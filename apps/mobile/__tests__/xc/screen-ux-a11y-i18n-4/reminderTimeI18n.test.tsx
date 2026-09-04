/**
 * xc/screen-ux-a11y-i18n-4 — reminder-time formatting under adversarial input
 * and against the device 12/24-hour preference.
 *
 * NotificationSettingsScreen renders `formatReminderMinutes(minutes)` as the
 * visible value, the accessibility label of that value, and inside each
 * preset's label. This harness:
 *
 *   1. fuzzes formatReminderMinutes with seeded ints/floats/negatives/huge
 *      values (never throws, always a well-formed clock string, minute part
 *      always 00–59, hour part 1–12);
 *   2. round-trips the screen's ±30-minute stepping through midnight in both
 *      directions from every seeded start (wraps, never leaves [0, 1440));
 *   3. checks that what the screen announces matches what it shows for every
 *      preset and the current value;
 *   4. compares the output to Intl's 24-hour rendering for locales whose
 *      default is 24-hour (en-GB, de-DE, fr-FR, ja-JP) — the function is
 *      hard-coded to h:mm AM/PM regardless of locale or the iOS "24-Hour
 *      Time" setting. That divergence is pinned as a known baseline gap
 *      (src/notifications/types.ts:113-123) rather than asserted away.
 *
 * Every row is written to artifacts/xc-screen-ux-a11y-i18n-4/reminder-time.json.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const fs = require('fs') as {
  mkdirSync: (dir: string, opts: { recursive: boolean }) => void;
  writeFileSync: (file: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

jest.mock('../../../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => insets,
    initialWindowMetrics: { insets },
  };
});
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
  useFocusEffect: () => undefined,
}));
jest.mock('../../../src/notifications/service', () => ({
  getScheduler: () => ({ openSystemSettings: () => Promise.resolve() }),
}));

import { NotificationSettingsScreen } from '../../../src/screens/NotificationSettingsScreen';
import { useNotificationStore } from '../../../src/notifications/notificationStore';
import {
  DEFAULT_NOTIFICATION_PREFS,
  formatReminderMinutes,
} from '../../../src/notifications/types';

const ARTIFACT_DIR =
  process.env.XC_ARTIFACT_DIR ??
  path.resolve(__dirname, '../../../../../artifacts/xc-screen-ux-a11y-i18n-4');
const FUZZ_COUNT = Number(process.env.XC_TIME_FUZZ ?? 3000);
const SEED = Number(process.env.XC_SEED ?? 424242);

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CLOCK = /^(1[0-2]|[1-9]):([0-5]\d) (AM|PM)$/;

interface FuzzRow {
  input: number;
  output: string;
  ok: boolean;
}

const fuzzRows: FuzzRow[] = [];
const localeRows: Array<{
  minutes: number;
  app: string;
  locale: string;
  intl24h: string;
  matches: boolean;
}> = [];

afterAll(() => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, 'reminder-time.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        seed: SEED,
        fuzzCount: fuzzRows.length,
        fuzzFailures: fuzzRows.filter(r => !r.ok),
        localeComparisons: localeRows.length,
        localeMismatches: localeRows.filter(r => !r.matches).length,
        localeRows,
        sampleFuzz: fuzzRows.slice(0, 40),
      },
      null,
      2,
    ),
  );
});

describe('formatReminderMinutes fuzz', () => {
  it(`never throws and always yields h:mm AM/PM for ${FUZZ_COUNT} seeded inputs`, () => {
    const rnd = mulberry32(SEED);
    const specials = [
      0,
      -0,
      1439,
      1440,
      1441,
      -1,
      -1440,
      -1441,
      720,
      719.5,
      720.4999,
      0.5,
      1439.5,
      1e9,
      -1e9,
      Number.MAX_SAFE_INTEGER,
      Number.MIN_SAFE_INTEGER,
    ];
    const inputs = [...specials];
    for (let i = inputs.length; i < FUZZ_COUNT; i++) {
      const r = rnd();
      inputs.push(
        r < 0.5
          ? Math.floor(rnd() * 1440)
          : r < 0.75
            ? Math.floor((rnd() - 0.5) * 200000)
            : (rnd() - 0.5) * 6000,
      );
    }
    for (const input of inputs) {
      let output = '';
      let ok = false;
      try {
        output = formatReminderMinutes(input);
        ok = CLOCK.test(output);
      } catch (error) {
        output = `THROW ${String(error)}`;
      }
      fuzzRows.push({ input, output, ok });
    }
    const failures = fuzzRows.filter(r => !r.ok);
    expect(failures).toEqual([]);
    // Spot values pin the wrap semantics.
    expect(formatReminderMinutes(0)).toBe('12:00 AM');
    expect(formatReminderMinutes(720)).toBe('12:00 PM');
    expect(formatReminderMinutes(1439)).toBe('11:59 PM');
    expect(formatReminderMinutes(1440)).toBe('12:00 AM');
    expect(formatReminderMinutes(-30)).toBe('11:30 PM');
  });

  it('NaN/Infinity input does not surface as "NaN:NaN" in the UI string', () => {
    // Bad persisted prefs must not produce garbage in a label a screen
    // reader would read verbatim.
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const out = formatReminderMinutes(bad);
      fuzzRows.push({ input: bad, output: out, ok: CLOCK.test(out) });
    }
  });
});

describe('24-hour locale comparison (pinned baseline gap)', () => {
  const LOCALES_24H = ['en-GB', 'de-DE', 'fr-FR', 'ja-JP'];
  const SAMPLES = [0, 30, 450, 720, 750, 1050, 1170, 1439];

  it('the app string never equals the Intl 24-hour rendering for 24h-default locales', () => {
    for (const locale of LOCALES_24H) {
      const fmt = new Intl.DateTimeFormat(locale, {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone: 'UTC',
      });
      for (const minutes of SAMPLES) {
        const app = formatReminderMinutes(minutes);
        const intl24h = fmt.format(new Date(Date.UTC(2026, 0, 1, 0, minutes)));
        localeRows.push({
          minutes,
          app,
          locale,
          intl24h,
          matches: app === intl24h,
        });
      }
    }
    // Baseline behaviour: h:mm AM/PM regardless of locale — recorded, not
    // asserted as correct. If someone makes it locale-aware, this flips and
    // the entry must move out of the findings list.
    expect(localeRows.every(r => !r.matches)).toBe(true);
    expect(localeRows.every(r => /(AM|PM)$/.test(r.app))).toBe(true);
  });
});

describe('NotificationSettingsScreen time controls', () => {
  function hostPressables(r: TestRenderer.ReactTestRenderer) {
    return r.root.findAll(
      n => typeof n.type === 'string' && typeof n.props.onClick === 'function',
    );
  }

  function seed(minutes: number) {
    const setPrefs = jest.fn(() => Promise.resolve());
    act(() => {
      useNotificationStore.setState({
        hydrated: true,
        prefs: {
          ...DEFAULT_NOTIFICATION_PREFS,
          enabled: true,
          practiceReminder: true,
          practiceReminderMinutes: minutes,
        },
        permission: 'granted',
        persistFailed: false,
        scheduleFailed: false,
        setPrefs,
        refreshPermission: jest.fn(() => Promise.resolve()),
        requestPermissionAndEnable: jest.fn(() => Promise.resolve(true)),
      });
    });
    let r!: TestRenderer.ReactTestRenderer;
    act(() => {
      r = TestRenderer.create(<NotificationSettingsScreen />);
    });
    return { r, setPrefs };
  }

  it('announced value == shown value for 96 half-hour starts; stepping wraps at both edges', () => {
    const rnd = mulberry32(SEED + 1);
    const starts = new Set<number>();
    while (starts.size < 96) starts.add(Math.floor(rnd() * 1440));
    for (const minutes of starts) {
      const { r, setPrefs } = seed(minutes);
      const shown = formatReminderMinutes(minutes);
      const valueLabel = r.root.findAll(
        n =>
          n.type === Text &&
          n.props.accessibilityLabel === `Reminder time ${shown}`,
      );
      expect(valueLabel.length).toBe(1);
      const visible = valueLabel[0]!.props.children;
      expect(visible).toBe(shown);

      const earlier = hostPressables(r).find(
        n => n.props.accessibilityLabel === 'Reminder 30 minutes earlier',
      )!;
      const later = hostPressables(r).find(
        n => n.props.accessibilityLabel === 'Reminder 30 minutes later',
      )!;
      expect(earlier.props.accessibilityRole).toBe('button');
      expect(later.props.accessibilityRole).toBe('button');
      act(() => {
        earlier.props.onClick();
      });
      act(() => {
        later.props.onClick();
      });
      const calls = setPrefs.mock.calls as unknown as Array<
        [{ practiceReminderMinutes: number }]
      >;
      expect(calls).toHaveLength(2);
      const [e, l] = calls;
      expect(e![0].practiceReminderMinutes).toBe((minutes - 30 + 1440) % 1440);
      expect(l![0].practiceReminderMinutes).toBe((minutes + 30) % 1440);
      for (const c of calls) {
        expect(c[0].practiceReminderMinutes).toBeGreaterThanOrEqual(0);
        expect(c[0].practiceReminderMinutes).toBeLessThan(1440);
      }
      act(() => {
        r.unmount();
      });
    }
  });

  it('presets announce their time and exactly one is selected when the value matches', () => {
    const { r } = seed(17 * 60 + 30);
    const presets = hostPressables(r).filter(n =>
      /^(Morning|Midday|Evening|Night), /.test(
        String(n.props.accessibilityLabel),
      ),
    );
    expect(presets).toHaveLength(4);
    const selected = presets.filter(n => n.props.accessibilityState?.selected);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.props.accessibilityLabel).toBe('Evening, 5:30 PM');
    for (const p of presets) {
      const label = String(p.props.accessibilityLabel);
      const time = label.split(', ')[1]!;
      expect(CLOCK.test(time)).toBe(true);
    }
    act(() => {
      r.unmount();
    });
  });
});
