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
      "not an official league, tournament, DUPR, medical, fitness, or professional coaching assessment",
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
