/**
 * Static code-health ratchet for the shipping app (App.tsx + src/**).
 *
 * `scripts/staticHealth` builds a full TypeScript program of apps/mobile and
 * reports, per production file: TODO/FIXME markers, empty and error-dropping
 * catches, swallowed rejections, `as any` / double casts / non-null
 * assertions, floating and unguarded voided promises, timers/subscriptions
 * without cleanup, unbounded and self-rescheduling loops, exports nothing
 * reachable from index.js imports (ts-prune style, symbol-based), modules
 * unreachable from the Metro entry, and constant/platform/__DEV__ branches.
 *
 * Every finding has a line-independent fingerprint. `baseline.json` lists
 * the fingerprints accepted on 4d812e1a; this suite fails on any NEW
 * fingerprint so debt only ratchets down. To accept a deliberate addition
 * (or drop paid-down entries), regenerate the file:
 *
 *   cd apps/mobile && npx tsc -p scripts/staticHealth/tsconfig.build.json \
 *     && node build/static-health/scan.js --out /tmp/static-health \
 *     && cp /tmp/static-health/baseline.json scripts/staticHealth/baseline.json
 */
import baselineJson from '../scripts/staticHealth/baseline.json';
import {
  diffAgainstBaseline,
  runScan,
  type Baseline,
} from '../scripts/staticHealth/scan';

const baseline = baselineJson as Baseline;

describe('apps/mobile static health ratchet', () => {
  const report = runScan();

  it('scans the whole shipping app (guards against a vacuous pass)', () => {
    expect(report.files.production).toBeGreaterThanOrEqual(100);
    expect(report.findings.length).toBeGreaterThan(0);
    // Fingerprints are the ratchet's identity: they must be unique.
    const fps = report.findings.map(f => f.fingerprint);
    expect(new Set(fps).size).toBe(fps.length);
  });

  it('baseline.json is sorted and free of duplicates', () => {
    expect(baseline.schemaVersion).toBe(1);
    const sorted = [...new Set(baseline.fingerprints)].sort();
    expect(baseline.fingerprints).toEqual(sorted);
  });

  it('introduces no static-health finding beyond the accepted baseline', () => {
    const { added } = diffAgainstBaseline(report, baseline);
    const describe = added.map(
      f => `${f.category}  ${f.file}:${f.line}  ${f.message}\n    ${f.snippet}`,
    );
    expect(describe).toEqual([]);
  });
});
