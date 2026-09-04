import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SELECTABLE_TECHNIQUES_V1 } from "@pickle/shared-types";
import {
  buildGoldCoverageAudit,
  loadGoldCorpus,
  parseReporterOutputs,
  PRODUCT_STROKE_CLASSES,
  renderCoverageTable,
  resolveGoldEvent,
  ROLE_STROKE_CLASSES,
  type CountWithProvenance,
  type GoldCoverageAudit,
} from "../src/goldCoverageAudit.js";
import type { StrokeGoldLabel } from "../src/strokeTaxonomyBench.js";

/**
 * Structural invariants of the gold-coverage audit (cv-gold-coverage-gaps).
 *
 * The audit is a read-only inventory of committed labels. These tests pin
 * that it (a) never invents a category, (b) carries provenance for every
 * count, (c) keeps unknown/ambiguous taxonomy labels unknown/ambiguous
 * instead of resolving them to a product class, and (d) reports every
 * product claim with a status. Corpus-size numbers are recomputed here from
 * the raw files rather than hard-coded so the test stays valid when labels
 * are added.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const corpus = loadGoldCorpus(root);
const audit = buildGoldCoverageAudit(corpus, {
  now: new Date("2026-01-01T00:00:00.000Z"),
  gitSha: "test",
});

function label(partial: Partial<StrokeGoldLabel>): StrokeGoldLabel {
  return {
    caseId: "synthetic",
    eventStartMs: 0,
    contactMs: null,
    eventEndMs: 100,
    owner: "target",
    l1: "unknown",
    l2: "unknown",
    l3: "unknown",
    reasoning: "synthetic",
    annotatorId: "test",
    createdAtIso: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

/** Every CountWithProvenance either lists one provenance entry per counted
 *  item, or its provenance refs carry explicit `×N` multiplicities that sum
 *  to the count. Absent counts must be 0 and still say where we looked. */
function provenanceExplains(entry: CountWithProvenance): boolean {
  if (entry.evidenceClass === "absent") {
    return entry.count === 0 && entry.provenance.length > 0;
  }
  if (entry.count === entry.provenance.length) return true;
  const multiplied = entry.provenance.reduce((sum, item) => {
    const match = /×(\d+)/.exec(item.ref);
    return sum + (match ? Number(match[1]) : 1);
  }, 0);
  if (multiplied === entry.count) return true;
  // clip-level counts list one provenance per clip with "(N pass(es))"
  const clips = new Set(entry.provenance.map((item) => item.ref.split(" ")[0]));
  return clips.size === entry.count;
}

function collectCounts(
  value: unknown,
  path: string,
  out: Array<[string, CountWithProvenance]>,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectCounts(item, `${path}[${index}]`, out));
    return;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("count" in record && "provenance" in record && "evidenceClass" in record) {
      out.push([path, record as unknown as CountWithProvenance]);
    }
    for (const [key, child] of Object.entries(record)) collectCounts(child, `${path}.${key}`, out);
  }
}

describe("goldCoverageAudit — corpus load", () => {
  it("classifies every committed annotation file (no unknown shapes)", () => {
    expect(audit.unknownShapeFiles).toEqual([]);
    const total = Object.values(audit.annotationFilesByShape).reduce((a, b) => a + b, 0);
    expect(total).toBe(corpus.annotationFiles.length);
  });

  it("records a sha256 for every input file it read", () => {
    expect(audit.inputs.length).toBeGreaterThan(10);
    for (const input of audit.inputs) {
      expect(input.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(input.bytes).toBeGreaterThan(0);
      expect(input.path.startsWith("datasets/")).toBe(true);
    }
    expect(
      audit.inputs.some((input) => input.path === "datasets/paddle-bench/stroke-gold.json"),
    ).toBe(true);
  });

  it("reads stroke-gold.json through the canonical validator (same count as the raw file)", () => {
    const raw = JSON.parse(
      readFileSync(join(root, "datasets/paddle-bench/stroke-gold.json"), "utf8"),
    ) as { labels: unknown[] };
    expect(audit.strokeGold.labels).toBe(raw.labels.length);
    expect(audit.strokeGold.target + audit.strokeGold.other).toBe(raw.labels.length);
  });
});

describe("goldCoverageAudit — no fabricated categories", () => {
  it("stroke-class rows are exactly SELECTABLE_TECHNIQUES_V1, in order", () => {
    expect(audit.strokeClasses.map((row) => row.productClass)).toEqual(
      SELECTABLE_TECHNIQUES_V1.map((technique) => technique.canonical),
    );
    expect(PRODUCT_STROKE_CLASSES).toHaveLength(12);
  });

  it("role rows are exactly the seven role classes", () => {
    expect(audit.roleClasses.map((row) => row.roleClass)).toEqual([...ROLE_STROKE_CLASSES]);
  });

  it("camera-angle rows only carry values that exist in registry.json or an explicit unregistered marker", () => {
    const registryAngles = new Set(
      corpus.registry.map((video) => video.cameraAngle ?? "unspecified"),
    );
    for (const row of audit.cameraAngle.rows) {
      expect(row.evidenceClass).toBe("registry_metadata");
      const known = registryAngles.has(row.cameraAngle);
      const unregistered = row.cameraAngle.startsWith("unregistered_source:");
      expect(known || unregistered).toBe(true);
      if (unregistered) expect(row.registryVideos).toEqual([]);
    }
  });

  it("lighting is never reported as a gold label", () => {
    expect(audit.lighting.structuredField).toBeNull();
    expect(audit.lighting.evidenceClass).toBe("free_text_keyword");
    expect(audit.lighting.lowLightOrNightLabels).toBe(0);
    for (const row of audit.lighting.rows) {
      expect(row.evidenceClass).toBe("free_text_keyword");
      expect(row.matchedText.length).toBeGreaterThanOrEqual(row.registryVideos.length);
    }
  });

  it("l1/l2/l3 histograms only contain values present in the gold file", () => {
    const gold = corpus.strokeGold.labels;
    expect(Object.keys(audit.strokeGold.l1).sort()).toEqual(
      [...new Set(gold.map((g) => g.l1))].sort(),
    );
    expect(Object.keys(audit.strokeGold.l2).sort()).toEqual(
      [...new Set(gold.map((g) => g.l2))].sort(),
    );
    expect(Object.keys(audit.strokeGold.l3).sort()).toEqual(
      [...new Set(gold.map((g) => g.l3))].sort(),
    );
  });
});

describe("goldCoverageAudit — every count carries provenance", () => {
  const counts: Array<[string, CountWithProvenance]> = [];
  collectCounts(audit, "$", counts);

  it("finds the provenance-bearing counts", () => {
    expect(counts.length).toBeGreaterThan(40);
  });

  it("the provenance check itself rejects unexplained counts", () => {
    expect(
      provenanceExplains({
        count: 3,
        evidenceClass: "gold_label",
        provenance: [{ path: "p", ref: "x" }],
      }),
    ).toBe(false);
    expect(
      provenanceExplains({
        count: 3,
        evidenceClass: "gold_label",
        provenance: [{ path: "p", ref: "frames×2" }],
      }),
    ).toBe(false);
    expect(
      provenanceExplains({
        count: 1,
        evidenceClass: "absent",
        provenance: [{ path: "p", ref: "x" }],
      }),
    ).toBe(false);
    expect(provenanceExplains({ count: 0, evidenceClass: "absent", provenance: [] })).toBe(false);
    expect(
      provenanceExplains({
        count: 3,
        evidenceClass: "gold_label",
        provenance: [{ path: "p", ref: "frames×3" }],
      }),
    ).toBe(true);
  });

  for (const [path, entry] of counts) {
    it(`${path} (${entry.evidenceClass}) count=${entry.count} is explained by its provenance`, () => {
      expect(provenanceExplains(entry)).toBe(true);
      for (const item of entry.provenance) {
        expect(item.path.length).toBeGreaterThan(0);
        expect(item.ref.length).toBeGreaterThan(0);
      }
    });
  }

  it("exact + ambiguous + unresolvable partitions the gold events", () => {
    const { exact, ambiguous, unresolvable } = audit.strokeGold.resolution;
    expect(exact + ambiguous + unresolvable).toBe(audit.strokeGold.labels);
    const exactFromRows = audit.strokeClasses.reduce(
      (sum, row) => sum + row.goldEventsExact.count,
      0,
    );
    expect(exactFromRows).toBe(exact);
    for (const row of audit.strokeClasses) {
      expect(row.goldEventsExactTarget + row.goldEventsExactOther).toBe(row.goldEventsExact.count);
      const basis = row.goldEventsExactByBasis;
      expect(basis.l3 + basis.l1_l2 + basis.l1_only).toBe(row.goldEventsExact.count);
      expect(row.exactEventsWithCommittedPose).toBeLessThanOrEqual(row.goldEventsExact.count);
    }
  });

  it("paddle/ball frame totals match an independent sum over the raw canonical files", () => {
    const bundlesDir = join(root, "datasets/paddle-bench/bundles");
    let paddle = 0;
    let ball = 0;
    let otherPaddle = 0;
    for (const bundle of readdirSync(bundlesDir)) {
      const dir = join(bundlesDir, bundle, "annotation");
      for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
        const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
          modality?: string;
          kind?: string;
          paddleFrames?: unknown[];
          ballFrames?: unknown[];
          otherPaddleFrames?: unknown[];
        };
        if (parsed.modality || parsed.kind) continue;
        paddle += parsed.paddleFrames?.length ?? 0;
        ball += parsed.ballFrames?.length ?? 0;
        otherPaddle += parsed.otherPaddleFrames?.length ?? 0;
      }
    }
    const pv = audit.partialVisibility;
    expect(
      pv.targetPaddleFrames.visible + pv.targetPaddleFrames.occluded + pv.targetPaddleFrames.absent,
    ).toBe(paddle);
    expect(
      pv.ballFrames.visible +
        pv.ballFrames.occluded +
        pv.ballFrames.not_visible +
        pv.ballFrames.uncertain,
    ).toBe(ball);
    expect(audit.multiPlayer.otherPaddleFrames.filesSummed.count).toBe(otherPaddle);
    expect(audit.multiPlayer.otherPaddleFrames.distinctBundleTimestamps).toBeLessThanOrEqual(
      otherPaddle,
    );
    expect(audit.multiPlayer.otherPaddleFrames.bothPaddlesVisibleWithin20ms).toBeLessThanOrEqual(
      otherPaddle,
    );
  });
});

describe("resolveGoldEvent — unknown stays unknown, ambiguity stays ambiguous", () => {
  it("l1 unknown resolves to nothing", () => {
    const resolution = resolveGoldEvent(label({ l1: "unknown", l2: "unknown", l3: "unknown" }));
    expect(resolution).toEqual({ exact: null, candidates: [], basis: "unknown" });
  });

  it("family without side is ambiguous between its forehand/backhand leaves", () => {
    const dink = resolveGoldEvent(label({ l1: "dink", l2: "unknown", l3: "unknown" }));
    expect(dink.exact).toBeNull();
    expect(dink.candidates).toEqual(["FOREHAND_DINK", "BACKHAND_DINK"]);
    const volley = resolveGoldEvent(label({ l1: "volley", l2: "unknown", l3: "unknown" }));
    expect(volley.exact).toBeNull();
    expect(volley.candidates).toEqual(["FOREHAND_VOLLEY", "BACKHAND_VOLLEY"]);
  });

  it("family + side with unknown leaf resolves via l1_l2, and says so", () => {
    const resolution = resolveGoldEvent(
      label({ l1: "groundstroke", l2: "backhand", l3: "unknown" }),
    );
    expect(resolution).toEqual({
      exact: "BACKHAND_DRIVE",
      candidates: ["BACKHAND_DRIVE"],
      basis: "l1_l2",
    });
  });

  it("a committed l3 leaf resolves via l3", () => {
    const serve = resolveGoldEvent(
      label({ l1: "serve", l2: "forehand", l3: "drop_serve_forehand" }),
    );
    expect(serve.exact).toBe("SERVE");
    expect(serve.basis).toBe("l3");
    const smash = resolveGoldEvent(
      label({ l1: "overhead_lob", l2: "overhead", l3: "overhead_smash" }),
    );
    expect(smash.exact).toBe("OVERHEAD");
    expect(smash.basis).toBe("l3");
  });

  it("never resolves to a class outside SELECTABLE_TECHNIQUES_V1", () => {
    for (const gold of corpus.strokeGold.labels) {
      const resolution = resolveGoldEvent(gold);
      for (const candidate of resolution.candidates) {
        expect(PRODUCT_STROKE_CLASSES).toContain(candidate);
      }
      if (resolution.exact) expect(resolution.candidates).toEqual([resolution.exact]);
      if (gold.l1 === "unknown") expect(resolution.candidates).toEqual([]);
      if (gold.l3 === "unknown") expect(resolution.basis).not.toBe("l3");
    }
  });

  it("classes with no gold of any kind are NO_GOLD and never SUPPORTED", () => {
    for (const row of audit.strokeClasses) {
      const anyGold =
        row.goldEventsExact.count + row.bundleLevelClips.count + row.declaredObservations.count > 0;
      expect(row.status === "NO_GOLD").toBe(!anyGold);
      if (row.status === "NO_GOLD") {
        const claim = audit.claims.find(
          (item) => item.claimId === `stroke-class:${row.productClass}`,
        );
        expect(claim?.status).toBe("UNVERIFIED");
      }
    }
  });
});

describe("goldCoverageAudit — product claims", () => {
  it("emits one stroke-class claim per product class plus the dossier claims", () => {
    for (const leaf of PRODUCT_STROKE_CLASSES) {
      expect(audit.claims.filter((claim) => claim.claimId === `stroke-class:${leaf}`)).toHaveLength(
        1,
      );
    }
    for (const claimId of [
      "strokes-covered",
      "capture-side-on-waist-height",
      "wherever-you-stand",
      "stops-the-clip-on-its-own",
      "technique-score-out-of-10",
      "form-review-key-phases",
      "measured-faults",
      "abstains-when-not-enough-seen",
      "import-video",
      "on-device-pose",
      "left-handed-players",
      "low-light",
    ]) {
      expect(audit.claims.some((claim) => claim.claimId === claimId)).toBe(true);
    }
  });

  it("every claim cites the dossier or code, has a status, and UNVERIFIED matches the list", () => {
    for (const claim of audit.claims) {
      expect(["SUPPORTED", "PARTIAL", "UNVERIFIED"]).toContain(claim.status);
      expect(claim.source.path.length).toBeGreaterThan(0);
      expect(claim.requiredGold.length).toBeGreaterThan(0);
      expect(claim.reason.length).toBeGreaterThan(0);
    }
    expect(audit.unverifiedClaims).toEqual(
      audit.claims.filter((claim) => claim.status === "UNVERIFIED").map((claim) => claim.claimId),
    );
  });

  it("claims that have zero committed gold are UNVERIFIED (never SUPPORTED)", () => {
    const zeroGold = (id: string, count: number) => {
      const claim = audit.claims.find((item) => item.claimId === id);
      expect(claim).toBeDefined();
      if (count === 0) expect(claim?.status).toBe("UNVERIFIED");
    };
    zeroGold(
      "technique-score-out-of-10",
      audit.otherGold.overallScoreLabels.count + audit.otherGold.coachReviews.count,
    );
    zeroGold(
      "measured-faults",
      audit.otherGold.faultLabels.count + audit.otherGold.coachReviews.count,
    );
    zeroGold("left-handed-players", audit.handedness.clipsLeft.length);
    zeroGold("low-light", audit.lighting.lowLightOrNightLabels);
    zeroGold("import-video", audit.otherGold.firstPartyPhoneCaptures.count);
    const onDevice = audit.claims.find((item) => item.claimId === "on-device-pose");
    expect(onDevice?.status).toBe("UNVERIFIED");
  });

  it("reports Linux read-only evidence plane and never an Apple result", () => {
    expect(audit.evidencePlane).toBe("linux_read_only_label_inventory");
    expect(audit.caveats.some((caveat) => /Apple Vision/.test(caveat))).toBe(true);
    expect(audit.otherGold.poseKeypointGold.count).toBe(0);
  });
});

describe("goldCoverageAudit — cross-checks", () => {
  it("are NO-DATA (agrees=null) when no reporter output is supplied", () => {
    const reporterChecks = audit.crossChecks.filter((check) => check.reporter.endsWith(".ts"));
    expect(reporterChecks.length).toBeGreaterThan(5);
    for (const check of reporterChecks) {
      expect(check.reporterValue).toBeNull();
      expect(check.agrees).toBeNull();
    }
    const release = audit.crossChecks.find((check) => check.reporter.includes("manifest.json"));
    expect(release?.agrees).not.toBeNull();
  });

  it("parse the existing reporters' stdout formats", () => {
    const facts = parseReporterOutputs({
      datasetReport: [
        "PADDLE labels: 102 frames (visible 85, occluded 17, absent 0)",
        "BALL labels  : 103 frames (visible 86, not_visible 5, occluded 6, uncertain 6)",
        "EVENT labels: 5 (3 target strokes + 2 other-player swings; from eventLabels)",
        "TARGET-PLAYER labels: x; explicit other-player paddle labels: 0 (gap)",
        "STROKE labels (v3): 11 [A, B]",
        "STROKE COVERAGE (v3 labels present):",
        "  present: BACKHAND_VOLLEY, OVERHEAD",
        "  MISSING: BACKHAND_DRIVE, RETURN",
      ].join("\n"),
      dataGaps: [
        "STROKE CLASSES:",
        "·   FOREHAND_DRIVE: 4 labeled",
        "✗   BACKHAND_DRIVE: 0 labeled",
        "·   right-handed: 35 clips",
        "·   dual-paddle labeled frames (wrong-player measurement): 81 frames (need 20+)",
        "  3. serves + returns (0 labeled) from any legal source",
      ].join("\n"),
      strokeTaxonomyBench: "labels: 29 across 11 cases",
    });
    expect(facts.datasetReport).toEqual({
      paddleFrames: 102,
      paddleVisible: 85,
      paddleOccluded: 17,
      ballFrames: 103,
      eventLabels: 5,
      otherPlayerPaddleLabels: 0,
      strokeLabelsV3: 11,
      presentV3: ["BACKHAND_VOLLEY", "OVERHEAD"],
      missingV3: ["BACKHAND_DRIVE", "RETURN"],
    });
    expect(facts.dataGaps.perClassLabeled).toEqual({ FOREHAND_DRIVE: 4, BACKHAND_DRIVE: 0 });
    expect(facts.dataGaps.rightHandedClips).toBe(35);
    expect(facts.dataGaps.dualPaddleFrames).toBe(81);
    expect(facts.dataGaps.priorityLines).toEqual([
      "serves + returns (0 labeled) from any legal source",
    ]);
    expect(facts.strokeTaxonomyBench).toEqual({ labels: 29, cases: 11 });
  });

  it("agree with the audit's own numbers when fed matching reporter output", () => {
    const withReporters = buildGoldCoverageAudit(corpus, {
      now: new Date("2026-01-01T00:00:00.000Z"),
      gitSha: "test",
      reporterOutputs: {
        strokeTaxonomyBench: `labels: ${audit.strokeGold.labels} across ${audit.strokeGold.cases.length} cases`,
      },
    });
    const check = withReporters.crossChecks.find(
      (item) => item.reporter === "strokeTaxonomyBench.ts",
    );
    expect(check?.agrees).toBe(true);
  });
});

describe("goldCoverageAudit — rendering", () => {
  it("renders every product class, role class, and claim into the text table", () => {
    const table = renderCoverageTable(audit);
    for (const leaf of PRODUCT_STROKE_CLASSES) expect(table).toContain(leaf);
    for (const role of ROLE_STROKE_CLASSES) expect(table).toContain(`  ${role}`);
    for (const claim of audit.claims) expect(table).toContain(claim.claimId);
    expect(table).toContain("UNVERIFIED (");
  });

  it("is deterministic for a fixed clock", () => {
    const again: GoldCoverageAudit = buildGoldCoverageAudit(corpus, {
      now: new Date("2026-01-01T00:00:00.000Z"),
      gitSha: "test",
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(audit));
  });
});
