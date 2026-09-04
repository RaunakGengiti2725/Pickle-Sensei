import { describe, expect, it } from "vitest";
import { generateSwingSequence } from "@pickle/evaluation";
import { classifyStroke } from "../src/index.js";
import { selectTargetEventV2, type StrokeEventProposalV2 } from "../src/strokeEvents.js";

/**
 * Adversarial regression test against b15a7d1a (stroke-heuristic-8).
 *
 * `analyzeVideo` (packages/swing-lab/src/analyzeVideo.ts, "5d. Stroke
 * recognition — EVENT-LOCAL") hands `classifyStroke` the selected event's
 * bounds as the classification window and the fused contact estimate as
 * `contactMs`. `selectTargetEventV2` treats a contact estimate that lands
 * within ±60 ms of an event's bounds as belonging to that event (selected
 * `via: "contact"`, NOT `contactOrphaned`). The candidate's new
 * `contact_outside_window` guard is strict (`contactMs > windowEndMs`), so
 * the two contracts disagree on the 1..60 ms band: the pipeline says "this
 * contact belongs to this event", the classifier now abstains on it.
 *
 * On 4d812e1a this input committed FOREHAND at 0.8 (the same result the
 * unmodified window produces); on b15a7d1a it returns UNKNOWN with
 * limiting factor `contact_outside_window`.
 */
function eventEndingBeforeContact(
  startMs: number,
  contactMs: number,
  gapMs: number,
): StrokeEventProposalV2 {
  return {
    eventId: "E1",
    startMs,
    peakMs: contactMs - gapMs - 10,
    endMs: contactMs - gapMs,
    peakSpeed: 2,
    prominence: 3,
    source: "wrist",
    confidence: 0.9,
    paddleConfirmed: false,
    paddlePeakMs: null,
    paddleSupport: 0,
  };
}

describe("event-local classification honours selectTargetEvent's ±60 ms contact tolerance", () => {
  const { sequence, window } = generateSwingSequence();
  const contactMs = window.peakMs;

  const reference = classifyStroke({
    sequence,
    window: { startMs: window.startMs, endMs: window.endMs },
    contactMs,
    eventPeakMs: contactMs,
    handedness: "right",
    paddle: null,
    paddleSpeeds: null,
    wristSpeeds: null,
  });

  it.each([1, 20, 40, 60])(
    "contact %d ms past the selected event's end still commits the side the full window commits",
    (gapMs) => {
      const event = eventEndingBeforeContact(window.startMs, contactMs, gapMs);
      const selection = selectTargetEventV2([event], contactMs);
      expect(selection.status).toBe("selected");
      if (selection.status !== "selected") return;
      // The pipeline's own contract: this contact BELONGS to this event.
      expect(selection.via).toBe("contact");
      expect(selection.contactOrphaned).toBeUndefined();

      // Exactly what analyzeVideo passes downstream.
      const prediction = classifyStroke({
        sequence,
        window: { startMs: selection.event.startMs, endMs: selection.event.endMs },
        contactMs,
        eventPeakMs: selection.event.peakMs,
        handedness: "right",
        paddle: null,
        paddleSpeeds: null,
        wristSpeeds: null,
      });

      expect(prediction.limitingFactors).not.toContain("contact_outside_window");
      expect(prediction.label).toBe(reference.label);
      expect(prediction.confidence).toBe(reference.confidence);
    },
  );
});
