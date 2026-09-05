import { CHECKPOINTS } from '@pickle/shared-types';
import type { Profile } from '../../src/state/profile';
import { makePrng, pick } from '../../xc-harness/lifecycle-persistence/seeds';

/**
 * Seeded boundary / malformed-input generators for the `mod-app-store`
 * stress campaign (state/appStore + state/profile).
 *
 * Everything is a pure function of a 32-bit seed: the campaign derives one
 * PRNG per iteration (`makePrng(seed)`), so any row of the emitted JSON table
 * can be replayed with `STRESS_SEED=<seed>`. Payloads embed an ASCII marker
 * (`markerFor(seed)`) so the harness can prove that raw persisted bytes never
 * leak into user-facing error copy.
 */

export type Rng = () => number;

export { makePrng, pick };

export function markerFor(seed: number): string {
  return `MK${seed.toString(36)}Z`;
}

export const CANONICAL_A = '7fc2c743-028f-4ec6-942c-a84508f3be38';
export const CANONICAL_B = '0b4d1f9e-3c2a-4b8e-9f1d-2a6c7e8b9d01';

export const VALID_GOALS = [
  'dinks',
  'drives',
  'drops',
  'serve',
  'return',
  'volleys',
  'footwork',
  'all-around',
] as const;

export const VALID_GENDERS = [
  'female',
  'male',
  'nonbinary',
  'prefer_not_to_say',
] as const;

export function validProfile(rng: Rng, marker: string): Profile {
  const goal = pick(rng, VALID_GOALS);
  const profile: Profile = {
    skillLevel: pick(rng, ['2.5', '3.0', '3.5', '4.0', '4.5+']),
    handedness: pick(rng, ['right', 'left'] as const),
    goal,
    biggestProblem: pick(rng, ['control', 'consistency', 'power', 'not sure']),
    focusCheckpoint: pick(rng, CHECKPOINTS),
  };
  if (rng() < 0.6) profile.firstName = `Dana${marker}`;
  if (rng() < 0.5) profile.gender = pick(rng, VALID_GENDERS);
  return profile;
}

// ── string boundaries ──────────────────────────────────────────────────────

export const STRING_KINDS = [
  'empty',
  'whitespace',
  'nul-bytes',
  'zero-width-only',
  'bidi-override',
  'bom-prefixed',
  'nfc',
  'nfd',
  'lone-high-surrogate',
  'lone-low-surrogate',
  'zwj-graphemes',
  'combining-storm',
  'path-traversal-posix',
  'path-traversal-encoded',
  'path-traversal-windows',
  'sql-like',
  'html-like',
  'json-in-string',
  'numeric-1e999',
  'numeric-neg-zero',
  'numeric-nan',
  'fullwidth-digits',
  'proto-name',
  'ascii-64k',
  'ascii-64k-plus-1',
  'cjk-64k-codepoints',
  'emoji-64k-code-units',
  'ascii-256k',
  'ascii-1mb',
  'control-chars',
  'plain',
] as const;

export type StringKind = (typeof STRING_KINDS)[number];

const KB64 = 64 * 1024;

export function stringOfKind(kind: StringKind, marker: string): string {
  switch (kind) {
    case 'empty':
      return '';
    case 'whitespace':
      return ' \t\n\r ';
    case 'nul-bytes':
      return `a\u0000b${marker}\u0000`;
    case 'zero-width-only':
      return '\u200b\u200c\u200d\ufeff';
    case 'bidi-override':
      return `\u202e${marker}\u202c`;
    case 'bom-prefixed':
      return `\ufeff${marker}`;
    case 'nfc':
      return `\u00e9${marker}`;
    case 'nfd':
      return `e\u0301${marker}`;
    case 'lone-high-surrogate':
      return `\ud800${marker}`;
    case 'lone-low-surrogate':
      return `${marker}\udc00`;
    case 'zwj-graphemes':
      return '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}\u200d\u{1F466}'.repeat(8);
    case 'combining-storm':
      return `Z${'\u0301\u0302\u0303\u0304'.repeat(64)}${marker}`;
    case 'path-traversal-posix':
      return `../../../etc/passwd/${marker}`;
    case 'path-traversal-encoded':
      return `..%2F..%2F..%2Fetc%2Fpasswd%00${marker}`;
    case 'path-traversal-windows':
      return `..\\..\\windows\\system32\\${marker}`;
    case 'sql-like':
      return `'; DROP TABLE kv; -- ${marker}`;
    case 'html-like':
      return `<script>alert('${marker}')</script>`;
    case 'json-in-string':
      return `{"profile":{"skillLevel":"${marker}"}}`;
    case 'numeric-1e999':
      return '1e999';
    case 'numeric-neg-zero':
      return '-0';
    case 'numeric-nan':
      return 'NaN';
    case 'fullwidth-digits':
      return `\uff17\uff46\uff43\uff12${marker}`;
    case 'proto-name':
      return '__proto__';
    case 'ascii-64k':
      return 'x'.repeat(KB64);
    case 'ascii-64k-plus-1':
      return 'x'.repeat(KB64 + 1);
    case 'cjk-64k-codepoints':
      // 64Ki code points, 192 KiB of UTF-8.
      return '\u4e2d'.repeat(KB64);
    case 'emoji-64k-code-units':
      // 32Ki code points but 64Ki UTF-16 code units.
      return '\u{1F3D3}'.repeat(KB64 / 2);
    case 'ascii-256k':
      return 'y'.repeat(256 * 1024);
    case 'ascii-1mb':
      return 'z'.repeat(1024 * 1024);
    case 'control-chars':
      return `\u0001\u0002\u001f\u007f\u0085${marker}`;
    case 'plain':
      return `plain ${marker}`;
  }
}

/** Weighted so that the multi-hundred-KB strings stay rare (heap + time). */
export function pickStringKind(rng: Rng): StringKind {
  const roll = rng();
  if (roll < 0.02) return 'ascii-1mb';
  if (roll < 0.05) return 'ascii-256k';
  const light = STRING_KINDS.filter(
    kind => kind !== 'ascii-1mb' && kind !== 'ascii-256k',
  );
  return pick(rng, light);
}

// ── JSON text builders (raw text so 1e999 / -0 / NaN survive) ─────────────

export const SCALAR_TEXTS = [
  '1e999',
  '-1e999',
  '-0',
  '0',
  '1e-999',
  '9007199254740993',
  '1.7976931348623157e309',
  'NaN',
  'Infinity',
  '-Infinity',
  'null',
  'true',
  'false',
  '""',
  '[]',
  '{}',
  '[[]]',
  '{"":{}}',
  '"\\u0000"',
  '"\\ud800"',
  '"\\udc00"',
  '"\\ufeff"',
  'undefined',
  '0x10',
  '01',
  '.5',
  '+1',
] as const;

export function jsonString(value: string): string {
  return JSON.stringify(value);
}

export interface FieldPlan {
  key: string;
  /** Raw JSON text for the value. */
  text: string;
  kind: string;
}

const PROFILE_KEYS = [
  'firstName',
  'gender',
  'skillLevel',
  'handedness',
  'goal',
  'biggestProblem',
  'focusCheckpoint',
] as const;

export const POLLUTION_KEYS = [
  '__proto__',
  'constructor',
  'prototype',
  '__defineGetter__',
  'hasOwnProperty',
  'toString',
  'valueOf',
] as const;

/**
 * A profile-shaped JSON object where every field independently draws a
 * valid value, a boundary string, a boundary scalar, a wrong container, or
 * is omitted / duplicated. Prototype-pollution keys are mixed in. A third
 * of the objects are "near-valid" (each field valid with p=0.9) so the
 * single-bad-field cases the store's own parser lets through are dense.
 */
export function profileObjectText(
  rng: Rng,
  marker: string,
): { text: string; fields: FieldPlan[] } {
  const base = validProfile(rng, marker);
  const fields: FieldPlan[] = [];
  const validShare = rng() < 0.33 ? 0.9 : 0.35;
  for (const key of PROFILE_KEYS) {
    const roll = rng();
    const baseValue = (base as unknown as Record<string, unknown>)[key];
    if (roll < validShare) {
      if (baseValue === undefined) continue;
      fields.push({ key, text: jsonString(String(baseValue)), kind: 'valid' });
      continue;
    }
    // Remaining mass split as 0.20 / 0.20 / 0.10 / 0.07 / 0.08 of 0.65.
    const bad = (roll - validShare) / (1 - validShare);
    if (bad < 0.31) {
      const kind = pickStringKind(rng);
      fields.push({
        key,
        text: jsonString(stringOfKind(kind, marker)),
        kind: `string:${kind}`,
      });
    } else if (bad < 0.62) {
      const text = pick(rng, SCALAR_TEXTS);
      fields.push({ key, text, kind: `scalar:${text}` });
    } else if (bad < 0.77) {
      fields.push({ key, text: '[]', kind: 'array-empty' });
    } else if (bad < 0.88) {
      fields.push({
        key,
        text: `{"${key}":${jsonString(String(baseValue ?? marker))}}`,
        kind: 'nested-object',
      });
    } else {
      fields.push({ key, text: '"omitted"', kind: 'omitted' });
    }
  }
  const pollution = rng();
  if (pollution < 0.3) {
    const key = pick(rng, POLLUTION_KEYS);
    const payload =
      key === '__proto__'
        ? `{"polluted":${jsonString(marker)}}`
        : key === 'constructor'
          ? `{"prototype":{"polluted":${jsonString(marker)}}}`
          : `{"polluted":${jsonString(marker)}}`;
    fields.push({ key, text: payload, kind: 'pollution' });
  }
  if (rng() < 0.2) {
    fields.push({
      key: `extra_${marker}`,
      text: pick(rng, SCALAR_TEXTS),
      kind: 'extra-key',
    });
  }
  if (rng() < 0.15) {
    // Duplicate key: JSON.parse keeps the LAST occurrence.
    fields.push({
      key: 'skillLevel',
      text: pick(rng, SCALAR_TEXTS),
      kind: 'duplicate-key',
    });
  }
  const entries = fields
    .filter(field => field.kind !== 'omitted')
    .map(field => `${jsonString(field.key)}:${field.text}`);
  return { text: `{${entries.join(',')}}`, fields };
}

export const VERSION_TEXTS = [
  '1',
  '2',
  '999',
  '-1',
  '0',
  '1e999',
  '"1"',
  '"2.0.0"',
  'null',
  '[]',
  '{}',
  'true',
] as const;

/** `{version, profile}` stash envelope with a future / wrong-typed version. */
export function pendingEnvelopeText(
  rng: Rng,
  marker: string,
): { text: string; version: string; fields: FieldPlan[] } {
  const version = pick(rng, VERSION_TEXTS);
  const profile = profileObjectText(rng, marker);
  const wrapProfile = rng();
  const profileText =
    wrapProfile < 0.1
      ? `[${profile.text}]`
      : wrapProfile < 0.15
        ? `{"profile":${profile.text}}`
        : profile.text;
  const orderFlip = rng() < 0.5;
  const parts = [`"version":${version}`, `"profile":${profileText}`];
  if (orderFlip) parts.reverse();
  return {
    text: `{${parts.join(',')}}`,
    version,
    fields: profile.fields,
  };
}

// ── raw byte-level corruption of any persisted JSON text ──────────────────

export const CORRUPTIONS = [
  'truncate',
  'truncate-mid-string',
  'insert-nul',
  'insert-quote',
  'insert-brace',
  'insert-bom',
  'insert-bidi',
  'delete-char',
  'swap-chars',
  'prepend-garbage',
  'append-garbage',
  'wrap-array',
  'double-encode',
  'whitespace-only',
  'deep-nesting',
  'scalar-only',
  'leading-zeros',
  'comment',
  'single-quotes',
  'trailing-comma',
  'huge-1mb',
  'html-page',
  'intact',
] as const;

export type Corruption = (typeof CORRUPTIONS)[number];

export function corrupt(
  rng: Rng,
  text: string,
  marker: string,
  corruption: Corruption = pick(rng, CORRUPTIONS),
): { raw: string; corruption: Corruption } {
  const at = Math.floor(rng() * Math.max(1, text.length));
  const splice = (insert: string) =>
    text.slice(0, at) + insert + text.slice(at);
  switch (corruption) {
    case 'truncate':
      return { raw: text.slice(0, at), corruption };
    case 'truncate-mid-string': {
      const quote = text.indexOf('"', 1);
      return {
        raw:
          quote > 0 ? text.slice(0, quote + 1 + (at % 5)) : text.slice(0, at),
        corruption,
      };
    }
    case 'insert-nul':
      return { raw: splice('\u0000'), corruption };
    case 'insert-quote':
      return { raw: splice('"'), corruption };
    case 'insert-brace':
      return { raw: splice(pick(rng, ['{', '}', '[', ']'])), corruption };
    case 'insert-bom':
      return { raw: `\ufeff${text}`, corruption };
    case 'insert-bidi':
      return { raw: splice('\u202e'), corruption };
    case 'delete-char':
      return { raw: text.slice(0, at) + text.slice(at + 1), corruption };
    case 'swap-chars':
      return {
        raw:
          text.length > at + 1
            ? text.slice(0, at) + text[at + 1] + text[at] + text.slice(at + 2)
            : text,
        corruption,
      };
    case 'prepend-garbage':
      return { raw: `${marker}${text}`, corruption };
    case 'append-garbage':
      return { raw: `${text}${marker}`, corruption };
    case 'wrap-array':
      return { raw: `[${text}]`, corruption };
    case 'double-encode':
      return { raw: JSON.stringify(text), corruption };
    case 'whitespace-only':
      return { raw: ' \n\t\r ', corruption };
    case 'deep-nesting': {
      const depth = 1000 + Math.floor(rng() * 9000);
      return {
        raw: '['.repeat(depth) + text + ']'.repeat(depth),
        corruption,
      };
    }
    case 'scalar-only':
      return { raw: pick(rng, SCALAR_TEXTS), corruption };
    case 'leading-zeros':
      return { raw: text.replace(/"version":1/, '"version":01'), corruption };
    case 'comment':
      return { raw: `/* ${marker} */ ${text}`, corruption };
    case 'single-quotes':
      return { raw: text.replace(/"/g, "'"), corruption };
    case 'trailing-comma':
      return { raw: text.replace(/}$/, ',}'), corruption };
    case 'huge-1mb':
      return { raw: text + ' '.repeat(1024 * 1024), corruption };
    case 'html-page':
      return {
        raw: `<!doctype html><html><body>Sign in to Wi-Fi ${marker}</body></html>`,
        corruption,
      };
    case 'intact':
      return { raw: text, corruption };
  }
}

// ── canonical ids / owners ─────────────────────────────────────────────────

export const ID_KINDS = [
  'valid',
  'uppercase',
  'padded',
  'nil-uuid',
  'braces',
  'urn-prefix',
  'no-dashes',
  'fullwidth',
  'traversal',
  'empty',
  'whitespace',
  'nul',
  'version-9',
  'variant-c',
  'huge',
  'other-account',
] as const;

export type IdKind = (typeof ID_KINDS)[number];

export function idOfKind(kind: IdKind, marker: string): string {
  switch (kind) {
    case 'valid':
      return CANONICAL_A;
    case 'uppercase':
      return CANONICAL_A.toUpperCase();
    case 'padded':
      return `  ${CANONICAL_A}\n`;
    case 'nil-uuid':
      return '00000000-0000-0000-0000-000000000000';
    case 'braces':
      return `{${CANONICAL_A}}`;
    case 'urn-prefix':
      return `urn:uuid:${CANONICAL_A}`;
    case 'no-dashes':
      return CANONICAL_A.replace(/-/g, '');
    case 'fullwidth':
      return `\uff17fc2c743-028f-4ec6-942c-a84508f3be38`;
    case 'traversal':
      return `../../${marker}`;
    case 'empty':
      return '';
    case 'whitespace':
      return '   ';
    case 'nul':
      return `${CANONICAL_A}\u0000`;
    case 'version-9':
      return '7fc2c743-028f-9ec6-942c-a84508f3be38';
    case 'variant-c':
      return '7fc2c743-028f-4ec6-c42c-a84508f3be38';
    case 'huge':
      return 'a'.repeat(KB64);
    case 'other-account':
      return CANONICAL_B;
  }
}

// ── fake server responses ─────────────────────────────────────────────────

export const RESPONSE_KINDS = [
  'ok-valid',
  'ok-pending-state',
  'ok-empty-object',
  'ok-array',
  'ok-null',
  'ok-html',
  'ok-truncated-json',
  'ok-wrong-types',
  'ok-huge-name',
  'ok-pollution',
  'ok-unknown-checkpoint',
  'ok-future-schema',
  'ok-empty-body',
  '400-typed',
  '400-untyped',
  '400-huge-message',
  '401',
  '403',
  '404',
  '413',
  '429',
  '500-plain',
  '500-with-detail',
  '502-html',
  '503',
  'network-error',
  'abort',
] as const;

export type ResponseKind = (typeof RESPONSE_KINDS)[number];

export interface FakeResponsePlan {
  kind: ResponseKind;
  status: number;
  body: string;
  /** Throw from fetch instead of returning a response. */
  throws?: string;
}

export function responseOfKind(
  kind: ResponseKind,
  marker: string,
  route: 'get-me' | 'put-onboarding',
): FakeResponsePlan {
  const profileRow = {
    skill_level: '3.5',
    handedness: 'right',
    primary_goal: 'drops',
    biggest_problem: 'control',
    focus_checkpoint: 'paddle_set',
    first_name: `Server${marker}`,
    gender: 'female',
  };
  const okValid =
    route === 'get-me'
      ? {
          user: { id: CANONICAL_A, email: 'x@example.test' },
          onboardingState: 'complete',
          profile: profileRow,
        }
      : {
          plan: { focusCheckpoint: 'paddle_set' },
          recommendedCheckpoint: 'paddle_set',
          profile: profileRow,
        };
  const err = (status: number, message: string | null) => ({
    kind,
    status,
    body:
      message === null
        ? '{"error":{}}'
        : JSON.stringify({ error: { message, code: 'stress' } }),
  });
  switch (kind) {
    case 'ok-valid':
      return { kind, status: 200, body: JSON.stringify(okValid) };
    case 'ok-pending-state':
      return {
        kind,
        status: 200,
        body: JSON.stringify({
          ...okValid,
          onboardingState: 'pending',
          recommendedCheckpoint: undefined,
        }),
      };
    case 'ok-empty-object':
      return { kind, status: 200, body: '{}' };
    case 'ok-array':
      return { kind, status: 200, body: '[]' };
    case 'ok-null':
      return { kind, status: 200, body: 'null' };
    case 'ok-html':
      return {
        kind,
        status: 200,
        body: `<!doctype html><html><body>Wi-Fi login ${marker}</body></html>`,
      };
    case 'ok-truncated-json':
      return { kind, status: 200, body: JSON.stringify(okValid).slice(0, 40) };
    case 'ok-wrong-types':
      return {
        kind,
        status: 200,
        body: JSON.stringify({
          ...okValid,
          recommendedCheckpoint: 42,
          profile: { ...profileRow, skill_level: 3.5, handedness: ['right'] },
        }),
      };
    case 'ok-huge-name':
      return {
        kind,
        status: 200,
        body: JSON.stringify({
          ...okValid,
          profile: { ...profileRow, first_name: 'N'.repeat(KB64) },
        }),
      };
    case 'ok-pollution':
      return {
        kind,
        status: 200,
        body: `{"__proto__":{"polluted":"${marker}"},"onboardingState":"complete","recommendedCheckpoint":"paddle_set","profile":${JSON.stringify(
          profileRow,
        )}}`,
      };
    case 'ok-unknown-checkpoint':
      return {
        kind,
        status: 200,
        body: JSON.stringify({
          ...okValid,
          recommendedCheckpoint: `../../${marker}`,
          profile: { ...profileRow, focus_checkpoint: `../../${marker}` },
        }),
      };
    case 'ok-future-schema':
      return {
        kind,
        status: 200,
        body: JSON.stringify({
          schemaVersion: 99,
          onboardingState: 'complete',
          recommendedCheckpoint: 'paddle_set',
          profile: { v2: profileRow },
        }),
      };
    case 'ok-empty-body':
      return { kind, status: 200, body: '' };
    case '400-typed':
      return err(400, 'Invalid onboarding payload.');
    case '400-untyped':
      return err(400, null);
    case '400-huge-message':
      return err(400, 'E'.repeat(KB64));
    case '401':
      return err(401, 'Unauthorized.');
    case '403':
      return err(403, 'Forbidden.');
    case '404':
      return { kind, status: 404, body: 'Not found' };
    case '413':
      return err(413, 'Payload too large.');
    case '429':
      return err(429, 'Too many requests.');
    case '500-plain':
      return err(500, 'Internal error.');
    case '500-with-detail':
      return {
        kind,
        status: 500,
        body: JSON.stringify({
          error: {
            message: `relation "profiles" does not exist at pg://${marker}`,
            stack: `Error: boom ${marker}\n  at handler (index.ts:3557)`,
          },
        }),
      };
    case '502-html':
      return { kind, status: 502, body: '<html>502 Bad Gateway</html>' };
    case '503':
      return err(503, 'Your coaching profile is temporarily unavailable.');
    case 'network-error':
      return {
        kind,
        status: 0,
        body: '',
        throws: `TypeError: Network request failed ${marker}`,
      };
    case 'abort':
      return { kind, status: 0, body: '', throws: 'AbortError' };
  }
}

/** Whether the server would have accepted `kind` as "profile exists". */
export function getMeYieldsProfile(kind: ResponseKind): boolean {
  return (
    kind === 'ok-valid' ||
    kind === 'ok-huge-name' ||
    kind === 'ok-pollution' ||
    // focus_checkpoint is derived client-side from primary_goal, so an
    // unknown server slug still yields a usable profile.
    kind === 'ok-unknown-checkpoint'
  );
}

/**
 * Whether a PUT /v1/me/onboarding answer of `kind` carries a usable
 * `recommendedCheckpoint` — the only thing the client needs from it.
 */
export function putYieldsRecommendation(kind: ResponseKind): boolean {
  const plan = responseOfKind(kind, 'MK0Z', 'put-onboarding');
  if (plan.throws || plan.status !== 200) return false;
  const payload = parseJsonOrNull(plan.body);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  const slug = (payload as Record<string, unknown>)['recommendedCheckpoint'];
  return typeof slug === 'string' && CHECKPOINT_SET.has(slug);
}

/** Whether the server told the client, in-band, that there is no profile. */
export function getMeSaysNoProfile(kind: ResponseKind): boolean {
  return kind === 'ok-pending-state';
}

// ── in-memory (non-JSON) malformed Profile objects for the store API ──────

export const OBJECT_KINDS = [
  'valid',
  'cyclic',
  'bigint-field',
  'throwing-getter',
  'throwing-toJSON',
  'symbol-keys',
  'frozen',
  'null-prototype',
  'proto-polluting-own-key',
  'array-as-profile',
  'string-as-profile',
  'huge-name',
  'nan-skill',
  'undefined-required',
  'function-field',
  'date-field',
  'map-field',
] as const;

export type ObjectKind = (typeof OBJECT_KINDS)[number];

export function objectOfKind(
  rng: Rng,
  kind: ObjectKind,
  marker: string,
): Profile {
  const base = validProfile(rng, marker) as unknown as Record<string, unknown>;
  switch (kind) {
    case 'valid':
      return base as unknown as Profile;
    case 'cyclic': {
      base['self'] = base;
      return base as unknown as Profile;
    }
    case 'bigint-field':
      base['skillLevel'] = BigInt(35);
      return base as unknown as Profile;
    case 'throwing-getter':
      Object.defineProperty(base, 'goal', {
        enumerable: true,
        get() {
          throw new Error('goal getter exploded');
        },
      });
      return base as unknown as Profile;
    case 'throwing-toJSON':
      base['toJSON'] = () => {
        throw new Error('toJSON exploded');
      };
      return base as unknown as Profile;
    case 'symbol-keys':
      (base as Record<symbol, unknown>)[Symbol('stress')] = marker;
      return base as unknown as Profile;
    case 'frozen':
      return Object.freeze(base) as unknown as Profile;
    case 'null-prototype': {
      const bare = Object.create(null) as Record<string, unknown>;
      Object.assign(bare, base);
      return bare as unknown as Profile;
    }
    case 'proto-polluting-own-key':
      Object.defineProperty(base, '__proto__', {
        enumerable: true,
        configurable: true,
        writable: true,
        value: { polluted: marker },
      });
      return base as unknown as Profile;
    case 'array-as-profile':
      return [base] as unknown as Profile;
    case 'string-as-profile':
      return `{"skillLevel":"${marker}"}` as unknown as Profile;
    case 'huge-name':
      base['firstName'] = 'N'.repeat(KB64);
      return base as unknown as Profile;
    case 'nan-skill':
      base['skillLevel'] = Number.NaN;
      return base as unknown as Profile;
    case 'undefined-required':
      base['handedness'] = undefined;
      return base as unknown as Profile;
    case 'function-field':
      base['goal'] = () => marker;
      return base as unknown as Profile;
    case 'date-field':
      base['biggestProblem'] = new Date(0);
      return base as unknown as Profile;
    case 'map-field':
      base['focusCheckpoint'] = new Map([[marker, 1]]);
      return base as unknown as Profile;
  }
}

// ── strict oracle: what a usable Profile looks like ───────────────────────

const HANDEDNESS = new Set(['right', 'left', 'ambidextrous']);
const GENDER_SET = new Set<string>(VALID_GENDERS);
const CHECKPOINT_SET = new Set<string>(CHECKPOINTS);

export interface ShapeVerdict {
  ok: boolean;
  reasons: string[];
}

/**
 * The contract the rest of the app relies on (SettingsScreen/HomeScreen
 * render every field as a <Text> child, AnalyzeScreen feeds handedness and
 * focusCheckpoint into the analysis request): the five required fields are
 * strings, handedness / focusCheckpoint come from their vocabularies, and the
 * optional identity fields are absent or correctly typed.
 */
export function strictProfileVerdict(value: unknown): ShapeVerdict {
  const reasons: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reasons: ['not-an-object'] };
  }
  const record = value as Record<string, unknown>;
  for (const key of ['skillLevel', 'goal', 'biggestProblem'] as const) {
    if (typeof record[key] !== 'string') reasons.push(`${key}:not-string`);
  }
  if (!HANDEDNESS.has(record['handedness'] as string)) {
    reasons.push('handedness:not-in-vocabulary');
  }
  if (!CHECKPOINT_SET.has(record['focusCheckpoint'] as string)) {
    reasons.push('focusCheckpoint:not-a-checkpoint');
  }
  if (
    record['firstName'] !== undefined &&
    typeof record['firstName'] !== 'string'
  ) {
    reasons.push('firstName:not-string');
  }
  if (
    record['gender'] !== undefined &&
    !GENDER_SET.has(record['gender'] as string)
  ) {
    reasons.push('gender:not-in-vocabulary');
  }
  // An OWN `__proto__` data property (what JSON.parse produces) is inert;
  // prototype pollution is asserted separately against Object.prototype.
  return { ok: reasons.length === 0, reasons };
}

/** The store's OWN acceptance rule (appStore.ts parsePendingProfile). */
export function looseStashAccepts(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return false;
    }
    const profile = (parsed as Record<string, unknown>)['profile'];
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      return false;
    }
    const candidate = profile as Record<string, unknown>;
    return [
      'skillLevel',
      'handedness',
      'goal',
      'biggestProblem',
      'focusCheckpoint',
    ].every(key => typeof candidate[key] === 'string');
  } catch {
    return false;
  }
}

export function parseJsonOrNull(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Short, escape-safe preview of a payload for the JSON row table. */
export function preview(text: string | null, max = 160): string | null {
  if (text === null) return null;
  const escaped = JSON.stringify(text.length > max ? text.slice(0, max) : text);
  return text.length > max
    ? `${escaped}…(+${text.length - max} chars)`
    : escaped;
}
