import { afterAll, describe, expect, it } from "vitest";
import { parsePoseSequence, serializePoseSequence, type PoseSequence } from "@pickle/swing-domain";
import { campaign, ResultTable, SeededRng } from "./support.js";

/**
 * Model-based fuzz of the swing-lab → swing-domain pose wire boundary.
 *
 * `swingLabPoseWire` mirrors native/swing-lab/Sources/main.swift:196-212
 * (fps fallback + wire shape) exactly, so what the Apple binary would write
 * for a given reader state is exercised against the canonical Linux parser
 * (`parsePoseSequence`) without Swift. Mutations model empty / one-frame /
 * huge / corrupt extractions. Invariants:
 *  - the parser never throws (returns a Result for any JSON value);
 *  - a well-formed swing-lab wire with fps > 0 parses and round-trips;
 *  - each corruption is rejected with the modelled failure code.
 */

const JOINTS = [
  "nose",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
];

interface ReaderBox {
  width: number;
  height: number;
  /** AVAssetTrack.nominalFrameRate as swing-lab reads it (0 when the track lacks one). */
  fps: number;
}

interface WireFrame {
  i: number;
  t: number;
  c: number;
  l: { n: string; x: number; y: number; v: number }[];
}

/** main.swift:196-204 — effective fps from frame span, else the reader's nominal fps. */
function swingLabEffectiveFps(reader: ReaderBox, frames: WireFrame[]): number {
  const first = frames[0];
  const last = frames[frames.length - 1];
  if (frames.length >= 2 && first && last && last.t > first.t) {
    return ((frames.length - 1) * 1000) / (last.t - first.t);
  }
  return reader.fps;
}

/** main.swift:206-212 — the pose.json root swing-lab writes. */
function swingLabPoseWire(reader: ReaderBox, frames: WireFrame[]): Record<string, unknown> {
  const effectiveFps = swingLabEffectiveFps(reader, frames);
  return {
    schemaVersion: 1,
    format: "pickle.pose-sequence.v1",
    coordinateSystem: "normalized_image_top_left",
    poseModelVersion: "apple-vision-bodypose-1",
    video: { w: reader.width, h: reader.height, fps: reader.fps > 0 ? reader.fps : effectiveFps },
    frames,
  };
}

function makeFrames(rng: SeededRng, count: number, stepMs: number): WireFrame[] {
  const frames: WireFrame[] = [];
  let t = rng.int(0, 5_000);
  for (let i = 0; i < count; i += 1) {
    frames.push({
      i,
      t,
      c: rng.doubleIn(0, 1),
      l: JOINTS.map((n) => ({
        n,
        x: rng.doubleIn(-0.2, 1.2),
        y: rng.doubleIn(-0.2, 1.2),
        v: rng.doubleIn(0, 1),
      })),
    });
    t += Math.max(1, Math.round(stepMs * rng.doubleIn(0.5, 1.5)));
  }
  return frames;
}

function makeReader(rng: SeededRng): ReaderBox {
  return {
    width: rng.pick([1, 2, 320, 608, 1080, 1920, 3840, 7680]),
    height: rng.pick([1, 2, 240, 1080, 1920, 2160, 4320]),
    fps: rng.pick([0, 0, 12, 24, 29.97, 30, 60, 120, 240]),
  };
}

/** Deep-clone via JSON exactly like the file boundary would. */
function viaJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

type Mutation = {
  name: string;
  expect: "ok" | string; // failure code when rejected
  apply: (wire: Record<string, unknown>, rng: SeededRng) => unknown;
};

function frameArray(wire: Record<string, unknown>): WireFrame[] {
  return wire.frames as WireFrame[];
}

const MUTATIONS: Mutation[] = [
  { name: "identity", expect: "ok", apply: (wire) => wire },
  { name: "root_null", expect: "pose_sequence.not_object", apply: () => null },
  {
    // typeof [] === "object": an array root passes the not_object guard and
    // is rejected one check later as "unsupported schema version: undefined".
    name: "root_array",
    expect: "pose_sequence.unsupported_schema",
    apply: () => [],
  },
  { name: "root_string", expect: "pose_sequence.not_object", apply: () => "pose" },
  {
    name: "schema_version_2",
    expect: "pose_sequence.unsupported_schema",
    apply: (wire) => ({ ...wire, schemaVersion: 2 }),
  },
  {
    name: "schema_version_string",
    expect: "pose_sequence.unsupported_schema",
    apply: (wire) => ({ ...wire, schemaVersion: "1" }),
  },
  {
    name: "format_legacy",
    expect: "pose_sequence.unsupported_format",
    apply: (wire) => ({ ...wire, format: "pickle.pose-sequence.v0" }),
  },
  {
    name: "coordinate_system_unknown",
    expect: "pose_sequence.unknown_coordinate_system",
    apply: (wire) => ({ ...wire, coordinateSystem: "normalized_bottom_left" }),
  },
  {
    name: "model_version_empty",
    expect: "pose_sequence.missing_model_version",
    apply: (wire) => ({ ...wire, poseModelVersion: "" }),
  },
  {
    name: "video_missing",
    expect: "pose_sequence.invalid_video",
    apply: (wire) => {
      const { video: _video, ...rest } = wire;
      return rest;
    },
  },
  {
    name: "video_zero_width",
    expect: "pose_sequence.invalid_video",
    apply: (wire) => ({ ...wire, video: { ...(wire.video as object), w: 0 } }),
  },
  {
    name: "video_negative_height",
    expect: "pose_sequence.invalid_video",
    apply: (wire) => ({ ...wire, video: { ...(wire.video as object), h: -1080 } }),
  },
  {
    name: "video_fps_zero",
    expect: "pose_sequence.invalid_video",
    apply: (wire) => ({ ...wire, video: { ...(wire.video as object), fps: 0 } }),
  },
  {
    name: "video_fps_null",
    expect: "pose_sequence.invalid_video",
    apply: (wire) => ({ ...wire, video: { ...(wire.video as object), fps: null } }),
  },
  {
    name: "frames_object",
    expect: "pose_sequence.invalid_frames",
    apply: (wire) => ({ ...wire, frames: {} }),
  },
  {
    name: "frames_missing",
    expect: "pose_sequence.invalid_frames",
    apply: (wire) => {
      const { frames: _frames, ...rest } = wire;
      return rest;
    },
  },
  { name: "frames_empty", expect: "ok", apply: (wire) => ({ ...wire, frames: [] }) },
  {
    name: "frames_one",
    expect: "ok",
    apply: (wire) => ({ ...wire, frames: frameArray(wire).slice(0, 1) }),
  },
  {
    name: "frame_null",
    expect: "pose_sequence.corrupt_frame",
    apply: (wire, rng) => {
      const frames: unknown[] = [...frameArray(wire)];
      if (frames.length === 0) return wire;
      frames[rng.int(0, frames.length - 1)] = null;
      return { ...wire, frames };
    },
  },
  {
    name: "frame_index_fractional",
    expect: "pose_sequence.corrupt_frame",
    apply: (wire, rng) => {
      const frames = frameArray(wire).map((frame) => ({ ...frame }));
      const target = frames[rng.int(0, frames.length - 1)];
      if (!target) return wire;
      target.i = 1.5;
      return { ...wire, frames };
    },
  },
  {
    name: "frame_confidence_nan_string",
    expect: "pose_sequence.corrupt_frame",
    apply: (wire, rng) => {
      const frames = frameArray(wire).map((frame) => ({ ...frame }));
      const target = frames[rng.int(0, frames.length - 1)];
      if (!target) return wire;
      // JSON cannot carry NaN; a producer that tried gets a string or null.
      (target as unknown as { c: unknown }).c = rng.bool() ? "nan" : null;
      return { ...wire, frames };
    },
  },
  {
    name: "frame_duplicate_timestamp",
    expect: "pose_sequence.non_monotonic",
    apply: (wire, rng) => {
      const frames = frameArray(wire).map((frame) => ({ ...frame }));
      if (frames.length < 2) return wire;
      const index = rng.int(1, frames.length - 1);
      const previous = frames[index - 1];
      const target = frames[index];
      if (!previous || !target) return wire;
      target.t = previous.t;
      return { ...wire, frames };
    },
  },
  {
    name: "frame_reversed_timestamps",
    expect: "pose_sequence.non_monotonic",
    apply: (wire) => {
      const frames = frameArray(wire);
      if (frames.length < 2) return wire;
      return { ...wire, frames: [...frames].reverse() };
    },
  },
  {
    name: "frame_no_landmarks",
    expect: "pose_sequence.corrupt_frame",
    apply: (wire, rng) => {
      const frames = frameArray(wire).map((frame) => ({ ...frame }));
      const target = frames[rng.int(0, frames.length - 1)];
      if (!target) return wire;
      target.l = [];
      return { ...wire, frames };
    },
  },
  {
    name: "landmark_name_empty",
    expect: "pose_sequence.corrupt_landmark",
    apply: (wire, rng) => {
      const frames = frameArray(wire).map((frame) => ({
        ...frame,
        l: frame.l.map((mark) => ({ ...mark })),
      }));
      const target = frames[rng.int(0, frames.length - 1)];
      const mark = target?.l[rng.int(0, JOINTS.length - 1)];
      if (!mark) return wire;
      mark.n = "";
      return { ...wire, frames };
    },
  },
  {
    name: "landmark_x_string",
    expect: "pose_sequence.corrupt_landmark",
    apply: (wire, rng) => {
      const frames = frameArray(wire).map((frame) => ({
        ...frame,
        l: frame.l.map((mark) => ({ ...mark })),
      }));
      const target = frames[rng.int(0, frames.length - 1)];
      const mark = target?.l[rng.int(0, JOINTS.length - 1)];
      if (!mark) return wire;
      (mark as unknown as { x: unknown }).x = "0.5";
      return { ...wire, frames };
    },
  },
  {
    name: "landmark_z_null",
    expect: "pose_sequence.corrupt_landmark",
    apply: (wire, rng) => {
      const frames = frameArray(wire).map((frame) => ({
        ...frame,
        l: frame.l.map((mark) => ({ ...mark })),
      }));
      const target = frames[rng.int(0, frames.length - 1)];
      const mark = target?.l[rng.int(0, JOINTS.length - 1)];
      if (!mark) return wire;
      (mark as unknown as { z: unknown }).z = null;
      return { ...wire, frames };
    },
  },
  {
    name: "landmark_out_of_range_values",
    expect: "ok",
    apply: (wire, rng) => {
      const frames = frameArray(wire).map((frame) => ({
        ...frame,
        l: frame.l.map((mark) => ({
          ...mark,
          x: rng.doubleIn(-1e6, 1e6),
          y: rng.doubleIn(-1e6, 1e6),
          v: rng.doubleIn(-5, 5),
        })),
      }));
      return { ...wire, frames };
    },
  },
];

const table = new ResultTable("pose-wire-fuzz");

afterAll(() => {
  const path = table.flush();
  expect(table.brokenCount, `BROKEN rows in ${path}`).toBe(0);
});

const PRODUCER = {
  providerId: "pose.apple-vision",
  runtime: "vision_framework" as const,
  executionTarget: "on_device" as const,
  artifactHash: null,
};

function parseNeverThrows(json: string): ReturnType<typeof parsePoseSequence> {
  try {
    return parsePoseSequence(json, PRODUCER);
  } catch (error) {
    throw new Error(`parsePoseSequence threw: ${String(error)}`);
  }
}

describe("swing-lab pose wire → swing-domain parser (model-based fuzz)", () => {
  it("well-formed swing-lab wires with a positive nominal fps parse and round-trip", () => {
    for (const seed of campaign.seeds(campaign.iterations * 10)) {
      const rng = new SeededRng(seed);
      const reader = makeReader(rng);
      if (reader.fps <= 0) reader.fps = 30;
      const frames = makeFrames(rng, rng.int(0, 400), rng.pick([8, 16, 33, 41, 83, 1000]));
      const wire = swingLabPoseWire(reader, frames);
      const parsed = parseNeverThrows(JSON.stringify(wire));
      let outcome: "HELD" | "BROKEN" = "HELD";
      let detail = `frames=${frames.length} reader=${JSON.stringify(reader)}`;
      if (!parsed.ok) {
        outcome = "BROKEN";
        detail += ` rejected=${parsed.failure.code}`;
      } else {
        const sequence: PoseSequence = parsed.value;
        const again = parseNeverThrows(serializePoseSequence(sequence));
        if (!again.ok || again.value.frames.length !== frames.length) {
          outcome = "BROKEN";
          detail += " round-trip mismatch";
        } else if (
          again.value.frames.some(
            (frame, index) => frame.timestampMs !== frames[index]?.t || frame.frameIndex !== index,
          )
        ) {
          outcome = "BROKEN";
          detail += " round-trip timestamps/indexes drifted";
        }
      }
      table.record("well_formed_round_trip", seed, outcome, detail);
      expect(outcome, `seed=${seed} ${detail}`).toBe("HELD");
    }
  }, 120_000);

  it("every modelled corruption is rejected with its failure code; valid shapes still parse", () => {
    for (const seed of campaign.seeds(campaign.iterations * 8)) {
      for (const mutation of MUTATIONS) {
        const rng = new SeededRng(seed ^ BigInt(MUTATIONS.indexOf(mutation) + 1));
        const reader = makeReader(rng);
        if (reader.fps <= 0) reader.fps = 30;
        const frames = makeFrames(rng, rng.int(2, 64), 33);
        const mutated = mutation.apply(swingLabPoseWire(reader, frames), rng);
        const parsed = parseNeverThrows(JSON.stringify(mutated));
        const observed = parsed.ok ? "ok" : parsed.failure.code;
        const held = observed === mutation.expect;
        table.record(
          `mutation:${mutation.name}`,
          seed,
          held ? "HELD" : "BROKEN",
          `expected=${mutation.expect} observed=${observed}`,
        );
        expect(observed, `seed=${seed} mutation=${mutation.name}`).toBe(mutation.expect);
      }
    }
  }, 120_000);

  it("MODEL main.swift:196-212 — a 0/1-frame extraction of a track without a nominal fps writes fps=0, which the canonical parser rejects", () => {
    // AVAssetTrack.nominalFrameRate is 0 for tracks that do not declare one
    // (INFERRED for one-frame/still-derived assets; not shown by run
    // 33909637479 whose clip reports nominalFps=12). With < 2 pose frames the
    // fallback has no span to derive fps from and passes the 0 through.
    const seed = campaign.seeds(1)[0] ?? 1n;
    const rng = new SeededRng(seed);
    const cases: { frames: WireFrame[]; label: string }[] = [
      { frames: [], label: "no_pose_frames" },
      { frames: makeFrames(rng, 1, 33), label: "one_pose_frame" },
    ];
    for (const { frames, label } of cases) {
      const wire = swingLabPoseWire({ width: 608, height: 1080, fps: 0 }, frames);
      const video = wire.video as { fps: number };
      const parsed = parseNeverThrows(JSON.stringify(viaJson(wire)));
      const observed = parsed.ok ? "ok" : parsed.failure.code;
      table.record(
        `fps_fallback:${label}`,
        seed,
        "HELD",
        `modelled fps=${video.fps} parser=${observed} (pins current behaviour; see findings)`,
      );
      expect(video.fps).toBe(0);
      expect(observed).toBe("pose_sequence.invalid_video");
    }
    // With ≥ 2 frames the span fallback produces a positive fps and the wire parses.
    const spanFrames = makeFrames(rng, 2, 41);
    const spanWire = swingLabPoseWire({ width: 608, height: 1080, fps: 0 }, spanFrames);
    const spanParsed = parseNeverThrows(JSON.stringify(spanWire));
    table.record("fps_fallback:two_pose_frames", seed, spanParsed.ok ? "HELD" : "BROKEN");
    expect(spanParsed.ok).toBe(true);
  });

  it("huge extraction (min(STRESS_ITER,10) × 20k frames) parses without stack growth or drift", () => {
    const seed = campaign.seeds(1)[0] ?? 1n;
    const rng = new SeededRng(seed ^ 0x4867n);
    // Capped: 200k frames ≈ 240 MB of JSON, near V8's max string length.
    const count = Math.min(campaign.iterations, 10) * 20_000;
    const frames = makeFrames(rng, count, 8);
    const wire = swingLabPoseWire({ width: 3840, height: 2160, fps: 120 }, frames);
    const json = JSON.stringify(wire);
    const before = process.memoryUsage().heapUsed;
    const startedAt = performance.now();
    const parsed = parseNeverThrows(json);
    const elapsedMs = Math.round(performance.now() - startedAt);
    const heapDeltaMb = Math.round((process.memoryUsage().heapUsed - before) / 1048576);
    const held = parsed.ok && parsed.value.frames.length === count;
    table.record(
      "huge_extraction",
      seed,
      held ? "HELD" : "BROKEN",
      `frames=${count} bytes=${json.length} parseMs=${elapsedMs} heapDeltaMb=${heapDeltaMb}`,
    );
    expect(held, `seed=${seed}`).toBe(true);
  }, 120_000);

  it("random JSON garbage never throws out of the parser", () => {
    const tokens = [
      "{",
      "}",
      "[",
      "]",
      ":",
      ",",
      '"frames"',
      '"t"',
      "1",
      "-0",
      "1e400",
      "null",
      "true",
      '"\\u0000"',
      " ",
    ];
    for (const seed of campaign.seeds(campaign.iterations * 50)) {
      const rng = new SeededRng(seed ^ 0x6a7n);
      const length = rng.int(0, 40);
      let text = "";
      for (let index = 0; index < length; index += 1) text += rng.pick(tokens);
      let outcome: "HELD" | "BROKEN" = "HELD";
      try {
        const parsed = parsePoseSequence(text, PRODUCER);
        if (parsed.ok) {
          outcome = "BROKEN";
        }
      } catch (error) {
        // Invalid JSON text is allowed to surface as a thrown SyntaxError only
        // if the parser contract says so; it does not — it wraps JSON.parse.
        outcome = "BROKEN";
        table.record(
          "garbage_json",
          seed,
          outcome,
          `threw ${String(error)} for ${JSON.stringify(text)}`,
        );
        expect.fail(`seed=${seed} parser threw for ${JSON.stringify(text)}: ${String(error)}`);
      }
      table.record("garbage_json", seed, outcome, JSON.stringify(text).slice(0, 80));
      expect(outcome, `seed=${seed} garbage parsed as valid: ${text}`).toBe("HELD");
    }
  }, 120_000);
});
