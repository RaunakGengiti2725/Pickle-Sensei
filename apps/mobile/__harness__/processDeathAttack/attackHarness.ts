/// <reference types="node" />
/**
 * Adversarial extension of the W02-03 process-death harness. It reuses the
 * candidate's fixture writer, child launcher, rating service and kill
 * triggers unchanged, and adds what the candidate does not exercise:
 *   - launch sequences longer than two (a kill DURING the relaunch's
 *     journal recovery, then a third launch that must still reconcile);
 *   - a fault-injecting HTTP proxy between the child and the rating service
 *     (429 + Retry-After, 5xx, dropped sockets, hanging responses);
 *   - direct SQL mutation of the durable file between launches (corrupt or
 *     partial persisted state, clock skew);
 *   - launches under a different data owner on the same file (account
 *     switch between the kill and the relaunch).
 * Nothing under src/ or the candidate's harness is modified.
 */
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  launchChild,
  writeFixture,
  type LaunchResult,
} from '../processDeath/harness';
import type { KillTrigger } from '../processDeath/killPoints';
import { KILL_PREFIX } from '../processDeath/killSwitch';
import {
  startRatingService,
  type RatingService,
  type ServerSnapshot,
} from '../processDeath/ratingService';
import {
  OWNER_ID,
  REPORT_PREFIX,
  type ChildEnvironment,
  type ChildReport,
} from '../processDeath/report';

export const THIRD_OPERATION_ID = '44444444-4444-4444-8444-000000000003';
export const OTHER_OWNER_ID = '22222222-2222-4222-8222-222222222222';

const CANDIDATE_DIR = path.resolve(__dirname, '..', 'processDeath');
const MOBILE_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Fault-injecting proxy
// ---------------------------------------------------------------------------

export type Fault =
  | {
      readonly kind: 'status';
      readonly status: number;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: unknown;
    }
  /** Close the socket without any response (connection reset). */
  | { readonly kind: 'drop' }
  /** Never answer; the request stays open until the child dies. */
  | { readonly kind: 'hang' };

export interface FaultRule {
  readonly method?: string;
  readonly pathIncludes: string;
  /** 1-based occurrence of a matching request seen by the proxy, or every
   * matching request. */
  readonly ordinal: number | 'all';
  readonly fault: Fault;
}

export interface FaultProxy {
  readonly baseUrl: string;
  /** `METHOD path` of every request the proxy answered with a fault. */
  readonly injected: readonly string[];
  /** `METHOD path` of every request that reached the proxy. */
  readonly seen: readonly string[];
  /** Replaces the active rules and restarts their occurrence counters. */
  setRules(rules: readonly FaultRule[]): void;
  close(): Promise<void>;
}

/**
 * The proxy fronts the rating service for EVERY launch of a sequence (the
 * shipping journal scopes attempts by API origin, so a relaunch must reach
 * the same origin it reserved under); faults are armed per launch.
 */
export async function startFaultProxy(
  upstreamBaseUrl: string,
): Promise<FaultProxy> {
  const upstream = new URL(upstreamBaseUrl);
  const injected: string[] = [];
  const seen: string[] = [];
  let rules: readonly FaultRule[] = [];
  let counts = new Map<FaultRule, number>();
  const hanging = new Set<http.ServerResponse>();

  const server = http.createServer((request, response) => {
    const method = request.method ?? 'GET';
    const url = request.url ?? '/';
    seen.push(`${method} ${url}`);
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      const rule = rules.find(candidate => {
        if (candidate.method !== undefined && candidate.method !== method)
          return false;
        if (!url.includes(candidate.pathIncludes)) return false;
        const next = (counts.get(candidate) ?? 0) + 1;
        counts.set(candidate, next);
        return candidate.ordinal === 'all' || next === candidate.ordinal;
      });
      if (rule) {
        injected.push(`${method} ${url}`);
        if (rule.fault.kind === 'drop') {
          response.socket?.destroy();
          return;
        }
        if (rule.fault.kind === 'hang') {
          hanging.add(response);
          return;
        }
        const payload = JSON.stringify(
          rule.fault.body ?? {
            error: { code: 'attack.injected', message: 'Injected fault.' },
          },
        );
        response.writeHead(rule.fault.status, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...(rule.fault.headers ?? {}),
        });
        response.end(payload);
        return;
      }
      const forward = http.request(
        {
          host: upstream.hostname,
          port: upstream.port,
          method,
          path: url,
          headers: {
            ...request.headers,
            host: upstream.host,
            'content-length': String(body.byteLength),
          },
        },
        answer => {
          response.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(response);
        },
      );
      forward.on('error', () => {
        response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'attack.upstream' } }));
      });
      forward.end(body);
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}${upstream.pathname}`,
    injected,
    seen,
    setRules(next) {
      rules = next;
      counts = new Map();
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const response of hanging) response.destroy();
        server.closeAllConnections();
        server.close(error => (error ? reject(error) : resolve()));
      }),
  };
}

// ---------------------------------------------------------------------------
// Durable-file mutation between launches
// ---------------------------------------------------------------------------

/**
 * Applies SQL to the closed database file with a separate `node:sqlite`
 * process (the file is never open in the Jest process). Foreign keys are
 * off on purpose: the point is to leave state the shipping code did not
 * write.
 */
export function mutateDatabase(dbPath: string, statements: string[]): void {
  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const [file, ...sql] = process.argv.slice(1);
    const db = new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys = OFF');
    for (const statement of sql) db.exec(statement);
    db.close();
  `;
  execFileSync(process.execPath, ['-e', script, dbPath, ...statements], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

export function queryDatabase(
  dbPath: string,
  sql: string,
): Record<string, unknown>[] {
  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const [file, sql] = process.argv.slice(1);
    const db = new DatabaseSync(file, { readOnly: true });
    process.stdout.write(JSON.stringify(db.prepare(sql).all(), (_, v) =>
      typeof v === 'bigint' ? Number(v) : v));
    db.close();
  `;
  const out = execFileSync(process.execPath, ['-e', script, dbPath, sql], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out.toString('utf8')) as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Owner-parameterised child (account switch on the same file)
// ---------------------------------------------------------------------------

export interface AttackChildEnvironment extends ChildEnvironment {
  readonly PD_OWNER_ID: string;
}

/** Same spawn contract as the candidate's `launchChild`, but runs
 * `attackChild.ts` (the candidate child with the data owner taken from
 * `PD_OWNER_ID`) and bounds the wall time so a hung child cannot hang Jest. */
export function launchAttackChild(
  env: AttackChildEnvironment,
  timeoutMs = 20_000,
): Promise<LaunchResult & { timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '-r',
        path.join(CANDIDATE_DIR, 'register.js'),
        path.join(__dirname, 'attackChild.ts'),
      ],
      {
        cwd: MOBILE_ROOT,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      const killLine = stderr
        .split('\n')
        .find(line => line.startsWith(KILL_PREFIX));
      const reportLine = stdout
        .split('\n')
        .find(line => line.startsWith(REPORT_PREFIX));
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
        killMarker: killLine ? killLine.slice(KILL_PREFIX.length) : null,
        report: reportLine
          ? (JSON.parse(reportLine.slice(REPORT_PREFIX.length)) as ChildReport)
          : null,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Multi-launch scenarios
// ---------------------------------------------------------------------------

export interface LaunchPlan {
  readonly launch: '1' | '2';
  readonly operationId: string;
  readonly kill?: { readonly id: string; readonly trigger: KillTrigger };
  /** Faults armed for this launch. Any plan with faults puts the WHOLE
   * sequence behind the proxy (same API origin for every launch). */
  readonly faults?: readonly FaultRule[];
  /** Runs against the closed database file before the launch starts. */
  readonly mutate?: readonly string[];
  /** Run the owner-parameterised child under this owner. */
  readonly ownerId?: string;
  /** Wall-time guard for the owner-parameterised child. */
  readonly timeoutMs?: number;
}

export interface LaunchOutcome extends LaunchResult {
  readonly timedOut: boolean;
  readonly proxy: {
    readonly injected: readonly string[];
    readonly seen: readonly string[];
  } | null;
}

export interface SequenceResult {
  readonly dbPath: string;
  readonly launches: readonly LaunchOutcome[];
  readonly server: ServerSnapshot;
}

export async function runSequence(
  plans: readonly LaunchPlan[],
): Promise<SequenceResult> {
  const dir = mkdtempSync(path.join(tmpdir(), 'pickle-process-death-attack-'));
  const fixturePath = writeFixture(dir);
  const dbPath = path.join(dir, 'pickle-sensei.db');
  const service: RatingService = await startRatingService();
  const proxy = plans.some(plan => plan.faults !== undefined)
    ? await startFaultProxy(service.baseUrl)
    : null;
  const launches: LaunchOutcome[] = [];
  try {
    for (const plan of plans) {
      if (plan.mutate) mutateDatabase(dbPath, [...plan.mutate]);
      const injectedBefore = proxy?.injected.length ?? 0;
      const seenBefore = proxy?.seen.length ?? 0;
      proxy?.setRules(plan.faults ?? []);
      const env: ChildEnvironment = {
        PD_DB_PATH: dbPath,
        PD_FIXTURE_PATH: fixturePath,
        PD_API_BASE_URL: proxy ? proxy.baseUrl : service.baseUrl,
        PD_LAUNCH: plan.launch,
        PD_OPERATION_ID: plan.operationId,
        ...(plan.kill
          ? {
              PD_KILL: JSON.stringify(plan.kill.trigger),
              PD_KILL_ID: plan.kill.id,
            }
          : {}),
      };
      const result =
        plan.ownerId !== undefined || plan.timeoutMs !== undefined
          ? await launchAttackChild(
              { ...env, PD_OWNER_ID: plan.ownerId ?? OWNER_ID },
              plan.timeoutMs,
            )
          : { ...(await launchChild(env)), timedOut: false };
      launches.push({
        ...result,
        proxy: proxy
          ? {
              injected: proxy.injected.slice(injectedBefore),
              seen: proxy.seen.slice(seenBefore),
            }
          : null,
      });
    }
    return { dbPath, launches, server: service.snapshot() };
  } finally {
    await proxy?.close();
    await service.close();
  }
}
