#!/usr/bin/env node
// Sandbox mutation probes for tools/release/check-release-manifest.mjs.
//
// Copies the checker + its four inputs into a throwaway sandbox per probe,
// applies one mutation, runs the sandboxed checker and records the exit code.
// Tracked files are never touched. Each probe declares whether the checker is
// expected to REJECT the mutation (desiredExit 1). `caught` records today's
// behaviour; a probe that used to be caught and no longer is fails this
// harness (regression guard). Probes marked caught:false are known gaps and
// are reported, not failed.
//
//   node tools/release/audit/probe-release-checker.mjs [--out <dir>]
//
// Writes <out>/results.json, <out>/<probe>.log and prints a table.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outDir = resolve(
  outIdx >= 0 ? args[outIdx + 1] : join(repoRoot, "artifacts/release-audit/probes"),
);

const CHECKER = "tools/release/check-release-manifest.mjs";
const MANIFEST = "infra/release/release-manifest.json";
const PBXPROJ = "apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj";
const GRADLE = "apps/mobile/android/app/build.gradle";
const RUNTIME = "apps/mobile/src/config/runtimeConfig.ts";
const INPUTS = [CHECKER, MANIFEST, PBXPROJ, GRADLE, RUNTIME];

const text = (root, rel) => readFileSync(join(root, rel), "utf8");
const put = (root, rel, body) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};
const json = (root, rel) => JSON.parse(text(root, rel));
const putJson = (root, rel, obj) => put(root, rel, JSON.stringify(obj, null, 2) + "\n");
const replaceAllOrThrow = (s, from, to) => {
  if (!s.includes(from)) throw new Error(`mutation anchor not found: ${from}`);
  return s.split(from).join(to);
};
const replaceNth = (s, from, to, n) => {
  let idx = -1;
  for (let i = 0; i <= n; i++) {
    idx = s.indexOf(from, idx + 1);
    if (idx < 0) throw new Error(`anchor #${n} not found: ${from}`);
  }
  return s.slice(0, idx) + to + s.slice(idx + from.length);
};

/** @type {{id:string, why:string, desiredExit:0|1, caught:boolean, mutate:(root:string)=>void}[]} */
const PROBES = [
  {
    id: "p01-baseline",
    why: "unmodified copy passes",
    desiredExit: 0,
    caught: true,
    mutate: () => {},
  },
  {
    id: "p02-split-pbxproj-mv",
    why: "Release config MARKETING_VERSION 1.1 while Debug stays 1.0 (includes() sees the Debug hit)",
    desiredExit: 1,
    caught: false,
    mutate: (r) =>
      put(
        r,
        PBXPROJ,
        replaceNth(text(r, PBXPROJ), "MARKETING_VERSION = 1.0;", "MARKETING_VERSION = 1.1;", 1),
      ),
  },
  {
    id: "p03-drop-irreversible",
    why: "app_store_submission removed from irreversibleActions (only non-empty is checked)",
    desiredExit: 1,
    caught: false,
    mutate: (r) => {
      const m = json(r, MANIFEST);
      m.irreversibleActions = m.irreversibleActions.filter((a) => a.id !== "app_store_submission");
      putJson(r, MANIFEST, m);
    },
  },
  {
    id: "p04-blocking-steps-empty",
    why: "releaseBlockingSteps=[] and schemaVersion=99 accepted",
    desiredExit: 1,
    caught: false,
    mutate: (r) => {
      const m = json(r, MANIFEST);
      m.releaseBlockingSteps = [];
      m.schemaVersion = 99;
      putJson(r, MANIFEST, m);
    },
  },
  {
    id: "p05-malformed-json",
    why: "invalid JSON → uncaught SyntaxError (exit 1 but no check-style message)",
    desiredExit: 1,
    caught: true,
    mutate: (r) => put(r, MANIFEST, text(r, MANIFEST).slice(0, -3)),
  },
  {
    id: "p06-missing-manifest",
    why: "manifest deleted → uncaught ENOENT",
    desiredExit: 1,
    caught: true,
    mutate: (r) => rmSync(join(r, MANIFEST)),
  },
  {
    id: "p07-string-booleans",
    why: "realUserData / requiresHumanAuthorization as strings",
    desiredExit: 1,
    caught: true,
    mutate: (r) => {
      const m = json(r, MANIFEST);
      m.environments.production.realUserData = "true";
      m.environments.development.realUserData = "no";
      for (const a of m.irreversibleActions) a.requiresHumanAuthorization = "yes";
      putJson(r, MANIFEST, m);
    },
  },
  {
    id: "p08-rollback-auth-false",
    why: "db_snapshot_restore requiresHumanAuthorization=false accepted (rollback hooks unchecked)",
    desiredExit: 1,
    caught: false,
    mutate: (r) => {
      const m = json(r, MANIFEST);
      const h = m.rollbackHooks.find((x) => x.id === "db_snapshot_restore");
      h.requiresHumanAuthorization = false;
      putJson(r, MANIFEST, m);
    },
  },
  {
    id: "p09-real-prod-origin",
    why: "production apiOrigin set to a real URL",
    desiredExit: 1,
    caught: true,
    mutate: (r) => {
      const m = json(r, MANIFEST);
      m.environments.production.apiOrigin = "https://example.supabase.co/functions/v1/api";
      putJson(r, MANIFEST, m);
    },
  },
  {
    id: "p10-build-bump-manifest-only",
    why: "manifest buildNumber 2, project files still 1",
    desiredExit: 1,
    caught: true,
    mutate: (r) => {
      const m = json(r, MANIFEST);
      m.versionScheme.buildNumber = 2;
      putJson(r, MANIFEST, m);
    },
  },
  {
    id: "p11-gradle-comment",
    why: "versionCode 2 // was versionCode 1 — comment satisfies the regex",
    desiredExit: 1,
    caught: false,
    mutate: (r) =>
      put(
        r,
        GRADLE,
        replaceAllOrThrow(text(r, GRADLE), "versionCode 1", "versionCode 2 // was versionCode 1"),
      ),
  },
  {
    id: "p12-runtime-double-quotes",
    why: 'APP_VERSION = "1.0" (same value, different quoting) is rejected — brittle',
    desiredExit: 0,
    caught: false,
    mutate: (r) =>
      put(
        r,
        RUNTIME,
        replaceAllOrThrow(
          text(r, RUNTIME),
          "const APP_VERSION = '1.0';",
          'const APP_VERSION = "1.0";',
        ),
      ),
  },
  {
    id: "p13-severity-downgrade-dup",
    why: "consent hook downgraded to P2 + duplicated hook id",
    desiredExit: 1,
    caught: true,
    mutate: (r) => {
      const m = json(r, MANIFEST);
      const h = m.monitoringHooks.find((x) => x.id === "consent_ledger_integrity");
      h.severity = "P2";
      m.monitoringHooks.push({ ...m.monitoringHooks[0] });
      putJson(r, MANIFEST, m);
    },
  },
  {
    id: "p14-split-pbxproj-cpv",
    why: "Release CURRENT_PROJECT_VERSION 3 while Debug stays 1",
    desiredExit: 1,
    caught: false,
    mutate: (r) =>
      put(
        r,
        PBXPROJ,
        replaceNth(
          text(r, PBXPROJ),
          "CURRENT_PROJECT_VERSION = 1;",
          "CURRENT_PROJECT_VERSION = 3;",
          1,
        ),
      ),
  },
  {
    id: "p15-mv-format",
    why: "marketingVersion '01.0' rejected by format check",
    desiredExit: 1,
    caught: true,
    mutate: (r) => {
      const m = json(r, MANIFEST);
      m.versionScheme.marketingVersion = "01.0";
      putJson(r, MANIFEST, m);
    },
  },
  // --- pass-2 additions -------------------------------------------------
  {
    id: "p16-build-number-string",
    why: 'buildNumber "1" (string) rejected',
    desiredExit: 1,
    caught: true,
    mutate: (r) => {
      const m = json(r, MANIFEST);
      m.versionScheme.buildNumber = "1";
      putJson(r, MANIFEST, m);
    },
  },
  {
    id: "p17-pbxproj-comment-mv",
    why: "real MARKETING_VERSION 2.0 everywhere, but a '// MARKETING_VERSION = 1.0;' comment remains",
    desiredExit: 1,
    caught: false,
    mutate: (r) =>
      put(
        r,
        PBXPROJ,
        replaceAllOrThrow(
          text(r, PBXPROJ),
          "MARKETING_VERSION = 1.0;",
          "MARKETING_VERSION = 2.0; /* MARKETING_VERSION = 1.0; */",
        ),
      ),
  },
  {
    id: "p18-dev-origin-missing",
    why: "development.apiOrigin key removed (undefined !== null)",
    desiredExit: 1,
    caught: true,
    mutate: (r) => {
      const m = json(r, MANIFEST);
      delete m.environments.development.apiOrigin;
      putJson(r, MANIFEST, m);
    },
  },
  {
    id: "p19-staging-real-user-data",
    why: "staging.realUserData=true rejected",
    desiredExit: 1,
    caught: true,
    mutate: (r) => {
      const m = json(r, MANIFEST);
      m.environments.staging.realUserData = true;
      putJson(r, MANIFEST, m);
    },
  },
  {
    id: "p20-empty-alarm",
    why: 'monitoring hook alarm "" accepted (only typeof string is checked)',
    desiredExit: 1,
    caught: false,
    mutate: (r) => {
      const m = json(r, MANIFEST);
      for (const h of m.monitoringHooks) h.alarm = "";
      putJson(r, MANIFEST, m);
    },
  },
  {
    id: "p21-rollback-hook-missing-action",
    why: "rollback hook without action rejected",
    desiredExit: 1,
    caught: true,
    mutate: (r) => {
      const m = json(r, MANIFEST);
      delete m.rollbackHooks.find((x) => x.id === "backend_image_rollback").action;
      putJson(r, MANIFEST, m);
    },
  },
  {
    id: "p22-irreversible-empty",
    why: "irreversibleActions=[] rejected",
    desiredExit: 1,
    caught: true,
    mutate: (r) => {
      const m = json(r, MANIFEST);
      m.irreversibleActions = [];
      putJson(r, MANIFEST, m);
    },
  },
  {
    id: "p23-gradle-versioncode-10",
    why: "versionCode 10 with manifest 1 — \\b boundary rejects",
    desiredExit: 1,
    caught: true,
    mutate: (r) =>
      put(r, GRADLE, replaceAllOrThrow(text(r, GRADLE), "versionCode 1", "versionCode 10")),
  },
  {
    id: "p24-schema-version-missing",
    why: "schemaVersion removed entirely — accepted",
    desiredExit: 1,
    caught: false,
    mutate: (r) => {
      const m = json(r, MANIFEST);
      delete m.schemaVersion;
      putJson(r, MANIFEST, m);
    },
  },
  {
    id: "p25-bom-manifest",
    why: "UTF-8 BOM prefix → JSON.parse throws (uncaught)",
    desiredExit: 1,
    caught: true,
    mutate: (r) => put(r, MANIFEST, "\uFEFF" + text(r, MANIFEST)),
  },
  {
    id: "p26-pbxproj-missing",
    why: "pbxproj file absent → uncaught ENOENT",
    desiredExit: 1,
    caught: true,
    mutate: (r) => rmSync(join(r, PBXPROJ)),
  },
  {
    id: "p27-runtime-version-drift",
    why: "APP_VERSION = '1.1' while manifest 1.0",
    desiredExit: 1,
    caught: true,
    mutate: (r) =>
      put(
        r,
        RUNTIME,
        replaceAllOrThrow(
          text(r, RUNTIME),
          "const APP_VERSION = '1.0';",
          "const APP_VERSION = '1.1';",
        ),
      ),
  },
  {
    id: "p28-manifest-and-project-bump-together",
    why: "coherent bump 1.0/1 → 1.1/2 across all four files passes",
    desiredExit: 0,
    caught: true,
    mutate: (r) => {
      const m = json(r, MANIFEST);
      m.versionScheme.marketingVersion = "1.1";
      m.versionScheme.buildNumber = 2;
      putJson(r, MANIFEST, m);
      put(
        r,
        PBXPROJ,
        replaceAllOrThrow(
          replaceAllOrThrow(
            text(r, PBXPROJ),
            "MARKETING_VERSION = 1.0;",
            "MARKETING_VERSION = 1.1;",
          ),
          "CURRENT_PROJECT_VERSION = 1;",
          "CURRENT_PROJECT_VERSION = 2;",
        ),
      );
      put(
        r,
        GRADLE,
        replaceAllOrThrow(
          replaceAllOrThrow(text(r, GRADLE), "versionCode 1", "versionCode 2"),
          'versionName "1.0"',
          'versionName "1.1"',
        ),
      );
      put(
        r,
        RUNTIME,
        replaceAllOrThrow(
          text(r, RUNTIME),
          "const APP_VERSION = '1.0';",
          "const APP_VERSION = '1.1';",
        ),
      );
    },
  },
];

mkdirSync(outDir, { recursive: true });
const results = [];
let regressions = 0;
for (const probe of PROBES) {
  const sandbox = join(outDir, "sandbox", probe.id);
  rmSync(sandbox, { recursive: true, force: true });
  for (const rel of INPUTS) cpSync(join(repoRoot, rel), join(sandbox, rel));
  probe.mutate(sandbox);
  const run = spawnSync(process.execPath, [join(sandbox, CHECKER)], {
    cwd: sandbox,
    encoding: "utf8",
  });
  const exit = run.status ?? -1;
  const log = `$ node ${CHECKER}\n# ${probe.why}\n--- stdout ---\n${run.stdout}--- stderr ---\n${run.stderr}--- exit ${exit} ---\n`;
  writeFileSync(join(outDir, `${probe.id}.log`), log);
  const failLines = (run.stdout.match(/^FAIL /gm) ?? []).length;
  const uncaught = /^\s*(SyntaxError|Error|TypeError):|ENOENT|^node:internal/m.test(run.stderr);
  const caughtNow = exit === probe.desiredExit;
  if (probe.caught && !caughtNow) regressions++;
  results.push({
    id: probe.id,
    why: probe.why,
    desiredExit: probe.desiredExit,
    observedExit: exit,
    failLines,
    uncaughtException: uncaught,
    status: caughtNow ? "ok" : probe.caught ? "REGRESSION" : "gap",
    log: `${probe.id}.log`,
  });
}
writeFileSync(join(outDir, "results.json"), JSON.stringify({ repoRoot, results }, null, 2) + "\n");

const pad = (s, n) => String(s).padEnd(n);
console.log(
  pad("probe", 40) +
    pad("want", 6) +
    pad("got", 5) +
    pad("FAILs", 7) +
    pad("uncaught", 10) +
    "status",
);
for (const r of results) {
  console.log(
    pad(r.id, 40) +
      pad(r.desiredExit, 6) +
      pad(r.observedExit, 5) +
      pad(r.failLines, 7) +
      pad(r.uncaughtException, 10) +
      r.status,
  );
}
const gaps = results.filter((r) => r.status === "gap").length;
console.log(
  `\n${results.length} probes · ${gaps} known gaps · ${regressions} regressions · results: ${outDir}/results.json`,
);
process.exit(regressions > 0 ? 1 : 0);
