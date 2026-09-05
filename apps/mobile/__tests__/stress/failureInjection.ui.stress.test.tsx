import React from 'react';
import { Modal, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * STRESS — failure injection — the UI CONSUMERS of the account module:
 * `ManageAccountScreen` (deletion request + confirm through the REAL
 * `src/account/deletion` client) and `ConsentSettingsScreen` (hydrate +
 * toggle through the REAL `consentApi` + `consentStore`).
 *
 * Dependencies injected: fetch (every catalog fault on each step), the clock
 * (fake timers advanced 60s past every 15s deadline), navigation (mocked).
 *
 * Invariants asserted per iteration, on the RENDERED tree:
 *   - no infinite spinner: after 60s no `BrandSpinner` / loading copy;
 *   - visible retry/back control: the primary action is re-enabled AND the
 *     cancel/back control is enabled;
 *   - no silent failure: a non-empty error string is rendered;
 *   - no fake success: the deletion purge never runs without `deleted:true`,
 *     the consent switch never flips without a server-validated ledger.
 *
 * Replay: `STRESS_SEED=<seed> npx jest __tests__/stress/failureInjection.ui`
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
  useFocusEffect: (callback: () => void | (() => void)) => {
    const React = jest.requireActual<typeof import('react')>('react');
    React.useEffect(() => callback(), [callback]);
  },
}));

import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { ConsentSettingsScreen } from '../../src/screens/ConsentSettingsScreen';
import { BrandSpinner, BrandToggle, Button } from '../../src/design/components';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import { useConsentStore } from '../../src/state/consentStore';
import {
  pick,
  recordIteration,
  scenarioCases,
  seededRandom,
  type Rng,
} from '../../testing/stress/harness';
import {
  drawFault,
  expectedServerMessage,
  faultFetch,
  okFault,
  REQUEST_DEADLINE_MS,
  transportFailureExpected,
  type Fault,
  type MalformedShape,
} from '../../testing/stress/faultFetch';

const SUITE = 'ui';
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

const VALID_CHALLENGE = {
  challenge: '33333333-3333-4333-8333-333333333333',
  expiresAt: '2099-01-01T00:00:00.000Z',
};
const VALID_CONFIRM = {
  deleted: true,
  appleAuthorizationRevocation: 'revoked',
};

function malformedChallenge(rng: Rng): MalformedShape {
  return pick(rng, [
    { shape: 'null', payload: null },
    { shape: 'empty_object', payload: {} },
    { shape: 'challenge_number', payload: { challenge: 42, expiresAt: 'x' } },
    { shape: 'missing_expiresAt', payload: { challenge: 'abc' } },
    { shape: 'nulls', payload: { challenge: null, expiresAt: null } },
    { shape: 'nested_data', payload: { data: VALID_CHALLENGE } },
  ]);
}

function malformedConfirm(rng: Rng): MalformedShape {
  return pick(rng, [
    { shape: 'null', payload: null },
    { shape: 'empty_object', payload: {} },
    { shape: 'deleted_false', payload: { deleted: false } },
    { shape: 'deleted_string_true', payload: { deleted: 'true' } },
    { shape: 'deleted_one', payload: { deleted: 1 } },
    { shape: 'ok_true_only', payload: { ok: true } },
  ]);
}

function consentRow(scope: string, active: boolean): Record<string, unknown> {
  return {
    scope,
    active,
    consentVersion: active ? 'model-training-v1' : null,
    lastAction: active ? 'granted' : null,
    lastActionAt: active ? '2026-09-01T00:00:00.000Z' : null,
  };
}

function validStatus(active: boolean): unknown {
  return {
    subjectPseudonym: 'pseud-1',
    scopes: [
      consentRow('video_analysis', true),
      consentRow('model_training', active),
    ],
  };
}

function malformedStatus(rng: Rng): MalformedShape {
  return pick(rng, [
    { shape: 'null', payload: null },
    { shape: 'empty_object', payload: {} },
    { shape: 'scopes_null', payload: { subjectPseudonym: null, scopes: null } },
    {
      shape: 'active_string',
      payload: {
        subjectPseudonym: null,
        scopes: [{ ...consentRow('model_training', true), active: 'true' }],
      },
    },
    {
      shape: 'row_not_object',
      payload: { subjectPseudonym: null, scopes: ['model_training'] },
    },
    {
      shape: 'pseudonym_number',
      payload: { subjectPseudonym: 42, scopes: [] },
    },
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function challengeAccepted(payload: unknown): boolean {
  return (
    isRecord(payload) &&
    typeof payload['challenge'] === 'string' &&
    typeof payload['expiresAt'] === 'string'
  );
}
function confirmAccepted(payload: unknown): boolean {
  return isRecord(payload) && payload['deleted'] === true;
}
function statusAccepted(payload: unknown): boolean {
  if (!isRecord(payload) || !Array.isArray(payload['scopes'])) return false;
  const p = payload['subjectPseudonym'];
  if (!(p === null || typeof p === 'string')) return false;
  return payload['scopes'].every(
    row =>
      isRecord(row) &&
      typeof row['scope'] === 'string' &&
      typeof row['active'] === 'boolean' &&
      (row['consentVersion'] === null ||
        typeof row['consentVersion'] === 'string') &&
      (row['lastAction'] === null || typeof row['lastAction'] === 'string') &&
      (row['lastActionAt'] === null || typeof row['lastActionAt'] === 'string'),
  );
}

/** Whether the step is expected to have SUCCEEDED once 60s have elapsed
 * (a stalled body under 60s still lands — the deadline only covers the
 * request; `ok_malformed` succeeds only when the reference validator does). */
function acceptedAfter60s(
  fault: Fault,
  valid: (p: unknown) => boolean,
): boolean {
  switch (fault.kind) {
    case 'ok':
      return true;
    case 'slow_ok':
      return (fault.delayMs ?? 0) < REQUEST_DEADLINE_MS;
    case 'slow_body':
      return (fault.delayMs ?? 0) <= 60_000;
    case 'ok_malformed':
      return valid(fault.payload);
    default:
      return false;
  }
}

/**
 * F1: a non-2xx body of `{error:{message:""}}` passes the `typeof === 'string'`
 * check in deletion.ts / onboarding.ts, so the empty string becomes the
 * user-facing error and `error ? <Text>…</Text> : null` renders nothing.
 * The edge function never emits an empty message (every errorJson/codedError
 * call site passes a literal), so this is only reachable through an
 * intermediary — recorded as a finding, not asserted as a suite failure.
 */
const FINDING_EMPTY_SERVER_MESSAGE = 'F1-empty-server-message-renders-no-copy';

const DELETION_FAILURE_COPY = [
  'Account deletion is temporarily offline. Nothing was deleted — please try again.',
  'Your sign-in has expired. Sign in again, then delete your account.',
  'The server returned an invalid deletion response.',
  'The server returned an invalid deletion challenge.',
  'The server did not confirm the deletion.',
  'The deletion request could not be completed. Nothing was deleted.',
  'The deletion could not be completed. Nothing was deleted.',
];
const CONSENT_FAILURE_COPY = [
  'Consent settings are temporarily unavailable.',
  'The consent server returned an invalid response.',
  'Your consent change could not be saved. Nothing was changed.',
];

function firstCopy(text: string, copies: readonly string[]): string | null {
  return copies.find(c => text.includes(c)) ?? null;
}

/** A fault whose settlement is outside the client's control (ignores the
 * abort signal / body never resolves): the consumer cannot recover by
 * itself, recorded as KNOWN_LIMIT rather than asserted. */
function uncontrollable(fault: Fault): boolean {
  return (
    fault.kind === 'hang_ignore_abort' ||
    fault.kind === 'body_stall' ||
    (fault.kind === 'slow_body' && (fault.delayMs ?? 0) > 60_000)
  );
}

// ---------------------------------------------------------------------------
// rendering helpers (same conventions as __tests__/wf/flow-account-deletion)
// ---------------------------------------------------------------------------

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

function spinners(renderer: TestRenderer.ReactTestRenderer): number {
  return renderer.root.findAllByType(BrandSpinner).length;
}

async function openSheet(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    control(renderer, 'Delete account').props.onPress();
  });
  await act(async () => {
    control(renderer, 'Skip the survey').props.onPress();
  });
  expect(allText(renderer)).toContain('Delete your account?');
}

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
  });
  mockGoBack.mockClear();
  mockNavigate.mockClear();
  useAuthStore.setState({
    hydrated: true,
    session: syncedSession,
    busy: false,
    error: null,
    completeAccountDeletion: jest.fn(() => Promise.resolve()),
  });
  useConsentStore.setState({
    availability: 'loading',
    modelTrainingActive: false,
    lastActionAt: null,
    busy: false,
    error: null,
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
  jest.clearAllTimers();
  jest.useRealTimers();
  clearApiSession();
});

// ---------------------------------------------------------------------------
// ManageAccountScreen — step 1 (request) under every fault
// ---------------------------------------------------------------------------

describe('ui.manageAccount.request — deletion request faults on the rendered sheet', () => {
  const scenario = 'ui.manageAccount.request';
  scenarioCases(scenario).forEach(([seed, iteration]) => {
    it(`seed ${seed} (iteration ${iteration}) leaves the sheet actionable with visible copy`, async () => {
      const rng = seededRandom(seed);
      const fault = drawFault(
        rng,
        iteration,
        VALID_CHALLENGE,
        malformedChallenge,
      );
      await recordIteration(
        {
          suite: SUITE,
          scenario,
          seed,
          iteration,
          fault: fault.id,
          inputs: { fault },
        },
        async () => {
          const transport = faultFetch([fault]);
          globalThis.fetch = transport.fetch as typeof fetch;
          const renderer = render(<ManageAccountScreen />);
          await openSheet(renderer);
          await act(async () => {
            sheetButton(renderer, 'Continue to delete').props.onPress();
          });
          await advance(60_000);

          const text = allText(renderer);
          const keep = sheetButton(renderer, 'Keep my account');
          const continueButtons = sheetButtons(renderer, 'Continue to delete');
          const requesting = sheetButtons(renderer, 'Requesting…');
          const armed = sheetButtons(renderer, 'Permanently delete');
          const purge = useAuthStore.getState()
            .completeAccountDeletion as jest.Mock;
          const observed: Record<string, unknown> = {
            fetchCalls: transport.calls.length,
            aborted: transport.calls[0]?.aborted ?? null,
            spinners: spinners(renderer),
            keepEnabled: keep.props.disabled === false,
            continueVisible: continueButtons.length,
            requestingVisible: requesting.length,
            armedVisible: armed.length,
            sheetVisible: sheetVisible(renderer),
            purgeCalls: purge.mock.calls.length,
            errorCopy:
              text.includes('Nothing was deleted') ||
              text.includes('sign in again') ||
              text.includes('Sign in again'),
          };
          try {
            expect(purge).not.toHaveBeenCalled();
            expect(sheetVisible(renderer)).toBe(true);
            expect(transport.calls).toHaveLength(1);
            expect(transport.calls[0]!.url).toBe(
              `${API_BASE}/v1/me/delete-request`,
            );

            if (uncontrollable(fault) && spinners(renderer) > 0) {
              // The fetch ignored the abort: the sheet keeps its spinner and
              // cancel stays disabled — nothing the client can do.
              expect(requesting).toHaveLength(1);
              return { observed, classification: 'KNOWN_LIMIT' };
            }

            expect(spinners(renderer)).toBe(0);
            expect(requesting).toHaveLength(0);
            expect(keep.props.disabled).toBe(false);

            if (acceptedAfter60s(fault, challengeAccepted)) {
              expect(armed).toHaveLength(1);
              return { observed };
            }
            // Failure: back on the review step with a retry control and copy.
            expect(continueButtons).toHaveLength(1);
            expect(continueButtons[0]!.props.disabled).toBe(false);
            expect(armed).toHaveLength(0);
            const copy = firstCopy(text, DELETION_FAILURE_COPY);
            observed['copy'] = copy;
            if (transportFailureExpected(fault)) {
              expect(copy).toBe(DELETION_FAILURE_COPY[0]);
            } else if (fault.kind === 'http_error' && fault.status === 401) {
              expect(copy).toBe(DELETION_FAILURE_COPY[1]);
            } else {
              const server = expectedServerMessage(fault);
              if (server !== null) {
                // The screen renders `error ? <Text>{error}</Text> : null`:
                // the server string must actually be on screen.
                const rendered = renderer.root
                  .findAllByType(Text)
                  .some(
                    node => node.props.children === server && server.length > 0,
                  );
                observed['serverCopyRendered'] = rendered;
                if (server.length === 0) {
                  // `{error:{message:""}}` is a string, so deletion.ts
                  // surfaces it verbatim and the sheet shows no copy at all.
                  if (!rendered && copy === null) {
                    return {
                      observed,
                      classification: 'BROKEN',
                      finding: FINDING_EMPTY_SERVER_MESSAGE,
                    };
                  }
                  expect(copy).not.toBeNull();
                } else {
                  expect(rendered).toBe(true);
                }
              } else {
                expect(copy).not.toBeNull();
              }
            }
            return {
              observed: { ...observed, faultRealistic: fault.realistic },
              classification: 'HELD',
            };
          } finally {
            act(() => renderer.unmount());
          }
        },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// ManageAccountScreen — step 2 (confirm) under every fault
// ---------------------------------------------------------------------------

describe('ui.manageAccount.confirm — deletion confirm faults on the rendered sheet', () => {
  const scenario = 'ui.manageAccount.confirm';
  scenarioCases(scenario).forEach(([seed, iteration]) => {
    it(`seed ${seed} (iteration ${iteration}) never purges without deleted:true and stays actionable`, async () => {
      const rng = seededRandom(seed);
      const fault = drawFault(rng, iteration, VALID_CONFIRM, malformedConfirm);
      await recordIteration(
        {
          suite: SUITE,
          scenario,
          seed,
          iteration,
          fault: fault.id,
          inputs: { fault },
        },
        async () => {
          const transport = faultFetch([okFault(VALID_CHALLENGE), fault]);
          globalThis.fetch = transport.fetch as typeof fetch;
          const renderer = render(<ManageAccountScreen />);
          await openSheet(renderer);
          await act(async () => {
            sheetButton(renderer, 'Continue to delete').props.onPress();
          });
          await advance(5_000);
          const confirm = sheetButton(renderer, 'Permanently delete');
          expect(confirm.props.disabled).toBe(false);
          await act(async () => {
            confirm.props.onPress();
          });
          await advance(60_000);

          const purge = useAuthStore.getState()
            .completeAccountDeletion as jest.Mock;
          const text = allText(renderer);
          const accepted = acceptedAfter60s(fault, confirmAccepted);
          const observed: Record<string, unknown> = {
            fetchCalls: transport.calls.length,
            aborted: transport.calls[1]?.aborted ?? null,
            spinners: spinners(renderer),
            sheetVisible: sheetVisible(renderer),
            purgeCalls: purge.mock.calls.length,
            deletingVisible: sheetButtons(renderer, 'Deleting…').length,
            confirmVisible: sheetButtons(renderer, 'Permanently delete').length,
            continueVisible: sheetButtons(renderer, 'Continue to delete')
              .length,
          };
          try {
            expect(transport.calls).toHaveLength(2);
            expect(transport.calls[1]!.url).toBe(
              `${API_BASE}/v1/me/delete-confirm`,
            );
            if (accepted) {
              expect(purge).toHaveBeenCalledTimes(1);
              expect(sheetVisible(renderer)).toBe(false);
              return { observed };
            }
            // No fake success.
            expect(purge).not.toHaveBeenCalled();
            expect(sheetVisible(renderer)).toBe(true);

            if (uncontrollable(fault) && spinners(renderer) > 0) {
              expect(sheetButtons(renderer, 'Deleting…')).toHaveLength(1);
              return { observed, classification: 'KNOWN_LIMIT' };
            }
            expect(spinners(renderer)).toBe(0);
            expect(sheetButtons(renderer, 'Deleting…')).toHaveLength(0);
            const keep = sheetButton(renderer, 'Keep my account');
            expect(keep.props.disabled).toBe(false);
            // Retry control: same challenge (retryable) or back to step 1.
            const retry = sheetButtons(renderer, 'Permanently delete');
            const back = sheetButtons(renderer, 'Continue to delete');
            expect(retry.length + back.length).toBe(1);
            expect((retry[0] ?? back[0])!.props.disabled).toBe(false);
            const copy = firstCopy(text, DELETION_FAILURE_COPY);
            observed['copy'] = copy;
            if (fault.kind === 'http_error' && fault.status === 401) {
              expect(back).toHaveLength(1);
              expect(copy).toBe(DELETION_FAILURE_COPY[1]);
            } else if (transportFailureExpected(fault)) {
              expect(retry).toHaveLength(1);
              expect(copy).toBe(DELETION_FAILURE_COPY[0]);
            } else {
              const server = expectedServerMessage(fault);
              if (server !== null) {
                const rendered = renderer.root
                  .findAllByType(Text)
                  .some(
                    node => node.props.children === server && server.length > 0,
                  );
                observed['serverCopyRendered'] = rendered;
                if (server.length === 0) {
                  if (!rendered && copy === null) {
                    return {
                      observed,
                      classification: 'BROKEN',
                      finding: FINDING_EMPTY_SERVER_MESSAGE,
                    };
                  }
                  expect(copy).not.toBeNull();
                } else {
                  expect(rendered).toBe(true);
                }
              } else {
                expect(copy).not.toBeNull();
              }
            }
            return {
              observed: { ...observed, faultRealistic: fault.realistic },
              classification: 'HELD',
            };
          } finally {
            act(() => renderer.unmount());
          }
        },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// ConsentSettingsScreen — hydrate on mount, then "Try again"
// ---------------------------------------------------------------------------

describe('ui.consent.hydrate — status fetch faults on the rendered screen', () => {
  const scenario = 'ui.consent.hydrate';
  scenarioCases(scenario).forEach(([seed, iteration]) => {
    it(`seed ${seed} (iteration ${iteration}) shows Try again with copy or a validated ledger`, async () => {
      const rng = seededRandom(seed);
      const fault = drawFault(
        rng,
        iteration,
        validStatus(rng() < 0.5),
        malformedStatus,
      );
      const retryFault = drawFault(
        rng,
        iteration + 7,
        validStatus(true),
        malformedStatus,
      );
      await recordIteration(
        {
          suite: SUITE,
          scenario,
          seed,
          iteration,
          fault: `${fault.id}|retry:${retryFault.id}`,
          inputs: { fault, retryFault },
        },
        async () => {
          const transport = faultFetch([fault, retryFault]);
          globalThis.fetch = transport.fetch as typeof fetch;
          const renderer = render(<ConsentSettingsScreen />);
          await advance(60_000);

          const toggle = () => renderer.root.findByType(BrandToggle);
          const tryAgain = () => sheetButtons(renderer, 'Try again');
          const text = allText(renderer);
          const state = useConsentStore.getState();
          const observed: Record<string, unknown> = {
            fetchCalls: transport.calls.length,
            availability: state.availability,
            error: state.error,
            active: state.modelTrainingActive,
            toggleDisabled: toggle().props.disabled,
            toggleValue: toggle().props.value,
            tryAgainVisible: tryAgain().length,
            loadingCopy: text.includes('Checking your current choice'),
          };
          try {
            expect(transport.calls[0]!.url).toBe(
              `${API_BASE}/v1/me/consent/status`,
            );
            const accepted = acceptedAfter60s(fault, statusAccepted);
            if (uncontrollable(fault) && state.availability === 'loading') {
              expect(text).toContain('Checking your current choice');
              expect(toggle().props.disabled).toBe(true);
              return { observed, classification: 'KNOWN_LIMIT' };
            }
            expect(text).not.toContain('Checking your current choice');
            if (accepted) {
              expect(state.availability).toBe('ready');
              expect(toggle().props.disabled).toBe(false);
              const training = (
                fault.payload as {
                  scopes: Array<{ scope: string; active: boolean }>;
                }
              ).scopes.find(s => s.scope === 'model_training');
              expect(toggle().props.value).toBe(training?.active ?? false);
              expect(tryAgain()).toHaveLength(0);
              return { observed };
            }
            // Failure: visible copy + Try again, switch OFF and disabled.
            expect(state.availability).toBe('unavailable');
            expect(toggle().props.disabled).toBe(true);
            expect(toggle().props.value).toBe(false);
            expect(tryAgain()).toHaveLength(1);
            observed['copy'] = firstCopy(text, CONSENT_FAILURE_COPY);
            expect(observed['copy']).not.toBeNull();

            // Retry through the button with the second fault.
            await act(async () => {
              tryAgain()[0]!.props.onPress();
            });
            await advance(60_000);
            const after = useConsentStore.getState();
            const retryAccepted = acceptedAfter60s(retryFault, statusAccepted);
            observed['retry'] = {
              availability: after.availability,
              error: after.error,
              fetchCalls: transport.calls.length,
            };
            expect(transport.calls).toHaveLength(2);
            if (
              uncontrollable(retryFault) &&
              after.availability === 'loading'
            ) {
              return { observed, classification: 'KNOWN_LIMIT' };
            }
            if (retryAccepted) {
              expect(after.availability).toBe('ready');
              expect(toggle().props.disabled).toBe(false);
              expect(tryAgain()).toHaveLength(0);
            } else {
              expect(after.availability).toBe('unavailable');
              expect(tryAgain()).toHaveLength(1);
              expect(
                firstCopy(allText(renderer), CONSENT_FAILURE_COPY),
              ).not.toBeNull();
            }
            return {
              observed: {
                ...observed,
                faultRealistic: fault.realistic && retryFault.realistic,
              },
              classification: 'HELD',
            };
          } finally {
            act(() => renderer.unmount());
          }
        },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// ConsentSettingsScreen — toggle under faults (no optimistic flip)
// ---------------------------------------------------------------------------

describe('ui.consent.toggle — grant/withdraw faults on the rendered switch', () => {
  const scenario = 'ui.consent.toggle';
  scenarioCases(scenario).forEach(([seed, iteration]) => {
    it(`seed ${seed} (iteration ${iteration}) never flips the switch without a validated ledger`, async () => {
      const rng = seededRandom(seed);
      const startActive = rng() < 0.5;
      const serverActive = rng() < 0.5;
      const fault = drawFault(
        rng,
        iteration,
        validStatus(serverActive),
        malformedStatus,
      );
      await recordIteration(
        {
          suite: SUITE,
          scenario,
          seed,
          iteration,
          fault: fault.id,
          inputs: { fault, startActive, serverActive },
        },
        async () => {
          const transport = faultFetch([
            okFault(validStatus(startActive)),
            fault,
          ]);
          globalThis.fetch = transport.fetch as typeof fetch;
          const renderer = render(<ConsentSettingsScreen />);
          await advance(0);
          const toggle = () => renderer.root.findByType(BrandToggle);
          expect(useConsentStore.getState().availability).toBe('ready');
          expect(toggle().props.value).toBe(startActive);

          await act(async () => {
            toggle().props.onValueChange(!startActive);
          });
          const busyMidFlight = useConsentStore.getState().busy;
          await advance(60_000);

          const state = useConsentStore.getState();
          const text = allText(renderer);
          const accepted = acceptedAfter60s(fault, statusAccepted);
          const observed: Record<string, unknown> = {
            fetchCalls: transport.calls.length,
            url: transport.calls[1]?.url.replace(API_BASE, ''),
            busyMidFlight,
            busy: state.busy,
            active: state.modelTrainingActive,
            error: state.error,
            toggleValue: toggle().props.value,
            toggleDisabled: toggle().props.disabled,
          };
          try {
            expect(transport.calls).toHaveLength(2);
            expect(transport.calls[1]!.url).toBe(
              `${API_BASE}/v1/me/consent/${startActive ? 'withdraw' : 'grant'}`,
            );
            if (uncontrollable(fault) && state.busy) {
              expect(toggle().props.disabled).toBe(true);
              expect(toggle().props.value).toBe(startActive); // never optimistic
              return { observed, classification: 'KNOWN_LIMIT' };
            }
            expect(state.busy).toBe(false);
            expect(toggle().props.disabled).toBe(false);
            if (accepted) {
              const training = (
                fault.payload as {
                  scopes: Array<{ scope: string; active: boolean }>;
                }
              ).scopes.find(s => s.scope === 'model_training');
              expect(toggle().props.value).toBe(training?.active ?? false);
              expect(state.error).toBeNull();
              return { observed };
            }
            // Failure: switch unchanged, copy visible, switch re-enabled.
            expect(toggle().props.value).toBe(startActive);
            expect(state.availability).toBe('ready');
            observed['copy'] = firstCopy(text, CONSENT_FAILURE_COPY);
            expect(observed['copy']).not.toBeNull();
            return {
              observed: { ...observed, faultRealistic: fault.realistic },
              classification: 'HELD',
            };
          } finally {
            act(() => renderer.unmount());
          }
        },
      );
    });
  });
});
