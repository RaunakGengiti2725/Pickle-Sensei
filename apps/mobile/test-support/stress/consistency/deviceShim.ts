/**
 * Device clock/zone shims for the store campaigns.
 *
 * The store reads the device zone through `Intl.DateTimeFormat()` with no
 * options (`resolvedOptions().timeZone`). Node fixes that at process start
 * (TZ) and ignores later `process.env.TZ` writes, so the campaign swaps the
 * constructor for one that injects the scenario's zone ONLY when the caller
 * did not name one. Explicit-zone formatters (the engine's day bucketing)
 * are untouched, so the snapshot's own arithmetic stays real.
 */
const OriginalDateTimeFormat = Intl.DateTimeFormat;

let deviceZone: string | null = null;

export function setDeviceTimeZone(zone: string | null): void {
  deviceZone = zone;
}

export function currentDeviceTimeZone(): string | null {
  return deviceZone;
}

export function installDeviceTimeZoneShim(): () => void {
  function ShimDateTimeFormat(
    this: unknown,
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions,
  ): Intl.DateTimeFormat {
    const resolved =
      deviceZone !== null && (!options || options.timeZone === undefined)
        ? { ...(options ?? {}), timeZone: deviceZone }
        : options;
    return new OriginalDateTimeFormat(locales, resolved);
  }
  ShimDateTimeFormat.prototype = OriginalDateTimeFormat.prototype;
  ShimDateTimeFormat.supportedLocalesOf =
    OriginalDateTimeFormat.supportedLocalesOf.bind(OriginalDateTimeFormat);
  (Intl as { DateTimeFormat: typeof Intl.DateTimeFormat }).DateTimeFormat =
    ShimDateTimeFormat as unknown as typeof Intl.DateTimeFormat;
  return () => {
    (Intl as { DateTimeFormat: typeof Intl.DateTimeFormat }).DateTimeFormat =
      OriginalDateTimeFormat;
    deviceZone = null;
  };
}

/** YYYY-MM-DD of an instant in a zone — independent of the engine's
 * `formatToParts` path (en-CA renders ISO order natively). Falls back to
 * UTC for zones Intl rejects, mirroring the engine's contract. */
export function dayKeyIn(zone: string, ms: number): string {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new OriginalDateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    formatter = new OriginalDateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  }
  return formatter.format(new Date(ms));
}

export function zoneIsValid(zone: string): boolean {
  try {
    new OriginalDateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Zones chosen to exercise DST (incl. the 30-minute Lord Howe shift and
 * the southern-hemisphere calendar), extreme offsets (+14, +13:45, -12),
 * non-hour offsets, and two zones Intl must reject (→ UTC fallback). */
export const STRESS_ZONES: readonly string[] = [
  'UTC',
  'America/Los_Angeles',
  'America/New_York',
  'America/Denver',
  'America/Phoenix',
  'America/St_Johns',
  'America/Santiago',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Australia/Lord_Howe',
  'Pacific/Auckland',
  'Pacific/Chatham',
  'Pacific/Kiritimati',
  'Pacific/Apia',
  'Etc/GMT+12',
  'Etc/GMT-14',
  'Invalid/Zone',
  '',
];

/** Instants that sit on or beside a DST wall-clock discontinuity in 2026
 * (America: Mar 8 / Nov 1; EU: Mar 29 / Oct 25; Sydney: Apr 5 / Oct 4;
 * Lord Howe follows Sydney; Chile: Apr 5 / Sep 6). All UTC. */
export const DST_EDGE_INSTANTS: readonly string[] = [
  '2026-03-08T09:59:59.000Z',
  '2026-03-08T10:00:00.000Z',
  '2026-03-08T10:30:00.000Z',
  '2026-11-01T08:59:59.000Z',
  '2026-11-01T09:00:00.000Z',
  '2026-11-01T09:30:00.000Z',
  '2026-03-29T00:59:59.000Z',
  '2026-03-29T01:00:00.000Z',
  '2026-10-25T00:59:59.000Z',
  '2026-10-25T01:00:00.000Z',
  '2026-04-04T15:59:59.000Z',
  '2026-04-04T16:00:00.000Z',
  '2026-10-03T15:59:59.000Z',
  '2026-10-03T16:00:00.000Z',
  '2026-04-05T02:59:59.000Z',
  '2026-04-05T03:00:00.000Z',
  '2026-09-06T03:59:59.000Z',
  '2026-09-06T04:00:00.000Z',
  '2026-12-31T23:59:59.000Z',
  '2027-01-01T00:00:00.000Z',
  '2028-02-29T12:00:00.000Z',
];
