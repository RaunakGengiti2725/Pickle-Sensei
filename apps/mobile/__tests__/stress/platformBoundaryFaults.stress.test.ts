/**
 * STRESS / failure-injection — platform boundaries that FEED `mod-telemetry`:
 *
 *   Keychain   → `loadPersistedSession()` → the pseudonymous owner key that
 *                App.tsx stamps into `stabilitySlo.setContext()`;
 *   RevenueCat → `BillingStoreClient.configure/loadPlans` and the access
 *                backend (`fetch` via `createCanonicalAccessClient`) →
 *                `useAccessStore.initialize()`, the gate that fronts
 *                AnalyzeScreen (`useRatingRouteGate`) and decides whether a
 *                single `analyze_opened` funnel event can ever be recorded;
 *   camera /   → the native `PickleVideoCapture.startSessionCapture` bridge
 *   permissions  → `camera_startup_succeeded|failed` stability events;
 *   TTS        → the native `PickleAudioCoach` bridge behind `tts`.
 *
 * Every dependency is driven through throw / reject / malformed / partial /
 * slow / never-resolves (timeout where the boundary owns one). Per seed the
 * plan is derived from the seed; fake timers advance 60s so "never" is
 * observed as a real hang, not a slow success.
 *
 * Invariants:
 *   - telemetry never carries vault material (email, display name, refresh
 *     token) or raw native/SDK error text;
 *   - a malformed Keychain record is DISCARDED (reset), never trusted;
 *   - a settled Keychain fault leaves the recorder writable with an honest
 *     context (unassigned / signed-out), a hang leaves it unassigned;
 *   - a settled RevenueCat/backend fault leaves the access store in a state
 *     the route gate visibly resolves (ready → Analyze, error/unconfigured →
 *     Paywall), with the fixed user-facing copy rather than SDK text, and
 *     `canonicalAccess` fail-closed (null) — never fake access;
 *   - a hung backend (`fetch` never settles) is recorded as observed: the
 *     access client has no timeout, so the store stays `loading` past 60s;
 *   - a failed native camera start records exactly one bounded
 *     `camera_startup_failed` reason and NO `camera_startup_succeeded`;
 *   - the TTS bridge reports `available()` honestly for missing/partial
 *     modules and never records anything into telemetry.
 *
 * Replay: `STRESS_SEED=<seed> npx jest __tests__/stress/platformBoundaryFaults`
 * Scale:  `STRESS_ITER=<n>`.
 */
import { NativeModules } from 'react-native';
import { loadPersistedSession } from '../../src/account/sessionVault';
import {
  UNASSIGNED_STABILITY_USER_KEY,
  createStabilityRecorder,
} from '../../src/analysis/stabilityTelemetry';
import { createCanonicalAccessClient } from '../../src/billing/accessApi';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
  StorePlans,
} from '../../src/billing/types';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
} from '../../src/data/accountScope';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import {
  SLOW_LATENCY_MS,
  SPINNER_BUDGET_MS,
  flushMicrotasks,
  neverResolves,
  pick,
  recordStress,
  seededRandom,
  sensitiveHits,
  settlementProbe,
  stabilityEventViolations,
  stressSeeds,
  tally,
} from '../../testing/stress/faultInjection';

// ─── Keychain seam ──────────────────────────────────────────────────────────

type KeychainRead = () => Promise<
  | false
  | { service: string; storage: string; username: string; password: string }
>;
const mockKeychainSeam: { read: KeychainRead; resets: number } = {
  read: async () => false,
  resets: 0,
};

jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY:
      'AccessibleAfterFirstUnlockThisDeviceOnly',
  },
  getGenericPassword: () => mockKeychainSeam.read(),
  setGenericPassword: async () => ({ service: 's', storage: 'mock' }),
  resetGenericPassword: async () => {
    mockKeychainSeam.resets += 1;
    return true;
  },
}));

const KEYCHAIN_FAULTS = [
  'ok',
  'empty',
  'throw_sync',
  'reject',
  'malformed_json',
  'malformed_shape',
  'partial_record',
  'non_uuid_id',
  'slow_45s',
  'never',
] as const;
type KeychainFault = (typeof KEYCHAIN_FAULTS)[number];

const VAULT_EMAIL = 'coach.rivera@example.com';
const VAULT_NAME = 'Coach Rivera';
const VAULT_REFRESH = 'rt_9f8e7d6c5b4a3210ffeeddccbbaa9988';
const VAULT_UUID = '0f1e2d3c-4b5a-4697-8877-665544332211';

function goodRecord(canonicalAppUserId = VAULT_UUID): string {
  return JSON.stringify({
    version: 1,
    provider: 'apple',
    canonicalAppUserId,
    refreshToken: VAULT_REFRESH,
    email: VAULT_EMAIL,
    displayName: VAULT_NAME,
  });
}

function keychainReadFor(fault: KeychainFault): KeychainRead {
  const item = (password: string) => ({
    service: 'com.picklesensei.auth.session',
    storage: 'KeychainMock',
    username: 'session',
    password,
  });
  switch (fault) {
    case 'ok':
      return async () => item(goodRecord());
    case 'empty':
      return async () => false;
    case 'throw_sync':
      return () => {
        throw new Error(
          'SecItemCopyMatching failed: errSecInteractionNotAllowed (-25308) for /var/mobile/Library/Keychains',
        );
      };
    case 'reject':
      return () =>
        Promise.reject(
          new Error('Keychain access denied while device is locked'),
        );
    case 'malformed_json':
      return async () => item('{"version":1,"provider":"apple",');
    case 'malformed_shape':
      return async () => item(JSON.stringify(['session', VAULT_EMAIL]));
    case 'partial_record':
      return async () =>
        item(
          JSON.stringify({
            version: 1,
            provider: 'apple',
            email: VAULT_EMAIL,
            displayName: VAULT_NAME,
          }),
        );
    case 'non_uuid_id':
      return async () => item(goodRecord('001234.9a8b7c6d5e4f.0987'));
    case 'slow_45s':
      return () =>
        new Promise(resolve =>
          setTimeout(() => resolve(item(goodRecord())), SLOW_LATENCY_MS),
        );
    case 'never':
      return () => neverResolves();
  }
}

// ─── RevenueCat / access backend seams ──────────────────────────────────────

const STORE_FAULTS = [
  'ok',
  'configure_throw',
  'configure_reject',
  'configure_slow_45s',
  'configure_never',
  'plans_reject',
  'plans_malformed',
  'plans_never',
] as const;
type StoreFault = (typeof STORE_FAULTS)[number];

const BACKEND_FAULTS = [
  'ok',
  'fetch_throw',
  'fetch_reject',
  'status_401',
  'status_500',
  'status_503_slow_45s',
  'malformed_json',
  'partial_access',
  'never',
] as const;
type BackendFault = (typeof BACKEND_FAULTS)[number];

const GOOD_ACCESS: CanonicalAccessState = {
  premium: false,
  entitlements: [],
  freeRatings: {
    limit: 2,
    used: 1,
    reserved: 0,
    remaining: 1,
    availableToReserve: 1,
  },
  canStartRating: true,
  paywallRequired: false,
};

const GOOD_PLANS: StorePlans = {
  offeringId: 'default',
  annual: null,
  monthly: null,
  lifetime: null,
};

const RC_ERROR_TEXT =
  'RevenueCat: PurchasesError code=23 "The receipt is missing" userInfo={NSUnderlyingError=/var/mobile/Containers/Data/Application/1234/Library/receipt}';

function storeFor(fault: StoreFault): BillingAccessDependencies['store'] {
  const configure = (): Promise<void> => {
    switch (fault) {
      case 'configure_throw':
        throw new Error(RC_ERROR_TEXT);
      case 'configure_reject':
        return Promise.reject(new Error(RC_ERROR_TEXT));
      case 'configure_slow_45s':
        return new Promise(resolve => setTimeout(resolve, SLOW_LATENCY_MS));
      case 'configure_never':
        return neverResolves();
      default:
        return Promise.resolve();
    }
  };
  const loadPlans = (): Promise<StorePlans> => {
    switch (fault) {
      case 'plans_reject':
        return Promise.reject(new Error(RC_ERROR_TEXT));
      case 'plans_malformed':
        return Promise.resolve({ offerings: 'nope' } as unknown as StorePlans);
      case 'plans_never':
        return neverResolves();
      default:
        return Promise.resolve(GOOD_PLANS);
    }
  };
  const entitlement = async () => ({
    premium: false,
    productId: null,
    expirationDate: null,
  });
  return {
    configure,
    loadPlans,
    purchase: entitlement,
    restore: entitlement,
    readEntitlement: entitlement,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function fetchFor(fault: BackendFault): typeof fetch {
  const good = { ...GOOD_ACCESS };
  return ((..._args: unknown[]) => {
    void _args;
    switch (fault) {
      case 'ok':
        return Promise.resolve(jsonResponse(200, good));
      case 'fetch_throw':
        throw new TypeError('Network request failed');
      case 'fetch_reject':
        return Promise.reject(new TypeError('Network request failed'));
      case 'status_401':
        return Promise.resolve(jsonResponse(401, { error: 'unauthorized' }));
      case 'status_500':
        return Promise.resolve(jsonResponse(500, { error: 'boom' }));
      case 'status_503_slow_45s':
        return new Promise<Response>(resolve =>
          setTimeout(
            () => resolve(jsonResponse(503, { error: 'maintenance' })),
            SLOW_LATENCY_MS,
          ),
        );
      case 'malformed_json':
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError('Unexpected token <')),
        } as unknown as Response);
      case 'partial_access':
        return Promise.resolve(
          jsonResponse(200, { premium: false, entitlements: [] }),
        );
      case 'never':
        return neverResolves<Response>();
    }
  }) as typeof fetch;
}

const SETTLED_BACKEND: ReadonlySet<BackendFault> = new Set([
  'ok',
  'fetch_throw',
  'fetch_reject',
  'status_401',
  'status_500',
  'status_503_slow_45s',
  'malformed_json',
  'partial_access',
]);
const SETTLED_STORE: ReadonlySet<StoreFault> = new Set([
  'ok',
  'configure_throw',
  'configure_reject',
  'configure_slow_45s',
  'plans_reject',
  'plans_malformed',
]);

// ─── Native camera / TTS seams ──────────────────────────────────────────────

const CAMERA_FAULTS = [
  'ok',
  'module_missing',
  'method_missing',
  'throw_sync',
  'reject_permission_denied',
  'reject_generic',
  'malformed_receipt',
  'partial_receipt',
  'slow_45s',
  'never',
] as const;
type CameraFault = (typeof CAMERA_FAULTS)[number];

const TTS_FAULTS = [
  'ok',
  'module_missing',
  'speak_missing',
  'speak_throws',
  'stop_throws',
] as const;
type TtsFault = (typeof TTS_FAULTS)[number];

const PERMISSION_TEXT =
  'AVCaptureDevice authorization denied (AVAuthorizationStatusDenied); NSCameraUsageDescription prompt dismissed by user on device 00008120-001A2B3C4D5E6F7G';

function cameraModuleFor(fault: CameraFault): unknown {
  if (fault === 'module_missing') return undefined;
  const base = {
    capture: async () => ({}),
    importVideo: async () => ({}),
    stopSessionCapture: async () => undefined,
    extractSessionEventClip: async () => ({}),
    cancel: () => undefined,
    addListener: () => undefined,
    removeListeners: () => undefined,
  };
  if (fault === 'method_missing') return base;
  const startSessionCapture = (): Promise<unknown> => {
    switch (fault) {
      case 'throw_sync':
        throw new Error(PERMISSION_TEXT);
      case 'reject_permission_denied':
        return Promise.reject(new Error(PERMISSION_TEXT));
      case 'reject_generic':
        return Promise.reject(
          new Error('AVCaptureSession could not add input: -11852'),
        );
      case 'malformed_receipt':
        return Promise.resolve('session-1');
      case 'partial_receipt':
        return Promise.resolve({ sessionCaptureId: '' });
      case 'slow_45s':
        return new Promise(resolve =>
          setTimeout(
            () => resolve({ sessionCaptureId: 'sc-slow' }),
            SLOW_LATENCY_MS,
          ),
        );
      case 'never':
        return neverResolves();
      default:
        return Promise.resolve({ sessionCaptureId: 'sc-1' });
    }
  };
  return { ...base, startSessionCapture };
}

function ttsModuleFor(fault: TtsFault): unknown {
  switch (fault) {
    case 'module_missing':
      return undefined;
    case 'speak_missing':
      return { stop: () => undefined };
    case 'speak_throws':
      return {
        speak: () => {
          throw new Error('AVSpeechSynthesizer: audio session interrupted');
        },
        stop: () => undefined,
      };
    case 'stop_throws':
      return {
        speak: () => undefined,
        stop: () => {
          throw new Error('AVSpeechSynthesizer: stop failed');
        },
      };
    default:
      return { speak: () => undefined, stop: () => undefined };
  }
}

const nativeModules = NativeModules as Record<string, unknown>;

/** Loads capture.ts / tts.ts fresh against the CURRENT NativeModules seams
 * and the CURRENT module-level stability recorder (both capture their native
 * module at import time, exactly as the shipping bundle does). */
function loadBridges(cameraFault: CameraFault, ttsFault: TtsFault) {
  nativeModules['PickleVideoCapture'] = cameraModuleFor(cameraFault);
  nativeModules['PickleAudioCoach'] = ttsModuleFor(ttsFault);
  let capture!: typeof import('../../src/camera/capture');
  let tts!: typeof import('../../src/audio/tts');
  let telemetry!: typeof import('../../src/analysis/stabilityTelemetry');
  jest.isolateModules(() => {
    telemetry = jest.requireActual('../../src/analysis/stabilityTelemetry');
    capture = jest.requireActual('../../src/camera/capture');
    tts = jest.requireActual('../../src/audio/tts');
  });
  return { capture, tts, telemetry };
}

const SENSITIVE_LITERALS = [
  VAULT_EMAIL,
  VAULT_NAME,
  VAULT_REFRESH,
  '/var/mobile',
  'NSCameraUsageDescription',
  '00008120-001A2B3C4D5E6F7G',
  'PurchasesError',
];

function literalLeaks(value: unknown): string[] {
  const text = JSON.stringify(value) ?? '';
  return SENSITIVE_LITERALS.filter(literal => text.includes(literal));
}

async function advance(ms: number): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
  await flushMicrotasks(2);
}

const SUITE = 'platformBoundaryFaults';

describe('STRESS mod-telemetry / platform boundaries: Keychain, RevenueCat + access backend, camera permissions bridge, TTS bridge', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    mockKeychainSeam.read = async () => false;
    mockKeychainSeam.resets = 0;
    clearAccessStoreConfiguration();
  });

  afterEach(() => {
    clearAccessStoreConfiguration();
    delete nativeModules['PickleVideoCapture'];
    delete nativeModules['PickleAudioCoach'];
    jest.useRealTimers();
  });

  describe('Keychain → session vault → stability context', () => {
    for (const seed of stressSeeds('platformKeychain', 10)) {
      const random = seededRandom(seed);
      const plan = { keychain: pick(random, KEYCHAIN_FAULTS) };

      it(`seed ${seed} — keychain=${plan.keychain}`, async () => {
        await recordStress(SUITE, 'keychainVault', seed, plan, async note => {
          mockKeychainSeam.read = keychainReadFor(plan.keychain);
          const recorder = createStabilityRecorder();
          recorder.record({ kind: 'session_started' });

          const probe = settlementProbe(loadPersistedSession());
          await flushMicrotasks();
          await advance(SPINNER_BUDGET_MS);

          const settled = probe.settled();
          const session = probe.value() ?? null;
          let ownerError: string | null = null;
          let owner = UNASSIGNED_STABILITY_USER_KEY;
          if (settled) {
            // App.tsx: signed-in → canonicalDataOwner(id), else signed-out.
            try {
              owner = session
                ? canonicalDataOwner(session.canonicalAppUserId)
                : SIGNED_OUT_DATA_OWNER;
            } catch (error) {
              ownerError = error instanceof Error ? error.message : 'unknown';
            }
          }
          if (ownerError === null) {
            recorder.setContext({ userKey: owner, sessionKey: 'run-1' });
          }
          recorder.record({
            kind: 'camera_startup_failed',
            reason: 'session_capture_unavailable',
          });
          const events = [...recorder.events()];
          const leaks = literalLeaks(events);
          const hits = sensitiveHits(
            events as unknown as Array<Record<string, unknown>>,
          );
          note({
            settled,
            outcome: probe.outcome(),
            sessionLoaded: session !== null,
            resets: mockKeychainSeam.resets,
            owner,
            ownerError,
            events: tally(events as unknown as Array<Record<string, unknown>>),
            userKeys: [...new Set(events.map(event => event.userKey))],
            leaks,
            sensitive: hits.map(hit => `${hit.field}:${hit.pattern}`),
          });

          // The recorder never throws and never carries vault material.
          expect(leaks).toEqual([]);
          expect(hits).toEqual([]);
          expect(stabilityEventViolations(events)).toEqual([]);
          expect(probe.outcome()).not.toBe('rejected');

          switch (plan.keychain) {
            case 'ok':
            case 'slow_45s':
              expect(settled).toBe(true);
              expect(session?.canonicalAppUserId).toBe(VAULT_UUID);
              expect(owner).toBe(VAULT_UUID);
              expect(mockKeychainSeam.resets).toBe(0);
              break;
            case 'empty':
            case 'throw_sync':
            case 'reject':
              expect(settled).toBe(true);
              expect(session).toBeNull();
              expect(owner).toBe(SIGNED_OUT_DATA_OWNER);
              expect(mockKeychainSeam.resets).toBe(0);
              break;
            case 'malformed_json':
            case 'malformed_shape':
            case 'partial_record':
              // Discarded, never trusted: the record is reset.
              expect(settled).toBe(true);
              expect(session).toBeNull();
              expect(owner).toBe(SIGNED_OUT_DATA_OWNER);
              expect(mockKeychainSeam.resets).toBe(1);
              break;
            case 'non_uuid_id':
              // The vault accepts any non-empty string but the owner key
              // derivation requires a UUID: the error is recorded here as
              // the observation App.tsx / authStore would hit.
              expect(settled).toBe(true);
              expect(session).not.toBeNull();
              expect(ownerError).toContain('canonical backend UUID');
              break;
            case 'never':
              expect(settled).toBe(false);
              expect(owner).toBe(UNASSIGNED_STABILITY_USER_KEY);
              break;
          }
          return ownerError
            ? {
                verdict: 'broken',
                brokenInvariant:
                  'vault-accepted non-UUID canonical id throws in canonicalDataOwner (owner derivation used by App.tsx / authStore.restorePersistedSession)',
              }
            : {};
        });
      });
    }
  });

  describe('RevenueCat store + access backend (fetch) → access gate fronting AnalyzeScreen', () => {
    for (const seed of stressSeeds('platformAccess', 14)) {
      const random = seededRandom(seed);
      const plan = {
        store: pick(random, STORE_FAULTS),
        backend: pick(random, BACKEND_FAULTS),
      };

      it(`seed ${seed} — store=${plan.store} backend=${plan.backend}`, async () => {
        await recordStress(SUITE, 'accessGate', seed, plan, async note => {
          const backend = createCanonicalAccessClient({
            baseUrl: 'https://api.example.test',
            token: 'access-token',
            fetchFn: fetchFor(plan.backend),
          });
          configureAccessStore({ store: storeFor(plan.store), backend });
          const recorder = createStabilityRecorder();

          const probe = settlementProbe(useAccessStore.getState().initialize());
          await flushMicrotasks();
          const statusAtStart = useAccessStore.getState().status;
          await advance(SPINNER_BUDGET_MS);

          const state = useAccessStore.getState();
          // AnalyzeRoute's gate (RootNavigator.useRatingRouteGate): resolves
          // to Analyze when canStartRating, to Paywall on ready/unconfigured/
          // error, and to NOTHING (LoadingState "Checking access…") while
          // loading.
          const gate = state.canonicalAccess?.canStartRating
            ? 'analyze'
            : state.status === 'ready' ||
                state.status === 'unconfigured' ||
                state.status === 'error'
              ? 'paywall'
              : 'loading';
          recorder.record({ kind: 'session_started' });
          const leaks = literalLeaks([state.error, ...recorder.events()]);
          note({
            settled: probe.settled(),
            statusAtStart,
            status: state.status,
            gate,
            canStartRating: state.canonicalAccess?.canStartRating ?? null,
            errorCode: state.error?.code ?? null,
            errorMessage: state.error?.message ?? null,
            leaks,
          });

          expect(probe.outcome()).not.toBe('rejected');
          expect(leaks).toEqual([]);
          expect(stabilityEventViolations([...recorder.events()])).toEqual([]);

          const backendSettles = SETTLED_BACKEND.has(plan.backend);
          const storeSettles = SETTLED_STORE.has(plan.store);
          if (backendSettles && storeSettles) {
            expect(probe.settled()).toBe(true);
            expect(['ready', 'error', 'unconfigured']).toContain(state.status);
            expect(gate).not.toBe('loading');
            if (plan.backend === 'ok') {
              expect(state.canonicalAccess).toEqual(GOOD_ACCESS);
              expect(gate).toBe('analyze');
            } else {
              // Fail closed: no access from a faulted backend.
              expect(state.canonicalAccess).toBeNull();
              expect(gate).toBe('paywall');
              expect(state.error?.code).toBe(
                plan.backend === 'malformed_json' ||
                  plan.backend === 'partial_access'
                  ? 'billing.backend_invalid_response'
                  : 'billing.backend_unavailable',
              );
            }
            if (
              plan.backend === 'ok' &&
              plan.store !== 'ok' &&
              plan.store !== 'configure_slow_45s'
            ) {
              expect(state.error?.code).toMatch(
                /^billing\.(unconfigured|offerings_unavailable)$/,
              );
            }
            return {};
          }
          // A hung dependency: the store is honest (still loading, no fake
          // access) but the gate leaves the user on "Checking access…" with
          // no back control and no telemetry — recorded as observed.
          expect(probe.settled()).toBe(false);
          expect(state.status).toBe('loading');
          expect(state.canonicalAccess).toBeNull();
          expect(gate).toBe('loading');
          return {
            verdict: 'broken',
            brokenInvariant:
              'access gate spins past 60s on a never-settling backend/store: no timeout in accessApi, LoadingState without back control, no telemetry',
          };
        });
      });
    }

    it('access backend fetch that never settles has no client-side timeout: initialize() still pending after 60s, store loading, canonicalAccess null (pinned seed 1)', async () => {
      await recordStress(
        SUITE,
        'accessGate.noTimeout',
        1,
        { store: 'ok', backend: 'never' },
        async note => {
          const backend = createCanonicalAccessClient({
            baseUrl: 'https://api.example.test',
            token: 'access-token',
            fetchFn: fetchFor('never'),
          });
          configureAccessStore({ store: storeFor('ok'), backend });
          const probe = settlementProbe(useAccessStore.getState().initialize());
          await flushMicrotasks();
          await advance(SPINNER_BUDGET_MS);
          await advance(SPINNER_BUDGET_MS);
          const state = useAccessStore.getState();
          note({
            settledAfter120s: probe.settled(),
            status: state.status,
            canonicalAccess: state.canonicalAccess,
          });
          expect(probe.settled()).toBe(false);
          expect(state.status).toBe('loading');
          expect(state.canonicalAccess).toBeNull();
          return {
            verdict: 'broken',
            brokenInvariant:
              'createCanonicalAccessClient.request awaits fetchFn with no AbortController/timeout (contrast data/api.ts API_REQUEST_TIMEOUT_MS)',
          };
        },
        { knownBroken: true },
      );
    });
  });

  describe('native camera (permissions) + TTS bridges → camera_startup_* telemetry', () => {
    for (const seed of stressSeeds('platformBridges', 12)) {
      const random = seededRandom(seed);
      const plan = {
        camera: pick(random, CAMERA_FAULTS),
        tts: pick(random, TTS_FAULTS),
      };

      it(`seed ${seed} — camera=${plan.camera} tts=${plan.tts}`, async () => {
        await recordStress(SUITE, 'nativeBridges', seed, plan, async note => {
          const { capture, tts, telemetry } = loadBridges(
            plan.camera,
            plan.tts,
          );
          telemetry.stabilitySlo.reset();

          // TTS: availability is honest, speak/stop faults are the bridge's
          // to propagate (LiveSessionFlow.notify isolates them upstream).
          const ttsAvailable = tts.tts.available();
          let speakError: string | null = null;
          let stopError: string | null = null;
          try {
            tts.tts.speak('Nice paddle position');
          } catch (error) {
            speakError = error instanceof Error ? error.message : 'unknown';
          }
          try {
            tts.tts.stop();
          } catch (error) {
            stopError = error instanceof Error ? error.message : 'unknown';
          }

          // Camera: start a session capture against the faulted bridge.
          const sessionAvailable = capture.sessionCaptureAvailable();
          let startProbe: ReturnType<typeof settlementProbe> | null = null;
          let syncThrow: string | null = null;
          try {
            startProbe = settlementProbe(capture.startSessionCapture());
          } catch (error) {
            syncThrow = error instanceof Error ? error.message : 'unknown';
          }
          await flushMicrotasks();
          await advance(SPINNER_BUDGET_MS);

          const events = [...telemetry.stabilitySlo.events()];
          const kinds = tally(
            events as unknown as Array<Record<string, unknown>>,
          );
          const reasons = events
            .filter(event => event.kind === 'camera_startup_failed')
            .map(event => (event as { reason: string }).reason);
          const leaks = literalLeaks(events);
          const hits = sensitiveHits(
            events as unknown as Array<Record<string, unknown>>,
          );
          const outcome = syncThrow
            ? 'sync_throw'
            : (startProbe?.outcome() ?? 'pending');
          note({
            ttsAvailable,
            speakError,
            stopError,
            sessionAvailable,
            outcome,
            kinds,
            reasons,
            leaks,
            sensitive: hits.map(hit => `${hit.field}:${hit.pattern}`),
          });

          expect(leaks).toEqual([]);
          expect(hits).toEqual([]);
          expect(stabilityEventViolations(events)).toEqual([]);
          expect(
            events.filter(e => e.kind === 'camera_startup_failed').length,
          ).toBeLessThanOrEqual(1);

          // TTS bridge contract.
          // available() is `Boolean(native?.speak)`: honest for a missing
          // module or missing method, blind to a throwing speak().
          expect(ttsAvailable).toBe(
            plan.tts === 'ok' ||
              plan.tts === 'stop_throws' ||
              plan.tts === 'speak_throws',
          );
          // speak() on a partial module throws a TypeError of its own; the
          // bridge propagates, LiveSessionFlow.notify() isolates upstream.
          if (plan.tts === 'speak_throws' || plan.tts === 'speak_missing') {
            expect(speakError).not.toBeNull();
          } else {
            expect(speakError).toBeNull();
          }
          if (plan.tts === 'stop_throws') expect(stopError).not.toBeNull();
          else expect(stopError).toBeNull();
          // Nothing the TTS bridge does lands in telemetry.
          expect(kinds['session_flow_failed'] ?? 0).toBe(0);

          switch (plan.camera) {
            case 'ok':
            case 'slow_45s':
              expect(outcome).toBe('resolved');
              expect(kinds).toEqual({ camera_startup_succeeded: 1 });
              break;
            case 'module_missing':
            case 'method_missing':
              expect(sessionAvailable).toBe(false);
              expect(outcome).toBe('rejected');
              expect(reasons).toEqual(['session_capture_unavailable']);
              break;
            case 'throw_sync':
              // The native call throws synchronously inside the try → same
              // bounded reason as a rejection; the error still surfaces.
              expect(outcome).toBe('rejected');
              expect(reasons).toEqual(['native_session_start_error']);
              break;
            case 'reject_permission_denied':
            case 'reject_generic':
              expect(outcome).toBe('rejected');
              expect(reasons).toEqual(['native_session_start_error']);
              expect(kinds['camera_startup_succeeded'] ?? 0).toBe(0);
              break;
            case 'malformed_receipt':
            case 'partial_receipt':
              expect(outcome).toBe('rejected');
              expect(reasons).toEqual(['invalid_session_receipt']);
              expect(kinds['camera_startup_succeeded'] ?? 0).toBe(0);
              break;
            case 'never':
              expect(outcome).toBe('pending');
              expect(kinds).toEqual({});
              break;
          }
          return plan.camera === 'never'
            ? {
                verdict: 'broken',
                brokenInvariant:
                  'startSessionCapture hung 60s with no camera_startup_failed and no timeout (hung dependency invisible to telemetry)',
              }
            : {};
        });
      });
    }

    it('permission-denied rejection text (device id, NSCameraUsageDescription) never reaches telemetry; reason is the bounded native_session_start_error (pinned seed 1)', async () => {
      await recordStress(
        SUITE,
        'nativeBridges.permissionDenied',
        1,
        { camera: 'reject_permission_denied', tts: 'ok' },
        async note => {
          const { capture, telemetry } = loadBridges(
            'reject_permission_denied',
            'ok',
          );
          telemetry.stabilitySlo.reset();
          await expect(capture.startSessionCapture()).rejects.toThrow(
            'AVCaptureDevice authorization denied',
          );
          const events = [...telemetry.stabilitySlo.events()];
          note({ events });
          expect(events).toHaveLength(1);
          expect(events[0]).toMatchObject({
            kind: 'camera_startup_failed',
            reason: 'native_session_start_error',
          });
          expect(literalLeaks(events)).toEqual([]);
          return {};
        },
      );
    });
  });
});
