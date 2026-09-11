import React, {
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  FlatList,
  Linking,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Button,
  Card,
  EmptyState,
  LoadingState,
  Pill,
  PressableScale,
} from '../design/components';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import { getDb } from '../data/db';
import {
  captureDataOwnerContext,
  getActiveDataOwner,
  getDataOwnerSnapshot,
  subscribeToDataOwner,
  isDataOwnerContextCurrent,
  SIGNED_OUT_DATA_OWNER,
} from '../data/accountScope';
import {
  listPendingCaptures,
  listShots,
  type LocalShotRow,
  type PendingCapture,
} from '../data/repository';
import type { RootStackParams } from '../navigation/params';
import { useTabBarContentInset } from '../navigation/tabBarLayout';
import { useTabScrollDock } from '../navigation/tabBarDock';
import { DuprReadout } from '../progress/DuprReadout';
import { duprAccessibilityLabel } from '../progress/duprEstimate';
import { SavedDrillCard } from '../training/components';
import { useTrainingStore } from '../training/store';
import type { InstructionalMedia } from '../training/types';
import { useAuthStore } from '../auth/authStore';
import { plural } from '../util/plural';
import { showBrandNotice } from '../design/BrandNotice';
import { forDataOwner } from '../data/transactions';

type LibraryTab = 'reads' | 'saved';

/** Pending-clips group header + pill, exported so tests pin the copy. */
export const PENDING_SECTION_LABEL = 'SAVED CLIPS · NOT ANALYZED';
export const PENDING_SECTION_PILL = 'NOT SCORED';
export const PENDING_SECTION_NOTE =
  'Saved technique confirmations and interrupted analyses reopen the same clip. Other pending clips remain read-only. Opening a clip never starts a rating.';
export const MUTATION_ERROR_DISMISS_HINT = 'Dismisses this message';
/** Reads-tab copy when the local repository could not be read. */
export const READS_LOAD_ERROR_TITLE = 'Your reads couldn’t be opened.';
export const READS_LOAD_ERROR_BODY =
  'Your saved reads and clips couldn’t be read from this device right now. Try again to reload them.';

/**
 * Embeds open their canonical watch page, never the raw /embed/ URL: YouTube
 * refuses embed surfaces loaded without an embedding referer (error 153),
 * while the watch page always plays in the YouTube app or browser.
 */
function mediaUrl(media: InstructionalMedia): string {
  return media.kind === 'hosted' ? media.playbackUrl : media.sourceUrl;
}

export function pendingEvidenceCopy(capture: PendingCapture): string {
  if (capture.evidenceStatus === 'valid' && capture.clip?.captureEvidence) {
    return `${
      capture.clip.captureEvidence.poseFrameCount
    } pose frames · ${Math.round(
      capture.clip.captureEvidence.meanJointCoverage * 100,
    )}% joint coverage`;
  }
  switch (capture.evidenceStatus) {
    case 'legacy':
      return 'Recorded by an older app version — can’t be scored';
    case 'metadata_mismatch':
      return 'Evidence doesn’t match this video — can’t be scored';
    case 'corrupt':
      return 'Saved evidence could not be verified — can’t be scored';
    case 'valid':
      // A journaled run or a saved technique-confirmation record means an
      // analysis DID start for this clip; "has not run yet" would contradict
      // the row's own reopen action.
      return pendingCaptureActionLabel(capture)
        ? 'Analysis started — not scored yet'
        : 'Clip saved — analysis has not run yet';
  }
}

/**
 * Row action for a pending clip that can reopen its own saved analysis;
 * null for the read-only clips the section note describes.
 */
export function pendingCaptureActionLabel(
  capture: PendingCapture,
): string | null {
  switch (capture.techniqueConfirmation) {
    case 'ready':
      return 'Confirm technique';
    case 'release_pending':
      return 'Recover confirmation';
    case 'blocked':
      return 'Review saved capture';
    case undefined:
      return capture.hasOriginalOperation === true
        ? 'Review saved analysis'
        : null;
  }
}

/** Compact clip length: `23s`, `1:05`; sub-second clips read `<1s`. */
export function formatClipDuration(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Month + day tile shared by read rows and pending-clip rows. */
function DateTile(props: { iso: string }) {
  const date = new Date(props.iso);
  return (
    <View style={styles.dateBlock}>
      <Text style={[type.micro, { color: color.inkSoft }]}>
        {date.toLocaleDateString(undefined, { month: 'short' }).toUpperCase()}
      </Text>
      <Text style={[type.h2, styles.dateNumber]}>{date.getDate()}</Text>
    </View>
  );
}

/**
 * Row title for a pending clip. Prefers the player's declared stroke, then a
 * recognized shot type; a clip with neither is labeled plainly as an auto
 * capture instead of the old machine-y "Automatic capture".
 */
export function pendingCaptureTitle(capture: PendingCapture): string {
  const stroke =
    capture.declaredStroke ??
    (capture.shotType !== 'unrecognized' ? capture.shotType : null);
  if (!stroke) return 'Auto capture';
  const strokeName = stroke
    .split('_')
    .filter(word => word.length > 0)
    .map(word => word[0]!.toUpperCase() + word.slice(1))
    .join(' ');
  return `${strokeName} · auto capture`;
}

export function LibraryScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const tabBarInset = useTabBarContentInset();
  // One latch for the tab; whichever list is mounted for the current state
  // feeds it, and each list's own unmount releases it.
  const tabBarDock = useTabScrollDock('Library');
  const localOnly = useAuthStore(state => state.session?.localOnly === true);
  const ownerKey = useAuthStore(state => state.session?.canonicalAppUserId);
  const ownerEpoch = useSyncExternalStore(
    subscribeToDataOwner,
    getDataOwnerSnapshot,
    getDataOwnerSnapshot,
  );
  const activeOwner = ownerEpoch.ownerKey;
  const ownerGeneration =
    activeOwner === SIGNED_OUT_DATA_OWNER ? null : ownerEpoch.generation;
  const loadTicket = useRef<symbol | null>(null);
  const [tab, setTab] = useState<LibraryTab>('reads');
  const [shots, setShots] = useState<LocalShotRow[] | null>(null);
  const [captures, setCaptures] = useState<PendingCapture[]>([]);
  const [loadedOwner, setLoadedOwner] = useState<{
    ownerKey: string;
    generation: number | null;
    ticket: symbol;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  const savedStatus = useTrainingStore(state => state.savedStatus);
  const planStatus = useTrainingStore(state => state.planStatus);
  const savedDrills = useTrainingStore(state => state.savedDrills);
  const currentPlan = useTrainingStore(state => state.currentPlan);
  const drillDetails = useTrainingStore(state => state.drillDetails);
  const savedError = useTrainingStore(state => state.savedError);
  const mutation = useTrainingStore(state => state.mutation);
  const mutationError = useTrainingStore(state => state.mutationError);
  const loadSavedDrills = useTrainingStore(state => state.loadSavedDrills);
  const loadCurrentPlan = useTrainingStore(state => state.loadCurrentPlan);
  const setDrillSaved = useTrainingStore(state => state.setDrillSaved);
  const clearMutationError = useTrainingStore(
    state => state.clearMutationError,
  );

  // Only the newest read may touch state: a superseded read that settles
  // late (after a refocus, a retry, or blur) is dropped, whichever way it
  // settled. A failed repository read is an error, never an empty library:
  // the first-run empty state renders only from a successful, empty result.
  const retryReads = useCallback(() => {
    if (
      !loadedOwner ||
      loadedOwner.ticket !== loadTicket.current ||
      !isDataOwnerContextCurrent(ownerEpoch) ||
      navigation.isFocused?.() === false
    )
      return;
    loadTicket.current = null;
    setLoadError(null);
    setShots(null);
    setLoadRevision(revision => revision + 1);
  }, [loadedOwner, navigation, ownerEpoch]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      const ticket = Symbol();
      loadTicket.current = ticket;
      const owner = getActiveDataOwner();
      const context =
        owner === SIGNED_OUT_DATA_OWNER ? null : captureDataOwnerContext();
      const isCurrent = () =>
        active &&
        loadTicket.current === ticket &&
        getActiveDataOwner() === owner &&
        (context === null || isDataOwnerContextCurrent(context));
      void (async () => {
        try {
          const rawDb = getDb();
          const db = context ? forDataOwner(rawDb, context) : rawDb;
          const [realShots, pending] = await Promise.all([
            listShots(db, 100),
            listPendingCaptures(db, 100),
          ]);
          if (!isCurrent()) return;
          setShots(realShots);
          setCaptures(pending);
          setLoadError(null);
        } catch {
          if (!isCurrent()) return;
          setLoadError(READS_LOAD_ERROR_BODY);
        } finally {
          if (isCurrent()) {
            setLoadedOwner({
              ownerKey: owner,
              generation: context?.generation ?? null,
              ticket,
            });
          }
        }
      })();
      void loadSavedDrills();
      void loadCurrentPlan();
      return () => {
        active = false;
        if (loadTicket.current === ticket) loadTicket.current = null;
      };
    }, [
      activeOwner,
      loadCurrentPlan,
      loadRevision,
      loadSavedDrills,
      localOnly,
      ownerGeneration,
      ownerKey,
    ]),
  );

  const openMedia = useCallback(async (media: InstructionalMedia) => {
    const url = mediaUrl(media);
    try {
      if (!(await Linking.canOpenURL(url))) {
        throw new Error('unsupported');
      }
      await Linking.openURL(url);
    } catch {
      showBrandNotice({
        title: 'Video unavailable',
        detail:
          'This reviewed video could not be opened. Refresh the library and try again.',
        tone: 'danger',
        eyebrow: 'COACHING VIDEO',
      });
    }
  }, []);

  const ownsLoadedData =
    loadedOwner?.ownerKey === activeOwner &&
    loadedOwner.generation === ownerGeneration &&
    loadedOwner.ticket === loadTicket.current;
  const reads = shots ?? [];
  const completedPlanItems =
    currentPlan?.items.filter(item => item.drill && item.completion).length ??
    0;
  const prescribedPlanItems =
    currentPlan?.items.filter(item => item.drill).length ?? 0;
  // A saved entry renders when its server catalog detail loaded — the user
  // saved it and the server confirmed the drill exists. SavedDrillCard
  // labels coach-reviewed prescriptions vs plain catalog entries itself
  // (mappings presence), so bookmark visibility never depends on a
  // fault→drill prescription existing. Entries whose detail could NOT be
  // fetched stay hidden with honest copy — nothing is rendered from guesses.
  const verifiedSavedDrills = savedDrills.filter(
    drill => drillDetails[drill.slug] !== undefined,
  );
  const heldSavedCount = savedDrills.length - verifiedSavedDrills.length;

  const header = (
    <View style={styles.pageHeader}>
      <Text style={[type.hero, styles.pageTitle]}>Library</Text>
      <Text style={[type.body, styles.pageSubtitle]}>
        Your measured reads and the reviewed work you chose to keep.
      </Text>
      <View accessibilityRole="tablist" style={styles.segmentedControl}>
        {(
          [
            ['reads', 'Reads'],
            ['saved', 'Saved drills'],
          ] as const
        ).map(([value, label]) => {
          const selected = tab === value;
          return (
            <Pressable
              key={value}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => setTab(value)}
              style={({ pressed }) => [
                styles.segment,
                selected && styles.segmentSelected,
                pressed && { opacity: 0.78 },
              ]}
            >
              <Text
                style={[
                  type.bodyBold,
                  { color: selected ? color.onDark : color.graphite },
                ]}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );

  if (tab === 'saved') {
    return (
      <SafeAreaView edges={['top']} style={styles.screen}>
        <StatusBar barStyle="dark-content" />
        <ScrollView
          {...tabBarDock}
          contentContainerStyle={[
            styles.savedContent,
            { paddingBottom: tabBarInset },
          ]}
          showsVerticalScrollIndicator={false}
        >
          {header}
          {planStatus === 'ready' && currentPlan ? (
            <PressableScale
              accessibilityLabel="Open your current personalized plan"
              onPress={() =>
                navigation.navigate('Result', {
                  analysisId: currentPlan.sourceShotId,
                })
              }
              style={styles.planSummary}
            >
              <View style={styles.planSummaryTop}>
                <Text
                  numberOfLines={2}
                  style={[type.micro, styles.planSummaryLabel]}
                >
                  CURRENT PLAN
                </Text>
                <Pill
                  label={`${completedPlanItems}/${prescribedPlanItems} DONE`}
                  tone="dark"
                />
              </View>
              <Text style={[type.h1, styles.planTitle]}>
                {currentPlan.shotType.replace(/_/g, ' ')}
              </Text>
              <Text style={[type.body, styles.planCopy]}>
                Reviewed work for{' '}
                {currentPlan.priorityCheckpoint.replace(/_/g, ' ')} ·{' '}
                {currentPlan.priorityDirection.replace(/_/g, ' ')}
              </Text>
              <View style={styles.planProgressTrack}>
                <View
                  style={[
                    styles.planProgressFill,
                    {
                      width: `${
                        prescribedPlanItems === 0
                          ? 0
                          : (completedPlanItems / prescribedPlanItems) * 100
                      }%`,
                    },
                  ]}
                />
              </View>
              <View style={styles.openPlanRow}>
                <Text
                  numberOfLines={1}
                  style={[type.bodyBold, styles.openPlanLabel]}
                >
                  Continue plan
                </Text>
                <Icon name="arrow" size={19} color={color.volt} />
              </View>
            </PressableScale>
          ) : null}

          <PressableScale
            accessibilityLabel="Explore the Drill Library"
            onPress={() => navigation.navigate('DrillLibrary')}
            style={styles.exploreCard}
          >
            <View style={styles.exploreIcon}>
              <Icon name="library" size={20} color={color.court} />
            </View>
            <View style={styles.flex}>
              <Text numberOfLines={2} style={[type.h3, { color: color.ink }]}>
                Explore the Drill Library
              </Text>
              <Text
                numberOfLines={2}
                style={[type.caption, styles.exploreCopy]}
              >
                Form cues, video demos, and picks based on your scored analyses.
              </Text>
            </View>
            <Icon name="arrow" size={18} color={color.inkSoft} />
          </PressableScale>

          {savedStatus === 'loading' || savedStatus === 'idle' ? (
            <View style={styles.stateBlock}>
              <LoadingState label="Loading saved drills…" />
            </View>
          ) : savedStatus === 'unconfigured' ? (
            <Card tone="soft" style={styles.messageCard}>
              <View style={styles.messageIcon}>
                <Icon name="shield" size={22} color={color.court} />
              </View>
              <Text style={[type.h2, styles.messageTitle]}>
                Saved training needs a synced account.
              </Text>
              <Text style={[type.body, styles.messageBody]}>
                {savedError?.message ??
                  'The app has no authenticated training API connection in this build. Nothing local is being presented as server-backed coaching.'}
              </Text>
              {localOnly ? (
                <View style={styles.retryWrap}>
                  <Button
                    label="Connect account"
                    variant="dark"
                    onPress={() => navigation.navigate('ConnectAccount')}
                  />
                </View>
              ) : null}
            </Card>
          ) : savedStatus === 'error' ? (
            <Card tone="soft" style={styles.messageCard}>
              <Text style={[type.h2, styles.messageTitle]}>
                Training is offline.
              </Text>
              <Text style={[type.body, styles.messageBody]}>
                {savedError?.message ?? 'Saved drills could not be verified.'}
              </Text>
              <View style={styles.retryWrap}>
                <Button
                  label="Try again"
                  variant="secondary"
                  onPress={() => void loadSavedDrills()}
                />
              </View>
            </Card>
          ) : savedDrills.length === 0 ? (
            <View style={styles.emptySaved}>
              <EmptyState
                title="No saved drills yet."
                body="When the server can match a synced score to published, reviewed work, save those drills here for later."
              />
            </View>
          ) : verifiedSavedDrills.length === 0 ? (
            <Card tone="soft" style={styles.messageCard}>
              <View style={styles.messageIcon}>
                <Icon name="shield" size={22} color={color.court} />
              </View>
              <Text style={[type.h2, styles.messageTitle]}>
                Saved entries couldn’t be verified right now.
              </Text>
              <Text style={[type.body, styles.messageBody]}>
                {savedDrills.length} saved{' '}
                {savedDrills.length === 1 ? 'entry is' : 'entries are'} hidden
                because {savedDrills.length === 1 ? 'its' : 'their'} server
                catalog {savedDrills.length === 1 ? 'entry' : 'entries'} could
                not be loaded. Nothing is shown from guesses and no generic
                drill is substituted.
              </Text>
              <View style={styles.retryWrap}>
                <Button
                  label="Try again"
                  variant="secondary"
                  onPress={() => void loadSavedDrills()}
                />
              </View>
            </Card>
          ) : (
            <>
              <View style={styles.savedHeading}>
                <Text
                  numberOfLines={2}
                  style={[type.h3, styles.savedHeadingTitle]}
                >
                  Saved drills
                </Text>
                <Text style={[type.caption, { color: color.inkSoft }]}>
                  {verifiedSavedDrills.length} saved
                </Text>
              </View>
              {verifiedSavedDrills.map(drill => (
                <SavedDrillCard
                  key={drill.slug}
                  drill={drill}
                  detail={drillDetails[drill.slug]}
                  busy={mutation !== 'idle'}
                  onUnsave={() => void setDrillSaved(drill.slug, false)}
                  onOpenMedia={media => void openMedia(media)}
                />
              ))}
              {heldSavedCount > 0 ? (
                <View style={styles.heldNotice}>
                  <Icon name="shield" size={17} color={color.inkSoft} />
                  <Text style={[type.caption, styles.heldNoticeCopy]}>
                    {heldSavedCount} additional saved{' '}
                    {heldSavedCount === 1 ? 'entry is' : 'entries are'} hidden
                    because {heldSavedCount === 1 ? 'its' : 'their'} server
                    catalog {heldSavedCount === 1 ? 'entry' : 'entries'} could
                    not be loaded.
                  </Text>
                </View>
              ) : null}
            </>
          )}

          {mutationError ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={mutationError.message}
              accessibilityHint={MUTATION_ERROR_DISMISS_HINT}
              onPress={clearMutationError}
              style={styles.inlineError}
            >
              <Icon name="close" size={18} color={color.bad} />
              <Text style={[type.caption, { color: color.bad, flex: 1 }]}>
                {mutationError.message}
              </Text>
              <Text style={[type.micro, { color: color.bad }]}>DISMISS</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (loadError && ownsLoadedData) {
    return (
      <SafeAreaView edges={['top']} style={styles.screen}>
        <StatusBar barStyle="dark-content" />
        <ScrollView
          {...tabBarDock}
          contentContainerStyle={[
            styles.readsContent,
            { paddingBottom: tabBarInset },
          ]}
          showsVerticalScrollIndicator={false}
        >
          {header}
          <View accessibilityLiveRegion="assertive" accessibilityRole="alert">
            <Card tone="soft" style={styles.messageCard}>
              <View style={[styles.messageIcon, styles.messageIconBad]}>
                <Icon name="close" size={22} color={color.bad} />
              </View>
              <Text style={[type.h2, styles.messageTitle]}>
                {READS_LOAD_ERROR_TITLE}
              </Text>
              <Text style={[type.body, styles.messageBody]}>
                {READS_LOAD_ERROR_BODY}
              </Text>
              <View style={styles.retryWrap}>
                <Button
                  label="Try again"
                  variant="secondary"
                  onPress={retryReads}
                />
              </View>
            </Card>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['top']} style={styles.screen}>
      <StatusBar barStyle="dark-content" />
      {shots === null || loadError || !ownsLoadedData ? (
        <ScrollView
          {...tabBarDock}
          contentContainerStyle={[
            styles.readsContent,
            styles.emptyContent,
            { paddingBottom: tabBarInset },
          ]}
          showsVerticalScrollIndicator={false}
        >
          {header}
          <LoadingState label="Opening your library…" />
        </ScrollView>
      ) : (
        <FlatList
          {...tabBarDock}
          data={reads}
          keyExtractor={item => item.id}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[
            styles.readsContent,
            reads.length === 0 && captures.length === 0 && styles.emptyContent,
            { paddingBottom: tabBarInset },
          ]}
          ListHeaderComponent={
            <>
              {header}
              {reads.length || captures.length ? (
                <View style={styles.readHeader}>
                  <Text style={[type.body, { color: color.inkSoft }]}>
                    {reads.length} analyzed {plural(reads.length, 'read')} ·{' '}
                    {captures.length} pending {plural(captures.length, 'clip')}
                  </Text>
                  {captures.length ? (
                    <View style={styles.pendingGroup}>
                      <View style={styles.pendingHeader}>
                        <Text
                          numberOfLines={2}
                          style={[type.micro, styles.pendingHeaderLabel]}
                        >
                          {PENDING_SECTION_LABEL}
                        </Text>
                        <Pill label={PENDING_SECTION_PILL} tone="neutral" />
                      </View>
                      {captures.map(capture => {
                        const action = pendingCaptureActionLabel(capture);
                        const title = pendingCaptureTitle(capture);
                        const content = (
                          <>
                            <DateTile iso={capture.capturedAtIso} />
                            <View style={styles.flex}>
                              <Text
                                numberOfLines={1}
                                style={[type.bodyBold, styles.pendingTitle]}
                              >
                                {title}
                              </Text>
                              <Text
                                numberOfLines={2}
                                style={[type.caption, styles.pendingMeta]}
                              >
                                {formatClipDuration(capture.durationMs)} ·{' '}
                                {pendingEvidenceCopy(capture)}
                              </Text>
                              {action ? (
                                <Text
                                  numberOfLines={1}
                                  style={[type.caption, styles.pendingAction]}
                                >
                                  {action}
                                </Text>
                              ) : null}
                            </View>
                            {action ? (
                              <Icon
                                name="chevron"
                                size={18}
                                color={color.inkSoft}
                              />
                            ) : null}
                          </>
                        );
                        // Read-only clips are plain rows: nothing to tap, so
                        // nothing pretends to be tappable.
                        if (!action) {
                          return (
                            <View key={capture.id} style={styles.pendingRow}>
                              {content}
                            </View>
                          );
                        }
                        return (
                          <PressableScale
                            key={capture.id}
                            testID={
                              capture.techniqueConfirmation
                                ? `open-saved-confirmation-${capture.id}`
                                : `open-saved-original-${capture.id}`
                            }
                            accessibilityLabel={`${action}: ${title}`}
                            accessibilityHint="Reopens this saved clip without starting a rating."
                            onPress={() => {
                              if (
                                !loadedOwner ||
                                loadedOwner.ticket !== loadTicket.current ||
                                !isDataOwnerContextCurrent(ownerEpoch) ||
                                navigation.isFocused?.() === false
                              )
                                return;
                              navigation.navigate('Analyze', {
                                captureId: capture.id,
                                ...(capture.techniqueConfirmation
                                  ? {}
                                  : { mode: 'original' as const }),
                              });
                            }}
                            style={styles.pendingRow}
                          >
                            {content}
                          </PressableScale>
                        );
                      })}
                      <Text style={[type.caption, styles.pendingNote]}>
                        {PENDING_SECTION_NOTE}
                      </Text>
                    </View>
                  ) : null}
                  <Text
                    style={styles.readOrderCaption}
                    testID="library-read-order"
                  >
                    ALL STROKES · NEWEST FIRST
                  </Text>
                </View>
              ) : null}
            </>
          }
          ListEmptyComponent={
            <EmptyState
              title="Your measured reads, in one place."
              body="Validated analyses appear here with their real score and model trace. Unscored captures stay clearly marked."
              action={
                <Button
                  label="Analyze your first stroke"
                  variant="dark"
                  icon="camera"
                  onPress={() => navigation.navigate('Analyze')}
                />
              }
            />
          }
          renderItem={({ item, index }) => (
            <PressableScale
              accessibilityLabel={`Open ${item.shotType.replace(
                /_/g,
                ' ',
              )} result${
                item.resultKind !== 'low_confidence' &&
                item.overallScore !== null
                  ? `, ${duprAccessibilityLabel(item.overallScore)}`
                  : ''
              }`}
              onPress={() =>
                navigation.navigate('Result', { analysisId: item.id })
              }
              style={styles.row}
            >
              <DateTile iso={item.capturedAt} />
              <View style={styles.flex}>
                <Text numberOfLines={2} style={[type.h3, styles.strokeName]}>
                  {item.shotType.replace(/_/g, ' ')}
                </Text>
                <Text numberOfLines={1} style={[type.caption, styles.readMeta]}>
                  Read {String(reads.length - index).padStart(2, '0')} ·{' '}
                  {new Date(item.capturedAt).toLocaleTimeString(undefined, {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </Text>
              </View>
              {item.resultKind === 'low_confidence' ? (
                <View style={styles.notRead}>
                  <Icon name="camera" size={17} color={color.warn} />
                  <Text style={[type.micro, { color: color.ink }]}>
                    NOT READ
                  </Text>
                </View>
              ) : item.overallScore !== null ? (
                <DuprReadout
                  score={item.overallScore}
                  valueStyle={styles.score}
                  accessible={false}
                />
              ) : null}
              <Icon name="chevron" size={18} color={color.inkSoft} />
            </PressableScale>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  flex: { flex: 1 },
  pageHeader: { paddingTop: space.xl, marginBottom: space.lg },
  pageTitle: { color: color.ink },
  pageSubtitle: { color: color.inkSoft, marginTop: space.sm, maxWidth: 340 },
  segmentedControl: {
    flexDirection: 'row',
    backgroundColor: color.surfaceAlt,
    borderRadius: radius.pill,
    padding: 4,
    marginTop: space.lg,
  },
  segment: {
    flex: 1,
    minHeight: 46,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentSelected: { backgroundColor: color.ink },
  readsContent: { paddingHorizontal: space.lg },
  savedContent: { paddingHorizontal: space.lg },
  emptyContent: { flexGrow: 1 },
  readHeader: { marginBottom: space.lg },
  readOrderCaption: {
    ...type.caption,
    color: color.inkSoft,
    marginTop: space.lg,
  },
  pendingGroup: {
    borderRadius: radius.lg,
    backgroundColor: color.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    marginTop: space.lg,
    padding: space.md,
  },
  pendingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    paddingBottom: space.sm,
  },
  pendingHeaderLabel: { color: color.inkSoft, flex: 1, flexShrink: 1 },
  // Same anatomy as a read row (date tile · title/meta · trailing) so the two
  // lists read as one library; only the trailing chevron marks a row that
  // reopens something.
  pendingRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
  },
  // No 'capitalize' here: pendingCaptureTitle already carries final casing
  // ('Forehand Drive · auto capture').
  pendingTitle: { color: color.ink },
  pendingMeta: { color: color.inkSoft, marginTop: 2 },
  pendingAction: { color: color.court, marginTop: 4 },
  pendingNote: {
    color: color.inkSoft,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
    paddingTop: space.sm,
  },
  row: {
    minHeight: 104,
    borderRadius: radius.lg,
    backgroundColor: color.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    paddingHorizontal: space.md,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  dateBlock: {
    width: 48,
    height: 58,
    borderRadius: radius.md,
    backgroundColor: color.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dateNumber: {
    color: color.ink,
    fontVariant: ['tabular-nums'],
  },
  strokeName: { color: color.ink, textTransform: 'capitalize' },
  readMeta: { color: color.inkSoft, marginTop: 3 },
  score: { ...type.score, color: color.ink },
  notRead: { alignItems: 'center', gap: 4 },
  planSummary: {
    minHeight: 226,
    borderRadius: radius.xl,
    backgroundColor: color.surfaceDark,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineDark,
    padding: space.lg,
    marginBottom: space.lg,
  },
  planSummaryTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  planSummaryLabel: { color: color.volt, flex: 1, flexShrink: 1 },
  planTitle: {
    color: color.onDark,
    textTransform: 'capitalize',
    marginTop: space.lg,
  },
  planCopy: {
    color: color.onDarkMuted,
    textTransform: 'capitalize',
    marginTop: space.sm,
  },
  planProgressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: color.lineDark,
    overflow: 'hidden',
    marginTop: space.lg,
  },
  planProgressFill: { height: '100%', backgroundColor: color.volt },
  openPlanRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    marginTop: space.lg,
  },
  openPlanLabel: { color: color.onDark, flex: 1, flexShrink: 1 },
  exploreCard: {
    minHeight: 84,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderRadius: radius.lg,
    backgroundColor: color.surfaceElevated,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    marginBottom: space.lg,
  },
  exploreIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: color.courtSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  exploreCopy: { color: color.inkSoft, marginTop: 2 },
  stateBlock: { minHeight: 260 },
  messageCard: { padding: space.lg, marginBottom: space.lg },
  messageIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: color.courtSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  messageIconBad: { backgroundColor: color.badSoft },
  messageTitle: { color: color.ink, marginTop: space.lg },
  messageBody: { color: color.inkSoft, marginTop: space.sm },
  retryWrap: { marginTop: space.lg },
  emptySaved: { minHeight: 310, justifyContent: 'center' },
  savedHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    marginBottom: space.md,
  },
  savedHeadingTitle: { color: color.ink, flex: 1, flexShrink: 1 },
  inlineError: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    borderRadius: radius.md,
    backgroundColor: color.badSoft,
    padding: space.md,
    marginTop: space.sm,
  },
  heldNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingHorizontal: space.sm,
    marginTop: space.sm,
  },
  heldNoticeCopy: { color: color.inkSoft, flex: 1 },
});
