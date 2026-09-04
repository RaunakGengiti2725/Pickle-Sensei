import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  parsePoseSequence,
  resolveStroke,
  serializePoseSequence,
  sha256Hex,
  type PoseSequence,
} from "../src/index.js";

/**
 * STRUCTURAL AUDIT #1 (pass 1/3) — swing-domain boundary probes:
 * stroke-resolution threshold semantics, pose wire-format strictness, and
 * the SHA-256 UTF-8 fallback encoder.
 */

const MODEL = {
  providerId: "classifier.audit",
  modelVersion: "audit-1",
  runtime: "deterministic" as const,
  executionTarget: "on_device" as const,
  artifactHash: null,
};

describe("audit: resolveStroke threshold semantics", () => {
  const declared = { declared: "dink" as const };

  it("a prediction exactly at the threshold wins (inclusive ≥), just below defers to the declaration", () => {
    const at = resolveStroke(
      {
        ...declared,
        predicted: {
          shotType: "forehand_drive",
          confidence: 0.8,
          alternatives: [],
          producedBy: MODEL,
        },
      },
      { predictionConfidenceThreshold: 0.8 },
    );
    expect(at.kind).toBe("predicted");
    const below = resolveStroke(
      {
        ...declared,
        predicted: {
          shotType: "forehand_drive",
          confidence: 0.7999,
          alternatives: [],
          producedBy: MODEL,
        },
      },
      { predictionConfidenceThreshold: 0.8 },
    );
    expect(below).toEqual({ kind: "declared", shotType: "dink" });
  });

  it("a NaN prediction confidence never wins over the declaration and never invents a stroke", () => {
    const withDeclaration = resolveStroke(
      {
        ...declared,
        predicted: {
          shotType: "forehand_drive",
          confidence: Number.NaN,
          alternatives: [],
          producedBy: MODEL,
        },
      },
      { predictionConfidenceThreshold: 0.8 },
    );
    expect(withDeclaration).toEqual({ kind: "declared", shotType: "dink" });
    const alone = resolveStroke(
      {
        declared: null,
        predicted: {
          shotType: "forehand_drive",
          confidence: Number.NaN,
          alternatives: [],
          producedBy: MODEL,
        },
      },
      { predictionConfidenceThreshold: 0.8 },
    );
    expect(alone.kind).toBe("unresolved");
  });
});

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
        landmarks: [
          { name: "right_wrist", x: 0.5, y: 0.4, visibility: 0.9 },
          { name: "left_wrist", x: 0.45, y: 0.42, visibility: 0.8 },
        ],
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

describe("audit: pose wire format strictness beyond the documented cases", () => {
  it("a frame with the same landmark name twice is rejected as corrupt (ambiguous joint)", () => {
    const wire = JSON.parse(serializePoseSequence(sequence()));
    wire.frames[0].l.push({ n: "right_wrist", x: 0.9, y: 0.9, v: 0.1 });
    const parsed = parsePoseSequence(JSON.stringify(wire), PRODUCER);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.failure.kind).toBe("corrupted_media");
  });

  it("frame indices must be strictly increasing like timestamps (duplicate index rejected)", () => {
    const wire = JSON.parse(serializePoseSequence(sequence()));
    wire.frames[1].i = 0;
    const parsed = parsePoseSequence(JSON.stringify(wire), PRODUCER);
    expect(parsed.ok).toBe(false);
  });

  it("a negative frame index is rejected", () => {
    const wire = JSON.parse(serializePoseSequence(sequence()));
    wire.frames[0].i = -1;
    const parsed = parsePoseSequence(JSON.stringify(wire), PRODUCER);
    expect(parsed.ok).toBe(false);
  });

  it("control: equal consecutive timestamps are rejected as non_monotonic", () => {
    const wire = JSON.parse(serializePoseSequence(sequence()));
    wire.frames[1].t = wire.frames[0].t;
    const parsed = parsePoseSequence(JSON.stringify(wire), PRODUCER);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.failure.code).toBe("pose_sequence.non_monotonic");
  });
});

describe("audit: sha256Hex UTF-8 fallback encoder agrees with node:crypto", () => {
  const savedEncoder = (globalThis as { TextEncoder?: unknown }).TextEncoder;
  afterEach(() => {
    (globalThis as { TextEncoder?: unknown }).TextEncoder = savedEncoder;
  });

  const nodeHash = (text: string): string =>
    createHash("sha256").update(text, "utf8").digest("hex");

  it("with TextEncoder present (control): BMP, astral, and 3 MiB inputs match", () => {
    const big = "pickle-sensei-".repeat((3 * 1024 * 1024) / 14);
    for (const text of ["", "abc", "héllo wörld ✓", "😀 pickle 🏓", big]) {
      expect(sha256Hex(text)).toBe(nodeHash(text));
    }
  });

  it("without TextEncoder (exotic runtime fallback): well-formed strings match", () => {
    delete (globalThis as { TextEncoder?: unknown }).TextEncoder;
    for (const text of ["", "abc", "héllo wörld ✓", "😀 pickle 🏓", "a".repeat(1000)]) {
      expect(sha256Hex(text)).toBe(nodeHash(text));
    }
  });

  it("without TextEncoder: a lone surrogate hashes identically to the TextEncoder path", () => {
    const lone = "id-\uD800-tail";
    const viaTextEncoder = sha256Hex(lone);
    delete (globalThis as { TextEncoder?: unknown }).TextEncoder;
    const viaFallback = sha256Hex(lone);
    // A provenance hash must not depend on which JS runtime computed it.
    expect(viaFallback).toBe(viaTextEncoder);
    expect(viaTextEncoder).toBe(nodeHash(lone));
  });
});
