import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * AUDIT PROBES (structural #2, mobile-settings-account) — verified-good
 * candidates around deletion teardown.
 *
 * 1. completeAccountDeletion when the owner purge fails on every attempt AND
 *    the Keychain reset throws: must still resolve, sign the runtime out,
 *    and report localPurge:'failed'.
 * 2. Unmount of ManageAccountScreen while the sheet is in 'deleting': the
 *    confirm response still drives completeAccountDeletion exactly once
 *    (teardown must not lose the deletion outcome) and no state update
 *    lands on the unmounted dialog.
 * 3. Challenge expiry: dialog left armed past expiresAt; server answers 403
 *    → non-retryable → sheet returns to 'review' with the server's message,
 *    nothing deleted.
 */

const mockExecuted: Array<{ sql: string }> = [];
let mockFailOn: ((sql: string) => boolean) | null = null;
jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    execute: async (sql: string, params: unknown[] = []) => {
      mockExecuted.push({ sql });
      void params;
      if (mockFailOn?.(sql)) throw new Error(`sqlite: ${sql}`);
      return { rows: [] };
    },
    close: () => undefined,
  }),
}));

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
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

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
}));

const mockShowBrandNotice = jest.fn();
jest.mock('../../src/design/BrandNotice', () => {
  const actual = jest.requireActual<
    typeof import('../../src/design/BrandNotice')
  >('../../src/design/BrandNotice');
  return {
    ...actual,
    showBrandNotice: (...args: unknown[]) => mockShowBrandNotice(...args),
  };
});

const mockRequestAccountDeletion = jest.fn<
  Promise<{ challenge: string; expiresAt: string }>,
  unknown[]
>();
const mockConfirmAccountDeletion = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../../src/account/deletion', () => {
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

import * as Keychain from 'react-native-keychain';
import { Text } from 'react-native';
import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { Button } from '../../src/design/components';
import { AccountDeletionError } from '../../src/account/deletion';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  SESSION_VAULT_SERVICE,
  savePersistedSession,
} from '../../src/account/sessionVault';
import {
  getActiveDataOwner,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

const OWNER = '11111111-1111-4111-8111-111111111111';
const session: AuthSession = {
  provider: 'apple',
  subject: 'apple-subject',
  canonicalAppUserId: OWNER,
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

function pressable(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  )[0]!;
}

function sheetButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = renderer.root
    .findAllByType(Button)
    .filter(node => String(node.props.label).startsWith(label));
  return matches[0] ?? null;
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

async function armDialog(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    pressable(renderer, 'Delete account').props.onPress();
  });
  await act(async () => {
    pressable(renderer, 'Skip the survey').props.onPress();
  });
  await act(async () => {
    sheetButton(renderer, 'Continue to delete')!.props.onPress();
  });
  await act(async () => {
    jest.advanceTimersByTime(5_000);
  });
}

beforeEach(() => {
  mockExecuted.length = 0;
  mockFailOn = null;
  __keychainStore.clear();
  mockShowBrandNotice.mockReset();
  mockRequestAccountDeletion.mockReset();
  mockConfirmAccountDeletion.mockReset();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('AUDIT 1: completeAccountDeletion with purge failing 3× and Keychain reset throwing', () => {
  it('still resolves signed-out and reports localPurge failed', async () => {
    await savePersistedSession({
      version: 1,
      provider: 'apple',
      canonicalAppUserId: OWNER,
      refreshToken: 'refresh-token',
      displayName: 'Alex Chen',
      email: 'alex@example.com',
    });
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(true);
    const resetSpy = jest
      .spyOn(Keychain, 'resetGenericPassword')
      .mockRejectedValue(new Error('keychain locked'));
    mockFailOn = sql => sql.startsWith('DELETE FROM') || sql === 'BEGIN';
    useAuthStore.setState({ session, hydrated: true, deletionCleanup: null });
    setActiveDataOwner(OWNER);

    const outcome = await useAuthStore
      .getState()
      .completeAccountDeletion()
      .then(
        () => 'resolved',
        e => `rejected:${String(e)}`,
      );
    const state = useAuthStore.getState();
    console.log(
      JSON.stringify({
        probe: 'deletion-cleanup-double-failure',
        outcome,
        session: state.session,
        deletionCleanup: state.deletionCleanup,
        activeOwner: getActiveDataOwner(),
        resetCalls: resetSpy.mock.calls.length,
      }),
    );
    const resetCalls = resetSpy.mock.calls.length;
    resetSpy.mockRestore();
    expect(outcome).toBe('resolved');
    expect(state.session).toBeNull();
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(state.deletionCleanup?.localPurge).toBe('failed');
    expect(resetCalls).toBe(1);
  });
});

describe('AUDIT 2/3: ManageAccountScreen teardown and challenge expiry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    useAuthStore.setState({
      hydrated: true,
      session,
      busy: false,
      error: null,
      deletionCleanup: null,
      completeAccountDeletion: jest.fn(() => Promise.resolve()),
    });
  });
  afterEach(() => jest.useRealTimers());

  it('unmount during deleting: the confirm outcome still completes deletion once, without warnings', async () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    mockRequestAccountDeletion.mockResolvedValue({
      challenge: 'c1',
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    let resolveConfirm!: (v: unknown) => void;
    mockConfirmAccountDeletion.mockImplementation(
      () => new Promise(resolve => (resolveConfirm = resolve)),
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<ManageAccountScreen />);
    });
    await armDialog(renderer);
    await act(async () => {
      sheetButton(renderer, 'Permanently delete')!.props.onPress();
    });
    expect(mockConfirmAccountDeletion).toHaveBeenCalledTimes(1);
    // The auth gate (or navigation) tears the screen down mid-request.
    act(() => renderer.unmount());
    await act(async () => {
      resolveConfirm({
        deleted: true,
        appleAuthorizationRevocation: 'revoked',
      });
      await Promise.resolve();
    });
    const calls = (useAuthStore.getState().completeAccountDeletion as jest.Mock)
      .mock.calls.length;
    const errors = consoleError.mock.calls.map(c => String(c[0]));
    consoleError.mockRestore();
    console.log(
      JSON.stringify({
        probe: 'deletion-unmount-during-deleting',
        completeAccountDeletionCalls: calls,
        consoleErrors: errors,
      }),
    );
    expect(calls).toBe(1);
    expect(errors).toHaveLength(0);
  });

  it('expired challenge (403 on confirm): sheet returns to review with the server message, no cleanup', async () => {
    mockRequestAccountDeletion.mockResolvedValue({
      challenge: 'c1',
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    mockConfirmAccountDeletion.mockRejectedValue(
      new AccountDeletionError(
        'deletion.rejected',
        'The deletion request expired. Start again from Settings.',
        false,
      ),
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<ManageAccountScreen />);
    });
    await armDialog(renderer);
    // Leave the sheet armed past the 15-minute server expiry.
    await act(async () => {
      jest.advanceTimersByTime(16 * 60_000);
    });
    await act(async () => {
      sheetButton(renderer, 'Permanently delete')!.props.onPress();
    });
    const copy = allText(renderer);
    const calls = (useAuthStore.getState().completeAccountDeletion as jest.Mock)
      .mock.calls.length;
    console.log(
      JSON.stringify({
        probe: 'deletion-challenge-expiry-403',
        backOnReview: sheetButton(renderer, 'Continue to delete') !== null,
        permanentlyDeleteVisible:
          sheetButton(renderer, 'Permanently delete') !== null,
        copyHasServerMessage: copy.includes('The deletion request expired'),
        completeAccountDeletionCalls: calls,
      }),
    );
    expect(sheetButton(renderer, 'Continue to delete')).not.toBeNull();
    expect(sheetButton(renderer, 'Permanently delete')).toBeNull();
    expect(copy).toContain('The deletion request expired');
    expect(calls).toBe(0);
    act(() => renderer.unmount());
  });
});
