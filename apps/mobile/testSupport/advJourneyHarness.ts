import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { CapturedClip } from '../src/camera/capture';
import type { RunCaptureAnalysisRequest } from '../src/analysis/runCaptureAnalysis';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
} from '../src/account/apiSession';
import {
  captureDataOwnerContext,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import { createTransport } from '../src/data/api';
import type { LocalDb } from '../src/data/db';
import { createSqliteTestDb, seedSqliteCapture } from './sqlite';

/**
 * Adversarial end-to-end journey harness (INT-e2e-journeys).
 *
 * Real migrated SQLite (optionally file-backed so a "relaunch" is a genuine
 * close + reopen that re-runs every startup migration), the shipping HTTP
 * transport (`createTransport`) over a scripted fetch, and knobs for the
 * failure boundaries under attack: network loss, lost acknowledgements,
 * slow responses, 4xx/5xx verdicts and bearer capture per request.
 */

export const ADV_OWNER_A = '11111111-1111-4111-8111-111111111111';
export const ADV_OWNER_B = '22222222-2222-4222-8222-222222222222';
export const ADV_API_ORIGIN = 'https://api.example.test/functions/v1/api';

export function advSignIn(
  owner: string,
  bearerToken = `bearer-for-${owner.slice(0, 8)}`,
  apiBaseUrl = ADV_API_ORIGIN,
) {
  setActiveDataOwner(owner);
  establishApiSession({
    canonicalAppUserId: owner,
    apiBaseUrl,
    bearerToken,
    provider: 'apple',
  });
}

export function advSignOut() {
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
}

export function advFixture(label = 'owned') {
  const { sequence, window } = generateSwingSequence();
  const sidecar = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: `file:///private/captures/${label}.mov`,
    capturedAtIso: '2026-09-06T12:00:00.000Z',
    durationMs: window.endMs,
    width: 1080,
    height: 1080,
    fps: 60,
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: `file:///private/captures/${label}.pose.json`,
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecar),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
  return { clip, sidecar, sequence };
}

export function advResponse(status: number, body: unknown): Response {
  return {
    ok: status < 400,
    status,
    statusText: String(status),
    json: async () => body,
  } as Response;
}

export interface AdvServerCall {
  url: string;
  bearer: string | undefined;
  body: Record<string, unknown>;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/**
 * Scripted backend. Every knob is one-shot unless stated: the attack arms it,
 * the next matching request consumes it.
 */
export function advServer() {
  const reservations = new Map<
    string,
    { id: string; outcome: string | null }
  >();
  const acceptedShots: string[] = [];
  const createdSessions: string[] = [];
  const finalizedSessions: string[] = [];
  const calls: AdvServerCall[] = [];
  const knobs = {
    /** Next request throws a network error before reaching the server. */
    networkDownOnce: null as RegExp | null,
    /** Network stays down for every request matching the pattern. */
    networkDown: null as RegExp | null,
    /** Server applies the request, then the response is lost. */
    loseResponseOnce: null as RegExp | null,
    /** Server answers the next matching request with this status/body. */
    statusOnce: null as { match: RegExp; status: number; body: unknown } | null,
    /** Hold the next matching request until released. */
    holdOnce: null as { match: RegExp; gate: Promise<void> } | null,
    /** Runs while the matching request is "on the wire" (before the verdict). */
    onRequest: null as ((call: AdvServerCall) => Promise<void> | void) | null,
  };
  const fetchPort = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<
        string,
        unknown
      >;
      const bearer = (init?.headers as Record<string, string> | undefined)
        ?.authorization;
      const call = { url, body, bearer };
      calls.push(call);
      if (knobs.networkDown?.test(url))
        throw new TypeError('Network request failed');
      if (knobs.networkDownOnce?.test(url)) {
        knobs.networkDownOnce = null;
        throw new TypeError('Network request failed');
      }
      if (knobs.holdOnce?.match.test(url)) {
        const gate = knobs.holdOnce.gate;
        knobs.holdOnce = null;
        await gate;
      }
      if (knobs.onRequest) await knobs.onRequest(call);
      if (knobs.statusOnce?.match.test(url)) {
        const { status, body: replyBody } = knobs.statusOnce;
        knobs.statusOnce = null;
        return advResponse(status, replyBody);
      }
      const lost = knobs.loseResponseOnce?.test(url) ?? false;
      if (lost) knobs.loseResponseOnce = null;
      const reply = (status: number, replyBody: unknown) => {
        if (lost) throw new TypeError('Network request failed (response lost)');
        return advResponse(status, replyBody);
      };
      if (url.endsWith('/v1/analysis-permits')) {
        const key = String(body.idempotencyKey);
        let permit = reservations.get(key);
        if (!permit) {
          permit = {
            id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(reservations.size + 1).padStart(12, '0')}`,
            outcome: null,
          };
          reservations.set(key, permit);
        }
        return reply(200, {
          permit: {
            id: permit.id,
            status: permit.outcome ? 'finalized' : 'reserved',
            accessSource: 'free',
            expiresAt: '2026-09-07T00:00:00.000Z',
          },
        });
      }
      if (url.endsWith('/finalize') && url.includes('/v1/analysis-permits/')) {
        const permit = [...reservations.values()].find(value =>
          url.includes(value.id),
        );
        if (!permit)
          return reply(404, { error: { code: 'access.permit_not_found' } });
        if (permit.outcome && permit.outcome !== body.outcome)
          return reply(409, {
            error: { code: 'access.permit_already_finalized' },
          });
        permit.outcome = String(body.outcome);
        return reply(200, { permit });
      }
      if (url.endsWith('/v1/shots:sync')) {
        const shots = body.shots as Array<{
          id: string;
          analysisPermitId: string;
        }>;
        for (const shot of shots) {
          const permit = [...reservations.values()].find(
            value => value.id === shot.analysisPermitId,
          );
          if (permit) permit.outcome = 'scored';
          acceptedShots.push(shot.id);
        }
        return reply(200, {
          acceptedIds: shots.map(shot => shot.id),
          rejected: [],
        });
      }
      if (url.endsWith('/v1/sessions')) {
        createdSessions.push(String(body.id));
        return reply(200, {});
      }
      if (/\/v1\/sessions\/[^/]+\/finalize$/.test(url)) {
        finalizedSessions.push(url.split('/').slice(-2)[0]!);
        return reply(200, {});
      }
      throw new Error(`Unexpected test request ${url}`);
    },
  );
  return {
    calls,
    reservations,
    acceptedShots,
    createdSessions,
    finalizedSessions,
    fetchPort,
    knobs,
    /** Permits the server has charged (outcome scored). */
    get charged() {
      return [...reservations.values()].filter(
        value => value.outcome === 'scored',
      ).length;
    },
    /** Permits the server has released back (outcome released/failed/etc). */
    get released() {
      return [...reservations.values()].filter(
        value => value.outcome !== null && value.outcome !== 'scored',
      ).length;
    },
    requests(pattern: RegExp) {
      return calls.filter(call => pattern.test(call.url));
    },
  };
}

/**
 * Shipping-transport factory mirroring `configureSyncRuntime`: the bearer is
 * resolved per request and only while the bound owner is still the active
 * API session, exactly like production.
 */
export function advTransport(owner: string, apiOrigin = ADV_API_ORIGIN) {
  return createTransport({
    baseUrl: apiOrigin,
    get token() {
      const current = getApiSession();
      if (!current) return null;
      return current.canonicalAppUserId === owner &&
        current.apiBaseUrl === apiOrigin
        ? current.bearerToken
        : null;
    },
  });
}

export function advCaptureRequest(
  db: LocalDb,
  clip: CapturedClip,
  captureId: string,
  overrides: Partial<RunCaptureAnalysisRequest> = {},
): RunCaptureAnalysisRequest {
  return {
    db,
    ownerContext: captureDataOwnerContext(),
    captureId,
    clip,
    declaredStroke: 'forehand_drive',
    declaredCanonical: 'FOREHAND_DRIVE',
    handedness: 'right',
    cameraView: 'side',
    apiConfig: { baseUrl: ADV_API_ORIGIN, token: 'request-time-token' },
    appVersion: '0.1.0',
    ...overrides,
  };
}

export type AdvStore = ReturnType<typeof createSqliteTestDb>;

/** Opens (or re-opens after a simulated process death) the app database. */
export function advOpenDb(path = ':memory:'): AdvStore {
  return createSqliteTestDb(path);
}

export function advSeedCapture(
  store: AdvStore,
  owner: string,
  captureId: string,
  clip: CapturedClip,
) {
  seedSqliteCapture(store.db, owner, captureId, clip);
}

export function advRows(store: AdvStore, table: string, owner?: string) {
  return owner
    ? store.native
        .prepare(`SELECT * FROM ${table} WHERE owner_key = ?`)
        .all(owner)
    : store.native.prepare(`SELECT * FROM ${table}`).all();
}
