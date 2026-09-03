// Public legal documents served by the API function (no auth):
//
//   GET /privacy — the privacy policy the App Store listing and the in-app
//                  Privacy links point at.
//   GET /terms   — service and subscription terms the paywall links to.
//
// Served as PLAIN TEXT by design: the Supabase functions gateway rewrites
// Content-Type to text/plain and forces a sandboxing CSP on the shared
// *.supabase.co domain (anti-phishing protection), so HTML would render as
// raw source. Formatted text reads cleanly in any browser at the same URLs;
// if a styled page is ever wanted, host these on a custom domain and update
// runtimeConfig's legal URLs.
//
// These documents describe the production mobile app and Supabase Edge API,
// not the retired services/api implementation. Keep them synchronized with
// actual data flows, App Store Connect privacy answers, and purchase screens.

const LAST_UPDATED = "September 2, 2026";
const SUPPORT_EMAIL = "picklesenseidev@gmail.com";
const LEGAL_OWNER = "Raunak Gengiti";
const CONTACT_ADDRESS = "6737 Elegante Way, San Diego, California 92130, United States";

export const PRIVACY_POLICY_TEXT = `PICKLE SENSEI — PRIVACY POLICY
Last updated: ${LAST_UPDATED}

This Privacy Policy explains how ${LEGAL_OWNER}, an individual who provides
and operates the service under the name Pickle Sensei ("Pickle Sensei," "we,"
"us," or "our"), collects, uses, discloses, retains, and protects information
when you use the Pickle Sensei mobile application, its account services, and
the public pages served with those services (collectively, the "Service").

The most important privacy fact is simple: raw court video, camera frames,
audio recorded with a clip, and body-pose landmarks stay on your device.
Stroke analysis runs on your device. Pickle Sensei does not upload those raw
media or pose-landmark files to its servers.


1. SCOPE AND RESPONSIBILITY

This policy applies to information processed by Pickle Sensei through the
Service. It does not replace the privacy notices of Apple, Google, RevenueCat,
Supabase, YouTube, Vimeo, or another third party whose service you choose to
use. Those parties process some information under their own terms and privacy
policies, as described below.

For purposes of applicable privacy law, ${LEGAL_OWNER} is the operator and,
where that terminology applies, the business or data controller responsible
for Pickle Sensei. The mailing address is ${CONTACT_ADDRESS}.


2. INFORMATION WE COLLECT OR PROCESS

A. Account and sign-in information

When you sign in with Apple or Google, we receive the information that the
provider makes available and that is needed to create or access your account.
This may include your email address, display name, sign-in provider, provider
account identifier, and an internal Pickle Sensei account identifier.

The provider identity token is used to establish a session and is not stored
on your device by Pickle Sensei. A refresh credential is stored in the
device's protected Keychain or Keystore so you can remain signed in. Access
credentials are held temporarily while the app runs. Authentication records
and server sessions are handled through Supabase Auth.

B. Coaching profile and preferences

We collect the onboarding answers and profile details you choose to provide,
such as skill level, dominant hand, training goals, focus area, optional first
name, and optional gender selection. We use them to personalize coaching,
recommended drills, and the in-app experience.

C. Stroke analysis, activity, and progress information

The app creates structured records from on-device analysis. Depending on the
feature used, these records may include:

• declared and detected stroke type;
• camera view and capture mode;
• capture and session timestamps, clip duration, frame rate, and dimensions;
• technique scores, confidence values, movement measurements, phase timing,
  checkpoint results, limiting factors, and coaching recommendations;
• app, model, detector, and scoring-version identifiers;
• practice-session counts, completed drills, saved drills, streaks,
  achievements, rank, and progress summaries; and
• whether a result was scored or the system abstained because confidence or
  evidence was insufficient.

These structured records are stored locally. When you use a signed-in,
synced account, some records needed for account history, progress, rank,
allowance enforcement, and service continuity are also sent to our servers.
They do not contain the raw video, raw audio, camera frames, or pose-landmark
file from which the analysis was produced.

D. Feedback and communications

If you rate an analysis as accurate or not quite right, we collect that
choice and, when applicable, the issue category. If you contact us, we
receive the information in your message and the contact information you use.

Before deleting an account, you may complete an optional exit survey. It can
include a selected reason, what might have changed your decision, optional
free-text comments, platform and app version, sign-in provider, approximate
account age, whether the account had Pro access, and the number of scored
analyses. Skipping the survey never prevents deletion.

E. Consent and privacy-choice records

We keep an auditable record of privacy choices made in Data & consent,
including the scope, grant or withdrawal, policy or consent version,
timestamp, source screen, platform/OS label, and capture-mode label. This
lets us honor the current choice and demonstrate that optional processing was
not enabled without an affirmative action.

F. Optional model-improvement and evaluation records

Optional model-improvement permission is off by default. If you turn it on,
analysis feedback you submit and the associated structured analysis record
may be marked eligible for review and model improvement. Turning it on does
not upload raw video, raw audio, camera frames, or pose-landmark files.

Evaluation telemetry is a separate, opt-in category and is also off by
default. If an evaluation-telemetry control is offered and you enable it, we
may collect a record of an analysis attempt: generated trial/capture and
analysis identifiers, timestamps, declared stroke, result or abstention,
latency, app/model versions, confidence and scoring claims, phase/contact
timing, limiting factors, user flags, capture dimensions, and the consent
version. These records are linked to your Pickle Sensei account while the
account exists; they are not anonymous. They do not include the raw clip or
pose-landmark file.

Withdrawing an optional permission stops new records from becoming eligible
or being collected under that permission. It does not retroactively undo
processing already completed before withdrawal. Consent-history records are
retained with the account for accountability and are deleted with it.

G. Purchase and entitlement information

Apple's App Store or Google Play processes purchases. RevenueCat helps us
validate receipts and determine access. We and RevenueCat may process your
Pickle Sensei account identifier, store, product identifier, purchase and
renewal history, transaction/receipt status, entitlement status, expiration
date, trial or introductory-offer status, and related store metadata. We use
this information to provide Pro features, prevent purchase fraud, restore
purchases, support customers, and understand subscription performance.

We do not receive or store your full payment-card number, bank-account
details, or store-account password. Apple or Google handles the payment.

H. Network, app, and security information

When the app communicates with our API, servers necessarily process request
information such as IP address, request time and route, app version, platform,
authentication status, and response/error information. We use this data to
deliver the Service, protect accounts, investigate errors, prevent abuse, and
apply rate limits. Short-lived authentication caches, token hashes, and
rate-limit counters normally expire within ten minutes. Hosting providers may
retain infrastructure and security logs under their own documented schedules.

We do not use a third-party advertising SDK, do not request the advertising
identifier, and do not track activity across other companies' apps or
websites for advertising.

I. Information kept only on your device

The following is processed or stored locally by the app and is not uploaded
to Pickle Sensei's servers:

• raw recorded or imported video, camera frames, clip audio, and pose
  landmarks;
• the contents of your photo library other than the single video you choose
  through the system picker;
• notification preferences and locally scheduled reminder state;
• device-local playback and interface state; and
• protected sign-in credentials described in Section 2.A.

Camera, microphone, photo-library selection, and notification access are used
only after the relevant feature or permission is requested. You can change
system permissions in device Settings, although disabling a required
permission may prevent that feature from working.


3. INFORMATION WE DO NOT COLLECT FOR OUR SERVERS

Pickle Sensei does not collect for its servers:

• raw court video, raw camera frames, raw clip audio, or pose-landmark files;
• payment-card or bank-account numbers;
• precise or coarse GPS location;
• address-book contacts;
• advertising identifiers or cross-app advertising profiles;
• face templates, face recognition, or identity inferred from body movement;
  or
• medical records.

We do not sell personal information. We do not share personal information for
cross-context behavioral advertising, and we do not serve targeted ads.


4. HOW WE USE INFORMATION

We use information described above to:

• create, authenticate, secure, and support accounts;
• provide on-device stroke analysis and sync structured results;
• personalize coaching, drills, progress, streaks, achievements, and rank;
• enforce free-analysis allowances and provide paid features;
• process, verify, restore, and troubleshoot purchases;
• remember and enforce consent and privacy choices;
• respond to questions, feedback, and account requests;
• operate, secure, debug, and improve the Service;
• conduct optional evaluation or model-improvement work only within the
  permission you granted; and
• comply with law, resolve disputes, and enforce our Terms of Use.

Pickle Sensei uses automated, on-device processing to generate technique
scores and coaching suggestions. These outputs do not make legal, employment,
credit, insurance, medical, or similarly significant decisions about you.


5. WHEN WE DISCLOSE INFORMATION

We disclose information only as needed for the purposes in this policy:

• Supabase provides authentication, database, and Edge Function hosting for
  account and synced-service data.
• RevenueCat receives an internal account identifier and purchase-related
  information to validate purchases, manage entitlements, prevent fraud,
  provide subscription analytics, and support purchase restoration.
• Apple and Google provide sign-in and store-payment services. Information
  sent to or received from them is also governed by their policies.
• Upstash may provide short-lived cache and rate-limit infrastructure when
  enabled. Cached values are derived service state, token hashes, and
  short-lived request counters rather than raw court media.
• YouTube or Vimeo may receive ordinary web-request information, such as IP
  address, device/browser information, cookies or similar storage, and video
  interactions when you choose to open or play an externally hosted drill
  video. YouTube embeds use its privacy-enhanced domain where supported, but
  the video provider remains an independent third party.
• Professional advisers, authorities, or other parties may receive
  information when reasonably necessary to comply with law, protect rights
  and safety, investigate fraud or security incidents, or establish or defend
  legal claims.
• If the Service is involved in a merger, financing, acquisition,
  reorganization, or sale of assets, information may be transferred subject
  to appropriate confidentiality and continued notice of applicable privacy
  practices.

Service providers are permitted to process information only for contracted
purposes and must protect it consistently with their agreements and
applicable law. We do not permit them to use Pickle Sensei data for targeted
advertising on our behalf.


6. LEGAL BASES FOR PROCESSING

Where a law requires a legal basis, we rely on:

• performance of a contract — to provide accounts, analysis history,
  personalization, purchases, and requested Service features;
• consent — for optional model-improvement or evaluation processing and for
  device permissions where consent is the applicable basis;
• legitimate interests — to secure, maintain, troubleshoot, and improve the
  Service, prevent fraud, and understand aggregate product performance, where
  those interests are not overridden by your rights; and
• legal obligations and legal claims — when processing is needed to comply
  with law or establish, exercise, or defend rights.

You may withdraw consent for future optional processing at any time without
affecting the lawfulness of processing completed before withdrawal.


7. RETENTION

We use the following retention rules:

• Account, profile, synced analysis, training, progress, consent, feedback,
  and entitlement records are retained while the account is active and are
  deleted from our primary application database when account deletion
  completes, except as specifically stated below.
• A pending deletion challenge expires after 15 minutes and stale challenge
  records are scheduled for deletion after expiration.
• Short-lived cache and rate-limit records normally expire within ten
  minutes.
• RevenueCat webhook audit records are scheduled for deletion after 90 days.
  They are restricted to service administration and security purposes.
• If you submit the optional exit survey and then delete your account, the
  account identifier is removed from that response during deletion. The
  resulting de-identified survey entry, including the coarse context listed
  in Section 2.D, may be retained for longitudinal product research until it
  is no longer useful. It is not used to contact you or recreate your
  identity.
• Raw clips and other device-only data remain in app-private storage until
  removed by normal app cleanup or until you delete the app. Deleting your
  server account does not itself erase a clip file already stored on the
  phone.
• Apple, Google, RevenueCat, video providers, and infrastructure providers
  may retain records under their own policies, including transaction,
  tax/accounting, fraud-prevention, and security records that they are
  legally required or permitted to keep.

We may retain limited information longer when required by law, needed to
complete a pending dispute or security investigation, or necessary to
enforce legal rights. When possible, we restrict use during that period to
the retention purpose.


8. ACCOUNT DELETION AND OTHER CHOICES

You can delete a synced Pickle Sensei account in Settings → Manage account →
Delete account. The optional survey can be skipped. After the separate final
confirmation succeeds, deletion is permanent and removes the account and its
associated profile, synced analysis history, sessions, progress data, saved
drills, consent records, evaluation records, feedback, permits, rank state,
and Pickle Sensei entitlement row from our primary application database.
The backend also permanently deletes the customer record identified by the
internal account identifier from RevenueCat. For an account created with Sign
in with Apple, the backend revokes the stored Apple authorization before it
deletes the account. An older account created before we began securely storing
an Apple revocation credential may require you to remove Pickle Sensei
manually in your Apple Account's Sign in with Apple settings; the app tells
you when this exceptional step is needed. We fulfill the account deletion
even if a legacy Apple credential is unavailable.

Deleting a Pickle Sensei account does not cancel an auto-renewing subscription
managed by Apple or Google, does not itself create a refund, and does not
erase device-only clips. Cancel a subscription in the applicable store before
deleting if you do not want it to renew. Apple subscriptions can be managed
at https://apps.apple.com/account/subscriptions.

You can also:

• withdraw optional model-improvement permission in Settings → Data & consent;
• change camera, microphone, photo, and notification permissions in device
  Settings;
• manage or cancel subscriptions through your App Store or Google Play
  account; and
• ask us for access, correction, deletion, or a portable copy of personal
  information by emailing ${SUPPORT_EMAIL}.

We may need to verify that a request relates to your account. Depending on
where you live, you may also have rights to object to or restrict processing,
withdraw consent, appeal a decision, or complain to a privacy regulator. We
will not discriminate against you for exercising an applicable privacy right.


9. INTERNATIONAL PROCESSING

Pickle Sensei and its providers may process information in countries other
than the one where you live. Those countries may have different data-
protection laws. Where required, we use contractual or other approved
safeguards for cross-border transfers and honor mandatory local rights.


10. SECURITY

We use administrative, technical, and organizational safeguards appropriate
to the nature of the information. These include TLS encryption in transit,
protected device credential storage, server-side authentication, scoped
service credentials, per-user row-level database security, request-rate
limits, input limits, and restricted server-only writes for entitlement and
audit records. No storage or transmission system is completely secure, so we
cannot guarantee absolute security.


11. CHILDREN

The Service is not directed to children under 13, and we do not knowingly
collect personal information from a child under 13. If you believe a child
under 13 provided personal information, contact ${SUPPORT_EMAIL} so we can
investigate and delete it. A parent or guardian is responsible for deciding
whether an older minor may use the Service where local law requires consent.


12. CHANGES TO THIS POLICY

We may update this policy as the Service, providers, or law changes. We will
post the revised policy, change the date above, and provide additional notice
when required. Material changes apply prospectively unless law permits or
requires otherwise.


13. CONTACT

Operator and privacy contact: ${LEGAL_OWNER}
Mailing address: ${CONTACT_ADDRESS}
Email for privacy questions and requests: ${SUPPORT_EMAIL}
`;

export const TERMS_TEXT = `PICKLE SENSEI — TERMS OF USE
Last updated: ${LAST_UPDATED}

These Terms of Use ("Terms") are an agreement between you and ${LEGAL_OWNER},
an individual who provides and operates the service under the name Pickle
Sensei ("Pickle Sensei," "we," "us," or "our"). They govern the Pickle Sensei
mobile application, account services, analysis features, content, and related
services (collectively, the "Service").

Please read these Terms and the Privacy Policy before using the Service. By
creating an account, purchasing access, or using the Service, you agree to
these Terms. If you do not agree, do not use the Service.


1. ELIGIBILITY

You must be at least 13 years old to use the Service. If you have not reached
the age at which you may enter a binding contract where you live, a parent or
legal guardian must review and agree to these Terms for you and is responsible
for your use. You may not use the Service if applicable law prohibits it.


2. WHAT PICKLE SENSEI PROVIDES

Pickle Sensei uses on-device computer vision and automated scoring methods to
provide pickleball stroke analysis, technique estimates, coaching cues,
practice tools, progress history, drills, streaks, achievements, and player-
development summaries.

Scores, ranks, checkpoint measurements, stroke labels, phase timing, and
coaching suggestions are estimates produced from the available recording and
model. They may be incomplete, inaccurate, or unavailable. A Pickle Sensei
score or rank is not an official league, tournament, DUPR, medical, fitness,
or professional coaching assessment, and it must not be represented as one.

The Service may abstain from producing a score when evidence is insufficient.
No particular score, improvement, detection rate, athletic result, ranking,
or uninterrupted availability is promised.


3. HEALTH AND SAFETY

Pickle Sensei provides general educational and recreational information. It
does not provide medical advice, diagnosis, treatment, physical therapy, or
emergency services, and it is not a substitute for a qualified coach or
health professional.

You are responsible for deciding whether an exercise, drill, or movement is
appropriate for you. Use a safe court area, secure the recording device,
remain aware of people and objects around you, stop if you feel pain,
dizziness, or unsafe, and seek professional advice when appropriate. Do not
delay seeking medical care because of information from the Service. In an
emergency, contact local emergency services.


4. ACCOUNTS AND SECURITY

Sign-in is provided through Apple or Google. You must provide accurate
information, use only an account you are authorized to use, maintain the
security of your device and provider account, and promptly notify us of
suspected unauthorized access. You are responsible for activity under your
account except to the extent caused by our breach of these Terms or law.

One person may not impersonate another, transfer an account, evade a valid
suspension, or use another person's store purchase without authorization.
Features may require a compatible device, current operating system, camera,
internet access, and provider account.


5. LICENSE AND OWNERSHIP

Subject to these Terms and applicable store rules, we grant you a limited,
personal, revocable, nonexclusive, nontransferable, nonsublicensable license
to install and use the Service on devices you own or control for personal,
noncommercial use. Rights not expressly granted are reserved.

Pickle Sensei and its licensors own the Service, including its software,
models, design, branding, text, graphics, compilations, and other content,
excluding content you own and third-party material. These Terms do not
transfer ownership of the Service or its intellectual property to you.


6. YOUR CONTENT, VIDEO, AND FEEDBACK

You retain the rights you have in videos, comments, and other material you
provide. You represent that you have permission to record and analyze every
person visible or audible in a clip and that your use complies with privacy,
recording-consent, venue, and other applicable laws. Do not record someone in
a place or manner where they reasonably expect privacy.

Raw recorded/imported video, clip audio, camera frames, and pose landmarks are
processed locally and are not uploaded to Pickle Sensei's servers. For synced
features, you authorize us to host, reproduce, process, and display the
structured account, analysis, activity, and feedback data described in the
Privacy Policy solely to operate, secure, support, and improve the Service.

If you send suggestions or product feedback, you permit us to use it without
payment or restriction, but this does not give us ownership of your raw court
video or override an optional consent setting. Model-improvement and
evaluation uses remain subject to the choices described in the Privacy Policy.


7. ACCEPTABLE USE

You may not:

• use the Service unlawfully or violate another person's rights;
• upload, enter, or transmit material you do not have the right to use;
• harass, stalk, exploit, or endanger another person;
• attempt to access another account or nonpublic system;
• bypass usage limits, purchase checks, security controls, or rate limits;
• interfere with, overload, damage, or disrupt the Service;
• introduce malware or use automated scraping, bots, or bulk extraction;
• copy, sell, rent, sublicense, or commercially exploit the Service;
• reverse engineer, decompile, disassemble, derive source code or model
  parameters, or create derivative works, except to the limited extent a
  restriction is prohibited by law or an open-source license permits it; or
• use output to build or train a competing model or service without written
  permission.

We may investigate suspected misuse and restrict access when reasonably
necessary to protect users, the Service, or legal rights.


8. FREE ACCESS AND PICKLE SENSEI PRO

Free accounts may receive a limited number of full technique ratings. The
current allowance, included Pro features, plan duration, localized price,
trial terms, and any introductory terms are displayed in the app before you
confirm a purchase. Feature descriptions are part of the offer only as shown
on the purchase screen at that time.

Pickle Sensei Pro may be offered as an auto-renewing monthly subscription, an
auto-renewing yearly subscription, or a one-time lifetime product. Availability
varies by store and region.

A. Subscriptions

Payment is charged to your Apple App Store or Google Play account when you
confirm the purchase. A subscription automatically renews for another period
of the same duration unless you cancel at least 24 hours before the end of the
current period. Your store account may be charged for renewal within 24 hours
before the current period ends. You can manage or cancel the subscription in
your store account settings. Deleting the app or your Pickle Sensei account
does not cancel a store subscription.

B. Free trials and introductory offers

If an eligible trial or introductory offer is displayed, its duration and
post-offer price are shown before purchase. Unless canceled at least 24 hours
before the trial or introductory period ends, it converts to the displayed
paid subscription and renews automatically. Eligibility and redemption are
determined by the applicable store and may be limited to one offer per user or
subscription group.

C. Lifetime product

A lifetime product, where offered, is a one-time, non-renewing purchase. It
provides access to the purchased Pro tier for the operating lifetime of the
Pickle Sensei Service, subject to these Terms, applicable law, and store rules.
It is not a promise that the Service or every feature will exist forever, and
it is not transferable between unrelated store accounts.

D. Prices, taxes, restoration, and refunds

Prices and currencies come from the applicable store and may include or add
tax as required. We may change future prices or offerings; a store handles
required notice or consent for subscription-price changes. Purchase
restoration requires the store account that owns or is entitled to the
purchase and successful store verification.

Apple or Google, not Pickle Sensei, processes payment and controls store
refunds, billing disputes, cancellations, and purchase eligibility under its
rules. Except where law or store policy requires otherwise, fees are
nonrefundable and there are no credits for partially used periods.


9. THIRD-PARTY SERVICES AND CONTENT

The Service relies on or may link to third-party services, including Apple,
Google, Supabase, RevenueCat, YouTube, and Vimeo. Your use of them may be
governed by separate terms and privacy policies. You must comply with
applicable third-party terms, including store usage rules, network-service
terms, and video-provider terms.

Third-party instructional media belongs to its respective creator or rights
holder and is provided for convenient access. A link, embed, attribution, or
reference does not mean Pickle Sensei owns or endorses all third-party
content. Availability and accuracy of external content are controlled by the
provider, and we may replace or remove it.


10. PRIVACY

Our Privacy Policy explains what information the Service processes and the
choices available to you. It is incorporated into these Terms by reference.
Camera, microphone, photo selection, notifications, optional model-
improvement processing, and optional evaluation processing remain subject to
the permissions and choices described there.


11. SERVICE CHANGES AND AVAILABILITY

We may add, change, suspend, or discontinue features to maintain security,
comply with law, improve the product, address technical or provider changes,
or operate the Service responsibly. We will provide notice or remedies when
required by law. Features, models, drills, supported strokes, devices, and
store offerings may differ by region, platform, app version, or account tier.

The Service may be interrupted by maintenance, network failure, store or
provider outages, device limitations, or events outside our reasonable
control. You are responsible for keeping any device-only clip or information
you need; synced data and device-local data are not a guaranteed archival or
backup service.


12. SUSPENSION, TERMINATION, AND ACCOUNT DELETION

You may stop using the Service at any time. A synced account can be
permanently deleted through Settings → Manage account → Delete account. The
optional survey may be skipped. Account deletion removes associated data as
described in the Privacy Policy but does not cancel a subscription, issue a
refund, erase a clip stored only on your phone, or delete your Apple or Google
account. The backend also deletes the canonical RevenueCat customer record and,
for Sign in with Apple accounts with a stored revocation credential, revokes
the app's Apple authorization. A legacy Apple account without that credential
is still deleted and the app directs you to disconnect Pickle Sensei manually
in Apple Account settings. Cancel any auto-renewing subscription through the
applicable store.

We may suspend or terminate access if you materially or repeatedly violate
these Terms, create security or legal risk, or use the Service fraudulently.
Where appropriate, we will provide notice and a reasonable opportunity to
remedy the issue. Terms that by their nature should survive—such as ownership,
payment obligations already incurred, disclaimers, liability limits, and
dispute provisions—survive termination.


13. DISCLAIMERS

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE SERVICE AND ALL OUTPUT,
CONTENT, AND THIRD-PARTY MATERIAL ARE PROVIDED "AS IS" AND "AS AVAILABLE."
PICKLE SENSEI DISCLAIMS EXPRESS, IMPLIED, AND STATUTORY WARRANTIES, INCLUDING
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, ACCURACY, QUIET ENJOYMENT,
NONINFRINGEMENT, AND WARRANTIES ARISING FROM COURSE OF DEALING OR USAGE.

WE DO NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, SECURE,
COMPATIBLE WITH EVERY DEVICE, OR THAT AN ANALYSIS, SCORE, RECOMMENDATION, OR
EXTERNAL RESOURCE WILL BE ACCURATE OR ACHIEVE A PARTICULAR RESULT.

SOME JURISDICTIONS DO NOT ALLOW CERTAIN DISCLAIMERS. NOTHING IN THESE TERMS
EXCLUDES A WARRANTY OR CONSUMER RIGHT THAT CANNOT LAWFULLY BE EXCLUDED.


14. LIMITATION OF LIABILITY

TO THE MAXIMUM EXTENT PERMITTED BY LAW, PICKLE SENSEI AND ITS PROVIDERS WILL
NOT BE LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, PUNITIVE, OR
CONSEQUENTIAL DAMAGES, OR FOR LOST PROFITS, LOST REVENUE, LOST DATA, BUSINESS
INTERRUPTION, REPUTATIONAL LOSS, OR THE COST OF A SUBSTITUTE SERVICE, ARISING
FROM OR RELATED TO THE SERVICE, EVEN IF ADVISED THAT SUCH DAMAGE IS POSSIBLE.

TO THE MAXIMUM EXTENT PERMITTED BY LAW, PICKLE SENSEI'S TOTAL LIABILITY FOR
ALL CLAIMS ARISING FROM OR RELATED TO THE SERVICE WILL NOT EXCEED THE GREATER
OF (A) THE AMOUNT YOU PAID FOR THE SERVICE DURING THE 12 MONTHS BEFORE THE
EVENT GIVING RISE TO THE CLAIM OR (B) USD $50.

THESE LIMITS DO NOT APPLY TO LIABILITY THAT CANNOT BE LIMITED BY LAW,
INCLUDING LIABILITY FOR FRAUD, WILLFUL MISCONDUCT, OR PERSONAL INJURY TO THE
EXTENT CAUSED BY NEGLIGENCE WHERE SUCH A LIMIT IS PROHIBITED. YOUR LOCAL LAW
MAY GIVE YOU ADDITIONAL RIGHTS.


15. RESPONSIBILITY FOR CLAIMS

You are responsible for losses and third-party claims resulting from your
unlawful use of the Service, your violation of another person's recording or
privacy rights, or content you provide without necessary rights, but only to
the extent permitted by applicable law and caused by your conduct. This
section does not require a consumer to indemnify Pickle Sensei for Pickle
Sensei's own negligence, unlawful conduct, or breach of these Terms.


16. DISPUTES AND APPLICABLE LAW

Before filing a formal claim, you and Pickle Sensei agree to make a reasonable
good-faith effort to resolve it by contacting ${SUPPORT_EMAIL}. This does not
prevent either party from seeking urgent relief or using a small-claims,
consumer-protection, regulatory, or other process that cannot lawfully be
waived.

These Terms and any dispute arising from them or the Service are governed by
the laws of the State of California, without regard to conflict-of-laws rules.
Subject to any small-claims right and any mandatory consumer-protection or
venue right that cannot lawfully be waived, you and Pickle Sensei consent to
exclusive personal jurisdiction and venue in the state courts located in San
Diego County, California, and the United States federal courts with
jurisdiction over San Diego County, California. The United Nations Convention
on Contracts for the International Sale of Goods does not apply.


17. APPLE APP STORE TERMS

If you obtained the app through Apple's App Store, Apple's Licensed
Application End User License Agreement (the "Apple Standard EULA") governs
the license to the iOS application unless a valid custom EULA is presented by
the application provider. These Terms supplement the Apple Standard EULA for
the Pickle Sensei account, content, subscriptions, and Service. If there is a
conflict concerning the app license, the Apple Standard EULA controls.

The Apple Standard EULA is available at:
https://www.apple.com/legal/internet-services/itunes/dev/stdeula/

Apple is not responsible for operating or supporting Pickle Sensei. Questions,
complaints, or claims about the Service should be directed to the Pickle Sensei
contact point below. Apple controls App Store payments, refunds, and store
account management under its own rules.


18. CHANGES TO THESE TERMS

We may revise these Terms to reflect Service, legal, security, or provider
changes. We will post the revised Terms, change the date above, and provide
additional notice when required. If a material change requires consent, we
will request it. Continued use after the effective date of a valid update
constitutes acceptance where permitted by law; otherwise, you may stop using
the Service and delete your account.


19. GENERAL

If a provision is unenforceable, it will be enforced to the maximum lawful
extent and the remaining provisions will remain effective. A failure to
enforce a provision is not a waiver. You may not assign these Terms without
our consent; we may assign them as part of a merger, acquisition,
reorganization, or transfer of the Service, subject to applicable law. These
Terms, the Privacy Policy, the applicable purchase disclosure, and the
applicable store terms are the entire agreement concerning the Service,
except for terms that cannot legally be limited or excluded.


20. CONTACT

Questions, complaints, support requests, and legal notices:
${LEGAL_OWNER}
${CONTACT_ADDRESS}
${SUPPORT_EMAIL}
`;
