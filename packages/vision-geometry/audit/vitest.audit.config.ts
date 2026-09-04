import { defineConfig } from "vitest/config";

/**
 * Execution-audit harness config (devin/audit-pkg-vision-geometry-execution).
 * Files are named `*.audit.ts` (not `*.test.ts`) so the default `pnpm test`
 * glob and `pnpm eval` never pick them up; run explicitly with
 *   pnpm --filter @pickle/vision-geometry exec vitest run --config audit/vitest.audit.config.ts
 * Writes a machine-readable result table to $AUDIT_OUT_DIR (default
 * artifacts/vision-geometry-audit/) — never into datasets/.
 */
export default defineConfig({
  test: { include: ["audit/**/*.audit.ts"] },
});
