import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  BackHandler,
  Easing,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import { PressableScale } from '../design/components';
import { useReliableSafeAreaInsets } from '../design/safeArea';
import { Icon, type IconName } from '../design/icons';
import { color, font, radius, shadow, space, type } from '../design/tokens';
import type { BillingPeriod, StorePlan } from '../billing/types';
import { selectHasPremium, useAccessStore } from '../state/accessStore';
import {
  freeRatingAllowanceCopy,
  RATING_CONSUMPTION_RULE,
} from './paywallCopy';

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
    icon: 'spark',
    title: 'Unlimited validated ratings',
    body: 'Automatic capture, evidence-backed checkpoints, and no invented score.',
  },
  {
    icon: 'court',
    title: 'Coaching that follows evidence',
    body: 'When reviewed work exists, a server-accepted score sets its priority and reassessment baseline.',
  },
  {
    icon: 'progress',
    title: 'Rank and progress from real scores',
    body: 'Bronze-to-Diamond player rank and trend lines built only from server-accepted analyses.',
  },
  {
    icon: 'bookmark',
    title: 'Reviewed practice, kept together',
    body: 'Published drills and rights-cleared coaching videos can be saved with the plan that prescribed them.',
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
  if (plan.period === 'lifetime') return 'one-time · yours forever';
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
  /** The recommended plan: always volt-framed, wider, with a straddling badge. */
  hero?: boolean;
  heroBadge?: string | null;
  chip?: string | null;
  chipTone?: 'volt' | 'dark';
  onPress: () => void;
}) {
  const { plan, selected, hero } = props;
  const priceA11y =
    plan.period === 'lifetime'
      ? `${plan.priceString} one-time`
      : `${plan.priceString} per ${periodLabel(plan.period)}`;
  return (
    <View style={[styles.podiumColumn, hero && styles.podiumColumnHero]}>
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
        ]}
      >
        {hero && props.heroBadge ? (
          <View pointerEvents="none" style={styles.heroBadge}>
            <View style={styles.heroBadgePill}>
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
          style={[styles.podiumPrice, hero && styles.podiumPriceHero]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.7}
        >
          {plan.priceString}
        </Text>
        <Text style={styles.podiumQualifier} numberOfLines={2}>
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
          <Text style={styles.trialText} numberOfLines={1}>
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
        <Icon name={props.icon} color={color.volt} size={18} />
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
  const {
    status,
    operation,
    plans,
    selectedPeriod,
    canonicalAccess,
    error,
    initialize,
    selectPeriod,
    purchaseSelected,
    restorePurchases,
    clearError,
  } = useAccessStore();
  const premium = useAccessStore(selectHasPremium);

  // Two-step flow: page 1 sells the value, page 2 (one deliberate tap later)
  // shows store-verified pricing. Entering content slides/fades in 220ms
  // ease-out (transform+opacity only, native driver).
  const [page, setPage] = useState<PaywallPage>('value');
  const pageOpacity = useRef(new Animated.Value(1)).current;
  const pageShift = useRef(new Animated.Value(0)).current;

  const transitionTo = useCallback(
    (next: PaywallPage) => {
      setPage(current => {
        if (current === next) return current;
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
        return next;
      });
    },
    [pageOpacity, pageShift],
  );

  useEffect(() => {
    if (status === 'idle') void initialize();
  }, [initialize, status]);

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
  const busy = operation !== 'idle';
  const annualSavings = savingsLabel(
    plans?.annual ?? null,
    plans?.monthly ?? null,
  );
  const ctaSuffix: Record<BillingPeriod, string> = {
    monthly: '/mo',
    annual: '/yr',
    lifetime: ' once',
  };
  const purchaseLabel = selectedPlan?.freeTrial
    ? 'Start free trial'
    : selectedPlan
    ? `Continue · ${selectedPlan.priceString}${ctaSuffix[selectedPlan.period]}`
    : 'Store pricing unavailable';
  const canPurchase = Boolean(selectedPlan && canonicalAccess);
  const showRetry =
    status !== 'loading' && (!plans || canonicalAccess === null);

  const purchase = async () => {
    const verified = await purchaseSelected();
    if (verified) props.onPurchased?.();
  };

  const restore = async () => {
    const verified = await restorePurchases();
    if (verified) props.onPurchased?.();
  };

  if (premium) {
    return (
      <LinearGradient
        colors={[color.surfaceDark, color.courtDeep]}
        style={styles.screen}
      >
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
            <LinearGradient
              colors={[color.volt, color.mint]}
              style={styles.crownBadge}
            >
              <Icon name="crown" size={28} color={color.onVolt} />
            </LinearGradient>
            <Text style={styles.activeEyebrow}>MEMBERSHIP VERIFIED</Text>
            <Text style={styles.activeTitle}>Your full court is open.</Text>
            <Text style={styles.activeSub}>
              Unlimited rating access is verified on this account. Published
              reviewed coaching stays tied to it.
            </Text>
            <PressableScale
              onPress={props.onClose}
              accessibilityLabel="Continue coaching"
              style={styles.primaryButton}
            >
              <Text style={styles.primaryButtonText}>Continue coaching</Text>
              <Icon name="arrow" color={color.onVolt} size={20} />
            </PressableScale>
          </View>
        </View>
      </LinearGradient>
    );
  }

  const allowanceCopy = freeRatingAllowanceCopy(canonicalAccess);
  const onPricingPage = page === 'pricing';

  return (
    <LinearGradient
      colors={[color.surfaceDark, color.inkElevated, color.courtDeep]}
      locations={[0, 0.58, 1]}
      style={styles.screen}
    >
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
              <View style={styles.miniMark} />
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
          style={[
            styles.pageBody,
            { opacity: pageOpacity, transform: [{ translateX: pageShift }] },
          ]}
        >
          {onPricingPage ? (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.content}
              showsVerticalScrollIndicator={false}
            >
              <View style={styles.hero}>
                <Text style={styles.eyebrow}>STORE-VERIFIED PRICING</Text>
                <Text style={styles.title}>Choose your plan.</Text>
                <Text style={styles.subtitle}>
                  {allowanceCopy} Every price below comes from your app store —
                  never an estimate.
                </Text>
              </View>

              <View style={styles.plans}>
                {plans ? (
                  <View style={styles.podiumRow}>
                    {plans.monthly ? (
                      <PodiumColumn
                        plan={plans.monthly}
                        selected={selectedPeriod === 'monthly'}
                        onPress={() => selectPeriod('monthly')}
                      />
                    ) : null}
                    {plans.annual ? (
                      <PodiumColumn
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
                        plan={plans.lifetime}
                        selected={selectedPeriod === 'lifetime'}
                        chip="PAY ONCE"
                        chipTone="dark"
                        onPress={() => selectPeriod('lifetime')}
                      />
                    ) : null}
                  </View>
                ) : null}

                {selectedPlan ? (
                  <Text style={styles.selectedSummary}>
                    {selectedPlanSummary(selectedPlan)}
                  </Text>
                ) : null}

                {status === 'loading' && !plans ? (
                  <View
                    accessibilityRole="progressbar"
                    accessibilityLabel="Loading App Store pricing"
                    style={styles.loadingCard}
                  >
                    <ActivityIndicator color={color.volt} />
                    <Text style={styles.loadingText}>
                      Loading secure store pricing…
                    </Text>
                  </View>
                ) : null}

                {!plans && status !== 'loading' ? (
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
                  <Icon name="shield" color={color.volt} size={18} />
                  <Text style={styles.errorText}>{error.message}</Text>
                </PressableScale>
              ) : null}

              {showRetry ? (
                <PressableScale
                  testID="paywall-retry"
                  onPress={() => void initialize()}
                  accessibilityLabel="Retry loading membership"
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
                  <ActivityIndicator color={color.onVolt} />
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
                disabled={busy}
                style={styles.restoreButton}
              >
                {operation === 'restoring' ? (
                  <ActivityIndicator color={color.onDark} />
                ) : (
                  <Text style={styles.restoreText}>Restore purchases</Text>
                )}
              </PressableScale>

              <View style={styles.trustRow}>
                <Icon name="shield" color={color.mint} size={17} />
                <Text style={styles.trustText}>
                  Purchase and renewal are confirmed by your app store. Cancel
                  in your store account settings.
                </Text>
              </View>

              {selectedPlan ? (
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
                <LinearGradient
                  colors={[color.volt, color.mint]}
                  style={styles.crownBadge}
                >
                  <Icon name="crown" size={27} color={color.onVolt} />
                </LinearGradient>
                <Text style={styles.eyebrow}>PLAY PAST THE FIRST TWO</Text>
                <Text style={styles.title}>A coach for every stroke.</Text>
                <Text style={styles.subtitle}>
                  {allowanceCopy} Membership keeps scoring, practice, and
                  progress moving together.
                </Text>
                <Text style={styles.ratingRule}>{RATING_CONSUMPTION_RULE}</Text>
              </View>

              <View style={styles.benefits}>
                {BENEFITS.map(benefit => (
                  <BenefitRow key={benefit.title} {...benefit} />
                ))}
              </View>

              <PressableScale
                testID="paywall-see-plans"
                onPress={() => transitionTo('pricing')}
                accessibilityLabel="See membership plans"
                style={styles.primaryButton}
              >
                <Text style={styles.primaryButtonText}>
                  See membership plans
                </Text>
                <Icon name="arrow" color={color.onVolt} size={20} />
              </PressableScale>

              <View style={styles.trustRow}>
                <Icon name="shield" color={color.mint} size={17} />
                <Text style={styles.trustText}>
                  Store-verified pricing on the next step. Purchases are handled
                  by your app store — cancel anytime.
                </Text>
              </View>
            </ScrollView>
          )}
        </Animated.View>
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  topBar: {
    minHeight: 64,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  wordmarkRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  miniMark: {
    width: 20,
    height: 20,
    borderRadius: 7,
    backgroundColor: color.volt,
    borderWidth: 5,
    borderColor: color.court,
  },
  wordmark: {
    ...type.micro,
    fontFamily: font.bold,
    color: color.onDark,
    letterSpacing: 1.25,
  },
  closeButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.onDarkTint,
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
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.floating,
  },
  eyebrow: {
    ...type.micro,
    color: color.volt,
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
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(215,250,69,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(215,250,69,0.2)',
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
  podiumColumn: { flex: 1 },
  podiumColumnHero: { flex: 1.18, zIndex: 1 },
  podiumCard: {
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: color.lineMutedDark,
    backgroundColor: color.onDarkTint,
    paddingVertical: space.md,
    paddingHorizontal: space.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  podiumCardHero: {
    borderColor: 'rgba(215,250,69,0.55)',
    backgroundColor: 'rgba(215,250,69,0.07)',
  },
  podiumCardSelected: {
    borderColor: color.volt,
    backgroundColor: 'rgba(215,250,69,0.16)',
    shadowColor: color.volt,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.28,
    shadowRadius: 18,
    elevation: 8,
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
    backgroundColor: color.volt,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
    shadowColor: color.shadow,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 4,
  },
  heroBadgeText: {
    fontFamily: font.bold,
    fontSize: 10,
    lineHeight: 13,
    fontWeight: 'normal',
    color: color.onVolt,
    letterSpacing: 0.8,
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
    fontFamily: font.semibold,
    color: color.onDarkMuted,
    textAlign: 'center',
  },
  podiumPrice: {
    fontFamily: font.semibold,
    fontSize: 22,
    lineHeight: 27,
    fontWeight: 'normal',
    letterSpacing: -0.6,
    fontVariant: ['tabular-nums'],
    color: color.onDark,
    textAlign: 'center',
    marginTop: 2,
  },
  podiumPriceHero: {
    fontSize: 28,
    lineHeight: 33,
    letterSpacing: -0.8,
  },
  podiumQualifier: {
    fontFamily: font.medium,
    fontSize: 10,
    lineHeight: 13,
    fontWeight: 'normal',
    color: color.onDarkMuted,
    textAlign: 'center',
    marginTop: 3,
  },
  podiumChip: {
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginTop: space.sm,
  },
  podiumChipVolt: { backgroundColor: color.volt },
  podiumChipDark: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: color.lineMutedDark,
  },
  podiumChipText: {
    fontFamily: font.bold,
    fontSize: 9,
    lineHeight: 11,
    fontWeight: 'normal',
    letterSpacing: 0.55,
  },
  podiumChipTextVolt: { color: color.onVolt },
  podiumChipTextDark: { color: color.onDarkMuted },
  trialText: {
    fontFamily: font.semibold,
    fontSize: 10,
    lineHeight: 13,
    fontWeight: 'normal',
    color: color.volt,
    textAlign: 'center',
    marginTop: 4,
  },
  selectedSummary: {
    ...type.caption,
    fontFamily: font.semibold,
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
    backgroundColor: color.onDarkTint,
    padding: space.md,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
  },
  unavailableCopy: { flex: 1 },
  unavailableTitle: { ...type.bodyBold, color: color.onDark },
  unavailableBody: { ...type.caption, color: color.onDarkMuted, marginTop: 3 },
  errorCard: {
    marginTop: space.md,
    padding: space.md,
    borderRadius: radius.sm,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    backgroundColor: 'rgba(215,250,69,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(215,250,69,0.22)',
  },
  errorText: { ...type.caption, color: color.onDark, flex: 1 },
  primaryButton: {
    minHeight: 58,
    marginTop: space.md,
    borderRadius: radius.pill,
    backgroundColor: color.volt,
    paddingHorizontal: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  primaryButtonText: { ...type.bodyBold, color: color.onVolt },
  secondaryButton: {
    minHeight: 52,
    marginTop: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.lineMutedDark,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: { ...type.bodyBold, color: color.onDark },
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
  activeEyebrow: { ...type.micro, color: color.volt, marginTop: space.lg },
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
