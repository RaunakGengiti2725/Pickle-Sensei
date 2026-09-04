/**
 * Audit harness (execution pass 2, shared-packages-ops). New file only; no
 * production code changed. `it.fails` cases pin REPRODUCED defects — they
 * pass while the defect exists and start failing once it is fixed, at which
 * point they should be flipped to plain `it`.
 */
import { describe, expect, it } from "vitest";
import {
  computePlayerRank,
  deriveConsentStatus,
  validateEvaluationTrial,
  type ConsentRecord,
  type PlayerRankAnalysisInput,
} from "../src/index.js";

function rec(o: {
  id: string;
  action: "granted" | "withdrawn";
  at: string;
  seq?: number;
  scope?: ConsentRecord["scope"];
}): ConsentRecord {
  return {
    id: o.id,
    subjectPseudonym: "subject-A",
    scope: o.scope ?? "model_training",
    action: o.action,
    consentVersion: "model-training-v1",
    source: "in_app",
    device: null,
    captureMode: o.action === "granted" ? "all_captures" : null,
    strokeIntent: null,
    recordedAtIso: o.at,
    ...(o.seq !== undefined ? { seq: o.seq } : {}),
  };
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  items.forEach((x, i) => {
    for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) {
      out.push([x, ...rest]);
    }
  });
  return out;
}

function trainingActive(records: readonly ConsentRecord[]): boolean {
  return deriveConsentStatus(records).find((s) => s.scope === "model_training")?.active ?? false;
}

// Deterministic LCG so the fuzz corpus is reproducible across runs.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("audit: deriveConsentStatus ordering", () => {
  it.fails(
    "FINDING: same-millisecond grant + withdrawal without seq is input-order dependent",
    () => {
      const at = "2026-08-01T00:01:00.000Z";
      const granted = rec({ id: "g", action: "granted", at });
      const withdrawn = rec({ id: "w", action: "withdrawn", at });
      // Both orders describe the same ledger; the derived status must agree.
      expect(trainingActive([withdrawn, granted])).toBe(trainingActive([granted, withdrawn]));
    },
  );

  it.fails(
    "FINDING: mixing records with and without seq makes the comparator non-transitive",
    () => {
      const records = [
        rec({ id: "r0", action: "granted", at: "2026-01-02T00:00:00.000Z", seq: 3 }),
        rec({ id: "r1", action: "withdrawn", at: "2026-01-02T00:00:00.000Z" }),
        rec({ id: "r2", action: "granted", at: "2026-01-01T00:00:00.000Z", seq: 2 }),
      ];
      const outcomes = new Set(permutations(records).map(trainingActive));
      expect(outcomes.size).toBe(1);
    },
  );

  it("fuzz: with unique seq on every record the derivation is order-independent", () => {
    const rand = lcg(42);
    const times = ["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"];
    for (let n = 0; n < 300; n++) {
      const seqs = [1, 2, 3, 4].sort(() => rand() - 0.5);
      const records = seqs.map((seq, i) =>
        rec({
          id: `r${i}`,
          action: rand() < 0.5 ? "granted" : "withdrawn",
          at: times[Math.floor(rand() * times.length)]!,
          seq,
        }),
      );
      const outcomes = new Set(permutations(records).map(trainingActive));
      expect(outcomes.size).toBe(1);
    }
  });

  it("fuzz: with distinct timestamps and no seq the derivation is order-independent", () => {
    const rand = lcg(7);
    for (let n = 0; n < 300; n++) {
      const records = [0, 1, 2, 3].map((i) =>
        rec({
          id: `r${i}`,
          action: rand() < 0.5 ? "granted" : "withdrawn",
          at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        }),
      );
      const outcomes = new Set(permutations(records).map(trainingActive));
      expect(outcomes.size).toBe(1);
    }
  });

  it("empty ledger is NOT consented for every scope", () => {
    for (const s of deriveConsentStatus([])) {
      expect(s.active).toBe(false);
      expect(s.lastAction).toBeNull();
    }
  });
});

describe("audit: validateEvaluationTrial never throws on arbitrary JSON", () => {
  const junk: unknown[] = [
    null,
    undefined,
    0,
    -1,
    NaN,
    "",
    "string",
    [],
    [1, 2],
    {},
    { schemaVersion: "evaluation-trial-v1" },
    { schemaVersion: "evaluation-trial-v1", claims: null, dims: null, consent: null },
    { schemaVersion: "evaluation-trial-v1", claims: [], dims: [], consent: [] },
    { schemaVersion: "evaluation-trial-v1", claims: { targetLock: 5 }, dims: {}, consent: {} },
    {
      schemaVersion: "evaluation-trial-v1",
      claims: { targetLock: { status: "presented" }, eventSelection: { status: "abstained" } },
      limitingFactors: "nope",
      userFlags: [1],
      dims: { devicePlatform: "web" },
      consent: { scope: "model_training", consentVersion: "" },
    },
    Object.create(null),
    new Date(0),
  ];
  it("returns ok=false with at least one error for every junk input", () => {
    for (const value of junk) {
      const result = validateEvaluationTrial(value);
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.ok).toBe(result.errors.length === 0);
    }
  });
});

describe("audit: computePlayerRank order independence", () => {
  it("fuzz: shuffling the input never changes the summary", () => {
    const rand = lcg(99);
    const shots = ["forehand_drive", "backhand_dink", "serve", "volley"];
    for (let n = 0; n < 100; n++) {
      const count = 1 + Math.floor(rand() * 20);
      const inputs: PlayerRankAnalysisInput[] = [];
      for (let i = 0; i < count; i++) {
        inputs.push({
          shotType: shots[Math.floor(rand() * shots.length)]!,
          overallScore: rand() < 0.15 ? null : Math.round(rand() * 1000) / 100,
          resultKind: rand() < 0.15 ? "abstained" : "scored",
          capturedAt: new Date(Date.UTC(2026, 0, 1) + Math.floor(rand() * 5) * 1000).toISOString(),
          id: `id-${i}`,
          source: rand() < 0.1 ? "synthetic" : "real",
        });
      }
      const expected = JSON.stringify(computePlayerRank(inputs));
      for (let k = 0; k < 5; k++) {
        const shuffled = [...inputs].sort(() => rand() - 0.5);
        expect(JSON.stringify(computePlayerRank(shuffled))).toBe(expected);
      }
    }
  });

  it("returns null (unranked) for abstained-only or non-real history", () => {
    expect(
      computePlayerRank([
        {
          shotType: "serve",
          overallScore: null,
          resultKind: "abstained",
          capturedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          shotType: "serve",
          overallScore: 8,
          resultKind: "scored",
          capturedAt: "2026-01-01T00:00:00.000Z",
          source: "synthetic",
        },
      ]),
    ).toBeNull();
  });
});
