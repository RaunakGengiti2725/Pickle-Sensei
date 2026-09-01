/**
 * billing-entitlement-sync audit — client-side characterization.
 *
 * Pins the CURRENT behaviour of the RevenueCat client → accessApi →
 * accessStore → analyze path so the audit findings are reproducible:
 *
 *  1. legacy 'premium' alias: both the RevenueCat client and the access parser
 *     honor the alias; the parser REQUIRES the server to spell the entitlement
 *     as 'premium' (the Edge Function always prepends it).
 *  2. a 401 from the backend (the app's bearer is a provider ID token with no
 *     refresh path) is surfaced as a NON-retryable backend failure; after a
 *     completed StoreKit purchase this leaves canonicalAccess null so the gate
 *     denies and Restore/Retry fail the same way.
 *  3. accessStore never re-reads access on its own: once the server says both
 *     free ratings are used, the cached snapshot keeps canStartRating=true
 *     until something calls refreshAccess()/initialize() (nothing in the app
 *     does after a rating).
 *  4. runCaptureAnalysis maps a 402 access.paywall_required reserve rejection
 *     to a generic 'unavailable' outcome — indistinguishable from an outage,
 *     so AnalyzeScreen renders "Nothing was rated. / Try again" instead of
 *     routing to the paywall.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { LocalDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import type { CapturedClip } from '../../src/camera/capture';
import { runCaptureAnalysis } from '../../src/analysis/runCaptureAnalysis';
import {
  createCanonicalAccessClient,
  createRevenueCatBillingClient,
  type BillingAccessDependencies,
  type CanonicalAccessState,
  type StorePlans,
} from '../../src/billing';
import type { RevenueCatSdk } from '../../src/billing/revenueCatClient';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  selectCanStartRating,
  selectHasPremium,
  selectPaywallRequired,
  useAccessStore,
} from '../../src/state/accessStore';

jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};

const CANONICAL_USER = '11111111-1111-4111-8111-111111111111';

function access(
  used: 0 | 1 | 2,
  reserved = 0,
  premium = false,
): CanonicalAccessState {
  const remaining = 2 - used;
  const availableToReserve = remaining - reserved;
  const canStartRating = premium || availableToReserve > 0;
  return {
    premium,
    entitlements: premium ? ['premium', 'pickle_sensei_pro'] : [],
    freeRatings: { limit: 2, used, reserved, remaining, availableToReserve },
    canStartRating,
    paywallRequired: !canStartRating,
  };
}

const plans: StorePlans = {
  offeringId: 'default',
  annual: {
    id: 'default:annual:$rc_annual:pickle_sensei_pro_annual',
    productId: 'pickle_sensei_pro_annual',
    period: 'annual',
    price: 59.99,
    priceString: '$59.99',
    pricePerMonthString: '$5.00',
    freeTrial: null,
  },
  monthly: null,
  lifetime: null,
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  } as unknown as Response;
}

function dependencies(overrides: {
  getAccess: () => Promise<CanonicalAccessState>;
  syncBilling: BillingAccessDependencies['backend']['syncBilling'];
}): BillingAccessDependencies {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => plans),
      purchase: jest.fn(async () => ({
        premium: true,
        productId: 'pickle_sensei_pro_annual',
        expirationDate: '2027-09-01T00:00:00.000Z',
      })),
      restore: jest.fn(async () => ({
        premium: true,
        productId: 'pickle_sensei_pro_annual',
        expirationDate: '2027-09-01T00:00:00.000Z',
      })),
      readEntitlement: jest.fn(async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      })),
    },
    backend: {
      getAccess: jest.fn(overrides.getAccess),
      syncBilling: jest.fn(overrides.syncBilling),
    },
  };
}

// ── 1. legacy alias ─────────────────────────────────────────────────────────

describe('legacy premium alias', () => {
  function sdkWith(active: Record<string, unknown>): RevenueCatSdk {
    const customerInfo = { entitlements: { active } } as never;
    return {
      isConfigured: async () => true,
      configure: () => undefined,
      getAppUserID: async () => CANONICAL_USER,
      logIn: async () => undefined,
      getOfferings: async () => ({ current: null }),
      purchasePackage: async () => ({ customerInfo }),
      restorePurchases: async () => customerInfo,
      getCustomerInfo: async () => customerInfo,
      checkTrialOrIntroductoryPriceEligibility: async () => ({}),
    };
  }

  it('RevenueCat client treats either entitlement id as premium', async () => {
    const canonical = createRevenueCatBillingClient(
      { publicSdkKey: 'appl_test', canonicalAppUserId: CANONICAL_USER },
      sdkWith({
        pickle_sensei_pro: {
          productIdentifier: 'pickle_sensei_pro_annual',
          expirationDate: '2027-01-01T00:00:00.000Z',
        },
      }),
      'ios',
    );
    const legacy = createRevenueCatBillingClient(
      { publicSdkKey: 'appl_test', canonicalAppUserId: CANONICAL_USER },
      sdkWith({
        premium: {
          productIdentifier: 'premium_annual_3999',
          expirationDate: null,
        },
      }),
      'ios',
    );
    const neither = createRevenueCatBillingClient(
      { publicSdkKey: 'appl_test', canonicalAppUserId: CANONICAL_USER },
      sdkWith({
        something_else: { productIdentifier: 'x', expirationDate: null },
      }),
      'ios',
    );
    await expect(canonical.readEntitlement()).resolves.toMatchObject({
      premium: true,
      productId: 'pickle_sensei_pro_annual',
    });
    await expect(legacy.readEntitlement()).resolves.toMatchObject({
      premium: true,
      productId: 'premium_annual_3999',
    });
    await expect(neither.readEntitlement()).resolves.toMatchObject({
      premium: false,
    });
  });

  it('access parser requires the server to name the alias "premium" (the Edge Function always prepends it)', async () => {
    const client = (body: unknown) =>
      createCanonicalAccessClient({
        baseUrl: 'https://api.test',
        token: 'id-token',
        fetchFn: async () => jsonResponse(200, body),
      });

    await expect(
      client({ ...access(2, 0, true) }).getAccess(),
    ).resolves.toMatchObject({ premium: true });

    // Same server truth spelled only with the canonical id → rejected.
    const canonicalOnly = {
      ...access(2, 0, true),
      entitlements: ['pickle_sensei_pro'],
    };
    await expect(client(canonicalOnly).getAccess()).rejects.toMatchObject({
      code: 'billing.backend_invalid_response',
    });
  });
});

// ── 2. expired bearer after purchase ────────────────────────────────────────

describe('purchase completes but the backend rejects the bearer (401)', () => {
  beforeEach(() => clearAccessStoreConfiguration());

  it('accessApi maps a 401 to a NON-retryable backend_unavailable error', async () => {
    const client = createCanonicalAccessClient({
      baseUrl: 'https://api.test',
      token: 'expired-provider-id-token',
      fetchFn: async () =>
        jsonResponse(401, {
          error: { message: 'The identity token could not be verified.' },
        }),
    });
    await expect(client.syncBilling()).rejects.toMatchObject({
      code: 'billing.backend_unavailable',
      retryable: false,
    });
    await expect(client.getAccess()).rejects.toMatchObject({
      code: 'billing.backend_unavailable',
      retryable: false,
    });
  });

  it('StoreKit purchase succeeds, sync 401s → access null, gate denies, Restore and Retry fail identically', async () => {
    let backendAccepts = true;
    const backend = createCanonicalAccessClient({
      baseUrl: 'https://api.test',
      token: 'provider-id-token',
      fetchFn: async (input: string) => {
        if (!backendAccepts) {
          return jsonResponse(401, {
            error: { message: 'The identity token could not be verified.' },
          });
        }
        if (input.endsWith('/v1/me/access')) {
          return jsonResponse(200, access(1));
        }
        throw new Error(`unexpected ${input}`);
      },
    });
    const deps = dependencies({
      getAccess: () => backend.getAccess(),
      syncBilling: () => backend.syncBilling(),
    });
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    expect(selectCanStartRating(useAccessStore.getState())).toBe(true);

    // The provider ID token the app holds as its bearer expires; nothing in
    // the app refreshes it. The store purchase itself still succeeds.
    backendAccepts = false;
    const purchased = await useAccessStore.getState().purchaseSelected();
    expect(purchased).toBe(false);
    expect(deps.store.purchase).toHaveBeenCalledTimes(1);

    let state = useAccessStore.getState();
    expect(state.status).toBe('error');
    expect(state.canonicalAccess).toBeNull();
    expect(state.error?.code).toBe('billing.backend_verification_pending');
    expect(selectHasPremium(state)).toBe(false);
    expect(selectPaywallRequired(state)).toBe(true);

    // The error copy tells the user to try Restore — which uses the same
    // bearer and fails the same way.
    const restored = await useAccessStore.getState().restorePurchases();
    expect(restored).toBe(false);
    state = useAccessStore.getState();
    expect(state.canonicalAccess).toBeNull();
    expect(state.error?.code).toBe('billing.backend_verification_pending');

    // Paywall "Try again" → initialize() → same 401.
    await useAccessStore.getState().initialize();
    state = useAccessStore.getState();
    expect(state.canonicalAccess).toBeNull();
    expect(selectPaywallRequired(state)).toBe(true);
  });
});

// ── 3. stale access snapshot after ratings ──────────────────────────────────

describe('accessStore snapshot after the free ratings are consumed', () => {
  beforeEach(() => clearAccessStoreConfiguration());

  it('keeps canStartRating=true until refreshAccess() is called explicitly', async () => {
    let serverAccess = access(0);
    configureAccessStore(
      dependencies({
        getAccess: async () => serverAccess,
        syncBilling: async () => {
          throw new Error('not exercised');
        },
      }),
    );
    await useAccessStore.getState().initialize();
    expect(selectCanStartRating(useAccessStore.getState())).toBe(true);

    // Two ratings are reserved and scored through the permit/sync path — the
    // accessStore is never told; the server truth moves on without it.
    serverAccess = access(2);
    expect(selectCanStartRating(useAccessStore.getState())).toBe(true);
    expect(selectPaywallRequired(useAccessStore.getState())).toBe(false);

    // The store CAN observe the truth — but only when asked.
    await expect(useAccessStore.getState().refreshAccess()).resolves.toBe(true);
    expect(selectCanStartRating(useAccessStore.getState())).toBe(false);
    expect(selectPaywallRequired(useAccessStore.getState())).toBe(true);
  });
});

// ── 4. 402 at reserve time is an outage-shaped error ────────────────────────

function recordingDb(): { db: LocalDb; calls: string[] } {
  const calls: string[] = [];
  const db: LocalDb = {
    async execute(sql) {
      calls.push(sql);
      return { rows: [] };
    },
    close() {},
  };
  return { db, calls };
}

function swingClipWithSidecar(): { clip: CapturedClip; sidecarJson: string } {
  const { sequence, window } = generateSwingSequence({});
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///captures/stroke-wf.mov',
    durationMs: window.endMs,
    fps: 60,
    width: 1080,
    height: 1080,
    capturedAtIso: '2026-09-01T18:00:00.000Z',
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
      poseModelVersion: 'apple-vision-bodypose-1',
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: sequence.frames.length,
      poseFrameCount: sequence.frames.length,
      poseMissingFrameCount: 0,
      trackedDurationMs: window.endMs,
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
      uri: 'file:///captures/stroke-wf.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
  return { clip, sidecarJson };
}

describe('runCaptureAnalysis when the server refuses the reserve with 402', () => {
  beforeEach(() => setActiveDataOwner(CANONICAL_USER));
  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it('returns a generic "unavailable" outcome (same shape as an outage) — no paywall signal for the screen', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const fetchMock = jest.fn(async (url: string) => {
      if (url.endsWith('/v1/analysis-permits')) {
        return jsonResponse(402, {
          error: {
            code: 'access.paywall_required',
            message:
              'Both lifetime free ratings have been used. Membership is required for another rating.',
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const outcome = await runCaptureAnalysis({
      db,
      captureId: 'capture-wf',
      clip,
      declaredStroke: 'forehand_drive',
      handedness: 'right',
      cameraView: 'side',
      apiConfig: { baseUrl: 'https://api.test', token: 'id-token' },
      appVersion: '0.1.0',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    // Only the server's prose survives; the machine-readable
    // access.paywall_required code and the 402 status are dropped, so the
    // caller cannot distinguish "pay to continue" from "service down".
    expect(outcome.reason).toBe(
      'Both lifetime free ratings have been used. Membership is required for another rating.',
    );
    expect(Object.keys(outcome).sort()).toEqual(['kind', 'reason']);
    // Nothing was written locally either: the capture is left as it was.
    expect(calls.some(sql => sql.includes('local_analysis_record'))).toBe(
      false,
    );
  });

  it('an outage produces the SAME outcome shape', async () => {
    const { db } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () =>
      jsonResponse(503, {
        error: {
          message: 'Access is temporarily unavailable. Please try again.',
        },
      }),
    );

    const outcome = await runCaptureAnalysis({
      db,
      captureId: 'capture-wf',
      clip,
      declaredStroke: 'forehand_drive',
      handedness: 'right',
      cameraView: 'side',
      apiConfig: { baseUrl: 'https://api.test', token: 'id-token' },
      appVersion: '0.1.0',
    });
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(Object.keys(outcome).sort()).toEqual(['kind', 'reason']);
  });
});
