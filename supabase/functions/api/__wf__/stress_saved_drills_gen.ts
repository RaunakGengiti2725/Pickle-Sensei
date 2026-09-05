// Shared seeded generators for the PUT /v1/me/saved-drills/:slug stress
// harnesses (stress_saved_drills_put_fuzz.test.ts drives the in-process edge
// handler; stress_saved_drills_put_pg.test.ts drives a disposable Postgres).
// Everything here is a pure function of the seed so any row in the JSON
// result tables can be regenerated from its `iterSeed`.

/** Mirrors index.ts DRILL_SLUG_RE (oracle only — the handler has its own). */
export const DRILL_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,119}$/i;

// ── Seeded RNG (mulberry32) ──────────────────────────────────────────────────

export class Prng {
  private state: number;
  constructor(public readonly seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
  weighted<T>(entries: ReadonlyArray<readonly [number, T]>): T {
    const total = entries.reduce((s, [w]) => s + w, 0);
    let r = this.next() * total;
    for (const [w, v] of entries) {
      r -= w;
      if (r < 0) return v;
    }
    return entries[entries.length - 1][1];
  }
  uuid(): string {
    const hex = () => this.int(0, 15).toString(16);
    const h = (n: number) => Array.from({ length: n }, hex).join("");
    return `${h(8)}-${h(4)}-4${h(3)}-${"89ab"[this.int(0, 3)]}${h(3)}-${h(12)}`;
  }
  string(alphabet: string, len: number): string {
    let out = "";
    for (let i = 0; i < len; i += 1) {
      out += alphabet[this.int(0, alphabet.length - 1)];
    }
    return out;
  }
}

export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const iterSeedOf = (campaignSeed: number, i: number): number =>
  fnv1a(`${campaignSeed}:${i}`) >>> 0;

// ── Slug generator ───────────────────────────────────────────────────────────

export const LOWER = "abcdefghijklmnopqrstuvwxyz";
export const UPPER = LOWER.toUpperCase();
export const DIGITS = "0123456789";
export const SLUG_TAIL = LOWER + UPPER + DIGITS + "_-";
export const SLUG_HEAD = LOWER + UPPER + DIGITS;
export const LATIN1_PRINTABLE = Array.from(
  { length: 0x7e - 0x20 + 1 },
  (_, i) => String.fromCharCode(0x20 + i),
).join("") + "\u00a0\u00e9\u00ff";

export type SlugKind =
  | "valid"
  | "valid_max_len"
  | "valid_encoded"
  | "too_long"
  | "bad_first_char"
  | "bad_char"
  | "unicode"
  | "control"
  | "encoded_slash"
  | "encoded_nul"
  | "malformed_percent"
  | "dot_segments"
  | "empty"
  | "huge"
  | "whitespace";

export interface SlugGen {
  kind: SlugKind;
  /** raw path segment as placed in the URL */
  raw: string;
}

export function validSlug(rng: Prng, len: number): string {
  return rng.string(SLUG_HEAD, 1) + rng.string(SLUG_TAIL, Math.max(0, len - 1));
}

export function pctEncodeAll(s: string): string {
  return Array.from(new TextEncoder().encode(s))
    .map((b) => `%${b.toString(16).padStart(2, "0").toUpperCase()}`)
    .join("");
}

export function genSlug(rng: Prng): SlugGen {
  const kind = rng.weighted<SlugKind>([
    [22, "valid"],
    [4, "valid_max_len"],
    [6, "valid_encoded"],
    [6, "too_long"],
    [6, "bad_first_char"],
    [10, "bad_char"],
    [8, "unicode"],
    [4, "control"],
    [4, "encoded_slash"],
    [3, "encoded_nul"],
    [8, "malformed_percent"],
    [4, "dot_segments"],
    [3, "empty"],
    [4, "huge"],
    [3, "whitespace"],
  ]);
  switch (kind) {
    case "valid":
      return { kind, raw: validSlug(rng, rng.int(1, 119)) };
    case "valid_max_len":
      return { kind, raw: validSlug(rng, 120) };
    case "valid_encoded": {
      const s = validSlug(rng, rng.int(1, 40));
      // encode a random subset of characters (all decode back to the slug)
      const raw = Array.from(s)
        .map((c) => (rng.chance(0.5) ? pctEncodeAll(c) : c))
        .join("");
      return { kind, raw };
    }
    case "too_long":
      return {
        kind,
        raw: validSlug(rng, rng.pick([121, 122, 150, 256, 1024])),
      };
    case "bad_first_char":
      return {
        kind,
        raw: rng.pick(["-", "_"]) + validSlug(rng, rng.int(0, 30)),
      };
    case "bad_char": {
      const s = validSlug(rng, rng.int(1, 30));
      const bad = rng.pick([
        ".",
        "~",
        "!",
        "*",
        "'",
        "(",
        ")",
        "@",
        "$",
        "&",
        "+",
        ",",
        ";",
        "=",
        ":",
        "%25",
        "%3C",
        "%3E",
        "%22",
        "%27",
        "%60",
        "%7B",
        "%7D",
        "%5C",
        "%5E",
        "%7C",
        "%3F",
        "%23",
      ]);
      const pos = rng.int(0, s.length);
      return { kind, raw: s.slice(0, pos) + bad + s.slice(pos) };
    }
    case "unicode": {
      const s = validSlug(rng, rng.int(0, 20));
      const u = rng.pick([
        "\u017f", // ſ — case-folds to s
        "\u212a", // Kelvin sign
        "\u0130", // İ
        "\u0131", // ı
        "\u00e9",
        "\u00df",
        "\u200b", // zero-width space
        "\u200e", // LRM
        "\u202e", // RLO
        "\u2066",
        "\ufeff",
        "\u{1f3d3}", // 🏓
        "\u{1d400}", // 𝐀
        "\uff41", // fullwidth a
        "\u0430", // Cyrillic а
        "\u00ad", // soft hyphen
      ]);
      return {
        kind,
        raw: encodeURIComponent(s + u + validSlug(rng, rng.int(0, 5))),
      };
    }
    case "control": {
      const c = rng.pick([
        "%00",
        "%01",
        "%09",
        "%0A",
        "%0D",
        "%1B",
        "%7F",
        "%0D%0A",
        "%C2%85",
      ]);
      return {
        kind,
        raw: validSlug(rng, rng.int(1, 10)) + c + validSlug(rng, rng.int(0, 5)),
      };
    }
    case "encoded_slash":
      return {
        kind,
        raw: validSlug(rng, rng.int(1, 8)) +
          rng.pick(["%2F", "%2f", "%5C", "%2F..%2F", "%2Fv1%2Fme"]) +
          validSlug(rng, rng.int(1, 8)),
      };
    case "encoded_nul":
      return {
        kind,
        raw: validSlug(rng, rng.int(1, 8)) + "%00" +
          validSlug(rng, rng.int(0, 8)),
      };
    case "malformed_percent":
      return {
        kind,
        raw: rng.pick([
          "%",
          "%%",
          "%z",
          "%zz",
          "%G1",
          "abc%",
          "abc%2",
          "%C3",
          "%E0%A4%A",
          "%FF%FE",
          "%C0%AF",
          "%ED%A0%80",
          "a%80b",
          "%F4%90%80%80",
          validSlug(rng, rng.int(1, 30)) + "%",
          "%" + validSlug(rng, rng.int(1, 30)),
        ]),
      };
    case "dot_segments":
      return {
        kind,
        raw: rng.pick([
          ".",
          "..",
          "...",
          "%2e",
          "%2e%2e",
          ".%2e",
          "..%2f",
          "..%5c",
          ".a",
          "a.",
          "a..b",
        ]),
      };
    case "empty":
      return { kind, raw: "" };
    case "huge":
      return {
        kind,
        raw: rng.string(
          rng.chance(0.5) ? SLUG_TAIL : SLUG_TAIL + ".%!",
          rng.pick([2_000, 8_192, 65_536]),
        ),
      };
    case "whitespace":
      return {
        kind,
        raw: rng.pick([
          "%20",
          "a%20b",
          "%20abc",
          "abc%20",
          "a%09b",
          "%E2%80%83a",
          "+abc",
          "a+b",
        ]),
      };
  }
}
