// Adversarial tests for W01-04 (candidate 654695aa) on the mobile plane:
// cross-plane drift (do mobile, Edge and shared-types really resolve the SAME
// module and the SAME fixture file?), interleaved account switch, and
// process-death/restart re-hydration of persisted outcome state. Every
// assertion is the SECURE expectation.
//   cd apps/mobile && npx jest --ci __tests__/jointChargeabilityAttack.test.ts

import {
  JOINT_CHARGEABILITY_CONTRACT_VERSION,
  JOINT_CHARGEABILITY_FIXTURE_SCHEMA_VERSION,
  NON_CHARGEABLE_REASON_CODES,
  decideChargeability,
  isChargeableAnalysis,
  parseChargeabilityFixtureTable,
  type ChargeabilityFixtureCase,
} from '@pickle/shared-types';

declare const require: (id: string) => unknown;
declare const __dirname: string;
const { readFileSync, existsSync, realpathSync } = require('node:fs') as {
  readFileSync: (path: string, encoding: 'utf8') => string;
  existsSync: (path: string) => boolean;
  realpathSync: (path: string) => string;
};
const { resolve, dirname } = require('node:path') as {
  resolve: (...parts: string[]) => string;
  dirname: (path: string) => string;
};

const REPO_ROOT = resolve(__dirname, '../../..');
const FIXTURE_PATH = resolve(
  REPO_ROOT,
  'packages/shared-types/fixtures/chargeability/joint-chargeability-v1.json',
);
const CANONICAL_MODULE = resolve(
  REPO_ROOT,
  'packages/shared-types/src/chargeability.ts',
);

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, 'utf8')) as JsonObject;
}

function loadCases(): ChargeabilityFixtureCase[] {
  const parsed = parseChargeabilityFixtureTable(readJson(FIXTURE_PATH));
  if (!parsed.ok) {
    throw new Error(`fixture table rejected: ${parsed.failure.code}`);
  }
  return parsed.value.cases;
}

function chargeableCase(): { outcome: JsonObject; eligibility: JsonObject } {
  const entry = loadCases().find(c => c.category === 'chargeable');
  if (!entry) throw new Error('no chargeable case');
  return JSON.parse(
    JSON.stringify({ outcome: entry.outcome, eligibility: entry.eligibility }),
  ) as { outcome: JsonObject; eligibility: JsonObject };
}

function importMapTarget(denoJsonPath: string): string {
  const config = readJson(denoJsonPath);
  const imports = config.imports;
  if (
    typeof imports !== 'object' ||
    imports === null ||
    Array.isArray(imports)
  ) {
    throw new Error(`${denoJsonPath} has no import map`);
  }
  const entry = Object.entries(imports).find(([specifier]) =>
    specifier.endsWith('packages/shared-types/src/chargeability.js'),
  );
  if (!entry || typeof entry[1] !== 'string') {
    throw new Error(`${denoJsonPath} does not map the chargeability module`);
  }
  return resolve(dirname(denoJsonPath), entry[1]);
}

function expectDenied(
  decision: ReturnType<typeof decideChargeability>,
  label: string,
): void {
  expect({ label, chargeable: decision.chargeable }).toEqual({
    label,
    chargeable: false,
  });
  expect({ label, credits: decision.creditsConsumed }).toEqual({
    label,
    credits: 0,
  });
  expect(NON_CHARGEABLE_REASON_CODES).toContain(decision.reasonCode);
}

describe('W01-04 attack: cross-plane drift (mobile)', () => {
  it('every Deno import map points the Edge plane at the one canonical module file', () => {
    const maps = [
      resolve(REPO_ROOT, 'deno.json'),
      resolve(REPO_ROOT, 'supabase/functions/api/deno.json'),
      resolve(REPO_ROOT, 'supabase/functions/api/__wf__/deno.json'),
    ];
    for (const map of maps) {
      const target = importMapTarget(map);
      expect(existsSync(target)).toBe(true);
      expect(realpathSync(target)).toBe(realpathSync(CANONICAL_MODULE));
    }
  });

  it('the Edge fixture consumer and the mobile consumer read the same fixture file', () => {
    const edgeTest = readFileSync(
      resolve(
        REPO_ROOT,
        'supabase/functions/api/__wf__/joint_chargeability_contract.test.ts',
      ),
      'utf8',
    );
    const match = /new URL\(\s*"([^"]+joint-chargeability-v1\.json)"/.exec(
      edgeTest,
    );
    const relative = match?.[1];
    expect(typeof relative).toBe('string');
    if (typeof relative !== 'string') return;
    const edgeFixture = resolve(
      REPO_ROOT,
      'supabase/functions/api/__wf__',
      relative,
    );
    expect(realpathSync(edgeFixture)).toBe(realpathSync(FIXTURE_PATH));
  });

  it('the module the app bundles declares the same contract version the table pins', () => {
    const table = readJson(FIXTURE_PATH);
    expect(table.contractVersion).toBe(JOINT_CHARGEABILITY_CONTRACT_VERSION);
    expect(table.schemaVersion).toBe(
      JOINT_CHARGEABILITY_FIXTURE_SCHEMA_VERSION,
    );
    const source = readFileSync(CANONICAL_MODULE, 'utf8');
    expect(source).toContain(`"${JOINT_CHARGEABILITY_CONTRACT_VERSION}"`);
  });

  it('a stale table copy claiming a different contract version is rejected by every plane', () => {
    const stale = readJson(FIXTURE_PATH);
    stale.contractVersion = 'joint-chargeability-v0';
    expect(parseChargeabilityFixtureTable(stale).ok).toBe(false);
    const staleSchema = readJson(FIXTURE_PATH);
    staleSchema.schemaVersion = 'joint-chargeability-fixtures-v0';
    expect(parseChargeabilityFixtureTable(staleSchema).ok).toBe(false);
  });
});

describe('W01-04 attack: interleaved account switch (mobile)', () => {
  it("user B's ledger verdict never charges user A's outcome (and vice versa)", () => {
    const a = chargeableCase();
    const b = chargeableCase();
    for (const key of ['ownerId', 'analysisId', 'operationId', 'captureId']) {
      b.outcome[key] = `${String(a.outcome[key])}-other-account`;
      const binding = b.eligibility.binding;
      if (
        typeof binding !== 'object' ||
        binding === null ||
        Array.isArray(binding)
      ) {
        throw new Error('binding missing');
      }
      binding[key] = `${String(a.outcome[key])}-other-account`;
    }
    expect(decideChargeability(a.outcome, a.eligibility).chargeable).toBe(true);
    expect(decideChargeability(b.outcome, b.eligibility).chargeable).toBe(true);
    const crossed1 = decideChargeability(a.outcome, b.eligibility);
    expectDenied(crossed1, 'outcome A with eligibility B');
    expect(crossed1.reasonCode).toBe('binding_mismatch');
    const crossed2 = decideChargeability(b.outcome, a.eligibility);
    expectDenied(crossed2, 'outcome B with eligibility A');
    expect(crossed2.reasonCode).toBe('binding_mismatch');
  });

  it('only the owner field differing (same analysis ids) is still a binding mismatch', () => {
    const { outcome, eligibility } = chargeableCase();
    const binding = eligibility.binding;
    if (
      typeof binding !== 'object' ||
      binding === null ||
      Array.isArray(binding)
    ) {
      throw new Error('binding missing');
    }
    binding.ownerId = `${String(binding.ownerId)}-signed-in-later`;
    const decision = decideChargeability(outcome, eligibility);
    expectDenied(decision, 'owner switched under same analysis');
    expect(decision.reasonCode).toBe('binding_mismatch');
  });
});

describe('W01-04 attack: process death and restart (mobile)', () => {
  it('a persisted then re-hydrated outcome decides identically; a persisted consumed ledger never re-charges', () => {
    const live = chargeableCase();
    const before = decideChargeability(live.outcome, live.eligibility);
    const persisted = JSON.stringify(live);
    const rehydrated = JSON.parse(persisted) as typeof live;
    expect(
      decideChargeability(rehydrated.outcome, rehydrated.eligibility),
    ).toEqual(before);
    rehydrated.eligibility.creditState = 'already_consumed';
    const afterRestart = decideChargeability(
      rehydrated.outcome,
      rehydrated.eligibility,
    );
    expectDenied(afterRestart, 'restart after consumption');
    expect(afterRestart.reasonCode).toBe('credit_already_consumed');
  });

  it('a crash between publication and ledger verification leaves a non-chargeable state', () => {
    const { outcome, eligibility } = chargeableCase();
    eligibility.publicationState = 'not_verified';
    const decision = decideChargeability(outcome, eligibility);
    expectDenied(decision, 'publication not verified after crash');
    expect(decision.reasonCode).toBe('publication_not_verified_once');
    const publication = outcome.publication;
    if (
      typeof publication !== 'object' ||
      publication === null ||
      Array.isArray(publication)
    ) {
      throw new Error('publication missing');
    }
    outcome.publication = { status: 'not_published' };
    expectDenied(
      decideChargeability(outcome, eligibility),
      'publication lost after crash',
    );
  });

  it('corrupt persisted rows (truncated JSON, wrong type, empty) fail closed without throwing', () => {
    const { outcome, eligibility } = chargeableCase();
    const text = JSON.stringify(outcome);
    const truncated = text.slice(0, text.length - 40);
    let parsedTruncated: unknown = undefined;
    try {
      parsedTruncated = JSON.parse(truncated);
    } catch {
      parsedTruncated = undefined;
    }
    for (const raw of [parsedTruncated, text, '', 0, [], {}, null, undefined]) {
      expect(() => decideChargeability(raw, eligibility)).not.toThrow();
      expectDenied(decideChargeability(raw, eligibility), `raw=${typeof raw}`);
      expect(isChargeableAnalysis(outcome, raw)).toBe(false);
    }
  });
});
