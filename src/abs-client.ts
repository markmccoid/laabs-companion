import { createHash } from "node:crypto";
import { HttpError } from "./errors";

/** The subset of `GET /api/me` the Companion uses. */
export type AbsUser = {
  id: string;
  username: string;
};

/** The subset of `GET /api/items/:id?expanded=1` the Companion uses. */
export type AbsLibraryItem = {
  id: string;
  path: string;
  isFile?: boolean;
  mediaType?: string;
};

/** ABS ids become part of a file name, so only allow plain id characters. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const isSafeId = (value: unknown): value is string => typeof value === "string" && SAFE_ID.test(value);

type AbsClientOptions = {
  baseUrl: string;
  timeoutMs: number;
  meCacheTtlMs: number;
  fetch?: typeof fetch;
  now?: () => number;
};

/**
 * Talks to Audiobookshelf with the caller's own token. The Companion never
 * holds credentials of its own, so a user can only do what ABS lets them do.
 */
export class AbsClient {
  private readonly meCache = new Map<string, { user: AbsUser; expiresAt: number }>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: AbsClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private async request(pathAndQuery: string, token: string): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.options.baseUrl}${pathAndQuery}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      throw new HttpError(
        502,
        "abs_unreachable",
        `Audiobookshelf is unreachable at ABS_INTERNAL_URL: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The user behind `token`, cached for `meCacheTtlMs` per token. */
  async getMe(token: string): Promise<AbsUser> {
    const key = createHash("sha256").update(token).digest("hex");
    const now = this.now();
    const cached = this.meCache.get(key);
    if (cached && cached.expiresAt > now) return cached.user;

    const response = await this.request("/api/me", token);
    if (response.status === 401 || response.status === 403) {
      this.meCache.delete(key);
      throw new HttpError(401, "invalid_token", "Audiobookshelf rejected the access token");
    }
    if (!response.ok) {
      throw new HttpError(502, "abs_error", `Audiobookshelf /api/me failed (${response.status})`);
    }
    const body = (await response.json().catch(() => null)) as Partial<AbsUser> | null;
    if (!body || !isSafeId(body.id) || typeof body.username !== "string" || !body.username) {
      throw new HttpError(502, "abs_error", "Audiobookshelf /api/me returned an unexpected user");
    }
    const user: AbsUser = { id: body.id, username: body.username };
    this.pruneCache(now);
    this.meCache.set(key, { user, expiresAt: now + this.options.meCacheTtlMs });
    return user;
  }

  /** The library item, if this user can access it. */
  async getItem(libraryItemId: string, token: string): Promise<AbsLibraryItem> {
    const response = await this.request(`/api/items/${encodeURIComponent(libraryItemId)}?expanded=1`, token);
    if (response.status === 401) throw new HttpError(401, "invalid_token", "Audiobookshelf rejected the access token");
    if (response.status === 403) throw new HttpError(403, "no_access", "No access to this library item");
    if (response.status === 404) throw new HttpError(404, "item_not_found", "Library item not found");
    if (!response.ok) {
      throw new HttpError(502, "abs_error", `Audiobookshelf /api/items failed (${response.status})`);
    }
    const body = (await response.json().catch(() => null)) as Partial<AbsLibraryItem> | null;
    if (!body || typeof body.path !== "string" || !body.path) {
      throw new HttpError(502, "abs_error", "Audiobookshelf returned an item without a path");
    }
    return { id: String(body.id ?? libraryItemId), path: body.path, isFile: Boolean(body.isFile), mediaType: body.mediaType };
  }

  private pruneCache(now: number) {
    if (this.meCache.size < 1000) return;
    for (const [key, entry] of this.meCache) {
      if (entry.expiresAt <= now) this.meCache.delete(key);
    }
  }
}
