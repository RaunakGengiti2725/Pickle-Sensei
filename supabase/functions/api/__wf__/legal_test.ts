// App Review 3.1.2 / 5.1.1 content checks for supabase/functions/api/legal.ts.
//   deno test --allow-all --no-check --node-modules-dir=none supabase/functions/api/__wf__/

import { assert, assertMatch, assertStringIncludes } from "jsr:@std/assert@1";
import { PRIVACY_POLICY_TEXT, SUPPORT_TEXT, TERMS_TEXT } from "../legal.ts";

const SUPPORT_EMAIL = "picklesenseidev@gmail.com";
const LEGAL_OWNER = "Raunak Gengiti";
const CONTACT_ADDRESS = "6737 Elegante Way, San Diego, California 92130, United States";

function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

Deno.test("both documents identify the service and expose the same real support mailbox", () => {
  for (const text of [PRIVACY_POLICY_TEXT, TERMS_TEXT]) {
    assertStringIncludes(text, "Pickle Sensei");
    assertStringIncludes(text, SUPPORT_EMAIL);
    assertStringIncludes(text, LEGAL_OWNER);
    assertStringIncludes(text, CONTACT_ADDRESS);
    assert(!/example\.com|TODO|TBD|lorem|insert (name|address)/i.test(text));
  }
});

Deno.test("support page provides real contact, troubleshooting, and account deletion help", () => {
  const text = flat(SUPPORT_TEXT);
  for (const needle of [
    SUPPORT_EMAIL,
    LEGAL_OWNER,
    CONTACT_ADDRESS,
    "Sign in with Apple or Sign in with Google",
    "restore purchases",
    "Stop and Analyze",
    "Deleting an account does not cancel an Apple subscription",
    "To request access to, correction of, deletion of, or a portable copy",
    "does not sell personal information",
    "/privacy",
    "/terms",
  ]) {
    assertStringIncludes(text, needle);
  }
  assert(!/example\.com|TODO|TBD|lorem/i.test(SUPPORT_TEXT));
});

Deno.test(
  "terms contain complete subscription, trial, lifetime, refund, and deletion disclosures",
  () => {
    const text = flat(TERMS_TEXT);
    for (const needle of [
      "auto-renewing monthly subscription, an auto-renewing yearly subscription, or a one-time lifetime product",
      "unless you cancel at least 24 hours before the end of the current period",
      "charged for renewal within 24 hours before the current period ends",
      "manage or cancel the subscription in your store account settings",
      "post-offer price are shown before purchase",
      "one-time, non-renewing purchase",
      "controls store refunds",
      "Deleting the app or your Pickle Sensei account does not cancel a store subscription",
    ]) {
      assertStringIncludes(text, needle);
    }
  },
);

Deno.test(
  "terms explain product limits, health safety, consumer carve-outs, and the Apple license",
  () => {
    const text = flat(TERMS_TEXT);
    for (const needle of [
      "not an official league, tournament, player-rating, medical, fitness, or professional coaching assessment",
      "does not provide medical advice, diagnosis, treatment, physical therapy, or emergency services",
      "NOTHING IN THESE TERMS EXCLUDES A WARRANTY OR CONSUMER RIGHT THAT CANNOT LAWFULLY BE EXCLUDED",
      "Apple Standard EULA",
      "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/",
      "Apple is not responsible for operating or supporting Pickle Sensei",
    ]) {
      assertStringIncludes(text, needle);
    }
  },
);

Deno.test("privacy discloses a required onboarding name without legal-name verification", () => {
  const text = flat(PRIVACY_POLICY_TEXT);
  for (const needle of [
    "Onboarding requires a name for account personalization",
    "You may enter your preferred name or a nickname",
    "we do not require or verify your legal name for this field",
    "We use it to address you in the app",
    "skill level, dominant hand, training goals, and your biggest problem",
    "The questionnaire is required",
    'You may choose "Prefer not to say" for gender',
    "Completed answers are stored on your device before sign-in",
    "linked to your account and synced to our servers after you sign in",
  ]) {
    assertStringIncludes(text, needle);
  }
  assert(!/optional first name|name \(optional\)/i.test(text));
});

Deno.test("privacy distinguishes the provider display name, which may be absent", () => {
  const accountInfo =
    flat(PRIVACY_POLICY_TEXT)
      .split("A. Account and sign-in information")[1]
      ?.split("B. Coaching profile and preferences")[0] ?? "";
  assertStringIncludes(accountInfo, "This may include your email address, display name");
  assertStringIncludes(accountInfo, "Apple or Google may not supply a display name");
  assertStringIncludes(
    accountInfo,
    "Any provider display name is separate from the name you enter during onboarding",
  );
  assert(!/must provide|required display name|verified legal name/i.test(accountInfo));
});

Deno.test(
  "support and terms allow nicknames without conflating onboarding and provider names",
  () => {
    const support = flat(SUPPORT_TEXT);
    for (const needle of [
      "The name you enter in onboarding is required for account personalization",
      "Use a preferred name or nickname; it does not need to be your legal name",
      "Settings → Player shows this name",
      "Manage account shows the display name from Apple or Google, if provided, which may be different",
    ]) {
      assertStringIncludes(support, needle);
    }
    const terms = flat(TERMS_TEXT);
    assertStringIncludes(
      terms,
      "You may use a preferred name or nickname for the required onboarding name",
    );
    assertStringIncludes(terms, "You do not need to provide a legal name for that field");
    assertStringIncludes(terms, "One person may not impersonate another");
  },
);

Deno.test(
  "submission name disclosures describe the checked public policy and required onboarding name",
  async () => {
    const text = flat(
      await Deno.readTextFile(new URL("../../../../docs/APP_STORE_SUBMISSION.md", import.meta.url)),
    );
    for (const needle of [
      "The public privacy page was checked on 2026-09-11",
      "Onboarding requires a name for account personalization",
      "A preferred name or nickname is accepted, without legal-name verification",
      "Older stored profiles may lack the onboarding name",
      "name or nickname (required)",
      "Provider display name, if available, and required onboarding name or nickname",
    ]) {
      assert(text.includes(needle), `Missing name disclosure: ${needle}`);
    }
    assert(!/optional first name|name \(optional\)/i.test(text));
  },
);

Deno.test(
  "the build 4 disclosure records its update date and retains ownership, age, and international scope",
  () => {
    for (const text of [SUPPORT_TEXT, PRIVACY_POLICY_TEXT, TERMS_TEXT]) {
      assertStringIncludes(text, "Last updated: September 11, 2026");
    }
    const privacy = flat(PRIVACY_POLICY_TEXT);
    assertStringIncludes(privacy, `${LEGAL_OWNER}, an individual`);
    assertStringIncludes(privacy, "business or data controller responsible for Pickle Sensei");
    assertStringIncludes(privacy, "countries other than the one where you live");
    assertStringIncludes(privacy, "honor mandatory local rights");
    assertStringIncludes(privacy, "not directed to children under 13");
    assertStringIncludes(privacy, "random installation identifier");
    assertStringIncludes(privacy, "server-issued device identifier");
    assertStringIncludes(privacy, "prevent an allocation from being spent twice");
    assertStringIncludes(flat(TERMS_TEXT), "You must be at least 13 years old");
  },
);

Deno.test(
  "privacy policy accurately separates device-only media from synced structured data",
  () => {
    const text = flat(PRIVACY_POLICY_TEXT);
    for (const needle of [
      "raw court video, camera frames, audio recorded with a clip, and body-pose landmarks stay on your device",
      "Stroke analysis runs on your device",
      "does not upload those raw media or pose-landmark files",
      "structured records are stored locally",
      "sent to our servers",
      "do not contain the raw video, raw audio, camera frames, or pose-landmark file",
      "protected Keychain or Keystore",
      "Google Sign-In software included in the app declares that it may process",
      "does not request device location permission for Google sign-in",
    ]) {
      assertStringIncludes(text, needle);
    }
  },
);

Deno.test(
  "privacy policy details consent data without falsely calling linked evaluation records anonymous",
  () => {
    const text = flat(PRIVACY_POLICY_TEXT);
    for (const needle of [
      "Optional model-improvement permission is off by default",
      "feedback you submit and the associated structured analysis record",
      "Evaluation telemetry is a separate, opt-in category",
      "These records are linked to your Pickle Sensei account while the account exists; they are not anonymous",
      "Withdrawing an optional permission stops new records",
    ]) {
      assertStringIncludes(text, needle);
    }
    assert(!/evaluation telemetry[^.]{0,120}anonymized/i.test(text));
  },
);

Deno.test(
  "privacy policy identifies processors, purposes, retention, choices, and deletion effects",
  () => {
    const text = flat(PRIVACY_POLICY_TEXT);
    for (const needle of [
      "Supabase provides authentication, database, and Edge Function hosting",
      "RevenueCat receives an internal account identifier and purchase-related information",
      "Upstash may provide short-lived cache and rate-limit infrastructure",
      "YouTube or Vimeo may receive ordinary web-request information",
      "network-derived coarse location",
      "may show its own advertisements",
      "normally expire within ten minutes",
      "scheduled for deletion after 90 days",
      "Settings → Manage account → Delete account",
      "does not cancel an auto-renewing subscription",
      "ask us for access, correction, deletion, or a portable copy",
      "will not discriminate against you for exercising an applicable privacy right",
      "permanently deletes the customer record identified by the internal account identifier from RevenueCat",
      "backend revokes the stored Apple authorization before it deletes the account",
    ]) {
      assertStringIncludes(text, needle);
    }
  },
);

Deno.test(
  "privacy policy and support page disclose the free-rating record that outlives account deletion",
  () => {
    // Mirrors migration 20260902150000_free_rating_identity_ledger.sql:
    // public.free_rating_ledger keeps SHA-256(provider:sub) → scored count
    // with no FK, so the free rating (one since 20260910170000) cannot be
    // re-earned by deleting and re-creating the account. Retaining anything
    // past deletion must be stated, with its basis, in §7 (retention) and its
    // effect in §8.
    const privacy = flat(PRIVACY_POLICY_TEXT);
    for (const needle of [
      "one-way hash (SHA-256) of your sign-in provider's account identifier",
      "number of scored analyses recorded under it",
      "contains no email address, name, or Pickle Sensei account identifier",
      "legitimate-interest basis of preventing free-tier abuse",
      "survives account deletion for that reason",
      "A free rating you have already used is not restored by deleting the account",
      "sign in again with the same Apple or Google account",
      "free rating is not offered a second time",
    ]) {
      assertStringIncludes(privacy, needle);
    }
    assertStringIncludes(
      flat(SUPPORT_TEXT),
      "does not restore free ratings that were already used",
    );
  },
);

Deno.test("privacy policy states important negative disclosures", () => {
  const text = flat(PRIVACY_POLICY_TEXT);
  for (const needle of [
    "do not receive or store your full payment-card number",
    "precise or coarse GPS location",
    "address-book contacts",
    "do not request the advertising identifier",
    "do not track activity across other companies' apps or websites for advertising",
    "does not use this information for cross-app tracking",
    "do not sell personal information",
    "not directed to children under 13",
    "No storage or transmission system is completely secure",
  ]) {
    assertStringIncludes(text, needle);
  }
});

Deno.test(
  "terms select California law and a specific San Diego forum with consumer carve-outs",
  () => {
    const text = flat(TERMS_TEXT);
    for (const needle of [
      "laws of the State of California",
      "state courts located in San Diego County, California",
      "United States federal courts with jurisdiction over San Diego County, California",
      "mandatory consumer-protection or venue right that cannot lawfully be waived",
    ]) {
      assertStringIncludes(text, needle);
    }
  },
);

Deno.test("legal documents are substantive and contain numbered sections", () => {
  assert(PRIVACY_POLICY_TEXT.length > 10_000);
  assert(TERMS_TEXT.length > 10_000);
  assertMatch(PRIVACY_POLICY_TEXT, /\n13\. CONTACT\n/);
  assertMatch(TERMS_TEXT, /\n20\. CONTACT\n/);
});

Deno.test("legal text contains no control or bidi characters (served as text/plain)", () => {
  const isBad = (cp: number) =>
    (cp < 0x20 && cp !== 0x0a) ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069);
  for (const text of [SUPPORT_TEXT, PRIVACY_POLICY_TEXT, TERMS_TEXT]) {
    for (const ch of text) {
      assert(!isBad(ch.codePointAt(0) ?? 0), `bad char U+${ch.codePointAt(0)?.toString(16)}`);
    }
  }
});
