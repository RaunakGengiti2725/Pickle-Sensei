#!/usr/bin/env python3
"""Parallel-session concurrency matrix for the Supabase access-control SQL.

Drives N sessions (one psycopg connection each, released from a barrier so the
calls overlap) against a THROWAWAY Postgres that already has shim_auth.sql and
every migration applied, under READ COMMITTED (PostgREST's default and hence
production), SERIALIZABLE, and REPEATABLE READ (observation only). Every
scenario is seeded; the seed, every user id, permit key and shot payload are
written to results.json, and each invariant violation (or round with a deadlock /
shot.write_failed) additionally gets a stand-alone replay script under repro/:
the round's fixture SQL verbatim, then one psql per worker launched together,
then the invariant witness queries (--repro-all writes one for every round).

Scenarios (each x isolation level):
  reserve_distinct_keys       N reserve_analysis_permit() calls, distinct keys, free user
  reserve_same_key            N reserve_analysis_permit() calls, ONE key (idempotent replay)
  reserve_premium             N reserve calls for a premium user (bypass must not deny)
  sync_forged_permits         N apply_synced_shot() scored syncs, N distinct pre-issued permits
  sync_same_shot              N apply_synced_shot() replays of ONE shot + permit
  reserve_sync_mixed          reserves and scored/abstained syncs racing on one account
  ledger_direct_writes        N service-role scored inserts + low_confidence->scored updates
                              for a user with two identities (trigger arithmetic)
  delete_vs_writes            auth.users delete racing reserve + sync on the same account,
                              then re-creation with the same identity
  delete_cascade_scale        heap numbers: cascade of a large account while other
                              users keep syncing (cross-user interference)
  sweep_vs_sync               pg_cron stale-permit sweep racing a sync at the 24h boundary

Invariants are checked by a superuser connection after every round; the
process exits non-zero when any invariant fails under a gated isolation level
(READ COMMITTED or SERIALIZABLE). REPEATABLE READ results are recorded but do
not gate — PostgREST never runs these functions under it.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import random
import sys
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from collections.abc import Callable
from typing import Any

import psycopg

ISOLATIONS = {
    "read_committed": "READ COMMITTED",
    "serializable": "SERIALIZABLE",
    "repeatable_read": "REPEATABLE READ",
}
GATED_ISOLATIONS = ("read_committed", "serializable")

RESERVE_SQL = "select result || ':' || coalesce(permit_id::text, '') from public.reserve_analysis_permit(%s)"
SERIALIZATION_FAILURE = "40001"
DEADLOCK_DETECTED = "40P01"
UNIQUE_VIOLATION = "23505"
FK_VIOLATION = "23503"

PHASES = ["ready", "prepare", "accelerate", "contact", "follow_through", "recover"]
CHECKPOINTS = ["paddle_ready", "knee_bend", "contact_point", "follow_through", "recovery"]
VERSION_VECTOR = {
    "appVersion": "1.0.0-concurrency",
    "modelBundleVersion": "bundle-1",
    "poseModelVersion": "pose-1",
    "paddleModelVersion": "paddle-1",
    "strokeDetectorVersion": "stroke-1",
    "phaseModelVersion": "phase-1",
    "scoringModelVersion": "scoring-1",
    "shotConfigVersion": "config-1",
}
USER_TABLES = [
    "profiles",
    "sessions",
    "shots",
    "shot_phases",
    "shot_measurements",
    "shot_checkpoints",
    "analysis_permits",
    "player_rank_state",
    "billing_entitlements",
    "consent_records",
    "captures",
    "analysis_feedback",
    "account_deletion_requests",
]
HEAP_TABLES = [
    "shots",
    "shot_phases",
    "shot_checkpoints",
    "shot_measurements",
    "analysis_permits",
    "free_rating_ledger",
    "player_rank_state",
    "profiles",
    "sessions",
]


# ─────────────────────────── result records ───────────────────────────


@dataclass
class Outcome:
    worker: int
    op: str
    ok: bool
    value: str | None
    sqlstate: str | None
    error: str | None
    ms: float
    uid: str | None = None  # auth.uid() the statement ran as (None = superuser)
    sql: str | None = None  # the exact statement with literals, for replay


def sql_literal(v: Any) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, (list, tuple)):
        return "ARRAY[" + ", ".join(sql_literal(x) for x in v) + "]"
    return "'" + str(v).replace("'", "''") + "'"


def render_sql(stmt: str, params: tuple) -> str:
    """Substitute psycopg %s placeholders with SQL literals (replay scripts only;
    the live harness always sends parameters server-side)."""
    parts = stmt.split("%s")
    if len(parts) - 1 != len(params):
        raise ValueError(f"placeholder/param mismatch: {stmt!r} {params!r}")
    out = parts[0]
    for part, val in zip(parts[1:], params, strict=True):
        out += sql_literal(val) + part
    return out


# Fixture statements issued while a round is being set up (reset per round by
# main, copied into the round's inputs so the repro script can recreate them).
FIXTURE_SQL: list[tuple[str, str]] = []  # (phase, sql); phase = "pre" | "post" the race
FIXTURE_PHASE: list[str] = ["pre"]


@dataclass
class RoundResult:
    round: int
    inputs: dict[str, Any]
    outcomes: list[Outcome]
    status_histogram: dict[str, int]
    invariants: list[dict[str, Any]]
    passed: bool
    observations: dict[str, Any] = field(default_factory=dict)


@dataclass
class ScenarioResult:
    scenario: str
    isolation: str
    gated: bool
    workers: int
    rounds: list[RoundResult]
    passed: bool
    wall_ms: float
    notes: list[str] = field(default_factory=list)


# ─────────────────────────── helpers ───────────────────────────


def det_uuid(rng: random.Random) -> str:
    return str(uuid.UUID(int=rng.getrandbits(128), version=4))


def identity_hash(provider: str, provider_id: str) -> str:
    return hashlib.sha256(f"{provider}:{provider_id}".encode()).hexdigest()


def is_serialization(o: Outcome) -> bool:
    """40001 surfaced as SQLSTATE, or swallowed by apply_synced_shot's `when others` and
    returned as shot.write_failed:<could not serialize ...> (transaction still commits)."""
    if not o.ok:
        return o.sqlstate == SERIALIZATION_FAILURE
    return bool(o.value) and o.value.startswith("shot.write_failed:could not serialize")


def status_key(o: Outcome) -> str:
    if o.ok:
        v = o.value or "<null>"
        return v.split(":", 1)[0] if ":" in v else v
    return f"ERR:{o.sqlstate}"


def histogram(outcomes: list[Outcome]) -> dict[str, int]:
    h: dict[str, int] = {}
    for o in outcomes:
        k = status_key(o)
        h[k] = h.get(k, 0) + 1
    return dict(sorted(h.items()))


class Db:
    """Thin wrapper: one autocommit connection; explicit BEGIN/COMMIT per op."""

    def __init__(self, url: str):
        self.conn = psycopg.connect(url, autocommit=True)

    def close(self) -> None:
        self.conn.close()

    def q(self, stmt: str, params: tuple = ()) -> list[tuple]:
        with self.conn.cursor() as cur:
            cur.execute(stmt, params)
            if cur.description is None:
                return []
            return cur.fetchall()

    def fixture(self, stmt: str, params: tuple = ()) -> list[tuple]:
        """A superuser write that is part of the round's setup: executed AND
        recorded (rendered with literals) so the repro script can replay it."""
        FIXTURE_SQL.append((FIXTURE_PHASE[0], render_sql(stmt, params)))
        return self.q(stmt, params)

    def one(self, stmt: str, params: tuple = ()) -> Any:
        rows = self.q(stmt, params)
        return rows[0][0] if rows else None

    def as_user(
        self,
        isolation: str,
        uid: str,
        stmt: str,
        params: tuple,
        worker: int,
        op: str,
    ) -> Outcome:
        """Run ONE statement as `authenticated` with auth.uid()=uid in its own txn
        under the requested isolation level — exactly what PostgREST does for an
        RPC call, minus the HTTP layer."""
        t0 = time.perf_counter()
        try:
            with self.conn.cursor() as cur:
                cur.execute(f"BEGIN ISOLATION LEVEL {ISOLATIONS[isolation]}")
                cur.execute("set local role authenticated")
                cur.execute("select set_config('request.jwt.claim.sub', %s, true)", (uid,))
                cur.execute(stmt, params)
                row = cur.fetchone()
                cur.execute("COMMIT")
            return Outcome(worker, op, True, None if row is None else str(row[0]), None, None, (time.perf_counter() - t0) * 1000, uid, render_sql(stmt, params))
        except psycopg.Error as e:
            try:
                self.conn.execute("ROLLBACK")
            except psycopg.Error:
                pass
            return Outcome(worker, op, False, None, e.sqlstate, str(e).splitlines()[0], (time.perf_counter() - t0) * 1000, uid, render_sql(stmt, params))

    def as_admin(self, isolation: str, stmts: list[tuple[str, tuple]], worker: int, op: str) -> Outcome:
        t0 = time.perf_counter()
        rendered = ";\n".join(render_sql(st, pa) for st, pa in stmts)
        try:
            with self.conn.cursor() as cur:
                cur.execute(f"BEGIN ISOLATION LEVEL {ISOLATIONS[isolation]}")
                last: str | None = "ok"
                for stmt, params in stmts:
                    cur.execute(stmt, params)
                    if cur.description is not None:
                        r = cur.fetchone()
                        last = None if r is None else str(r[0])
                cur.execute("COMMIT")
            return Outcome(worker, op, True, last, None, None, (time.perf_counter() - t0) * 1000, None, rendered)
        except psycopg.Error as e:
            try:
                self.conn.execute("ROLLBACK")
            except psycopg.Error:
                pass
            return Outcome(worker, op, False, None, e.sqlstate, str(e).splitlines()[0], (time.perf_counter() - t0) * 1000, None, rendered)


def shot_payload(rng: random.Random, shot_id: str, session_id: str | None, permit_id: str, kind: str, captured_at: dt.datetime) -> dict[str, Any]:
    scored = kind == "scored"
    return {
        "id": shot_id,
        "sessionId": session_id,
        "analysisPermitId": permit_id,
        "shotType": rng.choice(["dink", "drive", "serve", "third_shot_drop"]),
        "cameraView": rng.choice(["side", "rear_oblique"]),
        "capturedAt": captured_at.isoformat(),
        "startMs": 0,
        "contactMs": 400 if scored else None,
        "endMs": 900,
        "overallScore": round(rng.uniform(3.0, 9.5), 1) if scored else None,
        "confidence": round(rng.uniform(0.6, 0.99), 4) if scored else round(rng.uniform(0.05, 0.4), 4),
        "resultKind": kind,
        "versionVector": VERSION_VECTOR,
        "phases": [
            {"key": k, "startMs": i * 150, "representativeMs": i * 150 + 75, "endMs": (i + 1) * 150, "confidence": 0.9}
            for i, k in enumerate(PHASES)
        ],
        "checkpoints": [
            {
                "key": k,
                "score": round(rng.uniform(20, 100), 1),
                "confidence": 0.9,
                "band": rng.choice(["green", "yellow", "red"]),
                "direction": "up",
                "severity": round(rng.uniform(0, 1), 3),
                "applicable": True,
            }
            for k in CHECKPOINTS
        ],
    }


# ─────────────────────────── fixtures (superuser) ───────────────────────────


class Fixtures:
    def __init__(self, admin: Db, rng: random.Random, tag: str):
        self.admin = admin
        self.rng = rng
        self.tag = tag
        self.n = 0

    def user(self, *, premium: bool = False, identities: int = 1, provider: str = "apple", subject: str | None = None) -> dict[str, Any]:
        self.n += 1
        uid = det_uuid(self.rng)
        email = f"{self.tag}-{self.n}@example.test"
        self.admin.fixture(
            "insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values (%s, %s, %s::jsonb, %s::jsonb)",
            (uid, email, json.dumps({"full_name": f"CM {self.tag} {self.n}"}), json.dumps({"provider": provider})),
        )
        ids = []
        for i in range(identities):
            sub = subject if (subject and i == 0) else f"{provider}-sub-{self.tag}-{self.n}-{i}"
            prov = provider if i == 0 else "google"
            self.admin.fixture(
                "insert into auth.identities (provider, provider_id, user_id, identity_data) values (%s, %s, %s, %s::jsonb)",
                (prov, sub, uid, json.dumps({"sub": sub, "email": email})),
            )
            ids.append({"provider": prov, "provider_id": sub, "hash": identity_hash(prov, sub)})
        if self.admin.one("select count(*) from public.profiles where id = %s", (uid,)) != 1:
            raise RuntimeError("handle_new_user did not provision a profile")
        if premium:
            self.admin.fixture(
                "insert into public.billing_entitlements (user_id, premium, product_key, expires_at) values (%s, true, 'pickle_sensei_pro_lifetime', null)",
                (uid,),
            )
        session_id = det_uuid(self.rng)
        self.admin.fixture(
            "insert into public.sessions (id, user_id, started_at) values (%s, %s, now() - interval '1 hour')",
            (session_id, uid),
        )
        return {"uid": uid, "email": email, "identities": ids, "session_id": session_id, "premium": premium}

    def raw_permit(self, uid: str, key: str, *, created_at_sql: str = "now()") -> str:
        pid = det_uuid(self.rng)
        self.admin.fixture(
            f"insert into public.analysis_permits (id, user_id, idempotency_key, status, created_at) values (%s, %s, %s, 'reserved', {created_at_sql})",
            (pid, uid, key),
        )
        return pid

    def raw_scored_shot(self, uid: str, session_id: str | None, shot_id: str, kind: str = "scored") -> None:
        p = shot_payload(self.rng, shot_id, session_id, "00000000-0000-0000-0000-000000000000", kind, dt.datetime.now(dt.timezone.utc))
        self.admin.fixture(
            """insert into public.shots (id, user_id, session_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
                 overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
                 paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
               values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'a', 'b', 'p', 'pd', 's', 'ph', 'sc', 'cfg')""",
            (
                shot_id, uid, session_id, p["shotType"], p["cameraView"], p["capturedAt"], p["startMs"], p["contactMs"], p["endMs"],
                p["overallScore"], p["confidence"], kind,
            ),
        )


# ─────────────────────────── invariant queries ───────────────────────────


def user_state(admin: Db, uid: str) -> dict[str, Any]:
    return {
        "scored_shots": admin.one("select count(*) from public.shots where user_id = %s and result_kind = 'scored'", (uid,)),
        "abstained_shots": admin.one("select count(*) from public.shots where user_id = %s and result_kind = 'low_confidence'", (uid,)),
        "shots": admin.one("select count(*) from public.shots where user_id = %s", (uid,)),
        "phases": admin.one("select count(*) from public.shot_phases where user_id = %s", (uid,)),
        "checkpoints": admin.one("select count(*) from public.shot_checkpoints where user_id = %s", (uid,)),
        "permits_total": admin.one("select count(*) from public.analysis_permits where user_id = %s", (uid,)),
        "permits_reserved_active": admin.one(
            "select count(*) from public.analysis_permits where user_id = %s and status = 'reserved' and created_at > now() - interval '24 hours'",
            (uid,),
        ),
        "permits_reserved_any": admin.one("select count(*) from public.analysis_permits where user_id = %s and status = 'reserved'", (uid,)),
        "permits_finalized_scored": admin.one(
            "select count(*) from public.analysis_permits where user_id = %s and status = 'finalized' and outcome = 'scored'", (uid,)
        ),
        "permits_released_by_outcome": dict(
            admin.q("select outcome, count(*) from public.analysis_permits where user_id = %s and status = 'released' group by outcome", (uid,))
        ),
        "ledger": dict(
            admin.q(
                """select i.provider || ':' || i.provider_id, l.scored_count
                   from auth.identities i
                   left join public.free_rating_ledger l on l.identity_hash = encode(sha256(convert_to(i.provider || ':' || i.provider_id, 'utf8')), 'hex')
                   where i.user_id = %s""",
                (uid,),
            )
        ),
        "rank_state_rows": admin.one("select count(*) from public.player_rank_state where user_id = %s", (uid,)),
    }


def lifetime_count_as(admin: Db, uid: str) -> int:
    with admin.conn.cursor() as cur:
        cur.execute("begin")
        cur.execute("set local role authenticated")
        cur.execute("select set_config('request.jwt.claim.sub', %s, true)", (uid,))
        cur.execute("select public.lifetime_scored_count()")
        v = cur.fetchone()[0]
        cur.execute("commit")
    return int(v)


def check(name: str, ok: bool, detail: Any) -> dict[str, Any]:
    return {"invariant": name, "ok": bool(ok), "detail": detail}


def orphans(admin: Db) -> dict[str, int]:
    out = {}
    for t in USER_TABLES:
        if t == "profiles":
            out[t] = admin.one("select count(*) from public.profiles p where not exists (select 1 from auth.users u where u.id = p.id)")
        else:
            out[t] = admin.one(
                f"select count(*) from public.{t} c where not exists (select 1 from public.profiles p where p.id = c.user_id)"
            )
    out["shot_phases_without_shot"] = admin.one("select count(*) from public.shot_phases d where not exists (select 1 from public.shots s where s.id = d.shot_id)")
    out["shot_checkpoints_without_shot"] = admin.one(
        "select count(*) from public.shot_checkpoints d where not exists (select 1 from public.shots s where s.id = d.shot_id)"
    )
    return out


def heap_snapshot(admin: Db) -> dict[str, Any]:
    rows = admin.q(
        """select relname, n_live_tup, n_dead_tup, n_tup_ins, n_tup_upd, n_tup_del, n_tup_hot_upd,
                  pg_total_relation_size('public.' || relname)
           from pg_stat_user_tables where schemaname = 'public' and relname = any(%s) order by relname""",
        (HEAP_TABLES,),
    )
    db = admin.q(
        "select xact_commit, xact_rollback, deadlocks, conflicts, tup_inserted, tup_updated, tup_deleted from pg_stat_database where datname = current_database()"
    )[0]
    return {
        "tables": {
            r[0]: {
                "n_live_tup": r[1], "n_dead_tup": r[2], "n_tup_ins": r[3], "n_tup_upd": r[4], "n_tup_del": r[5],
                "n_tup_hot_upd": r[6], "total_bytes": r[7],
            }
            for r in rows
        },
        "database": {
            "xact_commit": db[0], "xact_rollback": db[1], "deadlocks": db[2], "conflicts": db[3],
            "tup_inserted": db[4], "tup_updated": db[5], "tup_deleted": db[6],
        },
        "at": dt.datetime.now(dt.timezone.utc).isoformat(),
    }


# ─────────────────────────── parallel driver ───────────────────────────


class Ctx:
    def __init__(self, url: str, seed: int, workers: int, rounds: int, out_dir: str, log: Callable[[str], None]):
        self.url = url
        self.seed = seed
        self.workers = workers
        self.rounds = rounds
        self.out_dir = out_dir
        self.log = log
        self.admin = Db(url)
        self.pool: list[Db] = [Db(url) for _ in range(workers)]

    def close(self) -> None:
        self.admin.close()
        for d in self.pool:
            d.close()

    def parallel(self, jobs: list[Callable[[Db], Outcome]], stagger_ms: list[float] | None = None) -> list[Outcome]:
        FIXTURE_PHASE[0] = "post"
        """Run jobs concurrently, one connection each, all released together.
        stagger_ms (recorded in the round's inputs) delays individual workers
        so a racer lands in the middle of the others' serialized stream."""
        n = len(jobs)
        barrier = threading.Barrier(n)

        def run(i: int) -> Outcome:
            barrier.wait()
            if stagger_ms and stagger_ms[i] > 0:
                time.sleep(stagger_ms[i] / 1000.0)
            return jobs[i](self.pool[i])

        with ThreadPoolExecutor(max_workers=n) as ex:
            return list(ex.map(run, range(n)))


def scenario_rng(seed: int, scenario: str, isolation: str, rnd: int) -> random.Random:
    h = hashlib.sha256(f"{seed}:{scenario}:{isolation}:{rnd}".encode()).digest()
    return random.Random(int.from_bytes(h[:8], "big"))


def fixture_tag(prefix: str, iso: str, rnd: int, rng: random.Random) -> str:
    """Unique per (scenario, isolation, round, seed) so identity subjects never collide."""
    return f"{prefix}-{iso[:3]}{rnd}-{rng.getrandbits(32):08x}"


# ─────────────────────────── scenarios ───────────────────────────


def sc_reserve_distinct_keys(ctx: Ctx, iso: str, rnd: int, rng: random.Random) -> RoundResult:
    fx = Fixtures(ctx.admin, rng, fixture_tag("rdk", iso, rnd, rng))
    u = fx.user()
    keys = [f"key-{rnd}-{i}-{det_uuid(rng)[:8]}" for i in range(ctx.workers)]
    jobs = [
        (lambda i, k: (lambda db: db.as_user(iso, u["uid"], RESERVE_SQL, (k,), i, "reserve")))(i, k)
        for i, k in enumerate(keys)
    ]
    outcomes = ctx.parallel(jobs)
    st = user_state(ctx.admin, u["uid"])
    accepted = [o for o in outcomes if o.ok and o.value and o.value.startswith("accepted:")]
    inv = [
        check("reserved permits never exceed the 2 free ratings", st["permits_reserved_active"] <= 2, st["permits_reserved_active"]),
        check("no more than 2 reserve calls returned accepted", len(accepted) <= 2, len(accepted)),
        check("every non-accepted call is paywall_required or a serialization failure",
              all(o.value == "access.paywall_required:" if o.ok else o.sqlstate == SERIALIZATION_FAILURE for o in outcomes if o not in accepted),
              histogram(outcomes)),
        check("exactly 2 accepted when no worker was aborted",
              len(accepted) == 2 or any(not o.ok for o in outcomes), len(accepted)),
    ]
    return RoundResult(rnd, {"user": u, "keys": keys, "isolation": iso}, outcomes, histogram(outcomes), inv, all(i["ok"] for i in inv), {"state": st})


def sc_reserve_same_key(ctx: Ctx, iso: str, rnd: int, rng: random.Random) -> RoundResult:
    fx = Fixtures(ctx.admin, rng, fixture_tag("rsk", iso, rnd, rng))
    u = fx.user()
    key = f"same-{rnd}-{det_uuid(rng)[:8]}"
    jobs = [
        (lambda i: (lambda db: db.as_user(iso, u["uid"], RESERVE_SQL, (key,), i, "reserve")))(i)
        for i in range(ctx.workers)
    ]
    outcomes = ctx.parallel(jobs)
    st = user_state(ctx.admin, u["uid"])
    permit_ids = {o.value for o in outcomes if o.ok and o.value and o.value.startswith("accepted:")}
    inv = [
        check("one idempotency key yields exactly one permit row", st["permits_total"] == 1, st["permits_total"]),
        check("all successful callers see the same permit id", len(permit_ids) <= 1, sorted(permit_ids)),
        check("no unique_violation leaks to the caller", all(o.sqlstate != UNIQUE_VIOLATION for o in outcomes), histogram(outcomes)),
        check("every call either accepted or serialization-failed", all(o.ok or o.sqlstate == SERIALIZATION_FAILURE for o in outcomes), histogram(outcomes)),
    ]
    return RoundResult(rnd, {"user": u, "key": key, "isolation": iso}, outcomes, histogram(outcomes), inv, all(i["ok"] for i in inv), {"state": st})


def sc_reserve_premium(ctx: Ctx, iso: str, rnd: int, rng: random.Random) -> RoundResult:
    fx = Fixtures(ctx.admin, rng, fixture_tag("rp", iso, rnd, rng))
    u = fx.user(premium=True)
    keys = [f"prem-{rnd}-{i}-{det_uuid(rng)[:8]}" for i in range(ctx.workers)]
    jobs = [
        (lambda i, k: (lambda db: db.as_user(iso, u["uid"], RESERVE_SQL, (k,), i, "reserve")))(i, k)
        for i, k in enumerate(keys)
    ]
    outcomes = ctx.parallel(jobs)
    st = user_state(ctx.admin, u["uid"])
    accepted = sum(1 for o in outcomes if o.ok and o.value and o.value.startswith("accepted:"))
    inv = [
        check("premium is never denied (no paywall_required)", all(o.value != "access.paywall_required:" for o in outcomes if o.ok), histogram(outcomes)),
        check("one permit row per successful call", st["permits_total"] == accepted, {"permits": st["permits_total"], "accepted": accepted}),
        check("every call either accepted or serialization-failed", all(o.ok or o.sqlstate == SERIALIZATION_FAILURE for o in outcomes), histogram(outcomes)),
    ]
    return RoundResult(rnd, {"user": u, "keys": keys, "isolation": iso}, outcomes, histogram(outcomes), inv, all(i["ok"] for i in inv), {"state": st})


def sc_sync_forged_permits(ctx: Ctx, iso: str, rnd: int, rng: random.Random) -> RoundResult:
    """Every worker holds its own VALID reserved permit (as a pre-fix build could
    have issued) and syncs a scored shot at once: at most two may become ratings."""
    fx = Fixtures(ctx.admin, rng, fixture_tag("sfp", iso, rnd, rng))
    u = fx.user()
    permits = [fx.raw_permit(u["uid"], f"forged-{rnd}-{i}") for i in range(ctx.workers)]
    now = dt.datetime.now(dt.timezone.utc)
    payloads = [shot_payload(rng, det_uuid(rng), u["session_id"], permits[i], "scored", now) for i in range(ctx.workers)]
    jobs = [
        (lambda i, p: (lambda db: db.as_user(iso, u["uid"], "select public.apply_synced_shot(%s::jsonb)", (json.dumps(p),), i, "sync")))(i, p)
        for i, p in enumerate(payloads)
    ]
    outcomes = ctx.parallel(jobs)
    st = user_state(ctx.admin, u["uid"])
    lifetime = lifetime_count_as(ctx.admin, u["uid"])
    accepted = sum(1 for o in outcomes if o.ok and o.value == "accepted")
    inv = [
        check("never more than 2 scored shots for a free account", st["scored_shots"] <= 2, st["scored_shots"]),
        check("accepted syncs == scored shots", accepted == st["scored_shots"], {"accepted": accepted, "scored": st["scored_shots"]}),
        check("every identity ledger == scored shots", all((v or 0) == st["scored_shots"] for v in st["ledger"].values()), st["ledger"]),
        check("lifetime_scored_count() == scored shots", lifetime == st["scored_shots"], lifetime),
        check("finalized(scored) permits == scored shots", st["permits_finalized_scored"] == st["scored_shots"], st["permits_finalized_scored"]),
        check("permits still reserved == syncs that neither finalized nor were refused (clean retry)",
              st["permits_reserved_any"] == sum(1 for o in outcomes if status_key(o) not in ("accepted", "access.paywall_required")),
              {"reserved": st["permits_reserved_any"], "statuses": histogram(outcomes)}),
        check("detail rows match shots (phases=6/shot, checkpoints=5/shot)",
              st["phases"] == 6 * st["shots"] and st["checkpoints"] == 5 * st["shots"], {"shots": st["shots"], "phases": st["phases"], "checkpoints": st["checkpoints"]}),
        check("statuses are accepted / paywall_required / 40001 / swallowed-40001 only",
              all((o.ok and o.value in ("accepted", "access.paywall_required")) or is_serialization(o) for o in outcomes),
              histogram(outcomes)),
    ]
    return RoundResult(rnd, {"user": u, "permits": permits, "payloads": payloads, "isolation": iso}, outcomes, histogram(outcomes), inv, all(i["ok"] for i in inv), {"state": st, "lifetime_scored_count": lifetime})


def sc_sync_same_shot(ctx: Ctx, iso: str, rnd: int, rng: random.Random) -> RoundResult:
    fx = Fixtures(ctx.admin, rng, fixture_tag("sss", iso, rnd, rng))
    u = fx.user()
    permit = fx.raw_permit(u["uid"], f"same-shot-{rnd}")
    payload = shot_payload(rng, det_uuid(rng), u["session_id"], permit, "scored", dt.datetime.now(dt.timezone.utc))
    body = json.dumps(payload)
    jobs = [
        (lambda i: (lambda db: db.as_user(iso, u["uid"], "select public.apply_synced_shot(%s::jsonb)", (body,), i, "sync")))(i)
        for i in range(ctx.workers)
    ]
    outcomes = ctx.parallel(jobs)
    st = user_state(ctx.admin, u["uid"])
    inv = [
        check("exactly one shot row", st["shots"] == 1, st["shots"]),
        check("exactly one scored rating counted", st["scored_shots"] == 1 and all(v == 1 for v in st["ledger"].values()), st["ledger"]),
        check("permit finalized once", st["permits_finalized_scored"] == 1, st["permits_finalized_scored"]),
        check("no shot.id_conflict / write_failed for the owner's own replay",
              all(not (o.ok and o.value and (o.value == "shot.id_conflict" or o.value.startswith("shot.write_failed"))) for o in outcomes), histogram(outcomes)),
    ]
    obs = {
        "state": st,
        "replay_accepted": sum(1 for o in outcomes if o.ok and o.value == "accepted"),
        "replay_permit_not_reserved": sum(1 for o in outcomes if o.ok and o.value == "access.permit_not_reserved"),
    }
    return RoundResult(rnd, {"user": u, "permit": permit, "payload": payload, "isolation": iso}, outcomes, histogram(outcomes), inv, all(i["ok"] for i in inv), obs)


def sc_reserve_sync_mixed(ctx: Ctx, iso: str, rnd: int, rng: random.Random) -> RoundResult:
    """Two legitimately reserved permits; then reserves, scored syncs and
    abstained syncs all race. The account may never end with more than two
    scored shots, and reserved permits may never exceed what is left."""
    fx = Fixtures(ctx.admin, rng, fixture_tag("rsm", iso, rnd, rng))
    u = fx.user()
    pre: list[str] = []
    for i in range(2):
        o = ctx.admin.as_user("read_committed", u["uid"], RESERVE_SQL, (f"pre-{rnd}-{i}",), -1, "reserve")
        if not (o.ok and o.value and o.value.startswith("accepted:")):
            raise RuntimeError(f"setup reserve failed: {o}")
        pre.append(o.value.split(":", 1)[1])
    now = dt.datetime.now(dt.timezone.utc)
    jobs: list[Callable[[Db], Outcome]] = []
    inputs: list[dict[str, Any]] = []
    for i in range(ctx.workers):
        kind = i % 4
        if kind == 0:
            key = f"mixed-{rnd}-{i}"
            inputs.append({"worker": i, "op": "reserve", "key": key})
            jobs.append((lambda i, key: (lambda db: db.as_user(iso, u["uid"], RESERVE_SQL, (key,), i, "reserve")))(i, key))
        else:
            permit = pre[i % 2]
            rk = "scored" if kind != 3 else "low_confidence"
            p = shot_payload(rng, det_uuid(rng), u["session_id"], permit, rk, now)
            inputs.append({"worker": i, "op": f"sync_{rk}", "payload": p})
            jobs.append((lambda i, p, rk: (lambda db: db.as_user(iso, u["uid"], "select public.apply_synced_shot(%s::jsonb)", (json.dumps(p),), i, f"sync_{rk}")))(i, p, rk))
    outcomes = ctx.parallel(jobs)
    st = user_state(ctx.admin, u["uid"])
    lifetime = lifetime_count_as(ctx.admin, u["uid"])
    inv = [
        check("scored shots <= 2", st["scored_shots"] <= 2, st["scored_shots"]),
        check("reserved permits <= 2 - scored", st["permits_reserved_active"] <= max(0, 2 - st["scored_shots"]),
              {"reserved": st["permits_reserved_active"], "scored": st["scored_shots"]}),
        check("finalized(scored) permits == scored shots", st["permits_finalized_scored"] == st["scored_shots"], st["permits_finalized_scored"]),
        check("released(low_confidence) permits == abstained shots",
              st["permits_released_by_outcome"].get("low_confidence", 0) == st["abstained_shots"],
              {"released": st["permits_released_by_outcome"], "abstained": st["abstained_shots"]}),
        check("every identity ledger == scored shots", all((v or 0) == st["scored_shots"] for v in st["ledger"].values()), st["ledger"]),
        check("lifetime_scored_count() == scored shots", lifetime == st["scored_shots"], lifetime),
        check("only contract statuses or 40001 / swallowed-40001",
              all((o.ok and status_key(o) in ("accepted", "access.paywall_required", "access.permit_not_reserved"))
                  or is_serialization(o) for o in outcomes), histogram(outcomes)),
    ]
    return RoundResult(rnd, {"user": u, "pre_permits": pre, "workers": inputs, "isolation": iso}, outcomes, histogram(outcomes), inv, all(i["ok"] for i in inv), {"state": st, "lifetime_scored_count": lifetime})


def sc_ledger_direct_writes(ctx: Ctx, iso: str, rnd: int, rng: random.Random) -> RoundResult:
    """Trigger arithmetic without the advisory lock: superuser inserts scored
    shots and converts low_confidence rows to scored concurrently for an
    account with two identities, one carrying history (5)."""
    fx = Fixtures(ctx.admin, rng, fixture_tag("ldw", iso, rnd, rng))
    u = fx.user(identities=2)
    history = 5
    ctx.admin.fixture("insert into public.free_rating_ledger (identity_hash, scored_count) values (%s, %s)", (u["identities"][0]["hash"], history))
    half = ctx.workers // 2
    pending_updates = [det_uuid(rng) for _ in range(half)]
    for sid in pending_updates:
        fx.raw_scored_shot(u["uid"], u["session_id"], sid, kind="low_confidence")
    inserts = [det_uuid(rng) for _ in range(ctx.workers - half)]
    jobs: list[Callable[[Db], Outcome]] = []
    for i, sid in enumerate(inserts):
        p = shot_payload(rng, sid, u["session_id"], "00000000-0000-0000-0000-000000000000", "scored", dt.datetime.now(dt.timezone.utc))
        stmt = (
            """insert into public.shots (id, user_id, session_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
                 overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
                 paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
               values (%s, %s, %s, %s, %s, %s, 0, 400, 900, %s, %s, 'scored', 'a', 'b', 'p', 'pd', 's', 'ph', 'sc', 'cfg')""",
            (sid, u["uid"], u["session_id"], p["shotType"], p["cameraView"], p["capturedAt"], p["overallScore"], p["confidence"]),
        )
        jobs.append((lambda i, stmt: (lambda db: db.as_admin(iso, [stmt], i, "insert_scored")))(i, stmt))
    for j, sid in enumerate(pending_updates):
        stmt = ("update public.shots set result_kind = 'scored', overall_score = 6.5, contact_ms = 400 where id = %s", (sid,))
        jobs.append((lambda i, stmt: (lambda db: db.as_admin(iso, [stmt], i, "upgrade_to_scored")))(len(inserts) + j, stmt))
    outcomes = ctx.parallel(jobs)
    st = user_state(ctx.admin, u["uid"])
    expected = history + st["scored_shots"]
    inv = [
        check("every identity ledger == history + committed scored shots", all(v == expected for v in st["ledger"].values()),
              {"ledger": st["ledger"], "expected": expected, "scored": st["scored_shots"]}),
        check("the second (history-less) identity was pulled up to the max", u["identities"][1]["hash"] in {
            r[0] for r in ctx.admin.q("select identity_hash from public.free_rating_ledger where scored_count = %s", (expected,))}, st["ledger"]),
        check("only success / 40001 / deadlock outcomes",
              all(o.ok or o.sqlstate in (SERIALIZATION_FAILURE, DEADLOCK_DETECTED) for o in outcomes), histogram(outcomes)),
    ]
    return RoundResult(rnd, {"user": u, "history": history, "inserts": inserts, "upgrades": pending_updates, "isolation": iso}, outcomes, histogram(outcomes), inv, all(i["ok"] for i in inv), {"state": st})


def sc_delete_vs_writes(ctx: Ctx, iso: str, rnd: int, rng: random.Random) -> RoundResult:
    """auth.users delete (what auth.admin.deleteUser does) racing reserve and
    scored sync on the same account. Afterwards: nothing user-owned may remain,
    nothing may be orphaned, the ledger must survive and a re-created account on
    the same identity must inherit the count."""
    fx = Fixtures(ctx.admin, rng, fixture_tag("dvw", iso, rnd, rng))
    u = fx.user()
    subject = u["identities"][0]["provider_id"]
    # one scored rating already spent, one permit reserved legitimately
    o = ctx.admin.as_user("read_committed", u["uid"], RESERVE_SQL, (f"del-pre-{rnd}",), -1, "reserve")
    pre_permit = o.value.split(":", 1)[1]
    pre_shot = shot_payload(rng, det_uuid(rng), u["session_id"], pre_permit, "scored", dt.datetime.now(dt.timezone.utc))
    o2 = ctx.admin.as_user("read_committed", u["uid"], "select public.apply_synced_shot(%s::jsonb)", (json.dumps(pre_shot),), -1, "sync")
    if o2.value != "accepted":
        raise RuntimeError(f"setup sync failed: {o2}")
    o3 = ctx.admin.as_user("read_committed", u["uid"], RESERVE_SQL, (f"del-pre2-{rnd}",), -1, "reserve")
    live_permit = o3.value.split(":", 1)[1]
    forged = [fx.raw_permit(u["uid"], f"del-forged-{rnd}-{i}") for i in range(ctx.workers)]
    before = user_state(ctx.admin, u["uid"])
    now = dt.datetime.now(dt.timezone.utc)
    delete_worker = rng.randrange(ctx.workers)
    # the delete lands 0..40ms into the racers' lock-serialized stream
    stagger = [0.0] * ctx.workers
    stagger[delete_worker] = round(rng.uniform(0, 40), 1)
    jobs: list[Callable[[Db], Outcome]] = []
    inputs: list[dict[str, Any]] = []
    for i in range(ctx.workers):
        if i == delete_worker:
            inputs.append({"worker": i, "op": "delete_auth_user"})
            jobs.append((lambda i: (lambda db: db.as_admin(iso, [("delete from auth.users where id = %s", (u["uid"],))], i, "delete_auth_user")))(i))
        elif i % 3 == 0:
            key = f"del-race-{rnd}-{i}"
            inputs.append({"worker": i, "op": "reserve", "key": key})
            jobs.append((lambda i, key: (lambda db: db.as_user(iso, u["uid"], RESERVE_SQL, (key,), i, "reserve")))(i, key))
        else:
            permit = live_permit if i % 3 == 1 else forged[i]
            p = shot_payload(rng, det_uuid(rng), u["session_id"], permit, "scored", now)
            inputs.append({"worker": i, "op": "sync_scored", "payload": p})
            jobs.append((lambda i, p: (lambda db: db.as_user(iso, u["uid"], "select public.apply_synced_shot(%s::jsonb)", (json.dumps(p),), i, "sync_scored")))(i, p))
    outcomes = ctx.parallel(jobs, stagger)
    delete_outcome = next(o for o in outcomes if o.op == "delete_auth_user")
    # The delete may itself have lost a deadlock / serialization race: retry it
    # once sequentially — auth.admin.deleteUser returns an error to the client
    # who retries; the invariant is about the END state after deletion succeeds.
    delete_retries = 0
    while not delete_outcome.ok and delete_retries < 3:
        delete_retries += 1
        delete_outcome = ctx.admin.as_admin("read_committed", [("delete from auth.users where id = %s", (u["uid"],))], -1, "delete_auth_user_retry")
    remaining = {t: ctx.admin.one(f"select count(*) from public.{t} where {'id' if t == 'profiles' else 'user_id'} = %s", (u["uid"],)) for t in USER_TABLES}
    orph = orphans(ctx.admin)
    ledger_after = ctx.admin.one("select scored_count from public.free_rating_ledger where identity_hash = %s", (u["identities"][0]["hash"],))
    scored_committed_before_delete = sum(1 for o in outcomes if o.ok and o.value == "accepted") + 1  # +1 for the setup shot
    # re-create the account with the same Apple subject
    u2 = fx.user(subject=subject)
    lifetime2 = lifetime_count_as(ctx.admin, u2["uid"])
    o4 = ctx.admin.as_user("read_committed", u2["uid"], RESERVE_SQL, (f"recreated-{rnd}",), -1, "reserve")
    inv = [
        check("deletion eventually succeeded", delete_outcome.ok, {"outcome": asdict(delete_outcome), "retries": delete_retries}),
        check("no user-owned rows remain after deletion", all(v == 0 for v in remaining.values()), remaining),
        check("no orphaned rows anywhere", all(v == 0 for v in orph.values()), orph),
        check("free_rating_ledger row survives deletion", ledger_after is not None, ledger_after),
        check("ledger == scored shots ever committed for the identity (<= 2)",
              ledger_after is not None and ledger_after == min(scored_committed_before_delete, 2) and ledger_after <= 2,
              {"ledger": ledger_after, "accepted_in_race": scored_committed_before_delete - 1}),
        check("re-created account inherits the identity count", lifetime2 == ledger_after, {"lifetime_scored_count": lifetime2, "ledger": ledger_after}),
        check("re-created account is refused once the identity spent both ratings, else accepted",
              (o4.ok and o4.value == "access.paywall_required:") if (ledger_after or 0) >= 2 else (o4.ok and o4.value.startswith("accepted:")), asdict(o4)),
        check("racers got only contract statuses, FK/deadlock/serialization errors, or write_failed",
              all(
                  (o.op == "delete_auth_user")
                  or (o.ok and status_key(o) in ("accepted", "access.paywall_required", "access.permit_not_found", "access.permit_not_reserved", "shot.write_failed"))
                  or (not o.ok and o.sqlstate in (SERIALIZATION_FAILURE, DEADLOCK_DETECTED, FK_VIOLATION))
                  for o in outcomes
              ), histogram(outcomes)),
    ]
    obs = {
        "before": before,
        "delete_outcome": asdict(delete_outcome),
        "delete_retries": delete_retries,
        "deadlocks_seen": sum(1 for o in outcomes if (o.sqlstate == DEADLOCK_DETECTED) or (o.ok and o.value and "deadlock" in o.value)),
        "recreated_user": u2,
        "recreated_reserve": asdict(o4),
    }
    return RoundResult(rnd, {"user": u, "pre_permit": pre_permit, "live_permit": live_permit, "forged": forged, "workers": inputs, "delete_worker": delete_worker, "stagger_ms": stagger, "isolation": iso},
                       outcomes, histogram(outcomes), inv, all(i["ok"] for i in inv), obs)


def sc_delete_cascade_scale(ctx: Ctx, iso: str, rnd: int, rng: random.Random, shots_per_user: int) -> RoundResult:
    """Heap numbers: one account with many shots (+6 phases +5 checkpoints each)
    is deleted while every other worker keeps syncing for OTHER users. Measures
    cascade duration, bystander latency, and dead tuples left behind."""
    fx = Fixtures(ctx.admin, rng, fixture_tag("dcs", iso, rnd, rng))
    big = fx.user(premium=True)
    bystanders = [fx.user(premium=True) for _ in range(ctx.workers - 1)]
    t0 = time.perf_counter()
    ctx.admin.fixture(
        """with s as (
             insert into public.shots (id, user_id, session_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
               overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
               paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
             select gen_random_uuid(), %s, %s, 'dink', 'side', now() - (g || ' seconds')::interval, 0, 400, 900,
                    7.0, 0.9, 'scored', 'a', 'b', 'p', 'pd', 's', 'ph', 'sc', 'cfg'
             from generate_series(1, %s) g
             returning id, user_id),
           ph as (
             insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
             select s.id, s.user_id, k, 0, 50, 100, 0.9 from s, unnest(%s::text[]) k)
           insert into public.shot_checkpoints (shot_id, user_id, checkpoint_key, score, confidence, band, direction, severity, applicable)
           select s.id, s.user_id, k, 80, 0.9, 'green', 'up', 0.1, true from s, unnest(%s::text[]) k""",
        (big["uid"], big["session_id"], shots_per_user, PHASES, CHECKPOINTS),
    )
    fixture_ms = (time.perf_counter() - t0) * 1000
    before = user_state(ctx.admin, big["uid"])
    heap_before = heap_snapshot(ctx.admin)
    now = dt.datetime.now(dt.timezone.utc)
    jobs: list[Callable[[Db], Outcome]] = []

    def bystander_job(i: int, b: dict[str, Any]) -> Callable[[Db], Outcome]:
        def run(db: Db) -> Outcome:
            # each bystander syncs a burst of 10 scored shots, one txn each, while the cascade runs
            worst = 0.0
            last: Outcome | None = None
            for k in range(10):
                o = db.as_user("read_committed", b["uid"], RESERVE_SQL, (f"scale-{rnd}-{i}-{k}",), i, "reserve")
                if not (o.ok and o.value and o.value.startswith("accepted:")):
                    return o
                permit = o.value.split(":", 1)[1]
                p = shot_payload(rng, str(uuid.uuid4()), b["session_id"], permit, "scored", now)
                last = db.as_user("read_committed", b["uid"], "select public.apply_synced_shot(%s::jsonb)", (json.dumps(p),), i, "bystander_sync")
                worst = max(worst, last.ms)
                if last.value != "accepted":
                    return last
            assert last is not None
            last.ms = worst
            return last

        return run

    jobs.append(lambda db: db.as_admin(iso, [("delete from auth.users where id = %s", (big["uid"],))], 0, "delete_big_user"))
    for i, b in enumerate(bystanders, start=1):
        jobs.append(bystander_job(i, b))
    outcomes = ctx.parallel(jobs, [30.0] + [0.0] * len(bystanders))
    heap_after = heap_snapshot(ctx.admin)
    remaining = {t: ctx.admin.one(f"select count(*) from public.{t} where {'id' if t == 'profiles' else 'user_id'} = %s", (big["uid"],)) for t in USER_TABLES}
    orph = orphans(ctx.admin)
    delete_o = outcomes[0]
    by = outcomes[1:]
    inv = [
        check("cascade delete succeeded", delete_o.ok, asdict(delete_o)),
        check("no rows of the deleted account remain", all(v == 0 for v in remaining.values()), remaining),
        check("no orphaned rows anywhere", all(v == 0 for v in orph.values()), orph),
        check("bystanders were never rejected while the cascade ran", all(o.ok and o.value == "accepted" for o in by), histogram(by)),
    ]
    obs = {
        "shots_per_user": shots_per_user,
        "fixture_ms": round(fixture_ms, 1),
        "rows_before": before,
        "cascade_ms": round(delete_o.ms, 1),
        "bystander_worst_sync_ms": round(max((o.ms for o in by), default=0.0), 1),
        "heap_before": heap_before,
        "heap_after": heap_after,
        "dead_tuples_delta": {
            t: heap_after["tables"][t]["n_dead_tup"] - heap_before["tables"][t]["n_dead_tup"] for t in heap_before["tables"]
        },
    }
    return RoundResult(rnd, {"big_user": big, "bystanders": bystanders, "isolation": iso}, outcomes, histogram(outcomes), inv, all(i["ok"] for i in inv), obs)


def sc_sweep_vs_sync(ctx: Ctx, iso: str, rnd: int, rng: random.Random) -> RoundResult:
    """The hourly pg_cron sweep UPDATE races scored syncs whose permits sit on
    both sides of the 24h boundary. Nothing may ever be both finalized and
    expired, and a stale permit may never become a rating."""
    fx = Fixtures(ctx.admin, rng, fixture_tag("svs", iso, rnd, rng))
    users = [fx.user(premium=True) for _ in range(ctx.workers - 1)]
    permits = []
    for i, u in enumerate(users):
        stale = i % 2 == 0
        created = "now() - interval '24 hours 1 second'" if stale else "now() - interval '23 hours 59 minutes'"
        permits.append({"uid": u["uid"], "permit": fx.raw_permit(u["uid"], f"sweep-{rnd}-{i}", created_at_sql=created), "stale": stale})
    now = dt.datetime.now(dt.timezone.utc)
    payloads = [shot_payload(rng, det_uuid(rng), u["session_id"], permits[i]["permit"], "scored", now) for i, u in enumerate(users)]
    jobs: list[Callable[[Db], Outcome]] = [
        lambda db: db.as_admin(iso, [(
            "update public.analysis_permits set status = 'released', outcome = 'expired' where status = 'reserved' and created_at < now() - interval '24 hours'", ())], 0, "cron_sweep")
    ]
    for i, u in enumerate(users):
        jobs.append((lambda i, u, p: (lambda db: db.as_user(iso, u["uid"], "select public.apply_synced_shot(%s::jsonb)", (json.dumps(p),), i + 1, "sync")))(i, u, payloads[i]))
    stagger = [round(rng.uniform(0, 15), 1)] + [0.0] * len(users)
    outcomes = ctx.parallel(jobs, stagger)
    rows = ctx.admin.q(
        "select p.id::text, p.status, p.outcome, (select count(*) from public.shots s where s.user_id = p.user_id) from public.analysis_permits p where p.id = any(%s::uuid[])",
        ([p["permit"] for p in permits],),
    )
    by_id = {r[0]: {"status": r[1], "outcome": r[2], "shots": r[3]} for r in rows}
    stale_ok = all(by_id[p["permit"]]["shots"] == 0 and by_id[p["permit"]]["status"] != "finalized" for p in permits if p["stale"])
    fresh_ok = all(by_id[p["permit"]]["shots"] == 1 and by_id[p["permit"]]["status"] == "finalized" for p in permits if not p["stale"]) or any(
        not o.ok for o in outcomes)
    inv = [
        check("stale permits never became a shot (released, or still reserved when both sweep and sync aborted)", stale_ok, {p["permit"]: by_id[p["permit"]] for p in permits if p["stale"]}),
        check("fresh permits finalized with exactly one shot (unless 40001)", fresh_ok, {p["permit"]: by_id[p["permit"]] for p in permits if not p["stale"]}),
        check("no permit both finalized and expired", all(not (v["status"] == "finalized" and v["outcome"] == "expired") for v in by_id.values()), by_id),
        check("sync statuses are accepted / permit_expired / permit_not_reserved / 40001",
              all((o.op != "sync") or (o.ok and o.value in ("accepted", "access.permit_expired", "access.permit_not_reserved")) or is_serialization(o) for o in outcomes),
              histogram(outcomes)),
    ]
    return RoundResult(rnd, {"users": users, "permits": permits, "payloads": payloads, "stagger_ms": stagger, "isolation": iso}, outcomes, histogram(outcomes), inv, all(i["ok"] for i in inv), {"permits_after": by_id})


SCENARIOS: dict[str, Callable[..., RoundResult]] = {
    "reserve_distinct_keys": sc_reserve_distinct_keys,
    "reserve_same_key": sc_reserve_same_key,
    "reserve_premium": sc_reserve_premium,
    "sync_forged_permits": sc_sync_forged_permits,
    "sync_same_shot": sc_sync_same_shot,
    "reserve_sync_mixed": sc_reserve_sync_mixed,
    "ledger_direct_writes": sc_ledger_direct_writes,
    "delete_vs_writes": sc_delete_vs_writes,
    "delete_cascade_scale": sc_delete_cascade_scale,
    "sweep_vs_sync": sc_sweep_vs_sync,
}
SINGLE_ROUND = {"delete_cascade_scale"}


# ─────────────────────────── repro emission ───────────────────────────


def write_repro(out_dir: str, scenario: str, iso: str, rr: RoundResult) -> str:
    """Self-contained replay: fixture SQL verbatim (superuser), then every worker
    transaction launched concurrently with psql (&), then the invariant witnesses.
    Repro runs must start from a fresh throwaway DB (fixture ids are fixed)."""
    rdir = os.path.join(out_dir, "repro")
    os.makedirs(rdir, exist_ok=True)
    base = f"{scenario}_{iso}_round{rr.round}"
    path = os.path.join(rdir, base + ".sh")
    inputs = rr.inputs
    lines = [
        "#!/usr/bin/env bash",
        f"# Replay of {scenario} / {ISOLATIONS[iso]} / round {rr.round}.",
        "# Requires a FRESH THROWAWAY postgres with shim_auth.sql + all migrations applied",
        "# and PGURL pointing at it (superuser). Fixture rows are recreated verbatim, then",
        "# every worker transaction is launched at once with psql (&). Timing-dependent",
        "# outcomes (which worker wins a lock) can differ between runs; the invariants",
        "# must hold regardless.",
        "set -euo pipefail",
        ': "${PGURL:?set PGURL to the throwaway database}"',
        f"ISO='{ISOLATIONS[iso]}'",
        'W=$(mktemp -d)',
        'trap \'rm -rf "$W"\' EXIT',
        "",
        "# ---- recorded inputs (verbatim from results.json) ----",
        'cat <<\'JSON\' > "$W/inputs.json"',
        json.dumps({k: v for k, v in inputs.items() if k not in ("fixture_sql", "fixture_sql_after_race")}, indent=2, default=str),
        "JSON",
        "",
        "# ---- fixtures (superuser, in order) ----",
        'cat <<\'SQL\' > "$W/fixtures.sql"',
    ]
    for stmt in inputs.get("fixture_sql", []):
        lines.append(stmt.rstrip(";") + ";")
    lines += [
        "SQL",
        'psql "$PGURL" -v ON_ERROR_STOP=1 -q -f "$W/fixtures.sql"',
        "",
        "# ---- worker transactions (one psql each, launched together) ----",
    ]
    post = inputs.get("fixture_sql_after_race", [])
    for i, o in enumerate(rr.outcomes):
        if not o.sql:
            continue
        lines.append(f"# worker {o.worker} op={o.op} observed ok={o.ok} value={o.value!r} sqlstate={o.sqlstate} error={o.error!r} ms={o.ms:.1f}")
        lines.append(f'cat <<\'SQL\' > "$W/w{i}.sql"')
        lines.append(f"begin isolation level {ISOLATIONS[iso]};")
        if o.uid:
            lines.append("set local role authenticated;")
            lines.append(f"select set_config('request.jwt.claim.sub', '{o.uid}', true);")
        lines.append(o.sql.rstrip(";") + ";")
        lines.append("commit;")
        lines.append("SQL")
    stagger = inputs.get("stagger_ms")
    for i, o in enumerate(rr.outcomes):
        if not o.sql:
            continue
        delay = ""
        if stagger and i < len(stagger) and stagger[i] > 0:
            delay = f"sleep {stagger[i] / 1000.0:.3f}; "
        lines.append(f'( {delay}psql "$PGURL" -q -f "$W/w{i}.sql" > "$W/w{i}.out" 2>&1 || echo "worker {i} exit=$?" >> "$W/w{i}.out" ) &')
    lines += [
        "wait",
        'for f in "$W"/w*.out; do echo "== $f"; cat "$f"; done',
    ]
    if post:
        lines += ["", "# ---- fixtures issued after the race (e.g. sign-in again after deletion) ----", 'cat <<\'SQL\' > "$W/fixtures_after.sql"']
        lines += [stmt.rstrip(";") + ";" for stmt in post]
        lines += ["SQL", 'psql "$PGURL" -v ON_ERROR_STOP=1 -q -f "$W/fixtures_after.sql"']
    lines += [
        "",
        "# ---- invariant witnesses (recorded run) ----",
    ]
    for inv in rr.invariants:
        lines.append(f"# {'OK  ' if inv['ok'] else 'FAIL'} {inv['invariant']}: {json.dumps(inv['detail'], default=str)[:400]}")
    users = []
    if "user" in inputs:
        users.append(inputs["user"])
    users += inputs.get("users", []) + inputs.get("bystanders", []) + ([inputs["big_user"]] if "big_user" in inputs else [])
    for u in users[:8]:
        lines.append(
            f"psql \"$PGURL\" -c \"select status, outcome, count(*) from public.analysis_permits where user_id = '{u['uid']}' group by 1,2;\" "
            f"-c \"select result_kind, count(*) from public.shots where user_id = '{u['uid']}' group by 1;\" "
            f"-c \"select * from public.free_rating_ledger where identity_hash in (select encode(sha256(convert_to(provider || ':' || provider_id, 'utf8')), 'hex') from auth.identities where user_id = '{u['uid']}');\""
        )
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")
    os.chmod(path, 0o755)
    return path


# ─────────────────────────── main ───────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--workers", type=int, default=24)
    ap.add_argument("--rounds", type=int, default=5)
    ap.add_argument("--seed", type=int, default=20260904)
    ap.add_argument("--scale-shots", type=int, default=1500, help="shots for the delete_cascade_scale account")
    ap.add_argument("--isolation", action="append", choices=list(ISOLATIONS), help="restrict isolation levels (default: all three)")
    ap.add_argument("--scenario", action="append", choices=list(SCENARIOS), help="restrict scenarios (default: all)")
    ap.add_argument("--repro-all", action="store_true", help="write a replay script for every round, not only failed/deadlocked ones")
    args = ap.parse_args()

    url = os.environ.get("CONCURRENCY_PG_URL")
    if not url:
        print("CONCURRENCY_PG_URL is required", file=sys.stderr)
        return 2
    if "supabase.co" in url or "ucqnaiwqwjtgvlduiuib" in url:
        print("refusing to run against a hosted Supabase project", file=sys.stderr)
        return 2
    os.makedirs(args.out_dir, exist_ok=True)
    log_path = os.path.join(args.out_dir, "matrix.log")
    log_f = open(log_path, "a")

    def log(msg: str) -> None:
        line = f"[{dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')}] {msg}"
        print(line, flush=True)
        log_f.write(line + "\n")
        log_f.flush()

    isolations = args.isolation or list(ISOLATIONS)
    scenarios = args.scenario or list(SCENARIOS)
    ctx = Ctx(url, args.seed, args.workers, args.rounds, args.out_dir, log)
    server = ctx.admin.one("select version()")
    log(f"postgres: {server}")
    log(f"seed={args.seed} workers={args.workers} rounds={args.rounds} isolations={isolations} scenarios={scenarios}")
    ctx.admin.q("select pg_stat_reset()")
    heap0 = heap_snapshot(ctx.admin)

    results: list[ScenarioResult] = []
    gate_failed = False
    for scenario in scenarios:
        fn = SCENARIOS[scenario]
        for iso in isolations:
            t0 = time.perf_counter()
            rounds: list[RoundResult] = []
            n_rounds = 1 if scenario in SINGLE_ROUND else args.rounds
            notes: list[str] = []
            for rnd in range(n_rounds):
                rng = scenario_rng(args.seed, scenario, iso, rnd)
                FIXTURE_SQL.clear()
                FIXTURE_PHASE[0] = "pre"
                try:
                    if scenario == "delete_cascade_scale":
                        rr = fn(ctx, iso, rnd, rng, args.scale_shots)
                    else:
                        rr = fn(ctx, iso, rnd, rng)
                except Exception as e:  # harness bug or unexpected DB state: recorded, never hidden
                    tb = traceback.format_exc()
                    rr = RoundResult(rnd, {"isolation": iso}, [], {}, [check("harness completed the round", False, {"error": str(e), "traceback": tb})], False)
                rr.inputs["fixture_sql"] = [sql for ph, sql in FIXTURE_SQL if ph == "pre"]
                rr.inputs["fixture_sql_after_race"] = [sql for ph, sql in FIXTURE_SQL if ph == "post"]
                rounds.append(rr)
                flag = "PASS" if rr.passed else "FAIL"
                log(f"{scenario:24s} {iso:16s} round {rnd}: {flag} statuses={rr.status_histogram}")
                if not rr.passed:
                    for inv in rr.invariants:
                        if not inv["ok"]:
                            log(f"    violated: {inv['invariant']} -> {json.dumps(inv['detail'], default=str)[:600]}")
                interesting = (not rr.passed) or any(o.sqlstate == DEADLOCK_DETECTED or (o.value or "").startswith("shot.write_failed") for o in rr.outcomes)
                if args.repro_all or interesting:
                    path = write_repro(args.out_dir, scenario, iso, rr)
                    notes.append(f"repro: {os.path.relpath(path, args.out_dir)}")
            passed = all(r.passed for r in rounds)
            gated = iso in GATED_ISOLATIONS
            if gated and not passed:
                gate_failed = True
            results.append(ScenarioResult(scenario, iso, gated, args.workers, rounds, passed, (time.perf_counter() - t0) * 1000, notes))

    heap1 = heap_snapshot(ctx.admin)
    summary = {
        "run": {
            "seed": args.seed,
            "workers": args.workers,
            "rounds": args.rounds,
            "scale_shots": args.scale_shots,
            "isolations": isolations,
            "scenarios": scenarios,
            "postgres": server,
            "started": heap0["at"],
            "finished": heap1["at"],
            "gate_failed": gate_failed,
        },
        "matrix": [
            {
                "scenario": r.scenario,
                "isolation": r.isolation,
                "gated": r.gated,
                "passed": r.passed,
                "rounds": len(r.rounds),
                "statuses": {k: sum(rr.status_histogram.get(k, 0) for rr in r.rounds) for k in sorted({k for rr in r.rounds for k in rr.status_histogram})},
                "violations": [inv["invariant"] for rr in r.rounds for inv in rr.invariants if not inv["ok"]],
                "wall_ms": round(r.wall_ms, 1),
                "notes": r.notes,
            }
            for r in results
        ],
        "heap": {"before": heap0, "after": heap1},
        "scenarios": [asdict(r) for r in results],
    }
    with open(os.path.join(args.out_dir, "results.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    with open(os.path.join(args.out_dir, "heap.json"), "w") as f:
        json.dump({"before": heap0, "after": heap1, "scale": [asdict(rr) for r in results if r.scenario == "delete_cascade_scale" for rr in r.rounds]}, f, indent=2, default=str)

    md = ["| scenario | isolation | gated | result | rounds | statuses | violations |", "|---|---|---|---|---|---|---|"]
    for m in summary["matrix"]:
        md.append(
            f"| {m['scenario']} | {ISOLATIONS[m['isolation']]} | {'yes' if m['gated'] else 'observation'} | {'PASS' if m['passed'] else 'FAIL'} | {m['rounds']} | "
            f"`{json.dumps(m['statuses'])}` | {'; '.join(sorted(set(m['violations']))) or '-'} |"
        )
    with open(os.path.join(args.out_dir, "matrix.md"), "w") as f:
        f.write("\n".join(md) + "\n")
    log("\n" + "\n".join(md))
    log(f"gate: {'FAILED' if gate_failed else 'passed'} (READ COMMITTED + SERIALIZABLE)")
    ctx.close()
    log_f.close()
    return 1 if gate_failed else 0


if __name__ == "__main__":
    sys.exit(main())
