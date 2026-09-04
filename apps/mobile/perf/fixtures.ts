/**
 * Deterministic fixtures + artifact writer for the render-cost harness.
 *
 * Every generator takes a seeded PRNG so a failing scenario replays from
 * `{seed, count}` alone. Shapes follow the repository types exactly
 * (`LocalShotRow`, `RealAnalysisFact`, `CaptureHistoryEntry`,
 * `PendingCapture`) so the real screens exercise their real code paths.
 */
import { CHECKPOINTS, SHOT_TYPES } from '@pickle/shared-types';
import type {
  CaptureHistoryEntry,
  LocalShotRow,
  PendingCapture,
  RealAnalysisFact,
} from '../src/data/repository';
import type { CaptureEvidenceV1, CapturedClip } from '../src/camera/capture';
import type { DrillDetail, SavedDrill } from '../src/training/types';

// apps/mobile's tsconfig carries no Node types (same pattern as
// __tests__/importedRealFootageAnalysis.test.ts).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const fs = require('fs') as {
  mkdirSync: (dir: string, opts: { recursive: boolean }) => void;
  writeFileSync: (file: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

/** mulberry32 — small, deterministic, good enough for fixture shuffling. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('pick from empty list');
  return item;
}

/** Fixed "now" so day bucketing is stable across runs and time zones. */
export const FIXED_NOW_ISO = '2026-09-03T18:30:00.000Z';
export const FIXED_NOW_MS = Date.parse(FIXED_NOW_ISO);
const HOUR_MS = 3_600_000;

function isoAgo(hours: number): string {
  return new Date(FIXED_NOW_MS - hours * HOUR_MS).toISOString();
}

export function makeShots(seed: number, count: number): LocalShotRow[] {
  const rng = makeRng(seed);
  const rows: LocalShotRow[] = [];
  for (let i = 0; i < count; i += 1) {
    const scored = rng() < 0.85;
    rows.push({
      id: `shot-${seed}-${i}`,
      sessionId: rng() < 0.4 ? `session-${seed}-${Math.floor(i / 6)}` : null,
      shotType: pick(rng, SHOT_TYPES),
      capturedAt: isoAgo(i * 5 + rng() * 3),
      overallScore: scored ? Math.round(rng() * 60 + 30) / 10 : null,
      confidence: Math.round(rng() * 40 + 60) / 100,
      resultKind: scored ? 'scored' : 'low_confidence',
      source: 'real',
      favorite: rng() < 0.1,
    });
  }
  return rows;
}

export function makeFacts(seed: number, count: number): RealAnalysisFact[] {
  const rng = makeRng(seed ^ 0x5bd1e995);
  const facts: RealAnalysisFact[] = [];
  for (let i = 0; i < count; i += 1) {
    const scored = rng() < 0.85;
    const checkpointScores: Record<string, number> = {};
    for (const checkpoint of CHECKPOINTS) {
      if (rng() < 0.8) checkpointScores[checkpoint] = Math.round(rng() * 100);
    }
    facts.push({
      id: `shot-${seed}-${i}`,
      shotType: pick(rng, SHOT_TYPES),
      capturedAt: isoAgo(i * 5 + rng() * 3),
      overallScore: scored ? Math.round(rng() * 60 + 30) / 10 : null,
      confidence: Math.round(rng() * 40 + 60) / 100,
      resultKind: scored ? 'scored' : 'low_confidence',
      scoringModelVersion: 'scoring-model-1',
      shotConfigVersion: 'shot-config-1',
      sessionId: rng() < 0.4 ? `session-${seed}-${Math.floor(i / 6)}` : null,
      priorityCheckpoint: scored ? pick(rng, CHECKPOINTS) : null,
      checkpointScores: scored ? checkpointScores : {},
    });
  }
  return facts;
}

function evidence(rng: () => number): CaptureEvidenceV1 {
  const poseFrameCount = 40 + Math.floor(rng() * 40);
  return {
    schemaVersion: 1,
    window: 'detected_motion',
    poseSource: 'apple_vision_body_pose',
    poseModelVersion: 'apple-vision-bodypose-1',
    triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
    motionUnit: 'normalized_image_units_per_second',
    poseFrameCount,
    poseMissingFrameCount: Math.floor(rng() * 5),
    analysisInputFrameCount: poseFrameCount + 5,
    trackedDurationMs: 300 + Math.floor(rng() * 900),
    meanCanonicalJointVisibility: 0.7 + rng() * 0.3,
    meanJointCoverage: 0.7 + rng() * 0.3,
    minimumJointCoverage: 0.5 + rng() * 0.3,
    fullBodyVisibleFrameCount: Math.floor(poseFrameCount * rng()),
    jointMotion: [
      {
        joint: 'right_wrist',
        sampleCount: 20,
        meanNormalizedPerSecond: 0.5 + rng(),
        peakNormalizedPerSecond: 1 + rng(),
      },
    ],
  };
}

function guidedClip(
  rng: () => number,
  base: {
    uri: string;
    capturedAtIso: string;
    durationMs: number;
    fps: number;
    width: number;
    height: number;
  },
): CapturedClip {
  return {
    ...base,
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: 1_000,
      endMs: 1_800,
      peakMotionMs: 1_500,
      confidence: 0.6 + rng() * 0.4,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: evidence(rng),
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 1_000,
    postRollMs: 1_200,
  };
}

export function makeCaptureHistory(
  seed: number,
  count: number,
): CaptureHistoryEntry[] {
  const rng = makeRng(seed ^ 0x1b873593);
  const entries: CaptureHistoryEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `capture-${seed}-${i}`;
    const base = {
      uri: `file:///captures/${id}.mov`,
      capturedAtIso: isoAgo(i * 5 + rng() * 3),
      durationMs: 2_000 + Math.floor(rng() * 3_000),
      fps: 60,
      width: 1_080,
      height: 1_920,
    };
    entries.push({
      id,
      shotType: 'unrecognized',
      declaredStroke: rng() < 0.7 ? pick(rng, SHOT_TYPES) : null,
      ...base,
      evidenceStatus: 'valid',
      status: rng() < 0.9 ? 'analyzed' : 'awaiting_model',
      clip: guidedClip(rng, base),
    });
  }
  return entries;
}

export function makePendingCaptures(
  seed: number,
  count: number,
): PendingCapture[] {
  return makeCaptureHistory(seed, count).map(
    ({ status: _status, ...rest }) => rest,
  );
}

export function makeSavedDrills(
  seed: number,
  count: number,
): {
  drills: SavedDrill[];
  details: Record<string, DrillDetail>;
} {
  const rng = makeRng(seed ^ 0xe6546b64);
  const drills: SavedDrill[] = [];
  const details: Record<string, DrillDetail> = {};
  for (let i = 0; i < count; i += 1) {
    const slug = `drill-${seed}-${i}`;
    const drill: SavedDrill = {
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      slug,
      title: `Drill ${i} ${pick(rng, SHOT_TYPES).replace(/_/g, ' ')}`,
      description: `Reviewed drill number ${i} for the technique library.`,
      coachName: 'Pickle Sensei Training Library',
      equipment: ['paddle', 'balls'],
      difficultyMin: null,
      difficultyMax: null,
      savedAt: isoAgo(i * 24),
    };
    drills.push(drill);
    details[slug] = {
      id: drill.id,
      slug,
      title: drill.title,
      description: drill.description,
      coachName: drill.coachName,
      equipment: drill.equipment,
      difficultyMin: null,
      difficultyMax: null,
      saved: true,
      mappings:
        rng() < 0.5
          ? [
              {
                checkpoint: pick(rng, CHECKPOINTS),
                shotType: pick(rng, SHOT_TYPES),
                planRole: 'targeted',
                faultDirections: ['too_late'],
                cueText: 'Meet the ball in front of the lead hip.',
                targetSets: 3,
                targetRepetitionsPerSet: 10,
                targetDurationSeconds: null,
                restSeconds: 30,
              },
            ]
          : [],
      instructionalMedia: [
        {
          id: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          kind: 'embed',
          provider: 'youtube',
          videoId: `vid${i}`,
          embedUrl: `https://www.youtube-nocookie.com/embed/vid${i}`,
          sourceUrl: `https://www.youtube.com/watch?v=vid${i}`,
          creatorName: 'Reviewed creator',
          licenseName: 'YouTube Terms of Service',
          licenseUrl: 'https://www.youtube.com/t/terms',
          attribution: 'Video by Reviewed creator on YouTube',
        },
      ],
    };
  }
  return { drills, details };
}

/** Artifacts land under `<repo>/artifacts/perf-mobile-render/` (gitignored)
 * unless `PERF_RENDER_OUT_DIR` points elsewhere. */
export function artifactDir(): string {
  const configured = process.env['PERF_RENDER_OUT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(__dirname, '../../../artifacts/perf-mobile-render');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeArtifact(name: string, data: unknown): string {
  const file = path.join(artifactDir(), name);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

/** All string leaves of a `renderer.toJSON()` tree, joined — props (which
 * may hold React elements and cycles) are ignored on purpose. */
export function renderedText(json: unknown): string {
  const parts: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    visit((node as { children?: unknown }).children);
  };
  visit(json);
  return parts.join(' ');
}

/** Counts rendered host nodes whose `accessibilityLabel` matches — the
 * observable "how many rows did the list mount" for virtualization checks. */
export function countByLabel(
  json: unknown,
  matches: (label: string) => boolean,
): number {
  let count = 0;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const rec = node as {
      props?: { accessibilityLabel?: unknown };
      children?: unknown;
    };
    const label = rec.props?.accessibilityLabel;
    if (typeof label === 'string' && matches(label)) count += 1;
    visit(rec.children);
  };
  visit(json);
  return count;
}
