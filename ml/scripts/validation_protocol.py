#!/usr/bin/env python3
"""Scientific validation protocol package: schemas, validators and report runner.

This module ships the *procedure* for the W06 scientific validation and none of
its *data*. It defines the owner-supplied inputs (ratified protocol, consent
records, footage metadata, qualified reviewer records, blinded reviews,
adjudications) and the candidate predictions that a validation run needs,
validates each against a schema plus cross-record rules, and computes the
validation report once every input exists. Until then the report states
BLOCKED_EXTERNAL and names exactly which inputs are missing and who owns them.

The repository contains zero labels, zero reviewers and zero reviews for this
protocol. The runner never fabricates a record, a metric or an approval: a
missing input is reported as missing, a malformed input makes the run
INVALID_INPUT, and a computed report is an input to a human release decision
(`numerical_release_authorized` is always false).

Only the Python standard library is used.

Usage:
  python3 ml/scripts/validation_protocol.py --report [--inputs DIR] [--json]
  python3 ml/scripts/validation_protocol.py --validate KIND FILE [FILE ...]
  python3 ml/scripts/validation_protocol.py --schema KIND

Exit codes: 0 = report produced (BLOCKED_EXTERNAL, BLOCKED_INTERNAL or
COMPUTED) or all files valid; 1 = INVALID_INPUT / any invalid file; 2 = usage.
"""
from __future__ import annotations

import argparse
import functools
import json
import math
import re
import statistics
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from validate_annotations import TECHNIQUES

PROTOCOL_SCHEMA_VERSION = "validation-protocol-v1"
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_INPUT_ROOT = Path("datasets/validation-protocol")
CORPUS_REGISTRY_PATH = Path("datasets/corpus/recordings.json")
QUALIFICATION_POLICY_VERSION = "coach-qualification-policy-v1"

# Locked / retired holdouts (datasets/holdouts/ledger.json and
# packages/evaluation/src/benchmarkRelease.ts W06_PROTECTED_CASE_IDS /
# W06_PROTECTED_SESSION_IDS). Footage that references them can never enter this
# protocol.
PROTECTED_CASE_IDS = frozenset({"wm-dink-01", "afn-vic-rally1"})
PROTECTED_SESSION_IDS = frozenset({"wm-tournament-2014", "afn-vic-2025"})
PROTECTED_HOLDOUT_IDS = PROTECTED_CASE_IDS | PROTECTED_SESSION_IDS

# Content identity of the protected recordings and every recording derived from
# them (re-cuts, crops, re-encodes registered in datasets/corpus/recordings.json).
# Mirrors `protectedSourceHashes` in packages/evaluation/src/benchmarkRelease.ts;
# the unit tests pin that this set and the corpus registry agree.
PROTECTED_MEDIA_SHA256 = frozenset(
    {
        "024decaeb66e7eacd2b4d98673aa3adc02d00af591afcc5ccc851a679836a05c",
        "274544640cc6483e3ce0a677c49054e59658d84a90c72637a753a1fdfe2f1611",
        "72cd8795bdc2be6860a16ffa7245d4b889ea4c2482c3001812b883ed9e0486f6",
        "7d396a6d65669fc3b7fc3c33988e257be08f830e93ca20c51f38171fca0959a7",
        "8b77606225ba0e3543accc6195c7fb10a7d312f445a73a5e4a03ab68b8862c15",
        "ac6c9d7b50558a0cb02dd3253841a9a3a68b3c7d8b602f6ee30142f7c07d3d8f",
        "b6f280b2900c9f338daa7d5e6b4ac82a8ba4b8ff74d1c7762e3e0905ee946b62",
    }
)

# Dev-fixture identities (docs/COACH_QUALIFICATION_POLICY.md §4,
# packages/swing-lab/src/coachProvisioning.ts): rejected wherever an identity is
# recorded.
SYNTHETIC_IDENTITY_PATTERN = re.compile(r"synthetic", re.IGNORECASE)
IDENTITY_FIELDS = frozenset(
    {
        "ratified_by",
        "athlete_id",
        "athlete_group_id",
        "guardian_release_id",
        "participant_release_id",
        "verified_by",
        "rights_holder_id",
        "reviewer_id",
        "credential_ref",
        "assessed_by",
        "adjudicator_id",
    }
)

# JSON numbers are exchanged as IEEE-754 doubles; anything outside the exactly
# representable integer range (or non-finite) is refused rather than rounded.
MAX_SAFE_MAGNITUDE = 2**53

OPAQUE_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$"
SHA256_PATTERN = r"^[0-9a-f]{64}$"
DATE_TIME_PATTERN = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$"

HANDEDNESS = ["right", "left", "ambidextrous", "unknown"]
CAMERA_VIEWS = [
    "front",
    "rear",
    "dominant_side",
    "nondominant_side",
    "diagonal",
    "overhead",
    "other",
]
FOOTAGE_SOURCES = ["consented_first_party_capture", "commissioned_capture", "licensed_media"]
QUALIFICATION_CRITERIA = [
    "criterion.certification",
    "criterion.professional-coaching-history",
    "criterion.competitive-background-plus-teaching",
]
VERIFIED_METHODS = [
    "issuer_confirmed",
    "document_reviewed",
    "employer_confirmed",
    "public_record",
]
VERIFICATION_METHODS = VERIFIED_METHODS + ["unverified_disclosed"]
METADATA_VERIFICATION_METHODS = [
    "device_log_confirmed",
    "recorder_confirmed",
    "document_reviewed",
]
SUBGROUP_DIMENSIONS = [
    "device_os",
    "camera_view",
    "capture_conditions",
    "handedness",
    "athlete_group_id",
]

_OPAQUE_ID = {"type": "string", "pattern": OPAQUE_ID_PATTERN}
_NULLABLE_OPAQUE_ID = {"type": ["string", "null"], "pattern": OPAQUE_ID_PATTERN}
_DATE_TIME = {"type": "string", "pattern": DATE_TIME_PATTERN, "format": "date-time"}
_NULLABLE_DATE_TIME = {
    "type": ["string", "null"],
    "pattern": DATE_TIME_PATTERN,
    "format": "date-time",
}
_NON_EMPTY = {"type": "string", "minLength": 1}
_NULLABLE_NON_EMPTY = {"type": ["string", "null"], "minLength": 1}
_NULLABLE_NUMBER = {"type": ["number", "null"]}


def _object(required: list[str], properties: dict[str, dict]) -> dict:
    return {
        "type": "object",
        "required": required,
        "additionalProperties": False,
        "properties": properties,
    }


SCHEMAS: dict[str, dict] = {
    "protocol": _object(
        [
            "schema_version",
            "protocol_id",
            "status",
            "ratified_by",
            "ratified_at",
            "frozen_before_evaluation",
            "rubric_version",
            "blind_protocol_version",
            "rating_scale",
            "minimum_reviewers_per_clip",
            "minimum_independent_athletes",
            "targets",
            "excluded_case_ids",
        ],
        {
            "schema_version": {"const": PROTOCOL_SCHEMA_VERSION},
            "protocol_id": _OPAQUE_ID,
            "status": {"enum": ["proposed", "ratified"]},
            "ratified_by": {"type": "array", "items": _OPAQUE_ID, "uniqueItems": True},
            "ratified_at": _NULLABLE_DATE_TIME,
            "frozen_before_evaluation": {"type": "boolean"},
            "rubric_version": _NON_EMPTY,
            "blind_protocol_version": _NON_EMPTY,
            "rating_scale": _object(
                ["id", "minimum", "maximum"],
                {"id": _NON_EMPTY, "minimum": {"type": "number"}, "maximum": {"type": "number"}},
            ),
            "minimum_reviewers_per_clip": {"type": "integer", "minimum": 2},
            "minimum_independent_athletes": {"type": "integer", "minimum": 1},
            "targets": _object(
                [
                    "coach_exact_agreement_minimum",
                    "player_weighted_mae_maximum",
                    "range_coverage_minimum",
                    "median_width_maximum",
                ],
                {
                    "coach_exact_agreement_minimum": _NULLABLE_NUMBER,
                    "player_weighted_mae_maximum": _NULLABLE_NUMBER,
                    "range_coverage_minimum": _NULLABLE_NUMBER,
                    "median_width_maximum": _NULLABLE_NUMBER,
                },
            ),
            "excluded_case_ids": {"type": "array", "items": _NON_EMPTY, "uniqueItems": True},
        },
    ),
    "consent": _object(
        [
            "participant_release_id",
            "athlete_id",
            "terms_version",
            "signed_at",
            "age_class",
            "guardian_release_id",
            "permissions",
            "withdrawal_process_version",
            "state",
        ],
        {
            "participant_release_id": _OPAQUE_ID,
            "athlete_id": _OPAQUE_ID,
            "terms_version": _NON_EMPTY,
            "signed_at": _DATE_TIME,
            "age_class": {"enum": ["adult", "minor"]},
            "guardian_release_id": _NULLABLE_OPAQUE_ID,
            "permissions": _object(
                [
                    "product_evaluation",
                    "internal_human_review",
                    "derived_features",
                    "commercial_model_training",
                ],
                {
                    "product_evaluation": {"type": "boolean"},
                    "internal_human_review": {"type": "boolean"},
                    "derived_features": {"type": "boolean"},
                    "commercial_model_training": {"type": "boolean"},
                },
            ),
            "withdrawal_process_version": _NON_EMPTY,
            "state": {"enum": ["active", "withdrawn"]},
        },
    ),
    "footage": _object(
        [
            "clip_id",
            "media_sha256",
            "athlete_id",
            "athlete_group_id",
            "session_id",
            "source",
            "participant_release_id",
            "capture",
            "metadata_verification",
            "rights",
            "player_rating",
        ],
        {
            "clip_id": _OPAQUE_ID,
            "media_sha256": {"type": "string", "pattern": SHA256_PATTERN},
            "athlete_id": _OPAQUE_ID,
            "athlete_group_id": _OPAQUE_ID,
            "session_id": _OPAQUE_ID,
            "source": {"enum": FOOTAGE_SOURCES},
            "participant_release_id": _OPAQUE_ID,
            "capture": _object(
                [
                    "recorded_at",
                    "device_os",
                    "camera_view",
                    "fps",
                    "resolution",
                    "capture_conditions",
                    "handedness",
                ],
                {
                    "recorded_at": _DATE_TIME,
                    "device_os": {"enum": ["ios", "other"]},
                    "camera_view": {"enum": CAMERA_VIEWS},
                    "fps": {"type": "number", "minimum": 1},
                    "resolution": {"type": "string", "pattern": r"^\d{2,5}x\d{2,5}$"},
                    "capture_conditions": _NON_EMPTY,
                    "handedness": {"enum": HANDEDNESS},
                },
            ),
            "metadata_verification": {
                "type": ["object", "null"],
                "required": ["verified_by", "verified_at", "method"],
                "additionalProperties": False,
                "properties": {
                    "verified_by": _OPAQUE_ID,
                    "verified_at": _DATE_TIME,
                    "method": {"enum": METADATA_VERIFICATION_METHODS},
                },
            },
            "rights": _object(
                [
                    "rights_holder_id",
                    "commercial_training_grant_id",
                    "evidence_ref",
                    "verified_by",
                    "verified_at",
                    "state",
                ],
                {
                    "rights_holder_id": _OPAQUE_ID,
                    "commercial_training_grant_id": _NULLABLE_OPAQUE_ID,
                    "evidence_ref": _NON_EMPTY,
                    "verified_by": _NULLABLE_OPAQUE_ID,
                    "verified_at": _NULLABLE_DATE_TIME,
                    "state": {"enum": ["cleared", "pending"]},
                },
            ),
            "player_rating": {
                "type": ["object", "null"],
                "required": [
                    "rating_definition_id",
                    "value",
                    "observed_at",
                    "verified_by",
                    "verification_method",
                ],
                "additionalProperties": False,
                "properties": {
                    "rating_definition_id": _NON_EMPTY,
                    "value": {"type": "number"},
                    "observed_at": _DATE_TIME,
                    "verified_by": _OPAQUE_ID,
                    "verification_method": {"enum": VERIFICATION_METHODS},
                },
            },
        },
    ),
    "reviewer": _object(
        [
            "reviewer_id",
            "roles",
            "qualification_policy_version",
            "credential_ref",
            "qualification",
        ],
        {
            "reviewer_id": _OPAQUE_ID,
            "roles": {
                "type": "array",
                "minItems": 1,
                "uniqueItems": True,
                "items": {"enum": ["reviewer", "adjudicator"]},
            },
            "qualification_policy_version": {"const": QUALIFICATION_POLICY_VERSION},
            "credential_ref": _OPAQUE_ID,
            "qualification": _object(
                ["verdict", "satisfied_criteria", "evidence", "assessed_by", "assessed_at"],
                {
                    "verdict": {"enum": ["qualified", "not_qualified"]},
                    "satisfied_criteria": {
                        "type": "array",
                        "uniqueItems": True,
                        "items": {"enum": QUALIFICATION_CRITERIA},
                    },
                    "evidence": {
                        "type": "array",
                        "items": _object(
                            ["criterion", "verification_method"],
                            {
                                "criterion": {"enum": QUALIFICATION_CRITERIA},
                                "verification_method": {"enum": VERIFICATION_METHODS},
                            },
                        ),
                    },
                    "assessed_by": _OPAQUE_ID,
                    "assessed_at": _DATE_TIME,
                },
            ),
        },
    ),
    "review": _object(
        [
            "review_id",
            "clip_id",
            "reviewer_id",
            "blinding",
            "rubric_version",
            "outcome",
            "technique",
            "quality_rating",
            "cannot_evaluate_reason",
            "confidence",
            "submitted_at",
        ],
        {
            "review_id": _NON_EMPTY,
            "clip_id": _OPAQUE_ID,
            "reviewer_id": _OPAQUE_ID,
            "blinding": _object(
                [
                    "protocol_version",
                    "model_output_disclosed",
                    "other_reviews_disclosed",
                    "athlete_identity_disclosed",
                ],
                {
                    "protocol_version": _NON_EMPTY,
                    "model_output_disclosed": {"const": False},
                    "other_reviews_disclosed": {"const": False},
                    "athlete_identity_disclosed": {"const": False},
                },
            ),
            "rubric_version": _NON_EMPTY,
            "outcome": {"enum": ["rated", "cannot_evaluate"]},
            "technique": {"type": ["string", "null"], "enum": sorted(TECHNIQUES) + [None]},
            "quality_rating": {"type": ["integer", "null"]},
            "cannot_evaluate_reason": _NULLABLE_NON_EMPTY,
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "submitted_at": _DATE_TIME,
        },
    ),
    "adjudication": _object(
        ["clip_id", "adjudicator_id", "review_ids", "resolved_rating", "rationale", "submitted_at"],
        {
            "clip_id": _OPAQUE_ID,
            "adjudicator_id": _OPAQUE_ID,
            "review_ids": {
                "type": "array",
                "minItems": 2,
                "uniqueItems": True,
                "items": _NON_EMPTY,
            },
            "resolved_rating": {"type": "integer"},
            "rationale": _NON_EMPTY,
            "submitted_at": _DATE_TIME,
        },
    ),
    "prediction": _object(
        ["clip_id", "subject", "prediction"],
        {
            "clip_id": _OPAQUE_ID,
            "subject": _object(
                ["pipeline_version", "scoring_definition_version", "model_version"],
                {
                    "pipeline_version": _NON_EMPTY,
                    "scoring_definition_version": _NON_EMPTY,
                    "model_version": _NON_EMPTY,
                },
            ),
            "prediction": _object(
                ["status", "lower", "upper", "reason"],
                {
                    "status": {"enum": ["range", "abstained"]},
                    "lower": _NULLABLE_NUMBER,
                    "upper": _NULLABLE_NUMBER,
                    "reason": _NULLABLE_NON_EMPTY,
                },
            ),
        },
    ),
}

# Input kinds in the order the report lists them. `directory` is relative to the
# inputs root; `protocol` is a single file, every other kind is one JSON file per
# record. `owner` says who must supply the input: `external` = the product owner
# (footage, consent, rights, reviewers, reviews, adjudication); `internal` = the
# engineering side (candidate predictions produced by running the frozen
# candidate on the eligible footage).
INPUT_KINDS: list[dict[str, str]] = [
    {"id": "protocol", "schema": "protocol", "path": "protocol.json", "owner": "external"},
    {"id": "consent", "schema": "consent", "path": "consent/*.json", "owner": "external"},
    {"id": "footage", "schema": "footage", "path": "footage/*.json", "owner": "external"},
    {"id": "reviewers", "schema": "reviewer", "path": "reviewers/*.json", "owner": "external"},
    {"id": "reviews", "schema": "review", "path": "reviews/*.json", "owner": "external"},
    {
        "id": "adjudications",
        "schema": "adjudication",
        "path": "adjudications/*.json",
        "owner": "external",
    },
    {
        "id": "predictions",
        "schema": "prediction",
        "path": "predictions/*.json",
        "owner": "internal",
    },
]

MISSING_INPUT_DEFINITIONS: dict[str, dict[str, str]] = {
    "ratified_protocol": {
        "label": "ratified protocol",
        "owner": "external",
        "expected_path": "protocol.json",
        "description": (
            "protocol.json with status=ratified, named signatories, a frozen rubric, "
            "blind protocol, rating scale, reviewer minimum and preregistered targets"
        ),
    },
    "consented_footage": {
        "label": "consented footage",
        "owner": "external",
        "expected_path": "footage/*.json + consent/*.json",
        "description": (
            "footage records whose participant_release_id resolves to an active consent "
            "record for the same athlete granting product_evaluation and "
            "internal_human_review"
        ),
    },
    "verified_capture_metadata": {
        "label": "verified capture metadata",
        "owner": "external",
        "expected_path": "footage/*.json (metadata_verification)",
        "description": (
            "every footage record carries a metadata_verification block signed by a "
            "verifier (device_log_confirmed | recorder_confirmed | document_reviewed)"
        ),
    },
    "rights_clearance": {
        "label": "rights clearance",
        "owner": "external",
        "expected_path": "footage/*.json (rights)",
        "description": (
            "every footage record has rights.state=cleared with a verifier and "
            "verification timestamp"
        ),
    },
    "qualified_blinded_reviewers": {
        "label": "qualified blinded reviewers",
        "owner": "external",
        "expected_path": "reviewers/*.json",
        "description": (
            "at least minimum_reviewers_per_clip reviewer records with "
            "qualification.verdict=qualified under coach-qualification-policy-v1, each "
            "satisfied criterion backed by verified evidence, plus at least one "
            "adjudicator role"
        ),
    },
    "blinded_reviews": {
        "label": "blinded reviews",
        "owner": "external",
        "expected_path": "reviews/*.json",
        "description": (
            "for every eligible clip, at least minimum_reviewers_per_clip blinded reviews "
            "from distinct qualified reviewers (model output, other reviews and athlete "
            "identity undisclosed)"
        ),
    },
    "adjudication": {
        "label": "adjudication",
        "owner": "external",
        "expected_path": "adjudications/*.json",
        "description": (
            "for every clip whose blinded reviews disagree or abstain, one adjudication by "
            "a qualified adjudicator who authored none of the clip's reviews"
        ),
    },
    "candidate_predictions": {
        "label": "candidate predictions",
        "owner": "internal",
        "expected_path": "predictions/*.json",
        "description": (
            "one prediction record per eligible clip produced by the frozen candidate "
            "(a range on the protocol rating scale or an abstention with a reason)"
        ),
    },
}

EXTERNAL_INPUT_IDS = frozenset(
    key for key, spec in MISSING_INPUT_DEFINITIONS.items() if spec["owner"] == "external"
)


# --------------------------------------------------------------------------- #
# Protected holdout identity (content hash + id aliases)
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ProtectedIdentity:
    media_sha256: frozenset[str]
    aliases: frozenset[str]


def _registry_recordings(registry: Path) -> list[dict]:
    if not registry.is_file():
        return []
    try:
        with registry.open(encoding="utf-8") as handle:
            loaded = json.load(handle)
    except (OSError, ValueError, RecursionError):
        return []
    if not isinstance(loaded, list):
        return []
    return [record for record in loaded if isinstance(record, dict)]


@functools.lru_cache(maxsize=None)
def protected_identity(registry: Path | None = None) -> ProtectedIdentity:
    """Content hashes and id aliases that identify protected holdout footage.

    The pinned constants are the floor; the corpus registry adds every recording
    filed under a protected session and every recording derived (re-cut, crop,
    re-encode) from one of them, so an alias or a derivative can never be
    registered as fresh validation footage.
    """
    hashes = set(PROTECTED_MEDIA_SHA256)
    aliases = {value.lower() for value in PROTECTED_HOLDOUT_IDS}
    if registry is None:
        registry = REPO_ROOT / CORPUS_REGISTRY_PATH
    by_id = {
        record["recordingId"]: record
        for record in _registry_recordings(registry)
        if isinstance(record.get("recordingId"), str)
    }
    protected_ids: set[str] = set()
    for recording_id, record in by_id.items():
        session = record.get("sessionKey")
        if isinstance(session, str) and session.lower() in PROTECTED_SESSION_IDS:
            protected_ids.add(recording_id)
        digest = record.get("sha256")
        if isinstance(digest, str) and digest.lower() in hashes:
            protected_ids.add(recording_id)
    changed = True
    while changed:
        changed = False
        for recording_id, record in by_id.items():
            if recording_id in protected_ids:
                continue
            parents = record.get("derivedFrom")
            if isinstance(parents, list) and any(
                isinstance(parent, dict) and parent.get("parentRecordingId") in protected_ids
                for parent in parents
            ):
                protected_ids.add(recording_id)
                changed = True
    for recording_id in protected_ids:
        record = by_id[recording_id]
        aliases.add(recording_id.lower())
        digest = record.get("sha256")
        if isinstance(digest, str) and re.fullmatch(SHA256_PATTERN, digest.lower()):
            hashes.add(digest.lower())
        session = record.get("sessionKey")
        if isinstance(session, str) and session:
            aliases.add(session.lower())
        path = record.get("path")
        if isinstance(path, str) and path:
            aliases.add(Path(path).stem.lower())
        notes = record.get("notes")
        if isinstance(notes, str):
            for legacy in re.findall(r"legacy id:\s*([A-Za-z0-9._:-]+)", notes):
                aliases.add(legacy.lower())
    return ProtectedIdentity(media_sha256=frozenset(hashes), aliases=frozenset(aliases))


def is_protected_identifier(value: str) -> bool:
    """True when `value` names a protected holdout, case-insensitively and
    including prefixed/suffixed aliases such as `WM-DINK-01` or
    `afn-vic-2025-recut-0001` (the benchmark release gate matches the same way)."""
    lowered = value.lower()
    return any(alias in lowered for alias in protected_identity().aliases)


def is_protected_media(sha256: str) -> bool:
    return sha256.lower() in protected_identity().media_sha256


def _parse_date_time(value: str) -> datetime | None:
    match = re.fullmatch(DATE_TIME_PATTERN, value)
    if match is None:
        return None
    fraction = match.group(1) or ""
    normalized = value[:19] + fraction[:7] + value[19 + len(fraction) :]
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        return None


# --------------------------------------------------------------------------- #
# Schema validation (JSON-Schema subset, standard library only)
# --------------------------------------------------------------------------- #


def _type_matches(value: object, expected: str) -> bool:
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "null":
        return value is None
    raise ValueError(f"unsupported schema type {expected!r}")


def _check_schema(value: object, schema: dict, path: str, errors: list[str]) -> None:
    if "const" in schema:
        if value != schema["const"] or type(value) is not type(schema["const"]):
            errors.append(f"{path}: must equal {json.dumps(schema['const'])}")
        return
    if "enum" in schema:
        if value not in schema["enum"]:
            errors.append(f"{path}: must be one of {json.dumps(schema['enum'])}")
        return
    expected = schema.get("type")
    if expected is not None:
        expected_types = expected if isinstance(expected, list) else [expected]
        if not any(_type_matches(value, kind) for kind in expected_types):
            errors.append(f"{path}: expected {'|'.join(expected_types)}")
            return
    if value is None:
        return
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            errors.append(f"{path}: must not be empty")
        if "pattern" in schema and re.fullmatch(schema["pattern"], value) is None:
            errors.append(f"{path}: does not match {schema['pattern']}")
        elif schema.get("format") == "date-time" and _parse_date_time(value) is None:
            errors.append(f"{path}: is not a valid calendar date-time")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if isinstance(value, float) and not math.isfinite(value):
            errors.append(f"{path}: must be a finite number")
            return
        if abs(value) > MAX_SAFE_MAGNITUDE:
            errors.append(f"{path}: magnitude exceeds 2^53 and cannot be represented exactly")
            return
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path}: must be >= {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(f"{path}: must be <= {schema['maximum']}")
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append(f"{path}: needs at least {schema['minItems']} items")
        if schema.get("uniqueItems"):
            seen = [json.dumps(item, sort_keys=True) for item in value]
            if len(set(seen)) != len(seen):
                errors.append(f"{path}: items must be unique")
        item_schema = schema.get("items")
        if item_schema is not None:
            for index, item in enumerate(value):
                _check_schema(item, item_schema, f"{path}[{index}]", errors)
    if isinstance(value, dict):
        properties = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path}: missing required field {key!r}")
        if schema.get("additionalProperties") is False:
            for key in sorted(set(value) - set(properties)):
                errors.append(f"{path}: unknown field {key!r}")
        for key, sub_schema in properties.items():
            if key in value:
                _check_schema(value[key], sub_schema, f"{path}.{key}", errors)


def _synthetic_identity_checks(value: object, path: str, err) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}" if path else key
            if key in IDENTITY_FIELDS:
                candidates = child if isinstance(child, list) else [child]
                for candidate in candidates:
                    if isinstance(candidate, str) and SYNTHETIC_IDENTITY_PATTERN.search(candidate):
                        err(
                            f"{child_path} {candidate!r} is a SYNTHETIC dev-fixture identity and "
                            "can never enter the protocol"
                        )
            _synthetic_identity_checks(child, child_path, err)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _synthetic_identity_checks(child, f"{path}[{index}]", err)


def _cross_checks(kind: str, doc: dict, errors: list[str]) -> None:
    def err(message: str) -> None:
        errors.append(message)

    _synthetic_identity_checks(doc, "", err)
    if kind == "protocol":
        if doc.get("status") == "ratified":
            if not doc.get("ratified_by"):
                err("ratified_by must name at least one signatory when status=ratified")
            if doc.get("ratified_at") is None:
                err("ratified_at is required when status=ratified")
            if doc.get("frozen_before_evaluation") is not True:
                err("frozen_before_evaluation must be true when status=ratified")
        scale = doc.get("rating_scale")
        if isinstance(scale, dict) and isinstance(scale.get("minimum"), (int, float)):
            maximum = scale.get("maximum")
            if isinstance(maximum, (int, float)) and maximum <= scale["minimum"]:
                err("rating_scale.maximum must exceed rating_scale.minimum")
        for key, value in (doc.get("targets") or {}).items():
            if key in {"coach_exact_agreement_minimum", "range_coverage_minimum"}:
                if isinstance(value, (int, float)) and not 0 <= value <= 1:
                    err(f"targets.{key} must lie in [0, 1]")
            elif isinstance(value, (int, float)) and value < 0:
                err(f"targets.{key} must be >= 0")
    elif kind == "consent":
        age_class = doc.get("age_class")
        guardian = doc.get("guardian_release_id")
        if age_class == "minor" and guardian is None:
            err("guardian_release_id is required when age_class=minor")
        if age_class == "adult" and guardian is not None:
            err("guardian_release_id must be null when age_class=adult")
    elif kind == "footage":
        for key in ("clip_id", "session_id", "athlete_id", "athlete_group_id"):
            value = doc.get(key)
            if isinstance(value, str) and is_protected_identifier(value):
                err(f"{key} {value!r} is a protected holdout and may not enter the protocol")
        digest = doc.get("media_sha256")
        if isinstance(digest, str) and is_protected_media(digest):
            err(
                f"media_sha256 {digest[:12]}… is a protected holdout recording (or a re-cut of "
                "one) and may not enter the protocol under any clip_id"
            )
        capture = doc.get("capture")
        recorded_at = (
            _parse_date_time(capture["recorded_at"])
            if isinstance(capture, dict) and isinstance(capture.get("recorded_at"), str)
            else None
        )
        verification = doc.get("metadata_verification")
        if isinstance(verification, dict) and isinstance(verification.get("verified_at"), str):
            verified_at = _parse_date_time(verification["verified_at"])
            if recorded_at is not None and verified_at is not None and verified_at < recorded_at:
                err("metadata_verification.verified_at precedes capture.recorded_at")
        rights = doc.get("rights")
        if isinstance(rights, dict) and rights.get("state") == "cleared":
            if rights.get("verified_by") is None or rights.get("verified_at") is None:
                err("rights.state=cleared requires verified_by and verified_at")
    elif kind == "reviewer":
        qualification = doc.get("qualification")
        if isinstance(qualification, dict):
            reviewer_id = doc.get("reviewer_id")
            assessed_by = qualification.get("assessed_by")
            if (
                isinstance(reviewer_id, str)
                and isinstance(assessed_by, str)
                and assessed_by.lower() == reviewer_id.lower()
            ):
                err(
                    "qualification.assessed_by equals reviewer_id: coaches cannot assess their "
                    "own qualification (coach-qualification-policy-v1 requires an admin assessor)"
                )
            evidence = qualification.get("evidence")
            criteria = qualification.get("satisfied_criteria")
            verified_for: set[str] = set()
            if isinstance(evidence, list):
                for record in evidence:
                    if not isinstance(record, dict):
                        continue
                    if record.get("verification_method") in VERIFIED_METHODS:
                        verified_for.add(str(record.get("criterion")))
                    elif record.get("criterion") in (criteria or []):
                        err(
                            f"criterion {record.get('criterion')!r} is claimed but its evidence is "
                            "unverified_disclosed, which can never satisfy a criterion"
                        )
            if isinstance(criteria, list):
                for criterion in criteria:
                    if criterion not in verified_for:
                        err(f"satisfied criterion {criterion!r} has no verified evidence record")
                if qualification.get("verdict") == "qualified" and not criteria:
                    err("verdict=qualified requires at least one satisfied criterion")
    elif kind == "review":
        clip_id = doc.get("clip_id")
        reviewer_id = doc.get("reviewer_id")
        if isinstance(clip_id, str) and isinstance(reviewer_id, str):
            if doc.get("review_id") != f"{clip_id}.{reviewer_id}":
                err("review_id must equal '<clip_id>.<reviewer_id>'")
        outcome = doc.get("outcome")
        rating = doc.get("quality_rating")
        reason = doc.get("cannot_evaluate_reason")
        if outcome == "rated":
            if rating is None:
                err("outcome=rated requires an integer quality_rating")
            if reason is not None:
                err("cannot_evaluate_reason must be null when outcome=rated")
        elif outcome == "cannot_evaluate":
            if rating is not None:
                err("outcome=cannot_evaluate requires quality_rating=null (no guessed rating)")
            if reason is None:
                err("outcome=cannot_evaluate requires a non-empty cannot_evaluate_reason")
    elif kind == "prediction":
        prediction = doc.get("prediction")
        if isinstance(prediction, dict):
            status = prediction.get("status")
            lower = prediction.get("lower")
            upper = prediction.get("upper")
            if status == "range":
                if lower is None or upper is None:
                    err("prediction.status=range requires numeric lower and upper")
                elif lower > upper:
                    err("prediction.lower must not exceed prediction.upper")
                if prediction.get("reason") is not None:
                    err("prediction.reason must be null when status=range")
            elif status == "abstained":
                if lower is not None or upper is not None:
                    err("prediction.status=abstained requires lower=null and upper=null")
                if prediction.get("reason") is None:
                    err("prediction.status=abstained requires a non-empty reason")


def validate_record(kind: str, doc: object, name: str) -> list[str]:
    """Return every schema and cross-field error for one record (empty = valid)."""
    if kind not in SCHEMAS:
        raise ValueError(f"unknown record kind {kind!r}; known: {sorted(SCHEMAS)}")
    errors: list[str] = []
    _check_schema(doc, SCHEMAS[kind], name, errors)
    if isinstance(doc, dict):
        cross: list[str] = []
        _cross_checks(kind, doc, cross)
        errors.extend(f"{name}: {message}" for message in cross)
    return errors


# --------------------------------------------------------------------------- #
# Loading owner-supplied inputs
# --------------------------------------------------------------------------- #


@dataclass
class ProtocolInputs:
    root: Path
    root_exists: bool
    protocol: dict | None = None
    consent: list[dict] = field(default_factory=list)
    footage: list[dict] = field(default_factory=list)
    reviewers: list[dict] = field(default_factory=list)
    reviews: list[dict] = field(default_factory=list)
    adjudications: list[dict] = field(default_factory=list)
    predictions: list[dict] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    record_counts: dict[str, int] = field(default_factory=dict)


_UNREADABLE = object()


def _refuse_non_finite(constant: str) -> object:
    raise ValueError(f"non-finite number {constant} is not valid JSON")


def _read_json(path: Path, display: str, errors: list[str]) -> object:
    """Parse one strict-JSON file; returns `_UNREADABLE` (and records the error)
    when the file cannot be parsed. A JSON `null` document is returned as None
    so the caller can reject it as an invalid record rather than skip it."""
    try:
        with path.open(encoding="utf-8") as handle:
            return json.load(handle, parse_constant=_refuse_non_finite)
    except (OSError, ValueError) as exc:
        errors.append(f"{display}: could not be read as JSON ({exc})")
    except RecursionError:
        errors.append(f"{display}: could not be read as JSON (nesting too deep)")
    return _UNREADABLE


def load_inputs(root: Path) -> ProtocolInputs:
    """Load and validate every input under `root`; never invents a record."""
    inputs = ProtocolInputs(root=root, root_exists=root.is_dir())
    loaded: dict[str, list[dict]] = {}
    for kind in INPUT_KINDS:
        schema = kind["schema"]
        if kind["id"] == "protocol":
            path = root / kind["path"]
            inputs.record_counts["protocol"] = 0
            if path.is_file():
                doc = _read_json(path, kind["path"], inputs.errors)
                if doc is not _UNREADABLE:
                    inputs.record_counts["protocol"] = 1
                    record_errors = validate_record(schema, doc, kind["path"])
                    inputs.errors.extend(record_errors)
                    if not record_errors and isinstance(doc, dict):
                        inputs.protocol = doc
            continue
        directory = root / kind["path"].split("/")[0]
        records: list[dict] = []
        count = 0
        if directory.is_dir():
            for path in sorted(directory.glob("*.json")):
                display = f"{directory.name}/{path.name}"
                doc = _read_json(path, display, inputs.errors)
                if doc is _UNREADABLE:
                    continue
                count += 1
                record_errors = validate_record(schema, doc, display)
                inputs.errors.extend(record_errors)
                if not record_errors and isinstance(doc, dict):
                    records.append(doc)
        inputs.record_counts[kind["id"]] = count
        loaded[kind["id"]] = records
    inputs.consent = loaded["consent"]
    inputs.footage = loaded["footage"]
    inputs.reviewers = loaded["reviewers"]
    inputs.reviews = loaded["reviews"]
    inputs.adjudications = loaded["adjudications"]
    inputs.predictions = loaded["predictions"]
    _check_uniqueness(inputs)
    return inputs


def _check_uniqueness(inputs: ProtocolInputs) -> None:
    def duplicates(records: list[dict], key: str, label: str) -> None:
        seen: set[str] = set()
        for record in records:
            value = record[key]
            if value in seen:
                inputs.errors.append(f"{label}: duplicate {key} {value!r}")
            seen.add(value)

    duplicates(inputs.consent, "participant_release_id", "consent")
    duplicates(inputs.footage, "clip_id", "footage")
    duplicates(inputs.footage, "media_sha256", "footage")
    duplicates(inputs.reviewers, "reviewer_id", "reviewers")
    duplicates(inputs.reviewers, "credential_ref", "reviewers")
    duplicates(inputs.reviews, "review_id", "reviews")
    duplicates(inputs.adjudications, "clip_id", "adjudications")
    duplicates(inputs.predictions, "clip_id", "predictions")


# --------------------------------------------------------------------------- #
# Report computation
# --------------------------------------------------------------------------- #


@dataclass
class _ClipState:
    clip: dict
    eligible: bool
    ratings: dict[str, int] = field(default_factory=dict)
    abstained_reviewers: list[str] = field(default_factory=list)
    disagreement: bool = False
    adjudicated: bool = False
    unevaluable: bool = False
    target: int | None = None


def _missing(missing: dict[str, list[str]], input_id: str, detail: str) -> None:
    missing.setdefault(input_id, []).append(detail)


def _qualified_reviewers(inputs: ProtocolInputs) -> dict[str, dict]:
    return {
        reviewer["reviewer_id"]: reviewer
        for reviewer in inputs.reviewers
        if reviewer["qualification"]["verdict"] == "qualified"
    }


def _cross_record_checks(inputs: ProtocolInputs, qualified: dict[str, dict]) -> list[str]:
    """Consistency rules that need more than one record; violations are INVALID_INPUT."""
    errors: list[str] = []
    review_ids = {review["review_id"]: review for review in inputs.reviews}
    reviews_by_clip: dict[str, list[dict]] = {}
    for review in inputs.reviews:
        reviews_by_clip.setdefault(review["clip_id"], []).append(review)
    footage_by_clip = {clip["clip_id"]: clip for clip in inputs.footage}
    consent_by_release = {record["participant_release_id"]: record for record in inputs.consent}

    # Conflict of interest: nobody who verified, holds rights to or appears in
    # the footage may review or adjudicate it.
    reviewer_ids = {reviewer["reviewer_id"] for reviewer in inputs.reviewers}
    for clip in inputs.footage:
        clip_id = clip["clip_id"]
        roles = {
            "athlete_id": clip["athlete_id"],
            "rights.rights_holder_id": clip["rights"]["rights_holder_id"],
            "rights.verified_by": clip["rights"]["verified_by"],
        }
        verification = clip["metadata_verification"]
        if verification is not None:
            roles["metadata_verification.verified_by"] = verification["verified_by"]
        for field_name, identity in roles.items():
            if identity in reviewer_ids:
                errors.append(
                    f"footage/{clip_id}: {field_name} {identity!r} is also a reviewer record; "
                    "reviewers may not verify, own or appear in footage they could review"
                )
    for record in inputs.consent:
        if record["athlete_id"] in reviewer_ids:
            errors.append(
                f"consent/{record['participant_release_id']}: athlete_id "
                f"{record['athlete_id']!r} is also a reviewer record"
            )

    for adjudication in inputs.adjudications:
        clip_id = adjudication["clip_id"]
        adjudicator_id = adjudication["adjudicator_id"]
        adjudicator = qualified.get(adjudicator_id)
        clip_reviews = reviews_by_clip.get(clip_id, [])
        for review in clip_reviews:
            if review["reviewer_id"] == adjudicator_id:
                errors.append(
                    f"adjudications/{clip_id}: adjudicator {adjudicator_id!r} authored review "
                    f"{review['review_id']!r} of this clip and is not independent"
                )
        listed = set(adjudication["review_ids"])
        for review in clip_reviews:
            if review["review_id"] not in listed:
                errors.append(
                    f"adjudications/{clip_id}: review_ids omits review {review['review_id']!r} "
                    "of this clip; an adjudication must cover every blinded review"
                )
        if clip_reviews and all(review["outcome"] != "rated" for review in clip_reviews):
            errors.append(
                f"adjudications/{clip_id}: every blinded review of this clip abstained; a "
                "rating cannot be resolved from the adjudicator alone"
            )
        adjudicated_at = _parse_date_time(adjudication["submitted_at"])
        for review_id in adjudication["review_ids"]:
            review = review_ids.get(review_id)
            if review is None:
                errors.append(f"adjudications/{clip_id}: references unknown review {review_id!r}")
            elif review["clip_id"] != clip_id:
                errors.append(
                    f"adjudications/{clip_id}: review {review_id!r} belongs to another clip"
                )
            else:
                reviewed_at = _parse_date_time(review["submitted_at"])
                if (
                    adjudicated_at is not None
                    and reviewed_at is not None
                    and adjudicated_at < reviewed_at
                ):
                    errors.append(
                        f"adjudications/{clip_id}: submitted_at precedes review {review_id!r}"
                    )
        if adjudicator is None:
            errors.append(
                f"adjudications/{clip_id}: adjudicator {adjudication['adjudicator_id']!r} is not a "
                "qualified reviewer record"
            )
        elif "adjudicator" not in adjudicator["roles"]:
            errors.append(
                f"adjudications/{clip_id}: {adjudication['adjudicator_id']!r} lacks the "
                "adjudicator role"
            )
    for review in inputs.reviews:
        submitted_at = _parse_date_time(review["submitted_at"])
        clip = footage_by_clip.get(review["clip_id"])
        if submitted_at is None or clip is None:
            continue
        recorded_at = _parse_date_time(clip["capture"]["recorded_at"])
        if recorded_at is not None and submitted_at < recorded_at:
            errors.append(
                f"reviews/{review['review_id']}: submitted_at precedes the clip's "
                "capture.recorded_at"
            )
        consent = consent_by_release.get(clip["participant_release_id"])
        if consent is not None:
            signed_at = _parse_date_time(consent["signed_at"])
            if signed_at is not None and submitted_at < signed_at:
                errors.append(
                    f"reviews/{review['review_id']}: submitted_at precedes the participant's "
                    "consent signed_at"
                )

    subjects = sorted(
        {json.dumps(prediction["subject"], sort_keys=True) for prediction in inputs.predictions}
    )
    if len(subjects) > 1:
        errors.append(
            f"predictions: {len(subjects)} distinct candidate subject versions supplied; one "
            "frozen candidate per report (" + "; ".join(subjects) + ")"
        )

    protocol = inputs.protocol
    if protocol is not None:
        low = protocol["rating_scale"]["minimum"]
        high = protocol["rating_scale"]["maximum"]
        ratified_at = None
        if protocol["ratified_at"] is not None:
            ratified_at = _parse_date_time(protocol["ratified_at"])
        for review in inputs.reviews:
            submitted_at = _parse_date_time(review["submitted_at"])
            if ratified_at is not None and submitted_at is not None and submitted_at < ratified_at:
                errors.append(
                    f"reviews/{review['review_id']}: submitted_at precedes protocol ratified_at; "
                    "reviews collected before the protocol was frozen are not blinded evidence"
                )
            rating = review["quality_rating"]
            if rating is not None and not low <= rating <= high:
                errors.append(
                    f"reviews/{review['review_id']}: quality_rating {rating} outside the protocol "
                    f"rating scale [{low}, {high}]"
                )
            if review["blinding"]["protocol_version"] != protocol["blind_protocol_version"]:
                errors.append(
                    f"reviews/{review['review_id']}: blinding.protocol_version differs from the "
                    "ratified blind_protocol_version"
                )
            if review["rubric_version"] != protocol["rubric_version"]:
                errors.append(
                    f"reviews/{review['review_id']}: rubric_version differs from the ratified "
                    "rubric"
                )
        for adjudication in inputs.adjudications:
            rating = adjudication["resolved_rating"]
            if not low <= rating <= high:
                errors.append(
                    f"adjudications/{adjudication['clip_id']}: resolved_rating {rating} outside "
                    f"the protocol rating scale [{low}, {high}]"
                )
        for prediction in inputs.predictions:
            body = prediction["prediction"]
            if body["status"] == "range" and not (low <= body["lower"] and body["upper"] <= high):
                errors.append(
                    f"predictions/{prediction['clip_id']}: range lies outside the protocol rating "
                    f"scale [{low}, {high}]"
                )
    return errors


def _mean(values: list[float]) -> float | None:
    return round(statistics.fmean(values), 6) if values else None


def _player_weighted(per_clip: dict[str, list[float]]) -> float | None:
    per_athlete = [statistics.fmean(values) for values in per_clip.values() if values]
    return _mean(per_athlete)


def _gate(
    gate_id: str, target: float | None, observed: float | None, higher_is_better: bool
) -> dict:
    if target is None:
        verdict = "NOT_EVALUABLE"
        reason = "no preregistered target in the ratified protocol"
    elif observed is None:
        verdict = "NOT_EVALUABLE"
        reason = "no observations"
    else:
        met = observed >= target if higher_is_better else observed <= target
        verdict = "MET" if met else "NOT_MET"
        reason = "point estimate only; no interval, no independence adjustment"
    return {
        "id": gate_id,
        "target": target,
        "observed": observed,
        "verdict": verdict,
        "note": reason,
    }


def _compute_results(inputs: ProtocolInputs, clips: list[_ClipState]) -> dict:
    protocol = inputs.protocol
    if protocol is None:
        raise ValueError("results can only be computed from a ratified protocol")
    resolved = [clip for clip in clips if clip.eligible and clip.target is not None]
    predictions = {prediction["clip_id"]: prediction for prediction in inputs.predictions}

    multi = [clip for clip in clips if clip.eligible and len(clip.ratings) >= 2]
    exact = [1.0 if len(set(clip.ratings.values())) == 1 else 0.0 for clip in multi]
    pairwise: list[float] = []
    for clip in multi:
        values = sorted(clip.ratings.values())
        for i, left in enumerate(values):
            for right in values[i + 1 :]:
                pairwise.append(float(right - left))
    agreement = {
        "clips_with_multiple_reviews": len(multi),
        "exact_agreement_rate": _mean(exact),
        "mean_absolute_difference": _mean(pairwise),
        "adjudicated_clips": sum(1 for clip in clips if clip.adjudicated),
        "reviewer_abstentions": sum(len(clip.abstained_reviewers) for clip in clips),
    }

    covered: list[float] = []
    errors: list[float] = []
    widths: list[float] = []
    covered_by_athlete: dict[str, list[float]] = {}
    errors_by_athlete: dict[str, list[float]] = {}
    abstentions = 0
    subgroup_rows: dict[str, dict[str, dict[str, list[float]]]] = {
        dimension: {} for dimension in SUBGROUP_DIMENSIONS
    }
    for clip in resolved:
        prediction = predictions[clip.clip["clip_id"]]["prediction"]
        if prediction["status"] == "abstained":
            abstentions += 1
            continue
        target = float(clip.target)
        lower = float(prediction["lower"])
        upper = float(prediction["upper"])
        hit = 1.0 if lower <= target <= upper else 0.0
        error = abs((lower + upper) / 2 - target)
        covered.append(hit)
        errors.append(error)
        widths.append(upper - lower)
        athlete = clip.clip["athlete_id"]
        covered_by_athlete.setdefault(athlete, []).append(hit)
        errors_by_athlete.setdefault(athlete, []).append(error)
        for dimension in SUBGROUP_DIMENSIONS:
            value = (
                clip.clip[dimension]
                if dimension == "athlete_group_id"
                else clip.clip["capture"][dimension]
            )
            row = subgroup_rows[dimension].setdefault(value, {"covered": [], "errors": []})
            row["covered"].append(hit)
            row["errors"].append(error)

    candidate = {
        "subject_versions": sorted(
            {json.dumps(prediction["subject"], sort_keys=True) for prediction in inputs.predictions}
        ),
        "attempts": len(resolved),
        "numerical_outputs": len(covered),
        "abstentions": abstentions,
        "range_coverage_pooled": _mean(covered),
        "range_coverage_player_weighted": _player_weighted(covered_by_athlete),
        "mae_pooled": _mean(errors),
        "mae_player_weighted": _player_weighted(errors_by_athlete),
        "median_width": round(statistics.median(widths), 6) if widths else None,
        "confidence_intervals": None,
        "confidence_interval_note": (
            "not computed: grouped/simultaneous uncertainty needs the ratified power and "
            "precision plan; point estimates here are diagnostics, not release evidence"
        ),
    }

    subgroups = {
        dimension: {
            value: {
                "clips": len(row["covered"]),
                "range_coverage": _mean(row["covered"]),
                "mae": _mean(row["errors"]),
            }
            for value, row in sorted(rows.items())
        }
        for dimension, rows in subgroup_rows.items()
    }

    targets = protocol["targets"]
    gates = [
        _gate(
            "coach_agreement",
            targets["coach_exact_agreement_minimum"],
            agreement["exact_agreement_rate"],
            higher_is_better=True,
        ),
        _gate(
            "primary_error",
            targets["player_weighted_mae_maximum"],
            candidate["mae_player_weighted"],
            higher_is_better=False,
        ),
        _gate(
            "range_coverage",
            targets["range_coverage_minimum"],
            candidate["range_coverage_player_weighted"],
            higher_is_better=True,
        ),
        _gate(
            "useful_width",
            targets["median_width_maximum"],
            candidate["median_width"],
            higher_is_better=False,
        ),
    ]

    eligible = [clip for clip in clips if clip.eligible]
    return {
        "protocol_id": protocol["protocol_id"],
        "rubric_version": protocol["rubric_version"],
        "rating_scale": protocol["rating_scale"],
        "clips": {
            "supplied": len(inputs.footage),
            "eligible": len(eligible),
            "resolved": len(resolved),
            "unevaluable": sum(1 for clip in eligible if clip.unevaluable),
            "independent_athletes": len({clip.clip["athlete_id"] for clip in eligible}),
            "independent_sessions": len({clip.clip["session_id"] for clip in eligible}),
            "minimum_independent_athletes": protocol["minimum_independent_athletes"],
        },
        "reviewer_agreement": agreement,
        "candidate": candidate,
        "subgroups": subgroups,
        "gates": gates,
    }


def _display_root(root: Path) -> str:
    try:
        return str(root.resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(root)


def build_report(inputs: ProtocolInputs) -> dict:
    """Compute the validation report, or state exactly which inputs are missing."""
    missing: dict[str, list[str]] = {}
    protocol = inputs.protocol
    if protocol is None:
        _missing(missing, "ratified_protocol", "no valid protocol.json")
    elif protocol["status"] != "ratified":
        _missing(missing, "ratified_protocol", f"protocol.json status is {protocol['status']!r}")
    min_reviewers = protocol["minimum_reviewers_per_clip"] if protocol is not None else 2
    excluded = set(protocol["excluded_case_ids"]) if protocol is not None else set()

    consent_by_release = {record["participant_release_id"]: record for record in inputs.consent}
    withdrawn_by_athlete: dict[str, str] = {}
    for record in inputs.consent:
        if record["state"] == "withdrawn":
            withdrawn_by_athlete.setdefault(record["athlete_id"], record["participant_release_id"])
    qualified = _qualified_reviewers(inputs)
    blinded = {rid for rid, reviewer in qualified.items() if "reviewer" in reviewer["roles"]}
    errors = list(inputs.errors) + _cross_record_checks(inputs, qualified)

    clips: list[_ClipState] = []
    for clip in inputs.footage:
        clip_id = clip["clip_id"]
        eligible = True
        if clip_id in excluded or clip["session_id"] in excluded:
            eligible = False
        consent = consent_by_release.get(clip["participant_release_id"])
        if consent is None:
            _missing(missing, "consented_footage", f"{clip_id}: no consent record")
            eligible = False
        elif consent["athlete_id"] != clip["athlete_id"]:
            _missing(missing, "consented_footage", f"{clip_id}: consent names another athlete")
            eligible = False
        elif consent["state"] != "active":
            _missing(missing, "consented_footage", f"{clip_id}: consent is {consent['state']}")
            eligible = False
        elif clip["athlete_id"] in withdrawn_by_athlete:
            _missing(
                missing,
                "consented_footage",
                f"{clip_id}: athlete withdrew consent under release "
                f"{withdrawn_by_athlete[clip['athlete_id']]}; a second release does not "
                "override a withdrawal",
            )
            eligible = False
        elif not (
            consent["permissions"]["product_evaluation"]
            and consent["permissions"]["internal_human_review"]
        ):
            _missing(
                missing,
                "consented_footage",
                f"{clip_id}: consent lacks product_evaluation/internal_human_review",
            )
            eligible = False
        if clip["metadata_verification"] is None:
            _missing(missing, "verified_capture_metadata", f"{clip_id}: metadata not verified")
            eligible = False
        if clip["rights"]["state"] != "cleared":
            _missing(missing, "rights_clearance", f"{clip_id}: rights {clip['rights']['state']}")
            eligible = False
        clips.append(_ClipState(clip=clip, eligible=eligible))
    if not inputs.footage:
        _missing(missing, "consented_footage", "no footage records")
        _missing(missing, "verified_capture_metadata", "no footage records")
        _missing(missing, "rights_clearance", "no footage records")

    adjudicators = {
        rid for rid, reviewer in qualified.items() if "adjudicator" in reviewer["roles"]
    }
    if len(blinded) < min_reviewers:
        _missing(
            missing,
            "qualified_blinded_reviewers",
            f"{len(blinded)} qualified reviewer(s) with the reviewer role recorded, protocol "
            f"needs {min_reviewers}",
        )
    if not adjudicators:
        _missing(missing, "qualified_blinded_reviewers", "no qualified adjudicator recorded")

    reviews_by_clip: dict[str, list[dict]] = {}
    for review in inputs.reviews:
        reviews_by_clip.setdefault(review["clip_id"], []).append(review)
    adjudication_by_clip = {record["clip_id"]: record for record in inputs.adjudications}
    prediction_by_clip = {record["clip_id"]: record for record in inputs.predictions}

    eligible_clips = [clip for clip in clips if clip.eligible]
    if not eligible_clips:
        _missing(missing, "blinded_reviews", "no eligible clips to review")
        _missing(missing, "adjudication", "no eligible clips to adjudicate")
        _missing(missing, "candidate_predictions", "no eligible clips to predict on")
    for state in eligible_clips:
        clip_id = state.clip["clip_id"]
        for review in reviews_by_clip.get(clip_id, []):
            reviewer_id = review["reviewer_id"]
            if reviewer_id not in blinded:
                _missing(
                    missing,
                    "blinded_reviews",
                    f"{clip_id}: review by {reviewer_id} is not from a qualified reviewer with "
                    "the reviewer role",
                )
                continue
            if review["outcome"] == "rated":
                state.ratings[reviewer_id] = review["quality_rating"]
            else:
                state.abstained_reviewers.append(reviewer_id)
        if clip_id not in prediction_by_clip:
            _missing(missing, "candidate_predictions", f"{clip_id}: no candidate prediction")
        usable = len(state.ratings) + len(state.abstained_reviewers)
        if usable < min_reviewers:
            _missing(
                missing,
                "blinded_reviews",
                f"{clip_id}: {usable} qualified blinded review(s), protocol needs "
                f"{min_reviewers}",
            )
            continue
        if not state.ratings:
            state.unevaluable = True
            continue
        state.disagreement = (
            len(set(state.ratings.values())) != 1 or bool(state.abstained_reviewers)
        )
        adjudication = adjudication_by_clip.get(clip_id)
        if not state.disagreement:
            state.target = next(iter(state.ratings.values()))
        elif adjudication is None:
            _missing(
                missing,
                "adjudication",
                f"{clip_id}: reviewers disagree or abstained and no adjudication exists",
            )
        else:
            state.adjudicated = True
            state.target = adjudication["resolved_rating"]

    if protocol is not None and eligible_clips:
        athletes = {clip.clip["athlete_id"] for clip in eligible_clips}
        if len(athletes) < protocol["minimum_independent_athletes"]:
            _missing(
                missing,
                "consented_footage",
                f"{len(athletes)} independent athlete(s), protocol needs "
                f"{protocol['minimum_independent_athletes']}",
            )

    missing_entries = [
        {
            "input": input_id,
            "label": spec["label"],
            "owner": spec["owner"],
            "expected_path": f"{_display_root(inputs.root)}/{spec['expected_path']}",
            "requirement": spec["description"],
            "what_is_missing": "; ".join(missing[input_id]),
        }
        for input_id, spec in MISSING_INPUT_DEFINITIONS.items()
        if input_id in missing
    ]

    if errors:
        status = "INVALID_INPUT"
    elif any(entry["owner"] == "external" for entry in missing_entries):
        status = "BLOCKED_EXTERNAL"
    elif missing_entries:
        status = "BLOCKED_INTERNAL"
    else:
        status = "COMPUTED"

    results = _compute_results(inputs, clips) if status == "COMPUTED" else None
    return {
        "schema_version": PROTOCOL_SCHEMA_VERSION,
        "inputs_root": _display_root(inputs.root),
        "inputs_root_exists": inputs.root_exists,
        "status": status,
        "numerical_release_authorized": False,
        "release_decision": "human",
        "record_counts": dict(inputs.record_counts),
        "validation_errors": errors,
        "missing_inputs": missing_entries,
        "results": results,
    }


# --------------------------------------------------------------------------- #
# Rendering and CLI
# --------------------------------------------------------------------------- #


def render_report(report: dict) -> str:
    lines = [
        f"Scientific validation protocol report ({report['schema_version']})",
        f"Inputs root: {report['inputs_root']}"
        + ("" if report["inputs_root_exists"] else " (absent)"),
        f"Status: {report['status']}",
        "Records: "
        + ", ".join(f"{name}={count}" for name, count in report["record_counts"].items()),
    ]
    if report["validation_errors"]:
        lines.append("Invalid inputs (fix at the source; nothing is inferred around them):")
        lines.extend(f"  - {error}" for error in report["validation_errors"])
    if report["missing_inputs"]:
        lines.append("Missing inputs:")
        for entry in report["missing_inputs"]:
            owner = (
                "owner must supply" if entry["owner"] == "external" else "engineering must supply"
            )
            lines.append(f"  - {entry['label']} [{entry['input']}] ({owner})")
            lines.append(f"      expected: {entry['expected_path']}")
            lines.append(f"      requires: {entry['requirement']}")
            lines.append(f"      missing:  {entry['what_is_missing']}")
    results = report["results"]
    if results is not None:
        clips = results["clips"]
        lines.append(
            f"Clips: supplied={clips['supplied']} eligible={clips['eligible']} "
            f"resolved={clips['resolved']} athletes={clips['independent_athletes']} "
            f"sessions={clips['independent_sessions']}"
        )
        agreement = results["reviewer_agreement"]
        lines.append(
            f"Reviewer agreement: exact={agreement['exact_agreement_rate']} "
            f"mean_abs_diff={agreement['mean_absolute_difference']} "
            f"adjudicated={agreement['adjudicated_clips']}"
        )
        candidate = results["candidate"]
        lines.append(
            f"Candidate: outputs={candidate['numerical_outputs']} "
            f"abstentions={candidate['abstentions']} "
            f"coverage(player-weighted)={candidate['range_coverage_player_weighted']} "
            f"mae(player-weighted)={candidate['mae_player_weighted']} "
            f"median_width={candidate['median_width']}"
        )
        lines.append("Gates (point estimates; a human ratifies or rejects):")
        for gate in results["gates"]:
            lines.append(
                f"  - {gate['id']}: {gate['verdict']} (target={gate['target']} "
                f"observed={gate['observed']})"
            )
    lines.append(
        "Numerical release authorized: no (submission and release are human decisions; "
        "this report is an input to them)"
    )
    return "\n".join(lines)


def _run_report(root: Path, as_json: bool) -> int:
    report = build_report(load_inputs(root))
    if as_json:
        print(json.dumps(report, indent=2, sort_keys=True, allow_nan=False))
    else:
        print(render_report(report))
    return 1 if report["status"] == "INVALID_INPUT" else 0


def _run_validate(kind: str, paths: list[str]) -> int:
    failures = 0
    for raw in paths:
        path = Path(raw)
        errors: list[str] = []
        doc = _read_json(path, str(path), errors)
        if doc is not _UNREADABLE:
            errors.extend(validate_record(kind, doc, str(path)))
        if errors:
            failures += 1
            for error in errors:
                print(error)
        else:
            print(f"{path}: OK")
    return 1 if failures else 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="validation_protocol.py",
        description="Scientific validation protocol: schemas, validators and report runner.",
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--report", action="store_true", help="compute or block the validation report"
    )
    mode.add_argument(
        "--validate",
        nargs="+",
        metavar=("KIND", "FILE"),
        help="validate FILE(s) as record KIND (" + "|".join(sorted(SCHEMAS)) + ")",
    )
    mode.add_argument("--schema", choices=sorted(SCHEMAS), help="print one record schema as JSON")
    parser.add_argument(
        "--inputs",
        default=None,
        help=f"inputs root for --report (default: <repo>/{DEFAULT_INPUT_ROOT})",
    )
    parser.add_argument("--json", action="store_true", help="emit the report as JSON")
    args = parser.parse_args(argv)

    if args.schema:
        print(json.dumps(SCHEMAS[args.schema], indent=2))
        return 0
    if args.validate:
        kind = args.validate[0]
        if kind not in SCHEMAS or len(args.validate) < 2:
            parser.error("--validate needs a known KIND followed by at least one FILE")
        return _run_validate(kind, args.validate[1:])
    root = REPO_ROOT / DEFAULT_INPUT_ROOT if args.inputs is None else Path(args.inputs)
    return _run_report(root, args.json)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
