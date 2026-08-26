/**
 * Design tokens (directive §46): one source for color/type/spacing.
 * Sunlight-first: very high contrast, oversized numerals, minimal chrome.
 */

export const color = {
  ink: '#0B1220',
  inkSoft: '#42505F',
  surface: '#FFFFFF',
  surfaceAlt: '#F1F5F3',
  line: '#DDE5E1',
  court: '#0E7C5B', // primary — court green
  courtDeep: '#0A5C44',
  volt: '#C8F04B', // energetic accent, used sparingly
  good: '#15803D',
  warn: '#B45309',
  bad: '#B91C1C',
  paywall: '#4338CA',
  onDark: '#FFFFFF',
  fixture: '#7C3AED', // dev-fixture labeling — unmistakable
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radius = {
  sm: 8,
  md: 14,
  lg: 22,
  pill: 999,
} as const;

export const type = {
  display: { fontSize: 64, fontWeight: '800' as const, letterSpacing: -2 },
  score: { fontSize: 44, fontWeight: '800' as const, letterSpacing: -1 },
  h1: { fontSize: 28, fontWeight: '700' as const },
  h2: { fontSize: 20, fontWeight: '700' as const },
  body: { fontSize: 16, fontWeight: '400' as const },
  bodyBold: { fontSize: 16, fontWeight: '600' as const },
  caption: { fontSize: 13, fontWeight: '500' as const },
  micro: { fontSize: 11, fontWeight: '600' as const, letterSpacing: 0.5 },
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
