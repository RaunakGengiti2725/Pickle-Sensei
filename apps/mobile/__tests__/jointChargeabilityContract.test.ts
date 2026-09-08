// Mobile consumer of the shared joint-chargeability contract fixture table
// (packages/shared-types/fixtures/chargeability/joint-chargeability-v1.json).
// The app decides through the same @pickle/shared-types module the Edge
// function and the SQL fixtures pin, so the three planes cannot drift on when
// an outcome consumes a credit: only when BOTH the mechanics score AND the
// benchmark range are independently validated AND durably delivered once.

import {
  CHARGEABILITY_FIXTURE_CATEGORIES,
  CHARGEABLE_REASON_CODE,
  JOINT_CHARGEABILITY_CONTRACT_VERSION,
  JOINT_CHARGEABILITY_FIXTURE_SCHEMA_VERSION,
  NON_CHARGEABLE_REASON_CODES,
  decideChargeability,
  isChargeableAnalysis,
  parseChargeabilityFixtureTable,
  type ChargeabilityFixtureTable,
} from '@pickle/shared-types';

declare const require: (id: string) => unknown;
declare const __dirname: string;
const { readFileSync } = require('node:fs') as {
  readFileSync: (path: string, encoding: 'utf8') => string;
};
const { resolve } = require('node:path') as {
  resolve: (...parts: string[]) => string;
};

const FIXTURE_PATH = resolve(
  __dirname,
  '../../../packages/shared-types/fixtures/chargeability/joint-chargeability-v1.json',
);

function loadTable(): ChargeabilityFixtureTable {
  const parsed = parseChargeabilityFixtureTable(
    JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')),
  );
  if (!parsed.ok) {
    throw new Error(`fixture table rejected: ${parsed.failure.code}`);
  }
  return parsed.value;
}

describe('joint-chargeability contract (mobile plane)', () => {
  const table = loadTable();

  it('consumes the versioned canonical fixture table', () => {
    expect(table.schemaVersion).toBe(
      JOINT_CHARGEABILITY_FIXTURE_SCHEMA_VERSION,
    );
    expect(table.contractVersion).toBe(JOINT_CHARGEABILITY_CONTRACT_VERSION);
    for (const category of CHARGEABILITY_FIXTURE_CATEGORIES) {
      expect(
        table.cases.filter(entry => entry.category === category).length,
      ).toBeGreaterThan(0);
    }
  });

  it('reaches the same verdict as the shared contract for every case', () => {
    for (const entry of table.cases) {
      const decision = decideChargeability(entry.outcome, entry.eligibility);
      expect({ id: entry.id, ...decision }).toEqual({
        id: entry.id,
        contractVersion: JOINT_CHARGEABILITY_CONTRACT_VERSION,
        chargeable: entry.expected.chargeable,
        reasonCode: entry.expected.reasonCode,
        creditsConsumed: entry.expected.creditsConsumed,
      });
      expect(isChargeableAnalysis(entry.outcome, entry.eligibility)).toBe(
        entry.expected.chargeable,
      );
    }
  });

  it('never consumes a credit for partial, failed, withheld or replayed outcomes', () => {
    const nonChargeable = table.cases.filter(
      entry => entry.category !== 'chargeable',
    );
    expect(nonChargeable.length).toBeGreaterThan(0);
    for (const entry of nonChargeable) {
      const decision = decideChargeability(entry.outcome, entry.eligibility);
      expect({ id: entry.id, ...decision }).toMatchObject({
        chargeable: false,
        creditsConsumed: 0,
      });
      expect(decision.reasonCode).not.toBe(CHARGEABLE_REASON_CODE);
      expect(NON_CHARGEABLE_REASON_CODES).toContain(decision.reasonCode);
    }
  });

  it('charges exactly the both-outputs-delivered case', () => {
    const chargeable = table.cases.filter(
      entry => entry.category === 'chargeable',
    );
    expect(chargeable).toHaveLength(1);
    for (const entry of chargeable) {
      expect(decideChargeability(entry.outcome, entry.eligibility)).toEqual({
        contractVersion: JOINT_CHARGEABILITY_CONTRACT_VERSION,
        chargeable: true,
        reasonCode: CHARGEABLE_REASON_CODE,
        creditsConsumed: 1,
      });
    }
  });
});
