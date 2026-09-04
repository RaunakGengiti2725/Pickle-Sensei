import { describe, expect, it } from "vitest";
import { resolveTechniqueIntent } from "../src/techniqueIntent.js";

/**
 * Adversarial pass 3 (tester #4) — technique-intent grammar attacks.
 *
 *   S5  "forehand and backhand dink" must be ambiguous, not BACKHAND_DINK@0.95.
 *   S6  "not a dink, a drive" — negation must not leak dink options.
 *
 * Convention: BROKEN scenarios state the EXPECTED behaviour under `it.fails`
 * (green while the defect exists, red once fixed — flip to `it` then), with a
 * sibling `it` that pins the currently-observed behaviour as the repro.
 */

function canonicals(text: string): string[] {
  const r = resolveTechniqueIntent(text);
  if (r.status === "resolved") return [r.technique.canonical];
  if (r.status === "ambiguous") return r.options.map((o) => o.canonical).sort();
  return [];
}

describe("S5 both sides mentioned with one action", () => {
  const PHRASES = [
    "forehand and backhand dink",
    "backhand and forehand dink",
    "forehand or backhand dink",
    "my forehand dink and my backhand dink",
    "fh and bh dink",
    "dink forehand backhand",
  ];

  it("REPRO: the LAST side word wins silently — resolved at 0.95, never ambiguous", () => {
    // SIDE_WORDS is a for-loop that overwrites `side`; BACKHAND is tested
    // after FOREHAND, so any phrase containing both resolves to BACKHAND_*.
    for (const text of PHRASES) {
      const r = resolveTechniqueIntent(text);
      expect(r.status, text).toBe("resolved");
      if (r.status !== "resolved") continue;
      expect(r.technique.canonical, text).toBe("BACKHAND_DINK");
      expect(r.confidence, text).toBe(0.95);
    }
  });

  it("REPRO: word order does not matter — 'backhand and forehand dink' is ALSO BACKHAND_DINK", () => {
    // Not "last mentioned wins" (a defensible heuristic) but "BACKHAND wins",
    // because of the fixed regex order. The user who said forehand last is
    // silently routed to backhand.
    expect(canonicals("backhand and forehand dink")).toEqual(["BACKHAND_DINK"]);
    expect(canonicals("backhand, no wait, forehand dink")).toEqual(["BACKHAND_DINK"]);
  });

  it.fails(
    "EXPECTED: both sides + one action → ambiguous over {FOREHAND_DINK, BACKHAND_DINK} (BROKEN)",
    () => {
      for (const text of PHRASES) {
        const r = resolveTechniqueIntent(text);
        expect(r.status, text).toBe("ambiguous");
        expect(canonicals(text), text).toEqual(["BACKHAND_DINK", "FOREHAND_DINK"]);
      }
    },
  );

  it("control: single side + action still resolves (grammar not over-tightened by the fix)", () => {
    expect(canonicals("forehand dink")).toEqual(["FOREHAND_DINK"]);
    expect(canonicals("backhand dink")).toEqual(["BACKHAND_DINK"]);
    expect(canonicals("dink")).toEqual(["BACKHAND_DINK", "FOREHAND_DINK"]);
  });
});

describe("S6 negation", () => {
  it("REPRO: 'not a dink, a drive' → ambiguous with 4 options including both DINKs", () => {
    const r = resolveTechniqueIntent("not a dink, a drive");
    expect(r.status).toBe("ambiguous");
    expect(canonicals("not a dink, a drive")).toEqual([
      "BACKHAND_DINK",
      "BACKHAND_DRIVE",
      "FOREHAND_DINK",
      "FOREHAND_DRIVE",
    ]);
  });

  it("REPRO: negated single technique resolves TO the negated technique", () => {
    // "not a dink" has exactly one action word → resolved/ambiguous on dink.
    expect(canonicals("not a dink")).toEqual(["BACKHAND_DINK", "FOREHAND_DINK"]);
    expect(canonicals("not my forehand drive")).toEqual(["FOREHAND_DRIVE"]);
    expect(canonicals("everything except the serve")).toEqual(["SERVE"]);
    // "anything" is an AUTO word, so this negation is swallowed by auto-detect.
    expect(resolveTechniqueIntent("anything but the serve").status).toBe("auto");
    const r = resolveTechniqueIntent("not my forehand drive");
    expect(r.status === "resolved" && r.confidence).toBe(0.95);
  });

  it.fails("EXPECTED: negation drops 'dink' from the option set (BROKEN)", () => {
    const opts = canonicals("not a dink, a drive");
    expect(opts).not.toContain("FOREHAND_DINK");
    expect(opts).not.toContain("BACKHAND_DINK");
    expect(opts.length).toBeGreaterThan(0);
  });

  it.fails(
    "EXPECTED: 'not a dink' alone is unknown/ambiguous, never resolved to a dink (BROKEN)",
    () => {
      const r = resolveTechniqueIntent("not my forehand dink");
      expect(r.status).not.toBe("resolved");
    },
  );

  it("'no' / 'don't' variants: pin the observed verdicts", () => {
    // "don't know" is an AUTO word, so "don't" phrases are swallowed by auto.
    expect(resolveTechniqueIntent("don't know, dink").status).toBe("auto");
    expect(resolveTechniqueIntent("i don't want the dink, the drive").status).toBe("ambiguous");
    expect(canonicals("no dink, drive")).toEqual([
      "BACKHAND_DINK",
      "BACKHAND_DRIVE",
      "FOREHAND_DINK",
      "FOREHAND_DRIVE",
    ]);
  });
});

describe("extra: grammar edge probes", () => {
  it("unicode punctuation / homoglyphs are stripped to spaces, not letters", () => {
    // Curly apostrophe is not in the keep-set → "don’t" becomes "don t" and
    // AUTO_WORDS' \bdon'?t know\b does NOT match. Pinned.
    expect(resolveTechniqueIntent("I don’t know").status).toBe("unknown");
    expect(resolveTechniqueIntent("I don't know").status).toBe("auto");
    // Fullwidth letters are non-ascii → stripped → no words.
    expect(resolveTechniqueIntent("ｄｉｎｋ").status).toBe("unknown");
    expect(resolveTechniqueIntent("dink\u200b").status).toBe("ambiguous");
  });

  it("huge input (1 MiB of noise + one keyword) terminates and resolves", () => {
    const text = `${"zzz ".repeat(256 * 1024)}serve`;
    const start = Date.now();
    const r = resolveTechniqueIntent(text);
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(r.status).toBe("resolved");
  });

  it("'drop' collides: 'drop the volley' is ambiguous over drop + volley (pin)", () => {
    expect(canonicals("drop the volley")).toEqual(["BACKHAND_VOLLEY", "DROP", "FOREHAND_VOLLEY"]);
  });

  it("'return' as a verb leaks into RETURN: 'return to my dink' (pin)", () => {
    expect(canonicals("return to my dink")).toEqual(["BACKHAND_DINK", "FOREHAND_DINK", "RETURN"]);
  });

  it("'attack' maps to SPEEDUP even in 'attack my third shot drop' (pin)", () => {
    expect(canonicals("attack my third shot drop")).toEqual(["DROP", "SPEEDUP"]);
  });

  it("all-side, no-action with both sides: 'forehand and backhand' → BACKHAND-only options (REPRO)", () => {
    const r = resolveTechniqueIntent("forehand and backhand");
    expect(r.status).toBe("ambiguous");
    expect(canonicals("forehand and backhand")).toEqual([
      "BACKHAND_DINK",
      "BACKHAND_DRIVE",
      "BACKHAND_VOLLEY",
    ]);
  });
});
