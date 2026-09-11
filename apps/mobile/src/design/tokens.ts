/**
 * Pickle Sensei design tokens.
 *
 * The palette is intentionally equipment-adjacent: court green, graphite,
 * warm chalk and one optic ball accent. Semantic aliases keep screens free of
 * ad-hoc color decisions.
 */

import { Platform } from 'react-native';

export const color = {
  ink: '#071710',
  inkElevated: '#10271E',
  inkSoft: '#627168',
  graphite: '#1A2D25',
  surface: '#F7F6F0',
  surfaceElevated: '#FFFFFF',
  surfaceAlt: '#EBEFE8',
  surfaceDark: '#06130E',
  line: '#DCE3DC',
  lineDark: '#21382E',
  lineStrongDark: '#4A5550',
  lineMutedDark: '#31433B',
  court: '#087956',
  courtDeep: '#07563E',
  courtSoft: '#D8EEE4',
  volt: '#D7FA45',
  voltSoft: '#EFFBC4',
  mint: '#53D99B',
  flame: '#FF9B42',
  good: '#137A50',
  goodSoft: '#DCEFE4',
  warn: '#A86416',
  warnSoft: '#F6E8CE',
  bad: '#A63D36',
  badSoft: '#F4DEDB',
  paywall: '#07563E',
  onDark: '#F8FAF5',
  onDarkMuted: '#A5B1AA',
  onDarkSubtle: '#93A39B',
  onDarkFaint: '#819087',
  onDarkDisabled: '#66736D',
  onVolt: '#142014',
  shadow: '#08120E',
  cameraSurface: '#071A13',
  tabBar: '#FFFFFF',
  overlayStrong: 'rgba(4,10,8,0.68)',
  overlayDeep: 'rgba(7,17,14,0.9)',
  overlayDark: 'rgba(7,17,14,0.84)',
  overlayDarkSoft: 'rgba(7,17,14,0.82)',
  inkTint: 'rgba(11,23,19,0.09)',
  onDarkTint: 'rgba(255,255,255,0.1)',
  onDarkTintFaint: 'rgba(255,255,255,0.06)',
  voltTint: 'rgba(215,250,69,0.12)',
  mintTint: 'rgba(83,217,155,0.12)',
  flameTint: 'rgba(255,155,66,0.12)',
} as const;

/**
 * Rank insignia materials — one flat four-tone palette per tier (shadow
 * facet → body → lit facet → brightest edge), so the badges read as copper,
 * steel, gold, ice and sapphire without a single gradient. `accent` is the
 * tone the surrounding UI borrows (ladder fills, pills); every tier's
 * `accent` keeps ≥ 4.5:1 against `color.surfaceDark`.
 */
export const rankTier = {
  bronze: {
    deep: '#6B3A1A',
    base: '#B0683A',
    light: '#DC9962',
    bright: '#F7CFA3',
    accent: '#DC9962',
    tint: 'rgba(220,153,98,0.14)',
  },
  silver: {
    deep: '#5A686F',
    base: '#97A5AC',
    light: '#C6D2D7',
    bright: '#F0F5F7',
    accent: '#C6D2D7',
    tint: 'rgba(198,210,215,0.14)',
  },
  gold: {
    deep: '#8A5B08',
    base: '#D6A21F',
    light: '#F4C84C',
    bright: '#FFEBA8',
    accent: '#F4C84C',
    tint: 'rgba(244,200,76,0.14)',
  },
  platinum: {
    deep: '#1C6874',
    base: '#3CA5B3',
    light: '#7DD5DF',
    bright: '#CBF4F8',
    accent: '#7DD5DF',
    tint: 'rgba(125,213,223,0.14)',
  },
  diamond: {
    deep: '#39379B',
    base: '#5E65E2',
    light: '#9AA8FF',
    bright: '#DCE1FF',
    accent: '#9AA8FF',
    tint: 'rgba(154,168,255,0.14)',
  },
} as const;

/**
 * Achievement badge materials — one flat four-tone palette per RARITY
 * (shadow facet → body → lit facet → brightest edge), the same grammar as
 * `rankTier` so the consistency badges and the rank insignia read as one
 * family without a gradient anywhere. The ladder climbs from chalk through
 * the court's own greens to the house volt, then violet, the streak's flame
 * and a mythic ember: common → uncommon → rare → epic → legendary → mythic.
 * `accent` is what the surrounding UI borrows on dark surfaces (≥ 4.5:1
 * against `color.surfaceDark`); `deep` is the text tone on light surfaces
 * (≥ 4.5:1 against `color.surface`). `plaque` is the engraved band the
 * numeral sits on — ink for every rarity, so the digits always read.
 */
export const achievementRarity = {
  common: {
    deep: '#6A665A',
    base: '#A39E8F',
    light: '#D2CEC1',
    bright: '#F3F0E6',
    accent: '#D2CEC1',
    tint: 'rgba(210,206,193,0.14)',
  },
  uncommon: {
    deep: '#0B4A35',
    base: '#0F7A56',
    light: '#3FB88A',
    bright: '#A6EBCB',
    accent: '#3FB88A',
    tint: 'rgba(63,184,138,0.14)',
  },
  rare: {
    deep: '#5A6A0C',
    base: '#A8C51C',
    light: '#D7FA45',
    bright: '#F1FFB0',
    accent: '#D7FA45',
    tint: 'rgba(215,250,69,0.14)',
  },
  epic: {
    deep: '#4A2C8F',
    base: '#6E48CF',
    light: '#9C7DF2',
    bright: '#D9CCFF',
    accent: '#B39CFF',
    tint: 'rgba(179,156,255,0.14)',
  },
  legendary: {
    deep: '#8A3E0B',
    base: '#D66A1F',
    light: '#FF9B42',
    bright: '#FFD1A8',
    accent: '#FF9B42',
    tint: 'rgba(255,155,66,0.14)',
  },
  mythic: {
    deep: '#7A1F3D',
    base: '#C2325F',
    light: '#FF6B9A',
    bright: '#FFC1D6',
    accent: '#FF8FB3',
    tint: 'rgba(255,143,179,0.14)',
  },
} as const;

/**
 * Membership plan materials (the paywall's pricing page, on the app's chalk
 * surface). The recommended plan is the one ink card on the page and its
 * siblings are white — the dark "Pro" tile beside the standard models — so
 * the recommendation is carried by the fill itself, not by chips or badges.
 * Flat fills only; volt appears exactly twice: the recommended plan's badge
 * and its amount while selected. Text on these fills keeps ≥ 4.5:1
 * (`color.ink`/`color.inkSoft` on `plan`; `color.onDark`/`color.onDarkMuted`
 * and `color.volt` on `hero`).
 */
export const membership = {
  /** Sibling (non-recommended) plan card and its edge; ink-edged when chosen. */
  plan: color.surfaceElevated,
  planLine: color.line,
  planSelectedLine: color.ink,
  /** Recommended plan card; volt-edged when chosen. */
  hero: color.ink,
  heroSelectedLine: color.volt,
} as const;

/** The unearned badge: the same shapes cast in charcoal — visible on
 * purpose (the silhouette of what is not yet earned is the advertisement)
 * but never mistaken for a material. */
export const achievementLocked = {
  deep: '#10271E',
  base: '#1A2D25',
  light: '#31433B',
  bright: '#66736D',
  accent: '#819087',
  tint: 'rgba(255,255,255,0.06)',
} as const;

export const space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
  xxxl: 64,
} as const;

export const radius = {
  xs: 8,
  sm: 12,
  md: 18,
  lg: 26,
  xl: 34,
  pill: 999,
} as const;

export const font = Platform.select({
  ios: {
    regular: 'Manrope-Regular',
    medium: 'Manrope-Medium',
    semibold: 'Manrope-SemiBold',
    bold: 'Manrope-Bold',
  },
  default: {
    regular: 'Manrope_400Regular',
    medium: 'Manrope_500Medium',
    semibold: 'Manrope_600SemiBold',
    bold: 'Manrope_700Bold',
  },
});

const weight = Platform.select({
  ios: { regular: '400', medium: '500', semibold: '600' } as const,
  default: { regular: 'normal', medium: 'normal', semibold: 'normal' } as const,
});

export const type = {
  hero: {
    fontFamily: font.semibold,
    fontSize: 48,
    lineHeight: 50,
    fontWeight: weight.semibold,
    letterSpacing: -2.2,
  },
  display: {
    fontFamily: font.semibold,
    fontSize: 64,
    lineHeight: 66,
    fontWeight: weight.semibold,
    letterSpacing: -2.5,
    fontVariant: ['tabular-nums'] as const,
  },
  score: {
    fontFamily: font.semibold,
    fontSize: 30,
    lineHeight: 34,
    fontWeight: weight.semibold,
    letterSpacing: -1.5,
    fontVariant: ['tabular-nums'] as const,
  },
  h1: {
    fontFamily: font.semibold,
    fontSize: 32,
    lineHeight: 36,
    fontWeight: weight.semibold,
    letterSpacing: -1,
  },
  h2: {
    fontFamily: font.semibold,
    fontSize: 21,
    lineHeight: 27,
    fontWeight: weight.semibold,
    letterSpacing: -0.35,
  },
  h3: {
    fontFamily: font.semibold,
    fontSize: 17,
    lineHeight: 22,
    fontWeight: weight.semibold,
    letterSpacing: -0.15,
  },
  body: {
    fontFamily: font.regular,
    fontSize: 16,
    lineHeight: 23,
    fontWeight: weight.regular,
  },
  bodyBold: {
    fontFamily: font.semibold,
    fontSize: 16,
    lineHeight: 22,
    fontWeight: weight.semibold,
  },
  caption: {
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: weight.medium,
  },
  micro: {
    fontFamily: font.semibold,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: weight.semibold,
    letterSpacing: 0.9,
  },
} as const;

export const shadow = {
  soft: {
    shadowColor: color.shadow,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.07,
    shadowRadius: 24,
    elevation: 3,
  },
  floating: {
    shadowColor: color.shadow,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.14,
    shadowRadius: 26,
    elevation: 6,
  },
} as const;

export function bandColor(
  band: 'green' | 'yellow' | 'red' | 'unscored',
): string {
  switch (band) {
    case 'green':
      return color.good;
    case 'yellow':
      return color.warn;
    case 'red':
      return color.bad;
    case 'unscored':
      return color.inkSoft;
  }
}
