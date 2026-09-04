# Security / dependency negative controls

Executable audit probes for the `security-secrets-deps` subsystem. Each file is a
`node --test` suite that pins a contract the gate is supposed to enforce; a
**failing** test here is a defect in the gate, not in the test. Nothing under this
directory is wired into `pnpm test` / CI — run it on demand:

```sh
node --test tools/security-audit/dependency_policy.test.mjs        # static, < 1 s
node --test tools/security-audit/loadtest_guards.test.mjs          # static, < 1 s
node --test --test-timeout=1200000 tools/security-audit/security_scan_gate.test.mjs
```

`security_scan_gate.test.mjs` clones the current checkout into a temp directory,
plants **runtime-generated** synthetic tokens (nothing secret-shaped is stored in
the repo), commits them there, and runs `scripts/security-scan.sh` against the
scratch clone. It never touches the real checkout or any remote; the scratch clone
is deleted afterwards (`SECURITY_AUDIT_KEEP=1` keeps it for inspection). It needs
`scripts/security-scan.sh`'s pinned gitleaks (self-downloaded on first run) and
takes a few minutes because every history scan walks all commits.

| Suite                               | What a failure means                                          |
| ----------------------------------- | ------------------------------------------------------------- |
| `secret gate — controls`            | the scanner itself is broken (should always pass)             |
| `path allowlists`                   | `.gitleaks.toml` path allowlists hide committed credentials   |
| `extension allowlists`              | binary/model allowlists are extension-only, not content-based |
| `scanner binary trust`              | `GITLEAKS_BIN` / cache reuse accept a non-gitleaks executable |
| `history scope`                     | default history scan fails HEAD's gate for unrelated refs     |
| `edge function dependency pinning`  | a floating `npm:pkg@N` specifier with no lockfile beside it   |
| `dependency vulnerability scanning` | the "dependency scan" stage runs no audit                     |
| `toolchain engine contracts`        | engines/packageManager pins disagree with CI or react-native  |
| `k6 load-test scripts`              | a script could target production without an explicit BASE_URL |
