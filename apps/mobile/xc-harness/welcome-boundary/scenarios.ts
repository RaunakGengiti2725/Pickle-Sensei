/**
 * Seeded scenario space for the WelcomeScreen boundary / i18n / a11y stress
 * campaign (`__tests__/stress/welcomeScreenBoundaryI18nA11y.stress.test.tsx`).
 *
 * Every scenario is a pure function of its seed (Mulberry32, shared with the
 * lifecycle-persistence matrix), so any row in the results table can be
 * replayed with `STRESS_SEED=<seed>`.
 */
import { makePrng, pick } from '../lifecycle-persistence/seeds';

export type MountMode = 'app' | 'direct';
export type PropsVariant =
  'both' | 'no-signin' | 'signin-undefined' | 'getstarted-undefined';
export type Interaction = 'none' | 'start' | 'signin';
export type PersistedKind =
  'clean' | 'kv-raw' | 'kv-json' | 'vault-raw' | 'vault-json';

export interface Viewport {
  name: string;
  width: number;
  height: number;
  insetTop: number;
  insetBottom: number;
}

export interface Scenario {
  seed: number;
  family: 'grid' | 'locale' | 'timezone' | 'random';
  mount: MountMode;
  props: PropsVariant;
  interaction: Interaction;
  fontScale: number;
  viewport: Viewport;
  locale: string;
  rtl: boolean;
  timeZone: string;
  clockIso: string;
  persisted: PersistedKind;
  persistedKey: string | null;
  payloadId: string;
}

// ─── Dynamic Type / viewport axes ────────────────────────────────────────────

/** iOS fontScale values RN reports for Default, xxLarge and AX3. */
export const FONT_SCALES = [1, 1.235, 2.35] as const;

export const VIEWPORTS: readonly Viewport[] = [
  {
    name: 'iPhone-SE1-320',
    width: 320,
    height: 568,
    insetTop: 20,
    insetBottom: 0,
  },
  {
    name: 'iPhone-SE3-375',
    width: 375,
    height: 667,
    insetTop: 20,
    insetBottom: 0,
  },
  {
    name: 'iPhone-ProMax-430',
    width: 430,
    height: 932,
    insetTop: 59,
    insetBottom: 34,
  },
];

/** Zero / negative / huge numerics fed to the layout inputs. */
export const NUMERIC_BOUNDARY_SCALES = [0, -1, 1e6] as const;
export const NUMERIC_BOUNDARY_VIEWPORTS: readonly Viewport[] = [
  { name: 'zero-viewport', width: 0, height: 0, insetTop: 0, insetBottom: 0 },
  {
    name: 'negative-viewport',
    width: -100,
    height: -50,
    insetTop: -10,
    insetBottom: -10,
  },
  {
    name: 'huge-viewport',
    width: 1e9,
    height: 1e9,
    insetTop: 1e6,
    insetBottom: 1e6,
  },
];

// ─── Locales / timezones ─────────────────────────────────────────────────────

export const LOCALES = [
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

export const RTL_LOCALES = new Set<string>(['ar-EG']);

/**
 * UTC+14 (Kiritimati) and UTC-12 (`Etc/GMT+12`, the most negative zone in
 * tzdb — there is no UTC-14 zone), plus DST-observing zones with 60- and
 * 30-minute shifts and a 45-minute offset.
 */
export const TIMEZONES = [
  'Pacific/Kiritimati',
  'Etc/GMT+12',
  'America/New_York',
  'Europe/Berlin',
  'Australia/Lord_Howe',
  'Pacific/Chatham',
  'America/Santiago',
  'Asia/Kolkata',
] as const;

/** Instants one second before / at a DST transition or a calendar edge. */
export const CLOCK_EDGES = [
  '2026-03-08T06:59:59.000Z', // US spring forward (02:00 EST → 03:00 EDT)
  '2026-11-01T05:59:59.000Z', // US fall back
  '2026-03-29T00:59:59.000Z', // EU spring forward
  '2026-10-25T00:59:59.000Z', // EU fall back
  '2026-04-04T15:29:59.000Z', // Lord Howe fall back (30-minute shift)
  '2026-09-26T13:44:59.000Z', // Chatham spring forward (+12:45 → +13:45)
  '2026-12-31T23:59:59.000Z', // year boundary (already 2027 in UTC+14)
  '2026-02-28T23:59:59.000Z', // non-leap February edge
] as const;

// ─── Hostile string payloads ─────────────────────────────────────────────────

// Deliberately NOT a sentence the screen renders, so a leak is unambiguous.
const LATIN_SENTENCE =
  'Persisted boundary payload zq7 for the welcome stress harness, never legitimate screen copy. ';
const CJK =
  '見えないストロークを見て、修正を知る。私的な技術コーチが各キャプチャを導き、検証された読み取りを次の一歩に変える。';
const ARABIC =
  'مدرب تقنية خاص يوجه كل لقطة ويحول القراءات المعتمدة إلى خطوة واحدة واضحة تالية. ';
const THAI =
  'โค้ชเทคนิคส่วนตัวที่แนะนำการจับภาพแต่ละครั้งและเปลี่ยนการอ่านที่ผ่านการตรวจสอบให้เป็นขั้นตอนถัดไปที่ชัดเจน';
const DEVANAGARI =
  'एक निजी तकनीक कोच जो प्रत्येक कैप्चर का मार्गदर्शन करता है और सत्यापित रीडिंग को एक स्पष्ट अगले कदम में बदलता है। ';
const GERMAN_COMPOUND =
  'Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz';
const ZWJ_FAMILY = '👨‍👩‍👧‍👦👩‍❤️‍💋‍👩🏳️‍🌈🧑🏽‍💻👨🏿‍🦽🇪🇬🇯🇵🇮🇳';
const COMBINING =
  'Z\u0351\u036b\u0343\u036a\u0302\u036b\u033d\u034f\u0334\u0319\u0324\u031e\u0349\u035a\u032f\u031e\u0320\u034d';

function repeatTo(chunk: string, minLength: number): string {
  let out = '';
  while (out.length < minLength) out += chunk;
  return out;
}

export const PAYLOADS: Readonly<Record<string, string>> = {
  'latin-240': repeatTo(LATIN_SENTENCE, 240),
  'cjk-220': repeatTo(CJK, 220),
  'arabic-rtl-210': '\u200f' + repeatTo(ARABIC, 210) + '\u061c',
  'thai-no-spaces-220': repeatTo(THAI, 220),
  'devanagari-conjuncts-220': repeatTo(DEVANAGARI, 220),
  'german-compound-256': repeatTo(GERMAN_COMPOUND, 256),
  'zwj-emoji-200': repeatTo(ZWJ_FAMILY, 200),
  'combining-marks-240': repeatTo(COMBINING, 240),
  'bidi-override':
    '\u202e' + repeatTo('Start your first read ', 200) + '\u202c',
  'null-bytes': repeatTo('a\u0000b\u0000', 200),
  'huge-20k': repeatTo('x', 20_000),
  empty: '',
  whitespace: ' \n\t\r\u00a0\u2028\u2029 ',
  'not-json': 'definitely not json {',
  'json-string-literal': '"just a string"',
  'json-array': '[1,2,3]',
  'json-number-huge': '1e309',
  'json-number-negative': '-9007199254740993',
  'json-number-zero': '0',
  'json-null': 'null',
};

export const PAYLOAD_IDS = Object.keys(PAYLOADS);

/** kv keys the signed-out launch reads (recorded from the real appStore/authStore). */
export const KV_KEYS_READ_AT_LAUNCH = [
  'auth.session',
  'auth.local-mode',
  'auth.last-provider',
  'onboarding.pending-profile',
  'profile:signed-out',
  'profile',
] as const;

/** JSON envelopes that pass a shape check and carry the payload in string slots. */
export function jsonEnvelopeFor(key: string, payload: string): string {
  switch (key) {
    case 'auth.session':
      return JSON.stringify({
        version: 1,
        provider: 'apple',
        subject: payload,
        canonicalAppUserId: payload,
        localOnly: false,
        displayName: payload,
        email: payload,
      });
    case 'auth.local-mode':
      return JSON.stringify({ localOnly: payload });
    case 'auth.last-provider':
      return JSON.stringify(payload);
    case 'onboarding.pending-profile':
      return JSON.stringify({
        version: 1,
        profile: {
          skillLevel: payload,
          handedness: payload,
          goal: payload,
          biggestProblem: payload,
          focusCheckpoint: payload,
          displayName: payload,
        },
      });
    default:
      return JSON.stringify({
        skillLevel: payload,
        handedness: payload,
        goal: payload,
        biggestProblem: payload,
        focusCheckpoint: payload,
      });
  }
}

export function vaultEnvelopeFor(payload: string): string {
  return JSON.stringify({
    version: 1,
    provider: 'apple',
    canonicalAppUserId: '7fc2c743-028f-4ec6-942c-a84508f3be38',
    refreshToken: payload,
    email: payload,
    displayName: payload,
  });
}

// ─── Scenario generation ─────────────────────────────────────────────────────

const PERSISTED_KINDS: readonly PersistedKind[] = [
  'clean',
  'clean',
  'kv-raw',
  'kv-json',
  'vault-raw',
  'vault-json',
];

export function scenarioFromSeed(
  seed: number,
  family: Scenario['family'] = 'random',
): Scenario {
  const rng = makePrng(seed);
  const mount: MountMode = rng() < 0.7 ? 'app' : 'direct';
  const props: PropsVariant =
    mount === 'app'
      ? 'both'
      : pick(rng, [
          'both',
          'both',
          'no-signin',
          'signin-undefined',
          'getstarted-undefined',
        ]);
  const interaction: Interaction =
    props === 'no-signin' || props === 'signin-undefined'
      ? pick(rng, ['none', 'start'])
      : pick(rng, ['none', 'start', 'signin']);
  const numericAttack = rng() < 0.12;
  const fontScale = numericAttack
    ? pick(rng, NUMERIC_BOUNDARY_SCALES)
    : pick(rng, FONT_SCALES);
  const viewport =
    numericAttack && rng() < 0.5
      ? pick(rng, NUMERIC_BOUNDARY_VIEWPORTS)
      : pick(rng, VIEWPORTS);
  const locale = pick(rng, LOCALES);
  const timeZone = pick(rng, TIMEZONES);
  const clockIso = pick(rng, CLOCK_EDGES);
  const persisted: PersistedKind =
    mount === 'app' ? pick(rng, PERSISTED_KINDS) : 'clean';
  const persistedKey =
    persisted === 'kv-raw' || persisted === 'kv-json'
      ? pick(rng, KV_KEYS_READ_AT_LAUNCH)
      : null;
  const payloadId = pick(rng, PAYLOAD_IDS);
  return {
    seed,
    family,
    mount,
    props,
    interaction,
    fontScale,
    viewport,
    locale,
    rtl: RTL_LOCALES.has(locale),
    timeZone,
    clockIso,
    persisted,
    persistedKey,
    payloadId,
  };
}

/**
 * Deterministic corner grid that every run executes regardless of
 * STRESS_ITER: 3 font scales × 3 widths (app mount, en-IN/UTC-agnostic),
 * one iteration per locale (RTL for ar-EG) and one per timezone at a DST
 * edge. Seeds are stable so the grid rows replay like random rows.
 */
export function cornerScenarios(baseSeed: number): Scenario[] {
  const rows: Scenario[] = [];
  let n = 0;
  for (const fontScale of FONT_SCALES) {
    for (const viewport of VIEWPORTS) {
      const seed = baseSeed + 100_000 + n;
      n += 1;
      rows.push({
        ...scenarioFromSeed(seed, 'grid'),
        mount: 'app',
        props: 'both',
        interaction: 'none',
        fontScale,
        viewport,
        persisted: 'clean',
        persistedKey: null,
      });
    }
  }
  LOCALES.forEach((locale, i) => {
    const seed = baseSeed + 200_000 + i;
    rows.push({
      ...scenarioFromSeed(seed, 'locale'),
      mount: 'app',
      props: 'both',
      locale,
      rtl: RTL_LOCALES.has(locale),
      fontScale: FONT_SCALES[i % FONT_SCALES.length] ?? 1,
      viewport: VIEWPORTS[i % VIEWPORTS.length] ?? VIEWPORTS[1]!,
    });
  });
  TIMEZONES.forEach((timeZone, i) => {
    const seed = baseSeed + 300_000 + i;
    rows.push({
      ...scenarioFromSeed(seed, 'timezone'),
      mount: 'app',
      props: 'both',
      timeZone,
      clockIso: CLOCK_EDGES[i] ?? CLOCK_EDGES[0],
      persisted: 'clean',
      persistedKey: null,
    });
  });
  return rows;
}

export function scenarioLabel(s: Scenario): string {
  return [
    `seed=${s.seed}`,
    s.family,
    s.mount,
    s.props,
    s.interaction,
    `scale=${s.fontScale}`,
    s.viewport.name,
    s.locale,
    s.rtl ? 'rtl' : 'ltr',
    s.timeZone,
    s.clockIso.slice(0, 19),
    s.persisted + (s.persistedKey ? `:${s.persistedKey}` : ''),
    s.payloadId,
  ].join(' ');
}
