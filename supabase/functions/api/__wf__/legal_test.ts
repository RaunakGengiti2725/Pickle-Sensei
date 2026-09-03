// App Review 3.1.2 / 5.1.1 content checks for supabase/functions/api/legal.ts.
//   deno test --allow-all --no-check --node-modules-dir=none supabase/functions/api/__wf__/

import { assert, assertMatch, assertStringIncludes } from "jsr:@std/assert@1";
import { PRIVACY_POLICY_TEXT, TERMS_TEXT } from "../legal.ts";

const SUPPORT_EMAIL = "picklesenseidev@gmail.com";

Deno.test("both documents expose the same real support mailbox", () => {
  assertStringIncludes(PRIVACY_POLICY_TEXT, SUPPORT_EMAIL);
  assertStringIncludes(TERMS_TEXT, SUPPORT_EMAIL);
  assert(!/example\.com|TODO|TBD|lorem/i.test(PRIVACY_POLICY_TEXT + TERMS_TEXT));
});

Deno.test(
  "terms describe auto-renewing subscriptions per 3.1.2 (renewal, 24h cancel rule, store management, prices in-app)",
  () => {
    const flat = TERMS_TEXT.replace(/\s+/g, " ");
    assertStringIncludes(
      flat,
      "auto-renewing monthly or yearly subscription, or a one-time lifetime purchase",
    );
    assertMatch(
      flat,
      /renew automatically unless canceled at least 24 hours before the end of the current period/,
    );
    assertMatch(flat, /managed or canceled in your store account settings/);
    assertStringIncludes(flat, "Prices are shown in the app before purchase");
    assertStringIncludes(flat, "charged to your App Store or Google Play account");
  },
);

Deno.test("privacy policy covers the 5.1.1 disclosures the app actually relies on", () => {
  const flat = PRIVACY_POLICY_TEXT.replace(/\s+/g, " ");
  for (const needle of [
    "Court video and camera frames — YOUR DEVICE ONLY",
    "Video is never uploaded",
    "ONLY if you opt in under Settings → Data & consent",
    "You can delete your account at any time in Settings → Delete account",
    "not directed at children under 13",
    "per-user row-level security",
    "No payment card numbers",
    "No precise location",
    "no sale of your data to anyone",
  ]) {
    assertStringIncludes(flat, needle);
  }
});

Deno.test("legal text contains no control or bidi characters (served as text/plain)", () => {
  const isBad = (cp: number) =>
    (cp < 0x20 && cp !== 0x0a) ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069);
  for (const text of [PRIVACY_POLICY_TEXT, TERMS_TEXT]) {
    for (const ch of text)
      assert(!isBad(ch.codePointAt(0) ?? 0), `bad char U+${ch.codePointAt(0)?.toString(16)}`);
  }
});
