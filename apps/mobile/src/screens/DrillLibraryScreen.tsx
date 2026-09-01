import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  Easing,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useApiSessionStore } from '../account/apiSession';
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  Page,
  PressableScale,
  ScreenHeader,
  useReducedMotion,
} from '../design/components';
import { Icon } from '../design/icons';
import { useReliableSafeAreaInsets } from '../design/safeArea';
import { color, radius, shadow, space, type } from '../design/tokens';
import type { RootStackParams } from '../navigation/params';
import { DrillVideoPlayer } from '../components/DrillVideoPlayer';
import { getDb } from '../data/db';
import { listScoredCheckpointFacts } from '../data/repository';
import {
  checkpointDisplayName,
  computeLibraryFocus,
  familyDisplayLabel,
  focusEvidenceLine,
  recommendDrills,
  type LibraryFocus,
} from '../library/libraryFocus';
import { createTrainingApi, type CatalogDrill } from '../training/api';
import {
  TrainingError,
  type DrillDetail,
  type DrillMapping,
  type InstructionalMedia,
} from '../training/types';

/**
 * The drill library as a learning surface, not a database browser.
 *
 * The default view sorts itself around the player: a focus card names their
 * weakest sufficiently-evidenced checkpoint (computed on this device from
 * their own scored analyses — see library/libraryFocus.ts for the honesty
 * rules), family-matched drills are recommended under it, and the rest of
 * the catalog follows. Searching or filtering switches to plain results.
 *
 * Every drill card leads with form content: the expanded detail shows the
 * server's coaching cues (checkpoint, cue text, practice targets) before any
 * video. Instructional media stays attributed third-party video — creator
 * and attribution rendered verbatim, playback in-app via DrillVideoPlayer,
 * the original source one tap away. It is never framed as Pickle Sensei's
 * own coaching, and internal draft bylines never render.
 *
 * Browse rows are plain deep links to real YouTube search results at the
 * source: every expanded drill offers "More drills on YouTube", and an
 * active search query adds a top-level row that searches all of YouTube.
 * Those are results pages, so they intentionally stay external. No video IDs
 * or counts are ever fabricated client-side.
 */

const SEARCH_DEBOUNCE_MS = 250;
const TOAST_DISMISS_MS = 2500;

/** Internal seeding byline that must never render in the product UI. */
const DRAFT_BYLINE_PATTERN = /engineering draft/i;

const FAMILIES = [
  'dink',
  'volley',
  'drive',
  'serve',
  'return',
  'drop_reset',
  'global',
] as const;

function difficultyLabel(drill: CatalogDrill): string | null {
  if (drill.difficultyMin && drill.difficultyMax) {
    return drill.difficultyMin === drill.difficultyMax
      ? `Skill ${drill.difficultyMin}`
      : `Skill ${drill.difficultyMin}–${drill.difficultyMax}`;
  }
  if (drill.difficultyMin) return `Skill ${drill.difficultyMin}+`;
  if (drill.difficultyMax) return `Skill up to ${drill.difficultyMax}`;
  return null;
}

function equipmentLabel(equipment: string[]): string | null {
  if (equipment.length === 0) return null;
  const joined = equipment.join(', ').toLowerCase();
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/** One quiet metadata line replaces the old pill row + equipment row. */
function drillMetaLine(drill: CatalogDrill): string | null {
  const family = drill.families[0] ?? null;
  const parts = [
    family ? familyDisplayLabel(family) : null,
    difficultyLabel(drill),
    equipmentLabel(drill.equipment),
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** "3 sets × 10 · rest 30s" — only from fields the mapping actually carries. */
function mappingTargetLine(mapping: DrillMapping): string | null {
  const sets =
    mapping.targetRepetitionsPerSet !== null
      ? `${mapping.targetSets} × ${mapping.targetRepetitionsPerSet}`
      : mapping.targetDurationSeconds !== null
      ? `${mapping.targetSets} × ${mapping.targetDurationSeconds}s`
      : `${mapping.targetSets} set${mapping.targetSets === 1 ? '' : 's'}`;
  const parts = [sets];
  if (mapping.restSeconds !== null) parts.push(`rest ${mapping.restSeconds}s`);
  return parts.join(' · ');
}

function matchesQuery(drill: CatalogDrill, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [drill.title, drill.description, ...drill.equipment]
    .join(' ')
    .toLowerCase()
    .includes(needle);
}

function toMessage(error: unknown): string {
  return error instanceof TrainingError
    ? error.message
    : 'The drill catalog is temporarily unavailable.';
}

/**
 * Every playable media entry, mirroring firstPlayableMedia's expiry rule in
 * training/components exactly: embeds are always playable, hosted files only
 * while their signed playback URL is unexpired.
 */
function playableMediaList(
  detail: DrillDetail | null,
  now = Date.now(),
): InstructionalMedia[] {
  if (!detail) return [];
  return detail.instructionalMedia.filter(media =>
    media.kind === 'hosted' ? new Date(media.expiresAt).getTime() > now : true,
  );
}

/**
 * Real YouTube search-results deep link. This is the honest route to
 * "hundreds more" videos: YouTube's own corpus queried at the source — no
 * fabricated video IDs or counts on our side.
 */
function youtubeSearchUrl(topic: string): string {
  return (
    'https://www.youtube.com/results?search_query=' +
    encodeURIComponent(`${topic} pickleball drill`)
  );
}

type DetailState =
  | { status: 'loading' }
  | { status: 'ready'; detail: DrillDetail }
  | { status: 'error'; message: string };

/** Soft entrance for the expanded form guide: quick fade + settle, skipped
 * entirely under reduced motion. Transform/opacity only. */
function DetailReveal(props: { children: React.ReactNode }) {
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

/** The personalized header: the player's weakest evidenced checkpoint. */
function FocusCard(props: { focus: LibraryFocus }) {
  const { focus } = props;
  const width = Math.max(0, Math.min(100, focus.averageScore));
  return (
    <Card tone="dark" style={styles.focusCard} testID="library-focus">
      <Text style={[type.micro, styles.focusEyebrow]}>YOUR FOCUS</Text>
      <View style={styles.focusTitleRow}>
        <Text style={[type.h2, styles.focusTitle]}>
          {checkpointDisplayName(focus.checkpoint)}
        </Text>
        <Text style={[type.h2, styles.focusScore]}>
          {String(focus.averageScore)}
        </Text>
      </View>
      <Text style={[type.caption, styles.focusMeta]}>
        {focusEvidenceLine(focus)}
      </Text>
      <View
        accessibilityLabel={`Recent average ${focus.averageScore} out of 100`}
        style={styles.focusTrack}
      >
        <View style={[styles.focusFill, { width: `${width}%` }]} />
      </View>
    </Card>
  );
}

function DrillCard(props: {
  drill: CatalogDrill;
  expanded: boolean;
  detail: DetailState | undefined;
  savePending: boolean;
  onToggleExpanded: () => void;
  onToggleSaved: () => void;
  onRetryDetail: () => void;
  onOpenMedia: (media: InstructionalMedia) => void;
  onBrowseVideos: () => void;
}) {
  const { drill } = props;
  const coachByline = DRAFT_BYLINE_PATTERN.test(drill.coachName)
    ? null
    : drill.coachName;
  const metaLine = drillMetaLine(drill);
  const detail = props.detail;
  const readyDetail = detail?.status === 'ready' ? detail.detail : null;
  const mediaList = playableMediaList(readyDetail);
  return (
    <Card style={styles.drillCard} testID={`drill-card-${drill.slug}`}>
      <View style={styles.cardTop}>
        <View style={styles.cardHeading}>
          <Text style={[type.h3, styles.drillTitle]}>{drill.title}</Text>
          {metaLine ? (
            <Text numberOfLines={1} style={[type.caption, styles.metaLine]}>
              {metaLine}
            </Text>
          ) : null}
        </View>
        <PressableScale
          testID={`save-toggle-${drill.slug}`}
          accessibilityLabel={
            drill.saved
              ? `Remove ${drill.title} from saved drills`
              : `Save ${drill.title}`
          }
          accessibilityState={{ selected: drill.saved }}
          disabled={props.savePending}
          onPress={props.onToggleSaved}
          containerStyle={styles.bookmarkContainer}
          style={[
            styles.bookmarkButton,
            drill.saved && styles.bookmarkButtonSaved,
          ]}
        >
          <Icon
            name="bookmark"
            size={19}
            color={drill.saved ? color.court : color.inkSoft}
          />
        </PressableScale>
      </View>
      <PressableScale
        accessibilityLabel={`${props.expanded ? 'Hide' : 'Show'} detail for ${
          drill.title
        }`}
        accessibilityState={{ expanded: props.expanded }}
        onPress={props.onToggleExpanded}
        style={styles.cardBody}
      >
        <Text numberOfLines={3} style={[type.caption, styles.description]}>
          {drill.description}
        </Text>
        {coachByline ? (
          <Text style={[type.caption, styles.coachLine]}>{coachByline}</Text>
        ) : null}
        {/* Explicit expand affordance: without it, cards read as static
            text and nobody discovers the form guide one tap away. */}
        <View style={styles.expandCta}>
          <Text style={[type.bodyBold, styles.expandCtaText]}>
            {props.expanded ? 'Hide form guide' : 'Form guide & videos'}
          </Text>
          <View style={props.expanded ? styles.chevronUp : styles.chevronDown}>
            <Icon name="chevron" size={16} color={color.inkSoft} />
          </View>
        </View>
      </PressableScale>
      {props.expanded ? (
        <DetailReveal>
          <View style={styles.detailWrap}>
            {!detail || detail.status === 'loading' ? (
              <Text style={[type.caption, styles.detailMuted]}>
                Loading drill detail…
              </Text>
            ) : detail.status === 'error' ? (
              <View style={styles.detailError}>
                <Icon name="close" size={16} color={color.bad} />
                <Text style={[type.caption, styles.detailErrorText]}>
                  Drill detail could not be loaded from this deployment.{' '}
                  {detail.message}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Retry detail for ${drill.title}`}
                  onPress={props.onRetryDetail}
                  style={({ pressed }) => [pressed && styles.pressed]}
                >
                  <Text style={[type.caption, styles.detailRetry]}>
                    Try again
                  </Text>
                </Pressable>
              </View>
            ) : (
              <>
                {readyDetail && readyDetail.mappings.length > 0 ? (
                  <View style={styles.cueBlock}>
                    <Text style={[type.micro, styles.detailLabel]}>
                      FORM FOCUS
                    </Text>
                    {readyDetail.mappings.map((mapping, index) => {
                      const targets = mappingTargetLine(mapping);
                      return (
                        <View
                          key={`${mapping.checkpoint}-${index}`}
                          style={styles.cueRow}
                        >
                          <View style={styles.cueDot} />
                          <View style={styles.cueCopy}>
                            <Text style={[type.bodyBold, styles.cueText]}>
                              {mapping.cueText}
                            </Text>
                            <Text style={[type.caption, styles.cueMeta]}>
                              {[
                                checkpointDisplayName(mapping.checkpoint),
                                targets,
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </Text>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                ) : null}
                {mediaList.length > 0 ? (
                  <Text style={[type.micro, styles.detailLabel]}>
                    WATCH IT DONE
                  </Text>
                ) : null}
                {mediaList.map((media, index) => (
                  <PressableScale
                    key={media.id}
                    testID={`watch-media-${drill.slug}-${index}`}
                    accessibilityLabel={`Watch demonstration for ${drill.title}`}
                    accessibilityHint={media.attribution}
                    onPress={() => props.onOpenMedia(media)}
                    style={styles.mediaRow}
                  >
                    <View style={styles.playIcon}>
                      <Icon name="play" size={18} color={color.onVolt} />
                    </View>
                    <View style={styles.mediaCopy}>
                      <Text style={[type.bodyBold, styles.mediaTitle]}>
                        Watch demonstration
                      </Text>
                      <Text style={[type.caption, styles.mediaCreator]}>
                        {media.creatorName}
                      </Text>
                      {/* Attribution is a license obligation: always shown verbatim. */}
                      <Text style={[type.caption, styles.mediaAttribution]}>
                        {media.attribution}
                      </Text>
                    </View>
                    <Icon name="chevron" size={16} color={color.inkSoft} />
                  </PressableScale>
                ))}
                {mediaList.length > 0 ? (
                  <Text style={[type.micro, styles.mediaDisclosure]}>
                    Community videos · credited to their creators
                  </Text>
                ) : null}
                {/* Honest discovery: a real YouTube search-results page for
                    this drill, so it opens externally by design. */}
                <PressableScale
                  testID={`browse-videos-${drill.slug}`}
                  accessibilityLabel={`Browse YouTube videos for ${drill.title}`}
                  onPress={props.onBrowseVideos}
                  style={styles.mediaRow}
                >
                  <View style={styles.browseIcon}>
                    <Icon name="library" size={18} color={color.ink} />
                  </View>
                  <View style={styles.mediaCopy}>
                    <Text style={[type.bodyBold, styles.mediaTitle]}>
                      More drills on YouTube
                    </Text>
                    <Text style={[type.caption, styles.mediaCreator]}>
                      Opens the YouTube app
                    </Text>
                  </View>
                  <Icon name="arrow" size={18} color={color.inkSoft} />
                </PressableScale>
              </>
            )}
          </View>
        </DetailReveal>
      ) : null}
    </Card>
  );
}

export function DrillLibraryScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const session = useApiSessionStore(state => state.session);
  const api = useMemo(
    () =>
      createTrainingApi({
        baseUrl: session?.apiBaseUrl,
        token: session?.bearerToken,
      }),
    [session?.apiBaseUrl, session?.bearerToken],
  );

  const [drills, setDrills] = useState<CatalogDrill[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [family, setFamily] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [pendingSaves, setPendingSaves] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, DetailState>>({});
  const [playerMedia, setPlayerMedia] = useState<InstructionalMedia | null>(
    null,
  );
  const [toast, setToast] = useState<string | null>(null);
  /** undefined = still reading local evidence; null = no honest focus. */
  const [focus, setFocus] = useState<LibraryFocus | null | undefined>(
    undefined,
  );
  const requestIdRef = useRef(0);
  const hasLoadedRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastOpacity = useRef(new Animated.Value(0)).current;
  /** Synchronous single-flight guard for save mutations. `pendingSaves` is
   * state (drives the disabled UI) and only flushes between events, so a
   * same-tick double-fire could slip past it — this ref cannot. */
  const inFlightSavesRef = useRef<Set<string>>(new Set());
  const insets = useReliableSafeAreaInsets();

  /**
   * Non-blocking save confirmation: fades in at the bottom, never captures
   * touches or accessibility focus, and dismisses itself.
   */
  const showToast = useCallback(
    (message: string) => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      setToast(message);
      toastOpacity.setValue(0);
      Animated.timing(toastOpacity, {
        toValue: 1,
        duration: 160,
        useNativeDriver: true,
      }).start();
      toastTimerRef.current = setTimeout(
        () => setToast(null),
        TOAST_DISMISS_MS,
      );
    },
    [toastOpacity],
  );

  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    const handle = setTimeout(
      () => setDebouncedQuery(query),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(handle);
  }, [query]);

  // The focus is computed from local evidence only — it never blocks the
  // catalog, and any read failure quietly resolves to "no focus".
  const loadFocus = useCallback(async () => {
    try {
      const facts = await listScoredCheckpointFacts(getDb());
      setFocus(computeLibraryFocus(facts));
    } catch {
      setFocus(null);
    }
  }, []);

  useEffect(() => {
    void loadFocus();
  }, [loadFocus]);

  const load = useCallback(
    async (mode: 'initial' | 'update' | 'refresh') => {
      const requestId = ++requestIdRef.current;
      if (mode === 'initial') {
        setDrills(null);
        setLoadError(null);
      } else if (mode === 'refresh') {
        setRefreshing(true);
        void loadFocus();
      }
      try {
        const items = await api.listCatalogDrills({
          q: debouncedQuery.trim() || undefined,
          family: family ?? undefined,
        });
        if (requestId !== requestIdRef.current) return;
        hasLoadedRef.current = true;
        setDrills(items);
        setLoadError(null);
      } catch (error) {
        if (requestId !== requestIdRef.current) return;
        if (mode === 'initial') setLoadError(toMessage(error));
        else setInlineError(toMessage(error));
      } finally {
        if (requestId === requestIdRef.current) setRefreshing(false);
      }
    },
    [api, debouncedQuery, family, loadFocus],
  );

  useEffect(() => {
    void load(hasLoadedRef.current ? 'update' : 'initial');
  }, [load]);

  const toggleSaved = useCallback(
    async (drill: CatalogDrill) => {
      if (pendingSaves.has(drill.slug)) return;
      if (inFlightSavesRef.current.has(drill.slug)) return;
      inFlightSavesRef.current.add(drill.slug);
      const nextSaved = !drill.saved;
      setInlineError(null);
      setPendingSaves(prev => new Set(prev).add(drill.slug));
      const applySaved = (saved: boolean) =>
        setDrills(
          prev =>
            prev?.map(item =>
              item.slug === drill.slug ? { ...item, saved } : item,
            ) ?? prev,
        );
      applySaved(nextSaved);
      try {
        if (nextSaved) await api.saveDrill(drill.slug);
        else await api.unsaveDrill(drill.slug);
        showToast(
          nextSaved
            ? 'Saved to your library · Library → Saved drills'
            : 'Removed from saved drills',
        );
      } catch (error) {
        applySaved(drill.saved);
        setInlineError(toMessage(error));
      } finally {
        inFlightSavesRef.current.delete(drill.slug);
        setPendingSaves(prev => {
          const next = new Set(prev);
          next.delete(drill.slug);
          return next;
        });
      }
    },
    [api, pendingSaves, showToast],
  );

  const loadDetail = useCallback(
    async (slug: string) => {
      setDetails(prev => ({ ...prev, [slug]: { status: 'loading' } }));
      try {
        const detail = await api.getDrill(slug);
        setDetails(prev => ({ ...prev, [slug]: { status: 'ready', detail } }));
      } catch (error) {
        setDetails(prev => ({
          ...prev,
          [slug]: { status: 'error', message: toMessage(error) },
        }));
      }
    },
    [api],
  );

  const toggleExpanded = useCallback(
    (slug: string) => {
      const alreadyExpanded = expandedSlug === slug;
      setExpandedSlug(alreadyExpanded ? null : slug);
      if (!alreadyExpanded && details[slug] === undefined) {
        void loadDetail(slug);
      }
    },
    [details, expandedSlug, loadDetail],
  );

  // YouTube search-results pages only. Instructional videos themselves play
  // in-app via DrillVideoPlayer; results pages have no embed form, so they
  // open at the source (YouTube app or browser).
  const openExternal = useCallback(async (url: string) => {
    try {
      await Linking.openURL(url);
    } catch {
      setInlineError('YouTube could not be opened on this device.');
    }
  }, []);

  const visibleDrills = useMemo(
    () => (drills ?? []).filter(drill => matchesQuery(drill, debouncedQuery)),
    [debouncedQuery, drills],
  );

  // An active search also gets a real all-of-YouTube search deep link, so
  // every query reaches YouTube's full corpus — honestly, at the source.
  const youtubeQuery = debouncedQuery.trim();

  // Personalized sections render only on the untouched default view; any
  // search or family filter switches to plain, predictable results.
  const filtered = youtubeQuery.length > 0 || family !== null;
  const recommended = useMemo(
    () => (!filtered && focus ? recommendDrills(visibleDrills, focus) : []),
    [filtered, focus, visibleDrills],
  );
  const recommendedSlugs = useMemo(
    () => new Set(recommended.map(drill => drill.slug)),
    [recommended],
  );
  const catalogDrills = useMemo(
    () =>
      recommended.length > 0
        ? visibleDrills.filter(drill => !recommendedSlugs.has(drill.slug))
        : visibleDrills,
    [recommended.length, recommendedSlugs, visibleDrills],
  );

  const renderDrill = (drill: CatalogDrill) => (
    <DrillCard
      key={drill.slug}
      drill={drill}
      expanded={expandedSlug === drill.slug}
      detail={details[drill.slug]}
      savePending={pendingSaves.has(drill.slug)}
      onToggleExpanded={() => toggleExpanded(drill.slug)}
      onToggleSaved={() => void toggleSaved(drill)}
      onRetryDetail={() => void loadDetail(drill.slug)}
      onOpenMedia={setPlayerMedia}
      onBrowseVideos={() => void openExternal(youtubeSearchUrl(drill.title))}
    />
  );

  let content: React.ReactNode;
  if (drills === null && loadError === null) {
    content = <LoadingState label="Loading the drill catalog…" />;
  } else if (drills === null) {
    content = (
      <ErrorState
        title="The drill catalog could not load."
        detail={loadError ?? 'The drill catalog is temporarily unavailable.'}
        onRetry={() => void load('initial')}
      />
    );
  } else {
    content = (
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[
          styles.listContent,
          visibleDrills.length === 0 && styles.listContentEmpty,
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load('refresh')}
            tintColor={color.court}
          />
        }
      >
        {filtered ? (
          <Text style={[type.caption, styles.resultCount]}>
            {`${visibleDrills.length} of ${drills.length} drill${
              drills.length === 1 ? '' : 's'
            }`}
          </Text>
        ) : null}
        {inlineError ? (
          <Pressable
            accessibilityRole="alert"
            accessibilityLabel="Dismiss error"
            onPress={() => setInlineError(null)}
            style={styles.inlineError}
          >
            <Icon name="close" size={16} color={color.bad} />
            <Text style={[type.caption, styles.inlineErrorText]}>
              {inlineError}
            </Text>
          </Pressable>
        ) : null}
        {!filtered && focus ? <FocusCard focus={focus} /> : null}
        {!filtered && focus === null ? (
          <View style={styles.focusHint} testID="library-focus-hint">
            <Icon name="spark" size={17} color={color.court} />
            <Text style={[type.caption, styles.focusHintText]}>
              After two scored analyses of the same technique, this library
              sorts itself around your weakest checkpoint.
            </Text>
          </View>
        ) : null}
        {recommended.length > 0 ? (
          <>
            <Text style={[type.h3, styles.sectionTitle]}>
              Recommended for you
            </Text>
            <Text style={[type.caption, styles.sectionCaption]}>
              Matched to your focus by technique family.
            </Text>
            {recommended.map(renderDrill)}
            {catalogDrills.length > 0 ? (
              <Text style={[type.h3, styles.sectionTitle]}>All drills</Text>
            ) : null}
          </>
        ) : null}
        {visibleDrills.length === 0 ? (
          <EmptyState
            title="No drills match"
            body="Try a different search or family filter."
          />
        ) : (
          catalogDrills.map(renderDrill)
        )}
      </ScrollView>
    );
  }

  return (
    <Page>
      <ScreenHeader title="Drill Library" onBack={() => navigation.goBack()} />
      <View style={styles.controls}>
        <View style={styles.searchPill}>
          <TextInput
            testID="drill-search-input"
            accessibilityLabel="Search drills"
            value={query}
            onChangeText={setQuery}
            placeholder="Search drills, equipment…"
            placeholderTextColor={color.inkSoft}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            style={styles.searchInput}
          />
          {query.length > 0 ? (
            <PressableScale
              accessibilityLabel="Clear search"
              onPress={() => setQuery('')}
              hitSlop={8}
              containerStyle={styles.clearContainer}
              style={styles.clearButton}
            >
              <Icon name="close" size={14} color={color.inkSoft} />
            </PressableScale>
          ) : null}
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.familyRow}
        >
          {[null, ...FAMILIES].map(value => {
            const selected = family === value;
            return (
              <Pressable
                key={value ?? 'all'}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={
                  value
                    ? `Filter ${value.replace(/_/g, ' ')} drills`
                    : 'Show all drill families'
                }
                onPress={() => setFamily(value)}
                style={({ pressed }) => [
                  styles.familyChip,
                  selected && styles.familyChipSelected,
                  pressed && styles.pressed,
                ]}
              >
                <Text
                  style={[
                    type.caption,
                    selected
                      ? styles.familyChipTextSelected
                      : styles.familyChipText,
                  ]}
                >
                  {value ? familyDisplayLabel(value) : 'All'}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
        {youtubeQuery.length > 0 ? (
          <PressableScale
            testID="search-youtube"
            accessibilityLabel={`Search YouTube: "${youtubeQuery}" pickleball drills`}
            onPress={() => void openExternal(youtubeSearchUrl(youtubeQuery))}
            style={[styles.mediaRow, styles.searchYoutubeRow]}
          >
            <View style={styles.browseIcon}>
              <Icon name="library" size={18} color={color.ink} />
            </View>
            <View style={styles.mediaCopy}>
              <Text
                numberOfLines={1}
                style={[type.bodyBold, styles.mediaTitle]}
              >
                {`Search YouTube: "${youtubeQuery}" pickleball drills`}
              </Text>
              <Text style={[type.caption, styles.mediaCreator]}>
                Search results on YouTube · community videos
              </Text>
            </View>
            <Icon name="arrow" size={18} color={color.inkSoft} />
          </PressableScale>
        ) : null}
      </View>
      {content}
      <DrillVideoPlayer
        media={playerMedia}
        onClose={() => setPlayerMedia(null)}
      />
      {toast ? (
        <Animated.View
          pointerEvents="none"
          accessibilityLiveRegion="polite"
          style={[
            styles.toast,
            { bottom: insets.bottom + space.lg, opacity: toastOpacity },
          ]}
        >
          <Text style={[type.caption, styles.toastText]}>{toast}</Text>
        </Animated.View>
      ) : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pressed: { opacity: 0.78 },
  controls: { paddingHorizontal: space.lg, paddingTop: space.sm },
  searchPill: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.surfaceElevated,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    paddingHorizontal: space.md,
  },
  searchInput: {
    ...type.body,
    flex: 1,
    color: color.ink,
    paddingVertical: space.sm,
  },
  clearContainer: { width: 28, borderRadius: 14 },
  clearButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: color.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  familyRow: {
    flexDirection: 'row',
    gap: space.sm,
    paddingVertical: space.md,
  },
  familyChip: {
    minHeight: 38,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
  },
  familyChipSelected: {
    backgroundColor: color.ink,
    borderColor: color.ink,
  },
  familyChipText: { color: color.inkSoft },
  familyChipTextSelected: { color: color.onDark },
  listContent: {
    paddingHorizontal: space.lg,
    paddingBottom: space.xxl,
  },
  listContentEmpty: { flexGrow: 1 },
  resultCount: { color: color.inkSoft, marginBottom: space.md },
  inlineError: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    borderRadius: radius.md,
    backgroundColor: color.badSoft,
    padding: space.md,
    marginBottom: space.md,
  },
  inlineErrorText: { color: color.bad, flex: 1 },
  focusCard: { marginBottom: space.md },
  focusEyebrow: { color: color.onDarkSubtle },
  focusTitleRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.sm,
    marginTop: space.sm,
  },
  focusTitle: { color: color.onDark, flex: 1 },
  focusScore: { color: color.volt, fontVariant: ['tabular-nums'] },
  focusMeta: { color: color.onDarkMuted, marginTop: space.xs },
  focusTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: color.lineDark,
    overflow: 'hidden',
    marginTop: space.md,
  },
  focusFill: {
    height: 4,
    borderRadius: 2,
    backgroundColor: color.volt,
  },
  focusHint: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    backgroundColor: color.surfaceAlt,
    borderRadius: radius.md,
    padding: space.md,
    marginBottom: space.md,
  },
  focusHintText: { color: color.inkSoft, flex: 1 },
  sectionTitle: { color: color.ink, marginTop: space.sm },
  sectionCaption: {
    color: color.inkSoft,
    marginTop: space.xxs,
    marginBottom: space.md,
  },
  drillCard: { padding: space.lg, marginBottom: 12 },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  cardHeading: { flex: 1 },
  bookmarkContainer: { width: 44, borderRadius: 22 },
  bookmarkButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: color.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bookmarkButtonSaved: { backgroundColor: color.courtSoft },
  cardBody: { alignItems: 'stretch' },
  drillTitle: { color: color.ink },
  metaLine: { color: color.inkSoft, marginTop: space.xs },
  description: { color: color.inkSoft, marginTop: space.sm },
  coachLine: { color: color.inkSoft, marginTop: space.sm },
  expandCta: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
    marginTop: space.md,
    paddingTop: space.xs,
  },
  expandCtaText: { color: color.court, flex: 1 },
  chevronDown: { transform: [{ rotate: '90deg' }] },
  chevronUp: { transform: [{ rotate: '-90deg' }] },
  detailWrap: { gap: space.sm },
  detailLabel: { color: color.inkSoft, marginTop: space.xs },
  detailMuted: { color: color.inkSoft },
  detailError: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
  },
  detailErrorText: { color: color.bad, flex: 1 },
  detailRetry: { color: color.court },
  cueBlock: { gap: space.sm },
  cueRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: color.voltSoft,
    borderRadius: radius.md,
    padding: space.md,
    gap: 10,
  },
  cueDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: color.court,
    marginTop: 7,
  },
  cueCopy: { flex: 1 },
  cueText: { color: color.ink },
  cueMeta: { color: color.inkSoft, marginTop: space.xxs },
  mediaRow: {
    minHeight: 66,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: color.surfaceAlt,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  playIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: color.volt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  browseIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: color.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchYoutubeRow: { marginBottom: space.sm },
  mediaCopy: { flex: 1 },
  mediaTitle: { color: color.ink },
  mediaCreator: { color: color.inkSoft, marginTop: 2 },
  mediaAttribution: { color: color.inkSoft, marginTop: 1 },
  mediaDisclosure: { color: color.inkSoft },
  toast: {
    ...shadow.floating,
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    backgroundColor: color.inkElevated,
    borderRadius: radius.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  toastText: { color: color.onDark, textAlign: 'center' },
});
