// `pg` resolution helper for the stress harnesses.
//
// The repo root has no `pg` dependency (the driver lives in the workspaces
// that talk to Postgres), so resolve it from the workspaces that do rather
// than adding a root dependency for a test-only harness.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");

const CANDIDATES = [
  path.join(repoRoot, "packages/database/package.json"),
  path.join(repoRoot, "services/api/package.json"),
  path.join(repoRoot, "services/media-worker/package.json"),
  path.join(repoRoot, "package.json"),
];

export function loadPg() {
  const failures = [];
  for (const from of CANDIDATES) {
    try {
      return createRequire(from)("pg");
    } catch (error) {
      failures.push(`${from}: ${error.code ?? error.message}`);
    }
  }
  throw new Error(
    `unable to resolve the "pg" driver. Run \`pnpm install\` first.\n${failures.join("\n")}`,
  );
}
