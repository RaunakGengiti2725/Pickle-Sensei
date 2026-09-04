/**
 * STRESS (lens: concurrency) — src/util/uuid.ts + src/util/plural.ts.
 *
 * `makeUuid` mints the client-side ids that become row keys (captures,
 * analyses, permit reservations, training sets). Every caller is on a hot
 * async path (`runCaptureAnalysis`, `sessionNative`, `trialCapture`,
 * `practiceSet`), so ids are minted concurrently and a collision would mean a
 * duplicate/overwritten row. It also reads `globalThis.crypto` on EVERY call,
 * so a randomness provider that appears/disappears mid-burst (the polyfill
 * installing late, a rotated global, a hostile stub) must not produce a
 * malformed or repeated id.
 *
 * Invariants asserted per seeded iteration:
 *   - no duplicate id inside an iteration AND none across the whole campaign;
 *   - every id is RFC-4122 v4 shaped (version nibble 4, variant bits 10xx);
 *   - the crypto path and the Math.random fallback are both exercised, and a
 *     provider swapped between two awaits never yields a malformed id;
 *   - a partial provider (getRandomValues missing) silently uses the
 *     fallback rather than throwing on an id-minting path;
 *   - `plural` is pure: interleaved concurrent calls return exactly what the
 *     same calls return sequentially (no shared/leaked state), including the
 *     odd counts UI copy can hand it (0, -0, negatives, NaN, Infinity).
 *
 * Scale: `STRESS_ITER` iterations (default small; recorded campaign 600).
 * `STRESS_OUT_UTIL` writes the seed -> outcome table as JSON.
 */

import { writeFileSync } from 'fs';

import { makeUuid } from '../../src/util/uuid';
import { plural } from '../../src/util/plural';

const ITERATIONS = Number(process.env['STRESS_ITER'] ?? 40);
const OUT_PATH = process.env['STRESS_OUT_UTIL'];
const BURST_BUDGET_MS = 5000;

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function intBelow(rng: () => number, bound: number): number {
  return Math.floor(rng() * bound);
}

async function ticks(count: number): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Provider = 'real' | 'seeded' | 'absent' | 'partial' | 'rotating';

interface CryptoHost {
  crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array };
}

const host = globalThis as unknown as CryptoHost;
const realCrypto = host.crypto;

function seededProvider(rng: () => number): {
  getRandomValues: (a: Uint8Array) => Uint8Array;
} {
  return {
    getRandomValues: (bytes: Uint8Array) => {
      for (let i = 0; i < bytes.length; i++) bytes[i] = intBelow(rng, 256);
      return bytes;
    },
  };
}

function installProvider(provider: Provider, rng: () => number): void {
  switch (provider) {
    case 'real':
      host.crypto = realCrypto;
      break;
    case 'seeded':
      host.crypto = seededProvider(rng);
      break;
    case 'absent':
      delete host.crypto;
      break;
    case 'partial':
      // A provider object with no getRandomValues (a half-installed
      // polyfill): makeUuid must take the Math.random fallback, not throw.
      host.crypto = {};
      break;
    case 'rotating':
      host.crypto = seededProvider(rng);
      break;
  }
}

interface UuidOutcome {
  seed: number;
  provider: Provider;
  concurrency: number;
  perCaller: number;
  ids: number;
  unique: number;
  malformed: number;
  throws: number;
  rotations: number;
  wallMs: number;
  violations: string[];
}

const PROVIDERS: Provider[] = [
  'real',
  'seeded',
  'absent',
  'partial',
  'rotating',
];

const allIds = new Set<string>();
let globalDuplicates = 0;
const uuidOutcomes: UuidOutcome[] = [];

async function runUuidIteration(seed: number): Promise<UuidOutcome> {
  const rng = makeRng(seed);
  const provider = PROVIDERS[intBelow(rng, PROVIDERS.length)]!;
  const concurrency = 4 + intBelow(rng, 29);
  const perCaller = 1 + intBelow(rng, 6);
  installProvider(provider, rng);

  const ids: string[] = [];
  const violations: string[] = [];
  let throws = 0;
  let rotations = 0;
  const started = Date.now();

  const callers: Array<Promise<void>> = [];
  for (let caller = 0; caller < concurrency; caller++) {
    callers.push(
      (async () => {
        for (let n = 0; n < perCaller; n++) {
          await ticks(intBelow(rng, 4));
          try {
            ids.push(makeUuid());
          } catch (error) {
            throws += 1;
            violations.push(`threw: ${String(error)}`);
          }
        }
      })(),
    );
  }

  if (provider === 'rotating') {
    // Swap the randomness provider under the running burst — the mobile
    // analogue of a polyfill installing (or a global being replaced) while
    // ids are being minted between awaits.
    for (let swap = 0; swap < 4; swap++) {
      callers.push(
        ticks(1 + intBelow(rng, 5)).then(() => {
          rotations += 1;
          const choice = intBelow(rng, 3);
          if (choice === 0) delete host.crypto;
          else if (choice === 1) host.crypto = {};
          else host.crypto = seededProvider(rng);
        }),
      );
    }
  }

  await Promise.all(callers);
  const wallMs = Date.now() - started;

  const unique = new Set(ids);
  const malformed = ids.filter(id => !UUID_V4.test(id)).length;
  if (unique.size !== ids.length) {
    violations.push(`duplicate ids in iteration: ${ids.length - unique.size}`);
  }
  if (malformed > 0) violations.push(`${malformed} malformed ids`);
  if (wallMs >= BURST_BUDGET_MS) violations.push(`wallMs=${wallMs}`);
  for (const id of ids) {
    if (allIds.has(id)) {
      globalDuplicates += 1;
      violations.push(`campaign-wide duplicate id ${id}`);
    }
    allIds.add(id);
  }

  host.crypto = realCrypto;

  return {
    seed,
    provider,
    concurrency,
    perCaller,
    ids: ids.length,
    unique: unique.size,
    malformed,
    throws,
    rotations,
    wallMs,
    violations,
  };
}

// ---------------------------------------------------------------------------
// plural: purity under interleaving
// ---------------------------------------------------------------------------
interface PluralCall {
  count: number;
  singular: string;
  pluralForm?: string;
}

const ODD_COUNTS = [
  0,
  -0,
  1,
  -1,
  2,
  37,
  1.0,
  1.5,
  0.999999,
  -1.5,
  NaN,
  Infinity,
  -Infinity,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
  1e-9,
];
const WORDS = ['day', 'read', 'clip', 'active day', 'entry is', 'rating'];
const IRREGULARS = ['days', 'reads', 'entries are', 'daily averages'];

function planPluralCalls(rng: () => number, count: number): PluralCall[] {
  const calls: PluralCall[] = [];
  for (let i = 0; i < count; i++) {
    const call: PluralCall = {
      count: ODD_COUNTS[intBelow(rng, ODD_COUNTS.length)]!,
      singular: WORDS[intBelow(rng, WORDS.length)]!,
    };
    if (rng() < 0.4) {
      call.pluralForm = IRREGULARS[intBelow(rng, IRREGULARS.length)]!;
    }
    calls.push(call);
  }
  return calls;
}

function applyPlural(call: PluralCall): string {
  return call.pluralForm === undefined
    ? plural(call.count, call.singular)
    : plural(call.count, call.singular, call.pluralForm);
}

interface PluralOutcome {
  seed: number;
  calls: number;
  mismatches: number;
  contractViolations: string[];
}

const pluralOutcomes: PluralOutcome[] = [];

async function runPluralIteration(seed: number): Promise<PluralOutcome> {
  const rng = makeRng(seed);
  const calls = planPluralCalls(rng, 8 + intBelow(rng, 25));
  const sequential = calls.map(applyPlural);

  // Same calls, interleaved across concurrent async actors in a seeded order.
  const interleaved = new Array<string>(calls.length);
  await Promise.all(
    calls.map(async (call, index) => {
      await ticks(intBelow(rng, 5));
      interleaved[index] = applyPlural(call);
    }),
  );

  let mismatches = 0;
  const contractViolations: string[] = [];
  for (let i = 0; i < calls.length; i++) {
    if (interleaved[i] !== sequential[i]) mismatches += 1;
    const call = calls[i]!;
    const expected =
      call.count === 1
        ? call.singular
        : (call.pluralForm ?? `${call.singular}s`);
    if (sequential[i] !== expected) {
      contractViolations.push(
        `count=${String(call.count)} -> ${String(sequential[i])} (expected ${expected})`,
      );
    }
  }
  return { seed, calls: calls.length, mismatches, contractViolations };
}

function uuidFailures(results: UuidOutcome[]): string {
  return results
    .filter(result => result.violations.length > 0)
    .map(
      result =>
        `seed ${result.seed} (${result.provider}): ${result.violations.join('; ')}`,
    )
    .join('\n');
}

afterAll(() => {
  host.crypto = realCrypto;
  if (!OUT_PATH) return;
  writeFileSync(
    OUT_PATH,
    `${JSON.stringify(
      {
        unit: 'mod-walkthrough-store-util',
        lens: 'concurrency',
        targets: [
          'apps/mobile/src/util/uuid.ts',
          'apps/mobile/src/util/plural.ts',
        ],
        iterations: ITERATIONS,
        uuidIdsMinted: allIds.size,
        uuidGlobalDuplicates: globalDuplicates,
        uuidOutcomes,
        pluralOutcomes,
      },
      null,
      2,
    )}\n`,
  );
});

describe('makeUuid under concurrent bursts (seeded)', () => {
  it('never collides and never emits a malformed id across every provider state', async () => {
    const results: UuidOutcome[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const outcome = await runUuidIteration(6_000_000 + i);
      results.push(outcome);
      uuidOutcomes.push(outcome);
    }
    expect(uuidFailures(results)).toBe('');
    expect(globalDuplicates).toBe(0);
    // Every provider state must actually have been exercised.
    const covered = new Set(results.map(result => result.provider));
    expect(covered.size).toBeGreaterThan(1);
  });

  it('mints ids without a randomness provider at all (fallback path)', async () => {
    delete host.crypto;
    try {
      const ids = await Promise.all(
        Array.from({ length: 256 }, async (_, index) => {
          await ticks(index % 3);
          return makeUuid();
        }),
      );
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(UUID_V4);
    } finally {
      host.crypto = realCrypto;
    }
  });

  it('a provider swapped mid-burst never yields a malformed or repeated id', async () => {
    const rng = makeRng(7_000_001);
    const ids: string[] = [];
    const work = Array.from({ length: 64 }, async (_, index) => {
      await ticks(index % 5);
      ids.push(makeUuid());
    });
    const swaps = Array.from({ length: 16 }, (_, index) =>
      ticks(index % 7).then(() => {
        if (index % 3 === 0) delete host.crypto;
        else if (index % 3 === 1) host.crypto = {};
        else host.crypto = seededProvider(rng);
      }),
    );
    try {
      await Promise.all([...work, ...swaps]);
    } finally {
      host.crypto = realCrypto;
    }
    expect(ids).toHaveLength(64);
    expect(new Set(ids).size).toBe(64);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });
});

describe('plural is pure under interleaved concurrent use (seeded)', () => {
  it('returns the same label sequentially and interleaved, for every odd count', async () => {
    const failures: string[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const outcome = await runPluralIteration(8_000_000 + i);
      pluralOutcomes.push(outcome);
      if (outcome.mismatches > 0) {
        failures.push(`seed ${outcome.seed}: ${outcome.mismatches} mismatches`);
      }
      if (outcome.contractViolations.length > 0) {
        failures.push(
          `seed ${outcome.seed}: ${outcome.contractViolations.join('; ')}`,
        );
      }
    }
    expect(failures.join('\n')).toBe('');
  });
});
