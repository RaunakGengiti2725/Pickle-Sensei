# Model manifests

Lineage manifests for model artifacts. The in-app default manifest lives in
`@pickle/model-registry` (`defaultManifest.ts`) and lists only providers that
actually ship in the build. Downloadable/remote model releases add a manifest
here with, at minimum:

- provider id, semantic version, task, runtime, execution target
- artifact URI + SHA-256 (mandatory for any downloadable artifact)
- training dataset snapshot id and evaluation dataset version
- evaluation report hash and coach-validation reference (release gate)
- deployment status (`experimental | shadow | candidate | production | deprecated`)

A trained model without a complete manifest cannot be released; the server
enforces the same evidence in `scoring_model` (`0013_scoring_release_evidence`).
No manifest is created here until a real artifact exists.
