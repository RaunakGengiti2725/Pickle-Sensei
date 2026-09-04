// Locale/timezone invariance matrix for the edge function.
//
// Runs i18n_locale_probe.ts as a child process once per (POSIX locale, TZ)
// cell — 12 audit locales × 4 zones — and asserts that every date/number site
// the function ships (UTC day keys, streak arithmetic, score rounding, permit
// timestamps, code-point sort, catalog search) produces byte-identical JSON
// in every cell, while the locale-sensitive CONTROL rows do vary (proving the
// children really ran under the requested locale and zone).
//
// Set PS_I18N_OUT=<file.json> to keep the raw per-cell outputs.
//
// Run: cd supabase/functions/api/__wf__ && deno task test
//  or: deno test -A --no-check --config deno.json i18n_locale_invariance.test.ts

import { assert, assertEquals, assertNotEquals } from "@std/assert";

const LOCALES: readonly { tag: string; posix: string }[] = [
  { tag: "de-DE", posix: "de_DE.UTF-8" },
  { tag: "fr-FR", posix: "fr_FR.UTF-8" },
  { tag: "ar-EG", posix: "ar_EG.UTF-8" },
  { tag: "hi-IN", posix: "hi_IN.UTF-8" },
  { tag: "ja-JP", posix: "ja_JP.UTF-8" },
  { tag: "pt-BR", posix: "pt_BR.UTF-8" },
  { tag: "tr-TR", posix: "tr_TR.UTF-8" },
  { tag: "ru-RU", posix: "ru_RU.UTF-8" },
  { tag: "th-TH", posix: "th_TH.UTF-8" },
  { tag: "zh-CN", posix: "zh_CN.UTF-8" },
  { tag: "en-IN", posix: "en_IN.UTF-8" },
  { tag: "es-419", posix: "es_MX.UTF-8" },
];

/** UTC, the two extremes (+14 / -11) and a half-hour zone. At the fixed
 * instant 2026-09-04T23:30Z the local date is 09-05 in the first, 09-04 in
 * the second, 09-05 in the third. */
const ZONES = ["UTC", "Pacific/Kiritimati", "Pacific/Pago_Pago", "Australia/Adelaide"];

interface Cell {
  locale: string;
  posix: string;
  tz: string;
  command: string;
  code: number;
  stdout: string;
  stderr: string;
  probe: {
    env: { LANG: string | null; TZ: string | null };
    deno: string;
    v8: string;
    rows: Record<string, unknown>;
  } | null;
}

const PROBE = new URL("./i18n_locale_probe.ts", import.meta.url).pathname;
const CONFIG = new URL("./deno.json", import.meta.url).pathname;

async function runCell(locale: { tag: string; posix: string }, tz: string): Promise<Cell> {
  const args = ["run", "-A", "--no-check", "--config", CONFIG, PROBE];
  const env = { LANG: locale.posix, LC_ALL: locale.posix, TZ: tz };
  const out = await new Deno.Command(Deno.execPath(), {
    args,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(out.stdout);
  const stderr = new TextDecoder().decode(out.stderr);
  let probe: Cell["probe"] = null;
  if (out.code === 0) {
    try {
      probe = JSON.parse(stdout) as NonNullable<Cell["probe"]>;
    } catch {
      probe = null;
    }
  }
  return {
    locale: locale.tag,
    posix: locale.posix,
    tz,
    command: `LANG=${env.LANG} LC_ALL=${env.LC_ALL} TZ=${tz} deno ${args.join(" ")}`,
    code: out.code,
    stdout,
    stderr,
    probe,
  };
}

const CONTROL_PREFIX = "control.";
const RUNTIME_KEYS = new Set(["deno.locale", "deno.timeZone"]);

Deno.test("edge fn date/number sites are byte-identical across 12 locales × 4 zones", async () => {
  const cells: Cell[] = [];
  for (const locale of LOCALES) {
    cells.push(...(await Promise.all(ZONES.map((tz) => runCell(locale, tz)))));
  }
  assertEquals(cells.length, LOCALES.length * ZONES.length);

  const outPath = Deno.env.get("PS_I18N_OUT");
  if (outPath) {
    await Deno.writeTextFile(
      outPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          deno: Deno.version,
          locales: LOCALES,
          zones: ZONES,
          cells,
        },
        null,
        2,
      ),
    );
  }

  for (const cell of cells) {
    assertEquals(cell.code, 0, `${cell.command}\n${cell.stderr}`);
    assert(cell.probe, `${cell.command} printed no JSON:\n${cell.stdout}`);
  }

  // The child really ran under the requested locale and zone. ICU may resolve
  // a POSIX locale to a parent tag (es_MX → es-MX, never plain "en-US").
  for (const cell of cells) {
    const rows = cell.probe!.rows;
    assertEquals(rows["deno.timeZone"], cell.tz, cell.command);
    assertEquals(
      String(rows["deno.locale"]).split("-")[0],
      cell.locale.split("-")[0],
      cell.command,
    );
  }

  // Locale-sensitive controls vary across the matrix...
  const controlDates = new Set(
    cells.map((c) => String(c.probe!.rows["control.toLocaleDateString()"])),
  );
  assert(controlDates.size >= 8, `controls collapsed to ${[...controlDates].join(" | ")}`);
  const controlDays = new Set(cells.map((c) => c.probe!.rows["control.getDate() (process zone)"]));
  assertEquals([...controlDays].sort(), [4, 5], "process zone did not move the local date");

  // ...while every shipped site does not.
  const invariantKeys = Object.keys(cells[0]!.probe!.rows).filter(
    (key) => !key.startsWith(CONTROL_PREFIX) && !RUNTIME_KEYS.has(key),
  );
  assert(invariantKeys.length >= 6, invariantKeys.join(", "));
  const reference = cells.find((c) => c.locale === "en-IN" && c.tz === "UTC")!;
  for (const key of invariantKeys) {
    const expected = JSON.stringify(reference.probe!.rows[key]);
    for (const cell of cells) {
      assertEquals(
        JSON.stringify(cell.probe!.rows[key]),
        expected,
        `${key} diverged in ${cell.locale}/${cell.tz}\n${cell.command}`,
      );
    }
  }

  // And the UTC day key is the UTC day, not the process-zone day: 23:30Z on
  // 09-04 stays 09-04 even in Kiritimati (+14), where the local date is 09-05.
  const kiritimati = cells.find((c) => c.tz === "Pacific/Kiritimati")!;
  assertEquals(
    kiritimati.probe!.rows["index.ts:1788 today=toISOString().slice(0,10)"],
    "2026-09-04",
  );
  assertEquals(kiritimati.probe!.rows["control.getDate() (process zone)"], 5);
  assertEquals(kiritimati.probe!.rows["index.ts:1682 computePracticeStreak"], {
    currentDays: 2,
    longestDays: 3,
    practicedToday: true,
    lastPracticeDate: "2026-09-04",
  });
});

Deno.test(
  "drills.ts:707 catalog search is locale-blind — and therefore misses Turkish dotted İ queries in every locale",
  async () => {
    const cells = await Promise.all(
      ["tr-TR", "en-IN", "de-DE"].map((tag) =>
        runCell(
          LOCALES.find((l) => l.tag === tag)!,
          "UTC",
        ),
      ),
    );
    for (const cell of cells) {
      assertEquals(cell.code, 0, cell.stderr);
      const search = cell.probe!.rows["drills.ts:707 searchDrillCatalog"] as Record<
        string,
        string[]
      >;
      assert(search["DINK"]!.length > 0, "ASCII case folding works");
      // `String.prototype.toLowerCase` is locale-independent by spec: "İ" lowers
      // to "i̇" (i + U+0307) under tr-TR exactly as under en-IN, so a query typed
      // with the Turkish capital İ never matches the ASCII "dink" catalog text.
      assertEquals(search["Dİnk (Turkish dotted capital İ)"], []);
      assertEquals(search["drıve (dotless ı)"], []);
      assert(search["family=dink"]!.length > 0, "family filter finds the dink family");
      assertEquals(search["family=DINK"], search["family=dink"]);
      assertNotEquals(search["DINK"], search["Dİnk (Turkish dotted capital İ)"]);
    }
  },
);
