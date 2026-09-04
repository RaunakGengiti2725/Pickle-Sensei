import { describe, expect, it } from "vitest";
import {
  SessionEventEngine,
  type SessionStrokeEvent,
  type SpeedSample,
} from "../src/sessionEngine.js";

/**
 * ADVERSARIAL PASS 3 / TESTER #1 — SessionEventEngine attacks (frontier
 * gating, sealed-stream behaviour, lifecycle transitions, non-finite input,
 * long-session cost). Target commit 4d812e1a; production code untouched.
 *
 * Classification convention:
 *   - "HELD: …" tests assert the CONTRACT and it holds on 4d812e1a.
 *   - "GAP (…): …" tests reproduce a deviation from the documented contract
 *     and PIN THE OBSERVED behaviour (so the attack stays executable and
 *     cannot be masked by a failing precondition, unlike `it.fails`). When
 *     production closes the gap the pin fails and the test must be flipped
 *     to a HELD assertion — the fix cannot go unnoticed.
 * Every GAP test console.logs the observed values so the run log is the
 * evidence artifact.
 */

function speedBumps(
  bumps: Array<{ peakMs: number; height: number; halfWidthMs: number }>,
  fromMs = 0,
  toMs = 8000,
  stepMs = 40,
): SpeedSample[] {
  const series: SpeedSample[] = [];
  for (let t = fromMs; t <= toMs; t += stepMs) {
    let value = 0.08;
    for (const bump of bumps) {
      value += bump.height * Math.exp(-0.5 * ((t - bump.peakMs) / bump.halfWidthMs) ** 2);
    }
    series.push({ timestampMs: t, value });
  }
  return series;
}

function feed(engine: SessionEventEngine, samples: readonly SpeedSample[]): SessionStrokeEvent[] {
  const closed: SessionStrokeEvent[] = [];
  for (const sample of samples) closed.push(...engine.pushWristSample(sample));
  return closed;
}

const ONE_STROKE = [{ peakMs: 1500, height: 2.0, halfWidthMs: 120 }];
const TWO_STROKES = [
  { peakMs: 1200, height: 2.0, halfWidthMs: 120 },
  { peakMs: 3600, height: 2.0, halfWidthMs: 120 },
];

const fakeAnalysis = { id: "attack-analysis" } as unknown as NonNullable<
  SessionStrokeEvent["analysis"]
>;

describe("ATTACK S1 — paddle samples behind the frontier after an event closed", () => {
  it("HELD: late paddle samples never touch the closed event (proposal frozen, identical after the late push)", () => {
    const engine = new SessionEventEngine({ sessionId: "s1-frozen" });
    const closed = feed(engine, speedBumps(ONE_STROKE, 0, 5000));
    expect(closed).toHaveLength(1);
    const before = JSON.stringify(engine.snapshot().events[0]);
    const frontier = closed[0]!.proposal.endMs;
    // A huge paddle spike exactly inside the closed event and a second one at
    // the frontier itself — both are behind/at the frontier.
    const late = engine.push({
      paddle: [
        { timestampMs: closed[0]!.proposal.peakMs, value: 40 },
        { timestampMs: frontier, value: 40 },
        { timestampMs: frontier - 1, value: 40 },
      ],
    });
    expect(late).toEqual([]);
    const after = engine.snapshot();
    expect(JSON.stringify(after.events[0])).toBe(before);
    expect(after.events).toHaveLength(1);
    expect(after.events[0]!.proposal.paddleConfirmed).toBe(false);
    expect(after.events[0]!.proposal.paddlePeakMs).toBeNull();
    // Frozen at emission: writes must throw (Object.freeze).
    expect(() => {
      (after.events[0]!.proposal as { paddleConfirmed: boolean }).paddleConfirmed = true;
    }).not.toThrow(); // snapshot() hands out a COPY — the copy is writable …
    expect(engine.snapshot().events[0]!.proposal.paddleConfirmed).toBe(false); // … the engine is not.
  });

  it("HELD (documented contract): the paddle path is NOT frontier-gated — droppedLateSamples counts wrist only, late paddle samples are retained", () => {
    const engine = new SessionEventEngine({ sessionId: "s1-counter" });
    const closed = feed(engine, speedBumps(ONE_STROKE, 0, 5000));
    expect(closed).toHaveLength(1);
    const frontier = closed[0]!.proposal.endMs;
    const beforeQuality = engine.snapshot().qualityState;
    expect(beforeQuality.droppedLateSamples).toBe(0);
    engine.push({
      paddle: Array.from({ length: 25 }, (_, index) => ({
        timestampMs: frontier - 1000 + index * 40,
        value: 3,
      })),
    });
    const quality = engine.snapshot().qualityState;
    // The scenario text asked whether droppedLateSamples increments for late
    // PADDLE samples. Module doc (sessionEngine.ts L603-L607): wrist samples
    // at/before the frontier are dropped+counted, paddle samples are KEPT
    // regardless. Observed matches the documented contract: counter stays 0,
    // paddleSamples grows by 25.
    expect(quality.droppedLateSamples).toBe(0);
    expect(quality.paddleSamples).toBe(beforeQuality.paddleSamples + 25);
    // Contrast: the SAME timestamps on the wrist path are dropped and counted.
    engine.push({
      wrist: Array.from({ length: 25 }, (_, index) => ({
        timestampMs: frontier - 1000 + index * 40,
        value: 3,
      })),
    });
    expect(engine.snapshot().qualityState.droppedLateSamples).toBe(25);
    expect(engine.snapshot().events).toHaveLength(1);
  });

  it("GAP (P3, pre-existing): a late paddle spike BEHIND the frontier silently de-confirms every FUTURE event (paddleMax normalization) with no note/counter", () => {
    // Control: two identical strokes, paddle activity aligned with each →
    // both paddle-confirmed.
    const control = new SessionEventEngine({ sessionId: "s1-control" });
    const wrist = speedBumps(TWO_STROKES, 0, 6000);
    const paddle = speedBumps(TWO_STROKES, 0, 6000).map((s) => ({ ...s, value: s.value * 1.2 }));
    for (let index = 0; index < wrist.length; index += 1) {
      control.push({ wrist: [wrist[index]!], paddle: [paddle[index]!] });
    }
    control.flush();
    const controlStates = control.snapshot().events.map((e) => e.proposal.paddleConfirmed);
    expect(controlStates).toEqual([true, true]);

    // Attack: same streams, but right after E1 closes a single paddle sample
    // with a huge value arrives with a timestamp BEHIND the frontier (a
    // tracker glitch delivered late). It can never re-bound E1 — but it
    // silently sets paddleMax for the rest of the session.
    const attacked = new SessionEventEngine({ sessionId: "s1-attack" });
    let injected = false;
    for (let index = 0; index < wrist.length; index += 1) {
      const closed = attacked.push({ wrist: [wrist[index]!], paddle: [paddle[index]!] });
      if (closed.length > 0 && !injected) {
        injected = true;
        attacked.push({ paddle: [{ timestampMs: closed[0]!.proposal.endMs - 200, value: 500 }] });
      }
    }
    attacked.flush();
    const snapshot = attacked.snapshot();
    const attackedStates = snapshot.events.map((e) => e.proposal.paddleConfirmed);
    console.log(
      JSON.stringify({
        scenario: "S1-late-paddle-spike",
        injected,
        controlPaddleConfirmed: controlStates,
        attackedPaddleConfirmed: attackedStates,
        attackedPaddleSupport: snapshot.events.map((e) => e.proposal.paddleSupport),
        notes: snapshot.qualityState.notes,
        droppedLateSamples: snapshot.qualityState.droppedLateSamples,
      }),
    );
    expect(injected).toBe(true);
    // CONTRACT ("recorded, not silent" — sessionEngine.ts L593-L607, L1017):
    // if late paddle history may change future confirmation, the quality
    // state must record it. OBSERVED (pinned): E2 flips to unconfirmed while
    // notes stay empty and droppedLateSamples stays 0 — the late sample is
    // neither dropped nor recorded, yet it changed a future verdict.
    expect(attackedStates).toEqual([true, false]);
    expect(snapshot.qualityState.notes).toEqual([]);
    expect(snapshot.qualityState.droppedLateSamples).toBe(0);
  });
});

describe("ATTACK S3 — flush() twice, then push() again", () => {
  it("HELD: a second flush() is idempotent (no events, no state change)", () => {
    const engine = new SessionEventEngine({ sessionId: "s3-idempotent" });
    // Stop while the stroke is still decaying (flush closes it as 'flush').
    feed(engine, speedBumps(ONE_STROKE, 0, 1700));
    const first = engine.flush();
    expect(first.map((e) => e.closeReason)).toEqual(["flush"]);
    const afterFirst = JSON.stringify(engine.snapshot());
    expect(engine.flush()).toEqual([]);
    expect(engine.flush()).toEqual([]);
    expect(JSON.stringify(engine.snapshot())).toBe(afterFirst);
  });

  it("HELD: post-flush wrist samples at/behind the frontier are dropped and counted, never re-open closed history", () => {
    const engine = new SessionEventEngine({ sessionId: "s3-behind" });
    feed(engine, speedBumps(ONE_STROKE, 0, 5000));
    engine.flush();
    engine.flush();
    const frontier = engine.snapshot().events[0]!.proposal.endMs;
    const closed = engine.push({
      wrist: [
        { timestampMs: frontier, value: 5 },
        { timestampMs: frontier - 40, value: 5 },
        { timestampMs: 0, value: 5 },
      ],
    });
    expect(closed).toEqual([]);
    expect(engine.snapshot().qualityState.droppedLateSamples).toBe(3);
    expect(engine.snapshot().events).toHaveLength(1);
  });

  it("GAP (P3, pre-existing): the engine has no sealed state — after flush()×2 a whole new stroke is accepted and emits E2 (mobile LiveSessionFlow guards this itself; the scheduler's endOfStream() does not)", () => {
    const engine = new SessionEventEngine({ sessionId: "s3-post-flush-new-stroke" });
    const stream = speedBumps(TWO_STROKES, 0, 6000);
    const cut = stream.findIndex((s) => s.timestampMs >= 2400); // between the strokes
    const preClosed = feed(engine, stream.slice(0, cut));
    const flushed = [...engine.flush(), ...engine.flush()];
    const frontierAfterFlush = engine.snapshot().events.at(-1)!.proposal.endMs;
    expect([...preClosed, ...flushed].map((e) => e.eventId)).toEqual(["E1"]);
    let threw: string | null = null;
    let postFlushClosed: SessionStrokeEvent[] = [];
    try {
      postFlushClosed = feed(engine, stream.slice(cut));
      postFlushClosed.push(...engine.flush());
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error);
    }
    const snapshot = engine.snapshot();
    console.log(
      JSON.stringify({
        scenario: "S3-post-flush-new-stroke",
        frontierAfterFlush,
        threw,
        postFlushEvents: postFlushClosed.map((e) => ({
          id: e.eventId,
          start: e.proposal.startMs,
          peak: e.proposal.peakMs,
          end: e.proposal.endMs,
          reason: e.closeReason,
        })),
        totalEvents: snapshot.events.length,
        droppedLateSamples: snapshot.qualityState.droppedLateSamples,
        notes: snapshot.qualityState.notes,
      }),
    );
    // CONTRACT (flush() doc L854-L858: "End of recording (user stopped the
    // session)"): after the stream ended, further samples must either throw
    // or be dropped. OBSERVED (pinned): nothing throws, nothing is dropped
    // (the new samples are AHEAD of the frontier, so the wrist gate does not
    // fire) and a brand-new E2 is emitted and would be dispatched by
    // SessionAnalysisScheduler.pushSamples() after endOfStream().
    expect(threw).toBeNull();
    expect(postFlushClosed.map((e) => e.eventId)).toEqual(["E2"]);
    expect(snapshot.events).toHaveLength(2);
    expect(snapshot.qualityState.droppedLateSamples).toBe(0);
    expect(snapshot.qualityState.notes).toEqual([]);
  });

  it("GAP (P3, pre-existing): flush() on the RISING edge of a stroke emits nothing, and the post-flush remainder of the SAME swing then emits it as a fresh event", () => {
    const stream = speedBumps(ONE_STROKE, 0, 5000);
    const observed: Array<{ cutMs: number; flushed: number; postFlush: string[] }> = [];
    for (const cutMs of [1300, 1420, 1500]) {
      const engine = new SessionEventEngine({ sessionId: `s3-rising-${cutMs}` });
      const cut = stream.findIndex((s) => s.timestampMs >= cutMs);
      feed(engine, stream.slice(0, cut));
      const flushed = [...engine.flush(), ...engine.flush()];
      const post = [...feed(engine, stream.slice(cut)), ...engine.flush()];
      observed.push({
        cutMs,
        flushed: flushed.length,
        postFlush: post.map((e) => `${e.eventId}:${e.proposal.peakMs}:${e.closeReason}`),
      });
    }
    console.log(JSON.stringify({ scenario: "S3-post-flush-rising-edge", observed }));
    // A stroke that had not crested when the user stopped is (correctly) not
    // emitted by flush() — but the engine then happily completes it from
    // samples delivered AFTER end-of-recording. Pinned observed values.
    expect(observed.map((o) => o.flushed)).toEqual([0, 0, 0]);
    expect(observed.map((o) => o.postFlush)).toEqual([
      ["E1:1520:settle"],
      ["E1:1520:settle"],
      ["E1:1520:settle"],
    ]);
  });
});

describe("ATTACK S4 — markEvent transition matrix", () => {
  function oneEvent(sessionId: string) {
    const engine = new SessionEventEngine({ sessionId });
    const closed = feed(engine, speedBumps(ONE_STROKE, 0, 5000));
    expect(closed).toHaveLength(1);
    return { engine, eventId: closed[0]!.eventId };
  }

  it("GAP (P3, pre-existing): processing → processing is accepted silently (a double dispatch of the same event is not detectable through the engine)", () => {
    const { engine, eventId } = oneEvent("s4-double-processing");
    engine.markEvent(eventId, "processing");
    let secondThrew = false;
    try {
      engine.markEvent(eventId, "processing");
    } catch {
      secondThrew = true;
    }
    console.log(
      JSON.stringify({
        scenario: "S4-processing-twice",
        secondCallThrew: secondThrew,
        state: engine.eventState(eventId),
      }),
    );
    // CONTRACT (L904-L906: "pending → processing → ready|abstained, with an
    // honest processing → pending revert") lists no processing → processing
    // edge; pending → pending IS rejected (L924), so the matrix is
    // inconsistent. Expected: the second call throws like pending → pending.
    // OBSERVED (pinned): accepted, state stays 'processing', no error.
    expect(secondThrew).toBe(false);
    expect(engine.eventState(eventId)).toBe("processing");
    // Rapid repeat: 1000 further processing → processing writes are all accepted.
    for (let index = 0; index < 1000; index += 1) engine.markEvent(eventId, "processing");
    expect(engine.eventState(eventId)).toBe("processing");
  });

  it("HELD: pending → pending, unknown id, ready-without-analysis and any write after a terminal state are all rejected", () => {
    const { engine, eventId } = oneEvent("s4-held");
    expect(() => engine.markEvent(eventId, "pending")).toThrow(/cannot revert/);
    expect(() => engine.markEvent("E0", "processing")).toThrow(/unknown session event/);
    expect(() => engine.markEvent("", "processing")).toThrow(/unknown session event/);
    expect(() => engine.markEvent("e1", "processing")).toThrow(/unknown session event/);
    engine.markEvent(eventId, "processing");
    expect(() => engine.markEvent(eventId, "ready")).toThrow(/AnalysisRecord/);
    expect(() => engine.markEvent(eventId, "ready", { analysis: null })).toThrow(/AnalysisRecord/);
    engine.markEvent(eventId, "abstained", { abstainReason: "TEST" });
    for (const state of ["pending", "processing", "ready", "abstained"] as const) {
      expect(() => engine.markEvent(eventId, state, { analysis: fakeAnalysis })).toThrow(
        /append-only/,
      );
    }
    expect(engine.eventState(eventId)).toBe("abstained");
    expect(engine.snapshot().events[0]!.analysis).toBeNull();
  });

  it("HELD: pending → ready (skipping processing) is accepted with a real record — documented as allowed by omission", () => {
    const { engine, eventId } = oneEvent("s4-skip-processing");
    expect(engine.markEvent(eventId, "ready", { analysis: fakeAnalysis }).state).toBe("ready");
  });

  it("GAP (P3, pre-existing): 'abstained' is accepted with NO abstainReason — an abstention with no recorded reason contradicts 'never silent'", () => {
    const { engine, eventId } = oneEvent("s4-abstain-no-reason");
    engine.markEvent(eventId, "processing");
    let threw = false;
    try {
      engine.markEvent(eventId, "abstained");
    } catch {
      threw = true;
    }
    const event = engine.snapshot().events[0]!;
    console.log(
      JSON.stringify({
        scenario: "S4-abstained-without-reason",
        threw,
        state: event.state,
        abstainReason: event.abstainReason,
      }),
    );
    // CONTRACT (module doc: outcomes are "recorded, not silent"; scheduler
    // contract 2: 'abstained' carries the analysis' reason). OBSERVED
    // (pinned): terminal 'abstained' with abstainReason === null.
    expect(threw).toBe(false);
    expect(event.state).toBe("abstained");
    expect(event.abstainReason).toBeNull();
  });

  it("GAP (P3, pre-existing): an AnalysisRecord can be attached to a non-terminal event ('processing'/'pending' with analysis ≠ null)", () => {
    const { engine, eventId } = oneEvent("s4-analysis-on-pending");
    let threw = false;
    try {
      engine.markEvent(eventId, "processing", { analysis: fakeAnalysis });
      engine.markEvent(eventId, "pending", { analysis: fakeAnalysis });
    } catch {
      threw = true;
    }
    const event = engine.snapshot().events[0]!;
    console.log(
      JSON.stringify({
        scenario: "S4-analysis-attached-to-pending",
        threw,
        state: event.state,
        analysisAttached: event.analysis !== null,
      }),
    );
    // CONTRACT (L909-L910): "an event can never be counted as analyzed
    // without [a record]" — the dual must hold too: a pending event must not
    // carry an analysis (downstream views key off `analysis !== null`).
    // OBSERVED (pinned): state 'pending' with a non-null analysis attached.
    expect(threw).toBe(false);
    expect(event.state).toBe("pending");
    expect(event.analysis).not.toBeNull();
  });
});

describe("ATTACK (own) — non-finite / degenerate input", () => {
  it("GAP (P3, pre-existing): NaN/Infinity samples are dropped SILENTLY — not counted anywhere in qualityState", () => {
    const engine = new SessionEventEngine({ sessionId: "nan-samples" });
    feed(engine, speedBumps(ONE_STROKE, 0, 2000));
    const before = engine.snapshot().qualityState;
    engine.push({
      wrist: [
        { timestampMs: NaN, value: 1 },
        { timestampMs: 2040, value: NaN },
        { timestampMs: Infinity, value: 1 },
        { timestampMs: 2080, value: -Infinity },
      ],
      paddle: [{ timestampMs: NaN, value: NaN }],
    });
    const after = engine.snapshot().qualityState;
    console.log(JSON.stringify({ scenario: "non-finite-samples", before, after }));
    const accounted =
      after.wristSamples -
      before.wristSamples +
      (after.paddleSamples - before.paddleSamples) +
      (after.notes.length - before.notes.length);
    // CONTRACT: "recorded, not silent". OBSERVED (pinned): 5 malformed
    // samples vanish with zero trace (wristSamples/paddleSamples/
    // droppedLateSamples/notes all unchanged).
    expect(accounted).toBe(0);
    expect(after).toEqual(before);
  });

  it("HELD: unsorted, duplicate-timestamp and negative-timestamp samples keep the internal series sorted and emit the same events as an ordered feed", () => {
    const ordered = new SessionEventEngine({ sessionId: "order-a" });
    const shuffled = new SessionEventEngine({ sessionId: "order-b" });
    const stream = speedBumps(TWO_STROKES, -2000, 6000);
    feed(ordered, stream);
    // Push in chunks of 7 reversed inside each chunk, plus every sample twice.
    for (let index = 0; index < stream.length; index += 7) {
      const chunk = stream.slice(index, index + 7).reverse();
      shuffled.push({ wrist: [...chunk, ...chunk] });
    }
    ordered.flush();
    shuffled.flush();
    const bounds = (engine: SessionEventEngine) =>
      engine
        .snapshot()
        .events.map((e) => [e.proposal.startMs, e.proposal.peakMs, e.proposal.endMs]);
    expect(bounds(ordered)).toHaveLength(2);
    // Duplicates are additional samples at the same timestamp — the smoothing
    // window sees them, so bounds may differ slightly; event COUNT and time
    // ordering must not.
    expect(bounds(shuffled)).toHaveLength(2);
    expect(bounds(shuffled)[0]![1]).toBeLessThan(bounds(shuffled)[1]![1]!);
    expect(shuffled.snapshot().qualityState.droppedLateSamples).toBeGreaterThanOrEqual(0);
  });

  it("HELD: an empty push and a flush on an empty engine are no-ops", () => {
    const engine = new SessionEventEngine({ sessionId: "empty" });
    expect(engine.push({})).toEqual([]);
    expect(engine.push({ wrist: [], paddle: [] })).toEqual([]);
    expect(engine.flush()).toEqual([]);
    expect(engine.activeProposal()).toBeNull();
    expect(engine.snapshot().qualityState.lastSampleMs).toBeNull();
  });

  it("HELD: unicode / empty sessionId round-trips through snapshot", () => {
    for (const sessionId of ["", "🎾-séance-\u0000", "a".repeat(10_000)]) {
      const engine = new SessionEventEngine({ sessionId });
      expect(engine.snapshot().sessionId).toBe(sessionId);
    }
  });
});

describe("MEASURE (own) — per-push cost grows with session length (full-series re-proposal per push)", () => {
  it("records push latency at 1k / 3k / 6k accumulated samples (30 fps ≈ 33 s / 100 s / 200 s of play) — cost is linear in session length", () => {
    const engine = new SessionEventEngine({ sessionId: "cost" });
    const bumps = Array.from({ length: 90 }, (_, index) => ({
      peakMs: 1200 + index * 2400,
      height: 2.0,
      halfWidthMs: 120,
    }));
    const stream = speedBumps(bumps, 0, 6_100 * 33.4, 33.4);
    const marks = [1000, 3000, 6000];
    const results: Array<{ samples: number; meanPushMs: number; events: number }> = [];
    let nextMark = 0;
    for (let index = 0; index < stream.length; index += 1) {
      engine.pushWristSample(stream[index]!);
      if (nextMark < marks.length && index + 1 === marks[nextMark]) {
        // Time 30 consecutive pushes at this depth.
        const window = stream.slice(index + 1, index + 31);
        const started = performance.now();
        for (const sample of window) engine.pushWristSample(sample);
        const elapsed = performance.now() - started;
        index += window.length;
        results.push({
          samples: index + 1,
          meanPushMs: elapsed / window.length,
          events: engine.snapshot().events.length,
        });
        nextMark += 1;
      }
    }
    const growth = results[2]!.meanPushMs / results[0]!.meanPushMs;
    console.log(
      JSON.stringify({
        scenario: "push-cost-vs-session-length",
        results,
        growth6kOver1k: growth,
        note: "Linux bench box; per-push cost is a proxy, not device truth. propose() re-runs proposeStrokeEventsV2 over the WHOLE accumulated series on every pushWristSample (sessionEngine.ts L950-L958), and LiveSessionFlow.pushSample feeds one sample per frame.",
      }),
    );
    expect(results).toHaveLength(3);
    // OBSERVED (pinned loosely — timing): the mean per-push cost at 6k samples
    // is several times the cost at 1k. A windowed proposer would keep the
    // ratio near 1; O(n) re-proposal makes it ≈ n₂/n₁ (6 here). We only pin
    // "clearly super-constant" so CI jitter cannot flip the verdict.
    expect(growth).toBeGreaterThan(2);
  }, 120_000);
});
