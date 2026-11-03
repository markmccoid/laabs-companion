import fs from "node:fs/promises";
import path from "node:path";
import type { AbsUser } from "./abs-client";
import { atomicWriteFile, renameWithRetry } from "./atomic-write";
import { HttpError, isErrnoException } from "./errors";
import { KeyedLock } from "./keyed-lock";
import {
  BOOKMARK_SIDECAR_SCHEMA_VERSION,
  isSidecarSchemaWritable,
  type BookmarkSidecarDocument,
  type BookmarkSidecarWrite,
  type SidecarBookmarkRecord,
} from "./shared/sidecar-format";
import { mergeSidecarRecords } from "./shared/sidecar-merge";

export type WriteMode = "merge" | "replace";

/** Only live sidecars match: temp files and `.bak.json` backups have extra dot segments. */
const SIDECAR_FILE = /^\.laabs\.bookmarks\.([A-Za-z0-9_-]+)\.json$/;

export const sidecarFileName = (absUserId: string) => `.laabs.bookmarks.${absUserId}.json`;
export const backupFileName = (absUserId: string, timestamp: number) =>
  `.laabs.bookmarks.${absUserId}.${timestamp}.bak.json`;

/** Fields the Companion owns on every write. Everything else on the file is preserved. */
const MANAGED_FIELDS = new Set([
  "schemaVersion",
  "absUserId",
  "username",
  "libraryItemId",
  "mediaKind",
  "item",
  "audioFingerprint",
  "episodeFingerprints",
  "updatedAt",
  "records",
]);

type StoredFile =
  | { kind: "missing" }
  | { kind: "ok"; document: BookmarkSidecarDocument; raw: string }
  | { kind: "corrupt"; raw: string };

type Logger = Pick<Console, "info" | "warn">;

const sameUsername = (left: unknown, right: string) =>
  typeof left === "string" && left.trim().toLowerCase() === right.trim().toLowerCase();

const readStoredFile = async (filePath: string): Promise<StoredFile> => {
  let raw: string;
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile()) {
      throw new HttpError(500, "sidecar_not_a_file", `${path.basename(filePath)} is not a regular file`);
    }
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { kind: "corrupt", raw };
    const document = parsed as BookmarkSidecarDocument;
    if (!Array.isArray(document.records)) return { kind: "corrupt", raw };
    if (typeof document.schemaVersion !== "number") return { kind: "corrupt", raw };
    return { kind: "ok", document, raw };
  } catch {
    return { kind: "corrupt", raw };
  }
};

const serialize = (document: BookmarkSidecarDocument) => `${JSON.stringify(document, null, 2)}\n`;

/**
 * Reads and writes Bookmark Sidecars in item folders (BookmarkSidecarImplementationPlan.md §2).
 * Every operation on one user's sidecar runs under that file's lock.
 */
export class SidecarStore {
  private readonly locks = new KeyedLock();

  constructor(
    private readonly options: { now?: () => number; logger?: Logger } = {},
  ) {}

  private now() {
    return (this.options.now ?? Date.now)();
  }

  private get logger(): Logger {
    return this.options.logger ?? console;
  }

  /** The user's sidecar, adopting an orphaned one by username if needed; null when there is none. */
  async read(folder: string, user: AbsUser, libraryItemId: string): Promise<BookmarkSidecarDocument | null> {
    const target = path.join(folder, sidecarFileName(user.id));
    return this.locks.run(target, async () => {
      const stored = await this.loadOrAdopt(folder, target, user, libraryItemId);
      if (stored.kind === "missing") return null;
      if (stored.kind === "corrupt") {
        throw new HttpError(500, "sidecar_unreadable", "The Bookmark Sidecar is not valid JSON");
      }
      return stored.document;
    });
  }

  async write(
    folder: string,
    user: AbsUser,
    libraryItemId: string,
    body: BookmarkSidecarWrite,
    mode: WriteMode,
  ): Promise<BookmarkSidecarDocument> {
    const target = path.join(folder, sidecarFileName(user.id));
    return this.locks.run(target, async () => {
      const stored = await this.loadOrAdopt(folder, target, user, libraryItemId);
      if (stored.kind === "corrupt" && mode === "merge") {
        throw new HttpError(
          500,
          "sidecar_unreadable",
          "The Bookmark Sidecar is not valid JSON; use mode=replace to back it up and overwrite it",
        );
      }
      const existing = stored.kind === "ok" ? stored.document : null;
      if (existing && !isSidecarSchemaWritable(existing)) {
        throw new HttpError(
          409,
          "unsupported_schema",
          `The Bookmark Sidecar uses schemaVersion ${existing.schemaVersion}; this Companion writes ${BOOKMARK_SIDECAR_SCHEMA_VERSION}`,
        );
      }

      if (mode === "replace" && stored.kind !== "missing") {
        await this.backup(folder, user.id, stored.raw);
      }

      const records: SidecarBookmarkRecord[] =
        mode === "replace"
          ? mergeSidecarRecords(body.records, [])
          : mergeSidecarRecords(body.records, existing?.records ?? []);

      const bodyExtras = Object.fromEntries(
        Object.entries(body).filter(([key]) => !MANAGED_FIELDS.has(key)),
      );
      const document: BookmarkSidecarDocument = {
        ...(existing ?? {}),
        ...bodyExtras,
        schemaVersion: BOOKMARK_SIDECAR_SCHEMA_VERSION,
        absUserId: user.id,
        username: user.username,
        libraryItemId,
        mediaKind: body.mediaKind,
        item: body.item,
        audioFingerprint: body.audioFingerprint ?? null,
        episodeFingerprints:
          body.episodeFingerprints !== undefined ? body.episodeFingerprints : (existing?.episodeFingerprints ?? null),
        updatedAt: this.now(),
        records,
      };
      await atomicWriteFile(target, serialize(document));
      return document;
    });
  }

  /** Keeps the replaced file as a hidden `.bak.json`, never overwriting an older backup. */
  private async backup(folder: string, absUserId: string, raw: string) {
    let timestamp = this.now();
    for (;;) {
      const backupPath = path.join(folder, backupFileName(absUserId, timestamp));
      try {
        await fs.access(backupPath);
        timestamp += 1;
      } catch {
        await atomicWriteFile(backupPath, raw);
        return;
      }
    }
  }

  private async loadOrAdopt(
    folder: string,
    target: string,
    user: AbsUser,
    libraryItemId: string,
  ): Promise<StoredFile> {
    const stored = await readStoredFile(target);
    if (stored.kind !== "missing") return stored;
    return this.adopt(folder, target, user, libraryItemId);
  }

  /**
   * Sidecar Adoption: after an ABS rebuild a user gets a new id, so their old
   * sidecar sits under the old id. Take it over when exactly one other sidecar
   * in the folder carries this username.
   */
  private async adopt(folder: string, target: string, user: AbsUser, libraryItemId: string): Promise<StoredFile> {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    const candidates: { filePath: string; document: BookmarkSidecarDocument }[] = [];
    for (const entry of entries) {
      const match = SIDECAR_FILE.exec(entry.name);
      if (!match || match[1] === user.id || !entry.isFile()) continue;
      const filePath = path.join(folder, entry.name);
      const candidate = await readStoredFile(filePath).catch(() => ({ kind: "missing" }) as const);
      if (candidate.kind === "ok" && sameUsername(candidate.document.username, user.username)) {
        candidates.push({ filePath, document: candidate.document });
      }
    }
    if (candidates.length !== 1) {
      if (candidates.length > 1) {
        this.logger.warn(
          `Sidecar Adoption skipped in ${folder}: ${candidates.length} sidecars match username "${user.username}"`,
        );
      }
      return { kind: "missing" };
    }

    const [{ filePath, document }] = candidates;
    await renameWithRetry(filePath, target);
    this.logger.info(
      `Sidecar Adoption: ${path.basename(filePath)} -> ${path.basename(target)} for "${user.username}" in ${folder}`,
    );
    if (!isSidecarSchemaWritable(document)) {
      const raw = await fs.readFile(target, "utf8");
      return { kind: "ok", document, raw };
    }
    const adopted: BookmarkSidecarDocument = { ...document, absUserId: user.id, username: user.username, libraryItemId };
    const raw = serialize(adopted);
    await atomicWriteFile(target, raw);
    return { kind: "ok", document: adopted, raw };
  }
}
