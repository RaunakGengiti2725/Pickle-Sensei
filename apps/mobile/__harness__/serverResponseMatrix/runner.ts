/// <reference types="node" />
/**
 * Executes (call site × scenario) cells against the scenario server, records
 * a replayable row per cell and writes JSON artefacts under
 * `artifacts/server-response-matrix/<run>/` (git-ignored).
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  establishApiSession,
  clearApiSession,
  setApiUnauthorizedListener,
} from '../../src/account/apiSession';
import {
  classifyError,
  type CallSite,
  type ClassifiedError,
  type InvokeContext,
} from './callSites';
import type { ScenarioResponse, ScenarioServer } from './scenarioServer';
import {
  judge,
  type MatrixScenario,
  type ObservedOutcome,
  type Settlement,
  type Violation,
} from './scenarios';

export const MATRIX_TOKEN = 'harness-bearer-token';
export const MATRIX_APP_USER = 'harness-canonical-app-user';

export interface MatrixRow {
  site: string;
  family: CallSite['family'];
  source: string;
  consumer: string;
  returns: CallSite['returns'];
  scenario: string;
  class: MatrixScenario['class'];
  judgedAs: MatrixScenario['class'];
  seed: number | null;
  description: string;
  response: {
    kind: ScenarioResponse['kind'];
    status: number | null;
    bodyBytes: number | null;
    headers: Record<string, string> | null;
  };
  requestsSeen: number;
  requestPaths: string[];
  settlement: Settlement;
  resolvedKind: ObservedOutcome['resolvedKind'];
  resolvedPreview: string | null;
  error: ClassifiedError | null;
  retryable: boolean | null;
  unauthorizedReports: number;
  unhandledRejections: number;
  durationMs: number;
  heapDeltaBytes: number;
  violations: Violation[];
  replay: string;
}

function summarizeResponse(response: ScenarioResponse): MatrixRow['response'] {
  switch (response.kind) {
    case 'status':
      return {
        kind: response.kind,
        status: response.status,
        bodyBytes:
          response.body === undefined
            ? 0
            : Buffer.byteLength(JSON.stringify(response.body)),
        headers: response.headers ?? null,
      };
    case 'json':
      return {
        kind: response.kind,
        status: response.status ?? 200,
        bodyBytes:
          response.body === undefined
            ? 0
            : Buffer.byteLength(JSON.stringify(response.body)),
        headers: null,
      };
    case 'raw':
      return {
        kind: response.kind,
        status: response.status ?? 200,
        bodyBytes: Buffer.byteLength(response.body),
        headers: { 'content-type': response.contentType ?? 'application/json' },
      };
    case 'truncated':
      return {
        kind: response.kind,
        status: response.status ?? 200,
        bodyBytes: response.sendBytes,
        headers: { 'content-length': String(Buffer.byteLength(response.body)) },
      };
    case 'prefix':
      return {
        kind: response.kind,
        status: response.status ?? 200,
        bodyBytes: Math.min(response.cut, Buffer.byteLength(response.body)),
        headers: null,
      };
    case 'hang':
      return {
        kind: response.kind,
        status: response.mode === 'headers_only' ? 200 : null,
        bodyBytes: null,
        headers: null,
      };
    case 'reset':
      return {
        kind: response.kind,
        status: null,
        bodyBytes: null,
        headers: null,
      };
  }
}

function preview(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    const text = JSON.stringify(value);
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch (error) {
    // Deeply nested arrays overflow both JSON.stringify and Array#toString.
    return `<unserialisable ${Object.prototype.toString.call(value)}: ${error instanceof RangeError ? 'RangeError' : String(error)}>`;
  }
}

export interface UnhandledRejectionTracker {
  count(): number;
  reset(): void;
  uninstall(): void;
}

export function trackUnhandledRejections(): UnhandledRejectionTracker {
  let count = 0;
  const listener = () => {
    count += 1;
  };
  process.on('unhandledRejection', listener);
  return {
    count: () => count,
    reset: () => {
      count = 0;
    },
    uninstall: () => {
      process.off('unhandledRejection', listener);
    },
  };
}

/** Installs the API session so `reportApiUnauthorized` reaches our counter. */
export function installMatrixSession(baseUrl: string): {
  unauthorizedReports(): number;
  reset(): void;
  teardown(): void;
} {
  let reports = 0;
  establishApiSession({
    apiBaseUrl: baseUrl,
    bearerToken: MATRIX_TOKEN,
    canonicalAppUserId: MATRIX_APP_USER,
    provider: 'apple',
    refreshToken: 'harness-refresh-token',
    bearerExpiresAtMs: Date.now() + 3_600_000,
  });
  setApiUnauthorizedListener(() => {
    reports += 1;
  });
  return {
    unauthorizedReports: () => reports,
    reset: () => {
      reports = 0;
    },
    teardown: () => {
      setApiUnauthorizedListener(null);
      clearApiSession();
    },
  };
}

const HUNG = Symbol('hung');

async function settle(
  promise: Promise<unknown>,
  deadlineMs: number,
): Promise<{ settlement: Settlement; value?: unknown; error?: unknown }> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<typeof HUNG>(resolve => {
    timer = setTimeout(() => resolve(HUNG), deadlineMs);
  });
  try {
    const outcome = await Promise.race([
      promise.then(
        value => ({ settlement: 'resolved' as const, value }),
        (error: unknown) => ({ settlement: 'rejected' as const, error }),
      ),
      deadline,
    ]);
    if (outcome === HUNG) return { settlement: 'hung' };
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface CellRunner {
  /**
   * Runs one cell. `shared: true` skips the per-cell server/session/rejection
   * resets so many cells can run concurrently against one programme (used for
   * the hang scenarios, which otherwise cost a full client timeout each).
   */
  run(
    site: CallSite,
    scenario: MatrixScenario,
    options?: { shared?: boolean },
  ): Promise<MatrixRow>;
}

export function createCellRunner(
  server: ScenarioServer,
  session: ReturnType<typeof installMatrixSession>,
  rejections: UnhandledRejectionTracker,
  testFile: string,
): CellRunner {
  const context: InvokeContext = {
    baseUrl: server.baseUrl,
    token: MATRIX_TOKEN,
    canonicalAppUserId: MATRIX_APP_USER,
  };
  return {
    async run(site, scenario, options = {}) {
      const response = scenario.build(site);
      if (!options.shared) {
        server.respondWith(response);
        server.resetLog();
        session.reset();
        rejections.reset();
        // Let anything still dangling from the previous cell flush first.
        await new Promise<void>(resolve => setImmediate(resolve));
        rejections.reset();
      }

      const heapBefore = process.memoryUsage().heapUsed;
      const started = Date.now();
      let last: Awaited<ReturnType<typeof settle>> = { settlement: 'resolved' };
      for (let index = 0; index < scenario.invocations; index += 1) {
        last = await settle(
          Promise.resolve().then(() => site.invoke(context)),
          scenario.deadlineMs,
        );
        if (last.settlement !== 'resolved') break;
      }
      const durationMs = Date.now() - started;
      await new Promise<void>(resolve => setImmediate(resolve));
      const heapAfter = process.memoryUsage().heapUsed;

      const error =
        last.settlement === 'rejected' ? classifyError(last.error) : null;
      const resolvedKind: ObservedOutcome['resolvedKind'] =
        last.settlement !== 'resolved'
          ? null
          : last.value === null
            ? 'null'
            : last.value === undefined
              ? 'undefined'
              : 'value';
      const observed: ObservedOutcome = {
        settlement: last.settlement,
        resolvedKind,
        retryable: error?.retryable ?? null,
        untyped: error?.untyped ?? false,
        unhandledRejections: rejections.count(),
        unauthorizedReports: session.unauthorizedReports(),
      };
      const judgedAs = scenario.judgeAs ?? scenario.class;
      const replayFilter = `${site.id}::${scenario.id}`;
      return {
        site: site.id,
        family: site.family,
        source: site.source,
        consumer: site.consumer,
        returns: site.returns,
        scenario: scenario.id,
        class: scenario.class,
        judgedAs,
        seed: scenario.seed ?? null,
        description: scenario.description,
        response: summarizeResponse(response),
        requestsSeen: options.shared
          ? server.requests.filter(request => request.url === site.path).length
          : server.requests.length,
        requestPaths: options.shared
          ? [`${site.method} ${site.path}`]
          : server.requests.map(request => `${request.method} ${request.url}`),
        settlement: last.settlement,
        resolvedKind,
        resolvedPreview:
          last.settlement === 'resolved' ? preview(last.value) : null,
        error,
        retryable: observed.retryable,
        unauthorizedReports: observed.unauthorizedReports,
        unhandledRejections: observed.unhandledRejections,
        durationMs,
        heapDeltaBytes: heapAfter - heapBefore,
        violations: judge(site, judgedAs, observed, scenario),
        replay: `cd apps/mobile && MATRIX_FILTER='${replayFilter}' npx jest --ci ${testFile}`,
      };
    },
  };
}

/** `MATRIX_FILTER='site::scenario'` (either side may be `*`) narrows a run to one cell. */
export function cellSelected(
  site: CallSite,
  scenario: MatrixScenario,
): boolean {
  const filter = process.env['MATRIX_FILTER'];
  if (!filter) return true;
  const [siteFilter = '*', scenarioFilter = '*'] = filter.split('::');
  return (
    (siteFilter === '*' || siteFilter === site.id) &&
    (scenarioFilter === '*' || scenarioFilter === scenario.id)
  );
}

export function artifactDir(): string {
  const root = path.resolve(__dirname, '..', '..', '..', '..');
  const run = process.env['MATRIX_RUN_ID'] ?? 'local';
  const dir = path.join(root, 'artifacts', 'server-response-matrix', run);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeArtifact(name: string, data: unknown): string {
  const file = path.join(artifactDir(), name);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return file;
}

export function appendLog(name: string, line: string): void {
  fs.appendFileSync(
    path.join(artifactDir(), name),
    `${new Date().toISOString()} ${line}\n`,
    'utf8',
  );
}

export interface MatrixSummary {
  rows: number;
  bySettlement: Record<Settlement, number>;
  byViolation: Record<string, number>;
  violationCells: string[];
  untypedRejections: string[];
  resolvedNullOnNonOk: string[];
  slowestMs: Array<{ cell: string; durationMs: number }>;
  largestHeapDelta: Array<{ cell: string; heapDeltaBytes: number }>;
  rssBytes: number;
  heapUsedBytes: number;
}

export function summarize(rows: MatrixRow[]): MatrixSummary {
  const bySettlement: Record<Settlement, number> = {
    resolved: 0,
    rejected: 0,
    hung: 0,
  };
  const byViolation: Record<string, number> = {};
  const violationCells: string[] = [];
  const untypedRejections: string[] = [];
  const resolvedNullOnNonOk: string[] = [];
  for (const row of rows) {
    bySettlement[row.settlement] += 1;
    const cell = `${row.site}::${row.scenario}`;
    for (const violation of row.violations) {
      byViolation[violation] = (byViolation[violation] ?? 0) + 1;
    }
    if (row.violations.length > 0) violationCells.push(cell);
    if (row.error?.untyped)
      untypedRejections.push(
        `${cell} → ${row.error.name}: ${row.error.message}`,
      );
    if (
      row.settlement === 'resolved' &&
      row.resolvedKind === 'null' &&
      row.judgedAs !== 'ok' &&
      row.judgedAs !== 'duplicate'
    ) {
      resolvedNullOnNonOk.push(cell);
    }
  }
  const memory = process.memoryUsage();
  return {
    rows: rows.length,
    bySettlement,
    byViolation,
    violationCells,
    untypedRejections,
    resolvedNullOnNonOk,
    slowestMs: [...rows]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 15)
      .map(row => ({
        cell: `${row.site}::${row.scenario}`,
        durationMs: row.durationMs,
      })),
    largestHeapDelta: [...rows]
      .sort((a, b) => b.heapDeltaBytes - a.heapDeltaBytes)
      .slice(0, 15)
      .map(row => ({
        cell: `${row.site}::${row.scenario}`,
        heapDeltaBytes: row.heapDeltaBytes,
      })),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
  };
}

/** site × scenario grid of a compact verdict glyph for the JSON matrix table. */
export function matrixTable(rows: MatrixRow[]): {
  columns: string[];
  rows: Array<{ site: string; cells: Record<string, string> }>;
} {
  const columns = [...new Set(rows.map(row => row.scenario))];
  const sites = [...new Set(rows.map(row => row.site))];
  return {
    columns,
    rows: sites.map(site => ({
      site,
      cells: Object.fromEntries(
        columns.map(column => {
          const row = rows.find(
            candidate =>
              candidate.site === site && candidate.scenario === column,
          );
          if (!row) return [column, '·'];
          const base =
            row.settlement === 'hung'
              ? 'HUNG'
              : row.settlement === 'resolved'
                ? `ok:${row.resolvedKind}`
                : `rej:${row.error?.name ?? '?'}${row.retryable === null ? '' : row.retryable ? '/T' : '/P'}`;
          return [
            column,
            row.violations.length > 0
              ? `${base} !${row.violations.join(',')}`
              : base,
          ];
        }),
      ),
    })),
  };
}
