import type { SidecarBookmarkRecord } from "./sidecar-format";

/**
 * Per-record last-write-wins (ADR 0046). The LAABS Companion runs the same
 * merge server-side, so keep this free of app imports.
 */
const pickNewer = (
  local: SidecarBookmarkRecord,
  remote: SidecarBookmarkRecord,
): SidecarBookmarkRecord => {
  if (local.updatedAt !== remote.updatedAt) {
    return local.updatedAt > remote.updatedAt ? local : remote;
  }
  // Tie: a deletion wins so a stale copy cannot resurrect a deleted bookmark.
  if (Boolean(local.deletedAt) !== Boolean(remote.deletedAt)) {
    return local.deletedAt ? local : remote;
  }
  return remote;
};

export const mergeSidecarRecords = (
  local: readonly SidecarBookmarkRecord[],
  remote: readonly SidecarBookmarkRecord[],
): SidecarBookmarkRecord[] => {
  const merged = new Map<string, SidecarBookmarkRecord>();
  remote.forEach((record) => merged.set(record.id, record));
  local.forEach((record) => {
    const existing = merged.get(record.id);
    merged.set(record.id, existing ? pickNewer(record, existing) : record);
  });
  return [...merged.values()].sort(
    (left, right) =>
      left.startTimeSeconds - right.startTimeSeconds || left.id.localeCompare(right.id),
  );
};

/**
 * The fields a user can change. `updatedAt`, server-link status, Episode
 * references, and other bookkeeping are excluded so they never count as an edit.
 */
export const recordContentHash = (record: SidecarBookmarkRecord): string =>
  JSON.stringify([
    record.deletedAt ? "deleted" : "live",
    record.kind,
    record.startTimeSeconds,
    record.kind === "clip" ? (record.endTimeSeconds ?? null) : null,
    record.title,
    record.note ?? null,
  ]);

export const areSidecarRecordListsEqual = (
  left: readonly SidecarBookmarkRecord[],
  right: readonly SidecarBookmarkRecord[],
) => {
  if (left.length !== right.length) return false;
  const rightById = new Map(right.map((record) => [record.id, record]));
  return left.every((record) => {
    const other = rightById.get(record.id);
    return (
      Boolean(other) &&
      other!.updatedAt === record.updatedAt &&
      recordContentHash(other!) === recordContentHash(record)
    );
  });
};
