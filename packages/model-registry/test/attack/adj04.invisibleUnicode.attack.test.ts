/**
 * ADJ-04 adversarial: the near-duplicate / alias guard in registry.ts is
 * built on `/\s/` (whitespace) + `trim().toLowerCase()`. Unicode FORMAT and
 * CONTROL code points are neither whitespace nor case, so a version or id
 * carrying an invisible character (zero-width space, zero-width joiner,
 * soft hyphen, bidi override, NUL) is accepted as a *distinct*, legal label —
 * which reopens exactly the failure modes the fix claims to close:
 *   - "latest\u200b" is a forbidden alias that renders as "latest";
 *   - "sm-v1" and "sm-v1\u200b" are two entries that print identically;
 *   - a rollbackPredecessor typed with a stray invisible char is rejected as
 *     "not registered" with a message in which both keys look the same.
 *
 * EXPECTED (candidate's own contract, registry.ts lines 253-273 + 383-400):
 * ids/versions are explicit, visible, immutable labels — anything outside
 * printable, non-format characters is rejected with a
 * ModelRegistryValidationError naming the field.
 *
 * Every test here FAILS on 3dd83f33 (and on 4d812e1a — not a regression, a
 * gap in the new guard).
 */
import { describe, expect, it } from "vitest";
import { ModelRegistry, ModelRegistryValidationError } from "../../src/index.js";
import { scorerEntry, thrownBy } from "./fixture.js";

const INVISIBLE = [
  ["zero-width space", "\u200b"],
  ["zero-width joiner", "\u200d"],
  ["zero-width non-joiner", "\u200c"],
  ["soft hyphen", "\u00ad"],
  ["right-to-left override", "\u202e"],
  ["NUL", "\u0000"],
  ["word joiner", "\u2060"],
] as const;

describe("ADJ-04 attack: invisible code points in id/version", () => {
  for (const [name, ch] of INVISIBLE) {
    it(`rejects a version carrying a ${name} (U+${ch.codePointAt(0)!.toString(16).padStart(4, "0")})`, () => {
      const error = thrownBy(
        () =>
          new ModelRegistry({
            schemaVersion: 1,
            entries: [scorerEntry({ version: `sm-v1${ch}` })],
          }),
      );
      expect(error, `version "sm-v1${ch}" was accepted`).toBeInstanceOf(
        ModelRegistryValidationError,
      );
      expect((error as Error).message).toMatch(/version/);
    });

    it(`rejects an id carrying a ${name}`, () => {
      const error = thrownBy(
        () =>
          new ModelRegistry({
            schemaVersion: 1,
            entries: [scorerEntry({ id: `scorer.${ch}sm-v1` })],
          }),
      );
      expect(error, `id "scorer.${ch}sm-v1" was accepted`).toBeInstanceOf(
        ModelRegistryValidationError,
      );
      expect((error as Error).message).toMatch(/\bid\b/);
    });
  }

  it("does not let a zero-width character smuggle a forbidden version alias past the ban", () => {
    for (const alias of ["latest\u200b", "\u200blatest", "lat\u00adest", "current\u200d"]) {
      const error = thrownBy(
        () => new ModelRegistry({ schemaVersion: 1, entries: [scorerEntry({ version: alias })] }),
      );
      expect(error, JSON.stringify(alias)).toBeInstanceOf(ModelRegistryValidationError);
      expect((error as Error).message).toMatch(/version/);
    }
  });

  it("treats two versions that differ only by an invisible character as near-duplicates", () => {
    const error = thrownBy(
      () =>
        new ModelRegistry({
          schemaVersion: 1,
          entries: [
            scorerEntry({}),
            scorerEntry({ version: "sm-v1\u200b", deploymentStatus: "deprecated" }),
          ],
        }),
    );
    expect(error).toBeInstanceOf(ModelRegistryValidationError);
    expect((error as Error).message).toMatch(/Duplicate|differ only|version/);
  });

  it("treats NFC and NFD spellings of the same version as the same label", () => {
    // "vé" composed vs decomposed: identical on screen, different code points.
    const error = thrownBy(
      () =>
        new ModelRegistry({
          schemaVersion: 1,
          entries: [
            scorerEntry({ version: "v\u00e9" }),
            scorerEntry({ version: "ve\u0301", deploymentStatus: "deprecated" }),
          ],
        }),
    );
    expect(error).toBeInstanceOf(ModelRegistryValidationError);
    expect((error as Error).message).toMatch(/Duplicate|differ only|version/);
  });
});
