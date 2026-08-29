import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StrokeEventLabel } from "../src/annotationSchema.js";
import {
  attributeReplayFailure,
  overlapOfGold,
  signalStatsFor,
} from "../src/eventFailureOracle.js";
import { REPO_ROOT } from "../src/engine/corpus.js";
import { proposeStrokeEventsV2 } from "../src/strokeEvents.js";

function label(startMs: number, endMs: number, contactMs: number | null = null): StrokeEventLabel {
  return { eventStartMs: startMs, eventEndMs: endMs, contactMs, owner: "target" };
}

function denseSeries(
  fromMs: number,
  toMs: number,
  stepMs: number,
  valueAt: (tMs: number) => number,
) {
  const out: Array<{ timestampMs: number; value: number }> = [];
  for (let t = fromMs; t <= toMs; t += stepMs) out.push({ timestampMs: t, value: valueAt(t) });
  return out;
}

describe("event-failure oracle attribution precedence", () => {
  it("classifies a gold span outside the committed series window as UNATTRIBUTABLE_HERE", () => {
    const series = denseSeries(0, 1000, 40, () => 0.1);
    const gold = label(900, 1400);
    const verdict = attributeReplayFailure(
      signalStatsFor(series, gold),
      "MISSED",
      null,
      gold,
      { firstMs: 0, lastMs: 1000 },
      "case-x",
    );
    expect(verdict.attribution).toBe("UNATTRIBUTABLE_HERE");
    expect(verdict.evidence).toContain("does not fully cover");
  });

  it("classifies <3 in-span samples as POSE_SIGNAL_ABSENT, before any logic verdict", () => {
    const series = [
      { timestampMs: 0, value: 0.1 },
      { timestampMs: 500, value: 2 },
      { timestampMs: 3000, value: 0.1 },
    ];
    const gold = label(1000, 2000);
    const verdict = attributeReplayFailure(
      signalStatsFor(series, gold),
      "MISSED",
      null,
      gold,
      { firstMs: 0, lastMs: 3000 },
      "case-x",
    );
    expect(verdict.attribution).toBe("POSE_SIGNAL_ABSENT");
  });

  it("classifies a sparse in-span series (gap >200ms) as SAMPLING", () => {
    const series = [
      { timestampMs: 0, value: 0.1 },
      { timestampMs: 1000, value: 1 },
      { timestampMs: 1400, value: 1 },
      { timestampMs: 1900, value: 1 },
      { timestampMs: 2500, value: 0.1 },
    ];
    const gold = label(950, 2000);
    const verdict = attributeReplayFailure(
      signalStatsFor(series, gold),
      "MISSED",
      null,
      gold,
      { firstMs: 0, lastMs: 2500 },
      "case-x",
    );
    expect(verdict.attribution).toBe("SAMPLING");
  });

  it("classifies a sub-gate in-span peak as WRIST_SIGNAL_QUALITY", () => {
    const series = denseSeries(0, 3000, 40, (t) =>
      t >= 1000 && t <= 2000 ? 0.3 : t >= 2400 && t <= 2600 ? 3 : 0.05,
    );
    const gold = label(1000, 2000);
    const verdict = attributeReplayFailure(
      signalStatsFor(series, gold),
      "MISSED",
      null,
      gold,
      { firstMs: 0, lastMs: 3000 },
      "case-x",
    );
    expect(verdict.attribution).toBe("WRIST_SIGNAL_QUALITY");
  });

  it("classifies as EVENT_LOGIC only when the recorded signal fully supports the event", () => {
    const series = denseSeries(0, 3000, 40, (t) => (t >= 1200 && t <= 1800 ? 1.5 : 0.05));
    const gold = label(1000, 2000);
    const verdict = attributeReplayFailure(
      signalStatsFor(series, gold),
      "MIS_BOUNDED",
      { startMs: 400, endMs: 1100 },
      gold,
      { firstMs: 0, lastMs: 3000 },
      "case-x",
    );
    expect(verdict.attribution).toBe("EVENT_LOGIC");
    expect(verdict.evidence).toContain("matched proposal 400–1100");
  });
});

describe("committed rally1 fixture replay (regression anchor for the oracle)", () => {
  const fixture = JSON.parse(
    readFileSync(
      join(REPO_ROOT, "apps/mobile/__tests__/fixtures/sessionReplay.afn-sasebo-rally1.json"),
      "utf8",
    ),
  ) as { wristSamples: Array<{ tMs: number; v: number }> };
  const speeds = fixture.wristSamples.map((sample) => ({
    timestampMs: sample.tMs,
    value: sample.v,
  }));

  it("reproduces the recorded batch proposals from the committed wrist series", () => {
    const { events } = proposeStrokeEventsV2({
      paddleSpeeds: null,
      wristSpeeds: speeds,
      clipStartMs: speeds[0]!.timestampMs,
      clipEndMs: speeds[speeds.length - 1]!.timestampMs,
    });
    expect(events.length).toBe(3);
    const gold = label(2600, 3600, 2900);
    const best = events.map((event) => overlapOfGold(event, gold)).sort((a, b) => b - a)[0]!;
    expect(best).toBeGreaterThanOrEqual(0.85);
  });
});
