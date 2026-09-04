/**
 * Replay one seed (or a list) N times and report the failure rate per invariant.
 *
 *   cd packages/analytics && npx tsx test/stress/replay.ts guard:20260915 drift:21260906 --times 10 [--max-string 65536] [--out file.json]
 *
 * (tsx is not a dependency of this package; any tsx 4.x in the workspace store works.)
 */
import { writeFileSync } from "node:fs";
import { runIteration, type Row, type Unit } from "./campaign.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const times = Number(flag("--times") ?? 10);
const maxString = Number(flag("--max-string") ?? 65536);
const out = flag("--out");
const targets = args.filter((a) => /^(guard|drift|cost):\d+$/.test(a));

if (targets.length === 0) {
  console.error(
    "usage: replay.ts <unit>:<seed> [...] [--times N] [--max-string N] [--out file.json]",
  );
  process.exit(2);
}

interface Replay {
  unit: Unit;
  seed: number;
  runs: number;
  invariants: Record<
    string,
    { broken: number; held: number; info: number; rate: number; sampleDetail: string }
  >;
  deterministic: boolean;
}

const replays: Replay[] = [];
for (const target of targets) {
  const [unitRaw, seedRaw] = target.split(":");
  const unit = unitRaw as Unit;
  const seed = Number(seedRaw);
  const invariants: Replay["invariants"] = {};
  let firstStable: string | null = null;
  let deterministic = true;
  for (let i = 0; i < times; i++) {
    const rows: Row[] = runIteration(unit, seed, maxString);
    const stable = JSON.stringify(rows.map(({ ms: _ms, ...r }) => r));
    if (firstStable === null) firstStable = stable;
    else if (stable !== firstStable) deterministic = false;
    for (const row of rows) {
      const slot = (invariants[row.invariant] ??= {
        broken: 0,
        held: 0,
        info: 0,
        rate: 0,
        sampleDetail: row.detail,
      });
      if (row.outcome === "BROKEN") slot.broken++;
      else if (row.outcome === "HELD") slot.held++;
      else slot.info++;
    }
  }
  for (const slot of Object.values(invariants)) slot.rate = slot.broken / times;
  replays.push({ unit, seed, runs: times, invariants, deterministic });
}

const report = { generatedAt: new Date().toISOString(), maxString, replays };
if (out) writeFileSync(out, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
