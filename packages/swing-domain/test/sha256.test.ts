import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { sha256Hex } from "../src/sha256.js";

describe("sha256Hex", () => {
  it("matches NIST FIPS 180-4 test vectors", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(
      sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("agrees with node:crypto across sizes and unicode, including >55-byte padding edges", () => {
    const cases = [
      "a".repeat(55),
      "a".repeat(56),
      "a".repeat(64),
      "a".repeat(1000),
      '{"schemaVersion":1,"frames":[{"t":17}]}',
      "pöse séquence ünicode ✓ 🎾",
    ];
    for (const text of cases) {
      expect(sha256Hex(text)).toBe(
        createHash("sha256").update(text, "utf8").digest("hex"),
      );
    }
  });
});
