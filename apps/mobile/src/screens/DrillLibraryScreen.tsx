import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
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
  Pill,
  PressableScale,
  ScreenHeader,
} from '../design/components';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import type { RootStackParams } from '../navigation/params';
import { createTrainingApi, type CatalogDrill } from '../training/api';
import {
  TrainingError,
  type DrillDetail,
  type InstructionalMedia,
} from '../training/types';

/**
 * Searchable catalog of the server's drill library. Everything in this
 * catalog today is a drill-library-v1 engineering seed with NO coach
 * endorsement, so every card carries an explicit UNVALIDATED draft label and
 * the server-provided coach line is rendered exactly as sent. Saving is
 * optimistic and reverts loudly on failure; nothing is ever presented as
 * validated coaching.
 *
 * Instructional media on the expanded card is attributed third-party video
 * (e.g. YouTube). Every playable video the server serves is listed, each
 * with its creator name + attribution displayed verbatim, the list carries a
 * single "Community video · not Pickle Sensei coach-validated" caption, and
 * playback happens at the original source URL via Linking — never framed as
 * Pickle Sensei's own coaching.
 *
 * Browse rows are plain deep links to real YouTube search results at the
 * source: every expanded drill offers "Browse hundreds more on YouTube"
 * (where "hundreds" describes YouTube's own corpus for that search, not our
 * catalog), and an active search query adds a top-level row that searches
 * all of YouTube. No video IDs or counts are ever fabricated client-side,
 * and none of it is framed as Pickle Sensei's own coaching.
 */

const SEARCH_DEBOUNCE_MS = 250;

const FAMILIES = [
  'dink',
  'volley',
  'drive',
  'serve',
  'return',
  'drop_reset',
  'global',
] as const;

function familyLabel(family: string): string {
  return family.replace(/_/g, ' ').toUpperCase();
}

function difficultyLabel(drill: CatalogDrill): string | null {
  if (drill.difficultyMin && drill.difficultyMax) {
    return drill.difficultyMin === drill.difficultyMax
      ? `SKILL ${drill.difficultyMin}`
      : `SKILL ${drill.difficultyMin}–${drill.difficultyMax}`;
  }
  if (drill.difficultyMin) return `SKILL ${drill.difficultyMin}+`;
  if (drill.difficultyMax) return `SKILL UP TO ${drill.difficultyMax}`;
  return null;
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
  const difficulty = difficultyLabel(drill);
  const detail = props.detail;
  const readyDetail = detail?.status === 'ready' ? detail.detail : null;
  const firstCue = readyDetail?.mappings[0]?.cueText ?? null;
  const mediaList = playableMediaList(readyDetail);
  const detailSummary = readyDetail
    ? [
        readyDetail.mappings.length > 0
          ? `${readyDetail.mappings.length} reviewed prescription${
              readyDetail.mappings.length === 1 ? '' : 's'
            } on file`
          : 'No reviewed prescription is published for this drill yet.',
        readyDetail.instructionalMedia.length > 0
          ? `${readyDetail.instructionalMedia.length} instructional video${
              readyDetail.instructionalMedia.length === 1 ? '' : 's'
            }`
          : 'no rights-cleared video yet',
      ].join(' · ')
    : null;
  return (
    <Card style={styles.drillCard} testID={`drill-card-${drill.slug}`}>
      <View style={styles.cardTop}>
        <Pill
          label={
            drill.validationState === 'UNVALIDATED'
              ? 'UNVALIDATED · ENGINEERING DRAFT'
              : drill.validationState
          }
          tone="warn"
        />
        <View style={styles.flex} />
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
          style={styles.bookmarkButton}
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
        <Text style={[type.h3, styles.drillTitle]}>{drill.title}</Text>
        <Text numberOfLines={3} style={[type.caption, styles.description]}>
          {drill.description}
        </Text>
        <Text style={[type.caption, styles.coachLine]}>{drill.coachName}</Text>
        {drill.equipment.length > 0 ? (
          <Text style={[type.micro, styles.equipmentRow]}>
            {drill.equipment.join(' · ').toUpperCase()}
          </Text>
        ) : null}
        {difficulty ? (
          <View style={styles.metaRow}>
            <Pill label={difficulty} />
          </View>
        ) : null}
      </PressableScale>
      {props.expanded ? (
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
              {firstCue ? (
                <View style={styles.cueRow}>
                  <View style={styles.cueDot} />
                  <Text style={[type.bodyBold, styles.cueText]}>
                    {firstCue}
                  </Text>
                </View>
              ) : null}
              {mediaList.map((media, index) => (
                <PressableScale
                  key={media.id}
                  testID={`watch-media-${drill.slug}-${index}`}
                  accessibilityLabel={`Watch real coach demonstration for ${drill.title}`}
                  accessibilityHint={media.attribution}
                  onPress={() => props.onOpenMedia(media)}
                  style={styles.mediaRow}
                >
                  <View style={styles.playIcon}>
                    <Icon name="play" size={18} color={color.onVolt} />
                  </View>
                  <View style={styles.mediaCopy}>
                    <Text style={[type.bodyBold, styles.mediaTitle]}>
                      WATCH: real coach demonstration
                    </Text>
                    <Text style={[type.caption, styles.mediaCreator]}>
                      {media.creatorName}
                    </Text>
                    {/* Attribution is a license obligation: always shown verbatim. */}
                    <Text style={[type.caption, styles.mediaAttribution]}>
                      {media.attribution}
                    </Text>
                  </View>
                  <Icon name="arrow" size={18} color={color.inkSoft} />
                </PressableScale>
              ))}
              {mediaList.length > 0 ? (
                <Text style={[type.micro, styles.mediaDisclosure]}>
                  Community video · not Pickle Sensei coach-validated
                </Text>
              ) : null}
              {/* Honest discovery: a real YouTube search for this drill —
                  "hundreds" describes YouTube's corpus, not our catalog. */}
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
                    Browse hundreds more on YouTube
                  </Text>
                  <Text style={[type.caption, styles.mediaCreator]}>
                    Search results on YouTube · community videos
                  </Text>
                </View>
                <Icon name="arrow" size={18} color={color.inkSoft} />
              </PressableScale>
              <Text style={[type.caption, styles.detailMuted]}>
                {detailSummary}
              </Text>
            </>
          )}
        </View>
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
  const requestIdRef = useRef(0);
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    const handle = setTimeout(
      () => setDebouncedQuery(query),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(handle);
  }, [query]);

  const load = useCallback(
    async (mode: 'initial' | 'update' | 'refresh') => {
      const requestId = ++requestIdRef.current;
      if (mode === 'initial') {
        setDrills(null);
        setLoadError(null);
      } else if (mode === 'refresh') {
        setRefreshing(true);
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
    [api, debouncedQuery, family],
  );

  useEffect(() => {
    void load(hasLoadedRef.current ? 'update' : 'initial');
  }, [load]);

  const toggleSaved = useCallback(
    async (drill: CatalogDrill) => {
      if (pendingSaves.has(drill.slug)) return;
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
      } catch (error) {
        applySaved(drill.saved);
        setInlineError(toMessage(error));
      } finally {
        setPendingSaves(prev => {
          const next = new Set(prev);
          next.delete(drill.slug);
          return next;
        });
      }
    },
    [api, pendingSaves],
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

  // Attributed third-party video and YouTube browse links: open the original
  // page (YouTube app or browser) so creators are credited at the source. No
  // in-app player.
  const openExternal = useCallback(async (url: string) => {
    try {
      await Linking.openURL(url);
    } catch {
      setInlineError(
        'This community video could not be opened on this device.',
      );
    }
  }, []);

  const visibleDrills = useMemo(
    () => (drills ?? []).filter(drill => matchesQuery(drill, debouncedQuery)),
    [debouncedQuery, drills],
  );

  // An active search also gets a real all-of-YouTube search deep link, so
  // every query reaches YouTube's full corpus — honestly, at the source.
  const youtubeQuery = debouncedQuery.trim();

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
        <Text style={[type.caption, styles.resultCount]}>
          {visibleDrills.length} of {drills.length} drill
          {drills.length === 1 ? '' : 's'} · engineering drafts, none
          coach-validated yet
        </Text>
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
        {visibleDrills.length === 0 ? (
          <EmptyState
            title="No drills match"
            body="Try a different search or family filter. Every drill in this catalog is an engineering draft."
          />
        ) : (
          visibleDrills.map(drill => (
            <DrillCard
              key={drill.slug}
              drill={drill}
              expanded={expandedSlug === drill.slug}
              detail={details[drill.slug]}
              savePending={pendingSaves.has(drill.slug)}
              onToggleExpanded={() => toggleExpanded(drill.slug)}
              onToggleSaved={() => void toggleSaved(drill)}
              onRetryDetail={() => void loadDetail(drill.slug)}
              onOpenMedia={media => void openExternal(media.sourceUrl)}
              onBrowseVideos={() =>
                void openExternal(youtubeSearchUrl(drill.title))
              }
            />
          ))
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
                style={({ pressed }) => [pressed && styles.pressed]}
              >
                <Pill
                  label={value ? familyLabel(value) : 'ALL'}
                  tone={selected ? 'dark' : 'neutral'}
                />
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
  drillCard: { padding: space.lg, marginBottom: 12 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  bookmarkContainer: { width: 44, borderRadius: 22 },
  bookmarkButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: color.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBody: { alignItems: 'stretch' },
  drillTitle: { color: color.ink, marginTop: space.sm },
  description: { color: color.inkSoft, marginTop: space.xs },
  coachLine: { color: color.inkSoft, marginTop: space.sm },
  equipmentRow: { color: color.inkSoft, marginTop: space.sm },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    marginTop: space.sm,
  },
  detailWrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
    marginTop: space.md,
    paddingTop: space.md,
    gap: space.sm,
  },
  detailMuted: { color: color.inkSoft },
  detailError: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
  },
  detailErrorText: { color: color.bad, flex: 1 },
  detailRetry: { color: color.court },
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
  cueText: { color: color.ink, flex: 1 },
});
