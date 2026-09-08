import { describe, expect, it } from "vitest";
import fixtureTable from "../../fixtures/chargeability/joint-chargeability-v1.json" with { type: "json" };
import {
  CHARGEABILITY_FIXTURE_CATEGORIES,
  CHARGEABLE_REASON_CODE,
  JOINT_CHARGEABILITY_CONTRACT_VERSION,
  JOINT_CHARGEABILITY_FIXTURE_SCHEMA_VERSION,
  NON_CHARGEABLE_REASON_CODES,
  decideChargeability,
  parseChargeabilityFixtureTable,
  type ChargeabilityFixtureCase,
  type ChargeabilityFixtureTable,
} from "../chargeability.js";
import { isChargeableAnalysis } from "../index.js";

function table(): ChargeabilityFixtureTable {
  const parsed = parseChargeabilityFixtureTable(fixtureTable);
  if (!parsed.ok) throw new Error(parsed.failure.code);
  return parsed.value;
}

function cases(category: ChargeabilityFixtureCase["category"]): ChargeabilityFixtureCase[] {
  return table().cases.filter((entry) => entry.category === category);
}

describe("joint-chargeability contract fixture table", () => {
  it("is the versioned canonical table every plane consumes", () => {
    const parsed = table();
    expect(parsed.schemaVersion).toBe(JOINT_CHARGEABILITY_FIXTURE_SCHEMA_VERSION);
    expect(parsed.contractVersion).toBe(JOINT_CHARGEABILITY_CONTRACT_VERSION);
    expect(new Set(parsed.cases.map((entry) => entry.id)).size).toBe(parsed.cases.length);
  });

  it("covers every fixture category, including partial, failed, withheld and replayed", () => {
    for (const category of CHARGEABILITY_FIXTURE_CATEGORIES) {
      expect(cases(category).length, category).toBeGreaterThan(0);
    }
    expect(cases("chargeable")).toHaveLength(1);
  });

  it("exercises every non-chargeable reason code the contract can emit", () => {
    const emitted = new Set(table().cases.map((entry) => entry.expected.reasonCode));
    for (const reasonCode of NON_CHARGEABLE_REASON_CODES) {
      expect(emitted.has(reasonCode), reasonCode).toBe(true);
    }
    expect(emitted.has(CHARGEABLE_REASON_CODE)).toBe(true);
  });

  it("charges only when both outputs are validated and durably delivered once", () => {
    for (const entry of table().cases) {
      const decision = decideChargeability(entry.outcome, entry.eligibility);
      expect(decision, entry.id).toEqual({
        contractVersion: JOINT_CHARGEABILITY_CONTRACT_VERSION,
        chargeable: entry.expected.chargeable,
        reasonCode: entry.expected.reasonCode,
        creditsConsumed: entry.expected.creditsConsumed,
      });
      expect(isChargeableAnalysis(entry.outcome, entry.eligibility), entry.id).toBe(
        entry.expected.chargeable,
      );
      expect(decision.chargeable, entry.id).toBe(entry.category === "chargeable");
    }
  });

  it("never consumes a credit for a partial, failed, withheld or replayed outcome", () => {
    for (const category of ["partial", "failed", "withheld", "replayed"] as const) {
      for (const entry of cases(category)) {
        const decision = decideChargeability(entry.outcome, entry.eligibility);
        expect(decision.chargeable, entry.id).toBe(false);
        expect(decision.creditsConsumed, entry.id).toBe(0);
        expect(decision.reasonCode, entry.id).not.toBe(CHARGEABLE_REASON_CODE);
        expect(entry.expected.creditsConsumed, entry.id).toBe(0);
      }
    }
  });

  it("fails closed on unknown input shapes", () => {
    for (const raw of [undefined, null, "complete", 1, [], Object.create({ status: "complete" })]) {
      const decision = decideChargeability(raw, raw);
      expect(decision.chargeable).toBe(false);
      expect(decision.creditsConsumed).toBe(0);
    }
  });
});

describe("parseChargeabilityFixtureTable", () => {
  interface RawTable {
    schemaVersion: string;
    contractVersion: string;
    description: string;
    cases: Array<Record<string, unknown>>;
  }
  function rawTable(): RawTable {
    return JSON.parse(JSON.stringify(fixtureTable)) as RawTable;
  }

  it("rejects a table for another contract or fixture schema version", () => {
    expect(parseChargeabilityFixtureTable({ ...rawTable(), contractVersion: "v0" }).ok).toBe(false);
    expect(parseChargeabilityFixtureTable({ ...rawTable(), schemaVersion: "v0" }).ok).toBe(false);
    expect(parseChargeabilityFixtureTable(null).ok).toBe(false);
    expect(parseChargeabilityFixtureTable({ ...rawTable(), cases: [] }).ok).toBe(false);
  });

  it("rejects cases whose expected verdict is internally inconsistent", () => {
    const consumed = rawTable();
    const first = consumed.cases[0];
    if (first === undefined) throw new Error("fixture table is empty");
    consumed.cases[0] = {
      ...first,
      expected: { ...(first.expected as object), creditsConsumed: 0 },
    };
    expect(parseChargeabilityFixtureTable(consumed).ok).toBe(false);

    const mislabelled = rawTable();
    const partial = mislabelled.cases.find((entry) => entry.category === "partial");
    if (partial === undefined) throw new Error("no partial case");
    mislabelled.cases[mislabelled.cases.indexOf(partial)] = {
      ...partial,
      expected: { chargeable: true, reasonCode: CHARGEABLE_REASON_CODE, creditsConsumed: 1 },
    };
    expect(parseChargeabilityFixtureTable(mislabelled).ok).toBe(false);

    const unknownReason = rawTable();
    unknownReason.cases[0] = {
      ...first,
      expected: { chargeable: false, reasonCode: "because", creditsConsumed: 0 },
    };
    expect(parseChargeabilityFixtureTable(unknownReason).ok).toBe(false);
  });

  it("rejects duplicate ids and unknown categories", () => {
    const duplicated = rawTable();
    const first = duplicated.cases[0];
    if (first === undefined) throw new Error("fixture table is empty");
    duplicated.cases.push({ ...first });
    expect(parseChargeabilityFixtureTable(duplicated).ok).toBe(false);

    const unknownCategory = rawTable();
    unknownCategory.cases[0] = { ...first, category: "bonus" };
    expect(parseChargeabilityFixtureTable(unknownCategory).ok).toBe(false);
  });
});
