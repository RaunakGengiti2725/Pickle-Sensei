import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFixtureVisionProviderSet } from "./support/fixtureProvider.js";

/**
 * Structural audit (pass 1) — I15 production guard, NODE_ENV branch.
 * The existing suite only exercises PICKLE_ENV; this pins the documented
 * fallback to NODE_ENV and its precedence.
 */

const saved = { pickle: process.env["PICKLE_ENV"], node: process.env["NODE_ENV"] };

function restore(name: "PICKLE_ENV" | "NODE_ENV", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  delete process.env["PICKLE_ENV"];
  delete process.env["NODE_ENV"];
});

afterEach(() => {
  restore("PICKLE_ENV", saved.pickle);
  restore("NODE_ENV", saved.node);
});

describe("audit: FixtureVisionProvider production guard — NODE_ENV fallback", () => {
  it("refuses when only NODE_ENV=production is set", () => {
    process.env["NODE_ENV"] = "production";
    expect(() => createFixtureVisionProviderSet("forehand_drive")).toThrow(/production/i);
  });

  it("PICKLE_ENV takes precedence over NODE_ENV in both directions", () => {
    process.env["PICKLE_ENV"] = "development";
    process.env["NODE_ENV"] = "production";
    expect(() => createFixtureVisionProviderSet("forehand_drive")).not.toThrow();

    process.env["PICKLE_ENV"] = "production";
    process.env["NODE_ENV"] = "test";
    expect(() => createFixtureVisionProviderSet("forehand_drive")).toThrow(/production/i);
  });

  it("constructs when neither variable is set (local tooling default)", () => {
    expect(() => createFixtureVisionProviderSet("forehand_drive")).not.toThrow();
  });

  it("an EMPTY PICKLE_ENV does not disable the NODE_ENV=production refusal", () => {
    process.env["PICKLE_ENV"] = "";
    process.env["NODE_ENV"] = "production";
    expect(() => createFixtureVisionProviderSet("forehand_drive")).toThrow(/production/i);
  });
});
