import { describe, expect, it } from "vitest";
import { observedSampleIntervalMs } from "../src/strokeEvents.js";
import {
  aggregate,
  loadGoldCases,
  runVariant,
  type VariantRow,
  type VariantSpec,
} from "../src/fpsTemporalSegmentation.js";

/**
 * ADVERSARIAL TESTS for candidate 8193d372 (xc-cv::XC-CV-3 + XC-CV-4).
 * Each `it` below FAILS on the candidate and documents a concrete defect in
 * the changed code; none of them is a lock on tuned numbers.
 *
 * Linux replay proxy over committed Apple-Vision pose — not Apple device
 * truth.
 */

const spec = (
  bundle: string,
  fps: number | null,
  extra: Partial<VariantSpec> = {},
): VariantSpec => ({
  bundle,
  fps,
  phase: 0,
  jitterMs: 0,
  dropRate: 0,
  seed: 0,
  ...extra,
});

/** Stamps whose consecutive intervals alternate `first`, `second`, `first`,
 * ... — the cadence a 60 fps stream decimated 2.5:1 (60→24) delivers: the
 * kept frames sit 2, 3, 2, 3 source frames apart (33, 50, 33, 50 ms). */
function alternatingStamps(first: number, second: number, count: number) {
  const out = [{ timestampMs: 1000 }];
  for (let index = 1; index < count; index += 1) {
    out.push({
      timestampMs: out[index - 1]!.timestampMs + (index % 2 === 1 ? first : second),
    });
  }
  return out;
}

describe("observedSampleIntervalMs on a 60→24 (33/50 ms alternating) cadence", () => {
  it("is the same cadence whichever sub-interval the series starts on", () => {
    // Same physical camera, same decimation ratio; only the first kept frame
    // differs. The candidate's robustCadenceMs takes the median of a bimodal
    // interval set and keeps only the intervals within 5 ms of it, so the
    // result is whichever mode the median index lands on: 33.3 or 50.
    const startsShort = observedSampleIntervalMs(alternatingStamps(33, 50, 50));
    const startsLong = observedSampleIntervalMs(alternatingStamps(50, 33, 50));
    expect(startsShort).not.toBeNull();
    expect(startsLong).not.toBeNull();
    expect(startsShort).toBeCloseTo(startsLong!, 3);
  });

  it("measures the effective 24 fps interval (~41.7 ms), not one of the two sub-intervals", () => {
    const effective24fpsMs = 1000 / 24;
    for (const [first, second] of [
      [33, 50],
      [50, 33],
    ] as const) {
      const interval = observedSampleIntervalMs(alternatingStamps(first, second, 51));
      expect(interval).not.toBeNull();
      // 10 % is the candidate's own standardRateSnapFraction.
      expect(Math.abs(interval! - effective24fpsMs)).toBeLessThanOrEqual(effective24fpsMs * 0.1);
    }
  });
});

describe("cluster acceptance across decimation phases (gold wave-a, 24 fps)", () => {
  // The cluster's acceptance only checks decimation phase 0. A 60→24
  // decimation has 5 phases (which of the 5 source frames the kept 2 sit on);
  // the SAME clip decimated at phases 3 and 4 delivers the same 33/50 ms
  // alternating cadence with the other sub-interval first, and the candidate
  // then drops 3 of the 9 natively-matched gold events (observed 6 vs 9).
  it(
    "keeps native.matched - matched <= 1 at EVERY decimation phase, not only phase 0",
    { timeout: 240_000 },
    async () => {
      const gold = loadGoldCases();
      const nativeByBundle = new Map<string, VariantRow>();
      for (const entry of gold) {
        nativeByBundle.set(entry.bundle, await runVariant(entry, spec(entry.bundle, null)));
      }
      const native = aggregate([...nativeByBundle.values()], nativeByBundle, "native");

      const matchedByPhase: Record<number, number> = {};
      for (const phase of [0, 1, 2, 3, 4]) {
        const rows: VariantRow[] = [];
        for (const entry of gold) {
          rows.push(await runVariant(entry, spec(entry.bundle, 24, { phase })));
        }
        matchedByPhase[phase] = aggregate(rows, nativeByBundle, 24).matched;
      }

      for (const phase of [0, 1, 2, 3, 4]) {
        expect(
          native.matched - matchedByPhase[phase]!,
          `24 fps decimation phase ${phase}: native matched ${native.matched}, decimated matched ${matchedByPhase[phase]} (all phases: ${JSON.stringify(matchedByPhase)})`,
        ).toBeLessThanOrEqual(1);
      }
    },
  );
});

describe("native-cadence replay of wavea-faead-rally (24 fps Apple-Vision bundle)", () => {
  // The bundle's annotation lists exactly two target strokes in the window
  // (13417–13833 and 13875–14500) and its wrist series is natively 24 fps, so
  // no decimation is involved. The candidate's cadence-scaled speed floor
  // (0.5 × sqrt(16.7/41.7) ≈ 0.32) admits a 0.46-peak movement at
  // 12667–13250 as a full (non-low-amplitude) stroke event that overlaps no
  // labeled stroke; 4d812e1a proposed nothing there. This is the +1
  // `event_recall.unmatched_proposals` the regression bench reports
  // (bench:compare exit 1), which the cluster's own acceptance forbids.
  it(
    "does not propose a stroke event outside the annotated strokes",
    { timeout: 60_000 },
    async () => {
      const gold = loadGoldCases().find((entry) => entry.bundle === "wavea-faead-rally");
      expect(gold).toBeDefined();
      const row = await runVariant(gold!, spec("wavea-faead-rally", null));
      const goldSpans = row.events
        .filter((event) => event.owner === "target")
        .map((event) => event.goldSpanMs);
      const overlapsAGoldStroke = (proposal: { startMs: number; endMs: number }) =>
        goldSpans.some(([from, to]) => proposal.startMs <= to && proposal.endMs >= from);
      const strays = row.proposals.filter((proposal) => !overlapsAGoldStroke(proposal));
      expect(
        strays.map(
          (proposal) => `${proposal.startMs}-${proposal.endMs}@${proposal.peakSpeed.toFixed(3)}`,
        ),
        `proposals outside every annotated stroke (gold spans ${JSON.stringify(goldSpans)})`,
      ).toEqual([]);
    },
  );
});
