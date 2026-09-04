// Cross-cutting i18n property tests for `sanitizeUserText` (http.ts).
//
// Seeded and replayable: XC_I18N_SEED (default 20260904), XC_I18N_ITERS
// (default 20000 per property). When XC_I18N_OUT is set, a JSON table with
// every counterexample (exact input, code points, seed, iteration) plus
// timing / heap numbers is written there.
//
// Two kinds of tests live here, following the repo's `REPRO:` convention:
//   * invariant tests — MUST hold; a failure is a defect.
//   * `REPRO:` tests — pin CURRENT behaviour that the harness identified as
//     an i18n defect (assertions state what the code does today).
//
//   XC_I18N_OUT=/tmp/xc deno test -A --no-check --config deno.json xc_i18n_sanitize_property_test.ts

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { sanitizeUserText } from "../http.ts";
import {
  ALPHABET_NAMES,
  CLUSTERS,
  codePointsOf,
  count,
  FREE_TEXT,
  itersFromEnv,
  KB64,
  makeRng,
  measureHeap,
  NAMES,
  randomGraphemeName,
  randomMixedString,
  SAFE_CLUSTERS,
  seedFromEnv,
  stringOfBytes,
  writeArtifact,
} from "./xc_i18n_unicode_corpus.ts";

const SEED = seedFromEnv(20260904);
const ITERS = itersFromEnv(20_000);
const CAPS = [40, 64, 200, 500, 512, 1000, 2000] as const;

/** Every Unicode White_Space code point other than U+0020. */
const NON_ASCII_WS = /[\t\n\r\v\f\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
// Chars the sanitizer contract says must never survive.
const FORBIDDEN =
  // deno-lint-ignore no-control-regex
  /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/; // eslint-disable-line no-control-regex

interface Counterexample {
  property: string;
  seed: number;
  iteration: number;
  cap?: number;
  alphabets?: string[];
  inputJson: string;
  inputCodePoints: string[];
  outputJson?: string;
  detail: string;
}

interface PropertyRow {
  property: string;
  iterations: number;
  failures: number;
  ms: number;
}

const counterexamples: Counterexample[] = [];
const rows: PropertyRow[] = [];

function runProperty(
  property: string,
  iterations: number,
  body: (
    i: number,
    fail: (ce: Omit<Counterexample, "property" | "seed" | "iteration">) => void,
  ) => void,
): number {
  const started = performance.now();
  let failures = 0;
  for (let i = 0; i < iterations; i += 1) {
    body(i, (ce) => {
      failures += 1;
      if (counterexamples.filter((c) => c.property === property).length < 50) {
        counterexamples.push({ property, seed: SEED, iteration: i, ...ce });
      }
    });
  }
  rows.push({
    property,
    iterations,
    failures,
    ms: Math.round(performance.now() - started),
  });
  return failures;
}

const ce = (text: string, detail: string, extra: Partial<Counterexample> = {}) => ({
  inputJson: JSON.stringify(text),
  inputCodePoints: codePointsOf(text),
  detail,
  ...extra,
});

// ─── Invariants ──────────────────────────────────────────────────────────────

Deno.test(
  "property: output never exceeds cap in code points, never contains forbidden chars, is well-formed",
  () => {
    const rng = makeRng(SEED ^ 0x1001);
    const failures = runProperty("cap_forbidden_wellformed", ITERS, (_, fail) => {
      const cap = rng.pick(CAPS);
      const { text, alphabets } = randomMixedString(rng, 1 + rng.int(300));
      const out = sanitizeUserText(text, cap);
      const problems: string[] = [];
      if (count.cp(out) > cap) problems.push(`cp ${count.cp(out)} > cap ${cap}`);
      if (FORBIDDEN.test(out)) problems.push("forbidden char survived");
      if (!out.isWellFormed()) problems.push("lone surrogate survived");
      if (out !== out.trim()) problems.push("leading/trailing whitespace");
      if (/\s\s/.test(out)) problems.push("whitespace run");
      if (NON_ASCII_WS.test(out)) {
        problems.push("non-ASCII whitespace survived");
      }
      if (count.bytes(out) > cap * 4) {
        problems.push(`bytes ${count.bytes(out)} > 4*cap`);
      }
      if (problems.length) {
        fail(
          ce(text, problems.join("; "), {
            cap,
            alphabets,
            outputJson: JSON.stringify(out),
          }),
        );
      }
    });
    assertEquals(failures, 0);
  },
);

Deno.test("property: sanitizeUserText is idempotent", () => {
  const rng = makeRng(SEED ^ 0x1002);
  const failures = runProperty("idempotent", ITERS, (_, fail) => {
    const cap = rng.pick(CAPS);
    const { text, alphabets } = randomMixedString(rng, 1 + rng.int(300));
    const once = sanitizeUserText(text, cap);
    const twice = sanitizeUserText(once, cap);
    if (once !== twice) {
      fail(
        ce(text, "sanitize(sanitize(x)) != sanitize(x)", {
          cap,
          alphabets,
          outputJson: JSON.stringify([once, twice]),
        }),
      );
    }
  });
  assertEquals(failures, 0);
});

Deno.test("property: a smaller cap yields a prefix of the larger cap's output", () => {
  const rng = makeRng(SEED ^ 0x1003);
  const failures = runProperty("cap_monotone_prefix", ITERS, (_, fail) => {
    const { text, alphabets } = randomMixedString(rng, 1 + rng.int(300));
    const small = 1 + rng.int(100);
    const large = small + 1 + rng.int(300);
    const a = sanitizeUserText(text, small);
    const b = sanitizeUserText(text, large);
    if (!b.startsWith(a)) {
      fail(
        ce(text, `sanitize(x,${small}) is not a prefix of sanitize(x,${large})`, {
          alphabets,
          outputJson: JSON.stringify([a, b]),
        }),
      );
    }
  });
  assertEquals(failures, 0);
});

Deno.test(
  "property: text made only of safe clusters (no ZWJ/ZWNJ, no whitespace) passes through unchanged under a generous cap",
  () => {
    const rng = makeRng(SEED ^ 0x1004);
    const failures = runProperty("safe_clusters_unchanged", ITERS, (_, fail) => {
      const n = 1 + rng.int(20);
      const { text, clusters } = randomGraphemeName(rng, n, SAFE_CLUSTERS);
      const out = sanitizeUserText(text, 200);
      if (out !== text) {
        fail(
          ce(text, `changed; clusters=${clusters.join(",")}`, {
            outputJson: JSON.stringify(out),
          }),
        );
      }
      if (count.graphemes(out) !== n) {
        fail(
          ce(text, `grapheme count ${count.graphemes(out)} != ${n}`, {
            outputJson: JSON.stringify(out),
          }),
        );
      }
    });
    assertEquals(failures, 0);
  },
);

Deno.test(
  "property: any 3-grapheme name built from safe clusters survives sanitizeUserText(·, 200) intact (sanitizer alone never rejects it)",
  () => {
    const rng = makeRng(SEED ^ 0x1005);
    const failures = runProperty("three_grapheme_name_sanitizer", ITERS, (_, fail) => {
      const { text, clusters } = randomGraphemeName(rng, 3, SAFE_CLUSTERS);
      const out = sanitizeUserText(text, 200);
      if (out !== text || count.graphemes(out) !== 3) {
        fail(
          ce(text, `clusters=${clusters.join(",")} -> graphemes ${count.graphemes(out)}`, {
            outputJson: JSON.stringify(out),
          }),
        );
      }
    });
    assertEquals(failures, 0);
  },
);

Deno.test(
  "property: a 64 KiB payload never passes any cap (code points <= cap, bytes <= 4*cap, and far below 64 KiB)",
  () => {
    const rng = makeRng(SEED ^ 0x1006);
    const units = [
      "a",
      "\u00e9",
      "e\u0301",
      "\u6f22",
      "\u{1f600}",
      "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}",
      "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}",
      "\u0627\u0644",
      "a\u0300\u0301\u0302\u0303",
      "\u200b",
      " ",
      "\u3000",
    ];
    const heapBefore = measureHeap();
    const timings: Array<{
      unit: string;
      cap: number;
      ms: number;
      outCp: number;
      outBytes: number;
    }> = [];
    const failures = runProperty("kb64_never_passes_cap", units.length * CAPS.length, (i, fail) => {
      const unit = units[i % units.length];
      const cap = CAPS[Math.floor(i / units.length)];
      const payload = stringOfBytes(unit, KB64 + rng.int(8));
      assert(
        count.bytes(payload) >= KB64 - 32 && count.bytes(payload) <= KB64 + 8,
        "payload size sanity",
      );
      const t0 = performance.now();
      const out = sanitizeUserText(payload, cap);
      const ms = performance.now() - t0;
      timings.push({
        unit: JSON.stringify(unit),
        cap,
        ms: Math.round(ms * 100) / 100,
        outCp: count.cp(out),
        outBytes: count.bytes(out),
      });
      if (count.cp(out) > cap || count.bytes(out) > cap * 4 || count.bytes(out) >= KB64) {
        fail({
          inputJson: `<${count.bytes(payload)} bytes of ${JSON.stringify(unit)}>`,
          inputCodePoints: codePointsOf(unit),
          cap,
          detail: `cp=${count.cp(out)} bytes=${count.bytes(out)}`,
        });
      }
    });
    const heapAfter = measureHeap();
    writeArtifact("sanitize_kb64_timings.json", {
      seed: SEED,
      heapBefore,
      heapAfter,
      timings,
    });
    assertEquals(failures, 0);
  },
);

Deno.test(
  "scale: 1 MiB and 5 MiB pathological inputs sanitize in bounded time (no regex blow-up)",
  () => {
    const sizes = [1 * 1024 * 1024, 5 * 1000 * 1000];
    const units = ["a", " ", "\u200b", "\ud83d", "\u{1f600}", "a\u0301", "\r\n"];
    const results: Array<{
      bytes: number;
      unit: string;
      ms: number;
      outCp: number;
      heapUsedAfter: number;
    }> = [];
    for (const size of sizes) {
      for (const unit of units) {
        const payload = stringOfBytes(unit, size);
        const t0 = performance.now();
        const out = sanitizeUserText(payload, 2000);
        const ms = performance.now() - t0;
        results.push({
          bytes: count.bytes(payload),
          unit: JSON.stringify(unit),
          ms: Math.round(ms),
          outCp: count.cp(out),
          heapUsedAfter: measureHeap().heapUsed,
        });
        assert(count.cp(out) <= 2000, "cap respected");
        assert(ms < 5000, `sanitize of ${size} bytes of ${JSON.stringify(unit)} took ${ms}ms`);
      }
    }
    writeArtifact("sanitize_scale_timings.json", results);
  },
);

Deno.test(
  "corpus: every named name/free-text case is recorded with u16/cp/grapheme/byte counts before and after",
  () => {
    const table = [...NAMES, ...FREE_TEXT].map((c) => {
      const out = sanitizeUserText(c.text, 200);
      return {
        name: c.name,
        inputJson: JSON.stringify(c.text),
        inputCodePoints: codePointsOf(c.text),
        outputJson: JSON.stringify(out),
        outputCodePoints: codePointsOf(out),
        unchanged: out === c.text,
        hasZwjOrZwnj: /[\u200c\u200d]/.test(c.text),
        expectUnchanged: c.expectUnchanged,
        in: {
          u16: count.u16(c.text),
          cp: count.cp(c.text),
          graphemes: count.graphemes(c.text),
          bytes: count.bytes(c.text),
        },
        out: {
          u16: count.u16(out),
          cp: count.cp(out),
          graphemes: count.graphemes(out),
          bytes: count.bytes(out),
        },
        graphemesChanged: count.graphemes(out) !== count.graphemes(c.text),
        note: c.note ?? null,
      };
    });
    writeArtifact("sanitize_corpus_matrix.json", table);
    const unexpected = table.filter((r) => r.expectUnchanged && !r.unchanged);
    // Every unexpected change must be one of the ZWJ/ZWNJ cases pinned below.
    for (const r of unexpected) {
      assert(
        r.hasZwjOrZwnj,
        `unexpected sanitizer change outside the ZWJ/ZWNJ family: ${r.name} ${r.inputJson} -> ${r.outputJson}`,
      );
    }
    // Every case that was expected to change did change.
    for (const r of table.filter((r) => !r.expectUnchanged)) {
      assert(!r.unchanged, `${r.name} was expected to change but did not`);
    }
  },
);

Deno.test(
  "corpus: RTL text (Arabic/Hebrew/Persian/Urdu, with points and harakat) is preserved byte-for-byte except ZWNJ",
  () => {
    for (const c of NAMES.filter((n) => /rtl|arabic|hebrew|persian|urdu/.test(n.name))) {
      const out = sanitizeUserText(c.text, 40);
      if (c.text.includes("\u200c")) continue; // pinned separately below
      assertEquals(out, c.text, c.name);
    }
    for (const c of FREE_TEXT.filter((n) => /rtl|bidi/.test(n.name))) {
      assertEquals(sanitizeUserText(c.text, 1000), c.text, c.name);
    }
  },
);

Deno.test(
  "corpus: combining-mark sequences (NFC and NFD) are preserved and never split when they fit the cap",
  () => {
    for (const c of CLUSTERS.filter((k) => !k.containsStripped)) {
      const name = c.text.repeat(5);
      const out = sanitizeUserText(name, 200);
      assertEquals(out, name, c.name);
      assertEquals(count.graphemes(out), 5, c.name);
    }
  },
);

// ─── Characterizations of confirmed i18n defects (REPRO: current behaviour) ──

Deno.test(
  "REPRO: ZWJ (U+200D) is stripped, so emoji ZWJ sequences are split into their parts (1 grapheme -> 4)",
  () => {
    const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}";
    assertEquals(count.graphemes(family), 1);
    const out = sanitizeUserText(family, 40);
    assertEquals(out, "\u{1f468}\u{1f469}\u{1f467}\u{1f466}");
    assertEquals(count.graphemes(out), 4);
  },
);

Deno.test("REPRO: ZWNJ (U+200C) is stripped from Persian orthography (علی‌رضا -> علیرضا)", () => {
  const alireza = "علی\u200cرضا";
  const out = sanitizeUserText(alireza, 40);
  assertNotEquals(out, alireza);
  assertEquals(out, "علیرضا");
});

Deno.test(
  "REPRO: ZWJ is stripped from Indic conjunct requests (Devanagari क्‍ष, Sinhala ශ්‍රී)",
  () => {
    assertEquals(sanitizeUserText("क्\u200dष", 40), "क्ष");
    assertEquals(sanitizeUserText("ශ්\u200dරී", 40), "ශ්රී");
  },
);

Deno.test(
  "REPRO: names consisting only of invisible/blank characters outside the strip set survive as non-empty",
  () => {
    for (const invisible of [
      "\u2060",
      "\u3164",
      "\u00ad",
      "\u034f",
      "\u180e",
      "\u115f",
      "\uffa0",
      "\u{e0041}\u{e0042}",
    ]) {
      const out = sanitizeUserText(invisible, 40);
      assertEquals(
        out,
        invisible,
        `expected ${codePointsOf(invisible).join(" ")} to pass through (current behaviour)`,
      );
      assert(out.length >= 1);
    }
  },
);

Deno.test(
  "REPRO: the code-point cap can cut a grapheme cluster, dropping its combining marks (a×39 + e\u0301 at cap 40 -> ...e)",
  () => {
    const name = "a".repeat(39) + "e\u0301";
    assertEquals(count.graphemes(name), 40);
    const out = sanitizeUserText(name, 40);
    assertEquals(out, "a".repeat(39) + "e");
    assertEquals(count.graphemes(out), 40);
    assertNotEquals(out, name);
  },
);

Deno.test(
  "property: how often does the code-point cap split a grapheme cluster? (recorded, not asserted)",
  () => {
    const rng = makeRng(SEED ^ 0x1007);
    let split = 0;
    let total = 0;
    const samples: Array<{ inputJson: string; cap: number; outputJson: string }> = [];
    for (let i = 0; i < ITERS; i += 1) {
      const { text } = randomGraphemeName(rng, 8 + rng.int(40), SAFE_CLUSTERS);
      const cap = 1 + rng.int(count.cp(text));
      const out = sanitizeUserText(text, cap);
      if (!text.startsWith(out)) continue; // trimEnd changed it; not a cluster question
      const rest = text.slice(out.length);
      total += 1;
      // If the boundary is mid-cluster, `out + firstCodePoint(rest)` still has the same grapheme count as `out`.
      const first = Array.from(rest)[0];
      if (
        first !== undefined &&
        count.graphemes(out + first) === count.graphemes(out) &&
        out.length > 0
      ) {
        split += 1;
        if (samples.length < 20) {
          samples.push({
            inputJson: JSON.stringify(text),
            cap,
            outputJson: JSON.stringify(out),
          });
        }
      }
    }
    rows.push({
      property: "cap_splits_grapheme_cluster(observed)",
      iterations: total,
      failures: split,
      ms: 0,
    });
    writeArtifact("sanitize_cluster_split_samples.json", {
      seed: SEED,
      total,
      split,
      rate: total ? split / total : 0,
      samples,
    });
  },
);

Deno.test("artifact: write property summary + counterexamples", () => {
  const path = writeArtifact("sanitize_property_summary.json", {
    seed: SEED,
    itersPerProperty: ITERS,
    alphabets: ALPHABET_NAMES,
    heap: measureHeap(),
    properties: rows,
    counterexamples,
  });
  if (path) console.warn(`[xc-i18n] wrote ${path}`);
});
