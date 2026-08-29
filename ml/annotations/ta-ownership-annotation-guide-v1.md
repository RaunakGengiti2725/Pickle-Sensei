# TA + paddle-ownership annotation guide — v1

Version: 1 (2026-08-29). Written for workstream C06 to close the definitional
gaps behind the W14 TA κ0.44 result (`datasets/experiments/wave-b/W14-overlap/`).
This guide changes only by re-versioning (v2, v3, …), never by editing in place.

## 1. Target-acquisition (TA) — operational definition

A TA case is **verified (correct-lock)** iff the lime track follows the person
who occupies the user's start region — *regardless of whether that person is a
gameplay participant*. The bench question is "did we lock the person the user
aimed the region at?", not "did we lock a valid player?".

Taxonomy (3-class): `correct-lock`, `wrong-lock`, `reject` (unusable scene).

## 2. `bystander_target` (REQUIRED situation tag)

When the start-region occupant is a **non-player** (spectator, staff,
referee, camera operator), the case is still `correct-lock` if the track
follows that occupant, but it MUST carry `situationTag: "bystander_target"`.

Rationale: these are legitimate adversarial cases for the tracker, but they are
not the product's intended flow (a user films *their own play*). Untagged, they
silently inflate lock-accuracy on the product metric. All metric reports MUST
be sliceable by this tag; headline lock-accuracy excludes `bystander_target`
cases, with the tagged slice reported alongside.

Corpus examples (both W14 TA disagreements — adjudicated in
`datasets/experiments/wave-c/C06-adjudications.json`):

- `ta-44c0c451500c-s1w0-p6` — region ~(0.155, 0.326) lands on a black-shirt
  staff member filming on a phone behind the barrier; the ARMY player and the
  wheelchair athlete are outside the region. Occupant tracked ⇒ `correct-lock`
  + `bystander_target`.
- `ta-960a1a200d6d-s8w0-p1` — region ~(0.120, 0.302) lands on a barrier-lean
  spectator (tan cap, white shirt) while the AIR FORCE wheelchair athlete plays
  center court. Occupant tracked ⇒ `correct-lock` + `bystander_target`.

## 3. TA verdict precedence + crowd-region scrub

Deterministic precedence when several verdicts could apply:

1. `reject` (scene unusable: not pickleball, cut/b-roll, region empty)
2. `wrong-lock` (track leaves the region occupant)
3. `correct-lock` (tag `bystander_target` when §2 applies)

For crowd-heavy regions where the candidate only clips the region edge
(`ta-faead33a362c-s3w5-p2` pattern), a single mid-frame render is insufficient:
scrub **start / mid / end** frames of the window before verifying.

## 4. Ownership — motion-blur center-offset rule

For a motion-blurred paddle, accept a box as covering the paddle when the box
center lies within **0.05 normalized units** (per frame width) of the center of
the *visible blur mass*. Beyond 0.05, downgrade to `ambiguous` (localization,
not ownership, is then the failure).

Example: `afn-sasebo-rally2 @2204 box2` — box center ~x1388 vs blur core
~x1310 (1920 wide) ⇒ offset ~0.04 ⇒ accept as `target` (ADJ-C06-3).

## 5. Ownership — evidence standard for `other`, and adjacent-frame scrub

Single-frame ownership review is NOT safe. Review every box with **±1–2
adjacent frames** (or a 3-frame strip from the propose tool).

- `other` (another player's paddle) requires **resolvable hand/arm continuity**
  to that player in at least one adjacent frame. A paddle-like blur with no
  attachable owner stays `ambiguous` (kept out of P/R denominators).
  Example: `afn-sasebo-rally2 @2604 box1` (ADJ-C06-4).
- Union boxes spanning two paddles are always `reject` (geometry, not
  ownership).

## 6. Static-object ledger

Named repeat traps that mimic paddles in single frames: **floor paddles,
net-tape logo patches, banner graphics/feather flags, equipment-bag piles**.
Any object pixel-static across ≥1 s while play continues is a static object ⇒
`reject`, never `target`/`other`. Keep a per-video ledger of confirmed static
objects (first/last seen ms) so later frames inherit the verdict.
Example: `afn-sasebo-rally2 @3372 box1` — floor paddle static 1303→3505 ms
(ADJ-C06-5; the one genuine perception miss in W14 came from skipping this).

## 7. Confidence

Record annotator confidence (0–1) per verdict. Low-confidence agreements
(0.5–0.6) are the priority pool for the next overlap round.
