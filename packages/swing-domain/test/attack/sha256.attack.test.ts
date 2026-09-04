/**
 * Adversarial pass 3 / tester #4 — sha256Hex vs node:crypto.
 *
 * sha256Hex is the sidecar integrity check on mobile (runCaptureAnalysis.ts,
 * poseSidecar.ts): a digest disagreement means "hash mismatch → analysis
 * unavailable". Attacks: a 16 MB string, a lone high surrogate "\uD800",
 * lone low surrogate, mixed BMP/astral unicode, and the module's fallback
 * UTF-8 encoder (used when TextEncoder is absent — exotic RN runtimes) which
 * must agree with the TextEncoder path byte-for-byte or the same sidecar
 * hashes differently on two runtimes.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../src/index.js";

const nodeSha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

const SEED = 0x5eed_0009;
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

describe("[attack] sha256Hex — huge and malformed-unicode inputs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("16 MB ASCII string agrees with node:crypto and completes in bounded time", () => {
    const text = "a".repeat(16 * 1024 * 1024);
    const started = performance.now();
    const ours = sha256Hex(text);
    const elapsedMs = performance.now() - started;

    console.log(`[attack] sha256Hex 16MB: ${elapsedMs.toFixed(0)}ms`);
    expect(ours).toBe(nodeSha256(text));
    expect(elapsedMs).toBeLessThan(20_000);
  }, 60_000);

  it(`16 MB seeded pseudo-random unicode (seed ${SEED}, BMP + astral, valid pairs) agrees with node:crypto`, () => {
    const rand = mulberry32(SEED);
    const parts: string[] = [];
    let length = 0;
    const target = 16 * 1024 * 1024;
    while (length < target) {
      const roll = rand();
      let piece: string;
      if (roll < 0.7) piece = String.fromCharCode(0x20 + Math.floor(rand() * 0x5f));
      else if (roll < 0.9) piece = String.fromCharCode(0x80 + Math.floor(rand() * 0xd77f));
      else piece = String.fromCodePoint(0x10000 + Math.floor(rand() * 0xffff));
      parts.push(piece);
      length += piece.length;
    }
    const text = parts.join("");
    expect(sha256Hex(text)).toBe(nodeSha256(text));
  }, 60_000);

  it("lone high surrogate '\\uD800' does not throw and agrees with node:crypto (both emit U+FFFD)", () => {
    const text = "\uD800";
    let ours = "";
    expect(() => {
      ours = sha256Hex(text);
    }).not.toThrow();
    expect(ours).toBe(nodeSha256(text));
  });

  it("lone low surrogate, reversed pair, and surrogate at string end agree with node:crypto", () => {
    for (const text of ["\uDC00", "\uDC00\uD800", "abc\uD800", "\uD83D", "x\uD83D\uDE00\uD83D"]) {
      expect(sha256Hex(text), JSON.stringify(text)).toBe(nodeSha256(text));
    }
  });

  it("empty string and the 55/56/64-byte SHA-256 padding boundaries agree with node:crypto", () => {
    for (const n of [0, 55, 56, 63, 64, 65, 119, 120, 128]) {
      const text = "z".repeat(n);
      expect(sha256Hex(text), `length ${n}`).toBe(nodeSha256(text));
    }
  });

  it("fallback UTF-8 encoder (TextEncoder absent) agrees with node:crypto on well-formed unicode", () => {
    vi.stubGlobal("TextEncoder", undefined);
    for (const text of ["hello", "héllo", "日本語", "😀 emoji", "a\u0000b", "\u07ff\u0800\uffff"]) {
      expect(sha256Hex(text), JSON.stringify(text)).toBe(nodeSha256(text));
    }
  });

  it("fallback UTF-8 encoder agrees with node:crypto on a lone high surrogate (cross-runtime digest stability)", () => {
    vi.stubGlobal("TextEncoder", undefined);
    const text = "\uD800";
    let ours = "";
    expect(() => {
      ours = sha256Hex(text);
    }).not.toThrow();
    expect(
      ours,
      "fallback encoder emits 0xED 0xA0 0x80 (WTF-8) for a lone surrogate while TextEncoder/node emit U+FFFD — same string, two digests",
    ).toBe(nodeSha256(text));
  });
});
