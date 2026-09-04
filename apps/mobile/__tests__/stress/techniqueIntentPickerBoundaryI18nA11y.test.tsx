/**
 * STRESS — TechniqueIntentPicker × boundary / i18n / a11y.
 *
 * Every variant renders the real component through react-test-renderer and
 * audits the HOST tree react-native hands to the platform:
 *   - the field and every chip carry a role + accessibility label and model
 *     to ≥ 44 pt at the variant's Dynamic Type scale and window width
 *   - the visible grid is always a subset of SELECTABLE_TECHNIQUES_V1 plus
 *     "Auto detect", the selected technique never disappears from the grid,
 *     and exactly one chip is `selected`
 *   - `onChange` emissions match the shared resolver byte-for-byte (source,
 *     canonical, legacySlug, confidence, rawUserText) — the component may
 *     never guess a technique the resolver did not resolve
 *   - no rendered text is "undefined"/"null"/"[object Object]", no copy
 *     violates the store dossier word list, the field echoes the typed text
 *     unchanged (no silent normalisation of what the user wrote)
 *
 * Campaigns (all seeded and replayable from `seed`/`cell`):
 *   matrix   3 widths × 3 font scales × light/dark × 4 `value` shapes
 *   corpus   boundary strings (empty / 20k noise / ZWJ / RTL / combining /
 *            CJK / Arabic / German compounds / fullwidth / Turkish İ …) and
 *            the 12-locale phrase list, each typed into a fresh render
 *   fuzz     STRESS_ITER seeded interaction sequences: generated phrases
 *            (technique words × negations × auto words × Unicode noise),
 *            submit, chip taps, value-prop swaps, theme flips, width/scale
 *
 * HARD checks fail the test. STRICT checks (the i18n expectations below) are
 * recorded as BROKEN rows and only fail under STRESS_STRICT=1:
 *   - a phrase that is exactly a technique display name — optionally with
 *     iOS Smart Punctuation (’), Turkish dotted İ, Latin diacritics, or
 *     fullwidth Latin — should resolve to that technique
 *   - an auto phrase with a curly apostrophe (“don’t know”) should reach
 *     the AUTO intent exactly like its straight-apostrophe twin
 *
 * Output: artifacts/stress/picker-*.json (STRESS_OUT overrides).
 */
import React from 'react';
import { Dimensions, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  SELECTABLE_TECHNIQUES_V1,
  TECHNIQUE_INTENT_VERSION,
  projectVoiceResolution,
  resolveVoiceTechniqueIntent,
  type TechniqueIntent,
} from '@pickle/shared-types';
import {
  TechniqueIntentPicker,
  autoDetectIntent,
} from '../../src/flow/TechniqueIntentPicker';
import {
  auditInteractive,
  compactTree,
} from '../../test-support/stress/a11yAudit';
import {
  STRESS_ITER,
  campaignSeeds,
  summarizePayload,
  writeCampaignTable,
  writeStressArtifact,
  type CampaignRow,
} from '../../test-support/stress/artifacts';
import {
  AUTO_WORDS,
  BOUNDARY_INPUTS,
  FONT_SCALES,
  LOCALES,
  LOCALE_INPUTS,
  LONG_STRINGS,
  NEGATION_WORDS,
  NOISE_TOKENS,
  TECHNIQUE_WORDS,
  VIEWPORTS,
} from '../../test-support/stress/corpus';
import {
  createRng,
  seedFromString,
  type Rng,
} from '../../test-support/stress/rng';

declare const process: { env: Record<string, string | undefined> };

const STRICT = process.env.STRESS_STRICT === '1';
const DEFAULT_WINDOW = { width: 750, height: 1334, scale: 2, fontScale: 2 };
const AUTO_LABEL = 'Auto detect';
const FIELD_LABEL = 'Type or dictate the technique you are working on';
const GROUP_LABEL = 'Which technique are you working on?';
const FORBIDDEN_COPY =
  /android|google play|guest mode|live court|dupr|swingvision|pb vision|selkirk|joola|\d+\s*% accura/i;
const DISPLAY_NAMES = new Set(
  SELECTABLE_TECHNIQUES_V1.map(technique => technique.displayName),
);

type Renderer = TestRenderer.ReactTestRenderer;

interface Variant {
  value: TechniqueIntent | null;
  dark: boolean;
  width: number;
  height: number;
  fontScale: number;
}

function setWindow(width: number, height: number, fontScale: number) {
  const metrics = { width, height, scale: 3, fontScale };
  Dimensions.set({ window: metrics, screen: metrics });
}

afterEach(() => {
  Dimensions.set({ window: DEFAULT_WINDOW, screen: DEFAULT_WINDOW });
});

function tapIntent(canonical: string): TechniqueIntent {
  const technique = SELECTABLE_TECHNIQUES_V1.find(
    item => item.canonical === canonical,
  )!;
  return {
    version: TECHNIQUE_INTENT_VERSION,
    source: 'tap',
    canonical: technique.canonical,
    legacySlug: technique.legacySlug,
    confidence: 1,
  };
}

const VALUE_SHAPES: ReadonlyArray<{
  id: string;
  value: TechniqueIntent | null;
}> = [
  { id: 'null', value: null },
  { id: 'tap-forehand-dink', value: tapIntent('FOREHAND_DINK') },
  { id: 'auto', value: autoDetectIntent() },
  {
    id: 'foreign-canonical',
    value: {
      version: TECHNIQUE_INTENT_VERSION,
      source: 'voice',
      canonical: 'TWEENER',
      legacySlug: null,
      confidence: 0.5,
      rawUserText: 'tweener',
    },
  },
];

class Harness {
  readonly emitted: Array<TechniqueIntent | null> = [];
  renderer!: Renderer;
  variant: Variant;

  constructor(variant: Variant) {
    this.variant = variant;
  }

  private readonly onChange = (intent: TechniqueIntent | null) => {
    this.emitted.push(intent);
  };

  async mount() {
    setWindow(this.variant.width, this.variant.height, this.variant.fontScale);
    await act(async () => {
      this.renderer = TestRenderer.create(
        <TechniqueIntentPicker
          value={this.variant.value}
          onChange={this.onChange}
          dark={this.variant.dark}
        />,
      );
    });
  }

  async update(next: Partial<Variant>) {
    this.variant = { ...this.variant, ...next };
    setWindow(this.variant.width, this.variant.height, this.variant.fontScale);
    await act(async () => {
      this.renderer.update(
        <TechniqueIntentPicker
          value={this.variant.value}
          onChange={this.onChange}
          dark={this.variant.dark}
        />,
      );
    });
  }

  unmount() {
    act(() => {
      this.renderer.unmount();
    });
  }

  field() {
    return this.renderer.root.findByType(TextInput);
  }

  async type(text: string) {
    const field = this.field();
    await act(async () => {
      (field.props.onChangeText as (value: string) => void)(text);
    });
  }

  async submit() {
    const field = this.field();
    await act(async () => {
      (field.props.onSubmitEditing as () => void)();
    });
  }

  chipHosts() {
    return this.renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        node.props.accessibilityRole === 'radio',
    );
  }

  async tapChip(label: string) {
    const chip = this.renderer.root.findAll(
      node =>
        typeof node.type !== 'string' &&
        node.props.accessibilityLabel === label &&
        typeof node.props.onPress === 'function',
    )[0];
    if (!chip) throw new Error(`no chip ${label}`);
    await act(async () => {
      (chip.props.onPress as () => void)();
    });
  }

  texts(): string[] {
    return this.renderer.root
      .findAll(node => String(node.type) === 'Text')
      .map(node => React.Children.toArray(node.props.children).join(''));
  }
}

interface Inspection {
  hard: string[];
  strict: string[];
  detail: Record<string, unknown>;
}

function expectedResolution(text: string) {
  return text.trim().length >= 3
    ? projectVoiceResolution(resolveVoiceTechniqueIntent(text))
    : null;
}

/** Audits the rendered tree against the picker's contract for `typed`. */
function inspect(harness: Harness, typed: string): Inspection {
  const hard: string[] = [];
  const strict: string[] = [];
  const { variant } = harness;
  const root = harness.renderer.root;

  const field = harness.field();
  if (field.props.accessibilityLabel !== FIELD_LABEL)
    hard.push(`field label ${String(field.props.accessibilityLabel)}`);
  if (field.props.value !== typed)
    hard.push(
      `field echoes ${summarizePayload(String(field.props.value))} ≠ typed ${summarizePayload(typed)}`,
    );

  const groups = root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.accessibilityRole === 'radiogroup',
  );
  if (groups.length !== 1) hard.push(`radiogroups: ${groups.length}`);
  else if (groups[0]!.props.accessibilityLabel !== GROUP_LABEL)
    hard.push(`group label ${String(groups[0]!.props.accessibilityLabel)}`);

  const audit = auditInteractive(root, {
    fontScale: variant.fontScale,
    windowWidth: variant.width,
    windowHeight: variant.height,
  });
  for (const issue of audit.issues)
    hard.push(`a11y:${issue.kind} ${issue.detail} @${issue.path}`);

  const chips = harness.chipHosts();
  const labels = chips.map(chip => String(chip.props.accessibilityLabel));
  const resolution = expectedResolution(typed);
  const selectedTechnique =
    SELECTABLE_TECHNIQUES_V1.find(
      technique => technique.canonical === variant.value?.canonical,
    ) ?? null;
  const expectedTechniques =
    resolution?.status === 'ambiguous'
      ? (() => {
          const narrowed = resolution.options;
          if (
            selectedTechnique &&
            !narrowed.some(
              option => option.canonical === selectedTechnique.canonical,
            )
          ) {
            return [...narrowed, selectedTechnique];
          }
          return narrowed;
        })()
      : SELECTABLE_TECHNIQUES_V1;
  const expectedLabels = [
    ...expectedTechniques.map(technique => technique.displayName),
    AUTO_LABEL,
  ];
  if (labels.join('|') !== expectedLabels.join('|')) {
    hard.push(
      `grid [${labels.join(', ')}] ≠ expected [${expectedLabels.join(', ')}]`,
    );
  }
  for (const label of labels) {
    if (label !== AUTO_LABEL && !DISPLAY_NAMES.has(label))
      hard.push(`chip label "${label}" is not a selectable display name`);
  }
  const selectedChips = chips.filter(
    chip =>
      (chip.props.accessibilityState as { selected?: boolean } | undefined)
        ?.selected === true,
  );
  const autoSelected = variant.value?.source === 'auto';
  const expectedSelected = autoSelected
    ? [AUTO_LABEL]
    : selectedTechnique
      ? [selectedTechnique.displayName]
      : [];
  const selectedLabels = selectedChips.map(chip =>
    String(chip.props.accessibilityLabel),
  );
  if (selectedLabels.join('|') !== expectedSelected.join('|'))
    hard.push(
      `selected [${selectedLabels.join(', ')}] ≠ [${expectedSelected.join(', ')}]`,
    );
  for (const chip of chips) {
    if (chip.props.accessibilityState === undefined)
      hard.push(
        `chip ${String(chip.props.accessibilityLabel)} lacks accessibilityState`,
      );
  }

  const texts = harness.texts();
  for (const text of texts) {
    if (/undefined|\[object Object\]|NaN/.test(text) || text === 'null')
      hard.push(`rendered text leaks a value: ${summarizePayload(text)}`);
    if (FORBIDDEN_COPY.test(text))
      hard.push(`copy violates dossier word list: ${summarizePayload(text)}`);
  }
  const hint = texts.find(
    text =>
      text.includes('pick one below') ||
      text.includes('tap one below') ||
      text.includes('for example'),
  );
  const selectionInNarrowed =
    resolution?.status === 'ambiguous' &&
    selectedTechnique !== null &&
    resolution.options.some(
      option => option.canonical === selectedTechnique.canonical,
    );
  if (resolution?.status === 'ambiguous' && !selectionInNarrowed) {
    if (!hint || !hint.endsWith('— pick one below.'))
      hard.push(`ambiguous input without narrowing hint (${String(hint)})`);
  } else if (resolution?.status === 'unknown') {
    if (!hint) hard.push('unknown input without re-prompt hint');
  } else if (hint) {
    hard.push(`hint shown for ${resolution?.status ?? 'short'} input: ${hint}`);
  }

  return {
    hard,
    strict,
    detail: {
      typed: summarizePayload(typed),
      typedLength: typed.length,
      typedCodePoints: Array.from(typed).length,
      resolution: resolution
        ? {
            status: resolution.status,
            ...(resolution.status === 'resolved'
              ? { technique: resolution.technique.canonical }
              : {}),
            ...(resolution.status === 'ambiguous'
              ? { options: resolution.options.map(o => o.canonical) }
              : {}),
          }
        : null,
      hint,
      chips: labels.length,
      interactive: audit.elements.map(el => ({
        label: el.label,
        role: el.role,
        size: `${el.width}×${el.height}`,
        basis: el.sizeBasis,
      })),
    },
  };
}

/** The contract for what `onChangeText(text)` may emit. */
function checkTypingEmission(
  harness: Harness,
  typed: string,
  before: number,
): string[] {
  const hard: string[] = [];
  const resolution = expectedResolution(typed);
  const emitted = harness.emitted.slice(before);
  if (resolution?.status === 'resolved') {
    if (emitted.length !== 1) {
      hard.push(
        `resolved input emitted ${emitted.length} intents (expected 1)`,
      );
    } else {
      const intent = emitted[0];
      if (
        !intent ||
        intent.version !== TECHNIQUE_INTENT_VERSION ||
        intent.source !== 'voice' ||
        intent.canonical !== resolution.technique.canonical ||
        intent.legacySlug !== resolution.technique.legacySlug ||
        intent.confidence !== resolution.confidence ||
        intent.rawUserText !== typed.trim() ||
        !(
          typeof intent.confidence === 'number' &&
          intent.confidence > 0 &&
          intent.confidence <= 1
        )
      ) {
        hard.push(
          `voice intent ${JSON.stringify(intent)} ≠ resolver ${resolution.technique.canonical}@${resolution.confidence}`,
        );
      }
    }
  } else if (emitted.length !== 0) {
    hard.push(
      `${resolution?.status ?? 'short'} input emitted ${JSON.stringify(emitted)}`,
    );
  }
  return hard;
}

function checkSubmitEmission(
  harness: Harness,
  typed: string,
  before: number,
): string[] {
  const hard: string[] = [];
  const resolution = expectedResolution(typed);
  const emitted = harness.emitted.slice(before);
  if (resolution?.status === 'resolved') {
    if (
      emitted.length !== 1 ||
      emitted[0]?.source !== 'voice' ||
      emitted[0]?.canonical !== resolution.technique.canonical
    )
      hard.push(`submit of resolved input emitted ${JSON.stringify(emitted)}`);
  } else if (resolution?.status === 'auto') {
    if (
      emitted.length !== 1 ||
      JSON.stringify(emitted[0]) !== JSON.stringify(autoDetectIntent())
    )
      hard.push(`submit of auto input emitted ${JSON.stringify(emitted)}`);
  } else if (emitted.length !== 0) {
    hard.push(
      `submit of ${resolution?.status ?? 'short'} input emitted ${JSON.stringify(emitted)}`,
    );
  }
  return hard;
}

/** i18n expectations a player would reasonably hold (STRICT class). */
function i18nExpectation(typed: string): string | null {
  const resolution = expectedResolution(typed);
  const nfkc = typed.normalize('NFKC');
  const folded = nfkc
    .replace(/[’‘]/g, "'")
    .replace(/İ/g, 'I')
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u200b-\u200f\u202a-\u202e\u061c\u2060]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[‑–—]/g, '-')
    .trim()
    .toLowerCase();
  const displayHit = SELECTABLE_TECHNIQUES_V1.find(
    technique => technique.displayName.toLowerCase() === folded,
  );
  if (displayHit && folded !== typed.trim().toLowerCase()) {
    if (
      resolution?.status !== 'resolved' ||
      resolution.technique.canonical !== displayHit.canonical
    ) {
      return `i18n: "${summarizePayload(typed)}" is the display name of ${displayHit.canonical} after Unicode folding but resolved to ${resolution?.status ?? 'nothing'}`;
    }
  }
  const straight = typed.replace(/[’‘]/g, "'");
  if (straight !== typed) {
    const twin = expectedResolution(straight);
    if (twin && resolution && twin.status !== resolution.status) {
      return `i18n: curly-apostrophe "${summarizePayload(typed)}" → ${resolution.status} but straight twin → ${twin.status}`;
    }
  }
  return null;
}

function rowFor(
  campaign: string,
  seed: number,
  cell: string,
  hard: string[],
  strict: string[],
  detail: Record<string, unknown>,
): CampaignRow {
  const violations = [...hard, ...strict];
  return {
    campaign,
    seed,
    cell,
    outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
    detail: { ...detail, hardViolations: hard.length },
    violations,
  };
}

function captureTree(
  trees: Map<string, unknown>,
  row: CampaignRow,
  harness: Harness,
) {
  if (row.outcome === 'BROKEN')
    trees.set(row.cell, compactTree(harness.renderer.root));
}

function assertRows(
  rows: CampaignRow[],
  artifactName: string,
  trees: Map<string, unknown>,
) {
  const hardBroken = rows.filter(
    row => (row.detail.hardViolations as number) > 0,
  );
  const strictBroken = rows.filter(row => row.outcome === 'BROKEN');
  if (strictBroken.length > 0) {
    writeStressArtifact(
      `${artifactName}-trees.json`,
      Object.fromEntries(trees),
    );
  }
  if (hardBroken.length > 0 || (STRICT && strictBroken.length > 0)) {
    const offending = hardBroken.length > 0 ? hardBroken : strictBroken;
    const path = writeStressArtifact(
      `${artifactName}-trees.json`,
      Object.fromEntries(trees),
    );
    throw new Error(
      `${offending.length} BROKEN rows (rendered trees: ${path}):\n` +
        offending
          .slice(0, 12)
          .map(
            row =>
              `  seed=${row.seed} cell=${row.cell}\n    ${row.violations.join('\n    ')}`,
          )
          .join('\n'),
    );
  }
}

function randomPhrase(rng: Rng): string {
  const parts: string[] = [];
  const count = rng.int(1, rng.chance(0.15) ? 40 : 6);
  for (let i = 0; i < count; i++) {
    const roll = rng.next();
    if (roll < 0.45) parts.push(rng.pick(TECHNIQUE_WORDS));
    else if (roll < 0.6) parts.push(rng.pick(NEGATION_WORDS));
    else if (roll < 0.7) parts.push(rng.pick(AUTO_WORDS));
    else if (roll < 0.85) parts.push(rng.pick(NOISE_TOKENS));
    else if (roll < 0.9) parts.push(rng.pick(LOCALE_INPUTS[rng.pick(LOCALES)]));
    else if (roll < 0.95)
      parts.push(rng.pick(SELECTABLE_TECHNIQUES_V1).displayName);
    else
      parts.push(
        rng.pick(Object.values(LONG_STRINGS)).slice(0, rng.int(1, 300)),
      );
  }
  let phrase = parts.join(
    rng.pick([' ', ' ', ' ', '', '\u00a0', '-', '  ', '\n']),
  );
  const casing = rng.pick([
    'as-is',
    'upper',
    'lower',
    'title',
    'turkish-upper',
  ] as const);
  if (casing === 'upper') phrase = phrase.toUpperCase();
  else if (casing === 'lower') phrase = phrase.toLowerCase();
  else if (casing === 'title')
    phrase = phrase.replace(/\b\w/g, c => c.toUpperCase());
  else if (casing === 'turkish-upper')
    phrase = phrase.toLocaleUpperCase('tr-TR');
  if (rng.chance(0.1)) phrase = phrase.repeat(rng.int(2, 8));
  return phrase;
}

describe('TechniqueIntentPicker stress — boundary / i18n / a11y', () => {
  it('matrix: 3 widths × 3 font scales × light/dark × 4 value shapes', async () => {
    const rows: CampaignRow[] = [];
    const trees = new Map<string, unknown>();
    for (const viewport of VIEWPORTS) {
      for (const fontScale of FONT_SCALES) {
        for (const dark of [false, true]) {
          for (const shape of VALUE_SHAPES) {
            const cell = `${viewport.name}|fs${fontScale}|${dark ? 'dark' : 'light'}|${shape.id}`;
            const harness = new Harness({
              value: shape.value,
              dark,
              width: viewport.width,
              height: viewport.height,
              fontScale,
            });
            const hard: string[] = [];
            let detail: Record<string, unknown> = {};
            try {
              await harness.mount();
              const inspection = inspect(harness, '');
              hard.push(...inspection.hard);
              detail = inspection.detail;
              // Narrow the grid with an ambiguous phrase, then clear it.
              await harness.type('dink');
              const narrowed = inspect(harness, 'dink');
              hard.push(...narrowed.hard.map(v => `[dink] ${v}`));
              detail.narrowedChips = narrowed.detail.chips;
              await harness.type('');
              hard.push(
                ...inspect(harness, '').hard.map(v => `[cleared] ${v}`),
              );
            } catch (error) {
              hard.push(
                `threw: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            const row = rowFor(
              'picker-matrix',
              seedFromString(cell),
              cell,
              hard,
              [],
              detail,
            );
            rows.push(row);
            captureTree(trees, row, harness);
            harness.unmount();
          }
        }
      }
    }
    writeCampaignTable('picker-matrix', rows);
    expect(rows).toHaveLength(
      VIEWPORTS.length * FONT_SCALES.length * 2 * VALUE_SHAPES.length,
    );
    assertRows(rows, 'picker-matrix', trees);
  });

  it('corpus: boundary strings and 12-locale phrases typed into fresh renders', async () => {
    const rows: CampaignRow[] = [];
    const trees = new Map<string, unknown>();
    const inputs: Array<{ id: string; text: string }> = [
      ...BOUNDARY_INPUTS,
      ...Object.entries(LONG_STRINGS).map(([id, text]) => ({
        id: `long-${id}`,
        text,
      })),
      ...LOCALES.flatMap(locale =>
        LOCALE_INPUTS[locale].map((text, index) => ({
          id: `${locale}#${index}`,
          text,
        })),
      ),
    ];
    for (const input of inputs) {
      const seed = seedFromString(`picker-corpus:${input.id}`);
      const rng = createRng(seed);
      const viewport = rng.pick(VIEWPORTS);
      const fontScale = rng.pick(FONT_SCALES);
      const dark = rng.chance(0.5);
      const shape = rng.pick(VALUE_SHAPES);
      const harness = new Harness({
        value: shape.value,
        dark,
        width: viewport.width,
        height: viewport.height,
        fontScale,
      });
      const cell = `${input.id}|${viewport.name}|fs${fontScale}|${dark ? 'dark' : 'light'}|${shape.id}`;
      const hard: string[] = [];
      const strict: string[] = [];
      let detail: Record<string, unknown> = {};
      const started = Date.now();
      try {
        await harness.mount();
        const before = harness.emitted.length;
        await harness.type(input.text);
        hard.push(...checkTypingEmission(harness, input.text, before));
        const inspection = inspect(harness, input.text);
        hard.push(...inspection.hard);
        detail = inspection.detail;
        const beforeSubmit = harness.emitted.length;
        await harness.submit();
        hard.push(...checkSubmitEmission(harness, input.text, beforeSubmit));
        const expectation = i18nExpectation(input.text);
        if (expectation) strict.push(expectation);
        // A chip tap must still work with hostile text in the field.
        const beforeTap = harness.emitted.length;
        const chipLabel = String(
          harness.chipHosts()[0]!.props.accessibilityLabel,
        );
        await harness.tapChip(chipLabel);
        const tapped = harness.emitted[beforeTap];
        const expectedTap =
          chipLabel === AUTO_LABEL
            ? autoDetectIntent()
            : tapIntent(
                SELECTABLE_TECHNIQUES_V1.find(t => t.displayName === chipLabel)!
                  .canonical,
              );
        if (
          harness.emitted.length !== beforeTap + 1 ||
          JSON.stringify(tapped) !== JSON.stringify(expectedTap)
        )
          hard.push(
            `tap of ${chipLabel} emitted ${JSON.stringify(harness.emitted.slice(beforeTap))}`,
          );
      } catch (error) {
        hard.push(
          `threw: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      detail.elapsedMs = Date.now() - started;
      if ((detail.elapsedMs as number) > 2000)
        hard.push(
          `variant took ${String(detail.elapsedMs)}ms (> 2000ms budget)`,
        );
      const row = rowFor('picker-corpus', seed, cell, hard, strict, detail);
      rows.push(row);
      captureTree(trees, row, harness);
      harness.unmount();
    }
    writeCampaignTable('picker-corpus', rows);
    expect(rows.length).toBeGreaterThanOrEqual(
      BOUNDARY_INPUTS.length + LOCALES.length * 5,
    );
    assertRows(rows, 'picker-corpus', trees);
  });

  it('fuzz: seeded interaction sequences (STRESS_ITER)', async () => {
    const rows: CampaignRow[] = [];
    const trees = new Map<string, unknown>();
    const seeds = campaignSeeds(seedFromString('picker-fuzz'));
    for (const seed of seeds) {
      const rng = createRng(seed);
      const viewport = rng.pick(VIEWPORTS);
      const fontScale = rng.pick([
        0.823, 1, 1.118, 1.353, 1.786, 2.143, 2.643, 3.571,
      ]);
      const harness = new Harness({
        value: rng.pick(VALUE_SHAPES).value,
        dark: rng.chance(0.5),
        width: viewport.width,
        height: viewport.height,
        fontScale,
      });
      const hard: string[] = [];
      const strict: string[] = [];
      const steps: string[] = [];
      let typed = '';
      let maxChips = 0;
      try {
        await harness.mount();
        hard.push(...inspect(harness, typed).hard.map(v => `[mount] ${v}`));
        const stepCount = rng.int(3, 12);
        for (let i = 0; i < stepCount; i++) {
          const action = rng.pick([
            'type',
            'type',
            'type',
            'submit',
            'tap',
            'value',
            'theme',
            'window',
            'clear',
          ] as const);
          if (action === 'type') {
            typed = randomPhrase(rng);
            steps.push(`type(${summarizePayload(typed, 40)})`);
            const before = harness.emitted.length;
            await harness.type(typed);
            hard.push(
              ...checkTypingEmission(harness, typed, before).map(
                v => `[${i}] ${v}`,
              ),
            );
            const expectation = i18nExpectation(typed);
            if (expectation) strict.push(`[${i}] ${expectation}`);
          } else if (action === 'clear') {
            typed = '';
            steps.push('clear');
            await harness.type('');
          } else if (action === 'submit') {
            steps.push('submit');
            const before = harness.emitted.length;
            await harness.submit();
            hard.push(
              ...checkSubmitEmission(harness, typed, before).map(
                v => `[${i}] ${v}`,
              ),
            );
          } else if (action === 'tap') {
            const chips = harness.chipHosts();
            const label = String(rng.pick(chips).props.accessibilityLabel);
            steps.push(`tap(${label})`);
            const before = harness.emitted.length;
            await harness.tapChip(label);
            const intent = harness.emitted[before];
            const expected =
              label === AUTO_LABEL
                ? autoDetectIntent()
                : tapIntent(
                    SELECTABLE_TECHNIQUES_V1.find(t => t.displayName === label)!
                      .canonical,
                  );
            if (
              harness.emitted.length !== before + 1 ||
              JSON.stringify(intent) !== JSON.stringify(expected)
            )
              hard.push(
                `[${i}] tap ${label} emitted ${JSON.stringify(harness.emitted.slice(before))}`,
              );
            // The parent commits the tapped intent, as the real flow does.
            await harness.update({ value: intent ?? null });
          } else if (action === 'value') {
            const shape = rng.pick(VALUE_SHAPES);
            steps.push(`value(${shape.id})`);
            await harness.update({ value: shape.value });
          } else if (action === 'theme') {
            steps.push('theme');
            await harness.update({ dark: !harness.variant.dark });
          } else {
            const next = rng.pick(VIEWPORTS);
            const scale = rng.pick(FONT_SCALES);
            steps.push(`window(${next.name},fs${scale})`);
            await harness.update({
              width: next.width,
              height: next.height,
              fontScale: scale,
            });
          }
          const inspection = inspect(harness, typed);
          hard.push(...inspection.hard.map(v => `[${i}:${action}] ${v}`));
          maxChips = Math.max(maxChips, inspection.detail.chips as number);
        }
      } catch (error) {
        hard.push(
          `threw: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const cell = `seed${seed}|${viewport.name}|fs${fontScale}`;
      const row = rowFor('picker-fuzz', seed, cell, hard, strict, {
        steps,
        emitted: harness.emitted.length,
        maxChips,
        finalTyped: summarizePayload(typed),
      });
      rows.push(row);
      captureTree(trees, row, harness);
      harness.unmount();
    }
    writeCampaignTable('picker-fuzz', rows);
    expect(rows).toHaveLength(seeds.length);
    expect(seeds.length).toBe(process.env.STRESS_ONLY ? 1 : STRESS_ITER);
    assertRows(rows, 'picker-fuzz', trees);
  });
});
