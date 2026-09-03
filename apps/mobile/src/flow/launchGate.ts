/**
 * Pre-auth launch order: Welcome → onboarding questionnaire → sign-in.
 *
 * Onboarding deliberately runs BEFORE the login flow: a new player answers
 * the setup questions first and only then connects an account (the answers
 * wait in the appStore pre-auth stash until an owner adopts them). The
 * primary CTA takes that path UNCONDITIONALLY — it never consults device
 * history, so the same button does the same thing on every phone. Returning
 * players have their own explicit route: Welcome's "I already have an
 * account" link goes straight to sign-in (an account that never finished
 * setup still lands in the in-account questionnaire afterwards).
 *
 * The questionnaire itself cannot be skipped: leaving it from step one only
 * goes back to Welcome, and the sole way forward to sign-in is finishing it.
 */

export type PreAuthStage = 'welcome' | 'onboarding' | 'signin';

/** Welcome's primary CTA ("Start your first read"): always the questionnaire. */
export function stageAfterGetStarted(): PreAuthStage {
  return 'onboarding';
}

/** Finishing the pre-auth questionnaire hands off to sign-in — never back to
 * Welcome, never into the app (no session yet). */
export function stageAfterOnboarding(): PreAuthStage {
  return 'signin';
}

/** Step one's back control returns to the screen the questionnaire was
 * entered from — never to sign-in, so setup can't be skipped. */
export function stageWhenLeavingOnboarding(): PreAuthStage {
  return 'welcome';
}
