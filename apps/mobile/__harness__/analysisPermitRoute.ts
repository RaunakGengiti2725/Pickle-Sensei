/**
 * The finalize route's acknowledgement exactly as the production edge
 * function writes it (`supabase/functions/api/index.ts` `permitView` +
 * `access`): it names the permit it settled, the settled status and the
 * outcome it recorded. Test servers answer `POST
 * /v1/analysis-permits/:id/finalize` with this so the client's
 * acknowledgement check sees the same shape the real route produces.
 */

const FINALIZE_PATH = /\/v1\/analysis-permits\/([^/]+)\/finalize$/;

export interface FinalizeAcknowledgement {
  permit: {
    id: string;
    accessSource: 'free';
    status: 'finalized';
    outcome: string | null;
    reservedAt: string;
    expiresAt: string;
  };
  access: {
    premium: boolean;
    entitlements: string[];
    freeRatings: {
      limit: number;
      used: number;
      reserved: number;
      remaining: number;
      availableToReserve: number;
    };
    paywallRequired: boolean;
  };
}

/** The permit id addressed by a finalize URL (path-decoded), else `null`. */
export function finalizedPermitId(url: string): string | null {
  const match = FINALIZE_PATH.exec(url);
  return match ? decodeURIComponent(match[1]!) : null;
}

export function finalizeAcknowledgement(
  url: string,
  requestBody: unknown,
): FinalizeAcknowledgement {
  const id = finalizedPermitId(url);
  if (id === null) throw new Error(`not a finalize URL: ${url}`);
  const outcome =
    typeof requestBody === 'object' &&
    requestBody !== null &&
    typeof (requestBody as { outcome?: unknown }).outcome === 'string'
      ? (requestBody as { outcome: string }).outcome
      : null;
  return {
    permit: {
      id,
      accessSource: 'free',
      status: 'finalized',
      outcome,
      reservedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z',
    },
    access: {
      premium: false,
      entitlements: [],
      freeRatings: {
        limit: 2,
        used: 0,
        reserved: 0,
        remaining: 2,
        availableToReserve: 2,
      },
      paywallRequired: false,
    },
  };
}
