import type { Profile } from '../../src/state/profile';
import {
  GUEST_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

/**
 * Crash-safety audit — untrusted persisted JSON and timestamps.
 *
 * Every kv/SQLite payload the app reads back was written by an earlier
 * build (or a corrupted disk). These tests feed garbage through the real
 * parsers and stores and assert the launch-critical paths land in an honest
 * empty state instead of throwing into React render.
 */

const mockKvTable = new Map<string, string>();

jest.mock('../../src/data/db', () => ({
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

jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => null,
}));

jest.mock('../../src/account/onboarding', () => ({
  fetchCanonicalOnboardingProfile: async () => null,
  saveCanonicalOnboardingProfile: async (_s: unknown, profile: Profile) =>
    profile,
}));

import {
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../src/state/appStore';
import { parseConsistencyLedger } from '../../src/consistency/store';
import { parseReviewPromptState } from '../../src/review/appStoreReview';
import {
  buildConsistencySnapshot,
  dayOrdinal,
} from '../../src/consistency/engine';

const GARBAGE_PAYLOADS = [
  '{not json',
  '[]',
  'null',
  '"string"',
  '42',
  '{"version":"1","profile":7}',
];

beforeEach(() => {
  mockKvTable.clear();
  setActiveDataOwner(GUEST_DATA_OWNER);
  // `preAuthOnboarded` is gone (product decision 2026-09-01: no device-level
  // "already onboarded" marker); `hydrateError` is the launch-gate retry state.
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
    lastShotType: 'forehand_drive',
  });
});

describe('appStore.hydrate() survives corrupt persisted JSON', () => {
  it.each(GARBAGE_PAYLOADS)(
    'corrupt owner profile %j settles hydrate() without throwing',
    async raw => {
      mockKvTable.set(`profile:${GUEST_DATA_OWNER}`, raw);
      await expect(useAppStore.getState().hydrate()).resolves.toBeUndefined();
      const state = useAppStore.getState();
      expect(state.hydrated).toBe(true);
      expect(state.ownerKey).toBe(GUEST_DATA_OWNER);
      // Either the parser rejected the row (null) or JSON.parse accepted a
      // primitive; neither path may leave hydrate() rejected.
      expect(state.onboardingBusy).toBe(false);
    },
  );

  it.each(GARBAGE_PAYLOADS)(
    'corrupt pre-auth stash %j is ignored and never adopted as a profile',
    async raw => {
      mockKvTable.set(PENDING_ONBOARDING_PROFILE_KV_KEY, raw);
      await expect(useAppStore.getState().hydrate()).resolves.toBeUndefined();
      const state = useAppStore.getState();
      expect(state.hydrated).toBe(true);
      expect(state.profile).toBeNull();
      // A malformed stash must not be written into the owner's profile slot.
      expect(mockKvTable.get(`profile:${GUEST_DATA_OWNER}`)).toBeUndefined();
    },
  );
});

describe('owner-scoped kv parsers reject garbage without throwing', () => {
  it.each(GARBAGE_PAYLOADS)(
    'parseConsistencyLedger(%j) yields an empty ledger',
    raw => {
      const ledger = parseConsistencyLedger(raw);
      expect(ledger.drills).toEqual([]);
      expect(ledger.celebrated).toEqual({});
    },
  );

  it.each(GARBAGE_PAYLOADS)(
    'parseReviewPromptState(%j) yields a default state',
    raw => {
      const state = parseReviewPromptState(raw);
      expect(state).toEqual(parseReviewPromptState(null));
    },
  );
});

describe('consistency engine tolerates invalid timestamps', () => {
  it('drops activities with unparseable atIso and keeps the valid ones', () => {
    const snapshot = buildConsistencySnapshot(
      [
        { kind: 'stroke', atIso: 'not-a-date', resultKind: 'scored' },
        { kind: 'stroke', atIso: '', resultKind: 'scored' },
        {
          kind: 'stroke',
          atIso: '2026-08-30T10:00:00.000Z',
          resultKind: 'scored',
          overallScore: 7.1,
        },
      ],
      { asOfIso: '2026-08-30T12:00:00.000Z', timeZone: 'UTC' },
    );
    expect(snapshot.totalActivities).toBe(1);
    expect(snapshot.currentStreak).toBe(1);
    expect(Object.keys(snapshot.days)).toEqual(['2026-08-30']);
  });

  it('falls back to now when asOfIso itself is unparseable', () => {
    expect(() =>
      buildConsistencySnapshot([], { asOfIso: 'garbage', timeZone: 'UTC' }),
    ).not.toThrow();
    const snapshot = buildConsistencySnapshot([], {
      asOfIso: 'garbage',
      timeZone: 'UTC',
    });
    expect(Number.isFinite(dayOrdinal(snapshot.asOfDay))).toBe(true);
  });

  it('falls back to a supported formatter for an unknown IANA zone', () => {
    expect(() =>
      buildConsistencySnapshot([], {
        asOfIso: '2026-08-30T12:00:00.000Z',
        timeZone: 'Not/AZone',
      }),
    ).not.toThrow();
  });
});
