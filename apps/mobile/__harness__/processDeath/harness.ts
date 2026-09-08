/// <reference types="node" />
/**
 * Parent side of the process-death harness. For one scenario it:
 *   1. writes a deterministic capture fixture (synthetic swing pose sidecar +
 *      clip bytes whose sha256 the native byte proof re-verifies) and a fresh
 *      on-disk SQLite file in a scratch directory;
 *   2. starts an isolated loopback rating service (server state for every
 *      launch of the scenario), optionally behind the fault proxy;
 *   3. spawns `child.ts` once per launch spec on the same file — a launch
 *      with a kill trigger dies by SIGKILL after printing the `PD_KILL`
 *      marker; a relaunch (a DIFFERENT proposed operation id, optional
 *      network faults) runs to completion and prints its report;
 *   4. returns every launch result with the server's durable view after it.
 * All assertions live in the Jest suite; this module only observes.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { CapturedClip } from '../../src/camera/capture';
import {
  startFaultProxy,
  type FaultRule,
  type ProxiedRequest,
} from './faultProxy';
import type { KillPoint, KillTrigger } from './killPoints';
import { KILL_PREFIX } from './killSwitch';
import { startRatingService, type ServerSnapshot } from './ratingService';
import {
  REPORT_PREFIX,
  type ChildEnvironment,
  type ChildReport,
  type FixtureFile,
} from './report';

export const FIRST_OPERATION_ID = '44444444-4444-4444-8444-000000000001';
export const RELAUNCH_OPERATION_ID = '44444444-4444-4444-8444-000000000002';

const HARNESS_DIR = __dirname;
const MOBILE_ROOT = path.resolve(HARNESS_DIR, '..', '..');

export interface LaunchResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** `PD_KILL <id> <where>` marker written just before SIGKILL, if any. */
  readonly killMarker: string | null;
  readonly report: ChildReport | null;
}

export interface LaunchSpec {
  readonly launch: '1' | '2';
  readonly operationId: string;
  readonly kill?: { readonly id: string; readonly trigger: KillTrigger };
  /** Fault rules armed on the proxy for this launch only (needs `proxy`). */
  readonly faults?: readonly FaultRule[];
}

export interface LaunchOutcome extends LaunchResult {
  /** Server view right after this launch exited. */
  readonly serverAfter: ServerSnapshot;
  /** Proxy log entries produced during this launch (empty without proxy). */
  readonly proxied: readonly ProxiedRequest[];
}

export interface LaunchesResult {
  readonly dbPath: string;
  readonly launches: readonly LaunchOutcome[];
  readonly server: ServerSnapshot;
}

export interface ScenarioResult {
  readonly point: KillPoint | null;
  readonly dbPath: string;
  readonly first: LaunchResult;
  readonly second: LaunchResult;
  readonly server: ServerSnapshot;
}

export function writeFixture(dir: string): string {
  const { sequence, window } = generateSwingSequence();
  const sidecar = serializePoseSequence(sequence);
  const sidecarPath = path.join(dir, 'pose-sequence.json');
  writeFileSync(sidecarPath, sidecar);
  const movie = Buffer.from(
    `process-death harness clip bytes ${sequence.frames.length}`,
  );
  const moviePath = path.join(dir, 'capture.mov');
  writeFileSync(moviePath, movie);
  const clip: CapturedClip = {
    uri: pathToFileURL(moviePath).href,
    capturedAtIso: '2026-09-06T12:00:00.000Z',
    durationMs: window.endMs,
    width: sequence.video.width,
    height: sequence.video.height,
    fps: sequence.video.fps,
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    byteSize: movie.byteLength,
    nativeMediaIdentity: {
      schemaVersion: 1,
      format: 'pickle.native-media-identity.v1',
      receiptId: '66666666-6666-4666-8666-666666666666',
      operationId: '77777777-7777-4777-8777-777777777777',
      origin: 'import_copy',
      algorithm: 'sha256',
      videoFileName: 'capture.mov',
      byteSize: movie.byteLength,
      sha256: createHash('sha256').update(movie).digest('hex'),
    },
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: pathToFileURL(sidecarPath).href,
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecar),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
  const fixture: FixtureFile = { clip, declaredStroke: 'forehand_drive' };
  const fixturePath = path.join(dir, 'fixture.json');
  writeFileSync(fixturePath, JSON.stringify(fixture));
  return fixturePath;
}

export function launchChild(env: ChildEnvironment): Promise<LaunchResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        // node:sqlite prints an ExperimentalWarning on Node 22; a successful
        // launch must otherwise keep stderr empty (errors still surface).
        '--disable-warning=ExperimentalWarning',
        '-r',
        path.join(HARNESS_DIR, 'register.js'),
        path.join(HARNESS_DIR, 'child.ts'),
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

/**
 * Run `specs` in order on one fresh database against one rating service.
 * With `proxy`, every launch talks to the fault proxy in front of that
 * service; a spec's `faults` are armed for that launch only.
 */
export async function runLaunches(
  specs: readonly LaunchSpec[],
  options: { readonly proxy?: boolean } = {},
): Promise<LaunchesResult> {
  const dir = mkdtempSync(path.join(tmpdir(), 'pickle-process-death-'));
  const fixturePath = writeFixture(dir);
  const dbPath = path.join(dir, 'pickle-sensei.db');
  const service = await startRatingService();
  const proxy = options.proxy ? await startFaultProxy(service.baseUrl) : null;
  const launches: LaunchOutcome[] = [];
  try {
    for (const spec of specs) {
      if (spec.faults && proxy === null)
        throw new Error('fault rules require the proxy option');
      proxy?.setRules(spec.faults ?? []);
      const proxiedBefore = proxy?.requests().length ?? 0;
      const result = await launchChild({
        PD_DB_PATH: dbPath,
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
      });
      launches.push({
        ...result,
        serverAfter: service.snapshot(),
        proxied: proxy ? proxy.requests().slice(proxiedBefore) : [],
      });
    }
    return { dbPath, launches, server: service.snapshot() };
  } finally {
    await proxy?.close();
    await service.close();
  }
}

/**
 * Kill at `point` during launch 1, relaunch on the same database. Pass
 * `null` for the control pair: a normal first launch followed by a relaunch
 * that must replay (not re-rate) the completed operation.
 */
export async function runScenario(
  point: KillPoint | null,
): Promise<ScenarioResult> {
  const { dbPath, launches, server } = await runLaunches([
    {
      launch: '1',
      operationId: FIRST_OPERATION_ID,
      ...(point ? { kill: { id: point.id, trigger: point.trigger } } : {}),
    },
    { launch: '2', operationId: RELAUNCH_OPERATION_ID },
  ]);
  const [first, second] = launches;
  if (!first || !second)
    throw new Error('scenario ran fewer than two launches');
  return { point, dbPath, first, second, server };
}
