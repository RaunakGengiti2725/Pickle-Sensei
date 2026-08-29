# Coach Qualification Policy

**Version: `coach-qualification-policy-v1`** (pinned in code as
`COACH_QUALIFICATION_POLICY_VERSION`, `packages/swing-lab/src/coachProvisioning.ts`).
Any change to this policy's criteria or verification standards MUST bump the
version string and add the new version to `KNOWN_QUALIFICATION_POLICY_VERSIONS`;
existing registry entries keep the version they were assessed under.

Purpose: production coach reviews are the ONLY thing that can unlock technique
scoring / fault diagnosis / drill recommendations out of BLOCKED_ON_VALIDATION
(docs/CLAIM_REVIEW.md gate H). Therefore **no anonymous expert Gold**: every
production review must come from a coach provisioned under this policy, with a
recorded, admin-assessed qualification and an append-only audit trail of who
provisioned whom and when.

## 1. Qualification criteria (v1)

A coach is **qualified** when at least ONE criterion below is satisfied with
_verified_ evidence (see §2 for what counts as verified):

| Criterion id                                     | Requirement                                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `criterion.certification`                        | Holds a recognized pickleball coaching certification (e.g. PPR, IPTPA, USA Pickleball), verified with the issuer or via the certificate document. |
| `criterion.professional-coaching-history`        | Documented professional (paid) pickleball coaching history of at least two years, verified with an employer, facility, or client records.         |
| `criterion.competitive-background-plus-teaching` | High-level sanctioned competitive background (pro tour, top-rated sanctioned tournament play) PLUS documented teaching experience, both verified. |

The satisfied criteria are recorded in the registry entry
(`qualification.satisfiedCriteria`) together with the verdict, the assessing
admin's identity, and the assessment timestamp. Only verdict-`qualified`
coaches may be provisioned; there is no "provisional" or "pending" reviewer
status.

## 2. Verification standards

Each evidence record carries a `verification.method`:

- `issuer_confirmed` — the certifying body confirmed the credential.
- `document_reviewed` — an admin reviewed the original document.
- `employer_confirmed` — an employer/facility confirmed the history.
- `public_record` — verifiable public record (e.g. sanctioned tournament results).
- `unverified_disclosed` — the coach disclosed it, but it was NOT verified.

`unverified_disclosed` information is recorded honestly (it is real disclosed
context, useful for transparency) but can **never** satisfy a qualification
criterion. The validators enforce this: a criterion claimed without a
verified supporting record fails registry validation.

Evidence documents and PII stay **off-repo** in the private credential store;
the repo records only opaque ids (`credentialRef`, `evidenceRef`). Coach ids
are opaque/pseudonymous.

## 3. Optional-but-recorded qualification metadata

The registry entry's `qualification` record captures, for every coach:

- `certifications[]` — each with organization, name-as-issued, level, verification;
- `professionalCoachingHistory` — verified claim or `null`;
- `competitiveBackground` — verified claim or `null`;
- `affiliation` — organization/role or `null`;
- `yearsCoaching` — `{value, basis}` or `null` (the basis says where the number comes from);
- `specialties[]` — free text as stated by the coach (may be empty).

Every field is **optional-but-recorded**: it is either a real record (with an
off-repo evidence reference where verification applies) or explicitly `null`
meaning "not provided / not on record". Nothing may be invented, inferred,
paraphrased into invented levels, or machine-generated. Missing (undefined)
fields fail validation — absence must be stated, not implied.

## 4. Roles and the provisioning flow

- **Coach**: provides identity + qualification claims and evidence off-repo.
- **Admin (provisioner)**: verifies evidence, assesses the qualification
  against this policy, and performs the provisioning action. Admin identities
  are recorded (`provisionedBy`, `assessedBy`, `performedBy`, `verifiedBy`);
  `SYNTHETIC*` identities are rejected everywhere.
- Engineers may NOT self-assess or provision themselves as coaches, and an
  LLM may never be a coach or an assessor. Machine-proposed content stays
  Tier-C and never enters this registry.

Provisioning writes two things atomically via the admin flow
(`POST /api/coach-provisioning` in the Coach Review Lab dev API, or an
equivalently reviewed commit):

1. an append-only audit record
   `datasets/coach-review/provisioning-log/<coachId>.a<n>.json`
   (`ProvisioningAction`: provision | suspend | reinstate, who, when, why,
   and — for provision — the full registry entry installed);
2. the updated registry `datasets/coach-review/coaches.json` (schema v2),
   which must validate as a whole after the change.

Action ids are sequential per coach (`<coachId>.a1`, `.a2`, …); the first
action for a coach must be `provision`; suspend/reinstate are status-only
actions. Audit records are never edited or deleted.

## 5. Enforcement (who may submit production reviews)

Every production write path in the Coach Review Lab (reviews, amendments,
adjudications, drill-mapping proposals, assignments) is gated on
`isEligibleReviewer`: the coach must be present in the v2 registry, status
`active`, non-synthetic, credentialRef-matched, and carry a valid
verdict-`qualified` qualification under a known policy version. Anything
else is refused with 403 and nothing is persisted.

## 6. Current truth

As of this policy version the registry is **empty**: zero real coaches are
provisioned and zero production reviews exist. Recruiting and verifying real
qualified coaches is irreducibly external (BLOCKED_EXTERNAL); this policy and
its tooling exist so that when a real coach appears, only their evidence —
never the process — remains missing.
