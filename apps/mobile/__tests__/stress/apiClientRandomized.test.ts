/// <reference types="node" />
/**
 * STRESS `mod-api-client` — seeded randomized long-run over the public API of
 * `src/data/api.ts` (createTransport, createAnalysisPermitClient,
 * submitAnalysisFeedback, api.request).
 *
 * Every sequence (5-60 steps) is generated from its seed together with every
 * adversarial server reply — malformed / partial / oversized / non-JSON
 * bodies, 4xx/5xx envelopes with wrong-typed fields, hangs, late and
 * duplicate deliveries, body stalls, network failures, and bearer rotation
 * racing in-flight requests — and executed against the real module. The
 * invariants (I1-I14, documented in `test-support/stress/apiClientRandomized.ts`)
 * are checked after every step.
 *
 * Knobs (all optional):
 *   STRESS_ITER=2500        sequences to run (default keeps the suite fast)
 *   STRESS_SEED_BASE=1      first seed
 *   STRESS_REPLAY_SEEDS=7,9 run only these seeds and dump their full traces
 *   STRESS_OUT_DIR=…        artefact directory (default
 *                           apps/mobile/artifacts/stress/api-client-randomized)
 *
 * Failure policy mirrors `serverResponseMatrix.callSites.test.ts`: violations
 * reproduced on this commit are PINNED below with their finding id. The suite
 * fails on any violation that matches no pin, and each pin has a directed
 * probe that fails once the behaviour is fixed (so the fix retires the pin).
 */
import fs from 'node:fs';
import path from 'node:path';

import { API_REQUEST_TIMEOUT_MS } from '../../src/data/api';
import {
  FLUSH_MS,
  OPS,
  REPLY_KINDS,
  generateSequence,
  matchesClass,
  minimizeFailure,
  runSequence,
  type Call,
  type FailureClass,
  type Op,
  type Reply,
  type ReplyKind,
  type SequenceResult,
  type Step,
  type ViolationRecord,
} from '../../test-support/stress/apiClientRandomized';

const ITER = Math.max(1, Number(process.env.STRESS_ITER ?? 120));
const SEED_BASE = Number(process.env.STRESS_SEED_BASE ?? 1);
const REPLAY_SEEDS = (process.env.STRESS_REPLAY_SEEDS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);
const OUT_DIR =
  process.env.STRESS_OUT_DIR ??
  path.join(
    __dirname,
    '..',
    '..',
    'artifacts',
    'stress',
    'api-client-randomized',
  );
const RUN_ID = `${SEED_BASE}-${ITER}`;
const OUT = path.join(OUT_DIR, RUN_ID);

const SEEDS: number[] = REPLAY_SEEDS.length
  ? REPLAY_SEEDS
  : Array.from({ length: ITER }, (_, i) => SEED_BASE + i);

/** Generous: each sequence costs a few ms of real time; the campaign at
 * STRESS_ITER=2500 fits comfortably. */
const CAMPAIGN_TIMEOUT_MS = 60_000 + SEEDS.length * 250;

// ─── Pins: violations reproduced on 1fb0efd7 ──────────────────────────────

interface Pin {
  id: string;
  finding: string;
  matches: (v: ViolationRecord) => boolean;
}

const UNREADABLE_2XX_OPS = new Set<Op>([
  'syncShots',
  'uploadTrials',
  'feedback',
]);

const KNOWN_VIOLATIONS: readonly Pin[] = [
  {
    id: 'F1',
    finding:
      'data/api.ts:97 clears the abort timer when fetch() resolves, so a body that stalls (response.json() never / late) bypasses API_REQUEST_TIMEOUT_MS — the promise hangs or settles late (also pinned by serverResponseMatrix.callSites.test.ts F1)',
    matches: v =>
      v.violation === 'unbounded_await' && v.replyKind === 'body_stall',
  },
  {
    id: 'F5',
    finding:
      'data/api.ts:113 `return json as T` hands any 2xx body to syncShots/uploadEvaluationTrials unvalidated; api.ts:272 copies a non-boolean reviewEligible through (F5 in serverResponseMatrix.callSites.test.ts covers the transport half)',
    matches: v =>
      v.violation === 'unvalidated_2xx_escape' &&
      v.op !== null &&
      UNREADABLE_2XX_OPS.has(v.op),
  },
  {
    id: 'S1',
    finding:
      'data/api.ts:155 `response.permit` and :272 `response.feedback.reviewEligible` dereference a 2xx body that parsed to null / lacks the key → raw TypeError instead of ApiError(502 access.permit_invalid / typed failure)',
    matches: v =>
      v.violation === 'untyped_error_on_2xx' &&
      (v.op === 'reserve' || v.op === 'feedback'),
  },
  {
    id: 'S2',
    finding:
      'data/api.ts:108-111 copies `error.code` / `error.message` from a non-2xx envelope without a type check: ApiError.code can be a number/object/array (typed string), ApiError.message can be "[object Object]"/"" — and runCaptureAnalysis.ts:336,342 shows ApiError.message to the user verbatim',
    matches: v =>
      (v.violation === 'error_code_not_string' ||
        v.violation === 'error_message_not_string_source' ||
        v.violation === 'error_message_empty') &&
      v.replyKind === 'error_json',
  },
];

function pinFor(v: ViolationRecord): Pin | null {
  return KNOWN_VIOLATIONS.find(p => p.matches(v)) ?? null;
}

// ─── Artefacts ────────────────────────────────────────────────────────────

interface SeedRow {
  seed: number;
  steps: number;
  calls: number;
  outcome: 'HELD' | 'KNOWN' | 'BROKEN';
  digest: string;
  violations: Array<ViolationRecord & { pin: string | null }>;
}

function writeJson(name: string, value: unknown): string {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

const results: SequenceResult[] = [];

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('mod-api-client seeded randomized long-run', () => {
  it('generates only JSON-legal reply bodies (a real server could send every one)', () => {
    let bodies = 0;
    for (const seed of SEEDS.slice(0, 200)) {
      for (const step of generateSequence(seed).steps) {
        if (step.kind === 'rotate') continue;
        const calls = step.kind === 'call' ? [step.call] : step.calls;
        for (const c of calls) {
          // No body is ever handed out for these; nothing to check.
          if (c.reply.jsonRejects || c.reply.fetchError) continue;
          if (c.reply.kind === 'hang' || c.reply.latencyMs === null) continue;
          bodies += 1;
          const text = JSON.stringify(c.reply.body);
          if (text === undefined || JSON.stringify(JSON.parse(text)) !== text) {
            throw new Error(
              `seed ${seed} call ${c.id} (${c.op}/${c.reply.kind}) body is not JSON-legal`,
            );
          }
        }
      }
    }
    expect(bodies).toBeGreaterThan(0);
  });

  it(
    `runs ${SEEDS.length} seeded sequences and holds every invariant not pinned`,
    async () => {
      const rows: SeedRow[] = [];
      const coverage: Record<string, number> = {};
      const violationTally: Record<string, number> = {};
      const unpinned: Array<ViolationRecord & { seed: number }> = [];
      const lengths: number[] = [];
      let calls = 0;
      let callsHeld = 0;
      let stepsExecuted = 0;

      for (const seed of SEEDS) {
        const result = await runSequence(seed);
        results.push(result);
        lengths.push(result.length);
        calls += result.callCount;
        stepsExecuted += result.length;
        for (const entry of result.trace) {
          const stepViolations = result.violations.filter(
            v => v.stepIndex === entry.step,
          );
          const violatingCalls = new Set(stepViolations.map(v => v.callId));
          for (const c of entry.calls) {
            const key = `${c.op}×${c.reply}`;
            coverage[key] = (coverage[key] ?? 0) + 1;
            if (!violatingCalls.has(c.id) && !violatingCalls.has(null))
              callsHeld += 1;
          }
        }
        const annotated = result.violations.map(v => {
          const pin = pinFor(v);
          const key = `${pin?.id ?? 'UNPINNED'}:${v.violation}:${v.op ?? '-'}:${v.replyKind ?? '-'}`;
          violationTally[key] = (violationTally[key] ?? 0) + 1;
          if (!pin) unpinned.push({ ...v, seed });
          return { ...v, pin: pin?.id ?? null };
        });
        rows.push({
          seed,
          steps: result.length,
          calls: result.callCount,
          outcome: annotated.length
            ? annotated.some(v => v.pin === null)
              ? 'BROKEN'
              : 'KNOWN'
            : 'HELD',
          digest: result.traceDigest,
          violations: annotated,
        });
      }

      const cellsCovered = Object.keys(coverage).length;
      const summary = {
        commit: '1fb0efd7f3157060af4c61342f5102e068d2ddc5',
        unit: 'mod-api-client',
        lens: 'randomized-seeded',
        seedBase: SEED_BASE,
        sequences: SEEDS.length,
        stepsExecuted,
        callsExecuted: calls,
        callsHeldAllInvariants: callsHeld,
        sequenceLength: {
          min: Math.min(...lengths),
          max: Math.max(...lengths),
          mean: lengths.reduce((a, b) => a + b, 0) / lengths.length,
        },
        timeoutMs: API_REQUEST_TIMEOUT_MS,
        flushMs: FLUSH_MS,
        outcomes: {
          HELD: rows.filter(r => r.outcome === 'HELD').length,
          KNOWN: rows.filter(r => r.outcome === 'KNOWN').length,
          BROKEN: rows.filter(r => r.outcome === 'BROKEN').length,
        },
        coverageCells: `${cellsCovered}/${OPS.length * REPLY_KINDS.length}`,
        coverage,
        violationTally,
        pins: KNOWN_VIOLATIONS.map(p => ({ id: p.id, finding: p.finding })),
        unpinned,
      };
      writeJson('summary.json', summary);
      writeJson('seeds.json', rows);
      if (REPLAY_SEEDS.length) {
        writeJson(
          'replay-traces.json',
          results.map(r => ({ seed: r.seed, trace: r.trace })),
        );
      }

      expect(unpinned).toEqual([]);
      // Every op × reply-kind cell is reachable; a large campaign covers all.
      if (SEEDS.length >= 1000) {
        expect(cellsCovered).toBe(OPS.length * REPLY_KINDS.length);
      }
    },
    CAMPAIGN_TIMEOUT_MS,
  );

  it(
    'is deterministic: the same seed twice yields an identical trace',
    async () => {
      const stride = Math.max(1, Math.floor(results.length / 250));
      const sample = results.filter((_, i) => i % stride === 0);
      expect(sample.length).toBeGreaterThan(0);
      const table: Array<{
        seed: number;
        first: string;
        second: string;
        identical: boolean;
      }> = [];
      for (const first of sample) {
        const second = await runSequence(first.seed);
        const identical =
          second.traceDigest === first.traceDigest &&
          JSON.stringify(second.trace) === JSON.stringify(first.trace);
        table.push({
          seed: first.seed,
          first: first.traceDigest,
          second: second.traceDigest,
          identical,
        });
      }
      writeJson('determinism.json', table);
      expect(table.filter(t => !t.identical)).toEqual([]);
    },
    CAMPAIGN_TIMEOUT_MS,
  );

  it(
    'minimizes one failing seed per (violation, op, reply) class to a replayable payload',
    async () => {
      const classes = new Map<string, { seed: number; cls: FailureClass }>();
      for (const r of results) {
        for (const v of r.violations) {
          const key = `${v.violation}:${v.op ?? '-'}:${v.replyKind ?? '-'}`;
          if (!classes.has(key)) {
            classes.set(key, {
              seed: r.seed,
              cls: { violation: v.violation, op: v.op, replyKind: v.replyKind },
            });
          }
        }
      }
      const minimized: Array<{
        class: string;
        seed: number;
        pin: string | null;
        originalSteps: number;
        minimizedSteps: number;
        detail: string;
        steps: Step[];
        rerun: { runs: number; reproduced: number };
      }> = [];
      for (const [key, { seed, cls }] of classes) {
        const m = await minimizeFailure(seed, cls);
        // Flake check: the minimized payload must reproduce on every replay.
        let reproduced = 0;
        const runs = 10;
        let sample: ViolationRecord | undefined;
        for (let i = 0; i < runs; i += 1) {
          const r = await runSequence(seed, { steps: m.steps });
          const hit = r.violations.find(v => matchesClass(v, cls));
          if (hit) {
            reproduced += 1;
            sample = hit;
          }
        }
        minimized.push({
          class: key,
          seed,
          pin: sample ? (pinFor(sample)?.id ?? null) : null,
          originalSteps: m.originalSteps,
          minimizedSteps: m.minimizedSteps,
          detail: m.detail,
          steps: m.steps,
          rerun: { runs, reproduced },
        });
      }
      writeJson('minimized.json', minimized);
      for (const m of minimized) {
        expect(
          `${m.class} reproduced ${m.rerun.reproduced}/${m.rerun.runs}`,
        ).toBe(`${m.class} reproduced ${m.rerun.runs}/${m.rerun.runs}`);
      }
    },
    CAMPAIGN_TIMEOUT_MS,
  );
});

// ─── Directed probes: each pin must keep reproducing until fixed ─────────

function reply(kind: ReplyKind, overrides: Partial<Reply>): Reply {
  return {
    kind,
    latencyMs: 50,
    secondDeliveryMs: null,
    status: 200,
    statusText: 'OK',
    body: undefined,
    jsonRejects: false,
    bodyDelayMs: 0,
    fetchError: null,
    bodyValid: false,
    ...overrides,
  };
}

function single(op: Op, arg: unknown, r: Reply): Step[] {
  const call: Call = { id: 0, op, arg, reply: r };
  return [{ kind: 'call', call }];
}

async function probe(steps: Step[]): Promise<ViolationRecord[]> {
  // Seed 1 has a non-null initial token ("token-0"), which every probe needs.
  expect(generateSequence(1).initialToken).toBe('token-0');
  const r = await runSequence(1, { steps });
  for (const v of r.violations) {
    if (!pinFor(v))
      throw new Error(`unpinned violation in probe: ${JSON.stringify(v)}`);
  }
  return r.violations;
}

describe('directed probes (pins retire when the fix lands)', () => {
  it('F1: body stall after headers is never bounded by the client timeout', async () => {
    const v = await probe(
      single(
        'syncShots',
        [],
        reply('body_stall', {
          body: { acceptedIds: [], rejected: [] },
          bodyDelayMs: null,
          bodyValid: true,
        }),
      ),
    );
    expect(v.map(x => x.violation)).toEqual(['unbounded_await']);
  });

  it('F1: a body that lands after the deadline still settles late instead of 408', async () => {
    const v = await probe(
      single(
        'createSession',
        { id: 'sess-1' },
        reply('body_stall', {
          body: {},
          bodyDelayMs: API_REQUEST_TIMEOUT_MS,
          bodyValid: true,
        }),
      ),
    );
    expect(v.map(x => x.violation)).toEqual(['unbounded_await']);
  });

  it('F5: syncShots / uploadEvaluationTrials resolve a shape-invalid 2xx body', async () => {
    const a = await probe(
      single('syncShots', [], reply('ok_non_object', { body: 'ok' })),
    );
    const b = await probe(
      single(
        'uploadTrials',
        [],
        reply('ok_unparseable', { jsonRejects: true }),
      ),
    );
    const c = await probe(
      single(
        'feedback',
        { analysisId: 'a', rating: 'accurate', category: null },
        reply('ok_mutated', { body: { feedback: { reviewEligible: 'yes' } } }),
      ),
    );
    expect(a.map(x => x.violation)).toEqual(['unvalidated_2xx_escape']);
    expect(b.map(x => x.violation)).toEqual(['unvalidated_2xx_escape']);
    expect(c.map(x => x.violation)).toEqual(['unvalidated_2xx_escape']);
  });

  it('S1: reserve / submitAnalysisFeedback throw a raw TypeError on a 2xx null / keyless body', async () => {
    const a = await probe(
      single('reserve', 'idem', reply('ok_unparseable', { jsonRejects: true })),
    );
    const b = await probe(
      single(
        'feedback',
        { analysisId: 'a', rating: 'not_quite', category: 'other' },
        reply('ok_mutated', { body: { ok: true } }),
      ),
    );
    expect(a.map(x => x.violation)).toEqual(['untyped_error_on_2xx']);
    expect(a[0]!.detail).toContain('TypeError');
    expect(b.map(x => x.violation)).toEqual(['untyped_error_on_2xx']);
    expect(b[0]!.detail).toContain('TypeError');
  });

  it('S2: non-string error.code / error.message pass through ApiError unchecked', async () => {
    const a = await probe(
      single(
        'raw',
        { method: 'GET', path: '/v1/me/access', body: undefined },
        reply('error_json', {
          status: 503,
          statusText: 'Error',
          body: { error: { code: 42, message: { nested: 'object' } } },
        }),
      ),
    );
    const b = await probe(
      single(
        'raw',
        { method: 'GET', path: '/v1/me/access', body: undefined },
        reply('error_json', {
          status: 402,
          statusText: 'Error',
          body: { error: { code: 'access.paywall_required', message: '' } },
        }),
      ),
    );
    expect(a.map(x => x.violation).sort()).toEqual(
      ['error_code_not_string', 'error_message_not_string_source'].sort(),
    );
    expect(
      a.find(x => x.violation === 'error_message_not_string_source')!.detail,
    ).toContain('[object Object]');
    expect(b.map(x => x.violation)).toEqual(['error_message_empty']);
  });

  it('HELD: hang → typed 408 exactly at the deadline, timer cleared, late reply ignored', async () => {
    const v = await probe([
      ...single('reserve', 'idem', reply('hang', { latencyMs: null })),
      ...single(
        'syncShots',
        [],
        reply('late', {
          latencyMs: API_REQUEST_TIMEOUT_MS + 1,
          status: 401,
          statusText: 'Unauthorized',
          body: { error: { code: 'auth.invalid_token', message: 'late' } },
        }),
      ),
    ]);
    expect(v).toEqual([]);
  });

  it('HELD: duplicate 401 deliveries report unauthorized exactly once; a rotated bearer is ignored', async () => {
    const dup: Call = {
      id: 0,
      op: 'raw',
      arg: { method: 'GET', path: '/v1/me/rank', body: undefined },
      reply: reply('duplicate', {
        latencyMs: 100,
        secondDeliveryMs: 5_000,
        status: 401,
        statusText: 'Unauthorized',
        body: { error: { code: 'auth.invalid_token', message: 'dup' } },
      }),
    };
    const rotatedAway: Call = {
      id: 1,
      op: 'syncShots',
      arg: [],
      reply: reply('error_json', {
        latencyMs: 3_000,
        status: 401,
        statusText: 'Unauthorized',
        body: { error: { code: 'auth.invalid_token', message: 'stale' } },
      }),
    };
    const v = await probe([
      {
        kind: 'batch',
        calls: [dup, rotatedAway],
        rotateAtMs: 1_000,
        rotation: { token: 'token-1', scope: 'both' },
      },
    ]);
    expect(v).toEqual([]);
  });
});
