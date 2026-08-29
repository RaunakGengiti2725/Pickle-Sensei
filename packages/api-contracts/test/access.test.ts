import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AccessStateSchema,
  AnalysisPermitFinalizeRequest,
  AnalysisPermitReserveRequest,
} from "../src/schemas.js";

describe("rating access contracts", () => {
  it("locks the free allowance to exactly two lifetime ratings", () => {
    const parsed = AccessStateSchema.parse({
      premium: false,
      entitlements: [],
      freeRatings: { limit: 2, used: 1, reserved: 0, remaining: 1, availableToReserve: 1 },
      canStartRating: true,
      paywallRequired: false,
    });
    expect(parsed.freeRatings.limit).toBe(2);
    expect(() =>
      AccessStateSchema.parse({
        ...parsed,
        freeRatings: { ...parsed.freeRatings, limit: 3 },
      }),
    ).toThrow();
  });

  it("requires idempotency keys and real rating IDs for successful finalization", () => {
    expect(AnalysisPermitReserveRequest.parse({ idempotencyKey: randomUUID() })).toBeTruthy();
    expect(
      AnalysisPermitFinalizeRequest.safeParse({ outcome: "scored", ratingId: null }).success,
    ).toBe(false);
    expect(
      AnalysisPermitFinalizeRequest.safeParse({
        outcome: "scored",
        ratingId: randomUUID(),
      }).success,
    ).toBe(true);
    expect(
      AnalysisPermitFinalizeRequest.safeParse({
        outcome: "low_confidence",
        ratingId: randomUUID(),
      }).success,
    ).toBe(false);
  });
});
