# Research behind the Pickle Sensei Astra prompt

Revision note, 2026-09-05: the original research below remains a dated record. Its incremental/optional comparison recommendation is superseded by the user's canonical 3D replacement direction and the revised [Astra master plan](astra-app-improvement.md). The new research and audit addendum follows the original notes; neither section is evidence that 3D has been implemented or released.

Prepared 2026-09-04, America/Los_Angeles. Repository inspected at `c23b266`. This was research and a bounded read-only architecture inspection, not a security certification or completed application audit. Only the prompt and these notes were created; app code, production services, and configuration were not changed.

## Model and prompting findings

Official documentation identifies GPT-6 Astra as a model for complex reasoning, coding, research, and end-to-end work. The API model identifier is `gpt-6-astra`; documented reasoning levels include `max`. Select the highest effort actually available in the intended interface for this demanding experiment. This is a setup recommendation, not a guarantee of better results on every task; writing “use 100%” in a prompt does not select an effort level. The model page does not establish an AGI guarantee. [OpenAI model documentation](https://developers.openai.com/api/docs/models/gpt-6-astra).

OpenAI's Astra guidance calls out autonomy, sensitivity to instruction files, explicit delegation, and proportionate verification as useful prompting controls. The prompt adapts these to Pickle Sensei's authority boundaries and product contracts. [Astra prompting guidance](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices).

The proposed method is to give Astra a measurable engineering contract: establish current behavior, reproduce failures, make focused repairs, verify them independently, and retain evidence. This is a synthesized workflow recommendation, not a published benchmark showing this exact prompt is optimal. Task-specific evaluation and human judgment are more useful than impressions of impressive output. [OpenAI evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices).

Cyber capability and testing scope remain separate. OpenAI documents controlled environments, explicit authorized targets, and permission boundaries for advanced defensive work. This prompt targets the user's local project and disposable test systems; it does not assume access to separately provisioned specialist models or security products. [OpenAI cyber guidance](https://learn.chatgpt.com/docs/cyber-safety).

## Why the security scope is specific

The security requirements combine the actual Supabase/mobile architecture with authorization, resource-abuse, and upstream-trust categories from the [OWASP API Security Top 10](https://owasp.org/API-Security/editions/2023/en/0x11-t10/). Storage, cryptography, authentication, networking, platform interaction, tamper resistance, and privacy coverage comes from [OWASP MASVS](https://mas.owasp.org/MASVS/).

Direct database access deserves its own tests: protecting an Edge route does not demonstrate that exposed tables, views, or RPCs enforce the same boundary. Supabase describes policies, privileges, view behavior, and privileged access in its [row-level security guidance](https://supabase.com/docs/guides/database/postgres/row-level-security).

The local inspection identified audit targets, not proven exploitable vulnerabilities:

- Production code lives in `supabase/functions/api`, while some security documentation still describes legacy Fastify/AWS behavior.
- Durable refresh sessions, the verified-auth cache, and the transitional provider-token path warrant end-to-end revocation and compatibility testing.
- The SQL security suite notes its single-session limit for true concurrency. Permit and identity-ledger races need independent connections when investigated.
- Some Edge tests mirror historical dispatcher code or historical defect reproductions. Their existence does not prove current production behavior is protected.
- Existing CI checks should be reconciled with Edge execution coverage, dependency checks, secrets, native code, and real deployment settings.

Primary local references: [AGENTS.md](/Users/raunakgengiti/Pickle-Sensei/AGENTS.md), [security regression matrix](/Users/raunakgengiti/Pickle-Sensei/supabase/tests/security_regression.sql), [current CI](/Users/raunakgengiti/Pickle-Sensei/.github/workflows/ci.yml), and [historical security report](/Users/raunakgengiti/Pickle-Sensei/docs/SECURITY_CERTIFICATION_2026-08-30.md).

## Form-analysis research and recommendation

The shipping provider composition already includes geometry-based biomechanics and technique scoring. Several older documents still say shipping captures cannot score. The prompt requires reconciling these claims with runtime and validation evidence; it does not infer scientific validity from functioning code. [Provider composition](/Users/raunakgengiti/Pickle-Sensei/apps/mobile/src/vision/providers.ts:150), [older scoring document](/Users/raunakgengiti/Pickle-Sensei/docs/SCORING.md:3).

Current features use body-relative 2D landmarks and wrist proxies for paddle-related measurements. Their confidence incorporates joint visibility and fixed method factors. That calculation alone does not demonstrate calibrated probability or validate physical interpretations such as true paddle orientation. [Feature extractor](/Users/raunakgengiti/Pickle-Sensei/packages/vision-geometry/src/featureExtractor.ts:33).

The research suggests three directions to compare:

| Candidate                                                                  | What makes it worth investigating                                               | Evidence needed before shipping                                                                                           |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Same-player, comparable-view swing comparison using existing pose sidecars | Fits current Practice Set and Form Review; can expose specific observed changes | Repeatability, view rejection, phase accuracy, false improvement rate, and coach agreement                                |
| Native estimated 3D pose                                                   | Could offer an additional geometric representation on compatible devices        | Athlete selection, depth/scale assumptions, pickleball accuracy, device cost, and comparison with current 2D measurements |
| Learned monocular 3D plus biomechanical constraints                        | Broader movement research shows feasibility                                     | Sports-specific reference data, licensing, compute/privacy tradeoffs, and substantial validation                          |

Apple provides a native 3D body-pose API. Its availability is a reason to evaluate it, not proof of accurate pickleball biomechanics. [Apple Vision documentation](https://developer.apple.com/documentation/vision/identifying-3d-human-body-poses-in-images).

The March 2026 OpenCap Monocular preprint combines monocular pose, optimization, a constrained skeletal model, and dynamics estimation. Its reported validation covers walking, squatting, and sit-to-stand. These results cannot be transferred directly to fast pickleball swings. [Original OpenCap Monocular paper](https://arxiv.org/abs/2603.24733).

The AthleticsPose preprint reports that authentic athletic data matters and that camera view, subject scale, and high-speed motion affect reliability. This supports testing on real, varied pickleball recordings instead of relying on synthetic scoring checks. It does not validate the proposed Pickle Sensei feature. [Original AthleticsPose paper](https://arxiv.org/abs/2507.12905).

My recommended first experiment is **“What reliably changed in this set?”** Compare visible wrist motion, defensible timing events, and selected joint geometry between comparable attempts. Preserve original timing alongside phase alignment. Say when views cannot be compared or no reliable change is detected. An observed difference is not automatically improvement; a coach-supported interpretation needs separate evidence.

This is an incremental product hypothesis, not a claim of invention. It builds on [practice-set comparisons](/Users/raunakgengiti/Pickle-Sensei/apps/mobile/src/progress/practiceSetProgress.ts) and [existing replay evidence](/Users/raunakgengiti/Pickle-Sensei/apps/mobile/src/review/formReviewModel.ts). Success should be judged on held-out players and sessions, with coach-adjudicated labels and false improvement rates, before any production promotion.

## How to use the deliverable

Open the Pickle Sensei project in an agent that can inspect and edit the repository, select GPT-6 Astra and the highest available reasoning effort, and paste the contents of [the full prompt](/Users/raunakgengiti/Pickle-Sensei/docs/prompts/astra-app-improvement.md). Alternatively, ask the agent to read that file and execute its instructions. These notes provide starting evidence; the executing agent should verify changing facts and current repository state.

Judge the run by reproduced and repaired failures, preserved contracts, measured outcomes, reviewable changes, and honestly identified unknowns. No prompt can ensure that every vulnerability or form-analysis error has been found.

## 2026-09-05 addendum: canonical 3D replacement

### Product decision and audit scope

The intended product replaces primary 2D analysis with validated 3D reconstruction, supported comparison/coaching, and a modelled correction of the athlete's own body. The existing 2D path is a temporary shipping baseline and a justified fallback/archive reader, not a permanent competing mode. Prototype isolation remains a safety measure before release, not the final architecture.

The audit used `/Users/raunakgengiti/Pickle-Sensei-astra-20260904` at `0205ea7`. Four bounded read-only workstreams traced native acquisition, geometry/coaching, routes/history, and evidence/device gates. Their code findings informed the plan; their agreement is not scientific validation. No estimator weights, body models or private videos were uploaded or downloaded for this revision. No runtime routing or production configuration changed.

### Findings that change the implementation standard

- **VERIFIED (code):** native iOS capture/import writes 2D landmarks. `observations.ts` and the parser allow optional depth, but `toLegacyPoseFrames` discards it and the shipping geometry remains image-plane. There is no native 3D producer or 3D model-task entry. Add explicit roles, time/coordinate/scale provenance and per-joint uncertainty rather than treating `z?` as a complete contract.
- **VERIFIED (code mismatch):** phase segmentation uses aspect 1 while biomechanics uses video aspect; phase, feature and UI handedness rules differ; camera view is hardcoded. Reproduce their effects and replace the assumptions under version discipline, without silently changing old scores.
- **PARTIAL:** `Experimental3DComparison` validates and projects supplied XYZ, with caller-supplied alignment/review metadata. It does not reconstruct, fit an individual body, qualify a reference or generate corrected motion. The offline comparison evaluates 2D geometry and records zero real/coach-reviewed pairs.
- **BLOCKED:** `datasets/coach-review/coaches.json` has no provisioned coaches. Existing gate evaluator code does not compute all S/F/D verdicts; exposed holdouts and frozen gate references need a versioned reconciliation. No eligible independent 3D truth or physical-iPhone 3D trials were identified. Public/agent-labelled recordings cannot substitute for the required participant, training and coach evidence.
- **VERIFIED (integration gaps):** shipping Supabase keeps eight version-vector fields, not the proposed 3D lineage; legacy model-release APIs are not the production acceptance policy. New artifact types also need cleanup/export inventory, strict readers, authoritative release enforcement and one-run/one-rating behavior. A feature flag alone cannot complete the migration.

No new reconstruction accuracy, coaching-quality or physical-iPhone performance measurement was made in this planning pass. Prior Mac/Linux timings and simulator layout measurements retain those labels; they do not become 3D gate evidence.

### Primary-source comparison and limits

| Source                                                                                                                                                | Supported research observation                                                                                                                                                          | What remains unproven for Pickle Sensei                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Apple Vision 3D, WWDC23](https://developer.apple.com/videos/play/wwdc2023/111241/)                                                                   | Native image-based 17-joint reconstruction; the presented revision selects the most prominent person. Height may be a reference 1.8 m value rather than measured from sufficient depth. | Pickleball identity, fast motion, missing-foot/hand detail, scale, temporal stability and device cost. Check actual SDK revision and the effective app minimum OS. |
| [MediaPipe Pose Landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/python)                                     | Separate image and estimated hip-centred world landmarks.                                                                                                                               | Calibrated world/court motion, sport-specific confidence, viewpoint invariance and reliable occlusion recovery.                                                    |
| [MotionBERT](https://github.com/Walter0807/MotionBERT) and [data protocol](https://github.com/Walter0807/MotionBERT/blob/main/docs/pose3d.md)         | Temporal pose-representation candidate with Apache-2.0 code and a published H36M evaluation workflow.                                                                                   | Weight/data licensing, sparse-joint adaptation, mobile execution and pickleball generalization; benchmark numbers cannot serve as app measurements.                |
| [WHAM](https://github.com/yohanshin/WHAM), [MIT code license](https://github.com/yohanshin/WHAM/blob/main/LICENSE)                                    | Camera/global trajectory and temporal reconstruction methods to compare.                                                                                                                | Body-model/weight/dependency rights, correct floor/contact assumptions and affordable on-device performance.                                                       |
| [GVHMR](https://zju3dv.github.io/gvhmr/), [license](https://github.com/zju3dv/GVHMR/blob/main/LICENSE)                                                | Gravity-view coordinates and world-grounded reconstruction research.                                                                                                                    | Commercial permission and all product-specific validity. The license restricts commercial use; do not assume that an internal product prototype is exempt.         |
| [SMPL](https://smpl.is.tue.mpg.de/) and [SMPL-X license](https://github.com/vchoutas/smplx/blob/main/LICENSE)                                         | Parametric body models exist, with separate licensing requirements.                                                                                                                     | Permission for this commercial product/R&D and the validity of individual geometry; a wrapper's license does not cover all assets.                                 |
| [One Euro filter](https://gery.casiez.net/1euro/)                                                                                                     | A speed-adaptive jitter/lag tradeoff worth comparing with unfiltered and constrained temporal baselines.                                                                                | Accuracy improvement, preserved peaks/phase timing and uncertainty under pickleball motion. Smoothing is not evidence recovery.                                    |
| [RealityKit guidance, WWDC25](https://developer.apple.com/videos/play/wwdc2025/288/), [RN Filament](https://margelo.github.io/react-native-filament/) | Candidate native GPU render paths; Apple states SceneKit is soft-deprecated and not recommended for new substantial work.                                                               | RN 0.87 integration, lifecycle stability, device frame times and actual memory/battery cost. No renderer has been selected by benchmark here.                      |
| [OpenCap Monocular](https://arxiv.org/abs/2603.24733)                                                                                                 | The preprint reports constrained reconstruction validation for walking, squatting and sit-to-stand.                                                                                     | Transfer to fast pickleball, mobile/privacy feasibility and any force/injury claim. Its reported results are not a pickleball acceptance threshold.                |

### Decisions not to inherit from the scaffolds

Do not keep the old scoring targets/weights unchanged merely because provider interfaces can be reused. New 3D metric semantics and confidence need new versions and calibration. Do not reuse the 2D 120 ms matching tolerance, 0.65 confidence heuristic or 1.5 bone-ratio guard as a 3D acceptance criterion. Do not score a reference during a player's run just to manufacture eligibility, or validate a correction because the same heuristic score rises.

Keep one analysis/evidence graph and one presentation resolver. Match qualified exemplars first, eligible earlier own-best second, otherwise none. Generated corrections need an approved modification mask, documented kinematic dependencies, unchanged individual geometry, independent feasibility review and explicit exclusion from observed-data, score, rank and ground-truth paths.

The master plan separates frozen existing limits from proposed additional 3D study targets. Proposed numerical targets still require pre-registration, independent truth, powered sampling and qualified approval; unknown thresholds and unwired evaluators block release. Existing coach-gate holdout exclusions remain in force; a new final generalization protocol must use fresh registered evidence rather than silently repurposing retired holdouts.

### Tool and delivery boundaries

A read-only search of the existing Figma design file hit the Starter-plan MCP quota. Figma synchronization is blocked in this session; code tokens and local/native design evaluation remain available. Generic skill-generated e-commerce/style recommendations were not adopted over the app's established identity. Figma or an attractive render cannot validate biomechanics.

The master plan now requires explicit cutover, rollback and legacy retirement. Plan updates and scaffold tests do not authorize production rollout. Preserve the existing scoring/entitlement/account/privacy contracts, and keep every unsupported grade blocked until its own evidence exists.

### Independent review amendments

- The latest form-weighted SQL view (`20260831130000_form_weighted_rank.sql`) still partitions by user/technique rather than scoring definition; `computePlayerRank` has no version input. The plan now blocks 3D writers until SQL/shared/Edge rank and all best/comparison surfaces use an approved version partition. Arithmetic stays consistent within a partition; no 2D/3D score blend or automatic equivalence is assumed.
- A selected 3D-eligible run cannot obtain a legacy score after failure. All gate groups, including scoring-grade, are required for canonical cutover; partials are per-run abstentions of released capabilities. Necessary older-device/Android cohorts and authorized rollback for new runs need explicit policy scope, not a competing primary chooser.
- Account ownership does not identify the athlete. Own-best now requires a new explicit same-athlete evidence binding and qualified actual-3D score/review eligibility; legacy 2D scores do not rank or qualify references. The new locked 3D cohort comes from G0-authorized capture, not the YouTube successors of the 2D holdout ledger.
- The v1 coach policy does not establish the required expertise scope, exemplar suitability and reference-rights attestations. A versioned v2 policy/validator and real assessment records are required before these reviews count. No frozen v1 policy or coach identity was changed.
- Recruiting floors are not minimum evaluable sample sizes. For example, a two-sided exact 95% upper error bound below 2%, with zero observed errors, needs at least 183 independent trials; 20 only yield about 16.8%. A two-sided lower precision bound of 90% needs at least 36 all-correct independent predictions. Correlation, nonzero errors and multiplicity require a suitable larger design, not those arithmetic minima.
- WHAM's README acknowledges VIBE/TCMR-derived implementation. Its MIT notice alone cannot establish clearance for that chain, weights, datasets and body assets; it remains a literature comparator until the intended-use license review clears it. WHAM-based OpenCap research does not resolve that question.
- The plan names privacy/support/App Store disclosure work, stored onboarding-goal mapping, platform/OS and re-analysis accounting decisions, and the separation of source correspondence from display-refresh synchronization. Its analysis DAG produces the approved actual score/abstention and atomic outcome before presentation, never a score from the modelled view.

### Checks executed for this revision

**VERIFIED (software baseline only, `0205ea7` on macOS):** `npx jest --silent --runInBand __tests__/experimental3DComparison.test.tsx __tests__/formReviewScreen.test.tsx __tests__/resultGuide.test.tsx` passed 101 tests in three suites. `pnpm --filter @pickle/swing-lab exec vitest run test/formComparison.test.ts` passed 107 tests. These test supplied geometry, control/evidence contracts and the legacy comparison scaffold, not real reconstruction or coaching accuracy.

The independent plan review's 13 findings were addressed and rechecked; the correction branch now must complete or explicitly abstain within the same result budget without discarding a valid actual result. Formatting and invisible-Unicode inspection of the changed prose passed. This revision changed the master plan, research notes and the two existing project-notes files only; it did not change runtime analysis/routing or release a gate. Separate concurrent Supabase edits in the main checkout were left untouched.
