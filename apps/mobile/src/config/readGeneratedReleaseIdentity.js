/**
 * Reads `releaseIdentity.generated.json`, the record the Xcode bundle phase
 * (src/diagnostics/bundle-xcode.sh) writes from
 * `scripts/release-identity.mjs --check --require-committed --json` right
 * before Metro bundles. The file is a build artifact ignored by git: a tree
 * that was never built, or whose candidate the script refused, has none.
 * Metro only tolerates a missing module when the `require` sits directly
 * inside `try`, which is why this stays a CommonJS `require` in a JavaScript
 * module — a static import would fail every bundle, test and typecheck of an
 * unbuilt tree. Nothing here is trusted; `releaseIdentity.ts` validates it.
 *
 * @returns {unknown} the parsed file, or `null` when no build wrote one
 */
export function readGeneratedReleaseIdentity() {
  try {
    return require('./releaseIdentity.generated.json');
  } catch {
    return null;
  }
}
