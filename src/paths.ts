import fs from "node:fs/promises";
import path from "node:path";
import type { PathMapping } from "./config";
import { HttpError, isErrnoException } from "./errors";

/** Splits on both separators: ABS may report POSIX paths to a Companion on Windows. */
const pathSegments = (value: string) => value.split(/[\\/]+/).filter(Boolean);

const hasPrefix = (value: string, prefix: string) => {
  const valueParts = pathSegments(value);
  const prefixParts = pathSegments(prefix);
  return (
    prefixParts.length <= valueParts.length &&
    prefixParts.every((part, index) => part === valueParts[index])
  );
};

/**
 * Translates the path ABS reports into the path this Companion sees. Without a
 * matching mapping the path is used as is (the recommended "same mounts" setup).
 */
export const mapAbsPath = (absPath: string, mappings: readonly PathMapping[]): string => {
  const mapping = [...mappings]
    .sort((left, right) => pathSegments(right.absPrefix).length - pathSegments(left.absPrefix).length)
    .find((candidate) => hasPrefix(absPath, candidate.absPrefix));
  if (!mapping) return absPath;
  const rest = pathSegments(absPath).slice(pathSegments(mapping.absPrefix).length);
  return path.join(mapping.localPrefix, ...rest);
};

/** True when `candidate` is strictly inside `root` (root itself does not count). */
export const isStrictlyInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

export const resolveLibraryRoots = async (roots: readonly string[]): Promise<string[]> => {
  const resolved: string[] = [];
  for (const root of roots) {
    try {
      const real = await fs.realpath(root);
      if (!(await fs.stat(real)).isDirectory()) throw new Error("not a directory");
      resolved.push(real);
    } catch (error) {
      throw new Error(
        `Library root "${root}" is not an accessible folder: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return resolved;
};

/**
 * Resolves an item's folder with realpath and requires it to be under one of
 * the (already realpath'd) library roots. Symlinks that leave a root are refused.
 */
export const resolveItemFolder = async (
  absItemPath: string,
  realRoots: readonly string[],
  mappings: readonly PathMapping[],
): Promise<string> => {
  const localPath = mapAbsPath(absItemPath, mappings);
  if (!path.isAbsolute(localPath)) {
    throw new HttpError(403, "path_not_allowed", "Item path is not absolute");
  }
  let realPath: string;
  try {
    realPath = await fs.realpath(localPath);
  } catch (error) {
    if (isErrnoException(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      throw new HttpError(
        500,
        "item_folder_missing",
        "The item folder does not exist on the Companion. Mount the same paths as Audiobookshelf, or set PATH_MAPPINGS.",
      );
    }
    throw error;
  }
  if (!realRoots.some((root) => isStrictlyInside(root, realPath))) {
    throw new HttpError(403, "path_not_allowed", "Item folder is outside the configured LIBRARY_ROOTS");
  }
  if (!(await fs.stat(realPath)).isDirectory()) {
    throw new HttpError(409, "unsupported_item", "Single-file items have no folder for a Bookmark Sidecar");
  }
  return realPath;
};
