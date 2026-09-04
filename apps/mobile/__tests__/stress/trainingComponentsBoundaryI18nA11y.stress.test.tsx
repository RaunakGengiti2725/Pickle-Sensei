/**
 * STRESS — unit `cmp-training-components`, lens `boundary-i18n-a11y`.
 *
 * Renders the REAL `SavedDrillCard` / `PlanDrillCard` (src/training/components.tsx)
 * through react-test-renderer and audits the HOST tree:
 *   - accessibility: every press target has role + non-blank label +
 *     accessible=true + ≥44pt target, labels are the documented templates and
 *     unique per card, disabled state matches intent;
 *   - text: no JS sentinel leaks ("undefined", "NaN", "Invalid Date", …),
 *     the position badge / prescription / rest / date labels are what the
 *     fixture implies;
 *   - layout model (INFERRED, deterministic Yoga approximation in
 *     test-support/stress/renderAudit.ts): row overflow with RN's
 *     flexShrink:0 default and fixed-box clipping under 3 font scales × 3
 *     device widths.
 *
 * Inputs come from a seeded corpus (test-support/stress/boundaryCorpus.ts):
 * 15 string classes (200+ char runs, CJK, Arabic RTL, bidi, ZWJ emoji,
 * combining marks, German compounds, Thai, Devanagari, zero-width/control,
 * empty/whitespace, numeric-like), nullable numeric pools that straddle the
 * DB CHECK domains, 12 locales × 8 time zones × DST/day-boundary instants.
 *
 * Replay: `STRESS_SEED=<campaign seed> STRESS_ITER=<n>` reproduces the same
 * variants; `STRESS_ONLY=<iteration>` replays a single one. Every variant's
 * outcome is written to `apps/mobile/artifacts/stress/training-components-
 * boundary-i18n-a11y/results.json` (gitignored) together with the rendered-
 * tree excerpt for each violation.
 *
 * Known defects are pinned (`reproduction:` tests) and tallied separately so
 * the campaign stays green; any violation that is not a pinned defect fails.
 *
 * Time zone and locale are emulated by delegating `Date#toLocaleDateString`
 * to `Intl.DateTimeFormat(locale, { timeZone })` — jest sandboxes
 * `process.env.TZ`, so a real-TZ run is `TZ=<zone> npx jest <this file>`
 * (see the `process time zone` test, which uses the un-mocked method).
 */
import { join } from 'path';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  firstPlayableMedia,
  PlanDrillCard,
  prescriptionLabel,
  SavedDrillCard,
} from '../../src/training/components';
import type {
  DrillDetail,
  InstructionalMedia,
  SavedDrill,
  TrainingPlanItem,
} from '../../src/training/types';
import {
  DEVICE_WIDTHS,
  EDGE_INSTANTS,
  FONT_SCALES,
  generateString,
  LOCALES,
  NUMERIC_POOLS,
  STRING_CLASSES,
  TIMEZONES,
  type Locale,
  type StringClass,
  type TimeZone,
} from '../../test-support/stress/boundaryCorpus';
import {
  auditAccessibility,
  auditSentinels,
  collectTexts,
  estimateLayout,
  excerpt,
  MIN_TARGET_PT,
  type HostNode,
  type Violation,
} from '../../test-support/stress/renderAudit';
import {
  createSeededRng,
  readIntEnv,
  type SeededRng,
} from '../../test-support/stress/seededRng';

const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};

jest.mock('react-native-safe-area-context', () => {
  const ReactActual = jest.requireActual('react') as typeof React;
  return {
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) =>
      ReactActual.createElement(ReactActual.Fragment, null, children),
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  };
});

const CAMPAIGN_SEED = readIntEnv('STRESS_SEED', 20260904);
const ITERATIONS = readIntEnv('STRESS_ITER', 40);
const ONLY = process.env.STRESS_ONLY ? Number(process.env.STRESS_ONLY) : null;
const OUT_DIR =
  process.env.STRESS_OUT ??
  join(
    __dirname,
    '..',
    '..',
    'artifacts',
    'stress',
    'training-components-boundary-i18n-a11y',
  );
/** Screens host these cards inside `space.lg` (24pt) horizontal padding. */
const SCREEN_PADDING = 24;
/** Host-tree paths: Card View → cardTop row → numberBadge → position Text. */
const CARD_TOP_PATH = 'View/View[0]';
const POSITION_BADGE_TEXT_PATH = 'View/View[0]/View[0]/Text[0]';

// ---------------------------------------------------------------------------
// Known defects (pinned below). A campaign violation that matches one of
// these is tallied as KNOWN_DEFECT instead of failing the run.
// ---------------------------------------------------------------------------

interface KnownDefect {
  id: string;
  title: string;
  matches: (violation: Violation, variant: Variant) => boolean;
}

const KNOWN_DEFECTS: readonly KnownDefect[] = [
  {
    id: 'TC-BIA-01',
    title:
      'position badge is "0" + position, so positions ≥ 10 render as "010".."020"',
    matches: v => v.kind === 'TEXT_POSITION_LABEL',
  },
  {
    id: 'TC-BIA-02',
    title:
      'cardTop row (badge + kind label + 44pt bookmark) has no shrinkable text; at accessibility font scales the kicker pushes the bookmark past the card',
    matches: v => v.kind === 'LAYOUT_ROW_OVERFLOW' && v.path === CARD_TOP_PATH,
  },
  {
    id: 'TC-BIA-03',
    title:
      'completion button label is not shrinkable; icon + gap (26pt) push it into the 16pt padding when its widest line exceeds inner-26pt (never past the border box: max spill 26 < 32)',
    matches: v =>
      v.kind === 'LAYOUT_ROW_PADDING_INTRUSION' &&
      v.evidence.includes('"minHeight":54'),
  },
  {
    id: 'TC-BIA-04',
    title:
      '34×34 number badge clips the scaled position text at accessibility font scales',
    matches: v =>
      v.kind === 'LAYOUT_FIXED_BOX_CLIP' &&
      v.detail.startsWith('fixed box 34×34'),
  },
  {
    id: 'TC-BIA-05',
    title:
      'numeric prescription/rest values render verbatim (negative, zero, fractional, ≥1e6, Infinity) — no clamping or humanising',
    matches: (v, variant) =>
      v.kind === 'TEXT_OUT_OF_DOMAIN_NUMERIC' ||
      (v.kind === 'TEXT_SENTINEL_LEAK' &&
        /"(NaN|Infinity)"/.test(v.detail) &&
        [
          variant.position,
          variant.targetSets,
          variant.targetReps,
          variant.targetDuration,
          variant.rest,
        ].some(n => n !== null && !Number.isFinite(n))),
  },
  {
    id: 'TC-BIA-06',
    title:
      'a blank drill title yields subject-less accessibility labels ("Save ", "Watch reviewed instruction for ")',
    matches: v => v.kind === 'A11Y_LABEL_BLANK_SUBJECT',
  },
];

// ---------------------------------------------------------------------------
// Variant generation
// ---------------------------------------------------------------------------

type ComponentName = 'SavedDrillCard' | 'PlanDrillCard';
type MediaState =
  | 'no-detail'
  | 'detail-no-media'
  | 'embed'
  | 'hosted-live'
  | 'hosted-expired'
  | 'hosted-expired-then-embed'
  | 'hosted-invalid-expiry';

interface Variant {
  iteration: number;
  seed: number;
  component: ComponentName;
  strings: Record<
    | 'title'
    | 'description'
    | 'coach'
    | 'cue'
    | 'creator'
    | 'license'
    | 'attribution',
    StringClass
  >;
  position: number;
  kind: TrainingPlanItem['kind'];
  targetSets: number | null;
  targetReps: number | null;
  targetDuration: number | null;
  rest: number | null;
  saved: boolean;
  busy: boolean;
  mappings: number;
  media: MediaState;
  completion: { completedAt: string; qualifiesForStreak: boolean } | null;
  locale: Locale;
  timeZone: TimeZone;
  fontScale: (typeof FONT_SCALES)[number];
  deviceWidth: (typeof DEVICE_WIDTHS)[number];
}

function pickString(rng: SeededRng): StringClass {
  return rng.pick(STRING_CLASSES);
}

function variantFor(campaignSeed: number, iteration: number): Variant {
  const seed = (campaignSeed + iteration * 7919) >>> 0;
  const rng = createSeededRng(seed);
  const complete = rng.chance(0.35);
  return {
    iteration,
    seed,
    component: rng.chance(0.4) ? 'SavedDrillCard' : 'PlanDrillCard',
    strings: {
      title: pickString(rng),
      description: pickString(rng),
      coach: pickString(rng),
      cue: pickString(rng),
      creator: pickString(rng),
      license: pickString(rng),
      attribution: pickString(rng),
    },
    position: rng.pick(NUMERIC_POOLS.position),
    kind: rng.pick(['warmup', 'targeted', 'reassessment'] as const),
    targetSets: rng.pick(NUMERIC_POOLS.targetSets),
    targetReps: rng.pick(NUMERIC_POOLS.targetReps),
    targetDuration: rng.pick(NUMERIC_POOLS.targetDuration),
    rest: rng.pick(NUMERIC_POOLS.rest),
    saved: rng.chance(0.5),
    busy: rng.chance(0.25),
    mappings: rng.pick([0, 1, 3]),
    media: rng.pick([
      'no-detail',
      'detail-no-media',
      'embed',
      'hosted-live',
      'hosted-expired',
      'hosted-expired-then-embed',
      'hosted-invalid-expiry',
    ] as const),
    completion: complete
      ? {
          completedAt: rng.pick(EDGE_INSTANTS),
          qualifiesForStreak: rng.chance(0.5),
        }
      : null,
    locale: rng.pick(LOCALES),
    timeZone: rng.pick(TIMEZONES),
    fontScale: rng.pick(FONT_SCALES),
    deviceWidth: rng.pick(DEVICE_WIDTHS),
  };
}

interface Fixture {
  strings: Record<keyof Variant['strings'], string>;
  detail: DrillDetail | undefined;
  saved: SavedDrill;
  item: TrainingPlanItem;
  /** Fixed clock handed to firstPlayableMedia through Date.now. */
  now: number;
}

const NOW = Date.parse('2026-09-04T12:00:00.000Z');

function buildMedia(
  variant: Variant,
  strings: Fixture['strings'],
): InstructionalMedia[] {
  const base = {
    sourceUrl: 'https://example.com/source',
    creatorName: strings.creator,
    licenseName: strings.license,
    licenseUrl: null,
    attribution: strings.attribution,
  };
  const embed: InstructionalMedia = {
    ...base,
    id: `${variant.seed}-embed`,
    kind: 'embed',
    provider: 'youtube',
    videoId: 'dQw4w9WgXcQ',
    embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
  };
  const hosted = (expiresAt: string, suffix: string): InstructionalMedia => ({
    ...base,
    id: `${variant.seed}-${suffix}`,
    kind: 'hosted',
    playbackUrl: 'https://cdn.example.com/clip.m3u8',
    expiresAt,
  });
  switch (variant.media) {
    case 'no-detail':
    case 'detail-no-media':
      return [];
    case 'embed':
      return [embed];
    case 'hosted-live':
      return [hosted(new Date(NOW + 60_000).toISOString(), 'live')];
    case 'hosted-expired':
      return [hosted(new Date(NOW - 1).toISOString(), 'expired')];
    case 'hosted-expired-then-embed':
      return [hosted(new Date(NOW).toISOString(), 'boundary'), embed];
    case 'hosted-invalid-expiry':
      return [hosted('not-a-date', 'invalid'), embed];
    default: {
      const exhaustive: never = variant.media;
      throw new Error(String(exhaustive));
    }
  }
}

function buildFixture(variant: Variant): Fixture {
  const rng = createSeededRng(variant.seed ^ 0x5f3759df);
  const strings = {
    title: generateString(rng, variant.strings.title),
    description: generateString(rng, variant.strings.description),
    coach: generateString(rng, variant.strings.coach),
    cue: generateString(rng, variant.strings.cue),
    creator: generateString(rng, variant.strings.creator),
    license: generateString(rng, variant.strings.license),
    attribution: generateString(rng, variant.strings.attribution),
  };
  const media = buildMedia(variant, strings);
  const detail: DrillDetail | undefined =
    variant.media === 'no-detail'
      ? undefined
      : {
          id: `${variant.seed}-detail`,
          slug: 'stress-drill',
          title: strings.title,
          description: strings.description,
          coachName: strings.coach,
          equipment: [],
          difficultyMin: null,
          difficultyMax: null,
          saved: variant.saved,
          mappings: Array.from({ length: variant.mappings }, (_, i) => ({
            checkpoint: `cp-${i}`,
            shotType: 'dink',
            planRole: 'targeted' as const,
            faultDirections: [],
            cueText: strings.cue,
            targetSets: 3,
            targetRepetitionsPerSet: 10,
            targetDurationSeconds: null,
            restSeconds: 30,
          })),
          instructionalMedia: media,
        };
  return {
    strings,
    detail,
    now: NOW,
    saved: {
      id: `${variant.seed}-saved`,
      slug: 'stress-drill',
      title: strings.title,
      description: strings.description,
      coachName: strings.coach,
      equipment: [],
      difficultyMin: null,
      difficultyMax: null,
      savedAt: '2026-01-01T00:00:00.000Z',
    },
    item: {
      id: `${variant.seed}-item`,
      position: variant.position,
      kind: variant.kind,
      drill: {
        slug: 'stress-drill',
        title: strings.title,
        description: strings.description,
        coachName: strings.coach,
        equipment: [],
        saved: variant.saved,
      },
      cueText: variant.strings.cue === 'empty' ? null : strings.cue,
      targetSets: variant.targetSets,
      targetRepetitionsPerSet: variant.targetReps,
      targetDurationSeconds: variant.targetDuration,
      restSeconds: variant.rest,
      completion: variant.completion
        ? {
            id: `${variant.seed}-completion`,
            completedAt: variant.completion.completedAt,
            actualRepetitions: null,
            actualDurationSeconds: null,
            qualifiesForStreak: variant.completion.qualifiesForStreak,
          }
        : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Rendering + audit
// ---------------------------------------------------------------------------

interface Handlers {
  onUnsave: jest.Mock;
  onToggleSaved: jest.Mock;
  onConfirmComplete: jest.Mock;
  onOpenMedia: jest.Mock;
}

function mockHandlers(): Handlers {
  return {
    onUnsave: jest.fn(),
    onToggleSaved: jest.fn(),
    onConfirmComplete: jest.fn(),
    onOpenMedia: jest.fn(),
  };
}

function render(
  variant: Variant,
  fixture: Fixture,
  handlers: Handlers,
): { renderer: TestRenderer.ReactTestRenderer; tree: HostNode | null } {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      variant.component === 'SavedDrillCard' ? (
        <SavedDrillCard
          drill={fixture.saved}
          detail={fixture.detail}
          busy={variant.busy}
          onUnsave={handlers.onUnsave}
          onOpenMedia={handlers.onOpenMedia}
        />
      ) : (
        <PlanDrillCard
          item={fixture.item}
          detail={fixture.detail}
          busy={variant.busy}
          onToggleSaved={handlers.onToggleSaved}
          onConfirmComplete={handlers.onConfirmComplete}
          onOpenMedia={handlers.onOpenMedia}
        />
      ),
    );
  });
  const json = renderer.toJSON();
  const tree = Array.isArray(json) ? (json[0] ?? null) : json;
  return { renderer, tree };
}

function expectedControls(
  variant: Variant,
  fixture: Fixture,
  playable: boolean,
): Array<{ label: string; disabled: boolean; handler: keyof Handlers }> {
  const title = fixture.strings.title;
  if (variant.component === 'SavedDrillCard') {
    const out: Array<{
      label: string;
      disabled: boolean;
      handler: keyof Handlers;
    }> = [
      {
        label: `Remove ${title} from saved drills`,
        disabled: variant.busy,
        handler: 'onUnsave',
      },
    ];
    if (playable) {
      out.push({
        label: `Watch reviewed instruction for ${title}`,
        disabled: false,
        handler: 'onOpenMedia',
      });
    }
    return out;
  }
  const out: Array<{
    label: string;
    disabled: boolean;
    handler: keyof Handlers;
  }> = [
    {
      label: `${variant.saved ? 'Remove' : 'Save'} ${title}`,
      disabled: variant.busy,
      handler: 'onToggleSaved',
    },
  ];
  if (playable) {
    out.push({
      label: `Watch reviewed instruction for ${title}`,
      disabled: false,
      handler: 'onOpenMedia',
    });
  }
  const target = prescriptionLabel(fixture.item);
  if (variant.completion || target !== null) {
    out.push({
      label: variant.completion
        ? `${title} completion logged`
        : `Confirm completion of ${title}`,
      disabled: Boolean(variant.completion) || variant.busy,
      handler: 'onConfirmComplete',
    });
  }
  return out;
}

const STATIC_LABELS = [
  'Remove  from saved drills',
  'Watch reviewed instruction for ',
  'Save ',
  'Remove ',
  ' completion logged',
  'Confirm completion of ',
];

function isInDomainInteger(
  value: number | null,
  min: number,
  max: number,
): boolean {
  return (
    value === null || (Number.isInteger(value) && value >= min && value <= max)
  );
}

function auditTexts(
  variant: Variant,
  fixture: Fixture,
  tree: HostNode,
): Violation[] {
  const violations: Violation[] = [];
  const texts = collectTexts(tree);
  const fixtureStrings = Object.values(fixture.strings);
  violations.push(...auditSentinels(tree, fixtureStrings));

  if (variant.component === 'PlanDrillCard') {
    const item = fixture.item;
    if (!item.completion) {
      const badge = texts.find(t => t.path === POSITION_BADGE_TEXT_PATH);
      const inDomain =
        Number.isInteger(item.position) &&
        item.position >= 1 &&
        item.position <= 99;
      const expected = inDomain ? String(item.position).padStart(2, '0') : null;
      if (badge && expected !== null && badge.text !== expected) {
        violations.push({
          kind: 'TEXT_POSITION_LABEL',
          path: badge.path,
          detail: `position ${item.position} rendered as "${badge.text}", expected "${expected}"`,
          evidence: badge.text,
        });
      } else if (badge && expected === null) {
        violations.push({
          kind: 'TEXT_OUT_OF_DOMAIN_NUMERIC',
          path: badge.path,
          detail: `out-of-domain position ${item.position} rendered verbatim as "${badge.text}"`,
          evidence: badge.text,
        });
      }
    }
    const target = prescriptionLabel(item);
    const prescriptionText = texts.find(t => t.text === (target ?? '—'));
    if (!prescriptionText) {
      violations.push({
        kind: 'TEXT_SENTINEL_LEAK',
        path: 'prescriptionRow',
        detail: `prescription label "${target ?? '—'}" not found in rendered texts`,
        evidence: texts.map(t => t.text.slice(0, 40)).join(' | '),
      });
    }
    if (target !== null) {
      const numbersInDomain =
        isInDomainInteger(item.targetSets, 1, 20) &&
        isInDomainInteger(item.targetRepetitionsPerSet, 1, 500) &&
        isInDomainInteger(item.targetDurationSeconds, 10, 7200);
      if (!numbersInDomain) {
        violations.push({
          kind: 'TEXT_OUT_OF_DOMAIN_NUMERIC',
          path: 'prescriptionRow',
          detail: `prescription rendered verbatim as "${target}" for sets=${String(
            item.targetSets,
          )} reps=${String(item.targetRepetitionsPerSet)} duration=${String(
            item.targetDurationSeconds,
          )}`,
          evidence: target,
        });
      }
    }
    if (item.restSeconds !== null) {
      const restText = texts.find(t => t.text === `${item.restSeconds}s rest`);
      if (!restText) {
        violations.push({
          kind: 'TEXT_SENTINEL_LEAK',
          path: 'prescriptionRow',
          detail: `rest label "${item.restSeconds}s rest" not found`,
          evidence: texts.map(t => t.text.slice(0, 40)).join(' | '),
        });
      } else if (!isInDomainInteger(item.restSeconds, 0, 900)) {
        violations.push({
          kind: 'TEXT_OUT_OF_DOMAIN_NUMERIC',
          path: restText.path,
          detail: `out-of-domain rest ${item.restSeconds} rendered verbatim as "${restText.text}"`,
          evidence: restText.text,
        });
      }
    }
    if (item.completion) {
      const expectedDate = new Intl.DateTimeFormat(variant.locale, {
        timeZone: variant.timeZone,
      }).format(new Date(item.completion.completedAt));
      const logged = texts.find(t => t.text.startsWith('Logged '));
      if (!logged || logged.text !== `Logged ${expectedDate}`) {
        violations.push({
          kind: 'TEXT_SENTINEL_LEAK',
          path: logged?.path ?? 'evidenceNote',
          detail: `expected "Logged ${expectedDate}" for ${item.completion.completedAt} in ${variant.locale}/${variant.timeZone}, got "${logged?.text ?? '<missing>'}"`,
          evidence: logged?.text ?? '',
        });
      }
    }
  }
  return violations;
}

interface Outcome {
  iteration: number;
  seed: number;
  component: ComponentName;
  variant: Omit<Variant, 'iteration' | 'seed' | 'component'>;
  renderedNull: boolean;
  controls: number;
  texts: number;
  longestText: number;
  status: 'HELD' | 'KNOWN_DEFECT' | 'BROKEN';
  knownDefects: string[];
  violations: Array<Violation & { knownDefect: string | null }>;
  handlersFired: Record<keyof Handlers, number>;
}

function runVariant(variant: Variant): Outcome {
  const fixture = buildFixture(variant);
  const handlers = mockHandlers();
  const localeSpy = jest
    .spyOn(Date.prototype, 'toLocaleDateString')
    .mockImplementation(function (this: Date) {
      return new Intl.DateTimeFormat(variant.locale, {
        timeZone: variant.timeZone,
      }).format(this);
    });
  const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(fixture.now);
  const { iteration, seed, component, ...rest } = variant;
  const base = {
    iteration,
    seed,
    component,
    variant: rest,
    handlersFired: {
      onUnsave: 0,
      onToggleSaved: 0,
      onConfirmComplete: 0,
      onOpenMedia: 0,
    },
  };
  try {
    const { renderer, tree } = render(variant, fixture, handlers);
    try {
      if (!tree) {
        // PlanDrillCard renders nothing when the item has no drill; our
        // fixtures always carry a drill, so a null tree is a failure.
        return {
          ...base,
          renderedNull: true,
          controls: 0,
          texts: 0,
          longestText: 0,
          status: 'BROKEN',
          knownDefects: [],
          violations: [
            {
              kind: 'TEXT_SENTINEL_LEAK',
              path: 'root',
              detail: 'component rendered null for a fixture with a drill',
              evidence: '',
              knownDefect: null,
            },
          ],
        };
      }
      const layoutOptions = {
        deviceWidth: variant.deviceWidth,
        fontScale: variant.fontScale,
        screenPaddingHorizontal: SCREEN_PADDING,
      };
      const playable = firstPlayableMedia(fixture.detail, fixture.now) !== null;
      const expected = expectedControls(variant, fixture, playable);
      const expectedByLabel = new Map(expected.map(e => [e.label, e]));
      const a11y = auditAccessibility(tree, {
        ...layoutOptions,
        staticLabelPrefixes: STATIC_LABELS,
        expectDisabled: label =>
          label === undefined
            ? undefined
            : expectedByLabel.get(label)?.disabled,
      });
      const violations: Violation[] = [...a11y.violations];

      // Exact control ledger: the rendered set of labels must equal the
      // documented templates for this fixture, in order.
      const renderedLabels = a11y.controls.map(c => c.label ?? '');
      const expectedLabels = expected.map(e => e.label);
      if (JSON.stringify(renderedLabels) !== JSON.stringify(expectedLabels)) {
        violations.push({
          kind: 'A11Y_MISSING_LABEL',
          path: 'controls',
          detail: `control ledger mismatch: rendered ${JSON.stringify(
            renderedLabels.map(l => l.slice(0, 50)),
          )} expected ${JSON.stringify(expectedLabels.map(l => l.slice(0, 50)))}`,
          evidence: a11y.controls.map(c => excerpt(c.node, 0)).join('\n'),
        });
      }

      // Every enabled control forwards to exactly its handler.
      for (const control of a11y.controls) {
        const spec =
          control.label === undefined
            ? undefined
            : expectedByLabel.get(control.label);
        const onClick = control.node.props.onClick;
        if (!spec || typeof onClick !== 'function') continue;
        const before = Object.fromEntries(
          Object.entries(handlers).map(([k, fn]) => [k, fn.mock.calls.length]),
        ) as Record<keyof Handlers, number>;
        act(() => {
          onClick({ nativeEvent: {} });
        });
        const fired = (Object.keys(handlers) as Array<keyof Handlers>).filter(
          k => handlers[k].mock.calls.length !== before[k],
        );
        const want = spec.disabled ? [] : [spec.handler];
        if (JSON.stringify(fired) !== JSON.stringify(want)) {
          violations.push({
            kind: 'A11Y_DISABLED_STATE_MISMATCH',
            path: control.path,
            detail: `press on "${(control.label ?? '').slice(0, 40)}" fired ${JSON.stringify(
              fired,
            )}, expected ${JSON.stringify(want)}`,
            evidence: excerpt(control.node, 0),
          });
        }
        if (spec.handler === 'onOpenMedia' && !spec.disabled) {
          const call = handlers.onOpenMedia.mock.calls.at(-1) as
            [InstructionalMedia] | undefined;
          const expectedMedia = firstPlayableMedia(fixture.detail, fixture.now);
          if (!call || call[0] !== expectedMedia) {
            violations.push({
              kind: 'A11Y_DISABLED_STATE_MISMATCH',
              path: control.path,
              detail: 'onOpenMedia did not receive the first playable media',
              evidence: JSON.stringify(call?.[0]?.id ?? null),
            });
          }
        }
      }

      violations.push(...auditTexts(variant, fixture, tree));
      violations.push(...estimateLayout(tree, layoutOptions));

      const texts = collectTexts(tree);
      const classified = violations.map(v => ({
        ...v,
        evidence: v.evidence.slice(0, 1200),
        knownDefect: KNOWN_DEFECTS.find(d => d.matches(v, variant))?.id ?? null,
      }));
      const unknown = classified.filter(v => v.knownDefect === null);
      const known = [
        ...new Set(
          classified
            .map(v => v.knownDefect)
            .filter((x): x is string => x !== null),
        ),
      ];
      return {
        ...base,
        renderedNull: false,
        controls: a11y.controls.length,
        texts: texts.length,
        longestText: texts.reduce((m, t) => Math.max(m, [...t.text].length), 0),
        status:
          unknown.length > 0
            ? 'BROKEN'
            : known.length > 0
              ? 'KNOWN_DEFECT'
              : 'HELD',
        knownDefects: known,
        violations: classified,
        handlersFired: {
          onUnsave: handlers.onUnsave.mock.calls.length,
          onToggleSaved: handlers.onToggleSaved.mock.calls.length,
          onConfirmComplete: handlers.onConfirmComplete.mock.calls.length,
          onOpenMedia: handlers.onOpenMedia.mock.calls.length,
        },
      };
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  } finally {
    localeSpy.mockRestore();
    nowSpy.mockRestore();
  }
}

function writeArtifact(name: string, data: unknown): string {
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, name);
  writeFileSync(path, JSON.stringify(data, null, 2));
  return path;
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

describe('training/components — boundary/i18n/a11y stress campaign', () => {
  test(`seeded campaign (STRESS_SEED=${CAMPAIGN_SEED}, STRESS_ITER=${ITERATIONS})`, () => {
    const iterations =
      ONLY !== null ? [ONLY] : Array.from({ length: ITERATIONS }, (_, i) => i);
    const outcomes: Outcome[] = [];
    for (const iteration of iterations) {
      outcomes.push(runVariant(variantFor(CAMPAIGN_SEED, iteration)));
    }
    const coverage = {
      components: tally(outcomes.map(o => o.component)),
      titleClasses: tally(outcomes.map(o => o.variant.strings.title)),
      locales: tally(outcomes.map(o => o.variant.locale)),
      timeZones: tally(outcomes.map(o => o.variant.timeZone)),
      fontScales: tally(outcomes.map(o => String(o.variant.fontScale))),
      deviceWidths: tally(outcomes.map(o => String(o.variant.deviceWidth))),
      mediaStates: tally(outcomes.map(o => o.variant.media)),
      completed: tally(
        outcomes.map(o => String(o.variant.completion !== null)),
      ),
      busy: tally(outcomes.map(o => String(o.variant.busy))),
    };
    const summary = {
      campaignSeed: CAMPAIGN_SEED,
      iterations: outcomes.length,
      replay: `STRESS_SEED=${CAMPAIGN_SEED} STRESS_ITER=${ITERATIONS} STRESS_ONLY=<iteration> npx jest --ci __tests__/stress/trainingComponentsBoundaryI18nA11y.stress.test.tsx`,
      status: tally(outcomes.map(o => o.status)),
      violationsByKind: tally(
        outcomes.flatMap(o => o.violations.map(v => v.kind)),
      ),
      knownDefects: tally(outcomes.flatMap(o => o.knownDefects)),
      controlsAudited: outcomes.reduce((a, o) => a + o.controls, 0),
      textsAudited: outcomes.reduce((a, o) => a + o.texts, 0),
      longestText: outcomes.reduce((m, o) => Math.max(m, o.longestText), 0),
      coverage,
      brokenIterations: outcomes
        .filter(o => o.status === 'BROKEN')
        .map(o => o.iteration),
    };
    writeArtifact('results.json', outcomes);
    writeArtifact('summary.json', summary);

    const broken = outcomes.filter(o => o.status === 'BROKEN');
    expect(
      broken.map(o => ({
        iteration: o.iteration,
        seed: o.seed,
        unknown: o.violations
          .filter(v => v.knownDefect === null)
          .map(v => `${v.kind} ${v.path}: ${v.detail}`),
      })),
    ).toEqual([]);
    expect(outcomes.length).toBe(iterations.length);
    if (ONLY === null && ITERATIONS >= 150) {
      // Coverage floor for a full run: every axis exercised.
      expect(Object.keys(coverage.locales).sort()).toEqual([...LOCALES].sort());
      expect(Object.keys(coverage.timeZones).sort()).toEqual(
        [...TIMEZONES].sort(),
      );
      expect(Object.keys(coverage.fontScales).length).toBe(FONT_SCALES.length);
      expect(Object.keys(coverage.deviceWidths).length).toBe(
        DEVICE_WIDTHS.length,
      );
      expect(Object.keys(coverage.titleClasses).sort()).toEqual(
        [...STRING_CLASSES].sort(),
      );
    }
  });

  test('replay: the same (seed, iteration) renders the same tree and outcome', () => {
    const a = runVariant(variantFor(CAMPAIGN_SEED, 7));
    const b = runVariant(variantFor(CAMPAIGN_SEED, 7));
    expect(b).toEqual(a);
    expect(variantFor(CAMPAIGN_SEED, 8)).not.toEqual(
      variantFor(CAMPAIGN_SEED, 7),
    );
  });
});

function tally(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => a.localeCompare(b)),
  );
}

// ---------------------------------------------------------------------------
// Deterministic grids
// ---------------------------------------------------------------------------

function completedVariant(overrides: Partial<Variant>): Variant {
  return {
    ...variantFor(CAMPAIGN_SEED, 0),
    component: 'PlanDrillCard',
    strings: {
      title: 'latin-short',
      description: 'latin-short',
      coach: 'latin-short',
      cue: 'latin-short',
      creator: 'latin-short',
      license: 'latin-short',
      attribution: 'latin-short',
    },
    position: 2,
    kind: 'targeted',
    targetSets: 3,
    targetReps: 10,
    targetDuration: null,
    rest: 30,
    saved: false,
    busy: false,
    mappings: 1,
    media: 'embed',
    completion: { completedAt: EDGE_INSTANTS[5], qualifiesForStreak: true },
    locale: 'en-IN',
    timeZone: 'UTC',
    fontScale: 1,
    deviceWidth: 375,
    ...overrides,
  };
}

describe('date label grid — 12 locales × 8 time zones × 3 edge instants', () => {
  const instants = [EDGE_INSTANTS[0], EDGE_INSTANTS[2], EDGE_INSTANTS[5]];
  const grid: Array<{
    locale: Locale;
    timeZone: TimeZone;
    completedAt: string;
  }> = [];
  for (const locale of LOCALES) {
    for (const timeZone of TIMEZONES) {
      for (const completedAt of instants)
        grid.push({ locale, timeZone, completedAt });
    }
  }

  test(`${grid.length} rendered variants: "Logged <date>" is the zone-local calendar day, intact, sentinel-free`, () => {
    const rows = grid.map(cell => {
      const outcome = runVariant(
        completedVariant({
          locale: cell.locale,
          timeZone: cell.timeZone,
          completion: {
            completedAt: cell.completedAt,
            qualifiesForStreak: false,
          },
        }),
      );
      const expected = new Intl.DateTimeFormat(cell.locale, {
        timeZone: cell.timeZone,
      }).format(new Date(cell.completedAt));
      return {
        ...cell,
        expected,
        status: outcome.status,
        violations: outcome.violations,
      };
    });
    writeArtifact('date-grid.json', rows);
    expect(rows.filter(r => r.status === 'BROKEN')).toEqual([]);
    // Day-boundary instant really lands on different calendar days at UTC+14 vs UTC-12.
    const plus14 = rows.find(
      r =>
        r.timeZone === 'Pacific/Kiritimati' &&
        r.locale === 'en-IN' &&
        r.completedAt === EDGE_INSTANTS[5],
    );
    const minus12 = rows.find(
      r =>
        r.timeZone === 'Etc/GMT+12' &&
        r.locale === 'en-IN' &&
        r.completedAt === EDGE_INSTANTS[5],
    );
    expect(plus14?.expected).toBe('16/6/2026');
    expect(minus12?.expected).toBe('14/6/2026');
    expect(rows.length).toBe(grid.length);
  });

  test('process time zone: un-mocked toLocaleDateString renders the process-local day', () => {
    // No spy here: whatever TZ this jest process runs under is honoured.
    const fixture = buildFixture(completedVariant({}));
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(fixture.now);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <PlanDrillCard
          item={fixture.item}
          detail={fixture.detail}
          busy={false}
          onToggleSaved={jest.fn()}
          onConfirmComplete={jest.fn()}
          onOpenMedia={jest.fn()}
        />,
      );
    });
    const json = renderer.toJSON();
    const tree = Array.isArray(json) ? json[0] : json;
    const logged = collectTexts(tree as HostNode).find(t =>
      t.text.startsWith('Logged '),
    );
    const expected = new Intl.DateTimeFormat(undefined).format(
      new Date(EDGE_INSTANTS[5]),
    );
    expect(logged?.text).toBe(`Logged ${expected}`);
    writeArtifact('process-tz.json', {
      TZ: process.env.TZ ?? null,
      resolvedTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      rendered: logged?.text,
    });
    act(() => {
      renderer.unmount();
    });
    nowSpy.mockRestore();
  });
});

describe('layout grid — 3 font scales × 3 widths × archetypes', () => {
  const archetypes: Array<{ name: string; overrides: Partial<Variant> }> = [
    {
      name: 'saved-short',
      overrides: { component: 'SavedDrillCard', media: 'embed' },
    },
    {
      name: 'saved-long-cjk',
      overrides: {
        component: 'SavedDrillCard',
        media: 'hosted-live',
        strings: {
          title: 'cjk-200',
          description: 'arabic-rtl-200',
          coach: 'german-compound',
          cue: 'latin-short',
          creator: 'zwj-emoji',
          license: 'thai-200',
          attribution: 'combining-marks',
        },
      },
    },
    { name: 'plan-short-open', overrides: { completion: null } },
    { name: 'plan-short-complete', overrides: {} },
    {
      name: 'plan-warmup-duration',
      overrides: {
        kind: 'warmup',
        completion: null,
        targetReps: null,
        targetDuration: 7200,
        rest: 900,
      },
    },
    {
      name: 'plan-long-german',
      overrides: {
        completion: null,
        strings: {
          title: 'german-compound',
          description: 'latin-240-unbroken',
          coach: 'devanagari',
          cue: 'zwj-emoji',
          creator: 'latin-200-words',
          license: 'bidi-mixed',
          attribution: 'zero-width-control',
        },
      },
    },
    {
      name: 'plan-no-prescription',
      overrides: {
        completion: null,
        targetSets: null,
        rest: null,
        media: 'detail-no-media',
      },
    },
    { name: 'plan-position-20', overrides: { completion: null, position: 20 } },
  ];

  test(`${archetypes.length * FONT_SCALES.length * DEVICE_WIDTHS.length} rendered variants: a11y holds; layout-model overflows are only the pinned defects`, () => {
    const rows: Array<Record<string, unknown>> = [];
    let broken = 0;
    for (const archetype of archetypes) {
      for (const fontScale of FONT_SCALES) {
        for (const deviceWidth of DEVICE_WIDTHS) {
          const outcome = runVariant(
            completedVariant({
              ...archetype.overrides,
              fontScale,
              deviceWidth,
            }),
          );
          if (outcome.status === 'BROKEN') broken += 1;
          rows.push({
            archetype: archetype.name,
            fontScale,
            deviceWidth,
            status: outcome.status,
            knownDefects: outcome.knownDefects,
            layout: outcome.violations
              .filter(v => v.kind.startsWith('LAYOUT_'))
              .map(v => ({
                kind: v.kind,
                path: v.path,
                detail: v.detail,
                knownDefect: v.knownDefect,
              })),
            a11y: outcome.violations
              .filter(v => v.kind.startsWith('A11Y_'))
              .map(v => v.kind),
          });
        }
      }
    }
    writeArtifact('layout-grid.json', rows);
    expect(rows.filter(r => (r.a11y as string[]).length > 0)).toEqual([]);
    expect(broken).toBe(0);
    // At the default font scale on every width nothing spills past a border
    // box or clips (padding intrusion of the completion label is tolerated).
    const hardAtDefault = rows.filter(
      r =>
        r.fontScale === 1 &&
        (r.layout as Array<{ kind: string }>).some(
          l => l.kind !== 'LAYOUT_ROW_PADDING_INTRUSION',
        ),
    );
    expect(hardAtDefault).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Helper fuzz (pure functions)
// ---------------------------------------------------------------------------

describe('prescriptionLabel / firstPlayableMedia boundary fuzz', () => {
  const FUZZ = Math.max(ITERATIONS, 150);

  test(`prescriptionLabel: ${FUZZ} seeded numeric triples never throw; null/falsy sets → null; reps win over duration`, () => {
    const rng = createSeededRng(CAMPAIGN_SEED ^ 0xabcdef);
    const table: Array<Record<string, unknown>> = [];
    for (let i = 0; i < FUZZ; i += 1) {
      const item: TrainingPlanItem = {
        ...buildFixture(variantFor(CAMPAIGN_SEED, 0)).item,
        targetSets: rng.pick(NUMERIC_POOLS.targetSets),
        targetRepetitionsPerSet: rng.pick(NUMERIC_POOLS.targetReps),
        targetDurationSeconds: rng.pick(NUMERIC_POOLS.targetDuration),
      };
      const label = prescriptionLabel(item);
      table.push({
        sets: String(item.targetSets),
        reps: String(item.targetRepetitionsPerSet),
        duration: String(item.targetDurationSeconds),
        label,
      });
      if (!item.targetSets) {
        expect(label).toBeNull();
      } else if (item.targetRepetitionsPerSet !== null) {
        expect(label).toBe(
          `${item.targetSets} × ${item.targetRepetitionsPerSet} reps`,
        );
      } else if (item.targetDurationSeconds !== null) {
        expect(label).toBe(
          `${item.targetSets} × ${item.targetDurationSeconds} sec`,
        );
      } else {
        expect(label).toBeNull();
      }
    }
    writeArtifact('prescription-fuzz.json', table);
  });

  test('firstPlayableMedia: expiry is strict (expiresAt === now is NOT playable), invalid expiry skipped, embeds always playable', () => {
    const now = NOW;
    const mk = (expiresAt: string, id: string): InstructionalMedia => ({
      id,
      kind: 'hosted',
      playbackUrl: 'https://cdn.example.com/x.m3u8',
      expiresAt,
      sourceUrl: 'https://example.com',
      creatorName: 'c',
      licenseName: 'l',
      licenseUrl: null,
      attribution: 'a',
    });
    const detail = (media: InstructionalMedia[]): DrillDetail => ({
      ...buildFixture(variantFor(CAMPAIGN_SEED, 0)).detail!,
      instructionalMedia: media,
    });
    expect(firstPlayableMedia(undefined, now)).toBeNull();
    expect(firstPlayableMedia(detail([]), now)).toBeNull();
    expect(
      firstPlayableMedia(detail([mk(new Date(now).toISOString(), 'eq')]), now),
    ).toBeNull();
    expect(
      firstPlayableMedia(
        detail([mk(new Date(now + 1).toISOString(), 'p1')]),
        now,
      )?.id,
    ).toBe('p1');
    expect(
      firstPlayableMedia(detail([mk('not-a-date', 'bad')]), now),
    ).toBeNull();
    expect(firstPlayableMedia(detail([mk('', 'empty')]), now)).toBeNull();
    const embed = buildMedia(
      { ...variantFor(CAMPAIGN_SEED, 0), media: 'embed' },
      buildFixture(variantFor(CAMPAIGN_SEED, 0)).strings,
    )[0]!;
    expect(
      firstPlayableMedia(detail([mk('not-a-date', 'bad'), embed]), now),
    ).toBe(embed);
    expect(
      firstPlayableMedia(
        detail([mk('+275760-09-13T00:00:00.000Z', 'max')]),
        now,
      )?.id,
    ).toBe('max');
    expect(
      firstPlayableMedia(
        detail([mk('-271821-04-20T00:00:00.000Z', 'min')]),
        now,
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pinned defects (minimised reproductions). Each documents CURRENT behaviour.
// ---------------------------------------------------------------------------

describe('pinned defects (reproductions of current behaviour)', () => {
  test('TC-BIA-01 reproduction: position 10 renders badge "010" (positions 1..9 render "01".."09")', () => {
    const ok = runVariant(completedVariant({ completion: null, position: 9 }));
    expect(ok.violations.filter(v => v.kind === 'TEXT_POSITION_LABEL')).toEqual(
      [],
    );
    for (const position of [10, 20]) {
      const outcome = runVariant(
        completedVariant({ completion: null, position }),
      );
      const v = outcome.violations.find(x => x.kind === 'TEXT_POSITION_LABEL');
      expect(v?.detail).toBe(
        `position ${position} rendered as "0${position}", expected "${position}"`,
      );
      expect(v?.knownDefect).toBe('TC-BIA-01');
    }
  });

  test('TC-BIA-02 reproduction (layout model): single-word TARGETED kicker pushes the bookmark past the card at AX5 (3.118×) on 320pt', () => {
    const plan = runVariant(
      completedVariant({
        completion: null,
        kind: 'targeted',
        fontScale: 3.118,
        deviceWidth: 320,
      }),
    );
    const v = plan.violations.find(x => x.knownDefect === 'TC-BIA-02');
    expect(v?.kind).toBe('LAYOUT_ROW_OVERFLOW');
    expect(v?.path).toBe(CARD_TOP_PATH);
    expect(v?.detail).toContain('deviceWidth=320 fontScale=3.118');
    const spill = Number(
      /, ([\d.]+)pt past border box/.exec(v?.detail ?? '')?.[1],
    );
    expect(spill).toBeGreaterThan(SCREEN_PADDING); // past the card's own 24pt padding
    // The two-word SAVED DRILL kicker wraps inside the row instead.
    const saved = runVariant(
      completedVariant({
        component: 'SavedDrillCard',
        fontScale: 3.118,
        deviceWidth: 320,
      }),
    );
    expect(saved.violations.filter(x => x.path === CARD_TOP_PATH)).toEqual([]);
    // WARM-UP (hyphen break available but not needed) still overflows, though
    // it stays inside the card's 24pt padding.
    const warmup = runVariant(
      completedVariant({
        completion: null,
        kind: 'warmup',
        fontScale: 3.118,
        deviceWidth: 320,
      }),
    );
    const w = warmup.violations.find(x => x.path === CARD_TOP_PATH);
    const warmSpill = Number(
      /, ([\d.]+)pt past border box/.exec(w?.detail ?? '')?.[1],
    );
    expect(warmSpill).toBeGreaterThan(0);
    expect(warmSpill).toBeLessThan(SCREEN_PADDING);
    // Not reproduced at the default scale or on the widest device.
    for (const overrides of [
      { fontScale: 1 as const, deviceWidth: 320 as const },
      { fontScale: 3.118 as const, deviceWidth: 430 as const },
    ]) {
      const fine = runVariant(
        completedVariant({ completion: null, kind: 'targeted', ...overrides }),
      );
      expect(fine.violations.filter(x => x.path === CARD_TOP_PATH)).toEqual([]);
    }
  });

  test('TC-BIA-03 reproduction (layout model): completion label intrudes into the button padding but never past its border box', () => {
    for (const fontScale of FONT_SCALES) {
      for (const deviceWidth of DEVICE_WIDTHS) {
        const outcome = runVariant(
          completedVariant({ completion: null, fontScale, deviceWidth }),
        );
        const hard = outcome.violations.filter(
          x =>
            x.kind === 'LAYOUT_ROW_OVERFLOW' &&
            x.evidence.includes('"minHeight":54'),
        );
        expect(hard).toEqual([]);
        const soft = outcome.violations.find(
          x => x.knownDefect === 'TC-BIA-03',
        );
        if (soft) {
          const spill = Number(
            /overflow ([\d.]+)pt past content box/.exec(soft.detail)?.[1],
          );
          expect(spill).toBeGreaterThan(0);
          expect(spill).toBeLessThanOrEqual(26);
          expect(soft.evidence).toContain('"paddingHorizontal":16');
        }
      }
    }
    const narrow = runVariant(
      completedVariant({
        completion: null,
        fontScale: 1.353,
        deviceWidth: 320,
      }),
    );
    expect(narrow.violations.some(x => x.knownDefect === 'TC-BIA-03')).toBe(
      true,
    );
  });

  test('TC-BIA-04 reproduction (layout model): 34×34 badge clips "02" at AX5 (lineHeight 14 × 3.118 = 43.7pt)', () => {
    const outcome = runVariant(
      completedVariant({ completion: null, fontScale: 3.118 }),
    );
    const v = outcome.violations.find(x => x.knownDefect === 'TC-BIA-04');
    expect(v?.detail).toContain('fixed box 34×34');
    const fine = runVariant(
      completedVariant({ completion: null, fontScale: 1.353 }),
    );
    expect(
      fine.violations.filter(x => x.kind === 'LAYOUT_FIXED_BOX_CLIP'),
    ).toEqual([]);
  });

  test('TC-BIA-05 reproduction: out-of-domain numerics render verbatim', () => {
    const cases: Array<[Partial<Variant>, string]> = [
      [{ targetSets: 3, targetReps: -5 }, '3 × -5 reps'],
      [{ targetSets: 3, targetReps: 2.5 }, '3 × 2.5 reps'],
      [{ targetSets: Infinity, targetReps: 10 }, 'Infinity × 10 reps'],
      [{ targetSets: 3, targetReps: null, targetDuration: 0 }, '3 × 0 sec'],
      [
        { targetSets: 1_000_000, targetReps: 1_000_000_000 },
        '1000000 × 1000000000 reps',
      ],
    ];
    for (const [overrides, expectedLabel] of cases) {
      const outcome = runVariant(
        completedVariant({ completion: null, ...overrides }),
      );
      const fixture = buildFixture(
        completedVariant({ completion: null, ...overrides }),
      );
      expect(prescriptionLabel(fixture.item)).toBe(expectedLabel);
      expect(outcome.violations.some(v => v.knownDefect === 'TC-BIA-05')).toBe(
        true,
      );
    }
    // NaN / 0 / -0 sets short-circuit to "no prescription" (falsy check).
    for (const targetSets of [NaN, 0, -0]) {
      const variant = completedVariant({
        completion: null,
        targetSets,
        targetReps: 10,
      });
      const outcome = runVariant(variant);
      expect(outcome.controls).toBe(2); // bookmark + media only, no completion button
      const { renderer, tree } = render(
        variant,
        buildFixture(variant),
        mockHandlers(),
      );
      expect(collectTexts(tree as HostNode).some(t => t.text === '—')).toBe(
        true,
      );
      act(() => {
        renderer.unmount();
      });
    }
    // But a NEGATIVE sets count is truthy and renders.
    const negative = buildFixture(
      completedVariant({ completion: null, targetSets: -1, targetReps: 10 }),
    );
    expect(prescriptionLabel(negative.item)).toBe('-1 × 10 reps');
  });

  test('TC-BIA-06 reproduction: blank title → labels "Save " / "Watch reviewed instruction for " / "Confirm completion of "', () => {
    const outcome = runVariant(
      completedVariant({
        completion: null,
        strings: { ...completedVariant({}).strings, title: 'empty' },
      }),
    );
    const blank = outcome.violations.filter(v => v.knownDefect === 'TC-BIA-06');
    expect(blank.map(v => v.detail)).toEqual([
      'label "Save " has no subject (title was blank)',
      'label "Watch reviewed instruction for " has no subject (title was blank)',
      'label "Confirm completion of " has no subject (title was blank)',
    ]);
    // Whitespace-only titles hit the same path.
    const ws = runVariant(
      completedVariant({
        completion: null,
        strings: { ...completedVariant({}).strings, title: 'whitespace' },
      }),
    );
    expect(
      ws.violations.filter(v => v.knownDefect === 'TC-BIA-06').length,
    ).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Invariants that must hold on every variant (cheap, explicit)
// ---------------------------------------------------------------------------

describe('explicit a11y invariants', () => {
  test('every interactive element in both cards has role=button, a label, accessible=true and a ≥44pt target', () => {
    for (const component of ['SavedDrillCard', 'PlanDrillCard'] as const) {
      for (const busy of [false, true]) {
        for (const completion of [
          null,
          { completedAt: EDGE_INSTANTS[6], qualifiesForStreak: true },
        ]) {
          const outcome = runVariant(
            completedVariant({
              component,
              busy,
              completion,
              media: 'hosted-live',
            }),
          );
          const a11y = outcome.violations.filter(v =>
            v.kind.startsWith('A11Y_'),
          );
          expect(a11y).toEqual([]);
          expect(outcome.controls).toBe(component === 'SavedDrillCard' ? 2 : 3);
        }
      }
    }
    expect(MIN_TARGET_PT).toBe(44);
  });

  test('PlanDrillCard with a null drill renders nothing (reassessment items carry no drill)', () => {
    const fixture = buildFixture(completedVariant({ kind: 'reassessment' }));
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <PlanDrillCard
          item={{ ...fixture.item, drill: null }}
          detail={undefined}
          busy={false}
          onToggleSaved={jest.fn()}
          onConfirmComplete={jest.fn()}
          onOpenMedia={jest.fn()}
        />,
      );
    });
    expect(renderer.toJSON()).toBeNull();
  });
});
