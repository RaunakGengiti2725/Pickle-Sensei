import { describe, expect, it } from "vitest";
import {
  TARGET_FPS,
  aggregate,
  decimationPhaseCount,
  diffAgainstNative,
  loadGoldCases,
  loadPeople,
  mulberry32,
  resamplePeople,
  runVariant,
  type GoldCase,
  type VariantRow,
  type VariantSpec,
} from "../src/fpsTemporalSegmentation.js";
import { runE13EventBoundsEval } from "../src/e13EventBoundsEval.js";
import type { PeopleFile } from "../src/playerTracker.js";

/**
 * XC cv-temporal-segmentation harness pins (Linux replay proxy).
 *
 * Two kinds of test live here:
 *  - HARNESS CONTRACT: the resampler and scorer behave as documented on
 *    synthetic and committed inputs (deterministic, label-preserving).
 *  - MEASUREMENT LOCKS: outcomes measured on 4d812e1a for the committed
 *    wave-a gold. They are locks, not targets: if the proposer/segmenter
 *    changes and one flips, re-measure and decide whether the change is an
 *    improvement — never edit gold to make a lock pass.
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

function syntheticPeople(fps: number, frames: number): PeopleFile {
  const interval = 1000 / fps;
  return {
    schemaVersion: 1,
    poseModelVersion: "test",
    video: { w: 1920, h: 1080, fps },
    frames: Array.from({ length: frames }, (_, index) => {
      const t = Math.round(index * interval);
      const x = 0.3 + index * 0.01;
      return {
        t,
        p: [
          {
            c: 0.9,
            l: [
              { n: "left_shoulder", x: x - 0.05, y: 0.4, v: 0.9 },
              { n: "right_shoulder", x: x + 0.05, y: 0.4, v: 0.9 },
              { n: "right_wrist", x, y: 0.5 + index * 0.02, v: 0.9 },
              { n: "left_wrist", x: x - 0.1, y: 0.5, v: 0.9 },
            ],
          },
        ],
      };
    }),
  };
}

describe("fps resampler contract", () => {
  it("native spec returns the frames untouched", () => {
    const people = syntheticPeople(60, 30);
    const out = resamplePeople(people, spec("x", null));
    expect(out.mode).toBe("native");
    expect(out.synthetic).toBe(false);
    expect(out.file.frames.map((frame) => frame.t)).toEqual(people.frames.map((frame) => frame.t));
  });

  it("decimation keeps only real frames at the target density and honours the grid phase", () => {
    const people = syntheticPeople(60, 60);
    const at30 = resamplePeople(people, spec("x", 30));
    expect(at30.mode).toBe("decimate");
    expect(at30.synthetic).toBe(false);
    expect(at30.interpolatedFrames).toBe(0);
    const native = new Set(people.frames.map((frame) => frame.t));
    for (const frame of at30.file.frames) expect(native.has(frame.t)).toBe(true);
    expect(at30.outputFrames).toBeGreaterThanOrEqual(29);
    expect(at30.outputFrames).toBeLessThanOrEqual(31);
    const phase1 = resamplePeople(people, spec("x", 30, { phase: 1 }));
    expect(phase1.file.frames[0]!.t).toBe(people.frames[1]!.t);
    expect(phase1.file.frames.map((f) => f.t)).not.toEqual(at30.file.frames.map((f) => f.t));
    const at24 = resamplePeople(people, spec("x", 24));
    expect(at24.outputFrames).toBeGreaterThanOrEqual(23);
    expect(at24.outputFrames).toBeLessThanOrEqual(25);
    expect(decimationPhaseCount(2)).toBe(2); // 60→30: even/odd native frames
    expect(decimationPhaseCount(2.5)).toBe(5); // 60→24: pattern repeats every 5 native frames
    expect(decimationPhaseCount(1.25)).toBe(5); // 30→24: 4 grid steps = 5 native frames
  });

  it("interpolation is flagged synthetic, monotonic, and linear between real frames", () => {
    const people = syntheticPeople(30, 20);
    const out = resamplePeople(people, spec("x", 60));
    expect(out.mode).toBe("interpolate");
    expect(out.synthetic).toBe(true);
    expect(out.interpolatedFrames).toBeGreaterThan(0);
    for (let index = 1; index < out.file.frames.length; index += 1) {
      expect(out.file.frames[index]!.t).toBeGreaterThan(out.file.frames[index - 1]!.t);
    }
    const a = people.frames[0]!;
    const b = people.frames[1]!;
    const mid = out.file.frames.find((frame) => frame.t > a.t && frame.t < b.t)!;
    const alpha = (mid.t - a.t) / (b.t - a.t);
    const wristA = a.p[0]!.l.find((mark) => mark.n === "right_wrist")!;
    const wristB = b.p[0]!.l.find((mark) => mark.n === "right_wrist")!;
    const wristMid = mid.p[0]!.l.find((mark) => mark.n === "right_wrist")!;
    // people.json timestamps are integer ms, so alpha recovered from the
    // rounded `t` differs from the exact grid alpha by ≤ 0.5/33 ≈ 1.5%.
    expect(wristMid.x).toBeCloseTo(wristA.x + (wristB.x - wristA.x) * alpha, 3);
    expect(wristMid.y).toBeCloseTo(wristA.y + (wristB.y - wristA.y) * alpha, 3);
    expect(out.outputFrames).toBeGreaterThanOrEqual(37);
  });

  it("jitter and drops are seeded and replayable", () => {
    const people = syntheticPeople(60, 60);
    const a = resamplePeople(people, spec("x", null, { jitterMs: 4, dropRate: 0.2, seed: 7 }));
    const b = resamplePeople(people, spec("x", null, { jitterMs: 4, dropRate: 0.2, seed: 7 }));
    const c = resamplePeople(people, spec("x", null, { jitterMs: 4, dropRate: 0.2, seed: 8 }));
    expect(a.file.frames.map((f) => f.t)).toEqual(b.file.frames.map((f) => f.t));
    expect(a.file.frames.map((f) => f.t)).not.toEqual(c.file.frames.map((f) => f.t));
    expect(a.droppedFrames).toBeGreaterThan(0);
    for (let index = 1; index < a.file.frames.length; index += 1) {
      expect(a.file.frames[index]!.t).toBeGreaterThan(a.file.frames[index - 1]!.t);
    }
    const rng = mulberry32(1);
    const first = [rng(), rng(), rng()];
    const rng2 = mulberry32(1);
    expect([rng2(), rng2(), rng2()]).toEqual(first);
  });
});

describe("committed wave-a gold (read-only)", () => {
  const cases = loadGoldCases();
  const byBundle = new Map(cases.map((entry) => [entry.bundle, entry]));

  it("loads all 8 windowed runDirs with their eventLabels and phases blocks", () => {
    expect(cases.map((entry) => entry.bundle).sort()).toEqual(
      [
        "wavea-944403-dink",
        "wavea-944403-smash",
        "wavea-faead-feed",
        "wavea-faead-rally",
        "wavea-marne-dig",
        "wavea-marne-serve",
        "wavea-sasebo-volleys",
        "wavea-wgm-wheelchair",
      ].sort(),
    );
    const targetEvents = cases.reduce(
      (sum, entry) => sum + entry.events.filter((event) => event.owner === "target").length,
      0,
    );
    expect(targetEvents).toBe(11);
    expect(cases.filter((entry) => entry.phases !== null).length).toBe(8);
    expect(cases.filter((entry) => entry.phaseEventIndex !== null).length).toBe(8);
    for (const entry of cases) {
      const people = loadPeople(entry.runDir);
      expect(people.video.fps).toBe(entry.nativeFps);
      expect(people.frames.length).toBeGreaterThan(30);
    }
  });

  it("native replay reproduces the E13 evaluator's proposals on the three D2-07 bundles", async () => {
    const e13 = runE13EventBoundsEval();
    for (const entry of e13.perBundle) {
      const gold = byBundle.get(entry.bundle)!;
      const row = await runVariant(gold, spec(entry.bundle, null));
      expect(
        row.proposals.map((p) => [
          Math.round(p.startMs),
          Math.round(p.peakMs),
          Math.round(p.endMs),
        ]),
      ).toEqual(
        entry.proposals.map((p) => [
          Math.round(p.startMs),
          Math.round(p.peakMs),
          Math.round(p.endMs),
        ]),
      );
      expect(row.wristSamples).toBe(entry.wristSamples);
    }
  });

  it("resampling never touches the gold timestamps and the run is deterministic", async () => {
    const gold = byBundle.get("wavea-marne-serve")!;
    const before = JSON.stringify(gold.events);
    const a = await runVariant(gold, spec(gold.bundle, 24));
    const b = await runVariant(gold, spec(gold.bundle, 24));
    expect(JSON.stringify(gold.events)).toBe(before);
    expect(a.events).toEqual(b.events);
    expect(a.proposals).toEqual(b.proposals);
    expect(a.phases).toEqual(b.phases);
    for (const event of a.events) {
      const label = gold.events[event.eventIndex]!;
      expect(event.goldSpanMs).toEqual([label.eventStartMs, label.eventEndMs]);
      expect(event.goldContactMs).toBe(label.contactMs);
    }
  });

  it("runs every bundle at native and 24/30/60/120 with the documented resampling mode", async () => {
    for (const gold of cases) {
      for (const fps of [null, ...TARGET_FPS]) {
        const row = await runVariant(gold, spec(gold.bundle, fps));
        if (fps === null) expect(row.resample.mode).toBe("native");
        else if (fps <= gold.nativeFps * 1.02) {
          expect(row.resample.mode).toBe("decimate");
          expect(row.resample.synthetic).toBe(false);
        } else {
          expect(row.resample.mode).toBe("interpolate");
          expect(row.resample.synthetic).toBe(true);
        }
        expect(row.target).not.toBeNull();
        expect(row.events.length).toBe(gold.events.length);
        expect(row.phases.length).toBe(5);
        expect(row.perf.heapUsedAfterBytes).toBeGreaterThan(0);
      }
    }
  }, 60_000);
});

describe("measurement locks on 4d812e1a (re-measure before changing)", () => {
  const cases = loadGoldCases();
  const byBundle = new Map(cases.map((entry) => [entry.bundle, entry]));
  const nativeRows = new Map<string, VariantRow>();
  const native = async (gold: GoldCase) => {
    const cached = nativeRows.get(gold.bundle);
    if (cached) return cached;
    const row = await runVariant(gold, spec(gold.bundle, null));
    nativeRows.set(gold.bundle, row);
    return row;
  };

  it("native: 9/11 target events matched, 8 PROPOSED_OK, contact inside 7/8 scored", async () => {
    const rows = await Promise.all(cases.map((gold) => native(gold)));
    const matrix = aggregate(rows, new Map(rows.map((row) => [row.spec.bundle, row])), "native");
    expect(matrix.targetEvents).toBe(11);
    expect(matrix.matched).toBe(9);
    expect(matrix.proposedOk).toBe(8);
    expect(matrix.contactInside).toBe(7);
    expect(matrix.contactScored).toBe(8);
    expect(matrix.phases["temporalV2.anchored"].segmented).toBe(8);
  });

  it("real decimation 60→30 loses the three short 59.94fps strokes (dig, dink, smash) — the 3-sample smoothed peak falls under the 0.5 n/s gate", async () => {
    for (const bundle of ["wavea-marne-dig", "wavea-944403-dink", "wavea-944403-smash"]) {
      const gold = byBundle.get(bundle)!;
      const base = await native(gold);
      const at30 = await runVariant(gold, spec(bundle, 30));
      expect(at30.resample.mode).toBe("decimate");
      const target = base.events.findIndex((event) => event.owner === "target");
      expect(base.events[target]!.matched).not.toBeNull();
      expect(at30.events[target]!.outcome).toBe("MISSED");
      expect(at30.proposals.length).toBe(0);
      expect(base.events[target]!.goldSpanPeak!.smoothedSpeed).toBeGreaterThan(
        at30.events[target]!.goldSpanPeak!.smoothedSpeed,
      );
      expect(at30.events[target]!.goldSpanPeak!.smoothedSpeed).toBeLessThan(0.5);
      const failures = diffAgainstNative(at30, base);
      expect(failures.some((failure) => failure.kind === "event_lost_vs_native")).toBe(true);
      expect(failures[0]!.replay).toContain(`"bundle":"${bundle}"`);
    }
  });

  it("real decimation 30→24 on sasebo-volleys is grid-phase dependent (all-missed vs all-matched)", async () => {
    const gold = byBundle.get("wavea-sasebo-volleys")!;
    const outcomes: string[] = [];
    const probe = await runVariant(gold, spec(gold.bundle, 24));
    expect(probe.resample.phaseCount).toBeGreaterThanOrEqual(2);
    for (let phase = 0; phase < probe.resample.phaseCount; phase += 1) {
      const row = await runVariant(gold, spec(gold.bundle, 24, { phase }));
      outcomes.push(
        row.events
          .filter((event) => event.owner === "target")
          .map((event) => event.outcome)
          .join(","),
      );
    }
    expect(new Set(outcomes).size).toBeGreaterThan(1);
    expect(outcomes).toContain("MISSED,MISSED,MISSED");
    expect(outcomes).toContain("PROPOSED_OK,PROPOSED_OK,PROPOSED_OK");
  });

  it("marne-serve at 24/30 fps keeps the contact but the start bound slides ~434ms into the swing", async () => {
    const gold = byBundle.get("wavea-marne-serve")!;
    const base = await native(gold);
    expect(base.events[0]!.startErrMs).toBe(100);
    for (const fps of [24, 30]) {
      const row = await runVariant(gold, spec(gold.bundle, fps));
      expect(row.events[0]!.outcome).toBe("PROPOSED_OK");
      expect(row.events[0]!.contactInside).toBe(true);
      expect(row.events[0]!.startErrMs).toBe(534);
    }
  });

  it("XC-CV-3: ≤2 ms timestamp jitter at native fps never loses a natively matched target event (all bundles, seeds 1–3)", async () => {
    for (const gold of cases) {
      const base = await native(gold);
      for (const seed of [1, 2, 3]) {
        const row = await runVariant(gold, spec(gold.bundle, null, { jitterMs: 2, seed }));
        const lost = diffAgainstNative(row, base).filter(
          (failure) => failure.kind === "event_lost_vs_native",
        );
        expect(
          lost,
          `${gold.bundle} seed ${seed}: ${lost.map((f) => f.detail).join("; ")}`,
        ).toEqual([]);
      }
    }
  }, 60_000);

  it("XC-CV-3: 2 ms jitter never breaks streaming/batch parity on a bundle whose native replay has parity", async () => {
    for (const gold of cases) {
      const base = await native(gold);
      if (!base.streaming.parity) continue;
      for (const seed of [1, 2, 3]) {
        const row = await runVariant(gold, spec(gold.bundle, null, { jitterMs: 2, seed }));
        expect(row.streaming.parity, `${gold.bundle} seed ${seed}: ${row.streaming.mismatch}`).toBe(
          true,
        );
      }
    }
  }, 60_000);

  it("XC-CV-3: real 60→30 and 60→24 decimation keeps streaming/batch parity wherever the native replay has it", async () => {
    for (const gold of cases) {
      const base = await native(gold);
      if (!base.streaming.parity) continue;
      for (const fps of [24, 30]) {
        const probe = await runVariant(gold, spec(gold.bundle, fps));
        for (let phase = 0; phase < probe.resample.phaseCount; phase += 1) {
          const row =
            phase === 0 ? probe : await runVariant(gold, spec(gold.bundle, fps, { phase }));
          expect(
            row.streaming.parity,
            `${gold.bundle} fps ${fps} phase ${phase}: ${row.streaming.mismatch}`,
          ).toBe(true);
        }
      }
    }
  }, 120_000);

  it("marne-dig native: SessionEventEngine streams 2 events where the batch proposer returns 1", async () => {
    const base = await native(byBundle.get("wavea-marne-dig")!);
    expect(base.proposals.length).toBe(1);
    expect(base.streaming.parity).toBe(false);
    expect(base.streaming.emitted.length).toBe(2);
  });

  it("gold-anchored segmentPhasesTemporalV2 reproduces the gold contact exactly at every fps (anchor is an input, not an estimate)", async () => {
    for (const gold of cases) {
      for (const fps of [null, 24, 30, 60]) {
        const row = await runVariant(gold, spec(gold.bundle, fps));
        const anchored = row.phases.find((p) => p.segmenter === "temporalV2.anchored")!;
        if (anchored.status === "segmented") expect(anchored.contactErrMs).toBe(0);
      }
    }
  }, 60_000);
});
