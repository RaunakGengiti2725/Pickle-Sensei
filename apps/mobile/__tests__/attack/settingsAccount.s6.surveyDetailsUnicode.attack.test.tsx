import React from 'react';
import { Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * ADVERSARIAL PASS 3 — mobile-settings-account, scenario S6 (client half;
 * the edge half is supabase/functions/api/__wf__/attack_settings_account_pass3/).
 *
 * The exit-survey comment field declares `maxLength={ACCOUNT_DELETION_DETAILS_MAX}`
 * (500) and renders `${details.length}/500`. `TextInput.maxLength` is a NATIVE
 * guard; the JS layer performs no truncation of its own before `buildSurvey`
 * puts `details` on the wire (ManageAccountScreen.tsx buildSurvey → trim only).
 * Here `onChangeText` delivers what the native side would have to refuse —
 * 500 multibyte emoji (1000 UTF-16 units) and 600 ASCII chars — and we
 * observe what the app sends and what the counter shows. The real
 * `src/account/deletion.ts` runs against a scripted `fetch`.
 *
 *   cd apps/mobile && npx jest --ci \
 *     __tests__/attack/settingsAccount.s6.surveyDetailsUnicode.attack.test.tsx
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

import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { Button } from '../../src/design/components';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import { ACCOUNT_DELETION_DETAILS_MAX } from '../../src/account/deletion';

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

const OWNER = '66666666-6666-4666-8666-666666666666';
const API = 'https://api.attack.invalid/functions/v1/api';

const session: AuthSession = {
  provider: 'google',
  subject: OWNER,
  canonicalAppUserId: OWNER,
  localOnly: false,
  displayName: 'Uni Code',
  email: 'uni@example.com',
};

/** Deterministic emoji sequence (seed noted in the log). */
function seededEmoji(count: number, seed: number): string {
  const palette = ['😀', '🎾', '🏓', '🥒', '🔥', '💯', '🙌', '🤝'];
  let x = seed >>> 0;
  let out = '';
  for (let i = 0; i < count; i += 1) {
    x = (x * 1_664_525 + 1_013_904_223) >>> 0;
    out += palette[x % palette.length]!;
  }
  return out;
}

const SEED = 20260904;
const EMOJI_500 = seededEmoji(500, SEED);
const ASCII_600 = Array.from({ length: 600 }, (_, i) =>
  String.fromCharCode(97 + (i % 26)),
).join('');

function codePoints(s: string): number {
  return Array.from(s).length;
}

interface WireCall {
  url: string;
  body: string | null;
}

function installFetch(): WireCall[] {
  const calls: WireCall[] = [];
  (globalThis as { fetch: unknown }).fetch = jest.fn(
    async (input: unknown, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: typeof init?.body === 'string' ? init.body : null,
      });
      return new Response(
        JSON.stringify({ challenge: 'c-1', expiresAt: 'x' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  );
  return calls;
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

async function typeCommentAndRequest(
  renderer: TestRenderer.ReactTestRenderer,
  comment: string,
) {
  await act(async () => {
    pressable(renderer, 'Delete account')[0]!.props.onPress();
  });
  await act(async () => {
    pressable(renderer, "It's too expensive")[0]!.props.onPress();
  });
  await act(async () => {
    sheetButton(renderer, 'Next').props.onPress();
  });
  const input = renderer.root.findByType(TextInput);
  expect(input.props.maxLength).toBe(ACCOUNT_DELETION_DETAILS_MAX);
  await act(async () => {
    input.props.onChangeText(comment);
  });
  const counter = allText(renderer).match(/(\d+)\/500/)?.[1] ?? null;
  await act(async () => {
    sheetButton(renderer, 'Continue').props.onPress();
  });
  await act(async () => {
    sheetButton(renderer, 'Continue to delete').props.onPress();
  });
  return counter;
}

function wireDetails(calls: WireCall[]): string | null {
  const request = calls.find(c => c.url.endsWith('/v1/me/delete-request'));
  expect(request).toBeDefined();
  const body = JSON.parse(request!.body ?? '{}') as {
    survey?: { details?: string | null };
  };
  return body.survey?.details ?? null;
}

describe('S6 (client) — exit-survey details: 500 emoji / 600 chars', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    jest.useFakeTimers();
    establishApiSession({
      apiBaseUrl: API,
      bearerToken: 'bearer-owner',
      canonicalAppUserId: OWNER,
      provider: 'google',
    });
    useAuthStore.setState({
      hydrated: true,
      session,
      busy: false,
      error: null,
      deletionCleanup: null,
      completeAccountDeletion: jest.fn(() => Promise.resolve()),
    });
  });
  afterEach(() => {
    unmountAll();
    jest.useRealTimers();
    clearApiSession();
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  it('precondition: ACCOUNT_DELETION_DETAILS_MAX is 500 and the field declares it as maxLength', async () => {
    expect(ACCOUNT_DELETION_DETAILS_MAX).toBe(500);
    installFetch();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = mount(<ManageAccountScreen />);
    });
    await typeCommentAndRequest(renderer, 'ok');
    act(() => renderer.unmount());
  });

  it('500 emoji (1000 UTF-16 units, 500 code points): wire carries ≤ 500 code points and the counter does not exceed 500', async () => {
    expect(EMOJI_500.length).toBe(1000);
    expect(codePoints(EMOJI_500)).toBe(500);
    const calls = installFetch();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = mount(<ManageAccountScreen />);
    });
    const counter = await typeCommentAndRequest(renderer, EMOJI_500);
    const details = wireDetails(calls);
    console.info(
      `[attack s6] seed=${SEED} emoji500: counter=${counter}/500 wire.utf16=${details?.length} wire.codePoints=${details ? codePoints(details) : null}`,
    );
    expect(details).not.toBeNull();
    expect(codePoints(details!)).toBeLessThanOrEqual(
      ACCOUNT_DELETION_DETAILS_MAX,
    );
    // The counter is the user's only signal of the cap; it must agree with
    // the unit the cap is enforced in (server: code points).
    expect(Number(counter)).toBeLessThanOrEqual(ACCOUNT_DELETION_DETAILS_MAX);
    act(() => renderer.unmount());
  });

  it('600 ASCII chars delivered past the native guard: the client truncates to 500 before the wire', async () => {
    const calls = installFetch();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = mount(<ManageAccountScreen />);
    });
    const counter = await typeCommentAndRequest(renderer, ASCII_600);
    const details = wireDetails(calls);
    console.info(
      `[attack s6] ascii600: counter=${counter}/500 wire.length=${details?.length}`,
    );
    expect(details).not.toBeNull();
    expect(details!.length).toBeLessThanOrEqual(ACCOUNT_DELETION_DETAILS_MAX);
    act(() => renderer.unmount());
  });

  it('600 emoji (1200 UTF-16 units): wire carries ≤ 500 code points', async () => {
    const calls = installFetch();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = mount(<ManageAccountScreen />);
    });
    await typeCommentAndRequest(renderer, seededEmoji(600, SEED + 1));
    const details = wireDetails(calls);
    expect(details).not.toBeNull();
    expect(codePoints(details!)).toBeLessThanOrEqual(
      ACCOUNT_DELETION_DETAILS_MAX,
    );
    act(() => renderer.unmount());
  });

  it('whitespace-only / control-only comment is sent as null (server would store null anyway)', async () => {
    const calls = installFetch();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = mount(<ManageAccountScreen />);
    });
    await typeCommentAndRequest(renderer, '   \n\t  ');
    expect(wireDetails(calls)).toBeNull();
    act(() => renderer.unmount());
  });
});
