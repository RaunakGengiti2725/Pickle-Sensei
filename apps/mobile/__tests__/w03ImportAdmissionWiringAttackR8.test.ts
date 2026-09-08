import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * W03-01 adversary, round 8 (candidate 806d511b) — wiring pins.
 *
 * The rotation / codec / track-layout rules of `admitImportedMedia` only run
 * when the caller passes an `ImportedMediaProbe`. These static pins ask
 * whether any shipping call site does, and whether the session-less legacy
 * entry point in AnalyzeScreen admits the container before it spends the
 * native extraction pass. Same technique as the repo's `__wf__` static pins:
 * the source is the evidence.
 */

const MOBILE_SRC = join(__dirname, '..', 'src');

function source(relative: string): string {
  return readFileSync(join(MOBILE_SRC, relative), 'utf8');
}

describe('ATTACK 11 — rotation / codec / track-layout rules are reachable from the shipping path', () => {
  it('runCaptureAnalysis passes a media probe to admitImportedMedia at least once', () => {
    const text = source('analysis/runCaptureAnalysis.ts');
    const calls = text.match(/admitImportedMedia\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    const withProbe = calls.filter(
      call => !/admitImportedMedia\(\s*clip\s*\)/.test(call),
    );
    expect(withProbe.length).toBeGreaterThan(0);
  });

  it('the imported clip record carries the probed container facts (rotation, codec, track count)', () => {
    const text = source('camera/capture.ts');
    expect(text).toMatch(/rotationDegrees/);
    expect(text).toMatch(/videoTrackCount/);
  });
});

describe('ATTACK 12 — the session-less legacy entry point spends extraction before any admission', () => {
  it('AnalyzeScreen admits the container envelope before extractImportedPoseSequence', () => {
    const text = source('screens/AnalyzeScreen.tsx');
    const extractionAt = text.indexOf('extractImportedPoseSequence(');
    expect(extractionAt).toBeGreaterThan(-1);
    const admissionAt = text.indexOf('admitImportedMedia(');
    expect(admissionAt).toBeGreaterThan(-1);
    expect(admissionAt).toBeLessThan(extractionAt);
  });
});
