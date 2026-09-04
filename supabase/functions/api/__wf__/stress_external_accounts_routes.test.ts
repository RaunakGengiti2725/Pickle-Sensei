/**
 * stress_external_accounts — ROUTE-LEVEL concurrency campaign.
 *
 * The REAL handler (index.ts) runs in-process over stateful fakes
 * (stress_external_accounts_harness.ts). Every round is seeded; every lane in
 * a round is a real HTTP request fired inside one Promise.all burst, with
 * seeded upstream latency so the interleavings differ per seed.
 *
 *   deno test -A --no-check --config deno.json stress_external_accounts_routes.test.ts
 *   STRESS_ITER=60 STRESS_BURST=8 STRESS_LATENCY_MS=10 deno test -A --no-check --config deno.json stress_external_accounts_routes.test.ts
 *
 * Scenarios (each writes <STRESS_OUT_DIR>/<scenario>.json, seed → outcome):
 *   R1 duplicate delivery: N concurrent delete-confirm with the SAME bearer +
 *      challenge (retry storm) — user deleted exactly once, Apple token revoked
 *      exactly once, RC deleted, no 5xx, no 4xx other than "already gone".
 *   R2 two devices: delete-confirm from device A while device B re-bootstraps
 *      with a fresh Apple authorization code — no live Apple grant may survive
 *      the account's deletion (Apple's revocation requirement).
 *   R3 duplicate bootstrap: the same one-use Apple code delivered N times —
 *      exactly one credential row, its ciphertext decrypts to the grant Apple
 *      actually issued, the replays are 401 invalid-authorization (never 5xx,
 *      never a second stored token).
 *   R4 retry after a transient fault: RC 5xx / Apple 503 / network throw on
 *      the first pass, clean retry — Apple revoke happens once overall
 *      (checkpoint), the user is deleted only on the successful pass.
 *   R5 rotation: APPLE_TOKEN_ENCRYPTION_KEY rotated between bootstrap and
 *      deletion — deletion still completes (manual_action_required), the
 *      unrevocable ciphertext is dropped, RC + Auth deletion run once.
 *   R6 logout during delete-confirm: the same session logs out while N
 *      delete-confirms are in flight — every 200 is a real deletion, every
 *      non-200 leaves the account intact or the checkpoints consistent.
 *   R7 Google accounts (no Apple credential): N duplicate delete-confirms —
 *      one RC delete, one row, one Auth delete, all lanes 200.
 *   R8 clock skew: the edge clock is skewed vs Apple's; within tolerance the
 *      exchange/revoke succeed, beyond it Apple says invalid_client and the
 *      route must classify it RETRYABLE (503, credential kept) — never
 *      manual_action_required, never a dropped token.
 */
import { assert, assertEquals } from "@std/assert";
import { assertCampaign, type KnownBroken } from "./stress_external_accounts_harness.ts";
import type { Invariant } from "./xc_concurrency_harness.ts";
import { decryptAppleRefreshToken } from "../externalAccounts.ts";
import {
  appleBootstrapRequest,
  campaign,
  credentialRow,
  credentialRows,
  deleteConfirmRequest,
  drive,
  edgeRequest,
  fakeIdToken,
  isRecord,
  type LaneResult,
  loadStressHarness,
  Prng,
  seedDeletionChallenge,
  STRESS_BURST,
  STRESS_ITER,
  type StressHarness,
  type StressWorld,
} from "./stress_external_accounts_harness.ts";

const FILE = "stress_external_accounts_routes.test.ts";
const h: StressHarness = await loadStressHarness();

/**
 * Defects this campaign reproduces on 1fb0efd7 (see the stress report). They
 * are recorded BROKEN in every JSON report; the test only turns red if one of
 * them stops reproducing (then trim the entry and close the finding).
 *
 * EA-1 duplicate delete-confirm: a lane that read the checkpoint row before
 *      the winner's auth.users delete finishes its cleanup AFTER the cascade;
 *      its `revenuecat_deleted_at` upsert hits the profiles FK (23503) and the
 *      lane answers 503 for an account that IS deleted. Client sees "try
 *      again" for a deletion that succeeded; the retry is a 401.
 * EA-2 bootstrap racing delete-confirm: the deletion revokes the ONE token it
 *      read, then blind-writes `apple_revoked_at` over whatever ciphertext a
 *      concurrent bootstrap upserted meanwhile (lost update), then the cascade
 *      destroys the row — the tokens issued in the window stay live at Apple
 *      with no handle left to revoke them.
 */
const EA1: KnownBroken = { no_503_after_account_deleted: "EA-1", losers_are_401_or_403: "EA-1" };
const EA1_EA2: KnownBroken = { ...EA1, grants_held_at_deletion_all_revoked: "EA-2" };

const inv = (name: string, holds: boolean, detail: string): Invariant => ({ name, holds, detail });
const ip = (seed: number, lane: number) => `203.0.113.${((seed + lane * 7) % 200) + 1}`;
/** POST /v1/me/delete-confirm is budgeted 5/hour per user (in-isolate), so a
 * same-user burst is capped at 5 lanes — otherwise the 6th lane is a 429 that
 * says nothing about cleanup concurrency. */
const DELETE_BURST = Math.min(STRESS_BURST, 5);

/** Deterministic UUID subject: GoTrue mints the canonical user id from the
 * provider subject in the fake, and auth-js refuses non-UUID ids. */
function subjectFor(seed: number, tag: string): string {
  let x = seed >>> 0;
  for (const ch of tag) x = Math.imul(x ^ ch.charCodeAt(0), 0x01000193) >>> 0 || 1;
  return new Prng(x).uuid();
}

interface Account {
  subject: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
}

/** Sign an Apple account in through the real bootstrap route (code exchange
 * included) so the credential row is exactly what production would store. */
async function appleAccount(
  w: StressWorld,
  seed: number,
  tag: string,
  legacy = false,
): Promise<Account> {
  const subject = subjectFor(seed, `apple-${tag}`);
  const r = await drive(
    h,
    -1,
    "bootstrap",
    appleBootstrapRequest(w, subject, "192.0.2.9", { legacy }),
  );
  assertEquals(r.status, 200, `bootstrap setup failed: ${JSON.stringify(r.body)}`);
  const session = isRecord(r.body.session) ? r.body.session : {};
  const user = isRecord(r.body.user) ? r.body.user : {};
  const account = {
    subject,
    userId: String(user.id),
    accessToken: String(session.accessToken),
    refreshToken: String(session.refreshToken),
  };
  w.rc.subscribers.add(account.userId);
  return account;
}

async function googleAccount(w: StressWorld, seed: number, tag: string): Promise<Account> {
  const subject = subjectFor(seed, `google-${tag}`);
  const r = await drive(
    h,
    -1,
    "bootstrap",
    edgeRequest("POST", "/v1/account/bootstrap", {
      token: fakeIdToken("google", subject),
      ip: "192.0.2.9",
      body: {},
    }),
  );
  assertEquals(r.status, 200, `google bootstrap setup failed: ${JSON.stringify(r.body)}`);
  const session = isRecord(r.body.session) ? r.body.session : {};
  const user = isRecord(r.body.user) ? r.body.user : {};
  const account = {
    subject,
    userId: String(user.id),
    accessToken: String(session.accessToken),
    refreshToken: String(session.refreshToken),
  };
  w.rc.subscribers.add(account.userId);
  return account;
}

/** Ground truth after a burst that was supposed to delete `a`. */
function deletionInvariants(
  w: StressWorld,
  a: Account,
  results: LaneResult[],
  expectDeleted: boolean,
): Invariant[] {
  const out: Invariant[] = [];
  const okLanes = results.filter((r) => r.status === 200);
  const userGone = !w.fake.users.has(a.userId);
  const rows = credentialRows(w, a.userId);
  const liveGrants = w.apple.liveGrantsFor(a.subject);
  const authDeletes200 = w.adminDeletes.filter(
    (d) => d.userId === a.userId && d.status === 200,
  ).length;
  const rcDeleted = !w.rc.subscribers.has(a.userId);
  out.push(
    inv(
      "no_500_crash",
      results.every((r) => r.status !== 500 && r.status < 504),
      `statuses=${results.map((r) => r.status).join(",")}`,
    ),
  );
  out.push(
    inv(
      "bounded_wall_time",
      results.every((r) => r.ms < 5_000),
      `max=${Math.max(...results.map((r) => r.ms))}ms`,
    ),
  );
  const late503 = results.filter((r) => r.status === 503);
  out.push(
    inv(
      "no_503_after_account_deleted",
      !userGone || late503.length === 0,
      `userGone=${userGone} lanes503=${late503.map((r) => r.lane).join(",")} fkViolations=${w.fkViolations.filter((u) => u === a.userId).length}`,
    ),
  );
  if (expectDeleted) {
    out.push(
      inv(
        "user_deleted_once",
        userGone && authDeletes200 === 1,
        `gone=${userGone} authDeletes200=${authDeletes200}`,
      ),
    );
    out.push(inv("at_least_one_200", okLanes.length >= 1, `ok=${okLanes.length}`));
    out.push(inv("rc_deleted", rcDeleted, `rcSubscriberStillExists=${!rcDeleted}`));
    out.push(inv("credential_rows_cascaded", rows.length === 0, `rows=${rows.length}`));
  }
  out.push(
    inv(
      "no_live_apple_grant_after_deletion",
      !userGone || liveGrants.length === 0,
      `userGone=${userGone} liveGrants=${liveGrants.map((g) => g.refreshToken).join(",")}`,
    ),
  );
  out.push(inv("no_duplicate_credential_rows", rows.length <= 1, `rows=${rows.length}`));
  // Every 200 must be a real deletion (the lane's account really is gone).
  out.push(
    inv(
      "every_200_is_a_deletion",
      okLanes.length === 0 || userGone,
      `ok=${okLanes.length} gone=${userGone}`,
    ),
  );
  for (const r of okLanes.filter((r) => r.op.startsWith("delete-confirm"))) {
    const rev = r.body.appleAuthorizationRevocation;
    out.push(
      inv(
        "200_reports_revocation_outcome",
        rev === "revoked" || rev === "not_applicable" || rev === "manual_action_required",
        `lane ${r.lane}: ${String(rev)}`,
      ),
    );
  }
  return out;
}

// ── R1 duplicate delivery ────────────────────────────────────────────────────
Deno.test(
  `stress-R1 delete-confirm duplicate delivery ×${DELETE_BURST} (same bearer + challenge) — one deletion, one revoke, no 5xx`,
  async () => {
    const report = await campaign(
      "stress-R1-delete-confirm-duplicate-delivery",
      "duplicate delivery",
      FILE,
      { burst: DELETE_BURST },
      STRESS_ITER,
      async (seed) => {
        const w = h.reset(seed);
        const a = await appleAccount(w, seed, "r1");
        const challenge = seedDeletionChallenge(w, a.userId);
        const results = await Promise.all(
          Array.from({ length: DELETE_BURST }, (_, lane) =>
            drive(
              h,
              lane,
              "delete-confirm",
              deleteConfirmRequest(a.accessToken, challenge, ip(seed, lane)),
            ),
          ),
        );
        const invs = deletionInvariants(w, a, results, true);
        const revokedGrants = [...w.apple.grants.values()].filter(
          (g) => g.subject === a.subject && g.revoked,
        );
        invs.push(
          inv("apple_grant_revoked", revokedGrants.length === 1, `revoked=${revokedGrants.length}`),
        );
        // Duplicates that lost the race must be 401 (session fenced/gone) or 403
        // (challenge row cascaded) — never a 5xx, never a 200 claiming a second deletion.
        const losers = results.filter((r) => r.status !== 200);
        invs.push(
          inv(
            "losers_are_401_or_403",
            losers.every((r) => r.status === 401 || r.status === 403),
            `losers=${losers.map((r) => `${r.status}:${r.code ?? ""}`).join(",")}`,
          ),
        );
        return {
          invariants: invs,
          statuses: results.map((r) => r.status),
          detail: {
            appleRevokeCalls: w.apple.revokeCalls,
            rcDeleteCalls: w.rc.deleteCalls,
            adminDeletes: w.adminDeletes.map((d) => d.status),
            fkViolations: w.fkViolations.length,
          },
        };
      },
      { knownBroken: EA1 },
    );
    assertCampaign(report, EA1);
  },
);

// ── R2 two devices ───────────────────────────────────────────────────────────
Deno.test(
  `stress-R2 delete-confirm (device A) racing a fresh Apple bootstrap (device B) — no live Apple grant survives deletion`,
  async () => {
    const report = await campaign(
      "stress-R2-delete-vs-rebootstrap",
      "two actors on one identity",
      FILE,
      { burst: STRESS_BURST },
      STRESS_ITER,
      async (seed) => {
        const w = h.reset(seed);
        const a = await appleAccount(w, seed, "r2");
        const challenge = seedDeletionChallenge(w, a.userId);
        const prng = new Prng(seed);
        let deleteLanes = 0;
        const lanes = Array.from({ length: STRESS_BURST }, (_, lane) => {
          const isDelete = (lane === 0 || prng.int(0, 2) === 0) && deleteLanes < DELETE_BURST;
          if (isDelete) deleteLanes += 1;
          return isDelete
            ? drive(
                h,
                lane,
                "delete-confirm",
                deleteConfirmRequest(a.accessToken, challenge, ip(seed, lane)),
              )
            : drive(h, lane, "bootstrap", appleBootstrapRequest(w, a.subject, ip(seed, lane)));
        });
        const results = await Promise.all(lanes);
        const invs = deletionInvariants(w, a, results, false).filter(
          (i) => i.name !== "no_live_apple_grant_after_deletion",
        );
        const userGone = !w.fake.users.has(a.userId);
        const deletes = results.filter((r) => r.op === "delete-confirm");
        invs.push(inv("delete_lane_present", deletes.length >= 1, ""));
        // Apple's rule: when the account is deleted, every refresh token we hold
        // for it must be revoked. A grant issued BEFORE the auth.users delete was
        // stored in (and destroyed with) this account's row; a grant issued after
        // it belongs to a brand-new sign-in and is legitimately live.
        const deletedAt =
          w.adminDeletes.find((d) => d.userId === a.userId && d.status === 200)?.t ?? null;
        const orphanedLive =
          deletedAt === null
            ? []
            : [...w.apple.grants.values()].filter(
                (g) => g.subject === a.subject && !g.revoked && g.issuedAt < deletedAt,
              );
        invs.push(
          inv(
            "grants_held_at_deletion_all_revoked",
            orphanedLive.length === 0,
            `deletedAt=${deletedAt} liveGrantsIssuedBefore=${orphanedLive.map((g) => g.refreshToken).join(",")}`,
          ),
        );
        const bootstrapsOk = results.filter((r) => r.op === "bootstrap" && r.status === 200).length;
        return {
          invariants: invs,
          statuses: results.map((r) => r.status),
          detail: {
            userGone,
            bootstrapsOk,
            deleteStatuses: deletes.map((r) => r.status),
            appleGrants: [...w.apple.grants.values()].map(
              (g) => `${g.refreshToken}:${g.revoked ? "revoked" : "LIVE"}@${g.issuedAtCall}`,
            ),
            appleTimeline: w.apple.timeline.map((t) => `${t.t} ${t.op} ${t.detail}`),
            adminDeletes: w.adminDeletes.map((d) => d.status),
          },
        };
      },
      { knownBroken: EA1_EA2 },
    );
    assertCampaign(report, { grants_held_at_deletion_all_revoked: "EA-2" });
  },
);

// ── R3 duplicate bootstrap ───────────────────────────────────────────────────
Deno.test(
  `stress-R3 bootstrap duplicate delivery ×${STRESS_BURST} (same one-use Apple code) — one row, ciphertext = issued grant, replays 401`,
  async () => {
    const report = await campaign(
      "stress-R3-bootstrap-duplicate-code",
      "duplicate bootstrap",
      FILE,
      { burst: STRESS_BURST },
      STRESS_ITER,
      async (seed) => {
        const w = h.reset(seed);
        const subject = subjectFor(seed, "apple-r3");
        const code = w.apple.issueCode(subject);
        const results = await Promise.all(
          Array.from({ length: STRESS_BURST }, (_, lane) =>
            drive(
              h,
              lane,
              "bootstrap",
              appleBootstrapRequest(w, subject, ip(seed, lane), { code }),
            ),
          ),
        );
        const invs: Invariant[] = [];
        const ok = results.filter((r) => r.status === 200);
        const invalid = results.filter(
          (r) => r.status === 401 && r.code === "auth.apple_authorization_invalid",
        );
        invs.push(
          inv(
            "no_5xx",
            results.every((r) => r.status < 500),
            `statuses=${results.map((r) => r.status).join(",")}`,
          ),
        );
        invs.push(inv("exactly_one_200", ok.length === 1, `ok=${ok.length}`));
        invs.push(
          inv(
            "replays_401_invalid_authorization",
            invalid.length === results.length - 1,
            `invalid=${invalid.length} of ${results.length - 1}; codes=${results.map((r) => `${r.status}:${r.code ?? ""}`).join(",")}`,
          ),
        );
        invs.push(
          inv(
            "apple_exchanged_every_delivery",
            w.apple.tokenCalls === results.length,
            `tokenCalls=${w.apple.tokenCalls}`,
          ),
        );
        const userId = ok.length
          ? String((isRecord(ok[0].body.user) ? ok[0].body.user : {}).id)
          : subject;
        const rows = credentialRows(w, userId);
        invs.push(inv("exactly_one_credential_row", rows.length === 1, `rows=${rows.length}`));
        const grants = [...w.apple.grants.values()].filter((g) => g.subject === subject);
        invs.push(inv("apple_issued_one_grant", grants.length === 1, `grants=${grants.length}`));
        if (rows.length === 1 && grants.length === 1) {
          let plaintext = "";
          try {
            plaintext = await decryptAppleRefreshToken(
              String(rows[0].apple_refresh_token_encrypted),
              userId,
              h.encryptionKey,
            );
          } catch (e) {
            plaintext = `DECRYPT_FAILED:${String(e)}`;
          }
          invs.push(
            inv(
              "stored_ciphertext_decrypts_to_issued_grant",
              plaintext === grants[0].refreshToken,
              `stored=${plaintext} issued=${grants[0].refreshToken}`,
            ),
          );
          invs.push(
            inv(
              "row_not_marked_revoked",
              rows[0].apple_revoked_at === null,
              `apple_revoked_at=${String(rows[0].apple_revoked_at)}`,
            ),
          );
        }
        // Every lane minted a session (GoTrue spent the id token N times) — the
        // losers' sessions are live sessions for the account. Observation only.
        const sessions = [...w.fake.sessions.values()].filter(
          (s) => s.userId === userId && !s.revoked,
        ).length;
        return {
          invariants: invs,
          statuses: results.map((r) => r.status),
          detail: { liveSessions: sessions },
        };
      },
    );
    assertCampaign(report);
  },
);

// ── R4 retry after transient fault ───────────────────────────────────────────
Deno.test(
  `stress-R4 transient fault on the first delete-confirm pass, clean retry burst — revoke checkpointed once, user deleted once`,
  async () => {
    const faults = [
      "rc_500",
      "rc_throw",
      "apple_503",
      "apple_throw",
      "apple_429",
      "apple_invalid_client",
      "rc_hang_then_ok",
    ] as const;
    const report = await campaign(
      "stress-R4-transient-fault-then-retry",
      "retry after transient",
      FILE,
      { burst: STRESS_BURST, faults: faults.length },
      STRESS_ITER,
      async (seed, round) => {
        const fault = faults[round % faults.length];
        let armed = true;
        const w = h.reset(seed, {
          apple: {
            revokeFault: () => {
              if (!armed || !fault.startsWith("apple")) return null;
              armed = false;
              if (fault === "apple_503") return { kind: "status", status: 503 };
              if (fault === "apple_429") return { kind: "status", status: 429, body: {} };
              if (fault === "apple_invalid_client")
                return { kind: "status", status: 400, body: { error: "invalid_client" } };
              return { kind: "throw" };
            },
          },
          rc: {
            deleteFault: () => {
              if (!armed || !fault.startsWith("rc")) return null;
              armed = false;
              if (fault === "rc_500") return { kind: "status", status: 500 };
              if (fault === "rc_hang_then_ok") return { kind: "delay", ms: 40 };
              return { kind: "throw" };
            },
          },
        });
        const a = await appleAccount(w, seed, "r4");
        const challenge = seedDeletionChallenge(w, a.userId);
        const first = await drive(
          h,
          0,
          "delete-confirm#1",
          deleteConfirmRequest(a.accessToken, challenge, ip(seed, 0)),
        );
        const invs: Invariant[] = [];
        const rowAfterFirst = credentialRow(w, a.userId);
        const revokedAfterFirst = rowAfterFirst?.apple_revoked_at != null;
        if (fault === "rc_hang_then_ok") {
          invs.push(inv("delayed_rc_still_200", first.status === 200, `status=${first.status}`));
        } else {
          invs.push(
            inv(
              "faulted_pass_is_503",
              first.status === 503,
              `status=${first.status} body=${JSON.stringify(first.body)}`,
            ),
          );
          invs.push(
            inv(
              "faulted_pass_did_not_delete_user",
              w.fake.users.has(a.userId),
              `userExists=${w.fake.users.has(a.userId)}`,
            ),
          );
          if (fault.startsWith("rc")) {
            invs.push(
              inv(
                "apple_revoked_and_checkpointed_before_rc_fault",
                w.apple.revokeCalls === 1 && revokedAfterFirst,
                `revokeCalls=${w.apple.revokeCalls} checkpoint=${revokedAfterFirst}`,
              ),
            );
            invs.push(
              inv(
                "rc_not_checkpointed_after_fault",
                rowAfterFirst?.revenuecat_deleted_at == null,
                `rc_deleted_at=${String(rowAfterFirst?.revenuecat_deleted_at)}`,
              ),
            );
          } else {
            invs.push(
              inv(
                "apple_transient_keeps_credential",
                rowAfterFirst?.apple_refresh_token_encrypted != null && !revokedAfterFirst,
                `token=${rowAfterFirst?.apple_refresh_token_encrypted != null} revoked=${revokedAfterFirst}`,
              ),
            );
            invs.push(
              inv(
                "apple_transient_no_rc_call",
                w.rc.deleteCalls === 0,
                `rcDeleteCalls=${w.rc.deleteCalls}`,
              ),
            );
          }
        }
        // Retry storm: the app retries; several devices/taps at once.
        const results = await Promise.all(
          Array.from({ length: DELETE_BURST - 1 }, (_, lane) =>
            drive(
              h,
              lane + 1,
              "delete-confirm#retry",
              deleteConfirmRequest(a.accessToken, challenge, ip(seed, lane + 1)),
            ),
          ),
        );
        if (fault !== "rc_hang_then_ok") invs.push(...deletionInvariants(w, a, results, true));
        else invs.push(...deletionInvariants(w, a, results, false));
        const revokeSuccesses = [...w.apple.grants.values()].filter((g) => g.revoked).length;
        invs.push(
          inv(
            "apple_grant_revoked_exactly_once_overall",
            revokeSuccesses === 1,
            `revokedGrants=${revokeSuccesses} revokeCalls=${w.apple.revokeCalls}`,
          ),
        );
        if (fault.startsWith("rc") && fault !== "rc_hang_then_ok") {
          invs.push(
            inv(
              "retry_did_not_call_apple_again",
              w.apple.revokeCalls === 1,
              `revokeCalls=${w.apple.revokeCalls}`,
            ),
          );
        }
        return {
          invariants: invs,
          statuses: [first.status, ...results.map((r) => r.status)],
          detail: {
            fault,
            firstStatus: first.status,
            appleRevokeCalls: w.apple.revokeCalls,
            rcDeleteCalls: w.rc.deleteCalls,
          },
        };
      },
      { knownBroken: EA1 },
    );
    assertCampaign(report);
  },
);

// ── R5 key rotation ──────────────────────────────────────────────────────────
Deno.test(
  `stress-R5 APPLE_TOKEN_ENCRYPTION_KEY rotated between bootstrap and delete-confirm ×${DELETE_BURST} — manual_action_required, ciphertext dropped, deleted once`,
  async () => {
    const report = await campaign(
      "stress-R5-key-rotation",
      "rotation during lifetime",
      FILE,
      { burst: DELETE_BURST },
      STRESS_ITER,
      async (seed) => {
        const w = h.reset(seed);
        const a = await appleAccount(w, seed, "r5");
        const challenge = seedDeletionChallenge(w, a.userId);
        const previous = h.encryptionKey;
        h.rotateEncryptionKey();
        try {
          const results = await Promise.all(
            Array.from({ length: DELETE_BURST }, (_, lane) =>
              drive(
                h,
                lane,
                "delete-confirm",
                deleteConfirmRequest(a.accessToken, challenge, ip(seed, lane)),
              ),
            ),
          );
          const invs = deletionInvariants(w, a, results, true);
          const ok = results.filter((r) => r.status === 200);
          invs.push(
            inv(
              "outcome_manual_action_required",
              ok.every((r) => r.body.appleAuthorizationRevocation === "manual_action_required"),
              ok.map((r) => String(r.body.appleAuthorizationRevocation)).join(","),
            ),
          );
          invs.push(
            inv(
              "apple_revoke_never_attempted",
              w.apple.revokeCalls === 0,
              `revokeCalls=${w.apple.revokeCalls}`,
            ),
          );
          // The Apple grant is still live at Apple (unrevocable by us) — the route
          // must SAY so (manual_action_required) — override the generic check.
          const idx = invs.findIndex((i) => i.name === "no_live_apple_grant_after_deletion");
          if (idx >= 0)
            invs[idx] = inv(
              "live_grant_disclosed_as_manual_action",
              ok.length > 0 &&
                ok.every((r) => r.body.appleAuthorizationRevocation === "manual_action_required"),
              invs[idx].detail,
            );
          return {
            invariants: invs,
            statuses: results.map((r) => r.status),
            detail: { rcDeleteCalls: w.rc.deleteCalls },
          };
        } finally {
          h.rotateEncryptionKey(previous);
        }
      },
      { knownBroken: EA1 },
    );
    assertCampaign(report);
  },
);

// ── R6 logout during delete-confirm ──────────────────────────────────────────
Deno.test(
  `stress-R6 logout of the same session while ×${DELETE_BURST} delete-confirms are in flight — every 200 is a deletion, no 5xx`,
  async () => {
    const report = await campaign(
      "stress-R6-logout-during-delete",
      "logout during request",
      FILE,
      { burst: DELETE_BURST + 1 },
      STRESS_ITER,
      async (seed) => {
        const w = h.reset(seed);
        const a = await appleAccount(w, seed, "r6");
        const challenge = seedDeletionChallenge(w, a.userId);
        const prng = new Prng(seed);
        const logoutAt = prng.int(0, DELETE_BURST);
        const lanes = Array.from({ length: DELETE_BURST + 1 }, (_, lane) =>
          lane === logoutAt
            ? drive(
                h,
                lane,
                "logout",
                edgeRequest("POST", "/v1/auth/logout", {
                  token: a.accessToken,
                  ip: ip(seed, lane),
                  body: {},
                }),
              )
            : drive(
                h,
                lane,
                "delete-confirm",
                deleteConfirmRequest(a.accessToken, challenge, ip(seed, lane)),
              ),
        );
        const results = await Promise.all(lanes);
        const invs = deletionInvariants(
          w,
          a,
          results.filter((r) => r.op !== "logout"),
          false,
        );
        const userGone = !w.fake.users.has(a.userId);
        const row = credentialRow(w, a.userId);
        // If the account survived (logout won), its credential state must be
        // consistent: either untouched, or revoked+checkpointed (a later retry
        // completes without a second revoke).
        if (!userGone) {
          const liveGrants = w.apple.liveGrantsFor(a.subject).length;
          const consistent =
            (row?.apple_revoked_at != null && liveGrants === 0) ||
            (row?.apple_revoked_at == null && liveGrants === 1);
          invs.push(
            inv(
              "survivor_checkpoint_consistent_with_apple",
              consistent,
              `apple_revoked_at=${String(row?.apple_revoked_at)} liveGrants=${liveGrants}`,
            ),
          );
        }
        return {
          invariants: invs,
          statuses: results.map((r) => r.status),
          detail: { logoutAt, userGone, ops: results.map((r) => `${r.op}:${r.status}`) },
        };
      },
      { knownBroken: EA1 },
    );
    assertCampaign(report);
  },
);

// ── R7 Google (no Apple credential) ──────────────────────────────────────────
Deno.test(
  `stress-R7 Google account delete-confirm duplicate delivery ×${DELETE_BURST} — one RC delete, ≤1 checkpoint row, deleted once`,
  async () => {
    const report = await campaign(
      "stress-R7-google-delete-duplicate",
      "duplicate delivery (google)",
      FILE,
      { burst: DELETE_BURST },
      STRESS_ITER,
      async (seed) => {
        const w = h.reset(seed);
        const a = await googleAccount(w, seed, "r7");
        const challenge = seedDeletionChallenge(w, a.userId);
        const results = await Promise.all(
          Array.from({ length: DELETE_BURST }, (_, lane) =>
            drive(
              h,
              lane,
              "delete-confirm",
              deleteConfirmRequest(a.accessToken, challenge, ip(seed, lane)),
            ),
          ),
        );
        const invs = deletionInvariants(w, a, results, true);
        invs.push(
          inv(
            "apple_never_called",
            w.apple.tokenCalls === 0 && w.apple.revokeCalls === 0,
            `token=${w.apple.tokenCalls} revoke=${w.apple.revokeCalls}`,
          ),
        );
        invs.push(
          inv(
            "outcome_not_applicable",
            results
              .filter((r) => r.status === 200)
              .every((r) => r.body.appleAuthorizationRevocation === "not_applicable"),
            "",
          ),
        );
        const rcSuccess = w.rc.deletedAtCall.has(a.userId);
        invs.push(
          inv("rc_deleted_exactly_once_(rest_404)", rcSuccess, `deleteCalls=${w.rc.deleteCalls}`),
        );
        return {
          invariants: invs,
          statuses: results.map((r) => r.status),
          detail: { rcDeleteCalls: w.rc.deleteCalls },
        };
      },
      { knownBroken: EA1 },
    );
    assertCampaign(report);
  },
);

// ── R8 clock skew ────────────────────────────────────────────────────────────
Deno.test(
  `stress-R8 edge clock skewed vs Apple ×${STRESS_BURST} — within tolerance succeeds; beyond it 503 + credential kept (never dropped)`,
  async () => {
    // Apple (as modelled): iat may not be > 60 s in the future; exp (= iat +
    // 300 s) may not be > 60 s in the past. So the edge clock may run up to
    // 60 s fast or 360 s slow.
    const skews = [0, 30_000, -30_000, 59_000, 120_000, -300_000, 3_600_000, -3_600_000];
    const appleAccepts = (skewMs: number) => skewMs <= 60_000 && skewMs >= -360_000;
    const realNow = Date.now;
    try {
      const report = await campaign(
        "stress-R8-clock-skew",
        "clock skew",
        FILE,
        { burst: STRESS_BURST, skews: skews.length },
        STRESS_ITER,
        async (seed, round) => {
          const skewMs = skews[round % skews.length];
          const withinTolerance = appleAccepts(skewMs);
          // Apple keeps the true clock; the EDGE clock is skewed.
          const w = h.reset(seed, { apple: { now: () => realNow() } });
          Date.now = () => realNow() + skewMs;
          let a: Account;
          const invs: Invariant[] = [];
          try {
            const subject = subjectFor(seed, "apple-r8");
            const boots = await Promise.all(
              Array.from({ length: STRESS_BURST }, (_, lane) =>
                drive(h, lane, "bootstrap", appleBootstrapRequest(w, subject, ip(seed, lane))),
              ),
            );
            if (withinTolerance) {
              invs.push(
                inv(
                  "skew_within_tolerance_bootstraps_200",
                  boots.every((r) => r.status === 200),
                  boots.map((r) => `${r.status}:${r.code ?? ""}`).join(","),
                ),
              );
            } else {
              invs.push(
                inv(
                  "skew_beyond_tolerance_bootstraps_503_not_401",
                  boots.every((r) => r.status === 503),
                  boots.map((r) => `${r.status}:${r.code ?? ""}`).join(","),
                ),
              );
              invs.push(
                inv(
                  "apple_saw_invalid_client_only",
                  w.apple.secretRejections.length === boots.length && w.apple.grants.size === 0,
                  `rejections=${w.apple.secretRejections.slice(0, 3).join(",")} grants=${w.apple.grants.size}`,
                ),
              );
              return { invariants: invs, statuses: boots.map((r) => r.status), detail: { skewMs } };
            }
            const userId = String((isRecord(boots[0].body.user) ? boots[0].body.user : {}).id);
            const session = isRecord(boots[0].body.session) ? boots[0].body.session : {};
            a = {
              subject,
              userId,
              accessToken: String(session.accessToken),
              refreshToken: String(session.refreshToken),
            };
            w.rc.subscribers.add(userId);
            // N bootstraps issued N grants and the row holds the LAST upsert's
            // token. Only one grant can be revoked by us — see R2 for the
            // multi-device consequence; here we check the row is exactly one and
            // decrypts to one of the issued grants.
            const rows = credentialRows(w, userId);
            invs.push(inv("exactly_one_credential_row", rows.length === 1, `rows=${rows.length}`));
            // Deletion under a different skew — the challenge is minted on the
            // same (skewed) edge clock the route will age it against.
            const deleteSkew = skews[(round + 3) % skews.length];
            Date.now = () => realNow() + deleteSkew;
            const challenge = seedDeletionChallenge(w, userId);
            const results = await Promise.all(
              Array.from({ length: DELETE_BURST }, (_, lane) =>
                drive(
                  h,
                  lane,
                  "delete-confirm",
                  deleteConfirmRequest(a.accessToken, challenge, ip(seed, lane)),
                ),
              ),
            );
            if (appleAccepts(deleteSkew)) {
              invs.push(
                ...deletionInvariants(w, a, results, true).filter(
                  (i) => i.name !== "no_live_apple_grant_after_deletion",
                ),
              );
              invs.push(
                inv(
                  "stored_grant_revoked",
                  [...w.apple.grants.values()].some((g) => g.subject === subject && g.revoked),
                  "",
                ),
              );
            } else {
              invs.push(
                inv(
                  "skewed_delete_is_503",
                  results.every((r) => r.status === 503),
                  results.map((r) => `${r.status}:${r.code ?? ""}`).join(","),
                ),
              );
              invs.push(inv("skewed_delete_keeps_user", w.fake.users.has(userId), ""));
              const row = credentialRow(w, userId);
              invs.push(
                inv(
                  "skewed_delete_keeps_credential_not_dropped",
                  row?.apple_refresh_token_encrypted != null && row.apple_revoked_at == null,
                  `token=${row?.apple_refresh_token_encrypted != null} revoked_at=${String(row?.apple_revoked_at)}`,
                ),
              );
              invs.push(
                inv(
                  "skewed_delete_no_rc_delete",
                  w.rc.deleteCalls === 0,
                  `rcDeleteCalls=${w.rc.deleteCalls}`,
                ),
              );
            }
            return {
              invariants: invs,
              statuses: results.map((r) => r.status),
              detail: { skewMs, deleteSkew },
            };
          } finally {
            Date.now = realNow;
          }
        },
        { knownBroken: EA1 },
      );
      assertCampaign(report);
    } finally {
      Date.now = realNow;
    }
  },
);

// ── Sanity: the harness models what the route relies on ──────────────────────
Deno.test(
  "stress harness sanity: Apple fake refuses a bad client_secret, one-use codes, idempotent revoke; admin delete cascades",
  async () => {
    const w = h.reset(1);
    const a = await appleAccount(w, 1, "sanity");
    assert(credentialRow(w, a.userId));
    assertEquals(w.apple.liveGrantsFor(a.subject).length, 1);
    // second exchange of the same code
    const usedCode = [...w.apple.codes.keys()][0];
    const dup = await drive(
      h,
      0,
      "bootstrap",
      appleBootstrapRequest(w, a.subject, "192.0.2.1", { code: usedCode }),
    );
    assertEquals(dup.status, 401);
    assertEquals(dup.code, "auth.apple_authorization_invalid");
    const challenge = seedDeletionChallenge(w, a.userId);
    const del = await drive(
      h,
      0,
      "delete-confirm",
      deleteConfirmRequest(a.accessToken, challenge, "192.0.2.1"),
    );
    assertEquals(del.status, 200, JSON.stringify(del.body));
    assertEquals(del.body.appleAuthorizationRevocation, "revoked");
    assertEquals(w.apple.liveGrantsFor(a.subject).length, 0);
    assertEquals(w.fake.users.has(a.userId), false);
    assertEquals(credentialRows(w, a.userId).length, 0);
    assertEquals(w.rc.subscribers.has(a.userId), false);
  },
);
