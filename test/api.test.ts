import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir, record, startHarness, writeBody, type Harness } from "./helpers";

const BOOK_ID = "li_book";
const SIDECAR_MARK = ".laabs.bookmarks.usr_mark.json";

describe("LAABS Companion API against a mocked Audiobookshelf", () => {
  let dir: string;
  let library: string;
  let bookFolder: string;
  let harness: Harness;
  let clock: number;

  const listFolder = async () => (await fs.readdir(bookFolder)).sort();
  const readSidecar = async (name = SIDECAR_MARK) => JSON.parse(await fs.readFile(path.join(bookFolder, name), "utf8"));

  beforeEach(async () => {
    dir = await makeTempDir();
    library = path.join(dir, "audiobooks");
    bookFolder = path.join(library, "Frank Herbert", "Dune");
    await fs.mkdir(bookFolder, { recursive: true });
    await fs.writeFile(path.join(bookFolder, "01.mp3"), "");
    await fs.writeFile(path.join(library, "single.m4b"), "");
    await fs.mkdir(path.join(dir, "outside"), { recursive: true });

    clock = 1_000_000;
    harness = await startHarness([library], {}, { now: () => clock });
    harness.abs.users.set("token-mark", { id: "usr_mark", username: "mark" });
    harness.abs.users.set("token-anna", { id: "usr_anna", username: "anna" });
    harness.abs.items.set(BOOK_ID, { path: bookFolder });
    harness.abs.items.set("li_single", { path: path.join(library, "single.m4b"), isFile: true });
    harness.abs.items.set("li_outside", { path: path.join(dir, "outside") });
    harness.abs.items.set("li_private", { path: bookFolder, allowedUserIds: ["usr_anna"] });
  });

  afterEach(async () => {
    await harness.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe("health", () => {
    it("reports the service without auth", async () => {
      const response = await harness.request("GET", "/health", { token: null });
      expect(response).toEqual({
        status: 200,
        body: { service: "laabs-companion", apiVersion: 1, schemaVersions: [1] },
      });
    });
  });

  describe("auth", () => {
    it("401s without a bearer token", async () => {
      const response = await harness.request("GET", `/v1/items/${BOOK_ID}/bookmarks`, { token: null });
      expect(response.status).toBe(401);
      expect(response.body.error).toBe("missing_token");
    });

    it("401s when ABS rejects the token", async () => {
      const response = await harness.request("GET", `/v1/items/${BOOK_ID}/bookmarks`, { token: "bogus" });
      expect(response.status).toBe(401);
      expect(response.body.error).toBe("invalid_token");
    });

    it("caches /api/me per token but checks item access every time", async () => {
      await harness.request("GET", `/v1/items/${BOOK_ID}/bookmarks`);
      await harness.request("GET", `/v1/items/${BOOK_ID}/bookmarks`);
      expect(harness.abs.meCalls).toBe(1);
      expect(harness.abs.itemCalls).toBe(2);
    });

    it("403s when ABS denies access to the item", async () => {
      const response = await harness.request("GET", "/v1/items/li_private/bookmarks");
      expect(response.status).toBe(403);
      expect(response.body.error).toBe("no_access");
    });

    it("404s for an item ABS does not know", async () => {
      const response = await harness.request("PUT", "/v1/items/li_missing/bookmarks", { body: writeBody() });
      expect(response.status).toBe(404);
      expect(response.body.error).toBe("item_not_found");
    });

    it("keeps each user to their own sidecar", async () => {
      await harness.request("PUT", `/v1/items/${BOOK_ID}/bookmarks`, { body: writeBody() });
      const anna = await harness.request("GET", `/v1/items/${BOOK_ID}/bookmarks`, { token: "token-anna" });
      expect(anna.status).toBe(404);
      await harness.request("PUT", `/v1/items/${BOOK_ID}/bookmarks`, {
        token: "token-anna",
        body: writeBody({ records: [record({ id: "anna_1" })] }),
      });
      expect(await listFolder()).toEqual([".laabs.bookmarks.usr_anna.json", "01.mp3", SIDECAR_MARK].sort());
      expect((await readSidecar()).records.map((entry: { id: string }) => entry.id)).toEqual(["bookmark_1"]);
    });
  });

  describe("path safety", () => {
    it("403s for an item folder outside LIBRARY_ROOTS", async () => {
      const response = await harness.request("PUT", "/v1/items/li_outside/bookmarks", { body: writeBody() });
      expect(response.status).toBe(403);
      expect(response.body.error).toBe("path_not_allowed");
      expect(await fs.readdir(path.join(dir, "outside"))).toEqual([]);
    });

    it("403s for a symlinked folder that escapes the root", async () => {
      await fs.symlink(path.join(dir, "outside"), path.join(library, "Sneaky"));
      harness.abs.items.set("li_link", { path: path.join(library, "Sneaky") });
      const response = await harness.request("PUT", "/v1/items/li_link/bookmarks", { body: writeBody() });
      expect(response.status).toBe(403);
      expect(await fs.readdir(path.join(dir, "outside"))).toEqual([]);
    });

    it("409s for a single-file item", async () => {
      const response = await harness.request("GET", "/v1/items/li_single/bookmarks");
      expect(response.status).toBe(409);
      expect(response.body.error).toBe("unsupported_item");
    });

    it("404s for an item id that is unsafe", async () => {
      const response = await harness.request("GET", `/v1/items/${encodeURIComponent("../x")}/bookmarks`);
      expect(response.status).toBe(404);
    });
  });

  describe("read and merge", () => {
    it("404s when the user has no sidecar", async () => {
      const response = await harness.request("GET", `/v1/items/${BOOK_ID}/bookmarks`);
      expect(response.status).toBe(404);
      expect(response.body.error).toBe("no_sidecar");
    });

    it("creates the sidecar dotfile with Companion-owned fields", async () => {
      const response = await harness.request("PUT", `/v1/items/${BOOK_ID}/bookmarks`, { body: writeBody() });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        schemaVersion: 1,
        absUserId: "usr_mark",
        username: "mark",
        libraryItemId: BOOK_ID,
        mediaKind: "book",
        audioFingerprint: { durationSeconds: 42120, trackCount: 12 },
        episodeFingerprints: null,
        updatedAt: clock,
        records: [record()],
      });
      expect(await readSidecar()).toEqual(response.body);
      expect(await listFolder()).toEqual(["01.mp3", SIDECAR_MARK].sort());

      const read = await harness.request("GET", `/v1/items/${BOOK_ID}/bookmarks`);
      expect(read).toEqual({ status: 200, body: response.body });
    });

    it("merges per record by updatedAt and keeps deletion markers", async () => {
      await harness.request("PUT", `/v1/items/${BOOK_ID}/bookmarks`, {
        body: writeBody({
          records: [
            record({ id: "a", title: "A old", updatedAt: 10 }),
            record({ id: "b", title: "B new", updatedAt: 50, startTimeSeconds: 5 }),
            record({ id: "c", updatedAt: 10, startTimeSeconds: 300 }),
          ],
        }),
      });
      clock += 1;
      const response = await harness.request("PUT", `/v1/items/${BOOK_ID}/bookmarks`, {
        body: writeBody({
          records: [
            record({ id: "a", title: "A new", updatedAt: 20 }),
            record({ id: "b", title: "B stale", updatedAt: 40, startTimeSeconds: 5 }),
            record({ id: "c", updatedAt: 10, deletedAt: 10, startTimeSeconds: 300 }),
            record({ id: "d", kind: "clip", startTimeSeconds: 200, endTimeSeconds: 260 }),
          ],
        }),
      });
      expect(response.status).toBe(200);
      expect(response.body.records).toEqual([
        record({ id: "b", title: "B new", updatedAt: 50, startTimeSeconds: 5 }),
        record({ id: "a", title: "A new", updatedAt: 20 }),
        record({ id: "d", kind: "clip", startTimeSeconds: 200, endTimeSeconds: 260 }),
        record({ id: "c", updatedAt: 10, deletedAt: 10, startTimeSeconds: 300 }),
      ]);
      expect(response.body.updatedAt).toBe(clock);
    });

    it("preserves unknown fields on the file, the body, and records", async () => {
      await harness.request("PUT", `/v1/items/${BOOK_ID}/bookmarks`, { body: writeBody() });
      const stored = await readSidecar();
      await fs.writeFile(
        path.join(bookFolder, SIDECAR_MARK),
        JSON.stringify({
          ...stored,
          fromNewerClient: { keep: true },
          records: [{ ...stored.records[0], color: "red" }],
        }),
      );
      const response = await harness.request("PUT", `/v1/items/${BOOK_ID}/bookmarks`, {
        body: { ...writeBody({ records: [record({ id: "other", startTimeSeconds: 900 })] }), bodyExtra: 7 },
      });
      expect(response.body.fromNewerClient).toEqual({ keep: true });
      expect(response.body.bodyExtra).toBe(7);
      expect(response.body.records[0]).toMatchObject({ id: "bookmark_1", color: "red" });
    });

    it("stores podcast episode fingerprints and episode refs", async () => {
      const response = await harness.request("PUT", `/v1/items/${BOOK_ID}/bookmarks`, {
        body: writeBody({
          mediaKind: "podcast",
          audioFingerprint: null,
          episodeFingerprints: { "Episode 12.mp3": 3600 },
          records: [record({ episode: { episodeId: "ep_1", audioRelPath: "Episode 12.mp3" } })],
        }),
      });
      expect(response.body).toMatchObject({
        mediaKind: "podcast",
        audioFingerprint: null,
        episodeFingerprints: { "Episode 12.mp3": 3600 },
      });
      expect(response.body.records[0].episode).toEqual({ episodeId: "ep_1", audioRelPath: "Episode 12.mp3" });
    });

    it("422s for an invalid body or mode", async () => {
      expect((await harness.request("PUT", `/v1/items/${BOOK_ID}/bookmarks`, { rawBody: "{nope" })).status).toBe(422);
      expect(
        (await harness.request("PUT", `/v1/items/${BOOK_ID}/bookmarks`, { body: { ...writeBody(), records: "x" } }))
          .status,
      ).toBe(422);
      expect(
        (await harness.request("PUT", `/v1/items/${BOOK_ID}/bookmarks?mode=nuke`, { body: writeBody() })).status,
      ).toBe(422);
      expect(await listFolder()).toEqual(["01.mp3"]);
    });

    it("refuses to write over a newer schemaVersion", async () => {
      await fs.writeFile(
        path.join(bookFolder, SIDECAR_MARK),
        JSON.stringify({ schemaVersion: 2, username: "mark", records: [] }),
      );
      const response = await harness.request("PUT", `/v1/items/${BOOK_ID}/bookmarks`, { body: writeBody() });
      expect(response.status).toBe(409);
      expect(response.body.error).toBe("unsupported_schema");
      expect((await harness.request("GET", `/v1/items/${BOOK_ID}/bookmarks`)).body.schemaVersion).toBe(2);
    });

    it("serializes concurrent writes so no record is lost", async () => {
      const writes = Array.from({ length: 20 }, (_, index) =>
        harness.request("PUT", `/v1/items/${BOOK_ID}/bookmarks`, {
          body: writeBody({ records: [record({ id: `r${String(index).padStart(2, "0")}`, startTimeSeconds: index })] }),
        }),
      );
      const responses = await Promise.all(writes);
      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect((await readSidecar()).records).toHaveLength(20);
      expect(await listFolder()).toEqual(["01.mp3", SIDECAR_MARK].sort());
    });
  });

  describe("replace", () => {
    it("replaces records and keeps the old file as a .bak.json dotfile", async () => {
      await harness.request("PUT", `/v1/items/${BOOK_ID}/bookmarks`, {
        body: writeBody({ records: [record({ id: "old_1" }), record({ id: "old_2" })] }),
      });
      const before = await fs.readFile(path.join(bookFolder, SIDECAR_MARK), "utf8");
      clock = 2_000_000;

      const response = await harness.request("PUT", `/v1/items/${BOOK_ID}/bookmarks?mode=replace`, {
        body: writeBody({ audioFingerprint: { durationSeconds: 50000, trackCount: 1 }, records: [record({ id: "new_1" })] }),
      });
      expect(response.status).toBe(200);
      expect(response.body.records.map((entry: { id: string }) => entry.id)).toEqual(["new_1"]);
      expect(response.body.audioFingerprint).toEqual({ durationSeconds: 50000, trackCount: 1 });

      const backupName = ".laabs.bookmarks.usr_mark.2000000.bak.json";
      expect(await listFolder()).toEqual(["01.mp3", SIDECAR_MARK, backupName].sort());
      expect(await fs.readFile(path.join(bookFolder, backupName), "utf8")).toBe(before);
    });

    it("never overwrites an earlier backup made in the same millisecond", async () => {
      await harness.request("PUT", `/v1/items/${BOOK_ID}/bookmarks`, { body: writeBody() });
      await harness.request("PUT", `/v1/items/${BOOK_ID}/bookmarks?mode=replace`, { body: writeBody({ records: [] }) });
      await harness.request("PUT", `/v1/items/${BOOK_ID}/bookmarks?mode=replace`, { body: writeBody({ records: [] }) });
      const backups = (await listFolder()).filter((name) => name.endsWith(".bak.json"));
      expect(backups).toHaveLength(2);
    });

    it("writes without a backup when there was no file", async () => {
      const response = await harness.request("PUT", `/v1/items/${BOOK_ID}/bookmarks?mode=replace`, { body: writeBody() });
      expect(response.status).toBe(200);
      expect(await listFolder()).toEqual(["01.mp3", SIDECAR_MARK].sort());
    });

    it("backs up and overwrites a corrupt file, which a merge refuses", async () => {
      await fs.writeFile(path.join(bookFolder, SIDECAR_MARK), "{corrupt");
      expect((await harness.request("PUT", `/v1/items/${BOOK_ID}/bookmarks`, { body: writeBody() })).status).toBe(500);
      const response = await harness.request("PUT", `/v1/items/${BOOK_ID}/bookmarks?mode=replace`, { body: writeBody() });
      expect(response.status).toBe(200);
      const backup = (await listFolder()).find((name) => name.endsWith(".bak.json"))!;
      expect(await fs.readFile(path.join(bookFolder, backup), "utf8")).toBe("{corrupt");
    });
  });

  describe("Sidecar Adoption", () => {
    const writeOrphan = async (absUserId: string, username: string, ids: string[]) =>
      fs.writeFile(
        path.join(bookFolder, `.laabs.bookmarks.${absUserId}.json`),
        JSON.stringify({
          schemaVersion: 1,
          absUserId,
          username,
          libraryItemId: "li_before_rebuild",
          mediaKind: "book",
          item: {},
          audioFingerprint: null,
          updatedAt: 1,
          records: ids.map((id) => record({ id })),
          keepMe: "yes",
        }),
      );

    it("adopts the single sidecar with a matching username on read", async () => {
      await writeOrphan("usr_old", "Mark", ["kept"]);
      const response = await harness.request("GET", `/v1/items/${BOOK_ID}/bookmarks`);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ absUserId: "usr_mark", libraryItemId: BOOK_ID, keepMe: "yes" });
      expect(response.body.records.map((entry: { id: string }) => entry.id)).toEqual(["kept"]);
      expect(await listFolder()).toEqual(["01.mp3", SIDECAR_MARK].sort());
      expect((await readSidecar()).absUserId).toBe("usr_mark");
    });

    it("adopts on write and merges into the adopted records", async () => {
      await writeOrphan("usr_old", "mark", ["kept"]);
      const response = await harness.request("PUT", `/v1/items/${BOOK_ID}/bookmarks`, {
        body: writeBody({ records: [record({ id: "new", startTimeSeconds: 999 })] }),
      });
      expect(response.body.records.map((entry: { id: string }) => entry.id)).toEqual(["kept", "new"]);
      expect(await listFolder()).toEqual(["01.mp3", SIDECAR_MARK].sort());
    });

    it("does not adopt another user's sidecar", async () => {
      await writeOrphan("usr_old", "anna", ["theirs"]);
      expect((await harness.request("GET", `/v1/items/${BOOK_ID}/bookmarks`)).status).toBe(404);
      expect(await listFolder()).toContain(".laabs.bookmarks.usr_old.json");
    });

    it("starts empty when more than one sidecar matches", async () => {
      await writeOrphan("usr_old1", "mark", ["one"]);
      await writeOrphan("usr_old2", "mark", ["two"]);
      expect((await harness.request("GET", `/v1/items/${BOOK_ID}/bookmarks`)).status).toBe(404);
      const response = await harness.request("PUT", `/v1/items/${BOOK_ID}/bookmarks`, { body: writeBody() });
      expect(response.body.records.map((entry: { id: string }) => entry.id)).toEqual(["bookmark_1"]);
      expect(await listFolder()).toEqual(
        ["01.mp3", SIDECAR_MARK, ".laabs.bookmarks.usr_old1.json", ".laabs.bookmarks.usr_old2.json"].sort(),
      );
    });

    it("ignores backups when looking for a sidecar to adopt", async () => {
      await fs.writeFile(
        path.join(bookFolder, ".laabs.bookmarks.usr_old.123.bak.json"),
        JSON.stringify({ schemaVersion: 1, username: "mark", records: [record()] }),
      );
      expect((await harness.request("GET", `/v1/items/${BOOK_ID}/bookmarks`)).status).toBe(404);
    });
  });

  describe("reverse proxy base path", () => {
    it("serves under BASE_PATH when the proxy does not strip it", async () => {
      const proxied = await startHarness([library], { basePath: "/laabs" });
      try {
        const response = await fetch(`${proxied.baseUrl}/laabs/health`);
        expect(response.status).toBe(200);
        expect(((await response.json()) as { service: string }).service).toBe("laabs-companion");
      } finally {
        await proxied.stop();
      }
    });
  });
});
