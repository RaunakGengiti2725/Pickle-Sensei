// Pins the behaviour of the release-readiness harnesses against this checkout.
// Run: node --test tools/release/xc-readiness/__tests__/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const tool = (name) => join(here, "..", name);
const out = mkdtempSync(join(tmpdir(), "xc-readiness-"));
const run = (args) => spawnSync(process.execPath, args, { cwd: repoRoot, encoding: "utf8" });

test("version-triple: committed iOS identity/version sources agree (hard checks) and the report lists soft disagreements explicitly", () => {
  const json = join(out, "version-triple.json");
  const r = run([tool("version-triple.mjs"), "--json", json]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rep = JSON.parse(readFileSync(json, "utf8"));
  assert.equal(rep.hardFailures, 0);
  const byId = Object.fromEntries(rep.checks.map((c) => [c.id, c]));
  assert.equal(byId["pbxproj.marketingVersion == manifest"].ok, true);
  assert.equal(byId["runtimeConfig.APP_STORE_ID == dossier Apple ID"].ok, true);
  assert.equal(byId["bundleId agrees: pbxproj/Appfile/gradle/dossier"].ok, true);
  // soft checks are reported, never hidden
  assert.ok(
    rep.checks.some((c) => c.level === "SOFT" && c.id.startsWith("apps/mobile/package.json")),
  );
});

test("version-triple: --mac-plist compares the built app plist when present and ignores a missing path", () => {
  const r = run([tool("version-triple.mjs"), "--mac-plist", join(out, "does-not-exist.plist")]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!r.stdout.includes("mac plist"));
});

test("forbidden-terms: classifies rule text as META, non-iOS Platform branches apart, attribution apart, and real copy as COPY", () => {
  const json = join(out, "forbidden-terms.json");
  const r = run([tool("forbidden-terms-scan.mjs"), "--json", json]);
  const rep = JSON.parse(readFileSync(json, "utf8"));
  const hits = rep.hits;
  const at = (file, line) => hits.filter((h) => h.file === file && h.line === line);

  // dossier rule 4 enumerates the forbidden terms — META, never copy
  assert.ok(at("docs/APP_STORE_SUBMISSION.md", 34).length > 0);
  assert.ok(at("docs/APP_STORE_SUBMISSION.md", 34).every((h) => h.classification === "META"));

  // Android-only arm of a Platform.OS ternary — reported, but not iOS copy
  const gp = at("apps/mobile/src/screens/ManageAccountScreen.tsx", 75);
  assert.equal(gp.length, 1);
  assert.equal(gp[0].classification, "NON_IOS_BRANCH");

  // YouTube channel attribution on an embedded drill video
  const sel = at("supabase/functions/api/drillMedia.ts", 103);
  assert.equal(sel.length, 1);
  assert.equal(sel[0].classification, "ATTRIBUTION");

  // multi-line template literal: each match lands on its own source line
  const legal = hits.filter(
    (h) => h.file === "supabase/functions/api/legal.ts" && h.rule === "google_play",
  );
  assert.deepEqual(
    legal.map((h) => h.line).sort((a, b) => a - b),
    [224, 447, 639],
  );
  assert.ok(legal.every((h) => h.classification === "COPY"));

  // exit code follows HARD/COPY hits only
  const hardCopy = hits.filter((h) => h.severity === "HARD" && h.classification === "COPY");
  assert.equal(r.status, hardCopy.length > 0 ? 1 : 0);
});

test("prelaunch-walk: every checklist item carries exactly one label and the status file matches the checklist", () => {
  const json = join(out, "prelaunch-walk.json");
  const r = run([
    tool("prelaunch-walk.mjs"),
    "--status",
    tool("prelaunch-status.4d812e1a.json"),
    "--json",
    json,
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rep = JSON.parse(readFileSync(json, "utf8"));
  assert.equal(rep.problems.length, 0);
  assert.equal(rep.totals.MISSING, 0);
  assert.equal(
    rep.items.length,
    rep.totals.verified + rep.totals["human-only"] + rep.totals.BLOCKED,
  );
  // ✅ marks in the checklist are never auto-promoted to verified
  assert.ok(
    rep.items.some((it) => it.checklistMark === "code-state ✅" && it.status !== "verified"),
  );
});

test("prelaunch-walk: a status file with a missing item fails", () => {
  const partial = join(out, "partial.json");
  const full = JSON.parse(readFileSync(tool("prelaunch-status.4d812e1a.json"), "utf8"));
  delete full.items["143"];
  full.items["9999"] = { status: "verified", evidence: "drift" };
  writeFileSync(partial, JSON.stringify(full));
  const r = run([tool("prelaunch-walk.mjs"), "--status", partial]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /line 143: no status entry/);
  assert.match(r.stdout, /line 9999 does not match/);
});
