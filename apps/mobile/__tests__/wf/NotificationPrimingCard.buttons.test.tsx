import React from 'react';
import { StyleSheet, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Button ledger for the Home notification priming card: every pressable it
 * renders ("Turn on", "Not now") is pressed here and its real effect is
 * asserted through the notification store, the owner-scoped kv, and the
 * SchedulerPort seam — granted / denied / rejected permission paths, the
 * one-way dismissal, visibility gating, and accessibility metadata.
 */

const mockKvTable = new Map<string, string>();
let mockKvWriteFailure: Error | null = null;
let mockKvWrites = 0;

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKvWrites += 1;
        if (mockKvWriteFailure) throw mockKvWriteFailure;
        mockKvTable.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

const mockScheduler = {
  permissionState: jest.fn<Promise<PermissionState>, []>(),
  requestPermission: jest.fn<Promise<PermissionState>, []>(),
  applyPlan: jest.fn<Promise<void>, [readonly PlannedNotification[]]>(),
  cancelAllPlanned: jest.fn<Promise<void>, []>(),
  openSystemSettings: jest.fn<Promise<void>, []>(),
};

jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => mockScheduler,
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

import type { PermissionState } from '../../src/notifications/service';
import type { PlannedNotification } from '../../src/notifications/types';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsKeyForOwner,
} from '../../src/notifications/types';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { NotificationPrimingCard } from '../../src/notifications/NotificationPrimingCard';
import { PressableScale } from '../../src/design/components';

const CARD_TEST_ID = 'notification-priming-card';
const TURN_ON_LABEL = 'Turn on practice reminders';
const NOT_NOW_LABEL = 'Not now';

type Renderer = TestRenderer.ReactTestRenderer;

function primedState(
  overrides: Partial<{
    hydrated: boolean;
    enabled: boolean;
    promptDismissed: boolean;
    permission: PermissionState | 'unknown';
  }> = {},
) {
  const {
    hydrated = true,
    enabled = false,
    promptDismissed = false,
    permission = 'undetermined',
  } = overrides;
  act(() => {
    useNotificationStore.setState({
      hydrated,
      ownerKey: GUEST_DATA_OWNER,
      prefs: { ...DEFAULT_NOTIFICATION_PREFS, enabled, promptDismissed },
      permission,
    });
  });
}

const mounted: Renderer[] = [];

function render(): Renderer {
  let renderer: Renderer | undefined;
  act(() => {
    renderer = TestRenderer.create(<NotificationPrimingCard />);
  });
  mounted.push(renderer!);
  return renderer!;
}

function card(renderer: Renderer) {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === CARD_TEST_ID,
  );
}

/** The RN Pressable each PressableScale renders — the node that actually
 * owns onPress/disabled/accessibilityState (not the wrapper composite). */
function pressables(renderer: Renderer) {
  return renderer.root.findAll(
    node =>
      node.type !== PressableScale &&
      typeof node.props.onPress === 'function' &&
      typeof node.props.accessibilityLabel === 'string',
  );
}

function pressable(renderer: Renderer, label: string) {
  const matches = pressables(renderer).filter(
    node => node.props.accessibilityLabel === label,
  );
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

async function press(renderer: Renderer, label: string) {
  const node = pressable(renderer, label);
  expect(node.props.disabled).toBeFalsy();
  await act(async () => {
    node.props.onPress();
    await Promise.resolve();
  });
}

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function storedPrefs() {
  const raw = mockKvTable.get(notificationPrefsKeyForOwner(GUEST_DATA_OWNER));
  return raw === undefined ? null : (JSON.parse(raw) as unknown);
}

beforeEach(() => {
  mockKvTable.clear();
  mockKvWriteFailure = null;
  mockKvWrites = 0;
  mockScheduler.permissionState.mockReset().mockResolvedValue('undetermined');
  mockScheduler.requestPermission.mockReset().mockResolvedValue('granted');
  mockScheduler.applyPlan.mockReset().mockResolvedValue(undefined);
  mockScheduler.cancelAllPlanned.mockReset().mockResolvedValue(undefined);
  mockScheduler.openSystemSettings.mockReset().mockResolvedValue(undefined);
  setActiveDataOwner(GUEST_DATA_OWNER);
  primedState();
});

afterEach(() => {
  act(() => {
    for (const renderer of mounted.splice(0)) renderer.unmount();
  });
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('NotificationPrimingCard visibility', () => {
  it('renders nothing before the store hydrates', () => {
    primedState({ hydrated: false });
    const renderer = render();
    expect(renderer.toJSON()).toBeNull();
    expect(pressables(renderer)).toHaveLength(0);
  });

  it('renders nothing once reminders are enabled', () => {
    primedState({ enabled: true });
    expect(render().toJSON()).toBeNull();
  });

  it('renders nothing once the prompt was dismissed', () => {
    primedState({ promptDismissed: true });
    expect(render().toJSON()).toBeNull();
  });

  it('renders nothing while the OS permission is denied', () => {
    primedState({ permission: 'denied' });
    expect(render().toJSON()).toBeNull();
  });

  it('shows the offer for hydrated, unanswered, non-denied state', () => {
    for (const permission of ['undetermined', 'unknown', 'granted'] as const) {
      primedState({ permission });
      const renderer = render();
      expect(card(renderer)).toHaveLength(1);
      expect(allText(renderer)).toContain('A nudge on practice days?');
      act(() => renderer.unmount());
      mounted.pop();
    }
  });
});

describe('NotificationPrimingCard button ledger', () => {
  it('exposes exactly two labelled buttons with hints', () => {
    const renderer = render();
    const buttons = pressables(renderer);
    expect(buttons.map(node => node.props.accessibilityLabel)).toEqual([
      TURN_ON_LABEL,
      NOT_NOW_LABEL,
    ]);
    for (const button of buttons) {
      expect(button.props.accessibilityRole).toBe('button');
      expect(typeof button.props.accessibilityHint).toBe('string');
      expect(button.props.disabled).toBeFalsy();
      expect(button.props.accessibilityState).toMatchObject({
        disabled: false,
      });
      expect(button.props.accessibilityState?.busy).toBeFalsy();
      const rawStyle: unknown =
        typeof button.props.style === 'function'
          ? button.props.style({ pressed: false })
          : button.props.style;
      const style = (StyleSheet.flatten(rawStyle as never) ?? {}) as Record<
        string,
        unknown
      >;
      expect(Number(style['minHeight'])).toBeGreaterThanOrEqual(44);
    }
    expect(allText(renderer)).toContain('Turn on');
    expect(allText(renderer)).toContain('Not now');
  });

  describe('"Turn on" -> requestPermissionAndEnable', () => {
    it('requests the OS permission and, when granted, enables + schedules + persists', async () => {
      const renderer = render();
      await press(renderer, TURN_ON_LABEL);

      expect(mockScheduler.requestPermission).toHaveBeenCalledTimes(1);
      const state = useNotificationStore.getState();
      expect(state.permission).toBe('granted');
      expect(state.prefs.enabled).toBe(true);
      expect(state.prefs.promptDismissed).toBe(true);
      expect(state.ownerKey).toBe(GUEST_DATA_OWNER);
      expect(storedPrefs()).toEqual(
        expect.objectContaining({
          version: 1,
          enabled: true,
          promptDismissed: true,
        }),
      );
      expect(mockScheduler.applyPlan).toHaveBeenCalledTimes(1);
      const plan = mockScheduler.applyPlan.mock.calls[0]![0];
      expect(plan.map(item => item.id)).toContain('ps.reminder.practice');
      // Answered: the card leaves the Home screen for good.
      expect(card(renderer)).toHaveLength(0);
      expect(renderer.toJSON()).toBeNull();
    });

    it('when the OS prompt is denied it stays off, schedules nothing, and stops asking', async () => {
      mockScheduler.requestPermission.mockResolvedValue('denied');
      const renderer = render();
      await press(renderer, TURN_ON_LABEL);

      const state = useNotificationStore.getState();
      expect(state.permission).toBe('denied');
      expect(state.prefs.enabled).toBe(false);
      expect(mockScheduler.applyPlan).not.toHaveBeenCalled();
      expect(storedPrefs()).toBeNull();
      // Denied hides the card (permission gate); reminders stay reachable
      // from Settings, where the recovery banner lives.
      expect(renderer.toJSON()).toBeNull();
    });

    it('keeps the choice this session even if the kv write fails', async () => {
      mockKvWriteFailure = new Error('disk full');
      const renderer = render();
      await expect(press(renderer, TURN_ON_LABEL)).resolves.toBeUndefined();

      const state = useNotificationStore.getState();
      expect(state.prefs.enabled).toBe(true);
      expect(state.prefs.promptDismissed).toBe(true);
      expect(mockScheduler.applyPlan).toHaveBeenCalledTimes(1);
      expect(renderer.toJSON()).toBeNull();
    });

    it('survives a scheduler failure after grant without throwing', async () => {
      mockScheduler.applyPlan.mockRejectedValue(new Error('notifee down'));
      const renderer = render();
      await expect(press(renderer, TURN_ON_LABEL)).resolves.toBeUndefined();

      expect(useNotificationStore.getState().prefs.enabled).toBe(true);
      expect(renderer.toJSON()).toBeNull();
    });

    it('when the permission request rejects it does not throw, keeps the card, and the button stays usable', async () => {
      mockScheduler.requestPermission.mockRejectedValueOnce(
        new Error('native module unavailable'),
      );
      const renderer = render();
      await expect(press(renderer, TURN_ON_LABEL)).resolves.toBeUndefined();

      const state = useNotificationStore.getState();
      expect(state.permission).toBe('unknown');
      expect(state.prefs.enabled).toBe(false);
      expect(state.prefs.promptDismissed).toBe(false);
      expect(mockScheduler.applyPlan).not.toHaveBeenCalled();
      expect(storedPrefs()).toBeNull();
      expect(card(renderer)).toHaveLength(1);
      // WF-ISSUE: "Turn on" gives no user-visible feedback when the
      // permission request fails — the card just stays; assertion that
      // failure copy is visible skipped.

      // The button is not left stuck: a second press retries the request.
      mockScheduler.requestPermission.mockResolvedValueOnce('granted');
      await press(renderer, TURN_ON_LABEL);
      expect(mockScheduler.requestPermission).toHaveBeenCalledTimes(2);
      expect(useNotificationStore.getState().prefs.enabled).toBe(true);
      expect(renderer.toJSON()).toBeNull();
    });

    it('does not throw when pressed in a signed-out process', async () => {
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      const renderer = render();
      await expect(press(renderer, TURN_ON_LABEL)).resolves.toBeUndefined();
      expect(useNotificationStore.getState().permission).toBe('granted');
      // setPrefs refuses to write without an owner: nothing is persisted or
      // scheduled for an account context that no longer exists.
      expect(storedPrefs()).toBeNull();
      expect(mockScheduler.applyPlan).not.toHaveBeenCalled();
    });
  });

  describe('"Not now" -> dismissPrompt', () => {
    it('dismisses forever without touching the OS permission prompt', async () => {
      const renderer = render();
      await press(renderer, NOT_NOW_LABEL);

      expect(mockScheduler.requestPermission).not.toHaveBeenCalled();
      const state = useNotificationStore.getState();
      expect(state.prefs.promptDismissed).toBe(true);
      expect(state.prefs.enabled).toBe(false);
      expect(state.permission).toBe('undetermined');
      expect(storedPrefs()).toEqual(
        expect.objectContaining({ enabled: false, promptDismissed: true }),
      );
      // Master switch still off: the sync pass cancels rather than plans.
      expect(mockScheduler.applyPlan).not.toHaveBeenCalled();
      expect(mockScheduler.cancelAllPlanned).toHaveBeenCalledTimes(1);
      expect(renderer.toJSON()).toBeNull();
    });

    it('is idempotent under a double tap (one persisted write)', async () => {
      const renderer = render();
      const node = pressable(renderer, NOT_NOW_LABEL);
      await act(async () => {
        node.props.onPress();
        node.props.onPress();
        await Promise.resolve();
      });
      expect(mockKvWrites).toBe(1);
      expect(mockScheduler.cancelAllPlanned).toHaveBeenCalledTimes(1);
      expect(useNotificationStore.getState().prefs.promptDismissed).toBe(true);
      expect(renderer.toJSON()).toBeNull();
    });

    it('honors the dismissal this session even if the kv write fails', async () => {
      mockKvWriteFailure = new Error('disk full');
      const renderer = render();
      await expect(press(renderer, NOT_NOW_LABEL)).resolves.toBeUndefined();
      expect(useNotificationStore.getState().prefs.promptDismissed).toBe(true);
      expect(renderer.toJSON()).toBeNull();
    });

    it('does not throw when pressed in a signed-out process', async () => {
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      const renderer = render();
      await expect(press(renderer, NOT_NOW_LABEL)).resolves.toBeUndefined();
      expect(storedPrefs()).toBeNull();
      expect(mockScheduler.requestPermission).not.toHaveBeenCalled();
    });
  });
});
