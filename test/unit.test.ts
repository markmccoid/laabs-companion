import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AbsClient } from "../src/abs-client";
import { atomicWriteFile } from "../src/atomic-write";
import { loadConfig } from "../src/config";
import { HttpError } from "../src/errors";
import { KeyedLock } from "../src/keyed-lock";
import { isStrictlyInside, mapAbsPath, resolveItemFolder, resolveLibraryRoots } from "../src/paths";
import { mergeSidecarRecords } from "../src/shared/sidecar-merge";
import { validateSidecarWrite } from "../src/validate";
import { makeTempDir, record, writeBody } from "./helpers";

describe("mergeSidecarRecords (shared with LAABS Audio)", () => {
  it("keeps the record with the newer updatedAt", () => {
    const merged = mergeSidecarRecords(
      [record({ title: "Local", updatedAt: 20 })],
      [record({ title: "Remote", updatedAt: 15 })],
    );
    expect(merged).toEqual([record({ title: "Local", updatedAt: 20 })]);
  });

  it("lets a deletion win a tie", () => {
    const deleted = record({ deletedAt: 10, updatedAt: 10 });
    expect(mergeSidecarRecords([record()], [deleted])).toEqual([deleted]);
    expect(mergeSidecarRecords([deleted], [record()])).toEqual([deleted]);
  });

  it("keeps the remote version on a full tie", () => {
    const merged = mergeSidecarRecords([record({ title: "Local" })], [record({ title: "Remote" })]);
    expect(merged[0].title).toBe("Remote");
  });

  it("does not let a stale copy resurrect a deleted record", () => {
    const deleted = record({ deletedAt: 30, updatedAt: 30 });
    expect(mergeSidecarRecords([record({ updatedAt: 20 })], [deleted])).toEqual([deleted]);
  });

  it("unions records and sorts by start time, then id", () => {
    const merged = mergeSidecarRecords(
      [record({ id: "b", startTimeSeconds: 50 }), record({ id: "c", startTimeSeconds: 50 })],
      [record({ id: "a", startTimeSeconds: 200 })],
    );
    expect(merged.map((entry) => entry.id)).toEqual(["b", "c", "a"]);
  });

  it("keeps unknown fields on the winning record", () => {
    const newer = { ...record({ updatedAt: 99 }), color: "red" } as never;
    expect(mergeSidecarRecords([newer], [record()])[0]).toHaveProperty("color", "red");
  });
});

describe("path safety", () => {
  let dir: string;
  let library: string;
  let realRoots: string[];

  beforeEach(async () => {
    dir = await makeTempDir();
    library = path.join(dir, "books");
    await fs.mkdir(path.join(library, "Author", "Book"), { recursive: true });
    await fs.mkdir(path.join(dir, "books2", "Other"), { recursive: true });
    await fs.mkdir(path.join(dir, "outside"), { recursive: true });
    await fs.writeFile(path.join(library, "single.m4b"), "");
    await fs.symlink(path.join(dir, "outside"), path.join(library, "escape"));
    realRoots = await resolveLibraryRoots([library]);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("accepts a folder inside a root and returns its realpath", async () => {
    const folder = await resolveItemFolder(path.join(library, "Author", "Book"), realRoots, []);
    expect(folder).toBe(await fs.realpath(path.join(library, "Author", "Book")));
  });

  it("refuses the root itself", async () => {
    await expect(resolveItemFolder(library, realRoots, [])).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a sibling that only shares the root's prefix", async () => {
    await expect(resolveItemFolder(path.join(dir, "books2", "Other"), realRoots, [])).rejects.toMatchObject({
      status: 403,
    });
  });

  it("refuses .. traversal out of a root", async () => {
    await expect(
      resolveItemFolder(path.join(library, "Author", "..", "..", "outside"), realRoots, []),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a symlink that leaves the root", async () => {
    await expect(resolveItemFolder(path.join(library, "escape"), realRoots, [])).rejects.toMatchObject({
      status: 403,
    });
  });

  it("returns 409 for a file instead of a folder", async () => {
    await expect(resolveItemFolder(path.join(library, "single.m4b"), realRoots, [])).rejects.toMatchObject({
      status: 409,
    });
  });

  it("reports a missing folder as a server-side setup error", async () => {
    await expect(resolveItemFolder(path.join(library, "Nope"), realRoots, [])).rejects.toMatchObject({
      status: 500,
      code: "item_folder_missing",
    });
  });

  it("applies the longest matching path mapping", async () => {
    const mappings = [
      { absPrefix: "/audiobooks", localPrefix: "/nowhere" },
      { absPrefix: "/audiobooks/Author", localPrefix: path.join(library, "Author") },
    ];
    expect(mapAbsPath("/audiobooks/Author/Book", mappings)).toBe(path.join(library, "Author", "Book"));
    expect(mapAbsPath("/audiobooksX/Book", mappings)).toBe("/audiobooksX/Book");
    await expect(resolveItemFolder("/audiobooks/Author/Book", realRoots, mappings)).resolves.toBeTruthy();
  });

  it("isStrictlyInside does not treat '..name' folders as traversal", () => {
    expect(isStrictlyInside("/lib", "/lib/..hidden")).toBe(true);
    expect(isStrictlyInside("/lib", "/lib")).toBe(false);
    expect(isStrictlyInside("/lib", "/other")).toBe(false);
  });
});

describe("KeyedLock", () => {
  it("serializes work per key and releases the key afterwards", async () => {
    const lock = new KeyedLock();
    const events: string[] = [];
    const slow = lock.run("a", async () => {
      events.push("a1 start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push("a1 end");
    });
    const second = lock.run("a", async () => {
      events.push("a2");
    });
    const other = lock.run("b", async () => {
      events.push("b");
    });
    await Promise.all([slow, second, other]);
    expect(events.indexOf("a2")).toBeGreaterThan(events.indexOf("a1 end"));
    expect(events.indexOf("b")).toBeLessThan(events.indexOf("a1 end"));
    expect(lock.size).toBe(0);
  });

  it("keeps going after a failure", async () => {
    const lock = new KeyedLock();
    await expect(lock.run("a", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(lock.run("a", async () => "ok")).resolves.toBe("ok");
  });
});

describe("atomicWriteFile", () => {
  it("replaces the target and leaves no temp files", async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, ".laabs.bookmarks.u1.json");
    await atomicWriteFile(target, "one");
    await atomicWriteFile(target, "two");
    expect(await fs.readFile(target, "utf8")).toBe("two");
    expect(await fs.readdir(dir)).toEqual([".laabs.bookmarks.u1.json"]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("validateSidecarWrite", () => {
  it("accepts a valid body and keeps unknown fields", () => {
    const body = { ...writeBody(), futureField: { a: 1 } };
    expect(validateSidecarWrite(body)).toMatchObject({ futureField: { a: 1 } });
  });

  it.each([
    ["non-object body", []],
    ["bad mediaKind", { ...writeBody(), mediaKind: "movie" }],
    ["missing records", { ...writeBody(), records: undefined }],
    ["bad record kind", writeBody({ records: [record({ kind: "range" as never })] })],
    ["negative start", writeBody({ records: [record({ startTimeSeconds: -1 })] })],
    ["duplicate ids", writeBody({ records: [record(), record()] })],
    ["bad fingerprint", { ...writeBody(), audioFingerprint: { durationSeconds: "x", trackCount: 1 } }],
    ["bad episode", writeBody({ records: [record({ episode: { episodeId: 3 } as never })] })],
  ])("rejects %s with 422", (_label, body) => {
    expect(() => validateSidecarWrite(body)).toThrow(HttpError);
    try {
      validateSidecarWrite(body);
    } catch (error) {
      expect((error as HttpError).status).toBe(422);
    }
  });
});

describe("loadConfig", () => {
  it("requires ABS_INTERNAL_URL and LIBRARY_ROOTS", () => {
    expect(() => loadConfig({})).toThrow(/ABS_INTERNAL_URL/);
    expect(() => loadConfig({ ABS_INTERNAL_URL: "http://abs" })).toThrow(/LIBRARY_ROOTS/);
  });

  it("parses roots, mappings, and base path", () => {
    const config = loadConfig({
      ABS_INTERNAL_URL: "http://abs:80/",
      LIBRARY_ROOTS: `/audiobooks${path.delimiter}/podcasts|/more`,
      PATH_MAPPINGS: "/audiobooks=/mnt/media/audiobooks|/podcasts=/mnt/media/podcasts",
      BASE_PATH: "laabs/",
    });
    expect(config.absInternalUrl).toBe("http://abs:80");
    expect(config.libraryRoots).toEqual(["/audiobooks", "/podcasts", "/more"]);
    expect(config.pathMappings).toHaveLength(2);
    expect(config.basePath).toBe("/laabs");
    expect(config.meCacheTtlMs).toBe(300_000);
  });
});

describe("AbsClient /api/me cache", () => {
  it("caches per token for the TTL", async () => {
    let calls = 0;
    let now = 0;
    const fakeFetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ id: "u1", username: "mark" }), { status: 200 });
    }) as typeof fetch;
    const client = new AbsClient({ baseUrl: "http://abs", timeoutMs: 1000, meCacheTtlMs: 300_000, fetch: fakeFetch, now: () => now });
    await client.getMe("t1");
    await client.getMe("t1");
    expect(calls).toBe(1);
    await client.getMe("t2");
    expect(calls).toBe(2);
    now = 300_001;
    await client.getMe("t1");
    expect(calls).toBe(3);
  });

  it("refuses ids that are unsafe in a file name", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ id: "../evil", username: "mark" }), { status: 200 })) as typeof fetch;
    const client = new AbsClient({ baseUrl: "http://abs", timeoutMs: 1000, meCacheTtlMs: 1000, fetch: fakeFetch });
    await expect(client.getMe("t")).rejects.toMatchObject({ status: 502 });
  });
});
