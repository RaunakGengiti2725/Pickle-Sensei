/**
 * Pure (jest-free, React-free) building blocks for the NotificationSettings
 * BOUNDARY × I18N × A11Y stress campaign
 * (`__tests__/stress/notificationSettingsScreen.boundaryI18nA11y.stress.test.tsx`).
 *
 *   - `Rng`               seeded mulberry32; every scenario is a pure
 *                         function of its seed and replays bit-for-bit.
 *   - `scenarioFromSeed`  the full variant: font scale × width × permission
 *                         are a fixed grid over the seed (any 36 consecutive
 *                         seeds cover every cell), everything else — the
 *                         persisted-kv payload, in-memory prefs, failure
 *                         injections, wall-clock instant, locale, the tap
 *                         sequence — is drawn from the seed's RNG stream.
 *   - payload catalog     200+ char Latin, CJK, Arabic RTL, ZWJ emoji,
 *                         combining marks, German compounds, Thai, Devanagari,
 *                         Turkish, Russian, bidi controls, NUL, BOM; zero /
 *                         negative / huge / float / NaN-as-string numerics.
 *   - oracles             an independent 12-hour formatter and an independent
 *                         re-implementation of the persisted-prefs contract
 *                         (boolean fields keep booleans, everything else falls
 *                         back to the default; minutes must be an integer in
 *                         [0, 1440)).
 *   - `auditTree`         walks a react-test-renderer JSON tree and reports
 *                         every interactive element (role, label, state,
 *                         ≥44pt target), every text node (NaN / undefined /
 *                         payload leaks), clip risks (numberOfLines, fixed
 *                         heights vs the scaled line height, disabled font
 *                         scaling) and RTL-unsafe styles.
 *
 * The screen is English-only and reads no locale: the locale dimension is
 * therefore observational (recorded per seed, RTL flag applied for ar-EG)
 * rather than an oracle of translated copy. Time zone is a PROCESS-level
 * dimension (V8 caches TZ; jest's sandboxed process.env cannot change it) —
 * the campaign is run once per zone with `TZ=<zone>` and each result records
 * the zone it actually executed under.
 */

// ─── Seeded RNG (mulberry32) ─────────────────────────────────────────────────

export class Rng {
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
  int(minInclusive: number, maxInclusive: number): number {
    return (
      minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1))
    );
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }
}

// ─── Dimensions of the lens ──────────────────────────────────────────────────

export const FONT_SCALES = [1.0, 1.5, 3.0] as const;
export const WIDTHS = [320, 390, 430] as const;
export const PERMISSIONS = [
  'granted',
  'denied',
  'undetermined',
  'error',
] as const;
export type PermissionCell = (typeof PERMISSIONS)[number];

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
export type Locale = (typeof LOCALES)[number];
export const RTL_LOCALES: readonly Locale[] = ['ar-EG'];

/** The eight zones the campaign is run under (`TZ=<zone> npx jest …`). */
export const TIMEZONES = [
  'UTC',
  'Pacific/Kiritimati', // UTC+14, no DST
  'Etc/GMT+12', // UTC−12 (POSIX sign), no DST
  'America/New_York', // US DST (spring 2026-03-08, fall 2026-11-01)
  'Europe/Berlin', // EU DST (2026-03-29, 2026-10-25)
  'Australia/Sydney', // southern DST (2026-04-05, 2026-10-04)
  'Asia/Kolkata', // UTC+5:30 half-hour offset
  'Pacific/Chatham', // UTC+12:45 / +13:45 quarter-hour offset with DST
] as const;

/** Wall-clock instants on or around DST edges, plus quiet days. */
export const NOW_INSTANTS = [
  { label: 'us-spring-forward-eve', iso: '2026-03-08T06:59:00.000Z' },
  { label: 'us-spring-forward-gap', iso: '2026-03-08T07:15:00.000Z' },
  { label: 'us-fall-back-fold', iso: '2026-11-01T05:30:00.000Z' },
  { label: 'eu-spring-forward', iso: '2026-03-29T00:59:00.000Z' },
  { label: 'eu-fall-back', iso: '2026-10-25T01:30:00.000Z' },
  { label: 'au-fall-back', iso: '2026-04-04T16:30:00.000Z' },
  { label: 'au-spring-forward', iso: '2026-10-03T16:30:00.000Z' },
  { label: 'chatham-spring', iso: '2026-09-26T14:00:00.000Z' },
  { label: 'quiet-weekday', iso: '2026-06-17T09:12:00.000Z' },
  { label: 'quiet-sunday-late', iso: '2026-06-21T23:58:00.000Z' },
  { label: 'year-end', iso: '2026-12-31T23:59:30.000Z' },
  { label: 'leap-day-2028', iso: '2028-02-29T12:00:00.000Z' },
] as const;

export const MINUTES_IN_DAY = 24 * 60;
export const DEFAULT_MINUTES = 17 * 60 + 30;
export const TIME_STEP_MINUTES = 30;
export const MIN_TARGET_PT = 44;

// ─── Payload catalog ─────────────────────────────────────────────────────────

function repeatTo(unit: string, minChars: number): string {
  let out = '';
  while (out.length < minChars) out += unit;
  return out;
}

const ZALGO_MARKS =
  '\u0300\u0301\u0302\u0303\u0304\u0305\u0306\u0307\u0308\u0309\u030a\u030b\u030c\u030d\u030e\u030f\u0310\u0311\u0312\u0313\u0314\u0315\u031a\u031b\u033d\u033e\u033f\u0340\u0341\u0342\u0343\u0344\u0346\u034a\u034b\u034c\u0350\u0351\u0352\u0357\u035b\u0363\u0364\u0365\u0366\u0367\u0368\u0369\u036a\u036b\u036c\u036d\u036e\u036f';

export const STRING_PAYLOADS: readonly { id: string; value: string }[] = [
  {
    id: 'latin-240',
    value: repeatTo(
      'Reminder preferences are stored on this phone only and never leave it. ',
      240,
    ),
  },
  {
    id: 'cjk-220',
    value: repeatTo(
      '練習リマインダーは端末内でのみ予約されます。通知内容に個人情報は含まれません。',
      220,
    ),
  },
  {
    id: 'zh-210',
    value: repeatTo('练习提醒仅在本手机上安排，不会上传任何比赛数据。', 210),
  },
  {
    id: 'arabic-rtl-230',
    value: repeatTo(
      'يتم جدولة التذكيرات على هذا الهاتف فقط ولا تُرسل أي بيانات عن لعبك. ',
      230,
    ),
  },
  {
    id: 'hindi-220',
    value: repeatTo(
      'अभ्यास अनुस्मारक केवल इस फ़ोन पर निर्धारित होते हैं। ',
      220,
    ),
  },
  {
    id: 'thai-nospace-220',
    value: repeatTo(
      'การเตือนฝึกซ้อมถูกตั้งเวลาไว้บนโทรศัพท์เครื่องนี้เท่านั้น',
      220,
    ),
  },
  {
    id: 'russian-220',
    value: repeatTo(
      'Напоминания о тренировке планируются только на этом телефоне. ',
      220,
    ),
  },
  {
    id: 'turkish-dotless-200',
    value: repeatTo(
      'Iııİi Hatırlatıcılar yalnızca bu telefonda planlanır. ',
      200,
    ),
  },
  {
    id: 'german-compound-260',
    value: repeatTo(
      'Donaudampfschifffahrtselektrizitätenhauptbetriebswerkbauunterbeamtengesellschaft',
      260,
    ),
  },
  {
    id: 'zwj-emoji-family-50',
    value: repeatTo('👨‍👩‍👧‍👦🏳️‍🌈👩🏽‍🚀🧑🏿‍🤝‍🧑🏻', 50 * 4),
  },
  {
    id: 'flags-skin-tones',
    value: repeatTo('🇯🇵🇩🇪🇧🇷🇪🇬👍🏻👍🏼👍🏽👍🏾👍🏿', 120),
  },
  {
    id: 'combining-zalgo-200',
    value: repeatTo(
      `R${ZALGO_MARKS}e${ZALGO_MARKS}m${ZALGO_MARKS}i${ZALGO_MARKS}n${ZALGO_MARKS}d`,
      200,
    ),
  },
  {
    id: 'bidi-controls',
    value: '\u202Eevening\u202C \u2067مساء\u2069 \u200F\u200E 5:30 PM \u061C',
  },
  {
    id: 'control-chars',
    value:
      'a\u0000b\u0001c\u0007d\u000be\u000cf\u001bg\u007fh\u0085i\u2028j\u2029k',
  },
  { id: 'bom-nbsp-zwsp', value: '\uFEFF\u00A0\u200B\u2060\u180E\u3000' },
  { id: 'empty', value: '' },
  { id: 'whitespace', value: '   \t\n\r  ' },
  { id: 'json-like', value: '{"enabled":true,"practiceReminderMinutes":450}' },
  { id: 'html-script', value: '<script>alert("x")</script>' },
  { id: 'sql-like', value: "' OR 1=1; DROP TABLE kv; --" },
  { id: 'format-specifiers', value: '%s %d %@ %n {0} ${enabled}' },
  { id: 'huge-10k', value: repeatTo('x', 10_000) },
];

export type NumericPayload = {
  id: string;
  json: string; // literal as it appears in the JSON document
  /** The value `JSON.parse` produces for `json` (numbers only when finite). */
  parsed: unknown;
};

export const NUMERIC_PAYLOADS: readonly NumericPayload[] = [
  { id: 'zero', json: '0', parsed: 0 },
  { id: 'neg-zero', json: '-0', parsed: -0 },
  { id: 'one', json: '1', parsed: 1 },
  { id: 'last-minute', json: '1439', parsed: 1439 },
  { id: 'midnight-wrap', json: '1440', parsed: 1440 },
  { id: 'past-wrap', json: '1441', parsed: 1441 },
  { id: 'two-days', json: '2880', parsed: 2880 },
  { id: 'negative-30', json: '-30', parsed: -30 },
  { id: 'negative-day', json: '-1440', parsed: -1440 },
  { id: 'billion', json: '1000000000', parsed: 1_000_000_000 },
  { id: 'neg-billion', json: '-1000000000', parsed: -1_000_000_000 },
  { id: 'max-safe', json: '9007199254740991', parsed: 9007199254740991 },
  { id: 'beyond-safe', json: '9007199254740993', parsed: 9007199254740992 },
  { id: 'e308', json: '1e308', parsed: 1e308 },
  { id: 'overflow-inf', json: '1e400', parsed: Infinity },
  { id: 'float-1050.5', json: '1050.5', parsed: 1050.5 },
  { id: 'float-0.1', json: '0.1', parsed: 0.1 },
  { id: 'exp-int', json: '1.05e3', parsed: 1050 },
  { id: 'string-number', json: '"1050"', parsed: '1050' },
  { id: 'string-nan', json: '"NaN"', parsed: 'NaN' },
  { id: 'string-inf', json: '"Infinity"', parsed: 'Infinity' },
  { id: 'null', json: 'null', parsed: null },
  { id: 'true', json: 'true', parsed: true },
  { id: 'array', json: '[1050]', parsed: [1050] },
  { id: 'object', json: '{"minutes":1050}', parsed: { minutes: 1050 } },
];

export const PREF_BOOL_KEYS = [
  'enabled',
  'practiceReminder',
  'streakDefense',
  'weeklyRecap',
  'comeback',
  'promptDismissed',
] as const;
export type PrefBoolKey = (typeof PREF_BOOL_KEYS)[number];

export const DEFAULT_PREFS_ORACLE: Record<PrefBoolKey, boolean> = {
  enabled: false,
  practiceReminder: true,
  streakDefense: true,
  weeklyRecap: true,
  comeback: true,
  promptDismissed: false,
};

// ─── Scenario ────────────────────────────────────────────────────────────────

export type HydrationKind =
  | 'kv-absent'
  | 'kv-valid'
  | 'kv-field-fuzz'
  | 'kv-raw-string'
  | 'kv-invalid-json'
  | 'kv-non-object'
  | 'kv-huge'
  | 'pending-onboarding';

export type ActionKind =
  | 'turn-on'
  | 'switch'
  | 'preset'
  | 'earlier'
  | 'later'
  | 'open-settings'
  | 'check-again';

export interface PlannedAction {
  kind: ActionKind;
  /** Switch label or preset index, depending on kind. */
  target?: string | number;
}

export interface Scenario {
  seed: number;
  fontScale: (typeof FONT_SCALES)[number];
  width: (typeof WIDTHS)[number];
  permission: PermissionCell;
  /** Result of the system prompt when the player taps "Turn on reminders". */
  promptResult: 'granted' | 'denied' | 'error';
  locale: Locale;
  rtl: boolean;
  owner: 'uuid' | 'guest' | 'signed-out';
  ownerId: string;
  now: (typeof NOW_INSTANTS)[number];
  hydration: HydrationKind;
  /** Raw kv document for the prefs key (null = absent). */
  kvPrefsRaw: string | null;
  /** Raw kv document for the pending onboarding key (null = absent). */
  kvPendingRaw: string | null;
  /** Payload ids embedded in the kv documents (for leak checks). */
  payloadIds: string[];
  payloadStrings: string[];
  /** The persisted-prefs oracle: what the screen must show after hydrate. */
  expectedBools: Record<PrefBoolKey, boolean>;
  expectedMinutes: number;
  persistFails: boolean;
  scheduleFails: boolean;
  openSettingsFails: boolean;
  /** Onboarding choice could not be persisted at hydrate → shown next launch. */
  pendingDeferredByWriteFailure: boolean;
  actions: PlannedAction[];
  pressBackAtEnd: boolean;
  streakDays: number;
  practicedToday: boolean;
  hasAnyHistory: boolean;
}

function uuidFromRng(rng: Rng): string {
  const hex = (n: number) =>
    Array.from({ length: n }, () => rng.int(0, 15).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${rng.pick(['8', '9', 'a', 'b'])}${hex(3)}-${hex(12)}`;
}

function jsonStringLiteral(value: string): string {
  return JSON.stringify(value);
}

/** Independent oracle for the persisted-prefs contract. */
export function oracleFromRecord(record: Record<string, unknown> | null): {
  bools: Record<PrefBoolKey, boolean>;
  minutes: number;
} {
  const bools: Record<PrefBoolKey, boolean> = { ...DEFAULT_PREFS_ORACLE };
  let minutes = DEFAULT_MINUTES;
  if (record) {
    for (const key of PREF_BOOL_KEYS) {
      const v = record[key];
      if (typeof v === 'boolean') bools[key] = v;
    }
    const m = record['practiceReminderMinutes'];
    if (
      typeof m === 'number' &&
      Number.isInteger(m) &&
      m >= 0 &&
      m < MINUTES_IN_DAY
    ) {
      minutes = m;
    }
  }
  return { bools, minutes };
}

function parseRecordOrNull(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    return v as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function scenarioFromSeed(seed: number): Scenario {
  const rng = new Rng((seed * 2654435761 + 0x9e3779b9) >>> 0);
  const fontScale = FONT_SCALES[seed % 3]!;
  const width = WIDTHS[Math.floor(seed / 3) % 3]!;
  const permission = PERMISSIONS[Math.floor(seed / 9) % 4]!;
  const locale = rng.pick(LOCALES);
  const promptResult = rng.pick([
    'granted',
    'granted',
    'granted',
    'denied',
    'error',
  ] as const);
  const ownerRoll = rng.next();
  const owner: Scenario['owner'] =
    ownerRoll < 0.04 ? 'signed-out' : ownerRoll < 0.2 ? 'guest' : 'uuid';
  const ownerId =
    owner === 'uuid'
      ? uuidFromRng(rng)
      : owner === 'guest'
        ? 'device-guest'
        : 'signed-out';
  const now = rng.pick(NOW_INSTANTS);

  const hydration = rng.pick([
    'kv-absent',
    'kv-valid',
    'kv-valid',
    'kv-field-fuzz',
    'kv-field-fuzz',
    'kv-field-fuzz',
    'kv-raw-string',
    'kv-invalid-json',
    'kv-non-object',
    'kv-huge',
    'pending-onboarding',
  ] as const);

  const payloadIds: string[] = [];
  const payloadStrings: string[] = [];
  const useString = (): string => {
    const p = rng.pick(STRING_PAYLOADS);
    payloadIds.push(p.id);
    if (p.value.trim().length > 0) payloadStrings.push(p.value);
    return p.value;
  };
  const useNumeric = (): NumericPayload => {
    const p = rng.pick(NUMERIC_PAYLOADS);
    payloadIds.push(p.id);
    return p;
  };

  let kvPrefsRaw: string | null = null;
  let kvPendingRaw: string | null = null;

  const fieldLiteral = (): string => {
    const roll = rng.next();
    if (roll < 0.45) return rng.chance(0.5) ? 'true' : 'false';
    if (roll < 0.7) return jsonStringLiteral(useString());
    if (roll < 0.9) return useNumeric().json;
    return rng.pick(['null', '[]', '{}', '"true"', '"false"', '0', '1']);
  };

  switch (hydration) {
    case 'kv-absent':
      break;
    case 'kv-valid': {
      const minutes = rng.pick([
        0,
        1,
        29,
        30,
        450,
        720,
        1050,
        1170,
        1410,
        1439,
        rng.int(0, MINUTES_IN_DAY - 1),
      ]);
      const parts = PREF_BOOL_KEYS.map(
        k => `"${k}":${rng.chance(0.5) ? 'true' : 'false'}`,
      );
      parts.push(`"practiceReminderMinutes":${minutes}`);
      parts.push('"version":1');
      kvPrefsRaw = `{${parts.join(',')}}`;
      break;
    }
    case 'kv-field-fuzz': {
      const parts: string[] = [];
      for (const key of PREF_BOOL_KEYS) {
        if (rng.chance(0.85)) parts.push(`"${key}":${fieldLiteral()}`);
      }
      if (rng.chance(0.9)) {
        const roll = rng.next();
        const literal =
          roll < 0.6
            ? useNumeric().json
            : roll < 0.8
              ? jsonStringLiteral(useString())
              : rng.pick(['true', 'null', '[]', '{}']);
        parts.push(`"practiceReminderMinutes":${literal}`);
      }
      if (rng.chance(0.5)) {
        parts.push(
          `"version":${rng.pick(['1', '2', '0', '-1', '"1"', 'null'])}`,
        );
      }
      if (rng.chance(0.4)) {
        parts.push(
          `${jsonStringLiteral(useString())}:${jsonStringLiteral(useString())}`,
        );
      }
      if (rng.chance(0.2)) parts.push('"__proto__":{"enabled":true}');
      kvPrefsRaw = `{${parts.join(',')}}`;
      break;
    }
    case 'kv-raw-string':
      kvPrefsRaw = useString();
      break;
    case 'kv-invalid-json':
      kvPrefsRaw = rng.pick([
        '{',
        '{"enabled":tru}',
        '{"enabled":true,}',
        "{'enabled':true}",
        `{"enabled":${jsonStringLiteral(useString())}`,
        'undefined',
        'NaN',
        '\u0000',
      ]);
      break;
    case 'kv-non-object':
      kvPrefsRaw = rng.pick([
        'null',
        'true',
        'false',
        '[]',
        '[{"enabled":true}]',
        '1050',
        '-1',
        '""',
        jsonStringLiteral(useString()),
      ]);
      break;
    case 'kv-huge': {
      const filler = repeatTo(useString(), 60_000);
      kvPrefsRaw = `{"enabled":true,"filler":${jsonStringLiteral(filler)},"practiceReminderMinutes":450}`;
      break;
    }
    case 'pending-onboarding': {
      const roll = rng.next();
      kvPendingRaw =
        roll < 0.5
          ? `{"version":1,"enabled":${rng.chance(0.5) ? 'true' : 'false'}}`
          : roll < 0.7
            ? `{"version":1,"enabled":${jsonStringLiteral(useString())}}`
            : roll < 0.85
              ? `{"version":${useNumeric().json},"enabled":true}`
              : useString();
      if (rng.chance(0.3)) {
        kvPrefsRaw = `{"enabled":false,"practiceReminderMinutes":450}`;
      }
      break;
    }
  }

  const persistFails = rng.chance(0.15);
  const scheduleFails = rng.chance(0.15);
  const openSettingsFails = rng.chance(0.3);

  const record = parseRecordOrNull(kvPrefsRaw);
  const oracle = oracleFromRecord(record);
  let pendingDeferredByWriteFailure = false;
  // Pending onboarding choice applies only when no prefs doc exists and the
  // pending doc is exactly {version:1, enabled:boolean}. Persisting the
  // applied choice can fail; the store then keeps the marker for the next
  // launch and shows defaults for this one (recorded, not judged). A failure
  // to CLEAR a stale marker must not discard prefs that were read fine.
  const pending = parseRecordOrNull(kvPendingRaw);
  const pendingValid =
    pending !== null &&
    pending['version'] === 1 &&
    typeof pending['enabled'] === 'boolean';
  if (pendingValid && !kvPrefsRaw) {
    if (persistFails) {
      pendingDeferredByWriteFailure = true;
    } else {
      oracle.bools.enabled = pending!['enabled'] as boolean;
      oracle.bools.promptDismissed = true;
    }
  }
  if (owner === 'signed-out') {
    // A signed-out process hydrates to defaults regardless of the kv.
    oracle.bools = { ...DEFAULT_PREFS_ORACLE };
    oracle.minutes = DEFAULT_MINUTES;
    pendingDeferredByWriteFailure = false;
  }

  const actionCount = rng.int(0, 7);
  const actions: PlannedAction[] = [];
  for (let i = 0; i < actionCount; i += 1) {
    const roll = rng.next();
    if (roll < 0.15) actions.push({ kind: 'turn-on' });
    else if (roll < 0.4)
      actions.push({
        kind: 'switch',
        target: rng.pick([
          'All reminders',
          'Practice nudge',
          'Streak defense',
          'Weekly recap',
          'Welcome back',
        ]),
      });
    else if (roll < 0.6)
      actions.push({ kind: 'preset', target: rng.int(0, 3) });
    else if (roll < 0.75) actions.push({ kind: 'earlier' });
    else if (roll < 0.9) actions.push({ kind: 'later' });
    else if (roll < 0.95) actions.push({ kind: 'open-settings' });
    else actions.push({ kind: 'check-again' });
  }

  return {
    seed,
    fontScale,
    width,
    permission,
    promptResult,
    locale,
    rtl: RTL_LOCALES.includes(locale),
    owner,
    ownerId,
    now,
    hydration,
    kvPrefsRaw,
    kvPendingRaw,
    payloadIds,
    payloadStrings,
    expectedBools: oracle.bools,
    expectedMinutes: oracle.minutes,
    persistFails,
    scheduleFails,
    openSettingsFails,
    pendingDeferredByWriteFailure,
    actions,
    pressBackAtEnd: rng.chance(0.7),
    streakDays: rng.pick([0, 1, 2, 7, 30, 365]),
    practicedToday: rng.chance(0.4),
    hasAnyHistory: rng.chance(0.8),
  };
}

// ─── Oracles ─────────────────────────────────────────────────────────────────

/** Independent 12-hour clock formatter (the screen's contract: `h:mm AM|PM`). */
export function expectedTimeLabel(minutes: number): string {
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${m < 10 ? `0${m}` : m} ${h24 < 12 ? 'AM' : 'PM'}`;
}

export const PRESETS = [
  { label: 'Morning', minutes: 7 * 60 + 30 },
  { label: 'Midday', minutes: 12 * 60 },
  { label: 'Evening', minutes: 17 * 60 + 30 },
  { label: 'Night', minutes: 19 * 60 + 30 },
] as const;

export function presetAccessibilityLabel(index: number): string {
  const p = PRESETS[index]!;
  return `${p.label}, ${expectedTimeLabel(p.minutes)}`;
}

/** Local wall-clock minutes of an instant in the CURRENT process zone. */
export function localMinutesOf(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * True when `minutes` past midnight does not exist on the local calendar day
 * of `dayMs` (a spring-forward gap). Checks both the offset in force at the
 * start and at the end of that day.
 */
export function isDstGap(dayMs: number, minutes: number): boolean {
  const d = new Date(dayMs);
  const y = d.getFullYear();
  const mo = d.getMonth();
  const day = d.getDate();
  const start = new Date(y, mo, day, 0, 0, 0, 0);
  const end = new Date(y, mo, day, 23, 59, 0, 0);
  const offsets = new Set([start.getTimezoneOffset(), end.getTimezoneOffset()]);
  for (const offset of offsets) {
    const candidate =
      Date.UTC(y, mo, day, Math.floor(minutes / 60), minutes % 60) +
      offset * 60_000;
    const back = new Date(candidate);
    if (
      back.getFullYear() === y &&
      back.getMonth() === mo &&
      back.getDate() === day &&
      back.getHours() * 60 + back.getMinutes() === minutes
    ) {
      return false;
    }
  }
  return true;
}

// ─── Rendered-tree audit ─────────────────────────────────────────────────────

export interface TreeNode {
  type: string;
  props: Record<string, unknown>;
  children?: (TreeNode | string)[] | null;
}

type Style = Record<string, unknown>;

export function flattenStyle(style: unknown): Style {
  if (!style) return {};
  if (Array.isArray(style)) {
    const out: Style = {};
    for (const part of style) Object.assign(out, flattenStyle(part));
    return out;
  }
  if (typeof style === 'object') return style as Style;
  return {};
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'switch',
  'link',
  'adjustable',
  'checkbox',
  'radio',
  'tab',
  'togglebutton',
  'menuitem',
  'imagebutton',
  'combobox',
  'spinbutton',
  'slider',
]);

export interface InteractiveReport {
  role: string | null;
  label: string | null;
  hint: string | null;
  disabled: boolean | null;
  checked: boolean | null;
  selected: boolean | null;
  /** Explicit height / minHeight on the pressable or its wrapper. */
  heightPt: number;
  /** Explicit width / minWidth, or Infinity when the element stretches. */
  widthPt: number;
  hitSlop: number | null;
  path: string;
  issues: string[];
}

export interface TextReport {
  text: string;
  fontSize: number | null;
  lineHeight: number | null;
  numberOfLines: number | null;
  allowFontScaling: boolean | null;
  maxFontSizeMultiplier: number | null;
  /** Explicit height of the nearest ancestor with a fixed `height`. */
  fixedAncestorHeight: number | null;
  path: string;
  issues: string[];
}

export interface TreeAudit {
  interactives: InteractiveReport[];
  texts: TextReport[];
  alerts: number;
  rtlUnsafe: string[];
  duplicateLabels: string[];
  /** Estimated clip/overflow risks (static estimate — no layout engine). */
  clipRisks: string[];
  violations: string[];
}

function textOf(node: TreeNode): string {
  const parts: string[] = [];
  const walk = (n: TreeNode | string) => {
    if (typeof n === 'string') parts.push(n);
    else for (const c of n.children ?? []) walk(c);
  };
  walk(node);
  return parts.join('');
}

function numeric(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Rough Latin/CJK glyph-advance estimate used only for clip *risk* flags. */
function estimateTextWidthPt(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x2e80 && cp <= 0x9fff) w += fontSize * 1.0;
    else if (cp >= 0xac00 && cp <= 0xd7af) w += fontSize * 1.0;
    else if (ch === ' ') w += fontSize * 0.28;
    else if (/[iljt.,:;'!|]/.test(ch)) w += fontSize * 0.3;
    else if (/[A-Z]/.test(ch)) w += fontSize * 0.66;
    else w += fontSize * 0.54;
  }
  return w;
}

export function auditTree(
  root: TreeNode | TreeNode[] | null,
  options: {
    fontScale: number;
    width: number;
    rtl: boolean;
    payloadStrings: readonly string[];
  },
): TreeAudit {
  const audit: TreeAudit = {
    interactives: [],
    texts: [],
    alerts: 0,
    rtlUnsafe: [],
    duplicateLabels: [],
    clipRisks: [],
    violations: [],
  };
  if (!root) {
    audit.violations.push('tree: renderer produced no host output');
    return audit;
  }
  const roots = Array.isArray(root) ? root : [root];

  const visit = (
    node: TreeNode | string,
    ancestors: TreeNode[],
    path: string,
  ) => {
    if (typeof node === 'string') return;
    const props = node.props ?? {};
    const style = flattenStyle(props['style']);
    const role =
      typeof props['accessibilityRole'] === 'string'
        ? (props['accessibilityRole'] as string)
        : null;

    if (role === 'alert') audit.alerts += 1;

    // RTL-unsafe styling: hard text alignment / absolute left-right.
    if (options.rtl) {
      const ta = style['textAlign'];
      if (ta === 'left' || ta === 'right')
        audit.rtlUnsafe.push(`${path}: textAlign=${String(ta)}`);
      // Symmetric absolute fills (left === right) mirror trivially; only
      // one-sided or asymmetric offsets are direction-dependent.
      if (
        style['position'] === 'absolute' &&
        ('left' in style || 'right' in style) &&
        style['left'] !== style['right']
      )
        audit.rtlUnsafe.push(
          `${path}: absolute left=${String(style['left'])} right=${String(style['right'])}`,
        );
    }

    const isInteractive =
      (role !== null && INTERACTIVE_ROLES.has(role)) ||
      typeof props['onClick'] === 'function' ||
      typeof props['onPress'] === 'function';
    if (isInteractive) {
      const issues: string[] = [];
      const label =
        typeof props['accessibilityLabel'] === 'string'
          ? (props['accessibilityLabel'] as string)
          : null;
      const state = (props['accessibilityState'] ?? {}) as Record<
        string,
        unknown
      >;
      if (!role || !INTERACTIVE_ROLES.has(role))
        issues.push('missing/unknown accessibilityRole');
      if (!label || label.trim().length === 0) {
        // A text-only child is an acceptable implicit label; anything else is not.
        const inner = textOf(node).trim();
        if (inner.length === 0)
          issues.push('no accessibilityLabel and no text content');
      }
      if (props['accessible'] === false)
        issues.push('accessible=false on an interactive');
      if (role === 'switch' && typeof state['checked'] !== 'boolean')
        issues.push('switch without boolean accessibilityState.checked');
      if (props['disabled'] === true && state['disabled'] !== true)
        issues.push('disabled prop without accessibilityState.disabled');

      // Target size: the pressable's own style, then the PressableScale wrapper.
      const wrapper = ancestors[ancestors.length - 1];
      const wrapperStyle = wrapper ? flattenStyle(wrapper.props['style']) : {};
      const height =
        numeric(style['height']) ??
        numeric(style['minHeight']) ??
        numeric(wrapperStyle['height']) ??
        numeric(wrapperStyle['minHeight']) ??
        0;
      const stretches =
        wrapperStyle['alignSelf'] === 'stretch' ||
        (numeric(wrapperStyle['flex']) ?? 0) >= 1 ||
        style['alignSelf'] === 'stretch' ||
        (numeric(style['flex']) ?? 0) >= 1;
      const explicitWidth =
        numeric(style['width']) ??
        numeric(style['minWidth']) ??
        numeric(wrapperStyle['width']) ??
        numeric(wrapperStyle['minWidth']);
      const widthPt = explicitWidth ?? (stretches ? Infinity : 0);
      const hitSlopRaw = props['hitSlop'];
      const hitSlop =
        typeof hitSlopRaw === 'number'
          ? hitSlopRaw
          : hitSlopRaw && typeof hitSlopRaw === 'object'
            ? Math.min(
                ...Object.values(hitSlopRaw as Record<string, unknown>).map(
                  v => numeric(v) ?? 0,
                ),
              )
            : null;
      const effectiveH = height + 2 * (hitSlop ?? 0);
      const effectiveW = widthPt + 2 * (hitSlop ?? 0);
      if (effectiveH < MIN_TARGET_PT)
        issues.push(
          `target height ${height}pt (+hitSlop ${hitSlop ?? 0}) < ${MIN_TARGET_PT}`,
        );
      if (effectiveW < MIN_TARGET_PT)
        issues.push(
          `target width ${widthPt}pt (+hitSlop ${hitSlop ?? 0}) < ${MIN_TARGET_PT}`,
        );

      audit.interactives.push({
        role,
        label,
        hint:
          typeof props['accessibilityHint'] === 'string'
            ? (props['accessibilityHint'] as string)
            : null,
        disabled:
          typeof state['disabled'] === 'boolean'
            ? (state['disabled'] as boolean)
            : null,
        checked:
          typeof state['checked'] === 'boolean'
            ? (state['checked'] as boolean)
            : null,
        selected:
          typeof state['selected'] === 'boolean'
            ? (state['selected'] as boolean)
            : null,
        heightPt: height,
        widthPt,
        hitSlop,
        path,
        issues,
      });
      for (const issue of issues)
        audit.violations.push(`${label ?? role ?? path}: ${issue}`);
    }

    if (node.type === 'Text') {
      const issues: string[] = [];
      const text = textOf(node);
      const fontSize = numeric(style['fontSize']);
      const lineHeight = numeric(style['lineHeight']);
      const numberOfLines = numeric(props['numberOfLines']);
      const allowFontScaling =
        typeof props['allowFontScaling'] === 'boolean'
          ? (props['allowFontScaling'] as boolean)
          : null;
      const maxFontSizeMultiplier = numeric(props['maxFontSizeMultiplier']);
      const children = node.children ?? [];
      const hasNonString = children.some(
        c => typeof c !== 'string' && c.type !== 'Text',
      );
      if (hasNonString) issues.push('non-text child inside <Text>');
      if (/\b(NaN|undefined|null|Infinity|\[object Object\])\b/.test(text))
        issues.push(
          `renders "${text.match(/NaN|undefined|null|Infinity|\[object Object\]/)?.[0]}"`,
        );
      for (const payload of options.payloadStrings) {
        if (
          payload.length >= 3 &&
          text.includes(payload.slice(0, Math.min(payload.length, 40)))
        ) {
          issues.push('persisted payload leaked into rendered text');
          break;
        }
      }
      if (allowFontScaling === false)
        issues.push('allowFontScaling=false (Dynamic Type disabled)');
      if (
        maxFontSizeMultiplier !== null &&
        maxFontSizeMultiplier < options.fontScale
      )
        audit.clipRisks.push(
          `${path}: maxFontSizeMultiplier ${maxFontSizeMultiplier} caps scale ${options.fontScale}`,
        );

      let fixedAncestorHeight: number | null = null;
      for (let i = ancestors.length - 1; i >= 0; i -= 1) {
        const h = numeric(flattenStyle(ancestors[i]!.props['style'])['height']);
        if (h !== null) {
          fixedAncestorHeight = h;
          break;
        }
      }
      const scaledLine =
        (lineHeight ?? (fontSize ?? 14) * 1.2) * options.fontScale;
      if (fixedAncestorHeight !== null && scaledLine > fixedAncestorHeight) {
        audit.clipRisks.push(
          `${path}: "${text.slice(0, 30)}" scaled line ${scaledLine.toFixed(0)}pt inside fixed ${fixedAncestorHeight}pt container`,
        );
      }
      if (numberOfLines !== null && fontSize !== null) {
        // Header title sits between two 44pt sides inside space.lg padding.
        const available = options.width - 2 * 24 - 2 * 44;
        const est = estimateTextWidthPt(text, fontSize * options.fontScale);
        if (est > available * numberOfLines) {
          audit.clipRisks.push(
            `${path}: numberOfLines=${numberOfLines} "${text}" est ${est.toFixed(0)}pt > ${available}pt available at ${options.width}pt × ${options.fontScale}x`,
          );
        }
      }
      audit.texts.push({
        text,
        fontSize,
        lineHeight,
        numberOfLines,
        allowFontScaling,
        maxFontSizeMultiplier,
        fixedAncestorHeight,
        path,
        issues,
      });
      for (const issue of issues)
        audit.violations.push(`text "${text.slice(0, 40)}": ${issue}`);
    }

    const kids = node.children ?? [];
    kids.forEach((child, index) => {
      visit(child, [...ancestors, node], `${path}/${node.type}[${index}]`);
    });
  };

  roots.forEach((r, i) => visit(r, [], `#${i}`));

  // Duplicate labels among ENABLED interactives are ambiguous to VoiceOver.
  const seen = new Map<string, number>();
  for (const it of audit.interactives) {
    if (!it.label || it.disabled) continue;
    const key = `${it.role}:${it.label}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [key, count] of seen) {
    if (count > 1) {
      audit.duplicateLabels.push(`${key} ×${count}`);
      audit.violations.push(
        `duplicate enabled interactive label ${key} ×${count}`,
      );
    }
  }
  return audit;
}

// ─── Result records ──────────────────────────────────────────────────────────

export interface SeedResult {
  seed: number;
  outcome: 'HELD' | 'BROKEN';
  tz: string;
  scenario: Omit<Scenario, 'payloadStrings' | 'kvPrefsRaw'> & {
    kvPrefsRawPreview: string | null;
    kvPrefsRawLength: number;
  };
  interactives: number;
  texts: number;
  alerts: number;
  clipRisks: string[];
  rtlUnsafe: string[];
  actionsExecuted: number;
  finalMinutes: number | null;
  timeLabel: string | null;
  plannedPracticeLocalMinutes: number | null;
  dstGap: boolean;
  consoleErrors: string[];
  failures: string[];
  durationMs: number;
  replay: string;
}
