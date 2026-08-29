/**
 * Pickle Sensei design tokens.
 *
 * The palette is intentionally equipment-adjacent: court green, graphite,
 * warm chalk and one optic ball accent. Semantic aliases keep screens free of
 * ad-hoc color decisions.
 */

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

export const font = {
  regular: 'Manrope_400Regular',
  medium: 'Manrope_500Medium',
  semibold: 'Manrope_600SemiBold',
  bold: 'Manrope_700Bold',
} as const;

export const type = {
  hero: {
    fontFamily: font.semibold,
    fontSize: 48,
    lineHeight: 50,
    fontWeight: 'normal' as const,
    letterSpacing: -2.2,
  },
  display: {
    fontFamily: font.semibold,
    fontSize: 64,
    lineHeight: 68,
    fontWeight: 'normal' as const,
    letterSpacing: -2.5,
    fontVariant: ['tabular-nums'] as const,
  },
  score: {
    fontFamily: font.semibold,
    fontSize: 44,
    lineHeight: 48,
    fontWeight: 'normal' as const,
    letterSpacing: -1.5,
    fontVariant: ['tabular-nums'] as const,
  },
  h1: {
    fontFamily: font.semibold,
    fontSize: 32,
    lineHeight: 36,
    fontWeight: 'normal' as const,
    letterSpacing: -1,
  },
  h2: {
    fontFamily: font.semibold,
    fontSize: 21,
    lineHeight: 27,
    fontWeight: 'normal' as const,
    letterSpacing: -0.35,
  },
  h3: {
    fontFamily: font.semibold,
    fontSize: 17,
    lineHeight: 22,
    fontWeight: 'normal' as const,
    letterSpacing: -0.15,
  },
  body: {
    fontFamily: font.regular,
    fontSize: 16,
    lineHeight: 23,
    fontWeight: 'normal' as const,
  },
  bodyBold: {
    fontFamily: font.semibold,
    fontSize: 16,
    lineHeight: 22,
    fontWeight: 'normal' as const,
  },
  caption: {
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: 'normal' as const,
  },
  micro: {
    fontFamily: font.semibold,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: 'normal' as const,
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
