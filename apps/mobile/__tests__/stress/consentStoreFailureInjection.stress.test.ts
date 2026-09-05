/**
 * STRESS / failure-injection — `state/consentStore` (unit `mod-consent-store`).
 *
 * The store has exactly three dependencies that can fail: the injected
 * `ConsentFetch` (transport + Response + body), the in-memory API session
 * (`getApiSession`, which can change or vanish mid-flight) and the clock
 * (`CONSENT_REQUEST_TIMEOUT_MS` abort timer). Every one of them is attacked
 * here from a data-driven fault catalogue (`FAULTS`, 60+ distinct faults) —
 * throw / reject / timeout / malformed / partial / slow / never-resolves —
 * against every store operation, then from a seeded random campaign that
 * interleaves faults with sign-out, account switches and bearer rotation.
 *
 * Invariants asserted after every scenario (fake clock advanced 60 s):
 *  - the store call never rejects (the screen calls it with `void`);
 *  - no infinite spinner: `busy === false` and `availability !== 'loading'`;
 *  - no fake success: `modelTrainingActive` is true only when a VALID server
 *    response for the CURRENT account said so;
 *  - no silent failure: a failure that is the latest landed event leaves
 *    `error !== null` or `availability === 'unavailable'` (the screen renders
 *    a "Try again" control for `unavailable`);
 *  - no timer leak (`jest.getTimerCount() === 0`) and exactly one fetch per
 *    operation that had a session;
 *  - a signed-out end state is exactly the signed-out constant.
 *
 * The store has no persisted state (in-memory zustand only), so "no corrupted
 * persisted state" is vacuous here and asserted as "no persistence attempted".
 *
 * Reproduce a campaign iteration:
 *   STRESS_ITER=<n> STRESS_SEED=<seed> npx jest --ci consentStoreFailureInjection
 * Write the seed → outcome table:
 *   STRESS_OUT=/tmp/consent-stress.json npx jest --ci consentStoreFailureInjection
 *
 * `test.failing` blocks assert the EXPECTED behaviour of documented findings
 * and must be flipped to plain `test` when the underlying issue is fixed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Platform } from 'react-native';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
  setApiUnauthorizedListener,
  type ApiSession,
} from '../../src/account/apiSession';
import {
  CONSENT_REQUEST_TIMEOUT_MS,
  MODEL_TRAINING_CONSENT_VERSION,
  type ConsentFetch,
} from '../../src/account/consentApi';
import {
  useConsentStore,
  type ConsentAvailability,
} from '../../src/state/consentStore';

// getRuntimePublicConfig() is read while the request headers are built; the
// factory below lets one fault make it throw without touching the real module.
let mockRuntimeConfigThrows = false;
jest.mock('../../src/config/runtimeConfig', () => {
  const actual = jest.requireActual<
    typeof import('../../src/config/runtimeConfig')
  >('../../src/config/runtimeConfig');
  return {
    ...actual,
    getRuntimePublicConfig: () => {
      if (mockRuntimeConfigThrows) {
        throw new Error('runtime config unavailable');
      }
      return actual.getRuntimePublicConfig();
    },
  };
});

// ─── Seeded PRNG (mulberry32): every iteration replayable from its seed ─────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('pick from empty list');
  return item;
}

function int(rng: () => number, min: number, maxInclusive: number): number {
  return min + Math.floor(rng() * (maxInclusive - min + 1));
}

// ─── Sessions ───────────────────────────────────────────────────────────────

const ACCOUNT_A = 'a0000000-0000-4000-8000-00000000000a';
const ACCOUNT_B = 'b0000000-0000-4000-8000-00000000000b';

function session(
  canonicalAppUserId: string,
  bearerToken = `token-${canonicalAppUserId.slice(-1)}`,
): ApiSession {
  return {
    apiBaseUrl: 'https://api.test',
    bearerToken,
    canonicalAppUserId,
    provider: 'apple',
  };
}

const SIGNED_OUT = {
  availability: 'signed_out' as ConsentAvailability,
  modelTrainingActive: false,
  lastActionAt: null,
  busy: false,
  error: null,
};

function resetStore(): void {
  useConsentStore.setState({
    availability: 'loading',
    modelTrainingActive: false,
    lastActionAt: null,
    busy: false,
    error: null,
  });
}

function snapshot() {
  const s = useConsentStore.getState();
  return {
    availability: s.availability,
    modelTrainingActive: s.modelTrainingActive,
    lastActionAt: s.lastActionAt,
    busy: s.busy,
    error: s.error,
  };
}

// ─── Payload builders ───────────────────────────────────────────────────────

function scopeRow(scope: string, active: boolean, overrides: object = {}) {
  return {
    scope,
    active,
    consentVersion: active ? MODEL_TRAINING_CONSENT_VERSION : null,
    lastAction: active ? 'granted' : 'withdrawn',
    lastActionAt: '2026-09-05T00:00:00.000Z',
    ...overrides,
  };
}

function validStatus(modelTrainingActive: boolean, extra: object = {}) {
  return {
    subjectPseudonym: 'c0000000-0000-4000-8000-00000000000c',
    scopes: [
      scopeRow('video_analysis', true),
      scopeRow('model_training', modelTrainingActive),
      scopeRow('evaluation_telemetry', false),
    ],
    ...extra,
  };
}

// ─── Fault catalogue ────────────────────────────────────────────────────────

/**
 * How the injected fetch behaves for ONE request.
 *  - `expected: 'success'`  → a valid ledger response lands; `active` is what
 *    the store must display afterwards.
 *  - `expected: 'failure'`  → the store must surface a visible error and keep
 *    the ledger-derived state untouched (toggle) or go `unavailable` (hydrate).
 *  - `expected: 'contract_hang'` → the dependency violates the fetch contract
 *    (never settles AND ignores AbortSignal, or a Response whose body never
 *    arrives). React Native's fetch (whatwg-fetch over XHR, verified in
 *    node_modules/react-native/Libraries/Network/fetch.js) cannot produce
 *    either, so these rows are recorded, not counted as broken.
 */
type Expected = 'success' | 'failure' | 'contract_hang';

interface Fault {
  id: string;
  dependency:
    'transport' | 'response' | 'body' | 'http' | 'payload' | 'clock' | 'config';
  describe: string;
  expected: Expected;
  /** For `success`: what a hydrate must display. Toggles override via server. */
  active?: boolean;
  /** Fetch factory. `active` is the ledger value the server would report. */
  make: (active: boolean) => ConsentFetch;
  /** Whether `reportApiUnauthorized` is expected to be invoked. */
  status?: number;
  /** Number of fetch invocations expected (default 1; 0 when the request never leaves the client). */
  fetchCalls?: number;
}

function response(
  body: unknown,
  init: { ok?: unknown; status?: number; jsonMode?: JsonMode } = {},
): Response {
  const ok = 'ok' in init ? init.ok : true;
  const { status = ok ? 200 : 500, jsonMode = 'resolve' } = init;
  const json = (): Promise<unknown> => {
    switch (jsonMode) {
      case 'resolve':
        return Promise.resolve(body);
      case 'reject':
        return Promise.reject(new SyntaxError('Unexpected token < in JSON'));
      case 'throw':
        throw new TypeError('body already consumed');
      case 'never':
        return new Promise<never>(() => {});
      case 'slow':
        return new Promise(resolve => setTimeout(() => resolve(body), 20_000));
    }
  };
  return { ok, status, json } as unknown as Response;
}

type JsonMode = 'resolve' | 'reject' | 'throw' | 'never' | 'slow';

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

/** Resolves/rejects after `delayMs` unless the AbortSignal fires first. */
function delayed(
  delayMs: number,
  settle: () => Response,
  honorsAbort = true,
): ConsentFetch {
  return (_input, init) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          resolve(settle());
        } catch (error) {
          reject(error);
        }
      }, delayMs);
      if (honorsAbort) {
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(abortError());
        });
      }
    });
}

function never(honorsAbort: boolean): ConsentFetch {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      if (honorsAbort) {
        init?.signal?.addEventListener('abort', () => reject(abortError()));
      }
    });
}

const immediate =
  (make: (active: boolean) => Response) =>
  (active: boolean): ConsentFetch =>
  () =>
    Promise.resolve(make(active));

const HTTP_FAILURE_STATUSES = [
  400, 401, 403, 404, 408, 409, 410, 413, 422, 429, 451, 500, 501, 502, 503,
  504,
];

const FAULTS: Fault[] = [
  // transport ────────────────────────────────────────────────────────────
  {
    id: 'F01',
    dependency: 'transport',
    describe: 'fetch throws synchronously (TypeError)',
    expected: 'failure',
    make: () => () => {
      throw new TypeError('Network request failed');
    },
  },
  {
    id: 'F02',
    dependency: 'transport',
    describe: 'fetch rejects with TypeError("Network request failed")',
    expected: 'failure',
    make: () => () => Promise.reject(new TypeError('Network request failed')),
  },
  {
    id: 'F03',
    dependency: 'transport',
    describe: 'fetch rejects with a non-Error string',
    expected: 'failure',
    make: () => () => Promise.reject('boom'),
  },
  {
    id: 'F04',
    dependency: 'transport',
    describe: 'fetch rejects with undefined',
    expected: 'failure',
    make: () => () => Promise.reject(undefined),
  },
  {
    id: 'F05',
    dependency: 'transport',
    describe: 'fetch rejects with an AbortError immediately',
    expected: 'failure',
    make: () => () => Promise.reject(abortError()),
  },
  {
    id: 'F06',
    dependency: 'clock',
    describe: 'fetch never settles but honours AbortSignal (real RN fetch)',
    expected: 'failure',
    make: () => never(true),
  },
  {
    id: 'F07',
    dependency: 'clock',
    describe:
      'fetch never settles AND ignores AbortSignal (contract violation)',
    expected: 'contract_hang',
    make: () => never(false),
  },
  {
    id: 'F08',
    dependency: 'clock',
    describe: 'fetch resolves 1 ms before the 15 s abort',
    expected: 'success',
    make: active =>
      delayed(CONSENT_REQUEST_TIMEOUT_MS - 1, () =>
        response(validStatus(active)),
      ),
  },
  {
    id: 'F09',
    dependency: 'clock',
    describe: 'fetch would resolve 1 ms after the 15 s abort (aborted)',
    expected: 'failure',
    make: active =>
      delayed(CONSENT_REQUEST_TIMEOUT_MS + 1, () =>
        response(validStatus(active)),
      ),
  },
  {
    id: 'F10',
    dependency: 'clock',
    describe: 'fetch would resolve exactly at the 15 s boundary',
    expected: 'failure',
    make: active =>
      delayed(CONSENT_REQUEST_TIMEOUT_MS, () => response(validStatus(active))),
  },
  {
    id: 'F11',
    dependency: 'clock',
    describe: 'slow success (5 s)',
    expected: 'success',
    make: active => delayed(5_000, () => response(validStatus(active))),
  },
  {
    id: 'F12',
    dependency: 'clock',
    describe: 'slow failure: 503 after 10 s',
    expected: 'failure',
    status: 503,
    make: () =>
      delayed(10_000, () =>
        response({ error: 'down' }, { ok: false, status: 503 }),
      ),
  },
  {
    id: 'F13',
    dependency: 'clock',
    describe: 'slow rejection after 14 s (ignores abort, settles on its own)',
    expected: 'failure',
    make: () =>
      delayed(
        14_000,
        () => {
          throw new TypeError('Network request failed');
        },
        false,
      ),
  },
  {
    id: 'F14',
    dependency: 'clock',
    describe:
      'fetch ignores abort and resolves late at 40 s (post-abort success)',
    expected: 'success',
    make: active => delayed(40_000, () => response(validStatus(active)), false),
  },
  // response object ───────────────────────────────────────────────────────
  {
    id: 'F15',
    dependency: 'response',
    describe: 'fetch resolves with undefined instead of a Response',
    expected: 'failure',
    make: () => () => Promise.resolve(undefined as unknown as Response),
  },
  {
    id: 'F16',
    dependency: 'response',
    describe: 'fetch resolves with null',
    expected: 'failure',
    make: () => () => Promise.resolve(null as unknown as Response),
  },
  {
    id: 'F17',
    dependency: 'response',
    describe: 'Response without a json() method',
    expected: 'failure',
    make: () => () =>
      Promise.resolve({ ok: true, status: 200 } as unknown as Response),
  },
  {
    id: 'F18',
    dependency: 'response',
    describe: 'Response whose json is not a function',
    expected: 'failure',
    make: () => () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: 42,
      } as unknown as Response),
  },
  {
    id: 'F19',
    dependency: 'response',
    describe: 'Response.ok undefined (status 200)',
    expected: 'failure',
    make: immediate(active =>
      response(validStatus(active), { ok: undefined, status: 200 }),
    ),
  },
  {
    id: 'F20',
    dependency: 'response',
    describe:
      'Response.ok is the truthy string "yes" (non-boolean, treated ok)',
    expected: 'success',
    make: immediate(active =>
      response(validStatus(active), { ok: 'yes', status: 200 }),
    ),
  },
  // body ─────────────────────────────────────────────────────────────────
  {
    id: 'F21',
    dependency: 'body',
    describe: 'json() rejects (HTML error page)',
    expected: 'failure',
    make: () => () => Promise.resolve(response(null, { jsonMode: 'reject' })),
  },
  {
    id: 'F22',
    dependency: 'body',
    describe: 'json() throws synchronously',
    expected: 'failure',
    make: () => () => Promise.resolve(response(null, { jsonMode: 'throw' })),
  },
  {
    id: 'F23',
    dependency: 'body',
    describe:
      'json() never resolves (stalled body after headers; contract violation)',
    expected: 'contract_hang',
    make: () => () => Promise.resolve(response(null, { jsonMode: 'never' })),
  },
  {
    id: 'F24',
    dependency: 'body',
    describe: 'json() resolves slowly (20 s, past the abort window)',
    expected: 'success',
    make: immediate(active =>
      response(validStatus(active), { jsonMode: 'slow' }),
    ),
  },
  {
    id: 'F25',
    dependency: 'body',
    describe: '200 with empty body (json() rejects)',
    expected: 'failure',
    make: () => () =>
      Promise.resolve(response(null, { status: 200, jsonMode: 'reject' })),
  },
  {
    id: 'F26',
    dependency: 'body',
    describe: '204 No Content with ok:true and null payload',
    expected: 'failure',
    make: () => () => Promise.resolve(response(null, { status: 204 })),
  },
  // http statuses ────────────────────────────────────────────────────────
  ...HTTP_FAILURE_STATUSES.map((status, index): Fault => ({
    id: `H${String(index + 1).padStart(2, '0')}`,
    dependency: 'http',
    describe: `HTTP ${status} with JSON error body`,
    expected: 'failure',
    status,
    make: () => () =>
      Promise.resolve(
        response({ error: { code: 'x', message: 'y' } }, { ok: false, status }),
      ),
  })),
  {
    id: 'H17',
    dependency: 'http',
    describe: 'HTTP 500 whose body is not JSON',
    expected: 'failure',
    status: 500,
    make: () => () =>
      Promise.resolve(
        response(null, { ok: false, status: 500, jsonMode: 'reject' }),
      ),
  },
  {
    id: 'H18',
    dependency: 'http',
    describe: 'HTTP 403 carrying a VALID status payload (must not be applied)',
    expected: 'failure',
    status: 403,
    make: () => () =>
      Promise.resolve(response(validStatus(true), { ok: false, status: 403 })),
  },
  // payload shape ────────────────────────────────────────────────────────
  {
    id: 'P01',
    dependency: 'payload',
    describe: 'payload null',
    expected: 'failure',
    make: immediate(() => response(null)),
  },
  {
    id: 'P02',
    dependency: 'payload',
    describe: 'payload is a string',
    expected: 'failure',
    make: immediate(() => response('ok')),
  },
  {
    id: 'P03',
    dependency: 'payload',
    describe: 'payload is an array',
    expected: 'failure',
    make: immediate(() => response([validStatus(true)])),
  },
  {
    id: 'P04',
    dependency: 'payload',
    describe: 'payload {} (no scopes)',
    expected: 'failure',
    make: immediate(() => response({})),
  },
  {
    id: 'P05',
    dependency: 'payload',
    describe: 'scopes is an object, not an array',
    expected: 'failure',
    make: immediate(() =>
      response({ subjectPseudonym: null, scopes: { model_training: true } }),
    ),
  },
  {
    id: 'P06',
    dependency: 'payload',
    describe: 'scopes: [] (valid, no model_training → off)',
    expected: 'success',
    active: false,
    make: immediate(() => response({ subjectPseudonym: null, scopes: [] })),
  },
  {
    id: 'P07',
    dependency: 'payload',
    describe: 'scopes: [null]',
    expected: 'failure',
    make: immediate(() => response({ subjectPseudonym: null, scopes: [null] })),
  },
  {
    id: 'P08',
    dependency: 'payload',
    describe: 'unknown scope name',
    expected: 'failure',
    make: immediate(() =>
      response({
        subjectPseudonym: null,
        scopes: [scopeRow('marketing', true)],
      }),
    ),
  },
  {
    id: 'P09',
    dependency: 'payload',
    describe: 'active is the string "true"',
    expected: 'failure',
    make: immediate(() =>
      response({
        subjectPseudonym: null,
        scopes: [scopeRow('model_training', true, { active: 'true' })],
      }),
    ),
  },
  {
    id: 'P10',
    dependency: 'payload',
    describe: 'active is 1',
    expected: 'failure',
    make: immediate(() =>
      response({
        subjectPseudonym: null,
        scopes: [scopeRow('model_training', true, { active: 1 })],
      }),
    ),
  },
  {
    id: 'P11',
    dependency: 'payload',
    describe: 'active missing',
    expected: 'failure',
    make: immediate(() =>
      response({
        subjectPseudonym: null,
        scopes: [scopeRow('model_training', true, { active: undefined })],
      }),
    ),
  },
  {
    id: 'P12',
    dependency: 'payload',
    describe: 'lastAction "revoked" (unknown enum)',
    expected: 'failure',
    make: immediate(() =>
      response({
        subjectPseudonym: null,
        scopes: [scopeRow('model_training', true, { lastAction: 'revoked' })],
      }),
    ),
  },
  {
    id: 'P13',
    dependency: 'payload',
    describe: 'lastActionAt is a number',
    expected: 'failure',
    make: immediate(() =>
      response({
        subjectPseudonym: null,
        scopes: [
          scopeRow('model_training', true, { lastActionAt: 1757030400 }),
        ],
      }),
    ),
  },
  {
    id: 'P14',
    dependency: 'payload',
    describe: 'consentVersion is a number',
    expected: 'failure',
    make: immediate(() =>
      response({
        subjectPseudonym: null,
        scopes: [scopeRow('model_training', true, { consentVersion: 1 })],
      }),
    ),
  },
  {
    id: 'P15',
    dependency: 'payload',
    describe: 'subjectPseudonym is a number',
    expected: 'failure',
    make: immediate(active =>
      response(validStatus(active, { subjectPseudonym: 7 })),
    ),
  },
  {
    id: 'P16',
    dependency: 'payload',
    describe: 'subjectPseudonym missing (undefined)',
    expected: 'failure',
    make: immediate(active =>
      response(validStatus(active, { subjectPseudonym: undefined })),
    ),
  },
  {
    id: 'P17',
    dependency: 'payload',
    describe: 'model_training row missing, other scopes present (→ off)',
    expected: 'success',
    active: false,
    make: immediate(() =>
      response({
        subjectPseudonym: null,
        scopes: [
          scopeRow('video_analysis', true),
          scopeRow('evaluation_telemetry', true),
        ],
      }),
    ),
  },
  {
    id: 'P18',
    dependency: 'payload',
    describe:
      'model_training active with null lastAction/lastActionAt/consentVersion',
    expected: 'success',
    active: true,
    make: immediate(() =>
      response({
        subjectPseudonym: null,
        scopes: [
          scopeRow('model_training', true, {
            lastAction: null,
            lastActionAt: null,
            consentVersion: null,
          }),
        ],
      }),
    ),
  },
  {
    id: 'P19',
    dependency: 'payload',
    describe: 'prototype-pollution keys in payload and row',
    expected: 'success',
    active: true,
    make: immediate(() =>
      response(
        JSON.parse(
          '{"subjectPseudonym":null,"__proto__":{"polluted":true},"scopes":[{"scope":"model_training","active":true,"consentVersion":null,"lastAction":null,"lastActionAt":null,"__proto__":{"polluted":true}}]}',
        ),
      ),
    ),
  },
  {
    id: 'P20',
    dependency: 'payload',
    describe: '10 000 scope rows (huge payload)',
    expected: 'success',
    active: true,
    make: immediate(() =>
      response({
        subjectPseudonym: null,
        scopes: [
          ...Array.from({ length: 9_999 }, () =>
            scopeRow('video_analysis', true),
          ),
          scopeRow('model_training', true),
        ],
      }),
    ),
  },
  {
    id: 'P21',
    dependency: 'payload',
    describe: 'one malformed row among 50 valid rows',
    expected: 'failure',
    make: immediate(() =>
      response({
        subjectPseudonym: null,
        scopes: [
          ...Array.from({ length: 49 }, () => scopeRow('video_analysis', true)),
          scopeRow('model_training', true, { active: 'yes' }),
        ],
      }),
    ),
  },
  {
    id: 'P22',
    dependency: 'payload',
    describe: 'scope row is an array',
    expected: 'failure',
    make: immediate(() =>
      response({ subjectPseudonym: null, scopes: [['model_training', true]] }),
    ),
  },
  {
    id: 'P23',
    dependency: 'payload',
    describe: 'scope row is a string',
    expected: 'failure',
    make: immediate(() =>
      response({ subjectPseudonym: null, scopes: ['model_training'] }),
    ),
  },
  {
    id: 'P24',
    dependency: 'payload',
    describe: 'payload is a Date object (non-plain object without scopes)',
    expected: 'failure',
    make: immediate(() => response(new Date(0))),
  },
  {
    id: 'P25',
    dependency: 'payload',
    describe: 'scope key is a symbol-ish string "Symbol(model_training)"',
    expected: 'failure',
    make: immediate(() =>
      response({
        subjectPseudonym: null,
        scopes: [scopeRow('Symbol(model_training)', true)],
      }),
    ),
  },
  {
    id: 'P26',
    dependency: 'payload',
    describe: 'extra unknown fields on payload and row (tolerated)',
    expected: 'success',
    active: true,
    make: immediate(() =>
      response({
        ...validStatus(true, { extra: { deep: [1, 2, 3] } }),
        scopes: [scopeRow('model_training', true, { future: 'field' })],
      }),
    ),
  },
  {
    id: 'P27',
    dependency: 'payload',
    describe: 'valid payload, model_training active:false',
    expected: 'success',
    active: false,
    make: immediate(() => response(validStatus(false))),
  },
  {
    id: 'P28',
    dependency: 'payload',
    describe: 'valid payload, model_training active:true',
    expected: 'success',
    active: true,
    make: immediate(() => response(validStatus(true))),
  },
  // config ───────────────────────────────────────────────────────────────
  {
    id: 'C01',
    dependency: 'config',
    describe: 'getRuntimePublicConfig() throws while building headers',
    expected: 'failure',
    fetchCalls: 0,
    make: () => {
      mockRuntimeConfigThrows = true;
      return () => Promise.resolve(response(validStatus(true)));
    },
  },
];

const FAULT_IDS = new Set(FAULTS.map(f => f.id));
if (FAULT_IDS.size !== FAULTS.length) throw new Error('duplicate fault id');

// ─── Scenario runner ────────────────────────────────────────────────────────

type Op = 'hydrate' | 'grant' | 'withdraw';

interface Row {
  suite: string;
  id: string;
  op?: Op;
  seed?: number;
  outcome: 'HELD' | 'BROKEN' | 'CONTRACT_HANG' | 'KNOWN_FAILING';
  observed: string;
  detail?: unknown;
}

const RESULTS: Row[] = [];

let unauthorizedReports: string[] = [];

function installUnauthorizedRecorder(): void {
  unauthorizedReports = [];
  setApiUnauthorizedListener(s => {
    unauthorizedReports.push(s.bearerToken);
  });
}

async function settle(ms = 60_000): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
  // A few extra microtask turns for promise chains that resolve with no timer.
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function runOp(op: Op, fetchFn: ConsentFetch): Promise<void> {
  const store = useConsentStore.getState();
  return op === 'hydrate'
    ? store.hydrate(fetchFn)
    : store.setModelTrainingConsent(op === 'grant', fetchFn);
}

function countingFetch(fetchFn: ConsentFetch): {
  fetchFn: ConsentFetch;
  calls: { input: string; init?: RequestInit }[];
} {
  const calls: { input: string; init?: RequestInit }[] = [];
  return {
    calls,
    fetchFn: (input, init) => {
      calls.push({ input, init });
      return fetchFn(input, init);
    },
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  resetStore();
  clearApiSession();
  mockRuntimeConfigThrows = false;
  installUnauthorizedRecorder();
});

afterEach(() => {
  setApiUnauthorizedListener(null);
  jest.useRealTimers();
});

afterAll(() => {
  const out = process.env['STRESS_OUT'];
  if (!out) return;
  mkdirSync(dirname(out), { recursive: true });
  const summary = {
    unit: 'mod-consent-store',
    lens: 'failure-injection',
    faultsInCatalogue: FAULTS.length,
    rows: RESULTS.length,
    byOutcome: RESULTS.reduce<Record<string, number>>((acc, row) => {
      acc[row.outcome] = (acc[row.outcome] ?? 0) + 1;
      return acc;
    }, {}),
    results: RESULTS,
  };
  writeFileSync(out, JSON.stringify(summary, null, 2));
});

// ─── 1. Fault catalogue × every operation ───────────────────────────────────

describe('consentStore failure injection — fault catalogue × operation', () => {
  const OPS: Op[] = ['hydrate', 'grant', 'withdraw'];
  const cases = FAULTS.flatMap(fault =>
    OPS.map(op => [fault.id, op, fault] as const),
  );

  it.each(cases)('%s / %s', async (id, op, fault) => {
    establishApiSession(session(ACCOUNT_A));
    // Toggles start from a hydrated 'ready' state with the OPPOSITE value so a
    // kept-optimistic value or a fake success is distinguishable.
    const before =
      op === 'hydrate'
        ? {
            availability: 'loading' as ConsentAvailability,
            modelTrainingActive: false,
          }
        : {
            availability: 'ready' as ConsentAvailability,
            modelTrainingActive: op === 'withdraw',
          };
    useConsentStore.setState({
      ...before,
      lastActionAt: null,
      busy: false,
      error: null,
    });

    const ledgerAfter =
      op === 'hydrate' ? (fault.active ?? true) : op === 'grant';
    const counted = countingFetch(fault.make(ledgerAfter));

    let rejected: unknown = null;
    const inFlight = runOp(op, counted.fetchFn).catch(e => {
      rejected = e ?? new Error('rejected with undefined');
    });
    const during = snapshot();
    await settle();
    // A contract-violating dependency never settles the store promise either;
    // awaiting it would hang the test, so it is only awaited when it can settle.
    if (fault.expected !== 'contract_hang') await inFlight;

    const after = snapshot();
    const detail = {
      fault: fault.describe,
      before,
      during,
      after,
      unauthorizedReports,
    };

    // Universal invariants.
    expect(rejected).toBeNull();
    expect(counted.calls).toHaveLength(fault.fetchCalls ?? 1);
    const init = counted.calls[0]?.init;
    if (init) {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(
        String((init.headers as Record<string, string>)['Authorization']),
      ).toBe('Bearer token-a');
      if (op !== 'hydrate') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body['scope']).toBe('model_training');
        expect(body['device']).toBe(
          `${Platform.OS} ${String(Platform.Version)}`,
        );
      }
    }
    // The request was visibly in progress while pending.
    if (op === 'hydrate') expect(during.availability).toBe('loading');
    else expect(during.busy).toBe(true);
    expect(during.error).toBeNull();

    if (fault.expected === 'contract_hang') {
      // Dependency violates the fetch contract: record, do not fail.
      RESULTS.push({
        suite: 'catalogue',
        id,
        op,
        outcome: 'CONTRACT_HANG',
        observed: `after 60 s: availability=${after.availability} busy=${after.busy} (dependency never settles; unreachable with RN whatwg-fetch)`,
        detail,
      });
      expect(after.availability === 'loading' || after.busy).toBe(true);
      return;
    }

    expect(jest.getTimerCount()).toBe(0);
    expect(after.busy).toBe(false);
    expect(after.availability).not.toBe('loading');

    if (fault.expected === 'success') {
      // The server's answer is the truth: a fixed-`active` fault says what the
      // server reports regardless of the operation that was sent.
      const expectedActive = fault.active ?? ledgerAfter;
      expect(after).toEqual(
        expect.objectContaining({
          availability: 'ready',
          modelTrainingActive: expectedActive,
          error: null,
        }),
      );
    } else {
      expect(typeof after.error).toBe('string');
      expect((after.error ?? '').length).toBeGreaterThan(0);
      if (op === 'hydrate') {
        expect(after.availability).toBe('unavailable');
        expect(after.modelTrainingActive).toBe(false);
      } else {
        // The ledger did not change: the pre-toggle value must be kept and
        // the screen keeps rendering the toggle ('ready').
        expect(after.availability).toBe('ready');
        expect(after.modelTrainingActive).toBe(before.modelTrainingActive);
      }
    }
    // Prototype pollution must never leak out of parsing.
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();

    RESULTS.push({
      suite: 'catalogue',
      id,
      op,
      outcome: 'HELD',
      observed: `${after.availability} active=${after.modelTrainingActive} error=${JSON.stringify(after.error)}`,
      detail,
    });
  });

  it('catalogue holds at least 60 distinct injected faults', () => {
    expect(FAULTS.length).toBeGreaterThanOrEqual(60);
    expect(new Set(FAULTS.map(f => f.dependency)).size).toBeGreaterThanOrEqual(
      6,
    );
  });
});

// ─── 2. Session faults (sign-out / switch / rotation mid-flight) ────────────

describe('consentStore failure injection — session dependency mid-flight', () => {
  type SessionEvent =
    'signOut' | 'switchToB' | 'rotateBearer' | 'switchAndBack';
  const EVENTS: SessionEvent[] = [
    'signOut',
    'switchToB',
    'rotateBearer',
    'switchAndBack',
  ];
  const OUTCOMES = ['success', 'failure'] as const;
  const OPS: Op[] = ['hydrate', 'grant', 'withdraw'];
  const cases = OPS.flatMap(op =>
    EVENTS.flatMap(event =>
      OUTCOMES.map(outcome => [op, event, outcome] as const),
    ),
  );

  it.each(cases)('%s then %s, request %s', async (op, event, outcome) => {
    establishApiSession(session(ACCOUNT_A));
    useConsentStore.setState({
      availability: 'ready',
      modelTrainingActive: op === 'withdraw',
      lastActionAt: null,
      busy: false,
      error: null,
    });
    const fetchFn = delayed(2_000, () => {
      if (outcome === 'failure') throw new TypeError('Network request failed');
      return response(validStatus(op !== 'withdraw'));
    });
    const pending: Promise<void>[] = [];
    const inFlight = runOp(op, fetchFn);
    await settle(1_000);

    // The screen re-hydrates on every session change; B's server answers with
    // the OPPOSITE of what A's response carries so a leak is distinguishable.
    const bStatus = () =>
      Promise.resolve(response(validStatus(op === 'withdraw')));
    switch (event) {
      case 'signOut':
        clearApiSession();
        pending.push(useConsentStore.getState().hydrate(bStatus));
        break;
      case 'switchToB':
        clearApiSession();
        establishApiSession(session(ACCOUNT_B));
        pending.push(useConsentStore.getState().hydrate(bStatus));
        break;
      case 'rotateBearer':
        establishApiSession(session(ACCOUNT_A, 'token-a-rotated'));
        break;
      case 'switchAndBack':
        clearApiSession();
        establishApiSession(session(ACCOUNT_B));
        clearApiSession();
        establishApiSession(session(ACCOUNT_A, 'token-a-2'));
        break;
    }
    await settle();
    await Promise.all([inFlight, ...pending]);
    const after = snapshot();

    expect(after.busy).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
    if (event === 'signOut') {
      expect(after).toEqual(SIGNED_OUT);
    } else if (event === 'switchToB') {
      // Belongs to A: neither A's ledger nor A's error may leak into B's view.
      expect(after.modelTrainingActive).toBe(op === 'withdraw');
      expect(after.error).toBeNull();
      expect(after.availability).toBe('ready');
    } else {
      // Same account (bearer rotation or a round trip): response is applied.
      if (outcome === 'success') {
        expect(after.availability).toBe('ready');
        expect(after.modelTrainingActive).toBe(op !== 'withdraw');
        expect(after.error).toBeNull();
      } else {
        expect(typeof after.error).toBe('string');
        expect(after.availability).toBe(
          op === 'hydrate' ? 'unavailable' : 'ready',
        );
      }
    }
    RESULTS.push({
      suite: 'session',
      id: `${op}/${event}/${outcome}`,
      op,
      outcome: 'HELD',
      observed: JSON.stringify(after),
    });
  });

  it('no session: hydrate → signed_out without a request; toggle → visible error, no request', async () => {
    const counted = countingFetch(() =>
      Promise.resolve(response(validStatus(true))),
    );
    await useConsentStore.getState().hydrate(counted.fetchFn);
    expect(snapshot()).toEqual(SIGNED_OUT);
    await useConsentStore
      .getState()
      .setModelTrainingConsent(true, counted.fetchFn);
    const after = snapshot();
    expect(counted.calls).toHaveLength(0);
    expect(after.availability).toBe('signed_out');
    expect(after.modelTrainingActive).toBe(false);
    expect(after.busy).toBe(false);
    expect(after.error).toMatch(/Sign in/);
    RESULTS.push({
      suite: 'session',
      id: 'no-session',
      outcome: 'HELD',
      observed: JSON.stringify(after),
    });
  });

  it('session established DURING a signed-out hydrate does not resurrect a request', async () => {
    const counted = countingFetch(() =>
      Promise.resolve(response(validStatus(true))),
    );
    const inFlight = useConsentStore.getState().hydrate(counted.fetchFn);
    establishApiSession(session(ACCOUNT_A));
    await inFlight;
    expect(counted.calls).toHaveLength(0);
    expect(snapshot().availability).toBe('signed_out');
    RESULTS.push({
      suite: 'session',
      id: 'signin-during-signed-out-hydrate',
      outcome: 'HELD',
      observed: 'signed_out, 0 requests',
    });
  });

  it('a second toggle while busy is dropped and does not double-send', async () => {
    establishApiSession(session(ACCOUNT_A));
    useConsentStore.setState({ availability: 'ready' });
    const counted = countingFetch(
      delayed(1_000, () => response(validStatus(true))),
    );
    const first = useConsentStore
      .getState()
      .setModelTrainingConsent(true, counted.fetchFn);
    const second = useConsentStore
      .getState()
      .setModelTrainingConsent(false, counted.fetchFn);
    await settle();
    await Promise.all([first, second]);
    expect(counted.calls).toHaveLength(1);
    expect(snapshot()).toEqual(
      expect.objectContaining({
        busy: false,
        availability: 'ready',
        modelTrainingActive: true,
      }),
    );
    RESULTS.push({
      suite: 'session',
      id: 'busy-guard',
      outcome: 'HELD',
      observed: '1 request, final active=true',
    });
  });
});

// ─── 3. Seeded random campaign ──────────────────────────────────────────────

/**
 * Model: the server processes requests in ISSUE order against a per-account
 * ledger and answers with the snapshot taken at processing time; responses
 * land after a per-request latency (so they may land out of order — HTTP/2
 * streams and separate connections do that). Faults are drawn from the
 * catalogue minus contract-violating hangs. Session events are interleaved
 * and — exactly like `ConsentSettingsScreen`'s `useEffect` on the session —
 * every session change (and the initial mount) issues a `hydrate()`.
 */
const STRESS_ITER = Number(process.env['STRESS_ITER'] ?? 200);
const STRESS_SEED = process.env['STRESS_SEED']
  ? Number(process.env['STRESS_SEED'])
  : null;

type StepKind =
  | 'hydrate'
  | 'grant'
  | 'withdraw'
  | 'tick'
  | 'signOut'
  | 'signInA'
  | 'signInB'
  | 'rotate';

interface Landed {
  /** Account the request was issued under. */
  account: string;
  op: Op;
  kind: 'success' | 'failure';
  /** Server snapshot carried by a success response. */
  active: boolean | null;
  /** Issue index (server processing order). */
  index: number;
  /** Landed after a request for the same account that was issued later. */
  reordered: boolean;
  /** Whether the store applied it (same account current at landing time). */
  applied: boolean;
  ev: number;
}

interface CampaignResult {
  seed: number;
  steps: string[];
  final: ReturnType<typeof snapshot>;
  landed: Landed[];
  violations: string[];
  reorderDivergence: boolean;
  staleErrorAfterSuccess: boolean;
}

const CAMPAIGN_FAULTS = FAULTS.filter(
  f => f.expected !== 'contract_hang' && f.id !== 'C01' && f.id !== 'F14',
);
const CAMPAIGN_SUCCESS_FAULTS = CAMPAIGN_FAULTS.filter(
  f => f.expected === 'success',
);

/** Half the draws come from the (smaller) success pool so orderings between
 *  successes and failures are exercised, not just failure after failure. */
function pickFault(rng: () => number): Fault {
  return rng() < 0.5
    ? pick(rng, CAMPAIGN_SUCCESS_FAULTS)
    : pick(rng, CAMPAIGN_FAULTS);
}

async function runCampaign(seed: number): Promise<CampaignResult> {
  const rng = mulberry32(seed);
  resetStore();
  clearApiSession();
  const ledger: Record<string, boolean> = {
    [ACCOUNT_A]: rng() < 0.5,
    [ACCOUNT_B]: rng() < 0.5,
  };
  const steps: string[] = [];
  const landed: Landed[] = [];
  const pending: Promise<void>[] = [];
  const violations: string[] = [];
  let issued = 0;
  let ev = 0;
  /** Last event that replaced the whole store (signed-out reset). */
  let lastResetEv = -1;
  const lastLandedIndexByAccount: Record<string, number> = {};

  const land = (
    account: string,
    op: Op,
    index: number,
    kind: Landed['kind'],
    active: boolean | null,
  ): void => {
    const currentAccount = getApiSession()?.canonicalAppUserId ?? null;
    const applied = currentAccount === account;
    ev += 1;
    // Stale response with NO session current → store resets to signed-out.
    if (!applied && currentAccount === null) lastResetEv = ev;
    landed.push({
      account,
      op,
      kind,
      active,
      index,
      reordered: index < (lastLandedIndexByAccount[account] ?? -1),
      applied,
      ev,
    });
    lastLandedIndexByAccount[account] = Math.max(
      lastLandedIndexByAccount[account] ?? -1,
      index,
    );
  };

  /** Fetch for a request that IS issued (session present, not busy-dropped). */
  const serverFetch = (op: Op, fault: Fault, account: string): ConsentFetch => {
    const index = issued;
    issued += 1;
    // Server processes at issue time: a successful toggle commits, and the
    // response carries the server's truth (a fixed-`active` fault IS the
    // server's truth for that request).
    const success = fault.expected === 'success';
    if (success && op !== 'hydrate') ledger[account] = op === 'grant';
    if (success && fault.active !== undefined) ledger[account] = fault.active;
    const snapshotActive = ledger[account] ?? false;
    const inner = fault.make(snapshotActive);
    const latency = int(rng, 0, 20_000);
    // One landing per request: a fault that keeps running after the abort
    // (e.g. F13) settles a promise the store has already given up on.
    let landedOnce = false;
    const landOnce = (kind: Landed['kind'], active: boolean | null): void => {
      if (landedOnce) return;
      landedOnce = true;
      land(account, op, index, kind, active);
    };
    return (input, init) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          Promise.resolve()
            .then(() => inner(input, init))
            .then(
              r => {
                // The store applies a response only once its BODY has settled
                // (a slow/never body lands later than the headers), so the
                // landing is recorded when `json()` settles, not on resolve.
                const landNow = (): void =>
                  landOnce(
                    success ? 'success' : 'failure',
                    success ? snapshotActive : null,
                  );
                const body =
                  r === null || typeof r !== 'object'
                    ? undefined
                    : (r as { json?: unknown }).json;
                if (typeof body !== 'function') {
                  landNow();
                  resolve(r);
                  return;
                }
                const json = body as () => Promise<unknown>;
                resolve({
                  ...r,
                  json: () => {
                    let settled: Promise<unknown>;
                    try {
                      settled = Promise.resolve(json.call(r));
                    } catch (e) {
                      landNow();
                      throw e;
                    }
                    return settled.then(
                      v => {
                        landNow();
                        return v;
                      },
                      e => {
                        landNow();
                        throw e;
                      },
                    );
                  },
                } as Response);
              },
              e => {
                landOnce('failure', null);
                reject(e);
              },
            );
        }, latency);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          landOnce('failure', null);
          reject(abortError());
        });
      });
  };

  const neverCalled: ConsentFetch = () => {
    violations.push('fetch invoked for a request that must not be issued');
    return Promise.reject(new Error('unexpected fetch'));
  };

  const issue = (kind: Op, fault: Fault): void => {
    steps.push(`${kind}:${fault.id}`);
    const account = getApiSession()?.canonicalAppUserId ?? null;
    const wasBusy = useConsentStore.getState().busy;
    const dropped = kind !== 'hydrate' && wasBusy;
    if (account === null) {
      // No session: the store resets to signed-out without a request.
      ev += 1;
      lastResetEv = ev;
    }
    const fetchFn =
      account === null || dropped
        ? neverCalled
        : serverFetch(kind, fault, account);
    pending.push(
      runOp(kind, fetchFn).catch(e => {
        violations.push(`${kind} rejected: ${String(e)}`);
      }),
    );
  };

  const screenHydrate = (): void => issue('hydrate', pickFault(rng));

  const KINDS: StepKind[] = [
    'hydrate',
    'grant',
    'grant',
    'withdraw',
    'withdraw',
    'tick',
    'tick',
    'tick',
    'signOut',
    'signInA',
    'signInB',
    'rotate',
  ];
  if (rng() < 0.8) establishApiSession(session(ACCOUNT_A));
  screenHydrate(); // screen mount
  const stepCount = int(rng, 2, 8);
  for (let i = 0; i < stepCount; i += 1) {
    const kind = pick(rng, KINDS);
    switch (kind) {
      case 'hydrate':
      case 'grant':
      case 'withdraw':
        issue(kind, pickFault(rng));
        break;
      case 'tick': {
        const ms = int(rng, 0, 16_000);
        steps.push(`tick:${ms}`);
        await jest.advanceTimersByTimeAsync(ms);
        break;
      }
      case 'signOut':
        steps.push('signOut');
        clearApiSession();
        screenHydrate();
        break;
      case 'signInA':
        steps.push('signInA');
        establishApiSession(session(ACCOUNT_A, `token-a-${i}`));
        screenHydrate();
        break;
      case 'signInB':
        steps.push('signInB');
        establishApiSession(session(ACCOUNT_B, `token-b-${i}`));
        screenHydrate();
        break;
      case 'rotate': {
        const current = getApiSession();
        steps.push('rotate');
        if (current) {
          establishApiSession({
            ...current,
            bearerToken: `${current.bearerToken}-r${i}`,
          });
          screenHydrate();
        }
        break;
      }
    }
  }

  await settle();
  await Promise.all(pending);
  const final = snapshot();
  const current = getApiSession();

  if (final.busy) violations.push('busy still true after 60 s');
  if (final.availability === 'loading')
    violations.push('availability still loading after 60 s');
  if (jest.getTimerCount() !== 0)
    violations.push(`timer leak: ${jest.getTimerCount()}`);

  let reorderDivergence = false;
  let staleErrorAfterSuccess = false;

  if (!current) {
    // Signed out at the end: the signed-out constant, optionally with the
    // "Sign in to change this" message from a toggle attempted while signed out.
    const { error, ...rest } = final;
    const { error: _ignored, ...expected } = SIGNED_OUT;
    if (JSON.stringify(rest) !== JSON.stringify(expected)) {
      violations.push(`signed-out end state drifted: ${JSON.stringify(final)}`);
    }
    if (error !== null && !/Sign in/.test(error)) {
      violations.push(`signed-out with a foreign error: ${error}`);
    }
  } else {
    const account = current.canonicalAppUserId;
    const mine = landed.filter(
      l => l.applied && l.account === account && l.ev > lastResetEv,
    );
    const last = mine.at(-1);
    // Events that (re)write modelTrainingActive: any success, or a hydrate failure.
    const lastSetter = mine
      .filter(l => l.kind === 'success' || l.op === 'hydrate')
      .at(-1);
    const expectedActive =
      lastSetter?.kind === 'success' ? lastSetter.active === true : false;

    // No fake success / no lost value: active mirrors the last applied setter.
    if (final.modelTrainingActive !== expectedActive) {
      violations.push(
        `modelTrainingActive=${final.modelTrainingActive} but last applied setter says ${expectedActive}`,
      );
    }
    if (final.modelTrainingActive && final.availability !== 'ready') {
      violations.push(`active while ${final.availability}`);
    }
    // No silent failure: latest applied event a failure ⇒ something visible.
    if (
      last?.kind === 'failure' &&
      final.error === null &&
      final.availability !== 'unavailable'
    ) {
      violations.push('failure landed last but nothing visible');
    }
    if (last?.kind === 'success' && final.availability !== 'ready') {
      violations.push(
        `success landed last but availability=${final.availability}`,
      );
    }
    // Ordering probe: a reordered success landed last and disagrees with the
    // server ledger (counted, not a violation — see the deterministic probe).
    if (
      last?.kind === 'success' &&
      last.reordered &&
      final.modelTrainingActive !== ledger[account]
    ) {
      reorderDivergence = true;
    }
    // Stale error probe: 'ready' after a success, but an error string from a
    // failure ISSUED EARLIER is still displayed (counted; deterministic probe
    // below). An error from a later-issued request that merely landed first is
    // the newer user action and legitimately stays.
    if (
      last?.kind === 'success' &&
      final.availability === 'ready' &&
      final.error !== null &&
      mine.some(l => l.kind === 'failure' && l.index < last.index)
    ) {
      staleErrorAfterSuccess = true;
    }
  }

  return {
    seed,
    steps,
    final,
    landed,
    violations,
    reorderDivergence,
    staleErrorAfterSuccess,
  };
}

describe(`consentStore failure injection — seeded campaign (${STRESS_ITER} iterations)`, () => {
  const seeds =
    STRESS_SEED !== null
      ? [STRESS_SEED]
      : Array.from({ length: STRESS_ITER }, (_, i) => 7_000_000 + i);

  it('holds the store invariants on every seed (replay: STRESS_SEED=<seed>)', async () => {
    const broken: CampaignResult[] = [];
    let reorderDivergences = 0;
    let staleErrors = 0;
    let requests = 0;
    for (const seed of seeds) {
      const result = await runCampaign(seed);
      requests += result.landed.length;
      if (result.reorderDivergence) reorderDivergences += 1;
      if (result.staleErrorAfterSuccess) staleErrors += 1;
      RESULTS.push({
        suite: 'campaign',
        id: `seed-${seed}`,
        seed,
        outcome: result.violations.length ? 'BROKEN' : 'HELD',
        observed: result.violations.length
          ? result.violations.join('; ')
          : `${result.final.availability} active=${result.final.modelTrainingActive} landed=${result.landed.length}${result.reorderDivergence ? ' REORDER_DIVERGENCE' : ''}${result.staleErrorAfterSuccess ? ' STALE_ERROR' : ''}`,
        detail: {
          steps: result.steps,
          final: result.final,
          landed: result.landed,
        },
      });
      if (result.violations.length) broken.push(result);
    }
    RESULTS.push({
      suite: 'campaign',
      id: 'summary',
      outcome: 'HELD',
      observed: `iterations=${seeds.length} requests=${requests} reorderDivergences=${reorderDivergences} staleErrorAfterSuccess=${staleErrors}`,
    });
    expect(
      broken.map(b => ({
        seed: b.seed,
        steps: b.steps,
        violations: b.violations,
      })),
    ).toEqual([]);
  }, 600_000);
});

// ─── 4. Ordering / interleaving probes (deterministic) ──────────────────────

describe('consentStore failure injection — interleaving probes', () => {
  /**
   * P3 (documented, `test.failing`): a hydrate GET that the server answered
   * BEFORE a later grant POST committed, but whose response lands AFTER the
   * POST's, overwrites the fresh ledger value with the stale one — the store
   * has no request generation/sequence guard. Reachable when a hydrate is
   * issued while a toggle is in flight — the store and its promise outlive the
   * screen, so leaving `ConsentSettings` and re-entering it (mount effect →
   * `hydrate()`) within the toggle's 15 s window does exactly that — AND the
   * network delivers the GET after the POST. Flip to `test` once a sequence
   * guard exists.
   */
  test.failing(
    'a stale hydrate response landing after a newer grant response must not win',
    async () => {
      establishApiSession(session(ACCOUNT_A));
      useConsentStore.setState({
        availability: 'ready',
        modelTrainingActive: false,
      });
      // Grant issued first, answered at t=3 s with the committed ledger (true).
      const grant = useConsentStore.getState().setModelTrainingConsent(
        true,
        delayed(3_000, () => response(validStatus(true))),
      );
      // Screen re-entered → mount effect re-hydrates. Server snapshot taken
      // before the grant committed (false) but delivered at t=5 s.
      const hydrate = useConsentStore
        .getState()
        .hydrate(delayed(5_000, () => response(validStatus(false))));
      await settle();
      await Promise.all([grant, hydrate]);
      const after = snapshot();
      RESULTS.push({
        suite: 'probe',
        id: 'reorder-stale-get-wins',
        outcome: after.modelTrainingActive ? 'HELD' : 'KNOWN_FAILING',
        observed: JSON.stringify(after),
      });
      expect(after.modelTrainingActive).toBe(true);
    },
  );

  /**
   * P3 (documented, `test.failing`): a hydrate that FAILS while a grant is in
   * flight (same re-entry path as above) sets `error`; the grant then succeeds
   * and `applyStatus` restores 'ready' + active:true without clearing `error`,
   * so the screen shows the toggle ON next to "Consent settings are
   * temporarily unavailable." with no control that clears it.
   */
  test.failing(
    'a toggle success landing after a hydrate failure must clear the stale error',
    async () => {
      establishApiSession(session(ACCOUNT_A));
      useConsentStore.setState({
        availability: 'ready',
        modelTrainingActive: false,
      });
      const grant = useConsentStore.getState().setModelTrainingConsent(
        true,
        delayed(5_000, () => response(validStatus(true))),
      );
      const hydrate = useConsentStore.getState().hydrate(
        delayed(1_000, () => {
          throw new TypeError('Network request failed');
        }),
      );
      await settle();
      await Promise.all([grant, hydrate]);
      const after = snapshot();
      RESULTS.push({
        suite: 'probe',
        id: 'stale-error-after-success',
        outcome: after.error === null ? 'HELD' : 'KNOWN_FAILING',
        observed: JSON.stringify(after),
      });
      expect(after).toEqual(
        expect.objectContaining({
          availability: 'ready',
          modelTrainingActive: true,
          busy: false,
          error: null,
        }),
      );
    },
  );

  /**
   * P3 (documented, `test.failing`): consentApi does not call
   * `reportApiUnauthorized` on 401, unlike accessApi/data api. An expired
   * bearer therefore shows "temporarily unavailable" with a "Try again" that
   * repeats the same 401 until the session keeper rotates the token.
   */
  test.failing(
    'a 401 is reported to the auth layer like every other API client does',
    async () => {
      establishApiSession(session(ACCOUNT_A));
      await useConsentStore
        .getState()
        .hydrate(() =>
          Promise.resolve(
            response({ error: 'unauthorized' }, { ok: false, status: 401 }),
          ),
        );
      const after = snapshot();
      RESULTS.push({
        suite: 'probe',
        id: '401-not-reported',
        outcome: unauthorizedReports.length ? 'HELD' : 'KNOWN_FAILING',
        observed: `unauthorizedReports=${JSON.stringify(unauthorizedReports)} state=${JSON.stringify(after)}`,
      });
      expect(unauthorizedReports).toEqual(['token-a']);
    },
  );

  it('hydrate failure during an in-flight grant that then FAILS keeps everything visible and not busy', async () => {
    establishApiSession(session(ACCOUNT_A));
    useConsentStore.setState({
      availability: 'ready',
      modelTrainingActive: false,
    });
    const grant = useConsentStore.getState().setModelTrainingConsent(
      true,
      delayed(5_000, () => {
        throw new TypeError('Network request failed');
      }),
    );
    const hydrate = useConsentStore.getState().hydrate(
      delayed(1_000, () => {
        throw new TypeError('Network request failed');
      }),
    );
    await settle();
    await Promise.all([grant, hydrate]);
    const after = snapshot();
    expect(after.busy).toBe(false);
    expect(after.modelTrainingActive).toBe(false);
    expect(after.availability).toBe('unavailable');
    expect(typeof after.error).toBe('string');
    RESULTS.push({
      suite: 'probe',
      id: 'double-failure',
      outcome: 'HELD',
      observed: JSON.stringify(after),
    });
  });

  it('grant failure then hydrate success clears the error and shows the ledger', async () => {
    establishApiSession(session(ACCOUNT_A));
    useConsentStore.setState({
      availability: 'ready',
      modelTrainingActive: false,
    });
    await useConsentStore
      .getState()
      .setModelTrainingConsent(true, () => Promise.reject(new TypeError('x')));
    expect(snapshot().error).not.toBeNull();
    await useConsentStore
      .getState()
      .hydrate(() => Promise.resolve(response(validStatus(false))));
    expect(snapshot()).toEqual(
      expect.objectContaining({
        availability: 'ready',
        modelTrainingActive: false,
        error: null,
        busy: false,
      }),
    );
    RESULTS.push({
      suite: 'probe',
      id: 'fail-then-hydrate-ok',
      outcome: 'HELD',
      observed: JSON.stringify(snapshot()),
    });
  });

  it('20 rapid alternating toggles, each answered by the ledger, converge on the last request', async () => {
    establishApiSession(session(ACCOUNT_A));
    useConsentStore.setState({
      availability: 'ready',
      modelTrainingActive: false,
    });
    let ledger = false;
    for (let i = 0; i < 20; i += 1) {
      const next = i % 2 === 0;
      await useConsentStore.getState().setModelTrainingConsent(next, () => {
        ledger = next;
        return Promise.resolve(response(validStatus(ledger)));
      });
      expect(snapshot()).toEqual(
        expect.objectContaining({
          modelTrainingActive: ledger,
          busy: false,
          error: null,
        }),
      );
    }
    RESULTS.push({
      suite: 'probe',
      id: 'rapid-toggles',
      outcome: 'HELD',
      observed: `final active=${ledger}`,
    });
  });

  it('the store never persists anything (no SQLite/AsyncStorage/Keychain surface)', () => {
    const state = useConsentStore.getState() as unknown as Record<
      string,
      unknown
    >;
    expect(Object.keys(state).sort()).toEqual([
      'availability',
      'busy',
      'error',
      'hydrate',
      'lastActionAt',
      'modelTrainingActive',
      'setModelTrainingConsent',
    ]);
    RESULTS.push({
      suite: 'probe',
      id: 'no-persistence',
      outcome: 'HELD',
      observed: 'in-memory only',
    });
  });
});
