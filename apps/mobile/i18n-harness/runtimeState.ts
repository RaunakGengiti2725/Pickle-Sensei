import type { RuntimeState } from './matrix';

/**
 * Runtime-state shims. A JS engine's DEFAULT locale cannot be changed after
 * start-up, so to replay "the device is set to de-DE" inside one process we
 * substitute that locale wherever production code passes `undefined` (or
 * nothing) as the locale argument. Every explicit locale (e.g. the app's
 * `en-US-u-ca-gregory-nu-latn` day-key formatter) is left untouched — that
 * is exactly what a real default-locale change does.
 *
 * The `hermes-ios-en-region` state additionally removes
 * `Intl.NumberFormat.prototype.formatToParts` (absent on Hermes iOS) and
 * records any use of options Hermes iOS documents as unsupported, so a site
 * that depends on them shows up as a divergence instead of silently passing.
 *
 * `env` applies no shims: the process' real default locale/zone are the
 * truth, which the orchestrator uses to cross-check the shimmed runs.
 */

export interface ShimEvent {
  api: string;
  detail: string;
}

interface Installed {
  events: ShimEvent[];
  restore: () => void;
}

const HERMES_IOS_UNSUPPORTED_NUMBER_OPTIONS = [
  'compactDisplay',
  'signDisplay',
] as const;
const HERMES_IOS_UNSUPPORTED_NOTATIONS = ['compact', 'engineering'] as const;
const HERMES_IOS_UNSUPPORTED_DATE_OPTIONS = [
  'numberingSystem',
  'formatMatcher',
] as const;

type LocalesArg = string | string[] | undefined;

function withDefault(locales: LocalesArg, fallback: string): LocalesArg {
  if (locales === undefined || locales === null) return fallback;
  if (Array.isArray(locales) && locales.length === 0) return fallback;
  return locales;
}

function recordUnsupported(
  state: RuntimeState,
  events: ShimEvent[],
  api: string,
  options: object | undefined,
): void {
  if (state !== 'hermes-ios-en-region' || !options) return;
  const record = options as Record<string, unknown>;
  if (api === 'Intl.NumberFormat') {
    for (const key of HERMES_IOS_UNSUPPORTED_NUMBER_OPTIONS) {
      if (record[key] !== undefined) {
        events.push({
          api,
          detail: `option ${key} is unsupported on Hermes iOS`,
        });
      }
    }
    const notation = record['notation'];
    if (
      typeof notation === 'string' &&
      (HERMES_IOS_UNSUPPORTED_NOTATIONS as readonly string[]).includes(notation)
    ) {
      events.push({
        api,
        detail: `notation "${notation}" is unsupported on Hermes iOS`,
      });
    }
  }
  if (api === 'Intl.DateTimeFormat') {
    for (const key of HERMES_IOS_UNSUPPORTED_DATE_OPTIONS) {
      if (record[key] !== undefined) {
        events.push({
          api,
          detail: `option ${key} is unsupported on Hermes iOS`,
        });
      }
    }
  }
}

function wrapConstructor<
  C extends
    | typeof Intl.DateTimeFormat
    | typeof Intl.NumberFormat
    | typeof Intl.Collator,
>(
  original: C,
  api: string,
  defaultLocale: string,
  state: RuntimeState,
  events: ShimEvent[],
): C {
  const Wrapped = function (
    this: unknown,
    locales?: LocalesArg,
    options?: object,
  ) {
    recordUnsupported(state, events, api, options);
    const resolved = withDefault(locales, defaultLocale);
    return new (
      original as unknown as new (l?: LocalesArg, o?: object) => object
    )(resolved, options);
  } as unknown as C;
  Object.defineProperty(Wrapped, 'prototype', {
    value: original.prototype,
    writable: false,
  });
  Object.defineProperty(Wrapped, 'supportedLocalesOf', {
    value: original.supportedLocalesOf.bind(original),
  });
  Object.defineProperty(Wrapped, 'name', { value: original.name });
  return Wrapped;
}

export function installRuntimeState(
  state: RuntimeState,
  defaultLocale: string,
): Installed {
  const events: ShimEvent[] = [];
  if (state === 'env') {
    return { events, restore: () => undefined };
  }

  const originals = {
    DateTimeFormat: Intl.DateTimeFormat,
    NumberFormat: Intl.NumberFormat,
    Collator: Intl.Collator,
    toLocaleDateString: Date.prototype.toLocaleDateString,
    toLocaleTimeString: Date.prototype.toLocaleTimeString,
    toLocaleString: Date.prototype.toLocaleString,
    numberToLocaleString: Number.prototype.toLocaleString,
    localeCompare: String.prototype.localeCompare,
    toLocaleUpperCase: String.prototype.toLocaleUpperCase,
    toLocaleLowerCase: String.prototype.toLocaleLowerCase,
    numberFormatToParts: Intl.NumberFormat.prototype.formatToParts,
  };

  Intl.DateTimeFormat = wrapConstructor(
    originals.DateTimeFormat,
    'Intl.DateTimeFormat',
    defaultLocale,
    state,
    events,
  );
  Intl.NumberFormat = wrapConstructor(
    originals.NumberFormat,
    'Intl.NumberFormat',
    defaultLocale,
    state,
    events,
  );
  Intl.Collator = wrapConstructor(
    originals.Collator,
    'Intl.Collator',
    defaultLocale,
    state,
    events,
  );

  Date.prototype.toLocaleDateString = function (
    this: Date,
    locales?: LocalesArg,
    options?: Intl.DateTimeFormatOptions,
  ) {
    recordUnsupported(state, events, 'Intl.DateTimeFormat', options);
    return originals.toLocaleDateString.call(
      this,
      withDefault(locales, defaultLocale),
      options,
    );
  };
  Date.prototype.toLocaleTimeString = function (
    this: Date,
    locales?: LocalesArg,
    options?: Intl.DateTimeFormatOptions,
  ) {
    recordUnsupported(state, events, 'Intl.DateTimeFormat', options);
    return originals.toLocaleTimeString.call(
      this,
      withDefault(locales, defaultLocale),
      options,
    );
  };
  Date.prototype.toLocaleString = function (
    this: Date,
    locales?: LocalesArg,
    options?: Intl.DateTimeFormatOptions,
  ) {
    recordUnsupported(state, events, 'Intl.DateTimeFormat', options);
    return originals.toLocaleString.call(
      this,
      withDefault(locales, defaultLocale),
      options,
    );
  };
  Number.prototype.toLocaleString = function (
    this: number,
    locales?: LocalesArg,
    options?: Intl.NumberFormatOptions,
  ) {
    recordUnsupported(state, events, 'Intl.NumberFormat', options);
    return originals.numberToLocaleString.call(
      this,
      withDefault(locales, defaultLocale),
      options,
    );
  };
  String.prototype.localeCompare = function (
    this: string,
    that: string,
    locales?: LocalesArg,
    options?: Intl.CollatorOptions,
  ) {
    return originals.localeCompare.call(
      this,
      that,
      withDefault(locales, defaultLocale),
      options,
    );
  };
  String.prototype.toLocaleUpperCase = function (
    this: string,
    locales?: LocalesArg,
  ) {
    return originals.toLocaleUpperCase.call(
      this,
      withDefault(locales, defaultLocale),
    );
  };
  String.prototype.toLocaleLowerCase = function (
    this: string,
    locales?: LocalesArg,
  ) {
    return originals.toLocaleLowerCase.call(
      this,
      withDefault(locales, defaultLocale),
    );
  };

  if (state === 'hermes-ios-en-region') {
    // hermes/lib/VM/JSLib/Intl.cpp defines NumberFormat.prototype.formatToParts
    // under `#ifndef __APPLE__` — it does not exist on iOS.
    delete (Intl.NumberFormat.prototype as { formatToParts?: unknown })
      .formatToParts;
  }

  return {
    events,
    restore: () => {
      Intl.DateTimeFormat = originals.DateTimeFormat;
      Intl.NumberFormat = originals.NumberFormat;
      Intl.Collator = originals.Collator;
      Date.prototype.toLocaleDateString = originals.toLocaleDateString;
      Date.prototype.toLocaleTimeString = originals.toLocaleTimeString;
      Date.prototype.toLocaleString = originals.toLocaleString;
      Number.prototype.toLocaleString = originals.numberToLocaleString;
      String.prototype.localeCompare = originals.localeCompare;
      String.prototype.toLocaleUpperCase = originals.toLocaleUpperCase;
      String.prototype.toLocaleLowerCase = originals.toLocaleLowerCase;
      Intl.NumberFormat.prototype.formatToParts = originals.numberFormatToParts;
    },
  };
}

/** Run `fn` under a runtime state and always restore the globals. */
export function withRuntimeState<T>(
  state: RuntimeState,
  defaultLocale: string,
  fn: (events: ShimEvent[]) => T,
): T {
  const installed = installRuntimeState(state, defaultLocale);
  try {
    return fn(installed.events);
  } finally {
    installed.restore();
  }
}
