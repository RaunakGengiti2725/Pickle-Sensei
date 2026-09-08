/**
 * INT-ui-flows-a11y adversary — ManageAccount deletion: copy rules and
 * double actions.
 *
 * Attack 1: the notice raised after a confirmed deletion is user-facing copy
 * on an iPhone-only product; APP_STORE_SUBMISSION.md forbids Android /
 * Google Play references anywhere a user can read them.
 *
 * Attack 2: "Permanently delete" is pressed twice in the same tick while the
 * confirm request is still in flight; the server must be asked exactly once
 * and cleanup must run exactly once.
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
const mockShowBrandNotice = jest.fn();
jest.mock('../../src/design/BrandNotice', () => ({
  showBrandNotice: (notice: unknown) => mockShowBrandNotice(notice),
}));
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

import React from 'react';
import { Platform, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { Button } from '../../src/design/components';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import { establishApiSession } from '../../src/account/apiSession';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';

const PROHIBITED_COPY = [
  /\bAndroid\b/,
  /Google Play/,
  /guest mode/i,
  /Live Court/,
  /\bDUPR\b/,
  /SwingVision|PB Vision|Selkirk|JOOLA/,
];

const syncedSession: AuthSession = {
  provider: 'apple',
  subject: '11111111-1111-4111-8111-111111111111',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};
const apiSession = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'access-token',
  canonicalAppUserId: syncedSession.canonicalAppUserId!,
  provider: 'apple' as const,
};

function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<ManageAccountScreen />);
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

function pressable(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable labeled ${label}`);
  return node;
}

function sheetButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const [node] = renderer.root
    .findAllByType(Button)
    .filter(n => String(n.props.label).startsWith(label));
  if (!node) throw new Error(`No sheet button labeled ${label}`);
  return node;
}

async function armDeletion(renderer: TestRenderer.ReactTestRenderer) {
  mockRequestAccountDeletion.mockResolvedValue({
    challenge: 'captured-challenge',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  await act(async () => {
    pressable(renderer, 'Delete account').props.onPress();
  });
  await act(async () => {
    pressable(renderer, 'Skip the survey').props.onPress();
  });
  await act(async () => {
    sheetButton(renderer, 'Continue to delete').props.onPress();
  });
  await act(async () => {
    jest.advanceTimersByTime(5_000);
  });
}

function collectProhibited(text: string): string[] {
  return PROHIBITED_COPY.filter(re => re.test(text)).map(String);
}

describe('adv: ManageAccount deletion copy + double confirm', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockGoBack.mockClear();
    mockShowBrandNotice.mockClear();
    mockRequestAccountDeletion.mockReset();
    mockConfirmAccountDeletion.mockReset();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    setActiveDataOwner(apiSession.canonicalAppUserId);
    establishApiSession(apiSession);
    useAuthStore.setState({
      hydrated: true,
      session: syncedSession,
      busy: false,
      error: null,
      completeAccountDeletion: jest.fn(() => Promise.resolve()),
    });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs under the iOS platform (precondition for every copy assertion below)', () => {
    expect(Platform.OS).toBe('ios');
  });

  it('never shows Android / Google Play copy on the ManageAccount surface or its deletion sheet', async () => {
    const renderer = renderScreen();
    try {
      expect(collectProhibited(allText(renderer))).toEqual([]);
      await armDeletion(renderer);
      expect(collectProhibited(allText(renderer))).toEqual([]);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('confirmed-deletion notice contains no Android / Google Play reference (iPhone-only copy rule)', async () => {
    mockConfirmAccountDeletion.mockResolvedValue(undefined);
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await act(async () => {
        sheetButton(renderer, 'Permanently delete').props.onPress();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockShowBrandNotice).toHaveBeenCalledTimes(1);
      const notice = mockShowBrandNotice.mock.calls[0]![0] as {
        title: string;
        detail: string;
        eyebrow?: string;
      };
      expect(notice.eyebrow).toBe('DELETION CONFIRMED');
      const noticeText = `${notice.title} ${notice.detail} ${notice.eyebrow ?? ''}`;
      expect(collectProhibited(noticeText)).toEqual([]);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('two same-tick presses on Permanently delete confirm once and clean up once', async () => {
    let resolveConfirm!: () => void;
    mockConfirmAccountDeletion.mockReturnValue(
      new Promise<void>(res => {
        resolveConfirm = res;
      }),
    );
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await act(async () => {
        const button = sheetButton(renderer, 'Permanently delete');
        button.props.onPress();
        button.props.onPress();
      });
      expect(mockConfirmAccountDeletion).toHaveBeenCalledTimes(1);
      expect(sheetButton(renderer, 'Permanently delete').props.disabled).toBe(
        true,
      );
      await act(async () => {
        resolveConfirm();
        await Promise.resolve();
      });
      expect(mockConfirmAccountDeletion).toHaveBeenCalledTimes(1);
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).toHaveBeenCalledTimes(1);
      expect(mockShowBrandNotice).toHaveBeenCalledTimes(1);
    } finally {
      act(() => renderer.unmount());
    }
  });
});
