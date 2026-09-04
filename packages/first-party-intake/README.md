# @pickle/first-party-intake

CPU intake validator for consented first-party capture clips (D2-12). It is
the executable half of
[`datasets/pickleball/FIRST_PARTY_CAPTURE_PROTOCOL.md`](../../datasets/pickleball/FIRST_PARTY_CAPTURE_PROTOCOL.md).

Per clip it:

1. verifies the consent reference against an exported C10 consent ledger
   (a `consent-ledger-export` envelope, or a bare JSON array of
   `ConsentRecord` rows from `@pickle/shared-types`): the subject pseudonym
   must have ACTIVE `video_analysis` AND `model_training` grants after
   folding the append-only ledger — a withdrawal rejects the clip. When a
   signing key is configured the export itself must be a correctly
   HMAC-signed v2 envelope, and when a watermark is configured it must not
   be behind the last export this host accepted (see
   [Ledger integrity](#ledger-integrity));
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
  --signing-key-file consent-export.key \
  --min-max-seq <maxSeq of the previous accepted export>
```

Exit codes: 0 accepted, 1 rejected (consent not established — including a
ledger that fails signature or watermark verification — or `UNSUPPORTED`
envelope), 2 invalid invocation/inputs. Every flag must be one of the
documented ones; an unknown or misspelled flag (`--signing-kye`) exits 2
with the usage text on stderr instead of being silently ignored.
`intake --help` prints the usage.

## Ledger integrity

A ledger file is only as trustworthy as its transport. Without the options
below the intake trusts whatever rows the file contains, so an export with
the withdrawal row stripped and `recordsSha256` recomputed is ACCEPTED —
that is the documented limitation of consent export contract v1.

| Option (`IntakeInput` / CLI)                                           | Effect                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `consentSigningKey` / `--signing-key <key>` / `--signing-key-file <p>` | HMAC-SHA256 key of consent export contract v2. Only a correctly signed v2 envelope is trusted: an unsigned v1 envelope or a bare record array is a _signature downgrade_, a wrong signature is a forgery, and either REJECTS the clip. Prefer the file form — argv is visible to other processes and shell history. |
| `consentMinMaxSeq` / `--min-max-seq <n>`                               | Ledger watermark: the highest `maxSeq` this host already accepted for the subject (read it back from the previous record's `consentLedger.maxSeq`). A signed export whose `maxSeq` is behind it is a _stale export replay_ (it may predate a withdrawal) and REJECTS the clip. Must be a non-negative integer.      |

Both options are forwarded verbatim to `loadConsentLedger`, so the operator
path enforces exactly the same checks as the library (`test/consentExport.redteam.test.ts`
pins the checks, `test/adjudication.intakeSigning.test.ts` pins that they are
reachable from `intakeClip` and the CLI). A ledger that fails verification
does not crash the intake: the record is written with `status: "REJECTED"`
and a `consent ledger could not be verified: …` reason so the refused
export leaves an auditable trail. The key itself is never written anywhere
— not to the record, the manifest draft, stdout or stderr.

Every record carries `consentLedger` evidence:

```json
"consentLedger": { "signatureVerified": true, "maxSeq": 3, "watermark": 2 }
```

`signatureVerified` is true only when a key was configured AND the v2
signature verified; `maxSeq` is the highest `seq` in the trusted export
(feed it into the next run's `--min-max-seq`); `watermark` echoes the
configured floor. The manifest draft's `consentReference` repeats the first
two as `exportSignatureVerified` / `ledgerMaxSeq`.

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
