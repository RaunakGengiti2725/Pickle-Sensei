/**
 * Server-response scenario matrix — every mobile API call site × every
 * adversarial response class, served by a REAL loopback HTTP server.
 *
 * Contract under test (see __harness__/serverResponseMatrix/scenarios.ts):
 * no unhandled rejection, no fake success on unreadable 2xx bodies, no
 * resolution on non-2xx, retry classes per the outbox contract, and every
 * call settles even when the server never answers.
 *
 * Cells whose observed behaviour violates that contract on the audited
 * commit are pinned in KNOWN_VIOLATIONS (each with the finding that owns
 * it). The suite fails on any NEW violation and on any pinned violation
 * that no longer reproduces (so a fix must retire its entry).
 *
 * Artefacts (git-ignored): artifacts/server-response-matrix/<MATRIX_RUN_ID>/
 *   callSites.rows.json   — one replayable row per cell
 *   callSites.matrix.json — site × scenario verdict grid
 *   callSites.summary.json
 *   callSites.log
 * Replay one cell: MATRIX_FILTER='<site>::<scenario>' npx jest --ci <this file>
 * Fuzz depth: MATRIX_FUZZ_PER_SITE (default 60), seeds 1..N per site.
 */
import { CALL_SITES } from '../__harness__/serverResponseMatrix/callSites';
import {
  appendLog,
  cellSelected,
  createCellRunner,
  installMatrixSession,
  matrixTable,
  summarize,
  trackUnhandledRejections,
  writeArtifact,
  type CellRunner,
  type MatrixRow,
} from '../__harness__/serverResponseMatrix/runner';
import {
  startScenarioServer,
  type ScenarioServer,
} from '../__harness__/serverResponseMatrix/scenarioServer';
import {
  DETERMINISTIC_SCENARIOS,
  HANG_DEADLINE_MS,
  fuzzScenario,
} from '../__harness__/serverResponseMatrix/scenarios';

const TEST_FILE = '__tests__/serverResponseMatrix.callSites.test.ts';
const FUZZ_PER_SITE = Number(process.env['MATRIX_FUZZ_PER_SITE'] ?? 60);

/**
 * Contract violations reproduced on 4d812e1a. Each rule pins the exact
 * violation set for the cells it covers and names the finding that owns it;
 * a rule that stops matching any cell is stale (the fix must retire it).
 */
interface ViolationPin {
  finding: string;
  sites: (siteId: string) => boolean;
  scenarios: (scenarioId: string, judgedAs: string) => boolean;
  violations: string[];
}

const TRAINING = (id: string) => id.startsWith('training.');
const BILLING = (id: string) => id.startsWith('billing.');
const UNREADABLE_2XX = new Set([
  'malformed_2xx',
  'wrong_shape_2xx',
  'partial_2xx',
]);
/** 4xx cells whose body is not a JSON error envelope. */
const BODYLESS_4XX = new Set([
  'status_400_empty',
  'status_404_html',
  'status_405',
  'status_410',
]);

const KNOWN_VIOLATIONS: readonly ViolationPin[] = [
  {
    finding:
      'F1 body stall bypasses every client timeout: each client clears its AbortController timer in `finally` right after fetch() resolves with headers, so response.json() on a stalled body is unbounded (data/api.ts:96-99, account/bootstrap.ts:226, onboarding.ts:60, consentApi.ts:134, deletion.ts:127, sessionLifecycle.ts:49, progress/api.ts:160)',
    sites: id => id !== 'account.revokeApiSession',
    scenarios: id => id === 'hang_headers_only',
    violations: ['no_timeout'],
  },
  {
    finding:
      'F2 no request timeout at all: training/api.ts:426, billing/accessApi.ts:162, progress/playerRank.ts:139 call fetch without a signal; a server that never answers pends until the OS gives up',
    sites: id =>
      TRAINING(id) || BILLING(id) || id === 'progress.fetchPlayerRank',
    scenarios: id => id === 'hang_no_response',
    violations: ['no_timeout'],
  },
  {
    finding:
      'F3 GET /v1/me unreadable 2xx resolves null ("no profile on server"): onboarding.ts:61 `.json().catch(() => null)` + parseServerProfile → null; appStore.ts:148 then hydrates profile:null and routes the account into in-account onboarding instead of the CANONICAL_PROFILE_UNAVAILABLE state',
    sites: id => id === 'account.fetchCanonicalOnboardingProfile',
    scenarios: (_id, judgedAs) => UNREADABLE_2XX.has(judgedAs),
    violations: ['silent_null'],
  },
  {
    finding:
      'F4 body-before-status classification: training/api.ts:453 readJson() and account/bootstrap.ts:228 readPayload() throw a RETRYABLE invalid_response before the 4xx status is examined, so a 4xx with a non-JSON body (gateway HTML/empty) is classified transient (bootstrap: even a bodyless 401)',
    sites: id => TRAINING(id) || id === 'account.bootstrapCanonicalAccount',
    scenarios: (id, judgedAs) =>
      BODYLESS_4XX.has(id) ||
      (judgedAs === 'unauthorized' && id === 'status_401_empty'),
    violations: ['retry_class_permanent_expected'],
  },
  {
    finding:
      'OBS-1 (by design, not a finding) sessionLifecycle.ts:107 treats only 401/403 as terminal for POST /v1/auth/refresh; every other 4xx stays retryable because the edge fn only ever emits 401 or 5xx there (supabase/functions/api/index.ts:560-565)',
    sites: id => id === 'account.refreshApiSession',
    scenarios: (_id, judgedAs) => judgedAs === 'client_error',
    violations: ['retry_class_permanent_expected'],
  },
  {
    finding:
      'F5 (P3) data/api.ts:116 `return json as T` hands any 2xx body to the caller unvalidated; syncShots/uploadEvaluationTrials resolve null/{}/"ok"/[] — drainOutbox absorbs it as a TypeError → transient, no receipt, no attempt burned (pinned by serverResponseMatrix.outbox.test.ts)',
    sites: id =>
      id === 'data.transport.syncShots' ||
      id === 'data.transport.uploadEvaluationTrials',
    scenarios: (_id, judgedAs) => UNREADABLE_2XX.has(judgedAs),
    violations: ['fake_success'],
  },
];

function pinFor(row: MatrixRow): ViolationPin | undefined {
  const observed = [...row.violations].sort().join(',');
  return KNOWN_VIOLATIONS.find(
    pin =>
      pin.sites(row.site) &&
      pin.scenarios(row.scenario, row.judgedAs) &&
      [...pin.violations].sort().join(',') === observed,
  );
}

const rows: MatrixRow[] = [];
let server: ScenarioServer;
let session: ReturnType<typeof installMatrixSession>;
let rejections: ReturnType<typeof trackUnhandledRejections>;
let runner: CellRunner;

const cellKey = (row: MatrixRow) => `${row.site}::${row.scenario}`;

beforeAll(async () => {
  server = await startScenarioServer();
  session = installMatrixSession(server.baseUrl);
  rejections = trackUnhandledRejections();
  runner = createCellRunner(server, session, rejections, TEST_FILE);
  appendLog(
    'callSites.log',
    `server ${server.baseUrl} sites=${CALL_SITES.length} deterministic=${DETERMINISTIC_SCENARIOS.length} fuzzPerSite=${FUZZ_PER_SITE}`,
  );
});

afterAll(async () => {
  const summary = summarize(rows);
  const files = [
    writeArtifact('callSites.rows.json', rows),
    writeArtifact(
      'callSites.matrix.json',
      matrixTable(rows.filter(row => row.class !== 'fuzz')),
    ),
    writeArtifact('callSites.summary.json', {
      ...summary,
      knownViolations: KNOWN_VIOLATIONS.map(pin => ({
        finding: pin.finding,
        violations: pin.violations,
        cells: rows.filter(row => pinFor(row) === pin).map(cellKey),
      })),
      callSites: CALL_SITES.map(site => ({
        id: site.id,
        family: site.family,
        method: site.method,
        path: site.path,
        source: site.source,
        consumer: site.consumer,
        returns: site.returns,
      })),
      scenarios: DETERMINISTIC_SCENARIOS.map(scenario => ({
        id: scenario.id,
        class: scenario.class,
        judgeAs: scenario.judgeAs ?? scenario.class,
        description: scenario.description,
      })),
    }),
  ];
  appendLog(
    'callSites.log',
    `rows=${rows.length} settlement=${JSON.stringify(summary.bySettlement)} violations=${JSON.stringify(summary.byViolation)} artefacts=${files.join(',')}`,
  );
  session.teardown();
  rejections.uninstall();
  await server.close();
});

const sequentialScenarios = DETERMINISTIC_SCENARIOS.filter(
  scenario => scenario.class !== 'hang',
);
const hangScenarios = DETERMINISTIC_SCENARIOS.filter(
  scenario => scenario.class === 'hang',
);

describe.each(CALL_SITES.map(site => [site.id, site] as const))(
  '%s',
  (_id, site) => {
    test('deterministic response classes', async () => {
      for (const scenario of sequentialScenarios) {
        if (!cellSelected(site, scenario)) continue;
        const row = await runner.run(site, scenario);
        rows.push(row);
        appendLog(
          'callSites.log',
          `${cellKey(row)} ${row.settlement} ${row.error?.name ?? row.resolvedKind ?? ''} retryable=${row.retryable} ${row.durationMs}ms viol=${row.violations.join('|')}`,
        );
      }
    }, 120_000);

    test(`seeded fuzz ×${FUZZ_PER_SITE}`, async () => {
      for (let seed = 1; seed <= FUZZ_PER_SITE; seed += 1) {
        const scenario = fuzzScenario(site, seed);
        if (!cellSelected(site, scenario)) continue;
        const row = await runner.run(site, scenario);
        rows.push(row);
        if (
          row.settlement !== 'rejected' ||
          row.violations.length > 0 ||
          row.error?.untyped
        ) {
          appendLog(
            'callSites.log',
            `${cellKey(row)} seed=${seed} ${row.description} → ${row.settlement}:${row.resolvedKind ?? row.error?.name} viol=${row.violations.join('|')}`,
          );
        }
      }
    }, 120_000);
  },
);

test(
  'hang scenarios: every call site settles before the 25 s deadline',
  async () => {
    for (const scenario of hangScenarios) {
      server.respondWith(
        scenario.build(CALL_SITES[0] as (typeof CALL_SITES)[number]),
      );
      server.resetLog();
      session.reset();
      rejections.reset();
      const batch = await Promise.all(
        CALL_SITES.filter(site => cellSelected(site, scenario)).map(site =>
          runner.run(site, scenario, { shared: true }),
        ),
      );
      for (const row of batch) {
        rows.push(row);
        appendLog(
          'callSites.log',
          `${cellKey(row)} ${row.settlement} ${row.error?.name ?? row.resolvedKind ?? ''} ${row.durationMs}ms viol=${row.violations.join('|')}`,
        );
      }
    }
  },
  HANG_DEADLINE_MS * hangScenarios.length + 20_000,
);

test('matrix verdict: every violation is pinned to a finding, no stale pin', () => {
  const matched = new Set<ViolationPin>();
  const unpinned: string[] = [];
  for (const row of rows) {
    if (row.violations.length === 0) continue;
    const pin = pinFor(row);
    if (pin) matched.add(pin);
    else
      unpinned.push(
        `${cellKey(row)} (${row.judgedAs}) → ${row.violations.join(',')}`,
      );
  }
  const filterActive = Boolean(process.env['MATRIX_FILTER']);
  const stale = filterActive
    ? []
    : KNOWN_VIOLATIONS.filter(pin => !matched.has(pin)).map(pin => pin.finding);
  expect(unpinned).toEqual([]);
  expect(stale).toEqual([]);
});

test('no cell produced an unhandled rejection; hangs are only the pinned timeout gaps', () => {
  const unhandled = rows
    .filter(row => row.unhandledRejections > 0)
    .map(cellKey);
  const hung = rows
    .filter(row => row.settlement === 'hung' && !pinFor(row))
    .map(cellKey);
  expect(unhandled).toEqual([]);
  expect(hung).toEqual([]);
});

test('every non-2xx status rejects (no resolution on an error status)', () => {
  const resolvedOnError = rows
    .filter(row => row.violations.includes('resolved_on_error_status'))
    .map(cellKey);
  expect(resolvedOnError).toEqual([]);
});

test('duplicate identical successes: two answers → two independent settlements, no extra request', () => {
  const duplicates = rows.filter(row => row.scenario === 'ok_duplicate_x2');
  expect(duplicates.length).toBeGreaterThan(0);
  for (const row of duplicates) {
    expect(row.settlement).toBe('resolved');
    expect(row.requestsSeen).toBe(2);
  }
});
