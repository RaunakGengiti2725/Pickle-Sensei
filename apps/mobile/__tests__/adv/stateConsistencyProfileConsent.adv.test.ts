/**
 * INT-state-consistency adversarial probes against appStore (owner-scoped
 * coaching profile) and consentStore on integration head 2994371e. A FAILING
 * attack is a confirmed break; a PASSING attack is evidence the boundary holds.
 */
import type { Profile } from '../../src/state/profile';
import type { LocalDb } from '../../src/data/db';
import type { DataOwnerContext } from '../../src/data/accountScope';
import {
  SIGNED_OUT_DATA_OWNER,
  captureDataOwnerContext,
  profileKeyForOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';

const mockKvTable = new Map<string, string>();
let mockFailWriteKey: string | null = null;

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    const db: LocalDb = {
      async execute(sql: string, params: unknown[] = []) {
        if (sql.startsWith('SELECT value FROM kv')) {
          const value = mockKvTable.get(String(params[0]));
          return { rows: value === undefined ? [] : [{ value }] };
        }
        if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
          if (mockFailWriteKey === params[0]) throw new Error('disk full');
          mockKvTable.set(String(params[0]), String(params[1]));
          return { rows: [] };
        }
        return { rows: [] };
      },
      async transaction(operation) {
        const snapshot = new Map(mockKvTable);
        try {
          return await operation(db);
        } catch (error) {
          mockKvTable.clear();
          for (const [key, value] of snapshot) mockKvTable.set(key, value);
          throw error;
        }
      },
      close() {},
    };
    return db;
  },
}));

type MockApiSession = {
  apiBaseUrl: string;
  bearerToken: string;
  canonicalAppUserId: string;
  provider: 'apple';
} | null;
let mockApiSession: MockApiSession = null;
const mockApiListeners = new Set<(session: MockApiSession) => void>();
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockApiSession,
  subscribeToApiSession: (listener: (session: MockApiSession) => void) => {
    mockApiListeners.add(listener);
    return () => mockApiListeners.delete(listener);
  },
}));

const mockFetchCanonical = jest.fn<Promise<Profile | null>, [unknown]>(
  async () => null,
);
const mockSaveCanonical = jest.fn<Promise<Profile>, [unknown, Profile]>(
  async (_session, profile) => profile,
);
jest.mock('../../src/account/onboarding', () => ({
  fetchCanonicalOnboardingProfile: (session: unknown) =>
    mockFetchCanonical(session),
  saveCanonicalOnboardingProfile: (session: unknown, profile: Profile) =>
    mockSaveCanonical(session, profile),
}));

import {
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../src/state/appStore';
import { MODEL_TRAINING_CONSENT_VERSION } from '../../src/account/consentApi';
import {
  configureConsentStore,
  resetConsentStore,
  useConsentStore,
} from '../../src/state/consentStore';

const OWNER_A = 'a0000000-0000-4000-8000-000000000001';
const OWNER_B = 'b0000000-0000-4000-8000-000000000002';

const profileA: Profile = {
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
};
const profileB: Profile = {
  ...profileA,
  skillLevel: '4.0',
  goal: 'dinks',
  focusCheckpoint: 'contact_position',
};

function installSession(owner: string) {
  mockApiSession = {
    apiBaseUrl: 'https://api.example.test',
    bearerToken: `token-${owner}`,
    canonicalAppUserId: owner,
    provider: 'apple',
  };
  for (const listener of mockApiListeners) listener(mockApiSession);
}

function clearSession() {
  mockApiSession = null;
  for (const listener of mockApiListeners) listener(null);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(turns = 80) {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

function statusBody(modelTrainingActive: boolean) {
  return {
    subjectPseudonym: 'c0000000-0000-0000-0000-000000000003',
    scopes: [
      {
        scope: 'model_training',
        active: modelTrainingActive,
        consentVersion: modelTrainingActive
          ? MODEL_TRAINING_CONSENT_VERSION
          : null,
        lastAction: modelTrainingActive ? 'granted' : 'withdrawn',
        lastActionAt: '2026-08-29T00:00:00.000Z',
      },
    ],
  };
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: () => Promise.resolve(body) } as unknown as Response;
}

function contextFor(owner: string): DataOwnerContext {
  setActiveDataOwner(owner);
  return captureDataOwnerContext();
}

beforeEach(() => {
  mockKvTable.clear();
  mockFailWriteKey = null;
  mockApiSession = null;
  mockFetchCanonical.mockReset();
  mockFetchCanonical.mockImplementation(async () => null);
  mockSaveCanonical.mockReset();
  mockSaveCanonical.mockImplementation(async (_session, profile) => profile);
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  resetConsentStore();
  return useAppStore.getState().hydrate();
});

afterEach(() => {
  clearSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  resetConsentStore();
});

describe('ADV-11 corrupt profile bytes + malformed pre-auth stash + empty canonical', () => {
  it('never fabricates a profile and retains both corrupt rows for a later authoritative write', async () => {
    mockKvTable.set(profileKeyForOwner(OWNER_A), '{"skillLevel":');
    mockKvTable.set(
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      '{"version":1,"profile":{"skillLevel":"pro"}}',
    );
    setActiveDataOwner(OWNER_A);
    installSession(OWNER_A);
    await useAppStore.getState().hydrate();
    await flush();
    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.profile).toBeNull();
    expect(state.awaitingApiSession).toBe(false);
    expect(mockFetchCanonical).toHaveBeenCalledTimes(1);
    expect(mockSaveCanonical).not.toHaveBeenCalled();
    expect(mockKvTable.get(profileKeyForOwner(OWNER_A))).toBe('{"skillLevel":');
    expect(mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe(
      '{"version":1,"profile":{"skillLevel":"pro"}}',
    );
  });
});

describe('ADV-12 completeOnboarding() racing a concurrent hydrate() for the same owner', () => {
  it('keeps the server-accepted profile locally and in state after both settle', async () => {
    setActiveDataOwner(OWNER_A);
    installSession(OWNER_A);
    await useAppStore.getState().hydrate();
    await flush();
    expect(useAppStore.getState().profile).toBeNull();

    const save = deferred<Profile>();
    mockSaveCanonical.mockReturnValueOnce(save.promise);
    const saving = useAppStore.getState().completeOnboarding(profileA);
    await flush();
    // A second hydrate lands while the save round trip is in flight (e.g. a
    // gate re-render); the server has not answered the fetch yet either.
    const fetch = deferred<Profile | null>();
    mockFetchCanonical.mockReturnValueOnce(fetch.promise);
    const hydrating = useAppStore.getState().hydrate();
    await flush();
    save.resolve(profileA);
    await saving;
    fetch.resolve(null);
    await hydrating;
    await flush();
    const state = useAppStore.getState();
    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);
    expect(state.onboardingBusy).toBe(false);
    expect(state.profile).toEqual(profileA);
    expect(mockKvTable.get(profileKeyForOwner(OWNER_A))).toBe(
      JSON.stringify(profileA),
    );
  });
});

describe('ADV-13 local write fails after the server accepted the profile (process-death analogue)', () => {
  it('surfaces the failure without a fabricated profile, then recovers from the server on relaunch without re-asking', async () => {
    setActiveDataOwner(OWNER_A);
    installSession(OWNER_A);
    await useAppStore.getState().hydrate();
    await flush();
    mockFailWriteKey = profileKeyForOwner(OWNER_A);
    await useAppStore.getState().completeOnboarding(profileA);
    let state = useAppStore.getState();
    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);
    expect(state.profile).toBeNull();
    expect(state.onboardingBusy).toBe(false);
    expect(state.onboardingError).toBe('disk full');
    expect(mockKvTable.has(profileKeyForOwner(OWNER_A))).toBe(false);

    mockFailWriteKey = null;
    mockFetchCanonical.mockResolvedValueOnce(profileA);
    await useAppStore.getState().hydrate();
    await flush();
    state = useAppStore.getState();
    expect(state.profile).toEqual(profileA);
    expect(state.hydrateError).toBeNull();
    expect(mockKvTable.get(profileKeyForOwner(OWNER_A))).toBe(
      JSON.stringify(profileA),
    );
    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);
  });
});

describe('ADV-14 owner A\u2019s canonical profile fetch resolves after A signs out and B signs in', () => {
  it('never writes A\u2019s profile into B\u2019s bucket or state', async () => {
    setActiveDataOwner(OWNER_A);
    installSession(OWNER_A);
    const fetchA = deferred<Profile | null>();
    mockFetchCanonical.mockReturnValueOnce(fetchA.promise);
    const hydratingA = useAppStore.getState().hydrate();
    await flush();
    // Sign out, then B signs in and hydrates with an empty server profile.
    clearSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    await useAppStore.getState().hydrate();
    setActiveDataOwner(OWNER_B);
    installSession(OWNER_B);
    mockFetchCanonical.mockResolvedValueOnce(profileB);
    const hydratingB = useAppStore.getState().hydrate();
    fetchA.resolve(profileA);
    await Promise.all([hydratingA, hydratingB]);
    await flush();
    const state = useAppStore.getState();
    expect(state.ownerKey).toBe(OWNER_B);
    expect(state.profile).toEqual(profileB);
    expect(mockKvTable.get(profileKeyForOwner(OWNER_B))).toBe(
      JSON.stringify(profileB),
    );
    expect(mockKvTable.has(profileKeyForOwner(OWNER_A))).toBe(false);
  });
});

describe('ADV-15 consent toggle during an in-flight hydrate whose own request then fails', () => {
  it('leaves the store in a resolved availability instead of loading forever', async () => {
    const context = contextFor(OWNER_A);
    installSession(OWNER_A);
    configureConsentStore(context);
    const status = deferred<Response>();
    const hydrating = useConsentStore.getState().hydrate(() => status.promise);
    expect(useConsentStore.getState().availability).toBe('loading');
    const toggling = useConsentStore
      .getState()
      .setModelTrainingConsent(true, () =>
        Promise.reject(new Error('network down')),
      );
    await toggling;
    status.resolve(jsonResponse(statusBody(false)));
    await hydrating;
    await flush();
    const state = useConsentStore.getState();
    expect(state.busy).toBe(false);
    expect(state.modelTrainingActive).toBe(false);
    expect(state.availability).not.toBe('loading');
  });
});

describe('ADV-16 consent grant resolves after sign-out and a different owner signs in', () => {
  it('does not grant model-training consent to owner B from A\u2019s late response', async () => {
    const contextA = contextFor(OWNER_A);
    installSession(OWNER_A);
    configureConsentStore(contextA);
    await useConsentStore
      .getState()
      .hydrate(async () => jsonResponse(statusBody(false)));
    expect(useConsentStore.getState().availability).toBe('ready');
    const grant = deferred<Response>();
    const granting = useConsentStore
      .getState()
      .setModelTrainingConsent(true, () => grant.promise);
    await flush();
    expect(useConsentStore.getState().busy).toBe(true);

    clearSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    resetConsentStore();
    const contextB = contextFor(OWNER_B);
    installSession(OWNER_B);
    configureConsentStore(contextB);
    await useConsentStore
      .getState()
      .hydrate(async () => jsonResponse(statusBody(false)));
    grant.resolve(jsonResponse(statusBody(true)));
    await granting;
    await flush();
    const state = useConsentStore.getState();
    expect(state.ownerContext?.ownerKey).toBe(OWNER_B);
    expect(state.availability).toBe('ready');
    expect(state.modelTrainingActive).toBe(false);
    expect(state.busy).toBe(false);
  });
});
