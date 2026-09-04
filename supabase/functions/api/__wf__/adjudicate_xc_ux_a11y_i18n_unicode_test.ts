/**
 * Adjudication reproduction for area xc-ux-a11y-i18n (Unicode):
 * sanitizeUserText strips U+200C (ZWNJ) / U+200D (ZWJ), which are
 * orthographically required in Persian, Sinhala and Indic scripts and hold
 * emoji ZWJ sequences together.
 *
 * Default run pins the defect observed on 4d812e1a:
 *   (cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json adjudicate_xc_ux_a11y_i18n_unicode_test.ts)
 * Acceptance run for a fix (must exit 0 once fixed):
 *   (cd supabase/functions/api/__wf__ && ADJ_EXPECTED=1 deno test -A --no-check --config deno.json adjudicate_xc_ux_a11y_i18n_unicode_test.ts)
 */
import { assertEquals } from "@std/assert";
import { sanitizeUserText } from "../http.ts";

const EXPECTED = Deno.env.get("ADJ_EXPECTED") === "1";

const NAMES: ReadonlyArray<readonly [label: string, input: string]> = [
  ["Persian Alireza (ZWNJ)", "علی\u200cرضا"],
  ["Sinhala Sri (ZWJ conjunct)", "ශ්\u200dරී"],
  ["Devanagari kSa half-form (ZWJ)", "क्\u200dष"],
  ["Emoji family (ZWJ sequence)", "👨\u200d👩\u200d👧\u200d👦"],
];

const graphemes = (s: string) => [...new Intl.Segmenter().segment(s)].length;

Deno.test({
  name: "B1 expected: ZWNJ/ZWJ inside a name survive sanitizeUserText unchanged",
  ignore: !EXPECTED,
  fn() {
    for (const [label, input] of NAMES) {
      assertEquals(sanitizeUserText(input, 40), input, label);
    }
    // Spoofing/format characters that are NOT orthographic must still go.
    assertEquals(sanitizeUserText("Ra\u200bun\u202eak\ufeff\u200e", 40), "Raunak");
  },
});

Deno.test({
  name: "B1 reproduction (4d812e1a): ZWNJ/ZWJ are stripped, splitting the emoji family into 4 graphemes",
  ignore: EXPECTED,
  fn() {
    assertEquals(sanitizeUserText("علی\u200cرضا", 40), "علیرضا");
    assertEquals(sanitizeUserText("ශ්\u200dරී", 40), "ශ්රී");
    const family = sanitizeUserText("👨\u200d👩\u200d👧\u200d👦", 40);
    assertEquals(graphemes("👨\u200d👩\u200d👧\u200d👦"), 1);
    assertEquals(graphemes(family), 4);
  },
});
