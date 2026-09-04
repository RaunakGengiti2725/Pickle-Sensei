/**
 * ADJ-04 adversarial (candidate 3dd83f33): the new ModelRegistry.resolve()
 * throws AmbiguousModelResolutionError whenever more than one PRODUCTION
 * entry matches a query. A manifest with per-stroke production scorers
 * (dink scorer + serve scorer — the "per-stroke scorer release gate" that
 * providers.ts documents) is VALID at construction (disjoint stroke
 * coverage), but the AUTO DETECT path calls
 * `registry.resolve({ task: 'technique_scoring', platform })` with NO stroke
 * (providers.ts:161-163), so both scorers match and resolve() throws.
 *
 * createFusionProviders() is typed to return {kind:'real'}|{kind:'unavailable'}
 * and runCaptureAnalysis() (runCaptureAnalysis.ts:250) calls it without a
 * try/catch; sessionNative.ts:214 always runs with declaredStroke: null.
 * On 4d812e1a the same manifest resolves silently (wrong but no throw).
 *
 * The shipped DEFAULT_MODEL_MANIFEST has a single "all"-strokes scorer, so
 * this is latent today; it fires on the first per-stroke scorer promotion.
 */
import type { ModelManifest, ModelManifestEntry } from '@pickle/model-registry';

jest.mock('@pickle/model-registry', () => {
  const actual = jest.requireActual<typeof import('@pickle/model-registry')>(
    '@pickle/model-registry',
  );
  const base = actual.DEFAULT_MODEL_MANIFEST as ModelManifest;
  const scorer = base.entries.find(
    (entry: ModelManifestEntry) =>
      entry.task === 'technique_scoring' &&
      entry.deploymentStatus === 'production',
  )!;
  const perStroke: ModelManifest = {
    ...base,
    entries: [
      ...base.entries.filter(entry => entry !== scorer),
      { ...scorer, id: 'scorer.dink', supportedStrokes: ['dink'] },
      { ...scorer, id: 'scorer.serve', supportedStrokes: ['serve'] },
    ],
  };
  return { ...actual, DEFAULT_MODEL_MANIFEST: perStroke };
});

describe('ADJ-04 attack: AUTO DETECT with per-stroke production scorers', () => {
  it('the per-stroke manifest is accepted by the registry (precondition)', () => {
    const { ModelRegistry, DEFAULT_MODEL_MANIFEST } = jest.requireMock<
      typeof import('@pickle/model-registry')
    >('@pickle/model-registry');
    expect(() => new ModelRegistry(DEFAULT_MODEL_MANIFEST)).not.toThrow();
  });

  it('createFusionProviders(null) returns an availability result instead of throwing', () => {
    const { createFusionProviders } = jest.requireActual<
      typeof import('../src/vision/providers')
    >('../src/vision/providers');
    let outcome: ReturnType<typeof createFusionProviders> | undefined;
    let thrown: unknown = null;
    try {
      outcome = createFusionProviders(null);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeNull();
    expect(outcome === undefined ? null : outcome.kind).toMatch(
      /^(real|unavailable)$/,
    );
  });

  it('a declared stroke still resolves its own scorer (control)', () => {
    const { createFusionProviders } = jest.requireActual<
      typeof import('../src/vision/providers')
    >('../src/vision/providers');
    expect(() => createFusionProviders('dink')).not.toThrow();
    expect(() => createFusionProviders('serve')).not.toThrow();
  });
});
