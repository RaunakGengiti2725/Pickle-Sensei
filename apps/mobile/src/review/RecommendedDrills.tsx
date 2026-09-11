import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import type { ShotAnalysis } from '@pickle/shared-types';
import { getApiSession } from '../account/apiSession';
import {
  Button,
  Card,
  LoadingState,
  PressableScale,
  useReducedMotion,
} from '../design/components';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import { createTrainingApi, type CatalogDrill } from '../training/api';
import {
  equipmentLine,
  parseDrillDescription,
} from '../training/drillDescription';
import { TrainingError } from '../training/types';
import {
  DRILL_MATCH_NOTE,
  drillFocusFromAnalysis,
  pickRecommendedDrills,
} from './recommendedDrillsModel';

/**
 * DRILLS FOR THIS STROKE — up to three catalog drills matched by the stroke
 * family of one scored analysis' worst measured fault, each one a card a
 * player can act on: the title, what the drill is for, the dose ("3 × 10
 * shadow swings + 2 × 10 fed balls") and, one tap away, the numbered steps
 * and the equipment. The catalog's description carries all of that in one
 * string; `parseDrillDescription` splits it so none of it is clamped away.
 *
 * Contract: never throws, never blocks the rest of the Result surface. The
 * catalog is fetched ONCE per analysis id (plus explicit retries); every
 * state is a quiet card, and the match note states the honest basis — a
 * family match from the catalog, not a coach-validated checkpoint mapping.
 *
 * Saving: when the host wires `onToggleSaved`, each drill carries a
 * bookmark toggle. The saved state is the host's call (`isSaved`) so the
 * training store's ledger — not this component — is the source of truth.
 */

export const RECOMMENDED_DRILLS_LIMIT = 3;
export const RECOMMENDED_DRILLS_SIGN_IN_COPY =
  'Sign in to see drills matched to this stroke.';
export const RECOMMENDED_DRILLS_LOADING_COPY =
  'Finding drills for this stroke…';
export const RECOMMENDED_DRILLS_ERROR_COPY =
  'Drills for this stroke couldn’t be loaded right now.';
export const RECOMMENDED_DRILLS_EMPTY_COPY =
  'The drill catalog lists nothing for this stroke family yet.';
export const RECOMMENDED_DRILLS_STEPS_LABEL = 'How to do it';
export const RECOMMENDED_DRILLS_HIDE_STEPS_LABEL = 'Hide steps';

type DrillsState =
  | { status: 'idle' }
  | { status: 'no_session' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; drills: CatalogDrill[] };

function errorMessage(error: unknown): string {
  return error instanceof TrainingError && error.message.trim().length > 0
    ? error.message
    : RECOMMENDED_DRILLS_ERROR_COPY;
}

/** "Beginner" / "Beginner–intermediate" from the catalog's own range. */
function difficultyLabel(drill: CatalogDrill): string | null {
  const { difficultyMin: min, difficultyMax: max } = drill;
  if (min && max && min !== max) return `${min}–${max}`;
  return min ?? max ?? null;
}

/** Text/tint roles of a drill card on the dark (Result guide) and light
 * surfaces; layout is shared, only color changes. */
const PALETTE = {
  light: {
    text: color.ink,
    muted: color.inkSoft,
    subtle: color.inkSoft,
    accent: color.court,
    badge: color.courtSoft,
    badgeText: color.court,
    chip: color.surfaceAlt,
    line: color.line,
    savedBg: color.court,
    savedIcon: color.onDark,
    row: color.surfaceElevated,
  },
  dark: {
    text: color.onDark,
    muted: color.onDarkMuted,
    subtle: color.onDarkSubtle,
    accent: color.volt,
    badge: color.voltTint,
    badgeText: color.volt,
    chip: color.onDarkTint,
    line: color.lineDark,
    savedBg: color.volt,
    savedIcon: color.onVolt,
    row: color.inkElevated,
  },
} as const;

/** Soft entrance for the expanded steps: quick fade + settle, skipped under
 * reduced motion. Transform/opacity only (native driver). */
function StepsReveal(props: { children: React.ReactNode }) {
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) {
      progress.setValue(1);
      return;
    }
    Animated.timing(progress, {
      toValue: 1,
      duration: 200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [progress, reduced]);
  return (
    <Animated.View
      style={{
        opacity: progress,
        transform: [
          {
            translateY: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [6, 0],
            }),
          },
        ],
      }}
    >
      {props.children}
    </Animated.View>
  );
}

function DrillCard(props: {
  drill: CatalogDrill;
  index: number;
  dark: boolean;
  expanded: boolean;
  onToggleExpanded: (slug: string) => void;
  saved: boolean;
  pending: boolean;
  onToggleSaved?: ((drill: CatalogDrill, saved: boolean) => void) | undefined;
}) {
  const { drill, dark, expanded, saved } = props;
  const palette = dark ? PALETTE.dark : PALETTE.light;
  const parts = useMemo(
    () => parseDrillDescription(drill.description),
    [drill.description],
  );
  const equipment = equipmentLine(drill.equipment);
  const difficulty = difficultyLabel(drill);
  const hasSteps = parts.steps.length > 0;

  return (
    <Card
      tone={dark ? 'dark' : 'light'}
      style={styles.card}
      testID={`recommended-drill-${drill.slug}`}
    >
      <View style={styles.cardTop}>
        <View style={[styles.numberBadge, { backgroundColor: palette.badge }]}>
          <Text style={[type.micro, { color: palette.badgeText }]}>
            {String(props.index + 1).padStart(2, '0')}
          </Text>
        </View>
        {difficulty ? (
          <Text style={[type.micro, { color: palette.subtle }]}>
            {difficulty.toUpperCase()}
          </Text>
        ) : null}
        <View style={styles.flex} />
        {props.onToggleSaved ? (
          <PressableScale
            accessibilityLabel={
              saved
                ? `Remove ${drill.title} from your library`
                : `Save ${drill.title} to your library`
            }
            accessibilityState={{ selected: saved }}
            disabled={props.pending}
            onPress={() => props.onToggleSaved?.(drill, !saved)}
            containerStyle={styles.bookmarkContainer}
            style={[
              styles.bookmarkButton,
              { backgroundColor: saved ? palette.savedBg : palette.chip },
            ]}
            testID={`recommended-drill-${drill.slug}-save`}
          >
            <Icon
              name="bookmark"
              size={19}
              color={saved ? palette.savedIcon : palette.muted}
            />
          </PressableScale>
        ) : null}
      </View>

      <Text style={[type.h3, styles.title, { color: palette.text }]}>
        {drill.title}
      </Text>
      {parts.purpose ? (
        <Text style={[type.body, styles.purpose, { color: palette.muted }]}>
          {parts.purpose}
        </Text>
      ) : null}

      {parts.dose || hasSteps ? (
        <View style={[styles.doseBlock, { borderTopColor: palette.line }]}>
          {parts.dose ? (
            <Text
              style={[type.bodyBold, { color: palette.text }]}
              testID={`recommended-drill-${drill.slug}-dose`}
            >
              {parts.dose}
            </Text>
          ) : null}
          {hasSteps ? (
            <PressableScale
              accessibilityLabel={`${
                expanded ? 'Hide' : 'Show'
              } steps for ${drill.title}`}
              accessibilityState={{ expanded }}
              onPress={() => props.onToggleExpanded(drill.slug)}
              style={styles.stepsToggle}
              testID={`recommended-drill-${drill.slug}-steps`}
            >
              <Text style={[type.bodyBold, { color: palette.accent }]}>
                {expanded
                  ? RECOMMENDED_DRILLS_HIDE_STEPS_LABEL
                  : RECOMMENDED_DRILLS_STEPS_LABEL}
              </Text>
              <View style={expanded ? styles.chevronUp : styles.chevronDown}>
                <Icon name="chevron" size={16} color={palette.accent} />
              </View>
            </PressableScale>
          ) : null}
        </View>
      ) : null}

      {hasSteps && expanded ? (
        <StepsReveal>
          <View
            style={styles.steps}
            testID={`recommended-drill-${drill.slug}-steps-list`}
          >
            {parts.steps.map((step, index) => (
              <View key={index} style={styles.stepRow}>
                <Text
                  style={[
                    type.caption,
                    styles.stepNumber,
                    { color: palette.accent },
                  ]}
                >
                  {index + 1}
                </Text>
                <Text
                  style={[type.body, styles.stepText, { color: palette.text }]}
                >
                  {step}
                </Text>
              </View>
            ))}
            {equipment ? (
              <Text
                style={[
                  type.caption,
                  styles.equipment,
                  { color: palette.subtle },
                ]}
              >
                {equipment}
              </Text>
            ) : null}
          </View>
        </StepsReveal>
      ) : null}
    </Card>
  );
}

export function RecommendedDrills(props: {
  analysis: ShotAnalysis;
  onOpenLibrary: () => void;
  /** Dark-surface card tones (Result guide). Default light. */
  dark?: boolean;
  /**
   * Per-drill "Save to library" toggle. `isSaved` decides the shown state
   * (the host reads the training store); `pendingSlug` disables the toggle
   * whose mutation is in flight.
   */
  onToggleSaved?: (drill: CatalogDrill, saved: boolean) => void;
  isSaved?: (drill: CatalogDrill) => boolean;
  pendingSlug?: string | null;
}) {
  const { analysis } = props;
  const focus = useMemo(() => drillFocusFromAnalysis(analysis), [analysis]);
  const family = focus?.family ?? null;
  const [state, setState] = useState<DrillsState>({ status: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const requestRef = useRef(0);
  // The latest focus for the in-flight request; the effect is keyed on the
  // analysis id + family so a re-rendered analysis object never refetches.
  const focusRef = useRef(focus);
  focusRef.current = focus;

  useEffect(() => {
    if (family === null) return;
    const requestId = ++requestRef.current;
    const session = getApiSession();
    const baseUrl = session?.apiBaseUrl?.trim();
    const token = session?.bearerToken?.trim();
    if (!baseUrl || !token) {
      setState({ status: 'no_session' });
      return;
    }
    setState({ status: 'loading' });
    let cancelled = false;
    void (async () => {
      try {
        const api = createTrainingApi({ baseUrl, token });
        const drills = await api.listCatalogDrills({ family });
        if (cancelled || requestId !== requestRef.current) return;
        const current = focusRef.current;
        setState({
          status: 'ready',
          drills: current
            ? pickRecommendedDrills(drills, current, RECOMMENDED_DRILLS_LIMIT)
            : [],
        });
      } catch (error) {
        if (cancelled || requestId !== requestRef.current) return;
        setState({ status: 'error', message: errorMessage(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [analysis.id, family, attempt]);

  if (!focus || state.status === 'idle') return null;

  const dark = props.dark === true;
  const palette = dark ? PALETTE.dark : PALETTE.light;
  const quietTone = dark ? 'dark' : 'soft';

  if (state.status === 'no_session') {
    return (
      <Card
        tone={quietTone}
        style={styles.quietCard}
        testID="recommended-drills"
      >
        <Text style={[type.caption, { color: palette.muted }]}>
          {RECOMMENDED_DRILLS_SIGN_IN_COPY}
        </Text>
      </Card>
    );
  }

  if (state.status === 'loading') {
    return (
      <View style={styles.loading} testID="recommended-drills">
        <LoadingState label={RECOMMENDED_DRILLS_LOADING_COPY} dark={dark} />
      </View>
    );
  }

  if (state.status === 'error') {
    return (
      <Card
        tone={quietTone}
        style={styles.quietCard}
        testID="recommended-drills"
      >
        <Text style={[type.caption, { color: palette.muted }]}>
          {state.message}
        </Text>
        <View style={styles.retry}>
          <Button
            label="Retry"
            variant={dark ? 'dark' : 'ghost'}
            compact
            onPress={() => setAttempt(current => current + 1)}
            testID="recommended-drills-retry"
          />
        </View>
        <View style={styles.action}>
          <Button
            label="Browse library"
            variant={dark ? 'dark' : 'secondary'}
            onPress={props.onOpenLibrary}
            testID="recommended-drills-open-library"
          />
        </View>
      </Card>
    );
  }

  const toggleExpanded = (slug: string) =>
    setExpanded(current => ({ ...current, [slug]: !current[slug] }));

  return (
    <View testID="recommended-drills">
      {state.drills.length === 0 ? (
        <Card tone={quietTone} style={styles.quietCard}>
          <Text style={[type.caption, { color: palette.muted }]}>
            {RECOMMENDED_DRILLS_EMPTY_COPY}
          </Text>
        </Card>
      ) : (
        <View style={styles.list}>
          {state.drills.map((drill, index) => (
            <DrillCard
              key={drill.slug}
              drill={drill}
              index={index}
              dark={dark}
              expanded={expanded[drill.slug] === true}
              onToggleExpanded={toggleExpanded}
              saved={props.isSaved ? props.isSaved(drill) : drill.saved}
              pending={props.pendingSlug === drill.slug}
              onToggleSaved={props.onToggleSaved}
            />
          ))}
        </View>
      )}
      <Text
        style={[
          type.caption,
          styles.matchNote,
          { color: dark ? color.onDarkFaint : color.inkSoft },
        ]}
      >
        {DRILL_MATCH_NOTE}
      </Text>
      <PressableScale
        accessibilityLabel="Open drill library"
        onPress={props.onOpenLibrary}
        style={[
          styles.libraryRow,
          { backgroundColor: palette.row, borderColor: palette.line },
        ]}
        testID="recommended-drills-open-library"
      >
        <Text style={[type.bodyBold, { color: palette.text }]}>
          Open drill library
        </Text>
        <Icon name="arrow" size={18} color={palette.muted} />
      </PressableScale>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  quietCard: { marginTop: space.md, padding: space.md },
  loading: { marginTop: space.md, minHeight: 120 },
  retry: { marginTop: space.sm, alignSelf: 'flex-start' },
  action: { marginTop: space.md, marginBottom: space.sm },
  list: { gap: space.sm, marginTop: space.md },
  card: { padding: space.lg },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  numberBadge: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bookmarkContainer: { alignSelf: 'center', borderRadius: 22 },
  bookmarkButton: {
    width: 44,
    height: 44,
    minWidth: 44,
    minHeight: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { marginTop: space.md },
  purpose: { marginTop: space.xs },
  doseBlock: {
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: space.md,
    paddingTop: space.md,
    gap: space.xs,
  },
  stepsToggle: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  chevronDown: { transform: [{ rotate: '90deg' }] },
  chevronUp: { transform: [{ rotate: '-90deg' }] },
  steps: { gap: space.sm, paddingBottom: space.xs },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  stepNumber: {
    width: 18,
    textAlign: 'right',
    lineHeight: 23,
    fontVariant: ['tabular-nums'],
  },
  stepText: { flex: 1 },
  equipment: { marginTop: space.xs },
  matchNote: { marginTop: space.md, paddingHorizontal: space.xs },
  libraryRow: {
    minHeight: 52,
    marginTop: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
