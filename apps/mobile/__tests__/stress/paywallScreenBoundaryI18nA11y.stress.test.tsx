/**
 * PaywallScreen — boundary / i18n / accessibility stress campaign.
 *
 * Every variant mounts the REAL RootNavigator (real NavigationContainer,
 * native-stack, bottom tabs + PremiumTabBar, real PaywallRoute → PaywallScreen,
 * real zustand access store) or, for the prop-boundary variants, the real
 * PaywallScreen directly. Only native modules are mocked (gradient, svg,
 * sqlite, notifications) and — as in wf/flow-guest-local-only.navigator — the
 * screens that are not the unit under test are stubbed with markers so the
 * suite does not drag every store into memory. `fetch` is never reached: the
 * billing/backend dependencies are injected through `configureAccessStore`.
 *
 * Each variant is derived ONLY from `(STRESS_SEED, index)` and is therefore
 * replayable: `STRESS_SEED=20260905 STRESS_ONLY=37 npx jest --ci <file>`.
 * `STRESS_ITER` (default 160) sets the campaign size. Results are written as a
 * JSON table (one row per executed variant) to `STRESS_OUT` or
 * `apps/mobile/artifacts/stress/paywall-boundary-i18n-a11y.json` (git-ignored).
 *
 * What is asserted (hard invariants, fail the variant):
 *   - the screen renders and survives a plan-select / back / close sequence
 *     without throwing and without React console errors;
 *   - every interactive element in the paywall subtree exposes an
 *     accessibility role AND a non-empty label on its HOST node, and its
 *     flattened style declares a ≥ 44pt height (width may stretch);
 *   - no rendered string contains `undefined` / `null` / `NaN` leakage;
 *   - closing pops the Paywall route (navigator) / fires `onClose` (direct).
 *
 * What is only RECORDED (Linux cannot lay out iOS text — a character-width
 * model estimates clipping for `numberOfLines` texts; labelled INFERRED in
 * the JSON): `clipRisks`, `overlapRisks`, `unreachableLabels`.
 */
jest.mock('react-native-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});
jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Line: Mock,
    Path: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
  };
});
jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    throw new Error('sqlite is not available under jest');
  },
}));
jest.mock('../../src/notifications/service', () => ({
  subscribeToNotificationPresses: () => () => {},
}));

// Non-unit screens → markers (same approach as the repo's navigator suites).
// HomeScreen's stub is the launch pad: it pushes the Paywall route through the
// REAL navigation object the moment the Tabs route mounts.
jest.mock('../../src/screens/HomeScreen', () => {
  const ReactLib = require('react');
  const { Text: RNText } = require('react-native');
  const { useNavigation } = require('@react-navigation/native');
  return {
    HomeScreen: () => {
      const navigation = useNavigation();
      ReactLib.useEffect(() => {
        navigation.navigate('Paywall', { source: 'rating' });
      }, [navigation]);
      return ReactLib.createElement(RNText, null, '[HomeScreen]');
    },
  };
});
jest.mock('../../src/screens/LibraryScreen', () => ({
  LibraryScreen: () =>
    require('react').createElement(
      require('react-native').Text,
      null,
      '[LibraryScreen]',
    ),
}));
jest.mock('../../src/screens/ProgressScreen', () => ({
  ProgressScreen: () =>
    require('react').createElement(
      require('react-native').Text,
      null,
      '[ProgressScreen]',
    ),
}));
jest.mock('../../src/screens/SettingsScreen', () => ({
  SettingsScreen: () =>
    require('react').createElement(
      require('react-native').Text,
      null,
      '[SettingsScreen]',
    ),
}));
jest.mock('../../src/screens/AnalyzeScreen', () => ({
  AnalyzeScreen: () =>
    require('react').createElement(
      require('react-native').Text,
      null,
      '[AnalyzeScreen]',
    ),
}));
jest.mock('../../src/screens/DrillLibraryScreen', () => ({
  DrillLibraryScreen: () =>
    require('react').createElement(
      require('react-native').Text,
      null,
      '[DrillLibraryScreen]',
    ),
}));
jest.mock('../../src/screens/ResultScreen', () => ({
  ResultScreen: () =>
    require('react').createElement(
      require('react-native').Text,
      null,
      '[ResultScreen]',
    ),
}));
jest.mock('../../src/screens/ResultDetailsScreen', () => ({
  ResultDetailsScreen: () =>
    require('react').createElement(
      require('react-native').Text,
      null,
      '[ResultDetailsScreen]',
    ),
}));
jest.mock('../../src/screens/FormReviewScreen', () => ({
  FormReviewScreen: () =>
    require('react').createElement(
      require('react-native').Text,
      null,
      '[FormReviewScreen]',
    ),
}));
jest.mock('../../src/screens/StreakCalendarScreen', () => ({
  StreakCalendarScreen: () =>
    require('react').createElement(
      require('react-native').Text,
      null,
      '[StreakCalendarScreen]',
    ),
}));
jest.mock('../../src/screens/SignInScreen', () => ({
  SignInScreen: () =>
    require('react').createElement(
      require('react-native').Text,
      null,
      '[SignInScreen]',
    ),
}));
jest.mock('../../src/screens/ManageAccountScreen', () => ({
  ManageAccountScreen: () =>
    require('react').createElement(
      require('react-native').Text,
      null,
      '[ManageAccountScreen]',
    ),
}));
jest.mock('../../src/screens/ConsentSettingsScreen', () => ({
  ConsentSettingsScreen: () =>
    require('react').createElement(
      require('react-native').Text,
      null,
      '[ConsentSettingsScreen]',
    ),
}));
jest.mock('../../src/screens/NotificationSettingsScreen', () => ({
  NotificationSettingsScreen: () =>
    require('react').createElement(
      require('react-native').Text,
      null,
      '[NotificationSettingsScreen]',
    ),
}));

import * as fs from 'node:fs';
import * as path from 'node:path';
import React from 'react';
import {
  Dimensions,
  I18nManager,
  PixelRatio,
  StyleSheet,
  Text,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  BillingError,
  type BillingAccessDependencies,
  type CanonicalAccessState,
  type StorePlan,
  type StorePlans,
} from '../../src/billing/types';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import { RootNavigator } from '../../src/navigation/RootNavigator';
import {
  PaywallScreen,
  type PaywallScreenProps,
} from '../../src/screens/PaywallScreen';

// ─── Campaign knobs ──────────────────────────────────────────────────────────

const STRESS_SEED = Number(process.env.STRESS_SEED ?? 20260905);
const STRESS_ITER = Math.max(1, Number(process.env.STRESS_ITER ?? 160));
const STRESS_ONLY = (process.env.STRESS_ONLY ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);
const STRESS_OUT =
  process.env.STRESS_OUT ??
  path.join(
    __dirname,
    '..',
    '..',
    'artifacts',
    'stress',
    'paywall-boundary-i18n-a11y.json',
  );
const MIN_TARGET_PT = 44;

// ─── Seeded RNG (mulberry32) ─────────────────────────────────────────────────

function hash32(a: number, b: number): number {
  let h = (a ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (b >>> 0), 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
}

// ─── Dimensions of the lens ──────────────────────────────────────────────────

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
type Locale = (typeof LOCALES)[number];

const CURRENCY: Record<Locale, string> = {
  'de-DE': 'EUR',
  'fr-FR': 'EUR',
  'ar-EG': 'EGP',
  'hi-IN': 'INR',
  'ja-JP': 'JPY',
  'pt-BR': 'BRL',
  'tr-TR': 'TRY',
  'ru-RU': 'RUB',
  'th-TH': 'THB',
  'zh-CN': 'CNY',
  'en-IN': 'INR',
  'es-419': 'MXN',
};

/** IANA zones spanning the offset extremes and DST/half-hour oddities. */
const TIMEZONES = [
  'Etc/GMT+12', // UTC-12 (IANA's westernmost fixed offset)
  'Pacific/Kiritimati', // UTC+14
  'America/New_York', // DST (spring forward / fall back)
  'Europe/Berlin', // DST, EU rules
  'Australia/Lord_Howe', // 30-minute DST shift
  'Asia/Kathmandu', // UTC+5:45
  'Pacific/Chatham', // UTC+12:45 / +13:45 DST
  'UTC',
] as const;

/** Instants sitting on DST edges (and one plain one) for `Date.now`. */
const CLOCKS = [
  { label: 'us-spring-forward', iso: '2026-03-08T07:00:00.000Z' },
  { label: 'us-fall-back', iso: '2026-11-01T05:59:59.000Z' },
  { label: 'eu-spring-forward', iso: '2026-03-29T01:00:00.000Z' },
  { label: 'eu-fall-back', iso: '2026-10-25T00:59:59.000Z' },
  { label: 'lord-howe-shift', iso: '2026-10-03T15:00:00.000Z' },
  { label: 'plain', iso: '2026-09-05T00:00:00.000Z' },
] as const;

const FONT_SCALES = [1, 1.235, 2.35] as const; // Large (default), xxLarge, AX3
const WIDTHS = [320, 375, 430] as const; // iPhone SE (1st) / 13 mini / 15 Pro Max

const STRING_FAMILIES = [
  'ascii',
  'long200',
  'cjk',
  'arabic',
  'zwj',
  'combining',
  'german',
  'thai',
  'empty',
] as const;
type StringFamily = (typeof STRING_FAMILIES)[number];

const PRICE_CLASSES = [
  'normal',
  'zero',
  'negative',
  'huge',
  'tiny',
  'emptyString',
] as const;
type PriceClass = (typeof PRICE_CLASSES)[number];

const PLAN_SETS = [
  'all',
  'noMonthly',
  'noAnnual',
  'noLifetime',
  'onlyAnnual',
  'unavailable',
  'loading',
] as const;
type PlanSet = (typeof PLAN_SETS)[number];

const ACCESS_CLASSES = [
  'unverified',
  'fresh',
  'oneLeft',
  'exhausted',
  'reservedPending',
  'negativeRemaining',
  'hugeUsed',
  'premium',
] as const;
type AccessClass = (typeof ACCESS_CLASSES)[number];

const ERROR_CLASSES = ['none', 'short', 'long'] as const;
type ErrorClass = (typeof ERROR_CLASSES)[number];

const TRIAL_CLASSES = ['none', 'short', 'longLocalized'] as const;
type TrialClass = (typeof TRIAL_CLASSES)[number];

const LEGAL_CLASSES = ['both', 'termsOnly', 'none', 'nullBoth'] as const;
type LegalClass = (typeof LEGAL_CLASSES)[number];

const MOUNTS = ['navigator', 'navigator', 'navigator', 'direct'] as const;
type Mount = (typeof MOUNTS)[number];

const PAGES = ['value', 'pricing', 'pricing'] as const;
type Page = (typeof PAGES)[number];

interface Variant {
  index: number;
  seed: number;
  mount: Mount;
  page: Page;
  locale: Locale;
  timezone: (typeof TIMEZONES)[number];
  clock: (typeof CLOCKS)[number]['label'];
  fontScale: (typeof FONT_SCALES)[number];
  width: (typeof WIDTHS)[number];
  stringFamily: StringFamily;
  priceClass: PriceClass;
  planSet: PlanSet;
  access: AccessClass;
  error: ErrorClass;
  trial: TrialClass;
  legal: LegalClass;
  rtl: boolean;
}

function variantFor(index: number): Variant {
  const seed = hash32(STRESS_SEED, index);
  const rng = new Rng(seed);
  const locale = LOCALES[index % LOCALES.length] ?? 'de-DE';
  return {
    index,
    seed,
    mount: rng.pick(MOUNTS),
    page: rng.pick(PAGES),
    locale,
    timezone: TIMEZONES[index % TIMEZONES.length] ?? 'UTC',
    clock: rng.pick(CLOCKS).label,
    fontScale: FONT_SCALES[Math.floor(index / 12) % FONT_SCALES.length] ?? 1,
    width: WIDTHS[Math.floor(index / 36) % WIDTHS.length] ?? 375,
    stringFamily: rng.pick(STRING_FAMILIES),
    priceClass: rng.pick(PRICE_CLASSES),
    planSet: rng.pick(PLAN_SETS),
    access: rng.pick(ACCESS_CLASSES),
    error: rng.pick(ERROR_CLASSES),
    trial: rng.pick(TRIAL_CLASSES),
    legal: rng.pick(LEGAL_CLASSES),
    rtl: locale === 'ar-EG',
  };
}

// ─── Fixture generators ──────────────────────────────────────────────────────

const SAMPLES: Record<Exclude<StringFamily, 'empty'>, string> = {
  ascii: 'Membership pricing is unavailable from the app store right now.',
  long200:
    'The App Store could not return a verified offer for this account at this time; please check your network connection, confirm that in-app purchases are permitted in Screen Time, and try again in a few minutes.',
  cjk: '現在、App Storeから確認済みのメンバーシップ価格を取得できません。ネットワーク接続を確認して、しばらくしてからもう一度お試しください。会員資格の確認は後で完了します。',
  arabic:
    'تعذّر تحميل عرض موثّق من متجر التطبيقات لهذا الحساب في الوقت الحالي. يُرجى التحقق من اتصال الشبكة والمحاولة مرة أخرى بعد بضع دقائق.',
  zwj: '👨‍👩‍👧‍👦🏳️‍🌈👩🏽‍🚀🧑🏿‍🤝‍🧑🏻 Store offer unavailable 🏓🏓🏓 👨‍👩‍👧‍👦🏳️‍🌈👩🏽‍🚀 please retry 🏓',
  combining:
    'Ṃẹ̃m̥b̂ẻr̃s̈h̊ĩp̣ p̈r̃ĩc̣ĩn̈g̊ ĩs̃ ũn̈ạṽạĩl̃ạb̈l̃ẹ f̃r̃õm̃ t̃h̃ẹ ạp̃p̃ s̃t̃õr̃ẹ r̃ĩg̃h̃t̃ ñõw̃, p̃l̃ẹạs̃ẹ t̃r̃ỹ ạg̃ạĩñ l̃ạt̃ẹr̃.',
  german:
    'Mitgliedschaftspreisinformationsbereitstellungsfehler: Die Abonnementverwaltungsschnittstelle des App Stores konnte keine überprüfte Preisangabe zurückgeben.',
  thai: 'ไม่สามารถโหลดข้อเสนอสมาชิกที่ได้รับการยืนยันจาก App Store สำหรับบัญชีนี้ได้ในขณะนี้ โปรดตรวจสอบการเชื่อมต่อเครือข่ายแล้วลองอีกครั้งในอีกสักครู่',
};

const TRIAL_LABELS: Record<Locale, string> = {
  'de-DE': '7-tägige kostenlose Testversion',
  'fr-FR': 'Essai gratuit de 7 jours',
  'ar-EG': 'إصدار تجريبي مجاني لمدة 7 أيام',
  'hi-IN': '7-दिन का निःशुल्क परीक्षण',
  'ja-JP': '7日間の無料トライアル',
  'pt-BR': 'Teste gratuito de 7 dias',
  'tr-TR': '7 günlük ücretsiz deneme',
  'ru-RU': '7-дневная бесплатная пробная версия',
  'th-TH': 'ทดลองใช้ฟรี 7 วัน',
  'zh-CN': '7天免费试用',
  'en-IN': '7-day free trial',
  'es-419': 'Prueba gratuita de 7 días',
};

function sample(family: StringFamily): string {
  return family === 'empty' ? '' : SAMPLES[family];
}

function priceFor(base: number, cls: PriceClass): number {
  switch (cls) {
    case 'zero':
      return 0;
    case 'negative':
      return -base;
    case 'huge':
      return 1_000_000_000_000_000 + base;
    case 'tiny':
      return 0.001;
    default:
      return base;
  }
}

function formatPrice(value: number, locale: Locale, cls: PriceClass): string {
  if (cls === 'emptyString') return '';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: CURRENCY[locale],
  }).format(value);
}

function plan(
  period: StorePlan['period'],
  base: number,
  v: Variant,
  perMonth: number | null,
): StorePlan {
  const price = priceFor(base, v.priceClass);
  return {
    id: `${period}-plan`,
    productId: `pickle_sensei_pro_${period}`,
    period,
    price,
    priceString: formatPrice(price, v.locale, v.priceClass),
    pricePerMonthString:
      perMonth === null
        ? null
        : formatPrice(priceFor(perMonth, v.priceClass), v.locale, v.priceClass),
    freeTrial:
      period === 'annual' && v.trial !== 'none'
        ? {
            label:
              v.trial === 'short' ? '7-day free trial' : TRIAL_LABELS[v.locale],
            periodIso8601: 'P7D',
          }
        : null,
  };
}

function plansFor(v: Variant): StorePlans | null {
  if (v.planSet === 'unavailable' || v.planSet === 'loading') return null;
  const monthly = plan('monthly', 7.99, v, 7.99);
  const annual = plan('annual', 59.99, v, 5);
  const lifetime = plan('lifetime', 159.99, v, null);
  return {
    offeringId: 'default',
    monthly:
      v.planSet === 'noMonthly' || v.planSet === 'onlyAnnual' ? null : monthly,
    annual: v.planSet === 'noAnnual' ? null : annual,
    lifetime:
      v.planSet === 'noLifetime' || v.planSet === 'onlyAnnual'
        ? null
        : lifetime,
  };
}

function accessFor(v: Variant): CanonicalAccessState | null {
  const make = (
    used: number,
    reserved: number,
    remaining: number,
    premium = false,
  ): CanonicalAccessState => ({
    premium,
    entitlements: premium ? ['pickle_sensei_pro'] : [],
    freeRatings: {
      limit: 2,
      used,
      reserved,
      remaining,
      availableToReserve: Math.max(0, remaining - reserved),
    },
    canStartRating: premium || remaining - reserved > 0,
    paywallRequired: !premium && remaining - reserved <= 0,
  });
  switch (v.access) {
    case 'unverified':
      return null;
    case 'fresh':
      return make(0, 0, 2);
    case 'oneLeft':
      return make(1, 0, 1);
    case 'exhausted':
      return make(2, 0, 0);
    case 'reservedPending':
      return make(0, 1, 2);
    case 'negativeRemaining':
      return make(0, 0, -3);
    case 'hugeUsed':
      return make(Number.MAX_SAFE_INTEGER, 0, 0);
    case 'premium':
      return make(2, 0, 0, true);
  }
}

function errorMessageFor(v: Variant): string | null {
  if (v.error === 'none') return null;
  if (v.error === 'short') return 'Store offer unavailable.';
  const text = sample(v.stringFamily);
  return text.length > 0 ? text : SAMPLES.long200;
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function dependenciesFor(v: Variant): BillingAccessDependencies {
  const plans = plansFor(v);
  const access = accessFor(v);
  const message = errorMessageFor(v);
  const entitlement = { premium: false, productId: null, expirationDate: null };
  return {
    store: {
      configure: async () => undefined,
      loadPlans: async () => {
        if (v.planSet === 'loading') return never<StorePlans>();
        if (!plans) {
          throw new BillingError(
            'billing.offerings_unavailable',
            message ??
              'Membership pricing is unavailable from the app store right now.',
            true,
          );
        }
        return plans;
      },
      purchase: async () => entitlement,
      restore: async () => entitlement,
      readEntitlement: async () => entitlement,
    },
    backend: {
      getAccess: async () => {
        if (v.planSet === 'loading') return never<CanonicalAccessState>();
        if (!access) {
          throw new BillingError(
            'billing.backend_unavailable',
            message ?? 'Membership verification is temporarily unavailable.',
            true,
          );
        }
        if (message && plans) {
          // Both sources succeed but the backend reports a message: surface it
          // as a non-fatal store error after the successful read.
          setTimeout(() => {
            useAccessStore.setState({
              error: {
                code: 'billing.backend_verification_pending',
                message,
                retryable: true,
              },
            });
          }, 0);
        }
        return access;
      },
      syncBilling: async () => {
        throw new Error('not reached');
      },
    },
  };
}

// ─── Environment shaping (font scale, width, RTL, TZ, clock) ─────────────────

const originalTz = process.env.TZ;
const originalIsRtl = I18nManager.isRTL;
let fontScaleSpy: jest.SpyInstance | null = null;
let nowSpy: jest.SpyInstance | null = null;

function applyEnvironment(v: Variant) {
  process.env.TZ = v.timezone;
  const clock = CLOCKS.find(c => c.label === v.clock);
  const instant = Date.parse(clock ? clock.iso : '2026-09-05T00:00:00.000Z');
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(instant);
  fontScaleSpy = jest
    .spyOn(PixelRatio, 'getFontScale')
    .mockReturnValue(v.fontScale);
  Dimensions.set({
    window: { width: v.width, height: 844, scale: 3, fontScale: v.fontScale },
    screen: { width: v.width, height: 844, scale: 3, fontScale: v.fontScale },
  });
  (I18nManager as { isRTL: boolean }).isRTL = v.rtl;
  return {
    tzOffsetMinutes: new Date(instant).getTimezoneOffset(),
    resolvedTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

function restoreEnvironment() {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
  nowSpy?.mockRestore();
  fontScaleSpy?.mockRestore();
  nowSpy = null;
  fontScaleSpy = null;
  Dimensions.set({
    window: { width: 750, height: 1334, scale: 2, fontScale: 2 },
    screen: { width: 750, height: 1334, scale: 2, fontScale: 2 },
  });
  (I18nManager as { isRTL: boolean }).isRTL = originalIsRtl;
}

// ─── Rendered-tree inspection ────────────────────────────────────────────────

type HostStyle = ViewStyle & TextStyle;

function flatten(style: unknown): HostStyle {
  return (StyleSheet.flatten(style as ViewStyle) ?? {}) as HostStyle;
}

function isHost(node: ReactTestInstance, name: string): boolean {
  return typeof node.type === 'string' && node.type === name;
}

function textOf(node: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (child: ReactTestInstance | string) => {
    if (typeof child === 'string') {
      parts.push(child);
      return;
    }
    child.children.forEach(walk);
  };
  node.children.forEach(walk);
  return parts.join('');
}

function paywallRoot(renderer: TestRenderer.ReactTestRenderer) {
  const instances = renderer.root.findAllByType(PaywallScreen);
  return instances[0] ?? null;
}

interface InteractiveRecord {
  testID: string | null;
  role: string | null;
  label: string | null;
  text: string;
  height: number;
  heightSource: 'declared' | 'implied';
  width: number | null;
  disabled: boolean;
  selected: boolean | null;
  violations: string[];
}

function inspectInteractive(root: ReactTestInstance): InteractiveRecord[] {
  const hosts = root.findAll(
    n =>
      isHost(n, 'View') &&
      (n.props.accessible === true ||
        typeof n.props.onClick === 'function' ||
        typeof n.props.onResponderRelease === 'function' ||
        typeof n.props.onStartShouldSetResponder === 'function'),
  );
  return hosts.map(host => {
    const style = flatten(host.props.style);
    const declaredHeight =
      typeof style.height === 'number'
        ? style.height
        : typeof style.minHeight === 'number'
          ? style.minHeight
          : null;
    // Content-driven targets (no height/minHeight): vertical padding plus the
    // tallest single-line Text child at font scale 1 — the smallest the
    // control can be on device.
    const implied = () => {
      const pad = (edge: 'paddingTop' | 'paddingBottom') => {
        const value =
          style[edge] ?? style.paddingVertical ?? style.padding ?? 0;
        return typeof value === 'number' ? value : 0;
      };
      const lineHeights = host
        .findAll(n => isHost(n, 'Text'))
        .map(n => flatten(n.props.style).lineHeight)
        .filter((h): h is number => typeof h === 'number');
      return (
        pad('paddingTop') + pad('paddingBottom') + Math.max(0, ...lineHeights)
      );
    };
    const height = declaredHeight ?? implied();
    const width =
      typeof style.width === 'number'
        ? style.width
        : typeof style.minWidth === 'number'
          ? style.minWidth
          : null;
    const role: string | null = host.props.accessibilityRole ?? null;
    const label: string | null =
      typeof host.props.accessibilityLabel === 'string'
        ? host.props.accessibilityLabel
        : null;
    const text = textOf(host);
    const violations: string[] = [];
    if (!role) violations.push('missing accessibilityRole');
    if (!label || label.trim().length === 0) {
      violations.push('missing accessibilityLabel');
    }
    if (height < MIN_TARGET_PT) {
      violations.push(
        `${declaredHeight === null ? 'implied' : 'declared'} height ${height} < 44`,
      );
    }
    if (width !== null && width < MIN_TARGET_PT) {
      violations.push(`width ${width} < 44`);
    }
    return {
      testID: host.props.testID ?? null,
      role,
      label,
      text,
      height,
      heightSource: declaredHeight === null ? 'implied' : 'declared',
      width,
      disabled: host.props.accessibilityState?.disabled === true,
      selected:
        typeof host.props.accessibilityState?.selected === 'boolean'
          ? host.props.accessibilityState.selected
          : null,
      violations,
    };
  });
}

/** Views that carry a label/role but are not marked `accessible` — on iOS
 * such a label is not a VoiceOver element (RN docs: `accessible` makes the
 * view an accessibility element). Recorded, not asserted (INFERRED). */
function inspectUnreachableLabels(root: ReactTestInstance) {
  return root
    .findAll(
      n =>
        isHost(n, 'View') &&
        n.props.accessible !== true &&
        (typeof n.props.accessibilityLabel === 'string' ||
          typeof n.props.accessibilityRole === 'string'),
    )
    .map(n => ({
      label: n.props.accessibilityLabel ?? null,
      role: n.props.accessibilityRole ?? null,
    }));
}

// Character-width model (em units) — an estimate, not iOS text layout.
function charEm(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp === 0x200d || cp === 0x200c || (cp >= 0xfe00 && cp <= 0xfe0f))
    return 0; // ZWJ / ZWNJ / variation selectors
  if (cp >= 0x0300 && cp <= 0x036f) return 0; // combining diacriticals
  if (cp >= 0x1e00 && cp <= 0x1eff) return 0.55; // Latin extended additional
  if (cp >= 0x0600 && cp <= 0x06ff)
    return cp >= 0x064b && cp <= 0x0652 ? 0 : 0.5;
  if (cp >= 0x0e00 && cp <= 0x0e7f)
    return cp >= 0x0e31 && cp <= 0x0e3a ? 0 : 0.5;
  if (cp >= 0x0900 && cp <= 0x097f)
    return cp >= 0x093a && cp <= 0x094f ? 0 : 0.6;
  if (cp >= 0x0400 && cp <= 0x04ff) return 0.58;
  if (cp >= 0x3000 && cp <= 0x9fff) return 1.0; // CJK
  if (cp >= 0xff00 && cp <= 0xffef) return 1.0; // full-width forms
  if (cp >= 0x1f000) return 1.2; // emoji
  if (ch === ' ') return 0.28;
  if (/[0-9]/.test(ch)) return 0.6;
  if (/[A-Z]/.test(ch)) return 0.66;
  if (/[.,·'’]/.test(ch)) return 0.28;
  return 0.52;
}

function estimateWidth(text: string, fontSize: number, letterSpacing = 0) {
  const chars = Array.from(text);
  let em = 0;
  for (const ch of chars) em += charEm(ch);
  return em * fontSize + Math.max(0, chars.length - 1) * letterSpacing;
}

interface ClipRisk {
  text: string;
  numberOfLines: number;
  fontSize: number;
  effectiveFontSize: number;
  availableWidth: number;
  neededWidth: number;
  container: string;
}

/**
 * Column widths from the paywall's own StyleSheet: content padding 24 each
 * side (max 560), podium gap 8, flex 1 / 1.18 (hero) / 1, card padding 8 +
 * 1.5 border each side. `numberOfLines` texts outside the podium get the
 * full content width.
 */
function layoutModel(v: Variant, root: ReactTestInstance): ClipRisk[] {
  const contentWidth = Math.min(v.width, 560) - 48;
  const columns = root.findAll(
    n =>
      isHost(n, 'View') &&
      typeof n.props.testID === 'string' &&
      n.props.testID.startsWith('paywall-plan-'),
  );
  const heroPresent = columns.some(
    c => c.props.testID === 'paywall-plan-annual',
  );
  const totalFlex = columns.reduce(
    (sum, c) => sum + (c.props.testID === 'paywall-plan-annual' ? 1.18 : 1),
    0,
  );
  const rowInner = contentWidth - Math.max(0, columns.length - 1) * 8;
  const columnInner = (flex: number) =>
    totalFlex > 0 ? (rowInner * flex) / totalFlex - 16 - 3 : contentWidth;
  const risks: ClipRisk[] = [];
  const texts = root.findAll(
    n => isHost(n, 'Text') && typeof n.props.numberOfLines === 'number',
  );
  for (const node of texts) {
    const style = flatten(node.props.style);
    const fontSize = typeof style.fontSize === 'number' ? style.fontSize : 16;
    const letterSpacing =
      typeof style.letterSpacing === 'number' ? style.letterSpacing : 0;
    const lines: number = node.props.numberOfLines;
    const scaled = fontSize * v.fontScale;
    const effective = node.props.adjustsFontSizeToFit
      ? scaled * (node.props.minimumFontScale ?? 0.01)
      : scaled;
    const text = textOf(node);
    if (text.length === 0) continue;
    const column = columns.find(c => c.findAll(t => t === node).length > 0);
    const available = column
      ? columnInner(column.props.testID === 'paywall-plan-annual' ? 1.18 : 1)
      : contentWidth;
    const needed = estimateWidth(text, effective, letterSpacing);
    const capacity = lines === 1 ? available : available * lines * 0.9;
    if (needed > capacity) {
      risks.push({
        text,
        numberOfLines: lines,
        fontSize,
        effectiveFontSize: Number(effective.toFixed(2)),
        availableWidth: Number(available.toFixed(1)),
        neededWidth: Number(needed.toFixed(1)),
        container: column
          ? `${column.props.testID}${heroPresent ? '' : ' (no hero)'}`
          : 'content',
      });
    }
  }
  return risks;
}

/** The hero "BEST VALUE" pill is absolutely positioned across the column: if
 * its intrinsic width exceeds the column it overlaps the neighbours. */
function overlapModel(v: Variant, root: ReactTestInstance) {
  const hero = root.findAll(
    n => isHost(n, 'View') && n.props.testID === 'paywall-plan-annual',
  )[0];
  if (!hero) return [];
  const pillText = hero.findAll(
    n => isHost(n, 'Text') && textOf(n) === 'BEST VALUE',
  )[0];
  if (!pillText) return [];
  const style = flatten(pillText.props.style);
  const fontSize = typeof style.fontSize === 'number' ? style.fontSize : 10;
  const letterSpacing =
    typeof style.letterSpacing === 'number' ? style.letterSpacing : 0;
  const columns = root.findAll(
    n =>
      isHost(n, 'View') &&
      typeof n.props.testID === 'string' &&
      n.props.testID.startsWith('paywall-plan-'),
  ).length;
  const contentWidth = Math.min(v.width, 560) - 48;
  const totalFlex = 1.18 + (columns - 1);
  const columnWidth = ((contentWidth - (columns - 1) * 8) * 1.18) / totalFlex;
  const pillWidth =
    estimateWidth('BEST VALUE', fontSize * v.fontScale, letterSpacing) + 20;
  return pillWidth > columnWidth
    ? [
        {
          element: 'hero badge pill',
          pillWidth: Number(pillWidth.toFixed(1)),
          columnWidth: Number(columnWidth.toFixed(1)),
        },
      ]
    : [];
}

function visibleStrings(root: ReactTestInstance): string[] {
  return root
    .findAll(n => isHost(n, 'Text'))
    .map(textOf)
    .filter(s => s.length > 0);
}

// ─── Mounting ────────────────────────────────────────────────────────────────

async function flush() {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
}

interface Mounted {
  renderer: TestRenderer.ReactTestRenderer;
  onClose: jest.Mock;
  onPurchased: jest.Mock;
}

async function mount(v: Variant): Promise<Mounted> {
  const onClose = jest.fn();
  const onPurchased = jest.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  const metrics = {
    frame: { x: 0, y: 0, width: v.width, height: 844 },
    insets: { top: 47, bottom: 34, left: 0, right: 0 },
  };
  if (v.mount === 'navigator') {
    await act(async () => {
      renderer = TestRenderer.create(
        <SafeAreaProvider initialMetrics={metrics}>
          <RootNavigator />
        </SafeAreaProvider>,
      );
    });
  } else {
    const legal: Partial<PaywallScreenProps> =
      v.legal === 'both'
        ? { onOpenTerms: jest.fn(), onOpenPrivacy: jest.fn() }
        : v.legal === 'termsOnly'
          ? { onOpenTerms: jest.fn(), onOpenPrivacy: undefined }
          : v.legal === 'nullBoth'
            ? ({
                onOpenTerms: null,
                onOpenPrivacy: null,
              } as unknown as Partial<PaywallScreenProps>)
            : {};
    const purchased: Partial<PaywallScreenProps> =
      v.legal === 'nullBoth'
        ? ({ onPurchased: null } as unknown as Partial<PaywallScreenProps>)
        : v.legal === 'none'
          ? {}
          : { onPurchased };
    await act(async () => {
      renderer = TestRenderer.create(
        <SafeAreaProvider initialMetrics={metrics}>
          <PaywallScreen onClose={onClose} {...purchased} {...legal} />
        </SafeAreaProvider>,
      );
    });
  }
  await flush();
  await flush();
  return { renderer, onClose, onPurchased };
}

function pressHost(root: ReactTestInstance, testID: string) {
  const host = root.findAll(
    n => isHost(n, 'View') && n.props.testID === testID,
  )[0];
  if (!host) throw new Error(`no host with testID ${testID}`);
  host.props.onClick();
}

function hostByTestId(root: ReactTestInstance, testID: string) {
  return root.findAll(n => isHost(n, 'View') && n.props.testID === testID)[0];
}

function hostByLabel(root: ReactTestInstance, label: string) {
  return root.findAll(
    n => isHost(n, 'View') && n.props.accessibilityLabel === label,
  )[0];
}

// ─── Result table ────────────────────────────────────────────────────────────

interface Row {
  index: number;
  seed: number;
  replay: string;
  variant: Omit<Variant, 'index' | 'seed'>;
  environment: { tzOffsetMinutes: number; resolvedTimeZone: string };
  outcome: 'pass' | 'fail';
  failures: string[];
  interactive: InteractiveRecord[];
  visibleStringCount: number;
  longestVisibleString: number;
  savingsChip: string | null;
  purchaseLabel: string | null;
  clipRisks: ClipRisk[];
  overlapRisks: ReturnType<typeof overlapModel>;
  unreachableLabels: ReturnType<typeof inspectUnreachableLabels>;
  consoleErrors: string[];
  durationMs: number;
}

const rows: Row[] = [];

const LEAK = /\b(undefined|null|NaN|\[object Object\])\b/;

async function runVariant(v: Variant): Promise<Row> {
  const started = Date.now();
  const failures: string[] = [];
  const consoleErrors: string[] = [];
  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(
        args
          .map(a => String(a))
          .join(' ')
          .slice(0, 300),
      );
    });
  const environment = applyEnvironment(v);
  configureAccessStore(dependenciesFor(v));
  let interactive: InteractiveRecord[] = [];
  let strings: string[] = [];
  let clipRisks: ClipRisk[] = [];
  let overlapRisks: ReturnType<typeof overlapModel> = [];
  let unreachableLabels: ReturnType<typeof inspectUnreachableLabels> = [];
  let mounted: Mounted | null = null;
  try {
    mounted = await mount(v);
    const { renderer } = mounted;
    const screen = paywallRoot(renderer);
    if (!screen) throw new Error('PaywallScreen did not mount');
    const premium = v.access === 'premium' && v.planSet !== 'loading';

    if (!premium && v.page === 'pricing') {
      await act(async () => pressHost(screen, 'paywall-see-plans'));
      await flush();
    }

    // Snapshot inspection on the requested page.
    interactive = inspectInteractive(screen);
    strings = visibleStrings(screen);
    clipRisks = layoutModel(v, screen);
    overlapRisks = overlapModel(v, screen);
    unreachableLabels = inspectUnreachableLabels(screen);

    for (const record of interactive) {
      for (const violation of record.violations) {
        failures.push(
          `a11y: ${record.testID ?? record.label ?? record.text}: ${violation}`,
        );
      }
    }
    for (const s of strings) {
      if (LEAK.test(s))
        failures.push(`leak: ${JSON.stringify(s.slice(0, 80))}`);
    }

    // Page markers.
    if (premium) {
      if (!hostByLabel(screen, 'Continue coaching')) {
        failures.push('premium page: "Continue coaching" missing');
      }
    } else if (v.page === 'pricing') {
      if (!hostByTestId(screen, 'paywall-continue')) {
        failures.push('pricing page: purchase CTA missing');
      }
      if (!hostByTestId(screen, 'paywall-restore')) {
        failures.push('pricing page: restore missing');
      }
      const plans = plansFor(v);
      const expectedCards = plans
        ? (['monthly', 'annual', 'lifetime'] as const).filter(p => plans[p])
        : [];
      for (const period of expectedCards) {
        if (!hostByTestId(screen, `paywall-plan-${period}`)) {
          failures.push(`pricing page: plan card ${period} missing`);
        }
      }
      if (v.planSet === 'loading') {
        if (!hostByLabel(screen, 'Loading App Store pricing')) {
          failures.push('loading state: progressbar missing');
        }
      }
      if (
        v.planSet !== 'loading' &&
        (v.planSet === 'unavailable' || v.access === 'unverified')
      ) {
        if (!hostByTestId(screen, 'paywall-retry')) {
          failures.push('unavailable state: retry missing');
        }
      }
      const message = errorMessageFor(v);
      if (message && v.planSet !== 'loading') {
        const dismiss = hostByLabel(screen, 'Dismiss membership message');
        if (!dismiss) failures.push('error card missing');
        else if (!strings.some(s => s === message)) {
          failures.push('error message text not rendered verbatim');
        }
      }

      // Interactions: select every card, verify selection state + label.
      for (const period of expectedCards) {
        await act(async () => pressHost(screen, `paywall-plan-${period}`));
        await flush();
        const card = hostByTestId(screen, `paywall-plan-${period}`);
        if (!card) {
          failures.push(`card ${period} vanished after press`);
          continue;
        }
        if (card.props.accessibilityState?.selected !== true) {
          failures.push(`card ${period} not selected after press`);
        }
        if (!String(card.props.accessibilityLabel).endsWith(', selected')) {
          failures.push(`card ${period} label lacks ", selected"`);
        }
        if (useAccessStore.getState().selectedPeriod !== period) {
          failures.push(`store selectedPeriod != ${period} after press`);
        }
      }
      // Dismiss the error card if present.
      const dismiss = hostByLabel(screen, 'Dismiss membership message');
      if (dismiss) {
        await act(async () => dismiss.props.onClick());
        await flush();
        if (hostByLabel(screen, 'Dismiss membership message')) {
          failures.push('error card did not dismiss');
        }
      }
      // Back to value page.
      await act(async () => pressHost(screen, 'paywall-back'));
      await flush();
      if (!hostByTestId(screen, 'paywall-see-plans')) {
        failures.push('back did not return to the value page');
      }
    } else if (!hostByTestId(screen, 'paywall-see-plans')) {
      failures.push('value page: "See membership plans" missing');
    }

    // Close.
    const closeLabel = premium ? 'Close membership' : 'Close membership offer';
    const close = hostByLabel(screen, closeLabel);
    if (!close) failures.push(`close button "${closeLabel}" missing`);
    else {
      await act(async () => close.props.onClick());
      await flush();
      if (v.mount === 'navigator') {
        if (paywallRoot(renderer)) {
          failures.push('navigator: Paywall route still mounted after close');
        } else if (
          !renderer.root
            .findAllByType(Text)
            .some(t => t.props.children === '[HomeScreen]')
        ) {
          failures.push('navigator: Home not visible after close');
        }
      } else if (mounted.onClose.mock.calls.length !== 1) {
        failures.push(
          `direct: onClose called ${mounted.onClose.mock.calls.length}×`,
        );
      }
    }
  } catch (error) {
    failures.push(
      `threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  } finally {
    if (mounted) {
      const { renderer } = mounted;
      await act(async () => renderer.unmount());
    }
    clearAccessStoreConfiguration();
    restoreEnvironment();
    errorSpy.mockRestore();
  }
  const relevantConsoleErrors = consoleErrors.filter(
    // react-test-renderer's own deprecation banner is not a screen defect.
    m => !m.includes('react-test-renderer is deprecated'),
  );
  for (const m of relevantConsoleErrors) failures.push(`console.error: ${m}`);
  const { index, seed, ...variant } = v;
  return {
    index,
    seed,
    replay: `STRESS_SEED=${STRESS_SEED} STRESS_ONLY=${index} npx jest --ci __tests__/stress/paywallScreenBoundaryI18nA11y.stress.test.tsx`,
    variant,
    environment,
    outcome: failures.length === 0 ? 'pass' : 'fail',
    failures,
    interactive,
    visibleStringCount: strings.length,
    longestVisibleString: strings.reduce((m, s) => Math.max(m, s.length), 0),
    savingsChip: strings.find(s => s.startsWith('SAVE ')) ?? null,
    purchaseLabel:
      interactive.find(i => i.testID === 'paywall-continue')?.label ?? null,
    clipRisks,
    overlapRisks,
    unreachableLabels,
    consoleErrors: relevantConsoleErrors,
    durationMs: Date.now() - started,
  };
}

// ─── Campaign ────────────────────────────────────────────────────────────────

const indices =
  STRESS_ONLY.length > 0
    ? STRESS_ONLY
    : Array.from({ length: STRESS_ITER }, (_, i) => i);

afterAll(() => {
  const summary = {
    seed: STRESS_SEED,
    iterations: rows.length,
    passed: rows.filter(r => r.outcome === 'pass').length,
    failed: rows.filter(r => r.outcome === 'fail').length,
    variantsWithClipRisk: rows.filter(r => r.clipRisks.length > 0).length,
    variantsWithOverlapRisk: rows.filter(r => r.overlapRisks.length > 0).length,
    interactiveElementsInspected: rows.reduce(
      (n, r) => n + r.interactive.length,
      0,
    ),
    coverage: {
      locales: [...new Set(rows.map(r => r.variant.locale))].sort(),
      timezones: [...new Set(rows.map(r => r.variant.timezone))].sort(),
      fontScales: [...new Set(rows.map(r => r.variant.fontScale))].sort(),
      widths: [...new Set(rows.map(r => r.variant.width))].sort(),
      stringFamilies: [
        ...new Set(rows.map(r => r.variant.stringFamily)),
      ].sort(),
      priceClasses: [...new Set(rows.map(r => r.variant.priceClass))].sort(),
      planSets: [...new Set(rows.map(r => r.variant.planSet))].sort(),
      accessClasses: [...new Set(rows.map(r => r.variant.access))].sort(),
      mounts: [...new Set(rows.map(r => r.variant.mount))].sort(),
      pages: [...new Set(rows.map(r => r.variant.page))].sort(),
    },
    note: 'Linux/jest rendered-tree evidence. clipRisks/overlapRisks/unreachableLabels come from a character-width model and RN accessibility semantics (INFERRED), not from iOS text layout.',
    rows,
  };
  fs.mkdirSync(path.dirname(STRESS_OUT), { recursive: true });
  fs.writeFileSync(STRESS_OUT, JSON.stringify(summary, null, 2));
});

describe(`PaywallScreen boundary/i18n/a11y stress (seed ${STRESS_SEED}, ${indices.length} variants)`, () => {
  test.each(indices)(
    'variant %i renders, is accessible and survives interaction',
    async index => {
      const v = variantFor(index);
      const row = await runVariant(v);
      rows.push(row);
      expect({
        replay: row.replay,
        variant: row.variant,
        failures: row.failures,
      }).toEqual({ replay: row.replay, variant: row.variant, failures: [] });
    },
  );

  if (indices.length >= 150) {
    test('campaign covers every locale, timezone, font scale and width', () => {
      const v = indices.map(variantFor);
      expect(new Set(v.map(x => x.locale)).size).toBe(LOCALES.length);
      expect(new Set(v.map(x => x.timezone)).size).toBe(TIMEZONES.length);
      expect(new Set(v.map(x => x.fontScale)).size).toBe(FONT_SCALES.length);
      expect(new Set(v.map(x => x.width)).size).toBe(WIDTHS.length);
      expect(new Set(v.map(x => `${x.fontScale}x${x.width}`)).size).toBe(
        FONT_SCALES.length * WIDTHS.length,
      );
      expect(new Set(v.map(x => x.stringFamily)).size).toBe(
        STRING_FAMILIES.length,
      );
      expect(new Set(v.map(x => x.priceClass)).size).toBe(PRICE_CLASSES.length);
    });
  }
});

describe('PaywallScreen invariants across the lens axes', () => {
  // The screen has no date/time output: the rendered strings must be
  // byte-identical under every timezone / DST-edge clock.
  test('rendered copy is timezone- and clock-invariant', async () => {
    const base = variantFor(0);
    const snapshots: string[] = [];
    for (const timezone of TIMEZONES) {
      for (const clock of CLOCKS) {
        const v: Variant = {
          ...base,
          mount: 'direct',
          page: 'pricing',
          timezone,
          clock: clock.label,
          planSet: 'all',
          access: 'oneLeft',
          error: 'none',
          priceClass: 'normal',
          trial: 'short',
        };
        applyEnvironment(v);
        configureAccessStore(dependenciesFor(v));
        const { renderer } = await mount(v);
        const screen = paywallRoot(renderer);
        if (!screen) throw new Error('no screen');
        await act(async () => pressHost(screen, 'paywall-see-plans'));
        await flush();
        snapshots.push(visibleStrings(screen).join('\u241f'));
        await act(async () => renderer.unmount());
        clearAccessStoreConfiguration();
        restoreEnvironment();
      }
    }
    expect(snapshots.length).toBe(TIMEZONES.length * CLOCKS.length);
    expect(new Set(snapshots).size).toBe(1);
  });

  // Locale only enters through store-formatted strings; with identical plan
  // strings the screen's own copy must not depend on the process locale/RTL.
  test('screen copy is identical across all 12 locales and RTL', async () => {
    const snapshots: string[] = [];
    for (const locale of LOCALES) {
      const v: Variant = {
        ...variantFor(1),
        mount: 'direct',
        page: 'pricing',
        locale,
        rtl: locale === 'ar-EG',
        planSet: 'all',
        access: 'fresh',
        error: 'none',
        priceClass: 'normal',
        trial: 'none',
      };
      applyEnvironment(v);
      // Force the same price strings for every locale so only the screen's
      // own copy can differ.
      const deps = dependenciesFor({ ...v, locale: 'en-IN' });
      configureAccessStore(deps);
      const { renderer } = await mount(v);
      const screen = paywallRoot(renderer);
      if (!screen) throw new Error('no screen');
      await act(async () => pressHost(screen, 'paywall-see-plans'));
      await flush();
      snapshots.push(visibleStrings(screen).join('\u241f'));
      await act(async () => renderer.unmount());
      clearAccessStoreConfiguration();
      restoreEnvironment();
    }
    expect(snapshots.length).toBe(LOCALES.length);
    expect(new Set(snapshots).size).toBe(1);
  });
});
