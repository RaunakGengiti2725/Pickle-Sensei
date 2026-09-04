/**
 * ADVERSARIAL PASS 3 — scenario 7 (mobile-launch-onboarding).
 *
 * Attack: seed the pre-auth stash with a 1 MB `skillLevel` (plus a 6 MB
 * variant above the edge API's 5 MB JSON body limit) and hydrate a canonical
 * owner. The REAL `saveCanonicalOnboardingProfile` runs against a captured
 * fetch that answers exactly like the edge route (`skillLevel.length > 64` →
 * 400 "Invalid onboarding payload.").
 *
 * Expected: either the stash is rejected before any network call, or the
 * PUT /v1/me/onboarding body is bounded — and a body the server rejects as
 * invalid is not re-sent on every later hydrate.
 */
import type { Profile } from '../../../src/state/profile';
import {
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';

const mockKvTable = new Map<string, string>();

jest.mock('../../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKvTable.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

jest.mock('../../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({ appVersion: '1.0.0-attack' }),
}));

const CANONICAL_ID = '77777777-7777-4777-8777-777777777777';
const API_BASE = 'https://api.example.test';

let mockApiSession: {
  apiBaseUrl: string;
  bearerToken: string;
  canonicalAppUserId: string;
  provider: 'apple';
} | null = null;
jest.mock('../../../src/account/apiSession', () => ({
  getApiSession: () => mockApiSession,
}));

import {
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../../src/state/appStore';

interface CapturedRequest {
  url: string;
  method: string;
  bodyBytes: number;
}

const captured: CapturedRequest[] = [];
const MAX_JSON_BODY_BYTES = 5_000_000; // supabase/functions/api/index.ts

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** Behaves like the edge API for the routes hydrate() touches. */
function fakeEdgeFetch(input: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET';
  const body = typeof init?.body === 'string' ? init.body : '';
  const bodyBytes = utf8ByteLength(body);
  captured.push({ url: input, method, bodyBytes });
  const json = (status: number, payload: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  if (bodyBytes > MAX_JSON_BODY_BYTES) {
    return json(413, { error: { message: 'Request body too large.' } });
  }
  if (method === 'GET' && input.endsWith('/v1/me')) {
    return json(200, {
      id: CANONICAL_ID,
      email: 'dana@example.test',
      onboardingState: 'pending',
      profile: null,
    });
  }
  if (method === 'PUT' && input.endsWith('/v1/me/onboarding')) {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const skillLevel =
      typeof parsed['skillLevel'] === 'string' ? parsed['skillLevel'] : '';
    if (!skillLevel || skillLevel.length > 64) {
      return json(400, { error: { message: 'Invalid onboarding payload.' } });
    }
    return json(200, { recommendedCheckpoint: 'paddle_set' });
  }
  return json(404, { error: { message: 'Not found.' } });
}

const answers: Profile = {
  firstName: 'Dana',
  gender: 'female',
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
};

function seedStash(profile: Profile) {
  mockKvTable.set(
    PENDING_ONBOARDING_PROFILE_KV_KEY,
    JSON.stringify({ version: 1, profile }),
  );
}

function puts(): CapturedRequest[] {
  return captured.filter(r => r.method === 'PUT');
}

const ONE_MB = 1_048_576;
/** Generous upper bound for a legitimate onboarding body (server caps every
 * field at ≤1 000 chars; a real body is ~150 bytes). */
const REASONABLE_BODY_BYTES = 16_384;

let originalFetch: typeof globalThis.fetch;

beforeAll(() => {
  originalFetch = globalThis.fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  mockKvTable.clear();
  captured.length = 0;
  globalThis.fetch = fakeEdgeFetch as typeof globalThis.fetch;
  mockApiSession = {
    apiBaseUrl: API_BASE,
    bearerToken: 'bearer-attack',
    canonicalAppUserId: CANONICAL_ID,
    provider: 'apple',
  };
  setActiveDataOwner(canonicalDataOwner(CANONICAL_ID));
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
  });
});

describe('S7 — 1 MB skillLevel in the pre-auth stash', () => {
  it('canonical PUT /v1/me/onboarding body is bounded, or the stash is rejected before any network call', async () => {
    seedStash({ ...answers, skillLevel: 'x'.repeat(ONE_MB) });
    await useAppStore.getState().hydrate();
    const sent = puts();
    const largest = Math.max(0, ...sent.map(r => r.bodyBytes));
    expect({
      putCount: sent.length,
      largestPutBodyBytes: largest,
      boundedOrRejectedPreNetwork: largest <= REASONABLE_BODY_BYTES,
    }).toEqual(expect.objectContaining({ boundedOrRejectedPreNetwork: true }));
  });

  it('a body the server rejected as invalid (400) is not re-sent unchanged on every later hydrate', async () => {
    seedStash({ ...answers, skillLevel: 'x'.repeat(ONE_MB) });
    for (let launch = 0; launch < 3; launch += 1) {
      await useAppStore.getState().hydrate();
    }
    const sent = puts();
    const totalBytes = sent.reduce((sum, r) => sum + r.bodyBytes, 0);
    // A deterministic 400 must not be retried like a network blip: at most
    // the first launch's attempt (plus its identity-fields fallback) may hit
    // the network, and the stash must be gone afterwards.
    expect({
      putCount: sent.length,
      totalPutBytesAcross3Launches: totalBytes,
      stashStillPresent: Boolean(
        mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY),
      ),
      retriedOnLaterLaunches: sent.length > 2,
    }).toEqual({
      // Observed counters are echoed so the failure output records them.
      putCount: sent.length,
      totalPutBytesAcross3Launches: totalBytes,
      stashStillPresent: false,
      retriedOnLaterLaunches: false,
    });
  });

  it('6 MB skillLevel (above the edge 5 MB JSON limit) is not shipped to the network at all', async () => {
    seedStash({ ...answers, skillLevel: 'y'.repeat(6 * ONE_MB) });
    await useAppStore.getState().hydrate();
    const sent = puts();
    expect(sent.map(r => r.bodyBytes > MAX_JSON_BODY_BYTES)).not.toContain(
      true,
    );
  });

  it('1 MB skillLevel is not installed as the owner profile / kept in memory after the server refuses it', async () => {
    seedStash({ ...answers, skillLevel: 'x'.repeat(ONE_MB) });
    await useAppStore.getState().hydrate();
    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.profile?.skillLevel.length ?? 0).toBeLessThanOrEqual(64);
    const raw = mockKvTable.get(`profile:${canonicalDataOwner(CANONICAL_ID)}`);
    expect(raw?.length ?? 0).toBeLessThanOrEqual(REASONABLE_BODY_BYTES);
  });

  it('positive control: a normal stash produces one small PUT and is adopted with the server focus', async () => {
    seedStash(answers);
    await useAppStore.getState().hydrate();
    const sent = puts();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.bodyBytes).toBeLessThan(512);
    expect(useAppStore.getState().profile?.focusCheckpoint).toBe('paddle_set');
    expect(mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe('');
  });
});
