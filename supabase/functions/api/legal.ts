// Public legal documents served by the API function (no auth):
//
//   GET /privacy — the privacy policy the App Store listing and the in-app
//                  Privacy links point at.
//   GET /terms   — subscription terms the paywall links to.
//
// Served as PLAIN TEXT by design: the Supabase functions gateway rewrites
// Content-Type to text/plain and forces a sandboxing CSP on the shared
// *.supabase.co domain (anti-phishing protection), so HTML would render as
// raw source. Formatted text reads cleanly in any browser at the same URLs;
// if a styled page is ever wanted, host these on a custom domain or GitHub
// Pages and update runtimeConfig's legal URLs.
//
// The copy below describes what the app ACTUALLY does today (local-first
// video, on-device analysis, consent-gated telemetry, RevenueCat billing,
// in-app 2-step account deletion). The support mailbox is the monitored
// account chosen for launch (also the App Store listing's support contact).

const LAST_UPDATED = "August 30, 2026";
const SUPPORT_EMAIL = "picklesenseidev@gmail.com";

export const PRIVACY_POLICY_TEXT = `PICKLE SENSEI — PRIVACY POLICY
Last updated: ${LAST_UPDATED}

Pickle Sensei is a pickleball coaching app that analyzes your stroke
technique. This policy explains what information the app collects, how it
is used, and the controls you have.

The short version: your court video stays on your phone, analysis runs on
your device, and the only data our servers hold is the minimum needed to
run your account, your progress history, and your membership.


1. INFORMATION WE COLLECT

• Account identity — your email address and name as provided by Google or
  Apple sign-in, plus an internal account ID. Stored on our servers
  (Supabase) to create and sign in to your account.

• Coaching profile — skill level, dominant hand, goals, and the optional
  first name and gender you may enter during onboarding. Used to
  personalize coaching guidance.

• Analysis results — stroke type, technique scores, checkpoint
  measurements, timestamps, and app/model version numbers. Kept on your
  device and synced to our servers while you are signed in, powering your
  progress history, streaks, and player rank.

• Court video and camera frames — YOUR DEVICE ONLY. Analysis runs
  on-device. Video is never uploaded; cloud video upload is not built into
  the app.

• Membership status — whether a subscription is active, which product was
  purchased, and its expiry. Held by our servers and RevenueCat (our
  billing processor).

• Evaluation telemetry — anonymized model-evaluation records, collected
  ONLY if you opt in under Settings → Data & consent.


2. WHAT WE NEVER COLLECT

• No payment card numbers — purchases are processed by Apple's App Store
  or Google Play; we only receive a confirmation of membership status.
• No face recognition, and no identity inference from body movement.
• No advertising profiles, and no sale of your data to anyone.
• No precise location.


3. PAYMENTS

Subscriptions are purchased through the App Store or Google Play and
managed by RevenueCat. Apple/Google handle all payment details; card data
never reaches Pickle Sensei's servers. The membership state we store is
limited to: active or not, which product, and when it expires.


4. CONSENT CONTROLS

Optional data programs (model-training contributions and evaluation
telemetry) are OFF by default and controlled in Settings → Data & consent.
Every grant and withdrawal is recorded in an auditable consent ledger, and
withdrawing stops future collection immediately.


5. DATA RETENTION AND DELETION

Your data is retained while your account is active. You can delete your
account at any time in Settings → Delete account (a deliberate two-step
confirmation). Deletion permanently removes your account and all
server-side data: profile, analysis history, sessions, consent records,
and membership records. Data stored only on your device is yours and can
be removed by deleting the app.


6. SECURITY

All traffic is encrypted in transit (TLS). Server-side data is protected
by per-user row-level security — each account can only ever read or write
its own rows — and membership state can only be written by our servers
after verifying it with the billing provider.


7. CHILDREN

Pickle Sensei is not directed at children under 13, and we do not
knowingly collect personal information from them.


8. CHANGES

If this policy changes materially we will update this page and the
"last updated" date above.


9. CONTACT

Questions or data requests: ${SUPPORT_EMAIL}
`;

export const TERMS_TEXT = `PICKLE SENSEI — TERMS OF USE
Last updated: ${LAST_UPDATED}

By using Pickle Sensei you agree to these terms.


1. THE SERVICE

Pickle Sensei provides automated pickleball technique analysis and
coaching guidance. Scores and feedback are computer-generated coaching
estimates — not an official player rating (such as DUPR) — and are
provided "as is" without warranty. Always exercise your own judgment about
physical activity that is safe for you.


2. MEMBERSHIP AND BILLING

• Free accounts include a limited number of full technique ratings.
• Pickle Sensei Pro is available as an auto-renewing monthly or yearly
  subscription, or a one-time lifetime purchase.
• Payment is charged to your App Store or Google Play account.
  Subscriptions renew automatically unless canceled at least 24 hours
  before the end of the current period, and can be managed or canceled in
  your store account settings.
• Prices are shown in the app before purchase. Refunds are handled by the
  App Store / Google Play under their policies.


3. YOUR CONTENT AND ACCOUNT

You are responsible for activity on your account. You may delete your
account at any time in Settings; deletion is permanent.


4. ACCEPTABLE USE

Do not abuse, reverse engineer, overload, or attempt to gain unauthorized
access to the service, other users' data, or membership features.


5. LIABILITY

To the maximum extent permitted by law, Pickle Sensei is not liable for
indirect or consequential damages arising from the use of the app.


6. CONTACT

Questions: ${SUPPORT_EMAIL}
`;
