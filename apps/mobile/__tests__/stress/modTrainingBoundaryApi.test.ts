/**
 * STRESS · mod-training · lens `boundary-malformed` · layer: `training/api.ts`
 *
 * Campaign `api-response`: every training endpoint is driven through a fake
 * transport that returns seeded, mutated wire payloads (wrong types, deleted
 * keys, prototype-pollution keys, NaN / ±Infinity / -0 / 2^53, null bytes,
 * 64 KB+ strings, NFD pairs, traversal slugs, future schema keys, empty
 * containers, truncated / corrupted JSON text, odd HTTP statuses, thrown
 * transports). Invariants per row:
 *   1. a fulfilled call returns a value that satisfies the INDEPENDENT
 *      validator derived from types.ts (never an invalid shape);
 *   2. a rejected call rejects with a TrainingError instance (never a raw
 *      TypeError / URIError / SyntaxError / non-Error);
 *   3. HTTP >= 500 and 429 are retryable, 401 is `training.session_expired`
 *      and fires onUnauthorized exactly once, the rejection status equals the
 *      HTTP status;
 *   4. exactly one transport call per api call (no retries / double writes);
 *   5. Object.prototype / Array.prototype stay clean after every row;
 *   6. an accepted value never carries a `polluted` marker outside the
 *      pass-through `equipment: unknown[]` arrays.
 *
 * Campaign `api-url`: hostile caller-supplied slugs / ids / query strings
 * must produce a request URL that stays inside the intended route (no
 * segment collapse after WHATWG normalisation) or a typed rejection.
 *
 * Replay one row:  STRESS_ONLY=api-response:<seed> npx jest modTrainingBoundaryApi
 * Full campaign:   STRESS_ITER=1500 npx jest modTrainingBoundaryApi
 * Table:           apps/mobile/artifacts/stress/mod-training/api-*.json
 *
 * Known BROKEN rows (pinned below with `test.failing`, flip to `test` when
 * fixed) are tagged `known` in the table and do not fail the campaign; any
 * UNKNOWN broken row fails it.
 */
import {
  createTrainingApi,
  type CatalogTrainingApi,
} from '../../src/training/api';
import { TrainingError } from '../../src/training/types';
import {
  BASE_URL,
  FIX,
  HOSTILE_STRINGS,
  Rng,
  apiConfig,
  catalogDrillWire,
  classifySettled,
  completionWire,
  corruptJsonText,
  describeError,
  drillDetailWire,
  fakeResponse,
  globalPollution,
  hostileString,
  iterations,
  mutate,
  onlySeed,
  planWire,
  recordingFetch,
  savedDrillWire,
  seedFor,
  validCatalogDrill,
  validCompletion,
  validDrillDetail,
  validPlan,
  validSavedDrill,
  writeTable,
  type Mutation,
  type Outcome,
  type Recorded,
  type TableRow,
} from '../../test-support/stress/modTrainingBoundary';

interface Scenario {
  name: string;
  route: RegExp;
  wire: () => unknown;
  call: (api: CatalogTrainingApi) => Promise<unknown>;
  valid: (value: unknown) => boolean;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'GET catalog/drills',
    route: /^\/v1\/catalog\/drills(\?|$)/,
    wire: () => ({
      items: [catalogDrillWire(), catalogDrillWire('second-drill')],
    }),
    call: api => api.listCatalogDrills({}),
    valid: v => Array.isArray(v) && v.every(validCatalogDrill),
  },
  {
    name: 'GET me/saved-drills',
    route: /^\/v1\/me\/saved-drills$/,
    wire: () => ({ items: [savedDrillWire(), savedDrillWire('second-drill')] }),
    call: api => api.listSavedDrills(),
    valid: v => Array.isArray(v) && v.every(validSavedDrill),
  },
  {
    name: 'GET catalog/drills/:slug',
    route: /^\/v1\/catalog\/drills\/[^/?]+$/,
    wire: () => drillDetailWire(),
    call: api => api.getDrill(FIX.slug),
    valid: validDrillDetail,
  },
  {
    name: 'PUT me/saved-drills/:slug',
    route: /^\/v1\/me\/saved-drills\/[^/?]+$/,
    wire: () => ({ slug: FIX.slug, saved: true }),
    call: api => api.saveDrill(FIX.slug),
    valid: v => v === undefined,
  },
  {
    name: 'DELETE me/saved-drills/:slug',
    route: /^\/v1\/me\/saved-drills\/[^/?]+$/,
    wire: () => ({}),
    call: api => api.unsaveDrill(FIX.slug),
    valid: v => v === undefined,
  },
  {
    name: 'GET training-plans/current',
    route: /^\/v1\/training-plans\/current$/,
    wire: () => ({ plan: planWire() }),
    call: api => api.getCurrentPlan(),
    valid: v => v === null || validPlan(v),
  },
  {
    name: 'POST training-plans',
    route: /^\/v1\/training-plans$/,
    wire: () => ({ plan: planWire() }),
    call: api => api.createPlan(FIX.uuid.shot),
    valid: validPlan,
  },
  {
    name: 'POST drill-completions',
    route: /^\/v1\/drill-completions$/,
    wire: () => ({ completion: completionWire() }),
    call: api =>
      api.completeDrill({
        id: FIX.uuid.completion,
        drillSlug: FIX.slug,
        trainingPlanItemId: FIX.uuid.item2,
        completedAt: '2026-08-27T19:00:00.000Z',
        actualRepetitions: 24,
        actualDurationSeconds: null,
      }),
    valid: validCompletion,
  },
  {
    name: 'POST training-plans/:id/reassessment',
    route: /^\/v1\/training-plans\/[^/?]+\/reassessment$/,
    wire: () => ({ plan: planWire() }),
    call: api => api.reassessPlan(FIX.uuid.plan, FIX.uuid.shot),
    valid: validPlan,
  },
];

const ERROR_STATUSES = [
  400, 402, 403, 404, 405, 409, 410, 413, 415, 422, 429, 451, 500, 501, 502,
  503, 504, 507, 599, 100, 199, 299, 300, 301, 304, 307, 599, 999,
] as const;

type Transport =
  | { kind: 'ok'; status: 200 | 201 | 299; body: unknown }
  | { kind: 'text'; status: number; text: string; detail: string }
  | { kind: 'error'; status: number; body: unknown }
  | { kind: 'unauthorized'; body: unknown }
  | { kind: 'no-content' }
  | { kind: 'throw'; error: unknown }
  | { kind: 'control' };

function planTransport(
  rng: Rng,
  scenario: Scenario,
): { transport: Transport; mutations: Mutation[] | string } {
  const roll = rng.next();
  if (roll < 0.05)
    return { transport: { kind: 'control' }, mutations: 'control:valid-wire' };
  if (roll < 0.66) {
    const { value, ops } = mutate(scenario.wire(), rng, rng.int(1, 4));
    return {
      transport: {
        kind: 'ok',
        status: rng.pick([200, 200, 200, 201, 299]),
        body: value,
      },
      mutations: ops,
    };
  }
  if (roll < 0.76) {
    const { value, ops } = mutate(scenario.wire(), rng, rng.int(0, 2));
    const corrupted = corruptJsonText(value, rng);
    return {
      transport: {
        kind: 'text',
        status: rng.pick([200, 200, 400, 500]),
        text: corrupted.text,
        detail: corrupted.detail,
      },
      mutations: [
        ...ops,
        { op: 'replace-root', path: 'text', detail: corrupted.detail },
      ],
    };
  }
  if (roll < 0.88) {
    const { value, ops } = mutate(
      {
        error: {
          code: 'validation.saved_drill',
          message: 'Invalid drill slug.',
        },
      },
      rng,
      rng.int(0, 3),
    );
    return {
      transport: {
        kind: 'error',
        status: rng.pick(ERROR_STATUSES),
        body: value,
      },
      mutations: ops,
    };
  }
  if (roll < 0.93) {
    const { value, ops } = mutate(
      { error: { code: 'auth.invalid_token', message: 'Expired.' } },
      rng,
      rng.int(0, 2),
    );
    return { transport: { kind: 'unauthorized', body: value }, mutations: ops };
  }
  if (roll < 0.96)
    return { transport: { kind: 'no-content' }, mutations: 'status:204' };
  const error = rng.pick<unknown>([
    new TypeError('Network request failed'),
    new Error('aborted'),
    'string-rejection',
    null,
    undefined,
    { code: 'ECONNRESET' },
    42,
  ]);
  return {
    transport: { kind: 'throw', error },
    mutations: `fetch-throws:${describeError(error)}`,
  };
}

function respond(transport: Transport, scenario: Scenario): Response {
  switch (transport.kind) {
    case 'control':
      return fakeResponse(200, { json: scenario.wire() });
    case 'ok':
      return fakeResponse(transport.status, { json: transport.body });
    case 'text':
      return fakeResponse(transport.status, { text: transport.text });
    case 'error':
      return fakeResponse(transport.status, { json: transport.body });
    case 'unauthorized':
      return fakeResponse(401, { json: transport.body });
    case 'no-content':
      return fakeResponse(204, { json: null });
    case 'throw':
      throw transport.error;
  }
}

function hasPollutionMarker(value: unknown, parentKey = ''): boolean {
  if (Array.isArray(value)) {
    if (parentKey === 'equipment') return false;
    return value.some(item => hasPollutionMarker(item));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record['polluted'] !== undefined) return true;
    return Object.keys(record).some(key =>
      hasPollutionMarker(record[key], key),
    );
  }
  return false;
}

function checkTransportContract(
  transport: Transport,
  settled: PromiseSettledResult<unknown>,
  unauthorizedCalls: number,
  calls: Recorded[],
  scenario: Scenario,
): Outcome | null {
  const broken = (invariant: string, detail: string): Outcome => ({
    kind: 'BROKEN',
    invariant,
    detail,
  });
  if (calls.length !== 1) {
    return broken('transport-call-count', `fetch called ${calls.length}×`);
  }
  const call = calls[0];
  if (!call) return broken('transport-call-count', 'no call recorded');
  if (!call.url.startsWith(`${BASE_URL}/`)) {
    return broken('url-base', call.url.slice(0, 120));
  }
  if (!scenario.route.test(call.url.slice(BASE_URL.length))) {
    return broken(
      'url-route',
      call.url.slice(BASE_URL.length, BASE_URL.length + 120),
    );
  }
  const expectedUnauthorized = transport.kind === 'unauthorized' ? 1 : 0;
  if (unauthorizedCalls !== expectedUnauthorized) {
    return broken(
      'on-unauthorized-count',
      `onUnauthorized fired ${unauthorizedCalls}× for ${transport.kind}`,
    );
  }
  if (transport.kind === 'control' && settled.status !== 'fulfilled') {
    return broken('rejected-valid-wire', describeError(settled.reason));
  }
  if (settled.status === 'fulfilled') {
    if (hasPollutionMarker(settled.value)) {
      return broken('pollution-marker-accepted', scenario.name);
    }
    if (transport.kind === 'error' && transport.status >= 400) {
      return broken(
        'http-error-accepted',
        `status ${transport.status} fulfilled`,
      );
    }
    if (transport.kind === 'unauthorized' || transport.kind === 'throw') {
      return broken('failure-accepted', `${transport.kind} fulfilled`);
    }
    return null;
  }
  const reason = settled.reason;
  if (!(reason instanceof TrainingError)) return null; // classified below
  if (transport.kind === 'unauthorized') {
    if (reason.code !== 'training.session_expired' || reason.status !== 401) {
      return broken('401-mapping', `${reason.code}/${reason.status}`);
    }
  }
  if (transport.kind === 'throw' && reason.code !== 'training.unavailable') {
    return broken('network-mapping', reason.code);
  }
  if (transport.kind === 'error' && transport.status >= 400) {
    if (reason.status !== transport.status) {
      return broken(
        'status-echo',
        `${reason.status} for HTTP ${transport.status}`,
      );
    }
    const shouldRetry = transport.status >= 500 || transport.status === 429;
    if (reason.retryable !== shouldRetry) {
      return broken(
        'retryable-flag',
        `${reason.retryable} for HTTP ${transport.status}`,
      );
    }
    if (reason.message.length > 4096) {
      return broken('error-message-unbounded', `len=${reason.message.length}`);
    }
  }
  if (
    transport.kind === 'text' &&
    transport.status >= 200 &&
    transport.status < 300
  ) {
    if (reason.code !== 'training.invalid_response') {
      return broken('malformed-json-mapping', reason.code);
    }
  }
  return null;
}

async function runResponseRow(seed: number, index: number): Promise<TableRow> {
  const rng = new Rng(seed);
  const scenario = rng.pick(SCENARIOS);
  const planned = planTransport(rng, scenario);
  let unauthorizedCalls = 0;
  const { fetchFn, calls } = recordingFetch(() =>
    respond(planned.transport, scenario),
  );
  const api = createTrainingApi(
    apiConfig(fetchFn, () => {
      unauthorizedCalls += 1;
    }),
  );
  const [settled] = await Promise.allSettled([scenario.call(api)]);
  const pollution = globalPollution();
  let outcome: Outcome;
  if (pollution) {
    outcome = {
      kind: 'BROKEN',
      invariant: 'global-prototype-polluted',
      detail: pollution,
    };
  } else {
    outcome =
      checkTransportContract(
        planned.transport,
        settled,
        unauthorizedCalls,
        calls,
        scenario,
      ) ?? classifySettled(settled, scenario.valid);
  }
  return {
    campaign: 'api-response',
    seed,
    index,
    scenario: `${scenario.name} · ${planned.transport.kind}`,
    mutations: planned.mutations,
    outcome,
    known:
      outcome.kind === 'BROKEN' &&
      outcome.invariant === 'error-message-unbounded'
        ? 'F-ERRMSG'
        : undefined,
  };
}

// ─── Campaign `api-url`: hostile caller-supplied path / query inputs ──────────

interface UrlProbe {
  name: string;
  prefix: string;
  /** JSON body key that must carry the input verbatim (body probes only). */
  bodyKey?: string;
  call: (api: CatalogTrainingApi, input: string) => Promise<unknown>;
}

const URL_PROBES: readonly UrlProbe[] = [
  {
    name: 'getDrill(slug)',
    prefix: '/v1/catalog/drills/',
    call: (api, s) => api.getDrill(s),
  },
  {
    name: 'saveDrill(slug)',
    prefix: '/v1/me/saved-drills/',
    call: (api, s) => api.saveDrill(s),
  },
  {
    name: 'unsaveDrill(slug)',
    prefix: '/v1/me/saved-drills/',
    call: (api, s) => api.unsaveDrill(s),
  },
  {
    name: 'reassessPlan(planId)',
    prefix: '/v1/training-plans/',
    call: (api, s) => api.reassessPlan(s, FIX.uuid.shot),
  },
  {
    name: 'listCatalogDrills({q})',
    prefix: '/v1/catalog/drills',
    call: (api, s) => api.listCatalogDrills({ q: s }),
  },
  {
    name: 'listCatalogDrills({family})',
    prefix: '/v1/catalog/drills',
    call: (api, s) => api.listCatalogDrills({ family: s }),
  },
  {
    name: 'createPlan(sourceShotId)',
    prefix: '/v1/training-plans',
    bodyKey: 'sourceShotId',
    call: (api, s) => api.createPlan(s),
  },
  {
    name: 'reassessPlan(shotId)',
    prefix: '/v1/training-plans/',
    bodyKey: 'shotId',
    call: (api, s) => api.reassessPlan(FIX.uuid.plan, s),
  },
  {
    name: 'completeDrill(planItemId)',
    prefix: '/v1/drill-completions',
    bodyKey: 'trainingPlanItemId',
    call: (api, s) =>
      api.completeDrill({
        id: FIX.uuid.completion,
        drillSlug: FIX.slug,
        trainingPlanItemId: s,
        completedAt: '2026-08-27T19:00:00.000Z',
        actualRepetitions: 1,
        actualDurationSeconds: null,
      }),
  },
];

function composeInput(rng: Rng): string {
  const roll = rng.int(0, 3);
  if (roll === 0) return hostileString(rng);
  if (roll === 1) return `${FIX.slug}${hostileString(rng)}`;
  if (roll === 2) return `${hostileString(rng)}${hostileString(rng)}`;
  const s = hostileString(rng);
  return rng.bool() ? s.normalize('NFD') : s.normalize('NFKC');
}

/** Known-bad url outcomes pinned below; tag so the campaign stays green. */
function knownUrl(
  input: string,
  outcome: Outcome,
  probe: UrlProbe,
): string | undefined {
  if (outcome.kind !== 'BROKEN') return undefined;
  if (
    outcome.invariant === 'untyped-rejection' &&
    /URIError/.test(outcome.detail)
  ) {
    return 'F-URIERROR';
  }
  if (
    outcome.invariant === 'url-segment-collapse' &&
    probe.prefix.endsWith('/')
  ) {
    return 'F-TRAVERSAL';
  }
  return undefined;
}

async function runUrlRow(seed: number, index: number): Promise<TableRow> {
  const rng = new Rng(seed);
  const probe = rng.pick(URL_PROBES);
  const input = composeInput(rng);
  const { fetchFn, calls } = recordingFetch(() =>
    fakeResponse(400, {
      json: {
        error: {
          code: 'validation.saved_drill',
          message: 'Invalid drill slug.',
        },
      },
    }),
  );
  const api = createTrainingApi(apiConfig(fetchFn));
  const [settled] = await Promise.allSettled([probe.call(api, input)]);
  let outcome: Outcome = classifySettled(settled, () => false);
  const call = calls[0];
  if (outcome.kind === 'rejected' && call) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(call.url);
    } catch {
      outcome = {
        kind: 'BROKEN',
        invariant: 'url-unparseable',
        detail: call.url.slice(0, 120),
      };
    }
    if (parsed) {
      const raw = call.url.slice(BASE_URL.length);
      if (parsed.origin !== BASE_URL) {
        outcome = {
          kind: 'BROKEN',
          invariant: 'url-origin-escape',
          detail: parsed.origin,
        };
      } else if (!raw.startsWith(probe.prefix)) {
        outcome = {
          kind: 'BROKEN',
          invariant: 'url-route',
          detail: raw.slice(0, 120),
        };
      } else if (
        probe.prefix.endsWith('/') &&
        (parsed.pathname !== (raw.split('?')[0] ?? raw) ||
          parsed.pathname.slice(probe.prefix.length).split('/')[0] === '')
      ) {
        outcome = {
          kind: 'BROKEN',
          invariant: 'url-segment-collapse',
          detail: `${JSON.stringify(input.slice(0, 24))} → ${parsed.pathname}`,
        };
      } else if (
        probe.prefix.endsWith('/') &&
        /[?#]/.test(
          raw.slice(probe.prefix.length).split('/reassessment')[0] ?? '',
        )
      ) {
        outcome = {
          kind: 'BROKEN',
          invariant: 'url-query-injection',
          detail: raw.slice(0, 120),
        };
      } else if (probe.bodyKey !== undefined) {
        const body = JSON.parse(call.body ?? 'null') as Record<
          string,
          unknown
        > | null;
        const sent = body?.[probe.bodyKey];
        if (sent !== input) {
          outcome = {
            kind: 'BROKEN',
            invariant: 'body-input-altered',
            detail: String(sent).slice(0, 60),
          };
        }
      }
    }
  } else if (outcome.kind === 'rejected' && !call) {
    outcome = {
      kind: 'BROKEN',
      invariant: 'rejected-before-transport',
      detail: outcome.code,
    };
  }
  const row: TableRow = {
    campaign: 'api-url',
    seed,
    index,
    scenario: probe.name,
    mutations: `input=${JSON.stringify(input.length > 48 ? `${input.slice(0, 24)}…(len=${input.length})` : input)}`,
    outcome,
  };
  row.known = knownUrl(input, outcome, probe);
  return row;
}

async function campaign(
  name: string,
  run: (seed: number, index: number) => Promise<TableRow>,
  defaultIterations: number,
): Promise<{ rows: TableRow[]; unexpected: TableRow[]; path: string }> {
  const only = onlySeed(name);
  const total = only === null ? iterations(defaultIterations) : 1;
  const rows: TableRow[] = [];
  for (let index = 0; index < total; index++) {
    const seed = only ?? seedFor(name, index);
    rows.push(await run(seed, index));
  }
  const unexpected = rows.filter(r => r.outcome.kind === 'BROKEN' && !r.known);
  const { path } = writeTable(name, rows, {
    replay: `STRESS_ONLY=${name}:<seed> npx jest modTrainingBoundaryApi`,
    unexpectedSeeds: unexpected.map(r => r.seed),
    knownSeeds: rows
      .filter(r => r.known)
      .map(r => ({ seed: r.seed, tag: r.known })),
  });
  return { rows, unexpected, path };
}

jest.setTimeout(600_000);

describe('mod-training boundary/malformed · api', () => {
  afterEach(() => {
    expect(globalPollution()).toBeNull();
  });

  test('campaign api-response: mutated wire payloads never escape the typed boundary', async () => {
    const { rows, unexpected, path } = await campaign(
      'api-response',
      runResponseRow,
      300,
    );
    expect(rows.length).toBeGreaterThan(0);
    // The harness must exercise both branches, or it proves nothing.
    expect(rows.some(r => r.outcome.kind === 'accepted')).toBe(true);
    expect(rows.some(r => r.outcome.kind === 'rejected')).toBe(true);
    expect({ path, unexpected: unexpected.slice(0, 10) }).toEqual({
      path,
      unexpected: [],
    });
  });

  test('campaign api-url: hostile caller inputs stay inside the route or reject typed', async () => {
    const { rows, unexpected, path } = await campaign(
      'api-url',
      runUrlRow,
      300,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect({ path, unexpected: unexpected.slice(0, 10) }).toEqual({
      path,
      unexpected: [],
    });
  });

  // ── Minimised reproductions of BROKEN rows (flip to `test` once fixed) ────

  test.failing(
    'F-URIERROR: a lone-surrogate slug rejects with TrainingError, not a raw URIError (seed api-url:lone-surrogate)',
    async () => {
      const { fetchFn } = recordingFetch(() =>
        fakeResponse(200, { json: drillDetailWire() }),
      );
      const api = createTrainingApi(apiConfig(fetchFn));
      // api.ts:474-475 `encodeURIComponent(slug)` throws URIError for '\ud800'
      // before the request is built; nothing converts it to a TrainingError.
      await expect(api.getDrill('\ud800')).rejects.toBeInstanceOf(
        TrainingError,
      );
    },
  );

  test.failing(
    'F-URIERROR: a lone-surrogate search query rejects typed (listCatalogDrills q)',
    async () => {
      const { fetchFn } = recordingFetch(() =>
        fakeResponse(200, { json: { items: [] } }),
      );
      const api = createTrainingApi(apiConfig(fetchFn));
      await expect(
        api.listCatalogDrills({ q: 'dink\udc00' }),
      ).rejects.toBeInstanceOf(TrainingError);
    },
  );

  test.failing(
    'F-TRAVERSAL: a "." / ".." slug must not collapse the saved-drill route to its collection',
    async () => {
      const { fetchFn, calls } = recordingFetch(() =>
        fakeResponse(204, { json: null }),
      );
      const api = createTrainingApi(apiConfig(fetchFn));
      await api.unsaveDrill('..').catch(() => undefined);
      await api.unsaveDrill('.').catch(() => undefined);
      // encodeURIComponent leaves '.' untouched, so the wire path is
      // `/v1/me/saved-drills/..` which every WHATWG/RFC 3986 client
      // normalises to `/v1/me/` (Node's URL shown here; iOS NSURLSession
      // behaviour is UNKNOWN from Linux). A DELETE that lands on a
      // collection path is a different route than the caller intended.
      const pathnames = calls.map(c => new URL(c.url).pathname);
      expect(pathnames).toEqual([
        expect.stringMatching(/^\/v1\/me\/saved-drills\/.+/),
        expect.stringMatching(/^\/v1\/me\/saved-drills\/.+/),
      ]);
    },
  );

  test.failing(
    'F-ERRMSG: a server error body cannot inject an unbounded / control-character message into TrainingError',
    async () => {
      const hostile = `\u202e${'x'.repeat(70_000)}\u0000`;
      const { fetchFn } = recordingFetch(() =>
        fakeResponse(400, {
          json: {
            error: { code: `bad\u0000${'c'.repeat(5000)}`, message: hostile },
          },
        }),
      );
      const api = createTrainingApi(apiConfig(fetchFn));
      const [settled] = await Promise.allSettled([api.listSavedDrills()]);
      expect(settled.status).toBe('rejected');
      const error = settled.status === 'rejected' ? settled.reason : null;
      expect(error).toBeInstanceOf(TrainingError);
      if (!(error instanceof TrainingError)) return;
      // api.ts:456-469 adopts `error.code` / `error.message` verbatim; screens
      // render `error.message` (DrillLibraryScreen toMessage, store.error).
      expect(error.code.length).toBeLessThanOrEqual(128);
      expect(error.message.length).toBeLessThanOrEqual(1024);
      const hasControlOrBidi = [...error.message].some(ch => {
        const cp = ch.codePointAt(0) ?? 0;
        return (
          cp <= 0x08 ||
          cp === 0x200e ||
          cp === 0x200f ||
          (cp >= 0x202a && cp <= 0x202e)
        );
      });
      expect(hasControlOrBidi).toBe(false);
    },
  );

  test('control: every hostile string in the pool is either sent encoded or rejected typed', async () => {
    let untyped = 0;
    for (const input of HOSTILE_STRINGS) {
      const { fetchFn } = recordingFetch(() =>
        fakeResponse(404, { json: { error: {} } }),
      );
      const api = createTrainingApi(apiConfig(fetchFn));
      const [settled] = await Promise.allSettled([api.getDrill(input)]);
      if (
        settled.status === 'rejected' &&
        !(settled.reason instanceof TrainingError)
      ) {
        untyped += 1;
        expect(String(settled.reason)).toMatch(/URIError/);
      }
    }
    // Only the two lone-surrogate strings in the pool trip encodeURIComponent.
    expect(untyped).toBe(2);
  });
});
