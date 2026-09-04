/**
 * ADJUDICATION REPRO — area `mobile-design-components-walkthrough` @ 4d812e1a.
 *
 * Independent, minimal reproductions of every auditor claim that survived
 * deduplication and reachability review. All of them are DEFERRED P3 (see the
 * adjudication output): each assertion below states the fixed behaviour and
 * FAILS at the baseline commit on purpose. Nothing here touches production
 * code. Pure/model reproductions only — no Apple runtime claims.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { StyleSheet } from 'react-native';
import { AnalysisFeedbackPrompt } from '../../src/components/AnalysisFeedbackPrompt';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import { submitAnalysisFeedback } from '../../src/data/api';
import { loadAnalysisRecordById } from '../../src/components/strokeResultData';
import {
  measuredRows,
  strokeResultHeader,
  type StrokeResultEvidenceRecord,
} from '../../src/components/strokeResultModel';
import { shouldLoadInPlayer } from '../../src/components/DrillVideoPlayer';
import type { LocalDb } from '../../src/data/db';
import { type } from '../../src/design/tokens';

jest.mock('../../src/data/api', () => {
  const actual =
    jest.requireActual<typeof import('../../src/data/api')>(
      '../../src/data/api',
    );
  return { ...actual, submitAnalysisFeedback: jest.fn() };
});

jest.mock('react-native-webview', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockWebView = (props: Record<string, unknown>) =>
    ReactModule.createElement(View, props);
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

jest.mock('react-native-linear-gradient', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: (props: { children?: React.ReactNode }) =>
      ReactModule.createElement(View, null, props.children),
  };
});

declare const __dirname: string;
const { readFileSync } = require('fs') as {
  readFileSync: (path: string, encoding: 'utf8') => string;
};
const { join } = require('path') as { join: (...parts: string[]) => string };
const SRC = join(__dirname, '..', '..', 'src');

const submitMock = submitAnalysisFeedback as jest.MockedFunction<
  typeof submitAnalysisFeedback
>;

function fakeDb(record: string): LocalDb {
  return {
    async execute(sql: string) {
      return sql.includes('FROM local_analysis_record')
        ? { rows: [{ record }] }
        : { rows: [] };
    },
    close() {},
  };
}

describe('R1 · AnalysisFeedbackPrompt — one submission per analysis (client contract)', () => {
  beforeEach(() => {
    submitMock.mockReset();
    submitMock.mockResolvedValue({ reviewEligible: false });
    establishApiSession({
      apiBaseUrl: 'https://api.test',
      bearerToken: 'token-1',
      canonicalAppUserId: 'user-1',
      provider: 'apple',
    });
  });
  afterEach(() => clearApiSession());

  it('two activations delivered in the same batch reach the network once', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AnalysisFeedbackPrompt analysisId="analysis-1" />,
      );
    });
    await act(async () => {
      const yes = renderer.root.findByProps({ testID: 'feedback-yes' });
      yes.props.onPress();
      yes.props.onPress();
    });
    expect(submitMock).toHaveBeenCalledTimes(1);
  });
});

describe('R2 · local_analysis_record rows that parse but are not record objects', () => {
  it.each(['5', '[]', '"text"', 'true', '[{"result":null}]'])(
    'payload %s is skipped (null) instead of surfacing as a saved analysis',
    async payload => {
      await expect(
        loadAnalysisRecordById(fakeDb(payload), 'a'),
      ).resolves.toBeNull();
    },
  );

  it.each([
    ['result as array', '{"id":"x","result":[]}'],
    [
      'result without timestamps',
      '{"id":"x","result":{"shotType":"forehand_drive"}}',
    ],
    [
      'declared basis, declaredStroke number',
      '{"id":"x","strokeIntent":{"resolutionBasis":"declared","declaredStroke":42}}',
    ],
  ])(
    'shape-corrupt row (%s) never throws out of the model helpers',
    async (_label, payload) => {
      const record = (await loadAnalysisRecordById(
        fakeDb(payload),
        'a',
      )) as StrokeResultEvidenceRecord | null;
      expect(() => strokeResultHeader(record, null)).not.toThrow();
      expect(() => measuredRows({ analysis: null, record })).not.toThrow();
    },
  );
});

describe('R3 · DrillVideoPlayer top-frame gate agrees with the WHATWG host', () => {
  const media = {
    kind: 'embed',
    provider: 'youtube',
    sourceUrl: 'https://www.youtube.com/watch?v=x',
    embedUrl: 'https://www.youtube-nocookie.com/embed/x',
  } as unknown as Parameters<typeof shouldLoadInPlayer>[0];

  it.each([
    'https://evil.com\\@youtube.com/',
    'https://evil.com\\@www.youtube-nocookie.com/embed/x',
  ])('drops %s (WHATWG hostname is evil.com)', url => {
    expect(new URL(url).hostname).toBe('evil.com');
    expect(shouldLoadInPlayer(media, { url, isTopFrame: true })).toBe(false);
  });
});

describe('R5 · third-party trademark policy — no "DUPR" in user-facing copy', () => {
  it('PlayerRankCard and its estimate helper carry no DUPR string', () => {
    const files = [
      join(SRC, 'components', 'PlayerRankCard.tsx'),
      join(SRC, 'progress', 'duprEstimate.ts'),
    ];
    const hits = files.filter(file =>
      /['"`][^'"`\n]*DUPR[^'"`\n]*['"`]/.test(readFileSync(file, 'utf8')),
    );
    expect(hits).toEqual([]);
  });
});

describe('R4 · typography canon — no ad-hoc font size below the smallest role', () => {
  it('PlayerRankBanner streak label keeps the `type.micro` size', () => {
    const source = readFileSync(
      join(SRC, 'components', 'PlayerRankBanner.tsx'),
      'utf8',
    );
    const smallest = Math.min(
      ...Object.values(type).map(
        role => StyleSheet.flatten(role)?.fontSize ?? Number.POSITIVE_INFINITY,
      ),
    );
    const adHoc = [...source.matchAll(/fontSize:\s*(\d+)/g)].map(m =>
      Number(m[1]),
    );
    expect(adHoc.filter(size => size < smallest)).toEqual([]);
  });
});
