import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../src/engine/corpus.js";
import { evaluateCertificationReadiness, loadHoldoutLedger } from "../../src/holdoutRotation.js";

/**
 * ADVERSARIAL S1 — SHADOW_HOLDOUT successor leaks into a bench as "dev".
 *
 * The holdout ledger (datasets/holdouts/ledger.json) designates label-blind
 * SHADOW_HOLDOUT successors whose inspection budget is ZERO. Nothing may
 * score, label, or even open them until the front-door freeze. This attack
 * writes a TEMPORARY paddle-bench manifest (never the committed one) that
 * lists a designated successor as an ordinary development case, then asks
 * the ledger-driven exclusion machinery to refuse it:
 *
 *   (a) the bench CLI (`tsx src/paddleBench.ts <manifest>`) must refuse to
 *       score a case whose id is a designated successor;
 *   (b) some production module must consult `ledger.successors` — a guard
 *       that exists only in test files is not a guard on the lab scripts.
 *
 * The temp manifest points labels at an EXISTING committed dev annotation and
 * runDir at a temp debug.json so the successor case is fully "scorable" — if
 * the bench scores it, the successor has been consumed as a dev case.
 */

const tmp = mkdtempSync(join(tmpdir(), "attack-s1-holdout-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ledger = loadHoldoutLedger();
const successor = ledger.successors.find((entry) => entry.tier === "SHADOW_HOLDOUT");

interface BenchCase {
  id: string;
  video: string;
  labels: string;
  runDir: string;
  sourceKey?: string;
  sessionKey?: string;
  role: string;
}

function writeContaminatedManifest(): { manifestPath: string; successorId: string } {
  if (!successor) throw new Error("ledger has no SHADOW_HOLDOUT successor — cannot attack");
  const committed = JSON.parse(
    readFileSync(join(REPO_ROOT, "datasets", "paddle-bench", "paddle-bench.json"), "utf8"),
  ) as { schemaVersion: 1; provenance: string; coverageGaps?: string[]; cases: BenchCase[] };
  const devLabels = join(
    REPO_ROOT,
    "datasets",
    "paddle-bench",
    "bundles",
    "afn-sasebo-rally1",
    "annotation",
    "devin-visual-v1.json",
  );
  const runDir = join(tmp, "runs", successor.caseId);
  mkdirSync(runDir, { recursive: true });
  // A "real-looking" tracker artifact: one observation that will register as
  // a hit on the first labeled frame, so scoring produces non-null metrics.
  const labels = JSON.parse(readFileSync(devLabels, "utf8")) as {
    paddleFrames: Array<{
      tMs: number;
      visibility: string;
      point: { x: number; y: number } | null;
    }>;
  };
  const firstVisible = labels.paddleFrames.find((frame) => frame.visibility === "visible")!;
  writeFileSync(
    join(runDir, "debug.json"),
    JSON.stringify({
      paddle: {
        observations: [
          {
            t: firstVisible.tMs,
            x: firstVisible.point!.x - 0.02,
            y: firstVisible.point!.y - 0.02,
            w: 0.04,
            h: 0.04,
            conf: 0.9,
          },
        ],
      },
    }),
  );
  const contaminated = {
    ...committed,
    cases: [
      ...committed.cases.map((benchCase) => ({
        ...benchCase,
        // Keep the committed cases in the manifest but make them unscorable
        // in the temp dir (their run artifacts are not on this machine).
        labels: join(REPO_ROOT, "datasets", "paddle-bench", benchCase.labels),
        runDir: join(tmp, "runs", benchCase.id),
      })),
      {
        id: successor.caseId,
        video: `videos/${successor.caseId}.mp4`,
        labels: devLabels,
        runDir,
        sourceKey: "yt-fresh",
        sessionKey: "yt-fresh-2026",
        role: "dev",
      },
    ],
  };
  const manifestPath = join(tmp, "paddle-bench.json");
  writeFileSync(manifestPath, JSON.stringify(contaminated, null, 2));
  return { manifestPath, successorId: successor.caseId };
}

function tsSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsSourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("ADVERSARIAL S1: designated SHADOW_HOLDOUT successor listed as a dev bench case", () => {
  it("precondition: the ledger designates at least one zero-budget SHADOW_HOLDOUT successor", () => {
    expect(successor).toBeDefined();
    expect(successor!.inspectionCount).toBe(0);
    expect(successor!.labelBlind).toBe(true);
    // The committed manifest itself is clean (this attack never edits it).
    const committed = readFileSync(
      join(REPO_ROOT, "datasets", "paddle-bench", "paddle-bench.json"),
      "utf8",
    );
    expect(committed.includes(successor!.caseId)).toBe(false);
  });

  it("paddle-bench CLI refuses to score a manifest that lists a designated successor as 'dev'", () => {
    const { manifestPath, successorId } = writeContaminatedManifest();
    const tsx = join(REPO_ROOT, "packages", "swing-lab", "node_modules", ".bin", "tsx");
    const run = spawnSync(tsx, ["src/paddleBench.ts", manifestPath], {
      cwd: join(REPO_ROOT, "packages", "swing-lab"),
      encoding: "utf8",
      timeout: 120_000,
    });
    const combined = `${run.stdout}\n${run.stderr}`;
    writeFileSync(join(tmp, "paddle-bench-cli.log"), `${combined}\nexit=${String(run.status)}`);
    // Expected: a non-zero exit naming the successor as excluded/held-out,
    // and NO per-case score line for it.
    const scoredSuccessor = new RegExp(`^${successorId}: labeled \\d+`, "m").test(run.stdout);
    expect(
      scoredSuccessor,
      `bench scored the SHADOW_HOLDOUT successor ${successorId} as a dev case:\n${combined}`,
    ).toBe(false);
    expect(run.status, `bench exit status (stdout+stderr):\n${combined}`).not.toBe(0);
    expect(combined).toMatch(new RegExp(`${successorId}.*(successor|holdout|excluded|refus)`, "i"));
  });

  it("some production lab module consults ledger.successors (a test-only guard does not protect lab scripts)", () => {
    const srcRoot = join(REPO_ROOT, "packages", "swing-lab", "src");
    const consumers = tsSourceFiles(srcRoot).filter((file) => {
      if (file.endsWith(join("src", "holdoutRotation.ts"))) return false;
      if (file.endsWith(join("src", "index.ts"))) return false;
      const source = readFileSync(file, "utf8");
      return /\.successors\b|loadHoldoutLedger\(/.test(source);
    });
    expect(
      consumers,
      "no swing-lab source outside holdoutRotation.ts reads the ledger's successor designations",
    ).not.toEqual([]);
  });

  it("evaluateCertificationReadiness has no input for bench manifests, so a contaminated bench cannot flip it to BLOCKED-for-contamination", () => {
    // Documents the gap rather than the wish: the readiness verdict is a pure
    // function of the ledger. The contaminated bench manifest written above
    // is invisible to it. A ledger-driven exclusion would need to either take
    // the bench manifests as input or be invoked by the bench scripts.
    const readiness = evaluateCertificationReadiness(ledger);
    expect(readiness.reasons.join(" ")).not.toContain("paddle-bench");
    expect(evaluateCertificationReadiness.length).toBe(1);
  });
});
