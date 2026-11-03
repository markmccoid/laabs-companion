import path from "node:path";

export type PathMapping = {
  /** Path prefix as Audiobookshelf reports it (inside the ABS container, if any). */
  absPrefix: string;
  /** The same folder as this Companion sees it. */
  localPrefix: string;
};

export type CompanionConfig = {
  absInternalUrl: string;
  /** Library folders the Companion may write into. Resolved with realpath at startup. */
  libraryRoots: string[];
  pathMappings: PathMapping[];
  host: string;
  port: number;
  /** Optional prefix to strip when a reverse proxy forwards `/laabs/...` unchanged. */
  basePath: string;
  meCacheTtlMs: number;
  absTimeoutMs: number;
  maxBodyBytes: number;
};

const splitList = (value: string | undefined) =>
  (value ?? "")
    .split(/\r?\n|\|/)
    .flatMap((entry) => entry.split(path.delimiter))
    .map((entry) => entry.trim())
    .filter(Boolean);

const parsePathMappings = (value: string | undefined): PathMapping[] =>
  (value ?? "")
    .split(/\r?\n|\|/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf("=");
      if (separator <= 0 || separator === entry.length - 1) {
        throw new Error(`PATH_MAPPINGS entry "${entry}" must look like /abs/path=/local/path`);
      }
      return {
        absPrefix: entry.slice(0, separator).trim(),
        localPrefix: entry.slice(separator + 1).trim(),
      };
    });

const parseInteger = (name: string, value: string | undefined, fallback: number) => {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
};

const normalizeBasePath = (value: string | undefined) => {
  const trimmed = (value ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): CompanionConfig => {
  const absInternalUrl = (env.ABS_INTERNAL_URL ?? "").trim().replace(/\/+$/, "");
  if (!absInternalUrl) throw new Error("ABS_INTERNAL_URL is required (for example http://audiobookshelf:80)");
  if (!/^https?:\/\//i.test(absInternalUrl)) throw new Error("ABS_INTERNAL_URL must start with http:// or https://");

  const libraryRoots = splitList(env.LIBRARY_ROOTS);
  if (libraryRoots.length === 0) {
    throw new Error(
      `LIBRARY_ROOTS is required: the library folders, separated by "${path.delimiter}" or "|"`,
    );
  }

  return {
    absInternalUrl,
    libraryRoots,
    pathMappings: parsePathMappings(env.PATH_MAPPINGS),
    host: env.HOST?.trim() || "0.0.0.0",
    port: parseInteger("PORT", env.PORT, 8787),
    basePath: normalizeBasePath(env.BASE_PATH),
    meCacheTtlMs: parseInteger("ME_CACHE_TTL_SECONDS", env.ME_CACHE_TTL_SECONDS, 300) * 1000,
    absTimeoutMs: parseInteger("ABS_TIMEOUT_MS", env.ABS_TIMEOUT_MS, 10_000),
    maxBodyBytes: parseInteger("MAX_BODY_BYTES", env.MAX_BODY_BYTES, 5 * 1024 * 1024),
  };
};
