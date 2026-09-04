/**
 * Adjudication reproduction (xc-journeys / journey-settings-account-deletion):
 * when the response to POST /v1/me/delete-confirm is lost after the server
 * executed the deletion, the client asserts "Nothing was deleted", and the
 * retry (bearer now belongs to a deleted user → 401) is mapped to "sign-in
 * expired" with retryable=false, so ManageAccountScreen never reaches
 * onDeleted → completeAccountDeletion (Keychain record + local owner data
 * are never purged; the next launch silently signs out).
 */
import type { ApiSession } from '../../../src/account/apiSession';
import {
  AccountDeletionError,
  confirmAccountDeletion,
} from '../../../src/account/deletion';

const session: ApiSession = {
  apiBaseUrl: 'https://edge.example',
  bearerToken: 'access-token',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  provider: 'apple',
} as unknown as ApiSession;

const challenge = '22222222-2222-4222-8222-222222222222';

describe('adjudication: lost delete-confirm response', () => {
  it('does not claim "Nothing was deleted" when the server may have deleted the account', async () => {
    let serverDeleted = false;
    const lostResponse = async (
      _url: string,
      _init?: unknown,
    ): Promise<Response> => {
      serverDeleted = true; // request reached the server and was executed
      throw new TypeError('Network request failed');
    };
    let first: unknown = null;
    await confirmAccountDeletion(session, challenge, lostResponse).catch(e => {
      first = e;
    });
    expect(serverDeleted).toBe(true);
    expect(first).toBeInstanceOf(AccountDeletionError);
    const firstError = first as AccountDeletionError;

    const afterDeletion = async (): Promise<Response> =>
      new Response(JSON.stringify({ error: { code: 'auth.required' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    let retry: unknown = null;
    await confirmAccountDeletion(session, challenge, afterDeletion).catch(e => {
      retry = e;
    });
    const retryError = retry as AccountDeletionError;

    console.log(
      `[adjudicate] first="${firstError.message}" retryable=${firstError.retryable} retry="${retryError.message}" retryCode=${retryError.code} retryable=${retryError.retryable}`,
    );
    // Expected product behaviour: an unknown outcome must not be presented as
    // "Nothing was deleted", and a 401 on retry (account gone) must resolve the
    // deletion locally rather than dead-end at "sign in again".
    expect(firstError.message).not.toContain('Nothing was deleted');
    expect(retryError.code).not.toBe('deletion.session_expired');
  });
});
