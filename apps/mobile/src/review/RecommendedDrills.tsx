import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ShotAnalysis } from '@pickle/shared-types';
import { getApiSession } from '../account/apiSession';
import { Button, Card, LoadingState, SectionTitle } from '../design/components';
import { color, space, type } from '../design/tokens';
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

  if (state.status === 'no_session') {
    return (
      <Card tone="soft" style={styles.quietCard} testID="recommended-drills">
        <Text style={[type.caption, styles.quietCopy]}>
          {RECOMMENDED_DRILLS_SIGN_IN_COPY}
        </Text>
      </Card>
    );
  }

  if (state.status === 'loading') {
    return (
      <View style={styles.loading} testID="recommended-drills">
        <LoadingState label={RECOMMENDED_DRILLS_LOADING_COPY} />
      </View>
    );
  }

  if (state.status === 'error') {
    return (
      <Card tone="soft" style={styles.quietCard} testID="recommended-drills">
        <Text style={[type.caption, styles.quietCopy]}>{state.message}</Text>
        <View style={styles.retry}>
          <Button
            label="Retry"
            variant="ghost"
            compact
            onPress={() => setAttempt(current => current + 1)}
            testID="recommended-drills-retry"
          />
        </View>
      </Card>
    );
  }

  return (
    <View testID="recommended-drills">
      <SectionTitle title="Drills for this stroke" />
      <Card style={styles.listCard}>
        {state.drills.length === 0 ? (
          <Text style={[type.caption, styles.quietCopy]}>
            {RECOMMENDED_DRILLS_EMPTY_COPY}
          </Text>
        ) : (
          state.drills.map((drill, index) => (
            <View
              key={drill.slug}
              style={[styles.row, index > 0 && styles.rowDivider]}
              testID={`recommended-drill-${drill.slug}`}
            >
              <Text style={[type.bodyBold, { color: color.ink }]}>
                {drill.title}
              </Text>
              <Text
                style={[type.caption, styles.description]}
                numberOfLines={2}
              >
                {drill.description}
              </Text>
              <Text style={[type.micro, styles.coach]}>
                {drill.coachName.toUpperCase()}
              </Text>
            </View>
          ))
        )}
        <Text style={[type.caption, styles.matchNote]}>{DRILL_MATCH_NOTE}</Text>
        <View style={styles.action}>
          <Button
            label="Open drill library"
            variant="secondary"
            onPress={props.onOpenLibrary}
            testID="recommended-drills-open-library"
          />
        </View>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  quietCard: { marginTop: space.md, padding: space.md },
  quietCopy: { color: color.inkSoft },
  loading: { marginTop: space.md, minHeight: 120 },
  retry: { marginTop: space.sm, alignSelf: 'flex-start' },
  listCard: { paddingHorizontal: space.lg, paddingVertical: space.sm },
  row: { paddingVertical: space.md, gap: space.xs },
  rowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
  },
  description: { color: color.inkSoft },
  coach: { color: color.inkSoft, marginTop: space.xxs },
  matchNote: {
    color: color.inkSoft,
    marginTop: space.sm,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
  },
  action: { marginTop: space.md, marginBottom: space.sm },
});
