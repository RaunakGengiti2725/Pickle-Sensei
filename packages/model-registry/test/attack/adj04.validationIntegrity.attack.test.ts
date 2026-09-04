/**
 * ADJ-04 adversarial: registry.ts promises (lines 516-517) that the stored
 * entry is "rebuilt from validated values". Three inputs break that promise
 * on 3dd83f33 — each is accepted by validateEntry() and lands in the
 * registry in a shape the validator would have rejected:
 *
 *  1. Getter-backed fields (validate-then-copy TOCTOU). `raw.version` is read
 *     at line 391 for the alias check and AGAIN at line 520 for the copy; a
 *     getter can answer "1.0.0" the first time and "latest" the second. Same
 *     for supportedPlatforms (413 vs 526) and every other field.
 *  2. Sparse arrays. `Array.prototype.every` (lines 416/426) skips holes, so
 *     `[, "ios"]` passes the "may only contain ios|android" check; the spread
 *     copy at 526 materialises the hole as `undefined`, and list() hands
 *     consumers `supportedPlatforms: [undefined, "ios"]`.
 *  3. promotionDate. The error text says "ISO-8601 date string" but the check
 *     is `Date.parse`, which accepts "1", "tomorrow-ish" garbage like
 *     "Sat Jan 1 2000", and rolls impossible calendar dates ("2026-02-30").
 *  4. resolve() without a stroke over a VALID manifest whose production
 *     scorers are partitioned by stroke throws AmbiguousModelResolutionError
 *     (registry.ts resolve(), `if (status === "production") throw`). The
 *     manifest passed validateCrossEntryInvariants (disjoint coverage) — the
 *     query is under-specified, not the manifest — and the only stroke-less
 *     production caller in the product is the AUTO DETECT path in
 *     apps/mobile/src/vision/providers.ts:161-163, which is typed to return
 *     an availability record, never to throw (see the mobile attack test).
 *     4d812e1a returned an entry here; 3dd83f33 throws: REGRESSION.
 *  5. ModelRegistryValidationError is built by joining EVERY problem into
 *     the message (registry.ts:118-123) and validateCrossEntryInvariants
 *     emits one problem per overlapping PAIR (O(n²)). At 4,000 overlapping
 *     production entries the join exceeds V8's max string length and the
 *     constructor escapes with a raw `RangeError: Invalid string length`
 *     after ~8s — the exact "raw engine error instead of a typed validation
 *     error" class ADJ-04 set out to eliminate.
 *
 * Every test here FAILS on 3dd83f33. 1-3 also fail on 4d812e1a (which had no
 * such checks at all) — gaps in the new guard, not regressions. 4 is a
 * regression introduced by the fix. 5: 4d812e1a accepted that manifest
 * silently (no overlap check at all), 3dd83f33 escapes with a RangeError.
 */
import { describe, expect, it } from "vitest";
import {
  AmbiguousModelResolutionError,
  ModelRegistry,
  ModelRegistryValidationError,
} from "../../src/index.js";
import { scorerEntry, thrownBy } from "./fixture.js";

/**
 * Entry whose `field` is a getter answering `honest` for every read except
 * the LAST one the constructor performs, which gets `swapped`. The number of
 * reads is measured on a dry run so the test does not depend on how many
 * times validateEntry() happens to touch the field.
 */
function lastReadSwapped<T extends object>(
  base: T,
  field: keyof T,
  honest: unknown,
  swapped: unknown,
): T {
  const probe: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  let reads = 0;
  Object.defineProperty(probe, field, {
    enumerable: true,
    configurable: true,
    get: () => {
      reads += 1;
      return honest;
    },
  });
  new ModelRegistry({ schemaVersion: 1, entries: [probe as unknown as never] });
  const total = reads;
  const armed: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  let calls = 0;
  Object.defineProperty(armed, field, {
    enumerable: true,
    configurable: true,
    get: () => (++calls === total ? swapped : honest),
  });
  return armed as T;
}

describe("ADJ-04 attack: validate-then-copy TOCTOU via getters", () => {
  it("does not store a forbidden alias version that a getter revealed only after validation", () => {
    const build = () =>
      new ModelRegistry({
        schemaVersion: 1,
        entries: [lastReadSwapped(scorerEntry({}), "version", "1.0.0", "latest")],
      });
    const error = thrownBy(build);
    if (error !== null) {
      expect(error).toBeInstanceOf(ModelRegistryValidationError);
      return;
    }
    const stored = build().resolve({ task: "technique_scoring", platform: "ios" });
    expect(stored?.version, "registry stored the post-validation value").toBe("1.0.0");
  });

  it("does not store an out-of-enum platform list that a getter swapped in after validation", () => {
    const build = () =>
      new ModelRegistry({
        schemaVersion: 1,
        entries: [
          lastReadSwapped(scorerEntry({}), "supportedPlatforms", ["ios"], ["ios", "windows-phone"]),
        ],
      });
    const error = thrownBy(build);
    if (error !== null) {
      expect(error).toBeInstanceOf(ModelRegistryValidationError);
      return;
    }
    const [stored] = build().list();
    expect(stored!.supportedPlatforms).toEqual(["ios"]);
  });

  it("does not store a bad artifact hash that a getter swapped in after validation", () => {
    const build = () =>
      new ModelRegistry({
        schemaVersion: 1,
        entries: [lastReadSwapped(scorerEntry({}), "artifactHash", "a".repeat(64), "not-a-hash")],
      });
    const error = thrownBy(build);
    if (error !== null) {
      expect(error).toBeInstanceOf(ModelRegistryValidationError);
      return;
    }
    const [stored] = build().list();
    expect(stored!.artifactHash).toBe("a".repeat(64));
  });
});

describe("ADJ-04 attack: sparse arrays slip through Array.prototype.every", () => {
  it("rejects supportedPlatforms with a hole instead of storing [undefined, 'ios']", () => {
    const platforms = new Array<"ios">(2);
    platforms[1] = "ios"; // index 0 stays a hole
    const build = () =>
      new ModelRegistry({
        schemaVersion: 1,
        entries: [scorerEntry({ supportedPlatforms: platforms })],
      });
    const error = thrownBy(build);
    if (error !== null) {
      expect(error).toBeInstanceOf(ModelRegistryValidationError);
      expect((error as Error).message).toMatch(/supportedPlatforms/);
      return;
    }
    const [stored] = build().list();
    expect(stored!.supportedPlatforms).toEqual(["ios"]);
  });

  it("rejects supportedStrokes with a hole instead of storing [undefined, 'dink']", () => {
    const strokes = new Array<"dink">(2);
    strokes[1] = "dink"; // index 0 stays a hole
    const build = () =>
      new ModelRegistry({
        schemaVersion: 1,
        entries: [scorerEntry({ supportedStrokes: strokes })],
      });
    const error = thrownBy(build);
    if (error !== null) {
      expect(error).toBeInstanceOf(ModelRegistryValidationError);
      expect((error as Error).message).toMatch(/supportedStrokes/);
      return;
    }
    const [stored] = build().list();
    expect(stored!.supportedStrokes).toEqual(["dink"]);
  });

  it("rejects a sparse array arriving through JSON-free construction of a 1-length hole", () => {
    // `new Array(1)` is a single hole: length 1 (passes the non-empty check),
    // every() visits nothing (passes the enum check).
    const build = () =>
      new ModelRegistry({
        schemaVersion: 1,
        entries: [
          scorerEntry({
            supportedPlatforms: new Array<"ios">(1),
          }),
        ],
      });
    const error = thrownBy(build);
    expect(error, "an entry with zero real platforms was accepted").toBeInstanceOf(
      ModelRegistryValidationError,
    );
  });
});

describe("ADJ-04 attack: promotionDate is not actually ISO-8601 checked", () => {
  for (const bad of ["1", "Sat Jan 1 2000", "2026-02-30", "12/31/2025"]) {
    it(`rejects promotionDate ${JSON.stringify(bad)}`, () => {
      const error = thrownBy(
        () =>
          new ModelRegistry({
            schemaVersion: 1,
            entries: [scorerEntry({ promotionDate: bad })],
          }),
      );
      expect(error, `${JSON.stringify(bad)} was accepted`).toBeInstanceOf(
        ModelRegistryValidationError,
      );
      expect((error as Error).message).toMatch(/promotionDate/);
    });
  }

  it("still accepts a real ISO-8601 timestamp (control)", () => {
    expect(
      thrownBy(
        () =>
          new ModelRegistry({
            schemaVersion: 1,
            entries: [scorerEntry({ promotionDate: "2026-01-15T00:00:00Z" })],
          }),
      ),
    ).toBeNull();
  });
});

describe("ADJ-04 attack: stroke-less resolve() over a valid stroke-partitioned manifest", () => {
  const partitioned = () =>
    new ModelRegistry({
      schemaVersion: 1,
      entries: [
        scorerEntry({ id: "scorer.dink", supportedStrokes: ["dink"] }),
        scorerEntry({ id: "scorer.serve", supportedStrokes: ["serve"] }),
      ],
    });

  it("the manifest itself is valid (precondition — disjoint production coverage)", () => {
    expect(thrownBy(partitioned)).toBeNull();
  });

  it("resolve({task, platform}) with no stroke does not throw for a manifest the validator accepted", () => {
    // 4d812e1a returned the version-newest match here. Whether the right
    // answer is `null` ("no single production scorer covers an unspecified
    // stroke") or one of the entries is a design call — throwing from a query
    // over a manifest the constructor accepted is not.
    const registry = partitioned();
    const outcome = thrownBy(() =>
      registry.resolve({ task: "technique_scoring", platform: "ios" }),
    );
    expect(
      outcome,
      "a query over a VALID manifest escaped as AmbiguousModelResolutionError",
    ).not.toBeInstanceOf(AmbiguousModelResolutionError);
    expect(outcome).toBeNull();
  });
});

describe("ADJ-04 attack: boundary size — O(n²) problem list escapes as a raw RangeError", () => {
  it("4,000 overlapping production entries are rejected with ModelRegistryValidationError, not RangeError", () => {
    const entries = Array.from({ length: 4000 }, (_, i) =>
      scorerEntry({ id: `scorer.n${i}`, version: `v${i}` }),
    );
    const error = thrownBy(() => new ModelRegistry({ schemaVersion: 1, entries }));
    expect(error, "manifest was accepted").not.toBeNull();
    expect(error, `escaped as ${(error as Error)?.constructor?.name}`).not.toBeInstanceOf(
      RangeError,
    );
    expect(error).toBeInstanceOf(ModelRegistryValidationError);
  }, 60_000);
});
