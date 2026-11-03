import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { CompanionConfig } from "../src/config";
import { resolveLibraryRoots } from "../src/paths";
import { createCompanionServer } from "../src/server";
import type { BookmarkSidecarWrite, SidecarBookmarkRecord } from "../src/shared/sidecar-format";

export const record = (overrides: Partial<SidecarBookmarkRecord> = {}): SidecarBookmarkRecord => ({
  id: "bookmark_1",
  kind: "point",
  startTimeSeconds: 100,
  title: "Quote",
  note: null,
  createdAt: 1,
  updatedAt: 10,
  deletedAt: null,
  ...overrides,
});

export const writeBody = (overrides: Partial<BookmarkSidecarWrite> = {}): BookmarkSidecarWrite => ({
  mediaKind: "book",
  item: { title: "Dune", author: "Frank Herbert", asin: null, relPath: "Frank Herbert/Dune" },
  audioFingerprint: { durationSeconds: 42120, trackCount: 12 },
  records: [record()],
  ...overrides,
});

export const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export const makeTempDir = async (prefix = "laabs-companion-") => fs.mkdtemp(path.join(os.tmpdir(), prefix));

type MockUser = { id: string; username: string };
type MockItem = { path: string; isFile?: boolean; allowedUserIds?: string[]; status?: number };

/** A stand-in for Audiobookshelf: `/api/me` and `/api/items/:id`, keyed by bearer token. */
export class MockAbs {
  readonly users = new Map<string, MockUser>();
  readonly items = new Map<string, MockItem>();
  meCalls = 0;
  itemCalls = 0;
  private server = http.createServer((request, response) => this.handle(request, response));
  url = "";

  async start() {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop() {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private send(response: http.ServerResponse, status: number, body: unknown) {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(typeof body === "string" ? body : JSON.stringify(body));
  }

  private handle(request: http.IncomingMessage, response: http.ServerResponse) {
    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
    const user = token ? this.users.get(token) : undefined;
    const url = new URL(request.url ?? "/", "http://abs");
    if (url.pathname === "/api/me") this.meCalls += 1;
    if (url.pathname.startsWith("/api/items/")) this.itemCalls += 1;
    if (!user) return this.send(response, 401, "Unauthorized");

    if (url.pathname === "/api/me") {
      return this.send(response, 200, { id: user.id, username: user.username, type: "user", isActive: true });
    }
    const itemMatch = /^\/api\/items\/([^/]+)$/.exec(url.pathname);
    if (itemMatch && url.searchParams.get("expanded") === "1") {
      const id = decodeURIComponent(itemMatch[1]);
      const item = this.items.get(id);
      if (!item) return this.send(response, 404, "Not Found");
      if (item.status) return this.send(response, item.status, "Error");
      if (item.allowedUserIds && !item.allowedUserIds.includes(user.id)) return this.send(response, 403, "Forbidden");
      return this.send(response, 200, {
        id,
        path: item.path,
        isFile: Boolean(item.isFile),
        mediaType: "book",
        media: {},
      });
    }
    return this.send(response, 404, "Not Found");
  }
}

export type Harness = {
  abs: MockAbs;
  baseUrl: string;
  roots: string[];
  stop: () => Promise<void>;
  request: (
    method: string,
    pathAndQuery: string,
    options?: { token?: string | null; body?: unknown; rawBody?: string },
  ) => Promise<{ status: number; body: any }>;
};

export const startHarness = async (
  roots: string[],
  overrides: Partial<CompanionConfig> = {},
  deps: { now?: () => number } = {},
): Promise<Harness> => {
  const abs = await new MockAbs().start();
  const config: CompanionConfig = {
    absInternalUrl: abs.url,
    libraryRoots: roots,
    pathMappings: [],
    host: "127.0.0.1",
    port: 0,
    basePath: "",
    meCacheTtlMs: 300_000,
    absTimeoutMs: 5_000,
    maxBodyBytes: 1024 * 1024,
    ...overrides,
  };
  const server = createCompanionServer(config, {
    realLibraryRoots: await resolveLibraryRoots(roots),
    now: deps.now,
    logger: silentLogger,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    abs,
    baseUrl,
    roots,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await abs.stop();
    },
    request: async (method, pathAndQuery, options = {}) => {
      const headers: Record<string, string> = { Accept: "application/json" };
      const token = options.token === undefined ? "token-mark" : options.token;
      if (token) headers.Authorization = `Bearer ${token}`;
      let body: string | undefined;
      if (options.rawBody !== undefined) body = options.rawBody;
      else if (options.body !== undefined) body = JSON.stringify(options.body);
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const response = await fetch(`${baseUrl}${pathAndQuery}`, { method, headers, body });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
  };
};
