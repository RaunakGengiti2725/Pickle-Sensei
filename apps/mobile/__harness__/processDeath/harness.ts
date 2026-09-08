/// <reference types="node" />
/**
 * Parent side of the process-death harness. For one kill point it:
 *   1. writes a deterministic capture fixture (synthetic swing pose sidecar +
 *      clip bytes whose sha256 the native byte proof re-verifies) and a fresh
 *      on-disk SQLite file in a scratch directory;
 *   2. starts an isolated loopback rating service (server state for the pair);
 *   3. spawns `child.ts` (launch 1) with the kill trigger and waits for it to
 *      die by SIGKILL after printing the `PD_KILL` marker;
 *   4. spawns `child.ts` again (launch 2, no trigger, a DIFFERENT proposed
 *      operation id) on the same file and parses its report;
 *   5. returns both launch results and the server's durable view.
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
import type { KillPoint } from './killPoints';
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
 * Kill at `point` during launch 1, relaunch on the same database. Pass
 * `null` for the control pair: a normal first launch followed by a relaunch
 * that must replay (not re-rate) the completed operation.
 */
export async function runScenario(
  point: KillPoint | null,
): Promise<ScenarioResult> {
  const dir = mkdtempSync(path.join(tmpdir(), 'pickle-process-death-'));
  const fixturePath = writeFixture(dir);
  const dbPath = path.join(dir, 'pickle-sensei.db');
  const service = await startRatingService();
  try {
    const shared = {
      PD_DB_PATH: dbPath,
      PD_FIXTURE_PATH: fixturePath,
      PD_API_BASE_URL: service.baseUrl,
    };
    const first = await launchChild({
      ...shared,
      PD_LAUNCH: '1',
      PD_OPERATION_ID: FIRST_OPERATION_ID,
      ...(point
        ? { PD_KILL: JSON.stringify(point.trigger), PD_KILL_ID: point.id }
        : {}),
    });
    const second = await launchChild({
      ...shared,
      PD_LAUNCH: '2',
      PD_OPERATION_ID: RELAUNCH_OPERATION_ID,
    });
    return { point, dbPath, first, second, server: service.snapshot() };
  } finally {
    await service.close();
  }
}
