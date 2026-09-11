/**
 * Two-page paywall flow on the app's chalk surface. Page 1 (value): benefits
 * and the free-allowance statement, with NO prices. Page 2 (pricing): three
 * full-width store-priced rows ordered Monthly / Yearly / Lifetime — the
 * recommended MONTHLY plan first, pre-selected and cast as the one ink card
 * (volt RECOMMENDED badge, volt amount while selected) while its siblings are
 * white cards (yearly carries the honest savings chip from store prices), a
 * plain-words restatement of the selected plan, and an honest fallback (never
 * an invented price) when store pricing is missing.
 */
jest.mock('react-native-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  initialWindowMetrics: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
}));
jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Line: Mock,
    Path: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
  };
});

import React from 'react';
import {
  Dimensions,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import TestRenderer, { act } from 'react-test-renderer';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
  StorePlans,
} from '../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../src/state/accessStore';
import { PaywallScreen } from '../src/screens/PaywallScreen';
import { BrandMark, PressableScale } from '../src/design/components';
import { Icon } from '../src/design/icons';
import { color, membership, radius, type } from '../src/design/tokens';

const freeAccess: CanonicalAccessState = {
  premium: false,
  entitlements: [],
  freeRatings: {
    limit: 2,
    used: 1,
    reserved: 0,
    remaining: 1,
    availableToReserve: 1,
  },
  canStartRating: true,
  paywallRequired: false,
};

const plans: StorePlans = {
  offeringId: 'default',
  annual: {
    id: 'annual-plan',
    productId: 'premium_annual_3999',
    period: 'annual',
    price: 39.99,
    priceString: '$39.99',
    pricePerMonthString: '$3.33',
    freeTrial: { label: '7-day free trial', periodIso8601: 'P7D' },
  },
  monthly: {
    id: 'monthly-plan',
    productId: 'premium_monthly_499',
    period: 'monthly',
    price: 4.99,
    priceString: '$4.99',
    pricePerMonthString: '$4.99',
    freeTrial: null,
  },
  lifetime: {
    id: 'lifetime-plan',
    productId: 'premium_lifetime_15999',
    period: 'lifetime',
    price: 159.99,
    priceString: '$159.99',
    pricePerMonthString: null,
    freeTrial: null,
  },
};

function dependencies(options?: {
  loadPlans?: () => Promise<StorePlans>;
}): BillingAccessDependencies {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(options?.loadPlans ?? (async () => plans)),
      purchase: jest.fn(async () => ({
        premium: true,
        productId: 'premium_annual_3999',
        expirationDate: null,
      })),
      restore: jest.fn(async () => ({
        premium: true,
        productId: 'premium_annual_3999',
        expirationDate: null,
      })),
      readEntitlement: jest.fn(async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      })),
    },
    backend: {
      getAccess: jest.fn(async () => freeAccess),
      syncBilling: jest.fn(async () => {
        throw new Error('not exercised in these tests');
      }),
    },
  };
}

async function renderPaywall(
  props: Partial<React.ComponentProps<typeof PaywallScreen>> = {},
) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PaywallScreen onClose={jest.fn()} {...props} />,
    );
  });
  // Flush initialize(): configure + getAccess/loadPlans promise chains.
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
  });
  return renderer;
}

/** Step from the value page to the pricing page (the second paywall page). */
async function openPricing(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    pressable(renderer, 'paywall-see-plans').props.onPress();
  });
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
  });
}

function allTextOf(node: TestRenderer.ReactTestInstance): string {
  return node
    .findAllByType(Text)
    .map(text => text.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return allTextOf(renderer.root);
}

function pressable(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    n => n.props.testID === testID && typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable with testID ${testID}`);
  return node;
}

/** The host view carrying this testID (its flattened style is what renders). */
function hostByTestId(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  return renderer.root.find(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
}

beforeEach(() => {
  jest
    .spyOn(Dimensions, 'get')
    .mockReturnValue({ width: 393, height: 852, scale: 3, fontScale: 1 });
  clearAccessStoreConfiguration();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('PaywallScreen podium', () => {
  it('uses a flat chalk value page, the approved BrandMark and ink glyphs on soft tiles', async () => {
    configureAccessStore(dependencies());
    const renderer = await renderPaywall();
    expect(renderer.root.findAllByType(LinearGradient)).toHaveLength(0);
    const mark = renderer.root.findByType(BrandMark);
    expect(mark.props).toMatchObject({ compact: true, size: 24 });
    expect(mark.props.light).toBeFalsy();
    expect(mark.findByType(Image).props.source).toBe(
      require('../assets/brand/pickle-mark.png'),
    );
    const crown = renderer.root
      .findAllByType(Icon)
      .find(icon => icon.props.name === 'crown')!;
    expect(StyleSheet.flatten(crown.parent!.props.style).backgroundColor).toBe(
      color.surfaceAlt,
    );
    expect(crown.props.color).toBe(color.ink);
    // One bespoke glyph per benefit, none of them the generic stroke/court set.
    const benefitIcons = renderer.root
      .findAllByType(Icon)
      .map(icon => icon.props.name)
      .filter(name => ['replay', 'verdict', 'ladder', 'cones'].includes(name));
    expect(benefitIcons).toEqual(['replay', 'verdict', 'ladder', 'cones']);
    const analysis = renderer.root
      .findAllByType(Icon)
      .find(icon => icon.props.name === 'replay')!;
    expect(analysis.props.color).toBe(color.ink);
    expect(
      StyleSheet.flatten(analysis.parent!.props.style).backgroundColor,
    ).toBe(color.surfaceAlt);
    expect(
      renderer.root
        .findAllByType(View)
        .some(
          view =>
            StyleSheet.flatten(view.props.style)?.backgroundColor ===
            color.surface,
        ),
    ).toBe(true);
    expect(
      StyleSheet.flatten(pressable(renderer, 'paywall-see-plans').props.style),
    ).toMatchObject({ backgroundColor: color.ink, borderRadius: radius.pill });
    act(() => renderer.unmount());
  });

  it('casts the recommended monthly plan as the one ink row, siblings white, never a glow or gradient', async () => {
    configureAccessStore(dependencies());
    const renderer = await renderPaywall({
      onOpenTerms: jest.fn(),
      onOpenPrivacy: jest.fn(),
    });
    await openPricing(renderer);
    expect(renderer.root.findAllByType(LinearGradient)).toHaveLength(0);
    const options = hostByTestId(renderer, 'paywall-plan-options');
    // Full-width rows, the recommended plan first.
    expect(StyleSheet.flatten(options.props.style)).toMatchObject({
      flexDirection: 'column',
      alignItems: 'stretch',
    });
    expect(
      options.findAllByType(PressableScale).map(node => node.props.testID),
    ).toEqual([
      'paywall-plan-monthly',
      'paywall-plan-annual',
      'paywall-plan-lifetime',
    ]);
    for (const period of ['monthly', 'annual', 'lifetime'] as const) {
      const card = pressable(renderer, `paywall-plan-${period}`);
      const style = StyleSheet.flatten(card.props.style);
      const hero = period === 'monthly';
      expect(style.borderRadius).toBe(radius.lg);
      expect(style.borderWidth).toBe(2);
      expect(style.shadowOpacity ?? 0).toBe(0);
      expect(style.elevation ?? 0).toBe(0);
      expect(style.backgroundColor).toBe(
        hero ? membership.hero : membership.plan,
      );
      expect(style.borderColor === color.volt).toBe(hero);
      const price = card
        .findAllByType(Text)
        .find(text => text.props.testID === `paywall-plan-${period}-price`)!;
      expect(StyleSheet.flatten(price.props.style)).toMatchObject(
        hero
          ? { fontSize: type.score.fontSize, color: color.volt }
          : { fontSize: type.h2.fontSize, color: color.ink },
      );
    }
    const monthly = pressable(renderer, 'paywall-plan-monthly');
    expect(StyleSheet.flatten(monthly.props.style).minHeight).toBeGreaterThan(
      StyleSheet.flatten(pressable(renderer, 'paywall-plan-annual').props.style)
        .minHeight,
    );
    const badge = monthly
      .findAllByType(View)
      .find(view => view.props.pointerEvents === 'none')!;
    expect(StyleSheet.flatten(badge.props.style)).toMatchObject({
      position: 'absolute',
      top: -12,
      backgroundColor: color.volt,
    });
    expect(badge.findAllByType(Icon).map(icon => icon.props.name)).toEqual([
      'spark',
    ]);
    expect(allTextOf(badge)).toBe('RECOMMENDED');
    for (const control of renderer.root.findAllByType(PressableScale)) {
      const style = StyleSheet.flatten(control.props.style);
      expect(style.minHeight ?? style.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    for (const text of renderer.root.findAllByType(Text)) {
      expect(
        StyleSheet.flatten(text.props.style).fontSize,
      ).toBeGreaterThanOrEqual(type.micro.fontSize);
    }
    // Choosing a sibling: an ink edge on the white card, volt leaves the
    // hero, and the hero stays ink (the dark treatment is the plan's, not
    // the selection's).
    await act(async () =>
      pressable(renderer, 'paywall-plan-annual').props.onPress(),
    );
    expect(
      StyleSheet.flatten(
        pressable(renderer, 'paywall-plan-annual').props.style,
      ),
    ).toMatchObject({
      borderColor: membership.planSelectedLine,
      backgroundColor: membership.plan,
    });
    const heroStyle = StyleSheet.flatten(
      pressable(renderer, 'paywall-plan-monthly').props.style,
    );
    expect(heroStyle.borderColor).toBe(membership.hero);
    expect(heroStyle.backgroundColor).toBe(membership.hero);
    expect(
      StyleSheet.flatten(
        pressable(renderer, 'paywall-plan-monthly')
          .findAllByType(Text)
          .find(text => text.props.testID === 'paywall-plan-monthly-price')!
          .props.style,
      ).color,
    ).toBe(color.onDark);
    act(() => renderer.unmount());
  });

  it('stacks each row and gives amounts the full card when a native price layout wraps', async () => {
    const localizedPlans: StorePlans = {
      ...plans,
      lifetime: { ...plans.lifetime!, priceString: 'CA$ 1,299.99' },
    };
    const deps = dependencies({ loadPlans: async () => localizedPlans });
    configureAccessStore(deps);
    const renderer = await renderPaywall();
    await openPricing(renderer);
    const price = pressable(renderer, 'paywall-plan-lifetime')
      .findAllByType(Text)
      .find(text => text.props.testID === 'paywall-plan-lifetime-price')!;
    expect(typeof price.props.onTextLayout).toBe('function');
    await act(async () => {
      price.props.onTextLayout({
        nativeEvent: { lines: [{ text: 'CA$ 1,299.99' }] },
      });
    });
    expect(
      StyleSheet.flatten(
        pressable(renderer, 'paywall-plan-lifetime').props.style,
      ).paddingHorizontal,
    ).toBeGreaterThan(8);
    await act(async () => {
      price.props.onTextLayout({
        nativeEvent: {
          lines: [{ text: 'CA$' }, { text: '1,299.9' }, { text: '9' }],
        },
      });
    });
    for (const period of ['monthly', 'annual', 'lifetime'] as const) {
      const card = pressable(renderer, `paywall-plan-${period}`);
      expect(StyleSheet.flatten(card.props.style).paddingHorizontal).toBe(8);
      expect(
        card
          .findAllByType(Text)
          .find(text => text.props.testID === `paywall-plan-${period}-price`)!
          .props.adjustsFontSizeToFit,
      ).toBe(false);
    }
    // The badge drops into the flow above the stacked hero content.
    const badge = pressable(renderer, 'paywall-plan-monthly')
      .findAllByType(View)
      .find(view => view.props.pointerEvents === 'none')!;
    expect(StyleSheet.flatten(badge.props.style)).toMatchObject({
      position: 'relative',
      top: 0,
    });
    const options = hostByTestId(renderer, 'paywall-plan-options');
    expect(StyleSheet.flatten(options.props.style)).toMatchObject({
      flexDirection: 'column',
      alignItems: 'stretch',
    });
    expect(
      options.findAllByType(PressableScale).map(node => node.props.testID),
    ).toEqual([
      'paywall-plan-monthly',
      'paywall-plan-annual',
      'paywall-plan-lifetime',
    ]);
    expect(useAccessStore.getState().selectedPeriod).toBe('monthly');
    expect(useAccessStore.getState().plans).toEqual(localizedPlans);
    await act(async () => {
      price.props.onTextLayout({
        nativeEvent: { lines: [{ text: 'CA$ 1,299.99' }] },
      });
      pressable(renderer, 'paywall-plan-lifetime').props.onPress();
    });
    expect(useAccessStore.getState().selectedPeriod).toBe('lifetime');
    expect(allText(renderer)).toContain(
      'Lifetime · CA$ 1,299.99 one-time payment. No renewal, no subscription.',
    );
    expect(
      pressable(renderer, 'paywall-continue').props.accessibilityLabel,
    ).toBe('Continue · CA$ 1,299.99 once');
    expect(deps.store.purchase).not.toHaveBeenCalled();
    expect(deps.store.restore).not.toHaveBeenCalled();
    expect(deps.backend.syncBilling).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('allocates the measured tabular amount width at maximum text without shrinking its font', async () => {
    jest
      .spyOn(Dimensions, 'get')
      .mockReturnValue({ width: 375, height: 667, scale: 2, fontScale: 3.571 });
    configureAccessStore(dependencies());
    const renderer = await renderPaywall();
    await openPricing(renderer);
    const content = StyleSheet.flatten(
      renderer.root.findByType(ScrollView).props.contentContainerStyle,
    );
    const card = pressable(renderer, 'paywall-plan-lifetime');
    const cardStyle = StyleSheet.flatten(card.props.style);
    const width =
      375 -
      2 * content.paddingHorizontal -
      2 * cardStyle.paddingHorizontal -
      2 * cardStyle.borderWidth;
    expect(width).toBeGreaterThanOrEqual(322.237);
    expect(content.paddingHorizontal).toBe(16);
    expect(cardStyle.paddingHorizontal).toBe(8);
    expect(width).toBe(323);
    const price = card
      .findAllByType(Text)
      .find(text => text.props.testID === 'paywall-plan-lifetime-price')!;
    expect(StyleSheet.flatten(price.props.style).fontSize).toBe(
      type.h2.fontSize,
    );
    expect(StyleSheet.flatten(price.props.style)).toMatchObject({
      ...type.h2,
      fontSize: 21,
      fontVariant: ['tabular-nums'],
    });
    expect(price.props.numberOfLines).toBeUndefined();
    expect(price.props.adjustsFontSizeToFit).toBe(false);
    expect(price.props.maxFontSizeMultiplier).toBeUndefined();
    expect(price.props.allowFontScaling).not.toBe(false);
    act(() => renderer.unmount());
  });

  it.each([1, 1.3])(
    'never clips or shrinks localized prices or billing details at %sx',
    async fontScale => {
      jest
        .spyOn(Dimensions, 'get')
        .mockReturnValue({ width: 393, height: 852, scale: 3, fontScale });
      const localizedPlans: StorePlans = {
        ...plans,
        monthly: { ...plans.monthly!, priceString: 'CA$ 12.99' },
        annual: {
          ...plans.annual!,
          priceString: 'CA$ 129.99',
          pricePerMonthString: 'CA$ 10.83',
        },
        lifetime: { ...plans.lifetime!, priceString: 'CA$ 1,299.99' },
      };
      configureAccessStore(
        dependencies({ loadPlans: async () => localizedPlans }),
      );
      const renderer = await renderPaywall();
      await openPricing(renderer);
      for (const period of ['monthly', 'annual', 'lifetime'] as const) {
        const card = pressable(renderer, `paywall-plan-${period}`);
        const price = card
          .findAllByType(Text)
          .find(text => text.props.testID === `paywall-plan-${period}-price`)!;
        expect(price.props.children).toBe(localizedPlans[period]!.priceString);
        expect(price.props.numberOfLines).toBeUndefined();
        expect(price.props.adjustsFontSizeToFit).toBe(false);
        expect(price.props.minimumFontScale).toBeUndefined();
        // The recommended plan's amount is set in the score size; the
        // siblings keep h2. Neither ever shrinks.
        expect(StyleSheet.flatten(price.props.style).fontSize).toBe(
          period === 'monthly' ? type.score.fontSize : type.h2.fontSize,
        );
        const detail = card
          .findAllByType(Text)
          .find(
            text => text.props.testID === `paywall-plan-${period}-qualifier`,
          )!;
        expect(detail.props.numberOfLines).toBeUndefined();
        expect(StyleSheet.flatten(detail.props.style).fontSize).toBe(
          type.caption.fontSize,
        );
      }
      await act(async () =>
        pressable(renderer, 'paywall-plan-lifetime').props.onPress(),
      );
      const cta = pressable(renderer, 'paywall-continue').findByType(Text);
      expect(cta.props.children).toBe('Continue · CA$ 1,299.99 once');
      expect(cta.props.numberOfLines).toBeUndefined();
      expect(cta.props.adjustsFontSizeToFit).not.toBe(true);
      expect(StyleSheet.flatten(cta.props.style).flexShrink).toBe(1);
      act(() => renderer.unmount());
    },
  );

  it('keeps verified membership flat without inventing a new offer', async () => {
    const deps = dependencies();
    deps.backend.getAccess = jest.fn(async () => ({
      ...freeAccess,
      premium: true,
      entitlements: ['premium'],
    }));
    configureAccessStore(deps);
    const renderer = await renderPaywall();
    expect(renderer.root.findAllByType(LinearGradient)).toHaveLength(0);
    expect(allText(renderer)).toContain('Your full court is open.');
    expect(allText(renderer)).not.toContain('$');
    const crown = renderer.root
      .findAllByType(Icon)
      .find(icon => icon.props.name === 'crown')!;
    expect(StyleSheet.flatten(crown.parent!.props.style).backgroundColor).toBe(
      color.surfaceAlt,
    );
    expect(deps.store.purchase).not.toHaveBeenCalled();
    expect(deps.store.restore).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('sells value on page 1: benefits, no prices, and a see-plans step', async () => {
    configureAccessStore(dependencies());
    const renderer = await renderPaywall();

    // Page 1 is the value pitch: benefits present, prices absent.
    const copy = allText(renderer);
    expect(copy).toContain('A coach for every stroke.');
    expect(copy).toContain('Unlimited technique analyses');
    expect(copy).not.toContain('validated ratings');
    expect(copy).not.toContain('rights-cleared coaching videos');
    expect(copy).toContain('Rank and progress from real scores');
    expect(copy).not.toContain('$');
    expect(pressable(renderer, 'paywall-see-plans')).toBeTruthy();
    expect(
      renderer.root.findAll(n => n.props.testID === 'paywall-continue'),
    ).toHaveLength(0);

    act(() => renderer.unmount());
  });

  it('returns from pricing to the value page via back', async () => {
    configureAccessStore(dependencies());
    const renderer = await renderPaywall();
    await openPricing(renderer);

    expect(pressable(renderer, 'paywall-continue')).toBeTruthy();
    await act(async () => {
      pressable(renderer, 'paywall-back').props.onPress();
    });
    expect(pressable(renderer, 'paywall-see-plans')).toBeTruthy();
    expect(
      renderer.root.findAll(n => n.props.testID === 'paywall-continue'),
    ).toHaveLength(0);

    act(() => renderer.unmount());
  });

  it('renders all three plan rows with store prices, the badge and the savings chip', async () => {
    configureAccessStore(dependencies());
    const renderer = await renderPaywall();
    await openPricing(renderer);

    expect(pressable(renderer, 'paywall-plan-monthly')).toBeTruthy();
    expect(pressable(renderer, 'paywall-plan-annual')).toBeTruthy();
    expect(pressable(renderer, 'paywall-plan-lifetime')).toBeTruthy();
    expect(pressable(renderer, 'paywall-continue')).toBeTruthy();
    expect(pressable(renderer, 'paywall-restore')).toBeTruthy();

    const copy = allText(renderer);
    // Store-verified prices, never invented.
    expect(copy).toContain('$4.99');
    expect(copy).toContain('$39.99');
    expect(copy).toContain('$159.99');
    // The recommended plan carries the one badge; the yearly row states its
    // saving from the store's own prices; everything else is a plain fact.
    expect(copy).toContain('RECOMMENDED');
    expect(copy).toContain('SAVE 33%');
    expect(copy).toContain('Billed monthly · cancel anytime');
    expect(copy).toContain('$3.33/mo · billed yearly');
    expect(copy).toContain('One-time purchase · no renewal');
    expect(copy).not.toContain('yours forever');
    expect(copy).not.toMatch(/\bBEST\b/);
    const monthly = pressable(renderer, 'paywall-plan-monthly');
    expect(allTextOf(monthly)).toContain('RECOMMENDED');
    expect(allTextOf(monthly)).not.toContain('SAVE');
    expect(allTextOf(pressable(renderer, 'paywall-plan-annual'))).toContain(
      'SAVE 33%',
    );
    expect(
      allTextOf(pressable(renderer, 'paywall-plan-lifetime')),
    ).not.toContain('RECOMMENDED');

    act(() => renderer.unmount());
  });

  it.each([1, 3.571])(
    'keeps the complete store trial label and the badge in flow at %sx',
    async fontScale => {
      jest
        .spyOn(Dimensions, 'get')
        .mockReturnValue({ width: 375, height: 667, scale: 2, fontScale });
      const longPlans: StorePlans = {
        ...plans,
        annual: {
          ...plans.annual!,
          freeTrial: {
            label: '14-day introductory free trial',
            periodIso8601: 'P14D',
          },
        },
      };
      const deps = dependencies({ loadPlans: async () => longPlans });
      configureAccessStore(deps);
      const renderer = await renderPaywall();
      await openPricing(renderer);
      const annual = pressable(renderer, 'paywall-plan-annual');
      const trial = annual
        .findAllByType(Text)
        .find(text => text.props.testID === 'paywall-plan-annual-trial')!;
      expect(trial.props.children).toBe('14-day introductory free trial');
      expect(trial.props.numberOfLines).toBeUndefined();
      for (const text of annual.findAllByType(Text)) {
        expect(text.props.adjustsFontSizeToFit).not.toBe(true);
        expect(text.props.maxFontSizeMultiplier).toBeUndefined();
        expect(text.props.allowFontScaling).not.toBe(false);
      }
      // The RECOMMENDED badge sits on the monthly card's shoulder and drops
      // into the flow once the row stacks for large text.
      const badge = pressable(renderer, 'paywall-plan-monthly')
        .findAllByType(View)
        .find(view => view.props.pointerEvents === 'none')!;
      expect(allTextOf(badge)).toBe('RECOMMENDED');
      expect(StyleSheet.flatten(badge.props.style)).toMatchObject(
        fontScale > 1.3
          ? { position: 'relative', top: 0 }
          : { position: 'absolute', top: -12 },
      );
      expect(deps.store.purchase).not.toHaveBeenCalled();
      expect(deps.store.restore).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    },
  );

  it('pre-selects the recommended monthly plan and restates it in words; yearly still offers its trial', async () => {
    configureAccessStore(dependencies());
    const renderer = await renderPaywall();
    await openPricing(renderer);

    expect(
      pressable(renderer, 'paywall-plan-monthly').props.accessibilityState
        ?.selected,
    ).toBe(true);
    expect(
      pressable(renderer, 'paywall-plan-monthly').props.accessibilityLabel,
    ).toBe('Monthly membership, $4.99 per month, selected');
    let copy = allText(renderer);
    expect(copy).toContain(
      'Monthly · $4.99 per month, auto-renews. Cancel anytime.',
    );
    expect(copy).toContain('Continue · $4.99/mo');
    expect(copy).toContain(
      '$4.99 per month, automatically renewing until canceled.',
    );
    expect(copy).not.toContain('Start free trial');

    await act(async () =>
      pressable(renderer, 'paywall-plan-annual').props.onPress(),
    );
    copy = allText(renderer);
    expect(copy).toContain(
      'Yearly · $39.99 per year, auto-renews. Cancel anytime.',
    );
    expect(copy).toContain('Start free trial');
    expect(copy).toContain('After the 7-day free trial,');

    act(() => renderer.unmount());
  });

  it('shows RECOMMENDED only when there is a choice, and keeps the ink card for a lone monthly plan', async () => {
    configureAccessStore(
      dependencies({
        loadPlans: async () => ({ ...plans, annual: null, lifetime: null }),
      }),
    );
    const renderer = await renderPaywall();
    await openPricing(renderer);

    expect(allText(renderer)).not.toContain('RECOMMENDED');
    const monthly = pressable(renderer, 'paywall-plan-monthly');
    expect(monthly.props.accessibilityState?.selected).toBe(true);
    expect(StyleSheet.flatten(monthly.props.style)).toMatchObject({
      backgroundColor: membership.hero,
      borderColor: color.volt,
    });
    expect(allTextOf(monthly)).toContain('Billed monthly · cancel anytime');

    act(() => renderer.unmount());
  });

  it('selecting lifetime updates the summary, CTA, and legal copy', async () => {
    configureAccessStore(dependencies());
    const renderer = await renderPaywall();
    await openPricing(renderer);

    await act(async () => {
      pressable(renderer, 'paywall-plan-lifetime').props.onPress();
    });

    expect(
      pressable(renderer, 'paywall-plan-lifetime').props.accessibilityLabel,
    ).toBe('Lifetime membership, $159.99 one-time, selected');
    const copy = allText(renderer);
    expect(copy).toContain(
      'Lifetime · $159.99 one-time payment. No renewal, no subscription.',
    );
    expect(copy).toContain('Continue · $159.99 once');
    expect(copy).toContain(
      '$159.99 one-time purchase. Not a subscription — no renewal.',
    );
    expect(copy).not.toContain('automatically renewing');

    act(() => renderer.unmount());
  });

  it('keeps the honest no-pricing fallback and retry when the store fails', async () => {
    configureAccessStore(
      dependencies({
        loadPlans: async () => {
          throw new Error('store offline');
        },
      }),
    );
    const renderer = await renderPaywall();
    await openPricing(renderer);

    const copy = allText(renderer);
    expect(copy).toContain('Store pricing is unavailable');
    expect(copy).not.toContain('$');
    expect(pressable(renderer, 'paywall-retry')).toBeTruthy();
    expect(
      renderer.root.findAll(n => n.props.testID === 'paywall-plan-annual'),
    ).toHaveLength(0);

    act(() => renderer.unmount());
  });
});
