# Pickle Sensei Release Readiness

Verified September 3, 2026 in App Store Connect, Apple Developer, Supabase,
the signed archive, and the production repository.

## Current result

Version 1.0 build 3 is validated by Apple and attached to the App Store
version. All App Store Connect work that can be completed without image
uploads or third-party verification is complete. The version is not submitted
because Apple still requires review images that were intentionally excluded
from this production pass. Worldwide distribution also has the external legal
conditions listed below; App Store Connect cannot satisfy them on the
developer's behalf.

The App Store version is configured for manual release. Approval does not make
the app public until the Account Holder releases it.

## Completed production checks

1. Main is clean and synchronized with `origin/main`.

2. Build 3 was archived with the production App Store certificate and a valid
   App Store provisioning profile. Apple reports the binary as Validated. The
   build is iPhone only, arm64, version 1.0, minimum iOS 15.1, includes symbols,
   includes Sign in with Apple, and declares that it does not use nonexempt
   encryption. Its app-target privacy manifest includes the direct app and
   embedded-video declarations that support the published privacy label.

3. App Store metadata precheck passes every enabled rule, including public URL
   validation.

4. App Privacy is published with the fourteen data types required by the app
   and its embedded SDKs: Name, Email Address, Phone Number, Fitness, Coarse
   Location, Other User Content, Browsing History, User ID, Device ID, Purchase
   History, Product Interaction, Advertising Data, Other Usage Data, and Other
   Data Types. Purposes and identity-linkage answers reflect the Google Sign-In,
   RevenueCat, Supabase, and embedded-video data flows. The app-target and SDK
   privacy manifests collectively cover these practices. Tracking remains No
   because Pickle Sensei does not link this data across other companies' apps
   or websites for targeted advertising or share it with a data broker.

5. The production review form contains a monitored email, phone number, Sign in
   with Apple reviewer instructions, and current notes for onboarding,
   purchases, live capture, imported video, privacy, and account deletion.

6. The dedicated Support page, Privacy Policy, and Terms of Use are public and
   return HTTP 200 for both GET and HEAD requests. The Support page is both the
   App Store Support URL and User Privacy Choices URL. The optional App Store
   Marketing URL is blank because the current marketing site contains
   placeholder links.

7. Supabase has the production Apple revocation configuration, encryption key,
   RevenueCat secret API key, RevenueCat public SDK key, and RevenueCat webhook
   authentication secret. The Apple private key is stored outside the
   repository with owner only file permissions.

8. The production database migration for external account cleanup is applied.
   The production Edge Function is deployed. Health, support, privacy, terms,
   authentication rejection, and public URL validation were checked live.

9. Sign in with Apple and Sign in with Google are both enabled in the production
   Supabase authentication settings.

10. The free app price, $7.99 monthly subscription, $59.99 yearly subscription,
    and $159.99 lifetime purchase match the app and repository configuration.
    The monthly and yearly products are in the same subscription group.

11. Free Apps and Paid Apps agreements, banking, and the United States tax form
    are active. The app is selected for all 175 current App Store countries or
    regions, and automatic availability is enabled for future storefronts. The
    Digital Services Act declaration has been changed to trader, and the contact
    email has been verified. The address identification document was submitted
    on September 3, 2026, and Apple reports the trader verification as In Review.

12. Sports is the sole App Store category. The optional Health & Fitness
    secondary category was removed because the product is a sport-specific
    pickleball technique coach, not a health, wellness, or medical app. The
    existing regulated-medical-device declaration truthfully remains No.

13. The release checks passed: workspace lint and type checks, 247 mobile test
    suites with 2,872 tests, 119 backend Edge Function tests, 56 native vision
    tests, CocoaPods installation, the distribution configuration check, signed
    archive export, Apple upload, and App Store metadata precheck.

## Required before submission

1. Wait for Apple to approve the Digital Services Act trader verification, then
   confirm its status is Active before releasing in European Union storefronts.
   No further action is available while Apple reports the submission as In
   Review.

2. Upload at least one App Store screenshot in the iPhone 6.5 inch screenshot
   section. App Store Connect currently shows zero screenshots.

3. Upload one review screenshot to `pickle_sensei_pro_monthly`.

4. Upload one review screenshot to `pickle_sensei_pro_yearly`.

5. Upload one review screenshot to `pickle_sensei_pro_lifetime`.

After those uploads, add the two subscriptions and the lifetime purchase for
review, add version 1.0 for review, inspect the final submission summary, and
submit it to App Review. Do not replace build 3 unless a newer binary is built
and validated.

## External conditions for worldwide release

These items cannot be completed truthfully inside App Store Connect and are not
legal advice. They require a qualified professional or an appointed provider.

1. Before actively offering the service in the European Union, appoint an EU
   GDPR Article 27 representative and add the representative's real contact
   details to the Privacy Policy, unless qualified EU privacy counsel gives a
   written conclusion that the narrow occasional-processing exemption applies.
   Account, purchase, and synced coaching processing are ordinary recurring
   parts of the service, so the exemption should not be assumed.

2. Before actively offering the service in the United Kingdom, appoint a UK
   GDPR representative and add its real contact details to the Privacy Policy,
   unless qualified UK privacy counsel confirms the corresponding exemption.

3. Obtain a written mainland-China distribution assessment. Apple currently
   marks China mainland Available on App Release, and Pickle Sensei is not a
   game, news, religious-content, book, or magazine app. Apple nevertheless
   states that some apps require a valid ICP Filing Number. Do not invent or
   enter a filing number; add one only after a Chinese filing professional
   confirms that it is required and obtains the valid record.

4. Have U.S. counsel or a qualified export professional confirm the consumer
   app's worldwide sanctions and export posture. App Store export compliance is
   already answered as no nonexempt encryption, but that answer is not a
   substitute for a developer's own sanctions obligations.

5. Have licensed counsel review the final Privacy Policy and Terms for the
   intended launch markets. The documents contain the real operator, address,
   California governing law, San Diego forum, purchase terms, privacy rights,
   retention rules, account deletion, safety limits, and mandatory-consumer-law
   carve-outs, but no document can prevent all claims or replace local advice in
   175 jurisdictions.

Apple controls review timing. A submission date cannot guarantee approval or
public release on the following day.

## Recommended final smoke test

Install build 3 on a physical iPhone and follow the What to Test instructions
saved with the build. Confirm Sign in with Apple, onboarding, live recording,
Stop and Analyze, Import Video, paywall prices, Restore Purchases, and account
deletion. Confirm that an unscored attempt does not use a free rating and that
camera video remains on the device.

## Apple references

1. Submit an app:
   https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-app

2. Screenshot specifications:
   https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications

3. Platform version and review information:
   https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information

4. Account deletion requirements:
   https://developer.apple.com/support/offering-account-deletion-in-your-app/

5. Digital Services Act trader requirements:
   https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-european-union-digital-services-act-trader-requirements/
