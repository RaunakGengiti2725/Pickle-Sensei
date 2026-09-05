import React from 'react';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Dimensions, I18nManager, Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { PermissionState } from '../../src/notifications/service';

/**
 * STRESS HARNESS — OnboardingScreen × boundary / i18n / a11y lens.
 *
 * Renders the REAL `App` (App.tsx Gate → OnboardingScreen) with the real
 * appStore, notificationStore and apiSession store behind it. Only native
 * surfaces are replaced: SQLite (in-memory kv), the OS notification
 * scheduler, the device Keychain-backed authStore (a zustand stand-in that
 * exposes the same `hydrated/session/hydrate/signOut` contract), the video
 * splash, the tab navigator that follows onboarding, and `fetch` (a fake
 * edge function that mirrors the production `sanitizeUserText` pipeline,
 * reading its strip regexes from supabase/functions/api/http.ts at runtime,
 * so client/server boundary disagreements surface here instead of in
 * production).
 *
 * Every iteration is derived from a 32-bit seed (mulberry32) and is
 * replayable with `STRESS_SEED=<n>`. Default campaign: STRESS_ITER=24 (fits
 * the normal suite). Campaign runs: `STRESS_ITER=200 npx jest --ci
 * __tests__/stress/onboardingScreen.boundaryI18nA11y.stress.test.tsx`.
 * Locale is a process-level property of Node's ICU, so the 12-locale matrix
 * is driven from the shell (`LANG=<locale> LC_ALL=<locale> STRESS_ITER=…`)
 * and every result row records the resolved ICU locale it ran under.
 *
 * Results: `${STRESS_OUT ?? <repo>/artifacts/stress}/onboarding-boundary-
 * i18n-a11y/<run>/results.json` (seed → outcome) plus rendered trees for
 * every seed that tripped a check.
 *
 * Evidence planes: everything asserted here is the React host tree as
 * rendered by react-test-renderer on Linux (VERIFIED). The font-scale layout
 * model is arithmetic over the flattened styles (INFERRED — Yoga/CoreText do
 * not run here); iOS truth for clipping needs the M4 runner.
 */

// ---------------------------------------------------------------------------
// Native-surface mocks (mirrors __tests__/wf/flow-launch-onboarding-screen +
// __tests__/wf/App.buttons; nothing product-owned is replaced except the
// authStore's Keychain/provider-SDK surface).
// ---------------------------------------------------------------------------

const mockInsets = { current: { top: 0, bottom: 0, left: 0, right: 0 } };
jest.mock('react-native-safe-area-context', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const passthrough = (props: { children?: React.ReactNode }) =>
    R.createElement(RN.View, null, props.children);
  return {
    SafeAreaProvider: passthrough,
    SafeAreaView: passthrough,
    useSafeAreaInsets: () => mockInsets.current,
    initialWindowMetrics: {
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
    },
  };
});

const mockKv = new Map<string, string>();
const mockDbControl = { writeError: null as Error | null, writes: 0 };
jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      if (statement.startsWith('SELECT value FROM kv')) {
        const value = mockKv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        mockDbControl.writes += 1;
        if (mockDbControl.writeError) throw mockDbControl.writeError;
        mockKv.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

const mockScheduler = {
  permission: 'undetermined' as PermissionState,
  requestResult: 'granted' as PermissionState,
  requestError: null as Error | null,
  requestCalls: 0,
  appliedPlans: [] as unknown[],
  async permissionState(): Promise<PermissionState> {
    return this.permission;
  },
  async requestPermission(): Promise<PermissionState> {
    this.requestCalls += 1;
    if (this.requestError) throw this.requestError;
    this.permission = this.requestResult;
    return this.requestResult;
  },
  async applyPlan(plan: unknown): Promise<void> {
    this.appliedPlans.push(plan);
  },
  async cancelAllPlanned(): Promise<void> {},
  async openSystemSettings(): Promise<void> {},
};
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => mockScheduler,
}));

interface MockSession {
  provider: 'apple' | 'google';
  canonicalAppUserId: string;
}
const mockAuthPlan: { session: MockSession | null } = { session: null };
const mockSignOut = jest.fn();
interface MockAuthState {
  hydrated: boolean;
  session: MockSession | null;
  busy: boolean;
  error: string | null;
  hydrate: () => Promise<void>;
  signInWithApple: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  clearError: () => void;
}
jest.mock('../../src/auth/authStore', () => {
  const { create } = jest.requireActual<typeof import('zustand')>('zustand');
  const scope = jest.requireActual<
    typeof import('../../src/data/accountScope')
  >('../../src/data/accountScope');
  const store = create<MockAuthState>(set => ({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
    hydrate: async () => {
      const session = mockAuthPlan.session;
      scope.setActiveDataOwner(
        session
          ? scope.canonicalDataOwner(session.canonicalAppUserId)
          : scope.SIGNED_OUT_DATA_OWNER,
      );
      set({ hydrated: true, session });
    },
    signInWithApple: async () => {},
    signInWithGoogle: async () => {},
    signOut: async () => {
      mockSignOut();
    },
    clearError: () => {},
  }));
  return { useAuthStore: store };
});

jest.mock('../../src/navigation/RootNavigator', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    RootNavigator: () => R.createElement(RN.Text, null, 'ROOT_NAVIGATOR'),
  };
});
jest.mock('../../src/screens/SplashScreen', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    SplashScreen: (props: { ready: boolean; onFinished: () => void }) => {
      R.useEffect(() => {
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
jest.mock('../../src/notifications/useNotificationBootstrap', () => ({
  useNotificationBootstrap: () => {},
}));
jest.mock('../../src/consistency/useConsistencyBootstrap', () => ({
  useConsistencyBootstrap: () => {},
}));

import App from '../../App';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import {
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../src/state/appStore';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { OnboardingScreen } from '../../src/screens/OnboardingScreen';

type Renderer = TestRenderer.ReactTestRenderer;
type HostNode = {
  type: string;
  props: Record<string, unknown>;
  children: Array<HostNode | string> | null;
};

// ---------------------------------------------------------------------------
// Fake edge function: PUT /v1/me/onboarding validates firstName EXACTLY like
// supabase/functions/api/index.ts (sanitizeUserText(raw, 200) then 1-40 UTF-16
// units) so a client/server disagreement is reproduced, not modelled. The
// Deno module cannot be imported under the mobile tsconfig, so the two strip
// regexes are read from the production source at runtime (a drift in http.ts
// fails `production sanitizer source is what this harness mirrors`).
// ---------------------------------------------------------------------------

const HTTP_TS_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'supabase',
  'functions',
  'api',
  'http.ts',
);
const HTTP_TS_SOURCE = fs.readFileSync(HTTP_TS_PATH, 'utf8');

function regexFromSource(constName: string): RegExp {
  const match = new RegExp(
    `const ${constName} =\\s*(?://[^\\n]*\\n\\s*)?/(.+)/g;`,
  ).exec(HTTP_TS_SOURCE);
  if (!match?.[1]) {
    throw new Error(`${constName} not found in ${HTTP_TS_PATH}`);
  }
  return new RegExp(match[1], 'g');
}

const CONTROL_AND_SPOOFING_CHARS = regexFromSource(
  'CONTROL_AND_SPOOFING_CHARS',
);
const LONE_SURROGATES = regexFromSource('LONE_SURROGATES');
const SANITIZE_PIPELINE_SOURCE = [
  'export function sanitizeUserText(value: string, maxLength: number): string {',
  '  const cleaned = value',
  '    .replace(CONTROL_AND_SPOOFING_CHARS, "")',
  '    .replace(LONE_SURROGATES, "")',
  '    .replace(/\\s+/g, " ")',
  '    .trim();',
  '  return Array.from(cleaned).slice(0, maxLength).join("").trimEnd();',
  '}',
].join('\n');

/** Mirror of supabase/functions/api/http.ts sanitizeUserText (pinned below). */
function sanitizeUserText(value: string, maxLength: number): string {
  const cleaned = value
    .replace(CONTROL_AND_SPOOFING_CHARS, '')
    .replace(LONE_SURROGATES, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, maxLength).join('').trimEnd();
}

interface FetchLog {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  status: number;
}
const fetchControl = {
  mode: 'ok' as 'ok' | 'network' | 'server_500',
  log: [] as FetchLog[],
};

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function fakeEdgeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = typeof input === 'string' ? input : String(input);
  const pathname = new URL(url).pathname;
  const method = init?.method ?? 'GET';
  const body =
    typeof init?.body === 'string'
      ? (JSON.parse(init.body) as Record<string, unknown>)
      : null;
  const record = (status: number, payload: unknown) => {
    fetchControl.log.push({ method, path: pathname, body, status });
    return jsonResponse(status, payload);
  };
  if (fetchControl.mode === 'network') {
    fetchControl.log.push({ method, path: pathname, body, status: 0 });
    throw new TypeError('Network request failed');
  }
  if (fetchControl.mode === 'server_500') {
    return record(500, { error: { message: 'Internal error' } });
  }
  if (method === 'GET' && pathname === '/v1/me') {
    return record(200, { onboardingState: 'pending', profile: null });
  }
  if (method === 'PUT' && pathname === '/v1/me/onboarding' && body) {
    const firstNameRaw = body['firstName'];
    if (firstNameRaw !== undefined && firstNameRaw !== null) {
      if (typeof firstNameRaw !== 'string') {
        return record(400, {
          error: { message: 'Invalid onboarding payload.' },
        });
      }
      const cleaned = sanitizeUserText(firstNameRaw, 200);
      if (cleaned.length < 1 || cleaned.length > 40) {
        return record(400, {
          error: {
            message: 'firstName must be 1-40 characters after trimming.',
          },
        });
      }
    }
    return record(200, {
      plan: { focusCheckpoint: 'contact_position' },
      recommendedCheckpoint: 'contact_position',
      profile: {
        skill_level: body['skillLevel'] ?? null,
        handedness: body['handedness'] ?? null,
        primary_goal: body['goal'] ?? null,
        biggest_problem: body['biggestProblem'] ?? null,
        focus_checkpoint: 'contact_position',
        first_name:
          typeof firstNameRaw === 'string'
            ? sanitizeUserText(firstNameRaw, 200)
            : null,
        gender: body['gender'] ?? null,
      },
    });
  }
  return record(404, { error: { message: 'Not found' } });
}

// ---------------------------------------------------------------------------
// Seeded RNG + variant space
// ---------------------------------------------------------------------------

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
  if (item === undefined) throw new Error('empty pick');
  return item;
}

function repeatFrom(rng: () => number, alphabet: string[], n: number) {
  let out = '';
  for (let i = 0; i < n; i += 1) out += pick(rng, alphabet);
  return out;
}

const CJK = '日本語のテキスト漢字仮名中文测试字符串한국어텍스트'.split('');
const ARABIC = 'محمدعليفاطمةأحمدخالدسارةنورليلىعمر'.split('');
const ARABIC_MARKS = ['\u064b', '\u064e', '\u0651', '\u0652'];
const COMBINING = ['\u0301', '\u0308', '\u0327', '\u0336', '\u0489', '\u20dd'];
const THAI = 'สมชายสมหญิงประเทศไทยกรุงเทพ'.split('');
const DEVANAGARI = 'प्रियंकाराहुलअमितनेहासंजय'.split('');
const CYRILLIC = 'ДмитрийЕкатеринаСветланаЖёлтый'.split('');
const ZWJ_EMOJI = [
  '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}\u200d\u{1F466}',
  '\u{1F469}\u{1F3FD}\u200d\u{1F4BB}',
  '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}',
  '\u{1F3F3}\uFE0F\u200D\u{1F308}',
];
const GERMAN_COMPOUNDS = [
  'Donaudampfschifffahrtsgesellschaftskapitän',
  'Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz',
  'Kraftfahrzeughaftpflichtversicherung',
  'Straßenverkehrsordnung',
];
const NUMERIC_LIKE = [
  '0',
  '-0',
  '-1',
  '00000',
  '1e309',
  'NaN',
  'Infinity',
  '\u0660\u0661\u0662', // Arabic-Indic digits
  '\uFF19\uFF19\uFF19', // fullwidth digits
  '9007199254740993',
  '-99999999999999999999',
];
const PLAIN = ['Dana', 'Jo', 'Zoë', 'Priya', 'İbrahim', 'José', 'Ñandú'];

const NAME_KINDS = [
  'empty',
  'whitespace_only',
  'zero_width_only',
  'invisible_unstripped',
  'bidi_control',
  'persian_zwnj',
  'plain',
  'long_ascii_200',
  'long_ascii_260',
  'cjk',
  'arabic_rtl',
  'zwj_emoji',
  'combining_marks',
  'german_compound',
  'thai',
  'devanagari',
  'cyrillic',
  'numeric_like',
  'at_max_40',
  'over_max_41',
  'padded_plain',
] as const;
type NameKind = (typeof NAME_KINDS)[number];

function makeName(rng: () => number, kind: NameKind): string {
  switch (kind) {
    case 'empty':
      return '';
    case 'whitespace_only':
      return repeatFrom(
        rng,
        [' ', '\t', '\u00a0', '\u3000'],
        1 + Math.floor(rng() * 6),
      );
    case 'zero_width_only':
      // All inside the server's CONTROL_AND_SPOOFING_CHARS strip set.
      return repeatFrom(
        rng,
        ['\u200b', '\u200c', '\u200d', '\u200e', '\u200f', '\ufeff'],
        1 + Math.floor(rng() * 4),
      );
    case 'invisible_unstripped':
      // Default-ignorable / invisible code points the server does NOT strip.
      return repeatFrom(
        rng,
        ['\u2060', '\u00ad', '\u034f', '\u061c', '\u180e', '\ufe0f', '\u3164'],
        1 + Math.floor(rng() * 4),
      );
    case 'bidi_control':
      return `Al${pick(rng, ['\u202e', '\u202a', '\u2066', '\u2069'])}i`;
    case 'persian_zwnj':
      // ZWNJ (U+200C) is orthographic in Persian/Urdu: علی‌رضا, محمد‌رضا.
      return pick(rng, [
        '\u0639\u0644\u06cc\u200c\u0631\u0636\u0627',
        '\u0645\u062d\u0645\u062f\u200c\u0631\u0636\u0627',
      ]);
    case 'plain':
      return pick(rng, PLAIN);
    case 'long_ascii_200':
      return repeatFrom(rng, 'abcdefghijklmnopqrstuvwxyz'.split(''), 200);
    case 'long_ascii_260':
      return repeatFrom(rng, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ '.split(''), 260);
    case 'cjk':
      return repeatFrom(rng, CJK, 1 + Math.floor(rng() * 40));
    case 'arabic_rtl': {
      const n = 2 + Math.floor(rng() * 20);
      let out = '';
      for (let i = 0; i < n; i += 1) {
        out += pick(rng, ARABIC);
        if (rng() < 0.4) out += pick(rng, ARABIC_MARKS);
      }
      return out;
    }
    case 'zwj_emoji':
      return repeatFrom(rng, ZWJ_EMOJI, 1 + Math.floor(rng() * 8));
    case 'combining_marks':
      return `Z${repeatFrom(rng, COMBINING, 1 + Math.floor(rng() * 40))}`;
    case 'german_compound':
      return pick(rng, GERMAN_COMPOUNDS);
    case 'thai':
      return repeatFrom(rng, THAI, 1 + Math.floor(rng() * 30));
    case 'devanagari':
      return repeatFrom(rng, DEVANAGARI, 1 + Math.floor(rng() * 30));
    case 'cyrillic':
      return repeatFrom(rng, CYRILLIC, 1 + Math.floor(rng() * 30));
    case 'numeric_like':
      return pick(rng, NUMERIC_LIKE);
    case 'at_max_40':
      return repeatFrom(rng, 'abcdefghij'.split(''), 40);
    case 'over_max_41':
      return repeatFrom(rng, 'abcdefghij'.split(''), 41);
    case 'padded_plain':
      return `  ${pick(rng, PLAIN)} \n`;
  }
}

const WIDTHS = [320, 375, 430] as const;
const HEIGHTS: Record<(typeof WIDTHS)[number], number> = {
  320: 568,
  375: 812,
  430: 932,
};
const FONT_SCALES = [1, 1.235, 2.35] as const; // default, xxLarge, AX3
const TIMEZONES = [
  'Pacific/Kiritimati', // UTC+14
  'Etc/GMT+12', // UTC-12
  'UTC',
  'America/New_York', // DST spring-forward edge below
  'Europe/Berlin', // DST fall-back edge below
  'Australia/Lord_Howe', // 30-minute DST shift
  'Pacific/Chatham', // +12:45 / +13:45
  'Asia/Kolkata', // +5:30, no DST
] as const;
const DST_EDGE_INSTANTS = [
  Date.UTC(2026, 2, 8, 6, 59, 59), // 1s before US spring-forward
  Date.UTC(2026, 2, 8, 7, 0, 0),
  Date.UTC(2026, 9, 25, 0, 59, 59), // 1s before EU fall-back
  Date.UTC(2026, 9, 25, 1, 0, 0),
  Date.UTC(2026, 3, 4, 15, 0, 0), // Lord Howe DST end
  Date.UTC(2026, 0, 1, 0, 0, 0),
] as const;
const INSETS = [
  { top: 0, bottom: 0, left: 0, right: 0 },
  { top: 59, bottom: 34, left: 0, right: 0 },
  { top: 20, bottom: 0, left: 0, right: 0 },
] as const;

interface Variant {
  seed: number;
  mode: 'preauth' | 'account';
  width: (typeof WIDTHS)[number];
  height: number;
  fontScale: (typeof FONT_SCALES)[number];
  timezone: (typeof TIMEZONES)[number];
  nowMs: number;
  rtl: boolean;
  insets: (typeof INSETS)[number];
  nameKind: NameKind;
  name: string;
  /** Per question: a 0..1 ratio mapped onto the radio options actually rendered. */
  answerRatios: [number, number, number, number, number];
  notification: 'granted' | 'denied' | 'error';
  fetch: 'ok' | 'network' | 'server_500';
  dbWriteFails: boolean;
  backtrackAtStep: number | null;
  finish: 'enable' | 'not_now';
}

function variantFor(seed: number): Variant {
  const rng = mulberry32(seed);
  const width = pick(rng, WIDTHS);
  return {
    seed,
    mode: rng() < 0.5 ? 'preauth' : 'account',
    width,
    height: HEIGHTS[width],
    fontScale: pick(rng, FONT_SCALES),
    timezone: pick(rng, TIMEZONES),
    nowMs: pick(rng, DST_EDGE_INSTANTS),
    rtl: rng() < 0.25,
    insets: pick(rng, INSETS),
    nameKind: pick(rng, NAME_KINDS),
    name: '',
    answerRatios: [rng(), rng(), rng(), rng(), rng()],
    notification: pick(rng, ['granted', 'granted', 'denied', 'error'] as const),
    fetch: pick(rng, ['ok', 'ok', 'ok', 'network', 'server_500'] as const),
    dbWriteFails: rng() < 0.1,
    backtrackAtStep: rng() < 0.3 ? 1 + Math.floor(rng() * 6) : null,
    finish: rng() < 0.7 ? 'enable' : 'not_now',
  };
}

function materialize(variant: Variant): Variant {
  const rng = mulberry32(variant.seed ^ 0x9e3779b9);
  return { ...variant, name: makeName(rng, variant.nameKind) };
}

// ---------------------------------------------------------------------------
// Tree utilities: a11y audit + font-scale layout model + evidence capture
// ---------------------------------------------------------------------------

type Style = Record<string, unknown>;

function flattenStyle(style: unknown): Style {
  if (!style) return {};
  if (Array.isArray(style)) {
    return style.reduce<Style>(
      (acc, entry) => ({ ...acc, ...flattenStyle(entry) }),
      {},
    );
  }
  if (typeof style === 'object') return style as Style;
  return {};
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function hitSlopOf(value: unknown): { v: number; h: number } {
  if (typeof value === 'number') return { v: value * 2, h: value * 2 };
  if (value && typeof value === 'object') {
    const insets = value as Record<string, number | undefined>;
    return {
      v: (insets['top'] ?? 0) + (insets['bottom'] ?? 0),
      h: (insets['left'] ?? 0) + (insets['right'] ?? 0),
    };
  }
  return { v: 0, h: 0 };
}

function textOf(node: HostNode | string): string {
  if (typeof node === 'string') return node;
  return (node.children ?? []).map(textOf).join('');
}

function isInteractive(node: HostNode): boolean {
  if (node.type === 'TextInput') return true;
  // `accessible={false}` marks a deliberately non-focusable surface (the
  // dialog scrim whose tap-to-dismiss duplicates the labelled Close button).
  if (node.props['accessible'] === false) return false;
  return (
    typeof node.props['onClick'] === 'function' ||
    typeof node.props['onPress'] === 'function' ||
    (typeof node.props['onResponderGrant'] === 'function' &&
      node.props['accessible'] === true)
  );
}

interface A11yViolation {
  kind: 'missing_role' | 'missing_label' | 'target_too_small' | 'unmeasurable';
  type: string;
  role: string | undefined;
  label: string | undefined;
  detail: string;
  style: Style;
}

interface LayoutFlag {
  text: string;
  fontSize: number;
  scaledFontSize: number;
  scaledLineHeight: number;
  estimatedLines: number;
  needed: number;
  box: { width?: number; height?: number };
  overflowPt: number;
}

/**
 * Estimated advance width for Manrope glyphs (semibold digits/caps ~0.62em,
 * lowercase ~0.55em, CJK 1em, combining marks 0). Deliberately simple and
 * documented so the model is inspectable; it is INFERRED evidence.
 */
function estimateTextWidth(
  text: string,
  fontSize: number,
  letterSpacing: number,
): number {
  let width = 0;
  for (const ch of Array.from(text)) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x300 && cp <= 0x36f) continue; // combining
    if (cp >= 0x2e80 && cp <= 0x9fff) width += fontSize;
    else if (/[0-9A-Z]/.test(ch)) width += fontSize * 0.62;
    else if (ch === ' ') width += fontSize * 0.28;
    else width += fontSize * 0.55;
    width += letterSpacing;
  }
  return width;
}

function audit(tree: HostNode | null, fontScale: number) {
  const a11y: A11yViolation[] = [];
  const layout: LayoutFlag[] = [];
  const interactive: Array<{
    type: string;
    role: string | undefined;
    label: string | undefined;
    minTarget: { w: number | 'stretch'; h: number | 'unknown' };
  }> = [];
  if (!tree) return { a11y, layout, interactive };

  const walk = (node: HostNode | string, ancestors: HostNode[]) => {
    if (typeof node === 'string') return;
    const style = flattenStyle(node.props['style']);
    if (isInteractive(node)) {
      const role =
        (node.props['accessibilityRole'] as string | undefined) ??
        (node.props['role'] as string | undefined);
      const label =
        (node.props['accessibilityLabel'] as string | undefined) ??
        (textOf(node).trim() || undefined);
      const slop = hitSlopOf(node.props['hitSlop']);
      const height = num(style['height']) ?? num(style['minHeight']);
      const width = num(style['width']) ?? num(style['minWidth']);
      // A pressable whose size is not pinned inherits the parent's fixed box
      // (e.g. a 44×44 header cell or the Button's minHeight wrapper).
      const parentStyle = flattenStyle(
        ancestors[ancestors.length - 1]?.props['style'],
      );
      const inheritedHeight =
        height ?? num(parentStyle['height']) ?? num(parentStyle['minHeight']);
      const effectiveH =
        inheritedHeight === undefined ? undefined : inheritedHeight + slop.v;
      const effectiveW = width === undefined ? 'stretch' : width + slop.h;
      interactive.push({
        type: node.type,
        role,
        label,
        minTarget: {
          w: effectiveW,
          h: effectiveH ?? 'unknown',
        },
      });
      if (node.type !== 'TextInput' && !role) {
        a11y.push({
          kind: 'missing_role',
          type: node.type,
          role,
          label,
          detail: 'no accessibilityRole',
          style,
        });
      }
      if (!label) {
        a11y.push({
          kind: 'missing_label',
          type: node.type,
          role,
          label,
          detail: 'no accessibilityLabel and no text content',
          style,
        });
      }
      if (effectiveH === undefined) {
        a11y.push({
          kind: 'unmeasurable',
          type: node.type,
          role,
          label,
          detail: 'no fixed/min height on node or parent',
          style,
        });
      } else if (effectiveH < 44) {
        a11y.push({
          kind: 'target_too_small',
          type: node.type,
          role,
          label,
          detail: `effective height ${effectiveH}pt < 44`,
          style,
        });
      }
      if (effectiveW !== 'stretch' && effectiveW < 44) {
        a11y.push({
          kind: 'target_too_small',
          type: node.type,
          role,
          label,
          detail: `effective width ${effectiveW}pt < 44`,
          style,
        });
      }
    }

    if (node.type === 'Text') {
      const text = textOf(node);
      const fontSize = num(style['fontSize']);
      const lineHeight =
        num(style['lineHeight']) ?? (fontSize ? fontSize * 1.2 : undefined);
      const allowScaling = node.props['allowFontScaling'] !== false;
      const maxMult = num(node.props['maxFontSizeMultiplier']);
      const mult = allowScaling
        ? maxMult && maxMult > 0
          ? Math.min(fontScale, maxMult)
          : fontScale
        : 1;
      if (text && fontSize && lineHeight) {
        const scaledFontSize = fontSize * mult;
        const scaledLineHeight = lineHeight * mult;
        // Nearest fixed box: the Text itself or the closest ancestor with a
        // numeric height/width.
        const boxes = [
          style,
          ...ancestors.map(a => flattenStyle(a.props['style'])).reverse(),
        ];
        const fixedH = boxes
          .map(b => num(b['height']))
          .find(v => v !== undefined);
        const fixedW = boxes
          .map(b => num(b['width']))
          .find(v => v !== undefined);
        if (fixedH !== undefined || fixedW !== undefined) {
          const letterSpacing = num(style['letterSpacing']) ?? 0;
          const textWidth = estimateTextWidth(
            text,
            scaledFontSize,
            letterSpacing,
          );
          const lines =
            fixedW !== undefined && fixedW > 0
              ? Math.max(1, Math.ceil(textWidth / fixedW))
              : 1;
          const needed = lines * scaledLineHeight;
          const overflow = fixedH !== undefined ? needed - fixedH : 0;
          if (overflow > 0.5) {
            layout.push({
              text,
              fontSize,
              scaledFontSize: Math.round(scaledFontSize * 100) / 100,
              scaledLineHeight: Math.round(scaledLineHeight * 100) / 100,
              estimatedLines: lines,
              needed: Math.round(needed * 100) / 100,
              box: { width: fixedW, height: fixedH },
              overflowPt: Math.round(overflow * 100) / 100,
            });
          }
        }
      }
    }

    for (const child of node.children ?? []) walk(child, [...ancestors, node]);
  };
  walk(tree, []);
  return { a11y, layout, interactive };
}

function hostTree(renderer: Renderer): HostNode | null {
  const json = renderer.toJSON();
  if (!json) return null;
  return (Array.isArray(json) ? json[0] : json) as unknown as HostNode;
}

/** Stable tree fingerprint: types + accessibility + text, functions dropped. */
function fingerprint(tree: HostNode | null): string {
  const scrub = (node: HostNode | string): unknown => {
    if (typeof node === 'string') return node;
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node.props)) {
      if (typeof value === 'function') continue;
      if (key === 'style') continue;
      props[key] = value;
    }
    return { t: node.type, p: props, c: (node.children ?? []).map(scrub) };
  };
  return createHash('sha256')
    .update(JSON.stringify(tree ? scrub(tree) : null))
    .digest('hex')
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Render + drive helpers
// ---------------------------------------------------------------------------

function allText(renderer: Renderer): string {
  return textLines(renderer).join('\n');
}

/** One entry per <Text>, its string children concatenated. */
function textLines(renderer: Renderer): string[] {
  return renderer.root.findAllByType(Text).map(node =>
    (Array.isArray(node.props.children)
      ? node.props.children
      : [node.props.children]
    )
      .flat()
      .filter((c: unknown): c is string => typeof c === 'string')
      .join(''),
  );
}

function radioLabels(renderer: Renderer): string[] {
  return renderer.root
    .findAll(
      node =>
        node.props?.accessibilityRole === 'radio' &&
        typeof node.props?.onPress === 'function' &&
        typeof node.props?.accessibilityLabel === 'string',
    )
    .map(node => node.props.accessibilityLabel as string)
    .filter((label, index, all) => all.indexOf(label) === index);
}

function isAncestor(
  ancestor: TestRenderer.ReactTestInstance,
  node: TestRenderer.ReactTestInstance,
): boolean {
  let current = node.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function pressables(renderer: Renderer, label: string) {
  const matches = renderer.root.findAll(
    node =>
      node.props?.accessibilityLabel === label &&
      typeof node.props?.onPress === 'function',
  );
  return matches.filter(
    node => !matches.some(other => other !== node && isAncestor(node, other)),
  );
}

function findPressable(renderer: Renderer, label: string) {
  const nodes = pressables(renderer, label);
  if (nodes.length !== 1) {
    throw new Error(
      `expected exactly one pressable labelled ${JSON.stringify(label)}, found ${nodes.length}`,
    );
  }
  return nodes[0]!;
}

function press(renderer: Renderer, label: string) {
  const node = findPressable(renderer, label);
  if (node.props.disabled) {
    throw new Error(`pressable ${JSON.stringify(label)} is disabled`);
  }
  act(() => {
    node.props.onPress();
  });
}

function isDisabled(renderer: Renderer, label: string): boolean {
  return Boolean(findPressable(renderer, label).props.disabled);
}

function progressNow(renderer: Renderer): number | null {
  const bars = renderer.root.findAll(
    n => n.props?.accessibilityRole === 'progressbar',
  );
  const bar = bars[0];
  return bar ? (bar.props.accessibilityValue.now as number) : null;
}

/**
 * The test renderer has no native text layer, so `maxLength` is emulated the
 * way UIKit applies it (UTF-16 units, never splitting a surrogate pair).
 * INFERRED from RN's RCTBaseTextInputView; the on-device truncation point for
 * multi-unit graphemes may differ by a code point.
 */
function applyMaxLength(text: string, maxLength: number | undefined): string {
  if (maxLength === undefined || text.length <= maxLength) return text;
  let cut = maxLength;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return text.slice(0, cut);
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  });
}

const CANONICAL_ID = '55555555-5555-4555-8555-555555555555';
let dateNowSpy: jest.SpyInstance<number, []> | null = null;

function resetWorld(variant: Variant) {
  mockKv.clear();
  mockDbControl.writeError = null;
  mockDbControl.writes = 0;
  mockScheduler.permission = 'undetermined';
  mockScheduler.requestResult =
    variant.notification === 'denied' ? 'denied' : 'granted';
  mockScheduler.requestError =
    variant.notification === 'error'
      ? new Error('UNUserNotificationCenter unavailable')
      : null;
  mockScheduler.requestCalls = 0;
  mockScheduler.appliedPlans = [];
  fetchControl.mode = 'ok';
  fetchControl.log = [];
  mockSignOut.mockClear();
  mockInsets.current = { ...variant.insets };
  Dimensions.set({
    window: {
      width: variant.width,
      height: variant.height,
      scale: 3,
      fontScale: variant.fontScale,
    },
    screen: {
      width: variant.width,
      height: variant.height,
      scale: 3,
      fontScale: variant.fontScale,
    },
  });
  process.env.TZ = variant.timezone;
  dateNowSpy?.mockRestore();
  dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(variant.nowMs);
  Object.defineProperty(I18nManager, 'isRTL', {
    value: variant.rtl,
    configurable: true,
  });
  clearApiSession();
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
  });
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
  });
  if (variant.mode === 'account') {
    mockAuthPlan.session = {
      provider: 'apple',
      canonicalAppUserId: CANONICAL_ID,
    };
    establishApiSession({
      apiBaseUrl: 'https://edge.test.invalid',
      bearerToken: 'test-bearer',
      canonicalAppUserId: CANONICAL_ID,
      provider: 'apple',
    });
  } else {
    mockAuthPlan.session = null;
  }
}

interface StepEvidence {
  step: string;
  progressNow: number | null;
  a11y: A11yViolation[];
  layout: LayoutFlag[];
  interactiveCount: number;
  fingerprint: string;
}

interface Outcome {
  seed: number;
  variant: Omit<Variant, 'name'> & {
    name: string;
    nameUtf16: number;
    nameCodePoints: number;
  };
  icuLocale: string;
  /** What the native field would hold after `maxLength` (see applyMaxLength). */
  typedName: string;
  nameTruncatedByMaxLength: boolean;
  answers: string[];
  steps: StepEvidence[];
  crashed: string | null;
  continueGateCorrect: boolean;
  revealCopy: string | null;
  revealCopyCorrect: boolean;
  finishReached: boolean;
  stashedFirstName: string | null | undefined;
  putFirstName: string | null | undefined;
  putStatuses: number[];
  serverAcceptedName: boolean | null;
  serverCleanedName: string | null;
  localServerNameDiverge: boolean;
  localProfileFirstName: string | null;
  localProfileGender: string | null;
  identityDroppedOnRetry: boolean;
  completedTo:
    'signin' | 'root_navigator' | 'error_shown' | 'onboarding' | 'unknown';
  a11yViolationCount: number;
  layoutFlagCount: number;
  localeApiCalls: number;
  localeApiCallsDuringSteps: number | null;
  localeApiCallers: Record<string, number>;
  localeApiStacks: Record<string, string>;
  checks: Record<string, 'held' | 'broken'>;
}

const STEP_NAMES = [
  'name',
  'gender',
  'level',
  'handedness',
  'goal',
  'problem',
  'reveal',
  'notifications',
];

async function runVariant(
  variantIn: Variant,
): Promise<{ outcome: Outcome; trees: Record<string, HostNode | null> }> {
  const variant = materialize(variantIn);
  resetWorld(variant);
  // Resolved BEFORE the spies go up so the harness's own probe is not counted.
  const icuLocale = Intl.DateTimeFormat().resolvedOptions().locale;
  const localeStacks: Record<string, string> = {};
  const traced = <T extends object, K extends keyof T & string>(
    label: string,
    target: T,
    key: K,
  ) => {
    const original = target[key] as unknown as (...args: unknown[]) => unknown;
    const spy = jest.spyOn(target, key as never) as unknown as jest.SpyInstance<
      unknown,
      unknown[]
    >;
    spy.mockImplementation(function (this: unknown, ...args: unknown[]) {
      if (!localeStacks[label]) {
        localeStacks[label] = (new Error().stack ?? '')
          .split('\n')
          .slice(2, 9)
          .map(line => line.trim().replace(/^at /, ''))
          .filter(
            line =>
              !line.includes('node_modules/jest') &&
              !line.includes('stress.test'),
          )
          .join(' <- ');
      }
      return new.target
        ? Reflect.construct(
            original as unknown as new (...a: unknown[]) => unknown,
            args,
            new.target,
          )
        : original.apply(this, args);
    });
    return [label, spy] as const;
  };
  const localeSpies = [
    traced('Intl.DateTimeFormat', Intl, 'DateTimeFormat'),
    traced('Intl.NumberFormat', Intl, 'NumberFormat'),
    traced('Date#toLocaleString', Date.prototype, 'toLocaleString'),
    traced('Date#toLocaleDateString', Date.prototype, 'toLocaleDateString'),
    traced('Date#toLocaleTimeString', Date.prototype, 'toLocaleTimeString'),
    traced('Number#toLocaleString', Number.prototype, 'toLocaleString'),
    traced('String#toLocaleUpperCase', String.prototype, 'toLocaleUpperCase'),
    traced('String#toLocaleLowerCase', String.prototype, 'toLocaleLowerCase'),
    traced('String#localeCompare', String.prototype, 'localeCompare'),
  ];

  const trees: Record<string, HostNode | null> = {};
  const steps: StepEvidence[] = [];
  let typed = variant.name;
  let trimmed = typed.trim();
  const outcome: Outcome = {
    seed: variant.seed,
    variant: {
      ...variant,
      nameUtf16: variant.name.length,
      nameCodePoints: Array.from(variant.name).length,
    },
    icuLocale,
    typedName: typed,
    nameTruncatedByMaxLength: false,
    answers: [],
    steps,
    crashed: null,
    continueGateCorrect: true,
    revealCopy: null,
    revealCopyCorrect: true,
    finishReached: false,
    stashedFirstName: undefined,
    putFirstName: undefined,
    putStatuses: [],
    serverAcceptedName: null,
    serverCleanedName: null,
    localServerNameDiverge: false,
    localProfileFirstName: null,
    localProfileGender: null,
    identityDroppedOnRetry: false,
    completedTo: 'unknown',
    a11yViolationCount: 0,
    layoutFlagCount: 0,
    localeApiCalls: 0,
    localeApiCallsDuringSteps: null,
    localeApiCallers: {},
    localeApiStacks: localeStacks,
    checks: {},
  };

  let renderer!: Renderer;
  const record = (step: string) => {
    const tree = hostTree(renderer);
    trees[step] = tree;
    const result = audit(tree, variant.fontScale);
    steps.push({
      step,
      progressNow: progressNow(renderer),
      a11y: result.a11y,
      layout: result.layout,
      interactiveCount: result.interactive.length,
      fingerprint: fingerprint(tree),
    });
  };

  try {
    act(() => {
      renderer = TestRenderer.create(<App />);
    });
    await flush();
    if (variant.mode === 'preauth') {
      if (!allText(renderer).includes('See the stroke.')) {
        throw new Error(
          `welcome not reached: ${allText(renderer).slice(0, 200)}`,
        );
      }
      press(renderer, 'Start your first read');
    }
    await flush();
    if (progressNow(renderer) !== 1) {
      throw new Error(
        `onboarding step 1 not reached: ${allText(renderer).slice(0, 200)}`,
      );
    }

    // Step 1: name
    record('name:empty');
    if (!isDisabled(renderer, 'Continue')) {
      outcome.continueGateCorrect = false;
    }
    const input = renderer.root.findByType(TextInput);
    typed = applyMaxLength(
      variant.name,
      input.props.maxLength as number | undefined,
    );
    trimmed = typed.trim();
    outcome.typedName = typed;
    outcome.nameTruncatedByMaxLength = typed !== variant.name;
    act(() => input.props.onChangeText(typed));
    record('name');
    const gateShouldBeOpen = trimmed.length >= 1;
    if (isDisabled(renderer, 'Continue') === gateShouldBeOpen) {
      outcome.continueGateCorrect = false;
    }
    if (!gateShouldBeOpen) {
      // Boundary: empty / whitespace-only names must not pass. Give the seed a
      // real name to keep exercising the later steps.
      act(() => renderer.root.findByType(TextInput).props.onChangeText('Dana'));
    }
    press(renderer, 'Continue');

    // Steps 2-6: single-choice questions, with an optional backtrack.
    for (let i = 0; i < variant.answerRatios.length; i += 1) {
      const stepIndex = i + 1;
      if (progressNow(renderer) !== stepIndex + 1) {
        throw new Error(
          `expected progress ${stepIndex + 1} at ${STEP_NAMES[stepIndex]}`,
        );
      }
      record(`${STEP_NAMES[stepIndex]}:unselected`);
      if (!isDisabled(renderer, 'Continue'))
        outcome.continueGateCorrect = false;
      const options = radioLabels(renderer);
      if (options.length < 2) {
        throw new Error(
          `${STEP_NAMES[stepIndex]} exposes ${options.length} radio options`,
        );
      }
      const choice =
        options[
          Math.min(
            options.length - 1,
            Math.floor(variant.answerRatios[i]! * options.length),
          )
        ]!;
      outcome.answers.push(choice);
      press(renderer, choice);
      record(STEP_NAMES[stepIndex]!);
      if (isDisabled(renderer, 'Continue')) outcome.continueGateCorrect = false;
      if (variant.backtrackAtStep === stepIndex) {
        press(renderer, 'Back');
        if (progressNow(renderer) !== stepIndex) {
          throw new Error(
            `Back from step ${stepIndex + 1} did not return to ${stepIndex}`,
          );
        }
        record(`${STEP_NAMES[stepIndex - 1]}:after-back`);
        press(renderer, 'Continue');
        // Selection must survive the round-trip.
        if (isDisabled(renderer, 'Continue'))
          outcome.continueGateCorrect = false;
      }
      press(renderer, 'Continue');
    }

    // Reveal
    if (progressNow(renderer) !== 7) throw new Error('reveal not reached');
    record('reveal');
    const effectiveName = gateShouldBeOpen ? trimmed : 'Dana';
    const builtFor = textLines(renderer).find(line =>
      line.startsWith('Built for '),
    );
    outcome.revealCopy = builtFor ?? null;
    outcome.revealCopyCorrect = builtFor === `Built for ${effectiveName}.`;
    press(renderer, 'Continue');

    // Notifications
    if (progressNow(renderer) !== 8)
      throw new Error('notifications not reached');
    record('notifications');
    if (variant.dbWriteFails) {
      mockDbControl.writeError = new Error(
        'SQLITE_FULL: database or disk is full',
      );
    }
    fetchControl.mode = variant.fetch;
    // Locale calls made by the screen itself (steps 1-8) are the unit's
    // invariant; anything after the finish press belongs to the stores /
    // next screen and is only recorded.
    outcome.localeApiCallsDuringSteps = localeSpies.reduce(
      (n, [, spy]) => n + spy.mock.calls.length,
      0,
    );
    press(
      renderer,
      variant.finish === 'enable' ? 'Turn on reminders' : 'Not now',
    );
    await flush();
    await flush();
    outcome.finishReached = true;
    const afterText = allText(renderer);
    if (afterText.includes('ROOT_NAVIGATOR'))
      outcome.completedTo = 'root_navigator';
    else if (afterText.includes('tied to you.')) outcome.completedTo = 'signin';
    else if (progressNow(renderer) === 8) {
      outcome.completedTo =
        useAppStore.getState().onboardingError ||
        useNotificationStore.getState().persistFailed
          ? 'error_shown'
          : 'onboarding';
      record('notifications:after-finish');
    }

    const stash = mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY);
    if (stash) {
      const parsed = JSON.parse(stash) as { profile?: { firstName?: string } };
      outcome.stashedFirstName = parsed.profile?.firstName ?? null;
    }
    const puts = fetchControl.log.filter(e => e.method === 'PUT');
    outcome.putStatuses = puts.map(e => e.status);
    const firstPut = puts[0];
    if (firstPut) {
      const sent = firstPut.body?.['firstName'];
      outcome.putFirstName = typeof sent === 'string' ? sent : null;
      if (typeof sent === 'string') {
        const cleaned = sanitizeUserText(sent, 200);
        outcome.serverCleanedName = cleaned;
        outcome.serverAcceptedName =
          cleaned.length >= 1 && cleaned.length <= 40;
        outcome.localServerNameDiverge = cleaned !== sent;
      }
      const retry = puts[1];
      if (
        retry &&
        retry.status === 200 &&
        retry.body &&
        !('firstName' in retry.body) &&
        !('gender' in retry.body)
      ) {
        outcome.identityDroppedOnRetry = true;
      }
    }
    if (variant.mode === 'account') {
      const local = useAppStore.getState().profile;
      outcome.localProfileFirstName = local?.firstName ?? null;
      outcome.localProfileGender = local?.gender ?? null;
      if (
        local &&
        outcome.serverCleanedName !== null &&
        local.firstName !== outcome.serverCleanedName
      ) {
        outcome.localServerNameDiverge = true;
      }
    }
  } catch (error) {
    outcome.crashed =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    if (renderer) trees['crash'] = hostTree(renderer);
  } finally {
    for (const [name, spy] of localeSpies) {
      if (spy.mock.calls.length > 0)
        outcome.localeApiCallers[name] = spy.mock.calls.length;
      outcome.localeApiCalls += spy.mock.calls.length;
      spy.mockRestore();
    }
    dateNowSpy?.mockRestore();
    dateNowSpy = null;
    Object.defineProperty(I18nManager, 'isRTL', {
      value: false,
      configurable: true,
    });
    if (renderer) {
      act(() => renderer.unmount());
    }
    await flush();
  }

  const a11yViolations = steps.flatMap(s => s.a11y);
  outcome.a11yViolationCount = a11yViolations.length;
  outcome.layoutFlagCount = steps.reduce((n, s) => n + s.layout.length, 0);
  const rootErrorShown = Object.values(trees).some(
    t => t && textOf(t).includes('Something went wrong'),
  );
  outcome.checks = {
    no_crash: outcome.crashed || rootErrorShown ? 'broken' : 'held',
    continue_gate: outcome.continueGateCorrect ? 'held' : 'broken',
    reveal_copy: outcome.revealCopyCorrect ? 'held' : 'broken',
    a11y_role_label_target: a11yViolations.length === 0 ? 'held' : 'broken',
    finish_reached: outcome.finishReached ? 'held' : 'broken',
    layout_model_no_overflow: outcome.layoutFlagCount === 0 ? 'held' : 'broken',
    name_reaches_server_unchanged:
      outcome.putFirstName === undefined || !outcome.localServerNameDiverge
        ? 'held'
        : 'broken',
    locale_api_untouched_during_steps:
      (outcome.localeApiCallsDuringSteps ?? outcome.localeApiCalls) === 0
        ? 'held'
        : 'broken',
  };
  return { outcome, trees };
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

const ITER = Math.max(1, Number(process.env['STRESS_ITER'] ?? 24) || 24);
const SEED_BASE = Number(process.env['STRESS_SEED_BASE'] ?? 1000) || 1000;
const ONLY_SEED = process.env['STRESS_SEED']
  ? Number(process.env['STRESS_SEED'])
  : null;
const OUT_ROOT =
  process.env['STRESS_OUT'] ??
  path.resolve(__dirname, '..', '..', '..', '..', 'artifacts', 'stress');
const RUN_ID =
  process.env['STRESS_RUN_ID'] ??
  `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const OUT_DIR = path.join(OUT_ROOT, 'onboarding-boundary-i18n-a11y', RUN_ID);

const seeds =
  ONLY_SEED !== null
    ? [ONLY_SEED]
    : Array.from({ length: ITER }, (_, i) => SEED_BASE + i);
const outcomes: Outcome[] = [];
const failingTrees: Record<string, Record<string, HostNode | null>> = {};
const KNOWN_BROKEN = new Set([
  'layout_model_no_overflow',
  'name_reaches_server_unchanged',
]);

beforeAll(() => {
  jest.spyOn(globalThis, 'fetch').mockImplementation(fakeEdgeFetch);
});

afterAll(() => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const byCheck: Record<
    string,
    { held: number; broken: number; brokenSeeds: number[] }
  > = {};
  for (const o of outcomes) {
    for (const [check, state] of Object.entries(o.checks)) {
      const bucket = (byCheck[check] ??= {
        held: 0,
        broken: 0,
        brokenSeeds: [],
      });
      bucket[state] += 1;
      if (state === 'broken') bucket.brokenSeeds.push(o.seed);
    }
  }
  const summary = {
    runId: RUN_ID,
    icuLocale: Intl.DateTimeFormat().resolvedOptions().locale,
    env: {
      LANG: process.env['LANG'] ?? null,
      LC_ALL: process.env['LC_ALL'] ?? null,
      node: process.version,
    },
    iterations: outcomes.length,
    renderedVariants: outcomes.reduce((n, o) => n + o.steps.length, 0),
    byCheck,
    nameKindsCovered: Array.from(
      new Set(outcomes.map(o => o.variant.nameKind)),
    ).sort(),
    fontScalesCovered: Array.from(
      new Set(outcomes.map(o => o.variant.fontScale)),
    ).sort(),
    widthsCovered: Array.from(
      new Set(outcomes.map(o => o.variant.width)),
    ).sort(),
    timezonesCovered: Array.from(
      new Set(outcomes.map(o => o.variant.timezone)),
    ).sort(),
    modesCovered: Array.from(new Set(outcomes.map(o => o.variant.mode))).sort(),
    nameStepFingerprints: Array.from(
      new Set(
        outcomes.flatMap(o =>
          o.steps.filter(s => s.step === 'name:empty').map(s => s.fingerprint),
        ),
      ),
    ),
  };
  fs.writeFileSync(
    path.join(OUT_DIR, 'summary.json'),
    JSON.stringify(summary, null, 2),
  );
  fs.writeFileSync(
    path.join(OUT_DIR, 'results.json'),
    JSON.stringify(
      outcomes.map(o => ({
        ...o,
        steps: o.steps.map(s => ({
          step: s.step,
          progressNow: s.progressNow,
          fingerprint: s.fingerprint,
          interactiveCount: s.interactiveCount,
          a11y: s.a11y.map(v => ({ ...v, style: undefined })),
          layout: s.layout,
        })),
      })),
      null,
      1,
    ),
  );
  for (const [seed, trees] of Object.entries(failingTrees)) {
    fs.writeFileSync(
      path.join(OUT_DIR, `tree-seed-${seed}.json`),
      JSON.stringify(
        trees,
        (_k, v) => (typeof v === 'function' ? '[fn]' : v),
        1,
      ),
    );
  }
  console.log(
    `[stress:onboarding] wrote ${outcomes.length} outcomes to ${OUT_DIR}`,
  );
});

describe(`OnboardingScreen boundary/i18n/a11y campaign (${seeds.length} seeds from ${seeds[0]})`, () => {
  for (const seed of seeds) {
    const preview = variantFor(seed);
    it(`seed ${seed} — ${preview.mode} ${preview.width}w ×${preview.fontScale} ${preview.timezone} ${preview.nameKind}${preview.rtl ? ' rtl' : ''}`, async () => {
      const { outcome, trees } = await runVariant(preview);
      outcomes.push(outcome);
      const broken = Object.entries(outcome.checks).filter(
        ([, s]) => s === 'broken',
      );
      if (broken.length > 0) {
        // Full 16-step tree only for surprises; the two catalogued defects
        // (see the FINDING describes) keep the steps that evidence them so a
        // 200-seed run stays in the low tens of MB.
        const surprise = broken.some(([check]) => !KNOWN_BROKEN.has(check));
        failingTrees[String(seed)] = surprise
          ? trees
          : { name: trees['name'] ?? null, reveal: trees['reveal'] ?? null };
      }

      // Invariants that must hold on every seed (HELD / BROKEN adjudicated
      // per check; the ones below are the ones the screen is expected to
      // satisfy today — anything else is reported through results.json and
      // the dedicated finding tests further down).
      expect(outcome.crashed).toBeNull();
      expect(outcome.checks['no_crash']).toBe('held');
      expect(outcome.checks['continue_gate']).toBe('held');
      expect(outcome.checks['reveal_copy']).toBe('held');
      expect(outcome.checks['finish_reached']).toBe('held');
      expect(outcome.checks['a11y_role_label_target']).toBe('held');
      expect(outcome.checks['locale_api_untouched_during_steps']).toBe('held');
      // Every step exposes the progressbar with a coherent value.
      for (const step of outcome.steps) {
        if (step.step.startsWith('notifications:after')) continue;
        expect(step.progressNow).toBeGreaterThanOrEqual(1);
        expect(step.progressNow).toBeLessThanOrEqual(8);
        expect(step.interactiveCount).toBeGreaterThan(0);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Cross-seed invariants (evaluated over the campaign that just ran)
// ---------------------------------------------------------------------------

describe('cross-seed invariants', () => {
  it('the rendered onboarding tree is byte-identical across all 8 timezones, DST instants, widths, insets and RTL flags (screen has no locale/date logic)', () => {
    const fingerprints = new Set(
      outcomes.flatMap(o =>
        o.steps.filter(s => s.step === 'name:empty').map(s => s.fingerprint),
      ),
    );
    // One fingerprint per mode (account mode shows "Leave setup" instead of
    // "Back" on step one) — nothing else may change the tree.
    const modes = new Set(outcomes.map(o => o.variant.mode));
    expect(fingerprints.size).toBeLessThanOrEqual(modes.size);
    expect(fingerprints.size).toBeGreaterThan(0);
  });

  it('every completed pre-auth seed stashes exactly the trimmed name (or omits it) and lands on sign-in', () => {
    for (const o of outcomes) {
      if (o.variant.mode !== 'preauth' || o.crashed) continue;
      if (o.variant.dbWriteFails) {
        expect(o.completedTo).toBe('error_shown');
        continue;
      }
      expect(o.completedTo).toBe('signin');
      const trimmed = o.typedName.trim();
      expect(o.stashedFirstName).toBe(trimmed.length >= 1 ? trimmed : 'Dana');
    }
  });

  it('every completed account seed either lands on the navigator (server ok) or shows a recoverable error (server/network failure)', () => {
    for (const o of outcomes) {
      if (o.variant.mode !== 'account' || o.crashed) continue;
      if (o.variant.fetch === 'ok' && !o.variant.dbWriteFails) {
        expect(o.completedTo).toBe('root_navigator');
        expect(o.putStatuses[o.putStatuses.length - 1]).toBe(200);
      } else {
        expect(o.completedTo).toBe('error_shown');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Findings — minimized deterministic repros. `it.failing` encodes a BROKEN
// invariant: jest passes while the defect stands and fails the moment the
// production code fixes it (at which point drop `.failing`).
// ---------------------------------------------------------------------------

describe('server boundary mirror', () => {
  it('production sanitizer source is what this harness mirrors', () => {
    expect(HTTP_TS_SOURCE).toContain(SANITIZE_PIPELINE_SOURCE);
    expect(sanitizeUserText(' \u200b\u200f Dana\u202e  ', 200)).toBe('Dana');
    expect(sanitizeUserText('\u2060', 200)).toBe('\u2060');
    expect(sanitizeUserText('\ud83d', 200)).toBe('');
  });
});

describe('FINDING: client first-name gate vs server sanitizer', () => {
  it.failing(
    'a zero-width-only name must not pass the Continue gate (server sanitizes it to empty)',
    async () => {
      const variant: Variant = {
        ...variantFor(1),
        mode: 'account',
        nameKind: 'zero_width_only',
        fetch: 'ok',
        dbWriteFails: false,
        backtrackAtStep: null,
        notification: 'granted',
      };
      const { outcome } = await runVariant(variant);
      outcomes.push(outcome);
      // Client accepted the name (gate opened, reveal shows "Built for <zw>.")
      // and the server rejected it — the invariant "what the client shows is
      // what the server keeps" is what this test asserts.
      expect(outcome.crashed).toBeNull();
      expect(outcome.serverAcceptedName).not.toBe(false);
    },
  );

  it.failing(
    'when the server rejects the name, the retry must not silently drop the gender answer as well',
    async () => {
      const variant: Variant = {
        ...variantFor(2),
        mode: 'account',
        nameKind: 'zero_width_only',
        fetch: 'ok',
        dbWriteFails: false,
        backtrackAtStep: null,
        notification: 'granted',
      };
      const { outcome } = await runVariant(variant);
      outcomes.push(outcome);
      expect(outcome.crashed).toBeNull();
      expect(outcome.identityDroppedOnRetry).toBe(false);
    },
  );

  it.failing(
    'an invisible-only name (U+2060 WORD JOINER etc.) must be rejected by at least one side; today both accept it',
    async () => {
      const variant: Variant = {
        ...variantFor(4),
        mode: 'account',
        nameKind: 'invisible_unstripped',
        fetch: 'ok',
        dbWriteFails: false,
        backtrackAtStep: null,
        notification: 'granted',
      };
      const { outcome } = await runVariant(variant);
      outcomes.push(outcome);
      expect(outcome.crashed).toBeNull();
      // Client gate opened (trim() keeps default-ignorables), reveal reads
      // "Built for <invisible>." and the server stored it (sanitizeUserText's
      // strip set covers U+200B-200F/202A-202E/2066-2069/FEFF but not U+2060,
      // U+00AD, U+034F, U+061C, U+180E, U+FE0F, U+3164).
      expect(outcome.serverAcceptedName).toBe(false);
    },
  );

  it.failing(
    'a bidi-control name is stored locally as typed while the server keeps the sanitized form',
    async () => {
      const variant: Variant = {
        ...variantFor(3),
        mode: 'account',
        nameKind: 'bidi_control',
        fetch: 'ok',
        dbWriteFails: false,
        backtrackAtStep: null,
        notification: 'granted',
      };
      const { outcome } = await runVariant(variant);
      outcomes.push(outcome);
      expect(outcome.crashed).toBeNull();
      expect(outcome.completedTo).toBe('root_navigator');
      expect(outcome.localServerNameDiverge).toBe(false);
    },
  );

  it.failing(
    'a ZWJ emoji name reaches the server intact (sanitizeUserText strips U+200D and breaks the sequence)',
    async () => {
      const variant: Variant = {
        ...variantFor(5),
        mode: 'account',
        nameKind: 'zwj_emoji',
        fetch: 'ok',
        dbWriteFails: false,
        backtrackAtStep: null,
        notification: 'granted',
      };
      const { outcome } = await runVariant(variant);
      outcomes.push(outcome);
      expect(outcome.crashed).toBeNull();
      expect(outcome.completedTo).toBe('root_navigator');
      expect(outcome.serverCleanedName).toBe(outcome.typedName.trim());
    },
  );

  it.failing(
    'a Persian name written with ZWNJ (U+200C) is stored by the server as typed',
    async () => {
      const variant: Variant = {
        ...variantFor(6),
        mode: 'account',
        nameKind: 'persian_zwnj',
        fetch: 'ok',
        dbWriteFails: false,
        backtrackAtStep: null,
        notification: 'granted',
      };
      const { outcome } = await runVariant(variant);
      outcomes.push(outcome);
      expect(outcome.crashed).toBeNull();
      expect(outcome.completedTo).toBe('root_navigator');
      expect(outcome.serverCleanedName).toBe(outcome.typedName.trim());
      expect(outcome.localProfileFirstName).toBe(outcome.serverCleanedName);
    },
  );
});

describe('FINDING: fixed-height text boxes under Dynamic Type (layout model, INFERRED)', () => {
  function renderStandalone(fontScale: number) {
    Dimensions.set({
      window: { width: 375, height: 812, scale: 3, fontScale },
      screen: { width: 375, height: 812, scale: 3, fontScale },
    });
    let renderer!: Renderer;
    act(() => {
      renderer = TestRenderer.create(
        <OnboardingScreen
          mode="preauth"
          onFinished={() => {}}
          onBack={() => {}}
        />,
      );
    });
    return renderer;
  }

  it('at the default font scale no text overflows its fixed box', () => {
    const renderer = renderStandalone(1);
    const result = audit(hostTree(renderer), 1);
    act(() => renderer.unmount());
    expect(result.layout).toEqual([]);
  });

  it.failing(
    'the 44×44 step counter ("1/8", lineHeight 44) fits at xxLarge (×1.235)',
    () => {
      const renderer = renderStandalone(1.235);
      const result = audit(hostTree(renderer), 1.235);
      act(() => renderer.unmount());
      expect(result.layout.filter(f => f.text.includes('/8'))).toEqual([]);
    },
  );

  it.failing(
    'the 44×44 step counter fits at accessibility size AX3 (×2.35)',
    () => {
      const renderer = renderStandalone(2.35);
      const result = audit(hostTree(renderer), 2.35);
      act(() => renderer.unmount());
      expect(result.layout.filter(f => f.text.includes('/8'))).toEqual([]);
    },
  );
});

describe('boundary: props', () => {
  it('renders with no props, undefined mode and undefined callbacks (account defaults) and Back/Leave is a no-op without a handler', () => {
    Dimensions.set({
      window: { width: 375, height: 812, scale: 3, fontScale: 1 },
      screen: { width: 375, height: 812, scale: 3, fontScale: 1 },
    });
    for (const props of [
      {},
      { mode: undefined, onFinished: undefined, onBack: undefined },
      { mode: 'preauth' as const },
      { mode: 'preauth' as const, onBack: undefined, onFinished: undefined },
    ]) {
      let renderer!: Renderer;
      act(() => {
        renderer = TestRenderer.create(<OnboardingScreen {...props} />);
      });
      expect(progressNow(renderer)).toBe(1);
      const result = audit(hostTree(renderer), 1);
      expect(result.a11y).toEqual([]);
      if (props.mode === 'preauth') {
        press(renderer, 'Back');
        expect(progressNow(renderer)).toBe(1);
      } else {
        press(renderer, 'Leave setup');
        expect(allText(renderer)).toContain('Leave setup?');
        const dialog = audit(hostTree(renderer), 1);
        expect(dialog.a11y).toEqual([]);
      }
      act(() => renderer.unmount());
    }
  });
});
