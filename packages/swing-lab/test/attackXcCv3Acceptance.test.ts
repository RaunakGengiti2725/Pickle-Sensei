import { describe, expect, it } from "vitest";
import {
  aggregate,
  diffAgainstNative,
  loadGoldCases,
  runVariant,
  type GoldCase,
  type VariantRow,
  type VariantSpec,
} from "../src/fpsTemporalSegmentation.js";

/**
 * ADVERSARIAL (xc-cv::XC-CV-3 candidate 5ee6b8ea): the cluster's own
 * acceptance and "expected" text, asserted verbatim against the committed
 * Wave-A gold (Linux replay proxy, same harness the candidate ships).
 *
 *  - acceptance #1: native.matched − fps30.matched ≤ 1 and
 *    native.matched − fps24.matched ≤ 1 (the candidate measures 9 vs 4 vs 4);
 *  - expected: "≤2 ms timestamp jitter must not change event bounds by more
 *    than one native frame interval" — the candidate's lock only asserts
 *    `event_lost_vs_native`, while the harness still reports
 *    `bounds_shift_over_one_native_frame` (Δstart 402 ms on marne-serve seed 2).
 *
 * These are NOT measurement locks: they are the acceptance criteria the fix
 * claims to satisfy.
 */

const spec = (
  bundle: string,
  fps: number | null,
  extra: Partial<VariantSpec> = {},
): VariantSpec => ({
  bundle,
  fps,
  phase: 0,
  jitterMs: 0,
  dropRate: 0,
  seed: 0,
  ...extra,
});

describe("XC-CV-3 attack: acceptance criteria on the committed wave-a gold", () => {
  const cases = loadGoldCases();
  const nativeRows = new Map<string, VariantRow>();
  const native = async (gold: GoldCase) => {
    const cached = nativeRows.get(gold.bundle);
    if (cached) return cached;
    const row = await runVariant(gold, spec(gold.bundle, null));
    nativeRows.set(gold.bundle, row);
    return row;
  };

  it("acceptance #1: real 60→30 and 60→24 decimation keeps the matched gold-event count within 1 of native", async () => {
    const nativeAll = await Promise.all(cases.map((gold) => native(gold)));
    const nativeByBundle = new Map(nativeAll.map((row) => [row.spec.bundle, row]));
    const nativeMatrix = aggregate(nativeAll, nativeByBundle, "native");
    const at30 = aggregate(
      await Promise.all(cases.map((gold) => runVariant(gold, spec(gold.bundle, 30)))),
      nativeByBundle,
      30,
    );
    const at24 = aggregate(
      await Promise.all(cases.map((gold) => runVariant(gold, spec(gold.bundle, 24)))),
      nativeByBundle,
      24,
    );
    const detail = `native ${nativeMatrix.matched}, 30 fps ${at30.matched}, 24 fps ${at24.matched} of ${nativeMatrix.targetEvents}`;
    expect(nativeMatrix.matched - at30.matched, detail).toBeLessThanOrEqual(1);
    expect(nativeMatrix.matched - at24.matched, detail).toBeLessThanOrEqual(1);
  }, 180_000);

  it("expected: ≤2 ms timestamp jitter at native fps moves no matched target bound by more than one native frame (all bundles, seeds 1–3)", async () => {
    const shifts: string[] = [];
    for (const gold of cases) {
      const base = await native(gold);
      for (const seed of [1, 2, 3]) {
        const row = await runVariant(gold, spec(gold.bundle, null, { jitterMs: 2, seed }));
        for (const failure of diffAgainstNative(row, base)) {
          if (failure.kind === "bounds_shift_over_one_native_frame") {
            shifts.push(`${gold.bundle} seed ${seed}: ${failure.detail}`);
          }
        }
      }
    }
    expect(shifts, shifts.join("\n")).toEqual([]);
  }, 120_000);
});
