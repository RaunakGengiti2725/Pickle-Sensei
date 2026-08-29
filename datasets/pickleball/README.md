# Pickle Sensei dataset registry

This directory records real dataset provenance. It must never contain generated
labels presented as ground truth, unlicensed match footage, or records invented
to make a dataset look larger than it is.

## Finding as of 2026-08-27

No reviewed public source is a commercially cleared, downloadable temporal
pickleball stroke dataset suitable for automatic stroke recognition, phase and
contact detection, or form scoring. The commercial-training-ready source count
is **zero**.

That conclusion is narrower than “there is no pickleball data online.” There is
useful real pickleball data, but it does not satisfy the motion-model need:

- [PickleBall Detection](https://universe.roboflow.com/senior-lab-b5ptu/pickleball-detection-1oqlw-px8fm)
  has 338 object-detection images and four classes. Its page declares CC BY 4.0
  but publishes no source-media description. It is static and has no stroke or
  form labels.
- [Pickleball Pen Ball Tracking v3](https://universe.roboflow.com/dustins-workspace-huvdc/pickleball-pen-ball-tracking/dataset/3)
  reports 10,921 source images and 78,592 generated v3 images. The latter count
  includes tiling and augmentation, so it is not 78,592 independent scenes. It
  labels only the ball, and its source-media provenance is undocumented.
- [ActionAtlas v1.0](https://huggingface.co/datasets/mrsalehi/ActionAtlas-v1.0)
  contains 934 metadata rows overall. An exact query of its official dataset
  API returned only two pickleball rows; both are two-second “Punch volley”
  segments and both have null source-license metadata. Its
  [official repository](https://github.com/mrsalehi/action-atlas) tells users to
  download the referenced videos from YouTube rather than distributing cleared
  media.
- The [University of Rochester project](https://www.hajim.rochester.edu/senior-design-day/pickleball-analytics/)
  describes 12,000 frames labeled with ball visibility and coordinates, but it
  publishes no dataset download, media license, or stroke labels.
- The [TrackNet-Pickleball repository](https://github.com/shivam-d11/Ball-Tracking-PickleBall)
  publishes code and weights under Apache-2.0 while explicitly excluding video,
  label CSVs, and training arrays. A code license does not clear the source
  footage.
- [pklmart](https://www.kaggle.com/datasets/cakesofspan/pklmarts-competitive-pickleball-extracts)
  reports over 300,000 real shot and rally outcomes, but they are tabular and
  licensed CC BY-NC-SA 4.0, whose noncommercial term blocks this commercial use.
- The [women's singles notational dataset](https://figshare.com/articles/dataset/Technical_and_Tactical_Performance_in_Women_s_Singles_Pickleball_A_Notational_Analysis_of_Key_Match_Indicators_data_files_for_SPSS_and_Theme_/28124738)
  covers 15 matches under CC BY 4.0, but releases analysis files rather than
  video, poses, or stroke boundaries.
- A [Scientific Reports paper](https://www.nature.com/articles/s41598-025-33985-6)
  names a “Pickleball Dataset,” but reports no item count, taxonomy, provenance,
  or usable dataset link. Its data-availability links resolve to publications,
  not a pickleball media artifact.

The exact counts, license claims, clearance status, and limitations are in
`registry.json`. Every registered source remains
`registered_not_downloaded`. A platform license label is recorded as a claim,
not treated as proof that an uploader owned every underlying image.

## Consent-first collection contract

`collection_manifest.schema.json` is the required manifest for first-party
temporal footage. It intentionally has no example rows: examples with plausible
people or clips are too easy to mistake for collected data.

A clip may enter a training snapshot only when all of the following are true:

1. The athlete (and guardian for a minor) signed the referenced release version,
   including commercial model training, product evaluation, and derived-feature
   use. Withdrawal and purge instructions remain linked to the pseudonymous
   athlete ID.
2. Pickle Sensei or its contracted recorder owns the capture, and the rights
   review confirms that it contains no third-party broadcast, scraped video,
   uncleared bystander, music, or other embedded media.
3. The raw asset has a SHA-256 digest and immutable capture metadata. Every
   derivative and annotation set links back to that digest.
4. Labels use the versioned canonical pickleball taxonomy and include stroke
   start, contact neighborhood, stroke end, phase boundaries, handedness,
   camera view, observability, and quality flags. `unknown`, `no_stroke`, and
   partial/aborted motions must remain valid outcomes so annotators are never
   forced to invent a technique.
5. Two independent trained annotators review the clip, and a qualified coach
   adjudicates disagreements. Model-generated suggestions stay separate from
   human ground truth and record their model/version.
6. The split is assigned by athlete group, not by clip. No athlete, session,
   burst, or derivative of one raw recording may cross train, validation, test,
   or locked holdout boundaries.
7. A revoked consent or rights grant triggers deletion from raw media,
   derivatives, feature stores, manifests, future snapshots, and retraining
   queues. Previously released model lineage must retain a tombstone that does
   not contain the withdrawn media.

## Coverage and release gates

Collection must cover every canonical technique plus realistic negatives, with
diversity across athlete identity, handedness, skill band, age band, body
presentation, adaptive play, indoor/outdoor court, lighting, clothing, paddle,
ball color, phone model, frame rate, camera view, distance, occlusion, and
background activity. Augmentations never count as new athletes or independent
captures.

Before any technique becomes scoreable, the locked athlete holdout must show:

- per-technique precision and recall, not only aggregate accuracy;
- calibrated confidence and an evaluated abstention threshold;
- contact and phase timing error;
- performance by capture condition and represented athlete subgroup;
- coach agreement for each checkpoint used in scoring;
- a signed model manifest linking the exact data snapshot, taxonomy, code,
  weights, metrics, and approved scoring configuration.

Until those gates pass, the honest product state is unavailable or
insufficient-confidence—not a fabricated score.
