/**
 * STRESS / concurrency — `src/account/sessionVault.ts`
 *
 * Seeded interleaving campaign over the vault API (save / load / clear) with
 * a controllable fake native underneath (`testing/sessionVaultStress`):
 * Promise.all bursts, duplicate calls, call-during-call, abandoned calls,
 * two actors on the one Keychain row, token rotation and logout racing a
 * read, corrupt / undecodable initial records, injected Keychain faults.
 *
 * Campaign A models the platform: the iOS module runs every call on one
 * serial dispatch queue, so native completion order == JS issue order
 * (FIFO). Every violation here is a real vault bug.
 * Campaign B lets the scheduler complete pending calls in seeded random
 * order — an adversarial model the platform does not produce. The oracle
 * replays the native completion log as a sequential store (completion order
 * is the linearization under both schedulers), so the same invariants apply:
 * fail-soft, no torn/duplicate rows, truthful save/load results, exactly one
 * native call per API call (+ one discard per malformed read), no lost
 * update, bounded wall time.
 *
 * Known defect (reported, pinned below with `it.failing` so the suite stays
 * green until it is fixed — and goes red the moment the fix lands so the pin
 * gets flipped): `discard-race` — a load that reads a malformed record
 * issues an unconditional `clearPersistedSession()` (sessionVault.ts:114);
 * under FIFO that reset lands after a concurrently issued save's set and
 * deletes the fresh session although the save resolved `true`. Campaign rows
 * carrying exactly that signature are counted in the JSON table
 * (`brokenByDefectClass`) and are the ONLY tolerated BROKEN rows; any
 * unclassified violation fails the campaign.
 *
 * Replay: `STRESS_SEED=<seed> npx jest __tests__/stress/sessionVaultConcurrency`
 * Scale:  `STRESS_ITER=5000 npx jest __tests__/stress/sessionVaultConcurrency`
 * Table:  artifacts/stress/session-vault/<STRESS_RUN_ID>/<campaign>.json
 */
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
  type VaultApi,
  runSeed,
} from '../../testing/sessionVaultStress/runner';
import {
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

const vault: VaultApi = {
  savePersistedSession,
  loadPersistedSession,
  clearPersistedSession,
};

const WALL_BUDGET_MS = 2_000;
const MAX_STEPS = 64;

async function campaign(
  name: string,
  baseSeed: number,
  order: 'fifo' | 'random',
  maxFaultRate: number,
): Promise<{ rows: SeedRow[]; file: string }> {
  const seeds = campaignSeeds(baseSeed);
  const rows: SeedRow[] = [];
  const started = Date.now();
  for (const seed of seeds) {
    const { row } = await runSeed(seed, fakeKeychainNative, vault, {
      order,
      maxFaultRate,
      wallBudgetMs: WALL_BUDGET_MS,
      maxSteps: MAX_STEPS,
    });
    rows.push(row);
  }
  const table = summarize(name, rows, Date.now() - started);
  const file = writeTable(table);
  return { rows, file };
}

function unclassifiedSummary(rows: SeedRow[]): string {
  return rows
    .filter(row => row.verdict === 'BROKEN' && row.defectClass === null)
    .slice(0, 10)
    .map(row => `seed=${row.seed} ${row.scenario} ${row.violated.join(',')}`)
    .join('\n');
}

function knownDefects(rows: SeedRow[]): number {
  return rows.filter(row => row.defectClass !== null).length;
}

function fullCampaign(rows: SeedRow[]): boolean {
  return rows.length > 1;
}

const MALFORMED = '{"version":1,"provider":"apple"}';
const FRESH = {
  version: 1 as const,
  provider: 'google' as const,
  canonicalAppUserId: 'user-fresh',
  refreshToken: 'rt-fresh',
  email: null,
  displayName: 'Fresh',
};

describe('sessionVault concurrency stress (seeded)', () => {
  beforeEach(() => {
    fakeKeychainNative.reset();
  });

  it('campaign A — platform FIFO native, no faults: every interleaving holds', async () => {
    const { rows } = await campaign('A-fifo-clean', 0x5e55_1000, 'fifo', 0);
    expect(rows.length).toBeGreaterThan(0);
    expect(unclassifiedSummary(rows)).toBe('');
    // Coverage checks apply to a campaign, not to a single STRESS_SEED replay:
    // the generator must have produced every shape, and the seeds must have
    // actually exercised the known discard race.
    if (fullCampaign(rows)) {
      const inputs = rows.map(row => JSON.stringify(row.inputs));
      expect(inputs.some(text => text.includes('"after":'))).toBe(true);
      expect(inputs.some(text => text.includes('"abandoned":true'))).toBe(true);
      expect(inputs.some(text => text.includes('"malformed"'))).toBe(true);
      expect(knownDefects(rows)).toBeGreaterThan(0);
    }
  });

  it('campaign A′ — platform FIFO native with injected Keychain faults', async () => {
    const { rows } = await campaign('A-fifo-faults', 0x5e55_2000, 'fifo', 0.5);
    expect(rows.length).toBeGreaterThan(0);
    if (fullCampaign(rows)) {
      expect(rows.some(row => (row.inputs['faultRate'] as number) > 0)).toBe(
        true,
      );
    }
    expect(unclassifiedSummary(rows)).toBe('');
  });

  it('campaign B — adversarial random native completion order: order-independent invariants hold', async () => {
    const { rows } = await campaign(
      'B-random-order',
      0x5e55_3000,
      'random',
      0.3,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(unclassifiedSummary(rows)).toBe('');
  });

  // Minimal repro of `discard-race` (minimized from campaign A seed
  // 1582633249: initial malformed record, burst = [load, save]). Flip to a
  // plain `it` once sessionVault only discards the record it actually read.
  it.failing(
    "KNOWN DEFECT discard-race: a save issued during a malformed-record load survives the load's discard",
    async () => {
      fakeKeychainNative.reset();
      fakeKeychainNative.configure({
        order: 'fifo',
        rng: seededRng(1),
        faultRate: 0,
      });
      fakeKeychainNative.store.set('com.picklesensei.auth.session', {
        username: 'session',
        password: MALFORMED,
        accessible: 'AccessibleAfterFirstUnlockThisDeviceOnly',
      });
      const burst = Promise.all([
        loadPersistedSession(),
        savePersistedSession(FRESH),
      ]);
      await fakeKeychainNative.drain(8, WALL_BUDGET_MS);
      const [loaded, saved] = await burst;
      expect(loaded).toBeNull();
      expect(saved).toBe(true);
      expect(
        fakeKeychainNative.log.map(op => `${op.kind}:${op.outcome}`),
      ).toEqual(['get:ok', 'set:ok', 'reset:ok']);
      // Expected: the row holds the fresh session the save reported durable.
      expect(
        fakeKeychainNative.store.get('com.picklesensei.auth.session')?.password,
      ).toBe(JSON.stringify(FRESH));
    },
  );

  it('the same two calls issued in the other order (save, then load) keep the fresh session', async () => {
    fakeKeychainNative.reset();
    fakeKeychainNative.configure({
      order: 'fifo',
      rng: seededRng(1),
      faultRate: 0,
    });
    fakeKeychainNative.store.set('com.picklesensei.auth.session', {
      username: 'session',
      password: MALFORMED,
      accessible: 'AccessibleAfterFirstUnlockThisDeviceOnly',
    });
    const burst = Promise.all([
      savePersistedSession(FRESH),
      loadPersistedSession(),
    ]);
    await fakeKeychainNative.drain(8, WALL_BUDGET_MS);
    const [saved, loaded] = await burst;
    expect(saved).toBe(true);
    expect(loaded).toEqual(FRESH);
    expect(fakeKeychainNative.issued).toBe(2);
    expect(
      fakeKeychainNative.store.get('com.picklesensei.auth.session')?.password,
    ).toBe(JSON.stringify(FRESH));
  });

  it('duplicate saves of one payload are idempotent: one row, all true, one native set each', async () => {
    const seeds = campaignSeeds(0x5e55_4000).slice(0, 50);
    for (const seed of seeds) {
      const rng = seededRng(seed);
      fakeKeychainNative.reset();
      fakeKeychainNative.configure({ order: 'fifo', rng, faultRate: 0 });
      const session = {
        version: 1 as const,
        provider: 'apple' as const,
        canonicalAppUserId: `user-${seed}`,
        refreshToken: `rt-${seed}`,
        email: null,
        displayName: null,
      };
      const count = 2 + rng.int(30);
      const results = Promise.all(
        Array.from({ length: count }, () => savePersistedSession(session)),
      );
      await fakeKeychainNative.drain(count + 2, WALL_BUDGET_MS);
      expect(await results).toEqual(Array.from({ length: count }, () => true));
      expect(fakeKeychainNative.store.size).toBe(1);
      expect(fakeKeychainNative.issued).toBe(count);
      expect(
        fakeKeychainNative.store.get('com.picklesensei.auth.session')?.password,
      ).toBe(JSON.stringify(session));
    }
  });

  it('duplicate clears and loads over an empty vault are idempotent and never throw', async () => {
    fakeKeychainNative.reset();
    fakeKeychainNative.configure({
      order: 'fifo',
      rng: seededRng(7),
      faultRate: 0,
    });
    const clears = Promise.all(
      Array.from({ length: 200 }, () => clearPersistedSession()),
    );
    const loads = Promise.all(
      Array.from({ length: 200 }, () => loadPersistedSession()),
    );
    await fakeKeychainNative.drain(400, WALL_BUDGET_MS);
    await expect(clears).resolves.toHaveLength(200);
    await expect(loads).resolves.toEqual(
      Array.from({ length: 200 }, () => null),
    );
    expect(fakeKeychainNative.issued).toBe(400);
    expect(fakeKeychainNative.store.size).toBe(0);
  });
});
