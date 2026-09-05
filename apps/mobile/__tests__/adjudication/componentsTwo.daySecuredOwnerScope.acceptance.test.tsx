/**
 * ADJUDICATION acceptance pin — stress area `components-2`, consistency.
 *
 * C2-CON-1 (RED on 1fb0efd7): a "Day N secured" moment armed while owner A
 * was active must never be shown to, or persisted under, a different owner.
 * `consumeDaySecured()` reads `getActiveDataOwner()` at CONSUME time, so a
 * moment armed for A and consumed after the owner changed to B is rendered
 * with A's streak and written to `consistency:<B>` as B's once-per-day
 * marker. Reachable without a signed-out pass: guest → "Connect account"
 * (`installApiSession` switches the owner directly) → Coach → score →
 * ResultScreen mounts the banner before B's first refresh lands.
 *
 * Independently reproduced from
 * `devin/stress-cmp-consistency-ui-rapid-interaction`
 * (`__tests__/stress/daySecuredOwnerScope.stress.test.tsx`).
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockKv = new Map<string, string>();

jest.mock('../../src/data/db', () => ({ getDb: () => ({ tag: 'db' }) }));
jest.mock('../../src/data/repository', () => ({
  getKv: async (_db: unknown, key: string) => mockKv.get(key) ?? null,
  setKv: async (_db: unknown, key: string, value: string) => {
    mockKv.set(key, value);
  },
  listActivityShots: async () => [],
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import { DaySecuredBanner } from '../../src/consistency/DaySecuredBanner';
import {
  consistencyKeyForOwner,
  useConsistencyStore,
  type DaySecuredMoment,
} from '../../src/consistency/store';
import {
  GUEST_DATA_OWNER,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import { useReducedMotion } from '../../src/design/components';

const OWNER_B = '22222222-2222-4222-8222-222222222222';

const MOMENT: DaySecuredMoment = {
  day: '2026-03-10',
  streak: 12,
  xpToday: 30,
  shieldsAvailable: 1,
  nextMilestone: null,
};

function MotionProbe() {
  useReducedMotion();
  return null;
}

beforeAll(async () => {
  let probe!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    probe = TestRenderer.create(<MotionProbe />);
  });
  act(() => probe.unmount());
});

afterEach(() => {
  mockKv.clear();
  act(() => {
    useConsistencyStore.setState({ daySecured: null });
  });
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

function banners(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.testID === 'day-secured-banner',
  );
}

describe('components-2 adjudication: Day Secured owner scope (RED on 1fb0efd7)', () => {
  it('C2-CON-1: a moment armed for the guest owner is neither shown to nor persisted for the account that connects next', async () => {
    setActiveDataOwner(GUEST_DATA_OWNER);
    act(() => {
      useConsistencyStore.setState({ daySecured: MOMENT });
    });
    setActiveDataOwner(OWNER_B);

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<DaySecuredBanner />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(banners(renderer)).toHaveLength(0);
    expect(mockKv.get(consistencyKeyForOwner(OWNER_B))).toBeUndefined();
    expect(
      mockKv.get(consistencyKeyForOwner(GUEST_DATA_OWNER)),
    ).toBeUndefined();
    expect(useConsistencyStore.getState().daySecured).toBeNull();
    act(() => renderer.unmount());
  });
});
