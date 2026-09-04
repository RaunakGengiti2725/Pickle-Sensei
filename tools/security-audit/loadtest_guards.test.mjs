#!/usr/bin/env node
/**
 * Static pins for tools/loadtest: every k6 script refuses to run without an
 * explicit BASE_URL (so nothing defaults to production), the authenticated flow
 * additionally requires TOKEN, and every script enforces a threshold that fails the
 * run on 5xx responses (`server_errors` or the stricter `unexpected_responses`).
 *
 * Run:  node --test tools/security-audit/loadtest_guards.test.mjs
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "loadtest");
const scripts = readdirSync(dir).filter((f) => f.endsWith(".js"));

describe("k6 load-test scripts", () => {
  it("exist", () => {
    assert.ok(scripts.length >= 3, `expected the k6 scripts in ${dir}`);
  });

  for (const file of scripts) {
    const src = readFileSync(join(dir, file), "utf8");

    it(`${file}: throws when BASE_URL is not supplied and never hardcodes a host`, () => {
      assert.match(src, /const BASE_URL = __ENV\.BASE_URL;/);
      assert.match(src, /if \(!BASE_URL\) throw new Error\(/);
      assert.doesNotMatch(src, /https:\/\/[a-z]{20}\.supabase\.co/, "no real project ref");
    });

    it(`${file}: fails the run on server errors`, () => {
      const thresholds = /(server_errors|unexpected_responses):\s*\["rate<0\.0\d"\]/;
      assert.match(src, thresholds, `${file} has no threshold failing the run on 5xx`);
    });
  }

  it("user-flow.js refuses to run without a TOKEN", () => {
    const src = readFileSync(join(dir, "user-flow.js"), "utf8");
    assert.match(src, /if \(!TOKEN\) throw new Error\(/);
  });
});
