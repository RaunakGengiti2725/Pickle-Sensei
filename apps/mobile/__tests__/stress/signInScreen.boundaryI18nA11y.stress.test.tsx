/**
 * STRESS — SignInScreen × BOUNDARY / I18N / A11Y.
 *
 * Seeded, replayable campaign over the REAL SignInScreen rendered through
 * the real authStore (zustand), the real account bootstrap client and the
 * real device-context reader. Only the native seams are faked: SQLite kv,
 * the PickleAuth native module, the Google Sign-In SDK, safe-area metrics
 * and `fetch`. A slice of iterations mounts the real `App.tsx` Gate
 * (SafeAreaProvider → QueryClientProvider → RootErrorBoundary → Gate) and
 * walks Welcome → "I already have an account" → SignInScreen → error →
 * Dismiss → Back, so the screen is also exercised inside the providers the
 * shipping app uses.
 *
 * Every iteration derives ALL of its inputs from one 32-bit seed:
 *   - viewport width (320 / 375 / 430 + random phones) and Dynamic Type
 *     scale (1.0 / 1.235 xxLarge / 2.35 AX3 + the rest of the iOS ladder)
 *   - safe-area insets incl. zero / negative / huge
 *   - locale (12) × timezone (8, UTC±14 and DST edges) fed to the REAL
 *     `Intl.DateTimeFormat().resolvedOptions()` reader
 *   - how the error reaches the screen (native Apple rejection, server 4xx/5xx
 *     `error.message`, Google cancel, missing native module, direct store
 *     state with null/undefined/empty message, pending sign-in = busy)
 *   - the error message itself: 200–2600 char Latin, CJK, Arabic RTL,
 *     Hebrew, ZWJ emoji, combining-mark storms, German compounds, Thai,
 *     Devanagari, bidi controls, control chars, zero / negative / huge
 *     numerics, whitespace-only, empty.
 *
 * Two kinds of checks run per variant:
 *   HARD (always asserted): render is crash- and warning-free; every
 *     interactive element has role + label; static target sizes ≥ 44pt;
 *     error card semantics (present iff error && code !== canceled, hint ===
 *     message, message text rendered verbatim); busy disables providers;
 *     Dismiss clears and Back navigates; the bootstrap request body carries
 *     the exact locale/timezone.
 *   LAYOUT MODEL (recorded; asserted only with STRESS_STRICT_LAYOUT=1): a
 *     small flexbox + text-wrap estimator walks the rendered host tree with
 *     the variant's width and font scale and reports clipped / overflowing /
 *     overlapping nodes. Yoga and CoreText do not run under jest, so these
 *     are INFERRED, not device truth — they are evidence to be confirmed on
 *     the Mac plane, and are emitted with rects into the JSON table.
 *
 * Knobs:
 *   STRESS_ITER=<n>          iterations (default 40; campaign ≥ 150)
 *   STRESS_SEED=<n>          master seed (default 20260904)
 *   STRESS_REPLAY=<s1,s2>    run exactly these iteration seeds
 *   STRESS_OUT=<path>        write the seed → outcome JSON table here
 *   STRESS_TREES=<dir>       dump a compact rendered tree per seed into <dir>
 *   STRESS_STRICT_LAYOUT=1   also fail on layout-model clipping/overlap
 *
 * Replay one seed:
 *   cd apps/mobile && STRESS_REPLAY=123456 npx jest --ci \
 *     __tests__/stress/signInScreen.boundaryI18nA11y.stress.test.tsx
 */
import React from 'react';
import {
  AccessibilityInfo,
  NativeModules,
  StyleSheet,
  Text,
} from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import * as fs from 'fs';
import * as path from 'path';

// ─── Native seams ────────────────────────────────────────────────────────────

const mockMetrics = {
  frame: { x: 0, y: 0, width: 375, height: 667 },
  insets: { top: 0, bottom: 0, left: 0, right: 0 },
};
jest.mock('react-native-safe-area-context', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const Passthrough = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return {
    SafeAreaProvider: Passthrough,
    SafeAreaView: Passthrough,
    useSafeAreaInsets: () => mockMetrics.insets,
    get initialWindowMetrics() {
      return mockMetrics;
    },
  };
});

const mockKv = new Map<string, string>();
jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      if (statement.startsWith('SELECT value FROM kv')) {
        const value = mockKv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKv.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));

jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
    googleWebClientId: 'test-web-client.apps.googleusercontent.com',
    appVersion: '1.0',
    legalPrivacyUrl: 'https://api.example.test/privacy',
    legalTermsUrl: 'https://api.example.test/terms',
    appStoreId: null,
    appStoreWriteReviewUrl: null,
  }),
}));

const mockGoogleSignin = {
  configure: jest.fn(),
  hasPlayServices: jest.fn(),
  signIn: jest.fn(),
  signInSilently: jest.fn(),
  hasPreviousSignIn: jest.fn(),
  signOut: jest.fn(),
  revokeAccess: jest.fn(),
};
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: mockGoogleSignin,
}));

// App-mode leaves outside this unit (the real Gate imports them).
jest.mock('../../src/navigation/RootNavigator', () => {
  const ReactModule = require('react');
  const { Text: RNText } = require('react-native');
  return {
    RootNavigator: () =>
      ReactModule.createElement(RNText, null, 'ROOT_NAVIGATOR'),
  };
});
jest.mock('../../src/screens/SplashScreen', () => {
  const ReactModule = require('react');
  return {
    SplashScreen: (props: { ready: boolean; onFinished: () => void }) => {
      ReactModule.useEffect(() => {
        if (props.ready) props.onFinished();
      }, [props.ready, props.onFinished]);
      return null;
    },
  };
});
jest.mock('../../src/components/RankUpCelebration', () => ({
  RankUpCelebration: () => null,
}));
jest.mock('../../src/consistency/StreakCelebration', () => ({
  StreakCelebration: () => null,
}));
jest.mock('../../src/walkthrough/FirstRunWalkthrough', () => ({
  FirstRunWalkthrough: () => null,
}));
jest.mock('../../src/walkthrough/walkthroughStore', () => {
  const state = { maybeShowFirstRun: async () => {} };
  return {
    useWalkthroughStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});
jest.mock('../../src/consistency/useConsistencyBootstrap', () => ({
  useConsistencyBootstrap: () => {},
}));
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => ({
    async permissionState() {
      return 'undetermined';
    },
    async requestPermission() {
      return 'denied';
    },
    async applyPlan() {},
    async cancelAllPlanned() {},
    async openSystemSettings() {},
  }),
}));

import App from '../../App';
import { SignInScreen } from '../../src/screens/SignInScreen';
import { useAuthStore } from '../../src/auth/authStore';
import { clearApiSession } from '../../src/account/apiSession';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';

type Renderer = TestRenderer.ReactTestRenderer;
type Json = ReturnType<Renderer['toJSON']>;
type HostNode = Exclude<Json, null | Array<unknown>>;

// ─── Seeded RNG ──────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(min: number, maxInclusive: number): number {
    return min + Math.floor(this.next() * (maxInclusive - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    return at(items, this.int(0, items.length - 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`index ${index} out of range`);
  return item;
}

// ─── Corpus ──────────────────────────────────────────────────────────────────

const LOCALES = [
  'de-DE',
  'fr-FR',
  'ar-EG',
  'hi-IN',
  'ja-JP',
  'pt-BR',
  'tr-TR',
  'ru-RU',
  'th-TH',
  'zh-CN',
  'en-IN',
  'es-419',
] as const;

// UTC+14 (Kiritimati), UTC-12 (Etc/GMT+12), the two US DST edges, the EU
// edge, a half-hour zone, a 45-minute zone and UTC.
const TIMEZONES = [
  'Pacific/Kiritimati',
  'Etc/GMT+12',
  'America/New_York',
  'America/Los_Angeles',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'UTC',
] as const;

// Instants sitting on DST transitions (US spring-forward 2026-03-08 07:00Z,
// US fall-back 2026-11-01 06:00Z, EU 2026-03-29 01:00Z / 2026-10-25 01:00Z).
const DST_EDGE_INSTANTS = [
  Date.UTC(2026, 2, 8, 6, 59, 59),
  Date.UTC(2026, 2, 8, 7, 0, 0),
  Date.UTC(2026, 10, 1, 5, 59, 59),
  Date.UTC(2026, 10, 1, 6, 0, 0),
  Date.UTC(2026, 2, 29, 0, 59, 59),
  Date.UTC(2026, 9, 25, 1, 0, 0),
  Date.UTC(2026, 0, 1, 0, 0, 0),
  Date.UTC(2038, 0, 19, 3, 14, 7),
] as const;

const WIDTHS_GRID = [320, 375, 430] as const;
const WIDTHS_EXTRA = [360, 390, 393, 402, 414, 440] as const;
// iOS Dynamic Type multipliers relative to Large (RN reports these).
const FONT_SCALES_GRID = [1, 1.235, 2.35] as const; // Large, xxLarge, AX3
const FONT_SCALES_EXTRA = [
  0.823, 0.882, 0.941, 1.118, 1.353, 1.647, 1.941, 2.765, 3.118,
] as const;

const LATIN_WORDS =
  'the account server could not verify this identity provider token please try again later membership coaching ratings synced progress connected verified secure'.split(
    ' ',
  );
const GERMAN_COMPOUNDS = [
  'Donaudampfschifffahrtsgesellschaftskapitänsmützenherstellerverband',
  'Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz',
  'Kraftfahrzeughaftpflichtversicherungsbeitragsrückerstattung',
  'Grundstücksverkehrsgenehmigungszuständigkeitsübertragungsverordnung',
];
const ZWJ_EMOJI = ['👨‍👩‍👧‍👦', '🏳️‍🌈', '👩🏽‍💻', '🧑‍🤝‍🧑', '👨‍🦯', '🐕‍🦺', '❤️‍🔥', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '👩‍❤️‍💋‍👨'];
const NUMERIC_EDGE = [
  '0',
  '-0',
  '-1',
  '00000000000000000000',
  '-9007199254740993',
  '9007199254740993',
  '1e308',
  '-1e-324',
  '∞',
  '-∞',
  'NaN',
  '٠١٢٣٤٥٦٧٨٩',
  '१२३४५६७८९०',
];
const WHITESPACE_EDGE = [
  ' ',
  '\n',
  '\n\n\n\n',
  '\t\t',
  '\u200B',
  '\u00A0'.repeat(50),
  '\u3000\u3000',
  ' '.repeat(300),
];
const CONTROL_EDGE = [
  '\u0000',
  '\u0007bell',
  '\uFEFFbom',
  'line\u2028sep\u2029para',
  'a\u0008b',
];

type MessageClass =
  | 'latin-long'
  | 'cjk'
  | 'arabic-rtl'
  | 'hebrew-rtl'
  | 'zwj-emoji'
  | 'combining-marks'
  | 'german-compound'
  | 'thai'
  | 'devanagari'
  | 'bidi-controls'
  | 'control-chars'
  | 'numeric-edge'
  | 'whitespace-only'
  | 'empty'
  | 'mixed-script'
  | 'short-plain';

const MESSAGE_CLASSES: readonly MessageClass[] = [
  'latin-long',
  'cjk',
  'arabic-rtl',
  'hebrew-rtl',
  'zwj-emoji',
  'combining-marks',
  'german-compound',
  'thai',
  'devanagari',
  'bidi-controls',
  'control-chars',
  'numeric-edge',
  'whitespace-only',
  'empty',
  'mixed-script',
  'short-plain',
];

function fill(rng: Rng, minLen: number, maxLen: number, unit: () => string) {
  const target = rng.int(minLen, maxLen);
  let out = '';
  while (out.length < target) out += unit();
  return out;
}

function makeMessage(rng: Rng, cls: MessageClass): string {
  switch (cls) {
    case 'latin-long':
      return fill(rng, 200, 2600, () => `${rng.pick(LATIN_WORDS)} `).trimEnd();
    case 'cjk':
      return fill(rng, 200, 900, () => {
        const r = rng.float();
        if (r < 0.7) return String.fromCharCode(rng.int(0x4e00, 0x9fff));
        if (r < 0.85) return String.fromCharCode(rng.int(0x3041, 0x3096));
        if (r < 0.95) return String.fromCharCode(rng.int(0xac00, 0xd7a3));
        return rng.pick(['。', '、', '！', '「', '」']);
      });
    case 'arabic-rtl':
      return (
        '\u200F' +
        fill(rng, 200, 800, () =>
          rng.chance(0.18) ? ' ' : String.fromCharCode(rng.int(0x0621, 0x064a)),
        ) +
        ' ٤٢'
      );
    case 'hebrew-rtl':
      return fill(rng, 200, 600, () =>
        rng.chance(0.2) ? ' ' : String.fromCharCode(rng.int(0x05d0, 0x05ea)),
      );
    case 'zwj-emoji':
      return fill(rng, 200, 700, () => rng.pick(ZWJ_EMOJI));
    case 'combining-marks':
      return fill(rng, 200, 900, () => {
        let s = String.fromCharCode(rng.int(0x61, 0x7a));
        const marks = rng.int(1, 8);
        for (let i = 0; i < marks; i += 1)
          s += String.fromCharCode(rng.int(0x0300, 0x036f));
        return rng.chance(0.15) ? `${s} ` : s;
      });
    case 'german-compound':
      return fill(rng, 200, 700, () => rng.pick(GERMAN_COMPOUNDS));
    case 'thai':
      return fill(rng, 200, 700, () => {
        const base = String.fromCharCode(rng.int(0x0e01, 0x0e2e));
        return rng.chance(0.4)
          ? base + String.fromCharCode(rng.int(0x0e31, 0x0e3a))
          : base;
      });
    case 'devanagari':
      return fill(rng, 200, 700, () => {
        const base = String.fromCharCode(rng.int(0x0905, 0x0939));
        const matra = rng.chance(0.5)
          ? String.fromCharCode(rng.int(0x093e, 0x094c))
          : '';
        return rng.chance(0.2) ? `${base}${matra} ` : base + matra;
      });
    case 'bidi-controls':
      return rng.pick([
        '\u202EServer said: token rejected\u202C — please retry',
        '\u2067مرفوض\u2069 token rejected \u2066LTR\u2069',
        'Sign-in \u200Ffailed\u200E for account ' + 'x'.repeat(210),
        '\u061C' + 'شكرا '.repeat(60),
      ]);
    case 'control-chars':
      return rng.pick(CONTROL_EDGE) + ' ' + fill(rng, 200, 300, () => 'x');
    case 'numeric-edge':
      return rng.chance(0.3)
        ? '9'.repeat(rng.int(200, 400))
        : rng.pick(NUMERIC_EDGE);
    case 'whitespace-only':
      return rng.pick(WHITESPACE_EDGE);
    case 'empty':
      return '';
    case 'mixed-script':
      return [
        makeMessage(rng, 'short-plain'),
        rng.pick(ZWJ_EMOJI),
        String.fromCharCode(rng.int(0x4e00, 0x9fff)).repeat(12),
        '\u200F' + String.fromCharCode(rng.int(0x0621, 0x064a)).repeat(12),
        rng.pick(GERMAN_COMPOUNDS),
        rng.pick(NUMERIC_EDGE),
      ].join(' ');
    case 'short-plain':
      return rng.pick([
        'The account server could not verify this identity provider token.',
        'Secure account setup is temporarily unavailable.',
        'Sign-in failed.',
        'Try again.',
      ]);
  }
}

// ─── Variant ─────────────────────────────────────────────────────────────────

type ErrorSeam =
  | 'none'
  | 'busy-pending'
  | 'apple-native-reject'
  | 'apple-native-error'
  | 'apple-native-cancel'
  | 'apple-module-missing'
  | 'apple-server-4xx'
  | 'apple-server-5xx'
  | 'google-server-4xx'
  | 'google-server-5xx'
  | 'google-cancel'
  | 'google-no-idtoken'
  | 'server-unreadable-json'
  | 'server-nonstring-message'
  | 'store-direct-null-message'
  | 'store-direct-undefined-message'
  | 'store-direct-unknown-code';

const ERROR_SEAMS: readonly ErrorSeam[] = [
  'none',
  'busy-pending',
  'apple-native-reject',
  'apple-native-error',
  'apple-native-cancel',
  'apple-module-missing',
  'apple-server-4xx',
  'apple-server-5xx',
  'google-server-4xx',
  'google-server-5xx',
  'google-cancel',
  'google-no-idtoken',
  'server-unreadable-json',
  'server-nonstring-message',
  'store-direct-null-message',
  'store-direct-undefined-message',
  'store-direct-unknown-code',
];

interface Variant {
  seed: number;
  mode: 'screen' | 'app';
  width: number;
  height: number;
  fontScale: number;
  insets: { top: number; bottom: number; left: number; right: number };
  locale: (typeof LOCALES)[number];
  timezone: (typeof TIMEZONES)[number];
  nowMs: number;
  seam: ErrorSeam;
  messageClass: MessageClass;
  message: string;
  httpStatus: number;
}

function heightFor(width: number): number {
  if (width <= 320) return 568;
  if (width <= 360) return 780;
  if (width <= 375) return 667;
  if (width <= 393) return 852;
  if (width <= 414) return 896;
  return 932;
}

function deriveVariant(seed: number, index: number, gridSize: number): Variant {
  const rng = new Rng(seed);
  // The first `gridSize` iterations walk the 3 widths × 3 scales × 17 seams
  // grid deterministically (so the must-cover cells always run); later
  // iterations sample freely, including the extra phones and scale ladder.
  const onGrid = index < gridSize;
  const width = onGrid
    ? at(WIDTHS_GRID, index % 3)
    : rng.chance(0.6)
      ? rng.pick(WIDTHS_GRID)
      : rng.pick(WIDTHS_EXTRA);
  const fontScale = onGrid
    ? at(FONT_SCALES_GRID, Math.floor(index / 3) % 3)
    : rng.chance(0.6)
      ? rng.pick(FONT_SCALES_GRID)
      : rng.pick(FONT_SCALES_EXTRA);
  const seam = onGrid
    ? at(ERROR_SEAMS, Math.floor(index / 9) % ERROR_SEAMS.length)
    : rng.pick(ERROR_SEAMS);
  const insetTop = rng.pick([0, 20, 44, 47, 50, 59, 62, -10, 400]);
  const insetBottom = rng.pick([0, 0, 21, 34, -5, 300]);
  const messageClass = rng.pick(MESSAGE_CLASSES);
  return {
    seed,
    mode: index % 5 === 4 ? 'app' : 'screen',
    width,
    height: heightFor(width),
    fontScale,
    insets: { top: insetTop, bottom: insetBottom, left: 0, right: 0 },
    locale: rng.pick(LOCALES),
    timezone: rng.pick(TIMEZONES),
    nowMs: rng.pick(DST_EDGE_INSTANTS),
    seam,
    messageClass,
    message: makeMessage(rng, messageClass),
    httpStatus: seam.endsWith('4xx')
      ? rng.pick([400, 401, 403, 404, 422, 429])
      : rng.pick([500, 502, 503, 504]),
  };
}

// ─── Mini layout model (INFERRED — Yoga/CoreText do not run under jest) ─────

interface Style {
  [key: string]: unknown;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function styleOf(node: HostNode): Style {
  const flat = StyleSheet.flatten(
    (node.props as { style?: unknown }).style as never,
  ) as Style | undefined;
  return flat ?? {};
}

function edges(
  s: Style,
  kind: 'margin' | 'padding',
): { top: number; right: number; bottom: number; left: number } {
  const all = num(s[kind]);
  const h = num(s[`${kind}Horizontal`], all);
  const v = num(s[`${kind}Vertical`], all);
  return {
    top: num(s[`${kind}Top`], v),
    right: num(s[`${kind}Right`], h),
    bottom: num(s[`${kind}Bottom`], v),
    left: num(s[`${kind}Left`], h),
  };
}

function borders(s: Style) {
  const all = num(s.borderWidth);
  return {
    top: num(s.borderTopWidth, all),
    right: num(s.borderRightWidth, all),
    bottom: num(s.borderBottomWidth, all),
    left: num(s.borderLeftWidth, all),
  };
}

// Approximate advance widths in em for a humanist sans (Manrope-like) at
// semibold; script buckets for the rest. Accuracy is ±10% — good enough to
// separate "fits" from "overflows by a third", not to call a 2px case.
function advance(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp === 0x200d || cp === 0xfe0f || (cp >= 0xe0020 && cp <= 0xe007f))
    return 0; // ZWJ, VS16, tag sequences
  if (cp >= 0x0300 && cp <= 0x036f) return 0; // combining marks
  if (cp >= 0x200b && cp <= 0x200f) return 0; // ZW space/joiners/marks
  if (cp >= 0x202a && cp <= 0x202e) return 0; // bidi embeddings
  if (cp >= 0x2066 && cp <= 0x2069) return 0; // bidi isolates
  if (cp === 0x061c || cp === 0xfeff) return 0;
  if (cp < 0x20) return 0;
  if (ch === ' ' || cp === 0xa0) return 0.26;
  if (cp === 0x3000) return 1;
  if ("iljI.,:;|!'".includes(ch)) return 0.28;
  if ('frt-'.includes(ch)) return 0.36;
  if ('mwMW'.includes(ch)) return 0.9;
  if (ch >= 'A' && ch <= 'Z') return 0.66;
  if (ch >= 'a' && ch <= 'z') return 0.55;
  if (ch >= '0' && ch <= '9') return 0.58;
  if (cp >= 0x0590 && cp <= 0x05ff) return 0.5; // Hebrew
  if (cp >= 0x0600 && cp <= 0x06ff) return 0.5; // Arabic (avg shaped)
  if (cp >= 0x0900 && cp <= 0x097f)
    return cp >= 0x093e && cp <= 0x094c ? 0.25 : 0.62;
  if (cp >= 0x0e00 && cp <= 0x0e7f)
    return cp >= 0x0e31 && cp <= 0x0e3a ? 0 : 0.6;
  if (cp >= 0x1100 && cp <= 0x11ff) return 1;
  if (cp >= 0x3000 && cp <= 0x9fff) return 1; // CJK, kana, punctuation
  if (cp >= 0xac00 && cp <= 0xd7af) return 1; // Hangul
  if (cp >= 0x1f000) return 1.25; // emoji
  if (cp >= 0x2000 && cp <= 0x2bff) return 0.8; // symbols, arrows, ∞
  if (cp === 0xf8ff) return 0.85; // Apple logo (private use)
  return 0.6;
}

function isBreakOpportunityAfter(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (
    ch === ' ' ||
    ch === '\t' ||
    cp === 0x200b ||
    cp === 0x3000 ||
    (cp >= 0x3000 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0x0e00 && cp <= 0x0e7f) ||
    cp >= 0x1f000
  );
}

interface TextMeasure {
  lines: number;
  widestLine: number;
  hardBreaks: number;
}

/** Greedy word wrap with character fallback for words wider than a line
 * (UIKit breaks mid-word once a single word exceeds the line). */
function measureText(
  text: string,
  fontSize: number,
  letterSpacing: number,
  maxWidth: number,
): TextMeasure {
  const paragraphs = text.split(/\r\n|\r|\n|\u2028|\u2029/);
  let lines = 0;
  let widest = 0;
  for (const para of paragraphs) {
    const chars = Array.from(para);
    if (chars.length === 0) {
      lines += 1;
      continue;
    }
    // Split into unbreakable runs (each run = list of cluster advances).
    const runs: number[][] = [];
    let run: number[] = [];
    for (const ch of chars) {
      const adv =
        advance(ch) * fontSize + (advance(ch) > 0 ? letterSpacing : 0);
      // Zero-width marks join the preceding cluster.
      if (!(adv === 0 && run.length > 0)) run.push(adv);
      if (isBreakOpportunityAfter(ch)) {
        runs.push(run);
        run = [];
      }
    }
    if (run.length > 0) runs.push(run);
    let lineW = 0;
    let lineCount = 1;
    for (const clusters of runs) {
      const w = clusters.reduce((a, b) => a + b, 0);
      if (w > maxWidth) {
        // Character-wrap the long run; a single cluster never splits (it
        // overflows instead, as UIKit renders it).
        if (lineW > 0) {
          widest = Math.max(widest, lineW);
          lineCount += 1;
          lineW = 0;
        }
        for (const c of clusters) {
          if (lineW > 0 && lineW + c > maxWidth + 0.01) {
            widest = Math.max(widest, lineW);
            lineCount += 1;
            lineW = 0;
          }
          lineW += c;
        }
        widest = Math.max(widest, lineW);
        continue;
      }
      if (lineW + w > maxWidth + 0.01) {
        widest = Math.max(widest, lineW);
        lineCount += 1;
        lineW = w;
      } else {
        lineW += w;
      }
    }
    widest = Math.max(widest, lineW);
    lines += lineCount;
  }
  return { lines, widestLine: widest, hardBreaks: paragraphs.length - 1 };
}

interface Box {
  type: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Content box relative to the outer box. */
  pad: { top: number; right: number; bottom: number; left: number };
  overflowHidden: boolean;
  text?: { value: string; lines: number; fontSize: number; lineHeight: number };
  children: Box[];
  node: HostNode;
}

interface LayoutIssue {
  kind:
    | 'clipped-horizontal'
    | 'overflow-horizontal'
    | 'clipped-vertical'
    | 'overflow-vertical'
    | 'overlap';
  /** Nearest clipping ancestor (overflow hidden / scroll / screen edge). */
  clipper?: string;
  node: string;
  text?: string;
  byPx: number;
  parent: string;
  parentContentWidth?: number;
  rect: { x: number; y: number; w: number; h: number };
}

function textOf(node: HostNode | string): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  const kids = node.children ?? [];
  return kids.map(k => textOf(k as HostNode | string)).join('');
}

function describe_(node: HostNode): string {
  const p = node.props as Record<string, unknown>;
  const bits = [node.type];
  if (typeof p.testID === 'string') bits.push(`#${p.testID}`);
  if (typeof p.accessibilityLabel === 'string')
    bits.push(`[label="${p.accessibilityLabel.slice(0, 40)}"]`);
  return bits.join('');
}

class LayoutModel {
  readonly issues: LayoutIssue[] = [];
  constructor(readonly fontScale: number) {}

  private textProps(node: HostNode, s: Style) {
    const p = node.props as {
      allowFontScaling?: boolean;
      maxFontSizeMultiplier?: number;
      numberOfLines?: number;
    };
    const cap =
      p.allowFontScaling === false
        ? 1
        : typeof p.maxFontSizeMultiplier === 'number' &&
            p.maxFontSizeMultiplier > 0
          ? Math.min(this.fontScale, p.maxFontSizeMultiplier)
          : this.fontScale;
    const fontSize = num(s.fontSize, 14) * cap;
    const lineHeight =
      typeof s.lineHeight === 'number'
        ? s.lineHeight * cap
        : Math.ceil(fontSize * 1.2);
    return {
      fontSize,
      lineHeight,
      letterSpacing: num(s.letterSpacing),
      numberOfLines: p.numberOfLines,
    };
  }

  /**
   * Lay out `node` given the width the parent offers for the OUTER box
   * (margins included). `stretch` means a column parent stretches the
   * child to that width when it has none of its own.
   */
  layout(node: HostNode | string, offered: number, stretch: boolean): Box {
    if (typeof node === 'string' || typeof node === 'number') {
      const value = String(node);
      return {
        type: '#text',
        label: JSON.stringify(value.slice(0, 30)),
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        pad: { top: 0, right: 0, bottom: 0, left: 0 },
        overflowHidden: false,
        children: [],
        node: { type: '#text', props: {}, children: [value] } as HostNode,
      };
    }
    const s = styleOf(node);
    const m = edges(s, 'margin');
    const pd = edges(s, 'padding');
    const b = borders(s);
    const pad = {
      top: pd.top + b.top,
      right: pd.right + b.right,
      bottom: pd.bottom + b.bottom,
      left: pd.left + b.left,
    };
    const props = node.props as Record<string, unknown>;
    const explicitW =
      typeof s.width === 'number'
        ? s.width
        : node.type === 'RNSVGSvgView' && typeof props.width === 'number'
          ? props.width
          : undefined;
    const explicitH =
      typeof s.height === 'number'
        ? s.height
        : node.type === 'RNSVGSvgView' && typeof props.height === 'number'
          ? props.height
          : undefined;
    const maxW = typeof s.maxWidth === 'number' ? s.maxWidth : Infinity;
    const minH = num(s.minHeight);
    const availableOuter = Math.max(0, offered - m.left - m.right);

    const box: Box = {
      type: node.type,
      label: describe_(node),
      x: m.left,
      y: m.top,
      w: 0,
      h: 0,
      pad,
      overflowHidden:
        s.overflow === 'hidden' ||
        s.overflow === 'scroll' ||
        node.type === 'RCTScrollView',
      children: [],
      node,
    };

    if (s.display === 'none') return box;

    if (node.type === 'Text') {
      const tp = this.textProps(node, s);
      const value = textOf(node);
      const outerW = explicitW ?? Math.min(availableOuter, maxW);
      const innerW = Math.max(0, outerW - pad.left - pad.right);
      const measure = measureText(value, tp.fontSize, tp.letterSpacing, innerW);
      const lines =
        typeof tp.numberOfLines === 'number' && tp.numberOfLines > 0
          ? Math.min(measure.lines, tp.numberOfLines)
          : measure.lines;
      const shrinkToFit =
        explicitW === undefined && (!stretch || s.alignSelf !== undefined);
      box.w = shrinkToFit
        ? Math.min(outerW, measure.widestLine + pad.left + pad.right)
        : outerW;
      box.h =
        explicitH ??
        Math.max(minH, lines * tp.lineHeight + pad.top + pad.bottom);
      box.text = {
        value,
        lines,
        fontSize: tp.fontSize,
        lineHeight: tp.lineHeight,
      };
      return box;
    }

    const kids = (node.children ?? []).filter(
      (k): k is HostNode | string => k !== null && typeof k !== 'undefined',
    );
    const row = s.flexDirection === 'row' || s.flexDirection === 'row-reverse';
    const gap = num(s.gap, num(row ? s.columnGap : s.rowGap));
    const outerW =
      explicitW ??
      (stretch && s.alignSelf !== 'flex-start' && s.alignSelf !== 'center'
        ? Math.min(availableOuter, maxW)
        : undefined);
    const innerAvail = Math.max(
      0,
      (outerW ?? Math.min(availableOuter, maxW)) - pad.left - pad.right,
    );
    const alignItems = (s.alignItems as string | undefined) ?? 'stretch';

    if (!row) {
      let y = pad.top;
      let contentW = 0;
      const flowKids: Box[] = [];
      for (const kid of kids) {
        const ks = typeof kid === 'string' ? {} : styleOf(kid);
        const absolute = ks.position === 'absolute';
        const child = this.layout(kid, innerAvail, alignItems === 'stretch');
        if (absolute) {
          child.x += pad.left;
          child.y += pad.top;
          box.children.push(child);
          continue;
        }
        const km =
          typeof kid === 'string' ? edges({}, 'margin') : edges(ks, 'margin');
        if (alignItems === 'center')
          child.x = pad.left + Math.max(0, (innerAvail - child.w) / 2);
        else if (alignItems === 'flex-end')
          child.x = pad.left + innerAvail - child.w - km.right;
        else child.x = pad.left + km.left;
        child.y = y + km.top;
        y = child.y + child.h + km.bottom;
        flowKids.push(child);
        box.children.push(child);
        contentW = Math.max(contentW, child.w + km.left + km.right);
      }
      if (flowKids.length > 1) {
        // apply gaps
        let shift = 0;
        for (const kid of flowKids.slice(1)) {
          shift += gap;
          kid.y += shift;
        }
        y += shift;
      }
      box.w = outerW ?? Math.min(contentW + pad.left + pad.right, maxW);
      box.h = explicitH ?? Math.max(minH, y + pad.bottom);
      this.audit(box, innerAvail, explicitH !== undefined);
      return box;
    }

    // ── Row ──
    interface Item {
      kid: HostNode | string;
      ks: Style;
      m: ReturnType<typeof edges>;
      basis: number;
      grow: number;
      shrink: number;
      final: number;
      box?: Box;
    }
    const items: Item[] = [];
    for (const kid of kids) {
      const ks = typeof kid === 'string' ? {} : styleOf(kid);
      if (ks.position === 'absolute') {
        const child = this.layout(kid, innerAvail, false);
        child.x += pad.left;
        child.y += pad.top;
        box.children.push(child);
        continue;
      }
      const km = edges(ks, 'margin');
      const flex = num(ks.flex);
      const grow = num(ks.flexGrow, flex > 0 ? flex : 0);
      // React Native default: flexShrink 0 (unlike the web).
      const shrink = num(ks.flexShrink, flex > 0 ? 1 : 0);
      let basis: number;
      if (typeof ks.flexBasis === 'number') basis = ks.flexBasis;
      else if (flex > 0) basis = 0;
      else if (typeof ks.width === 'number') basis = ks.width;
      else {
        // Yoga measures an unsized main-axis child FitContent at the
        // container's inner width when overflow !== scroll.
        const probe = this.layout(kid, innerAvail, false);
        basis = probe.w;
      }
      items.push({ kid, ks, m: km, basis, grow, shrink, final: basis });
    }
    const gaps = Math.max(0, items.length - 1) * gap;
    const used =
      items.reduce((acc, it) => acc + it.basis + it.m.left + it.m.right, 0) +
      gaps;
    let free = innerAvail - used;
    if (free > 0) {
      const totalGrow = items.reduce((a, it) => a + it.grow, 0);
      if (totalGrow > 0) {
        for (const it of items)
          it.final = it.basis + (free * it.grow) / totalGrow;
        free = 0;
      }
    } else if (free < 0) {
      const scaled = items.reduce((a, it) => a + it.basis * it.shrink, 0);
      if (scaled > 0) {
        for (const it of items) {
          it.final = Math.max(
            0,
            it.basis + (free * it.basis * it.shrink) / scaled,
          );
        }
        free = 0;
      }
    }
    // Yoga: center with negative free space overflows both sides; space-*
    // with negative free space packs from the start.
    const justify = (s.justifyContent as string | undefined) ?? 'flex-start';
    let x = pad.left;
    let between = gap;
    if (free > 0 && justify === 'center') x += free / 2;
    else if (free !== 0 && justify === 'center') x += free / 2;
    else if (free > 0 && justify === 'flex-end') x += free;
    else if (free > 0 && justify === 'space-between' && items.length > 1)
      between += free / (items.length - 1);
    else if (free > 0 && justify === 'space-around') {
      x += free / items.length / 2;
      between += free / items.length;
    } else if (free > 0 && justify === 'space-evenly') {
      x += free / (items.length + 1);
      between += free / (items.length + 1);
    }
    let rowContentH = 0;
    for (const it of items) {
      const child = this.layout(
        it.kid,
        it.final + it.m.left + it.m.right,
        false,
      );
      child.w = it.final;
      if (typeof it.kid !== 'string' && it.kid.type === 'Text' && child.text) {
        // Re-wrap the text at its final width.
        const ts = styleOf(it.kid);
        const tp = this.textProps(it.kid, ts);
        const inner = Math.max(0, it.final - child.pad.left - child.pad.right);
        const mm = measureText(
          child.text.value,
          tp.fontSize,
          tp.letterSpacing,
          inner,
        );
        const lines =
          typeof tp.numberOfLines === 'number' && tp.numberOfLines > 0
            ? Math.min(mm.lines, tp.numberOfLines)
            : mm.lines;
        child.h = Math.max(
          num(ts.minHeight),
          lines * tp.lineHeight + child.pad.top + child.pad.bottom,
        );
        child.text.lines = lines;
      }
      child.x = x + it.m.left;
      x = child.x + child.w + it.m.right + between;
      rowContentH = Math.max(rowContentH, child.h + it.m.top + it.m.bottom);
      it.box = child;
      box.children.push(child);
    }
    box.h = explicitH ?? Math.max(minH, rowContentH + pad.top + pad.bottom);
    const innerH = box.h - pad.top - pad.bottom;
    for (const it of items) {
      const child = it.box!;
      if (alignItems === 'center') child.y = pad.top + (innerH - child.h) / 2;
      else if (alignItems === 'flex-end')
        child.y = pad.top + innerH - child.h - it.m.bottom;
      else if (
        alignItems === 'stretch' &&
        !(typeof it.kid !== 'string' && it.kid.type === 'Text') &&
        typeof it.ks.height !== 'number'
      ) {
        child.y = pad.top + it.m.top;
        child.h = innerH - it.m.top - it.m.bottom;
      } else child.y = pad.top + it.m.top;
    }
    box.w = outerW ?? Math.min(x - between + pad.right, maxW);
    this.audit(box, innerAvail, explicitH !== undefined);
    return box;
  }

  private audit(box: Box, innerW: number, fixedHeight: boolean) {
    const contentRight = box.pad.left + innerW;
    const contentBottom = box.h - box.pad.bottom;
    for (const child of box.children) {
      if (child.w === 0 && child.h === 0) continue;
      const right = child.x + child.w;
      const bottom = child.y + child.h;
      const overflowRight = right - contentRight;
      const overflowLeft = box.pad.left - child.x;
      const horizontal = Math.max(overflowRight, overflowLeft);
      if (horizontal > 0.5) {
        this.issues.push({
          kind: 'overflow-horizontal',
          node: child.label,
          text: child.text?.value.slice(0, 60),
          byPx: Math.round(horizontal * 10) / 10,
          parent: box.label,
          parentContentWidth: Math.round(innerW * 10) / 10,
          rect: rect(child),
        });
      }
      const vertical = bottom - contentBottom;
      if (fixedHeight && vertical > 0.5) {
        this.issues.push({
          kind: 'overflow-vertical',
          node: child.label,
          text: child.text?.value.slice(0, 60),
          byPx: Math.round(vertical * 10) / 10,
          parent: box.label,
          rect: rect(child),
        });
      }
    }
    // Sibling overlap (only possible via overflow in our packed model).
    box.children.forEach((a, i) => {
      for (const c of box.children.slice(i + 1)) {
        if (a.w === 0 || c.w === 0 || a.h === 0 || c.h === 0) continue;
        const ox = Math.min(a.x + a.w, c.x + c.w) - Math.max(a.x, c.x);
        const oy = Math.min(a.y + a.h, c.y + c.h) - Math.max(a.y, c.y);
        if (ox > 0.5 && oy > 0.5) {
          this.issues.push({
            kind: 'overlap',
            node: `${a.label} × ${c.label}`,
            byPx: Math.round(Math.min(ox, oy) * 10) / 10,
            parent: box.label,
            rect: rect(c),
          });
        }
      }
    });
  }
}

/**
 * Second pass: for every text node, how far does it extend past the border
 * box of the nearest ancestor that clips (overflow hidden/scroll, or the
 * screen itself)? That is what a user would see cut off.
 */
function clipAudit(root: Box, issues: LayoutIssue[]) {
  const visit = (
    b: Box,
    ox: number,
    oy: number,
    clipper: { box: Box; x: number; y: number } | null,
  ) => {
    const ax = ox + b.x;
    const ay = oy + b.y;
    if (b.text && clipper && b.w > 0) {
      const cRight = clipper.x + clipper.box.w;
      const cBottom = clipper.y + clipper.box.h;
      const overRight = ax + b.w - cRight;
      const overLeft = clipper.x - ax;
      const h = Math.max(overRight, overLeft);
      if (h > 0.5) {
        issues.push({
          kind: 'clipped-horizontal',
          node: b.label,
          text: b.text.value.slice(0, 60),
          byPx: Math.round(h * 10) / 10,
          parent: clipper.box.label,
          clipper: clipper.box.label,
          rect: {
            x: Math.round(ax * 10) / 10,
            y: Math.round(ay * 10) / 10,
            w: Math.round(b.w * 10) / 10,
            h: Math.round(b.h * 10) / 10,
          },
        });
      }
      const v = ay + b.h - cBottom;
      if (v > 0.5 && clipper.box.type !== 'RCTScrollView') {
        issues.push({
          kind: 'clipped-vertical',
          node: b.label,
          text: b.text.value.slice(0, 60),
          byPx: Math.round(v * 10) / 10,
          parent: clipper.box.label,
          clipper: clipper.box.label,
          rect: {
            x: Math.round(ax * 10) / 10,
            y: Math.round(ay * 10) / 10,
            w: Math.round(b.w * 10) / 10,
            h: Math.round(b.h * 10) / 10,
          },
        });
      }
    }
    const nextClipper =
      b.overflowHidden || b === root ? { box: b, x: ax, y: ay } : clipper;
    for (const c of b.children) visit(c, ax, ay, nextClipper);
  };
  visit(root, 0, 0, null);
}

function rect(b: Box) {
  return {
    x: Math.round(b.x * 10) / 10,
    y: Math.round(b.y * 10) / 10,
    w: Math.round(b.w * 10) / 10,
    h: Math.round(b.h * 10) / 10,
  };
}

function findBox(box: Box, pred: (b: Box) => boolean): Box | null {
  if (pred(box)) return box;
  for (const c of box.children) {
    const hit = findBox(c, pred);
    if (hit) return hit;
  }
  return null;
}

function absoluteRect(
  root: Box,
  target: Box,
): { x: number; y: number; w: number; h: number } | null {
  const walk = (
    b: Box,
    ox: number,
    oy: number,
  ): { x: number; y: number; w: number; h: number } | null => {
    if (b === target) return { x: ox + b.x, y: oy + b.y, w: b.w, h: b.h };
    for (const c of b.children) {
      const hit = walk(c, ox + b.x, oy + b.y);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root, 0, 0);
}

// ─── Tree helpers ────────────────────────────────────────────────────────────

function hostRoot(renderer: Renderer): HostNode {
  const json = renderer.toJSON();
  if (!json || Array.isArray(json)) throw new Error('unexpected host tree');
  return json;
}

/** Rendered-tree evidence: host type, ids, a11y props, flattened style, text. */
function compactTree(node: HostNode | string): unknown {
  if (typeof node === 'string' || typeof node === 'number') return node;
  const p = node.props as Record<string, unknown>;
  const keep: Record<string, unknown> = {};
  for (const key of [
    'testID',
    'accessibilityRole',
    'accessibilityLabel',
    'accessibilityHint',
    'accessibilityState',
    'accessibilityLiveRegion',
    'accessible',
    'numberOfLines',
    'allowFontScaling',
    'maxFontSizeMultiplier',
  ]) {
    if (p[key] !== undefined) keep[key] = p[key];
  }
  if (p.style !== undefined) keep.style = StyleSheet.flatten(p.style as Style);
  if (isInteractive(node)) keep.interactive = true;
  return {
    type: node.type,
    ...keep,
    children: (node.children ?? []).map(k =>
      compactTree(k as HostNode | string),
    ),
  };
}

function walk(node: HostNode | string, visit: (n: HostNode) => void) {
  if (typeof node === 'string' || typeof node === 'number') return;
  visit(node);
  for (const kid of node.children ?? []) walk(kid as HostNode | string, visit);
}

function isInteractive(node: HostNode): boolean {
  const p = node.props as Record<string, unknown>;
  return (
    typeof p.onClick === 'function' ||
    typeof p.onResponderRelease === 'function' ||
    typeof p.onStartShouldSetResponder === 'function'
  );
}

function press(renderer: Renderer, label: string) {
  const targets = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function' &&
      typeof n.type !== 'string',
  );
  const target = targets[0];
  if (!target) throw new Error(`no pressable labelled ${label}`);
  act(() => {
    target.props.onPress();
  });
}

async function settle() {
  await act(async () => {});
  await act(async () => {});
}

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string | number => typeof c !== 'object')
    .join('');
}

// ─── Seams driven per variant ────────────────────────────────────────────────

type NativeApple = { signInWithApple: jest.Mock };
const nativeModules = NativeModules as { PickleAuth?: NativeApple };
const mockAppleSignIn = jest.fn();
const realFetch = globalThis.fetch;
let fetchBodies: unknown[] = [];

function installFetch(status: number, body: unknown, unreadable = false) {
  globalThis.fetch = jest.fn(
    async (_url: unknown, init?: { body?: string }) => {
      fetchBodies.push(init?.body ? JSON.parse(init.body) : null);
      return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
          if (unreadable) throw new SyntaxError('Unexpected token < in JSON');
          return body;
        },
      } as unknown as Response;
    },
  ) as unknown as typeof fetch;
}

function applePayload() {
  return {
    user: 'apple-sub-001',
    identityToken: 'apple-identity-token',
    authorizationCode: 'apple-auth-code',
    email: 'pat@privaterelay.example',
    givenName: 'Pat',
    familyName: 'Player',
  };
}

function googleSuccess(idToken: string | null) {
  return {
    type: 'success',
    data: {
      user: {
        id: 'google-uid-1',
        name: 'Pat Player',
        email: 'pat@gmail.example',
        photo: null,
        familyName: 'Player',
        givenName: 'Pat',
      },
      scopes: [],
      idToken,
      serverAuthCode: null,
    },
  };
}

interface Expectation {
  cardVisible: boolean;
  busy: boolean;
  heading: 'SIGN-IN FAILED' | 'NOT CONFIGURED YET' | null;
  message: string | null;
  bootstrapCalled: boolean;
  pressLabel: 'Continue with Apple' | 'Continue with Google' | null;
}

/** Arm the seams for the variant and return what the screen must show. */
function armSeam(v: Variant): Expectation {
  nativeModules.PickleAuth = { signInWithApple: mockAppleSignIn };
  mockAppleSignIn.mockReset();
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);
  mockGoogleSignin.hasPlayServices.mockResolvedValue(true);
  mockGoogleSignin.signIn.mockResolvedValue({ type: 'cancelled', data: null });
  installFetch(500, { error: { message: 'unarmed' } });
  const none: Expectation = {
    cardVisible: false,
    busy: false,
    heading: null,
    message: null,
    bootstrapCalled: false,
    pressLabel: null,
  };
  switch (v.seam) {
    case 'none':
      return none;
    case 'busy-pending':
      mockAppleSignIn.mockReturnValue(new Promise(() => {}));
      return { ...none, busy: true, pressLabel: 'Continue with Apple' };
    case 'apple-native-reject':
      mockAppleSignIn.mockRejectedValue({
        code: 'ASAuthorizationError.1000',
        message: v.message,
      });
      return {
        ...none,
        cardVisible: true,
        heading: 'SIGN-IN FAILED',
        message: v.message,
        pressLabel: 'Continue with Apple',
      };
    case 'apple-native-error':
      mockAppleSignIn.mockRejectedValue(new Error(v.message));
      return {
        ...none,
        cardVisible: true,
        heading: 'SIGN-IN FAILED',
        message: v.message,
        pressLabel: 'Continue with Apple',
      };
    case 'apple-native-cancel':
      mockAppleSignIn.mockRejectedValue({
        code: 'auth.canceled',
        message: v.message,
      });
      return { ...none, pressLabel: 'Continue with Apple' };
    case 'apple-module-missing':
      delete nativeModules.PickleAuth;
      return {
        ...none,
        cardVisible: true,
        heading: 'NOT CONFIGURED YET',
        message: 'Native Apple sign-in module is missing from this build.',
        pressLabel: 'Continue with Apple',
      };
    case 'apple-server-4xx':
    case 'apple-server-5xx': {
      mockAppleSignIn.mockResolvedValue(applePayload());
      installFetch(v.httpStatus, { error: { code: 'x', message: v.message } });
      const blank = v.message.trim() === '';
      const fallback =
        v.httpStatus === 401 || v.httpStatus === 403
          ? 'The account server could not verify this identity provider token.'
          : 'Secure account setup could not be completed.';
      return {
        ...none,
        cardVisible: true,
        heading: 'SIGN-IN FAILED',
        message: blank ? fallback : v.message,
        bootstrapCalled: true,
        pressLabel: 'Continue with Apple',
      };
    }
    case 'google-server-4xx':
    case 'google-server-5xx': {
      mockGoogleSignin.signIn.mockResolvedValue(
        googleSuccess('google-id-token'),
      );
      installFetch(v.httpStatus, { error: { code: 'x', message: v.message } });
      const blank = v.message.trim() === '';
      const fallback =
        v.httpStatus === 401 || v.httpStatus === 403
          ? 'The account server could not verify this identity provider token.'
          : 'Secure account setup could not be completed.';
      return {
        ...none,
        cardVisible: true,
        heading: 'SIGN-IN FAILED',
        message: blank ? fallback : v.message,
        bootstrapCalled: true,
        pressLabel: 'Continue with Google',
      };
    }
    case 'google-cancel':
      return { ...none, pressLabel: 'Continue with Google' };
    case 'google-no-idtoken':
      mockGoogleSignin.signIn.mockResolvedValue(googleSuccess(null));
      return {
        ...none,
        cardVisible: true,
        heading: 'SIGN-IN FAILED',
        message:
          'The identity provider did not return a token for secure account setup.',
        pressLabel: 'Continue with Google',
      };
    case 'server-unreadable-json':
      mockAppleSignIn.mockResolvedValue(applePayload());
      installFetch(502, null, true);
      return {
        ...none,
        cardVisible: true,
        heading: 'SIGN-IN FAILED',
        message: 'The account server returned an unreadable response.',
        bootstrapCalled: true,
        pressLabel: 'Continue with Apple',
      };
    case 'server-nonstring-message':
      mockAppleSignIn.mockResolvedValue(applePayload());
      installFetch(v.httpStatus, {
        error: { message: { nested: v.message, n: -0, big: 1e308 } },
      });
      return {
        ...none,
        cardVisible: true,
        heading: 'SIGN-IN FAILED',
        message:
          v.httpStatus === 401 || v.httpStatus === 403
            ? 'The account server could not verify this identity provider token.'
            : 'Secure account setup could not be completed.',
        bootstrapCalled: true,
        pressLabel: 'Continue with Apple',
      };
    case 'store-direct-null-message':
      return {
        ...none,
        cardVisible: true,
        heading: 'SIGN-IN FAILED',
        message: null,
      };
    case 'store-direct-undefined-message':
      return {
        ...none,
        cardVisible: true,
        heading: 'NOT CONFIGURED YET',
        message: null,
      };
    case 'store-direct-unknown-code':
      return {
        ...none,
        cardVisible: true,
        heading: 'SIGN-IN FAILED',
        message: v.message,
      };
  }
}

async function applyDirectStoreState(v: Variant) {
  const errorState =
    v.seam === 'store-direct-null-message'
      ? { code: 'auth.failed', message: null }
      : v.seam === 'store-direct-undefined-message'
        ? { code: 'auth.not_configured', message: undefined }
        : { code: 'totally.unknown.code', message: v.message };
  await act(async () => {
    useAuthStore.setState({
      error: errorState as unknown as { code: 'auth.failed'; message: string },
    });
  });
}

// ─── Per-variant checks ──────────────────────────────────────────────────────

interface Outcome {
  seed: number;
  index: number;
  mode: Variant['mode'];
  width: number;
  fontScale: number;
  insets: Variant['insets'];
  locale: string;
  timezone: string;
  seam: ErrorSeam;
  messageClass: MessageClass;
  messageLength: number;
  messagePreview: string;
  hard: string[];
  notes: string[];
  layout: LayoutIssue[];
  interactive: Array<{
    label: string;
    role: string;
    w: number;
    h: number;
    disabled: boolean;
  }>;
  contentHeight: number;
  needsScroll: boolean;
  warnings: string[];
  result: 'HELD' | 'BROKEN' | 'LAYOUT_FLAG';
  durationMs: number;
}

function checkTree(
  renderer: Renderer,
  v: Variant,
  expected: Expectation,
  hard: string[],
  notes: string[],
): {
  layout: LayoutIssue[];
  interactive: Outcome['interactive'];
  contentHeight: number;
} {
  const root = hostRoot(renderer);
  // Locate the SignInScreen root (the View carrying the safe-area padding)
  // by its body testID so app-mode trees are measured the same way.
  let screenNode: HostNode | null = null;
  const parents = new Map<HostNode, HostNode>();
  walk(root, n => {
    for (const k of n.children ?? [])
      if (typeof k !== 'string') parents.set(k as HostNode, n);
  });
  walk(root, n => {
    if ((n.props as { testID?: string }).testID === 'sign-in-body') {
      // body → scroll content view → RCTScrollView → screen
      let cur: HostNode | undefined = n;
      for (let i = 0; i < 3 && cur; i += 1) cur = parents.get(cur);
      screenNode = cur ?? null;
    }
  });
  if (!screenNode) {
    hard.push('sign-in-body not found in rendered tree');
    return { layout: [], interactive: [], contentHeight: 0 };
  }
  const screen = screenNode as HostNode;

  // Safe-area padding must be finite and never negative (clamped by fallback).
  // (UIKit never reports negative safe-area insets; a hostile negative value
  // passing straight through is recorded as a note, not a failure.)
  const screenStyle = styleOf(screen);
  const pt = screenStyle.paddingTop;
  const pb = screenStyle.paddingBottom;
  if (typeof pt !== 'number' || !Number.isFinite(pt))
    hard.push(
      `screen paddingTop invalid: ${String(pt)} for insets.top=${v.insets.top}`,
    );
  if (typeof pb !== 'number' || !Number.isFinite(pb))
    hard.push(
      `screen paddingBottom invalid: ${String(pb)} for insets.bottom=${v.insets.bottom}`,
    );
  if (typeof pt === 'number' && pt < 0)
    notes.push(
      `negative safe-area top ${v.insets.top} passed through as paddingTop ${pt}`,
    );
  if (typeof pb === 'number' && pb < 0)
    notes.push(
      `negative safe-area bottom ${v.insets.bottom} passed through as paddingBottom ${pb}`,
    );

  // Exactly one ScrollView; providers, error card and trust copy inside it.
  const scrollViews: HostNode[] = [];
  walk(screen, n => {
    if (n.type === 'RCTScrollView') scrollViews.push(n);
  });
  if (scrollViews.length !== 1)
    hard.push(`expected 1 ScrollView, found ${scrollViews.length}`);

  // Interactive inventory: role + label + not-nested-in-another-interactive.
  const interactive: Outcome['interactive'] = [];
  const model = new LayoutModel(v.fontScale);
  const box = model.layout(screen, v.width, true);
  clipAudit(box, model.issues);
  walk(screen, n => {
    if (!isInteractive(n)) return;
    const p = n.props as Record<string, unknown>;
    const label =
      typeof p.accessibilityLabel === 'string' ? p.accessibilityLabel : '';
    const role =
      typeof p.accessibilityRole === 'string' ? p.accessibilityRole : '';
    if (!label.trim())
      hard.push(`interactive ${describe_(n)} has no accessibilityLabel`);
    if (!role)
      hard.push(`interactive ${describe_(n)} has no accessibilityRole`);
    let anc = parents.get(n);
    while (anc && anc !== screen) {
      if (isInteractive(anc)) {
        hard.push(
          `interactive ${label} nested inside interactive ${describe_(anc)}`,
        );
        break;
      }
      anc = parents.get(anc);
    }
    const state = p.accessibilityState as { disabled?: boolean } | undefined;
    const b = findBox(box, bb => bb.node === n);
    const r = b ? absoluteRect(box, b) : null;
    const w = r?.w ?? 0;
    const h = r?.h ?? 0;
    interactive.push({
      label,
      role,
      w: Math.round(w),
      h: Math.round(h),
      disabled: Boolean(state?.disabled),
    });
    // Static ≥44pt: the style itself must guarantee the size (height/minHeight
    // or width) independent of the model.
    const st = styleOf(n);
    const hGuarantee = Math.max(num(st.height), num(st.minHeight));
    const wGuarantee = num(st.width);
    if (hGuarantee < 44 && h < 44)
      hard.push(
        `target "${label}" height ${h} < 44 (style guarantees ${hGuarantee})`,
      );
    if (wGuarantee > 0 && wGuarantee < 44)
      hard.push(`target "${label}" width ${wGuarantee} < 44`);
    if (w < 44) hard.push(`target "${label}" modeled width ${w} < 44`);
  });

  const labels = interactive.map(i => i.label);
  for (const must of ['Back', 'Continue with Apple', 'Continue with Google']) {
    if (!labels.includes(must)) hard.push(`missing control "${must}"`);
  }
  if (new Set(labels).size !== labels.length)
    hard.push(`duplicate accessibility labels: ${labels.join(', ')}`);

  // Busy / error semantics.
  for (const i of interactive) {
    if (i.label.startsWith('Continue with') && i.disabled !== expected.busy)
      hard.push(
        `"${i.label}" disabled=${i.disabled} but busy=${expected.busy}`,
      );
  }
  const copy = allText(renderer);
  if (expected.busy !== copy.includes('Signing in securely…'))
    hard.push(
      `busy row visible=${copy.includes('Signing in securely…')} expected ${expected.busy}`,
    );
  const dismiss = interactive.find(i => i.label === 'Dismiss sign-in error');
  if (Boolean(dismiss) !== expected.cardVisible)
    hard.push(
      `error card visible=${Boolean(dismiss)} expected ${expected.cardVisible} (seam ${v.seam})`,
    );
  if (expected.cardVisible) {
    if (expected.heading && !copy.includes(expected.heading))
      hard.push(`heading "${expected.heading}" missing`);
    const cardNode = (() => {
      let hit: HostNode | null = null;
      walk(screen, n => {
        if (
          (n.props as { accessibilityLabel?: string }).accessibilityLabel ===
          'Dismiss sign-in error'
        )
          hit = n;
      });
      return hit as HostNode | null;
    })();
    if (cardNode) {
      const p = cardNode.props as Record<string, unknown>;
      if (expected.message !== null) {
        if (p.accessibilityHint !== expected.message)
          hard.push(
            `accessibilityHint !== message (hint=${JSON.stringify(String(p.accessibilityHint).slice(0, 40))})`,
          );
        const rendered = textOf(cardNode);
        if (!rendered.includes(expected.message))
          hard.push(
            `message text not rendered verbatim (class ${v.messageClass}, len ${expected.message.length})`,
          );
      }
      // Reading order: the card sits after the providers in the tree.
      const order: string[] = [];
      walk(screen, n => {
        const l = (n.props as { accessibilityLabel?: string })
          .accessibilityLabel;
        if (isInteractive(n) && typeof l === 'string') order.push(l);
      });
      if (
        order.indexOf('Dismiss sign-in error') <
        order.indexOf('Continue with Google')
      )
        hard.push('error card precedes providers in reading order');
    }
  }

  // Scroll structure: the body must grow, not flex, so a tall error never
  // squeezes the trust footer over the providers.
  let body: HostNode | null = null;
  walk(screen, n => {
    if ((n.props as { testID?: string }).testID === 'sign-in-body') body = n;
  });
  if (body) {
    const bs = styleOf(body);
    if (bs.flex !== undefined) hard.push('body uses flex (must be flexGrow)');
    if (num(bs.flexGrow) !== 1) hard.push('body flexGrow !== 1');
  }
  return { layout: model.issues, interactive, contentHeight: box.h };
}

// ─── Campaign ────────────────────────────────────────────────────────────────

const MASTER_SEED = Number(process.env.STRESS_SEED ?? '20260904') >>> 0;
const REPLAY = (process.env.STRESS_REPLAY ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => Number(s) >>> 0);
const ITER =
  REPLAY.length > 0
    ? REPLAY.length
    : Math.max(1, Number(process.env.STRESS_ITER ?? '40') | 0);
const STRICT_LAYOUT = process.env.STRESS_STRICT_LAYOUT === '1';
const GRID_SIZE =
  WIDTHS_GRID.length * FONT_SCALES_GRID.length * ERROR_SEAMS.length; // 153

function iterationSeeds(): number[] {
  if (REPLAY.length > 0) return REPLAY;
  const master = mulberry32(MASTER_SEED);
  const seeds: number[] = [];
  for (let i = 0; i < ITER; i += 1)
    seeds.push(Math.floor(master() * 4294967296) >>> 0);
  return seeds;
}

function indexForSeed(seed: number): number {
  // Replayed seeds recover their grid position from the master sequence so
  // the same seed always yields the same variant.
  const master = mulberry32(MASTER_SEED);
  for (let i = 0; i < Math.max(ITER, GRID_SIZE, 4096); i += 1) {
    if (Math.floor(master() * 4294967296) >>> 0 === seed) return i;
  }
  return GRID_SIZE; // off-grid: fully random derivation
}

const outcomes: Outcome[] = [];
let consoleErrors: string[] = [];
let realConsoleError: typeof console.error;
let realDateNow: typeof Date.now;
let resolvedOptionsSpy: jest.SpyInstance | null = null;

beforeAll(() => {
  realConsoleError = console.error;
  realDateNow = Date.now;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(
      args
        .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ')
        .slice(0, 300),
    );
  };
});

afterAll(() => {
  console.error = realConsoleError;
  Date.now = realDateNow;
  globalThis.fetch = realFetch;
  resolvedOptionsSpy?.mockRestore();
  if (process.env.STRESS_OUT) {
    const out = path.resolve(process.env.STRESS_OUT);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(
      out,
      JSON.stringify(
        {
          unit: 'scr-signinscreen',
          lens: 'boundary-i18n-a11y',
          masterSeed: MASTER_SEED,
          iterations: outcomes.length,
          strictLayout: STRICT_LAYOUT,
          summary: {
            held: outcomes.filter(o => o.result === 'HELD').length,
            broken: outcomes.filter(o => o.result === 'BROKEN').length,
            layoutFlag: outcomes.filter(o => o.result === 'LAYOUT_FLAG').length,
          },
          outcomes,
        },
        null,
        1,
      ),
    );
  }
});

async function runVariant(v: Variant, index: number): Promise<Outcome> {
  const started = realDateNow();
  consoleErrors = [];
  fetchBodies = [];
  mockKv.clear();
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: true,
    session: null,
    busy: false,
    error: null,
  });
  mockMetrics.frame = { x: 0, y: 0, width: v.width, height: v.height };
  mockMetrics.insets = { ...v.insets };
  resolvedOptionsSpy?.mockRestore();
  const realResolved = Intl.DateTimeFormat.prototype.resolvedOptions;
  resolvedOptionsSpy = jest
    .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
    .mockImplementation(function (this: Intl.DateTimeFormat) {
      return {
        ...realResolved.call(this),
        locale: v.locale,
        timeZone: v.timezone,
      };
    });
  Date.now = () => v.nowMs;

  const expected = armSeam(v);
  const hard: string[] = [];
  const notes: string[] = [];
  const onBack = jest.fn();
  let renderer!: Renderer;

  try {
    if (v.mode === 'app') {
      await act(async () => {
        renderer = TestRenderer.create(<App />);
      });
      await settle();
      await settle();
      if (!allText(renderer).includes('I already have an account')) {
        hard.push(
          `app gate did not land on Welcome: ${allText(renderer).slice(0, 120)}`,
        );
      } else {
        press(renderer, 'I already have an account');
        await settle();
      }
    } else {
      await act(async () => {
        renderer = TestRenderer.create(<SignInScreen onBack={onBack} />);
      });
      await settle();
    }

    if (v.seam.startsWith('store-direct')) {
      await applyDirectStoreState(v);
    } else if (expected.pressLabel) {
      press(renderer, expected.pressLabel);
      await settle();
      await settle();
    }

    const tree = checkTree(renderer, v, expected, hard, notes);
    if (process.env.STRESS_TREES) {
      const dir = path.resolve(process.env.STRESS_TREES);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, `seed-${v.seed}.json`),
        JSON.stringify(
          {
            variant: v,
            layout: tree.layout,
            tree: compactTree(hostRoot(renderer)),
          },
          null,
          1,
        ),
      );
    }

    if (expected.bootstrapCalled) {
      const body = fetchBodies[0] as
        { locale?: string; timezone?: string } | undefined;
      if (!body) hard.push('bootstrap fetch not called');
      else {
        if (body.locale !== v.locale)
          hard.push(`bootstrap locale ${body.locale} !== ${v.locale}`);
        if (body.timezone !== v.timezone)
          hard.push(`bootstrap timezone ${body.timezone} !== ${v.timezone}`);
      }
    }

    // Recovery: Dismiss clears the card; Back leaves the screen.
    if (expected.cardVisible) {
      press(renderer, 'Dismiss sign-in error');
      await settle();
      if (useAuthStore.getState().error !== null)
        hard.push('Dismiss did not clear error');
      if (
        allText(renderer).includes('SIGN-IN FAILED') ||
        allText(renderer).includes('NOT CONFIGURED YET')
      )
        hard.push('error card still rendered after Dismiss');
    }
    if (!expected.busy) {
      press(renderer, 'Back');
      await settle();
      if (v.mode === 'screen' && onBack.mock.calls.length !== 1)
        hard.push(`onBack called ${onBack.mock.calls.length}× (expected 1)`);
      if (
        v.mode === 'app' &&
        !allText(renderer).includes('I already have an account')
      )
        hard.push('Back did not return the Gate to Welcome');
    } else {
      // Busy: Back must still be enabled (user can bail out of a hung sign-in).
      const back = renderer.root.findAll(
        n =>
          n.props.accessibilityLabel === 'Back' &&
          typeof n.props.onPress === 'function' &&
          typeof n.type !== 'string',
      )[0];
      if (!back || back.props.disabled) hard.push('Back disabled while busy');
    }

    const warnings = consoleErrors.filter(m => !m.includes('unarmed'));
    if (warnings.length > 0)
      hard.push(`console.error during render: ${warnings[0]}`);

    const layoutIssues = tree.layout;
    const result: Outcome['result'] =
      hard.length > 0
        ? 'BROKEN'
        : layoutIssues.length > 0
          ? 'LAYOUT_FLAG'
          : 'HELD';
    return {
      seed: v.seed,
      index,
      mode: v.mode,
      width: v.width,
      fontScale: v.fontScale,
      insets: v.insets,
      locale: v.locale,
      timezone: v.timezone,
      seam: v.seam,
      messageClass: v.messageClass,
      messageLength: v.message.length,
      messagePreview: JSON.stringify(v.message.slice(0, 48)),
      hard,
      notes,
      layout: layoutIssues,
      interactive: tree.interactive,
      contentHeight: Math.round(tree.contentHeight),
      needsScroll: tree.contentHeight > v.height,
      warnings,
      result,
      durationMs: realDateNow() - started,
    };
  } catch (error) {
    hard.push(
      `threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
    return {
      seed: v.seed,
      index,
      mode: v.mode,
      width: v.width,
      fontScale: v.fontScale,
      insets: v.insets,
      locale: v.locale,
      timezone: v.timezone,
      seam: v.seam,
      messageClass: v.messageClass,
      messageLength: v.message.length,
      messagePreview: JSON.stringify(v.message.slice(0, 48)),
      hard,
      notes,
      layout: [],
      interactive: [],
      contentHeight: 0,
      needsScroll: false,
      warnings: consoleErrors,
      result: 'BROKEN',
      durationMs: realDateNow() - started,
    };
  } finally {
    if (renderer) {
      act(() => {
        renderer.unmount();
      });
    }
    // Let any pending (never-resolving) sign-in promise be abandoned with
    // the store reset; the next variant re-arms everything.
    useAuthStore.setState({ busy: false, error: null, session: null });
    delete nativeModules.PickleAuth;
  }
}

describe(`SignInScreen boundary/i18n/a11y stress (master seed ${MASTER_SEED}, ${ITER} iterations)`, () => {
  const seeds = iterationSeeds();

  it.each(seeds.map((seed, i) => [seed, i] as const))(
    'seed %d holds the hard invariants',
    async (seed, i) => {
      const index = REPLAY.length > 0 ? indexForSeed(seed) : i;
      const variant = deriveVariant(seed, index, GRID_SIZE);
      const outcome = await runVariant(variant, index);
      outcomes.push(outcome);
      const detail = JSON.stringify(
        {
          seed,
          variant: { ...variant, message: variant.message.slice(0, 80) },
          hard: outcome.hard,
          layout: outcome.layout,
        },
        null,
        1,
      );
      expect({
        hard: outcome.hard,
        detail: outcome.hard.length ? detail : '',
      }).toEqual({ hard: [], detail: '' });
      if (STRICT_LAYOUT)
        expect({
          layout: outcome.layout,
          detail: outcome.layout.length ? detail : '',
        }).toEqual({ layout: [], detail: '' });
    },
  );

  // iOS has no live regions: RN's `accessibilityLiveRegion` is Android-only
  // (ReactAndroid BaseViewManager.setAccessibilityLiveRegion; nothing under
  // React/ on iOS). The codebase's own pattern for iOS announcements is
  // `AccessibilityInfo.announceForAccessibility` (RankUpCelebration,
  // StreakCelebration, FirstRunWalkthrough). A VoiceOver user who taps
  // "Continue with Apple" and gets a failure must hear it, or have focus moved
  // onto the error card — either satisfies this check.
  it('announces a sign-in failure to VoiceOver on iOS (announce or focus move)', async () => {
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => {});
    const focus = jest
      .spyOn(AccessibilityInfo, 'setAccessibilityFocus')
      .mockImplementation(() => {});
    const variant: Variant = {
      ...deriveVariant(MASTER_SEED, GRID_SIZE, GRID_SIZE),
      mode: 'screen',
      seam: 'apple-native-error',
      messageClass: 'short-plain',
      message:
        'The account server could not verify this identity provider token.',
    };
    try {
      const outcome = await runVariant(variant, GRID_SIZE);
      expect(outcome.hard).toEqual([]);
      const announced = announce.mock.calls.length + focus.mock.calls.length;
      expect({
        announced,
        note: announced
          ? ''
          : 'SignInScreen.tsx error card relies on accessibilityLiveRegion="assertive" (Android-only); no announceForAccessibility/setAccessibilityFocus call on iOS',
      }).toEqual({ announced: expect.any(Number), note: '' });
      expect(announced).toBeGreaterThan(0);
    } finally {
      announce.mockRestore();
      focus.mockRestore();
    }
  });

  it('executed every planned iteration and covered the boundary grid', () => {
    expect(outcomes.length).toBe(seeds.length);
    const seams = new Set(outcomes.map(o => o.seam));
    const widths = new Set(outcomes.map(o => o.width));
    const scales = new Set(outcomes.map(o => o.fontScale));
    // Any campaign ≥ the grid size must have touched every seam, width and scale.
    if (REPLAY.length === 0 && ITER >= GRID_SIZE) {
      expect([...seams].sort()).toEqual([...ERROR_SEAMS].sort());
      expect([...widths].sort()).toEqual(
        expect.arrayContaining([...WIDTHS_GRID]),
      );
      expect([...scales].sort()).toEqual(
        expect.arrayContaining([...FONT_SCALES_GRID]),
      );
      const classes = new Set(outcomes.map(o => o.messageClass));
      expect(classes.size).toBe(MESSAGE_CLASSES.length);
      const locales = new Set(outcomes.map(o => o.locale));
      expect(locales.size).toBe(LOCALES.length);
      const zones = new Set(outcomes.map(o => o.timezone));
      expect(zones.size).toBe(TIMEZONES.length);
      expect(outcomes.some(o => o.mode === 'app')).toBe(true);
    }
    const flagged = outcomes.filter(o => o.layout.length > 0);
    // Surface the layout-model summary in the run log for triage.
    const byKind = new Map<string, number>();
    for (const o of flagged)
      for (const li of o.layout)
        byKind.set(
          `${li.kind}:${li.node}`,
          (byKind.get(`${li.kind}:${li.node}`) ?? 0) + 1,
        );
    console.log(
      `[stress:scr-signinscreen] iterations=${outcomes.length} held=${outcomes.filter(o => o.result === 'HELD').length} broken=${outcomes.filter(o => o.result === 'BROKEN').length} layoutFlag=${flagged.length}\n` +
        [...byKind.entries()].map(([k, n]) => `  ${n}× ${k}`).join('\n'),
    );
  });
});
