/**
 * STRESS — sessionVault record handling (corrupt / missing / oversized /
 * native failure), seeded and replayable; plus a mutation self-check that
 * proves the concurrency oracle in `testing/sessionVaultStress` actually
 * catches a lying vault.
 *
 * Campaign C fuzzes the STORED record with a seeded corpus (valid, extra
 * keys, dropped/retyped keys, bad provider/version, empty required fields,
 * scalars, arrays, truncated JSON, garbage text, `__proto__` keys, 200 KB
 * fields) and checks `loadPersistedSession` against an independent reference
 * parser: exact session or null, malformed ⇒ exactly one discard reset and an
 * empty row, valid ⇒ no reset and untouched row, never throws, never leaks
 * extra keys (no access-token field can ride along), no prototype pollution.
 * Campaign D drives `savePersistedSession` across a seeded size spectrum
 * around a native size limit: the boolean is truthful, round-trip is exact
 * for accepted payloads, and a rejected write's consequence under the iOS
 * module's delete-then-insert semantics is recorded.
 *
 * Replay: `STRESS_SEED=<seed> npx jest __tests__/stress/sessionVaultRecords`
 * Scale:  `STRESS_ITER=5000 npx jest __tests__/stress/sessionVaultRecords`
 */
import {
  generateRecord,
  referenceParse,
  sessionOfSize,
  utf8ByteLength,
} from '../../testing/sessionVaultStress/corpus';
import {
  fakeKeychainNative,
  seededRng,
} from '../../testing/sessionVaultStress/fakeKeychain';
import {
  type SeedRow,
  campaignSeeds,
  summarize,
  writeTable,
} from '../../testing/sessionVaultStress/report';
import {
  VAULT_SERVICE,
  type VaultApi,
  runSeed,
} from '../../testing/sessionVaultStress/runner';
import {
  type PersistedSession,
  clearPersistedSession,
  loadPersistedSession,
  savePersistedSession,
} from '../../src/account/sessionVault';

jest.mock(
  'react-native-keychain',
  () =>
    jest.requireActual<{
      fakeKeychainModule: unknown;
    }>('../../testing/sessionVaultStress/fakeKeychain').fakeKeychainModule,
);

const ACCESSIBLE = 'AccessibleAfterFirstUnlockThisDeviceOnly';
const WALL_BUDGET_MS = 2_000;

function seedRow(password: string, accessible: string = ACCESSIBLE): void {
  fakeKeychainNative.store.set(VAULT_SERVICE, {
    username: 'session',
    password,
    accessible,
  });
}

function ownKeys(value: unknown): string[] {
  return value && typeof value === 'object' ? Object.keys(value).sort() : [];
}

describe('sessionVault record stress (seeded)', () => {
  beforeEach(() => {
    fakeKeychainNative.reset();
    fakeKeychainNative.configure({
      order: 'fifo',
      rng: seededRng(7),
      faultRate: 0,
      maxBytes: Number.POSITIVE_INFINITY,
      failedSetDeletesFirst: true,
      corruptRead: undefined,
    });
  });

  it('campaign C — corrupt/valid stored-record fuzz matches the reference contract', async () => {
    const rows: SeedRow[] = [];
    const started = Date.now();
    const kinds = new Set<string>();
    for (const seed of campaignSeeds(0x5e55_4000)) {
      const rng = seededRng(seed);
      const entry = generateRecord(rng);
      kinds.add(entry.kind);
      fakeKeychainNative.reset();
      seedRow(entry.password);
      const expected = referenceParse(entry.password);
      const t0 = Date.now();
      const violated: string[] = [];
      let loaded: PersistedSession | null = null;
      let threw = false;
      const pending = loadPersistedSession().then(
        value => {
          loaded = value;
        },
        () => {
          threw = true;
        },
      );
      await fakeKeychainNative.drain(4, WALL_BUDGET_MS);
      await pending;
      const log = fakeKeychainNative.log.map(op => `${op.kind}:${op.outcome}`);
      const row = fakeKeychainNative.store.get(VAULT_SERVICE);
      if (threw) violated.push('R1.load-threw');
      if (JSON.stringify(loaded) !== JSON.stringify(expected)) {
        violated.push('R2.load-result-differs-from-reference');
      }
      if (loaded !== null) {
        const keys = ownKeys(loaded);
        if (
          keys.join(',') !==
          'canonicalAppUserId,displayName,email,provider,refreshToken,version'
        ) {
          violated.push('R3.extra-or-missing-keys');
        }
        if (Object.getPrototypeOf(loaded) !== Object.prototype) {
          violated.push('R3.prototype');
        }
      }
      const probe: { polluted?: boolean } = {};
      if (probe.polluted !== undefined) {
        violated.push('R3.prototype-pollution');
      }
      if (expected === null) {
        if (log.join(',') !== 'get:ok,reset:ok')
          violated.push('R4.discard-not-issued');
        if (row !== undefined) violated.push('R4.malformed-record-kept');
      } else {
        if (log.join(',') !== 'get:ok') violated.push('R5.valid-record-reset');
        if (row?.password !== entry.password)
          violated.push('R5.valid-record-mutated');
      }
      const durationMs = Date.now() - t0;
      if (durationMs > WALL_BUDGET_MS) violated.push('R6.wall-time');
      rows.push({
        seed,
        scenario: `fuzz/${entry.kind}/${utf8ByteLength(entry.password)}B`,
        inputs: {
          kind: entry.kind,
          password:
            entry.password.length > 256
              ? `${entry.password.slice(0, 256)}…(${entry.password.length} chars)`
              : entry.password,
        },
        observed: { loaded, log, finalPresent: row !== undefined },
        violated,
        verdict: violated.length === 0 ? 'HELD' : 'BROKEN',
        defectClass: null,
        durationMs,
      });
    }
    const table = summarize('C-record-fuzz', rows, Date.now() - started);
    writeTable(table);
    if (rows.length > 1) expect(kinds.size).toBeGreaterThanOrEqual(12);
    expect(
      rows
        .filter(row => row.verdict === 'BROKEN')
        .slice(0, 10)
        .map(
          row => `seed=${row.seed} ${row.scenario} ${row.violated.join(',')}`,
        )
        .join('\n'),
    ).toBe('');
  });

  it('campaign D — oversized payload spectrum: truthful result, exact round-trip, recorded consequence of a rejected write', async () => {
    const LIMIT = 4096;
    const rows: SeedRow[] = [];
    const started = Date.now();
    let rejected = 0;
    for (const seed of campaignSeeds(0x5e55_5000)) {
      const rng = seededRng(seed);
      fakeKeychainNative.reset();
      fakeKeychainNative.configure({ maxBytes: LIMIT, rng: seededRng(seed) });
      const previous = sessionOfSize(rng, 200 + rng.int(200));
      seedRow(JSON.stringify(previous));
      // Bias toward the boundary; occasionally go far past it.
      const target = rng.chance(0.15)
        ? LIMIT * (2 + rng.int(64))
        : LIMIT - 64 + rng.int(129);
      const session = sessionOfSize(rng, target);
      const payload = JSON.stringify(session);
      const bytes = utf8ByteLength(payload);
      const fits = bytes <= LIMIT;
      const t0 = Date.now();
      const violated: string[] = [];
      const pending = savePersistedSession(session).then(
        value => value,
        (error: unknown) => error,
      );
      await fakeKeychainNative.drain(2, WALL_BUDGET_MS);
      const saved = await pending;
      if (typeof saved !== 'boolean') violated.push('S1.save-threw');
      if (saved !== fits) violated.push('S2.save-result-untruthful');
      const row = fakeKeychainNative.store.get(VAULT_SERVICE);
      if (fits && row?.password !== payload)
        violated.push('S3.accepted-not-stored');
      if (fits && row?.accessible !== ACCESSIBLE)
        violated.push('S3.accessibility');
      const load = loadPersistedSession();
      await fakeKeychainNative.drain(2, WALL_BUDGET_MS);
      const loaded = await load;
      if (fits && JSON.stringify(loaded) !== payload) {
        violated.push('S4.round-trip-mismatch');
      }
      if (!fits) {
        rejected += 1;
        // iOS module deletes the old item BEFORE the insert that then fails.
        if (row !== undefined)
          violated.push('S5.model-rejected-write-left-row');
        if (loaded !== null) violated.push('S5.load-after-rejected-write');
      }
      const durationMs = Date.now() - t0;
      if (durationMs > WALL_BUDGET_MS) violated.push('S6.wall-time');
      rows.push({
        seed,
        scenario: `oversize/${fits ? 'fits' : 'rejected'}/${bytes}B`,
        inputs: {
          limitBytes: LIMIT,
          payloadBytes: bytes,
          previousBytes: utf8ByteLength(JSON.stringify(previous)),
        },
        observed: {
          saved,
          finalPresent: row !== undefined,
          loadedAfter: loaded === null ? null : 'session',
          log: fakeKeychainNative.log.map(op => `${op.kind}:${op.outcome}`),
        },
        violated,
        verdict: violated.length === 0 ? 'HELD' : 'BROKEN',
        defectClass: null,
        durationMs,
      });
    }
    const table = summarize('D-oversize', rows, Date.now() - started);
    writeTable(table);
    if (rows.length > 1) {
      expect(rejected).toBeGreaterThan(0);
      expect(rejected).toBeLessThan(rows.length);
    }
    expect(
      rows
        .filter(row => row.verdict === 'BROKEN')
        .slice(0, 10)
        .map(
          row => `seed=${row.seed} ${row.scenario} ${row.violated.join(',')}`,
        )
        .join('\n'),
    ).toBe('');
  });

  it('a 1 MiB session round-trips exactly when the native accepts it', async () => {
    const session = sessionOfSize(seededRng(11), 1 << 20);
    const save = savePersistedSession(session);
    await fakeKeychainNative.drain(1, WALL_BUDGET_MS);
    expect(await save).toBe(true);
    const load = loadPersistedSession();
    await fakeKeychainNative.drain(1, WALL_BUDGET_MS);
    expect(await load).toEqual(session);
    expect(
      fakeKeychainNative.log.map(op => `${op.kind}:${op.outcome}`),
    ).toEqual(['set:ok', 'get:ok']);
  });

  it('missing record: load returns null and issues no discard', async () => {
    const load = loadPersistedSession();
    await fakeKeychainNative.drain(2, WALL_BUDGET_MS);
    expect(await load).toBeNull();
    expect(fakeKeychainNative.log.map(op => op.kind)).toEqual(['get']);
  });

  it('undecodable record (item present, no password field): load returns null and discards it', async () => {
    seedRow('\u0000<not-utf8>\u0000');
    fakeKeychainNative.configure({
      corruptRead: () => ({ password: undefined }),
    });
    const load = loadPersistedSession();
    await fakeKeychainNative.drain(2, WALL_BUDGET_MS);
    expect(await load).toBeNull();
    expect(
      fakeKeychainNative.log.map(op => `${op.kind}:${op.outcome}`),
    ).toEqual(['get:ok', 'reset:ok']);
    expect(fakeKeychainNative.store.size).toBe(0);
  });

  it('Keychain faults on every call: save false, load null, clear resolves, record untouched', async () => {
    const stored = sessionOfSize(seededRng(3), 300);
    seedRow(JSON.stringify(stored));
    fakeKeychainNative.configure({ faultRate: 1 });
    const burst = Promise.all([
      savePersistedSession(sessionOfSize(seededRng(4), 300)),
      loadPersistedSession(),
      clearPersistedSession(),
      loadPersistedSession(),
    ]);
    await fakeKeychainNative.drain(8, WALL_BUDGET_MS);
    const [saved, loaded, cleared, loadedAgain] = await burst;
    expect(saved).toBe(false);
    expect(loaded).toBeNull();
    expect(cleared).toBeUndefined();
    expect(loadedAgain).toBeNull();
    expect(
      fakeKeychainNative.log.map(op => `${op.kind}:${op.outcome}`),
    ).toEqual(['set:fault', 'get:fault', 'reset:fault', 'get:fault']);
    // A faulting set has already deleted the old item (iOS module semantics):
    // the record is gone even though nothing new was written.
    expect(fakeKeychainNative.store.get(VAULT_SERVICE)).toBeUndefined();
  });

  it('a faulting read leaves the stored record alone (no discard on transport error)', async () => {
    const stored = sessionOfSize(seededRng(5), 300);
    seedRow(JSON.stringify(stored));
    fakeKeychainNative.configure({ faultRate: 1 });
    const load = loadPersistedSession();
    await fakeKeychainNative.drain(2, WALL_BUDGET_MS);
    expect(await load).toBeNull();
    expect(fakeKeychainNative.log.map(op => op.kind)).toEqual(['get']);
    expect(fakeKeychainNative.store.get(VAULT_SERVICE)?.password).toBe(
      JSON.stringify(stored),
    );
  });

  describe('oracle self-check: mutated vaults are caught (the harness is not vacuous)', () => {
    const real: VaultApi = {
      savePersistedSession,
      loadPersistedSession,
      clearPersistedSession,
    };
    const options = {
      order: 'fifo' as const,
      maxFaultRate: 0.5,
      wallBudgetMs: WALL_BUDGET_MS,
      maxSteps: 64,
    };
    const SEEDS = 120;

    async function brokenCount(mutant: VaultApi): Promise<number> {
      let broken = 0;
      for (let i = 0; i < SEEDS; i += 1) {
        const { row } = await runSeed(
          0x5e55_6000 + i,
          fakeKeychainNative,
          mutant,
          options,
        );
        if (row.verdict === 'BROKEN' && row.defectClass === null) broken += 1;
      }
      return broken;
    }

    it('flags a save that reports true after a native failure (I4)', async () => {
      const mutant: VaultApi = {
        ...real,
        savePersistedSession: session =>
          real.savePersistedSession(session).then(() => true),
      };
      expect(await brokenCount(mutant)).toBeGreaterThan(0);
    });

    it('flags a load that serves a cached session instead of the row (I5)', async () => {
      let cached: PersistedSession | null = null;
      const mutant: VaultApi = {
        ...real,
        loadPersistedSession: async () => {
          const value = await real.loadPersistedSession();
          if (value) cached = value;
          return cached;
        },
      };
      expect(await brokenCount(mutant)).toBeGreaterThan(0);
    });

    it('flags a clear that skips the native reset (I6/I7)', async () => {
      const mutant: VaultApi = {
        ...real,
        clearPersistedSession: async () => undefined,
      };
      expect(await brokenCount(mutant)).toBeGreaterThan(0);
    });

    it('flags a save that writes twice (duplicate native traffic, I6)', async () => {
      const mutant: VaultApi = {
        ...real,
        savePersistedSession: async session => {
          const [first] = await Promise.all([
            real.savePersistedSession(session),
            real.savePersistedSession(session),
          ]);
          return first;
        },
      };
      expect(await brokenCount(mutant)).toBeGreaterThan(0);
    });
  });
});
