import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { PoseSequenceSidecarRef } from '../../src/camera/capture';
import { loadReviewPoseSequence } from '../../src/review/poseSidecar';
import type { ReviewPoseSequence } from '../../src/review/formReviewModel';
import {
  Rng,
  drawLength,
  invariant,
  runCampaign,
  stableJson,
  type SequenceRun,
  type StepTrace,
} from '../../test-support/stress/reviewSeeded';

/**
 * SEEDED RANDOMIZED LONG-RUN — review/poseSidecar.
 *
 * One sequence = a seeded private-artifact store (recorded sidecars, corrupt
 * bytes, tampered documents, unreadable files, non-string reads) plus 5..60
 * actions that write/tamper/break artifacts and load refs against them —
 * including concurrent loads. After every load the result is checked against
 * an INDEPENDENT reference: `null` unless the read succeeded with a string,
 * its SHA-256 is byte-identical to the ref, and the document satisfies the
 * canonical pose-sequence schema (spelled out again here, not imported);
 * otherwise exactly the recorded frames, never repaired, never inferred.
 *
 * Replay any seed: STRESS_SEED=<seed> STRESS_ITER=1 npx jest --ci <this file>.
 */

jest.setTimeout(20 * 60 * 1000);

type Artifact =
  | { kind: 'bytes'; json: string }
  | { kind: 'throws' }
  | { kind: 'nonString'; value: unknown };

const store = new Map<string, Artifact>();
const readLog: string[] = [];

jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

async function mockReadArtifact(uri: string): Promise<string> {
  readLog.push(uri);
  const artifact = store.get(uri);
  if (!artifact) throw new Error(`ENOENT ${uri}`);
  if (artifact.kind === 'throws') throw new Error(`EIO ${uri}`);
  if (artifact.kind === 'nonString') return artifact.value as string;
  return artifact.json;
}

// ─── Independent reference for the canonical parse ─────────────────────────

interface WireMark {
  n: string;
  x: number;
  y: number;
  v: number;
  z?: number;
}
interface WireFrame {
  i: number;
  t: number;
  c: number;
  l: WireMark[];
}
interface Wire {
  schemaVersion: number;
  format: string;
  coordinateSystem: string;
  poseModelVersion: string;
  video: { w: number; h: number; fps: number };
  frames: WireFrame[];
}

/** packages/swing-domain observations.ts COORDINATE_SYSTEMS, restated. */
const COORDINATE_SYSTEMS: readonly string[] = [
  'normalized_image_top_left',
  'image_pixels',
  'camera_meters',
  'world_meters',
  'body_normalized',
];

const fin = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** True when the parsed document is a valid canonical pose sequence. */
function refValid(doc: unknown): doc is Wire {
  if (!doc || typeof doc !== 'object') return false;
  const wire = doc as Partial<Wire>;
  if (wire.schemaVersion !== 1) return false;
  if (wire.format !== 'pickle.pose-sequence.v1') return false;
  if (!COORDINATE_SYSTEMS.includes(wire.coordinateSystem as string))
    return false;
  if (
    typeof wire.poseModelVersion !== 'string' ||
    wire.poseModelVersion.length === 0
  )
    return false;
  const video = wire.video;
  if (!video || !fin(video.w) || !fin(video.h) || !fin(video.fps)) return false;
  if (video.w <= 0 || video.h <= 0 || video.fps <= 0) return false;
  if (!Array.isArray(wire.frames)) return false;
  let previous = Number.NEGATIVE_INFINITY;
  for (const frame of wire.frames as unknown[]) {
    if (!frame || typeof frame !== 'object') return false;
    const f = frame as Partial<WireFrame>;
    if (!fin(f.t) || !fin(f.c) || !Number.isInteger(f.i)) return false;
    if (f.t <= previous) return false;
    previous = f.t;
    if (!Array.isArray(f.l) || f.l.length === 0) return false;
    for (const mark of f.l as unknown[]) {
      if (!mark || typeof mark !== 'object') return false;
      const m = mark as Partial<WireMark>;
      if (typeof m.n !== 'string' || m.n.length === 0) return false;
      if (!fin(m.x) || !fin(m.y) || !fin(m.v)) return false;
      if (m.z !== undefined && !fin(m.z)) return false;
    }
  }
  return true;
}

function refFrames(wire: Wire) {
  return wire.frames.map(frame => ({
    frameIndex: frame.i,
    timestampMs: frame.t,
    confidence: frame.c,
    landmarks: frame.l.map(mark => ({
      name: mark.n,
      x: mark.x,
      y: mark.y,
      visibility: mark.v,
      ...(mark.z !== undefined ? { z: mark.z } : {}),
    })),
  }));
}

function coordinateSystemsMatch(
  doc: Wire,
  loaded: ReviewPoseSequence,
): boolean {
  const full = loaded as ReviewPoseSequence & {
    schemaVersion?: number;
    format?: string;
    coordinateSystem?: string;
    producedBy?: {
      modelVersion?: string;
      providerId?: string;
      runtime?: string;
    };
    video?: { width: number; height: number; fps: number };
  };
  return (
    full.schemaVersion === 1 &&
    full.format === doc.format &&
    full.coordinateSystem === doc.coordinateSystem &&
    full.producedBy?.modelVersion === doc.poseModelVersion &&
    full.producedBy?.providerId === 'pose.apple-vision' &&
    full.producedBy?.runtime === 'vision_framework' &&
    full.video?.width === doc.video.w &&
    full.video?.height === doc.video.h &&
    full.video?.fps === doc.video.fps
  );
}

// ─── Generators ─────────────────────────────────────────────────────────────

function validDocument(rng: Rng): string {
  const { sequence } = generateSwingSequence({
    handed: rng.pick(['right', 'left'] as const),
    fps: rng.pick([24, 30, 60]),
    readyMs: rng.int(100, 500),
    backswingMs: rng.int(100, 500),
    accelerateMs: rng.int(80, 300),
    followMs: rng.int(80, 400),
    recoverMs: rng.int(100, 500),
    torsoLength: rng.float(0.2, 0.45),
  });
  return serializePoseSequence(sequence);
}

type DocMutation =
  | 'pretty-print'
  | 'reorder-keys'
  | 'extra-keys'
  | 'drop-frame'
  | 'empty-frames'
  | 'schema-version'
  | 'format'
  | 'coordinate-system'
  | 'model-version'
  | 'video'
  | 'frame-shape'
  | 'frame-timing'
  | 'non-monotonic'
  | 'landmark'
  | 'landmark-z-null'
  | 'root-not-object'
  | 'byte-flip'
  | 'truncate';

const DOC_MUTATIONS: readonly DocMutation[] = [
  'pretty-print',
  'reorder-keys',
  'extra-keys',
  'drop-frame',
  'empty-frames',
  'schema-version',
  'format',
  'coordinate-system',
  'model-version',
  'video',
  'frame-shape',
  'frame-timing',
  'non-monotonic',
  'landmark',
  'landmark-z-null',
  'root-not-object',
  'byte-flip',
  'truncate',
];

function reorder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorder);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).reverse()) {
      out[key] = reorder((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

const loose = (value: unknown): Record<string, unknown> =>
  value as Record<string, unknown>;

/** Applies one mutation to a valid document; returns the new bytes. */
function mutateDocument(rng: Rng, json: string, mutation: DocMutation): string {
  if (mutation === 'byte-flip') {
    const index = rng.int(0, json.length - 1);
    const replacement = rng.pick(['0', '9', 'x', '"', ',', '}', ' ', '-', 'e']);
    return json.slice(0, index) + replacement + json.slice(index + 1);
  }
  if (mutation === 'truncate')
    return json.slice(0, rng.int(0, json.length - 1));
  const doc = JSON.parse(json) as Wire;
  const frames = doc.frames;
  const frameAt = (): WireFrame | undefined =>
    frames.length > 0 ? frames[rng.int(0, frames.length - 1)] : undefined;
  switch (mutation) {
    case 'pretty-print':
      return JSON.stringify(doc, null, rng.pick([1, 2, '\t']));
    case 'reorder-keys':
      return JSON.stringify(reorder(doc));
    case 'extra-keys': {
      const extra = doc as Wire & Record<string, unknown>;
      extra.note = 'capture-debug';
      const frame = frameAt();
      if (frame)
        (frame as WireFrame & Record<string, unknown>).debug = rng.int(0, 9);
      if (frame?.l[0])
        (frame.l[0] as WireMark & Record<string, unknown>).w = 0.5;
      return JSON.stringify(extra);
    }
    case 'drop-frame': {
      if (frames.length > 0) frames.splice(rng.int(0, frames.length - 1), 1);
      return JSON.stringify(doc);
    }
    case 'empty-frames':
      doc.frames = [];
      return JSON.stringify(doc);
    case 'schema-version':
      loose(doc).schemaVersion = rng.pick([0, 2, '1', null, undefined]);
      return JSON.stringify(doc);
    case 'format':
      loose(doc).format = rng.pick(['pickle.pose-sequence.v2', '', null]);
      return JSON.stringify(doc);
    case 'coordinate-system':
      loose(doc).coordinateSystem = rng.pick([
        'image_pixels', // still valid
        'normalized_image_bottom_left',
        '',
        null,
      ]);
      return JSON.stringify(doc);
    case 'model-version':
      loose(doc).poseModelVersion = rng.pick(['', 7, null, undefined]);
      return JSON.stringify(doc);
    case 'video': {
      const video = doc.video as Record<string, unknown>;
      const field = rng.pick(['w', 'h', 'fps']);
      video[field] = rng.pick([0, -1, 'x', null, undefined, 30]);
      if (rng.chance(0.2)) loose(doc).video = undefined;
      return JSON.stringify(doc);
    }
    case 'frame-shape': {
      const frame = frameAt();
      if (frame) {
        const mode = rng.int(0, 4);
        const loose = frame as unknown as Record<string, unknown>;
        if (mode === 0) loose.i = rng.pick([1.5, 'a', null, Number.NaN]);
        else if (mode === 1) loose.c = rng.pick(['1', null, Number.NaN]);
        else if (mode === 2) loose.l = [];
        else if (mode === 3) loose.l = 'none';
        else
          frames[frames.indexOf(frame)] = rng.pick([
            null,
            5,
            'frame',
          ]) as unknown as WireFrame;
      }
      return JSON.stringify(doc);
    }
    case 'frame-timing': {
      const frame = frameAt();
      if (frame)
        (frame as unknown as Record<string, unknown>).t = rng.pick([
          '12',
          null,
          Number.NaN,
        ]);
      return JSON.stringify(doc);
    }
    case 'non-monotonic': {
      if (frames.length >= 2) {
        const index = rng.int(1, frames.length - 1);
        const mode = rng.int(0, 2);
        const current = frames[index] as WireFrame;
        const before = frames[index - 1] as WireFrame;
        if (mode === 0)
          current.t = before.t; // duplicate timestamp
        else if (mode === 1)
          current.t = before.t - rng.int(1, 40); // backwards
        else
          frames.splice(index, 0, {
            ...before,
            l: before.l.map(mark => ({ ...mark })),
          }); // duplicated frame
      }
      return JSON.stringify(doc);
    }
    case 'landmark': {
      const frame = frameAt();
      const mark = frame?.l[rng.int(0, (frame?.l.length ?? 1) - 1)];
      if (mark) {
        const loose = mark as unknown as Record<string, unknown>;
        const field = rng.pick(['n', 'x', 'y', 'v']);
        loose[field] =
          field === 'n'
            ? rng.pick(['', 4, null])
            : rng.pick(['0.5', null, Number.NaN]);
      }
      return JSON.stringify(doc);
    }
    case 'landmark-z-null': {
      const frame = frameAt();
      const mark = frame?.l[0];
      if (mark)
        (mark as unknown as Record<string, unknown>).z = rng.pick([
          null,
          'deep',
          0.25,
        ]);
      return JSON.stringify(doc);
    }
    case 'root-not-object':
      return JSON.stringify(rng.pick([[doc], null, 'sequence', 42]));
    default:
      return json;
  }
}

function refFor(
  json: string | null,
  uri: string,
  rng: Rng,
): PoseSequenceSidecarRef {
  return {
    schemaVersion: 1,
    format: 'pickle.pose-sequence.v1',
    uri,
    frameCount: rng.int(0, 400),
    sha256: json === null ? 'ab'.repeat(32) : sha256Hex(json),
    coordinateSystem: 'normalized_image_top_left',
    poseModelVersion: 'apple-vision-bodypose-1',
  } as PoseSequenceSidecarRef;
}

/** What loadReviewPoseSequence must return for `ref` against the store. */
function expectedOutcome(ref: PoseSequenceSidecarRef | null | undefined): {
  result: 'null' | 'sequence';
  doc?: Wire;
  reads: number;
} {
  if (!ref || typeof ref.uri !== 'string' || ref.uri.length === 0) {
    return { result: 'null', reads: 0 };
  }
  const artifact = store.get(ref.uri);
  if (!artifact || artifact.kind !== 'bytes')
    return { result: 'null', reads: 1 };
  if (sha256Hex(artifact.json) !== ref.sha256)
    return { result: 'null', reads: 1 };
  let doc: unknown;
  try {
    doc = JSON.parse(artifact.json);
  } catch {
    return { result: 'null', reads: 1 };
  }
  if (!refValid(doc)) return { result: 'null', reads: 1 };
  return { result: 'sequence', doc, reads: 1 };
}

function checkLoaded(
  loaded: ReviewPoseSequence | null,
  expected: ReturnType<typeof expectedOutcome>,
  label: string,
  step: number,
): void {
  if (expected.result === 'null') {
    invariant(
      loaded === null,
      'null-unless-verified',
      step,
      () =>
        `${label}: loaded a sequence (${loaded?.frames.length} frames) that must have been rejected`,
    );
    return;
  }
  const doc = expected.doc as Wire;
  invariant(
    loaded !== null,
    'valid-sidecar-loads',
    step,
    () =>
      `${label}: a byte-identical valid sidecar with ${doc.frames.length} frames loaded as null`,
  );
  const sequence = loaded as ReviewPoseSequence;
  invariant(
    stableJson(sequence.frames) === stableJson(refFrames(doc)),
    'frames-exactly-recorded',
    step,
    () => `${label}: loaded frames differ from the recorded document`,
  );
  invariant(
    coordinateSystemsMatch(doc, sequence),
    'sequence-header',
    step,
    () => `${label}: header/video/provenance differ from the document`,
  );
  for (const frame of sequence.frames) {
    invariant(
      Number.isFinite(frame.timestampMs) && Number.isFinite(frame.confidence),
      'frame-finite',
      step,
      () => `${label}: non-finite frame values`,
    );
    for (const mark of frame.landmarks) {
      invariant(
        Number.isFinite(mark.x) &&
          Number.isFinite(mark.y) &&
          Number.isFinite(mark.visibility),
        'landmark-finite',
        step,
        () => `${label}: non-finite landmark ${mark.name}`,
      );
    }
  }
}

// ─── One sequence ───────────────────────────────────────────────────────────

type Action =
  | 'record'
  | 'tamper'
  | 'corruptBytes'
  | 'breakRead'
  | 'nonStringRead'
  | 'delete'
  | 'load'
  | 'loadStaleRef'
  | 'loadBadRef'
  | 'loadConcurrent';

const ACTIONS: ReadonlyArray<[Action, number]> = [
  ['record', 14],
  ['tamper', 14],
  ['corruptBytes', 6],
  ['breakRead', 4],
  ['nonStringRead', 4],
  ['delete', 4],
  ['load', 26],
  ['loadStaleRef', 8],
  ['loadBadRef', 8],
  ['loadConcurrent', 12],
];

function drawAction(rng: Rng): Action {
  const total = ACTIONS.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng.float(0, total);
  for (const [action, weight] of ACTIONS) {
    roll -= weight;
    if (roll < 0) return action;
  }
  return 'load';
}

async function runSequence(
  seed: number,
  stepLimit?: number,
): Promise<SequenceRun> {
  const rng = new Rng(seed);
  const length = drawLength(rng);
  const steps = Math.min(length, stepLimit ?? length);
  store.clear();
  readLog.length = 0;
  const uris = Array.from(
    { length: rng.int(1, 4) },
    (_, index) => `file:///captures/${seed}-${index}.pose.json`,
  );
  /** The ref capture wrote for each uri (kept even after the bytes change). */
  const refs = new Map<string, PoseSequenceSidecarRef>();
  const trace: StepTrace[] = [];
  const tallies: Record<string, number> = {};
  const tally = (key: string, by = 1) => {
    tallies[key] = (tallies[key] ?? 0) + by;
  };

  const doLoad = async (
    ref: PoseSequenceSidecarRef | null | undefined,
    label: string,
    step: number,
  ): Promise<string> => {
    const expected = expectedOutcome(ref);
    const readsBefore = readLog.length;
    let loaded: ReviewPoseSequence | null;
    try {
      loaded = await loadReviewPoseSequence(ref);
    } catch (error) {
      throw new Error(
        `[never-rejects] step ${step}: ${label} rejected: ${String(error)}`,
      );
    }
    invariant(
      readLog.length - readsBefore === expected.reads,
      'one-read-per-load',
      step,
      () =>
        `${label}: ${readLog.length - readsBefore} artifact reads (expected ${expected.reads})`,
    );
    checkLoaded(loaded, expected, label, step);
    tally(expected.result === 'null' ? 'loadsRejected' : 'loadsAccepted');
    return expected.result === 'null'
      ? 'null'
      : `frames:${loaded?.frames.length}`;
  };

  for (let step = 1; step <= steps; step += 1) {
    const action = drawAction(rng);
    const entry: StepTrace = { step, action };
    const uri = rng.pick(uris);
    entry.uri = uri;
    switch (action) {
      case 'record': {
        const json = validDocument(rng);
        store.set(uri, { kind: 'bytes', json });
        refs.set(uri, refFor(json, uri, rng));
        entry.bytes = json.length;
        break;
      }
      case 'tamper': {
        const base = store.get(uri);
        const json = base?.kind === 'bytes' ? base.json : validDocument(rng);
        const mutation = rng.pick(DOC_MUTATIONS);
        let mutated: string;
        try {
          mutated = mutateDocument(rng, json, mutation);
        } catch {
          // The base bytes were already unparseable; tamper on a fresh doc.
          mutated = mutateDocument(rng, validDocument(rng), mutation);
        }
        store.set(uri, { kind: 'bytes', json: mutated });
        // Capture "recorded" the tampered bytes: the ref hashes them, so only
        // the schema decides. (Stale refs are exercised by loadStaleRef.)
        refs.set(uri, refFor(mutated, uri, rng));
        entry.mutation = mutation;
        tally(`tamper:${mutation}`);
        break;
      }
      case 'corruptBytes': {
        const base = store.get(uri);
        if (base?.kind === 'bytes') {
          const mutation = rng.pick([
            'byte-flip',
            'truncate',
            'pretty-print',
          ] as const);
          let corrupted: string;
          try {
            corrupted = mutateDocument(rng, base.json, mutation);
          } catch {
            // Already unparseable bytes cannot be pretty-printed; flip instead.
            corrupted = mutateDocument(rng, base.json, 'byte-flip');
          }
          store.set(uri, { kind: 'bytes', json: corrupted });
          entry.mutation = mutation;
        } else {
          entry.skipped = true;
        }
        break;
      }
      case 'breakRead':
        store.set(uri, { kind: 'throws' });
        break;
      case 'nonStringRead':
        store.set(uri, {
          kind: 'nonString',
          value: rng.pick([undefined, null, 42, { json: true }, ['x']]),
        });
        break;
      case 'delete':
        store.delete(uri);
        break;
      case 'load': {
        const ref = refs.get(uri);
        entry.result = await doLoad(ref, `load ${uri}`, step);
        break;
      }
      case 'loadStaleRef': {
        // A ref whose hash belongs to different bytes (older recording).
        const ref = refs.get(uri) ?? refFor(null, uri, rng);
        const stale = {
          ...ref,
          sha256: rng.chance(0.5)
            ? sha256Hex(validDocument(rng))
            : rng.pick(['', 'ab'.repeat(32), ref.sha256.toUpperCase()]),
        };
        entry.result = await doLoad(stale, `stale ref ${uri}`, step);
        break;
      }
      case 'loadBadRef': {
        const base = refs.get(uri) ?? refFor(null, uri, rng);
        const bad = rng.pick([
          null,
          undefined,
          { ...base, uri: '' },
          { ...base, uri: 7 as unknown as string },
          {
            ...base,
            uri: `file:///captures/missing-${rng.int(0, 99)}.pose.json`,
          },
          { ...base, sha256: undefined as unknown as string },
        ]);
        entry.result = await doLoad(bad, `bad ref ${uri}`, step);
        break;
      }
      case 'loadConcurrent': {
        const count = rng.int(2, 6);
        const targets = Array.from({ length: count }, () => rng.pick(uris));
        const expectations = targets.map(target =>
          expectedOutcome(refs.get(target)),
        );
        const readsBefore = readLog.length;
        const results = await Promise.all(
          targets.map(target => loadReviewPoseSequence(refs.get(target))),
        );
        const expectedReads = expectations.reduce(
          (sum, expected) => sum + expected.reads,
          0,
        );
        invariant(
          readLog.length - readsBefore === expectedReads,
          'one-read-per-load',
          step,
          () =>
            `concurrent: ${readLog.length - readsBefore} reads for ${count} loads (expected ${expectedReads})`,
        );
        results.forEach((loaded, index) => {
          checkLoaded(
            loaded,
            expectations[index] as ReturnType<typeof expectedOutcome>,
            `concurrent[${index}] ${targets[index]}`,
            step,
          );
        });
        entry.results = results.map(loaded =>
          loaded ? `frames:${loaded.frames.length}` : 'null',
        );
        tally('concurrentLoads', count);
        break;
      }
      default:
        break;
    }
    trace.push(entry);
  }
  tallies.steps = trace.length;
  return { trace, length, tallies };
}

describe('seeded randomized long-run: review pose sidecar loading', () => {
  it('loads only byte-identical valid sidecars, never repairs, deterministically', async () => {
    const result = await runCampaign({
      name: 'poseSidecar.seeded',
      run: runSequence,
    });
    expect(result.executed).toBe(result.requested);
    expect(result.lengthMin).toBeGreaterThanOrEqual(5);
    expect(result.lengthMax).toBeLessThanOrEqual(60);
    expect(result.determinismMismatches).toBe(0);
    expect(result.failures).toEqual([]);
  });
});
