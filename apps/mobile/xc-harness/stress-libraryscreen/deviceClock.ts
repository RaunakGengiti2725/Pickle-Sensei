/**
 * Simulated device locale + time zone for Jest.
 *
 * Jest sandboxes `process.env`, so assigning `TZ` inside a test never reaches
 * V8's date cache: `Date#getDate()` and the `toLocale*` family keep using the
 * worker's real zone. To exercise the screen under many zones inside ONE
 * campaign, this shim recomputes the local-time getters through
 * `Intl.DateTimeFormat` in the variant's zone and makes the `toLocale*`
 * methods default to the variant's locale and zone when the caller passes
 * none (the screen calls them with `undefined`, i.e. "device defaults").
 *
 * Results are labelled as simulated: they prove the screen composes the
 * local values the platform would hand it, not that iOS itself hands them.
 */

type LocalParts = {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
  second: number;
};

const proto = Date.prototype;
const originals = {
  getFullYear: proto.getFullYear,
  getMonth: proto.getMonth,
  getDate: proto.getDate,
  getDay: proto.getDay,
  getHours: proto.getHours,
  getMinutes: proto.getMinutes,
  getSeconds: proto.getSeconds,
  getTimezoneOffset: proto.getTimezoneOffset,
  toLocaleDateString: proto.toLocaleDateString,
  toLocaleTimeString: proto.toLocaleTimeString,
  toLocaleString: proto.toLocaleString,
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function partsIn(timeZone: string): (date: Date) => LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  return date => {
    const out: LocalParts = {
      year: 0,
      month: 0,
      day: 0,
      weekday: 0,
      hour: 0,
      minute: 0,
      second: 0,
    };
    for (const part of fmt.formatToParts(date)) {
      switch (part.type) {
        case 'year':
          out.year = Number(part.value);
          break;
        case 'month':
          out.month = Number(part.value) - 1;
          break;
        case 'day':
          out.day = Number(part.value);
          break;
        case 'weekday':
          out.weekday = WEEKDAYS.indexOf(part.value);
          break;
        case 'hour':
          out.hour = Number(part.value) % 24;
          break;
        case 'minute':
          out.minute = Number(part.value);
          break;
        case 'second':
          out.second = Number(part.value);
          break;
        default:
          break;
      }
    }
    return out;
  };
}

export interface DeviceClock {
  locale: string;
  timeZone: string;
}

let active: DeviceClock | null = null;

export function activeDeviceClock(): DeviceClock | null {
  return active;
}

export function installDeviceClock(clock: DeviceClock): void {
  const { locale, timeZone } = clock;
  const parts = partsIn(timeZone);
  const local = <K extends keyof LocalParts>(key: K) =>
    function (this: Date): number {
      const ms = this.getTime();
      if (Number.isNaN(ms)) return NaN;
      return parts(this)[key];
    };
  proto.getFullYear = local('year');
  proto.getMonth = local('month');
  proto.getDate = local('day');
  proto.getDay = local('weekday');
  proto.getHours = local('hour');
  proto.getMinutes = local('minute');
  proto.getSeconds = local('second');
  proto.getTimezoneOffset = function (this: Date): number {
    const ms = this.getTime();
    if (Number.isNaN(ms)) return NaN;
    const p = parts(this);
    const asUtc = Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second);
    return Math.round((ms - (ms % 1000) - asUtc) / 60_000);
  };
  const withDefaults = (
    original: (
      this: Date,
      locales?: string | string[],
      options?: Intl.DateTimeFormatOptions,
    ) => string,
  ) =>
    function (
      this: Date,
      locales?: string | string[],
      options?: Intl.DateTimeFormatOptions,
    ): string {
      return original.call(this, locales ?? locale, {
        timeZone,
        ...(options ?? {}),
      });
    };
  proto.toLocaleDateString = withDefaults(originals.toLocaleDateString);
  proto.toLocaleTimeString = withDefaults(originals.toLocaleTimeString);
  proto.toLocaleString = withDefaults(originals.toLocaleString);
  active = clock;
}

export function restoreDeviceClock(): void {
  proto.getFullYear = originals.getFullYear;
  proto.getMonth = originals.getMonth;
  proto.getDate = originals.getDate;
  proto.getDay = originals.getDay;
  proto.getHours = originals.getHours;
  proto.getMinutes = originals.getMinutes;
  proto.getSeconds = originals.getSeconds;
  proto.getTimezoneOffset = originals.getTimezoneOffset;
  proto.toLocaleDateString = originals.toLocaleDateString;
  proto.toLocaleTimeString = originals.toLocaleTimeString;
  proto.toLocaleString = originals.toLocaleString;
  active = null;
}
