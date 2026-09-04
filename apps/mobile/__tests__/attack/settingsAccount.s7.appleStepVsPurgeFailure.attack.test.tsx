import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * ADVERSARIAL PASS 3 — mobile-settings-account, scenario S7.
 *
 * Server: `{ deleted: true, appleAuthorizationRevocation:
 * 'manual_action_required' }` (an older Apple account with no stored
 * revocation token — the user must detach the app under iPhone Settings →
 * Sign in with Apple themselves). Device: `completeAccountDeletion()` ends
 * with `deletionCleanup.localPurge === 'failed'`.
 *
 * Both facts need to reach the user: the Apple step is the ONLY way that
 * Apple ID stops listing a deleted app, and the purge failure is the only
 * way they learn to delete the app. ManageAccountScreen.tsx (onDeleted)
 * chooses with `if (purge failed) … else if (manual_action_required) …`,
 * and `BrandNoticeHost` shows one notice at a time (a second
 * `showBrandNotice` REPLACES the first), so the expected behaviour here is
 * "the presented notice text carries the Apple instruction" — however it is
 * combined. Assertions encode that expectation; a failure is the repro.
 *
 *   cd apps/mobile && npx jest --ci \
 *     __tests__/attack/settingsAccount.s7.appleStepVsPurgeFailure.attack.test.tsx
 */

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

const mockShowBrandNotice = jest.fn<void, [unknown]>();
jest.mock('../../src/design/BrandNotice', () => {
  const actual = jest.requireActual<
    typeof import('../../src/design/BrandNotice')
  >('../../src/design/BrandNotice');
  return {
    ...actual,
    showBrandNotice: (notice: unknown) => mockShowBrandNotice(notice),
  };
});

const mockRequestAccountDeletion = jest.fn<
  Promise<{ challenge: string; expiresAt: string }>,
  unknown[]
>();
const mockConfirmAccountDeletion = jest.fn<
  Promise<{
    appleAuthorizationRevocation:
      'revoked' | 'not_applicable' | 'manual_action_required';
  }>,
  unknown[]
>();
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

import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { Button } from '../../src/design/components';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';

/** Every renderer is unmounted in afterEach so a failed assertion cannot
 * leave a subscribed screen alive past the test (store updates in the next
 * test would re-render it after teardown). */
const mounted: TestRenderer.ReactTestRenderer[] = [];
function mount(element: React.ReactElement): TestRenderer.ReactTestRenderer {
  const renderer = TestRenderer.create(element);
  mounted.push(renderer);
  return renderer;
}
function unmountAll(): void {
  for (const renderer of mounted.splice(0)) {
    try {
      act(() => renderer.unmount());
    } catch {
      // already unmounted by the test
    }
  }
}

const appleSession: AuthSession = {
  provider: 'apple',
  subject: '22222222-2222-4222-8222-222222222222',
  canonicalAppUserId: '22222222-2222-4222-8222-222222222222',
  localOnly: false,
  displayName: 'Sam Rivera',
  email: 'sam@example.com',
};

interface CapturedNotice {
  title: string;
  detail: string;
  tone?: string;
  eyebrow?: string;
}

function notices(): CapturedNotice[] {
  return mockShowBrandNotice.mock.calls.map(call => call[0] as CapturedNotice);
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

/** Drives Delete account → skip survey → request → 5s hold → confirm. */
async function runDeletionToConfirm(
  purgeOutcome: 'complete' | 'failed' | 'not_needed',
  appleOutcome: 'revoked' | 'not_applicable' | 'manual_action_required',
) {
  mockRequestAccountDeletion.mockResolvedValue({
    challenge: 'challenge-s7',
    expiresAt: '2026-09-04T00:00:00.000Z',
  });
  mockConfirmAccountDeletion.mockResolvedValue({
    appleAuthorizationRevocation: appleOutcome,
  });
  useAuthStore.setState({
    hydrated: true,
    session: appleSession,
    busy: false,
    error: null,
    deletionCleanup: null,
    completeAccountDeletion: jest.fn(async () => {
      // Mirrors the real store: the session is gone and the cleanup verdict
      // is published before the promise resolves.
      useAuthStore.setState({
        session: null,
        deletionCleanup: { localPurge: purgeOutcome },
      });
    }),
  });

  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = mount(<ManageAccountScreen />);
  });
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
  await act(async () => {
    confirm.props.onPress();
  });
  // Let completeAccountDeletion().then(...) settle.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(useAuthStore.getState().completeAccountDeletion).toHaveBeenCalledTimes(
    1,
  );
  return renderer;
}

const APPLE_STEP_MARKER = 'Stop Using Apple ID';

describe('S7 — deleted:true + manual_action_required + local purge FAILED', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockShowBrandNotice.mockReset();
    mockRequestAccountDeletion.mockReset();
    mockConfirmAccountDeletion.mockReset();
  });
  afterEach(() => {
    unmountAll();
    jest.useRealTimers();
  });

  it('control: manual_action_required with a CLEAN purge shows the Apple step', async () => {
    const renderer = await runDeletionToConfirm(
      'complete',
      'manual_action_required',
    );
    const shown = notices();
    expect(shown).toHaveLength(1);
    expect(shown[0]!.detail).toContain(APPLE_STEP_MARKER);
    expect(shown[0]!.eyebrow).toBe('ONE APPLE STEP');
    act(() => renderer.unmount());
  });

  it('control: purge FAILED with Apple revoked shows the local-cleanup warning', async () => {
    const renderer = await runDeletionToConfirm('failed', 'revoked');
    const shown = notices();
    expect(shown).toHaveLength(1);
    expect(shown[0]!.eyebrow).toBe('LOCAL CLEANUP NEEDED');
    expect(shown[0]!.tone).toBe('danger');
    act(() => renderer.unmount());
  });

  it('ATTACK: purge FAILED + manual_action_required → the user is still told the Apple step', async () => {
    const renderer = await runDeletionToConfirm(
      'failed',
      'manual_action_required',
    );
    const shown = notices();
    expect(shown.length).toBeGreaterThan(0);
    // BrandNoticeHost keeps one notice at a time, so the LAST presented
    // notice is what the user reads. It must carry the Apple instruction
    // (either as a combined notice or because the Apple one is shown last).
    const last = shown[shown.length - 1]!;
    const everyDetail = shown.map(n => n.detail).join('\n');
    expect(everyDetail).toContain(APPLE_STEP_MARKER);
    expect(last.detail).toContain(APPLE_STEP_MARKER);
    // …and the purge warning must not be dropped to make room for it.
    expect(everyDetail).toContain('delete the app to clear it');
    act(() => renderer.unmount());
  });

  it('ATTACK: which notice wins today (documents the observed precedence)', async () => {
    const renderer = await runDeletionToConfirm(
      'failed',
      'manual_action_required',
    );
    const shown = notices();
    console.info(
      '[attack s7] notices presented:',
      JSON.stringify(shown.map(n => ({ eyebrow: n.eyebrow, tone: n.tone }))),
      'appleStepPresent=',
      shown.some(n => n.detail.includes(APPLE_STEP_MARKER)),
    );
    expect(shown.some(n => n.detail.includes(APPLE_STEP_MARKER))).toBe(true);
    act(() => renderer.unmount());
  });

  it('control: revoked + clean purge shows NO notice at all (quiet success path)', async () => {
    const renderer = await runDeletionToConfirm('complete', 'revoked');
    expect(notices()).toHaveLength(0);
    act(() => renderer.unmount());
  });
});
