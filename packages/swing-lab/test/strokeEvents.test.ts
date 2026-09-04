import { describe, expect, it } from "vitest";
import { proposeStrokeEvents, selectTargetEvent } from "../src/index.js";
import { proposeStrokeEventsV2, selectTargetEventV2 } from "../src/strokeEvents.js";
import { segmentPhasesTemporalV2 } from "../src/index.js";

/** Speed series with gaussian-ish bumps at given (peakMs, height, halfWidth). */
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

describe("proposeStrokeEvents", () => {
  it("finds two separate swings as two events with honest boundaries", () => {
    const { events, source } = proposeStrokeEvents({
      paddleSpeeds: speedBumps([
        { peakMs: 1500, height: 2.0, halfWidthMs: 120 },
        { peakMs: 5000, height: 1.6, halfWidthMs: 140 },
      ]),
      wristSpeeds: null,
      clipStartMs: 0,
      clipEndMs: 8000,
    });
    expect(source).toBe("paddle");
    expect(events.length).toBe(2);
    expect(events[0]!.eventId).toBe("E1");
    expect(Math.abs(events[0]!.peakMs - 1500)).toBeLessThanOrEqual(60);
    expect(Math.abs(events[1]!.peakMs - 5000)).toBeLessThanOrEqual(60);
    expect(events[0]!.endMs).toBeLessThan(events[1]!.startMs); // no window stretching
  });

  it("merges a double-peaked single swing into one event", () => {
    const { events } = proposeStrokeEvents({
      paddleSpeeds: speedBumps([
        { peakMs: 1450, height: 1.8, halfWidthMs: 110 },
        { peakMs: 1650, height: 1.7, halfWidthMs: 110 }, // shallow valley between
      ]),
      wristSpeeds: null,
      clipStartMs: 0,
      clipEndMs: 4000,
    });
    expect(events.length).toBe(1);
  });

  it("proposes nothing on idle motion", () => {
    const { events } = proposeStrokeEvents({
      paddleSpeeds: speedBumps([]),
      wristSpeeds: null,
      clipStartMs: 0,
      clipEndMs: 4000,
    });
    expect(events.length).toBe(0);
  });
});

describe("proposeStrokeEvents — degenerate windows and non-finite samples (ADJ-08)", () => {
  const swing = speedBumps([{ peakMs: 1500, height: 2.0, halfWidthMs: 120 }], 0, 4000);

  it("abstains with degenerate_window on inverted or zero-length clip bounds", () => {
    for (const [clipStartMs, clipEndMs] of [
      [4000, 0],
      [1500, 1500],
    ] as const) {
      const v1 = proposeStrokeEvents({
        paddleSpeeds: swing,
        wristSpeeds: null,
        clipStartMs,
        clipEndMs,
      });
      expect(v1).toEqual({ events: [], source: "none", reason: "degenerate_window" });
      const v2 = proposeStrokeEventsV2({
        paddleSpeeds: swing,
        wristSpeeds: swing,
        clipStartMs,
        clipEndMs,
      });
      expect(v2).toEqual({ events: [], source: "none", reason: "degenerate_window" });
    }
  });

  it("drops non-finite samples before smoothing; emitted events stay finite and in-clip", () => {
    const poisoned = swing.map((sample, index) =>
      index % 6 === 2
        ? { ...sample, value: Number.NaN }
        : index % 6 === 4
          ? { ...sample, timestampMs: Number.NaN }
          : sample,
    );
    const { events, source } = proposeStrokeEvents({
      paddleSpeeds: null,
      wristSpeeds: poisoned,
      clipStartMs: 0,
      clipEndMs: 4000,
    });
    expect(source).toBe("wrist");
    expect(events.length).toBe(1);
    const event = events[0]!;
    for (const value of [
      event.startMs,
      event.peakMs,
      event.endMs,
      event.peakSpeed,
      event.prominence,
    ]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(event.startMs).toBeGreaterThanOrEqual(0);
    expect(event.endMs).toBeLessThanOrEqual(4000);
    expect(Math.abs(event.peakMs - 1500)).toBeLessThanOrEqual(60);
  });

  it("property: for random finite inputs every event satisfies clipStart <= start < end <= clipEnd", () => {
    // Deterministic LCG so a failure replays from its seed.
    let state = 0x9e3779b9;
    const rand = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    const randomSeries = (fromMs: number, toMs: number) => {
      const stepMs = 20 + Math.floor(rand() * 30);
      const series: Array<{ timestampMs: number; value: number }> = [];
      let value = rand() * 0.4;
      for (let t = fromMs; t <= toMs; t += stepMs) {
        value = Math.max(0, value + (rand() - 0.5) * 0.4);
        if (rand() < 0.05) value += rand() * 4;
        series.push({ timestampMs: t, value });
      }
      return series;
    };
    let emitted = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      // Series deliberately extend PAST both clip edges: proposals must still be
      // confined to the clip.
      const clipStartMs = Math.floor(rand() * 3000);
      const clipEndMs = clipStartMs + 800 + Math.floor(rand() * 8000);
      const seriesFrom = clipStartMs - Math.floor(rand() * 2000);
      const seriesTo = clipEndMs + Math.floor(rand() * 2000);
      const paddle = rand() < 0.3 ? null : randomSeries(seriesFrom, seriesTo);
      const wrist = rand() < 0.2 ? null : randomSeries(seriesFrom, seriesTo);
      for (const proposal of [
        proposeStrokeEvents({ paddleSpeeds: paddle, wristSpeeds: wrist, clipStartMs, clipEndMs }),
        proposeStrokeEventsV2({ paddleSpeeds: paddle, wristSpeeds: wrist, clipStartMs, clipEndMs }),
      ]) {
        for (const event of proposal.events) {
          emitted += 1;
          const label = `seed ${seed} ${JSON.stringify(event)} clip ${clipStartMs}..${clipEndMs}`;
          expect(event.startMs, label).toBeGreaterThanOrEqual(clipStartMs);
          expect(event.startMs, label).toBeLessThan(event.endMs);
          expect(event.endMs, label).toBeLessThanOrEqual(clipEndMs);
          expect(event.peakMs, label).toBeGreaterThanOrEqual(event.startMs);
          expect(event.peakMs, label).toBeLessThanOrEqual(event.endMs);
          expect(Number.isFinite(event.peakSpeed), label).toBe(true);
        }
      }
    }
    expect(emitted).toBeGreaterThan(50); // the property must actually be exercised
  });
});

describe("low-amplitude tier (wrist-only compact strokes)", () => {
  it("admits a sub-floor compact stroke only from wrist, flagged and confidence-penalized", () => {
    const compact = speedBumps([{ peakMs: 2000, height: 0.28, halfWidthMs: 130 }], 0, 4000);
    const fromWrist = proposeStrokeEvents({
      paddleSpeeds: null,
      wristSpeeds: compact,
      clipStartMs: 0,
      clipEndMs: 4000,
    });
    expect(fromWrist.source).toBe("wrist");
    expect(fromWrist.events.length).toBe(1);
    expect(fromWrist.events[0]!.lowAmplitude).toBe(true);
    expect(fromWrist.events[0]!.peakSpeed).toBeLessThan(0.5);
    const unpenalized = Math.max(
      0.2,
      Math.min(0.9, 0.4 + (fromWrist.events[0]!.prominence - 1) * 0.12),
    );
    expect(fromWrist.events[0]!.confidence).toBeCloseTo(unpenalized - 0.15, 6);
    expect(Math.abs(fromWrist.events[0]!.peakMs - 2000)).toBeLessThanOrEqual(60);
    const fromPaddle = proposeStrokeEvents({
      paddleSpeeds: compact,
      wristSpeeds: null,
      clipStartMs: 0,
      clipEndMs: 4000,
    });
    expect(fromPaddle.events.length).toBe(0); // tier-2 is wrist-only
  });

  it("rejects the same amplitude over a busy baseline (prominence gate)", () => {
    const busy = speedBumps([{ peakMs: 2000, height: 0.2, halfWidthMs: 130 }], 0, 4000).map(
      (sample) => ({ ...sample, value: sample.value + 0.1 }), // baseline 0.18, peak ≈0.38
    );
    const { events } = proposeStrokeEvents({
      paddleSpeeds: null,
      wristSpeeds: busy,
      clipStartMs: 0,
      clipEndMs: 4000,
    });
    expect(events.length).toBe(0);
  });

  it("never alters tier-1 output: full swings keep identical bounds and no flag", () => {
    const wrist = speedBumps([{ peakMs: 1500, height: 2.0, halfWidthMs: 120 }], 0, 4000);
    const { events } = proposeStrokeEvents({
      paddleSpeeds: null,
      wristSpeeds: wrist,
      clipStartMs: 0,
      clipEndMs: 4000,
    });
    expect(events.length).toBe(1);
    expect(events[0]!.lowAmplitude).toBeUndefined();
    expect(events[0]!.peakSpeed).toBeGreaterThan(0.5);
  });
});

describe("selectTargetEvent", () => {
  const two = proposeStrokeEvents({
    paddleSpeeds: speedBumps([
      { peakMs: 1500, height: 1.9, halfWidthMs: 120 },
      { peakMs: 5000, height: 1.8, halfWidthMs: 120 }, // comparable prominence
    ]),
    wristSpeeds: null,
    clipStartMs: 0,
    clipEndMs: 8000,
  }).events;

  it("declares MULTI_STROKE_AMBIGUOUS for comparable events without a contact anchor", () => {
    const selection = selectTargetEvent(two, null);
    expect(selection.status).toBe("ambiguous");
    if (selection.status !== "ambiguous") return;
    expect(selection.reason).toContain("MULTI_STROKE_AMBIGUOUS");
  });

  it("resolves ambiguity with a contact estimate inside exactly one event", () => {
    const selection = selectTargetEvent(two, 5010);
    expect(selection.status).toBe("selected");
    if (selection.status !== "selected") return;
    expect(selection.event.eventId).toBe("E2");
    expect(selection.via).toBe("contact");
  });

  it("selects decisively more prominent events without an anchor", () => {
    const skewed = proposeStrokeEvents({
      paddleSpeeds: speedBumps([
        { peakMs: 1500, height: 2.4, halfWidthMs: 120 },
        { peakMs: 5000, height: 0.7, halfWidthMs: 120 },
      ]),
      wristSpeeds: null,
      clipStartMs: 0,
      clipEndMs: 8000,
    }).events;
    const selection = selectTargetEvent(skewed, null);
    expect(selection.status).toBe("selected");
    if (selection.status !== "selected") return;
    expect(Math.abs(selection.event.peakMs - 1500)).toBeLessThanOrEqual(60);
  });
});

describe("proposeStrokeEventsV2 (body proposes · paddle confirms — decoupling contract)", () => {
  const wrist = speedBumps([
    { peakMs: 1500, height: 1.8, halfWidthMs: 130 },
    { peakMs: 5000, height: 1.7, halfWidthMs: 130 },
  ]);

  it("the paddle representation can NEVER redefine which movements exist", () => {
    const paddleA = speedBumps([{ peakMs: 1500, height: 2.4, halfWidthMs: 90 }]);
    // A merged/repaired paddle track with a huge peak elsewhere (the measured
    // rally1 failure mode) — proposals must not move.
    const paddleB = speedBumps([{ peakMs: 3200, height: 3.5, halfWidthMs: 90 }]);
    const withA = proposeStrokeEventsV2({
      paddleSpeeds: paddleA,
      wristSpeeds: wrist,
      clipStartMs: 0,
      clipEndMs: 8000,
    });
    const withB = proposeStrokeEventsV2({
      paddleSpeeds: paddleB,
      wristSpeeds: wrist,
      clipStartMs: 0,
      clipEndMs: 8000,
    });
    expect(withA.source).toBe("wrist");
    expect(withB.source).toBe("wrist");
    expect(withA.events.map((event) => [event.startMs, event.endMs])).toEqual(
      withB.events.map((event) => [event.startMs, event.endMs]),
    );
    // No proposal appears at the alien paddle peak.
    expect(withB.events.some((event) => event.startMs <= 3200 && 3200 <= event.endMs)).toBe(false);
  });

  it("a decisive paddle peak inside a body event confirms it and refines the peak", () => {
    const paddle = speedBumps([{ peakMs: 1560, height: 2.6, halfWidthMs: 80 }]);
    const { events } = proposeStrokeEventsV2({
      paddleSpeeds: paddle,
      wristSpeeds: wrist,
      clipStartMs: 0,
      clipEndMs: 8000,
    });
    const first = events.find((event) => event.startMs < 2000)!;
    expect(first.paddleConfirmed).toBe(true);
    expect(Math.abs(first.peakMs - 1560)).toBeLessThanOrEqual(40); // refined toward paddle
    const second = events.find((event) => event.startMs > 4000)!;
    expect(second.paddleConfirmed).toBe(false);
  });

  it("paddle confirmation breaks prominence ties instead of MULTI_STROKE_AMBIGUOUS", () => {
    const paddle = speedBumps([{ peakMs: 5000, height: 2.6, halfWidthMs: 80 }]);
    const { events } = proposeStrokeEventsV2({
      paddleSpeeds: paddle,
      wristSpeeds: wrist,
      clipStartMs: 0,
      clipEndMs: 8000,
    });
    const selection = selectTargetEventV2(events, null);
    expect(selection.status).toBe("selected");
    if (selection.status !== "selected") return;
    expect(selection.via).toBe("paddle_confirmation");
    expect(Math.abs(selection.event.peakMs - 5000)).toBeLessThanOrEqual(60);
  });

  it("falls back to FLAGGED paddle proposals only when body evidence is absent", () => {
    const paddle = speedBumps([{ peakMs: 2000, height: 2.2, halfWidthMs: 100 }]);
    const result = proposeStrokeEventsV2({
      paddleSpeeds: paddle,
      wristSpeeds: null,
      clipStartMs: 0,
      clipEndMs: 8000,
    });
    expect(result.source).toBe("paddle_fallback");
    expect(result.events.length).toBeGreaterThan(0);
    // Penalty relative to the same paddle-only proposal, and no self-confirmation.
    const paddleOnly = proposeStrokeEvents({
      paddleSpeeds: paddle,
      wristSpeeds: null,
      clipStartMs: 0,
      clipEndMs: 8000,
    });
    expect(result.events[0]!.confidence).toBeLessThan(paddleOnly.events[0]!.confidence);
    expect(result.events[0]!.paddleConfirmed).toBe(false);
  });
});

describe("segmentPhasesTemporalV2 (anchor-or-abstain)", () => {
  const speeds = speedBumps([{ peakMs: 1500, height: 2.0, halfWidthMs: 130 }], 0, 3000);
  const event = { startMs: 1100, endMs: 1950 };

  it("segments an anchored event with plausible boundaries", () => {
    const outcome = segmentPhasesTemporalV2({
      event,
      contactMs: 1520,
      paddleSpeeds: speeds,
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("segmented");
    if (outcome.status !== "segmented") return;
    expect(outcome.boundaries.accelerationStartMs).toBeLessThan(1520);
    expect(outcome.boundaries.followThroughEndMs).toBeGreaterThan(1520);
    expect(outcome.boundaries.relative.accelerationStartMs).toBeLessThan(0);
  });

  it("segments WITHOUT a contact anchor when motion evidence is decisive — anchor-free v2.1 (W5), contact boundary explicitly absent", () => {
    const outcome = segmentPhasesTemporalV2({
      event,
      contactMs: null,
      paddleSpeeds: speeds,
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("segmented");
    if (outcome.status !== "segmented") return;
    expect(outcome.boundaries.anchorBasis).toBe("event_peak");
    // No fabricated contact: NaN in-process ⇒ null in the JSON artifact.
    expect(Number.isNaN(outcome.boundaries.contactMs)).toBe(true);
    expect(JSON.parse(JSON.stringify(outcome)).boundaries.contactMs).toBeNull();
  });

  it("abstains when the anchor lies outside the event (wrong-event guard)", () => {
    const outcome = segmentPhasesTemporalV2({
      event,
      contactMs: 2600,
      paddleSpeeds: speeds,
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("abstained");
    if (outcome.status !== "abstained") return;
    expect(outcome.reason).toContain("PHASE_WRONG_EVENT");
  });

  // ORDERING INVARIANT — the cascade-measured held-out defect (followEnd ≤
  // contact under sparse post-contact sampling) must never be emitted again.
  const sparsePostContact = (withPostSamples: boolean) => {
    const series: Array<{ timestampMs: number; value: number }> = [];
    for (let t = 900; t <= 1500; t += 40) series.push({ timestampMs: t, value: 1.6 }); // active up to 1500
    if (withPostSamples) {
      for (let t = 1600; t <= 1720; t += 40) series.push({ timestampMs: t, value: 0.05 }); // quiet after gap
    }
    return series;
  };

  it("repairs follow-through to the first real post-contact observation (never inverted)", () => {
    const outcome = segmentPhasesTemporalV2({
      event,
      contactMs: 1520, // anchor falls inside a sampling gap (nearest sample at 1500)
      paddleSpeeds: sparsePostContact(true),
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("segmented");
    if (outcome.status !== "segmented") return;
    expect(outcome.boundaries.followThroughEndMs).toBeGreaterThan(1520);
  });

  it("abstains when NO samples exist after the contact anchor", () => {
    const outcome = segmentPhasesTemporalV2({
      event,
      contactMs: 1520,
      paddleSpeeds: sparsePostContact(false),
      wristSpeeds: null,
    });
    expect(outcome.status).toBe("abstained");
    if (outcome.status !== "abstained") return;
    expect(outcome.reason).toContain("PHASE_NO_POST_CONTACT_EVIDENCE");
  });
});
