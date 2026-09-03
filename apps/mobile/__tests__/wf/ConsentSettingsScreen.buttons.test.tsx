import React from 'react';
import { StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Button ledger for ConsentSettingsScreen. Every interactive element on the
 * screen is pressed here through the REAL consent store, with only the HTTP
 * client (`consentApi`) mocked, so each assertion is an observable effect:
 * navigation call, API call with the right payload, or a copy change.
 *
 * Ledger:
 *   1. ScreenHeader "Back"                      -> navigation.goBack()
 *   2. Switch "Use my feedback to improve scoring" -> setModelTrainingConsent()
 *      -> grantModelTrainingConsent / withdrawModelTrainingConsent
 *   3. Button "Connect account" (signed out)    -> navigate('ConnectAccount')
 *   4. Button "Try again" (unavailable)         -> hydrate() -> fetchConsentStatus
 */

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack, navigate: mockNavigate }),
}));

type ConsentApi = typeof import('../../src/account/consentApi');
const mockFetchConsentStatus = jest.fn<
  ReturnType<ConsentApi['fetchConsentStatus']>,
  Parameters<ConsentApi['fetchConsentStatus']>
>();
const mockGrant = jest.fn<
  ReturnType<ConsentApi['grantModelTrainingConsent']>,
  Parameters<ConsentApi['grantModelTrainingConsent']>
>();
const mockWithdraw = jest.fn<
  ReturnType<ConsentApi['withdrawModelTrainingConsent']>,
  Parameters<ConsentApi['withdrawModelTrainingConsent']>
>();
jest.mock('../../src/account/consentApi', () => {
  const actual = jest.requireActual<ConsentApi>('../../src/account/consentApi');
  return {
    ...actual,
    fetchConsentStatus: (
      ...args: Parameters<ConsentApi['fetchConsentStatus']>
    ) => mockFetchConsentStatus(...args),
    grantModelTrainingConsent: (
      ...args: Parameters<ConsentApi['grantModelTrainingConsent']>
    ) => mockGrant(...args),
    withdrawModelTrainingConsent: (
      ...args: Parameters<ConsentApi['withdrawModelTrainingConsent']>
    ) => mockWithdraw(...args),
  };
});

import { ConsentSettingsScreen } from '../../src/screens/ConsentSettingsScreen';
import { BrandToggle } from '../../src/design/components';
import { useConsentStore } from '../../src/state/consentStore';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
  type ApiSession,
} from '../../src/account/apiSession';
import {
  ConsentApiError,
  MODEL_TRAINING_CONSENT_VERSION,
  type ConsentStatus,
} from '../../src/account/consentApi';

const apiSession: ApiSession = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'bearer-test',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  provider: 'google',
};

const authSession: AuthSession = {
  provider: 'google',
  subject: apiSession.canonicalAppUserId,
  canonicalAppUserId: apiSession.canonicalAppUserId,
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

const guestSession: AuthSession = {
  provider: 'guest',
  subject: 'local-only',
  canonicalAppUserId: null,
  localOnly: true,
  displayName: null,
  email: null,
};

function status(active: boolean): ConsentStatus {
  return {
    subjectPseudonym: 'pseudo',
    scopes: [
      {
        scope: 'video_analysis',
        active: true,
        consentVersion: null,
        lastAction: null,
        lastActionAt: null,
      },
      {
        scope: 'model_training',
        active,
        consentVersion: active ? MODEL_TRAINING_CONSENT_VERSION : null,
        lastAction: active ? 'granted' : null,
        lastActionAt: active ? '2026-09-01T00:00:00.000Z' : null,
      },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mounted: TestRenderer.ReactTestRenderer[] = [];

async function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ConsentSettingsScreen />);
  });
  mounted.push(renderer);
  return renderer;
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

/** Innermost composite pressables: nodes owning both onPress and a role. */
function pressables(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      typeof node.props.onPress === 'function' &&
      typeof node.props.accessibilityRole === 'string' &&
      node.props.accessibilityRole !== 'switch',
  );
}

function backButton(renderer: TestRenderer.ReactTestRenderer) {
  const [node] = pressables(renderer).filter(
    n => n.props.accessibilityLabel === 'Back',
  );
  if (!node) throw new Error('No pressable labeled Back');
  return node;
}

function toggle(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByType(BrandToggle);
}

function controlLabels(renderer: TestRenderer.ReactTestRenderer): string[] {
  return pressables(renderer).map(n => String(n.props.accessibilityLabel));
}

function buttonLabeled(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const [node] = pressables(renderer).filter(
    n => n.props.accessibilityLabel === label,
  );
  if (!node) throw new Error(`No pressable labeled ${label}`);
  return node;
}

function resetStores() {
  useConsentStore.setState({
    availability: 'loading',
    modelTrainingActive: false,
    lastActionAt: null,
    busy: false,
    error: null,
  });
  clearApiSession();
  useAuthStore.setState({ session: null });
}

describe('ConsentSettingsScreen button ledger', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetStores();
  });

  afterEach(() => {
    // A screen left mounted by a failed assertion would keep re-hydrating
    // on every store reset and pollute the next test's call counts.
    for (const renderer of mounted.splice(0)) {
      act(() => renderer.unmount());
    }
  });

  it('exposes exactly the two interactive elements in the ledger when ready', async () => {
    establishApiSession(apiSession);
    useAuthStore.setState({ session: authSession });
    mockFetchConsentStatus.mockResolvedValue(status(false));
    const renderer = await renderScreen();

    expect(controlLabels(renderer)).toEqual(['Back']);
    expect(
      renderer.root.findAll(n => typeof n.props.onLongPress === 'function'),
    ).toHaveLength(0);
    expect(
      renderer.root.findAll(n => typeof n.props.onSubmitEditing === 'function'),
    ).toHaveLength(0);
    expect(renderer.root.findAllByType(BrandToggle)).toHaveLength(1);
  });

  describe('ScreenHeader "Back"', () => {
    it('pops the stack and is an accessible 44pt button with hitSlop', async () => {
      const renderer = await renderScreen();
      const back = backButton(renderer);

      expect(back.props.accessibilityRole).toBe('button');
      expect(back.props.accessibilityLabel).toBe('Back');
      expect(back.props.hitSlop).toBe(8);
      expect(back.props.disabled).toBeFalsy();
      const style: unknown = back.props.style;
      const resolved =
        typeof style === 'function'
          ? (style as (s: { pressed: boolean }) => StyleProp<ViewStyle>)({
              pressed: false,
            })
          : (style as StyleProp<ViewStyle>);
      const flat = StyleSheet.flatten(resolved) as {
        width?: number;
        height?: number;
      };
      expect(flat.width).toBeGreaterThanOrEqual(44);
      expect(flat.height).toBeGreaterThanOrEqual(44);

      act(() => {
        back.props.onPress();
      });
      expect(mockGoBack).toHaveBeenCalledTimes(1);
    });

    it('works while signed out and while a consent request is pending', async () => {
      useAuthStore.setState({ session: guestSession });
      const renderer = await renderScreen();
      act(() => {
        backButton(renderer).props.onPress();
      });
      expect(mockGoBack).toHaveBeenCalledTimes(1);

      act(() => {
        useConsentStore.setState({ availability: 'ready', busy: true });
      });
      act(() => {
        backButton(renderer).props.onPress();
      });
      expect(mockGoBack).toHaveBeenCalledTimes(2);
    });
  });

  describe('Switch "Use my feedback to improve scoring"', () => {
    it('is a labelled switch, hydrates from the server on mount and defaults OFF', async () => {
      establishApiSession(apiSession);
      useAuthStore.setState({ session: authSession });
      mockFetchConsentStatus.mockResolvedValue(status(false));
      const renderer = await renderScreen();

      expect(mockFetchConsentStatus).toHaveBeenCalledTimes(1);
      expect(mockFetchConsentStatus.mock.calls[0]?.[0]).toEqual(apiSession);
      const sw = toggle(renderer);
      expect(sw.props.label).toBe('Use my feedback to improve scoring');
      expect(sw.props.value).toBe(false);
      expect(sw.props.disabled).toBe(false);
    });

    it('grants model-training consent through the API and reflects the server answer', async () => {
      establishApiSession(apiSession);
      useAuthStore.setState({ session: authSession });
      mockFetchConsentStatus.mockResolvedValue(status(false));
      mockGrant.mockResolvedValue(status(true));
      const renderer = await renderScreen();

      await act(async () => {
        toggle(renderer).props.onValueChange(true);
      });

      expect(mockGrant).toHaveBeenCalledTimes(1);
      const [session, device] = mockGrant.mock.calls[0] ?? [];
      expect(session).toEqual(apiSession);
      expect(device).toMatch(/^ios /);
      expect(mockWithdraw).not.toHaveBeenCalled();
      expect(toggle(renderer).props.value).toBe(true);
      expect(toggle(renderer).props.disabled).toBe(false);
      expect(useConsentStore.getState().lastActionAt).toBe(
        '2026-09-01T00:00:00.000Z',
      );
      expect(allText(renderer)).not.toContain('could not be saved');
    });

    it('withdraws consent through the API when switched off', async () => {
      establishApiSession(apiSession);
      useAuthStore.setState({ session: authSession });
      mockFetchConsentStatus.mockResolvedValue(status(true));
      mockWithdraw.mockResolvedValue(status(false));
      const renderer = await renderScreen();
      expect(toggle(renderer).props.value).toBe(true);

      await act(async () => {
        toggle(renderer).props.onValueChange(false);
      });

      expect(mockWithdraw).toHaveBeenCalledTimes(1);
      expect(mockWithdraw.mock.calls[0]?.[0]).toEqual(apiSession);
      expect(mockGrant).not.toHaveBeenCalled();
      expect(toggle(renderer).props.value).toBe(false);
      expect(toggle(renderer).props.disabled).toBe(false);
    });

    it('disables itself while a request is pending and ignores a second flip', async () => {
      establishApiSession(apiSession);
      useAuthStore.setState({ session: authSession });
      mockFetchConsentStatus.mockResolvedValue(status(false));
      const pending = deferred<ConsentStatus>();
      mockGrant.mockReturnValue(pending.promise);
      const renderer = await renderScreen();

      await act(async () => {
        toggle(renderer).props.onValueChange(true);
      });
      expect(toggle(renderer).props.disabled).toBe(true);
      expect(toggle(renderer).props.value).toBe(false);

      await act(async () => {
        toggle(renderer).props.onValueChange(true);
      });
      expect(mockGrant).toHaveBeenCalledTimes(1);

      await act(async () => {
        pending.resolve(status(true));
        await pending.promise;
      });
      expect(toggle(renderer).props.disabled).toBe(false);
      expect(toggle(renderer).props.value).toBe(true);
    });

    it('shows the server error, keeps the ledger state and re-enables on a ConsentApiError', async () => {
      establishApiSession(apiSession);
      useAuthStore.setState({ session: authSession });
      mockFetchConsentStatus.mockResolvedValue(status(false));
      mockGrant.mockRejectedValue(
        new ConsentApiError('Consent settings are temporarily unavailable.'),
      );
      const renderer = await renderScreen();

      await act(async () => {
        toggle(renderer).props.onValueChange(true);
      });

      expect(allText(renderer)).toContain(
        'Consent settings are temporarily unavailable.',
      );
      expect(toggle(renderer).props.value).toBe(false);
      expect(toggle(renderer).props.disabled).toBe(false);
      expect(useConsentStore.getState().busy).toBe(false);

      mockGrant.mockResolvedValue(status(true));
      await act(async () => {
        toggle(renderer).props.onValueChange(true);
      });
      expect(mockGrant).toHaveBeenCalledTimes(2);
      expect(toggle(renderer).props.value).toBe(true);
      expect(allText(renderer)).not.toContain('temporarily unavailable');
    });

    it('shows the generic failure copy on an unexpected rejection', async () => {
      establishApiSession(apiSession);
      useAuthStore.setState({ session: authSession });
      mockFetchConsentStatus.mockResolvedValue(status(true));
      mockWithdraw.mockRejectedValue(new TypeError('Network request failed'));
      const renderer = await renderScreen();

      await act(async () => {
        toggle(renderer).props.onValueChange(false);
      });

      expect(allText(renderer)).toContain(
        'Your consent change could not be saved. Nothing was changed.',
      );
      expect(toggle(renderer).props.value).toBe(true);
      expect(toggle(renderer).props.disabled).toBe(false);
    });

    it('is disabled for a local-only guest and never hits the network', async () => {
      useAuthStore.setState({ session: guestSession });
      const renderer = await renderScreen();

      expect(mockFetchConsentStatus).not.toHaveBeenCalled();
      expect(useConsentStore.getState().availability).toBe('signed_out');
      const sw = toggle(renderer);
      expect(sw.props.disabled).toBe(true);
      expect(sw.props.value).toBe(false);
      expect(allText(renderer)).toContain(
        'Sign in to change this. Nothing is shared while signed out.',
      );

      await act(async () => {
        sw.props.onValueChange(true);
      });
      expect(mockGrant).not.toHaveBeenCalled();
      expect(mockWithdraw).not.toHaveBeenCalled();
    });

    it('offers a Connect account button to a local-only guest that opens the ConnectAccount route', async () => {
      useAuthStore.setState({ session: guestSession });
      const renderer = await renderScreen();

      expect(controlLabels(renderer)).toEqual(['Back', 'Connect account']);
      const connect = buttonLabeled(renderer, 'Connect account');
      expect(connect.props.accessibilityRole).toBe('button');
      expect(connect.props.disabled).toBeFalsy();

      act(() => {
        connect.props.onPress();
      });
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('ConnectAccount');
      expect(mockGoBack).not.toHaveBeenCalled();
      expect(mockFetchConsentStatus).not.toHaveBeenCalled();
    });

    it('hides Connect account and Try again once the ledger is ready', async () => {
      establishApiSession(apiSession);
      useAuthStore.setState({ session: authSession });
      mockFetchConsentStatus.mockResolvedValue(status(false));
      const renderer = await renderScreen();

      expect(controlLabels(renderer)).toEqual(['Back']);
      expect(allText(renderer)).not.toContain('Sign in to change this.');
      expect(allText(renderer)).not.toContain('Checking your current choice');
    });

    it('is disabled with visible copy when the status fetch fails', async () => {
      establishApiSession(apiSession);
      useAuthStore.setState({ session: authSession });
      mockFetchConsentStatus.mockRejectedValue(
        new ConsentApiError('The consent server returned an invalid response.'),
      );
      const renderer = await renderScreen();

      expect(useConsentStore.getState().availability).toBe('unavailable');
      expect(toggle(renderer).props.disabled).toBe(true);
      expect(toggle(renderer).props.value).toBe(false);
      expect(allText(renderer)).toContain(
        'The consent server returned an invalid response.',
      );
      expect(mockGrant).not.toHaveBeenCalled();
      expect(controlLabels(renderer)).toEqual(['Back', 'Try again']);
    });

    it('re-fetches the ledger from the Try again button and re-enables the switch on success', async () => {
      establishApiSession(apiSession);
      useAuthStore.setState({ session: authSession });
      mockFetchConsentStatus.mockRejectedValueOnce(
        new TypeError('Network request failed'),
      );
      const renderer = await renderScreen();

      expect(useConsentStore.getState().availability).toBe('unavailable');
      expect(allText(renderer)).toContain(
        'Consent settings are temporarily unavailable.',
      );
      const retry = buttonLabeled(renderer, 'Try again');
      expect(retry.props.accessibilityRole).toBe('button');
      expect(retry.props.disabled).toBeFalsy();
      expect(mockFetchConsentStatus).toHaveBeenCalledTimes(1);

      mockFetchConsentStatus.mockResolvedValueOnce(status(true));
      await act(async () => {
        retry.props.onPress();
      });

      expect(mockFetchConsentStatus).toHaveBeenCalledTimes(2);
      expect(mockFetchConsentStatus.mock.calls[1]?.[0]).toEqual(apiSession);
      expect(useConsentStore.getState().availability).toBe('ready');
      expect(toggle(renderer).props.disabled).toBe(false);
      expect(toggle(renderer).props.value).toBe(true);
      expect(controlLabels(renderer)).toEqual(['Back']);
      expect(allText(renderer)).not.toContain('temporarily unavailable');
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(mockGoBack).not.toHaveBeenCalled();
    });

    it('keeps Try again available and the error visible when the retry fails again', async () => {
      establishApiSession(apiSession);
      useAuthStore.setState({ session: authSession });
      mockFetchConsentStatus.mockRejectedValue(
        new ConsentApiError('The consent server returned an invalid response.'),
      );
      const renderer = await renderScreen();

      await act(async () => {
        buttonLabeled(renderer, 'Try again').props.onPress();
      });

      expect(mockFetchConsentStatus).toHaveBeenCalledTimes(2);
      expect(useConsentStore.getState().availability).toBe('unavailable');
      expect(toggle(renderer).props.disabled).toBe(true);
      expect(allText(renderer)).toContain(
        'The consent server returned an invalid response.',
      );
      expect(controlLabels(renderer)).toEqual(['Back', 'Try again']);
    });

    it('stays disabled with loading copy while the status is loading, then clears it', async () => {
      establishApiSession(apiSession);
      useAuthStore.setState({ session: authSession });
      const pending = deferred<ConsentStatus>();
      mockFetchConsentStatus.mockReturnValue(pending.promise);
      const renderer = await renderScreen();

      expect(useConsentStore.getState().availability).toBe('loading');
      expect(toggle(renderer).props.disabled).toBe(true);
      expect(allText(renderer)).toContain('Checking your current choice…');
      expect(controlLabels(renderer)).toEqual(['Back']);

      await act(async () => {
        pending.resolve(status(false));
        await pending.promise;
      });
      expect(toggle(renderer).props.disabled).toBe(false);
      expect(allText(renderer)).not.toContain('Checking your current choice');
    });

    it('shows the loading copy again while Try again is in flight', async () => {
      establishApiSession(apiSession);
      useAuthStore.setState({ session: authSession });
      mockFetchConsentStatus.mockRejectedValueOnce(
        new ConsentApiError('Consent settings are temporarily unavailable.'),
      );
      const renderer = await renderScreen();
      const pending = deferred<ConsentStatus>();
      mockFetchConsentStatus.mockReturnValueOnce(pending.promise);

      await act(async () => {
        buttonLabeled(renderer, 'Try again').props.onPress();
      });

      expect(useConsentStore.getState().availability).toBe('loading');
      expect(allText(renderer)).toContain('Checking your current choice…');
      expect(allText(renderer)).not.toContain('temporarily unavailable');
      expect(controlLabels(renderer)).toEqual(['Back']);

      await act(async () => {
        pending.resolve(status(false));
        await pending.promise;
      });
      expect(toggle(renderer).props.disabled).toBe(false);
      expect(controlLabels(renderer)).toEqual(['Back']);
    });

    it('does not throw when the server omits the model_training scope', async () => {
      establishApiSession(apiSession);
      useAuthStore.setState({ session: authSession });
      mockFetchConsentStatus.mockResolvedValue({
        subjectPseudonym: null,
        scopes: [],
      });
      const renderer = await renderScreen();

      expect(useConsentStore.getState().availability).toBe('ready');
      expect(toggle(renderer).props.value).toBe(false);
      expect(toggle(renderer).props.disabled).toBe(false);
    });
  });
});
