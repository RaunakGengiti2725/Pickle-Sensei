import { describe, expect, it } from "vitest";
import type { StabilitySloEvent } from "@pickle/shared-types";
import {
  StabilitySloEventSchema,
  StabilityWindowSubmission,
  createStabilityGuard,
} from "../src/modules/admin/stabilityGuard.js";

const AT = "2026-08-29T00:00:00.000Z";

function cleanSessions(count: number): StabilitySloEvent[] {
  const events: StabilitySloEvent[] = [];
  for (let i = 0; i < count; i++) {
    events.push({ kind: "session_started", userKey: `u${i}`, sessionKey: `s${i}`, at: AT });
    events.push({ kind: "session_ended_clean", userKey: `u${i}`, sessionKey: `s${i}`, at: AT });
  }
  return events;
}

/** Enough clean traffic to make EVERY SLO evaluable at the frozen v1
 * minimum sample sizes (50 sessions, 20 analyses, 20 camera startups,
 * 10 try-agains). */
function healthyEvaluableWindow(): StabilitySloEvent[] {
  const events = cleanSessions(50);
  for (let i = 0; i < 20; i++) {
    events.push({ kind: "analysis_started", userKey: "u0", sessionKey: "s0", at: AT });
    events.push({ kind: "analysis_completed", userKey: "u0", sessionKey: "s0", at: AT });
    events.push({ kind: "camera_startup_succeeded", userKey: "u0", sessionKey: "s0", at: AT });
  }
  for (let i = 0; i < 10; i++) {
    events.push({ kind: "try_again_rearmed", userKey: "u0", sessionKey: "s0", at: AT });
  }
  return events;
}

describe("createStabilityGuard", () => {
  it("is inactive (never blocks, never passes) before any window is observed", () => {
    const guard = createStabilityGuard();
    expect(guard.currentWindow()).toBeNull();
    expect(guard.checkRolloutChange(10, 50)).toEqual({ active: false });
  });

  it("proceeds on a fully healthy evaluable window", () => {
    const guard = createStabilityGuard(() => AT);
    const window = guard.submitWindow("w1", healthyEvaluableWindow());
    expect(window.decision.action).toBe("proceed");
    const check = guard.checkRolloutChange(10, 50);
    expect(check).toMatchObject({
      active: true,
      verdict: { allowed: true, effectiveRolloutPercent: 50 },
    });
  });

  it("holds on an insufficient-sample window and blocks advances", () => {
    const guard = createStabilityGuard();
    const window = guard.submitWindow("w1", cleanSessions(3));
    expect(window.decision.action).toBe("hold");
    const check = guard.checkRolloutChange(10, 50);
    expect(check).toMatchObject({
      active: true,
      verdict: { allowed: false, effectiveRolloutPercent: 10 },
    });
  });

  it("pauses on a breached window, blocking advances but never rollbacks", () => {
    const guard = createStabilityGuard();
    const events = healthyEvaluableWindow();
    events.push({
      kind: "crash",
      fatal: true,
      fingerprint: "f1",
      userKey: "u0",
      sessionKey: "s0",
      at: AT,
    });
    const window = guard.submitWindow("w1", events);
    expect(window.decision.action).toBe("pause");
    expect(window.decision.breachedSlos).toContain("crash_free_sessions");
    const advance = guard.checkRolloutChange(10, 50);
    expect(advance).toMatchObject({ active: true, verdict: { allowed: false } });
    const rollback = guard.checkRolloutChange(10, 0);
    expect(rollback).toMatchObject({
      active: true,
      verdict: { allowed: true, effectiveRolloutPercent: 0 },
    });
    const holdSteady = guard.checkRolloutChange(10, 10);
    expect(holdSteady).toMatchObject({ active: true, verdict: { allowed: true } });
  });

  it("replaces the window on resubmission (latest observation wins)", () => {
    const guard = createStabilityGuard();
    guard.submitWindow("w1", cleanSessions(3));
    expect(guard.currentWindow()?.decision.action).toBe("hold");
    guard.submitWindow("w2", healthyEvaluableWindow());
    expect(guard.currentWindow()?.windowId).toBe("w2");
    expect(guard.currentWindow()?.decision.action).toBe("proceed");
  });
});

describe("stability window schemas", () => {
  it("accepts every typed event kind and rejects unknown kinds", () => {
    const ok = StabilitySloEventSchema.safeParse({
      kind: "camera_startup_failed",
      reason: "native_error",
      userKey: "u1",
      sessionKey: null,
      at: AT,
    });
    expect(ok.success).toBe(true);
    const bad = StabilitySloEventSchema.safeParse({
      kind: "made_up_event",
      userKey: "u1",
      sessionKey: null,
      at: AT,
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a crash event without a fingerprint", () => {
    const bad = StabilitySloEventSchema.safeParse({
      kind: "crash",
      fatal: true,
      userKey: "u1",
      sessionKey: "s1",
      at: AT,
    });
    expect(bad.success).toBe(false);
  });

  it("validates a full submission envelope", () => {
    const parsed = StabilityWindowSubmission.safeParse({
      windowId: "2026-08-29T00",
      events: cleanSessions(2),
    });
    expect(parsed.success).toBe(true);
  });
});
