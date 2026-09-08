/**
 * Process-death primitive for the child. `dieAtKillPoint` writes the
 * `PD_KILL <id>` marker synchronously (so the parent can prove the kill
 * happened at the intended step, not by accident) and then SIGKILLs itself —
 * no unwinding, no `finally`, no ROLLBACK: the same abrupt end an iOS app
 * suffers when the OS terminates it.
 */
import { writeSync } from 'node:fs';
import type { KillTrigger } from './killPoints';

export const KILL_PREFIX = 'PD_KILL ';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPhase(value: unknown): value is 'before' | 'after' {
  return value === 'before' || value === 'after';
}

export function parseKillTrigger(json: string): KillTrigger {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value) || !isPhase(value['phase']))
    throw new Error(`Malformed kill trigger: ${json}`);
  const ordinal = value['ordinal'];
  if (typeof ordinal !== 'number' || !Number.isInteger(ordinal) || ordinal < 1)
    throw new Error(`Malformed kill trigger ordinal: ${json}`);
  if (value['kind'] === 'sql') {
    const includes = value['includes'];
    if (
      !Array.isArray(includes) ||
      includes.length === 0 ||
      !includes.every(
        (fragment): fragment is string => typeof fragment === 'string',
      )
    )
      throw new Error(`Malformed sql kill trigger: ${json}`);
    return { kind: 'sql', includes, ordinal, phase: value['phase'] };
  }
  if (value['kind'] === 'http' && typeof value['pathIncludes'] === 'string') {
    return {
      kind: 'http',
      pathIncludes: value['pathIncludes'],
      ordinal,
      phase: value['phase'],
    };
  }
  throw new Error(`Malformed kill trigger kind: ${json}`);
}

export function killTriggerFromEnvironment(): KillTrigger | null {
  const json = process.env['PD_KILL'];
  return json === undefined ? null : parseKillTrigger(json);
}

export function dieAtKillPoint(where: string): never {
  const id = process.env['PD_KILL_ID'] ?? 'unnamed';
  writeSync(
    2,
    `${KILL_PREFIX}${id} ${where.replace(/\s+/g, ' ').slice(0, 96)}\n`,
  );
  process.kill(process.pid, 'SIGKILL');
  // SIGKILL is delivered asynchronously; never let the caller observe a
  // return value or run another statement in the meantime.
  for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
