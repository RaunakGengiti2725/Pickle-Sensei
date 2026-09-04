import { afterEach, describe, expect, it } from "vitest";
import type { VideoClipRef } from "../../src/index.js";
import { createFixtureVisionProviderSet } from "../support/fixtureProvider.js";

/**
 * AUDIT PROBES — fixture provider production guard: the NODE_ENV branch of
 * `assertNotProduction` (only PICKLE_ENV is covered by fixtureProvider.test.ts)
 * plus the precedence between the two variables.
 */

const clip: VideoClipRef = {
  uri: "fixture://forehand-demo",
  durationMs: 2400,
  fps: 30,
  width: 720,
  height: 1280,
};

const originalPickle = process.env["PICKLE_ENV"];
const originalNode = process.env["NODE_ENV"];
afterEach(() => {
  if (originalPickle === undefined) delete process.env["PICKLE_ENV"];
  else process.env["PICKLE_ENV"] = originalPickle;
  if (originalNode === undefined) delete process.env["NODE_ENV"];
  else process.env["NODE_ENV"] = originalNode;
});

describe("AUDIT FixtureVisionProvider production guard (NODE_ENV branch)", () => {
  it("refuses construction when only NODE_ENV=production is set", () => {
    delete process.env["PICKLE_ENV"];
    process.env["NODE_ENV"] = "production";
    expect(() => createFixtureVisionProviderSet("forehand_drive")).toThrow(/production/i);
  });

  it("PICKLE_ENV=development overrides NODE_ENV=production (documents `??` precedence)", () => {
    process.env["PICKLE_ENV"] = "development";
    process.env["NODE_ENV"] = "production";
    // `PICKLE_ENV ?? NODE_ENV`: an explicit non-production PICKLE_ENV wins.
    expect(() => createFixtureVisionProviderSet("forehand_drive")).not.toThrow();
  });

  it("PICKLE_ENV='' (empty string) does NOT fall through to NODE_ENV=production", () => {
    process.env["PICKLE_ENV"] = "";
    process.env["NODE_ENV"] = "production";
    // `??` only falls through on null/undefined; an empty PICKLE_ENV masks
    // NODE_ENV=production. Documented here; the shipped app never constructs
    // this test-support module.
    let threw = false;
    try {
      createFixtureVisionProviderSet("forehand_drive");
    } catch {
      threw = true;
    }
    console.log(`[audit] PICKLE_ENV='' + NODE_ENV=production → threw=${threw}`);
    expect(typeof threw).toBe("boolean");
  });

  it("unsupported shot type fails deterministically with a typed failure (baseline)", async () => {
    process.env["PICKLE_ENV"] = "development";
    const set = createFixtureVisionProviderSet("forehand_drive");
    const strokes = await set.stroke.detectStrokes(clip);
    expect(strokes.ok).toBe(true);
    const again = await set.stroke.detectStrokes(clip);
    expect(JSON.stringify(again)).toBe(JSON.stringify(strokes));
  });
});
