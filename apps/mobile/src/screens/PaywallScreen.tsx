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
import { color, radius, space, type } from '../design/tokens';
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
    icon: 'stroke',
    title: 'Unlimited technique analyses',
    body: 'Automatic capture with replay and checkpoint feedback.',
  },
  {
    icon: 'court',
    title: 'Coaching that follows evidence',
    body: 'When reviewed work exists, a server-accepted score sets its priority and reassessment baseline.',
  },
  {
    icon: 'progress',
    title: 'Rank and progress from real scores',
    body: 'Player rank and trends built from your saved analysis results.',
  },
  {
    icon: 'bookmark',
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

const PODIUM_TITLES: Record<BillingPeriod, string> = {
  monthly: 'Monthly',
  annual: 'Yearly',
  lifetime: 'Lifetime',
};

/** Winners'-podium column heights: yearly tallest, lifetime second, monthly third. */
const PODIUM_HEIGHTS: Record<BillingPeriod, number> = {
  monthly: 148,
  annual: 188,
  lifetime: 158,
};

function podiumQualifier(plan: StorePlan): string {
  if (plan.period === 'lifetime') return 'one-time · no recurring fee';
  if (plan.period === 'annual') {
    return plan.pricePerMonthString
      ? `${plan.pricePerMonthString}/mo · billed yearly`
      : '/year · billed yearly';
  }
  return '/month · billed monthly';
}

/** Restates the selected plan in plain words; prices come from the store. */
function selectedPlanSummary(plan: StorePlan): string {
  if (plan.period === 'lifetime') {
    return `Lifetime · ${plan.priceString} one-time payment. No renewal, no subscription.`;
  }
  return `${PODIUM_TITLES[plan.period]} · ${plan.priceString} per ${periodLabel(
    plan.period,
  )}, auto-renews. Cancel anytime.`;
}

function PodiumColumn(props: {
  plan: StorePlan;
  selected: boolean;
  /** The recommended plan: wider, with a straddling value badge. */
  hero?: boolean;
  heroBadge?: string | null;
  chip?: string | null;
  chipTone?: 'volt' | 'dark';
  accessibleLayout: boolean;
  onNeedsWideLayout: () => void;
  onPress: () => void;
}) {
  const { plan, selected, hero } = props;
  const priceA11y =
    plan.period === 'lifetime'
      ? `${plan.priceString} one-time`
      : `${plan.priceString} per ${periodLabel(plan.period)}`;
  return (
    <View
      style={[
        styles.podiumColumn,
        hero && styles.podiumColumnHero,
        props.accessibleLayout && styles.podiumColumnAccessible,
      ]}
    >
      <PressableScale
        testID={`paywall-plan-${plan.period}`}
        onPress={props.onPress}
        accessibilityLabel={`${
          PODIUM_TITLES[plan.period]
        } membership, ${priceA11y}${selected ? ', selected' : ''}`}
        accessibilityState={{ selected }}
        style={[
          styles.podiumCard,
          { minHeight: PODIUM_HEIGHTS[plan.period] },
          hero && styles.podiumCardHero,
          selected && styles.podiumCardSelected,
          props.accessibleLayout && styles.podiumCardAccessible,
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
            <View
              style={[
                styles.heroBadgePill,
                props.accessibleLayout && styles.badgePillAccessible,
              ]}
            >
              <Text style={styles.heroBadgeText}>{props.heroBadge}</Text>
            </View>
          </View>
        ) : null}
        <View
          style={[styles.podiumRadio, selected && styles.podiumRadioSelected]}
        >
          {selected ? (
            <Icon name="check" size={12} color={color.onVolt} />
          ) : null}
        </View>
        <Text style={styles.podiumTitle}>{PODIUM_TITLES[plan.period]}</Text>
        <Text
          style={styles.podiumPrice}
          adjustsFontSizeToFit={false}
          testID={`paywall-plan-${plan.period}-price`}
          onTextLayout={event => {
            if (!props.accessibleLayout && event.nativeEvent.lines.length > 1) {
              props.onNeedsWideLayout();
            }
          }}
        >
          {plan.priceString}
        </Text>
        <Text
          style={styles.podiumQualifier}
          testID={`paywall-plan-${plan.period}-qualifier`}
        >
          {podiumQualifier(plan)}
        </Text>
        {props.chip ? (
          <View
            style={[
              styles.podiumChip,
              props.chipTone === 'dark'
                ? styles.podiumChipDark
                : styles.podiumChipVolt,
            ]}
          >
            <Text
              style={[
                styles.podiumChipText,
                props.chipTone === 'dark'
                  ? styles.podiumChipTextDark
                  : styles.podiumChipTextVolt,
              ]}
            >
              {props.chip}
            </Text>
          </View>
        ) : null}
        {plan.freeTrial ? (
          <Text
            style={styles.trialText}
            testID={`paywall-plan-${plan.period}-trial`}
          >
            {plan.freeTrial.label}
          </Text>
        ) : null}
      </PressableScale>
    </View>
  );
}

function BenefitRow(props: (typeof BENEFITS)[number]) {
  return (
    <View style={styles.benefitRow}>
      <View style={styles.benefitIcon}>
        <Icon name={props.icon} color={color.onDarkMuted} size={18} />
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
          <StatusBar barStyle="light-content" />
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
              <Icon name="close" size={22} color={color.onDark} />
            </PressableScale>
          </View>
          <View style={styles.activeBody}>
            <View style={styles.crownBadge}>
              <Icon name="crown" size={28} color={color.onDarkMuted} />
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
              <Icon name="arrow" color={color.onVolt} size={20} />
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
        <StatusBar barStyle="light-content" />
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
              <Icon name="back" size={20} color={color.onDark} />
            </PressableScale>
          ) : (
            <View style={styles.wordmarkRow}>
              <BrandMark compact light size={24} />
              <Text style={styles.wordmark}>PICKLE SENSEI</Text>
            </View>
          )}
          <PressableScale
            onPress={props.onClose}
            accessibilityLabel="Close membership offer"
            style={styles.closeButton}
          >
            <Icon name="close" size={22} color={color.onDark} />
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
                  <View
                    testID="paywall-plan-options"
                    style={[
                      styles.podiumRow,
                      accessibleLayout && styles.podiumRowAccessible,
                    ]}
                  >
                    {plans.monthly ? (
                      <PodiumColumn
                        accessibleLayout={accessibleLayout}
                        onNeedsWideLayout={useWidePrices}
                        plan={plans.monthly}
                        selected={selectedPeriod === 'monthly'}
                        onPress={() => selectPeriod('monthly')}
                      />
                    ) : null}
                    {plans.annual ? (
                      <PodiumColumn
                        accessibleLayout={accessibleLayout}
                        onNeedsWideLayout={useWidePrices}
                        plan={plans.annual}
                        selected={selectedPeriod === 'annual'}
                        hero
                        heroBadge="BEST VALUE"
                        chip={annualSavings}
                        onPress={() => selectPeriod('annual')}
                      />
                    ) : null}
                    {plans.lifetime ? (
                      <PodiumColumn
                        accessibleLayout={accessibleLayout}
                        onNeedsWideLayout={useWidePrices}
                        plan={plans.lifetime}
                        selected={selectedPeriod === 'lifetime'}
                        chip="PAY ONCE"
                        chipTone="dark"
                        onPress={() => selectPeriod('lifetime')}
                      />
                    ) : null}
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
                    <BrandSpinner
                      color={color.volt}
                      trackColor={color.lineDark}
                    />
                    <Text style={styles.loadingText}>
                      Loading secure store pricing…
                    </Text>
                  </View>
                ) : null}

                {!plans && status !== 'loading' && !offerWithheld ? (
                  <View style={styles.unavailableCard}>
                    <Icon name="shield" color={color.onDark} size={22} />
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
                  <Icon name="shield" color={color.onDarkMuted} size={18} />
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
                  <BrandSpinner color={color.onVolt} trackColor={color.court} />
                ) : (
                  <>
                    <Text style={styles.primaryButtonText}>
                      {purchaseLabel}
                    </Text>
                    <Icon name="arrow" color={color.onVolt} size={20} />
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
                  <BrandSpinner
                    color={color.onDark}
                    trackColor={color.lineStrongDark}
                  />
                ) : (
                  <Text style={styles.restoreText}>Restore purchases</Text>
                )}
              </PressableScale>

              <View style={styles.trustRow}>
                <Icon name="shield" color={color.onDarkMuted} size={17} />
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
                  <Icon name="crown" size={27} color={color.onDarkMuted} />
                </View>
                <Text style={styles.eyebrow}>
                  {hero?.eyebrow ?? 'PLAY PAST THE FIRST TWO'}
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
                <Icon name="arrow" color={color.onVolt} size={20} />
              </PressableScale>

              <View style={styles.trustRow}>
                <Icon name="shield" color={color.onDarkMuted} size={17} />
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
  screen: { flex: 1, backgroundColor: color.surfaceDark },
  topBar: {
    minHeight: 64,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  wordmarkRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  wordmark: {
    ...type.micro,
    color: color.onDark,
    letterSpacing: 1.25,
  },
  closeButton: {
    width: 48,
    height: 48,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.onDarkTintFaint,
    borderWidth: 1,
    borderColor: color.lineMutedDark,
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
    backgroundColor: color.lineMutedDark,
  },
  stepDotActive: {
    width: 18,
    backgroundColor: color.volt,
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
    width: 58,
    height: 58,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.inkElevated,
    borderWidth: 1,
    borderColor: color.lineDark,
  },
  eyebrow: {
    ...type.micro,
    color: color.onDarkMuted,
    marginTop: space.md,
    textAlign: 'center',
  },
  title: {
    ...type.h1,
    color: color.onDark,
    textAlign: 'center',
    marginTop: space.sm,
    maxWidth: 410,
  },
  subtitle: {
    ...type.body,
    color: color.onDarkMuted,
    textAlign: 'center',
    marginTop: space.sm,
    maxWidth: 440,
  },
  ratingRule: {
    ...type.caption,
    color: color.onDarkSubtle,
    textAlign: 'center',
    marginTop: space.sm,
    maxWidth: 420,
  },
  benefits: {
    marginTop: space.md,
    gap: space.sm,
    paddingVertical: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineDark,
  },
  benefitRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  benefitIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.onDarkTintFaint,
    borderWidth: 1,
    borderColor: color.lineDark,
  },
  benefitCopy: { flex: 1 },
  benefitTitle: { ...type.bodyBold, color: color.onDark },
  benefitBody: { ...type.caption, color: color.onDarkMuted, marginTop: 2 },
  plans: { marginTop: space.lg, gap: space.sm + space.xs },
  podiumRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    paddingTop: space.md,
  },
  podiumColumn: { flex: 1, minWidth: 0 },
  podiumColumnHero: { flex: 1.18, zIndex: 1 },
  podiumRowAccessible: {
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: space.lg,
  },
  podiumColumnAccessible: { flex: 0 },
  pricingContentAccessible: { paddingHorizontal: space.md },
  podiumCardAccessible: { paddingHorizontal: space.sm },
  heroBadgeAccessible: {
    position: 'relative',
    top: 0,
    marginBottom: space.sm,
    alignSelf: 'center',
    maxWidth: '100%',
  },
  badgePillAccessible: { borderRadius: radius.sm, maxWidth: '100%' },
  podiumCard: {
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: color.lineMutedDark,
    backgroundColor: color.onDarkTintFaint,
    paddingVertical: space.md,
    paddingHorizontal: space.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  podiumCardHero: {
    borderColor: color.lineStrongDark,
    backgroundColor: color.inkElevated,
  },
  podiumCardSelected: {
    borderColor: color.volt,
    backgroundColor: color.voltTint,
  },
  heroBadge: {
    position: 'absolute',
    top: -12,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 2,
  },
  heroBadgePill: {
    backgroundColor: color.inkElevated,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.lineStrongDark,
    paddingHorizontal: 10,
    paddingVertical: 5,
    maxWidth: '100%',
  },
  heroBadgeText: {
    ...type.micro,
    color: color.onDark,
    textAlign: 'center',
  },
  podiumRadio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: color.onDarkMuted,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.sm,
  },
  podiumRadioSelected: {
    borderColor: color.volt,
    backgroundColor: color.volt,
  },
  podiumTitle: {
    ...type.caption,
    color: color.onDarkMuted,
    textAlign: 'center',
  },
  podiumPrice: {
    ...type.h2,
    fontVariant: ['tabular-nums'],
    color: color.onDark,
    textAlign: 'center',
    alignSelf: 'stretch',
    marginTop: 2,
  },
  podiumQualifier: {
    ...type.caption,
    color: color.onDarkMuted,
    textAlign: 'center',
    alignSelf: 'stretch',
    marginTop: 3,
  },
  podiumChip: {
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    marginTop: space.sm,
    maxWidth: '100%',
  },
  podiumChipVolt: { backgroundColor: color.voltTint },
  podiumChipDark: {
    backgroundColor: color.onDarkTintFaint,
    borderWidth: 1,
    borderColor: color.lineMutedDark,
  },
  podiumChipText: { ...type.micro, textAlign: 'center' },
  podiumChipTextVolt: { color: color.volt },
  podiumChipTextDark: { color: color.onDarkMuted },
  trialText: {
    ...type.caption,
    color: color.onDark,
    textAlign: 'center',
    alignSelf: 'stretch',
    marginTop: space.xs,
  },
  selectedSummary: {
    ...type.caption,
    color: color.onDark,
    textAlign: 'center',
  },
  loadingCard: {
    minHeight: 96,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.lineMutedDark,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: space.sm,
  },
  loadingText: { ...type.caption, color: color.onDarkMuted },
  unavailableCard: {
    minHeight: 96,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.lineMutedDark,
    backgroundColor: color.onDarkTintFaint,
    padding: space.md,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
  },
  unavailableCopy: { flex: 1 },
  unavailableTitle: { ...type.bodyBold, color: color.onDark },
  unavailableBody: { ...type.caption, color: color.onDarkMuted, marginTop: 3 },
  errorCard: {
    minHeight: 44,
    marginTop: space.md,
    padding: space.md,
    borderRadius: radius.sm,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    backgroundColor: color.onDarkTintFaint,
    borderWidth: 1,
    borderColor: color.lineMutedDark,
  },
  errorText: { ...type.caption, color: color.onDark, flex: 1 },
  primaryButton: {
    minHeight: 58,
    marginTop: space.md,
    borderRadius: radius.md,
    backgroundColor: color.volt,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  primaryButtonText: {
    ...type.bodyBold,
    color: color.onVolt,
    flexShrink: 1,
    textAlign: 'center',
  },
  secondaryButton: {
    minHeight: 52,
    marginTop: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.lineMutedDark,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    ...type.bodyBold,
    color: color.onDark,
    textAlign: 'center',
  },
  restoreButton: {
    minHeight: 48,
    marginTop: space.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  restoreText: { ...type.bodyBold, color: color.onDark },
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
    color: color.onDarkMuted,
    flexShrink: 1,
    maxWidth: 390,
  },
  legalText: {
    ...type.caption,
    color: color.onDarkSubtle,
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
    color: color.onDark,
    textDecorationLine: 'underline',
  },
  activeHeader: {
    alignItems: 'flex-end',
    paddingHorizontal: space.lg,
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
    color: color.onDarkMuted,
    marginTop: space.lg,
    textAlign: 'center',
  },
  activeTitle: {
    ...type.h1,
    color: color.onDark,
    textAlign: 'center',
    marginTop: space.sm,
  },
  activeSub: {
    ...type.body,
    color: color.onDarkMuted,
    textAlign: 'center',
    maxWidth: 390,
    marginTop: space.sm,
  },
});
