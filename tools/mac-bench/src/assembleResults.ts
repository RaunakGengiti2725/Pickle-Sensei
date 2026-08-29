import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { summarizeStages, type StageSample } from "./latencyStats.js";
import {
  MAC_BENCH_RESULTS_SCHEMA_VERSION,
  validateMacBenchResults,
  type MacBenchCascadeSummary,
  type MacBenchExtractorBuild,
  type MacBenchHost,
  type MacBenchProvenance,
  type MacBenchResultsV1,
  type MacBenchRunPlan,
} from "./resultsSchema.js";

/**
 * assembleResults — turns one bench run's raw evidence into a validated
 * mac-bench-results-v1 document.
 *
 *   pnpm --filter @pickle/mac-bench assemble -- \
 *     --samples <stage-samples.jsonl> \
 *     [--cascade <datasets/cascade/cascade-*.json> | --cascade-unmeasured "<reason>"] \
 *     --cases id1,id2,… --cold 1 --warm 3 \
 *     --extractor-built true --extractor-ms 41000 --extractor-bin <path> \
 *     --out <results.json> [--note "…"]…
 *
 * The pure `assembleResults()` function is fixture-tested on Linux; only the
 * CLI host/provenance probes touch the running system. The assembler NEVER
 * recomputes cascade numbers — it copies the counters `pnpm lab:cascade`
 * wrote, keeping one source of truth.
 */

interface RawCascadeDocument {
  goldEvents: number;
  unconditionalPass: Record<string, number>;
  conditionalSurvival: Record<string, number>;
  strictSurvival: { survived: number; total: number };
  usableResult: { usable: number; total: number; contract: { version: string } };
  silentFailure: {
    silentFailures: number;
    answeredTrials: number;
    allTrials: number;
    contract: { version: string };
  };
}

export function parseStageSamplesJsonl(content: string): StageSample[] {
  const samples: StageSample[] = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`stage-samples line ${index + 1}: invalid JSON`);
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as StageSample).stage !== "string" ||
      typeof (parsed as StageSample).caseId !== "string" ||
      ((parsed as StageSample).phase !== "cold" && (parsed as StageSample).phase !== "warm") ||
      !Number.isInteger((parsed as StageSample).iteration) ||
      (parsed as StageSample).iteration < 1 ||
      !Number.isFinite((parsed as StageSample).wallMs) ||
      (parsed as StageSample).wallMs < 0
    ) {
      throw new Error(`stage-samples line ${index + 1}: not a valid StageSample`);
    }
    samples.push(parsed as StageSample);
  }
  if (samples.length === 0) {
    throw new Error("stage-samples: no samples found");
  }
  return samples;
}

/** A lab:cascade document with zero gold events (what cascadeWaterfall emits
 * when the canonical run dirs or gold annotations are absent) carries no
 * cascade evidence. It becomes cascade=null with an explicit reason instead
 * of failing schema validation at the very end of a bench run — the timing
 * evidence must survive, and absence stays explained, never zeroed. */
export function cascadeUnmeasuredReasonFor(
  raw: RawCascadeDocument,
  sourceFile: string,
): string | null {
  if (raw.goldEvents >= 1) return null;
  return `lab:cascade output ${sourceFile} contains 0 gold events (canonical runs or gold annotations absent) — no cascade evidence in this run`;
}

export function summarizeCascadeDocument(
  raw: RawCascadeDocument,
  sourceFile: string,
): MacBenchCascadeSummary {
  return {
    sourceFile,
    goldEvents: raw.goldEvents,
    unconditionalPass: raw.unconditionalPass,
    conditionalSurvival: raw.conditionalSurvival,
    strictSurvival: { survived: raw.strictSurvival.survived, total: raw.strictSurvival.total },
    usableResult: {
      usable: raw.usableResult.usable,
      total: raw.usableResult.total,
      contractVersion: raw.usableResult.contract.version,
    },
    silentFailure: {
      silentFailures: raw.silentFailure.silentFailures,
      answeredTrials: raw.silentFailure.answeredTrials,
      allTrials: raw.silentFailure.allTrials,
      contractVersion: raw.silentFailure.contract.version,
    },
  };
}

export interface AssembleInput {
  samples: StageSample[];
  host: MacBenchHost;
  provenance: MacBenchProvenance;
  plan: MacBenchRunPlan;
  extractor: MacBenchExtractorBuild;
  cascade: MacBenchCascadeSummary | null;
  cascadeUnmeasuredReason: string | null;
  notes: string[];
  generatedAtIso?: string;
}

export function assembleResults(input: AssembleInput): MacBenchResultsV1 {
  const document: MacBenchResultsV1 = {
    schemaVersion: MAC_BENCH_RESULTS_SCHEMA_VERSION,
    generatedAtIso: input.generatedAtIso ?? new Date().toISOString(),
    host: input.host,
    provenance: input.provenance,
    plan: input.plan,
    extractor: input.extractor,
    stages: summarizeStages(input.samples),
    cascade: input.cascade,
    cascadeUnmeasuredReason: input.cascade === null ? input.cascadeUnmeasuredReason : null,
    notes: input.notes,
  };
  const errors = validateMacBenchResults(document);
  if (errors.length > 0) {
    throw new Error(`assembled document failed validation:\n  ${errors.join("\n  ")}`);
  }
  return document;
}

function flagValue(name: string, argv: readonly string[]): string | null {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) return null;
  return argv[index + 1] ?? null;
}

function flagValues(name: string, argv: readonly string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] === name) {
      const value = argv[index + 1];
      if (value !== undefined) values.push(value);
    }
  }
  return values;
}

function probe(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

const isMain = process.argv[1]?.endsWith("assembleResults.ts");
if (isMain) {
  const argv = process.argv.slice(2);
  const samplesPath = flagValue("--samples", argv);
  const outPath = flagValue("--out", argv);
  const cases = flagValue("--cases", argv);
  if (!samplesPath || !outPath || !cases) {
    console.error(
      "usage: assembleResults --samples <jsonl> --cases id1,id2 --out <json> [see file header]",
    );
    process.exit(2);
  }

  const cascadePath = flagValue("--cascade", argv);
  const cascadeUnmeasuredReason = flagValue("--cascade-unmeasured", argv);
  if (!cascadePath && !cascadeUnmeasuredReason) {
    console.error("either --cascade <file> or --cascade-unmeasured <reason> is required");
    process.exit(2);
  }

  let cascade: MacBenchCascadeSummary | null = null;
  let zeroGoldReason: string | null = null;
  if (cascadePath) {
    const raw = JSON.parse(readFileSync(cascadePath, "utf8")) as RawCascadeDocument;
    zeroGoldReason = cascadeUnmeasuredReasonFor(raw, cascadePath);
    if (zeroGoldReason === null) {
      cascade = summarizeCascadeDocument(raw, cascadePath);
    } else {
      console.error(`assembleResults: ${zeroGoldReason}`);
    }
  }

  const document = assembleResults({
    samples: parseStageSamplesJsonl(readFileSync(samplesPath, "utf8")),
    host: {
      platform: process.platform,
      osVersion: probe("sw_vers", ["-productVersion"]) ?? probe("uname", ["-r"]) ?? "unknown",
      hardwareModel: probe("sysctl", ["-n", "hw.model"]),
      nodeVersion: process.version,
      pythonVersion: probe("python3", ["--version"]),
    },
    provenance: {
      gitCommit: probe("git", ["rev-parse", "HEAD"]) ?? "unknown",
      gitBranch: probe("git", ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "unknown",
      dirtyWorkingTree: (probe("git", ["status", "--porcelain"]) ?? "") !== "",
    },
    plan: {
      caseIds: cases.split(",").filter((id) => id.length > 0),
      coldIterations: Number(flagValue("--cold", argv) ?? "1"),
      warmIterations: Number(flagValue("--warm", argv) ?? "0"),
    },
    extractor: {
      built: flagValue("--extractor-built", argv) === "true",
      buildWallMs: flagValue("--extractor-ms", argv)
        ? Number(flagValue("--extractor-ms", argv))
        : null,
      binaryPath: flagValue("--extractor-bin", argv),
    },
    cascade,
    cascadeUnmeasuredReason: cascade === null ? (zeroGoldReason ?? cascadeUnmeasuredReason) : null,
    notes: flagValues("--note", argv),
  });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(document, null, 2));
  console.log(`written: ${outPath}`);
}
