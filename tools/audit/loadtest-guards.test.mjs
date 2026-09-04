// tools/loadtest/*.js target the PRODUCTION edge function. The only thing
// that prevents an accidental run is each script refusing to start without an
// explicit BASE_URL. This pins that guard (k6 is not installed on Linux CI, so
// the check is static: guard present, no baked-in production URL fallback).
//
// Run: node --test tools/audit/loadtest-guards.test.mjs
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const loadtestDir = resolve(here, "..", "loadtest");
const scripts = readdirSync(loadtestDir).filter((f) => f.endsWith(".js"));

test("every load-test script exists to be checked", () => {
  assert.ok(scripts.length >= 6, `expected >= 6 scripts, found ${scripts.length}`);
});

for (const file of scripts) {
  const source = readFileSync(join(loadtestDir, file), "utf8");

  test(`${file}: refuses to run without an explicit BASE_URL`, () => {
    assert.match(source, /const BASE_URL = __ENV\.BASE_URL;/);
    assert.match(source, /if \(!BASE_URL\) throw new Error\(/);
  });

  test(`${file}: no production URL is baked in as a fallback`, () => {
    // The project ref may appear in comments/README as an example, but never as
    // a default value for BASE_URL.
    assert.doesNotMatch(source, /BASE_URL\s*(?:\|\||\?\?|=)\s*["'`]https?:\/\//);
    assert.doesNotMatch(source, /ucqnaiwqwjtgvlduiuib/);
  });

  test(`${file}: never prints a bearer token`, () => {
    const logLines = source.split("\n").filter((l) => /console\.(log|error|warn)/.test(l));
    for (const line of logLines) {
      assert.doesNotMatch(line, /TOKEN|Authorization/i, `token-ish value logged: ${line.trim()}`);
    }
  });
}
