import { describe, expect, it } from "vitest";
import {
  BufferedAnalytics,
  DEFAULT_RATE_CARD,
  DriftMonitor,
  ZERO_USAGE,
  computeCost,
  computePsi,
  findPrivacyViolations,
  type AnalyticsEvent,
} from "../src/index.js";

/**
 * Minimized, deterministic reproductions of every gap the seeded randomized
 * campaign (stress.randomized-seeded.test.ts, STRESS_ITER=2000, base seed
 * 20260904) found in @pickle/analytics. Each is written as the behaviour the
 * public contract PROMISES and declared with `it.fails`, so:
 *
 *   - the suite is green while the gap exists (the pin documents it), and
 *   - the moment a fix lands, the pin fails loudly and must be flipped to a
 *     plain `it` (turning the repro into a regression test).
 *
 * Nothing here fabricates data: payloads are the ddmin-minimized ops from the
 * campaign's JSON tables (seed noted per case).
 */

const at = "2026-09-04T00:00:00.000Z";

describe("known gaps pinned by the randomized-seeded campaign", () => {
  describe("computePsi / DriftMonitor (invariant D-PSI-FINITE)", () => {
    // seed 2333041761 → 1 op
    it.fails(
      "computePsi is finite when a bin label names an Object.prototype member on one side only",
      () => {
        const psi = computePsi({ forehand_drive: 550, serve: 1894 }, { toString: 1430 });
        expect(Number.isFinite(psi)).toBe(true);
      },
    );

    // seed 3474544633 → 1 op
    it.fails("computePsi is finite for a reference-only 'constructor' bin", () => {
      const psi = computePsi(
        { "🥒": 2467, constructor: 825, "": 4048 },
        { forehand_drive: 2503, backhand_drive: 3437, third_shot_drop: 1147 },
      );
      expect(Number.isFinite(psi)).toBe(true);
    });

    // Monitor-level consequence: NaN psi is bucketed as "stable" and no alert fires.
    it.fails(
      "DriftMonitor reports drift (not 'stable' with psi NaN) when a novel label is an Object.prototype name",
      () => {
        const monitor = new DriftMonitor();
        for (let i = 0; i < 120; i++)
          monitor.record({ deviceModel: i % 2 ? "iPhone15,2" : "iPhone16,1" });
        monitor.freezeReference();
        for (let i = 0; i < 120; i++)
          monitor.record({ deviceModel: i % 3 === 0 ? "toString" : "iPhone15,2" });
        const result = monitor.test("device_model");
        expect("psi" in result && Number.isFinite(result.psi)).toBe(true);
        expect(monitor.alerts(at).some((a) => a.metric === "device_model")).toBe(true);
      },
    );
  });

  describe("findPrivacyViolations (invariant R-GUARD-PROBE)", () => {
    // seed 3474544633: `data:` URIs never have `:/` after the scheme, so URI_SCHEME cannot match them.
    it.fails("flags a data: URI carrying an inline image payload", () => {
      const event = {
        name: "onboarding_completed",
        at,
        skillLevel:
          "data:image/png;base64,XI3Toe1TDgmWqt5QPTc5t5ksT3SCpwi4WD1aWtkpyuSGoEbgwYn3m5C2/2t0snp00/TSApPHYaD/OtIPwOo1g",
        handedness: "right",
      } satisfies AnalyticsEvent;
      expect(findPrivacyViolations(event).map((v) => v.rule)).toContain("uri_scheme");
    });

    // seed 3474544633: `blob:` URLs are `blob:<origin>/<uuid>` — same missing-slash problem.
    it.fails("flags a blob: URL", () => {
      const event = {
        name: "app_opened",
        at,
        deviceClass: "blob:https://app.local/zavuz5aut66s-4f1e-8a3c",
      } satisfies AnalyticsEvent;
      expect(findPrivacyViolations(event).map((v) => v.rule)).toContain("uri_scheme");
    });

    // seed 3189168915: BASE64_BLOB only knows the standard alphabet; base64url (`-`/`_`) slips through.
    it.fails("flags a 160-char base64url payload as a blob", () => {
      const blob =
        "KrlLz_LUABlQ2HK-pYJGj-hC4-7MMrDc6d8mjn8gn-nwOLvFHOpwlpZGBSsO1B6LoWno-688oaymyaqCU32PXLIUuEI2itKJBvLDsgec8vDdQ32m5s7MAh4DtsLKn3cmspB8YTJR0ZgGc41";
      const event = { name: "app_opened", at, appBuild: blob } satisfies AnalyticsEvent;
      expect(findPrivacyViolations(event).map((v) => v.rule)).toContain("base64_blob");
    });

    // seed 2806279370: FILESYSTEM_PATH only anchors after start / whitespace / = " ' (.
    it.fails("flags a /private/ path that follows a comma", () => {
      const event = {
        name: "app_opened",
        at,
        platform: "error,/private/mtkgeni/clip.mov",
      } as unknown as AnalyticsEvent;
      expect(findPrivacyViolations(event).map((v) => v.rule)).toContain("filesystem_path");
    });

    // seed 2806279370: FORBIDDEN_KEY is an exact-match list, so compound identifier keys pass.
    it.fails("flags identifier-bearing compound keys such as phoneNumber / fileUrl", () => {
      const event = {
        name: "app_opened",
        at,
        phoneNumber: "k-ticur",
        fileUrl: "k-x",
      } as unknown as AnalyticsEvent;
      const paths = findPrivacyViolations(event).map((v) => v.path);
      expect(paths).toEqual(expect.arrayContaining(["phoneNumber", "fileUrl"]));
    });
  });

  describe("BufferedAnalytics (invariant R-SINK-NO-SILENT-LOSS)", () => {
    // seed 3474544633 → 4 ops: sink(maxBuffer=1), track, track, flush with a failing transport.
    it.fails(
      "a failing transport never loses a clean event without a counter recording the drop",
      async () => {
        const sink = new BufferedAnalytics(async () => {
          throw new Error("offline");
        }, 1);
        sink.track({ name: "app_opened", at, sessionId: "e1" });
        await Promise.resolve(); // auto-flush of [e1] fails → re-buffered
        sink.track({ name: "app_opened", at, sessionId: "e2" }); // buffer [e1,e2] ≥ maxBuffer → flush fails
        await sink.flush();
        // Contract (class doc): "failures are not silently dropped either".
        expect(sink.pendingCount() + sink.droppedViolationCount()).toBe(2);
      },
    );
  });

  describe("computeCost (invariant C-FINITE)", () => {
    // seed 3954948005 → 1 op. The doc promises integer micro-USD and refuses
    // non-finite INPUT, but a finite quantity can still yield a non-finite OUTPUT.
    it.fails("returns finite integer micro-USD for a finite quantity", () => {
      const cost = computeCost(
        { ...ZERO_USAGE, coach_review: Number.MAX_VALUE },
        DEFAULT_RATE_CARD,
      );
      expect(Number.isFinite(cost.totalMicroUsd)).toBe(true);
      expect(cost.totalUsdFormatted).not.toContain("Infinity");
    });
  });
});
