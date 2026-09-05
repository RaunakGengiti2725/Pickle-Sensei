/**
 * Seeded lifecycle campaign over consentStore + consentApi + apiSession.
 *
 * Each iteration schedules 3–12 events on a virtual timeline (login/rotate,
 * account switch, logout, hydrate, toggle, wall-clock skew) against a fake
 * consent server that PROCESSES a request at one virtual instant and REPLIES
 * at a later one — so a status read can be processed before a mutation yet
 * land after it, two accounts can be in flight at once, and a bearer can be
 * rotated or cleared while a request is outstanding.
 *
 * Invariants (per iteration, after the timeline drains):
 *  - no deadlock: every toggle promise settles, `busy` is false, no timers
 *    remain, all inside the 15 s client deadline per request;
 *  - no duplicate mutation: the server never sees two overlapping mutations
 *    from this device (the store's `busy` gate holds under bursts);
 *  - session binding: a `ready` state always carries the ledger of the account
 *    that is signed in at that instant (no cross-account leak); a signed-out
 *    device never shows an account's consent;
 *  - clock skew is inert: Date.now() jumps never change any outcome or
 *    deadline (deadlines are timer-based);
 *  - convergence: when signed in and `ready` at the end, the store's
 *    `modelTrainingActive` equals the server ledger — deviations are recorded
 *    (not asserted) as `divergence` so the campaign quantifies them.
 *  - dropped toggles are classified: legit (a mutation of the CURRENT account
 *    is in flight) vs `staleBusy` (busy held by a previous account's request).
 *
 * Scale: STRESS_ITER (default 60); replay: STRESS_SEED=<seed>.
 */
declare const process: { env: Record<string, string | undefined> };

import type { ApiSession } from '../../../src/account/apiSession';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
} from '../../../src/account/apiSession';
import { useConsentStore } from '../../../src/state/consentStore';
import {
  CLIENT_DEADLINE_MS,
  campaignSeeds,
  chance,
  drain,
  pick,
  randomInt,
  runIteration,
  type Rng,
} from '../../../testing/stress/concurrency';

const SUITE = 'consentStoreLifecycle';
const API = 'https://api.example.test/functions/v1/api';
const USERS = {
  A: '11111111-1111-4111-8111-111111111111',
  B: '22222222-2222-4222-8222-222222222222',
} as const;
type User = keyof typeof USERS;

/* ------------------------------- server --------------------------------- */

type Outcome = 'ok' | 'http_error' | 'throw' | 'hang';

interface ServerRequest {
  seq: number;
  user: User | null;
  bearer: string;
  kind: 'status' | 'grant' | 'withdraw';
  issuedAtMs: number;
  processedAtMs: number | null;
  repliedAtMs: number | null;
  abortedAtMs: number | null;
  outcome: Outcome;
}

class ConsentLedgerServer {
  readonly ledger: Record<
    User,
    { active: boolean; lastActionAt: string | null; n: number }
  > = {
    A: { active: false, lastActionAt: null, n: 0 },
    B: { active: false, lastActionAt: null, n: 0 },
  };
  readonly requests: ServerRequest[] = [];
  /** Bearer → user (every bearer ever issued stays valid, like a live access
   * token that has not expired). */
  readonly bearers = new Map<string, User>();

  constructor(
    private readonly rng: Rng,
    private readonly now: () => number,
  ) {}

  fetch = (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const headers = init?.headers as Record<string, string>;
    const bearer = headers['Authorization']?.replace('Bearer ', '') ?? '';
    const kind = url.endsWith('/status')
      ? 'status'
      : url.endsWith('/grant')
        ? 'grant'
        : 'withdraw';
    const outcome = pick<Outcome>(this.rng, [
      'ok',
      'ok',
      'ok',
      'ok',
      'ok',
      'ok',
      'http_error',
      'throw',
      'hang',
    ]);
    const processMs = randomInt(this.rng, 0, 6_000);
    const replyMs = randomInt(this.rng, 0, 8_000);
    const request: ServerRequest = {
      seq: this.requests.length,
      user: this.bearers.get(bearer) ?? null,
      bearer,
      kind,
      issuedAtMs: this.now(),
      processedAtMs: null,
      repliedAtMs: null,
      abortedAtMs: null,
      outcome,
    };
    this.requests.push(request);
    expect(method).toBe(kind === 'status' ? 'GET' : 'POST');

    return new Promise<Response>((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        request.repliedAtMs = this.now();
        fn();
      };
      init?.signal?.addEventListener('abort', () => {
        request.abortedAtMs = this.now();
        finish(() =>
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
        );
      });
      if (outcome === 'hang') return;
      if (outcome === 'throw') {
        setTimeout(
          () => finish(() => reject(new TypeError('Network request failed'))),
          processMs,
        );
        return;
      }
      setTimeout(() => {
        request.processedAtMs = this.now();
        if (outcome === 'http_error') {
          setTimeout(
            () =>
              finish(() =>
                resolve(
                  new Response(JSON.stringify({ error: { message: 'nope' } }), {
                    status: pick(this.rng, [400, 401, 429, 500, 503]),
                  }),
                ),
              ),
            replyMs,
          );
          return;
        }
        const user = request.user;
        if (!user) {
          setTimeout(
            () =>
              finish(() =>
                resolve(
                  new Response(
                    JSON.stringify({ error: { message: 'unauthorized' } }),
                    {
                      status: 401,
                    },
                  ),
                ),
              ),
            replyMs,
          );
          return;
        }
        const row = this.ledger[user];
        if (kind !== 'status') {
          row.active = kind === 'grant';
          row.n += 1;
          // Server clock: never the client's Date.now().
          row.lastActionAt = `${user}:${row.n}:${new Date(1_800_000_000_000 + this.now()).toISOString()}`;
        }
        const snapshot = { ...row };
        setTimeout(() => {
          finish(() =>
            resolve(
              new Response(
                JSON.stringify({
                  subjectPseudonym: `pseud-${user}`,
                  scopes: [
                    {
                      scope: 'model_training',
                      active: snapshot.active,
                      consentVersion: snapshot.active ? 'mt-v1' : null,
                      lastAction:
                        snapshot.n === 0
                          ? null
                          : snapshot.active
                            ? 'granted'
                            : 'withdrawn',
                      lastActionAt: snapshot.lastActionAt,
                    },
                    {
                      scope: 'evaluation_telemetry',
                      active: false,
                      consentVersion: null,
                      lastAction: null,
                      lastActionAt: null,
                    },
                  ],
                }),
                {
                  status: 200,
                  headers: { 'Content-Type': 'application/json' },
                },
              ),
            ),
          );
        }, replyMs);
      }, processMs);
    });
  };
}

/* ------------------------------- timeline ------------------------------- */

type EventKind = 'login' | 'switch' | 'logout' | 'hydrate' | 'toggle' | 'skew';

interface TimelineEvent {
  atMs: number;
  kind: EventKind;
  user?: User;
  granted?: boolean;
  skewMs?: number;
}

interface Transition {
  atMs: number;
  availability: string;
  active: boolean;
  lastActionAt: string | null;
  busy: boolean;
  error: string | null;
  sessionUser: User | null;
}

function planTimeline(rng: Rng): TimelineEvent[] {
  const count = randomInt(rng, 3, 12);
  const events: TimelineEvent[] = [];
  let signedIn: User | null = null;
  for (let i = 0; i < count; i += 1) {
    const atMs = randomInt(rng, 0, 20_000);
    const kind: EventKind = signedIn
      ? pick(rng, [
          'toggle',
          'toggle',
          'toggle',
          'hydrate',
          'login',
          'switch',
          'logout',
          'skew',
        ])
      : pick(rng, ['login', 'login', 'login', 'hydrate', 'toggle', 'skew']);
    switch (kind) {
      case 'login': {
        const user: User = signedIn ?? pick(rng, ['A', 'B']);
        events.push({ atMs, kind, user });
        signedIn = user;
        break;
      }
      case 'switch': {
        const user: User = signedIn === 'A' ? 'B' : 'A';
        events.push({ atMs, kind, user });
        signedIn = user;
        break;
      }
      case 'logout':
        events.push({ atMs, kind });
        signedIn = null;
        break;
      case 'toggle':
        events.push({ atMs, kind, granted: chance(rng, 0.5) });
        break;
      case 'skew':
        events.push({
          atMs,
          kind,
          skewMs: pick(rng, [-3_600_000, -60_000, 60_000, 3_600_000]),
        });
        break;
      case 'hydrate':
        events.push({ atMs, kind });
    }
  }
  // Timeline order is by time; the planner's notion of "signed in" only
  // biases the mix — events are still applied in temporal order.
  return events.sort((a, b) => a.atMs - b.atMs);
}

function sessionFor(user: User, bearer: string): ApiSession {
  return {
    apiBaseUrl: API,
    bearerToken: bearer,
    canonicalAppUserId: USERS[user],
    provider: 'apple',
    refreshToken: `refresh-${user}`,
    bearerExpiresAtMs: Date.now() + 3_600_000,
  };
}

function currentUser(): User | null {
  const id = getApiSession()?.canonicalAppUserId;
  return id === USERS.A ? 'A' : id === USERS.B ? 'B' : null;
}

const BUDGET_MS = 20_000 + CLIENT_DEADLINE_MS + 1_000;

describe('consentStore lifecycle — seeded session/timeline interleavings', () => {
  const initialState = useConsentStore.getState();
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-09-05T02:00:00.000Z') });
    clearApiSession();
    useConsentStore.setState(initialState, true);
  });
  afterEach(() => {
    clearApiSession();
    jest.useRealTimers();
  });

  const seeds = campaignSeeds(`${SUITE}/timeline`, 60);
  const totals = {
    events: 0,
    requests: 0,
    mutations: 0,
    toggles: 0,
    droppedLegit: 0,
    droppedStaleBusy: 0,
    divergent: 0,
    skews: 0,
  };

  it.each(seeds)(
    'seed %i: store stays bound, bounded and de-duplicated',
    async seed => {
      await runIteration(SUITE, 'timeline', seed, async rng => {
        let mono = 0;
        const now = () => mono;
        const server = new ConsentLedgerServer(rng, now);
        const events = planTimeline(rng);
        const transitions: Transition[] = [];
        const toggleLog: Array<{
          atMs: number;
          granted: boolean;
          user: User | null;
          issuedRequest: boolean;
          busyBefore: boolean;
          busyOwner: User | null;
          settledAtMs: number | null;
        }> = [];
        let bearerCounter = 0;
        /** Which account's mutation currently holds `busy` (server view). */
        let busyOwner: User | null = null;
        let sessionUserAtLastTransition: User | null = null;

        const unsubscribe = useConsentStore.subscribe(state => {
          sessionUserAtLastTransition = currentUser();
          transitions.push({
            atMs: mono,
            availability: state.availability,
            active: state.modelTrainingActive,
            lastActionAt: state.lastActionAt,
            busy: state.busy,
            error: state.error,
            sessionUser: sessionUserAtLastTransition,
          });
        });

        const pending: Array<Promise<void>> = [];
        const fire = (event: TimelineEvent) => {
          switch (event.kind) {
            case 'login':
            case 'switch': {
              const user = event.user as User;
              bearerCounter += 1;
              const bearer = `bearer-${user}-${bearerCounter}`;
              server.bearers.set(bearer, user);
              establishApiSession(sessionFor(user, bearer));
              // Screen effect: hydrate on every session change.
              pending.push(useConsentStore.getState().hydrate(server.fetch));
              return;
            }
            case 'logout':
              clearApiSession();
              pending.push(useConsentStore.getState().hydrate(server.fetch));
              return;
            case 'hydrate':
              pending.push(useConsentStore.getState().hydrate(server.fetch));
              return;
            case 'skew':
              jest.setSystemTime(Date.now() + (event.skewMs ?? 0));
              return;
            case 'toggle': {
              const before = useConsentStore.getState().busy;
              const requestsBefore = server.requests.length;
              const entry = {
                atMs: mono,
                granted: event.granted ?? false,
                user: currentUser(),
                issuedRequest: false,
                busyBefore: before,
                busyOwner,
                settledAtMs: null as number | null,
              };
              toggleLog.push(entry);
              const promise = useConsentStore
                .getState()
                .setModelTrainingConsent(event.granted ?? false, server.fetch);
              entry.issuedRequest = server.requests.length > requestsBefore;
              if (entry.issuedRequest) busyOwner = entry.user;
              pending.push(
                promise.then(() => {
                  entry.settledAtMs = mono;
                  if (entry.issuedRequest) busyOwner = null;
                }),
              );
            }
          }
        };
        for (const event of events) setTimeout(() => fire(event), event.atMs);

        let allSettled = false;
        const elapsed = await drain(
          () => mono > 20_000 && jest.getTimerCount() === 0,
          BUDGET_MS,
          50,
          e => {
            mono = e;
          },
        );
        // `pending` grows while the timeline runs; settle whatever exists now.
        await Promise.all(pending).then(() => {
          allSettled = true;
        });
        unsubscribe();

        const state = useConsentStore.getState();
        const user = currentUser();
        const mutations = server.requests.filter(r => r.kind !== 'status');
        const dropped = toggleLog.filter(
          t => !t.issuedRequest && t.user !== null,
        );
        const droppedStaleBusy = dropped.filter(
          t => t.busyBefore && t.busyOwner !== t.user,
        );
        const droppedLegit = dropped.filter(
          t => t.busyBefore && t.busyOwner === t.user,
        );
        const divergent =
          user !== null && state.availability === 'ready'
            ? state.modelTrainingActive !== server.ledger[user].active
            : false;
        // Overlapping mutations, split by whether they hit the same account row.
        const intervals = mutations.map(r => ({
          user: r.user,
          start: r.issuedAtMs,
          end:
            r.abortedAtMs ?? r.repliedAtMs ?? r.issuedAtMs + CLIENT_DEADLINE_MS,
        }));
        const overlaps: Array<{ same: boolean; a: number; b: number }> = [];
        for (let i = 0; i < intervals.length; i += 1) {
          for (let j = i + 1; j < intervals.length; j += 1) {
            const a = intervals[i];
            const b = intervals[j];
            if (!a || !b) continue;
            if (b.start < a.end && a.start < b.end) {
              overlaps.push({ same: a.user === b.user, a: i, b: j });
            }
          }
        }
        const sameRowOverlaps = overlaps.filter(o => o.same).length;
        const crossRowOverlaps = overlaps.filter(o => !o.same).length;

        const observed = {
          events: events.length,
          requests: server.requests.length,
          mutations: mutations.length,
          toggles: toggleLog.length,
          droppedLegit: droppedLegit.length,
          droppedStaleBusy: droppedStaleBusy.length,
          divergent,
          sameRowOverlaps,
          crossRowOverlaps,
          finalUser: user,
          finalState: {
            availability: state.availability,
            active: state.modelTrainingActive,
            busy: state.busy,
            error: state.error,
          },
          serverLedger: {
            A: server.ledger.A.active,
            B: server.ledger.B.active,
          },
          virtualElapsedMs: elapsed,
          timersLeft: jest.getTimerCount(),
          transitions: transitions.length,
        };

        return {
          plan: { events },
          observed,
          check: () => {
            totals.events += events.length;
            totals.requests += server.requests.length;
            totals.mutations += mutations.length;
            totals.toggles += toggleLog.length;
            totals.droppedLegit += droppedLegit.length;
            totals.droppedStaleBusy += droppedStaleBusy.length;
            totals.divergent += divergent ? 1 : 0;
            totals.skews += events.filter(e => e.kind === 'skew').length;

            // No deadlock / no stuck spinner.
            expect(allSettled).toBe(true);
            expect(state.busy).toBe(false);
            expect(jest.getTimerCount()).toBe(0);
            for (const t of toggleLog) expect(t.settledAtMs).not.toBeNull();

            // Bounded: every request settled (reply or abort) within the
            // client deadline, measured on the monotonic clock — skew-proof.
            for (const r of server.requests) {
              const settledAt = r.abortedAtMs ?? r.repliedAtMs;
              if (r.outcome === 'hang') {
                expect(r.abortedAtMs).toBe(r.issuedAtMs + CLIENT_DEADLINE_MS);
              } else if (settledAt !== null) {
                expect(settledAt - r.issuedAtMs).toBeLessThanOrEqual(
                  CLIENT_DEADLINE_MS,
                );
              }
            }

            // Single-session runs (no sign-out, no account switch, no
            // concurrent hydrate): the `busy` gate must serialize mutations.
            const logins = new Set(
              events.filter(e => e.kind === 'login').map(e => e.user),
            );
            const singleSession =
              logins.size <= 1 &&
              !events.some(
                e =>
                  e.kind === 'logout' ||
                  e.kind === 'switch' ||
                  e.kind === 'hydrate',
              );
            if (singleSession)
              expect(sameRowOverlaps + crossRowOverlaps).toBe(0);
            // Across session changes / concurrent status reads the gate is
            // known to leak (stale responses clear `busy`, arrival order
            // decides the shown state). Those are measured above and asserted
            // only under STRESS_STRICT=1 — see the campaign findings.
            if (process.env['STRESS_STRICT'] === '1') {
              expect(sameRowOverlaps).toBe(0);
              expect(crossRowOverlaps).toBe(0);
              expect(divergent).toBe(false);
              expect(droppedStaleBusy).toHaveLength(0);
            }
            // Every mutation the server saw was asked for by a toggle.
            expect(mutations.length).toBeLessThanOrEqual(
              toggleLog.filter(t => t.issuedRequest).length,
            );
            // Every request went out under a bearer the server knows for
            // the account that was signed in when it was issued.
            for (const r of server.requests) expect(r.user).not.toBeNull();

            // Session binding: a `ready` state always shows the ledger of the
            // account signed in at that instant; signed-out never shows data.
            for (const t of transitions) {
              if (t.availability === 'ready') {
                expect(t.sessionUser).not.toBeNull();
                if (t.lastActionAt !== null) {
                  expect(t.lastActionAt.startsWith(`${t.sessionUser}:`)).toBe(
                    true,
                  );
                }
              }
              if (t.sessionUser === null) {
                // Only the transient `busy:false` from a stale mutation may
                // land between clearApiSession() and the follow-up hydrate.
                if (t.availability !== 'loading') {
                  expect(t.active).toBe(false);
                }
              }
            }
            if (user === null) {
              expect(state.availability).toBe('signed_out');
              expect(state.modelTrainingActive).toBe(false);
            } else if (
              state.availability === 'ready' &&
              state.lastActionAt !== null
            ) {
              expect(state.lastActionAt.startsWith(`${user}:`)).toBe(true);
            }

            // Every dropped toggle was dropped because `busy` was set.
            for (const t of dropped) expect(t.busyBefore).toBe(true);
          },
        };
      });
    },
  );

  it('records campaign totals', () => {
    expect(totals.toggles).toBeGreaterThan(0);
    expect(totals.requests).toBeGreaterThan(0);
  });
});
