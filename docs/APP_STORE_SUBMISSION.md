# Pickle Sensei · App Store Connect submission dossier (iOS 1.0)

Companion file: `docs/APP_STORE_CONNECT_PUBLISHING_GUIDE.md` explains every
App Store Connect screen, rule and status against Apple's documentation; this
file holds the values to enter for Pickle Sensei.

Compiled 2026-09-02 from the shipping code in `apps/mobile`, the production edge
function in `supabase/functions/api`, `AGENTS.md`, and Apple's current App Store
Connect help pages. Every value below is either read directly from the repo or
derived from it, so the App Store listing, the privacy label, and the review
notes describe what the binary actually does.

## 0. How to use this file

This is an answer key for App Store Connect (ASC). Work through the sections in
order. Each field carries one of these markers:

| Marker    | Meaning                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------- |
| `ENTER:`  | Type or paste this exact text. Character counts were verified against Apple's limits.                |
| `SELECT:` | Choose this option from Apple's control (radio, checkbox, menu).                                     |
| `UPLOAD:` | Attach this asset. The spec for the asset is given inline.                                           |
| `HUMAN:`  | Only the account owner can supply this (phone, address, credentials, business decisions). Ask first. |
| `VERIFY:` | Check the current state in ASC before acting; act only if the condition holds.                       |
| `SKIP:`   | Leave blank / leave off. Do not "improve" it.                                                        |

Hard rules for the agent filling this in:

1. Never invent a value. If a `HUMAN:` item is blank, stop and ask.
2. Never click **Submit for Review** until every item in §2 (pre-flight) is
   checked off by a human.
3. Never enable Family Sharing, Made for Kids, or TestFlight external testing.
   Those are one-way or review-triggering switches.
4. Do not mention Android, Google Play, "guest mode", "Live Court", DUPR, or
   any competitor app anywhere in App Store metadata. Android is not shipping,
   guest mode has no UI entry point, Live Court was cut from v1, DUPR is a
   third-party trademark, and competitor names violate guideline 2.3.7.
5. Do not claim accuracy percentages, "AI coach equivalence", or "best" in any
   copy. The repo's claim gate (`docs/CLAIM_REVIEW.md`) forbids it, and the app's
   own copy only ever says "validated", "server-accepted", and "estimate".

## 1. Identity facts (single source of truth)

| Fact                         | Value                                                                                                                                                                                                                                                                                                                                          | Source                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| App display name             | Pickle Sensei                                                                                                                                                                                                                                                                                                                                  | `ios/PickleSensei/Info.plist` `CFBundleDisplayName`                 |
| Bundle ID                    | `com.picklesensei`                                                                                                                                                                                                                                                                                                                             | `project.pbxproj`                                                   |
| Apple Developer team         | `H26U6W4K6V` (paid Apple Developer Program team)                                                                                                                                                                                                                                                                                               | `project.pbxproj`, `ios/fastlane/Appfile`                           |
| Platform                     | iOS, iPhone only (`TARGETED_DEVICE_FAMILY = 1`), portrait only                                                                                                                                                                                                                                                                                 | `project.pbxproj`, `Info.plist`                                     |
| Minimum iOS                  | 15.1                                                                                                                                                                                                                                                                                                                                           | `IPHONEOS_DEPLOYMENT_TARGET`, RN 0.87 `min_ios_version_supported`   |
| Marketing version            | 1.0                                                                                                                                                                                                                                                                                                                                            | `MARKETING_VERSION`, `runtimeConfig.ts` `APP_VERSION`               |
| Build number                 | Assigned by fastlane (`latest_testflight_build_number + 1`). Build 3 was validated and attached to version 1.0 on 2026-09-03.                                                                                                                                                                                                                  | `ios/fastlane/Fastfile`, `docs/DISTRIBUTION.md`                     |
| Primary language             | English (U.S.)                                                                                                                                                                                                                                                                                                                                 | `CFBundleDevelopmentRegion = en`; the app ships English copy only   |
| Capabilities / entitlements  | Sign in with Apple (`com.apple.developer.applesignin`), In-App Purchase. No push notifications entitlement (reminders are local only).                                                                                                                                                                                                         | `PickleSensei.entitlements`, `docs/DISTRIBUTION.md`                 |
| Permission strings           | Camera (used), Photo Library (used, system picker), Microphone (declared, never requested: the capture session is video only)                                                                                                                                                                                                                  | `Info.plist`, `PickleAudioCoach.swift` line 17                      |
| Export compliance            | `ITSAppUsesNonExemptEncryption = false` (HTTPS only). ASC will not ask per build.                                                                                                                                                                                                                                                              | `Info.plist`                                                        |
| Backend                      | `https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api` (Supabase Edge Function)                                                                                                                                                                                                                                                           | `runtimeConfig.ts`                                                  |
| Privacy policy URL           | `https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api/privacy`                                                                                                                                                                                                                                                                            | `runtimeConfig.ts`, `supabase/functions/api/legal.ts`               |
| Terms of use URL             | `https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api/terms`                                                                                                                                                                                                                                                                              | same                                                                |
| Support email                | `picklesenseidev@gmail.com`                                                                                                                                                                                                                                                                                                                    | `legal.ts` `SUPPORT_EMAIL`                                          |
| Sign-in providers            | Sign in with Apple, Sign in with Google. No email/password. Sign-in is required to use the app (Welcome → onboarding → sign-in → app).                                                                                                                                                                                                         | `SignInScreen.tsx`, `AGENTS.md` "Launch flow"                       |
| Google OAuth client IDs      | iOS `278019487172-ku9j3985cijj4e636t7s7efn8r1vsu8m…`, Web `278019487172-crj0b3oig508i5e5dlqgfno275i9nes1…` (public, already in the binary)                                                                                                                                                                                                     | `runtimeConfig.ts`, `Info.plist` URL scheme                         |
| Billing                      | RevenueCat (`react-native-purchases` 10.8.1, `RevenueCat` 5.87.1, StoreKit 2). iOS public SDK key `appl_twORWAKcOeYuEFbvZGOUjnWDrAl` (production).                                                                                                                                                                                             | `runtimeConfig.ts`, `Podfile.lock`                                  |
| Entitlement (RevenueCat)     | `pickle_sensei_pro` (legacy alias `premium`)                                                                                                                                                                                                                                                                                                   | `AGENTS.md` Billing                                                 |
| Offering (RevenueCat)        | The **Current** offering; the app reads `offerings.current` and needs the standard MONTHLY, ANNUAL, LIFETIME packages.                                                                                                                                                                                                                         | `revenueCatClient.ts` line 333                                      |
| ASC product IDs              | `pickle_sensei_pro_monthly` (auto-renewable), yearly successor of `pickle_sensei_pro_annual` (auto-renewable, see §10 `VERIFY`), `pickle_sensei_pro_lifetime` (non-consumable)                                                                                                                                                                 | `AGENTS.md` Billing                                                 |
| Target prices (USD)          | $7.99 / month · $59.99 / year · $159.99 lifetime. The app never hardcodes prices; it displays what StoreKit returns.                                                                                                                                                                                                                           | `AGENTS.md` Billing, `PaywallScreen.tsx`                            |
| Free tier                    | 2 lifetime free validated ratings per account. Only a successfully scored analysis consumes one.                                                                                                                                                                                                                                               | `paywallCopy.ts`                                                    |
| Third-party SDKs in binary   | RevenueCat, GoogleSignIn 9.2.0 (+ AppAuth, GTMAppAuth, GoogleUtilities, AppCheckCore), Notifee (`react-native-notify-kit`, local notifications), react-native-keychain, op-sqlite, react-native-video, react-native-webview, reanimated, svg, screens, safe-area-context, linear-gradient, worklets. No analytics, crash-reporting, or ad SDK. | `Podfile.lock`, `package.json`                                      |
| Apple frameworks that matter | Vision (on-device body pose), AVFoundation (capture), StoreKit (`SKStoreReviewController` rating prompt), AuthenticationServices (Sign in with Apple)                                                                                                                                                                                          | `native/vision-core`, `PickleStoreReview.swift`, `PickleAuth.swift` |
| Third-party content          | Drill Library plays attributed YouTube videos through the official IFrame Player API (creator names displayed). No other third-party content.                                                                                                                                                                                                  | `supabase/functions/api/drillMedia.ts`, `DrillVideoPlayer.tsx`      |
| Tracking / ads / IDFA        | None. `PrivacyInfo.xcprivacy` declares `NSPrivacyTracking = false`.                                                                                                                                                                                                                                                                            | `PrivacyInfo.xcprivacy`, `docs/PRELAUNCH_CHECKLIST.md` §8           |
| App Store rating prompt      | `SKStoreReviewController` after scored analyses (OS-throttled) plus a Settings row that deep-links to the write-review page once `APP_STORE_ID` is set                                                                                                                                                                                         | `src/review/appStoreReview.ts`                                      |

## 2. Pre-flight checklist (all must be true before Submit for Review)

### 2.1 Account, agreements, banking

- [ ] `HUMAN:` **Agreements, Tax, and Banking → Paid Apps Agreement** is
      _Active_ (not "Pending" or "Processing"). Without it every in-app purchase
      shows "Developer Action Needed" and sandbox purchases fail during review.
- [ ] `HUMAN:` Banking information entered and verified; U.S. tax form (W-9 for
      a U.S. person/entity) completed; contact info (Senior Management, Finance,
      Technical, Legal, Marketing) filled.
- [ ] `HUMAN:` **Business → Digital Services Act trader status** declared (see
      §8.3). ASC asks for this on first submission regardless of where you sell.

### 2.2 ASC record and keys

- [ ] `VERIFY:` App record exists (it does: "1.0 Prepare for Submission" is
      visible), bundle ID `com.picklesensei`, SKU fixed at creation (cannot
      change).
- [x] `VERIFY:` Apple ID `6806918402` is set in
      `apps/mobile/src/config/runtimeConfig.ts` before the release archive is
      built. This
      turns Settings → "Rate Pickle Sensei" into a write-review deep link and
      stops the per-analysis prompt once someone rates.
- [ ] `VERIFY:` Users and Access → Integrations → **App Store Connect API** key
      `PLHCZDTYYS` (App Manager) exists; fastlane uses it from
      `~/.appstoreconnect/AuthKey_PLHCZDTYYS.p8` (never committed).
- [ ] `HUMAN:` Users and Access → Integrations → **In-App Purchase** → generate
      an In-App Purchase Key (.p8), note the Key ID and the **Issuer ID**, and
      upload both to RevenueCat → Project → Apps → App Store app → "In-app
      purchase key configuration". RevenueCat 5.x (StoreKit 2) cannot record
      transactions without it.
- [ ] `HUMAN:` In RevenueCat → the App Store app → copy the **Apple Server
      Notification URL** and paste it into ASC → App Information → **App Store
      Server Notifications** → Production Server URL AND Sandbox Server URL,
      Version 2. (RevenueCat's "Apply in App Store Connect" button does this for
      you if the ASC API key is connected.)
- [ ] `HUMAN:` Users and Access → **Sandbox → Testers**: at least one Sandbox
      Apple Account exists, and on the test iPhone it is signed in at Settings →
      Developer → Sandbox Apple Account. Purchase, restore, cancel, and lapse
      were each tested once (`docs/PRELAUNCH_CHECKLIST.md` §4).

### 2.3 RevenueCat

- [ ] `VERIFY:` Products exist in RevenueCat with identifiers matching §9/§10
      exactly, attached to entitlement `pickle_sensei_pro`.
- [ ] `VERIFY:` The **Current** offering contains exactly three packages of
      standard types Monthly (`$rc_monthly`), Annual (`$rc_annual`), Lifetime
      (`$rc_lifetime`) mapped to the three products. The app ignores any other
      package type.
- [ ] `VERIFY:` Supabase secrets set: `REVENUECAT_SECRET_API_KEY` (preferred)
      and `REVENUECAT_WEBHOOK_AUTH`; RevenueCat webhook configured at
      `https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api/webhooks/revenuecat`
      with the same Authorization value.

### 2.4 Backend

- [ ] `VERIFY:` `supabase db push` applied, then
      `supabase functions deploy api --no-verify-jwt` deployed, in that order,
      **before** the release build ships (the session contract of 2026-09-01
      requires the new server; see `AGENTS.md` "Auth sessions").
- [ ] `VERIFY:` `curl https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api/healthz`
      returns `{"ok":true}`; `/privacy` and `/terms` render readable text in
      Safari (they are served as plain text on purpose).
- [ ] `VERIFY:` Supabase Dashboard → Authentication → Providers: Google ON with
      both client IDs; **Apple ON with Client ID `com.picklesensei`**. Without
      the Apple provider every Sign in with Apple attempt fails with
      `auth.not_configured`.
- [ ] `VERIFY:` Supabase Edge Function secrets include
      `APPLE_SIGN_IN_CLIENT_ID=com.picklesensei`, `APPLE_SIGN_IN_TEAM_ID`,
      `APPLE_SIGN_IN_KEY_ID`, `APPLE_SIGN_IN_PRIVATE_KEY`, and a base64-encoded
      32-byte `APPLE_TOKEN_ENCRYPTION_KEY`. Apple bootstrap now exchanges the
      native authorization code and stores only AES-256-GCM ciphertext for the
      later revocation request.

### 2.5 Code and configuration changes still needed

- [x] `VERIFY:` **Support URL.** The dedicated public support page is live at
      `https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api/support`. It
      includes the real support email, owner and mailing address, account and
      purchase help, capture troubleshooting, account deletion instructions,
      and links to the Privacy Policy and Terms of Use.
- [x] `VERIFY:` `APP_STORE_ID` is set to `6806918402` (see §2.2).
- [x] Code: `ios/PickleSensei/PrivacyInfo.xcprivacy` mirrors the app's collected
      data types and declares RevenueCat-linked User ID and Purchase History for
      App Functionality + Analytics. `HUMAN:` make the App Store Connect privacy
      questionnaire match this manifest before submission and after every data-
      flow change.
- [x] Code: Sign in with Apple token revocation on account deletion. Native
      sign-in sends Apple's one-use authorization code to the backend; the Edge
      Function exchanges it, stores the refresh token encrypted and bound to the
      canonical user ID, and calls Apple's `/auth/revoke` before Supabase
      deletion. Legacy accounts without a stored token are still deleted and
      receive Apple's manual-disconnect instructions, as Apple requires.
- [x] Code: delete the canonical RevenueCat customer before Supabase account
      deletion using `REVENUECAT_SECRET_API_KEY`. Successful Apple and
      RevenueCat steps are checkpointed so retries are idempotent. This does not
      cancel the App Store subscription; the in-app deletion review warns about
      continued billing and links to App Store subscription management.
- [x] Code: Terms require users to be at least 13, with parent/guardian agreement
      where local law requires it; the Privacy Policy retains the matching
      under-13 disclosure.
- [ ] Optional: the in-app "DUPR-style estimate" (commit 65839e9) uses a third-
      party trademark inside the product. It is disclaimed in Settings and is a
      low-probability 5.2.1 risk. Keep it out of all metadata; consider renaming
      the label to "match-rating estimate" in a later build.

### 2.6 Build

- [ ] `VERIFY:` `cd apps/mobile && npm run check:distribution && npx tsc --noEmit && npx jest --silent`
      all green at the release commit.
- [ ] `VERIFY:` Xcode scheme Run configuration is Release; Debug never ships.
- [ ] `VERIFY:` The archive is built with Xcode 26 or later and the iOS 26 SDK.
      Apple: "Since April 28, 2026: Apps uploaded to App Store Connect must be
      built with Xcode 26 or later using an SDK for iOS 26". This Mac has Xcode
      26.4.1 (iOS 26.4 SDK), which passes; do not build the release on an older
      machine.
- [ ] `HUMAN:` `cd apps/mobile/ios && bundle exec fastlane ios release` on the
      Mac with the ASC key exported. This uploads the binary only. Wait for the
      "build processed" email, then attach the build in §11.7.
- [ ] `VERIFY:` The uploaded build's Info.plist still carries
      `ITSAppUsesNonExemptEncryption = false` so ASC does not raise the export
      compliance question.

### 2.7 Assets

- [ ] `HUMAN:` 6.9" iPhone screenshots (1320 × 2868 px portrait PNG or JPG,
      3 to 8 images) following the shot list in Appendix C. Capture on an
      iPhone 16 Pro Max / 17 Pro Max device or simulator. This is the only
      required iPhone size; Apple scales it to every other iPhone.
- [ ] `HUMAN:` One review screenshot of the paywall pricing page (any size
      ≥ 640 × 920, PNG/JPG) for the three in-app purchase records (§9, §10).
- [ ] `HUMAN:` A sample stroke clip (MP4/MOV, portrait or landscape, 3 to 10
      seconds, full body visible, one clear forehand) hosted at a public URL for
      the reviewer's "Import Video" path (Appendix D references it as
      `SAMPLE_CLIP_URL`). Also record a 30 to 60 second screen recording of the
      full flow (sign-in → capture → result) to attach in App Review
      Information.
- [ ] `VERIFY:` App icon 1024 × 1024 is in the build (`Images.xcassets/AppIcon.appiconset/icon-1024.png`).
      ASC takes the icon from the binary; nothing to upload separately.

### 2.8 Review account

- [ ] `HUMAN:` Create a dedicated Google account for App Review (for example
      `picklesensei.review@gmail.com`), turn **off** 2-Step Verification, add a
      recovery phone you control, and sign into it once from a browser so
      Google's "new device" challenge has been seen. Put its email and password
      into §11.8 Sign-In Information. Keep it alive for the life of the app.
      Reviewers can also use Sign in with Apple with any Apple ID; the notes say
      so.

## 3. General → App Information

Path: ASC → Apps → Pickle Sensei → General → **App Information**.

### 3.1 Localizable Information (English (U.S.))

| Field               | Value                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Name (30 max)       | `ENTER:` `Pickle Sensei` (13 chars). Alternative if you want a keyword in the name: `Pickle Sensei: Stroke Coach` (27). Do not exceed 30.       |
| Subtitle (30 max)   | `ENTER:` `Pickleball technique coach` (26). Alternatives: `Private pickleball form coach` (29), `Film a stroke. Get the fix.` (27).             |
| Privacy Policy URL  | `ENTER:` `https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api/privacy`                                                                    |
| Privacy Choices URL | `ENTER:` `https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api/support` (privacy-request contact and in-app account-deletion instructions) |
| Other localizations | `SKIP:` English (U.S.) only for 1.0.                                                                                                            |

### 3.2 General Information

| Field                           | Value                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundle ID                       | `VERIFY:` `com.picklesensei` (locked once a build is uploaded)                                                                                                                                                                                                                                                                           |
| SKU                             | `VERIFY:` whatever was set at creation (read-only)                                                                                                                                                                                                                                                                                       |
| Apple ID                        | `VERIFY:` copy this number into `runtimeConfig.ts` `APP_STORE_ID` (§2.2)                                                                                                                                                                                                                                                                 |
| Primary Language                | `SELECT:` English (U.S.)                                                                                                                                                                                                                                                                                                                 |
| Primary Category                | `SELECT:` **Sports**                                                                                                                                                                                                                                                                                                                     |
| Secondary Category              | `LEAVE BLANK:` Pickle Sensei is a sport-specific pickleball technique coach. Do not classify it as Health & Fitness, Medical, or another unrelated category merely to obtain a second browse surface.                                                                                                                                    |
| Content Rights                  | `SELECT:` **Yes, it contains, shows, or accesses third-party content** and tick the confirmation that you have the rights or are permitted to use it. Rationale: the Drill Library embeds public YouTube videos via YouTube's official IFrame Player API (permitted by YouTube's API Services Terms) with creator attribution.           |
| Age Rating                      | Complete the questionnaire per §4. Expected result: 9+ from the questionnaire, then Override to 13+ (recommended, see §4.4).                                                                                                                                                                                                             |
| License Agreement               | `SELECT:` Apple's Standard License Agreement (default). Do not upload a custom EULA. The Terms of Use URL is placed in the description (§11.4) to satisfy guideline 3.1.2(c).                                                                                                                                                            |
| App Store Server Notifications  | `ENTER:` the RevenueCat URL in both Production and Sandbox fields, Version 2 (§2.2).                                                                                                                                                                                                                                                     |
| App-Specific Shared Secret      | `SKIP:` unless RevenueCat asks for it. StoreKit 2 apps use the In-App Purchase Key instead. Generating it is harmless.                                                                                                                                                                                                                   |
| Regulated Medical Device Status | `VERIFY:` the existing declaration says **No**. Pickle Sensei is not designed, marketed, or intended as a medical device. With Sports as the sole category and no frequent Medical or Treatment Information in the age rating, the category-based declaration trigger does not apply; retaining the truthful No declaration is harmless. |
| Tax Category                    | `SELECT:` App Store software (default). Do not change.                                                                                                                                                                                                                                                                                   |

## 4. Age Rating questionnaire (2025 system: 4+, 9+, 13+, 16+, 18+)

Path: App Information → Age Rating → **Edit**. Apple requires the updated
questionnaire (in-app controls, capabilities, medical/wellness, and, from
September 2026, social-media questions) for every new submission.

### 4.1 Content descriptors

| Question                                         | Answer                                                                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cartoon or Fantasy Violence                      | `SELECT:` None                                                                                                                                           |
| Realistic Violence                               | `SELECT:` None                                                                                                                                           |
| Prolonged Graphic or Sadistic Realistic Violence | `SELECT:` None                                                                                                                                           |
| Guns or Other Weapons                            | `SELECT:` None                                                                                                                                           |
| Mature or Suggestive Themes                      | `SELECT:` None                                                                                                                                           |
| Sexual Content or Nudity                         | `SELECT:` None                                                                                                                                           |
| Graphic Sexual Content and Nudity                | `SELECT:` None                                                                                                                                           |
| Profanity or Crude Humor                         | `SELECT:` None                                                                                                                                           |
| Horror/Fear Themes                               | `SELECT:` None                                                                                                                                           |
| Alcohol, Tobacco, or Drug Use or References      | `SELECT:` None                                                                                                                                           |
| Medical or Treatment Information                 | `SELECT:` None. The app never diagnoses or manages a medical condition; the Terms say scores are coaching estimates.                                     |
| Health or Wellness Topics                        | `SELECT:` **Yes**. Apple's definition includes "exercise recommendations"; the app prescribes drills and technique changes. This answer alone yields 9+. |
| Gambling                                         | `SELECT:` No                                                                                                                                             |
| Simulated Gambling                               | `SELECT:` None                                                                                                                                           |
| Contests                                         | `SELECT:` None. Player rank, streaks, and achievements are personal; there is no leaderboard, head-to-head, or prize in 1.0.                             |
| Loot Boxes                                       | `SELECT:` No                                                                                                                                             |

### 4.2 In-App Controls

| Question          | Answer                                                        |
| ----------------- | ------------------------------------------------------------- |
| Parental Controls | `SELECT:` No                                                  |
| Age Assurance     | `SELECT:` No (no Declared Age Range API, no age verification) |

### 4.3 Capabilities

| Question                           | Answer                                                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Unrestricted Web Access            | `SELECT:` No. The only WebView is a constrained YouTube player shell for catalog videos; users cannot enter URLs or browse. |
| User-Generated Content             | `SELECT:` No. Nothing a user records or writes is distributed to other users.                                               |
| Social Media                       | `SELECT:` No (no feed, likes, comments, or sharing of user content)                                                         |
| Social Media disabled for under 13 | Not applicable once Social Media is No                                                                                      |
| Messaging and Chat                 | `SELECT:` No                                                                                                                |
| Advertising                        | `SELECT:` No                                                                                                                |

### 4.4 Additional Information

| Field                         | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Calculated rating             | Expect **9+** (driven only by Health or Wellness Topics).                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Made for Kids                 | `SKIP:` never select. It is irreversible and pulls the app into Kids Category rules (no third-party analytics, no external links, etc.).                                                                                                                                                                                                                                                                                                                                       |
| Override to Higher Age Rating | `SELECT:` **13+** (recommended). The privacy policy states the app is not directed at children under 13, the app collects email, name, and gender with no parental-consent flow, and the audience is adult players. Apple explicitly allows an override when your own policy sets a higher minimum age. If you would rather keep the calculated 9+, that is also compliant; the questionnaire answers above are the same either way. Record the choice in `docs/DECISIONS.md`. |
| Region-specific ratings       | Auto-generated (Brazil, Korea, Australia). No action.                                                                                                                                                                                                                                                                                                                                                                                                                          |

## 5. App Store → Trust & Safety → App Privacy (privacy nutrition label)

Path: sidebar → **App Privacy** → Get Started / Edit.

### 5.1 What actually leaves the device (audit summary)

Read from `apps/mobile/src/account/*.ts`, `src/evaluation/trialCapture.ts`,
`src/data/api.ts`, `supabase/functions/api/index.ts`, and the migrations:

| Data                                                                                                                                   | Where it goes                                                                 | Linked to account?                                     | Purpose                                          |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| Email address and display name from Apple/Google sign-in                                                                               | Supabase Auth + `public.profiles` (`email`, `display_name`, `avatar_url`)     | Yes (it is the account)                                | Authentication, account                          |
| Account ID (Supabase UUID). Also used as the RevenueCat `appUserID`.                                                                   | Supabase, RevenueCat                                                          | Yes                                                    | Account, entitlement verification                |
| Coaching profile: skill level, dominant hand, goal, biggest problem, optional first name, optional gender                              | `public.profiles` via `PUT /v1/me/onboarding`                                 | Yes                                                    | Personalizing coaching                           |
| Analysis results: stroke type, technique score, checkpoint scores, phases, confidence, timestamps, model/config versions, session id   | `public.shots`, `public.sessions` via `POST /v1/shots:sync`                   | Yes                                                    | Progress history, rank, free-rating accounting   |
| Purchase/entitlement state: premium yes/no, product key, expiry, verified_at; RevenueCat holds the StoreKit transaction history        | `public.billing_entitlements`, RevenueCat                                     | Yes                                                    | Unlocking Pro, fraud prevention                  |
| Consent ledger rows (scope, grant/withdraw, version, source, client device string)                                                     | `public.consent_records`                                                      | Yes                                                    | Accountability for opt-in programs               |
| Evaluation telemetry (claims/abstentions, timings, versions), **only after opt-in** in Settings → Data & consent                       | `public.evaluation_trials` (row carries `user_id`)                            | Yes (the row has a user id, despite "anonymized" copy) | Model evaluation (analytics)                     |
| "Was this analysis accurate?" feedback                                                                                                 | `public.analysis_feedback`                                                    | Yes                                                    | Product improvement                              |
| Saved drill slugs                                                                                                                      | `public.user_saved_drills`                                                    | Yes                                                    | App functionality                                |
| Account-deletion exit survey (reason + optional comment + server-stamped app version, platform, account age, premium flag)             | `public.account_deletion_feedback`, anonymized (`user_id` set NULL) on delete | No after deletion                                      | Churn analysis; optional, skippable form         |
| Bootstrap `environment` body (locale, timezone, OS version, app version, "iOS phone")                                                  | Sent to `/v1/account/bootstrap`, **not stored** (handler ignores the body)    | n/a                                                    | Not "collected" under Apple's definition         |
| Court video, camera frames, pose landmarks, imported clips                                                                             | **Never leave the device** (no storage bucket exists; no upload endpoint)     | n/a                                                    | Not collected                                    |
| Crash/stability events                                                                                                                 | In-memory recorder only (`stabilityTelemetry.ts`); nothing transmitted        | n/a                                                    | Not collected                                    |
| Google Sign-In SDK declarations: name, email, phone number, coarse location, user/device identifiers, other authentication data, usage | Google identity services; exact fields depend on provider behavior            | Conservatively treated as linked                       | Sign-in, security, functionality, analytics      |
| Embedded YouTube/Vimeo page or video, playback interaction, device/browser identifier, network-derived coarse location, ad data        | YouTube or Vimeo when the user opens a hosted drill video                     | Conservatively treated as linked                       | Playback, functionality, analytics, provider ads |
| Advertising identifier, precise GPS location, contacts, search history, health records                                                 | Not accessed by Pickle Sensei                                                 | n/a                                                    | Not collected                                    |

### 5.2 Answers to enter

**Step 1: "Do you or your third-party partners collect data from this app?"**
`SELECT:` Yes.

**Step 2: data types to tick.** Tick exactly these fourteen types. This is the
published September 3, 2026 answer and includes data declared by embedded SDKs
and WebViews, not only fields stored in Pickle Sensei's own database:

| Category         | Data types                                              |
| ---------------- | ------------------------------------------------------- |
| Contact Info     | Name; Email Address; Phone Number                       |
| Health & Fitness | Fitness                                                 |
| Location         | Coarse Location                                         |
| User Content     | Other User Content                                      |
| Browsing History | Browsing History                                        |
| Purchases        | Purchase History                                        |
| Identifiers      | User ID; Device ID                                      |
| Usage Data       | Product Interaction; Advertising Data; Other Usage Data |
| Other Data       | Other Data Types                                        |

Do not tick Photos or Videos, Audio Data, Precise Location, Contacts, Search
History, Sensitive Info, Financial Info, Body, Surroundings, Diagnostics,
Customer Support, Emails or Text Messages, or Gameplay Content unless the
shipping binary's behavior changes.

**Step 3: per data type.** For every type below, answer the "tracking" question
`SELECT:` **No, we do not use this data for tracking purposes**.

| Data type           | Usage purposes to tick                                                         | Linked to identity? | What it covers                                                                                 |
| ------------------- | ------------------------------------------------------------------------------ | ------------------- | ---------------------------------------------------------------------------------------------- |
| Name                | Product Personalization; App Functionality                                     | Yes                 | Provider/display name and optional first name                                                  |
| Email Address       | App Functionality                                                              | Yes                 | Apple/Google account identity                                                                  |
| Phone Number        | App Functionality                                                              | Yes                 | Google Sign-In SDK declaration                                                                 |
| Fitness             | Product Personalization; Analytics; App Functionality                          | Yes                 | Structured stroke, technique, session, and evaluation records                                  |
| Coarse Location     | App Functionality                                                              | Yes                 | Google Sign-In and network-derived coarse location declarations; no device location permission |
| Other User Content  | Analytics                                                                      | Yes                 | Optional free-form feedback and exit-survey content while associated with the account          |
| Browsing History    | Third-Party Advertising; Analytics; App Functionality                          | Yes                 | Externally hosted video/page viewed in the drill WebView                                       |
| User ID             | Analytics; App Functionality                                                   | Yes                 | Supabase UUID and RevenueCat app user ID                                                       |
| Device ID           | Analytics                                                                      | Yes                 | Google Sign-In and embedded-provider SDK declaration                                           |
| Purchase History    | App Functionality; Analytics                                                   | Yes                 | RevenueCat purchase and entitlement history tied to the account                                |
| Product Interaction | App Functionality; Product Personalization; Analytics; Third-Party Advertising | Yes                 | Drill/video interactions and app feature interactions                                          |
| Advertising Data    | Third-Party Advertising; Analytics                                             | Yes                 | Ads that an external video provider may display; no Pickle Sensei ad SDK                       |
| Other Usage Data    | Analytics; App Functionality                                                   | Yes                 | Evaluation telemetry, feedback, consent, and SDK usage data                                    |
| Other Data Types    | Product Personalization; Analytics; App Functionality                          | Yes                 | Coaching profile and other authentication/provider data                                        |

**Step 4: Publish.** The published label currently shows Data Linked to You for
Usage Data, Other Data, Health & Fitness, Contact Info, Browsing History, User
Content, Purchases, Identifiers, and Location. The preview may also show
provider-declared Identifiers or Other Data as Data Not Linked to You because
Apple aggregates individual SDK manifests. Tracking is No for every type.
Update these answers whenever the binary, providers, or data flows change.

### 5.3 Why these classifications

- **Fitness** is Apple's bucket for "fitness and exercise data". Sport technique
  scores are exercise-performance data. `docs/PRELAUNCH_CHECKLIST.md` §5 already
  anticipated "identity, fitness data; no tracking".
- **Purchase History + User ID** follow RevenueCat's published guidance for
  apps that identify users with a custom app user ID linked to an email.
- **Other Usage Data** is declared because the opt-in telemetry rows carry a
  `user_id`. Apple's optional-disclosure exemption needs the collection to be
  infrequent and outside primary functionality; per-analysis telemetry is
  neither, even when opt-in.
- **Other User Content** is included conservatively because free-form feedback
  can be linked to the account when submitted, even though the exit-survey row
  is anonymized during deletion.
- **Phone Number, Coarse Location, Device ID, Product Interaction, Advertising
  Data, and Browsing History** account for Google Sign-In and the constrained
  external-video WebView. Pickle Sensei does not request device location, use
  IDFA, or run its own advertising SDK.
- Bootstrap device context is not stored server-side, so it is not
  "collected".

## 6. App Store → Trust & Safety → App Accessibility (Accessibility Nutrition Labels)

Path: sidebar → **App Accessibility** → Get Started. These labels are
optional. Publishing an inaccurate one is worse than publishing none, so treat
every label as "claim only after testing on a device with the feature on".

| Label                             | Code evidence                                                                                                                                                        | Recommendation for 1.0                                                                                                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VoiceOver                         | ~190 `accessibilityLabel`/`accessibilityRole`/`accessibilityState` usages; custom camera UI is native UIKit with labels                                              | `HUMAN:` test the common tasks (sign in, onboarding, open camera, read a result, open paywall, delete account) with VoiceOver only. Claim only if every task completes without sight. |
| Voice Control                     | Same labels drive Voice Control names                                                                                                                                | `HUMAN:` test "Show names" and "Tap <label>" on the same tasks. Claim only if it passes.                                                                                              |
| Larger Text                       | RN default font scaling is on (no `allowFontScaling={false}`), but several labels use `numberOfLines={1}` with `adjustsFontSizeToFit`/`minimumScaleFactor` shrinking | `SKIP:` for 1.0. Apple's bar is 200% text with no truncation or clipping; the camera status card and podium prices shrink instead of reflowing.                                       |
| Dark Interface                    | No `useColorScheme`; screens have fixed light or dark surfaces by design                                                                                             | `SKIP:` the app does not follow the system Dark Mode setting.                                                                                                                         |
| Differentiate Without Color Alone | Checkpoint bands always show the number with the color; rank tiers show names; stat deltas use ▲/▼ glyphs plus color                                                 | `HUMAN:` verify with Settings → Accessibility → Differentiate Without Color on. Likely claimable.                                                                                     |
| Sufficient Contrast               | Design tokens are high-contrast on dark; some `onDarkFaint`/`inkSoft` captions may fall below 4.5:1                                                                  | `HUMAN:` measure the caption colors in `src/design/tokens.ts` against their backgrounds. Claim only if all body/caption text passes 4.5:1 (or does with Increase Contrast on).        |
| Reduced Motion                    | `useReducedMotion` gates sheet/step animations; splash cross-fade is opacity only                                                                                    | `HUMAN:` verify with Reduce Motion on that no large parallax/zoom remains (walkthrough spotlight, rank celebration, streak celebration). Likely claimable.                            |
| Captions                          | The only first-party video is the 5 s brand splash (music/sfx, no speech). Catalog videos are YouTube with YouTube captions.                                         | `SKIP:` not applicable.                                                                                                                                                               |
| Audio Descriptions                | No first-party narrative video                                                                                                                                       | `SKIP:` not applicable.                                                                                                                                                               |

Default action if no testing time exists before submission: `SKIP:` the whole
section (leave unpublished). It does not block review.

## 7. App Store → Trust & Safety → Ratings and Reviews

Nothing to fill before launch. After launch:

- Respond to reviews from this page (replies are public; keep the brand voice:
  calm, specific, no hype).
- Never reset the rating summary casually; it is only offered on new versions.
- The in-app prompt is `SKStoreReviewController` (guideline 5.6.1 compliant,
  OS-throttled to 3 per 365 days). Setting `APP_STORE_ID` (§2.2) makes the
  Settings row open `https://apps.apple.com/app/id<APP_STORE_ID>?action=write-review`.

## 8. Monetization → Pricing and Availability

Path: sidebar → **Pricing and Availability**.

### 8.1 Price

| Field             | Value                                                          |
| ----------------- | -------------------------------------------------------------- |
| Base country      | `SELECT:` United States                                        |
| Price             | `SELECT:` **Free** (USD 0.00). All revenue is in-app purchase. |
| Scheduled changes | `SKIP:`                                                        |
| Pre-orders        | `SKIP:` (off)                                                  |

### 8.2 Availability

| Field                                     | Value                                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Countries or regions                      | `VERIFIED:` **All 175 countries or regions**, each currently marked Available on App Release. Automatic availability for future App Store countries or regions is enabled. Worldwide selection does not remove local legal duties; see `docs/WORLDWIDE_LEGAL_RISK_REGISTER_2026-09-03.md`. |
| Distribution methods                      | `SELECT:` App Store (public). No alternative distribution, no custom app distribution.                                                                                                                                                                                                     |
| Make available on Macs with Apple silicon | `SELECT:` **Off** (uncheck "Make this app available"). The product is a rear-camera capture flow; on a Mac it would fail its core task.                                                                                                                                                    |
| Make available on Apple Vision Pro        | `SELECT:` **Off** for the same reason.                                                                                                                                                                                                                                                     |
| Pre-order                                 | `SKIP:`                                                                                                                                                                                                                                                                                    |

### 8.3 Digital Services Act trader status (Business section, asked at first submission)

| Question                    | Answer                                                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Are you a trader (EU law)?  | `VERIFIED:` **Trader**. Pickle Sensei is monetized and offered in EU storefronts.                                                                              |
| Trader contact information  | `VERIFIED:` real individual name, San Diego mailing address, App Review phone, and `picklesenseidev@gmail.com`; email verified and address document submitted. |
| EU compliance certification | `VERIFIED:` submitted September 3, 2026. Apple status is **In Review** for 27 countries or regions. Do not release in the EU until status becomes Active.      |

EU-27 for the exclusion list, if needed: Austria, Belgium, Bulgaria, Croatia,
Cyprus, Czechia, Denmark, Estonia, Finland, France, Germany, Greece, Hungary,
Ireland, Italy, Latvia, Lithuania, Luxembourg, Malta, Netherlands, Poland,
Portugal, Romania, Slovakia, Slovenia, Spain, Sweden.

## 9. Monetization → In-App Purchases (non-consumable lifetime)

Path: sidebar → **In-App Purchases** → **+**.

| Field                           | Value                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type                            | `SELECT:` Non-Consumable                                                                                                                                                                                                                                                                                 |
| Reference Name (internal)       | `ENTER:` `Pickle Sensei Pro Lifetime`                                                                                                                                                                                                                                                                    |
| Product ID                      | `ENTER:` `pickle_sensei_pro_lifetime` (must match RevenueCat exactly; cannot be changed or reused after deletion)                                                                                                                                                                                        |
| Availability                    | `SELECT:` all countries/regions where the app is available                                                                                                                                                                                                                                               |
| Price Schedule → Price          | `SELECT:` USD **159.99** (base United States); accept Apple's automatically generated prices for other storefronts                                                                                                                                                                                       |
| Tax Category                    | `SELECT:` App Store software (default)                                                                                                                                                                                                                                                                   |
| Family Sharing                  | `SELECT:` **Off**. Enabling is irreversible and the entitlement/RevenueCat setup was not designed around shared purchases.                                                                                                                                                                               |
| Content Hosting                 | `SELECT:` No (no Apple-hosted content)                                                                                                                                                                                                                                                                   |
| Localization (English U.S.)     | Display Name (30 max) `ENTER:` `Pro Lifetime` · Description (45 max) `ENTER:` `Unlimited validated ratings, pay once`                                                                                                                                                                                    |
| Image (promotional)             | `SKIP:`                                                                                                                                                                                                                                                                                                  |
| Review Information → Screenshot | `UPLOAD:` the paywall pricing-page screenshot (≥ 640 × 920 px, PNG/JPG) showing the Lifetime column.                                                                                                                                                                                                     |
| Review Information → Notes      | `ENTER:` `Lifetime option on the in-app paywall (Settings > Membership > Pickle Sensei Pro, or the Coach button after the two free ratings are used). Unlocks unlimited validated stroke ratings permanently. Purchases are processed by StoreKit via RevenueCat; prices shown come from the App Store.` |
| Submission                      | On the version page (§11.6) add this product under **In-App Purchases and Subscriptions** so it is reviewed with the 1.0 binary. First-time IAPs must ride along with a version.                                                                                                                         |

## 10. Monetization → Subscriptions (auto-renewable)

Path: sidebar → **Subscriptions** → **Create** (group first, then products).

### 10.1 Subscription group

| Field                             | Value                                                                                                                                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reference Name (internal)         | `ENTER:` `Pickle Sensei Pro`                                                                                                                                                                                   |
| Group Localization (English U.S.) | Subscription Group Display Name (30 max) `ENTER:` `Pickle Sensei Pro`                                                                                                                                          |
| App Name Display Options          | `SELECT:` Use App Name (Pickle Sensei)                                                                                                                                                                         |
| Custom App Name                   | `SKIP:`                                                                                                                                                                                                        |
| `VERIFY:`                         | Both subscriptions below live in **this one group**. Same-content, different-duration products belong at the **same level** (Level 1) so Apple treats a monthly→yearly switch as a crossgrade, not an upgrade. |

### 10.2 Monthly subscription

| Field                                | Value                                                                                                                                                                                                                                                                               |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reference Name                       | `ENTER:` `Pickle Sensei Pro Monthly`                                                                                                                                                                                                                                                |
| Product ID                           | `ENTER:` `pickle_sensei_pro_monthly`                                                                                                                                                                                                                                                |
| Subscription Duration                | `SELECT:` 1 month                                                                                                                                                                                                                                                                   |
| Group level                          | `SELECT:` Level 1                                                                                                                                                                                                                                                                   |
| Availability                         | `SELECT:` all countries/regions where the app is available                                                                                                                                                                                                                          |
| Subscription Price                   | `SELECT:` USD **7.99**, base United States, auto-generate other storefronts                                                                                                                                                                                                         |
| Introductory Offer                   | `SKIP:` for launch. (If added later, the paywall automatically shows "Start free trial" and the eligibility copy; nothing else to change.)                                                                                                                                          |
| Promotional / Win-back / Offer Codes | `SKIP:`                                                                                                                                                                                                                                                                             |
| Family Sharing                       | `SELECT:` Off                                                                                                                                                                                                                                                                       |
| Localization (English U.S.)          | Display Name (30 max) `ENTER:` `Pro Monthly` · Description (45 max) `ENTER:` `Unlimited validated ratings, billed monthly`                                                                                                                                                          |
| Image                                | `SKIP:`                                                                                                                                                                                                                                                                             |
| Review Screenshot                    | `UPLOAD:` paywall pricing-page screenshot (≥ 640 × 920) with the Monthly column visible                                                                                                                                                                                             |
| Review Notes                         | `ENTER:` `Monthly plan on the in-app paywall (Settings > Membership > Pickle Sensei Pro, or the Coach button after the two free ratings). Auto-renews monthly; price, duration, Restore purchases, Terms, and Privacy links are shown on the same screen. StoreKit via RevenueCat.` |

### 10.3 Yearly subscription

| Field                       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product ID                  | `VERIFY:` first. `AGENTS.md` records that the yearly product is "the yearly successor of `pickle_sensei_pro_annual`", meaning the original ID was created and then removed (ASC never lets you reuse a deleted product ID). Look in the Pickle Sensei Pro group: **if a yearly product already exists there, use it as-is and confirm its ID is the one mapped to the `$rc_annual` package in RevenueCat.** If none exists, `ENTER:` `pickle_sensei_pro_yearly` and map that ID to the Annual package in RevenueCat. The app itself never references product IDs, only package types, so either ID works once RevenueCat points at it. |
| Reference Name              | `ENTER:` `Pickle Sensei Pro Yearly`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Subscription Duration       | `SELECT:` 1 year                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Group level                 | `SELECT:` Level 1 (same as monthly)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Availability                | `SELECT:` all countries/regions where the app is available                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Subscription Price          | `SELECT:` USD **59.99**, base United States, auto-generate other storefronts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Introductory / promo offers | `SKIP:`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Family Sharing              | `SELECT:` Off                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Localization (English U.S.) | Display Name `ENTER:` `Pro Yearly` · Description `ENTER:` `Unlimited validated ratings, billed yearly`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Review Screenshot           | `UPLOAD:` paywall pricing-page screenshot with the Yearly ("BEST VALUE") column visible                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Review Notes                | `ENTER:` `Yearly plan on the in-app paywall (Settings > Membership > Pickle Sensei Pro, or the Coach button after the two free ratings). Auto-renews yearly; the paywall shows the per-month equivalent, Restore purchases, Terms, and Privacy links. StoreKit via RevenueCat.`                                                                                                                                                                                                                                                                                                                                                        |

### 10.4 Group-level settings

| Field                   | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Billing Grace Period    | Subscriptions page → Set Up Billing Grace Period. `SELECT:` **16 days**; renewal types **All Renewals**; environments **Production and Sandbox Environment** (Apple offers 3, 16 or 28 days; Only Paid to Paid Renewals; Only Sandbox). RevenueCat honors grace periods and the server re-verifies on every sync, so a card hiccup does not lock a paying player out. Apple's recommended path is sandbox first, then production; both boxes at once is acceptable when the client already treats a grace-period entitlement as active, which RevenueCat's entitlement state does. |
| Streamlined purchasing  | If the toggle is shown, leave it on (default).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Subscription Status URL | Same as App Store Server Notifications (§3.2); already covered.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Submission              | Add both subscriptions to the 1.0 version under **In-App Purchases and Subscriptions** (§11.6). Subscription group localizations are reviewed together with the first submission.                                                                                                                                                                                                                                                                                                                                                                                                  |

### 10.5 What the paywall already does (so you can answer reviewer questions)

`PaywallScreen.tsx` shows, for the selected plan: title, duration, store price,
"auto-renews, cancel anytime" or "one-time, no renewal", a **Restore
purchases** button, a trust line ("Purchase and renewal are confirmed by your
app store"), the legal sentence ("$X per month, automatically renewing until
canceled"), and **Terms** / **Privacy** links (wired in `RootNavigator.tsx`).
Settings → About also links both documents. This satisfies 3.1.2(c) inside the
app; the description in §11.4 satisfies it in metadata.

## 11. iOS App → 1.0 Prepare for Submission (the version page)

Path: sidebar → iOS App → **1.0 Prepare for Submission**.

### 11.1 App Previews and Screenshots

| Field               | Value                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iPhone 6.9" Display | `UPLOAD:` 3 to 8 PNG/JPG images at **1320 × 2868** (or 1290 × 2796 / 1260 × 2736) portrait, RGB, flattened (no transparency), device frames optional. Order per Appendix C. This is the only mandatory iPhone size; Apple auto-scales to 6.5", 6.3", 6.1", and smaller. Upload them BEFORE clicking Add for Review: images and videos are locked once the version is Ready for Review, Waiting for Review or In Review. |
| Other iPhone sizes  | `SKIP:` unless the scaled previews look wrong in Media Manager → View All Sizes.                                                                                                                                                                                                                                                                                                                                        |
| iPad                | `SKIP:` the app is iPhone-only (`TARGETED_DEVICE_FAMILY = 1`); ASC will not ask.                                                                                                                                                                                                                                                                                                                                        |
| App Preview (video) | `SKIP:` for 1.0 (optional; 15 to 30 s, 886 × 1920 for 6.9"). Nice to add later using real capture footage.                                                                                                                                                                                                                                                                                                              |

### 11.2 Promotional Text (170 max, editable any time without a new build)

`ENTER:` (164 chars)

```
Prop up your iPhone, hit one stroke, and get a scored form review with one clear fix. Two validated ratings are free, and unscored attempts never count against you.
```

### 11.3 Keywords (100 max, comma-separated, no spaces)

`ENTER:` (100 bytes, every keyword longer than two characters)

```
stroke,swing,analysis,form,drills,serve,dink,drive,drop,volley,video,training,paddle,lesson,ball,fix
```

Notes: Apple's field rule is "One or more keywords (each greater than two
characters) ... up to 100 bytes"; a two-letter keyword such as "ai" is
rejected, so it is not used. "pickleball", "technique", "coach", "pickle", and
"sensei" are already indexed from the name and subtitle, so they are
deliberately absent. No competitor or trademark terms (no SwingVision, PB
Vision, DUPR, Selkirk, JOOLA): Apple states "Names of other apps or companies
aren't allowed."

### 11.4 Description (4000 max)

`ENTER:` (3476 chars; paste verbatim, including the blank lines)

```
Pickle Sensei is a private pickleball technique coach that lives on your iPhone. Prop the phone up at the court, hit one stroke, and get an honest, evidence-backed read of your form with one clear thing to fix next.

HOW IT WORKS
1. Set the phone. Prop it side-on at waist height. A translucent outline on the live camera shows where to stand.
2. Tap record and swing. Body-pose tracking runs on the phone, catches your stroke wherever you stand, and stops the clip on its own. No shot picker, no timer.
3. Get the read. A validated analysis returns a technique score out of 10, checkpoint scores from 0 to 100, and coaching that follows the evidence.

WHAT YOU GET
• Auto Analyze: guided automatic capture with a live skeleton overlay and a motion heat map.
• Form Review: slow-motion replay of your own clip with the skeleton drawn over it. It pauses at each key phase and gives you a coaching cue at every stop.
• What to fix: a priority list of measured faults, the cue that addresses each one, and the checkpoints you already do well.
• Practice sets: analyze the same stroke again in the same session and watch the change attempt by attempt.
• Player rank: climb from Bronze through Silver, Gold, and Platinum to Diamond on scores from real, server-accepted analyses.
• Progress: score trends per stroke, practice volume, active days, and personal bests.
• Streaks and achievements: a day counts only when you actually train.
• Drill library: 40+ guided drills for dinks, drives, third-shot drops, serves, volleys, and footwork, with attributed coaching videos from pickleball creators. Save the drills the app prescribes.
• Import video: analyze a stroke clip you already have on this phone.
• Reminders: optional practice reminders that never show names or scores on your lock screen.

Strokes covered: serve, return, forehand and backhand drives, dinks, third-shot drops, volleys, resets, speedups, and overheads.

HONEST BY DESIGN
Pickle Sensei never invents a score. If the camera did not see enough of the stroke, the app says so and the attempt does not count against you. Technique scores are computer-generated coaching estimates, not an official player rating.

PRIVATE BY DEFAULT
Video and pose tracking are processed on your device. Clips stay in the app's private storage on your phone and are never uploaded. Only your account, coaching profile, analysis results, and membership status sync to your account so your rank and history follow you. You can permanently delete your account and all synced data from Settings at any time.

FREE AND PRO
Every account includes two free validated ratings. Only a successful score uses one.

Pickle Sensei Pro unlocks unlimited validated ratings:
• Monthly: $7.99 per month, auto-renews
• Yearly: $59.99 per year, auto-renews
• Lifetime: $159.99 one-time purchase, no renewal
US pricing. Your local price is shown in the app before you buy.

Subscription payment is charged to your Apple Account at confirmation of purchase. Subscriptions renew automatically unless canceled at least 24 hours before the end of the current period. Manage or cancel any time in your Apple Account settings.

Terms of Use: https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api/terms
Privacy Policy: https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api/privacy

REQUIREMENTS
Designed for iPhone and uses the rear camera. Sign in with Apple or Google keeps your ratings and progress tied to you.

Questions or feedback: picklesenseidev@gmail.com
```

Every feature named above exists in the 1.0 binary: Auto Analyze
(`GuidedCaptureViewController.swift`), Form Review (`FormReviewScreen.tsx`),
What to fix (`FixList.tsx`), practice sets (`practiceSet.ts`), player rank
(`playerRank.ts`), progress dashboard (`ProgressScreen.tsx`), consistency
engine (`src/consistency`), drill library (41 drills in `drills.ts`, attributed
videos in `drillMedia.ts`), import video (`importStrokeVideo`), reminders
(`src/notifications`). Selectable strokes come from
`SELECTABLE_TECHNIQUES_V1`.

### 11.5 URLs, version, copyright

| Field                     | Value                                                                                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Support URL               | `ENTER:` `https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api/support`                                                                                                     |
| Marketing URL             | `SKIP:` until the marketing site exists; then the site root.                                                                                                                     |
| Version                   | `ENTER:` `1.0` (must equal `MARKETING_VERSION` in the uploaded build)                                                                                                            |
| Copyright                 | `ENTER:` `2026 <legal name exactly as it appears on your Apple Developer Program membership>` (e.g. `2026 Raunak Gengiti`). `HUMAN:` confirm the legal name. No © symbol needed. |
| Routing App Coverage File | `SKIP:` (navigation apps only)                                                                                                                                                   |

### 11.6 In-App Purchases and Subscriptions (attach to this version)

`SELECT:` add all three: `pickle_sensei_pro_monthly`, the yearly product
(§10.3), `pickle_sensei_pro_lifetime`. They must be in "Ready to Submit" state
(all metadata, price, and review screenshot present). They get reviewed with
the binary and go live with it.

### 11.7 Build

`SELECT:` the processed 1.0 build uploaded by `fastlane ios release` (highest
build number). If ASC asks the export-compliance question here, something
stripped the plist key; answer: uses encryption → Yes; exempt (standard HTTPS
only, no proprietary crypto) → Yes.

### 11.8 App Review Information

| Field                                | Value                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-In required                     | `SELECT:` **Yes** (the app cannot be used without an account). Apple's field help: "If your app uses a single sign-on service, such as Facebook or Twitter, include the demo account login information for it. The demo account is used during the App Review process and must not expire."                                                       |
| User name                            | `HUMAN:` the dedicated Google review account email from §2.8. Fallback if no Google account can be prepared: `ENTER:` `Use "Continue with Apple" with any Apple ID` here and `not-required` in Password, and keep the Sign in with Apple paragraph in the notes. Apple accepts this for SSO-only apps, but a real credential is the safer choice. |
| Password                             | `HUMAN:` its password (ASCII only; copy exactly).                                                                                                                                                                                                                                                                                                 |
| Contact Information: First/Last name | `HUMAN:`                                                                                                                                                                                                                                                                                                                                          |
| Contact Information: Phone           | `HUMAN:` a number that is answered during U.S. business hours (App Review does call). Apple requires "international format, including a plus sign (+) followed by the country code" (for example `+1 555 123 4567`); a digits-only entry is refused.                                                                                              |
| Contact Information: Email           | `ENTER:` `picklesenseidev@gmail.com` (monitored)                                                                                                                                                                                                                                                                                                  |
| Notes (4000 max)                     | `ENTER:` the full text in **Appendix D** after replacing `SAMPLE_CLIP_URL`.                                                                                                                                                                                                                                                                       |
| Attachment                           | `UPLOAD:` the screen recording from §2.7 (sign-in → capture → result → paywall → account deletion path). Optional but it shortens review of a camera-dependent app.                                                                                                                                                                               |

### 11.9 Version Release

`SELECT:` **Manually release this version**. Approval can land at any hour;
releasing by hand lets you confirm the backend, RevenueCat production
entitlements, and the Support URL are live first. Phased release is not offered
for a first version.

### 11.10 Content Rights and Advertising Identifier (if shown during submission)

| Question                                             | Answer                                                                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Content rights (if asked again here)                 | Same as §3.2: Yes, third-party content, rights confirmed.                                                                             |
| Does this app use the Advertising Identifier (IDFA)? | `SELECT:` **No**. No ad SDK, RevenueCat does not read IDFA unless `collectDeviceIdentifiers()` is called, and the app never calls it. |
| Export compliance                                    | Skipped automatically because of `ITSAppUsesNonExemptEncryption = false`. See §11.7 if it appears.                                    |

### 11.11 Submit for Review

Only after every `HUMAN:` item in §2 is done and the version page shows no
red warnings: **Add for Review → Submit to App Review**. Expected review time
is one to three days for a new app; a reply in Resolution Center within 24
hours keeps the submission alive if they ask a question.

## 12. Growth & Marketing and Featuring (launch stance)

| Section                   | Action for 1.0                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In-App Events             | `SKIP:` (requires a live app; useful later for a "New season, new stroke" challenge card).                                                                                                                                                                                                                                                                                                                                                                                   |
| Custom Product Pages      | `SKIP:` at launch. Later: one page per stroke family (dinks, serves, drives) for ad campaigns.                                                                                                                                                                                                                                                                                                                                                                               |
| Product Page Optimization | `SKIP:` at launch (needs traffic to test icon/screenshot variants).                                                                                                                                                                                                                                                                                                                                                                                                          |
| Promo Codes               | After approval you may generate "up to 100 promo codes per version of each platform" for the app; each code "remains valid for four weeks from its generation date and can be used only once", and redeemers cannot rate or review. The same page offers codes for the non-consumable lifetime product; the two auto-renewable subscriptions are discounted through subscription offer codes instead (Monetization → Subscriptions). Use them for coaches and early testers. |
| Game Center               | `SKIP:` never enable; there is no Game Center integration in the binary.                                                                                                                                                                                                                                                                                                                                                                                                     |
| Nominations (Featuring)   | Optional after the build is approved: nominate as **App launch**. Story angle Apple editors respond to: on-device body-pose analysis with video that never leaves the phone, honest abstention instead of invented scores, and Sign in with Apple. Attach the same screenshots. Never claim accuracy figures.                                                                                                                                                                |

## 13. TestFlight (optional path before App Store review)

Internal testing (`bundle exec fastlane ios beta`) needs no review and no
metadata. If you ever invite **external** testers, ASC asks for Test
Information; use:

| Field                       | Value                                                                                                                                                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Beta App Description        | `ENTER:` `Pickle Sensei is a private pickleball technique coach. Prop up your iPhone, hit one stroke, and get a validated form review with one clear fix. Video stays on your phone. Please test camera capture on a real court.` |
| Feedback Email              | `ENTER:` `picklesenseidev@gmail.com`                                                                                                                                                                                              |
| Marketing URL               | `SKIP:`                                                                                                                                                                                                                           |
| Privacy Policy URL          | `ENTER:` `https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api/privacy`                                                                                                                                                      |
| Beta App Review Information | Same contact + sign-in details as §11.8; notes: Appendix D.                                                                                                                                                                       |
| Encryption                  | Answered by the plist key.                                                                                                                                                                                                        |

Reminder from `AGENTS.md`: the OS rating sheet never appears in TestFlight
builds by design, and purchases run in sandbox under the tester's own Apple
Account.

## 14. App Review risk register (guideline → status → what to say if asked)

| Guideline                                  | Status in 1.0                                                                                                                                                                   | Mitigation / reply                                                                                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 Completeness (reviewer cannot test)    | Camera flow needs a person swinging; sign-in is SSO only                                                                                                                        | Appendix D notes: Import Video path with `SAMPLE_CLIP_URL`, live camera instructions, Sign in with Apple works with any Apple ID, Google demo account provided, screen recording attached.                                               |
| 2.1 Crashes on iPad                        | iPhone-only app runs on iPad in compatibility mode; reviewers often test there                                                                                                  | Notes say "Designed for iPhone; installs on iPad in compatibility mode." Run the full flow once on an iPad simulator (compatibility mode) before submitting.                                                                             |
| 2.3.1 / 2.3.10 Accurate metadata           | Description lists only shipping features; no Android/Play/guest/Live Court mentions                                                                                             | Re-read §11.4 against the build before every resubmission.                                                                                                                                                                               |
| 2.3.7 Keywords                             | No competitor names or trademarks                                                                                                                                               | §11.3                                                                                                                                                                                                                                    |
| 2.5.4 Background modes                     | None declared                                                                                                                                                                   | n/a                                                                                                                                                                                                                                      |
| 3.1.1 IAP                                  | All digital unlocks go through StoreKit                                                                                                                                         | No external purchase links anywhere.                                                                                                                                                                                                     |
| 3.1.2(a) Subscription value                | Ongoing value = unlimited validated ratings, progress, drills                                                                                                                   | Paywall benefits list is verbatim shipping capability.                                                                                                                                                                                   |
| 3.1.2(c) Subscription info + legal links   | Title, duration, price, auto-renew sentence, Restore, Terms, Privacy on the paywall; Terms + Privacy URLs in the description; Privacy URL in App Information                    | Already in place; do not remove the URLs from §11.4.                                                                                                                                                                                     |
| 4.0 Design / 4.2 Minimum functionality     | Native camera, on-device ML, full product loop                                                                                                                                  | n/a                                                                                                                                                                                                                                      |
| 4.8 Login Services                         | Google Sign-In is offered, so Sign in with Apple is mandatory. It is offered, and the entitlement is declared.                                                                  | Verify the Supabase Apple provider is ON (§2.4) so it works in the review build.                                                                                                                                                         |
| 5.1.1(i)–(iv) Privacy policy + permissions | Policy URL in metadata and in-app; camera/photos strings explain use; microphone string is declared but never triggered                                                         | If asked about the microphone string: "the capture session is video only; the string exists for a future optional court-audio feature and is never requested in 1.0." Consider removing the key in 1.0.1 to avoid the question entirely. |
| 5.1.1(v) Account deletion                  | Settings → Account → Manage account → Delete account; two-step, server-verified, skippable exit survey; warns that store billing continues and links to subscription management | Appendix D describes the exact path. Complete Sign in with Apple token revocation and RevenueCat customer deletion from §2.5.                                                                                                            |
| 5.1.1(ix) Health/fitness data safeguards   | Analysis results are fitness data; stored per user with RLS; never used for ads                                                                                                 | Privacy label + policy already state no ads/tracking.                                                                                                                                                                                    |
| 5.1.2 Data use and sharing                 | Consent-gated telemetry off by default; RevenueCat is a processor                                                                                                               | Policy §1 and §4 describe both.                                                                                                                                                                                                          |
| 5.1.3 Health and health research           | Not HealthKit; no clinical claims                                                                                                                                               | n/a                                                                                                                                                                                                                                      |
| 5.2.1 Intellectual property                | YouTube embeds via official player with attribution; in-app "DUPR-style estimate" label                                                                                         | Content Rights = Yes (§3.2). Keep DUPR out of metadata; rename in-app label in a later build if challenged.                                                                                                                              |
| 5.6.1 Ratings prompt                       | `SKStoreReviewController` only; no custom nag                                                                                                                                   | n/a                                                                                                                                                                                                                                      |
| Sign in with Apple token revocation        | Implemented end-to-end: authorization-code exchange, encrypted refresh-token storage, revocation before account deletion (§2.5)                                                 | Verify all five Apple Edge Function secrets and test with a fresh Apple account before submission.                                                                                                                                       |
| RevenueCat customer deletion               | Implemented before Supabase deletion with the secret REST API key and retry checkpoint (§2.5)                                                                                   | Verify `REVENUECAT_SECRET_API_KEY` is a secret key; deleting a RevenueCat customer does not cancel Apple billing, so retain the subscription warning.                                                                                    |

## 15. After approval

1. Release manually (§11.9) once `/healthz` is green and RevenueCat shows the
   production App Store app connected with the In-App Purchase key.
2. Buy each product once with a real Apple Account on a TestFlight build first,
   then once on the App Store build; refund via Apple if needed. Confirm
   `public.billing_entitlements` flips `premium = true` and the webhook row
   lands in `public.webhook_events`.
3. Watch Ratings and Reviews and Resolution Center daily for the first week.
4. If `APP_STORE_ID` was not baked into 1.0, ship 1.0.1 with it so the Settings
   rating row deep-links correctly.
5. Update this file whenever the label, pricing, or data flows change. The
   privacy label can be edited without a new build; everything else needs a
   new version.

---

## Appendix A. Character counts (verified 2026-09-02)

| Field                   | Limit | Text                                        | Count  |
| ----------------------- | ----- | ------------------------------------------- | ------ |
| Name                    | 30    | Pickle Sensei                               | 13     |
| Name (alternative)      | 30    | Pickle Sensei: Stroke Coach                 | 27     |
| Subtitle                | 30    | Pickleball technique coach                  | 26     |
| Subtitle (alt 1)        | 30    | Private pickleball form coach               | 29     |
| Subtitle (alt 2)        | 30    | Film a stroke. Get the fix.                 | 27     |
| Keywords                | 100   | §11.3                                       | 100    |
| Promotional text        | 170   | §11.2                                       | 164    |
| Description             | 4000  | §11.4                                       | 3476   |
| Subscription group name | 30    | Pickle Sensei Pro                           | 17     |
| Monthly display name    | 30    | Pro Monthly                                 | 11     |
| Monthly description     | 45    | Unlimited validated ratings, billed monthly | 43     |
| Yearly display name     | 30    | Pro Yearly                                  | 10     |
| Yearly description      | 45    | Unlimited validated ratings, billed yearly  | 42     |
| Lifetime display name   | 30    | Pro Lifetime                                | 12     |
| Lifetime description    | 45    | Unlimited validated ratings, pay once       | 37     |
| Review notes            | 4000  | Appendix D                                  | < 4000 |

## Appendix B. `PrivacyInfo.xcprivacy` mirror of §5

The authoritative app-target manifest is
`apps/mobile/ios/PickleSensei/PrivacyInfo.xcprivacy`. It declares data collected
by Pickle Sensei and WebView partners that do not ship a separate manifest,
keeps `NSPrivacyTracking` false, and retains the required-reason API
declarations. Google Sign-In and RevenueCat supply their own manifests; Apple
combines all manifests into the archive privacy report. Do not duplicate their
provider-only Phone Number, Coarse Location, or Device ID entries in the app
target. The combined report and App Store Connect answers cover all fourteen
types in §5. Validate changes with `plutil -lint` and
`npm run check:distribution`.

## Appendix C. Screenshot shot list (6.9", 1320 × 2868, portrait)

Capture on an iPhone 16 Pro Max or 17 Pro Max (device or simulator), Release
build, signed in to an account with real analyses. Captions are optional
overlays you may render above the device frame; keep them in the brand voice
(sentence case, ends with a period, no superlatives).

| #   | Screen to capture                                                                                        | Caption (optional overlay)                          | Why                                                       |
| --- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------- |
| 1   | Result screen: score ring, checkpoint list with numbers and bands                                        | Your technique, scored honestly.                    | The hero; shows the product outcome first                 |
| 2   | Auto Analyze camera in `composing` state: silhouette outline, brackets, status card, shutter             | Match the outline. Tap record. Swing.               | Shows the capture flow and the private, on-device framing |
| 3   | Form Review: slow-motion frame with skeleton overlay, phase strip, coaching cue at a stop                | See the fix on your own swing.                      | Flagship replay                                           |
| 4   | Result "What to fix" list + recommended drills card                                                      | One clear next step, with the drill that trains it. | Coaching value                                            |
| 5   | Progress dashboard (dark): score trend chart, key statistics with ▲/▼ deltas                             | Progress you can measure.                           | Retention story                                           |
| 6   | Home with the Player Rank banner unfolded (tier ladder) and streak chip                                  | Climb from Bronze to Diamond.                       | Rank + consistency                                        |
| 7   | Drill Library list or a drill detail with an attributed video card                                       | Guided drills, with videos from real coaches.       | Library depth (mention attribution honestly)              |
| 8   | Settings → Privacy card ("Private by default", clips: app-private storage, cloud upload: not configured) | Your video never leaves your phone.                 | Privacy positioning (optional 8th shot)                   |

Do not include the paywall as a screenshot (allowed, but it wastes a slot; the
description already discloses pricing). Do not show sandbox banners, debug
overlays, or the Metro banner (Release scheme only).

## Appendix D. App Review notes (paste into §11.8 Notes; replace `SAMPLE_CLIP_URL`)

```
Thank you for reviewing Pickle Sensei, a pickleball technique coach for iPhone. Everything below applies to build 1.0.

SIGN-IN
There is no username/password login. Accounts are created with Sign in with Apple or Sign in with Google. The fastest path is "Continue with Apple" with any Apple ID; an account is created instantly. The Google account in the Sign-In fields above also works. Launch flow: Welcome > "Start your first read" > six short coaching-profile questions > a reminders step ("Not now" skips the notification prompt) > sign-in > Home.

FREE TIER AND PURCHASES
Every account includes 2 free validated ratings. Only a successfully scored analysis uses one; unscored attempts are returned. After both are used, the Coach button opens the paywall. Pickle Sensei Pro is sold as an auto-renewable monthly ($7.99) or yearly ($59.99) subscription, or a non-consumable lifetime purchase ($159.99), through StoreKit via RevenueCat. The paywall shows the plan title, duration, price, an auto-renewal sentence, Restore purchases, and Terms and Privacy links. Direct path to the paywall: Settings > Membership > Pickle Sensei Pro. Purchases during review run in Apple's sandbox.

HOW TO TEST STROKE ANALYSIS
Option A, Import Video (no swinging needed): on the test iPhone, open SAMPLE_CLIP_URL in Safari and save the clip to Photos. In the app tap the center Coach button > Import Video > choose the clip. Analysis runs on the device and opens the Result screen (technique score, checkpoints, What to fix, Form Review replay, recommended drills).
Option B, live camera: Coach > Auto Analyze > Open automatic camera. Allow camera access. Prop the phone in portrait about 8 to 12 feet away, side-on, at waist height. Tap the record button, step back until your whole body fits the translucent outline, and swing a paddle or mimic a forehand. The camera stops itself when a stroke is detected. You can also tap the stop button at any time: the strongest swing in the recording is analyzed (if there was none, the camera returns to the live preview with a notice; tap record to try again). While recording, the file rolls over silently every 50 seconds; nothing needs to be re-tapped.

CAMERA, PHOTOS, MICROPHONE
Capture is video only. Body-pose tracking uses Apple's Vision framework on the device. Clips are stored in the app's private container and are never uploaded; there is no cloud video feature. Photo access uses the system picker (PHPicker), so no library permission prompt appears. A microphone usage string is declared for a possible future court-audio option, but the 1.0 capture session adds no audio input and never requests microphone access.

ACCOUNT DELETION (Guideline 5.1.1(v))
Settings > Account > Manage account > Delete account. An optional one-question exit survey (Skip is always available) is followed by a two-step confirmation; the final button enables after a short pause. Deletion permanently removes the account and all server-side data.

DEVICE
Designed for iPhone in portrait. It installs on iPad in iPhone compatibility mode; the camera guide is tuned for iPhone rear cameras.

THIRD-PARTY CONTENT
The Drill Library shows attributed instructional videos from pickleball creators, played with the official YouTube embedded player; creator names appear with each video.

LEGAL
Privacy policy: https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api/privacy
Terms of use: https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api/terms
Support: picklesenseidev@gmail.com
```

## Appendix E. Reviewer-facing walkthrough of the app (for the agent's own understanding)

1. **Splash**: 5 s brand video, skippable after 1 s.
2. **Welcome**: "See the stroke. Know the fix." → "Start your first read" or
   "I already have an account".
3. **Onboarding** (cannot be skipped): name (optional), gender (optional),
   playing level, hitting hand, what to own, what breaks down, then a reminders
   step ("Turn on reminders" requests notification permission; "Not now" does
   not).
4. **Sign-in**: Continue with Apple / Continue with Google. Required.
5. **Tabs**: Home · Library · Coach (center) · Progress · Settings.
6. **Coach menu**: Auto Analyze · Import Video · Drill Library.
7. **Result**: technique score, checkpoints, Form Review card, What to fix,
   practice-set card, recommended drills, "Capture another".
8. **Paywall**: two pages (value → store-verified pricing), Restore purchases,
   Terms, Privacy.
9. **Settings**: Membership, Player, Reminders, Privacy (Data & consent),
   About (Rate, walkthrough, version, scoring model, Privacy policy, Terms),
   Account (Manage account → Delete account), Sign out.

## Appendix F. Sources

- Repo: `AGENTS.md`, `docs/DISTRIBUTION.md`, `docs/PRELAUNCH_CHECKLIST.md`,
  `docs/RELEASE_OPERATIONS.md`, `docs/CLAIM_REVIEW.md`,
  `apps/mobile/ios/PickleSensei/{Info.plist,PrivacyInfo.xcprivacy,PickleSensei.entitlements}`,
  `apps/mobile/src/config/runtimeConfig.ts`, `apps/mobile/src/screens/*.tsx`,
  `apps/mobile/src/account/*.ts`, `apps/mobile/src/billing/revenueCatClient.ts`,
  `supabase/functions/api/{index.ts,legal.ts,drillMedia.ts}`,
  `supabase/migrations/*.sql`, `apps/mobile/ios/Podfile.lock`.
- Apple: App Store Connect Help "Age ratings values and definitions" (2025
  system), "Set an app age rating", "Manage Accessibility Nutrition Labels",
  "Screenshot specifications" (6.9" required), "Manage European Union Digital
  Services Act trader requirements", "Offering account deletion in your app",
  App Review Guidelines 2.1, 2.3, 3.1.2, 4.8, 5.1.1, 5.6.1; "App privacy details
  on the App Store" (data types and purposes).
- RevenueCat docs: "Apple App Privacy" (Purchase History + User ID
  disclosures), "In-App Purchase Key Configuration", "Apple App Store Server
  Notifications".
