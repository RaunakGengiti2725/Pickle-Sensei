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
import fs from 'fs';
import path from 'path';
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
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listSourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
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
    const srcRoot = path.resolve(__dirname, '../../src');
    const offenders = listSourceFiles(srcRoot)
      .filter(file => BANNED.test(fs.readFileSync(file, 'utf8')))
      .map(file => path.relative(srcRoot, file));
    expect(offenders).toEqual([]);
  });
});
