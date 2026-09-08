/// <reference types="node" />
/**
 * Multi-launch driver for the W02-03 attack suite. The candidate harness runs
 * exactly two launches (kill, relaunch); an attack needs more shapes:
 * a third clean launch (fixed point), a crash INSIDE recovery, network faults
 * between the rating service and the relaunch, a relaunch under a different
 * account or a skewed clock, and durable-state tampering between launches.
 *
 * Candidate launches go through the candidate's own `launchChild` (so the
 * candidate harness itself is under test); attack launches spawn
 * `attackChild.ts` the same way. Both children run the SAME shipping code on
 * the SAME database file, against the SAME loopback rating service — the
 * only optional addition is the fault proxy in front of that service.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
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
  type ServerSnapshot,
} from '../processDeath/ratingService';
import {
  REPORT_PREFIX,
  type ChildEnvironment,
  type ChildReport,
} from '../processDeath/report';
import type { AttackChildReport } from './attackReport';
import {
  startFaultProxy,
  type FaultRule,
  type ProxiedRequest,
} from './faultProxy';

const HARNESS_DIR = __dirname;
const MOBILE_ROOT = path.resolve(HARNESS_DIR, '..', '..');

export interface ScenarioContext {
  readonly dir: string;
  readonly dbPath: string;
  readonly fixturePath: string;
  readonly moviePath: string;
  readonly sidecarPath: string;
}

export interface LaunchSpec {
  readonly launch: '1' | '2';
  readonly operationId: string;
  /** `candidate` = the candidate's child.ts via its launchChild (default). */
  readonly child?: 'candidate' | 'attack';
  readonly kill?: { readonly id: string; readonly trigger: KillTrigger };
  /** attack child only */
  readonly owner?: { readonly id: string; readonly bearer: string };
  readonly mode?: 'full' | 'recover_only';
  readonly clockOffsetMs?: number;
  /** Fault rules armed on the proxy for this launch only (needs `proxy`). */
  readonly faults?: readonly FaultRule[];
  /** Runs before the launch: tamper with durable state / fixture files. */
  readonly before?: (context: ScenarioContext) => void | Promise<void>;
}

export type AnyChildReport = ChildReport | AttackChildReport;

export interface AttackLaunchResult extends Omit<LaunchResult, 'report'> {
  readonly report: AnyChildReport | null;
  /** Server view right after this launch exited. */
  readonly serverAfter: ServerSnapshot;
  /** Proxy log entries produced during this launch (empty without proxy). */
  readonly proxied: readonly ProxiedRequest[];
}

export interface AttackScenarioResult {
  readonly context: ScenarioContext;
  readonly launches: readonly AttackLaunchResult[];
  readonly server: ServerSnapshot;
}

function launchAttackChild(
  env: ChildEnvironment & Record<string, string>,
): Promise<LaunchResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        '-r',
        path.join(HARNESS_DIR, '..', 'processDeath', 'register.js'),
        path.join(HARNESS_DIR, 'attackChild.ts'),
      ],
      {
        cwd: MOBILE_ROOT,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (exitCode, signal) => {
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
        killMarker: killLine ? killLine.slice(KILL_PREFIX.length) : null,
        report: reportLine
          ? (JSON.parse(reportLine.slice(REPORT_PREFIX.length)) as ChildReport)
          : null,
      });
    });
  });
}

export async function runAttackScenario(
  specs: readonly LaunchSpec[],
  options: { readonly proxy?: boolean } = {},
): Promise<AttackScenarioResult> {
  const dir = mkdtempSync(path.join(tmpdir(), 'pickle-process-death-attack-'));
  const fixturePath = writeFixture(dir);
  const context: ScenarioContext = {
    dir,
    dbPath: path.join(dir, 'pickle-sensei.db'),
    fixturePath,
    moviePath: path.join(dir, 'capture.mov'),
    sidecarPath: path.join(dir, 'pose-sequence.json'),
  };
  const service = await startRatingService();
  const proxy = options.proxy ? await startFaultProxy(service.baseUrl) : null;
  const launches: AttackLaunchResult[] = [];
  try {
    for (const spec of specs) {
      if (spec.faults && proxy === null)
        throw new Error('fault rules require the proxy option');
      proxy?.setRules(spec.faults ?? []);
      const proxiedBefore = proxy?.requests().length ?? 0;
      if (spec.before) await spec.before(context);
      const env: ChildEnvironment & Record<string, string> = {
        PD_DB_PATH: context.dbPath,
        PD_FIXTURE_PATH: fixturePath,
        PD_API_BASE_URL: proxy?.baseUrl ?? service.baseUrl,
        PD_LAUNCH: spec.launch,
        PD_OPERATION_ID: spec.operationId,
        ...(spec.kill
          ? {
              PD_KILL: JSON.stringify(spec.kill.trigger),
              PD_KILL_ID: spec.kill.id,
            }
          : {}),
        ...(spec.owner
          ? { PD_OWNER_ID: spec.owner.id, PD_BEARER_TOKEN: spec.owner.bearer }
          : {}),
        ...(spec.mode ? { PD_MODE: spec.mode } : {}),
        ...(spec.clockOffsetMs !== undefined
          ? { PD_CLOCK_OFFSET_MS: String(spec.clockOffsetMs) }
          : {}),
      };
      const result =
        spec.child === 'attack'
          ? await launchAttackChild(env)
          : await launchChild(env);
      launches.push({
        ...result,
        serverAfter: service.snapshot(),
        proxied: proxy ? proxy.requests().slice(proxiedBefore) : [],
      });
    }
    return { context, launches, server: service.snapshot() };
  } finally {
    await proxy?.close();
    await service.close();
  }
}

export function killPointById(
  points: readonly { id: string; trigger: KillTrigger }[],
  id: string,
): { readonly id: string; readonly trigger: KillTrigger } {
  const point = points.find(candidate => candidate.id === id);
  if (!point) throw new Error(`Unknown kill point ${id}`);
  return point;
}
