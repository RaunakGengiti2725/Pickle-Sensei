/**
 * W01-06 — the mobile release-policy client. `GET /v1/analysis/release-policy`
 * is fetched through the shared API client, verified exactly the way
 * `supabase/functions/api/releasePolicy.ts` verifies the stored authority
 * (RFC 8785 canonical bytes recomputed from the document, SHA-256 of those
 * bytes compared to the approval reference), cached in ONE bounded slot bound
 * to the signed-in account + API origin, and consulted by runCaptureAnalysis
 * before any permit is reserved: no verified ACTIVE policy ⇒ no reservation,
 * no numerical publication, mechanics-only partial. Offline, a cached policy
 * counts only while the trusted clock proves it is still inside its validity
 * window.
 *
 * Cross-plane vectors (canonical bytes + digests) were produced by the Edge
 * function's own `canonicalizeOfflineJson` / `digestCanonicalOfflineJson`.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type {
  AnalysisReleaseApproval,
  AnalysisReleasePolicyDocument,
} from '@pickle/shared-types';
import type { CapturedClip } from '../src/camera/capture';
import type { LocalDb } from '../src/data/db';
import { getKv, setKv } from '../src/data/repository';
import {
  ANALYSIS_RELEASE_POLICY_PATH,
  ApiError,
  createReleasePolicyClient,
} from '../src/data/api';
import type { TrustedTimeReading } from '../src/data/trustedTime';
import {
  RELEASE_NOT_AUTHORIZED_CODE,
  RELEASE_NOT_AUTHORIZED_MESSAGE,
} from '../src/analysis/partialOutcome';
import {
  RELEASE_AUTHORITY_SCHEMA_VERSION,
  RELEASE_POLICY_CACHE_KV_KEY,
  RELEASE_POLICY_CACHE_MAX_AGE_MS,
  RELEASE_POLICY_CACHE_MAX_BYTES,
  RELEASE_POLICY_MAX_CANONICAL_BYTES,
  ReleasePolicyCanonicalError,
  admitReleasePolicy,
  canonicalizeReleasePolicyJson,
  clearCachedReleasePolicy,
  digestReleasePolicyJson,
  readCachedReleasePolicy,
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

// The gate reads the app's trusted clock. Jest observes no AppState lifecycle,
// so the real singleton can never be `anchored`; the reading is scripted per
// test and every other trusted-time behaviour stays real.
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

const OWNER = '44444444-4444-4444-8444-444444444444';
const OTHER_OWNER = '55555555-5555-4555-8555-555555555555';
const API_ORIGIN = 'https://api.test';
const SCOPE = { ownerKey: OWNER, apiOrigin: API_ORIGIN };

/** 2026-08-29T13:20:00Z — a fixed issue instant so the digest vector holds. */
const VALID_FROM = 1_788_000_000;
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
const FIXTURE_DOCUMENT: AnalysisReleasePolicyDocument = {
  schemaVersion: 'analysis-release-policy-v1',
  version: 'mobile-fixture-policy-1',
  validFrom: VALID_FROM,
  validUntil: VALID_FROM + 365 * 86_400,
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
    {
      shotType: 'dink',
      cameraView: 'side',
      handedness: 'right',
      captureMode: 'imported_video',
    },
  ],
};
/** `digestCanonicalOfflineJson(FIXTURE_DOCUMENT)` on the Edge function. */
const FIXTURE_DIGEST =
  '0ded0fac0b982f065b9356d1040eaee1683aafd47b4abc65526b6ab9ab0ade89';

/** Key order, number formatting and string escaping vector; the canonical
 * form and digest below are the Edge function's output for this value. */
const CANONICAL_VECTOR = {
  z: [
    1,
    1e21,
    1.0,
    -0,
    0.000001,
    1e-7,
    '\u00e9\u2028\n"\\\u0001',
    true,
    null,
    {},
    [],
  ],
  a: { '\u00df': 'x', B: 2, b: 3, '\u20ac': 4, '\ud83d\ude00': 5 },
};
const CANONICAL_VECTOR_BYTES =
  '{"a":{"B":2,"b":3,"\u00df":"x","\u20ac":4,"\ud83d\ude00":5},"z":[1,1e+21,1,0,0.000001,1e-7,"\u00e9\u2028\\n\\"\\\\\\u0001",true,null,{},[]]}';
const CANONICAL_VECTOR_DIGEST =
  '353f0ee7d2ca83cb3f1b48e79e838414eeadae525aa688b13557608a4fd6be57';

const nowSeconds = () => Math.floor(Date.now() / 1000);

function approvalFor(
  document: AnalysisReleasePolicyDocument,
  overrides: Partial<AnalysisReleaseApproval> = {},
): AnalysisReleaseApproval {
  return {
    policy: {
      version: document.version,
      sha256: digestReleasePolicyJson(document),
    },
    mechanicsApprovedAt: document.validFrom,
    benchmarkApprovedAt: document.validFrom,
    withdrawnAt: null,
    denyNewAuthorizations: false,
    ...overrides,
  };
}

function verifiedPolicy(
  document: AnalysisReleasePolicyDocument = FIXTURE_DOCUMENT,
  approval: Partial<AnalysisReleaseApproval> = {},
): VerifiedReleasePolicy {
  return {
    document,
    canonicalDocument: canonicalizeReleasePolicyJson(document),
    approval: approvalFor(document, approval),
  };
}

interface AuthorityEnvelope {
  schemaVersion: string;
  serverTime: number;
  policy: unknown;
}

/** The route's 200 body for an installed policy (or `policy: null`). */
function authority(
  policy: VerifiedReleasePolicy | null = verifiedPolicy(),
  serverTime = nowSeconds(),
): AuthorityEnvelope {
  return {
    schemaVersion: RELEASE_AUTHORITY_SCHEMA_VERSION,
    serverTime,
    policy,
  };
}

function withdrawnAuthority(): AuthorityEnvelope {
  return authority(
    verifiedPolicy(FIXTURE_DOCUMENT, {
      withdrawnAt: nowSeconds() - 60,
      denyNewAuthorizations: true,
    }),
  );
}

function expiredAuthority(): AuthorityEnvelope {
  const now = nowSeconds();
  return authority(
    verifiedPolicy({
      ...FIXTURE_DOCUMENT,
      validFrom: now - 7_200,
      validUntil: now - 3_600,
    }),
  );
}

/** One canonical byte changed after the digest was taken. */
function tamperedBytesAuthority(): AuthorityEnvelope {
  const policy = verifiedPolicy();
  return authority({
    ...policy,
    canonicalDocument: policy.canonicalDocument.replace(
      '"boundaryStep":0.25',
      '"boundaryStep":0.26',
    ),
  });
}

/** The document and its bytes agree; the approval digest names other bytes. */
function tamperedDigestAuthority(): AuthorityEnvelope {
  const policy = verifiedPolicy();
  return authority({
    ...policy,
    approval: {
      ...policy.approval,
      policy: { ...policy.approval.policy, sha256: 'b'.repeat(64) },
    },
  });
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

function floorReading(nowMs: number): TrustedTimeReading {
  return {
    authority: 'floor',
    continuity: 'unmeasured',
    nowMs,
    wallClockMs: nowMs,
    rollbackDetected: false,
    storage: 'loaded',
  };
}

const NO_TRUSTED_TIME: TrustedTimeReading = {
  authority: 'none',
  continuity: 'none',
  nowMs: Date.now(),
  wallClockMs: Date.now(),
  rollbackDetected: false,
  storage: 'empty',
};

// ─── scripted HTTP ──────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

type PolicyRoute =
  { kind: 'body'; body: unknown; status?: number } | { kind: 'offline' };

interface ScriptedServer {
  fetchMock: jest.Mock;
  policyRequests: Array<{ url: string; init: RequestInit | undefined }>;
  reserveBodies: unknown[];
  finalizeBodies: unknown[];
  /** Every URL in call order — proves the gate runs before the reservation. */
  urls: string[];
}

function scriptedServer(policy: PolicyRoute): ScriptedServer {
  const policyRequests: ScriptedServer['policyRequests'] = [];
  const reserveBodies: unknown[] = [];
  const finalizeBodies: unknown[] = [];
  const urls: string[] = [];
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    urls.push(url);
    if (url.endsWith(ANALYSIS_RELEASE_POLICY_PATH)) {
      policyRequests.push({ url, init });
      if (policy.kind === 'offline')
        throw new TypeError('Network request failed');
      return jsonResponse(policy.body, policy.status ?? 200);
    }
    if (url.endsWith('/v1/analysis-permits')) {
      reserveBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({
        permit: {
          id: fixtureUuid(`permit:${reserveBodies.length}`),
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
      });
    }
    if (url.includes('/finalize')) {
      const body: unknown = JSON.parse(String(init?.body));
      finalizeBodies.push(body);
      return jsonResponse(finalizeAcknowledgement(url, body));
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { fetchMock, policyRequests, reserveBodies, finalizeBodies, urls };
}

function setFetch(fetchMock: unknown) {
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
}

// ─── capture fixture (real pipeline over the canonical synthetic swing) ─────

function swingClipWithSidecar(): { clip: CapturedClip; sidecarJson: string } {
  const { sequence, window } = generateSwingSequence({});
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///captures/release-policy.mov',
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
      uri: 'file:///captures/release-policy.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
  return { clip, sidecarJson };
}

let captureSerial = 0;
function captureRequest(db: LocalDb, clip: CapturedClip) {
  captureSerial += 1;
  return {
    db,
    ...seedCaptureRequest(db, clip, `release-policy-${captureSerial}`),
    clip,
    declaredStroke: 'forehand_drive' as const,
    declaredCanonical: 'FOREHAND_DRIVE' as const,
    handedness: 'right' as const,
    cameraView: 'side' as const,
    apiConfig: { baseUrl: API_ORIGIN, token: 'token-release-policy' },
    appVersion: '0.1.0',
  };
}

async function runOnce(
  db: ReturnType<typeof createCaptureAnalysisDb>,
  server: ScriptedServer,
) {
  const { clip, sidecarJson } = swingClipWithSidecar();
  mockReadArtifact = async () => sidecarJson;
  setFetch(server.fetchMock);
  return runCaptureAnalysis(captureRequest(db.db, clip));
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

/** No reservation, no chargeable product, nothing queued for sync. */
function expectNothingChargeable(
  db: ReturnType<typeof createCaptureAnalysisDb>,
  server: ScriptedServer,
) {
  expect(server.reserveBodies).toHaveLength(0);
  expect(server.finalizeBodies).toHaveLength(0);
  expect(db.shots).toHaveLength(0);
  expect(db.outbox).toHaveLength(0);
}

async function cachedSlot(db: LocalDb) {
  const raw = await getKv(db, RELEASE_POLICY_CACHE_KV_KEY);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

beforeEach(() => {
  signInCaptureOwner(OWNER, API_ORIGIN);
  mockTrustedTimeReading = () => anchoredReading(Date.now());
});
afterEach(() => {
  closeCaptureHarness();
  setFetch(undefined);
});

// ─── canonical bytes + digest mirror releasePolicy.ts ───────────────────────

describe('canonical bytes and SHA-256 mirror the Edge function', () => {
  it('reproduces the Edge digest of the fixture policy document', () => {
    const canonical = canonicalizeReleasePolicyJson(FIXTURE_DOCUMENT);
    expect(canonical.startsWith('{"benchmark":{"boundaryStep":0.25,')).toBe(
      true,
    );
    expect(
      canonical.endsWith(
        '"validFrom":1788000000,"validUntil":1819536000,"version":"mobile-fixture-policy-1"}',
      ),
    ).toBe(true);
    expect(sha256Hex(canonical)).toBe(FIXTURE_DIGEST);
    expect(digestReleasePolicyJson(FIXTURE_DOCUMENT)).toBe(FIXTURE_DIGEST);
  });

  it('sorts members by UTF-16 code units and formats numbers/strings like RFC 8785', () => {
    expect(canonicalizeReleasePolicyJson(CANONICAL_VECTOR)).toBe(
      CANONICAL_VECTOR_BYTES,
    );
    expect(digestReleasePolicyJson(CANONICAL_VECTOR)).toBe(
      CANONICAL_VECTOR_DIGEST,
    );
  });

  it('rejects values the Edge canonicalizer rejects instead of guessing bytes', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const cases: unknown[] = [
      { a: undefined },
      [undefined],
      { a: NaN },
      { a: Infinity },
      { a: new Date(0) },
      { a: () => 1 },
      { a: Symbol('s') },
      { a: 10n },
      cyclic,
      new Map(),
      undefined,
    ];
    for (const value of cases) {
      expect(() => canonicalizeReleasePolicyJson(value)).toThrow(
        ReleasePolicyCanonicalError,
      );
    }
    const deep: unknown[] = [];
    let cursor = deep;
    for (let depth = 0; depth < 70; depth += 1) {
      const next: unknown[] = [];
      cursor.push(next);
      cursor = next;
    }
    expect(() => canonicalizeReleasePolicyJson(deep)).toThrow(
      ReleasePolicyCanonicalError,
    );
  });
});

// ─── response verification ──────────────────────────────────────────────────

describe('verifyReleaseAuthorityResponse', () => {
  it('accepts a consistent envelope and an explicit no-policy answer', () => {
    const verified = verifyReleaseAuthorityResponse(authority());
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.policy?.document).toEqual(FIXTURE_DOCUMENT);
    expect(verified.policy?.approval.policy.sha256).toBe(FIXTURE_DIGEST);

    const none = verifyReleaseAuthorityResponse(authority(null));
    expect(none).toEqual({
      ok: true,
      policy: null,
      serverTime: expect.any(Number),
    });
  });

  it('rejects tampered canonical bytes', () => {
    expect(verifyReleaseAuthorityResponse(tamperedBytesAuthority())).toEqual({
      ok: false,
      reason: 'canonical_mismatch',
    });
  });

  it('rejects a digest that does not match the canonical bytes', () => {
    expect(verifyReleaseAuthorityResponse(tamperedDigestAuthority())).toEqual({
      ok: false,
      reason: 'digest_mismatch',
    });
  });

  it('rejects a document edited after approval and a version mismatch', () => {
    const policy = verifiedPolicy();
    const extended = authority({
      ...policy,
      document: {
        ...policy.document,
        validUntil: policy.document.validUntil + 86_400,
      },
    });
    expect(verifyReleaseAuthorityResponse(extended)).toEqual({
      ok: false,
      reason: 'canonical_mismatch',
    });
    const renamed = authority({
      ...policy,
      approval: {
        ...policy.approval,
        policy: { ...policy.approval.policy, version: 'someone-else' },
      },
    });
    expect(verifyReleaseAuthorityResponse(renamed)).toEqual({
      ok: false,
      reason: 'version_mismatch',
    });
  });

  it('rejects malformed envelopes and policies', () => {
    const base = authority();
    const rejected = (body: unknown) => verifyReleaseAuthorityResponse(body);
    expect(rejected(null).ok).toBe(false);
    expect(rejected('{}').ok).toBe(false);
    expect(
      rejected({ ...base, schemaVersion: 'analysis-release-authority-v2' }).ok,
    ).toBe(false);
    expect(rejected({ ...base, serverTime: '1788000000' }).ok).toBe(false);
    expect(rejected({ ...base, serverTime: 1.5 }).ok).toBe(false);
    expect(
      rejected({ schemaVersion: base.schemaVersion, policy: base.policy }).ok,
    ).toBe(false);
    expect(rejected({ ...base, policy: undefined }).ok).toBe(false);
    expect(rejected({ ...base, policy: 'installed' }).ok).toBe(false);
    expect(
      rejected({ ...base, policy: { document: FIXTURE_DOCUMENT } }).ok,
    ).toBe(false);
    const policy = verifiedPolicy();
    expect(
      rejected(
        authority({
          ...policy,
          approval: {
            ...policy.approval,
            withdrawnAt: 'never',
          } as unknown as AnalysisReleaseApproval,
        }),
      ).ok,
    ).toBe(false);
    expect(
      rejected(
        authority({
          ...policy,
          document: {
            ...policy.document,
            extra: true,
          } as unknown as AnalysisReleasePolicyDocument,
        }),
      ).ok,
    ).toBe(false);
    const oversized = {
      ...policy,
      canonicalDocument: policy.canonicalDocument.padEnd(
        RELEASE_POLICY_MAX_CANONICAL_BYTES + 1,
        ' ',
      ),
    };
    expect(rejected(authority(oversized))).toEqual({
      ok: false,
      reason: 'canonical_too_large',
    });
  });
});

// ─── admission mirrors admitChargeableRelease ───────────────────────────────

describe('admitReleasePolicy', () => {
  const now = nowSeconds();

  it('admits an approved, non-withdrawn policy inside its window', () => {
    expect(admitReleasePolicy(verifiedPolicy(), now)).toEqual({
      status: 'active',
      policy: expect.objectContaining({ document: FIXTURE_DOCUMENT }),
    });
    expect(
      admitReleasePolicy(
        verifiedPolicy(FIXTURE_DOCUMENT, { withdrawnAt: now + 3_600 }),
        now,
      ).status,
    ).toBe('active');
  });

  it('refuses no policy, withdrawn, denied, expired and unreleased policies', () => {
    expect(admitReleasePolicy(null, now)).toEqual({
      status: 'ineligible',
      reasonCode: 'unverified',
    });
    expect(
      admitReleasePolicy(
        verifiedPolicy(FIXTURE_DOCUMENT, { withdrawnAt: now - 1 }),
        now,
      ),
    ).toEqual({ status: 'ineligible', reasonCode: 'withdrawn' });
    expect(
      admitReleasePolicy(
        verifiedPolicy(FIXTURE_DOCUMENT, { denyNewAuthorizations: true }),
        now,
      ),
    ).toEqual({ status: 'ineligible', reasonCode: 'withdrawn' });
    expect(
      admitReleasePolicy(
        verifiedPolicy({
          ...FIXTURE_DOCUMENT,
          validFrom: now - 7_200,
          validUntil: now - 3_600,
        }),
        now,
      ),
    ).toEqual({ status: 'ineligible', reasonCode: 'expired' });
    expect(
      admitReleasePolicy(
        verifiedPolicy({
          ...FIXTURE_DOCUMENT,
          validFrom: now + 3_600,
          validUntil: now + 7_200,
        }),
        now,
      ),
    ).toEqual({ status: 'ineligible', reasonCode: 'unreleased' });
    expect(
      admitReleasePolicy(
        verifiedPolicy(FIXTURE_DOCUMENT, { benchmarkApprovedAt: null }),
        now,
      ),
    ).toEqual({ status: 'ineligible', reasonCode: 'unreleased' });
  });
});

// ─── transport client (api.ts) ──────────────────────────────────────────────

describe('createReleasePolicyClient', () => {
  it('GETs /v1/analysis/release-policy with the bearer and returns the raw body', async () => {
    const server = scriptedServer({ kind: 'body', body: authority() });
    setFetch(server.fetchMock);
    const client = createReleasePolicyClient({
      baseUrl: API_ORIGIN,
      token: 'bearer-1',
    });
    const body = await client.read();
    expect(server.policyRequests).toHaveLength(1);
    const { url, init } = server.policyRequests[0]!;
    expect(url).toBe(`${API_ORIGIN}${ANALYSIS_RELEASE_POLICY_PATH}`);
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(
      (init?.headers as Record<string, string> | undefined)?.['authorization'],
    ).toBe('Bearer bearer-1');
    expect(verifyReleaseAuthorityResponse(body).ok).toBe(true);
  });

  it('refuses to ask without a signed-in bearer and never touches the network', async () => {
    const server = scriptedServer({ kind: 'body', body: authority() });
    setFetch(server.fetchMock);
    const client = createReleasePolicyClient({
      baseUrl: API_ORIGIN,
      token: null,
    });
    await expect(client.read()).rejects.toMatchObject({
      status: 401,
      code: 'auth.required',
    });
    expect(server.fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces HTTP failures as ApiError without inventing a policy', async () => {
    const server = scriptedServer({
      kind: 'body',
      body: { error: { code: 'service.unavailable', message: 'later' } },
      status: 503,
    });
    setFetch(server.fetchMock);
    const client = createReleasePolicyClient({
      baseUrl: API_ORIGIN,
      token: 'bearer-1',
    });
    await expect(client.read()).rejects.toBeInstanceOf(ApiError);
  });
});

// ─── bounded, owner-bound cache ─────────────────────────────────────────────

describe('release-policy cache', () => {
  it('stores only a verified policy and reads it back for the same account + origin', async () => {
    const { db } = createCaptureAnalysisDb();
    const fetchedAt = nowSeconds();
    await expect(
      writeCachedReleasePolicy(db, SCOPE, {
        policy: verifiedPolicy(),
        serverTime: fetchedAt,
      }),
    ).resolves.toBe(true);
    const slot = await cachedSlot(db);
    expect(slot).not.toBeNull();
    expect(JSON.stringify(slot)).not.toContain(OWNER);
    expect(slot?.['fetchedAt']).toBe(fetchedAt);

    const same = await readCachedReleasePolicy(
      db,
      SCOPE,
      anchoredReading(Date.now()),
    );
    expect(same.status).toBe('active');
    if (same.status !== 'active') return;
    expect(same.policy.document).toEqual(FIXTURE_DOCUMENT);
    expect(same.policy.approval.policy.sha256).toBe(FIXTURE_DIGEST);
  });

  it('is invisible to another account and to another API origin', async () => {
    const { db } = createCaptureAnalysisDb();
    await writeCachedReleasePolicy(db, SCOPE, {
      policy: verifiedPolicy(),
      serverTime: nowSeconds(),
    });
    const reading = anchoredReading(Date.now());
    expect(
      await readCachedReleasePolicy(
        db,
        { ownerKey: OTHER_OWNER, apiOrigin: API_ORIGIN },
        reading,
      ),
    ).toEqual({ status: 'unavailable', reason: 'missing' });
    expect(
      await readCachedReleasePolicy(
        db,
        { ownerKey: OWNER, apiOrigin: 'https://other.test' },
        reading,
      ),
    ).toEqual({ status: 'unavailable', reason: 'missing' });
    expect(await readCachedReleasePolicy(db, SCOPE, reading)).toMatchObject({
      status: 'active',
    });
  });

  it('never turns tampered or malformed stored bytes into authorization', async () => {
    const { db } = createCaptureAnalysisDb();
    await writeCachedReleasePolicy(db, SCOPE, {
      policy: verifiedPolicy(),
      serverTime: nowSeconds(),
    });
    const raw = await getKv(db, RELEASE_POLICY_CACHE_KV_KEY);
    expect(raw).not.toBeNull();
    const reading = anchoredReading(Date.now());
    for (const corrupt of [
      raw!.replace('"boundaryStep":0.25', '"boundaryStep":0.26'),
      raw!.replace(FIXTURE_DIGEST, 'b'.repeat(64)),
      raw!.slice(0, -5),
      'not json',
      '[]',
      JSON.stringify({ ...JSON.parse(raw!), fetchedAt: 'yesterday' }),
      raw!.padEnd(RELEASE_POLICY_CACHE_MAX_BYTES + 1, ' '),
    ]) {
      await setKv(db, RELEASE_POLICY_CACHE_KV_KEY, corrupt);
      expect(await readCachedReleasePolicy(db, SCOPE, reading)).toEqual({
        status: 'unavailable',
        reason: 'invalid',
      });
    }
  });

  it('grants nothing outside the policy window, past the cache lifetime or without a trusted anchored clock', async () => {
    const { db } = createCaptureAnalysisDb();
    const fetchedAt = nowSeconds();
    await writeCachedReleasePolicy(db, SCOPE, {
      policy: verifiedPolicy(),
      serverTime: fetchedAt,
    });
    expect(
      await readCachedReleasePolicy(
        db,
        SCOPE,
        anchoredReading(FIXTURE_DOCUMENT.validUntil * 1000),
      ),
    ).toEqual({ status: 'unavailable', reason: 'expired' });
    expect(
      await readCachedReleasePolicy(
        db,
        SCOPE,
        anchoredReading(fetchedAt * 1000 + RELEASE_POLICY_CACHE_MAX_AGE_MS),
      ),
    ).toEqual({ status: 'unavailable', reason: 'expired' });
    expect(
      await readCachedReleasePolicy(db, SCOPE, floorReading(Date.now())),
    ).toEqual({ status: 'unavailable', reason: 'reconcile_required' });
    expect(await readCachedReleasePolicy(db, SCOPE, NO_TRUSTED_TIME)).toEqual({
      status: 'unavailable',
      reason: 'reconcile_required',
    });
    expect(
      await readCachedReleasePolicy(db, SCOPE, {
        ...anchoredReading(Date.now()),
        rollbackDetected: true,
      }),
    ).toEqual({ status: 'unavailable', reason: 'reconcile_required' });
  });

  it('refuses to store an ineligible or oversized policy and clears on demand', async () => {
    const { db } = createCaptureAnalysisDb();
    const now = nowSeconds();
    await expect(
      writeCachedReleasePolicy(db, SCOPE, {
        policy: verifiedPolicy(FIXTURE_DOCUMENT, { withdrawnAt: now - 1 }),
        serverTime: now,
      }),
    ).resolves.toBe(false);
    const policy = verifiedPolicy();
    await expect(
      writeCachedReleasePolicy(db, SCOPE, {
        policy: {
          ...policy,
          canonicalDocument: policy.canonicalDocument.padEnd(
            RELEASE_POLICY_MAX_CANONICAL_BYTES + 1,
            ' ',
          ),
        },
        serverTime: now,
      }),
    ).resolves.toBe(false);
    expect(await cachedSlot(db)).toBeNull();

    await writeCachedReleasePolicy(db, SCOPE, { policy, serverTime: now });
    expect(await cachedSlot(db)).not.toBeNull();
    await clearCachedReleasePolicy(db);
    expect(await cachedSlot(db)).toBeNull();
    expect(
      await readCachedReleasePolicy(db, SCOPE, anchoredReading(Date.now())),
    ).toEqual({ status: 'unavailable', reason: 'missing' });
  });
});

// ─── resolveReleaseAuthority: server first, verified cache offline ──────────

describe('resolveReleaseAuthority', () => {
  function gate(db: LocalDb, server: ScriptedServer) {
    setFetch(server.fetchMock);
    return resolveReleaseAuthority({
      db,
      scope: SCOPE,
      client: createReleasePolicyClient({
        baseUrl: API_ORIGIN,
        token: 'bearer-1',
      }),
    });
  }

  it('a verified active answer is admitted and cached', async () => {
    const { db } = createCaptureAnalysisDb();
    const admission = await gate(
      db,
      scriptedServer({ kind: 'body', body: authority() }),
    );
    expect(admission).toMatchObject({ status: 'active', source: 'server' });
    expect(await cachedSlot(db)).not.toBeNull();
  });

  it('a verified negative answer is ineligible and evicts an older cached policy', async () => {
    const { db } = createCaptureAnalysisDb();
    await writeCachedReleasePolicy(db, SCOPE, {
      policy: verifiedPolicy(),
      serverTime: nowSeconds(),
    });
    expect(
      await gate(db, scriptedServer({ kind: 'body', body: authority(null) })),
    ).toEqual({ status: 'ineligible', reasonCode: 'unverified' });
    expect(await cachedSlot(db)).toBeNull();

    await writeCachedReleasePolicy(db, SCOPE, {
      policy: verifiedPolicy(),
      serverTime: nowSeconds(),
    });
    expect(
      await gate(
        db,
        scriptedServer({ kind: 'body', body: withdrawnAuthority() }),
      ),
    ).toEqual({ status: 'ineligible', reasonCode: 'withdrawn' });
    expect(await cachedSlot(db)).toBeNull();
    expect(
      await gate(
        db,
        scriptedServer({ kind: 'body', body: expiredAuthority() }),
      ),
    ).toEqual({ status: 'ineligible', reasonCode: 'expired' });
  });

  it('a tampered answer is ineligible and leaves a valid cache untouched', async () => {
    const { db } = createCaptureAnalysisDb();
    await writeCachedReleasePolicy(db, SCOPE, {
      policy: verifiedPolicy(),
      serverTime: nowSeconds(),
    });
    const before = await cachedSlot(db);
    expect(
      await gate(
        db,
        scriptedServer({ kind: 'body', body: tamperedBytesAuthority() }),
      ),
    ).toEqual({ status: 'ineligible', reasonCode: 'unverified' });
    expect(
      await gate(
        db,
        scriptedServer({ kind: 'body', body: tamperedDigestAuthority() }),
      ),
    ).toEqual({ status: 'ineligible', reasonCode: 'unverified' });
    expect(await cachedSlot(db)).toEqual(before);
  });

  it('offline falls back to the cached policy only while the trusted clock proves it valid', async () => {
    const { db } = createCaptureAnalysisDb();
    expect(await gate(db, scriptedServer({ kind: 'offline' }))).toMatchObject({
      status: 'unavailable',
      reason: 'missing',
    });
    await writeCachedReleasePolicy(db, SCOPE, {
      policy: verifiedPolicy(),
      serverTime: nowSeconds(),
    });
    expect(await gate(db, scriptedServer({ kind: 'offline' }))).toMatchObject({
      status: 'active',
      source: 'cache',
    });
    mockTrustedTimeReading = () => floorReading(Date.now());
    expect(await gate(db, scriptedServer({ kind: 'offline' }))).toMatchObject({
      status: 'unavailable',
      reason: 'reconcile_required',
    });
    mockTrustedTimeReading = () =>
      anchoredReading(FIXTURE_DOCUMENT.validUntil * 1000 + 1);
    expect(await gate(db, scriptedServer({ kind: 'offline' }))).toMatchObject({
      status: 'unavailable',
      reason: 'expired',
    });
  });

  it('an HTTP failure is unavailable, not a verdict, and keeps the cache', async () => {
    const { db } = createCaptureAnalysisDb();
    await writeCachedReleasePolicy(db, SCOPE, {
      policy: verifiedPolicy(),
      serverTime: nowSeconds(),
    });
    const server = scriptedServer({
      kind: 'body',
      body: { error: { code: 'service.unavailable', message: 'later' } },
      status: 503,
    });
    expect(await gate(db, server)).toMatchObject({
      status: 'active',
      source: 'cache',
    });
  });
});

// ─── the shipping path: runCaptureAnalysis ──────────────────────────────────

describe('runCaptureAnalysis gates numerical publication on an active policy', () => {
  it('an active policy is verified before the reservation and the run scores', async () => {
    const db = createCaptureAnalysisDb();
    const server = scriptedServer({ kind: 'body', body: authority() });
    const outcome = await runOnce(db, server);
    expect(outcome.kind).toBe('scored');
    expect(server.policyRequests).toHaveLength(1);
    expect(server.reserveBodies).toHaveLength(1);
    expect(
      server.urls.indexOf(`${API_ORIGIN}${ANALYSIS_RELEASE_POLICY_PATH}`),
    ).toBeLessThan(server.urls.indexOf(`${API_ORIGIN}/v1/analysis-permits`));
    expect(db.shots).toHaveLength(1);
    expect(db.outbox).toHaveLength(1);
    expect(await cachedSlot(db.db)).not.toBeNull();
  });

  it.each([
    ['no installed policy', () => authority(null)],
    ['withdrawn policy', withdrawnAuthority],
    ['expired policy', expiredAuthority],
    ['tampered canonical bytes', tamperedBytesAuthority],
    ['tampered digest', tamperedDigestAuthority],
    [
      'malformed policy',
      () => ({ ...authority(), policy: { document: FIXTURE_DOCUMENT } }),
    ],
  ])(
    '%s → mechanics-only partial, no reservation, nothing chargeable',
    async (_label, body) => {
      const db = createCaptureAnalysisDb();
      const server = scriptedServer({ kind: 'body', body: body() });
      const outcome = await runOnce(db, server);
      expectMechanicsOnlyPartial(outcome);
      expect(server.policyRequests).toHaveLength(1);
      expectNothingChargeable(db, server);
      expect(await cachedSlot(db.db)).toBeNull();
    },
  );

  it('offline with a cached policy inside its window still reaches the reservation', async () => {
    const db = createCaptureAnalysisDb();
    await writeCachedReleasePolicy(db.db, SCOPE, {
      policy: verifiedPolicy(),
      serverTime: nowSeconds(),
    });
    const server = scriptedServer({ kind: 'offline' });
    const outcome = await runOnce(db, server);
    expect(outcome.kind).toBe('scored');
    expect(server.policyRequests).toHaveLength(1);
    expect(server.reserveBodies).toHaveLength(1);
  });

  it('offline without a usable cached policy is unavailable: no reservation, no partial verdict, retry later', async () => {
    const db = createCaptureAnalysisDb();
    const server = scriptedServer({ kind: 'offline' });
    const outcome = await runOnce(db, server);
    expect(outcome.kind).toBe('unavailable');
    expectNothingChargeable(db, server);

    await writeCachedReleasePolicy(db.db, SCOPE, {
      policy: verifiedPolicy(),
      serverTime: nowSeconds(),
    });
    mockTrustedTimeReading = () => floorReading(Date.now());
    const untrusted = await runOnce(db, scriptedServer({ kind: 'offline' }));
    expect(untrusted.kind).toBe('unavailable');
    expect(db.shots).toHaveLength(0);
  });

  it('a cached policy belongs to the account that fetched it', async () => {
    const db = createCaptureAnalysisDb();
    await runOnce(db, scriptedServer({ kind: 'body', body: authority() }));
    expect(await cachedSlot(db.db)).not.toBeNull();

    closeCaptureHarness();
    signInCaptureOwner(OTHER_OWNER, API_ORIGIN);
    const other = createCaptureAnalysisDb();
    const raw = await getKv(db.db, RELEASE_POLICY_CACHE_KV_KEY);
    await setKv(other.db, RELEASE_POLICY_CACHE_KV_KEY, raw!);
    const server = scriptedServer({ kind: 'offline' });
    const outcome = await runOnce(other, server);
    expect(outcome.kind).toBe('unavailable');
    expectNothingChargeable(other, server);
  });

  it('a verified withdrawal evicts the cache so a later offline run is not scored', async () => {
    const db = createCaptureAnalysisDb();
    expect(
      (await runOnce(db, scriptedServer({ kind: 'body', body: authority() })))
        .kind,
    ).toBe('scored');
    expectMechanicsOnlyPartial(
      await runOnce(
        db,
        scriptedServer({ kind: 'body', body: withdrawnAuthority() }),
      ),
    );
    expect(await cachedSlot(db.db)).toBeNull();
    const offline = scriptedServer({ kind: 'offline' });
    expect((await runOnce(db, offline)).kind).toBe('unavailable');
    expect(offline.reserveBodies).toHaveLength(0);
  });
});
