/// <reference types="node" />
/**
 * Executes one generated scenario against `src/data/api.ts` through a
 * scripted `fetch`, judges the settlement against the module's contract and
 * returns a replayable row. The oracle is computed from the SCENARIO (what
 * the server sent), never from the module's own output.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  ApiError,
  api,
  createAnalysisPermitClient,
  createTransport,
  submitAnalysisFeedback,
} from '../../src/data/api';
import { HARNESS_UUID, POLLUTION_MARKER, type Scenario } from './scenarios';

export const STRESS_BASE_URL = 'https://api.stress.test';

export type Violation =
  | 'hung'
  | 'threw_non_api_error'
  | 'wrong_status'
  | 'wrong_code'
  | 'code_not_string'
  | 'message_not_string'
  | 'unbounded_error_text'
  | 'resolved_on_error_status'
  | 'rejected_on_success'
  | 'throw_on_2xx'
  | 'unvalidated_2xx'
  | 'permit_shape_mismatch'
  | 'access_shape_mismatch'
  | 'foreign_keys_leaked'
  | 'path_not_encoded'
  | 'host_changed'
  | 'unexpected_request'
  | 'missing_request'
  | 'unauthorized_report_mismatch'
  | 'network_error_rewrapped'
  | 'proto_polluted'
  | 'prototype_replaced';

export type Settlement = 'resolved' | 'rejected' | 'hung';

export interface Row {
  index: number;
  seed: number;
  surface: Scenario['surface'];
  family: Scenario['family'];
  label: string;
  status: number;
  pathId: string;
  bodyKind: Scenario['body']['kind'];
  bodyBytes: number | null;
  bodyPreview: string | null;
  responseImpl: 'undici.Response' | 'fake' | 'reject';
  oracle: string;
  settlement: Settlement;
  resolvedPreview: string | null;
  error: {
    class: string;
    status: number | null;
    codeType: string;
    codePreview: string | null;
    messageLength: number | null;
    messagePreview: string | null;
  } | null;
  requestUrl: string | null;
  requestPathname: string | null;
  requestCount: number;
  unauthorizedReports: number;
  oversized: Scenario['oversized'];
  notes: string[];
  violations: Violation[];
  durationMs: number;
  replay: string;
}

// ── Scripted fetch ─────────────────────────────────────────────────────────

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
const REASON_PHRASE = /^[\t\x20-\x7e\x80-\xff]*$/;

function bodyBytes(scenario: Scenario): Uint8Array | null {
  switch (scenario.body.kind) {
    case 'text':
      return Buffer.from(scenario.body.text, 'utf8');
    case 'bytes':
      return scenario.body.bytes;
    case 'reject':
      return null;
  }
}

/**
 * Real undici `Response` whenever the constructor accepts the status/reason
 * (that is what React Native's fetch hands the client in production shape);
 * a minimal fake for statuses/reason phrases no constructor allows so the
 * `response.ok` / `statusText` fallbacks are still exercised.
 */
function buildResponse(
  scenario: Scenario,
  bytes: Uint8Array,
): { response: Response; impl: Row['responseImpl'] } {
  const { status, statusText } = scenario;
  const constructible =
    Number.isInteger(status) &&
    status >= 200 &&
    status <= 599 &&
    !(NULL_BODY_STATUSES.has(status) && bytes.byteLength > 0) &&
    REASON_PHRASE.test(statusText) &&
    statusText.length < 1024;
  if (constructible) {
    const body = NULL_BODY_STATUSES.has(status) ? null : Buffer.from(bytes);
    return {
      response: new Response(body, {
        status,
        statusText,
        headers: { 'content-type': 'application/json' },
      }),
      impl: 'undici.Response',
    };
  }
  const decoder = new TextDecoder('utf-8');
  const fake = {
    ok: status >= 200 && status <= 299,
    status,
    statusText,
    headers: new Headers({ 'content-type': 'application/json' }),
    async json(): Promise<unknown> {
      return JSON.parse(decoder.decode(bytes));
    },
    async text(): Promise<string> {
      return decoder.decode(bytes);
    },
  };
  return { response: fake as unknown as Response, impl: 'fake' };
}

export interface ScriptedFetch {
  install(scenario: Scenario): void;
  calls(): Array<{ url: string; init: RequestInit | undefined }>;
  impl(): Row['responseImpl'] | null;
  reset(): void;
  uninstall(): void;
}

export function installScriptedFetch(): ScriptedFetch {
  let current: Scenario | null = null;
  let calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let impl: Row['responseImpl'] | null = null;
  const spy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      calls.push({ url, init });
      if (!current) throw new Error('scripted fetch: no scenario installed');
      if (current.body.kind === 'reject') {
        impl = 'reject';
        throw current.body.error;
      }
      const bytes = bodyBytes(current) ?? new Uint8Array();
      const built = buildResponse(current, bytes);
      impl = built.impl;
      return built.response;
    });
  return {
    install(scenario) {
      current = scenario;
      calls = [];
      impl = null;
    },
    calls: () => calls,
    impl: () => impl,
    reset() {
      calls = [];
      impl = null;
    },
    uninstall() {
      spy.mockRestore();
    },
  };
}

// ── Oracle ─────────────────────────────────────────────────────────────────

interface Oracle {
  /** What the module should do, independent of what it did. */
  kind:
    | 'resolve'
    | 'reject_api_error'
    | 'rethrow_network_error'
    | 'reject_auth_required';
  status: number | null;
  code: string | null;
  codeIsString: boolean;
  message: string | null;
  parsed: unknown;
  parseOk: boolean;
  description: string;
  /** For permit.reserve: the permit/access the caller should receive. */
  permit: Record<string, unknown> | null;
  access: Record<string, unknown> | null;
  /** Whether a 2xx body has the shape the surface's TypeScript type promises. */
  successShapeValid: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeAndParse(scenario: Scenario): { ok: boolean; value: unknown } {
  const bytes = bodyBytes(scenario);
  if (bytes === null) return { ok: false, value: null };
  // WHATWG `Body.json()` = UTF-8 decode (BOM stripped, U+FFFD for invalid
  // sequences) then JSON.parse.
  const decoded = new TextDecoder('utf-8').decode(bytes);
  try {
    return { ok: true, value: JSON.parse(decoded) };
  } catch {
    return { ok: false, value: null };
  }
}

function oraclePermit(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  const accessSource = value['accessSource'];
  const expiresAt = value['expiresAt'];
  if (typeof id !== 'string' || id.trim() === '') return null;
  if (accessSource !== 'free' && accessSource !== 'premium') return null;
  if (typeof expiresAt !== 'string') return null;
  return { id, accessSource, status: value['status'], expiresAt };
}

function oracleAccess(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const ratings = value['freeRatings'];
  if (typeof value['premium'] !== 'boolean') return null;
  if (typeof ratings !== 'object' || ratings === null) return null;
  const table = ratings as Record<string, unknown>;
  const keys = ['limit', 'used', 'reserved', 'remaining', 'availableToReserve'];
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const n = table[key];
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    out[key] = n;
  }
  return { premium: value['premium'], freeRatings: out };
}

function successShapeValid(scenario: Scenario, parsed: unknown): boolean {
  const isStringArray = (v: unknown) =>
    Array.isArray(v) && v.every(item => typeof item === 'string');
  switch (scenario.surface) {
    case 'transport.syncShots':
      return (
        isRecord(parsed) &&
        isStringArray(parsed['acceptedIds']) &&
        Array.isArray(parsed['rejected'])
      );
    case 'transport.uploadEvaluationTrials':
      return (
        isRecord(parsed) &&
        isStringArray(parsed['acceptedTrialIds']) &&
        Array.isArray(parsed['rejected'])
      );
    case 'submitAnalysisFeedback':
      return (
        isRecord(parsed) &&
        isRecord(parsed['feedback']) &&
        typeof parsed['feedback']['reviewEligible'] === 'boolean'
      );
    case 'api.request':
      return parsed !== null && parsed !== undefined;
    case 'permit.reserve':
    case 'transport.createSession':
    case 'transport.finalizeSession':
    case 'permit.release':
      return true;
  }
}

export function computeOracle(scenario: Scenario): Oracle {
  const base: Oracle = {
    kind: 'resolve',
    status: null,
    code: null,
    codeIsString: true,
    message: null,
    parsed: null,
    parseOk: false,
    description: '',
    permit: null,
    access: null,
    successShapeValid: true,
  };
  const permitSurface =
    scenario.surface === 'permit.reserve' ||
    scenario.surface === 'permit.release';
  if (permitSurface && !(scenario.token ?? '').trim()) {
    return {
      ...base,
      kind: 'reject_auth_required',
      status: 401,
      code: 'auth.required',
      description: 'blank token → ApiError 401 auth.required before any fetch',
    };
  }
  if (scenario.body.kind === 'reject') {
    return {
      ...base,
      kind: 'rethrow_network_error',
      description: `fetch rejected (${scenario.body.label}) → same value rethrown`,
    };
  }
  const { ok: parseOk, value: parsed } = decodeAndParse(scenario);
  const okStatus = scenario.status >= 200 && scenario.status <= 299;
  if (!okStatus) {
    const envelope =
      isRecord(parsed) && isRecord(parsed['error']) ? parsed['error'] : null;
    const rawCode = envelope?.['code'];
    const rawMessage = envelope?.['message'];
    const code = rawCode ?? 'unknown';
    const message = rawMessage ?? scenario.statusText;
    return {
      ...base,
      kind: 'reject_api_error',
      status: scenario.status,
      code: typeof code === 'string' ? code : null,
      codeIsString: typeof code === 'string',
      message: typeof message === 'string' ? message : null,
      parsed,
      parseOk,
      description: `status ${scenario.status} → ApiError(${scenario.status}, ${typeof code === 'string' ? JSON.stringify(code.slice(0, 40)) : `<${typeof code}>`})`,
    };
  }
  if (scenario.surface === 'permit.reserve') {
    const permit = oraclePermit(isRecord(parsed) ? parsed['permit'] : null);
    if (permit === null) {
      return {
        ...base,
        kind: 'reject_api_error',
        status: 502,
        code: 'access.permit_invalid',
        parsed,
        parseOk,
        description:
          '2xx with unusable permit → ApiError 502 access.permit_invalid',
      };
    }
    if (permit['status'] !== 'reserved') {
      return {
        ...base,
        kind: 'reject_api_error',
        status: 409,
        code: 'access.permit_not_reserved',
        parsed,
        parseOk,
        description: '2xx with non-reserved permit → ApiError 409',
      };
    }
    return {
      ...base,
      kind: 'resolve',
      parsed,
      parseOk,
      permit,
      access: oracleAccess(isRecord(parsed) ? parsed['access'] : null),
      description: '2xx with valid reserved permit → resolves {permit, access}',
    };
  }
  // Void surfaces (`await request(...)`) never read the 2xx body, so any
  // body — parseable or not — is contract-conformant there.
  const voidSurface =
    scenario.surface === 'transport.createSession' ||
    scenario.surface === 'transport.finalizeSession' ||
    scenario.surface === 'permit.release';
  const shapeValid =
    voidSurface || (parseOk && successShapeValid(scenario, parsed));
  return {
    ...base,
    kind: 'resolve',
    parsed,
    parseOk,
    successShapeValid: shapeValid,
    description: shapeValid
      ? '2xx with contract-shaped body → resolves'
      : '2xx body does not match the surface type → typed rejection expected',
  };
}

// ── Invocation ─────────────────────────────────────────────────────────────

export function expectedPathname(scenario: Scenario): string | null {
  const id = encodeURIComponent(scenario.pathId);
  switch (scenario.surface) {
    case 'transport.finalizeSession':
      return `/v1/sessions/${id}/finalize`;
    case 'permit.release':
      return `/v1/analysis-permits/${id}/finalize`;
    case 'submitAnalysisFeedback':
      return `/v1/analyses/${id}/feedback`;
    case 'permit.reserve':
      return '/v1/analysis-permits';
    case 'transport.syncShots':
      return '/v1/shots:sync';
    case 'transport.createSession':
      return '/v1/sessions';
    case 'transport.uploadEvaluationTrials':
      return '/v1/me/evaluation/trials';
    case 'api.request':
      return '/v1/stress/probe';
  }
}

function invoke(scenario: Scenario): Promise<unknown> {
  const config = { baseUrl: STRESS_BASE_URL, token: scenario.token };
  switch (scenario.surface) {
    case 'transport.syncShots':
      return createTransport(config).syncShots([{ id: HARNESS_UUID }]);
    case 'transport.createSession':
      return createTransport(config).createSession({ id: scenario.pathId });
    case 'transport.finalizeSession':
      return createTransport(config).finalizeSession(scenario.pathId);
    case 'transport.uploadEvaluationTrials': {
      const transport = createTransport(config);
      if (!transport.uploadEvaluationTrials) {
        return Promise.reject(new Error('uploadEvaluationTrials missing'));
      }
      return transport.uploadEvaluationTrials([{ trialId: HARNESS_UUID }]);
    }
    case 'permit.reserve':
      return createAnalysisPermitClient(config).reserve(scenario.pathId);
    case 'permit.release':
      return createAnalysisPermitClient(config).release(
        scenario.pathId,
        'failed',
      );
    case 'submitAnalysisFeedback':
      return submitAnalysisFeedback(config, scenario.pathId, 'accurate', null);
    case 'api.request':
      return api.request(config, 'POST', '/v1/stress/probe', {
        id: scenario.pathId,
      });
  }
}

const HUNG = Symbol('hung');

async function settle(
  promise: Promise<unknown>,
  deadlineMs: number,
): Promise<{ settlement: Settlement; value?: unknown; error?: unknown }> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<typeof HUNG>(resolve => {
    timer = setTimeout(() => resolve(HUNG), deadlineMs);
  });
  try {
    const outcome = await Promise.race([
      promise.then(
        value => ({ settlement: 'resolved' as const, value }),
        (error: unknown) => ({ settlement: 'rejected' as const, error }),
      ),
      deadline,
    ]);
    if (outcome === HUNG) return { settlement: 'hung' };
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function preview(value: unknown, max = 240): string | null {
  if (value === undefined) return null;
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text === undefined) return `<${typeof value}>`;
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch (error) {
    return `<unserialisable ${Object.prototype.toString.call(value)}: ${error instanceof RangeError ? 'RangeError' : String(error)}>`;
  }
}

// ── Prototype-pollution sentinel ───────────────────────────────────────────

const OBJECT_PROTO_KEYS = Object.getOwnPropertyNames(Object.prototype).sort();
const ARRAY_PROTO_KEYS = Object.getOwnPropertyNames(Array.prototype).sort();

function protoPolluted(): boolean {
  const probe: Record<string, unknown> = {};
  if (
    probe['polluted'] !== undefined ||
    probe[POLLUTION_MARKER] !== undefined
  ) {
    return true;
  }
  if ([][0 as number] !== undefined) return true;
  const objectKeys = Object.getOwnPropertyNames(Object.prototype).sort();
  const arrayKeys = Object.getOwnPropertyNames(Array.prototype).sort();
  return (
    objectKeys.join(',') !== OBJECT_PROTO_KEYS.join(',') ||
    arrayKeys.join(',') !== ARRAY_PROTO_KEYS.join(',')
  );
}

/** C0 controls other than TAB/LF/CR, plus DEL. */
function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) {
      return true;
    }
  }
  return false;
}
const UNBOUNDED_TEXT = 65_536;

// ── Judge ──────────────────────────────────────────────────────────────────

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const key of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (
      !deepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      )
    ) {
      return false;
    }
  }
  return true;
}

export interface RunContext {
  fetch: ScriptedFetch;
  unauthorizedReports(): number;
  resetUnauthorizedReports(): void;
  deadlineMs: number;
  replayCommand(seed: number): string;
}

export async function runScenario(
  index: number,
  scenario: Scenario,
  context: RunContext,
): Promise<Row> {
  const oracle = computeOracle(scenario);
  context.fetch.install(scenario);
  context.resetUnauthorizedReports();
  const started = Date.now();
  const outcome = await settle(
    Promise.resolve().then(() => invoke(scenario)),
    context.deadlineMs,
  );
  const durationMs = Date.now() - started;
  const calls = context.fetch.calls();
  const violations = new Set<Violation>();
  const notes: string[] = [];

  // ── Request-side invariants ──────────────────────────────────────────
  const expectsRequest = oracle.kind !== 'reject_auth_required';
  if (expectsRequest && calls.length !== 1) {
    violations.add(
      calls.length === 0 ? 'missing_request' : 'unexpected_request',
    );
  }
  if (!expectsRequest && calls.length !== 0)
    violations.add('unexpected_request');
  const firstCall = calls[0];
  let requestPathname: string | null = null;
  if (firstCall) {
    try {
      const url = new URL(firstCall.url);
      requestPathname = preview(url.pathname, 240);
      if (url.origin !== new URL(STRESS_BASE_URL).origin) {
        violations.add('host_changed');
      }
      const expected = expectedPathname(scenario);
      if (
        expected !== null &&
        (url.pathname !== expected || url.search !== '' || url.hash !== '')
      ) {
        violations.add('path_not_encoded');
        notes.push(
          `url=${preview(firstCall.url, 200)} expectedPath=${preview(expected, 120)}`,
        );
      }
    } catch {
      violations.add('path_not_encoded');
      notes.push(`unparseable url ${preview(firstCall.url, 120)}`);
    }
    const headers = (firstCall.init?.headers ?? {}) as Record<string, string>;
    const hasAuth = typeof headers['authorization'] === 'string';
    if (hasAuth !== Boolean(scenario.token)) {
      notes.push(
        `authorization header present=${hasAuth} token=${preview(scenario.token, 20)}`,
      );
    }
  }

  // ── Unauthorized reporting: exactly when a 401 arrives with a bearer ──
  const expectedReports =
    oracle.kind === 'reject_api_error' &&
    oracle.status === 401 &&
    scenario.status === 401 &&
    scenario.token
      ? 1
      : 0;
  if (context.unauthorizedReports() !== expectedReports) {
    violations.add('unauthorized_report_mismatch');
  }

  // ── Settlement vs oracle ─────────────────────────────────────────────
  let errorSummary: Row['error'] = null;
  let resolvedPreview: string | null = null;
  if (outcome.settlement === 'hung') {
    violations.add('hung');
  } else if (outcome.settlement === 'rejected') {
    const error = outcome.error;
    const isApiError = error instanceof ApiError;
    const code: unknown = isApiError ? error.code : null;
    const message: unknown = error instanceof Error ? error.message : null;
    errorSummary = {
      class:
        error instanceof Error
          ? error.constructor.name
          : `<${error === null ? 'null' : typeof error}>`,
      status: isApiError ? error.status : null,
      codeType: typeof code,
      codePreview: preview(code, 80),
      messageLength: typeof message === 'string' ? message.length : null,
      messagePreview: preview(message, 80),
    };
    switch (oracle.kind) {
      case 'rethrow_network_error':
        if (
          scenario.body.kind === 'reject' &&
          !Object.is(error, scenario.body.error)
        ) {
          violations.add('network_error_rewrapped');
        }
        break;
      case 'resolve':
        if (oracle.successShapeValid) {
          violations.add(isApiError ? 'rejected_on_success' : 'throw_on_2xx');
        } else if (!isApiError) {
          // The type promised a shape; the module neither validated nor
          // rejected with a typed error — the throw is a downstream TypeError.
          violations.add('throw_on_2xx');
        }
        break;
      case 'reject_auth_required':
      case 'reject_api_error':
        if (!isApiError) {
          violations.add('threw_non_api_error');
          break;
        }
        if (error.status !== oracle.status) violations.add('wrong_status');
        if (typeof code !== 'string') {
          violations.add('code_not_string');
        } else if (
          oracle.codeIsString &&
          oracle.code !== null &&
          code !== oracle.code
        ) {
          violations.add('wrong_code');
          notes.push(
            `code ${preview(code, 40)} ≠ oracle ${preview(oracle.code, 40)}`,
          );
        }
        if (typeof message !== 'string') violations.add('message_not_string');
        if (
          typeof message === 'string' &&
          (message.length >= UNBOUNDED_TEXT || hasControlChars(message))
        ) {
          violations.add('unbounded_error_text');
        }
        if (typeof code === 'string' && code.length >= UNBOUNDED_TEXT) {
          violations.add('unbounded_error_text');
        }
        if (
          typeof message === 'string' &&
          oracle.message !== null &&
          message !== oracle.message
        ) {
          notes.push(
            `message ≠ oracle (${preview(message, 40)} vs ${preview(oracle.message, 40)})`,
          );
        }
        if (oracle.message === null && oracle.status === scenario.status) {
          notes.push(
            `message coerced from non-string: ${preview(message, 40)}`,
          );
        }
        break;
    }
  } else {
    const value = outcome.value;
    resolvedPreview = scenario.deepNesting
      ? `<deep nesting ${scenario.label}>`
      : preview(value);
    switch (oracle.kind) {
      case 'rethrow_network_error':
      case 'reject_auth_required':
      case 'reject_api_error':
        violations.add('resolved_on_error_status');
        break;
      case 'resolve':
        if (!oracle.successShapeValid) violations.add('unvalidated_2xx');
        if (scenario.surface === 'permit.reserve') {
          const result = value as { permit?: unknown; access?: unknown };
          const permit = result?.permit;
          if (!deepEqual(permit, oracle.permit)) {
            violations.add('permit_shape_mismatch');
          } else if (isRecord(permit)) {
            const keys = Object.keys(permit).sort().join(',');
            if (keys !== 'accessSource,expiresAt,id,status') {
              violations.add('foreign_keys_leaked');
            }
            if (Object.getPrototypeOf(permit) !== Object.prototype) {
              violations.add('prototype_replaced');
            }
          }
          if (!deepEqual(result?.access ?? null, oracle.access)) {
            violations.add('access_shape_mismatch');
          } else if (isRecord(result?.access)) {
            const ratings = result.access['freeRatings'] as Record<
              string,
              number
            >;
            const odd = Object.entries(ratings).filter(
              ([, n]) =>
                Object.is(n, -0) ||
                n < 0 ||
                !Number.isInteger(n) ||
                n > Number.MAX_SAFE_INTEGER,
            );
            if (odd.length > 0) {
              notes.push(
                `semantically odd freeRatings accepted: ${odd.map(([k, n]) => `${k}=${String(n)}`).join(' ')}`,
              );
            }
          }
          if (isRecord(permit) && typeof permit['id'] === 'string') {
            if (permit['id'].length >= UNBOUNDED_TEXT)
              notes.push('oversized permit.id accepted verbatim');
            if (hasControlChars(permit['id']))
              notes.push('control chars in permit.id accepted verbatim');
            if (permit['id'].normalize('NFC') !== permit['id'])
              notes.push('non-NFC permit.id passed through unnormalised');
          }
        } else if (
          scenario.surface === 'api.request' &&
          !scenario.deepNesting &&
          oracle.successShapeValid &&
          !deepEqual(value, oracle.parsed)
        ) {
          violations.add('unvalidated_2xx');
          notes.push('api.request resolved value ≠ parsed body');
        } else if (
          scenario.surface === 'submitAnalysisFeedback' &&
          oracle.successShapeValid &&
          !deepEqual(value, {
            reviewEligible: (
              oracle.parsed as { feedback: { reviewEligible: boolean } }
            ).feedback.reviewEligible,
          })
        ) {
          violations.add('unvalidated_2xx');
        }
        break;
    }
  }

  if (protoPolluted()) violations.add('proto_polluted');

  const bytes = bodyBytes(scenario);
  return {
    index,
    seed: scenario.seed,
    surface: scenario.surface,
    family: scenario.family,
    label: scenario.label,
    status: scenario.status,
    pathId: preview(scenario.pathId, 80) ?? '',
    bodyKind: scenario.body.kind,
    bodyBytes: bytes ? bytes.byteLength : null,
    bodyPreview:
      scenario.body.kind === 'text'
        ? preview(scenario.body.text, 120)
        : scenario.body.kind === 'bytes'
          ? `<${scenario.body.bytes.byteLength} bytes: ${Buffer.from(scenario.body.bytes.subarray(0, 24)).toString('hex')}…>`
          : `<reject ${scenario.body.label}>`,
    responseImpl: context.fetch.impl() ?? 'reject',
    oracle: oracle.description,
    settlement: outcome.settlement,
    resolvedPreview,
    error: errorSummary,
    requestUrl: firstCall ? preview(firstCall.url, 240) : null,
    requestPathname,
    requestCount: calls.length,
    unauthorizedReports: context.unauthorizedReports(),
    oversized: scenario.oversized,
    notes,
    violations: [...violations].sort(),
    durationMs,
    replay: context.replayCommand(scenario.seed),
  };
}

// ── Known-finding pins ─────────────────────────────────────────────────────

export interface Pin {
  id: string;
  severity: 'P2' | 'P3';
  finding: string;
  matches(row: Row): boolean;
}

const UNVALIDATED_SURFACES = new Set<Row['surface']>([
  'transport.syncShots',
  'transport.uploadEvaluationTrials',
  'submitAnalysisFeedback',
  'api.request',
]);

export const KNOWN_PINS: readonly Pin[] = [
  {
    id: 'K-F5',
    severity: 'P3',
    finding:
      'F5 (existing, serverResponseMatrix.callSites) data/api.ts:114 `return json as T` hands any 2xx body to the caller unvalidated: syncShots/uploadEvaluationTrials/api.request resolve null/{}/"ok"/[]/wrong types; submitAnalysisFeedback (api.ts:271) throws a bare TypeError instead of a typed ApiError.',
    matches: row =>
      UNVALIDATED_SURFACES.has(row.surface) &&
      row.violations.every(
        v => v === 'unvalidated_2xx' || v === 'throw_on_2xx',
      ),
  },
  {
    id: 'K-PATH',
    severity: 'P3',
    finding:
      'data/api.ts:127 `finalizeSession(id)` interpolates the id raw into `/v1/sessions/${id}/finalize` (release() and submitAnalysisFeedback() encodeURIComponent theirs): `/`, `?`, `#`, `..`, `\\`, `%`, CR/LF in the id change the request path/query/fragment; the id is a locally generated UUID (repository.ts:786) so the exposure is a corrupted outbox row, not remote input.',
    matches: row =>
      row.surface === 'transport.finalizeSession' &&
      row.violations.every(v => v === 'path_not_encoded'),
  },
  {
    id: 'K-DOTSEG',
    severity: 'P3',
    finding:
      'data/api.ts:183 release(permitId) and api.ts:265 submitAnalysisFeedback(analysisId) rely on encodeURIComponent, which leaves `.` unescaped: an id of "." or ".." is a dot-segment the URL parser collapses, so the request goes to /v1/analysis-permits/finalize or /v1/finalize instead of a permit resource. permit.id is server-supplied (a 2xx permit {id: ".."} passes parseReservedPermit).',
    matches: row =>
      (row.surface === 'permit.release' ||
        row.surface === 'submitAnalysisFeedback') &&
      /^\.{1,2}$/.test(row.pathId) &&
      row.violations.every(v => v === 'path_not_encoded'),
  },
  {
    id: 'K-NULL2XX',
    severity: 'P3',
    finding:
      'data/api.ts:150-154 reserve(): `request()` resolves `null` for a 2xx whose body is empty/unparsable (`.json().catch(() => null)`), then `response.permit` throws a bare TypeError ("Cannot read properties of null") instead of the typed ApiError 502 access.permit_invalid; runCaptureAnalysis.ts:341-345 then shows the "could not be reached" copy rather than the invalid-permit copy.',
    matches: row =>
      row.surface === 'permit.reserve' &&
      row.error?.class === 'TypeError' &&
      row.violations.every(v => v === 'threw_non_api_error'),
  },
  {
    id: 'K-CODE',
    severity: 'P3',
    finding:
      'data/api.ts:108 `json?.error?.code ?? "unknown"` only defaults null/undefined: a non-string `error.code` (number/object/array/boolean) becomes `ApiError.code` although the field is typed `string`; consumers compare with === so they fail closed today.',
    matches: row => row.violations.every(v => v === 'code_not_string'),
  },
  {
    id: 'K-TEXT',
    severity: 'P3',
    finding:
      'data/api.ts:106-110 copies `error.message` (and statusText) into `ApiError.message` with no length or control-character cap; runCaptureAnalysis.ts:341-345 surfaces `error.message` verbatim as the user-facing `reason`, so a 64 KiB / NUL / ANSI-escape message reaches the UI unchanged.',
    matches: row =>
      row.violations.every(
        v => v === 'unbounded_error_text' || v === 'code_not_string',
      ),
  },
];

export function pinFor(row: Row): Pin | null {
  if (row.violations.length === 0) return null;
  return KNOWN_PINS.find(pin => pin.matches(row)) ?? null;
}

export type Verdict = 'HELD' | `KNOWN:${string}` | 'BROKEN';

export function verdictFor(row: Row): Verdict {
  if (row.violations.length === 0) return 'HELD';
  const pin = pinFor(row);
  return pin ? `KNOWN:${pin.id}` : 'BROKEN';
}

// ── Artefacts ──────────────────────────────────────────────────────────────

export function artifactDir(runId: string): string {
  const dir = path.resolve(
    __dirname,
    '../../artifacts/api-client-stress',
    runId,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJson(dir: string, name: string, value: unknown): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}
