// Self-tests for the static-health audit harness. Each detector is fed a
// synthetic source that MUST trip it (so a "0 findings" report means the
// production code is clean, not that the detector is blind), plus the
// repository pins the harness relies on (mobile/shared never talk to
// PostgREST directly, so the edge fn inventory IS the client write surface).
//
//   cd tools/audit/static_health_edge_db && deno task test

import { assert, assertEquals, assertGreater } from "@std/assert";
import { repoPath, ts, type SourceFile } from "./lib/ast.ts";
import { inventory } from "./write_inventory.ts";
import {
  runScan,
  scanCatches,
  scanEmitters,
  scanFloatingPromises,
  scanMigrationCodes,
} from "./static_scan.ts";

function synthetic(text: string, path = "synthetic/edge.ts"): SourceFile {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  return { path, text, sf };
}

Deno.test("scanEmitters flags a 5xx body that interpolates the upstream error", () => {
  const src = synthetic(`
    async function route(db: any) {
      const r = await db.from("x").select("id");
      if (r.error) return errorJson(503, \`Database failed: \${r.error.message}\`);
      return json(200, {});
    }
  `);
  const emitters = scanEmitters(src);
  const leak = emitters.find((e) => e.status === 503);
  assert(leak, "503 emitter must be found");
  assert(leak.leaksDetail, "interpolating r.error.message into a 5xx body must be flagged");
});

Deno.test(
  "scanEmitters keeps a generic 5xx body clean and records codedError codes/statuses",
  () => {
    const src = synthetic(`
    function route() {
      if (bad) return codedError(409, "session.id_conflict", "Session id belongs to another user.");
      return serviceUnavailable("Session sync", err.message);
    }
  `);
    const emitters = scanEmitters(src);
    const coded = emitters.find((e) => e.via === "codedError");
    const su = emitters.find((e) => e.via === "serviceUnavailable");
    assertEquals(coded?.code, "session.id_conflict");
    assertEquals(coded?.status, 409);
    assertEquals(su?.status, 503);
    assertEquals(su?.leaksDetail, false);
    assertEquals(su?.noServerDetail, false);
  },
);

Deno.test(
  "scanEmitters flags serviceUnavailable(...) with no operator detail and a non-literal status",
  () => {
    const src = synthetic(`
    function route(status: number) {
      if (a) return serviceUnavailable("Drill save");
      return errorJson(status, "Something failed.");
    }
  `);
    const emitters = scanEmitters(src);
    assert(emitters.some((e) => e.via === "serviceUnavailable" && e.noServerDetail));
    assert(emitters.some((e) => e.via === "errorJson" && e.status === null));
  },
);

Deno.test("scanCatches distinguishes silent, fallback and logging catch blocks", () => {
  const src = synthetic(`
    async function a() {
      try { await x(); } catch {}
      try { await y(); } catch (err) { console.error("[api] y failed:", err); throw err; }
      try { await z(); } catch (_err) { return null; }
    }
  `);
  const sites = scanCatches(src);
  assertEquals(sites.length, 3);
  const kinds = sites.map((s) => s.classification).sort();
  assert(kinds.includes("silent"), `expected a silent catch, got ${kinds}`);
  assert(
    kinds.some((k) => k !== "silent"),
    "the logging/rethrowing catch must not be silent",
  );
});

Deno.test("scanFloatingPromises catches a fire-and-forget db write", () => {
  const src = synthetic(`
    async function route(db: any) {
      db.from("profiles").update({ a: 1 }).eq("id", 1);
      void db.from("profiles").update({ a: 2 }).eq("id", 1);
      await db.from("profiles").update({ a: 3 }).eq("id", 1);
    }
  `);
  const floating = scanFloatingPromises(src);
  assertGreater(floating.length, 0, "an un-awaited, un-voided db chain must be reported");
});

Deno.test("inventory classifies every edge fn PostgREST/RPC access with a known role", () => {
  const rows = inventory();
  assertGreater(rows.length, 30);
  assertEquals(rows.filter((r) => r.role === "unknown").length, 0);
  const tables = new Set(rows.filter((r) => r.op !== "rpc").map((r) => r.target));
  const migrations = [...Deno.readDirSync(repoPath("supabase/migrations"))]
    .map((e) => e.name)
    .filter((n) => n.endsWith(".sql"))
    .sort()
    .map((n) => Deno.readTextFileSync(repoPath(`supabase/migrations/${n}`)))
    .join("\n");
  for (const table of tables) {
    assert(
      new RegExp(
        `create (?:table(?: if not exists)?|or replace view|view) public\\.${table}\\b`,
        "i",
      ).test(migrations),
      `edge fn touches public.${table} but no migration creates it`,
    );
  }
  const rpcs = new Set(rows.filter((r) => r.op === "rpc").map((r) => r.target));
  for (const fn of rpcs) {
    assert(
      new RegExp(`create (?:or replace )?function public\\.${fn}\\s*\\(`, "i").test(migrations),
      `edge fn calls rpc ${fn} but no migration defines it`,
    );
  }
});

Deno.test(
  "mobile app and shared packages never talk to PostgREST/RPC directly (edge fn is the only DB client)",
  () => {
    const roots = ["apps/mobile/src", "packages"];
    const offenders: string[] = [];
    const isSource = (name: string) =>
      /\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\.|__tests__|node_modules|\.d\.ts$/.test(name);
    const visit = (dir: string) => {
      for (const entry of Deno.readDirSync(dir)) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory) {
          if (entry.name === "node_modules" || entry.name === "__tests__" || entry.name === "dist")
            continue;
          visit(full);
        } else if (isSource(full)) {
          const text = Deno.readTextFileSync(full);
          if (
            /@supabase\/supabase-js|\/rest\/v1\/|\.rpc\(\s*['"]|\.from\(\s*['"][a-z_]+['"]\s*\)\s*\.(select|insert|update|upsert|delete)\(/.test(
              text,
            )
          ) {
            offenders.push(full.slice(repoPath("").length));
          }
        }
      }
    };
    for (const root of roots) visit(repoPath(root));
    assertEquals(
      offenders,
      [],
      "direct Supabase data access outside the edge fn would bypass the audited grant surface",
    );
  },
);

Deno.test("scanMigrationCodes finds the RPC rejection codes that reach the app", () => {
  const codes = new Set(scanMigrationCodes().map((c) => c.code));
  assert(codes.has("shot.session_not_found"), `expected shot.session_not_found in ${[...codes]}`);
});

Deno.test("runScan report has every check with a boolean verdict and summary", () => {
  const report = runScan();
  assertEquals(report.checks.length, 9);
  for (const check of report.checks) {
    assertEquals(typeof check.pass, "boolean", check.id);
    assertGreater(check.summary.length, 0, check.id);
  }
  assertGreater(report.emitters.filter((e) => (e.status ?? 0) >= 500).length, 20);
  assertGreater(report.structure.routeCount, 10);
});
