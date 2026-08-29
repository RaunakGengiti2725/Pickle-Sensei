import { describe, expect, it } from "vitest";
import {
  aggregateStabilitySlo,
  evaluateStabilitySlo,
  guardRolloutAdvance,
  stabilityRolloutDecision,
  STABILITY_SLO_KEYS,
  STABILITY_SLO_THRESHOLDS_V1,
  type StabilitySloEvent,
  type StabilitySloKey,
  type StabilitySloThreshold,
} from "../src/stabilitySlo.js";

const AT = "2026-08-29T00:00:00.000Z";

function ev(
  kind: StabilitySloEvent["kind"],
  userKey: string,
  sessionKey: string | null,
  extra: Record<string, unknown> = {},
): StabilitySloEvent {
  return { kind, userKey, sessionKey, at: AT, ...extra } as StabilitySloEvent;
}

/** N users each starting one clean session. */
function cleanSessions(count: number): StabilitySloEvent[] {
  const events: StabilitySloEvent[] = [];
  for (let i = 0; i < count; i++) {
    events.push(ev("session_started", `u${i}`, `s${i}`));
    events.push(ev("session_ended_clean", `u${i}`, `s${i}`));
  }
  return events;
}

describe("aggregateStabilitySlo", () => {
  it("returns null rates (never a fake 100%) for an empty window", () => {
    const metrics = aggregateStabilitySlo([]);
    expect(metrics.usersObserved).toBe(0);
    expect(metrics.sessionsStarted).toBe(0);
    expect(metrics.crashFreeUsersRate).toBeNull();
    expect(metrics.crashFreeSessionsRate).toBeNull();
    expect(metrics.analysisCompletionRate).toBeNull();
    expect(metrics.cameraStartupFailureRate).toBeNull();
    expect(metrics.tryAgainFailureRate).toBeNull();
    expect(metrics.sessionFlowFailureRate).toBeNull();
    expect(metrics.memoryPressureTerminationRate).toBeNull();
  });

  it("computes crash-free users and sessions from fatal crashes only", () => {
    const events = [
      ...cleanSessions(4),
      ev("crash", "u0", "s0", { fatal: true, fingerprint: "f1" }),
      ev("crash", "u1", "s1", { fatal: false, fingerprint: "f2" }),
    ];
    const metrics = aggregateStabilitySlo(events);
    expect(metrics.usersObserved).toBe(4);
    expect(metrics.sessionsStarted).toBe(4);
    expect(metrics.fatalCrashes).toBe(1);
    expect(metrics.crashFreeUsersRate).toBe(3 / 4);
    expect(metrics.crashFreeSessionsRate).toBe(3 / 4);
  });

  it("scopes user crash rate to observed users, session rate to observed sessions", () => {
    const events = [
      ...cleanSessions(2),
      // Crash from a user/session outside this window's observations.
      ev("crash", "u-outside", "s-outside", { fatal: true, fingerprint: "f1" }),
    ];
    const metrics = aggregateStabilitySlo(events);
    expect(metrics.crashFreeUsersRate).toBe(1);
    expect(metrics.crashFreeSessionsRate).toBe(1);
    expect(metrics.fatalCrashes).toBe(1);
  });

  it("computes analysis completion, camera startup, and try-again rates", () => {
    const events = [
      ev("analysis_started", "u0", "s0"),
      ev("analysis_completed", "u0", "s0"),
      ev("analysis_started", "u0", "s0"),
      ev("analysis_failed", "u0", "s0", { failureKind: "sidecar_unreadable" }),
      ev("camera_startup_succeeded", "u0", "s0"),
      ev("camera_startup_failed", "u0", "s0", { reason: "native_error" }),
      ev("try_again_rearmed", "u0", "s0"),
      ev("try_again_failed", "u0", "s0", { reason: "handoff_expired" }),
    ];
    const metrics = aggregateStabilitySlo(events);
    expect(metrics.analysisCompletionRate).toBe(1 / 2);
    expect(metrics.cameraStartupFailureRate).toBe(1 / 2);
    expect(metrics.tryAgainFailureRate).toBe(1 / 2);
  });

  it("computes session-flow failure and memory-pressure termination rates", () => {
    const events = [
      ...cleanSessions(4),
      ev("session_flow_failed", "u0", "s0", { reason: "dispatch_failed" }),
      ev("session_flow_failed", "u0", "s0", { reason: "dispatch_failed" }),
      ev("memory_pressure_termination", "u1", null),
    ];
    const metrics = aggregateStabilitySlo(events);
    // Two failures in ONE observed session → 1/4 of sessions affected.
    expect(metrics.sessionFlowFailures).toBe(2);
    expect(metrics.sessionFlowFailureRate).toBe(1 / 4);
    expect(metrics.memoryPressureTerminationRate).toBe(1 / 4);
  });
});

describe("evaluateStabilitySlo", () => {
  /** Thresholds with minSample 1 so small fixtures are evaluable. */
  const permissive: Record<StabilitySloKey, StabilitySloThreshold> = Object.fromEntries(
    STABILITY_SLO_KEYS.map((key) => [key, { ...STABILITY_SLO_THRESHOLDS_V1[key], minSample: 1 }]),
  ) as Record<StabilitySloKey, StabilitySloThreshold>;

  it("marks every SLO not_evaluable on an empty window", () => {
    const evaluation = evaluateStabilitySlo(aggregateStabilitySlo([]));
    expect(evaluation.results).toHaveLength(STABILITY_SLO_KEYS.length);
    for (const result of evaluation.results) expect(result.verdict).toBe("not_evaluable");
  });

  it("marks a below-minSample SLO not_evaluable even when the rate looks fine", () => {
    const evaluation = evaluateStabilitySlo(aggregateStabilitySlo(cleanSessions(3)));
    const users = evaluation.results.find((r) => r.slo === "crash_free_users");
    expect(users?.value).toBe(1);
    expect(users?.sampleSize).toBe(3);
    expect(users?.verdict).toBe("not_evaluable");
  });

  it("breaches min-direction SLOs below threshold and max-direction above", () => {
    const events = [
      ...cleanSessions(4),
      ev("crash", "u0", "s0", { fatal: true, fingerprint: "f1" }),
      ev("analysis_started", "u1", "s1"),
      ev("analysis_failed", "u1", "s1", { failureKind: "x" }),
      ev("camera_startup_failed", "u1", "s1", { reason: "native_error" }),
    ];
    const evaluation = evaluateStabilitySlo(aggregateStabilitySlo(events), permissive);
    const byKey = new Map(evaluation.results.map((r) => [r.slo, r.verdict]));
    expect(byKey.get("crash_free_users")).toBe("breach");
    expect(byKey.get("crash_free_sessions")).toBe("breach");
    expect(byKey.get("analysis_completion")).toBe("breach");
    expect(byKey.get("camera_startup_failure")).toBe("breach");
  });

  it("passes every SLO on a fully healthy evaluable window", () => {
    const events = [
      ...cleanSessions(4),
      ev("analysis_started", "u0", "s0"),
      ev("analysis_completed", "u0", "s0"),
      ev("camera_startup_succeeded", "u0", "s0"),
      ev("try_again_rearmed", "u0", "s0"),
    ];
    const evaluation = evaluateStabilitySlo(aggregateStabilitySlo(events), permissive);
    for (const result of evaluation.results) expect(result.verdict).toBe("pass");
  });
});

describe("stabilityRolloutDecision + guardRolloutAdvance", () => {
  const permissive: Record<StabilitySloKey, StabilitySloThreshold> = Object.fromEntries(
    STABILITY_SLO_KEYS.map((key) => [key, { ...STABILITY_SLO_THRESHOLDS_V1[key], minSample: 1 }]),
  ) as Record<StabilitySloKey, StabilitySloThreshold>;

  const healthy = evaluateStabilitySlo(
    aggregateStabilitySlo([
      ...cleanSessions(4),
      ev("analysis_started", "u0", "s0"),
      ev("analysis_completed", "u0", "s0"),
      ev("camera_startup_succeeded", "u0", "s0"),
      ev("try_again_rearmed", "u0", "s0"),
    ]),
    permissive,
  );
  const breached = evaluateStabilitySlo(
    aggregateStabilitySlo([
      ...cleanSessions(4),
      ev("crash", "u0", "s0", { fatal: true, fingerprint: "f1" }),
      ev("analysis_started", "u0", "s0"),
      ev("analysis_completed", "u0", "s0"),
      ev("camera_startup_succeeded", "u0", "s0"),
      ev("try_again_rearmed", "u0", "s0"),
    ]),
    permissive,
  );
  const empty = evaluateStabilitySlo(aggregateStabilitySlo([]));

  it("proceeds only when everything is evaluable and passing", () => {
    expect(stabilityRolloutDecision(healthy).action).toBe("proceed");
  });

  it("pauses on any breach, listing the breached SLOs", () => {
    const decision = stabilityRolloutDecision(breached);
    expect(decision.action).toBe("pause");
    expect(decision.breachedSlos).toContain("crash_free_users");
  });

  it("holds (never green) when data is missing but nothing breached", () => {
    const decision = stabilityRolloutDecision(empty);
    expect(decision.action).toBe("hold");
    expect(decision.notEvaluableSlos).toHaveLength(STABILITY_SLO_KEYS.length);
  });

  it("blocks advancing exposure on pause/hold but never blocks pause or rollback", () => {
    const pause = stabilityRolloutDecision(breached);
    expect(guardRolloutAdvance(pause, 10, 50)).toMatchObject({
      allowed: false,
      effectiveRolloutPercent: 10,
    });
    expect(guardRolloutAdvance(pause, 10, 10).allowed).toBe(true);
    expect(guardRolloutAdvance(pause, 10, 0)).toMatchObject({
      allowed: true,
      effectiveRolloutPercent: 0,
    });
    const hold = stabilityRolloutDecision(empty);
    expect(guardRolloutAdvance(hold, 10, 50).allowed).toBe(false);
    const proceed = stabilityRolloutDecision(healthy);
    expect(guardRolloutAdvance(proceed, 10, 50)).toMatchObject({
      allowed: true,
      effectiveRolloutPercent: 50,
    });
  });
});
