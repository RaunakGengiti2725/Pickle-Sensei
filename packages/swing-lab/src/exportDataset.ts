import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  assignSplits,
  REAL_BENCHMARK_SCHEMA_VERSION,
  validateRealBenchmarkManifest,
  type RealBenchmarkCase,
  type RealBenchmarkManifest,
} from "@pickle/evaluation";
import type { CaptureRecord } from "@pickle/swing-domain";

/**
 * Consent-gated dataset exporter.
 *
 * Scans a directory of capture bundles and produces a real-benchmark
 * manifest. The gate is the point: a capture without explicit granted
 * training consent CANNOT be exported — "not_asked" is treated exactly like
 * "denied", and there is no override flag.
 *
 * Bundle layout (one directory per capture):
 *   <root>/<bundle>/capture.json        CaptureRecord (consent lives here)
 *   <root>/<bundle>/player.json         { "playerId": "pseudonym" }
 *   <root>/<bundle>/clip.(mp4|mov)      the exact video bytes
 *   <root>/<bundle>/pose.json           canonical pose-sequence sidecar
 *   <root>/<bundle>/annotation/*.json   one file per annotator
 *
 * The manifest references files by content hash; it never copies media.
 */

export interface ExportSkip {
  bundle: string;
  reason:
    | "missing_capture_json"
    | "consent_not_granted"
    | "missing_player_id"
    | "missing_clip"
    | "missing_pose_sequence"
    | "missing_annotation"
    | "malformed_capture_json";
}

export interface ExportOutcome {
  manifest: RealBenchmarkManifest | null;
  included: number;
  skipped: ExportSkip[];
}

export function exportDataset(input: {
  rootDir: string;
  datasetId: string;
  version: string;
  nowIso?: string;
}): ExportOutcome {
  const rootDir = resolve(input.rootDir);
  const skipped: ExportSkip[] = [];
  const cases: RealBenchmarkCase[] = [];

  const bundles = readdirSync(rootDir)
    .map((name) => join(rootDir, name))
    .filter((path) => statSync(path).isDirectory())
    .sort();

  for (const bundleDir of bundles) {
    const bundle = relative(rootDir, bundleDir);
    const capturePath = join(bundleDir, "capture.json");
    if (!existsSync(capturePath)) {
      skipped.push({ bundle, reason: "missing_capture_json" });
      continue;
    }
    let capture: CaptureRecord;
    try {
      capture = JSON.parse(readFileSync(capturePath, "utf8")) as CaptureRecord;
    } catch {
      skipped.push({ bundle, reason: "malformed_capture_json" });
      continue;
    }
    // THE gate: explicit granted consent or the capture does not leave.
    if (capture.consent?.state !== "granted") {
      skipped.push({ bundle, reason: "consent_not_granted" });
      continue;
    }
    const playerPath = join(bundleDir, "player.json");
    const playerId = existsSync(playerPath)
      ? (JSON.parse(readFileSync(playerPath, "utf8")) as { playerId?: string }).playerId
      : undefined;
    if (!playerId) {
      skipped.push({ bundle, reason: "missing_player_id" });
      continue;
    }
    const clipName = readdirSync(bundleDir).find((name) => /^clip\.(mp4|mov)$/i.test(name));
    if (!clipName) {
      skipped.push({ bundle, reason: "missing_clip" });
      continue;
    }
    const posePath = join(bundleDir, "pose.json");
    if (!existsSync(posePath)) {
      skipped.push({ bundle, reason: "missing_pose_sequence" });
      continue;
    }
    const annotationDir = join(bundleDir, "annotation");
    const annotations = existsSync(annotationDir)
      ? readdirSync(annotationDir).filter((name) => name.endsWith(".json"))
      : [];
    if (annotations.length === 0) {
      skipped.push({ bundle, reason: "missing_annotation" });
      continue;
    }

    const videoSha256 = sha256File(join(bundleDir, clipName));
    cases.push({
      caseId: `case-${videoSha256.slice(0, 16)}`,
      videoSha256,
      poseSequenceSha256: sha256File(posePath),
      playerId,
      declaredStroke: capture.stroke?.declared ?? "unknown",
      annotationPath: join(bundle, "annotation", annotations[0]!),
    });
  }

  if (cases.length === 0) {
    return { manifest: null, included: 0, skipped };
  }
  const manifest: RealBenchmarkManifest = {
    schemaVersion: REAL_BENCHMARK_SCHEMA_VERSION,
    id: input.datasetId,
    version: input.version,
    createdAtIso: input.nowIso ?? new Date().toISOString(),
    provenance: "consented_first_party",
    splitRatios: { train: 0.7, val: 0.15, test: 0.15 },
    cases,
  };
  const validated = validateRealBenchmarkManifest(manifest);
  if (!validated.ok) {
    throw new Error(`exporter produced an invalid manifest: ${validated.failure.message}`);
  }
  return { manifest, included: cases.length, skipped };
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// ── CLI ────────────────────────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith("exportDataset.ts");
if (isMain) {
  const [rootDir, datasetId, version] = process.argv.slice(2);
  if (!rootDir || !datasetId) {
    console.error("usage: pnpm dataset:export <bundles-dir> <dataset-id> [version]");
    process.exit(2);
  }
  const outcome = exportDataset({ rootDir, datasetId, version: version ?? "1.0.0" });
  for (const skip of outcome.skipped) {
    console.log(`skip ${skip.bundle}: ${skip.reason}`);
  }
  if (!outcome.manifest) {
    console.log("no exportable bundles (nothing had granted consent + labels).");
    process.exit(1);
  }
  const withSplits = assignSplits(outcome.manifest);
  const counts = { train: 0, val: 0, test: 0 };
  for (const entry of withSplits) counts[entry.split] += 1;
  const outPath = join(resolve(rootDir), `${datasetId}.manifest.json`);
  writeFileSync(outPath, JSON.stringify({ ...outcome.manifest, splitsPreview: counts }, null, 2));
  console.log(
    `exported ${outcome.included} cases (${counts.train} train / ${counts.val} val / ${counts.test} test players-grouped) -> ${outPath}`,
  );
}
