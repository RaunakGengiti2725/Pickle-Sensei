# @pickle/first-party-intake

CPU intake validator for consented first-party capture clips (D2-12). It is
the executable half of
[`datasets/pickleball/FIRST_PARTY_CAPTURE_PROTOCOL.md`](../../datasets/pickleball/FIRST_PARTY_CAPTURE_PROTOCOL.md).

Per clip it:

1. verifies the consent reference against an exported C10 consent ledger
   (a `consent-ledger-export` envelope — integrity fields verified, and the
   v2 HMAC signature when the host holds the key — or a legacy bare
   JSON array of `ConsentRecord` rows from `@pickle/shared-types`): the
   subject pseudonym must have ACTIVE `video_analysis` AND `model_training`
   grants after folding the append-only ledger — a withdrawal rejects the
   clip, and so does a ledger that fails verification;
2. runs the C12 capture-envelope check on CPU (`@pickle/capture-envelope`,
   ffprobe/ffmpeg): `UNSUPPORTED` overall rejects, `DEGRADED` accepts with a
   flag; pose-gated dimensions stay honestly `NOT_MEASURED`;
3. drafts the `collection_manifest.schema.json` entry intake can honestly
   fill (SHA-256 digest, stream stats, capture metadata, consent reference)
   with an explicit `pendingBeforeSnapshot` list — it never claims
   `approved_for_snapshot`.

```
pnpm --filter @pickle/first-party-intake intake -- \
  --clip raw.mp4 \
  --consent-ledger ledger.json \
  --subject <subjectPseudonym> \
  --capture-meta capture-meta.json \
  --operator <operatorId> \
  --out intake-record.json \
  --signing-key <hmacKey> \
  --min-max-seq <n>
```

Exit codes: 0 accepted, 1 rejected, 2 invalid invocation/inputs. Every
flag takes exactly one value; an unrecognised or repeated flag exits 2 with
the usage line on stderr (a mistyped `--signing-key` must never silently run
unsigned).

Ledger verification options (forwarded to `loadConsentLedger`; also
available programmatically as `IntakeInput.consentSigningKey` /
`consentMinMaxSeq`):

- `--signing-key <hmacKey>` — the export contract v2 HMAC key. When set, the
  host accepts ONLY correctly signed v2 envelopes: a v1 envelope or a bare
  array is a signature downgrade and a wrong signature is tampering; both
  REJECT the clip (exit 1, reason in `reasons` / `consent.errors`). Without
  the key a v1 envelope is corruption-evident only — anyone who can edit the
  file can drop a withdrawal and recompute its hash — so a host that has
  been issued the key must always pass it.
- `--min-max-seq <n>` — the highest export `maxSeq` this host has already
  accepted for the subject. The ledger is append-only, so a genuine, signed
  export whose `maxSeq` is below `n` is a stale snapshot taken before later
  rows (e.g. a withdrawal) and is REJECTED as a replay. Record the accepted
  envelope's `maxSeq` per subject and pass it on every later intake for that
  subject.

A ledger that cannot be read or parsed at all (missing file, invalid JSON)
is an invocation problem and exits 2.

`capture-meta.json` shape (enums mirror the manifest schema `capture` def):

```json
{
  "clipId": "…",
  "athleteId": "…",
  "athleteGroupId": "…",
  "sessionId": "…",
  "recordedAt": "2026-08-15T10:00:00.000Z",
  "capture": {
    "cameraView": "rear",
    "environment": "outdoor",
    "lighting": "daylight",
    "deviceClass": "iPhone15,2",
    "handedness": "right",
    "skillBand": "intermediate",
    "ageBand": "adult_18_34",
    "adaptivePlay": false,
    "bystanderState": "none"
  }
}
```

Test fixtures are SYNTHETIC only: ffmpeg lavfi noise clips generated in
tmpdir and consent rows with `SYNTHETIC-TEST-FIXTURE` pseudonyms. No real
consent record exists anywhere in this repository, and nothing from
`test/` may be copied under `datasets/`.
