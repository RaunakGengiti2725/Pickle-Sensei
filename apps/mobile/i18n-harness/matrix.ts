/**
 * i18n / locale-formatting audit matrix — the fixed dimensions every probe
 * run is replayed against. Nothing here touches production code; the probe
 * imports production modules read-only and records what they render.
 *
 * Replay: `node apps/mobile/i18n-harness/run-locale-matrix.mjs` (spawns one
 * jest process per time zone because Node/jest cannot switch TZ at runtime)
 * or a single zone: `TZ=Pacific/Kiritimati npx jest __tests__/i18n`.
 */

import dimensions from './dimensions.json';

/** Any BCP-47 tag plus the device region it implies (the `env` state uses
 * whatever the process really resolved to, which need not be in the 12). */
export interface LocaleUnderTest {
  tag: string;
  region: string;
}

export interface AuditLocale extends LocaleUnderTest {
  /** Representative IANA zone for the region. */
  zone: string;
  /** POSIX `LANG` spelling the orchestrator exports to make it the process
   * default locale. */
  posix: string;
}

/** The 12 locales the audit brief names, with the device region each implies
 * and a representative IANA zone for that region. `es-419` is a region-less
 * Latin-American Spanish tag; a device in that audience reports a concrete
 * region — Mexico is the largest one. Shared with `run-locale-matrix.mjs`
 * through `dimensions.json`. */
export const AUDIT_LOCALES: readonly AuditLocale[] = dimensions.locales;

/** Extra zones that stress the day-boundary and DST arithmetic the app does
 * with `Date` local getters and `T12:00:00Z` anchors: UTC, US DST, the
 * half-hour/quarter-hour offsets (St_Johns -3:30, Kathmandu +5:45, Chatham
 * +12:45), Lord_Howe's 30-minute DST step, Auckland/Fiji +12, Apia +13 and
 * Kiritimati +14 (everywhere from +12 up, 12:00Z is already tomorrow),
 * Pago_Pago -11 and Santiago, whose DST transitions happen at local
 * midnight. */
export const ADVERSARIAL_ZONES: readonly string[] = dimensions.adversarialZones;

export const ALL_ZONES: readonly string[] = [
  ...new Set<string>([
    ...AUDIT_LOCALES.map(locale => locale.zone),
    ...ADVERSARIAL_ZONES,
  ]),
];

/**
 * Intl runtime states React Native 0.87 can put the app in.
 *
 * - `icu-full`: the device locale is the JS default locale and every Intl
 *   API exists (Node/V8, Chrome debugger, Hermes on Android, and the shape a
 *   localized iOS build would see). VERIFIED here on Node full-ICU.
 * - `hermes-ios-en-region`: Hermes on iOS. The bundle declares only the `en`
 *   localization (`knownRegions = (en, Base)`, `CFBundleDevelopmentRegion =
 *   en`), so `NSLocale.currentLocale` — which Hermes uses as the default
 *   locale — is `en_<REGION>` for every user (INFERRED from
 *   hermes/lib/Platform/Intl/PlatformIntlApple.mm getDefaultLocale and
 *   Apple's locale-resolution rules). Hermes iOS also has no
 *   `Intl.NumberFormat.prototype.formatToParts` (Intl.cpp `#ifndef __APPLE__`)
 *   and ignores NumberFormat `notation`/`compactDisplay`/`signDisplay` and
 *   DateTimeFormat `numberingSystem`/`formatMatcher`. The shim emulates the
 *   default-locale substitution and the missing API; real NSDateFormatter
 *   output cannot be produced on Linux and is NOT claimed here.
 * - `env`: no shims at all — the process' real default locale and zone, used
 *   by the orchestrator to cross-check the shimmed runs against ICU truth.
 */
export const RUNTIME_STATES = ['icu-full', 'hermes-ios-en-region'] as const;
export type RuntimeState = (typeof RUNTIME_STATES)[number] | 'env';

export function defaultLocaleForState(
  state: RuntimeState,
  locale: LocaleUnderTest,
): string {
  return state === 'hermes-ios-en-region' ? `en-${locale.region}` : locale.tag;
}

/** Deterministic instants used everywhere so every row is replayable. */
export const FIXED_INSTANTS = {
  /** Friday 2026-09-04 13:05:07Z — a weekday afternoon in Europe, early
   * morning of the 5th in UTC+11 and beyond. */
  asOf: '2026-09-04T13:05:07.000Z',
  /** 23:30Z — past midnight for every zone east of UTC+0:30. */
  lateEvening: '2026-09-04T23:30:00.000Z',
  /** 00:20Z — the previous local day for the whole Americas. */
  justAfterUtcMidnight: '2026-09-05T00:20:00.000Z',
  /** Noon UTC anchor the calendar/achievement screens build from a day key. */
  noonAnchorDay: '2026-09-04',
  /** DST spring-forward (EU) 2026-03-29, fall-back (EU) 2026-10-25,
   * Chile spring-forward 2026-09-06 (at local midnight). */
  dstDays: ['2026-03-29', '2026-10-25', '2026-09-06', '2026-11-01'],
} as const;
