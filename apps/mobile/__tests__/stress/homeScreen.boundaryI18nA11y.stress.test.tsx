/**
 * STRESS — HomeScreen · boundary / i18n / a11y lens.
 *
 * Renders the REAL app shell (RootNavigator → NavigationContainer →
 * native-stack → bottom-tabs → HomeScreen, wrapped in the same
 * SafeAreaProvider + QueryClientProvider App.tsx uses) with the real Zustand
 * stores, the real repository and a REAL SQLite database (node:sqlite behind
 * the op-sqlite native seam, the pattern dbMigrationMalformedOutbox.test.ts
 * established). Only native modules and fetch are doubled.
 *
 * Every variant is derived from one seed (mulberry32) and is replayable:
 *   STRESS_ONLY=<seed[,seed]>  replay exactly these seeds
 *   STRESS_ITER=<n>            campaign size (default 12; ≥150 for the lens)
 *   STRESS_SEED=<n>            base seed (default 20260904)
 *   STRESS_REPEAT=<n>          run every seed n× (flake-rate probing)
 *   STRESS_OUT=<dir>           results table + rendered-tree evidence
 *
 * Oracles (rendered-tree level — Jest has no layout engine, so "clipped" is
 * an INFERRED width estimate, never a measured truth):
 *   R1 render completes without throwing and leaves the loading state;
 *   R2 no boundary token leaks into visible text or a11y labels
 *      (undefined / null / NaN / Invalid Date / [object Object] / e+NN);
 *   R3 every interactive element has an interactive accessibilityRole and a
 *      non-empty accessibilityLabel (or text content);
 *   R4 every interactive element's touch box (style height/minHeight +
 *      hitSlop, or the tallest fixed-height host inside it) is ≥ 44pt;
 *   R5 no interactive element is nested inside another (screen readers
 *      collapse the inner one);
 *   R6 numberOfLines={1} texts whose ESTIMATED glyph width exceeds the
 *      available column are reported as probable truncation (INFERRED);
 *   R7 visible copy honours the dossier vocabulary ban;
 *   R8 controls actually work through the real navigator/stores: the chart
 *      tab persists to SQLite kv and flips accessibilityState, the streak
 *      badge and drill card push their routes, a recent card opens Result;
 *   R9 locale-sensitive text follows the simulated device locale and the
 *      recent-read date honours the simulated device time zone.
 *
 * Known, previously-ledgered failure modes are recorded as KNOWN (they still
 * appear in the results table and evidence) and do not fail the suite;
 * anything new fails the seed.
 */
import React from 'react';
import {
  Dimensions,
  I18nManager,
  PixelRatio,
  StyleSheet,
  Text,
} from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type {
  ReactTestInstance,
  ReactTestRenderer,
  ReactTestRendererJSON,
} from 'react-test-renderer';
import type {
  CheckpointKey,
  ShotAnalysis,
  ShotTypeSlug,
} from '@pickle/shared-types';

// apps/mobile types only `jest` (no @types/node); the exact Node surface this
// harness drives is declared here, as dbMigrationMalformedOutbox.test.ts does.
declare const require: (id: string) => unknown;
declare const process: { env: Record<string, string | undefined> };
declare const __dirname: string;

const realNow: () => number = Date.now.bind(Date);

interface SqliteStatement {
  all(...params: (string | number | null)[]): Record<string, unknown>[];
  run(...params: (string | number | null)[]): unknown;
}
interface DatabaseSync {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
interface NodeFs {
  mkdirSync(path: string, options: { recursive: boolean }): void;
  writeFileSync(path: string, data: string): void;
}
interface NodePath {
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
}
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (location: string) => DatabaseSync;
};
const fs = require('fs') as NodeFs;
const nodePath = require('path') as NodePath;

// ─── Native seams (the ONLY doubles) ─────────────────────────────────────────

// One in-memory database for the whole file: the production `getDb()`
// singleton runs migrations once, so variants wipe rows rather than swap
// files (exactly what a device does between sessions).
const mockSqlite: { db: DatabaseSync | null; opens: number } = {
  db: null,
  opens: 0,
};

function wipeRows(db: DatabaseSync): void {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all()
    .map(row => String(row['name']));
  for (const table of tables) db.exec(`DELETE FROM "${table}"`);
}

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    mockSqlite.opens += 1;
    const run = (sql: string, params: unknown[] = []) => {
      const db = mockSqlite.db;
      if (!db) throw new Error('stress harness: database not seeded');
      const bound = params.map(value =>
        typeof value === 'boolean' ? Number(value) : value,
      ) as (string | number | null)[];
      const statement = db.prepare(sql);
      if (/^\s*(select|pragma|with)\b/i.test(sql)) {
        return { rows: statement.all(...bound) };
      }
      statement.run(...bound);
      return { rows: [] };
    };
    return {
      executeSync: (sql: string, params?: unknown[]) => run(sql, params),
      execute: async (sql: string, params?: unknown[]) => run(sql, params),
      close: () => {},
    };
  },
}));

jest.mock('react-native-linear-gradient', () => {
  const ReactModule = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});

jest.mock(
  'react-native-safe-area-context',
  () =>
    (
      require('react-native-safe-area-context/jest/mock') as {
        default: unknown;
      }
    ).default,
);

jest.mock('react-native-webview', () => {
  const { View } = require('react-native') as typeof import('react-native');
  return { __esModule: true, default: View, WebView: View };
});

const fetchCalls: string[] = [];
(globalThis as { fetch: unknown }).fetch = jest.fn(async (input: unknown) => {
  fetchCalls.push(String(input));
  return {
    ok: false,
    status: 503,
    headers: { get: () => null },
    json: async () => ({ error: 'stress harness: network disabled' }),
    text: async () => 'stress harness: network disabled',
  };
});

// ─── Production modules (real) ───────────────────────────────────────────────

import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RootNavigator } from '../../src/navigation/RootNavigator';
import { HomeScreen, WEEK_CHART_KV_KEY } from '../../src/screens/HomeScreen';
import { useAppStore } from '../../src/state/appStore';
import { useConsistencyStore } from '../../src/consistency/store';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import type { SchedulerPort } from '../../src/notifications/service';
import {
  GUEST_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { getDb, type LocalDb } from '../../src/data/db';
import { getKv, saveAnalysis, setKv } from '../../src/data/repository';
import { profileKeyForOwner } from '../../src/data/accountScope';
import type { Profile } from '../../src/state/profile';

// ─── Seeded scenario space ───────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('empty pool');
  return item;
}
const intIn = (rng: Rng, lo: number, hi: number) =>
  lo + Math.floor(rng() * (hi - lo + 1));

const LOCALES = [
  'de-DE',
  'fr-FR',
  'ar-EG',
  'hi-IN',
  'ja-JP',
  'pt-BR',
  'tr-TR',
  'ru-RU',
  'th-TH',
  'zh-CN',
  'en-IN',
  'es-419',
] as const;

/** UTC+14, UTC−12, half-hour, 45-minute, US DST, EU DST, 30-min DST, southern DST. */
const TIME_ZONES = [
  'Pacific/Kiritimati',
  'Etc/GMT+12',
  'Asia/Kolkata',
  'Pacific/Chatham',
  'America/New_York',
  'Europe/Berlin',
  'Australia/Lord_Howe',
  'America/Santiago',
] as const;

/** "Now" anchors: DST edges (US/EU/AU/CL), year roll, leap day, plain day. */
const CLOCKS = [
  '2026-03-08T07:00:30Z', // US spring-forward instant (02:00 EST → 03:00 EDT)
  '2026-11-01T05:59:30Z', // US fall-back, second 01:xx hour
  '2026-03-29T00:59:59Z', // EU spring-forward minus one second
  '2026-10-25T01:00:00Z', // EU fall-back instant
  '2026-04-05T15:30:00Z', // AU Lord Howe fall-back window
  '2026-09-06T03:00:00Z', // Chile spring-forward window
  '2026-12-31T23:30:00Z', // year roll for UTC+ zones
  '2028-02-29T12:00:00Z', // leap day
  '2026-06-15T10:00:00Z',
] as const;

const FONT_SCALES = [1, 1.5, 2] as const;
const WIDTHS = [320, 390, 430] as const;

const LATIN_220 =
  'Alexandria-Wilhelmina Fitzgerald-Montgomery of the Third Court Lane, keeper of the ninety-nine paddles, who practices dinks every single morning before the sun clears the fence and never once missed a scheduled analysis session in two seasons';
const CJK_200 =
  '山'.repeat(40) +
  '川'.repeat(40) +
  '泳'.repeat(40) +
  '龍'.repeat(40) +
  '日本語の長い名前'.repeat(5);
const ARABIC_RTL =
  'محمد عبد الرحمن بن خالد الطويل جداً لاعب البيكلبول الذي يتدرب كل صباح في الملعب الثالث بجوار السور الطويل ويحلل ضرباته بدقة';
const HINDI = 'श्रीमती अनन्या कृष्णमूर्ति द्विवेदी क्षत्रिय ज्ञानेश्वर';
const THAI =
  'สมชายผู้ฝึกซ้อมพิกเกิลบอลทุกเช้าอย่างสม่ำเสมอและวิเคราะห์การตีอย่างละเอียด';
const ZWJ_EMOJI = '👨‍👩‍👧‍👦👩🏽‍🚀🏳️‍🌈🧑🏿‍🤝‍🧑🏻👨‍❤️‍💋‍👨🏴󠁧󠁢󠁳󠁣󠁴󠁿🇧🇷🇯🇵';
const COMBINING = 'Z̴̧̢̨̛̘̙̜̝̞̟̠̤̥̦̩̪̫̬̭̮̯̰̱̲̳̹̺̻̼͇͈͉͍͎͓͔͕͖͙͚͓͔͕͖͙͚̀́̂̃̄̅̆̇̈̉̊̋̌̍̎̏̐̑̒̓̔̽̾̿̀́͂̓̈́͆͊͋͌͐͑͒͐͑͒̕̚ͅà̴̧̢̨̛̘̙̜̝̞̟̠̤̥̦̩̪̫̬̭̮̯̰̱̲̳̹̺̻̼͇͈͉͍͎͓͔͕͖͙͚́̂̃̄̅̆̇̈̉̊̋̌̍̎̏̐̑̒̓̔̽̾̿̀́͂̓̈́͆͊͋͌͐͑͒̕̚ͅļ̴̢̨̛̘̙̜̝̞̟̠̤̥̦̩̪̫̬̭̮̯̰̱̲̳̹̺̻̼͇͈͉͍͎̀́̂̃̄̅̆̇̈̉̊̋̌̍̎̏̐̑̒̓̔̽̾̿̀́͂̓̈́͆͊͋͌̕̚ͅģ̴̢̨̛̘̙̜̝̞̟̠̤̥̦̩̪̫̬̭̮̯̰̱̲̳̹̺̻̼͇͈͉͍͎̀́̂̃̄̅̆̇̈̉̊̋̌̍̎̏̐̑̒̓̔̽̾̿̀́͂̓̈́͆͊͋͌̕̚ͅờ̴̧̢̨̘̙̜̝̞̟̠̤̥̦̩̪̫̬̭̮̯̰̱̲̳̹̺̻̼͇͈͉͍͎́̂̃̄̅̆̇̈̉̊̋̌̍̎̏̐̑̒̓̔̽̾̿̀́͂̓̈́͆͊͋͌̕̚ͅ';
const GERMAN_COMPOUND =
  'Donaudampfschifffahrtsgesellschaftskapitänsmützenherstellungsverordnungsdurchführungsbestimmung';
const TURKISH = 'İlayda Şükriye Çağla Öztürk-Işık';
const BIDI_MIXED = 'Sami سامي 123 Ali علي‏ ‎LTR‎';
const WHITESPACE = '   \u00a0\u2003\u200b  ';

const NAME_POOL: ReadonlyArray<{ id: string; value: string | undefined }> = [
  { id: 'name:undefined', value: undefined },
  { id: 'name:empty', value: '' },
  { id: 'name:whitespace', value: WHITESPACE },
  { id: 'name:short', value: 'Ana' },
  { id: 'name:latin220', value: LATIN_220 },
  { id: 'name:cjk200', value: CJK_200 },
  { id: 'name:arabic-rtl', value: ARABIC_RTL },
  { id: 'name:hindi', value: HINDI },
  { id: 'name:thai', value: THAI },
  { id: 'name:zwj-emoji', value: ZWJ_EMOJI },
  { id: 'name:combining', value: COMBINING },
  { id: 'name:german-compound', value: GERMAN_COMPOUND },
  { id: 'name:turkish', value: TURKISH },
  { id: 'name:bidi-mixed', value: BIDI_MIXED },
  {
    id: 'name:template-injection',
    value: '${profile.firstName} {{name}} </Text>',
  },
];

const SKILL_POOL: ReadonlyArray<{ id: string; value: string }> = [
  { id: 'skill:empty', value: '' },
  { id: 'skill:beginner', value: 'Beginner' },
  { id: 'skill:cjk', value: '上級者レベル' },
  { id: 'skill:arabic', value: 'مستوى متقدم' },
  { id: 'skill:german-compound', value: GERMAN_COMPOUND },
  { id: 'skill:emoji', value: ZWJ_EMOJI },
  { id: 'skill:latin220', value: LATIN_220 },
];

const CHECKPOINT_KEYS: readonly CheckpointKey[] = [
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
];

const SHOT_TYPES: readonly ShotTypeSlug[] = [
  'serve',
  'return',
  'forehand_drive',
  'backhand_drive',
  'third_shot_drop',
  'dink',
  'volley',
  'overhead',
];

/** Scores the pipeline can never emit but a local row could hold. */
const SCORE_POOL: ReadonlyArray<{ id: string; value: number | null }> = [
  { id: 'score:null', value: null },
  { id: 'score:0', value: 0 },
  { id: 'score:-0', value: -0 },
  { id: 'score:-1', value: -1 },
  { id: 'score:10', value: 10 },
  { id: 'score:7.25', value: 7.25 },
  { id: 'score:9.95', value: 9.95 },
  { id: 'score:1e21', value: 1e21 },
  { id: 'score:1e-7', value: 1e-7 },
  { id: 'score:2^53+1', value: 2 ** 53 + 1 },
  { id: 'score:MAX_VALUE', value: Number.MAX_VALUE },
  { id: 'score:-MAX', value: -Number.MAX_VALUE },
];

const CONFIDENCE_POOL = [0, 0.5, 1, -1, 2, 1e308] as const;

/** Row-level strings outside the ShotTypeSlug union (legacy/corrupt rows). */
const ROGUE_SHOT_TYPE_POOL: ReadonlyArray<{ id: string; value: string }> = [
  { id: 'shot:empty', value: '' },
  { id: 'shot:underscores', value: '____' },
  { id: 'shot:latin220', value: LATIN_220.replace(/ /g, '_') },
  { id: 'shot:cjk', value: CJK_200.slice(0, 60) },
  { id: 'shot:arabic', value: ARABIC_RTL.slice(0, 60) },
  { id: 'shot:zwj', value: ZWJ_EMOJI },
  { id: 'shot:combining', value: COMBINING },
  { id: 'shot:german', value: GERMAN_COMPOUND },
];

const CAPTURED_AT_POOL: ReadonlyArray<{ id: string; value: string }> = [
  { id: 'at:epoch', value: '1970-01-01T00:00:00.000Z' },
  { id: 'at:max-date', value: '+275760-09-13T00:00:00.000Z' },
  { id: 'at:year-9999', value: '9999-12-31T23:59:59.999Z' },
  { id: 'at:offset+14', value: '2026-06-15T23:30:00+14:00' },
  { id: 'at:offset-12', value: '2026-06-15T00:30:00-12:00' },
  { id: 'at:not-a-date', value: 'not-a-date' },
  { id: 'at:empty', value: '' },
  { id: 'at:date-only', value: '2026-06-15' },
  { id: 'at:us-dst-gap', value: '2026-03-08T02:30:00' },
];

const STREAK_INJECT_POOL = [
  0, 1, 2, 7, 30, 365, 1000, 99999999, -1, -365,
] as const;

interface Scenario {
  seed: number;
  locale: (typeof LOCALES)[number];
  timeZone: (typeof TIME_ZONES)[number];
  clock: (typeof CLOCKS)[number];
  fontScale: (typeof FONT_SCALES)[number];
  width: (typeof WIDTHS)[number];
  rtl: boolean;
  profile:
    | { kind: 'none' }
    | {
        kind: 'profile';
        nameId: string;
        skillId: string;
        focus: CheckpointKey | '';
      };
  realShots: number;
  scoreIds: string[];
  rogueShots: Array<{ shotId: string; atId: string; scoreId: string }>;
  streakInject: number | null;
  notificationCard: boolean;
  interactions: boolean;
}

function deriveScenario(seed: number): Scenario {
  const rng = mulberry32(seed);
  const profileKind = rng() < 0.15 ? 'none' : 'profile';
  const realShots = pick(rng, [0, 0, 1, 3, 5, 12, 40] as const);
  const scoreIds = Array.from(
    { length: realShots },
    () => pick(rng, SCORE_POOL).id,
  );
  const rogueCount = pick(rng, [0, 0, 1, 2, 4] as const);
  const rogueShots = Array.from({ length: rogueCount }, () => ({
    shotId: pick(rng, ROGUE_SHOT_TYPE_POOL).id,
    atId: pick(rng, CAPTURED_AT_POOL).id,
    scoreId: pick(rng, SCORE_POOL).id,
  }));
  return {
    seed,
    locale: pick(rng, LOCALES),
    timeZone: pick(rng, TIME_ZONES),
    clock: pick(rng, CLOCKS),
    fontScale: pick(rng, FONT_SCALES),
    width: pick(rng, WIDTHS),
    rtl: rng() < 0.25,
    profile:
      profileKind === 'none'
        ? { kind: 'none' }
        : {
            kind: 'profile',
            nameId: pick(rng, NAME_POOL).id,
            skillId: pick(rng, SKILL_POOL).id,
            focus: rng() < 0.15 ? '' : pick(rng, CHECKPOINT_KEYS),
          },
    realShots,
    scoreIds,
    rogueShots,
    streakInject: rng() < 0.35 ? pick(rng, STREAK_INJECT_POOL) : null,
    notificationCard: rng() < 0.6,
    interactions: true,
  };
}

// ─── Environment simulation (device locale / tz / clock / type / width) ──────

interface EnvRestore {
  (): void;
}

function simulateDeviceEnvironment(s: Scenario): EnvRestore {
  const restores: Array<() => void> = [];

  // Time zone: Node re-reads TZ on assignment; Intl default follows.
  const previousTz = process.env.TZ;
  process.env.TZ = s.timeZone;
  restores.push(() => {
    process.env.TZ = previousTz;
  });

  // Device locale: Hermes resolves `undefined` locales to the device locale;
  // in Node that default is fixed at startup, so inject it at the boundary.
  const RealDTF = Intl.DateTimeFormat;
  const RealNF = Intl.NumberFormat;
  const withLocale = (locales: unknown) =>
    locales === undefined || locales === null ? s.locale : locales;
  const PatchedDTF = function (
    this: unknown,
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions,
  ) {
    return new RealDTF(withLocale(locales) as string | string[], options);
  } as unknown as typeof Intl.DateTimeFormat;
  Object.setPrototypeOf(PatchedDTF, RealDTF);
  (PatchedDTF as { prototype: unknown }).prototype = RealDTF.prototype;
  (PatchedDTF as { supportedLocalesOf: unknown }).supportedLocalesOf =
    RealDTF.supportedLocalesOf.bind(RealDTF);
  const PatchedNF = function (
    this: unknown,
    locales?: string | string[],
    options?: Intl.NumberFormatOptions,
  ) {
    return new RealNF(withLocale(locales) as string | string[], options);
  } as unknown as typeof Intl.NumberFormat;
  Object.setPrototypeOf(PatchedNF, RealNF);
  (PatchedNF as { prototype: unknown }).prototype = RealNF.prototype;
  (PatchedNF as { supportedLocalesOf: unknown }).supportedLocalesOf =
    RealNF.supportedLocalesOf.bind(RealNF);
  Intl.DateTimeFormat = PatchedDTF;
  Intl.NumberFormat = PatchedNF;
  restores.push(() => {
    Intl.DateTimeFormat = RealDTF;
    Intl.NumberFormat = RealNF;
  });

  const dateProto = Date.prototype;
  const realToLocaleDateString = dateProto.toLocaleDateString;
  const realToLocaleTimeString = dateProto.toLocaleTimeString;
  const realToLocaleString = dateProto.toLocaleString;
  const realNumberToLocaleString = Number.prototype.toLocaleString;
  dateProto.toLocaleDateString = function (
    this: Date,
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions,
  ) {
    return realToLocaleDateString.call(
      this,
      withLocale(locales) as string,
      options,
    );
  };
  dateProto.toLocaleTimeString = function (
    this: Date,
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions,
  ) {
    return realToLocaleTimeString.call(
      this,
      withLocale(locales) as string,
      options,
    );
  };
  dateProto.toLocaleString = function (
    this: Date,
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions,
  ) {
    return realToLocaleString.call(
      this,
      withLocale(locales) as string,
      options,
    );
  };
  Number.prototype.toLocaleString = function (
    this: number,
    locales?: string | string[],
    options?: Intl.NumberFormatOptions,
  ) {
    return realNumberToLocaleString.call(
      this,
      withLocale(locales) as string,
      options,
    );
  };
  restores.push(() => {
    dateProto.toLocaleDateString = realToLocaleDateString;
    dateProto.toLocaleTimeString = realToLocaleTimeString;
    dateProto.toLocaleString = realToLocaleString;
    Number.prototype.toLocaleString = realNumberToLocaleString;
  });

  // Clock: fixed "now" without fake timers (React Navigation + act() need
  // real timers). `new Date(x)` and Date.parse stay real.
  const RealDate = Date;
  const nowMs = RealDate.parse(s.clock);
  const FixedDate = function (this: Date, ...args: unknown[]) {
    if (args.length === 0) return new RealDate(nowMs);
    return new (RealDate as unknown as new (...a: unknown[]) => Date)(...args);
  } as unknown as typeof Date;
  Object.setPrototypeOf(FixedDate, RealDate);
  (FixedDate as { prototype: unknown }).prototype = RealDate.prototype;
  (FixedDate as { now: () => number }).now = () => nowMs;
  (FixedDate as { parse: typeof Date.parse }).parse =
    RealDate.parse.bind(RealDate);
  (FixedDate as { UTC: typeof Date.UTC }).UTC = RealDate.UTC.bind(RealDate);
  (globalThis as { Date: typeof Date }).Date = FixedDate;
  restores.push(() => {
    (globalThis as { Date: typeof Date }).Date = RealDate;
  });

  // Dynamic Type + device width: the values RN exposes to components.
  const fontScaleSpy = jest
    .spyOn(PixelRatio, 'getFontScale')
    .mockReturnValue(s.fontScale);
  const realGet = Dimensions.get.bind(Dimensions);
  const dimsSpy = jest.spyOn(Dimensions, 'get').mockImplementation(kind => {
    const base = realGet(kind);
    return { ...base, width: s.width, height: 852, fontScale: s.fontScale };
  });
  restores.push(() => {
    fontScaleSpy.mockRestore();
    dimsSpy.mockRestore();
  });

  // Layout direction flag (components that branch on it).
  const rtlDescriptor = Object.getOwnPropertyDescriptor(I18nManager, 'isRTL');
  try {
    Object.defineProperty(I18nManager, 'isRTL', {
      configurable: true,
      value: s.rtl,
    });
    restores.push(() => {
      if (rtlDescriptor)
        Object.defineProperty(I18nManager, 'isRTL', rtlDescriptor);
    });
  } catch {
    // Non-configurable on this RN build: RTL then only flows through strings.
  }

  return () => {
    for (const restore of restores.reverse()) restore();
  };
}

// ─── Fixture seeding through the REAL repository / SQLite ────────────────────

function poolValue<T>(
  pool: ReadonlyArray<{ id: string; value: T }>,
  id: string,
): T {
  const entry = pool.find(item => item.id === id);
  if (!entry) throw new Error(`unknown pool id ${id}`);
  return entry.value;
}

function analysisFixture(
  rng: Rng,
  index: number,
  shotType: ShotTypeSlug,
  capturedAtIso: string,
  overallScore: number | null,
): ShotAnalysis {
  const confidence = pick(rng, CONFIDENCE_POOL);
  const scored = overallScore !== null;
  const checkpoint = pick(rng, CHECKPOINT_KEYS);
  return {
    id: `stress-${index.toString(16).padStart(4, '0')}-${Math.floor(rng() * 1e9).toString(16)}`,
    sessionId: rng() < 0.5 ? null : `session-${index % 3}`,
    shotType,
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso,
    timestamps: { startMs: 0, contactMs: scored ? 420 : null, endMs: 900 },
    phases: [],
    measurements: [],
    checkpoints: [
      {
        key: checkpoint,
        score: scored
          ? Math.max(0, Math.min(100, (overallScore ?? 0) * 10))
          : null,
        confidence,
        band: scored ? 'green' : 'unscored',
        direction: 'late',
        severity: 0,
        applicable: scored,
      },
    ],
    overallScore,
    analysisConfidence: confidence,
    resultKind: scored ? 'scored' : 'low_confidence',
    guidance: scored ? null : 'Move the phone back one step.',
    priorityFix: scored
      ? { checkpoint, reasonKey: 'stress', severity: 0.2, confidence }
      : null,
    versionVector: {
      appVersion: '1.0.0',
      modelBundleVersion: 'stress',
      poseModelVersion: 'stress',
      paddleModelVersion: 'stress',
      strokeDetectorVersion: 'stress',
      phaseModelVersion: 'stress',
      scoringModelVersion: 'stress-model',
      shotConfigVersion: 'stress-config',
    },
    source: 'real',
  };
}

async function seedDatabase(s: Scenario, db: LocalDb): Promise<void> {
  const rng = mulberry32(s.seed ^ 0x5eed);
  const nowMs = Date.parse(s.clock);
  // Real analyses: one per day walking back from "now" so streaks replay.
  for (let i = 0; i < s.realShots; i += 1) {
    const scoreId = s.scoreIds[i] ?? 'score:null';
    const score = poolValue(SCORE_POOL, scoreId);
    const capturedAt = new Date(
      nowMs - i * 86_400_000 - intIn(rng, 0, 20 * 3_600_000),
    ).toISOString();
    const analysis = analysisFixture(
      rng,
      i,
      pick(rng, SHOT_TYPES),
      capturedAt,
      score,
    );
    if (score === null) {
      await db.execute(
        `INSERT OR REPLACE INTO local_shot
         (owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          GUEST_DATA_OWNER,
          analysis.id,
          analysis.sessionId,
          analysis.shotType,
          analysis.capturedAtIso,
          null,
          analysis.analysisConfidence,
          analysis.resultKind,
          analysis.source,
          JSON.stringify(analysis),
        ],
      );
    } else {
      await saveAnalysis(db, analysis, `permit-${i}`);
    }
  }
  // Rogue rows: what an older build or a corrupt store could leave behind.
  for (const [i, rogue] of s.rogueShots.entries()) {
    const shotType = poolValue(ROGUE_SHOT_TYPE_POOL, rogue.shotId);
    const capturedAt = poolValue(CAPTURED_AT_POOL, rogue.atId);
    const score = poolValue(SCORE_POOL, rogue.scoreId);
    const analysis = analysisFixture(rng, 1000 + i, 'dink', capturedAt, score);
    const payload = JSON.stringify({ ...analysis, shotType });
    await db.execute(
      `INSERT OR REPLACE INTO local_shot
       (owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        GUEST_DATA_OWNER,
        analysis.id,
        analysis.sessionId,
        shotType,
        capturedAt,
        score,
        analysis.analysisConfidence,
        score === null ? 'low_confidence' : 'scored',
        'real',
        payload,
      ],
    );
  }
  if (s.profile.kind === 'profile') {
    const firstName = poolValue(NAME_POOL, s.profile.nameId);
    const profile: Profile = {
      ...(firstName === undefined ? {} : { firstName }),
      skillLevel: poolValue(SKILL_POOL, s.profile.skillId),
      handedness: 'right',
      goal: 'dinks',
      biggestProblem: 'consistency',
      focusCheckpoint: s.profile.focus as CheckpointKey,
    };
    await setKv(
      db,
      profileKeyForOwner(GUEST_DATA_OWNER),
      JSON.stringify(profile),
    );
  }
}

const schedulerDouble: SchedulerPort & { applied: number } = {
  applied: 0,
  permissionState: async () => 'undetermined',
  requestPermission: async () => 'granted',
  applyPlan: async () => {
    schedulerDouble.applied += 1;
  },
  cancelAllPlanned: async () => {},
  openSystemSettings: async () => {},
};

// ─── Rendered-tree inspection ────────────────────────────────────────────────

type Node = ReactTestInstance;
const isHost = (n: Node) => typeof n.type === 'string';
const isPressable = (n: Node) =>
  typeof n.type === 'function' && n.type.name === 'Pressable';

function flat(style: unknown): Record<string, unknown> {
  return (StyleSheet.flatten(style as never) ?? {}) as Record<string, unknown>;
}

function textOf(node: Node): string {
  const out: string[] = [];
  const walk = (child: unknown) => {
    if (child === null || child === undefined || typeof child === 'boolean')
      return;
    if (typeof child === 'string' || typeof child === 'number') {
      out.push(String(child));
      return;
    }
    if (Array.isArray(child)) {
      child.forEach(walk);
    }
  };
  node.findAllByType(Text).forEach(t => walk(t.props.children));
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

function componentPath(node: Node): string {
  const names: string[] = [];
  let cursor: Node | null = node;
  while (cursor) {
    if (typeof cursor.type === 'function' && cursor.type.name) {
      names.push(cursor.type.name);
    }
    cursor = cursor.parent;
  }
  return names.slice(0, 6).reverse().join(' > ');
}

interface HitBox {
  height: number | null;
  width: number | null;
  hitSlopY: number;
  hitSlopX: number;
}

function hitBoxOf(pressable: Node): HitBox {
  const hosts = pressable.findAll(isHost);
  let height: number | null = null;
  let width: number | null = null;
  // Width is only knowable from the Pressable's OWN host style; an inner
  // fixed-width icon says nothing about the control's frame.
  const own = flat(hosts[0]?.props.style);
  for (const key of ['width', 'minWidth'] as const) {
    const value = own[key];
    if (typeof value === 'number' && value > 0)
      width = Math.max(width ?? 0, value);
  }
  for (const host of hosts) {
    const style = flat(host.props.style);
    for (const key of ['height', 'minHeight'] as const) {
      const value = style[key];
      if (typeof value === 'number') height = Math.max(height ?? 0, value);
    }
    // Vertical padding around a single-line text is a lower bound too.
    const pv =
      typeof style['paddingVertical'] === 'number'
        ? (style['paddingVertical'] as number) * 2
        : (typeof style['paddingTop'] === 'number'
            ? (style['paddingTop'] as number)
            : 0) +
          (typeof style['paddingBottom'] === 'number'
            ? (style['paddingBottom'] as number)
            : 0);
    if (pv > 0) {
      const texts = host.findAllByType(Text);
      const lineHeights = texts.map(t => {
        const ts = flat(t.props.style);
        return typeof ts['lineHeight'] === 'number'
          ? (ts['lineHeight'] as number)
          : typeof ts['fontSize'] === 'number'
            ? (ts['fontSize'] as number) * 1.2
            : 0;
      });
      const stackedText = lineHeights.reduce((a, b) => a + b, 0);
      if (stackedText > 0) height = Math.max(height ?? 0, pv + stackedText);
    }
  }
  const slop = pressable.props.hitSlop as
    | number
    | { top?: number; bottom?: number; left?: number; right?: number }
    | undefined;
  const hitSlopY =
    typeof slop === 'number'
      ? slop * 2
      : (slop?.top ?? 0) + (slop?.bottom ?? 0);
  const hitSlopX =
    typeof slop === 'number'
      ? slop * 2
      : (slop?.left ?? 0) + (slop?.right ?? 0);
  return { height, width, hitSlopY, hitSlopX };
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'tab',
  'switch',
  'checkbox',
  'radio',
  'menuitem',
  'togglebutton',
  'adjustable',
  'imagebutton',
  'combobox',
  'spinbutton',
]);

const LEAK_TOKENS = [
  'undefined',
  'null',
  'NaN',
  'Invalid Date',
  '[object Object]',
  'Infinity',
];
const LEAK_EXPONENT = /\d(?:\.\d+)?e[+-]\d+/;

/** Dossier vocabulary ban (docs/APP_STORE_SUBMISSION.md §1.4 + project rules). */
const BANNED_COPY = [
  /\bandroid\b/i,
  /google play/i,
  /guest mode/i,
  /live court/i,
  /\bDUPR\b/,
  /swingvision/i,
  /pb vision/i,
  /selkirk/i,
  /joola/i,
  /\d+(?:\.\d+)?\s?% accura/i,
];

/** Rough glyph advance in em for the truncation ESTIMATE (R6). */
function estimateEm(text: string): number {
  let em = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x0300 && cp <= 0x036f) continue; // combining marks
    if (cp === 0x200d || cp === 0xfe0f || (cp >= 0xe0020 && cp <= 0xe007f))
      continue;
    if (cp >= 0x1f000)
      em += 1.2; // emoji
    else if (
      (cp >= 0x3000 && cp <= 0x9fff) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0xff00 && cp <= 0xffef)
    )
      em += 1; // CJK / fullwidth
    else if (cp >= 0x0600 && cp <= 0x06ff)
      em += 0.55; // Arabic
    else if (cp >= 0x0900 && cp <= 0x0e7f)
      em += 0.6; // Devanagari / Thai
    else if (ch === ' ') em += 0.28;
    else if (/[A-Z]/.test(ch)) em += 0.66;
    else if (/[0-9]/.test(ch)) em += 0.55;
    else em += 0.52;
  }
  return em;
}

interface Issue {
  rule: string;
  status: 'BROKEN' | 'KNOWN' | 'INFERRED';
  detail: string;
  path: string;
  evidence: Record<string, unknown>;
}

interface ControlLedger {
  path: string;
  role: string | undefined;
  label: string;
  testID: string | undefined;
  hitBox: HitBox;
  effectiveHeight: number | null;
}

/**
 * Pre-existing, ledgered failure modes. An issue matching one is recorded as
 * KNOWN so the suite stays green while the campaign still reports it.
 */
const KNOWN_ISSUES: ReadonlyArray<{ rule: string; match: RegExp }> = [
  {
    // HomeScreen.tsx:579-584 — `.toUpperCase()` on a locale-formatted month
    // is locale-insensitive; Turkish dotted İ becomes I ("EKI" for "Eki").
    rule: 'R9',
    match: /tr-TR month uppercase/,
  },
  {
    // HomeScreen.tsx:494 — `formatDuprEstimate` renders "(≈ DUPR n.n)" in the
    // technique summary. Documented product decision (duprEstimate.ts,
    // dossier §2 optional rename item) that still contradicts the
    // "no DUPR in user-facing copy" project rule; ledgered, not fatal.
    rule: 'R7',
    match: /^DUPR$/,
  },
  {
    // repository.ts:237 reads overall_score with a bare Number(); nothing
    // clamps it to the 0–10 contract, so HomeScreen renders a corrupt row
    // verbatim: ≥ 1e21 prints through `.toFixed(1)` (HomeScreen.tsx:451,
    // 460, 490, 608) as exponent notation, ±Number.MAX_VALUE overflows the
    // week average (techniqueDashboard.ts:230/260) to "Infinity" or "NaN",
    // and a non-ISO captured_at prints "Invalid Date" (HomeScreen.tsx:579).
    rule: 'R2',
    match: /exponent|Invalid Date|Infinity|NaN/,
  },
];

function classify(rule: string, detail: string): Issue['status'] {
  return KNOWN_ISSUES.some(k => k.rule === rule && k.match.test(detail))
    ? 'KNOWN'
    : 'BROKEN';
}

type PrunedNode =
  | string
  | { type: string; props?: Record<string, unknown>; children?: PrunedNode[] };

const EVIDENCE_PROPS = [
  'testID',
  'accessibilityRole',
  'accessibilityLabel',
  'accessibilityState',
  'numberOfLines',
  'hitSlop',
] as const;

/** Host tree with styles/handlers stripped — what an a11y inspector shows. */
function pruneTree(
  json: ReturnType<ReactTestRenderer['toJSON']>,
): PrunedNode | PrunedNode[] | null {
  if (json === null) return null;
  if (Array.isArray(json)) return json.map(pruneOne);
  return pruneOne(json);
}

function pruneOne(node: ReactTestRendererJSON): PrunedNode {
  const props: Record<string, unknown> = {};
  for (const key of EVIDENCE_PROPS) {
    const value = node.props[key];
    if (value !== undefined) props[key] = value;
  }
  const style = flat(node.props.style);
  for (const key of ['height', 'minHeight', 'width', 'minWidth'] as const) {
    if (typeof style[key] === 'number') props[`style.${key}`] = style[key];
  }
  const children = (node.children ?? []).map(
    (child: ReactTestRendererJSON | string) =>
      typeof child === 'string' ? child : pruneOne(child),
  );
  return {
    type: node.type,
    ...(Object.keys(props).length ? { props } : {}),
    ...(children.length ? { children } : {}),
  };
}

/** `home` scopes the copy/truncation oracles; `root` scopes the control
 * ledger so the bottom tab bar the user sees on this screen is audited too. */
function auditHome(
  home: Node,
  root: Node,
  s: Scenario,
): { issues: Issue[]; controls: ControlLedger[]; text: string } {
  const issues: Issue[] = [];
  const controls: ControlLedger[] = [];
  const visibleText = textOf(home);

  // R2 — leaks in visible text.
  for (const token of LEAK_TOKENS) {
    if (visibleText.includes(token)) {
      issues.push({
        rule: 'R2',
        status: classify('R2', `text leaks "${token}"`),
        detail: `visible text leaks "${token}"`,
        path: 'HomeScreen',
        evidence: { excerpt: excerptAround(visibleText, token) },
      });
    }
  }
  if (LEAK_EXPONENT.test(visibleText)) {
    issues.push({
      rule: 'R2',
      status: classify('R2', 'exponent'),
      detail: 'visible text renders a score in exponent notation',
      path: 'HomeScreen',
      evidence: { excerpt: visibleText.match(LEAK_EXPONENT)?.[0] },
    });
  }

  // R7 — dossier vocabulary.
  for (const banned of BANNED_COPY) {
    const hit = visibleText.match(banned);
    if (hit) {
      issues.push({
        rule: 'R7',
        status: classify('R7', hit[0]),
        detail: `banned vocabulary "${hit[0]}" in visible copy`,
        path: 'HomeScreen',
        evidence: { excerpt: excerptAround(visibleText, hit[0]) },
      });
    }
  }

  // R3/R4/R5 — every Pressable on the screen (HomeScreen + tab bar).
  const pressables = root.findAll(isPressable);
  for (const p of pressables) {
    const path = componentPath(p);
    const role = p.props.accessibilityRole as string | undefined;
    const ownLabel = p.props.accessibilityLabel as string | undefined;
    const label = (ownLabel ?? textOf(p)).trim();
    const hitBox = hitBoxOf(p);
    const effectiveHeight =
      hitBox.height === null ? null : hitBox.height + hitBox.hitSlopY;
    controls.push({
      path,
      role,
      label,
      testID: p.props.testID as string | undefined,
      hitBox,
      effectiveHeight,
    });
    if (!role || !INTERACTIVE_ROLES.has(role)) {
      issues.push({
        rule: 'R3',
        status: classify('R3', `role ${String(role)}`),
        detail: `interactive element without interactive accessibilityRole (${String(role)})`,
        path,
        evidence: { label, testID: p.props.testID },
      });
    }
    if (!label) {
      issues.push({
        rule: 'R3',
        status: classify('R3', 'unlabeled'),
        detail: 'interactive element has no accessibilityLabel and no text',
        path,
        evidence: { role, testID: p.props.testID },
      });
    }
    for (const token of LEAK_TOKENS) {
      if (label.includes(token)) {
        issues.push({
          rule: 'R2',
          status: classify('R2', `label leaks ${token}`),
          detail: `accessibilityLabel leaks "${token}"`,
          path,
          evidence: { label },
        });
      }
    }
    if (/\s{2,}|^\s|\s[.,]/.test(ownLabel ?? '')) {
      issues.push({
        rule: 'R2',
        status: 'INFERRED',
        detail:
          'accessibilityLabel has empty interpolation (double space / stray punctuation)',
        path,
        evidence: { label: ownLabel },
      });
    }
    if (effectiveHeight === null) {
      issues.push({
        rule: 'R4',
        status: 'INFERRED',
        detail: 'touch box height not determinable from styles (content-sized)',
        path,
        evidence: { label, hitBox },
      });
    } else if (effectiveHeight < 44) {
      issues.push({
        rule: 'R4',
        status: classify('R4', `${path} ${effectiveHeight}`),
        detail: `touch target ${effectiveHeight}pt tall (< 44pt)`,
        path,
        evidence: { label, hitBox, testID: p.props.testID },
      });
    }
    if (hitBox.width !== null && hitBox.width + hitBox.hitSlopX < 44) {
      const style = flat(p.findAll(isHost)[0]?.props.style);
      const horizontal =
        (typeof style['paddingHorizontal'] === 'number'
          ? (style['paddingHorizontal'] as number) * 2
          : 0) + (hitBox.width ?? 0);
      if (horizontal + hitBox.hitSlopX < 44) {
        issues.push({
          rule: 'R4',
          status: classify('R4', `${path} width`),
          detail: `touch target may be ${horizontal + hitBox.hitSlopX}pt wide (< 44pt)`,
          path,
          evidence: { label, hitBox },
        });
      }
    }
    let ancestor = p.parent;
    while (ancestor) {
      if (isPressable(ancestor)) {
        issues.push({
          rule: 'R5',
          status: classify('R5', path),
          detail:
            'interactive element nested inside another interactive element',
          path,
          evidence: { outer: componentPath(ancestor), label },
        });
        break;
      }
      ancestor = ancestor.parent;
    }
  }

  // R6 — probable truncation of single-line texts (INFERRED estimate).
  const contentWidth = s.width - 2 * 24; // styles.content paddingHorizontal space.lg
  for (const t of home.findAllByType(Text)) {
    if (t.props.numberOfLines !== 1) continue;
    const content = textOf(t);
    if (!content) continue;
    const style = flat(t.props.style);
    const fontSize =
      typeof style['fontSize'] === 'number'
        ? (style['fontSize'] as number)
        : 15;
    const estimate = estimateEm(content) * fontSize * s.fontScale;
    // Banner body sits beside a 46pt emblem, a chevron and the streak block.
    const available = contentWidth - 46 - 16 - 84 - 2 * 12;
    if (estimate > available) {
      issues.push({
        rule: 'R6',
        status: 'INFERRED',
        detail: `single-line text likely ellipsised (~${Math.round(estimate)}pt est. > ~${available}pt at ${s.fontScale}× / ${s.width}pt)`,
        path: componentPath(t),
        evidence: {
          text: content.slice(0, 120),
          fontSize,
          fontScale: s.fontScale,
          width: s.width,
        },
      });
    }
  }

  return { issues, controls, text: visibleText };
}

function excerptAround(text: string, token: string): string {
  const at = text.indexOf(token);
  return text.slice(Math.max(0, at - 60), at + token.length + 60);
}

// ─── Render + wait ───────────────────────────────────────────────────────────

const LOADING_LABEL = 'Loading your court…';

async function flush(predicate: () => boolean, ticks = 60) {
  for (let i = 0; i < ticks; i += 1) {
    if (predicate()) return true;
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    });
  }
  return predicate();
}

interface Outcome {
  seed: number;
  scenario: Omit<Scenario, 'seed'>;
  outcome: 'HELD' | 'BROKEN' | 'CRASH';
  durationMs: number;
  issues: Issue[];
  controls: ControlLedger[];
  interactions: Record<string, string>;
  dbOpens: number;
  fetchCalls: number;
  textSample: string;
  locale: { recentDate: string | null; recentTime: string | null };
  /** Host tree of the whole render, kept only for seeds with BROKEN/KNOWN issues. */
  tree?: unknown;
  error?: string;
}

async function runScenario(s: Scenario): Promise<Outcome> {
  const started = realNow();
  const restoreEnv = simulateDeviceEnvironment(s);
  if (!mockSqlite.db) mockSqlite.db = new DatabaseSync(':memory:');
  else wipeRows(mockSqlite.db);
  mockSqlite.opens = 0;
  fetchCalls.length = 0;
  schedulerDouble.applied = 0;
  let renderer: ReactTestRenderer | null = null;
  const interactions: Record<string, string> = {};
  try {
    // Fresh module-level state for the real stores (same process, so the
    // real `getDb()` singleton is reset through isolateModules-free means:
    // the op-sqlite double swaps the underlying database per scenario).
    setActiveDataOwner(GUEST_DATA_OWNER);
    const db = getDb();
    await seedDatabase(s, db);
    await useAppStore.getState().hydrate();
    if (s.notificationCard) {
      await useNotificationStore
        .getState()
        .hydrate({ scheduler: schedulerDouble });
    } else {
      useNotificationStore.setState({ hydrated: false });
    }
    await useConsistencyStore.getState().hydrate();

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await act(async () => {
      renderer = TestRenderer.create(
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: s.width, height: 852 },
            insets: { top: 59, left: 0, right: 0, bottom: 34 },
          }}
        >
          <QueryClientProvider client={queryClient}>
            <RootNavigator />
          </QueryClientProvider>
        </SafeAreaProvider>,
      );
    });
    const r = renderer as unknown as ReactTestRenderer;
    const home = () => r.root.findAllByType(HomeScreen)[0] ?? null;
    const loadedNow = () => {
      const h = home();
      return !!h && !textOf(h).includes(LOADING_LABEL);
    };
    const loaded = await flush(loadedNow);
    const homeNode = home();
    if (!loaded || !homeNode) {
      return {
        seed: s.seed,
        scenario: stripSeed(s),
        outcome: 'BROKEN',
        durationMs: realNow() - started,
        issues: [
          {
            rule: 'R1',
            status: 'BROKEN',
            detail: homeNode
              ? 'HomeScreen never left the loading state'
              : 'HomeScreen not mounted',
            path: 'RootNavigator',
            evidence: { text: r.root ? textOf(r.root).slice(0, 400) : '' },
          },
        ],
        controls: [],
        interactions,
        dbOpens: mockSqlite.opens,
        fetchCalls: fetchCalls.length,
        textSample: '',
        locale: { recentDate: null, recentTime: null },
      };
    }

    if (s.streakInject !== null) {
      // Injected extreme (never engine-produced) streak values.
      const snapshot = useConsistencyStore.getState().snapshot;
      await act(async () => {
        useConsistencyStore.setState({
          snapshot: snapshot
            ? { ...snapshot, currentStreak: s.streakInject as number }
            : null,
        });
      });
    }

    const audit = auditHome(homeNode, r.root, s);
    const issues = [...audit.issues];
    // Rendered-tree evidence is captured BEFORE the interaction probes so it
    // shows the HomeScreen as audited, not the screen a probe navigated to.
    const treeAtAudit = pruneTree(r.toJSON());

    // R1 — error state is a failure unless a rogue row legitimately broke it.
    if (audit.text.includes('Your court couldn’t load')) {
      issues.push({
        rule: 'R1',
        status: classify('R1', 'error state'),
        detail: 'HomeScreen rendered its ErrorState',
        path: 'HomeScreen > ErrorState',
        evidence: { text: audit.text.slice(0, 300) },
      });
    }

    // R9 — locale/tz: the newest recent card's date/time strings.
    const recentCards = homeNode
      .findAll(isPressable)
      .filter(p =>
        String(p.props.accessibilityLabel ?? '').startsWith('Open '),
      );
    let recentDate: string | null = null;
    let recentTime: string | null = null;
    const firstCard = recentCards[0];
    if (firstCard) {
      const texts = firstCard.findAllByType(Text).map(textOf);
      recentDate = texts[0] ?? null;
      recentTime = texts[2] ?? null;
      const recentRow = (mockSqlite.db
        .prepare(
          `SELECT captured_at FROM local_shot WHERE owner_key = ? ORDER BY captured_at DESC LIMIT 1`,
        )
        .all(GUEST_DATA_OWNER)[0] ?? {})['captured_at'];
      const parsed = new Date(String(recentRow));
      if (!Number.isNaN(parsed.getTime()) && recentDate) {
        const expectedDate = parsed.toLocaleDateString(s.locale, {
          month: 'short',
          day: 'numeric',
        });
        const expectedUpper = expectedDate.toLocaleUpperCase(s.locale);
        if (recentDate !== expectedDate.toUpperCase()) {
          issues.push({
            rule: 'R9',
            status: 'BROKEN',
            detail: `recent-read date "${recentDate}" does not follow device locale/tz (expected "${expectedDate.toUpperCase()}")`,
            path: 'HomeScreen > recentDate',
            evidence: {
              recentDate,
              expectedDate,
              locale: s.locale,
              timeZone: s.timeZone,
            },
          });
        } else if (recentDate !== expectedUpper) {
          issues.push({
            rule: 'R9',
            status: classify('R9', `${s.locale} month uppercase`),
            detail: `${s.locale} month uppercase: rendered "${recentDate}" but locale-correct uppercase is "${expectedUpper}"`,
            path: 'HomeScreen > recentDate',
            evidence: {
              recentDate,
              expectedUpper,
              capturedAt: recentRow,
              timeZone: s.timeZone,
            },
          });
        }
      }
    }

    // R8 — real interactions through the real navigator and stores.
    if (s.interactions) {
      const byTestId = (id: string) =>
        homeNode.findAll(isPressable).find(p => p.props.testID === id) ?? null;
      const readsTab = byTestId('home-week-chart-reads');
      if (readsTab) {
        await act(async () => {
          (readsTab.props.onPress as () => void)();
        });
        await flush(() => false, 4);
        const persisted = await getKv(db, WEEK_CHART_KV_KEY);
        const selected = (
          byTestId('home-week-chart-reads')?.props.accessibilityState as
            { selected?: boolean } | undefined
        )?.selected;
        interactions['chart-tab-reads'] =
          persisted === 'reads' && selected === true
            ? 'HELD'
            : `BROKEN kv=${String(persisted)} selected=${String(selected)}`;
        if (interactions['chart-tab-reads'] !== 'HELD') {
          issues.push({
            rule: 'R8',
            status: 'BROKEN',
            detail: `chart tab press did not persist/select (${interactions['chart-tab-reads']})`,
            path: 'HomeScreen > chart tab',
            evidence: { persisted, selected },
          });
        }
      }
      const firstRecent = recentCards[0];
      if (firstRecent) {
        await act(async () => {
          (firstRecent.props.onPress as () => void)();
        });
        const resultMounted = () =>
          r.root.findAll(
            n =>
              typeof n.type === 'function' &&
              /^ResultScreen$/.test(n.type.name),
          );
        await flush(() => resultMounted().length > 0, 20);
        const routes = resultMounted();
        interactions['recent-card'] =
          routes.length > 0 ? 'HELD' : 'BROKEN Result route not mounted';
        if (routes.length === 0) {
          issues.push({
            rule: 'R8',
            status: 'BROKEN',
            detail: 'pressing a recent read did not mount the Result route',
            path: 'HomeScreen > recent card',
            evidence: { label: firstRecent.props.accessibilityLabel },
          });
        }
      } else {
        const badge = byTestId('home-streak-badge');
        if (badge) {
          await act(async () => {
            (badge.props.onPress as () => void)();
          });
          await flush(
            () =>
              r.root.findAll(
                n =>
                  typeof n.type === 'function' &&
                  /StreakCalendarScreen/.test(n.type.name),
              ).length > 0,
            20,
          );
          const mounted = r.root.findAll(
            n =>
              typeof n.type === 'function' &&
              /StreakCalendarScreen/.test(n.type.name),
          );
          interactions['streak-badge'] =
            mounted.length > 0 ? 'HELD' : 'BROKEN StreakCalendar not mounted';
          if (mounted.length === 0) {
            issues.push({
              rule: 'R8',
              status: 'BROKEN',
              detail: 'pressing the streak badge did not mount StreakCalendar',
              path: 'HomeScreen > streak badge',
              evidence: {},
            });
          }
        }
      }
    }

    const broken = issues.some(i => i.status === 'BROKEN');
    const keepTree = issues.some(i => i.status !== 'INFERRED');
    return {
      seed: s.seed,
      scenario: stripSeed(s),
      outcome: broken ? 'BROKEN' : 'HELD',
      durationMs: realNow() - started,
      ...(keepTree ? { tree: treeAtAudit } : {}),
      issues,
      controls: audit.controls,
      interactions,
      dbOpens: mockSqlite.opens,
      fetchCalls: fetchCalls.length,
      textSample: audit.text.slice(0, 600),
      locale: { recentDate, recentTime },
    };
  } catch (error) {
    return {
      seed: s.seed,
      scenario: stripSeed(s),
      outcome: 'CRASH',
      durationMs: realNow() - started,
      issues: [
        {
          rule: 'R1',
          status: 'BROKEN',
          detail: `render/seed threw: ${error instanceof Error ? error.message : String(error)}`,
          path: 'RootNavigator',
          evidence: {
            stack:
              error instanceof Error
                ? (error.stack ?? '').split('\n').slice(0, 8)
                : [],
          },
        },
      ],
      controls: [],
      interactions,
      dbOpens: mockSqlite.opens,
      fetchCalls: fetchCalls.length,
      textSample: '',
      locale: { recentDate: null, recentTime: null },
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (renderer) {
      await act(async () => {
        (renderer as unknown as ReactTestRenderer).unmount();
      });
    }
    // Reset the real stores between variants (their hydrate() re-reads SQLite).
    useAppStore.setState({ hydrated: false, profile: null, ownerKey: null });
    useConsistencyStore.setState({ snapshot: null });
    useNotificationStore.setState({ hydrated: false });
    restoreEnv();
  }
}

function stripSeed(s: Scenario): Omit<Scenario, 'seed'> {
  const rest: Partial<Scenario> = { ...s };
  delete rest.seed;
  return rest as Omit<Scenario, 'seed'>;
}

// ─── Campaign ────────────────────────────────────────────────────────────────

const BASE_SEED = Number(process.env.STRESS_SEED ?? 20260904);
const ITER = Number(process.env.STRESS_ITER ?? 12);
const REPEAT = Math.max(1, Number(process.env.STRESS_REPEAT ?? 1));
const ONLY = (process.env.STRESS_ONLY ?? '')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean)
  .map(Number);
const OUT_DIR =
  process.env.STRESS_OUT ??
  nodePath.resolve(
    __dirname,
    '../../../../artifacts/stress/scr-homescreen-boundary-i18n-a11y',
  );

const SEEDS: number[] = ONLY.length
  ? ONLY
  : Array.from({ length: ITER }, (_, i) => BASE_SEED + i);

const outcomes: Outcome[] = [];

describe('HomeScreen boundary/i18n/a11y stress (real navigator + real SQLite)', () => {
  const cases = SEEDS.flatMap(seed =>
    Array.from({ length: REPEAT }, (_, rep) => [seed, rep] as const),
  );

  it.each(cases)('seed %i (rep %i) holds every oracle', async seed => {
    const scenario = deriveScenario(seed);
    const outcome = await runScenario(scenario);
    outcomes.push(outcome);
    const broken = outcome.issues.filter(i => i.status === 'BROKEN');
    if (broken.length) {
      throw new Error(
        `seed ${seed} BROKEN (${JSON.stringify(scenario)}):\n` +
          broken
            .map(
              i =>
                `  [${i.rule}] ${i.detail} @ ${i.path}\n    ${JSON.stringify(i.evidence)}`,
            )
            .join('\n'),
      );
    }
  });

  afterAll(() => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const table = outcomes.map(o => ({
      seed: o.seed,
      outcome: o.outcome,
      durationMs: Math.round(o.durationMs),
      locale: o.scenario.locale,
      timeZone: o.scenario.timeZone,
      clock: o.scenario.clock,
      fontScale: o.scenario.fontScale,
      width: o.scenario.width,
      rtl: o.scenario.rtl,
      profile: o.scenario.profile,
      realShots: o.scenario.realShots,
      rogueShots: o.scenario.rogueShots.length,
      streakInject: o.scenario.streakInject,
      notificationCard: o.scenario.notificationCard,
      controls: o.controls.length,
      broken: o.issues
        .filter(i => i.status === 'BROKEN')
        .map(i => `[${i.rule}] ${i.detail}`),
      known: o.issues
        .filter(i => i.status === 'KNOWN')
        .map(i => `[${i.rule}] ${i.detail}`),
      inferred: o.issues.filter(i => i.status === 'INFERRED').length,
      interactions: o.interactions,
      recentDate: o.locale.recentDate,
      recentTime: o.locale.recentTime,
      error: o.error ?? null,
    }));
    const summary = {
      suite: 'homeScreen.boundaryI18nA11y.stress',
      baseSeed: BASE_SEED,
      iterations: SEEDS.length,
      repeat: REPEAT,
      executed: outcomes.length,
      held: outcomes.filter(o => o.outcome === 'HELD').length,
      broken: outcomes.filter(o => o.outcome === 'BROKEN').length,
      crashed: outcomes.filter(o => o.outcome === 'CRASH').length,
      knownIssueSeeds: outcomes
        .filter(o => o.issues.some(i => i.status === 'KNOWN'))
        .map(o => o.seed),
      coverage: {
        locales: [...new Set(outcomes.map(o => o.scenario.locale))].sort(),
        timeZones: [...new Set(outcomes.map(o => o.scenario.timeZone))].sort(),
        clocks: [...new Set(outcomes.map(o => o.scenario.clock))].sort(),
        fontScales: [
          ...new Set(outcomes.map(o => o.scenario.fontScale)),
        ].sort(),
        widths: [...new Set(outcomes.map(o => o.scenario.width))].sort(),
        nameIds: [
          ...new Set(
            outcomes.map(o =>
              o.scenario.profile.kind === 'profile'
                ? o.scenario.profile.nameId
                : 'none',
            ),
          ),
        ].sort(),
      },
      controlsPerVariant: {
        min: Math.min(...outcomes.map(o => o.controls.length)),
        max: Math.max(...outcomes.map(o => o.controls.length)),
      },
      generatedAt: stamp,
    };
    fs.writeFileSync(
      nodePath.join(OUT_DIR, `results-${stamp}.json`),
      JSON.stringify({ summary, table }, null, 2),
    );
    fs.writeFileSync(
      nodePath.join(OUT_DIR, `evidence-${stamp}.json`),
      JSON.stringify(outcomes, null, 2),
    );
    fs.writeFileSync(
      nodePath.join(OUT_DIR, 'latest.json'),
      JSON.stringify({ summary, table }, null, 2),
    );
  });
});
