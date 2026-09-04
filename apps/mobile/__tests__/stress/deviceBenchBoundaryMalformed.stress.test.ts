import fixture from '../fixtures/deviceBenchExport.fixture.json';
import {
  DEVICE_BENCH_SCHEMA_VERSION,
  DeviceBenchRecorder,
  deviceBenchExportFilename,
  validateDeviceBenchExport,
  type DeviceBenchExportV1,
} from '../../src/camera/deviceBench';
import {
  ALL_POOL,
  BOUNDARY_NUMBERS,
  campaignSeeds,
  clone,
  CONTAINERS,
  corruptJson,
  DELETE,
  describeValue,
  errorName,
  FUTURE_SCHEMA,
  GARBAGE_ROOTS,
  getAt,
  jsonStable,
  allNumbersFinite,
  allPaths,
  LOOSE_ISO,
  NULLISH,
  OutcomeTable,
  OVERSIZE_STRINGS,
  pick,
  POISON_NUMBERS,
  POISON_STRINGS,
  pollutionPayloads,
  prototypeSnapshot,
  randomInt,
  seededRandom,
  setAt,
  STRICT_ISO,
  STRESS_ITER,
  TRAVERSAL_STRINGS,
  UNICODE_STRINGS,
  type PoolValue,
  type Verdict,
} from '../../testing/stress/boundaryMalformed';

/**
 * STRESS — boundary/malformed input at the device-bench export boundary
 * (`validateDeviceBenchExport`, `DeviceBenchRecorder.finalize`,
 * `deviceBenchExportFilename`).
 *
 * Contracts under test (apps/mobile/src/camera/deviceBench.ts):
 *  - `validateDeviceBenchExport(unknown)` NEVER throws; it returns `[]` for a
 *    valid document and a non-empty list of strings otherwise;
 *  - `finalize()` returns a document the validator accepts, or throws the ONE
 *    typed error ("device-bench export invalid: …") — never anything else;
 *  - an accepted document is JSON-stable with every number finite;
 *  - Object.prototype / Array.prototype untouched afterwards.
 * Hard oracles: any untyped throw, a poison value accepted (wrong type,
 * NaN/±Infinity, negative time, non-monotonic tMs, bad enum, empty required
 * string, unexplained empty series), or a valid document rejected → BROKEN.
 * Loose cases recorded as OBSERVATION rows (the campaign's reported gaps):
 *  - `startedAtIso` is only checked for being a non-empty string, so a
 *    traversal/control string passes and `deviceBenchExportFilename` derives
 *    a filename containing `/`, `..` or NUL from it;
 *  - `clipUri` is any non-empty string (no `file:` requirement);
 *  - metadata strings are unbounded (64KB+) and may contain NUL/RTL bytes;
 *  - a document carrying its fields on the prototype chain validates but
 *    persists as `{}`;
 *  - sparse arrays (`new Array(3)`) validate because `forEach`/`some` skip
 *    holes, then fail validation after JSON persistence;
 *  - the schemaVersion error message embeds the offending value verbatim
 *    (64KB+ error detail) and JSON.stringify of a BigInt schemaVersion throws
 *    a TypeError out of the validator (BigInt cannot come from JSON, so it
 *    is recorded rather than asserted).
 *
 * Replay: STRESS_REPLAY=benchValidate:<seed> npx jest deviceBenchBoundaryMalformed
 * Scale:  STRESS_ITER=<n> (per campaign; default 60)
 */

const TYPED_PREFIX = 'device-bench export invalid: ';
const THERMAL = new Set(['nominal', 'fair', 'serious', 'critical']);

type Expectation =
  | 'must_accept'
  | 'must_reject'
  | 'observe_unparsed_iso'
  | 'observe_uri_unchecked'
  | 'observe_unbounded'
  | 'observe_control_chars'
  | 'free';

const STRING_POOL: readonly PoolValue[] = [
  ...POISON_STRINGS,
  ...OVERSIZE_STRINGS,
  ...TRAVERSAL_STRINGS,
  ...UNICODE_STRINGS,
  ...LOOSE_ISO,
  ...STRICT_ISO,
  { id: 'enum-like:"Nominal"', kind: 'poison_string', value: 'Nominal' },
  { id: 'enum-like:"fixed "', kind: 'poison_string', value: 'fixed ' },
  { id: 'enum-like:"ADAPTIVE"', kind: 'poison_string', value: 'ADAPTIVE' },
];
const NUMBER_POOL: readonly PoolValue[] = [
  ...POISON_NUMBERS,
  ...BOUNDARY_NUMBERS,
  ...FUTURE_SCHEMA,
];
const ANY_POOL: readonly PoolValue[] = [...ALL_POOL, ...NULLISH, ...CONTAINERS];

function poolFor(random: () => number, original: unknown): PoolValue {
  if (random() < 0.15) return pick(random, ANY_POOL);
  if (typeof original === 'number') return pick(random, NUMBER_POOL);
  if (typeof original === 'string') return pick(random, STRING_POOL);
  if (original === null) return pick(random, ANY_POOL);
  return pick(random, [...CONTAINERS, ...NULLISH, ...POISON_NUMBERS]);
}

const NONEMPTY_STRING_KEYS = new Set([
  'deviceModel',
  'osVersion',
  'appVersion',
]);
const CONTROL_STRING_IDS = new Set([
  'nul',
  'nul-padded',
  'rtl-override',
  'bom',
  'lone-surrogate',
]);

function isUnsafeFilename(name: string): boolean {
  return (
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\u0000') ||
    name.includes('..')
  );
}

function isEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function isFiniteNonNegative(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function stringLooseness(replacement: PoolValue): Expectation {
  if (replacement.kind === 'oversize_string') return 'observe_unbounded';
  if (CONTROL_STRING_IDS.has(replacement.id)) return 'observe_control_chars';
  return 'free';
}

/** Local expectation for replacing `path` (original value) with `replacement`. */
function expectationFor(
  path: string,
  original: unknown,
  replacement: PoolValue,
): Expectation {
  const v = replacement.value;
  if (v === DELETE) {
    // Every field the validator reads is required; unknown keys are ignored.
    return path.startsWith('__comment') ? 'must_accept' : 'must_reject';
  }
  if (path === 'schemaVersion')
    return v === DEVICE_BENCH_SCHEMA_VERSION ? 'must_accept' : 'must_reject';
  if (path.startsWith('__comment')) return 'must_accept';
  if (NONEMPTY_STRING_KEYS.has(path)) {
    if (typeof v !== 'string' || v.length === 0) return 'must_reject';
    return stringLooseness(replacement);
  }
  if (path === 'startedAtIso') {
    if (typeof v !== 'string' || v.length === 0) return 'must_reject';
    if (replacement.kind === 'strict_iso') return 'must_accept';
    return 'observe_unparsed_iso';
  }
  if (path === 'durationMs')
    return isFiniteNonNegative(v) ? 'must_accept' : 'must_reject';
  if (/^(thermal|fps|memory)$/.test(path)) return 'must_reject'; // series object replaced
  if (/^(thermal|fps|memory)\.samples$/.test(path)) return 'must_reject';
  if (/^(thermal|fps|memory)\.unavailableReason$/.test(path)) {
    // Fixture series are non-empty → the reason must stay exactly null.
    return v === null ? 'must_accept' : 'must_reject';
  }
  if (/\.samples\[\d+\]$/.test(path)) return 'must_reject';
  if (/\.samples\[\d+\]\.tMs$/.test(path)) {
    // finite ≥ 0 checked here; monotonicity is re-derived on the whole doc.
    return isFiniteNonNegative(v) ? 'must_accept' : 'must_reject';
  }
  if (/\.samples\[\d+\]\.state$/.test(path)) {
    return typeof v === 'string' && THERMAL.has(v)
      ? 'must_accept'
      : 'must_reject';
  }
  if (/\.samples\[\d+\]\.fps$/.test(path))
    return isFiniteNonNegative(v) ? 'must_accept' : 'must_reject';
  if (/\.samples\[\d+\]\.windowMs$/.test(path)) {
    return typeof v === 'number' && Number.isFinite(v) && v > 0
      ? 'must_accept'
      : 'must_reject';
  }
  if (/\.samples\[\d+\]\.footprintBytes$/.test(path)) {
    return isFiniteNonNegative(v) ? 'must_accept' : 'must_reject';
  }
  // `captures`, `notes` and `telemetrySchemas` are plain lists: empty is valid.
  if (path === 'captures')
    return isEmptyArray(v) ? 'must_accept' : 'must_reject';
  if (/^captures\[\d+\]$/.test(path)) return 'must_reject';
  if (/^captures\[\d+\]\.clipUri$/.test(path)) {
    if (typeof v !== 'string' || v.length === 0) return 'must_reject';
    if (replacement.kind === 'oversize_string') return 'observe_unbounded';
    return v.startsWith('file:') ? 'free' : 'observe_uri_unchecked';
  }
  if (/^captures\[\d+\]\.finalizedAtMs$/.test(path)) {
    return isFiniteNonNegative(v) ? 'must_accept' : 'must_reject';
  }
  if (/^captures\[\d+\]\.completionStrategy$/.test(path)) {
    return v === 'fixed' || v === 'adaptive' ? 'must_accept' : 'must_reject';
  }
  if (/^captures\[\d+\]\.telemetrySchemas$/.test(path)) {
    return isEmptyArray(v) ? 'must_accept' : 'must_reject';
  }
  if (/^captures\[\d+\]\.telemetrySchemas\[\d+\]$/.test(path)) {
    if (typeof v !== 'string' || v.length === 0) return 'must_reject';
    return stringLooseness(replacement);
  }
  if (path === 'notes') return isEmptyArray(v) ? 'must_accept' : 'must_reject';
  if (/^notes\[\d+\]$/.test(path)) {
    if (typeof v !== 'string') return 'must_reject';
    return stringLooseness(replacement);
  }
  throw new Error(
    `unmodelled path ${path} (original ${describeValue(original)})`,
  );
}

/** tMs order is a whole-document property; re-derive it after every mutation. */
function monotonicityHolds(doc: unknown): boolean {
  for (const label of ['thermal', 'fps', 'memory']) {
    const samples = getAt(doc, `${label}.samples`);
    if (!Array.isArray(samples)) return true; // reported by a structural check
    let last = -Infinity;
    for (const sample of samples as unknown[]) {
      if (typeof sample !== 'object' || sample === null) continue;
      const tMs = (sample as { tMs?: unknown }).tMs;
      if (!isFiniteNonNegative(tMs)) continue;
      if ((tMs as number) < last) return false;
      last = tMs as number;
    }
  }
  return true;
}

function combine(expectations: Expectation[]): Expectation {
  if (expectations.includes('must_reject')) return 'must_reject';
  if (expectations.every(e => e === 'must_accept')) return 'must_accept';
  const observe = expectations.find(e => e.startsWith('observe_'));
  return observe ?? 'free';
}

function carriesNonJson(value: unknown): boolean {
  if (typeof value === 'bigint' || typeof value === 'symbol') return true;
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value as Record<string, unknown>).some(
    v => typeof v === 'bigint' || typeof v === 'symbol',
  );
}

function hasArrayHoles(value: unknown, depth = 0): boolean {
  if (depth > 6 || typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (!(i in value)) return true;
      if (hasArrayHoles(value[i], depth + 1)) return true;
    }
    return false;
  }
  return Object.values(value as Record<string, unknown>).some(v =>
    hasArrayHoles(v, depth + 1),
  );
}

interface Attempt {
  threw: string | null;
  result: unknown;
}

function attempt(fn: () => unknown): Attempt {
  try {
    return { threw: null, result: fn() };
  } catch (error) {
    return { threw: errorName(error), result: undefined };
  }
}

function classifyValidation(
  expectation: Expectation,
  payload: unknown,
  run: Attempt,
  inheritedFields: boolean,
): { outcome: string; verdict: Verdict; detail?: string } {
  if (run.threw) {
    if (run.threw.startsWith('TypeError:') && carriesNonJson(payload)) {
      return {
        outcome: `threw_on_non_json_type:${run.threw}`,
        verdict: 'OBSERVATION',
      };
    }
    return { outcome: `THREW:${run.threw}`, verdict: 'BROKEN' };
  }
  const errors = run.result;
  if (!Array.isArray(errors) || errors.some(e => typeof e !== 'string')) {
    return { outcome: 'ERRORS_NOT_STRING_ARRAY', verdict: 'BROKEN' };
  }
  const longest = errors.reduce<number>(
    (max, e) => Math.max(max, (e as string).length),
    0,
  );
  if (errors.length > 0) {
    if (expectation === 'must_accept') {
      return {
        outcome: 'REJECTED_VALID',
        verdict: 'BROKEN',
        detail: errors.join('; ').slice(0, 300),
      };
    }
    if (longest > 1024) {
      return {
        outcome: 'rejected_error_detail_unbounded',
        verdict: 'OBSERVATION',
        detail: `longest=${longest}`,
      };
    }
    return {
      outcome: 'rejected_typed',
      verdict: 'HELD',
      detail: errors.join('; ').slice(0, 200),
    };
  }
  // Accepted.
  if (expectation === 'must_reject') {
    if (hasArrayHoles(payload)) {
      // `forEach`/`some` skip holes, so `[ , , ]` validates as three samples
      // and then fails validation once persisted (holes serialise as null).
      return {
        outcome: 'accepted_sparse_array_holes_rejected_after_json',
        verdict: 'OBSERVATION',
        detail: validateDeviceBenchExport(JSON.parse(JSON.stringify(payload)))
          .join('; ')
          .slice(0, 200),
      };
    }
    return { outcome: 'ACCEPTED_POISON', verdict: 'BROKEN' };
  }
  if (inheritedFields)
    return {
      outcome: 'accepted_inherited_fields_persists_empty',
      verdict: 'OBSERVATION',
    };
  if (!allNumbersFinite(payload))
    return { outcome: 'ACCEPTED_NONFINITE_NUMBER', verdict: 'BROKEN' };
  const stable = jsonStable(payload);
  if (!stable.stable)
    return {
      outcome: `ACCEPTED_NOT_JSON_STABLE:${stable.why}`,
      verdict: 'BROKEN',
    };
  const again = validateDeviceBenchExport(JSON.parse(JSON.stringify(payload)));
  if (again.length > 0)
    return { outcome: 'ACCEPTED_JSON_CLONE_REJECTED', verdict: 'BROKEN' };
  switch (expectation) {
    case 'observe_unparsed_iso': {
      const iso = getAt(payload, 'startedAtIso') as string;
      const filename = deviceBenchExportFilename(iso);
      const unsafe = isUnsafeFilename(filename) || filename.length > 255;
      return {
        outcome: unsafe
          ? 'accepted_unparsed_iso_unsafe_filename'
          : 'accepted_unparsed_iso',
        verdict: 'OBSERVATION',
        detail: `filename=${describeValue(filename)}`,
      };
    }
    case 'observe_uri_unchecked':
      return { outcome: 'accepted_clip_uri_unchecked', verdict: 'OBSERVATION' };
    case 'observe_unbounded':
      return { outcome: 'accepted_unbounded_string', verdict: 'OBSERVATION' };
    case 'observe_control_chars':
      return { outcome: 'accepted_control_chars', verdict: 'OBSERVATION' };
    default:
      return { outcome: 'accepted_closed', verdict: 'HELD' };
  }
}

const base = fixture as unknown as Record<string, unknown>;

describe('stress: device-bench boundary/malformed', () => {
  const protoBefore = prototypeSnapshot();

  it('fixture validates before mutation (precondition)', () => {
    expect(validateDeviceBenchExport(clone(base))).toEqual([]);
    expect(monotonicityHolds(base)).toBe(true);
  });

  it(`campaign benchValidate: ${STRESS_ITER} seeded malformed export documents`, () => {
    const table = new OutcomeTable('benchValidate');
    for (const seed of campaignSeeds('benchValidate')) {
      const random = seededRandom(seed);
      const doc = clone(base);
      const roll = random();
      let strategy: string;
      let input: string;
      let expectation: Expectation;
      let payload: unknown = doc;
      let inheritedFields = false;

      if (roll < 0.08) {
        strategy = 'garbage-root';
        const root = pick(random, GARBAGE_ROOTS);
        payload = root.value;
        input = `root=${root.id}`;
        expectation = 'must_reject';
      } else if (roll < 0.5) {
        strategy = 'mutate-1';
        const path = pick(random, allPaths(doc));
        const original = getAt(doc, path);
        const replacement = poolFor(random, original);
        setAt(doc, path, replacement.value);
        input = `${path}=${replacement.id}`;
        expectation = expectationFor(path, original, replacement);
      } else if (roll < 0.68) {
        strategy = 'mutate-n';
        const count = randomInt(random, 2, 4);
        const paths = allPaths(doc);
        const parts: string[] = [];
        const expectations: Expectation[] = [];
        for (let i = 0; i < count; i += 1) {
          const path = pick(random, paths);
          const original = getAt(doc, path);
          if (original === undefined) continue;
          const replacement = poolFor(random, original);
          setAt(doc, path, replacement.value);
          parts.push(`${path}=${replacement.id}`);
          expectations.push(expectationFor(path, original, replacement));
        }
        input = parts.join(' ');
        expectation = combine(expectations);
      } else if (roll < 0.76) {
        strategy = 'delete';
        const path = pick(
          random,
          allPaths(doc).filter(p => !/\[\d+\]$/.test(p)),
        );
        setAt(doc, path, DELETE);
        input = `delete ${path}`;
        expectation = path.startsWith('__comment')
          ? 'must_accept'
          : 'must_reject';
      } else if (roll < 0.82) {
        strategy = 'empty-series';
        const label = pick(random, ['thermal', 'fps', 'memory']);
        const reason = pick(random, [
          ...NULLISH,
          ...POISON_STRINGS.slice(0, 4),
          ...POISON_NUMBERS.slice(0, 5),
          {
            id: 'reason',
            kind: 'strict_iso',
            value: 'sensor unavailable',
          } as PoolValue,
        ]);
        setAt(doc, `${label}.samples`, []);
        setAt(doc, `${label}.unavailableReason`, reason.value);
        input = `${label}.samples=[] unavailableReason=${reason.id}`;
        expectation =
          typeof reason.value === 'string' && reason.value.length > 0
            ? reason.kind === 'oversize_string'
              ? 'observe_unbounded'
              : 'must_accept'
            : 'must_reject';
      } else if (roll < 0.9) {
        strategy = 'json-corrupt';
        const corrupted = corruptJson(random, doc);
        input = corrupted.id;
        if (corrupted.parseError !== null) {
          table.record({
            seed,
            strategy,
            input,
            outcome: `json_rejected:${corrupted.parseError}`,
            verdict: 'HELD',
          });
          continue;
        }
        payload = corrupted.parsed;
        expectation =
          JSON.stringify(corrupted.parsed) === JSON.stringify(base)
            ? 'must_accept'
            : 'free';
      } else if (roll < 0.96) {
        strategy = 'proto-pollution';
        const candidate = pick(random, pollutionPayloads(doc));
        payload = candidate.value;
        input = candidate.id;
        inheritedFields = candidate.id === 'proto:inherited-fields';
        expectation =
          candidate.id === 'proto:json-only' ? 'must_reject' : 'must_accept';
      } else {
        strategy = 'future-schema';
        const version = pick(random, [
          ...FUTURE_SCHEMA,
          {
            id: 'schema:v1-upper',
            kind: 'future_schema',
            value: 'PICKLE.DEVICE-BENCH.V1',
          },
          {
            id: 'schema:v1-trailing-space',
            kind: 'future_schema',
            value: `${DEVICE_BENCH_SCHEMA_VERSION} `,
          },
          {
            id: 'schema:v10',
            kind: 'future_schema',
            value: 'pickle.device-bench.v10',
          },
          {
            id: 'schema:64KB',
            kind: 'oversize_string',
            value: 'v'.repeat(65_536),
          },
          { id: 'schema:bigint', kind: 'poison_number', value: BigInt(1) },
          { id: 'schema:symbol', kind: 'poison_number', value: Symbol('v1') },
        ] as PoolValue[]);
        setAt(doc, 'schemaVersion', version.value);
        input = `schemaVersion=${version.id}`;
        expectation = 'must_reject';
      }

      if (
        payload === doc &&
        expectation !== 'must_reject' &&
        !monotonicityHolds(doc)
      ) {
        expectation = 'must_reject';
      }
      const run = attempt(() => validateDeviceBenchExport(payload));
      const c = classifyValidation(expectation, payload, run, inheritedFields);
      table.record({
        seed,
        strategy,
        input,
        outcome: c.outcome,
        verdict: c.verdict,
        detail: c.detail,
      });
    }
    const file = table.flush();
    expect({ broken: table.broken(), file }).toEqual({ broken: [], file });
  });

  it(`campaign benchRecorder: ${STRESS_ITER} seeded recorder push sequences`, () => {
    const table = new OutcomeTable('benchRecorder');
    const INIT_POOL: readonly PoolValue[] = [
      { id: 'valid', kind: 'strict_iso', value: 'iPhone16,1' },
      ...POISON_STRINGS.slice(0, 5),
      ...OVERSIZE_STRINGS.slice(0, 1),
      ...TRAVERSAL_STRINGS.slice(0, 4),
      ...UNICODE_STRINGS.slice(0, 2),
      ...NULLISH,
      ...POISON_NUMBERS.slice(0, 3),
    ];
    const ISO_POOL: readonly PoolValue[] = [
      ...STRICT_ISO,
      ...LOOSE_ISO.slice(0, 4),
      ...TRAVERSAL_STRINGS.slice(0, 5),
      ...POISON_STRINGS.slice(0, 5),
      ...NULLISH,
    ];
    const T_POOL: readonly PoolValue[] = [
      ...BOUNDARY_NUMBERS,
      ...POISON_NUMBERS,
      ...NULLISH,
    ];
    for (const seed of campaignSeeds('benchRecorder')) {
      const random = seededRandom(seed);
      const init = {
        deviceModel: random() < 0.7 ? INIT_POOL[0]! : pick(random, INIT_POOL),
        osVersion: random() < 0.8 ? INIT_POOL[0]! : pick(random, INIT_POOL),
        appVersion: random() < 0.8 ? INIT_POOL[0]! : pick(random, INIT_POOL),
        startedAtIso: random() < 0.5 ? STRICT_ISO[0]! : pick(random, ISO_POOL),
      };
      const parts = [
        `model=${init.deviceModel.id}`,
        `os=${init.osVersion.id}`,
        `app=${init.appVersion.id}`,
        `iso=${init.startedAtIso.id}`,
      ];
      const pushes = randomInt(random, 0, 8);
      const reasons: { thermal?: string; fps?: string; memory?: string } = {};
      let expectInvalid = [
        init.deviceModel,
        init.osVersion,
        init.appVersion,
        init.startedAtIso,
      ].some(p => typeof p.value !== 'string' || p.value.length === 0);
      const seen = { thermal: 0, fps: 0, memory: 0 };
      const lastT = { thermal: -Infinity, fps: -Infinity, memory: -Infinity };
      let unsafeFilename = false;

      const run = attempt(() => {
        const recorder = new DeviceBenchRecorder({
          deviceModel: init.deviceModel.value as string,
          osVersion: init.osVersion.value as string,
          appVersion: init.appVersion.value as string,
          startedAtIso: init.startedAtIso.value as string,
        });
        for (let i = 0; i < pushes; i += 1) {
          const kind = pick(random, [
            'thermal',
            'fps',
            'memory',
            'capture',
            'note',
          ] as const);
          const t =
            random() < 0.85
              ? ({
                  id: String(i * 1000),
                  kind: 'boundary_number',
                  value: i * 1000,
                } as PoolValue)
              : pick(random, T_POOL);
          if (kind === 'thermal') {
            const state =
              random() < 0.9
                ? pick(random, ['nominal', 'fair', 'serious', 'critical'])
                : pick(random, ['Nominal', '', 'hot', 1, null] as const);
            recorder.pushThermal({
              tMs: t.value as number,
              state: state as never,
            });
            parts.push(`thermal(t=${t.id},state=${describeValue(state)})`);
            if (
              !isFiniteNonNegative(t.value) ||
              typeof state !== 'string' ||
              !THERMAL.has(state)
            )
              expectInvalid = true;
            if (isFiniteNonNegative(t.value)) {
              if ((t.value as number) < lastT.thermal) expectInvalid = true;
              lastT.thermal = t.value as number;
            }
            seen.thermal += 1;
          } else if (kind === 'fps') {
            const fps =
              random() < 0.9
                ? pick(random, [0, 24, 29.97, 59.94, 120, 239.76])
                : (pick(random, T_POOL).value as number);
            const windowMs =
              random() < 0.9 ? 1000 : (pick(random, T_POOL).value as number);
            recorder.pushFps({ tMs: t.value as number, fps, windowMs });
            parts.push(
              `fps(t=${t.id},fps=${describeValue(fps)},win=${describeValue(windowMs)})`,
            );
            if (
              !isFiniteNonNegative(t.value) ||
              !isFiniteNonNegative(fps) ||
              typeof windowMs !== 'number' ||
              !Number.isFinite(windowMs) ||
              windowMs <= 0
            )
              expectInvalid = true;
            if (isFiniteNonNegative(t.value)) {
              if ((t.value as number) < lastT.fps) expectInvalid = true;
              lastT.fps = t.value as number;
            }
            seen.fps += 1;
          } else if (kind === 'memory') {
            const footprint =
              random() < 0.9
                ? 412_000_256
                : (pick(random, T_POOL).value as number);
            recorder.pushMemory({
              tMs: t.value as number,
              footprintBytes: footprint,
            });
            parts.push(`memory(t=${t.id},bytes=${describeValue(footprint)})`);
            if (
              !isFiniteNonNegative(t.value) ||
              !isFiniteNonNegative(footprint)
            )
              expectInvalid = true;
            if (isFiniteNonNegative(t.value)) {
              if ((t.value as number) < lastT.memory) expectInvalid = true;
              lastT.memory = t.value as number;
            }
            seen.memory += 1;
          } else if (kind === 'capture') {
            const uri =
              random() < 0.8
                ? 'file:///clip.mov'
                : (pick(random, [
                    ...POISON_STRINGS.slice(0, 2),
                    ...TRAVERSAL_STRINGS.slice(0, 3),
                    ...NULLISH,
                  ]).value as string);
            const strategy =
              random() < 0.9
                ? pick(random, ['adaptive', 'fixed'])
                : (pick(random, ['FIXED', '', null]) as string);
            recorder.pushCapture({
              clipUri: uri,
              finalizedAtMs: t.value as number,
              completionStrategy: strategy as never,
              telemetrySchemas: ['capture-completion-telemetry-v1'],
            });
            parts.push(
              `capture(uri=${describeValue(uri)},t=${t.id},strategy=${describeValue(strategy)})`,
            );
            if (
              typeof uri !== 'string' ||
              uri.length === 0 ||
              !isFiniteNonNegative(t.value) ||
              (strategy !== 'fixed' && strategy !== 'adaptive')
            )
              expectInvalid = true;
          } else {
            const note =
              random() < 0.85
                ? 'note'
                : pick(random, [
                    ...POISON_STRINGS.slice(0, 3),
                    ...NULLISH,
                    ...POISON_NUMBERS.slice(0, 2),
                  ]).value;
            recorder.addNote(note as string);
            parts.push(`note(${describeValue(note)})`);
            if (typeof note !== 'string') expectInvalid = true;
          }
        }
        for (const label of ['thermal', 'fps', 'memory'] as const) {
          if (seen[label] === 0) {
            const explain = random();
            if (explain < 0.8) reasons[label] = 'sensor unavailable';
            else if (explain < 0.9) reasons[label] = '';
            // else: left undefined → unexplained empty series
            if (!reasons[label]) expectInvalid = true;
            parts.push(`${label}.reason=${describeValue(reasons[label])}`);
          }
        }
        const doc = recorder.finalize(reasons);
        unsafeFilename = isUnsafeFilename(
          deviceBenchExportFilename(doc.startedAtIso),
        );
        return doc;
      });

      const input = parts.join(' ');
      let outcome: string;
      let verdict: Verdict;
      let detail: string | undefined;
      if (run.threw) {
        const typed = run.threw.startsWith(`Error:${TYPED_PREFIX}`);
        if (!typed) {
          outcome = `THREW_UNTYPED:${run.threw}`;
          verdict = 'BROKEN';
        } else if (!expectInvalid) {
          outcome = 'REJECTED_VALID';
          verdict = 'BROKEN';
          detail = run.threw.slice(0, 300);
        } else {
          outcome = 'finalize_rejected_typed';
          verdict = 'HELD';
          detail = run.threw.slice(
            TYPED_PREFIX.length + 6,
            TYPED_PREFIX.length + 206,
          );
        }
      } else {
        const doc = run.result as DeviceBenchExportV1;
        const errors = validateDeviceBenchExport(doc);
        const stable = jsonStable(doc);
        if (errors.length > 0) {
          outcome = 'FINALIZED_INVALID';
          verdict = 'BROKEN';
          detail = errors.join('; ');
        } else if (expectInvalid) {
          outcome = 'ACCEPTED_POISON';
          verdict = 'BROKEN';
        } else if (!allNumbersFinite(doc) || !stable.stable) {
          outcome = `FINALIZED_NOT_PERSISTABLE:${stable.why}`;
          verdict = 'BROKEN';
        } else if (unsafeFilename) {
          outcome = 'finalized_unsafe_filename_from_startedAtIso';
          verdict = 'OBSERVATION';
          detail = `filename=${describeValue(deviceBenchExportFilename(doc.startedAtIso))}`;
        } else if (init.startedAtIso.kind !== 'strict_iso') {
          outcome = 'finalized_unparsed_iso';
          verdict = 'OBSERVATION';
        } else if (
          [init.deviceModel, init.osVersion, init.appVersion].some(
            p =>
              p.kind === 'oversize_string' ||
              CONTROL_STRING_IDS.has(p.id) ||
              p.kind === 'traversal_string',
          )
        ) {
          outcome = 'finalized_loose_metadata';
          verdict = 'OBSERVATION';
        } else {
          outcome = 'finalized_valid';
          verdict = 'HELD';
        }
      }
      table.record({
        seed,
        strategy: 'recorder',
        input,
        outcome,
        verdict,
        detail,
      });
    }
    const file = table.flush();
    expect({ broken: table.broken(), file }).toEqual({ broken: [], file });
  });

  it('prototypes are untouched after every campaign', () => {
    expect(prototypeSnapshot()).toBe(protoBefore);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
});
