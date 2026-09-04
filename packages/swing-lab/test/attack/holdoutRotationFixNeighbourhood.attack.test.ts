import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../src/engine/corpus.js";
import {
  HOLDOUT_ROTATION_POLICY_VERSION,
  evaluateCertificationReadiness,
  loadHoldoutLedger,
  scanCommittedArtifactExposure,
  type HoldoutEntry,
  type HoldoutLedger,
  type SuccessorDesignation,
} from "../../src/holdoutRotation.js";
import { ledgerExclusionViolations } from "../../src/paddleBench.js";

/**
 * ADVERSARIAL — neighbourhood of the ADJ-02/ADJ-03 fix (34d56977).
 *
 * The fix promises (holdoutRotation.ts, evaluateCertificationReadiness doc):
 *   4. every designated successor is label-blind with zero inspections, and
 *      no committed datasets/ artifact names it (a self-declared zero is
 *      cross-checked against the tree the ledger came from),
 * and paddleBench.ts promises that the CLI refuses a manifest that scores a
 * zero-budget successor. Every test below builds a ledger/tree variant that
 * the fix accepts as ELIGIBLE (or scores) although the promise is violated.
 * They are EXPECTED TO FAIL on 34d56977; each failure is a concrete
 * fail-open in the changed code.
 */

const tmpRoots: string[] = [];
afterAll(() => {
  for (const root of tmpRoots) {
    try {
      chmodSync(join(root, "datasets", "experiments"), 0o755);
    } catch {
      /* not every root has that dir */
    }
    rmSync(root, { recursive: true, force: true });
  }
});

const SUCCESSOR_ID = "fresh-y";
const RETIRED_ID = "old-x";
const REGISTRY_REF = "datasets/pickleball/registry.json#freshCandidates";

function successor(overrides: Partial<SuccessorDesignation> = {}): SuccessorDesignation {
  return {
    caseId: SUCCESSOR_ID,
    tier: "SHADOW_HOLDOUT",
    designatedAtIso: "2026-09-01T00:00:00Z",
    designationRule: "newest",
    registryRef: REGISTRY_REF,
    labelBlind: true,
    inspectionCount: 0,
    pendingExternal: "",
    ...overrides,
  };
}

function activeHoldout(caseId: string, tier: HoldoutEntry["tier"]): HoldoutEntry {
  return {
    caseId,
    tier,
    status: "ACTIVE",
    firstHeldOutAtIso: "2026-09-01T00:00:00Z",
    inspections: [],
    retirement: null,
    notes: "",
  };
}

function ledgerWithRetiredAndSuccessor(
  successorOverrides: Partial<SuccessorDesignation> = {},
): HoldoutLedger {
  return {
    schemaVersion: 1,
    policyVersion: HOLDOUT_ROTATION_POLICY_VERSION,
    generatedAtIso: "2026-09-01T00:00:00Z",
    holdouts: [
      {
        caseId: RETIRED_ID,
        tier: "LOCKED_TEST",
        status: "RETIRED_TO_REGRESSION",
        firstHeldOutAtIso: "2026-09-01T00:00:00Z",
        inspections: [],
        retirement: {
          dateIso: "2026-09-02T00:00:00Z",
          workstream: "attack",
          reason: "contaminated",
          regressionRole: "fixture",
          successorId: SUCCESSOR_ID,
        },
        notes: "",
      },
    ],
    successors: [successor(successorOverrides)],
  };
}

/** A repo root whose datasets/ tree holds one artifact naming the successor. */
function repoWithExposure(relArtifact = "datasets/experiments/wave-z/summary.json"): string {
  const root = mkdtempSync(join(tmpdir(), "attack-fix-34d56977-"));
  tmpRoots.push(root);
  mkdirSync(join(root, "datasets", "holdouts"), { recursive: true });
  const artifact = join(root, relArtifact);
  mkdirSync(join(artifact, ".."), { recursive: true });
  writeFileSync(
    artifact,
    JSON.stringify({ cases: [{ id: SUCCESSOR_ID, labels: 12, note: "inspected by hand" }] }),
  );
  return root;
}

function writeLedger(root: string, ledger: object): void {
  writeFileSync(join(root, "datasets", "holdouts", "ledger.json"), JSON.stringify(ledger));
}

describe("CONTROL: fixtures are well-formed", () => {
  it("clean ledger + clean tree → ELIGIBLE; same ledger + exposing artifact → BLOCKED", () => {
    const clean = mkdtempSync(join(tmpdir(), "attack-fix-34d56977-clean-"));
    tmpRoots.push(clean);
    mkdirSync(join(clean, "datasets", "holdouts"), { recursive: true });
    const eligible = evaluateCertificationReadiness(ledgerWithRetiredAndSuccessor(), {
      repoRoot: clean,
    });
    expect(eligible.status, JSON.stringify(eligible, null, 2)).toBe("ELIGIBLE");
    const blocked = evaluateCertificationReadiness(ledgerWithRetiredAndSuccessor(), {
      repoRoot: repoWithExposure(),
    });
    expect(blocked.status, JSON.stringify(blocked, null, 2)).toBe("BLOCKED");
  });
});

describe("ATTACK A: artifact cross-check fails OPEN when the tree cannot be scanned", () => {
  it("nonexistent repoRoot → NOT_EVALUABLE (the cross-check did not run), not ELIGIBLE", () => {
    const readiness = evaluateCertificationReadiness(ledgerWithRetiredAndSuccessor(), {
      repoRoot: "/nonexistent/attack-fix-34d56977",
    });
    expect(readiness.status, JSON.stringify(readiness, null, 2)).not.toBe("ELIGIBLE");
  });

  it("repoRoot without a datasets/ directory → not ELIGIBLE", () => {
    const root = mkdtempSync(join(tmpdir(), "attack-fix-34d56977-nodatasets-"));
    tmpRoots.push(root);
    const readiness = evaluateCertificationReadiness(ledgerWithRetiredAndSuccessor(), {
      repoRoot: root,
    });
    expect(readiness.status, JSON.stringify(readiness, null, 2)).not.toBe("ELIGIBLE");
  });

  it.skipIf(process.getuid?.() === 0)(
    "EACCES on datasets/experiments hides the exposing artifact → ELIGIBLE (must be BLOCKED or NOT_EVALUABLE)",
    () => {
      const root = repoWithExposure();
      writeLedger(root, ledgerWithRetiredAndSuccessor());
      chmodSync(join(root, "datasets", "experiments"), 0o000);
      const readiness = evaluateCertificationReadiness(ledgerWithRetiredAndSuccessor(), {
        repoRoot: root,
      });
      expect(readiness.status, JSON.stringify(readiness, null, 2)).not.toBe("ELIGIBLE");
    },
  );

  it("a `sourceRepoRoot` field inside the ledger JSON itself redirects the scan (untrusted data picks the tree)", () => {
    const root = repoWithExposure();
    const raw = JSON.parse(
      JSON.stringify({
        ...ledgerWithRetiredAndSuccessor(),
        sourceRepoRoot: "/nonexistent/attack-fix-34d56977",
      }),
    ) as unknown;
    // Same ledger evaluated against the real tree is BLOCKED …
    expect(
      evaluateCertificationReadiness(raw, { repoRoot: root }).status,
      "control: exposure in the tree must block",
    ).toBe("BLOCKED");
    // … but the ledger's own `sourceRepoRoot` key is honoured when options
    // omit repoRoot, so committed data chooses which tree to cross-check.
    const spoofed = evaluateCertificationReadiness(raw);
    expect(spoofed.artifactScan.repoRoot, JSON.stringify(spoofed, null, 2)).not.toBe(
      "/nonexistent/attack-fix-34d56977",
    );
    expect(spoofed.status).not.toBe("ELIGIBLE");
  });
});

describe("ATTACK B: the ledger's own registryRef exempts arbitrary paths from the scan", () => {
  it("registryRef naming a DIRECTORY exempts the whole subtree → exposure hidden", () => {
    const root = repoWithExposure();
    const ledger = ledgerWithRetiredAndSuccessor({
      registryRef: "datasets/experiments#fresh-y",
    });
    const rawScan = scanCommittedArtifactExposure(root, [SUCCESSOR_ID]);
    expect(rawScan.get(SUCCESSOR_ID), "control: raw scan sees the artifact").toEqual([
      "datasets/experiments/wave-z/summary.json",
    ]);
    const readiness = evaluateCertificationReadiness(ledger, { repoRoot: root });
    expect(readiness.status, JSON.stringify(readiness, null, 2)).toBe("BLOCKED");
  });

  it("registryRef naming the exposing artifact itself exempts it → ELIGIBLE", () => {
    const root = repoWithExposure();
    const ledger = ledgerWithRetiredAndSuccessor({
      registryRef: "datasets/experiments/wave-z/summary.json#fresh-y",
    });
    const readiness = evaluateCertificationReadiness(ledger, { repoRoot: root });
    // The exempted path is not the ledger's registry: it does not exist as a
    // registry, and it is not under datasets/holdouts/. A designation must not
    // be able to whitelist its own inspection evidence.
    expect(readiness.status, JSON.stringify(readiness, null, 2)).toBe("BLOCKED");
  });
});

describe("ATTACK C: scan boundaries silently skipped instead of reported", () => {
  it("text artifact > 64 MiB naming the successor is skipped → ELIGIBLE", () => {
    const root = mkdtempSync(join(tmpdir(), "attack-fix-34d56977-big-"));
    tmpRoots.push(root);
    const dir = join(root, "datasets", "experiments", "wave-big");
    mkdirSync(dir, { recursive: true });
    const big = join(dir, "measurements.json");
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    writeFileSync(big, `{"caseId":"${SUCCESSOR_ID}","pad":"`);
    const fd = openSync(big, "a");
    for (let i = 0; i < 65; i += 1) writeSync(fd, chunk);
    writeSync(fd, '"}');
    closeSync(fd);
    const readiness = evaluateCertificationReadiness(ledgerWithRetiredAndSuccessor(), {
      repoRoot: root,
    });
    expect(readiness.status, JSON.stringify(readiness, null, 2)).not.toBe("ELIGIBLE");
  });

  it("committed symlink whose NAME is the successor id is skipped → ELIGIBLE", () => {
    const root = mkdtempSync(join(tmpdir(), "attack-fix-34d56977-symlink-"));
    tmpRoots.push(root);
    const dir = join(root, "datasets", "experiments", "wave-link");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "labels.json"), '{"paddleFrames":[]}');
    symlinkSync(join(dir, "labels.json"), join(dir, `${SUCCESSOR_ID}-labels.json`));
    const readiness = evaluateCertificationReadiness(ledgerWithRetiredAndSuccessor(), {
      repoRoot: root,
    });
    expect(readiness.status, JSON.stringify(readiness, null, 2)).not.toBe("ELIGIBLE");
  });
});

describe("ATTACK D: zero-budget ACTIVE holdouts are never cross-checked", () => {
  it("ACTIVE SHADOW_HOLDOUT entry with inspections [] and a committed annotation pack → ELIGIBLE", () => {
    // The lifecycle the fix itself describes: after the front-door freeze the
    // successor becomes an ACTIVE SHADOW_HOLDOUT holdout entry. At that exact
    // moment the artifact cross-check (successors only) stops protecting it.
    const root = repoWithExposure("datasets/experiments/wave-h/h16-annotation-pack.json");
    const ledger: HoldoutLedger = {
      schemaVersion: 1,
      policyVersion: HOLDOUT_ROTATION_POLICY_VERSION,
      generatedAtIso: "2026-09-01T00:00:00Z",
      holdouts: [activeHoldout(SUCCESSOR_ID, "SHADOW_HOLDOUT")],
      successors: [],
    };
    const readiness = evaluateCertificationReadiness(ledger, { repoRoot: root });
    expect(readiness.status, JSON.stringify(readiness, null, 2)).toBe("BLOCKED");
    expect(readiness.artifactScan.exposures.map((e) => e.caseId)).toContain(SUCCESSOR_ID);
  });
});

describe("ATTACK E: designated successors not claimed by a retired holdout are unvalidated", () => {
  const orphan = (overrides: Partial<SuccessorDesignation>): HoldoutLedger => ({
    schemaVersion: 1,
    policyVersion: HOLDOUT_ROTATION_POLICY_VERSION,
    generatedAtIso: "2026-09-01T00:00:00Z",
    holdouts: [activeHoldout("keep-1", "LOCKED_TEST")],
    successors: [successor(overrides)],
  });

  it("orphan successor with tier DEV → must be BLOCKED (rule 4 says every designated successor)", () => {
    const readiness = evaluateCertificationReadiness(orphan({ tier: "DEV" }));
    expect(readiness.status, JSON.stringify(readiness, null, 2)).toBe("BLOCKED");
  });

  it("orphan successor inspected 7×, not label-blind, pendingExternal set → must be BLOCKED", () => {
    const readiness = evaluateCertificationReadiness(
      orphan({ inspectionCount: 7, labelBlind: false, pendingExternal: "front-door freeze" }),
    );
    expect(readiness.status, JSON.stringify(readiness, null, 2)).toBe("BLOCKED");
  });
});

describe("ATTACK F: paddle-bench exclusion matches the manifest `id` only", () => {
  const real = loadHoldoutLedger();
  const designated = real.successors.find((entry) => entry.tier === "SHADOW_HOLDOUT");

  it("aliased case whose labels/runDir/video all name the successor is NOT a violation", () => {
    if (!designated) throw new Error("ledger has no SHADOW_HOLDOUT successor — cannot attack");
    const violations = ledgerExclusionViolations(
      {
        cases: [
          {
            id: "fresh-dev-42",
            video: `videos/${designated.caseId}.mp4`,
            labels: `bundles/${designated.caseId}/annotation/devin-visual-v1.json`,
            runDir: `runs/${designated.caseId}`,
          },
        ],
      },
      real,
    );
    expect(violations, "an aliased successor must still be refused").not.toEqual([]);
  });

  it("paddle-bench CLI scores the successor's artifacts under an alias id and exits 0", () => {
    if (!designated) throw new Error("ledger has no SHADOW_HOLDOUT successor — cannot attack");
    const tmp = mkdtempSync(join(tmpdir(), "attack-fix-34d56977-bench-"));
    tmpRoots.push(tmp);
    const devLabels = join(
      REPO_ROOT,
      "datasets",
      "paddle-bench",
      "bundles",
      "afn-sasebo-rally1",
      "annotation",
      "devin-visual-v1.json",
    );
    // Stand-in for the successor's (label-blind!) annotation and tracker run:
    // paths are named after the successor, only the manifest id is aliased.
    const bundle = join(tmp, "bundles", designated.caseId, "annotation");
    const runDir = join(tmp, "runs", designated.caseId);
    mkdirSync(bundle, { recursive: true });
    mkdirSync(runDir, { recursive: true });
    const labels = JSON.parse(readFileSync(devLabels, "utf8")) as {
      paddleFrames: Array<{
        tMs: number;
        visibility: string;
        point: { x: number; y: number } | null;
      }>;
    };
    writeFileSync(join(bundle, "devin-visual-v1.json"), JSON.stringify(labels));
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
    const manifestPath = join(tmp, "paddle-bench.json");
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          provenance: "real footage (attack manifest, temp only)",
          cases: [
            {
              id: "fresh-dev-42",
              video: `videos/${designated.caseId}.mp4`,
              labels: `bundles/${designated.caseId}/annotation/devin-visual-v1.json`,
              runDir: `runs/${designated.caseId}`,
              sourceKey: "yt-fresh",
            },
          ],
        },
        null,
        2,
      ),
    );
    const tsx = join(REPO_ROOT, "packages", "swing-lab", "node_modules", ".bin", "tsx");
    const run = spawnSync(tsx, ["src/paddleBench.ts", manifestPath], {
      cwd: join(REPO_ROOT, "packages", "swing-lab"),
      encoding: "utf8",
      timeout: 120_000,
    });
    const combined = `${run.stdout}\n${run.stderr}`;
    writeFileSync(join(tmp, "paddle-bench-cli.log"), `${combined}\nexit=${String(run.status)}`);
    expect(
      /^fresh-dev-42: labeled \d+/m.test(run.stdout),
      `bench scored the successor's artifacts under alias fresh-dev-42:\n${combined}`,
    ).toBe(false);
    expect(run.status, `bench exit status (stdout+stderr):\n${combined}`).not.toBe(0);
  });
});
