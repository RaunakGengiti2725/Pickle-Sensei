#!/usr/bin/env node
/**
 * xc-i18n-unicode-names-text — real-SQLite-engine round trip for the mobile
 * local store's SQL.
 *
 * Applies the mobile app's own LOCAL_MIGRATIONS DDL (parsed out of
 * apps/mobile/src/data/db.ts so it can never drift) to an in-memory SQLite via
 * `node:sqlite`, then replays the exact statements repository.ts issues for
 * kv / local_session / outbox with a Unicode corpus and records, per input:
 * UTF-16 units / code points / graphemes / UTF-8 bytes, whether the value
 * round-tripped byte-for-byte, and what SQLite's own length() / json_extract
 * see. 64 KiB and 5 MiB values are timed with heap numbers.
 *
 * Evidence class: Linux + SQLite <sqlite_version()> through V8's string→UTF-8
 * conversion. It is a proxy for op-sqlite on iOS, not Apple truth.
 *
 *   node --experimental-sqlite scripts/xc-i18n/sqlite_unicode_roundtrip.mjs
 *   (XC_I18N_OUT=/dir to write sqlite_roundtrip.json; exit 1 on any failure)
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const dbSourcePath = join(repoRoot, "apps/mobile/src/data/db.ts");

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const encoder = new TextEncoder();
const measure = (s) => ({
  u16: s.length,
  cp: Array.from(s).length,
  graphemes: Array.from(segmenter.segment(s)).length,
  bytes: encoder.encode(s).byteLength,
});
const codePointsOf = (s) =>
  Array.from(s, (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
const heap = () => {
  const m = process.memoryUsage();
  return { heapUsed: m.heapUsed, heapTotal: m.heapTotal, rss: m.rss };
};

/** The app's migration list, verbatim from db.ts (template literals with no
 * interpolation), evaluated as a JS array literal. */
function loadLocalMigrations() {
  const source = readFileSync(dbSourcePath, "utf8");
  const match = source.match(/const LOCAL_MIGRATIONS: string\[\] = \[([\s\S]*?)\n\];/);
  if (!match) throw new Error(`LOCAL_MIGRATIONS not found in ${dbSourcePath}`);
  const body = match[1].replace(/^\s*\/\/.*$/gm, "");
  // eslint-disable-next-line no-new-func
  const list = new Function(`return [${body}];`)();
  if (!Array.isArray(list) || list.length < 7) throw new Error("unexpected LOCAL_MIGRATIONS shape");
  return list;
}

const db = new DatabaseSync(":memory:");
const migrations = loadLocalMigrations();
for (const sql of migrations) db.exec(sql);
const sqliteVersion = db.prepare("SELECT sqlite_version() AS v").get().v;

/** LocalDb-shaped adapter (apps/mobile/src/data/db.ts `LocalDb`). */
const localDb = {
  execute(sql, params = []) {
    const stmt = db.prepare(sql);
    const isSelect = /^\s*(SELECT|PRAGMA|WITH)/i.test(sql);
    const rows = isSelect ? stmt.all(...params) : (stmt.run(...params), []);
    return Promise.resolve({ rows });
  },
  close() {
    db.close();
  },
};

// ─── Corpus ──────────────────────────────────────────────────────────────────
const FLAG = "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}";
const FAMILY_ZWJ = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}";
const CORPUS = [
  ["ascii", "Alice"],
  ["latin_nfd", "Zoe\u0308 Mu\u0308ller"],
  ["vietnamese", "Nguy\u1ec5n Th\u1ecb H\u1ecda"],
  ["hebrew_rtl", "\u05d3\u05d5\u05d3"],
  ["arabic_with_harakat", "\u0645\u064f\u062d\u064e\u0645\u0651\u064e\u062f"],
  ["persian_zwnj", "\u0639\u0644\u064a\u200c\u0631\u0636\u0627"],
  ["mixed_bidi", "Sam \u05e9\u05dc\u05d5\u05dd"],
  ["bidi_override", "\u202eecilA"],
  ["devanagari_conjunct_zwj", "\u0915\u094d\u200d\u0937"],
  ["bengali", "\u09b8\u09cc\u09b0\u09ad"],
  ["tamil", "\u0b95\u0bcb\u0baa\u0bbe\u0bb2"],
  ["thai", "\u0e2a\u0e21\u0e0a\u0e32\u0e22"],
  ["korean_nfc", "\uae40\ubbfc\uc218"],
  ["korean_nfd", "\u1100\u1175\u11b7\u1106\u1175\u11ab\u1109\u116e"],
  ["japanese", "\u5c71\u7530\u592a\u90ce"],
  ["cjk_ext_b", "\u{20000}\u{20001}"],
  ["emoji_3", "\u{1f3d3}\u{1f525}\u{1f4aa}"],
  ["family_zwj", FAMILY_ZWJ],
  ["three_tag_flags", FLAG.repeat(3)],
  ["zalgo", "A\u0300\u0301\u0302\u0303\u0304\u0305l\u0306\u0307i\u0308\u0309c\u030a\u030be"],
  ["zwsp_inside", "Al\u200bice"],
  ["bom_prefix", "\ufeffAlice"],
  ["nul_inside", "Al\u0000ice"],
  ["c1_controls", "Al\u0085\u009fice"],
  ["lone_high_surrogate", "Al\ud800ice"],
  ["lone_low_surrogate", "Al\udc00ice"],
  ["word_joiner_only", "\u2060"],
  ["hangul_filler_only", "\u3164"],
  ["nbsp_only", "\u00a0\u00a0"],
  ["fixture_word_unicode", "fïxture summary"],
  ["fixture_word_ascii", "fixture summary"],
];
const isWellFormed = (s) => s.isWellFormed();

const results = {
  sqliteVersion,
  node: process.version,
  migrations: migrations.length,
  rows: [],
  scale: [],
  failures: [],
};
const fail = (name, detail) => results.failures.push({ name, ...detail });

// ─── kv: profile JSON round trip (repository.ts setKv / getKv SQL) ────────────
for (const [name, text] of CORPUS) {
  const key = `profile:owner-${name}`;
  const profileJson = JSON.stringify({ firstName: text, skillLevel: "3.5" });
  await localDb.execute(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`, [key, profileJson]);
  const { rows } = await localDb.execute(`SELECT value FROM kv WHERE key = ?`, [key]);
  const back = rows[0]?.value ? String(rows[0].value) : null;
  const parsed = back === null ? null : JSON.parse(back);
  const backName = parsed?.firstName ?? null;
  const sqlite = db
    .prepare(
      `SELECT length(value) AS chars, length(CAST(value AS BLOB)) AS bytes, json_extract(value, '$.firstName') AS extracted FROM kv WHERE key = ?`,
    )
    .get(key);
  const row = {
    table: "kv",
    name,
    inputJson: JSON.stringify(text),
    inputCodePoints: codePointsOf(text),
    in: measure(text),
    wellFormed: isWellFormed(text),
    roundTripped: backName === text,
    backJson: JSON.stringify(backName),
    sqliteLengthChars: sqlite.chars,
    sqliteBlobBytes: sqlite.bytes,
    jsBytesOfStoredJson: encoder.encode(profileJson).byteLength,
    sqliteJsonExtractEquals: sqlite.extracted === text,
  };
  results.rows.push(row);
  // JSON.stringify escapes NUL and lone surrogates (\u0000, \ud800), so the kv
  // JSON path must round-trip EVERY string, well-formed or not.
  if (!row.roundTripped) fail(`kv:${name}`, { backJson: row.backJson });
}

// ─── local_session: raw TEXT columns (repository.ts saveSession SQL) ──────────
for (const [name, text] of CORPUS) {
  const id = `session-${name}`;
  await localDb.execute("BEGIN IMMEDIATE");
  await localDb.execute(
    `INSERT OR REPLACE INTO local_session
       (owner_key, id, mode, shot_type, focus_checkpoint, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ["owner", id, text, text, text, "2026-09-04T00:00:00.000Z"],
  );
  await localDb.execute(
    `INSERT INTO outbox (owner_key, kind, payload)
       VALUES (?, 'session.create', ?)`,
    ["owner", JSON.stringify({ id, mode: text, source: "real" })],
  );
  await localDb.execute("COMMIT");
  const back = db
    .prepare(
      `SELECT mode, length(mode) AS chars, length(CAST(mode AS BLOB)) AS bytes FROM local_session WHERE owner_key = 'owner' AND id = ?`,
    )
    .get(id);
  const outbox = db
    .prepare(
      `SELECT json_extract(payload, '$.mode') AS mode, json_extract(payload, '$.source') AS source FROM outbox WHERE json_extract(payload, '$.id') = ?`,
    )
    .get(id);
  const row = {
    table: "local_session",
    name,
    inputJson: JSON.stringify(text),
    in: measure(text),
    wellFormed: isWellFormed(text),
    roundTripped: back.mode === text,
    backJson: JSON.stringify(back.mode),
    backMeasure: measure(String(back.mode)),
    sqliteLengthChars: back.chars,
    sqliteBlobBytes: back.bytes,
    lengthCountsCodePoints: back.chars === measure(String(back.mode)).cp,
    // SQLite TEXT reads stop at the first NUL (sqlite3_column_text is a C
    // string) while the blob keeps every byte — the classic NUL-truncation.
    nulTruncatedOnRead:
      text.includes("\u0000") && back.mode !== text && back.bytes === measure(text).bytes,
    outboxJsonExtractEquals: outbox?.mode === text,
    outboxSourceStillReal: outbox?.source === "real",
  };
  results.rows.push(row);
  // Raw TEXT binding: well-formed NUL-free strings must round-trip. Lone
  // surrogates (ill-formed) and embedded NUL are engine properties that are
  // recorded, not asserted: the app only ever writes user text to SQLite as
  // JSON (kv / payload columns), where both are escaped — see the kv rows.
  if (row.wellFormed && !text.includes("\u0000") && !row.roundTripped) {
    fail(`local_session:${name}`, { backJson: row.backJson });
  }
  if (!row.outboxSourceStillReal) fail(`outbox:${name}`, { reason: "json_extract lost $.source" });
}

// The fixture-purge migration must not delete sessions whose summary merely
// contains Unicode near the word; re-run the migration list to observe.
db.prepare(`UPDATE local_session SET completed = 1, summary = mode`).run();
const before = db.prepare(`SELECT count(*) AS n FROM local_session`).get().n;
for (const sql of migrations) db.exec(sql);
const after = db.prepare(`SELECT count(*) AS n FROM local_session`).get().n;
const purged = db
  .prepare(`SELECT id FROM local_session`)
  .all()
  .map((r) => r.id);
results.fixturePurge = {
  sessionsBefore: before,
  sessionsAfter: after,
  // The LIKE '%fixture%' purge only fires for sessions with no shots; every
  // row here has none, so exactly the ASCII 'fixture' summary must go
  // (LIKE is ASCII-case-insensitive and does not fold ï → i).
  removed: CORPUS.map(([n]) => `session-${n}`).filter((id) => !purged.includes(id)),
};
if (results.fixturePurge.removed.join() !== "session-fixture_word_ascii") {
  fail("fixture_purge", results.fixturePurge);
}

// ─── Scale: 64 KiB and 5 MiB kv values ───────────────────────────────────────
for (const [name, text] of [
  ["kb64_emoji", "\u{1f3d3}".repeat(16_384)],
  ["kb64_cjk", "\u4e2d".repeat((65_536 / 3) | 0)],
  ["mib5_ascii", "x".repeat(5 * 1024 * 1024)],
  ["mib5_nfd_combining", "e\u0301".repeat(((5 * 1024 * 1024) / 3) | 0)],
]) {
  const started = performance.now();
  await localDb.execute(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`, [
    `big:${name}`,
    text,
  ]);
  const { rows } = await localDb.execute(`SELECT value FROM kv WHERE key = ?`, [`big:${name}`]);
  const ms = performance.now() - started;
  const back = String(rows[0]?.value ?? "");
  const sqlite = db
    .prepare(
      `SELECT length(value) AS chars, length(CAST(value AS BLOB)) AS bytes FROM kv WHERE key = ?`,
    )
    .get(`big:${name}`);
  const row = {
    name,
    in: measure(text),
    roundTripped: back === text,
    sqliteLengthChars: sqlite.chars,
    sqliteBlobBytes: sqlite.bytes,
    ms: Math.round(ms),
    heap: heap(),
  };
  results.scale.push(row);
  if (!row.roundTripped) fail(`scale:${name}`, {});
}

localDb.close();

const out = process.env.XC_I18N_OUT;
if (out) {
  mkdirSync(out, { recursive: true });
  const path = join(out, "sqlite_roundtrip.json");
  writeFileSync(path, JSON.stringify(results, null, 2));
  console.log(`[xc-i18n] wrote ${path}`);
}
console.log(
  JSON.stringify(
    {
      sqliteVersion,
      rows: results.rows.length,
      scale: results.scale.length,
      failures: results.failures.length,
      loneSurrogateRows: results.rows
        .filter((r) => !r.wellFormed)
        .map((r) => ({
          table: r.table,
          name: r.name,
          roundTripped: r.roundTripped,
          backJson: r.backJson,
        })),
      nulRows: results.rows
        .filter((r) => r.name === "nul_inside")
        .map((r) => ({
          table: r.table,
          roundTripped: r.roundTripped,
          sqliteLengthChars: r.sqliteLengthChars,
          cp: r.in.cp,
        })),
    },
    null,
    2,
  ),
);
process.exit(results.failures.length === 0 ? 0 : 1);
