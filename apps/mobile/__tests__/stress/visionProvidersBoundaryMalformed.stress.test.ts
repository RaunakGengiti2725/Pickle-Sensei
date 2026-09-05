/**
 * STRESS — mod-vision-providers × boundary/malformed input.
 *
 * Unit under attack: apps/mobile/src/vision/providers.ts (provider selection,
 * throws, partial results). Every iteration is generated from a seeded RNG
 * and replayable from its seed; results are emitted as a JSON table
 * (campaign, seed → outcome) when STRESS_OUT names a directory.
 *
 *   STRESS_ITER   iterations per seeded campaign (default 120 — fast enough
 *                 for the suite; the recorded campaign ran 500 × 8 campaigns).
 *   STRESS_SEED   master seed (default 20260905).
 *   STRESS_OUT    directory for the JSON result table (unset = no file).
 *   STRESS_REPLAY "<campaign>:<seed>" runs exactly one iteration and, with
 *                 STRESS_OUT, dumps its exact generated payload.
 *
 * Verdicts: HELD (asserted invariant satisfied), RECORDED (outside the static
 * contract — behaviour documented, not asserted), KNOWN (reproducible defect
 * already reported; see KNOWN_ISSUES — a fix flips it to HELD), BROKEN
 * (unreported invariant violation — fails the suite).
 *
 * Invariants (what "HELD" means here):
 *   I1 createFusionProviders never throws for any shotType value; a valid
 *      slug or null yields kind 'real' with every required provider present;
 *      null additionally yields the hierarchical classifier.
 *   I2 selectVisionProviders never throws for a falsy recording or for any
 *      recording whose poseFrames is an array — however hostile the frame
 *      contents — and returns 'unavailable' exactly when < 6 frames.
 *   I3 Providers issued from a hostile-but-typed recording never REJECT:
 *      extractPose / detectStrokes / detectPaddle settle with a Result.
 *   I4 The hierarchical classifier never rejects for a typed-shape input with
 *      hostile numbers (NaN/±Infinity/-0/overflow) and always returns an ok
 *      Result carrying a well-formed prediction (abstention is fine).
 *   I5 registry.resolve/byId/shadowFor/list never throw for junk queries and
 *      never return an entry that does not satisfy the query.
 *   I6 Every user-facing `reason` string obeys APP_STORE_SUBMISSION.md copy
 *      rules (no Android/Google Play/guest mode/Live Court/DUPR/competitors,
 *      no accuracy %, no superlatives).
 *   I7 The app's real ingress (runCaptureAnalysis → parsePoseSequence →
 *      createFusionProviders → analyzeCapture) never throws for ANY byte
 *      string: malformed/truncated JSON, future schema versions, hostile
 *      numbers/strings, prototype-pollution keys all yield a typed
 *      `corrupted_media` failure or a validated finite sequence; a validated
 *      sequence run through the fusion engine always settles with a Result
 *      (provider crashes surface as `<task>.provider_crash`, never as a
 *      rejection) and never pollutes Object.prototype.
 * Structurally malformed inputs (poseFrames not an array, keypoints missing,
 * non-string slugs) are outside the TypeScript contract; their outcome is
 * RECORDED (throw vs unavailable vs real) rather than asserted, so the table
 * documents the actual failure mode without fabricating a contract.
 *
 * Campaigns: A createFusionProviders · B0/B1/B2 selectVisionProviders +
 * issued providers · C0 pinned minimal repro · C1/C2 hierarchical classifier
 * · D model registry · E scoringStackStatus · F wire JSON → parsePoseSequence
 * → analyzeCapture.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ShotTypeSlug } from '@pickle/shared-types';
import { SHOT_TYPES } from '@pickle/shared-types';
import type {
  ModelTask,
  PaddleTrack,
  PoseSequence,
} from '@pickle/swing-domain';
import {
  measured,
  parsePoseSequence,
  serializePoseSequence,
  unavailable,
} from '@pickle/swing-domain';
import type { RecordedStrokeInput } from '@pickle/vision-geometry';
import type { IHierarchicalStrokeClassifier } from '@pickle/analysis-pipeline';
import { analyzeCapture } from '@pickle/analysis-pipeline';
import { generateSwing, generateSwingSequence } from '@pickle/evaluation';
import {
  createFusionProviders,
  registry,
  scoringStackStatus,
  selectVisionProviders,
} from '../../src/vision/providers';

// ─── Seeded RNG ─────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(campaign: string, master: number, i: number): number {
  let h = 2166136261 ^ master;
  for (const ch of `${campaign}#${i}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h ^ (i * 2654435761)) >>> 0;
}

class Rng {
  private readonly next: () => number;
  public constructor(public readonly seed: number) {
    this.next = mulberry32(seed);
  }
  public float(): number {
    return this.next();
  }
  public int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  public pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }
  public chance(p: number): boolean {
    return this.next() < p;
  }
}

// ─── Junk generators ────────────────────────────────────────────────────────

const HOSTILE_NUMBERS: readonly number[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -0,
  0,
  1e308,
  -1e308,
  Number.MAX_VALUE,
  Number.MIN_VALUE,
  Number.EPSILON,
  2 ** 53,
  2 ** 53 + 2,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
  2 ** 31 - 1,
  -(2 ** 31),
  4294967296,
  5e-324,
  -1,
  1.0000000000000002,
];

function hostileNumber(rng: Rng): number {
  if (rng.chance(0.15)) return (rng.float() - 0.5) * 1e12;
  return rng.pick(HOSTILE_NUMBERS);
}

const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}'; // 1 grapheme, 7 code points, 25 bytes

const FIXED_STRINGS: readonly string[] = [
  '',
  ' ',
  '\0',
  'a\0b',
  'forehand_drive\0',
  'forehand_drive ',
  ' forehand_drive',
  'Forehand_Drive',
  'FOREHAND_DRIVE',
  'forehand-drive',
  'forehand drive',
  'forehand_drive/../../etc/passwd',
  '../../../etc/passwd',
  '..\\..\\windows\\system32',
  '%2e%2e%2f%2e%2e%2f',
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'hasOwnProperty',
  'valueOf',
  '{"a":',
  '[1,2',
  '{"__proto__":{"polluted":true}}',
  'null',
  'undefined',
  'NaN',
  'Infinity',
  'latest',
  'current',
  'head',
  '\u00e9', // NFC é
  'e\u0301', // NFD é
  '\uFEFFforehand_drive', // BOM prefix
  '\u202eevird_dnaherof', // RTL override
  'fore\u200Bhand_drive', // zero-width space
  '\uD800', // lone surrogate
  '\uDFFF',
  FAMILY,
  'ｆｏｒｅｈａｎｄ＿ｄｒｉｖｅ', // fullwidth
  'x'.repeat(64 * 1024 + 1),
  'x'.repeat(1_000_000),
  FAMILY.repeat(3000), // 3000 graphemes, 21000 code points, 75000 bytes
  '\u00e9'.repeat(70_000), // 70000 code points, 140000 bytes
  'e\u0301'.repeat(40_000), // 40000 graphemes, 80000 code points
  '\0'.repeat(70_000),
];

function hostileString(rng: Rng): string {
  if (rng.chance(0.2)) {
    const len = rng.pick([1, 7, 64, 255, 256, 4096, 65535, 65536, 70000]);
    const chunkLen = Math.min(len, 256);
    let chunk = '';
    for (let i = 0; i < chunkLen; i += 1) {
      const cp = rng.pick([
        rng.int(0x80),
        0x80 + rng.int(0x780),
        0x1f300 + rng.int(0x300),
        0xd800 + rng.int(0x800), // surrogates, possibly unpaired
        0,
      ]);
      chunk += String.fromCodePoint(cp);
    }
    return chunk.repeat(Math.ceil(len / chunkLen)).slice(0, len);
  }
  return rng.pick(FIXED_STRINGS);
}

/** Finite, parse-surviving extremes: pass parsePoseSequence's isFinite gate. */
const FINITE_HOSTILE: readonly number[] = [
  -0,
  0,
  1e308,
  -1e308,
  Number.MAX_VALUE,
  5e-324,
  Number.EPSILON,
  2 ** 53,
  Number.MAX_SAFE_INTEGER,
  -1,
  1e12,
  -1e12,
  1e-12,
  0.5,
  1.0000000000000002,
  4294967296,
];

function finiteHostile(rng: Rng): number {
  return rng.chance(0.2) ? (rng.float() - 0.5) * 1e6 : rng.pick(FINITE_HOSTILE);
}

function prototypePollutionObject(): Record<string, unknown> {
  return JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}}}',
  );
}

function hostileValue(rng: Rng, depth = 0): unknown {
  const roll = rng.int(depth > 2 ? 12 : 18);
  switch (roll) {
    case 0:
      return undefined;
    case 1:
      return null;
    case 2:
      return rng.chance(0.5);
    case 3:
      return hostileNumber(rng);
    case 4:
      return hostileString(rng);
    case 5:
      return [];
    case 6:
      return {};
    case 7:
      return Object.create(null);
    case 8:
      return prototypePollutionObject();
    case 9:
      return Symbol('junk');
    case 10:
      return BigInt('18446744073709551616');
    case 11:
      return () => hostileNumber(rng);
    case 12:
      return new Date(NaN);
    case 13:
      return Array.from({ length: rng.int(8) }, () =>
        hostileValue(rng, depth + 1),
      );
    case 14: {
      const out: Record<string, unknown> = {};
      const keys = rng.int(6);
      for (let k = 0; k < keys; k += 1) {
        out[hostileString(rng).slice(0, 32)] = hostileValue(rng, depth + 1);
      }
      return out;
    }
    case 15:
      return new Map([[hostileString(rng).slice(0, 8), hostileNumber(rng)]]);
    case 16:
      return Object.freeze({ frozen: true });
    default:
      return Number.NaN;
  }
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') {
    return `string(len=${value.length})${value.length <= 48 ? `:${JSON.stringify(value)}` : ''}`;
  }
  if (typeof value === 'number')
    return `number:${Object.is(value, -0) ? '-0' : String(value)}`;
  if (typeof value === 'bigint') return `bigint:${value.toString()}`;
  if (typeof value === 'symbol') return 'symbol';
  if (typeof value === 'function') return 'function';
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `array(len=${value.length})`;
  if (value instanceof Date) return 'Date(NaN)';
  if (value instanceof Map) return 'Map';
  const proto = Object.getPrototypeOf(value);
  return proto === null
    ? 'nullProtoObject'
    : `object(keys=${Object.keys(value as object).length})`;
}

// ─── Copy rules (APP_STORE_SUBMISSION.md) ───────────────────────────────────

const FORBIDDEN_COPY =
  /android|google play|guest mode|live court|dupr|swingvision|pb vision|selkirk|joola|\d+(\.\d+)?\s*%|\bbest\b|\bmost accurate\b|\bworld[- ]class\b|\bperfect\b|\bguarantee/i;

function copyViolation(reason: string): string | null {
  const match = FORBIDDEN_COPY.exec(reason);
  return match ? match[0] : null;
}

// ─── Result table ───────────────────────────────────────────────────────────

interface Row {
  campaign: string;
  seed: number;
  input: string;
  outcome: string;
  detail: string;
  /**
   * HELD — asserted invariant held. RECORDED — input outside the static
   * contract, behaviour documented not asserted. KNOWN — reproducible
   * defect already reported as a finding (see KNOWN_ISSUES); the suite
   * keeps counting it so a fix flips it to HELD, but it does not fail CI.
   * BROKEN — unreported invariant violation; fails the suite.
   */
  verdict: 'HELD' | 'RECORDED' | 'KNOWN' | 'BROKEN';
  ms: number;
}

const rows: Row[] = [];
const broken: Row[] = [];

/**
 * Reported findings (stress report for this unit). A row whose detail
 * matches is labelled KNOWN instead of BROKEN. Remove an entry once the
 * defect is fixed so the harness asserts the invariant again.
 */
const KNOWN_ISSUES: ReadonlyArray<{
  id: string;
  campaign: string;
  matches: (detail: string) => boolean;
}> = [
  {
    // NaN landmark/paddle coordinate → committed side with confidence NaN;
    // `NaN < AUTO_RESOLUTION_MIN_CONFIDENCE` is false so the floor admits it
    // (strokeHeuristicLite.ts clamp(); strokeAutoResolution.ts confidence floor).
    id: 'classifier-nan-confidence',
    campaign: 'C1',
    matches: detail => detail.startsWith('confidence=NaN'),
  },
  {
    // selectVisionProviders admits a >=6-element frames array whose elements
    // are not PoseFrames; the issued RecordedPoseProvider then rejects at
    // extractPose instead of the selection refusing up front.
    id: 'select-admits-non-frame-elements',
    campaign: 'B2',
    matches: detail =>
      detail.startsWith('real providers from malformed recording REJECT'),
  },
];

function knownIssueFor(campaign: string, detail: string): string | null {
  const hit = KNOWN_ISSUES.find(
    issue => issue.campaign === campaign && issue.matches(detail),
  );
  return hit ? hit.id : null;
}

function record(row: Omit<Row, 'ms'>, startedAt: number): void {
  const full: Row = {
    ...row,
    ms: Math.round((performance.now() - startedAt) * 10) / 10,
  };
  rows.push(full);
  if (full.verdict === 'BROKEN') broken.push(full);
}

const ITER = Math.max(1, Number(process.env.STRESS_ITER ?? 120) || 120);
const MASTER = Number(process.env.STRESS_SEED ?? 20260905) || 20260905;
const REPLAY = process.env.STRESS_REPLAY ?? null;

function seedsFor(campaign: string): number[] {
  if (REPLAY) {
    const [name, seed] = REPLAY.split(':');
    return name === campaign ? [Number(seed)] : [];
  }
  return Array.from({ length: ITER }, (_, i) => hashSeed(campaign, MASTER, i));
}

/**
 * With STRESS_REPLAY set, dump the exact generated payload of the replayed
 * iteration to $STRESS_OUT/replay-<campaign>-<seed>.json (non-finite numbers,
 * bigints, symbols and functions are stringified so nothing is lost).
 */
function dumpReplay(campaign: string, seed: number, payload: unknown): void {
  if (!REPLAY) return;
  const out = process.env.STRESS_OUT;
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const seen = new WeakSet<object>();
  const json = JSON.stringify(
    payload,
    (_key, value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value))
        return `<${String(value)}>`;
      if (typeof value === 'number' && Object.is(value, -0)) return '<-0>';
      if (
        typeof value === 'bigint' ||
        typeof value === 'symbol' ||
        typeof value === 'function'
      )
        return describeValue(value);
      if (typeof value === 'string' && value.length > 256)
        return `<string len=${value.length}: ${value.slice(0, 64)}…>`;
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '<cycle>';
        seen.add(value);
      }
      return value;
    },
    1,
  );
  writeFileSync(
    join(out, `replay-${campaign}-${seed}.json`),
    json ?? 'undefined',
  );
}

function errorText(error: unknown): string {
  if (error instanceof Error)
    return `${error.constructor.name}: ${error.message}`.slice(0, 200);
  return `thrown:${describeValue(error)}`;
}

const VALID_SLUGS: readonly ShotTypeSlug[] = SHOT_TYPES;
const REQUIRED_FUSION_KEYS = [
  'phase',
  'biomechanics',
  'scorer',
  'faultDetector',
  'uncertainty',
  'coach',
] as const;

// ─── Recording / sequence fixtures + mutators ───────────────────────────────

type MutableRecording = {
  poseFrames: unknown;
  poseModelVersion: unknown;
  trigger: unknown;
  video: unknown;
  [extra: string]: unknown;
};

function validRecording(): RecordedStrokeInput {
  const swing = generateSwing();
  return {
    poseFrames: swing.frames,
    poseModelVersion: 'apple-vision-bodypose-1',
    trigger: {
      modelVersion: 'temporal-stroke-heuristic-2',
      startMs: swing.window.startMs,
      endMs: swing.window.endMs,
      peakMotionMs: swing.window.peakMs,
      confidence: 0.86,
    },
    video: { width: swing.clip.width, height: swing.clip.height },
  };
}

/** Deep-clone via JSON so mutations never leak between iterations. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Typed-shape hostile recording: poseFrames stays an array of frame-shaped
 * objects, but every number/string inside may be hostile.
 */
function hostileTypedRecording(rng: Rng): {
  recording: RecordedStrokeInput;
  note: string;
} {
  const base = clone(validRecording()) as unknown as {
    poseFrames: Array<{
      timestampMs: number;
      space: string;
      confidence: number;
      landmarks: Array<{
        name: string;
        x: number;
        y: number;
        visibility: number;
      }>;
    }>;
    poseModelVersion: string;
    trigger: {
      modelVersion: string;
      startMs: number;
      endMs: number;
      peakMotionMs: number | null;
      confidence: number;
    };
    video: { width: number; height: number };
  };
  const notes: string[] = [];
  const mutations = 1 + rng.int(4);
  for (let m = 0; m < mutations; m += 1) {
    switch (rng.int(12)) {
      case 0: {
        const keep = rng.pick([0, 1, 5, 6, 7, base.poseFrames.length]);
        base.poseFrames = base.poseFrames.slice(0, keep);
        notes.push(`frames=${keep}`);
        break;
      }
      case 1: {
        for (const frame of base.poseFrames) {
          if (rng.chance(0.3)) frame.timestampMs = hostileNumber(rng);
        }
        notes.push('timestamps:hostile');
        break;
      }
      case 2: {
        for (const frame of base.poseFrames) {
          for (const mark of frame.landmarks) {
            if (rng.chance(0.2)) {
              mark.x = hostileNumber(rng);
              mark.y = hostileNumber(rng);
            }
          }
        }
        notes.push('landmarks:hostile-xy');
        break;
      }
      case 3: {
        for (const frame of base.poseFrames) {
          if (rng.chance(0.5)) frame.landmarks = [];
        }
        notes.push('landmarks:emptied');
        break;
      }
      case 4: {
        for (const frame of base.poseFrames) {
          frame.confidence = hostileNumber(rng);
          for (const mark of frame.landmarks)
            mark.visibility = hostileNumber(rng);
        }
        notes.push('confidence:hostile');
        break;
      }
      case 5: {
        base.video = { width: hostileNumber(rng), height: hostileNumber(rng) };
        notes.push(
          `video=${describeValue(base.video.width)}/${describeValue(base.video.height)}`,
        );
        break;
      }
      case 6: {
        base.trigger.startMs = hostileNumber(rng);
        base.trigger.endMs = hostileNumber(rng);
        notes.push('trigger:hostile-window');
        break;
      }
      case 7: {
        base.trigger.peakMotionMs = rng.chance(0.5) ? null : hostileNumber(rng);
        base.trigger.confidence = hostileNumber(rng);
        notes.push('trigger:hostile-peak/conf');
        break;
      }
      case 8: {
        base.poseModelVersion = hostileString(rng);
        base.trigger.modelVersion = hostileString(rng);
        notes.push('versions:hostile-strings');
        break;
      }
      case 9: {
        base.poseFrames.reverse();
        notes.push('frames:reversed');
        break;
      }
      case 10: {
        const dup = base.poseFrames[0];
        if (dup) base.poseFrames = base.poseFrames.map(() => clone(dup));
        notes.push('frames:all-duplicate-timestamps');
        break;
      }
      default: {
        for (const frame of base.poseFrames) {
          for (const mark of frame.landmarks) {
            if (rng.chance(0.3)) mark.name = hostileString(rng).slice(0, 64);
          }
        }
        Object.assign(
          base as unknown as Record<string, unknown>,
          prototypePollutionObject(),
        );
        notes.push('landmark-names:hostile + proto-pollution keys');
        break;
      }
    }
  }
  return {
    recording: base as unknown as RecordedStrokeInput,
    note: notes.join(','),
  };
}

/** Structurally malformed recording: the TypeScript contract is violated. */
function malformedRecording(rng: Rng): { recording: unknown; note: string } {
  const base = clone(validRecording()) as unknown as MutableRecording;
  switch (rng.int(8)) {
    case 0: {
      const junk = hostileValue(rng);
      base.poseFrames = junk;
      return { recording: base, note: `poseFrames=${describeValue(junk)}` };
    }
    case 1: {
      const frames = Array.from({ length: 6 + rng.int(10) }, () =>
        hostileValue(rng),
      );
      base.poseFrames = frames;
      return { recording: base, note: 'poseFrames=array-of-junk' };
    }
    case 2: {
      delete base.poseFrames;
      return { recording: base, note: 'poseFrames:deleted' };
    }
    case 3: {
      const junk = hostileValue(rng);
      base.video = junk;
      return { recording: base, note: `video=${describeValue(junk)}` };
    }
    case 4: {
      const junk = hostileValue(rng);
      base.trigger = junk;
      return { recording: base, note: `trigger=${describeValue(junk)}` };
    }
    case 5: {
      const junk = hostileValue(rng);
      return { recording: junk, note: `recording=${describeValue(junk)}` };
    }
    case 6: {
      base.poseFrames = 'x'.repeat(6 + rng.int(64));
      return { recording: base, note: 'poseFrames=string(len>=6)' };
    }
    default: {
      const obj = Object.create(null) as Record<string, unknown>;
      obj.poseFrames = (base.poseFrames as unknown[]).slice();
      obj.poseModelVersion = base.poseModelVersion;
      obj.trigger = base.trigger;
      obj.video = base.video;
      return { recording: obj, note: 'recording=nullProto' };
    }
  }
}

function hostileTypedSequence(rng: Rng): {
  sequence: PoseSequence;
  window: { startMs: number; endMs: number; peakMs: number };
  note: string;
} {
  const generated = generateSwingSequence();
  const sequence = clone(generated.sequence);
  const window = { ...generated.window };
  const notes: string[] = [];
  const mutations = 1 + rng.int(4);
  for (let m = 0; m < mutations; m += 1) {
    switch (rng.int(10)) {
      case 0:
        sequence.frames = sequence.frames.slice(0, rng.pick([0, 1, 2, 5, 6]));
        notes.push(`frames=${sequence.frames.length}`);
        break;
      case 1:
        for (const frame of sequence.frames) {
          if (rng.chance(0.3)) frame.timestampMs = hostileNumber(rng);
        }
        notes.push('timestamps:hostile');
        break;
      case 2:
        for (const frame of sequence.frames) {
          for (const mark of frame.landmarks) {
            if (rng.chance(0.25)) {
              mark.x = hostileNumber(rng);
              mark.y = hostileNumber(rng);
              mark.visibility = hostileNumber(rng);
            }
          }
        }
        notes.push('landmarks:hostile');
        break;
      case 3:
        for (const frame of sequence.frames) {
          if (rng.chance(0.5)) frame.landmarks = [];
        }
        notes.push('landmarks:emptied');
        break;
      case 4:
        for (const frame of sequence.frames) {
          frame.landmarks = frame.landmarks.filter(
            mark => !/shoulder|hip|wrist/.test(mark.name) || rng.chance(0.5),
          );
        }
        notes.push('torso/wrist:dropped');
        break;
      case 5:
        window.startMs = hostileNumber(rng);
        window.endMs = hostileNumber(rng);
        notes.push('window:hostile');
        break;
      case 6:
        window.peakMs = hostileNumber(rng);
        notes.push('peak:hostile');
        break;
      case 7:
        sequence.video = {
          width: hostileNumber(rng),
          height: hostileNumber(rng),
          fps: hostileNumber(rng),
        };
        notes.push('video:hostile');
        break;
      case 8:
        for (const frame of sequence.frames) {
          for (const mark of frame.landmarks) {
            if (rng.chance(0.2)) mark.name = hostileString(rng).slice(0, 64);
          }
        }
        notes.push('landmark-names:hostile');
        break;
      default: {
        const template = sequence.frames[0];
        if (template) {
          sequence.frames = sequence.frames.concat(
            Array.from({ length: 300 }, (_, i) => ({
              ...clone(template),
              frameIndex: 10_000 + i,
              timestampMs: 10_000 + i * 8,
            })),
          );
        }
        notes.push('frames:+300-padding');
        break;
      }
    }
  }
  return { sequence, window, note: notes.join(',') };
}

function hostilePaddleTrack(
  rng: Rng,
  typed: boolean,
): { paddle: PaddleTrack | null; note: string } {
  if (rng.chance(0.25)) return { paddle: null, note: 'paddle=null' };
  const count = rng.pick([0, 1, 3, 12, 60]);
  const observations = Array.from({ length: count }, (_, i) => {
    const center = rng.chance(0.4)
      ? null
      : {
          x: rng.chance(0.5) ? rng.float() : hostileNumber(rng),
          y: rng.chance(0.5) ? rng.float() : hostileNumber(rng),
        };
    return {
      frameIndex: i,
      timestampMs: rng.chance(0.7) ? i * 33 : hostileNumber(rng),
      bbox: null,
      keypoints: { handleEnd: null, throat: null, center, tip: null },
      confidence: rng.chance(0.5) ? rng.float() : hostileNumber(rng),
    };
  });
  const track: PaddleTrack = {
    schemaVersion: 1,
    coordinateSystem: 'normalized_image_top_left',
    producedBy: {
      providerId: 'paddle.test',
      modelVersion: 'stress-0',
      runtime: 'deterministic',
      executionTarget: 'on_device',
      artifactHash: null,
    },
    observations,
    continuity: rng.chance(0.5) ? rng.float() : hostileNumber(rng),
  };
  if (typed)
    return {
      paddle: track,
      note: `paddle=typed(n=${count},centers-null-mixed)`,
    };
  const mutable = track as unknown as { observations: unknown };
  switch (rng.int(4)) {
    case 0: {
      mutable.observations = observations.map(o => ({
        ...o,
        keypoints: hostileValue(rng),
      }));
      return { paddle: track, note: 'paddle.keypoints=junk' };
    }
    case 1: {
      mutable.observations = hostileValue(rng);
      return {
        paddle: track,
        note: `paddle.observations=${describeValue(mutable.observations)}`,
      };
    }
    case 2: {
      mutable.observations = observations.map(o => ({
        ...o,
        keypoints: { center: hostileValue(rng) },
      }));
      return { paddle: track, note: 'paddle.center=junk' };
    }
    default:
      return { paddle: hostileValue(rng) as PaddleTrack, note: 'paddle=junk' };
  }
}

/**
 * Wire JSON for parsePoseSequence: starts from a valid serialized sequence
 * and applies byte-level (truncation, garbage bytes, raw literal splices) or
 * structural (future schema, junk fields, hostile numbers/strings, proto
 * keys) mutations. ~10% of seeds pass the JSON through untouched so the
 * happy path stays in the table.
 */
function hostileWireJson(rng: Rng): { json: string; note: string } {
  const valid = serializePoseSequence(generateSwingSequence().sequence);
  const roll = rng.int(20);
  if (roll < 2) return { json: valid, note: 'wire=valid' };
  if (roll < 4) {
    const cut = rng.int(valid.length);
    return { json: valid.slice(0, cut), note: `wire=truncated@${cut}` };
  }
  if (roll < 5) {
    const at = rng.int(valid.length);
    const junk = rng.pick([
      '\0',
      '\uFEFF',
      '}',
      ']',
      ',',
      '"',
      '\\',
      'NaN',
      '\u2028',
      '\uD800',
      '/*',
      '\n\n',
      '\x7f',
    ]);
    return {
      json: valid.slice(0, at) + junk + valid.slice(at),
      note: `wire=splice(${JSON.stringify(junk)})@${at}`,
    };
  }
  if (roll < 6) {
    const literal = rng.pick([
      '',
      ' ',
      'null',
      'true',
      '0',
      '-0',
      '1e999',
      '[]',
      '{}',
      '""',
      '"x"'.repeat(1),
      '{"__proto__":{"polluted":true}}',
      '{"constructor":{"prototype":{"x":1}}}',
      '[' + '['.repeat(5000),
      '{"schemaVersion":1}',
      '{"schemaVersion":"1","format":"pickle.pose-sequence.v1"}',
      'x'.repeat(64 * 1024 + 1),
      '\uFEFF' + valid,
      valid + valid,
      valid + '\0',
    ]);
    return { json: literal, note: `wire=literal(len=${literal.length})` };
  }
  if (roll < 10) return finiteHostileWireJson(rng, valid);
  // Structural mutations on the parsed wire object.
  const wire = JSON.parse(valid) as {
    schemaVersion: unknown;
    format: unknown;
    coordinateSystem: unknown;
    poseModelVersion: unknown;
    video: { w: unknown; h: unknown; fps: unknown } | unknown;
    frames: unknown;
    [k: string]: unknown;
  };
  const frames = wire.frames as Array<{
    i: unknown;
    t: unknown;
    c: unknown;
    l: unknown;
  }>;
  const notes: string[] = [];
  let pollute = false;
  const mutations = 1 + rng.int(3);
  for (let m = 0; m < mutations; m += 1) {
    switch (rng.int(14)) {
      case 0:
        wire.schemaVersion = rng.pick<unknown>([
          2,
          99,
          1.5,
          '1',
          -1,
          0,
          null,
          1e308,
          true,
          [1],
        ]);
        notes.push(`schemaVersion=${describeValue(wire.schemaVersion)}`);
        break;
      case 1:
        wire.format = rng.pick<unknown>([
          'pickle.pose-sequence.v2',
          'PICKLE.POSE-SEQUENCE.V1',
          '',
          null,
          1,
          'pickle.pose-sequence.v1\0',
        ]);
        notes.push(`format=${describeValue(wire.format)}`);
        break;
      case 2:
        wire.coordinateSystem = rng.chance(0.5)
          ? hostileString(rng).slice(0, 64)
          : hostileValue(rng);
        notes.push(`coordinateSystem=${describeValue(wire.coordinateSystem)}`);
        break;
      case 3:
        wire.poseModelVersion = rng.chance(0.7)
          ? hostileString(rng)
          : hostileValue(rng);
        notes.push(`poseModelVersion=${describeValue(wire.poseModelVersion)}`);
        break;
      case 4:
        wire.video = rng.chance(0.5)
          ? {
              w: hostileNumber(rng),
              h: hostileNumber(rng),
              fps: hostileNumber(rng),
            }
          : hostileValue(rng);
        notes.push('video:hostile');
        break;
      case 5:
        wire.frames = rng.pick<unknown>([
          [],
          {},
          null,
          'frames',
          0,
          [null],
          [{}],
          [[]],
          Array.from({ length: 6 }, () => hostileValue(rng)),
        ]);
        notes.push(`frames=${describeValue(wire.frames)}`);
        break;
      case 6:
        for (const frame of frames) {
          if (rng.chance(0.3)) frame.t = hostileNumber(rng);
          if (rng.chance(0.2))
            frame.i = rng.pick<unknown>([
              1.5,
              -1,
              '3',
              null,
              1e308,
              hostileNumber(rng),
            ]);
          if (rng.chance(0.2)) frame.c = hostileNumber(rng);
        }
        notes.push('frames.t/i/c:hostile');
        break;
      case 7:
        for (const frame of frames) {
          const marks = frame.l as Array<{
            n: unknown;
            x: unknown;
            y: unknown;
            v: unknown;
            z?: unknown;
          }>;
          if (!Array.isArray(marks)) continue;
          for (const mark of marks) {
            if (typeof mark !== 'object' || mark === null) continue;
            if (rng.chance(0.15)) mark.x = hostileNumber(rng);
            if (rng.chance(0.15)) mark.y = hostileNumber(rng);
            if (rng.chance(0.1)) mark.v = hostileNumber(rng);
            if (rng.chance(0.1))
              mark.z = rng.chance(0.5) ? hostileNumber(rng) : hostileValue(rng);
          }
        }
        notes.push('landmarks:hostile-xyvz');
        break;
      case 8:
        for (const frame of frames) {
          const marks = frame.l as Array<{ n: unknown }>;
          if (!Array.isArray(marks)) continue;
          for (const mark of marks) {
            if (rng.chance(0.2))
              mark.n = rng.chance(0.8) ? hostileString(rng) : hostileValue(rng);
          }
        }
        notes.push('landmark-names:hostile');
        break;
      case 9:
        for (const frame of frames) {
          if (rng.chance(0.4))
            frame.l = rng.pick<unknown>([[], null, {}, 'l', [null], [{}]]);
        }
        notes.push('frame.l:emptied/junk');
        break;
      case 10:
        frames.reverse();
        notes.push('frames:reversed');
        break;
      case 11: {
        const first = frames[0];
        if (first) wire.frames = frames.map(() => ({ ...first }));
        notes.push('frames:duplicate-timestamps');
        break;
      }
      case 12:
        pollute = true;
        notes.push('proto-pollution keys');
        break;
      default: {
        const keep = rng.pick([0, 1, 2, 5, 6, frames.length]);
        wire.frames = frames.slice(0, keep);
        notes.push(`frames=${keep}`);
        break;
      }
    }
  }
  let json: string;
  try {
    json = JSON.stringify(wire);
  } catch {
    json = '{"schemaVersion":1,"format":"pickle.pose-sequence.v1"';
    notes.push('unstringifiable->truncated');
  }
  if (pollute) {
    // Spliced into the raw text: JSON.parse creates OWN "__proto__" keys on
    // the root and on every frame/landmark object.
    json = json.replace(
      /\{/g,
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}},',
    );
  }
  if (rng.chance(0.2)) {
    // Raw-literal splices JSON.stringify cannot produce: 1e999 → Infinity, -0, huge ints.
    json = json.replace(
      /"t":([0-9.]+)/,
      () =>
        `"t":${rng.pick(['1e999', '-0', '-1e999', '99999999999999999999999', '0.1e-999'])}`,
    );
    notes.push('raw-literal t');
  }
  return { json, note: notes.join(',') };
}

/**
 * Mutations that keep the wire VALID for parsePoseSequence (finite numbers,
 * strictly increasing t, non-empty landmark lists) so the sequence reaches
 * createFusionProviders + analyzeCapture with extreme-but-legal content.
 */
function finiteHostileWireJson(
  rng: Rng,
  valid: string,
): { json: string; note: string } {
  const wire = JSON.parse(valid) as {
    poseModelVersion: string;
    video: { w: number; h: number; fps: number };
    frames: Array<{
      i: number;
      t: number;
      c: number;
      l: Array<{ n: string; x: number; y: number; v: number; z?: number }>;
    }>;
  };
  const notes: string[] = [];
  const mutations = 1 + rng.int(3);
  for (let m = 0; m < mutations; m += 1) {
    switch (rng.int(11)) {
      case 0:
        for (const frame of wire.frames) {
          for (const mark of frame.l) {
            if (rng.chance(0.3)) {
              mark.x = finiteHostile(rng);
              mark.y = finiteHostile(rng);
            }
          }
        }
        notes.push('xy:finite-extreme');
        break;
      case 1:
        for (const frame of wire.frames) {
          frame.c = finiteHostile(rng);
          for (const mark of frame.l) mark.v = finiteHostile(rng);
        }
        notes.push('confidence/visibility:finite-extreme');
        break;
      case 2:
        wire.video = {
          w: rng.pick([1, 1e-12, 1e308, 4294967296, 1080]),
          h: rng.pick([1, 1e-12, 1e308, 4294967296, 1920]),
          fps: rng.pick([1e-12, 1, 240, 1e308]),
        };
        notes.push(`video=${wire.video.w}x${wire.video.h}@${wire.video.fps}`);
        break;
      case 3: {
        // Strictly increasing but pathological spacing / offsets.
        const start = rng.pick([-1e12, -1, 0, 1e12, 2 ** 53 - 1000]);
        const step = rng.pick([5e-324, 1e-9, 1, 33, 1e6]);
        wire.frames.forEach((frame, index) => {
          frame.t = start + index * step;
        });
        notes.push(`t=${start}+i*${step}`);
        break;
      }
      case 4:
        wire.frames.forEach((frame, index) => {
          frame.i = rng.pick([0, -1, 2 ** 53, 1e308, index * 1000]);
        });
        notes.push('i:extreme-integers');
        break;
      case 5:
        for (const frame of wire.frames) {
          for (const mark of frame.l) {
            if (rng.chance(0.3))
              mark.n = rng.pick([
                FAMILY,
                '\u00e9',
                'e\u0301',
                'left_wrist\0',
                'LEFT_WRIST',
                'x'.repeat(64 * 1024 + 1),
                '../left_wrist',
                '__proto__',
              ]);
          }
        }
        notes.push('landmark-names:legal-hostile');
        break;
      case 6:
        for (const frame of wire.frames) {
          frame.l = frame.l.concat(
            frame.l.map(mark => ({ ...mark, x: 1 - mark.x })),
          );
        }
        notes.push('landmarks:duplicated-names');
        break;
      case 7:
        wire.poseModelVersion = rng.pick([
          'x'.repeat(1_000_000),
          FAMILY.repeat(3000),
          '\0',
          'latest',
          ' ',
          '../../etc/passwd',
          '\uD800',
        ]);
        notes.push(`poseModelVersion=len${wire.poseModelVersion.length}`);
        break;
      case 8:
        wire.frames = wire.frames.slice(0, rng.pick([1, 2, 5, 6, 7]));
        notes.push(`frames=${wire.frames.length}`);
        break;
      case 9:
        for (const frame of wire.frames) {
          frame.l = frame.l.slice(0, rng.pick([1, 2, 3]));
        }
        notes.push('landmarks:1-3 per frame');
        break;
      default:
        for (const frame of wire.frames) {
          for (const mark of frame.l) mark.z = finiteHostile(rng);
        }
        notes.push('z:finite-extreme');
        break;
    }
  }
  return { json: JSON.stringify(wire), note: `finite:${notes.join(',')}` };
}

function isWellFormedPrediction(value: unknown): string | null {
  if (typeof value !== 'object' || value === null)
    return 'prediction not an object';
  const p = value as Record<string, unknown>;
  if (typeof p.taxonomyVersion !== 'string')
    return 'taxonomyVersion not string';
  if (typeof p.classifierVersion !== 'string')
    return 'classifierVersion not string';
  if (typeof p.label !== 'string' || p.label.length === 0) return 'label empty';
  if (!(p.leaf === null || typeof p.leaf === 'string'))
    return 'leaf not string|null';
  if (![1, 2, 3].includes(p.taxonomyDepth as number))
    return `taxonomyDepth=${String(p.taxonomyDepth)}`;
  if (typeof p.confidence !== 'number' || !Number.isFinite(p.confidence))
    return `confidence=${String(p.confidence)}`;
  if (p.confidence < 0 || p.confidence > 1)
    return `confidence out of [0,1]: ${p.confidence}`;
  if (!Array.isArray(p.evidence)) return 'evidence not array';
  if (!Array.isArray(p.limitingFactors)) return 'limitingFactors not array';
  return null;
}

const CLIP = {
  uri: 'stress://clip',
  durationMs: 4000,
  fps: 30,
  width: 1080,
  height: 1080,
};

// ─── Campaigns ──────────────────────────────────────────────────────────────

describe('STRESS mod-vision-providers × boundary-malformed', () => {
  afterAll(() => {
    const out = process.env.STRESS_OUT;
    if (!out) return;
    mkdirSync(out, { recursive: true });
    const summary: Record<string, Record<string, number>> = {};
    for (const row of rows) {
      const bucket = (summary[row.campaign] ??= {});
      bucket[row.verdict] = (bucket[row.verdict] ?? 0) + 1;
      const key = `${row.verdict}:${row.outcome}`;
      bucket[key] = (bucket[key] ?? 0) + 1;
    }
    writeFileSync(
      join(out, 'vision-providers-boundary-malformed.json'),
      JSON.stringify(
        {
          unit: 'apps/mobile/src/vision/providers.ts',
          lens: 'boundary-malformed',
          masterSeed: MASTER,
          iterationsPerCampaign: ITER,
          scenariosExecuted: rows.length,
          broken: broken.length,
          known: rows.filter(row => row.verdict === 'KNOWN').length,
          knownIssues: KNOWN_ISSUES.map(issue => issue.id),
          summary,
          rows,
        },
        null,
        1,
      ),
    );
  });

  it('A: createFusionProviders never throws; valid slugs and null are real; junk is recorded (I1, I6)', () => {
    for (const seed of seedsFor('A')) {
      const rng = new Rng(seed);
      const t0 = performance.now();
      const roll = rng.int(10);
      const input: unknown =
        roll < 3
          ? rng.pick(VALID_SLUGS)
          : roll < 4
            ? null
            : roll < 5
              ? undefined
              : roll < 8
                ? hostileString(rng)
                : hostileValue(rng);
      const typedValid =
        input === null ||
        (typeof input === 'string' &&
          VALID_SLUGS.includes(input as ShotTypeSlug));
      let outcome = '';
      let detail = '';
      let verdict: Row['verdict'] = typedValid ? 'HELD' : 'RECORDED';
      try {
        const result = createFusionProviders(input as ShotTypeSlug | null);
        outcome = `kind=${result.kind}`;
        if (result.kind !== 'real' && result.kind !== 'unavailable') {
          verdict = 'BROKEN';
          detail = 'kind outside the union';
        } else if (result.kind === 'unavailable') {
          const violation = copyViolation(result.reason);
          if (violation) {
            verdict = 'BROKEN';
            detail = `copy violation: ${violation}`;
          } else if (typedValid) {
            verdict = 'BROKEN';
            detail = `valid input refused: ${result.reason}`;
          }
        } else {
          const missing = REQUIRED_FUSION_KEYS.filter(
            key =>
              typeof result.providers[key] !== 'object' ||
              result.providers[key] === null,
          );
          if (missing.length > 0) {
            verdict = 'BROKEN';
            detail = `missing providers: ${missing.join(',')}`;
          } else if (result.providers.classifier !== null) {
            verdict = 'BROKEN';
            detail =
              'flat classifier must be null (no validated flat classifier exists)';
          } else if (input === null) {
            const auto = result.providers.autoStrokeClassifier;
            if (
              !auto ||
              auto.descriptor.providerId !== 'stroke.heuristic-hierarchical'
            ) {
              verdict = 'BROKEN';
              detail =
                'null (AUTO DETECT) issued without the hierarchical classifier';
            } else {
              detail = `auto=${auto.descriptor.providerId}@${auto.descriptor.modelVersion}`;
            }
          } else if (!Array.isArray(result.providers.shadowScorers)) {
            verdict = 'BROKEN';
            detail = 'shadowScorers not an array';
          }
        }
      } catch (error) {
        outcome = 'throw';
        detail = errorText(error);
        verdict = 'BROKEN';
      }
      record(
        {
          campaign: 'A',
          seed,
          input: describeValue(input),
          outcome,
          detail,
          verdict,
        },
        t0,
      );
    }
  });

  it('B0: selectVisionProviders refuses every falsy recording without throwing (I2, I6)', () => {
    const falsy: readonly unknown[] = [
      undefined,
      null,
      false,
      0,
      -0,
      Number.NaN,
      '',
      BigInt(0),
    ];
    for (const seed of seedsFor('B0')) {
      const rng = new Rng(seed);
      const t0 = performance.now();
      const recording = rng.pick(falsy);
      const shotType = rng.chance(0.5)
        ? rng.pick(VALID_SLUGS)
        : hostileValue(rng);
      let outcome = '';
      let detail = '';
      let verdict: Row['verdict'] = 'HELD';
      try {
        const result = selectVisionProviders(
          shotType as ShotTypeSlug,
          recording as RecordedStrokeInput | null | undefined,
        );
        outcome = `kind=${result.kind}`;
        if (result.kind !== 'unavailable') {
          verdict = 'BROKEN';
          detail = 'falsy recording produced providers';
        } else if (!result.reason.includes('recorded pose sequence')) {
          verdict = 'BROKEN';
          detail = `unexpected reason: ${result.reason}`;
        } else if (copyViolation(result.reason)) {
          verdict = 'BROKEN';
          detail = `copy violation: ${copyViolation(result.reason)}`;
        }
      } catch (error) {
        outcome = 'throw';
        detail = errorText(error);
        verdict = 'BROKEN';
      }
      record(
        {
          campaign: 'B0',
          seed,
          input: `recording=${describeValue(recording)} shotType=${describeValue(shotType)}`,
          outcome,
          detail,
          verdict,
        },
        t0,
      );
    }
  });

  it('B1: typed recordings with hostile numbers/strings never throw; issued providers never reject (I2, I3, I6)', async () => {
    for (const seed of seedsFor('B1')) {
      const rng = new Rng(seed);
      const t0 = performance.now();
      const { recording, note } = hostileTypedRecording(rng);
      const shotType = rng.pick(VALID_SLUGS);
      dumpReplay('B1', seed, { shotType, recording });
      let outcome = '';
      let detail = '';
      let verdict: Row['verdict'] = 'HELD';
      try {
        const result = selectVisionProviders(shotType, recording);
        outcome = `kind=${result.kind}`;
        const expectUnavailable = recording.poseFrames.length < 6;
        if (result.kind === 'unavailable') {
          if (!expectUnavailable) {
            verdict = 'BROKEN';
            detail = `>=6 frames refused: ${result.reason}`;
          } else if (copyViolation(result.reason)) {
            verdict = 'BROKEN';
            detail = `copy violation: ${copyViolation(result.reason)}`;
          }
        } else if (expectUnavailable) {
          verdict = 'BROKEN';
          detail = `<6 frames (${recording.poseFrames.length}) issued providers`;
        } else {
          const providers = result.providers;
          const window = rng.chance(0.5)
            ? {
                startMs: recording.trigger.startMs,
                endMs: recording.trigger.endMs,
              }
            : { startMs: hostileNumber(rng), endMs: hostileNumber(rng) };
          const settled = await Promise.allSettled([
            providers.pose.extractPose(CLIP, window),
            providers.stroke.detectStrokes(CLIP),
            providers.paddle.detectPaddle(CLIP, window),
          ]);
          const rejected = settled
            .map((s, i) =>
              s.status === 'rejected'
                ? `${['pose', 'stroke', 'paddle'][i]}:${errorText(s.reason)}`
                : null,
            )
            .filter((s): s is string => s !== null);
          const malformedResult = settled
            .map((s, i) =>
              s.status === 'fulfilled' &&
              (typeof s.value !== 'object' ||
                s.value === null ||
                typeof s.value.ok !== 'boolean')
                ? ['pose', 'stroke', 'paddle'][i]
                : null,
            )
            .filter((s): s is string => s !== null);
          if (rejected.length > 0) {
            verdict = 'BROKEN';
            detail = `provider rejected: ${rejected.join(' | ')}`;
          } else if (malformedResult.length > 0) {
            verdict = 'BROKEN';
            detail = `non-Result value from: ${malformedResult.join(',')}`;
          } else {
            detail = settled
              .map((s, i) =>
                s.status === 'fulfilled'
                  ? `${['pose', 'stroke', 'paddle'][i]}=${s.value.ok ? 'ok' : s.value.failure.code}`
                  : '',
              )
              .join(' ');
            if (
              providers.source !== 'real' ||
              !providers.phase ||
              !providers.features
            ) {
              verdict = 'BROKEN';
              detail += ' | provider set incomplete';
            }
          }
        }
      } catch (error) {
        outcome = 'throw';
        detail = errorText(error);
        verdict = 'BROKEN';
      }
      record(
        {
          campaign: 'B1',
          seed,
          input: `${shotType} ${note}`,
          outcome,
          detail,
          verdict,
        },
        t0,
      );
    }
  });

  it('B2: structurally malformed recordings — outcome recorded (throw vs unavailable vs real), providers still never reject', async () => {
    for (const seed of seedsFor('B2')) {
      const rng = new Rng(seed);
      const t0 = performance.now();
      const { recording, note } = malformedRecording(rng);
      const shotType = rng.chance(0.7)
        ? rng.pick(VALID_SLUGS)
        : hostileValue(rng);
      dumpReplay('B2', seed, { shotType, recording });
      let outcome = '';
      let detail = '';
      let verdict: Row['verdict'] = 'RECORDED';
      try {
        const result = selectVisionProviders(
          shotType as ShotTypeSlug,
          recording as RecordedStrokeInput,
        );
        outcome = `kind=${result.kind}`;
        if (result.kind === 'unavailable') {
          if (copyViolation(result.reason)) {
            verdict = 'BROKEN';
            detail = `copy violation: ${copyViolation(result.reason)}`;
          }
        } else {
          const settled = await Promise.allSettled([
            result.providers.pose.extractPose(CLIP, {
              startMs: 0,
              endMs: 10_000,
            }),
            result.providers.stroke.detectStrokes(CLIP),
          ]);
          const rejected = settled.filter(s => s.status === 'rejected');
          if (rejected.length > 0) {
            outcome = 'kind=real->reject';
            detail = `real providers from malformed recording REJECT: ${rejected
              .map(s => (s.status === 'rejected' ? errorText(s.reason) : ''))
              .join(' | ')}`;
            const known = knownIssueFor('B2', detail);
            verdict = known ? 'KNOWN' : 'BROKEN';
            if (known) detail = `${detail} [known:${known}]`;
          } else {
            detail = `real-from-malformed; ${settled
              .map((s, i) =>
                s.status === 'fulfilled'
                  ? `${['pose', 'stroke'][i]}=${s.value.ok ? `ok(${Array.isArray(s.value.value) ? s.value.value.length : '?'})` : s.value.failure.code}`
                  : '',
              )
              .join(' ')}`;
          }
        }
      } catch (error) {
        outcome = 'throw';
        detail = errorText(error);
      }
      record(
        {
          campaign: 'B2',
          seed,
          input: `${describeValue(shotType)} ${note}`,
          outcome,
          detail,
          verdict,
        },
        t0,
      );
    }
  });

  it('C0: pinned minimal repro — one non-finite shoulder x at the reference frame (known: classifier-nan-confidence)', async () => {
    const fusion = createFusionProviders(null);
    expect(fusion.kind).toBe('real');
    if (fusion.kind !== 'real') return;
    const classifier = fusion.providers
      .autoStrokeClassifier as IHierarchicalStrokeClassifier;
    const { sequence, window } = generateSwingSequence();
    const variants: ReadonlyArray<{ landmark: string; x: number }> = [
      { landmark: 'left_shoulder', x: Number.NaN },
      { landmark: 'left_shoulder', x: Number.NEGATIVE_INFINITY },
      { landmark: 'right_shoulder', x: Number.POSITIVE_INFINITY },
    ];
    for (const [index, variant] of variants.entries()) {
      const t0 = performance.now();
      const seq = clone(sequence);
      let nearest = seq.frames[0]!;
      for (const frame of seq.frames) {
        if (
          Math.abs(frame.timestampMs - window.peakMs) <
          Math.abs(nearest.timestampMs - window.peakMs)
        )
          nearest = frame;
      }
      for (const mark of nearest.landmarks) {
        if (mark.name === variant.landmark)
          (mark as { x: number }).x = variant.x;
      }
      const result = await classifier.classify({
        pose: seq,
        paddle: null,
        ball: null,
        window: { startMs: window.startMs, endMs: window.endMs },
        contactMs: window.peakMs,
        eventPeakMs: window.peakMs,
        handedness: 'right',
      });
      let outcome = '';
      let detail = '';
      let verdict: Row['verdict'] = 'HELD';
      if (!result.ok) {
        outcome = `fail:${result.failure.code}`;
        verdict = 'BROKEN';
      } else {
        outcome = `ok:${result.value.label}`;
        const problem = isWellFormedPrediction(result.value);
        if (problem) {
          const known = knownIssueFor('C1', problem);
          verdict = known ? 'KNOWN' : 'BROKEN';
          detail = known ? `${problem} [known:${known}]` : problem;
        } else {
          detail = `conf=${result.value.confidence}`;
        }
      }
      record(
        {
          campaign: 'C0',
          seed: index,
          input: `${variant.landmark}.x=${String(variant.x)} @ frame t=${nearest.timestampMs}; contactMs=eventPeakMs=${window.peakMs}`,
          outcome,
          detail,
          verdict,
        },
        t0,
      );
    }
  });

  it('C1: hierarchical classifier with typed-shape hostile inputs always resolves ok with a well-formed prediction (I4)', async () => {
    const fusion = createFusionProviders(null);
    expect(fusion.kind).toBe('real');
    if (fusion.kind !== 'real') return;
    const classifier = fusion.providers
      .autoStrokeClassifier as IHierarchicalStrokeClassifier;
    expect(classifier).toBeTruthy();
    for (const seed of seedsFor('C1')) {
      const rng = new Rng(seed);
      const t0 = performance.now();
      const { sequence, window, note } = hostileTypedSequence(rng);
      const { paddle, note: paddleNote } = hostilePaddleTrack(rng, true);
      const contactMs = rng.chance(0.5) ? null : hostileNumber(rng);
      const eventPeakMs = rng.chance(0.3)
        ? null
        : rng.chance(0.5)
          ? window.peakMs
          : hostileNumber(rng);
      const handedness = rng.pick(['right', 'left'] as const);
      let outcome = '';
      let detail = '';
      let verdict: Row['verdict'] = 'HELD';
      const classifyInput = {
        pose: sequence,
        paddle,
        ball: null,
        window: { startMs: window.startMs, endMs: window.endMs },
        contactMs,
        eventPeakMs,
        handedness,
      };
      dumpReplay('C1', seed, classifyInput);
      try {
        const result = await classifier.classify(classifyInput);
        if (!result.ok) {
          outcome = `fail:${result.failure.code}`;
          verdict = 'BROKEN';
          detail =
            'classifier returned a typed failure — contract is ok(prediction) with abstention as UNKNOWN';
        } else {
          const problem = isWellFormedPrediction(result.value);
          outcome = `ok:${result.value.label}`;
          if (problem) {
            const known = knownIssueFor('C1', problem);
            verdict = known ? 'KNOWN' : 'BROKEN';
            detail = known ? `${problem} [known:${known}]` : problem;
          } else {
            detail = `depth=${result.value.taxonomyDepth} conf=${result.value.confidence} limiting=${result.value.limitingFactors.slice(0, 2).join('/')}`;
          }
        }
      } catch (error) {
        outcome = 'reject';
        detail = errorText(error);
        verdict = 'BROKEN';
      }
      record(
        {
          campaign: 'C1',
          seed,
          input: `${note} ${paddleNote} contact=${describeValue(contactMs)} peak=${describeValue(eventPeakMs)} ${handedness}`,
          outcome,
          detail,
          verdict,
        },
        t0,
      );
    }
  });

  it('C2: hierarchical classifier with structurally malformed paddle/pose — outcome recorded (reject vs ok)', async () => {
    const fusion = createFusionProviders(null);
    if (fusion.kind !== 'real') return;
    const classifier = fusion.providers
      .autoStrokeClassifier as IHierarchicalStrokeClassifier;
    for (const seed of seedsFor('C2')) {
      const rng = new Rng(seed);
      const t0 = performance.now();
      const { sequence, window, note } = hostileTypedSequence(rng);
      const { paddle, note: paddleNote } = hostilePaddleTrack(rng, false);
      const pose: unknown = rng.chance(0.3)
        ? { ...sequence, frames: hostileValue(rng) }
        : rng.chance(0.2)
          ? hostileValue(rng)
          : sequence;
      const poseNote =
        pose === sequence
          ? 'pose=typed'
          : `pose=${describeValue((pose as { frames?: unknown })?.frames ?? pose)}`;
      let outcome = '';
      let detail = '';
      let verdict: Row['verdict'] = 'RECORDED';
      const classifyInput = {
        pose: pose as PoseSequence,
        paddle,
        ball: null,
        window: { startMs: window.startMs, endMs: window.endMs },
        contactMs: null,
        eventPeakMs: window.peakMs,
        handedness: hostileValue(rng) as 'right',
      };
      dumpReplay('C2', seed, classifyInput);
      try {
        const result = await classifier.classify(classifyInput);
        if (result.ok) {
          const problem = isWellFormedPrediction(result.value);
          outcome = `ok:${result.value.label}`;
          if (problem) {
            verdict = 'BROKEN';
            detail = `ok Result with malformed prediction: ${problem}`;
          }
        } else {
          outcome = `fail:${result.failure.code}`;
        }
      } catch (error) {
        // A synchronous throw inside an async method becomes a rejection; the
        // fusion engine's run() wrapper maps it to <task>.provider_crash.
        outcome = 'reject';
        detail = errorText(error);
      }
      record(
        {
          campaign: 'C2',
          seed,
          input: `${note} ${paddleNote} ${poseNote}`,
          outcome,
          detail,
          verdict,
        },
        t0,
      );
    }
  });

  it('D: registry.resolve/byId/shadowFor/list never throw on junk queries and never return a non-matching entry (I5)', () => {
    const tasks = registry.list().map(entry => entry.task);
    const platforms = ['ios', 'android', 'server'] as const;
    const statuses = [
      'experimental',
      'shadow',
      'candidate',
      'production',
      'deprecated',
    ] as const;
    for (const seed of seedsFor('D')) {
      const rng = new Rng(seed);
      const t0 = performance.now();
      const query = {
        task: (rng.chance(0.6)
          ? rng.pick(tasks)
          : hostileValue(rng)) as ModelTask,
        platform: (rng.chance(0.6)
          ? rng.pick(platforms)
          : hostileValue(rng)) as 'ios',
        ...(rng.chance(0.5)
          ? {
              stroke: (rng.chance(0.5)
                ? rng.pick(VALID_SLUGS)
                : hostileValue(rng)) as ShotTypeSlug,
            }
          : {}),
        ...(rng.chance(0.4)
          ? {
              status: (rng.chance(0.5)
                ? rng.pick(statuses)
                : hostileValue(rng)) as 'production',
            }
          : {}),
      };
      let outcome = '';
      let detail = '';
      let verdict: Row['verdict'] = 'HELD';
      try {
        const entry = registry.resolve(query);
        const shadow = registry.shadowFor({
          task: query.task,
          platform: query.platform,
          stroke: query.stroke,
        });
        const byId = registry.byId(hostileString(rng), hostileString(rng));
        const listed = registry.list(rng.chance(0.5) ? query.task : undefined);
        outcome = entry ? `entry=${entry.id}@${entry.version}` : 'null';
        const wantStatus = query.status ?? 'production';
        if (entry) {
          if (entry.task !== query.task) {
            verdict = 'BROKEN';
            detail = `task mismatch ${entry.task} != ${String(query.task)}`;
          } else if (entry.deploymentStatus !== wantStatus) {
            verdict = 'BROKEN';
            detail = `status mismatch ${entry.deploymentStatus} != ${String(wantStatus)}`;
          } else if (!entry.supportedPlatforms.includes(query.platform)) {
            verdict = 'BROKEN';
            detail = 'platform mismatch';
          } else if (
            query.stroke !== undefined &&
            entry.supportedStrokes !== 'all' &&
            !entry.supportedStrokes.includes(query.stroke)
          ) {
            verdict = 'BROKEN';
            detail = 'stroke mismatch';
          }
        }
        if (shadow && shadow.deploymentStatus !== 'shadow') {
          verdict = 'BROKEN';
          detail += ' shadowFor returned non-shadow';
        }
        if (byId !== null) {
          verdict = 'BROKEN';
          detail += ' byId matched junk';
        }
        if (!Array.isArray(listed)) {
          verdict = 'BROKEN';
          detail += ' list not array';
        }
      } catch (error) {
        outcome = 'throw';
        detail = errorText(error);
        verdict = 'BROKEN';
      }
      record(
        {
          campaign: 'D',
          seed,
          input: `task=${describeValue(query.task)} platform=${describeValue(query.platform)} stroke=${describeValue(query.stroke)} status=${describeValue(query.status)}`,
          outcome,
          detail,
          verdict,
        },
        t0,
      );
    }
  });

  it('F: JSON ingress → parsePoseSequence → createFusionProviders → analyzeCapture never throws, never pollutes, always a Result (I7)', async () => {
    const producedBy = {
      providerId: 'pose.apple-vision',
      runtime: 'vision_framework',
      executionTarget: 'on_device',
      artifactHash: null,
    } as const;
    const isFinite = (n: unknown): boolean =>
      typeof n === 'number' && Number.isFinite(n);
    for (const seed of seedsFor('F')) {
      const rng = new Rng(seed);
      const t0 = performance.now();
      const { json, note } = hostileWireJson(rng);
      const declared: unknown = rng.chance(0.45)
        ? rng.pick(VALID_SLUGS)
        : rng.chance(0.6)
          ? null
          : hostileString(rng);
      const declaredTyped =
        declared === null || VALID_SLUGS.includes(declared as ShotTypeSlug);
      dumpReplay('F', seed, { declared, json });
      let outcome = '';
      let detail = '';
      let paddleNote = '';
      let verdict: Row['verdict'] = 'HELD';
      try {
        const parsed = parsePoseSequence(json, producedBy);
        if (
          ({} as Record<string, unknown>).polluted !== undefined ||
          ({} as Record<string, unknown>).x !== undefined
        ) {
          verdict = 'BROKEN';
          detail = 'Object.prototype polluted by parsePoseSequence';
          delete (Object.prototype as Record<string, unknown>).polluted;
          delete (Object.prototype as Record<string, unknown>).x;
        }
        if (!parsed.ok) {
          outcome = `parse:${parsed.failure.code}`;
          if (
            parsed.failure.kind !== 'corrupted_media' ||
            !parsed.failure.code.startsWith('pose_sequence.')
          ) {
            verdict = 'BROKEN';
            detail = `untyped parse failure ${parsed.failure.kind}/${parsed.failure.code}`;
          }
        } else {
          const seq = parsed.value;
          const nonFinite =
            !isFinite(seq.video.width) ||
            !isFinite(seq.video.height) ||
            !isFinite(seq.video.fps) ||
            seq.frames.some(
              f =>
                !isFinite(f.timestampMs) ||
                !isFinite(f.confidence) ||
                f.landmarks.some(
                  l =>
                    !isFinite(l.x) || !isFinite(l.y) || !isFinite(l.visibility),
                ),
            );
          const monotonic = seq.frames.every(
            (f, i) =>
              i === 0 ||
              f.timestampMs > (seq.frames[i - 1]?.timestampMs ?? -Infinity),
          );
          if (nonFinite || !monotonic) {
            verdict = 'BROKEN';
            detail = `validated sequence is ${nonFinite ? 'non-finite' : 'non-monotonic'}`;
            outcome = 'parse:ok-invalid';
          } else {
            const fusion = createFusionProviders(
              declared as ShotTypeSlug | null,
            );
            if (fusion.kind === 'unavailable') {
              outcome = `parse:ok fusion:unavailable`;
              if (copyViolation(fusion.reason)) {
                verdict = 'BROKEN';
                detail = `copy violation: ${copyViolation(fusion.reason)}`;
              } else if (declaredTyped) {
                verdict = 'BROKEN';
                detail = `typed declared refused: ${fusion.reason}`;
              }
            } else {
              const first = seq.frames[0]?.timestampMs ?? 0;
              const last =
                seq.frames[seq.frames.length - 1]?.timestampMs ?? first;
              const window = rng.chance(0.6)
                ? {
                    startMs: first,
                    endMs: last,
                    peakMotionMs: (first + last) / 2,
                  }
                : {
                    startMs: hostileNumber(rng),
                    endMs: hostileNumber(rng),
                    peakMotionMs: rng.chance(0.5) ? null : hostileNumber(rng),
                  };
              let counter = 0;
              // The app always passes `unavailable`; a measured hostile track
              // reaches the classifier through the engine's run() crash boundary.
              const paddleChoice = rng.chance(0.35)
                ? hostilePaddleTrack(rng, rng.chance(0.5))
                : null;
              const paddleTrack =
                paddleChoice &&
                typeof paddleChoice.paddle === 'object' &&
                paddleChoice.paddle !== null &&
                'producedBy' in paddleChoice.paddle
                  ? paddleChoice
                  : null;
              paddleNote = paddleTrack ? ` ${paddleTrack.note}` : '';
              const settled = await Promise.allSettled([
                analyzeCapture(
                  fusion.providers,
                  {
                    captureId: hostileString(rng).slice(0, 128) || 'capture',
                    pose: seq,
                    paddle: paddleTrack
                      ? measured(paddleTrack.paddle as PaddleTrack)
                      : unavailable('paddle_detector_not_installed'),
                    ball: unavailable('ball_tracker_not_installed'),
                    trigger: {
                      ...window,
                      confidence: rng.chance(0.5) ? 0.9 : hostileNumber(rng),
                      producedBy: {
                        providerId: 'trigger.temporal-heuristic',
                        modelVersion: rng.chance(0.7)
                          ? 'temporal-stroke-heuristic-2'
                          : hostileString(rng).slice(0, 256),
                        runtime: 'deterministic',
                        executionTarget: 'on_device',
                        artifactHash: null,
                      },
                    },
                    stroke: {
                      declared: declared as ShotTypeSlug | null,
                      predicted: null,
                    },
                    declaredCanonical: rng.chance(0.7)
                      ? null
                      : hostileString(rng).slice(0, 64),
                    handedness: rng.pick(['right', 'left'] as const),
                    cameraView: rng.pick(['side', 'rear_oblique'] as const),
                    capturedAtIso: rng.chance(0.7)
                      ? '2026-09-05T00:00:00.000Z'
                      : hostileString(rng).slice(0, 64),
                  },
                  {
                    analysisId: 'stress-analysis',
                    sessionId: null,
                    appVersion: 'stress',
                    modelBundleVersion: 'on-device-fusion-1',
                    nowIso: () => '2026-09-05T00:00:00.000Z',
                    makeId: () => `id-${(counter += 1)}`,
                    captureEnvelopeThresholdsVersion: null,
                  },
                ),
              ]);
              const run = settled[0];
              if (!run) throw new Error('unreachable');
              if (run.status === 'rejected') {
                outcome = 'parse:ok fusion:REJECT';
                verdict = declaredTyped ? 'BROKEN' : 'RECORDED';
                detail = errorText(run.reason);
              } else if (!run.value.ok) {
                outcome = `parse:ok fusion:fail:${run.value.failure.code}`;
                if (
                  typeof run.value.failure.code !== 'string' ||
                  typeof run.value.failure.kind !== 'string'
                ) {
                  verdict = 'BROKEN';
                  detail = 'untyped fusion failure';
                }
              } else {
                const record = run.value.value;
                const crashed = record.modelRuns.filter(
                  r =>
                    r.status === 'failed' &&
                    r.failure?.code.endsWith('.provider_crash'),
                );
                outcome = `parse:ok fusion:ok:${record.result ? record.result.resultKind : 'abstained'}`;
                detail = `runs=${record.modelRuns.length} crashes=${crashed.map(r => r.task).join(',') || 'none'}`;
                if (
                  !Array.isArray(record.modelRuns) ||
                  record.modelRuns.length === 0
                ) {
                  verdict = 'BROKEN';
                  detail = 'no model runs recorded';
                }
                if (!declaredTyped && record.result?.resultKind === 'scored') {
                  verdict = 'BROKEN';
                  detail += ' | SCORED with a non-registry declared slug';
                }
              }
            }
          }
        }
      } catch (error) {
        outcome = 'throw';
        detail = errorText(error);
        verdict = 'BROKEN';
      }
      record(
        {
          campaign: 'F',
          seed,
          input: `${note} declared=${describeValue(declared)}${paddleNote}`,
          outcome,
          detail,
          verdict,
        },
        t0,
      );
    }
  });

  it('E: scoringStackStatus is a pure constant report with compliant copy (I6)', () => {
    const status = scoringStackStatus();
    expect(status).toEqual({
      installed: true,
      version: expect.stringContaining('sm-v1'),
      requirement: 'recorded_pose_sequence',
    });
    expect(copyViolation(status.version)).toBeNull();
    record(
      {
        campaign: 'E',
        seed: 0,
        input: 'scoringStackStatus()',
        outcome: status.version,
        detail: '',
        verdict: 'HELD',
      },
      performance.now(),
    );
  });

  it('reports every BROKEN row (minimized seeds) — must be empty', () => {
    if (broken.length > 0) {
      const byOutcome = new Map<string, Row[]>();
      for (const row of broken) {
        const key = `${row.campaign}:${row.outcome}:${row.detail.slice(0, 80)}`;
        byOutcome.set(key, [...(byOutcome.get(key) ?? []), row]);
      }
      const report = [...byOutcome.entries()]
        .map(
          ([key, list]) =>
            `${key} ×${list.length} — replay STRESS_REPLAY=${list[0]?.campaign}:${list[0]?.seed}`,
        )
        .join('\n');
      throw new Error(`BROKEN invariants (${broken.length} rows):\n${report}`);
    }
    expect(broken).toEqual([]);
  });
});
