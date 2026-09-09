# Runbook — Offline grant signing-key rotation (planned, P0 if compromised)

The Edge Function (`supabase/functions/api`) signs offline execution grants as
compact ES256 JWS. Every signature is tagged with the signing key's `kid` in
the protected header, and verification selects the public key by that `kid`.
The configured material is a **key ring**: exactly one **active** key (the only
key that ever signs) and at most one **previous** key whose signatures are
honoured only inside a **bounded overlap window**. This runbook is the only
approved way to introduce a new signing key, retire the old one and drop it.

Code: `supabase/functions/api/offlineSignature.ts` (`importOfflineGrantKeyRing`,
`verifyOfflineExecutionGrant`, `OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS`);
wiring: `offlineGrantKeyRing()` and `POST /v1/offline/grants` in
`supabase/functions/api/index.ts`. Regression pins:
`supabase/functions/api/__wf__/offline_key_rotation.test.ts` and the
"key ring" tests in `supabase/functions/api/offlineSignature.test.ts`.

## Contract

- **Secret**: `OFFLINE_GRANT_SIGNING_JWK` (Supabase secret). It holds either
  a single private P-256 JWK with a `kid` (a ring with no previous key — the
  pre-rotation format, still accepted) or the ring document below.
- **Ring document** (`schemaVersion` 1, no other top-level members):

  ```json
  {
    "schemaVersion": 1,
    "active": { "kty": "EC", "crv": "P-256", "kid": "<new kid>", "x": "…", "y": "…", "d": "…" },
    "previous": {
      "jwk": { "kty": "EC", "crv": "P-256", "kid": "<old kid>", "x": "…", "y": "…" },
      "retiredAtEpochSeconds": 1788000000,
      "overlapEndsAtEpochSeconds": 1788604800
    }
  }
  ```

  `previous` is `null` when there is no overlap in force. It carries the
  **public half only** — a `d` member, a `kid` equal to the active `kid`, a
  missing `kid`, unknown members, or a malformed window make the whole ring
  `invalid_key` and the route answers a generic **503** (`SigningKeyUnavailable`)
  without spending a grant. Nothing is signed with a half-configured ring.

- **Window**: `retiredAtEpochSeconds ≤ overlapEndsAtEpochSeconds ≤
retiredAtEpochSeconds + OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS`
  (7 days = the longest Pro lease). Instants are non-negative integer epoch
  seconds. The bound is enforced at import and again at verification time.
- **Verification verdicts** for a grant whose header `kid` is the previous key:
  - `iat ≤ retiredAtEpochSeconds` **and** `now < overlapEndsAtEpochSeconds`
    → valid (signature, bindings, expiry and release still checked as before).
  - `now ≥ overlapEndsAtEpochSeconds` → `retired_key`.
  - `iat > retiredAtEpochSeconds` → `retired_key` (the old key must never mint
    a grant after it was retired, even inside the overlap).
  - After the previous entry is dropped (`previous: null`) → `invalid_key`.
    `now` is the server's trusted clock, never a value from the token.
- **Issuance** always uses `active`; the response `keyId` and the
  `offline_grant_audit` log line show which key signed. Grants embed
  `allowedKeyIds = [active kid, previous kid]` from the ring, so a client
  binding never allowlists a key the server does not hold.
- Rotation is a **new secret value**: the isolate re-imports the ring on the
  first request after the value changes (cache keyed by the raw value). No
  remote key discovery, no clock fallback, no state writes.

## Procedure (planned rotation)

Work in a scratch directory that is deleted afterwards. Never paste key
material into chat, tickets, commits, logs or this repository.

1. **Generate** the new key pair with a fresh `kid` (date-stamped, e.g.
   `offline-grant-2026-09`). Any P-256 generator that exports a private JWK
   with `kty`, `crv`, `x`, `y`, `d`, `kid` is acceptable; the importer refuses
   other curves, extra members, and `key_ops` other than `["sign"]`.
2. **Extract the public half** of the CURRENT key (`kty`, `crv`, `kid`, `x`,
   `y` only — strip `d`). The current kid is visible in recent
   `offline_grant_audit` log lines (`keyId`) and in grant responses.
3. **Choose the window.** `retiredAtEpochSeconds` = the instant you will set
   the secret (now). `overlapEndsAtEpochSeconds` = `retiredAt` + the longest
   lease the old key may still have outstanding, capped at 7 days. Shorter
   is better; a longer value than the bound is refused.
4. **Assemble the ring document** (`active` = new private JWK, `previous` =
   old public JWK + window) and check it locally before touching production:

   ```bash
   cd supabase/functions/api/__wf__ && deno task test  # all Edge tests, no live DB needed for the rotation file
   ```

   Then dry-import the exact document you are about to set (reads the file,
   prints only the kids and window — never the keys):

   ```bash
   deno eval --config supabase/functions/api/deno.json \
     'const r = await (await import("./supabase/functions/api/offlineSignature.ts")).importOfflineGrantKeyRing(JSON.parse(await Deno.readTextFile(Deno.args[0]))); console.log(r.allowedKeyIds, r.previousKey?.retiredAtEpochSeconds, r.previousKey?.overlapEndsAtEpochSeconds);' \
     /path/to/ring.json
   ```

   An `invalid_key` here means the document would 503 in production — fix it
   first.

5. **Set the secret** (coordinated rollout only; requires an explicit
   human go-ahead per `AGENTS.md`):

   ```bash
   supabase secrets set OFFLINE_GRANT_SIGNING_JWK="$(cat /path/to/ring.json)"
   ```

   No redeploy is required: the next request re-imports the ring.

6. **Verify** with a signed-in test device: `POST /v1/offline/grants` returns
   200 with `keyId` = the NEW kid, and the `offline_grant_audit` line shows the
   same. A 503 `SigningKeyUnavailable` means the document was refused — revert
   to the previous secret value (step 8's "roll back") and fix the document.
7. **Wait out the overlap.** Grants issued under the old key keep verifying
   until `overlapEndsAtEpochSeconds`; after that instant they are refused with
   `retired_key` regardless of their own `exp`. Devices simply re-request a
   grant, which is signed by the active key.
8. **Drop the previous key** once `overlapEndsAtEpochSeconds` has passed (or
   immediately on compromise — see below): set the secret again with
   `"previous": null` (or the bare active private JWK). Old-key signatures are
   now `invalid_key`. **Roll back** (only before any new-key grant was issued):
   restore the previous secret value; the ring accepts the old single-JWK form.
9. **Destroy** the old private key and the scratch directory. The old public
   half stays in the ring only until step 8.

## Compromise of the active key (P0)

Do NOT set an overlap. Generate a new key (step 1) and set the ring with
`previous: null` — every grant under the compromised key becomes
`invalid_key` immediately; unexpired legitimate grants are re-issued under
the new key on the device's next request. Then follow `docs/runbooks/README.md`
incident flow (evidence → investigate → fix → validate → postmortem) and
record which `kid` was compromised and when the ring was replaced.

## Guardrails

- Two keys at most; a second previous key is not supported and must not be
  worked around by lengthening the window.
- Never put the previous key's `d` in the ring — the importer refuses it, and
  the old private key must not remain on the server after rotation.
- Never widen `OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS`, and never make the
  verifier read the window from the token.
- Validate before shipping any change to this path:

  ```bash
  npx --yes deno@2.5.6 check --node-modules-dir=none --frozen --lock=deno.lock supabase/functions/api/index.ts
  cd supabase/functions/api/__wf__ && XC_PG_URL=<disposable postgres url> deno task test
  ```
