/**
 * STRESS — sessionVault Keychain persistence, lens `randomized-seeded`.
 *
 * Seeded random sequences (length 5–60) of legal and near-legal actions over
 * the public API of `src/account/sessionVault.ts` — save / load / clear,
 * externally corrupted / truncated / oversized / foreign Keychain items,
 * injected Keychain faults (rejects, `false` results, garbage passwords, a
 * missing native module) and concurrent batches — model-checked after every
 * step against the invariants documented in
 * `test-support/stress/sessionVaultHarness.ts` (I1–I9).
 *
 * Scale is controlled by the environment so the suite stays fast by default:
 *   STRESS_ITER=2000 STRESS_SEED=20260904 STRESS_OUT=/tmp/vault.json \
 *     npx jest --ci __tests__/stress/sessionVaultModelChecked.stress.test.ts
 * Every sequence is replayable from its seed; failing seeds are minimized and
 * re-run 10× for a flake rate, and the whole table is written to STRESS_OUT.
 *
 * Open findings (pinned with `it.failing` so this suite flips the day they are
 * fixed — remove the pin together with the fix):
 *   F1 (I6) `savePersistedSession` serializes whatever object it is handed;
 *      a non-contract field on the record (e.g. `accessToken`) lands in the
 *      Keychain verbatim. No current caller passes one (authStore builds the
 *      literal), so this is a hardening gap, not a live leak.
 *   F2 (I7) `loadPersistedSession` reads, then — for a malformed item —
 *      resets in a second round trip; a save that lands between the two is
 *      wiped, so the batch is not linearizable (save resolved true, Keychain
 *      empty). Not reachable from the app's hydrate-then-sign-in order today.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  CORRUPTION_KINDS,
  corruptionContent,
  createFakeKeychain,
  genSequence,
  genSession,
  materialize,
  minimizeSequence,
  Rng,
  runSequence,
  sequenceSeed,
  type InvariantId,
  type Sequence,
  type SequenceOutcome,
  type VaultApi,
} from '../../test-support/stress/sessionVaultHarness';

const mockKeychain = createFakeKeychain();
jest.mock('react-native-keychain', () => mockKeychain.module);

import * as vault from '../../src/account/sessionVault';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';

const ITERATIONS = Number(process.env['STRESS_ITER'] ?? 120);
const BASE_SEED = Number(process.env['STRESS_SEED'] ?? 20260904);
const OUT_PATH = process.env['STRESS_OUT'];
const FLAKE_RERUNS = 10;
const MINIMIZE_PER_INVARIANT = 5;

/** Invariants with an open finding above; everything else must hold. */
const OPEN_FINDINGS: ReadonlySet<InvariantId> = new Set<InvariantId>([
  'I6',
  'I7',
]);

const vaultApi: VaultApi = {
  savePersistedSession: vault.savePersistedSession,
  loadPersistedSession: vault.loadPersistedSession,
  clearPersistedSession: vault.clearPersistedSession,
};

interface CampaignTable {
  runId: string;
  unit: string;
  lens: string;
  baseSeed: number;
  iterations: number;
  lengthRange: [number, number];
  openFindings: InvariantId[];
  summary: {
    sequences: number;
    actionsExecuted: number;
    opsExecuted: number;
    held: number;
    broken: number;
    brokenOnlyOpenFindings: number;
    brokenOtherInvariants: number;
    violationsPerInvariant: Record<string, number>;
    maxOpMs: number;
    wallMs: number;
  };
  results: Array<{
    seed: number;
    length: number;
    outcome: 'HELD' | 'BROKEN';
    invariants: InvariantId[];
    firstViolation: string | null;
    opsExecuted: number;
    maxOpMs: number;
    durationMs: number;
    traceDigest: string;
  }>;
  minimized: Array<{
    seed: number;
    invariant: InvariantId;
    originalLength: number;
    minimizedLength: number;
    actions: Sequence['actions'];
    detail: string;
  }>;
  flakeReruns: Array<{
    seed: number;
    invariant: InvariantId;
    reruns: number;
    reproduced: number;
    rate: number;
  }>;
  determinism: Array<{ seed: number; identical: boolean }>;
}

beforeEach(() => {
  mockKeychain.reset();
});

describe('sessionVault — seeded randomized long-run', () => {
  it(
    `campaign: ${ITERATIONS} seeded sequences hold every invariant except the documented open findings`,
    async () => {
      const wallStart = Date.now();
      const outcomes: SequenceOutcome[] = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const seed = sequenceSeed(BASE_SEED, i);
        outcomes.push(
          await runSequence(vaultApi, mockKeychain, genSequence(seed)),
        );
      }

      const perInvariant: Record<string, number> = {};
      for (const o of outcomes) {
        for (const v of o.violations) {
          perInvariant[v.invariant] = (perInvariant[v.invariant] ?? 0) + 1;
        }
      }

      // Minimize + flake-check a bounded number of failing seeds per invariant.
      const minimized: CampaignTable['minimized'] = [];
      const flakeReruns: CampaignTable['flakeReruns'] = [];
      const seen = new Map<InvariantId, number>();
      for (const o of outcomes) {
        for (const invariant of new Set(o.violations.map(v => v.invariant))) {
          const count = seen.get(invariant) ?? 0;
          if (count >= MINIMIZE_PER_INVARIANT) continue;
          seen.set(invariant, count + 1);
          const original = genSequence(o.seed);
          const small = await minimizeSequence(
            vaultApi,
            mockKeychain,
            original,
            invariant,
          );
          const check = await runSequence(vaultApi, mockKeychain, small);
          const detail =
            check.violations.find(v => v.invariant === invariant)?.detail ??
            '(minimized sequence no longer reproduces)';
          minimized.push({
            seed: o.seed,
            invariant,
            originalLength: original.actions.length,
            minimizedLength: small.actions.length,
            actions: small.actions,
            detail,
          });
          let reproduced = 0;
          for (let r = 0; r < FLAKE_RERUNS; r++) {
            const again = await runSequence(vaultApi, mockKeychain, original);
            if (again.violations.some(v => v.invariant === invariant)) {
              reproduced++;
            }
          }
          flakeReruns.push({
            seed: o.seed,
            invariant,
            reruns: FLAKE_RERUNS,
            reproduced,
            rate: reproduced / FLAKE_RERUNS,
          });
        }
      }

      // Determinism: the first 25 seeds re-run must produce identical traces.
      const determinism: CampaignTable['determinism'] = [];
      for (const o of outcomes.slice(0, 25)) {
        const again = await runSequence(
          vaultApi,
          mockKeychain,
          genSequence(o.seed),
        );
        determinism.push({
          seed: o.seed,
          identical:
            again.traceDigest === o.traceDigest &&
            JSON.stringify(again.violations) === JSON.stringify(o.violations),
        });
      }

      const brokenOnlyOpen = outcomes.filter(
        o =>
          o.violations.length > 0 &&
          o.violations.every(v => OPEN_FINDINGS.has(v.invariant)),
      );
      const brokenOther = outcomes.filter(o =>
        o.violations.some(v => !OPEN_FINDINGS.has(v.invariant)),
      );

      const table: CampaignTable = {
        runId: `session-vault-randomized-seeded-${BASE_SEED}-${ITERATIONS}`,
        unit: 'apps/mobile/src/account/sessionVault.ts',
        lens: 'randomized-seeded',
        baseSeed: BASE_SEED,
        iterations: ITERATIONS,
        lengthRange: [5, 60],
        openFindings: [...OPEN_FINDINGS],
        summary: {
          sequences: outcomes.length,
          actionsExecuted: outcomes.reduce((n, o) => n + o.actionsExecuted, 0),
          opsExecuted: outcomes.reduce((n, o) => n + o.opsExecuted, 0),
          held: outcomes.filter(o => o.outcome === 'HELD').length,
          broken: outcomes.filter(o => o.outcome === 'BROKEN').length,
          brokenOnlyOpenFindings: brokenOnlyOpen.length,
          brokenOtherInvariants: brokenOther.length,
          violationsPerInvariant: perInvariant,
          maxOpMs: Math.max(0, ...outcomes.map(o => o.maxOpMs)),
          wallMs: Date.now() - wallStart,
        },
        results: outcomes.map(o => ({
          seed: o.seed,
          length: o.length,
          outcome: o.outcome,
          invariants: [...new Set(o.violations.map(v => v.invariant))],
          firstViolation: o.violations[0]
            ? `step ${o.violations[0].step} ${o.violations[0].invariant}: ${o.violations[0].detail}`
            : null,
          opsExecuted: o.opsExecuted,
          maxOpMs: o.maxOpMs,
          durationMs: o.durationMs,
          traceDigest: o.traceDigest,
        })),
        minimized,
        flakeReruns,
        determinism,
      };

      if (OUT_PATH) {
        fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
        fs.writeFileSync(OUT_PATH, JSON.stringify(table, null, 2));
      }

      expect(outcomes).toHaveLength(ITERATIONS);
      expect(determinism.every(d => d.identical)).toBe(true);
      expect(
        brokenOther.map(o => ({
          seed: o.seed,
          violations: o.violations.map(
            v => `step ${v.step} ${v.invariant}: ${v.detail}`,
          ),
        })),
      ).toEqual([]);
      // Open findings must reproduce deterministically, never flake.
      for (const f of flakeReruns)
        expect(f).toMatchObject({ reproduced: FLAKE_RERUNS });
    },
    Math.max(60_000, ITERATIONS * 150),
  );

  it('determinism: the same seed replays to an identical trace and identical violations', async () => {
    for (let i = 0; i < 10; i++) {
      const seed = sequenceSeed(BASE_SEED ^ 0x5eed, i);
      const first = await runSequence(
        vaultApi,
        mockKeychain,
        genSequence(seed),
      );
      const second = await runSequence(
        vaultApi,
        mockKeychain,
        genSequence(seed),
      );
      expect(second.traceDigest).toBe(first.traceDigest);
      expect(second.violations).toEqual(first.violations);
      expect(genSequence(seed)).toEqual(genSequence(seed));
    }
  });

  it('sensitivity: the harness catches a vault that stops discarding malformed items, and one that leaks keys', async () => {
    const spec = genSession(new Rng(7));
    const sequence: Sequence = {
      seed: 7,
      actions: [
        { kind: 'save', session: spec },
        { kind: 'load' },
        {
          kind: 'corrupt',
          corruption: 'truncated',
          session: spec,
          cut: 0.5,
        },
        { kind: 'load' },
        { kind: 'save', session: spec },
        { kind: 'clear' },
        { kind: 'load' },
      ],
    };
    const clean = await runSequence(vaultApi, mockKeychain, sequence, {
      invariants: ['I1', 'I2', 'I3', 'I4', 'I5', 'I8', 'I9'],
    });
    expect(clean.violations).toEqual([]);

    const noDiscard: VaultApi = {
      ...vaultApi,
      clearPersistedSession: async () => undefined,
    };
    const caught = await runSequence(noDiscard, mockKeychain, sequence, {
      invariants: ['I3'],
    });
    expect(caught.violations.length).toBeGreaterThan(0);

    const leaky: VaultApi = {
      ...vaultApi,
      loadPersistedSession: async () => {
        const record = await vault.loadPersistedSession();
        return record
          ? ({ ...record, accessToken: 'leak' } as unknown as typeof record)
          : record;
      },
    };
    const leakCaught = await runSequence(leaky, mockKeychain, sequence, {
      invariants: ['I2'],
    });
    expect(leakCaught.violations.length).toBeGreaterThan(0);
  });
});

describe('sessionVault — corruption corpus (construction-derived expectations)', () => {
  it.each(CORRUPTION_KINDS)(
    'load handles Keychain content "%s" exactly as the contract says',
    async corruption => {
      const spec = genSession(
        new Rng(CORRUPTION_KINDS.indexOf(corruption) + 1),
      );
      const content = corruptionContent(corruption, spec, 0.37);
      mockKeychain.store.set(SESSION_VAULT_SERVICE, {
        username: content.username,
        password: content.password,
      });
      const loaded = await vault.loadPersistedSession();
      expect(loaded).toEqual(content.expected);
      if (content.expected === null) {
        expect(mockKeychain.store.has(SESSION_VAULT_SERVICE)).toBe(false);
      } else {
        expect(mockKeychain.store.get(SESSION_VAULT_SERVICE)?.password).toBe(
          content.password,
        );
        expect(Object.keys(loaded ?? {}).sort()).toEqual([
          'canonicalAppUserId',
          'displayName',
          'email',
          'provider',
          'refreshToken',
          'version',
        ]);
      }
      expect('polluted' in {}).toBe(false);
    },
  );

  it('oversized records (64 KiB … 4 MiB refresh tokens) round-trip without exceeding the per-op time budget', async () => {
    for (const refreshTokenLength of [
      64 * 1024,
      1024 * 1024,
      4 * 1024 * 1024,
    ]) {
      const record = materialize({
        provider: 'apple',
        canonicalAppUserId: 'user-oversized',
        refreshToken: 'rt-oversized',
        refreshTokenLength,
        email: null,
        displayName: null,
      });
      const t0 = Date.now();
      expect(await vault.savePersistedSession(record)).toBe(true);
      const loaded = await vault.loadPersistedSession();
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(loaded?.refreshToken.length).toBe(refreshTokenLength);
      expect(loaded).toEqual(record);
      await vault.clearPersistedSession();
      expect(mockKeychain.store.size).toBe(0);
    }
  });
});

describe('sessionVault — native module missing at require time', () => {
  it('a build without react-native-keychain fails soft: save false, load null, clear resolves', async () => {
    const loaded: Array<typeof vault> = [];
    jest.isolateModules(() => {
      jest.doMock('react-native-keychain', () => {
        throw new Error("Cannot find module 'react-native-keychain'");
      });
      loaded.push(
        jest.requireActual<typeof vault>('../../src/account/sessionVault'),
      );
    });
    jest.dontMock('react-native-keychain');
    const isolated = loaded[0];
    if (!isolated) throw new Error('isolated sessionVault did not load');
    await expect(
      isolated.savePersistedSession(
        materialize({
          provider: 'google',
          canonicalAppUserId: 'user-no-module',
          refreshToken: 'rt-no-module',
          email: null,
          displayName: null,
        }),
      ),
    ).resolves.toBe(false);
    await expect(isolated.loadPersistedSession()).resolves.toBeNull();
    await expect(isolated.clearPersistedSession()).resolves.toBeUndefined();
    expect(mockKeychain.calls).toEqual([]);
  });
});

describe('sessionVault — open findings pinned (it.failing flips when fixed)', () => {
  it.failing(
    'F1 (I6): a non-contract field on the record must not reach the Keychain',
    async () => {
      const wide = {
        ...materialize({
          provider: 'apple',
          canonicalAppUserId: 'user-f1',
          refreshToken: 'rt-f1',
          email: null,
          displayName: null,
        }),
        accessToken: 'SMUGGLED-accessToken-VALUE',
      };
      expect(
        await vault.savePersistedSession(
          wide as unknown as Parameters<typeof vault.savePersistedSession>[0],
        ),
      ).toBe(true);
      const stored = mockKeychain.store.get(SESSION_VAULT_SERVICE)?.password;
      expect(typeof stored).toBe('string');
      expect(stored as string).not.toContain('SMUGGLED-');
    },
  );

  it.failing(
    'F2 (I7): a save racing a load of a malformed item must not be wiped by the load\u2019s discard',
    async () => {
      mockKeychain.store.set(SESSION_VAULT_SERVICE, {
        username: 'session',
        password: '{not json',
      });
      const fresh = materialize({
        provider: 'google',
        canonicalAppUserId: 'user-f2',
        refreshToken: 'rt-f2',
        email: null,
        displayName: null,
      });
      const [loaded, saved] = await Promise.all([
        vault.loadPersistedSession(),
        vault.savePersistedSession(fresh),
      ]);
      expect(loaded).toBeNull();
      expect(saved).toBe(true);
      // A save that resolved true must be durable.
      expect(mockKeychain.store.get(SESSION_VAULT_SERVICE)?.password).toBe(
        JSON.stringify(fresh),
      );
    },
  );
});
