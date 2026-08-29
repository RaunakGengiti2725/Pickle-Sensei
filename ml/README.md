# ML workspace

This directory contains contracts and evaluation scaffolding for future learned
pickleball motion models. It does **not** contain a commercially cleared
temporal training dataset, a validated stroke classifier, or a production form
scorer today.

The source of truth for dataset provenance and collection eligibility is
[`datasets/pickleball/`](../datasets/pickleball/README.md). Its reviewed
commercial-training-ready temporal source count is zero. No clip, athlete, or
class count should be inferred from this directory structure.

```
annotations/   annotation.schema.json — canonical technique + negative-label ontology
datasets/      manifest.schema.json — eligible-source, consent, rights, and split contract
scripts/       annotation validator and unit tests
evaluation/    release-gate and regression harnesses (populated only by real evaluations)
golden/        future immutable, athlete-disjoint human-reviewed holdouts
pose/ paddle/ ball/ stroke-detection/ phase-segmentation/ biomechanics/ scoring/
               subsystem research and export code as cleared data and validated models exist
training/ export/ experiments/
```

## Canonical labels

`packages/shared-types/src/pickleballTaxonomy.ts` is the product-wide source of
truth. It defines 61 techniques across serve, return, groundstroke, drop/reset,
dink, volley, attack/counter, overhead/lob, and specialty families. Side, spin,
direction, court zones, contact state, intent, and rally outcome remain
orthogonal attributes; they are not additional technique classes.

Annotation outcomes also include `unknown_technique`, `no_stroke`, `partial`,
and `aborted`. These are first-class labels, not errors. Annotators must abstain
when a technique or phase is not observable instead of guessing a class to make
coverage appear complete.

Any taxonomy change requires a version bump plus synchronized changes to the
shared TypeScript taxonomy, annotation schema, validator, tests, dataset
manifest, and model manifests.

## Eligible data only

Training and evaluation manifests may reference only real footage captured or
licensed through one of these reviewed paths:

- consented first-party capture;
- a commissioned capture with participant releases; or
- licensed media with an explicit commercial model-training grant and
  participant/publicity clearance.

Every item must carry a raw-media SHA-256 digest, pseudonymous athlete and
athlete-group identifiers, active participant/guardian consent where
applicable, explicit commercial-training and derived-feature scopes, a
withdrawal process, verified capture/media rights, bystander and third-party
media clearance, human review, and an athlete-group split. Scraped broadcasts,
platform URLs without underlying-media rights, noncommercial licenses,
generated clips, augmentations presented as independent captures, and
unreleased media are ineligible.

Withdrawal must purge raw media, derivatives, features, annotations, manifests,
and future training queues while retaining only a non-media lineage tombstone.

## Evaluation and release gates

Future golden sets must contain real, consented or fully licensed clips with
human-reviewed ground truth and athlete-disjoint train, validation, test, and
locked-holdout partitions. Candidate outputs and reports stay separate from
ground truth; there is no “expected production output” until a model has passed
release review.

A technique cannot produce a user-facing class or score until its locked
athlete holdout establishes, at minimum:

- per-technique precision and recall plus calibrated abstention behavior;
- false-positive rates on `unknown_technique`, `no_stroke`, `partial`, and
  `aborted` clips;
- contact and phase timing error where those events are observable;
- performance by capture condition and represented athlete subgroup;
- qualified-coach agreement for every checkpoint used by scoring; and
- a signed lineage manifest linking the exact dataset snapshot, taxonomy,
  training code, weights, evaluation report, and approved scoring config.

Aggregate gains cannot hide subgroup regressions. Augmented derivatives never
count as new athletes or independent captures.

## Current native capability boundary

Apple Vision and MediaPipe provide on-device body landmarks for the live camera
overlay. The current temporal motion heuristic can help trigger capture from
observed wrist motion; it is not a validated technique classifier, contact
detector, biomechanics model, or production scoring system. It must not emit a
stroke name, form score, or MPH reading on that basis.

Model bundles may enter the product registry only after the data, evaluation,
rights, and review gates above pass. Until then, the truthful product state is
`unknown`, `awaiting_model`, `insufficient_confidence`, or unavailable—not a
fabricated result.
