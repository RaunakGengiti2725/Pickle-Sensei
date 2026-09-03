import React from 'react';
import { Modal, Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * End-to-end drive of the account-deletion flow as a user would tap it
 * (App Review 5.1.1(v)): Settings → Manage account → quiet "Delete account"
 * link → two-question exit survey (always skippable) → two-step confirmation
 * (request → 5s armed countdown → confirm) → local purge/sign-out. Unlike
 * manageAccountScreen.test.tsx this suite runs the REAL
 * `src/account/deletion` client against a stubbed `fetch`, so the wire shape
 * (survey body or none) and the failure copy the user sees come from the
 * production mapping.
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

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack, navigate: mockNavigate }),
  // Settings re-reads the free-rating ledger on every focus; a mount is the
  // first focus.
  useFocusEffect: (callback: () => void | (() => void)) => {
    const React = jest.requireActual<typeof import('react')>('react');
    React.useEffect(() => callback(), [callback]);
  },
}));

// Settings pulls the scoring stack descriptor from the vision providers; the
// real module drags in every geometry package, irrelevant to this flow.
jest.mock('../../src/vision/providers', () => ({
  scoringStackStatus: () => ({ version: 'test-stack' }),
}));
jest.mock('../../src/review/appStoreReview', () => ({
  rateAppFromSettings: jest.fn(() => Promise.resolve()),
}));

import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { SettingsScreen } from '../../src/screens/SettingsScreen';
import { BrandSpinner, Button } from '../../src/design/components';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import { useConsentStore } from '../../src/state/consentStore';

const API_BASE = 'https://api.example.test/functions/v1/api';
const OWNER = '11111111-1111-4111-8111-111111111111';

const syncedSession: AuthSession = {
  provider: 'google',
  subject: OWNER,
  canonicalAppUserId: OWNER,
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

type FetchCall = { url: string; init: RequestInit | undefined };

// Minimal Response stand-in: Node's undici Response.json() schedules work
// on process.nextTick/queueMicrotask, which jest fake timers intercept and
// leave hanging across tests.
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function textResponse(status: number, text: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.reject(new SyntaxError(`not json: ${text}`)),
  } as unknown as Response;
}

/** Scripted fetch: each call pops the next responder; records every call. */
function scriptFetch(
  responders: Array<(call: FetchCall) => Promise<Response>>,
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const queue = [...responders];
  globalThis.fetch = jest.fn(async (input: unknown, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    const responder = queue.shift();
    if (!responder) throw new Error(`unexpected fetch ${call.url}`);
    return responder(call);
  }) as unknown as typeof fetch;
  return { calls };
}

const realFetch = globalThis.fetch;

// React's async `act` lazily captures `setImmediate` on first use; if that
// happens under fully-faked timers, every later real-timer `act` hangs. Keep
// the task-scheduling primitives real and fake only the wall clock/intervals.
function useCountdownTimers() {
  jest.useFakeTimers({
    doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
  });
}

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

/** Labelled controls as the screen reader sees them (host nodes only). */
function byLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' && node.props.accessibilityLabel === label,
  );
}

function hostByLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = byLabel(renderer, label);
  expect(matches.length).toBe(1);
  return matches[0]!;
}

/** The innermost composite carrying the control's `onPress` (RN Pressable). */
function control(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = renderer.root.findAll(
    node =>
      typeof node.type !== 'string' &&
      node.props.accessibilityLabel === label &&
      'onPress' in node.props,
  );
  expect(matches.length).toBeGreaterThan(0);
  return matches[matches.length - 1]!;
}

function sheetButtons(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root
    .findAllByType(Button)
    .filter(node => String(node.props.label).startsWith(label));
}

function sheetButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = sheetButtons(renderer, label);
  expect(matches.length).toBe(1);
  return matches[0]!;
}

function sheetVisible(renderer: TestRenderer.ReactTestRenderer): boolean {
  return renderer.root.findByType(Modal).props.visible === true;
}

/** Tap the link: the dialog opens on exit-survey question 1. */
async function openSurvey(renderer: TestRenderer.ReactTestRenderer) {
  expect(byLabel(renderer, 'Delete account')).toHaveLength(1);
  await act(async () => {
    control(renderer, 'Delete account').props.onPress();
  });
  expect(sheetVisible(renderer)).toBe(true);
  expect(allText(renderer)).toContain("What's making you leave?");
  expect(allText(renderer)).not.toContain('Delete your account?');
}

/** Open the dialog and skip the survey straight to the confirmation page. */
async function openSheet(renderer: TestRenderer.ReactTestRenderer) {
  await openSurvey(renderer);
  await act(async () => {
    control(renderer, 'Skip the survey').props.onPress();
  });
  expect(allText(renderer)).toContain('Delete your account?');
}

async function pressContinue(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    sheetButton(renderer, 'Continue to delete').props.onPress();
  });
}

function armedResponders() {
  return [
    async () =>
      jsonResponse(200, {
        challenge: '33333333-3333-4333-8333-333333333333',
        expiresAt: '2099-01-01T00:00:00.000Z',
      }),
  ];
}

beforeEach(() => {
  mockGoBack.mockClear();
  mockNavigate.mockClear();
  useAuthStore.setState({
    hydrated: true,
    session: syncedSession,
    busy: false,
    error: null,
    completeAccountDeletion: jest.fn(() => Promise.resolve()),
  });
  establishApiSession({
    apiBaseUrl: API_BASE,
    bearerToken: 'provider-token',
    canonicalAppUserId: OWNER,
    provider: 'google',
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  jest.useRealTimers();
  clearApiSession();
});

describe('Settings → Manage account entry point', () => {
  beforeEach(() => {
    useConsentStore.setState({
      availability: 'ready',
      modelTrainingActive: false,
      busy: false,
      error: null,
      hydrate: jest.fn(() => Promise.resolve()),
    });
  });

  it('synced sessions get a "Manage account" row that navigates to ManageAccount', () => {
    const renderer = render(<SettingsScreen />);
    const row = byLabel(renderer, 'Manage account, Details');
    expect(row).toHaveLength(1);
    expect(
      hostByLabel(renderer, 'Manage account, Details').props.accessibilityRole,
    ).toBe('button');
    act(() => {
      control(renderer, 'Manage account, Details').props.onPress();
    });
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('ManageAccount');
    // Deletion itself is NOT on the Settings root (one level deep by design).
    expect(byLabel(renderer, 'Delete account')).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('guest (local-only) sessions never see the Manage account row', () => {
    useAuthStore.setState({ session: guestSession });
    const renderer = render(<SettingsScreen />);
    expect(byLabel(renderer, 'Manage account, Details')).toHaveLength(0);
    expect(allText(renderer)).not.toContain('Manage account');
    act(() => renderer.unmount());
  });
});

describe('ManageAccount screen chrome', () => {
  it('back control returns to Settings; delete link is a labelled button', () => {
    const renderer = render(<ManageAccountScreen />);
    const back = byLabel(renderer, 'Back');
    expect(back).toHaveLength(1);
    act(() => {
      control(renderer, 'Back').props.onPress();
    });
    expect(mockGoBack).toHaveBeenCalledTimes(1);

    const link = byLabel(renderer, 'Delete account');
    expect(link).toHaveLength(1);
    const linkHost = hostByLabel(renderer, 'Delete account');
    expect(linkHost.props.accessibilityRole).toBe('button');
    expect(linkHost.props.accessibilityState?.disabled).toBeFalsy();
    expect(hostByLabel(renderer, 'Back').props.accessibilityRole).toBe(
      'button',
    );
    // Account details reflect the live session.
    const copy = allText(renderer);
    expect(copy).toContain('Alex Chen');
    expect(copy).toContain('alex@example.com');
    expect(copy).toContain('Google');
    expect(sheetVisible(renderer)).toBe(false);
    act(() => renderer.unmount());
  });

  it('local-only sessions get no deletion link at all', () => {
    useAuthStore.setState({ session: guestSession });
    const renderer = render(<ManageAccountScreen />);
    expect(byLabel(renderer, 'Delete account')).toHaveLength(0);
    expect(allText(renderer)).toContain('Guest');
    act(() => renderer.unmount());
  });
});

describe('Exit survey — what rides along with the step-1 request', () => {
  const REASONS = [
    "I don't use it enough",
    "It hasn't improved my game",
    'The technique reads felt off',
    'Bugs, crashes, or camera trouble',
    "It's too expensive",
    'Privacy or data concerns',
    'Something else',
  ];
  const WANTED = [
    'More accurate technique reads',
    'A lower price or a free tier',
    'More drills and coaching guidance',
    'Fewer bugs and smoother capture',
    "Nothing — I've found another app or a coach",
    "Nothing — I just don't need it anymore",
  ];

  function radioLabels(renderer: TestRenderer.ReactTestRenderer) {
    return renderer.root
      .findAll(
        node =>
          typeof node.type === 'string' &&
          node.props.accessibilityRole === 'radio',
      )
      .map(node => String(node.props.accessibilityLabel));
  }

  it('both answers and the comment travel under body.survey, stored before the account is gone', async () => {
    const { calls } = scriptFetch(armedResponders());
    const renderer = render(<ManageAccountScreen />);
    await openSurvey(renderer);
    expect(allText(renderer)).toContain('QUESTION 1 OF 2');
    expect(radioLabels(renderer)).toEqual(REASONS);
    expect(sheetButton(renderer, 'Next').props.disabled).toBe(true);

    await act(async () => {
      control(renderer, "It's too expensive").props.onPress();
    });
    expect(sheetButton(renderer, 'Next').props.disabled).toBe(false);
    await act(async () => {
      sheetButton(renderer, 'Next').props.onPress();
    });
    expect(allText(renderer)).toContain('What would have kept you?');
    expect(allText(renderer)).toContain('QUESTION 2 OF 2');
    expect(radioLabels(renderer)).toEqual(WANTED);
    expect(sheetButton(renderer, 'Continue').props.disabled).toBe(true);

    await act(async () => {
      control(renderer, 'A lower price or a free tier').props.onPress();
    });
    const input = renderer.root.findByType(TextInput);
    expect(input.props.accessibilityLabel).toBe(
      'Anything else you want us to know',
    );
    expect(input.props.maxLength).toBe(500);
    await act(async () => {
      input.props.onChangeText('  $60 a year is steep for a rec player.  ');
    });
    await act(async () => {
      sheetButton(renderer, 'Continue').props.onPress();
    });
    expect(allText(renderer)).toContain('Delete your account?');
    // The survey never posts on its own — only with the deletion request.
    expect(calls).toHaveLength(0);

    await pressContinue(renderer);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API_BASE}/v1/me/delete-request`);
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      survey: {
        reason: 'too_expensive',
        wanted: 'price',
        details: '$60 a year is steep for a rec player.',
        platform: 'ios',
        appVersion: '1.0',
      },
    });
    expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('"Skip this question" keeps question 1 and records nothing else; Back keeps the first answer', async () => {
    const { calls } = scriptFetch(armedResponders());
    const renderer = render(<ManageAccountScreen />);
    await openSurvey(renderer);
    await act(async () => {
      control(renderer, 'Privacy or data concerns').props.onPress();
    });
    await act(async () => {
      sheetButton(renderer, 'Next').props.onPress();
    });
    // Back returns to question 1 with the reason still selected…
    await act(async () => {
      control(renderer, 'Back to the previous question').props.onPress();
    });
    expect(allText(renderer)).toContain("What's making you leave?");
    expect(
      hostByLabel(renderer, 'Privacy or data concerns').props
        .accessibilityState,
    ).toMatchObject({ selected: true });
    await act(async () => {
      sheetButton(renderer, 'Next').props.onPress();
    });
    // …and a half-typed draft is discarded by Skip — skipping means skipping.
    await act(async () => {
      renderer.root.findByType(TextInput).props.onChangeText('draft…');
    });
    await act(async () => {
      control(renderer, 'Skip this question').props.onPress();
    });
    expect(allText(renderer)).toContain('Delete your account?');

    await pressContinue(renderer);
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      survey: {
        reason: 'privacy',
        wanted: null,
        details: null,
        platform: 'ios',
        appVersion: '1.0',
      },
    });
    act(() => renderer.unmount());
  });

  it('"Skip the survey" sends no body at all (the pre-survey wire shape), even after picking a reason', async () => {
    const { calls } = scriptFetch(armedResponders());
    const renderer = render(<ManageAccountScreen />);
    await openSurvey(renderer);
    await act(async () => {
      control(renderer, 'Something else').props.onPress();
    });
    await act(async () => {
      control(renderer, 'Skip the survey').props.onPress();
    });
    expect(allText(renderer)).toContain('Delete your account?');
    expect(allText(renderer)).not.toContain('QUESTION');

    await pressContinue(renderer);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.body).toBeUndefined();
    act(() => renderer.unmount());
  });

  it('closing the survey (X, backdrop, hardware back) keeps the account and resets the answers', async () => {
    const { calls } = scriptFetch([]);
    const renderer = render(<ManageAccountScreen />);

    await openSurvey(renderer);
    await act(async () => {
      control(renderer, "I don't use it enough").props.onPress();
    });
    expect(
      hostByLabel(renderer, 'Close and keep my account').props
        .accessibilityRole,
    ).toBe('button');
    await act(async () => {
      control(renderer, 'Close and keep my account').props.onPress();
    });
    expect(sheetVisible(renderer)).toBe(false);

    await openSurvey(renderer);
    expect(
      hostByLabel(renderer, "I don't use it enough").props.accessibilityState,
    ).toMatchObject({ selected: false });
    expect(sheetButton(renderer, 'Next').props.disabled).toBe(true);
    await act(async () => {
      control(renderer, 'Cancel account deletion').props.onPress();
    });
    expect(sheetVisible(renderer)).toBe(false);

    await openSurvey(renderer);
    await act(async () => {
      renderer.root.findByType(Modal).props.onRequestClose();
    });
    expect(sheetVisible(renderer)).toBe(false);

    expect(calls).toHaveLength(0);
    expect(
      useAuthStore.getState().completeAccountDeletion,
    ).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});

describe('Delete account sheet — cancel paths', () => {
  it('"Keep my account" closes the sheet without any network call', async () => {
    const { calls } = scriptFetch([]);
    const renderer = render(<ManageAccountScreen />);
    await openSheet(renderer);
    const keep = sheetButton(renderer, 'Keep my account');
    expect(keep.props.disabled).toBe(false);
    await act(async () => {
      keep.props.onPress();
    });
    expect(sheetVisible(renderer)).toBe(false);
    expect(calls).toHaveLength(0);
    expect(
      useAuthStore.getState().completeAccountDeletion,
    ).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('backdrop tap and the X control both cancel from the review step', async () => {
    scriptFetch([]);
    const renderer = render(<ManageAccountScreen />);

    await openSheet(renderer);
    const backdrop = byLabel(renderer, 'Cancel account deletion');
    expect(backdrop).toHaveLength(1);
    await act(async () => {
      control(renderer, 'Cancel account deletion').props.onPress();
    });
    expect(sheetVisible(renderer)).toBe(false);

    await openSheet(renderer);
    const close = byLabel(renderer, 'Close account deletion confirmation');
    expect(close).toHaveLength(1);
    expect(
      hostByLabel(renderer, 'Close account deletion confirmation').props
        .accessibilityRole,
    ).toBe('button');
    await act(async () => {
      control(renderer, 'Close account deletion confirmation').props.onPress();
    });
    expect(sheetVisible(renderer)).toBe(false);
    act(() => renderer.unmount());
  });

  it('Android back (onRequestClose) cancels from review; reopening resets to step 1', async () => {
    useCountdownTimers();
    scriptFetch(armedResponders());
    const renderer = render(<ManageAccountScreen />);
    await openSheet(renderer);
    await pressContinue(renderer);
    expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(1);

    // Armed is not busy — the user may still back out.
    const modal = renderer.root.findByType(Modal);
    expect(typeof modal.props.onRequestClose).toBe('function');
    await act(async () => {
      modal.props.onRequestClose();
    });
    expect(sheetVisible(renderer)).toBe(false);

    // Re-entry starts over at the review step, never at a stale challenge.
    await openSheet(renderer);
    expect(sheetButtons(renderer, 'Continue to delete')).toHaveLength(1);
    expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
    expect(allText(renderer)).not.toContain('Nothing was deleted');
    act(() => renderer.unmount());
  });

  it('cancel is disabled while a request is in flight (no half-cancelled state)', async () => {
    let resolveRequest!: (r: Response) => void;
    scriptFetch([
      () =>
        new Promise<Response>(resolve => {
          resolveRequest = resolve;
        }),
    ]);
    const renderer = render(<ManageAccountScreen />);
    await openSheet(renderer);
    await act(async () => {
      sheetButton(renderer, 'Continue to delete').props.onPress();
    });
    expect(sheetButton(renderer, 'Requesting…').props.disabled).toBe(true);
    expect(
      hostByLabel(renderer, 'Requesting…').props.accessibilityState,
    ).toMatchObject({ disabled: true });
    expect(sheetButton(renderer, 'Keep my account').props.disabled).toBe(true);
    // Backdrop and hardware back are inert while busy.
    expect(
      control(renderer, 'Cancel account deletion').props.onPress,
    ).toBeUndefined();
    expect(
      renderer.root.findByType(Modal).props.onRequestClose,
    ).toBeUndefined();
    expect(renderer.root.findAllByType(BrandSpinner)).toHaveLength(1);

    await act(async () => {
      resolveRequest(
        jsonResponse(200, {
          challenge: '33333333-3333-4333-8333-333333333333',
          expiresAt: '2099-01-01T00:00:00.000Z',
        }),
      );
    });
    expect(renderer.root.findAllByType(BrandSpinner)).toHaveLength(0);
    expect(sheetButton(renderer, 'Keep my account').props.disabled).toBe(false);
    act(() => renderer.unmount());
  });
});

describe('Delete account sheet — step 1 request', () => {
  it('posts delete-request with the bearer and arms a 5-second hold-off that outlasts the 3s server min-age', async () => {
    useCountdownTimers();
    const { calls } = scriptFetch(armedResponders());
    const renderer = render(<ManageAccountScreen />);
    await openSheet(renderer);
    const cont = sheetButton(renderer, 'Continue to delete');
    expect(cont.props.disabled).toBe(false);
    await pressContinue(renderer);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API_BASE}/v1/me/delete-request`);
    expect(calls[0]!.init?.method).toBe('POST');
    expect(
      (calls[0]!.init?.headers as Record<string, string>).Authorization,
    ).toBe('Bearer provider-token');
    // The survey was skipped: the request carries no body at all.
    expect(calls[0]!.init?.body).toBeUndefined();

    let confirm = sheetButton(renderer, 'Permanently delete');
    expect(confirm.props.label).toBe('Permanently delete (5)');
    expect(confirm.props.disabled).toBe(true);

    // Still locked at the server's 3s minimum age — the client waits longer.
    await act(async () => {
      jest.advanceTimersByTime(3_000);
    });
    confirm = sheetButton(renderer, 'Permanently delete');
    expect(confirm.props.label).toBe('Permanently delete (2)');
    expect(confirm.props.disabled).toBe(true);

    await act(async () => {
      jest.advanceTimersByTime(1_999);
    });
    expect(sheetButton(renderer, 'Permanently delete').props.disabled).toBe(
      true,
    );

    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    confirm = sheetButton(renderer, 'Permanently delete');
    expect(confirm.props.label).toBe('Permanently delete');
    expect(confirm.props.disabled).toBe(false);

    // Countdown is idempotent once at zero (interval cleared).
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    expect(sheetButton(renderer, 'Permanently delete').props.label).toBe(
      'Permanently delete',
    );
    // Nothing destructive happened yet.
    expect(calls).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('offline: shows the offline copy, returns to step 1, and lets the user retry', async () => {
    const { calls } = scriptFetch([
      async () => {
        throw new TypeError('Network request failed');
      },
      ...armedResponders(),
    ]);
    const renderer = render(<ManageAccountScreen />);
    await openSheet(renderer);
    await pressContinue(renderer);

    expect(allText(renderer)).toContain(
      'Account deletion is temporarily offline. Nothing was deleted — please try again.',
    );
    expect(renderer.root.findAllByType(BrandSpinner)).toHaveLength(0);
    const cont = sheetButton(renderer, 'Continue to delete');
    expect(cont.props.disabled).toBe(false);
    expect(sheetButton(renderer, 'Keep my account').props.disabled).toBe(false);

    await pressContinue(renderer);
    expect(calls).toHaveLength(2);
    expect(allText(renderer)).not.toContain('temporarily offline');
    expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('401: tells the user to sign in again; nothing hangs', async () => {
    scriptFetch([
      async () => jsonResponse(401, { error: { message: 'unauthorized' } }),
    ]);
    const renderer = render(<ManageAccountScreen />);
    await openSheet(renderer);
    await pressContinue(renderer);
    expect(allText(renderer)).toContain(
      'Your sign-in has expired. Sign in again, then delete your account.',
    );
    expect(sheetButton(renderer, 'Continue to delete').props.disabled).toBe(
      false,
    );
    expect(sheetButton(renderer, 'Keep my account').props.disabled).toBe(false);
    act(() => renderer.unmount());
  });

  it('429 rate limit: surfaces the server message and stays actionable', async () => {
    scriptFetch([
      async () =>
        jsonResponse(429, {
          error: { code: 'rate_limited', message: 'Too many requests.' },
        }),
    ]);
    const renderer = render(<ManageAccountScreen />);
    await openSheet(renderer);
    await pressContinue(renderer);
    expect(allText(renderer)).toContain('Too many requests.');
    expect(sheetButton(renderer, 'Continue to delete').props.disabled).toBe(
      false,
    );
    act(() => renderer.unmount());
  });

  it('503 with a non-JSON body: generic "nothing was deleted" copy', async () => {
    scriptFetch([async () => textResponse(503, 'Service Unavailable')]);
    const renderer = render(<ManageAccountScreen />);
    await openSheet(renderer);
    await pressContinue(renderer);
    expect(allText(renderer)).toContain(
      'The deletion request could not be completed. Nothing was deleted.',
    );
    expect(sheetButton(renderer, 'Continue to delete').props.disabled).toBe(
      false,
    );
    act(() => renderer.unmount());
  });

  it('malformed 200 body never arms the confirm step', async () => {
    scriptFetch([async () => jsonResponse(200, { challenge: 42 })]);
    const renderer = render(<ManageAccountScreen />);
    await openSheet(renderer);
    await pressContinue(renderer);
    expect(allText(renderer)).toContain(
      'The server returned an invalid deletion challenge.',
    );
    expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('with no API session (runtime cleared) the request is refused with actionable copy', async () => {
    clearApiSession();
    const { calls } = scriptFetch([]);
    const renderer = render(<ManageAccountScreen />);
    await openSheet(renderer);
    await pressContinue(renderer);
    expect(calls).toHaveLength(0);
    expect(allText(renderer)).toContain(
      'Sign in to a synced account before deleting it.',
    );
    expect(sheetButton(renderer, 'Keep my account').props.disabled).toBe(false);
    act(() => renderer.unmount());
  });
});

describe('Delete account sheet — step 2 confirm', () => {
  async function armAndWait(renderer: TestRenderer.ReactTestRenderer) {
    await openSheet(renderer);
    await pressContinue(renderer);
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    const confirm = sheetButton(renderer, 'Permanently delete');
    expect(confirm.props.disabled).toBe(false);
    return confirm;
  }

  it('success: posts the minted challenge, closes the sheet, runs the store purge exactly once', async () => {
    useCountdownTimers();
    const { calls } = scriptFetch([
      ...armedResponders(),
      async () => jsonResponse(200, { deleted: true }),
    ]);
    const renderer = render(<ManageAccountScreen />);
    const confirm = await armAndWait(renderer);
    await act(async () => {
      confirm.props.onPress();
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe(`${API_BASE}/v1/me/delete-confirm`);
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({
      challenge: '33333333-3333-4333-8333-333333333333',
    });
    expect(sheetVisible(renderer)).toBe(false);
    expect(
      useAuthStore.getState().completeAccountDeletion,
    ).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('while deleting: confirm + keep are disabled, spinner shown, backdrop/back inert', async () => {
    useCountdownTimers();
    let resolveConfirm!: (r: Response) => void;
    scriptFetch([
      ...armedResponders(),
      () =>
        new Promise<Response>(resolve => {
          resolveConfirm = resolve;
        }),
    ]);
    const renderer = render(<ManageAccountScreen />);
    const confirm = await armAndWait(renderer);
    await act(async () => {
      confirm.props.onPress();
    });
    const deleting = sheetButton(renderer, 'Deleting…');
    expect(deleting.props.disabled).toBe(true);
    expect(sheetButton(renderer, 'Keep my account').props.disabled).toBe(true);
    expect(renderer.root.findAllByType(BrandSpinner)).toHaveLength(1);
    expect(
      renderer.root.findByType(Modal).props.onRequestClose,
    ).toBeUndefined();
    expect(
      control(renderer, 'Cancel account deletion').props.onPress,
    ).toBeUndefined();

    await act(async () => {
      resolveConfirm(jsonResponse(200, { deleted: true }));
    });
    expect(sheetVisible(renderer)).toBe(false);
    expect(
      useAuthStore.getState().completeAccountDeletion,
    ).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('server 403 (challenge expired): shows the server copy, nothing purged, user can still back out', async () => {
    useCountdownTimers();
    scriptFetch([
      ...armedResponders(),
      async () =>
        jsonResponse(403, {
          error: {
            code: 'account.deletion_challenge_expired',
            message: 'The deletion request expired. Start again from Settings.',
          },
        }),
    ]);
    const renderer = render(<ManageAccountScreen />);
    const confirm = await armAndWait(renderer);
    await act(async () => {
      confirm.props.onPress();
    });
    expect(allText(renderer)).toContain(
      'The deletion request expired. Start again from Settings.',
    );
    expect(renderer.root.findAllByType(BrandSpinner)).toHaveLength(0);
    expect(
      useAuthStore.getState().completeAccountDeletion,
    ).not.toHaveBeenCalled();
    expect(sheetVisible(renderer)).toBe(true);
    const keep = sheetButton(renderer, 'Keep my account');
    expect(keep.props.disabled).toBe(false);
    await act(async () => {
      keep.props.onPress();
    });
    expect(sheetVisible(renderer)).toBe(false);
    // Re-entry mints a NEW challenge instead of reusing the expired one.
    await openSheet(renderer);
    expect(sheetButtons(renderer, 'Continue to delete')).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('server 429 (too fast): message shown and confirm re-enabled for retry', async () => {
    useCountdownTimers();
    const { calls } = scriptFetch([
      ...armedResponders(),
      async () =>
        jsonResponse(429, {
          error: {
            code: 'account.deletion_too_fast',
            message: 'Please review the confirmation before deleting.',
          },
        }),
      async () => jsonResponse(200, { deleted: true }),
    ]);
    const renderer = render(<ManageAccountScreen />);
    let confirm = await armAndWait(renderer);
    await act(async () => {
      confirm.props.onPress();
    });
    expect(allText(renderer)).toContain(
      'Please review the confirmation before deleting.',
    );
    confirm = sheetButton(renderer, 'Permanently delete');
    expect(confirm.props.disabled).toBe(false);
    await act(async () => {
      confirm.props.onPress();
    });
    expect(calls).toHaveLength(3);
    expect(sheetVisible(renderer)).toBe(false);
    expect(
      useAuthStore.getState().completeAccountDeletion,
    ).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('a 200 without deleted:true is treated as failure, never as success', async () => {
    useCountdownTimers();
    scriptFetch([
      ...armedResponders(),
      async () => jsonResponse(200, { deleted: false }),
    ]);
    const renderer = render(<ManageAccountScreen />);
    const confirm = await armAndWait(renderer);
    await act(async () => {
      confirm.props.onPress();
    });
    expect(allText(renderer)).toContain(
      'The server did not confirm the deletion.',
    );
    expect(
      useAuthStore.getState().completeAccountDeletion,
    ).not.toHaveBeenCalled();
    expect(sheetVisible(renderer)).toBe(true);
    act(() => renderer.unmount());
  });

  it('unmounting mid-countdown leaves no live interval behind', async () => {
    useCountdownTimers();
    scriptFetch(armedResponders());
    const renderer = render(<ManageAccountScreen />);
    await openSheet(renderer);
    // The dialog's entrance and page-change animations are finite (220ms)
    // Animated.timing runs; let them settle so the only timer left when the
    // request arms is the countdown interval itself.
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(jest.getTimerCount()).toBe(0);
    await pressContinue(renderer);
    expect(jest.getTimerCount()).toBe(1);
    act(() => renderer.unmount());
    expect(jest.getTimerCount()).toBe(0);
  });
});
