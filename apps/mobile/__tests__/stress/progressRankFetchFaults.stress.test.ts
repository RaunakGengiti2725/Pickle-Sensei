/**
 * STRESS / failure-injection — `fetchPlayerRank` + `parsePlayerRank` +
 * `resolvePlayerRank` (src/progress/playerRank.ts) against a hostile
 * `/v1/rank` transport.
 *
 * Every seed builds a VALID server payload, then injects one to three faults
 * drawn from the transport catalog (throw / reject / HTTP status / invalid
 * JSON / slow / never-resolves) and the payload catalog (missing, null,
 * empty-string, boolean, array, object, numeric-string, out-of-range, ±0,
 * huge, sub-normal values in every field, including technique rows).
 *
 * Oracle (the contract the components rely on):
 *   O1 the call settles: null, a rank, or a rejection — never a hang, unless
 *      the fault itself is "never resolves" (then it must still be pending
 *      after 60s of fake time and nothing else may have happened);
 *   O2 a rejection is a `PlayerRankApiError` (components catch anything, but
 *      the module promises this type);
 *   O3 a returned rank is fully validated: `rating` finite in [0,10],
 *      `techniqueCount` finite, every technique row has a string shot type,
 *      finite score and string timestamp, and NO field was silently coerced
 *      from a non-numeric JSON value (null / '' / boolean / array / object);
 *   O4 the documented `scoredShotCount: null` (server inline fallback)
 *      survives parsing as null, so `resolvePlayerRank` can weigh evidence;
 *   O5 `resolvePlayerRank(localFacts, rank)` never throws and never yields a
 *      summary with a non-finite number or a tier that disagrees with the
 *      rating band (unknown server tiers re-derive from the rating).
 *
 * Numeric strings ("7.5") are accepted leniently by design of `Number()`;
 * they are recorded as `lenient` in the table but do not fail O3.
 */
import type { ApiSession } from '../../src/account/apiSession';
import type { PlayerRankFactLike } from '../../src/progress/playerRank';
import {
  fetchPlayerRank,
  PlayerRankApiError,
  resolvePlayerRank,
  type PlayerRankFetch,
  type ServerPlayerRank,
} from '../../src/progress/playerRank';
import {
  PLAYER_RANK_TIERS,
  playerRankTierForRating,
} from '@pickle/shared-types';
import {
  chance,
  fail,
  int,
  mulberry32,
  nonFinitePaths,
  pick,
  planCampaign,
  shuffled,
  StressTable,
  type Rng,
} from '../../test-support/stress/seededStress';

const CAMPAIGN = 'progressRankFetchFaults';
const plan = planCampaign(CAMPAIGN, 11_000, 60);
const table = new StressTable(CAMPAIGN, plan);

const SESSION: ApiSession = {
  apiBaseUrl: 'https://api.stress.test',
  bearerToken: 'stress-bearer',
  canonicalAppUserId: 'aaaaaaaa-0000-4000-8000-00000000c0de',
  provider: 'apple',
};

const SHOT_TYPES = [
  'dink',
  'volley',
  'third_shot_drop',
  'serve',
  'return',
  'forehand_drive',
  'backhand_drive',
  'overhead',
];

// ─── Valid payload generator ───────────────────────────────────────────────

interface TechniqueRow {
  shot_type: unknown;
  score: unknown;
  captured_at: unknown;
  sampled_count?: unknown;
}

interface RankPayload {
  rating: unknown;
  tier: unknown;
  techniqueCount: unknown;
  scoredShotCount: unknown;
  updatedAt: unknown;
  techniques: unknown;
}

function twoDecimals(rng: Rng, lo: number, hi: number): number {
  return Math.round((lo + rng() * (hi - lo)) * 100) / 100;
}

function isoDaysAgo(rng: Rng): string {
  const ms = Date.UTC(2026, 8, 1) - int(rng, 0, 400) * 86_400_000;
  return new Date(ms).toISOString();
}

function validPayload(rng: Rng): { rank: RankPayload } {
  const rowCount = int(rng, 0, 5);
  const techniques: TechniqueRow[] = [];
  for (let i = 0; i < rowCount; i += 1) {
    techniques.push({
      shot_type: SHOT_TYPES[i % SHOT_TYPES.length]!,
      score: twoDecimals(rng, 0, 10),
      captured_at: isoDaysAgo(rng),
      ...(chance(rng, 0.7) ? { sampled_count: int(rng, 1, 8) } : {}),
    });
  }
  const rating = twoDecimals(rng, 0, 10);
  return {
    rank: {
      rating,
      tier: chance(rng, 0.85)
        ? playerRankTierForRating(rating).key
        : pick(rng, ['mythic', 'legend', '']),
      techniqueCount: techniques.length,
      // Documented contract: null when the server fell back to inline compute.
      scoredShotCount: chance(rng, 0.3) ? null : int(rng, rowCount, 200),
      updatedAt: chance(rng, 0.3) ? null : isoDaysAgo(rng),
      techniques,
    },
  };
}

// ─── Payload fault catalog ─────────────────────────────────────────────────

type ValueFault =
  | 'missing'
  | 'null'
  | 'empty-string'
  | 'blank-string'
  | 'word-string'
  | 'numeric-string'
  | 'true'
  | 'false'
  | 'empty-array'
  | 'empty-object'
  | 'negative'
  | 'over-ten'
  | 'huge'
  | 'negative-huge'
  | 'subnormal'
  | 'negative-zero'
  | 'fractional-count';

const VALUE_FAULTS: readonly ValueFault[] = [
  'missing',
  'null',
  'empty-string',
  'blank-string',
  'word-string',
  'numeric-string',
  'true',
  'false',
  'empty-array',
  'empty-object',
  'negative',
  'over-ten',
  'huge',
  'negative-huge',
  'subnormal',
  'negative-zero',
  'fractional-count',
];

/** JSON-representable replacement for a field under `fault`. */
function faultedValue(fault: ValueFault, rng: Rng): unknown {
  switch (fault) {
    case 'missing':
      return undefined;
    case 'null':
      return null;
    case 'empty-string':
      return '';
    case 'blank-string':
      return '   ';
    case 'word-string':
      return pick(rng, ['abc', 'NaN', 'Infinity', '7.5abc', '0x1f']);
    case 'numeric-string':
      return String(twoDecimals(rng, 0, 10));
    case 'true':
      return true;
    case 'false':
      return false;
    case 'empty-array':
      return [];
    case 'empty-object':
      return {};
    case 'negative':
      return -twoDecimals(rng, 0.01, 10);
    case 'over-ten':
      return 10 + twoDecimals(rng, 0.01, 10);
    case 'huge':
      return pick(rng, [1e308, Number.MAX_SAFE_INTEGER + 2, 1e21]);
    case 'negative-huge':
      return pick(rng, [-1e308, -(Number.MAX_SAFE_INTEGER + 2)]);
    case 'subnormal':
      return 5e-324;
    case 'negative-zero':
      return -0;
    case 'fractional-count':
      return twoDecimals(rng, 0.01, 0.99);
  }
}

/** Whether `Number(value)` would coerce this JSON value to a finite number
 * even though it is not numeric — the silent coercions the oracle forbids. */
function coercesSilently(value: unknown): boolean {
  if (value === null || value === '' || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

type TargetField =
  | 'rank.rating'
  | 'rank.tier'
  | 'rank.techniqueCount'
  | 'rank.scoredShotCount'
  | 'rank.updatedAt'
  | 'row.shot_type'
  | 'row.score'
  | 'row.captured_at'
  | 'row.sampled_count';

const TARGET_FIELDS: readonly TargetField[] = [
  'rank.rating',
  'rank.tier',
  'rank.techniqueCount',
  'rank.scoredShotCount',
  'rank.updatedAt',
  'row.shot_type',
  'row.score',
  'row.captured_at',
  'row.sampled_count',
];

type ShapeFault =
  | 'top-array'
  | 'top-string'
  | 'top-number'
  | 'top-null'
  | 'no-rank-key'
  | 'rank-array'
  | 'rank-string'
  | 'rank-true'
  | 'techniques-object'
  | 'techniques-string'
  | 'techniques-missing'
  | 'row-null'
  | 'row-array'
  | 'row-string';

const SHAPE_FAULTS: readonly ShapeFault[] = [
  'top-array',
  'top-string',
  'top-number',
  'top-null',
  'no-rank-key',
  'rank-array',
  'rank-string',
  'rank-true',
  'techniques-object',
  'techniques-string',
  'techniques-missing',
  'row-null',
  'row-array',
  'row-string',
];

interface PayloadMutation {
  label: string;
  /** The value the mutation planted, when it targeted one field. */
  planted?: { field: TargetField; value: unknown; fault: ValueFault };
  shape?: ShapeFault;
}

function applyValueFault(
  payload: { rank: RankPayload },
  field: TargetField,
  fault: ValueFault,
  rng: Rng,
): PayloadMutation {
  const value = faultedValue(fault, rng);
  const rank = payload.rank;
  const setOrDelete = (target: Record<string, unknown>, key: string) => {
    if (value === undefined) delete target[key];
    else target[key] = value;
  };
  if (field.startsWith('rank.')) {
    setOrDelete(rank as unknown as Record<string, unknown>, field.slice(5));
  } else {
    const rows = rank.techniques as TechniqueRow[];
    if (rows.length === 0) {
      rows.push({
        shot_type: 'dink',
        score: 5,
        captured_at: '2026-08-30T00:00:00.000Z',
      });
    }
    const row = rows[int(rng, 0, rows.length - 1)]!;
    setOrDelete(row as unknown as Record<string, unknown>, field.slice(4));
  }
  return { label: `${field}=${fault}`, planted: { field, value, fault } };
}

function applyShapeFault(
  payload: unknown,
  fault: ShapeFault,
): { payload: unknown; mutation: PayloadMutation } {
  const mutation: PayloadMutation = { label: `shape=${fault}`, shape: fault };
  const body = payload as { rank: RankPayload };
  switch (fault) {
    case 'top-array':
      return { payload: [body], mutation };
    case 'top-string':
      return { payload: 'ok', mutation };
    case 'top-number':
      return { payload: 200, mutation };
    case 'top-null':
      return { payload: null, mutation };
    case 'no-rank-key':
      return { payload: { data: body.rank }, mutation };
    case 'rank-array':
      return { payload: { rank: [body.rank] }, mutation };
    case 'rank-string':
      return { payload: { rank: 'gold' }, mutation };
    case 'rank-true':
      return { payload: { rank: true }, mutation };
    case 'techniques-object':
      body.rank.techniques = { dink: 5 };
      return { payload: body, mutation };
    case 'techniques-string':
      body.rank.techniques = 'dink';
      return { payload: body, mutation };
    case 'techniques-missing':
      delete (body.rank as Partial<RankPayload>).techniques;
      return { payload: body, mutation };
    case 'row-null':
      (body.rank.techniques as unknown[]).push(null);
      return { payload: body, mutation };
    case 'row-array':
      (body.rank.techniques as unknown[]).push(['dink', 5]);
      return { payload: body, mutation };
    case 'row-string':
      (body.rank.techniques as unknown[]).push('dink');
      return { payload: body, mutation };
  }
}

// ─── Transport fault catalog ───────────────────────────────────────────────

type TransportFault =
  | 'ok'
  | 'throw-sync'
  | 'reject-error'
  | 'reject-non-error'
  | 'http-error'
  | 'ok-invalid-json'
  | 'slow'
  | 'never';

const TRANSPORT_FAULTS: readonly TransportFault[] = [
  'ok',
  'ok',
  'ok',
  'throw-sync',
  'reject-error',
  'reject-non-error',
  'http-error',
  'ok-invalid-json',
  'slow',
  'never',
];

const HTTP_ERRORS = [
  400, 401, 403, 404, 408, 409, 410, 418, 422, 429, 500, 502, 503, 504,
];

function fakeResponse(
  status: number,
  body: unknown,
  invalidJson: boolean,
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () =>
      invalidJson
        ? Promise.reject(new SyntaxError('Unexpected token < in JSON'))
        : Promise.resolve(body),
  } as unknown as Response;
}

interface Scenario {
  seed: number;
  transport: TransportFault;
  httpStatus: number | null;
  slowMs: number;
  mutations: PayloadMutation[];
  payload: unknown;
}

function scenarioFor(seed: number): Scenario {
  const rng = mulberry32(seed);
  const transport = pick(rng, TRANSPORT_FAULTS);
  let payload: unknown = validPayload(rng);
  const mutations: PayloadMutation[] = [];
  if (transport === 'ok' || transport === 'slow') {
    // 80% of successful responses carry payload faults; the rest pin that a
    // healthy payload still parses under every seed.
    const faultCount = chance(rng, 0.8) ? int(rng, 1, 3) : 0;
    // One fault per field: a second fault on the same field would overwrite
    // the first and make the oracle judge a value that never reached parse.
    const untouched = shuffled(rng, TARGET_FIELDS);
    for (let i = 0; i < faultCount; i += 1) {
      if (chance(rng, 0.25)) {
        const result = applyShapeFault(payload, pick(rng, SHAPE_FAULTS));
        payload = result.payload;
        mutations.push(result.mutation);
        if (!result.mutation.shape?.startsWith('row-')) {
          break; // the rank object or its rows array is gone.
        }
      } else {
        const field = untouched.pop();
        if (!field) break;
        mutations.push(
          applyValueFault(
            payload as { rank: RankPayload },
            field,
            pick(rng, VALUE_FAULTS),
            rng,
          ),
        );
      }
    }
  }
  return {
    seed,
    transport,
    httpStatus: transport === 'http-error' ? pick(rng, HTTP_ERRORS) : null,
    slowMs: transport === 'slow' ? int(rng, 1_000, 59_000) : 0,
    mutations,
    payload,
  };
}

function transportFor(scenario: Scenario): PlayerRankFetch {
  switch (scenario.transport) {
    case 'throw-sync':
      return () => {
        throw new TypeError('Network request failed');
      };
    case 'reject-error':
      return () => Promise.reject(new TypeError('Network request failed'));
    case 'reject-non-error':
      return () => Promise.reject('socket hang up');
    case 'http-error':
      return async () =>
        fakeResponse(
          scenario.httpStatus!,
          { error: 'nope' },
          scenario.httpStatus! % 3 === 0,
        );
    case 'ok-invalid-json':
      return async () => fakeResponse(200, null, true);
    case 'slow':
      return () =>
        new Promise<Response>(resolve => {
          setTimeout(
            () => resolve(fakeResponse(200, scenario.payload, false)),
            scenario.slowMs,
          );
        });
    case 'never':
      return () => new Promise<Response>(() => {});
    case 'ok':
      return async () => fakeResponse(200, scenario.payload, false);
  }
}

// ─── Oracle ────────────────────────────────────────────────────────────────

const LOCAL_FACTS: PlayerRankFactLike[] = [
  {
    id: 'local-1',
    shotType: 'dink',
    capturedAt: '2026-08-20T10:00:00.000Z',
    overallScore: 5.5,
    resultKind: 'scored',
  },
  {
    id: 'local-2',
    shotType: 'dink',
    capturedAt: '2026-08-21T10:00:00.000Z',
    overallScore: 6.5,
    resultKind: 'scored',
  },
];

/**
 * Whether the planted value must make parsing reject (strict contract).
 * Decimal numeric strings are tolerated (`Number('7.5')`) and recorded as
 * lenient by the caller; everything else non-numeric must reject.
 */
function mustReject(planted: NonNullable<PayloadMutation['planted']>): boolean {
  const { field, value, fault } = planted;
  switch (field) {
    case 'rank.rating':
      if (typeof value === 'number') return value < 0 || value > 10;
      return fault !== 'numeric-string';
    case 'rank.techniqueCount':
      return typeof value !== 'number' && fault !== 'numeric-string';
    case 'rank.tier':
      return typeof value !== 'string';
    case 'row.shot_type':
    case 'row.captured_at':
      return typeof value !== 'string';
    case 'row.score':
      return typeof value !== 'number' && fault !== 'numeric-string';
    case 'rank.scoredShotCount':
    case 'rank.updatedAt':
    case 'row.sampled_count':
      return false; // optional / nullable fields
  }
}

function validateRank(
  rank: ServerPlayerRank,
  scenario: Scenario,
  failures: string[],
  notes: string[],
) {
  for (const path of nonFinitePaths(rank)) {
    failures.push(fail('O3-non-finite', path));
  }
  if (!(rank.rating >= 0 && rank.rating <= 10)) {
    failures.push(fail('O3-rating-range', String(rank.rating)));
  }
  if (typeof rank.tier !== 'string')
    failures.push(fail('O3-tier', 'not string'));
  if (!Array.isArray(rank.techniques)) {
    failures.push(fail('O3-techniques', 'not array'));
  } else {
    for (const row of rank.techniques) {
      if (typeof row.shotType !== 'string') {
        failures.push(fail('O3-row-shot-type', JSON.stringify(row.shotType)));
      } else if (row.shotType.trim().length === 0) {
        notes.push('lenient empty shot_type accepted');
      }
      if (typeof row.capturedAt !== 'string') {
        failures.push(
          fail('O3-row-captured-at', JSON.stringify(row.capturedAt)),
        );
      }
    }
  }
  // The generator itself emits the documented inline-fallback contract
  // (`scoredShotCount: null`) on ~30% of healthy payloads; it must survive.
  const body = scenario.payload as { rank?: { scoredShotCount?: unknown } };
  const plantedOnCount = scenario.mutations.some(
    m => m.planted?.field === 'rank.scoredShotCount',
  );
  if (
    !plantedOnCount &&
    body.rank?.scoredShotCount === null &&
    rank.scoredShotCount !== null
  ) {
    failures.push(
      fail(
        'O4-null-coerced',
        `scoredShotCount null → ${JSON.stringify(rank.scoredShotCount)}`,
      ),
    );
  }
  for (const mutation of scenario.mutations) {
    const planted = mutation.planted;
    if (!planted) continue;
    if (mustReject(planted)) {
      failures.push(
        fail(
          'O3-accepted-invalid',
          `${planted.field}=${planted.fault} (${JSON.stringify(planted.value)}) parsed instead of rejecting`,
        ),
      );
      continue;
    }
    if (planted.fault === 'numeric-string') {
      notes.push(`lenient ${planted.field} ${JSON.stringify(planted.value)}`);
    }
    if (planted.field === 'rank.scoredShotCount') {
      if (planted.value === null && rank.scoredShotCount !== null) {
        failures.push(
          fail(
            'O4-null-coerced',
            `scoredShotCount null → ${JSON.stringify(rank.scoredShotCount)}`,
          ),
        );
      } else if (
        coercesSilently(planted.value) &&
        planted.value !== null &&
        rank.scoredShotCount !== null
      ) {
        failures.push(
          fail(
            'O3-coerced',
            `scoredShotCount ${JSON.stringify(planted.value)} → ${rank.scoredShotCount}`,
          ),
        );
      } else if (typeof planted.value === 'string') {
        notes.push(`lenient scoredShotCount ${JSON.stringify(planted.value)}`);
      }
    }
    if (planted.field === 'row.sampled_count') {
      const coerced = rank.techniques.some(
        row => row.sampledCount !== undefined && coercesSilently(planted.value),
      );
      if (coerced && planted.value !== undefined) {
        // Not user-visible (sampledCount has no consumer yet) — recorded, not
        // failed, so the table still shows the coercion.
        notes.push(`lenient sampled_count ${JSON.stringify(planted.value)}`);
      }
    }
  }
  // Every shape fault removes or breaks the rank object or a technique row;
  // a rank coming back means one of them was accepted.
  for (const mutation of scenario.mutations) {
    if (mutation.shape)
      failures.push(fail('O3-accepted-shape', mutation.shape));
  }
}

function validateResolution(
  rank: ServerPlayerRank | null,
  failures: string[],
): Record<string, unknown> {
  try {
    const resolved = resolvePlayerRank(LOCAL_FACTS, rank);
    if (!resolved) return { resolved: null };
    const { summary } = resolved;
    for (const path of nonFinitePaths(summary)) {
      failures.push(fail('O5-non-finite', path));
    }
    const band = playerRankTierForRating(summary.rating).key;
    const known = PLAYER_RANK_TIERS.some(tier => tier.key === summary.tier);
    if (!known) failures.push(fail('O5-unknown-tier', summary.tier));
    if (rank && !PLAYER_RANK_TIERS.some(t => t.key === rank.tier)) {
      if (summary.tier !== band) {
        failures.push(fail('O5-tier-band', `${summary.tier} vs ${band}`));
      }
    }
    if (summary.techniqueCount !== summary.techniques.length && !rank) {
      failures.push(fail('O5-technique-count', String(summary.techniqueCount)));
    }
    return {
      resolved: resolved.source,
      rating: summary.rating,
      tier: summary.tier,
      scoredAnalysisCount: summary.scoredAnalysisCount,
    };
  } catch (error) {
    failures.push(fail('O5-throws', String(error)));
    return { resolved: 'threw' };
  }
}

// ─── Runner ────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

afterAll(() => {
  const path = table.write();

  console.log(
    `[${CAMPAIGN}] executed=${table.rows.length} broken=${table.broken.length} → ${path}`,
  );
});

async function runSeed(seed: number) {
  const scenario = scenarioFor(seed);
  const failures: string[] = [];
  const notes: string[] = [];
  const faultLabel = [
    `transport=${scenario.transport}`,
    ...scenario.mutations.map(m => m.label),
  ].join('+');

  let settled: 'pending' | 'resolved' | 'rejected' = 'pending';
  let value: ServerPlayerRank | null = null;
  let error: unknown;
  const promise = fetchPlayerRank(SESSION, transportFor(scenario)).then(
    result => {
      settled = 'resolved';
      value = result;
    },
    reason => {
      settled = 'rejected';
      error = reason;
    },
  );
  await jest.advanceTimersByTimeAsync(60_000);
  await Promise.race([promise, Promise.resolve()]);

  const detail: Record<string, unknown> = {
    transport: scenario.transport,
    httpStatus: scenario.httpStatus,
    slowMs: scenario.slowMs,
    mutations: scenario.mutations.map(m => m.label),
    settled,
  };

  if (scenario.transport === 'never') {
    if (settled !== 'pending') {
      failures.push(fail('O1-never-settled', settled));
    }
  } else if (settled === 'pending') {
    failures.push(fail('O1-hang', 'still pending after 60s of fake time'));
  } else if (settled === 'rejected') {
    detail.error = String(error);
    if (!(error instanceof PlayerRankApiError)) {
      failures.push(fail('O2-error-type', String(error)));
    }
    if (scenario.transport === 'ok' || scenario.transport === 'slow') {
      if (scenario.mutations.length === 0) {
        failures.push(fail('O3-rejected-valid', String(error)));
      }
    }
  } else {
    // Resolved: null or a rank.
    if (
      scenario.transport === 'http-error' ||
      scenario.transport === 'ok-invalid-json' ||
      scenario.transport === 'throw-sync' ||
      scenario.transport === 'reject-error' ||
      scenario.transport === 'reject-non-error'
    ) {
      failures.push(fail('O3-fake-success', 'transport fault resolved'));
    }
    detail.value = value;
    if (value !== null) validateRank(value, scenario, failures, notes);
    else {
      // null is only honest when the server said `rank: null`.
      const body = scenario.payload as { rank?: unknown } | null;
      if (!(body && typeof body === 'object' && body.rank === null)) {
        failures.push(fail('O3-null-for-non-null', JSON.stringify(body)));
      }
    }
    Object.assign(detail, validateResolution(value, failures));
  }
  if (notes.length > 0) detail.notes = notes;
  const row = table.record(seed, faultLabel, failures, detail);
  return row;
}

// ─── Minimized repros (from campaign seeds) ────────────────────────────────

const REPRO_SESSION: ApiSession = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'test-bearer',
  canonicalAppUserId: 'aaaaaaaa-0000-4000-8000-000000000001',
  provider: 'apple',
};

function jsonResponse(body: unknown): PlayerRankFetch {
  return async () => fakeResponse(200, body, false);
}

describe(`${CAMPAIGN}: minimized repros`, () => {
  // Seeds 11003, 11005, 11020 (O4): the edge function's inline-fallback
  // contract (no materialized rank state yet) sends `scoredShotCount: null`.
  // The client coerces it to 0, so the account rank counts as having seen
  // zero analyses and any single local scored row outranks it.
  it('a null scoredShotCount from the server must stay null, not become 0', async () => {
    const rank = await fetchPlayerRank(
      REPRO_SESSION,
      jsonResponse({
        rank: {
          rating: 6.2,
          tier: 'gold',
          techniqueCount: 2,
          scoredShotCount: null,
          updatedAt: null,
          techniques: [
            {
              shot_type: 'dink',
              score: 6.5,
              captured_at: '2026-08-20T00:00:00.000Z',
            },
            {
              shot_type: 'volley',
              score: 5.9,
              captured_at: '2026-08-19T00:00:00.000Z',
            },
          ],
        },
      }),
    );
    const oneLocalRow: PlayerRankFactLike[] = [
      {
        id: 'aaaaaaaa-0000-4000-8000-000000000002',
        shotType: 'serve',
        capturedAt: '2026-08-21T00:00:00.000Z',
        overallScore: 2,
        resultKind: 'scored',
      },
    ];
    expect({
      scoredShotCount: rank?.scoredShotCount,
      source: resolvePlayerRank(oneLocalRow, rank)?.source,
    }).toEqual({ scoredShotCount: null, source: 'account' });
  });

  // Seed 11027 (O3): non-numeric JSON scalars reach Number() and come out as
  // finite numbers instead of an invalid-response error.
  it('boolean and empty-string numerics must be rejected, not coerced', async () => {
    const rank = await fetchPlayerRank(
      REPRO_SESSION,
      jsonResponse({
        rank: {
          rating: '',
          tier: 'bronze',
          techniqueCount: false,
          scoredShotCount: true,
          updatedAt: null,
          techniques: [
            {
              shot_type: 'dink',
              score: true,
              captured_at: '2026-08-20T00:00:00.000Z',
            },
          ],
        },
      }),
    ).then(
      value => ({ resolved: value }),
      (error: unknown) => ({ rejected: error instanceof PlayerRankApiError }),
    );
    expect(rank).toEqual({ rejected: true });
  });
});

describe(`${CAMPAIGN}: fetch/api faults into fetchPlayerRank`, () => {
  it.each(plan.seeds)('seed %i', async seed => {
    const row = await runSeed(seed);
    // The table is the evidence; the assertion keeps jest honest about
    // broken seeds without hiding the rest of the campaign.
    if (row.outcome === 'broken') {
      console.log(
        `[${CAMPAIGN}] seed=${seed} BROKEN ${row.failures.join(' | ')}`,
      );
    }
    expect({ seed, fault: row.fault, failures: row.failures }).toEqual({
      seed,
      fault: row.fault,
      failures: [],
    });
  });
});
