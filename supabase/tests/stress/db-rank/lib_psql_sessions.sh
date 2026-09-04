# Two-session psql interleaving helpers for deterministic SQL repros.
# Source after setting PG_URL. Sessions are psql coprocesses; `run S sql`
# waits for the statement to finish, `start S sql` returns immediately (for
# statements that are expected to block) and `finish S` waits for it.
# `pq` is psql bound to the target DB: the host binary when present, else
# psql inside the pg_up.sh container (STRESS_PG_CONTAINER).
set -euo pipefail

declare -A SESS_IN SESS_OUT
SESS_PIDS=()
# Every backend this script opens is tagged so cleanup can terminate it
# server-side: killing a blocked client (esp. a `docker exec` one) does not
# reliably end its backend, and a leftover transaction holding row locks
# would hang the next run.
SESS_APP="stress-repro-$$"
cleanup_sessions() {
  pq -q -At -c "select pg_terminate_backend(pid) from pg_stat_activity
                where application_name = '$SESS_APP' and pid <> pg_backend_pid()" >/dev/null 2>&1 || true
  for p in "${SESS_PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
}
trap cleanup_sessions EXIT

if command -v psql >/dev/null 2>&1; then
  pq() { PGAPPNAME="$SESS_APP" psql "$PG_URL" "$@"; }
else
  # stderr is merged INSIDE the container: docker multiplexes the two streams
  # and does not preserve ordering between them, so an ERROR line could land
  # after the __DONE__ marker and get lost.
  pq() {
    docker exec -i -e PGAPPNAME="$SESS_APP" "${STRESS_PG_CONTAINER:-pickle-stress-db-rank}" \
      sh -c 'exec psql -U postgres -d postgres "$@" 2>&1' -- "$@"
  }
fi

open_session() {           # open_session NAME
  local name=$1 fifo_in fifo_out
  fifo_in=$(mktemp -u) && fifo_out=$(mktemp -u)
  mkfifo "$fifo_in" "$fifo_out"
  pq -q -At -v ON_ERROR_STOP=0 <"$fifo_in" >"$fifo_out" 2>&1 &
  SESS_PIDS+=($!)
  exec {SESS_IN[$name]}>"$fifo_in" {SESS_OUT[$name]}<"$fifo_out"
  rm -f "$fifo_in" "$fifo_out"
}

start() {                  # start NAME SQL   (does not wait)
  local name=$1 sql=$2
  printf '%s\n\\echo __DONE__\n' "$sql" >&"${SESS_IN[$name]}"
}

finish() {                 # finish NAME      (prints output until the marker)
  local name=$1 line
  while IFS= read -r line <&"${SESS_OUT[$name]}"; do
    [ "$line" = "__DONE__" ] && break
    printf '[%s] %s\n' "$name" "$line"
  done
}

run() { start "$1" "$2"; finish "$1"; }

close_session() { printf '\\q\n' >&"${SESS_IN[$1]}" 2>/dev/null || true; }

wait_until_blocked() {     # wait_until_blocked <pg_stat_activity predicate> [relation the blocked backend must already hold a lock on]
  # Spins (max ~5s) until a backend matching the predicate waits on a lock
  # (and, when given, already holds a granted lock on <relation>, i.e. it
  # got that far before blocking).
  local i pred=$1 rel=${2:-}
  local q="select count(*) from pg_stat_activity a where a.wait_event_type = 'Lock' and $pred"
  if [ -n "$rel" ]; then
    q="$q and exists (select 1 from pg_locks l where l.pid = a.pid and l.granted and l.relation = '$rel'::regclass)"
  fi
  for i in $(seq 1 100); do
    if [ "$(pq -At -c "$q")" -ge 1 ]; then
      return 0
    fi
    sleep 0.05
  done
  echo "timed out waiting for a blocked backend ($pred ${rel:+holding $rel})" >&2
  return 1
}
