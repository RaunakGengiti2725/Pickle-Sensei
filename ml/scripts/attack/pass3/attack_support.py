"""Shared helpers for adversarial pass 3 on ml/ tooling (subsystem ml-tooling-datasets).

Two engines are exercised side by side:

* the executable gate ``ml/scripts/validate_annotations.py`` (stdlib only), both
  in-process via ``validate()`` and as a subprocess via its CLI; and
* a JSON Schema Draft 2020-12 engine (``jsonschema``) run over the SAME
  documents against ``ml/annotations/annotation.schema.json`` and
  ``ml/datasets/manifest.schema.json``.

Every probe records what each engine said so a divergence between the two is
visible as data, not as an interpretation.

Requires ``pip install jsonschema`` (4.x). It is deliberately NOT discovered by
the CI ML stage (``-s ml/scripts -p 'test_*.py'`` does not recurse into this
package-less directory) so the extra dependency never leaks into the gate.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import jsonschema
from jsonschema import Draft202012Validator, FormatChecker

REPO_ROOT = Path(__file__).resolve().parents[4]
ML_SCRIPTS = REPO_ROOT / "ml" / "scripts"
VALIDATOR_PATH = ML_SCRIPTS / "validate_annotations.py"
ANNOTATION_SCHEMA_PATH = REPO_ROOT / "ml" / "annotations" / "annotation.schema.json"
MANIFEST_SCHEMA_PATH = REPO_ROOT / "ml" / "datasets" / "manifest.schema.json"
REGISTRY_PATH = REPO_ROOT / "datasets" / "pickleball" / "registry.json"

EVIDENCE_DIR = Path(
    os.environ.get("ATTACK_EVIDENCE_DIR", REPO_ROOT / "artifacts" / "attack-ml-tooling-datasets-4")
)


def _load_validator_module():
    spec = importlib.util.spec_from_file_location("validate_annotations", VALIDATOR_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


validate_annotations = _load_validator_module()
validate = validate_annotations.validate
TECHNIQUES = validate_annotations.TECHNIQUES

ANNOTATION_SCHEMA: dict[str, Any] = json.loads(ANNOTATION_SCHEMA_PATH.read_text(encoding="utf-8"))
MANIFEST_SCHEMA: dict[str, Any] = json.loads(MANIFEST_SCHEMA_PATH.read_text(encoding="utf-8"))

Draft202012Validator.check_schema(ANNOTATION_SCHEMA)
Draft202012Validator.check_schema(MANIFEST_SCHEMA)

ANNOTATION_VALIDATOR = Draft202012Validator(ANNOTATION_SCHEMA, format_checker=FormatChecker())
MANIFEST_VALIDATOR = Draft202012Validator(MANIFEST_SCHEMA, format_checker=FormatChecker())


# --------------------------------------------------------------------------- docs
def attributes() -> dict[str, Any]:
    return {
        "side": "forehand",
        "spin": "flat",
        "direction": "straight",
        "origin_zone": "baseline",
        "target_zone": "baseline",
        "contact_state": "after_bounce",
        "intent": "attack",
        "rally_outcome": "in_play",
    }


def valid_doc() -> dict[str, Any]:
    """Mirror of ml/scripts/test_validate_annotations.py::valid_doc (kept identical on purpose)."""
    return {
        "clip_id": "clip-0001-forehand",
        "annotation_outcome": "recognized_technique",
        "technique": "drive_forehand",
        "attributes": attributes(),
        "handedness": "right",
        "camera_view": "dominant_side",
        "stroke_start_ms": 0,
        "stroke_end_ms": 2000,
        "phases": [
            {"key": "ready", "start_ms": 0, "end_ms": 300, "observable": True},
            {"key": "prepare", "start_ms": 300, "end_ms": 700, "observable": True},
            {"key": "accelerate", "start_ms": 700, "end_ms": 1000, "observable": True},
            {"key": "contact", "start_ms": 1000, "end_ms": 1090, "observable": True},
            {"key": "follow_through", "start_ms": 1090, "end_ms": 1400, "observable": True},
            {"key": "recover", "start_ms": 1400, "end_ms": 2000, "observable": True},
        ],
        "contact_range_ms": {"start_ms": 1000, "end_ms": 1090},
        "checkpoint_labels": [
            {
                "checkpoint": "contact_position",
                "verdict": "major_fault",
                "fault_direction": "late",
                "fault_severity": 0.6,
            }
        ],
        "acceptable_alternative_mechanics": False,
        "quality_flags": ["clean"],
        "annotator": "coach-a",
        "revision": 1,
    }


def negative_doc(outcome: str) -> dict[str, Any]:
    doc = valid_doc()
    doc["annotation_outcome"] = outcome
    doc["technique"] = None
    doc["checkpoint_labels"] = []
    return doc


def valid_manifest() -> dict[str, Any]:
    """A fully populated manifest instance. No such instance exists in the repo; the
    unittest only inspects the schema text, so this is the first executable check
    that the manifest contract is even satisfiable."""
    return {
        "dataset_id": "ds-attack-pass3-0001",
        "version": "0.0.1-attack",
        "created_at": "2026-09-04T00:00:00Z",
        "taxonomy_version": "v3",
        "annotation_schema_version": "v2",
        "consent_terms_version": "consent-2026-01",
        "withdrawal_process_version": "withdrawal-2026-01",
        "rights_reviewed_at": "2026-09-04T00:00:00Z",
        "description": "synthetic manifest INSTANCE used only to exercise the schema; references no media",
        "items": [
            {
                "clip_id": "clip-attack-0001",
                "media_sha256": "0" * 64,
                "annotation_path": "annotations/clip-attack-0001.json",
                "athlete_id": "athlete-0001",
                "athlete_group_id": "group-0001",
                "session_id": "session-0001",
                "split": "train",
                "source": "consented_first_party_capture",
                "capture_provenance": {
                    "raw_asset_id": "raw-asset-0001",
                    "recorder_or_licensor_id": "recorder-0001",
                    "recorded_at": "2026-09-01T10:00:00Z",
                    "origin_description": "first-party capture on a private court",
                    "third_party_broadcast": False,
                },
                "consent": {
                    "participant_release_id": "release-0001",
                    "terms_version": "consent-2026-01",
                    "signed_at": "2026-09-01T09:00:00Z",
                    "age_class": "adult",
                    "guardian_release_id": None,
                    "commercial_model_training": True,
                    "product_evaluation": True,
                    "derived_features": True,
                    "internal_human_review": True,
                    "withdrawal_process_version": "withdrawal-2026-01",
                    "state": "active",
                },
                "rights": {
                    "rights_holder_id": "rights-holder-0001",
                    "commercial_training_grant_id": "grant-0001",
                    "evidence_uri": "s3://rights-evidence/grant-0001.pdf",
                    "commercial_model_training_permitted": True,
                    "derived_feature_use_permitted": True,
                    "third_party_media_clearance_complete": True,
                    "bystander_clearance_complete": True,
                    "verified_by": "reviewer-0001",
                    "verified_at": "2026-09-02T00:00:00Z",
                    "state": "cleared",
                },
                "human_review": {
                    "independent_annotator_ids": ["annotator-0001", "annotator-0002"],
                    "coach_reviewer_id": "coach-0001",
                    "reviewed_at": "2026-09-03T00:00:00Z",
                    "agreement": "agreed",
                    "decision": "accepted",
                },
                "training_eligible": True,
            }
        ],
    }


# ------------------------------------------------------------------------ engines
def schema_errors(instance: Any, validator: Draft202012Validator = ANNOTATION_VALIDATOR) -> list[str]:
    return sorted(
        f"{'/'.join(str(p) for p in error.absolute_path) or '<root>'}: {error.message}"
        for error in validator.iter_errors(instance)
    )


def manifest_schema_errors(instance: Any) -> list[str]:
    return schema_errors(instance, MANIFEST_VALIDATOR)


@dataclass
class CliResult:
    exit_code: int
    stdout: str
    stderr: str
    path: str


def run_cli(raw_text: str, filename: str = "attack.json") -> CliResult:
    """Write raw JSON text to a temp file and run the validator CLI on it."""
    with tempfile.TemporaryDirectory(prefix="attack-pass3-") as tmp:
        path = Path(tmp) / filename
        path.write_text(raw_text, encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, str(VALIDATOR_PATH), str(path)],
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
            timeout=60,
        )
        return CliResult(proc.returncode, proc.stdout, proc.stderr, str(path))


def run_cli_many(docs: list[str], names: list[str]) -> CliResult:
    with tempfile.TemporaryDirectory(prefix="attack-pass3-") as tmp:
        paths = []
        for text, name in zip(docs, names):
            path = Path(tmp) / name
            path.write_text(text, encoding="utf-8")
            paths.append(str(path))
        proc = subprocess.run(
            [sys.executable, str(VALIDATOR_PATH), *paths],
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
            timeout=60,
        )
        return CliResult(proc.returncode, proc.stdout, proc.stderr, tmp)


def in_process(doc: Any, name: str = "attack") -> dict[str, Any]:
    """Run validate() and capture either its error list or the exception it raised."""
    try:
        return {"errors": validate(copy.deepcopy(doc), name), "exception": None}
    except Exception as exc:  # noqa: BLE001 - the crash IS the observation
        return {"errors": None, "exception": f"{type(exc).__name__}: {exc}"}


# ----------------------------------------------------------------------- evidence
@dataclass
class Probe:
    scenario: str
    title: str
    classification: str  # HELD | BROKEN | DESIGN
    validator: dict[str, Any] = field(default_factory=dict)
    schema: list[str] | None = None
    cli: dict[str, Any] | None = None
    note: str = ""


_PROBES: list[Probe] = []


def record(probe: Probe) -> Probe:
    _PROBES.append(probe)
    return probe


def flush_evidence(filename: str) -> Path:
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    out = EVIDENCE_DIR / filename
    payload = {
        "commit": _git_head(),
        "python": sys.version,
        "jsonschema": _jsonschema_version(),
        "probes": [asdict(p) for p in _PROBES],
    }
    out.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return out


def _git_head() -> str:
    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, cwd=REPO_ROOT, check=True
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def _jsonschema_version() -> str:
    from importlib.metadata import version

    return version("jsonschema")


__all__ = [
    "ANNOTATION_SCHEMA",
    "ANNOTATION_VALIDATOR",
    "CliResult",
    "EVIDENCE_DIR",
    "MANIFEST_SCHEMA",
    "MANIFEST_VALIDATOR",
    "Probe",
    "REGISTRY_PATH",
    "REPO_ROOT",
    "TECHNIQUES",
    "attributes",
    "flush_evidence",
    "in_process",
    "jsonschema",
    "manifest_schema_errors",
    "negative_doc",
    "record",
    "run_cli",
    "run_cli_many",
    "schema_errors",
    "valid_doc",
    "valid_manifest",
    "validate",
]
