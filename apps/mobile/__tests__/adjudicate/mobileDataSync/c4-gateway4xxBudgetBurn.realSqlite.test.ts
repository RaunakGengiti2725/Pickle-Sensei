/**
 * C4 — `isPermanentSyncFailure()` treats EVERY whole-request 4xx other than
 * 401/408/429 as a contract verdict. A 404/403 that does not come from the
 * API at all (Supabase gateway "Requested function was not found" during a
 * function redeploy/rollback — body `{code, message}` with no `error`
 * envelope; a CDN/WAF 403 HTML page) therefore burns one attempt on EVERY
 * queued row per drain. Foreground `AppState` triggers are not backed off,
 * so eight app switches during the outage exhaust the budget and the
 * ratings are excluded from every future drain — including after the
 * gateway is healthy again.
 *
 * Driven through the real `createTransport()` + `api.ts request()` with a
 * fetch double, over real SQLite. Expected (fails on the baseline): a shot
 * queued during the gateway outage still reaches the server once it recovers.
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
import {
  getShotOutboxStatus,
  hasShotSyncReceipt,
  saveAnalysis,
} from '../../../src/data/repository';
import { OUTBOX_MAX_ATTEMPTS, drainOutbox } from '../../../src/data/sync';
import {
  CANONICAL_USER,
  PERMIT_ID,
  realAnalysis,
  shotId,
} from '../../../adjudicate/mobile-data-sync/fixtures';

const OWNER = canonicalDataOwner(CANONICAL_USER);

type Gateway =
  | { kind: 'function_not_found' }
  | { kind: 'waf_forbidden' }
  | { kind: 'healthy' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetch(gateway: { current: Gateway }): { posts: number } {
  const state = { posts: 0 };
  (globalThis as { fetch: unknown }).fetch = jest.fn(
    async (_url: string, init: { body?: string }) => {
      switch (gateway.current.kind) {
        case 'function_not_found':
          // Supabase functions gateway when no function is deployed under
          // the slug (no `error` envelope, so api.ts maps to code 'unknown').
          return jsonResponse(404, {
            code: 404,
            message: 'Requested function was not found',
          });
        case 'waf_forbidden':
          return new Response('<html><body>Forbidden</body></html>', {
            status: 403,
            statusText: 'Forbidden',
            headers: { 'content-type': 'text/html' },
          });
        case 'healthy': {
          state.posts += 1;
          const body = JSON.parse(String(init.body)) as {
            shots: Array<{ id: string }>;
          };
          return jsonResponse(200, {
            acceptedIds: body.shots.map(s => s.id),
            rejected: [],
          });
        }
      }
    },
  );
  return state;
}

describe.each<Gateway['kind']>(['function_not_found', 'waf_forbidden'])(
  'C4: whole-request %s burns the outbox budget (real SQLite + real api.ts)',
  outage => {
    const gateway: { current: Gateway } = { current: { kind: outage } };
    const transport = createTransport({
      baseUrl: 'https://example.invalid/functions/v1/api',
      token: 'test-access-token',
    });
    const id = shotId(outage === 'function_not_found' ? 0x41 : 0x42);

    beforeAll(async () => {
      setActiveDataOwner(OWNER);
      const db = getDb();
      await db.execute('DELETE FROM outbox');
      await db.execute('DELETE FROM sync_receipt');
      await saveAnalysis(db, realAnalysis({ id }), PERMIT_ID);
    });

    afterAll(() => {
      getDb().close();
      mockSqlite.reset();
    });

    it('a rating queued during the outage syncs once the gateway recovers', async () => {
      const db = getDb();
      const fetchState = installFetch(gateway);
      // Eight foreground events while the gateway is broken.
      for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) {
        await drainOutbox(db, transport);
      }
      const during = await getShotOutboxStatus(db, id);

      gateway.current = { kind: 'healthy' };
      await drainOutbox(db, transport);

      expect({
        outage: during,
        postsAfterRecovery: fetchState.posts,
        receipt: await hasShotSyncReceipt(db, id),
      }).toEqual({
        outage: expect.objectContaining({
          state: expect.not.stringMatching(/exhausted/),
        }),
        postsAfterRecovery: 1,
        receipt: true,
      });
    });
  },
);
