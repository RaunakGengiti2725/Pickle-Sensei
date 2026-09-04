/**
 * Test-only host that mounts the whole `cmp-progress-charts` unit
 * (DashSectionHeader + StatDeltaRow + PracticeVolumeChart + ScoreTrendChart +
 * ScoreDotPlot + PracticeSetCard) behind the SAME wiring shape ProgressScreen
 * uses, so the unit can be stressed with range switching and an async load in
 * flight:
 *
 *   - range tabs are `PressableScale`s that call `setRange` (ProgressScreen
 *     `rangeBar`, src/screens/ProgressScreen.tsx);
 *   - the load runs per (range, revision) with the `let active = true`
 *     cancellation ProgressScreen's focus effect uses, so a resolution that
 *     lands after the screen moved on must be dropped;
 *   - `onOpenAttempt` navigates, and the "attempt sheet" stands in for the
 *     Result surface so a duplicate-modal regression would be visible.
 *
 * This host exists ONLY to drive the six real components; it is not
 * production code and never ships.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Text, View } from 'react-native';
import { PressableScale } from '../../src/design/components';
import { DashSectionHeader } from '../../src/progress/DashSectionHeader';
import { StatDeltaRow } from '../../src/progress/StatDeltaRow';
import { PracticeVolumeChart } from '../../src/progress/PracticeVolumeChart';
import { ScoreTrendChart } from '../../src/progress/ScoreTrendChart';
import { ScoreDotPlot } from '../../src/progress/ScoreDotPlot';
import { PracticeSetCard } from '../../src/progress/PracticeSetCard';
import type {
  ScoredReadPoint,
  ScoreTrendBucket,
} from '../../src/progress/techniqueDashboard';
import type { PracticeHistoryChartBucket } from '../../src/progress/practiceHistory';
import type { PracticeSetSummary } from '../../src/progress/practiceSetProgress';

export type RangeKey = '7d' | '28d' | '90d' | 'all';
export const RANGE_KEYS: readonly RangeKey[] = ['7d', '28d', '90d', 'all'];
export const RANGE_LABELS: Record<RangeKey, string> = {
  '7d': '7 days',
  '28d': '28 days',
  '90d': '90 days',
  all: 'All time',
};

export interface DashboardPayload {
  range: RangeKey;
  practiceBuckets: PracticeHistoryChartBucket[];
  scoreBuckets: ScoreTrendBucket[];
  reads: ScoredReadPoint[];
  activeDays: number;
  avgScore: string;
  priorAvgScore: string | null;
  deltaScore: number | null;
  practiceSet: PracticeSetSummary | null;
}

export interface DashboardHostProps {
  /** One call per load intent; resolves with the payload for that range. */
  load: (range: RangeKey, revision: number) => Promise<DashboardPayload>;
  onNavigate: (target: { name: 'Result'; analysisId: string }) => void;
}

export function DashboardHost(props: DashboardHostProps) {
  const [range, setRange] = useState<RangeKey>('28d');
  const [revision, setRevision] = useState(0);
  const [payload, setPayload] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [openAttempt, setOpenAttempt] = useState<string | null>(null);
  const { load, onNavigate } = props;
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let active = true;
    setLoading(true);
    void loadRef
      .current(range, revision)
      .then(result => {
        if (!active) return;
        setPayload(result);
      })
      .catch(() => {
        if (!active) return;
        setPayload(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [range, revision]);

  const openResult = useCallback(
    (analysisId: string) => {
      setOpenAttempt(current => current ?? analysisId);
      onNavigate({ name: 'Result', analysisId });
    },
    [onNavigate],
  );

  return (
    <View testID="dashboard-host">
      <View accessibilityRole="tablist" testID="range-bar">
        {RANGE_KEYS.map(key => (
          <PressableScale
            key={key}
            accessibilityLabel={`${RANGE_LABELS[key]} range`}
            accessibilityRole="tab"
            accessibilityState={{ selected: key === range }}
            onPress={() => setRange(key)}
            testID={`range-${key}`}
          >
            <Text>{RANGE_LABELS[key]}</Text>
          </PressableScale>
        ))}
        <PressableScale
          accessibilityLabel="Reload progress"
          onPress={() => setRevision(current => current + 1)}
          testID="reload"
        >
          <Text>Reload</Text>
        </PressableScale>
      </View>

      {loading ? (
        <Text testID="dashboard-loading">Loading</Text>
      ) : payload === null ? (
        <Text testID="dashboard-error">
          Your saved camera history could not be opened.
        </Text>
      ) : (
        <View testID="dashboard-body">
          <DashSectionHeader
            title="THIS WINDOW"
            right={RANGE_LABELS[payload.range]}
          />
          <StatDeltaRow
            icon="spark"
            label="Average score"
            value={payload.avgScore}
            previous={payload.priorAvgScore}
            delta={payload.deltaScore}
            testID="stat-avg-score"
          />
          <DashSectionHeader title="PRACTICE VOLUME" />
          <PracticeVolumeChart
            buckets={payload.practiceBuckets}
            rangeLabel={RANGE_LABELS[payload.range]}
            activeDays={payload.activeDays}
            testID="volume-chart"
          />
          <DashSectionHeader title="SCORE TREND" />
          <ScoreTrendChart buckets={payload.scoreBuckets} />
          <ScoreDotPlot
            buckets={payload.scoreBuckets}
            reads={payload.reads}
            rangeLabel={RANGE_LABELS[payload.range]}
          />
          {payload.practiceSet ? (
            <PracticeSetCard
              summary={payload.practiceSet}
              onOpenAttempt={openResult}
            />
          ) : null}
        </View>
      )}

      <Modal visible={openAttempt !== null} testID="attempt-sheet">
        <View testID="attempt-sheet-body">
          <Text>{openAttempt ?? ''}</Text>
          <PressableScale
            accessibilityLabel="Close attempt"
            onPress={() => setOpenAttempt(null)}
            testID="attempt-sheet-close"
          >
            <Text>Close</Text>
          </PressableScale>
        </View>
      </Modal>
    </View>
  );
}
