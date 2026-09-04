import type { ActivityShotRow } from '../../../src/data/repository';

/**
 * Fault-injectable stand-in for the consistency store's persistence
 * dependencies: `getDb()` and the repository's `getKv` / `setKv` /
 * `listActivityShots`.
 *
 * Faults are ARMED per dependency and consumed by the next call to it (or
 * held sticky), so a scenario can say "the next history read rejects" or
 * "every kv write from now on hangs". Every call — faulted or not — is
 * recorded so a scenario can prove what the store actually did.
 */
export type DepName = 'getDb' | 'listActivityShots' | 'getKv' | 'setKv';

export type FaultKind =
  /** synchronous throw (SQLite open / statement preparation failure) */
  | 'throw'
  /** rejected promise carrying an Error (SQLITE_IOERR / SQLITE_BUSY) */
  | 'reject'
  /** rejected promise carrying a non-Error value (driver returned a string) */
  | 'reject-non-error'
  /** resolves after a short delay (contended database) */
  | 'slow'
  /** resolves only after 30–59 s (still inside the 60 s window) */
  | 'timeout'
  /** never settles (native bridge lost the callback) */
  | 'never'
  /** resolves with garbage rows / non-ledger kv text */
  | 'malformed'
  /** listActivityShots: only part of the history comes back;
   *  getKv: truncated JSON; setKv: the write lands but the promise rejects */
  | 'partial';

export const FAULT_KINDS: readonly FaultKind[] = [
  'throw',
  'reject',
  'reject-non-error',
  'slow',
  'timeout',
  'never',
  'malformed',
  'partial',
];

export interface Fault {
  kind: FaultKind;
  /** slow / timeout: delay before settling (fake-timer ms). */
  delayMs?: number;
  /** malformed: which garbage variant. */
  variant?: string;
  /** When true the fault stays armed for every call until cleared. */
  sticky?: boolean;
}

export interface RecordedCall {
  dep: DepName;
  key?: string;
  owner?: string;
  fault: FaultKind | 'ok';
  variant?: string;
  /** setKv only: the value the store tried to write. */
  value?: string;
}

/** Non-ledger kv payloads a corrupted row could hand back. */
export const MALFORMED_KV_VARIANTS: Record<string, string> = {
  empty: '',
  whitespace: '   \n\t ',
  'not-json': 'definitely not json',
  'truncated-json': '{"version":1,"drills":[{"id":"d1","completedAtIso":"20',
  'json-null': 'null',
  'json-true': 'true',
  'json-number': '42',
  'json-string': '"a string"',
  'json-array': '[1,2,3]',
  'json-empty-object': '{}',
  'drills-not-array': '{"version":1,"drills":"nope","celebrated":{}}',
  'drills-garbage-entries':
    '{"version":1,"drills":[null,1,"x",{"id":1},{"id":"d1"},{"completedAtIso":"2026-01-01T00:00:00.000Z"}],"celebrated":{}}',
  'drill-bad-instant':
    '{"version":1,"drills":[{"id":"bad","slug":"s","title":"t","completedAtIso":"not-a-date"}],"celebrated":{}}',
  'drill-future-instant':
    '{"version":1,"drills":[{"id":"future","slug":"s","title":"t","completedAtIso":"2999-01-01T00:00:00.000Z"}],"celebrated":{}}',
  'drill-year-99':
    '{"version":1,"drills":[{"id":"y99","slug":"s","title":"t","completedAtIso":"0099-01-01T00:00:00.000Z"}],"celebrated":{}}',
  'celebrated-array': '{"version":1,"drills":[],"celebrated":["streak.1"]}',
  'celebrated-non-string':
    '{"version":1,"drills":[],"celebrated":{"streak.1":1,"streak.3":null,"streak.7":true}}',
  'day-secured-number':
    '{"version":1,"drills":[],"celebrated":{},"daySecuredShownDay":20260310}',
  'version-99': '{"version":99,"drills":[],"celebrated":{}}',
  'nul-bytes': '{"version":1,\u0000"drills":[]}',
  'unicode-noise': '\u{1F3D3}\uFFFD\u202E{"version":1}',
  'deep-nesting': '['.repeat(5000) + ']'.repeat(5000),
  'huge-1mb':
    '{"version":1,"drills":[],"celebrated":{"x":"' +
    'y'.repeat(1024 * 1024) +
    '"}}',
  'proto-pollution':
    '{"__proto__":{"polluted":true},"version":1,"drills":[],"celebrated":{}}',
};

export const MALFORMED_KV_VARIANT_NAMES = Object.keys(MALFORMED_KV_VARIANTS);

/** Garbage local_shot rows a corrupted table / bad migration could yield. */
export const MALFORMED_SHOT_VARIANT_NAMES = [
  'captured-not-a-date',
  'captured-empty',
  'captured-null-string',
  'captured-far-future',
  'captured-year-99',
  'captured-epoch',
  'score-nan',
  'score-infinity',
  'score-negative',
  'score-string',
  'scored-without-score',
  'shot-type-null-string',
  'duplicate-id',
  'session-id-empty',
] as const;

export type MalformedShotVariant =
  (typeof MALFORMED_SHOT_VARIANT_NAMES)[number];

export function malformedShotRow(
  variant: string,
  nowIso: string,
  base: ActivityShotRow,
): ActivityShotRow {
  switch (variant) {
    case 'captured-not-a-date':
      return { ...base, id: `${base.id}:bad`, capturedAt: 'not-a-date' };
    case 'captured-empty':
      return { ...base, id: `${base.id}:bad`, capturedAt: '' };
    case 'captured-null-string':
      return { ...base, id: `${base.id}:bad`, capturedAt: 'null' };
    case 'captured-far-future':
      return {
        ...base,
        id: `${base.id}:bad`,
        capturedAt: '2999-01-01T00:00:00.000Z',
      };
    case 'captured-year-99':
      return {
        ...base,
        id: `${base.id}:bad`,
        capturedAt: '0099-01-01T00:00:00.000Z',
      };
    case 'captured-epoch':
      return {
        ...base,
        id: `${base.id}:bad`,
        capturedAt: '1970-01-01T00:00:00.000Z',
      };
    case 'score-nan':
      return { ...base, id: `${base.id}:bad`, overallScore: Number.NaN };
    case 'score-infinity':
      return {
        ...base,
        id: `${base.id}:bad`,
        overallScore: Number.POSITIVE_INFINITY,
      };
    case 'score-negative':
      return { ...base, id: `${base.id}:bad`, overallScore: -7 };
    case 'score-string':
      return {
        ...base,
        id: `${base.id}:bad`,
        overallScore: '7.5' as unknown as number,
      };
    case 'scored-without-score':
      return {
        ...base,
        id: `${base.id}:bad`,
        resultKind: 'scored',
        overallScore: null,
      };
    case 'shot-type-null-string':
      return { ...base, id: `${base.id}:bad`, shotType: 'null' };
    case 'duplicate-id':
      return { ...base, capturedAt: nowIso };
    case 'session-id-empty':
      return { ...base, id: `${base.id}:bad`, sessionId: '' };
    default:
      throw new Error(`unknown malformed shot variant ${variant}`);
  }
}

const NEVER = new Promise<never>(() => {});

export class FaultRepository {
  readonly kv = new Map<string, string>();
  /** owner → rows (the real query is owner-scoped). */
  readonly shots = new Map<string, ActivityShotRow[]>();
  readonly calls: RecordedCall[] = [];
  /** Every successful kv write, in order. */
  readonly writes: { key: string; value: string }[] = [];
  private readonly armed = new Map<DepName, Fault>();
  /** How the fake resolves `getActiveDataOwner()` for the shot query. */
  ownerResolver: () => string = () => 'unknown';

  arm(dep: DepName, fault: Fault): void {
    this.armed.set(dep, fault);
  }

  clearFaults(): void {
    this.armed.clear();
  }

  armedFaults(): Record<string, Fault> {
    return Object.fromEntries(this.armed.entries());
  }

  private take(dep: DepName): Fault | null {
    const fault = this.armed.get(dep);
    if (!fault) return null;
    if (!fault.sticky) this.armed.delete(dep);
    return fault;
  }

  private static error(dep: DepName, kind: FaultKind): Error {
    const error = new Error(`[injected ${kind}] ${dep}: SQLITE_IOERR`);
    error.name = 'SqliteError';
    return error;
  }

  private static delayed<T>(value: T, ms: number): Promise<T> {
    return new Promise(resolve => {
      setTimeout(() => resolve(value), ms);
    });
  }

  /** Shared handling for the promise-shaped faults. `null` = no fault. */
  private async settle<T>(
    dep: DepName,
    fault: Fault | null,
    ok: () => T,
  ): Promise<T> {
    if (!fault) return ok();
    switch (fault.kind) {
      case 'throw':
        throw FaultRepository.error(dep, fault.kind);
      case 'reject':
        return Promise.reject(FaultRepository.error(dep, fault.kind));
      case 'reject-non-error':
        return Promise.reject(`[injected reject-non-error] ${dep}`);
      case 'slow':
        return FaultRepository.delayed(ok(), fault.delayMs ?? 750);
      case 'timeout':
        return FaultRepository.delayed(ok(), fault.delayMs ?? 45_000);
      case 'never':
        return NEVER;
      default:
        return ok();
    }
  }

  getDb = (): object => {
    const fault = this.take('getDb');
    this.calls.push({ dep: 'getDb', fault: fault?.kind ?? 'ok' });
    if (fault) throw FaultRepository.error('getDb', fault.kind);
    return { __fake: 'db' };
  };

  listActivityShots = (_db: unknown): Promise<ActivityShotRow[]> => {
    const owner = this.ownerResolver();
    const fault = this.take('listActivityShots');
    this.calls.push({
      dep: 'listActivityShots',
      owner,
      fault: fault?.kind ?? 'ok',
      variant: fault?.variant,
    });
    const rows = [...(this.shots.get(owner) ?? [])].sort((a, b) =>
      a.capturedAt < b.capturedAt ? -1 : a.capturedAt > b.capturedAt ? 1 : 0,
    );
    if (fault?.kind === 'throw') {
      throw FaultRepository.error('listActivityShots', 'throw');
    }
    if (fault?.kind === 'malformed') {
      const variant = fault.variant ?? 'captured-not-a-date';
      const base: ActivityShotRow = rows[0] ?? {
        id: 'ghost',
        sessionId: null,
        shotType: 'dink',
        capturedAt: new Date().toISOString(),
        overallScore: 7,
        resultKind: 'scored',
      };
      const bad = malformedShotRow(variant, new Date().toISOString(), base);
      // A corrupted row sorts wherever its captured_at text puts it.
      const merged = [...rows, bad].sort((a, b) =>
        a.capturedAt < b.capturedAt ? -1 : a.capturedAt > b.capturedAt ? 1 : 0,
      );
      return Promise.resolve(merged);
    }
    if (fault?.kind === 'partial') {
      return Promise.resolve(rows.slice(0, Math.floor(rows.length / 2)));
    }
    return this.settle('listActivityShots', fault, () => rows);
  };

  getKv = (_db: unknown, key: string): Promise<string | null> => {
    const fault = this.take('getKv');
    this.calls.push({
      dep: 'getKv',
      key,
      fault: fault?.kind ?? 'ok',
      variant: fault?.variant,
    });
    if (fault?.kind === 'throw') {
      throw FaultRepository.error('getKv', 'throw');
    }
    if (fault?.kind === 'malformed') {
      const variant = fault.variant ?? 'not-json';
      return Promise.resolve(MALFORMED_KV_VARIANTS[variant] ?? 'not-json');
    }
    if (fault?.kind === 'partial') {
      const current = this.kv.get(key) ?? null;
      return Promise.resolve(
        current === null
          ? null
          : current.slice(0, Math.floor(current.length / 2)),
      );
    }
    return this.settle('getKv', fault, () => this.kv.get(key) ?? null);
  };

  setKv = (_db: unknown, key: string, value: string): Promise<void> => {
    const fault = this.take('setKv');
    this.calls.push({
      dep: 'setKv',
      key,
      fault: fault?.kind ?? 'ok',
      variant: fault?.variant,
      value,
    });
    if (fault?.kind === 'throw') {
      throw FaultRepository.error('setKv', 'throw');
    }
    if (fault?.kind === 'partial') {
      // Statement committed, but the driver callback reported failure.
      this.kv.set(key, value);
      this.writes.push({ key, value });
      return Promise.reject(FaultRepository.error('setKv', 'partial'));
    }
    if (fault?.kind === 'malformed') {
      // No such thing as a "malformed" write for an atomic kv store — the
      // write lands intact. Treated as ok so the campaign never lies.
      this.kv.set(key, value);
      this.writes.push({ key, value });
      return Promise.resolve();
    }
    return this.settle('setKv', fault, () => {
      this.kv.set(key, value);
      this.writes.push({ key, value });
    });
  };
}
