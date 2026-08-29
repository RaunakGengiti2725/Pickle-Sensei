import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { AnalysisRecord } from '@pickle/swing-domain';

jest.mock('../src/data/db', () => ({
  getDb: jest.fn(() => ({
    execute: jest.fn(async () => ({ rows: [] })),
    close() {},
  })),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});

const mockNavigate = jest.fn();
const mockPopToTop = jest.fn();
let mockSessionId = '';
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, popToTop: mockPopToTop }),
  useRoute: () => ({ params: { sessionId: mockSessionId } }),
}));

import { LiveSummaryScreen } from '../src/screens/LiveSummaryScreen';
import {
  LiveSessionFlow,
  type SessionEventAnalysisProvider,
  type SessionMotionSample,
} from '../src/flow/session';
import fixture from './fixtures/sessionReplay.afn-sasebo-rally1.json';

/**
 * G21 defect pin — the session summary must ROUTE to the actual per-event
 * analysis, not only show a READY state chip. Before the fix, a user who
 * ended a session (LiveCourt tears the live screen down and navigates here)
 * had NO path from a ready event to its analysis content: the summary row
 * rendered a chip and nothing was tappable. The Result route exists and the
 * record id is on the event view — the summary just never used them.
 */

const samples: SessionMotionSample[] = fixture.wristSamples;

function analysisDouble(eventId: string): AnalysisRecord {
  return {
    schemaVersion: 1,
    id: `analysis-${eventId}`,
    captureId: `capture-${eventId}`,
    createdAtIso: '2026-08-29T12:30:00.000Z',
    engineVersion: 'test-double',
    strokeTaxonomyVersion: 'test-double',
    strokeResolution: { kind: 'declared', shotType: 'forehand_drive' },
    modalities: {
      pose: true,
      paddle: false,
      ball: false,
      court: false,
      camera: false,
    },
    modelRuns: [],
    provenance: {
      appVersion: 'test-double',
      pipelineVersion: 'test-double',
      providerVersions: [
        {
          providerId: 'test-double',
          modelVersion: 'test-double',
          runtime: 'deterministic',
          executionTarget: 'on_device',
          artifactHash: null,
        },
      ],
      scoreVersion: 'test-double',
      taxonomyVersion: 'test-double',
      drillMappingVersion: 'none',
      captureEnvelopeVersion: 'capture-envelope-not-measured',
      recordedAtIso: '2026-08-29T12:30:00.000Z',
    },
    result: null,
    faults: [],
    uncertainty: {
      analysisConfidence: 0,
      presentation: 'abstain',
      perCheckpoint: {},
      limitingFactors: ['TEST_DOUBLE'],
    },
    evidence: [],
    shadow: [],
  };
}

async function completeSession(sessionId: string): Promise<void> {
  const provider: SessionEventAnalysisProvider = {
    providerId: 'g21-summary-routing-provider',
    availability: () => ({ status: 'available' }),
    analyzeEvent: async request => ({
      status: 'ready',
      analysis: analysisDouble(request.eventId),
    }),
  };
  const flow = new LiveSessionFlow({
    sessionId,
    source: 'replay',
    provider,
  });
  for (const sample of samples) flow.pushSample(sample);
  flow.end();
  await flow.settled();
}

describe('LiveSummaryScreen — ready events route to their actual analysis', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockPopToTop.mockClear();
  });

  it('tapping a ready event row opens the Result route with that event analysisId', async () => {
    mockSessionId = 'g21-summary-routing-1';
    await completeSession(mockSessionId);

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<LiveSummaryScreen />);
    });

    const e1Row = renderer.root.findAll(
      node =>
        typeof node.props.onPress === 'function' &&
        node.props.accessibilityLabel === 'Open analysis for event E1',
    );
    expect(e1Row).toHaveLength(1);
    act(() => e1Row[0]!.props.onPress());
    expect(mockNavigate).toHaveBeenCalledWith('Result', {
      analysisId: 'analysis-E1',
    });

    // Every ready event is reachable, each with its OWN record id.
    const rows = renderer.root.findAll(
      node =>
        typeof node.props.onPress === 'function' &&
        /^Open analysis for event E\d+$/.test(
          String(node.props.accessibilityLabel ?? ''),
        ),
    );
    expect(rows.length).toBe(fixture.expectedEmissions.length);
    act(() => renderer.unmount());
  });

  it('non-ready events stay honest: no analysis route is offered', async () => {
    mockSessionId = 'g21-summary-routing-2';
    const provider: SessionEventAnalysisProvider = {
      providerId: 'g21-pending-provider',
      availability: () => ({ status: 'available' }),
      analyzeEvent: async () => ({
        status: 'pending',
        pendingReason: 'TEST_HOLD',
      }),
    };
    const flow = new LiveSessionFlow({
      sessionId: mockSessionId,
      source: 'replay',
      provider,
    });
    for (const sample of samples) flow.pushSample(sample);
    flow.end();
    await flow.settled();

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<LiveSummaryScreen />);
    });
    const rows = renderer.root.findAll(node =>
      /^Open analysis for event/.test(
        String(node.props.accessibilityLabel ?? ''),
      ),
    );
    expect(rows).toHaveLength(0);
    act(() => renderer.unmount());
  });
});
