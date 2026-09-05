/**
 * Seeded scenario model for the DrillLibraryScreen boundary/i18n/a11y
 * campaign. `buildScenario(seed)` is a pure function of the seed: the same
 * seed always yields the same locale, font scale, viewport, session state,
 * server payloads, local scored reads and interaction script.
 *
 * The rendering/assertion half lives in the jest suite (it needs `act`,
 * fake timers and module mocks); this module only owns the data so a
 * failing seed can be inspected without a renderer.
 */
import {
  DIFFICULTY_VALUES,
  EXPIRY_CASES,
  LOCALES,
  LOCAL_SCORES,
  NULLABLE_COUNTS,
  TARGET_SETS,
  TITLE_SHAPES,
  longText,
  titleFor,
  type ExpiryCase,
  type LocaleSample,
  type TitleShape,
} from './boundaryCorpus';
import { SeededRng } from './seededRng';

export const FONT_SCALES = [1, 1.35, 2.0] as const;
export const VIEWPORT_WIDTHS = [320, 375, 430] as const;

const FAMILIES = [
  'dink',
  'volley',
  'drive',
  'serve',
  'return',
  'drop_reset',
  'global',
] as const;

const CHECKPOINTS = [
  'ready_position',
  'athletic_base',
  'preparation',
  'paddle_set',
  'swing_length',
  'sequencing',
  'paddle_path',
  'contact_position',
  'face_wrist_stability',
  'follow_through',
  'recovery',
] as const;

const SHOT_TYPES = [
  'dink',
  'volley',
  'forehand_drive',
  'backhand_drive',
  'serve',
  'return',
  'third_shot_drop',
  'overhead',
] as const;

export type SessionShape = 'configured' | 'missing' | 'blankToken';
export type CatalogOutcome =
  'ok' | 'http500' | 'network' | 'invalidShape' | 'http401';
export type MutationOutcome = 'ok' | 'http500' | 'network' | 'invalidShape';
export type QueryKind =
  | 'substring'
  | 'exactTitle'
  | 'hostile'
  | 'zeroWidth'
  | 'longNoMatch'
  | 'whitespaceOnly';

export interface DrillSpec {
  id: string;
  slug: string;
  titleShape: TitleShape;
  title: string;
  description: string;
  coachName: string;
  draftByline: boolean;
  equipment: string[];
  difficultyMin: string | null;
  difficultyMax: string | null;
  families: string[];
  saved: boolean;
}

export interface MappingSpec {
  checkpoint: string;
  shotType: string;
  planRole: 'warmup' | 'targeted';
  cueText: string;
  targetSets: number;
  reps: number | null;
  duration: number | null;
  rest: number | null;
}

export interface MediaSpec {
  id: string;
  kind: 'hosted' | 'embed';
  provider: 'youtube' | 'vimeo';
  videoId: string;
  expiry: ExpiryCase;
  /** Whether Date.now() sits before (future → playable) or after expiry. */
  relation: 'future' | 'past';
  creatorName: string;
  attribution: string;
  licenseName: string;
}

export interface LocalShotSpec {
  id: string;
  shotType: string;
  capturedAt: string;
  checkpoints: { key: string; score: number | null; applicable: boolean }[];
}

export interface Scenario {
  seed: number;
  locale: LocaleSample;
  fontScale: (typeof FONT_SCALES)[number];
  viewportWidthPt: (typeof VIEWPORT_WIDTHS)[number];
  session: SessionShape;
  catalog: CatalogOutcome;
  drills: DrillSpec[];
  localShots: LocalShotSpec[];
  serverErrorMessage: string;
  detail: {
    outcome: MutationOutcome;
    mappings: MappingSpec[];
    media: MediaSpec[];
  };
  /** Date.now() the scenario runs under (ms) — drives media expiry. */
  nowMs: number;
  actions: {
    expandIndex: number | null;
    openMediaIndex: number | null;
    browseVideos: boolean;
    save: { index: number; outcome: MutationOutcome } | null;
    query: { kind: QueryKind; text: string } | null;
    clearQuery: boolean;
    familyFilter: string | null;
    pressBack: boolean;
  };
}

function pickDifficulty(rng: SeededRng): [string | null, string | null] {
  const min = rng.pick(DIFFICULTY_VALUES);
  const max = rng.bool(0.5) ? min : rng.pick(DIFFICULTY_VALUES);
  return [min, max];
}

function buildDrill(
  rng: SeededRng,
  locale: LocaleSample,
  index: number,
  forcedShape: TitleShape | null,
): DrillSpec {
  const titleShape = forcedShape ?? rng.pick(TITLE_SHAPES);
  const title = titleFor(locale, titleShape);
  const draftByline = rng.bool(0.15);
  const [difficultyMin, difficultyMax] = pickDifficulty(rng);
  const equipmentPool = [
    'paddle',
    'ball',
    'Kitchen line tape',
    'İstanbul ışık kiti',
    'ßall',
    'ラケット',
    longText(locale, 200),
    '🏓',
  ];
  const equipment = rng.bool(0.2)
    ? []
    : rng.sample(equipmentPool, rng.int(1, 4));
  const familyCount = rng.bool(0.15) ? 0 : rng.int(1, 2);
  const families =
    familyCount === 0 ? [] : rng.sample([...FAMILIES], familyCount);
  const slugBase = rng.bool(0.2)
    ? `${locale.tag.toLowerCase()}-ドリル-${index}`
    : `drill-${locale.tag.toLowerCase()}-${index}`;
  return {
    id: rng.uuid(),
    slug: slugBase,
    titleShape,
    title,
    description: rng.bool(0.5) ? longText(locale, 260) : locale.sentence,
    coachName: draftByline
      ? `Engineering draft · ${locale.name}`
      : rng.bool(0.3)
        ? longText(locale, 200)
        : locale.name,
    draftByline,
    equipment,
    difficultyMin,
    difficultyMax,
    families,
    saved: rng.bool(0.35),
  };
}

function buildLocalShots(rng: SeededRng): LocalShotSpec[] {
  const count = rng.pick([0, 0, 2, 3, 5, 8, 12]);
  const shots: LocalShotSpec[] = [];
  const base = Date.UTC(2026, 5, 1, 12, 0, 0);
  for (let i = 0; i < count; i += 1) {
    const shotType = rng.pick(SHOT_TYPES);
    const keys = rng.sample([...CHECKPOINTS], rng.int(1, 4));
    shots.push({
      id: rng.uuid(),
      shotType,
      capturedAt: new Date(base - i * 3_600_000).toISOString(),
      checkpoints: keys.map(key => ({
        key,
        score: rng.bool(0.1) ? null : rng.pick(LOCAL_SCORES),
        applicable: rng.bool(0.85),
      })),
    });
  }
  return shots;
}

function buildMappings(rng: SeededRng, locale: LocaleSample): MappingSpec[] {
  const count = rng.pick([0, 1, 2, 3]);
  const mappings: MappingSpec[] = [];
  for (let i = 0; i < count; i += 1) {
    mappings.push({
      checkpoint: rng.pick(CHECKPOINTS),
      shotType: rng.pick(SHOT_TYPES),
      planRole: rng.bool() ? 'warmup' : 'targeted',
      cueText: rng.bool(0.4) ? longText(locale, 220) : locale.sentence,
      targetSets: rng.pick(TARGET_SETS),
      reps: rng.pick(NULLABLE_COUNTS),
      duration: rng.pick(NULLABLE_COUNTS),
      rest: rng.pick(NULLABLE_COUNTS),
    });
  }
  return mappings;
}

function buildMedia(rng: SeededRng, locale: LocaleSample): MediaSpec[] {
  const count = rng.pick([0, 1, 2, 3]);
  const media: MediaSpec[] = [];
  for (let i = 0; i < count; i += 1) {
    const provider = rng.bool() ? 'youtube' : 'vimeo';
    media.push({
      id: rng.uuid(),
      kind: rng.bool(0.6) ? 'hosted' : 'embed',
      provider,
      videoId: provider === 'youtube' ? `dQw4w9WgXc${i}` : `7654321${i}`,
      expiry: rng.pick(EXPIRY_CASES),
      relation: rng.bool() ? 'future' : 'past',
      creatorName: rng.bool(0.3) ? longText(locale, 200) : locale.name,
      attribution: rng.bool(0.5)
        ? `${longText(locale, 220)} — CC BY 4.0`
        : `${locale.name} · CC BY 4.0`,
      licenseName: 'CC BY 4.0',
    });
  }
  return media;
}

export function buildScenario(seed: number): Scenario {
  const rng = new SeededRng(seed);
  // Stratified: 12 × 3 × 3 consecutive seeds walk the whole locale × font
  // scale × width matrix exactly once; everything else is drawn from the RNG.
  const locale = LOCALES[seed % LOCALES.length] as LocaleSample;
  const fontScale = FONT_SCALES[
    Math.floor(seed / LOCALES.length) % FONT_SCALES.length
  ] as (typeof FONT_SCALES)[number];
  const viewportWidthPt = VIEWPORT_WIDTHS[
    Math.floor(seed / (LOCALES.length * FONT_SCALES.length)) %
      VIEWPORT_WIDTHS.length
  ] as (typeof VIEWPORT_WIDTHS)[number];
  const session: SessionShape = rng.bool(0.08)
    ? rng.bool()
      ? 'missing'
      : 'blankToken'
    : 'configured';
  const catalog: CatalogOutcome =
    session === 'configured'
      ? rng.pick([
          'ok',
          'ok',
          'ok',
          'ok',
          'ok',
          'ok',
          'http500',
          'network',
          'invalidShape',
          'http401',
        ] as const)
      : 'ok';
  const drillCount = catalog === 'ok' ? rng.pick([0, 1, 2, 3, 4, 6, 9]) : 0;
  const drills: DrillSpec[] = [];
  for (let i = 0; i < drillCount; i += 1) {
    // The first card always exercises a named boundary shape so every seed
    // with a catalog covers at least one long/RTL/ZWJ/combining title.
    drills.push(
      buildDrill(rng, locale, i, i === 0 ? rng.pick(TITLE_SHAPES) : null),
    );
  }
  const localShots = buildLocalShots(rng);
  const mappings = buildMappings(rng, locale);
  const media = buildMedia(rng, locale);
  const anchor = media[0] ?? null;
  const nowMs = anchor
    ? anchor.expiry.instantMs +
      (anchor.relation === 'future' ? -60_000 : 60_000)
    : Date.UTC(2026, 5, 15, 12, 0, 0);
  const firstDrill = drills[0] ?? null;
  const queryKind: QueryKind | null =
    drills.length > 0 && rng.bool(0.45)
      ? rng.pick([
          'substring',
          'exactTitle',
          'hostile',
          'zeroWidth',
          'longNoMatch',
          'whitespaceOnly',
        ] as const)
      : null;
  const query =
    queryKind && firstDrill
      ? {
          kind: queryKind,
          text:
            queryKind === 'substring'
              ? locale.querySubstring
              : queryKind === 'exactTitle'
                ? firstDrill.title
                : queryKind === 'hostile'
                  ? '<script>%s</script> \u202E DROP'
                  : queryKind === 'zeroWidth'
                    ? '\u200B'
                    : queryKind === 'whitespaceOnly'
                      ? '   \t  '
                      : 'q'.repeat(240),
        }
      : null;
  const hasCards = drills.length > 0;
  return {
    seed,
    locale,
    fontScale,
    viewportWidthPt,
    session,
    catalog,
    drills,
    localShots,
    serverErrorMessage: rng.bool(0.5)
      ? longText(locale, 240)
      : `${locale.sentence} (${locale.tag})`,
    detail: {
      outcome: rng.pick([
        'ok',
        'ok',
        'ok',
        'http500',
        'network',
        'invalidShape',
      ] as const),
      mappings,
      media,
    },
    nowMs,
    actions: {
      expandIndex:
        hasCards && rng.bool(0.7) ? rng.int(0, drills.length - 1) : null,
      openMediaIndex: rng.bool(0.5) ? 0 : null,
      browseVideos: rng.bool(0.4),
      save:
        hasCards && rng.bool(0.6)
          ? {
              index: rng.int(0, drills.length - 1),
              outcome: rng.pick([
                'ok',
                'ok',
                'http500',
                'network',
                'invalidShape',
              ] as const),
            }
          : null,
      query,
      clearQuery: query !== null && rng.bool(0.5),
      familyFilter: hasCards && rng.bool(0.3) ? rng.pick(FAMILIES) : null,
      pressBack: rng.bool(0.3),
    },
  };
}

/** Server JSON for GET /v1/catalog/drills (before the client parser). */
export function catalogPayload(scenario: Scenario): unknown {
  if (scenario.catalog === 'invalidShape') return { items: null };
  return {
    items: scenario.drills.map(drill => ({
      id: drill.id,
      slug: drill.slug,
      title: drill.title,
      description: drill.description,
      coach_name: drill.coachName,
      equipment: drill.equipment,
      difficulty_min: drill.difficultyMin,
      difficulty_max: drill.difficultyMax,
      families: drill.families,
      validation_state: 'UNVALIDATED',
      saved: drill.saved,
    })),
  };
}

/** Server JSON for GET /v1/catalog/drills/:slug. */
export function detailPayload(scenario: Scenario, drill: DrillSpec): unknown {
  if (scenario.detail.outcome === 'invalidShape') {
    return {
      drill: { ...drill, saved: 'yes' },
      mappings: [],
      instructionalMedia: [],
    };
  }
  return {
    drill: {
      id: drill.id,
      slug: drill.slug,
      title: drill.title,
      description: drill.description,
      coach_name: drill.coachName,
      equipment: drill.equipment,
      difficulty_min: drill.difficultyMin,
      difficulty_max: drill.difficultyMax,
      saved: drill.saved,
    },
    mappings: scenario.detail.mappings.map(mapping => ({
      checkpoint: mapping.checkpoint,
      shot_type: mapping.shotType,
      plan_role: mapping.planRole,
      fault_directions: ['too_high', 'too_late'],
      cue_text: mapping.cueText,
      target_sets: mapping.targetSets,
      target_repetitions_per_set: mapping.reps,
      target_duration_seconds: mapping.duration,
      rest_seconds: mapping.rest,
    })),
    instructionalMedia: scenario.detail.media.map(media =>
      media.kind === 'hosted'
        ? {
            id: media.id,
            kind: 'hosted',
            sourceUrl: 'https://example.org/source',
            playbackUrl: 'https://cdn.example.org/clip.mp4',
            expiresAt: media.expiry.expiresAt,
            creatorName: media.creatorName,
            licenseName: media.licenseName,
            licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
            attribution: media.attribution,
          }
        : {
            id: media.id,
            kind: 'embed',
            sourceUrl: 'https://example.org/source',
            provider: media.provider,
            videoId: media.videoId,
            embedUrl:
              media.provider === 'youtube'
                ? `https://www.youtube-nocookie.com/embed/${media.videoId}`
                : `https://player.vimeo.com/video/${media.videoId}`,
            creatorName: media.creatorName,
            licenseName: media.licenseName,
            licenseUrl: null,
            attribution: media.attribution,
          },
    ),
  };
}

/** Media entries the screen must list (mirrors the product's expiry rule). */
export function expectedPlayableMedia(scenario: Scenario): MediaSpec[] {
  return scenario.detail.media.filter(media =>
    media.kind === 'embed' ? true : media.expiry.instantMs > scenario.nowMs,
  );
}

/** Drills the client-side filter must keep for the scenario's query. */
export function expectedVisibleDrills(
  scenario: Scenario,
  query: string | null,
  family: string | null,
): DrillSpec[] {
  const needle = (query ?? '').trim().toLowerCase();
  return scenario.drills.filter(drill => {
    if (family !== null && !drill.families.includes(family)) return false;
    if (!needle) return true;
    return [drill.title, drill.description, ...drill.equipment].some(value =>
      value.toLowerCase().includes(needle),
    );
  });
}

/** The scenario's local scored reads as `local_shot` payloads. */
export function localShotPayload(shot: LocalShotSpec): string {
  return JSON.stringify({
    id: shot.id,
    sessionId: null,
    shotType: shot.shotType,
    capturedAtIso: shot.capturedAt,
    overallScore: 50,
    analysisConfidence: 0.9,
    resultKind: 'scored',
    source: 'real',
    checkpoints: shot.checkpoints,
  });
}
