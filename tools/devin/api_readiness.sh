#!/usr/bin/env bash
# Devin API v3 readiness probe for Pickle Sensei automation.
#
# Read-only. Proves that a service-user key can (a) reach the org-scoped API,
# (b) list sessions, (c) list playbooks and (d) list knowledge notes for THIS
# organization — the minimum a future coordinator needs before it may create
# sessions programmatically. Never creates anything and never prints the key.
#
#   DEVIN_API_KEY=cog_… tools/devin/api_readiness.sh [--json]
#
# Environment:
#   DEVIN_API_KEY   service-user key (required; starts with cog_)
#   DEVIN_API_BASE  default https://la-hacks-rttothemoon.devinenterprise.com/api
#   DEVIN_ORG_ID    default org-64c3d692a7604f66829849dfdd2389ba
#
# Exit codes: 0 all probes 200, 1 a probe was denied/failed, 2 no key, 3 API
# unreachable (network/TLS), 4 curl/jq missing.
set -euo pipefail

BASE="${DEVIN_API_BASE:-https://la-hacks-rttothemoon.devinenterprise.com/api}"
ORG="${DEVIN_ORG_ID:-org-64c3d692a7604f66829849dfdd2389ba}"
JSON=0
[ "${1:-}" = "--json" ] && JSON=1

for bin in curl jq; do
  command -v "$bin" >/dev/null 2>&1 || { echo "missing $bin" >&2; exit 4; }
done

if [ -z "${DEVIN_API_KEY:-}" ]; then
  echo "NO_KEY: set DEVIN_API_KEY to an org-scoped service-user key (Settings → Service users)." >&2
  echo "        Required role permissions: ViewSessions, ViewPlaybooks, ViewKnowledge (read probes);" >&2
  echo "        CreateSessions + ImpersonateOrgSessions for the coordinator to spawn work." >&2
  exit 2
fi
case "$DEVIN_API_KEY" in cog_*) ;; *) echo "WARN: key does not start with cog_ (v3 service-user keys do)" >&2 ;; esac

# Unauthenticated liveness: the API answers 403 problem+json when reachable.
live=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE/v3/organizations/$ORG/sessions?limit=1" 2>/dev/null || true)
if [ -z "$live" ] || [ "$live" = "000" ]; then
  echo "UNREACHABLE: $BASE (network/TLS)" >&2
  exit 3
fi

probe() { # name path
  local name="$1" path="$2" code body
  body=$(mktemp)
  code=$(curl -s -o "$body" -w '%{http_code}' --max-time 30 \
    -H "Authorization: Bearer $DEVIN_API_KEY" -H 'Accept: application/json' \
    "$BASE$path" 2>/dev/null || true)
  [ -n "$code" ] || code=000
  local count="null"
  if [ "$code" = "200" ]; then
    count=$(jq -r 'if type=="object" and has("items") then (.items|length) elif type=="array" then length else "n/a" end' "$body" 2>/dev/null || echo "n/a")
  fi
  local detail
  detail=$(jq -r '.detail // .title // empty' "$body" 2>/dev/null || true)
  rm -f "$body"
  printf '%s\t%s\t%s\t%s\n' "$name" "$code" "$count" "${detail:-}"
}

results=$(
  probe sessions  "/v3/organizations/$ORG/sessions?limit=1"
  probe playbooks "/v3/organizations/$ORG/playbooks"
  probe knowledge "/v3/organizations/$ORG/knowledge/notes?first=1"
)

fail=0
if [ "$JSON" = 1 ]; then
  echo "$results" | jq -R -s -c --arg base "$BASE" --arg org "$ORG" '
    split("\n") | map(select(length>0) | split("\t")
      | {probe: .[0], status: (.[1]|tonumber), items: .[2], detail: .[3]})
    | {base: $base, org: $org, probes: ., ready: (all(.[]; .status==200))}'
  echo "$results" | awk -F'\t' '$2!=200{exit 1}' || fail=1
else
  echo "base: $BASE"
  echo "org:  $ORG"
  while IFS=$'\t' read -r name code count detail; do
    if [ "$code" = "200" ]; then
      echo "PASS  $name (HTTP 200, items=$count)"
    else
      echo "FAIL  $name (HTTP $code${detail:+: $detail})"
      fail=1
    fi
  done <<<"$results"
  if [ "$fail" = 0 ]; then
    echo "READY: service user can read sessions, playbooks and knowledge for $ORG"
  else
    echo "NOT READY: grant the missing permission on the service user's role, then rerun"
  fi
fi
exit "$fail"
