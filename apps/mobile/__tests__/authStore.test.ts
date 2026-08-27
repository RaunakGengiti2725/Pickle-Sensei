/**
 * Auth store behavior. The jest environment has no native modules and no
 * Google client id configured — exactly the states these tests verify:
 * typed not_configured errors, never fake sign-ins.
 */
import { useAuthStore } from '../src/auth/authStore';

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
    expect(state.session?.subject).toMatch(/^guest-/);
    await useAuthStore.getState().signOut();
    state = useAuthStore.getState();
    expect(state.session).toBeNull();
  });

  it('clearError resets the error state', async () => {
    await useAuthStore.getState().signInWithGoogle();
    expect(useAuthStore.getState().error).not.toBeNull();
    useAuthStore.getState().clearError();
    expect(useAuthStore.getState().error).toBeNull();
  });
});
