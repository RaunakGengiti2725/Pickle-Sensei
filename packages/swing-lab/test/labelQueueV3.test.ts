import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HELD_OUT_BUNDLES } from "../src/labelQueueV2.js";
import {
  SIGNAL_WEIGHTS,
  collectAuditDisagreements,
  collectCascadeFailures,
  collectFailureMine,
  collectMinerUncertainty,
  collectOodBoundary,
  mergeItems,
  type QueueItemV3,
} from "../src/labelQueueV3.js";

function fixtureRoot(): string {
  const root = join(tmpdir(), `label-queue-v3-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function writeAudit(
  root: string,
  bundleId: string,
  frames: Array<{
    tMs: number;
    frameIdx: number;
    role: string;
    adjudicationId: string | null;
    centerDelta: number | null;
    classAgreement: boolean;
  }>,
): void {
  const dir = join(root, bundleId, "annotation");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "devin-visual-v4-waveD2-ownership-audit.json"),
    JSON.stringify({ captureBundle: bundleId, frames }),
  );
}

describe("collectAuditDisagreements", () => {
  it("selects only disagreeing/outlier/adjudicated slots and skips held-out bundles", () => {
    const root = fixtureRoot();
    writeAudit(root, "afn-sasebo-rally2", [
      {
        tMs: 100,
        frameIdx: 3,
        role: "a",
        adjudicationId: null,
        centerDelta: 0.01,
        classAgreement: true,
      },
      {
        tMs: 200,
        frameIdx: 6,
        role: "b",
        adjudicationId: null,
        centerDelta: 0.09,
        classAgreement: true,
      },
      {
        tMs: 300,
        frameIdx: 9,
        role: "c",
        adjudicationId: "ADJ-1",
        centerDelta: null,
        classAgreement: false,
      },
    ]);
    writeAudit(root, "wm-dink-01", [
      {
        tMs: 1,
        frameIdx: 0,
        role: "x",
        adjudicationId: "ADJ-2",
        centerDelta: 0.5,
        classAgreement: false,
      },
    ]);
    const items = collectAuditDisagreements(root);
    expect(items.map((i) => i.tMs)).toEqual([200, 300]);
    expect(items.every((i) => i.kind === "frame" && i.modalities.includes("ownership"))).toBe(true);
    expect(items.every((i) => !HELD_OUT_BUNDLES.includes(i.bundleId as never))).toBe(true);
    expect(items[1]?.signals[0]?.provenance.value).toContain("class disagreement");
    expect(items[1]?.signals[0]?.provenance.value).toContain("ADJ-1");
  });
});

describe("collectCascadeFailures", () => {
  it("emits items only for failed stages on development cases from the LATEST run", () => {
    const dir = fixtureRoot();
    writeFileSync(
      join(dir, "cascade-100.json"),
      JSON.stringify({
        rows: [
          {
            caseId: "afn-sasebo-rally1",
            split: "development",
            stages: { EVENT: { pass: false, detail: "old run" } },
          },
        ],
      }),
    );
    writeFileSync(
      join(dir, "cascade-200.json"),
      JSON.stringify({
        rows: [
          {
            caseId: "afn-sasebo-rally1",
            split: "development",
            stages: {
              EVENT: { pass: false, detail: "overlap 0%" },
              BALL: { pass: true, detail: "tracked" },
            },
          },
          {
            caseId: "wm-dink-01",
            split: "held_out",
            stages: { CONTACT: { pass: false, detail: "error 250ms" } },
          },
        ],
      }),
    );
    const { items, runFile } = collectCascadeFailures(dir);
    expect(runFile).toBe("cascade-200.json");
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("cascade/afn-sasebo-rally1/event");
    expect(items[0]?.signals[0]?.provenance.value).toBe("overlap 0%");
  });
});

describe("collectMinerUncertainty", () => {
  it("keeps only dev/val events, ranks by uncertainty, and caps at topN", () => {
    const dir = fixtureRoot();
    const line = (eventId: string, split: string, uncertainty: number) =>
      `${JSON.stringify({
        eventId,
        recordingId: "rec-x",
        sessionKey: "s",
        split,
        startMs: 0,
        endMs: 100,
        uncertainty,
        reasons: ["crowded"],
      })}\n`;
    writeFileSync(
      join(dir, "rec-x.jsonl"),
      line("evt-a", "dev", 0.5) +
        line("evt-b", "locked_test", 1) +
        line("evt-c", "val", 0.9) +
        line("evt-d", "shadow", 1) +
        line("evt-e", "dev", 0.7),
    );
    const items = collectMinerUncertainty(dir, 2);
    expect(items.map((i) => i.id)).toEqual(["miner/evt-c", "miner/evt-e"]);
    expect(items[0]?.score).toBeCloseTo(SIGNAL_WEIGHTS.miner_uncertainty.weight * 0.9);
  });
});

describe("collectFailureMine", () => {
  it("keeps only dev/val tracking-degradation kinds", () => {
    const dir = fixtureRoot();
    const path = join(dir, "failure-queue.json");
    writeFileSync(
      path,
      JSON.stringify({
        items: [
          {
            recordingId: "rec-1",
            sessionKey: "s",
            split: "dev",
            sceneIndex: 0,
            windowMs: { start: 0, end: 10 },
            kind: "TRACK_FRAGMENTATION",
            severity: 1,
            evidence: "churn",
          },
          {
            recordingId: "rec-1",
            sessionKey: "s",
            split: "locked_test",
            sceneIndex: 1,
            windowMs: { start: 0, end: 10 },
            kind: "TRACK_FRAGMENTATION",
            severity: 1,
            evidence: "never queue locked_test",
          },
          {
            recordingId: "rec-1",
            sessionKey: "s",
            split: "dev",
            sceneIndex: 2,
            windowMs: { start: 0, end: 10 },
            kind: "NO_PEOPLE",
            severity: 1,
            evidence: "not a labeling target",
          },
        ],
      }),
    );
    const items = collectFailureMine(path, 10);
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toContain("scene0");
  });
});

describe("collectOodBoundary", () => {
  it("selects only gate-passing negatives", () => {
    const dir = fixtureRoot();
    const path = join(dir, "ood.json");
    writeFileSync(
      path,
      JSON.stringify({
        measurements: [
          {
            id: "n1",
            category: "tennis",
            path: "p1",
            gateOk: false,
            poseFreeDetectable: true,
            durationMs: 5,
          },
          {
            id: "n2",
            category: "tabletennis",
            path: "p2",
            gateOk: true,
            poseFreeDetectable: false,
            durationMs: 7,
          },
        ],
      }),
    );
    const items = collectOodBoundary(path);
    expect(items.map((i) => i.id)).toEqual(["ood-boundary/n2"]);
    expect(items[0]?.windowMs).toEqual({ start: 0, end: 7 });
  });
});

describe("mergeItems", () => {
  const base = (overrides: Partial<QueueItemV3>): QueueItemV3 => ({
    rank: 0,
    id: "x",
    kind: "window",
    sessionKey: "s",
    split: "dev",
    bundleId: "b",
    recordingId: null,
    modalities: ["ball"],
    tMs: null,
    frameIdx: null,
    windowMs: { start: 0, end: 10 },
    score: 0.5,
    signals: [
      {
        type: "hard_slice",
        weight: 0.5,
        provenance: { source: "s", metric: "m", value: "v" },
      },
    ],
    instruction: "i",
    rationale: "r",
    ...overrides,
  });

  it("merges same-window same-modality items, summing signal weights", () => {
    const merged = mergeItems([
      base({ id: "a" }),
      base({
        id: "b",
        score: 0.7,
        signals: [
          {
            type: "miner_uncertainty",
            weight: 0.7,
            provenance: { source: "s2", metric: "m2", value: "v2" },
          },
        ],
      }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.score).toBeCloseTo(1.2);
    expect(merged[0]?.signals).toHaveLength(2);
  });

  it("never merges distinct frame items (different role at same tMs)", () => {
    const merged = mergeItems([
      base({ id: "disagreement/b/t100/role-a", kind: "frame", tMs: 100, windowMs: null }),
      base({ id: "disagreement/b/t100/role-b", kind: "frame", tMs: 100, windowMs: null }),
    ]);
    expect(merged).toHaveLength(2);
  });
});

describe("committed queue artifact invariants", () => {
  it("the committed e23 queue is deterministic, held-out-safe, split-safe, and provenance-complete", async () => {
    const { buildQueueV3 } = await import("../src/labelQueueV3.js");
    const { REPO_ROOT } = await import("../src/engine/corpus.js");
    const queueA = buildQueueV3(REPO_ROOT);
    const queueB = buildQueueV3(REPO_ROOT);
    expect(JSON.stringify(queueA)).toBe(JSON.stringify(queueB));
    const serialized = JSON.stringify(queueA.items);
    for (const heldOut of HELD_OUT_BUNDLES) expect(serialized).not.toContain(heldOut);
    const perSession = new Map<string, number>();
    for (const item of queueA.items) {
      expect(["dev", "val"]).toContain(item.split);
      expect(item.signals.length).toBeGreaterThan(0);
      for (const signal of item.signals) {
        expect(signal.provenance.source.length).toBeGreaterThan(0);
        expect(String(signal.provenance.value).length).toBeGreaterThan(0);
      }
      expect(item.score).toBeCloseTo(
        item.signals.reduce((sum, s) => sum + s.weight, 0),
        10,
      );
      perSession.set(item.sessionKey, (perSession.get(item.sessionKey) ?? 0) + 1);
    }
    for (const [, used] of perSession) expect(used).toBeLessThanOrEqual(queueA.perSessionCap);
    expect(queueA.items.map((i) => i.rank)).toEqual(queueA.items.map((_, idx) => idx + 1));
  });
});
