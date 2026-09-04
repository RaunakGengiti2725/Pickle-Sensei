#!/usr/bin/env node
// Audit harness: replays `npm audit`'s bulk-advisory query for a lockfile
// without going through the npm CLI (which hangs/times out on some networks).
// Same data source as `npm audit` (registry.npmjs.org bulk advisories).
//
// Usage: node tools/audit/npm-bulk-advisories.mjs <package-lock.json> [--omit=dev] [--json]
// Exit 0 = no advisories against the selected tree, 1 = advisories found,
// 2 = usage/network failure (never a pass).

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const lockPath = args.find((a) => !a.startsWith("--"));
const omitDev = args.includes("--omit=dev");
const asJson = args.includes("--json");
if (!lockPath) {
  console.error("usage: npm-bulk-advisories.mjs <package-lock.json> [--omit=dev] [--json]");
  process.exit(2);
}

const lock = JSON.parse(readFileSync(lockPath, "utf8"));
if (lock.lockfileVersion < 2 || !lock.packages) {
  console.error("lockfileVersion 2/3 with a packages map is required");
  process.exit(2);
}

/** @type {Record<string, Set<string>>} */
const versions = {};
for (const [path, meta] of Object.entries(lock.packages)) {
  if (path === "" || !meta.version) continue;
  if (omitDev && meta.dev === true) continue;
  if (meta.link) continue;
  const name = meta.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  (versions[name] ??= new Set()).add(meta.version);
}
const body = Object.fromEntries(Object.entries(versions).map(([k, v]) => [k, [...v]]));
const packageCount = Object.keys(body).length;

// The registry's bulk endpoint intermittently stalls with 0 bytes on some
// networks (this is what makes `npm audit` hang); bounded retries, never a pass.
const ATTEMPTS = 6;
const ATTEMPT_TIMEOUT_MS = 40_000;
let response = null;
for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
  try {
    response = await fetch("https://registry.npmjs.org/-/npm/v1/security/advisories/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (response.ok) break;
    console.error(`attempt ${attempt}/${ATTEMPTS}: HTTP ${response.status}`);
    response = null;
  } catch (error) {
    console.error(
      `attempt ${attempt}/${ATTEMPTS}: ${error instanceof Error ? error.message : String(error)}`,
    );
    response = null;
  } finally {
    clearTimeout(timer);
  }
}
if (!response) {
  console.error(`bulk advisory request failed after ${ATTEMPTS} attempts (UNKNOWN, not a pass)`);
  process.exit(2);
}
/** @type {Record<string, Array<{id:number,url:string,title:string,severity:string,vulnerable_versions:string}>>} */
const advisories = await response.json();

// semver is resolved from the audited project's own node_modules (it is a
// transitive dependency of every npm tree here), not from this script's dir.
const projectRequire = createRequire(resolve(dirname(resolve(lockPath)), "package.json"));
const semverSatisfies = projectRequire("semver").satisfies;
const hits = [];
for (const [name, list] of Object.entries(advisories)) {
  for (const adv of list) {
    for (const version of body[name] ?? []) {
      if (semverSatisfies(version, adv.vulnerable_versions, { includePrerelease: true })) {
        hits.push({
          name,
          version,
          severity: adv.severity,
          id: adv.id,
          title: adv.title,
          url: adv.url,
          vulnerable_versions: adv.vulnerable_versions,
        });
      }
    }
  }
}
hits.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);

const summary = {
  lockfile: lockPath,
  omitDev,
  packages: packageCount,
  advisories: hits.length,
  bySeverity: {},
};
for (const h of hits) summary.bySeverity[h.severity] = (summary.bySeverity[h.severity] ?? 0) + 1;

if (asJson) {
  console.log(JSON.stringify({ summary, hits }, null, 2));
} else {
  console.log(`packages queried: ${packageCount} (omitDev=${omitDev})`);
  for (const h of hits)
    console.log(
      `${h.severity.padEnd(8)} ${h.name}@${h.version}  ${h.title}  (${h.url}; vulnerable ${h.vulnerable_versions})`,
    );
  console.log(`advisories: ${hits.length} ${JSON.stringify(summary.bySeverity)}`);
}
process.exit(hits.length === 0 ? 0 : 1);
