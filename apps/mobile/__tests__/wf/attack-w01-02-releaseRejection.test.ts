import { createFakeOutboxDb } from '../../__harness__/serverResponseMatrix/outboxFakeDb';
/**
 * W01-02 ADVERSARIAL TEST (client side of the new contract) — attack branch
 * devin/pp/w01-02/attack-c01576c4 against candidate c01576c4.
 *
 * The candidate answers a scored shot synced while the release authority is
 * withdrawn / not installed with the per-shot code
 * `access.release_not_authorized`. This drives the SHIPPING outbox
 * (src/data/sync.ts) with exactly that rejection and records what happens to
 * the durable local rating when the authority comes back (the deny switch is
 * an incident lever, so "withdrawn now" is frequently "active again later").
 *
 * The test named BREAK is EXPECTED TO FAIL: it encodes the behaviour the
 * attacker argues the contract needs (a not-yet-authorized rating must be
 * re-offered once the authority is active again) and its failure is the
 * reproduction for the attack report.
 */
import {
  OUTBOX_MAX_ATTEMPTS,
  drainOutbox,
  isTransientSyncRejection,
  type SyncTransport,
} from '../../src/data/sync';
import {
  GUEST_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));

const RELEASE_CODE = 'access.release_not_authorized';
const SHOT_ID = 'aaaaaaaa-0102-4ccc-8ddd-eeeeeeeeeeee';
const analysis = {
  id: SHOT_ID,
  sessionId: null,
  shotType: 'dink',
  cameraView: 'side',
  handedness: 'right',
  capturedAtIso: '2026-09-08T18:00:00.000Z',
  timestamps: { startMs: 0, contactMs: 500, endMs: 1000 },
  phases: [],
  measurements: [],
  checkpoints: [],
  overallScore: 7.5,
  analysisConfidence: 0.9,
  resultKind: 'scored',
  guidance: null,
  priorityFix: null,
  versionVector: {
    appVersion: '0.1.0',
    modelBundleVersion: 'test-native-1',
    poseModelVersion: 'test-pose-1',
    paddleModelVersion: 'test-paddle-1',
    strokeDetectorVersion: 'test-stroke-1',
    phaseModelVersion: 'test-phase-1',
    scoringModelVersion: 'sm-v1',
    shotConfigVersion: 'dink@1',
  },
  source: 'real',
  analysisPermitId: 'cccccccc-0102-4ccc-8ddd-eeeeeeeeeeee',
};

function authorityTransport(): {
  transport: SyncTransport;
  setActive: (active: boolean) => void;
  calls: () => number;
} {
  let active = false;
  const syncShots = jest.fn(async (shots: Array<{ id: string }>) =>
    active
      ? { acceptedIds: shots.map(s => s.id), rejected: [] }
      : {
          acceptedIds: [],
          rejected: shots.map(s => ({
            id: s.id,
            code: RELEASE_CODE,
            message:
              'Validated ratings are not available right now. No rating was counted.',
          })),
        },
  );
  return {
    transport: {
      syncShots,
      uploadEvaluationTrials: jest.fn(async () => ({
        acceptedTrialIds: [],
        rejected: [],
      })),
    } as unknown as SyncTransport,
    setActive: value => {
      active = value;
    },
    calls: () => syncShots.mock.calls.length,
  };
}

beforeEach(() => {
  setActiveDataOwner(GUEST_DATA_OWNER);
});

describe('W01-02 attack: access.release_not_authorized on the shipping outbox', () => {
  it('is classified as a permanent contract verdict (burns the attempt budget)', () => {
    expect(isTransientSyncRejection(RELEASE_CODE)).toBe(false);
  });

  it('the rejected rating stays on the device (never dropped, never charged)', async () => {
    const fake = createFakeOutboxDb();
    fake.push('shot.sync', analysis, GUEST_DATA_OWNER);
    const { transport } = authorityTransport();
    const result = await drainOutbox(fake.db, transport);
    expect(result.failed).toBe(1);
    expect(result.remaining).toBe(1);
    expect(fake.outbox).toHaveLength(1);
    expect(fake.outbox[0]!.attempts).toBe(1);
    expect(fake.outbox[0]!.last_error).toContain(RELEASE_CODE);
  });

  it('BREAK(P2): after OUTBOX_MAX_ATTEMPTS drains during a withdrawal the rating is parked and never re-offered once the authority is active again', async () => {
    const fake = createFakeOutboxDb();
    fake.push('shot.sync', analysis, GUEST_DATA_OWNER);
    const authority = authorityTransport();
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i += 1) {
      await drainOutbox(fake.db, authority.transport);
    }
    expect(fake.outbox[0]!.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    const before = authority.calls();

    // Operator re-activates the policy.
    authority.setActive(true);
    const recovered = await drainOutbox(fake.db, authority.transport);

    // Expected by the attacker: a not-yet-authorized (but valid, uncharged)
    // rating is offered again once the authority is active; the server then
    // settles it under the permit the device still holds.
    expect(authority.calls()).toBe(before + 1);
    expect(recovered.synced).toBe(1);
    expect(fake.outbox).toHaveLength(0);
  });
});
