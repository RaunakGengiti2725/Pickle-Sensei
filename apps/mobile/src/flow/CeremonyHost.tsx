import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AppState,
  BackHandler,
  Platform,
  StyleSheet,
  View,
} from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';
import {
  captureDataOwnerContext,
  getActiveDataOwner,
  isDataOwnerContextCurrent,
  SIGNED_OUT_DATA_OWNER,
  type DataOwnerContext,
} from '../data/accountScope';
import {
  useRankCelebrationStore,
  type RankCelebration,
} from '../progress/rankCelebration';
import {
  useConsistencyStore,
  type ConsistencyCelebration,
} from '../consistency/store';
import { useWalkthroughStore } from '../walkthrough/walkthroughStore';
import { identifyCeremony } from './ceremonyRequest';

type Ceremony =
  | { kind: 'rank'; content: RankCelebration }
  | { kind: 'streak'; content: ConsistencyCelebration }
  | { kind: 'walkthrough'; content: object };
type CeremonyKind = Ceremony['kind'];

type Request = Ceremony & {
  order: number;
  ownerKey: string | null;
  complete: () => void;
};

interface Presentation {
  id: number;
  request: Request;
  context: DataOwnerContext | null;
  ownerKey: string | null | undefined;
}

const PresentationContext = createContext<{
  ceremony: Ceremony;
  dismiss: () => void;
} | null>(null);
const allKinds: readonly CeremonyKind[] = ['rank', 'streak', 'walkthrough'];
const fallbackWalkthrough = {};

export function useCeremonyPresentation() {
  return useContext(PresentationContext);
}

export function CeremonyHost(props: {
  children: React.ReactNode;
  ownerKey?: string | null;
  enabled?: boolean;
  kinds?: readonly CeremonyKind[];
}) {
  const { ownerKey, enabled = true, kinds = allKinds } = props;
  const rank = useRankCelebrationStore(s => s.current);
  const pendingRank = useRankCelebrationStore(s => s.pending);
  const queuedRanks = useRankCelebrationStore(s => s.queued);
  const streak = useConsistencyStore(s => s.celebration);
  const queuedStreaks = useConsistencyStore(s => s.queuedCelebrations);
  const tourVisible = useWalkthroughStore(s => s.visible);
  const tourQueued = useWalkthroughStore(s => s.queued);
  const tourRequest = useWalkthroughStore(s => s.request);
  const [foreground, setForeground] = useState(
    AppState.currentState == null || AppState.currentState === 'active',
  );
  const [presentation, setPresentation] = useState<Presentation | null>(null);
  const active = useRef(presentation);
  const nextId = useRef(0);
  const mounted = useRef(false);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const update = useCallback((value: Presentation | null) => {
    active.current = value;
    setPresentation(value);
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      setForeground(state === 'active');
    });
    return () => subscription.remove();
  }, []);

  const requests = useMemo(() => {
    const candidates: Request[] = [];
    if (kinds.includes('rank')) {
      for (const content of [rank, pendingRank, ...queuedRanks]) {
        if (!content) continue;
        candidates.push({
          kind: 'rank',
          content,
          ...identifyCeremony(content),
          complete: () => useRankCelebrationStore.getState().dismiss(content),
        });
      }
    }
    if (kinds.includes('streak')) {
      for (const content of [streak, ...queuedStreaks]) {
        if (!content) continue;
        candidates.push({
          kind: 'streak',
          content,
          ...identifyCeremony(content),
          complete: () =>
            useConsistencyStore.getState().dismissCelebration(content),
        });
      }
    }
    if (kinds.includes('walkthrough') && (tourVisible || tourQueued)) {
      const content = tourRequest ?? fallbackWalkthrough;
      candidates.push({
        kind: 'walkthrough',
        content,
        ...identifyCeremony(content),
        complete: () => useWalkthroughStore.getState().dismiss(tourRequest),
      });
    }
    return candidates.sort((a, b) => a.order - b.order);
  }, [
    kinds,
    rank,
    pendingRank,
    queuedRanks,
    streak,
    queuedStreaks,
    tourVisible,
    tourQueued,
    tourRequest,
  ]);

  const eligible = useCallback(
    (current: Presentation) =>
      enabled &&
      current.ownerKey === ownerKey &&
      (!current.context || isDataOwnerContextCurrent(current.context)) &&
      requests.some(request => request.order === current.request.order),
    [enabled, ownerKey, requests],
  );
  const eligibility = useRef(eligible);
  eligibility.current = eligible;
  const visible = presentation !== null && eligible(presentation);

  useLayoutEffect(() => {
    const current = active.current;
    if (current) {
      if (!eligible(current)) update(null);
      return;
    }
    if (!enabled || !foreground || ownerKey === null) return;
    if (ownerKey === SIGNED_OUT_DATA_OWNER) return;
    if (ownerKey !== undefined && getActiveDataOwner() !== ownerKey) return;
    const request = requests.find(
      candidate =>
        ownerKey === undefined ||
        candidate.ownerKey === null ||
        candidate.ownerKey === ownerKey,
    );
    if (!request) return;
    update({
      id: ++nextId.current,
      request,
      context: ownerKey === undefined ? null : captureDataOwnerContext(),
      ownerKey,
    });
  }, [
    eligible,
    enabled,
    foreground,
    ownerKey,
    presentation,
    requests,
    update,
    visible,
  ]);
  const id = presentation?.id ?? 0;
  const dismiss = useCallback(() => {
    const current = active.current;
    if (
      !mounted.current ||
      !current ||
      current.id !== id ||
      !eligibility.current(current)
    ) {
      return false;
    }
    update(null);
    current.request.complete();
    return true;
  }, [id, update]);

  useEffect(() => {
    if (!visible) return;
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      dismiss,
    );
    return () => subscription.remove();
  }, [dismiss, visible]);

  if (!visible) return null;

  const overlay = (
    <View
      key={id}
      testID="ceremony-overlay"
      style={styles.overlay}
      collapsable={false}
      accessibilityViewIsModal
      importantForAccessibility="yes"
      onAccessibilityEscape={dismiss}
    >
      <PresentationContext.Provider
        value={{ ceremony: presentation.request, dismiss }}
      >
        {props.children}
      </PresentationContext.Provider>
    </View>
  );

  return Platform.OS === 'ios' ? (
    <FullWindowOverlay unstable_accessibilityContainerViewIsModal>
      {overlay}
    </FullWindowOverlay>
  ) : (
    overlay
  );
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFill, zIndex: 1000, elevation: 1000 },
});
