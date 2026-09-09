# Runbook — Offline grant signing-key rotation

The Edge Function signs every offline execution grant (`POST /v1/offline/grants`)
as a compact ES256 JWS whose protected header carries the signing key's `kid`.
The key material lives in the Supabase secret `OFFLINE_GRANT_SIGNING_JWK`,
imported by `importOfflineGrantKeyRing()` in
`supabase/functions/api/offlineSignature.ts`. This runbook rotates that key
without invalidating grants that devices already hold and may be using
offline, and without ever letting the retired key outlive its bounded overlap.

Nothing here touches production by itself: every `supabase secrets set`
against project `ucqnaiwqwjtgvlduiuib` needs an explicit human go-ahead in the
session that performs it, exactly like a deploy.

## Contract (the code's numbers)

| Symbol                                           | Value                                    | Meaning                                                                                                                                                      |
| ------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OFFLINE_GRANT_KEY_RING_SCHEMA_VERSION`          | `1`                                      | Shape of the structured secret below.                                                                                                                        |
| `OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS`       | `OFFLINE_PRO_LEASE_MAX_SECONDS` (7 days) | Longest a previous key may keep verifying: `overlapEndsAtEpochSeconds - retiredAtEpochSeconds` must not exceed it (a zero-length window is allowed).         |
| `OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS` | `3600 s` (one hour)                      | How long after `retiredAtEpochSeconds` the old key may still have _issued_ a grant this verifier honours, and how far ahead of the clock `retiredAt` may be. |

Every timestamp is **Unix seconds**. The importer refuses (`invalid_key`) a
`retiredAtEpochSeconds` or `overlapEndsAtEpochSeconds` that is negative, not a
safe integer, later than `253402300799` (9999-12-31T23:59:59Z — the offline
contract's last instant), or given in milliseconds; it also refuses a
`retiredAtEpochSeconds` later than `now + OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS`
on the importing isolate's clock. A retirement instant the trusted clock cannot
corroborate would make the "bounded" overlap relative to a bogus instant, so it
never imports and the route answers a generic `503` and spends no grant.

### Verification semantics

Given a ring `{active, previous}` and a grant whose header names `kid`:

- `kid == active.kid` → verified normally; the active key has no issuance
  cut-off and no window.
- `kid == previous.kid` → verified only if **all** hold, otherwise `retired_key`:
  - `now < overlapEndsAtEpochSeconds` (the end is **exclusive**: at
    `overlapEndsAt` itself the receipt is already refused even if its lease has
    not expired);
  - `iat <= retiredAtEpochSeconds + OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS`
    (the retired key may not _mint_: a previous-key grant issued later than the
    grace is refused inside the overlap too).
- Any other `kid` → `invalid_key`. Once `previous` is dropped from the ring,
  its receipts are `invalid_key` as well.
- A verifier whose trusted clock is more than one grace _before_
  `retiredAtEpochSeconds` refuses the ring (`invalid_key`): the ring describes
  a retirement that has not happened yet.

`allowedKeyIds` is **verifier-side binding context**, never a signed claim. The
grant payload does not carry the allowlist; the verifier supplies it (the ring's
`allowedKeyIds`, i.e. `[active.kid]` or `[active.kid, previous.kid]`) and the
metadata contract refuses a `kid` outside it (`invalid_metadata`) before any key
is consulted. The allowlist can only narrow the ring — a binding that names only
the active kid keeps verifying active-key grants through a ring that still holds
the previous key, and a kid the allowlist names but the ring does not hold is
`invalid_key`. The route signs with `allowedKeyIds: [signingKey.kid]`; the
device binds the issued `keyId` the same way (`bindIssuedGrant` in
`apps/mobile/src/data/offlineCapabilities.ts`).

### Material the importer refuses (`invalid_key`)

- `previous.jwk` carrying private material (`d`) — the previous entry is the
  public half only, so the secret never holds two live private keys.
- `previous.jwk.kid == active.kid`.
- `previous.jwk` sharing the active key's `x` coordinate: the identical point
  **and** its negation `(x, p - y)`. On P-256 `P = ±Q ⇔ same x`, and the negated
  point's private scalar is `n - d`, trivially derived from the active `d`; a
  single private key would then control both kids and could exercise the
  previous kid's window. Two rotations must therefore use genuinely fresh key
  pairs — never re-derive the "previous" key from the active one.
- An active `d` outside `[1, n-1]`, coordinates off the curve
  (`y² ≠ x³ − 3x + b mod p`), or a public point that does not belong to its `d`
  (the importer signs a probe with the private key and verifies it with the
  public half; a mismatched d/(x, y) pair never signs).
- Any field outside the documented shape, `schemaVersion != 1`, a missing
  `previous` member (use `null` explicitly), a non-EC / non-P-256 JWK, or a
  key whose `key_ops` is not exactly `["sign"]` (active) / `["verify"]`
  (previous) when present.

## Procedure

Work on a clean machine with the Supabase CLI linked to the project; never
paste key material into chat, tickets, logs or commit messages.

### 0. Generate the new key pair

```bash
deno eval '
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const kid = "offline-" + new Date().toISOString().slice(0, 10).replaceAll("-", "");
const priv = { ...(await crypto.subtle.exportKey("jwk", pair.privateKey)), kid, key_ops: ["sign"] };
const pub = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, key_ops: ["verify"] };
delete priv.ext; delete pub.ext; delete priv.alg; delete pub.alg;
await Deno.writeTextFile("new-private.jwk.json", JSON.stringify(priv));
await Deno.writeTextFile("new-public.jwk.json", JSON.stringify(pub));
'
```

Pick a `kid` that differs from the current one (the importer refuses a
collision). Keep `new-private.jwk.json` out of the repository and out of any
shell history; delete it once the secret is set.

### 1. Export the current key's public half

Read the current `OFFLINE_GRANT_SIGNING_JWK` value from the operator's secure
store (the Supabase dashboard never shows it back). If it is a bare private
JWK, its `{kty, crv, kid, x, y}` with `key_ops: ["verify"]` is the previous
public JWK. If it is already a ring document, `active` is the key being retired
now and the existing `previous` is **dropped** — the ring holds at most one
previous key, so wait for the current overlap to end (or accept that the older
key's receipts become `invalid_key` immediately) before rotating again.

### 2. Choose the instants

- `retiredAtEpochSeconds` = the Unix-seconds instant you will run
  `supabase secrets set` in step 4 — read the clock right before the command
  (`date +%s`). Do **not** back-date it to the moment you started assembling
  the ring: the old secret keeps signing in already-running isolates until the
  new value propagates (cold start, dry import, typing), and every grant the
  server issues in that gap was spent by `issue_offline_grant` and may be held
  by a device that is now offline. The code honours such grants for
  `OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS` (3600 s) after
  `retiredAtEpochSeconds`; if propagation could take longer than that in your
  situation, set `retiredAt` a little into the future (at most one grace ahead
  of the clock, or the import is refused) and run step 4 at that instant.
- `overlapEndsAtEpochSeconds` = `retiredAt + overlap`, with
  `0 <= overlap <= OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS`. Use the longest
  lease the previous key may have issued (7 days for Pro leases; shorter if you
  know from the audit log — `evt: "offline_grant_audit"`, `keyId` — that no
  longer lease is outstanding). Receipts are refused at `overlapEndsAt` even if
  their lease has not expired, so a shorter overlap trades operator convenience
  for devices that must come online and re-request.

### 3. Assemble and dry-import the ring

```json
{
  "schemaVersion": 1,
  "active": {
    "kty": "EC",
    "crv": "P-256",
    "kid": "<new kid>",
    "x": "…",
    "y": "…",
    "d": "…",
    "key_ops": ["sign"]
  },
  "previous": {
    "jwk": {
      "kty": "EC",
      "crv": "P-256",
      "kid": "<old kid>",
      "x": "…",
      "y": "…",
      "key_ops": ["verify"]
    },
    "retiredAtEpochSeconds": 1788000000,
    "overlapEndsAtEpochSeconds": 1788604800
  }
}
```

Dry-import it with the code that will run in production, against the same
clock the route will use:

```bash
cd supabase/functions/api && deno eval --lock=deno.lock '
import { importOfflineGrantKeyRing } from "./offlineSignature.ts";
const ring = await importOfflineGrantKeyRing(JSON.parse(await Deno.readTextFile("ring.json")), Math.floor(Date.now() / 1000));
console.log({ signingKid: ring.signingKey.kid, allowedKeyIds: ring.allowedKeyIds, previous: ring.previousKey && { kid: ring.previousKey.kid, retiredAt: ring.previousKey.retiredAtEpochSeconds, overlapEndsAt: ring.previousKey.overlapEndsAtEpochSeconds } });
'
```

An `invalid_key` here is one of the refusals listed above (or a `retiredAt`
more than one grace ahead of this machine's clock); fix the document, never
the code. Delete `ring.json` after step 4.

### 4. Set the secret (human go-ahead required)

```bash
supabase secrets set OFFLINE_GRANT_SIGNING_JWK="$(cat ring.json)"
```

The route caches the imported ring per distinct secret value, so isolates pick
the new ring up on their next request without a redeploy; no Edge deploy is
needed for a rotation. Confirm from the function logs that new
`offline_grant_audit` entries carry `keyId: <new kid>` and that no
`[api] Offline grant issuance:` error with `name: "SigningKeyUnavailable"` is
logged (the client sees only a generic `503`; the log line means the ring
failed to import and the route is refusing to issue — roll back to the previous
secret value immediately, then fix the document).

### 5. After the overlap: retire the previous key

Once `now >= overlapEndsAtEpochSeconds` the previous key verifies nothing
(`retired_key`). Set the secret again with `"previous": null` (or a bare
private JWK) so its public half leaves the configuration and its receipts
become `invalid_key`; keep the old private key only as long as your incident
policy requires for forensics, then destroy it.

### Compromise of the active key

Rotate immediately with `overlapEndsAtEpochSeconds == retiredAtEpochSeconds`
(zero overlap) — every receipt the compromised key signed is then refused at
once, and its issuance is cut off one grace after `retiredAt`. Devices holding
grants under the compromised key will have to come online and re-request;
their allocation is not reclaimed by the rotation (offline allocation is not
consumption). Treat the event as a P0 per
[`README.md`](./README.md) and preserve the `offline_grant_audit` log for the
window before mitigation.

## Verification before declaring the rotation validated

- `npx --yes deno@2.5.6 check --node-modules-dir=none --frozen --lock=deno.lock supabase/functions/api/index.ts`
- `cd supabase/functions/api/__wf__ && XC_PG_URL=<disposable postgres url> deno task test`
  (includes `offline_key_rotation.test.ts`, which pins every rule above
  against the real route handler)
- `deno test --frozen --lock=deno.lock supabase/functions/api/offlineSignature.test.ts`
