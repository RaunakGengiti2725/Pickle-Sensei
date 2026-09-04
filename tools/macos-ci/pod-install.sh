#!/usr/bin/env bash
# Install the iOS CocoaPods dependencies for apps/mobile on the Mac runner.
#
# Preferred path (matches AGENTS.md): the repo Gemfile via Bundler, which pins
# cocoapods/xcodeproj/activesupport to the versions the Podfile.lock was made
# with. That needs a Ruby >= 3.1 (fastlane / activesupport 7). If the runner's
# Ruby is too old (macOS ships 2.6), fall back to a Homebrew-installed
# CocoaPods, which bundles its own Ruby. Fails loudly if neither is possible.
#
# Must run from the repo root. Requires `node` on PATH (the Podfile resolves
# react_native_pods.rb through node).
set -euo pipefail

MOBILE_DIR="apps/mobile"
IOS_DIR="$MOBILE_DIR/ios"
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
# Keep gems out of the (non-writable) system Ruby and out of the checkout so a
# persistent cache survives `actions/checkout` cleaning the workspace.
export BUNDLE_PATH="${BUNDLE_PATH:-$HOME/Library/Caches/PickleSensei-CI/bundle}"
export BUNDLE_JOBS="${BUNDLE_JOBS:-4}"
# CocoaPods trunk CDN only; never prompt.
export COCOAPODS_DISABLE_STATS=1

command -v node >/dev/null || { echo "::error::node is required on PATH before pod install"; exit 1; }

# Surface Rubies the runner shell may not have on PATH (Homebrew, rbenv, mise).
for dir in /opt/homebrew/opt/ruby/bin "$HOME/.rbenv/shims" "$HOME/.local/share/mise/shims"; do
  if [ -d "$dir" ]; then
    export PATH="$dir:$PATH"
  fi
done

ruby_is_recent() {
  command -v ruby >/dev/null && ruby -e 'exit(Gem::Version.new(RUBY_VERSION) >= Gem::Version.new("3.1") ? 0 : 1)'
}

echo "node: $(node --version)"
echo "ruby on PATH: $(command -v ruby || echo none) $(ruby --version 2>/dev/null || true)"

if ruby_is_recent; then
  echo "using repo Gemfile via Bundler (BUNDLE_PATH=$BUNDLE_PATH)"
  if ! command -v bundle >/dev/null; then
    gem install bundler --no-document --user-install
    export PATH="$(ruby -e 'print Gem.user_dir')/bin:$PATH"
  fi
  (cd "$MOBILE_DIR" && bundle install)
  (cd "$MOBILE_DIR" && bundle exec pod --version)
  (cd "$IOS_DIR" && bundle exec pod install)
elif command -v pod >/dev/null; then
  echo "Ruby on PATH is too old for the Gemfile; using system-wide CocoaPods $(pod --version)"
  (cd "$IOS_DIR" && pod install)
elif command -v brew >/dev/null; then
  echo "Ruby on PATH is too old for the Gemfile and no 'pod' found; installing CocoaPods via Homebrew"
  HOMEBREW_NO_AUTO_UPDATE=1 brew install cocoapods
  (cd "$IOS_DIR" && pod install)
else
  echo "::error::No usable Ruby >= 3.1 (for the Gemfile), no 'pod', and no Homebrew on this runner."
  echo "Install one of: 'brew install cocoapods' or a Ruby >= 3.1 (e.g. 'brew install ruby')."
  exit 1
fi

echo "pod install complete; Podfile.lock status:"
git -C "$IOS_DIR" status --short Podfile.lock || true
