import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parsePoseSequence,
  resolveStroke,
  serializePoseSequence,
  sha256Hex,
  type PoseSequence,
} from "../src/index.js";

/**
 * STRUCTURAL AUDIT #2 (pass 1) — @pickle/swing-domain reproducers.
 * Failing test = finding; passing test = verified invariant.
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

const MODEL_REF = {
  providerId: "stroke.classifier",
  modelVersion: "audit-1",
  runtime: "deterministic" as const,
  executionTarget: "on_device" as const,
  artifactHash: null,
};

function predicted(confidence: number) {
  return {
    shotType: "forehand_drive" as const,
    confidence,
    alternatives: [],
    producedBy: MODEL_REF,
  };
}

const nodeSha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

describe("AUDIT sha256Hex — encoder parity", () => {
  const realTextEncoder = globalThis.TextEncoder;
  afterEach(() => {
    vi.stubGlobal("TextEncoder", realTextEncoder);
    vi.unstubAllGlobals();
  });

  it("H2-A: the fallback UTF-8 encoder (no TextEncoder runtime) matches node:crypto on BMP + astral text (verified invariant)", () => {
    const inputs = ["", "abc", "héllo wörld", "日本語テキスト", "emoji 🎾🏓", "a".repeat(1000)];
    const withEncoder = inputs.map((text) => sha256Hex(text));
    vi.stubGlobal("TextEncoder", undefined);
    const withFallback = inputs.map((text) => sha256Hex(text));
    expect(withFallback).toEqual(withEncoder);
    expect(withEncoder).toEqual(inputs.map(nodeSha256));
  });

  it("H2-B: the fallback encoder and TextEncoder agree on a lone surrogate (both must emit U+FFFD per WHATWG)", () => {
    const lone = "abc\uD800def";
    const withEncoder = sha256Hex(lone);
    vi.stubGlobal("TextEncoder", undefined);
    const withFallback = sha256Hex(lone);
    expect(withEncoder).toBe(nodeSha256(lone));
    expect(withFallback).toBe(withEncoder);
  });

  it("H2-C: multi-megabyte input matches node:crypto (verified invariant)", () => {
    const big = "pose-sidecar-".repeat(400_000); // ~5.2 MB
    expect(sha256Hex(big)).toBe(nodeSha256(big));
  });
});

describe("AUDIT resolveStroke — threshold inclusivity", () => {
  it("R2-A: a prediction exactly AT the threshold is accepted (>=), one epsilon below falls back to the declaration (verified invariant)", () => {
    const at = resolveStroke(
      { declared: "dink", predicted: predicted(0.8) },
      { predictionConfidenceThreshold: 0.8 },
    );
    expect(at).toEqual({ kind: "predicted", shotType: "forehand_drive", confidence: 0.8 });
    const below = resolveStroke(
      { declared: "dink", predicted: predicted(0.8 - 1e-12) },
      { predictionConfidenceThreshold: 0.8 },
    );
    expect(below).toEqual({ kind: "declared", shotType: "dink" });
  });

  it("R2-B: a NaN prediction confidence never wins over a declaration (verified invariant)", () => {
    const resolved = resolveStroke(
      { declared: "dink", predicted: predicted(Number.NaN) },
      { predictionConfidenceThreshold: 0.8 },
    );
    expect(resolved).toEqual({ kind: "declared", shotType: "dink" });
  });
});

describe("AUDIT parsePoseSequence — frame-structure validation", () => {
  it("P2-A: equal consecutive timestamps are rejected as non_monotonic (verified invariant)", () => {
    const wire = JSON.parse(serializePoseSequence(sequence()));
    wire.frames[1].t = wire.frames[0].t;
    const parsed = parsePoseSequence(JSON.stringify(wire), PRODUCER);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.failure.code).toBe("pose_sequence.non_monotonic");
  });

  it("P2-B: duplicate landmark names within one frame are rejected (a frame cannot have two right wrists)", () => {
    const wire = JSON.parse(serializePoseSequence(sequence()));
    wire.frames[0].l.push({ n: "right_wrist", x: 0.9, y: 0.9, v: 0.1 });
    const parsed = parsePoseSequence(JSON.stringify(wire), PRODUCER);
    console.log(
      JSON.stringify({
        audit: "P2-B duplicate landmark",
        ok: parsed.ok,
        landmarks: parsed.ok ? parsed.value.frames[0]!.landmarks : null,
      }),
    );
    expect(parsed.ok).toBe(false);
  });

  it("P2-C: frameIndex must be strictly increasing alongside timestamps (contract L17: 'malformed ... rejected rather than repaired')", () => {
    const wire = JSON.parse(serializePoseSequence(sequence()));
    wire.frames[1].i = -5;
    const parsed = parsePoseSequence(JSON.stringify(wire), PRODUCER);
    expect(parsed.ok).toBe(false);
  });

  it("P2-D: a frame confidence outside [0,1] is rejected (contract: confidence is 0..1)", () => {
    const wire = JSON.parse(serializePoseSequence(sequence()));
    wire.frames[0].c = 7;
    const parsed = parsePoseSequence(JSON.stringify(wire), PRODUCER);
    expect(parsed.ok).toBe(false);
  });
});
