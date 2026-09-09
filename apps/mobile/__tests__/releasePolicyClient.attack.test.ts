/**
 * W01-06 adversarial suite — attacks the mobile release-policy client at its
 * failure boundaries: canonicalizer parity with the Edge function, concurrent
 * fetches racing a withdrawal, transport failures at every step of the
 * shipping path, an account switch in the middle of the fetch, clock and
 * cache boundaries, corrupt persisted records, process death around the cache
 * write, double submission and user-facing copy.
 *
 * Every test states the invariant the candidate is expected to keep; a failing
 * test is a confirmed break of that invariant on the attacked revision.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type {
  AnalysisReleaseApproval,
  AnalysisReleasePolicyDocument,
} from '@pickle/shared-types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CapturedClip } from '../src/camera/capture';
import type { LocalDb } from '../src/data/db';
import { getKv, setKv } from '../src/data/repository';
import {
  ANALYSIS_RELEASE_POLICY_PATH,
  createReleasePolicyClient,
} from '../src/data/api';
import {
  TRUSTED_TIME_ROLLBACK_TOLERANCE_MS,
  type TrustedTimeReading,
} from '../src/data/trustedTime';
import {
  RELEASE_NOT_AUTHORIZED_CODE,
  RELEASE_NOT_AUTHORIZED_MESSAGE,
} from '../src/analysis/partialOutcome';
import {
  RELEASE_AUTHORITY_SCHEMA_VERSION,
  RELEASE_POLICY_CACHE_MAX_AGE_MS,
  RELEASE_POLICY_CACHE_MAX_BYTES,
  canonicalizeReleasePolicyJson,
  digestReleasePolicyJson,
  readCachedReleasePolicy,
  releasePolicyCacheKeyForOwner,
  resolveReleaseAuthority,
  verifyReleaseAuthorityResponse,
  writeCachedReleasePolicy,
  type VerifiedReleasePolicy,
} from '../src/analysis/releasePolicyClient';
import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';
import {
  createCaptureAnalysisDb,
  closeCaptureHarness,
  fixtureUuid,
  seedCaptureRequest,
  signInCaptureOwner,
} from '../testSupport/captureAnalysisHarness';
import { finalizeAcknowledgement } from '../__harness__/analysisPermitRoute';

jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

let mockTrustedTimeReading: () => TrustedTimeReading = () =>
  anchoredReading(Date.now());
jest.mock('../src/data/trustedTime', () => {
  const actual = jest.requireActual('../src/data/trustedTime');
  return {
    ...actual,
    trustedTime: {
      ...actual.trustedTime,
      read: async () => mockTrustedTimeReading(),
    },
  };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};

// ─── fixtures ───────────────────────────────────────────────────────────────

const OWNER = '66666666-6666-4666-8666-666666666666';
const OTHER_OWNER = '77777777-7777-4777-8777-777777777777';
const API_ORIGIN = 'https://api.test';
const SCOPE = { ownerKey: OWNER, apiOrigin: API_ORIGIN };
const OTHER_SCOPE = { ownerKey: OTHER_OWNER, apiOrigin: API_ORIGIN };
const RETRY_LATER =
  'The rating service could not be reached. Your capture is saved and can be scored later.';

const artifact = { version: 'fixture-1', sha256: 'a'.repeat(64) };
const lineage = {
  pipeline: artifact,
  definition: artifact,
  model: artifact,
  preprocessing: artifact,
  calibration: artifact,
  dataset: artifact,
  validationReport: artifact,
  supportedDomain: artifact,
};
const nowSeconds = () => Math.floor(Date.now() / 1000);
const ABSENT = Symbol('absent');

function documentAt(
  validFrom: number,
  validUntil: number,
): AnalysisReleasePolicyDocument {
  return {
    schemaVersion: 'analysis-release-policy-v1',
    version: 'attack-policy-1',
    validFrom,
    validUntil,
    mechanics: { lineage },
    benchmark: {
      lineage,
      uncertainty: {
        kind: 'calibrated_prediction_interval',
        nominalCoverage: 0.9,
        coverageScope: 'supported_slice',
        calibrationUnit: 'player_session',
      },
      maximumIntervalWidth: 1.5,
      boundaryStep: 0.25,
      supportedIntervals: [{ lower: 3, upper: 5 }],
    },
    supportedInputs: [
      {
        shotType: 'forehand_drive',
        cameraView: 'side',
        handedness: 'right',
        captureMode: 'automatic_pose_trigger',
      },
    ],
  };
}

function activeDocument(): AnalysisReleasePolicyDocument {
  const from = nowSeconds() - 30 * 86_400;
  return documentAt(from, from + 366 * 86_400);
}

function verifiedPolicy(
  document: AnalysisReleasePolicyDocument = activeDocument(),
  approval: Partial<AnalysisReleaseApproval> = {},
): VerifiedReleasePolicy {
  return {
    document,
    canonicalDocument: canonicalizeReleasePolicyJson(document),
    approval: {
      policy: {
        version: document.version,
        sha256: digestReleasePolicyJson(document),
      },
      mechanicsApprovedAt: document.validFrom,
      benchmarkApprovedAt: document.validFrom,
      withdrawnAt: null,
      denyNewAuthorizations: false,
      ...approval,
    },
  };
}

function authority(
  policy: VerifiedReleasePolicy | null = verifiedPolicy(),
  serverTime: unknown = nowSeconds(),
): Record<string, unknown> {
  return {
    schemaVersion: RELEASE_AUTHORITY_SCHEMA_VERSION,
    serverTime,
    policy,
  };
}

function anchoredReading(nowMs: number): TrustedTimeReading {
  return {
    authority: 'anchored',
    continuity: 'measured',
    nowMs,
    wallClockMs: nowMs,
    rollbackDetected: false,
    storage: 'loaded',
  };
}

// ─── scripted HTTP ──────────────────────────────────────────────────────────

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}

type PolicyAnswer = (
  init: RequestInit | undefined,
  index: number,
) => Promise<Response> | Response;

interface ScriptedServer {
  fetchMock: jest.Mock;
  policyRequests: number;
  reserveBodies: unknown[];
  finalizeBodies: unknown[];
  urls: string[];
}

function scriptedServer(
  policy: PolicyAnswer,
  reserve: (index: number) => Response = index =>
    jsonResponse({
      permit: {
        id: fixtureUuid(`attack-permit:${index}`),
        accessSource: 'free',
        status: 'reserved',
        expiresAt: '2026-09-04T20:00:00.000Z',
      },
      access: {
        premium: false,
        freeRatings: {
          limit: 2,
          used: 0,
          reserved: 1,
          remaining: 2,
          availableToReserve: 1,
        },
      },
    }),
): ScriptedServer {
  const server: ScriptedServer = {
    fetchMock: jest.fn(),
    policyRequests: 0,
    reserveBodies: [],
    finalizeBodies: [],
    urls: [],
  };
  server.fetchMock.mockImplementation(
    async (url: string, init?: RequestInit) => {
      server.urls.push(url);
      if (url.endsWith(ANALYSIS_RELEASE_POLICY_PATH)) {
        server.policyRequests += 1;
        return policy(init, server.policyRequests);
      }
      if (url.endsWith('/v1/analysis-permits')) {
        server.reserveBodies.push(JSON.parse(String(init?.body)));
        return reserve(server.reserveBodies.length);
      }
      if (url.includes('/finalize')) {
        const body: unknown = JSON.parse(String(init?.body));
        server.finalizeBodies.push(body);
        return jsonResponse(finalizeAcknowledgement(url, body));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  );
  return server;
}

const offline: PolicyAnswer = () => {
  throw new TypeError('Network request failed');
};
const answer =
  (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  (): Response =>
    jsonResponse(body, status, headers);

function setFetch(fetchMock: unknown) {
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
}

// ─── capture fixture ────────────────────────────────────────────────────────

function swingClipWithSidecar(label: string): {
  clip: CapturedClip;
  sidecarJson: string;
} {
  const { sequence, window } = generateSwingSequence({});
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: `file:///captures/${label}.mov`,
    durationMs: window.endMs,
    fps: sequence.video.fps,
    width: sequence.video.width,
    height: sequence.video.height,
    capturedAtIso: '2026-09-04T12:00:00.000Z',
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: window.startMs,
      endMs: window.endMs,
      peakMotionMs: window.peakMs,
      confidence: 0.86,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'apple_vision_body_pose',
      poseModelVersion: sequence.producedBy.modelVersion,
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: sequence.frames.length,
      poseFrameCount: sequence.frames.length,
      poseMissingFrameCount: 0,
      trackedDurationMs: window.endMs - window.startMs,
      meanCanonicalJointVisibility: 0.9,
      meanJointCoverage: 0.9,
      minimumJointCoverage: 0.8,
      fullBodyVisibleFrameCount: sequence.frames.length,
      jointMotion: [
        {
          joint: 'right_wrist',
          sampleCount: 4,
          meanNormalizedPerSecond: 0.6,
          peakNormalizedPerSecond: 1.4,
        },
      ],
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 400,
    postRollMs: 300,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: `file:///captures/${label}.pose.json`,
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
  return { clip, sidecarJson };
}

type Harness = ReturnType<typeof createCaptureAnalysisDb>;

interface SeededCapture {
  request: Parameters<typeof runCaptureAnalysis>[0];
}

let captureSerial = 0;
function seedCapture(db: LocalDb, label?: string): SeededCapture {
  captureSerial += 1;
  const name = label ?? `attack-${captureSerial}`;
  const { clip, sidecarJson } = swingClipWithSidecar(name);
  mockReadArtifact = async () => sidecarJson;
  return {
    request: {
      db,
      ...seedCaptureRequest(db, clip, name),
      clip,
      declaredStroke: 'forehand_drive' as const,
      declaredCanonical: 'FOREHAND_DRIVE' as const,
      handedness: 'right' as const,
      cameraView: 'side' as const,
      apiConfig: { baseUrl: API_ORIGIN, token: 'token-attack' },
      appVersion: '0.1.0',
    },
  };
}

async function run(seeded: SeededCapture, server: ScriptedServer) {
  setFetch(server.fetchMock);
  return runCaptureAnalysis(seeded.request);
}

async function runFresh(db: Harness, server: ScriptedServer) {
  return run(seedCapture(db.db), server);
}

function expectMechanicsOnlyPartial(
  outcome: Awaited<ReturnType<typeof runCaptureAnalysis>>,
) {
  expect(outcome.kind).toBe('partial');
  if (outcome.kind !== 'partial') throw new Error('not a partial');
  expect(outcome.record.result).toBeNull();
  expect(outcome.record.partialOutcome).toEqual({
    status: 'partial',
    billingDisposition: 'not_chargeable',
    withheld: 'technique_benchmark',
    reasonCode: RELEASE_NOT_AUTHORIZED_CODE,
    message: RELEASE_NOT_AUTHORIZED_MESSAGE,
  });
}

function expectNothingChargeable(db: Harness, server: ScriptedServer) {
  expect(server.reserveBodies).toHaveLength(0);
  expect(server.finalizeBodies).toHaveLength(0);
  expect(db.shots).toHaveLength(0);
  expect(db.outbox).toHaveLength(0);
}

async function cachedSlot(db: LocalDb, ownerKey = OWNER) {
  const raw = await getKv(db, releasePolicyCacheKeyForOwner(ownerKey));
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

function gate(db: LocalDb, server: ScriptedServer, scope = SCOPE) {
  setFetch(server.fetchMock);
  return resolveReleaseAuthority({
    db,
    scope,
    client: createReleasePolicyClient({
      baseUrl: API_ORIGIN,
      token: 'bearer-attack',
    }),
  });
}

beforeEach(() => {
  signInCaptureOwner(OWNER, API_ORIGIN);
  mockTrustedTimeReading = () => anchoredReading(Date.now());
});
afterEach(() => {
  closeCaptureHarness();
  setFetch(undefined);
});

// ─── A1: canonicalizer parity with the Edge function ────────────────────────

describe('A1 canonical bytes mirror canonicalizeOfflineJson for every own member', () => {
  it('keeps an own "__proto__" member exactly as the Edge canonicalizer does', () => {
    // `JSON.parse` creates an OWN data property named "__proto__"; the Edge
    // canonicalizer (supabase/functions/api/canonicalDigest.ts) copies members
    // onto `Object.create(null)` and emits `{"__proto__":1,"a":2}` — VERIFIED
    // with `deno run` against that file. The mirror must produce the same bytes.
    const parsed: unknown = JSON.parse('{"a":2,"__proto__":1}');
    expect(Object.getOwnPropertyNames(parsed)).toEqual(['a', '__proto__']);
    expect(canonicalizeReleasePolicyJson(parsed)).toBe('{"__proto__":1,"a":2}');
  });

  it('never gives two different values the same canonical bytes', () => {
    const plain: unknown = JSON.parse('{"a":2}');
    const extended: unknown = JSON.parse('{"a":2,"__proto__":{"x":1}}');
    expect(canonicalizeReleasePolicyJson(extended)).not.toBe(
      canonicalizeReleasePolicyJson(plain),
    );
    expect(digestReleasePolicyJson(extended)).not.toBe(
      digestReleasePolicyJson(plain),
    );
  });

  it('does not let a "__proto__" member reach Object.prototype', () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    canonicalizeReleasePolicyJson(
      JSON.parse('{"__proto__":{"polluted":true},"a":1}'),
    );
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

// ─── A2: concurrent fetches racing a withdrawal ─────────────────────────────

describe('A2 two in-flight authority reads race a withdrawal', () => {
  it('a verified negative answer is never overwritten by an older in-flight active answer', async () => {
    const { db } = createCaptureAnalysisDb();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    // Request 1 (issued first) carries an ACTIVE policy but answers last;
    // request 2 (issued second) is the server's LATER verified statement that
    // no policy is installed and answers immediately.
    const server = scriptedServer(async (_init, index) => {
      if (index === 1) {
        await firstGate;
        return jsonResponse(authority(verifiedPolicy(), nowSeconds() - 30));
      }
      return jsonResponse(authority(null, nowSeconds()));
    });
    const first = gate(db, server);
    const second = gate(db, server);
    expect(await second).toEqual({
      status: 'ineligible',
      reasonCode: 'unverified',
    });
    expect(await cachedSlot(db)).toBeNull();
    releaseFirst();
    await first;
    // The most recent verified statement from the authority was "no policy":
    // the cache must not resurrect the withdrawn policy for offline use.
    expect(await cachedSlot(db)).toBeNull();
    expect(await gate(db, scriptedServer(offline))).toMatchObject({
      status: 'unavailable',
    });
  });

  it('a withdrawal answered by the server in between two runs is never resurrected into the cache', async () => {
    const db = createCaptureAnalysisDb();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const server = scriptedServer(async (_init, index) => {
      if (index === 1) {
        await firstGate;
        return jsonResponse(authority(verifiedPolicy(), nowSeconds() - 30));
      }
      return jsonResponse(authority(null, nowSeconds()));
    });
    const slow = seedCapture(db.db, 'attack-race-slow');
    const fast = seedCapture(db.db, 'attack-race-fast');
    setFetch(server.fetchMock);
    const slowRun = runCaptureAnalysis(slow.request);
    const fastRun = runCaptureAnalysis(fast.request);
    expectMechanicsOnlyPartial(await fastRun);
    expect(await cachedSlot(db.db)).toBeNull();
    releaseFirst();
    await slowRun;
    expect(await cachedSlot(db.db)).toBeNull();
  });
});

// ─── A3: transport failures at the policy step of the shipping path ─────────

describe('A3 transport failures on the policy read are retryable, never a verdict, never a charge', () => {
  const failures: Array<[string, PolicyAnswer]> = [
    [
      '429 with Retry-After',
      answer({ error: { code: 'rate_limited', message: 'slow down' } }, 429, {
        'retry-after': '30',
      }),
    ],
    ['500', answer({ error: { code: 'internal', message: 'boom' } }, 500)],
    ['502 without a body', answer(undefined, 502)],
    ['503 service unavailable', answer({}, 503)],
    ['302 redirect (redirect: manual)', answer(undefined, 302)],
    [
      'opaque redirect',
      () =>
        ({
          type: 'opaqueredirect',
          ok: false,
          status: 0,
          statusText: '',
          headers: { get: () => null },
          json: async () => undefined,
        }) as unknown as Response,
    ],
    [
      'answered by another URL',
      () =>
        ({
          ...jsonResponse(authority()),
          url: 'https://portal.example/login',
          redirected: true,
        }) as unknown as Response,
    ],
    [
      '200 with an unreadable body',
      () =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: { get: () => null },
          json: async () => {
            throw new SyntaxError('Unexpected token <');
          },
        }) as unknown as Response,
    ],
    ['200 with an array body', answer([authority()])],
    [
      '200 with policy: undefined',
      answer({ ...authority(), policy: undefined }),
    ],
    ['200 with a string policy', answer({ ...authority(), policy: 'null' })],
    [
      'abort mid-flight',
      () => Promise.reject(new DOMException('aborted', 'AbortError')),
    ],
  ];

  it.each(failures)(
    '%s → unavailable, no reservation, nothing cached; the held operation never publishes, a new capture scores once the authority answers',
    async (_label, policy) => {
      const db = createCaptureAnalysisDb();
      const seeded = seedCapture(db.db);
      const failing = scriptedServer(policy);
      const outcome = await run(seeded, failing);
      expect(outcome).toEqual({ kind: 'unavailable', reason: RETRY_LATER });
      expect(failing.policyRequests).toBe(1);
      expectNothingChargeable(db, failing);
      expect(await cachedSlot(db.db)).toBeNull();
      expect(db.journal).toHaveLength(1);
      expect(db.journal[0]).toMatchObject({
        permit_id: null,
        state: 'release_pending',
        release_outcome: 'failed',
      });

      // Re-running the SAME operation is held for recovery (the journal's
      // pre-existing hold/recover contract, identical on BASE_SHA for a failed
      // reserve); it must never fabricate a score or a charge.
      const healthy = scriptedServer(answer(authority()));
      const retried = await run(seeded, healthy);
      expect(retried).toMatchObject({
        kind: 'unavailable',
        cause: 'recovery_pending',
      });
      expectNothingChargeable(db, healthy);
      expect(db.journal).toHaveLength(1);

      const fresh = await runFresh(db, healthy);
      expect(fresh.kind).toBe('scored');
      expect(healthy.reserveBodies).toHaveLength(1);
      expect(db.shots).toHaveLength(1);
    },
  );

  it.each(failures)(
    '%s with a valid cached policy → the cache admits and the run scores',
    async (_label, policy) => {
      const db = createCaptureAnalysisDb();
      await writeCachedReleasePolicy(db.db, SCOPE, {
        policy: verifiedPolicy(),
        serverTime: nowSeconds(),
      });
      const before = await cachedSlot(db.db);
      const server = scriptedServer(policy);
      const outcome = await runFresh(db, server);
      expect(outcome.kind).toBe('scored');
      expect(server.reserveBodies).toHaveLength(1);
      expect(await cachedSlot(db.db)).toEqual(before);
    },
  );

  it('a 408 timeout on the policy read is unavailable and the deadline is honoured', async () => {
    jest.useFakeTimers();
    try {
      const db = createCaptureAnalysisDb();
      const server = scriptedServer(() => new Promise<Response>(() => {}));
      const pending = gate(db.db, server);
      await jest.advanceTimersByTimeAsync(20_000);
      expect(await pending).toMatchObject({
        status: 'unavailable',
        reason: 'missing',
        error: expect.objectContaining({
          status: 408,
          code: 'network.timeout',
        }),
      });
      expect(await cachedSlot(db.db)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

// ─── A4: an account switch while the policy read is in flight ───────────────

describe('A4 interleaved account switch', () => {
  it('a policy fetched for one account never authorizes or caches for the account that signed in meanwhile', async () => {
    const db = createCaptureAnalysisDb();
    const seeded = seedCapture(db.db);
    const server = scriptedServer(() => {
      // The user signs out and another account signs in while the authority
      // read is on the wire; the answer still arrives for the old request.
      signInCaptureOwner(OTHER_OWNER, API_ORIGIN);
      return jsonResponse(authority());
    });
    const outcome = await run(seeded, server);
    expect(outcome.kind).not.toBe('scored');
    expect(server.reserveBodies).toHaveLength(0);
    expect(server.finalizeBodies).toHaveLength(0);
    expect(db.shots).toHaveLength(0);
    expect(db.outbox).toHaveLength(0);
    // Whatever was cached is bound to the account that asked, never the other.
    expect(await cachedSlot(db.db, OTHER_OWNER)).toBeNull();
    expect(
      await readCachedReleasePolicy(
        db.db,
        OTHER_SCOPE,
        anchoredReading(Date.now()),
      ),
    ).toEqual({ status: 'unavailable', reason: 'missing' });
    // The other account, now offline, gets nothing from the first account's slot.
    const other = seedCapture(db.db);
    const offlineServer = scriptedServer(offline);
    expect(await run(other, offlineServer)).toEqual({
      kind: 'unavailable',
      reason: RETRY_LATER,
    });
    expect(offlineServer.reserveBodies).toHaveLength(0);
  });

  it('a verified negative for one account never evicts another account\u2019s cache', async () => {
    const { db } = createCaptureAnalysisDb();
    await writeCachedReleasePolicy(db, OTHER_SCOPE, {
      policy: verifiedPolicy(),
      serverTime: nowSeconds(),
    });
    expect(await gate(db, scriptedServer(answer(authority(null))))).toEqual({
      status: 'ineligible',
      reasonCode: 'unverified',
    });
    expect(await cachedSlot(db, OTHER_OWNER)).not.toBeNull();
  });
});

// ─── A5: clock boundaries on the cached path ────────────────────────────────

describe('A5 clock boundaries for the cached policy', () => {
  async function cachedAt(
    db: LocalDb,
    document: AnalysisReleasePolicyDocument,
    approval: Partial<AnalysisReleaseApproval>,
    fetchedAt: number,
  ) {
    await expect(
      writeCachedReleasePolicy(db, SCOPE, {
        policy: verifiedPolicy(document, approval),
        serverTime: fetchedAt,
      }),
    ).resolves.toBe(true);
  }

  it('is active one second before validUntil and expired at validUntil', async () => {
    const { db } = createCaptureAnalysisDb();
    // validUntil lies inside the cache lifetime so the window edge, not the
    // lifetime cap, decides.
    const document = documentAt(nowSeconds() - 86_400, nowSeconds() + 3_600);
    await cachedAt(db, document, {}, nowSeconds());
    expect(
      await readCachedReleasePolicy(
        db,
        SCOPE,
        anchoredReading(document.validUntil * 1000 - 1000),
      ),
    ).toMatchObject({ status: 'active' });
    expect(
      await readCachedReleasePolicy(
        db,
        SCOPE,
        anchoredReading(document.validUntil * 1000),
      ),
    ).toEqual({ status: 'unavailable', reason: 'expired' });
  });

  it('a scheduled withdrawal ends the cached authority exactly at withdrawnAt', async () => {
    const { db } = createCaptureAnalysisDb();
    const now = nowSeconds();
    const withdrawnAt = now + 3_600;
    await cachedAt(db, activeDocument(), { withdrawnAt }, now);
    expect(
      await readCachedReleasePolicy(
        db,
        SCOPE,
        anchoredReading(withdrawnAt * 1000 - 1000),
      ),
    ).toMatchObject({ status: 'active' });
    expect(
      await readCachedReleasePolicy(
        db,
        SCOPE,
        anchoredReading(withdrawnAt * 1000),
      ),
    ).toEqual({ status: 'unavailable', reason: 'expired' });
  });

  it('a record fetched in the future (clock rollback since the fetch) authorizes nothing', async () => {
    const { db } = createCaptureAnalysisDb();
    const fetchedAt = nowSeconds();
    await cachedAt(db, activeDocument(), {}, fetchedAt);
    const rolledBack =
      fetchedAt * 1000 - TRUSTED_TIME_ROLLBACK_TOLERANCE_MS - 1000;
    expect(
      await readCachedReleasePolicy(db, SCOPE, anchoredReading(rolledBack)),
    ).toEqual({ status: 'unavailable', reason: 'reconcile_required' });
    expect(
      await readCachedReleasePolicy(db, SCOPE, {
        ...anchoredReading(Date.now()),
        rollbackDetected: true,
      }),
    ).toEqual({ status: 'unavailable', reason: 'reconcile_required' });
  });

  it('a clock demoted to a floor after the app left the foreground authorizes nothing', async () => {
    const { db } = createCaptureAnalysisDb();
    await cachedAt(db, activeDocument(), {}, nowSeconds());
    // trustedTime.read() reports `floor` + `unmeasured` once the anchor's
    // elapsed time is only a lower bound, and `floor` + `persisted` from a
    // stored high-water mark alone.
    expect(
      await readCachedReleasePolicy(db, SCOPE, {
        ...anchoredReading(Date.now()),
        authority: 'floor',
        continuity: 'unmeasured',
      }),
    ).toEqual({ status: 'unavailable', reason: 'reconcile_required' });
    expect(
      await readCachedReleasePolicy(db, SCOPE, {
        ...anchoredReading(Date.now()),
        authority: 'floor',
        continuity: 'persisted',
      }),
    ).toEqual({ status: 'unavailable', reason: 'reconcile_required' });
    expect(
      await readCachedReleasePolicy(db, SCOPE, {
        ...anchoredReading(Date.now()),
        authority: 'none',
        storage: 'invalid',
      }),
    ).toEqual({ status: 'unavailable', reason: 'reconcile_required' });
  });

  it.each([
    ['NaN', Number.NaN],
    ['negative', -1],
    ['zero', 0],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['far future (year 2200)', 7_258_118_400_000],
    ['far past (1970)', 1_000],
  ])(
    'a trusted reading of %s milliseconds never yields an active cached policy',
    async (_label, nowMs) => {
      const { db } = createCaptureAnalysisDb();
      await cachedAt(db, activeDocument(), {}, nowSeconds());
      const verdict = await readCachedReleasePolicy(
        db,
        SCOPE,
        anchoredReading(nowMs),
      );
      expect(verdict.status).toBe('unavailable');
    },
  );

  it('the cache never outlives the lease maximum even when the server clock was behind', async () => {
    const { db } = createCaptureAnalysisDb();
    // The server clock was 3 days behind the device when the policy was
    // fetched; the document's window covers that instant.
    const staleServerTime = nowSeconds() - 3 * 86_400;
    await cachedAt(
      db,
      documentAt(staleServerTime - 86_400, staleServerTime + 366 * 86_400),
      {},
      staleServerTime,
    );
    expect(
      await readCachedReleasePolicy(
        db,
        SCOPE,
        anchoredReading(
          staleServerTime * 1000 + RELEASE_POLICY_CACHE_MAX_AGE_MS - 1000,
        ),
      ),
    ).toMatchObject({ status: 'active' });
    expect(
      await readCachedReleasePolicy(
        db,
        SCOPE,
        anchoredReading(
          staleServerTime * 1000 + RELEASE_POLICY_CACHE_MAX_AGE_MS,
        ),
      ),
    ).toEqual({ status: 'unavailable', reason: 'expired' });
  });
});

// ─── A6: envelope boundaries ────────────────────────────────────────────────

describe('A6 envelope serverTime boundaries', () => {
  it.each([
    ['one second before 2025', 1_735_689_599],
    ['one second after 2100', 4_102_444_801],
    ['non-integer', 1_788_000_000.5],
    ['string', '1788000000'],
    ['NaN', Number.NaN],
    ['negative', -1],
    ['zero', 0],
    ['null', null],
    ['absent', ABSENT],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 2],
  ])(
    'serverTime %s is a malformed envelope: unavailable, nothing cached, no verdict',
    async (_label, serverTime) => {
      const body = authority(verifiedPolicy(), serverTime);
      if (serverTime === ABSENT) delete body['serverTime'];
      expect(verifyReleaseAuthorityResponse(body)).toEqual({
        ok: false,
        reason: 'malformed_envelope',
      });
      const db = createCaptureAnalysisDb();
      const server = scriptedServer(answer(body));
      expect(await runFresh(db, server)).toEqual({
        kind: 'unavailable',
        reason: RETRY_LATER,
      });
      expectNothingChargeable(db, server);
      expect(await cachedSlot(db.db)).toBeNull();
    },
  );

  it('the 2025 and 2100 bounds themselves are accepted as envelope times', () => {
    const document = documentAt(1, 4_102_444_800 + 86_400);
    for (const serverTime of [1_735_689_600, 4_102_444_800]) {
      expect(
        verifyReleaseAuthorityResponse(
          authority(verifiedPolicy(document), serverTime),
        ),
      ).toMatchObject({ ok: true, serverTime });
    }
  });

  it('a policy whose document is edited after approval cannot ride an otherwise valid envelope', async () => {
    const policy = verifiedPolicy();
    const edited: VerifiedReleasePolicy = {
      ...policy,
      document: {
        ...policy.document,
        validUntil: policy.document.validUntil + 86_400 * 365,
      },
    };
    expect(verifyReleaseAuthorityResponse(authority(edited))).toEqual({
      ok: false,
      reason: 'canonical_mismatch',
    });
    const db = createCaptureAnalysisDb();
    const server = scriptedServer(answer(authority(edited)));
    expect(await runFresh(db, server)).toEqual({
      kind: 'unavailable',
      reason: RETRY_LATER,
    });
    expectNothingChargeable(db, server);
  });
});

// ─── A7: corrupt and hostile persisted records ──────────────────────────────

describe('A7 corrupt or hostile cache records', () => {
  async function seeded(db: LocalDb) {
    await writeCachedReleasePolicy(db, SCOPE, {
      policy: verifiedPolicy(),
      serverTime: nowSeconds(),
    });
    const raw = await getKv(db, releasePolicyCacheKeyForOwner(OWNER));
    if (raw === null) throw new Error('cache not written');
    return raw;
  }
  const key = releasePolicyCacheKeyForOwner(OWNER);
  const reading = () => anchoredReading(Date.now());

  it('a record exactly at the byte cap is still readable; one byte over is not', async () => {
    const { db } = createCaptureAnalysisDb();
    const raw = await seeded(db);
    const atCap = raw.padEnd(RELEASE_POLICY_CACHE_MAX_BYTES, ' ');
    await setKv(db, key, atCap);
    expect(await readCachedReleasePolicy(db, SCOPE, reading())).toMatchObject({
      status: 'active',
    });
    // Multibyte padding: fewer UTF-16 units than the cap, more UTF-8 bytes.
    const multibyte =
      raw +
      '\u20ac'.repeat(
        Math.ceil((RELEASE_POLICY_CACHE_MAX_BYTES - raw.length) / 3) + 1,
      );
    expect(multibyte.length).toBeLessThan(RELEASE_POLICY_CACHE_MAX_BYTES);
    await setKv(db, key, multibyte);
    expect(await readCachedReleasePolicy(db, SCOPE, reading())).toEqual({
      status: 'unavailable',
      reason: 'invalid',
    });
  });

  it.each([
    ['empty string', () => ''],
    ['null literal', () => 'null'],
    ['number literal', () => '1'],
    ['array', () => '[]'],
    [
      'nested array policy',
      (raw: string) => JSON.stringify({ ...JSON.parse(raw), policy: [] }),
    ],
    [
      'policy null',
      (raw: string) => JSON.stringify({ ...JSON.parse(raw), policy: null }),
    ],
    [
      'fetchedAt zero',
      (raw: string) => JSON.stringify({ ...JSON.parse(raw), fetchedAt: 0 }),
    ],
    [
      'fetchedAt negative',
      (raw: string) => JSON.stringify({ ...JSON.parse(raw), fetchedAt: -1 }),
    ],
    [
      'fetchedAt far future',
      (raw: string) =>
        JSON.stringify({ ...JSON.parse(raw), fetchedAt: 4_102_444_801 }),
    ],
    [
      'fetchedAt non-integer',
      (raw: string) =>
        JSON.stringify({ ...JSON.parse(raw), fetchedAt: 1_788_000_000.5 }),
    ],
    [
      'schema downgraded',
      (raw: string) =>
        JSON.stringify({
          ...JSON.parse(raw),
          schemaVersion: 'mobile-release-policy-cache-v0',
        }),
    ],
    [
      'binding missing',
      (raw: string) => {
        const record = JSON.parse(raw) as Record<string, unknown>;
        delete record['binding'];
        return JSON.stringify(record);
      },
    ],
    [
      'binding numeric',
      (raw: string) => JSON.stringify({ ...JSON.parse(raw), binding: 1 }),
    ],
    [
      'prototype pollution record',
      (raw: string) =>
        `{"__proto__":${raw},"schemaVersion":"mobile-release-policy-cache-v1"}`,
    ],
    [
      'approval withdrawn in the past',
      (raw: string) => {
        const record = JSON.parse(raw) as {
          policy: { approval: Record<string, unknown> };
        };
        record.policy.approval['withdrawnAt'] = 1_788_000_000;
        return JSON.stringify(record);
      },
    ],
    [
      'approval denyNewAuthorizations',
      (raw: string) => {
        const record = JSON.parse(raw) as {
          policy: { approval: Record<string, unknown> };
        };
        record.policy.approval['denyNewAuthorizations'] = true;
        return JSON.stringify(record);
      },
    ],
    [
      'approval not yet approved',
      (raw: string) => {
        const record = JSON.parse(raw) as {
          policy: { approval: Record<string, unknown> };
        };
        record.policy.approval['benchmarkApprovedAt'] = null;
        return JSON.stringify(record);
      },
    ],
    [
      'approval version renamed',
      (raw: string) => {
        const record = JSON.parse(raw) as {
          policy: { approval: { policy: Record<string, unknown> } };
        };
        record.policy.approval.policy['version'] = 'other';
        return JSON.stringify(record);
      },
    ],
  ])('%s → never an active cached policy', async (_label, corrupt) => {
    const { db } = createCaptureAnalysisDb();
    const raw = await seeded(db);
    const prototypeBefore = Object.getOwnPropertyNames(Object.prototype).sort();
    await setKv(db, key, corrupt(raw));
    const verdict = await readCachedReleasePolicy(db, SCOPE, reading());
    expect(verdict.status).toBe('unavailable');
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(
      prototypeBefore,
    );
    // The shipping path agrees: offline, nothing is reserved.
    const harness = createCaptureAnalysisDb();
    await setKv(harness.db, key, corrupt(raw));
    const server = scriptedServer(offline);
    expect(await runFresh(harness, server)).toEqual({
      kind: 'unavailable',
      reason: RETRY_LATER,
    });
    expectNothingChargeable(harness, server);
  });

  it('a record copied from another account\u2019s slot under this account\u2019s key is invisible', async () => {
    const { db } = createCaptureAnalysisDb();
    await writeCachedReleasePolicy(db, OTHER_SCOPE, {
      policy: verifiedPolicy(),
      serverTime: nowSeconds(),
    });
    const foreign = await getKv(db, releasePolicyCacheKeyForOwner(OTHER_OWNER));
    await setKv(db, key, foreign!);
    expect(await readCachedReleasePolicy(db, SCOPE, reading())).toEqual({
      status: 'unavailable',
      reason: 'missing',
    });
  });

  it('a corrupt slot is not repaired or evicted by a transport failure, and is replaced only by a verified active answer', async () => {
    const { db } = createCaptureAnalysisDb();
    await setKv(db, key, 'not json');
    expect(await gate(db, scriptedServer(offline))).toMatchObject({
      status: 'unavailable',
      reason: 'invalid',
    });
    expect(await getKv(db, key)).toBe('not json');
    expect(await gate(db, scriptedServer(answer(authority())))).toMatchObject({
      status: 'active',
      source: 'server',
    });
    expect(await cachedSlot(db)).toMatchObject({
      schemaVersion: 'mobile-release-policy-cache-v1',
    });
  });
});

// ─── A8: process death around the cache write and the eviction ─────────────

describe('A8 process death and storage faults around the cache', () => {
  it('a failed cache write never blocks the online run and never fabricates offline authority', async () => {
    const db = createCaptureAnalysisDb();
    db.failNext('INSERT OR REPLACE INTO kv');
    const server = scriptedServer(answer(authority()));
    const outcome = await runFresh(db, server);
    expect(outcome.kind).toBe('scored');
    expect(server.reserveBodies).toHaveLength(1);
    expect(await cachedSlot(db.db)).toBeNull();
    const offlineServer = scriptedServer(offline);
    expect(await runFresh(db, offlineServer)).toEqual({
      kind: 'unavailable',
      reason: RETRY_LATER,
    });
    expect(offlineServer.reserveBodies).toHaveLength(0);
  });

  it('a failed eviction still settles the run as a mechanics-only partial and never scores offline', async () => {
    const db = createCaptureAnalysisDb();
    await writeCachedReleasePolicy(db.db, SCOPE, {
      policy: verifiedPolicy(),
      serverTime: nowSeconds(),
    });
    db.failNext('DELETE FROM kv WHERE key = ?');
    const server = scriptedServer(answer(authority(null)));
    expectMechanicsOnlyPartial(await runFresh(db, server));
    expectNothingChargeable(db, server);
    // The eviction was lost (process died before the DELETE landed). Offline,
    // the stale slot may admit, but the reservation cannot happen offline, so
    // nothing numerical is ever published or charged.
    const offlineServer = scriptedServer(offline, () => {
      throw new TypeError('Network request failed');
    });
    const later = await runFresh(db, offlineServer);
    expect(later.kind).toBe('unavailable');
    expect(db.shots).toHaveLength(0);
    expect(offlineServer.finalizeBodies).toHaveLength(0);
  });

  it('a restart after a settled refusal replays the partial without a second authority read or reservation', async () => {
    const db = createCaptureAnalysisDb();
    const seeded = seedCapture(db.db);
    const server = scriptedServer(answer(authority(null)));
    expectMechanicsOnlyPartial(await run(seeded, server));
    const healthy = scriptedServer(answer(authority()));
    const replay = await run(seeded, healthy);
    expect(replay.kind).toBe('partial');
    if (replay.kind !== 'partial') throw new Error('not a partial');
    expect(replay.replayed).toBe(true);
    expect(healthy.reserveBodies).toHaveLength(0);
    expect(db.shots).toHaveLength(0);
  });
});

// ─── A9: server-side disagreement and free-rating conservation ──────────────

describe('A9 the server refuses the reservation after the client admitted the policy', () => {
  it('a 409 release_not_authorized at reserve is a mechanics-only partial, nothing chargeable, and the run is settled', async () => {
    const db = createCaptureAnalysisDb();
    const seeded = seedCapture(db.db);
    const server = scriptedServer(answer(authority()), () =>
      jsonResponse(
        {
          error: {
            code: RELEASE_NOT_AUTHORIZED_CODE,
            message: 'server says no',
          },
        },
        409,
      ),
    );
    expectMechanicsOnlyPartial(await run(seeded, server));
    expect(server.reserveBodies).toHaveLength(1);
    expect(server.finalizeBodies).toHaveLength(0);
    expect(db.shots).toHaveLength(0);
    expect(db.outbox).toHaveLength(0);
    // A retry of the same capture with a now-agreeing server replays the
    // settled partial: no second reservation, no rating counted.
    const agreeing = scriptedServer(answer(authority()));
    const replay = await run(seeded, agreeing);
    expect(replay.kind).toBe('partial');
    expect(agreeing.reserveBodies).toHaveLength(0);
  });

  it('a 429 at reserve after an admitted policy is unavailable and retryable, never a charge', async () => {
    const db = createCaptureAnalysisDb();
    const seeded = seedCapture(db.db);
    const server = scriptedServer(answer(authority()), () =>
      jsonResponse({ error: { code: 'rate_limited', message: 'later' } }, 429, {
        'retry-after': '5',
      }),
    );
    const outcome = await run(seeded, server);
    expect(outcome.kind).toBe('unavailable');
    expect(db.shots).toHaveLength(0);
    expect(db.outbox).toHaveLength(0);
    // The operation is held for recovery (pre-existing journal contract);
    // a healthy server must not turn the hold into a second reservation.
    const healthy = scriptedServer(answer(authority()));
    expect(await run(seeded, healthy)).toMatchObject({
      kind: 'unavailable',
      cause: 'recovery_pending',
    });
    expect(healthy.reserveBodies).toHaveLength(0);
    expect(db.shots).toHaveLength(0);
    expect((await runFresh(db, healthy)).kind).toBe('scored');
    expect(healthy.reserveBodies).toHaveLength(1);
    expect(db.shots).toHaveLength(1);
  });
});

// ─── A10: double submission ─────────────────────────────────────────────────

describe('A10 double submission of the same capture', () => {
  it('two concurrent runs of one capture reserve at most once and publish one shot', async () => {
    const db = createCaptureAnalysisDb();
    const seeded = seedCapture(db.db);
    const server = scriptedServer(answer(authority()));
    setFetch(server.fetchMock);
    const [first, second] = await Promise.all([
      runCaptureAnalysis(seeded.request),
      runCaptureAnalysis(seeded.request),
    ]);
    expect(server.reserveBodies.length).toBeLessThanOrEqual(1);
    expect(db.shots.length).toBeLessThanOrEqual(1);
    expect([first.kind, second.kind]).toContain('scored');
    expect(db.outbox.length).toBe(db.shots.length);
  });
});

// ─── A11: user-facing copy ──────────────────────────────────────────────────

describe('A11 copy introduced by the client follows the App Store dossier', () => {
  it('names no forbidden product, competitor, accuracy or superlative claim', () => {
    const forbidden =
      /android|google play|guest mode|live court|dupr|swingvision|pb vision|selkirk|joola|\d+\s?%|best-in-class|most accurate|ai coach/i;
    for (const file of [
      '../src/analysis/releasePolicyClient.ts',
      '../src/data/api.ts',
    ]) {
      const source = readFileSync(join(__dirname, file), 'utf8');
      const strings = source.match(/'[^'\n]*'/g) ?? [];
      for (const literal of strings) {
        expect(literal).not.toMatch(forbidden);
      }
    }
  });

  it('typed refusals carry app-owned copy, never server free text', async () => {
    const db = createCaptureAnalysisDb();
    const server = scriptedServer(
      answer({
        ...authority(null),
        message: '<script>alert(1)</script> 99% accurate AI coach',
      }),
    );
    const outcome = await runFresh(db, server);
    expectMechanicsOnlyPartial(outcome);
    expect(JSON.stringify(outcome)).not.toContain('99%');
    expect(JSON.stringify(outcome)).not.toContain('<script>');
  });

  it('an ApiError from the policy route never leaks server free text into the outcome', async () => {
    const db = createCaptureAnalysisDb();
    const server = scriptedServer(
      answer(
        {
          error: {
            code: 'internal',
            message: 'stack trace: /srv/api/index.ts:5556 token=abc',
          },
        },
        500,
      ),
    );
    const outcome = await runFresh(db, server);
    expect(outcome).toEqual({ kind: 'unavailable', reason: RETRY_LATER });
  });
});
