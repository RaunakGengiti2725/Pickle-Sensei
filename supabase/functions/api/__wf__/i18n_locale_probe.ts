// Locale/timezone probe for the edge function's date and number sites.
//
// Executed as a CHILD PROCESS by i18n_locale_invariance.test.ts — once per
// (LANG, TZ) cell — because V8/ICU read the default locale and the process
// zone once at startup; mutating `Deno.env` inside a running isolate does not
// move them. Prints one JSON document to stdout.
//
// `index.ts` calls Deno.serve at module top level, so the private helpers are
// replicated here verbatim with their file:line; `drills.ts` is imported and
// exercised directly.

import { searchDrillCatalog } from "../drills.ts";

const DAY_MS = 86_400_000;

/** index.ts:1682-1725 — computePracticeStreak, copied verbatim. */
function computePracticeStreak(days: string[], today: string) {
  const toDay = (value: string): number | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const parsed = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed) ? Math.floor(parsed / DAY_MS) : null;
  };
  const todayDay = toDay(today)!;
  const uniqueDays = [...new Set(days.map(toDay).filter((d): d is number => d !== null))]
    .filter((d) => d <= todayDay)
    .sort((a, b) => a - b);
  if (uniqueDays.length === 0) {
    return {
      currentDays: 0,
      longestDays: 0,
      practicedToday: false,
      lastPracticeDate: null,
    };
  }
  let longestDays = 1;
  let run = 1;
  for (let i = 1; i < uniqueDays.length; i += 1) {
    if (uniqueDays[i] === uniqueDays[i - 1] + 1) {
      run += 1;
      longestDays = Math.max(longestDays, run);
    } else {
      run = 1;
    }
  }
  const latestDay = uniqueDays[uniqueDays.length - 1];
  let currentDays = 0;
  if (latestDay === todayDay || latestDay === todayDay - 1) {
    currentDays = 1;
    for (let i = uniqueDays.length - 2; i >= 0; i -= 1) {
      if (uniqueDays[i] !== uniqueDays[i + 1] - 1) break;
      currentDays += 1;
    }
  }
  return {
    currentDays,
    longestDays,
    practicedToday: latestDay === todayDay,
    lastPracticeDate: new Date(latestDay * DAY_MS).toISOString().slice(0, 10),
  };
}

/** Fixed "now": 2026-09-04T23:30:00Z — 23:30 UTC is already 2026-09-05 in
 * every zone east of UTC+00:30, so a zone-leaking `today` would show here. */
const NOW_MS = Date.parse("2026-09-04T23:30:00.000Z");
const PRACTICE_DAYS = [
  "2026-08-30",
  "2026-08-31",
  "2026-09-01",
  "2026-09-03",
  "2026-09-04",
  "2026-09-04",
  "not-a-day",
  "2026-09-09",
];
/** progress_daily avg_score values (0-10) that sit on rounding edges. */
const VIEW_SCORES = ["7.25", "7.35", "0.05", "9.995", "10", "3.14159", "6.449999999"];

const resolved = Intl.DateTimeFormat().resolvedOptions();
const rows: Record<string, unknown> = {
  "deno.locale": resolved.locale,
  "deno.timeZone": resolved.timeZone,
  // index.ts:1788 / buildProgress — `today` handed to computePracticeStreak.
  "index.ts:1788 today=toISOString().slice(0,10)": new Date(NOW_MS).toISOString().slice(0, 10),
  // index.ts:1682-1725 — the streak itself.
  "index.ts:1682 computePracticeStreak": computePracticeStreak(
    PRACTICE_DAYS,
    new Date(NOW_MS).toISOString().slice(0, 10),
  ),
  // index.ts:1774-1775 — view score ×10 rounding; the client divides by 10.
  "index.ts:1774 avg_score=round(Number(x)*100)/10": VIEW_SCORES.map(
    (value) => Math.round(Number(value) * 100) / 10,
  ),
  // index.ts:655-656 — permit timestamps.
  "index.ts:655 permit reservedAt/expiresAt": {
    reservedAt: new Date(NOW_MS).toISOString(),
    expiresAt: new Date(NOW_MS + 24 * 3_600_000).toISOString(),
  },
  // index.ts:1884 — rank tie-break uses code-point `<`, not localeCompare.
  "index.ts:1884 shot_type codepoint sort": ["volley", "dink", "Drive", "İdrive", "idrive", "serve"]
    .slice()
    .sort((a, b) => (a < b ? -1 : 1)),
  // drills.ts:707-713 — case-insensitive catalog search via toLowerCase().
  "drills.ts:707 searchDrillCatalog": {
    DINK: (await searchDrillCatalog({ q: "DINK" })).map((d) => d.slug),
    "Dİnk (Turkish dotted capital İ)": (await searchDrillCatalog({ q: "Dİnk" })).map((d) => d.slug),
    "drıve (dotless ı)": (await searchDrillCatalog({ q: "drıve" })).map((d) => d.slug),
    "family=DINK": (await searchDrillCatalog({ family: "DINK" })).map((d) => d.slug),
    "family=dink": (await searchDrillCatalog({ family: "dink" })).map((d) => d.slug),
  },
  // Locale-sensitive controls: these SHOULD differ per cell, proving the
  // child process really runs under the requested locale and zone.
  "control.toLocaleDateString()": new Date(NOW_MS).toLocaleDateString(),
  "control.getDate() (process zone)": new Date(NOW_MS).getDate(),
};

await Deno.stdout.write(
  new TextEncoder().encode(
    JSON.stringify({
      env: { LANG: Deno.env.get("LANG") ?? null, TZ: Deno.env.get("TZ") ?? null },
      deno: Deno.version.deno,
      v8: Deno.version.v8,
      rows,
    }) + "\n",
  ),
);
