/**
 * REPRO — finding F1 (P2), found by the boundary/i18n/a11y stress campaign
 * (`__tests__/stress/analysisFeedbackProgressBoundaryI18nA11y.test.tsx`;
 * failing seeds in artifacts/stress/boundary-i18n-a11y.json, the full
 * stage × scale × width table in artifacts/stress/reachable-layout-grid.json).
 *
 * THIS SUITE IS RED ON PURPOSE: it is the minimized reproduction of a
 * production layout defect in `AnalysisProgressBar`'s label row, not a
 * characterization of intended behaviour. It goes green when the row is
 * fixed (e.g. let the sublabel shrink/wrap too, stack it under the label, or
 * drop the hint above a font-scale threshold). Nothing here may be relaxed
 * to make it pass.
 *
 * Defect: `labelRow` is `flexDirection: 'row'` with `label` the ONLY
 * shrinkable child (`styles.label = { flexShrink: 1 }`); the sublabel keeps
 * the default `flexShrink: 0`. Both are `numberOfLines={1}`. Whenever
 * label + 8pt gap + sublabel exceed the row, the stage label — the only text
 * that says WHAT the app is doing — is the one that gets ellipsized:
 *   - default text size (L), 375pt-wide iPhones (row 311pt): "Verifying
 *     capture evidence" + "usually under ~10 seconds" need ≈334pt → label
 *     keeps ≈86% of its width and truncates;
 *   - default text size, 320pt iPhone SE (row 256pt): label keeps ≈52%;
 *   - largest accessibility size (AX5, 3.571×): the sublabel alone is ≈578pt,
 *     wider than every row → the label is squeezed to 0pt on every device.
 *
 * The props are production-reachable, not synthetic: `analysisStageProgress()`
 * pairs every unmeasured stage label with `ANALYSIS_DURATION_HINT`
 * ("usually under ~10 seconds") and `AnalyzeScreen` renders exactly that
 * through `AnalysisProgressBar`.
 *
 * Measurement provenance: advances come from the shipped
 * `assets/fonts/Manrope_500Medium.ttf` (exact, unkerned); the flex arithmetic
 * is MODELLED after Yoga's single-line text measurement. NOT an iOS runtime
 * measurement — Apple-plane confirmation needs a device/simulator run, which
 * this Linux plane cannot make.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  ANALYSIS_DURATION_HINT,
  ANALYSIS_STAGE_LABELS,
  AnalysisProgressBar,
  analysisStageProgress,
} from '../../../src/components/AnalysisProgress';
import {
  CONTAINER_WIDTHS,
  FONT_SCALES,
  measureSingleLine,
  modelLabelRow,
} from '../boundaryI18nA11yHarness';

const CAPTION_PT = 13; // type.caption fontSize
const CAPTION_FONT = 'Manrope_500Medium' as const;
const DEFAULT = FONT_SCALES[0];
const AX5 = FONT_SCALES[2];
const SE_320 = CONTAINER_WIDTHS[0];
const MINI_375 = CONTAINER_WIDTHS[1];
const PRO_MAX_340 = CONTAINER_WIDTHS[2];

function layoutFor(
  stage: 'verifying' | 'measuring' | 'saving',
  scale: number,
  rowWidth: number,
) {
  const ui = analysisStageProgress(stage);
  const label = measureSingleLine(ui.label, CAPTION_FONT, CAPTION_PT, scale);
  const sublabel = measureSingleLine(
    ui.sublabel ?? '',
    CAPTION_FONT,
    CAPTION_PT,
    scale,
  );
  return {
    ui,
    label,
    sublabel,
    layout: modelLabelRow(rowWidth, label.widthPt, sublabel.widthPt),
  };
}

describe('F1 · AnalysisProgressBar label row truncates the stage label', () => {
  it('pairs every unmeasured stage with the duration hint (precondition)', () => {
    for (const stage of ['verifying', 'measuring', 'saving'] as const) {
      const ui = analysisStageProgress(stage);
      expect(ui.label).toBe(ANALYSIS_STAGE_LABELS[stage]);
      expect(ui.sublabel).toBe(ANALYSIS_DURATION_HINT);
    }
  });

  it('shows the whole "Verifying capture evidence" label at the default text size on a 375pt iPhone', () => {
    const { label, sublabel, layout } = layoutFor(
      'verifying',
      DEFAULT.scale,
      MINI_375.width,
    );
    expect({
      device: MINI_375.device,
      scale: DEFAULT.name,
      labelNaturalPt: Math.round(label.widthPt),
      sublabelNaturalPt: Math.round(sublabel.widthPt),
      neededPt: Math.round(label.widthPt + 8 + sublabel.widthPt),
      rowPt: MINI_375.width,
      labelVisiblePct: Math.round(layout.labelVisibleFraction * 100),
    }).toEqual({
      device: MINI_375.device,
      scale: DEFAULT.name,
      labelNaturalPt: Math.round(label.widthPt),
      sublabelNaturalPt: Math.round(sublabel.widthPt),
      neededPt: Math.round(label.widthPt + 8 + sublabel.widthPt),
      rowPt: MINI_375.width,
      labelVisiblePct: 100,
    });
  });

  it('shows the whole stage label at the default text size on a 320pt iPhone SE', () => {
    const clipped = (['verifying', 'measuring', 'saving'] as const)
      .map(stage => ({
        stage,
        ...layoutFor(stage, DEFAULT.scale, SE_320.width),
      }))
      .filter(cell => cell.layout.labelClipped)
      .map(
        cell =>
          `${cell.stage}: ${Math.round(cell.layout.labelVisibleFraction * 100)}% visible`,
      );
    expect(clipped).toEqual([]);
  });

  it('keeps the stage label readable at AX5 on every device width', () => {
    const collapsed: string[] = [];
    for (const stage of ['verifying', 'measuring', 'saving'] as const) {
      for (const container of [SE_320, MINI_375, PRO_MAX_340]) {
        const { layout } = layoutFor(stage, AX5.scale, container.width);
        if (layout.labelCollapsed) {
          collapsed.push(
            `${stage} @ ${container.device}: sublabel ${Math.round(layout.sublabelNatural)}pt > row ${container.width}pt, label 0pt`,
          );
        }
      }
    }
    expect(collapsed).toEqual([]);
  });

  it('renders both strings and a full accessible name (the defect is visual only; holds today)', async () => {
    const ui = analysisStageProgress('measuring');
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AnalysisProgressBar
          progress={null}
          label={ui.label}
          sublabel={ui.sublabel}
        />,
      );
    });
    const root = renderer.root.findByProps({ testID: 'analysis-progress' });
    expect(root.props.accessibilityLabel).toBe(
      `${ui.label}. ${ui.sublabel ?? ''}`,
    );
    const texts = renderer.root
      .findAllByType('Text' as never)
      .map(n => n.children.join(''));
    expect(texts).toEqual([ui.label, ui.sublabel]);
    await act(async () => {
      renderer.unmount();
    });
  });
});
