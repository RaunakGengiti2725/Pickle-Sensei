/**
 * Adjudication repro — cluster `mobile-design-components-walkthrough::C1`.
 *
 * "DUPR" is a third-party trademark and is banned from every user-facing
 * string (docs/APP_STORE_SUBMISSION.md §1.4 / §2, REVIEW.md "Launch flow &
 * copy"). The technique-to-match-rating estimate stays, disclaimed, under a
 * neutral label. This suite pins the ban at two layers: the rendered
 * PlayerRankCard (visible text AND accessibility labels — VoiceOver reads
 * those verbatim) and a static scan of every shipped mobile source file, so
 * a Settings/Progress/Result footnote or a comment cannot reintroduce it.
 */
import React from 'react';
import { Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => null,
}));

jest.mock('../../src/progress/rankCelebration', () => {
  const state = { maybeCelebrate: async () => {} };
  return {
    useRankCelebrationStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});

import { PlayerRankCard } from '../../src/components/PlayerRankCard';
import type { RealAnalysisFact } from '../../src/data/repository';

// Node built-ins for the static source scan. The mobile tsconfig excludes
// node typings (see be-mobile-sync-outbox.test.ts), so shims stay local.
declare const require: (id: string) => unknown;
declare const __dirname: string;
const { readdirSync, readFileSync, statSync } = require('fs') as {
  readdirSync: (path: string) => string[];
  readFileSync: (path: string, encoding: 'utf8') => string;
  statSync: (path: string) => { isDirectory(): boolean };
};
const { join, relative, resolve } = require('path') as {
  join: (...parts: string[]) => string;
  relative: (from: string, to: string) => string;
  resolve: (...parts: string[]) => string;
};

const BANNED = /DUPR/;

function fact(id: string, overallScore: number): RealAnalysisFact {
  return {
    id,
    shotType: 'dink',
    capturedAt: '2026-08-10T10:00:00Z',
    overallScore,
    confidence: 0.9,
    resultKind: 'scored',
    scoringModelVersion: 'model-2',
    shotConfigVersion: 'config-1',
    sessionId: null,
    priorityCheckpoint: null,
    checkpointScores: {},
  };
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat(3)
    .filter((child): child is string | number =>
      ['string', 'number'].includes(typeof child),
    )
    .join(' ')
    .replace(/\s+/g, ' ');
}

function allAccessibilityCopy(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAll(node => node.type === View || node.type === Text)
    .flatMap(node => [
      node.props.accessibilityLabel,
      node.props.accessibilityHint,
    ])
    .filter((label): label is string => typeof label === 'string');
}

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listSourceFiles(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe('R5 — third-party trademark absent from user-facing copy', () => {
  it('PlayerRankCard and its estimate helper carry no DUPR string', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <PlayerRankCard facts={[fact('fact-1', 5.5), fact('fact-2', 5.5)]} />,
      );
    });

    const copy = allText(renderer);
    const labels = allAccessibilityCopy(renderer);

    // The card is ranked (Gold at 5.5) and still shows the disclaimed
    // estimate — the number stays, the trademark goes.
    expect(copy).toContain('Gold');
    expect(copy).toContain('5.50');
    expect(copy).toMatch(/≈/);
    expect(copy).toMatch(/rough estimate/);

    expect(copy).not.toMatch(BANNED);
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(label).not.toMatch(BANNED);

    act(() => renderer.unmount());
  });

  it('no shipped mobile source file (apps/mobile/src) mentions DUPR', () => {
    const srcRoot = resolve(__dirname, '../../src');
    const offenders = listSourceFiles(srcRoot)
      .filter(file => BANNED.test(readFileSync(file, 'utf8')))
      .map(file => relative(srcRoot, file));
    expect(offenders).toEqual([]);
  });
});
