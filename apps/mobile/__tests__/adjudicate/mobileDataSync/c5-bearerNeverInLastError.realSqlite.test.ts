/**
 * C5 — claim under test: the bearer token can end up verbatim in
 * `outbox.last_error`. `recordRowFailure` does store `String(error)`
 * verbatim, so the question is whether any error the REAL transport
 * (`createTransport` → `api.ts request()`) produces carries the bearer.
 * Exercised: network failure (fetch rejects), 401 with an API envelope, 500
 * with a non-JSON body, 403 HTML, and a 20s timeout abort.
 *
 * Passing here means the candidate is NOT reproducible with the shipping
 * transport (the auditor's repro injected a synthetic Error containing the
 * bearer).
 */
import { createRealOpSqliteModule } from '../../../adjudicate/mobile-data-sync/realSqliteOpMock';

const mockSqlite = createRealOpSqliteModule();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockSqlite.open(options),
}));

import {
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { createTransport } from '../../../src/data/api';
import { getDb } from '../../../src/data/db';
import { saveAnalysis } from '../../../src/data/repository';
import { drainOutbox } from '../../../src/data/sync';
import {
  CANONICAL_USER,
  PERMIT_ID,
  outboxRows,
  realAnalysis,
  shotId,
} from '../../../adjudicate/mobile-data-sync/fixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);
const BEARER = 'eyJhbGciOiJIUzI1NiJ9.SECRET-ACCESS-TOKEN.signature';

type FetchBehaviour =
  | 'network_failed'
  | 'unauthorized_envelope'
  | 'server_error_text'
  | 'forbidden_html'
  | 'timeout';

function installFetch(behaviour: { current: FetchBehaviour }): void {
  (globalThis as { fetch: unknown }).fetch = jest.fn(
    async (_url: string, init: { signal: AbortSignal }) => {
      switch (behaviour.current) {
        case 'network_failed':
          throw new TypeError('Network request failed');
        case 'unauthorized_envelope':
          return new Response(
            JSON.stringify({
              error: { code: 'auth.required', message: 'Sign in again.' },
            }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          );
        case 'server_error_text':
          return new Response('upstream connect error', {
            status: 502,
            statusText: 'Bad Gateway',
          });
        case 'forbidden_html':
          return new Response('<html>Forbidden</html>', {
            status: 403,
            statusText: 'Forbidden',
          });
        case 'timeout':
          return new Promise<Response>((_, reject) => {
            init.signal.addEventListener('abort', () =>
              reject(new Error('Aborted')),
            );
          });
      }
    },
  );
}

describe('C5: bearer token never reaches outbox.last_error (real api.ts)', () => {
  const behaviour: { current: FetchBehaviour } = { current: 'network_failed' };
  const transport = createTransport({
    baseUrl: 'https://example.invalid/functions/v1/api',
    token: BEARER,
  });

  beforeAll(async () => {
    setActiveDataOwner(OWNER);
    const db = getDb();
    await saveAnalysis(db, realAnalysis({ id: shotId(0x51) }), PERMIT_ID);
    installFetch(behaviour);
  });

  afterAll(() => {
    getDb().close();
    mockSqlite.reset();
    jest.useRealTimers();
  });

  it.each<FetchBehaviour>([
    'network_failed',
    'unauthorized_envelope',
    'server_error_text',
    'forbidden_html',
  ])('%s: last_error is recorded without the bearer', async kind => {
    behaviour.current = kind;
    await drainOutbox(getDb(), transport);
    const [row] = await outboxRows(getDb(), OWNER);
    expect(row?.last_error).toEqual(expect.any(String));
    expect(row?.last_error).not.toContain(BEARER);
    expect(row?.last_error).not.toMatch(/bearer/i);
  });

  it('timeout: last_error is the typed timeout message without the bearer', async () => {
    jest.useFakeTimers();
    behaviour.current = 'timeout';
    const drain = drainOutbox(getDb(), transport);
    await jest.advanceTimersByTimeAsync(20_001);
    await drain;
    const [row] = await outboxRows(getDb(), OWNER);
    expect(row?.last_error).toContain('took too long');
    expect(row?.last_error).not.toContain(BEARER);
  });
});
