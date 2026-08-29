/**
 * D3-02 — red-team EVENT isolation (SYNTHETIC adversarial fixtures).
 *
 * Every fixture here is synthetic (gaussian speed-bump construction, same
 * helper as strokeEvents.test.ts) and clearly labeled as such. Scenarios:
 * rapid consecutive strokes, practice-swing-then-real-swing, miss (full
 * swing, no contact), interrupted swing, walk-through wrist wobble.
 * Invariants under attack: no fabricated event bounds, no contact claim
 * attached to a miss, closed session events immutable.
 *
 * Breaks found by this workstream (regression-pinned below):
 *  B1  rapid consecutive strokes with peaks 600–700ms apart were GLUED into
 *      ONE event spanning both swings (fabricated multi-swing bounds);
 *  B2  a contact estimate falling OUTSIDE every proposed event silently fell
 *      through to prominence selection with no recorded signal — a contact
 *      claim from a miss/noise could steer downstream analysis of an event
 *      it does not belong to (now recorded as `contactOrphaned`);
 *  B3  sustained walk-through wrist wobble chained through the fragment glue
 *      into a single 4.2s "event" (physically implausible stroke bounds).
 */
import { describe, expect, it } from "vitest";
import {
  proposeStrokeEventsV2,
  selectTargetEvent,
  selectTargetEventV2,
} from "../src/strokeEvents.js";
import { SessionEventEngine } from "../src/sessionEngine.js";

/** SYNTHETIC speed series with gaussian bumps (same helper as strokeEvents.test.ts). */
function speedBumps(
  bumps: Array<{ peakMs: number; height: number; halfWidthMs: number }>,
  fromMs = 0,
  toMs = 8000,
  stepMs = 40,
): Array<{ timestampMs: number; value: number }> {
  const series: Array<{ timestampMs: number; value: number }> = [];
  for (let t = fromMs; t <= toMs; t += stepMs) {
    let value = 0.08; // idle baseline
    for (const bump of bumps) {
      value += bump.height * Math.exp(-0.5 * ((t - bump.peakMs) / bump.halfWidthMs) ** 2);
    }
    series.push({ timestampMs: t, value });
  }
  return series;
}

describe("B1 — rapid consecutive strokes must stay TWO events (fixed glue over-merge)", () => {
  it("comparable strokes with peaks 600–1000ms apart are never fused into one event", () => {
    for (const gap of [600, 700, 800, 900, 1000]) {
      const wrist = speedBumps([
        { peakMs: 1500, height: 1.8, halfWidthMs: 110 },
        { peakMs: 1500 + gap, height: 1.7, halfWidthMs: 110 },
      ]);
      const { events } = proposeStrokeEventsV2({
        paddleSpeeds: null,
        wristSpeeds: wrist,
        clipStartMs: 0,
        clipEndMs: 8000,
      });
      expect(events.length, `gap=${gap}ms`).toBe(2);
      // No fabricated bounds: neither event spans both swings.
      expect(events[0]!.endMs).toBeLessThan(1500 + gap - 100);
      expect(events[1]!.startMs).toBeGreaterThan(1500 + 100);
      expect(events[0]!.endMs).toBeLessThanOrEqual(events[1]!.startMs);
    }
  });

  it("swing + weaker follow-through burst (rally1-shaped fragmentation, SYNTHETIC replica) still glues to ONE event", () => {
    // The glue exists for this measured failure shape: main swing then a
    // weaker follow-through burst a brief dip later — one physical movement.
    const wrist = speedBumps([
      { peakMs: 1500, height: 2.0, halfWidthMs: 140 },
      { peakMs: 1980, height: 0.9, halfWidthMs: 80 },
    ]);
    const { events } = proposeStrokeEventsV2({
      paddleSpeeds: null,
      wristSpeeds: wrist,
      clipStartMs: 0,
      clipEndMs: 8000,
    });
    expect(events.length).toBe(1);
    expect(events[0]!.peakMs).toBeLessThan(1700); // peak stays on the swing
  });

  it("KNOWN LIMIT (open, honest): comparable peaks ≤500ms apart are indistinguishable from measured fragmentation and remain glued", () => {
    const wrist = speedBumps([
      { peakMs: 1500, height: 1.8, halfWidthMs: 110 },
      { peakMs: 1980, height: 1.7, halfWidthMs: 110 },
    ]);
    const { events } = proposeStrokeEventsV2({
      paddleSpeeds: null,
      wristSpeeds: wrist,
      clipStartMs: 0,
      clipEndMs: 8000,
    });
    expect(events.length).toBe(1);
  });
});

describe("B2 — a contact estimate outside every event is a RECORDED orphan, never a silent anchor", () => {
  const wrist = speedBumps([
    { peakMs: 1500, height: 2.2, halfWidthMs: 120 },
    { peakMs: 5000, height: 1.0, halfWidthMs: 120 },
  ]);
  const { events } = proposeStrokeEventsV2({
    paddleSpeeds: null,
    wristSpeeds: wrist,
    clipStartMs: 0,
    clipEndMs: 8000,
  });

  it("prominence fall-through carries contactOrphaned (v1 and v2)", () => {
    for (const selection of [selectTargetEvent(events, 3200), selectTargetEventV2(events, 3200)]) {
      expect(selection.status).toBe("selected");
      if (selection.status !== "selected") return;
      expect(selection.via).toBe("prominence");
      expect(selection.contactOrphaned).toBe(true);
      // The orphaned estimate is truly outside the selected event.
      expect(3200 < selection.event.startMs - 60 || 3200 > selection.event.endMs + 60).toBe(true);
    }
  });

  it("single-event miss window: swing selected, orphaned contact recorded", () => {
    const oneSwing = proposeStrokeEventsV2({
      paddleSpeeds: null,
      wristSpeeds: speedBumps([{ peakMs: 1500, height: 2.0, halfWidthMs: 120 }]),
      clipStartMs: 0,
      clipEndMs: 8000,
    }).events;
    const selection = selectTargetEvent(oneSwing, 4000);
    expect(selection.status).toBe("selected");
    if (selection.status !== "selected") return;
    expect(selection.contactOrphaned).toBe(true);
  });

  it("a contact inside an event still selects cleanly with NO orphan flag", () => {
    const selection = selectTargetEvent(events, 1510);
    expect(selection.status).toBe("selected");
    if (selection.status !== "selected") return;
    expect(selection.via).toBe("contact");
    expect(selection.contactOrphaned).toBeUndefined();
  });

  it("miss (full swing, NO contact estimate): selection carries no contact claim at all", () => {
    const selection = selectTargetEvent(events, null);
    expect(selection.status).toBe("selected");
    if (selection.status !== "selected") return;
    expect(selection.contactOrphaned).toBeUndefined();
    // Proposals themselves never carry a contact field — segmentation cannot
    // fabricate a contact claim inside a miss.
    for (const event of events) {
      expect("contactMs" in event).toBe(false);
    }
  });
});

describe("practice swing then real swing (SYNTHETIC)", () => {
  const wrist = speedBumps([
    { peakMs: 1500, height: 1.8, halfWidthMs: 130 }, // practice swing
    { peakMs: 4000, height: 1.9, halfWidthMs: 130 }, // real swing
  ]);
  const { events } = proposeStrokeEventsV2({
    paddleSpeeds: null,
    wristSpeeds: wrist,
    clipStartMs: 0,
    clipEndMs: 8000,
  });

  it("two comparable swings without an anchor abstain as MULTI_STROKE_AMBIGUOUS", () => {
    expect(events.length).toBe(2);
    const selection = selectTargetEventV2(events, null);
    expect(selection.status).toBe("ambiguous");
  });

  it("a contact anchor inside the real swing resolves it — never the practice swing", () => {
    const selection = selectTargetEventV2(events, 4010);
    expect(selection.status).toBe("selected");
    if (selection.status !== "selected") return;
    expect(selection.via).toBe("contact");
    expect(Math.abs(selection.event.peakMs - 4000)).toBeLessThanOrEqual(80);
  });
});

describe("interrupted swing (SYNTHETIC)", () => {
  it("an aborted micro-burst below the minimum span proposes nothing", () => {
    const wrist = speedBumps([{ peakMs: 1500, height: 2.0, halfWidthMs: 25 }]);
    const { events } = proposeStrokeEventsV2({
      paddleSpeeds: null,
      wristSpeeds: wrist,
      clipStartMs: 0,
      clipEndMs: 8000,
    });
    expect(events.length).toBe(0);
  });

  it("a short interrupted swing gets honest bounds confined to the observed motion", () => {
    const wrist = speedBumps([{ peakMs: 1500, height: 2.0, halfWidthMs: 50 }]);
    const { events } = proposeStrokeEventsV2({
      paddleSpeeds: null,
      wristSpeeds: wrist,
      clipStartMs: 0,
      clipEndMs: 8000,
    });
    expect(events.length).toBe(1);
    expect(events[0]!.startMs).toBeGreaterThanOrEqual(1200);
    expect(events[0]!.endMs).toBeLessThanOrEqual(1800);
  });
});

describe("B3 — walk-through wrist wobble cannot fabricate a multi-second event", () => {
  it("sustained locomotion wobble never yields an event longer than the boundary-reach cap allows", () => {
    const series: Array<{ timestampMs: number; value: number }> = [];
    for (let t = 0; t <= 8000; t += 40) {
      series.push({
        timestampMs: t,
        value: 0.45 + 0.2 * Math.sin(t / 300) + 0.1 * Math.sin(t / 97),
      });
    }
    const { events } = proposeStrokeEventsV2({
      paddleSpeeds: null,
      wristSpeeds: series,
      clipStartMs: 0,
      clipEndMs: 8000,
    });
    for (const event of events) {
      // ±1200ms reach from the peak: no glued mega-event (was 4240ms pre-fix).
      expect(event.endMs - event.startMs).toBeLessThanOrEqual(2400);
    }
    // Residual low-confidence wobble proposals abstain at selection: no
    // decisive prominence leader exists in locomotion noise.
    if (events.length >= 2) {
      expect(selectTargetEventV2(events, null).status).toBe("ambiguous");
    }
  });

  it("a single-frame spike is smoothed away, never an event", () => {
    const series: Array<{ timestampMs: number; value: number }> = [];
    for (let t = 0; t <= 8000; t += 40) {
      series.push({ timestampMs: t, value: t === 3000 ? 5.0 : 0.08 });
    }
    const { events } = proposeStrokeEventsV2({
      paddleSpeeds: null,
      wristSpeeds: series,
      clipStartMs: 0,
      clipEndMs: 8000,
    });
    expect(events.length).toBe(0);
  });
});

describe("session engine — closed events immutable under rapid strokes and late data (SYNTHETIC)", () => {
  it("rapid strokes 700ms apart stream as TWO non-overlapping closed events with frozen proposals", () => {
    const engine = new SessionEventEngine({ sessionId: "d3-02-rapid" });
    const wrist = speedBumps(
      [
        { peakMs: 1500, height: 1.8, halfWidthMs: 110 },
        { peakMs: 2200, height: 2.2, halfWidthMs: 110 },
      ],
      0,
      9000,
    );
    const emitted = [];
    for (const sample of wrist) emitted.push(...engine.push({ wrist: [sample] }));
    emitted.push(...engine.flush());
    expect(emitted.length).toBe(2);
    expect(emitted[0]!.proposal.endMs).toBeLessThanOrEqual(emitted[1]!.proposal.startMs);
    for (const event of emitted) expect(Object.isFrozen(event.proposal)).toBe(true);
  });

  it("late samples behind the frontier are dropped and counted — closed bounds never move", () => {
    const engine = new SessionEventEngine({ sessionId: "d3-02-late" });
    const wrist = speedBumps([{ peakMs: 1500, height: 2.0, halfWidthMs: 110 }], 0, 6000);
    for (const sample of wrist) engine.push({ wrist: [sample] });
    const before = engine.snapshot().events.map((event) => ({ ...event.proposal }));
    expect(before.length).toBe(1);
    // Adversarial late injection: a huge spike inside the closed event.
    engine.push({ wrist: [{ timestampMs: 1520, value: 9.9 }] });
    engine.push({ wrist: [{ timestampMs: 6100, value: 0.05 }] });
    const after = engine.snapshot();
    expect(after.events.map((event) => ({ ...event.proposal }))).toEqual(before);
    expect(after.qualityState.droppedLateSamples).toBe(1);
  });
});
