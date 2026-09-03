/**
 * Data-layer zero-silent-failure audit — the screens that sit on top of the
 * consent / auth / deletion stores (workflow: data-layer-typed-failures).
 *
 * Drives the controls a real user taps and checks how each store failure
 * reaches the UI: failure copy, busy guards, cancel branches, accessibility.
 * "DEFECT:" tests document confirmed defects (reported as issues) and pass
 * against the current code so the evidence is executable.
 */
import React from 'react';
import { Modal, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: {
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
    },
  };
});

const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack }),
}));

const mockRequestAccountDeletion = jest.fn<
  Promise<{ challenge: string; expiresAt: string }>,
  unknown[]
>();
const mockConfirmAccountDeletion = jest.fn<Promise<void>, unknown[]>();
jest.mock('../../src/account/deletion', () => {
  // Only the network calls are stubbed; the survey vocabulary/caps the
  // dialog renders from (and AccountDeletionError) are the real ones.
  const actual = jest.requireActual<
    typeof import('../../src/account/deletion')
  >('../../src/account/deletion');
  return {
    ...actual,
    requestAccountDeletion: (...args: unknown[]) =>
      mockRequestAccountDeletion(...args),
    confirmAccountDeletion: (...args: unknown[]) =>
      mockConfirmAccountDeletion(...args),
  };
});

import { ConsentSettingsScreen } from '../../src/screens/ConsentSettingsScreen';
import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { SignInScreen } from '../../src/screens/SignInScreen';
import { BrandToggle, Button } from '../../src/design/components';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import { useConsentStore } from '../../src/state/consentStore';

const syncedSession: AuthSession = {
  provider: 'apple',
  subject: 'apple-subject',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
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

/** Labelled controls (outermost composite per label, like the app's suites). */
function controlLabels(renderer: TestRenderer.ReactTestRenderer): string[] {
  const labels = renderer.root
    .findAll(
      node =>
        typeof node.props.accessibilityLabel === 'string' &&
        typeof node.props.onPress === 'function' &&
        node.props.accessibilityRole !== 'switch',
    )
    .map(node => node.props.accessibilityLabel as string);
  return Array.from(new Set(labels));
}

function pressables(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
}

/** The host (native) node carrying the resolved accessibility props. */
function hostNode(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.find(
    node =>
      typeof node.type === 'string' && node.props.accessibilityLabel === label,
  );
}

function sheetButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = renderer.root
    .findAllByType(Button)
    .filter(node => String(node.props.label).startsWith(label));
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
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

describe('ConsentSettingsScreen ← consentStore', () => {
  beforeEach(() => {
    useConsentStore.setState({
      availability: 'ready',
      modelTrainingActive: false,
      lastActionAt: null,
      busy: false,
      error: null,
      hydrate: jest.fn(() => Promise.resolve()),
      setModelTrainingConsent: jest.fn(() => Promise.resolve()),
    });
  });

  it('toggle is disabled while a change is in flight (double-tap guard) and re-enabled after', () => {
    useConsentStore.setState({ busy: true });
    const renderer = render(<ConsentSettingsScreen />);
    let toggle = renderer.root.findByType(BrandToggle);
    expect(toggle.props.disabled).toBe(true);
    expect(toggle.props.label).toBe('Use my feedback to improve scoring');
    act(() => {
      useConsentStore.setState({ busy: false });
    });
    toggle = renderer.root.findByType(BrandToggle);
    expect(toggle.props.disabled).toBe(false);
    act(() => renderer.unmount());
  });

  it('a failed change shows the store copy and leaves the toggle on the server value', () => {
    useConsentStore.setState({
      modelTrainingActive: false,
      error: 'Consent settings are temporarily unavailable.',
    });
    const renderer = render(<ConsentSettingsScreen />);
    expect(allText(renderer)).toContain(
      'Consent settings are temporarily unavailable.',
    );
    expect(renderer.root.findByType(BrandToggle).props.value).toBe(false);
    act(() => renderer.unmount());
  });

  it('when consent status could not load, the error is shown with a "Try again" control that re-hydrates', async () => {
    useConsentStore.setState({
      availability: 'unavailable',
      error: 'Consent settings are temporarily unavailable.',
    });
    const renderer = render(<ConsentSettingsScreen />);
    expect(allText(renderer)).toContain(
      'Consent settings are temporarily unavailable.',
    );
    expect(renderer.root.findByType(BrandToggle).props.disabled).toBe(true);
    expect(controlLabels(renderer)).toEqual(['Back', 'Try again']);
    expect(useConsentStore.getState().hydrate).toHaveBeenCalledTimes(1);
    await act(async () => {
      pressables(renderer, 'Try again')[0]!.props.onPress();
    });
    expect(useConsentStore.getState().hydrate).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
  });
});

describe('SignInScreen ← authStore', () => {
  beforeEach(() => {
    useAuthStore.setState({
      hydrated: true,
      session: null,
      busy: false,
      error: null,
    });
  });

  it('provider buttons are wired, role=button, and disabled while busy with visible progress copy', async () => {
    const pending = deferred<void>();
    const signInWithGoogle = jest.fn(() => pending.promise);
    useAuthStore.setState({ signInWithGoogle });
    const renderer = render(<SignInScreen onBack={() => {}} />);
    const google = pressables(renderer, 'Continue with Google')[0]!;
    expect(
      hostNode(renderer, 'Continue with Google').props.accessibilityRole,
    ).toBe('button');
    expect(google.props.disabled).toBe(false);

    act(() => {
      google.props.onPress();
      useAuthStore.setState({ busy: true });
    });
    expect(signInWithGoogle).toHaveBeenCalledTimes(1);
    expect(
      pressables(renderer, 'Continue with Google')[0]!.props.disabled,
    ).toBe(true);
    expect(allText(renderer)).toContain('Signing in securely…');

    await act(async () => {
      pending.resolve();
      useAuthStore.setState({ busy: false });
    });
    expect(
      pressables(renderer, 'Continue with Google')[0]!.props.disabled,
    ).toBe(false);
    act(() => renderer.unmount());
  });

  it('cancel branch: auth.canceled renders no error card; other failures render dismissible copy', () => {
    useAuthStore.setState({
      error: { code: 'auth.canceled', message: 'Sign-in canceled.' },
    });
    const renderer = render(<SignInScreen onBack={() => {}} />);
    expect(pressables(renderer, 'Dismiss sign-in error')).toHaveLength(0);
    expect(allText(renderer)).not.toContain('Sign-in canceled.');

    act(() => {
      useAuthStore.setState({
        error: {
          code: 'auth.failed',
          message: 'The account service is unavailable. Please try again.',
        },
      });
    });
    const dismiss = pressables(renderer, 'Dismiss sign-in error')[0]!;
    expect(dismiss.props.accessibilityLiveRegion).toBe('assertive');
    expect(allText(renderer)).toContain('SIGN-IN FAILED');
    expect(allText(renderer)).toContain(
      'The account service is unavailable. Please try again.',
    );
    act(() => {
      dismiss.props.onPress();
    });
    expect(useAuthStore.getState().error).toBeNull();
    expect(pressables(renderer, 'Dismiss sign-in error')).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('a real signInWithApple failure without the native module lands as typed not_configured copy, not a spinner', async () => {
    const renderer = render(<SignInScreen onBack={() => {}} />);
    const apple = pressables(renderer, 'Continue with Apple')[0];
    // Apple button renders on iOS only; drive the store directly otherwise.
    await act(async () => {
      if (apple) apple.props.onPress();
      else await useAuthStore.getState().signInWithApple();
    });
    expect(useAuthStore.getState().busy).toBe(false);
    expect(useAuthStore.getState().error?.code).toBe('auth.not_configured');
    expect(allText(renderer)).toContain('NOT CONFIGURED YET');
    act(() => renderer.unmount());
  });
});

describe('ManageAccountScreen delete sheet ← deletion api', () => {
  beforeEach(() => {
    mockGoBack.mockClear();
    mockRequestAccountDeletion.mockReset();
    mockConfirmAccountDeletion.mockReset();
    useAuthStore.setState({
      hydrated: true,
      session: syncedSession,
      busy: false,
      error: null,
      completeAccountDeletion: jest.fn(() => Promise.resolve()),
    });
  });

  /** The link opens the exit survey first; skip it to reach the
   * confirmation whose failure paths this suite pins. */
  async function skipSurvey(renderer: TestRenderer.ReactTestRenderer) {
    expect(allText(renderer)).toContain("What's making you leave?");
    await act(async () => {
      pressables(renderer, 'Skip the survey')[0]!.props.onPress();
    });
    expect(allText(renderer)).toContain('Delete your account?');
  }

  async function openSheet() {
    const renderer = render(<ManageAccountScreen />);
    await act(async () => {
      pressables(renderer, 'Delete account')[0]!.props.onPress();
    });
    await skipSurvey(renderer);
    return renderer;
  }

  it('request failure returns to review with typed copy; nothing is deleted locally', async () => {
    mockRequestAccountDeletion.mockRejectedValue(
      new Error('Network request failed'),
    );
    const renderer = await openSheet();
    await act(async () => {
      sheetButton(renderer, 'Continue to delete').props.onPress();
    });
    expect(allText(renderer)).toContain(
      'The deletion request could not be completed. Nothing was deleted.',
    );
    const retry = sheetButton(renderer, 'Continue to delete');
    expect(retry.props.disabled).toBe(false);
    expect(
      useAuthStore.getState().completeAccountDeletion,
    ).not.toHaveBeenCalled();
    expect(useAuthStore.getState().session).toEqual(syncedSession);
    act(() => renderer.unmount());
  });

  it('confirm failure re-arms immediately (no countdown) with copy and never purges', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      mockRequestAccountDeletion.mockResolvedValue({
        challenge: 'challenge-1',
        expiresAt: '2026-08-31T00:00:00.000Z',
      });
      mockConfirmAccountDeletion.mockRejectedValue(new Error('503'));
      const renderer = await openSheet();
      await act(async () => {
        sheetButton(renderer, 'Continue to delete').props.onPress();
      });
      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });
      await act(async () => {
        sheetButton(renderer, 'Permanently delete').props.onPress();
      });
      expect(allText(renderer)).toContain(
        'The deletion could not be completed. Nothing was deleted.',
      );
      const again = sheetButton(renderer, 'Permanently delete');
      expect(again.props.label).toBe('Permanently delete');
      expect(again.props.disabled).toBe(false);
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancel branch: Keep my account closes the dialog and resets it (survey first, then a clean review)', async () => {
    mockRequestAccountDeletion.mockRejectedValue(new Error('x'));
    const renderer = await openSheet();
    await act(async () => {
      sheetButton(renderer, 'Continue to delete').props.onPress();
    });
    expect(allText(renderer)).toContain('Nothing was deleted.');
    await act(async () => {
      sheetButton(renderer, 'Keep my account').props.onPress();
    });
    expect(allText(renderer)).not.toContain('Delete your account?');
    await act(async () => {
      pressables(renderer, 'Delete account')[0]!.props.onPress();
    });
    // Reopening starts the survey over, and the confirmation behind it
    // carries no stale error.
    await skipSurvey(renderer);
    expect(allText(renderer)).not.toContain('Nothing was deleted.');
    expect(sheetButton(renderer, 'Continue to delete').props.disabled).toBe(
      false,
    );
    act(() => renderer.unmount());
  });

  it('every dismiss control is disabled while "Requesting…", and a late response for a closed sheet is dropped (reopening arms a fresh countdown that runs)', async () => {
    const pending = deferred<{ challenge: string; expiresAt: string }>();
    mockRequestAccountDeletion.mockReturnValue(pending.promise);
    const renderer = await openSheet();
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      await act(async () => {
        sheetButton(renderer, 'Continue to delete').props.onPress();
      });
      expect(sheetButton(renderer, 'Requesting…').props.disabled).toBe(true);
      expect(sheetButton(renderer, 'Keep my account').props.disabled).toBe(
        true,
      );
      // Backdrop cancel is disabled…
      expect(
        renderer.root
          .findAll(
            node => node.props.accessibilityLabel === 'Cancel account deletion',
          )
          .every(node => node.props.onPress === undefined),
      ).toBe(true);
      // …and so is the X during the busy phase: its Pressable `disabled`
      // gate is closed (Pressability never fires onPress while disabled) and
      // the state is announced to assistive tech.
      const closeControls = pressables(
        renderer,
        'Close account deletion confirmation',
      );
      expect(closeControls.length).toBeGreaterThan(0);
      expect(closeControls.every(node => node.props.disabled === true)).toBe(
        true,
      );
      const closeHost = renderer.root.findAll(
        node =>
          node.props.accessibilityLabel ===
            'Close account deletion confirmation' &&
          node.props.accessibilityState?.disabled === true,
      );
      expect(closeHost.length).toBeGreaterThan(0);
      // Android back is ignored while busy too.
      expect(renderer.root.findByType(Modal).props.onRequestClose).toBe(
        undefined,
      );
      expect(allText(renderer)).toContain('Delete your account?');

      // Because the sheet could not be dismissed mid-request, the response
      // arms the visible sheet and its countdown actually runs down to an
      // enabled "Permanently delete".
      await act(async () => {
        pending.resolve({
          challenge: 'challenge-1',
          expiresAt: '2026-08-31T00:00:00.000Z',
        });
      });
      const armed = sheetButton(renderer, 'Permanently delete');
      expect(armed.props.label).toBe('Permanently delete (5)');
      expect(armed.props.disabled).toBe(true);
      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });
      const ready = sheetButton(renderer, 'Permanently delete');
      expect(ready.props.label).toBe('Permanently delete');
      expect(ready.props.disabled).toBe(false);
      expect(sheetButton(renderer, 'Keep my account').props.disabled).toBe(
        false,
      );
      act(() => renderer.unmount());
    } finally {
      jest.useRealTimers();
    }
  });
});
