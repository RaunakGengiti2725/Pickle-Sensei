/**
 * ADV INT-analysis-scoring — the mobile side of the shot-sync verdict
 * contract, fed the EXACT malformed bodies the Edge function was observed to
 * emit under duplicate/conflicting ids in one batch
 * (supabase/functions/api/__wf__/adv_analysis_scoring_release_sync.test.ts,
 * A5/A6b). One id must carry exactly one verdict; the client must never
 * count an accepted+rejected id as synced, nor a doubly-acked id twice.
 */
import { ApiError, parseShotSyncAcknowledgement } from '../../src/data/api';

const ID = 'a4388575-afb0-49e0-9991-ac5dfcb416e7';

describe('ADV S1: shot-sync acknowledgement with one id, two verdicts', () => {
  test('acceptedIds + rejected both naming the same id is refused as an invalid acknowledgement', () => {
    const body = {
      acceptedIds: [ID],
      rejected: [
        {
          id: ID,
          code: 'access.release_not_authorized',
          message:
            'This rating could not be validated for release. It stays on this device and was not counted.',
        },
      ],
    };
    let thrown: unknown = null;
    try {
      parseShotSyncAcknowledgement(body, [ID]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).code).toBe('sync.invalid_acknowledgement');
    expect((thrown as ApiError).status).toBe(502);
  });

  test('the same id acknowledged twice in acceptedIds is refused', () => {
    expect(() =>
      parseShotSyncAcknowledgement({ acceptedIds: [ID, ID], rejected: [] }, [
        ID,
      ]),
    ).toThrow(ApiError);
  });

  test('an acknowledgement for an id the device never submitted is refused', () => {
    expect(() =>
      parseShotSyncAcknowledgement(
        {
          acceptedIds: ['00000000-0000-4000-8000-000000000009'],
          rejected: [],
        },
        [ID],
      ),
    ).toThrow(ApiError);
  });

  test('a partial acknowledgement (one submitted id with no verdict) is refused', () => {
    expect(() =>
      parseShotSyncAcknowledgement({ acceptedIds: [], rejected: [] }, [ID]),
    ).toThrow(ApiError);
  });

  test('precondition: a single well-formed verdict per id parses', () => {
    expect(
      parseShotSyncAcknowledgement({ acceptedIds: [ID], rejected: [] }, [ID]),
    ).toEqual({ acceptedIds: [ID], rejected: [] });
  });
});
