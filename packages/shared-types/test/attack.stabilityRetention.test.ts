import { describe, expect, it } from "vitest";
import {
  MEDIA_RETENTION_POLICY_V1,
  aggregateStabilitySlo,
  evaluateStabilitySlo,
  guardRolloutAdvance,
  isRetentionExpired,
  retentionDeadline,
  stabilityRolloutDecision,
  type StabilitySloEvent,
  type StabilitySloWindowMetrics,
} from "../src/index.js";

/**
 * Adversarial pass (shared-packages-ops #2, pass 3) against the stability
 * SLO gate and the media-retention policy in @pickle/shared-types: NaN /
 * out-of-range rates, unknown event kinds, window-boundary crashes, NaN and
 * negative rollout percentages, and Date overflow / clock skew. HELD cases
 * assert the safe behaviour; FINDING cases pin what the code does today so
 * the repro is executable and the expected behaviour is stated in the name.
 */

const AT = "2026-09-04T00:00:00.000Z";

function ev(
  kind: StabilitySloEvent["kind"],
  userKey: string,
  sessionKey: string | null,
  extra: Record<string, unknown> = {},
): StabilitySloEvent {
  return { kind, userKey, sessionKey, at: AT, ...extra } as StabilitySloEvent;
}

function healthyMetrics(): StabilitySloWindowMetrics {
  const events: StabilitySloEvent[] = [];
  for (let i = 0; i < 100; i++) {
    events.push(ev("session_started", `u${i}`, `s${i}`));
    events.push(ev("analysis_started", `u${i}`, `s${i}`));
    events.push(ev("analysis_completed", `u${i}`, `s${i}`));
    events.push(ev("camera_startup_succeeded", `u${i}`, `s${i}`));
    events.push(ev("try_again_rearmed", `u${i}`, `s${i}`));
  }
  return aggregateStabilitySlo(events);
}

describe("attack: stability SLO evaluation with malformed rates", () => {
  it("HELD: NaN rates breach in BOTH directions (fail-closed), null rates are not_evaluable", () => {
    const m = healthyMetrics();
    const nan = evaluateStabilitySlo({
      ...m,
      crashFreeUsersRate: Number.NaN,
      cameraStartupFailureRate: Number.NaN,
    });
    expect(nan.results.find((r) => r.slo === "crash_free_users")?.verdict).toBe("breach");
    expect(nan.results.find((r) => r.slo === "camera_startup_failure")?.verdict).toBe("breach");
    expect(stabilityRolloutDecision(nan).action).toBe("pause");
    const nul = evaluateStabilitySlo({ ...m, crashFreeUsersRate: null });
    expect(stabilityRolloutDecision(nul).action).toBe("hold");
  });

  it("FINDING: impossible rates pass — crashFreeUsersRate=Infinity / 1.5 and cameraStartupFailureRate=-1 are 'pass', so a corrupt window can read green", () => {
    const m = healthyMetrics();
    const e = evaluateStabilitySlo({
      ...m,
      crashFreeUsersRate: Number.POSITIVE_INFINITY,
      crashFreeSessionsRate: 1.5,
      cameraStartupFailureRate: -1,
    });
    expect(e.results.map((r) => r.verdict)).toEqual(Array(7).fill("pass"));
    expect(stabilityRolloutDecision(e).action).toBe("proceed");
  });

  it("HELD: sampleSize exactly minSample evaluates; minSample-1 is not_evaluable; -0 sample → not_evaluable via null rate", () => {
    const m = healthyMetrics();
    const exact = evaluateStabilitySlo({ ...m, usersObserved: 20 });
    expect(exact.results.find((r) => r.slo === "crash_free_users")?.verdict).toBe("pass");
    const under = evaluateStabilitySlo({ ...m, usersObserved: 19 });
    expect(under.results.find((r) => r.slo === "crash_free_users")?.verdict).toBe("not_evaluable");
    const zero = aggregateStabilitySlo([]);
    expect(zero.crashFreeUsersRate).toBeNull();
    expect(stabilityRolloutDecision(evaluateStabilitySlo(zero)).action).toBe("hold");
  });
});

describe("attack: aggregateStabilitySlo with hostile event streams", () => {
  it("FINDING: an unknown event kind (corrupt/forward-compat log) is silently ignored — no count, no error", () => {
    const m = aggregateStabilitySlo([
      ev("session_started", "u", "s"),
      ev("crashh" as StabilitySloEvent["kind"], "u", "s", { fatal: true }),
    ]);
    expect(m.fatalCrashes).toBe(0);
    expect(m.crashFreeUsersRate).toBe(1);
  });

  it("FINDING (documented boundary): a fatal crash whose session_started fell in the previous window does not count against crash_free_sessions, and its user is dropped from crash_free_users too", () => {
    const events: StabilitySloEvent[] = [];
    for (let i = 0; i < 50; i++) events.push(ev("session_started", `u${i}`, `s${i}`));
    // 50 crashes from sessions/users started before this window opened.
    for (let i = 0; i < 50; i++) {
      events.push(ev("crash", `old${i}`, `oldsess${i}`, { fatal: true, fingerprint: "f" }));
    }
    const m = aggregateStabilitySlo(events);
    expect(m.fatalCrashes).toBe(50);
    expect(m.crashFreeSessionsRate).toBe(1);
    expect(m.crashFreeUsersRate).toBe(1);
    const e = evaluateStabilitySlo(m);
    expect(e.results.find((r) => r.slo === "crash_free_users")?.verdict).toBe("pass");
    expect(e.results.find((r) => r.slo === "crash_free_sessions")?.verdict).toBe("pass");
  });

  it("HELD: memory-pressure terminations count even without an observed session (conservative), duplicate session_started does not inflate the denominator", () => {
    const events: StabilitySloEvent[] = [];
    for (let i = 0; i < 60; i++) {
      events.push(ev("session_started", "u0", "s0"));
    }
    events.push(ev("memory_pressure_termination", "ghost", null));
    const m = aggregateStabilitySlo(events);
    expect(m.sessionsStarted).toBe(1);
    expect(m.memoryPressureTerminationRate).toBe(1);
  });

  it("FINDING: analysis_completed without a matching analysis_started drives analysisCompletionRate above 1 (still 'pass')", () => {
    const events: StabilitySloEvent[] = [];
    for (let i = 0; i < 20; i++) events.push(ev("analysis_started", "u", "s"));
    for (let i = 0; i < 40; i++) events.push(ev("analysis_completed", "u", "s"));
    const m = aggregateStabilitySlo(events);
    expect(m.analysisCompletionRate).toBe(2);
    expect(
      evaluateStabilitySlo(m).results.find((r) => r.slo === "analysis_completion")?.verdict,
    ).toBe("pass");
  });

  it("HELD: 200k seeded events (LCG seed 0xabc) aggregate without exceeding O(n) and every rate is within [0,1] or null", () => {
    let s = 0xabc;
    const rnd = (): number => (s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32;
    const kinds: StabilitySloEvent["kind"][] = [
      "session_started",
      "session_ended_clean",
      "crash",
      "memory_pressure_termination",
      "analysis_started",
      "analysis_completed",
      "analysis_failed",
      "camera_startup_succeeded",
      "camera_startup_failed",
      "try_again_rearmed",
      "try_again_failed",
      "session_flow_failed",
    ];
    const events: StabilitySloEvent[] = [];
    for (let i = 0; i < 200_000; i++) {
      const k = kinds[Math.floor(rnd() * kinds.length)] as StabilitySloEvent["kind"];
      events.push(
        ev(
          k,
          `u${Math.floor(rnd() * 2000)}`,
          rnd() < 0.05 ? null : `s${Math.floor(rnd() * 5000)}`,
          {
            fatal: rnd() < 0.5,
            fingerprint: "f",
            reason: "r",
            failureKind: "k",
          },
        ),
      );
    }
    const t0 = performance.now();
    const m = aggregateStabilitySlo(events);
    expect(performance.now() - t0).toBeLessThan(5_000);
    for (const key of [
      "crashFreeUsersRate",
      "crashFreeSessionsRate",
      "analysisCompletionRate",
      "cameraStartupFailureRate",
      "tryAgainFailureRate",
      "sessionFlowFailureRate",
    ] as const) {
      const v = m[key];
      expect(v === null || (v >= 0 && v <= 1), key).toBe(true);
    }
  });
});

describe("attack: guardRolloutAdvance with hostile percentages", () => {
  const pause = stabilityRolloutDecision(
    evaluateStabilitySlo({ ...healthyMetrics(), crashFreeUsersRate: 0 }),
  );
  const proceed = stabilityRolloutDecision(evaluateStabilitySlo(healthyMetrics()));

  it("HELD: under pause, 10→50 is blocked and effective stays 10; 10→10 and 10→0 are allowed", () => {
    expect(guardRolloutAdvance(pause, 10, 50)).toMatchObject({
      allowed: false,
      effectiveRolloutPercent: 10,
    });
    expect(guardRolloutAdvance(pause, 10, 10).allowed).toBe(true);
    expect(guardRolloutAdvance(pause, 10, 0).allowed).toBe(true);
  });

  it("FINDING: requested NaN is 'not an advance' → allowed under pause with effectiveRolloutPercent NaN", () => {
    const v = guardRolloutAdvance(pause, 10, Number.NaN);
    expect(v.allowed).toBe(true);
    expect(Number.isNaN(v.effectiveRolloutPercent)).toBe(true);
  });

  it("FINDING: percentages are unbounded — 10→1e9 under proceed and 10→-50 under pause are both allowed as-is", () => {
    expect(guardRolloutAdvance(proceed, 10, 1e9)).toMatchObject({
      allowed: true,
      effectiveRolloutPercent: 1e9,
    });
    expect(guardRolloutAdvance(pause, 10, -50)).toMatchObject({
      allowed: true,
      effectiveRolloutPercent: -50,
    });
  });

  it("FINDING: current NaN also reads as 'not an advance' — 100% under pause is allowed when the current percentage is unknown", () => {
    expect(guardRolloutAdvance(pause, Number.NaN, 100)).toMatchObject({
      allowed: true,
      effectiveRolloutPercent: 100,
    });
  });
});

describe("attack: media retention at Date extremes and clock skew", () => {
  const NOW = new Date("2026-09-04T12:00:00.000Z");

  it("HELD: a retention window that overflows Date (1e15 days) yields an Invalid deadline and the asset is NOT expired", () => {
    const created = new Date("2026-01-01T00:00:00.000Z");
    const deadline = retentionDeadline({ kind: "user_controlled" }, created, 1e15);
    expect(deadline).not.toBeNull();
    expect(Number.isNaN(deadline!.getTime())).toBe(true);
    expect(
      isRetentionExpired(
        { kind: "raw_video", createdAt: created, expiresAt: null, userRetentionDays: 1e15 },
        MEDIA_RETENTION_POLICY_V1,
        NOW,
      ),
    ).toBe(false);
  });

  it("HELD: fractional / NaN / Infinity / negative / 0 retention days never expire user content", () => {
    const created = new Date("2000-01-01T00:00:00.000Z");
    for (const days of [0.5, Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
      expect(
        isRetentionExpired(
          { kind: "raw_video", createdAt: created, expiresAt: null, userRetentionDays: days },
          MEDIA_RETENTION_POLICY_V1,
          NOW,
        ),
        String(days),
      ).toBe(false);
    }
  });

  it("HELD: share_video expires at exactly 30 days (<=), not one ms before; a createdAt in the future never expires", () => {
    const created = new Date(NOW.getTime() - 30 * 86_400_000);
    const asset = { kind: "share_video" as const, expiresAt: null, userRetentionDays: null };
    expect(
      isRetentionExpired({ ...asset, createdAt: created }, MEDIA_RETENTION_POLICY_V1, NOW),
    ).toBe(true);
    expect(
      isRetentionExpired(
        { ...asset, createdAt: new Date(created.getTime() + 1) },
        MEDIA_RETENTION_POLICY_V1,
        NOW,
      ),
    ).toBe(false);
    expect(
      isRetentionExpired(
        { ...asset, createdAt: new Date(NOW.getTime() + 86_400_000) },
        MEDIA_RETENTION_POLICY_V1,
        NOW,
      ),
    ).toBe(false);
  });

  it("FINDING: an Invalid Date createdAt on a fixed_window asset silently never expires (share renders would accumulate)", () => {
    expect(
      isRetentionExpired(
        {
          kind: "share_video",
          createdAt: new Date("garbage"),
          expiresAt: null,
          userRetentionDays: null,
        },
        MEDIA_RETENTION_POLICY_V1,
        NOW,
      ),
    ).toBe(false);
  });

  it("HELD: explicit expiresAt wins over the kind rule in both directions (until_deleted with a past expiresAt IS expired)", () => {
    expect(
      isRetentionExpired(
        {
          kind: "model_bundle",
          createdAt: new Date(0),
          expiresAt: new Date(NOW.getTime() - 1),
          userRetentionDays: null,
        },
        MEDIA_RETENTION_POLICY_V1,
        NOW,
      ),
    ).toBe(true);
    expect(
      isRetentionExpired(
        {
          kind: "share_video",
          createdAt: new Date(0),
          expiresAt: new Date(NOW.getTime() + 1),
          userRetentionDays: null,
        },
        MEDIA_RETENTION_POLICY_V1,
        NOW,
      ),
    ).toBe(false);
  });
});
