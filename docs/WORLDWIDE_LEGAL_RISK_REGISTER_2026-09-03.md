# Pickle Sensei Worldwide Legal Risk Register

Verified September 3, 2026. This is an engineering and App Store compliance
record, not legal advice or a guarantee against claims.

## Production controls already in place

1. The app, both subscriptions, and the lifetime purchase cover all 175 current
   App Store countries or regions. Every app storefront is marked Available on
   App Release, and future storefront availability is enabled.

2. The Free Apps and Paid Apps agreements, U.S. W-9, and payout bank account are
   Active. The app is free, with StoreKit prices of $7.99 monthly, $59.99 yearly,
   and $159.99 lifetime in the United States; Apple localizes other currencies.

3. The published App Privacy answers cover all fourteen verified app, SDK, and
   embedded-video data types. No data type is used for tracking. The app-target
   and provider SDK privacy manifests collectively cover those practices.

4. The Privacy Policy and Terms identify Raunak Gengiti as the individual
   operator, list the real San Diego address and support email, select
   California law and a San Diego forum subject to mandatory consumer rights,
   disclose purchases and renewals, and explain privacy rights, retention,
   safety, automated scoring, account deletion, Apple revocation, and RevenueCat
   deletion.

5. Raw court video, audio, camera frames, and pose landmarks remain on the
   device. The backend uses row-level security, scoped service writes, encrypted
   Apple revocation material, authenticated deletion, request limits, and
   short-lived security caches.

## Conditions that must be resolved outside App Store Connect

1. European Union privacy representative. A controller outside the EU that
   offers services to people in the EU generally must designate an Article 27
   representative. The exemption is narrow and depends on processing being
   occasional, low risk, and not large-scale special-category processing.
   Pickle Sensei regularly processes accounts, purchases, and synced coaching
   records, so the exemption must not be assumed. Appoint a representative or
   obtain a written exemption opinion, then publish the representative's name
   and contact details in the Privacy Policy.

2. United Kingdom privacy representative. The UK has a corresponding rule for
   non-UK organisations offering goods or services to people in the UK. Appoint
   a UK representative or obtain a written exemption opinion, then publish the
   representative's contact details.

3. European Union DSA status. Apple has the truthful Trader declaration,
   verified email, real address, phone, and submitted address evidence. The
   current status is In Review for 27 countries or regions. Do not release in EU
   storefronts until Apple shows Active.

4. Mainland China. Apple currently shows Available on App Release. Pickle
   Sensei is not a game, news, religious-content, book, or magazine app. Apple
   still states that some apps require a valid ICP Filing Number. Obtain a
   written assessment from a qualified mainland-China filing professional. If a
   filing is required, obtain and enter the real number before release; never
   use a guessed number.

5. Sanctions and export controls. App Store Connect records no nonexempt
   encryption, and Apple's storefront list excludes several comprehensively
   restricted markets. A U.S. developer nevertheless remains responsible for
   applicable sanctions and export rules. Obtain a written consumer-software
   assessment before worldwide release.

6. Minors. The product is not directed to children under 13, is not in the Kids
   category, and the Terms require a parent or guardian where a minor cannot
   contract. Do not market to children or add child-directed features without a
   new privacy, age-assurance, and parental-consent review.

7. Recording consent. The Terms require permission from every person visible or
   audible in a clip and prohibit recording where someone reasonably expects
   privacy. Marketing and support must not encourage covert recording. Local
   recording-consent rules still apply to each user.

8. Accessibility and consumer law. Mandatory local consumer rights override the
   Terms. Before claiming any App Store accessibility label, complete the
   feature-specific device testing in `docs/APP_STORE_SUBMISSION.md`. Ask counsel
   to confirm whether any microenterprise exemption applies before relying on it.

## Submission blockers unrelated to legal drafting

1. Apple must complete DSA verification.

2. The App Store version needs at least one required iPhone screenshot.

3. Monthly, yearly, and lifetime products each need an App Review screenshot.

4. After those uploads, add the app and all three purchase products to the same
   draft submission, inspect the final summary, and submit for review.

## Primary references

1. Apple App Privacy details:
   https://developer.apple.com/app-store/app-privacy-details/

2. Apple worldwide availability:
   https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/manage-availability-for-your-app-on-the-app-store

3. Apple mainland-China requirements:
   https://developer.apple.com/help/app-store-connect/reference/app-information/app-information

4. GDPR Article 27 text:
   https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679

5. EDPB territorial-scope guidance:
   https://www.edpb.europa.eu/sites/default/files/files/file1/edpb_guidelines_3_2018_territorial_scope_after_public_consultation_en_1.pdf

6. UK ICO guidance for non-UK organisations:
   https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/international-transfers/receiving-personal-information-from-the-eea/

7. RevenueCat Apple privacy guidance:
   https://www.revenuecat.com/docs/platform-resources/apple-platform-resources/apple-app-privacy
