/**
 * STRESS (seeded randomized long-run) — `src/account/consentApi.ts`.
 *
 * Random grant / withdraw / status sequences over the three consent scopes
 * against a simulated edge fn that folds the latest action per scope (the
 * real server semantics in `supabase/functions/api/index.ts`). Every answer
 * is drawn from the seed: clean folds, HTTP errors, malformed folds (bad
 * scope names, non-boolean `active`, non-string timestamps…), non-JSON,
 * network failures and stalled sockets driven past the 15 s deadline.
 *
 * Invariants model-checked after EVERY step (module docblock +
 * `__tests__/wf/fix-19-consentApi.test.ts`):
 *   C1  exactly one request per call (never retried), to
 *       `${apiBaseUrl}/v1/me/consent/{status|grant|withdraw}` with the right
 *       method, JSON Accept/Content-Type, `Authorization: Bearer <current>`,
 *       `X-Client-Version: <runtime appVersion>` and an abort signal
 *   C2  request bodies are exact: grant = {scope, consentVersion, source:
 *       'mobile_settings', device, captureMode:'all_captures'}; withdraw =
 *       {scope, source, device}; status = no body at all
 *   C3  the client never sends a grant the user did not tap: a `/grant`
 *       request appears only for an explicit grant action, and its scope is
 *       the tapped scope (video_analysis is never granted from this client)
 *   C4  transport / HTTP failures → ConsentApiError 'Consent settings are
 *       temporarily unavailable.'; any malformed 2xx fold → ConsentApiError
 *       'The consent server returned an invalid response.'; nothing else
 *       ever escapes (no TypeError / SyntaxError / AbortError)
 *   C5  a successful call returns EXACTLY the server fold (scopes
 *       independent, off by default, latest action wins, versions verbatim)
 *   C6  a stalled request is still pending at 14 999 ms and fails right
 *       after 15 000 ms; no timer survives any settled call
 *   C7  determinism: the same seed replays to an identical trace
 *
 * Replay one seed:  STRESS_ONLY_SEED=<seed> npx jest __tests__/stress/consentApiRandomized
 * Long campaign:    STRESS_ITER=2500 npx jest __tests__/stress/consentApiRandomized
 */
import type { ApiSession } from '../../src/account/apiSession';
import {
  CONSENT_REQUEST_TIMEOUT_MS,
  ConsentApiError,
  EVALUATION_TELEMETRY_CONSENT_VERSION,
  MODEL_TRAINING_CONSENT_VERSION,
  fetchConsentStatus,
  grantEvaluationTelemetryConsent,
  grantModelTrainingConsent,
  withdrawEvaluationTelemetryConsent,
  withdrawModelTrainingConsent,
  type ConsentAction,
  type ConsentScope,
  type ConsentStatus,
} from '../../src/account/consentApi';
import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';
import {
  campaignConfig,
  createFakeFetch,
  describeFailures,
  runCampaign,
  seededUuid,
  settle,
  stable,
  type Rng,
  type SequenceSpec,
  type WireFault,
} from '../../test-support/stress/seededCampaign';

const API_BASE = 'https://api.example.test/functions/v1/api';
const CLOCK_START = Date.parse('2026-09-05T00:00:00.000Z');
const MSG_UNAVAILABLE = 'Consent settings are temporarily unavailable.';
const MSG_INVALID = 'The consent server returned an invalid response.';

const SCOPES: readonly ConsentScope[] = [
  'video_analysis',
  'model_training',
  'evaluation_telemetry',
];

type Fault =
  | 'none'
  | 'network'
  | 'hang'
  | 'http400'
  | 'http401'
  | 'http403'
  | 'http429'
  | 'http500'
  | 'http503'
  | 'http_nonjson'
  | 'ok_nonjson'
  | 'ok_null'
  | 'ok_array'
  | 'ok_string'
  | 'ok_scopes_missing'
  | 'ok_scopes_object'
  | 'ok_subject_number'
  | 'ok_row_not_record'
  | 'ok_row_bad_scope'
  | 'ok_row_active_string'
  | 'ok_row_active_missing'
  | 'ok_row_bad_lastAction'
  | 'ok_row_lastAction_missing'
  | 'ok_row_bad_lastActionAt'
  | 'ok_row_bad_version'
  | 'ok_scopes_partial'
  | 'ok_scopes_shuffled'
  | 'ok_subject_null';

const FAULTS: readonly Fault[] = [
  'network',
  'hang',
  'http400',
  'http401',
  'http403',
  'http429',
  'http500',
  'http503',
  'http_nonjson',
  'ok_nonjson',
  'ok_null',
  'ok_array',
  'ok_string',
  'ok_scopes_missing',
  'ok_scopes_object',
  'ok_subject_number',
  'ok_row_not_record',
  'ok_row_bad_scope',
  'ok_row_active_string',
  'ok_row_active_missing',
  'ok_row_bad_lastAction',
  'ok_row_lastAction_missing',
  'ok_row_bad_lastActionAt',
  'ok_row_bad_version',
  'ok_scopes_partial',
  'ok_scopes_shuffled',
  'ok_subject_null',
];

type Call =
  | 'status'
  | 'grantModelTraining'
  | 'withdrawModelTraining'
  | 'grantEvaluationTelemetry'
  | 'withdrawEvaluationTelemetry';

type Action =
  | { kind: 'call'; call: Call; fault: Fault }
  | { kind: 'rotateBearer' }
  | { kind: 'setDevice'; device: string };

const DEVICE_ALPHABET =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ,.-_/()"\'<>&éñ日本語🏓';

function randomDevice(rng: Rng): string {
  const kind = rng.weighted([
    ['ios', 6],
    ['empty', 1],
    ['random', 3],
    ['long', 1],
  ] as const);
  if (kind === 'ios') return `iOS phone ${rng.int(15, 19)}.${rng.int(0, 7)}`;
  if (kind === 'empty') return '';
  const length = kind === 'long' ? rng.int(200, 600) : rng.int(1, 40);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += DEVICE_ALPHABET[rng.int(0, DEVICE_ALPHABET.length - 1)];
  }
  return out;
}

function generate(rng: Rng, length: number): Action[] {
  const actions: Action[] = [];
  for (let i = 0; i < length; i += 1) {
    const kind = rng.weighted([
      ['call', 80],
      ['rotateBearer', 10],
      ['setDevice', 10],
    ] as const);
    if (kind === 'call') {
      actions.push({
        kind,
        call: rng.weighted([
          ['status', 3],
          ['grantModelTraining', 2],
          ['withdrawModelTraining', 2],
          ['grantEvaluationTelemetry', 2],
          ['withdrawEvaluationTelemetry', 2],
        ] as const),
        fault: rng.chance(0.5) ? 'none' : rng.pick(FAULTS),
      });
    } else if (kind === 'setDevice') {
      actions.push({ kind, device: randomDevice(rng) });
    } else {
      actions.push({ kind });
    }
  }
  return actions;
}

function describeAction(action: Action): string {
  switch (action.kind) {
    case 'call':
      return `${action.call}(fault=${action.fault})`;
    case 'rotateBearer':
      return action.kind;
    case 'setDevice':
      return `setDevice(${JSON.stringify(action.device)})`;
  }
}

// ─── Simulated server ────────────────────────────────────────────────────────

interface ScopeRow {
  scope: ConsentScope;
  active: boolean;
  consentVersion: string | null;
  lastAction: ConsentAction | null;
  lastActionAt: string | null;
}

interface ServerModel {
  subjectPseudonym: string | null;
  rows: Record<ConsentScope, ScopeRow>;
}

function fold(
  model: ServerModel,
  order: readonly ConsentScope[],
): ConsentStatus {
  return {
    subjectPseudonym: model.subjectPseudonym,
    scopes: order.map(scope => ({ ...model.rows[scope] })),
  };
}

function callScope(call: Call): ConsentScope | null {
  switch (call) {
    case 'status':
      return null;
    case 'grantModelTraining':
    case 'withdrawModelTraining':
      return 'model_training';
    case 'grantEvaluationTelemetry':
    case 'withdrawEvaluationTelemetry':
      return 'evaluation_telemetry';
  }
}

function callAction(call: Call): ConsentAction | null {
  if (call === 'status') return null;
  return call.startsWith('grant') ? 'granted' : 'withdrawn';
}

function versionFor(scope: ConsentScope): string {
  return scope === 'model_training'
    ? MODEL_TRAINING_CONSENT_VERSION
    : EVALUATION_TELEMETRY_CONSENT_VERSION;
}

/** Applies the action to the server model exactly as the edge fn would:
 * a new row per action, folded to the latest per scope. */
function applyToServer(model: ServerModel, call: Call, nowIso: string): void {
  const scope = callScope(call);
  const action = callAction(call);
  if (!scope || !action) return;
  const row = model.rows[scope];
  row.lastAction = action;
  row.lastActionAt = nowIso;
  row.active = action === 'granted';
  if (action === 'granted') row.consentVersion = versionFor(scope);
}

type Expected =
  | { outcome: 'resolved'; value: ConsentStatus }
  | { outcome: 'error'; message: string };

function corruptFold(
  fault: Fault,
  good: ConsentStatus,
  rng: Rng,
): { body: unknown; expected: Expected } {
  const bad = (body: unknown): { body: unknown; expected: Expected } => ({
    body,
    expected: { outcome: 'error', message: MSG_INVALID },
  });
  const rowIndex = rng.int(0, good.scopes.length - 1);
  const withRow = (
    patch: (row: Record<string, unknown>) => Record<string, unknown> | unknown,
  ): unknown => ({
    ...good,
    scopes: good.scopes.map((row, i) =>
      i === rowIndex ? patch({ ...row }) : row,
    ),
  });
  switch (fault) {
    case 'ok_null':
      return bad(null);
    case 'ok_array':
      return bad(good.scopes);
    case 'ok_string':
      return bad('ok');
    case 'ok_scopes_missing':
      return bad({ subjectPseudonym: good.subjectPseudonym });
    case 'ok_scopes_object':
      return bad({ ...good, scopes: { model_training: good.scopes[0] } });
    case 'ok_subject_number':
      return bad({ ...good, subjectPseudonym: 42 });
    case 'ok_row_not_record':
      return bad(withRow(() => 'model_training'));
    case 'ok_row_bad_scope':
      return bad(withRow(row => ({ ...row, scope: 'ModelTraining' })));
    case 'ok_row_active_string':
      return bad(withRow(row => ({ ...row, active: 'true' })));
    case 'ok_row_active_missing':
      return bad(
        withRow(row => {
          delete row.active;
          return row;
        }),
      );
    case 'ok_row_bad_lastAction':
      return bad(withRow(row => ({ ...row, lastAction: 'revoked' })));
    case 'ok_row_lastAction_missing':
      return bad(
        withRow(row => {
          delete row.lastAction;
          return row;
        }),
      );
    case 'ok_row_bad_lastActionAt':
      return bad(withRow(row => ({ ...row, lastActionAt: Date.now() })));
    case 'ok_row_bad_version':
      return bad(withRow(row => ({ ...row, consentVersion: 1 })));
    case 'ok_scopes_partial': {
      // Legal: an older fold that omits scopes the account never touched.
      const partial = { ...good, scopes: good.scopes.slice(0, rowIndex + 1) };
      return {
        body: partial,
        expected: { outcome: 'resolved', value: partial },
      };
    }
    case 'ok_scopes_shuffled': {
      const order = [...good.scopes];
      for (let i = order.length - 1; i > 0; i -= 1) {
        const j = rng.int(0, i);
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
      const shuffled = { ...good, scopes: order };
      return {
        body: shuffled,
        expected: { outcome: 'resolved', value: shuffled },
      };
    }
    case 'ok_subject_null': {
      const nulled = { ...good, subjectPseudonym: null };
      return { body: nulled, expected: { outcome: 'resolved', value: nulled } };
    }
    default:
      throw new Error(`not a 2xx fold fault: ${fault}`);
  }
}

const HTTP_STATUS: Partial<Record<Fault, number>> = {
  http400: 400,
  http401: 401,
  http403: 403,
  http429: 429,
  http500: 500,
  http503: 503,
};

function plan(
  fault: Fault,
  model: ServerModel,
  call: Call,
  rng: Rng,
  nowIso: string,
): { wire: WireFault; expected: Expected; serverApplies: boolean } {
  const unavailable: Expected = { outcome: 'error', message: MSG_UNAVAILABLE };
  switch (fault) {
    case 'network':
      return {
        wire: { kind: 'network' },
        expected: unavailable,
        serverApplies: false,
      };
    case 'hang':
      // The socket stalled; whether the server recorded the action is
      // unknowable to the client, and the client must not assume either.
      return {
        wire: { kind: 'hang' },
        expected: unavailable,
        serverApplies: false,
      };
    case 'http_nonjson':
      return {
        wire: { kind: 'http_nonjson', status: 502 },
        expected: unavailable,
        serverApplies: false,
      };
    case 'ok_nonjson':
      return {
        wire: { kind: 'ok_nonjson' },
        expected: { outcome: 'error', message: MSG_INVALID },
        serverApplies: true,
      };
    default: {
      const status = HTTP_STATUS[fault];
      if (status !== undefined) {
        return {
          wire: {
            kind: 'http',
            status,
            body: {
              error: { code: 'consent.failed', message: `HTTP ${status}` },
            },
          },
          expected: unavailable,
          serverApplies: false,
        };
      }
      // A 2xx from the server: the action was recorded, then the fold is
      // delivered (possibly corrupted by the fault).
      const next: ServerModel = {
        subjectPseudonym: model.subjectPseudonym,
        rows: {
          video_analysis: { ...model.rows.video_analysis },
          model_training: { ...model.rows.model_training },
          evaluation_telemetry: { ...model.rows.evaluation_telemetry },
        },
      };
      applyToServer(next, call, nowIso);
      const good = fold(next, SCOPES);
      if (fault === 'none') {
        return {
          wire: { kind: 'ok', body: good },
          expected: { outcome: 'resolved', value: good },
          serverApplies: true,
        };
      }
      const corrupted = corruptFold(fault, good, rng);
      return {
        wire: { kind: 'ok', body: corrupted.body },
        expected: corrupted.expected,
        serverApplies: true,
      };
    }
  }
}

// ─── Executor ────────────────────────────────────────────────────────────────

function invoke(
  call: Call,
  session: ApiSession,
  device: string,
  fetchFn: FakeFetchFn,
): Promise<ConsentStatus> {
  switch (call) {
    case 'status':
      return fetchConsentStatus(session, fetchFn);
    case 'grantModelTraining':
      return grantModelTrainingConsent(session, device, fetchFn);
    case 'withdrawModelTraining':
      return withdrawModelTrainingConsent(session, device, fetchFn);
    case 'grantEvaluationTelemetry':
      return grantEvaluationTelemetryConsent(session, device, fetchFn);
    case 'withdrawEvaluationTelemetry':
      return withdrawEvaluationTelemetryConsent(session, device, fetchFn);
  }
}

type FakeFetchFn = ReturnType<typeof createFakeFetch>['fetchFn'];

function expectedEnvelope(
  call: Call,
  device: string,
): { method: string; path: string; body: unknown } {
  const scope = callScope(call);
  const action = callAction(call);
  if (!scope || !action) {
    return { method: 'GET', path: '/v1/me/consent/status', body: undefined };
  }
  if (action === 'granted') {
    return {
      method: 'POST',
      path: '/v1/me/consent/grant',
      body: {
        scope,
        consentVersion: versionFor(scope),
        source: 'mobile_settings',
        device,
        captureMode: 'all_captures',
      },
    };
  }
  return {
    method: 'POST',
    path: '/v1/me/consent/withdraw',
    body: { scope, source: 'mobile_settings', device },
  };
}

async function execute(
  actions: Action[],
  rng: Rng,
  seed: number,
): Promise<{
  trace: { step: number; action: string; outcome: string }[];
  violation: { step: number; message: string } | null;
}> {
  jest.useFakeTimers({ now: CLOCK_START + (seed % 1000) * 1000 });
  const trace: { step: number; action: string; outcome: string }[] = [];
  const violations: { step: number; message: string }[] = [];
  const fail = (step: number, message: string): void => {
    if (violations.length === 0) violations.push({ step, message });
  };

  const blank = (scope: ConsentScope): ScopeRow => ({
    scope,
    active: false,
    consentVersion: null,
    lastAction: null,
    lastActionAt: null,
  });
  const model: ServerModel = {
    subjectPseudonym: rng.chance(0.8) ? seededUuid(rng) : null,
    rows: {
      video_analysis: blank('video_analysis'),
      model_training: blank('model_training'),
      evaluation_telemetry: blank('evaluation_telemetry'),
    },
  };
  // video_analysis is granted server-side during bootstrap on most accounts;
  // this client never touches it.
  if (rng.chance(0.7)) {
    model.rows.video_analysis = {
      scope: 'video_analysis',
      active: true,
      consentVersion: 'video-analysis-v1',
      lastAction: 'granted',
      lastActionAt: new Date(Date.now() - 86_400_000).toISOString(),
    };
  }

  let bearerSerial = 0;
  const session: ApiSession = {
    apiBaseUrl: API_BASE,
    bearerToken: `bearer-${seed}-0`,
    canonicalAppUserId: seededUuid(rng),
    provider: rng.pick(['apple', 'google'] as const),
  };
  let device = `iOS phone ${rng.int(15, 19)}.${rng.int(0, 7)}`;
  const appVersion = getRuntimePublicConfig().appVersion;

  try {
    for (const [step, action] of actions.entries()) {
      let outcome: unknown;
      if (action.kind === 'rotateBearer') {
        bearerSerial += 1;
        session.bearerToken = `bearer-${seed}-${bearerSerial}`;
        outcome = { outcome: 'rotated', serial: bearerSerial };
      } else if (action.kind === 'setDevice') {
        device = action.device;
        outcome = { outcome: 'device' };
      } else {
        const fake = createFakeFetch();
        const nowIso = new Date(Date.now()).toISOString();
        const planned = plan(action.fault, model, action.call, rng, nowIso);
        fake.queue(planned.wire);
        const settled = await settle(
          invoke(action.call, session, device, fake.fetchFn),
          CONSENT_REQUEST_TIMEOUT_MS,
        );
        if (planned.serverApplies) applyToServer(model, action.call, nowIso);

        outcome =
          settled.kind === 'stuck'
            ? { outcome: 'stuck' }
            : settled.kind === 'resolved'
              ? { outcome: 'resolved', value: settled.value }
              : settled.error instanceof ConsentApiError
                ? {
                    outcome: 'error',
                    name: settled.error.name,
                    message: settled.error.message,
                  }
                : {
                    outcome: 'error',
                    foreign:
                      settled.error instanceof Error
                        ? `${settled.error.name}: ${settled.error.message}`
                        : String(settled.error),
                  };

        // ── C1 / C2 / C3 envelope ──
        if (fake.requests.length !== 1) {
          fail(
            step,
            `C1 expected exactly 1 request, saw ${fake.requests.length}`,
          );
        }
        const req = fake.requests[0];
        const envelope = expectedEnvelope(action.call, device);
        if (req) {
          if (req.url !== `${API_BASE}${envelope.path}`)
            fail(step, `C1 url ${req.url}`);
          if (req.method !== envelope.method)
            fail(step, `C1 method ${req.method}`);
          if (req.headers.Authorization !== `Bearer ${session.bearerToken}`) {
            fail(step, `C1 bearer ${req.headers.Authorization}`);
          }
          if (
            req.headers.Accept !== 'application/json' ||
            req.headers['Content-Type'] !== 'application/json' ||
            req.headers['X-Client-Version'] !== appVersion
          ) {
            fail(step, `C1 headers ${stable(req.headers)}`);
          }
          if (!req.hadSignal) fail(step, 'C1 no abort signal');
          if (stable(req.body) !== stable(envelope.body)) {
            fail(
              step,
              `C2 body ${stable(req.body)} ≠ ${stable(envelope.body)}`,
            );
          }
          if (envelope.body === undefined && req.rawBody !== undefined) {
            fail(step, 'C2 status must send no body');
          }
          if (req.url.endsWith('/grant')) {
            const tapped = callScope(action.call);
            const sentScope = (req.body as { scope?: unknown } | undefined)
              ?.scope;
            if (callAction(action.call) !== 'granted' || sentScope !== tapped) {
              fail(
                step,
                `C3 grant sent without an explicit tap: ${stable(req.body)}`,
              );
            }
            if (sentScope === 'video_analysis')
              fail(step, 'C3 video_analysis granted from settings client');
          }
        }

        // ── C4 / C5 outcome ──
        const expectedOutcome =
          planned.expected.outcome === 'resolved'
            ? { outcome: 'resolved', value: planned.expected.value }
            : {
                outcome: 'error',
                name: 'ConsentApiError',
                message: planned.expected.message,
              };
        if (stable(outcome) !== stable(expectedOutcome)) {
          fail(
            step,
            `C4/C5 outcome ${stable(outcome)} ≠ expected ${stable(expectedOutcome)}`,
          );
        }
        if (settled.kind === 'resolved') {
          for (const row of settled.value.scopes) {
            if (row.active !== (row.lastAction === 'granted')) {
              fail(
                step,
                `C5 latest-action-wins broken for ${row.scope}: ${stable(row)}`,
              );
            }
          }
        }
        if (
          settled.kind === 'rejected' &&
          !(settled.error instanceof ConsentApiError)
        ) {
          fail(step, `C4 foreign error escaped: ${stable(outcome)}`);
        }

        // ── C6 deadline / timers ──
        if (settled.kind === 'stuck')
          fail(step, 'C6 never settled after the deadline');
        else if (action.fault === 'hang' && !settled.pendingBeforeDeadline) {
          fail(step, 'C6 stalled request settled before 15 s');
        }
        if (jest.getTimerCount() !== 0) {
          fail(step, `C6 ${jest.getTimerCount()} timer(s) leaked`);
          jest.clearAllTimers();
        }
      }
      trace.push({
        step,
        action: describeAction(action),
        outcome: stable(outcome),
      });
      if (violations.length > 0) break;
    }
  } finally {
    jest.useRealTimers();
  }
  return { trace, violation: violations[0] ?? null };
}

function coverageKey(action: Action): string {
  return action.kind === 'call'
    ? `${action.call}:${action.fault}`
    : action.kind;
}

const spec: SequenceSpec<Action> = {
  generate,
  execute,
  describeAction,
  coverageKey,
};

describe('STRESS consent API client — seeded randomized sequences', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it(
    'holds C1–C7 on every seeded sequence (see STRESS_* knobs)',
    async () => {
      const config = campaignConfig();
      const output = await runCampaign('consent-api-randomized', spec, config);
      expect(describeFailures(output)).toBe('');
      expect(output.summary.sequencesExecuted).toBe(
        config.onlySeeds?.length ?? config.iterations,
      );
      expect(output.summary.nonDeterministicSeeds).toEqual([]);
    },
    20 * 60_000,
  );
});
