/// <reference types="node" />
/**
 * Loopback stand-in for the three `supabase/functions/api` routes the
 * saved-analysis path hits, with the server-side idempotency the real
 * routes implement (index.ts `reserveAnalysisPermit` / `finalizeAnalysisPermit`
 * / `syncShots`):
 *   - POST /v1/analysis-permits          → same idempotencyKey, same permit;
 *   - POST /v1/analysis-permits/:id/finalize → replay of the same outcome is
 *     acknowledged; a different one is 409 permit_already_finalized;
 *   - POST /v1/shots:sync                → a shot the user already owns is
 *     accepted again without rewriting; a new one consumes its reserved permit.
 * The in-memory state IS the durable server for the whole kill/relaunch pair,
 * so duplicates (two permits, two shots, a second consume) are visible to the
 * parent's assertions. Any unexpected route or bearer is recorded as
 * `unrouted` / `unauthorized` and answered with an error, never silently 200.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BEARER_TOKEN } from './report';
import { activeReleaseAuthority } from '../../testSupport/releasePolicyFixture';

export interface PermitRecord {
  readonly id: string;
  readonly idempotencyKey: string;
  status: 'reserved' | 'finalized';
  outcome: string | null;
}

export interface ServerRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly status: number;
}

export interface ServerSnapshot {
  readonly permits: readonly PermitRecord[];
  readonly shots: readonly { id: string; permitId: string }[];
  readonly requests: readonly ServerRequest[];
  readonly unrouted: readonly string[];
  readonly unauthorized: readonly string[];
}

export interface RatingService {
  readonly baseUrl: string;
  snapshot(): ServerSnapshot;
  close(): Promise<void>;
}

/** Mirrors the deployed function's mount point; the client appends `/v1/...`. */
const MOUNT_PATH = '/functions/v1/api';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function permitId(ordinal: number): string {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${String(ordinal).padStart(12, '0')}`;
}

function readJson(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('error', reject);
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
  });
}

export async function startRatingService(): Promise<RatingService> {
  const permits: PermitRecord[] = [];
  const shots: { id: string; permitId: string }[] = [];
  const requests: ServerRequest[] = [];
  const unrouted: string[] = [];
  const unauthorized: string[] = [];

  const view = (permit: PermitRecord) => ({
    id: permit.id,
    status: permit.status,
    outcome: permit.outcome,
    accessSource: 'free',
    expiresAt: '2100-01-01T00:00:00.000Z',
  });
  const error = (status: number, code: string, message: string) => ({
    status,
    body: { error: { code, message } },
  });

  const route = (
    method: string,
    path: string,
    body: unknown,
  ): { status: number; body: unknown } => {
    if (method === 'GET' && path === '/v1/analysis/release-policy') {
      return { status: 200, body: activeReleaseAuthority() };
    }
    if (method === 'POST' && path === '/v1/analysis-permits') {
      const key = isRecord(body) ? body['idempotencyKey'] : undefined;
      if (typeof key !== 'string' || key.length === 0)
        return error(400, 'validation.analysis_permit', 'idempotencyKey');
      let permit = permits.find(candidate => candidate.idempotencyKey === key);
      if (!permit) {
        permit = {
          id: permitId(permits.length + 1),
          idempotencyKey: key,
          status: 'reserved',
          outcome: null,
        };
        permits.push(permit);
      }
      return { status: 200, body: { permit: view(permit), access: null } };
    }
    const finalize = /^\/v1\/analysis-permits\/([^/]+)\/finalize$/.exec(path);
    if (method === 'POST' && finalize) {
      const id = decodeURIComponent(finalize[1] ?? '');
      const outcome = isRecord(body) ? body['outcome'] : undefined;
      const permit = permits.find(candidate => candidate.id === id);
      if (!permit)
        return error(404, 'access.permit_not_found', 'Permit not found.');
      if (typeof outcome !== 'string')
        return error(400, 'validation.analysis_permit_finalize', 'outcome');
      if (permit.status !== 'reserved') {
        if (permit.outcome === outcome)
          return { status: 200, body: { permit: view(permit), access: null } };
        return error(
          409,
          'access.permit_already_finalized',
          `Analysis permit was already finalized as ${permit.outcome}.`,
        );
      }
      permit.status = 'finalized';
      permit.outcome = outcome;
      return { status: 200, body: { permit: view(permit), access: null } };
    }
    if (method === 'POST' && path === '/v1/shots:sync') {
      const entries = isRecord(body) ? body['shots'] : undefined;
      if (!Array.isArray(entries) || entries.length === 0)
        return error(400, 'validation.shots_sync', 'shots');
      const acceptedIds: string[] = [];
      const rejected: { id: string; code: string; message: string }[] = [];
      for (const entry of entries) {
        const id = isRecord(entry) ? entry['id'] : undefined;
        const permitRef = isRecord(entry)
          ? entry['analysisPermitId']
          : undefined;
        if (typeof id !== 'string' || typeof permitRef !== 'string') {
          rejected.push({
            id: typeof id === 'string' ? id : 'unknown',
            code: 'validation.shot',
            message: 'Malformed shot.',
          });
          continue;
        }
        if (shots.some(shot => shot.id === id)) {
          acceptedIds.push(id);
          continue;
        }
        const permit = permits.find(candidate => candidate.id === permitRef);
        if (!permit || permit.status !== 'reserved') {
          rejected.push({
            id,
            code: 'access.permit_not_reserved',
            message: 'Analysis permit is no longer reserved.',
          });
          continue;
        }
        permit.status = 'finalized';
        permit.outcome = 'scored';
        shots.push({ id, permitId: permit.id });
        acceptedIds.push(id);
      }
      return { status: 200, body: { acceptedIds, rejected } };
    }
    unrouted.push(`${method} ${path}`);
    return error(404, 'harness.unrouted', `No route for ${method} ${path}.`);
  };

  const server = http.createServer((request, response) => {
    void (async () => {
      const method = request.method ?? 'GET';
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      const path = pathname.startsWith(MOUNT_PATH)
        ? pathname.slice(MOUNT_PATH.length)
        : pathname;
      const body = await readJson(request).catch(() => undefined);
      const authorization = request.headers['authorization'];
      const answer =
        authorization === `Bearer ${BEARER_TOKEN}`
          ? route(method, path, body)
          : (unauthorized.push(`${method} ${path}`),
            error(401, 'auth.invalid', 'Bad bearer.'));
      requests.push({ method, path, body, status: answer.status });
      const payload = JSON.stringify(answer.body);
      response.writeHead(answer.status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      });
      response.end(payload);
    })();
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}${MOUNT_PATH}`,
    snapshot: () => ({
      permits: permits.map(permit => ({ ...permit })),
      shots: shots.map(shot => ({ ...shot })),
      requests: [...requests],
      unrouted: [...unrouted],
      unauthorized: [...unauthorized],
    }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close(err => (err ? reject(err) : resolve()));
      }),
  };
}
