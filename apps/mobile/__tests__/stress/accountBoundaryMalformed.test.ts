/**
 * STRESS — boundary/malformed inputs against the account module
 * (deletion + consentApi + onboarding). Harness:
 * `__harness__/accountBoundaryMalformed/`.
 *
 *   npx jest --ci accountBoundaryMalformed                 # default 300 seeds
 *   STRESS_ITER=3200 npx jest --ci accountBoundaryMalformed # full campaign
 *   STRESS_SEED=1234 npx jest --ci accountBoundaryMalformed # replay one seed
 *
 * The JSON table (seed → outcome) lands in
 * `apps/mobile/artifacts/stress/account-boundary-malformed/` (git-ignored;
 * override with STRESS_OUT).
 */
import { CHECKPOINTS } from '@pickle/shared-types';
import {
  AccountDeletionError,
  requestAccountDeletion,
} from '../../src/account/deletion';
import {
  OnboardingSyncError,
  fetchCanonicalOnboardingProfile,
  saveCanonicalOnboardingProfile,
} from '../../src/account/onboarding';
import type { Profile } from '../../src/state/profile';
import {
  STRESS_SESSION,
  isKnownBroken,
  readIterations,
  readReplaySeed,
  readSeedBase,
  runCampaign,
  runSeed,
  writeCampaign,
} from '../../__harness__/accountBoundaryMalformed/runner';

const DEFAULT_ITERATIONS = 300;
const DEFAULT_SEED_BASE = 1;
const CAMPAIGN_TIMEOUT_MS = 20 * 60 * 1000;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('stress: account module boundary/malformed inputs', () => {
  const replaySeed = readReplaySeed();

  test(
    replaySeed === null
      ? 'every seed either resolves to a shape-valid result or rejects with the typed error'
      : `replay seed ${replaySeed}`,
    async () => {
      const seedBase = readSeedBase(DEFAULT_SEED_BASE);
      const iterations =
        replaySeed === null ? readIterations(DEFAULT_ITERATIONS) : 1;
      const summary = await runCampaign(replaySeed ?? seedBase, iterations);
      const file = writeCampaign(
        summary,
        replaySeed === null
          ? `campaign-${seedBase}-${iterations}`
          : `replay-${replaySeed}`,
      );
      const unexpected = summary.rows.filter(
        r => r.outcome === 'BROKEN' && !isKnownBroken(r),
      );
      const known = summary.rows.filter(
        r => r.outcome === 'BROKEN' && isKnownBroken(r),
      );
      console.log(
        `[stress] executed=${summary.executed} held=${summary.held} broken=${summary.broken} ` +
          `(known-class=${known.length}, unexpected=${unexpected.length}) table=${file}`,
      );
      if (replaySeed !== null) {
        console.log(JSON.stringify(summary.rows[0], null, 2));
      }
      expect(summary.executed).toBe(iterations);
      expect(
        unexpected.map(r => ({
          seed: r.seed,
          target: r.target,
          violations: r.violations,
        })),
      ).toEqual([]);
    },
    CAMPAIGN_TIMEOUT_MS,
  );

  test('a seed replays to an identical row (deterministic generation + outcome)', async () => {
    const seeds = [7, 4242, 99_991];
    for (const seed of seeds) {
      const first = await runSeed(seed);
      const second = await runSeed(seed);
      expect(second).toEqual(first);
    }
  });

  test('seeds fan out across every target and both transports', async () => {
    const targets = new Set<string>();
    const transports = new Set<string>();
    for (let seed = 1; seed <= 120; seed += 1) {
      const row = await runSeed(seed);
      targets.add(row.target);
      transports.add(row.transport.split(':')[0] as string);
    }
    expect(targets.size).toBe(9);
    expect([...transports].sort()).toEqual(['reject', 'response']);
  });
});

/**
 * Known-broken classes pinned with `test.failing`: these PASS while the bug
 * exists and FAIL once it is fixed — remove the entry from
 * `KNOWN_BROKEN_CLASSES` and flip the test to `test(...)` at that point.
 */
describe('stress: pinned boundary failures (test.failing = currently broken)', () => {
  test.failing(
    'onboarding.fetch: a prototype-key primary_goal must not become a non-checkpoint focus',
    async () => {
      // Minimised from campaign seeds hitting
      // `onboarding.fetch:ok-shape:focusCheckpoint-not-checkpoint`.
      const profile = await fetchCanonicalOnboardingProfile(
        STRESS_SESSION,
        async () =>
          jsonResponse(200, {
            onboardingState: 'complete',
            profile: {
              skill_level: 'intermediate',
              handedness: 'right',
              primary_goal: '__proto__',
              biggest_problem: 'pop_ups',
            },
          }),
      );
      expect(profile).not.toBeNull();
      expect(CHECKPOINTS as readonly string[]).toContain(
        profile?.focusCheckpoint,
      );
    },
  );

  test('onboarding.fetch: the `__proto__` focus survives the appStore JSON round-trip as `{}`', async () => {
    // Documents the downstream shape (appStore persists JSON.stringify(profile)
    // and re-parses it); HomeScreen calls `.replace` on focusCheckpoint.
    const profile = await fetchCanonicalOnboardingProfile(
      STRESS_SESSION,
      async () =>
        jsonResponse(200, {
          onboardingState: 'complete',
          profile: {
            skill_level: 'intermediate',
            handedness: 'right',
            primary_goal: '__proto__',
            biggest_problem: 'pop_ups',
          },
        }),
    );
    expect(profile?.focusCheckpoint).toBe(Object.prototype);
    const persisted = JSON.parse(JSON.stringify(profile)) as {
      focusCheckpoint: unknown;
    };
    expect(persisted.focusCheckpoint).toEqual({});
    expect(
      typeof (persisted.focusCheckpoint as { replace?: unknown }).replace,
    ).toBe('undefined');
  });

  test.failing(
    'deletion.request: an empty server error.message must not become an empty typed error',
    async () => {
      // Minimised from campaign seed 2795 (`deletion.request:typed-error:empty-message`).
      let message: string | null = null;
      try {
        await requestAccountDeletion(STRESS_SESSION, null, async () =>
          jsonResponse(409, { error: { code: 'conflict', message: '' } }),
        );
      } catch (error) {
        if (error instanceof AccountDeletionError) message = error.message;
      }
      expect(message).not.toBeNull();
      expect(message?.trim()).not.toBe('');
    },
  );

  test.failing(
    'onboarding.save: a whitespace-only server error.message must not become a blank typed error',
    async () => {
      let message: string | null = null;
      try {
        await saveCanonicalOnboardingProfile(
          STRESS_SESSION,
          {
            skillLevel: 'intermediate',
            handedness: 'right',
            goal: 'dinks',
            biggestProblem: 'pop_ups',
            focusCheckpoint: 'contact_position',
          },
          async () =>
            jsonResponse(400, {
              error: { code: 'bad_request', message: ' \t ' },
            }),
        );
      } catch (error) {
        if (error instanceof OnboardingSyncError) message = error.message;
      }
      expect(message).not.toBeNull();
      expect(message?.trim()).not.toBe('');
    },
  );

  test.failing(
    'onboarding.save: a non-string firstName must reject with OnboardingSyncError, not TypeError',
    async () => {
      // Minimised from campaign seeds hitting `onboarding.save:untyped-throw:TypeError`.
      const profile = {
        firstName: 42,
        skillLevel: 'intermediate',
        handedness: 'right',
        goal: 'dinks',
        biggestProblem: 'pop_ups',
        focusCheckpoint: 'contact_position',
      } as unknown as Profile;
      let outcome: 'ok' | 'typed' | 'untyped' = 'ok';
      try {
        await saveCanonicalOnboardingProfile(
          STRESS_SESSION,
          profile,
          async () =>
            jsonResponse(200, { recommendedCheckpoint: 'contact_position' }),
        );
      } catch (error) {
        outcome = error instanceof OnboardingSyncError ? 'typed' : 'untyped';
      }
      expect(outcome).not.toBe('untyped');
    },
  );
});
