/**
 * Bookmark Sidecar file format (ADR 0046). A Bookmark Sidecar is the hidden
 * `.laabs.bookmarks.<absUserId>.json` file a LAABS Companion keeps in an
 * Audiobookshelf item folder. The LAABS Companion repository mirrors these
 * types; see BookmarkSidecarImplementationPlan.md §1–2.
 */

export const BOOKMARK_SIDECAR_SCHEMA_VERSION = 1;

/** Audio durations within this many seconds count as the same audio. */
export const SIDECAR_DURATION_TOLERANCE_SECONDS = 2;

export type SidecarMediaKind = "book" | "podcast";

export type SidecarAudioFingerprint = {
  durationSeconds: number;
  trackCount: number;
};

export type SidecarEpisodeRef = {
  /** Hint only: Audiobookshelf regenerates episode ids on a database rebuild. */
  episodeId: string;
  /** The Episode's audio file path inside the Podcast folder; the durable Episode key. */
  audioRelPath: string | null;
};

/** Key into `episodeFingerprints`: the audio path when known, else the episode id. */
export const episodeFingerprintKey = (ref: SidecarEpisodeRef) => ref.audioRelPath ?? ref.episodeId;

export type SidecarBookmarkRecord = {
  id: string;
  kind: "point" | "clip";
  startTimeSeconds: number;
  endTimeSeconds?: number | null;
  title: string;
  note: string | null;
  createdAt: number;
  updatedAt: number;
  /** Deletion marker. When set, `updatedAt` equals it. */
  deletedAt?: number | null;
  episode?: SidecarEpisodeRef | null;
};

export type SidecarItemInfo = {
  title?: string | null;
  author?: string | null;
  asin?: string | null;
  relPath?: string | null;
};

export type BookmarkSidecarDocument = {
  schemaVersion: number;
  absUserId: string;
  username: string;
  libraryItemId: string;
  mediaKind: SidecarMediaKind;
  item: SidecarItemInfo;
  /** Books only. */
  audioFingerprint: SidecarAudioFingerprint | null;
  /** Podcasts only: each Episode's Audio Fingerprint (duration seconds) by `episodeFingerprintKey`. */
  episodeFingerprints?: Record<string, number> | null;
  updatedAt: number;
  records: SidecarBookmarkRecord[];
};

/** Body of `PUT /v1/items/:libraryItemId/bookmarks`. */
export type BookmarkSidecarWrite = {
  mediaKind: SidecarMediaKind;
  item: SidecarItemInfo;
  audioFingerprint: SidecarAudioFingerprint | null;
  /** Replaces the stored map wholesale. */
  episodeFingerprints?: Record<string, number> | null;
  records: SidecarBookmarkRecord[];
};

export const isSidecarSchemaWritable = (document: Pick<BookmarkSidecarDocument, "schemaVersion">) =>
  document.schemaVersion <= BOOKMARK_SIDECAR_SCHEMA_VERSION;
