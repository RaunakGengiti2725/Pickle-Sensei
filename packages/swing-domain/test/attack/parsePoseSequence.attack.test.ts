/**
 * Adversarial pass 3 / tester #4 — parsePoseSequence huge/duplicate inputs.
 *
 * Attacks:
 *  - a VALID 1 000 000-frame payload (bounded time and heap growth);
 *  - a frame with duplicate landmark names (must be a typed rejection: the
 *    canonical record is "validated hard, never repaired", and duplicate
 *    joints make every downstream `landmarks.find(name)` silently pick one);
 *  - duplicate frame indices with monotonic timestamps;
 *  - a landmark name that is only whitespace / a prototype key.
 *
 * Seeded PRNG (mulberry32, seed recorded in test names) so runs are reproducible.
 */
import { describe, expect, it } from "vitest";
import { parsePoseSequence } from "../../src/index.js";

const PRODUCER = {
  providerId: "pose.apple-vision",
  runtime: "vision_framework" as const,
  executionTarget: "on_device" as const,
  artifactHash: null,
};

const SEED = 0x5eed_0004;
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function header(): string {
  return (
    '{"schemaVersion":1,"format":"pickle.pose-sequence.v1","coordinateSystem":"normalized_image_top_left",' +
    '"poseModelVersion":"apple-vision-bodypose-1","video":{"w":1080,"h":1920,"fps":60},"frames":['
  );
}

/** Streams a 1M-frame wire payload into one string without building 1M objects first. */
function millionFrameJson(frameCount: number): string {
  const rand = mulberry32(SEED);
  const parts: string[] = [header()];
  const chunk: string[] = [];
  for (let i = 0; i < frameCount; i += 1) {
    const x = (0.4 + rand() * 0.2).toFixed(4);
    const y = (0.4 + rand() * 0.2).toFixed(4);
    chunk.push(
      `{"i":${i},"t":${i * 16.6667},"c":0.9,"l":[{"n":"right_wrist","x":${x},"y":${y},"v":0.9}]}`,
    );
    if (chunk.length === 10_000) {
      parts.push(chunk.join(","), ",");
      chunk.length = 0;
    }
  }
  if (chunk.length > 0) parts.push(chunk.join(","));
  else parts[parts.length - 1] = ""; // drop trailing comma
  parts.push("]}");
  return parts.join("");
}

function wireWithFrames(frames: unknown[]): string {
  return `${header()}${frames.map((f) => JSON.stringify(f)).join(",")}]}`;
}

describe(`[attack] parsePoseSequence — 1 000 000 valid frames (seed ${SEED})`, () => {
  it("parses in bounded time and bounded heap growth, and preserves every frame", () => {
    const FRAMES = 1_000_000;
    const json = millionFrameJson(FRAMES);
    expect(json.length).toBeGreaterThan(50 * 1024 * 1024);

    if (typeof globalThis.gc === "function") globalThis.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    const parsed = parsePoseSequence(json, PRODUCER);
    const elapsedMs = performance.now() - started;
    const heapAfter = process.memoryUsage().heapUsed;
    const heapGrowthMb = (heapAfter - heapBefore) / (1024 * 1024);

    console.log(
      `[attack] parsePoseSequence 1M frames: json=${(json.length / 1048576).toFixed(1)}MB elapsed=${elapsedMs.toFixed(0)}ms heapGrowth=${heapGrowthMb.toFixed(0)}MB`,
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.frames).toHaveLength(FRAMES);
    expect(parsed.value.frames[FRAMES - 1]?.frameIndex).toBe(FRAMES - 1);
    // Bounds: linear-time parse of ~70MB JSON must stay well under 30s and
    // must not balloon beyond ~1.5GB of heap on top of the input string.
    expect(elapsedMs).toBeLessThan(30_000);
    expect(heapGrowthMb).toBeLessThan(1536);
  }, 120_000);

  it("rejects a non-monotonic timestamp buried at frame 999 999 without partial acceptance", () => {
    const FRAMES = 1_000_000;
    const json = millionFrameJson(FRAMES);
    // Rewrite the last frame's timestamp to equal the previous one.
    const lastT = `"t":${(FRAMES - 1) * 16.6667}`;
    const idx = json.lastIndexOf(lastT);
    expect(idx).toBeGreaterThan(0);
    const corrupted = `${json.slice(0, idx)}"t":${(FRAMES - 2) * 16.6667}${json.slice(idx + lastT.length)}`;
    const parsed = parsePoseSequence(corrupted, PRODUCER);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.failure.code).toBe("pose_sequence.non_monotonic");
  }, 120_000);
});

describe("[attack] parsePoseSequence — duplicate landmark names in one frame", () => {
  const duplicateFrame = {
    i: 0,
    t: 0,
    c: 0.9,
    l: [
      { n: "right_wrist", x: 0.5, y: 0.4, v: 0.9 },
      { n: "right_wrist", x: 0.1, y: 0.1, v: 0.1 },
    ],
  };

  it("a frame containing the same landmark name twice is a typed corrupted_media rejection", () => {
    const parsed = parsePoseSequence(wireWithFrames([duplicateFrame]), PRODUCER);
    expect(
      parsed.ok,
      "duplicate landmark names were ACCEPTED — downstream find(name) silently picks one of two conflicting joints",
    ).toBe(false);
    if (parsed.ok) return;
    expect(parsed.failure.kind).toBe("corrupted_media");
    expect(parsed.failure.code).toMatch(/^pose_sequence\./);
  });

  it("duplicate names differing only by unicode normalization form are two distinct joints (documented)", () => {
    const frames = [
      {
        i: 0,
        t: 0,
        c: 0.9,
        l: [
          { n: "\u00e9", x: 0.5, y: 0.4, v: 0.9 },
          { n: "e\u0301", x: 0.1, y: 0.1, v: 0.1 },
        ],
      },
    ];
    const parsed = parsePoseSequence(wireWithFrames(frames), PRODUCER);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.frames[0]?.landmarks).toHaveLength(2);
  });

  it("prototype-key landmark names ('__proto__', 'constructor') do not corrupt the parsed record", () => {
    const frames = [
      {
        i: 0,
        t: 0,
        c: 0.9,
        l: [
          { n: "__proto__", x: 0.5, y: 0.4, v: 0.9 },
          { n: "constructor", x: 0.5, y: 0.4, v: 0.9 },
        ],
      },
    ];
    const parsed = parsePoseSequence(wireWithFrames(frames), PRODUCER);
    if (parsed.ok) {
      const names = parsed.value.frames[0]?.landmarks.map((m) => m.name);
      expect(names).toEqual(["__proto__", "constructor"]);
      expect(Object.getPrototypeOf(parsed.value.frames[0])).toBe(Object.prototype);
    }
  });

  it("landmark name that is only whitespace / a lone surrogate is preserved verbatim or rejected, never mangled", () => {
    for (const name of [" ", "\uD800", "right_wrist\u0000"]) {
      const frames = [{ i: 0, t: 0, c: 0.9, l: [{ n: name, x: 0.5, y: 0.4, v: 0.9 }] }];
      const parsed = parsePoseSequence(wireWithFrames(frames), PRODUCER);
      if (parsed.ok) expect(parsed.value.frames[0]?.landmarks[0]?.name).toBe(name);
    }
  });
});
