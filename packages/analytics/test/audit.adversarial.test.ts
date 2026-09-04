/**
 * Audit harness (execution pass 2, shared-packages-ops). New file only; no
 * production code changed. `it.fails` cases pin REPRODUCED defects — they
 * pass while the defect exists and start failing once it is fixed.
 */
import { describe, expect, it } from "vitest";
import {
  BufferedAnalytics,
  COST_COMPONENTS,
  DEFAULT_RATE_CARD,
  DRIFT_THRESHOLDS,
  DriftMonitor,
  RollingDistribution,
  ZERO_USAGE,
  addUsage,
  computeCost,
  computePsi,
  findPrivacyViolations,
  numericBinLabel,
  scaleUsage,
  suggestOptimizations,
  type AnalyticsEvent,
  type RateCard,
} from "../src/index.js";

const AT = "2026-09-04T00:00:00.000Z";
const goodEvent = (i: number): AnalyticsEvent => ({
  name: "queue_backlog",
  at: AT,
  platform: "service",
  queue: "media",
  depth: i,
});

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("audit: BufferedAnalytics delivery accounting", () => {
  it.fails(
    "FINDING: with a persistently failing transport, re-buffer truncation drops events with no counter",
    async () => {
      const attempts: number[] = [];
      const sink = new BufferedAnalytics(async (batch) => {
        attempts.push(batch.length);
        throw new Error("transport down");
      }, 50);
      for (let i = 0; i < 50; i++) sink.track(goodEvent(i)); // auto-flush → fails → re-buffer 50
      await Promise.resolve();
      sink.track(goodEvent(50)); // 51 ≥ 50 → flush(51) fails → re-buffer slice(-50)
      await Promise.resolve();
      const delivered = 0;
      const tracked = 51;
      // Every tracked event must be either pending, delivered, or counted as dropped.
      expect(sink.pendingCount() + delivered + sink.droppedViolationCount()).toBe(tracked);
    },
  );

  it("evidence: 51 tracked, 0 delivered, 50 pending, droppedViolationCount 0 → 1 event silently lost", async () => {
    const sink = new BufferedAnalytics(async () => {
      throw new Error("transport down");
    }, 50);
    for (let i = 0; i < 51; i++) {
      sink.track(goodEvent(i));
      await Promise.resolve();
    }
    expect(sink.pendingCount()).toBe(50);
    expect(sink.droppedViolationCount()).toBe(0);
  });

  it("holds: failed flush preserves order and prepends the retried batch before newer events", async () => {
    let fail = true;
    const sent: number[] = [];
    const sink = new BufferedAnalytics(async (batch) => {
      if (fail) throw new Error("down");
      for (const e of batch) sent.push((e as { depth: number }).depth);
    }, 1000);
    for (let i = 0; i < 10; i++) sink.track(goodEvent(i));
    await sink.flush();
    expect(sink.pendingCount()).toBe(10);
    sink.track(goodEvent(10));
    fail = false;
    await sink.flush();
    expect(sent).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(sink.pendingCount()).toBe(0);
  });

  it("holds: violating events are never buffered, are counted, and reported via onViolation", async () => {
    const reported: string[] = [];
    let sent = 0;
    const sink = new BufferedAnalytics(
      async (b) => {
        sent += b.length;
      },
      10,
      (name) => reported.push(name),
    );
    sink.track({ name: "goal_selected", at: AT, goal: "file:///var/mobile/x.mov" });
    sink.track({ name: "goal_selected", at: AT, goal: "a".repeat(201) });
    sink.track({ name: "goal_selected", at: AT, goal: "coach@example.com" });
    sink.track({ name: "goal_selected", at: AT, goal: "A".repeat(120) });
    await sink.flush();
    expect(sent).toBe(0);
    expect(sink.droppedViolationCount()).toBe(4);
    expect(reported).toHaveLength(4);
  });
});

describe("audit: privacy guard coverage", () => {
  it.fails(
    "FINDING: near-miss field names (phoneNumber, localPath, userEmail) bypass forbidden_key",
    () => {
      const ev = {
        name: "goal_selected",
        at: AT,
        goal: "x",
        phoneNumber: "+15550100000",
        localPath: "Documents/clip-2026-09-04.mov",
        userEmail: "coach at example dot com",
      } as unknown as AnalyticsEvent;
      expect(findPrivacyViolations(ev).length).toBeGreaterThan(0);
    },
  );

  it("evidence: the same payload with canonical keys IS caught", () => {
    const ev = {
      name: "goal_selected",
      at: AT,
      goal: "x",
      phone: "+15550100000",
      path: "Documents/clip-2026-09-04.mov",
      email: "coach at example dot com",
    } as unknown as AnalyticsEvent;
    expect(findPrivacyViolations(ev).map((v) => v.rule)).toEqual([
      "forbidden_key",
      "forbidden_key",
      "forbidden_key",
    ]);
  });

  it("holds: scheme/path/email/base64/oversized rules fire on nested arrays and objects", () => {
    const ev = {
      name: "goal_selected",
      at: AT,
      goal: "x",
      nested: [{ deep: "content://media/external/1" }, "/Users/me/x", "ab@cd.io"],
      big: Array.from({ length: 33 }, () => "ok"),
    } as unknown as AnalyticsEvent;
    const rules = findPrivacyViolations(ev).map((v) => `${v.path}:${v.rule}`);
    expect(rules).toEqual(
      expect.arrayContaining([
        "nested[0].deep:uri_scheme",
        "nested[1]:filesystem_path",
        "nested[2]:email_address",
        "big:oversized_array",
      ]),
    );
  });

  it("holds: null / undefined / numbers / booleans never trip the guard", () => {
    const ev = {
      name: "goal_selected",
      at: AT,
      goal: "x",
      a: null,
      b: undefined,
      c: 1e308,
      d: false,
    } as unknown as AnalyticsEvent;
    expect(findPrivacyViolations(ev)).toEqual([]);
  });
});

describe("audit: drift", () => {
  it("holds: PSI is 0 for identical, symmetric-ish, finite with disjoint bins, 0 when either side empty", () => {
    expect(computePsi({ a: 10, b: 10 }, { a: 10, b: 10 })).toBe(0);
    const psi = computePsi({ a: 100 }, { b: 100 });
    expect(Number.isFinite(psi)).toBe(true);
    expect(psi).toBeGreaterThan(DRIFT_THRESHOLDS.psiDrift);
    expect(computePsi({}, { a: 1 })).toBe(0);
    expect(computePsi({ a: 1 }, {})).toBe(0);
  });

  it("observed: smoothing=0 with a disjoint bin yields non-finite PSI (default smoothing guards it)", () => {
    expect(Number.isFinite(computePsi({ a: 100 }, { b: 100 }, 0))).toBe(false);
  });

  it("fuzz: RollingDistribution counts always sum to min(n, max) and match a brute-force tail", () => {
    const rand = lcg(7);
    for (let run = 0; run < 100; run++) {
      const max = 1 + Math.floor(rand() * 30);
      const rd = new RollingDistribution("device_model", max);
      const all: string[] = [];
      const n = Math.floor(rand() * 100);
      for (let i = 0; i < n; i++) {
        const label = `L${Math.floor(rand() * 5)}`;
        rd.addCategory(label);
        all.push(label);
      }
      const tail = all.slice(-max);
      const expected: Record<string, number> = {};
      for (const l of tail) expected[l] = (expected[l] ?? 0) + 1;
      const snap = rd.snapshot();
      expect(snap.totalSamples).toBe(tail.length);
      expect(snap.counts).toEqual(expected);
    }
  });

  it("holds: numeric bin labels are total (−Inf..+Inf edges) and monotonic", () => {
    const labels = [-1e9, 0, 14.999, 15, 29.9, 30, 59, 60, 1e9].map((v) =>
      numericBinLabel("fps", v),
    );
    expect(new Set(labels).size).toBeGreaterThan(1);
    expect(labels[0]!.startsWith("<")).toBe(true);
    expect(labels.at(-1)!.startsWith(">=")).toBe(true);
  });

  it("holds: not-evaluable below minSamples on either side; NaN/Infinity/non-string observations ignored", () => {
    const mon = new DriftMonitor(1000);
    expect(mon.test("fps")).toMatchObject({ reason: "insufficient_reference_samples" });
    for (let i = 0; i < DRIFT_THRESHOLDS.minSamples; i++) mon.record({ fps: 30, latencyMs: NaN });
    mon.record({ fps: Infinity, deviceModel: 42 as unknown as string });
    expect(mon.snapshot("fps").totalSamples).toBe(DRIFT_THRESHOLDS.minSamples);
    expect(mon.snapshot("latency_ms").totalSamples).toBe(0);
    expect(mon.snapshot("device_model").totalSamples).toBe(0);
    mon.freezeReference();
    expect(mon.test("fps")).toMatchObject({ severity: "stable", psi: 0 });
    expect(mon.test("latency_ms")).toMatchObject({ reason: "insufficient_reference_samples" });
    const alerts = mon.alerts(AT);
    expect(alerts.every((a) => a.name === "drift_window_not_evaluable")).toBe(true);
    expect(alerts.some((a) => a.metric === "fps")).toBe(false);
  });

  it("holds: a fully shifted window after freeze is reported as drift", () => {
    const mon = new DriftMonitor(200);
    for (let i = 0; i < 200; i++) mon.record({ fps: 60 });
    mon.freezeReference();
    for (let i = 0; i < 200; i++) mon.record({ fps: 12 });
    expect(mon.test("fps")).toMatchObject({ severity: "drift" });
    expect(mon.alerts(AT).find((a) => a.metric === "fps")?.name).toBe("drift_detected");
  });
});

describe("audit: cost model", () => {
  it.fails(
    "FINDING: computeCost validates quantities but not the rate card — NaN/negative rates yield '$NaN'/negative totals silently",
    () => {
      const badCard: RateCard = {
        ...DEFAULT_RATE_CARD,
        server_gpu: { ...DEFAULT_RATE_CARD.server_gpu, usdPerUnit: NaN },
      };
      expect(() => computeCost({ ...ZERO_USAGE, server_gpu: 1 }, badCard)).toThrow();
    },
  );

  it("evidence: NaN rate → totalUsdFormatted '$NaN'; negative rate → negative total", () => {
    const nanCard: RateCard = {
      ...DEFAULT_RATE_CARD,
      server_gpu: { ...DEFAULT_RATE_CARD.server_gpu, usdPerUnit: NaN },
    };
    expect(computeCost({ ...ZERO_USAGE, server_gpu: 1 }, nanCard).totalUsdFormatted).toBe("$NaN");
    const negCard: RateCard = {
      ...DEFAULT_RATE_CARD,
      server_gpu: { ...DEFAULT_RATE_CARD.server_gpu, usdPerUnit: -1 },
    };
    expect(computeCost({ ...ZERO_USAGE, server_gpu: 1 }, negCard).totalMicroUsd).toBeLessThan(0);
  });

  it("holds: negative / NaN / Infinity quantities throw; zero usage is $0.000000", () => {
    for (const bad of [-1, NaN, Infinity]) {
      expect(() => computeCost({ ...ZERO_USAGE, storage: bad }, DEFAULT_RATE_CARD)).toThrow(
        /invalid_quantity/,
      );
    }
    const zero = computeCost(ZERO_USAGE, DEFAULT_RATE_CARD);
    expect(zero.totalMicroUsd).toBe(0);
    expect(zero.totalUsdFormatted).toBe("$0.000000");
    expect(suggestOptimizations(zero)).toEqual([]);
  });

  it("holds: addUsage/scaleUsage are linear; scale rejects negative/non-finite; suggestions ordered by cost share", () => {
    const u = { ...ZERO_USAGE, server_gpu: 2, storage: 10, bandwidth: 5 };
    expect(addUsage(u, u)).toEqual(scaleUsage(u, 2));
    expect(addUsage()).toEqual(ZERO_USAGE);
    for (const f of [-1, NaN, Infinity])
      expect(() => scaleUsage(u, f)).toThrow(/invalid_scale_factor/);
    const breakdown = computeCost(u, DEFAULT_RATE_CARD);
    const suggestions = suggestOptimizations(breakdown);
    const cost = new Map(breakdown.components.map((c) => [c.component, c.microUsd]));
    for (let i = 1; i < suggestions.length; i++) {
      expect(cost.get(suggestions[i - 1]!.targetComponent)!).toBeGreaterThanOrEqual(
        cost.get(suggestions[i]!.targetComponent)!,
      );
    }
    for (const s of suggestions) expect(cost.get(s.targetComponent)!).toBeGreaterThan(0);
    expect(COST_COMPONENTS.length).toBe(breakdown.components.length);
  });

  it("holds: micro-USD components are integers and the total is their exact sum", () => {
    const rand = lcg(3);
    for (let run = 0; run < 200; run++) {
      const usage = { ...ZERO_USAGE } as Record<(typeof COST_COMPONENTS)[number], number>;
      for (const c of COST_COMPONENTS) usage[c] = rand() * 1e6;
      const b = computeCost(usage, DEFAULT_RATE_CARD);
      for (const c of b.components) expect(Number.isInteger(c.microUsd)).toBe(true);
      expect(b.totalMicroUsd).toBe(b.components.reduce((s, c) => s + c.microUsd, 0));
    }
  });
});
