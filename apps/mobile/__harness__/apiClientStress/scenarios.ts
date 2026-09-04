/**
 * Seeded scenario generators for the `boundary-malformed` lens against
 * `src/data/api.ts`. Each generator returns a complete server response
 * (status, reason phrase, body as text or raw bytes) plus the client-side
 * input (path id / token) for one call surface. Nothing here touches the
 * network or the module under test — see `run.ts`.
 */
import type { Rng } from './rng';

export const SURFACES = [
  'transport.syncShots',
  'transport.createSession',
  'transport.finalizeSession',
  'transport.uploadEvaluationTrials',
  'permit.reserve',
  'permit.release',
  'submitAnalysisFeedback',
  'api.request',
] as const;
export type Surface = (typeof SURFACES)[number];

export const FAMILIES = [
  'malformed_json',
  'wrong_type',
  'proto_pollution',
  'numeric_edge',
  'null_bytes',
  'oversized_string',
  'path_traversal_id',
  'future_schema',
  'empty_container',
  'unicode_normalization',
  'error_envelope',
  'exotic_status',
  'byte_level',
  'network_error',
  'token_boundary',
] as const;
export type Family = (typeof FAMILIES)[number];

export type ScenarioBody =
  | { kind: 'text'; text: string }
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'reject'; error: unknown; label: string };

export interface StringMetrics {
  bytes: number;
  codePoints: number;
  utf16Units: number;
  graphemes: number | null;
}

export interface Scenario {
  seed: number;
  surface: Surface;
  family: Family;
  label: string;
  status: number;
  statusText: string;
  body: ScenarioBody;
  token: string | null;
  /** Id/slug/idempotency key handed to the call surface. */
  pathId: string;
  /** Metrics of the deliberately oversized string, when the family uses one. */
  oversized: StringMetrics | null;
  /** Deep-equality against the parsed body is skipped (pathological nesting). */
  deepNesting: boolean;
}

export const HARNESS_TOKEN = 'stress-bearer-token';
export const HARNESS_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export const POLLUTION_MARKER = '__api_stress_polluted__';

let segmenter: { segment(input: string): Iterable<unknown> } | null | undefined;
function graphemeCount(text: string): number | null {
  if (segmenter === undefined) {
    const intl = Intl as unknown as {
      Segmenter?: new (
        locale: string,
        options: { granularity: 'grapheme' },
      ) => { segment(input: string): Iterable<unknown> };
    };
    segmenter = intl.Segmenter
      ? new intl.Segmenter('en', { granularity: 'grapheme' })
      : null;
  }
  if (!segmenter) return null;
  let count = 0;
  for (const _segment of segmenter.segment(text)) count += 1;
  return count;
}

export function measureString(text: string): StringMetrics {
  let codePoints = 0;
  for (const _cp of text) codePoints += 1;
  return {
    bytes: Buffer.byteLength(text, 'utf8'),
    codePoints,
    utf16Units: text.length,
    graphemes: graphemeCount(text),
  };
}

// ── Valid skeletons per surface ────────────────────────────────────────────

export function validPermit(rng: Rng): Record<string, unknown> {
  return {
    id: HARNESS_UUID,
    accessSource: rng.pick(['free', 'premium'] as const),
    status: 'reserved',
    expiresAt: '2026-09-04T22:00:00.000Z',
  };
}

export function validAccess(rng: Rng): Record<string, unknown> {
  const limit = rng.int(0, 5);
  const used = rng.int(0, limit);
  const reserved = rng.int(0, limit - used);
  return {
    premium: rng.bool(0.3),
    freeRatings: {
      limit,
      used,
      reserved,
      remaining: limit - used,
      availableToReserve: limit - used - reserved,
    },
  };
}

export function validSuccessBody(rng: Rng, surface: Surface): unknown {
  switch (surface) {
    case 'permit.reserve':
      return rng.bool(0.8)
        ? { permit: validPermit(rng), access: validAccess(rng) }
        : { permit: validPermit(rng) };
    case 'transport.syncShots':
      return { acceptedIds: [HARNESS_UUID], rejected: [] };
    case 'transport.uploadEvaluationTrials':
      return { acceptedTrialIds: [HARNESS_UUID], rejected: [] };
    case 'submitAnalysisFeedback':
      return { feedback: { reviewEligible: rng.bool() } };
    case 'transport.createSession':
    case 'transport.finalizeSession':
    case 'permit.release':
      return rng.pick([{}, { ok: true }, { session: { id: HARNESS_UUID } }]);
    case 'api.request':
      return { probe: { echo: HARNESS_UUID, n: rng.int(0, 1000) } };
  }
}

export function validErrorBody(code: string, message: string): unknown {
  return { error: { code, message } };
}

const ERROR_STATUSES = [
  400, 401, 402, 403, 404, 405, 408, 409, 410, 413, 415, 422, 429, 500, 502,
  503, 504,
] as const;
const ERROR_CODES = [
  'auth.required',
  'access.paywall_required',
  'access.permit_expired',
  'shot.session_not_found',
  'shot.write_failed',
  'analysis.feedback_exists',
  'rate_limited',
  'unknown',
  'internal',
] as const;

function text(value: string): ScenarioBody {
  return { kind: 'text', text: value };
}
function json(value: unknown): ScenarioBody {
  return text(JSON.stringify(value));
}
/** `{"k":v,...rest}` built textually so keys like `__proto__` stay JSON keys. */
function prependKey(objectText: string, keyValueText: string): string {
  return objectText === '{}'
    ? `{${keyValueText}}`
    : `{${keyValueText},${objectText.slice(1)}`;
}
function appendKeys(objectText: string, keyValuesText: string): string {
  return objectText === '{}'
    ? `{${keyValuesText}}`
    : `${objectText.slice(0, -1)},${keyValuesText}}`;
}

interface Generated {
  label: string;
  status: number;
  statusText?: string;
  body: ScenarioBody;
  pathId?: string;
  token?: string | null;
  oversized?: StringMetrics;
  deepNesting?: boolean;
}

// ── Alphabets for size/encoding probes ─────────────────────────────────────

const ALPHABETS = [
  { name: 'ascii', unit: 'a' },
  { name: 'latin1-2B', unit: 'é' },
  { name: 'cjk-3B', unit: '漢' },
  { name: 'emoji-4B', unit: '😀' },
  { name: 'zwj-family-grapheme', unit: '👨‍👩‍👧‍👦' },
  { name: 'combining-marks', unit: 'e\u0301\u0302\u0303' },
] as const;

function repeatToUnits(unit: string, units: number): string {
  return unit.repeat(units);
}

// ── Families ───────────────────────────────────────────────────────────────

function genMalformedJson(rng: Rng, surface: Surface): Generated {
  const skeleton = JSON.stringify(validSuccessBody(rng, surface));
  const status = rng.bool(0.8) ? 200 : rng.pick(ERROR_STATUSES);
  const mode = rng.int(0, 15);
  switch (mode) {
    case 0: {
      const cut = rng.int(0, Math.max(0, skeleton.length - 1));
      return {
        label: `truncated_at_${cut}`,
        status,
        body: text(skeleton.slice(0, cut)),
      };
    }
    case 1: {
      const at = rng.int(0, skeleton.length - 1);
      return {
        label: `char_dropped_at_${at}`,
        status,
        body: text(skeleton.slice(0, at) + skeleton.slice(at + 1)),
      };
    }
    case 2: {
      const at = rng.int(0, skeleton.length);
      const noise = rng.pick([
        '{',
        '}',
        '[',
        ']',
        '"',
        ',',
        ':',
        '\\',
        '\u0000',
      ]);
      return {
        label: `noise_inserted_at_${at}`,
        status,
        body: text(skeleton.slice(0, at) + noise + skeleton.slice(at)),
      };
    }
    case 3:
      return {
        label: 'single_quotes',
        status,
        body: text(skeleton.replace(/"/g, "'")),
      };
    case 4:
      return {
        label: 'trailing_comma',
        status,
        body: text(skeleton.replace(/}$/, ',}')),
      };
    case 5:
      return {
        label: 'trailing_garbage',
        status,
        body: text(
          `${skeleton}${rng.pick(['x', '}', ']', ' null', '\u0000'])}`,
        ),
      };
    case 6:
      return {
        label: 'nan_literal',
        status,
        body: text(skeleton.replace(/:\s*(\d+|true|false)/, ': NaN')),
      };
    case 7:
      return {
        label: 'infinity_literal',
        status,
        body: text(skeleton.replace(/:\s*(\d+|true|false)/, ': -Infinity')),
      };
    case 8:
      return {
        label: 'undefined_literal',
        status,
        body: text(skeleton.replace(/:\s*(\d+|true|false)/, ': undefined')),
      };
    case 9:
      return {
        label: 'js_comment',
        status,
        body: text(`/* v2 */ ${skeleton} // trailing`),
      };
    case 10: {
      const depth = rng.pick([64, 1_000, 10_000, 100_000]);
      return {
        label: `deep_array_nesting_${depth}`,
        status,
        body: text('['.repeat(depth) + ']'.repeat(depth)),
        deepNesting: true,
      };
    }
    case 11: {
      const depth = rng.pick([64, 1_000, 10_000]);
      return {
        label: `deep_object_nesting_${depth}`,
        status,
        body: text('{"permit":'.repeat(depth) + 'null' + '}'.repeat(depth)),
        deepNesting: true,
      };
    }
    case 12:
      return {
        label: 'duplicate_key_last_wins_null',
        status,
        body: text(
          appendKeys(
            skeleton,
            '"permit":null,"acceptedIds":null,"acceptedTrialIds":null,"feedback":null,"probe":null,"error":null',
          ),
        ),
      };
    case 13:
      return {
        label: 'unquoted_keys',
        status,
        body: text(skeleton.replace(/"([A-Za-z_]+)":/g, '$1:')),
      };
    case 14:
      return {
        label: 'leading_zero_and_plus',
        status,
        body: text(skeleton.replace(/:\s*(\d+)/, ': +007')),
      };
    default:
      return {
        label: 'html_body',
        status,
        body: text('<!doctype html><html><body>502 Bad Gateway</body></html>'),
      };
  }
}

function genWrongType(rng: Rng, surface: Surface): Generated {
  const wrong = [
    'string',
    42,
    -1,
    0,
    true,
    false,
    null,
    [],
    ['free'],
    {},
    { nested: { deeper: 1 } },
    '   ',
    '',
  ] as const;
  const pickWrong = () => rng.pick(wrong);
  if (rng.bool(0.2)) {
    const top = pickWrong();
    return {
      label: `top_level_${Object.prototype.toString.call(top).slice(8, -1)}`,
      status: 200,
      body: json(top),
    };
  }
  switch (surface) {
    case 'permit.reserve': {
      const permit = validPermit(rng);
      const access = validAccess(rng);
      const slot = rng.pick([
        'permit',
        'permit.id',
        'permit.accessSource',
        'permit.status',
        'permit.expiresAt',
        'access',
        'access.premium',
        'access.freeRatings',
        'access.freeRatings.limit',
        'access.freeRatings.used',
        'access.freeRatings.reserved',
        'access.freeRatings.remaining',
        'access.freeRatings.availableToReserve',
      ] as const);
      const value = pickWrong();
      const body: Record<string, unknown> = { permit, access };
      if (slot === 'permit') body['permit'] = value;
      else if (slot === 'access') body['access'] = value;
      else if (slot.startsWith('permit.')) permit[slot.slice(7)] = value;
      else if (slot === 'access.premium') access['premium'] = value;
      else if (slot === 'access.freeRatings') access['freeRatings'] = value;
      else
        (access['freeRatings'] as Record<string, unknown>)[slot.slice(19)] =
          value;
      return {
        label: `${slot}=${JSON.stringify(value)}`,
        status: 200,
        body: json(body),
      };
    }
    case 'transport.syncShots': {
      const value = pickWrong();
      const slot = rng.pick(['acceptedIds', 'rejected'] as const);
      return {
        label: `${slot}=${JSON.stringify(value)}`,
        status: 200,
        body: json({
          acceptedIds: [HARNESS_UUID],
          rejected: [],
          [slot]: value,
        }),
      };
    }
    case 'transport.uploadEvaluationTrials': {
      const value = pickWrong();
      return {
        label: `acceptedTrialIds=${JSON.stringify(value)}`,
        status: 200,
        body: json({ acceptedTrialIds: value, rejected: [] }),
      };
    }
    case 'submitAnalysisFeedback': {
      const value = pickWrong();
      const slot = rng.pick(['feedback', 'feedback.reviewEligible'] as const);
      return {
        label: `${slot}=${JSON.stringify(value)}`,
        status: 200,
        body: json(
          slot === 'feedback'
            ? { feedback: value }
            : { feedback: { reviewEligible: value } },
        ),
      };
    }
    default: {
      // Error envelope slots on a 4xx/5xx are the interesting wrong types for
      // the remaining surfaces (they resolve `undefined` on any 2xx).
      const value = pickWrong();
      const slot = rng.pick(['error', 'error.code', 'error.message'] as const);
      const status = rng.pick(ERROR_STATUSES);
      const body =
        slot === 'error'
          ? { error: value }
          : slot === 'error.code'
            ? { error: { code: value, message: 'typed message' } }
            : { error: { code: 'typed.code', message: value } };
      return {
        label: `${slot}=${JSON.stringify(value)}`,
        status,
        body: json(body),
      };
    }
  }
}

function genProtoPollution(rng: Rng, surface: Surface): Generated {
  const payload = { [POLLUTION_MARKER]: true, polluted: POLLUTION_MARKER };
  const attack = rng.pick([
    { key: '__proto__', value: payload },
    { key: 'constructor', value: { prototype: payload } },
    { key: 'prototype', value: payload },
    { key: '__proto__', value: null },
    { key: '__defineGetter__', value: 'x' },
    { key: 'toString', value: 'not-a-function' },
    { key: 'hasOwnProperty', value: 0 },
  ]);
  const base = validSuccessBody(rng, surface) as Record<string, unknown>;
  const place = rng.pick([
    'top',
    'permit',
    'freeRatings',
    'error',
    'as_permit',
  ]);
  const status = place === 'error' ? rng.pick(ERROR_STATUSES) : 200;
  let body: unknown;
  // Build via string concatenation so `__proto__` really is a JSON key
  // (object-literal `__proto__` would set the prototype of the literal).
  const kv = `${JSON.stringify(attack.key)}:${JSON.stringify(attack.value)}`;
  const inject = (objectText: string) => prependKey(objectText, kv);
  switch (place) {
    case 'top':
      body = inject(JSON.stringify(base));
      break;
    case 'permit': {
      const permitText = inject(JSON.stringify(validPermit(rng)));
      body = `{"permit":${permitText},"access":${JSON.stringify(validAccess(rng))}}`;
      break;
    }
    case 'freeRatings': {
      const access = validAccess(rng);
      const ratings = inject(JSON.stringify(access['freeRatings']));
      body = `{"permit":${JSON.stringify(validPermit(rng))},"access":{"premium":${String(access['premium'])},"freeRatings":${ratings}}}`;
      break;
    }
    case 'error':
      body = `{"error":${inject('{"code":"typed.code","message":"typed message"}')}}`;
      break;
    default:
      body = `{"permit":{${kv}},"access":null}`;
  }
  return {
    label: `${place}:${attack.key}`,
    status,
    body: text(body as string),
  };
}

const NUMERIC_EDGES = [
  '1e999',
  '-1e999',
  '-0',
  '0',
  '-1',
  '0.5',
  '1e21',
  '9007199254740993',
  '1.7976931348623157e308',
  '5e-324',
  '2147483648',
  '4294967296',
  '-2147483649',
  '1e-7',
  '123456789012345678901234567890',
  '0.1e1',
  '1E2',
] as const;

function genNumericEdge(rng: Rng, surface: Surface): Generated {
  const literal = rng.pick(NUMERIC_EDGES);
  if (surface === 'permit.reserve') {
    const field = rng.pick([
      'limit',
      'used',
      'reserved',
      'remaining',
      'availableToReserve',
    ] as const);
    const access = validAccess(rng);
    const ratings = access['freeRatings'] as Record<string, unknown>;
    const ratingsText = JSON.stringify(ratings).replace(
      new RegExp(`"${field}":\\s*-?\\d+`),
      `"${field}":${literal}`,
    );
    const body = `{"permit":${JSON.stringify(validPermit(rng))},"access":{"premium":${String(access['premium'])},"freeRatings":${ratingsText}}}`;
    return {
      label: `freeRatings.${field}=${literal}`,
      status: 200,
      body: text(body),
    };
  }
  if (rng.bool(0.5)) {
    const status = rng.pick(ERROR_STATUSES);
    return {
      label: `error.code=${literal}`,
      status,
      body: text(`{"error":{"code":${literal},"message":"numeric code"}}`),
    };
  }
  const base = JSON.stringify(validSuccessBody(rng, surface));
  return {
    label: `success_number_slot=${literal}`,
    status: 200,
    body: text(prependKey(base, `"n":${literal}`)),
  };
}

function genNullBytes(rng: Rng, surface: Surface): Generated {
  const nul = rng.pick([
    '\u0000',
    'a\u0000b',
    '\u0000'.repeat(8),
    'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee\u0000',
  ]);
  const mode = rng.int(0, 5);
  if (mode === 0) {
    return {
      label: 'nul_in_path_id',
      status: 200,
      body: json(validSuccessBody(rng, surface)),
      pathId: nul,
    };
  }
  if (mode === 1) {
    const status = rng.pick(ERROR_STATUSES);
    return {
      label: 'nul_in_error_code_and_message',
      status,
      body: json(validErrorBody(`auth.required${nul}`, `Sign in${nul}again`)),
    };
  }
  if (mode === 2) {
    // A raw 0x00 byte inside a JSON string is invalid JSON.
    const skeleton = Buffer.from(
      JSON.stringify(validSuccessBody(rng, surface)),
      'utf8',
    );
    const at = skeleton.indexOf(0x22, 2) + 1; // just after an opening quote
    const bytes = Buffer.concat([
      skeleton.subarray(0, at),
      Buffer.from([0]),
      skeleton.subarray(at),
    ]);
    return {
      label: 'raw_nul_byte_in_string',
      status: 200,
      body: { kind: 'bytes', bytes },
    };
  }
  if (surface === 'permit.reserve') {
    const permit = validPermit(rng);
    const slot = rng.pick([
      'id',
      'accessSource',
      'status',
      'expiresAt',
    ] as const);
    permit[slot] =
      slot === 'accessSource'
        ? `free${nul}`
        : slot === 'status'
          ? `reserved${nul}`
          : nul;
    return {
      label: `permit.${slot}_with_nul`,
      status: 200,
      body: json({ permit, access: validAccess(rng) }),
    };
  }
  return {
    label: 'nul_key_in_success_body',
    status: 200,
    body: text(
      prependKey(
        JSON.stringify(validSuccessBody(rng, surface)),
        `${JSON.stringify(nul)}:1`,
      ),
    ),
  };
}

const SIZE_UNITS = [
  65_535, 65_536, 65_537, 131_072, 262_144, 1_048_576,
] as const;

function genOversized(rng: Rng, surface: Surface): Generated {
  const alphabet = rng.pick(ALPHABETS);
  let units = rng.pick(SIZE_UNITS);
  // Keep the biggest astral/grapheme bodies under ~4 MiB so the campaign
  // stays fast; the byte/codepoint/grapheme split is what is under test.
  if (alphabet.unit.length > 2 && units > 262_144) units = 262_144;
  const big = repeatToUnits(alphabet.unit, units);
  const metrics = measureString(big);
  const slot = rng.pick([
    'permit.id',
    'permit.accessSource_suffix',
    'permit.expiresAt',
    'error.message',
    'error.code',
    'acceptedIds[0]',
    'statusText',
    'pathId',
    'unknown_key',
  ] as const);
  const label = `${slot}:${alphabet.name}x${units}`;
  switch (slot) {
    case 'permit.id':
    case 'permit.expiresAt': {
      const permit = validPermit(rng);
      permit[slot.slice(7)] = big;
      return {
        label,
        status: 200,
        body: json({ permit, access: validAccess(rng) }),
        oversized: metrics,
      };
    }
    case 'permit.accessSource_suffix': {
      const permit = validPermit(rng);
      permit['accessSource'] = `free${big}`;
      return { label, status: 200, body: json({ permit }), oversized: metrics };
    }
    case 'error.message':
      return {
        label,
        status: rng.pick(ERROR_STATUSES),
        body: json(validErrorBody('typed.code', big)),
        oversized: metrics,
      };
    case 'error.code':
      return {
        label,
        status: rng.pick(ERROR_STATUSES),
        body: json(validErrorBody(big, 'typed message')),
        oversized: metrics,
      };
    case 'acceptedIds[0]':
      return {
        label,
        status: 200,
        body: json({ acceptedIds: [big], rejected: [] }),
        oversized: metrics,
      };
    case 'statusText':
      return {
        label,
        status: rng.pick(ERROR_STATUSES),
        body: text(''),
        statusText: big,
        oversized: metrics,
      };
    case 'pathId':
      return {
        label,
        status: 200,
        body: json(validSuccessBody(rng, surface)),
        pathId: big,
        oversized: metrics,
      };
    default:
      return {
        label,
        status: 200,
        body: text(
          prependKey(
            JSON.stringify(validSuccessBody(rng, surface)),
            `"padding":${JSON.stringify(big)}`,
          ),
        ),
        oversized: metrics,
      };
  }
}

export const TRAVERSAL_IDS = [
  '../../admin',
  '../../../v1/account/delete',
  '..%2F..%2Fadmin',
  '%2e%2e/%2e%2e/admin',
  'a/b',
  'a?x=1',
  'a?x=1&y=2#frag',
  'a#frag',
  'a b',
  'a\nb',
  'a\r\nHost: evil.example',
  '..',
  '.',
  '',
  '   ',
  '/',
  '//evil.example/',
  'https://evil.example/x',
  'a\\b',
  '..\\..\\admin',
  'a;b=c',
  'a%00b',
  'a\u0000b',
  'ünï',
  'e\u0301',
  '🍕',
  'a\u2028b',
  '\ufeffbom',
  'a:b@c',
  '~',
  '%',
  '%zz',
] as const;

function genPathTraversal(rng: Rng, surface: Surface): Generated {
  const pathId = rng.pick(TRAVERSAL_IDS);
  const status = rng.bool(0.85) ? 200 : rng.pick(ERROR_STATUSES);
  const body =
    status === 200
      ? json(validSuccessBody(rng, surface))
      : json(validErrorBody(rng.pick(ERROR_CODES), 'typed message'));
  return { label: `id=${JSON.stringify(pathId)}`, status, body, pathId };
}

function genFutureSchema(rng: Rng, surface: Surface): Generated {
  const version = rng.pick([2, 3, 99, '2.0', 'v3', { major: 2 }]);
  const mode = rng.int(0, 6);
  if (surface === 'permit.reserve') {
    const permit = validPermit(rng);
    const access = validAccess(rng);
    switch (mode) {
      case 0:
        return {
          label: 'top_level_schemaVersion',
          status: 200,
          body: json({ schemaVersion: version, permit, access }),
        };
      case 1:
        permit['status'] = rng.pick([
          'reserved_v2',
          'RESERVED',
          'active',
          'Reserved',
        ]);
        return {
          label: `permit.status=${String(permit['status'])}`,
          status: 200,
          body: json({ permit, access }),
        };
      case 2:
        permit['accessSource'] = rng.pick([
          'premium_plus',
          'trial',
          'team',
          'FREE',
        ]);
        return {
          label: `permit.accessSource=${String(permit['accessSource'])}`,
          status: 200,
          body: json({ permit, access }),
        };
      case 3:
        return {
          label: 'data_envelope',
          status: 200,
          body: json({ data: { permit, access }, meta: { version } }),
        };
      case 4:
        return {
          label: 'extra_fields_everywhere',
          status: 200,
          body: json({
            permit: { ...permit, v2: { scopes: ['rate'] }, ttlMs: 60000 },
            access: {
              ...access,
              plan: 'pro',
              freeRatings: {
                ...(access['freeRatings'] as object),
                rollover: 1,
              },
            },
            links: { self: '/v1/analysis-permits/x' },
          }),
        };
      case 5:
        return {
          label: 'permits_array_instead',
          status: 200,
          body: json({ permits: [permit], access }),
        };
      default:
        return {
          label: 'errors_array_envelope',
          status: rng.pick(ERROR_STATUSES),
          body: json({
            errors: [{ code: 'access.paywall_required', message: 'Upgrade' }],
            schemaVersion: version,
          }),
        };
    }
  }
  switch (mode) {
    case 0:
      return {
        label: 'top_level_schemaVersion',
        status: 200,
        body: json({
          schemaVersion: version,
          ...(validSuccessBody(rng, surface) as object),
        }),
      };
    case 1:
      return {
        label: 'data_envelope',
        status: 200,
        body: json({ data: validSuccessBody(rng, surface), meta: { version } }),
      };
    case 2:
      return {
        label: 'accepted_objects_instead_of_ids',
        status: 200,
        body: json({
          accepted: [{ id: HARNESS_UUID, receipt: 'r1' }],
          rejected: [],
        }),
      };
    case 3:
      return {
        label: 'errors_array_envelope',
        status: rng.pick(ERROR_STATUSES),
        body: json({
          errors: [{ code: 'rate_limited', message: 'Slow down' }],
        }),
      };
    case 4:
      return {
        label: 'error_with_details_and_retry',
        status: rng.pick(ERROR_STATUSES),
        body: json({
          error: {
            code: 'rate_limited',
            message: 'Slow down',
            details: { retryAfterMs: 1000, version },
          },
        }),
      };
    case 5:
      return {
        label: 'feedback_v2_shape',
        status: 200,
        body: json({
          feedback: { reviewEligible: rng.bool(), queue: 'human', version },
        }),
      };
    default:
      return {
        label: 'rejected_objects_new_fields',
        status: 200,
        body: json({
          acceptedIds: [],
          rejected: [
            {
              id: HARNESS_UUID,
              code: 'shot.v2_only',
              message: 'm',
              severity: 'warning',
              version,
            },
          ],
        }),
      };
  }
}

function genEmptyContainer(rng: Rng, surface: Surface): Generated {
  const options: Array<[string, ScenarioBody, number]> = [
    ['empty_object', text('{}'), 200],
    ['empty_array', text('[]'), 200],
    ['empty_body', text(''), 200],
    ['whitespace_body', text(rng.pick([' ', '\n', '\r\n\t'])), 200],
    ['empty_key', text('{"":""}'), 200],
    ['permit_empty_object', json({ permit: {} }), 200],
    ['permit_empty_array', json({ permit: [] }), 200],
    [
      'access_empty_object',
      json({ permit: validPermit(rng), access: {} }),
      200,
    ],
    [
      'freeRatings_empty_object',
      json({
        permit: validPermit(rng),
        access: { premium: false, freeRatings: {} },
      }),
      200,
    ],
    [
      'freeRatings_empty_array',
      json({
        permit: validPermit(rng),
        access: { premium: false, freeRatings: [] },
      }),
      200,
    ],
    ['error_empty_object', json({ error: {} }), rng.pick(ERROR_STATUSES)],
    ['error_empty_array', json({ error: [] }), rng.pick(ERROR_STATUSES)],
    ['error_empty_body_4xx', text(''), rng.pick(ERROR_STATUSES)],
    ['empty_object_4xx', text('{}'), rng.pick(ERROR_STATUSES)],
    ['acceptedIds_empty', json({ acceptedIds: [], rejected: [] }), 200],
    ['feedback_empty_object', json({ feedback: {} }), 200],
    [
      'nested_empties',
      json({ permit: { id: {}, accessSource: [], status: {}, expiresAt: [] } }),
      200,
    ],
  ];
  const [label, body, status] = rng.pick(options);
  void surface;
  return { label, status, body };
}

/** (canonical, lookalike) pairs — the client must treat them as different. */
const NORMALIZATION_PAIRS = [
  ['free', 'ｆｒｅｅ'],
  ['free', 'free\u200b'],
  ['free', 'free\u00a0'],
  ['free', 'FREE'],
  ['free', 'frée'],
  ['free', 'fre\u0065'],
  ['premium', 'ｐｒｅｍｉｕｍ'],
  ['premium', 'premıum'],
  ['reserved', 'ｒｅｓｅｒｖｅｄ'],
  ['reserved', 'reserve\u0301d'],
  ['reserved', 'reserved\ufeff'],
  ['reserved', 'Reserved'],
  ['permit', 'permıt'],
  ['permit', 'ｐｅｒｍｉｔ'],
  ['permit', 'permit\u200d'],
  ['access', 'acce\u0073s'],
  ['access.paywall_required', 'access.paywall\u005frequired'],
  ['access.paywall_required', 'ａccess.paywall_required'],
  ['access.paywall_required', 'access.paywall_required\u200b'],
  ['é', 'e\u0301'],
  ['ﬁ', 'fi'],
  ['Å', 'A\u030a'],
  ['한', '\u1112\u1161\u11ab'],
] as const;

function genUnicodeNormalization(rng: Rng, surface: Surface): Generated {
  const [canonical, lookalike] = rng.pick(NORMALIZATION_PAIRS);
  const swap = rng.bool() ? lookalike : canonical;
  const label = `${JSON.stringify(canonical)}~${JSON.stringify(lookalike)}`;
  if (canonical === 'free' || canonical === 'premium') {
    const permit = validPermit(rng);
    permit['accessSource'] = swap;
    return {
      label: `accessSource:${label}`,
      status: 200,
      body: json({ permit, access: validAccess(rng) }),
    };
  }
  if (canonical === 'reserved') {
    const permit = validPermit(rng);
    permit['status'] = swap;
    return {
      label: `status:${label}`,
      status: 200,
      body: json({ permit, access: validAccess(rng) }),
    };
  }
  if (canonical === 'permit' || canonical === 'access') {
    const body: Record<string, unknown> = {};
    body[swap] = canonical === 'permit' ? validPermit(rng) : validAccess(rng);
    if (canonical === 'access') body['permit'] = validPermit(rng);
    return { label: `key:${label}`, status: 200, body: json(body) };
  }
  if (canonical === 'access.paywall_required') {
    return {
      label: `error.code:${label}`,
      status: 402,
      body: json(validErrorBody(swap, 'Upgrade to keep rating')),
    };
  }
  // Pure normalization pairs travel through ids: the client must pass the
  // exact code points through (no NFC/NFD rewriting on either side).
  if (rng.bool()) {
    const permit = validPermit(rng);
    permit['id'] = `${HARNESS_UUID}-${swap}`;
    return {
      label: `permit.id:${label}`,
      status: 200,
      body: json({ permit, access: validAccess(rng) }),
    };
  }
  return {
    label: `pathId:${label}`,
    status: 200,
    body: json(validSuccessBody(rng, surface)),
    pathId: swap,
  };
}

function genErrorEnvelope(rng: Rng, _surface: Surface): Generated {
  const status = rng.pick(ERROR_STATUSES);
  const mode = rng.int(0, 11);
  const code = rng.pick(ERROR_CODES);
  switch (mode) {
    case 0:
      return {
        label: `valid_envelope_${code}`,
        status,
        body: json(validErrorBody(code, 'A typed message.')),
      };
    case 1:
      return {
        label: 'missing_code',
        status,
        body: json({ error: { message: 'only a message' } }),
      };
    case 2:
      return {
        label: 'missing_message',
        status,
        body: json({ error: { code } }),
        statusText: 'Reason Phrase',
      };
    case 3:
      return {
        label: 'error_is_string',
        status,
        body: json({ error: 'plain string' }),
      };
    case 4:
      return { label: 'error_is_null', status, body: json({ error: null }) };
    case 5:
      return { label: 'error_is_number', status, body: json({ error: 500 }) };
    case 6:
      return {
        label: 'nested_error_error',
        status,
        body: json({ error: { error: { code, message: 'nested' } } }),
      };
    case 7:
      return {
        label: 'code_null_message_null',
        status,
        body: json({ error: { code: null, message: null } }),
        statusText: 'Fallback Phrase',
      };
    case 8:
      return {
        label: 'text_plain_body',
        status,
        body: text('Service Unavailable'),
      };
    case 9:
      return {
        label: 'html_body',
        status,
        body: text('<html><body><h1>504</h1></body></html>'),
      };
    case 10:
      return {
        label: 'control_chars_in_message',
        status,
        body: json(
          validErrorBody(
            code,
            'line1\nline2\r\u0007\u001b[31mred\u001b[0m\u007f',
          ),
        ),
      };
    default:
      return {
        label: 'message_with_html_and_script',
        status,
        body: json(
          validErrorBody(code, '<script>alert(1)</script><b>bold</b>'),
        ),
      };
  }
}

const EXOTIC_STATUSES = [
  100, 101, 199, 300, 301, 302, 304, 399, 0, 600, 999, 1000, -1, 99, 200, 299,
  201, 204, 205,
] as const;

function genExoticStatus(rng: Rng, surface: Surface): Generated {
  const status = rng.pick(EXOTIC_STATUSES);
  const bodyKind = rng.int(0, 2);
  const body =
    bodyKind === 0
      ? json(validSuccessBody(rng, surface))
      : bodyKind === 1
        ? json(validErrorBody(rng.pick(ERROR_CODES), 'exotic status envelope'))
        : text('');
  return {
    label: `status_${status}_${bodyKind === 0 ? 'success_body' : bodyKind === 1 ? 'error_body' : 'empty'}`,
    status,
    body,
    statusText: rng.pick(['', 'Weird', 'OK']),
  };
}

function genByteLevel(rng: Rng, surface: Surface): Generated {
  const skeleton = Buffer.from(
    JSON.stringify(validSuccessBody(rng, surface)),
    'utf8',
  );
  const mode = rng.int(0, 8);
  const bytes = (b: Uint8Array): ScenarioBody => ({ kind: 'bytes', bytes: b });
  switch (mode) {
    case 0:
      return {
        label: 'utf8_bom_prefix',
        status: 200,
        body: bytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), skeleton])),
      };
    case 1: {
      // Truncated 3-byte sequence inside the id string.
      const at = skeleton.indexOf(0x22, 2) + 1;
      return {
        label: 'truncated_multibyte_in_string',
        status: 200,
        body: bytes(
          Buffer.concat([
            skeleton.subarray(0, at),
            Buffer.from([0xe6, 0x97]),
            skeleton.subarray(at),
          ]),
        ),
      };
    }
    case 2:
      return {
        label: 'invalid_bytes_ff_fe',
        status: 200,
        body: bytes(Buffer.concat([Buffer.from([0xff, 0xfe]), skeleton])),
      };
    case 3:
      return {
        label: 'utf16le_encoded_json',
        status: 200,
        body: bytes(Buffer.from(skeleton.toString('utf8'), 'utf16le')),
      };
    case 4: {
      const at = skeleton.indexOf(0x22, 2) + 1;
      return {
        label: 'overlong_nul_c0_80',
        status: 200,
        body: bytes(
          Buffer.concat([
            skeleton.subarray(0, at),
            Buffer.from([0xc0, 0x80]),
            skeleton.subarray(at),
          ]),
        ),
      };
    }
    case 5: {
      const cut = rng.int(1, skeleton.length - 1);
      return {
        label: `byte_truncated_at_${cut}`,
        status: 200,
        body: bytes(skeleton.subarray(0, cut)),
      };
    }
    case 6: {
      const at = skeleton.indexOf(0x22, 2) + 1;
      // Lone surrogate encoded as WTF-8 / CESU-8.
      return {
        label: 'lone_surrogate_wtf8',
        status: 200,
        body: bytes(
          Buffer.concat([
            skeleton.subarray(0, at),
            Buffer.from([0xed, 0xa0, 0x80]),
            skeleton.subarray(at),
          ]),
        ),
      };
    }
    case 7:
      return {
        label: 'escaped_lone_surrogate',
        status: 200,
        body: text(
          prependKey(skeleton.toString('utf8'), '"lone":"\\ud800\\udfff"'),
        ),
      };
    default:
      return {
        label: 'utf8_bom_only',
        status: 200,
        body: bytes(Buffer.from([0xef, 0xbb, 0xbf])),
      };
  }
}

function genNetworkError(rng: Rng, _surface: Surface): Generated {
  const abortError = () =>
    new DOMException('The operation was aborted.', 'AbortError');
  const choice = rng.pick([
    { label: 'TypeError_fetch_failed', error: new TypeError('fetch failed') },
    {
      label: 'Error_socket_hang_up',
      error: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    },
    { label: 'foreign_AbortError', error: abortError() },
    { label: 'thrown_string', error: 'boom' },
    { label: 'thrown_null', error: null },
    { label: 'thrown_object', error: { code: 'ENETUNREACH' } },
  ]);
  return {
    label: choice.label,
    status: 0,
    body: { kind: 'reject', error: choice.error, label: choice.label },
  };
}

function genTokenBoundary(rng: Rng, surface: Surface): Generated {
  const token = rng.pick([null, '', ' ', '\t\n', '\u0000', 'a'.repeat(8192)]);
  const status = rng.bool(0.5) ? 200 : 401;
  const body =
    status === 200
      ? json(validSuccessBody(rng, surface))
      : json(validErrorBody('auth.required', 'Sign in again.'));
  return {
    label: `token=${JSON.stringify(token).slice(0, 24)}_status_${status}`,
    status,
    body,
    token,
  };
}

const GENERATORS: Record<Family, (rng: Rng, surface: Surface) => Generated> = {
  malformed_json: genMalformedJson,
  wrong_type: genWrongType,
  proto_pollution: genProtoPollution,
  numeric_edge: genNumericEdge,
  null_bytes: genNullBytes,
  oversized_string: genOversized,
  path_traversal_id: genPathTraversal,
  future_schema: genFutureSchema,
  empty_container: genEmptyContainer,
  unicode_normalization: genUnicodeNormalization,
  error_envelope: genErrorEnvelope,
  exotic_status: genExoticStatus,
  byte_level: genByteLevel,
  network_error: genNetworkError,
  token_boundary: genTokenBoundary,
};

/** Surfaces that make the family interesting (others still run, less often). */
const SURFACE_WEIGHTS: Record<Family, readonly Surface[]> = {
  malformed_json: SURFACES,
  wrong_type: [
    'permit.reserve',
    'permit.reserve',
    'transport.syncShots',
    'transport.uploadEvaluationTrials',
    'submitAnalysisFeedback',
    'transport.finalizeSession',
    'api.request',
  ],
  proto_pollution: [
    'permit.reserve',
    'permit.reserve',
    'transport.syncShots',
    'api.request',
    'submitAnalysisFeedback',
  ],
  numeric_edge: [
    'permit.reserve',
    'permit.reserve',
    'transport.syncShots',
    'api.request',
    'submitAnalysisFeedback',
  ],
  null_bytes: SURFACES,
  oversized_string: [
    'permit.reserve',
    'permit.reserve',
    'transport.syncShots',
    'transport.finalizeSession',
    'permit.release',
    'submitAnalysisFeedback',
    'api.request',
  ],
  path_traversal_id: [
    'transport.finalizeSession',
    'transport.finalizeSession',
    'permit.release',
    'submitAnalysisFeedback',
    'permit.reserve',
    'transport.createSession',
  ],
  future_schema: [
    'permit.reserve',
    'permit.reserve',
    'transport.syncShots',
    'transport.uploadEvaluationTrials',
    'submitAnalysisFeedback',
  ],
  empty_container: SURFACES,
  unicode_normalization: [
    'permit.reserve',
    'permit.reserve',
    'transport.finalizeSession',
    'permit.release',
    'api.request',
  ],
  error_envelope: SURFACES,
  exotic_status: SURFACES,
  byte_level: SURFACES,
  network_error: SURFACES,
  token_boundary: [
    'permit.reserve',
    'permit.release',
    'transport.syncShots',
    'submitAnalysisFeedback',
  ],
};

export function generateScenario(rng: Rng, seed: number): Scenario {
  const family = rng.pick(FAMILIES);
  const surface = rng.pick(SURFACE_WEIGHTS[family]);
  const generated = GENERATORS[family](rng, surface);
  return {
    seed,
    surface,
    family,
    label: generated.label,
    status: generated.status,
    statusText: generated.statusText ?? '',
    body: generated.body,
    token: generated.token === undefined ? HARNESS_TOKEN : generated.token,
    pathId: generated.pathId ?? HARNESS_UUID,
    oversized: generated.oversized ?? null,
    deepNesting: generated.deepNesting ?? false,
  };
}
