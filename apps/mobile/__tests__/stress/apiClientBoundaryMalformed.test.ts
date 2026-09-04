/// <reference types="node" />
/**
 * STRESS `mod-api-client` × lens `boundary-malformed` — src/data/api.ts.
 *
 * Seeded campaign of malformed / truncated / oversized / wrong-typed /
 * prototype-polluting / numerically extreme / NUL-bearing / traversal /
 * future-schema / empty / Unicode-lookalike server responses (plus network
 * errors, exotic statuses and token boundaries) against every exported call
 * surface of the module, judged against the module's contract by an oracle
 * computed from the SCENARIO. Every row is replayable from its seed.
 *
 *   STRESS_ITER=3200 STRESS_SEED=20260904 npx jest --ci __tests__/stress/apiClientBoundaryMalformed.test.ts
 *   STRESS_REPLAY=<seed> npx jest --ci __tests__/stress/apiClientBoundaryMalformed.test.ts
 *
 * Artefacts: artifacts/api-client-stress/<STRESS_RUN_ID>/{rows,summary}.json
 * (git-ignored). Known findings are pinned (`KNOWN_PINS`); the campaign fails
 * only on a violation no pin explains, so a fix that removes a pin shows up
 * as a failing pin test rather than a silently greener campaign.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  API_REQUEST_TIMEOUT_MS,
  ApiError,
  createAnalysisPermitClient,
  createTransport,
} from '../../src/data/api';
import { reportApiUnauthorized } from '../../src/account/apiSession';
import {
  createRng,
  iterationSeed,
  parseSeedEnv,
} from '../../__harness__/apiClientStress/rng';
import {
  KNOWN_PINS,
  STRESS_BASE_URL,
  artifactDir,
  computeOracle,
  installScriptedFetch,
  pinFor,
  runScenario,
  verdictFor,
  writeJson,
  type Row,
  type RunContext,
  type Verdict,
} from '../../__harness__/apiClientStress/run';
import {
  FAMILIES,
  HARNESS_TOKEN,
  HARNESS_UUID,
  SURFACES,
  TRAVERSAL_IDS,
  generateScenario,
  measureString,
  type Scenario,
} from '../../__harness__/apiClientStress/scenarios';

jest.mock('../../src/account/apiSession', () => ({
  reportApiUnauthorized: jest.fn(),
}));

const unauthorizedMock = reportApiUnauthorized as jest.MockedFunction<
  typeof reportApiUnauthorized
>;

const TEST_FILE = '__tests__/stress/apiClientBoundaryMalformed.test.ts';
const DEFAULT_ITERATIONS = 400;
const ITERATIONS = Number(process.env['STRESS_ITER'] ?? DEFAULT_ITERATIONS);
const BASE_SEED = parseSeedEnv(process.env['STRESS_SEED'], 20260904);
const REPLAY_SEED = process.env['STRESS_REPLAY']
  ? parseSeedEnv(process.env['STRESS_REPLAY'], 0)
  : null;
const RUN_ID =
  process.env['STRESS_RUN_ID'] ??
  `${new Date().toISOString().replace(/[:.]/g, '-')}-seed${BASE_SEED}-n${ITERATIONS}`;
const PER_SCENARIO_DEADLINE_MS = 5_000;

function replayCommand(seed: number): string {
  return `cd apps/mobile && STRESS_REPLAY=${seed} npx jest --ci ${TEST_FILE}`;
}

function scenarioForSeed(seed: number): Scenario {
  return generateScenario(createRng(seed), seed);
}

function makeContext(
  fetch: ReturnType<typeof installScriptedFetch>,
): RunContext {
  return {
    fetch,
    unauthorizedReports: () => unauthorizedMock.mock.calls.length,
    resetUnauthorizedReports: () => unauthorizedMock.mockClear(),
    deadlineMs: PER_SCENARIO_DEADLINE_MS,
    replayCommand,
  };
}

interface Summary {
  runId: string;
  testFile: string;
  baseSeed: number;
  iterations: number;
  executed: number;
  durationMs: number;
  verdicts: Record<string, number>;
  byFamily: Record<
    string,
    { rows: number; held: number; known: number; broken: number }
  >;
  bySurface: Record<
    string,
    { rows: number; held: number; known: number; broken: number }
  >;
  violations: Record<string, number>;
  responseImpl: Record<string, number>;
  known: Array<{
    id: string;
    severity: string;
    finding: string;
    rows: number;
    seeds: number[];
  }>;
  broken: Array<{
    seed: number;
    surface: string;
    family: string;
    label: string;
    violations: string[];
    replay: string;
  }>;
  oversized: {
    rows: number;
    maxBytes: number;
    maxCodePoints: number;
    maxGraphemes: number;
  };
  replayExample: string;
}

function summarize(rows: Row[], durationMs: number): Summary {
  const bump = (
    table: Record<
      string,
      { rows: number; held: number; known: number; broken: number }
    >,
    key: string,
    verdict: Verdict,
  ) => {
    const cell = (table[key] ??= { rows: 0, held: 0, known: 0, broken: 0 });
    cell.rows += 1;
    if (verdict === 'HELD') cell.held += 1;
    else if (verdict === 'BROKEN') cell.broken += 1;
    else cell.known += 1;
  };
  const summary: Summary = {
    runId: RUN_ID,
    testFile: TEST_FILE,
    baseSeed: BASE_SEED,
    iterations: ITERATIONS,
    executed: rows.length,
    durationMs,
    verdicts: {},
    byFamily: {},
    bySurface: {},
    violations: {},
    responseImpl: {},
    known: KNOWN_PINS.map(pin => ({
      id: pin.id,
      severity: pin.severity,
      finding: pin.finding,
      rows: 0,
      seeds: [],
    })),
    broken: [],
    oversized: { rows: 0, maxBytes: 0, maxCodePoints: 0, maxGraphemes: 0 },
    replayExample: replayCommand(rows[0]?.seed ?? BASE_SEED),
  };
  for (const row of rows) {
    const verdict = verdictFor(row);
    summary.verdicts[verdict] = (summary.verdicts[verdict] ?? 0) + 1;
    bump(summary.byFamily, row.family, verdict);
    bump(summary.bySurface, row.surface, verdict);
    summary.responseImpl[row.responseImpl] =
      (summary.responseImpl[row.responseImpl] ?? 0) + 1;
    for (const violation of row.violations) {
      summary.violations[violation] = (summary.violations[violation] ?? 0) + 1;
    }
    const pin = pinFor(row);
    if (pin) {
      const entry = summary.known.find(k => k.id === pin.id);
      if (entry) {
        entry.rows += 1;
        if (entry.seeds.length < 12) entry.seeds.push(row.seed);
      }
    }
    if (verdict === 'BROKEN') {
      summary.broken.push({
        seed: row.seed,
        surface: row.surface,
        family: row.family,
        label: row.label,
        violations: row.violations,
        replay: row.replay,
      });
    }
    if (row.oversized) {
      summary.oversized.rows += 1;
      summary.oversized.maxBytes = Math.max(
        summary.oversized.maxBytes,
        row.oversized.bytes,
      );
      summary.oversized.maxCodePoints = Math.max(
        summary.oversized.maxCodePoints,
        row.oversized.codePoints,
      );
      summary.oversized.maxGraphemes = Math.max(
        summary.oversized.maxGraphemes,
        row.oversized.graphemes ?? 0,
      );
    }
  }
  return summary;
}

describe('api.ts boundary/malformed stress campaign', () => {
  let fetch: ReturnType<typeof installScriptedFetch>;
  let context: RunContext;

  beforeAll(() => {
    fetch = installScriptedFetch();
    context = makeContext(fetch);
  });
  afterAll(() => {
    fetch.uninstall();
  });

  (REPLAY_SEED === null ? it.skip : it)(
    `replays STRESS_REPLAY=${REPLAY_SEED ?? '<seed>'}`,
    async () => {
      const seed = REPLAY_SEED as number;
      const row = await runScenario(0, scenarioForSeed(seed), context);
      const dir = artifactDir(`${RUN_ID}-replay-${seed}`);
      const file = writeJson(dir, 'row.json', {
        row,
        verdict: verdictFor(row),
      });
      console.log(
        `[api-client-stress] replay ${seed} → ${verdictFor(row)} ${file}\n${JSON.stringify(row, null, 2)}`,
      );
      expect(verdictFor(row)).not.toBe('BROKEN');
    },
  );

  (REPLAY_SEED === null ? it : it.skip)(
    `runs ${ITERATIONS} seeded scenarios (STRESS_ITER) with no unexplained violation`,
    async () => {
      const rows: Row[] = [];
      const started = Date.now();
      const familiesSeen = new Set<string>();
      const surfacesSeen = new Set<string>();
      for (let index = 0; index < ITERATIONS; index += 1) {
        const seed = iterationSeed(BASE_SEED, index);
        const scenario = scenarioForSeed(seed);
        const row = await runScenario(index, scenario, context);
        familiesSeen.add(row.family);
        surfacesSeen.add(row.surface);
        rows.push(row);
      }
      const durationMs = Date.now() - started;
      const summary = summarize(rows, durationMs);
      const dir = artifactDir(RUN_ID);
      writeJson(dir, 'rows.json', rows);
      const summaryFile = writeJson(dir, 'summary.json', summary);
      console.log(
        `[api-client-stress] ${rows.length} rows in ${durationMs}ms → ${JSON.stringify(summary.verdicts)} violations=${JSON.stringify(summary.violations)} artefacts=${path.dirname(summaryFile)}`,
      );

      expect(rows).toHaveLength(ITERATIONS);
      expect(rows.filter(r => r.settlement === 'hung')).toEqual([]);
      expect(summary.broken).toEqual([]);
      if (ITERATIONS >= 1_000) {
        // A full-size campaign must touch every family and surface.
        expect([...familiesSeen].sort()).toEqual([...FAMILIES].sort());
        expect([...surfacesSeen].sort()).toEqual([...SURFACES].sort());
      }
      expect(fs.existsSync(summaryFile)).toBe(true);
    },
    10 * 60_000,
  );
});

// ── Deterministic pins for each known finding (minimised payloads) ────────

describe('api.ts boundary/malformed known-finding pins', () => {
  let fetch: ReturnType<typeof installScriptedFetch>;
  let context: RunContext;

  beforeAll(() => {
    fetch = installScriptedFetch();
    context = makeContext(fetch);
  });
  afterAll(() => {
    fetch.uninstall();
  });

  const scenario = (
    overrides: Partial<Scenario> & Pick<Scenario, 'surface' | 'label'>,
  ): Scenario => ({
    seed: 0,
    family: 'wrong_type',
    status: 200,
    statusText: '',
    body: { kind: 'text', text: '{}' },
    token: HARNESS_TOKEN,
    pathId: HARNESS_UUID,
    oversized: null,
    deepNesting: false,
    ...overrides,
  });

  const expectPin = async (s: Scenario, pinId: string) => {
    const row = await runScenario(0, s, context);
    expect({
      label: s.label,
      verdict: verdictFor(row),
      violations: row.violations,
      notes: row.notes,
    }).toEqual(expect.objectContaining({ verdict: `KNOWN:${pinId}` }));
    return row;
  };

  it.each([
    ['null', 'null'],
    ['empty object', '{}'],
    ['string', '"ok"'],
    ['array', '[]'],
    ['acceptedIds wrong type', '{"acceptedIds":"x","rejected":[]}'],
    ['truncated JSON', '{"acceptedIds":['],
  ])(
    'K-F5: syncShots resolves an unvalidated 2xx body (%s)',
    async (_name, text) => {
      const row = await expectPin(
        scenario({
          surface: 'transport.syncShots',
          label: `syncShots 2xx ${text}`,
          body: { kind: 'text', text },
        }),
        'K-F5',
      );
      expect(row.settlement).toBe('resolved');
    },
  );

  it('K-F5: submitAnalysisFeedback throws a bare TypeError on a 2xx without `feedback`', async () => {
    const row = await expectPin(
      scenario({
        surface: 'submitAnalysisFeedback',
        label: 'feedback 2xx {}',
        body: { kind: 'text', text: '{}' },
      }),
      'K-F5',
    );
    expect(row.settlement).toBe('rejected');
    expect(row.error?.class).toBe('TypeError');
  });

  /** Ids whose raw interpolation reaches a different path/query/fragment than
   * the encoded form (the URL parser percent-encodes spaces, NUL and non-ASCII
   * identically to encodeURIComponent, so those stay HELD). */
  const rawInterpolationDiffers = (id: string) => {
    const raw = new URL(`${STRESS_BASE_URL}/v1/sessions/${id}/finalize`);
    return (
      raw.pathname !== `/v1/sessions/${encodeURIComponent(id)}/finalize` ||
      raw.search !== '' ||
      raw.hash !== ''
    );
  };
  const DOT_SEGMENTS = ['.', '..'];

  it.each(TRAVERSAL_IDS.filter(rawInterpolationDiffers))(
    'K-PATH: finalizeSession(%j) interpolates the id into the path unencoded',
    async id => {
      const row = await expectPin(
        scenario({
          surface: 'transport.finalizeSession',
          family: 'path_traversal_id',
          label: `finalizeSession ${JSON.stringify(id)}`,
          pathId: id,
        }),
        'K-PATH',
      );
      expect(row.requestUrl).toBe(
        `${STRESS_BASE_URL}/v1/sessions/${id}/finalize`.slice(0, 240),
      );
    },
  );

  it.each(TRAVERSAL_IDS.filter(id => !rawInterpolationDiffers(id)))(
    'HELD: finalizeSession(%j) — URL parser encodes it identically',
    async id => {
      const row = await runScenario(
        0,
        scenario({
          surface: 'transport.finalizeSession',
          family: 'path_traversal_id',
          label: `finalizeSession ${JSON.stringify(id)}`,
          pathId: id,
        }),
        context,
      );
      expect({
        id,
        verdict: verdictFor(row),
        violations: row.violations,
      }).toEqual(expect.objectContaining({ verdict: 'HELD' }));
    },
  );

  it.each(TRAVERSAL_IDS.filter(id => !DOT_SEGMENTS.includes(id)))(
    'HELD: release(%j) and submitAnalysisFeedback() encode the id',
    async id => {
      for (const surface of [
        'permit.release',
        'submitAnalysisFeedback',
      ] as const) {
        const row = await runScenario(
          0,
          scenario({
            surface,
            family: 'path_traversal_id',
            label: `${surface} ${JSON.stringify(id)}`,
            pathId: id,
            body: {
              kind: 'text',
              text: '{"feedback":{"reviewEligible":true}}',
            },
          }),
          context,
        );
        expect({
          surface,
          id,
          verdict: verdictFor(row),
          violations: row.violations,
        }).toEqual(expect.objectContaining({ verdict: 'HELD' }));
        expect(row.requestPathname).toBe(
          surface === 'permit.release'
            ? `/v1/analysis-permits/${encodeURIComponent(id)}/finalize`
            : `/v1/analyses/${encodeURIComponent(id)}/feedback`,
        );
      }
    },
  );

  it.each(DOT_SEGMENTS)(
    'K-DOTSEG: encodeURIComponent leaves the dot-segment id %j intact, so the request leaves the permit/analysis resource',
    async id => {
      const release = await expectPin(
        scenario({
          surface: 'permit.release',
          family: 'path_traversal_id',
          label: `release ${id}`,
          pathId: id,
        }),
        'K-DOTSEG',
      );
      expect(release.requestPathname).toBe(
        id === '.' ? '/v1/analysis-permits/finalize' : '/v1/finalize',
      );
      const feedback = await expectPin(
        scenario({
          surface: 'submitAnalysisFeedback',
          family: 'path_traversal_id',
          label: `feedback ${id}`,
          pathId: id,
          body: { kind: 'text', text: '{"feedback":{"reviewEligible":true}}' },
        }),
        'K-DOTSEG',
      );
      expect(feedback.requestPathname).toBe(
        id === '.' ? '/v1/analyses/feedback' : '/v1/feedback',
      );
    },
  );

  it.each([
    ['empty body', ''],
    ['whitespace body', ' \n'],
    ['JSON null literal', 'null'],
    ['truncated JSON', '{"permit":{"id":'],
    ['UTF-8 BOM only', '\ufeff'],
    ['HTML', '<html>ok</html>'],
  ])(
    'K-NULL2XX: reserve() throws a bare TypeError on an unparsable 2xx body (%s)',
    async (_name, text) => {
      const row = await expectPin(
        scenario({
          surface: 'permit.reserve',
          family: 'malformed_json',
          label: `reserve 2xx ${JSON.stringify(text)}`,
          body: { kind: 'text', text },
        }),
        'K-NULL2XX',
      );
      expect(row.error).toEqual(
        expect.objectContaining({ class: 'TypeError', status: null }),
      );
      expect(row.error?.messagePreview).toContain(
        "Cannot read properties of null (reading 'permit')",
      );
    },
  );

  it.each([
    ['number', '42'],
    ['object', '{"a":1}'],
    ['array', '["auth.required"]'],
    ['boolean', 'true'],
    ['-0', '-0'],
    ['overflow', '1e999'],
  ])(
    'K-CODE: a non-string error.code (%s) lands in ApiError.code',
    async (_name, literal) => {
      const row = await expectPin(
        scenario({
          surface: 'permit.reserve',
          family: 'error_envelope',
          label: `error.code=${literal}`,
          status: 403,
          body: {
            kind: 'text',
            text: `{"error":{"code":${literal},"message":"m"}}`,
          },
        }),
        'K-CODE',
      );
      expect(row.error?.class).toBe('ApiError');
      expect(row.error?.codeType).not.toBe('string');
    },
  );

  it.each([
    [
      '64 KiB ascii message',
      `{"error":{"code":"c","message":${JSON.stringify('a'.repeat(65_536))}}}`,
    ],
    [
      '1 MiB ascii message',
      `{"error":{"code":"c","message":${JSON.stringify('a'.repeat(1_048_576))}}}`,
    ],
    [
      'NUL in message',
      '{"error":{"code":"c","message":"Sign in\\u0000again"}}',
    ],
    [
      'ANSI escape in message',
      '{"error":{"code":"c","message":"\\u001b[31mred\\u001b[0m"}}',
    ],
    [
      '64 KiB code',
      `{"error":{"code":${JSON.stringify('c'.repeat(65_536))},"message":"m"}}`,
    ],
  ])(
    'K-TEXT: server error text is copied into ApiError with no cap (%s)',
    async (_name, text) => {
      const row = await expectPin(
        scenario({
          surface: 'permit.reserve',
          family: 'oversized_string',
          label: 'unbounded error text',
          status: 402,
          body: { kind: 'text', text },
        }),
        'K-TEXT',
      );
      expect(row.error?.class).toBe('ApiError');
      expect(row.error?.status).toBe(402);
    },
  );

  it('measures 64 KiB boundaries in bytes, code points and graphemes independently', () => {
    expect(measureString('a'.repeat(65_536))).toEqual({
      bytes: 65_536,
      codePoints: 65_536,
      utf16Units: 65_536,
      graphemes: 65_536,
    });
    const emoji = measureString('😀'.repeat(65_536));
    expect(emoji).toEqual({
      bytes: 262_144,
      codePoints: 65_536,
      utf16Units: 131_072,
      graphemes: 65_536,
    });
    const family = measureString('👨‍👩‍👧‍👦'.repeat(1_024));
    expect(family.graphemes).toBe(1_024);
    expect(family.codePoints).toBe(7 * 1_024);
    expect(family.bytes).toBe(25 * 1_024);
  });
});

// ── Invariants that must HOLD (each a named regression guard) ─────────────

describe('api.ts boundary/malformed invariants that hold', () => {
  let fetch: ReturnType<typeof installScriptedFetch>;
  let context: RunContext;

  beforeAll(() => {
    fetch = installScriptedFetch();
    context = makeContext(fetch);
  });
  afterAll(() => {
    fetch.uninstall();
  });

  const reserve = (text: string, status = 200): Scenario => ({
    seed: 0,
    surface: 'permit.reserve',
    family: 'wrong_type',
    label: text.slice(0, 80),
    status,
    statusText: '',
    body: { kind: 'text', text },
    token: HARNESS_TOKEN,
    pathId: HARNESS_UUID,
    oversized: null,
    deepNesting: false,
  });

  it.each([
    '{"__proto__":{"polluted":"__api_stress_polluted__"},"permit":{"id":"p","accessSource":"free","status":"reserved","expiresAt":"x"}}',
    '{"permit":{"__proto__":{"polluted":"__api_stress_polluted__"},"id":"p","accessSource":"free","status":"reserved","expiresAt":"x"}}',
    '{"permit":{"constructor":{"prototype":{"polluted":1}},"id":"p","accessSource":"free","status":"reserved","expiresAt":"x"},"access":{"premium":false,"freeRatings":{"__proto__":{"polluted":1},"limit":2,"used":0,"reserved":1,"remaining":2,"availableToReserve":1}}}',
    '{"permit":{"__proto__":null,"id":"p","accessSource":"free","status":"reserved","expiresAt":"x"}}',
  ])(
    'prototype-pollution keys never reach Object.prototype and never leak into the permit: %s',
    async text => {
      const row = await runScenario(0, reserve(text), context);
      expect({
        verdict: verdictFor(row),
        violations: row.violations,
        resolved: row.resolvedPreview,
      }).toEqual(expect.objectContaining({ verdict: 'HELD' }));
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
      expect(row.resolvedPreview).toContain(
        '"permit":{"id":"p","accessSource":"free","status":"reserved","expiresAt":"x"}',
      );
    },
  );

  it.each([
    ['NaN via 1e999-1e999 is not JSON; Infinity via 1e999', '1e999', null],
    ['negative overflow', '-1e999', null],
    ['-0', '-0', 'accepted'],
    ['half rating', '0.5', 'accepted'],
    ['negative', '-1', 'accepted'],
    ['beyond 2^53', '9007199254740993', 'accepted'],
  ])(
    'numeric edge in freeRatings (%s): non-finite → access null, finite → passed through',
    async (_n, literal, accepted) => {
      const text = `{"permit":{"id":"p","accessSource":"free","status":"reserved","expiresAt":"x"},"access":{"premium":false,"freeRatings":{"limit":2,"used":0,"reserved":1,"remaining":2,"availableToReserve":${literal}}}}`;
      const row = await runScenario(0, reserve(text), context);
      expect(verdictFor(row)).toBe('HELD');
      if (accepted === null)
        expect(row.resolvedPreview).toContain('"access":null');
      else expect(row.notes.join(' ')).toContain('semantically odd');
    },
  );

  it.each([
    ['fullwidth free', 'ｆｒｅｅ'],
    ['zero-width space', 'free\u200b'],
    ['NBSP', 'free\u00a0'],
    ['upper', 'FREE'],
    ['NUL', 'free\u0000'],
    ['NFD accent', 'fre\u0301e'],
  ])(
    'accessSource lookalike (%s) is rejected as an invalid permit (502)',
    async (_n, source) => {
      const text = JSON.stringify({
        permit: {
          id: 'p',
          accessSource: source,
          status: 'reserved',
          expiresAt: 'x',
        },
      });
      const row = await runScenario(0, reserve(text), context);
      expect(verdictFor(row)).toBe('HELD');
      expect(row.error).toEqual(
        expect.objectContaining({
          class: 'ApiError',
          status: 502,
          codePreview: 'access.permit_invalid',
        }),
      );
    },
  );

  it.each([
    ['fullwidth', 'ｒｅｓｅｒｖｅｄ'],
    ['BOM suffix', 'reserved\ufeff'],
    ['NFD', 'reserve\u0301d'],
    ['future v2', 'reserved_v2'],
    ['consumed', 'consumed'],
    ['number', 1],
    ['null', null],
    ['object', { state: 'reserved' }],
  ])(
    'permit.status lookalike/future value (%s) → 409 access.permit_not_reserved',
    async (_n, status) => {
      const text = JSON.stringify({
        permit: { id: 'p', accessSource: 'free', status, expiresAt: 'x' },
      });
      const row = await runScenario(0, reserve(text), context);
      expect(verdictFor(row)).toBe('HELD');
      expect(row.error).toEqual(
        expect.objectContaining({ class: 'ApiError', status: 409 }),
      );
    },
  );

  it('a future schema with extra fields resolves only the four documented permit keys', async () => {
    const text = JSON.stringify({
      schemaVersion: 3,
      permit: {
        id: 'p',
        accessSource: 'premium',
        status: 'reserved',
        expiresAt: 'x',
        ttlMs: 1,
        scopes: ['rate'],
      },
      access: {
        premium: true,
        plan: 'pro',
        freeRatings: {
          limit: 2,
          used: 0,
          reserved: 1,
          remaining: 2,
          availableToReserve: 1,
          rollover: 9,
        },
      },
    });
    const row = await runScenario(0, reserve(text), context);
    expect(verdictFor(row)).toBe('HELD');
    expect(row.resolvedPreview).toBe(
      '{"permit":{"id":"p","accessSource":"premium","status":"reserved","expiresAt":"x"},"access":{"premium":true,"freeRatings":{"limit":2,"used":0,"reserved":1,"remaining":2,"availableToReserve":1}}}',
    );
  });

  it.each([
    '{}',
    '[]',
    '"ok"',
    '0',
    'true',
    '{"":""}',
    '{"permit":{}}',
    '{"permit":[]}',
    '{"permit":null}',
    '{"permits":[{"id":"p"}]}',
    '{"data":{"permit":{"id":"p","accessSource":"free","status":"reserved","expiresAt":"x"}}}',
  ])(
    'empty/renamed containers on a 2xx reserve → 502 access.permit_invalid (%j)',
    async text => {
      const row = await runScenario(0, reserve(text), context);
      expect(verdictFor(row)).toBe('HELD');
      expect(row.error).toEqual(
        expect.objectContaining({
          class: 'ApiError',
          status: 502,
          codePreview: 'access.permit_invalid',
        }),
      );
    },
  );

  it.each([100, 199, 300, 304, 399, 0, 600, 999, -1])(
    'exotic HTTP status %i is a typed ApiError carrying that status',
    async status => {
      const row = await runScenario(
        0,
        reserve('{"error":{"code":"x","message":"y"}}', status),
        context,
      );
      expect(verdictFor(row)).toBe('HELD');
      expect(row.error).toEqual(
        expect.objectContaining({ class: 'ApiError', status }),
      );
    },
  );

  it.each([null, '', ' ', '\t\n'])(
    'blank token %j → 401 auth.required before any network request',
    async token => {
      const row = await runScenario(
        0,
        { ...reserve('{"permit":{}}'), token, family: 'token_boundary' },
        context,
      );
      expect(verdictFor(row)).toBe('HELD');
      expect(row.requestCount).toBe(0);
      expect(row.error).toEqual(
        expect.objectContaining({ status: 401, codePreview: 'auth.required' }),
      );
      expect(unauthorizedMock).not.toHaveBeenCalled();
    },
  );

  it('a 401 with a bearer reports unauthorized exactly once; without a bearer never', async () => {
    const withToken = await runScenario(
      0,
      {
        ...reserve('{"error":{"code":"auth.required","message":"m"}}', 401),
        surface: 'transport.syncShots',
      },
      context,
    );
    expect(verdictFor(withToken)).toBe('HELD');
    expect(withToken.unauthorizedReports).toBe(1);
    const noToken = await runScenario(
      0,
      {
        ...reserve('{"error":{"code":"auth.required","message":"m"}}', 401),
        surface: 'transport.syncShots',
        token: null,
      },
      context,
    );
    expect(verdictFor(noToken)).toBe('HELD');
    expect(noToken.unauthorizedReports).toBe(0);
  });

  it('network-layer rejections are rethrown untouched (no rewrap into ApiError)', async () => {
    const error = new TypeError('fetch failed');
    const row = await runScenario(
      0,
      {
        ...reserve(''),
        family: 'network_error',
        body: { kind: 'reject', error, label: 'fetch failed' },
      },
      context,
    );
    expect(verdictFor(row)).toBe('HELD');
    expect(row.error?.class).toBe('TypeError');
  });
});

// ── Duplicate responses ────────────────────────────────────────────────────

describe('api.ts duplicate responses', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    unauthorizedMock.mockClear();
  });

  const permitBody = JSON.stringify({
    permit: {
      id: 'dup-permit',
      accessSource: 'free',
      status: 'reserved',
      expiresAt: 'x',
    },
    access: {
      premium: false,
      freeRatings: {
        limit: 2,
        used: 0,
        reserved: 1,
        remaining: 2,
        availableToReserve: 1,
      },
    },
  });

  it('N concurrent reserves with one idempotency key that all receive the identical body resolve to equal, unshared objects', async () => {
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response(permitBody, { status: 200 }),
      );
    const client = createAnalysisPermitClient({
      baseUrl: STRESS_BASE_URL,
      token: HARNESS_TOKEN,
    });
    const results = await Promise.all(
      seeds.map(() => client.reserve('same-key')),
    );
    for (const result of results) {
      expect(result.permit).toEqual({
        id: 'dup-permit',
        accessSource: 'free',
        status: 'reserved',
        expiresAt: 'x',
      });
    }
    const [first, second] = results;
    expect(first).not.toBe(second);
    if (first && second) {
      first.permit.id = 'mutated';
      expect(second.permit.id).toBe('dup-permit');
    }
  });

  it('a duplicated 401 reports unauthorized once per response, never more', async () => {
    const unauthorized = '{"error":{"code":"auth.required","message":"m"}}';
    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response(unauthorized, { status: 401 }),
      );
    const transport = createTransport({
      baseUrl: STRESS_BASE_URL,
      token: HARNESS_TOKEN,
    });
    const outcomes = await Promise.allSettled(
      [1, 2, 3].map(() => transport.syncShots([])),
    );
    expect(
      outcomes.every(
        o =>
          o.status === 'rejected' &&
          o.reason instanceof ApiError &&
          o.reason.status === 401,
      ),
    ).toBe(true);
    expect(unauthorizedMock).toHaveBeenCalledTimes(3);
  });

  it('KNOWN K-NULL2XX: a Response whose body was already consumed (duplicate Response object) surfaces as a bare TypeError, not the typed 502', async () => {
    const shared = new Response(permitBody, { status: 200 });
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => shared);
    const client = createAnalysisPermitClient({
      baseUrl: STRESS_BASE_URL,
      token: HARNESS_TOKEN,
    });
    await expect(client.reserve('k1')).resolves.toEqual(
      expect.objectContaining({
        permit: expect.objectContaining({ id: 'dup-permit' }),
      }),
    );
    const second = await client.reserve('k2').then(
      () => 'resolved',
      (error: unknown) => error,
    );
    expect(second).toBeInstanceOf(TypeError);
    expect(second).not.toBeInstanceOf(ApiError);
  });
});

// ── Timeouts (fake clock) ──────────────────────────────────────────────────

describe('api.ts timeouts', () => {
  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
    });
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const hangUntilAbort = () =>
    jest.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(
              new DOMException('The operation was aborted.', 'AbortError'),
            ),
          );
        }),
    );

  it(`a server that never sends headers is a typed 408 network.timeout at exactly ${API_REQUEST_TIMEOUT_MS}ms`, async () => {
    hangUntilAbort();
    const client = createAnalysisPermitClient({
      baseUrl: STRESS_BASE_URL,
      token: HARNESS_TOKEN,
    });
    let settled: unknown = 'pending';
    const promise = client.reserve('k').then(
      v => (settled = v),
      (e: unknown) => (settled = e),
    );
    await jest.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS - 1);
    expect(settled).toBe('pending');
    await jest.advanceTimersByTimeAsync(1);
    await promise;
    expect(settled).toBeInstanceOf(ApiError);
    expect(settled).toMatchObject({ status: 408, code: 'network.timeout' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('every transport surface maps the pre-header hang to the same 408', async () => {
    hangUntilAbort();
    const transport = createTransport({
      baseUrl: STRESS_BASE_URL,
      token: HARNESS_TOKEN,
    });
    const calls = [
      transport.syncShots([]),
      transport.createSession({}),
      transport.finalizeSession(HARNESS_UUID),
      transport.uploadEvaluationTrials?.([]) ??
        Promise.reject(new Error('missing')),
    ];
    const settled = Promise.allSettled(calls);
    await jest.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS);
    const outcomes = await settled;
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected')
        expect(outcome.reason).toMatchObject({
          status: 408,
          code: 'network.timeout',
        });
    }
  });

  it('KNOWN F1: headers-then-body-stall is never timed out (timer cleared before response.json())', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          // RN's fetch typings predate streaming bodies; Node's Response takes one.
          new ReadableStream<Uint8Array>({ start() {} }) as unknown as string,
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const client = createAnalysisPermitClient({
      baseUrl: STRESS_BASE_URL,
      token: HARNESS_TOKEN,
    });
    let settled: unknown = 'pending';
    void client.reserve('k').then(
      v => (settled = v),
      (e: unknown) => (settled = e),
    );
    await jest.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS * 2);
    await jest.advanceTimersByTimeAsync(24 * 60 * 60_000);
    // Pinned so a fix (e.g. racing response.json() against the same timer)
    // flips this test rather than silently changing behaviour.
    expect(settled).toBe('pending');
    expect(jest.getTimerCount()).toBe(0);
  });
});

// ── Oracle self-check (the judge must not be trivially satisfiable) ────────

describe('api.ts stress oracle self-check', () => {
  it('derives different expectations for valid, invalid and non-2xx bodies', () => {
    const base: Scenario = {
      seed: 0,
      surface: 'permit.reserve',
      family: 'wrong_type',
      label: 'self-check',
      status: 200,
      statusText: 'Reason',
      body: {
        kind: 'text',
        text: '{"permit":{"id":"p","accessSource":"free","status":"reserved","expiresAt":"x"}}',
      },
      token: HARNESS_TOKEN,
      pathId: HARNESS_UUID,
      oversized: null,
      deepNesting: false,
    };
    expect(computeOracle(base).kind).toBe('resolve');
    expect(
      computeOracle({ ...base, body: { kind: 'text', text: '{"permit":{}}' } }),
    ).toMatchObject({ kind: 'reject_api_error', status: 502 });
    expect(
      computeOracle({
        ...base,
        status: 429,
        body: { kind: 'text', text: 'not json' },
      }),
    ).toMatchObject({
      kind: 'reject_api_error',
      status: 429,
      code: 'unknown',
      message: 'Reason',
    });
    expect(computeOracle({ ...base, token: ' ' })).toMatchObject({
      kind: 'reject_auth_required',
    });
    expect(
      computeOracle({
        ...base,
        body: { kind: 'reject', error: new TypeError('x'), label: 'x' },
      }).kind,
    ).toBe('rethrow_network_error');
    expect(
      computeOracle({
        ...base,
        body: {
          kind: 'bytes',
          bytes: Buffer.from([
            0xef,
            0xbb,
            0xbf,
            ...Buffer.from(
              '{"permit":{"id":"p","accessSource":"free","status":"reserved","expiresAt":"x"}}',
            ),
          ]),
        },
      }).kind,
    ).toBe('resolve');
  });
});
