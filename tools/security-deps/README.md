# security-deps — dependency audit harness

Read-only tooling. Nothing here changes a manifest, a lockfile or `node_modules`;
every script writes only to its `--out-dir`.

| script                    | what it does                                                                                                                                                                                                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `osv_scan.mjs`            | Parses `pnpm-lock.yaml`, `apps/mobile/package-lock.json`, `deno.lock`, `apps/mobile/Gemfile.lock`, the SwiftPM `Package.resolved` and `apps/mobile/ios/Podfile.lock`, queries OSV (`/v1/querybatch` + `/v1/vulns`) and writes `osv-scan.{json,md}` with CVE ids, severity, fixed versions and dependency paths. |
| `dep_inventory.mjs`       | Duplicated/conflicting versions per tree, packages with `preinstall`/`install`/`postinstall` scripts in the installed trees, deprecated packages, packages with no release in 24 months, and floating specifiers (`npm:pkg@major`, `latest`).                                                                   |
| `bundle_reachability.mjs` | Builds the iOS release JS bundle with Metro (`--dev false`, sourcemap on) and reports which packages named by OSV/`npm audit` are actually included in the shipped bundle.                                                                                                                                      |

## Replay

```bash
# from repo root; pnpm 10.15.1 and apps/mobile `npm ci` already done
OUT=artifacts/security-deps
pnpm audit --json > $OUT/pnpm-audit.json
(cd apps/mobile && npm audit --json > ../../$OUT/npm-audit-mobile.json)
node tools/security-deps/osv_scan.mjs --out-dir $OUT/osv
node tools/security-deps/dep_inventory.mjs --out-dir $OUT/inventory
node tools/security-deps/bundle_reachability.mjs \
  --osv $OUT/osv/osv-scan.json --npm-audit $OUT/npm-audit-mobile.json \
  --out-dir $OUT/bundle
```

Ranking rule used in the audit: a CVE is _reachable_ only if the vulnerable
package is in the release bundle (`bundle-reachability.json`) **and** the
application can drive attacker-controlled input into the vulnerable API. Build-,
CLI- and dev-server-only packages (metro, `@react-native-community/cli-*`,
`xcode`, Bundler gems) are inventoried but ranked as not reachable in the app.
