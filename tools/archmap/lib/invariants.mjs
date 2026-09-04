// Invariant checks over the extracted model. Each check returns
// {id, title, severity, status: "pass"|"fail"|"info", details: [...], replay}
// where `replay` is the exact command + inputs needed to reproduce the result.
import fs from "node:fs";
import path from "node:path";
import { findCycles, singlePointsOfFailure, fanIn } from "./graph.mjs";
import { exists } from "./fsutil.mjs";
import { isRuntimeSourceFile } from "./extract.mjs";

const REPLAY = "node tools/archmap/archmap.mjs --check";

function result(id, title, severity, failures, infos = [], extra = {}) {
  const status = failures.length ? "fail" : infos.length && severity === "info" ? "info" : "pass";
  return {
    id,
    title,
    severity,
    status,
    details: failures,
    info: infos,
    replay: { command: REPLAY, focus: id, ...extra },
  };
}

/** Build the declared+observed package edge maps used by several checks. */
export function packageEdges(model) {
  const declared = new Map();
  const declaredRuntime = new Map();
  const observed = new Map();
  const observedRuntime = new Map();
  for (const [name, node] of Object.entries(model.workspaces.nodes)) {
    declared.set(name, new Set(Object.keys(node.workspaceDeps)));
    declaredRuntime.set(
      name,
      new Set(
        Object.keys(node.workspaceDeps).filter(
          (d) => node.workspaceDepKinds?.[d] !== "devDependencies",
        ),
      ),
    );
    observed.set(name, new Set(Object.keys(model.imports[name]?.imports ?? {})));
    observedRuntime.set(name, new Set(Object.keys(model.imports[name]?.runtimeImports ?? {})));
  }
  return { declared, declaredRuntime, observed, observedRuntime };
}

export function checkAll(model, repoRoot) {
  const checks = [];
  const { declared, declaredRuntime, observed, observedRuntime } = packageEdges(model);
  const names = new Set(Object.keys(model.workspaces.nodes));

  // DEP-01: no RUNTIME dependency cycles — `dependencies` ∪ non-type imports
  // from non-test source. Cycles that only close through devDependencies /
  // test / eval imports are reported as info (pnpm tolerates them; they still
  // block any future topological build).
  {
    const runtime = new Map();
    const full = new Map();
    for (const n of names) {
      runtime.set(
        n,
        new Set([...(declaredRuntime.get(n) ?? []), ...(observedRuntime.get(n) ?? [])]),
      );
      full.set(n, new Set([...(declared.get(n) ?? []), ...(observed.get(n) ?? [])]));
    }
    const runtimeCycles = findCycles(runtime);
    const runtimeKeys = new Set(runtimeCycles.map((c) => c.join(",")));
    const devOnlyCycles = findCycles(full).filter((c) => !runtimeKeys.has(c.join(",")));
    const explain = (cycle) => {
      const edges = [];
      for (const a of cycle)
        for (const b of cycle) {
          if (a === b || !full.get(a).has(b)) continue;
          const node = model.workspaces.nodes[a];
          edges.push({
            from: a,
            to: b,
            declaredAs: node.workspaceDepKinds?.[b] ?? null,
            runtimeImports: (model.imports[a]?.runtimeImports?.[b] ?? []).slice(0, 3),
            nonRuntimeImports: (model.imports[a]?.imports?.[b] ?? [])
              .filter((w) => !(model.imports[a]?.runtimeImports?.[b] ?? []).includes(w))
              .slice(0, 3),
          });
        }
      return { cycle, edges };
    };
    checks.push(
      result(
        "DEP-01",
        "No runtime cycles in the workspace package graph (dependencies ∪ non-test imports)",
        "P1",
        runtimeCycles.map(explain),
        devOnlyCycles.map((c) => ({ devOnlyCycle: true, ...explain(c) })),
      ),
    );
  }

  // DEP-02: every @pickle/* import is declared in that package's package.json
  // (apps/mobile is exempt: it resolves @pickle/* via tsconfig/metro aliases).
  {
    const failures = [];
    for (const n of names) {
      const node = model.workspaces.nodes[n];
      if (node.manager === "npm") continue;
      for (const dep of observed.get(n) ?? []) {
        if (!declared.get(n).has(dep)) {
          failures.push({
            package: n,
            importsUndeclared: dep,
            where: model.imports[n].imports[dep].slice(0, 5),
          });
        }
      }
    }
    checks.push(
      result("DEP-02", "Imported workspace packages are declared dependencies", "P2", failures),
    );
  }

  // DEP-03: declared workspace deps that are never imported (informational).
  {
    const infos = [];
    for (const n of names) {
      const node = model.workspaces.nodes[n];
      if (node.manager === "npm") continue;
      for (const dep of declared.get(n) ?? []) {
        if (!observed.get(n).has(dep))
          infos.push({ package: n, declaredUnused: dep, packageJson: `${node.dir}/package.json` });
      }
    }
    checks.push(
      result(
        "DEP-03",
        "Declared workspace dependencies that are never imported",
        "info",
        [],
        infos,
      ),
    );
  }

  // DEP-04: imported @pickle/* packages must exist in the workspace.
  {
    const failures = [];
    for (const n of names) {
      for (const dep of observed.get(n) ?? []) {
        if (!names.has(dep))
          failures.push({
            package: n,
            importsUnknownPackage: dep,
            where: model.imports[n].imports[dep].slice(0, 5),
          });
      }
    }
    checks.push(
      result("DEP-04", "Imported @pickle/* packages exist in the workspace", "P1", failures),
    );
  }

  // DEP-05: relative imports that escape a package directory. Runtime source
  // doing this is a boundary violation (fail); test/eval/bench files reaching
  // into another package's fixtures or eval tools are recorded as info — they
  // still couple the packages outside package.json.
  {
    const failures = [];
    const infos = [];
    for (const n of names) {
      const dir = model.workspaces.nodes[n].dir;
      for (const x of model.imports[n]?.crossDirImports ?? []) {
        const file = x.where.replace(/:\d+$/, "").slice(dir.length + 1);
        const targetRuntime = x.targetPackage
          ? isRuntimeSourceFile(
              x.resolves.slice(model.workspaces.nodes[x.targetPackage].dir.length + 1),
            )
          : true;
        (isRuntimeSourceFile(file) && targetRuntime ? failures : infos).push({ package: n, ...x });
      }
    }
    checks.push(
      result(
        "DEP-05",
        "No runtime relative imports that escape a package directory",
        "P2",
        failures,
        infos,
      ),
    );
  }

  // MOB-01: apps/mobile @pickle/* imports have tsconfig paths, metro alias, jest mapper.
  {
    const mobile = Object.entries(model.workspaces.nodes).find(([, v]) => v.manager === "npm")?.[0];
    const failures = [];
    const infos = [];
    if (mobile) {
      const used = Object.keys(model.imports[mobile]?.imports ?? {});
      const { tsconfigPaths, metroAliases, jestMappers } = model.mobileAliases;
      for (const dep of used) {
        const missing = [];
        if (!(dep in tsconfigPaths)) missing.push("apps/mobile/tsconfig.json paths");
        if (!(dep in metroAliases)) missing.push("apps/mobile/metro.config.js alias");
        if (!(dep in jestMappers)) missing.push("apps/mobile/jest.config.js moduleNameMapper");
        if (missing.length)
          failures.push({
            import: dep,
            missingIn: missing,
            where: model.imports[mobile].imports[dep].slice(0, 3),
          });
      }
      for (const dep of Object.keys(tsconfigPaths)) {
        if (!used.includes(dep)) infos.push({ aliasUnused: dep });
        const target = tsconfigPaths[dep];
        if (target && !exists(path.join(repoRoot, "apps/mobile", target)))
          failures.push({ alias: dep, tsconfigTargetMissing: target });
      }
      const tsSet = new Set(Object.keys(tsconfigPaths));
      for (const dep of Object.keys(metroAliases))
        if (!tsSet.has(dep)) failures.push({ metroAliasWithoutTsconfigPath: dep });
      for (const dep of Object.keys(jestMappers))
        if (!tsSet.has(dep)) failures.push({ jestMapperWithoutTsconfigPath: dep });
    }
    checks.push(
      result(
        "MOB-01",
        "apps/mobile @pickle/* imports are aliased consistently (tsconfig/metro/jest)",
        "P1",
        failures,
        infos,
      ),
    );
  }

  // MOB-02: native bridge matrix — every JS-referenced module has an iOS export.
  {
    const failures = [];
    const infos = [];
    for (const [name, m] of Object.entries(model.nativeBridges)) {
      if (m.js.length && !m.ios.length)
        failures.push({
          module: name,
          referencedFromJs: m.js.slice(0, 3),
          missing: "iOS RCT_EXTERN(_REMAP)_MODULE",
        });
      if (m.ios.length && !m.js.length)
        infos.push({ module: name, iosExportUnreferencedFromJs: m.ios });
      if (m.js.length && !m.android.length)
        infos.push({ module: name, noAndroidImplementation: true });
    }
    checks.push(
      result(
        "MOB-02",
        "React Native bridge names resolve to iOS native exports",
        "P0",
        failures,
        infos,
      ),
    );
  }

  // NAT-01: CocoaPods symlinks into native/ resolve.
  {
    const failures = [];
    const infos = [];
    for (const pod of model.native.pods) {
      for (const s of pod.symlinks)
        if (!s.resolvedExists) failures.push({ pod: pod.name, symlink: s.file, target: s.target });
      // Podspec lists Core/*.swift explicitly; every listed file must exist as a symlink.
      for (const g of pod.sourceGlobs) {
        if (g.includes("*")) continue;
        if (!pod.symlinks.some((s) => s.file.endsWith("/" + g.replace(/^Sources\//, ""))))
          failures.push({ pod: pod.name, podspecEntryNotOnDisk: g });
      }
      for (const s of pod.symlinks) {
        const rel = s.file.replace(/^.*\/Sources\/Core\//, "Sources/Core/");
        if (!pod.sourceGlobs.includes(rel))
          infos.push({ pod: pod.name, symlinkNotInPodspec: s.file });
      }
    }
    // native/vision-core sources that are NOT shipped into the app pod.
    const vc = model.native.swiftTargets.find((t) => t.dir === "native/vision-core");
    if (vc) {
      const linked = new Set(model.native.pods.flatMap((p) => p.symlinks.map((s) => s.target)));
      for (const f of vc.sourceFiles)
        if (!linked.has(f)) infos.push({ nativeSourceNotLinkedIntoAppPod: f });
    }
    checks.push(
      result(
        "NAT-01",
        "App pod symlinks resolve to native/ sources and match the podspec",
        "P0",
        failures,
        infos,
      ),
    );
  }

  // NAT-02: SwiftPM local dependencies resolve.
  {
    const failures = [];
    for (const t of model.native.swiftTargets) {
      for (const d of t.localDeps)
        if (!exists(path.join(repoRoot, d, "Package.swift")))
          failures.push({ target: t.name, localDepMissing: d });
    }
    checks.push(result("NAT-02", "SwiftPM local package dependencies resolve", "P1", failures));
  }

  // ROUTE-01: every METHOD /v1/path the mobile app calls exists in the edge fn.
  {
    const edge = model.routes.edge.routes;
    const failures = [];
    const infos = [];
    for (const [p, call] of Object.entries(model.routes.mobileClientCalls)) {
      const pathMatches = edge.filter((r) => r.path === p);
      if (!pathMatches.length) {
        failures.push({
          mobileCalls: `${call.methods.join("|")} ${p}`,
          where: call.where.slice(0, 3),
          notServedBy: "supabase/functions/api/index.ts",
        });
        continue;
      }
      for (const m of call.methods) {
        if (m === "UNKNOWN") {
          infos.push({
            path: p,
            note: "method not resolvable statically",
            where: call.where.slice(0, 2),
          });
          continue;
        }
        if (!pathMatches.some((r) => r.method === m || r.method === "ANY")) {
          failures.push({
            mobileCalls: `${m} ${p}`,
            where: call.where.slice(0, 3),
            edgeServesOnly: pathMatches.map((r) => r.method),
          });
        }
      }
    }
    const called = new Set(Object.keys(model.routes.mobileClientCalls));
    for (const r of edge)
      if (!called.has(r.path))
        infos.push({ edgeRouteNotCalledByMobile: `${r.method} ${r.path}`, where: r.where });
    checks.push(
      result(
        "ROUTE-01",
        "Every METHOD /v1 path referenced by apps/mobile is served by the edge function",
        "P1",
        failures,
        infos,
      ),
    );
  }

  // ROUTE-02: rate-limit families point at real routes.
  {
    const failures = [];
    const edgePaths = model.routes.edge.routes.map((r) => r.path);
    for (const fam of model.routes.edge.rateLimitFamilies) {
      const ok = edgePaths.some((p) => p === fam.path || p.startsWith(fam.path));
      if (!ok) failures.push({ rateLimitFamily: fam });
    }
    checks.push(
      result("ROUTE-02", "Edge rate-limit route families match served routes", "P2", failures),
    );
  }

  // ENV-01: env vars consumed by services/* or packages/* but absent from .env.example.
  {
    const failures = [];
    const IGNORE = new Set([
      "CI",
      "PICKLE_E2E_DATABASE_URL",
      "SCOUT_OUT",
      "HEALTH_REVIEW_NOW",
      "API_BASE_URL",
      "NODE_ENV",
    ]);
    for (const [name, v] of Object.entries(model.env)) {
      if (IGNORE.has(name)) continue;
      const nodeRuntime = v.runtimes.some((r) => r === "service(node)");
      if (nodeRuntime && !v.declaredIn.some((d) => d.startsWith(".env.example"))) {
        failures.push({
          env: name,
          consumers: v.consumers.slice(0, 4),
          missingFrom: ".env.example",
        });
      }
    }
    checks.push(
      result(
        "ENV-01",
        "Env vars read by services/* are documented in .env.example",
        "P3",
        failures,
      ),
    );
  }

  // ENV-02: edge-fn secrets documented in AGENTS.md or supabase/README.md.
  {
    const failures = [];
    const infos = [];
    for (const [name, v] of Object.entries(model.env)) {
      if (!v.runtimes.includes("edge-fn(deno)")) continue;
      const platformInjected =
        /^(SUPABASE_URL|SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY|SB_PUBLISHABLE_KEY)$/.test(
          name,
        );
      const testOnly = /^(STUB_|PICKLE_AUDIT_)/.test(name);
      const documented = v.declaredIn.some((d) =>
        /^(AGENTS\.md|supabase\/README\.md|docs\/devin\/)/.test(d),
      );
      if (!documented && !platformInjected && !testOnly)
        failures.push({ env: name, consumers: v.consumers.slice(0, 3) });
      if (testOnly)
        infos.push({
          env: name,
          note: "test/audit-only knob read by production entrypoint",
          consumers: v.consumers.slice(0, 2),
        });
    }
    checks.push(
      result(
        "ENV-02",
        "Edge-function secrets are documented (AGENTS.md / supabase/README.md)",
        "P2",
        failures,
        infos,
      ),
    );
  }

  // ENV-03: .env.example keys nobody reads (stale template entries).
  {
    const infos = [];
    for (const [name, v] of Object.entries(model.env)) {
      if (v.declaredIn.some((d) => d.startsWith(".env.example")) && v.consumers.length === 0)
        infos.push({ env: name, declaredIn: v.declaredIn });
    }
    checks.push(result("ENV-03", ".env.example keys with no consumer anywhere", "info", [], infos));
  }

  // ENV-04: secret-like names must not appear with literal values in TS/Swift source
  // (only checks the mobile runtime config for non-public patterns).
  {
    const failures = [];
    const rc = path.join(repoRoot, "apps/mobile/src/config/runtimeConfig.ts");
    if (exists(rc)) {
      const text = readFileSafe(rc);
      for (const m of text.matchAll(
        /['"](sk_[A-Za-z0-9]{10,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)['"]/g,
      )) {
        failures.push({
          file: "apps/mobile/src/config/runtimeConfig.ts",
          secretLikeLiteral: m[1].slice(0, 12) + "…",
        });
      }
    }
    checks.push(
      result(
        "ENV-04",
        "No non-public secret literals in apps/mobile runtime config",
        "P0",
        failures,
      ),
    );
  }

  // WF-01: workflow script references exist.
  {
    const failures = [];
    for (const [wf, w] of Object.entries(model.workflows)) {
      for (const [job, j] of Object.entries(w.jobs))
        for (const r of j.scriptRefs)
          if (!r.exists) failures.push({ workflow: wf, job, script: r.path, line: r.line });
    }
    checks.push(result("WF-01", "Workflow-referenced scripts exist", "P1", failures));
  }

  // WF-02: self-hosted workflows must be least-privilege + guarded.
  {
    const failures = [];
    const infos = [];
    for (const [wf, w] of Object.entries(model.workflows)) {
      if (!w.selfHosted) continue;
      if (w.triggers.includes("pull_request") || w.triggers.includes("pull_request_target"))
        failures.push({
          workflow: wf,
          issue: "pull_request trigger on a self-hosted personal runner",
        });
      if (!w.permissions)
        failures.push({
          workflow: wf,
          issue: "no top-level `permissions:` block (inherits repo default GITHUB_TOKEN scope)",
          file: `${wf}:1`,
        });
      if (!w.concurrencyGroup)
        infos.push({
          workflow: wf,
          note: "no `concurrency:` group — dispatches queue on the single runner but are not de-duplicated",
        });
      for (const [job, j] of Object.entries(w.jobs))
        if (j.timeoutMinutes == null && /self-hosted/.test(j.runsOn ?? ""))
          infos.push({ workflow: wf, job, note: "no timeout-minutes on a self-hosted job" });
    }
    checks.push(
      result(
        "WF-02",
        "Self-hosted (M4) workflows: no PR trigger, explicit read-only permissions",
        "P2",
        failures,
        infos,
      ),
    );
  }

  // WF-03: CI runs exactly the canonical verify stages (workflow ↔ script drift).
  {
    const failures = [];
    const ci = model.workflows[".github/workflows/ci.yml"];
    const vc = model.scripts["scripts/verify-cloud.sh"];
    if (ci && vc) {
      const stages = new Set([
        ...(vc.stageArrays.ALL_STAGES ?? []),
        ...(vc.stageArrays.PR_STAGES ?? []),
      ]);
      for (const s of stages)
        if (!vc.stageFunctions.includes(s))
          failures.push({ stageWithoutFunction: s, file: "scripts/verify-cloud.sh" });
      for (const fn of vc.stageFunctions)
        if (!stages.has(fn))
          failures.push({ stageFunctionNotInAnyTier: fn, file: "scripts/verify-cloud.sh" });
      const refsVerify = Object.values(ci.jobs).some((j) =>
        j.scriptRefs.some((r) => r.path === "scripts/verify-cloud.sh"),
      );
      if (!refsVerify)
        failures.push({
          workflow: ".github/workflows/ci.yml",
          issue: "does not invoke scripts/verify-cloud.sh",
        });
    }
    checks.push(
      result(
        "WF-03",
        "verify-cloud stage arrays ↔ stage functions ↔ ci.yml stay in sync",
        "P2",
        failures,
      ),
    );
  }

  // WF-04: mac-smoke-test.yml vs mac-full-verify.yml duplication.
  {
    const smoke = model.workflows[".github/workflows/mac-smoke-test.yml"];
    const full = model.workflows[".github/workflows/mac-full-verify.yml"];
    const infos = [];
    const failures = [];
    if (smoke && full) {
      infos.push({
        comparison: {
          "mac-smoke-test.yml": {
            triggers: smoke.triggers,
            permissions: smoke.permissions,
            concurrency: smoke.concurrencyGroup,
            inlineRunLines: smoke.inlineRunLines,
            scriptBacked: Object.values(smoke.jobs).some((j) => j.scriptRefs.length > 0),
          },
          "mac-full-verify.yml": {
            triggers: full.triggers,
            permissions: full.permissions,
            concurrency: full.concurrencyGroup,
            inlineRunLines: full.inlineRunLines,
            scriptBacked: Object.values(full.jobs).some((j) => j.scriptRefs.length > 0),
          },
        },
        verdict:
          "mac-smoke-test.yml is a strict subset of mac-full-verify.sh's `environment` stage (sw_vers/xcodebuild/swift/showsdks) and is not referenced by any script or doc as canonical.",
      });
      if (!smoke.permissions)
        failures.push({
          workflow: ".github/workflows/mac-smoke-test.yml",
          issue:
            "duplicate manual workflow on the M4 runner without `permissions:`; REVIEW.md requires workflows to be thin script wrappers",
        });
    }
    checks.push(
      result(
        "WF-04",
        "Mac workflows: mac-smoke-test.yml duplicates mac-full-verify environment stage",
        "P3",
        failures,
        infos,
      ),
    );
  }

  // SCR-01: scripts reference existing files; no `|| true`.
  {
    const failures = [];
    const infos = [];
    for (const [f, s] of Object.entries(model.scripts)) {
      for (const r of s.references)
        if (!r.exists && !/\$/.test(r.path))
          failures.push({ script: f, missingReference: r.path, line: r.line });
      for (const l of s.orTrueLines)
        failures.push({ script: f, verdictMaskingOrTrueAt: `${f}:${l}` });
      for (const l of s.orTrueBenignLines)
        infos.push({ script: f, bestEffortOrTrueAt: `${f}:${l}` });
      if (s.language === "shell" && !s.errexit && !s.usesPipefail)
        failures.push({ script: f, issue: "neither `set -e` nor `pipefail`" });
      if (s.language === "shell" && !s.errexit)
        infos.push({
          script: f,
          note: "no errexit (stage orchestrator or per-command handling)",
          nounset: s.nounset,
          pipefail: s.usesPipefail,
        });
    }
    checks.push(
      result(
        "SCR-01",
        "Shell entry points: references resolve, strict mode on, no `|| true`",
        "P2",
        failures,
        infos,
      ),
    );
  }

  // MIG-01: supabase migration naming + no duplicate timestamps; legacy system flagged.
  {
    const failures = [];
    const infos = [];
    const m = model.migrations;
    for (const b of m.supabase.badNames)
      failures.push({
        migration: `${m.supabase.dir}/${b}`,
        issue: "name not YYYYMMDDHHMMSS_description.sql",
      });
    for (const d of m.supabase.duplicateStamps) failures.push({ duplicateTimestamp: d });
    if (m.legacyNodeDatabase.files.length)
      infos.push({
        duplicateSystem: `${m.legacyNodeDatabase.dir} (${m.legacyNodeDatabase.files.length} files) — used by services/api + @pickle/database, not by the shipping backend (${m.supabase.dir}, ${m.supabase.files.length} files)`,
      });
    checks.push(
      result(
        "MIG-01",
        "Supabase migrations are well-named and unique; legacy migration tree flagged",
        "P1",
        failures,
        infos,
      ),
    );
  }

  // CP-01: declared critical paths reference files that exist.
  {
    const failures = [];
    for (const p of model.criticalPaths.paths) {
      for (const hop of p.hops)
        for (const via of hop.via)
          if (!exists(path.join(repoRoot, via)))
            failures.push({ path: p.id, hop: `${hop.from} → ${hop.to}`, missing: via });
    }
    for (const s of model.criticalPaths.externalSinglePointsOfFailure)
      for (const e of s.evidence)
        if (!exists(path.join(repoRoot, e))) failures.push({ spof: s.id, missingEvidence: e });
    checks.push(
      result("CP-01", "Critical-path hop files and SPOF evidence exist on disk", "P1", failures),
    );
  }

  // CP-02: critical-path routes exist in the edge fn.
  {
    const failures = [];
    const edgePaths = new Set(model.routes.edge.routes.map((r) => `${r.method} ${r.path}`));
    for (const p of model.criticalPaths.paths) {
      for (const hop of p.hops) {
        for (const m of `${hop.from} ${hop.to}`.matchAll(
          /\b(GET|POST|PUT|PATCH|DELETE) (\/v1\/[A-Za-z0-9_:./-]+)/g,
        )) {
          if (!edgePaths.has(`${m[1]} ${m[2]}`))
            failures.push({ path: p.id, route: `${m[1]} ${m[2]}`, notInEdgeRoutes: true });
        }
      }
    }
    checks.push(
      result("CP-02", "Critical-path HTTP routes are served by the edge function", "P1", failures),
    );
  }

  // FLAG-01: feature-flag system reaches the shipping product?
  {
    const infos = [];
    const failures = [];
    const ff = model.featureFlags;
    if (ff.flags.length) {
      const regKeys = new Set(ff.flags.map((f) => f.key));
      const seedOnly = ff.seedKeys.filter((k) => !regKeys.has(k));
      const regOnly = [...regKeys].filter((k) => !ff.seedKeys.includes(k));
      if (seedOnly.length) failures.push({ seedKeysNotInRegistry: seedOnly });
      if (regOnly.length) failures.push({ registryKeysNotInSeed: regOnly });
      infos.push({
        registryFlags: ff.flags.length,
        servedByLegacyApi: ff.servedByLegacyApi.length,
        servedByEdgeFunction: ff.servedByEdgeFunction.length,
        mobileReads: ff.mobileReads.length,
        verdict:
          ff.servedByEdgeFunction.length === 0 && ff.mobileReads.length === 0
            ? "remote feature flags are served only by services/api (legacy) and never read by apps/mobile or the edge function — the registry has no effect on the shipping product"
            : "flags reach the shipping product",
      });
      for (const f of ff.flags)
        if (f.mobileLiteralRefs?.length)
          infos.push({ flag: f.key, mobileLiteralRefs: f.mobileLiteralRefs.slice(0, 3) });
    }
    checks.push(
      result(
        "FLAG-01",
        "Feature-flag registry ↔ seed parity and reachability from the shipping app",
        "P2",
        failures,
        infos,
      ),
    );
  }

  // DATA-01: protected bench inputs exist; dataset dirs referenced by code exist.
  {
    const failures = [];
    const infos = [];
    for (const p of model.datasets.protectedFiles)
      if (!p.exists) failures.push({ protectedFileMissing: p.path });
    for (const [ref, files] of Object.entries(model.datasets.references)) {
      if (!(ref in model.datasets.dirs) && !exists(path.join(repoRoot, ref)))
        infos.push({ datasetPathReferencedButAbsent: ref, referencedFrom: files.slice(0, 3) });
    }
    for (const d of Object.keys(model.datasets.dirs))
      if (!(d in model.datasets.references)) infos.push({ datasetDirUnreferencedByCode: d });
    checks.push(
      result(
        "DATA-01",
        "Bench baseline/tolerances exist; dataset references resolve",
        "P1",
        failures,
        infos,
      ),
    );
  }

  // ART-01: release manifest paths exist; artifact roots are gitignored.
  {
    const failures = [];
    const a = model.artifacts;
    if (a.releaseManifest)
      for (const p of a.releaseManifest.referencedRepoPaths)
        if (!p.exists) failures.push({ releaseManifestPathMissing: p.path });
    for (const [root, r] of Object.entries(a.artifactRootsGitignored)) {
      if (r.gitignored || r.writtenBy.length === 0) continue;
      failures.push({
        artifactRootNotGitignored: root,
        probe: `git check-ignore -q -- ${root}/summary.json`,
        writtenBy: r.writtenBy,
      });
    }
    checks.push(
      result(
        "ART-01",
        "Release manifest references resolve; script-written artifact roots are gitignored",
        "P3",
        failures,
      ),
    );
  }

  // UNV-01: unverifiable-on-Linux surface is enumerated and covered by the Mac stages.
  {
    const infos = [];
    const u = model.unverifiable;
    for (const [k, v] of Object.entries(u.surfaces))
      infos.push({
        surface: k,
        files: v.files,
        loc: v.loc,
        verifiablePlane: k.includes("android") ? "none (no Android CI plane)" : "apple (M4 only)",
      });
    infos.push({
      macOnlyStages: u.macOnlyStages,
      skippedTests: u.skippedTests.length,
      conditionalSkips: u.conditionalSkips.length,
      platformBranches: u.platformBranches.count,
    });
    // Precondition-gated suites are legitimate when the precondition is met by
    // a CI plane (DATABASE_URL_TEST, ffmpeg, PICKLE_AUDIT_PG_URL). Listed as info.
    for (const c of u.conditionalSkips.filter((c) => !c.fsGatedUntracked))
      infos.push({ conditionalSkip: c });
    const failures = u.skippedTests.map((t) => ({ skippedTest: t }));
    checks.push(
      result(
        "UNV-01",
        "Unverifiable-on-Linux surfaces enumerated; no skipped tests",
        "P3",
        failures,
        infos,
      ),
    );
  }

  // UNV-02: a suite gated on a filesystem path that git does not track can
  // never execute in a clean checkout on ANY plane — it is dead coverage that
  // still reports "skipped", not "failed".
  {
    const failures = model.unverifiable.conditionalSkips
      .filter((c) => c.fsGatedUntracked)
      .map((c) => ({
        suite: c.where,
        guard: c.guardExpr,
        gatedOn: c.fsGatedUntracked,
        runsIn: "no CI plane (path absent in a clean checkout)",
      }));
    checks.push(
      result(
        "UNV-02",
        "Filesystem-gated test suites are runnable from a clean checkout",
        "P2",
        failures,
        [],
      ),
    );
  }

  // SPOF-01: computed package-graph single points of failure for the shipping roots.
  {
    const union = new Map();
    for (const n of names)
      union.set(n, new Set([...(declared.get(n) ?? []), ...(observed.get(n) ?? [])]));
    const roots = [...names].filter(
      (n) =>
        model.workspaces.nodes[n].kind === "app" || model.workspaces.nodes[n].kind === "service",
    );
    const spofs = singlePointsOfFailure(union, roots);
    const infos = [{ roots, spofs, fanIn: fanIn(union).slice(0, 10) }];
    checks.push(
      result("SPOF-01", "Package-graph single points of failure (computed)", "info", [], infos),
    );
  }

  return checks;
}

/**
 * ROUTE-03: the black-box probe (tools/archmap/edge/mobile_route_probe.ts run
 * against the real edge handler) must agree with the static ROUTE-01 verdict:
 * every statically-missing METHOD path is observed unrouted, and every
 * observed unrouted row (with a client-resolved method) is statically missing.
 * Disagreement means one of the two extractors is wrong — fail either way.
 */
export function crossCheckRouteProbe(model, probe) {
  const staticMissing = new Set(
    (model.invariants.find((c) => c.id === "ROUTE-01")?.details ?? []).map((d) => d.mobileCalls),
  );
  const rows = Array.isArray(probe?.rows) ? probe.rows : [];
  const failures = [];
  const infos = [];
  const observedMissing = new Set();
  for (const r of rows) {
    if (
      typeof r.method !== "string" ||
      typeof r.path !== "string" ||
      typeof r.routed !== "boolean"
    ) {
      failures.push({ malformedProbeRow: r });
      continue;
    }
    const key = `${r.method} ${r.path}`;
    if (!r.routed) observedMissing.add(key);
    if (!r.routed && r.methodSource === "client" && !staticMissing.has(key)) {
      failures.push({
        probeUnrouted: key,
        status: r.status,
        bodyPreview: r.bodyPreview,
        staticVerdict: "served",
      });
    }
    if (!r.routed && r.methodSource !== "client") {
      infos.push({
        probeUnrouted: key,
        methodSource: r.methodSource,
        note: "method guessed by probe, not by the client source",
      });
    }
  }
  for (const key of staticMissing) {
    if (!observedMissing.has(key)) {
      failures.push({
        staticMissing: key,
        probeVerdict: rows.some((r) => `${r.method} ${r.path}` === key) ? "routed" : "not probed",
      });
    }
  }
  return result(
    "ROUTE-03",
    "Black-box edge probe agrees with static mobile→edge route verdict",
    "P1",
    failures,
    infos,
    {
      probeCommand:
        "deno run -A --no-check --config supabase/functions/api/__wf__/deno.json tools/archmap/edge/mobile_route_probe.ts <routes-matrix.json> <route-probe.json>",
      probedRoutes: rows.length,
      confirmedUnrouted: [...staticMissing].filter((k) => observedMissing.has(k)).sort(),
    },
  );
}

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}
