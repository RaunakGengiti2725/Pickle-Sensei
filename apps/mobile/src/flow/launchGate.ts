/**
 * Pre-auth launch order: Welcome → onboarding questionnaire → sign-in.
 *
 * Onboarding deliberately runs BEFORE the login flow: a fresh device answers
 * the setup questions first and only then connects an account (the answers
 * wait in the appStore pre-auth stash until an owner adopts them). Devices
 * that already finished the questionnaire — or ever hydrated a profile — skip
 * straight from Welcome to sign-in, so returning users are never re-quizzed
 * before they can log in.
 */

export type PreAuthStage = 'welcome' | 'onboarding' | 'signin';

/** Welcome's primary CTA: questionnaire first on fresh devices, sign-in when
 * this device has already been onboarded. */
export function stageAfterGetStarted(preAuthOnboarded: boolean): PreAuthStage {
  return preAuthOnboarded ? 'signin' : 'onboarding';
}

/** Both finishing and skipping the pre-auth questionnaire hand off to
 * sign-in — never back to Welcome, never into the app (no session yet). */
export function stageAfterOnboarding(): PreAuthStage {
  return 'signin';
}
