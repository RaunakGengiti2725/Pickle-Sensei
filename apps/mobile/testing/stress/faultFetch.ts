/**
 * Fault catalog + fetch stub for the account module's one network dependency.
 *
 * `realistic: true` faults are reachable on device through RN's fetch
 * (whatwg-fetch over XMLHttpRequest — honours AbortSignal, resolves only once
 * the full body has arrived) against ANY server behaviour: network throw /
 * reject, hang until the client aborts, slow responses either side of the
 * 15s deadline, every HTTP error status with every body shape, and 2xx
 * bodies of every malformed shape.
 *
 * `realistic: false` faults violate that fetch contract (a fetch that ignores
 * the abort signal, a body stream that stalls AFTER headers, a fetch that
 * resolves a non-Response). They are still injected so the outcome is on
 * record (`KNOWN_LIMIT`), but they are not asserted as product defects.
 */
import { chance, pick, randomInt, type Rng } from './harness';

export type FaultKind =
  | 'ok'
  | 'throw_sync'
  | 'reject_network'
  | 'reject_nonerror'
  | 'hang_until_abort'
  | 'slow_ok'
  | 'slow_reject'
  | 'http_error'
  | 'ok_malformed'
  | 'ok_json_throws'
  | 'ok_json_sync_throw'
  | 'slow_body'
  | 'hang_ignore_abort'
  | 'body_stall'
  | 'resolve_null';

export type ErrorBodyKind =
  | 'json_error_message'
  | 'json_error_no_message'
  | 'json_error_message_not_string'
  | 'json_error_message_empty'
  | 'json_error_message_html'
  | 'json_error_message_huge'
  | 'json_error_not_object'
  | 'json_empty_object'
  | 'json_null'
  | 'json_array'
  | 'non_json'
  | 'empty_body';

export const HTTP_ERROR_STATUSES = [
  400, 401, 402, 403, 404, 405, 408, 409, 410, 413, 415, 422, 425, 429, 500,
  501, 502, 503, 504, 507, 520, 599,
] as const;

export const ERROR_BODY_KINDS: readonly ErrorBodyKind[] = [
  'json_error_message',
  'json_error_no_message',
  'json_error_message_not_string',
  'json_error_message_empty',
  'json_error_message_html',
  'json_error_message_huge',
  'json_error_not_object',
  'json_empty_object',
  'json_null',
  'json_array',
  'non_json',
  'empty_body',
];

export interface Fault {
  kind: FaultKind;
  /** compact replayable id, e.g. `http_error:503:non_json` */
  id: string;
  realistic: boolean;
  status?: number;
  bodyKind?: ErrorBodyKind;
  /** server message carried by `json_error_message*` bodies */
  serverMessage?: string;
  delayMs?: number;
  /** 2xx payload for `ok*` / `slow*` kinds */
  payload?: unknown;
  /** label of the malformed shape (for `ok_malformed`) */
  shape?: string;
}

/** Fault kinds swept in order; `realistic` ones first so small STRESS_ITER
 * runs still cover every device-reachable kind. */
export const FAULT_SWEEP: readonly FaultKind[] = [
  'throw_sync',
  'reject_network',
  'reject_nonerror',
  'hang_until_abort',
  'slow_ok',
  'slow_reject',
  'http_error',
  'http_error',
  'ok_malformed',
  'ok_malformed',
  'ok_json_throws',
  'ok',
  'http_error',
  'hang_ignore_abort',
  'body_stall',
  'slow_body',
  'resolve_null',
  'ok_json_sync_throw',
];

export const REQUEST_DEADLINE_MS = 15_000;

export const SERVER_MESSAGES = [
  'Too many requests.',
  'Deletion request expired. Start again.',
  'The challenge has already been used.',
  'Your session is no longer valid.',
  'Rate limit exceeded',
  'Try again later.',
] as const;

/** Delays that straddle the deadline: well under, just under, on, just over,
 * far over. */
export function drawDelay(rng: Rng): number {
  return pick(rng, [
    randomInt(rng, 1, 14_000),
    REQUEST_DEADLINE_MS - 1,
    REQUEST_DEADLINE_MS,
    REQUEST_DEADLINE_MS + 1,
    randomInt(rng, 15_001, 59_000),
  ]);
}

export interface MalformedShape {
  shape: string;
  payload: unknown;
}

export function drawFault(
  rng: Rng,
  iteration: number,
  validPayload: unknown,
  malformed: (rng: Rng) => MalformedShape,
): Fault {
  const kind = FAULT_SWEEP[iteration % FAULT_SWEEP.length]!;
  switch (kind) {
    case 'ok':
      return { kind, id: 'ok', realistic: true, payload: validPayload };
    case 'throw_sync':
    case 'reject_network':
    case 'reject_nonerror':
    case 'hang_until_abort':
      return { kind, id: kind, realistic: true };
    case 'hang_ignore_abort':
    case 'body_stall':
    case 'resolve_null':
      return { kind, id: kind, realistic: false };
    case 'slow_ok': {
      const delayMs = drawDelay(rng);
      return {
        kind,
        id: `slow_ok:${delayMs}`,
        realistic: true,
        delayMs,
        payload: validPayload,
      };
    }
    case 'slow_reject': {
      const delayMs = drawDelay(rng);
      return { kind, id: `slow_reject:${delayMs}`, realistic: true, delayMs };
    }
    case 'slow_body': {
      const delayMs = drawDelay(rng);
      return {
        kind,
        id: `slow_body:${delayMs}`,
        realistic: false,
        delayMs,
        payload: validPayload,
      };
    }
    case 'http_error': {
      const status = pick(rng, HTTP_ERROR_STATUSES);
      const bodyKind = pick(rng, ERROR_BODY_KINDS);
      const serverMessage = pick(rng, SERVER_MESSAGES);
      return {
        kind,
        id: `http_error:${status}:${bodyKind}`,
        realistic: true,
        status,
        bodyKind,
        serverMessage,
      };
    }
    case 'ok_malformed': {
      const drawn = malformed(rng);
      return {
        kind,
        id: `ok_malformed:${drawn.shape}`,
        realistic: true,
        shape: drawn.shape,
        payload: drawn.payload,
      };
    }
    case 'ok_json_throws':
      return { kind, id: kind, realistic: true };
    case 'ok_json_sync_throw':
      // whatwg-fetch's Body.json() is `this.text().then(JSON.parse)` and
      // text() returns a rejected promise when consumed — it never throws
      // synchronously, so this only models a foreign fetch implementation.
      return { kind, id: kind, realistic: false };
    default: {
      const never: never = kind;
      throw new Error(`unknown fault kind ${String(never)}`);
    }
  }
}

export function errorBody(fault: Fault): {
  json: () => Promise<unknown>;
} {
  const message = fault.serverMessage ?? 'Server message.';
  switch (fault.bodyKind) {
    case 'json_error_message':
      return { json: () => Promise.resolve({ error: { message } }) };
    case 'json_error_no_message':
      return { json: () => Promise.resolve({ error: { code: 'x' } }) };
    case 'json_error_message_not_string':
      return { json: () => Promise.resolve({ error: { message: 42 } }) };
    case 'json_error_message_empty':
      return { json: () => Promise.resolve({ error: { message: '' } }) };
    case 'json_error_message_html':
      return {
        json: () =>
          Promise.resolve({
            error: { message: '<b>Gateway</b> <script>x</script> error' },
          }),
      };
    case 'json_error_message_huge':
      return {
        json: () => Promise.resolve({ error: { message: 'x'.repeat(20_000) } }),
      };
    case 'json_error_not_object':
      return { json: () => Promise.resolve({ error: 'nope' }) };
    case 'json_empty_object':
      return { json: () => Promise.resolve({}) };
    case 'json_null':
      return { json: () => Promise.resolve(null) };
    case 'json_array':
      return { json: () => Promise.resolve([]) };
    case 'non_json':
      return {
        json: () =>
          Promise.reject(new SyntaxError('Unexpected token < in JSON')),
      };
    case 'empty_body':
    default:
      return {
        json: () => Promise.reject(new SyntaxError('Unexpected end of JSON')),
      };
  }
}

/** Minimal Response stand-in (undici's Response.json() schedules on
 * process.nextTick, which fake timers intercept). */
export function fakeResponse(
  status: number,
  json: () => Promise<unknown>,
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json,
  } as unknown as Response;
}

export interface FetchCall {
  url: string;
  init: RequestInit | undefined;
  /** true once the caller aborted the signal it passed */
  aborted: boolean;
  hadSignal: boolean;
}

export interface FaultFetch {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  calls: FetchCall[];
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/**
 * A fetch stub that applies `faults[i]` to the i-th call (the last fault
 * repeats). Delays are driven by (fake) timers; `hang_until_abort` settles
 * only through the caller's AbortSignal, exactly like whatwg-fetch.
 */
export function faultFetch(faults: readonly Fault[]): FaultFetch {
  const calls: FetchCall[] = [];
  const fetch = (input: string, init?: RequestInit): Promise<Response> => {
    const fault = faults[Math.min(calls.length, faults.length - 1)]!;
    const signal = init?.signal ?? null;
    const call: FetchCall = {
      url: String(input),
      init,
      aborted: false,
      hadSignal: signal !== null,
    };
    calls.push(call);
    signal?.addEventListener('abort', () => {
      call.aborted = true;
    });

    const okResponse = () =>
      fakeResponse(200, () => Promise.resolve(fault.payload));

    switch (fault.kind) {
      case 'throw_sync':
        throw new TypeError('Network request failed');
      case 'reject_network':
        return Promise.reject(new TypeError('Network request failed'));
      case 'reject_nonerror':
        return Promise.reject('socket hang up');
      case 'hang_until_abort':
        return new Promise<Response>((_resolve, reject) => {
          if (!signal) return;
          if (signal.aborted) reject(abortError());
          signal.addEventListener('abort', () => reject(abortError()));
        });
      case 'hang_ignore_abort':
        return new Promise<Response>(() => {});
      case 'resolve_null':
        return Promise.resolve(null as unknown as Response);
      case 'ok':
        return Promise.resolve(okResponse());
      case 'slow_ok':
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(okResponse()), fault.delayMs);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(abortError());
          });
        });
      case 'slow_reject':
        return new Promise<Response>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new TypeError('Network request failed')),
            fault.delayMs,
          );
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(abortError());
          });
        });
      case 'slow_body':
        return Promise.resolve(
          fakeResponse(
            200,
            () =>
              new Promise(resolve =>
                setTimeout(() => resolve(fault.payload), fault.delayMs),
              ),
          ),
        );
      case 'body_stall':
        return Promise.resolve(fakeResponse(200, () => new Promise(() => {})));
      case 'http_error':
        return Promise.resolve(
          fakeResponse(fault.status ?? 500, errorBody(fault).json),
        );
      case 'ok_malformed':
        return Promise.resolve(okResponse());
      case 'ok_json_throws':
        return Promise.resolve(
          fakeResponse(200, () =>
            Promise.reject(new SyntaxError('Unexpected token < in JSON')),
          ),
        );
      case 'ok_json_sync_throw':
        return Promise.resolve(
          fakeResponse(200, () => {
            throw new TypeError('body already consumed');
          }),
        );
      default: {
        const never: never = fault.kind;
        throw new Error(`unknown fault kind ${String(never)}`);
      }
    }
  };
  return { fetch, calls };
}

/** Whether a realistic fault is expected to be reported by the module as a
 * transport failure (network/abort path) vs. a status/payload failure. */
export function transportFailureExpected(fault: Fault): boolean {
  switch (fault.kind) {
    case 'throw_sync':
    case 'reject_network':
    case 'reject_nonerror':
    case 'hang_until_abort':
    case 'slow_reject':
      return true;
    case 'slow_ok':
      return (fault.delayMs ?? 0) >= REQUEST_DEADLINE_MS;
    default:
      return false;
  }
}

/** Whether the server message is expected to surface (deletion/onboarding
 * only surface `error.message` when it is a string — including empty). */
export function serverMessageSurfaces(fault: Fault): boolean {
  return (
    fault.kind === 'http_error' &&
    (fault.bodyKind === 'json_error_message' ||
      fault.bodyKind === 'json_error_message_empty' ||
      fault.bodyKind === 'json_error_message_html' ||
      fault.bodyKind === 'json_error_message_huge')
  );
}

export function expectedServerMessage(fault: Fault): string | null {
  if (!serverMessageSurfaces(fault)) return null;
  switch (fault.bodyKind) {
    case 'json_error_message':
      return fault.serverMessage ?? 'Server message.';
    case 'json_error_message_empty':
      return '';
    case 'json_error_message_html':
      return '<b>Gateway</b> <script>x</script> error';
    case 'json_error_message_huge':
      return 'x'.repeat(20_000);
    default:
      return null;
  }
}

/** Convenience: a fault that succeeds. */
export function okFault(payload: unknown): Fault {
  return { kind: 'ok', id: 'ok', realistic: true, payload };
}

export function maybe<T>(rng: Rng, probability: number, value: T): T | null {
  return chance(rng, probability) ? value : null;
}
