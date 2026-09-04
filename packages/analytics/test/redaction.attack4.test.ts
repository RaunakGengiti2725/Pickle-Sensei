import { describe, expect, it } from "vitest";
import {
  MAX_ANALYTICS_STRING_LENGTH,
  findPrivacyViolations,
  type AnalyticsEvent,
} from "../src/index.js";

/**
 * Adversarial pass 3 (tester #4) — redaction-guard boundary probes.
 *
 * Every case pins the guard's verdict on a value that sits exactly on a
 * boundary or on a spelling the regexes were not obviously written for.
 * The verdicts are deterministic and pure, so a change to any of them means
 * the redaction contract moved — the assertion below IS the contract.
 */

function eventWith(label: string): AnalyticsEvent {
  return {
    name: "analysis_failed",
    at: "2026-09-04T00:00:00.000Z",
    failureKind: label,
  } as unknown as AnalyticsEvent;
}

function rules(label: string): string[] {
  return findPrivacyViolations(eventWith(label))
    .map((v) => v.rule)
    .sort();
}

describe("findPrivacyViolations — boundary pins (attack pass 3)", () => {
  it("exactly MAX (200) chars of plain letters passes; 201 is oversized_string", () => {
    expect(MAX_ANALYTICS_STRING_LENGTH).toBe(200);
    // 'x' repeated is not base64-shaped? It IS: [A-Za-z0-9+/]{120,} matches any
    // 120+ run of letters. So use a value with spaces every 40 chars to stay
    // below the base64 threshold while hitting the length boundary exactly.
    const chunk = "abcdefghij klmnopqrst uvwxyzabcd efghijklmn "; // 44 chars
    const exact200 = (chunk.repeat(5) + "q".repeat(20)).slice(0, 200);
    expect(exact200.length).toBe(200);
    expect(rules(exact200)).toEqual([]);
    const over201 = exact200 + "z";
    expect(over201.length).toBe(201);
    expect(rules(over201)).toEqual(["oversized_string"]);
  });

  it("a 200-char unbroken alphanumeric run is flagged as base64_blob (not oversized)", () => {
    // Length is legal, but 120+ unbroken base64 alphabet chars is a blob.
    const run = "a".repeat(200);
    expect(rules(run)).toEqual(["base64_blob"]);
    expect(rules("a".repeat(119))).toEqual([]);
    expect(rules("a".repeat(120))).toEqual(["base64_blob"]);
  });

  it("uppercase 'S3://bucket/key' is flagged as uri_scheme (regex is case-insensitive)", () => {
    expect(rules("S3://pickle-media/clip.mp4")).toEqual(["uri_scheme"]);
    expect(rules("s3://pickle-media/clip.mp4")).toEqual(["uri_scheme"]);
    // '/var' preceded by '/' does not satisfy FILESYSTEM_PATH's leading-boundary
    // class, so only the scheme rule fires — pinned.
    expect(rules("FILE:///var/mobile/x.mov")).toEqual(["uri_scheme"]);
    expect(rules("CONTENT://media/external/video/1")).toEqual(["uri_scheme"]);
  });

  it("REPRO: URL-safe base64 (- and _) is NOT flagged by base64_blob", () => {
    // RFC 4648 §5 alphabet uses '-' and '_' instead of '+' and '/'. The guard's
    // BASE64_BLOB regex only knows the standard alphabet, so a 200-char
    // URL-safe blob with a '-' or '_' every <120 chars sails through. This
    // test pins the current verdict so a fix is a deliberate contract change.
    // Seeded LCG so the blob is reproducible (seed 0x5eed).
    let state = 0x5eed;
    const bytes = Buffer.alloc(150);
    for (let i = 0; i < bytes.length; i += 1) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      bytes[i] = (state >>> 16) & 0xff;
    }
    const urlSafe = bytes.toString("base64url");
    expect(urlSafe).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(urlSafe.length).toBe(200);
    expect(urlSafe).toMatch(/[-_]/);
    const standard = bytes.toString("base64");
    // The SAME 150 bytes in the standard alphabet ARE flagged…
    expect(rules(standard)).toEqual(["base64_blob"]);
    // …but in the URL-safe alphabet the verdict depends on the longest run
    // between '-'/'_' characters. Pin the exact verdict for this seed.
    // For seed 0x5eed: 5 separators, longest run 64 → NOT flagged (VERIFIED 4d812e1a).
    const longestRun = Math.max(...urlSafe.split(/[-_]/).map((s) => s.length));
    expect(longestRun).toBe(64);
    expect(rules(urlSafe)).toEqual([]);
  });

  it("REPRO: URL-safe base64 with a '-' every 119 chars evades the guard", () => {
    // Worst case: separators every 119 chars keep every standard-alphabet run
    // under the 120 threshold while the whole thing is 200 chars of payload.
    const evasive = "A".repeat(119) + "-" + "B".repeat(80);
    expect(evasive.length).toBe(200);
    expect(rules(evasive)).toEqual([]);
  });

  it.fails(
    "EXPECTED: a 200-char URL-safe base64 payload is flagged as base64_blob (BROKEN, P3)",
    () => {
      // Same 150 bytes as above, base64url-encoded. The standard-alphabet
      // encoding of these bytes IS flagged; only the alphabet differs.
      let state = 0x5eed;
      const bytes = Buffer.alloc(150);
      for (let i = 0; i < bytes.length; i += 1) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        bytes[i] = (state >>> 16) & 0xff;
      }
      expect(rules(bytes.toString("base64url"))).toEqual(["base64_blob"]);
    },
  );

  it("a standard-alphabet blob with '=' padding is still caught", () => {
    expect(rules("Q".repeat(118) + "==")).toEqual([]); // 118 < 120 run: allowed by design
    expect(rules("Q".repeat(120) + "==")).toEqual(["base64_blob"]);
  });

  it("data: URI with a short payload is flagged by uri_scheme even below the blob threshold", () => {
    expect(rules("data://image/png;base64,iVBORw0KGgo")).toEqual(["uri_scheme"]);
    // 'data:image/png;base64,...' (no slashes after the colon) — pin whatever the guard says.
    // URI_SCHEME requires ':/' or '://' so the RFC 2397 form is NOT caught.
    expect(rules("data:image/png;base64,iVBORw0KGgo")).toEqual([]);
  });
});
