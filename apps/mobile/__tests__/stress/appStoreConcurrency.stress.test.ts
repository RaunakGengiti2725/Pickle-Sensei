/**
 * STRESS / concurrency — `src/state/appStore.ts` (+ `src/state/profile.ts`).
 *
 * Seeded, replayable interleavings of hydrate / account switch /
 * completeOnboarding / completePreAuthOnboarding / bearer rotation against a
 * scheduler-controlled kv store and canonical profile server with optional
 * fault injection. See `xc-harness/stress/appStoreConcurrencyModel.ts` for
 * the scenario grammar and the invariant list.
 *
 *   STRESS_ITER=<n>        campaign iterations (default 60)
 *   STRESS_SEED_BASE=<n>   first seed (default 1)
 *   STRESS_FAULT_RATES=a,b restrict fault rates (e.g. "0" for fault-free)
 *   STRESS_ARTIFACT_DIR    where the seed → outcome JSON table is written
 *
 * Replay one seed:
 *   STRESS_ITER=1 STRESS_SEED_BASE=<seed> npx jest --ci appStoreConcurrency
 *
 * Invariants that HOLD are asserted for every seed. Invariants confirmed
 * BROKEN at 1fb0efd7 are listed in KNOWN_BROKEN, counted in the artifact, and
 * pinned below as `test.failing` replays of a minimal program + seed; a fix
 * flips those to green (jest then reports them as unexpectedly passing, the
 * cue to promote them to plain tests and drop the KNOWN_BROKEN entry).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { LocalDb } from '../../src/data/db';
import type { ApiSession } from '../../src/account/apiSession';
import type { Profile } from '../../src/state/profile';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearApiSession } from '../../src/account/apiSession';
import { PENDING_ONBOARDING_PROFILE_KV_KEY } from '../../src/state/appStore';
import {
  OWNER_A,
  OWNER_B,
  generateScenario,
  makeProfile,
  markerOf,
  profileKey,
  runScenario,
  type Scenario,
  type ScenarioResult,
  type Seams,
} from '../../xc-harness/stress/appStoreConcurrencyModel';

const seams: Seams = { db: { current: null }, server: { current: null } };

jest.mock('../../src/data/db', () => ({
  getDb: (): LocalDb => {
    const db = seams.db.current;
    if (!db) throw new Error('scenario db not installed');
    return db.handle();
  },
}));

jest.mock('../../src/account/onboarding', () => ({
  fetchCanonicalOnboardingProfile: (session: ApiSession) => {
    const server = seams.server.current;
    if (!server) throw new Error('scenario server not installed');
    return server.fetch(session);
  },
  saveCanonicalOnboardingProfile: (session: ApiSession, profile: Profile) => {
    const server = seams.server.current;
    if (!server) throw new Error('scenario server not installed');
    return server.save(session, profile);
  },
}));

const ITER = Math.max(1, Number(process.env['STRESS_ITER'] ?? 60));
const SEED_BASE = Number(process.env['STRESS_SEED_BASE'] ?? 1);
const FAULT_RATES = process.env['STRESS_FAULT_RATES']
  ? process.env['STRESS_FAULT_RATES'].split(',').map(Number)
  : undefined;
const ARTIFACT_DIR =
  process.env['STRESS_ARTIFACT_DIR'] ??
  path.join(__dirname, '..', '..', 'artifacts', 'stress');

/** Invariants confirmed BROKEN at 1fb0efd7 — each pinned by a replay below. */
const KNOWN_BROKEN: ReadonlySet<string> = new Set<string>([
  'laterIntentWins',
  'stashSavedOncePerOwner',
  'stashAdoptedByAtMostOneOwner',
  'stashNotLost',
  'durableIntentKept',
  'noNullMemoryWhileProfileStored',
  'memoryProfileIsDurable',
  'newestCleanHydrateWins',
  'deviceMatchesServerAfterWrite',
  'busyCleared',
]);

const stash = (marker: string): string =>
  JSON.stringify({ version: 1, profile: makeProfile(marker) });
const stored = (marker: string): string => JSON.stringify(makeProfile(marker));

interface TableRow {
  seed: number;
  ok: boolean;
  failed: string[];
  steps: number;
  faults: number;
  actions: string;
  initialOwner: string;
  durationMs: number;
}

function describeActions(scenario: Scenario): string {
  return scenario.actions
    .map(a => {
      switch (a.kind) {
        case 'switchOwner':
          return `switch(${a.owner.slice(0, 6)})`;
        case 'completeOnboarding':
          return `complete(${a.marker})`;
        case 'completePreAuthOnboarding':
          return `preAuth(${a.marker})`;
        default:
          return a.kind;
      }
    })
    .join(' > ');
}

function unexpectedFailures(result: ScenarioResult): string[] {
  return result.failed.filter(name => !KNOWN_BROKEN.has(name));
}

afterEach(() => {
  seams.db.current = null;
  seams.server.current = null;
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('appStore concurrency stress (seeded interleavings)', () => {
  it(
    `holds every non-KNOWN_BROKEN invariant across ${ITER} seeded interleavings (seeds ${SEED_BASE}..${SEED_BASE + ITER - 1})`,
    async () => {
      const table: TableRow[] = [];
      const failures: ScenarioResult[] = [];
      const brokenOnly: ScenarioResult[] = [];
      const invariantFailCounts: Record<string, number> = {};
      let totalOps = 0;
      const started = Date.now();
      for (let i = 0; i < ITER; i += 1) {
        const seed = SEED_BASE + i;
        const scenario = generateScenario(seed, { faultRates: FAULT_RATES });
        const result = await runScenario(scenario, seams);
        totalOps += result.ops.length;
        for (const name of result.failed) {
          invariantFailCounts[name] = (invariantFailCounts[name] ?? 0) + 1;
        }
        table.push({
          seed,
          ok: result.ok,
          failed: result.failed,
          steps: result.steps,
          faults: result.faultsInjected,
          actions: describeActions(scenario),
          initialOwner: scenario.initialOwner,
          durationMs: result.durationMs,
        });
        if (!result.ok) {
          (unexpectedFailures(result).length > 0 ? failures : brokenOnly).push(
            result,
          );
        }
      }
      fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
      const summary = {
        iterations: ITER,
        seedBase: SEED_BASE,
        faultRates: FAULT_RATES ?? 'default [0, 0, 0.05, 0.2]',
        totalLaunchedCalls: totalOps,
        wallMs: Date.now() - started,
        invariantFailCounts,
        knownBroken: [...KNOWN_BROKEN],
        unexpectedFailingSeeds: failures.map(r => r.seed),
        knownBrokenSeeds: brokenOnly.map(r => r.seed),
        table,
      };
      fs.writeFileSync(
        path.join(
          ARTIFACT_DIR,
          `appStore-concurrency-${SEED_BASE}-${ITER}.json`,
        ),
        JSON.stringify(summary, null, 2),
      );
      for (const r of [...failures, ...brokenOnly].slice(0, 200)) {
        fs.writeFileSync(
          path.join(ARTIFACT_DIR, `appStore-concurrency-seed-${r.seed}.json`),
          JSON.stringify(r, null, 2),
        );
      }
      const digest = failures
        .slice(0, 10)
        .map(
          r =>
            `seed ${r.seed}: ${unexpectedFailures(r).join(',')} | ${describeActions(r.scenario)} | final=${JSON.stringify(r.finalState)}`,
        )
        .join('\n');
      expect(digest).toBe('');
      expect(failures).toHaveLength(0);
    },
    Math.max(30_000, ITER * 200),
  );
});

describe('appStore concurrency — HELD under seeded bursts', () => {
  it('duplicate hydrate burst (x8) with a stored profile converges on it without touching the server', async () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const result = await runScenario(
        {
          seed,
          faultRate: 0,
          initialOwner: OWNER_A,
          initialKv: { [profileKey(OWNER_A)]: stored('K1') },
          initialServer: { [OWNER_A]: stored('C1') },
          actions: Array.from({ length: 8 }, () => ({
            kind: 'hydrate' as const,
          })),
        },
        seams,
      );
      expect({ seed, failed: result.failed }).toEqual({ seed, failed: [] });
      expect(result.finalState).toMatchObject({
        hydrated: true,
        ownerKey: OWNER_A,
        profileMarker: 'K1',
        hydrateError: null,
      });
      expect(seams.server.current?.fetchCalls ?? 0).toBe(0);
      expect(result.serverSaves).toEqual([]);
    }
  });

  it('completeOnboarding racing an account switch never leaks a profile into the other owner', async () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const result = await runScenario(
        {
          seed,
          faultRate: 0,
          initialOwner: OWNER_A,
          initialKv: {},
          initialServer: {},
          actions: [
            { kind: 'hydrate' },
            { kind: 'completeOnboarding', marker: 'P1' },
            { kind: 'switchOwner', owner: OWNER_B },
            { kind: 'completeOnboarding', marker: 'P2' },
          ],
        },
        seams,
      );
      expect({ seed, failed: result.failed }).toEqual({ seed, failed: [] });
      expect(markerOf(result.finalKv[profileKey(OWNER_B)])).not.toBe('P1');
      expect(markerOf(result.finalKv[profileKey(OWNER_A)])).not.toBe('P2');
      expect(result.finalState.ownerKey).toBe(OWNER_B);
      expect(
        result.serverSaves.every(s =>
          s.bearer.startsWith(`tok-${s.owner[0]}-`),
        ),
      ).toBe(true);
    }
  });

  it('sign-out during completeOnboarding leaves the signed-out store empty and the write owner-scoped', async () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const result = await runScenario(
        {
          seed,
          faultRate: 0,
          initialOwner: OWNER_A,
          initialKv: {},
          initialServer: {},
          actions: [
            { kind: 'hydrate' },
            { kind: 'completeOnboarding', marker: 'P1' },
            { kind: 'switchOwner', owner: SIGNED_OUT_DATA_OWNER },
          ],
        },
        seams,
      );
      expect({ seed, failed: result.failed }).toEqual({ seed, failed: [] });
      expect(result.finalState).toMatchObject({
        hydrated: true,
        ownerKey: SIGNED_OUT_DATA_OWNER,
        profileMarker: null,
        onboardingBusy: false,
      });
      expect(result.finalKv[profileKey(SIGNED_OUT_DATA_OWNER)]).toBeUndefined();
    }
  });

  it('a signed-out hydrate never adopts, clears, or writes the pre-auth stash', async () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const result = await runScenario(
        {
          seed,
          faultRate: 0,
          initialOwner: SIGNED_OUT_DATA_OWNER,
          initialKv: { [PENDING_ONBOARDING_PROFILE_KV_KEY]: stash('S0') },
          initialServer: {},
          actions: [
            { kind: 'hydrate' },
            { kind: 'hydrate' },
            { kind: 'completePreAuthOnboarding', marker: 'S1' },
            { kind: 'hydrate' },
          ],
        },
        seams,
      );
      expect({ seed, failed: result.failed }).toEqual({ seed, failed: [] });
      expect(markerOf(result.finalKv[PENDING_ONBOARDING_PROFILE_KV_KEY])).toBe(
        'S1',
      );
      expect(result.kvWrites.filter(w => w.key.startsWith('profile:'))).toEqual(
        [],
      );
      expect(result.finalState.profileMarker).toBeNull();
    }
  });
});

describe('appStore concurrency — BROKEN at 1fb0efd7 (pinned replays)', () => {
  // P2. Sequential, no concurrency needed: adoption fails once (server 5xx),
  // the stash is kept for retry, the user completes onboarding in-account,
  // and the NEXT hydrate adopts the older stash over the newer answers on
  // both the server and the device. completeOnboarding never clears the
  // stash; adoption never compares intent recency.
  test.failing(
    'a stash whose adoption failed is not resurrected over a newer in-account completion',
    async () => {
      const result = await runScenario(
        {
          seed: 1,
          faultRate: 0,
          sequential: true,
          scriptedFaults: { 'save#1': 'saveThrows' },
          initialOwner: SIGNED_OUT_DATA_OWNER,
          initialKv: {},
          initialServer: {},
          actions: [
            { kind: 'hydrate' },
            { kind: 'completePreAuthOnboarding', marker: 'S1' },
            { kind: 'switchOwner', owner: OWNER_A },
            { kind: 'completeOnboarding', marker: 'P2' },
            { kind: 'hydrate' },
          ],
        },
        seams,
      );
      expect(markerOf(result.finalServer[OWNER_A])).toBe('P2');
      expect(markerOf(result.finalKv[profileKey(OWNER_A)])).toBe('P2');
      expect(result.finalState.profileMarker).toBe('P2');
    },
  );

  // P3. Two hydrates for the same canonical owner both read the stash and
  // both PUT it to the server (adoption is read → save → write → clear with
  // no in-flight guard).
  test.failing(
    'duplicate hydrate adopts the stash with exactly one canonical save',
    async () => {
      const result = await runScenario(
        {
          seed: 1,
          faultRate: 0,
          initialOwner: OWNER_A,
          initialKv: { [PENDING_ONBOARDING_PROFILE_KV_KEY]: stash('S0') },
          initialServer: {},
          actions: [{ kind: 'hydrate' }, { kind: 'hydrate' }],
        },
        seams,
      );
      expect(result.serverSaves.map(s => s.marker)).toEqual(['S0']);
    },
  );

  // P3. Sign-in lands between the guest adoption's profile write and its
  // stash clear: the same pre-auth answers are adopted by BOTH owners.
  test.failing(
    'an account switch mid-adoption does not adopt the same stash into two owners',
    async () => {
      const result = await runScenario(
        {
          seed: 1,
          faultRate: 0,
          initialOwner: GUEST_DATA_OWNER,
          initialKv: { [PENDING_ONBOARDING_PROFILE_KV_KEY]: stash('S0') },
          initialServer: {},
          actions: [
            { kind: 'hydrate' },
            { kind: 'switchOwner', owner: OWNER_A },
          ],
        },
        seams,
      );
      const holders = Object.entries(result.finalKv)
        .filter(([k, v]) => k.startsWith('profile:') && markerOf(v) === 'S0')
        .map(([k]) => k);
      expect(holders).toHaveLength(1);
    },
  );

  // P3. A stash written while an adoption is in flight is erased by the
  // adoption's unconditional clear — newer answers silently lost.
  test.failing(
    'a stash written during adoption survives the adoption clear',
    async () => {
      const result = await runScenario(
        {
          seed: 1,
          faultRate: 0,
          initialOwner: GUEST_DATA_OWNER,
          initialKv: { [PENDING_ONBOARDING_PROFILE_KV_KEY]: stash('S0') },
          initialServer: {},
          actions: [
            { kind: 'hydrate' },
            { kind: 'completePreAuthOnboarding', marker: 'S1' },
          ],
        },
        seams,
      );
      const pending = markerOf(
        result.finalKv[PENDING_ONBOARDING_PROFILE_KV_KEY],
      );
      const adopted = markerOf(result.finalKv[profileKey(GUEST_DATA_OWNER)]);
      expect(pending === 'S1' || adopted === 'S1').toBe(true);
    },
  );

  // P3. A stale hydrate's canonical cache fill lands after a newer hydrate
  // adopted the stash: device keeps the OLD server profile, server has the
  // new answers, stash is gone — never reconciled because a local profile
  // now exists.
  test.failing(
    'a stale canonical cache fill does not overwrite an adopted stash',
    async () => {
      const result = await runScenario(
        {
          seed: 48,
          faultRate: 0,
          initialOwner: OWNER_A,
          initialKv: {},
          initialServer: { [OWNER_A]: stored('C1') },
          actions: [
            { kind: 'hydrate' },
            { kind: 'completePreAuthOnboarding', marker: 'S1' },
            { kind: 'hydrate' },
          ],
        },
        seams,
      );
      expect(markerOf(result.finalKv[profileKey(OWNER_A)])).toBe(
        markerOf(result.finalServer[OWNER_A]),
      );
    },
  );

  // P3. hydrate() only guards its final set() by OWNER, not by generation: a
  // guest hydrate that read "no profile" before a concurrent
  // completeOnboarding wrote one publishes profile=null over it (UI shows
  // onboarding again although the profile is stored).
  test.failing(
    'a stale hydrate does not publish profile=null over a concurrent completeOnboarding',
    async () => {
      const result = await runScenario(
        {
          seed: 4,
          faultRate: 0,
          initialOwner: GUEST_DATA_OWNER,
          initialKv: {},
          initialServer: {},
          actions: [
            { kind: 'hydrate' },
            { kind: 'completeOnboarding', marker: 'P1' },
          ],
        },
        seams,
      );
      expect(markerOf(result.finalKv[profileKey(GUEST_DATA_OWNER)])).toBe('P1');
      expect(result.finalState.profileMarker).toBe('P1');
    },
  );

  // P3. The legacy `profile` → `profile:device-guest` migration is a blind
  // read-then-write; a completeOnboarding landing in between is overwritten
  // by the legacy copy.
  test.failing(
    'legacy profile migration does not overwrite a concurrent completeOnboarding',
    async () => {
      const result = await runScenario(
        {
          seed: 3,
          faultRate: 0,
          initialOwner: GUEST_DATA_OWNER,
          initialKv: { profile: stored('L') },
          initialServer: {},
          actions: [
            { kind: 'hydrate' },
            { kind: 'completeOnboarding', marker: 'P1' },
          ],
        },
        seams,
      );
      expect(markerOf(result.finalKv[profileKey(GUEST_DATA_OWNER)])).toBe('P1');
    },
  );

  // P3 (fault path). Adoption assigns `raw` before the durable write; when
  // that write fails the store publishes the adopted profile while kv still
  // holds the previous one.
  test.failing(
    'a failed adoption write does not publish the unpersisted profile',
    async () => {
      const result = await runScenario(
        {
          seed: 1,
          faultRate: 0,
          sequential: true,
          scriptedFaults: { 'kvSet#1': 'kvSetThrows' },
          initialOwner: OWNER_A,
          initialKv: {
            [PENDING_ONBOARDING_PROFILE_KV_KEY]: stash('S0'),
            [profileKey(OWNER_A)]: stored('K1'),
          },
          initialServer: {},
          actions: [{ kind: 'hydrate' }],
        },
        seams,
      );
      expect(result.finalState.profileMarker).toBe(
        markerOf(result.finalKv[profileKey(OWNER_A)]),
      );
    },
  );

  // P3 (fault path). An older duplicate hydrate whose read fails settles
  // after the newer clean one and repaints hydrateError over a loaded
  // profile.
  test.failing(
    'a stale faulted hydrate does not repaint an error over a newer clean hydrate',
    async () => {
      const result = await runScenario(
        {
          seed: 2,
          faultRate: 0,
          scriptedFaults: { 'kvGet#4': 'kvGetThrows' },
          initialOwner: OWNER_A,
          initialKv: { [profileKey(OWNER_A)]: stored('K1') },
          initialServer: {},
          actions: [{ kind: 'hydrate' }, { kind: 'hydrate' }],
        },
        seams,
      );
      expect(result.finalState).toMatchObject({
        profileMarker: 'K1',
        hydrateError: null,
      });
    },
  );

  // P3 (fault path). completeOnboarding skips its final set() when the owner
  // changed mid-call and relies on the next hydrate()'s success path to clear
  // onboardingBusy; hydrate()'s error path never does, so a sign-out during
  // the save followed by a failed signed-out read leaves onboardingBusy=true
  // (pre-auth onboarding's Finish buttons stay disabled at "Finishing
  // setup…").
  test.failing(
    'onboardingBusy is cleared when the owner changes mid-save and the next hydrate fails',
    async () => {
      const result = await runScenario(
        {
          seed: 1,
          faultRate: 0,
          scriptedFaults: { 'kvGet#3': 'kvGetThrows' },
          initialOwner: OWNER_A,
          initialKv: {},
          initialServer: {},
          actions: [
            { kind: 'hydrate' },
            { kind: 'completeOnboarding', marker: 'P1' },
            { kind: 'switchOwner', owner: SIGNED_OUT_DATA_OWNER },
          ],
        },
        seams,
      );
      expect(result.finalState).toMatchObject({
        ownerKey: SIGNED_OUT_DATA_OWNER,
        onboardingBusy: false,
      });
    },
  );

  // P3. Two overlapping completeOnboarding calls (the store has no in-flight
  // guard; the screen's busy flag is React state) can land in different
  // orders on the server and the device.
  test.failing(
    'overlapping completeOnboarding calls leave device and server agreeing',
    async () => {
      const result = await runScenario(
        {
          seed: 2,
          faultRate: 0,
          initialOwner: OWNER_A,
          initialKv: {},
          initialServer: {},
          actions: [
            { kind: 'hydrate' },
            { kind: 'completeOnboarding', marker: 'P1' },
            { kind: 'rotateBearer' },
            { kind: 'completeOnboarding', marker: 'P2' },
          ],
        },
        seams,
      );
      expect(markerOf(result.finalKv[profileKey(OWNER_A)])).toBe(
        markerOf(result.finalServer[OWNER_A]),
      );
    },
  );
});
