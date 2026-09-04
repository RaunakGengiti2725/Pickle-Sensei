import * as fs from 'fs';
import * as path from 'path';
import { generateSwingSequence } from '@pickle/evaluation';
import {
  parsePoseSequence,
  serializePoseSequence,
  sha256Hex,
} from '@pickle/swing-domain';
import type { PoseSequenceSidecarRef } from '../../src/camera/capture';
import { loadReviewPoseSequence } from '../../src/review/poseSidecar';

/**
 * STRESS / concurrency — `review/poseSidecar`.
 *
 * Seeded bursts of `loadReviewPoseSequence` over a small pool of sidecar
 * files: duplicate loads of one ref, loads of different refs in flight at
 * once, a second actor that swaps a file's bytes or rewrites the ref's hash
 * while a read is in flight (two actors on the same row), reads that reject,
 * resolve late, or hand back a non-string. Every call is checked against an
 * exact oracle computed from the bytes that read actually delivered and the
 * ref as it stood when the call verified it:
 *
 *   non-null  ⇔  bytes are a string, sha256(bytes) === ref.sha256, parse ok
 *   non-null  ⇒  frames equal the parse of exactly those bytes (no cross-talk)
 *
 * plus: duplicate loads agree with each other, no call rejects, and the
 * burst settles within a wall-time bound.
 *
 *   STRESS_SEED=<seed> STRESS_ITER=1 npx jest --ci __tests__/stress/reviewModelsConcurrency.poseSidecar
 */

type Delivered =
  { kind: 'string'; json: string } | { kind: 'reject' } | { kind: 'nonString' };

let mockRead: (uri: string) => Promise<string> = async () => {
  throw new Error('mock not configured');
};

jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockRead(uri),
  };
});

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

function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('pick from empty list');
  return item;
}

async function hop(rng: () => number): Promise<void> {
  const r = rng();
  if (r < 0.25) return;
  if (r < 0.85) {
    const n = 1 + Math.floor(rng() * 4);
    for (let i = 0; i < n; i += 1) await Promise.resolve();
    return;
  }
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

// -------------------------------------------------------------- sidecar pool

interface PoolEntry {
  uri: string;
  json: string;
  sha256: string;
  frameCount: number;
}

const truths = [
  {},
  { handed: 'left' as const },
  { fps: 60, backswingMs: 500 },
  { torsoLength: 0.15, shoulderTurnDeg: 60 },
];

const pool: PoolEntry[] = truths.map((truth, index) => {
  const { sequence } = generateSwingSequence(truth);
  const json = serializePoseSequence(sequence);
  return {
    uri: `file:///captures/clip-${index}.pose.json`,
    json,
    sha256: sha256Hex(json),
    frameCount: sequence.frames.length,
  };
});

// Byte-level corruptions a second actor may write over a sidecar file.
function corrupt(rng: () => number, json: string): string {
  switch (Math.floor(rng() * 5)) {
    case 0:
      return json.slice(0, Math.floor(json.length * rng()));
    case 1:
      return json.replace(
        '"frames":[',
        '"frames":[{"i":0,"t":"nan","c":1,"l":[]},',
      );
    case 2:
      return `${json} `;
    case 3:
      return json.replace(/"t":(\d+)/, '"t":-1');
    default:
      return 'not json at all';
  }
}

function refFor(entry: PoolEntry): PoseSequenceSidecarRef {
  return {
    schemaVersion: 1,
    format: 'pickle.pose-sequence.v1',
    uri: entry.uri,
    frameCount: entry.frameCount,
    sha256: entry.sha256,
    coordinateSystem: 'normalized_image_top_left',
    poseModelVersion: 'apple-vision-bodypose-1',
  } as PoseSequenceSidecarRef;
}

function parsedFrameCount(json: string): number | null {
  const parsed = parsePoseSequence(json, {
    providerId: 'pose.apple-vision',
    runtime: 'vision_framework',
    executionTarget: 'on_device',
    artifactHash: null,
  });
  return parsed.ok ? parsed.value.frames.length : null;
}

// ------------------------------------------------------------------ scenario

interface CallRecord {
  index: number;
  uri: string;
  delivered: Delivered | null;
  shaAtVerify: string | null;
  result: 'rejected' | 'null' | number;
  expected: 'null' | number;
}

interface Iteration {
  seed: number;
  calls: number;
  wallMs: number;
  outcome: 'HELD' | 'BROKEN';
  violations: string[];
  nonNull: number;
  swaps: number;
  rehashes: number;
}

const WALL_BOUND_MS = 4_000;

async function runIteration(seed: number): Promise<Iteration> {
  const rng = mulberry32(seed);
  const violations: string[] = [];
  const files = new Map(pool.map(entry => [entry.uri, entry.json]));
  const refs = new Map(pool.map(entry => [entry.uri, refFor(entry)]));

  // One record per readCaptureArtifact invocation, in call order. The
  // module reads synchronously up to its first await, so the i-th mock call
  // belongs to the i-th load started by Promise.all.
  const records: CallRecord[] = [];
  const readRng = mulberry32(seed ^ 0x9e3779b9);
  const actorRng = mulberry32(seed ^ 0x51ed270b);
  let swaps = 0;
  let rehashes = 0;
  let readCalls = 0;

  mockRead = async uri => {
    const record = records[readCalls++];
    if (!record || record.uri !== uri) {
      throw new Error(`unexpected read #${readCalls} of ${uri}`);
    }
    await hop(readRng);
    // Second actor on the same row while this read is in flight. It acts on
    // a macrotask so a load whose read already resolved has verified by then
    // (microtasks drain first) and `shaAtVerify` is exact.
    const roll = actorRng();
    if (roll < 0.15) {
      swaps += 1;
      const other = pick(actorRng, pool);
      const bytes =
        actorRng() < 0.5 ? other.json : corrupt(actorRng, other.json);
      setTimeout(() => files.set(uri, bytes), 0);
    } else if (roll < 0.3) {
      rehashes += 1;
      const ref = refs.get(uri);
      const other = pick(actorRng, pool);
      const sha =
        actorRng() < 0.7 ? other.sha256 : sha256Hex(`${other.sha256}!`);
      setTimeout(() => {
        if (ref) (ref as { sha256: string }).sha256 = sha;
      }, 0);
    }
    await hop(readRng);
    const fault = readRng();
    if (fault < 0.1) {
      record.delivered = { kind: 'reject' };
      throw new Error('artifact unreadable');
    }
    if (fault < 0.15) {
      record.delivered = { kind: 'nonString' };
      return 42 as unknown as string;
    }
    const json = files.get(uri);
    if (json === undefined) throw new Error(`no file for ${uri}`);
    record.delivered = { kind: 'string', json };
    // The ref the module will verify against after this resolves.
    record.shaAtVerify = refs.get(uri)?.sha256 ?? null;
    return json;
  };

  const callCount = 4 + Math.floor(rng() * 28);
  const started = Date.now();
  const tasks: Promise<void>[] = [];
  for (let i = 0; i < callCount; i += 1) {
    const entry = pick(rng, pool);
    const record: CallRecord = {
      index: i,
      uri: entry.uri,
      delivered: null,
      shaAtVerify: null,
      result: 'null',
      expected: 'null',
    };
    records.push(record);
    const ref = refs.get(entry.uri);
    if (!ref) throw new Error('pool ref missing');
    tasks.push(
      loadReviewPoseSequence(ref).then(
        loaded => {
          record.result = loaded ? loaded.frames.length : 'null';
        },
        () => {
          record.result = 'rejected';
        },
      ),
    );
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), WALL_BOUND_MS);
  });
  const settled = await Promise.race([Promise.all(tasks), timeout]);
  clearTimeout(timer);
  const wallMs = Date.now() - started;
  if (settled === 'timeout') {
    violations.push(`deadlock: burst did not settle within ${WALL_BOUND_MS}ms`);
    await Promise.all(tasks);
  }

  // ---------------------------------------------------------- oracle
  for (const record of records) {
    if (record.result === 'rejected') {
      violations.push(`call ${record.index} rejected`);
      continue;
    }
    const d = record.delivered;
    if (!d) {
      violations.push(`call ${record.index} never read its artifact`);
      continue;
    }
    if (d.kind === 'string' && record.shaAtVerify === sha256Hex(d.json)) {
      const frames = parsedFrameCount(d.json);
      record.expected = frames === null ? 'null' : frames;
    } else {
      record.expected = 'null';
    }
    if (record.result !== record.expected) {
      violations.push(
        `call ${record.index} (${record.uri}) → ${record.result}, expected ${record.expected} [delivered=${d.kind}]`,
      );
    }
  }

  // Idempotency: duplicate loads that were handed identical bytes under the
  // same ref hash agree.
  const byKey = new Map<string, Set<string>>();
  for (const record of records) {
    if (!record.delivered || record.delivered.kind !== 'string') continue;
    const key = `${record.uri}|${record.shaAtVerify}|${sha256Hex(record.delivered.json)}`;
    const set = byKey.get(key) ?? new Set<string>();
    set.add(String(record.result));
    byKey.set(key, set);
  }
  for (const [key, results] of byKey) {
    if (results.size > 1) {
      violations.push(
        `duplicate loads disagree for ${key}: ${[...results].join(',')}`,
      );
    }
  }

  return {
    seed,
    calls: callCount,
    wallMs,
    outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
    violations,
    nonNull: records.filter(r => typeof r.result === 'number').length,
    swaps,
    rehashes,
  };
}

// ------------------------------------------------------------------ campaign

const ITER = Math.max(1, Number(process.env.STRESS_ITER ?? 24) || 24);
const SEED0 = Number(process.env.STRESS_SEED ?? 1) || 1;
const OUT_DIR = process.env.STRESS_OUT_DIR;

describe('loadReviewPoseSequence under seeded concurrent bursts', () => {
  it(
    `matches the byte-exact oracle over ${ITER} interleavings from seed ${SEED0}`,
    async () => {
      const table: Iteration[] = [];
      for (let i = 0; i < ITER; i += 1) {
        table.push(await runIteration(SEED0 + i));
      }
      if (OUT_DIR) {
        fs.mkdirSync(OUT_DIR, { recursive: true });
        fs.writeFileSync(
          path.join(
            OUT_DIR,
            `poseSidecar.concurrency.seed${SEED0}.n${ITER}.json`,
          ),
          JSON.stringify(
            {
              suite: 'reviewModelsConcurrency.poseSidecar',
              seed0: SEED0,
              iterations: table.length,
              callsExecuted: table.reduce((n, it) => n + it.calls, 0),
              nonNullLoads: table.reduce((n, it) => n + it.nonNull, 0),
              broken: table
                .filter(it => it.outcome === 'BROKEN')
                .map(it => it.seed),
              table,
            },
            null,
            2,
          ),
        );
      }
      const broken = table.filter(it => it.outcome === 'BROKEN');
      expect(
        broken.map(it => ({ seed: it.seed, violations: it.violations })),
      ).toEqual([]);
      expect(table).toHaveLength(ITER);
      // The oracle must have exercised both branches, or it proves nothing.
      expect(table.some(it => it.nonNull > 0)).toBe(true);
      expect(table.some(it => it.nonNull < it.calls)).toBe(true);
      for (const it of table) expect(it.wallMs).toBeLessThan(WALL_BOUND_MS);
    },
    Math.max(30_000, ITER * WALL_BOUND_MS),
  );
});
