/**
 * Adversarial pass (shared-packages-ops #1, pass 3) — consent ledger fold
 * and version gate. ALL fixtures SYNTHETIC. `it(...)` = HELD / OBSERVED
 * (pinned current behaviour); `it.fails(...)` = EXPECTED contract that is
 * currently broken.
 */
import { describe, expect, it } from "vitest";
import {
  checkConsentVersionAcceptable,
  deriveConsentStatus,
  isModelTrainingConsentActive,
  parseConsentVersionMajor,
  type ConsentRecord,
} from "../src/consent.js";

const SUBJECT = "SYNTHETIC-TEST-FIXTURE.attack-subject";

function rec(overrides: Partial<ConsentRecord>): ConsentRecord {
  return {
    id: "SYNTHETIC-TEST-FIXTURE.rec",
    subjectPseudonym: SUBJECT,
    scope: "model_training",
    action: "granted",
    consentVersion: "model-training-v1",
    source: "mobile_settings",
    device: null,
    captureMode: "all_captures",
    strokeIntent: null,
    recordedAtIso: "2026-09-04T10:00:00.000Z",
    ...overrides,
  };
}

describe("deriveConsentStatus ordering (no seq — legacy payloads)", () => {
  it("OBSERVED: recordedAtIso is compared LEXICALLY, so a grant written with a +05:00 offset that is chronologically EARLIER than a Z-suffixed withdrawal sorts AFTER it → consent stays ACTIVE", () => {
    const grant = rec({
      id: "g",
      action: "granted",
      recordedAtIso: "2026-09-04T14:00:00.000+05:00",
    }); // 09:00Z
    const withdraw = rec({
      id: "w",
      action: "withdrawn",
      recordedAtIso: "2026-09-04T10:00:00.000Z",
    }); // 10:00Z
    expect(Date.parse(grant.recordedAtIso)).toBeLessThan(Date.parse(withdraw.recordedAtIso));
    for (const order of [
      [grant, withdraw],
      [withdraw, grant],
    ]) {
      expect(isModelTrainingConsentActive(order)).toBe(true);
    }
  });

  it.fails(
    "EXPECTED: without seq, ordering follows the instant the timestamp denotes — the later withdrawal wins",
    () => {
      const grant = rec({
        id: "g",
        action: "granted",
        recordedAtIso: "2026-09-04T14:00:00.000+05:00",
      });
      const withdraw = rec({
        id: "w",
        action: "withdrawn",
        recordedAtIso: "2026-09-04T10:00:00.000Z",
      });
      expect(isModelTrainingConsentActive([grant, withdraw])).toBe(false);
    },
  );

  it("OBSERVED: the same instant in two spellings ('…00Z' vs '…00.000Z') is NOT a tie lexically — '.' < 'Z' so the millisecond-less spelling sorts LATER regardless of action", () => {
    const grant = rec({ id: "g", action: "granted", recordedAtIso: "2026-09-04T10:00:00Z" });
    const withdraw = rec({
      id: "w",
      action: "withdrawn",
      recordedAtIso: "2026-09-04T10:00:00.000Z",
    });
    expect(Date.parse(grant.recordedAtIso)).toBe(Date.parse(withdraw.recordedAtIso));
    expect(isModelTrainingConsentActive([withdraw, grant])).toBe(true);
    expect(isModelTrainingConsentActive([grant, withdraw])).toBe(true);
  });

  it("HELD: exact-tie timestamps with no seq keep ARRAY order (stable sort) — the last row in the array wins in both directions", () => {
    const grant = rec({ id: "g", action: "granted" });
    const withdraw = rec({ id: "w", action: "withdrawn" });
    expect(isModelTrainingConsentActive([grant, withdraw])).toBe(false);
    expect(isModelTrainingConsentActive([withdraw, grant])).toBe(true);
  });
});

describe("deriveConsentStatus ordering (mixed seq / no seq)", () => {
  it("OBSERVED: mixing seq-bearing and seq-less rows makes the comparator non-transitive (A<C by seq, B<A and C<B by time) — result depends on array order", () => {
    const a = rec({
      id: "a",
      seq: 1,
      action: "withdrawn",
      recordedAtIso: "2026-09-04T12:00:00.000Z",
    });
    const b = rec({ id: "b", action: "granted", recordedAtIso: "2026-09-04T11:00:00.000Z" }); // no seq
    const c = rec({
      id: "c",
      seq: 2,
      action: "withdrawn",
      recordedAtIso: "2026-09-04T10:00:00.000Z",
    });
    const outcomes = new Set<boolean>();
    const perms: ConsentRecord[][] = [
      [a, b, c],
      [a, c, b],
      [b, a, c],
      [b, c, a],
      [c, a, b],
      [c, b, a],
    ];
    for (const p of perms) outcomes.add(isModelTrainingConsentActive(p));
    // Pinned: at least one permutation lets the seq-less grant win over BOTH withdrawals.
    expect(outcomes.has(true)).toBe(true);
  });

  it.fails(
    "EXPECTED: with two withdrawals on record and one grant, no permutation of the same rows yields ACTIVE",
    () => {
      const a = rec({
        id: "a",
        seq: 1,
        action: "withdrawn",
        recordedAtIso: "2026-09-04T12:00:00.000Z",
      });
      const b = rec({ id: "b", action: "granted", recordedAtIso: "2026-09-04T11:00:00.000Z" });
      const c = rec({
        id: "c",
        seq: 2,
        action: "withdrawn",
        recordedAtIso: "2026-09-04T10:00:00.000Z",
      });
      for (const p of [
        [a, b, c],
        [a, c, b],
        [b, a, c],
        [b, c, a],
        [c, a, b],
        [c, b, a],
      ]) {
        expect(isModelTrainingConsentActive(p)).toBe(false);
      }
    },
  );

  it("HELD: with seq on EVERY row, seq order wins over any timestamp spelling or offset (10,000-row seeded shuffle)", () => {
    const rows: ConsentRecord[] = [];
    for (let i = 1; i <= 10_000; i++) {
      rows.push(
        rec({
          id: `r${i}`,
          seq: i,
          action: i === 10_000 ? "withdrawn" : "granted",
          recordedAtIso: i % 2 === 0 ? "2026-09-04T23:59:59.999+14:00" : "2026-09-04T00:00:00Z",
        }),
      );
    }
    let seed = 20260904;
    for (let i = rows.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const j = seed % (i + 1);
      [rows[i], rows[j]] = [rows[j]!, rows[i]!];
    }
    const status = deriveConsentStatus(rows).find((s) => s.scope === "model_training")!;
    expect(status.active).toBe(false);
    expect(status.lastAction).toBe("withdrawn");
  });

  it("HELD: duplicate seq values fall back to timestamp, then array order", () => {
    const g = rec({
      id: "g",
      seq: 5,
      action: "granted",
      recordedAtIso: "2026-09-04T10:00:00.000Z",
    });
    const w = rec({
      id: "w",
      seq: 5,
      action: "withdrawn",
      recordedAtIso: "2026-09-04T10:00:00.001Z",
    });
    expect(isModelTrainingConsentActive([w, g])).toBe(false);
  });

  it("HELD: NaN seq on one row is treated as present and `a.seq !== b.seq` → NaN - n = NaN comparator → falls to V8 treating NaN as 0 (tie) — pinned outcome", () => {
    const g = rec({
      id: "g",
      seq: NaN,
      action: "granted",
      recordedAtIso: "2026-09-04T09:00:00.000Z",
    });
    const w = rec({
      id: "w",
      seq: 2,
      action: "withdrawn",
      recordedAtIso: "2026-09-04T10:00:00.000Z",
    });
    // Comparator returns NaN → treated as 0 → stable order → last array element wins.
    expect(isModelTrainingConsentActive([g, w])).toBe(false);
    expect(isModelTrainingConsentActive([w, g])).toBe(true);
  });
});

describe("scope isolation & unicode", () => {
  it("HELD: a withdrawal on video_analysis never touches model_training and vice versa; evaluation_telemetry is independent too", () => {
    const rows = [
      rec({
        id: "1",
        scope: "video_analysis",
        action: "granted",
        consentVersion: "video-analysis-v1",
        seq: 1,
      }),
      rec({ id: "2", scope: "model_training", action: "granted", seq: 2 }),
      rec({
        id: "3",
        scope: "video_analysis",
        action: "withdrawn",
        consentVersion: "video-analysis-v1",
        seq: 3,
      }),
    ];
    const status = deriveConsentStatus(rows);
    expect(status.find((s) => s.scope === "video_analysis")?.active).toBe(false);
    expect(status.find((s) => s.scope === "model_training")?.active).toBe(true);
    expect(status.find((s) => s.scope === "evaluation_telemetry")).toEqual({
      scope: "evaluation_telemetry",
      active: false,
      consentVersion: null,
      lastAction: null,
      lastActionAtIso: null,
    });
  });

  it("HELD: an unknown scope string on a corrupt row is ignored (cannot grant anything)", () => {
    const rows = [
      rec({ id: "x", scope: "everything" as ConsentRecord["scope"], action: "granted", seq: 1 }),
    ];
    expect(deriveConsentStatus(rows).every((s) => !s.active)).toBe(true);
  });
});

describe("checkConsentVersionAcceptable", () => {
  it("HELD: padded major (v01), trailing whitespace/newline, unicode digits, exponent, negative and '+1' are all malformed", () => {
    for (const v of [
      "model-training-v01",
      "model-training-v1 ",
      "model-training-v1\n",
      " model-training-v1",
      "model-training-v１", // fullwidth 1
      "model-training-v1e3",
      "model-training-v-1",
      "model-training-v+1",
      "MODEL-TRAINING-V1",
      "model-training-v",
      "model-training-v1.0",
    ]) {
      expect(parseConsentVersionMajor("model_training", v)).toBeNull();
      expect(checkConsentVersionAcceptable("model_training", v, null).rejection).toBe("malformed");
    }
  });

  it("HELD: v0 is a valid contract; huge majors compare numerically and never overflow to a downgrade", () => {
    expect(parseConsentVersionMajor("model_training", "model-training-v0")).toBe(0);
    const huge = `model-training-v${"9".repeat(400)}`;
    expect(checkConsentVersionAcceptable("model_training", huge, "model-training-v1").ok).toBe(
      true,
    );
    expect(
      checkConsentVersionAcceptable("model_training", "model-training-v1", huge).rejection,
    ).toBe("downgrade");
  });

  it("OBSERVED: a malformed latestGrantedVersion on record (e.g. free text) disables the downgrade check — any well-formed request is accepted", () => {
    const r = checkConsentVersionAcceptable(
      "model_training",
      "model-training-v1",
      "totally-free-text",
    );
    expect(r).toEqual({ ok: true, rejection: null, message: null, major: 1 });
  });
});
