/**
 * STRESS — ConsentSettingsScreen · lens `boundary-i18n-a11y`.
 *
 * Renders the REAL screen inside the REAL `NavigationContainer` +
 * `createNativeStackNavigator` route the app registers (`ConsentSettings`),
 * with the REAL auth / api-session / consent zustand stores. Only native
 * modules (safe-area, sqlite) and `fetch` are mocked.
 *
 * Every variant is derived from ONE 32-bit seed (mulberry32) and is fully
 * replayable:
 *
 *   STRESS_SEED=<seed> npx jest --ci __tests__/stress/consentSettingsScreen.boundary-i18n-a11y.stress.test.tsx
 *
 * Campaign size / output:
 *
 *   STRESS_ITER=<n>        variants to run (default 60 — fast enough for CI)
 *   STRESS_BASE_SEED=<n>   first seed (default 1)
 *   STRESS_OUT=<dir>       write `results.json` (seed → outcome table) and
 *                          rendered-tree evidence for flagged variants
 *
 * Axes per variant: width ∈ {320, 390, 430} × fontScale ∈ {1, 1.35, 3.12},
 * 12 locales (ar-EG drives RTL), 8 IANA zones (UTC+14, UTC−12, DST edges,
 * 30/45-minute offsets), a boundary-string corpus (200+ chars, CJK, Arabic
 * RTL, ZWJ emoji, combining marks, German compounds, Thai, Devanagari,
 * Turkish, control chars, empty/whitespace/null-ish/numeric strings), a
 * boundary-instant corpus (epoch 0, negative, max Date, DST edges, invalid,
 * huge numeric strings) and 14 flow scenarios (signed-out, ready on/off,
 * grant/withdraw, failing toggle, HTTP/network/invalid-payload failures,
 * pending fetch = loading/busy, stale session mid-flight, injected error
 * copy).
 *
 * Invariants asserted on every variant (BROKEN = test failure):
 *   A1 every host pressable has accessibilityRole + non-empty label
 *   A2 every host pressable has a statically provable target ≥ 44×44pt
 *      (own style box + hitSlop); un-measurable targets are reported, not
 *      passed
 *   A3 toggle `accessibilityState.checked` mirrors the store; toggle is
 *      disabled exactly when busy || availability !== 'ready'
 *   A4 no Text renders 'undefined' / 'null' / 'NaN' / '[object Object]'
 *   A5 no `allowFontScaling={false}` and no `maxFontSizeMultiplier` < 1.35
 *   A6 rendered static copy has no forbidden store terms
 *      (APP_STORE_SUBMISSION.md)
 *   A7 no React/RN console.error during render or interaction
 *   A8 store: modelTrainingActive is false unless the server said true;
 *      lastActionAt is preserved verbatim and formats in the variant's
 *      locale+zone when it is a valid instant
 *   A9 Back pops to the previous route; Connect account navigates to
 *      ConnectAccount; Try again re-fetches; the toggle POSTs the correct
 *      grant/withdraw body
 *
 * Heuristic layout flags (recorded in results.json, never fail the run —
 * Jest has no layout engine, so these are ESTIMATES): single-line texts
 * whose estimated width at the variant's fontScale exceeds the available
 * width (`numberOfLines={1}` → truncation), fixed-height containers holding
 * text, and absolutely-positioned text (overlap risk).
 */
import React from 'react';
import {
  AccessibilityInfo,
  Dimensions,
  I18nManager,
  PixelRatio,
  StyleSheet,
  Text,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import {
  NavigationContainer,
  createNavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import * as fs from 'node:fs';
import * as path from 'node:path';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('react-native-safe-area-context', () => {
  const mock = jest.requireActual('react-native-safe-area-context/jest/mock');
  return mock.default ?? mock;
});

import { ConsentSettingsScreen } from '../../src/screens/ConsentSettingsScreen';
import type { RootStackParams } from '../../src/navigation/params';
import { useConsentStore } from '../../src/state/consentStore';
import { useAuthStore } from '../../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';

// ─────────────────────────────────────────────────────────────────────────────
// Seeded RNG
// ─────────────────────────────────────────────────────────────────────────────

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

function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('pick: empty corpus');
  return item;
}

// ─────────────────────────────────────────────────────────────────────────────
// Corpora
// ─────────────────────────────────────────────────────────────────────────────

const WIDTHS = [320, 390, 430] as const;
const HEIGHTS: Record<(typeof WIDTHS)[number], number> = {
  320: 568,
  390: 844,
  430: 932,
};
const FONT_SCALES = [1, 1.35, 3.12] as const;

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

const TIME_ZONES = [
  'Pacific/Kiritimati', // UTC+14
  'Etc/GMT+12', // UTC−12
  'America/New_York', // DST spring/fall edges
  'Europe/Berlin', // EU DST edges
  'Australia/Lord_Howe', // 30-minute DST shift
  'Pacific/Chatham', // +12:45 / +13:45
  'Asia/Kolkata', // +05:30, no DST
  'UTC',
] as const;

const REPEAT = (s: string, n: number) =>
  Array.from({ length: n }, () => s).join('');

const STRINGS = {
  ascii260: REPEAT('Consent settings are temporarily unavailable. ', 6), // 276
  cjk220: REPEAT('同意設定は一時的に利用できません。', 13), // 221 chars, no spaces
  arabicRtl: REPEAT('\u202Bإعدادات الموافقة غير متاحة مؤقتًا. ', 6) + '\u202C',
  bidiMixed: 'خطأ 42: الرمز ABC-123 غير صالح \u200Fتواصل مع الدعم\u200E ok',
  zwjEmoji: REPEAT('👨‍👩‍👧‍👦🏳️‍🌈👩🏽‍🚀🧑🏿‍🤝‍🧑🏻', 12),
  combining: REPEAT(
    'Z\u0351\u036B\u0343A\u0339\u036BL\u0349\u036BG\u0325O\u035C',
    8,
  ),
  german:
    'Donaudampfschifffahrtselektrizitätenhauptbetriebswerkbauunterbeamtengesellschaft Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz',
  thaiNoSpaces: REPEAT('การตั้งค่าความยินยอมไม่พร้อมใช้งานชั่วคราว', 5),
  devanagari: REPEAT('सहमति सेटिंग्स अस्थायी रूप से अनुपलब्ध हैं। ', 5),
  turkishDottedI: 'İzin ayarları geçici olarak kullanılamıyor. ıIİi',
  controlChars: 'line1\nline2\ttab\r\nline3\u0000nul\u200Bzwsp\uFEFFbom',
  empty: '',
  whitespace: '   \u00A0\u2003  ',
  numericZero: '0',
  numericNegative: '-1',
  numericHuge: '1e308',
  numericMaxSafe: String(Number.MAX_SAFE_INTEGER),
  nanLiteral: 'NaN',
  undefinedLiteral: 'undefined',
  nullLiteral: 'null',
} as const;
type StringId = keyof typeof STRINGS;
const STRING_IDS = Object.keys(STRINGS) as StringId[];

const INSTANTS = {
  epoch0: '1970-01-01T00:00:00.000Z',
  negativeEpoch: '1899-12-31T23:59:59.000Z',
  maxDate: '+275760-09-13T00:00:00.000Z',
  beyondMaxDate: '+275760-09-13T00:00:00.001Z', // invalid Date
  usSpringForward: '2026-03-08T07:00:00.000Z', // 02:00 → 03:00 America/New_York
  usFallBack: '2026-11-01T06:00:00.000Z', // second 01:00 America/New_York
  euSpringForward: '2026-03-29T01:00:00.000Z',
  lordHoweShift: '2026-10-03T15:00:00.000Z',
  chatham: '2026-04-05T14:45:00.000Z',
  kiritimatiNewYear: '2025-12-31T10:00:00.000Z', // already 2026 at UTC+14
  gmtMinus12: '2026-01-01T11:59:59.999Z',
  notADate: 'not-a-date',
  emptyString: '',
  hugeNumericString: '99999999999999999999',
  negativeNumericString: '-1',
  zeroString: '0',
  nullValue: null,
} as const;
type InstantId = keyof typeof INSTANTS;
const INSTANT_IDS = Object.keys(INSTANTS) as InstantId[];

const SCENARIOS = [
  'signed_out',
  'ready_off',
  'ready_on',
  'ready_toggle_grant',
  'ready_toggle_withdraw',
  'ready_toggle_fails',
  'unavailable_http',
  'unavailable_network',
  'unavailable_invalid_payload',
  'loading_pending',
  'busy_pending',
  'stale_session_midflight',
  'sign_out_while_ready',
  'sign_in_while_signed_out',
  'double_tap_toggle',
  'leave_while_loading',
  'injected_error_ready',
  'injected_error_unavailable',
] as const;
type Scenario = (typeof SCENARIOS)[number];

const FORBIDDEN_COPY =
  /android|google play|guest mode|live court|dupr|swingvision|pb vision|selkirk|joola|\d+\s?% accur/i;

// ─────────────────────────────────────────────────────────────────────────────
// Variant derivation (pure function of the seed)
// ─────────────────────────────────────────────────────────────────────────────

interface Variant {
  seed: number;
  scenario: Scenario;
  width: (typeof WIDTHS)[number];
  height: number;
  fontScale: (typeof FONT_SCALES)[number];
  locale: (typeof LOCALES)[number];
  rtl: boolean;
  timeZone: (typeof TIME_ZONES)[number];
  stringId: StringId;
  instantId: InstantId;
  /** Server-reported model_training.active for ready scenarios. */
  serverActive: boolean;
}

function deriveVariant(seed: number): Variant {
  const rng = mulberry32(seed);
  const locale = pick(rng, LOCALES);
  const width = pick(rng, WIDTHS);
  return {
    seed,
    scenario: pick(rng, SCENARIOS),
    width,
    height: HEIGHTS[width],
    fontScale: pick(rng, FONT_SCALES),
    locale,
    rtl: locale.startsWith('ar'),
    timeZone: pick(rng, TIME_ZONES),
    stringId: pick(rng, STRING_IDS),
    instantId: pick(rng, INSTANT_IDS),
    serverActive: rng() < 0.5,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch double (the only network boundary)
// ─────────────────────────────────────────────────────────────────────────────

type FetchCall = { url: string; method: string; body: unknown };

interface FetchPlan {
  status: (call: FetchCall) => Promise<FakeResponse> | FakeResponse;
}
interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function jsonResponse(status: number, payload: unknown): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function consentPayload(
  v: Variant,
  active: boolean,
  lastAction: 'granted' | 'withdrawn' | null,
) {
  return {
    subjectPseudonym: STRINGS[v.stringId] || null,
    scopes: [
      {
        scope: 'video_analysis',
        active: true,
        consentVersion: 'video-analysis-v1',
        lastAction: 'granted',
        lastActionAt: INSTANTS.epoch0,
      },
      {
        scope: 'model_training',
        active,
        consentVersion: STRINGS[v.stringId] || null,
        lastAction,
        lastActionAt: INSTANTS[v.instantId],
      },
    ],
  };
}

function invalidPayload(v: Variant): unknown {
  const rng = mulberry32(v.seed ^ 0x9e3779b9);
  const kind = Math.floor(rng() * 6);
  switch (kind) {
    case 0:
      return null;
    case 1:
      return { scopes: 'nope' };
    case 2:
      return { subjectPseudonym: 12345, scopes: [] };
    case 3:
      return {
        subjectPseudonym: null,
        scopes: [{ scope: 'model_training', active: 1 }],
      };
    case 4:
      return {
        subjectPseudonym: null,
        scopes: [{ scope: 'model_training', active: 'true', lastActionAt: -1 }],
      };
    default:
      return {
        subjectPseudonym: null,
        scopes: [{ scope: 'unknown_scope', active: true }],
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tree inspection helpers
// ─────────────────────────────────────────────────────────────────────────────

type Style = ViewStyle & TextStyle;

function flat(style: unknown): Style {
  return (StyleSheet.flatten(style as ViewStyle) ?? {}) as Style;
}

function isHost(node: ReactTestInstance): boolean {
  return typeof node.type === 'string';
}

function hostType(node: ReactTestInstance): string | null {
  return typeof node.type === 'string' ? node.type : null;
}

function hostPressables(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll(
    n =>
      isHost(n) &&
      typeof n.props.onClick === 'function' &&
      n.props.accessible === true,
  );
}

function textContent(node: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (child: unknown) => {
    if (child === null || child === undefined || typeof child === 'boolean')
      return;
    if (typeof child === 'string' || typeof child === 'number') {
      parts.push(String(child));
      return;
    }
    if (Array.isArray(child)) child.forEach(walk);
  };
  walk(node.props.children);
  return parts.join('');
}

function hostTexts(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll(n => hostType(n) === 'Text');
}

function hitSlopInsets(hitSlop: unknown): { v: number; h: number } {
  if (typeof hitSlop === 'number') return { v: hitSlop * 2, h: hitSlop * 2 };
  if (hitSlop && typeof hitSlop === 'object') {
    const s = hitSlop as {
      top?: number;
      bottom?: number;
      left?: number;
      right?: number;
    };
    return {
      v: (s.top ?? 0) + (s.bottom ?? 0),
      h: (s.left ?? 0) + (s.right ?? 0),
    };
  }
  return { v: 0, h: 0 };
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Statically provable minimum target box: own explicit height/minHeight and
 * width/minWidth plus hitSlop. When an axis has no explicit size, the
 * horizontal padding of the first descendant content View that holds a
 * Text is a lower bound (padding + non-empty label ≥ padding). `null` when
 * the axis depends entirely on layout. */
function provableTarget(node: ReactTestInstance): {
  w: number | null;
  h: number | null;
} {
  const s = flat(node.props.style);
  const slop = hitSlopInsets(node.props.hitSlop);
  let h = num(s.height) ?? num(s.minHeight);
  let w = num(s.width) ?? num(s.minWidth);
  if (h === null || w === null) {
    for (const child of node.findAll(
      n => hostType(n) === 'View' && n !== node,
    )) {
      if (
        !child.findAll(
          n => hostType(n) === 'Text' && textContent(n).trim().length > 0,
        ).length
      )
        continue;
      const cs = flat(child.props.style);
      if (h === null) h = num(cs.height) ?? num(cs.minHeight);
      if (w === null) {
        const pad = num(cs.paddingHorizontal) ?? num(cs.padding);
        const pl = num(cs.paddingLeft) ?? pad;
        const pr = num(cs.paddingRight) ?? pad;
        if (pl !== null && pr !== null) w = pl + pr;
      }
      break;
    }
  }
  return {
    h: h === null ? null : h + slop.v,
    w: w === null ? null : w + slop.h,
  };
}

function describe_(node: ReactTestInstance): string {
  const { style, ...rest } = node.props;
  delete rest.children;
  const props = Object.fromEntries(
    Object.entries(rest).map(([k, v]) => [
      k,
      typeof v === 'function' ? 'fn' : v,
    ]),
  );
  return `${String(node.type)} ${JSON.stringify(props)} style=${JSON.stringify(flat(style))}`;
}

/** Compact rendered tree (host nodes only) for evidence files. */
function dumpTree(
  node: ReactTestInstance,
  depth = 0,
  out: string[] = [],
): string[] {
  if (isHost(node)) {
    const s = flat(node.props.style);
    const bits: string[] = [String(node.type)];
    if (node.props.accessibilityRole)
      bits.push(`role=${node.props.accessibilityRole}`);
    if (node.props.accessibilityLabel)
      bits.push(`label=${JSON.stringify(node.props.accessibilityLabel)}`);
    if (node.props.accessibilityState)
      bits.push(`state=${JSON.stringify(node.props.accessibilityState)}`);
    if (node.props.hitSlop !== undefined)
      bits.push(`hitSlop=${JSON.stringify(node.props.hitSlop)}`);
    if (node.props.numberOfLines !== undefined)
      bits.push(`numberOfLines=${node.props.numberOfLines}`);
    if (node.props.allowFontScaling !== undefined)
      bits.push(`allowFontScaling=${node.props.allowFontScaling}`);
    const keep: (keyof Style)[] = [
      'width',
      'height',
      'minHeight',
      'minWidth',
      'maxWidth',
      'overflow',
      'position',
      'flexDirection',
      'flex',
      'fontSize',
      'lineHeight',
      'padding',
      'paddingHorizontal',
      'paddingVertical',
      'marginTop',
      'gap',
      'alignItems',
      'justifyContent',
    ];
    const kept: Record<string, unknown> = {};
    for (const k of keep) if (s[k] !== undefined) kept[k] = s[k];
    if (Object.keys(kept).length) bits.push(`style=${JSON.stringify(kept)}`);
    if (hostType(node) === 'Text')
      bits.push(`text=${JSON.stringify(textContent(node).slice(0, 120))}`);
    out.push(`${'  '.repeat(depth)}${bits.join(' ')}`);
  }
  for (const child of node.children) {
    if (typeof child === 'string') continue;
    dumpTree(child, isHost(node) ? depth + 1 : depth, out);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment doubles per variant (dimensions, font scale, RTL)
// ─────────────────────────────────────────────────────────────────────────────

const realDimensionsGet = Dimensions.get.bind(Dimensions);
const realGetFontScale = PixelRatio.getFontScale.bind(PixelRatio);
const realIsRtl = Object.getOwnPropertyDescriptor(I18nManager, 'isRTL');

function installEnvironment(v: Variant) {
  jest.spyOn(Dimensions, 'get').mockImplementation(dim => ({
    ...realDimensionsGet(dim),
    width: v.width,
    height: v.height,
    fontScale: v.fontScale,
    scale: 3,
  }));
  jest.spyOn(PixelRatio, 'getFontScale').mockImplementation(() => v.fontScale);
  Object.defineProperty(I18nManager, 'isRTL', {
    configurable: true,
    value: v.rtl,
  });
}

function restoreEnvironment() {
  jest.restoreAllMocks();
  if (realIsRtl) Object.defineProperty(I18nManager, 'isRTL', realIsRtl);
  else delete (I18nManager as unknown as Record<string, unknown>).isRTL;
  void realGetFontScale;
}

// ─────────────────────────────────────────────────────────────────────────────
// Real navigator around the real screen
// ─────────────────────────────────────────────────────────────────────────────

const Stack = createNativeStackNavigator<RootStackParams>();
const navigationRef = createNavigationContainerRef<RootStackParams>();

function TabsProbe() {
  return <Text testID="probe-tabs">probe:Tabs</Text>;
}
function ConnectAccountProbe() {
  return <Text testID="probe-connect">probe:ConnectAccount</Text>;
}

function Harness() {
  return (
    <NavigationContainer ref={navigationRef}>
      <Stack.Navigator
        initialRouteName="Tabs"
        screenOptions={{ headerShown: false }}
      >
        <Stack.Screen name="Tabs" component={TabsProbe} />
        <Stack.Screen
          name="ConsentSettings"
          component={ConsentSettingsScreen}
          options={{ title: 'Data & Consent' }}
        />
        <Stack.Screen name="ConnectAccount" component={ConnectAccountProbe} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

async function flush(renderer: TestRenderer.ReactTestRenderer, rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  void renderer;
}

const SESSION = {
  apiBaseUrl: 'https://api.test.invalid',
  bearerToken: 'test-bearer',
  canonicalAppUserId: '00000000-0000-4000-8000-000000000001',
  provider: 'apple' as const,
};

function resetStores() {
  clearApiSession();
  useAuthStore.setState({ session: null });
  useConsentStore.setState({
    availability: 'loading',
    modelTrainingActive: false,
    lastActionAt: null,
    busy: false,
    error: null,
  });
}

function signIn() {
  establishApiSession(SESSION);
  useAuthStore.setState({
    session: {
      provider: 'apple',
      subject: SESSION.canonicalAppUserId,
      canonicalAppUserId: SESSION.canonicalAppUserId,
      localOnly: false,
      displayName: null,
      email: null,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// One variant
// ─────────────────────────────────────────────────────────────────────────────

interface VariantResult {
  seed: number;
  scenario: Scenario;
  axes: Omit<Variant, 'seed' | 'scenario'>;
  outcome: 'HELD' | 'BROKEN';
  broken: string[];
  flags: string[];
  pressables: {
    label: string;
    role: string;
    target: { w: number | null; h: number | null };
  }[];
  fetchCalls: FetchCall[];
  store: {
    availability: string;
    modelTrainingActive: boolean;
    lastActionAt: string | null;
    busy: boolean;
    error: string | null;
  };
  ms: number;
}

const dumpedScenarios = new Set<Scenario>();

async function runVariant(
  v: Variant,
  evidenceDir: string | null,
): Promise<VariantResult> {
  const started = Date.now();
  const broken: string[] = [];
  const flags: string[] = [];
  const fetchCalls: FetchCall[] = [];
  const consoleErrors: string[] = [];
  const consoleSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(
        args.map(a => (a instanceof Error ? a.message : String(a))).join(' '),
      );
    });
  const announceSpy = jest
    .spyOn(AccessibilityInfo, 'announceForAccessibility')
    .mockImplementation(() => undefined);

  resetStores();
  installEnvironment(v);

  const pendingGet = deferred<FakeResponse>();
  const pendingPost = deferred<FakeResponse>();
  const injected = v.scenario.startsWith('injected_error');
  const readyActive =
    v.scenario === 'ready_on' || v.scenario === 'ready_toggle_withdraw'
      ? true
      : [
            'ready_off',
            'ready_toggle_grant',
            'ready_toggle_fails',
            'busy_pending',
            'stale_session_midflight',
            'sign_out_while_ready',
            'sign_in_while_signed_out',
            'double_tap_toggle',
            'leave_while_loading',
          ].includes(v.scenario)
        ? v.serverActive
        : false;

  const plan: FetchPlan = {
    status: call => {
      if (call.method === 'GET') {
        switch (v.scenario) {
          case 'unavailable_http':
            return jsonResponse(500 + Math.floor(mulberry32(v.seed)() * 4), {
              error: STRINGS[v.stringId],
            });
          case 'unavailable_network':
            throw new TypeError('Network request failed');
          case 'unavailable_invalid_payload':
            return jsonResponse(200, invalidPayload(v));
          case 'loading_pending':
          case 'leave_while_loading':
            return pendingGet.promise;
          case 'stale_session_midflight':
            // sign-out lands while the request is in flight
            clearApiSession();
            useAuthStore.setState({ session: null });
            return jsonResponse(200, consentPayload(v, true, 'granted'));
          default:
            return jsonResponse(
              200,
              consentPayload(v, readyActive, readyActive ? 'granted' : null),
            );
        }
      }
      // POST grant / withdraw
      switch (v.scenario) {
        case 'ready_toggle_fails':
          return jsonResponse(503, { error: STRINGS[v.stringId] });
        case 'busy_pending':
          return pendingPost.promise;
        default: {
          const granted = call.url.endsWith('/grant');
          return jsonResponse(
            200,
            consentPayload(v, granted, granted ? 'granted' : 'withdrawn'),
          );
        }
      }
    },
  };

  const fetchMock = jest.fn(async (input: string, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    fetchCalls.push(call);
    return plan.status(call);
  });
  const realFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = fetchMock;

  if (v.scenario !== 'signed_out' && v.scenario !== 'sign_in_while_signed_out')
    signIn();

  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(<Harness />);
    });
    await act(async () => {
      navigationRef.navigate('ConsentSettings');
    });
    await flush(renderer);

    if (injected) {
      await act(async () => {
        useConsentStore.setState({
          availability:
            v.scenario === 'injected_error_ready' ? 'ready' : 'unavailable',
          modelTrainingActive:
            v.scenario === 'injected_error_ready' ? v.serverActive : false,
          error: STRINGS[v.stringId],
          busy: false,
        });
      });
    }

    const root = renderer.root;
    const screenTexts = () => hostTexts(root).map(textContent);

    // ── A7 no console.error so far
    // (checked at the end, after interactions)

    // ── A1/A2 accessibility of every host pressable
    const audit = () => {
      const rows: VariantResult['pressables'] = [];
      for (const p of hostPressables(root)) {
        const role = p.props.accessibilityRole;
        const label = p.props.accessibilityLabel;
        const target = provableTarget(p);
        rows.push({
          label: String(label ?? ''),
          role: String(role ?? ''),
          target,
        });
        if (typeof role !== 'string' || role.length === 0)
          broken.push(
            `A1 pressable without accessibilityRole: ${describe_(p)}`,
          );
        if (typeof label !== 'string' || label.trim().length === 0)
          broken.push(
            `A1 pressable without accessibilityLabel: ${describe_(p)}`,
          );
        if (target.h === null || target.w === null)
          broken.push(
            `A2 target not statically provable (${JSON.stringify(target)}): ${describe_(p)}`,
          );
        else if (target.h < 44 || target.w < 44)
          broken.push(
            `A2 target ${target.w}x${target.h} < 44pt: ${describe_(p)}`,
          );
      }
      return rows;
    };
    let pressables = audit();

    // ── A3 toggle state mirrors the store
    const toggle = () => {
      const matches = hostPressables(root).filter(
        p => p.props.accessibilityRole === 'switch',
      );
      if (matches.length !== 1)
        broken.push(`A3 expected exactly 1 switch, found ${matches.length}`);
      return matches[0];
    };
    const checkToggle = (where: string) => {
      const t = toggle();
      if (!t) return;
      const st = useConsentStore.getState();
      const state = t.props.accessibilityState ?? {};
      const expectDisabled = st.busy || st.availability !== 'ready';
      if (state.checked !== st.modelTrainingActive)
        broken.push(
          `A3[${where}] switch checked=${String(state.checked)} but store.modelTrainingActive=${String(st.modelTrainingActive)}`,
        );
      if (Boolean(state.disabled) !== expectDisabled)
        broken.push(
          `A3[${where}] switch disabled=${String(state.disabled)} but busy=${String(st.busy)} availability=${st.availability}`,
        );
    };
    checkToggle('after-hydrate');

    // ── A4 no leaked null-ish text
    for (const txt of screenTexts()) {
      if (
        /^(undefined|null|NaN|\[object Object\])$/.test(txt.trim()) &&
        !injected
      )
        broken.push(`A4 text renders ${JSON.stringify(txt)}`);
      if (/\[object Object\]/.test(txt))
        broken.push(
          `A4 text contains [object Object]: ${JSON.stringify(txt.slice(0, 80))}`,
        );
    }

    // ── A5 font scaling never disabled / clamped below 1.35
    for (const t of hostTexts(root)) {
      if (t.props.allowFontScaling === false)
        broken.push(`A5 allowFontScaling=false: ${describe_(t)}`);
      const m = t.props.maxFontSizeMultiplier;
      if (typeof m === 'number' && m < 1.35)
        broken.push(`A5 maxFontSizeMultiplier=${m}: ${describe_(t)}`);
    }

    // ── A6 forbidden store copy (static copy only — injected corpus excluded)
    for (const t of hostTexts(root)) {
      const txt = textContent(t);
      if (injected && txt === STRINGS[v.stringId]) continue;
      if (FORBIDDEN_COPY.test(txt))
        broken.push(`A6 forbidden copy: ${JSON.stringify(txt)}`);
    }

    // ── Heuristic layout flags (estimates; never fail)
    const contentWidth = v.width - 2 * 32; // ScrollView paddingHorizontal space.xl
    for (const t of hostTexts(root)) {
      const s = flat(t.props.style);
      const txt = textContent(t);
      const fontSize = (num(s.fontSize) ?? 14) * v.fontScale;
      const estWidth = txt.length * fontSize * 0.5;
      if (t.props.numberOfLines === 1) {
        const available =
          txt === 'Data & consent' ? v.width - 2 * 24 - 2 * 44 : contentWidth;
        if (estWidth > available)
          flags.push(
            `CLIP_ESTIMATE numberOfLines=1 text=${JSON.stringify(txt)} est=${Math.round(estWidth)}pt > avail=${available}pt @fontScale=${v.fontScale} width=${v.width}`,
          );
      }
      if (s.position === 'absolute')
        flags.push(
          `OVERLAP_RISK absolute text=${JSON.stringify(txt.slice(0, 40))}`,
        );
      // flex:1 text in the card header row shares the row with a 34pt icon,
      // a 54pt toggle and two 8pt gaps; a single word wider than the
      // remaining width is broken mid-word on iOS (no clipping, degraded).
      if (s.flex === 1 && txt === 'Use my feedback to improve scoring') {
        const rowAvail = contentWidth - 2 * 24 - 34 - 54 - 16;
        const longestWord = Math.max(...txt.split(' ').map(w => w.length));
        const estWord = longestWord * fontSize * 0.5;
        if (estWord > rowAvail)
          flags.push(
            `WRAP_ESTIMATE longest word est=${Math.round(estWord)}pt > row avail=${rowAvail}pt @fontScale=${v.fontScale} width=${v.width}`,
          );
      }
    }
    // iOS announcement of state changes: `accessibilityLiveRegion` is
    // Android-only (react-native ViewAccessibility.d.ts @platform android);
    // on iOS a status/error text is only heard if announceForAccessibility
    // is called. Recorded as a flag; pinned by the test.failing below.
    const liveRegionTexts = hostTexts(root).filter(
      t => t.props.accessibilityLiveRegion,
    );
    if (liveRegionTexts.length && announceSpy.mock.calls.length === 0)
      flags.push(
        `A11Y_LIVE_REGION_ONLY ${liveRegionTexts.length} Text(s) rely on accessibilityLiveRegion (Android-only); announceForAccessibility calls=0`,
      );
    // fixed-height ancestors of text
    for (const view of root.findAll(n => hostType(n) === 'View')) {
      const s = flat(view.props.style);
      const h = num(s.height);
      if (h === null || s.overflow !== 'hidden') continue;
      const inner = view.findAll(n => hostType(n) === 'Text');
      if (inner.length)
        flags.push(
          `CLIP_RISK fixed height=${h} overflow=hidden contains ${inner.length} Text`,
        );
    }

    // ── A8 store invariants + locale/zone formatting of lastActionAt
    const st = useConsentStore.getState();
    const isReadyScenario = [
      'ready_off',
      'ready_on',
      'ready_toggle_grant',
      'ready_toggle_withdraw',
      'ready_toggle_fails',
      'busy_pending',
      'sign_out_while_ready',
      'double_tap_toggle',
    ].includes(v.scenario);
    if (isReadyScenario) {
      if (st.availability !== 'ready')
        broken.push(
          `A8 expected availability=ready got ${st.availability} error=${String(st.error)}`,
        );
      if (st.modelTrainingActive !== readyActive)
        broken.push(
          `A8 modelTrainingActive=${String(st.modelTrainingActive)} server said ${String(readyActive)}`,
        );
      const expectedInstant = INSTANTS[v.instantId];
      if (st.lastActionAt !== expectedInstant)
        broken.push(
          `A8 lastActionAt=${JSON.stringify(st.lastActionAt)} expected ${JSON.stringify(expectedInstant)}`,
        );
      if (typeof expectedInstant === 'string') {
        const d = new Date(expectedInstant);
        if (!Number.isNaN(d.getTime())) {
          try {
            const formatted = new Intl.DateTimeFormat(v.locale, {
              timeZone: v.timeZone,
              dateStyle: 'medium',
              timeStyle: 'short',
            }).format(d);
            if (!formatted)
              broken.push(
                `A8 Intl produced empty string for ${expectedInstant} in ${v.locale}/${v.timeZone}`,
              );
          } catch (e) {
            broken.push(
              `A8 Intl threw for ${expectedInstant} in ${v.locale}/${v.timeZone}: ${String(e)}`,
            );
          }
        } else {
          flags.push(
            `INVALID_INSTANT ${JSON.stringify(expectedInstant)} preserved verbatim (screen does not render it)`,
          );
        }
      }
    }
    if (
      v.scenario === 'signed_out' ||
      v.scenario === 'stale_session_midflight' ||
      v.scenario === 'sign_in_while_signed_out'
    ) {
      if (st.availability !== 'signed_out')
        broken.push(`A8 expected signed_out got ${st.availability}`);
      if (st.modelTrainingActive)
        broken.push('A8 modelTrainingActive=true while signed out');
      if (!screenTexts().some(t => t.startsWith('Sign in to change this')))
        broken.push('A8 signed-out copy missing');
    }
    if (v.scenario.startsWith('unavailable')) {
      if (st.availability !== 'unavailable')
        broken.push(`A8 expected unavailable got ${st.availability}`);
      if (st.modelTrainingActive)
        broken.push('A8 modelTrainingActive=true after failed hydrate');
      if (!screenTexts().some(t => t === st.error))
        broken.push(`A8 error copy ${JSON.stringify(st.error)} not rendered`);
      if (!pressables.some(p => p.label === 'Try again'))
        broken.push('A8 Try again missing in unavailable state');
    }
    if (
      v.scenario === 'loading_pending' ||
      v.scenario === 'leave_while_loading'
    ) {
      if (st.availability !== 'loading')
        broken.push(`A8 expected loading got ${st.availability}`);
      if (
        !screenTexts().some(t => t.startsWith('Checking your current choice'))
      )
        broken.push('A8 loading copy missing');
      const live = hostTexts(root).find(t =>
        textContent(t).startsWith('Checking your current choice'),
      );
      if (live && live.props.accessibilityLiveRegion !== 'polite')
        broken.push('A8 loading text is not a polite live region');
    }
    if (injected) {
      const rendered = screenTexts();
      const shown = rendered.some(t => t === STRINGS[v.stringId]);
      if (v.scenario === 'injected_error_unavailable' || STRINGS[v.stringId]) {
        if (!shown)
          broken.push(`A8 injected error ${v.stringId} not rendered verbatim`);
      }
    }
    if (
      st.modelTrainingActive &&
      !(isReadyScenario && readyActive) &&
      !(injected && v.serverActive)
    )
      broken.push('A8 modelTrainingActive=true without server proof');

    // ── A1b the switch's accessibilityLabel matches its visible label text
    {
      const t = toggle();
      if (t) {
        const visible = screenTexts();
        if (!visible.includes(String(t.props.accessibilityLabel)))
          broken.push(
            `A1 switch label ${JSON.stringify(t.props.accessibilityLabel)} has no matching visible Text`,
          );
      }
    }

    // ── A5b RTL variants: no Text forces writingDirection ltr
    if (v.rtl) {
      for (const t of hostTexts(root)) {
        if (flat(t.props.style).writingDirection === 'ltr')
          broken.push(`A5 writingDirection=ltr under RTL: ${describe_(t)}`);
      }
    }

    // ── A6b both consent scopes are presented as separate sections
    {
      const visible = screenTexts();
      for (const heading of [
        'Analyze my video',
        'Improve the models',
        'Data & consent',
      ]) {
        if (!visible.includes(heading))
          broken.push(`A6 section heading ${JSON.stringify(heading)} missing`);
      }
    }

    // ── A9 interactions
    const press = async (label: string, times = 1) => {
      const p = hostPressables(root).find(
        n => n.props.accessibilityLabel === label,
      );
      if (!p) {
        broken.push(`A9 pressable ${JSON.stringify(label)} not found`);
        return;
      }
      await act(async () => {
        for (let i = 0; i < times; i += 1) p.props.onClick({ nativeEvent: {} });
      });
      await flush(renderer);
    };
    const routeName = (): string | undefined =>
      navigationRef.getCurrentRoute()?.name;

    if (
      v.scenario === 'ready_toggle_grant' ||
      v.scenario === 'ready_toggle_withdraw' ||
      v.scenario === 'ready_toggle_fails'
    ) {
      const before = useConsentStore.getState().modelTrainingActive;
      await press('Use my feedback to improve scoring');
      const post = fetchCalls.find(c => c.method === 'POST');
      if (!post) broken.push('A9 toggle press produced no POST');
      else {
        const wantPath = before
          ? '/v1/me/consent/withdraw'
          : '/v1/me/consent/grant';
        if (!post.url.endsWith(wantPath))
          broken.push(`A9 toggle POST ${post.url} expected …${wantPath}`);
        const body = post.body as Record<string, unknown> | undefined;
        if (body?.scope !== 'model_training')
          broken.push(`A9 POST scope=${String(body?.scope)}`);
        if (body?.source !== 'mobile_settings')
          broken.push(`A9 POST source=${String(body?.source)}`);
        if (!before && body?.consentVersion !== 'model-training-v1')
          broken.push(
            `A9 grant consentVersion=${String(body?.consentVersion)}`,
          );
      }
      const after = useConsentStore.getState();
      if (v.scenario === 'ready_toggle_fails') {
        if (after.modelTrainingActive !== before)
          broken.push(
            `A9 failed toggle changed active ${String(before)}→${String(after.modelTrainingActive)}`,
          );
        if (!after.error) broken.push('A9 failed toggle surfaced no error');
        else if (!screenTexts().includes(after.error))
          broken.push(
            `A9 toggle error ${JSON.stringify(after.error)} not rendered`,
          );
        const errText = hostTexts(root).find(
          t => textContent(t) === after.error,
        );
        if (
          errText &&
          !errText.props.accessibilityLiveRegion &&
          errText.props.accessibilityRole !== 'alert' &&
          announceSpy.mock.calls.length === 0
        )
          flags.push(
            `A11Y_ERROR_NOT_ANNOUNCED failed-toggle error Text has no liveRegion/alert role and announceForAccessibility calls=0: ${describe_(errText)}`,
          );
      } else if (after.modelTrainingActive !== !before) {
        broken.push(
          `A9 toggle did not flip: before=${String(before)} after=${String(after.modelTrainingActive)}`,
        );
      }
      checkToggle('after-toggle');
      pressables = audit();
    }

    if (v.scenario === 'busy_pending') {
      await press('Use my feedback to improve scoring');
      const mid = useConsentStore.getState();
      if (!mid.busy) broken.push('A9 store not busy while POST pending');
      checkToggle('while-busy');
      // a second press while busy must not issue another POST
      await press('Use my feedback to improve scoring');
      if (fetchCalls.filter(c => c.method === 'POST').length !== 1)
        broken.push(
          `A9 busy toggle issued ${fetchCalls.filter(c => c.method === 'POST').length} POSTs`,
        );
      pendingPost.resolve(
        jsonResponse(
          200,
          consentPayload(
            v,
            !readyActive,
            !readyActive ? 'granted' : 'withdrawn',
          ),
        ),
      );
      await flush(renderer);
      if (useConsentStore.getState().busy)
        broken.push('A9 store still busy after POST resolved');
      checkToggle('after-busy');
    }

    if (v.scenario === 'double_tap_toggle') {
      const before = useConsentStore.getState().modelTrainingActive;
      await press('Use my feedback to improve scoring', 2);
      const posts = fetchCalls.filter(c => c.method === 'POST');
      if (posts.length !== 1)
        broken.push(`A9 double tap issued ${posts.length} POSTs (busy guard)`);
      const after = useConsentStore.getState();
      if (after.modelTrainingActive !== !before)
        broken.push(
          `A9 double tap left active=${String(after.modelTrainingActive)} (before ${String(before)})`,
        );
      if (after.busy) broken.push('A9 store stuck busy after double tap');
      checkToggle('after-double-tap');
    }

    if (v.scenario === 'sign_out_while_ready') {
      await act(async () => {
        clearApiSession();
        useAuthStore.setState({ session: null });
      });
      await flush(renderer);
      const s2 = useConsentStore.getState();
      if (s2.availability !== 'signed_out')
        broken.push(
          `A9 sign-out while ready left availability=${s2.availability}`,
        );
      if (s2.modelTrainingActive)
        broken.push('A9 sign-out while ready kept modelTrainingActive=true');
      if (!screenTexts().some(t => t.startsWith('Sign in to change this')))
        broken.push('A9 signed-out copy missing after sign-out');
      checkToggle('after-sign-out');
      pressables = audit();
    }

    if (v.scenario === 'sign_in_while_signed_out') {
      const gets = fetchCalls.filter(c => c.method === 'GET').length;
      await act(async () => {
        signIn();
      });
      await flush(renderer);
      if (fetchCalls.filter(c => c.method === 'GET').length !== gets + 1)
        broken.push('A9 sign-in did not trigger exactly one status fetch');
      const s2 = useConsentStore.getState();
      if (s2.availability !== 'ready')
        broken.push(`A9 after sign-in availability=${s2.availability}`);
      if (s2.modelTrainingActive !== readyActive)
        broken.push('A9 after sign-in active does not match server');
      if (screenTexts().some(t => t.startsWith('Sign in to change this')))
        broken.push('A9 signed-out copy still shown after sign-in');
      checkToggle('after-sign-in');
      pressables = audit();
    }

    if (v.scenario === 'leave_while_loading') {
      await press('Back');
      if (routeName() !== 'Tabs')
        broken.push(`A9 Back while loading landed on ${String(routeName())}`);
      pendingGet.resolve(
        jsonResponse(
          200,
          consentPayload(v, v.serverActive, v.serverActive ? 'granted' : null),
        ),
      );
      await flush(renderer);
      const s2 = useConsentStore.getState();
      if (s2.availability !== 'ready')
        broken.push(
          `A9 late GET after leaving left availability=${s2.availability}`,
        );
      await act(async () => {
        navigationRef.navigate('ConsentSettings');
      });
      await flush(renderer);
      if (fetchCalls.filter(c => c.method === 'GET').length !== 2)
        broken.push(
          `A9 re-entering the screen issued ${fetchCalls.filter(c => c.method === 'GET').length} GETs total (expected 2)`,
        );
      checkToggle('after-re-enter');
    }

    if (v.scenario === 'loading_pending') {
      pendingGet.resolve(
        jsonResponse(
          200,
          consentPayload(v, v.serverActive, v.serverActive ? 'granted' : null),
        ),
      );
      await flush(renderer);
      const s2 = useConsentStore.getState();
      if (s2.availability !== 'ready')
        broken.push(
          `A9 after pending GET resolved availability=${s2.availability}`,
        );
      if (s2.modelTrainingActive !== v.serverActive)
        broken.push('A9 resolved GET did not apply server active');
      checkToggle('after-loading');
    }

    if (v.scenario.startsWith('unavailable')) {
      const gets = fetchCalls.filter(c => c.method === 'GET').length;
      await press('Try again');
      if (fetchCalls.filter(c => c.method === 'GET').length !== gets + 1)
        broken.push('A9 Try again did not re-fetch exactly once');
      if (useConsentStore.getState().availability !== 'unavailable')
        broken.push('A9 Try again with same failure did not stay unavailable');
    }

    if (
      v.scenario === 'signed_out' ||
      v.scenario === 'stale_session_midflight' ||
      v.scenario === 'sign_out_while_ready'
    ) {
      // toggle is disabled: pressing it must not POST
      await press('Use my feedback to improve scoring');
      if (fetchCalls.some(c => c.method === 'POST'))
        broken.push('A9 disabled toggle issued a POST while signed out');
      await press('Connect account');
      if (routeName() !== 'ConnectAccount')
        broken.push(`A9 Connect account navigated to ${String(routeName())}`);
      await act(async () => {
        navigationRef.goBack();
      });
      await flush(renderer);
    }

    if (routeName() !== 'ConsentSettings')
      broken.push(
        `A9 expected to be on ConsentSettings, on ${String(routeName())}`,
      );
    await press('Back');
    if (routeName() !== 'Tabs')
      broken.push(`A9 Back landed on ${String(routeName())}`);
    if (!renderer.root.findAll(n => n.props.testID === 'probe-tabs').length)
      broken.push('A9 Tabs probe not rendered after Back');

    // ── A8b exactly the expected number of status fetches (no double hydrate)
    {
      const expectedGets =
        v.scenario === 'signed_out'
          ? 0
          : v.scenario === 'leave_while_loading' ||
              v.scenario.startsWith('unavailable_') // mount + "Try again"
            ? 2
            : 1;
      const gets = fetchCalls.filter(c => c.method === 'GET').length;
      if (gets !== expectedGets)
        broken.push(
          `A8 ${v.scenario} issued ${gets} status GETs (expected ${expectedGets})`,
        );
    }

    // ── A7
    for (const err of consoleErrors)
      broken.push(`A7 console.error: ${err.slice(0, 300)}`);

    const result: VariantResult = {
      seed: v.seed,
      scenario: v.scenario,
      axes: {
        width: v.width,
        height: v.height,
        fontScale: v.fontScale,
        locale: v.locale,
        rtl: v.rtl,
        timeZone: v.timeZone,
        stringId: v.stringId,
        instantId: v.instantId,
        serverActive: v.serverActive,
      },
      outcome: broken.length ? 'BROKEN' : 'HELD',
      broken,
      flags,
      pressables,
      // snapshot: the evidence re-render below remounts the screen (one more GET)
      fetchCalls: [...fetchCalls],
      store: (({
        availability,
        modelTrainingActive,
        lastActionAt,
        busy,
        error,
      }) => ({ availability, modelTrainingActive, lastActionAt, busy, error }))(
        useConsentStore.getState(),
      ),
      ms: Date.now() - started,
    };

    if (
      evidenceDir &&
      (broken.length || flags.length || !dumpedScenarios.has(v.scenario))
    ) {
      dumpedScenarios.add(v.scenario);
      // re-render the screen route for the tree dump (we are back on Tabs)
      await act(async () => {
        navigationRef.navigate('ConsentSettings');
      });
      await flush(renderer);
      const tree = dumpTree(renderer.root);
      fs.writeFileSync(
        path.join(evidenceDir, `tree-seed-${v.seed}.txt`),
        [
          `# seed ${v.seed} ${v.scenario} ${JSON.stringify(result.axes)}`,
          `# outcome ${result.outcome}`,
          ...broken.map(b => `# BROKEN ${b}`),
          ...flags.map(f => `# FLAG ${f}`),
          '',
          ...tree,
        ].join('\n'),
      );
    }
    return result;
  } finally {
    pendingGet.resolve(jsonResponse(200, consentPayload(v, false, null)));
    pendingPost.resolve(jsonResponse(200, consentPayload(v, false, null)));
    if (renderer) {
      await act(async () => {
        renderer.unmount();
      });
    }
    (globalThis as { fetch: unknown }).fetch = realFetch;
    consoleSpy.mockRestore();
    announceSpy.mockRestore();
    restoreEnvironment();
    resetStores();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Campaign
// ─────────────────────────────────────────────────────────────────────────────

const ITER = Math.max(1, Number(process.env.STRESS_ITER ?? 60) || 60);
const BASE_SEED = Number(process.env.STRESS_BASE_SEED ?? 1) || 1;
const ONLY_SEED = process.env.STRESS_SEED
  ? Number(process.env.STRESS_SEED)
  : null;
const OUT_DIR = process.env.STRESS_OUT
  ? path.resolve(process.env.STRESS_OUT)
  : null;
const CHUNK = 20;

const seeds: number[] =
  ONLY_SEED !== null
    ? [ONLY_SEED]
    : Array.from({ length: ITER }, (_, i) => BASE_SEED + i);
const chunks: number[][] = [];
for (let i = 0; i < seeds.length; i += CHUNK)
  chunks.push(seeds.slice(i, i + CHUNK));

const results: VariantResult[] = [];

beforeAll(() => {
  if (OUT_DIR) fs.mkdirSync(OUT_DIR, { recursive: true });
});

afterAll(() => {
  if (!OUT_DIR) return;
  const held = results.filter(r => r.outcome === 'HELD').length;
  const summary = {
    unit: 'scr-consentsettingsscreen',
    lens: 'boundary-i18n-a11y',
    processTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    iterations: results.length,
    held,
    broken: results.length - held,
    flagged: results.filter(r => r.flags.length).length,
    coverage: {
      scenarios: Object.fromEntries(
        SCENARIOS.map(s => [s, results.filter(r => r.scenario === s).length]),
      ),
      widths: Object.fromEntries(
        WIDTHS.map(w => [w, results.filter(r => r.axes.width === w).length]),
      ),
      fontScales: Object.fromEntries(
        FONT_SCALES.map(f => [
          f,
          results.filter(r => r.axes.fontScale === f).length,
        ]),
      ),
      locales: Object.fromEntries(
        LOCALES.map(l => [l, results.filter(r => r.axes.locale === l).length]),
      ),
      timeZones: Object.fromEntries(
        TIME_ZONES.map(t => [
          t,
          results.filter(r => r.axes.timeZone === t).length,
        ]),
      ),
      strings: Object.fromEntries(
        STRING_IDS.map(s => [
          s,
          results.filter(r => r.axes.stringId === s).length,
        ]),
      ),
      instants: Object.fromEntries(
        INSTANT_IDS.map(s => [
          s,
          results.filter(r => r.axes.instantId === s).length,
        ]),
      ),
    },
    flagKinds: results.reduce<Record<string, number>>((acc, r) => {
      for (const f of r.flags) {
        const kind = f.split(' ')[0] ?? f;
        acc[kind] = (acc[kind] ?? 0) + 1;
      }
      return acc;
    }, {}),
    brokenSeeds: results
      .filter(r => r.outcome === 'BROKEN')
      .map(r => ({ seed: r.seed, scenario: r.scenario, broken: r.broken })),
    results,
  };
  fs.writeFileSync(
    path.join(OUT_DIR, 'results.json'),
    JSON.stringify(summary, null, 2),
  );
});

describe('ConsentSettingsScreen · boundary/i18n/a11y stress (real navigator + real stores)', () => {
  test('corpus covers the lens axes', () => {
    expect(STRINGS.ascii260.length).toBeGreaterThanOrEqual(200);
    expect(STRINGS.cjk220.length).toBeGreaterThanOrEqual(200);
    expect(STRINGS.zwjEmoji).toMatch(/\u200D/);
    expect(STRINGS.combining).toMatch(/[\u0300-\u036F]/);
    expect(LOCALES).toHaveLength(12);
    expect(TIME_ZONES).toHaveLength(8);
    expect(WIDTHS).toHaveLength(3);
    expect(FONT_SCALES).toHaveLength(3);
    for (const tz of TIME_ZONES)
      expect(
        () => new Intl.DateTimeFormat('en', { timeZone: tz }),
      ).not.toThrow();
  });

  test('a seed derives the same variant every time (replayable)', () => {
    for (const seed of [1, 7, 4242, 0x7fffffff]) {
      expect(deriveVariant(seed)).toEqual(deriveVariant(seed));
    }
  });

  // KNOWN (P3, boundary-i18n-a11y campaign): on iOS a failed consent change
  // is shown but never announced — `accessibilityLiveRegion` is Android-only
  // and the screen does not call AccessibilityInfo.announceForAccessibility.
  // `test.failing` passes while the gap exists and FAILS once it is fixed,
  // signalling that this pin should become a regular assertion.
  test.failing(
    'KNOWN: a failed consent change is announced to VoiceOver (iOS)',
    async () => {
      let v = deriveVariant(1);
      for (let seed = 1; v.scenario !== 'ready_toggle_fails'; seed += 1)
        v = deriveVariant(seed);
      const r = await runVariant(v, null);
      expect(r.outcome).toBe('HELD');
      expect(r.flags.some(f => f.startsWith('A11Y_ERROR_NOT_ANNOUNCED'))).toBe(
        false,
      );
    },
  );

  test.each(chunks.map((c, i) => [i, c] as const))(
    'seeds chunk %#: every variant holds A1–A9',
    async (_i, chunk) => {
      const failures: string[] = [];
      for (const seed of chunk) {
        const v = deriveVariant(seed);
        const r = await runVariant(v, OUT_DIR);
        results.push(r);
        if (r.outcome === 'BROKEN') {
          failures.push(
            `seed=${seed} scenario=${v.scenario} axes=${JSON.stringify(r.axes)}\n  - ${r.broken.join('\n  - ')}`,
          );
        }
      }
      expect(failures).toEqual([]);
    },
  );
});
