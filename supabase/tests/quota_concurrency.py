import argparse
from collections import Counter
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import uuid


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()


class Database:
    def __init__(self, args):
        require(re.fullmatch(r"pickle_rls_[A-Za-z0-9]{8}", args.database), "Not a scratch database")
        self.env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
        options = ["-X", "-w", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres",
                   "-p", "5432", "-d", args.database]
        if args.socket:
            require(re.fullmatch(r"/tmp/pickle-rls\.[A-Za-z0-9]{8}", args.socket), "Not a scratch socket")
            require(args.database == "pickle_rls_" + args.socket.rsplit(".", 1)[1], "Scratch names differ")
            require(not Path(args.socket).is_symlink(), "Scratch directory is a symlink")
            psql = shutil.which("psql") or "/opt/homebrew/bin/psql"
            self.command = [psql, "-h", args.socket, *options]
        else:
            require(re.fullmatch(r"[0-9a-f]{64}", args.container), "Expected the newly created container ID")
            label = subprocess.run(
                ["docker", "inspect", "--format", '{{index .Config.Labels "pickle.rls-scratch"}}', args.container],
                capture_output=True, text=True, check=True, timeout=15,
            ).stdout.strip()
            require(label == args.database, "Container is not this runner's scratch resource")
            self.command = ["docker", "exec", "-i", args.container, "psql", "-h", "/var/run/postgresql", *options]
        target = self.json("select jsonb_build_object('database', current_database(), "
                           "'data', current_setting('data_directory'), 'tcp', inet_server_addr(), "
                           "'listen', current_setting('listen_addresses'))")
        require(target["database"] == args.database and target["tcp"] is None, "Scratch socket required")
        if args.socket:
            require(Path(target["data"]).resolve() == (Path(args.socket) / "data").resolve(), "Wrong local cluster")
            require(target["listen"] == "", "Local scratch cluster must not listen on TCP")
        require(self.run("select count(*) from auth.users").strip() == "0", "Expected an empty post-matrix scratch DB")

    def transaction(self, sql, user=None, application=None):
        statements = ["begin isolation level read committed", "set local statement_timeout = '30s'"]
        if application:
            statements.append("set local application_name = " + literal(application))
        if user:
            statements.extend(["set local role authenticated", "set local request.jwt.claim.sub = " + literal(user)])
        return "; ".join([*statements, sql, "commit;"])

    def run(self, sql, user=None):
        result = subprocess.run(self.command, input=self.transaction(sql, user), env=self.env,
                                capture_output=True, text=True, timeout=40)
        require(result.returncode == 0, f"psql failed ({result.returncode}): {result.stderr}\n{result.stdout}")
        return result.stdout

    def json(self, sql, user=None):
        return json.loads(self.run(sql, user))

    def value(self, expression, user):
        return self.json("select " + expression, user)


@dataclass
class Job:
    kind: str
    expression: str
    shot: str = ""
    permit: str = ""


def reserve(key):
    return Job("reserve", "(select to_jsonb(r) from public.reserve_analysis_permit(" + literal(key) + ") r)")


def sync(permit, kind="scored"):
    shot = str(uuid.uuid4())
    expression = "jsonb_build_object('result', public.apply_synced_shot(quota_test.shot(" + ",".join(
        literal(value) for value in [shot, permit, kind]
    ) + ")))"
    return Job("sync", expression, shot, permit)


def direct():
    shot = str(uuid.uuid4())
    return Job("direct", "jsonb_build_object('result', quota_test.insert_shots(array[" + literal(shot) + "]::uuid[]))", shot)


def race(db, name, user, jobs):
    application = "quota_" + uuid.uuid4().hex[:16]
    controller_sql = db.transaction(f"""
        select pg_advisory_xact_lock(public.access_lock_key({literal(user)}::uuid));
        do $$
        declare
          waiting integer;
          deadline timestamptz := clock_timestamp() + interval '20 seconds';
        begin
          loop
            select count(distinct waiter.pid) into waiting
            from pg_locks holder
            join pg_locks waiter on waiter.locktype = holder.locktype
              and waiter.database = holder.database and waiter.classid = holder.classid
              and waiter.objid = holder.objid and waiter.objsubid = holder.objsubid
            where holder.pid = pg_backend_pid() and holder.locktype = 'advisory'
              and holder.granted and not waiter.granted;
            if waiting = {len(jobs)} then
              raise notice 'QUOTA_BARRIER_READY:%', waiting;
              exit;
            end if;
            if clock_timestamp() >= deadline then
              raise exception 'Only %/{len(jobs)} independent connections reached the access lock', waiting;
            end if;
            perform pg_sleep(0.01);
          end loop;
        end $$
    """, application=application)
    controller = subprocess.Popen([*db.command, "-c", controller_sql], env=db.env,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    workers = []
    try:
        deadline = time.monotonic() + 15
        while True:
            ready = db.run(f"""select count(*) from pg_locks l join pg_stat_activity a on a.pid = l.pid
                where a.application_name = {literal(application)} and l.locktype = 'advisory' and l.granted""").strip()
            if ready == "1":
                break
            require(controller.poll() is None and time.monotonic() < deadline, f"{name}: controller did not acquire lock")
            time.sleep(0.01)
        for index, job in enumerate(jobs):
            sql = "select jsonb_build_object('pid', pg_backend_pid(), 'role', current_user, " \
                  "'user', auth.uid(), 'value', " + job.expression + ")"
            workers.append(subprocess.Popen(
                [*db.command, "-c", db.transaction(sql, user, f"{application}_{index}")],
                env=db.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            ))
        rows = []
        for worker in workers:
            stdout, stderr = worker.communicate(timeout=40)
            require(worker.returncode == 0, f"{name}: worker failed ({worker.returncode}): {stderr}\n{stdout}")
            row = json.loads(stdout)
            require(row["role"] == "authenticated" and row["user"] == user, f"{name}: wrong worker identity")
            rows.append(row)
        stdout, stderr = controller.communicate(timeout=40)
        require(controller.returncode == 0, f"{name}: barrier failed: {stderr}\n{stdout}")
        require(f"QUOTA_BARRIER_READY:{len(jobs)}" in stderr, f"{name}: no proven lock overlap: {stderr}")
        require(len({row["pid"] for row in rows}) == len(jobs), f"{name}: connections were reused")
        print(f"{name}: barrier verified {len(jobs)} independent waiting connections", flush=True)
        return [row["value"] for row in rows]
    finally:
        for process in [controller, *workers]:
            stop(process)


def outcomes(name, rows, expected):
    actual = dict(Counter(row["result"] for row in rows))
    require(actual == expected, f"{name}: expected {expected}, got {actual}")
    print(f"{name}: {json.dumps(actual, sort_keys=True)}", flush=True)


def seed_user(db, subject=None):
    user = str(uuid.uuid4())
    subject = subject or "local-quota-" + uuid.uuid4().hex
    db.run(f"""insert into auth.users (id, email, raw_app_meta_data)
        values ({literal(user)}, 'quota@example.invalid', '{{"provider":"google"}}');
        insert into auth.identities (provider, provider_id, user_id)
        values ('google', {literal(subject)}, {literal(user)})""")
    return user, subject


def seed_permits(db, user, count):
    permits = [str(uuid.uuid4()) for _ in range(count)]
    values = ",".join("(" + ",".join(literal(value) for value in [permit, user, permit]) + ")" for permit in permits)
    db.run("insert into public.analysis_permits (id,user_id,idempotency_key) values " + values, user)
    return permits


def state(db, user, **expected):
    actual = db.json("""select jsonb_build_object(
        'premium', a.premium, 'lifetime', a.scored_count, 'reserved', a.reserved_count,
        'identity', public.identity_scored_count(),
        'scored', (select count(*) from public.shots where result_kind = 'scored'),
        'abstained', (select count(*) from public.shots where result_kind = 'low_confidence'),
        'permits', (select count(*) from public.analysis_permits)
      ) from public.access_state() a""", user)
    for key, value in expected.items():
        require(actual[key] == value, f"State for {user}: expected {key}={value}, got {actual}")
    return actual


def writes(db, user, jobs, rows, kind="scored"):
    ids = ",".join(literal(job.shot) for job in jobs)
    shots = db.json(f"""select coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'kind', s.result_kind,
        'phases', (select count(*) from public.shot_phases p where p.shot_id = s.id),
        'checkpoints', (select count(*) from public.shot_checkpoints c where c.shot_id = s.id)
      )), '[]'::jsonb) from public.shots s where s.id in ({ids})""", user)
    by_id = {shot["id"]: shot for shot in shots}
    expected_ids = {job.shot for job, row in zip(jobs, rows) if row["result"] == "accepted"}
    require(set(by_id) == expected_ids, "Denied shots leaked into storage, or accepted shots are missing")
    for job, row in zip(jobs, rows):
        accepted = row["result"] == "accepted"
        if accepted:
            detail_count = 1 if job.kind == "sync" else 0
            require(by_id[job.shot] == {"id": job.shot, "kind": kind, "phases": detail_count,
                                       "checkpoints": detail_count}, "Shot/detail atomicity failed")
        if job.kind == "sync":
            permit = db.json("select jsonb_build_object('status', status, 'outcome', outcome) "
                             "from public.analysis_permits where id = " + literal(job.permit), user)
            expected = {"status": "finalized" if accepted and kind == "scored" else "released",
                        "outcome": kind if accepted else "free_limit_exceeded"}
            require(permit == expected, f"Permit {job.permit}: expected {expected}, got {permit}")


def main():
    parser = argparse.ArgumentParser()
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--socket")
    target.add_argument("--container")
    parser.add_argument("--database", required=True)
    args = parser.parse_args()
    db = Database(args)
    db.run(Path(__file__).with_suffix(".sql").read_text())
    probe, _ = seed_user(db)
    probe_jobs = [direct() for _ in range(3)]
    probe_rows = [db.value(job.expression, probe) for job in probe_jobs]
    probe_state = state(db, probe)
    print("B0 owner raw INSERT, no permits: " + json.dumps({
        "results": [row["result"] for row in probe_rows], "state": probe_state,
    }, sort_keys=True), flush=True)
    outcomes("B0", probe_rows, {"accepted": 2, "23514:access.paywall_required": 1})
    writes(db, probe, probe_jobs, probe_rows)
    state(db, probe, premium=False, scored=2, lifetime=2, identity=2, reserved=0, permits=0)

    multi, _ = seed_user(db)
    first = direct()
    require(db.value(first.expression, multi)["result"] == "accepted", "B1 first direct score")
    multiple_ids = [str(uuid.uuid4()), str(uuid.uuid4())]
    multiple = ",".join(literal(value) for value in multiple_ids)
    rejected = db.value("jsonb_build_object('result', quota_test.insert_shots(array[" + multiple + "]::uuid[]))", multi)
    require(rejected["result"] == "23514:access.paywall_required", "B1 multi-row overflow must reject the statement")
    require(db.run("select count(*) from public.shots where id in (" + multiple + ")", multi).strip() == "0",
            "B1 multi-row failure leaked a shot")
    state(db, multi, scored=1, lifetime=1, identity=1, reserved=0)
    require(db.value(direct().expression, multi)["result"] == "accepted", "B1 failed multi-row write spent a rating")
    state(db, multi, scored=2, lifetime=2, identity=2, reserved=0)
    print("B1: multi-row overflow rolled back every row and ledger write; remaining rating stayed usable", flush=True)

    upsert = subprocess.run(
        [*db.command, "-v", "VERBOSITY=sqlstate"],
        input=db.transaction("insert into public.shots select * from public.shots where id = " + literal(first.shot) +
                             " on conflict (id) do update set result_kind = excluded.result_kind", multi),
        env=db.env, capture_output=True, text=True, timeout=40,
    )
    require(upsert.returncode != 0 and "42501" in upsert.stderr,
            "B2 merge-upsert must preserve the missing UPDATE grant")
    state(db, multi, scored=2, lifetime=2, identity=2, reserved=0)
    print("B2: authenticated merge-upsert refused with 42501; history stayed immutable", flush=True)

    free, _ = seed_user(db)
    jobs = [reserve(f"distinct-{index}") for index in range(6)]
    rows = race(db, "R1 free distinct reserves", free, jobs)
    outcomes("R1", rows, {"accepted": 2, "access.paywall_required": 4})
    state(db, free, premium=False, reserved=2, permits=2, scored=0, identity=0, lifetime=0)
    require(len({row["permit_id"] for row in rows if row["result"] == "accepted"}) == 2, "R1 permit identities")
    require(all(row["permit_id"] is None for row in rows if row["result"] != "accepted"), "R1 refused permit leaked")

    same, _ = seed_user(db)
    rows = race(db, "R2 same new idempotency key", same, [reserve("same-key") for _ in range(6)])
    outcomes("R2", rows, {"accepted": 6})
    require(len({json.dumps(row, sort_keys=True) for row in rows}) == 1, "R2 replays must return identical permit rows")
    state(db, same, reserved=1, permits=1, lifetime=0)
    rows = race(db, "R2 remaining slot", same, [reserve(f"next-{index}") for index in range(4)])
    outcomes("R2 remaining", rows, {"accepted": 1, "access.paywall_required": 3})
    state(db, same, reserved=2, permits=2, lifetime=0)

    scored, subject = seed_user(db)
    jobs = [sync(permit) for permit in seed_permits(db, scored, 6)]
    rows = race(db, "R3 over-issued scored sync", scored, jobs)
    outcomes("R3", rows, {"accepted": 2, "access.paywall_required": 4})
    writes(db, scored, jobs, rows)
    state(db, scored, reserved=0, scored=2, lifetime=2, identity=2, permits=6)
    for job, row in zip(jobs, rows):
        if row["result"] == "accepted":
            require(db.value(job.expression, scored)["result"] == "accepted", "R3 committed sync replay failed")
    state(db, scored, reserved=0, scored=2, lifetime=2, identity=2)
    print("R3: 2 finalized/scored, 4 released/free_limit_exceeded; committed replays did not charge", flush=True)

    abstained, _ = seed_user(db)
    jobs = [sync(permit, "low_confidence") for permit in seed_permits(db, abstained, 6)]
    rows = race(db, "R4 abstentions", abstained, jobs)
    outcomes("R4", rows, {"accepted": 6})
    writes(db, abstained, jobs, rows, "low_confidence")
    state(db, abstained, reserved=0, scored=0, abstained=6, lifetime=0, identity=0)
    rows = race(db, "R4 released slots", abstained, [reserve(f"after-abstain-{index}") for index in range(6)])
    outcomes("R4 released slots", rows, {"accepted": 2, "access.paywall_required": 4})
    state(db, abstained, reserved=2, lifetime=0, identity=0)
    jobs = [sync(permit, "low_confidence") for permit in seed_permits(db, scored, 4)]
    rows = race(db, "R4 abstentions at cap", scored, jobs)
    outcomes("R4 at cap", rows, {"accepted": 4})
    writes(db, scored, jobs, rows, "low_confidence")
    state(db, scored, reserved=0, scored=2, abstained=4, lifetime=2, identity=2)

    premium, _ = seed_user(db)
    db.run("insert into public.billing_entitlements (user_id, premium, expires_at) values (" +
           literal(premium) + ", true, now() + interval '1 day')")
    rows = race(db, "R5 premium reserves", premium, [reserve(f"premium-{index}") for index in range(6)])
    outcomes("R5 reserves", rows, {"accepted": 6})
    state(db, premium, premium=True, reserved=6, lifetime=0)
    jobs = [sync(row["permit_id"]) for row in rows]
    rows = race(db, "R5 premium scored sync", premium, jobs)
    outcomes("R5 sync", rows, {"accepted": 6})
    writes(db, premium, jobs, rows)
    state(db, premium, premium=True, reserved=0, scored=6, lifetime=6, identity=6)
    rows = race(db, "R5 premium extra reserves", premium, [reserve(f"premium-extra-{index}") for index in range(4)])
    outcomes("R5 extra reserves", rows, {"accepted": 4})
    db.run("update public.billing_entitlements set expires_at = now() - interval '1 second' where user_id = " + literal(premium))
    jobs = [sync(row["permit_id"]) for row in rows]
    rows = race(db, "R5 expired premium sync", premium, jobs)
    outcomes("R5 expired", rows, {"access.paywall_required": 4})
    writes(db, premium, jobs, rows)
    state(db, premium, premium=False, reserved=0, scored=6, lifetime=6, identity=6)

    db.run("delete from auth.users where id = " + literal(scored))
    cascade = db.json(f"""select jsonb_build_object(
        'users', (select count(*) from auth.users where id = {literal(scored)}),
        'shots', (select count(*) from public.shots where user_id = {literal(scored)}),
        'permits', (select count(*) from public.analysis_permits where user_id = {literal(scored)}),
        'identities', (select count(*) from auth.identities where user_id = {literal(scored)}),
        'ledger', (select scored_count from public.free_rating_ledger where identity_hash =
                   public.free_rating_identity_hash('google', {literal(subject)})))""")
    require(cascade == {"users": 0, "shots": 0, "permits": 0, "identities": 0, "ledger": 2}, f"R6 cascade: {cascade}")
    recreated, _ = seed_user(db, subject)
    state(db, recreated, scored=0, lifetime=2, identity=2, reserved=0)
    rows = race(db, "R6 recreated identity reserves", recreated, [reserve(f"recreated-{index}") for index in range(6)])
    outcomes("R6 reserves", rows, {"access.paywall_required": 6})
    state(db, recreated, permits=0, scored=0, lifetime=2, identity=2)
    jobs = [sync(permit) for permit in seed_permits(db, recreated, 6)]
    rows = race(db, "R6 recreated identity sync", recreated, jobs)
    outcomes("R6 sync", rows, {"access.paywall_required": 6})
    writes(db, recreated, jobs, rows)
    state(db, recreated, reserved=0, scored=0, lifetime=2, identity=2)

    overlap, _ = seed_user(db)
    permit = db.value(reserve("first").expression, overlap)["permit_id"]
    require(db.value(sync(permit).expression, overlap)["result"] == "accepted", "R7 initial score")
    permit = db.value(reserve("last-slot").expression, overlap)["permit_id"]
    jobs = [sync(permit), *[reserve(f"overlap-{index}") for index in range(5)]]
    rows = race(db, "R7 reserve and scored sync overlap", overlap, jobs)
    require(rows[0]["result"] == "accepted", "R7 reserved score must succeed")
    outcomes("R7 reserves", rows[1:], {"access.paywall_required": 5})
    writes(db, overlap, jobs[:1], rows[:1])
    state(db, overlap, scored=2, lifetime=2, identity=2, reserved=0, permits=2)

    inserted, _ = seed_user(db)
    jobs = [direct() for _ in range(6)]
    rows = race(db, "R8 direct INSERT", inserted, jobs)
    outcomes("R8", rows, {"accepted": 2, "23514:access.paywall_required": 4})
    writes(db, inserted, jobs, rows)
    state(db, inserted, scored=2, lifetime=2, identity=2, permits=0)
    for job, row in zip(jobs, rows):
        if row["result"] == "accepted":
            require(db.value(job.expression, inserted)["result"] == "accepted", "R8 INSERT ON CONFLICT replay")
    state(db, inserted, scored=2, lifetime=2, identity=2)

    mixed, _ = seed_user(db)
    permits = seed_permits(db, mixed, 3)
    jobs = [job for permit in permits for job in [direct(), sync(permit)]]
    rows = race(db, "R9 direct INSERT and RPC overlap", mixed, jobs)
    counts = Counter(row["result"] for row in rows)
    require(counts["accepted"] == 2 and counts["access.paywall_required"] +
            counts["23514:access.paywall_required"] == 4, f"R9 mixed results: {counts}")
    writes(db, mixed, jobs, rows)
    state(db, mixed, scored=2, lifetime=2, identity=2, reserved=0)
    print("R9: 2 accepted / 4 denied across direct INSERT and RPC, ledger=2", flush=True)

    jobs = [direct() for _ in range(4)]
    rows = race(db, "R10 recreated identity direct INSERT", recreated, jobs)
    outcomes("R10", rows, {"23514:access.paywall_required": 4})
    writes(db, recreated, jobs, rows)
    state(db, recreated, scored=0, lifetime=2, identity=2, reserved=0)
    print("QUOTA CONCURRENCY: ALL CASES PASSED (read committed; real lock-queue barriers)", flush=True)


if __name__ == "__main__":
    main()
