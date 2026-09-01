import {
  stageAfterGetStarted,
  stageAfterOnboarding,
} from '../src/flow/launchGate';

/**
 * Launch-order contract: onboarding comes BEFORE the login flow. A fresh
 * device flows Welcome → questionnaire → sign-in; a device that already
 * finished setup (or ever hydrated a profile) skips straight to sign-in and
 * is never re-quizzed before it can log in.
 */

describe('launch gate ordering', () => {
  it('sends fresh devices into onboarding before any sign-in', () => {
    expect(stageAfterGetStarted(false)).toBe('onboarding');
  });

  it('sends already-onboarded devices straight to sign-in', () => {
    expect(stageAfterGetStarted(true)).toBe('signin');
  });

  it('hands off to sign-in after onboarding — completion and skip alike', () => {
    expect(stageAfterOnboarding()).toBe('signin');
  });
});
