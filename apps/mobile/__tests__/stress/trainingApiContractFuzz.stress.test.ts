/**
 * STRESS — unit `mod-training` (training/api), lens `failure-injection`,
 * payload dimension.
 *
 * Two campaigns against the REAL `createTrainingApi` over an injected fetch:
 *
 *  1. Named contract violations — every single-field corruption the server
 *     model knows for every route (UUID/ISO/HTTPS/enum/shape/consistency
 *     rules, list item index rotated) MUST be rejected as a retryable
 *     `training.invalid_response`; the healthy body for the same route MUST
 *     parse. Nothing partially parsed may escape.
 *
 *  2. Seeded structural fuzz — a healthy body mutated at random depth
 *     (delete key, primitive swap, null, wrap in array, truncate list,
 *     duplicate item, huge string, NaN-ish numerics, prototype-looking keys).
 *     The parser may accept or reject, but it must NEVER throw anything but a
 *     `TrainingError`, and whatever it accepts must round-trip the contract
 *     (UUID ids, ISO dates, https media, plan item kind/drill consistency).
 *
 * Replay:   STRESS_SEEDS=<seed> npx jest --ci __tests__/stress/trainingApiContractFuzz
 * Campaign: STRESS_ITER=5000 npx jest --ci __tests__/stress/trainingApiContractFuzz
 */
import {
  buildResultTable,
  iterationCount,
  makeResponse,
  ROUTE_KINDS,
  rngFor,
  seedsFor,
  writeResultTable,
  type IterationRecord,
  type Rng,
  type RouteKind,
} from '../../test-support/stress/failureInjectionHarness';
import {
  createTrainingServerModel,
  DRILLS,
  IDS,
  malformedVariants,
} from '../../test-support/stress/trainingServerModel';
import {
  createTrainingApi,
  type CatalogTrainingApi,
} from '../../src/training/api';
import {
  TrainingError,
  type DrillDetail,
  type TrainingPlan,
} from '../../src/training/types';

const BASE_SEED = 0x7a11_0002;
const BASE_URL = 'https://training.test.invalid';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Routes whose response body the api parses (DELETE ignores its body). */
const PARSED_ROUTES = ROUTE_KINDS.filter(route => route !== 'unsave');

function urlFor(route: RouteKind): string {
  switch (route) {
    case 'saved-list':
      return `${BASE_URL}/v1/me/saved-drills`;
    case 'detail':
      return `${BASE_URL}/v1/catalog/drills/${DRILLS[1].slug}`;
    case 'plan-current':
      return `${BASE_URL}/v1/training-plans/current`;
    case 'plan-create':
      return `${BASE_URL}/v1/training-plans`;
    case 'plan-reassess':
      return `${BASE_URL}/v1/training-plans/${IDS.plan}/reassessment`;
    case 'save':
      return `${BASE_URL}/v1/me/saved-drills/${DRILLS[1].slug}`;
    case 'unsave':
      return `${BASE_URL}/v1/me/saved-drills/${DRILLS[1].slug}`;
    case 'complete':
      return `${BASE_URL}/v1/drill-completions`;
    case 'catalog':
      return `${BASE_URL}/v1/catalog/drills`;
  }
}

function call(api: CatalogTrainingApi, route: RouteKind): Promise<unknown> {
  switch (route) {
    case 'saved-list':
      return api.listSavedDrills();
    case 'detail':
      return api.getDrill(DRILLS[1].slug);
    case 'plan-current':
      return api.getCurrentPlan();
    case 'plan-create':
      return api.createPlan(IDS.sourceShot);
    case 'plan-reassess':
      return api.reassessPlan(IDS.plan, IDS.reassessShot);
    case 'save':
      return api.saveDrill(DRILLS[1].slug);
    case 'unsave':
      return api.unsaveDrill(DRILLS[1].slug);
    case 'complete':
      return api.completeDrill({
        id: IDS.completion,
        trainingPlanItemId: IDS.item2,
        drillSlug: DRILLS[1].slug,
        completedAt: '2026-09-04T18:00:00.000Z',
        actualRepetitions: 24,
        actualDurationSeconds: null,
      });
    case 'catalog':
      return api.listCatalogDrills({});
  }
}

/** An api whose every response is `body` (status 200). */
function apiServing(body: unknown): CatalogTrainingApi {
  return createTrainingApi({
    baseUrl: BASE_URL,
    token: 'fuzz',
    fetchFn: () => Promise.resolve(makeResponse(200, body)),
  });
}

type Settled =
  | { kind: 'ok'; value: unknown }
  | { kind: 'training-error'; error: TrainingError }
  | { kind: 'foreign-error'; error: unknown };

async function settle(promise: Promise<unknown>): Promise<Settled> {
  try {
    return { kind: 'ok', value: await promise };
  } catch (error) {
    return error instanceof TrainingError
      ? { kind: 'training-error', error }
      : { kind: 'foreign-error', error };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

// ─── Contract audit of accepted values ───────────────────────────────────────

function isIso(value: unknown): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isHttps(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('https://');
}

function isNullableFinite(value: unknown): boolean {
  return (
    value === null || (typeof value === 'number' && Number.isFinite(value))
  );
}

function rawItems(raw: unknown): Json[] {
  const plan = (raw as Json | null)?.['plan'];
  const items = (plan as Json | null)?.['items'];
  return Array.isArray(items) ? (items as Json[]) : [];
}

function auditPlan(plan: TrainingPlan, raw: unknown, problems: string[]): void {
  if (!UUID.test(plan.id)) problems.push(`plan.id not uuid: ${plan.id}`);
  if (!isIso(plan.createdAt)) problems.push('plan.createdAt not iso');
  if (plan.completedAt !== null && !isIso(plan.completedAt)) {
    problems.push('plan.completedAt not iso');
  }
  if (!['active', 'completed', 'superseded'].includes(plan.status)) {
    problems.push(`plan.status ${plan.status}`);
  }
  if (
    typeof plan.baselineScore !== 'number' ||
    !Number.isFinite(plan.baselineScore)
  ) {
    problems.push('plan.baselineScore not finite');
  }
  const positions = new Set<number>();
  const ids = new Set<string>();
  plan.items.forEach((item, index) => {
    if (!UUID.test(item.id)) problems.push(`item.id not uuid: ${item.id}`);
    if (!Number.isSafeInteger(item.position))
      problems.push('item.position not an integer');
    if (positions.has(item.position) || ids.has(item.id)) {
      problems.push(
        `plan item duplicated (id=${item.id} position=${item.position}) accepted (api.ts parsePlan has no uniqueness check)`,
      );
    }
    positions.add(item.position);
    ids.add(item.id);
    const rawPosition = rawItems(raw)[index]?.['position'];
    if (typeof rawPosition !== 'number') {
      problems.push(
        `item.position coerced from ${JSON.stringify(rawPosition)} to ${item.position} (api.ts parsePlanItem Number())`,
      );
    }
    for (const key of [
      'targetSets',
      'targetRepetitionsPerSet',
      'targetDurationSeconds',
      'restSeconds',
    ] as const) {
      if (!isNullableFinite(item[key]))
        problems.push(`item.${key} not nullable finite`);
    }
    if (item.kind === 'reassessment' && item.drill !== null) {
      problems.push('reassessment item carries a drill');
    }
    if (item.kind !== 'reassessment' && item.drill === null) {
      problems.push(`${item.kind} item without a drill`);
    }
    if (item.completion) {
      if (!UUID.test(item.completion.id))
        problems.push('completion.id not uuid');
      if (!isIso(item.completion.completedAt))
        problems.push('completion.completedAt not iso');
    }
    if (item.drill && typeof item.drill.saved !== 'boolean') {
      problems.push('drill.saved not boolean');
    }
  });
}

function auditAccepted(
  route: RouteKind,
  value: unknown,
  raw: unknown,
  problems: string[],
): void {
  switch (route) {
    case 'saved-list':
    case 'catalog': {
      if (!Array.isArray(value)) {
        problems.push('list not an array');
        return;
      }
      for (const item of value as Array<Record<string, unknown>>) {
        if (!UUID.test(String(item['id'])))
          problems.push(`id not uuid: ${String(item['id'])}`);
        if (typeof item['slug'] !== 'string' || item['slug'].length === 0)
          problems.push('slug');
        if (route === 'saved-list' && !isIso(item['savedAt']))
          problems.push('savedAt not iso');
        if (route === 'catalog' && typeof item['saved'] !== 'boolean')
          problems.push('saved not boolean');
      }
      return;
    }
    case 'detail': {
      const detail = value as DrillDetail;
      if (!UUID.test(detail.id)) problems.push('drill.id not uuid');
      if (typeof detail.saved !== 'boolean')
        problems.push('drill.saved not boolean');
      if (typeof detail.slug !== 'string' || detail.slug.length === 0)
        problems.push('drill.slug');
      const rawMappings = ((raw as Json | null)?.['mappings'] ?? []) as Json[];
      detail.mappings.forEach((mapping, index) => {
        if (!Number.isSafeInteger(mapping.targetSets) || mapping.targetSets < 1)
          problems.push('mapping.targetSets');
        const rawSets = rawMappings[index]?.['target_sets'];
        if (typeof rawSets !== 'number') {
          problems.push(
            `mapping.targetSets coerced from ${JSON.stringify(rawSets)} to ${mapping.targetSets} (api.ts parseMapping Number())`,
          );
        }
        if (!['warmup', 'targeted'].includes(mapping.planRole))
          problems.push(`planRole ${String(mapping.planRole)}`);
        if (!Array.isArray(mapping.faultDirections))
          problems.push('mapping.faultDirections');
      });
      for (const media of detail.instructionalMedia) {
        if (!UUID.test(media.id)) problems.push('media.id not uuid');
        if (!isHttps(media.sourceUrl))
          problems.push(`media.sourceUrl ${media.sourceUrl}`);
        if (media.kind === 'embed' && !isHttps(media.embedUrl))
          problems.push('media.embedUrl not https');
        if (media.kind === 'hosted' && !isHttps(media.playbackUrl))
          problems.push('media.playbackUrl not https');
        if (media.kind === 'hosted' && !isIso(media.expiresAt))
          problems.push('media.expiresAt not iso');
        if (media.licenseUrl !== null && !isHttps(media.licenseUrl))
          problems.push('media.licenseUrl not https');
      }
      return;
    }
    case 'plan-current':
      if (value === null) return;
      return auditPlan(value as TrainingPlan, raw, problems);
    case 'plan-create':
    case 'plan-reassess':
      return auditPlan(value as TrainingPlan, raw, problems);
    case 'complete': {
      const completion = value as {
        id: string;
        completedAt: string;
        qualifiesForStreak: unknown;
      };
      if (!UUID.test(completion.id)) problems.push('completion.id not uuid');
      if (!isIso(completion.completedAt))
        problems.push('completion.completedAt not iso');
      if (typeof completion.qualifiesForStreak !== 'boolean')
        problems.push('qualifiesForStreak not boolean');
      return;
    }
    case 'save':
    case 'unsave':
      return;
  }
}

// ─── Structural fuzz ─────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

// Only values JSON.parse can actually produce: the wire cannot carry NaN,
// Infinity or undefined, so injecting them would test nothing real.
const PRIMITIVES: readonly unknown[] = [
  null,
  0,
  -1,
  1.5,
  1e308,
  '',
  ' ',
  'true',
  'null',
  '1',
  true,
  false,
  [],
  {},
  'x'.repeat(10_000),
  '2026-13-45T99:99:99Z',
  'not-a-uuid',
  'https://',
  'http://insecure.example/x',
  'javascript:alert(1)',
  '__proto__',
];

function paths(
  value: unknown,
  prefix: Array<string | number> = [],
): Array<Array<string | number>> {
  if (Array.isArray(value)) {
    return [
      prefix,
      ...value.flatMap((item, index) => paths(item, [...prefix, index])),
    ];
  }
  if (value !== null && typeof value === 'object') {
    return [
      prefix,
      ...Object.entries(value as Json).flatMap(([key, item]) =>
        paths(item, [...prefix, key]),
      ),
    ];
  }
  return [prefix];
}

function getAt(root: unknown, path: Array<string | number>): unknown {
  let cursor = root;
  for (const key of path) cursor = (cursor as Json)[String(key)];
  return cursor;
}

function setAt(
  root: unknown,
  path: Array<string | number>,
  value: unknown,
): unknown {
  if (path.length === 0) return value;
  const parent = getAt(root, path.slice(0, -1)) as Json | unknown[];
  const key = path[path.length - 1]!;
  if (Array.isArray(parent)) parent[Number(key)] = value;
  else parent[String(key)] = value;
  return root;
}

function deleteAt(root: unknown, path: Array<string | number>): unknown {
  if (path.length === 0) return undefined;
  const parent = getAt(root, path.slice(0, -1)) as Json | unknown[];
  const key = path[path.length - 1]!;
  if (Array.isArray(parent)) parent.splice(Number(key), 1);
  else delete parent[String(key)];
  return root;
}

const FUZZ_OPS = [
  'delete',
  'primitive',
  'null',
  'wrap-array',
  'truncate-list',
  'duplicate-item',
  'rename-key',
  'proto-key',
] as const;
type FuzzOp = (typeof FUZZ_OPS)[number];

function fuzz(
  rng: Rng,
  healthy: unknown,
  ops: number,
): { body: unknown; script: string[] } {
  let body: unknown = JSON.parse(JSON.stringify(healthy));
  const script: string[] = [];
  for (let i = 0; i < ops; i += 1) {
    const candidates = paths(body).filter(path => path.length > 0);
    if (candidates.length === 0) break;
    const path = rng.pick(candidates);
    const op: FuzzOp = rng.pick(FUZZ_OPS);
    const current = getAt(body, path);
    const label = path.join('.');
    switch (op) {
      case 'delete':
        body = deleteAt(body, path);
        script.push(`delete ${label}`);
        break;
      case 'primitive': {
        const value = rng.pick(PRIMITIVES);
        body = setAt(body, path, value);
        script.push(
          `${label} = ${typeof value === 'string' ? JSON.stringify(value.slice(0, 24)) : String(value)}`,
        );
        break;
      }
      case 'null':
        body = setAt(body, path, null);
        script.push(`${label} = null`);
        break;
      case 'wrap-array':
        body = setAt(body, path, [current]);
        script.push(`${label} = [${label}]`);
        break;
      case 'truncate-list':
        if (Array.isArray(current) && current.length > 0) {
          body = setAt(body, path, current.slice(0, rng.int(current.length)));
          script.push(`${label} truncated`);
        }
        break;
      case 'duplicate-item':
        if (Array.isArray(current) && current.length > 0) {
          body = setAt(body, path, [...current, current[0]]);
          script.push(`${label} += ${label}[0]`);
        }
        break;
      case 'rename-key': {
        const parent = getAt(body, path.slice(0, -1));
        if (parent && !Array.isArray(parent) && typeof parent === 'object') {
          const key = String(path[path.length - 1]);
          (parent as Json)[`${key}_`] = (parent as Json)[key];
          delete (parent as Json)[key];
          script.push(`rename ${label} → ${key}_`);
        }
        break;
      }
      case 'proto-key': {
        const parent = getAt(body, path.slice(0, -1));
        if (parent && !Array.isArray(parent) && typeof parent === 'object') {
          (parent as Json)['__proto__'] = { polluted: true };
          (parent as Json)['constructor'] = 'x';
          script.push(
            `${path.slice(0, -1).join('.') || '<root>'} += __proto__/constructor`,
          );
        }
        break;
      }
    }
  }
  return { body, script };
}

async function healthyBodyFor(route: RouteKind): Promise<unknown> {
  const model = createTrainingServerModel({
    savedSlugs: new Set([DRILLS[0].slug, DRILLS[1].slug]),
    hasPlan: true,
  });
  const requestBody =
    route === 'complete'
      ? {
          id: IDS.completion,
          completedAt: '2026-09-04T18:00:00.000Z',
          actualRepetitions: 24,
          actualDurationSeconds: null,
        }
      : route === 'plan-reassess'
        ? { shotId: IDS.reassessShot }
        : undefined;
  return model.healthy(route, urlFor(route), requestBody).json();
}

// ─── Known leniencies (each pinned by an it.failing below) ───────────────────

const KNOWN_LENIENCIES = {
  'lenient-numeric-coercion': /coerced from .* \(api\.ts parse\w+ Number\(\)\)/,
  'no-plan-item-uniqueness':
    /plan item duplicated .* \(api\.ts parsePlan has no uniqueness check\)/,
} as const;

type KnownLeniency = keyof typeof KNOWN_LENIENCIES;

/**
 * The leniency every failure of a record belongs to (the first one when a
 * record trips several), or null when any failure is outside the pinned set.
 */
function knownLeniencyFor(failures: string[]): KnownLeniency | null {
  if (failures.length === 0) return null;
  const entries = Object.entries(KNOWN_LENIENCIES) as Array<
    [KnownLeniency, RegExp]
  >;
  const matched = failures.map(
    failure =>
      entries.find(([, pattern]) => pattern.test(failure))?.[0] ?? null,
  );
  return matched.every(id => id !== null) ? matched[0]! : null;
}

// ─── Campaigns ───────────────────────────────────────────────────────────────

describe('stress: training api payload contract under injected corruption', () => {
  it('rejects every named contract violation on every parsed route and accepts the healthy body', async () => {
    const records: IterationRecord[] = [];
    for (const route of PARSED_ROUTES) {
      const healthy = await settle(
        call(apiServing(await healthyBodyFor(route)), route),
      );
      records.push({
        seed: 0,
        scenario: `${route}/healthy`,
        outcome: healthy.kind === 'ok' ? 'HELD' : 'BROKEN',
        interactions: 1,
        script: 'healthy body parses',
        failures:
          healthy.kind === 'ok'
            ? []
            : [`healthy ${route} rejected: ${describeError(healthy.error)}`],
      });
      for (let itemIndex = 0; itemIndex < DRILLS.length; itemIndex += 1) {
        const variants = malformedVariants(
          route,
          urlFor(route),
          itemIndex,
          new Set([DRILLS[0].slug, DRILLS[1].slug, DRILLS[2].slug]),
        );
        for (const variant of variants) {
          const settled = await settle(call(apiServing(variant.body), route));
          const failures: string[] = [];
          if (settled.kind === 'ok') {
            failures.push(
              `accepted ${variant.mutation}: ${JSON.stringify(settled.value).slice(0, 160)}`,
            );
          } else if (settled.kind === 'foreign-error') {
            failures.push(
              `threw non-TrainingError: ${describeError(settled.error)}`,
            );
          } else if (
            settled.error.code !== 'training.invalid_response' ||
            !settled.error.retryable
          ) {
            failures.push(
              `code=${settled.error.code} retryable=${settled.error.retryable}`,
            );
          }
          records.push({
            seed: itemIndex,
            scenario: `${route}/${variant.mutation}`,
            outcome: failures.length === 0 ? 'HELD' : 'BROKEN',
            interactions: 1,
            script: `${route} ← ${variant.mutation}`,
            failures,
          });
        }
      }
    }
    const table = buildResultTable({
      unit: 'mod-training',
      lens: 'failure-injection/contract',
      baseSeed: 0,
      results: records,
      faultOf: record => record.scenario.split('/')[1] ?? 'healthy',
    });
    const artifact = writeResultTable(
      'mod-training-contract-violations',
      table,
    );
    const broken = records.filter(record => record.outcome === 'BROKEN');
    expect({
      broken: broken.map(
        record => `${record.scenario}: ${record.failures.join('; ')}`,
      ),
      artifact,
    }).toEqual({
      broken: [],
      artifact,
    });
    // ≥ 60 distinct injected contract faults, each exercised on 3 item indexes.
    expect(
      new Set(records.map(record => record.scenario)).size,
    ).toBeGreaterThanOrEqual(60);
  });

  it('never throws a non-TrainingError under seeded structural fuzz and audits everything it accepts', async () => {
    const seeds = seedsFor(BASE_SEED, iterationCount(600));
    const records: Array<IterationRecord & { known: KnownLeniency | null }> =
      [];
    let accepted = 0;
    for (const seed of seeds) {
      const rng = rngFor(seed);
      const route = rng.pick(PARSED_ROUTES);
      const { body, script } = fuzz(
        rng,
        await healthyBodyFor(route),
        1 + rng.int(4),
      );
      const settled = await settle(call(apiServing(body), route));
      const failures: string[] = [];
      if (settled.kind === 'foreign-error') {
        failures.push(
          `threw non-TrainingError: ${describeError(settled.error)}`,
        );
      } else if (settled.kind === 'training-error') {
        if (settled.error.code !== 'training.invalid_response') {
          failures.push(`unexpected code ${settled.error.code}`);
        }
      } else {
        accepted += 1;
        auditAccepted(route, settled.value, body, failures);
        if (route === 'save') {
          const echoed = body as Json;
          if (echoed['slug'] !== DRILLS[1].slug || echoed['saved'] !== true) {
            failures.push(
              'save accepted a body that does not confirm this slug',
            );
          }
        }
      }
      records.push({
        seed,
        scenario: `${route}/${settled.kind}`,
        outcome: failures.length === 0 ? 'HELD' : 'BROKEN',
        interactions: 1,
        script: `${route} ← ${script.join(' ; ') || '(no-op)'}`,
        failures,
        known: knownLeniencyFor(failures),
      });
    }
    const table = buildResultTable({
      unit: 'mod-training',
      lens: 'failure-injection/structural-fuzz',
      baseSeed: BASE_SEED,
      results: records,
      faultOf: record => record.scenario.split('/')[0] ?? 'unknown',
    });
    const artifact = writeResultTable('mod-training-structural-fuzz', table);
    const unexpected = records.filter(
      record => record.outcome === 'BROKEN' && record.known === null,
    );
    expect({
      unexpected: unexpected
        .slice(0, 20)
        .map(
          record =>
            `seed=${record.seed} ${record.script}: ${record.failures.join('; ')}`,
        ),
      artifact,
    }).toEqual({ unexpected: [], artifact });
    expect(records).toHaveLength(seeds.length);
    // Some fuzzed bodies stay valid (e.g. a dropped optional key); that is fine
    // as long as they were audited, but the campaign must not be all-accept.
    expect(accepted).toBeLessThan(records.length);
  });

  // `it.failing` inverts the verdict: these PASS while the leniency reproduces
  // and FAIL the day it is fixed, so nothing is hidden or silently forgotten.
  it.failing(
    'KNOWN LENIENT lenient-numeric-coercion: a plan item whose position is null/"2"/[2]/true is rejected',
    async () => {
      const healthy = (await healthyBodyFor('plan-current')) as Json;
      const outcomes: string[] = [];
      for (const position of [null, '2', [2], true, '']) {
        const body = JSON.parse(JSON.stringify(healthy)) as Json;
        ((body['plan'] as Json)['items'] as Json[])[0]!['position'] = position;
        const settled = await settle(call(apiServing(body), 'plan-current'));
        outcomes.push(
          settled.kind === 'ok'
            ? `${JSON.stringify(position)}→${(settled.value as TrainingPlan).items[0]!.position}`
            : `${JSON.stringify(position)}→rejected`,
        );
      }
      expect(outcomes).toEqual(
        outcomes.map(outcome => `${outcome.split('→')[0]}→rejected`),
      );
    },
  );

  it.failing(
    'KNOWN LENIENT no-plan-item-uniqueness: a plan repeating an item id/position is rejected',
    async () => {
      const healthy = (await healthyBodyFor('plan-current')) as Json;
      const items = (healthy['plan'] as Json)['items'] as Json[];
      items.push(JSON.parse(JSON.stringify(items[0])) as Json);
      const settled = await settle(call(apiServing(healthy), 'plan-current'));
      expect(
        settled.kind === 'ok'
          ? `accepted ${(settled.value as TrainingPlan).items.length} items`
          : 'rejected',
      ).toBe('rejected');
    },
  );

  it.failing(
    'KNOWN LENIENT lenient-numeric-coercion: a mapping whose target_sets is "3"/[3]/true is rejected',
    async () => {
      const healthy = (await healthyBodyFor('detail')) as Json;
      const outcomes: string[] = [];
      for (const sets of ['3', [3], true]) {
        const body = JSON.parse(JSON.stringify(healthy)) as Json;
        (body['mappings'] as Json[])[0]!['target_sets'] = sets;
        const settled = await settle(call(apiServing(body), 'detail'));
        outcomes.push(
          settled.kind === 'ok'
            ? `${JSON.stringify(sets)}→${(settled.value as DrillDetail).mappings[0]!.targetSets}`
            : `${JSON.stringify(sets)}→rejected`,
        );
      }
      expect(outcomes).toEqual(
        outcomes.map(outcome => `${outcome.split('→')[0]}→rejected`),
      );
    },
  );
});
