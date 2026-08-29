import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MediaProbe } from "./probe.js";
import type { RightsProfile } from "./rights.js";

/**
 * CORPUS STORE — the hierarchical source of truth for the data factory.
 *
 *   SOURCE (platform record: who published what, under which rights)
 *     └─ RECORDING (one media file: content-hashed, probed, fingerprinted)
 *          └─ SESSION (sessionKey: one venue+occasion; the split unit)
 *               └─ scenes → player tracks → STROKE EVENT candidates (JSONL)
 *
 * Layout (designed so growth never rewrites history):
 *   datasets/corpus/sources.json          — SourceRecord[]
 *   datasets/corpus/recordings.json       — RecordingRecord[]
 *   datasets/corpus/splits.json           — split policy state + audit
 *   datasets/corpus/events/<recId>.jsonl  — CandidateEventRecord per line
 *   datasets/corpus/fingerprints/<recId>.json
 *   datasets/corpus/runs/<recId>/         — extraction artifacts per stage
 *   datasets/corpus/media/                — acquired media files
 *   datasets/corpus/factory-state.json    — resumable per-stage status
 *
 * sources/recordings stay single-file JSON while they hold thousands of
 * entries (a few MB); events — the collection that reaches 10^5–10^6 —
 * are sharded per recording from day one.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "../../../..");
export const CORPUS_DIR = join(REPO_ROOT, "datasets/corpus");

export type SourceOrigin = "dvids" | "wikimedia_commons" | "first_party" | "manual";

export interface SourceRecord {
  schemaVersion: 1;
  sourceId: string; // src-<origin>-<originId>
  origin: SourceOrigin;
  originId: string; // platform-native id (DVIDS video id, Commons file title)
  url: string; // canonical public page
  title: string;
  author: string;
  publishedDate?: string | undefined;
  license: string;
  rights: RightsProfile;
  acquisition: {
    acquiredAtIso: string;
    method: string; // e.g. "lab:acquire dvids-page-parse+cloudfront"
    mediaUrl?: string | undefined; // direct media URL used
    tool: string;
  };
  restrictions: string[];
  description?: string | undefined;
  notes?: string | undefined;
}

export interface RecordingLineage {
  parentRecordingId: string;
  relation: "time_crop" | "spatial_crop" | "transcode" | "unknown_overlap";
  detail: string;
  /** declared = registered by a human/import; detected = phash overlap. */
  evidence: "declared" | "detected" | "declared+detected";
}

export type SplitName = "dev" | "val" | "locked_test" | "shadow";

export interface RecordingRecord {
  schemaVersion: 1;
  recordingId: string; // rec-<sha256[:12]> (content-addressed)
  sourceId: string;
  path: string; // repo-relative media path
  sha256: string;
  probe: MediaProbe;
  sessionKey: string;
  registeredAtIso: string;
  derivedFrom: RecordingLineage[];
  /** Distinct real people count if known; null = unknown. */
  notes?: string;
}

export interface CandidateEventRecord {
  schemaVersion: 1;
  eventId: string; // evt-<recId12>-s<scene>-p<track>-<peakMs>
  tier: "C"; // candidates are NEVER labels
  recordingId: string;
  sourceId: string;
  sessionKey: string;
  split: SplitName;
  sceneIndex: number;
  sceneStartMs: number;
  sceneEndMs: number;
  /** Mining window inside the scene (long scenes are mined in 12s windows). */
  windowIndex: number;
  playerTrackId: number;
  playerCoverage: number;
  meanTorsoSpan: number;
  /** Track torso position at the motion peak (annotation + dedup aid). */
  torsoAtPeak: { x: number; y: number };
  peopleInScene: number;
  startMs: number;
  peakMs: number;
  endMs: number;
  peakSpeed: number;
  prominence: number;
  uncertainty: number;
  reasons: string[];
  minerVersion: string;
  minedAtIso: string;
}

export interface CorpusPaths {
  sources: string;
  recordings: string;
  splits: string;
  eventsDir: string;
  fingerprintsDir: string;
  runsDir: string;
  mediaDir: string;
  factoryState: string;
}

export function corpusPaths(root = CORPUS_DIR): CorpusPaths {
  return {
    sources: join(root, "sources.json"),
    recordings: join(root, "recordings.json"),
    splits: join(root, "splits.json"),
    eventsDir: join(root, "events"),
    fingerprintsDir: join(root, "fingerprints"),
    runsDir: join(root, "runs"),
    mediaDir: join(root, "media"),
    factoryState: join(root, "factory-state.json"),
  };
}

export function ensureCorpus(root = CORPUS_DIR): CorpusPaths {
  const paths = corpusPaths(root);
  for (const dir of [root, paths.eventsDir, paths.fingerprintsDir, paths.runsDir, paths.mediaDir]) {
    mkdirSync(dir, { recursive: true });
  }
  return paths;
}

function readJsonArray<T>(path: string): T[] {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T[]) : [];
}

/** Atomic write: tmp file + rename, so a crash never truncates the registry. */
function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

export function loadSources(root = CORPUS_DIR): SourceRecord[] {
  return readJsonArray<SourceRecord>(corpusPaths(root).sources);
}

export function loadRecordings(root = CORPUS_DIR): RecordingRecord[] {
  return readJsonArray<RecordingRecord>(corpusPaths(root).recordings);
}

export function saveSources(sources: SourceRecord[], root = CORPUS_DIR): void {
  writeJsonAtomic(
    corpusPaths(root).sources,
    [...sources].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
  );
}

export function saveRecordings(recordings: RecordingRecord[], root = CORPUS_DIR): void {
  writeJsonAtomic(
    corpusPaths(root).recordings,
    [...recordings].sort((a, b) => a.recordingId.localeCompare(b.recordingId)),
  );
}

export function upsertSource(record: SourceRecord, root = CORPUS_DIR): void {
  const sources = loadSources(root);
  const index = sources.findIndex((existing) => existing.sourceId === record.sourceId);
  if (index >= 0) sources[index] = record;
  else sources.push(record);
  saveSources(sources, root);
}

export function upsertRecording(record: RecordingRecord, root = CORPUS_DIR): void {
  const recordings = loadRecordings(root);
  const index = recordings.findIndex((existing) => existing.recordingId === record.recordingId);
  if (index >= 0) recordings[index] = record;
  else recordings.push(record);
  saveRecordings(recordings, root);
}

export function recordingIdForHash(sha256: string): string {
  return `rec-${sha256.slice(0, 12)}`;
}

export function sanitizeIdPart(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
}

/** One canonical Commons sourceId shared by acquisition and legacy import. */
export function commonsSourceId(fileTitle: string): string {
  return `src-commons-${sanitizeIdPart(fileTitle.replace(/^File:/, ""))}`;
}

export function eventId(
  recordingId: string,
  sceneIndex: number,
  trackId: number,
  peakMs: number,
  windowIndex = 0,
): string {
  return `evt-${recordingId.replace(/^rec-/, "")}-s${sceneIndex}w${windowIndex}-p${trackId}-${Math.round(peakMs)}`;
}

export function writeEventsShard(
  recordingId: string,
  events: CandidateEventRecord[],
  root = CORPUS_DIR,
): string {
  const path = join(corpusPaths(root).eventsDir, `${recordingId}.jsonl`);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(
    tmp,
    events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""),
  );
  renameSync(tmp, path);
  return path;
}

export function readEventsShard(recordingId: string, root = CORPUS_DIR): CandidateEventRecord[] {
  const path = join(corpusPaths(root).eventsDir, `${recordingId}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CandidateEventRecord);
}

export function readAllEvents(root = CORPUS_DIR): CandidateEventRecord[] {
  const dir = corpusPaths(root).eventsDir;
  if (!existsSync(dir)) return [];
  const events: CandidateEventRecord[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".jsonl"))) {
    events.push(...readEventsShard(file.replace(/\.jsonl$/, ""), root));
  }
  return events;
}

/** Structural invariants that must hold no matter how large the corpus gets. */
export function auditCorpus(root = CORPUS_DIR): string[] {
  const problems: string[] = [];
  const sources = loadSources(root);
  const recordings = loadRecordings(root);
  const sourceIds = new Set(sources.map((source) => source.sourceId));
  if (sourceIds.size !== sources.length) problems.push("duplicate sourceIds");
  const byHash = new Map<string, string[]>();
  for (const recording of recordings) {
    if (!sourceIds.has(recording.sourceId)) {
      problems.push(`${recording.recordingId}: unknown sourceId ${recording.sourceId}`);
    }
    if (!existsSync(join(REPO_ROOT, recording.path))) {
      problems.push(`${recording.recordingId}: missing media file ${recording.path}`);
    }
    if (recording.recordingId !== recordingIdForHash(recording.sha256)) {
      problems.push(`${recording.recordingId}: id does not match content hash`);
    }
    byHash.set(recording.sha256, [...(byHash.get(recording.sha256) ?? []), recording.recordingId]);
    for (const lineage of recording.derivedFrom) {
      if (!recordings.some((parent) => parent.recordingId === lineage.parentRecordingId)) {
        problems.push(
          `${recording.recordingId}: lineage parent ${lineage.parentRecordingId} not registered`,
        );
      }
    }
  }
  for (const [hash, ids] of byHash) {
    if (ids.length > 1)
      problems.push(`byte-identical recordings: ${ids.join(", ")} (${hash.slice(0, 12)})`);
  }
  for (const source of sources) {
    if (!source.license) problems.push(`${source.sourceId}: missing license`);
    if (!source.rights?.basis) problems.push(`${source.sourceId}: missing rights profile`);
    if (!source.url) problems.push(`${source.sourceId}: missing origin URL`);
  }
  return problems;
}
