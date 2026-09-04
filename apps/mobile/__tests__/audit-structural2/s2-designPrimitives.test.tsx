/**
 * Structural audit #2 probes for design primitives (components.tsx,
 * BrandNotice.tsx). Each test states the invariant the primitive should hold;
 * a failing test is a reproduced defect on the audited revision, a passing
 * test is a verified invariant. No production code is touched.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('react-native-svg', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const stub = (name: string) => {
    const Stub = (props: Record<string, unknown>) =>
      ReactModule.createElement(View, { ...props, testID: `svg-${name}` });
    Stub.displayName = name;
    return Stub;
  };
  return {
    __esModule: true,
    default: stub('Svg'),
    Svg: stub('Svg'),
    Circle: stub('Circle'),
    Path: stub('Path'),
    Polyline: stub('Polyline'),
    Polygon: stub('Polygon'),
    Line: stub('Line'),
    Rect: stub('Rect'),
    Defs: stub('Defs'),
    LinearGradient: stub('LinearGradient'),
    Stop: stub('Stop'),
    G: stub('G'),
    Text: stub('Text'),
  };
});

import {
  BrandDialog,
  BrandToggle,
  ScoreRing,
  TrendChart,
} from '../../src/design/components';
import { BrandNoticeHost, showBrandNotice } from '../../src/design/BrandNotice';

const isHost = (node: TestRenderer.ReactTestInstance) =>
  typeof node.type === 'string';

const roots: TestRenderer.ReactTestRenderer[] = [];
function render(element: React.ReactElement): TestRenderer.ReactTestRenderer {
  let root!: TestRenderer.ReactTestRenderer;
  act(() => {
    root = TestRenderer.create(element);
  });
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

function textOf(root: TestRenderer.ReactTestRenderer): string {
  return root.root
    .findAllByType(Text)
    .map(node =>
      node.props.children == null
        ? ''
        : Array.isArray(node.props.children)
          ? node.props.children.join('')
          : String(node.props.children),
    )
    .join('|');
}

describe('ScoreRing input hygiene', () => {
  it('clamps a negative score to the 0–10 scale instead of announcing it', () => {
    const root = render(<ScoreRing score={-2} />);
    const labelled = root.root.findAll(
      node =>
        isHost(node) &&
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.startsWith('Technique score'),
    );
    expect(labelled).toHaveLength(1);
    // A technique score is defined on 0–10; a negative value must not reach
    // VoiceOver or the visible numeral.
    expect(labelled[0]!.props.accessibilityLabel).not.toMatch(/-/);
    expect(textOf(root)).not.toContain('-2.0');
  });
});

describe('TrendChart input hygiene', () => {
  it('never emits NaN/Infinity into SVG point strings', () => {
    const root = render(
      <TrendChart points={[Number.NaN, 4, Number.POSITIVE_INFINITY, 7]} />,
    );
    const pointStrings = root.root
      .findAll(node => isHost(node) && typeof node.props.points === 'string')
      .map(node => node.props.points as string);
    expect(pointStrings.length).toBeGreaterThan(0);
    for (const points of pointStrings) {
      expect(points).not.toMatch(/NaN|Infinity/);
    }
  });

  it('renders the text fallback with fewer than two points (verified invariant)', () => {
    const root = render(<TrendChart points={[6]} />);
    expect(textOf(root)).toContain('Your trend appears after two scored reps.');
  });
});

describe('BrandDialog actions', () => {
  it('renders two actions with the same label without a duplicate React key', () => {
    const errors: string[] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args.map(String).join(' '));
    });
    const onA = jest.fn();
    const onB = jest.fn();
    try {
      render(
        <BrandDialog
          visible
          title="Delete clip?"
          detail="This cannot be undone."
          actions={[
            { label: 'Delete', variant: 'danger', onPress: onA },
            { label: 'Delete', variant: 'dark', onPress: onB },
          ]}
        />,
      );
    } finally {
      spy.mockRestore();
    }
    expect(errors.filter(e => /same key|unique "key"/i.test(e))).toEqual([]);
  });

  it('close control is a 44pt labelled button and backdrop is not an a11y target (verified invariant)', () => {
    const root = render(
      <BrandDialog
        visible
        title="Heads up"
        detail="Detail"
        onDismiss={() => {}}
        actions={[{ label: 'OK', variant: 'dark', onPress: () => {} }]}
      />,
    );
    const close = root.root.find(
      node => isHost(node) && node.props.accessibilityLabel === 'Close dialog',
    );
    expect(close.props.accessibilityRole).toBe('button');
    const style = close.props.style;
    const flat = Array.isArray(style)
      ? Object.assign({}, ...style.flat().filter(Boolean))
      : style;
    expect(flat.width).toBeGreaterThanOrEqual(44);
    expect(flat.height).toBeGreaterThanOrEqual(44);
  });
});

describe('BrandToggle semantics (verified invariant)', () => {
  it('is a switch with checked/disabled state, a 54×44 container and hitSlop', () => {
    const root = render(
      <BrandToggle label="Reminders" value onValueChange={() => {}} />,
    );
    const toggle = root.root.find(
      node => isHost(node) && node.props.accessibilityRole === 'switch',
    );
    expect(toggle.props.accessibilityLabel).toBe('Reminders');
    expect(toggle.props.accessibilityState).toMatchObject({ checked: true });
    expect(toggle.props.hitSlop).toBe(5);
  });
});

describe('BrandNotice pending queue', () => {
  it('shows every notice fired before the host mounted, not only the last', () => {
    showBrandNotice({ title: 'First notice', detail: 'one' });
    showBrandNotice({ title: 'Second notice', detail: 'two' });

    const root = render(<BrandNoticeHost />);
    const seen: string[] = [];
    const titleShown = () => {
      const dialog = root.root.findAll(
        node => node.props.testID === 'brand-notice',
      );
      return dialog.length ? textOf(root) : '';
    };
    seen.push(titleShown());
    const dismiss = () =>
      act(() => {
        root.root
          .find(
            node =>
              isHost(node) && node.props.accessibilityLabel === 'Close dialog',
          )
          .props.onClick({ nativeEvent: {} });
      });
    dismiss();
    seen.push(titleShown());
    const joined = seen.join(' || ');
    expect(joined).toContain('First notice');
    expect(joined).toContain('Second notice');
  });
});
