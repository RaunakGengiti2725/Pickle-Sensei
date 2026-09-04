/**
 * Redaction-guard cost vs. string length (64 KB+ strings lens).
 *
 *   STRESS_MAX_STRING=262144 STRESS_TIMING_OUT=/tmp/guard-timing.json \
 *     pnpm --filter @pickle/analytics test -- test/stress/guardTiming
 *
 * Measures `findPrivacyViolations` on a single oversized string field and,
 * separately, each redaction regex on the same string, so the table shows
 * which rule dominates. Timings are recorded (INFO), not asserted — only the
 * verdict and its determinism are asserted.
 *
 * The regex work is synchronous and blocks the worker's event loop; the guard
 * cost grows quadratically with length (~3 s at 64 Ki, ~56 s at 256 Ki on the
 * Linux CI class), so above STRESS_MAX_STRING=131072 the vitest worker can miss
 * its RPC heartbeat and the run exits non-zero even though every assertion
 * passed and the JSON table was written. Use ≤ 131072 for a clean exit.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { findPrivacyViolations, type AnalyticsEvent } from "../../src/index.js";
import { SeededRng } from "./seededRng.js";

const MAX_STRING = Number(process.env["STRESS_MAX_STRING"] ?? 16384);
const OUT = process.env["STRESS_TIMING_OUT"];
const SEED = 7;

/** Same patterns as src/index.ts, copied so each can be timed in isolation. */
const RULES: Record<string, RegExp> = {
  uri_scheme: /\b(?:file|content|assets-library|ph|s3|blob|data):\/?\//i,
  filesystem_path: /(?:^|[\s="'(])\/(?:var|private|Users|data|storage|tmp|home)\//,
  email_address: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  base64_blob: /[A-Za-z0-9+/]{120,}={0,2}/,
};

const ALPHABETS: Record<string, string> = {
  word: "abcdefghijklmnopqrstuvwxyz0123456789_",
  word_with_dots: "abcdefghijklmnopqrstuvwxyz.",
  spaces: "abcdefghijklmnopqrstuvwxyz ",
};

function sizes(): number[] {
  const out: number[] = [];
  for (let n = 4096; n <= MAX_STRING; n *= 2) out.push(n);
  return out;
}

interface Sample {
  length: number;
  alphabet: string;
  guardMs: number;
  perRuleMs: Record<string, number>;
  rules: string[];
}

function time(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

describe(`redaction guard cost vs string length (up to ${MAX_STRING} code units)`, () => {
  const rng = new SeededRng(SEED);
  const samples: Sample[] = [];

  for (const length of sizes()) {
    for (const [alphabetName, alphabet] of Object.entries(ALPHABETS)) {
      const text = rng.string(length, alphabet);
      const event = {
        name: "analysis_failed",
        at: "2026-09-04T12:00:00.000Z",
        failureKind: text,
      } as AnalyticsEvent;
      let rules: string[] = [];
      const guardMs = time(() => {
        rules = findPrivacyViolations(event).map((v) => v.rule);
      });
      const perRuleMs: Record<string, number> = {};
      for (const [rule, re] of Object.entries(RULES)) perRuleMs[rule] = time(() => re.test(text));
      samples.push({ length, alphabet: alphabetName, guardMs, perRuleMs, rules });

      it(
        `flags a ${length}-code-unit ${alphabetName} string as oversized, deterministically`,
        () => {
          expect(rules).toContain("oversized_string");
          expect(findPrivacyViolations(event).map((v) => v.rule)).toEqual(rules);
        },
        Math.max(5_000, Math.ceil(guardMs * 4) + 5_000),
      );
    }
  }

  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(
      OUT,
      JSON.stringify(
        {
          revision: process.env["STRESS_REVISION"] ?? null,
          generatedAt: new Date().toISOString(),
          seed: SEED,
          node: process.version,
          samples,
        },
        null,
        1,
      ),
    );
  }
});
