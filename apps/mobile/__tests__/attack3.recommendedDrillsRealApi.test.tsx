/**
 * ADVERSARIAL PASS 3 — RecommendedDrills against the REAL training api
 * (only the session store and the network are faked).
 *
 * S1 (network level): a whitespace bearer token must never produce a fetch.
 * S7 (network level): a 401 from the catalog route must surface the quiet
 *     session-expired caption + Retry, report the rejected bearer exactly
 *     once, and Retry must send the ROTATED bearer — the rejected one never
 *     goes out again.
 * Extras: a zero-width token (NOT JavaScript whitespace) must not crash the
 *     card; a huge token is sent verbatim; a unicode 401 body is honest.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type {
  CheckpointKey,
  CheckpointScore,
  FaultDirection,
  ScoreBand,
  ShotAnalysis,
} from '@pickle/shared-types';

const mockGetApiSession = jest.fn();
const mockReportApiUnauthorized = jest.fn();
jest.mock('../src/account/apiSession', () => ({
  getApiSession: () => mockGetApiSession(),
  reportApiUnauthorized: (token: string) => mockReportApiUnauthorized(token),
}));

import {
  RECOMMENDED_DRILLS_SIGN_IN_COPY,
  RecommendedDrills,
} from '../src/review/RecommendedDrills';

function checkpoint(
  key: CheckpointKey,
  score: number | null,
  band: ScoreBand,
  direction: FaultDirection,
): CheckpointScore {
  return {
    key,
    score,
    confidence: 0.8,
    band,
    direction,
    severity: score === null ? 0 : (100 - score) / 100,
    applicable: true,
  };
}

const analysis: ShotAnalysis = {
  id: 'analysis-1',
  sessionId: null,
  shotType: 'forehand_drive',
  cameraView: 'side',
  handedness: 'right',
  capturedAtIso: '2026-09-01T10:00:00.000Z',
  timestamps: { startMs: 0, contactMs: 1900, endMs: 3200 },
  phases: [],
  measurements: [],
  checkpoints: [
    checkpoint('ready_position', 85, 'green', 'none'),
    checkpoint('contact_position', 48, 'red', 'late'),
  ],
  overallScore: 6.8,
  analysisConfidence: 0.84,
  resultKind: 'scored',
  guidance: null,
  priorityFix: {
    checkpoint: 'contact_position',
    reasonKey: 'lowest_score',
    severity: 0.52,
    confidence: 0.8,
  },
  versionVector: {
    appVersion: '0.1.0',
    modelBundleVersion: 'on-device-fusion-1',
    poseModelVersion: 'apple-vision-bodypose-1',
    paddleModelVersion: 'none',
    strokeDetectorVersion: 'temporal-stroke-heuristic-2',
    phaseModelVersion: 'phase-geometry-1',
    scoringModelVersion: 'sm-v1',
    shotConfigVersion: 'forehand_drive@1',
  },
  source: 'real',
};

const session = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'access-token-v1',
  canonicalAppUserId: '00000000-0000-4000-8000-000000000001',
  provider: 'apple' as const,
};

const CATALOG_BODY = {
  items: [
    {
      id: '00000000-0000-4000-8000-00000000d001',
      slug: 'drive-and-recover',
      title: 'Drive And Recover',
      description: 'Description for drive-and-recover.',
      coach_name: 'Pickle Sensei Training Library',
      equipment: [],
      difficulty_min: null,
      difficulty_max: null,
      families: ['drive'],
      validation_state: 'UNVALIDATED',
      saved: false,
    },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

const mounted: TestRenderer.ReactTestRenderer[] = [];
let fetchMock: jest.Mock;

async function render() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <RecommendedDrills analysis={analysis} onOpenLibrary={jest.fn()} />,
    );
  });
  mounted.push(renderer);
  return renderer;
}

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function retryButton(renderer: TestRenderer.ReactTestRenderer) {
  const [node] = renderer.root.findAll(
    candidate =>
      candidate.props.testID === 'recommended-drills-retry' &&
      typeof candidate.props.onPress === 'function',
  );
  return node;
}

function authHeader(call: unknown[]): string | undefined {
  const init = call[1] as { headers?: Record<string, string> } | undefined;
  return init?.headers?.['Authorization'];
}

beforeEach(() => {
  mockGetApiSession.mockReset();
  mockReportApiUnauthorized.mockReset();
  fetchMock = jest.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
});

describe('S1 (network) — blank bearer never reaches fetch', () => {
  it.each(['', ' ', '\t', '\n\r', '\u00a0\u3000\ufeff'])(
    'bearerToken=%j → sign-in caption, zero fetches',
    async bearerToken => {
      mockGetApiSession.mockReturnValue({ ...session, bearerToken });
      const renderer = await render();
      expect(textOf(renderer)).toContain(RECOMMENDED_DRILLS_SIGN_IN_COPY);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockReportApiUnauthorized).not.toHaveBeenCalled();
    },
  );

  it('a zero-width-space token is NOT JS whitespace: it is sent, and a 401 is handled honestly (no crash)', async () => {
    // U+200B survives String#trim(). The card must not treat it as a
    // session-less device (that is the trim contract), but whatever the
    // server answers must come back as a quiet card, never a throw.
    mockGetApiSession.mockReturnValue({ ...session, bearerToken: '\u200b' });
    fetchMock.mockResolvedValue(jsonResponse(401, {}));
    const renderer = await render();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authHeader(fetchMock.mock.calls[0]!)).toBe('Bearer \u200b');
    expect(textOf(renderer)).toContain('Your sign-in expired');
    expect(retryButton(renderer)).toBeDefined();
    expect(mockReportApiUnauthorized).toHaveBeenCalledWith('\u200b');
  });

  it('a 64 KiB token is sent verbatim once (no truncation, no duplicate request)', async () => {
    const huge = 'x'.repeat(64 * 1024);
    mockGetApiSession.mockReturnValue({ ...session, bearerToken: huge });
    fetchMock.mockResolvedValue(jsonResponse(200, CATALOG_BODY));
    const renderer = await render();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authHeader(fetchMock.mock.calls[0]!)).toBe(`Bearer ${huge}`);
    expect(textOf(renderer)).toContain('recommended-drill-drive-and-recover');
  });
});

describe('S7 (network) — 401 on the catalog route', () => {
  it('quiet caption + Retry; the rejected bearer is reported once; Retry sends the ROTATED bearer', async () => {
    mockGetApiSession.mockReturnValue(session);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(401, {
          error: { code: 'training.unauthorized', message: 'nope' },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, CATALOG_BODY));
    const renderer = await render();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://api.example.test/v1/catalog/drills?family=drive',
    );
    expect(authHeader(fetchMock.mock.calls[0]!)).toBe('Bearer access-token-v1');
    // The api maps every 401 to the session-expired code, whatever the body
    // says — the server's `nope` never reaches the user.
    const copy = textOf(renderer);
    expect(copy).toContain('Your sign-in expired. Sign in again to continue.');
    expect(copy).not.toContain('nope');
    expect(mockReportApiUnauthorized).toHaveBeenCalledTimes(1);
    expect(mockReportApiUnauthorized).toHaveBeenCalledWith('access-token-v1');
    const retry = retryButton(renderer);
    expect(retry).toBeDefined();

    mockGetApiSession.mockReturnValue({
      ...session,
      bearerToken: 'access-token-v2',
    });
    await act(async () => {
      retry!.props.onPress();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authHeader(fetchMock.mock.calls[1]!)).toBe('Bearer access-token-v2');
    expect(textOf(renderer)).toContain('recommended-drill-drive-and-recover');
    // No second unauthorized report: the rotated token was accepted.
    expect(mockReportApiUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('a 401 whose body is not JSON (or is unicode garbage) still reads as session-expired', async () => {
    mockGetApiSession.mockReturnValue(session);
    fetchMock.mockResolvedValue({
      status: 401,
      ok: false,
      json: async () => {
        throw new SyntaxError('Unexpected token 🥒');
      },
    } as unknown as Response);
    const renderer = await render();
    expect(textOf(renderer)).toContain('Your sign-in expired');
    expect(textOf(renderer)).not.toContain('🥒');
    expect(retryButton(renderer)).toBeDefined();
  });

  it('a 403 with a unicode server message shows THAT message, not a crash', async () => {
    mockGetApiSession.mockReturnValue(session);
    fetchMock.mockResolvedValue(
      jsonResponse(403, {
        error: {
          code: 'training.forbidden',
          message: 'Ünïcödé — 「禁止」 🚫',
        },
      }),
    );
    const renderer = await render();
    expect(textOf(renderer)).toContain('Ünïcödé — 「禁止」 🚫');
    expect(mockReportApiUnauthorized).not.toHaveBeenCalled();
    expect(retryButton(renderer)).toBeDefined();
  });
});
