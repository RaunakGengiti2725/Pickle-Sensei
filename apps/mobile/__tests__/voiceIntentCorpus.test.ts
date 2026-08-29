/**
 * Voice-intent phrase corpus — SYNTHETIC transcripts written by hand for
 * this test (no real user speech, no speech engine involved). The contract
 * under test is transcript-in → intent-out only: the deterministic
 * voice-intent-v2 grammar (61-technique taxonomy) plus its projection into
 * the capture-selectable registry the mobile picker declares through.
 *
 * Honesty invariants exercised:
 *  - a coarse phrase ("forehand") stays a coarse intent — never an invented
 *    L3 leaf;
 *  - unknown phrases resolve to an honest unknown carrying re-prompt copy;
 *  - every output terminates in a versioned registry (taxonomy slug or
 *    SELECTABLE_TECHNIQUES_V1 canonical);
 *  - a declared intent is a PRIOR: the TechniqueIntent it becomes keeps
 *    declared/predicted separate (predictedStroke lives in the analysis
 *    envelope, never here).
 */
import {
  PICKLEBALL_TECHNIQUES,
  projectVoiceResolution,
  resolveVoiceTechniqueIntent,
  SELECTABLE_TECHNIQUES_V1,
  VOICE_INTENT_VERSION,
  type PickleballTechniqueSlug,
} from '@pickle/shared-types';

const TAXONOMY_SLUGS = new Set<string>(
  PICKLEBALL_TECHNIQUES.map(technique => technique.slug),
);
const SELECTABLE_CANONICALS = new Set(
  SELECTABLE_TECHNIQUES_V1.map(technique => technique.canonical),
);

/** [transcript, expected taxonomy leaf] — fully specified phrases. */
const LEAF_CORPUS: ReadonlyArray<[string, PickleballTechniqueSlug]> = [
  ['crosscourt forehand dink', 'dink_crosscourt_forehand'],
  ['straight backhand dink', 'dink_straight_backhand'],
  ['forehand topspin dink', 'dink_topspin_forehand'],
  ['work on my forehand drive', 'drive_forehand'],
  ['backhand drive please', 'drive_backhand'],
  ['forehand slice groundstroke', 'slice_forehand'],
  ['backhand slice return', 'return_slice_backhand'],
  ['forehand drive return', 'return_drive_forehand'],
  ['backhand block return', 'return_block_backhand'],
  ['forehand volley serve', 'volley_serve_forehand'],
  ['backhand drop serve', 'drop_serve_backhand'],
  ['forehand third shot drop', 'third_shot_drop_forehand'],
  ['backhand transition drop', 'transition_drop_backhand'],
  ['forehand volley reset', 'reset_volley_forehand'],
  ['backhand half volley reset', 'reset_half_volley_backhand'],
  ['forehand punch volley', 'punch_volley_forehand'],
  ['backhand block volley', 'block_volley_backhand'],
  ['two handed backhand dink', 'dink_two_hand_backhand'],
  ['forehand speed up', 'speedup_forehand'],
  ['speed up on the backhand side', 'speedup_backhand'],
  ['forehand roll volley', 'roll_volley_forehand'],
  ['backhand swinging volley', 'swinging_volley_backhand'],
  ['forehand counter', 'counter_forehand'],
  ['overhead smash', 'overhead_smash'],
  ['backhand overhead', 'backhand_overhead'],
  ['forehand offensive lob', 'offensive_lob_forehand'],
  ['backhand defensive lob', 'defensive_lob_backhand'],
  ['forehand around the post', 'around_the_post_forehand'],
  ['backhand erne', 'erne_backhand'],
  ['bert', 'bert'],
  ['tweener', 'tweener'],
  ['forehand squash shot', 'squash_shot_forehand'],
];

/** Coarse phrases: [transcript, expected status, minimum candidate count]. */
const COARSE_CORPUS: ReadonlyArray<[string, 'side' | 'family', number]> = [
  ['forehand', 'side', 2],
  ['my backhand', 'side', 2],
  ['dink', 'family', 2],
  ['backhand dink', 'family', 2],
  ['volley', 'family', 2],
  ['serve', 'family', 2],
  ['returns', 'family', 2],
  ['drop', 'family', 2],
  ['reset', 'family', 2],
  ['lob', 'family', 2],
  ['dink or volley', 'family', 2],
];

const AUTO_CORPUS = [
  'auto',
  'auto detect',
  'just detect it',
  'not sure',
  "i don't know",
  'whatever you think',
] as const;

const UNKNOWN_CORPUS = [
  '',
  '   ',
  'make me a sandwich',
  'pickleball',
  'left a bit',
  'zzzzz',
  'my elbow hurts',
] as const;

/** Misspelled/ASR-variant phrases: [transcript, expected taxonomy leaf]. */
const MISSPELLING_LEAF_CORPUS: ReadonlyArray<
  [string, PickleballTechniqueSlug]
> = [
  ['forhand drive', 'drive_forehand'],
  ['four hand drive', 'drive_forehand'],
  ['crosscort forehand dink', 'dink_crosscourt_forehand'],
  ['forehand punch volly', 'punch_volley_forehand'],
];

/** Multi-intent phrases: must stay coarse — a side/leaf is never guessed. */
const MULTI_INTENT_CORPUS = [
  'forehand and backhand dink',
  'forehand or backhand drive',
  'backhand and forehand volley',
  'serve and return',
] as const;

/** Everyday idioms reusing technique words: honest unknown, never a route. */
const IDIOM_CORPUS = [
  'serve dinner tonight',
  'that serves you right',
  'return my call later',
  'can you return it',
  'drop me off at the court',
  'just drop it',
  'on a roll today',
  'drive home safely',
  'block out the sun',
] as const;

describe('voice-intent phrase corpus (synthetic): leaf commitments', () => {
  it.each(LEAF_CORPUS)('"%s" → %s', (transcript, slug) => {
    const resolution = resolveVoiceTechniqueIntent(transcript);
    expect(resolution.status).toBe('leaf');
    if (resolution.status !== 'leaf') return;
    expect(resolution.slug).toBe(slug);
    expect(TAXONOMY_SLUGS.has(resolution.slug)).toBe(true);
  });
});

describe('voice-intent phrase corpus (synthetic): coarse phrases never invent an L3', () => {
  it.each(COARSE_CORPUS)(
    '"%s" stays %s-level',
    (transcript, status, minimum) => {
      const resolution = resolveVoiceTechniqueIntent(transcript);
      expect(resolution.status).toBe(status);
      if (resolution.status !== 'side' && resolution.status !== 'family')
        return;
      expect(resolution.candidates.length).toBeGreaterThanOrEqual(minimum);
      for (const slug of resolution.candidates) {
        expect(TAXONOMY_SLUGS.has(slug)).toBe(true);
      }
    },
  );

  it('"forehand" resolves side-level with only forehand taxonomy candidates', () => {
    const resolution = resolveVoiceTechniqueIntent('forehand');
    expect(resolution.status).toBe('side');
    if (resolution.status !== 'side') return;
    for (const slug of resolution.candidates) {
      expect(slug.includes('forehand')).toBe(true);
    }
  });
});

describe('voice-intent phrase corpus (synthetic): auto + honest unknown', () => {
  it.each(AUTO_CORPUS.map(transcript => [transcript]))(
    '"%s" → auto',
    transcript => {
      expect(resolveVoiceTechniqueIntent(transcript).status).toBe('auto');
    },
  );

  it.each(UNKNOWN_CORPUS.map(transcript => [transcript]))(
    '"%s" → unknown with re-prompt copy',
    transcript => {
      const resolution = resolveVoiceTechniqueIntent(transcript);
      expect(resolution.status).toBe('unknown');
      if (resolution.status !== 'unknown') return;
      expect(resolution.rePrompt.length).toBeGreaterThan(0);
    },
  );
});

describe('voice-intent robustness (v2): misspellings, multi-intent, idioms', () => {
  it.each(MISSPELLING_LEAF_CORPUS)(
    'misspelled "%s" → %s',
    (transcript, slug) => {
      const resolution = resolveVoiceTechniqueIntent(transcript);
      expect(resolution.status).toBe('leaf');
      if (resolution.status !== 'leaf') return;
      expect(resolution.slug).toBe(slug);
    },
  );

  it.each(MULTI_INTENT_CORPUS.map(transcript => [transcript]))(
    'multi-intent "%s" never silently selects one technique',
    transcript => {
      const projected = projectVoiceResolution(
        resolveVoiceTechniqueIntent(transcript),
      );
      expect(projected.status).not.toBe('resolved');
    },
  );

  it.each(IDIOM_CORPUS.map(transcript => [transcript]))(
    'idiom "%s" → never resolves to a technique',
    transcript => {
      const projected = projectVoiceResolution(
        resolveVoiceTechniqueIntent(transcript),
      );
      expect(projected.status).not.toBe('resolved');
      expect(projected.status).not.toBe('ambiguous');
    },
  );
});

describe('projection into the capture-selectable registry (declared PRIOR path)', () => {
  it('resolved projections terminate in SELECTABLE_TECHNIQUES_V1', () => {
    for (const [transcript] of LEAF_CORPUS) {
      const projected = projectVoiceResolution(
        resolveVoiceTechniqueIntent(transcript),
      );
      if (projected.status === 'resolved') {
        expect(SELECTABLE_CANONICALS.has(projected.technique.canonical)).toBe(
          true,
        );
      } else if (projected.status === 'ambiguous') {
        for (const option of projected.options) {
          expect(SELECTABLE_CANONICALS.has(option.canonical)).toBe(true);
        }
      } else {
        // Taxonomy techniques without a selectable analog (lobs, specialty,
        // counters) must project to an honest unknown — never rounded.
        expect(projected.status).toBe('unknown');
      }
    }
  });

  it('common product phrases project to the expected declared technique', () => {
    for (const [transcript, canonical] of [
      ['forehand drive', 'FOREHAND_DRIVE'],
      ['backhand dink', 'BACKHAND_DINK'],
      ['serve', 'SERVE'],
      ['returns', 'RETURN'],
      ['overhead smash', 'OVERHEAD'],
      ['forehand third shot drop', 'DROP'],
      ['reset', 'RESET'],
      ['forehand speed up', 'SPEEDUP'],
    ] as const) {
      const projected = projectVoiceResolution(
        resolveVoiceTechniqueIntent(transcript),
      );
      expect(projected.status).toBe('resolved');
      if (projected.status === 'resolved') {
        expect(projected.technique.canonical).toBe(canonical);
      }
    }
  });

  it('specialty techniques never round into a selectable declaration', () => {
    for (const transcript of [
      'tweener',
      'bert',
      'forehand erne',
      'backhand defensive lob',
    ]) {
      const projected = projectVoiceResolution(
        resolveVoiceTechniqueIntent(transcript),
      );
      expect(projected.status).toBe('unknown');
    }
  });

  it('resolution objects are versioned voice-intent-v2', () => {
    for (const [transcript] of LEAF_CORPUS) {
      expect(resolveVoiceTechniqueIntent(transcript).version).toBe(
        VOICE_INTENT_VERSION,
      );
    }
  });
});
