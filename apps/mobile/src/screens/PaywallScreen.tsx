import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  BackHandler,
  Easing,
  Linking,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import {
  BrandMark,
  BrandSpinner,
  PressableScale,
  useReducedMotion,
} from '../design/components';
import { useReliableSafeAreaInsets } from '../design/safeArea';
import { Icon, type IconName } from '../design/icons';
import { color, membership, radius, space, type } from '../design/tokens';
import type { BillingPeriod, StorePlan } from '../billing/types';
import { APP_STORE_SUBSCRIPTIONS_URL } from '../billing/membershipState';
import {
  selectHasPremium,
  selectMembershipState,
  selectNeedsFulfilmentRecovery,
  useAccessStore,
} from '../state/accessStore';
import { showBrandNotice } from '../design/BrandNotice';
import {
  FREE_PLAY_EYEBROW,
  freeRatingAllowanceCopy,
  membershipHeroCopy,
  RATING_CONSUMPTION_RULE,
} from './paywallCopy';

async function openSubscriptionManagement(): Promise<void> {
  try {
    await Linking.openURL(APP_STORE_SUBSCRIPTIONS_URL);
  } catch {
    showBrandNotice({
      title: 'Could not open subscriptions',
      detail:
        'Open App Store account settings to manage or cancel your subscription.',
      tone: 'danger',
      eyebrow: 'STORE UNAVAILABLE',
    });
  }
}

export interface PaywallScreenProps {
  onClose: () => void;
  /** Called only after the backend verifies the premium entitlement. */
  onPurchased?: () => void;
  onOpenTerms?: () => void;
  onOpenPrivacy?: () => void;
}

/** The value page's sell — every line is a real, shipping capability (no
 * invented features): unlimited ratings, evidence-bound coaching, the saved
 * practice library, and the rank/progress system. */
const BENEFITS: Array<{ icon: IconName; title: string; body: string }> = [
  {
    icon: 'replay',
    title: 'Unlimited technique analyses',
    body: 'Automatic capture with replay and checkpoint feedback.',
  },
  {
    icon: 'verdict',
    title: 'Coaching that follows evidence',
    body: 'When reviewed work exists, a server-accepted score sets its priority and reassessment baseline.',
  },
  {
    icon: 'ladder',
    title: 'Rank and progress from real scores',
    body: 'Player rank and trends built from your saved analysis results.',
  },
  {
    icon: 'cones',
    title: 'Practice, kept together',
    body: 'Save available drills and coaching videos with your practice plan.',
  },
];

type PaywallPage = 'value' | 'pricing';

function periodLabel(period: BillingPeriod): string {
  return period === 'annual'
    ? 'year'
    : period === 'lifetime'
      ? 'one-time'
      : 'month';
}

function savingsLabel(annual: StorePlan | null, monthly: StorePlan | null) {
  if (!annual || !monthly || monthly.price <= 0) return null;
  const annualAtMonthlyRate = monthly.price * 12;
  if (annual.price >= annualAtMonthlyRate) return null;
  const percent = Math.round(
    ((annualAtMonthlyRate - annual.price) / annualAtMonthlyRate) * 100,
  );
  return percent > 0 ? `SAVE ${percent}%` : null;
}

const PLAN_TITLES: Record<BillingPeriod, string> = {
  monthly: 'Monthly',
  annual: 'Yearly',
  lifetime: 'Lifetime',
};

/** One glyph per plan: the renewal day, one orbit of the sun, no end. */
const PLAN_ICONS: Record<BillingPeriod, IconName> = {
  monthly: 'calendar',
  annual: 'orbit',
  lifetime: 'infinity',
};

/** The unit the store amount is quoted in, set small beside it. */
const PLAN_UNITS: Record<BillingPeriod, string> = {
  monthly: '/mo',
  annual: '/yr',
  lifetime: 'once',
};

/** The recommended plan: first in the list and the one ink card on the chalk
 * page — the dark "Pro" tile beside the white standard models — and
 * pre-selected by the store. */
const RECOMMENDED_PERIOD: BillingPeriod = 'monthly';

/** Top-to-bottom order of the plan rows, the recommended plan first. */
const PLAN_ORDER: readonly BillingPeriod[] = ['monthly', 'annual', 'lifetime'];

/** The one line under a plan's name; every number in it is the store's. */
function planDetail(plan: StorePlan): string {
  if (plan.period === 'lifetime') return 'One-time purchase · no renewal';
  if (plan.period === 'annual') {
    return plan.pricePerMonthString
      ? `${plan.pricePerMonthString}/mo · billed yearly`
      : 'Billed yearly';
  }
  return 'Billed monthly · cancel anytime';
}

/** Restates the selected plan in plain words; prices come from the store. */
function selectedPlanSummary(plan: StorePlan): string {
  if (plan.period === 'lifetime') {
    return `Lifetime · ${plan.priceString} one-time payment. No renewal, no subscription.`;
  }
  return `${PLAN_TITLES[plan.period]} · ${plan.priceString} per ${periodLabel(
    plan.period,
  )}, auto-renews. Cancel anytime.`;
}

function PlanRow(props: {
  plan: StorePlan;
  selected: boolean;
  /** The recommended plan: the one ink card, with the volt badge on its
   * shoulder; every other row is a white card. */
  hero?: boolean;
  heroBadge?: string | null;
  /** A quiet fact beside the name (the yearly saving, from store prices). */
  chip?: string | null;
  accessibleLayout: boolean;
  onNeedsWideLayout: () => void;
  onPress: () => void;
}) {
  const { plan, selected, hero } = props;
  const priceA11y =
    plan.period === 'lifetime'
      ? `${plan.priceString} one-time`
      : `${plan.priceString} per ${periodLabel(plan.period)}`;
  const ink = hero ? styles.onHero : styles.onPlan;
  const muted = hero ? styles.onHeroMuted : styles.onPlanMuted;
  return (
    <PressableScale
      testID={`paywall-plan-${plan.period}`}
      onPress={props.onPress}
      accessibilityLabel={`${
        PLAN_TITLES[plan.period]
      } membership, ${priceA11y}${selected ? ', selected' : ''}`}
      accessibilityState={{ selected }}
      style={[
        styles.planCard,
        hero ? styles.planCardHero : styles.planCardPlan,
        selected &&
          (hero ? styles.planCardHeroSelected : styles.planCardPlanSelected),
        props.accessibleLayout && styles.planCardAccessible,
      ]}
    >
      {hero && props.heroBadge ? (
        <View
          pointerEvents="none"
          style={[
            styles.heroBadge,
            props.accessibleLayout && styles.heroBadgeAccessible,
          ]}
        >
          <Icon name="spark" size={11} strokeWidth={2.4} color={color.onVolt} />
          <Text style={styles.heroBadgeText}>{props.heroBadge}</Text>
        </View>
      ) : null}
      <View
        style={[
          styles.planRow,
          props.accessibleLayout && styles.planRowStacked,
        ]}
      >
        <View style={styles.planCopy}>
          <View style={styles.planTitleRow}>
            <Icon
              name={PLAN_ICONS[plan.period]}
              size={16}
              strokeWidth={2}
              color={hero ? color.onDarkMuted : color.inkSoft}
            />
            <Text style={[styles.planTitle, ink]}>
              {PLAN_TITLES[plan.period]}
            </Text>
            {props.chip ? (
              <View style={styles.planChip}>
                <Text style={styles.planChipText}>{props.chip}</Text>
              </View>
            ) : null}
          </View>
          <Text
            style={[styles.planDetail, muted]}
            testID={`paywall-plan-${plan.period}-qualifier`}
          >
            {planDetail(plan)}
          </Text>
          {plan.freeTrial ? (
            <Text
              style={[styles.planTrial, ink]}
              testID={`paywall-plan-${plan.period}-trial`}
            >
              {plan.freeTrial.label}
            </Text>
          ) : null}
        </View>
        <View
          style={[
            styles.planPrice,
            props.accessibleLayout && styles.planPriceStacked,
          ]}
        >
          <Text
            style={[
              styles.planAmount,
              hero
                ? selected
                  ? styles.planAmountHeroSelected
                  : styles.planAmountHero
                : styles.planAmountPlan,
            ]}
            adjustsFontSizeToFit={false}
            testID={`paywall-plan-${plan.period}-price`}
            onTextLayout={event => {
              if (
                !props.accessibleLayout &&
                event.nativeEvent.lines.length > 1
              ) {
                props.onNeedsWideLayout();
              }
            }}
          >
            {plan.priceString}
          </Text>
          <Text style={[styles.planUnit, muted]}>
            {PLAN_UNITS[plan.period]}
          </Text>
        </View>
      </View>
    </PressableScale>
  );
}

function BenefitRow(props: (typeof BENEFITS)[number]) {
  return (
    <View style={styles.benefitRow}>
      <View style={styles.benefitIcon}>
        <Icon name={props.icon} color={color.ink} size={18} />
      </View>
      <View style={styles.benefitCopy}>
        <Text style={styles.benefitTitle}>{props.title}</Text>
        <Text style={styles.benefitBody}>{props.body}</Text>
      </View>
    </View>
  );
}

export function PaywallScreen(props: PaywallScreenProps) {
  const insets = useReliableSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const [widePrices, setWidePrices] = useState(false);
  const accessibleLayout = useWindowDimensions().fontScale > 1.3 || widePrices;
  const useWidePrices = useCallback(() => setWidePrices(true), []);
  const accessState = useAccessStore();
  const {
    status,
    operation,
    plans,
    selectedPeriod,
    canonicalAccess,
    fulfilmentStatus,
    reconciliation,
    error: accessError,
    initialize,
    selectPeriod,
    purchaseSelected,
    restorePurchases,
    retryPendingFulfilment,
    reconcileBilling,
    clearError,
  } = accessState;
  const premium = useAccessStore(selectHasPremium);
  const pendingRecovery = useAccessStore(selectNeedsFulfilmentRecovery);
  const recoveryRequired =
    pendingRecovery ||
    reconciliation.status === 'unavailable' ||
    reconciliation.status === 'checking';
  const membership = selectMembershipState(accessState);
  const hero = membershipHeroCopy(membership, recoveryRequired);
  // A purchase the server has not settled is never re-offered: while it is
  // pending or on hold the pricing page carries no plan or price at all.
  const offerWithheld =
    membership.kind === 'pending' || membership.kind === 'hold';
  const error = accessError ?? reconciliation.error;
  const mounted = useRef(true);
  const pricingRequested = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Two-step flow: page 1 sells the value, page 2 (one deliberate tap later)
  // shows store-verified pricing. Entering content slides/fades in 220ms
  // with the native driver; reduced motion keeps both pages at rest.
  const [page, setPage] = useState<PaywallPage>('value');
  const pageRef = useRef<PaywallPage>('value');
  const pageOpacity = useRef(new Animated.Value(1)).current;
  const pageShift = useRef(new Animated.Value(0)).current;

  const transitionTo = useCallback(
    (next: PaywallPage) => {
      if (pageRef.current === next) return;
      pageRef.current = next;
      if (reducedMotion) {
        pageOpacity.setValue(1);
        pageShift.setValue(0);
        setPage(next);
        return;
      }
      pageOpacity.setValue(0);
      pageShift.setValue(next === 'pricing' ? 28 : -28);
      Animated.parallel([
        Animated.timing(pageOpacity, {
          toValue: 1,
          duration: 220,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(pageShift, {
          toValue: 0,
          duration: 220,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start();
      setPage(next);
    },
    [pageOpacity, pageShift, reducedMotion],
  );

  useEffect(() => {
    if (reducedMotion) {
      pageOpacity.setValue(1);
      pageShift.setValue(0);
    }
  }, [pageOpacity, pageShift, reducedMotion]);

  useEffect(() => {
    if (operation !== 'idle' || status === 'loading' || premium) return;
    if (
      status === 'idle' ||
      (status === 'ready' && !plans && !pricingRequested.current)
    ) {
      pricingRequested.current = true;
      void initialize();
    }
  }, [initialize, operation, plans, premium, status]);

  // Hardware back on the pricing page returns to the value page instead of
  // dismissing the paywall (predictable step-back navigation).
  useEffect(() => {
    if (page !== 'pricing') return;
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        transitionTo('value');
        return true;
      },
    );
    return () => subscription.remove();
  }, [page, transitionTo]);

  const selectedPlan =
    selectedPeriod === 'annual'
      ? plans?.annual
      : selectedPeriod === 'lifetime'
        ? plans?.lifetime
        : plans?.monthly;
  const busy = operation !== 'idle' || status === 'loading';
  const annualSavings = savingsLabel(
    plans?.annual ?? null,
    plans?.monthly ?? null,
  );
  // "RECOMMENDED" is a choice between plans; a lone plan carries no badge.
  const planCount = plans
    ? PLAN_ORDER.filter(period => plans[period]).length
    : 0;
  const ctaSuffix: Record<BillingPeriod, string> = {
    monthly: '/mo',
    annual: '/yr',
    lifetime: ' once',
  };
  const purchaseLabel = recoveryRequired
    ? 'Membership verification pending'
    : selectedPlan?.freeTrial
      ? 'Start free trial'
      : selectedPlan
        ? `Continue · ${selectedPlan.priceString}${ctaSuffix[selectedPlan.period]}`
        : 'Store pricing unavailable';
  const canPurchase = Boolean(
    selectedPlan &&
    canonicalAccess &&
    fulfilmentStatus === 'clear' &&
    !recoveryRequired,
  );
  const showRetry =
    status !== 'loading' &&
    (recoveryRequired || !plans || canonicalAccess === null);

  const purchase = async () => {
    const verified = await purchaseSelected();
    if (verified && mounted.current) props.onPurchased?.();
  };

  const restore = async () => {
    const verified = await restorePurchases();
    if (verified && mounted.current) props.onPurchased?.();
  };

  const retry = async () => {
    if (selectNeedsFulfilmentRecovery(useAccessStore.getState())) {
      const verified = await retryPendingFulfilment();
      if (verified && mounted.current) props.onPurchased?.();
    } else if (
      useAccessStore.getState().reconciliation.status === 'unavailable' ||
      useAccessStore.getState().reconciliation.status === 'checking'
    ) {
      const verified = await reconcileBilling({ force: true });
      if (verified && mounted.current) props.onPurchased?.();
    } else {
      await initialize();
    }
  };

  if (premium) {
    return (
      <View style={styles.screen}>
        <View style={[styles.screen, { paddingBottom: insets.bottom }]}>
          <StatusBar barStyle="dark-content" />
          <View
            style={[
              styles.activeHeader,
              { paddingTop: Math.max(insets.top, space.md) },
            ]}
          >
            <PressableScale
              onPress={props.onClose}
              accessibilityLabel="Close membership"
              style={styles.closeButton}
            >
              <Icon name="close" size={22} color={color.ink} />
            </PressableScale>
          </View>
          <View style={styles.activeBody}>
            <View style={styles.crownBadge}>
              <Icon name="crown" size={28} color={color.ink} />
            </View>
            <Text style={styles.activeEyebrow}>{membership.eyebrow}</Text>
            <Text style={styles.activeTitle}>{membership.title}</Text>
            <Text style={styles.activeSub}>{membership.detail}</Text>
            <PressableScale
              onPress={props.onClose}
              accessibilityLabel="Continue coaching"
              style={styles.primaryButton}
            >
              <Text style={styles.primaryButtonText}>Continue coaching</Text>
              <Icon name="arrow" color={color.onDark} size={20} />
            </PressableScale>
            {membership.retryAllowed ? (
              <PressableScale
                testID="paywall-retry"
                onPress={() => void retry()}
                accessibilityLabel="Retry membership verification"
                disabled={busy}
                style={styles.secondaryButton}
              >
                <Text style={styles.secondaryButtonText}>
                  Retry verification
                </Text>
              </PressableScale>
            ) : null}
            {membership.manageSubscription ? (
              <PressableScale
                testID="paywall-manage-subscription"
                onPress={() => void openSubscriptionManagement()}
                accessibilityLabel="Manage subscription in the App Store"
                style={styles.secondaryButton}
              >
                <Text style={styles.secondaryButtonText}>
                  Manage subscription
                </Text>
              </PressableScale>
            ) : null}
          </View>
        </View>
      </View>
    );
  }

  const allowanceCopy = freeRatingAllowanceCopy(canonicalAccess);
  const onPricingPage = page === 'pricing';

  return (
    <View style={styles.screen}>
      <View style={[styles.screen, { paddingBottom: insets.bottom }]}>
        <StatusBar barStyle="dark-content" />
        <View
          style={[
            styles.topBar,
            { paddingTop: Math.max(insets.top, space.md) },
          ]}
        >
          {onPricingPage ? (
            <PressableScale
              testID="paywall-back"
              onPress={() => transitionTo('value')}
              accessibilityLabel="Back to membership benefits"
              style={styles.closeButton}
            >
              <Icon name="back" size={20} color={color.ink} />
            </PressableScale>
          ) : (
            <View style={styles.wordmarkRow}>
              <BrandMark compact size={24} />
              <Text style={styles.wordmark}>PICKLE SENSEI</Text>
            </View>
          )}
          <PressableScale
            onPress={props.onClose}
            accessibilityLabel="Close membership offer"
            style={styles.closeButton}
          >
            <Icon name="close" size={22} color={color.ink} />
          </PressableScale>
        </View>

        <View
          style={styles.stepDots}
          accessibilityLabel={onPricingPage ? 'Step 2 of 2' : 'Step 1 of 2'}
        >
          <View
            style={[styles.stepDot, !onPricingPage && styles.stepDotActive]}
          />
          <View
            style={[styles.stepDot, onPricingPage && styles.stepDotActive]}
          />
        </View>

        <Animated.View
          testID="paywall-page-body"
          style={[
            styles.pageBody,
            { opacity: pageOpacity, transform: [{ translateX: pageShift }] },
          ]}
        >
          {onPricingPage ? (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={[
                styles.content,
                accessibleLayout && styles.pricingContentAccessible,
              ]}
              showsVerticalScrollIndicator={false}
            >
              <View style={styles.hero}>
                <Text style={styles.eyebrow}>
                  {hero?.eyebrow ?? 'STORE-VERIFIED PRICING'}
                </Text>
                <Text style={styles.title}>
                  {hero?.title ?? 'Choose your plan.'}
                </Text>
                <Text style={styles.subtitle}>
                  {hero?.detail ??
                    `${allowanceCopy} Every price below comes from your app store — never an estimate.`}
                </Text>
              </View>

              <View style={styles.plans}>
                {plans && !offerWithheld ? (
                  <View testID="paywall-plan-options" style={styles.planList}>
                    {PLAN_ORDER.map(period => {
                      const plan = plans[period];
                      if (!plan) return null;
                      const recommended = period === RECOMMENDED_PERIOD;
                      return (
                        <PlanRow
                          key={period}
                          accessibleLayout={accessibleLayout}
                          onNeedsWideLayout={useWidePrices}
                          plan={plan}
                          selected={selectedPeriod === period}
                          hero={recommended}
                          heroBadge={
                            recommended && planCount > 1 ? 'RECOMMENDED' : null
                          }
                          chip={period === 'annual' ? annualSavings : null}
                          onPress={() => selectPeriod(period)}
                        />
                      );
                    })}
                  </View>
                ) : null}

                {selectedPlan && !offerWithheld ? (
                  <Text style={styles.selectedSummary}>
                    {selectedPlanSummary(selectedPlan)}
                  </Text>
                ) : null}

                {status === 'loading' && !plans && !offerWithheld ? (
                  <View
                    accessibilityRole="progressbar"
                    accessibilityLabel="Loading App Store pricing"
                    style={styles.loadingCard}
                  >
                    <BrandSpinner color={color.court} trackColor={color.line} />
                    <Text style={styles.loadingText}>
                      Loading secure store pricing…
                    </Text>
                  </View>
                ) : null}

                {!plans && status !== 'loading' && !offerWithheld ? (
                  <View style={styles.unavailableCard}>
                    <Icon name="shield" color={color.ink} size={22} />
                    <View style={styles.unavailableCopy}>
                      <Text style={styles.unavailableTitle}>
                        Store pricing is unavailable
                      </Text>
                      <Text style={styles.unavailableBody}>
                        We couldn’t load a verified App Store offer. Try
                        again—no estimated price will be shown.
                      </Text>
                    </View>
                  </View>
                ) : null}
              </View>

              {error ? (
                <PressableScale
                  onPress={clearError}
                  accessibilityLabel="Dismiss membership message"
                  accessibilityHint={error.message}
                  accessibilityLiveRegion="assertive"
                  style={styles.errorCard}
                >
                  <Icon name="shield" color={color.inkSoft} size={18} />
                  <Text accessibilityRole="alert" style={styles.errorText}>
                    {error.message}
                  </Text>
                </PressableScale>
              ) : null}

              {showRetry ? (
                <PressableScale
                  testID="paywall-retry"
                  onPress={() => void retry()}
                  accessibilityLabel={
                    recoveryRequired
                      ? 'Retry membership verification'
                      : 'Retry loading membership'
                  }
                  disabled={busy}
                  style={styles.secondaryButton}
                >
                  <Text style={styles.secondaryButtonText}>Try again</Text>
                </PressableScale>
              ) : null}

              <PressableScale
                testID="paywall-continue"
                onPress={() => void purchase()}
                accessibilityLabel={purchaseLabel}
                disabled={!canPurchase || busy}
                style={styles.primaryButton}
              >
                {operation === 'purchasing' || operation === 'syncing' ? (
                  <BrandSpinner
                    color={color.onDark}
                    trackColor={color.lineStrongDark}
                  />
                ) : (
                  <>
                    <Text style={styles.primaryButtonText}>
                      {purchaseLabel}
                    </Text>
                    <Icon name="arrow" color={color.onDark} size={20} />
                  </>
                )}
              </PressableScale>

              <PressableScale
                testID="paywall-restore"
                onPress={() => void restore()}
                accessibilityLabel="Restore purchases"
                disabled={busy || recoveryRequired}
                style={styles.restoreButton}
              >
                {operation === 'restoring' ? (
                  <BrandSpinner color={color.ink} trackColor={color.line} />
                ) : (
                  <Text style={styles.restoreText}>Restore purchases</Text>
                )}
              </PressableScale>

              <View style={styles.trustRow}>
                <Icon name="shield" color={color.inkSoft} size={17} />
                <Text style={styles.trustText}>
                  Purchase and renewal are confirmed by your app store. Cancel
                  in your store account settings.
                </Text>
              </View>

              {selectedPlan && !offerWithheld ? (
                <Text style={styles.legalText}>
                  {selectedPlan.period === 'lifetime'
                    ? `${selectedPlan.priceString} one-time purchase. Not a subscription — no renewal.`
                    : `${
                        selectedPlan.freeTrial
                          ? `After the ${selectedPlan.freeTrial.label}, `
                          : ''
                      }${selectedPlan.priceString} per ${periodLabel(
                        selectedPlan.period,
                      )}, automatically renewing until canceled.`}
                </Text>
              ) : null}

              {props.onOpenTerms || props.onOpenPrivacy ? (
                <View style={styles.legalLinks}>
                  {props.onOpenTerms ? (
                    <PressableScale
                      onPress={props.onOpenTerms}
                      accessibilityLabel="Terms of use"
                      accessibilityRole="link"
                      style={styles.legalLink}
                    >
                      <Text style={styles.legalLinkText}>Terms</Text>
                    </PressableScale>
                  ) : null}
                  {props.onOpenPrivacy ? (
                    <PressableScale
                      onPress={props.onOpenPrivacy}
                      accessibilityLabel="Privacy policy"
                      accessibilityRole="link"
                      style={styles.legalLink}
                    >
                      <Text style={styles.legalLinkText}>Privacy</Text>
                    </PressableScale>
                  ) : null}
                </View>
              ) : null}
            </ScrollView>
          ) : (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.content}
              showsVerticalScrollIndicator={false}
            >
              <View style={styles.hero}>
                <View style={styles.crownBadge}>
                  <Icon name="crown" size={27} color={color.ink} />
                </View>
                <Text style={styles.eyebrow}>
                  {hero?.eyebrow ?? FREE_PLAY_EYEBROW}
                </Text>
                <Text style={styles.title}>
                  {hero?.title ?? 'A coach for every stroke.'}
                </Text>
                <Text style={styles.subtitle}>
                  {hero?.detail ??
                    `${allowanceCopy} Membership keeps scoring, practice, and progress moving together.`}
                </Text>
                <Text style={styles.ratingRule}>{RATING_CONSUMPTION_RULE}</Text>
              </View>

              {recoveryRequired ? (
                <PressableScale
                  testID="paywall-retry"
                  onPress={() => void retry()}
                  accessibilityLabel="Retry membership verification"
                  disabled={busy}
                  style={styles.secondaryButton}
                >
                  <Text style={styles.secondaryButtonText}>
                    Retry verification
                  </Text>
                </PressableScale>
              ) : (
                <View style={styles.benefits}>
                  {BENEFITS.map(benefit => (
                    <BenefitRow key={benefit.title} {...benefit} />
                  ))}
                </View>
              )}

              <PressableScale
                testID="paywall-see-plans"
                onPress={() => transitionTo('pricing')}
                accessibilityLabel={
                  recoveryRequired
                    ? 'View membership details'
                    : 'See membership plans'
                }
                style={styles.primaryButton}
              >
                <Text style={styles.primaryButtonText}>
                  {recoveryRequired
                    ? 'View membership details'
                    : 'See membership plans'}
                </Text>
                <Icon name="arrow" color={color.onDark} size={20} />
              </PressableScale>

              <View style={styles.trustRow}>
                <Icon name="shield" color={color.inkSoft} size={17} />
                <Text style={styles.trustText}>
                  Store-verified pricing on the next step. Purchases are handled
                  by your app store — cancel anytime.
                </Text>
              </View>
            </ScrollView>
          )}
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  topBar: {
    minHeight: 64,
    paddingHorizontal: space.md,
    paddingBottom: space.xs,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  wordmarkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: space.sm,
  },
  wordmark: {
    ...type.micro,
    color: color.ink,
    letterSpacing: 1.25,
  },
  closeButton: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surfaceAlt,
  },
  scroll: { flex: 1 },
  pageBody: { flex: 1 },
  stepDots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    paddingBottom: space.xs,
  },
  stepDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: color.line,
  },
  stepDotActive: {
    width: 18,
    backgroundColor: color.ink,
  },
  content: {
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xl,
  },
  hero: { alignItems: 'center' },
  crownBadge: {
    width: 56,
    height: 56,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surfaceAlt,
  },
  eyebrow: {
    ...type.micro,
    color: color.inkSoft,
    marginTop: space.md,
    textAlign: 'center',
  },
  title: {
    ...type.h1,
    color: color.ink,
    textAlign: 'center',
    marginTop: space.sm,
    maxWidth: 410,
  },
  subtitle: {
    ...type.body,
    color: color.inkSoft,
    textAlign: 'center',
    marginTop: space.sm,
    maxWidth: 440,
  },
  ratingRule: {
    ...type.caption,
    color: color.inkSoft,
    textAlign: 'center',
    marginTop: space.sm,
    maxWidth: 420,
  },
  benefits: {
    alignSelf: 'stretch',
    marginTop: space.lg,
  },
  benefitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm + space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.line,
  },
  benefitIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surfaceAlt,
  },
  benefitCopy: { flex: 1 },
  benefitTitle: { ...type.bodyBold, color: color.ink },
  benefitBody: { ...type.caption, color: color.inkSoft, marginTop: 2 },
  plans: { marginTop: space.lg, gap: space.sm + space.xs },
  // Full-width plan rows, the recommended plan first. Always a column, so
  // localized amounts have the whole card; the row inside each card stacks
  // when text is large or an amount wraps.
  planList: {
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: space.sm + space.xs,
  },
  pricingContentAccessible: { paddingHorizontal: space.md },
  planCard: {
    minHeight: 88,
    borderRadius: radius.lg,
    borderWidth: 2,
    paddingVertical: space.md + space.xs,
    paddingHorizontal: space.md + space.xs,
    justifyContent: 'center',
  },
  planCardAccessible: { paddingHorizontal: space.sm },
  // Sibling plans: white cards on chalk; ink-edged when chosen.
  planCardPlan: {
    backgroundColor: membership.plan,
    borderColor: membership.planLine,
  },
  planCardPlanSelected: { borderColor: membership.planSelectedLine },
  // The recommended plan: the one ink card; volt-edged when chosen.
  planCardHero: {
    minHeight: 100,
    backgroundColor: membership.hero,
    borderColor: membership.hero,
  },
  planCardHeroSelected: { borderColor: membership.heroSelectedLine },
  heroBadge: {
    position: 'absolute',
    top: -12,
    right: space.md + space.xs,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    backgroundColor: color.volt,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
    zIndex: 2,
  },
  heroBadgeAccessible: {
    position: 'relative',
    top: 0,
    right: 0,
    alignSelf: 'flex-start',
    marginBottom: space.sm,
  },
  heroBadgeText: { ...type.micro, color: color.onVolt },
  planRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  planRowStacked: {
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: space.sm,
  },
  planCopy: { flex: 1, minWidth: 0 },
  planTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    flexWrap: 'wrap',
  },
  planTitle: { ...type.h3 },
  planDetail: { ...type.caption, marginTop: 3 },
  planTrial: { ...type.caption, marginTop: 3 },
  planChip: {
    backgroundColor: color.courtSoft,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  planChipText: { ...type.micro, color: color.courtDeep },
  planPrice: { alignItems: 'flex-end', flexShrink: 0 },
  planPriceStacked: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.xs,
  },
  planAmount: {
    ...type.h2,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
  planAmountPlan: { color: color.ink },
  planAmountHero: { ...type.score, color: color.onDark },
  planAmountHeroSelected: { ...type.score, color: color.volt },
  planUnit: { ...type.caption },
  onPlan: { color: color.ink },
  onPlanMuted: { color: color.inkSoft },
  onHero: { color: color.onDark },
  onHeroMuted: { color: color.onDarkMuted },
  selectedSummary: {
    ...type.caption,
    color: color.inkSoft,
    textAlign: 'center',
  },
  loadingCard: {
    minHeight: 96,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: space.sm,
  },
  loadingText: { ...type.caption, color: color.inkSoft },
  unavailableCard: {
    minHeight: 96,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.surfaceElevated,
    padding: space.md,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
  },
  unavailableCopy: { flex: 1 },
  unavailableTitle: { ...type.bodyBold, color: color.ink },
  unavailableBody: { ...type.caption, color: color.inkSoft, marginTop: 3 },
  errorCard: {
    minHeight: 44,
    marginTop: space.md,
    padding: space.md,
    borderRadius: radius.md,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    backgroundColor: color.surfaceElevated,
    borderWidth: 1,
    borderColor: color.line,
  },
  errorText: { ...type.caption, color: color.ink, flex: 1 },
  primaryButton: {
    minHeight: 58,
    marginTop: space.md,
    borderRadius: radius.pill,
    backgroundColor: color.ink,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  primaryButtonText: {
    ...type.bodyBold,
    color: color.onDark,
    flexShrink: 1,
    textAlign: 'center',
  },
  secondaryButton: {
    minHeight: 52,
    marginTop: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.surfaceElevated,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    ...type.bodyBold,
    color: color.ink,
    textAlign: 'center',
  },
  restoreButton: {
    minHeight: 48,
    marginTop: space.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  restoreText: { ...type.bodyBold, color: color.inkSoft },
  trustRow: {
    marginTop: space.md,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: space.sm,
    paddingHorizontal: space.sm,
  },
  trustText: {
    ...type.caption,
    color: color.inkSoft,
    flexShrink: 1,
    maxWidth: 390,
  },
  legalText: {
    ...type.caption,
    color: color.inkSoft,
    textAlign: 'center',
    marginTop: space.md,
    paddingHorizontal: space.md,
  },
  legalLinks: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: space.sm,
    marginTop: space.sm,
  },
  legalLink: {
    minWidth: 64,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  legalLinkText: {
    ...type.caption,
    color: color.ink,
    textDecorationLine: 'underline',
  },
  activeHeader: {
    alignItems: 'flex-end',
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
  },
  activeBody: {
    flex: 1,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activeEyebrow: {
    ...type.micro,
    color: color.inkSoft,
    marginTop: space.lg,
    textAlign: 'center',
  },
  activeTitle: {
    ...type.h1,
    color: color.ink,
    textAlign: 'center',
    marginTop: space.sm,
  },
  activeSub: {
    ...type.body,
    color: color.inkSoft,
    textAlign: 'center',
    maxWidth: 390,
    marginTop: space.sm,
  },
});
