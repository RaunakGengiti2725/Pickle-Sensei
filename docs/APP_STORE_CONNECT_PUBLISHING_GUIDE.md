# Publishing an iOS app through App Store Connect: the verified process reference

Researched 2026-09-02 against Apple's own pages: App Store Connect Help (every
page in the "Create an app record", "Manage app information", "Manage
submissions", "Manage your app's availability", "Manage app pricing", "Manage
subscriptions", "Manage In-App Purchases", "Test a beta version", "Manage
agreements", "Manage compliance information" and "Reference" chapters that
apply to an iPhone app with in-app purchases), the App Review Guidelines, the
App Review distribution page, the "Offering account deletion in your app"
support page, the App Store privacy details page, and the Upcoming Requirements
page. Every section lists the Apple URL it was checked against. Where Apple's
page states a number or a rule, this file quotes it; where a fact could not be
confirmed on an Apple page, it says so.

This file explains how App Store Connect works and what Apple requires at each
step. The app-specific values to type into each field live in
`docs/APP_STORE_SUBMISSION.md` (the dossier). Use both together: this file for
"what is this screen, what are the rules, what happens next", the dossier for
"what exactly do I enter for Pickle Sensei".

---

## 1. The whole process in order

Apple's own outline is short: accept the agreement and enter tax and banking
information, add users, create the app record and upload a build, test with
TestFlight, submit, then monitor status and sales.
(<https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-workflow>)
Apple's publishing overview adds: choose your build, set pricing and
availability, complete metadata and pick a release option, watch the status and
reply to App Review, request promo codes after approval, and expect up to 24
hours for the app to go live after approval.
(<https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/overview-of-publishing-your-app-on-the-app-store>)

For a first release of a free iPhone app that sells auto-renewable
subscriptions and a non-consumable, the dependency order is:

| #   | Step                                                                                                                                                                      | Where                                                   | Who (role)                                                          | Blocks                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | Apple Developer Program membership active; two-factor authentication on the Apple Account                                                                                 | developer.apple.com                                     | Account Holder                                                      | Signing in to App Store Connect at all             |
| 2   | Accept the latest Apple Developer Program License Agreement                                                                                                               | developer.apple.com → Agreements                        | Account Holder                                                      | Creating apps, Xcode signing, TestFlight, API      |
| 3   | Sign the Paid Apps Agreement                                                                                                                                              | ASC → Business → Agreements                             | Account Holder only                                                 | Creating in-app purchases, IAPs loading in sandbox |
| 4   | Submit tax forms (US W-9 for a US person or entity; others per country), then banking                                                                                     | ASC → Business → Agreements → Tax Forms / Bank Accounts | Account Holder, Admin, Finance (Account Holder approves banking)    | Agreement becoming Active; getting paid            |
| 5   | Declare EU Digital Services Act trader status                                                                                                                             | ASC → Business → Agreements → Compliance                | Account Holder or Admin                                             | First submission asks for it; EU availability      |
| 6   | Generate an App Store Connect API key (optional, for fastlane) and an In-App Purchase key (required for StoreKit 2 server validation, e.g. RevenueCat)                    | ASC → Users and Access → Integrations                   | Account Holder or Admin                                             | Automated uploads; server-side purchase validation |
| 7   | Create Sandbox Apple Accounts                                                                                                                                             | ASC → Users and Access → Sandbox                        | Account Holder, Admin, App Manager, Developer                       | Testing purchases on device                        |
| 8   | Create the app record (name, primary language, bundle ID, SKU, user access)                                                                                               | ASC → Apps → +                                          | Account Holder, Admin, App Manager                                  | Uploading any build                                |
| 9   | Fill App Information: subtitle, categories, content rights, age rating, privacy policy URL, EULA choice, server notification URLs, medical device declaration if required | ASC → app → General → App Information                   | Account Holder, Admin, App Manager (Marketing for some)             | Submission                                         |
| 10  | Complete App Privacy (data types, purposes, linked, tracking) and publish                                                                                                 | ASC → app → App Privacy                                 | Account Holder, Admin, App Manager                                  | Submission                                         |
| 11  | Set Pricing (Free) and Availability (countries), tax category, Mac and Vision Pro availability                                                                            | ASC → app → Pricing and Availability                    | Account Holder, Admin, App Manager                                  | Submission                                         |
| 12  | Create the subscription group, both subscriptions, the non-consumable; prices, availability, localizations, review screenshots; billing grace period                      | ASC → app → Monetization                                | Account Holder, Admin, App Manager (Developer/Marketing can create) | Attaching IAPs to the version                      |
| 13  | Build with Xcode 26 or later, upload the build, wait for processing                                                                                                       | Xcode / Transporter / fastlane                          | Account Holder, Admin, App Manager, Developer                       | Choosing a build                                   |
| 14  | (Optional) TestFlight internal testing; external testing needs Beta App Review                                                                                            | ASC → app → TestFlight                                  | per role                                                            | Nothing; recommended                               |
| 15  | Fill the version page: screenshots, promotional text, description, keywords, support URL, version, copyright, build, App Review information, release option               | ASC → app → iOS App → 1.0                               | Account Holder, Admin, App Manager (Marketing for text)             | Add for Review                                     |
| 16  | Add for Review → add the three IAPs and the subscription group to the same submission → Submit for Review                                                                 | Version page / App Review                               | Account Holder, Admin, App Manager                                  | Review                                             |
| 17  | Answer App Review messages within the submission; fix and resubmit if rejected                                                                                            | ASC → app → App Review                                  | Account Holder, Admin, App Manager                                  | Approval                                           |
| 18  | Release (manually or automatically); allow up to 24 hours to appear                                                                                                       | Version page                                            | Account Holder, Admin, App Manager                                  | Live                                               |
| 19  | After approval: promo codes, nominations, respond to reviews, watch Sales and Trends and Payments                                                                         | ASC                                                     | per role                                                            |                                                    |

Two Apple rules shape this order. You cannot add an app until the Account
Holder has signed the latest agreement in Business
(<https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app>),
and the first in-app purchase of each type must be submitted together with a
new app version
(<https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-in-app-purchase>).

---

## 2. Account level: membership, roles, agreements, tax, banking, compliance

### 2.1 Membership and sign-in

- Apple Developer Program membership costs 99 USD per year. Individuals enroll
  under their legal name, which becomes the seller name; organizations need a
  D-U-N-S number and a legal entity that can sign contracts.
  (<https://developer.apple.com/programs/whats-included/>,
  <https://developer.apple.com/help/account/membership/program-enrollment/>)
- "You must enable two-step verification or two-factor authentication to sign
  into App Store Connect."
  (<https://developer.apple.com/help/app-store-connect/manage-your-team/overview-of-accounts-and-roles>)
- Only the Account Holder can "sign legal agreements, renew membership, request
  access to the App Store Connect API, remove auto-renewable subscriptions from
  sale, submit Safari Extensions, or create developer ID certificates."
  (<https://developer.apple.com/help/app-store-connect/reference/account-management/role-permissions>)
- Individuals can add up to 50 App Store Connect users; organizations have no
  limit.
  (<https://developer.apple.com/help/app-store-connect/manage-your-team/overview-of-accounts-and-roles>)

### 2.2 Roles and which role each task needs

Roles: Account Holder, Admin, Finance, App Manager, Developer, Marketing,
Sales, Customer Support. Admin and Finance always see every app; other roles
can be limited to specific apps.
(<https://developer.apple.com/help/app-store-connect/reference/account-management/role-permissions>)

Required roles quoted from the individual help pages:

| Task                                        | Roles allowed                                                         |
| ------------------------------------------- | --------------------------------------------------------------------- |
| Sign the Paid Apps Agreement                | Account Holder                                                        |
| Enter banking / tax                         | Account Holder, Admin, Finance (Account Holder approves bank changes) |
| Declare DSA trader status                   | Account Holder, Admin                                                 |
| Generate In-App Purchase keys               | Account Holder, Admin                                                 |
| Add a new app                               | Account Holder, Admin, App Manager                                    |
| Edit app information / version metadata     | Account Holder, Admin, App Manager, Marketing                         |
| Set age rating                              | Account Holder, Admin, App Manager, Marketing                         |
| Manage App Privacy answers                  | Account Holder, Admin, App Manager                                    |
| Enter privacy policy URL                    | Account Holder, Admin, App Manager, Marketing                         |
| Manage Accessibility Nutrition Labels       | Account Holder, Admin, Finance, App Manager, Marketing                |
| Set a price, availability, release option   | Account Holder, Admin, App Manager                                    |
| Upload builds                               | Account Holder, Admin, App Manager, Developer                         |
| Create in-app purchases and subscriptions   | Account Holder, Admin, App Manager, Developer, Marketing              |
| Set IAP prices                              | Account Holder, Admin, App Manager                                    |
| Turn on Family Sharing                      | Account Holder, App Manager                                           |
| Enable Billing Grace Period                 | Account Holder, Admin, App Manager                                    |
| Create Sandbox Apple Accounts               | Account Holder, Admin, App Manager, Developer                         |
| Submit an app / IAP; reply to App Review    | Account Holder, Admin, App Manager                                    |
| Invite external TestFlight testers          | Account Holder, Admin, App Manager                                    |
| Respond to reviews                          | Account Holder, Admin, Customer Support                               |
| Request promo codes; nominate for featuring | Account Holder, Admin, App Manager, Marketing                         |

### 2.3 Paid Apps Agreement

- "To sell your apps on the App Store or offer In-App Purchases, the Account
  Holder must sign the Paid Apps Agreement." Path: Business → Agreements →
  Paid Apps → View and Agree to Terms. Accepting cannot be undone.
- "You won't be able to create a new app or In-App Purchase until you've agreed
  to the most recent version of the Paid Apps Agreement."
- "The agreement must be Active to test In-App Purchases in the sandbox
  environment."
  (<https://developer.apple.com/help/app-store-connect/manage-agreements/sign-and-update-agreements>,
  <https://developer.apple.com/help/app-store-connect/configure-in-app-purchase-settings/overview-for-configuring-in-app-purchases>)
- Agreement statuses and meanings: New (unsigned), Pending User Info (signed
  but required info missing), Processing, Verifying, Active, Active (Pending
  User), Active (New Agreement Available), Pending (New Legal Entity), Pending
  (Update Legal Entity), Pending (New Agreement Available), Expired, Disabled
  ("your app is removed from the App Store until you provide the required
  information").
  (<https://developer.apple.com/help/app-store-connect/manage-agreements/view-agreements-status>)

### 2.4 Tax forms

- "All developers must complete a US tax form to comply with the Paid Apps
  Agreement." US-based developers complete a W-9 (SSN or ITIN for an
  individual, EIN for a business). Non-US developers are guided to a W-8BEN,
  W-8BEN-E or W-8ECI. Australia, Brazil, Canada, Ireland, Mexico, Singapore,
  South Korea and others have additional forms.
- "Once you submit this information, you won't be able to make any changes in
  App Store Connect. For any corrections or additional tax forms, contact us."
  (<https://developer.apple.com/help/app-store-connect/manage-tax-information/provide-tax-information>)

### 2.5 Banking

- "In order to add banking information, you'll first need to sign a Paid Apps
  Agreement." "You must submit all required tax forms needed for your paid
  contract in order for us to process banking information."
- Enter the account holder name exactly as the bank has it. Only one bank
  account receives payments. Changes made by an Admin or Finance user must be
  approved by the Account Holder; approved changes process within 24 hours,
  unapproved changes lapse after 30 days.
  (<https://developer.apple.com/help/app-store-connect/manage-banking-information/enter-banking-information>)

### 2.6 EU Digital Services Act trader status

- "Even if you don't distribute apps in the EU, you'll still need to declare a
  trader status." ASC asks the next time you submit a new app.
- Trader signals Apple lists: making revenue from the app (in-app purchases,
  paid, ads), commercial practices, VAT registration, acting in a business
  capacity. "If you don't distribute apps on the App Store in the EU ... you're
  not acting as a trader on the App Store."
- Individuals who are traders provide an address or P.O. Box, phone number and
  email address; all are displayed on the EU product page. Organizations show
  their D-U-N-S address plus phone and email. Email and phone are verified with
  two-factor codes, and you upload a document proving name and address (and a
  bill or receipt for a P.O. Box).
- Path: Business → Agreements → Compliance → Digital Services Act → Complete
  Compliance Requirements → "This is a trader account" or "This is not a
  trader account". Per-app status can be changed later under App Information →
  App Store Regulations and Permits → Digital Services Act. An optional
  "Labels and Markings URL" can be added per app.
  (<https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-european-union-digital-services-act-trader-requirements>)
- Consequence of not declaring: since February 17, 2025 apps without trader
  status are removed from the EU storefronts until it is provided and
  verified. (<https://developer.apple.com/news/?id=6agg0lja>)

### 2.7 Users and Access → Integrations

- App Store Connect API keys sign JWTs with the Issuer ID, Key ID and the .p8
  private key; team keys are made by the Account Holder or Admin, individual
  keys inherit the user's role; the .p8 downloads once.
  (<https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api>)
- In-App Purchase keys "allow Apple to authenticate and validate
  client-to-server or server-to-server requests related to In-App Purchases,
  including App Store server APIs and promotional offers." Path: Users and
  Access → Integrations → Keys → In-App Purchase → Generate In-App Purchase
  Key. The key downloads only once; revoking is permanent.
  (<https://developer.apple.com/help/app-store-connect/configure-in-app-purchase-settings/generate-keys-for-in-app-purchases>)
- The Issuer ID shown at the top of the Integrations → Keys page is the value
  RevenueCat asks for next to the uploaded In-App Purchase key (RevenueCat's
  own doc: <https://www.revenuecat.com/docs/service-credentials/itunesconnect-app-specific-shared-secret/in-app-purchase-key-configuration>).

### 2.8 Sandbox Apple Accounts

- Created in Users and Access → Sandbox. Up to 10,000 accounts. The email
  "must not already be registered as an Apple Account"; plus-addressing
  (`name+us@icloud.com`) works. Name, email and password cannot be edited after
  creation. Each tester is tied to one of the 175 storefronts and can be moved.
- On device: "Sign in with a Sandbox account in the App Store on your test
  device. You don't need to sign out of your personal Apple Account at the
  device level." Developer Mode must be on for development-signed builds.
  (<https://developer.apple.com/help/app-store-connect/test-in-app-purchases/create-a-sandbox-apple-account>,
  <https://developer.apple.com/help/app-store-connect/test-in-app-purchases/overview-of-testing-in-sandbox>)
- Default sandbox renewal speed: 1 week = 3 min, 1 month = 5 min, 2 months =
  10 min, 3 months = 15 min, 6 months = 30 min, 1 year = 1 hour; billing retry
  10 min; "Subscriptions automatically renew up to 12 times before auto-renewal
  turns off on the thirteenth renewal attempt." The speed is adjustable per
  tester, and the settings page can also clear purchase history, simulate
  interrupted purchases and create test families.
  (<https://developer.apple.com/help/app-store-connect/test-in-app-purchases/manage-sandbox-apple-account-settings>)

---

## 3. The app record

- Path: Apps → + → New App. Fields: Platforms, Name, Primary Language, Bundle
  ID, SKU, User Access (Limited or Full).
  (<https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app>)
- Name: "at least two characters and no more than 30 characters", editable
  until you submit, then only with a new version. An app name can be used for
  one app per localization across the whole store; if another developer holds
  it and you own the trademark you can file a claim.
- Bundle ID: "You can't change this property after you upload a build" and it
  must match Xcode.
- SKU: letters, numbers, hyphens, periods, underscores; must not start with a
  hyphen, period or underscore; "You can't change the SKU after you add the app
  to your account."
- Apple ID: the numeric id Apple assigns; used in App Store URLs; read-only.
- Primary Language: fallback metadata language; changeable, but only to a
  language that already has approved metadata and screenshots.
  (<https://developer.apple.com/help/app-store-connect/reference/app-information/app-information>,
  <https://developer.apple.com/help/app-store-connect/manage-app-information/localize-app-information>)
- Developer name: individuals cannot change it (it is the legal name).
  Organizations may enter a registered trade name in the Company Name field
  only when adding their first app, and it can never be edited.
  (<https://developer.apple.com/help/app-store-connect/create-an-app-record/set-your-developer-name>)
- After creation the status is Prepare for Submission.

---

## 4. General → App Information

Properties shared across platforms and localizations. Source:
<https://developer.apple.com/help/app-store-connect/reference/app-information/app-information>
and the required/localizable/editable table at
<https://developer.apple.com/help/app-store-connect/reference/app-information/required-localizable-and-editable-properties/>.

| Field                                   | Rule                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name                                    | 2 to 30 characters, localizable                                                                                                                                                                                                                                                                                                                                     |
| Subtitle                                | up to 30 characters, localizable                                                                                                                                                                                                                                                                                                                                    |
| Privacy Policy URL                      | required for iOS; localizable; also editable from the App Privacy page. "Any changes to the URLs releases with your next app version."                                                                                                                                                                                                                              |
| User Privacy Choices URL                | optional: "a webpage where users can access their data, request deletion, or make changes"                                                                                                                                                                                                                                                                          |
| Primary and Secondary Category          | Subcategories exist only for Games and Stickers. Secondary is optional. Choosing Health & Fitness or Medical as primary OR secondary triggers the Regulated Medical Device declaration (below).                                                                                                                                                                     |
| Content Rights                          | "Apps that contain, show, or access third-party content must have all the necessary rights to that content or be otherwise permitted to use it under the laws of each App Store country or region in which they're available."                                                                                                                                      |
| Age Rating                              | required; set at the app level; see §5                                                                                                                                                                                                                                                                                                                              |
| License Agreement                       | Apple's standard EULA applies unless you paste a custom plain-text EULA for chosen regions ("All HTML tags are stripped"). With the standard EULA no license link is shown on the product page.                                                                                                                                                                     |
| URL for App Store Server Notifications  | visible only for apps with IAPs; Production and Sandbox URLs; Version 1 (deprecated) or Version 2. "If you do not provide a Sandbox URL ... the App Store will automatically send notifications for both environments to the Production URL."                                                                                                                       |
| App-Specific Shared Secret              | needed only for StoreKit 1 receipt validation; StoreKit 2 flows use the In-App Purchase key instead                                                                                                                                                                                                                                                                 |
| Regulated Medical Devices               | "Apps that are available in the EU/EEA, UK, or U.S., and have a primary or secondary category of Health & Fitness or Medical, or that have 'frequent' Medical or Treatment information listed in the age rating, are required to complete this declaration." A non-medical app answers No under App Store Regulations & Permits → Declare Regulated Medical Device. |
| Digital Services Act (DSA) status       | per-app trader toggle plus optional Labels and Markings URL                                                                                                                                                                                                                                                                                                         |
| Availability in Korea / China / Vietnam | region-specific permit fields that appear only when the criteria apply (GRAC rating number, ICP filing, game license)                                                                                                                                                                                                                                               |
| App Encryption Documentation            | the export compliance questionnaire lives here too (see §12.4)                                                                                                                                                                                                                                                                                                      |

Sources for the rows: license agreement
(<https://developer.apple.com/help/app-store-connect/manage-app-information/provide-a-custom-license-agreement>),
server notifications
(<https://developer.apple.com/help/app-store-connect/configure-in-app-purchase-settings/enter-server-urls-for-app-store-server-notifications>),
medical devices
(<https://developer.apple.com/help/app-store-connect/manage-app-information/declare-regulated-medical-device-status>),
privacy URLs
(<https://developer.apple.com/help/app-store-connect/reference/app-information/app-privacy>).

---

## 5. Age rating

- The questionnaire covers content descriptors, in-app controls and
  capabilities. Ratings under the current system are 4+, 9+, 13+, 16+ and 18+;
  region-specific ratings are generated for Australia, Brazil and Korea. "An
  Unrated app can't be published on the App Store."
- Steps: App Information → Age Ratings → Set Up Age Ratings → tick any in-app
  controls and capabilities → answer each content section (None / Infrequent /
  Frequent, or Yes / No for Gambling and Loot Boxes) → Additional Information
  shows the calculated rating → choose Not Applicable, Made for Kids, or
  Override to Higher Age Rating → optional Age Suitability URL → Save.
- Made for Kids is only offered for 4+ or 9+ results and "You can't change
  this selection once your app is approved by App Review."
- Override: "If your app has a EULA with minimum age requirements that exceed
  the rating that Apple calculated, you must override to a rating that adheres
  to the requirements." Otherwise the override is optional. The content
  descriptors still reflect the answers.
  (<https://developer.apple.com/help/app-store-connect/manage-app-information/set-an-app-age-rating/>)
- Categories Apple defines (paraphrased from the reference page): In-App
  Controls (Parental Controls, Age Assurance); Capabilities (Unrestricted Web
  Access, User-Generated Content, Social Media, Social Media Disabled for Users
  Under 13, Messaging and Chat, Advertising); Mature Themes (Profanity or Crude
  Humor, Horror/Fear Themes, Alcohol/Tobacco/Drug Use or References); Medical
  or Wellness (Medical or Treatment Information, Health or Wellness Topics,
  the latter defined as "self-care or lifestyle recommendations ... calorie
  tracking, dieting advice, or exercise recommendations"); Sexuality or Nudity
  (three levels); Violence (Cartoon or Fantasy, Realistic, Prolonged Graphic or
  Sadistic, Guns or Other Weapons); Chance-Based Activities (Gambling,
  Simulated Gambling, Contests, Loot Boxes).
- Rating outcomes: 4+ allows parental controls, age assurance, UGC, messaging,
  advertising and infrequent contests; 9+ adds infrequent profanity/horror,
  health and wellness topics, infrequent mature themes, infrequent cartoon
  violence or weapons, loot boxes; 13+ adds social media, frequent profanity or
  horror, infrequent alcohol/drug references, infrequent medical or treatment
  information, infrequent sexual content, frequent cartoon violence, infrequent
  realistic violence, frequent weapons, infrequent simulated gambling and
  frequent contests; 16+ adds unrestricted web access, frequent medical or
  treatment information and frequent mature themes; 18+ adds frequent
  alcohol/drug references, frequent sexual content, frequent realistic violence,
  gambling and frequent simulated gambling.
  (<https://developer.apple.com/help/app-store-connect/reference/age-ratings-values-and-definitions>)
- Deadlines: responses to the updated questions were required by January 31,
  2026; from September 2026 the social-media questions are required when
  submitting new apps or updates.
  (<https://developer.apple.com/news/?id=ks775ehf>,
  <https://developer.apple.com/news/?id=tlur8uvi>)

---

## 6. App Privacy (privacy nutrition label)

### 6.1 The screen

"You're required to provide a privacy policy URL for your iOS app platform ...
Offering a privacy choices URL is optional. Furthermore, if you're
distributing your app on the App Store, you're required to explain your data
handling practices in App Store Connect." Answers are app-level and must also
cover "third-party partners whose code you integrate into your app."
(<https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy>)

Apple's steps, verbatim in structure:

1. App Privacy → Get Started.
2. "Indicate whether you or your third-party partners collect data from your
   app." No → "No, we do not collect data from this app" → Save, done. Yes →
   "Yes, we collect data from this app" → Next.
3. "Select all of the data you or your third-party partners collect from this
   app and click Save."
4. "In the Data Types section, click each data type and answer the questions
   that follow" (purposes; linked to identity; used for tracking).
5. Save, check the Product Page Preview, click Publish, agree that the answers
   are accurate. "If your product page isn't live yet, your responses will be
   published once your product page goes live."

Later edits: Data Types → Edit to add or remove types, then Publish. Answers
can be changed at any time without a new build.

### 6.2 Definitions that decide the answers

From <https://developer.apple.com/app-store/app-privacy-details/>:

- Collect: "transmitting data off the device in a way that allows you and/or
  your third-party partners to access it for a period longer than what is
  necessary to service the transmitted request in real time." On-device
  processing is not collection.
- Linked to the user: data is linked unless direct identifiers are stripped
  before collection and you never re-link it. "'Personal Information' and
  'Personal Data', as defined under relevant privacy laws, are considered
  linked to the user."
- Tracking: linking app data about a user or device with third-party data for
  targeted advertising or ad measurement, or sharing it with a data broker.
  Login SDKs that repurpose data for advertising count as tracking.
- Optional disclosure applies only when all four hold: not used for tracking,
  not used for advertising/marketing/other purposes, collected only in
  infrequent optional cases outside the primary functionality, and entered by
  the user in a form that shows their name or account name each time.
  "Data collected on an ongoing basis after an initial request for permission
  must be disclosed."
- Payment info entered in Apple's purchase sheet is not collected by you and
  needs no disclosure.

### 6.3 Data types, purposes and manifest identifiers

| Category         | Data type (ASC label)                                                                                         | Privacy manifest string (`NSPrivacyCollectedDataType`)                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Contact Info     | Name, Email Address, Phone Number, Physical Address, Other User Contact Info                                  | `...Name`, `...EmailAddress`, `...PhoneNumber`, `...PhysicalAddress`, `...OtherUserContactInfo`                                   |
| Health & Fitness | Health, Fitness                                                                                               | `...Health`, `...Fitness`                                                                                                         |
| Financial Info   | Payment Info, Credit Info, Other Financial Info                                                               | `...PaymentInfo`, `...CreditInfo`, `...OtherFinancialInfo`                                                                        |
| Location         | Precise Location, Coarse Location                                                                             | `...PreciseLocation`, `...CoarseLocation`                                                                                         |
| Sensitive Info   | Sensitive Info                                                                                                | `...SensitiveInfo`                                                                                                                |
| Contacts         | Contacts                                                                                                      | `...Contacts`                                                                                                                     |
| User Content     | Emails or Text Messages, Photos or Videos, Audio Data, Gameplay Content, Customer Support, Other User Content | `...EmailsOrTextMessages`, `...PhotosorVideos`, `...AudioData`, `...GameplayContent`, `...CustomerSupport`, `...OtherUserContent` |
| Browsing History | Browsing History                                                                                              | `...BrowsingHistory`                                                                                                              |
| Search History   | Search History                                                                                                | `...SearchHistory`                                                                                                                |
| Identifiers      | User ID, Device ID                                                                                            | `...UserID`, `...DeviceID`                                                                                                        |
| Purchases        | Purchase History                                                                                              | `...PurchaseHistory`                                                                                                              |
| Usage Data       | Product Interaction, Advertising Data, Other Usage Data                                                       | `...ProductInteraction`, `...AdvertisingData`, `...OtherUsageData`                                                                |
| Diagnostics      | Crash Data, Performance Data, Other Diagnostic Data                                                           | `...CrashData`, `...PerformanceData`, `...OtherDiagnosticData`                                                                    |
| Surroundings     | Environment Scanning                                                                                          | `...EnvironmentScanning`                                                                                                          |
| Body             | Hands, Head                                                                                                   | `...Hands`, `...Head`                                                                                                             |
| Other Data       | Other Data Types                                                                                              | `...OtherDataTypes`                                                                                                               |

Purposes (ASC label / manifest string): Third-Party Advertising /
`NSPrivacyCollectedDataTypePurposeThirdPartyAdvertising`; Developer's
Advertising or Marketing / `...PurposeDeveloperAdvertising`; Analytics /
`...PurposeAnalytics`; Product Personalization /
`...PurposeProductPersonalization`; App Functionality /
`...PurposeAppFunctionality`; Other Purposes / `...PurposeOther`.
(<https://developer.apple.com/documentation/bundleresources/privacy_manifest_files/describing_data_use_in_privacy_manifests>)

Apple's example of purpose selection: "collecting an email address and using
it to authenticate the user and personalize the user's experience within your
app would include App Functionality and Product Personalization."

### 6.4 Third-party SDKs

You must declare what your SDKs collect. RevenueCat documents that apps using
it must declare Purchase History with both App Functionality and Analytics,
and User ID when a custom app user ID is used
(<https://www.revenuecat.com/docs/platform-resources/apple-platform-resources/apple-app-privacy>).
Google Sign-In returns the user's name and email to the app; declare them
under Contact Info as the app stores them.

### 6.5 Privacy manifest in the binary

`PrivacyInfo.xcprivacy` carries `NSPrivacyTracking`,
`NSPrivacyTrackingDomains`, `NSPrivacyCollectedDataTypes` (each entry: type,
`NSPrivacyCollectedDataTypeLinked`, `NSPrivacyCollectedDataTypeTracking`,
`NSPrivacyCollectedDataTypePurposes`) and `NSPrivacyAccessedAPITypes`
(required-reason APIs with approved reason codes such as UserDefaults
`CA92.1`/`C56D.1`, file timestamp `C617.1`/`DDA9.1`, system boot time `35F9.1`,
disk space `E174.1`/`85F4.1`, active keyboards `54BD.1`). Apple's upload
validation rejects builds whose required-reason API use lacks a declared
reason (ITMS-91053) or whose listed third-party SDKs lack a manifest or
signature (ITMS-91061).
(<https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api>,
<https://developer.apple.com/documentation/bundleresources/privacy-manifest-files>)
The manifest and the ASC label should agree; Xcode's Privacy Report (Product →
Archive → Generate Privacy Report) aggregates the app's and SDKs' manifests.

### 6.6 App Tracking Transparency

The ATT prompt (`NSUserTrackingUsageDescription`) is required only when the
app tracks in Apple's sense. An app with no ad SDK, no data broker and no IDFA
use answers "No" to tracking and needs no prompt.
(<https://developer.apple.com/app-store/user-privacy-and-data-use/>)

---

## 7. App Accessibility (Accessibility Nutrition Labels)

- Optional. Nine features: VoiceOver, Voice Control, Larger Text (200% or more
  without loss), Sufficient Contrast, Dark Interface, Differentiate Without
  Color Alone, Reduced Motion, Captions, Audio Descriptions. Each has an
  evaluation criteria page; claim a feature only when the app's common tasks
  pass those criteria.
  (<https://developer.apple.com/help/app-store-connect/manage-app-accessibility/overview-of-accessibility-nutrition-labels>)
- Flow: App Accessibility → Get Started → select devices (auto-detected once a
  version is live) → Add iPhone Support → Yes/No → tick features → Publish.
  "You can only publish support for devices that have a live version on the App
  Store." An optional Accessibility URL can be published for the product page.
  (<https://developer.apple.com/help/app-store-connect/manage-app-accessibility/manage-accessibility-nutrition-labels>)

---

## 8. The version page (iOS App → 1.0 Prepare for Submission)

Source for limits and wording:
<https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information>.

| Field                      | Apple's rule                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Screenshots                | Required, localizable. 1 to 10 per size, JPG or PNG, "Images can't include alpha channels or transparencies." Sizes in §8.1.                                                                                                                                                                                                                                                                      |
| App Preview                | Optional, up to three per localization per device size, 15 to 30 seconds, 500 MB max, H.264 or ProRes 422 HQ, 30 fps; 6.9" previews are 886 × 1920 (portrait). Processing can take 24 hours; previews always appear before screenshots.                                                                                                                                                           |
| Promotional Text           | up to 170 characters; editable any time without a new version                                                                                                                                                                                                                                                                                                                                     |
| Description                | up to 4000 characters, plain text, "HTML format isn't supported"                                                                                                                                                                                                                                                                                                                                  |
| Keywords                   | "One or more keywords (each greater than two characters) ... up to 100 bytes of content. Your app is searchable by app name and company name, so you shouldn't duplicate these values in the keyword list. Names of other apps or companies aren't allowed." Required, localizable.                                                                                                               |
| Support URL                | Required. "This URL must lead to actual contact information (legal address, email address, telephone number), as may be required by local law, so that users can reach you regarding app issues, general feedback, and feature enhancement requests."                                                                                                                                             |
| Marketing URL              | optional                                                                                                                                                                                                                                                                                                                                                                                          |
| Version Number             | shown on the product page; must match the build's `CFBundleShortVersionString`                                                                                                                                                                                                                                                                                                                    |
| Copyright                  | Required. "The name of the person or entity that owns the exclusive rights to the app, preceded by the year the rights were obtained (for example, 2014 Example, Inc.). The copyright symbol is added automatically."                                                                                                                                                                             |
| Routing App Coverage File  | navigation apps only (.geojson)                                                                                                                                                                                                                                                                                                                                                                   |
| Build                      | one build per version; changeable until submission; a build in Missing Compliance needs the export questions answered first                                                                                                                                                                                                                                                                       |
| App Review Information     | Contact name, email, phone ("in international format, including a plus sign (+) followed by the country code"); Notes up to 4000 bytes in any language; Sign-in required with username and password ("If your app uses a single sign-on service ... include the demo account login information for it. The demo account is used during the App Review process and must not expire."); attachments |
| Version Release            | Manual; Automatic; Automatic no earlier than a date                                                                                                                                                                                                                                                                                                                                               |
| What's New in this Version | "isn't available for the first version of the app but required for all subsequent versions"; up to 4000 characters; localizable                                                                                                                                                                                                                                                                   |
| Phased Release             | updates only; 7 days                                                                                                                                                                                                                                                                                                                                                                              |
| Reset overview rating      | updates only                                                                                                                                                                                                                                                                                                                                                                                      |

Editing windows: screenshots and previews can be uploaded only while the
version is in Prepare for Submission, Invalid Binary, Rejected, Metadata
Rejected or Developer Rejected. "Note: Images and videos aren't editable" in
Ready for Review, and cannot be uploaded in Waiting for Review or In Review.
After approval "you must create a new version to update the screenshots."
(<https://developer.apple.com/help/app-store-connect/manage-app-information/upload-app-previews-and-screenshots>,
<https://developer.apple.com/help/app-store-connect/reference/app-information/app-and-submission-statuses>)

### 8.1 Screenshot sizes (iPhone)

From <https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/>:

| Display | Devices                                                                      | Accepted portrait sizes               | Requirement                                                                       |
| ------- | ---------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------- |
| 6.9"    | iPhone Air, 17 Pro Max, 16 Pro Max, 16 Plus, 15 Pro Max, 15 Plus, 14 Pro Max | 1260 × 2736, 1290 × 2796, 1320 × 2868 | Required if the app runs on iPhone (the 6.5" set is the only alternative)         |
| 6.5"    | 14 Plus, 13 Pro Max, 12 Pro Max, 11 Pro Max, 11, XS Max, XR                  | 1284 × 2778, 1242 × 2688              | "Required if app runs on iPhone and screenshots for 6.9" display aren't provided" |
| 6.3"    | 17 Pro, 17, 16 Pro, 16, 15 Pro, 15, 14 Pro                                   | 1179 × 2556, 1206 × 2622              | optional; scaled from 6.5"/6.9" otherwise                                         |
| 6.1"    | 17e, 16e, 14, 13 Pro, 13, 13 mini, 12 Pro, 12, 12 mini, 11 Pro, XS, X        | 1170 × 2532, 1125 × 2436, 1080 × 2340 | optional                                                                          |
| 5.5"    | 8 Plus, 7 Plus, 6S Plus, 6 Plus                                              | 1242 × 2208                           | optional                                                                          |
| 4.7"    | SE 2/3, 8, 7, 6S, 6                                                          | 750 × 1334                            | optional                                                                          |

Landscape uses the same numbers swapped. "If your app's user interface is the
same across multiple device sizes and localizations, provide only the highest
resolution screenshots required. They automatically scale down." Media
Manager → View All Sizes lets you override any size. iPad sizes are required
only when the build supports iPad; App Store Connect derives supported devices
from the uploaded build.

Content rule from the guidelines: "Screenshots should show the app in use,
and not merely the title art, login page, or splash screen" (2.3.3), and all
metadata imagery must suit a 4+ audience even if the app is rated higher
(2.3.8).

---

## 9. Pricing and Availability

### 9.1 Price Schedule

- "You'll need to set pricing for your app before you submit it for review.
  Choose from up to 800 price points by default, and request to access an
  additional 100 higher price points (up to $10,000)."
- Flow: Pricing and Availability → Price Schedule → Add Pricing → choose a
  base country or region → choose a price (the first list shows 25 common
  points; See Additional Prices shows all) → review the generated prices for
  the other 174 storefronts and 43 currencies → Next → Confirm.
- Apple never changes the base-country price and periodically equalizes the
  others for tax and exchange-rate changes unless you edited a storefront by
  hand, in which case that storefront is yours to maintain.
- Changing the base country later deletes scheduled price changes; IAPs inherit
  the app's base country unless their pricing was edited separately.
  (<https://developer.apple.com/help/app-store-connect/manage-app-pricing/set-a-price>)
- A free app is price 0 in the base country. Any non-zero price requires the
  Paid Apps Agreement.
  (<https://developer.apple.com/help/app-store-connect/reference/pricing-and-availability/app-pricing-and-availability>)

### 9.2 App Availability

- "Before submitting your app for review on the App Store, you must set its
  availability." Options: All Countries or Regions (175, plus any added
  later), Specific Countries or Regions (with a checkbox to include future
  additions), or Publish as Pre-Order.
- The customer's Apple Account country decides which storefront they buy from.
- Removing a country later takes the app off that storefront within 24 hours;
  existing customers keep updates and can redownload.
- Remove App From Sale (bottom of the page) removes it everywhere within 24
  hours; existing customers keep it.
  (<https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/manage-availability-for-your-app-on-the-app-store>)
- Pre-order: release date 2 to 180 days out for a first release; in-app
  purchases cannot be pre-ordered.
  (<https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/publish-for-pre-order>)

### 9.3 Distribution methods

Public (App Store plus Apple Business Manager / Apple School Manager volume
purchase, optional 50% education discount for 20+ units) or Private (specific
organizations only). "Once your app is approved, the distribution method
can't be changed", except that a public app can request Unlisted distribution
(direct link only).
(<https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/set-distribution-methods>)

### 9.4 Tax category

Default "App Store software"; alternatives include Artwork, Audiobooks, Books,
Boosting, Cloud media player, Cloud storage, Dating, Fitness and health ("Apps
that provide streaming fitness classes or focus on healthy living"), Games,
Greeting cards, Magazines, Music and other audio, News publications,
Photography, Software training material, Video. Changes affect future
transactions only and can take an hour. The app's category applies to its IAPs
unless an IAP is given its own.
(<https://developer.apple.com/help/app-store-connect/manage-app-information/set-a-tax-category>)

### 9.5 iPhone apps on Macs with Apple silicon and on Apple Vision Pro

Both are on by default: "Users running macOS 11 or later on Macs with Apple
silicon can access iPhone and iPad apps through the Mac App Store, provided no
edits are made to the app availability", and "Your iPhone and iPad apps will
be available to users on Apple Vision Pro unless you edit their availability."
Uncheck "Make this app available" (Mac) and "Make this app available on Apple
Vision Pro" on the Pricing and Availability page to opt out. Both are app-level
settings.
(<https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/manage-availability-of-iphone-and-ipad-apps-on-macs-with-apple-silicon>,
<https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/manage-availability-of-iphone-and-ipad-apps-on-apple-vision-pro>)

---

## 10. Monetization

### 10.1 In-app purchase basics

- Four types: Consumable, Non-Consumable, Auto-Renewable Subscription,
  Non-Renewing Subscription. Up to 10,000 products per app; products are not
  shareable across apps.
- Apple's configuration workflow: accept the Paid Apps Agreement → design →
  configure products in ASC → implement StoreKit → test in sandbox → set up
  App Store Server Notifications → submit for review.
- "It may take up to 1 hour for changes you make to product metadata to appear
  in the sandbox environment."
  (<https://developer.apple.com/help/app-store-connect/configure-in-app-purchase-settings/overview-for-configuring-in-app-purchases>)

### 10.2 Product fields and limits

From <https://developer.apple.com/help/app-store-connect/reference/in-app-purchases-and-subscriptions/in-app-purchase-information>:

| Field                 | Rule                                                                                                                                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reference Name        | internal, up to 64 characters, editable without review                                                                                                                                                                                  |
| Product ID            | letters, numbers, hyphens, periods, underscores, up to 100 characters; "isn't editable after you save"; "can't be reused for another In-App Purchase within the same app, even if you delete the original In-App Purchase with that ID" |
| Display Name          | 2 to 30 characters, localizable, reviewed                                                                                                                                                                                               |
| Description           | up to 45 characters, localizable, reviewed                                                                                                                                                                                              |
| Review Notes          | up to 4000 characters                                                                                                                                                                                                                   |
| App Review Screenshot | "clearly shows the item or service being offered"; review only; any screenshot size the app supports; "you can update it but not remove it"                                                                                             |
| Image (promotional)   | required only to promote the IAP on the product page or for win-back offers: 1024 × 1024 JPG/PNG, 72 dpi, RGB, flattened, no rounded corners                                                                                            |
| Availability          | countries; "Remove from sale" keeps access for existing buyers                                                                                                                                                                          |
| Price Schedule        | same base-country model as the app: 800 price points, automatic equalization, optional per-storefront overrides                                                                                                                         |
| Tax Category          | inherits the app's unless set                                                                                                                                                                                                           |
| Family Sharing        | non-consumables and auto-renewable subscriptions only; "once you turn on Family Sharing ... you can't turn it off"                                                                                                                      |

Creation: In-App Purchases → + → Consumable or Non-Consumable → reference
name and product ID → Create, then fill the rest.
(<https://developer.apple.com/help/app-store-connect/manage-in-app-purchases/create-consumable-or-non-consumable-in-app-purchases>,
<https://developer.apple.com/help/app-store-connect/configure-in-app-purchase-settings/turn-on-family-sharing-for-in-app-purchases>)

### 10.3 In-app purchase statuses

Prepare for Submission → (Add for Review) Ready for Review → Waiting for
Review → In Review → Approved (or Accepted while another item in the same
submission is still rejected). Rejected can be edited and resubmitted with
Update Review; Developer Rejected means you removed it; Developer Removed from
Sale keeps access for existing buyers; Removed from Sale means Apple removed
it. While Ready for Review, Waiting or In Review "you can edit only the
reference name, pricing, and availability."
(<https://developer.apple.com/help/app-store-connect/reference/in-app-purchases-and-subscriptions/in-app-purchase-statuses>)

### 10.4 Auto-renewable subscriptions

- Structure: a subscription group (up to 100 subscriptions; a customer holds
  one subscription per group at a time) containing subscriptions, each with a
  level. "You can stack subscriptions with equal content but different
  durations ... at the same level." Level 1 is the most valuable. Upgrades take
  effect immediately with a prorated refund; downgrades and different-duration
  crossgrades take effect at the next renewal.
- Durations: 1 week, 1 month, 2 months, 3 months, 6 months, 1 year. "The
  duration can't be changed after you submit for review."
- Group fields: Reference Name (internal), Group Display Name (user-facing,
  localizable, no control characters or markup), App Name Display Options (use
  the app name or a custom name on the device's Manage Subscriptions page).
- Subscription fields: Reference Name, Product ID, Duration, Subscription
  Prices (per country, 800 points; you may preserve the current price for
  existing subscribers on an increase), Availability, Review Information
  (screenshot + notes), Family Sharing, Tax Category, Localizations (Display
  Name, Description), Introductory Offers, Promotional Offers, Offer Codes,
  Win-back offers, Image.
- "Your first auto-renewable subscription must be submitted with a new app
  version. Your first subscription group must also be submitted with a new app
  version and must include an auto-renewable subscription in the same
  submission."
- Proceeds: 70% during a subscriber's first year, 85% after one accumulated
  year in the same group (or from day one under the Small Business Program).
  (<https://developer.apple.com/help/app-store-connect/manage-subscriptions/offer-auto-renewable-subscriptions>,
  <https://developer.apple.com/help/app-store-connect/reference/in-app-purchases-and-subscriptions/auto-renewable-subscription-information>,
  <https://developer.apple.com/help/app-store-connect/reference/pricing-and-availability/in-app-purchase-and-subscriptions-pricing-and-availability>)

### 10.5 Introductory offers, offer codes, promotional offers

- Introductory offers: free (3 days to 1 year), pay as you go, or pay up front;
  one per subscription group per customer; one current and one future offer
  per country.
- Offer codes: one-time-use, custom, or sandbox codes; up to 10 active offers
  per app and 1 million codes per app per quarter; generating real codes needs
  the app in Ready for Distribution and the IAP Approved.
- Promotional offers: for existing or lapsed subscribers, up to 10 active per
  subscription, require an In-App Purchase key to sign.
  (<https://developer.apple.com/help/app-store-connect/reference/pricing-and-availability/in-app-purchase-and-subscriptions-pricing-and-availability>,
  <https://developer.apple.com/help/app-store-connect/manage-in-app-purchases/create-offer-codes-for-in-app-purchases>)

### 10.6 Billing Grace Period

Set per app under Subscriptions → Billing Grace Period → Set Up. Choose 3, 16
or 28 days (weekly subscriptions are capped at 6 days), choose All Renewals or
Only Paid to Paid Renewals, and choose Only Sandbox Environment or Production
and Sandbox. Apple's recommended workflow: turn it on in sandbox, test, then
enable production. Your server still has to read the renewal state and keep
access during the grace period.
(<https://developer.apple.com/help/app-store-connect/manage-subscriptions/enable-billing-grace-period-for-auto-renewable-subscriptions>)

### 10.7 Streamlined purchasing

On by default; it lets customers buy subscriptions merchandised on the App
Store (contingent pricing, win-back offers) without opening the app. Turning it
off requires a binary that includes the necessary StoreKit APIs.
(<https://developer.apple.com/help/app-store-connect/manage-subscriptions/manage-streamlined-purchasing>)

### 10.8 Promoting in-app purchases

Optional: up to 20 promoted products on the product page, each needing the
1024 × 1024 promotional image; showing them to people without the app requires
the purchase-intent APIs.
(<https://developer.apple.com/help/app-store-connect/configure-in-app-purchase-settings/promote-in-app-purchases>)

### 10.9 Submitting products

"The first consumable, non-consumable, auto-renewable subscription, and
non-renewing subscription In-App Purchase of each type must be submitted with
a new app version." Add for Review on each product, put them in the same draft
submission as the app version (and the subscription group with at least one
subscription), up to 200 items per submission. Products with content hosting
can no longer be submitted. In-app purchases are not supported on Apple Watch.
(<https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-in-app-purchase>)

---

## 11. Testing purchases

- Sandbox mirrors production products without charging. It supports storefront
  switching, accelerated renewals, server notifications, Family Sharing and
  Apple Pay tests. (<https://developer.apple.com/help/app-store-connect/test-in-app-purchases/overview-of-testing-in-sandbox>)
- TestFlight builds run in sandbox automatically; subscriptions renew daily,
  up to 6 times in a week, regardless of duration. To test billing retry and
  grace periods, sign in with a Sandbox Apple Account under Settings →
  Developer. (<https://developer.apple.com/help/app-store-connect/test-a-beta-version/testing-subscriptions-and-in-app-purchases-in-testflight>)
- App Review tests purchases in sandbox; the Paid Apps Agreement must be
  Active or products do not load.
- StoreKit Testing in Xcode uses a local `.storekit` configuration with no
  App Store connection, useful before products exist in ASC.

---

## 12. Builds

### 12.1 Upload and processing

- Upload with Xcode, Transporter, altool, the App Store Connect API, or Xcode
  Cloud. "The first time you upload a build, a beta version of the app is
  created ... the build needs to be processed in Apple's system before it
  appears." You get an email when it finishes; if a build stays Processing
  more than 24 hours, contact Apple. A failed upload lets you reuse the same
  build number.
  (<https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds>,
  <https://developer.apple.com/help/app-store-connect/reference/app-uploads/build-upload-statuses>)
- Each build is identified by bundle ID + version number + build string.
  The version must match the ASC version you attach it to.
- Build statuses: Invalid Binary, Missing Compliance, Waiting for Export
  Compliance Review, In Compliance Review, Ready to Submit, Waiting for Review
  (TestFlight), In Beta Review, Not Available for Testing, Expired (90 days),
  Rejected, Ready to Test, Testing.
  (<https://developer.apple.com/help/app-store-connect/reference/app-uploads/app-build-statuses>)

### 12.2 Toolchain requirement (current)

"Since April 28, 2026: Apps uploaded to App Store Connect must be built with
Xcode 26 or later using an SDK for iOS 26, iPadOS 26, tvOS 26, visionOS 26, or
watchOS 26." (<https://developer.apple.com/news/upcoming-requirements/>)
This Mac has Xcode 26.4.1 with the iOS 26.4 SDK, which satisfies it.

### 12.3 Size limits, icon, devices

- iOS app: 4 GB maximum uncompressed, 500 MB total for `__TEXT` sections
  (deployment target iOS 9 or later).
  (<https://developer.apple.com/help/app-store-connect/reference/app-uploads/maximum-build-file-sizes>)
- The App Store icon comes from the asset catalog in the binary (1024 × 1024,
  no transparency); changing it later requires a new version.
  (<https://developer.apple.com/help/app-store-connect/manage-app-information/add-an-app-icon>)
- `TARGETED_DEVICE_FAMILY` in the Xcode project decides iPhone-only vs
  universal; ASC uses the build to decide which screenshot sizes to require.

### 12.4 Export compliance

- Apps that use encryption (including HTTPS and OS crypto) must make an export
  compliance determination. "Your app uses encryption limited to that within
  the Apple operating system → No documentation required in App Store
  Connect." Industry-standard algorithms outside the OS need a French
  declaration only for France; proprietary algorithms need a CCATS plus the
  French declaration.
- Setting `ITSAppUsesNonExemptEncryption` to `false` in Info.plist means ASC
  does not ask the encryption questions on each upload. Otherwise a build shows
  Missing Compliance and you answer the questions from the version page (Manage
  next to the build) or App Information → App Encryption Documentation.
  Apple clears documentation reviews in about two business days.
  (<https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance>,
  <https://developer.apple.com/help/app-store-connect/reference/app-information/export-compliance-documentation-for-encryption>,
  <https://developer.apple.com/help/app-store-connect/manage-app-information/determine-and-upload-app-encryption-documentation>)

---

## 13. TestFlight

- Internal testing: up to 100 App Store Connect users; no review. External
  testing: up to 10,000 testers per app via email or public link; "When you add
  the first build of your app to a group, the build gets sent to App Review ...
  A review is required only for the first build." Builds expire after 90 days.
  You can submit up to six builds to TestFlight App Review in 24 hours. To
  create an external group you must first have an internal group.
  (<https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview>,
  <https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers>)
- Test Information (required before external testing): Beta App Description
  (required), Feedback Email (required), plus the Beta App Review sign-in and
  contact details; you can also show approved screenshots and category in the
  invite.
  (<https://developer.apple.com/help/app-store-connect/test-a-beta-version/provide-test-information>)
- Public links can filter by device and OS version and cap the tester count
  (1 to 10,000). Testers who join by link appear as anonymous.

---

## 14. Submitting and the review process

### 14.1 Mechanics

- "You can only associate one build with each app version. However, you can
  change the build as often as you want until you submit."
  (<https://developer.apple.com/help/app-store-connect/manage-builds/choose-a-build-to-submit>)
- Submit an app: verify the build → "Add for Review" (adds the version to a
  new or existing draft submission; status becomes Ready for Review) → add
  other items → "Submit for Review" (status becomes Waiting for Review, then In
  Review). "All items submitted together must be Accepted to complete the
  submission."
  (<https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-app>)
- Submission model: one app-version submission per platform at a time, plus at
  most one more submission of items without an app version. Items that can
  ride along: subscriptions and groups, in-app purchases, In-App Events, custom
  product pages, product page optimization tests, Apple-hosted asset packs,
  Game Center components. "Submissions may not be reviewed in the order you
  submit them."
  (<https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/overview-of-submitting-for-review>)
- Removing from review is possible in Waiting for Export Compliance, Waiting
  for Review, In Review, Pending Developer Release and Pending Apple Release;
  the version becomes Developer Rejected and a resubmission starts review over.
  Cancelling a submission also resets any Accepted items.
  (<https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/remove-a-submission-from-review>)

### 14.2 Statuses

App statuses (<https://developer.apple.com/help/app-store-connect/reference/app-information/app-and-submission-statuses>):

| Status                        | Meaning / what you can do                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Prepare for Submission        | record created, metadata in progress                                                                                                 |
| Ready for Review              | added to a draft submission, not sent; images and videos not editable                                                                |
| Invalid Binary                | build fails binary requirements; upload or pick another                                                                              |
| Waiting for Review            | received, not started; some metadata editable; can remove the build; cannot touch screenshots or previews                            |
| In Review                     | being reviewed; can remove from review                                                                                               |
| Accepted                      | this item passed but another item in the submission was rejected; fix or remove the rejected items                                   |
| Waiting for Export Compliance | CCATS under review                                                                                                                   |
| Pending Developer Release     | approved; you must release it; Apple emails a reminder after 30 days                                                                 |
| Processing for Distribution   | live within 24 hours                                                                                                                 |
| Pending Apple Release         | held until the matching OS ships                                                                                                     |
| Ready for Distribution        | approved and live (agreements must be in effect)                                                                                     |
| Rejected                      | read the message, fix, reply, resubmit                                                                                               |
| Metadata Rejected             | metadata only: "edit the metadata to resolve the issue, and reply to the message from App Review"; the same build can be resubmitted |
| Developer Rejected            | you removed it from review                                                                                                           |

Submission statuses: Waiting for Review, In Review, Processing (you cancelled),
Unresolved Issues (something rejected), Rejected (app bundle or TestFlight
submission). Item statuses: Ready for Review, Waiting for Review, In Review,
Accepted, Rejected.

Country statuses on the availability page include Available, Available on App
Release, Pre-Order, Processing to Available, Not Available, Missing App
Rating, Missing Tax Form (Brazil), ICP or game-registration issues (China),
Cannot Sell App.

### 14.3 Talking to App Review

- Rejections arrive in the App Review section with the guideline cited. "You
  can correspond with Apple, and include attachments ... until you resubmit."
  "If your app was rejected for a metadata issue, you can resubmit the same
  build after resolving the issue."
  (<https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/reply-to-app-review-messages>)
- Unresolved Issues: edit rejected items (once before resubmission) or remove
  them, then Resubmit to App Review; removed items cannot be added back to the
  same submission.
  (<https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/manage-a-submission-with-unresolved-issues>)
- Timelines and escalation, from <https://developer.apple.com/distribute/app-review/>:
  "On average, 90% of submissions are reviewed in less than 24 hours." "Over
  40% of unresolved issues are related to guideline 2.1: App Completeness."
  Expedited review can be requested for a critical bug fix (include repro
  steps) or an event you are directly associated with. Appeals go to the App
  Review Board, one per rejected submission, after answering any information
  requests. For bug-fix updates Apple may offer to approve the current
  submission and let you fix newly found issues next time; you accept by
  replying in ASC. You can also book a 30-minute App Review appointment.

### 14.4 Apple's own pre-submission checklist ("Before You Submit")

Quoted from <https://developer.apple.com/app-store/review/guidelines/>:
test for crashes and bugs; ensure all metadata is complete and accurate;
update your contact information; "Provide App Review with full access to your
app. If your app includes account-based features, provide either an active
demo account or fully-featured demo mode"; enable backend services; "Include
detailed explanations of non-obvious features and in-app purchases in the App
Review notes."

Common issues Apple lists on the App Review page: crashes and bugs, broken
links ("A link to user support with up-to-date contact information and a link
to your privacy policy is required for all apps"), placeholder content,
incomplete information (demo account, special configuration, demo video for
hard-to-replicate environments), privacy policy issues, unclear data access
requests (purpose strings), inaccurate screenshots, substandard UI, web
clippings, repeated submissions, copycats, misleading users, not enough lasting
value, submitted by the wrong entity.

---

## 15. Guideline rules that decide approval for this kind of app

All quotes from <https://developer.apple.com/app-store/review/guidelines/>.

- 2.1(a): "include demo account info (and turn on your back-end service!) if
  your app includes a login. If you are unable to provide a demo account due to
  legal or security obligations, you may include a built-in demo mode in lieu
  of a demo account with prior approval by Apple."
- 2.3.2: description, screenshots and previews must "clearly indicate whether
  any featured items, levels, subscriptions, etc. require additional
  purchases."
- 2.3.3: screenshots show the app in use, not splash or login screens.
- 2.3.7: unique name, accurate keywords, no trademarked terms or other apps'
  names, no prices in names or subtitles, names limited to 30 characters,
  subtitles must not "reference other apps, or make unverifiable product
  claims."
- 2.3.8: metadata imagery suitable for 4+; "For Kids" wording reserved for the
  Kids Category.
- 2.3.10: no "names, icons, or imagery of other mobile platforms" and no
  irrelevant information in metadata.
- 3.1.1: digital unlocks must use in-app purchase; "make sure you have a
  restore mechanism for any restorable in-app purchases."
- 3.1.2(a): ongoing value, period of at least seven days, works on all the
  user's devices; free trials allowed by configuring offers in ASC; scams
  remove the app and possibly the developer.
- 3.1.2(b): "Users should have a seamless upgrade/downgrade experience and
  should not be able to inadvertently subscribe to multiple variations of the
  same thing" (one subscription group with levels handles this).
- 3.1.2(c): "Before asking a customer to subscribe, you should clearly describe
  what the user will get for the price ... Ensure you clearly communicate the
  requirements described in Schedule 2 of the Apple Developer Program License
  Agreement." In practice reviewers expect the paywall to show title, duration,
  price, a functional privacy policy link and a Terms of Use (EULA) link, and
  the App Store metadata to carry a privacy policy URL and a Terms of Use link
  (in the description) or a custom EULA.
- 4.8: apps using Google Sign-In or other third-party logins for the primary
  account must also offer a login that limits data to name and email, lets
  users hide their email, and does not collect interactions for advertising
  without consent; Sign in with Apple satisfies this. Exceptions: your own
  account system only, enterprise/education accounts, government IDs, clients
  of a specific third-party service.
- 5.1.1(i): privacy policy link "in the App Store Connect metadata field and
  within the app", identifying data collected, third parties, retention and
  deletion, and how to revoke consent.
- 5.1.1(ii)–(iv): consent for data collection, clear purpose strings, data
  minimization ("use the out-of-process picker ... rather than requesting full
  access to protected resources like Photos"), respect permission settings.
- 5.1.1(v): "If your app doesn't include significant account-based features,
  let people use it without a login. If your app supports account creation,
  you must also offer account deletion within the app."
- 5.1.1(x): optional requests for name and email are fine when features are
  not conditional on them.
- 5.1.2(i): explicit permission before sharing personal data with third
  parties; ATT for tracking; "Your app may not require users to enable system
  functionalities (e.g. push notifications, location services, tracking) in
  order to access functionality."
- 5.6.1: "Use the provided API to prompt users to review your app ... we will
  disallow custom review prompts." Keep public review replies free of personal
  information, spam or marketing.
- 5.6.2: the developer identity presented to Apple and customers must be
  accurate and current.

Account deletion guidance (<https://developer.apple.com/support/offering-account-deletion-in-your-app/>):
easy to find (typically in account settings); delete the whole record, not
just deactivate; confirmation steps are allowed but unnecessary friction is
not; "Apps that support Sign in with Apple should use the Sign in with Apple
REST API to revoke user tokens"; if the user has an auto-renewable
subscription, tell them billing continues through Apple and point them to
`https://apps.apple.com/account/subscriptions` or `showManageSubscriptions`
before they delete; automatically created ("guest") accounts also need
deletion.

---

## 16. Release and after

### 16.1 Release options

Manually release this version (status becomes Pending Developer Release after
approval; click Release This Version; Apple emails after 30 days of waiting),
Automatically release this version, or Automatically release after App Review
no earlier than a date and time. "After manually releasing your app version, it
may take up to 24 hours for it to appear on the App Store." Releasing also
publishes any pre-orders. Pre-order setups force manual release.
(<https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/select-an-app-store-version-release-option>)

### 16.2 Phased release (updates only)

Over 7 days to users with automatic updates: 1%, 2%, 5%, 10%, 20%, 50%, 100%.
Anyone can still download manually. Pause for up to 30 days in total; Release
to All Users at any time. Available when the version is Prepare for
Submission, Waiting for Review, In Review, Waiting for Export Compliance,
Pending Developer Release, Developer Rejected, Rejected or Metadata Rejected.
(<https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases>)

### 16.3 Updating

Create a new version with the + next to the platform; metadata copies forward;
"it's not possible to revert to a previous version on the App Store"; the
current version must be Ready for Distribution first; increment the build
string in Xcode; What's New is required.
(<https://developer.apple.com/help/app-store-connect/update-your-app/create-a-new-version>)

### 16.4 Promo codes and offer codes

- App promo codes: "up to 100 promo codes per version of each platform"; "Each
  code remains valid for four weeks from its generation date and can be used
  only once"; redeemers cannot rate or review; codes cannot be generated when
  the app is removed from sale everywhere. Path: sidebar → Promo Codes →
  Generate → agree to the terms → History tab to download.
  (<https://developer.apple.com/help/app-store-connect/offer-promo-codes/request-and-manage-promo-codes>)
- The same page also generates promo codes for in-app purchases other than
  auto-renewable subscriptions; subscriptions are discounted through offer
  codes (§10.5). Confirm the per-product count in the UI; Apple's help page
  quoted above documents only the per-version app limit.

### 16.5 Growth and marketing tools

- In-App Events: timed events shown on the product page, in search and in
  editorial; require review; iPhone and iPad only.
  (<https://developer.apple.com/help/app-store-connect/offer-in-app-events/overview-of-in-app-events>)
- Custom product pages: "up to 70 custom product pages per app", each with
  its own screenshots, previews, promotional text and keywords, reachable by
  URL; require review.
  (<https://developer.apple.com/help/app-store-connect/create-custom-product-pages/configure-multiple-product-page-versions>)
- Product page optimization: test up to three treatments (icon, screenshots,
  previews) against the original; the app must be Ready for Distribution;
  alternate icons must exist in the shipping binary.
  (<https://developer.apple.com/help/app-store-connect/create-product-page-optimization-tests/overview-of-product-page-optimization>)
- Nominations (Featuring): App Launch, App Enhancements or New Content; a
  description, a publish date or range ("a minimum lead time of 3 weeks"), up
  to 10 related apps, up to 5 supplemental URLs, helpful details; CSV import
  for up to 50; nomination name up to 60 characters, description up to 1,000,
  helpful details up to 500.
  (<https://developer.apple.com/help/app-store-connect/manage-featuring-nominations/nominate-your-app-for-featuring>,
  <https://developer.apple.com/help/app-store-connect/reference/nominations/nominations-template>)
- Game Center: only for apps that implement GameKit; leaderboards and
  achievements that have gone live cannot be removed. Leave it alone unless the
  binary uses it.
  (<https://developer.apple.com/help/app-store-connect/configure-game-center/overview-of-game-center>)

### 16.6 Ratings and reviews

Respond from Ratings and Reviews (Account Holder, Admin, Customer Support);
one response per review is shown; responses can be edited or deleted any time
and take up to 24 hours to appear; the customer is notified and may update
their review. iOS 18.4+ shows an LLM-generated review summary. Ratings can be
reset with a new version, which also hides the old average until enough new
ratings arrive.
(<https://developer.apple.com/help/app-store-connect/monitor-ratings-and-reviews/ratings-and-reviews-overview>,
<https://developer.apple.com/help/app-store-connect/monitor-ratings-and-reviews/respond-to-reviews>)

### 16.7 Getting paid

Requirements: Paid Apps Agreement in effect, banking on file, minimum monthly
threshold met per region, invoicing requirements met. "Payments are made ...
within 45 days of the last day of the fiscal month in which the transaction was
completed", as one consolidated deposit per currency; financial reports appear
by the first Friday of the next fiscal month. Threshold: 0.02 USD equivalent
for most listed bank countries (US, Canada, EU members, Australia and others),
40 USD elsewhere.
(<https://developer.apple.com/help/app-store-connect/getting-paid/overview-of-receiving-payments>,
<https://developer.apple.com/help/app-store-connect/reference/reporting/minimum-payment-threshold>)
The App Store Small Business Program lowers commission to 15% for developers
under 1 million USD in prior-year proceeds; enrollment is a separate request.
(<https://developer.apple.com/app-store/small-business-program/>)

---

## 17. Where first submissions fail, and the matching safeguard in the dossier

| Failure mode Apple cites                                           | Guideline | Safeguard in `APP_STORE_SUBMISSION.md`                                                                       |
| ------------------------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------ |
| Reviewer cannot get past sign-in                                   | 2.1       | Sign-in required = Yes with a non-expiring demo account; notes explain Sign in with Apple; §11.8, Appendix D |
| Reviewer cannot exercise the core feature (camera + a real stroke) | 2.1       | Import Video path with a hosted sample clip; live-camera instructions; screen recording attached             |
| Crash on iPad in compatibility mode                                | 2.1       | Test the flow once on an iPad simulator before submitting; notes state iPhone design                         |
| Broken or missing support / privacy links                          | 2.1, 5.1  | Support URL must be a real page with contact details; privacy URL verified live                              |
| Placeholder or unfinished metadata                                 | 2.1       | Every field has a final value; no TODOs                                                                      |
| Metadata mentions other platforms or competitors                   | 2.3.7/10  | Hard rule 4 in the dossier; keyword list checked                                                             |
| Subscription terms or legal links missing                          | 3.1.2(c)  | Paywall shows price/duration/renewal/Restore/Terms/Privacy; description carries Terms and Privacy URLs       |
| Third-party login without Sign in with Apple                       | 4.8       | Sign in with Apple is offered; Supabase Apple provider must be on                                            |
| Purpose strings unclear or permissions over-requested              | 5.1.1     | Camera and photo strings explain use; PHPicker avoids library access; microphone string is unused            |
| No in-app account deletion                                         | 5.1.1(v)  | Settings → Account → Manage account → Delete account, two-step                                               |
| Privacy label does not match behaviour                             | 5.1       | Label built from the actual data flows; manifest snippet mirrors it                                          |
| Paid Apps Agreement not Active, products fail to load in review    | 3.1.1     | Pre-flight §2.1 of the dossier                                                                               |
| Inaccurate app category                                            | 2.3       | Sports is the sole category; the optional secondary category is blank                                        |

---

## 18. Source index

App Store Connect Help (developer.apple.com/help/app-store-connect/...):
`get-started/app-store-connect-workflow`, `get-started/app-store-connect-sections`,
`manage-your-team/overview-of-accounts-and-roles`,
`reference/account-management/role-permissions`,
`create-an-app-record/add-a-new-app`, `create-an-app-record/set-your-developer-name`,
`create-an-app-record/view-and-edit-app-information`,
`manage-builds/upload-builds`, `manage-builds/choose-a-build-to-submit`,
`reference/app-uploads/build-upload-statuses`, `reference/app-uploads/app-build-statuses`,
`reference/app-uploads/maximum-build-file-sizes`,
`manage-app-information/set-an-app-age-rating`,
`reference/app-information/age-ratings-values-and-definitions`,
`manage-app-information/provide-a-custom-license-agreement`,
`manage-app-information/localize-app-information`,
`manage-app-information/manage-app-privacy`, `reference/app-information/app-privacy`,
`manage-app-information/set-a-tax-category`,
`manage-app-information/declare-regulated-medical-device-status`,
`manage-app-information/overview-of-export-compliance`,
`manage-app-information/determine-and-upload-app-encryption-documentation`,
`reference/app-information/export-compliance-documentation-for-encryption`,
`manage-app-information/add-an-app-icon`,
`manage-app-information/upload-app-previews-and-screenshots`,
`reference/app-information/screenshot-specifications`,
`reference/app-information/app-preview-specifications`,
`reference/app-information/app-information`,
`reference/app-information/platform-version-information`,
`reference/app-information/required-localizable-and-editable-properties`,
`reference/app-information/app-and-submission-statuses`,
`manage-app-accessibility/overview-of-accessibility-nutrition-labels`,
`manage-app-accessibility/manage-accessibility-nutrition-labels`,
`test-a-beta-version/testflight-overview`, `test-a-beta-version/provide-test-information`,
`test-a-beta-version/invite-external-testers`,
`test-a-beta-version/testing-subscriptions-and-in-app-purchases-in-testflight`,
`manage-submissions-to-app-review/overview-of-submitting-for-review`,
`manage-submissions-to-app-review/submit-an-app`,
`manage-submissions-to-app-review/submit-an-in-app-purchase`,
`manage-submissions-to-app-review/remove-a-submission-from-review`,
`manage-submissions-to-app-review/reply-to-app-review-messages`,
`manage-submissions-to-app-review/manage-a-submission-with-unresolved-issues`,
`manage-your-apps-availability/overview-of-publishing-your-app-on-the-app-store`,
`manage-your-apps-availability/manage-availability-for-your-app-on-the-app-store`,
`manage-your-apps-availability/set-distribution-methods`,
`manage-your-apps-availability/publish-for-pre-order`,
`manage-your-apps-availability/select-an-app-store-version-release-option`,
`manage-your-apps-availability/manage-availability-of-iphone-and-ipad-apps-on-macs-with-apple-silicon`,
`manage-your-apps-availability/manage-availability-of-iphone-and-ipad-apps-on-apple-vision-pro`,
`manage-app-pricing/set-a-price`,
`reference/pricing-and-availability/app-pricing-and-availability`,
`reference/pricing-and-availability/in-app-purchase-and-subscriptions-pricing-and-availability`,
`update-your-app/create-a-new-version`, `update-your-app/release-a-version-update-in-phases`,
`manage-featuring-nominations/nominate-your-app-for-featuring`,
`reference/nominations/nominations-template`,
`monitor-ratings-and-reviews/ratings-and-reviews-overview`,
`monitor-ratings-and-reviews/respond-to-reviews`,
`manage-agreements/sign-and-update-agreements`, `manage-agreements/view-agreements-status`,
`manage-banking-information/enter-banking-information`,
`manage-tax-information/provide-tax-information`,
`manage-compliance-information/manage-european-union-digital-services-act-trader-requirements`,
`getting-paid/overview-of-receiving-payments`,
`reference/reporting/minimum-payment-threshold`,
`offer-promo-codes/request-and-manage-promo-codes`,
`configure-in-app-purchase-settings/overview-for-configuring-in-app-purchases`,
`configure-in-app-purchase-settings/generate-keys-for-in-app-purchases`,
`configure-in-app-purchase-settings/enter-server-urls-for-app-store-server-notifications`,
`configure-in-app-purchase-settings/turn-on-family-sharing-for-in-app-purchases`,
`configure-in-app-purchase-settings/promote-in-app-purchases`,
`manage-in-app-purchases/create-consumable-or-non-consumable-in-app-purchases`,
`manage-in-app-purchases/set-a-price-for-an-in-app-purchase`,
`manage-in-app-purchases/create-offer-codes-for-in-app-purchases`,
`manage-subscriptions/offer-auto-renewable-subscriptions`,
`manage-subscriptions/enable-billing-grace-period-for-auto-renewable-subscriptions`,
`manage-subscriptions/manage-streamlined-purchasing`,
`reference/in-app-purchases-and-subscriptions/in-app-purchase-types`,
`reference/in-app-purchases-and-subscriptions/in-app-purchase-information`,
`reference/in-app-purchases-and-subscriptions/in-app-purchase-statuses`,
`reference/in-app-purchases-and-subscriptions/auto-renewable-subscription-information`,
`test-in-app-purchases/overview-of-testing-in-sandbox`,
`test-in-app-purchases/create-a-sandbox-apple-account`,
`test-in-app-purchases/manage-sandbox-apple-account-settings`,
`offer-in-app-events/overview-of-in-app-events`,
`create-custom-product-pages/configure-multiple-product-page-versions`,
`create-product-page-optimization-tests/overview-of-product-page-optimization`,
`configure-game-center/overview-of-game-center`.

Other Apple pages: App Review Guidelines
(<https://developer.apple.com/app-store/review/guidelines/>), App Review
(<https://developer.apple.com/distribute/app-review/>), Offering account
deletion (<https://developer.apple.com/support/offering-account-deletion-in-your-app/>),
App privacy details (<https://developer.apple.com/app-store/app-privacy-details/>),
Upcoming requirements (<https://developer.apple.com/news/upcoming-requirements/>),
Age rating news (<https://developer.apple.com/news/?id=ks775ehf>,
<https://developer.apple.com/news/?id=tlur8uvi>), DSA removal notice
(<https://developer.apple.com/news/?id=6agg0lja>), Small Business Program
(<https://developer.apple.com/app-store/small-business-program/>), privacy
manifest documentation
(<https://developer.apple.com/documentation/bundleresources/privacy-manifest-files>).
Third party: RevenueCat privacy guidance and In-App Purchase key setup
(<https://www.revenuecat.com/docs/platform-resources/apple-platform-resources/apple-app-privacy>,
<https://www.revenuecat.com/docs/service-credentials/itunesconnect-app-specific-shared-secret/in-app-purchase-key-configuration>).
