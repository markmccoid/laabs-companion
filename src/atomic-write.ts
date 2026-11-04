import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isErrnoException } from "./errors";

const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
/** Some shared folders (SMB through a VM file share, some FUSE mounts) refuse fsync on files too. */
const UNSUPPORTED_SYNC_CODES = new Set(["ENOTSUP", "EOPNOTSUPP", "EINVAL", "ENOSYS"]);

const syncIfSupported = async (handle: fs.FileHandle) => {
  try {
    await handle.sync();
  } catch (error) {
    if (!isErrnoException(error) || !UNSUPPORTED_SYNC_CODES.has(error.code ?? "")) throw error;
  }
};

/** Windows refuses to replace a file another process (an indexer, antivirus) has open; retry briefly. */
const renameWithRetry = async (from: string, to: string) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (attempt >= 5 || !isErrnoException(error) || !RETRYABLE_RENAME_CODES.has(error.code ?? "")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
};

/** The temp file is a dotfile too, so Audiobookshelf's scanner and watcher skip it. */
export const tempPathFor = (target: string) => {
  const base = path.basename(target).replace(/^\.+/, "");
  return path.join(path.dirname(target), `.${base}.${randomBytes(6).toString("hex")}.tmp`);
};

/** Writes `content` to a temp dotfile beside `target`, fsyncs it, then renames it over `target`. */
export const atomicWriteFile = async (target: string, content: string) => {
  const temp = tempPathFor(target);
  const handle = await fs.open(temp, "wx", 0o664);
  try {
    try {
      await handle.writeFile(content, "utf8");
      await syncIfSupported(handle);
    } finally {
      await handle.close();
    }
    await renameWithRetry(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  if (process.platform !== "win32") {
    // Persist the rename itself. Best effort: some network filesystems refuse directory fsync.
    const directory = await fs.open(path.dirname(target), "r").catch(() => null);
    await directory?.sync().catch(() => undefined);
    await directory?.close().catch(() => undefined);
  }
};

export { renameWithRetry };
