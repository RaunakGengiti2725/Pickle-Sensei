// W01-04 objective: "Make packages/shared-types the single definition of when
// an outcome is chargeable ... so the three planes cannot drift." A definition
// nothing in the shipping planes consults cannot prevent drift; this test
// asserts that at least one non-test module of each shipping plane (the Edge
// function and the mobile app) actually decides through the canonical module.
//   pnpm --filter @pickle/shared-types exec vitest run src/__tests__/attack/chargeability.shippingCaller.attack.test.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");
const CANONICAL_SYMBOLS = ["decideChargeability", "isChargeableAnalysis"] as const;

function isTestPath(path: string): boolean {
  return (
    /\.(test|spec)\.tsx?$/.test(path) ||
    path.includes("/__tests__/") ||
    path.includes("/__wf__/") ||
    path.includes("/test/") ||
    path.includes("/node_modules/")
  );
}

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (name === "node_modules" || name.startsWith(".")) continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(full) && !isTestPath(full)) out.push(full);
    }
  };
  walk(dir(root));
  return out;
}

function dir(path: string): string {
  return resolve(REPO_ROOT, path);
}

function shippingCallers(root: string): string[] {
  return sourceFiles(root).filter((file) => {
    const text = readFileSync(file, "utf8");
    return CANONICAL_SYMBOLS.some((symbol) => new RegExp(`\\b${symbol}\\s*\\(`).test(text));
  });
}

describe("W01-04 attack: the canonical predicate must be on a shipping path", () => {
  it("the Edge function (production backend) decides chargeability through the shared module", () => {
    const callers = shippingCallers("supabase/functions/api");
    expect(
      callers,
      "no non-test Edge module calls decideChargeability/isChargeableAnalysis",
    ).not.toHaveLength(0);
  });

  it("the mobile app decides chargeability through the shared module", () => {
    const callers = shippingCallers("apps/mobile/src");
    expect(
      callers,
      "no non-test mobile module calls decideChargeability/isChargeableAnalysis",
    ).not.toHaveLength(0);
  });

  it("within shared-types the only production caller is reachable from a shipping plane", () => {
    // offlineAuthorization.ts calls isChargeableAnalysis inside
    // validateOfflineResultReceiptBinding; something outside tests must call that.
    const consumers = [
      ...sourceFiles("supabase/functions/api"),
      ...sourceFiles("apps/mobile/src"),
      ...sourceFiles("packages/shared-types/src"),
    ].filter((file) => {
      if (file.endsWith("/offlineAuthorization.ts")) return false;
      return /\bvalidateOfflineResultReceiptBinding\s*\(/.test(readFileSync(file, "utf8"));
    });
    expect(
      consumers,
      "validateOfflineResultReceiptBinding has no non-test caller",
    ).not.toHaveLength(0);
  });
});
