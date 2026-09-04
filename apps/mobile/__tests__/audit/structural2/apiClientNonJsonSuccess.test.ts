/**
 * Structural audit (mobile-data-sync, pass 1) — `api.ts:101-113`.
 *
 * Run: `cd apps/mobile && npx jest
 *       __tests__/audit/structural2/apiClientNonJsonSuccess.test.ts`
 *
 * `request()` swallows a body-parse failure (`.catch(() => null)`) and then
 * returns `json as T`. A 2xx whose body is not JSON (captive-portal splash,
 * CDN/WAF interstitial, empty 200 from a misrouted base URL) therefore
 * resolves the typed promise with `null` and every caller dereferences it.
 */
import {
  ApiError,
  createAnalysisPermitClient,
  createTransport,
} from '../../../src/data/api';
import { drainOutbox } from '../../../src/data/sync';
import type { LocalDb } from '../../../src/data/db';
import { setActiveDataOwner } from '../../../src/data/accountScope';
import {
  AUDIT_OWNER_A,
  AUDIT_PERMIT_ID,
  scoredAnalysis,
} from '../../../test-support/audit/fixtures';

function htmlOk(): Response {
  return new Response(
    '<html><body>Sign in to this Wi-Fi network</body></html>',
    {
      status: 200,
      headers: { 'content-type': 'text/html' },
    },
  );
}

const config = { baseUrl: 'https://api.test', token: 'bearer-token' };

beforeEach(() => {
  (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => htmlOk());
});

afterEach(() => {
  delete (globalThis as { fetch?: unknown }).fetch;
});

describe('2xx response whose body is not JSON', () => {
  it('syncShots must surface a typed ApiError instead of resolving null', async () => {
    const transport = createTransport(config);
    let outcome: { resolved: unknown } | { rejected: string } = {
      resolved: undefined,
    };
    try {
      outcome = { resolved: await transport.syncShots([{ id: 'x' }]) };
    } catch (error) {
      outcome = {
        rejected:
          error instanceof ApiError
            ? `ApiError ${error.status} ${error.code}`
            : String(error),
      };
    }
    expect(outcome).toEqual({
      rejected: expect.stringMatching(/^ApiError/),
    });
  });

  it('reserve must surface a typed ApiError instead of a TypeError from dereferencing null', async () => {
    const client = createAnalysisPermitClient(config);
    let rejected: unknown = null;
    await client.reserve('idem-1').catch(error => {
      rejected = error;
    });
    expect(rejected).toBeInstanceOf(ApiError);
  });

  it('a drain that receives a non-JSON 2xx must record a typed transport error, not a TypeError', async () => {
    setActiveDataOwner(AUDIT_OWNER_A);
    const rows = [
      {
        id: 1,
        owner_key: AUDIT_OWNER_A,
        kind: 'shot.sync',
        payload: JSON.stringify({
          ...scoredAnalysis(),
          analysisPermitId: AUDIT_PERMIT_ID,
        }),
        attempts: 0,
        last_error: null as string | null,
      },
    ];
    const db: LocalDb = {
      async execute(sql, params = []) {
        if (sql.startsWith('SELECT id, kind, payload')) {
          return { rows: rows.map(r => ({ ...r })) };
        }
        if (sql.startsWith('UPDATE outbox')) {
          const row = rows.find(
            r => r.id === Number(params[params.length - 1]),
          );
          if (row) {
            row.last_error = String(params[0]);
            if (sql.includes('attempts + 1')) row.attempts += 1;
          }
        }
        return { rows: [] };
      },
      close() {},
    };
    try {
      await drainOutbox(db, createTransport(config));
    } finally {
      setActiveDataOwner('signed-out');
    }
    expect(rows[0]).toEqual(
      expect.objectContaining({
        attempts: 0,
        last_error: expect.not.stringMatching(/TypeError|null/),
      }),
    );
  });
});
