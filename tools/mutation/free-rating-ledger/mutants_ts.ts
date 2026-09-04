/**
 * Edge-function mutants for the free-rating access computation and the
 * refusal mappings in supabase/functions/api/index.ts (accessPayload,
 * reserveAnalysisPermit, syncShots). Applied to a SCRATCH copy of the whole
 * `supabase/functions/api/` directory; production is never touched.
 */
import type { Edit } from "./mutants_sql.ts";

export interface TsMutant {
  id: string;
  target: "accessPayload" | "reserveAnalysisPermit" | "syncShots";
  description: string;
  edits: Edit[];
  expect: "killed" | "survive_gap" | "equivalent";
}

export const EDGE_INDEX = "index.ts";

export const TS_MUTANTS: TsMutant[] = [
  {
    id: "T01_used_unclamped",
    target: "accessPayload",
    description: "used is not clamped to 2 (inherited ledger > 2 yields negative remaining)",
    edits: [
      {
        find: "  const used = Math.min(2, state.scored_count ?? 0);",
        replace: "  const used = state.scored_count ?? 0;",
      },
    ],
    expect: "survive_gap",
  },
  {
    id: "T02_limit_three",
    target: "accessPayload",
    description: "remaining computed against a limit of 3",
    edits: [
      {
        find: "  const remaining = 2 - used;",
        replace: "  const remaining = 3 - used;",
      },
    ],
    expect: "survive_gap",
  },
  {
    id: "T03_reserved_unclamped",
    target: "accessPayload",
    description: "reserved not clamped to remaining (availableToReserve can go negative)",
    edits: [
      {
        find: "  const reserved = Math.min(state.reserved_count ?? 0, remaining);",
        replace: "  const reserved = state.reserved_count ?? 0;",
      },
    ],
    expect: "survive_gap",
  },
  {
    id: "T04_reserved_ignored",
    target: "accessPayload",
    description: "live reservations ignored (reserved always 0)",
    edits: [
      {
        find: "  const reserved = Math.min(state.reserved_count ?? 0, remaining);",
        replace: "  const reserved = 0;",
      },
    ],
    expect: "survive_gap",
  },
  {
    id: "T05_canStart_gte_zero",
    target: "accessPayload",
    description: "canStartRating true when availableToReserve >= 0 (exhausted account may start)",
    edits: [
      {
        find: "  const canStartRating = premium || availableToReserve > 0;",
        replace: "  const canStartRating = premium || availableToReserve >= 0;",
      },
    ],
    expect: "survive_gap",
  },
  {
    id: "T06_canStart_ignores_premium",
    target: "accessPayload",
    description: "premium no longer unlocks rating",
    edits: [
      {
        find: "  const canStartRating = premium || availableToReserve > 0;",
        replace: "  const canStartRating = availableToReserve > 0;",
      },
    ],
    expect: "killed",
  },
  {
    id: "T07_canStart_uses_remaining",
    target: "accessPayload",
    description:
      "canStartRating ignores live reservations (remaining > 0 instead of availableToReserve)",
    edits: [
      {
        find: "  const canStartRating = premium || availableToReserve > 0;",
        replace: "  const canStartRating = premium || remaining > 0;",
      },
    ],
    expect: "survive_gap",
  },
  {
    id: "T08_paywall_not_inverted",
    target: "accessPayload",
    description: "paywallRequired equals canStartRating (inverted)",
    edits: [
      {
        find: "    paywallRequired: !canStartRating,",
        replace: "    paywallRequired: canStartRating,",
      },
    ],
    expect: "survive_gap",
  },
  {
    id: "T09_used_from_reserved",
    target: "accessPayload",
    description: "used derived from reserved_count instead of scored_count",
    edits: [
      {
        find: "  const used = Math.min(2, state.scored_count ?? 0);",
        replace: "  const used = Math.min(2, state.reserved_count ?? 0);",
      },
    ],
    expect: "survive_gap",
  },
  {
    id: "T10_premium_ignores_db",
    target: "accessPayload",
    description: "premium from access_state ignored (only the billing-sync verdict counts)",
    edits: [
      {
        find: "    premium: Boolean(state.premium),\n    activeEntitlements: [],",
        replace: "    premium: false,\n    activeEntitlements: [],",
      },
    ],
    expect: "survive_gap",
  },
  {
    id: "T11_reserve_paywall_not_402",
    target: "reserveAnalysisPermit",
    description:
      "reserve refusal falls through to the generic 503 instead of 402 access.paywall_required",
    edits: [
      {
        find: '  if (row.result === "access.paywall_required") {\n    return codedError(\n      402,',
        replace:
          '  if (row.result === "access.paywall_required__never") {\n    return codedError(\n      402,',
      },
    ],
    expect: "survive_gap",
  },
  {
    id: "T12_reserve_paywall_200",
    target: "reserveAnalysisPermit",
    description: "reserve refusal answered with HTTP 200 (client never sees the paywall)",
    edits: [
      {
        find: '  if (row.result === "access.paywall_required") {\n    return codedError(\n      402,',
        replace:
          '  if (row.result === "access.paywall_required") {\n    return codedError(\n      200,',
      },
    ],
    expect: "survive_gap",
  },
  {
    id: "T13_sync_paywall_unmapped",
    target: "syncShots",
    description:
      "sync refusal access.paywall_required is not a mapped status (rejected as shot.write_failed → outbox retries forever)",
    edits: [
      {
        find: '  "access.paywall_required":\n    "Both lifetime free ratings have been used. Membership is required for another rating.",',
        replace: "",
      },
    ],
    expect: "survive_gap",
  },
  {
    id: "T14_sync_paywall_accepted",
    target: "syncShots",
    description:
      "a refused scored shot is acknowledged as accepted (client drops it from the outbox as if recorded)",
    edits: [
      {
        find: '    if (status === "accepted") {\n      acceptedIds.push(shot.id);',
        replace:
          '    if (status === "accepted" || status === "access.paywall_required") {\n      acceptedIds.push(shot.id);',
      },
    ],
    expect: "survive_gap",
  },
];
