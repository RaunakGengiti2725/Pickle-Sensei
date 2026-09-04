/**
 * Minimized reproduction distilled from the seeded campaign in
 * `notificationSettingsScreen.boundaryI18nA11y.stress.test.tsx`
 * (seeds 22 / 131 → case A, seeds 111 / 194 → case B; deterministic 10/10).
 *
 * `useNotificationStore.hydrate()` wraps its kv READS and WRITES in one
 * `try { … } catch { prefs = DEFAULT }` (src/notifications/notificationStore.ts
 * hydrate). A kv WRITE failure after a successful read therefore:
 *
 *   A. discards prefs that were read and parsed fine when clearing a stale
 *      onboarding marker fails — the screen shows the default 5:30 PM
 *      instead of the persisted 7:30 AM (and `enabled` falls back to false,
 *      so `syncNow` cancels everything scheduled for this launch);
 *   B. silently drops the onboarding choice when persisting it fails, with
 *      `persistFailed` still false — no "couldn't save" alert row, unlike the
 *      `setPrefs` path which keeps the in-memory change and raises the flag.
 *
 * Same doubles as the campaign: in-memory kv with write-failure injection,
 * a SchedulerPort fake, real screen inside the real navigator.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type {
  PermissionState,
  SchedulerPort,
} from '../../src/notifications/service';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsKeyForOwner,
} from '../../src/notifications/types';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
  useNotificationStore,
} from '../../src/notifications/notificationStore';

const mockKv = new Map<string, string>();
let mockKvWriteFails = false;

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const value = mockKv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        if (mockKvWriteFails) throw new Error('SQLITE_FULL (injected)');
        mockKv.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

const mockScheduler: SchedulerPort & { cancelAllCalls: number } = {
  cancelAllCalls: 0,
  async permissionState(): Promise<PermissionState> {
    return 'granted';
  },
  async requestPermission(): Promise<PermissionState> {
    return 'granted';
  },
  async applyPlan(): Promise<void> {},
  async cancelAllPlanned(): Promise<void> {
    mockScheduler.cancelAllCalls += 1;
  },
  async openSystemSettings(): Promise<void> {},
};
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => mockScheduler,
}));
jest.mock('../../src/consistency/store', () => ({
  computeConsistencySnapshot: async () => ({
    currentStreak: 3,
    trainedToday: false,
    totalActivities: 12,
    shieldsAvailable: 0,
    nextStreakMilestone: null,
  }),
}));

import { NotificationSettingsScreen } from '../../src/screens/NotificationSettingsScreen';

const OWNER = '0f4c1a8e-6c2d-4b9a-8f1e-2d3c4b5a6978';
const Stack = createNativeStackNavigator<{
  Tabs: undefined;
  NotificationSettings: undefined;
}>();
const TabsStub = () => null;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
  });
}

async function mountScreen(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 47, bottom: 34, left: 0, right: 0 },
        }}
      >
        <NavigationContainer
          initialState={{
            routes: [{ name: 'Tabs' }, { name: 'NotificationSettings' }],
          }}
        >
          <Stack.Navigator>
            <Stack.Screen name="Tabs" component={TabsStub} />
            <Stack.Screen
              name="NotificationSettings"
              component={NotificationSettingsScreen}
            />
          </Stack.Navigator>
        </NavigationContainer>
      </SafeAreaProvider>,
    );
  });
  await flush();
  return renderer;
}

function renderedTexts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll(node => String(node.type) === 'Text')
    .map(node => {
      const children: unknown = node.props.children;
      const parts = Array.isArray(children) ? children.flat() : [children];
      return parts.filter((c): c is string => typeof c === 'string').join('');
    })
    .filter(Boolean);
}

beforeEach(() => {
  mockKv.clear();
  mockKvWriteFails = false;
  mockScheduler.cancelAllCalls = 0;
  setActiveDataOwner(OWNER);
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
  });
});

afterEach(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('NotificationSettingsScreen after a kv write failure during hydrate', () => {
  it('A: a failed stale-marker clear must not discard persisted prefs that were read fine (campaign seeds 22, 131)', async () => {
    mockKv.set(
      notificationPrefsKeyForOwner(OWNER),
      JSON.stringify({
        version: 1,
        enabled: true,
        practiceReminder: true,
        practiceReminderMinutes: 7 * 60 + 30,
        streakDefense: true,
        weeklyRecap: true,
        comeback: true,
        promptDismissed: true,
      }),
    );
    mockKv.set(
      PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
      JSON.stringify({ version: 1, enabled: true }),
    );
    mockKvWriteFails = true;

    await act(async () => {
      await useNotificationStore.getState().hydrate();
    });
    const renderer = await mountScreen();
    const texts = renderedTexts(renderer);
    const store = useNotificationStore.getState();

    try {
      expect(store.prefs.practiceReminderMinutes).toBe(7 * 60 + 30);
      expect(store.prefs.enabled).toBe(true);
      expect(texts).toContain('7:30 AM');
      expect(mockScheduler.cancelAllCalls).toBe(0);
    } finally {
      await act(async () => {
        renderer.unmount();
      });
    }
  });

  it('B: a failed onboarding-choice persist must surface persistFailed instead of silently showing defaults (campaign seeds 111, 194)', async () => {
    mockKv.set(
      PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
      JSON.stringify({ version: 1, enabled: true }),
    );
    mockKvWriteFails = true;

    await act(async () => {
      await useNotificationStore.getState().hydrate();
    });
    const renderer = await mountScreen();
    const store = useNotificationStore.getState();
    const alerts = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        node.props.accessibilityRole === 'alert',
    );

    try {
      // Either honour the choice in memory (as setPrefs does on a failed
      // write) or tell the player the save failed — never neither.
      expect(store.prefs.enabled || store.persistFailed).toBe(true);
      expect(alerts.length + (store.prefs.enabled ? 1 : 0)).toBeGreaterThan(0);
    } finally {
      await act(async () => {
        renderer.unmount();
      });
    }
  });
});
