import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { detectOfflineStrokeWindow } from "@pickle/vision-geometry";
import { REPO_ROOT } from "../src/engine/corpus.js";
import {
  dominantWristSpeeds,
  EVENT_CONTEXT_PAD_MS,
  MIN_DETECT_SPAN_MS,
  planDetectSpanHull,
  planDetectSpanSegments,
  segmentsCoverageMs,
  type SpanSegment,
} from "../src/detectSpanPlan.js";
import { buildPlayerTracks, targetPoseSequence, type PeopleFile } from "../src/playerTracker.js";
import { proposeStrokeEventsV2 } from "../src/strokeEvents.js";
import type { StrokeEventLabel, SwingAnnotation } from "../src/annotationSchema.js";

const PB = join(REPO_ROOT, "datasets/paddle-bench");
const HELD_OUT = new Set(["wm-dink-01", "afn-vic-rally1"]);

/** Exact pre-refactor detect-span math from analyzeVideo.ts (regression oracle). */
function legacyDetectSpan(
  strokeWindow: SpanSegment,
  events: Array<{ startMs: number; endMs: number }>,
): SpanSegment {
  if (events.length === 0) return { startMs: strokeWindow.startMs, endMs: strokeWindow.endMs };
  let startMs = Math.min(...events.map((event) => event.startMs)) - EVENT_CONTEXT_PAD_MS;
  let endMs = Math.max(...events.map((event) => event.endMs)) + EVENT_CONTEXT_PAD_MS;
  const deficit = MIN_DETECT_SPAN_MS - (endMs - startMs);
  if (deficit > 0) {
    startMs -= deficit / 2;
    endMs += deficit / 2;
  }
  return {
    startMs: Math.max(strokeWindow.startMs, startMs),
    endMs: Math.min(strokeWindow.endMs, endMs),
  };
}

function covered(segments: readonly SpanSegment[], tMs: number): boolean {
  return segments.some((segment) => tMs >= segment.startMs && tMs <= segment.endMs);
}

describe("planDetectSpanHull — legacy regression", () => {
  const strokeWindow = { startMs: 1000, endMs: 20000 };
  it("matches the exact legacy math on representative event sets", () => {
    const cases: Array<Array<{ startMs: number; endMs: number }>> = [
      [],
      [{ startMs: 5000, endMs: 5200 }],
      [
        { startMs: 3000, endMs: 3400 },
        { startMs: 15000, endMs: 15600 },
      ],
      [{ startMs: 1100, endMs: 1200 }], // floor pushes past window start → clamp
      [{ startMs: 19500, endMs: 19900 }], // clamp at window end
      [
        { startMs: 4000, endMs: 4500 },
        { startMs: 4600, endMs: 5100 },
        { startMs: 5300, endMs: 6000 },
      ],
    ];
    for (const events of cases) {
      expect(planDetectSpanHull(strokeWindow, events)).toEqual(
        legacyDetectSpan(strokeWindow, events),
      );
    }
  });
});

describe("planDetectSpanSegments — tight windowing", () => {
  const strokeWindow = { startMs: 0, endMs: 30000 };

  it("no events → single segment identical to the stroke window (hull fallback)", () => {
    expect(planDetectSpanSegments(strokeWindow, [])).toEqual([strokeWindow]);
  });

  it("single event → identical to the hull span (no behavior change)", () => {
    const events = [{ startMs: 5000, endMs: 5300 }];
    expect(planDetectSpanSegments(strokeWindow, events)).toEqual([
      planDetectSpanHull(strokeWindow, events),
    ]);
  });

  it("close events merge into one segment identical to the hull", () => {
    const events = [
      { startMs: 5000, endMs: 5300 },
      { startMs: 5600, endMs: 6000 },
    ];
    expect(planDetectSpanSegments(strokeWindow, events)).toEqual([
      planDetectSpanHull(strokeWindow, events),
    ]);
  });

  it("distant events → disjoint segments, subset of hull, quantified savings", () => {
    const events = [
      { startMs: 3000, endMs: 3400 },
      { startMs: 25000, endMs: 25600 },
    ];
    const hull = planDetectSpanHull(strokeWindow, events);
    const segments = planDetectSpanSegments(strokeWindow, events);
    expect(segments).toHaveLength(2);
    for (const segment of segments) {
      expect(segment.startMs).toBeGreaterThanOrEqual(hull.startMs);
      expect(segment.endMs).toBeLessThanOrEqual(hull.endMs);
      expect(segment.endMs - segment.startMs).toBeGreaterThanOrEqual(MIN_DETECT_SPAN_MS);
    }
    expect(segments[1]!.startMs).toBeGreaterThan(segments[0]!.endMs);
    const savedMs = hull.endMs - hull.startMs - segmentsCoverageMs(segments);
    // hull ≈ 23.8s, segments 2×1.5..1.6s → ~20s of inter-event dead time saved
    expect(savedMs).toBeGreaterThan(19000);
  });

  it("every event keeps its full context pad (or the hull clamp the legacy span had)", () => {
    const events = [
      { startMs: 2000, endMs: 2300 },
      { startMs: 20000, endMs: 20500 },
    ];
    const hull = planDetectSpanHull(strokeWindow, events);
    const segments = planDetectSpanSegments(strokeWindow, events);
    for (const event of events) {
      const wantStart = Math.max(hull.startMs, event.startMs - EVENT_CONTEXT_PAD_MS);
      const wantEnd = Math.min(hull.endMs, event.endMs + EVENT_CONTEXT_PAD_MS);
      expect(covered(segments, wantStart)).toBe(true);
      expect(covered(segments, wantEnd)).toBe(true);
      expect(covered(segments, event.startMs)).toBe(true);
      expect(covered(segments, event.endMs)).toBe(true);
    }
  });
});

/**
 * GOLD-BOUNDARY CLIP GATE (automatic fail): replay the REAL pipeline pre-pass
 * (committed people.json → target → stroke window → wrist speeds →
 * proposeStrokeEventsV2 → span plan) on every committed wave-a development
 * case, then require that every gold event boundary the LEGACY hull covered
 * is also covered by the tight segments. Any clipped gold start/end fails.
 */
describe("tight windows never clip a gold event boundary (wave-a dev cases)", () => {
  const boundsPath = join(PB, "event-bounds-wave-a.json");
  const cases = existsSync(boundsPath)
    ? (
        JSON.parse(readFileSync(boundsPath, "utf8")) as {
          cases: Array<{ id: string; labels: string; runDir: string; role?: string }>;
        }
      ).cases.filter((entry) => entry.role === "development")
    : [];

  it("uses only development cases (held-out untouched)", () => {
    expect(cases.length).toBeGreaterThan(0);
    for (const entry of cases) expect(HELD_OUT.has(entry.id)).toBe(false);
  });

  it.each(cases.map((entry) => [entry.id, entry] as const))(
    "%s: tight segments cover every hull-covered gold boundary",
    (_id, benchCase) => {
      const annotation = JSON.parse(
        readFileSync(resolve(PB, benchCase.labels), "utf8"),
      ) as SwingAnnotation & { eventLabels?: StrokeEventLabel[] };
      const goldEvents = (annotation.eventLabels ?? []).filter((entry) => entry.owner === "target");
      expect(goldEvents.length).toBeGreaterThan(0);
      const people = JSON.parse(
        readFileSync(resolve(PB, benchCase.runDir, "people.json"), "utf8"),
      ) as PeopleFile;
      const tracks = buildPlayerTracks(people);
      expect(tracks.length).toBeGreaterThan(0);
      // Auto target policy (coverage × size), as the pipeline does pre-seed.
      const target = [...tracks].sort(
        (a, b) => b.coverage * b.meanTorsoSpan - a.coverage * a.meanTorsoSpan,
      )[0]!;
      const sequence = targetPoseSequence(people, target);
      const window = detectOfflineStrokeWindow(sequence);
      if (!window.ok) return; // no stroke window → detector never runs; nothing to clip
      const strokeWindow = window.value;
      const prePass = proposeStrokeEventsV2({
        paddleSpeeds: null,
        wristSpeeds: dominantWristSpeeds(sequence, strokeWindow),
        clipStartMs: strokeWindow.startMs,
        clipEndMs: strokeWindow.endMs,
      });
      const hull = planDetectSpanHull(strokeWindow, prePass.events);
      const segments = planDetectSpanSegments(strokeWindow, prePass.events);
      for (const gold of goldEvents) {
        for (const boundary of [gold.eventStartMs, gold.eventEndMs]) {
          if (boundary < hull.startMs || boundary > hull.endMs) continue; // legacy never saw it
          // AUTOMATIC FAIL: hull covered this gold boundary but tight clipped it.
          expect(covered(segments, boundary), `${benchCase.id} boundary ${boundary}`).toBe(true);
        }
      }
      // Tight coverage is never larger than the hull.
      expect(segmentsCoverageMs(segments)).toBeLessThanOrEqual(hull.endMs - hull.startMs + 1e-6);
    },
  );
});
