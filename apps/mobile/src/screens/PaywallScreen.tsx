import React, { useEffect } from 'react';
import {
  ActivityIndicator,
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
    title: 'Reviewed practice, kept together',
    body: 'Published drills and rights-cleared coaching videos can be saved with the plan that prescribed them.',
  },
];

function periodLabel(period: BillingPeriod): string {
  return period === 'annual' ? 'year' : 'month';
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

function PlanCard(props: {
  plan: StorePlan;
  selected: boolean;
  badge?: string | null;
  onPress: () => void;
}) {
  const detail = props.plan.pricePerMonthString
    ? `${props.plan.pricePerMonthString} per month`
    : `Billed every ${periodLabel(props.plan.period)}`;
  return (
    <PressableScale
      testID={`paywall-plan-${props.plan.period}`}
      onPress={props.onPress}
      accessibilityLabel={`${props.plan.period} membership, ${
        props.plan.priceString
      } per ${periodLabel(props.plan.period)}${
        props.selected ? ', selected' : ''
      }`}
      style={[styles.planCard, props.selected && styles.planCardSelected]}
    >
      <View style={[styles.radio, props.selected && styles.radioSelected]}>
        {props.selected ? <View style={styles.radioDot} /> : null}
      </View>
      <View style={styles.planCopy}>
        <View style={styles.planTitleRow}>
          <Text style={styles.planTitle}>
            {props.plan.period === 'annual' ? 'Annual' : 'Monthly'}
          </Text>
          {props.badge ? (
            <View style={styles.savingsBadge}>
              <Text style={styles.savingsText}>{props.badge}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.planDetail}>{detail}</Text>
        {props.plan.freeTrial ? (
          <Text style={styles.trialText}>{props.plan.freeTrial.label}</Text>
        ) : null}
      </View>
      <View style={styles.planPriceBlock}>
        <Text style={styles.planPrice}>{props.plan.priceString}</Text>
        <Text style={styles.planPeriod}>/{periodLabel(props.plan.period)}</Text>
      </View>
    </PressableScale>
  );
}

function BenefitRow(props: (typeof BENEFITS)[number]) {
  return (
    <View style={styles.benefitRow}>
      <View style={styles.benefitIcon}>
        <Icon name={props.icon} color={color.volt} size={20} />
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

  useEffect(() => {
    if (status === 'idle') void initialize();
  }, [initialize, status]);

  const selectedPlan =
    selectedPeriod === 'annual' ? plans?.annual : plans?.monthly;
  const busy = operation !== 'idle';
  const annualSavings = savingsLabel(
    plans?.annual ?? null,
    plans?.monthly ?? null,
  );
  const purchaseLabel = selectedPlan?.freeTrial
    ? `Start ${selectedPlan.freeTrial.label}`
    : selectedPlan
      ? `Continue with ${selectedPlan.period}`
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
          <View style={styles.wordmarkRow}>
            <View style={styles.miniMark} />
            <Text style={styles.wordmark}>PICKLE SENSEI</Text>
          </View>
          <PressableScale
            onPress={props.onClose}
            accessibilityLabel="Close membership offer"
            style={styles.closeButton}
          >
            <Icon name="close" size={22} color={color.onDark} />
          </PressableScale>
        </View>

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
              {allowanceCopy} Membership keeps scoring, practice, and progress
              moving together.
            </Text>
            <Text style={styles.ratingRule}>{RATING_CONSUMPTION_RULE}</Text>
          </View>

          <View style={styles.benefits}>
            {BENEFITS.map(benefit => (
              <BenefitRow key={benefit.title} {...benefit} />
            ))}
          </View>

          <View style={styles.plans}>
            {plans?.annual ? (
              <PlanCard
                plan={plans.annual}
                selected={selectedPeriod === 'annual'}
                badge={annualSavings}
                onPress={() => selectPeriod('annual')}
              />
            ) : null}
            {plans?.monthly ? (
              <PlanCard
                plan={plans.monthly}
                selected={selectedPeriod === 'monthly'}
                onPress={() => selectPeriod('monthly')}
              />
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
                    We couldn’t load a verified App Store offer. Try again—no
                    estimated price will be shown.
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
                <Text style={styles.primaryButtonText}>{purchaseLabel}</Text>
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
              Purchase and renewal are confirmed by your app store. Cancel in
              your store account settings.
            </Text>
          </View>

          {selectedPlan ? (
            <Text style={styles.legalText}>
              {selectedPlan.freeTrial
                ? `After the ${selectedPlan.freeTrial.label}, `
                : ''}
              {selectedPlan.priceString} per {periodLabel(selectedPlan.period)},
              automatically renewing until canceled.
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
    marginTop: space.lg,
    gap: space.md,
    paddingVertical: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineDark,
  },
  benefitRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  benefitIcon: {
    width: 42,
    height: 42,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(215,250,69,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(215,250,69,0.2)',
  },
  benefitCopy: { flex: 1 },
  benefitTitle: { ...type.bodyBold, color: color.onDark },
  benefitBody: { ...type.caption, color: color.onDarkMuted, marginTop: 2 },
  plans: { marginTop: space.lg, gap: 10 },
  planCard: {
    minHeight: 88,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.lineMutedDark,
    backgroundColor: color.onDarkTint,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  planCardSelected: {
    borderColor: color.volt,
    backgroundColor: 'rgba(215,250,69,0.12)',
  },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: color.onDarkMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioSelected: { borderColor: color.volt },
  radioDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: color.volt,
  },
  planCopy: { flex: 1 },
  planTitleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  planTitle: { ...type.bodyBold, color: color.onDark },
  savingsBadge: {
    backgroundColor: color.volt,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  savingsText: {
    fontFamily: font.bold,
    fontSize: 9,
    lineHeight: 11,
    color: color.onVolt,
    letterSpacing: 0.55,
  },
  planDetail: { ...type.caption, color: color.onDarkMuted, marginTop: 2 },
  trialText: { ...type.caption, color: color.volt, marginTop: 3 },
  planPriceBlock: { alignItems: 'flex-end' },
  planPrice: { ...type.h3, color: color.onDark },
  planPeriod: { ...type.caption, color: color.onDarkMuted },
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
