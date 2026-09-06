/**
 * Two-page paywall flow. Page 1 (value): benefits and the free-allowance
 * statement, with NO prices. Page 2 (pricing): the podium layout — three
 * store-priced columns (Monthly / Yearly / Lifetime), yearly pre-selected
 * with BEST VALUE + savings badges, lifetime marked PAY ONCE, a plain-words
 * restatement of the selected plan, and an honest fallback (never an
 * invented price) when store pricing is missing.
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
import { color, radius, type } from '../src/design/tokens';

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

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function pressable(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    n => n.props.testID === testID && typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable with testID ${testID}`);
  return node;
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
  it('uses a flat value page, the approved BrandMark and neutral benefit icons', async () => {
    configureAccessStore(dependencies());
    const renderer = await renderPaywall();
    expect(renderer.root.findAllByType(LinearGradient)).toHaveLength(0);
    const mark = renderer.root.findByType(BrandMark);
    expect(mark.props).toMatchObject({ compact: true, light: true, size: 24 });
    expect(mark.findByType(Image).props.source).toBe(
      require('../assets/brand/pickle-mark.png'),
    );
    const crown = renderer.root
      .findAllByType(Icon)
      .find(icon => icon.props.name === 'crown')!;
    expect(StyleSheet.flatten(crown.parent!.props.style).backgroundColor).toBe(
      color.inkElevated,
    );
    expect(crown.props.color).toBe(color.onDarkMuted);
    const analysis = renderer.root
      .findAllByType(Icon)
      .find(icon => icon.props.name === 'stroke')!;
    expect(analysis.props.color).toBe(color.onDarkMuted);
    expect(
      renderer.root
        .findAllByType(View)
        .some(
          view =>
            StyleSheet.flatten(view.props.style)?.backgroundColor ===
            color.surfaceDark,
        ),
    ).toBe(true);
    expect(
      StyleSheet.flatten(pressable(renderer, 'paywall-see-plans').props.style),
    ).toMatchObject({ backgroundColor: color.volt, borderRadius: radius.md });
    act(() => renderer.unmount());
  });

  it('keeps the default podium and only the selected plan has a solid volt border, never a glow', async () => {
    configureAccessStore(dependencies());
    const renderer = await renderPaywall({
      onOpenTerms: jest.fn(),
      onOpenPrivacy: jest.fn(),
    });
    await openPricing(renderer);
    expect(renderer.root.findAllByType(LinearGradient)).toHaveLength(0);
    for (const period of ['monthly', 'annual', 'lifetime'] as const) {
      const card = pressable(renderer, `paywall-plan-${period}`);
      const style = StyleSheet.flatten(card.props.style);
      expect(style.borderRadius).toBe(radius.md);
      expect(style.borderWidth).toBe(2);
      expect(style.shadowOpacity ?? 0).toBe(0);
      expect(style.elevation ?? 0).toBe(0);
      expect(style.borderColor === color.volt).toBe(period === 'annual');
      expect(StyleSheet.flatten(card.parent!.props.style).flex).toBe(
        period === 'annual' ? 1.18 : 1,
      );
    }
    for (const control of renderer.root.findAllByType(PressableScale)) {
      const style = StyleSheet.flatten(control.props.style);
      expect(style.minHeight ?? style.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    for (const text of renderer.root.findAllByType(Text)) {
      expect(
        StyleSheet.flatten(text.props.style).fontSize,
      ).toBeGreaterThanOrEqual(type.micro.fontSize);
    }
    await act(async () =>
      pressable(renderer, 'paywall-plan-monthly').props.onPress(),
    );
    expect(
      StyleSheet.flatten(
        pressable(renderer, 'paywall-plan-monthly').props.style,
      ),
    ).toMatchObject({
      borderColor: color.volt,
      backgroundColor: color.voltTint,
    });
    expect(
      StyleSheet.flatten(pressable(renderer, 'paywall-plan-annual').props.style)
        .borderColor,
    ).not.toBe(color.volt);
    act(() => renderer.unmount());
  });

  it('switches all plan cards to full width when a native price layout wraps', async () => {
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
        pressable(renderer, 'paywall-plan-lifetime').parent!.props.style,
      ).flex,
    ).toBe(1);
    await act(async () => {
      price.props.onTextLayout({
        nativeEvent: {
          lines: [{ text: 'CA$' }, { text: '1,299.9' }, { text: '9' }],
        },
      });
    });
    for (const period of ['monthly', 'annual', 'lifetime'] as const) {
      const card = pressable(renderer, `paywall-plan-${period}`);
      expect(StyleSheet.flatten(card.parent!.props.style)).toMatchObject({
        flex: 0,
      });
      expect(
        card
          .findAllByType(Text)
          .find(text => text.props.testID === `paywall-plan-${period}-price`)!
          .props.adjustsFontSizeToFit,
      ).toBe(false);
    }
    const options = renderer.root.find(
      node =>
        typeof node.type === 'string' &&
        node.props.testID === 'paywall-plan-options',
    );
    expect(StyleSheet.flatten(options.props.style)).toMatchObject({
      flexDirection: 'column',
      alignItems: 'stretch',
    });
    expect(useAccessStore.getState().selectedPeriod).toBe('annual');
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
    expect(
      StyleSheet.flatten(
        pressable(renderer, 'paywall-plan-lifetime').parent!.props.style,
      ).flex,
    ).toBe(0);
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
      alignSelf: 'stretch',
    });
    expect(price.props.numberOfLines).toBeUndefined();
    expect(price.props.adjustsFontSizeToFit).toBe(false);
    expect(price.props.maxFontSizeMultiplier).toBeUndefined();
    expect(price.props.allowFontScaling).not.toBe(false);
    act(() => renderer.unmount());
  });

  it.each([1, 1.3])(
    'never clips or shrinks localized prices or billing qualifiers at %sx',
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
        expect(StyleSheet.flatten(price.props.style).fontSize).toBe(
          type.h2.fontSize,
        );
        const qualifier = card
          .findAllByType(Text)
          .find(
            text => text.props.testID === `paywall-plan-${period}-qualifier`,
          )!;
        expect(qualifier.props.numberOfLines).toBeUndefined();
        expect(StyleSheet.flatten(qualifier.props.style).fontSize).toBe(
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
      color.inkElevated,
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
    expect(copy).toContain('Unlimited validated ratings');
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

  it('renders all three podium columns with store prices and badges', async () => {
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
    // Podium badges and qualifiers.
    expect(copy).toContain('BEST VALUE');
    expect(copy).toContain('PAY ONCE');
    expect(copy).toContain('SAVE 33%');
    expect(copy).toContain('/month · billed monthly');
    expect(copy).toContain('$3.33/mo · billed yearly');
    expect(copy).toContain('one-time · yours forever');

    act(() => renderer.unmount());
  });

  it.each([1, 3.571])(
    'keeps the complete store trial label and badges in flow at %sx',
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
      if (fontScale > 1.3) {
        const badge = annual
          .findAllByType(View)
          .find(view => view.props.pointerEvents === 'none')!;
        expect(StyleSheet.flatten(badge.props.style)).toMatchObject({
          position: 'relative',
          top: 0,
        });
        expect(StyleSheet.flatten(annual.parent!.props.style).flex).toBe(0);
      }
      expect(deps.store.purchase).not.toHaveBeenCalled();
      expect(deps.store.restore).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    },
  );

  it('pre-selects yearly and restates it in words with trial-first CTA', async () => {
    configureAccessStore(dependencies());
    const renderer = await renderPaywall();
    await openPricing(renderer);

    expect(
      pressable(renderer, 'paywall-plan-annual').props.accessibilityState
        ?.selected,
    ).toBe(true);
    const copy = allText(renderer);
    expect(copy).toContain(
      'Yearly · $39.99 per year, auto-renews. Cancel anytime.',
    );
    expect(copy).toContain('Start free trial');
    expect(copy).toContain('After the 7-day free trial,');

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
