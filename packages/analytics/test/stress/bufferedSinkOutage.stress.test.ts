/**
 * BufferedAnalytics buffer bound while the transport is DOWN.
 *
 * `track()` auto-flushes at `maxBuffer`; `flush()` re-buffers a failed batch
 * as `[...batch.slice(-maxBuffer), ...buffer]`. The slice bounds one BATCH,
 * not the buffer: while a long-lived service keeps tracking during an
 * outage, every `maxBuffer` events start another failing flush whose batch
 * is re-added, so `pendingCount()` grows linearly with events tracked until
 * something calls `flush()` explicitly — which then re-sends the whole pile
 * as one batch and, on failure, keeps only the last `maxBuffer`.
 *
 * These cases FAIL on the current implementation; they document the growth
 * found by the long-run-leak stress lens (seeded rows in
 * `<STRESS_OUT>.outage-growth.json`) and become the regression pin once the
 * bound is enforced on the buffer itself.
 *
 *   STRESS_ITER=600 STRESS_OUT=/tmp/x.json pnpm --filter @pickle/analytics test -- outage
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { outageGrowthProbe, type OutageGrowthRow } from "./campaign.js";
import { iterationSeed } from "./seededRng.js";

const ROWS = Number(process.env["STRESS_ITER"] ?? "25");
const CAMPAIGN_SEED = Number(process.env["STRESS_SEED"] ?? "20260905");
const OUT = process.env["STRESS_OUT"];

describe("BufferedAnalytics under a transport outage (no explicit flush)", () => {
  it(`keeps pendingCount() <= maxBuffer across ${ROWS} seeded outages`, async () => {
    const rows: OutageGrowthRow[] = [];
    for (let i = 1; i <= ROWS; i++) {
      rows.push(await outageGrowthProbe(iterationSeed(CAMPAIGN_SEED, 50_000 + i)));
    }
    if (OUT) {
      mkdirSync(dirname(OUT), { recursive: true });
      writeFileSync(
        OUT.replace(/\.json$/, "") + ".outage-growth.json",
        JSON.stringify(rows, null, 2),
      );
    }
    const overBound = rows.filter((r) => r.pendingAfterOutage > r.maxBuffer);
    expect(
      overBound.map(
        (r) =>
          `seed=${r.seed} maxBuffer=${r.maxBuffer} tracked=${r.tracked} pending=${r.pendingAfterOutage}`,
      ),
    ).toEqual([]);
  });

  it("minimal repro: maxBuffer=1, 40 events tracked while down → pending must be 1", async () => {
    const row = await outageGrowthProbe(iterationSeed(CAMPAIGN_SEED, 50_001), {
      maxBuffer: 1,
      multiples: 40,
    });
    expect(row.tracked).toBe(40);
    expect(row.pendingAfterExplicitFlush).toBeLessThanOrEqual(1);
    expect(row.pendingAfterOutage, JSON.stringify(row)).toBeLessThanOrEqual(1);
  });
});
