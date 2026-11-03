import { HttpError } from "./errors";
import type { BookmarkSidecarWrite } from "./shared/sidecar-format";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isOptionalNullableNumber = (value: unknown) => value === undefined || value === null || isFiniteNumber(value);
const isOptionalNullableString = (value: unknown) => value === undefined || value === null || typeof value === "string";

const invalid = (message: string): never => {
  throw new HttpError(422, "invalid_body", message);
};

const validateRecord = (value: unknown, index: number) => {
  const at = `records[${index}]`;
  if (!isObject(value)) return invalid(`${at} must be an object`);
  if (typeof value.id !== "string" || !value.id || value.id.length > 200) invalid(`${at}.id must be a non-empty string`);
  if (value.kind !== "point" && value.kind !== "clip") invalid(`${at}.kind must be "point" or "clip"`);
  if (!isFiniteNumber(value.startTimeSeconds) || value.startTimeSeconds < 0) {
    invalid(`${at}.startTimeSeconds must be a non-negative number`);
  }
  if (!isOptionalNullableNumber(value.endTimeSeconds)) invalid(`${at}.endTimeSeconds must be a number or null`);
  if (typeof value.title !== "string") invalid(`${at}.title must be a string`);
  if (value.note !== null && typeof value.note !== "string") invalid(`${at}.note must be a string or null`);
  if (!isFiniteNumber(value.createdAt)) invalid(`${at}.createdAt must be a number`);
  if (!isFiniteNumber(value.updatedAt)) invalid(`${at}.updatedAt must be a number`);
  if (!isOptionalNullableNumber(value.deletedAt)) invalid(`${at}.deletedAt must be a number or null`);
  if (value.episode !== undefined && value.episode !== null) {
    if (!isObject(value.episode)) return invalid(`${at}.episode must be an object or null`);
    if (typeof value.episode.episodeId !== "string") invalid(`${at}.episode.episodeId must be a string`);
    if (value.episode.audioRelPath !== null && typeof value.episode.audioRelPath !== "string") {
      invalid(`${at}.episode.audioRelPath must be a string or null`);
    }
  }
};

/**
 * Checks a `PUT` body's shape. Unknown fields, on the body and on records, are
 * allowed and preserved so a newer client's additions survive.
 */
export const validateSidecarWrite = (body: unknown): BookmarkSidecarWrite => {
  if (!isObject(body)) return invalid("Body must be a JSON object");
  if (body.mediaKind !== "book" && body.mediaKind !== "podcast") invalid('mediaKind must be "book" or "podcast"');

  if (!isObject(body.item)) invalid("item must be an object");
  const item = body.item as Json;
  for (const key of ["title", "author", "asin", "relPath"]) {
    if (!isOptionalNullableString(item[key])) invalid(`item.${key} must be a string or null`);
  }

  if (body.audioFingerprint !== null && body.audioFingerprint !== undefined) {
    const fingerprint = body.audioFingerprint;
    if (
      !isObject(fingerprint) ||
      !isFiniteNumber(fingerprint.durationSeconds) ||
      !Number.isInteger(fingerprint.trackCount)
    ) {
      invalid("audioFingerprint must be null or { durationSeconds: number, trackCount: integer }");
    }
  }

  if (body.episodeFingerprints !== undefined && body.episodeFingerprints !== null) {
    if (!isObject(body.episodeFingerprints) || !Object.values(body.episodeFingerprints).every(isFiniteNumber)) {
      invalid("episodeFingerprints must be null or an object of numbers");
    }
  }

  if (!Array.isArray(body.records)) return invalid("records must be an array");
  body.records.forEach(validateRecord);
  const ids = new Set<string>();
  for (const record of body.records as Json[]) {
    if (ids.has(record.id as string)) invalid(`Duplicate record id "${String(record.id)}"`);
    ids.add(record.id as string);
  }

  return { ...body, audioFingerprint: body.audioFingerprint ?? null } as unknown as BookmarkSidecarWrite;
};
