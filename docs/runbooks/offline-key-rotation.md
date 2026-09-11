# Runbook — Offline grant signing-key rotation (planned, P0 if compromised)

The Edge Function (`supabase/functions/api`) signs offline execution grants as
compact ES256 JWS. Every signature is tagged with the signing key's `kid` in
the protected header, and verification selects the public key by that `kid`.
The configured material is a **key ring**: exactly one **active** key (the only
key that ever signs) and at most one **previous** key whose signatures are
honoured only inside a **bounded overlap window**. This runbook is the only
approved way to introduce a new signing key, retire the old one and drop it.

Code: `supabase/functions/api/offlineSignature.ts` (`importOfflineGrantKeyRing`,
`verifyOfflineExecutionGrant`, `OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS`,
`OFFLINE_KEY_ROTATION_MAX_EPOCH_SECONDS`,
`OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS`);
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

- **Key-material consistency** (checked at import, before any grant is
  issued; each failure is `invalid_key` → generic 503, no `issue_offline_grant`
  call):
  - `active.d` must be a valid P-256 scalar (`0 < d < n`) and `active.x/y`
    must be the public point that belongs to that `d` — the importer signs a
    probe with `d` and verifies it under `(x, y)`. A private JWK whose
    coordinates were copied from another key is refused, in both the bare
    single-JWK form and the ring form.
  - Every `x/y` pair (active and previous) must be a point on P-256 (32-byte
    base64url coordinates that satisfy the curve equation). Off-curve
    material is refused at import rather than failing every verification.
  - `previous.jwk.x` must differ from the active key's `x`. On P-256 two
    points with the same `x` are the same point or its negation `(x, p - y)`,
    and the negated point is controlled by the active scalar (`n - d`); either
    way a single private key would sign under both kids, which is not a
    rotation and is refused.

- **Window**: `retiredAtEpochSeconds ≤ overlapEndsAtEpochSeconds ≤
retiredAtEpochSeconds + OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS`
  (7 days = the longest Pro lease). Both instants are **Unix seconds**:
  non-negative integers no later than `OFFLINE_KEY_ROTATION_MAX_EPOCH_SECONDS`
  = 253402300799 (9999-12-31T23:59:59Z, the bound every other timestamp of the
  offline contract uses). A value in **milliseconds** (13 digits for any
  current date), or anything else past that bound, is `invalid_key` — the
  overlap length is only meaningful relative to a plausible instant. Both
  bounds are enforced at import and again at verification time.
- **Propagation grace** `OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS`
  (15 minutes, fixed in code): the slack between the instant you write into
  the ring and the instant the new secret actually takes effect on every
  isolate. The route keeps signing under the OLD key until the new value has
  propagated; those grants are spent by the server and may already be on an
  offline device, so they must verify. The grace also anchors the window to
  the trusted clock: a ring whose `retiredAt` is more than one grace ahead of
  `now` is not in force yet and its previous key verifies nothing, so a
  far-future `retiredAt` cannot keep the old key an accepted issuer.
- **Verification verdicts** for a grant whose header `kid` is the previous key
  (`grace` = the constant above; `now` is the server's trusted clock, never a
  value from the token):
  - `retiredAt - grace ≤ now < overlapEndsAt` **and** `iat ≤ retiredAt + grace`
    → valid (signature, bindings, expiry and release still checked as before).
  - `now ≥ overlapEndsAtEpochSeconds` → `retired_key`.
  - `now < retiredAtEpochSeconds - grace` → `retired_key` (the ring's
    retirement instant is not plausible yet).
  - `iat > retiredAtEpochSeconds + grace` → `retired_key` (the old key must
    never mint a grant once the new secret has had time to land, even inside
    the overlap).
  - After the previous entry is dropped (`previous: null`) → `invalid_key`.
- **Issuance** always uses `active`; the response `keyId` and the
  `offline_grant_audit` log line show which key signed. The signed claims do
  **not** carry the key list. `ring.allowedKeyIds = [active kid, previous kid]`
  is verifier-side binding context: the server derives it from the ring it
  holds and passes it as `binding.allowedKeyIds` when signing and verifying,
  so the allowlist can only name keys the server actually holds. A binding
  may narrow the ring further (for example to the active `kid` only); it can
  never add a key the ring does not hold.
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
3. **Choose the window** — in **Unix seconds** (`date -u +%s`; 10 digits for
   any current date, never `Date.now()` milliseconds):
   - `retiredAtEpochSeconds` = the instant you expect to run `supabase secrets
set` in step 5, i.e. the clock reading at this step **plus** the time the
     remaining steps take (assembling, dry-import, review). Step 5 must then
     happen inside `[retiredAt - grace, retiredAt + grace]` (±15 minutes):
     earlier and the ring is not in force yet (old-key receipts are
     `retired_key` until the clock catches up — harmless but visible);
     later and grants the route still issued under the old key while the
     secret propagated fall outside `iat ≤ retiredAt + grace` and are refused
     although the server spent them. If step 5 slips past the grace, re-read
     the clock, update `retiredAt`/`overlapEndsAt` and dry-import again.
   - `overlapEndsAtEpochSeconds` = `retiredAt` + the longest lease the old
     key may still have outstanding (a grant issued at `retiredAt + grace`
     lives at most 7 days), capped at `retiredAt` + 7 days. Shorter is
     better; a longer value than the bound, or either instant past
     9999-12-31, is refused.
4. **Assemble the ring document** (`active` = new private JWK, `previous` =
   old public JWK + window) and check it locally before touching production:

   ```bash
   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json offline_key_rotation.test.ts
   ```

   Then dry-import the exact document you are about to set, from the
   repository root (reads the file, prints only the kids and window — never
   the keys). The dry-import runs the same importer as the route, including
   the key-material consistency checks above, so a document it accepts is one
   the route will sign with, and one it refuses is one the route would 503 on:

   ```bash
   deno eval --config supabase/functions/api/deno.json \
     'const r = await (await import("./supabase/functions/api/offlineSignature.ts")).importOfflineGrantKeyRing(JSON.parse(await Deno.readTextFile(Deno.args[0]))); console.log(r.allowedKeyIds, r.previousKey?.retiredAtEpochSeconds, r.previousKey?.overlapEndsAtEpochSeconds);' \
     /path/to/ring.json
   ```

   An `OfflineGrantCryptoError: invalid_key` here means the document would
   503 in production — fix it first. Typical causes: `d` and `x/y` from
   different keys (re-export the new key pair together), an `x/y` that is not
   a P-256 point, a previous entry that still carries `d`, a previous entry
   whose `x` equals the active key's (same or negated point), instants given
   in milliseconds or past 9999-12-31, or a window past the 7-day bound.

5. **Set the secret** (coordinated rollout only; requires an explicit
   human go-ahead per `AGENTS.md`):

   ```bash
   supabase secrets set OFFLINE_GRANT_SIGNING_JWK="$(cat /path/to/ring.json)"
   ```

   No redeploy is required: the next request re-imports the ring. Check the
   clock once more before running it: it must be within one grace (15
   minutes) of the `retiredAtEpochSeconds` in the document.

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
- Never widen `OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS`,
  `OFFLINE_KEY_ROTATION_MAX_EPOCH_SECONDS` or
  `OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS`, and never make the
  verifier read the window from the token.
- Never set `retiredAtEpochSeconds` far in the future to "pre-stage" a
  rotation: the previous key verifies nothing until the clock is within one
  grace of it, and the route signs with `active` from the moment the secret
  lands regardless.
- Validate before shipping any change to this path:

  ```bash
  npx --yes deno@2.5.6 check --node-modules-dir=none --frozen --lock=deno.lock supabase/functions/api/index.ts
  cd supabase/functions/api/__wf__ && XC_PG_URL=<disposable postgres url> deno task test
  ```
