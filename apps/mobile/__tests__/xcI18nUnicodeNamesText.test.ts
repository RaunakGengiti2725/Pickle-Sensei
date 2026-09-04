/**
 * xc-i18n-unicode-names-text — client-side Unicode harness.
 *
 * Exercises the mobile TypeScript layers that carry user names and free text
 * (onboarding profile hydrate/save, deletion survey, kv/session persistence
 * SQL) with a seeded Unicode corpus: RTL, ZWJ emoji, combining marks, tag
 * sequences, controls, lone surrogates, 64 KiB payloads. Every measurement is
 * recorded in four units (UTF-16 units / code points / graphemes / UTF-8
 * bytes) and written to $XC_I18N_OUT when set, so counterexamples are
 * replayable from the seed + iteration recorded next to them.
 *
 * Linux/Jest evidence only: it says nothing about UITextInput `maxLength`
 * semantics or op-sqlite's native binding on iOS (see blocked_external).
 */
import type { ApiSession } from '../src/account/apiSession';
import {
  fetchCanonicalOnboardingProfile,
  saveCanonicalOnboardingProfile,
  type OnboardingFetch,
} from '../src/account/onboarding';
import {
  ACCOUNT_DELETION_DETAILS_MAX,
  requestAccountDeletion,
  type AccountDeletionSurvey,
} from '../src/account/deletion';
import type { LocalDb } from '../src/data/db';
import { getKv, setKv } from '../src/data/repository';
import type { Profile } from '../src/state/profile';

// ─── Measurement (four units) ────────────────────────────────────────────────

// The mobile tsconfig has no node/DOM libs and stops at es2022 for Intl, so
// the Node-only pieces are typed explicitly and pulled via jest.requireActual
// (same pattern as the other suites) instead of widening the app's config.
type GraphemeSegmenter = { segment(input: string): Iterable<unknown> };
type Utf8Encoder = { encode(input: string): { byteLength: number } };
type NodeEnv = {
  env: Record<string, string | undefined>;
  memoryUsage(): { heapUsed: number; heapTotal: number; rss: number };
};
const { Segmenter } = Intl as unknown as {
  Segmenter: new (
    locale: undefined,
    options: { granularity: 'grapheme' },
  ) => GraphemeSegmenter;
};
const { TextEncoder } = jest.requireActual<{
  TextEncoder: new () => Utf8Encoder;
}>('node:util');
const { mkdirSync, writeFileSync } = jest.requireActual<{
  mkdirSync(path: string, options: { recursive: boolean }): void;
  writeFileSync(path: string, data: string): void;
}>('node:fs');
const { join } = jest.requireActual<{ join(...parts: string[]): string }>(
  'node:path',
);
const nodeProcess = jest.requireActual<NodeEnv>('node:process');

const segmenter = new Segmenter(undefined, { granularity: 'grapheme' });
const encoder = new TextEncoder();
const measure = (s: string) => ({
  u16: s.length,
  cp: Array.from(s).length,
  graphemes: Array.from(segmenter.segment(s)).length,
  bytes: encoder.encode(s).byteLength,
});
const codePointsOf = (s: string): string[] =>
  Array.from(
    s,
    ch =>
      `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`,
  );

// ─── Deterministic RNG (mulberry32) ──────────────────────────────────────────

const SEED = Number.parseInt(nodeProcess.env.XC_I18N_SEED ?? '20260904', 10);
const ITERS = Number.parseInt(nodeProcess.env.XC_I18N_ITERS ?? '5000', 10);
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rng: () => number, xs: readonly T[]): T =>
  xs[Math.floor(rng() * xs.length)] as T;

// ─── Corpus ──────────────────────────────────────────────────────────────────

/** Single grapheme clusters that contain no ZWJ/ZWNJ (the server strips those). */
const SAFE_CLUSTERS: ReadonlyArray<{ name: string; text: string }> = [
  { name: 'ascii_a', text: 'a' },
  { name: 'latin_e_acute_nfc', text: '\u00e9' },
  { name: 'latin_e_acute_nfd', text: 'e\u0301' },
  { name: 'vietnamese_stacked', text: '\u1ead' },
  {
    name: 'zalgo_a_12_marks',
    text: 'a\u0300\u0301\u0302\u0303\u0304\u0305\u0306\u0307\u0308\u0309\u030a\u030b',
  },
  { name: 'hebrew_shin_with_points', text: '\u05e9\u05c1\u05b8' },
  { name: 'arabic_lam_with_shadda_fatha', text: '\u0644\u0651\u064e' },
  { name: 'devanagari_ksha_conjunct', text: '\u0915\u094d\u0937' },
  { name: 'tamil_ko', text: '\u0b95\u0bcb' },
  { name: 'thai_sara_am', text: '\u0e01\u0e33' },
  { name: 'hangul_nfc', text: '\ud55c' },
  { name: 'hangul_nfd_jamo', text: '\u1112\u1161\u11ab' },
  { name: 'cjk_ideograph', text: '\u4e2d' },
  { name: 'cjk_ext_b_surrogate_pair', text: '\u{20000}' },
  { name: 'emoji_grinning', text: '\u{1f600}' },
  { name: 'emoji_thumbs_up_skin_tone', text: '\u{1f44d}\u{1f3fd}' },
  { name: 'emoji_heart_vs16', text: '\u2764\ufe0f' },
  { name: 'emoji_keycap_1', text: '1\ufe0f\u20e3' },
  { name: 'emoji_flag_jp', text: '\u{1f1ef}\u{1f1f5}' },
  {
    name: 'emoji_flag_england_tag_sequence',
    text: '\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}',
  },
  {
    name: 'emoji_flag_scotland_tag_sequence',
    text: '\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}',
  },
  {
    name: 'emoji_flag_wales_tag_sequence',
    text: '\u{1f3f4}\u{e0067}\u{e0062}\u{e0077}\u{e006c}\u{e0073}\u{e007f}',
  },
];
const FLAG = '\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}';
const FAMILY_ZWJ = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}';

const NAMES: ReadonlyArray<{ name: string; text: string }> = [
  { name: 'ascii', text: 'Alice' },
  { name: 'latin_nfd', text: 'Zoe\u0308 Mu\u0308ller' },
  { name: 'vietnamese', text: 'Nguy\u1ec5n Th\u1ecb H\u1ecda' },
  { name: 'hebrew_rtl', text: '\u05d3\u05d5\u05d3' },
  {
    name: 'arabic_with_harakat',
    text: '\u0645\u064f\u062d\u064e\u0645\u0651\u064e\u062f',
  },
  { name: 'persian_zwnj', text: '\u0639\u0644\u064a\u200c\u0631\u0636\u0627' },
  { name: 'urdu', text: '\u0639\u0627\u0626\u0634\u0647' },
  { name: 'mixed_bidi', text: 'Sam \u05e9\u05dc\u05d5\u05dd' },
  { name: 'devanagari', text: '\u0915\u094d\u0937\u092e\u093e' },
  { name: 'bengali', text: '\u09b8\u09cc\u09b0\u09ad' },
  { name: 'tamil', text: '\u0b95\u0bcb\u0baa\u0bbe\u0bb2' },
  { name: 'thai', text: '\u0e2a\u0e21\u0e0a\u0e32\u0e22' },
  { name: 'korean_nfc', text: '\uae40\ubbfc\uc218' },
  {
    name: 'korean_nfd',
    text: '\u1100\u1175\u11b7\u1106\u1175\u11ab\u1109\u116e',
  },
  { name: 'japanese', text: '\u5c71\u7530\u592a\u90ce' },
  { name: 'chinese', text: '\u674e\u96f7' },
  { name: 'cjk_ext_b', text: '\u{20000}\u{20001}' },
  { name: 'emoji_3', text: '\u{1f3d3}\u{1f525}\u{1f4aa}' },
  { name: 'family_zwj', text: FAMILY_ZWJ },
  { name: 'three_tag_flags', text: FLAG.repeat(3) },
  {
    name: 'zalgo',
    text: 'A\u0300\u0301\u0302\u0303\u0304\u0305l\u0306\u0307i\u0308\u0309c\u030a\u030be',
  },
  { name: 'bidi_override', text: '\u202eecilA' },
  { name: 'zwsp_inside', text: 'Al\u200bice' },
  { name: 'bom_prefix', text: '\ufeffAlice' },
  { name: 'nul_inside', text: 'Al\u0000ice' },
  { name: 'lone_high_surrogate', text: 'Al\ud800ice' },
  { name: 'lone_low_surrogate', text: 'Al\udc00ice' },
  { name: 'word_joiner_only', text: '\u2060' },
  { name: 'hangul_filler_only', text: '\u3164' },
  { name: 'soft_hyphen_only', text: '\u00ad' },
  { name: 'nbsp_only', text: '\u00a0\u00a0' },
  { name: 'bom_only', text: '\ufeff' },
];

// ─── Artifacts ───────────────────────────────────────────────────────────────

const OUT = nodeProcess.env.XC_I18N_OUT;
function writeArtifact(name: string, value: unknown): string | null {
  if (!OUT) return null;
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, name);
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}
const heap = () => {
  const m = nodeProcess.memoryUsage();
  return { heapUsed: m.heapUsed, heapTotal: m.heapTotal, rss: m.rss };
};

// ─── Fixtures ────────────────────────────────────────────────────────────────

const session: ApiSession = {
  apiBaseUrl: 'https://api.example.test/functions/v1/api',
  bearerToken: 'provider-token',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  provider: 'apple',
};
const baseProfile: Profile = {
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'dinks',
  biggestProblem: 'consistency',
  focusCheckpoint: 'paddle_set',
};
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
const serverProfile = (first_name: unknown) => ({
  onboardingState: 'complete',
  profile: {
    first_name,
    skill_level: '3.5',
    handedness: 'right',
    primary_goal: 'dinks',
    biggest_problem: 'consistency',
  },
});

/** Minimal in-memory LocalDb that speaks exactly the SQL repository.ts emits
 * for kv. It mirrors SQLite's TEXT affinity (strings round-trip as-is) so
 * the test isolates the TypeScript layer; the real-engine round trip lives in
 * scripts/xc-i18n/sqlite_unicode_roundtrip.mjs. */
function memoryKvDb(): LocalDb & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async execute(sql, params = []) {
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        store.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      if (sql.startsWith('SELECT value FROM kv')) {
        const v = store.get(String(params[0]));
        return { rows: v === undefined ? [] : [{ value: v }] };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
    close() {},
  };
}

// ─── Onboarding hydrate (server → client) ────────────────────────────────────

describe('xc-i18n onboarding hydrate: first_name across scripts', () => {
  it('hydrates every non-blank Unicode first_name intact (matrix recorded)', async () => {
    const rows: Array<Record<string, unknown>> = [];
    for (const c of NAMES) {
      const fetchFn: OnboardingFetch = async () =>
        jsonResponse(serverProfile(c.text));
      const profile = await fetchCanonicalOnboardingProfile(session, fetchFn);
      rows.push({
        name: c.name,
        inputJson: JSON.stringify(c.text),
        inputCodePoints: codePointsOf(c.text),
        in: measure(c.text),
        hydratedFirstName:
          profile?.firstName === undefined
            ? null
            : JSON.stringify(profile.firstName),
        hydratedEqualsTrim: profile?.firstName === c.text.trim(),
        droppedAsBlank: profile !== null && profile.firstName === undefined,
      });
    }
    writeArtifact('mobile_onboarding_hydrate_matrix.json', rows);
    for (const r of rows) {
      const name = r.name as string;
      // `String.prototype.trim` strips U+FEFF and U+00A0, so those become
      // blank and are dropped; every other name hydrates as trim(input).
      if (name === 'nbsp_only' || name === 'bom_only') {
        expect(r.droppedAsBlank).toBe(true);
      } else {
        expect(r.hydratedEqualsTrim).toBe(true);
      }
    }
  });

  it('REPRO: invisible-only first names (U+2060 / U+3164 / U+00AD) hydrate as non-empty display names', async () => {
    for (const text of ['\u2060', '\u3164', '\u00ad']) {
      const fetchFn: OnboardingFetch = async () =>
        jsonResponse(serverProfile(text));
      const profile = await fetchCanonicalOnboardingProfile(session, fetchFn);
      expect(profile?.firstName).toBe(text);
      expect(measure(text).graphemes).toBe(1);
    }
  });
});

// ─── Onboarding save (client → server) ───────────────────────────────────────

describe('xc-i18n onboarding save: firstName on the wire', () => {
  it('sends firstName byte-for-byte (after trim) for every script; JSON body bytes recorded', async () => {
    const rows: Array<Record<string, unknown>> = [];
    for (const c of NAMES) {
      let sentBody: string | null = null;
      const fetchFn: OnboardingFetch = async (_input, init) => {
        sentBody = typeof init?.body === 'string' ? init.body : null;
        return jsonResponse({ recommendedCheckpoint: 'paddle_set' });
      };
      const saved = await saveCanonicalOnboardingProfile(
        session,
        { ...baseProfile, firstName: c.text },
        fetchFn,
      );
      const parsed =
        sentBody === null
          ? null
          : (JSON.parse(sentBody) as { firstName?: string });
      rows.push({
        name: c.name,
        inputJson: JSON.stringify(c.text),
        in: measure(c.text),
        bodyBytes:
          sentBody === null ? null : encoder.encode(sentBody).byteLength,
        wireFirstName:
          parsed?.firstName === undefined
            ? null
            : JSON.stringify(parsed.firstName),
        wireEqualsTrim: parsed?.firstName === c.text.trim(),
        omittedAsBlank: parsed !== null && parsed.firstName === undefined,
        returnedFirstName:
          saved.firstName === undefined
            ? null
            : JSON.stringify(saved.firstName),
      });
    }
    writeArtifact('mobile_onboarding_save_matrix.json', rows);
    for (const r of rows) {
      const name = r.name as string;
      if (name === 'nbsp_only' || name === 'bom_only') {
        expect(r.omittedAsBlank).toBe(true);
      } else {
        expect(r.wireEqualsTrim).toBe(true);
      }
    }
  });

  it('REPRO: when the server rejects a valid 3-grapheme name (three tag flags, 42 UTF-16 units) the client silently retries WITHOUT firstName and keeps the name locally only', async () => {
    const name = FLAG.repeat(3);
    expect(measure(name)).toEqual({ u16: 42, cp: 21, graphemes: 3, bytes: 84 });
    const bodies: Array<Record<string, unknown>> = [];
    // Mirrors the real edge response for this input (pinned in
    // supabase/functions/api/__wf__/xc_i18n_routes_test.ts).
    const fetchFn: OnboardingFetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (typeof body.firstName === 'string') {
        return jsonResponse(
          {
            error: {
              code: 'validation.invalid',
              message: 'firstName must be 1-40 characters.',
            },
          },
          400,
        );
      }
      return jsonResponse({ recommendedCheckpoint: 'paddle_set' });
    };
    const saved = await saveCanonicalOnboardingProfile(
      session,
      { ...baseProfile, firstName: name },
      fetchFn,
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.firstName).toBe(name);
    expect(bodies[1]).not.toHaveProperty('firstName');
    // No error surfaces; the local profile keeps the name the server never stored.
    expect(saved.firstName).toBe(name);
    writeArtifact('mobile_onboarding_three_flag_fallback.json', {
      inputJson: JSON.stringify(name),
      inputCodePoints: codePointsOf(name),
      in: measure(name),
      requests: bodies,
      returnedProfileFirstName: saved.firstName,
    });
  });

  it('property: a random 3-grapheme name is always sent intact; how many exceed the 40-unit server check is recorded per pool', async () => {
    const rng = makeRng(SEED ^ 0x3001);
    const wide = SAFE_CLUSTERS.filter(c => c.text.length >= 12);
    const pools = [
      { pool: 'all_safe_clusters', clusters: SAFE_CLUSTERS, iterations: ITERS },
      {
        pool: 'wide_safe_clusters',
        clusters: wide,
        iterations: Math.max(50, Math.floor(ITERS / 4)),
      },
    ];
    const perPool: Record<
      string,
      {
        iterations: number;
        over40u16: number;
        over40cp: number;
        over40graphemes: number;
      }
    > = {};
    const samplesOver40: Array<Record<string, unknown>> = [];
    let sentIntact = 0;
    const started = Date.now();
    for (const { pool, clusters, iterations } of pools) {
      const stats = {
        iterations,
        over40u16: 0,
        over40cp: 0,
        over40graphemes: 0,
      };
      perPool[pool] = stats;
      for (let i = 0; i < iterations; i += 1) {
        const picked = [
          pick(rng, clusters),
          pick(rng, clusters),
          pick(rng, clusters),
        ];
        const text = picked.map(c => c.text).join('');
        const m = measure(text);
        expect(m.graphemes).toBe(3);
        let wire: string | undefined;
        const fetchFn: OnboardingFetch = async (_input, init) => {
          wire = (JSON.parse(String(init?.body)) as { firstName?: string })
            .firstName;
          return jsonResponse({ recommendedCheckpoint: 'paddle_set' });
        };
        await saveCanonicalOnboardingProfile(
          session,
          { ...baseProfile, firstName: text },
          fetchFn,
        );
        if (wire === text) sentIntact += 1;
        if (m.u16 > 40) {
          stats.over40u16 += 1;
          if (samplesOver40.length < 100) {
            samplesOver40.push({
              seed: SEED,
              pool,
              iteration: i,
              clusters: picked.map(c => c.name),
              inputJson: JSON.stringify(text),
              inputCodePoints: codePointsOf(text),
              in: m,
            });
          }
        }
        if (m.cp > 40) stats.over40cp += 1;
        if (m.graphemes > 40) stats.over40graphemes += 1;
      }
    }
    const total = pools.reduce((n, p) => n + p.iterations, 0);
    writeArtifact('mobile_three_grapheme_property.json', {
      seed: SEED,
      total,
      sentIntact,
      perPool,
      ms: Date.now() - started,
      heap: heap(),
      samplesOver40,
    });
    expect(sentIntact).toBe(total);
    // 3 graphemes never exceed 40 in graphemes or code points; only the
    // UTF-16 check can reject them — the wide pool demonstrates that.
    for (const s of Object.values(perPool)) {
      expect(s.over40graphemes).toBe(0);
      expect(s.over40cp).toBe(0);
    }
    expect(perPool.wide_safe_clusters?.over40u16).toBeGreaterThan(0);
  });
});

// ─── Deletion survey free text ───────────────────────────────────────────────

describe('xc-i18n deletion survey details', () => {
  const survey = (details: string | null): AccountDeletionSurvey => ({
    reason: 'other',
    wanted: null,
    details,
    platform: 'ios',
    appVersion: '1.0.0',
  });

  it('carries Unicode details verbatim under body.survey.details (matrix recorded)', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const texts = [
      ...NAMES.filter(
        c =>
          ![
            'nbsp_only',
            'bom_only',
            'word_joiner_only',
            'hangul_filler_only',
            'soft_hyphen_only',
          ].includes(c.name),
      ),
      {
        name: 'arabic_paragraph_rtl',
        text: 'أحتاج إلى تحسين ضربة الدينك الخاصة بي عند الشبكة',
      },
      {
        name: 'japanese_paragraph',
        text: 'ディンクが浮いてしまいます。手首を使いすぎているかもしれません。',
      },
      { name: 'multiline', text: 'Line one\nLine two\n\nLine four' },
    ];
    for (const c of texts) {
      let sent: unknown = null;
      const fetchFn = async (_input: string, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body));
        return jsonResponse({
          challenge: '33333333-3333-4333-8333-333333333333',
          expiresAt: '2026-09-04T00:00:00.000Z',
        });
      };
      await requestAccountDeletion(session, survey(c.text), fetchFn);
      const wire = (sent as { survey: { details: string } }).survey.details;
      rows.push({
        name: c.name,
        inputJson: JSON.stringify(c.text),
        in: measure(c.text),
        wireEqualsInput: wire === c.text,
      });
      expect(wire).toBe(c.text);
    }
    writeArtifact('mobile_deletion_details_matrix.json', rows);
  });

  it('cap parity: client ACCOUNT_DELETION_DETAILS_MAX (500, applied by TextInput maxLength in UTF-16 units) vs server 500 code points — a 500-unit emoji comment is 250 code points, a 500-code-point CJK comment is 500 units (table recorded)', () => {
    expect(ACCOUNT_DELETION_DETAILS_MAX).toBe(500);
    const cases = [
      { name: 'ascii_500', text: 'a'.repeat(500) },
      { name: 'cjk_500', text: '\u4e2d'.repeat(500) },
      { name: 'astral_emoji_250_pairs', text: '\u{1f3d3}'.repeat(250) },
      { name: 'tag_flag_35', text: FLAG.repeat(35) },
      { name: 'nfd_e_acute_250', text: 'e\u0301'.repeat(250) },
      { name: 'kb64_ascii', text: 'x'.repeat(65_536) },
    ];
    const table = cases.map(c => {
      const m = measure(c.text);
      return {
        ...c,
        text: undefined,
        ...m,
        fitsClientMaxLengthU16: m.u16 <= ACCOUNT_DELETION_DETAILS_MAX,
        fitsServerCapCodePoints: m.cp <= 500,
        // 20260902000000_account_deletion_feedback.sql: char_length(details) <= 500
        fitsDbCharLength: m.cp <= 500,
      };
    });
    writeArtifact('mobile_deletion_cap_parity.json', table);
    for (const row of table) {
      // Client check (UTF-16) is never looser than the server check (code points).
      if (row.fitsClientMaxLengthU16)
        expect(row.fitsServerCapCodePoints).toBe(true);
    }
    expect(
      table.find(r => r.name === 'kb64_ascii')?.fitsClientMaxLengthU16,
    ).toBe(false);
    expect(
      table.find(r => r.name === 'kb64_ascii')?.fitsServerCapCodePoints,
    ).toBe(false);
  });
});

// ─── Local kv persistence (profile JSON through repository SQL) ──────────────

describe('xc-i18n local profile kv round trip', () => {
  it('profile JSON with every corpus name round-trips through setKv/getKv (TypeScript layer)', async () => {
    const db = memoryKvDb();
    const rows: Array<Record<string, unknown>> = [];
    for (const c of NAMES) {
      const profile: Profile = { ...baseProfile, firstName: c.text };
      const key = `profile:owner-${c.name}`;
      await setKv(db, key, JSON.stringify(profile));
      const raw = await getKv(db, key);
      const back = raw === null ? null : (JSON.parse(raw) as Profile);
      rows.push({
        name: c.name,
        inputJson: JSON.stringify(c.text),
        in: measure(c.text),
        storedJsonBytes: raw === null ? null : encoder.encode(raw).byteLength,
        roundTripped: back?.firstName === c.text,
      });
      expect(back?.firstName).toBe(c.text);
    }
    writeArtifact('mobile_kv_profile_roundtrip.json', rows);
  });

  it('a 64 KiB name survives JSON kv round trip on the TypeScript layer (no client-side cap exists here; recorded)', async () => {
    const db = memoryKvDb();
    const big = '\u{1f3d3}'.repeat(16_384); // 65,536 UTF-8 bytes, 16,384 code points
    expect(measure(big).bytes).toBe(65_536);
    await setKv(
      db,
      'profile:big',
      JSON.stringify({ ...baseProfile, firstName: big }),
    );
    const raw = await getKv(db, 'profile:big');
    expect((JSON.parse(String(raw)) as Profile).firstName).toBe(big);
    writeArtifact('mobile_kv_kb64.json', {
      in: measure(big),
      storedBytes: encoder.encode(String(raw)).byteLength,
      heap: heap(),
    });
  });

  it('property: random mixed-script strings (with controls, RTL marks, ZWJ, lone surrogates) round-trip through kv JSON unchanged', async () => {
    const rng = makeRng(SEED ^ 0x3002);
    const db = memoryKvDb();
    const alphabet = [
      ...SAFE_CLUSTERS.map(c => c.text),
      FAMILY_ZWJ,
      '\u200c',
      '\u200d',
      '\u200e',
      '\u200f',
      '\u202e',
      '\u2066',
      '\u2069',
      '\u0000',
      '\u0007',
      '\u001f',
      '\u007f',
      '\u0085',
      '\ufeff',
      '\u2060',
      '\u3164',
      '\ud800',
      '\udc00',
      ' ',
      '\n',
      '\t',
      '\u00a0',
    ];
    let ok = 0;
    const failures: Array<Record<string, unknown>> = [];
    for (let i = 0; i < ITERS; i += 1) {
      const len = 1 + Math.floor(rng() * 24);
      let s = '';
      for (let k = 0; k < len; k += 1) s += pick(rng, alphabet);
      await setKv(
        db,
        'profile:p',
        JSON.stringify({ ...baseProfile, firstName: s }),
      );
      const back = (JSON.parse(String(await getKv(db, 'profile:p'))) as Profile)
        .firstName;
      if (back === s) ok += 1;
      else if (failures.length < 50) {
        failures.push({
          seed: SEED,
          iteration: i,
          inputJson: JSON.stringify(s),
          inputCodePoints: codePointsOf(s),
          backJson: JSON.stringify(back),
        });
      }
    }
    writeArtifact('mobile_kv_property.json', {
      seed: SEED,
      iterations: ITERS,
      ok,
      failures,
      heap: heap(),
    });
    expect(ok).toBe(ITERS);
  });
});
