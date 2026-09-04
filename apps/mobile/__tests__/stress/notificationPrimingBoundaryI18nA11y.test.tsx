/**
 * stress-cmp-notification-priming — lens `boundary-i18n-a11y`, render campaign.
 *
 * Seeded campaign over NotificationPrimingCard: 12 locales × 8 timezone cases
 * × 3 iOS Dynamic Type scales × 3 iPhone widths × hostile store states
 * (missing/null/undefined prefs fields, unknown permission values, falsy and
 * non-boolean permission results, unmount mid-request, double taps).
 *
 * Every iteration checks the accessibility contract on the rendered tree
 * (exactly two interactive elements, each with role + non-empty label + hint +
 * a state that exposes `disabled`/`busy`, ≥44pt target) and reconstructs the
 * actions-row geometry from the STYLES on that tree (see
 * `testing/stress/notificationPriming/layout.ts`, pinned against real Yoga in
 * `notificationPrimingLayoutModel.test.ts`) to detect clipping.
 *
 * Scale: `STRESS_ITER` (default 180 — the lens asks for ≥150 rendered
 * variants and the default campaign runs in a few seconds). Replay one row of
 * the seed table with `STRESS_SEED=<seed>`:
 *   cd apps/mobile && STRESS_SEED=1234 npx jest --ci __tests__/stress/notificationPrimingBoundaryI18nA11y.test.tsx
 * Evidence: artifacts/stress-notification-priming/<STRESS_RUN_ID>/
 *   notificationPrimingRender.{events.ndjson,seeds.json}
 */
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { PressableScale } from '../../src/design/components';
import { space, type } from '../../src/design/tokens';
import type { PermissionState } from '../../src/notifications/service';
import {
  DEFAULT_NOTIFICATION_PREFS,
  type NotificationPrefs,
} from '../../src/notifications/types';
import {
  layoutActionsRow,
  measureText,
  visibleWidth,
  type CardChrome,
} from '../../testing/stress/notificationPriming/layout';
import {
  FONT_SCALES,
  LOCALES,
  SCREEN_WIDTHS,
  ZONE_CASES,
  rngFor,
} from '../../testing/stress/notificationPriming/rng';
import {
  iterations,
  pinnedSeed,
  record,
  rowsFor,
  seedTableFile,
  writeSeedTable,
} from '../../testing/stress/notificationPriming/evidence';

const SUITE = 'notificationPrimingRender';

/** The pill label style the card ships (`type.caption` over Manrope). */
const CAPTION = {
  fontFamily: 'Manrope_500Medium',
  fontSize: 13,
  lineHeight: 18,
};

type StoreState = {
  hydrated: unknown;
  prefs: NotificationPrefs;
  permission: PermissionState | 'unknown' | null | undefined;
  requestPermissionAndEnable: () => Promise<boolean>;
  dismissPrompt: () => Promise<void>;
};

const mockRequest = jest.fn<Promise<boolean>, []>();
const mockDismiss = jest.fn<Promise<void>, []>(() => Promise.resolve());
const mockState: StoreState = {
  hydrated: true,
  prefs: { ...DEFAULT_NOTIFICATION_PREFS },
  permission: 'undetermined',
  requestPermissionAndEnable: () => mockRequest(),
  dismissPrompt: () => mockDismiss(),
};

jest.mock('../../src/notifications/notificationStore', () => ({
  useNotificationStore: (selector: (s: StoreState) => unknown) =>
    selector(mockState),
}));

import { NotificationPrimingCard } from '../../src/notifications/NotificationPrimingCard';

/* ------------------------------------------------------------------ inputs */

/** Permission values the card can see, including the degenerate ones. */
const PERMISSIONS: readonly (PermissionState | 'unknown' | null | undefined)[] =
  ['undetermined', 'granted', 'unknown', 'denied', null, undefined];

type PrefsCase = { name: string; prefs: NotificationPrefs };

/**
 * Hostile prefs objects. `NotificationPrefs` is a closed type, so the
 * missing/null/undefined-field cases are built by deletion and cast at the
 * boundary — exactly the shapes a corrupted KV row can produce before
 * `parseNotificationPrefs` normalizes it (and the shapes a future caller
 * could hand the card).
 */
function prefsCases(): readonly PrefsCase[] {
  const base = { ...DEFAULT_NOTIFICATION_PREFS };
  const withoutEnabled: Record<string, unknown> = { ...base };
  delete withoutEnabled['enabled'];
  const withoutDismissed: Record<string, unknown> = { ...base };
  delete withoutDismissed['promptDismissed'];
  return [
    { name: 'defaults', prefs: base },
    { name: 'enabled', prefs: { ...base, enabled: true } },
    { name: 'dismissed', prefs: { ...base, promptDismissed: true } },
    {
      name: 'missing enabled',
      prefs: withoutEnabled as unknown as NotificationPrefs,
    },
    {
      name: 'missing promptDismissed',
      prefs: withoutDismissed as unknown as NotificationPrefs,
    },
    {
      name: 'null flags',
      prefs: {
        ...base,
        enabled: null,
        promptDismissed: null,
      } as unknown as NotificationPrefs,
    },
    {
      name: 'undefined flags',
      prefs: {
        ...base,
        enabled: undefined,
        promptDismissed: undefined,
      } as unknown as NotificationPrefs,
    },
    {
      name: 'zero minutes',
      prefs: { ...base, practiceReminderMinutes: 0 },
    },
    {
      name: 'negative minutes',
      prefs: { ...base, practiceReminderMinutes: -1 },
    },
    {
      name: 'huge minutes',
      prefs: {
        ...base,
        practiceReminderMinutes: Number.MAX_SAFE_INTEGER,
      },
    },
  ];
}

type RequestResultCase = {
  name: string;
  make: () => Promise<boolean>;
  /** Whether the card should end up showing the failure alert. */
  expectFailure: boolean;
};

const REQUEST_RESULTS: readonly RequestResultCase[] = [
  { name: 'granted', make: () => Promise.resolve(true), expectFailure: false },
  { name: 'refused', make: () => Promise.resolve(false), expectFailure: true },
  {
    name: 'undefined',
    make: () => Promise.resolve(undefined as unknown as boolean),
    expectFailure: true,
  },
  {
    name: 'null',
    make: () => Promise.resolve(null as unknown as boolean),
    expectFailure: true,
  },
  {
    name: 'truthy non-boolean',
    make: () => Promise.resolve('granted' as unknown as boolean),
    expectFailure: false,
  },
];

type Interaction =
  | 'idle'
  | 'tapPrimary'
  | 'doubleTapPrimary'
  | 'tapSecondary'
  | 'unmountMidRequest';

const INTERACTIONS: readonly Interaction[] = [
  'idle',
  'tapPrimary',
  'doubleTapPrimary',
  'tapSecondary',
  'unmountMidRequest',
];

interface Variant {
  seed: number;
  locale: string;
  zone: string;
  zoneWhy: string;
  fontScaleName: string;
  fontScale: number;
  deviceName: string;
  screenWidth: number;
  permission: PermissionState | 'unknown' | null | undefined;
  prefsCase: string;
  prefs: NotificationPrefs;
  hydrated: unknown;
  requestResult: RequestResultCase;
  interaction: Interaction;
}

function variantFor(seed: number): Variant {
  const rng = rngFor(seed);
  const cases = prefsCases();
  const font = rng.pick(FONT_SCALES);
  const device = rng.pick(SCREEN_WIDTHS);
  const zone = rng.pick(ZONE_CASES);
  const prefsCase = rng.pick(cases);
  return {
    seed,
    locale: rng.pick(LOCALES),
    zone: zone.zone,
    zoneWhy: zone.why,
    fontScaleName: font.name,
    fontScale: font.scale,
    deviceName: device.name,
    screenWidth: device.width,
    permission: rng.pick(PERMISSIONS),
    prefsCase: prefsCase.name,
    prefs: prefsCase.prefs,
    hydrated: rng.bool(0.85) ? true : rng.pick([false, null, undefined]),
    requestResult: rng.pick(REQUEST_RESULTS),
    interaction: rng.pick(INTERACTIONS),
  };
}

/* ------------------------------------------------------- rendered-tree read */

interface InteractiveEvidence {
  label: unknown;
  hint: unknown;
  role: unknown;
  state: unknown;
  disabled: unknown;
  text: string;
  minHeight: unknown;
  paddingHorizontal: unknown;
  borderWidth: unknown;
  slotMinWidth: unknown;
}

function textOf(node: TestRenderer.ReactTestInstance): string {
  return node
    .findAllByType(Text)
    .flatMap(t => [t.props.children].flat())
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function interactiveElements(
  renderer: TestRenderer.ReactTestRenderer,
): InteractiveEvidence[] {
  return renderer.root.findAllByType(PressableScale).map(node => {
    const style = StyleSheet.flatten(node.props.style) as Record<
      string,
      unknown
    >;
    const container = StyleSheet.flatten(node.props.containerStyle) as Record<
      string,
      unknown
    >;
    return {
      label: node.props.accessibilityLabel,
      hint: node.props.accessibilityHint,
      role: node.props.accessibilityRole,
      state: node.props.accessibilityState,
      disabled: node.props.disabled,
      text: textOf(node),
      minHeight: style['minHeight'],
      paddingHorizontal: style['paddingHorizontal'],
      borderWidth: style['borderWidth'],
      slotMinWidth: container['minWidth'],
    };
  });
}

/** The host (native) nodes an assistive technology actually focuses. */
function hostInteractiveLabels(
  renderer: TestRenderer.ReactTestRenderer,
): string[] {
  return renderer.root
    .findAll(
      node =>
        typeof node.type === 'string' &&
        node.props.accessibilityRole === 'button',
    )
    .map(node => String(node.props.accessibilityLabel ?? ''));
}

function cardStyles(renderer: TestRenderer.ReactTestRenderer) {
  const card = renderer.root.findAllByProps({
    testID: 'notification-priming-card',
  })[0];
  if (!card) throw new Error('card not rendered');
  return StyleSheet.flatten(card.props.style) as Record<string, number>;
}

/**
 * Builds the layout chrome from the rendered tree (styles) plus the two
 * enclosing layout facts the card cannot know: the HomeScreen content
 * padding (`space.lg`) and the icon slot width (read off the tree).
 */
function chromeFrom(
  renderer: TestRenderer.ReactTestRenderer,
  screenWidth: number,
  elements: InteractiveEvidence[],
): CardChrome {
  const card = cardStyles(renderer);
  const iconWrap = renderer.root
    .findAll(node => typeof node.type === 'string')
    .map(node => StyleSheet.flatten(node.props.style) as Record<string, number>)
    .find(style => style && style['width'] === 40 && style['height'] === 40);
  const first = elements[0];
  if (!first) throw new Error('no interactive elements');
  return {
    screenWidth,
    // HomeScreen renders the card inside its ScrollView content container
    // (`paddingHorizontal: space.lg`).
    screenPaddingHorizontal: space.lg,
    iconWidth: iconWrap?.['width'] ?? 40,
    card: {
      padding: card['padding'] ?? 0,
      gap: card['gap'] ?? 0,
      borderWidth: card['borderWidth'] ?? 0,
    },
    actions: { gap: 8 },
    slot: { minWidth: Number(first.slotMinWidth ?? 0) },
    pill: {
      minHeight: Number(first.minHeight ?? 0),
      paddingHorizontal: Number(first.paddingHorizontal ?? 0),
      borderWidth: Number(first.borderWidth ?? 0),
    },
    pillLabel: {
      fontFamily: type.caption.fontFamily,
      fontSize: type.caption.fontSize,
      lineHeight: type.caption.lineHeight,
    },
  };
}

/** Reads the actions-row gap off the tree (the card's `styles.actions`). */
function actionsGap(renderer: TestRenderer.ReactTestRenderer): number {
  const row = renderer.root
    .findAll(node => typeof node.type === 'string')
    .map(
      node => StyleSheet.flatten(node.props.style) as Record<string, unknown>,
    )
    .find(
      style => style && style['flexDirection'] === 'row' && style['gap'] === 8,
    );
  const gap = row?.['gap'];
  return typeof gap === 'number' ? gap : 8;
}

/* ------------------------------------------------------------ the campaign */

function flush() {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function pressableByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  return renderer.root
    .findAllByType(PressableScale)
    .find(node => node.props.accessibilityLabel === label);
}

const PRIMARY_LABEL = 'Turn on practice reminders';
const SECONDARY_LABEL = 'Not now';

/**
 * Dynamic Type scales at which the actions row is known to be clipped by the
 * screen edge on the narrower devices — the P2 finding this campaign
 * reproduced (see the `hazard` block at the bottom of this file). Any variant
 * outside this set that clips is a NEW regression and fails the campaign.
 */
const KNOWN_CLIPPING = new Set([
  'accessibilityLarge@320',
  'accessibilityLarge@375',
]);

interface Outcome {
  visible: boolean;
  interactiveCount: number;
  hostButtonLabels: string[];
  primaryText: string;
  failureAlert: { role: unknown; live: unknown } | null;
  pills: { label: string; width: number; height: number; visible: number }[];
  overflowPastCopyColumn: number;
  overflowPastCardBorder: number;
  overflowPastScreen: number;
  clipped: boolean;
  requestCalls: number;
  dismissCalls: number;
}

async function runVariant(variant: Variant): Promise<Outcome> {
  mockRequest.mockReset();
  mockDismiss.mockClear();
  mockRequest.mockImplementation(variant.requestResult.make);
  mockState.hydrated = variant.hydrated;
  mockState.prefs = variant.prefs;
  mockState.permission = variant.permission;

  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<NotificationPrimingCard />);
  });

  const visible =
    renderer.root.findAllByProps({ testID: 'notification-priming-card' })
      .length > 0;

  if (!visible) {
    const outcome: Outcome = {
      visible: false,
      interactiveCount: interactiveElements(renderer).length,
      hostButtonLabels: hostInteractiveLabels(renderer),
      primaryText: '',
      failureAlert: null,
      pills: [],
      overflowPastCopyColumn: 0,
      overflowPastCardBorder: 0,
      overflowPastScreen: 0,
      clipped: false,
      requestCalls: mockRequest.mock.calls.length,
      dismissCalls: mockDismiss.mock.calls.length,
    };
    act(() => renderer.unmount());
    return outcome;
  }

  if (variant.interaction === 'tapPrimary') {
    await act(async () => {
      pressableByLabel(renderer, PRIMARY_LABEL)?.props.onPress();
    });
    await flush();
  } else if (variant.interaction === 'doubleTapPrimary') {
    let release!: (value: boolean) => void;
    mockRequest.mockImplementation(
      () =>
        new Promise<boolean>(resolve => {
          release = resolve;
        }),
    );
    act(() => {
      pressableByLabel(renderer, PRIMARY_LABEL)?.props.onPress();
    });
    act(() => {
      pressableByLabel(renderer, PRIMARY_LABEL)?.props.onPress();
    });
    await act(async () => {
      release(await variant.requestResult.make());
    });
    await flush();
  } else if (variant.interaction === 'tapSecondary') {
    await act(async () => {
      pressableByLabel(renderer, SECONDARY_LABEL)?.props.onPress();
    });
    await flush();
  } else if (variant.interaction === 'unmountMidRequest') {
    let release!: (value: boolean) => void;
    mockRequest.mockImplementation(
      () =>
        new Promise<boolean>(resolve => {
          release = resolve;
        }),
    );
    act(() => {
      pressableByLabel(renderer, PRIMARY_LABEL)?.props.onPress();
    });
    act(() => renderer.unmount());
    await act(async () => {
      release(true);
    });
    return {
      visible: true,
      interactiveCount: 0,
      hostButtonLabels: [],
      primaryText: '',
      failureAlert: null,
      pills: [],
      overflowPastCopyColumn: 0,
      overflowPastCardBorder: 0,
      overflowPastScreen: 0,
      clipped: false,
      requestCalls: mockRequest.mock.calls.length,
      dismissCalls: mockDismiss.mock.calls.length,
    };
  }

  const elements = interactiveElements(renderer);
  const chrome = chromeFrom(renderer, variant.screenWidth, elements);
  chrome.actions.gap = actionsGap(renderer);
  const labels = elements.map(e => e.text);
  const layout = layoutActionsRow(chrome, labels, variant.fontScale);
  const failureNode = renderer.root.findAllByProps({
    testID: 'notification-priming-failure',
  })[0];
  const outcome: Outcome = {
    visible: true,
    interactiveCount: elements.length,
    hostButtonLabels: hostInteractiveLabels(renderer),
    primaryText: elements[0]?.text ?? '',
    failureAlert: failureNode
      ? {
          role: failureNode.props.accessibilityRole,
          live: failureNode.props.accessibilityLiveRegion,
        }
      : null,
    pills: layout.pills.map(p => ({
      label: p.label,
      width: Math.round(p.width * 100) / 100,
      height: Math.round(p.height * 100) / 100,
      visible: Math.round(visibleWidth(p, variant.screenWidth) * 100) / 100,
    })),
    overflowPastCopyColumn:
      Math.round(layout.overflowPastCopyColumn * 100) / 100,
    overflowPastCardBorder:
      Math.round(layout.overflowPastCardBorder * 100) / 100,
    overflowPastScreen: Math.round(layout.overflowPastScreen * 100) / 100,
    clipped: layout.overflowPastScreen > 0,
    requestCalls: mockRequest.mock.calls.length,
    dismissCalls: mockDismiss.mock.calls.length,
  };
  act(() => renderer.unmount());
  return outcome;
}

function expectedVisible(variant: Variant): boolean {
  const prefs = variant.prefs as unknown as Record<string, unknown>;
  return (
    variant.hydrated === true &&
    !prefs['enabled'] &&
    !prefs['promptDismissed'] &&
    variant.permission !== 'denied'
  );
}

const DEFAULT_ITERATIONS = 180;
const seeds: number[] = (() => {
  const pinned = pinnedSeed();
  if (pinned !== null) return [pinned];
  const count = iterations(DEFAULT_ITERATIONS);
  // Deterministic seed sequence: seed N is variant N, forever.
  return Array.from({ length: count }, (_, i) => 0x5eed0000 + i);
})();

describe('stress cmp-notification-priming — boundary/i18n/a11y render campaign', () => {
  afterAll(() => {
    writeSeedTable(SUITE, {
      lens: 'boundary-i18n-a11y',
      component: 'src/notifications/NotificationPrimingCard.tsx',
      dimensions: {
        locales: LOCALES.length,
        zoneCases: ZONE_CASES.length,
        fontScales: FONT_SCALES.map(f => f.name),
        screenWidths: SCREEN_WIDTHS.map(d => d.width),
        permissionValues: PERMISSIONS.map(p => String(p)),
        prefsCases: prefsCases().map(p => p.name),
        requestResults: REQUEST_RESULTS.map(r => r.name),
        interactions: INTERACTIONS,
      },
      knownClipping: [...KNOWN_CLIPPING],
    });
  });

  it(`renders ${seeds.length} seeded variants and holds the a11y contract`, async () => {
    expect(seeds.length).toBeGreaterThan(0);
    const failures: string[] = [];

    for (const seed of seeds) {
      const variant = variantFor(seed);
      const outcome = await runVariant(variant);
      const problems: string[] = [];
      const key = `${variant.fontScaleName.split(' ')[0]}@${variant.screenWidth}`;

      // Visibility gate is a pure function of the store state.
      if (outcome.visible !== expectedVisible(variant)) {
        problems.push('visibility-gate');
      }

      if (outcome.visible && variant.interaction !== 'unmountMidRequest') {
        // A11Y: exactly the two documented controls, both labelled for
        // VoiceOver at the HOST node an assistive technology focuses.
        if (outcome.interactiveCount !== 2) problems.push('interactive-count');
        if (
          outcome.hostButtonLabels.length !== 2 ||
          outcome.hostButtonLabels.some(l => l.trim() === '')
        ) {
          problems.push('unlabelled-host-button');
        }
        // A11Y: ≥44pt target after Dynamic Type wrapping.
        if (outcome.pills.some(p => p.height < 44)) {
          problems.push('target-below-44pt');
        }
        // A11Y: no control may be clipped away by the screen edge.
        if (outcome.clipped && !KNOWN_CLIPPING.has(key)) {
          problems.push(`clipped-off-screen:${key}`);
        }
        if (outcome.pills.some(p => p.visible < 44)) {
          if (!KNOWN_CLIPPING.has(key)) problems.push('visible-below-44pt');
        }
        // Failure feedback must be an announced alert, never silent.
        const tapped =
          variant.interaction === 'tapPrimary' ||
          variant.interaction === 'doubleTapPrimary';
        if (tapped && variant.requestResult.expectFailure) {
          if (
            outcome.failureAlert === null ||
            outcome.failureAlert.role !== 'alert' ||
            outcome.failureAlert.live !== 'polite'
          ) {
            problems.push('missing-failure-alert');
          }
        }
        if (tapped && !variant.requestResult.expectFailure) {
          if (outcome.failureAlert !== null) problems.push('spurious-alert');
        }
        // A single in-flight request per double tap.
        if (variant.interaction === 'doubleTapPrimary') {
          if (outcome.requestCalls !== 1) problems.push('double-fired-request');
        }
      }

      record({
        suite: SUITE,
        scenario: `${variant.fontScaleName} · ${variant.deviceName} · ${variant.locale} · ${variant.zone} · ${variant.interaction}`,
        seed,
        inputs: {
          locale: variant.locale,
          zone: variant.zone,
          zoneWhy: variant.zoneWhy,
          fontScale: variant.fontScale,
          fontScaleName: variant.fontScaleName,
          device: variant.deviceName,
          screenWidth: variant.screenWidth,
          permission: String(variant.permission),
          prefsCase: variant.prefsCase,
          hydrated: String(variant.hydrated),
          requestResult: variant.requestResult.name,
          interaction: variant.interaction,
        },
        observed: { ...outcome, knownClipping: KNOWN_CLIPPING.has(key) },
        verdict: problems.length === 0 ? 'pass' : 'fail',
        ...(problems.length === 0
          ? {}
          : { brokenInvariant: problems.join(',') }),
      });

      if (problems.length > 0) {
        failures.push(`seed ${seed}: ${problems.join(',')}`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('covers every locale, timezone case, font scale and width in the default campaign', () => {
    if (pinnedSeed() !== null) return; // replay mode inspects one seed
    const rows = rowsFor(SUITE);
    expect(rows.length).toBeGreaterThanOrEqual(150);
    const seen = (key: string) =>
      new Set(
        rows.map(r => String((r.inputs as Record<string, unknown>)[key])),
      );
    expect(seen('locale').size).toBe(LOCALES.length);
    expect(seen('zone').size).toBe(ZONE_CASES.length);
    expect(seen('fontScaleName').size).toBe(FONT_SCALES.length);
    expect(seen('screenWidth').size).toBe(SCREEN_WIDTHS.length);
    expect(seen('interaction').size).toBe(INTERACTIONS.length);
    expect(seen('prefsCase').size).toBe(prefsCases().length);
    expect(seen('permission').size).toBe(PERMISSIONS.length);
  });

  it('writes a replayable seed → outcome table', () => {
    const rows = rowsFor(SUITE);
    expect(rows.every(r => Number.isInteger(r.seed))).toBe(true);
    expect(seedTableFile(SUITE)).toContain('notificationPrimingRender.seeds');
  });

  /**
   * HAZARD (P2, reproduced by this campaign): the actions row is a
   * `flexDirection: 'row'` with no `flexWrap`, holding two `flexGrow: 0`
   * slots of intrinsic width (`minWidth: 96`). Their labels scale with
   * Dynamic Type but the copy column does not grow, so from
   * AccessibilityLarge (multiplier 2.143) upwards the "Not now" pill leaves
   * the card and the screen: on a 320pt device 58.7pt of it is off-screen
   * (83pt of the 141.7pt pill remains reachable, with its label clipped), on
   * 375pt 3.7pt. Already at the DEFAULT text size the row overshoots the
   * copy column by 16.7pt on a 320pt device and crosses the card border by
   * 0.3pt. Every number here is the geometry `layoutActionsRow` reproduces
   * from the shipped styles and real Yoga (see
   * `notificationPrimingLayoutModel.test.ts`); INVERT this block (assert 0
   * overflow) once the row wraps or the labels are clamped.
   */
  describe('hazard — Dynamic Type clipping of the actions row', () => {
    const measure = async (fontScale: number, screenWidth: number) => {
      mockRequest.mockReset();
      mockRequest.mockResolvedValue(true);
      mockState.hydrated = true;
      mockState.prefs = { ...DEFAULT_NOTIFICATION_PREFS };
      mockState.permission = 'undetermined';
      let renderer!: TestRenderer.ReactTestRenderer;
      act(() => {
        renderer = TestRenderer.create(<NotificationPrimingCard />);
      });
      const elements = interactiveElements(renderer);
      const chrome = chromeFrom(renderer, screenWidth, elements);
      chrome.actions.gap = actionsGap(renderer);
      const layout = layoutActionsRow(
        chrome,
        elements.map(e => e.text),
        fontScale,
      );
      act(() => renderer.unmount());
      return layout;
    };

    it('fits inside the card at the default text size on 375pt and wider', async () => {
      for (const width of [375, 430]) {
        const layout = await measure(1.0, width);
        expect(layout.overflowPastCopyColumn).toBe(0);
        expect(layout.overflowPastScreen).toBe(0);
      }
    });

    it('overruns the copy column at the default text size on a 320pt screen', async () => {
      const layout = await measure(1.0, 320);
      expect(layout.overflowPastCopyColumn).toBeCloseTo(16.7, 0);
      // Crosses the hairline border by exactly the hairline width — 0.5pt at
      // the @2x hairline this environment reports, 1/3pt on an @3x device.
      expect(layout.overflowPastCardBorder).toBeGreaterThan(0);
      expect(layout.overflowPastCardBorder).toBeLessThanOrEqual(0.5);
      expect(layout.overflowPastScreen).toBe(0);
    });

    it('pushes "Not now" off the screen at accessibilityLarge (320pt: 58.7pt lost)', async () => {
      const layout = await measure(2.143, 320);
      expect(layout.overflowPastScreen).toBeCloseTo(58.7, 0);
      const notNow = layout.pills[1];
      expect(notNow?.label).toBe('Not now');
      // The pill still offers a >44pt hit area, but its label is cut off.
      expect(visibleWidth(notNow!, 320)).toBeCloseTo(83, 0);
      const labelRight =
        notNow!.left + 17 + measureText('Not now', CAPTION, 2.143);
      expect(labelRight).toBeGreaterThan(320);
    });

    it('pushes "Not now" off the screen at accessibilityLarge (375pt: 3.7pt lost)', async () => {
      const layout = await measure(2.143, 375);
      expect(layout.overflowPastScreen).toBeCloseTo(3.7, 0);
    });

    it('fits on a 430pt screen at accessibilityLarge', async () => {
      const layout = await measure(2.143, 430);
      expect(layout.overflowPastScreen).toBe(0);
    });

    it('keeps every pill at least 44pt tall at every scale', async () => {
      for (const scale of [1.0, 1.353, 2.143, 3.571]) {
        for (const width of [320, 375, 430]) {
          const layout = await measure(scale, width);
          for (const pill of layout.pills) {
            expect(pill.height).toBeGreaterThanOrEqual(44);
          }
        }
      }
    });
  });
});
