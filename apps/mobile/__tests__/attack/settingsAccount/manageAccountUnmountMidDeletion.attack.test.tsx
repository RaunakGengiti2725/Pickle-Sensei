import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * ADVERSARIAL PASS 3 / tester #4 — scenario 7 (ManageAccount unmounts while
 * `confirmDeletion` is in flight).
 *
 * The player taps "Permanently delete", the POST /v1/me/delete-confirm is
 * slow, and they leave the screen (header back / gesture) before it lands.
 * The server account IS deleted, so the local completion
 * (`completeAccountDeletion`: purge the owner's rows, forget the Keychain
 * record, disconnect the provider) MUST still run — exactly once — and the
 * follow-up `showBrandNotice` (fired against a tree with no BrandNoticeHost
 * mounted) must not throw or surface an unhandled rejection.
 *
 * Extras: a double-tap on the final button, a rejection landing after
 * unmount, and a re-opened dialog racing a stale confirm.
 */

jest.mock('../../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

jest.mock('../../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => insets,
    initialWindowMetrics: null,
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
const mockConfirmAccountDeletion = jest.fn<
  Promise<AccountDeletionResult>,
  unknown[]
>();
jest.mock('../../../src/account/deletion', () => {
  const actual = jest.requireActual<
    typeof import('../../../src/account/deletion')
  >('../../../src/account/deletion');
  return {
    ...actual,
    requestAccountDeletion: (...args: unknown[]) =>
      mockRequestAccountDeletion(...args),
    confirmAccountDeletion: (...args: unknown[]) =>
      mockConfirmAccountDeletion(...args),
  };
});

const mockShowBrandNotice = jest.fn();
jest.mock('../../../src/design/BrandNotice', () => {
  const actual = jest.requireActual<
    typeof import('../../../src/design/BrandNotice')
  >('../../../src/design/BrandNotice');
  return {
    ...actual,
    showBrandNotice: (...args: unknown[]) => {
      mockShowBrandNotice(...args);
      // Run the real one too: with no BrandNoticeHost mounted it must only
      // park the notice, never throw.
      return (actual.showBrandNotice as (...a: unknown[]) => void)(...args);
    },
  };
});

import type { AccountDeletionResult } from '../../../src/account/deletion';
import { ManageAccountScreen } from '../../../src/screens/ManageAccountScreen';
import { Button } from '../../../src/design/components';
import { useAuthStore, type AuthSession } from '../../../src/auth/authStore';

const syncedSession: AuthSession = {
  provider: 'apple',
  subject: '11111111-1111-4111-8111-111111111111',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<ManageAccountScreen />);
  });
  return renderer;
}

function pressable(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
}

function sheetButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = renderer.root
    .findAllByType(Button)
    .filter(node => String(node.props.label).startsWith(label));
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

/** Drives the dialog to the armed, tappable "Permanently delete" button. */
async function armDeletion(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    pressable(renderer, 'Delete account')[0]!.props.onPress();
  });
  await act(async () => {
    pressable(renderer, 'Skip the survey')[0]!.props.onPress();
  });
  await act(async () => {
    sheetButton(renderer, 'Continue to delete').props.onPress();
  });
  await act(async () => {
    jest.advanceTimersByTime(5_000);
  });
  const confirm = sheetButton(renderer, 'Permanently delete');
  expect(confirm.props.disabled).toBe(false);
  return confirm;
}

declare const process: {
  on: (event: 'unhandledRejection', handler: (reason: unknown) => void) => void;
  off: (
    event: 'unhandledRejection',
    handler: (reason: unknown) => void,
  ) => void;
};

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

let completeCalls = 0;
let resolveComplete: (() => void) | null = null;

describe('scenario 7 — unmount ManageAccountScreen while confirmDeletion is in flight', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    unhandled.length = 0;
    completeCalls = 0;
    resolveComplete = null;
    process.on('unhandledRejection', onUnhandled);
    mockGoBack.mockClear();
    mockShowBrandNotice.mockClear();
    mockRequestAccountDeletion.mockReset();
    mockConfirmAccountDeletion.mockReset();
    mockRequestAccountDeletion.mockResolvedValue({
      challenge: 'challenge-1',
      expiresAt: '2026-08-31T00:00:00.000Z',
    });
    useAuthStore.setState({
      hydrated: true,
      session: syncedSession,
      busy: false,
      error: null,
      deletionCleanup: null,
      completeAccountDeletion: jest.fn(() => {
        completeCalls += 1;
        return new Promise<void>(resolve => {
          resolveComplete = resolve;
        });
      }),
    });
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    jest.useRealTimers();
  });

  it('success after unmount: completeAccountDeletion runs exactly once, the LOCAL CLEANUP notice does not throw', async () => {
    let resolveConfirm!: (result: AccountDeletionResult) => void;
    mockConfirmAccountDeletion.mockImplementation(
      () =>
        new Promise<AccountDeletionResult>(resolve => {
          resolveConfirm = resolve;
        }),
    );
    const renderer = renderScreen();
    const confirm = await armDeletion(renderer);
    await act(async () => {
      confirm.props.onPress();
    });
    expect(mockConfirmAccountDeletion).toHaveBeenCalledTimes(1);
    expect(sheetButton(renderer, 'Deleting…').props.disabled).toBe(true);
    // "Keep my account" is disabled mid-flight, so the only way out is the
    // header back / swipe: the whole screen unmounts.
    expect(sheetButton(renderer, 'Keep my account').props.disabled).toBe(true);
    act(() => renderer.unmount());
    expect(completeCalls).toBe(0);

    // The server finishes the deletion after the screen is gone.
    await act(async () => {
      resolveConfirm({
        appleAuthorizationRevocation: 'manual_action_required',
      });
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(completeCalls).toBe(1);

    // Local purge reports failure → the danger notice is shown on a tree
    // with no host mounted: it must park, not throw.
    useAuthStore.setState({ deletionCleanup: { localPurge: 'failed' } });
    await act(async () => {
      resolveComplete!();
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(mockShowBrandNotice).toHaveBeenCalledTimes(1);
    expect(mockShowBrandNotice.mock.calls[0]![0]).toMatchObject({
      eyebrow: 'LOCAL CLEANUP NEEDED',
      tone: 'danger',
    });
    expect(unhandled).toEqual([]);
    expect(completeCalls).toBe(1);
  });

  it('rejection after unmount: nothing is purged, nothing throws, no notice', async () => {
    let rejectConfirm!: (reason: unknown) => void;
    mockConfirmAccountDeletion.mockImplementation(
      () =>
        new Promise<AccountDeletionResult>((_, reject) => {
          rejectConfirm = reject;
        }),
    );
    const renderer = renderScreen();
    const confirm = await armDeletion(renderer);
    await act(async () => {
      confirm.props.onPress();
    });
    act(() => renderer.unmount());
    await act(async () => {
      rejectConfirm(new TypeError('Network request failed'));
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(completeCalls).toBe(0);
    expect(mockShowBrandNotice).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
    // Session untouched: the server never confirmed.
    expect(useAuthStore.getState().session).toEqual(syncedSession);
  });

  it('double-tap on "Permanently delete" sends exactly one confirm', async () => {
    let resolveConfirm!: (result: AccountDeletionResult) => void;
    mockConfirmAccountDeletion.mockImplementation(
      () =>
        new Promise<AccountDeletionResult>(resolve => {
          resolveConfirm = resolve;
        }),
    );
    const renderer = renderScreen();
    const confirm = await armDeletion(renderer);
    act(() => {
      confirm.props.onPress();
    });
    // Second discrete tap lands on the re-rendered (disabled) button.
    act(() => {
      const button = sheetButton(renderer, 'Deleting…');
      expect(button.props.disabled).toBe(true);
      button.props.onPress();
    });
    expect(mockConfirmAccountDeletion).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveConfirm({ appleAuthorizationRevocation: 'revoked' });
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(completeCalls).toBe(1);
    await act(async () => {
      resolveComplete!();
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(mockShowBrandNotice).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
    act(() => renderer.unmount());
  });

  it('busy dialog cannot be dismissed (no onRequestClose); a network rejection re-arms retry without purging', async () => {
    let rejectFirst!: (reason: unknown) => void;
    mockConfirmAccountDeletion.mockImplementationOnce(
      () =>
        new Promise<AccountDeletionResult>((_, reject) => {
          rejectFirst = reject;
        }),
    );
    const renderer = renderScreen();
    const confirm = await armDeletion(renderer);
    await act(async () => {
      confirm.props.onPress();
    });
    // Force-close the dialog from the parent (what a navigation reset or a
    // sign-out elsewhere does) while the confirm is in flight.
    // The dialog exposes no cancel while busy, so drive Modal's
    // onRequestClose contract: it is undefined while busy.
    const modal = renderer.root.findAll(
      node => node.props.visible === true && 'onRequestClose' in node.props,
    )[0];
    expect(modal).toBeDefined();
    expect(modal!.props.onRequestClose).toBeUndefined();

    // Stale rejection lands: the dialog is still open, so it shows the
    // retry state — but must NOT re-arm a challenge that the server may
    // have consumed.
    await act(async () => {
      rejectFirst(new TypeError('Network request failed'));
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    const retry = sheetButton(renderer, 'Permanently delete');
    expect(retry.props.disabled).toBe(false);
    expect(completeCalls).toBe(0);
    expect(unhandled).toEqual([]);
    act(() => renderer.unmount());
  });
});
