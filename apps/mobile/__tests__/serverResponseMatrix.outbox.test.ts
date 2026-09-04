/**
 * Server-response matrix — the DURABLE OUTBOX boundary.
 *
 * The call-site matrix proves what each transport promise does. This suite
 * proves what `drainOutbox()` (src/data/sync.ts) does with it: for every
 * adversarial response class served by the real loopback server through the
 * real `createTransport`, the queue must end in exactly the state the outbox
 * contract prescribes —
 *   - accepted rows: one sync_receipt + one DELETE, inside one transaction;
 *   - permanent failures (4xx except 401/408/429, contract rejections):
 *     row kept, attempts +1;
 *   - transient failures (401/408/429/5xx/reset/unreadable 2xx bodies,
 *     transient rejection codes): row kept, attempts unchanged;
 *   - duplicate / replayed / conflicting acknowledgements never produce a
 *     second receipt or a second delete, and never delete a row the server
 *     did not acknowledge.
 *
 * Artefacts: artifacts/server-response-matrix/<MATRIX_RUN_ID>/outbox.rows.json
 * Replay one class: MATRIX_FILTER='outbox::<scenario>' npx jest --ci <this file>
 */
import { createTransport } from '../src/data/api';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import { drainOutbox, OUTBOX_MAX_ATTEMPTS } from '../src/data/sync';
import {
  CALL_SITES,
  HARNESS_UUID,
  HARNESS_UUID_2,
  HARNESS_UUID_3,
  type CallSite,
} from '../__harness__/serverResponseMatrix/callSites';
import { createFakeOutboxDb } from '../__harness__/serverResponseMatrix/outboxFakeDb';
import {
  appendLog,
  installMatrixSession,
  MATRIX_TOKEN,
  trackUnhandledRejections,
  writeArtifact,
} from '../__harness__/serverResponseMatrix/runner';
import {
  startScenarioServer,
  type RecordedRequest,
  type ScenarioResponse,
  type ScenarioServer,
} from '../__harness__/serverResponseMatrix/scenarioServer';
import {
  DETERMINISTIC_SCENARIOS,
  type MatrixScenario,
  type ScenarioClass,
} from '../__harness__/serverResponseMatrix/scenarios';

const SHOT_A = HARNESS_UUID;
const SHOT_B = '3c4d5e6f-7081-4a9b-bc22-ccddeeff0011';
const SESSION_ID = HARNESS_UUID_2;
const TRIAL_ID = HARNESS_UUID_3;
const PERMIT_ID = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OWNER = GUEST_DATA_OWNER;

const analysis = (id: string) => ({
  id,
  analysisPermitId: PERMIT_ID,
  sessionId: SESSION_ID,
  shotType: 'forehand_drive',
  cameraView: 'side',
  handedness: 'right',
  capturedAtIso: '2026-08-26T18:00:00.000Z',
  timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
  phases: [],
  measurements: [],
  checkpoints: [],
  overallScore: 7.4,
  analysisConfidence: 0.9,
  resultKind: 'scored',
  guidance: null,
  priorityFix: null,
  versionVector: {
    appVersion: '0.1.0',
    modelBundleVersion: 'test-native-1',
    poseModelVersion: 'test-pose-1',
    paddleModelVersion: 'test-paddle-1',
    strokeDetectorVersion: 'test-stroke-1',
    phaseModelVersion: 'test-phase-1',
    scoringModelVersion: 'sm-v1',
    shotConfigVersion: 'forehand_drive@1',
  },
  source: 'real',
});

/** The good acknowledgement for each outbox endpoint, keyed by request path. */
const GOOD_BY_PATH: Record<string, unknown> = {
  '/v1/sessions': { id: SESSION_ID },
  [`/v1/sessions/${SESSION_ID}/finalize`]: {
    id: SESSION_ID,
    endedAt: '2026-08-26T18:10:00.000Z',
  },
  '/v1/shots:sync': { acceptedIds: [SHOT_A, SHOT_B], rejected: [] },
  '/v1/me/evaluation/trials': { acceptedTrialIds: [TRIAL_ID], rejected: [] },
};

function siteFor(request: RecordedRequest): CallSite {
  const template =
    CALL_SITES.find(
      site => site.family === 'outbox' && request.url === site.path,
    ) ?? CALL_SITES.find(site => site.id === 'data.transport.finalizeSession');
  if (!template) throw new Error(`no outbox call site for ${request.url}`);
  const good = GOOD_BY_PATH[request.url];
  return {
    ...template,
    good: good === undefined ? template.good : { body: good },
  };
}

type QueueRow = 'session' | 'finalize' | 'shotA' | 'shotB' | 'trial';
const VOID_ROWS: QueueRow[] = ['session', 'finalize'];
const SHOT_ROWS: QueueRow[] = ['shotA', 'shotB'];
const BATCH_ROWS: QueueRow[] = [...SHOT_ROWS, 'trial'];
const ALL_ROWS: QueueRow[] = [...VOID_ROWS, ...BATCH_ROWS];

interface OutboxExpectation {
  /** Rows that must be gone after the drain. */
  deleted: QueueRow[];
  /** Rows that must remain, with the attempts they must show. */
  kept: Array<[QueueRow, number]>;
  /** Receipt entity ids expected, in order. */
  receipts: string[];
  /** Kept rows whose `last_error` must match (the reason a row was held). */
  lastError?: Array<[QueueRow, RegExp]>;
}

const kept = (rows: QueueRow[], attempts: number): Array<[QueueRow, number]> =>
  rows.map(row => [row, attempts]);

type OutboxClass = Exclude<ScenarioClass, 'hang' | 'fuzz' | 'duplicate'>;

function expectationFor(judgedAs: OutboxClass): OutboxExpectation {
  switch (judgedAs) {
    case 'ok':
      return { deleted: ALL_ROWS, kept: [], receipts: [SHOT_A, SHOT_B] };
    case 'client_error':
      // The void rows and the trial batch are refused and charged. The shots
      // belong to the set whose `session.create` was just refused with
      // budget left: they are held uncharged (no `/v1/shots:sync` call — the
      // server would answer `shot.session_not_found`) with the reason on the
      // row, until the set is asked for again (fix8 S1/V1).
      return {
        deleted: [],
        kept: [...kept([...VOID_ROWS, 'trial'], 1), ...kept(SHOT_ROWS, 0)],
        receipts: [],
        lastError: SHOT_ROWS.map(row => [row, /^shot\.session_not_found: /]),
      };
    case 'unauthorized':
    case 'timeout_408':
    case 'rate_limited':
    case 'server_error':
    case 'reset':
      return { deleted: [], kept: kept(ALL_ROWS, 0), receipts: [] };
    case 'malformed_2xx':
    case 'wrong_shape_2xx':
    case 'partial_2xx':
    case 'oversized_2xx':
      // `createSession`/`finalizeSession` return void, so ANY 2xx completes
      // them (the body is never consulted); the shot/trial batches must
      // fall back to transient (no receipt, no attempt burned).
      return { deleted: VOID_ROWS, kept: kept(BATCH_ROWS, 0), receipts: [] };
  }
}

interface OutboxRow {
  scenario: string;
  class: string;
  judgedAs: string;
  description: string;
  durationMs: number;
  settlement: 'resolved' | 'rejected' | 'hung';
  result: { synced: number; failed: number; remaining: number } | null;
  error: string | null;
  requests: string[];
  outboxAfter: Array<{
    id: number;
    kind: string;
    attempts: number;
    last_error: string | null;
  }>;
  receipts: number;
  unauthorizedReports: number;
  unhandledRejections: number;
  violations: string[];
  replay: string;
}

const TEST_FILE = '__tests__/serverResponseMatrix.outbox.test.ts';
const rows: OutboxRow[] = [];
let server: ScenarioServer;
let session: ReturnType<typeof installMatrixSession>;
let rejections: ReturnType<typeof trackUnhandledRejections>;

function selected(scenarioId: string): boolean {
  const filter = process.env['MATRIX_FILTER'];
  if (!filter) return true;
  const [siteFilter = '*', scenarioFilter = '*'] = filter.split('::');
  return (
    (siteFilter === '*' || siteFilter === 'outbox') &&
    (scenarioFilter === '*' || scenarioFilter === scenarioId)
  );
}

function seedQueue(shots: { setless: boolean } = { setless: false }) {
  const fake = createFakeOutboxDb();
  const shot = (id: string) =>
    shots.setless ? { ...analysis(id), sessionId: null } : analysis(id);
  const ids = {
    session: fake.push(
      'session.create',
      { id: SESSION_ID, startedAt: '2026-08-26T18:00:00.000Z' },
      OWNER,
    ),
    finalize: fake.push('session.finalize', { id: SESSION_ID }, OWNER),
    shotA: fake.push('shot.sync', shot(SHOT_A), OWNER),
    shotB: fake.push('shot.sync', shot(SHOT_B), OWNER),
    trial: fake.push(
      'evaluation.trial',
      { trialId: TRIAL_ID, capturedAt: '2026-08-26T18:00:00.000Z' },
      OWNER,
    ),
  };
  return { fake, ids };
}

const HUNG = Symbol('hung');
async function drainWithDeadline(
  fake: ReturnType<typeof createFakeOutboxDb>,
  deadlineMs: number,
) {
  const transport = createTransport({
    baseUrl: server.baseUrl,
    token: MATRIX_TOKEN,
  });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<typeof HUNG>(resolve => {
    timer = setTimeout(() => resolve(HUNG), deadlineMs);
  });
  try {
    const outcome = await Promise.race([
      drainOutbox(fake.db, transport).then(
        result => ({ settlement: 'resolved' as const, result, error: null }),
        (error: unknown) => ({
          settlement: 'rejected' as const,
          result: null,
          error: String(error),
        }),
      ),
      deadline,
    ]);
    if (outcome === HUNG)
      return { settlement: 'hung' as const, result: null, error: null };
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function judgeOutbox(
  expectation: OutboxExpectation,
  ids: ReturnType<typeof seedQueue>['ids'],
  fake: ReturnType<typeof createFakeOutboxDb>,
  outcome: Awaited<ReturnType<typeof drainWithDeadline>>,
  unhandled: number,
): string[] {
  const violations: string[] = [];
  if (unhandled > 0) violations.push('unhandled_rejection');
  if (outcome.settlement === 'hung') return [...violations, 'no_timeout'];
  if (outcome.settlement === 'rejected') violations.push('drain_rejected');
  const remaining = new Map(fake.outbox.map(row => [row.id, row] as const));
  for (const name of expectation.deleted) {
    if (remaining.has(ids[name])) violations.push(`${name}_not_deleted`);
  }
  for (const [name, attempts] of expectation.kept) {
    const row = remaining.get(ids[name]);
    if (!row) {
      violations.push(`${name}_deleted_without_ack`);
      continue;
    }
    if (row.attempts !== attempts)
      violations.push(`${name}_attempts_${row.attempts}_expected_${attempts}`);
  }
  for (const [name, pattern] of expectation.lastError ?? []) {
    const row = remaining.get(ids[name]);
    if (row && !pattern.test(String(row.last_error ?? '')))
      violations.push(`${name}_last_error_${JSON.stringify(row.last_error)}`);
  }
  const receiptIds = fake.receipts.map(receipt => receipt.entityId);
  if (receiptIds.join(',') !== expectation.receipts.join(','))
    violations.push(
      `receipts_[${receiptIds.join(',')}]_expected_[${expectation.receipts.join(',')}]`,
    );
  if (new Set(receiptIds).size !== receiptIds.length)
    violations.push('duplicate_receipt');
  return violations;
}

beforeAll(async () => {
  server = await startScenarioServer();
  session = installMatrixSession(server.baseUrl);
  rejections = trackUnhandledRejections();
  setActiveDataOwner(OWNER);
});

afterAll(async () => {
  writeArtifact('outbox.rows.json', rows);
  appendLog(
    'outbox.log',
    `rows=${rows.length} violations=${rows.filter(row => row.violations.length > 0).length}`,
  );
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  session.teardown();
  rejections.uninstall();
  await server.close();
});

const OUTBOX_SCENARIOS = DETERMINISTIC_SCENARIOS.filter(
  scenario => scenario.class !== 'hang' && scenario.class !== 'duplicate',
);

async function runScenario(
  scenario: Pick<
    MatrixScenario,
    'id' | 'class' | 'description' | 'deadlineMs'
  > & { judgeAs?: ScenarioClass },
  respond: (request: RecordedRequest, ordinal: number) => ScenarioResponse,
  expectation: OutboxExpectation,
  prepared = seedQueue(),
): Promise<OutboxRow> {
  const { fake, ids } = prepared;
  server.respondWith(respond);
  server.resetLog();
  session.reset();
  rejections.reset();
  const started = Date.now();
  const outcome = await drainWithDeadline(fake, scenario.deadlineMs);
  // Let any detached continuation surface before we read the counter.
  await new Promise(resolve => setImmediate(resolve));
  const unhandled = rejections.count();
  const row: OutboxRow = {
    scenario: scenario.id,
    class: scenario.class,
    judgedAs: scenario.judgeAs ?? scenario.class,
    description: scenario.description,
    durationMs: Date.now() - started,
    settlement: outcome.settlement,
    result: outcome.result,
    error: outcome.error,
    requests: server.requests.map(
      request => `${request.method} ${request.url}`,
    ),
    outboxAfter: fake.snapshot(),
    receipts: fake.receipts.length,
    unauthorizedReports: session.unauthorizedReports(),
    unhandledRejections: unhandled,
    violations: judgeOutbox(expectation, ids, fake, outcome, unhandled),
    replay: `cd apps/mobile && MATRIX_FILTER='outbox::${scenario.id}' npx jest --ci ${TEST_FILE}`,
  };
  rows.push(row);
  appendLog(
    'outbox.log',
    `${row.scenario} ${row.settlement} ${JSON.stringify(row.result)} receipts=${row.receipts} viol=${row.violations.join('|')}`,
  );
  return row;
}

describe('drainOutbox × every deterministic response class (real transport, real HTTP)', () => {
  for (const scenario of OUTBOX_SCENARIOS) {
    const judgedAs = (scenario.judgeAs ?? scenario.class) as OutboxClass;
    test(
      `${scenario.id} (${judgedAs}): ${scenario.description}`,
      async () => {
        if (!selected(scenario.id)) return;
        const row = await runScenario(
          scenario,
          request => scenario.build(siteFor(request)),
          expectationFor(judgedAs),
        );
        expect(row.violations).toEqual([]);
        expect(row.settlement).toBe('resolved');
        if (judgedAs === 'unauthorized') {
          // One 401 per request; the void rows and both batches each report once.
          expect(row.unauthorizedReports).toBe(row.requests.length);
        }
        if (judgedAs === 'client_error') {
          // The shots above are held behind their refused set, so the same
          // response is also judged on shots that belong to no set: the
          // `/v1/shots:sync` refusal itself is charged once per row.
          const setless = await runScenario(
            { ...scenario, id: `${scenario.id}__setless_shots` },
            request => scenario.build(siteFor(request)),
            { deleted: [], kept: kept(ALL_ROWS, 1), receipts: [] },
            seedQueue({ setless: true }),
          );
          expect(setless.violations).toEqual([]);
          expect(setless.requests).toContain('POST /v1/shots:sync');
        }
      },
      scenario.deadlineMs + 5_000,
    );
  }
});

describe('duplicate / replayed / conflicting acknowledgements', () => {
  const dup = (id: string, description: string) => ({
    id,
    class: 'duplicate' as const,
    description,
    deadlineMs: 8_000,
  });

  test('D1 identical success answered twice: second drain sends nothing, receipts stay at 2', async () => {
    if (!selected('dup_second_drain_idempotent')) return;
    const prepared = seedQueue();
    const first = await runScenario(
      dup(
        'dup_second_drain_idempotent',
        'same acceptance served to every request; drain twice',
      ),
      request => ({
        kind: 'json',
        body:
          GOOD_BY_PATH[request.url] ??
          GOOD_BY_PATH[`/v1/sessions/${SESSION_ID}/finalize`],
      }),
      { deleted: ALL_ROWS, kept: [], receipts: [SHOT_A, SHOT_B] },
      prepared,
    );
    expect(first.violations).toEqual([]);
    const receiptStatements = prepared.fake.statements.filter(sql =>
      sql.includes('INSERT OR REPLACE INTO sync_receipt'),
    ).length;
    expect(receiptStatements).toBe(2);
    server.resetLog();
    const again = await drainOutbox(
      prepared.fake.db,
      createTransport({ baseUrl: server.baseUrl, token: MATRIX_TOKEN }),
    );
    expect(again).toEqual({ synced: 0, failed: 0, remaining: 0 });
    expect(server.requests).toHaveLength(0);
    expect(prepared.fake.receipts).toHaveLength(2);
  });

  test('D2 acceptedIds lists the same shot twice: one receipt, one delete per shot', async () => {
    if (!selected('dup_accepted_id_twice')) return;
    const prepared = seedQueue();
    const row = await runScenario(
      dup('dup_accepted_id_twice', 'acceptedIds: [A, A, B, B]'),
      request =>
        request.url === '/v1/shots:sync'
          ? {
              kind: 'json',
              body: {
                acceptedIds: [SHOT_A, SHOT_A, SHOT_B, SHOT_B],
                rejected: [],
              },
            }
          : {
              kind: 'json',
              body:
                GOOD_BY_PATH[request.url] ??
                GOOD_BY_PATH[`/v1/sessions/${SESSION_ID}/finalize`],
            },
      { deleted: ALL_ROWS, kept: [], receipts: [SHOT_A, SHOT_B] },
      prepared,
    );
    expect(row.violations).toEqual([]);
    expect(
      prepared.fake.statements.filter(sql =>
        sql.startsWith('DELETE FROM outbox'),
      ).length,
    ).toBe(5);
  });

  test('D3 shot listed as BOTH accepted and rejected: accepted wins exactly once, no attempt burned', async () => {
    if (!selected('dup_accepted_and_rejected')) return;
    const prepared = seedQueue();
    const row = await runScenario(
      dup(
        'dup_accepted_and_rejected',
        'A accepted AND rejected(shot.invalid); B accepted',
      ),
      request =>
        request.url === '/v1/shots:sync'
          ? {
              kind: 'json',
              body: {
                acceptedIds: [SHOT_A, SHOT_B],
                rejected: [
                  { id: SHOT_A, code: 'shot.invalid', message: 'conflict' },
                ],
              },
            }
          : {
              kind: 'json',
              body:
                GOOD_BY_PATH[request.url] ??
                GOOD_BY_PATH[`/v1/sessions/${SESSION_ID}/finalize`],
            },
      { deleted: ALL_ROWS, kept: [], receipts: [SHOT_A, SHOT_B] },
      prepared,
    );
    expect(row.violations).toEqual([]);
  });

  test('D4 replayed STALE acknowledgement (ids of another batch): nothing deleted, no receipt; unacknowledged shots burn one attempt (permanent by contract)', async () => {
    if (!selected('dup_stale_replay')) return;
    const prepared = seedQueue();
    const row = await runScenario(
      dup('dup_stale_replay', 'acceptedIds names a shot we never sent'),
      request =>
        request.url === '/v1/shots:sync'
          ? {
              kind: 'json',
              body: {
                acceptedIds: ['9999aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'],
                rejected: [],
              },
            }
          : request.url === '/v1/me/evaluation/trials'
            ? {
                kind: 'json',
                body: {
                  acceptedTrialIds: ['9999aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'],
                  rejected: [],
                },
              }
            : {
                kind: 'json',
                body:
                  GOOD_BY_PATH[request.url] ??
                  GOOD_BY_PATH[`/v1/sessions/${SESSION_ID}/finalize`],
              },
      { deleted: VOID_ROWS, kept: kept(BATCH_ROWS, 1), receipts: [] },
      prepared,
    );
    expect(row.violations).toEqual([]);
    const shotRows = prepared.fake.outbox.filter(r => r.kind === 'shot.sync');
    expect(shotRows.map(r => r.last_error)).toEqual([
      'shot.sync_unacknowledged',
      'shot.sync_unacknowledged',
    ]);
    expect(
      prepared.fake.outbox.find(r => r.kind === 'evaluation.trial')?.last_error,
    ).toBe('evaluation.trial_unacknowledged');
  });

  test('D5 stale replay repeated OUTBOX_MAX_ATTEMPTS times abandons the shot rows from sync (local data intact, row stays in table)', async () => {
    if (!selected('dup_stale_replay_exhausts')) return;
    const prepared = seedQueue();
    server.respondWith(request =>
      request.url === '/v1/shots:sync'
        ? { kind: 'json', body: { acceptedIds: [], rejected: [] } }
        : {
            kind: 'json',
            body:
              GOOD_BY_PATH[request.url] ??
              GOOD_BY_PATH[`/v1/sessions/${SESSION_ID}/finalize`],
          },
    );
    const transport = createTransport({
      baseUrl: server.baseUrl,
      token: MATRIX_TOKEN,
    });
    const trail: Array<{ synced: number; failed: number; remaining: number }> =
      [];
    for (let attempt = 0; attempt < OUTBOX_MAX_ATTEMPTS + 1; attempt += 1) {
      trail.push(await drainOutbox(prepared.fake.db, transport));
    }
    const shotRows = prepared.fake.outbox.filter(r => r.kind === 'shot.sync');
    expect(shotRows.map(r => r.attempts)).toEqual([
      OUTBOX_MAX_ATTEMPTS,
      OUTBOX_MAX_ATTEMPTS,
    ]);
    // The 9th drain no longer selects them (attempts < OUTBOX_MAX_ATTEMPTS).
    expect(trail[OUTBOX_MAX_ATTEMPTS]).toEqual({
      synced: 0,
      failed: 0,
      remaining: 2,
    });
    expect(prepared.fake.receipts).toHaveLength(0);
    rows.push({
      scenario: 'dup_stale_replay_exhausts',
      class: 'duplicate',
      judgedAs: 'duplicate',
      description: `{acceptedIds:[],rejected:[]} × ${OUTBOX_MAX_ATTEMPTS + 1} drains`,
      durationMs: 0,
      settlement: 'resolved',
      result: trail[OUTBOX_MAX_ATTEMPTS] ?? null,
      error: null,
      requests: [`trail=${JSON.stringify(trail)}`],
      outboxAfter: prepared.fake.snapshot(),
      receipts: 0,
      unauthorizedReports: 0,
      unhandledRejections: rejections.count(),
      violations: [],
      replay: `cd apps/mobile && MATRIX_FILTER='outbox::dup_stale_replay_exhausts' npx jest --ci ${TEST_FILE}`,
    });
  });

  test('D6 partial acceptance with a transient rejection: accepted row deleted with a receipt, rejected row keeps its budget', async () => {
    if (!selected('partial_ack_transient_rejection')) return;
    const prepared = seedQueue();
    const row = await runScenario(
      dup(
        'partial_ack_transient_rejection',
        'A accepted; B rejected shot.write_failed',
      ),
      request =>
        request.url === '/v1/shots:sync'
          ? {
              kind: 'json',
              body: {
                acceptedIds: [SHOT_A],
                rejected: [
                  { id: SHOT_B, code: 'shot.write_failed', message: 'db' },
                ],
              },
            }
          : {
              kind: 'json',
              body:
                GOOD_BY_PATH[request.url] ??
                GOOD_BY_PATH[`/v1/sessions/${SESSION_ID}/finalize`],
            },
      {
        deleted: ['session', 'finalize', 'shotA', 'trial'],
        kept: [['shotB', 0]],
        receipts: [SHOT_A],
      },
      prepared,
    );
    expect(row.violations).toEqual([]);
    expect(
      prepared.fake.outbox.map(r => [r.kind, r.attempts, r.last_error]),
    ).toEqual([['shot.sync', 0, 'shot.write_failed: db']]);
  });

  test('D7 partial acceptance with a PERMANENT rejection: rejected row burns exactly one attempt', async () => {
    if (!selected('partial_ack_permanent_rejection')) return;
    const prepared = seedQueue();
    const row = await runScenario(
      dup(
        'partial_ack_permanent_rejection',
        'A accepted; B rejected shot.invalid',
      ),
      request =>
        request.url === '/v1/shots:sync'
          ? {
              kind: 'json',
              body: {
                acceptedIds: [SHOT_A],
                rejected: [
                  { id: SHOT_B, code: 'shot.invalid', message: 'bad' },
                ],
              },
            }
          : {
              kind: 'json',
              body:
                GOOD_BY_PATH[request.url] ??
                GOOD_BY_PATH[`/v1/sessions/${SESSION_ID}/finalize`],
            },
      {
        deleted: ['session', 'finalize', 'shotA', 'trial'],
        kept: [['shotB', 1]],
        receipts: [SHOT_A],
      },
      prepared,
    );
    expect(row.violations).toEqual([]);
  });
});

test('no drain produced an unhandled rejection or hung', () => {
  expect(
    rows.filter(row => row.unhandledRejections > 0).map(row => row.scenario),
  ).toEqual([]);
  expect(
    rows.filter(row => row.settlement === 'hung').map(row => row.scenario),
  ).toEqual([]);
});
