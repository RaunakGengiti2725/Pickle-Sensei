/**
 * STRESS — unit `cmp-consistency-ui`, lens `rapid-interaction`, owner-scope
 * edge of the one-shot "Day N secured" moment.
 *
 * `DaySecuredBanner` consumes `useConsistencyStore().daySecured` from an
 * effect on its first render, i.e. whenever the result surface happens to
 * mount — which can be AFTER the active data owner has already changed
 * (sign-out, or an account switch whose refresh has not landed yet). This
 * suite pins what the store does in those two races; both behaviours are
 * reported as findings, so the assertions below are deliberately written
 * against the CURRENT behaviour and must be updated together with any fix.
 *
 * Repro: npx jest --ci __tests__/stress/daySecuredOwnerScope
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
  parseConsistencyLedger,
  useConsistencyStore,
  type DaySecuredMoment,
} from '../../src/consistency/store';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import { useReducedMotion } from '../../src/design/components';

const OWNER_A = '11111111-1111-4111-8111-111111111111';
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

function mountBanner(): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<DaySecuredBanner />);
  });
  return renderer;
}

function banners(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.testID === 'day-secured-banner',
  );
}

describe('stress: day-secured consumption across an owner change', () => {
  it('drops the armed moment when the banner mounts after sign-out', async () => {
    setActiveDataOwner(OWNER_A);
    act(() => {
      useConsistencyStore.setState({ daySecured: MOMENT });
    });
    // The user signs out between the refresh that armed the moment and the
    // result surface mounting.
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);

    const renderer = mountBanner();
    await act(async () => {
      await Promise.resolve();
    });

    // FINDING: the moment is cleared from the store and NOT returned, so it
    // is neither shown nor left pending for the next signed-in refresh.
    expect(useConsistencyStore.getState().daySecured).toBeNull();
    expect(banners(renderer)).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it("writes owner A's consumed day into owner B's ledger on a fast switch", async () => {
    setActiveDataOwner(OWNER_A);
    act(() => {
      useConsistencyStore.setState({ daySecured: MOMENT });
    });
    // Account switch: the new owner's refresh has not landed yet, so the
    // moment armed for A is still in the store when B's surface mounts.
    setActiveDataOwner(OWNER_B);

    const renderer = mountBanner();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // FINDING: A's moment is shown to B and its consumption is persisted
    // under B's ledger key, burning B's own "Day N secured" for that day.
    expect(banners(renderer)).toHaveLength(1);
    expect(mockKv.get(consistencyKeyForOwner(OWNER_A))).toBeUndefined();
    expect(
      parseConsistencyLedger(
        mockKv.get(consistencyKeyForOwner(OWNER_B)) ?? null,
      ).daySecuredShownDay,
    ).toBe(MOMENT.day);
    act(() => renderer.unmount());
  });
});
