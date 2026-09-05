/**
 * Pin for MSA-P1-1 acceptance criterion 1 (request step): a 401 on
 * POST /v1/me/delete-request must report the rejected bearer to the auth
 * store (reportApiUnauthorized) before the AccountDeletionError is thrown.
 * confirmAccountDeletion's half of the criterion lives in
 * deletionLostConfirm.repro.test.tsx.
 */
import {
  clearApiSession,
  establishApiSession,
  setApiUnauthorizedListener,
} from '../../src/account/apiSession';
import {
  AccountDeletionError,
  requestAccountDeletion,
} from '../../src/account/deletion';

const canonicalAppUserId = '11111111-1111-4111-8111-111111111111';
const apiSession = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'access-token-1',
  canonicalAppUserId,
  provider: 'apple' as const,
};

const unauthorizedListener = jest.fn();

beforeEach(() => {
  unauthorizedListener.mockReset();
  establishApiSession(apiSession);
  setApiUnauthorizedListener(unauthorizedListener);
});

afterEach(() => {
  setApiUnauthorizedListener(null);
  clearApiSession();
});

it('requestAccountDeletion: a 401 reports the rejected bearer to the auth store before throwing', async () => {
  const fetchFn = jest.fn(() =>
    Promise.resolve({
      ok: false,
      status: 401,
      json: () =>
        Promise.resolve({
          error: { message: 'The session is no longer valid. Sign in again.' },
        }),
    } as unknown as Response),
  );
  await expect(
    requestAccountDeletion(apiSession, null, fetchFn),
  ).rejects.toMatchObject({
    name: 'AccountDeletionError',
    code: 'deletion.session_expired',
  } satisfies Partial<AccountDeletionError>);
  expect(unauthorizedListener).toHaveBeenCalledTimes(1);
  expect(unauthorizedListener.mock.calls[0]?.[0]).toMatchObject({
    bearerToken: 'access-token-1',
    canonicalAppUserId,
  });
});
