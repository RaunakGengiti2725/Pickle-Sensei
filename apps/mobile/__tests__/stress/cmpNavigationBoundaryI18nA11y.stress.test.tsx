/**
 * STRESS — unit `cmp-navigation`, lens `boundary-i18n-a11y`.
 *
 * Renders the real <PremiumTabBar/> across a deterministic grid of
 *   3 widths x 3 iOS font scales x 12 locales x {menu closed, menu open}
 * = 216 variants, with the seeded RNG choosing safe-area insets, timezone,
 * RTL and the focused tab per variant. Every variant is replayable from its
 * seed (see navStressKit.ts).
 *
 * Hard invariants asserted per variant (rendered-tree facts):
 *   - every interactive element carries an accessibilityRole AND a non-empty
 *     accessibilityLabel;
 *   - every interactive element's touch box is >= 44pt (declared in its own
 *     style, or resolved through the bar layout model for the flex children);
 *   - tab accessibility state tracks focus exactly (one selected tab, and only
 *     when the focused route is a real tab);
 *   - the accessible labels and visible copy are byte-identical across all 12
 *     locales, 8 timezones and both writing directions (the surface reads
 *     none of them today, so any drift would be a real regression);
 *   - the coach menu exposes all three actions with role, label and hint.
 *
 * Modelled (NOT measured) per variant, recorded in the results table: the
 * single-line text extents of the tab labels, the COACH caption and the coach
 * action detail lines, and the FAB/caption vertical overlap. React Test
 * Renderer runs no layout engine and Linux is not an Apple device; those rows
 * are labelled `modelled` and the AX3 overflow set is pinned by a
 * characterization test instead of being asserted as a pass.
 */
jest.mock('react-native-reanimated', () => {
  const React = require('react');
  const { View } = require('react-native');
  const AnimatedView = (props: Record<string, unknown>) =>
    React.createElement(View, props);
  return {
    __esModule: true,
    default: {
      View: AnimatedView,
      createAnimatedComponent:
        (Component: React.ComponentType<Record<string, unknown>>) =>
        (props: Record<string, unknown>) =>
          React.createElement(Component, props),
    },
    Easing: { out: (fn: unknown) => fn, cubic: () => 0 },
    interpolate: () => 0,
    useAnimatedStyle: (updater: () => object) => updater(),
    useSharedValue: (init: unknown) => ({ value: init }),
    withTiming: (toValue: unknown) => toValue,
  };
});
jest.mock('react-native-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});

let mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
jest.mock('react-native-safe-area-context', () => ({
  __esModule: true,
  useSafeAreaInsets: () => mockInsets,
}));

let mockReducedMotion = false;
jest.mock('../../src/design/components', () => {
  const actual = jest.requireActual<
    typeof import('../../src/design/components')
  >('../../src/design/components');
  return {
    ...actual,
    __esModule: true,
    useReducedMotion: () => mockReducedMotion,
  };
});

jest.mock('../../src/state/accessStore', () => ({
  __esModule: true,
  useAccessStore: {
    getState: () => ({
      canonicalAccess: { canStartRating: true },
      status: 'ready',
      initialize: async () => undefined,
    }),
  },
}));
jest.mock('../../src/auth/authStore', () => ({
  __esModule: true,
  useAuthStore: {
    getState: () => ({ session: { localOnly: false } }),
  },
}));

import React from 'react';
import { PixelRatio, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { PremiumTabBar } from '../../src/navigation/PremiumTabBar';
import { space, type } from '../../src/design/tokens';
import {
  BASE_SEED,
  FONT_SCALES,
  INSET_CASES,
  LOCALES,
  MIN_TARGET_POINTS,
  STRESS_MULTIPLIER,
  TAB_LABEL_TRANSLATIONS,
  TIMEZONES,
  WIDTHS,
  applyEnvironment,
  auditAccessibility,
  estimateTextWidth,
  flattenStyle,
  interactiveNodes,
  MINIMISING,
  makeRng,
  resetEnvironment,
  resolveBarLayout,
  scaledLineHeight,
  seedIsSelected,
  writeResults,
  type ResultRow,
} from '../../testing/stress/navStressKit';

type Renderer = TestRenderer.ReactTestRenderer;

/** Style constants the component declares; asserted against the rendered tree
 * so the model can never drift away from the implementation silently. */
const BAR_HEIGHT = 70;
const FAB_SIZE = 68;
const FAB_RISE = 24;
const BAR_PADDING_H = 6;
const TAB_MIN_WIDTH = 52;
const CENTER_MIN_WIDTH = 68;
const ACTION_MAX_WIDTH = 380;

const TAB_ROUTES = [
  { key: 'Home-1', name: 'Home' },
  { key: 'Library-1', name: 'Library' },
  { key: 'Add-1', name: 'Add' },
  { key: 'Performance-1', name: 'Performance' },
  { key: 'Settings-1', name: 'Settings' },
] as const;

const EXPECTED_TAB_LABELS = ['Home', 'Library', 'Progress', 'Settings'];
const EXPECTED_ACTIONS = [
  { title: 'Auto Analyze', detail: 'Auto capture · validated scores only' },
  { title: 'Import Video', detail: 'Choose a real clip from this phone' },
  { title: 'Drill Library', detail: 'Guided drills you can search' },
];

function makeProps(index: number): {
  props: BottomTabBarProps;
  emit: jest.Mock;
  navigate: jest.Mock;
  rootNavigate: jest.Mock;
} {
  const emit = jest.fn(() => ({ defaultPrevented: false }));
  const navigate = jest.fn();
  const rootNavigate = jest.fn();
  return {
    emit,
    navigate,
    rootNavigate,
    props: {
      state: { index, routes: TAB_ROUTES.map(route => ({ ...route })) },
      navigation: {
        emit,
        navigate,
        getParent: () => ({ navigate: rootNavigate }),
      },
      descriptors: {},
      insets: mockInsets,
    } as unknown as BottomTabBarProps,
  };
}

function render(element: React.ReactElement): Renderer {
  let renderer!: Renderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function pressByLabel(renderer: Renderer, label: string): void {
  const nodes = renderer.root.findAll(
    node =>
      node.props?.accessibilityLabel === label &&
      typeof node.props?.onPress === 'function',
  );
  if (nodes.length === 0) throw new Error(`No pressable labeled ${label}`);
  act(() => {
    nodes[0]!.props.onPress();
  });
}

function textNodes(renderer: Renderer) {
  return renderer.root.findAllByType(Text).map(node => ({
    value: [node.props.children]
      .flat()
      .filter((child): child is string => typeof child === 'string')
      .join(''),
    numberOfLines: node.props.numberOfLines as number | undefined,
    style: flattenStyle(node.props.style),
  }));
}

type Variant = {
  seed: number;
  index: number;
  width: number;
  fontScale: number;
  locale: string;
  timezone: string;
  rtl: boolean;
  menuOpen: boolean;
  insetsId: string;
  focusedIndex: number;
  reducedMotion: boolean;
};

/** The deterministic grid: 3 widths x 3 font scales x 12 locales x 2 menu
 * states = 216 variants; STRESS_ITER repeats the grid with fresh nuisance
 * parameters per repetition. */
function enumerateVariants(): Variant[] {
  const variants: Variant[] = [];
  let index = 0;
  for (let repeat = 0; repeat < STRESS_MULTIPLIER; repeat += 1) {
    for (const width of WIDTHS) {
      for (const fontScale of FONT_SCALES) {
        for (const locale of LOCALES) {
          for (const menuOpen of [false, true]) {
            const seed = BASE_SEED + index;
            const rng = makeRng(seed);
            variants.push({
              seed,
              index,
              width,
              fontScale,
              locale,
              menuOpen,
              timezone: rng.pick(TIMEZONES),
              rtl: locale === 'ar-EG' ? true : rng.bool(0.25),
              insetsId: rng.pick(INSET_CASES).id,
              focusedIndex: rng.int(TAB_ROUTES.length),
              reducedMotion: rng.bool(0.3),
            });
            index += 1;
          }
        }
      }
    }
  }
  return variants;
}

const rows: ResultRow[] = [];
let artifactPath = '';

describe('cmp-navigation stress — boundary / i18n / a11y', () => {
  const variants = enumerateVariants().filter(variant =>
    seedIsSelected(variant.seed),
  );

  beforeAll(() => {
    expect(variants.length).toBeGreaterThanOrEqual(MINIMISING ? 0 : 150);
  });

  afterAll(() => {
    artifactPath = writeResults('premiumTabBar-boundary-i18n-a11y', {
      campaign: 'PremiumTabBar boundary/i18n/a11y grid',
      baseSeed: BASE_SEED,
      multiplier: STRESS_MULTIPLIER,
      rows,
      summary: {
        variants: rows.length,
        held: rows.filter(row => row.outcome === 'HELD').length,
        modelledOverflow: rows.filter(
          row => row.outcome === 'MODELLED_OVERFLOW',
        ).length,
        broken: rows.filter(row => row.outcome === 'BROKEN').length,
        threw: rows.filter(row => row.outcome === 'THREW').length,
        note: 'text extents and box overlap are MODELLED (no layout engine on this plane); a11y roles/labels/states and declared touch boxes are rendered-tree facts',
      },
    });
    console.log(`[stress] results table: ${artifactPath}`);
    resetEnvironment();
  });

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders the whole variant grid with intact roles, labels and touch targets', () => {
    const fontScaleSpy = jest.spyOn(PixelRatio, 'getFontScale');
    const labelsPerVariant = new Set<string>();
    const copyPerVariant = new Set<string>();

    for (const variant of variants) {
      const applied = applyEnvironment({
        locale: variant.locale,
        timezone: variant.timezone,
        rtl: variant.rtl,
      });
      mockInsets = INSET_CASES.find(
        entry => entry.id === variant.insetsId,
      )!.insets;
      mockReducedMotion = variant.reducedMotion;
      fontScaleSpy.mockReturnValue(variant.fontScale);

      const row: ResultRow = {
        seed: variant.seed,
        outcome: 'HELD',
        width: variant.width,
        fontScale: variant.fontScale,
        locale: variant.locale,
        timezone: variant.timezone,
        rtlRequested: variant.rtl,
        rtlApplied: applied.rtlApplied,
        insets: variant.insetsId,
        focusedIndex: variant.focusedIndex,
        menuOpen: variant.menuOpen,
        reducedMotion: variant.reducedMotion,
      };

      let renderer: Renderer | null = null;
      try {
        const harness = makeProps(variant.focusedIndex);
        renderer = render(<PremiumTabBar {...harness.props} />);
        if (variant.menuOpen) pressByLabel(renderer, 'Open coach actions');

        const nodes = interactiveNodes(renderer.root);
        const audit = auditAccessibility(nodes);
        row.interactiveCount = nodes.length;
        row.a11yViolations = audit.violations;

        const layout = resolveBarLayout({
          screenWidth: variant.width,
          paddingHorizontal: BAR_PADDING_H,
          tabMinWidth: TAB_MIN_WIDTH,
          centerMinWidth: CENTER_MIN_WIDTH,
          tabCount: TAB_ROUTES.length,
        });

        // Nodes that inherit their box: the four tabs (flex row children,
        // stretched to the bar height) and the modal backdrop (absolute fill).
        // Both are sized through the model rather than waved through.
        const inheritedTooSmall = audit.inheritedSize.filter(entry => {
          const isTab = entry.role === 'tab';
          const width = isTab ? layout.tabWidth : variant.width;
          const height = isTab
            ? Math.max(
                Number(entry.style.minHeight ?? 0),
                BAR_HEIGHT - Number(entry.style.paddingTop ?? 0),
              )
            : BAR_HEIGHT * 4;
          return width < MIN_TARGET_POINTS || height < MIN_TARGET_POINTS;
        });
        row.inheritedSizeNodes = audit.inheritedSize.length;
        row.inheritedTooSmall = inheritedTooSmall.length;

        // --- rendered-tree facts -------------------------------------------
        const tabs = nodes.filter(entry => entry.role === 'tab');
        expect(tabs).toHaveLength(4);
        expect(tabs.map(entry => entry.label)).toEqual(EXPECTED_TAB_LABELS);
        const selected = tabs.filter(
          entry => (entry.state as { selected?: boolean }).selected === true,
        );
        const focusedRoute = TAB_ROUTES[variant.focusedIndex]!.name;
        expect(selected).toHaveLength(focusedRoute === 'Add' ? 0 : 1);
        if (focusedRoute !== 'Add') {
          expect(selected[0]!.label).toBe(
            focusedRoute === 'Performance' ? 'Progress' : focusedRoute,
          );
        }

        const fab = nodes.find(
          entry =>
            entry.label === 'Open coach actions' ||
            entry.label === 'Close coach actions',
        );
        expect(fab).toBeDefined();
        expect(fab!.role).toBe('button');

        if (variant.menuOpen) {
          const actionRows = nodes.filter(entry =>
            EXPECTED_ACTIONS.some(action => action.title === entry.label),
          );
          expect(actionRows).toHaveLength(EXPECTED_ACTIONS.length);
          for (const action of EXPECTED_ACTIONS) {
            const match = actionRows.find(
              entry => entry.label === action.title,
            );
            expect(match?.role).toBe('button');
            expect(match?.hint).toBe(action.detail);
            expect(Number(match?.style.minHeight)).toBeGreaterThanOrEqual(
              MIN_TARGET_POINTS,
            );
          }
        }

        expect(audit.violations).toEqual([]);
        expect(inheritedTooSmall).toEqual([]);

        labelsPerVariant.add(
          JSON.stringify(nodes.map(entry => entry.label).sort()),
        );
        copyPerVariant.add(
          JSON.stringify(
            textNodes(renderer)
              .map(entry => entry.value)
              .sort(),
          ),
        );

        // --- modelled extents ----------------------------------------------
        const overflows: Record<string, number>[] = [];
        for (const text of textNodes(renderer)) {
          if (text.numberOfLines !== 1 || text.value.length === 0) continue;
          const fontSize = Number(text.style.fontSize ?? type.micro.fontSize);
          const available = EXPECTED_TAB_LABELS.includes(text.value)
            ? layout.tabWidth
            : Math.min(ACTION_MAX_WIDTH, variant.width - space.lg * 2) -
              12 * 2 -
              46 -
              13 -
              19 -
              13;
          const modelled = estimateTextWidth(text.value, {
            fontSize,
            fontScale: variant.fontScale,
            letterSpacing: Number(text.style.letterSpacing ?? 0),
          });
          if (modelled > available) {
            overflows.push({
              [text.value]: Number((modelled - available).toFixed(1)),
            });
          }
        }

        // COACH caption: not truncated (no numberOfLines) but boxed by the
        // centre slot, and it shares the slot with the risen FAB.
        const coachCaption = textNodes(renderer).find(
          entry => entry.value === 'COACH',
        );
        expect(coachCaption).toBeDefined();
        const captionWidth = estimateTextWidth('COACH', {
          fontSize: Number(coachCaption!.style.fontSize ?? 11),
          fontScale: variant.fontScale,
          letterSpacing: Number(coachCaption!.style.letterSpacing ?? 0),
        });
        if (captionWidth > layout.centerWidth) {
          overflows.push({
            COACH: Number((captionWidth - layout.centerWidth).toFixed(1)),
          });
        }
        const captionHeight = scaledLineHeight(
          Number(coachCaption!.style.lineHeight ?? 14),
          variant.fontScale,
        );
        const captionTop = BAR_HEIGHT - 7 - captionHeight;
        const fabBottom = -FAB_RISE + FAB_SIZE;
        row.modelledCaptionOverlapPt = Number(
          Math.max(0, fabBottom - captionTop).toFixed(1),
        );
        row.modelledOverflows = overflows;
        if (overflows.length > 0 || Number(row.modelledCaptionOverlapPt) > 0) {
          row.outcome = 'MODELLED_OVERFLOW';
        }
      } catch (error) {
        row.outcome = 'THREW';
        row.error = String(error);
        rows.push(row);
        throw error;
      } finally {
        if (renderer) act(() => renderer!.unmount());
      }
      rows.push(row);
    }

    fontScaleSpy.mockRestore();

    // i18n invariance: one label set and one copy set for every locale,
    // timezone and writing direction in the grid.
    if (!MINIMISING) {
      expect(labelsPerVariant.size).toBe(2);
      expect(copyPerVariant.size).toBeLessThanOrEqual(2);
    }
    expect(rows.filter(row => row.outcome === 'THREW')).toEqual([]);
    expect(
      rows.flatMap(row => (row.a11yViolations as unknown[]) ?? []),
    ).toEqual([]);
  });

  (MINIMISING ? it.skip : it)(
    'characterizes the modelled single-line overflow per width and font scale',
    () => {
      // Pins WHERE the shipped copy stops fitting its slot, so a copy or layout
      // change has to move this expectation deliberately instead of silently.
      // The numbers are modelled (`estimateTextWidth`), not measured — pixel
      // truth needs the Apple plane.
      const overflowing = (predicate: (label: string) => boolean) => {
        const byKey = new Map<string, Set<string>>();
        for (const row of rows) {
          const key = `${row.width}@${row.fontScale}`;
          const set = byKey.get(key) ?? new Set<string>();
          for (const overflow of (row.modelledOverflows as Record<
            string,
            number
          >[]) ?? []) {
            for (const label of Object.keys(overflow)) {
              if (predicate(label)) set.add(label);
            }
          }
          byKey.set(key, set);
        }
        return byKey;
      };

      const tabLabels = overflowing(
        label => EXPECTED_TAB_LABELS.includes(label) || label === 'COACH',
      );
      // Tab labels and the COACH caption fit at default and xxLarge Dynamic
      // Type on every supported width...
      for (const width of WIDTHS) {
        expect([...(tabLabels.get(`${width}@1`) ?? [])]).toEqual([]);
        expect([...(tabLabels.get(`${width}@1.235`) ?? [])]).toEqual([]);
      }
      // ...and stop fitting at AX3, where `numberOfLines={1}` truncates them.
      expect([...(tabLabels.get('320@2.35') ?? [])].sort()).toEqual([
        'COACH',
        'Home',
        'Library',
        'Progress',
        'Settings',
      ]);
      expect([...(tabLabels.get('430@2.35') ?? [])].sort()).toEqual([
        'Progress',
        'Settings',
      ]);

      // The coach action detail lines are a different story: they already
      // overflow their row at DEFAULT Dynamic Type on a 320pt iPhone, and at
      // xxLarge on 375pt. Reported as a finding; pinned here as the current
      // modelled state.
      const details = overflowing(label =>
        EXPECTED_ACTIONS.some(action => action.detail === label),
      );
      expect([...(details.get('320@1') ?? [])].sort()).toEqual([
        'Auto capture · validated scores only',
        'Choose a real clip from this phone',
        'Guided drills you can search',
      ]);
      expect([...(details.get('375@1') ?? [])]).toEqual([]);
      expect([...(details.get('430@1') ?? [])]).toEqual([]);
      expect([...(details.get('375@1.235') ?? [])].sort()).toEqual([
        'Auto capture · validated scores only',
        'Choose a real clip from this phone',
      ]);

      // The risen FAB and the COACH caption collide at AX3 only.
      const overlapByScale = new Map<number, number>();
      for (const row of rows) {
        overlapByScale.set(
          Number(row.fontScale),
          Math.max(
            overlapByScale.get(Number(row.fontScale)) ?? 0,
            Number(row.modelledCaptionOverlapPt ?? 0),
          ),
        );
      }
      expect(overlapByScale.get(1)).toBe(0);
      expect(overlapByScale.get(1.235)).toBe(0);
      expect(overlapByScale.get(2.35)!).toBeGreaterThan(0);
    },
  );

  it('reports the localisation headroom of the bar (modelled, not shipped copy)', () => {
    // The bar's labels are hardcoded English; this table says how much room a
    // future localisation would have per locale at each font scale. It asserts
    // only the invariant that matters today: the SHIPPED (en) labels fit at
    // default and xxLarge on the narrowest device.
    const headroom: ResultRow[] = [];
    for (const width of WIDTHS) {
      const layout = resolveBarLayout({
        screenWidth: width,
        paddingHorizontal: BAR_PADDING_H,
        tabMinWidth: TAB_MIN_WIDTH,
        centerMinWidth: CENTER_MIN_WIDTH,
        tabCount: TAB_ROUTES.length,
      });
      for (const [locale, labels] of Object.entries(TAB_LABEL_TRANSLATIONS)) {
        for (const fontScale of FONT_SCALES) {
          const overflowing = Object.entries(labels)
            .filter(([key]) => key !== 'Coach')
            .filter(
              ([, label]) =>
                estimateTextWidth(label, {
                  fontSize: 11,
                  fontScale,
                  letterSpacing: 0.1,
                }) > layout.tabWidth,
            )
            .map(([, label]) => label);
          headroom.push({
            seed: BASE_SEED,
            outcome: overflowing.length === 0 ? 'HELD' : 'MODELLED_OVERFLOW',
            kind: 'localisation-headroom',
            width,
            locale,
            fontScale,
            tabWidth: Number(layout.tabWidth.toFixed(2)),
            overflowing,
          });
        }
      }
    }
    writeResults('premiumTabBar-localisation-headroom', {
      campaign: 'Tab label localisation headroom (modelled)',
      baseSeed: BASE_SEED,
      multiplier: 1,
      rows: headroom,
      summary: {
        note: 'plausible translations, NOT shipped copy — the shipping bar hardcodes English labels',
      },
    });

    const enAtNarrow = headroom.filter(
      row =>
        row.locale === 'en-US' &&
        row.width === 320 &&
        Number(row.fontScale) < 2,
    );
    expect(enAtNarrow.every(row => row.outcome === 'HELD')).toBe(true);
  });
});
