import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { type } from '../src/design/tokens';
import { DuprReadout } from '../src/progress/DuprReadout';
import {
  DUPR_ANCHORS,
  DUPR_CEILING,
  DUPR_ESTIMATE_LABEL,
  DUPR_ESTIMATE_NOTE,
  DUPR_LABEL,
  DUPR_MIN,
  DUPR_SCALE_MAX,
  duprAccessibilityLabel,
  duprDelta,
  duprFraction,
  duprFromScore,
  formatDupr,
  formatDuprDelta,
  formatDuprDistance,
  formatTechniqueScore,
} from '../src/progress/duprEstimate';

/**
 * D-046: the headline rating is an estimated DUPR, always labelled an
 * estimate, with the 0–10 figure kept as the smaller secondary reading. The
 * map is NOT a straight line: DUPR is bunched in the 3s, 5.0+ is the top
 * ~0.7% of rated players and 6.0+ is about 190 people, so the scoring
 * engine's own band boundaries (checkpoints red < 65, yellow 65–79, green
 * ≥ 80) are anchored to DUPR's published bands (Novice < 3, Intermediate
 * 3–4, Advanced 4–5, Professional 5+) and everything between is linear.
 * These tests pin that shape so a display tweak can't silently change the
 * number a player sees.
 */

describe('duprFromScore', () => {
  it('anchors the scoring engine’s band boundaries to DUPR’s skill bands', () => {
    expect(DUPR_MIN).toBe(2);
    expect(DUPR_CEILING).toBe(6);
    expect(DUPR_SCALE_MAX).toBe(8);
    expect(DUPR_ANCHORS).toEqual([
      [0, 2],
      [6.5, 3],
      [8, 4],
      [9.5, 5],
      [10, 6],
    ]);
    // A red-band average (checkpoints < 65) stays in the Novice band.
    expect(duprFromScore(0)).toBe(2);
    expect(duprFromScore(6.5)).toBe(3);
    // The green threshold (checkpoints averaging 80) is the Advanced line.
    expect(duprFromScore(8)).toBe(4);
    // Near-perfect form reaches the Professional line; perfect form on one
    // swing is pro-level mechanics, and the estimate never goes higher.
    expect(duprFromScore(9.5)).toBe(5);
    expect(duprFromScore(10)).toBe(6);
  });

  it('keeps a failing swing in the novice range and the median rated player near 3.3', () => {
    // The owner's example: 5.8/10 is a poor swing, not a 5.48 DUPR.
    expect(duprFromScore(5.8)).toBe(2.89);
    expect(duprFromScore(5)).toBe(2.77);
    expect(duprFromScore(3)).toBe(2.46);
    // 7.0 ≈ the median rated player (~3.3); 7.8 ≈ the median tournament
    // player (~3.8); 9.0 is a strong Advanced player.
    expect(duprFromScore(7)).toBe(3.33);
    expect(duprFromScore(7.8)).toBe(3.87);
    expect(duprFromScore(9)).toBe(4.67);
  });

  it('interpolates linearly inside each segment, two decimals', () => {
    expect(duprFromScore(6.4)).toBe(2.98);
    expect(duprFromScore(7.1)).toBe(3.4);
    expect(duprFromScore(8.5)).toBe(4.33);
    expect(duprFromScore(9.9)).toBe(5.8);
    // The rank rating carries hundredths; the estimate rounds, never truncates.
    expect(duprFromScore(7.62)).toBe(3.75);
    expect(duprFromScore(7.02)).toBe(3.35);
    expect(duprFromScore(3.33)).toBe(2.51);
  });

  it('is convex: each higher segment is worth more DUPR per technique point', () => {
    const slopes = DUPR_ANCHORS.slice(1).map(([score, dupr], index) => {
      const [previousScore, previousDupr] = DUPR_ANCHORS[index]!;
      return (dupr - previousDupr) / (score - previousScore);
    });
    for (let index = 1; index < slopes.length; index += 1) {
      expect(slopes[index]!).toBeGreaterThanOrEqual(slopes[index - 1]!);
    }
    expect(slopes[0]!).toBeLessThan(slopes.at(-1)!);
  });

  it('clamps out-of-range input to the scale ends', () => {
    expect(duprFromScore(-2)).toBe(2);
    expect(duprFromScore(14)).toBe(6);
  });

  it('never turns a non-finite score into a number', () => {
    expect(duprFromScore(NaN)).toBeNaN();
    expect(duprFromScore(Infinity)).toBeNaN();
    expect(duprFromScore(-Infinity)).toBeNaN();
    expect(duprFraction(NaN)).toBe(0);
  });

  it('is monotonic: a higher technique score never shows a lower DUPR', () => {
    let previous = duprFromScore(0);
    for (let tenths = 1; tenths <= 100; tenths += 1) {
      const next = duprFromScore(tenths / 10);
      expect(next).toBeGreaterThanOrEqual(previous);
      previous = next;
    }
  });

  it('places the estimate between the app’s lowest and highest figure for rings and bars', () => {
    expect(duprFraction(0)).toBe(0);
    expect(duprFraction(6.5)).toBeCloseTo(0.25, 10);
    expect(duprFraction(8)).toBeCloseTo(0.5, 10);
    expect(duprFraction(9.5)).toBeCloseTo(0.75, 10);
    expect(duprFraction(10)).toBe(1);
    expect(duprFraction(12)).toBe(1);
    // A failing swing fills under a quarter of the ring — the picture says
    // what the number says.
    expect(duprFraction(5.8)).toBeLessThan(0.25);
  });
});

describe('formatting', () => {
  it('prints the estimate with exactly two decimals', () => {
    expect(formatDupr(6.4)).toBe('2.98');
    expect(formatDupr(10)).toBe('6.00');
    expect(formatDupr(0)).toBe('2.00');
  });

  it('expresses a change as the difference of the two displayed figures, never a rescaled score gap', () => {
    // 6.6 → 7.4 crosses the 6.5 anchor: 3.07 → 3.60.
    expect(duprDelta(6.6, 7.4)).toBe(0.53);
    expect(duprDelta(7.2, 6.9)).toBe(-0.2);
    expect(duprDelta(7.4, 7.4)).toBe(0);
    // The same 0.8-point gain is worth different DUPR at different levels.
    expect(duprDelta(5, 5.8)).toBe(0.12);
    expect(duprDelta(9, 9.8)).toBe(0.93);
    expect(formatDuprDelta(6.6, 7.4)).toBe('+0.53');
    expect(formatDuprDelta(7.2, 6.9)).toBe('\u22120.20');
    expect(formatDuprDelta(7.4, 7.4)).toBe('+0.00');
    // A rounding-to-zero negative shows as +0.00, never "−0.00".
    expect(formatDuprDelta(7.401, 7.4)).toBe('+0.00');
    expect(formatDuprDistance(7.02, 7.5)).toBe('0.32');
    expect(formatDuprDistance(7.5, 7.02)).toBe('0.32');
  });

  it('keeps the 0–10 reading as the secondary line at the caller’s precision', () => {
    expect(formatTechniqueScore(6.4)).toBe('6.4 /10');
    expect(formatTechniqueScore(7.62, 2)).toBe('7.62 /10');
    expect(formatTechniqueScore(10)).toBe('10.0 /10');
  });

  it('reads both figures aloud and says which is which', () => {
    expect(duprAccessibilityLabel(6.4)).toBe(
      'Estimated DUPR 2.98, technique score 6.4 out of 10',
    );
    expect(duprAccessibilityLabel(7.62, 2)).toBe(
      'Estimated DUPR 3.75, technique score 7.62 out of 10',
    );
  });

  it('labels the figure as an estimate and names the limitation', () => {
    expect(DUPR_LABEL).toBe('DUPR');
    expect(DUPR_ESTIMATE_LABEL).toMatch(/EST\./);
    expect(DUPR_ESTIMATE_LABEL).toContain('DUPR');
    expect(DUPR_ESTIMATE_NOTE).toMatch(/^Estimated DUPR/);
    expect(DUPR_ESTIMATE_NOTE).toContain('not from match results');
    expect(DUPR_ESTIMATE_NOTE).toContain('Not an official DUPR rating');
    expect(DUPR_ESTIMATE_NOTE).not.toMatch(/\d/);
  });
});

describe('DuprReadout', () => {
  function render(element: React.ReactElement) {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(element);
    });
    return renderer;
  }

  function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
    return renderer.root
      .findAllByType(Text)
      .map(node => node.props.children)
      .flat(3)
      .filter((child): child is string => typeof child === 'string');
  }

  it('prints the DUPR as the numeral, the unit beside it and the /10 beneath in a smaller role', () => {
    const renderer = render(
      <DuprReadout score={6.4} valueStyle={type.score} dark testID="readout" />,
    );
    try {
      expect(texts(renderer)).toEqual(['2.98', ' DUPR', '6.4 /10']);
      const value = renderer.root.findByProps({ testID: 'readout-dupr' });
      expect(value.props.style).toBe(type.score);
      const unit = value
        .findAllByType(Text)
        .find(node => node.props.children === ' DUPR')!;
      expect(unit.props.style[0]).toBe(type.micro);
      const secondary = renderer.root.findByProps({ testID: 'readout-score' });
      expect(secondary.props.style[0]).toBe(type.micro);
      expect(secondary.props.children).toBe('6.4 /10');
      const host = renderer.root.findAll(
        node =>
          node.props.testID === 'readout' && typeof node.type === 'string',
      )[0]!;
      expect(host.props).toMatchObject({
        accessible: true,
        accessibilityLabel:
          'Estimated DUPR 2.98, technique score 6.4 out of 10',
      });
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('shows the rank rating’s hundredths on the secondary line', () => {
    const renderer = render(
      <DuprReadout score={7.62} scoreDecimals={2} valueStyle={type.score} />,
    );
    try {
      expect(texts(renderer)).toEqual(['3.75', ' DUPR', '7.62 /10']);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('can defer VoiceOver to a labelled host row', () => {
    const renderer = render(
      <DuprReadout
        score={6.4}
        valueStyle={type.score}
        accessible={false}
        testID="readout"
      />,
    );
    try {
      const host = renderer.root.findAll(
        node =>
          node.props.testID === 'readout' && typeof node.type === 'string',
      )[0]!;
      expect(host.props.accessible).toBe(false);
      expect(host.props.accessibilityLabel).toBeUndefined();
    } finally {
      act(() => renderer.unmount());
    }
  });
});
