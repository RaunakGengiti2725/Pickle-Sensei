import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFixtureVisionProviderSet } from "./support/fixtureProvider.js";

/**
 * ADVERSARIAL PASS 3 / TESTER #2 — S7: the FixtureVisionProvider production
 * guard (test/support/fixtureProvider.ts:37-43) reads
 *   env = process.env.PICKLE_ENV ?? process.env.NODE_ENV
 * and throws when env === "production". Pin that EITHER variable alone blocks
 * construction, and probe the `??` precedence edge cases.
 *
 * Tests marked `it.fails` are REPRODUCED DEFECTS at the audited revision: the
 * body states the expected safe behaviour; vitest passes the case only while
 * the defect persists. When production is fixed, drop the `.fails` modifier.
 */

const saved: Record<"PICKLE_ENV" | "NODE_ENV", string | undefined> = {
  PICKLE_ENV: undefined,
  NODE_ENV: undefined,
};

function setEnv(name: "PICKLE_ENV" | "NODE_ENV", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  saved.PICKLE_ENV = process.env["PICKLE_ENV"];
  saved.NODE_ENV = process.env["NODE_ENV"];
});

afterEach(() => {
  setEnv("PICKLE_ENV", saved.PICKLE_ENV);
  setEnv("NODE_ENV", saved.NODE_ENV);
});

const construct = () => createFixtureVisionProviderSet("forehand_drive");

describe("S7 FixtureVisionProvider production guard — either variable blocks construction", () => {
  it("NODE_ENV=production with PICKLE_ENV unset → throws", () => {
    setEnv("PICKLE_ENV", undefined);
    setEnv("NODE_ENV", "production");
    expect(process.env["PICKLE_ENV"]).toBeUndefined();
    expect(construct).toThrow(/production/i);
  });

  it("PICKLE_ENV=production with NODE_ENV unset → throws", () => {
    setEnv("NODE_ENV", undefined);
    setEnv("PICKLE_ENV", "production");
    expect(process.env["NODE_ENV"]).toBeUndefined();
    expect(construct).toThrow(/production/i);
  });

  it("both set to production → throws", () => {
    setEnv("NODE_ENV", "production");
    setEnv("PICKLE_ENV", "production");
    expect(construct).toThrow(/production/i);
  });

  it("PICKLE_ENV=production overrides NODE_ENV=development → throws", () => {
    setEnv("NODE_ENV", "development");
    setEnv("PICKLE_ENV", "production");
    expect(construct).toThrow(/production/i);
  });

  it("both unset → constructs a fixture-tagged set (control)", () => {
    setEnv("NODE_ENV", undefined);
    setEnv("PICKLE_ENV", undefined);
    expect(construct().source).toBe("fixture");
  });

  it("rapid repeats: 100 alternating production/unset toggles never leak a construction", () => {
    setEnv("PICKLE_ENV", undefined);
    for (let index = 0; index < 100; index += 1) {
      setEnv("NODE_ENV", index % 2 === 0 ? "production" : undefined);
      if (index % 2 === 0) expect(construct).toThrow(/production/i);
      else expect(construct().source).toBe("fixture");
    }
  });

  // Documented precedence: PICKLE_ENV wins whenever it is SET. A non-production
  // PICKLE_ENV therefore masks NODE_ENV=production by design; pin it so a
  // change in precedence is a deliberate decision.
  it("documented precedence: PICKLE_ENV=development masks NODE_ENV=production (constructs)", () => {
    setEnv("NODE_ENV", "production");
    setEnv("PICKLE_ENV", "development");
    expect(construct().source).toBe("fixture");
  });

  // `??` treats the EMPTY string as set, so `PICKLE_ENV=` (exported but blank,
  // e.g. an `.env` line with no value) silences NODE_ENV=production.
  it.fails("PICKLE_ENV='' (blank) with NODE_ENV=production must still throw", () => {
    setEnv("NODE_ENV", "production");
    setEnv("PICKLE_ENV", "");
    expect(construct).toThrow(/production/i);
  });

  it("observed: PICKLE_ENV='' + NODE_ENV=production constructs the fixture set (evidence for the finding above)", () => {
    setEnv("NODE_ENV", "production");
    setEnv("PICKLE_ENV", "");
    expect(construct().source).toBe("fixture");
  });

  for (const spelling of ["Production", "PRODUCTION", " production", "production\n", "prod"]) {
    it(`observed: case/whitespace variant ${JSON.stringify(spelling)} of NODE_ENV is NOT recognised (strict equality) — constructs`, () => {
      setEnv("PICKLE_ENV", undefined);
      setEnv("NODE_ENV", spelling);
      expect(construct().source).toBe("fixture");
    });
  }
});
