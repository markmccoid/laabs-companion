import http from "node:http";
import { AbsClient, isSafeId } from "./abs-client";
import type { CompanionConfig } from "./config";
import { HttpError } from "./errors";
import { resolveItemFolder } from "./paths";
import { BOOKMARK_SIDECAR_SCHEMA_VERSION } from "./shared/sidecar-format";
import { SidecarStore, type WriteMode } from "./sidecar-store";
import { validateSidecarWrite } from "./validate";

export const COMPANION_API_VERSION = 1;

const ITEM_BOOKMARKS_ROUTE = /^\/v1\/items\/([^/]+)\/bookmarks\/?$/;

type Logger = Pick<Console, "info" | "warn" | "error">;

export type CompanionDeps = {
  /** Library roots after realpath (see `resolveLibraryRoots`). */
  realLibraryRoots: string[];
  fetch?: typeof fetch;
  now?: () => number;
  logger?: Logger;
};

const sendJson = (response: http.ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  response.end(payload);
};

const bearerToken = (request: http.IncomingMessage) => {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "");
  const token = match?.[1].trim();
  if (!token) throw new HttpError(401, "missing_token", "Authorization: Bearer <ABS access token> is required");
  return token;
};

const readJsonBody = async (request: http.IncomingMessage, maxBytes: number): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, "body_too_large", `Body exceeds ${maxBytes} bytes`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(422, "invalid_body", "Body is not valid JSON");
  }
};

const stripBasePath = (pathname: string, basePath: string) => {
  if (!basePath) return pathname;
  if (pathname === basePath) return "/";
  return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
};

export const createRequestHandler = (config: CompanionConfig, deps: CompanionDeps) => {
  const logger = deps.logger ?? console;
  const abs = new AbsClient({
    baseUrl: config.absInternalUrl,
    timeoutMs: config.absTimeoutMs,
    meCacheTtlMs: config.meCacheTtlMs,
    fetch: deps.fetch,
    now: deps.now,
  });
  const store = new SidecarStore({ now: deps.now, logger });

  /** Identity, library access, and the item's folder, all decided by ABS with the caller's token. */
  const authorizeItem = async (request: http.IncomingMessage, rawItemId: string) => {
    const token = bearerToken(request);
    let libraryItemId: string;
    try {
      libraryItemId = decodeURIComponent(rawItemId);
    } catch {
      throw new HttpError(404, "item_not_found", "Library item not found");
    }
    const user = await abs.getMe(token);
    if (!isSafeId(libraryItemId)) throw new HttpError(404, "item_not_found", "Library item not found");
    const item = await abs.getItem(libraryItemId, token);
    if (item.isFile) {
      throw new HttpError(409, "unsupported_item", "Single-file items have no folder for a Bookmark Sidecar");
    }
    const folder = await resolveItemFolder(item.path, deps.realLibraryRoots, config.pathMappings);
    return { user, libraryItemId, folder };
  };

  const handle = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://companion.local");
    const pathname = stripBasePath(url.pathname, config.basePath);

    if (pathname === "/health" || pathname === "/health/") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        throw new HttpError(405, "method_not_allowed", "Use GET");
      }
      sendJson(response, 200, {
        service: "laabs-companion",
        apiVersion: COMPANION_API_VERSION,
        schemaVersions: [BOOKMARK_SIDECAR_SCHEMA_VERSION],
      });
      return;
    }

    const route = ITEM_BOOKMARKS_ROUTE.exec(pathname);
    if (!route) throw new HttpError(404, "not_found", "Not found");

    if (request.method === "GET") {
      const { user, libraryItemId, folder } = await authorizeItem(request, route[1]);
      const document = await store.read(folder, user, libraryItemId);
      if (!document) throw new HttpError(404, "no_sidecar", "No Bookmark Sidecar for this item");
      sendJson(response, 200, document);
      return;
    }

    if (request.method === "PUT") {
      const modeParam = url.searchParams.get("mode") ?? "merge";
      if (modeParam !== "merge" && modeParam !== "replace") {
        throw new HttpError(422, "invalid_mode", 'mode must be "merge" or "replace"');
      }
      const { user, libraryItemId, folder } = await authorizeItem(request, route[1]);
      const body = validateSidecarWrite(await readJsonBody(request, config.maxBodyBytes));
      const document = await store.write(folder, user, libraryItemId, body, modeParam as WriteMode);
      sendJson(response, 200, document);
      return;
    }

    throw new HttpError(405, "method_not_allowed", "Use GET or PUT");
  };

  return (request: http.IncomingMessage, response: http.ServerResponse) => {
    handle(request, response).catch((error: unknown) => {
      if (error instanceof HttpError) {
        if (error.status >= 500) logger.error(`${request.method} ${request.url}: ${error.code}: ${error.message}`);
        if (!response.headersSent) sendJson(response, error.status, { error: error.code, message: error.message });
        else response.end();
        if (error.status === 413) request.resume();
        return;
      }
      logger.error(`${request.method} ${request.url}: unexpected error`, error);
      if (!response.headersSent) sendJson(response, 500, { error: "internal_error", message: "Internal error" });
      else response.end();
    });
  };
};

export const createCompanionServer = (config: CompanionConfig, deps: CompanionDeps) =>
  http.createServer(createRequestHandler(config, deps));
