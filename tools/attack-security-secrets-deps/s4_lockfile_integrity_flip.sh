#!/usr/bin/env bash
# S4 — flip one `integrity` hash in each lockfile and run the pipeline's install.
#
# Attack: a tampered lockfile that points at the real tarball but with a wrong
# sha512. The install must refuse the tarball.
#
# Checks:
#   s4.a  apps/mobile/package-lock.json (npm)  → `npm ci --ignore-scripts` exits != 0 with EINTEGRITY
#   s4.b  pnpm-lock.yaml (root workspace)      → `pnpm install --frozen-lockfile` exits != 0 with ERR_PNPM_TARBALL_INTEGRITY
#
# Both run in a temp export of the commit under test (package manifests + lockfiles
# only) so the real working tree is never touched. pnpm (root) is NEVER run in
# apps/mobile. Network: downloads the flipped package's tarball from the registry.
#
# Env: ATTACK_TARGET_NPM (default zustand), ATTACK_TARGET_PNPM (default zod)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
NPM_TARGET="${ATTACK_TARGET_NPM:-zustand}"
PNPM_TARGET="${ATTACK_TARGET_PNPM:-zod}"

# ── s4.a npm ────────────────────────────────────────────────────────────────────
temp_export "$TMP/npm" apps/mobile/package.json apps/mobile/package-lock.json
(cd "$TMP/npm/apps/mobile" && node -e '
// change one base64 character (5th after the dash) so the sha512 stays well-formed
const fs = require("fs");
const name = process.argv[1];
const l = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const e = l.packages[`node_modules/${name}`];
if (!e) throw new Error(`${name} not in package-lock.json`);
const orig = e.integrity;
const pos = orig.indexOf("-") + 5;
const flipped = orig.slice(0, pos) + (orig[pos] === "A" ? "B" : "A") + orig.slice(pos + 1);
console.log(`${name}@${e.version} ${e.resolved}\n  before ${orig}\n  after  ${flipped}`);
e.integrity = flipped;
fs.writeFileSync("package-lock.json", JSON.stringify(l, null, 2) + "\n");
' "$NPM_TARGET") >"$OUT/s4a-flip.txt" 2>&1
cat "$OUT/s4a-flip.txt" >&2
rc="$(cd "$TMP/npm/apps/mobile" && run_capture "$OUT/s4a-npm-ci.log" npm ci --ignore-scripts --no-audit --no-fund)"
if [ "$rc" != 0 ] && grep -q 'EINTEGRITY' "$OUT/s4a-npm-ci.log"; then
  record HELD s4.a-npm-integrity "$rc" "$OUT/s4a-npm-ci.log" "npm ci rejects the flipped sha512 (EINTEGRITY)"
else
  record BROKEN s4.a-npm-integrity "$rc" "$OUT/s4a-npm-ci.log" "npm ci did not fail with EINTEGRITY"
fi

# ── s4.b pnpm ───────────────────────────────────────────────────────────────────
mapfile -t WORKSPACE_MANIFESTS < <(cd "$REPO_ROOT" && git ls-files | grep -E '(^|/)package\.json$' | grep -v '^apps/mobile/')
temp_export "$TMP/pnpm" pnpm-lock.yaml pnpm-workspace.yaml "${WORKSPACE_MANIFESTS[@]}"
(cd "$TMP/pnpm" && node -e '
const fs = require("fs");
const name = process.argv[1];
let y = fs.readFileSync("pnpm-lock.yaml", "utf8");
const lines = y.split("\n");
const idx = lines.findIndex((l) => l.startsWith(`  ${name}@`) && l.endsWith(":"));
const m = idx === -1 ? null : [null, lines[idx].trim().slice(0, -1), (lines[idx + 1].match(/integrity: (sha512-[A-Za-z0-9+/=]+)/) || [])[1]];
if (m && !m[2]) throw new Error(`no integrity line under ${m[1]}`);
if (!m) throw new Error(`${name} entry not found in pnpm-lock.yaml`);
const orig = m[2];
const pos = orig.indexOf("-") + 5;
const flipped = orig.slice(0, pos) + (orig[pos] === "A" ? "B" : "A") + orig.slice(pos + 1);
console.log(`${m[1]}\n  before ${orig}\n  after  ${flipped}`);
fs.writeFileSync("pnpm-lock.yaml", y.replace(orig, flipped));
' "$PNPM_TARGET") >"$OUT/s4b-flip.txt" 2>&1
cat "$OUT/s4b-flip.txt" >&2
{ echo "pnpm $(pnpm --version) (package.json packageManager: $(node -e 'process.stdout.write(require(process.argv[1]).packageManager||"")' "$REPO_ROOT/package.json"))"; } >"$OUT/s4b-toolchain.txt"
rc="$(cd "$TMP/pnpm" && run_capture "$OUT/s4b-pnpm-install.log" pnpm install --frozen-lockfile --ignore-scripts)"
if [ "$rc" != 0 ] && grep -q 'ERR_PNPM_TARBALL_INTEGRITY' "$OUT/s4b-pnpm-install.log"; then
  record HELD s4.b-pnpm-integrity "$rc" "$OUT/s4b-pnpm-install.log" "pnpm install --frozen-lockfile rejects the flipped sha512 (ERR_PNPM_TARBALL_INTEGRITY)"
else
  record BROKEN s4.b-pnpm-integrity "$rc" "$OUT/s4b-pnpm-install.log" "pnpm install did not fail with ERR_PNPM_TARBALL_INTEGRITY"
fi

verdict
