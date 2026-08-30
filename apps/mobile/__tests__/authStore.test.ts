/**
 * Auth store behavior with no native modules and no Google client id
 * configured — exactly the states these tests verify: typed not_configured
 * errors, never fake sign-ins. The checked-in runtime config now ships real
 * OAuth client IDs, so the unconfigured state is pinned via this mock.
 * (Configured-client behavior, including silent restore, lives in
 * authHydrateRestore.test.ts.)
 */
import { useAuthStore } from '../src/auth/authStore';
import { establishApiSession, getApiSession } from '../src/account/apiSession';

jest.mock('../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

// SQLite native module is absent under jest; the store's persistence guard
// swallows that (session stays in memory), which is what we exercise here.
jest.mock('../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

beforeEach(() => {
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
  });
  establishApiSession({
    apiBaseUrl: 'https://api.example.test',
    bearerToken: 'transient-test-token',
    canonicalAppUserId: '7fc2c743-028f-4ec6-942c-a84508f3be38',
    provider: 'apple',
  });
});

describe('authStore', () => {
  it('hydrates to signed-out when no local db exists', async () => {
    await useAuthStore.getState().hydrate();
    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.session).toBeNull();
  });

  it('apple sign-in without the native module is a typed not_configured error — not a fake session', async () => {
    await useAuthStore.getState().signInWithApple();
    const state = useAuthStore.getState();
    expect(state.session).toBeNull();
    expect(state.error?.code).toBe('auth.not_configured');
    expect(state.busy).toBe(false);
  });

  it('google sign-in without a client id is a typed not_configured error', async () => {
    await useAuthStore.getState().signInWithGoogle();
    const state = useAuthStore.getState();
    expect(state.session).toBeNull();
    expect(state.error?.code).toBe('auth.not_configured');
    expect(state.error?.message).toMatch(/client id/i);
  });

  it('guest session signs in locally and sign-out clears it', async () => {
    await useAuthStore.getState().continueAsGuest();
    let state = useAuthStore.getState();
    expect(state.session?.provider).toBe('guest');
    expect(state.session).toMatchObject({
      subject: 'local-only',
      canonicalAppUserId: null,
      localOnly: true,
    });
    expect(getApiSession()).toBeNull();
    await useAuthStore.getState().signOut();
    state = useAuthStore.getState();
    expect(state.session).toBeNull();
    expect(getApiSession()).toBeNull();
  });

  it('clearError resets the error state', async () => {
    await useAuthStore.getState().signInWithGoogle();
    expect(useAuthStore.getState().error).not.toBeNull();
    useAuthStore.getState().clearError();
    expect(useAuthStore.getState().error).toBeNull();
  });
});
