import { ApiError } from '../../src/data/api';
import type { SyncTransport } from '../../src/data/sync';
import { chance, int, pick, weighted, type Prng } from './prng';
import type { Scheduler } from './scheduler';

/**
 * Seeded stand-in for POST /v1/shots:sync, /v1/sessions, /v1/sessions/:id/
 * finalize and /v1/me/evaluation/trials.
 *
 * Server semantics mirrored from supabase/functions/api/index.ts `syncShots`
 * (VERIFIED by reading, not by running the edge function):
 *   - a shot id this owner already synced is acknowledged again (idempotent
 *     replay — `replayIds`), it is never written or charged twice;
 *   - a permit already consumed by a different shot is refused with the
 *     permanent code `access.permit_not_reserved`;
 *   - per-item rejections carry the contract codes listed in
 *     SYNC_STATUS_MESSAGES / `shot.write_failed`.
 * Everything else — which failure class a request draws, which items are
 * accepted/rejected/omitted — is a seeded decision so every iteration is
 * replayable from its seed.
 */
export type VerdictClass =
  | 'accepted'
  | 'replay_accepted'
  | 'rejected_transient'
  | 'rejected_permanent'
  | 'omitted'
  | 'request_permanent'
  | 'request_transient';

export interface ServerCallRecord {
  seq: number;
  op: 'syncShots' | 'createSession' | 'finalizeSession' | 'uploadTrials';
  owner: string;
  actor: string;
  ids: string[];
  outcome: string;
  verdicts: Record<string, VerdictClass>;
}

export type RequestMode =
  | 'accept'
  | 'partial'
  | 'api_error'
  | 'network_error'
  | 'timeout'
  | 'malformed_body'
  | 'revoked';

export interface ServerProfile {
  name: string;
  modes: ReadonlyArray<[RequestMode, number]>;
  /** Per-item verdict weights inside `partial` responses. */
  itemVerdicts: ReadonlyArray<
    [
      'accepted' | 'rejected_transient' | 'rejected_permanent' | 'omitted',
      number,
    ]
  >;
}

export const SERVER_PROFILES: readonly ServerProfile[] = [
  {
    name: 'healthy',
    modes: [
      ['accept', 80],
      ['partial', 10],
      ['api_error', 5],
      ['network_error', 3],
      ['timeout', 2],
    ],
    itemVerdicts: [
      ['accepted', 70],
      ['rejected_transient', 15],
      ['rejected_permanent', 10],
      ['omitted', 5],
    ],
  },
  {
    name: 'flaky',
    modes: [
      ['accept', 35],
      ['partial', 25],
      ['api_error', 20],
      ['network_error', 10],
      ['timeout', 7],
      ['malformed_body', 3],
    ],
    itemVerdicts: [
      ['accepted', 45],
      ['rejected_transient', 25],
      ['rejected_permanent', 20],
      ['omitted', 10],
    ],
  },
  {
    name: 'hostile',
    modes: [
      ['accept', 15],
      ['partial', 30],
      ['api_error', 30],
      ['network_error', 10],
      ['timeout', 10],
      ['malformed_body', 5],
    ],
    itemVerdicts: [
      ['accepted', 30],
      ['rejected_transient', 30],
      ['rejected_permanent', 25],
      ['omitted', 15],
    ],
  },
];

/** HTTP statuses the drain classifies (sync.ts isPermanentSyncFailure). */
export const API_ERROR_STATUSES: ReadonlyArray<[number, string]> = [
  [400, 'validation.shots_sync'],
  [401, 'auth.required'],
  [403, 'auth.forbidden'],
  [404, 'route.not_found'],
  [408, 'network.timeout'],
  [409, 'shot.id_conflict'],
  [413, 'payload.too_large'],
  [422, 'validation.shot'],
  [429, 'rate.limited'],
  [500, 'server.error'],
  [502, 'server.bad_gateway'],
  [503, 'server.unavailable'],
  [504, 'server.timeout'],
];

export const TRANSIENT_ITEM_CODES = [
  'shot.write_failed',
  'auth.required',
  'shot.session_not_found',
] as const;

export const PERMANENT_ITEM_CODES = [
  'access.permit_not_found',
  'access.permit_not_reserved',
  'access.permit_expired',
  'access.paywall_required',
  'shot.id_conflict',
  'validation.shot',
] as const;

export function isPermanentStatus(status: number): boolean {
  return (
    status >= 400 &&
    status < 500 &&
    status !== 401 &&
    status !== 408 &&
    status !== 429
  );
}

interface ShotLedgerEntry {
  permitId: string;
  timesAccepted: number;
  timesSent: number;
}

export class FakeServer {
  readonly calls: ServerCallRecord[] = [];
  /** owner|shotId → ledger (first acceptance = the one "spend"). */
  readonly shots = new Map<string, ShotLedgerEntry>();
  /** owner|permitId → shotId that consumed it. */
  readonly permits = new Map<string, string>();
  readonly sessionsCreated = new Set<string>();
  readonly sessionsFinalized = new Set<string>();
  readonly trialsAccepted = new Set<string>();
  readonly revoked = new Set<string>();
  /** Requests carrying a shot id that another in-flight request also carries. */
  overlappingDuplicateSends = 0;
  private inFlightShotIds = new Map<string, number>();
  /** When true every request succeeds — used for the convergence phase. */
  forceHealthy = false;

  constructor(
    private readonly rng: Prng,
    private readonly scheduler: Scheduler,
    readonly profile: ServerProfile,
  ) {}

  revoke(owner: string): void {
    this.revoked.add(owner);
  }

  restore(owner: string): void {
    this.revoked.delete(owner);
  }

  private key(owner: string, id: string): string {
    return `${owner}|${id}`;
  }

  accepted(owner: string, shotId: string): boolean {
    return (this.shots.get(this.key(owner, shotId))?.timesAccepted ?? 0) > 0;
  }

  /** Sum over shots of (times sent − 1), i.e. redundant transmissions. */
  duplicateSends(): number {
    let total = 0;
    for (const entry of this.shots.values()) {
      total += Math.max(0, entry.timesSent - 1);
    }
    return total;
  }

  private drawMode(owner: string): RequestMode {
    if (this.revoked.has(owner)) return 'revoked';
    if (this.forceHealthy) return 'accept';
    return weighted(this.rng, this.profile.modes);
  }

  private throwFor(mode: RequestMode, record: ServerCallRecord): never {
    switch (mode) {
      case 'revoked': {
        record.outcome = 'ApiError 401 auth.required (bearer revoked)';
        for (const id of record.ids) record.verdicts[id] = 'request_transient';
        throw new ApiError(401, 'auth.required', 'Sign in again to sync.');
      }
      case 'api_error': {
        const [status, code] = pick(this.rng, API_ERROR_STATUSES);
        record.outcome = `ApiError ${status} ${code}`;
        const cls = isPermanentStatus(status)
          ? 'request_permanent'
          : 'request_transient';
        for (const id of record.ids) record.verdicts[id] = cls;
        throw new ApiError(status, code, `stress ${status}`);
      }
      case 'timeout': {
        record.outcome = 'ApiError 408 network.timeout (aborted mid-call)';
        for (const id of record.ids) record.verdicts[id] = 'request_transient';
        throw new ApiError(
          408,
          'network.timeout',
          'The server took too long to respond.',
        );
      }
      case 'network_error':
      default: {
        record.outcome = 'TypeError Network request failed';
        for (const id of record.ids) record.verdicts[id] = 'request_transient';
        throw new TypeError('Network request failed');
      }
    }
  }

  transportFor(owner: string, actor: string): SyncTransport {
    const start = (
      op: ServerCallRecord['op'],
      ids: string[],
    ): ServerCallRecord => {
      const record: ServerCallRecord = {
        seq: this.calls.length,
        op,
        owner,
        actor,
        ids,
        outcome: 'pending',
        verdicts: {},
      };
      this.calls.push(record);
      return record;
    };

    return {
      syncShots: async shots => {
        const payloads = shots as Array<Record<string, unknown>>;
        const ids = payloads.map(p => String(p['id']));
        const record = start('syncShots', ids);
        // Bearer is resolved at issue time (createTransport `get token()`).
        const mode = this.drawMode(owner);
        for (const id of ids) {
          const k = this.key(owner, id);
          const inFlight = this.inFlightShotIds.get(k) ?? 0;
          if (inFlight > 0) this.overlappingDuplicateSends += 1;
          this.inFlightShotIds.set(k, inFlight + 1);
        }
        try {
          await this.scheduler.networkRoundTrip();
          if (
            mode === 'api_error' ||
            mode === 'network_error' ||
            mode === 'timeout' ||
            mode === 'revoked'
          ) {
            this.throwFor(mode, record);
          }
          if (mode === 'malformed_body') {
            record.outcome = 'HTTP 200 with malformed body';
            for (const id of ids) record.verdicts[id] = 'request_transient';
            return { acceptedIds: ids } as unknown as {
              acceptedIds: string[];
              rejected: Array<{ id: string; code: string; message: string }>;
            };
          }
          const acceptedIds: string[] = [];
          const rejected: Array<{ id: string; code: string; message: string }> =
            [];
          for (const payload of payloads) {
            const id = String(payload['id']);
            const permitId = String(payload['analysisPermitId']);
            const k = this.key(owner, id);
            const ledger = this.shots.get(k) ?? {
              permitId,
              timesAccepted: 0,
              timesSent: 0,
            };
            ledger.timesSent += 1;
            this.shots.set(k, ledger);
            if (ledger.timesAccepted > 0) {
              // Idempotent replay: acknowledged, never charged again.
              ledger.timesAccepted += 1;
              acceptedIds.push(id);
              record.verdicts[id] = 'replay_accepted';
              continue;
            }
            const permitKey = this.key(owner, permitId);
            const permitHolder = this.permits.get(permitKey);
            if (permitHolder !== undefined && permitHolder !== id) {
              rejected.push({
                id,
                code: 'access.permit_not_reserved',
                message: 'Analysis permit is no longer reserved.',
              });
              record.verdicts[id] = 'rejected_permanent';
              continue;
            }
            const verdict =
              mode === 'accept'
                ? 'accepted'
                : weighted(this.rng, this.profile.itemVerdicts);
            switch (verdict) {
              case 'accepted':
                ledger.timesAccepted = 1;
                this.permits.set(permitKey, id);
                acceptedIds.push(id);
                record.verdicts[id] = 'accepted';
                break;
              case 'rejected_transient':
                rejected.push({
                  id,
                  code: pick(this.rng, TRANSIENT_ITEM_CODES),
                  message: 'transient rejection',
                });
                record.verdicts[id] = 'rejected_transient';
                break;
              case 'rejected_permanent':
                rejected.push({
                  id,
                  code: pick(this.rng, PERMANENT_ITEM_CODES),
                  message: 'permanent rejection',
                });
                record.verdicts[id] = 'rejected_permanent';
                break;
              case 'omitted':
              default:
                record.verdicts[id] = 'omitted';
                break;
            }
          }
          if (chance(this.rng, 0.05) && !this.forceHealthy) {
            // A foreign id in acceptedIds must never produce a receipt.
            acceptedIds.push(`foreign-${int(this.rng, 1000, 9999)}`);
          }
          record.outcome = `HTTP 200 accepted=${acceptedIds.length} rejected=${rejected.length}`;
          return { acceptedIds, rejected };
        } finally {
          for (const id of ids) {
            const k = this.key(owner, id);
            this.inFlightShotIds.set(k, (this.inFlightShotIds.get(k) ?? 1) - 1);
          }
        }
      },

      createSession: async session => {
        const id = String((session as Record<string, unknown>)['id']);
        const record = start('createSession', [id]);
        const mode = this.drawMode(owner);
        await this.scheduler.networkRoundTrip();
        if (
          mode === 'accept' ||
          mode === 'partial' ||
          mode === 'malformed_body'
        ) {
          this.sessionsCreated.add(this.key(owner, id));
          record.outcome = 'HTTP 200';
          record.verdicts[id] = 'accepted';
          return;
        }
        this.throwFor(mode, record);
      },

      finalizeSession: async id => {
        const record = start('finalizeSession', [id]);
        const mode = this.drawMode(owner);
        await this.scheduler.networkRoundTrip();
        if (
          mode === 'accept' ||
          mode === 'partial' ||
          mode === 'malformed_body'
        ) {
          this.sessionsFinalized.add(this.key(owner, id));
          record.outcome = 'HTTP 200';
          record.verdicts[id] = 'accepted';
          return;
        }
        this.throwFor(mode, record);
      },

      uploadEvaluationTrials: async trials => {
        const items = trials as Array<{ trialId: string }>;
        const ids = items.map(t => t.trialId);
        const record = start('uploadTrials', ids);
        const mode = this.drawMode(owner);
        await this.scheduler.networkRoundTrip();
        if (
          mode === 'api_error' ||
          mode === 'network_error' ||
          mode === 'timeout' ||
          mode === 'revoked'
        ) {
          this.throwFor(mode, record);
        }
        if (mode === 'malformed_body') {
          record.outcome = 'HTTP 200 with malformed body';
          for (const id of ids) record.verdicts[id] = 'request_transient';
          return { acceptedTrialIds: ids } as unknown as {
            acceptedTrialIds: string[];
            rejected: Array<{ trialId: string; code: string; message: string }>;
          };
        }
        const acceptedTrialIds: string[] = [];
        const rejected: Array<{
          trialId: string;
          code: string;
          message: string;
        }> = [];
        for (const id of ids) {
          const verdict =
            mode === 'accept'
              ? 'accepted'
              : weighted(this.rng, this.profile.itemVerdicts);
          switch (verdict) {
            case 'accepted':
              this.trialsAccepted.add(this.key(owner, id));
              acceptedTrialIds.push(id);
              record.verdicts[id] = 'accepted';
              break;
            case 'rejected_transient':
              rejected.push({
                trialId: id,
                code: 'evaluation.trial_write_failed',
                message: 'transient',
              });
              record.verdicts[id] = 'rejected_transient';
              break;
            case 'rejected_permanent':
              rejected.push({
                trialId: id,
                code: 'evaluation.consent_required',
                message: 'permanent',
              });
              record.verdicts[id] = 'rejected_permanent';
              break;
            case 'omitted':
            default:
              record.verdicts[id] = 'omitted';
          }
        }
        record.outcome = `HTTP 200 accepted=${acceptedTrialIds.length} rejected=${rejected.length}`;
        return { acceptedTrialIds, rejected };
      },
    };
  }
}
