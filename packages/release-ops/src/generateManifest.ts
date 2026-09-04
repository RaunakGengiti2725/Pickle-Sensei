import { execFileSync } from "node:child_process";
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
  type BackendReleaseRef,
  type MobileBuildRef,
  type ReleaseRecord,
} from "./releaseRecord.js";

/**
 * Generates the release-pipeline manifest for the CURRENT repo state. Every
 * version dimension is read from its single source of truth — nothing here is
 * hand-maintained, so the manifest cannot drift from the code it describes.
 *
 * Mobile build identity comes from infra/release/release-manifest.json
 * (versionScheme — the same source `pnpm release:check` trusts) and is
 * cross-checked against the values compiled into the iOS app; a mismatch is
 * an error, never a silently wrong record. The backend release is the
 * Supabase Edge Function in supabase/functions/api, which is deployed from the
 * repo tree and therefore versioned by the release commit SHA.
 *
 * Gates start honest: nothing evaluated, external gates BLOCKED_EXTERNAL.
 */

export const RELEASE_MANIFEST_PATH = "infra/release/release-manifest.json";
export const RUNTIME_CONFIG_PATH = "apps/mobile/src/config/runtimeConfig.ts";
export const IOS_PBXPROJ_PATH = "apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj";
export const EDGE_FUNCTION_DIR = "supabase/functions/api";

export function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("pnpm-workspace.yaml not found above " + startDir);
    dir = parent;
  }
}

function readVersionScheme(repoRoot: string): { marketingVersion: string; buildNumber: number } {
  const raw = readFileSync(join(repoRoot, RELEASE_MANIFEST_PATH), "utf8");
  const parsed = JSON.parse(raw) as { versionScheme?: unknown };
  const scheme = parsed.versionScheme;
  if (typeof scheme !== "object" || scheme === null) {
    throw new Error(`${RELEASE_MANIFEST_PATH} is missing versionScheme`);
  }
  const { marketingVersion, buildNumber } = scheme as {
    marketingVersion?: unknown;
    buildNumber?: unknown;
  };
  if (typeof marketingVersion !== "string" || !/^\d+\.\d+(\.\d+)?$/.test(marketingVersion)) {
    throw new Error(
      `${RELEASE_MANIFEST_PATH} versionScheme.marketingVersion must be MAJOR.MINOR[.PATCH]`,
    );
  }
  if (typeof buildNumber !== "number" || !Number.isInteger(buildNumber) || buildNumber < 1) {
    throw new Error(
      `${RELEASE_MANIFEST_PATH} versionScheme.buildNumber must be a positive integer`,
    );
  }
  return { marketingVersion, buildNumber };
}

function readRuntimeConfigAppVersion(repoRoot: string): string {
  const source = readFileSync(join(repoRoot, RUNTIME_CONFIG_PATH), "utf8");
  const match = /^const APP_VERSION = '([^']+)';$/m.exec(source);
  if (match?.[1] === undefined) {
    throw new Error(`${RUNTIME_CONFIG_PATH} does not declare const APP_VERSION = '<version>'`);
  }
  return match[1];
}

function readPbxprojVersions(repoRoot: string): {
  marketingVersions: Set<string>;
  projectVersions: Set<string>;
} {
  const source = readFileSync(join(repoRoot, IOS_PBXPROJ_PATH), "utf8");
  const marketingVersions = new Set<string>();
  const projectVersions = new Set<string>();
  for (const match of source.matchAll(/^\s*MARKETING_VERSION = ([^;]+);$/gm)) {
    if (match[1] !== undefined) marketingVersions.add(match[1].trim());
  }
  for (const match of source.matchAll(/^\s*CURRENT_PROJECT_VERSION = ([^;]+);$/gm)) {
    if (match[1] !== undefined) projectVersions.add(match[1].trim());
  }
  if (marketingVersions.size === 0 || projectVersions.size === 0) {
    throw new Error(`${IOS_PBXPROJ_PATH} declares no MARKETING_VERSION / CURRENT_PROJECT_VERSION`);
  }
  return { marketingVersions, projectVersions };
}

/**
 * The mobile build the release ships: marketing version + build number from
 * the release manifest, refused when the compiled app disagrees (runtimeConfig
 * APP_VERSION, Xcode MARKETING_VERSION / CURRENT_PROJECT_VERSION).
 */
export function readMobileBuildRef(repoRoot: string): MobileBuildRef {
  const scheme = readVersionScheme(repoRoot);
  const runtimeVersion = readRuntimeConfigAppVersion(repoRoot);
  const problems: string[] = [];
  if (runtimeVersion !== scheme.marketingVersion) {
    problems.push(
      `${RUNTIME_CONFIG_PATH} APP_VERSION '${runtimeVersion}' != versionScheme.marketingVersion '${scheme.marketingVersion}'`,
    );
  }
  const pbx = readPbxprojVersions(repoRoot);
  for (const version of pbx.marketingVersions) {
    if (version !== scheme.marketingVersion) {
      problems.push(
        `${IOS_PBXPROJ_PATH} MARKETING_VERSION '${version}' != versionScheme.marketingVersion '${scheme.marketingVersion}'`,
      );
    }
  }
  for (const version of pbx.projectVersions) {
    if (version !== String(scheme.buildNumber)) {
      problems.push(
        `${IOS_PBXPROJ_PATH} CURRENT_PROJECT_VERSION '${version}' != versionScheme.buildNumber ${scheme.buildNumber}`,
      );
    }
  }
  if (problems.length > 0) {
    throw new Error("mobile build version drift:\n  - " + problems.join("\n  - "));
  }
  return { appVersion: scheme.marketingVersion, buildNumber: String(scheme.buildNumber) };
}

/**
 * The production backend is the Supabase Edge Function deployed from the repo
 * tree (`supabase functions deploy api`); it carries no version of its own, so
 * the release commit SHA is its version.
 */
export function readBackendReleaseRef(repoRoot: string, commitSha: string): BackendReleaseRef {
  if (!existsSync(join(repoRoot, EDGE_FUNCTION_DIR, "index.ts"))) {
    throw new Error(`${EDGE_FUNCTION_DIR}/index.ts not found — no backend to describe`);
  }
  return { serviceName: EDGE_FUNCTION_DIR, version: commitSha };
}

export function readDatabaseSchemaVersion(repoRoot: string): {
  latestMigration: string;
  migrationCount: number;
} {
  const migrations = readdirSync(join(repoRoot, "packages/database/migrations"))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const latestMigration = migrations[migrations.length - 1];
  if (latestMigration === undefined) throw new Error("no database migrations found");
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
  const commitSha = options.commitSha ?? readCommitSha(repoRoot);

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
    commitSha,
    mobileBuild: readMobileBuildRef(repoRoot),
    backendRelease: readBackendReleaseRef(repoRoot, commitSha),
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
