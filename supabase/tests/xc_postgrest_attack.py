#!/usr/bin/env python3
"""Cross-user isolation attack client against a REAL PostgREST.

The SQL harness (xc_cross_user_isolation.sql) proves the database boundary with
`set role` + a JWT-sub GUC. This script proves the same boundary through the
wire protocol the iOS app and the edge function actually speak: PostgREST with
an HS256 bearer token, `Prefer: resolution=merge-duplicates|ignore-duplicates`
upserts, embedded-resource selects (`select=*,shots(*)`), horizontal filters,
`?columns=`, RPC POSTs, and header-level role forgery.

Stdlib only (hmac/base64/json/urllib) so it runs with the repo's plain python3.
Every probe is recorded with its exact method, path, headers-of-interest, body
and response so a failure is replayable verbatim from the JSON artifact.

Usage:
  xc_postgrest_attack.py --base-url http://127.0.0.1:3999 --jwt-secret <s> \
      --ids ids.json --out out_dir

Exit: 0 all probes passed, 1 an isolation probe FAILED, 2 setup/transport error.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

TIMEOUT = 20


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def make_jwt(
    secret: str, sub: str | None, role: str, extra: dict[str, Any] | None = None
) -> str:
    """HS256 token shaped like a Supabase access token."""
    header = {"alg": "HS256", "typ": "JWT"}
    now = int(time.time())
    payload: dict[str, Any] = {
        "role": role,
        "iss": "supabase",
        "iat": now,
        "exp": now + 3600,
    }
    if sub is not None:
        payload["sub"] = sub
        payload["aud"] = "authenticated"
    if extra:
        payload.update(extra)
    signing_input = (
        f"{b64url(json.dumps(header).encode())}.{b64url(json.dumps(payload).encode())}"
    )
    sig = hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).digest()
    return f"{signing_input}.{b64url(sig)}"


class Harness:
    def __init__(self, base_url: str, secret: str, ids: dict[str, str]) -> None:
        self.base_url = base_url.rstrip("/")
        self.secret = secret
        self.ids = ids
        self.results: list[dict[str, Any]] = []
        self.tokens: dict[tuple[str | None, str], str] = {}

    def uid(self, name: str) -> str:
        return self.ids[name]

    def token(self, actor: str | None, role: str = "authenticated") -> str:
        key = (actor, role)
        if key not in self.tokens:
            self.tokens[key] = make_jwt(
                self.secret, self.uid(actor) if actor else None, role
            )
        return self.tokens[key]

    def request(
        self,
        method: str,
        path: str,
        *,
        token: str | None,
        body: Any = None,
        prefer: str | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> tuple[int, str]:
        url = f"{self.base_url}{path}"
        data = None
        headers: dict[str, str] = {"Accept": "application/json"}
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if prefer:
            headers["Prefer"] = prefer
        if extra_headers:
            headers.update(extra_headers)
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                return resp.status, resp.read().decode(errors="replace")
        except urllib.error.HTTPError as err:  # PostgREST denials arrive as 4xx
            return err.code, err.read().decode(errors="replace")

    # ------------------------------------------------------------------
    def probe(
        self,
        section: str,
        scenario: str,
        *,
        method: str,
        path: str,
        actor: str | None,
        role: str = "authenticated",
        body: Any = None,
        prefer: str | None = None,
        extra_headers: dict[str, str] | None = None,
        expect_rows: int | None = None,
        expect_status: tuple[int, ...] | None = None,
        expect_body_contains: str | None = None,
        expect_body_excludes: tuple[str, ...] = (),
        severity: str = "P0",
        token: str | None = None,
    ) -> bool:
        bearer = (
            token
            if token is not None
            else (self.token(actor, role) if actor or role else None)
        )
        status, text = self.request(
            method,
            path,
            token=bearer,
            body=body,
            prefer=prefer,
            extra_headers=extra_headers,
        )
        rows: int | None = None
        try:
            parsed = json.loads(text) if text.strip() else None
            if isinstance(parsed, list):
                rows = len(parsed)
        except json.JSONDecodeError:
            parsed = None

        checks: list[str] = []
        ok = True
        if expect_status is not None:
            checks.append(f"status in {list(expect_status)}")
            ok = ok and status in expect_status
        if expect_rows is not None:
            # A 4xx denial is a stronger outcome than "0 rows": only enforce the
            # row count when PostgREST actually executed the statement.
            checks.append(f"rows={expect_rows} (when 2xx)")
            if status < 300:
                ok = ok and rows == expect_rows
        if expect_body_contains is not None:
            checks.append(f"body~{expect_body_contains!r}")
            ok = ok and expect_body_contains in text
        for needle in expect_body_excludes:
            checks.append(f"body!~{needle!r}")
            ok = ok and needle not in text

        self.results.append(
            {
                "section": section,
                "scenario": scenario,
                "severity": severity,
                "actor": actor,
                "actor_role": role,
                "method": method,
                "path": path,
                "prefer": prefer,
                "extra_headers": extra_headers,
                "request_body": body,
                "expectation": " AND ".join(checks),
                "status": status,
                "rows": rows,
                "response_body": text[:2000],
                "pass": ok,
            }
        )
        if not ok:
            print(
                f"XC-HTTP FAIL [{section}] {scenario} :: expected {' AND '.join(checks)} "
                f"observed status={status} rows={rows} body={text[:300]}",
                file=sys.stderr,
            )
        return ok


def build_probes(h: Harness) -> None:
    alice, bob = "alice", "bob"
    a_shot = h.uid("shot_a")
    a_session = h.uid("sess_a")
    a_permit = h.uid("permit_a2")
    a_capture = h.uid("cap_a")
    b_session = h.uid("sess_b")
    denied = (401, 403)

    # --- R: cross-user reads must come back empty (200 + []) ---------------
    for table, key, val in [
        ("shots", "id", a_shot),
        ("sessions", "id", a_session),
        ("analysis_permits", "id", a_permit),
        ("captures", "id", a_capture),
        ("profiles", "id", h.uid(alice)),
        ("billing_entitlements", "user_id", h.uid(alice)),
        ("account_deletion_requests", "user_id", h.uid(alice)),
        ("user_saved_drills", "user_id", h.uid(alice)),
        ("shot_phases", "shot_id", a_shot),
        ("shot_measurements", "shot_id", a_shot),
        ("shot_checkpoints", "shot_id", a_shot),
        ("consent_records", "user_id", h.uid(alice)),
        ("evaluation_trials", "user_id", h.uid(alice)),
        ("player_rank_state", "user_id", h.uid(alice)),
    ]:
        h.probe(
            "R",
            f"R {table} filtered to alice {key}",
            method="GET",
            path=f"/{table}?{key}=eq.{val}",
            actor=bob,
            expect_status=(200,),
            expect_rows=0,
        )
    # Unfiltered reads must only ever return Bob's own rows.
    h.probe(
        "R",
        "R unfiltered shots returns only bob rows",
        method="GET",
        path=f"/shots?select=user_id&user_id=neq.{h.uid(bob)}",
        actor=bob,
        expect_status=(200,),
        expect_rows=0,
    )
    h.probe(
        "R",
        "R unfiltered profiles returns only bob",
        method="GET",
        path=f"/profiles?select=id&id=neq.{h.uid(bob)}",
        actor=bob,
        expect_status=(200,),
        expect_rows=0,
    )
    # Embedded resources are the classic RLS bypass vector.
    h.probe(
        "R",
        "R embed sessions->shots cannot surface alice children",
        method="GET",
        path=f"/sessions?select=id,shots(id,user_id)&id=eq.{a_session}",
        actor=bob,
        expect_status=(200,),
        expect_rows=0,
    )
    h.probe(
        "R",
        "R embed shots->shot_phases through bob session leaks nothing of alice",
        method="GET",
        path="/shots?select=id,user_id,shot_phases(shot_id,phase_key)",
        actor=bob,
        expect_status=(200,),
        expect_body_contains=h.uid(bob),
        expect_body_excludes=(h.uid(alice), a_shot),
    )
    h.probe(
        "R",
        "R embed profiles(*) through bob rows never resolves alice profile",
        method="GET",
        path="/sessions?select=id,user_id,profiles(id,first_name)",
        actor=bob,
        expect_status=(200, 300, 400),
        expect_body_excludes=(h.uid(alice), "Alice"),
    )
    h.probe(
        "R",
        "R embed profiles->sessions,shots for alice id",
        method="GET",
        path=f"/profiles?select=id,sessions(id),shots(id)&id=eq.{h.uid(alice)}",
        actor=bob,
        expect_status=(200,),
        expect_rows=0,
    )
    # Aggregate/count oracles: a HEAD with count must not reveal foreign rows.
    h.probe(
        "R",
        "R count oracle on alice shots (Prefer count=exact)",
        method="GET",
        path=f"/shots?select=id&id=eq.{a_shot}",
        actor=bob,
        prefer="count=exact",
        expect_status=(200,),
        expect_rows=0,
    )
    # Derived views inherit the base-table RLS.
    for view in ("player_technique_rating", "practice_days", "progress_daily"):
        h.probe(
            "R",
            f"R view {view} scoped to caller",
            method="GET",
            path=f"/{view}?select=*&user_id=neq.{h.uid(bob)}",
            actor=bob,
            expect_status=(200,),
            expect_rows=0,
        )
    # Service-only tables must not be reachable at all.
    for table in (
        "free_rating_ledger",
        "webhook_events",
        "account_external_credentials",
    ):
        h.probe(
            "R",
            f"R service-only table {table} unreachable",
            method="GET",
            path=f"/{table}?select=*",
            actor=bob,
            expect_status=(401, 403, 404),
        )

    # --- W: cross-user writes / owner reassignment ------------------------
    h.probe(
        "W",
        "W patch alice session ended_at",
        method="PATCH",
        path=f"/sessions?id=eq.{a_session}",
        actor=bob,
        body={"ended_at": "2026-09-04T00:00:00Z"},
        prefer="return=representation",
        expect_status=(200, 204, 401, 403, 404),
        expect_rows=0,
    )
    h.probe(
        "W",
        "W reassign own session to alice (owner takeover)",
        method="PATCH",
        path=f"/sessions?id=eq.{b_session}",
        actor=bob,
        body={"user_id": h.uid(alice)},
        expect_status=denied + (400, 404),
    )
    h.probe(
        "W",
        "W patch alice profile",
        method="PATCH",
        path=f"/profiles?id=eq.{h.uid(alice)}",
        actor=bob,
        body={"first_name": "pwned"},
        prefer="return=representation",
        expect_status=(200, 204) + denied + (404,),
        expect_rows=0,
    )
    h.probe(
        "W",
        "W patch alice permit status",
        method="PATCH",
        path=f"/analysis_permits?id=eq.{a_permit}",
        actor=bob,
        body={"status": "finalized", "outcome": "scored"},
        prefer="return=representation",
        expect_status=(200, 204) + denied + (404,),
        expect_rows=0,
    )
    h.probe(
        "W",
        "W patch alice billing to premium",
        method="PATCH",
        path=f"/billing_entitlements?user_id=eq.{h.uid(alice)}",
        actor=bob,
        body={"premium": False},
        expect_status=denied + (400, 404),
    )
    h.probe(
        "W",
        "W grant self premium via billing insert",
        method="POST",
        path="/billing_entitlements",
        actor=bob,
        body={
            "user_id": h.uid(bob),
            "premium": True,
            "product_key": "pickle_sensei_pro_annual",
        },
        expect_status=denied + (400, 404),
    )
    h.probe(
        "W",
        "W insert shot owned by alice",
        method="POST",
        path="/shots",
        actor=bob,
        body={
            "id": "20000000-0000-4000-8000-0000000000ff",
            "user_id": h.uid(alice),
            "session_id": b_session,
            "shot_type": "drive",
            "result_kind": "scored",
            "overall_score": 7,
            "analysis_confidence": 0.9,
            "start_ms": 0,
            "end_ms": 1000,
            "captured_at": "2026-09-04T00:00:00Z",
        },
        expect_status=denied + (400, 404),
    )
    h.probe(
        "W",
        "W patch alice shot (no client update grant at all)",
        method="PATCH",
        path=f"/shots?id=eq.{a_shot}",
        actor=bob,
        body={"result_kind": "abstained"},
        expect_status=denied + (400, 404),
    )
    h.probe(
        "W",
        "W patch alice deletion request challenge",
        method="PATCH",
        path=f"/account_deletion_requests?user_id=eq.{h.uid(alice)}",
        actor=bob,
        body={"challenge": "xc-pwned"},
        prefer="return=representation",
        expect_status=(200, 204) + denied + (404,),
        expect_rows=0,
    )
    h.probe(
        "W",
        "W ?columns= smuggles user_id past the payload",
        method="POST",
        path="/user_saved_drills?columns=user_id,slug",
        actor=bob,
        body={"user_id": h.uid(alice), "slug": "xc-http-smuggle"},
        expect_status=denied + (400, 404, 409),
    )

    # --- D: cross-user deletes -------------------------------------------
    for table, key, val in [
        ("shots", "id", a_shot),
        ("sessions", "id", a_session),
        ("analysis_permits", "id", a_permit),
        ("captures", "id", a_capture),
        ("user_saved_drills", "user_id", h.uid(alice)),
        ("account_deletion_requests", "user_id", h.uid(alice)),
        ("profiles", "id", h.uid(alice)),
        ("billing_entitlements", "user_id", h.uid(alice)),
        ("shot_phases", "shot_id", a_shot),
        ("consent_records", "user_id", h.uid(alice)),
    ]:
        h.probe(
            "D",
            f"D delete alice rows from {table}",
            method="DELETE",
            path=f"/{table}?{key}=eq.{val}",
            actor=bob,
            prefer="return=representation",
            expect_status=(200, 204) + denied + (400, 404),
            expect_rows=0,
        )
    # Broad DELETE: everything that is NOT bob's must be untouchable.
    h.probe(
        "D",
        "D delete every session not owned by bob",
        method="DELETE",
        path=f"/sessions?user_id=neq.{h.uid(bob)}",
        actor=bob,
        prefer="return=representation",
        expect_status=(200, 204, 400) + denied,
        expect_rows=0,
    )

    # --- P: PostgREST upsert semantics -----------------------------------
    h.probe(
        "P",
        "P merge-duplicates upsert onto alice session id",
        method="POST",
        path="/sessions",
        actor=bob,
        body={
            "id": a_session,
            "user_id": h.uid(bob),
            "started_at": "2026-09-04T00:00:00Z",
        },
        prefer="resolution=merge-duplicates,return=representation",
        expect_status=denied + (400, 404, 409),
    )
    h.probe(
        "P",
        "P ignore-duplicates upsert onto alice session id",
        method="POST",
        path="/sessions",
        actor=bob,
        body={
            "id": a_session,
            "user_id": h.uid(bob),
            "started_at": "2026-09-04T00:00:00Z",
        },
        prefer="resolution=ignore-duplicates,return=representation",
        expect_status=(200, 201, 204) + denied + (400, 404, 409),
        expect_rows=0,
    )
    h.probe(
        "P",
        "P merge-duplicates upsert onto alice deletion request",
        method="POST",
        path="/account_deletion_requests",
        actor=bob,
        body={
            "user_id": h.uid(alice),
            "challenge": "30000000-0000-4000-8000-000000000a0a",
            "expires_at": "2026-09-05T00:00:00Z",
        },
        prefer="resolution=merge-duplicates,return=representation",
        expect_status=denied + (400, 404, 409),
    )
    h.probe(
        "P",
        "P merge-duplicates upsert onto alice saved drill",
        method="POST",
        path="/user_saved_drills",
        actor=bob,
        body={"user_id": h.uid(alice), "slug": "xc-alice-drill"},
        prefer="resolution=merge-duplicates,return=representation",
        expect_status=denied + (400, 404, 409),
    )
    h.probe(
        "P",
        "P upsert on_conflict=user_id,idempotency_key onto alice permit",
        method="POST",
        path="/analysis_permits?on_conflict=user_id,idempotency_key",
        actor=bob,
        body={
            "user_id": h.uid(alice),
            "idempotency_key": "xc-alice-key-2",
            "status": "finalized",
        },
        prefer="resolution=merge-duplicates,return=representation",
        expect_status=denied + (400, 404, 409),
    )
    h.probe(
        "P",
        "P90 owner control: bob upserts his OWN deletion request (must succeed)",
        method="POST",
        path="/account_deletion_requests",
        actor=bob,
        body={
            "user_id": h.uid(bob),
            "challenge": "30000000-0000-4000-8000-000000000b0b",
            "expires_at": "2026-09-05T00:00:00Z",
        },
        prefer="resolution=merge-duplicates,return=representation",
        expect_status=(200, 201),
        expect_rows=1,
        severity="P1",
    )

    # --- X: RPC over HTTP -------------------------------------------------
    h.probe(
        "X",
        "X rpc access_state is caller-scoped (bob not premium)",
        method="POST",
        path="/rpc/access_state",
        actor=bob,
        body={},
        expect_status=(200,),
        expect_body_contains='"premium":false',
    )
    h.probe(
        "X",
        "X rpc apply_synced_shot with alice permit",
        method="POST",
        path="/rpc/apply_synced_shot",
        actor=bob,
        body={
            "shot": {
                "id": "20000000-0000-4000-8000-0000000000fe",
                "analysisPermitId": a_permit,
                "sessionId": b_session,
                "resultKind": "scored",
                "capturedAt": "2026-09-04T00:00:00Z",
                "userId": h.uid(alice),
            }
        },
        expect_status=(200,),
        expect_body_contains="access.permit_not_found",
    )
    h.probe(
        "X",
        "X rpc apply_synced_shot into alice session",
        method="POST",
        path="/rpc/apply_synced_shot",
        actor=bob,
        body={
            "shot": {
                "id": "20000000-0000-4000-8000-0000000000fd",
                "analysisPermitId": h.uid("permit_b1"),
                "sessionId": a_session,
                "resultKind": "scored",
                "capturedAt": "2026-09-04T00:00:00Z",
            }
        },
        expect_status=(200,),
        expect_body_contains="shot.session_not_found",
    )
    h.probe(
        "X",
        "X rpc recompute_player_rank(alice) not exposed",
        method="POST",
        path="/rpc/recompute_player_rank",
        actor=bob,
        body={"p_user_id": h.uid(alice)},
        expect_status=(401, 403, 404),
    )
    h.probe(
        "X",
        "X rpc free_rating_identity_hash not exposed",
        method="POST",
        path="/rpc/free_rating_identity_hash",
        actor=bob,
        body={"p_provider": "google", "p_provider_id": "xc-google-sub-alice"},
        expect_status=(401, 403, 404),
    )
    h.probe(
        "X",
        "X rpc identity_scored_count takes no args (cannot target alice)",
        method="POST",
        path="/rpc/identity_scored_count",
        actor=bob,
        body={"p_uid": h.uid(alice)},
        expect_status=(400, 404) + denied,
    )

    # --- A: token / role forgery -----------------------------------------
    h.probe(
        "A",
        "A anon token with alice sub",
        method="GET",
        path="/shots?select=*",
        actor=alice,
        role="anon",
        expect_status=(401, 403, 404),
    )
    h.probe(
        "A",
        "A no token at all",
        method="GET",
        path="/shots?select=*",
        actor=None,
        role="anon",
        token="",
        expect_status=(401, 403, 404),
    )
    h.probe(
        "A",
        "A forged service_role token signed with the wrong secret",
        method="GET",
        path="/billing_entitlements?select=*",
        actor=None,
        role="service_role",
        token=make_jwt(
            "xc-wrong-secret-000000000000000000000000", None, "service_role"
        ),
        expect_status=(401, 403),
    )
    h.probe(
        "A",
        "A unsigned (alg=none style) token",
        method="GET",
        path="/shots?select=*",
        actor=None,
        role="authenticated",
        token=(
            base64.urlsafe_b64encode(b'{"alg":"none","typ":"JWT"}')
            .rstrip(b"=")
            .decode()
            + "."
            + base64.urlsafe_b64encode(json.dumps({"role": "service_role"}).encode())
            .rstrip(b"=")
            .decode()
            + "."
        ),
        expect_status=(401, 403),
    )
    h.probe(
        "A",
        "A bob token + forged Role-ish headers",
        method="GET",
        path=f"/shots?id=eq.{a_shot}",
        actor=bob,
        extra_headers={
            "X-Client-Role": "service_role",
            "Role": "service_role",
            "X-Forwarded-Role": "service_role",
        },
        expect_status=(200,),
        expect_rows=0,
    )
    h.probe(
        "A",
        "A design check: correctly-signed service_role claim bypasses RLS (JWT secret is the trust root, server-only)",
        method="GET",
        path="/billing_entitlements?select=*",
        actor=None,
        role="service_role",
        token=make_jwt(h.secret, h.uid(bob), "service_role"),
        expect_status=(200,),
        severity="P1",
    )

    # --- Owner controls: the denials above must not be vacuous ------------
    h.probe(
        "O",
        "O90 bob reads his own shots",
        method="GET",
        path="/shots?select=id,user_id",
        actor=bob,
        expect_status=(200,),
        severity="P1",
        expect_body_contains=h.uid(bob),
        expect_body_excludes=(h.uid(alice),),
    )
    h.probe(
        "O",
        "O91 bob patches his own session ended_at",
        method="PATCH",
        path=f"/sessions?id=eq.{b_session}",
        actor=bob,
        body={"ended_at": "2026-09-04T01:00:00Z"},
        prefer="return=representation",
        expect_status=(200,),
        expect_rows=1,
        severity="P1",
    )
    h.probe(
        "O",
        "O92 bob reads his own access_state",
        method="POST",
        path="/rpc/access_state",
        actor=bob,
        body={},
        expect_status=(200,),
        severity="P1",
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--jwt-secret", required=True)
    ap.add_argument("--ids", required=True, help="ids.json exported from xc.ids")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    raw = json.loads(Path(args.ids).read_text())
    ids = {row["name"]: row["id"] for row in raw}

    h = Harness(args.base_url, args.jwt_secret, ids)
    status, text = h.request("GET", "/", token=h.token("bob"))
    if status not in (200, 404):
        print(
            f"PostgREST not reachable: status={status} body={text[:300]}",
            file=sys.stderr,
        )
        return 2

    build_probes(h)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "http_results.json").write_text(json.dumps(h.results, indent=2))
    failures = [r for r in h.results if not r["pass"]]
    (out / "http_failures.json").write_text(json.dumps(failures, indent=2))
    summary = {
        "base_url": args.base_url,
        "total": len(h.results),
        "passed": sum(1 for r in h.results if r["pass"]),
        "failed": len(failures),
        "failed_p0": sum(1 for r in failures if r["severity"] == "P0"),
        "by_section": {
            s: {
                "total": sum(1 for r in h.results if r["section"] == s),
                "passed": sum(1 for r in h.results if r["section"] == s and r["pass"]),
            }
            for s in sorted({r["section"] for r in h.results})
        },
    }
    (out / "http_summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
