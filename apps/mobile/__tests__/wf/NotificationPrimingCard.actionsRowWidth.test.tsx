import React from 'react';
import { StyleSheet } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Reproduction (stress area components-3, seeds 1592590339 / 1592590341):
 * the priming card's "Turn on" / "Not now" row is a non-wrapping flex row of
 * two `flexGrow: 0` slots with `minWidth: 96` each. Its font-independent
 * minimum width (96 + gap 8 + 96 = 200pt) already exceeds the copy column on
 * a 320pt-wide screen (320 − 2·24 screen − 2·16 card − 40 icon − 16 gap −
 * hairline ≈ 183pt), and at accessibility Dynamic Type sizes the buttons run
 * past the card and the screen edge. This test is pure style arithmetic on
 * the rendered tree — it does not model iOS text measurement.
 */

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute() {
      return { rows: [] };
    },
    close() {},
  }),
}));

jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => ({
    permissionState: async () => 'undetermined',
    requestPermission: async () => 'granted',
    applyPlan: async () => undefined,
    cancelAllPlanned: async () => undefined,
    openSystemSettings: async () => undefined,
  }),
}));

jest.mock('../../src/consistency/store', () => ({
  computeConsistencySnapshot: async () => ({
    currentStreak: 2,
    trainedToday: false,
    totalActivities: 3,
    shieldsAvailable: 0,
    nextStreakMilestone: null,
  }),
}));

import { DEFAULT_NOTIFICATION_PREFS } from '../../src/notifications/types';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { GUEST_DATA_OWNER } from '../../src/data/accountScope';
import { NotificationPrimingCard } from '../../src/notifications/NotificationPrimingCard';
import { space } from '../../src/design/tokens';

const SMALLEST_SUPPORTED_WIDTH_PT = 320;
const HOME_SCREEN_MARGIN = space.lg;
const CARD_TEST_ID = 'notification-priming-card';

type Flat = Record<string, unknown>;

function flat(style: unknown): Flat {
  return (StyleSheet.flatten(style as never) ?? {}) as Flat;
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

let renderer: TestRenderer.ReactTestRenderer | undefined;

beforeEach(() => {
  act(() => {
    useNotificationStore.setState({
      hydrated: true,
      ownerKey: GUEST_DATA_OWNER,
      prefs: { ...DEFAULT_NOTIFICATION_PREFS },
      permission: 'undetermined',
    });
    renderer = TestRenderer.create(<NotificationPrimingCard />);
  });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

function isHostView(node: TestRenderer.ReactTestInstance): boolean {
  return typeof node.type === 'string' && String(node.type) === 'View';
}

function hostViews() {
  return renderer!.root.findAll(isHostView);
}

it('actions row fits the copy column at 320pt or is allowed to wrap', () => {
  const card = hostViews().find(n => n.props.testID === CARD_TEST_ID);
  expect(card).toBeDefined();
  const cardStyle = flat(card!.props.style);
  const iconWrap = hostViews()
    .map(n => flat(n.props.style))
    .find(s => s.width === 40 && s.height === 40);
  expect(iconWrap).toBeDefined();

  const copyColumn =
    SMALLEST_SUPPORTED_WIDTH_PT -
    2 * HOME_SCREEN_MARGIN -
    2 * num(cardStyle.padding) -
    2 * num(cardStyle.borderWidth) -
    num(iconWrap!.width) -
    num(cardStyle.gap);

  const actionsRow = hostViews()
    .map(n => ({ n, s: flat(n.props.style) }))
    .find(({ s }) => s.flexDirection === 'row' && s.marginTop === space.sm + 2);
  expect(actionsRow).toBeDefined();
  const rowStyle = actionsRow!.s;

  const slots = actionsRow!.n
    .findAll(n => isHostView(n) && flat(n.props.style).minWidth !== undefined)
    .map(n => flat(n.props.style));
  expect(slots).toHaveLength(2);

  const minRowWidth =
    slots.reduce((sum, s) => sum + num(s.minWidth), 0) +
    num(rowStyle.gap) * (slots.length - 1);
  const canShrinkOrWrap =
    rowStyle.flexWrap === 'wrap' ||
    slots.every(s => num(s.flexShrink) > 0 && num(s.minWidth) === 0);

  if (!canShrinkOrWrap) {
    // 96 + 8 + 96 = 200pt of non-shrinkable row vs ≈183pt of copy column.
    expect(minRowWidth).toBeLessThanOrEqual(copyColumn);
  }
});
