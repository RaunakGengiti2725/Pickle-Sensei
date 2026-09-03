import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ShotAnalysis } from '@pickle/shared-types';
import { getApiSession } from '../account/apiSession';
import {
  Button,
  Card,
  LoadingState,
  PressableScale,
  SectionTitle,
} from '../design/components';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import { createTrainingApi, type CatalogDrill } from '../training/api';
import { TrainingError } from '../training/types';
import {
  DRILL_MATCH_NOTE,
  drillFocusFromAnalysis,
  pickRecommendedDrills,
} from './recommendedDrillsModel';

/**
 * DRILLS FOR THIS STROKE — up to three catalog drills matched by the stroke
 * family of one scored analysis' worst measured fault.
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
  const quietTone = dark ? 'dark' : 'soft';
  const ink = dark ? color.onDark : color.ink;
  const inkSoft = dark ? color.onDarkMuted : color.inkSoft;
  const libraryButton = (
    <View style={styles.action}>
      <Button
        label={
          state.status === 'ready' ? 'Open drill library' : 'Browse library'
        }
        variant={dark ? 'dark' : 'secondary'}
        onPress={props.onOpenLibrary}
        testID="recommended-drills-open-library"
      />
    </View>
  );

  if (state.status === 'no_session') {
    return (
      <Card
        tone={quietTone}
        style={styles.quietCard}
        testID="recommended-drills"
      >
        <Text style={[type.caption, { color: inkSoft }]}>
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
        <Text style={[type.caption, { color: inkSoft }]}>{state.message}</Text>
        <View style={styles.retry}>
          <Button
            label="Retry"
            variant={dark ? 'dark' : 'ghost'}
            compact
            onPress={() => setAttempt(current => current + 1)}
            testID="recommended-drills-retry"
          />
        </View>
        {libraryButton}
      </Card>
    );
  }

  return (
    <View testID="recommended-drills">
      <SectionTitle title="Drills for this stroke" dark={dark} />
      <Card tone={dark ? 'dark' : 'light'} style={styles.listCard}>
        {state.drills.length === 0 ? (
          <Text style={[type.caption, { color: inkSoft }]}>
            {RECOMMENDED_DRILLS_EMPTY_COPY}
          </Text>
        ) : (
          state.drills.map((drill, index) => {
            const saved = props.isSaved ? props.isSaved(drill) : drill.saved;
            const pending = props.pendingSlug === drill.slug;
            return (
              <View
                key={drill.slug}
                style={[
                  styles.row,
                  index > 0 && styles.rowDivider,
                  index > 0 && dark && styles.rowDividerDark,
                ]}
                testID={`recommended-drill-${drill.slug}`}
              >
                <View style={styles.rowTop}>
                  <Text style={[type.bodyBold, styles.title, { color: ink }]}>
                    {drill.title}
                  </Text>
                  {props.onToggleSaved ? (
                    <PressableScale
                      accessibilityLabel={
                        saved
                          ? `Remove ${drill.title} from your library`
                          : `Save ${drill.title} to your library`
                      }
                      accessibilityState={{ selected: saved }}
                      disabled={pending}
                      onPress={() => props.onToggleSaved?.(drill, !saved)}
                      containerStyle={styles.saveContainer}
                      style={[
                        styles.saveToggle,
                        dark && styles.saveToggleDark,
                        saved && styles.saveToggleOn,
                      ]}
                      testID={`recommended-drill-${drill.slug}-save`}
                    >
                      <Icon
                        name="bookmark"
                        size={15}
                        color={saved ? color.onVolt : inkSoft}
                      />
                      <Text
                        style={[
                          type.micro,
                          { color: saved ? color.onVolt : inkSoft },
                        ]}
                      >
                        {pending ? 'SAVING' : saved ? 'SAVED' : 'SAVE'}
                      </Text>
                    </PressableScale>
                  ) : null}
                </View>
                <Text
                  style={[type.caption, { color: inkSoft }]}
                  numberOfLines={2}
                >
                  {drill.description}
                </Text>
                <Text style={[type.micro, styles.coach, { color: inkSoft }]}>
                  {drill.coachName.toUpperCase()}
                </Text>
              </View>
            );
          })
        )}
        <Text
          style={[
            type.caption,
            styles.matchNote,
            dark && styles.matchNoteDark,
            { color: inkSoft },
          ]}
        >
          {DRILL_MATCH_NOTE}
        </Text>
        {libraryButton}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  quietCard: { marginTop: space.md, padding: space.md },
  loading: { marginTop: space.md, minHeight: 120 },
  retry: { marginTop: space.sm, alignSelf: 'flex-start' },
  listCard: { paddingHorizontal: space.lg, paddingVertical: space.sm },
  row: { paddingVertical: space.md, gap: space.xs },
  rowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
  },
  rowDividerDark: { borderTopColor: color.lineDark },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { flex: 1 },
  saveContainer: { alignSelf: 'center' },
  saveToggle: {
    minHeight: 34,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.line,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  saveToggleDark: { borderColor: color.lineDark },
  saveToggleOn: { backgroundColor: color.volt, borderColor: color.volt },
  coach: { marginTop: space.xxs },
  matchNote: {
    marginTop: space.sm,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
  },
  matchNoteDark: { borderTopColor: color.lineDark },
  action: { marginTop: space.md, marginBottom: space.sm },
});
