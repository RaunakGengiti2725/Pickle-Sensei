import {
  stageAfterGetStarted,
  stageAfterOnboarding,
  stageWhenLeavingOnboarding,
} from '../src/flow/launchGate';

/**
 * Launch-order contract: onboarding comes BEFORE the login flow and cannot
 * be skipped. "Start your first read" ALWAYS flows Welcome → questionnaire →
 * sign-in, on every device — it never consults device history, so a phone
 * that once held an account (or already answered the questionnaire) gets the
 * same path as a fresh one. Leaving the questionnaire from step one only goes
 * back to Welcome; the sole way to reach sign-in through it is finishing it.
 * Returning users reach sign-in through the explicit "I already have an
 * account" link instead.
 */

describe('launch gate ordering', () => {
  it('sends the primary CTA into onboarding before any sign-in', () => {
    expect(stageAfterGetStarted()).toBe('onboarding');
  });

  it('takes no device-history input — the route cannot silently skip to sign-in', () => {
    expect(stageAfterGetStarted.length).toBe(0);
  });

  it('hands off to sign-in only after onboarding is finished', () => {
    expect(stageAfterOnboarding()).toBe('signin');
  });

  it('leaving step one returns to Welcome — never to sign-in, so setup cannot be skipped', () => {
    expect(stageWhenLeavingOnboarding()).toBe('welcome');
    expect(stageWhenLeavingOnboarding()).not.toBe(stageAfterOnboarding());
  });
});
