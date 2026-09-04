/**
 * Deterministic fixtures for the screen audit: seeded RNG, adversarial string
 * corpus (Cyrillic, CJK, Arabic/RTL, German compounds, emoji, control chars),
 * fixture builders for the mobile repository row shapes, and the artifact
 * writer every screen audit uses.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import type {
  CaptureHistoryEntry,
  LocalShotRow,
  PendingCapture,
  RealAnalysisFact,
} from '../../../src/data/repository';
import type { CaptureEvidenceV1 } from '../../../src/camera/capture';
import type { CanonicalProgress } from '../../../src/progress/api';
import type { Cell, Issue, TreeAudit } from './treeAudit';

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — every failure records its seed.
// ---------------------------------------------------------------------------
export class Rng {
  private state: number;
  constructor(readonly seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, maxInclusive: number): number {
    return min + Math.floor(this.next() * (maxInclusive - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    const v = items[this.int(0, items.length - 1)];
    if (v === undefined) throw new Error('pick from empty list');
    return v;
  }
  bool(p = 0.5): boolean {
    return this.next() < p;
  }
}

// ---------------------------------------------------------------------------
// Adversarial strings
// ---------------------------------------------------------------------------
export const ADVERSARIAL_STRINGS = {
  cyrillic: 'Тренировка удара с лёта на кухне против сильного соперника',
  cjk: '厨房线附近的截击训练与反手切削练习课程',
  arabic: 'تدريب الضربة الخلفية عند خط المطبخ مع شريك',
  german:
    'Rückhandvolleytrainingsvorbereitungsgeschwindigkeitsmessungsergebnis',
  germanLong:
    'Donaudampfschifffahrtselektrizitätenhauptbetriebswerkbauunterbeamtengesellschaft',
  emoji: '🏓🔥💪 Dink ladder 🥒🥒🥒',
  mixedRtl: 'Serve ‏تدريب‎ drill',
  whitespace: '  Padded   name  ',
  html: '<b>Bold</b> & <script>alert(1)</script>',
  longLatin:
    'An extraordinarily long free-form drill description that keeps going well beyond any reasonable card width to see how wrapping behaves',
  zeroWidth: 'Dink\u200B\u200B\u200Bladder\u200D',
  combining:
    'Z\u0351\u036B\u0343\u036A\u0302\u036B\u033D\u034F\u0334\u0319\u0324\u031E\u0349\u035A\u032F\u031E\u0320\u034DA\u036B\u0357\u0334\u0362\u0335\u031C\u0330\u0354L\u0368\u0367\u0369\u0358\u0320G\u0311\u0357\u030E\u0305\u035B\u0341\u0334\u033B\u0348\u034D\u0354\u0339O\u0342\u030C\u030C\u0358\u0328\u0335\u0339\u033B\u031D\u0333',
  empty: '',
  single: 'A',
} as const;

export type AdversarialKey = keyof typeof ADVERSARIAL_STRINGS;
export const ADVERSARIAL_KEYS = Object.keys(
  ADVERSARIAL_STRINGS,
) as AdversarialKey[];

// Real canonical shot types plus adversarial "unknown" slugs that a DB row
// written by a future/older build might carry.
export const SHOT_TYPE_POOL = [
  'dink',
  'forehand_drive',
  'backhand_drive',
  'serve',
  'third_shot_drop',
  'volley',
  'overhead',
  'return_of_serve',
  'backhand_roll_volley_from_transition_zone_under_pressure',
  ADVERSARIAL_STRINGS.german,
  ADVERSARIAL_STRINGS.cjk,
  ADVERSARIAL_STRINGS.arabic,
  ADVERSARIAL_STRINGS.cyrillic,
] as const;

export const CHECKPOINT_POOL = [
  'contact_position',
  'preparation',
  'paddle_set',
  'follow_through',
  'footwork',
  'balance',
  'recovery',
  'kinetic_chain_sequencing_hip_shoulder_separation',
  ADVERSARIAL_STRINGS.german,
] as const;

const DAY_MS = 86_400_000;

export function isoDaysAgo(days: number, hour = 10, base = FIXED_NOW): string {
  const d = new Date(base.getTime() - days * DAY_MS);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

/** Deterministic "now" for every scenario: a Tuesday in mid March. */
export const FIXED_NOW = new Date('2026-03-10T18:00:00.000Z');

export function makeShot(
  rng: Rng,
  index: number,
  overrides: Partial<LocalShotRow> = {},
): LocalShotRow {
  const scored = rng.bool(0.8);
  return {
    id: `shot-${rng.seed}-${index}`,
    sessionId: rng.bool(0.5) ? `session-${rng.seed}-${rng.int(0, 3)}` : null,
    shotType: rng.pick(SHOT_TYPE_POOL),
    capturedAt: isoDaysAgo(rng.int(0, 45), rng.int(0, 23)),
    overallScore: scored
      ? rng.pick([0, 0.4, 3.333333, 6.2, 7.95, 9.99, 10, 10.0001])
      : null,
    confidence: rng.pick([0, 0.12, 0.5, 0.87, 1, 1.5, -0.1]),
    resultKind: scored
      ? 'scored'
      : rng.pick(['abstained', 'abstain', 'unknown_kind', '']),
    source: rng.pick(['device', 'legacy', 'import', '']),
    favorite: rng.bool(0.3),
    ...overrides,
  };
}

export function makeFact(
  rng: Rng,
  index: number,
  overrides: Partial<RealAnalysisFact> = {},
): RealAnalysisFact {
  const scored = rng.bool(0.8);
  const checkpoints: Record<string, number> = {};
  const count = rng.int(0, 5);
  for (let i = 0; i < count; i += 1) {
    checkpoints[rng.pick(CHECKPOINT_POOL)] = rng.pick([
      0, 12.5, 50, 77.7777, 100, 100.5,
    ]);
  }
  return {
    id: `fact-${rng.seed}-${index}`,
    shotType: rng.pick(SHOT_TYPE_POOL),
    capturedAt: isoDaysAgo(rng.int(0, 45), rng.int(0, 23)),
    overallScore: scored
      ? rng.pick([0, 0.4, 3.333333, 6.2, 7.95, 9.99, 10])
      : null,
    confidence: rng.pick([0, 0.12, 0.5, 0.87, 1]),
    resultKind: scored ? 'scored' : 'low_confidence',
    scoringModelVersion: rng.pick([
      '1.0.0',
      '2026.03.01',
      '',
      'v9-experimental-long-model-identifier',
    ]),
    shotConfigVersion: rng.pick(['1', '2', '']),
    sessionId: rng.bool(0.5) ? `session-${rng.seed}-${rng.int(0, 3)}` : null,
    priorityCheckpoint: rng.bool(0.7) ? rng.pick(CHECKPOINT_POOL) : null,
    checkpointScores: checkpoints,
    ...overrides,
  };
}

export function makePendingCapture(
  rng: Rng,
  index: number,
  overrides: Partial<PendingCapture> = {},
): PendingCapture {
  return {
    id: `capture-${rng.seed}-${index}`,
    shotType: rng.pick(SHOT_TYPE_POOL),
    declaredStroke: rng.bool(0.5) ? 'dink' : null,
    uri: `file:///var/mobile/Containers/Data/Application/${rng.seed}/clip-${index}.mov`,
    capturedAtIso: isoDaysAgo(rng.int(0, 45), rng.int(0, 23)),
    durationMs: rng.pick([0, 800, 4200, 30_000, 3_600_000]),
    fps: rng.pick([0, 24, 30, 60, 240]),
    width: rng.pick([0, 720, 1080, 1920]),
    height: rng.pick([0, 1280, 1920, 1080]),
    clip: null,
    evidenceStatus: rng.pick([
      'valid',
      'legacy',
      'corrupt',
      'metadata_mismatch',
    ]),
    ...overrides,
  };
}

/**
 * Repository-shaped capture that PASSES `isVerifiedPracticeCapture` (valid
 * evidence, clip metadata identical to the row). `kind` picks the guided
 * automatic capture (with pose evidence) or an imported clip whose pose
 * sequence has been measured. `daysAgo`/`hour` place it deterministically.
 */
export function makeVerifiedCapture(
  rng: Rng,
  index: number,
  kind: 'automatic' | 'imported',
  daysAgo: number,
  overrides: Partial<CaptureHistoryEntry> = {},
): CaptureHistoryEntry {
  const id = `vcap-${rng.seed}-${index}`;
  const uri = `file:///var/mobile/Containers/Data/Application/${rng.seed}/${id}.mov`;
  const capturedAtIso = isoDaysAgo(daysAgo, rng.int(5, 21));
  const base = {
    uri,
    capturedAtIso,
    durationMs: rng.pick([1_200, 3_000, 4_200]),
    fps: rng.pick([30, 60]),
    width: 1_080,
    height: 1_920,
  };
  const evidence: CaptureEvidenceV1 = {
    schemaVersion: 1,
    window: 'detected_motion',
    poseSource: 'apple_vision_body_pose',
    poseModelVersion: 'apple-vision-bodypose-1',
    triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
    motionUnit: 'normalized_image_units_per_second',
    poseFrameCount: rng.int(2, 40),
    poseMissingFrameCount: rng.int(0, 2),
    analysisInputFrameCount: 42,
    trackedDurationMs: rng.pick([120, 300, 950]),
    meanCanonicalJointVisibility: rng.pick([0.4, 0.8, 1]),
    meanJointCoverage: rng.pick([0.33333, 0.75, 1]),
    minimumJointCoverage: 0.6,
    fullBodyVisibleFrameCount: 2,
    jointMotion: [
      {
        joint: 'right_wrist',
        sampleCount: 2,
        meanNormalizedPerSecond: 0.8,
        peakNormalizedPerSecond: 1.2,
      },
    ],
  };
  const clip: CaptureHistoryEntry['clip'] =
    kind === 'automatic'
      ? {
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
            confidence: 0.82,
            source: 'temporal_pose_motion',
            modelVersion: 'temporal-stroke-heuristic-2',
          },
          captureEvidence: evidence,
          ballSpeed: {
            status: 'unavailable',
            reason: 'calibrated_ball_tracker_unavailable',
          },
          preRollMs: 1_000,
          postRollMs: 1_200,
        }
      : {
          ...base,
          captureMode: 'imported_video',
          recognition: { status: 'unknown', reason: 'analysis_not_run' },
          ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
          poseSequence: {
            schemaVersion: 1,
            format: 'pickle.pose-sequence.v1',
            uri: `${uri}.pose.json`,
            frameCount: 117,
            sha256: 'c'.repeat(64),
            coordinateSystem: 'normalized_image_top_left',
            poseModelVersion: 'apple-vision-bodypose-1',
          },
        };
  return {
    id,
    shotType: rng.pick(SHOT_TYPE_POOL),
    declaredStroke: rng.bool(0.5) ? 'dink' : null,
    ...base,
    evidenceStatus: 'valid',
    status: rng.bool(0.6) ? 'analyzed' : 'awaiting_model',
    clip,
    ...overrides,
  } as CaptureHistoryEntry;
}

export function makeCanonicalProgress(rng: Rng): CanonicalProgress {
  const days = rng.int(0, 14);
  const series = [];
  for (let i = 0; i < days; i += 1) {
    series.push({
      day: isoDaysAgo(i).slice(0, 10),
      shotType: rng.pick(SHOT_TYPE_POOL),
      scoringModelVersion: '1.0.0',
      shotCount: rng.int(0, 40),
      avgScore: rng.pick([0, 4.5, 6.66666, 10]),
      bestScore: rng.pick([0, 7, 10]),
    });
  }
  // One entry per checkpoint, like the server's per-checkpoint aggregate
  // (ProgressScreen keys these rows by checkpoint).
  const uniqueCheckpoints = (count: number): string[] =>
    Array.from(
      new Set(Array.from({ length: count }, () => rng.pick(CHECKPOINT_POOL))),
    );
  return {
    series,
    improving: uniqueCheckpoints(rng.int(0, 4)).map(checkpoint => ({
      checkpoint,
      delta: rng.pick([0, 0.1, 12.345, -3, 100]),
    })),
    needsAttention: uniqueCheckpoints(rng.int(0, 4)).map(checkpoint => ({
      checkpoint,
      avg: rng.pick([0, 33.3333, 50, 99.9]),
    })),
    streak: {
      currentDays: rng.pick([0, 1, 7, 365, 10_000]),
      longestDays: rng.pick([0, 1, 7, 365, 10_000]),
      practicedToday: rng.bool(),
      lastPracticeDate: rng.bool(0.7)
        ? isoDaysAgo(rng.int(0, 30)).slice(0, 10)
        : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Artifact writer
// ---------------------------------------------------------------------------
export interface ScenarioResult {
  id: string;
  screen: string;
  state: string;
  seed: number | null;
  cell: Cell;
  inputs: Record<string, unknown>;
  renderMs: number;
  threw: string | null;
  textCount: number;
  controlCount: number;
  issues: Issue[];
  focusOrder?: TreeAudit['focusOrder'];
  texts?: TreeAudit['texts'];
  controls?: TreeAudit['controls'];
  notes?: string[];
}

export function repoRoot(): string {
  return path.resolve(__dirname, '../../../../..');
}

export function artifactDir(): string {
  const dir = path.join(repoRoot(), 'artifacts', 'screen-ux-a11y-i18n-2');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function gitHead(): string {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: repoRoot(),
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

export function summarize(results: ScenarioResult[]) {
  const byKind: Record<
    string,
    {
      count: number;
      scenarios: string[];
      example: string;
      confidence: string;
      severityHint: string;
    }
  > = {};
  for (const r of results) {
    for (const issue of r.issues) {
      const entry = byKind[issue.kind] ?? {
        count: 0,
        scenarios: [],
        example: issue.detail,
        confidence: issue.confidence,
        severityHint: issue.severityHint,
      };
      entry.count += 1;
      if (!entry.scenarios.includes(r.id) && entry.scenarios.length < 40)
        entry.scenarios.push(r.id);
      byKind[issue.kind] = entry;
    }
  }
  const matrix: Record<string, Record<string, number>> = {};
  for (const r of results) {
    const cellKey = `fs${r.cell.fontScale}@${r.cell.width}${r.cell.rtl ? '-rtl' : ''}`;
    for (const issue of r.issues) {
      matrix[issue.kind] = matrix[issue.kind] ?? {};
      const row = matrix[issue.kind]!;
      row[cellKey] = (row[cellKey] ?? 0) + 1;
    }
  }
  return {
    scenarios: results.length,
    threw: results
      .filter(r => r.threw)
      .map(r => ({ id: r.id, seed: r.seed, error: r.threw })),
    issuesByKind: byKind,
    matrixByCell: matrix,
  };
}

export function writeArtifacts(
  screen: string,
  results: ScenarioResult[],
  extra: Record<string, unknown> = {},
) {
  const dir = artifactDir();
  const summary = summarize(results);
  const payload = {
    screen,
    commit: gitHead(),
    generatedAt: new Date().toISOString(),
    method:
      'react-test-renderer host tree; font scale / width / RTL injected via mocked useWindowDimensions + I18nManager; layout numbers are heuristic estimates (INFERRED); props/labels/copy are VERIFIED from the rendered tree.',
    ...extra,
    summary,
    scenarios: results,
  };
  fs.writeFileSync(
    path.join(dir, `${screen}.json`),
    JSON.stringify(payload, null, 1),
  );
  fs.writeFileSync(
    path.join(dir, `${screen}.summary.json`),
    JSON.stringify(
      { screen, commit: payload.commit, ...extra, summary },
      null,
      2,
    ),
  );
  const lines = ['issueKind\tcell\tcount'];
  for (const [kind, row] of Object.entries(summary.matrixByCell)) {
    for (const [cell, count] of Object.entries(row))
      lines.push(`${kind}\t${cell}\t${count}`);
  }
  fs.writeFileSync(
    path.join(dir, `${screen}.matrix.tsv`),
    lines.join('\n') + '\n',
  );
  return summary;
}
