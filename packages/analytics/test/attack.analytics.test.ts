import { describe, expect, it } from "vitest";
import {
  BufferedAnalytics,
  findPrivacyViolations,
  MAX_ANALYTICS_ARRAY_LENGTH,
  type AnalyticsEvent,
  type PrivacyViolation,
} from "../src/index.js";
import { computeCost, DEFAULT_RATE_CARD, scaleUsage, ZERO_USAGE } from "../src/costModel.js";
import { computePsi, DriftMonitor, DRIFT_THRESHOLDS, RollingDistribution } from "../src/drift.js";

/**
 * Adversarial pass (shared-packages-ops #2, pass 3) against @pickle/analytics:
 * the redaction guard, the buffered sink under transport failure and
 * interleaved flushes, the PSI drift monitor fed hostile category labels,
 * and the cost model at float extremes. HELD cases assert the safe behaviour;
 * FINDING cases pin what the code does today so the repro is executable and
 * the expected behaviour is stated in the name.
 */

const BASE = { at: "2026-09-04T00:00:00.000Z", sessionId: "s-1" };

function ev(extra: Record<string, unknown>): AnalyticsEvent {
  return { ...BASE, ...extra } as unknown as AnalyticsEvent;
}

function rules(violations: PrivacyViolation[]): string[] {
  return violations.map((v) => v.rule).sort();
}

describe("attack: redaction guard bypasses", () => {
  it("HELD: iOS/Android media paths, file/ph/content URIs, emails and 120+ base64 runs are all caught", () => {
    expect(
      rules(
        findPrivacyViolations(
          ev({ name: "share_created", label: "/private/var/mobile/Containers/Data/x.mov" }),
        ),
      ),
    ).toEqual(["filesystem_path"]);
    expect(
      rules(findPrivacyViolations(ev({ name: "share_created", label: "ph://ABC/L0" }))),
    ).toEqual(["uri_scheme"]);
    // Scheme match is case-insensitive; the path rule needs a leading
    // separator so `FILE:///tmp/x` is caught once, by the scheme rule.
    expect(
      rules(findPrivacyViolations(ev({ name: "share_created", label: "FILE:///tmp/x" }))),
    ).toEqual(["uri_scheme"]);
    expect(
      rules(findPrivacyViolations(ev({ name: "share_created", label: "someone@example.com" }))),
    ).toEqual(["email_address"]);
    expect(
      rules(findPrivacyViolations(ev({ name: "share_created", label: "A".repeat(120) }))),
    ).toEqual(["base64_blob"]);
  });

  it("FINDING (bypass): a raw byte payload in a typed array under a non-forbidden key passes every rule", () => {
    // Array.isArray(Uint8Array) is false and Object.entries yields numeric
    // keys, so a 1 MiB frame under `pixels` hits neither oversized_array nor
    // forbidden_key. JSON.stringify would ship it as {"0":..,"1":..}.
    const pixels = new Uint8Array(1 << 20);
    const event = ev({ name: "analysis_failed", failureKind: "x", pixels });
    expect(findPrivacyViolations(event)).toEqual([]);
    // Same payload as a plain array IS caught — the gap is typed arrays only.
    expect(
      rules(
        findPrivacyViolations(
          ev({
            name: "analysis_failed",
            failureKind: "x",
            pixels: Array.from({ length: 33 }, () => 0),
          }),
        ),
      ),
    ).toEqual(["oversized_array"]);
  });

  it("FINDING (bypass): Map/Set contents are invisible to the scanner (but also serialize to {} — no leak over JSON)", () => {
    const m = new Map([["path", "/var/mobile/leak.mov"]]);
    const event = ev({ name: "analysis_failed", failureKind: "x", meta: m });
    expect(findPrivacyViolations(event)).toEqual([]);
    expect(JSON.stringify(m)).toBe("{}");
  });

  it("FINDING (bypass): toJSON() lets a value the scanner never sees reach the wire", () => {
    const sneaky = { toJSON: () => "/var/mobile/Containers/leak.mov" };
    const event = ev({ name: "analysis_failed", failureKind: "x", meta: sneaky });
    expect(findPrivacyViolations(event)).toEqual([]);
    expect(JSON.stringify(event)).toContain("/var/mobile/Containers/leak.mov");
  });

  it("FINDING (bypass): a base64 blob split with one whitespace every 119 chars is not a 'blob'", () => {
    const chunk =
      "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODkrLw==".slice(
        0,
        119,
      );
    const label = `${chunk} ${chunk.slice(0, 60)}`;
    expect(label.length).toBeLessThanOrEqual(200);
    expect(findPrivacyViolations(ev({ name: "share_created", label }))).toEqual([]);
  });

  it("FINDING (bypass): forbidden-key list is exact-match — file_path / videoUri / imageURL / homeAddress pass by name", () => {
    // Values below are innocuous so only the key rule is under test.
    const event = ev({
      name: "analysis_failed",
      failureKind: "x",
      file_path: "x",
      videoUri: "x",
      imageURL: "x",
      homeAddress: "x",
      user_email: "x",
    });
    expect(findPrivacyViolations(event)).toEqual([]);
    // Canonical spellings ARE caught (case-insensitively).
    expect(
      rules(
        findPrivacyViolations(ev({ name: "analysis_failed", failureKind: "x", FILEPATH: "x" })),
      ),
    ).toEqual(["forbidden_key"]);
  });

  it("HELD: Windows/relative-looking paths and a bare bucket key are NOT flagged (documented scope), unicode homoglyph scheme is not a scheme", () => {
    expect(
      findPrivacyViolations(ev({ name: "share_created", label: "C:\\Users\\x\\clip.mov" })),
    ).toEqual([]);
    expect(findPrivacyViolations(ev({ name: "share_created", label: "fіle:///x" }))).toEqual([]); // Cyrillic і
  });

  it("HELD: a 33-element nested array at depth 3 and a 201-char string are both caught with exact paths", () => {
    const v = findPrivacyViolations(
      ev({
        name: "analysis_failed",
        failureKind: "x",
        a: {
          b: { c: Array.from({ length: MAX_ANALYTICS_ARRAY_LENGTH + 1 }, () => "x".repeat(201)) },
        },
      }),
    );
    expect(v[0]).toEqual({ path: "a.b.c", rule: "oversized_array" });
    expect(v.filter((x) => x.rule === "oversized_string")).toHaveLength(33);
    expect(v[1]?.path).toBe("a.b.c[0]");
  });
});

describe("attack: BufferedAnalytics under transport failure and interleaving", () => {
  const clean = (i: number): AnalyticsEvent => ev({ name: "app_opened", i });

  it("FINDING: with a permanently failing transport and continued traffic, the OLDEST events are dropped with no counter", async () => {
    let attempts = 0;
    const sink = new BufferedAnalytics(async () => {
      attempts++;
      throw new Error("offline");
    }, 10);
    for (let i = 0; i < 200; i++) sink.track(clean(i));
    await new Promise((r) => setTimeout(r, 0));
    await sink.flush().catch(() => undefined);
    expect(attempts).toBeGreaterThan(1);
    // Bounded (by design) …
    expect(sink.pendingCount()).toBeLessThanOrEqual(20);
    // … but 200 were accepted and there is no API reporting the ~180 lost:
    // droppedViolationCount() counts only privacy drops.
    expect(sink.droppedViolationCount()).toBe(0);
  });

  it("FINDING: two interleaved flushes that both fail re-buffer in reverse order (later batch first)", async () => {
    let calls = 0;
    const gates: Array<() => void> = [];
    const sink = new BufferedAnalytics(
      () =>
        new Promise<void>((_, reject) => {
          calls++;
          gates.push(() => reject(new Error("fail")));
        }),
      100,
    );
    sink.track(clean(1));
    sink.track(clean(2));
    const f1 = sink.flush();
    sink.track(clean(3));
    const f2 = sink.flush();
    expect(calls).toBe(2);
    gates[0]?.();
    await f1;
    gates[1]?.();
    await f2;
    const order = (sink as unknown as { buffer: Array<AnalyticsEvent & { i: number }> }).buffer.map(
      (e) => e.i,
    );
    // Event 3 now precedes 1 and 2 — ordering of the retried stream is lost.
    expect(order).toEqual([3, 1, 2]);
  });

  it("HELD: a transport that throws synchronously is still contained (no unhandled rejection from track)", async () => {
    const sink = new BufferedAnalytics(() => {
      throw new Error("sync boom");
    }, 1);
    expect(() => sink.track(clean(1))).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(sink.pendingCount()).toBe(1);
  });

  it("HELD: maxBuffer 0 flushes on every track and never grows unbounded on success", async () => {
    const seen: number[] = [];
    const sink = new BufferedAnalytics(async (b) => {
      seen.push(b.length);
    }, 0);
    for (let i = 0; i < 5; i++) sink.track(clean(i));
    await new Promise((r) => setTimeout(r, 0));
    expect(sink.pendingCount()).toBe(0);
    expect(seen).toEqual([1, 1, 1, 1, 1]);
  });

  it("HELD: 10k rapid tracks with a slow transport keep pendingCount bounded by maxBuffer after drain", async () => {
    const sink = new BufferedAnalytics(async () => {
      await new Promise((r) => setTimeout(r, 1));
    }, 50);
    for (let i = 0; i < 10_000; i++) sink.track(clean(i));
    await new Promise((r) => setTimeout(r, 20));
    await sink.flush();
    expect(sink.pendingCount()).toBe(0);
  });
});

describe("attack: drift monitor with hostile category labels", () => {
  it("FINDING: a category label that is an Object.prototype key ('constructor') poisons PSI to NaN → severity 'stable'", () => {
    // computePsi reads `reference[bin] ?? 0` on a plain object; for a bin
    // present only in `current`, reference['constructor'] is Object's
    // constructor function, (fn + smoothing) is a string, and the PSI is
    // NaN. NaN >= threshold is false, so the metric reads 'stable' — a
    // device reporting deviceModel="constructor" silently disables drift
    // detection for device_model.
    const reference: Record<string, number> = { iphone15: 100 };
    const current: Record<string, number> = { constructor: 100 };
    const psi = computePsi(reference, current);
    expect(Number.isNaN(psi)).toBe(true);

    const monitor = new DriftMonitor(1000);
    for (let i = 0; i < DRIFT_THRESHOLDS.minSamples; i++)
      monitor.record({ deviceModel: "iphone15" });
    monitor.freezeReference();
    for (let i = 0; i < DRIFT_THRESHOLDS.minSamples; i++)
      monitor.record({ deviceModel: "constructor" });
    // Window is fully replaced? Not necessarily — rolling 1000; but the
    // reference has no 'constructor' bin so the lookup hits the prototype.
    const result = monitor.test("device_model");
    expect("severity" in result && result.severity).toBe("stable");
    expect("psi" in result && Number.isNaN(result.psi)).toBe(true);
    // Contrast: the same total shift with an ordinary label is flagged as drift.
    const honest = new DriftMonitor(1000);
    for (let i = 0; i < DRIFT_THRESHOLDS.minSamples; i++)
      honest.record({ deviceModel: "iphone15" });
    honest.freezeReference();
    for (let i = 0; i < DRIFT_THRESHOLDS.minSamples; i++) honest.record({ deviceModel: "pixel9" });
    const honestResult = honest.test("device_model");
    expect("severity" in honestResult && honestResult.severity).toBe("drift");
  });

  it("FINDING: the same poisoning via 'toString' / 'hasOwnProperty' / 'valueOf' / '__proto__' labels", () => {
    // Object.fromEntries (used by RollingDistribution.snapshot) creates an
    // OWN '__proto__' key on the current side, but the lookup on the
    // reference side still walks to Object.prototype — every inherited name
    // poisons the PSI.
    for (const label of ["toString", "hasOwnProperty", "valueOf", "__proto__"]) {
      const psi = computePsi({ a: 50 }, Object.fromEntries([[label, 50]]));
      expect(Number.isNaN(psi), label).toBe(true);
    }
  });

  it("HELD: RollingDistribution evicts exactly to maxSamples and never reports a negative count", () => {
    const w = new RollingDistribution("device_model", 3);
    for (const l of ["a", "a", "b", "c", "c", "c"]) w.addCategory(l);
    expect(w.snapshot()).toEqual({ metric: "device_model", totalSamples: 3, counts: { c: 3 } });
  });

  it("FINDING: computePsi accepts negative counts and returns a negative/NaN PSI without throwing", () => {
    expect(Number.isNaN(computePsi({ a: 10, b: -5 }, { a: 10, b: 10 }))).toBe(true);
    // Totals that cancel to zero short-circuit to 'no drift' (0) instead of erroring.
    expect(computePsi({ a: 10, b: -10 }, { a: 10, b: 10 })).toBe(0);
  });

  it("HELD: NaN/Infinity numeric observations are ignored, -0 lands in the lowest bin", () => {
    const m = new DriftMonitor(10);
    m.record({ fps: Number.NaN });
    m.record({ fps: Number.POSITIVE_INFINITY });
    m.record({ fps: -0 });
    expect(m.snapshot("fps").totalSamples).toBe(1);
  });
});

describe("attack: cost model float extremes", () => {
  it("FINDING: a huge (finite) quantity yields Infinity micro-USD and totalUsdFormatted '$Infinity' — no overflow guard", () => {
    const breakdown = computeCost({ ...ZERO_USAGE, coach_review: 1e308 }, DEFAULT_RATE_CARD);
    expect(breakdown.totalMicroUsd).toBe(Number.POSITIVE_INFINITY);
    expect(breakdown.totalUsdFormatted).toBe("$Infinity");
  });

  it("HELD: NaN / negative / -Infinity quantities throw; -0 is accepted as zero", () => {
    expect(() => computeCost({ ...ZERO_USAGE, storage: Number.NaN }, DEFAULT_RATE_CARD)).toThrow(
      /invalid_quantity/,
    );
    expect(() => computeCost({ ...ZERO_USAGE, storage: -1e-300 }, DEFAULT_RATE_CARD)).toThrow();
    expect(computeCost({ ...ZERO_USAGE, storage: -0 }, DEFAULT_RATE_CARD).totalMicroUsd).toBe(0);
  });

  it("FINDING: a negative usdPerUnit on the rate card is not validated → negative cost", () => {
    const card = {
      ...DEFAULT_RATE_CARD,
      storage: { ...DEFAULT_RATE_CARD.storage, usdPerUnit: -1 },
    };
    expect(computeCost({ ...ZERO_USAGE, storage: 5 }, card).totalMicroUsd).toBeLessThan(0);
  });

  it("HELD: scaleUsage rejects NaN/negative/Infinity factors; factor 0 zeroes everything", () => {
    expect(() => scaleUsage(ZERO_USAGE, Number.NaN)).toThrow(/invalid_scale_factor/);
    expect(() => scaleUsage(ZERO_USAGE, Number.POSITIVE_INFINITY)).toThrow();
    expect(scaleUsage({ ...ZERO_USAGE, storage: 9 }, 0).storage).toBe(0);
  });
});
