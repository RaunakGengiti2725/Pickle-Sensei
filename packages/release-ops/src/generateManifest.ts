import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CAPTURE_ENVELOPE_THRESHOLDS_VERSION } from "@pickle/capture-envelope";
import { FEATURE_FLAG_SEED_DEFAULTS } from "@pickle/database";
import { DEFAULT_MODEL_MANIFEST } from "@pickle/model-registry";
import { SCORING_MODEL_VERSION } from "@pickle/scoring";
import { SHARED_SIDE_PROFILES_V1, TECHNIQUE_ANALYSIS_PROFILES_V1 } from "@pickle/shared-types";
import { DRILL_LIBRARY_V0_VERSION, FAULT_TAXONOMY_V0_DRAFT_VERSION } from "@pickle/swing-lab";
import {
  createInitialCoachReviewGate,
  createInitialStageGates,
  RELEASE_RECORD_SCHEMA_VERSION,
  type ReleaseRecord,
} from "./releaseRecord.js";

/**
 * Generates the release-pipeline manifest for the CURRENT repo state. Every
 * version dimension is read from its single source of truth — nothing here is
 * hand-maintained, so the manifest cannot drift from the code it describes.
 *
 * Gates start honest: nothing evaluated, external gates BLOCKED_EXTERNAL.
 *
 * The backend that ships is the Supabase Edge Function in
 * supabase/functions/api with the schema in supabase/migrations (AGENTS.md).
 * services/api and packages/database are the legacy local stack the mobile
 * app does not call, so the record never describes them.
 */

/** Repo path of the shipping backend; doubles as its serviceName. */
export const SHIPPING_BACKEND_PATH = "supabase/functions/api";
/** Repo path of the schema the shipping backend runs against. */
export const SHIPPING_MIGRATIONS_PATH = "supabase/migrations";

export function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("pnpm-workspace.yaml not found above " + startDir);
    dir = parent;
  }
}

function readPackageVersion(repoRoot: string, relPath: string): { name: string; version: string } {
  const raw = readFileSync(join(repoRoot, relPath, "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
  if (typeof parsed.name !== "string" || typeof parsed.version !== "string") {
    throw new Error(`${relPath}/package.json is missing name or version`);
  }
  return { name: parsed.name, version: parsed.version };
}

/**
 * The edge function has no package.json; its version is a fingerprint of the
 * deployable source (the top-level .ts modules `supabase functions deploy`
 * bundles — tests under __wf__ are not part of the deploy).
 */
export function readBackendRelease(repoRoot: string): { serviceName: string; version: string } {
  const dir = join(repoRoot, SHIPPING_BACKEND_PATH);
  if (!existsSync(join(dir, "index.ts"))) {
    throw new Error(`${SHIPPING_BACKEND_PATH}/index.ts not found`);
  }
  const sources = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .sort();
  const hash = createHash("sha256");
  for (const name of sources) {
    hash.update(name);
    hash.update("\0");
    hash.update(readFileSync(join(dir, name)));
    hash.update("\0");
  }
  return {
    serviceName: SHIPPING_BACKEND_PATH,
    version: `sha256-${hash.digest("hex").slice(0, 16)}`,
  };
}

export function readDatabaseSchemaVersion(repoRoot: string): {
  latestMigration: string;
  migrationCount: number;
} {
  const migrations = readdirSync(join(repoRoot, SHIPPING_MIGRATIONS_PATH))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const latestMigration = migrations[migrations.length - 1];
  if (latestMigration === undefined) {
    throw new Error(`no migrations found in ${SHIPPING_MIGRATIONS_PATH}`);
  }
  return { latestMigration, migrationCount: migrations.length };
}

export function readCommitSha(repoRoot: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
}

export interface GenerateManifestOptions {
  repoRoot: string;
  /** Injectable for deterministic tests. */
  commitSha?: string;
  generatedAtIso?: string;
}

export function generateReleaseRecord(options: GenerateManifestOptions): ReleaseRecord {
  const { repoRoot } = options;
  const mobile = readPackageVersion(repoRoot, "apps/mobile");

  const techniqueAnalysisProfileVersions: Record<string, string> = {};
  for (const [canonical, profile] of Object.entries(TECHNIQUE_ANALYSIS_PROFILES_V1)) {
    techniqueAnalysisProfileVersions[canonical] = profile.profileVersion;
  }
  for (const profile of Object.values(SHARED_SIDE_PROFILES_V1)) {
    techniqueAnalysisProfileVersions[profile.id] = profile.profileVersion;
  }

  const featureFlags: Record<string, boolean> = {};
  for (const [key, , enabled] of FEATURE_FLAG_SEED_DEFAULTS) featureFlags[key] = enabled;

  return {
    schemaVersion: RELEASE_RECORD_SCHEMA_VERSION,
    generatedAtIso: options.generatedAtIso ?? new Date().toISOString(),
    commitSha: options.commitSha ?? readCommitSha(repoRoot),
    mobileBuild: { appVersion: mobile.version, buildNumber: null },
    backendRelease: readBackendRelease(repoRoot),
    databaseSchema: readDatabaseSchemaVersion(repoRoot),
    modelVersions: DEFAULT_MODEL_MANIFEST.entries.map((entry) => ({
      id: entry.id,
      version: entry.version,
      deploymentStatus: entry.deploymentStatus,
    })),
    techniqueAnalysisProfileVersions,
    scoreVersion: SCORING_MODEL_VERSION,
    faultTaxonomyVersion: FAULT_TAXONOMY_V0_DRAFT_VERSION,
    drillLibraryVersion: DRILL_LIBRARY_V0_VERSION,
    captureEnvelopeVersion: CAPTURE_ENVELOPE_THRESHOLDS_VERSION,
    featureFlags,
    stageGates: createInitialStageGates(),
    coachReviewGate: createInitialCoachReviewGate(),
  };
}
