import { Platform } from 'react-native';
import type { RuntimePublicConfig } from '../config/runtimeConfig';

export interface AccountBootstrapEnvironment {
  locale: string;
  timezone: string;
  device: {
    platform: 'ios' | 'android';
    osVersion: string;
    appVersion: string;
    model: string;
  };
}

function currentLocaleAndTimezone(): { locale: string; timezone: string } {
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  const locale = resolved.locale?.trim();
  const timezone = resolved.timeZone?.trim();
  if (!locale || !timezone) {
    throw new Error(
      'This device did not provide a locale and timezone for account setup.',
    );
  }
  return { locale, timezone };
}

/** Runtime-derived device context; no fixture or guessed handset identifiers. */
export function getAccountBootstrapEnvironment(
  config: RuntimePublicConfig,
): AccountBootstrapEnvironment {
  const localeAndTimezone = currentLocaleAndTimezone();
  if (Platform.OS === 'android') {
    const manufacturer = Platform.constants.Manufacturer?.trim();
    const model = Platform.constants.Model?.trim();
    return {
      ...localeAndTimezone,
      device: {
        platform: 'android',
        osVersion:
          Platform.constants.Release?.trim() || String(Platform.Version),
        appVersion: config.appVersion,
        model: [manufacturer, model].filter(Boolean).join(' '),
      },
    };
  }
  if (Platform.OS === 'ios') {
    return {
      ...localeAndTimezone,
      device: {
        platform: 'ios',
        osVersion: Platform.constants.osVersion,
        appVersion: config.appVersion,
        // React Native does not expose Apple's hardware identifier. These are
        // genuine OS-provided device descriptors, not a guessed iPhone model.
        model: [
          Platform.constants.systemName,
          Platform.constants.interfaceIdiom,
        ]
          .filter(Boolean)
          .join(' '),
      },
    };
  }
  throw new Error(`Unsupported account platform: ${Platform.OS}`);
}
