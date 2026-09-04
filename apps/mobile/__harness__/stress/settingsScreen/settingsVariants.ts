import type { AuthSession } from '../../../src/auth/authStore';
import type { CanonicalAccessState } from '../../../src/billing/types';
import type {
  ConsistencySnapshot,
  TrainingActivityInput,
} from '../../../src/consistency/engine';
import { buildConsistencySnapshot } from '../../../src/consistency/engine';
import type { NotificationPrefs } from '../../../src/notifications/types';
import {
  DEFAULT_NOTIFICATION_PREFS,
  parseNotificationPrefs,
} from '../../../src/notifications/types';
import type { Profile } from '../../../src/state/profile';
import { SeededRng } from './seededRng';
import { TEXT_CLASSES, textFor, type TextClass } from './textCorpus';

/** The 12 locales named by the lens; each selects the script corpus used for
 * user-controlled strings (the app itself ships English copy only). */
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

/** 8 zones: the UTC+14 / UTC-12 extremes, three DST zones (one with a
 * 30-minute shift), two non-hour offsets, and UTC itself. */
export const TIMEZONES = [
  'Pacific/Kiritimati',
  'Etc/GMT+12',
  'America/New_York',
  'Europe/Berlin',
  'Australia/Lord_Howe',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'UTC',
] as const;
export type TimeZone = (typeof TIMEZONES)[number];

/** Instants sitting on DST transitions / day boundaries in the zones above. */
export const AS_OF_INSTANTS = [
  '2026-03-08T07:00:00.000Z', // US spring forward (02:00 EST -> 03:00 EDT)
  '2026-11-01T05:59:59.000Z', // one second before US fall back
  '2026-11-01T06:00:00.000Z', // US fall back
  '2026-03-29T01:00:00.000Z', // EU spring forward
  '2026-10-25T00:59:59.000Z', // EU fall back edge
  '2026-04-05T15:59:59.000Z', // Lord Howe 30-minute DST end edge
  '2026-01-01T00:00:00.000Z', // UTC midnight, still Dec 31 west of UTC
  '2026-12-31T23:59:59.999Z', // last millisecond of the year
] as const;

/** iOS Dynamic Type: default, "Large" accessibility size, AX5 (largest). */
export const FONT_SCALES = [1, 1.5, 3.12] as const;
/** Portrait widths: iPhone SE (1st gen), iPhone 15, iPhone 15 Pro Max. */
export const WIDTHS = [320, 375, 430] as const;

export type SessionKind =
  'signed_out' | 'guest' | 'apple_synced' | 'google_synced';

export type AccessCase =
  | 'none'
  | 'free_2'
  | 'free_1'
  | 'free_0'
  | 'reserved_1'
  | 'premium'
  | 'hostile_negative'
  | 'hostile_huge'
  | 'hostile_nan';

export type NotificationCase =
  | 'off'
  | 'denied'
  | 'on_no_reminder'
  | 'reminder_midnight'
  | 'reminder_last_minute'
  | 'reminder_default'
  | 'reminder_random'
  | 'hostile_negative'
  | 'hostile_over_day'
  | 'hostile_huge'
  | 'hostile_nan';

export type ConsistencyCase =
  | 'none'
  | 'engine_empty'
  | 'engine_dst_streak'
  | 'engine_long_streak'
  | 'hostile_negative'
  | 'hostile_huge';

export type ConsentCase =
  'signed_out' | 'ready_on' | 'ready_off' | 'unavailable' | 'loading';

export interface SettingsVariant {
  seed: number;
  locale: Locale;
  timeZone: TimeZone;
  asOfIso: string;
  fontScale: number;
  width: number;
  rtl: boolean;
  session: {
    kind: SessionKind;
    displayNameClass: TextClass | 'null' | 'empty_string';
    emailClass: TextClass | 'null';
  };
  profile: {
    present: boolean;
    firstNameClass: TextClass | 'undefined';
    genderCase: 'set' | 'undefined';
    skillLevelClass: 'canonical' | 'long' | 'empty';
    focusCase: 'canonical' | 'underscored_long';
  };
  access: AccessCase;
  notifications: NotificationCase;
  consistency: ConsistencyCase;
  consent: ConsentCase;
  legal: 'both' | 'privacy_only' | 'none';
  appVersionClass: 'canonical' | 'long';
}

export interface SettingsFixture {
  variant: SettingsVariant;
  session: AuthSession | null;
  profile: Profile | null;
  access: CanonicalAccessState | null;
  /** Access injected straight into the store (bypasses the API parser). */
  accessInjectedRaw: boolean;
  notificationPrefs: NotificationPrefs;
  notificationPermission: 'granted' | 'denied' | 'undetermined' | 'unknown';
  consistency: ConsistencySnapshot | null;
  consentStatusActive: boolean | null;
  legalPrivacyUrl: string | null;
  legalTermsUrl: string | null;
  appVersion: string;
}

const SCRIPT_BY_LOCALE: Record<Locale, readonly TextClass[]> = {
  'de-DE': ['german_compound', 'latin_200', 'latin_short', 'combining_leading'],
  'fr-FR': ['combining_leading', 'latin_200', 'zalgo', 'latin_short'],
  'ar-EG': ['arabic_rtl', 'arabic_rtl_200', 'bidi_override', 'latin_short'],
  'hi-IN': ['hindi_combining', 'latin_short', 'zwj_emoji'],
  'ja-JP': ['cjk_ja', 'astral_leading', 'emoji_leading'],
  'pt-BR': ['combining_leading', 'latin_200', 'emoji_leading', 'latin_short'],
  'tr-TR': ['turkish_dotless', 'latin_short', 'german_compound'],
  'ru-RU': ['cyrillic', 'latin_200', 'zalgo'],
  'th-TH': ['thai_unspaced', 'latin_short', 'zwj_emoji'],
  'zh-CN': ['cjk_zh', 'astral_leading', 'latin_short'],
  'en-IN': ['latin_short', 'latin_200', 'hindi_combining', 'zwj_emoji'],
  'es-419': ['combining_leading', 'latin_200', 'emoji_leading', 'latin_short'],
};

const BOUNDARY_CLASSES: readonly TextClass[] = [
  'empty',
  'whitespace_only',
  'newline_embedded',
  'zwj_emoji',
  'emoji_leading',
  'astral_leading',
  'combining_leading',
];

function pickTextClass(rng: SeededRng, locale: Locale): TextClass {
  if (rng.chance(0.25)) return rng.pick(BOUNDARY_CLASSES);
  if (rng.chance(0.1)) return rng.pick(TEXT_CLASSES);
  return rng.pick(SCRIPT_BY_LOCALE[locale]);
}

export function buildVariant(seed: number): SettingsVariant {
  const rng = new SeededRng(seed);
  const locale = rng.pick(LOCALES);
  const kind = rng.pick<SessionKind>([
    'guest',
    'apple_synced',
    'google_synced',
    'apple_synced',
    'google_synced',
    'signed_out',
  ]);
  const displayNameRoll = rng.next();
  const displayNameClass: SettingsVariant['session']['displayNameClass'] =
    kind === 'guest' || kind === 'signed_out'
      ? 'null'
      : displayNameRoll < 0.12
        ? 'null'
        : displayNameRoll < 0.2
          ? 'empty_string'
          : pickTextClass(rng, locale);
  return {
    seed,
    locale,
    timeZone: rng.pick(TIMEZONES),
    asOfIso: rng.pick(AS_OF_INSTANTS),
    fontScale: rng.pick(FONT_SCALES),
    width: rng.pick(WIDTHS),
    rtl: locale === 'ar-EG',
    session: {
      kind,
      displayNameClass,
      emailClass: rng.chance(0.2)
        ? 'null'
        : rng.chance(0.7)
          ? 'latin_short'
          : pickTextClass(rng, locale),
    },
    profile: {
      present: rng.chance(0.85),
      firstNameClass: rng.chance(0.2)
        ? 'undefined'
        : pickTextClass(rng, locale),
      genderCase: rng.chance(0.7) ? 'set' : 'undefined',
      skillLevelClass: rng.chance(0.8)
        ? 'canonical'
        : rng.chance(0.5)
          ? 'long'
          : 'empty',
      focusCase: rng.chance(0.8) ? 'canonical' : 'underscored_long',
    },
    access: rng.pick<AccessCase>([
      'none',
      'free_2',
      'free_1',
      'free_0',
      'reserved_1',
      'premium',
      'hostile_negative',
      'hostile_huge',
      'hostile_nan',
    ]),
    notifications: rng.pick<NotificationCase>([
      'off',
      'denied',
      'on_no_reminder',
      'reminder_midnight',
      'reminder_last_minute',
      'reminder_default',
      'reminder_random',
      'hostile_negative',
      'hostile_over_day',
      'hostile_huge',
      'hostile_nan',
    ]),
    consistency: rng.pick<ConsistencyCase>([
      'none',
      'engine_empty',
      'engine_dst_streak',
      'engine_long_streak',
      'hostile_negative',
      'hostile_huge',
    ]),
    consent: rng.pick<ConsentCase>([
      'signed_out',
      'ready_on',
      'ready_off',
      'unavailable',
      'loading',
    ]),
    legal: rng.pick(['both', 'both', 'privacy_only', 'none']),
    appVersionClass: rng.chance(0.85) ? 'canonical' : 'long',
  };
}

function textOrNull(
  rng: SeededRng,
  cls: TextClass | 'null' | 'empty_string' | 'undefined',
): string | null {
  if (cls === 'null' || cls === 'undefined') return null;
  if (cls === 'empty_string') return '';
  return textFor(rng, cls);
}

function makeAccess(caseName: AccessCase): {
  access: CanonicalAccessState | null;
  raw: boolean;
} {
  const free = (used: number, reserved: number): CanonicalAccessState => {
    const remaining = 2 - used;
    const availableToReserve = remaining - reserved;
    return {
      premium: false,
      entitlements: [],
      freeRatings: { limit: 2, used, reserved, remaining, availableToReserve },
      canStartRating: availableToReserve > 0,
      paywallRequired: availableToReserve <= 0,
    };
  };
  const hostile = (availableToReserve: number): CanonicalAccessState => ({
    premium: false,
    entitlements: [],
    freeRatings: {
      limit: 2,
      used: 0,
      reserved: 0,
      remaining: 2,
      availableToReserve,
    },
    canStartRating: true,
    paywallRequired: false,
  });
  switch (caseName) {
    case 'none':
      return { access: null, raw: false };
    case 'free_2':
      return { access: free(0, 0), raw: false };
    case 'free_1':
      return { access: free(1, 0), raw: false };
    case 'free_0':
      return { access: free(2, 0), raw: false };
    case 'reserved_1':
      return { access: free(1, 1), raw: false };
    case 'premium':
      return {
        access: {
          premium: true,
          entitlements: ['premium'],
          freeRatings: {
            limit: 2,
            used: 2,
            reserved: 0,
            remaining: 0,
            availableToReserve: 0,
          },
          canStartRating: true,
          paywallRequired: false,
        },
        raw: false,
      };
    case 'hostile_negative':
      return { access: hostile(-3), raw: true };
    case 'hostile_huge':
      return { access: hostile(Number.MAX_SAFE_INTEGER), raw: true };
    case 'hostile_nan':
      return { access: hostile(Number.NaN), raw: true };
  }
}

function makeNotifications(
  rng: SeededRng,
  caseName: NotificationCase,
): {
  prefs: NotificationPrefs;
  permission: SettingsFixture['notificationPermission'];
} {
  const stored = (patch: Partial<NotificationPrefs>): NotificationPrefs =>
    parseNotificationPrefs(
      JSON.stringify({ ...DEFAULT_NOTIFICATION_PREFS, ...patch }),
    );
  const raw = (minutes: number): NotificationPrefs => ({
    ...DEFAULT_NOTIFICATION_PREFS,
    enabled: true,
    practiceReminder: true,
    practiceReminderMinutes: minutes,
  });
  switch (caseName) {
    case 'off':
      return { prefs: stored({ enabled: false }), permission: 'granted' };
    case 'denied':
      return { prefs: stored({ enabled: true }), permission: 'denied' };
    case 'on_no_reminder':
      return {
        prefs: stored({ enabled: true, practiceReminder: false }),
        permission: 'granted',
      };
    case 'reminder_midnight':
      return {
        prefs: stored({ enabled: true, practiceReminderMinutes: 0 }),
        permission: 'granted',
      };
    case 'reminder_last_minute':
      return {
        prefs: stored({ enabled: true, practiceReminderMinutes: 1439 }),
        permission: 'granted',
      };
    case 'reminder_default':
      return { prefs: stored({ enabled: true }), permission: 'undetermined' };
    case 'reminder_random':
      return {
        prefs: stored({
          enabled: true,
          practiceReminderMinutes: rng.int(0, 1439),
        }),
        permission: 'granted',
      };
    case 'hostile_negative':
      return { prefs: raw(-90), permission: 'granted' };
    case 'hostile_over_day':
      return { prefs: raw(1440 + 30), permission: 'granted' };
    case 'hostile_huge':
      return { prefs: raw(Number.MAX_SAFE_INTEGER), permission: 'granted' };
    case 'hostile_nan':
      return { prefs: raw(Number.NaN), permission: 'granted' };
  }
}

function makeConsistency(
  rng: SeededRng,
  caseName: ConsistencyCase,
  timeZone: TimeZone,
  asOfIso: string,
): ConsistencySnapshot | null {
  const activities: TrainingActivityInput[] = [];
  const asOfMs = Date.parse(asOfIso);
  const dayMs = 86_400_000;
  const push = (daysAgo: number, kind: TrainingActivityInput['kind']) => {
    activities.push({
      kind,
      atIso: new Date(
        asOfMs - daysAgo * dayMs - rng.int(0, 3_600_000),
      ).toISOString(),
      shotType: kind === 'drill' ? undefined : 'dink',
      overallScore: kind === 'drill' ? undefined : rng.int(0, 10),
      resultKind: kind === 'drill' ? undefined : 'scored',
      label: kind === 'drill' ? 'Kitchen-line dinks' : undefined,
    });
  };
  switch (caseName) {
    case 'none':
      return null;
    case 'engine_empty':
      return buildConsistencySnapshot([], { asOfIso, timeZone });
    case 'engine_dst_streak':
      for (let d = 0; d < 5; d += 1)
        push(d, rng.pick(['stroke', 'session_stroke', 'drill']));
      return buildConsistencySnapshot(activities, { asOfIso, timeZone });
    case 'engine_long_streak':
      for (let d = 0; d < 400; d += 1) push(d, 'stroke');
      return buildConsistencySnapshot(activities, { asOfIso, timeZone });
    case 'hostile_negative': {
      const base = buildConsistencySnapshot([], { asOfIso, timeZone });
      return { ...base, currentStreak: -1, earned: [] };
    }
    case 'hostile_huge': {
      const base = buildConsistencySnapshot([], { asOfIso, timeZone });
      const earned = base.earned.slice();
      for (let i = 0; i < 1000; i += 1) {
        earned.push({ id: `stress-${i}`, earnedOnDay: base.asOfDay });
      }
      return { ...base, currentStreak: 1_000_000_000, earned };
    }
  }
}

export function buildFixture(variant: SettingsVariant): SettingsFixture {
  const rng = new SeededRng(variant.seed ^ 0x5f3759df);
  const kind = variant.session.kind;
  const session: AuthSession | null =
    kind === 'signed_out'
      ? null
      : kind === 'guest'
        ? {
            provider: 'guest',
            subject: 'local-only',
            canonicalAppUserId: null,
            localOnly: true,
            displayName: null,
            email: null,
          }
        : {
            provider: kind === 'apple_synced' ? 'apple' : 'google',
            subject: `subject-${variant.seed}`,
            canonicalAppUserId: `00000000-0000-4000-8000-${String(variant.seed).padStart(12, '0')}`,
            localOnly: false,
            displayName: textOrNull(rng, variant.session.displayNameClass),
            email: (() => {
              const cls = variant.session.emailClass;
              if (cls === 'null') return null;
              const local =
                cls === 'latin_short'
                  ? `player${variant.seed}`
                  : textFor(rng, cls);
              return `${local}@example.test`;
            })(),
          };
  const firstName = textOrNull(rng, variant.profile.firstNameClass);
  const profile: Profile | null = variant.profile.present
    ? {
        ...(firstName === null ? {} : { firstName }),
        ...(variant.profile.genderCase === 'set'
          ? {
              gender: rng.pick([
                'female',
                'male',
                'nonbinary',
                'prefer_not_to_say',
              ] as const),
            }
          : {}),
        skillLevel:
          variant.profile.skillLevelClass === 'canonical'
            ? rng.pick(['beginner', 'intermediate', 'advanced'])
            : variant.profile.skillLevelClass === 'long'
              ? 'advanced tournament player with two decades of competitive doubles experience'
              : '',
        handedness: rng.pick(['right', 'left', 'ambidextrous'] as const),
        goal: 'dinks',
        biggestProblem: 'consistency',
        focusCheckpoint:
          variant.profile.focusCase === 'canonical'
            ? rng.pick([
                'contact_position',
                'preparation',
                'paddle_set',
              ] as const)
            : ('follow_through_extension_and_recovery_to_ready_position_after_contact' as Profile['focusCheckpoint']),
      }
    : null;
  const access = makeAccess(variant.access);
  const notifications = makeNotifications(rng, variant.notifications);
  return {
    variant,
    session,
    profile,
    access: access.access,
    accessInjectedRaw: access.raw,
    notificationPrefs: notifications.prefs,
    notificationPermission: notifications.permission,
    consistency: makeConsistency(
      rng,
      variant.consistency,
      variant.timeZone,
      variant.asOfIso,
    ),
    consentStatusActive:
      variant.consent === 'ready_on'
        ? true
        : variant.consent === 'ready_off'
          ? false
          : null,
    legalPrivacyUrl:
      variant.legal === 'none' ? null : 'https://api.example.test/privacy',
    legalTermsUrl:
      variant.legal === 'both' ? 'https://api.example.test/terms' : null,
    appVersion:
      variant.appVersionClass === 'canonical'
        ? '1.0.0 (1)'
        : '1.0.0-rc.1+build.2026.09.04.stress-harness-long-version-identifier (123456789)',
  };
}

/** Deterministic grid the suite always runs: 3 font scales × 3 widths × {guest, synced}. */
export function gridVariants(): SettingsVariant[] {
  const out: SettingsVariant[] = [];
  let index = 0;
  for (const fontScale of FONT_SCALES) {
    for (const width of WIDTHS) {
      for (const kind of ['guest', 'google_synced'] as const) {
        const base = buildVariant(1_000_000 + index);
        index += 1;
        out.push({
          ...base,
          fontScale,
          width,
          locale: 'en-IN',
          rtl: false,
          session: {
            kind,
            displayNameClass: kind === 'guest' ? 'null' : 'latin_short',
            emailClass: 'latin_short',
          },
          profile: {
            present: true,
            firstNameClass: 'latin_short',
            genderCase: 'set',
            skillLevelClass: 'canonical',
            focusCase: 'canonical',
          },
          access: kind === 'guest' ? 'none' : 'free_0',
          notifications: 'denied',
          consistency: 'engine_dst_streak',
          consent: kind === 'guest' ? 'signed_out' : 'ready_on',
          legal: 'both',
          appVersionClass: 'canonical',
        });
      }
    }
  }
  return out;
}
