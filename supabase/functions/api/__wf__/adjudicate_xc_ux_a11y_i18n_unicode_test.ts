// Adjudication reproduction for xc-ux-a11y-i18n::XC-UAI-03 — sanitizeUserText
// must keep U+200C ZERO WIDTH NON-JOINER and U+200D ZERO WIDTH JOINER. Both are
// format characters that Persian, Indic scripts and emoji ZWJ sequences need
// to render correctly; stripping them corrupts a user's name (baseline
// 4d812e1a: CONTROL_AND_SPOOFING_CHARS covered the whole range \u200b-\u200f).
// The other zero-width / bidi / BOM characters stay stripped.
//
// Modes:
//   default / ADJ_EXPECTED=1 — assert the EXPECTED behaviour (fails on the
//                              unfixed code, passes once http.ts is fixed).
//   ADJ_EXPECTED=0           — characterization: print what the current
//                              build does and assert only the invariants
//                              that hold before AND after the fix.
//
//   cd supabase/functions/api/__wf__ && ADJ_EXPECTED=1 deno test -A --no-check --config deno.json adjudicate_xc_ux_a11y_i18n_unicode_test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import { sanitizeUserText } from "../http.ts";

const EXPECTED_MODE = Deno.env.get("ADJ_EXPECTED") !== "0";
const MAX = 40;

const ZWNJ = "\u200c";
const ZWJ = "\u200d";

const PRESERVED: ReadonlyArray<{ label: string; text: string }> = [
  { label: "Persian name with ZWNJ", text: `علی${ZWNJ}رضا` },
  { label: "Sinhala with ZWJ", text: `ශ්${ZWJ}රී` },
  { label: "Devanagari with ZWJ", text: `क्${ZWJ}ष` },
  { label: "emoji ZWJ family sequence", text: `👨${ZWJ}👩${ZWJ}👧${ZWJ}👦` },
];

function graphemes(text: string): number {
  return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text))
    .length;
}

function codePoints(text: string): string {
  return Array.from(text)
    .map((cp) => `U+${cp.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`)
    .join(" ");
}

Deno.test("sanitizeUserText keeps ZWNJ (U+200C) and ZWJ (U+200D) inside words", () => {
  for (const { label, text } of PRESERVED) {
    const out = sanitizeUserText(text, MAX);
    if (!EXPECTED_MODE) {
      console.log(`[characterization] ${label}: ${codePoints(text)} -> ${codePoints(out)}`);
      continue;
    }
    assertEquals(out, text, `${label}: ${codePoints(text)} -> ${codePoints(out)}`);
  }
});

Deno.test("sanitizeUserText keeps an emoji ZWJ sequence as ONE grapheme", () => {
  const family = `👨${ZWJ}👩${ZWJ}👧${ZWJ}👦`;
  const out = sanitizeUserText(family, MAX);
  if (!EXPECTED_MODE) {
    console.log(`[characterization] family graphemes: ${graphemes(family)} -> ${graphemes(out)}`);
    return;
  }
  assertEquals(graphemes(out), 1, `got ${graphemes(out)} graphemes: ${codePoints(out)}`);
});

Deno.test(
  "sanitizeUserText still strips ZWSP (U+200B), LRM/RLM (U+200E/U+200F), bidi controls and BOM",
  () => {
    assertEquals(sanitizeUserText("a\u200bb\u200ec", MAX), "abc");
    assertEquals(sanitizeUserText("a\u200fb\u202ec\u2066d\ufeffe", MAX), "abcde");
    assertEquals(sanitizeUserText("Ra\u200bun\u202eak\ufeff", MAX), "Raunak");
  },
);

Deno.test(
  "joiners with no join context (leading, trailing, next to whitespace, alone) are dropped",
  () => {
    if (!EXPECTED_MODE) {
      console.log(
        `[characterization] "${codePoints(`${ZWJ}Ali${ZWNJ}`)}" -> "${codePoints(sanitizeUserText(`${ZWJ}Ali${ZWNJ}`, MAX))}"`,
      );
      return;
    }
    assertEquals(sanitizeUserText(`${ZWJ}Ali${ZWNJ}`, MAX), "Ali");
    assertEquals(sanitizeUserText(`Ali ${ZWNJ} Reza`, MAX), "Ali Reza");
    assertEquals(sanitizeUserText(`Ali${ZWNJ} ${ZWJ}Reza`, MAX), "Ali Reza");
    assertEquals(sanitizeUserText(`${ZWJ}${ZWNJ}${ZWJ}`, MAX), "");
    assertEquals(sanitizeUserText(`  ${ZWNJ}  `, MAX), "");
  },
);

Deno.test("the code-point cap still counts kept joiners (matches the DB char_length caps)", () => {
  const name = `علی${ZWNJ}رضا`;
  assertEquals(Array.from(name).length, 7);
  const out = sanitizeUserText(name, 7);
  if (!EXPECTED_MODE) {
    console.log(`[characterization] cap 7: ${codePoints(name)} -> ${codePoints(out)}`);
  } else {
    assertEquals(out, name);
  }
  // Cap 4 lands exactly on the ZWNJ: the cut must not end on a dangling joiner.
  const cut = sanitizeUserText(name, 4);
  assert(Array.from(cut).length <= 4);
  assert(cut.isWellFormed());
  assert(!cut.endsWith(ZWNJ) && !cut.endsWith(ZWJ), "a cut never ends on a dangling joiner");
  if (EXPECTED_MODE) assertEquals(cut, "علی");
});
