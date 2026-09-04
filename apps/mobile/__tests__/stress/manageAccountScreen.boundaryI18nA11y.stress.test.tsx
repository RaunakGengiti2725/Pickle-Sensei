/**
 * STRESS — unit `scr-manageaccountscreen`, lens `boundary-i18n-a11y`.
 *
 * Renders the REAL ManageAccountScreen inside the real React Navigation
 * container + native-stack navigator (only `react-native-screens`'
 * native views are replaced by plain Views), the real safe-area contexts,
 * the real auth/api-session zustand stores and the real deletion client
 * (`fetch` is the only network seam mocked). Every iteration is derived
 * from ONE 32-bit seed (mulberry32) and drives a seeded journey:
 *
 *   session boundary (long / CJK / RTL / ZWJ / combining / German compound /
 *   empty / whitespace / null / undefined name+email, provider, localOnly,
 *   null session) × window width (375 / 393 / 430) × font scale
 *   (1.0 / 1.35 / 2.35) × locale (12) × dialog journey (skip / answer /
 *   comment / oversize comment / request / server failure / countdown /
 *   confirm / cancel branches) × header Back through the real navigator.
 *
 * Per rendered variant the audit checks, on the HOST tree:
 *   - every interactive host element has an accessibility label (or text
 *     content), a role, and an effective target ≥ 44 pt
 *     (height|minHeight + hitSlop, or absoluteFill);
 *   - missing/blank session values render the '—' placeholder;
 *   - the comment counter stays `n/500` in ASCII digits in every locale;
 *   - the survey payload put on the wire matches what was chosen;
 *   - the armed countdown reaches 0 after exactly 5 s under fake timers;
 *   - the real navigator pops back to Settings on header Back.
 * It also RECORDS (not asserts — Linux Jest has no Yoga layout) a heuristic
 * single-line clipping estimate for every `numberOfLines={1}` text and the
 * grapheme-vs-UTF-16 counter divergence, so the JSON table carries the
 * evidence for the report.
 *
 * Run (small default so it can live in the suite):
 *   cd apps/mobile && npx jest --ci --silent __tests__/stress/manageAccountScreen.boundaryI18nA11y
 * Campaign / replay / table:
 *   STRESS_ITER=400 STRESS_SEED=20260904 STRESS_OUT=/tmp/ma-stress.json npx jest --ci __tests__/stress/manageAccountScreen.boundaryI18nA11y
 *   STRESS_REPLAY=123456789,987654321 npx jest --ci __tests__/stress/manageAccountScreen.boundaryI18nA11y
 * Time zones are process-level in Jest: run once per zone, e.g.
 *   for tz in Pacific/Kiritimati Etc/GMT+12 Europe/Berlin America/New_York Pacific/Chatham Australia/Lord_Howe Asia/Kathmandu UTC; do TZ=$tz STRESS_ITER=20 npx jest --ci __tests__/stress/manageAccountScreen.boundaryI18nA11y || exit 1; done
 */
import React from 'react';
import {
  Dimensions,
  I18nManager,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import {
  createNavigationContainerRef,
  NavigationContainer,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

// react-native-screens is a native view library; the navigator's JS
// (@react-navigation/native-stack) stays real, only the native views become
// plain Views so the whole route stack renders as host nodes.
jest.mock('react-native-screens', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const HostView = RN.View as unknown as React.ComponentType<
    Record<string, unknown>
  >;
  const passthrough = (name: string) => {
    const C = ReactModule.forwardRef<
      unknown,
      { children?: React.ReactNode; style?: unknown }
    >((props, ref) =>
      ReactModule.createElement(
        HostView,
        { ...props, ref, testID: `rns:${name}` },
        props.children,
      ),
    );
    C.displayName = name;
    return C;
  };
  const noop = () => undefined;
  return {
    enableScreens: noop,
    enableFreeze: noop,
    screensEnabled: () => true,
    freezeEnabled: () => false,
    Screen: passthrough('Screen'),
    InnerScreen: passthrough('InnerScreen'),
    ScreenContext: ReactModule.createContext(passthrough('Screen')),
    ScreenStackHeaderConfig: passthrough('ScreenStackHeaderConfig'),
    ScreenStackHeaderSubview: passthrough('ScreenStackHeaderSubview'),
    ScreenStackHeaderLeftView: passthrough('ScreenStackHeaderLeftView'),
    ScreenStackHeaderCenterView: passthrough('ScreenStackHeaderCenterView'),
    ScreenStackHeaderRightView: passthrough('ScreenStackHeaderRightView'),
    ScreenStackHeaderBackButtonImage: passthrough(
      'ScreenStackHeaderBackButtonImage',
    ),
    ScreenStackHeaderSearchBarView: passthrough(
      'ScreenStackHeaderSearchBarView',
    ),
    SearchBar: passthrough('SearchBar'),
    ScreenContainer: passthrough('ScreenContainer'),
    ScreenStack: passthrough('ScreenStack'),
    ScreenStackItem: passthrough('ScreenStackItem'),
    FullWindowOverlay: passthrough('FullWindowOverlay'),
    ScreenFooter: passthrough('ScreenFooter'),
    ScreenContentWrapper: passthrough('ScreenContentWrapper'),
    isSearchBarAvailableForCurrentPlatform: false,
    executeNativeBackPress: () => true,
    compatibilityFlags: {
      isNewBackTitleImplementation: true,
      usesHeaderFlexboxImplementation: true,
      usesNewAndroidHeaderHeightImplementation: false,
    },
    featureFlags: { experiment: {} },
    useTransitionProgress: () => ({
      progress: new RN.Animated.Value(1),
      closing: new RN.Animated.Value(0),
      goingForward: new RN.Animated.Value(0),
    }),
  };
});

// Safe-area: real contexts (the navigator's SafeAreaProviderCompat consumes
// them); the native provider/view are replaced so insets come from the
// harness-controlled initialMetrics.
jest.mock('react-native-safe-area-context', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const actual = jest.requireActual<
    typeof import('react-native-safe-area-context')
  >('react-native-safe-area-context');
  const INSETS = { top: 47, bottom: 34, left: 0, right: 0 };
  const FRAME = { x: 0, y: 0, width: 393, height: 852 };
  const SafeAreaView = (props: {
    children?: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    edges?: ReadonlyArray<'top' | 'bottom' | 'left' | 'right'>;
  }) => {
    const insets =
      ReactModule.useContext(actual.SafeAreaInsetsContext) ?? INSETS;
    const edges = props.edges ?? ['top', 'bottom', 'left', 'right'];
    return ReactModule.createElement(
      RN.View,
      {
        testID: 'harness:SafeAreaView',
        style: [
          props.style,
          {
            paddingTop: edges.includes('top') ? insets.top : 0,
            paddingBottom: edges.includes('bottom') ? insets.bottom : 0,
            paddingLeft: edges.includes('left') ? insets.left : 0,
            paddingRight: edges.includes('right') ? insets.right : 0,
          },
        ],
      },
      props.children,
    );
  };
  return {
    ...actual,
    initialWindowMetrics: { frame: FRAME, insets: INSETS },
    SafeAreaView,
    SafeAreaProvider: (props: {
      children?: React.ReactNode;
      initialMetrics?: {
        frame: typeof FRAME;
        insets: typeof INSETS;
      } | null;
    }) =>
      ReactModule.createElement(
        actual.SafeAreaFrameContext.Provider,
        { value: props.initialMetrics?.frame ?? FRAME },
        ReactModule.createElement(
          actual.SafeAreaInsetsContext.Provider,
          { value: props.initialMetrics?.insets ?? INSETS },
          props.children,
        ),
      ),
    useSafeAreaInsets: () =>
      ReactModule.useContext(actual.SafeAreaInsetsContext) ?? INSETS,
    useSafeAreaFrame: () =>
      ReactModule.useContext(actual.SafeAreaFrameContext) ?? FRAME,
  };
});

import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import {
  useAuthStore,
  type AuthProvider,
  type AuthSession,
} from '../../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import { ACCOUNT_DELETION_DETAILS_MAX } from '../../src/account/deletion';
import type { RootStackParams } from '../../src/navigation/params';

declare const process: {
  env: Record<string, string | undefined>;
};

// ---------------------------------------------------------------------------
// Campaign knobs
// ---------------------------------------------------------------------------

const ITERATIONS = Math.max(1, Number(process.env['STRESS_ITER'] ?? '24'));
const BASE_SEED = Number(process.env['STRESS_SEED'] ?? '20260904') >>> 0 || 1;
const REPLAY = (process.env['STRESS_REPLAY'] ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(s => s.length > 0)
  .map(s => Number(s) >>> 0);
const OUT_PATH = process.env['STRESS_OUT'];
const MIN_TARGET_PT = 44;

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — one 32-bit seed replays an iteration exactly.
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

function iterationSeed(base: number, index: number): number {
  // splitmix-style hash so consecutive iterations are not correlated.
  let z = (base + Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0 || 1;
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: ReadonlyArray<T>): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

// ---------------------------------------------------------------------------
// Lens corpus
// ---------------------------------------------------------------------------

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

const WIDTHS = [375, 393, 430] as const; // iPhone SE/mini, 15/16, Pro Max
const FONT_SCALES = [1, 1.35, 2.35] as const; // Large (default), xxxLarge, AX3

const NAMES: Record<Locale, readonly string[]> = {
  'de-DE': [
    'Jürgen Straßenbahnschaffner',
    'Donaudampfschifffahrtsgesellschaftskapitänswitwenrentenversicherungsanstalt',
    'Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz Müller-Lüdenscheidt',
  ],
  'fr-FR': [
    'Élodie Lefèvre-Dubois',
    'Anaïs Œuvrard de la Croix-Saint-Étienne',
    'Ame\u0301lie Ce\u0301cile Franc\u0327ois', // NFD combining marks
  ],
  'ar-EG': [
    'محمد عبد الرحمن الصاوي',
    'فاطمة الزهراء بنت عبد الله بن محمد بن إبراهيم الأنصاري القرشي المصري',
    '\u200fعلي \u202bAli\u202c ابن سينا',
  ],
  'hi-IN': [
    'प्रियंका श्रीवास्तव',
    'क्षितिज ज्ञानेश्वर द्विवेदी-चतुर्वेदी',
    'ऋषिकेश नारायणस्वामी वेंकटरामन अय्यंगार',
  ],
  'ja-JP': ['田中 太郎', '長谷川 美咲', '龘龘龘 靐靐靐 齉齉齉 (名字)'],
  'pt-BR': ['João Conceição', 'Maria Auxiliadora dos Santos Gonçalves Pereira'],
  'tr-TR': ['İsmail Yıldırım', 'Gülşah Öztürk-Çağlayan', 'IŞIL Iİıi'],
  'ru-RU': [
    'Дмитрий Пётр Щербаков',
    'Александра Константиновна Преображенская-Достоевская',
  ],
  'th-TH': [
    'สมชาย ใจดี',
    'กัญญาภัค วรรณวิเศษสุขสำราญ',
    'น้ำใส ตั้งใจดี เก่งกล้าสามารถ',
  ],
  'zh-CN': ['王小明', '欧阳靖宇', '龘靐齉爩麤鱻 中文姓名超长测试'],
  'en-IN': [
    'Venkatanarasimharajuvaripeta Subramaniam',
    'Dr. Anantha Padmanabhan Krishnamurthy Iyer',
  ],
  'es-419': ['José Ñandú Pérez', 'María de los Ángeles Peñarrieta Güemes'],
};

const EMOJI_ZWJ = ['👨‍👩‍👧‍👦', '👩🏽‍💻', '🏳️‍🌈', '🧑🏿‍🤝‍🧑🏻', '👨‍❤️‍💋‍👨', '🇮🇳', '🇧🇷'];

const COMBINING = [
  'Z\u0351\u036b\u0343a\u0338\u034a\u031bl\u0334g\u0324\u033eo\u0338',
  'ñ\u0303\u0303\u0303',
];

function repeatTo(base: string, minLength: number): string {
  let out = '';
  while (out.length < minLength) out += base;
  return out;
}

type NameKind =
  | 'locale'
  | 'long200'
  | 'long600'
  | 'zwj'
  | 'combining'
  | 'bidi-override'
  | 'zero-width'
  | 'empty'
  | 'whitespace'
  | 'null'
  | 'undefined';

const NAME_KINDS: readonly NameKind[] = [
  'locale',
  'locale',
  'locale',
  'long200',
  'long600',
  'zwj',
  'combining',
  'bidi-override',
  'zero-width',
  'empty',
  'whitespace',
  'null',
  'undefined',
];

function makeName(
  rng: Rng,
  locale: Locale,
  kind: NameKind,
): string | null | undefined {
  const base = rng.pick(NAMES[locale]);
  switch (kind) {
    case 'locale':
      return base;
    case 'long200':
      return repeatTo(`${base} `, 200 + rng.int(60));
    case 'long600':
      return repeatTo(`${base}${rng.pick(EMOJI_ZWJ)} `, 600 + rng.int(200));
    case 'zwj':
      return `${rng.pick(EMOJI_ZWJ)}${base}${rng.pick(EMOJI_ZWJ)}${rng.pick(EMOJI_ZWJ)}`;
    case 'combining':
      return `${rng.pick(COMBINING)} ${base}`;
    case 'bidi-override':
      return `\u202e${base}\u202c`;
    case 'zero-width':
      return `\u200b${base.split('').join('\u200d')}\u200b`;
    case 'empty':
      return '';
    case 'whitespace':
      return rng.pick([' ', '   ', '\u3000', '\u00a0', '\t\n']);
    case 'null':
      return null;
    case 'undefined':
      return undefined;
  }
}

function makeEmail(
  rng: Rng,
  locale: Locale,
  kind: NameKind,
): string | null | undefined {
  const local = rng.pick([
    'sam',
    'first.middle.last',
    'jürgen.straßenbahn',
    'محمد',
    '太郎',
    'приве́т',
    'สมชาย',
    'name+tag',
  ]);
  const domain = rng.pick([
    'example.com',
    'sub.department.university-of-somewhere.ac.uk',
    'bücher.example',
    'مثال.إختبار',
    '例え.テスト',
  ]);
  switch (kind) {
    case 'locale':
      return `${local}@${domain}`;
    case 'long200':
      return `${repeatTo(local + '.', 190)}@${domain}`;
    case 'long600':
      return `${repeatTo(local + '.', 600)}@${domain}`;
    case 'zwj':
      return `${rng.pick(EMOJI_ZWJ)}${local}@${domain}`;
    case 'combining':
      return `${rng.pick(COMBINING)}@${domain}`;
    case 'bidi-override':
      return `\u202e${local}@${domain}\u202c`;
    case 'zero-width':
      return `${local}\u200b@\u200c${domain}`;
    case 'empty':
      return '';
    case 'whitespace':
      return '  ';
    case 'null':
      return null;
    case 'undefined':
      return undefined;
    default:
      return `${rng.pick(NAMES[locale])}@${domain}`;
  }
}

type SegmenterCtor = new (
  locale?: string,
  options?: { granularity: 'grapheme' },
) => { segment(input: string): Iterable<unknown> };

/** User-perceived characters (extended grapheme clusters, Intl.Segmenter). */
function graphemeCount(text: string): number {
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterCtor })
    .Segmenter;
  if (!Segmenter) return Array.from(text).length;
  const seg = new Segmenter(undefined, { granularity: 'grapheme' });
  return Array.from(seg.segment(text)).length;
}

// ---------------------------------------------------------------------------
// Heuristic single-line width model (INFERRED — no Yoga in Linux Jest).
// Average advance per character as a fraction of the font size, by script.
// ---------------------------------------------------------------------------

function advanceFactor(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 0x0300 && cp <= 0x036f) return 0; // combining marks
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x200f)
    return 0;
  if (cp === 0x202a || cp === 0x202b || cp === 0x202c || cp === 0x202e)
    return 0;
  if (cp === 0xfe0f) return 0;
  if (cp >= 0x1f000 || (cp >= 0x2600 && cp <= 0x27bf)) return 1.25; // emoji
  if (cp >= 0x1f3fb && cp <= 0x1f3ff) return 0;
  if (cp >= 0x3000 && cp <= 0x9fff) return 1.0; // CJK
  if (cp >= 0xac00 && cp <= 0xd7af) return 1.0;
  if (cp >= 0x0e00 && cp <= 0x0e7f) return 0.62; // Thai
  if (cp >= 0x0900 && cp <= 0x097f) return 0.6; // Devanagari
  if (cp >= 0x0600 && cp <= 0x06ff) return 0.5; // Arabic
  if (cp >= 0x0400 && cp <= 0x04ff) return 0.58; // Cyrillic
  if (ch === ' ') return 0.28;
  if (ch === 'i' || ch === 'l' || ch === 'j' || ch === 't' || ch === 'f')
    return 0.3;
  if (ch === 'm' || ch === 'w' || ch === 'M' || ch === 'W') return 0.8;
  if (ch >= 'A' && ch <= 'Z') return 0.66;
  if (ch >= '0' && ch <= '9') return 0.56;
  return 0.54;
}

function estimateWidth(
  text: string,
  fontSize: number,
  fontScale: number,
): number {
  let em = 0;
  for (const ch of text) em += advanceFactor(ch);
  return em * fontSize * fontScale;
}

// ---------------------------------------------------------------------------
// Host-tree helpers
// ---------------------------------------------------------------------------

type Flat = Record<string, unknown>;

function isHost(node: ReactTestInstance): boolean {
  return typeof node.type === 'string';
}

/** Host element name ('View' | 'Text' | 'TextInput' | …) or null. */
function hostType(node: ReactTestInstance): string | null {
  return typeof node.type === 'string' ? node.type : null;
}

function flat(node: ReactTestInstance): Flat {
  const style = node.props['style'] as unknown;
  const resolved =
    typeof style === 'function' ? style({ pressed: false }) : style;
  return (StyleSheet.flatten(resolved as never) ?? {}) as Flat;
}

function textOf(node: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (n: ReactTestInstance | string | number) => {
    if (typeof n === 'string' || typeof n === 'number') {
      parts.push(String(n));
      return;
    }
    for (const c of n.children) walk(c);
  };
  walk(node);
  return parts.join('');
}

function hostTexts(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll(n => hostType(n) === 'Text', { deep: true });
}

function allText(root: ReactTestInstance): string {
  return hostTexts(root).map(textOf).join(' | ');
}

function isInteractiveHost(node: ReactTestInstance): boolean {
  if (!isHost(node)) return false;
  if (hostType(node) === 'TextInput') return true;
  if (hostType(node) !== 'View') return false;
  const p = node.props;
  return (
    typeof p['onClick'] === 'function' ||
    typeof p['onStartShouldSetResponder'] === 'function' ||
    typeof p['onResponderRelease'] === 'function'
  );
}

function hasLabel(node: ReactTestInstance): boolean {
  const label = node.props['accessibilityLabel'];
  if (typeof label === 'string' && label.trim().length > 0) return true;
  return textOf(node).trim().length > 0;
}

function slopOf(node: ReactTestInstance): { v: number; h: number } {
  const slop = node.props['hitSlop'] as
    | number
    | { top?: number; bottom?: number; left?: number; right?: number }
    | undefined;
  if (typeof slop === 'number') return { v: slop * 2, h: slop * 2 };
  if (slop && typeof slop === 'object') {
    return {
      v: (slop.top ?? 0) + (slop.bottom ?? 0),
      h: (slop.left ?? 0) + (slop.right ?? 0),
    };
  }
  return { v: 0, h: 0 };
}

interface TargetAudit {
  label: string;
  role: string | null;
  type: string;
  height: number | 'fill' | 'content';
  width: number | 'fill' | 'content';
  effectiveHeight: number | null;
  effectiveWidth: number | null;
  ok: boolean;
  reason: string | null;
}

function auditTarget(node: ReactTestInstance): TargetAudit {
  const f = flat(node);
  const slop = slopOf(node);
  const label =
    (node.props['accessibilityLabel'] as string | undefined) ??
    textOf(node).trim().slice(0, 60);
  const role = (node.props['accessibilityRole'] as string | undefined) ?? null;
  const absoluteFill =
    f['position'] === 'absolute' &&
    f['top'] === 0 &&
    f['bottom'] === 0 &&
    f['left'] === 0 &&
    f['right'] === 0;
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const h = num(f['height']) ?? num(f['minHeight']);
  const w = num(f['width']) ?? num(f['minWidth']);
  const effectiveHeight = absoluteFill ? null : h === null ? null : h + slop.v;
  const effectiveWidth = absoluteFill ? null : w === null ? null : w + slop.h;
  const reasons: string[] = [];
  if (!hasLabel(node)) reasons.push('unlabeled');
  if (hostType(node) !== 'TextInput' && !role) reasons.push('no-role');
  if (!absoluteFill) {
    if (effectiveHeight === null) {
      // Content-sized: only paddingVertical-sized controls reach here. The
      // screen's text links/rows all declare minHeight, so flag it.
      reasons.push('height-unknown');
    } else if (effectiveHeight < MIN_TARGET_PT) {
      reasons.push(`height ${effectiveHeight}pt < ${MIN_TARGET_PT}`);
    }
    if (effectiveWidth !== null && effectiveWidth < MIN_TARGET_PT) {
      reasons.push(`width ${effectiveWidth}pt < ${MIN_TARGET_PT}`);
    }
  }
  return {
    label,
    role,
    type: String(node.type),
    height: absoluteFill ? 'fill' : (h ?? 'content'),
    width: absoluteFill ? 'fill' : (w ?? 'content'),
    effectiveHeight,
    effectiveWidth,
    ok: reasons.length === 0,
    reason: reasons.length ? reasons.join('; ') : null,
  };
}

function auditInteractive(root: ReactTestInstance): TargetAudit[] {
  return (
    root
      .findAll(isInteractiveHost, { deep: true })
      // The scroll views' responder plumbing is not a control.
      .filter(
        n =>
          n.props['testID'] === undefined ||
          !String(n.props['testID']).startsWith('rns:'),
      )
      .map(auditTarget)
  );
}

interface ClipEstimate {
  text: string;
  fontSize: number;
  scaledFontSize: number;
  estimatedWidth: number;
  availableWidth: number | null;
  overflowRatio: number | null;
  role: 'detail-value' | 'header-title' | 'pill' | 'other';
}

/** Heuristic clip model for single-line texts. INFERRED, not layout truth. */
function estimateClipping(
  root: ReactTestInstance,
  width: number,
  fontScale: number,
  detailValues: readonly string[],
): ClipEstimate[] {
  const out: ClipEstimate[] = [];
  const contentInner = width - 2 * 32 - 2 * 24; // content paddingHorizontal + card padding
  const headerInner = width - 2 * 24 - 2 * 44; // ScreenHeader padding + two 44pt sides
  for (const node of hostTexts(root)) {
    if (node.props['numberOfLines'] !== 1) continue;
    const text = textOf(node);
    const f = flat(node);
    const fontSize = typeof f['fontSize'] === 'number' ? f['fontSize'] : 16;
    const maxMult = node.props['maxFontSizeMultiplier'];
    const allow = node.props['allowFontScaling'] !== false;
    const scale = allow
      ? typeof maxMult === 'number' && maxMult > 0
        ? Math.min(fontScale, maxMult)
        : fontScale
      : 1;
    const est = estimateWidth(text, fontSize, scale);
    let role: ClipEstimate['role'] = 'other';
    let available: number | null = null;
    if (detailValues.includes(text)) {
      role = 'detail-value';
      // label column: caption 13pt, widest label "Signed in with"
      const labelWidth = estimateWidth('Signed in with', 13, scale);
      available = Math.max(0, contentInner - labelWidth - 16);
    } else if (text === 'Manage account') {
      role = 'header-title';
      available = headerInner;
    } else if (text === 'SYNCED' || text === 'LOCAL') {
      role = 'pill';
    }
    out.push({
      text: text.length > 80 ? `${text.slice(0, 77)}…` : text,
      fontSize,
      scaledFontSize: Math.round(fontSize * scale * 100) / 100,
      estimatedWidth: Math.round(est),
      availableWidth: available === null ? null : Math.round(available),
      overflowRatio:
        available === null || available <= 0
          ? null
          : Math.round((est / available) * 100) / 100,
      role,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Real navigator harness
// ---------------------------------------------------------------------------

const Stack = createNativeStackNavigator<RootStackParams>();

function TabsStub() {
  return null;
}

function mountInNavigator(width: number, height: number) {
  const navigationRef = createNavigationContainerRef<RootStackParams>();
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width, height },
          insets: { top: 47, bottom: 34, left: 0, right: 0 },
        }}
      >
        <NavigationContainer
          ref={navigationRef}
          initialState={{
            index: 1,
            routes: [{ name: 'Tabs' }, { name: 'ManageAccount' }],
          }}
        >
          <Stack.Navigator
            screenOptions={{
              headerShown: false,
              animation: 'fade_from_bottom',
            }}
          >
            <Stack.Screen name="Tabs" component={TabsStub} />
            <Stack.Screen
              name="ManageAccount"
              component={ManageAccountScreen}
              options={{ title: 'Manage Account' }}
            />
          </Stack.Navigator>
        </NavigationContainer>
      </SafeAreaProvider>,
    );
  });
  return { renderer, navigationRef };
}

function byLabel(root: ReactTestInstance, label: string): ReactTestInstance[] {
  return root.findAll(
    n => isHost(n) && n.props['accessibilityLabel'] === label,
    { deep: true },
  );
}

function byLabelPrefix(
  root: ReactTestInstance,
  prefix: string,
): ReactTestInstance[] {
  return root.findAll(
    n =>
      isHost(n) &&
      typeof n.props['accessibilityLabel'] === 'string' &&
      String(n.props['accessibilityLabel']).startsWith(prefix),
    { deep: true },
  );
}

async function press(node: ReactTestInstance): Promise<void> {
  await act(async () => {
    const onClick = node.props['onClick'] as ((e: unknown) => void) | undefined;
    const onPress = node.props['onPress'] as ((e: unknown) => void) | undefined;
    (onClick ?? onPress)?.({ nativeEvent: {} });
  });
}

function isDisabled(node: ReactTestInstance): boolean {
  const state = node.props['accessibilityState'] as
    { disabled?: boolean } | undefined;
  return state?.disabled === true;
}

// ---------------------------------------------------------------------------
// fetch seam — the only network boundary. Records bodies for the wire check.
// ---------------------------------------------------------------------------

type FetchFailure =
  | 'none'
  | 'http-429'
  | 'http-500'
  | 'http-401'
  | 'http-400-message'
  | 'non-json'
  | 'invalid-shape'
  | 'network';

interface FetchLog {
  path: string;
  body: unknown;
  authorizationPresent: boolean;
}

interface FetchSeam {
  log: FetchLog[];
  /** When `hold` is set, responses wait here until `release()` is called so
   * the in-flight (busy) UI can be audited. */
  release: () => void;
}

function installFetch(plan: {
  request: FetchFailure;
  confirm: FetchFailure;
  hold: boolean;
}): FetchSeam {
  const log: FetchLog[] = [];
  let pending: Array<() => void> = [];
  const gate = () =>
    plan.hold
      ? new Promise<void>(resolve => {
          pending.push(resolve);
        })
      : Promise.resolve();
  const respond = (status: number, payload: unknown, json = true) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      if (!json) throw new SyntaxError('not json');
      return payload;
    },
  });
  const fetchMock = jest.fn(
    async (
      input: unknown,
      init?: { body?: string; headers?: Record<string, string> },
    ) => {
      const url = String(input);
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      const parsed = init?.body
        ? (JSON.parse(init.body) as unknown)
        : undefined;
      log.push({
        path,
        body: parsed,
        authorizationPresent:
          typeof init?.headers?.['Authorization'] === 'string' &&
          init.headers['Authorization'].startsWith('Bearer '),
      });
      const failure = path.endsWith('/delete-request')
        ? plan.request
        : plan.confirm;
      await gate();
      switch (failure) {
        case 'http-429':
          return respond(429, { error: { message: 'Too many requests' } });
        case 'http-500':
          return respond(500, { error: { message: 'boom' } });
        case 'http-401':
          return respond(401, {});
        case 'http-400-message':
          return respond(400, {
            error: { message: 'Survey rejected by the server (test).' },
          });
        case 'non-json':
          return respond(502, null, false);
        case 'invalid-shape':
          return respond(200, { unexpected: true });
        case 'network':
          throw new TypeError('Network request failed');
        case 'none':
        default:
          return path.endsWith('/delete-request')
            ? respond(200, {
                challenge: `chal-${log.length}`,
                expiresAt: new Date(Date.now() + 600_000).toISOString(),
              })
            : respond(200, {
                deleted: true,
                appleAuthorizationRevocation: 'revoked',
              });
      }
    },
  );
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  return {
    log,
    release: () => {
      const waiting = pending;
      pending = [];
      for (const resolve of waiting) resolve();
    },
  };
}

/** Compact host-node serialization for rendered-tree evidence. */
function describeHost(node: ReactTestInstance): string {
  const keep = [
    'accessibilityRole',
    'accessibilityLabel',
    'accessibilityState',
    'accessibilityViewIsModal',
    'numberOfLines',
    'hitSlop',
    'maxLength',
  ];
  const props: Record<string, unknown> = {};
  for (const k of keep)
    if (node.props[k] !== undefined) props[k] = node.props[k];
  const f = flat(node);
  const style: Record<string, unknown> = {};
  for (const k of [
    'height',
    'minHeight',
    'width',
    'minWidth',
    'flexShrink',
    'textAlign',
    'fontSize',
  ]) {
    if (f[k] !== undefined) style[k] = f[k];
  }
  const text = hostType(node) === 'Text' ? textOf(node) : '';
  return `<${String(node.type)} ${JSON.stringify(props)} style=${JSON.stringify(style)}${
    hostType(node) === 'Text'
      ? ` children=${JSON.stringify(text.length > 60 ? `${text.slice(0, 57)}…` : text)}`
      : ''
  }>`;
}

// ---------------------------------------------------------------------------
// One iteration
// ---------------------------------------------------------------------------

/** Local-time discontinuities (spring-forward / fall-back) for zones that
 * have them; fixed-offset zones (UTC±14, Kathmandu) get a plain instant. */
const DST_EDGE_ISO: Record<string, string> = {
  'Europe/Berlin': '2026-03-29T00:59:57Z',
  'America/New_York': '2026-11-01T05:59:57Z',
  'America/Los_Angeles': '2026-03-08T09:59:57Z',
  'Pacific/Chatham': '2026-04-04T14:59:57Z',
  'Australia/Lord_Howe': '2026-10-03T15:29:57Z',
  'Pacific/Auckland': '2026-09-26T13:59:57Z',
};

interface Variant {
  seed: number;
  locale: Locale;
  rtl: boolean;
  width: number;
  height: number;
  fontScale: number;
  session: 'synced' | 'local-only' | 'null';
  provider: AuthProvider;
  nameKind: NameKind;
  emailKind: NameKind;
  nameLength: number;
  emailLength: number;
}

type Journey =
  | 'view-only'
  | 'open-cancel-close'
  | 'open-cancel-backdrop'
  | 'open-cancel-hardware-back'
  | 'skip-survey-keep'
  | 'answer-both-request'
  | 'answer-comment-request'
  | 'skip-q2-request'
  | 'oversize-comment'
  | 'request-failure-retry'
  | 'confirm-failure-retry'
  | 'full-delete';

const JOURNEYS: readonly Journey[] = [
  'view-only',
  'open-cancel-close',
  'open-cancel-backdrop',
  'open-cancel-hardware-back',
  'skip-survey-keep',
  'answer-both-request',
  'answer-comment-request',
  'skip-q2-request',
  'oversize-comment',
  'request-failure-retry',
  'confirm-failure-retry',
  'full-delete',
];

interface IterationResult {
  seed: number;
  index: number;
  tz: string;
  variant: Variant;
  journey: Journey;
  journeyExecuted: boolean;
  outcome: 'HELD' | 'BROKEN' | 'ERROR';
  failures: string[];
  observations: string[];
  interactiveAudited: number;
  targets: TargetAudit[];
  /** Host-node serializations backing each failure / notable observation. */
  treeEvidence: string[];
  clipEstimates: ClipEstimate[];
  counter: {
    codeUnits: number;
    graphemes: number;
    rendered: string;
  } | null;
  wire: FetchLog[];
  navPoppedToSettings: boolean | null;
  error?: string;
}

function makeVariant(seed: number, rng: Rng): Variant {
  const locale = rng.pick(LOCALES);
  const width = rng.pick(WIDTHS);
  const session = rng.chance(0.08)
    ? 'null'
    : rng.chance(0.1)
      ? 'local-only'
      : 'synced';
  const nameKind = rng.pick(NAME_KINDS);
  const emailKind = rng.pick(NAME_KINDS);
  return {
    seed,
    locale,
    rtl: locale === 'ar-EG',
    width,
    height: width === 375 ? 667 : width === 393 ? 852 : 932,
    fontScale: rng.pick(FONT_SCALES),
    session,
    provider:
      session === 'local-only'
        ? 'guest'
        : rng.pick(['apple', 'google'] as const),
    nameKind,
    emailKind,
    nameLength: 0,
    emailLength: 0,
  };
}

function buildSession(
  rng: Rng,
  v: Variant,
): {
  session: AuthSession | null;
  name: string | null | undefined;
  email: string | null | undefined;
} {
  if (v.session === 'null') return { session: null, name: null, email: null };
  const name = makeName(rng, v.locale, v.nameKind);
  const email = makeEmail(rng, v.locale, v.emailKind);
  const id = `${v.seed.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
  const session = {
    provider: v.provider,
    subject: id,
    canonicalAppUserId: id,
    localOnly: v.session === 'local-only',
    // `undefined` is deliberately let through: the vault/bootstrap types say
    // `string | null`, the boundary lens asks what the screen does anyway.
    displayName: name as string | null,
    email: email as string | null,
  } satisfies AuthSession;
  return { session, name, email };
}

function expectedDisplay(value: string | null | undefined): string {
  return value ?? '—';
}

async function runIteration(
  index: number,
  seed: number,
): Promise<IterationResult> {
  const rng = new Rng(seed);
  const variant = makeVariant(seed, rng);
  const journey: Journey =
    variant.session === 'synced' ? rng.pick(JOURNEYS) : 'view-only';
  const result: IterationResult = {
    seed,
    index,
    tz: process.env['TZ'] ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    variant,
    journey,
    journeyExecuted: false,
    outcome: 'HELD',
    failures: [],
    observations: [],
    interactiveAudited: 0,
    targets: [],
    treeEvidence: [],
    clipEstimates: [],
    counter: null,
    wire: [],
    navPoppedToSettings: null,
  };
  const fail = (msg: string) => result.failures.push(msg);
  const note = (msg: string) => result.observations.push(msg);

  jest.useFakeTimers();
  // Wall clock at a DST edge for the process zone, when it has one, so the
  // countdown is exercised across a local-time discontinuity.
  jest.setSystemTime(
    new Date(DST_EDGE_ISO[result.tz] ?? '2026-09-04T12:00:00Z'),
  );
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
  Object.defineProperty(I18nManager, 'isRTL', {
    value: variant.rtl,
    configurable: true,
  });

  const { session, name, email } = buildSession(rng, variant);
  variant.nameLength = typeof name === 'string' ? name.length : -1;
  variant.emailLength = typeof email === 'string' ? email.length : -1;

  const completeAccountDeletion = jest.fn(async () => undefined);
  useAuthStore.setState({
    hydrated: true,
    session,
    busy: false,
    error: null,
    deletionCleanup: null,
    completeAccountDeletion,
  });
  if (
    session &&
    !session.localOnly &&
    session.provider !== 'guest' &&
    session.canonicalAppUserId
  ) {
    establishApiSession({
      apiBaseUrl: 'https://api.stress.invalid',
      bearerToken: 'stress-bearer-not-a-secret',
      canonicalAppUserId: session.canonicalAppUserId,
      provider: session.provider,
    });
  } else {
    clearApiSession();
  }

  const plan = {
    request:
      journey === 'request-failure-retry'
        ? rng.pick<FetchFailure>([
            'http-429',
            'http-500',
            'http-401',
            'http-400-message',
            'non-json',
            'invalid-shape',
            'network',
          ])
        : 'none',
    confirm:
      journey === 'confirm-failure-retry'
        ? rng.pick<FetchFailure>([
            'http-429',
            'http-500',
            'http-401',
            'non-json',
            'invalid-shape',
            'network',
          ])
        : 'none',
  };
  const seam = installFetch({ ...plan, hold: journey === 'full-delete' });
  const wire = seam.log;
  result.wire = wire;

  let mounted: ReturnType<typeof mountInNavigator> | null = null;
  try {
    mounted = mountInNavigator(variant.width, variant.height);
    const { renderer, navigationRef } = mounted;
    const root = renderer.root;

    // ---- screen audit -------------------------------------------------
    const detailValues = [
      expectedDisplay(name),
      expectedDisplay(email),
      session
        ? ({ apple: 'Apple', google: 'Google', guest: 'Guest' } as const)[
            session.provider
          ]
        : '—',
    ];
    const text = allText(root);
    const detailTexts = hostTexts(root).filter(
      n => n.props['numberOfLines'] === 1,
    );
    for (const [i, expected] of detailValues.entries()) {
      const label = ['Name', 'Email', 'Signed in with'][i] ?? '';
      const trimmed = expected.trim();
      if (trimmed.length === 0) {
        fail(
          `${label} renders blank (value ${JSON.stringify(expected)}) instead of the '—' placeholder`,
        );
        const node = detailTexts.find(n => textOf(n) === expected);
        if (node) result.treeEvidence.push(`${label}: ${describeHost(node)}`);
      } else if (!text.includes(expected)) {
        fail(
          `${label} value not rendered verbatim (expected ${JSON.stringify(expected.slice(0, 40))}…)`,
        );
      }
    }
    if (variant.rtl && text.includes('\u202e')) {
      note(
        'bidi override U+202E passes through into the rendered Text verbatim',
      );
    }
    if (!text.includes('Manage account')) fail('header title missing');
    if (!text.includes(session && !session.localOnly ? 'SYNCED' : 'LOCAL')) {
      fail('status pill wrong');
    }
    const deleteLinks = byLabel(root, 'Delete account');
    if (session && !session.localOnly) {
      if (deleteLinks.length !== 1)
        fail(`expected one Delete account link, got ${deleteLinks.length}`);
    } else if (deleteLinks.length !== 0) {
      fail('Delete account offered for a non-synced session');
    }

    const screenTargets = auditInteractive(root);
    result.targets.push(...screenTargets);
    for (const t of screenTargets)
      if (!t.ok) fail(`screen control "${t.label}": ${t.reason}`);
    const screenClips = estimateClipping(
      root,
      variant.width,
      variant.fontScale,
      detailValues,
    );
    result.clipEstimates.push(...screenClips);
    for (const clip of screenClips) {
      if (clip.overflowRatio !== null && clip.overflowRatio > 1) {
        const node = detailTexts.find(n =>
          textOf(n).startsWith(clip.text.replace(/…$/, '')),
        );
        if (node)
          result.treeEvidence.push(
            `clip-estimate ${clip.role} x${clip.overflowRatio}: ${describeHost(node)}`,
          );
      }
    }

    // ---- dialog journey ---------------------------------------------------
    if (journey !== 'view-only' && deleteLinks[0]) {
      await press(deleteLinks[0]);
      const dialogAudit = (pageName: string) => {
        const targets = auditInteractive(root);
        result.targets.push(...targets);
        for (const t of targets)
          if (!t.ok) fail(`${pageName} control "${t.label}": ${t.reason}`);
        result.clipEstimates.push(
          ...estimateClipping(
            root,
            variant.width,
            variant.fontScale,
            detailValues,
          ),
        );
      };
      dialogAudit('why');
      const modalCards = root.findAll(
        n => isHost(n) && n.props['accessibilityViewIsModal'] === true,
        { deep: true },
      );
      if (modalCards.length !== 1)
        fail(
          `expected one accessibilityViewIsModal card, got ${modalCards.length}`,
        );
      const progress = root.findAll(
        n => isHost(n) && n.props['accessibilityRole'] === 'progressbar',
        { deep: true },
      );
      if (
        progress.length !== 1 ||
        progress[0]?.props['accessibilityLabel'] !== 'Question 1 of 2'
      ) {
        fail('question 1 progressbar missing/mislabelled');
      }
      const radiosQ1 = root.findAll(
        n => isHost(n) && n.props['accessibilityRole'] === 'radio',
        { deep: true },
      );
      if (radiosQ1.length !== 7)
        fail(`expected 7 reason radios, got ${radiosQ1.length}`);
      const radiogroups = root.findAll(
        n => isHost(n) && n.props['accessibilityRole'] === 'radiogroup',
        { deep: true },
      );
      if (radiogroups.length !== 1)
        fail(`expected one radiogroup, got ${radiogroups.length}`);

      const modalOpen = () =>
        byLabel(root, 'Cancel account deletion').length === 1;
      const nextButton = () => byLabel(root, 'Next')[0];

      if (journey === 'open-cancel-close') {
        await press(byLabel(root, 'Close and keep my account')[0]!);
        if (modalOpen()) fail('close did not dismiss the dialog');
      } else if (journey === 'open-cancel-backdrop') {
        await press(byLabel(root, 'Cancel account deletion')[0]!);
        if (modalOpen()) fail('backdrop did not dismiss the dialog');
      } else if (journey === 'open-cancel-hardware-back') {
        const modal = root.findAll(
          n =>
            typeof n.props['onRequestClose'] === 'function' &&
            n.props['visible'] === true,
        );
        await act(async () => {
          (modal[0]?.props['onRequestClose'] as (() => void) | undefined)?.();
        });
        if (modalOpen()) fail('hardware back did not dismiss the dialog');
      } else {
        // ---- question 1 ----
        let chosenReason: number | null = null;
        if (journey === 'skip-survey-keep') {
          await press(byLabel(root, 'Skip the survey')[0]!);
        } else {
          if (!isDisabled(nextButton()!))
            fail('Next enabled before a reason is chosen');
          chosenReason = rng.int(7);
          // Change of mind: pick a different one first, sometimes.
          if (rng.chance(0.4))
            await press(radiosQ1[(chosenReason + 1 + rng.int(6)) % 7]!);
          await press(radiosQ1[chosenReason]!);
          const selected = root
            .findAll(
              n => isHost(n) && n.props['accessibilityRole'] === 'radio',
              { deep: true },
            )
            .filter(
              n =>
                (n.props['accessibilityState'] as { selected?: boolean })
                  .selected === true,
            );
          if (selected.length !== 1)
            fail(`expected one selected radio, got ${selected.length}`);
          if (isDisabled(nextButton()!))
            fail('Next still disabled after choosing a reason');
          await press(nextButton()!);
          dialogAudit('kept');
          const p2 = root.findAll(
            n => isHost(n) && n.props['accessibilityRole'] === 'progressbar',
            { deep: true },
          );
          if (p2[0]?.props['accessibilityLabel'] !== 'Question 2 of 2')
            fail('question 2 progressbar mislabelled');
          if (rng.chance(0.25)) {
            // Back to question 1 and forward again keeps the answer.
            await press(byLabel(root, 'Back to the previous question')[0]!);
            const still = root
              .findAll(
                n => isHost(n) && n.props['accessibilityRole'] === 'radio',
                { deep: true },
              )
              .filter(
                n =>
                  (n.props['accessibilityState'] as { selected?: boolean })
                    .selected === true,
              );
            if (still.length !== 1) fail('reason lost after Back');
            await press(nextButton()!);
          }
          // ---- question 2 ----
          const radiosQ2 = root.findAll(
            n => isHost(n) && n.props['accessibilityRole'] === 'radio',
            { deep: true },
          );
          if (radiosQ2.length !== 6)
            fail(`expected 6 wanted radios, got ${radiosQ2.length}`);
          const input = root.findAll(n => hostType(n) === 'TextInput', {
            deep: true,
          })[0];
          if (!input) fail('comment TextInput missing');
          if (
            input &&
            input.props['maxLength'] !== ACCOUNT_DELETION_DETAILS_MAX
          )
            fail('maxLength not the shared cap');
          if (
            input &&
            input.props['accessibilityLabel'] !==
              'Anything else you want us to know'
          )
            fail('comment input unlabeled');
          const continueButton = () => byLabel(root, 'Continue')[0]!;
          let comment = '';
          let wantedIdx: number | null = null;
          if (journey === 'skip-q2-request') {
            await press(byLabel(root, 'Skip this question')[0]!);
          } else {
            if (!isDisabled(continueButton()))
              fail('Continue enabled with nothing answered');
            if (
              journey === 'answer-comment-request' ||
              journey === 'oversize-comment' ||
              rng.chance(0.5)
            ) {
              const base = rng.pick([
                ...NAMES[variant.locale],
                rng.pick(EMOJI_ZWJ),
                rng.pick(COMBINING),
                '   ',
                '\u200b',
                '0',
                '-1',
                String(Number.MAX_SAFE_INTEGER),
              ]);
              comment =
                journey === 'oversize-comment'
                  ? repeatTo(
                      base,
                      ACCOUNT_DELETION_DETAILS_MAX + 1 + rng.int(4000),
                    )
                  : repeatTo(base, rng.pick([1, 40, 200, 499, 500])).slice(
                      0,
                      ACCOUNT_DELETION_DETAILS_MAX,
                    );
              await act(async () => {
                (input!.props['onChangeText'] as (t: string) => void)(comment);
              });
              const counterNode = hostTexts(root).find(n =>
                /^\d+\/\d+$/.test(textOf(n)),
              );
              const rendered = counterNode ? textOf(counterNode) : '';
              result.counter = {
                codeUnits: comment.length,
                graphemes: graphemeCount(comment),
                rendered,
              };
              if (!/^[0-9]+\/500$/.test(rendered))
                fail(`counter not ASCII n/500: ${JSON.stringify(rendered)}`);
              if (
                rendered !== `${comment.length}/${ACCOUNT_DELETION_DETAILS_MAX}`
              ) {
                fail(
                  `counter ${rendered} does not reflect the input length ${comment.length}`,
                );
              }
              if (comment.length > ACCOUNT_DELETION_DETAILS_MAX) {
                note(
                  `JS layer accepts ${comment.length} code units past maxLength; counter reads ${rendered}`,
                );
              }
              if (graphemeCount(comment) !== comment.length) {
                note(
                  `counter counts UTF-16 code units (${comment.length}) not graphemes (${graphemeCount(comment)})`,
                );
              }
            }
            if (
              journey === 'answer-both-request' ||
              (wantedIdx === null && comment.trim().length === 0) ||
              rng.chance(0.5)
            ) {
              wantedIdx = rng.int(6);
              await press(radiosQ2[wantedIdx]!);
            }
            if (isDisabled(continueButton()))
              fail('Continue disabled after answering question 2');
            await press(continueButton());
          }
        }
        // ---- review ----
        dialogAudit('review');
        const reviewText = allText(root);
        if (!reviewText.includes('Delete your account?'))
          fail('review page missing');
        if (byLabel(root, 'Manage subscription in the App Store').length !== 1)
          fail('subscription link missing');
        const p3 = root.findAll(
          n => isHost(n) && n.props['accessibilityRole'] === 'progressbar',
          { deep: true },
        );
        if (p3.length !== 0) fail('progressbar shown on review page');

        if (journey === 'skip-survey-keep') {
          await press(byLabel(root, 'Keep my account')[0]!);
          if (modalOpen()) fail('Keep my account did not dismiss');
          if (wire.length !== 0) fail('network touched on keep');
        } else {
          await press(byLabel(root, 'Continue to delete')[0]!);
          if (journey === 'full-delete') {
            // In flight: every escape hatch is disabled, the busy label is
            // honest, the double-tap guard is mirrored into a11y state.
            const busyChecks: Array<[string, ReactTestInstance | undefined]> = [
              ['Requesting…', byLabel(root, 'Requesting…')[0]],
              ['Keep my account', byLabel(root, 'Keep my account')[0]],
              [
                'Close account deletion confirmation',
                byLabel(root, 'Close account deletion confirmation')[0],
              ],
              [
                'Cancel account deletion',
                byLabel(root, 'Cancel account deletion')[0],
              ],
            ];
            for (const [label, node] of busyChecks) {
              if (!node) fail(`busy state: "${label}" missing`);
              else if (!isDisabled(node)) {
                fail(`busy state: "${label}" not disabled while requesting`);
                result.treeEvidence.push(describeHost(node));
              }
            }
            const modal = root.findAll(
              n =>
                typeof n.props['visible'] === 'boolean' &&
                'onRequestClose' in n.props,
            );
            if (modal[0] && modal[0].props['onRequestClose'] !== undefined)
              fail('hardware back not blocked while requesting');
            await act(async () => {
              seam.release();
            });
          }
          const req = wire.find(w => w.path === '/v1/me/delete-request');
          if (!req) fail('delete-request not sent');
          if (req && !req.authorizationPresent)
            fail('bearer missing on delete-request');
          // Wire check: survey shape mirrors the answers.
          if (req) {
            const body = req.body as
              | {
                  survey?: {
                    reason?: string;
                    wanted?: string | null;
                    details?: string | null;
                  };
                }
              | undefined;
            if (chosenReason === null) {
              if (body !== undefined) fail('skipped survey must send no body');
            } else if (!body?.survey) {
              fail('answered survey not on the wire');
            } else if (
              body.survey.details !== null &&
              typeof body.survey.details === 'string' &&
              body.survey.details !== body.survey.details.trim()
            ) {
              fail('details not trimmed on the wire');
            }
          }

          if (journey === 'request-failure-retry') {
            const errText = allText(root);
            // Honest copy: the client's own wording, or the server-sent
            // message (the seam sends 'Too many requests' / 'boom').
            const hasCopy =
              errText.includes('Nothing was deleted') ||
              errText.includes('Sign in again') ||
              errText.includes('Survey rejected') ||
              errText.includes('invalid deletion') ||
              errText.includes('Too many requests') ||
              errText.includes(' boom ');
            if (!hasCopy)
              fail(
                `request failure (${plan.request}) shows no honest error copy`,
              );
            const retry = byLabel(root, 'Continue to delete')[0];
            if (!retry) fail('no retry path after request failure');
            else if (isDisabled(retry))
              fail('retry disabled after request failure');
            result.journeyExecuted = true;
          } else {
            // ---- armed countdown ----
            let confirm = byLabelPrefix(root, 'Permanently delete')[0];
            if (!confirm) fail('armed button missing');
            if (
              confirm &&
              confirm.props['accessibilityLabel'] !== 'Permanently delete (5)'
            ) {
              fail(
                `armed label ${String(confirm?.props['accessibilityLabel'])}`,
              );
            }
            if (confirm && !isDisabled(confirm))
              fail('armed button enabled before hold-off');
            await act(async () => {
              jest.advanceTimersByTime(4_999);
            });
            confirm = byLabelPrefix(root, 'Permanently delete')[0];
            if (confirm && !isDisabled(confirm))
              fail('armed button enabled at 4.999s');
            await act(async () => {
              jest.advanceTimersByTime(1);
            });
            confirm = byLabelPrefix(root, 'Permanently delete')[0];
            if (
              !confirm ||
              confirm.props['accessibilityLabel'] !== 'Permanently delete' ||
              isDisabled(confirm)
            ) {
              fail(
                `countdown did not release at 5s (label=${String(confirm?.props['accessibilityLabel'])})`,
              );
            }
            if (
              journey === 'oversize-comment' ||
              journey === 'answer-both-request' ||
              journey === 'answer-comment-request' ||
              journey === 'skip-q2-request'
            ) {
              // Cancel from armed: still nothing deleted.
              await press(byLabel(root, 'Keep my account')[0]!);
              if (modalOpen())
                fail('Keep my account did not dismiss when armed');
              if (wire.some(w => w.path === '/v1/me/delete-confirm'))
                fail('confirm sent without a tap');
              result.journeyExecuted = true;
            } else if (confirm) {
              await press(confirm);
              if (journey === 'full-delete') {
                const deleting = byLabel(root, 'Deleting…')[0];
                if (!deleting || !isDisabled(deleting))
                  fail('deleting state not shown/disabled while confirming');
                const keep = byLabel(root, 'Keep my account')[0];
                if (!keep || !isDisabled(keep))
                  fail('Keep my account enabled while deleting');
                await act(async () => {
                  seam.release();
                });
              }
              const conf = wire.find(w => w.path === '/v1/me/delete-confirm');
              if (!conf) fail('delete-confirm not sent');
              if (journey === 'confirm-failure-retry') {
                const errText = allText(root);
                if (
                  !/Nothing was deleted|Sign in again|did not confirm|invalid deletion response|Too many requests| boom /.test(
                    errText,
                  )
                ) {
                  fail(
                    `confirm failure (${plan.confirm}) shows no honest error copy`,
                  );
                }
                if (completeAccountDeletion.mock.calls.length !== 0)
                  fail('local purge ran after a failed confirm');
                const retryable =
                  plan.confirm === 'http-429' ||
                  plan.confirm === 'http-500' ||
                  plan.confirm === 'network' ||
                  plan.confirm === 'non-json';
                const again = byLabelPrefix(root, 'Permanently delete')[0];
                const back = byLabel(root, 'Continue to delete')[0];
                if (retryable ? !again || isDisabled(again) : !back) {
                  fail(`no retry path after confirm failure ${plan.confirm}`);
                }
                result.journeyExecuted = true;
              } else {
                if (completeAccountDeletion.mock.calls.length !== 1)
                  fail('completeAccountDeletion not invoked once');
                if (modalOpen()) fail('dialog still open after deletion');
                result.journeyExecuted = true;
              }
            }
          }
        }
      }
      if (
        journey === 'open-cancel-close' ||
        journey === 'open-cancel-backdrop' ||
        journey === 'open-cancel-hardware-back' ||
        journey === 'skip-survey-keep'
      ) {
        result.journeyExecuted = true;
      }
      // Reopen after any close → reset to question 1, nothing selected.
      if (
        !modalOpen() &&
        byLabel(root, 'Delete account')[0] &&
        rng.chance(0.5)
      ) {
        await press(byLabel(root, 'Delete account')[0]!);
        const sel = root
          .findAll(n => isHost(n) && n.props['accessibilityRole'] === 'radio', {
            deep: true,
          })
          .filter(
            n =>
              (n.props['accessibilityState'] as { selected?: boolean })
                .selected === true,
          );
        if (sel.length !== 0) fail('reopened dialog kept a selection');
        if (allText(root).includes('Delete your account?'))
          fail('reopened dialog did not reset to question 1');
        await press(byLabel(root, 'Close and keep my account')[0]!);
      }
    } else {
      result.journeyExecuted = journey === 'view-only';
    }

    // ---- real navigator: header Back pops to Settings ------------------
    // A dialog left open in an error state closes first (nothing is busy).
    const lingering = byLabelPrefix(root, 'Close ')[0];
    if (lingering && !isDisabled(lingering)) {
      await press(lingering);
      if (byLabel(root, 'Cancel account deletion').length !== 0)
        fail('close from error state did not dismiss');
    }
    if (byLabel(root, 'Cancel account deletion').length === 0) {
      const back = byLabel(root, 'Back')[0];
      if (!back) fail('header Back missing');
      else {
        await press(back);
        const state = navigationRef.getRootState();
        const top = state?.routes[state.index]?.name;
        result.navPoppedToSettings =
          top === 'Tabs' && state?.routes.length === 1;
        if (!result.navPoppedToSettings)
          fail(`header Back did not pop to Tabs (top=${String(top)})`);
      }
    }

    result.interactiveAudited = result.targets.length;
    act(() => renderer.unmount());
    mounted = null;
  } catch (error) {
    result.outcome = 'ERROR';
    result.error =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
  } finally {
    if (mounted) {
      try {
        act(() => mounted!.renderer.unmount());
      } catch {
        // already torn down
      }
    }
    jest.useRealTimers();
    clearApiSession();
    Object.defineProperty(I18nManager, 'isRTL', {
      value: false,
      configurable: true,
    });
  }
  if (result.outcome !== 'ERROR')
    result.outcome = result.failures.length ? 'BROKEN' : 'HELD';
  return result;
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

const seeds: Array<{ index: number; seed: number }> =
  REPLAY.length > 0
    ? REPLAY.map((seed, index) => ({ index, seed }))
    : Array.from({ length: ITERATIONS }, (_, index) => ({
        index,
        seed: iterationSeed(BASE_SEED, index),
      }));

const results: IterationResult[] = [];

afterAll(() => {
  if (!OUT_PATH) return;
  const byOutcome = { HELD: 0, BROKEN: 0, ERROR: 0 };
  const count = (key: (r: IterationResult) => string) => {
    const out: Record<string, number> = {};
    for (const r of results) out[key(r)] = (out[key(r)] ?? 0) + 1;
    return out;
  };
  const failureKinds: Record<string, number[]> = {};
  for (const r of results) {
    byOutcome[r.outcome] += 1;
    for (const f of r.failures) {
      const kind = f.replace(/\(value .*$/, '').trim();
      (failureKinds[kind] ??= []).push(r.seed);
    }
  }
  const table = {
    unit: 'scr-manageaccountscreen',
    lens: 'boundary-i18n-a11y',
    baseSeed: BASE_SEED,
    tz: process.env['TZ'] ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    iterations: results.length,
    byOutcome,
    interactiveTargetsAudited: results.reduce(
      (n, r) => n + r.interactiveAudited,
      0,
    ),
    interactiveTargetsFailed: results.reduce(
      (n, r) => n + r.targets.filter(t => !t.ok).length,
      0,
    ),
    coverage: {
      widthByFontScale: count(r => `${r.variant.width}x${r.variant.fontScale}`),
      locale: count(r => r.variant.locale),
      session: count(r => r.variant.session),
      nameKind: count(r => r.variant.nameKind),
      emailKind: count(r => r.variant.emailKind),
      journey: count(r => r.journey),
    },
    failureKinds,
    clipEstimatesOverflowing: results
      .flatMap(r =>
        r.clipEstimates.map(c => ({
          seed: r.seed,
          width: r.variant.width,
          fontScale: r.variant.fontScale,
          ...c,
        })),
      )
      .filter(c => c.overflowRatio !== null && c.overflowRatio > 1)
      .filter(
        (c, i, arr) =>
          arr.findIndex(
            o =>
              o.role === c.role &&
              o.width === c.width &&
              o.fontScale === c.fontScale &&
              o.text === c.text,
          ) === i,
      ),
    rows: results,
  };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(table, null, 1));
});

describe(`ManageAccountScreen stress — boundary/i18n/a11y (base seed ${BASE_SEED}, ${seeds.length} iterations)`, () => {
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = undefined;
  });

  for (const { index, seed } of seeds) {
    it(`seed ${seed} (#${index}) holds every boundary/i18n/a11y invariant`, async () => {
      const result = await runIteration(index, seed);
      results.push(result);
      if (result.outcome === 'ERROR') {
        throw new Error(`seed ${seed}: harness error ${result.error ?? ''}`);
      }
      expect({
        seed,
        variant: result.variant,
        journey: result.journey,
        failures: result.failures,
      }).toEqual({
        seed,
        variant: result.variant,
        journey: result.journey,
        failures: [],
      });
      expect(result.journeyExecuted).toBe(true);
    });
  }
});
