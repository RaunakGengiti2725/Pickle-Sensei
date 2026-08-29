# DATA ENGINE — the permanent data factory

> Everything here is measured/implemented as of 2026-08-28. The engine's job:
> continuously acquire → validate → segment → mine → rank → review → release,
> at a scale the old per-video hand workflow could never reach, without ever
> laundering machine output into ground truth.

## Pipeline (implemented stages)

```
LEGAL SOURCE (DVIDS public domain · Wikimedia Commons license-filtered)
   ↓  lab:acquire       provenance + per-modality rights + SHA-256 + probe
SOURCE REGISTRY         datasets/corpus/sources.json
   ↓  lab:corpus-sessions   same venue+occasion ⇒ ONE session (split unit)
RECORDING REGISTRY      datasets/corpus/recordings.json (content-addressed ids)
   ↓  lab:factory --stage extract      pose+people+scenes (Swift, resumable, parallel)
   ↓  lab:factory --stage fingerprint  temporal dHash (64-bit @1fps)
   ↓  lab:factory --stage dedup        overlap detection → session merges → lineage
   ↓  lab:factory --stage mine         windowed Tier-C StrokeEvent candidates (JSONL shards)
   ↓  lab:failure-mine                 stress scan → ranked annotation queue
   ↓  lab:ta-bench propose|render|run  target-acquisition benchmark (live-UX replay)
   ↓  human review (lab:annotate, ta-bench render → verified states)
GOLD / TIER-C           (SILVER exists in schema; nothing has earned it yet)
   ↓  lab:dataset-release              immutable manifest, hashes, tiers, ladder
   ↓  lab:learning-curve               metric-vs-n with bootstrap intervals
```

## Hierarchy and IDs

SOURCE (`src-<origin>-<originId>`) → RECORDING (`rec-<sha256[:12]>`, content-addressed)
→ SESSION (`sessionKey`: one venue+occasion — THE split unit) → scene → window
→ player track → CANDIDATE EVENT (`evt-<rec>-s<scene>w<window>-p<track>-<peakMs>`).

Recordings carry `derivedFrom` lineage (`declared` at registration, `detected`
by phash overlap, or both). Derived recordings inherit the parent session, so
a subclip can never drift into a different split than its source pixels.

## Per-modality rights (never "it's online, so it's fine")

Every source records store / analyze / annotate / train / redistributeDerivatives /
commercial with a legal basis string (`engine/rights.ts`). Unknown licenses
quarantine every modality; `trainingEligible()` gates release accounting.
PD-USGov (DVIDS) and CC BY/CC0 derive full profiles; CC BY-SA marks
derivatives ShareAlike. Pexels/Pixabay/Coverr remain rejected (ToS forbids ML).

## Split ladder (4 layers, sacred shadow)

- Assignment is a **pure salted-hash of sessionKey** (dev 50 / val 20 /
  locked_test 15 / shadow 15) done at registration, before any human sees a
  frame. Previously inspected sessions are **pinned** with written reasons
  (`datasets/corpus/splits.json`); pins may tighten, never loosen.
- Factory NEVER mines locked_test (without `--include-protected`) or shadow;
  failure mining and TA proposals read dev/val only. Shadow currently holds
  40.1min across 2 sessions untouched.
- `val` is empty today (12 sessions is too few for every bucket to fill);
  it populates automatically as acquisition grows. Do not manually move an
  inspected session into val/locked_test/shadow — that is the forbidden
  direction.

## Dedup that actually caught things

`dedup` computes a temporal dHash sequence per recording and slides shorter
against longer. On this corpus it detected the three DVIDS re-uploads of
already-registered Commons content (hamming ≈0.5 over 60s) and auto-merged
their sessions — including the AFN VIC copy landing correctly in the
locked_test session. KNOWN LIMITATION (recorded in dedup-report.json):
temporal dHash does not catch SPATIAL crops; those rely on declared lineage
at registration (all six legacy crops are declared).

## Tiers

- **GOLD** — human-verified only (today: 40 paddle + 4 other-paddle + 22 ball
  frames, 9 event labels, 25 phase boundaries, 5 stroke labels, 7 verified TA
  cases; ALL single-annotator — second annotator remains the top gap).
- **SILVER** — verified teacher output. Count is 0. Nothing is silver-washed.
- **TIER-C** — machine candidates (199 mined stroke-event candidates, 281
  proposed TA cases). Never reported as labels; used for mining, ranking,
  stress aggregates.

## Scale posture (100K-events design)

Content-addressed ids; per-recording JSONL event shards; atomic writes;
per-stage `factory-state.json` with stage versions (bumping a stage version
invalidates exactly that stage); adoption of prior extraction artifacts;
parallel worker pool; failures recorded and skipped, resumable. sources.json/
recordings.json stay single-file until the thousands (a few MB) — shard then.

## Corpus today (computed by `lab:corpus-status`, never hand-maintained)

20 sources (16 DVIDS, 4 Commons) · 26 recordings (17 roots) · 62.9 min root
footage · 12 sessions · 199 Tier-C candidates (dev) · integrity OK.
Release: `datasets/releases/pickle-real-v0.2` (schemaVersion 2, immutable).

## Target-acquisition bench (the live UX, finally measured)

`lab:ta-bench` replays a faithful TS port of the shipped acquisition
(`engine/taReplay.ts`, port-semantics unit tests) against real multi-person
footage. First measurements (EXP-2026-08-28-target-acquisition-bench):
sticky ambiguity is a dead end (3/7 verified cases never lock), natural
motion causes false gesture locks (37/288 Tier-C), post-lock following is
the weakest stage (mean on-target 0.49–0.58). Candidate fixes (hysteresis,
3s ambiguity timeout, sustained gesture) dominate on the 288-case aggregate
(false gestures −76%, stable locks +53%) but are NOT confirmed on the 7
verified cases — decision recorded: verify ≥30 cases before porting to Swift
(EXP-2026-08-28-ta-candidate-variants).

## Honest limitations

1. Verified GOLD is single-annotator; agreement is unmeasurable.
2. Learning curves say both perception metrics are UNSTABLE at n=3 dev cases
   (leave-one-out recall swings 0.38–0.63) — no reliability claims allowed.
3. DVIDS "pickleball" search is exhausted (16 videos); next legitimate scale:
   more DVIDS queries (adaptive sports, base recreation), NARA/state PD
   sources, and above all FIRST-PARTY consented capture.
4. Deep prelabels (paddle/ball/contact) are not yet run corpus-wide; the
   Silver tier stays empty until teacher outputs pass verification.
5. Mining recall is kinematic-only (wrist speed); strokes with hidden wrists
   are invisible to the miner — paddle-based confirmation is future work.
