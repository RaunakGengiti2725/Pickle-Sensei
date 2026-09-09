import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * INT-deletion-managed-media adversary (attacks the shipping deletion path).
 *
 * The Edge contract (supabase/functions/api/index.ts, "Account deletion"
 * routes) mints `{operationId, statusCapability, statusExpiresAt}` on
 * delete-request, answers delete-confirm with 202 `{operationId, state:
 * "in_progress"}` while a lease is held, and offers POST /v1/me/delete-status
 * (bearer = statusCapability) so a client that lost the final response can
 * resolve the outcome without a live session. These tests drive the REAL
 * `src/account/deletion.ts` through the REAL ManageAccountScreen with only
 * `fetch` faked, and record what the shipping client actually does with that
 * contract under network loss, session fencing, a 202 answer and an
 * unrecognized Apple outcome.
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

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
}));

jest.mock('../../src/design/components', () => {
  const actual = jest.requireActual<
    typeof import('../../src/design/components')
  >('../../src/design/components');
  return { ...actual, useReducedMotion: () => true };
});

import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { Button } from '../../src/design/components';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import { establishApiSession } from '../../src/account/apiSession';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHALLENGE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STATUS_CAPABILITY = 'c'.repeat(43);
const BEARER = 'access-token';
const API = 'https://api.example.test';

const syncedSession: AuthSession = {
  provider: 'apple',
  subject: OWNER,
  canonicalAppUserId: OWNER,
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

interface RecordedCall {
  path: string;
  bearer: string | null;
  body: Record<string, unknown> | null;
}

type FetchScript = (call: RecordedCall) => Promise<Response>;

const calls: RecordedCall[] = [];
let script: FetchScript = () => Promise.reject(new Error('unscripted fetch'));

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const requestPayload = {
  challenge: CHALLENGE,
  expiresAt: '2099-01-01T00:00:00.000Z',
  operationId: OPERATION_ID,
  statusCapability: STATUS_CAPABILITY,
  statusExpiresAt: '2099-01-02T00:00:00.000Z',
};

function installFetch(): void {
  calls.length = 0;
  globalThis.fetch = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = new Headers(init?.headers);
      const authorization = headers.get('Authorization');
      const rawBody = typeof init?.body === 'string' ? init.body : null;
      const call: RecordedCall = {
        path: url.replace(API, ''),
        bearer: authorization ? authorization.replace(/^Bearer /, '') : null,
        body: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : null,
      };
      calls.push(call);
      return script(call);
    },
  ) as unknown as typeof fetch;
}

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

/** Presses like a user: a disabled button never fires. */
function tap(button: ReturnType<typeof sheetButton>): void {
  if (button.props.disabled) return;
  button.props.onPress();
}

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
}

const statusCalls = () => calls.filter(c => c.path === '/v1/me/delete-status');
const confirmCalls = () =>
  calls.filter(c => c.path === '/v1/me/delete-confirm');

describe('ADV deletion: shipping client vs durable Edge deletion contract', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    installFetch();
    mockShowBrandNotice.mockClear();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    setActiveDataOwner(OWNER);
    establishApiSession({
      apiBaseUrl: API,
      bearerToken: BEARER,
      canonicalAppUserId: OWNER,
      provider: 'apple',
    });
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

  it('ATTACK network loss on the final response, then a fenced session: client dead-ends without consulting the status capability', async () => {
    let confirmAttempts = 0;
    script = async call => {
      if (call.path === '/v1/me/delete-request') {
        return jsonResponse(200, requestPayload);
      }
      if (call.path === '/v1/me/delete-confirm') {
        confirmAttempts += 1;
        if (confirmAttempts === 1) {
          // Server finished the deletion; the response never reached the phone.
          throw new TypeError('Network request failed');
        }
        // Auth user is gone and the bearer was fenced by the completed deletion.
        return jsonResponse(401, {
          error: { message: 'The session is no longer valid. Sign in again.' },
        });
      }
      if (call.path === '/v1/me/delete-status') {
        return jsonResponse(200, {
          state: 'completed',
          completionReceipt: { completedAt: '2026-09-09T00:00:00.000Z' },
          appleAuthorizationRevocation: 'revoked',
        });
      }
      return jsonResponse(404, { error: { message: 'no route' } });
    };
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await act(async () => {
        tap(sheetButton(renderer, 'Permanently delete'));
      });
      expect(allText(renderer)).toContain('Deletion status unknown');

      await act(async () => {
        tap(sheetButton(renderer, 'Retry deletion'));
      });

      // The client had everything it needed to resolve the outcome offline of
      // the session (operationId + statusCapability were in the request
      // response) and the server exposes the status route for exactly this
      // case. A client that honours the contract resolves the outcome here.
      const cleanup = useAuthStore.getState().completeAccountDeletion;
      expect(statusCalls().length).toBeGreaterThan(0);
      expect(calls.some(c => c.bearer === STATUS_CAPABILITY)).toBe(true);
      expect(cleanup).toHaveBeenCalled();
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('OBSERVED after the fenced 401 the shipping client tells the deleted user to sign in again and drops the flow', async () => {
    let confirmAttempts = 0;
    script = async call => {
      if (call.path === '/v1/me/delete-request') {
        return jsonResponse(200, requestPayload);
      }
      if (call.path === '/v1/me/delete-confirm') {
        confirmAttempts += 1;
        if (confirmAttempts === 1)
          throw new TypeError('Network request failed');
        return jsonResponse(401, {
          error: { message: 'The session is no longer valid. Sign in again.' },
        });
      }
      return jsonResponse(404, { error: { message: 'no route' } });
    };
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await act(async () => {
        tap(sheetButton(renderer, 'Permanently delete'));
      });
      await act(async () => {
        tap(sheetButton(renderer, 'Retry deletion'));
      });
      const text = allText(renderer);
      expect(text).toContain('Sign in again before retrying');
      // Back on the review page: the only forward action mints a NEW request
      // (which the server refuses with 409 while the confirmed operation is
      // retained), and the status route was never consulted.
      expect(sheetButton(renderer, 'Continue to delete').props.disabled).toBe(
        false,
      );
      expect(statusCalls()).toHaveLength(0);
      expect(calls.every(c => c.bearer === BEARER)).toBe(true);
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).not.toHaveBeenCalled();
      expect(
        confirmCalls().every(c => c.body?.['operationId'] === undefined),
      ).toBe(true);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('ATTACK 202 in_progress: the client should surface an in-progress state and carry operationId on retry', async () => {
    script = async call => {
      if (call.path === '/v1/me/delete-request') {
        return jsonResponse(200, requestPayload);
      }
      if (call.path === '/v1/me/delete-confirm') {
        return jsonResponse(
          202,
          { operationId: OPERATION_ID, state: 'in_progress' },
          { 'Retry-After': '3' },
        );
      }
      return jsonResponse(404, { error: { message: 'no route' } });
    };
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await act(async () => {
        tap(sheetButton(renderer, 'Permanently delete'));
      });
      await act(async () => {
        tap(sheetButton(renderer, 'Retry deletion'));
      });
      expect(confirmCalls()).toHaveLength(2);
      // Contract: `POST /v1/me/delete-confirm { challenge, operationId? }`.
      // Once the server has named the operation, a retry must be bound to it.
      expect(confirmCalls()[1]!.body?.['operationId']).toBe(OPERATION_ID);
      // 202 + state:"in_progress" is a defined, non-failure answer.
      expect(allText(renderer)).not.toContain(
        'The server did not confirm the deletion',
      );
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('OBSERVED 202 in_progress is rendered as "did not confirm" and every confirm is challenge-only', async () => {
    script = async call => {
      if (call.path === '/v1/me/delete-request') {
        return jsonResponse(200, requestPayload);
      }
      if (call.path === '/v1/me/delete-confirm') {
        return jsonResponse(
          202,
          { operationId: OPERATION_ID, state: 'in_progress' },
          { 'Retry-After': '3' },
        );
      }
      return jsonResponse(404, { error: { message: 'no route' } });
    };
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await act(async () => {
        tap(sheetButton(renderer, 'Permanently delete'));
      });
      expect(allText(renderer)).toContain(
        'The server did not confirm the deletion',
      );
      expect(allText(renderer)).toContain('Deletion status unknown');
      expect(confirmCalls()[0]!.body).toEqual({ challenge: CHALLENGE });
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).not.toHaveBeenCalled();
    } finally {
      act(() => renderer.unmount());
    }
  });

  // The Edge fn (accountDeletionOperations.ts `AppleDeletionOutcome`) can only
  // emit revoked | not_applicable | manual_action_required today, so this is a
  // forward-compatibility hazard rather than a live break: deletion.ts coerces
  // any other value to `not_applicable` and the screen then shows clean
  // "DELETION CONFIRMED" success copy for an outcome it did not recognise.
  it.each(['failed', 'unknown', 'REVOKED', null, undefined])(
    'OBSERVED unrecognized Apple revocation outcome %p is coerced to not_applicable and rendered as clean DELETION CONFIRMED',
    async outcome => {
      script = async call => {
        if (call.path === '/v1/me/delete-request') {
          return jsonResponse(200, requestPayload);
        }
        if (call.path === '/v1/me/delete-confirm') {
          return jsonResponse(200, {
            deleted: true,
            operationId: OPERATION_ID,
            completionReceipt: { completedAt: '2026-09-09T00:00:00.000Z' },
            ...(outcome === undefined
              ? {}
              : { appleAuthorizationRevocation: outcome }),
          });
        }
        return jsonResponse(404, { error: { message: 'no route' } });
      };
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await act(async () => {
          tap(sheetButton(renderer, 'Permanently delete'));
        });
        await act(async () => {
          await Promise.resolve();
        });
        expect(mockShowBrandNotice).toHaveBeenCalledTimes(1);
        expect(mockShowBrandNotice).toHaveBeenCalledWith(
          expect.objectContaining({
            tone: 'success',
            eyebrow: 'DELETION CONFIRMED',
          }),
        );
        expect(
          useAuthStore.getState().completeAccountDeletion,
        ).toHaveBeenCalledTimes(1);
      } finally {
        act(() => renderer.unmount());
      }
    },
  );

  it('PASS double tap on Permanently delete sends exactly one confirmation', async () => {
    let release!: (response: Response) => void;
    script = async call => {
      if (call.path === '/v1/me/delete-request') {
        return jsonResponse(200, requestPayload);
      }
      if (call.path === '/v1/me/delete-confirm') {
        return new Promise<Response>(resolve => {
          release = resolve;
        });
      }
      return jsonResponse(404, { error: { message: 'no route' } });
    };
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await act(async () => {
        tap(sheetButton(renderer, 'Permanently delete'));
      });
      await act(async () => {
        tap(sheetButton(renderer, 'Deleting'));
        tap(sheetButton(renderer, 'Deleting'));
      });
      expect(sheetButton(renderer, 'Deleting').props.disabled).toBe(true);
      expect(sheetButton(renderer, 'Keep my account').props.disabled).toBe(
        true,
      );
      expect(confirmCalls()).toHaveLength(1);
      await act(async () => {
        release(
          jsonResponse(200, {
            deleted: true,
            operationId: OPERATION_ID,
            completionReceipt: { completedAt: '2026-09-09T00:00:00.000Z' },
            appleAuthorizationRevocation: 'revoked',
          }),
        );
      });
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).toHaveBeenCalledTimes(1);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('PASS slow confirm past the 15s deadline is reported as unknown, never as kept or deleted', async () => {
    script = async call => {
      if (call.path === '/v1/me/delete-request') {
        return jsonResponse(200, requestPayload);
      }
      if (call.path === '/v1/me/delete-confirm') {
        return new Promise<Response>(() => {});
      }
      return jsonResponse(404, { error: { message: 'no route' } });
    };
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await act(async () => {
        tap(sheetButton(renderer, 'Permanently delete'));
      });
      await act(async () => {
        jest.advanceTimersByTime(15_001);
      });
      const text = allText(renderer);
      expect(text).toContain('Deletion status unknown');
      expect(text).not.toContain('Nothing was deleted');
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).not.toHaveBeenCalled();
      expect(mockShowBrandNotice).not.toHaveBeenCalled();
    } finally {
      act(() => renderer.unmount());
    }
  });

  it.each([
    ['non-object', '"deleted"'],
    ['array', '[true]'],
    ['deleted:"true"', '{"deleted":"true"}'],
    ['deleted:1', '{"deleted":1}'],
    ['not JSON', 'deleted'],
  ])(
    'PASS malformed 200 confirm body (%s) is unknown, not success',
    async (_label, raw) => {
      script = async call => {
        if (call.path === '/v1/me/delete-request') {
          return jsonResponse(200, requestPayload);
        }
        if (call.path === '/v1/me/delete-confirm') {
          return new Response(raw, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return jsonResponse(404, { error: { message: 'no route' } });
      };
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await act(async () => {
          tap(sheetButton(renderer, 'Permanently delete'));
        });
        expect(allText(renderer)).toContain('Deletion status unknown');
        expect(
          useAuthStore.getState().completeAccountDeletion,
        ).not.toHaveBeenCalled();
        expect(mockShowBrandNotice).not.toHaveBeenCalled();
      } finally {
        act(() => renderer.unmount());
      }
    },
  );

  it('PASS malformed delete-request payload never arms a confirmation', async () => {
    script = async call => {
      if (call.path === '/v1/me/delete-request') {
        return jsonResponse(200, { challenge: 42, expiresAt: null });
      }
      return jsonResponse(500, {});
    };
    const renderer = renderScreen();
    try {
      await act(async () => {
        pressable(renderer, 'Delete account')[0]!.props.onPress();
      });
      await act(async () => {
        pressable(renderer, 'Skip the survey')[0]!.props.onPress();
      });
      await act(async () => {
        sheetButton(renderer, 'Continue to delete').props.onPress();
      });
      expect(allText(renderer)).toContain('invalid deletion challenge');
      expect(confirmCalls()).toHaveLength(0);
      expect(sheetButton(renderer, 'Keep my account').props.disabled).toBe(
        false,
      );
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('PASS 409 deletion_in_progress on a fresh request keeps the account (nothing armed, nothing purged)', async () => {
    script = async call => {
      if (call.path === '/v1/me/delete-request') {
        return jsonResponse(409, {
          error: {
            code: 'account.deletion_in_progress',
            message:
              'Account deletion is already confirmed. Check its status before starting again.',
          },
        });
      }
      return jsonResponse(500, {});
    };
    const renderer = renderScreen();
    try {
      await act(async () => {
        pressable(renderer, 'Delete account')[0]!.props.onPress();
      });
      await act(async () => {
        pressable(renderer, 'Skip the survey')[0]!.props.onPress();
      });
      await act(async () => {
        sheetButton(renderer, 'Continue to delete').props.onPress();
      });
      expect(allText(renderer)).toContain('already confirmed');
      expect(confirmCalls()).toHaveLength(0);
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).not.toHaveBeenCalled();
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('ATTACK process death after confirm: a relaunched client should resume the confirmed operation via status or operationId', async () => {
    // Session 1: the user confirms; the Edge accepts the work (202) and the
    // process dies before the client hears back. The Edge now refuses fresh
    // requests with "check its status" and only resumes on a confirm carrying
    // the original challenge or operationId.
    script = async call => {
      if (call.path === '/v1/me/delete-request') {
        return jsonResponse(200, requestPayload);
      }
      if (call.path === '/v1/me/delete-confirm') {
        return jsonResponse(
          202,
          { operationId: OPERATION_ID, state: 'in_progress' },
          { 'Retry-After': '3' },
        );
      }
      return jsonResponse(500, {});
    };
    const first = renderScreen();
    await armDeletion(first);
    await act(async () => {
      tap(sheetButton(first, 'Permanently delete'));
    });
    expect(confirmCalls()).toHaveLength(1);
    act(() => first.unmount());

    // Session 2 (relaunch): the only thing the Edge will accept for this
    // owner is the original challenge/operationId or the status capability.
    const acceptedConfirms: Array<Record<string, unknown> | null> = [];
    script = async call => {
      if (call.path === '/v1/me/delete-request') {
        return jsonResponse(409, {
          error: {
            code: 'account.deletion_in_progress',
            message:
              'Account deletion is already confirmed. Check its status before starting again.',
          },
        });
      }
      if (call.path === '/v1/me/delete-status') {
        return jsonResponse(200, {
          state: 'in_progress',
          completionReceipt: null,
          appleAuthorizationRevocation: null,
        });
      }
      if (call.path === '/v1/me/delete-confirm') {
        acceptedConfirms.push(call.body);
        return jsonResponse(202, {
          operationId: OPERATION_ID,
          state: 'in_progress',
        });
      }
      return jsonResponse(500, {});
    };
    calls.length = 0;
    const relaunched = renderScreen();
    try {
      await act(async () => {
        pressable(relaunched, 'Delete account')[0]!.props.onPress();
      });
      await act(async () => {
        pressable(relaunched, 'Skip the survey')[0]!.props.onPress();
      });
      await act(async () => {
        sheetButton(relaunched, 'Continue to delete').props.onPress();
      });
      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
      // A relaunched client that persisted the capability/operationId would
      // consult status or resume the operation; either path is acceptable.
      const resumed =
        statusCalls().length > 0 ||
        acceptedConfirms.some(
          body =>
            body?.challenge === CHALLENGE || body?.operationId === OPERATION_ID,
        );
      expect(resumed).toBe(true);
    } finally {
      act(() => relaunched.unmount());
    }
  });

  it('OBSERVED process death after confirm: the relaunched client is told to check a status it has no path to', async () => {
    script = async call => {
      if (call.path === '/v1/me/delete-request') {
        return jsonResponse(200, requestPayload);
      }
      if (call.path === '/v1/me/delete-confirm') {
        return jsonResponse(202, {
          operationId: OPERATION_ID,
          state: 'in_progress',
        });
      }
      return jsonResponse(500, {});
    };
    const first = renderScreen();
    await armDeletion(first);
    await act(async () => {
      tap(sheetButton(first, 'Permanently delete'));
    });
    act(() => first.unmount());

    script = async call => {
      if (call.path === '/v1/me/delete-request') {
        return jsonResponse(409, {
          error: {
            code: 'account.deletion_in_progress',
            message:
              'Account deletion is already confirmed. Check its status before starting again.',
          },
        });
      }
      return jsonResponse(500, {});
    };
    calls.length = 0;
    const relaunched = renderScreen();
    try {
      await act(async () => {
        pressable(relaunched, 'Delete account')[0]!.props.onPress();
      });
      await act(async () => {
        pressable(relaunched, 'Skip the survey')[0]!.props.onPress();
      });
      await act(async () => {
        sheetButton(relaunched, 'Continue to delete').props.onPress();
      });
      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
      expect(allText(relaunched)).toContain('Check its status');
      expect(statusCalls()).toHaveLength(0);
      expect(confirmCalls()).toHaveLength(0);
      expect(pressable(relaunched, 'Check deletion status')).toHaveLength(0);
      // The account is neither deleted locally nor recoverable from here.
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).not.toHaveBeenCalled();
      expect(useAuthStore.getState().session).toBe(syncedSession);
    } finally {
      act(() => relaunched.unmount());
    }
  });
});
