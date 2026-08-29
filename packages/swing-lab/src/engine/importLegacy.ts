import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CORPUS_DIR, REPO_ROOT, commonsSourceId, ensureCorpus, loadRecordings,
  recordingIdForHash, upsertRecording, upsertSource,
  type RecordingLineage, type RecordingRecord, type SourceRecord,
} from "./corpus.js";
import { probeMedia, sha256File } from "./probe.js";
import { rightsForLicense } from "./rights.js";
import { assignSplit, loadSplits, saveSplits, type SplitsFile } from "./splits.js";

/**
 * ONE-TIME LEGACY IMPORT: datasets/paddle-bench/registry.json → corpus.
 *
 *   pnpm lab:corpus-init
 *
 * Upgrades the v1 flat registry to the hierarchical corpus with explicit
 * per-modality rights, declared lineage for every derived clip, and PINNED
 * split assignments that preserve the held-out discipline built up so far
 * (sessions whose footage was already inspected can never be promoted to
 * locked_test/shadow). Idempotent: re-running upserts the same records.
 */

interface LegacyVideo {
  id: string;
  file: string;
  source: string;
  author?: string;
  license: string;
  sessionKey?: string;
  description?: string;
  dateAcquiredIso?: string;
  usageRestrictions?: string;
}

/** Sessions already inspected in previous runs — the reason is the pin. */
const PINNED_SPLITS: SplitsFile["pinned"] = {
  "wm-tournament-2014": {
    split: "dev",
    reason: "volley-02 is a dev case; the same recording also holds held-out CASE wm-dink-01 (v0.1 KNOWN LIMITATION — session-level split impossible for this recording; future wm sessions must separate)",
  },
  "afn-sasebo-2025-06": { split: "dev", reason: "rally1/rally2 used for identity/occlusion/event debugging across runs" },
  "afn-sigonella-2025": { split: "dev", reason: "inspected during acquisition (clinic/interview footage)" },
  "afn-vic-2025": {
    split: "locked_test",
    reason: "held-out discipline from v0.1: selected from stills, single evaluation after freezing, no threshold iteration",
  },
  "dvids-marne-2024": { split: "dev", reason: "mined; candidate list inspected and published in HANDOFF" },
  "dvids-warriorgames-2026": { split: "dev", reason: "mined; candidate list inspected" },
  "dvids-warriorgames-2026-broll": {
    split: "val",
    reason: "registered with human-written description — possibly viewed; conservative: eligible for decisions, NOT for locked_test/shadow",
  },
};

function originOf(video: LegacyVideo, byId: Map<string, LegacyVideo>): {
  sourceId: string; origin: SourceRecord["origin"]; originId: string; url: string; parentId: string | null;
} {
  const derivedMatch =
    video.source.match(/^derived from ([\w-]+)/i) ?? video.description?.match(/Derived from ([\w-]+)/i) ?? null;
  if (derivedMatch) {
    const parent = byId.get(derivedMatch[1]!);
    if (!parent) throw new Error(`${video.id}: derived-from parent ${derivedMatch[1]} not in registry`);
    const parentOrigin = originOf(parent, byId);
    return { ...parentOrigin, parentId: parent.id };
  }
  const commonsMatch = video.source.match(/commons\.wikimedia\.org\/wiki\/File:(.+)$/);
  if (commonsMatch) {
    const title = decodeURIComponent(commonsMatch[1]!).replace(/_/g, " ");
    return { sourceId: commonsSourceId(title), origin: "wikimedia_commons", originId: title, url: video.source, parentId: null };
  }
  const dvidsMatch = video.source.match(/dvidshub\.net\/video\/(\d+)\//);
  if (dvidsMatch) {
    return { sourceId: `src-dvids-${dvidsMatch[1]}`, origin: "dvids", originId: dvidsMatch[1]!, url: video.source, parentId: null };
  }
  throw new Error(`${video.id}: unrecognized source "${video.source}"`);
}

function lineageRelation(video: LegacyVideo): RecordingLineage["relation"] {
  const description = video.description ?? "";
  if (/crop \(\d+x\d+/i.test(description)) return "spatial_crop";
  if (/derived from .*\(\d+(\.\d+)?-\d+(\.\d+)?s\)/i.test(description) || /\(\d+(\.\d+)?-\d+(\.\d+)?s\)/.test(description)) {
    return "time_crop";
  }
  return "transcode";
}

const isMain = process.argv[1]?.endsWith("importLegacy.ts");
if (isMain) {
  const paths = ensureCorpus();
  const legacy = JSON.parse(readFileSync(join(REPO_ROOT, "datasets/paddle-bench/registry.json"), "utf8")) as {
    videos: LegacyVideo[];
  };
  const byId = new Map(legacy.videos.map((video) => [video.id, video]));
  const splits = loadSplits(paths.splits);
  splits.pinned = { ...PINNED_SPLITS, ...splits.pinned };

  (async () => {
    // Pass 1: roots before derived clips so lineage parents resolve.
    const ordered = [...legacy.videos].sort((a, b) => Number(!!originOf(a, byId).parentId) - Number(!!originOf(b, byId).parentId));
    const recordingIdByLegacyId = new Map<string, string>();
    let imported = 0;
    for (const video of ordered) {
      const { sourceId, origin, originId, url, parentId } = originOf(video, byId);
      const root = parentId ? byId.get(parentId)! : video;
      const source: SourceRecord = {
        schemaVersion: 1,
        sourceId,
        origin,
        originId,
        url,
        title: root.description?.split(".")[0] ?? root.id,
        author: root.author ?? "unknown",
        license: root.license,
        rights: rightsForLicense(root.license, "lab:corpus-init (rule-derived from v1 registry license)"),
        acquisition: {
          acquiredAtIso: root.dateAcquiredIso ?? "2026-08-27",
          method: "manual acquisition in earlier runs (v1 registry)",
          tool: "legacy import",
        },
        restrictions: root.usageRestrictions ? [root.usageRestrictions] : [],
        description: root.description,
        notes: "imported from datasets/paddle-bench/registry.json (schema v1)",
      };
      upsertSource(source);

      const mediaPath = join(REPO_ROOT, "datasets/paddle-bench", video.file);
      const sha256 = await sha256File(mediaPath);
      const recordingId = recordingIdForHash(sha256);
      recordingIdByLegacyId.set(video.id, recordingId);
      const derivedFrom: RecordingLineage[] = [];
      if (parentId) {
        const parentRecordingId = recordingIdByLegacyId.get(parentId);
        if (!parentRecordingId) throw new Error(`${video.id}: parent ${parentId} not yet imported`);
        derivedFrom.push({
          parentRecordingId,
          relation: lineageRelation(video),
          detail: video.description ?? "derived clip (see v1 registry)",
          evidence: "declared",
        });
      }
      const sessionKey = video.sessionKey ?? (parentId ? byId.get(parentId)!.sessionKey ?? video.id : video.id);
      const recording: RecordingRecord = {
        schemaVersion: 1,
        recordingId,
        sourceId,
        path: join("datasets/paddle-bench", video.file),
        sha256,
        probe: probeMedia(mediaPath),
        sessionKey,
        registeredAtIso: new Date().toISOString(),
        derivedFrom,
        notes: `legacy id: ${video.id}`,
      };
      const existing = loadRecordings().find((entry) => entry.recordingId === recordingId);
      if (existing) recording.registeredAtIso = existing.registeredAtIso;
      upsertRecording(recording);
      assignSplit(splits, sessionKey);
      imported += 1;
      console.log(`✓ ${video.id.padEnd(26)} → ${recordingId} · ${sourceId} · session ${sessionKey} · split ${splits.assigned[sessionKey]!.split}${derivedFrom.length ? ` · derived(${derivedFrom[0]!.relation})` : ""}`);
    }
    saveSplits(paths.splits, splits);
    console.log("═".repeat(66));
    console.log(`imported ${imported} legacy files into ${CORPUS_DIR.replace(`${REPO_ROOT}/`, "")}`);
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
