/**
 * STRESS / failure-injection — `src/account/sessionVault.ts` (module level).
 *
 * The vault's one dependency is `react-native-keychain`. Every one of its
 * three operations is driven through the fault catalogue in
 * `stress-harness/session-vault/keychainFaults.ts`: sync throw, rejection
 * (Error / SecItem codes / bare values), never-resolves, slow (1 s … 59 s),
 * malformed return shapes, partial writes, plus module-shape faults (native
 * module missing, functions undefined, throwing getters) and ~60 Keychain
 * record corruptions (malformed / truncated / oversized / accepted-but-noisy).
 *
 * Campaigns:
 *   catalogue/get, catalogue/set, catalogue/reset  every fault × prestate
 *   catalogue/module                               every module shape × op
 *   catalogue/record                               every record corruption
 *   seeded/sequence                                STRESS_ITER random op
 *                                                  sequences (mulberry32,
 *                                                  seed = index)
 *   seeded/concurrent                              STRESS_ITER/4 bursts of
 *                                                  concurrent ops
 *
 * Invariants (per op):
 *   settlesWithin60s     the promise settles inside 60 s of fake time
 *   noThrow              load/save/clear never reject
 *   resultShape          save → boolean, load → null | contract record,
 *                        clear → undefined
 *   noFakeSuccess        save → true only when the store holds exactly the
 *                        record, under the contract accessibility
 *   honestFailure        a fault-free save returns true
 *   noFabrication        load never returns a record the store did not hold
 *   honestLoad           a fault-free load returns the stored record / null
 *   garbageDiscarded     a fault-free load of garbage returns null AND resets
 *   readFaultKeepsRecord a read failure never destroys the record
 *   clearApplied         a fault-free clear empties the store
 *   storeHonest          the store only ever holds: what it held, the exact
 *                        record just saved, or (partial-write fault) a prefix
 *   recoverable          after the fault is lifted, one plain load returns
 *                        the store's honest content and no garbage survives
 *   prototypeClean       no prototype pollution from hostile records
 *
 * Rows → artifacts/stress/session-vault/module-rows.json (+ summary). The
 * final assertions fail on any row that fails outside KNOWN_DEVIATIONS and
 * on any known deviation that is no longer reproduced.
 */
import {
  clearPersistedSession,
  loadPersistedSession,
  savePersistedSession,
  SESSION_VAULT_SERVICE,
  type PersistedSession,
} from '../../src/account/sessionVault';
import {
  ALL_FAULTS,
  GET_FAULTS,
  MODULE_MODES,
  RECORD_CORRUPTIONS,
  RESET_FAULTS,
  SET_FAULTS,
  VAULT_ACCESSIBLE,
  VAULT_ACCOUNT,
  VAULT_SERVICE,
  deliversRealResult,
  isVaultRecord,
  mockKeychain,
  sameRecord,
  seededRecord,
  settleWithin,
  stressIterations,
  summarizeRows,
  writeStressArtifact,
  type KeychainFault,
  type KeychainOp,
  type ModuleMode,
  type RecordCorruption,
  type Settled,
  type StressRow,
  type VaultRecord,
} from '../../stress-harness/session-vault/keychainFaults';
import { nodeProcess } from '../../xc-harness/lifecycle-persistence/nodeShim';
import { makePrng, pick } from '../../xc-harness/lifecycle-persistence/seeds';

type Harness =
  typeof import('../../stress-harness/session-vault/keychainFaults');

jest.mock('react-native-keychain', () => {
  const harness = jest.requireActual(
    '../../stress-harness/session-vault/keychainFaults',
  ) as Harness;
  return harness.buildKeychainModule(harness.mockKeychain);
});

type VaultModule = typeof import('../../src/account/sessionVault');

const BUDGET_MS = 60_000;
/** Replay one seeded row (sequence + burst) instead of the whole campaign. */
const REPLAY_SEED =
  nodeProcess.env['STRESS_SEED'] === undefined
    ? null
    : Number(nodeProcess.env['STRESS_SEED']);
const SEQUENCE_ITER = stressIterations('STRESS_ITER_SEQUENCE', 200);
const CONCURRENT_ITER = stressIterations(
  'STRESS_ITER_CONCURRENT',
  Math.max(20, Math.floor(SEQUENCE_ITER / 4)),
);

/**
 * Contract deviations already reproduced and triaged (see the session
 * report). A row failing ONLY through these is a known deviation, not a new
 * failure; a dedicated assertion checks each is still reproduced so a fix
 * flips the rows back to strict.
 */
const KNOWN_DEVIATIONS = {
  'SV-FI-1':
    'A Keychain call that never settles keeps load/save/clearPersistedSession pending forever (no timeout in sessionVault.ts:109/121/137); hydrate() awaits it at authStore.ts:580 so `hydrated` never flips and App.tsx:198 shows LoadingState with no retry control',
  'SV-FI-4':
    'A malformed getGenericPassword RESULT (object without a string password, e.g. {username} only, [] or another service\u2019s item) is treated as a malformed persisted record: loadPersistedSession() calls clearPersistedSession() (sessionVault.ts:114) and deletes the VALID stored session',
} as const;
type DeviationId = keyof typeof KNOWN_DEVIATIONS;

function classifyDeviation(
  faults: readonly KeychainFault[],
  invariant: string,
): DeviationId | null {
  const base = invariant.replace(/^step\d+:/, '');
  if (
    base === 'settlesWithin60s' &&
    faults.some(candidate => candidate.category === 'never-resolves')
  ) {
    return 'SV-FI-1';
  }
  if (
    base === 'readFaultKeepsRecord' &&
    faults.some(
      candidate => candidate.op === 'get' && candidate.category === 'malformed',
    )
  ) {
    return 'SV-FI-4';
  }
  return null;
}

// ─── Row plumbing ───────────────────────────────────────────────────────────

const rows: StressRow[] = [];

function realNow(): number {
  return jest.getRealSystemTime();
}

function finishRow(input: {
  campaign: string;
  scenario: string;
  seed: number | null;
  faults: readonly KeychainFault[];
  inputs: Record<string, unknown>;
  observed: Record<string, unknown>;
  invariants: Record<string, boolean>;
  startedReal: number;
}): StressRow {
  const knownDeviations: string[] = [];
  const failed: string[] = [];
  for (const [name, held] of Object.entries(input.invariants)) {
    if (held) continue;
    const deviation = classifyDeviation(input.faults, name);
    if (deviation) knownDeviations.push(`${deviation}:${name}`);
    else failed.push(name);
  }
  const row: StressRow = {
    suite: 'sessionVaultFailureInjection',
    campaign: input.campaign,
    scenario: input.scenario,
    seed: input.seed,
    faults: input.faults.map(candidate => candidate.id),
    inputs: input.inputs,
    observed: input.observed,
    invariants: input.invariants,
    ok: failed.length === 0,
    failed,
    knownDeviations,
    durationMs: realNow() - input.startedReal,
  };
  rows.push(row);
  return row;
}

function abbreviate(raw: string | null): string | null {
  if (raw === null) return null;
  return raw.length > 120 ? `${raw.slice(0, 117)}…(${raw.length})` : raw;
}

function describeSettled(settled: Settled<unknown>): unknown {
  switch (settled.state) {
    case 'resolved':
      return {
        state: 'resolved',
        value:
          settled.value && typeof settled.value === 'object'
            ? Object.keys(settled.value as object).sort()
            : settled.value,
      };
    case 'rejected':
      return { state: 'rejected', error: settled.error };
    default:
      return { state: 'pending' };
  }
}

// ─── One operation under fault ──────────────────────────────────────────────

type OpKind = 'save' | 'load' | 'clear';

interface OpOutcome {
  kind: OpKind;
  settled: Settled<unknown> & { elapsedMs: number };
  rawBefore: string | null;
  recordBefore: VaultRecord | null;
  classBefore: 'empty' | 'valid' | 'garbage';
  rawAfter: string | null;
  classAfter: 'empty' | 'valid' | 'garbage';
  keychainOps: KeychainOp[];
  invariants: Record<string, boolean>;
}

function isPrefixWrite(rawAfter: string | null, expected: string): boolean {
  return (
    rawAfter !== null &&
    rawAfter.length < expected.length &&
    expected.startsWith(rawAfter)
  );
}

async function runOp(
  vault: VaultModule,
  kind: OpKind,
  record: VaultRecord | null,
  armed: {
    get: KeychainFault | null;
    set: KeychainFault | null;
    reset: KeychainFault | null;
  },
): Promise<OpOutcome> {
  const rawBefore = mockKeychain.raw();
  const recordBefore = mockKeychain.parsed();
  const classBefore = mockKeychain.classify();
  const callIndex = mockKeychain.calls.length;
  let promise: Promise<unknown>;
  switch (kind) {
    case 'save':
      promise = vault.savePersistedSession(record as PersistedSession);
      break;
    case 'load':
      promise = vault.loadPersistedSession();
      break;
    default:
      promise = vault.clearPersistedSession();
  }
  const settled = await settleWithin(promise, BUDGET_MS);
  const rawAfter = mockKeychain.raw();
  const classAfter = mockKeychain.classify();
  const keychainOps = mockKeychain.opsSince(callIndex);
  const item = mockKeychain.store.get(VAULT_SERVICE);

  const invariants: Record<string, boolean> = {};
  invariants['settlesWithin60s'] = settled.state !== 'pending';
  invariants['noThrow'] = settled.state !== 'rejected';
  const value = settled.state === 'resolved' ? settled.value : undefined;
  const opFault =
    kind === 'save' ? armed.set : kind === 'load' ? armed.get : armed.reset;
  const faultFree = deliversRealResult(opFault);

  if (kind === 'save') {
    const expected = JSON.stringify(record);
    invariants['resultShape'] =
      settled.state !== 'resolved' || typeof value === 'boolean';
    invariants['noFakeSuccess'] =
      value !== true ||
      (rawAfter === expected &&
        item?.accessible === VAULT_ACCESSIBLE &&
        item?.username === VAULT_ACCOUNT);
    invariants['honestFailure'] =
      !faultFree || settled.state !== 'resolved' || value === true;
    invariants['storeHonest'] =
      rawAfter === rawBefore ||
      rawAfter === expected ||
      (opFault?.storeEffect === 'partial' && isPrefixWrite(rawAfter, expected));
  } else if (kind === 'load') {
    invariants['resultShape'] =
      settled.state !== 'resolved' || value === null || isVaultRecord(value);
    invariants['noFabrication'] =
      !isVaultRecord(value) ||
      (recordBefore !== null && sameRecord(value, recordBefore));
    if (faultFree) {
      invariants['honestLoad'] =
        settled.state === 'resolved' &&
        (classBefore === 'valid'
          ? isVaultRecord(value) && sameRecord(value, recordBefore)
          : value === null);
      if (classBefore === 'garbage') {
        invariants['garbageDiscarded'] =
          keychainOps.includes('reset') &&
          (rawAfter === null || !deliversRealResult(armed.reset));
      }
    }
    // A read that did not deliver the stored item must not touch the store
    // (discarding pre-existing garbage after a malformed reply is fine).
    if (
      opFault &&
      !deliversRealResult(opFault) &&
      !(opFault.category === 'malformed' && classBefore === 'garbage')
    ) {
      invariants['readFaultKeepsRecord'] = rawAfter === rawBefore;
    }
    invariants['storeHonest'] = rawAfter === rawBefore || rawAfter === null;
  } else {
    invariants['resultShape'] =
      settled.state !== 'resolved' || value === undefined;
    if (faultFree) invariants['clearApplied'] = rawAfter === null;
    invariants['storeHonest'] = rawAfter === rawBefore || rawAfter === null;
  }

  return {
    kind,
    settled,
    rawBefore,
    recordBefore,
    classBefore,
    rawAfter,
    classAfter,
    keychainOps,
    invariants,
  };
}

/** Faults lifted, one plain load: the module must hand back the store's
 * honest content and leave no garbage behind. */
async function recoveryProbe(
  vault: VaultModule,
): Promise<{ ok: boolean; observed: unknown }> {
  mockKeychain.arm(null);
  const classBefore = mockKeychain.classify();
  const expected = mockKeychain.parsed();
  const settled = await settleWithin(vault.loadPersistedSession(), BUDGET_MS);
  const value = settled.state === 'resolved' ? settled.value : undefined;
  const ok =
    settled.state === 'resolved' &&
    (classBefore === 'valid'
      ? isVaultRecord(value) && sameRecord(value, expected)
      : value === null && mockKeychain.raw() === null);
  return {
    ok,
    observed: {
      classBefore,
      settled: describeSettled(settled),
      classAfter: mockKeychain.classify(),
    },
  };
}

function opObserved(outcome: OpOutcome): Record<string, unknown> {
  return {
    settled: describeSettled(outcome.settled),
    elapsedMs: outcome.settled.elapsedMs,
    classBefore: outcome.classBefore,
    classAfter: outcome.classAfter,
    rawAfter: abbreviate(outcome.rawAfter),
    keychainOps: outcome.keychainOps,
  };
}

function armedFor(faults: readonly KeychainFault[]) {
  const armed: {
    get: KeychainFault | null;
    set: KeychainFault | null;
    reset: KeychainFault | null;
  } = { get: null, set: null, reset: null };
  mockKeychain.arm(null);
  for (const candidate of faults) {
    armed[candidate.op] = candidate;
    mockKeychain.arm(candidate);
  }
  return armed;
}

type Prestate = 'empty' | 'valid' | 'garbage';

function seedPrestate(prestate: Prestate, seed: number): VaultRecord | null {
  mockKeychain.store.clear();
  if (prestate === 'valid') {
    const record = seededRecord(seed);
    mockKeychain.seed(record);
    return record;
  }
  if (prestate === 'garbage') {
    mockKeychain.seed('{"version":1,"provider":"app');
  }
  return null;
}

const liveVault: VaultModule = {
  clearPersistedSession,
  loadPersistedSession,
  savePersistedSession,
  SESSION_VAULT_SERVICE,
};

// ─── Campaigns ──────────────────────────────────────────────────────────────

async function catalogueCampaign(
  campaign: string,
  kind: OpKind,
  faults: readonly KeychainFault[],
  prestates: readonly Prestate[],
): Promise<void> {
  let index = 0;
  for (const fault of faults) {
    for (const prestate of prestates) {
      index += 1;
      const startedReal = realNow();
      mockKeychain.reset();
      seedPrestate(prestate, 1_000 + index);
      const record = kind === 'save' ? seededRecord(5_000 + index) : null;
      const armed = armedFor([fault]);
      const outcome = await runOp(liveVault, kind, record, armed);
      const recovery = await recoveryProbe(liveVault);
      finishRow({
        campaign,
        scenario: `${fault.id}/prestate=${prestate}`,
        seed: null,
        faults: [fault],
        inputs: {
          op: kind,
          prestate,
          fault: fault.id,
          category: fault.category,
          delayMs: fault.delayMs ?? null,
        },
        observed: { ...opObserved(outcome), recovery: recovery.observed },
        invariants: { ...outcome.invariants, recoverable: recovery.ok },
        startedReal,
      });
    }
  }
}

async function moduleCampaign(): Promise<void> {
  for (const mode of MODULE_MODES) {
    for (const kind of ['save', 'load', 'clear'] as const) {
      const startedReal = realNow();
      mockKeychain.reset();
      const before = seedPrestate('valid', 9_000);
      mockKeychain.moduleMode = mode;
      let isolated: VaultModule | null = null;
      let loadError: string | null = null;
      // The mock factory only runs once per registry; drop the cached
      // instance so the isolated require re-evaluates it under this mode.
      jest.resetModules();
      jest.isolateModules(() => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          isolated = require('../../src/account/sessionVault') as VaultModule;
        } catch (error) {
          loadError =
            error instanceof Error
              ? `${error.name}: ${error.message}`
              : String(error);
        }
      });
      const vault = isolated as VaultModule | null;
      const invariants: Record<string, boolean> = {
        moduleLoads: vault !== null && loadError === null,
      };
      let observed: Record<string, unknown> = { loadError };
      if (vault) {
        const record = seededRecord(9_100);
        const outcome = await runOp(vault, kind, record, {
          get: null,
          set: null,
          reset: null,
        });
        Object.assign(invariants, outcome.invariants);
        // With the accessibility table missing, get/reset still work; save
        // cannot name its protection class and must fail soft.
        const usable = mode === 'accessible-undefined' && kind !== 'save';
        const value =
          outcome.settled.state === 'resolved'
            ? outcome.settled.value
            : undefined;
        if (!usable) {
          // The module is unusable for this op: it must fail soft and leave
          // the record alone (the honest-path invariants do not apply).
          delete invariants['honestFailure'];
          delete invariants['honestLoad'];
          delete invariants['clearApplied'];
          invariants['failsSoft'] =
            kind === 'save'
              ? value === false
              : kind === 'load'
                ? value === null
                : value === undefined;
          invariants['recordUntouched'] =
            mockKeychain.raw() === JSON.stringify(before);
        }
        observed = {
          ...observed,
          ...opObserved(outcome),
          accessiblePassed:
            mockKeychain.store.get(VAULT_SERVICE)?.accessible ?? null,
        };
      }
      mockKeychain.moduleMode = 'ok';
      jest.resetModules();
      finishRow({
        campaign: 'catalogue/module',
        scenario: `${mode}/${kind}`,
        seed: null,
        faults: [],
        inputs: { op: kind, moduleMode: mode, prestate: 'valid' },
        observed,
        invariants,
        startedReal,
      });
    }
  }
}

async function recordCampaign(): Promise<void> {
  const protoBefore = Object.getOwnPropertyNames(Object.prototype)
    .sort()
    .join(',');
  for (const corruption of RECORD_CORRUPTIONS) {
    const startedReal = realNow();
    mockKeychain.reset();
    const raw = corruption.raw();
    mockKeychain.seed(raw);
    const armed = armedFor([]);
    const parseStartedReal = realNow();
    const outcome = await runOp(liveVault, 'load', null, armed);
    const parseRealMs = realNow() - parseStartedReal;
    const value =
      outcome.settled.state === 'resolved' ? outcome.settled.value : undefined;
    const invariants: Record<string, boolean> = { ...outcome.invariants };
    if (corruption.expect === 'reject') {
      invariants['rejected'] = value === null;
      invariants['discarded'] =
        outcome.keychainOps.includes('reset') && mockKeychain.raw() === null;
    } else {
      invariants['accepted'] =
        isVaultRecord(value) && value.refreshToken === corruption.acceptedToken;
      invariants['onlyContractKeys'] =
        !!value &&
        typeof value === 'object' &&
        JSON.stringify(Object.keys(value as object).sort()) ===
          JSON.stringify(
            [
              'version',
              'provider',
              'canonicalAppUserId',
              'refreshToken',
              'email',
              'displayName',
            ].sort(),
          );
      invariants['noTokenLeak'] =
        !!value &&
        typeof value === 'object' &&
        !('accessToken' in (value as object)) &&
        !('bearerToken' in (value as object)) &&
        !('idToken' in (value as object));
    }
    invariants['prototypeClean'] =
      Object.getOwnPropertyNames(Object.prototype).sort().join(',') ===
        protoBefore && !('polluted' in Object.prototype);
    const recovery = await recoveryProbe(liveVault);
    invariants['recoverable'] = recovery.ok;
    finishRow({
      campaign: 'catalogue/record',
      scenario: corruption.id,
      seed: null,
      faults: [],
      inputs: {
        corruption: corruption.id,
        category: corruption.category,
        expect: corruption.expect,
        bytes: raw.length,
        rawHead: abbreviate(raw),
      },
      observed: {
        ...opObserved(outcome),
        parseRealMs,
        recovery: recovery.observed,
      },
      invariants,
      startedReal,
    });
  }
}

type StepKind = 'save' | 'load' | 'clear' | 'corrupt' | 'external-valid';
const STEP_KINDS: readonly StepKind[] = [
  'save',
  'load',
  'clear',
  'corrupt',
  'external-valid',
];

interface StepPlan {
  kind: StepKind;
  faults: KeychainFault[];
  record: VaultRecord | null;
  corruption: RecordCorruption | null;
}

const SEQUENCE_CORRUPTIONS = RECORD_CORRUPTIONS.filter(
  c => c.category !== 'oversized',
);

function planSequence(seed: number): StepPlan[] {
  const rng = makePrng(seed);
  const length = 3 + Math.floor(rng() * 6);
  const steps: StepPlan[] = [];
  for (let i = 0; i < length; i += 1) {
    const kind = pick(rng, STEP_KINDS);
    const faults: KeychainFault[] = [];
    if (kind === 'save' && rng() < 0.65) faults.push(pick(rng, SET_FAULTS));
    if (kind === 'load') {
      if (rng() < 0.65) faults.push(pick(rng, GET_FAULTS));
      if (rng() < 0.35) faults.push(pick(rng, RESET_FAULTS));
    }
    if (kind === 'clear' && rng() < 0.65) faults.push(pick(rng, RESET_FAULTS));
    steps.push({
      kind,
      faults,
      record:
        kind === 'save' || kind === 'external-valid'
          ? seededRecord(seed, i)
          : null,
      corruption: kind === 'corrupt' ? pick(rng, SEQUENCE_CORRUPTIONS) : null,
    });
  }
  return steps;
}

async function sequenceCampaign(from: number, count: number): Promise<void> {
  for (let seed = from; seed < from + count; seed += 1) {
    const startedReal = realNow();
    mockKeychain.reset();
    const steps = planSequence(seed);
    const invariants: Record<string, boolean> = {};
    const trace: unknown[] = [];
    const allFaults: KeychainFault[] = [];
    let stepIndex = 0;
    for (const step of steps) {
      stepIndex += 1;
      if (step.kind === 'corrupt') {
        mockKeychain.seed((step.corruption as RecordCorruption).raw());
        trace.push({
          step: stepIndex,
          kind: step.kind,
          corruption: step.corruption?.id,
        });
        continue;
      }
      if (step.kind === 'external-valid') {
        mockKeychain.seed(step.record as VaultRecord);
        trace.push({ step: stepIndex, kind: step.kind });
        continue;
      }
      allFaults.push(...step.faults);
      const armed = armedFor(step.faults);
      const outcome = await runOp(liveVault, step.kind, step.record, armed);
      for (const [name, held] of Object.entries(outcome.invariants)) {
        const key = `${name}`;
        invariants[key] = (invariants[key] ?? true) && held;
        if (!held) {
          invariants[`step${stepIndex}:${name}`] = false;
        }
      }
      trace.push({
        step: stepIndex,
        kind: step.kind,
        faults: step.faults.map(f => f.id),
        ...opObserved(outcome),
      });
    }
    const recovery = await recoveryProbe(liveVault);
    invariants['recoverable'] = recovery.ok;
    finishRow({
      campaign: 'seeded/sequence',
      scenario: `sequence/${seed}`,
      seed,
      faults: allFaults,
      inputs: {
        steps: steps.map(step => ({
          kind: step.kind,
          faults: step.faults.map(f => f.id),
          corruption: step.corruption?.id ?? null,
          token: step.record?.refreshToken ?? null,
        })),
      },
      observed: {
        trace,
        recovery: recovery.observed,
        finalClass: mockKeychain.classify(),
      },
      invariants,
      startedReal,
    });
  }
}

async function concurrentCampaign(from: number, count: number): Promise<void> {
  for (let seed = from; seed < from + count; seed += 1) {
    const startedReal = realNow();
    const rng = makePrng(seed ^ 0x5bd1e995);
    mockKeychain.reset();
    const initial = rng() < 0.7 ? seededRecord(seed, 99) : null;
    if (initial) mockKeychain.seed(initial);
    const faults: KeychainFault[] = [];
    if (rng() < 0.6) faults.push(pick(rng, GET_FAULTS));
    if (rng() < 0.6) faults.push(pick(rng, SET_FAULTS));
    if (rng() < 0.6) faults.push(pick(rng, RESET_FAULTS));
    const armed = armedFor(faults);
    const burst = 2 + Math.floor(rng() * 4);
    const kinds: OpKind[] = [];
    const saved: VaultRecord[] = [];
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < burst; i += 1) {
      const kind = pick(rng, ['save', 'load', 'clear'] as const);
      kinds.push(kind);
      if (kind === 'save') {
        const record = seededRecord(seed, i);
        saved.push(record);
        promises.push(liveVault.savePersistedSession(record));
      } else if (kind === 'load') {
        promises.push(liveVault.loadPersistedSession());
      } else {
        promises.push(liveVault.clearPersistedSession());
      }
    }
    const settledAll = await settleWithin(
      Promise.all(
        promises.map(promise =>
          promise.then(
            value => ({ state: 'resolved', value }) as const,
            (error: unknown) =>
              ({ state: 'rejected', error: String(error) }) as const,
          ),
        ),
      ),
      BUDGET_MS,
    );
    const results = settledAll.state === 'resolved' ? settledAll.value : null;
    const rawAfter = mockKeychain.raw();
    const candidates = new Set<string | null>([
      null,
      initial ? JSON.stringify(initial) : null,
    ]);
    for (const record of saved) candidates.add(JSON.stringify(record));
    const partialArmed = armed.set?.storeEffect === 'partial';
    const invariants: Record<string, boolean> = {};
    invariants['settlesWithin60s'] = settledAll.state !== 'pending';
    if (results) {
      invariants['noThrow'] = results.every(r => r.state === 'resolved');
      invariants['resultShape'] = results.every((r, i) => {
        if (r.state !== 'resolved') return true;
        const kind = kinds[i];
        if (kind === 'save') return typeof r.value === 'boolean';
        if (kind === 'load') return r.value === null || isVaultRecord(r.value);
        return r.value === undefined;
      });
      const known = [initial, ...saved].filter(
        (r): r is VaultRecord => r !== null,
      );
      invariants['noFabrication'] = results.every((r, i) => {
        if (
          r.state !== 'resolved' ||
          kinds[i] !== 'load' ||
          !isVaultRecord(r.value)
        )
          return true;
        const value = r.value;
        return known.some(record => sameRecord(record, value));
      });
      invariants['noFakeSuccess'] = results.every((r, i) => {
        if (r.state !== 'resolved' || kinds[i] !== 'save' || r.value !== true)
          return true;
        // A true must correspond to a moment the store held that record; with
        // concurrent overwrites the final store may differ, but a true from a
        // store-unchanged fault is a lie.
        return armed.set === null || armed.set.storeEffect !== 'unchanged';
      });
    }
    invariants['storeHonest'] =
      candidates.has(rawAfter) ||
      (partialArmed &&
        rawAfter !== null &&
        saved.some(r => isPrefixWrite(rawAfter, JSON.stringify(r))));
    const recovery = await recoveryProbe(liveVault);
    invariants['recoverable'] = recovery.ok;
    finishRow({
      campaign: 'seeded/concurrent',
      scenario: `concurrent/${seed}`,
      seed,
      faults,
      inputs: {
        initial: initial?.refreshToken ?? null,
        burst: kinds,
        faults: faults.map(f => f.id),
        tokens: saved.map(r => r.refreshToken),
      },
      observed: {
        results: results
          ? results.map(r => (r.state === 'resolved' ? describeSettled(r) : r))
          : 'pending',
        elapsedMs: settledAll.elapsedMs,
        rawAfter: abbreviate(rawAfter),
        finalClass: mockKeychain.classify(),
        recovery: recovery.observed,
      },
      invariants,
      startedReal,
    });
  }
}

// ─── Runner ─────────────────────────────────────────────────────────────────

beforeAll(() => {
  jest.useFakeTimers();
});

afterAll(() => {
  mockKeychain.reset();
  jest.useRealTimers();
  const summary = {
    ...summarizeRows(rows),
    knownDeviationCatalogue: KNOWN_DEVIATIONS,
    iterations: { sequence: SEQUENCE_ITER, concurrent: CONCURRENT_ITER },
    node:
      (globalThis as { process?: { version?: string } }).process?.version ??
      null,
  };
  writeStressArtifact('module-rows.json', rows);
  writeStressArtifact('module-summary.json', summary);
});

describe('sessionVault failure injection (module)', () => {
  const full = REPLAY_SEED === null;
  const catalogueIt = full ? it : it.skip;

  catalogueIt(
    'catalogue: every getGenericPassword fault × {valid, empty, garbage} prestate',
    async () => {
      await catalogueCampaign('catalogue/get', 'load', GET_FAULTS, [
        'valid',
        'empty',
        'garbage',
      ]);
    },
  );

  catalogueIt(
    'catalogue: every setGenericPassword fault × {empty, valid, garbage} prestate',
    async () => {
      await catalogueCampaign('catalogue/set', 'save', SET_FAULTS, [
        'empty',
        'valid',
        'garbage',
      ]);
    },
  );

  catalogueIt(
    'catalogue: every resetGenericPassword fault × {valid, garbage, empty} prestate',
    async () => {
      await catalogueCampaign('catalogue/reset', 'clear', RESET_FAULTS, [
        'valid',
        'garbage',
        'empty',
      ]);
    },
  );

  catalogueIt(
    'catalogue: every module shape × {save, load, clear}',
    async () => {
      await moduleCampaign();
    },
  );

  catalogueIt(
    'catalogue: every record corruption (malformed / partial / oversized / accepted)',
    async () => {
      await recordCampaign();
    },
  );

  it(`seeded op sequences ×${SEQUENCE_ITER} (mulberry32, seed = index)`, async () => {
    if (REPLAY_SEED === null) await sequenceCampaign(1, SEQUENCE_ITER);
    else await sequenceCampaign(REPLAY_SEED, 1);
  });

  it(`seeded concurrent bursts ×${CONCURRENT_ITER} (mulberry32, seed = index)`, async () => {
    if (REPLAY_SEED === null) await concurrentCampaign(1, CONCURRENT_ITER);
    else await concurrentCampaign(REPLAY_SEED, 1);
  });

  catalogueIt(
    'injected at least 60 distinct faults and every fault in the catalogue ran',
    () => {
      const injected = new Set(rows.flatMap(row => row.faults));
      const missing = ALL_FAULTS.map(f => f.id).filter(id => !injected.has(id));
      expect(missing).toEqual([]);
      const moduleRows = rows.filter(
        row => row.campaign === 'catalogue/module',
      );
      expect(
        new Set(moduleRows.map(row => row.inputs['moduleMode'] as ModuleMode))
          .size,
      ).toBe(MODULE_MODES.length);
      expect(
        injected.size + MODULE_MODES.length + RECORD_CORRUPTIONS.length,
      ).toBeGreaterThanOrEqual(60);
      expect(injected.size).toBeGreaterThanOrEqual(60);
    },
  );

  catalogueIt(
    'every triaged deviation is still reproduced (remove it from KNOWN_DEVIATIONS once fixed)',
    () => {
      const seen = new Set(
        rows.flatMap(row => row.knownDeviations.map(e => e.split(':')[0])),
      );
      for (const id of Object.keys(KNOWN_DEVIATIONS)) {
        expect(seen.has(id)).toBe(true);
      }
    },
  );

  it('no row fails an invariant outside the known deviations', () => {
    const failing = rows
      .filter(row => !row.ok)
      .map(row => ({
        campaign: row.campaign,
        scenario: row.scenario,
        seed: row.seed,
        failed: row.failed,
      }));
    expect(failing).toEqual([]);
    expect(rows.length).toBeGreaterThan(0);
  });
});
