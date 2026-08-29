# @pickle/first-party-intake

CPU intake validator for consented first-party capture clips (D2-12). It is
the executable half of
[`datasets/pickleball/FIRST_PARTY_CAPTURE_PROTOCOL.md`](../../datasets/pickleball/FIRST_PARTY_CAPTURE_PROTOCOL.md).

Per clip it:

1. verifies the consent reference against an exported C10 consent ledger
   (JSON array of `ConsentRecord` rows from `@pickle/shared-types`): the
   subject pseudonym must have ACTIVE `video_analysis` AND `model_training`
   grants after folding the append-only ledger — a withdrawal rejects the
   clip;
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
  --out intake-record.json
```

Exit codes: 0 accepted, 1 rejected, 2 invalid invocation/inputs.

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
