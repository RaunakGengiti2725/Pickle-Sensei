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
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
  seedSqliteCapture,
} from '../../testSupport/sqlite';
import {
  activeReleaseAuthority,
  isReleasePolicyRequest,
  permitCalls,
} from '../../testSupport/releasePolicyFixture';
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
  configureAccessStore as configureBillingAccessStore,
  selectCanStartRating,
  selectHasPremium,
  selectPaywallRequired,
  useAccessStore,
} from '../../src/state/accessStore';
import { createPendingFulfilmentStorage } from '../../src/billing/pendingFulfilment';

function configureAccessStore(clients: BillingAccessDependencies): void {
  setActiveDataOwner(CANONICAL_USER);
  const { db } = createSqliteTestDb();
  configureBillingAccessStore(clients, {
    owner: CANONICAL_USER,
    pendingFulfilmentStorage: createPendingFulfilmentStorage(() => db),
  });
}

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
  afterEach(() => {
    clearAccessStoreConfiguration();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    closeSqliteTestDatabases();
  });

  it('accessApi maps a transient 401 to a retryable backend_unavailable error', async () => {
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
      retryable: true,
    });
    await expect(client.getAccess()).rejects.toMatchObject({
      code: 'billing.backend_unavailable',
      retryable: true,
    });
  });

  it('StoreKit completion survives a 401 and retries only the backend with the rotated bearer', async () => {
    let backendAccepts = true;
    let token = 'expired-access-token';
    const requestedTokens: unknown[] = [];
    const backend = createCanonicalAccessClient({
      baseUrl: 'https://api.test',
      get token() {
        return token;
      },
      fetchFn: async (input: string, init) => {
        requestedTokens.push(
          (init?.headers as Record<string, string>)?.Authorization,
        );
        if (!backendAccepts) {
          return jsonResponse(401, {
            error: { message: 'The identity token could not be verified.' },
          });
        }
        if (input.endsWith('/v1/me/access')) {
          return jsonResponse(200, access(1));
        }
        if (input.endsWith('/v1/billing/sync')) {
          return jsonResponse(200, {
            access: access(1, 0, true),
            billing: {
              premium: true,
              productKey: 'pickle_sensei_pro_annual',
              expiresAt: '2027-09-01T00:00:00.000Z',
              verifiedAt: '2026-09-01T00:00:00.000Z',
            },
          });
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
    expect(deps.store.restore).not.toHaveBeenCalled();
    expect(deps.backend.syncBilling).toHaveBeenCalledTimes(1);
    state = useAccessStore.getState();
    expect(state.canonicalAccess).toBeNull();
    expect(state.error?.code).toBe('billing.backend_verification_pending');

    // Paywall "Try again" → initialize() → same 401.
    await useAccessStore.getState().initialize();
    state = useAccessStore.getState();
    expect(state.canonicalAccess).toBeNull();
    expect(selectPaywallRequired(state)).toBe(true);
    expect(deps.backend.syncBilling).toHaveBeenCalledTimes(2);
    token = 'rotated-access-token';
    backendAccepts = true;
    await expect(
      useAccessStore.getState().retryPendingFulfilment(),
    ).resolves.toBe(true);
    expect(requestedTokens.at(-1)).toBe('Bearer rotated-access-token');
    expect(deps.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(deps.store.purchase).toHaveBeenCalledTimes(1);
    expect(deps.store.restore).not.toHaveBeenCalled();
    expect(useAccessStore.getState().pendingFulfilment).toBeNull();
  });
});

// ── 3. stale access snapshot after ratings ──────────────────────────────────

describe('accessStore snapshot after the free ratings are consumed', () => {
  beforeEach(() => clearAccessStoreConfiguration());
  afterEach(() => {
    clearAccessStoreConfiguration();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    closeSqliteTestDatabases();
  });

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

  it('honors live free-rating reservations, released quota, lifetime exhaustion, and server-verified premium', async () => {
    let serverAccess = access(1);
    const deps = dependencies({
      getAccess: async () => serverAccess,
      syncBilling: async () => {
        throw new Error('quota refresh must not purchase or sync billing');
      },
    });
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    expect(selectCanStartRating(useAccessStore.getState())).toBe(true);

    serverAccess = access(1, 1);
    await expect(useAccessStore.getState().refreshAccess()).resolves.toBe(true);
    expect(useAccessStore.getState().canonicalAccess?.freeRatings).toEqual({
      limit: 2,
      used: 1,
      reserved: 1,
      remaining: 1,
      availableToReserve: 0,
    });
    expect(selectCanStartRating(useAccessStore.getState())).toBe(false);
    expect(selectPaywallRequired(useAccessStore.getState())).toBe(true);

    // Only a fresh server snapshot can say that the live hold was released.
    serverAccess = access(1, 0);
    await expect(useAccessStore.getState().refreshAccess()).resolves.toBe(true);
    expect(selectCanStartRating(useAccessStore.getState())).toBe(true);
    expect(selectPaywallRequired(useAccessStore.getState())).toBe(false);

    serverAccess = access(2);
    await expect(useAccessStore.getState().refreshAccess()).resolves.toBe(true);
    expect(selectCanStartRating(useAccessStore.getState())).toBe(false);
    expect(selectPaywallRequired(useAccessStore.getState())).toBe(true);

    serverAccess = access(2, 0, true);
    await expect(useAccessStore.getState().refreshAccess()).resolves.toBe(true);
    expect(selectHasPremium(useAccessStore.getState())).toBe(true);
    expect(selectCanStartRating(useAccessStore.getState())).toBe(true);
    expect(selectPaywallRequired(useAccessStore.getState())).toBe(false);
    expect(deps.backend.getAccess).toHaveBeenCalledTimes(5);
    expect(deps.backend.syncBilling).not.toHaveBeenCalled();
    expect(deps.store.purchase).not.toHaveBeenCalled();
    expect(deps.store.restore).not.toHaveBeenCalled();
  });
});

// ── 4. 402 at reserve time is distinct from an outage ───────────────────────

function recordingDb(): { db: LocalDb; calls: string[] } {
  const store = createSqliteTestDb();
  const calls: string[] = [];
  store.observeStatements(call => calls.push(call.sql));
  return { db: store.db, calls };
}

function swingClipWithSidecar(): { clip: CapturedClip; sidecarJson: string } {
  // Reserve tests must use metadata from these exact bytes, not a native model label.
  const { sequence, window } = generateSwingSequence({});
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///captures/stroke-wf.mov',
    durationMs: window.endMs,
    fps: sequence.video.fps,
    width: sequence.video.width,
    height: sequence.video.height,
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
      poseModelVersion: sequence.producedBy.modelVersion,
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
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
  return { clip, sidecarJson };
}

describe('runCaptureAnalysis when the server refuses the reserve with 402', () => {
  beforeEach(() => {
    setActiveDataOwner(CANONICAL_USER);
    establishApiSession({
      canonicalAppUserId: CANONICAL_USER,
      apiBaseUrl: 'https://api.test',
      bearerToken: 'id-token',
      provider: 'apple',
    });
  });
  afterEach(() => {
    closeSqliteTestDatabases();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it('returns an "unavailable" outcome tagged cause=paywall_required so the screen can route to the paywall instead of a retry', async () => {
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
      if (isReleasePolicyRequest(url))
        return jsonResponse(200, activeReleaseAuthority());
      throw new Error(`Unexpected fetch: ${url}`);
    });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    seedSqliteCapture(
      db,
      CANONICAL_USER,
      '77777777-7777-4777-8777-777777777777',
      clip,
    );
    const outcome = await runCaptureAnalysis({
      db,
      captureId: '77777777-7777-4777-8777-777777777777',
      clip,
      declaredStroke: 'forehand_drive',
      handedness: 'right',
      cameraView: 'side',
      apiConfig: { baseUrl: 'https://api.test', token: 'id-token' },
      appVersion: '0.1.0',
    });

    expect(permitCalls(fetchMock)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.test/v1/analysis-permits',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer id-token' }),
      }),
    );
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    // The server's prose survives, and the 402 access.paywall_required verdict
    // is preserved as a machine-readable cause so "pay to continue" is
    // distinguishable from "service down".
    expect(outcome.reason).toBe(
      'Both lifetime free ratings have been used. Membership is required for another rating.',
    );
    expect(outcome.cause).toBe('paywall_required');
    expect(Object.keys(outcome).sort()).toEqual(['cause', 'kind', 'reason']);
    // No rating is written: only the reserve rejection is durably journaled.
    expect(calls.some(sql => sql.includes('local_analysis_record'))).toBe(
      false,
    );
    expect(calls.some(sql => sql.includes('INSERT INTO outbox'))).toBe(false);
    const journal = await db.execute(
      'SELECT state, terminal_reason, last_http_status FROM analysis_run_journal',
    );
    expect(journal.rows).toEqual([
      {
        state: 'terminal',
        terminal_reason: 'reservation_rejected',
        last_http_status: 402,
      },
    ]);
  });

  it('an outage produces an "unavailable" outcome WITHOUT a paywall cause', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const fetchMock = jest.fn(async (url: string) => {
      if (url.endsWith('/v1/analysis-permits')) {
        return jsonResponse(503, {
          error: {
            message: 'Access is temporarily unavailable. Please try again.',
          },
        });
      }
      if (isReleasePolicyRequest(url))
        return jsonResponse(200, activeReleaseAuthority());
      throw new Error(`Unexpected fetch: ${url}`);
    });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    seedSqliteCapture(
      db,
      CANONICAL_USER,
      '77777777-7777-4777-8777-777777777777',
      clip,
    );
    const outcome = await runCaptureAnalysis({
      db,
      captureId: '77777777-7777-4777-8777-777777777777',
      clip,
      declaredStroke: 'forehand_drive',
      handedness: 'right',
      cameraView: 'side',
      apiConfig: { baseUrl: 'https://api.test', token: 'id-token' },
      appVersion: '0.1.0',
    });
    expect(permitCalls(fetchMock)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.test/v1/analysis-permits',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer id-token' }),
      }),
    );
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(Object.keys(outcome).sort()).toEqual(['kind', 'reason']);
    expect(outcome.reason).toBe(
      'Access is temporarily unavailable. Please try again.',
    );
    expect(calls.some(sql => sql.includes('local_analysis_record'))).toBe(
      false,
    );
    expect(calls.some(sql => sql.includes('INSERT INTO outbox'))).toBe(false);
    const journal = await db.execute(
      'SELECT state, terminal_reason, last_http_status, permit_id, result_id FROM analysis_run_journal',
    );
    expect(journal.rows).toEqual([
      {
        state: 'release_pending',
        terminal_reason: null,
        last_http_status: 503,
        permit_id: null,
        result_id: null,
      },
    ]);
  });
});
