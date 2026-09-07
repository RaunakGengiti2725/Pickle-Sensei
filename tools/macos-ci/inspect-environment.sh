#!/usr/bin/env bash
# Inspect the self-hosted Mac runner: OS, hardware, Xcode, Swift, SDKs,
# simulator runtimes/devices, and the toolchains the iOS build needs.
#
# Prints a human-readable report and writes the same report to the path given
# as $1 (default: macos-ci-artifacts/environment.txt). Never prints secrets or
# environment variables; hardware identifiers (serial / UUID) are redacted.
set -euo pipefail

OUT="${1:-macos-ci-artifacts/environment.txt}"
mkdir -p "$(dirname "$OUT")"

section() {
  printf '\n=== %s ===\n' "$1"
}

run() {
  # Run a command, never fail the inspection because one probe is missing.
  if ! "$@" 2>&1; then
    echo "(probe failed: $*)"
  fi
}

{
  section "Runner"
  echo "runner name: ${RUNNER_NAME:-unknown}"
  echo "runner os/arch: ${RUNNER_OS:-unknown}/${RUNNER_ARCH:-unknown}"
  echo "workspace: ${GITHUB_WORKSPACE:-$(pwd)}"
  echo "date (UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"

  section "macOS"
  run sw_vers
  echo "kernel arch: $(uname -m)"
  echo "uptime:$(uptime)"

  section "Hardware"
  run system_profiler SPHardwareDataType -detailLevel mini \
    | grep -Ev 'Serial Number|Hardware UUID|Provisioning UDID' || true
  echo "logical cpus: $(sysctl -n hw.logicalcpu)"
  echo "memory bytes: $(sysctl -n hw.memsize)"

  section "Disk"
  run df -h / "${HOME}"

  section "Xcode"
  echo "xcode-select -p: $(xcode-select -p 2>&1 || true)"
  echo "DEVELOPER_DIR: ${DEVELOPER_DIR:-<unset>}"
  run xcodebuild -version
  run xcrun --find xcodebuild
  echo "license accepted: $(xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1 && echo yes || echo 'no / first-launch pending')"

  section "Swift"
  run swift --version

  section "SDKs"
  run xcodebuild -showsdks

  section "Simulator runtimes"
  run xcrun simctl list runtimes

  section "Simulator devices (available)"
  run xcrun simctl list devices available

  section "Node / npm"
  echo "node: $(command -v node || echo missing) $(node --version 2>/dev/null || true)"
  echo "npm:  $(command -v npm || echo missing) $(npm --version 2>/dev/null || true)"
  echo "pnpm: $(command -v pnpm || echo missing) $(pnpm --version 2>/dev/null || true)"

  section "Ruby / CocoaPods"
  echo "ruby:    $(command -v ruby || echo missing) $(ruby --version 2>/dev/null || true)"
  echo "gem:     $(command -v gem || echo missing) $(gem --version 2>/dev/null || true)"
  echo "bundler: $(command -v bundle || echo missing) $(bundle --version 2>/dev/null || true)"
  echo "pod:     $(command -v pod || echo missing) $(pod --version 2>/dev/null || true)"
  for candidate in /opt/homebrew/opt/ruby/bin/ruby "$HOME/.rbenv/shims/ruby" "$HOME/.rvm/rubies"; do
    if [ -e "$candidate" ]; then
      echo "also present: $candidate $("$candidate" --version 2>/dev/null || true)"
    fi
  done

  section "Homebrew"
  echo "brew: $(command -v brew || echo missing) $(brew --version 2>/dev/null | head -1 || true)"

  section "Python"
  echo "python3: $(command -v python3 || echo missing) $(python3 --version 2>/dev/null || true)"

  section "Git"
  run git --version
} | tee "$OUT"

echo
echo "environment report written to $OUT"
