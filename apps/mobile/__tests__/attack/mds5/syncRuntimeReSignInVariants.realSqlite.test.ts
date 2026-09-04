/**
 * MDS-5 attack variants — drive the real `syncRuntime` + `api.ts` + real
 * SQLite through every sign-out / re-sign-in ordering the C7 repro did not
 * cover, and assert the invariant the fix claims: at most one drain is ever in
 * flight, every queued shot is POSTed once per network outcome and receipted
 * once, and a stale generation can never act for a newer one.
 *
 * Requires `NODE_OPTIONS=--experimental-sqlite` (node:sqlite).
 */
import { AppState } from 'react-native';

import { createRealOpSqliteModule } from '../../../adjudicate/mobile-data-sync/realSqliteOpMock';

const mockSqlite = createRealOpSqliteModule();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockSqlite.open(options),
}));

import {
  clearApiSession,
  establishApiSession,
  setApiUnauthorizedListener,
  type ApiSession,
} from '../../../src/account/apiSession';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { API_REQUEST_TIMEOUT_MS } from '../../../src/data/api';
import { getDb } from '../../../src/data/db';
import {
  hasShotSyncReceipt,
  saveAnalysis,
  saveSession,
} from '../../../src/data/repository';
import { SYNC_RETRY_MAX_MS } from '../../../src/data/syncRuntime';
import {
  clearSyncRuntime,
  configureSyncRuntime,
  triggerOutboxSync,
} from '../../../src/data/syncRuntime';
import {
  CANONICAL_USER,
  PERMIT_ID,
  outboxRows,
  realAnalysis,
  shotId,
} from '../../../adjudicate/mobile-data-sync/fixtures';

const SECOND_USER = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const OWNER = canonicalDataOwner(CANONICAL_USER);
const OWNER_B = canonicalDataOwner(SECOND_USER);

function session(bearerToken: string, user = CANONICAL_USER): ApiSession {
  return {
    apiBaseUrl: 'https://example.invalid/functions/v1/api',
    bearerToken,
    canonicalAppUserId: user,
    provider: 'apple',
  };
}

interface Recorded {
  path: string;
  bearer: string;
  shotIds: string[];
  /** Resolves the request 200 with every shot accepted. */
  accept: () => void;
  /** Resolves the request with a bare 401 (expired / unknown bearer). */
  unauthorized: () => void;
  settled: boolean;
}

/** Fetch double: every request parks until the test releases it. Honours the
 * AbortSignal so `API_REQUEST_TIMEOUT_MS` produces the real 408 path. */
function installFetch(): Recorded[] {
  const recorded: Recorded[] = [];
  (globalThis as { fetch: unknown }).fetch = jest.fn(
    (
      url: string,
      init: {
        body?: string;
        headers: Record<string, string>;
        signal?: AbortSignal;
      },
    ) =>
      new Promise<Response>((resolve, reject) => {
        const path = url.replace(/^https:\/\/[^/]+\/functions\/v1\/api/, '');
        const body = init.body
          ? (JSON.parse(init.body) as { shots?: Array<{ id: string }> })
          : {};
        const shotIds = (body.shots ?? []).map(s => s.id);
        const entry: Recorded = {
          path,
          bearer: init.headers['authorization'] ?? '<none>',
          shotIds,
          settled: false,
          accept: () => {
            entry.settled = true;
            resolve(
              new Response(
                JSON.stringify(
                  path === '/v1/shots:sync'
                    ? { acceptedIds: shotIds, rejected: [] }
                    : { ok: true },
                ),
                {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                },
              ),
            );
          },
          unauthorized: () => {
            entry.settled = true;
            resolve(
              new Response(
                JSON.stringify({
                  error: { code: 'auth.required', message: 'expired' },
                }),
                {
                  status: 401,
                  headers: { 'content-type': 'application/json' },
                },
              ),
            );
          },
        };
        init.signal?.addEventListener('abort', () => {
          entry.settled = true;
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          reject(error);
        });
        recorded.push(entry);
      }),
  );
  return recorded;
}

/** Drain the microtask queue (SQLite stand-in yields one tick per statement). */
async function flush(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

async function settle(): Promise<void> {
  await flush();
  await jest.advanceTimersByTimeAsync(0);
  await flush();
}

function summary(recorded: Recorded[]) {
  return recorded.map(r => ({
    path: r.path,
    bearer: r.bearer,
    shotIds: r.shotIds,
  }));
}

function shotPosts(recorded: Recorded[]) {
  return summary(recorded.filter(r => r.path === '/v1/shots:sync'));
}

function selectCount(): number {
  const live = mockSqlite.opened[mockSqlite.opened.length - 1]!;
  return live.log.filter(sql => sql.startsWith('SELECT id, kind, payload'))
    .length;
}

describe('MDS-5 attack: sign-out / re-sign-in orderings around an in-flight drain', () => {
  let recorded: Recorded[];
  let appStateListeners: Array<(state: string) => void>;
  const unauthorized = jest.fn();

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    appStateListeners = [];
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_type, handler) => {
        const listener = handler as (state: string) => void;
        appStateListeners.push(listener);
        return {
          remove: () => {
            appStateListeners = appStateListeners.filter(l => l !== listener);
          },
        } as ReturnType<typeof AppState.addEventListener>;
      });
    recorded = installFetch();
    unauthorized.mockReset();
    setApiUnauthorizedListener(unauthorized);
    setActiveDataOwner(OWNER);
    establishApiSession(session('bearer-one'));
  });

  afterEach(async () => {
    // Release anything still parked so the global in-flight slot never leaks
    // into the next case, then tear the runtime and the database down.
    for (const r of recorded) if (!r.settled) r.accept();
    await settle();
    await jest.advanceTimersByTimeAsync(SYNC_RETRY_MAX_MS * 2);
    clearSyncRuntime();
    clearApiSession();
    setApiUnauthorizedListener(null);
    getDb().close();
    mockSqlite.reset();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  async function queueShots(ids: string[]): Promise<void> {
    const db = getDb();
    for (const id of ids) {
      await saveAnalysis(db, realAnalysis({ id }), PERMIT_ID);
    }
  }

  function resignIn(bearer: string): void {
    clearSyncRuntime();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    setActiveDataOwner(OWNER);
    establishApiSession(session(bearer));
    configureSyncRuntime(session(bearer));
  }

  it('V1: three generations for the same owner while the first drain is parked → one POST, receipts once, and a later rating drains once under the newest bearer', async () => {
    const IDS = [shotId(0xa1), shotId(0xa2)];
    await queueShots(IDS);
    const db = getDb();

    configureSyncRuntime(session('bearer-one'));
    await settle();
    expect(shotPosts(recorded)).toEqual([
      { path: '/v1/shots:sync', bearer: 'Bearer bearer-one', shotIds: IDS },
    ]);

    resignIn('bearer-two');
    await settle();
    resignIn('bearer-three');
    await settle();
    // Triggers and foreground events from the newest generation coalesce.
    triggerOutboxSync();
    for (const l of appStateListeners) l('active');
    triggerOutboxSync();
    await settle();
    expect(shotPosts(recorded)).toHaveLength(1);

    recorded[0]!.accept();
    await settle();

    expect(shotPosts(recorded)).toHaveLength(1);
    expect(await outboxRows(db, OWNER)).toEqual([]);
    expect(
      await Promise.all(IDS.map(id => hasShotSyncReceipt(db, id))),
    ).toEqual([true, true]);

    // Exactly one follow-up drain ran (the coalesced newest-generation pass).
    const selectsAfterRelease = selectCount();
    expect(selectsAfterRelease).toBe(2);

    // A rating saved now belongs to generation three and drains once.
    const LATE = shotId(0xa3);
    await queueShots([LATE]);
    triggerOutboxSync();
    await settle();
    expect(shotPosts(recorded).slice(1)).toEqual([
      {
        path: '/v1/shots:sync',
        bearer: 'Bearer bearer-three',
        shotIds: [LATE],
      },
    ]);
    recorded[recorded.length - 1]!.accept();
    await settle();
    expect(await hasShotSyncReceipt(db, LATE)).toBe(true);
    expect(await outboxRows(db, OWNER)).toEqual([]);
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it('V2: stale request times out (408) after re-sign-in → the fresh generation re-POSTs the same rows exactly once, sequentially, under the new bearer', async () => {
    const IDS = [shotId(0xb1)];
    await queueShots(IDS);
    const db = getDb();

    configureSyncRuntime(session('bearer-one'));
    await settle();
    expect(shotPosts(recorded)).toHaveLength(1);

    resignIn('bearer-two');
    await settle();
    expect(shotPosts(recorded)).toHaveLength(1);

    // Nothing is released: the 20 s request timeout aborts the stale POST.
    await jest.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS);
    await settle();

    expect(recorded[0]!.settled).toBe(true);
    expect(shotPosts(recorded)).toEqual([
      { path: '/v1/shots:sync', bearer: 'Bearer bearer-one', shotIds: IDS },
      { path: '/v1/shots:sync', bearer: 'Bearer bearer-two', shotIds: IDS },
    ]);
    // Transient: no attempt burned, row still queued, no receipt yet.
    const rowsWhileRetrying = await outboxRows(db, OWNER);
    expect(rowsWhileRetrying).toHaveLength(1);
    expect(rowsWhileRetrying[0]!.attempts).toBe(0);
    expect(rowsWhileRetrying[0]!.last_error).toContain('took too long');
    expect(await hasShotSyncReceipt(db, IDS[0]!)).toBe(false);

    recorded[1]!.accept();
    await settle();
    expect(shotPosts(recorded)).toHaveLength(2);
    expect(await outboxRows(db, OWNER)).toEqual([]);
    expect(await hasShotSyncReceipt(db, IDS[0]!)).toBe(true);
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it('V3: the stale bearer is rejected (401) after re-sign-in → the new session is NOT torn down and the fresh generation uploads once under the new bearer', async () => {
    const IDS = [shotId(0xc1), shotId(0xc2), shotId(0xc3)];
    await queueShots(IDS);
    const db = getDb();

    configureSyncRuntime(session('bearer-one'));
    await settle();
    resignIn('bearer-two');
    await settle();
    expect(shotPosts(recorded)).toHaveLength(1);

    recorded[0]!.unauthorized();
    await settle();

    // 401 on the old bearer must not sign the new session out.
    expect(unauthorized).not.toHaveBeenCalled();
    expect(shotPosts(recorded)).toEqual([
      { path: '/v1/shots:sync', bearer: 'Bearer bearer-one', shotIds: IDS },
      { path: '/v1/shots:sync', bearer: 'Bearer bearer-two', shotIds: IDS },
    ]);
    recorded[1]!.accept();
    await settle();
    expect(await outboxRows(db, OWNER)).toEqual([]);
    expect(
      await Promise.all(IDS.map(id => hasShotSyncReceipt(db, id))),
    ).toEqual([true, true, true]);
  });

  it('V4: re-sign-in landing in the exact tick the stale response is released → receipts once, no second POST of the same rows', async () => {
    const IDS = [shotId(0xd1), shotId(0xd2)];
    await queueShots(IDS);
    const db = getDb();

    configureSyncRuntime(session('bearer-one'));
    await settle();
    expect(shotPosts(recorded)).toHaveLength(1);

    // Release and re-sign-in in the same synchronous window: the stale drain
    // resumes its receipt transaction while generation two's first trigger
    // runs.
    recorded[0]!.accept();
    resignIn('bearer-two');
    await settle();

    expect(shotPosts(recorded)).toHaveLength(1);
    expect(await outboxRows(db, OWNER)).toEqual([]);
    expect(
      await Promise.all(IDS.map(id => hasShotSyncReceipt(db, id))),
    ).toEqual([true, true]);
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it('V5: sign out with NO re-sign-in while a drain is parked → the stale drain finishes, nothing else fires for 10 minutes, and a later sign-in drains immediately', async () => {
    const IDS = [shotId(0xe1)];
    await queueShots(IDS);
    const db = getDb();

    configureSyncRuntime(session('bearer-one'));
    await settle();
    expect(shotPosts(recorded)).toHaveLength(1);

    clearSyncRuntime();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    // Signed-out foreground events and triggers are inert.
    for (const l of appStateListeners) l('active');
    triggerOutboxSync();
    await settle();

    recorded[0]!.accept();
    await settle();
    await jest.advanceTimersByTimeAsync(SYNC_RETRY_MAX_MS * 2);
    expect(recorded).toHaveLength(1);
    expect(appStateListeners).toHaveLength(0);

    // Receipt is keyed by the owner the drain started for.
    setActiveDataOwner(OWNER);
    expect(await outboxRows(db, OWNER)).toEqual([]);
    expect(await hasShotSyncReceipt(db, IDS[0]!)).toBe(true);

    // The in-flight slot was released: signing back in drains at once.
    establishApiSession(session('bearer-two'));
    const LATE = shotId(0xe2);
    await queueShots([LATE]);
    configureSyncRuntime(session('bearer-two'));
    await settle();
    expect(shotPosts(recorded).slice(1)).toEqual([
      { path: '/v1/shots:sync', bearer: 'Bearer bearer-two', shotIds: [LATE] },
    ]);
  });

  it('V6: switch to a DIFFERENT account mid-drain (session.create parked) → the stale owner never borrows the new bearer, its rows stay queued attempt-free, and the new owner drains once', async () => {
    const db = getDb();
    await saveSession(db, {
      id: 'ffffffff-0000-4000-8000-000000000001',
      mode: 'practice',
      shotType: 'forehand_drive',
      focusCheckpoint: null,
      startedAt: '2026-08-26T18:00:00.000Z',
    });
    const A_IDS = [shotId(0xf1)];
    await queueShots(A_IDS);

    configureSyncRuntime(session('bearer-one'));
    await settle();
    expect(summary(recorded)).toEqual([
      { path: '/v1/sessions', bearer: 'Bearer bearer-one', shotIds: [] },
    ]);

    // Account B signs in while A's session.create is parked.
    clearSyncRuntime();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    setActiveDataOwner(OWNER_B);
    establishApiSession(session('bearer-B', SECOND_USER));
    configureSyncRuntime(session('bearer-B', SECOND_USER));
    const B_IDS = [shotId(0xf2)];
    await queueShots(B_IDS);
    triggerOutboxSync();
    await settle();
    // B waits behind A's in-flight drain.
    expect(recorded).toHaveLength(1);

    recorded[0]!.accept();
    await settle();

    // A's drain continues with A's shot: its bearer resolves to nothing (A's
    // session is gone) so the request carries NO authorization — never B's.
    expect(summary(recorded).slice(1)).toEqual([
      { path: '/v1/shots:sync', bearer: '<none>', shotIds: A_IDS },
    ]);
    // B still waits behind the stale drain.
    recorded[1]!.unauthorized();
    await settle();

    // Now B's shots go out once under B's bearer.
    expect(summary(recorded).slice(2)).toEqual([
      { path: '/v1/shots:sync', bearer: 'Bearer bearer-B', shotIds: B_IDS },
    ]);
    recorded[2]!.accept();
    await settle();
    await jest.advanceTimersByTimeAsync(SYNC_RETRY_MAX_MS * 2);
    // The bearer-less 401 belonged to nobody: B's session stays up and no
    // request ever carried A's shot under B's bearer.
    for (const p of shotPosts(recorded)) {
      if (p.shotIds.some(id => A_IDS.includes(id))) {
        expect(p.bearer).not.toBe('Bearer bearer-B');
      }
    }
    expect(
      shotPosts(recorded).filter(p => p.bearer === 'Bearer bearer-B'),
    ).toEqual([
      { path: '/v1/shots:sync', bearer: 'Bearer bearer-B', shotIds: B_IDS },
    ]);

    expect(await outboxRows(db, OWNER_B)).toEqual([]);
    expect(await hasShotSyncReceipt(db, B_IDS[0]!)).toBe(true);
    // A's shot row stays queued for A's next sign-in with no attempt burned
    // (the bearer-less request is a transient 401 or was never sent).
    const aRows = await outboxRows(db, OWNER);
    expect(aRows.map(r => r.kind)).toEqual(['shot.sync']);
    expect(aRows[0]!.attempts).toBe(0);
    setActiveDataOwner(OWNER);
    expect(await hasShotSyncReceipt(db, A_IDS[0]!)).toBe(false);
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it('V7: 50-row batch boundary — 51 queued shots across a re-sign-in drain in two passes with no shot POSTed twice', async () => {
    const IDS = Array.from({ length: 51 }, (_, i) => shotId(0x1000 + i));
    await queueShots(IDS);
    const db = getDb();

    configureSyncRuntime(session('bearer-one'));
    await settle();
    expect(shotPosts(recorded)).toHaveLength(1);
    expect(recorded[0]!.shotIds).toHaveLength(50);

    resignIn('bearer-two');
    await settle();
    expect(shotPosts(recorded)).toHaveLength(1);

    recorded[0]!.accept();
    await settle();
    // The follow-up pass carries only the 51st row.
    expect(shotPosts(recorded)).toHaveLength(2);
    expect(recorded[1]!.bearer).toBe('Bearer bearer-two');
    expect(recorded[1]!.shotIds).toEqual([IDS[50]]);
    recorded[1]!.accept();
    await settle();

    const seen = new Map<string, number>();
    for (const r of shotPosts(recorded))
      for (const id of r.shotIds) seen.set(id, (seen.get(id) ?? 0) + 1);
    expect([...seen.values()].every(n => n === 1)).toBe(true);
    expect(seen.size).toBe(51);
    expect(await outboxRows(db, OWNER)).toEqual([]);
  });

  it('V8: 200 interleaved re-sign-ins + triggers + foreground events while parked → still one POST and one follow-up drain', async () => {
    const IDS = [shotId(0x2001)];
    await queueShots(IDS);
    const db = getDb();
    configureSyncRuntime(session('bearer-one'));
    await settle();

    for (let i = 0; i < 200; i++) {
      if (i % 3 === 0) resignIn(`bearer-${i}`);
      else if (i % 3 === 1) triggerOutboxSync();
      else for (const l of appStateListeners) l('active');
      if (i % 17 === 0) await settle();
    }
    await settle();
    expect(shotPosts(recorded)).toHaveLength(1);
    expect(appStateListeners).toHaveLength(1);

    recorded[0]!.accept();
    await settle();
    expect(selectCount()).toBe(2);
    await jest.advanceTimersByTimeAsync(SYNC_RETRY_MAX_MS * 2);
    expect(shotPosts(recorded)).toHaveLength(1);
    expect(await outboxRows(db, OWNER)).toEqual([]);
    expect(await hasShotSyncReceipt(db, IDS[0]!)).toBe(true);
  });
});
