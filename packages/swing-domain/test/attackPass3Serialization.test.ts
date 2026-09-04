import { describe, expect, it } from "vitest";
import {
  parsePoseSequence,
  serializePoseSequence,
  toLegacyPoseFrames,
  type PoseSequence,
} from "../src/index.js";

/**
 * ADVERSARIAL PASS 3 / TESTER #1 — pose-sequence wire format under hostile
 * input (frame handling on the capture → analysis boundary). HELD asserts
 * the contract; GAP pins an observed deviation and logs it for the artifact.
 */

const PRODUCER = {
  providerId: "pose.apple-vision",
  runtime: "vision_framework" as const,
  executionTarget: "on_device" as const,
  artifactHash: null,
};

function sequence(overrides: Partial<PoseSequence> = {}): PoseSequence {
  return {
    schemaVersion: 1,
    format: "pickle.pose-sequence.v1",
    coordinateSystem: "normalized_image_top_left",
    producedBy: { ...PRODUCER, modelVersion: "apple-vision-bodypose-1" },
    video: { width: 1080, height: 1920, fps: 60 },
    frames: [
      {
        frameIndex: 0,
        timestampMs: 0,
        confidence: 0.92,
        landmarks: [{ name: "right_wrist", x: 0.5, y: 0.4, visibility: 0.9 }],
      },
      {
        frameIndex: 1,
        timestampMs: 17,
        confidence: 0.93,
        landmarks: [{ name: "right_wrist", x: 0.51, y: 0.39, visibility: 0.9 }],
      },
    ],
    ...overrides,
  };
}

function wireOf(seq: PoseSequence): Record<string, unknown> {
  return JSON.parse(serializePoseSequence(seq)) as Record<string, unknown>;
}

describe("ATTACK (own) — parsePoseSequence hostile wire input", () => {
  it("HELD: non-JSON, non-object roots, arrays, null, huge nesting and prototype-pollution keys are all rejected or inert", () => {
    const cases: Array<[string, string]> = [
      ["", "pose_sequence.not_json"],
      ["\uFEFF{}", "pose_sequence.not_json"],
      ["null", "pose_sequence.not_object"],
      ["[]", "pose_sequence.unsupported_schema"],
      ["42", "pose_sequence.not_object"],
      ['"string"', "pose_sequence.not_object"],
      ["[".repeat(10_000) + "]".repeat(10_000), "pose_sequence.unsupported_schema"],
      [
        '{"__proto__":{"schemaVersion":1},"constructor":{"prototype":{}}}',
        "pose_sequence.unsupported_schema",
      ],
    ];
    for (const [input, code] of cases) {
      const result = parsePoseSequence(input, PRODUCER);
      expect(result.ok, input.slice(0, 40)).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe(code);
    }
    // The polluted parse must not have touched Object.prototype.
    expect(({} as { schemaVersion?: unknown }).schemaVersion).toBeUndefined();
  });

  it("HELD: equal timestamps, negative/NaN/Infinity times, string numbers and boolean-typed fields are rejected as corrupt_frame / non_monotonic", () => {
    const base = wireOf(sequence());
    const frames = base["frames"] as Array<Record<string, unknown>>;
    const variants: Array<[string, Record<string, unknown>, string]> = [
      [
        "equal-timestamps",
        { ...base, frames: [frames[0], { ...frames[1], t: 0 }] },
        "pose_sequence.non_monotonic",
      ],
      [
        "negative-second",
        { ...base, frames: [frames[0], { ...frames[1], t: -5 }] },
        "pose_sequence.non_monotonic",
      ],
      [
        "nan-time",
        { ...base, frames: [{ ...frames[0], t: "NaN" }] },
        "pose_sequence.corrupt_frame",
      ],
      [
        "string-time",
        { ...base, frames: [{ ...frames[0], t: "17" }] },
        "pose_sequence.corrupt_frame",
      ],
      [
        "bool-confidence",
        { ...base, frames: [{ ...frames[0], c: true }] },
        "pose_sequence.corrupt_frame",
      ],
      [
        "float-index",
        { ...base, frames: [{ ...frames[0], i: 0.5 }] },
        "pose_sequence.corrupt_frame",
      ],
      ["null-frame", { ...base, frames: [null] }, "pose_sequence.corrupt_frame"],
      ["frames-object", { ...base, frames: {} }, "pose_sequence.invalid_frames"],
      ["zero-fps", { ...base, video: { w: 1, h: 1, fps: 0 } }, "pose_sequence.invalid_video"],
      [
        "string-dims",
        { ...base, video: { w: "1080", h: 1920, fps: 60 } },
        "pose_sequence.invalid_video",
      ],
      ["empty-model", { ...base, poseModelVersion: "" }, "pose_sequence.missing_model_version"],
      [
        "landmark-empty-name",
        { ...base, frames: [{ ...frames[0], l: [{ n: "", x: 0, y: 0, v: 1 }] }] },
        "pose_sequence.corrupt_landmark",
      ],
      [
        "landmark-null-z",
        { ...base, frames: [{ ...frames[0], l: [{ n: "a", x: 0, y: 0, v: 1, z: null }] }] },
        "pose_sequence.corrupt_landmark",
      ],
    ];
    for (const [label, wire, code] of variants) {
      const result = parsePoseSequence(JSON.stringify(wire), PRODUCER);
      expect(result.ok, label).toBe(false);
      if (!result.ok) expect(result.failure.code, label).toBe(code);
    }
  });

  it("GAP (P3, pre-existing): the parser has no RANGE checks — negative timestamps, frameIndex -1 / 2^53 / out of order / duplicated, confidence -3 and 7, visibility 1e9, coordinates ±1e300, fps 1e308, duplicate landmark names and a 100k-char unicode landmark name are all accepted", () => {
    const base = wireOf(sequence());
    const frames = base["frames"] as Array<Record<string, unknown>>;
    const hostile = {
      ...base,
      video: { w: 1e300, h: 1, fps: 1e308 },
      frames: [
        {
          i: 2 ** 53,
          t: -1e15,
          c: -3,
          l: [
            { n: "right_wrist", x: -1e300, y: 1e300, v: 1e9 },
            { n: "right_wrist", x: 0, y: 0, v: 0 },
            { n: "🎾".repeat(50_000), x: 0.5, y: 0.5, v: 0.5 },
          ],
        },
        { ...frames[0], i: -1, t: 0, c: 7 },
        { ...frames[1], i: -1, t: 1 },
      ],
    };
    const result = parsePoseSequence(JSON.stringify(hostile), PRODUCER);
    console.log(
      JSON.stringify({
        scenario: "swing-domain-parse-no-range-checks",
        ok: result.ok,
        frames: result.ok
          ? result.value.frames.map((f) => ({
              i: f.frameIndex,
              t: f.timestampMs,
              c: f.confidence,
              landmarks: f.landmarks.length,
            }))
          : result.failure.code,
        legacyLandmarks: result.ok
          ? toLegacyPoseFrames(result.value).map((f) => f.landmarks.map((l) => l.name))
          : null,
      }),
    );
    // CONTRACT (observations.ts: confidence/visibility 0..1, normalized
    // coordinates, frameIndex a monotonically increasing index). OBSERVED
    // (pinned): everything above parses ok; only finiteness and strict
    // timestamp order are enforced. A duplicated landmark name survives
    // into the legacy projection as two "right_wrist" entries.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.frames[0]!.confidence).toBe(-3);
    expect(result.value.frames[1]!.confidence).toBe(7);
    expect(result.value.frames[0]!.frameIndex).toBe(2 ** 53);
    expect(result.value.frames[1]!.frameIndex).toBe(-1);
    expect(result.value.frames[2]!.frameIndex).toBe(-1);
    expect(result.value.video.fps).toBe(1e308);
    expect(
      toLegacyPoseFrames(result.value)[0]!.landmarks.filter((l) => l.name === "right_wrist"),
    ).toHaveLength(2);
  });

  it("GAP (P3, pre-existing): serializePoseSequence does not validate — NaN/Infinity/undefined in a landmark serialise to null (or vanish) and the round trip then FAILS on parse, so a bad capture is only detected on read", () => {
    const seq = sequence();
    seq.frames[0]!.landmarks[0]!.x = NaN;
    seq.frames[1]!.landmarks[0]!.visibility = Infinity;
    const json = serializePoseSequence(seq);
    const back = parsePoseSequence(json, PRODUCER);
    console.log(
      JSON.stringify({
        scenario: "swing-domain-serialize-no-validation",
        json: json.slice(0, 260),
        roundTrip: back.ok ? "ok" : back.failure.code,
      }),
    );
    expect(json).toContain('"x":null');
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.failure.code).toBe("pose_sequence.corrupt_landmark");

    const emptyFrames = parsePoseSequence(
      serializePoseSequence(sequence({ frames: [] })),
      PRODUCER,
    );
    // Zero frames is accepted as a valid sequence (no min-frame invariant).
    expect(emptyFrames.ok).toBe(true);
    if (emptyFrames.ok) expect(toLegacyPoseFrames(emptyFrames.value)).toEqual([]);
  });

  it("MEASURE: a 60 fps × 10 min sequence (36k frames × 17 landmarks) round-trips in bounded time on the Linux bench box", () => {
    const frames: PoseSequence["frames"] = [];
    const names = [
      "head",
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
      "left_heel",
      "right_heel",
      "extra_a",
      "extra_b",
    ];
    for (let i = 0; i < 36_000; i++) {
      frames.push({
        frameIndex: i,
        timestampMs: i * (1000 / 60),
        confidence: 0.9,
        landmarks: names.map((name, k) => ({
          name,
          x: (k + 1) / 20,
          y: (i % 100) / 100,
          visibility: 0.8,
        })),
      });
    }
    const t0 = performance.now();
    const json = serializePoseSequence(sequence({ frames }));
    const t1 = performance.now();
    const back = parsePoseSequence(json, PRODUCER);
    const t2 = performance.now();
    console.log(
      JSON.stringify({
        scenario: "swing-domain-36k-frames",
        bytes: json.length,
        serializeMs: Math.round(t1 - t0),
        parseMs: Math.round(t2 - t1),
        note: "Linux bench proxy, not device truth",
      }),
    );
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.value.frames).toHaveLength(36_000);
    expect(t2 - t0).toBeLessThan(20_000);
  }, 60_000);
});
