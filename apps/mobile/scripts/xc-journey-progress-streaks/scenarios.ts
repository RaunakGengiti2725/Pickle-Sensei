import {
  DST_ZONES,
  addDaysToKey,
  localDayOf,
  makeRng,
  resolveWallClock,
  transitionsIn,
  wallClock,
  type Rng,
  type Zone,
} from './oracle';

export type ActivityMix = 'none' | 'single' | 'consecutive' | 'gappy' | 'many';

export type AsOfVariant =
  | 'last-day-random'
  | 'last-day-00:00:00.000'
  | 'last-day-23:59:59.999'
  | 'next-day-00:00:00.000'
  | 'next-day-00:00:00.001'
  | 'two-days-later-00:00:00.000'
  | 'seven-days-later-noon';

export interface GeneratedActivity {
  /** Wall-clock day the activity was generated on (the expected local day). */
  localDay: string;
  /** Wall-clock label, for replay readability. */
  wallClock: string;
  atIso: string;
  /** 'ambiguous-a'/'ambiguous-b' for the two instants of a fall-back hour. */
  resolution: 'unique' | 'ambiguous-a' | 'ambiguous-b';
  kind: 'stroke' | 'session_stroke' | 'drill';
  score: number | null;
  shotType: string;
}

export interface Scenario {
  zone: Zone;
  seed: number;
  mix: ActivityMix;
  anchorDay: string;
  windowDays: number;
  asOfVariant: AsOfVariant;
  asOfIso: string;
  asOfWallClock: string;
  /** Wall-clock times that fell into a spring-forward gap and were skipped. */
  skippedGapWallClocks: string[];
  activities: GeneratedActivity[];
}

const BOUNDARY_TIMES: ReadonlyArray<[number, number, number, number]> = [
  [0, 0, 0, 0],
  [0, 0, 0, 1],
  [0, 0, 0, 999],
  [0, 59, 59, 999],
  [1, 30, 0, 0],
  [2, 30, 0, 0],
  [3, 0, 0, 0],
  [12, 0, 0, 0],
  [22, 59, 59, 999],
  [23, 0, 0, 0],
  [23, 59, 59, 0],
  [23, 59, 59, 999],
];

const SHOT_TYPES = [
  'serve',
  'dink',
  'third_shot_drop',
  'forehand_drive',
  'backhand_drive',
  'overhead',
  'volley',
  'reset',
];

const anchorCache = new Map<Zone, string[]>();

/** Candidate anchor days for a zone: around DST transitions when there are
 * any, plus the year boundary, plus a plain mid-year week. */
export function anchorDaysFor(zone: Zone): string[] {
  const cached = anchorCache.get(zone);
  if (cached) return cached;
  const anchors = new Set<string>([
    '2025-12-29',
    '2026-01-01',
    '2026-02-26',
    '2026-06-15',
    '2028-02-27', // leap day window
  ]);
  if (DST_ZONES.includes(zone)) {
    for (const transition of transitionsIn(zone, 2026)) {
      const day = localDayOf(transition, zone);
      anchors.add(addDaysToKey(day, -5));
      anchors.add(addDaysToKey(day, -1));
      anchors.add(day);
    }
  }
  const result = [...anchors].sort();
  anchorCache.set(zone, result);
  return result;
}

export function scenarioCounts(mix: ActivityMix, rng: Rng): number {
  switch (mix) {
    case 'none':
      return 0;
    case 'single':
      return 1;
    case 'many':
      return rng.int(8, 60);
    default:
      return rng.int(1, 4);
  }
}

function pickTime(rng: Rng): [number, number, number, number] {
  if (rng.chance(0.6)) return rng.pick(BOUNDARY_TIMES);
  return [rng.int(0, 23), rng.int(0, 59), rng.int(0, 59), rng.int(0, 999)];
}

function asOfFor(
  variant: AsOfVariant,
  lastDay: string,
  zone: Zone,
  rng: Rng,
): { iso: string; wall: string } {
  const resolveOrShift = (
    day: string,
    h: number,
    mi: number,
    s: number,
    ms: number,
  ): { iso: string; wall: string } => {
    let resolution = resolveWallClock(wallClock(day, h, mi, s, ms), zone);
    let hour = h;
    // A midnight that does not exist (zones shifting at 00:00) — use the
    // first existing minute of the day instead, which is still "day start".
    while (resolution.kind === 'gap' && hour < 23) {
      hour += 1;
      resolution = resolveWallClock(wallClock(day, hour, mi, s, ms), zone);
    }
    if (resolution.kind === 'gap') throw new Error('unresolvable asOf');
    const instant = resolution.instants[0]!;
    return {
      iso: new Date(instant).toISOString(),
      wall: `${day}T${String(hour).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')} ${zone}`,
    };
  };
  switch (variant) {
    case 'last-day-random': {
      const [h, mi, s, ms] = pickTime(rng);
      return resolveOrShift(lastDay, h, mi, s, ms);
    }
    case 'last-day-00:00:00.000':
      return resolveOrShift(lastDay, 0, 0, 0, 0);
    case 'last-day-23:59:59.999':
      return resolveOrShift(lastDay, 23, 59, 59, 999);
    case 'next-day-00:00:00.000':
      return resolveOrShift(addDaysToKey(lastDay, 1), 0, 0, 0, 0);
    case 'next-day-00:00:00.001':
      return resolveOrShift(addDaysToKey(lastDay, 1), 0, 0, 0, 1);
    case 'two-days-later-00:00:00.000':
      return resolveOrShift(addDaysToKey(lastDay, 2), 0, 0, 0, 0);
    case 'seven-days-later-noon':
      return resolveOrShift(addDaysToKey(lastDay, 7), 12, 0, 0, 0);
  }
}

export const AS_OF_VARIANTS: readonly AsOfVariant[] = [
  'last-day-random',
  'last-day-00:00:00.000',
  'last-day-23:59:59.999',
  'next-day-00:00:00.000',
  'next-day-00:00:00.001',
  'two-days-later-00:00:00.000',
  'seven-days-later-noon',
];

export const MIXES: readonly ActivityMix[] = [
  'none',
  'single',
  'consecutive',
  'gappy',
  'many',
];

export function generateScenario(zone: Zone, seed: number): Scenario {
  const rng = makeRng(seed);
  const mix = rng.pick(MIXES);
  const anchorDay = rng.pick(anchorDaysFor(zone));
  const windowDays = mix === 'none' ? 0 : mix === 'single' ? 1 : rng.int(2, 24);
  const asOfVariant = rng.pick(AS_OF_VARIANTS);
  const activities: GeneratedActivity[] = [];
  const skipped: string[] = [];

  for (let offset = 0; offset < windowDays; offset += 1) {
    const day = addDaysToKey(anchorDay, offset);
    const trained =
      mix === 'gappy'
        ? rng.chance(0.55)
        : mix === 'consecutive' || mix === 'many' || mix === 'single';
    if (!trained) continue;
    const count = scenarioCounts(mix, rng);
    let placed = 0;
    let attempts = 0;
    while (placed < count && attempts < count * 4) {
      attempts += 1;
      const [h, mi, s, ms] = pickTime(rng);
      const wc = wallClock(day, h, mi, s, ms);
      const label = `${day}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
      const resolution = resolveWallClock(wc, zone);
      if (resolution.kind === 'gap') {
        skipped.push(label);
        continue;
      }
      const kind = rng.pick(['stroke', 'session_stroke', 'drill'] as const);
      const shotType = rng.pick(SHOT_TYPES);
      const score =
        kind === 'drill' || rng.chance(0.2) ? null : rng.int(30, 95) / 10;
      const instants = resolution.instants as readonly number[];
      instants.forEach((instant, index) => {
        if (placed >= count) return;
        activities.push({
          localDay: day,
          wallClock: label,
          atIso: new Date(instant).toISOString(),
          resolution:
            resolution.kind === 'unique'
              ? 'unique'
              : index === 0
                ? 'ambiguous-a'
                : 'ambiguous-b',
          kind,
          score,
          shotType,
        });
        placed += 1;
      });
    }
    if (placed === 0) {
      // Never leave a "trained" day empty: noon always exists.
      const noon = resolveWallClock(wallClock(day, 12), zone);
      activities.push({
        localDay: day,
        wallClock: `${day}T12:00:00.000`,
        atIso: new Date(noon.instants[0]!).toISOString(),
        resolution: 'unique',
        kind: 'stroke',
        score: 6.5,
        shotType: 'serve',
      });
    }
  }

  const lastDay = addDaysToKey(anchorDay, Math.max(0, windowDays - 1));
  const asOf = asOfFor(asOfVariant, lastDay, zone, rng);
  return {
    zone,
    seed,
    mix,
    anchorDay,
    windowDays,
    asOfVariant,
    asOfIso: asOf.iso,
    asOfWallClock: asOf.wall,
    skippedGapWallClocks: skipped,
    activities,
  };
}
