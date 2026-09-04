/**
 * Scenario catalogue + oracle for the server-response matrix.
 *
 * A scenario is a function of the call site (so it can pad / cut / reshape
 * that site's own good body). The oracle turns (call site, scenario class,
 * observed outcome) into a verdict against the mobile contracts:
 *
 *  - no unhandled rejection, ever;
 *  - a non-2xx response never resolves (except the deliberately best-effort
 *    logout);
 *  - a 2xx with a body the parser cannot read never resolves into a value
 *    (no fake success) and never resolves into `null` where `null` means
 *    "the server says there is nothing" (no silent misread);
 *  - retry classes follow the outbox contract (`isPermanentSyncFailure`):
 *    4xx permanent except 401/408/429; 5xx, 429, network and timeout
 *    transient — and the clients that carry their own `retryable` flag agree
 *    (401 ⇒ session expired, not retryable, for every client except the
 *    outbox transport whose 401 is retried after a bearer refresh);
 *  - every call settles: a server that never answers must surface a
 *    timeout instead of leaving the caller (and its UI state) pending forever.
 */
import type { CallSite } from './callSites';
import type { ScenarioResponse } from './scenarioServer';

export type ScenarioClass =
  | 'ok'
  | 'client_error'
  | 'unauthorized'
  | 'timeout_408'
  | 'rate_limited'
  | 'server_error'
  | 'malformed_2xx'
  | 'wrong_shape_2xx'
  | 'partial_2xx'
  | 'oversized_2xx'
  | 'hang'
  | 'reset'
  | 'duplicate'
  | 'fuzz';

export interface MatrixScenario {
  id: string;
  class: ScenarioClass;
  description: string;
  /** Seed for generated scenarios (replay key). */
  seed?: number;
  /** Oracle class when it differs from the descriptive class. */
  judgeAs?: ScenarioClass;
  /** The body is the good shape with its top-level values nulled. */
  nullsKeys?: true;
  /** How long the caller may take before the cell is recorded as hung. */
  deadlineMs: number;
  /** Invoke the call site this many times against the same programme. */
  invocations: number;
  build(site: CallSite): ScenarioResponse;
}

export const DEFAULT_DEADLINE_MS = 8_000;
/** Every mobile client timeout is ≤ 20 s (`API_REQUEST_TIMEOUT_MS`). */
export const HANG_DEADLINE_MS = 25_000;
export const MiB = 1024 * 1024;

const errorEnvelope = (code: string, message: string) => ({
  error: { code, message },
});

function goodResponse(site: CallSite): ScenarioResponse {
  if (site.good.status !== undefined && site.good.body === undefined) {
    return { kind: 'status', status: site.good.status };
  }
  return {
    kind: 'json',
    status: site.good.status ?? 200,
    body: site.good.body,
  };
}

function goodText(site: CallSite): string {
  return JSON.stringify(site.good.body ?? {});
}

function padded(site: CallSite, bytes: number): ScenarioResponse {
  const body = site.good.body;
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    return {
      kind: 'json',
      body: { ...(body as Record<string, unknown>), _pad: 'x'.repeat(bytes) },
    };
  }
  // Void sites (204, no body): the oversized payload is what a misbehaving
  // proxy would attach to an otherwise-successful status.
  return {
    kind: 'json',
    status: site.good.status ?? 200,
    body: body ?? { _pad: 'x'.repeat(bytes) },
  };
}

const scenario = (
  id: string,
  cls: ScenarioClass,
  description: string,
  build: (site: CallSite) => ScenarioResponse,
  options: Partial<
    Pick<MatrixScenario, 'deadlineMs' | 'invocations' | 'judgeAs' | 'nullsKeys'>
  > = {},
): MatrixScenario => ({
  id,
  class: cls,
  description,
  deadlineMs: options.deadlineMs ?? DEFAULT_DEADLINE_MS,
  invocations: options.invocations ?? 1,
  build,
  ...(options.judgeAs ? { judgeAs: options.judgeAs } : {}),
  ...(options.nullsKeys ? { nullsKeys: true } : {}),
});

export const DETERMINISTIC_SCENARIOS: readonly MatrixScenario[] = [
  scenario('ok', 'ok', 'control: the good body', goodResponse),
  scenario(
    'ok_duplicate_x2',
    'duplicate',
    'two identical successful answers to two identical requests',
    goodResponse,
    {
      invocations: 2,
    },
  ),

  // ── 4xx ──────────────────────────────────────────────────────────────────
  scenario(
    'status_400_envelope',
    'client_error',
    '400 with the server error envelope',
    () => ({
      kind: 'status',
      status: 400,
      body: errorEnvelope('validation.invalid_body', 'Invalid request body.'),
    }),
  ),
  scenario('status_400_empty', 'client_error', '400 with no body', () => ({
    kind: 'status',
    status: 400,
  })),
  scenario(
    'status_402_paywall',
    'client_error',
    '402 access.paywall_required',
    () => ({
      kind: 'status',
      status: 402,
      body: errorEnvelope('access.paywall_required', 'Upgrade to keep rating.'),
    }),
  ),
  scenario('status_403_envelope', 'client_error', '403 forbidden', () => ({
    kind: 'status',
    status: 403,
    body: errorEnvelope('auth.forbidden', 'Forbidden.'),
  })),
  scenario('status_404_html', 'client_error', '404 with an HTML body', () => ({
    kind: 'raw',
    status: 404,
    body: '<html><body>Not found</body></html>',
    contentType: 'text/html',
  })),
  scenario('status_405', 'client_error', '405 method not allowed', () => ({
    kind: 'status',
    status: 405,
  })),
  scenario('status_409_envelope', 'client_error', '409 conflict', () => ({
    kind: 'status',
    status: 409,
    body: errorEnvelope('shot.duplicate', 'Already synced.'),
  })),
  scenario('status_410', 'client_error', '410 gone', () => ({
    kind: 'status',
    status: 410,
  })),
  scenario('status_413', 'client_error', '413 payload too large', () => ({
    kind: 'status',
    status: 413,
    body: errorEnvelope('validation.too_large', 'Payload too large.'),
  })),
  scenario('status_422_envelope', 'client_error', '422 unprocessable', () => ({
    kind: 'status',
    status: 422,
    body: errorEnvelope('validation.failed', 'Unprocessable.'),
  })),
  scenario(
    'status_401_envelope',
    'unauthorized',
    '401 with the auth envelope',
    () => ({
      kind: 'status',
      status: 401,
      body: errorEnvelope('auth.unauthorized', 'Invalid or expired token.'),
    }),
  ),
  scenario('status_401_empty', 'unauthorized', '401 with no body', () => ({
    kind: 'status',
    status: 401,
  })),
  scenario(
    'status_408',
    'timeout_408',
    'server-sent 408 request timeout',
    () => ({
      kind: 'status',
      status: 408,
      body: errorEnvelope('network.timeout', 'Request timeout.'),
    }),
  ),

  // ── 429 ──────────────────────────────────────────────────────────────────
  scenario(
    'status_429_retry_after_seconds',
    'rate_limited',
    '429 exactly as rateLimit.ts emits it (Retry-After: 7)',
    () => ({
      kind: 'status',
      status: 429,
      body: errorEnvelope(
        'rate_limited',
        'Too many requests. Please slow down and try again shortly.',
      ),
      headers: {
        'Retry-After': '7',
        'RateLimit-Limit': '30',
        'RateLimit-Remaining': '0',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    }),
  ),
  scenario(
    'status_429_retry_after_http_date',
    'rate_limited',
    '429 with an HTTP-date Retry-After',
    () => ({
      kind: 'status',
      status: 429,
      body: errorEnvelope('rate_limited', 'Too many requests.'),
      headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' },
    }),
  ),
  scenario(
    'status_429_retry_after_huge',
    'rate_limited',
    '429 with Retry-After: 3600 (delete-request budget)',
    () => ({
      kind: 'status',
      status: 429,
      body: errorEnvelope('rate_limited', 'Too many requests.'),
      headers: { 'Retry-After': '3600' },
    }),
  ),
  scenario(
    'status_429_no_header',
    'rate_limited',
    '429 without Retry-After and no body',
    () => ({
      kind: 'status',
      status: 429,
    }),
  ),

  // ── 5xx ──────────────────────────────────────────────────────────────────
  scenario(
    'status_500_generic',
    'server_error',
    '500 with the generic envelope',
    () => ({
      kind: 'status',
      status: 500,
      body: errorEnvelope('internal', 'Something went wrong.'),
    }),
  ),
  scenario('status_500_empty', 'server_error', '500 with no body', () => ({
    kind: 'status',
    status: 500,
  })),
  scenario('status_502_html', 'server_error', '502 gateway HTML', () => ({
    kind: 'raw',
    status: 502,
    body: '<html><head><title>502 Bad Gateway</title></head></html>',
    contentType: 'text/html',
  })),
  scenario(
    'status_503_retry_after',
    'server_error',
    '503 with Retry-After: 30',
    () => ({
      kind: 'status',
      status: 503,
      body: errorEnvelope('unavailable', 'Try again later.'),
      headers: { 'Retry-After': '30' },
    }),
  ),
  scenario(
    'status_504_empty',
    'server_error',
    '504 gateway timeout, empty',
    () => ({
      kind: 'status',
      status: 504,
    }),
  ),
  scenario(
    'status_500_good_body',
    'server_error',
    '500 whose body is the GOOD payload (status must win)',
    site => ({
      kind: 'json',
      status: 500,
      body: site.good.body ?? {},
    }),
  ),

  // ── 2xx with unreadable bodies ───────────────────────────────────────────
  scenario(
    'malformed_unterminated',
    'malformed_2xx',
    '200 `{"a":` (unterminated JSON)',
    () => ({
      kind: 'raw',
      body: '{"a":',
    }),
  ),
  scenario(
    'malformed_html',
    'malformed_2xx',
    '200 HTML captive-portal page',
    () => ({
      kind: 'raw',
      body: '<!DOCTYPE html><html><body>Sign in to the Wi-Fi</body></html>',
      contentType: 'text/html',
    }),
  ),
  scenario(
    'malformed_empty',
    'malformed_2xx',
    '200 with an empty body',
    () => ({
      kind: 'raw',
      body: '',
    }),
  ),
  scenario(
    'malformed_nan_literal',
    'malformed_2xx',
    '200 `{"rating":NaN}`',
    () => ({
      kind: 'raw',
      body: '{"rating":NaN}',
    }),
  ),
  scenario(
    'malformed_trailing_garbage',
    'malformed_2xx',
    '200 good JSON followed by garbage',
    site => ({
      kind: 'raw',
      body: `${goodText(site)}garbage`,
    }),
  ),
  scenario('malformed_single_quotes', 'malformed_2xx', "200 `{'a':1}`", () => ({
    kind: 'raw',
    body: "{'a':1}",
  })),
  scenario(
    'malformed_204_with_body_expected',
    'malformed_2xx',
    '204 No Content where a body is expected',
    () => ({
      kind: 'status',
      status: 204,
    }),
  ),

  // ── 2xx with well-formed JSON of the wrong shape ─────────────────────────
  scenario('shape_null', 'wrong_shape_2xx', '200 `null`', () => ({
    kind: 'json',
    body: null,
  })),
  scenario('shape_empty_object', 'wrong_shape_2xx', '200 `{}`', () => ({
    kind: 'json',
    body: {},
  })),
  scenario('shape_empty_array', 'wrong_shape_2xx', '200 `[]`', () => ({
    kind: 'json',
    body: [],
  })),
  scenario('shape_string', 'wrong_shape_2xx', '200 `"ok"`', () => ({
    kind: 'json',
    body: 'ok',
  })),
  scenario('shape_number', 'wrong_shape_2xx', '200 `1`', () => ({
    kind: 'json',
    body: 1,
  })),
  scenario('shape_boolean_true', 'wrong_shape_2xx', '200 `true`', () => ({
    kind: 'json',
    body: true,
  })),
  scenario(
    'shape_error_envelope_on_200',
    'wrong_shape_2xx',
    '200 carrying an error envelope',
    () => ({
      kind: 'json',
      body: errorEnvelope('internal', 'Masked failure.'),
    }),
  ),
  scenario(
    'shape_keys_nulled',
    'wrong_shape_2xx',
    '200 good keys, every top-level value null',
    site => {
      const body = site.good.body;
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        return {
          kind: 'json',
          body: Object.fromEntries(Object.keys(body).map(key => [key, null])),
        };
      }
      return { kind: 'json', body: null };
    },
    { nullsKeys: true },
  ),
  scenario(
    'shape_duplicate_keys_last_wins',
    'wrong_shape_2xx',
    '200 with every top-level key duplicated (second copy null)',
    site => {
      const body = site.good.body;
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        const entries = Object.entries(body).map(
          ([key, value]) =>
            `${JSON.stringify(key)}:${JSON.stringify(value)},${JSON.stringify(key)}:null`,
        );
        return { kind: 'raw', body: `{${entries.join(',')}}` };
      }
      return { kind: 'json', body: null };
    },
    { nullsKeys: true },
  ),
  scenario(
    'shape_text_plain_good_json',
    'ok',
    '200 good JSON served as text/plain',
    site => ({
      kind: 'raw',
      body: goodText(site),
      contentType: 'text/plain',
    }),
  ),
  scenario(
    'shape_bom_prefixed_good_json',
    'ok',
    '200 good JSON with a UTF-8 BOM',
    site => ({
      kind: 'raw',
      body: `\uFEFF${goodText(site)}`,
    }),
  ),

  // ── partial bodies ───────────────────────────────────────────────────────
  scenario(
    'partial_truncated_half_then_reset',
    'partial_2xx',
    '200, Content-Length of the full body, half the bytes, socket destroyed',
    site => {
      const text = goodText(site);
      return {
        kind: 'truncated',
        body: text,
        sendBytes: Math.floor(text.length / 2),
      };
    },
  ),
  scenario(
    'partial_truncated_zero_then_reset',
    'partial_2xx',
    '200 headers only, then socket destroyed',
    site => ({
      kind: 'truncated',
      body: goodText(site),
      sendBytes: 0,
    }),
  ),
  scenario(
    'partial_clean_cut_half',
    'partial_2xx',
    '200 clean prefix (half of the JSON text)',
    site => {
      const text = goodText(site);
      return { kind: 'prefix', body: text, cut: Math.floor(text.length / 2) };
    },
  ),
  scenario(
    'partial_clean_cut_last_byte',
    'partial_2xx',
    '200 clean prefix missing the final byte',
    site => {
      const text = goodText(site);
      return { kind: 'prefix', body: text, cut: Math.max(0, text.length - 1) };
    },
  ),

  // ── oversized bodies ─────────────────────────────────────────────────────
  scenario(
    'oversized_1mib_padded_good',
    'oversized_2xx',
    '200 good body + 1 MiB padding key',
    site => padded(site, MiB),
    {
      deadlineMs: 20_000,
      judgeAs: 'ok',
    },
  ),
  scenario(
    'oversized_8mib_padded_good',
    'oversized_2xx',
    '200 good body + 8 MiB padding key',
    site => padded(site, 8 * MiB),
    {
      deadlineMs: 20_000,
      judgeAs: 'ok',
    },
  ),
  scenario(
    'oversized_8mib_string',
    'oversized_2xx',
    '200 a single 8 MiB JSON string',
    () => ({
      kind: 'raw',
      body: `"${'A'.repeat(8 * MiB)}"`,
    }),
    { deadlineMs: 20_000, judgeAs: 'wrong_shape_2xx' },
  ),
  scenario(
    'oversized_8mib_malformed',
    'oversized_2xx',
    '200 8 MiB of `A` (not JSON)',
    () => ({
      kind: 'raw',
      body: 'A'.repeat(8 * MiB),
    }),
    { deadlineMs: 20_000, judgeAs: 'malformed_2xx' },
  ),
  scenario(
    'oversized_deep_nesting',
    'oversized_2xx',
    '200 `[[[[…]]]]` nested 100k deep',
    () => ({
      kind: 'raw',
      body: `${'['.repeat(100_000)}${']'.repeat(100_000)}`,
    }),
    { deadlineMs: 20_000, judgeAs: 'wrong_shape_2xx' },
  ),

  // ── connection-level ─────────────────────────────────────────────────────
  scenario(
    'reset_before_headers',
    'reset',
    'socket destroyed before any status line',
    () => ({ kind: 'reset' }),
  ),
  scenario(
    'hang_no_response',
    'hang',
    'server accepts the request and never answers',
    () => ({
      kind: 'hang',
      mode: 'no_response',
    }),
    { deadlineMs: HANG_DEADLINE_MS },
  ),
  scenario(
    'hang_headers_only',
    'hang',
    '200 headers, body never completes',
    () => ({
      kind: 'hang',
      mode: 'headers_only',
    }),
    { deadlineMs: HANG_DEADLINE_MS, judgeAs: 'partial_2xx' },
  ),
];

// ── seeded fuzz ────────────────────────────────────────────────────────────

/** mulberry32 — tiny, deterministic, good enough to pick mutation sites. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type JsonPath = Array<string | number>;

function collectPaths(value: unknown, prefix: JsonPath, out: JsonPath[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      out.push([...prefix, index]);
      collectPaths(item, [...prefix, index], out);
    });
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push([...prefix, key]);
      collectPaths(item, [...prefix, key], out);
    }
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function setAt(root: unknown, path: JsonPath, next: unknown): unknown {
  if (path.length === 0) return next;
  const copy = clone(root) as Record<string, unknown> | unknown[];
  let cursor: unknown = copy;
  for (let index = 0; index < path.length - 1; index += 1) {
    cursor = (cursor as Record<string, unknown>)[String(path[index])];
  }
  const last = path[path.length - 1];
  if (Array.isArray(cursor)) cursor[Number(last)] = next;
  else (cursor as Record<string, unknown>)[String(last)] = next;
  return copy;
}

function deleteAt(root: unknown, path: JsonPath): unknown {
  if (path.length === 0) return null;
  const copy = clone(root) as Record<string, unknown> | unknown[];
  let cursor: unknown = copy;
  for (let index = 0; index < path.length - 1; index += 1) {
    cursor = (cursor as Record<string, unknown>)[String(path[index])];
  }
  const last = path[path.length - 1];
  if (Array.isArray(cursor)) cursor.splice(Number(last), 1);
  else delete (cursor as Record<string, unknown>)[String(last)];
  return copy;
}

const WRONG_TYPE_VALUES: readonly unknown[] = [
  null,
  '',
  'string',
  0,
  -1,
  1e308,
  Number.MAX_SAFE_INTEGER + 1,
  true,
  false,
  [],
  {},
  [null],
  { nested: true },
  '2026-13-45T99:99:99Z',
  'not-a-uuid',
  '0'.repeat(4096),
];

export type FuzzOperation =
  | 'delete_path'
  | 'wrong_type'
  | 'duplicate_array_item'
  | 'truncate_text'
  | 'swap_two_leaves'
  | 'deep_wrap';

export interface FuzzMutation {
  seed: number;
  operation: FuzzOperation;
  path: JsonPath | null;
  detail: string;
  response: ScenarioResponse;
}

/** One deterministic mutation of the site's good body, identified by seed. */
export function fuzzMutation(site: CallSite, seed: number): FuzzMutation {
  const random = seededRandom(seed);
  const good = site.good.body ?? {};
  const paths: JsonPath[] = [];
  collectPaths(good, [], paths);
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)] as T;
  const operations: FuzzOperation[] = [
    'delete_path',
    'wrong_type',
    'duplicate_array_item',
    'truncate_text',
    'swap_two_leaves',
    'deep_wrap',
  ];
  const operation = pick(operations);
  const path = paths.length > 0 ? pick(paths) : null;

  switch (operation) {
    case 'delete_path': {
      if (!path)
        return {
          seed,
          operation,
          path,
          detail: 'no paths; body → null',
          response: { kind: 'json', body: null },
        };
      return {
        seed,
        operation,
        path,
        detail: `delete ${path.join('.')}`,
        response: { kind: 'json', body: deleteAt(good, path) },
      };
    }
    case 'wrong_type': {
      const value = pick(WRONG_TYPE_VALUES);
      if (!path)
        return {
          seed,
          operation,
          path,
          detail: `body → ${JSON.stringify(value)}`,
          response: { kind: 'json', body: value },
        };
      return {
        seed,
        operation,
        path,
        detail: `${path.join('.')} → ${JSON.stringify(value)}`,
        response: { kind: 'json', body: setAt(good, path, value) },
      };
    }
    case 'duplicate_array_item': {
      const arrayPaths = paths.filter(candidate => {
        let cursor: unknown = good;
        for (const step of candidate)
          cursor = (cursor as Record<string, unknown>)[String(step)];
        return Array.isArray(cursor) && cursor.length > 0;
      });
      if (arrayPaths.length === 0) {
        return {
          seed,
          operation,
          path: null,
          detail: 'no arrays; wrap body in array',
          response: { kind: 'json', body: [good, good] },
        };
      }
      const target = pick(arrayPaths);
      let cursor: unknown = good;
      for (const step of target)
        cursor = (cursor as Record<string, unknown>)[String(step)];
      const items = cursor as unknown[];
      const duplicated = [...items, ...items];
      return {
        seed,
        operation,
        path: target,
        detail: `${target.join('.')} duplicated (${items.length} → ${duplicated.length})`,
        response: { kind: 'json', body: setAt(good, target, duplicated) },
      };
    }
    case 'truncate_text': {
      const text = JSON.stringify(good);
      const cut = Math.floor(random() * text.length);
      return {
        seed,
        operation,
        path: null,
        detail: `text cut at byte ${cut}/${text.length}`,
        response: { kind: 'prefix', body: text, cut },
      };
    }
    case 'swap_two_leaves': {
      if (paths.length < 2)
        return {
          seed,
          operation,
          path: null,
          detail: 'fewer than two paths',
          response: { kind: 'json', body: good },
        };
      const isAncestor = (shorter: JsonPath, longer: JsonPath) =>
        shorter.length < longer.length &&
        shorter.every((step, index) => String(step) === String(longer[index]));
      const disjoint = (x: JsonPath, y: JsonPath) =>
        !isAncestor(x, y) && !isAncestor(y, x);
      const a = pick(paths);
      const candidates = paths.filter(
        candidate =>
          candidate.join('\u0000') !== a.join('\u0000') &&
          disjoint(a, candidate),
      );
      if (candidates.length === 0)
        return {
          seed,
          operation,
          path: a,
          detail: 'no disjoint partner path',
          response: { kind: 'json', body: good },
        };
      const b = pick(candidates);
      const read = (root: unknown, at: JsonPath): unknown => {
        let cursor: unknown = root;
        for (const step of at)
          cursor = (cursor as Record<string, unknown>)[String(step)];
        return cursor;
      };
      const valueA = read(good, a);
      const valueB = read(good, b);
      return {
        seed,
        operation,
        path: a,
        detail: `swap ${a.join('.')} ↔ ${b.join('.')}`,
        response: {
          kind: 'json',
          body: setAt(setAt(good, a, valueB), b, valueA),
        },
      };
    }
    case 'deep_wrap': {
      const depth = 1 + Math.floor(random() * 3);
      let wrapped: unknown = good;
      for (let index = 0; index < depth; index += 1)
        wrapped = { data: wrapped };
      return {
        seed,
        operation,
        path: null,
        detail: `wrapped in {data:…} × ${depth}`,
        response: { kind: 'json', body: wrapped },
      };
    }
  }
}

export function fuzzScenario(site: CallSite, seed: number): MatrixScenario {
  const mutation = fuzzMutation(site, seed);
  return {
    id: `fuzz_${seed}`,
    class: 'fuzz',
    description: `${mutation.operation}: ${mutation.detail}`,
    seed,
    deadlineMs: DEFAULT_DEADLINE_MS,
    invocations: 1,
    build: () => mutation.response,
  };
}

// ── oracle ─────────────────────────────────────────────────────────────────

export type Settlement = 'resolved' | 'rejected' | 'hung';

export interface ObservedOutcome {
  settlement: Settlement;
  /** `null` for rejections; `'null'` when a promise resolved to null. */
  resolvedKind: 'null' | 'undefined' | 'value' | null;
  retryable: boolean | null;
  untyped: boolean;
  unhandledRejections: number;
  unauthorizedReports: number;
}

export type Violation =
  | 'unhandled_rejection'
  | 'fake_success'
  | 'silent_null'
  | 'resolved_on_error_status'
  | 'rejected_on_ok'
  | 'no_timeout'
  | 'retry_class_permanent_expected'
  | 'retry_class_transient_expected'
  | 'unauthorized_not_reported'
  | 'unauthorized_reported_twice';

const REPORTS_UNAUTHORIZED: ReadonlySet<CallSite['family']> = new Set([
  'outbox',
  'permit',
  'feedback',
  'training',
  'billing',
]);

/** Which families treat a 401 as transient (bearer refresh) per the outbox contract. */
const TRANSIENT_401: ReadonlySet<CallSite['family']> = new Set([
  'outbox',
  'permit',
  'feedback',
]);

export function judge(
  site: CallSite,
  cls: ScenarioClass,
  observed: ObservedOutcome,
  scenario?: Pick<MatrixScenario, 'nullsKeys'>,
): Violation[] {
  const violations: Violation[] = [];
  if (observed.unhandledRejections > 0) violations.push('unhandled_rejection');
  if (observed.settlement === 'hung') {
    violations.push('no_timeout');
    return violations;
  }
  const resolved = observed.settlement === 'resolved';
  const bestEffort = site.returns === 'best_effort';

  switch (cls) {
    case 'ok':
    case 'duplicate':
      if (!resolved) violations.push('rejected_on_ok');
      break;

    case 'client_error':
    case 'unauthorized':
    case 'timeout_408':
    case 'rate_limited':
    case 'server_error':
    case 'reset':
      if (bestEffort) break;
      if (resolved) {
        violations.push('resolved_on_error_status');
        break;
      }
      if (cls === 'client_error' && observed.retryable === true) {
        violations.push('retry_class_permanent_expected');
      }
      if (
        (cls === 'rate_limited' || cls === 'server_error' || cls === 'reset') &&
        observed.retryable === false
      ) {
        violations.push('retry_class_transient_expected');
      }
      if (cls === 'unauthorized') {
        const expectTransient = TRANSIENT_401.has(site.family);
        if (expectTransient && observed.retryable === false)
          violations.push('retry_class_transient_expected');
        if (!expectTransient && observed.retryable === true)
          violations.push('retry_class_permanent_expected');
        if (REPORTS_UNAUTHORIZED.has(site.family)) {
          if (observed.unauthorizedReports === 0)
            violations.push('unauthorized_not_reported');
          if (observed.unauthorizedReports > 1)
            violations.push('unauthorized_reported_twice');
        }
      }
      if (
        cls === 'timeout_408' &&
        site.family === 'outbox' &&
        observed.retryable === false
      ) {
        violations.push('retry_class_transient_expected');
      }
      break;

    case 'malformed_2xx':
    case 'wrong_shape_2xx':
    case 'partial_2xx':
      if (!resolved) break;
      if (site.returns === 'value') violations.push('fake_success');
      if (site.returns === 'nullable') {
        // `{plan: null}` / `{rank: null}` IS the documented absent signal.
        if (
          site.nullOnNulledKeys &&
          scenario?.nullsKeys &&
          observed.resolvedKind === 'null'
        )
          break;
        violations.push(
          observed.resolvedKind === 'null' ? 'silent_null' : 'fake_success',
        );
      }
      break;

    case 'oversized_2xx':
    case 'fuzz':
    case 'hang':
      // Settled without an unhandled rejection is the only hard requirement;
      // the row is recorded for triage (fake-success candidates are derived
      // from the resolved value in the report, not from a fixed oracle,
      // because a fuzzed body can still be legitimately parseable).
      break;
  }
  return violations;
}
