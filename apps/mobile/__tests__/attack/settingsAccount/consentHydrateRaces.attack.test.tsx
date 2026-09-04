import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * ADVERSARIAL PASS 3 / tester #4 — scenarios 6 + 8 (consent GET races).
 *
 * The consent store is the mobile mirror of the server ledger. Two attacks:
 *   6. "Try again" is tapped 5× on ConsentSettingsScreen while the ledger is
 *      unavailable. Either at most ONE GET may be in flight, or interleaved
 *      responses must be unable to leave `modelTrainingActive` disagreeing
 *      with the newest server answer.
 *   8. `hydrate()` twice in the SAME session; the first GET resolves AFTER
 *      the second with a different `active` value. The newer response must
 *      win — the store must not show an older ledger state as current.
 *
 * Extras: a stale unavailable error landing after a fresh success, and a
 * seeded fuzz over resolution orders (seed recorded in the log line).
 */

jest.mock('../../../src/data/db', () => ({ getDb: jest.fn() }));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
}));

import {
  clearApiSession,
  establishApiSession,
} from '../../../src/account/apiSession';
import { MODEL_TRAINING_CONSENT_VERSION } from '../../../src/account/consentApi';
import { useAuthStore, type AuthSession } from '../../../src/auth/authStore';
import { BrandToggle, Button } from '../../../src/design/components';
import { ConsentSettingsScreen } from '../../../src/screens/ConsentSettingsScreen';
import { useConsentStore } from '../../../src/state/consentStore';

const apiSession = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'token-1',
  canonicalAppUserId: 'a0000000-0000-0000-0000-000000000001',
  provider: 'apple' as const,
};

const authSession: AuthSession = {
  provider: 'apple',
  subject: apiSession.canonicalAppUserId,
  canonicalAppUserId: apiSession.canonicalAppUserId,
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

function statusBody(
  modelTrainingActive: boolean,
  at = '2026-08-29T00:00:00.000Z',
) {
  return {
    subjectPseudonym: 'b0000000-0000-0000-0000-000000000002',
    scopes: [
      {
        scope: 'video_analysis',
        active: false,
        consentVersion: null,
        lastAction: null,
        lastActionAt: null,
      },
      {
        scope: 'model_training',
        active: modelTrainingActive,
        consentVersion: modelTrainingActive
          ? MODEL_TRAINING_CONSENT_VERSION
          : null,
        lastAction: modelTrainingActive ? 'granted' : 'withdrawn',
        lastActionAt: at,
      },
    ],
  };
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

interface PendingGet {
  resolve: (response: Response) => void;
  reject: (reason: unknown) => void;
}

/** Every GET is parked until the test releases it, in any order. */
class GateFetch {
  pending: PendingGet[] = [];
  calls = 0;
  readonly fn = jest.fn((): Promise<Response> => {
    this.calls += 1;
    return new Promise<Response>((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  });
  inFlight(): number {
    return this.pending.length;
  }
  release(index: number, response: Response) {
    const [entry] = this.pending.splice(index, 1);
    entry!.resolve(response);
  }
  fail(index: number) {
    const [entry] = this.pending.splice(index, 1);
    entry!.reject(new TypeError('Network request failed'));
  }
}

function resetStore() {
  useConsentStore.setState({
    availability: 'loading',
    modelTrainingActive: false,
    lastActionAt: null,
    busy: false,
    error: null,
  });
}

async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

let mounted: TestRenderer.ReactTestRenderer | null = null;
let gate: GateFetch;

beforeEach(() => {
  resetStore();
  clearApiSession();
  gate = new GateFetch();
  (globalThis as { fetch: unknown }).fetch = gate.fn;
});

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
  // Settle any parked GET so the request timeout timer is cleared.
  for (const entry of gate.pending.splice(0))
    entry.reject(new Error('teardown'));
  delete (globalThis as { fetch?: unknown }).fetch;
  clearApiSession();
});

describe('scenario 8 — two hydrates in one session, first GET lands last', () => {
  it('store-level: the NEWER response must win', async () => {
    establishApiSession(apiSession);
    const { hydrate } = useConsentStore.getState();
    const first = hydrate(gate.fn);
    const second = hydrate(gate.fn);
    expect(gate.inFlight()).toBe(2);

    // Ledger says WITHDRAWN on the newer read, then the OLDER read (granted)
    // arrives late.
    gate.release(
      1,
      jsonResponse(statusBody(false, '2026-08-30T00:00:00.000Z')),
    );
    await second;
    expect(useConsentStore.getState().modelTrainingActive).toBe(false);

    gate.release(0, jsonResponse(statusBody(true, '2026-08-29T00:00:00.000Z')));
    await first;
    const state = useConsentStore.getState();
    expect(state.availability).toBe('ready');
    // Newer response (withdrawn) must win over the stale granted answer.
    expect(state.modelTrainingActive).toBe(false);
    expect(state.lastActionAt).toBe('2026-08-30T00:00:00.000Z');
  });

  it('store-level: a stale FAILURE landing after a fresh success must not flip to unavailable', async () => {
    establishApiSession(apiSession);
    const { hydrate } = useConsentStore.getState();
    const first = hydrate(gate.fn);
    const second = hydrate(gate.fn);
    gate.release(1, jsonResponse(statusBody(true)));
    await second;
    expect(useConsentStore.getState()).toMatchObject({
      availability: 'ready',
      modelTrainingActive: true,
    });
    gate.fail(0);
    await first;
    expect(useConsentStore.getState()).toMatchObject({
      availability: 'ready',
      modelTrainingActive: true,
    });
  });
});

describe('scenario 8 variant — slow mount GET lands after the player toggled consent ON', () => {
  it('a slow status GET must not undo a completed grant', async () => {
    establishApiSession(apiSession);
    // Mount-time GET is slow; the player, seeing the toggle become ready
    // from a previous visit, flips it on. The grant POST completes first.
    useConsentStore.setState({
      availability: 'ready',
      modelTrainingActive: false,
    });
    const { hydrate, setModelTrainingConsent } = useConsentStore.getState();
    const slowGet = hydrate(gate.fn);
    const grant = setModelTrainingConsent(true, gate.fn);
    expect(gate.inFlight()).toBe(2);
    gate.release(1, jsonResponse(statusBody(true, '2026-08-30T12:00:00.000Z')));
    await grant;
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);

    // The pre-grant GET (withdrawn) now lands.
    gate.release(
      0,
      jsonResponse(statusBody(false, '2026-08-29T00:00:00.000Z')),
    );
    await slowGet;
    // Ledger holds the grant; the toggle must still say ON.
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);
  });
});

describe('scenario 6 — Retry ×5 while unavailable', () => {
  function renderScreen() {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<ConsentSettingsScreen />);
    });
    mounted = renderer;
    return renderer;
  }

  function retryButton(renderer: TestRenderer.ReactTestRenderer) {
    return renderer.root
      .findAllByType(Button)
      .find(node => node.props.label === 'Try again');
  }

  it('≤1 in-flight GET, or interleaved responses cannot yield a wrong modelTrainingActive', async () => {
    establishApiSession(apiSession);
    useAuthStore.setState({ session: authSession });
    const renderer = renderScreen();
    // Mount hydrate → fail it so the Retry affordance appears.
    await act(async () => {
      gate.fail(0);
      await flush();
    });
    expect(useConsentStore.getState().availability).toBe('unavailable');
    expect(retryButton(renderer)).toBeDefined();

    // Five rapid taps: each is its own discrete press. A tap that finds no
    // button (because the screen swapped it for "Checking…") counts as
    // absorbed by the UI, which is a legitimate way to hold property A.
    let tapsLanded = 0;
    for (let i = 0; i < 5; i += 1) {
      act(() => {
        const button = retryButton(renderer);
        if (button) {
          tapsLanded += 1;
          button.props.onPress();
        }
      });
    }
    await act(flush);
    const inFlight = gate.inFlight();
    console.log(
      `[attack] retry taps landed=${tapsLanded} in-flight GETs=${inFlight}`,
    );

    if (inFlight <= 1) {
      // Property A holds: at most one GET is in flight.
      expect(tapsLanded).toBe(1);
      expect(useConsentStore.getState().availability).toBe('loading');
      return;
    }

    // Property A failed (5 concurrent GETs). Property B must then hold:
    // resolve them in a scrambled order with different answers and require
    // the store to end on the LAST response the server produced.
    // Order of server answers: taps 0..4 answered false,true,false,true,false
    // Delivery order: 4,2,0,3,1 → last delivered = tap 1 (true)... but the
    // newest server truth is tap 4 (false, latest lastActionAt).
    const answers = [false, true, false, true, false];
    const delivery = [4, 2, 0, 3, 1];
    const at = (tap: number) => `2026-08-3${tap}T00:00:00.000Z`;
    // Deliver in scrambled order; `release` indexes shrink as we splice, so
    // resolve via the captured entries directly.
    const entries = [...gate.pending];
    gate.pending.length = 0;
    await act(async () => {
      for (const tap of delivery) {
        entries[tap]!.resolve(jsonResponse(statusBody(answers[tap]!, at(tap))));
        await flush();
      }
    });
    const state = useConsentStore.getState();
    expect(state.availability).toBe('ready');
    // Newest ledger truth is tap 4: withdrawn (false).
    expect(state.modelTrainingActive).toBe(false);
    expect(state.lastActionAt).toBe(at(4));
  });

  it('UI path: leave and re-open Consent while the first GET is slow → the slow stale answer overwrites the fresh one', async () => {
    establishApiSession(apiSession);
    useAuthStore.setState({ session: authSession });
    renderScreen();
    expect(gate.inFlight()).toBe(1);
    // Back out while the read is still pending, then re-open the screen.
    act(() => mounted?.unmount());
    mounted = null;
    const second = renderScreen();
    expect(gate.inFlight()).toBe(2);

    // The re-open's GET answers first: withdrawn (newest ledger state).
    await act(async () => {
      gate.release(
        1,
        jsonResponse(statusBody(false, '2026-08-30T00:00:00.000Z')),
      );
      await flush();
    });
    expect(useConsentStore.getState().modelTrainingActive).toBe(false);

    // The first screen's slow GET now lands with the OLDER granted state.
    await act(async () => {
      gate.release(
        0,
        jsonResponse(statusBody(true, '2026-08-29T00:00:00.000Z')),
      );
      await flush();
    });
    const state = useConsentStore.getState();
    expect(state.modelTrainingActive).toBe(false);
    expect(second.root.findByType(BrandToggle).props.value).toBe(false);
  });

  it('seeded fuzz: N concurrent hydrates resolved in random order must always end on the newest answer', async () => {
    establishApiSession(apiSession);
    const SEED = 0x5eed_0006;
    let s = SEED;
    const rand = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x1_0000_0000;
    };
    let mismatches = 0;
    const ITERATIONS = 48;
    for (let iter = 0; iter < ITERATIONS; iter += 1) {
      resetStore();
      gate = new GateFetch();
      const n = 2 + Math.floor(rand() * 5);
      const answers = Array.from({ length: n }, () => rand() < 0.5);
      const { hydrate } = useConsentStore.getState();
      const promises = Array.from({ length: n }, () => hydrate(gate.fn));
      const entries = [...gate.pending];
      const order = entries.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rand() * (i + 1));
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
      for (const idx of order) {
        entries[idx]!.resolve(
          jsonResponse(
            statusBody(answers[idx]!, `2026-08-2${idx}T00:00:00.000Z`),
          ),
        );
        await flush();
      }
      await Promise.all(promises);
      const expected = answers[n - 1];
      if (useConsentStore.getState().modelTrainingActive !== expected) {
        mismatches += 1;
      }
    }
    console.log(
      `[attack][seed=${SEED.toString(16)}] consent newest-wins mismatches: ${mismatches}/${ITERATIONS}`,
    );
    expect(mismatches).toBe(0);
  });
});
