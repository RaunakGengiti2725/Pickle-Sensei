/**
 * stress-cmp-notification-priming — pins the TypeScript geometry model used by
 * the render campaign (`testing/stress/notificationPriming/layout.ts`) against
 * real Yoga (yoga-layout@3, the flexbox engine React Native embeds) for
 * 4 Dynamic Type scales × 3 iPhone widths × 3 primary labels. The fixture is
 * produced by `generateYogaFixture.mjs`; if the model and Yoga ever disagree by
 * more than half a point the campaign's clipping verdicts are not trustworthy.
 */
import yogaFixture from '../../testing/stress/notificationPriming/yogaLayout.fixture.json';
import {
  layoutActionsRow,
  measureText,
  wrapLines,
  type CardChrome,
} from '../../testing/stress/notificationPriming/layout';

interface YogaRow {
  fontScaleName: string;
  screenWidth: number;
  fontScale: number;
  primaryLabel: string;
  failed: boolean;
  copyColumnWidth: number;
  rowContentWidth: number;
  pills: { label: string; width: number; height: number; left: number }[];
  overflowPastCopyColumn: number;
  overflowPastCardBorder: number;
  overflowPastScreen: number;
}

/** The same chrome the fixture generator encodes (HomeScreen + card styles). */
function chrome(screenWidth: number): CardChrome {
  return {
    screenWidth,
    screenPaddingHorizontal: 24,
    iconWidth: 40,
    card: { padding: 16, gap: 16, borderWidth: 1 / 3 },
    actions: { gap: 8 },
    slot: { minWidth: 96 },
    pill: { minHeight: 44, paddingHorizontal: 16, borderWidth: 1 },
    pillLabel: {
      fontFamily: 'Manrope_500Medium',
      fontSize: 13,
      lineHeight: 18,
    },
  };
}

const rows = yogaFixture.rows as YogaRow[];

describe('stress cmp-notification-priming — layout model vs real Yoga', () => {
  it('ships a fixture covering 4 scales × 3 widths × 3 labels', () => {
    expect(rows).toHaveLength(36);
    expect(new Set(rows.map(r => r.fontScale)).size).toBe(4);
    expect(new Set(rows.map(r => r.screenWidth)).size).toBe(3);
    expect(new Set(rows.map(r => r.primaryLabel)).size).toBe(3);
  });

  it.each(
    rows.map(r => [r.fontScaleName, r.screenWidth, r.primaryLabel, r] as const),
  )(
    'matches Yoga within 0.5pt — %s @ %dpt, primary "%s"',
    (_scale, screenWidth, primaryLabel, row) => {
      const layout = layoutActionsRow(
        chrome(screenWidth),
        [primaryLabel, 'Not now'],
        row.fontScale,
      );
      expect(layout.copyColumnWidth).toBeCloseTo(row.copyColumnWidth, 0);
      expect(layout.rowContentWidth).toBeCloseTo(row.rowContentWidth, 0);
      expect(layout.overflowPastCopyColumn).toBeCloseTo(
        row.overflowPastCopyColumn,
        0,
      );
      expect(layout.overflowPastCardBorder).toBeCloseTo(
        row.overflowPastCardBorder,
        0,
      );
      expect(layout.overflowPastScreen).toBeCloseTo(row.overflowPastScreen, 0);
      expect(layout.pills).toHaveLength(2);
      layout.pills.forEach((pill, i) => {
        const yoga = row.pills[i]!;
        expect(pill.label).toBe(yoga.label);
        expect(pill.width).toBeCloseTo(yoga.width, 0);
        expect(pill.height).toBeCloseTo(yoga.height, 0);
        expect(pill.left).toBeCloseTo(yoga.left, 0);
      });
    },
  );

  it('measures with the bundled Manrope advances (kerned whole strings)', () => {
    const caption = {
      fontFamily: 'Manrope_500Medium',
      fontSize: 13,
      lineHeight: 18,
    };
    // 3.53826em × 13pt ("Turn on" in Manrope Medium, kerned).
    expect(measureText('Turn on', caption, 1)).toBeCloseTo(46.0, 0);
    // Unmapped code points fall back to the average Latin advance, so a CJK
    // label is still measured (approximately) rather than as zero width.
    expect(measureText('連続記録', caption, 1)).toBeGreaterThan(0);
    expect(wrapLines('Try again', caption, 1, 30)).toEqual(['Try', 'again']);
    expect(wrapLines('Try again', caption, 1, 500)).toEqual(['Try again']);
  });
});
