import { execFileSync } from "node:child_process";
import { relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTACT_ESTIMATOR_VERSION,
  CONTACT_OWNERSHIP_POSTERIOR_VERSION,
} from "../../vision-geometry/src/index.js";
import {
  E02_COMMITTED_PATH,
  EVAL_OUT_DIR,
  G05_COMMITTED_PATH,
  REGENERATE_COMMAND,
  REPO_ROOT,
  buildE02Artifact,
  buildG05Artifact,
  e02UndisclosedWrongMarkers,
  g05Measure,
  readJsonArtifact,
  regressionGateViolations,
  type AcceptedRegression,
  type E02Artifact,
  type G05Artifact,
} from "../../vision-geometry/eval/contactGoldArtifacts.js";
import { replayAll } from "../../vision-geometry/eval/contactGoldReplay.js";

/**
 * The committed contact-gold artifacts (wave-e e02, wave-g g05) are review
 * evidence for the live contact estimator. This suite runs in `pnpm test`
 * (CI `verify` job) and fails when either artifact is stale: it rebuilds the
 * artifact from the current source and requires byte-equal content apart
 * from the run-specific provenance fields the committed file itself carries.
 */

const SHA40 = /^[0-9a-f]{40}$/;

function expectWellFormedAcceptances(accepted: readonly AcceptedRegression[]): void {
  for (const entry of accepted) {
    expect(entry.estimatorVersion).toMatch(/^contact-evidence-\d+\.\d+$/);
    expect(entry.rationale.trim().length).toBeGreaterThan(20);
    expect(entry.rows.length).toBeGreaterThan(0);
    expect(Object.keys(entry.ceiling).length).toBeGreaterThan(0);
  }
}

describe("committed contact-gold artifacts track the live estimator", () => {
  it("eval output directory is untracked (never datasets/)", () => {
    expect(relative(REPO_ROOT, EVAL_OUT_DIR).startsWith("artifacts/")).toBe(true);
    // git check-ignore exits 0 when the path is ignored.
    expect(() =>
      execFileSync("git", ["check-ignore", "-q", EVAL_OUT_DIR], { cwd: REPO_ROOT }),
    ).not.toThrow();
  });

  it("e02 artifact is regenerated for the live estimator and discloses every wrong marker", () => {
    const committed = readJsonArtifact<E02Artifact>(E02_COMMITTED_PATH);

    expect(committed.estimatorVersion).toBe(CONTACT_ESTIMATOR_VERSION);
    expect(committed.commit).toMatch(SHA40);
    expect(committed.regenerate).toBe(REGENERATE_COMMAND);
    expectWellFormedAcceptances(committed.acceptedRegressions ?? []);

    const fresh = buildE02Artifact(replayAll(), {
      acceptedRegressions: committed.acceptedRegressions ?? [],
      commit: committed.commit,
      evaluatedAtIso: committed.evaluatedAtIso,
    });
    expect(committed).toStrictEqual(fresh);

    expect(e02UndisclosedWrongMarkers(committed)).toEqual([]);
  });

  it("g05 artifact is regenerated for the live estimator + posterior", () => {
    const committed = readJsonArtifact<G05Artifact>(G05_COMMITTED_PATH);

    expect(committed.estimatorVersion).toBe(CONTACT_ESTIMATOR_VERSION);
    expect(committed.posteriorVersion).toBe(CONTACT_OWNERSHIP_POSTERIOR_VERSION);
    expect(committed.commit).toMatch(SHA40);
    expect(committed.regenerate).toBe(REGENERATE_COMMAND);
    expectWellFormedAcceptances(committed.acceptedRegressions ?? []);

    const fresh = buildG05Artifact(g05Measure(), {
      acceptedRegressions: committed.acceptedRegressions ?? [],
      commit: committed.commit,
      dateUtc: committed.dateUtc,
    });
    expect(committed).toStrictEqual(fresh);
  });
});

describe("regressionGateViolations", () => {
  const committed = { wrongMarkers: 0, medianErrorMs: 17 };

  it("fails a wrongMarkers or median regression even inside the absolute floor", () => {
    expect(
      regressionGateViolations(committed, { wrongMarkers: 1, medianErrorMs: 27 }, [], "v"),
    ).toEqual([
      { metric: "wrongMarkers", committed: 0, fresh: 1, allowed: 0 },
      { metric: "medianErrorMs", committed: 17, fresh: 27, allowed: 17 },
    ]);
  });

  it("passes equal or improved metrics", () => {
    expect(
      regressionGateViolations(committed, { wrongMarkers: 0, medianErrorMs: 12 }, [], "v"),
    ).toEqual([]);
  });

  it("honors an accepted ceiling only for the live estimator version", () => {
    const accepted: AcceptedRegression[] = [
      {
        estimatorVersion: "v",
        ceiling: { wrongMarkers: 1, medianErrorMs: 27 },
        rows: ["b@1 16ms → 144ms"],
        rationale: "reviewed: explanation of the accepted delta",
      },
    ];
    const fresh = { wrongMarkers: 1, medianErrorMs: 27 };
    expect(regressionGateViolations(committed, fresh, accepted, "v")).toEqual([]);
    expect(regressionGateViolations(committed, fresh, accepted, "v-next")).toHaveLength(2);
    expect(
      regressionGateViolations(committed, { wrongMarkers: 2, medianErrorMs: 27 }, accepted, "v"),
    ).toEqual([{ metric: "wrongMarkers", committed: 0, fresh: 2, allowed: 1 }]);
  });

  it("never compares an unmeasurable (null) side", () => {
    expect(
      regressionGateViolations(
        { wrongMarkers: 0, medianErrorMs: null },
        { wrongMarkers: 0, medianErrorMs: 500 },
        [],
        "v",
      ),
    ).toEqual([]);
  });
});
