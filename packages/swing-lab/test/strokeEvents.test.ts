import { describe, expect, it } from "vitest";
import { proposeStrokeEvents, selectTargetEvent } from "../src/index.js";
import {
  observedCadence,
  proposeStrokeEventsV2,
  selectTargetEventV2,
} from "../src/strokeEvents.js";
import { segmentPhasesTemporalV2 } from "../src/index.js";
import { buildPlayerTracks, type PeopleFile } from "../src/playerTracker.js";

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

describe("low-amplitude tier (wrist-only compact strokes)", () => {
  // Amplitude floors are defined at the reference cadence (60 fps); these
  // fixtures sample there so "sub-floor" means what the gates say it means.
  const REFERENCE_STEP_MS = 1000 / 60;

  it("admits a sub-floor compact stroke only from wrist, flagged and confidence-penalized", () => {
    const compact = speedBumps(
      [{ peakMs: 2000, height: 0.28, halfWidthMs: 130 }],
      0,
      4000,
      REFERENCE_STEP_MS,
    );
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
    const busy = speedBumps(
      [{ peakMs: 2000, height: 0.2, halfWidthMs: 130 }],
      0,
      4000,
      REFERENCE_STEP_MS,
    ).map((sample) => ({ ...sample, value: sample.value + 0.1 })); // baseline 0.18, peak ≈0.38
    const { events } = proposeStrokeEvents({
      paddleSpeeds: null,
      wristSpeeds: busy,
      clipStartMs: 0,
      clipEndMs: 4000,
    });
    expect(events.length).toBe(0);
  });

  it("scales the floors with the sample interval: the same compact stroke sampled at 30 fps is still proposed", () => {
    const at30 = proposeStrokeEvents({
      paddleSpeeds: null,
      wristSpeeds: speedBumps(
        [{ peakMs: 2000, height: 0.28, halfWidthMs: 130 }],
        0,
        4000,
        1000 / 30,
      ),
      clipStartMs: 0,
      clipEndMs: 4000,
    });
    expect(at30.events.length).toBe(1);
    expect(Math.abs(at30.events[0]!.peakMs - 2000)).toBeLessThanOrEqual(60);
    // Idle motion stays idle at every cadence.
    for (const stepMs of [1000 / 60, 1000 / 30, 1000 / 24]) {
      const idle = proposeStrokeEvents({
        paddleSpeeds: null,
        wristSpeeds: speedBumps([], 0, 4000, stepMs),
        clipStartMs: 0,
        clipEndMs: 4000,
      });
      expect(idle.events.length).toBe(0);
    }
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

/** Deterministic PRNG (same generator as the fps temporal harness). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("XC-CV-3: timestamp-jitter stability of the wrist proposer", () => {
  const NATIVE_INTERVAL_MS = 1000 / 60;
  const bumps = [
    { peakMs: 1500, height: 2.2, halfWidthMs: 140 },
    { peakMs: 4200, height: 0.9, halfWidthMs: 180 },
  ];
  const trueSpeed = (t: number) =>
    bumps.reduce(
      (total, bump) =>
        total + bump.height * Math.exp(-0.5 * ((t - bump.peakMs) / bump.halfWidthMs) ** 2),
      0.08,
    );

  /** A 60 fps camera measures ONE frame interval of wrist displacement per
   * frame; the presentation stamp it lands on wobbles by ±jitterMs (integer
   * ms, as the native capture layer writes them). The finite-difference speed
   * the proposer receives is that displacement over the STAMPED interval —
   * exactly what dominantWristSpeeds computes from a jittered pose file. */
  function stampedWristSpeeds(jitterMs: number, seed: number) {
    const random = mulberry32(seed);
    const series: Array<{ timestampMs: number; value: number }> = [];
    let previousTrueMs = 0;
    let previousStampMs = 0;
    for (let index = 0; index < 360; index += 1) {
      const trueMs = index * NATIVE_INTERVAL_MS;
      const wobble = jitterMs === 0 ? 0 : (random() * 2 - 1) * jitterMs;
      const stampMs = Math.round(trueMs + wobble);
      if (index === 0) {
        series.push({ timestampMs: stampMs, value: trueSpeed(trueMs) });
      } else {
        const displacement = (trueSpeed(trueMs) * (trueMs - previousTrueMs)) / 1000;
        series.push({
          timestampMs: stampMs,
          value: (displacement * 1000) / (stampMs - previousStampMs),
        });
      }
      previousTrueMs = trueMs;
      previousStampMs = stampMs;
    }
    return series;
  }

  const propose = (wristSpeeds: Array<{ timestampMs: number; value: number }>) =>
    proposeStrokeEventsV2({ paddleSpeeds: null, wristSpeeds, clipStartMs: 0, clipEndMs: 6000 })
      .events;

  it("≤2 ms presentation-stamp jitter moves no event bound by more than one native frame interval (20 seeds)", () => {
    const reference = propose(stampedWristSpeeds(0, 0));
    expect(reference.length).toBe(2);
    for (let seed = 1; seed <= 20; seed += 1) {
      const jittered = propose(stampedWristSpeeds(2, seed));
      expect(jittered.length, `seed ${seed} event count`).toBe(reference.length);
      for (const [index, event] of jittered.entries()) {
        const base = reference[index]!;
        expect(
          Math.abs(event.startMs - base.startMs),
          `seed ${seed} E${index + 1} start ${base.startMs} → ${event.startMs}`,
        ).toBeLessThanOrEqual(NATIVE_INTERVAL_MS);
        expect(
          Math.abs(event.endMs - base.endMs),
          `seed ${seed} E${index + 1} end ${base.endMs} → ${event.endMs}`,
        ).toBeLessThanOrEqual(NATIVE_INTERVAL_MS);
      }
    }
  });

  it("an exactly regular grid is re-timed to ITS OWN rate (25 fps is not snapped to 24) — values untouched", () => {
    expect(observedCadence(speedBumps([], 0, 4000, 40))).toEqual({ intervalMs: 40, spreadMs: 0 });
    expect(observedCadence(speedBumps([], 0, 4000, 1000 / 60))?.intervalMs).toBeCloseTo(
      1000 / 60,
      9,
    );
    // Integer-ms stamps of a 59.94 fps capture alternate 16/17 ms: snapped to 60 fps.
    const stamped = Array.from({ length: 200 }, (_, index) => ({
      timestampMs: Math.round(index * (1000 / 59.94)),
      value: 0.1,
    }));
    expect(observedCadence(stamped)).toEqual({ intervalMs: 1000 / 60, spreadMs: 1 });
  });

  it("a genuinely dropped frame is NOT jitter: the doubled interval keeps its measured speed", () => {
    // Two identical series except one frame is missing in the second; the
    // proposer must not "repair" the doubled interval as if it were wobble.
    const full = stampedWristSpeeds(0, 0);
    const dropped = full.filter((_, index) => index !== 90);
    // Speed over the doubled interval = displacement of two frames / 2 intervals.
    dropped[90] = {
      timestampMs: full[91]!.timestampMs,
      value:
        ((full[90]!.value + full[91]!.value) * NATIVE_INTERVAL_MS) /
        (full[91]!.timestampMs - full[89]!.timestampMs),
    };
    const events = propose(dropped);
    expect(events.length).toBe(2);
    expect(Math.abs(events[0]!.peakMs - 1500)).toBeLessThanOrEqual(2 * NATIVE_INTERVAL_MS);
  });
});

describe("XC-CV-4: playerTracker loss periods follow observed cadence, not declared fps", () => {
  /** 24 fps single-person file whose frames 40–41 are two frame intervals
   * apart (one real dropped detection ≈ 83 ms). */
  function peopleFile(declaredFps: number): PeopleFile {
    const interval = 1000 / 24;
    const frames: PeopleFile["frames"] = [];
    for (let index = 0; index < 96; index += 1) {
      if (index === 41) continue;
      const x = 0.4 + index * 0.001;
      frames.push({
        t: Math.round(index * interval),
        p: [
          {
            c: 0.9,
            l: [
              { n: "left_shoulder", x: x - 0.05, y: 0.4, v: 0.9 },
              { n: "right_shoulder", x: x + 0.05, y: 0.4, v: 0.9 },
              { n: "left_hip", x: x - 0.04, y: 0.6, v: 0.9 },
              { n: "right_hip", x: x + 0.04, y: 0.6, v: 0.9 },
            ],
          },
        ],
      });
    }
    return {
      schemaVersion: 1,
      poseModelVersion: "test",
      video: { w: 1080, h: 1920, fps: declaredFps },
      frames,
    };
  }

  it("identical frames with declared fps 12 vs 24 yield the same lossPeriods", () => {
    const at12 = buildPlayerTracks(peopleFile(12));
    const at24 = buildPlayerTracks(peopleFile(24));
    expect(at12.length).toBe(1);
    expect(at24.length).toBe(1);
    expect(at12[0]!.lossPeriods).toEqual(at24[0]!.lossPeriods);
    // The 83 ms hole in a 41.7 ms cadence IS a loss period whatever the header says.
    expect(at24[0]!.lossPeriods.length).toBe(1);
    expect(at12[0]!.lossPeriods.length).toBe(1);
  });

  /** 30 fps capture decimated to 24 fps by dropping every 5th frame (the
   * fps-temporal harness's real, non-synthetic decimation; also what a
   * throttled capture emits): timestamps advance 33,33,33,33,67 ms. One
   * person, present in every frame. Adopted from the round-1 adversary
   * (devin/attack-fix-5ee6b8ea). */
  function decimated30to24(frameCount: number, extraHoleAfter: number | null): PeopleFile {
    const frames: PeopleFile["frames"] = [];
    let sourceIndex = 0;
    for (let index = 0; index < frameCount; index += 1) {
      const x = 0.4 + index * 0.001;
      frames.push({
        t: Math.round((sourceIndex * 1000) / 30),
        p: [
          {
            c: 0.9,
            l: [
              { n: "left_shoulder", x: x - 0.05, y: 0.4, v: 0.9 },
              { n: "right_shoulder", x: x + 0.05, y: 0.4, v: 0.9 },
              { n: "left_hip", x: x - 0.04, y: 0.6, v: 0.9 },
              { n: "right_hip", x: x + 0.04, y: 0.6, v: 0.9 },
            ],
          },
        ],
      });
      sourceIndex += index % 4 === 3 ? 2 : 1;
      if (extraHoleAfter !== null && index === extraHoleAfter) sourceIndex += 3;
    }
    return {
      schemaVersion: 1,
      poseModelVersion: "test",
      video: { w: 1080, h: 1920, fps: 24 },
      frames,
    };
  }

  it("a person detected in every frame of a 30→24 fps decimated file (33,33,33,33,67 ms cadence) has no loss periods", () => {
    const tracks = buildPlayerTracks(decimated30to24(96, null));
    expect(tracks.length).toBe(1);
    expect(tracks[0]!.frames.length).toBe(96);
    expect(tracks[0]!.lossPeriods, JSON.stringify(tracks[0]!.lossPeriods.slice(0, 5))).toEqual([]);
  });

  it("on the same irregular cadence a genuine three-frame hole (≈133 ms) is still exactly one loss period", () => {
    const file = decimated30to24(96, 50);
    expect(file.frames[51]!.t - file.frames[50]!.t).toBeGreaterThanOrEqual(133);
    const tracks = buildPlayerTracks(file);
    expect(tracks.length).toBe(1);
    expect(tracks[0]!.lossPeriods).toEqual([
      { fromMs: file.frames[50]!.t, toMs: file.frames[51]!.t },
    ]);
  });

  it("a person missing from a frame in which ANOTHER person was detected is a loss period even when the stamp gap looks like cadence", () => {
    const file = decimated30to24(96, null);
    // Replace the sole person in frame 41 by a far-away second person and keep
    // the frame: the track skips a file frame — a real loss — although the
    // 40→42 stamp gap (66 ms) equals the cadence's own long interval.
    expect(file.frames[42]!.t - file.frames[40]!.t).toBeLessThanOrEqual(67);
    const other = file.frames[41]!.p[0]!;
    file.frames[41]!.p = [
      {
        c: 0.9,
        l: other.l.map((joint) => ({ ...joint, x: joint.x + 0.4 })),
      },
    ];
    const tracks = buildPlayerTracks(file);
    const main = tracks.find((track) => track.frames.length === 95);
    expect(main).toBeDefined();
    expect(main!.lossPeriods.length).toBe(1);
    expect(main!.lossPeriods[0]!.fromMs).toBe(file.frames[40]!.t);
    expect(main!.lossPeriods[0]!.toMs).toBe(file.frames[42]!.t);
  });
});
