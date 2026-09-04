#!/usr/bin/env python3
"""Adversarial pass 3 / tester #4 — ml/scripts/validate_annotations.py vs the JSON contracts.

Run from the repository root (needs `pip install jsonschema`):

  python3 -m unittest discover -s ml/scripts/attack/pass3 -p 'test_*.py' -v

Convention (same as the other attack branches): tests named ``HELD`` assert the
correct behaviour and pass today. Tests decorated ``@unittest.expectedFailure``
and named ``BROKEN`` are reproductions of findings against 4d812e1a — they
assert the CORRECT behaviour, so they show as "expected failure" while the
defect is present and flip to "unexpected success" once production is fixed
(then drop the decorator). Nothing here weakens or replaces the CI suite in
ml/scripts/test_validate_annotations.py.

Each probe is also recorded to
``artifacts/attack-ml-tooling-datasets-4/validator_probes.json`` (override with
ATTACK_EVIDENCE_DIR) with what BOTH engines said.
"""

from __future__ import annotations

import copy
import json
import unittest

from attack_support import (
    Probe,
    flush_evidence,
    in_process,
    manifest_schema_errors,
    negative_doc,
    record,
    run_cli,
    run_cli_many,
    schema_errors,
    valid_doc,
    valid_manifest,
)


def _cli_dict(result) -> dict:
    return {"exit_code": result.exit_code, "stdout": result.stdout.strip(), "stderr_tail": result.stderr[-400:]}


class S1DuplicateTopLevelKeys(unittest.TestCase):
    """Scenario 1: duplicate top-level 'technique' keys; json.load keeps the LAST value."""

    def test_HELD_last_duplicate_wins_and_an_invalid_last_value_is_rejected(self):
        raw = json.dumps(valid_doc())
        raw_last_bogus = raw[:-1] + ', "technique": "bogus_shot"}'
        result = run_cli(raw_last_bogus)
        record(
            Probe(
                "S1", "duplicate technique key, last=bogus", "HELD",
                cli=_cli_dict(result), note="json.loads keeps the last duplicate; validator sees 'bogus_shot'",
            )
        )
        self.assertEqual(result.exit_code, 1)
        self.assertIn("unknown canonical technique 'bogus_shot'", result.stdout)

    @unittest.expectedFailure
    def test_BROKEN_duplicate_keys_with_a_valid_last_value_should_be_rejected(self):
        """P3: a file whose FIRST technique is 'bogus_shot' and whose LAST is canonical validates 'ok'.

        Neither engine sees the first value (json.load/jsonschema both use dict semantics), so a
        hand-edited or tool-merged annotation with conflicting duplicate keys passes silently. The
        validator could reject duplicates with json.loads(..., object_pairs_hook=...)."""
        raw = json.dumps(valid_doc())
        raw_first_bogus = '{"technique": "bogus_shot", ' + raw[1:]
        result = run_cli(raw_first_bogus)
        parsed = json.loads(raw_first_bogus)
        record(
            Probe(
                "S1", "duplicate technique key, first=bogus last=canonical", "BROKEN",
                validator=in_process(parsed), schema=schema_errors(parsed), cli=_cli_dict(result),
                note="both engines only ever see the final value; the conflicting first value is dropped silently",
            )
        )
        self.assertEqual(result.exit_code, 1, result.stdout)

    def test_HELD_duplicate_nested_attribute_key_last_value_is_what_gets_checked(self):
        raw = json.dumps(valid_doc()).replace('"side": "forehand"', '"side": "forehand", "side": "bogus"')
        result = run_cli(raw)
        record(Probe("S1", "duplicate attributes.side key, last=bogus", "HELD", cli=_cli_dict(result)))
        self.assertEqual(result.exit_code, 1)
        self.assertIn("attributes.side has unknown value 'bogus'", result.stdout)


class S2CheckpointLabelExtraKey(unittest.TestCase):
    """Scenario 2: checkpoint label carrying an extra key 'severity' (F2 divergence)."""

    def test_HELD_schema_rejects_additional_checkpoint_property(self):
        doc = valid_doc()
        doc["checkpoint_labels"][0]["severity"] = 0.5
        errors = schema_errors(doc)
        self.assertTrue(any("'severity' was unexpected" in e for e in errors), errors)

    @unittest.expectedFailure
    def test_BROKEN_validator_must_reject_unknown_checkpoint_label_keys(self):
        """P2: validate() never checks checkpoint-label keys, so a typo such as `severity`
        instead of `fault_severity` passes and the severity is silently lost."""
        doc = valid_doc()
        doc["checkpoint_labels"][0]["severity"] = 0.5
        del doc["checkpoint_labels"][0]["fault_severity"]
        probe = record(
            Probe(
                "S2", "checkpoint label with extra key 'severity' (typo of fault_severity)", "BROKEN",
                validator=in_process(doc), schema=schema_errors(doc), cli=_cli_dict(run_cli(json.dumps(doc))),
                note="validator ok, schema INVALID (additionalProperties=false at checkpoint_labels/items)",
            )
        )
        self.assertNotEqual(probe.validator["errors"], [])

    @unittest.expectedFailure
    def test_BROKEN_validator_must_enforce_note_maxLength_500(self):
        """P3: schema caps checkpoint_labels[].note at 500 chars; validator accepts any length."""
        doc = valid_doc()
        doc["checkpoint_labels"][0]["note"] = "n" * 501
        probe = record(
            Probe("S2", "checkpoint note of 501 chars", "BROKEN", validator=in_process(doc), schema=schema_errors(doc))
        )
        self.assertNotEqual(probe.validator["errors"], [])


class S3OneMillisecondWindows(unittest.TestCase):
    """Scenario 3: stroke [0,1), single ready phase [0,1], contact_range {0,1}."""

    def _doc(self):
        doc = valid_doc()
        doc["stroke_start_ms"] = 0
        doc["stroke_end_ms"] = 1
        doc["phases"] = [{"key": "ready", "start_ms": 0, "end_ms": 1, "observable": True}]
        doc["contact_range_ms"] = {"start_ms": 0, "end_ms": 1}
        return doc

    def test_HELD_one_ms_stroke_window_is_accepted_by_both_engines(self):
        doc = self._doc()
        probe = record(Probe("S3", "1 ms stroke window with 1 ms phase and contact", "HELD", validator=in_process(doc), schema=schema_errors(doc)))
        self.assertEqual(probe.validator["errors"], [])
        self.assertEqual(probe.schema, [])

    def test_HELD_zero_length_stroke_window_is_rejected(self):
        doc = self._doc()
        doc["stroke_end_ms"] = 0
        doc["phases"][0]["end_ms"] = 0
        doc["contact_range_ms"] = {"start_ms": 0, "end_ms": 0}
        probe = record(Probe("S3", "0 ms stroke window", "HELD", validator=in_process(doc), schema=schema_errors(doc)))
        self.assertTrue(any("0 <= stroke_start_ms < stroke_end_ms" in e for e in probe.validator["errors"]))

    def test_HELD_phase_and_contact_one_ms_past_the_window_are_rejected(self):
        doc = self._doc()
        doc["phases"][0]["end_ms"] = 2
        errs = in_process(doc)["errors"]
        self.assertTrue(any("inside the stroke window" in e for e in errs), errs)
        doc = self._doc()
        doc["contact_range_ms"] = {"start_ms": 1, "end_ms": 2}
        errs = in_process(doc)["errors"]
        self.assertTrue(any("contact_range_ms must be inside the stroke window" in e for e in errs), errs)

    def test_DESIGN_zero_length_phase_spans_are_accepted(self):
        """Observation, not a finding: `start_ms <= end_ms` admits a zero-duration phase and a
        zero-width contact instant. Both engines agree; the contract text does not forbid it."""
        doc = self._doc()
        doc["phases"][0]["end_ms"] = 0
        doc["contact_range_ms"] = {"start_ms": 1, "end_ms": 1}
        probe = record(Probe("S3", "zero-length phase [0,0] and contact instant {1,1}", "DESIGN", validator=in_process(doc), schema=schema_errors(doc)))
        self.assertEqual(probe.validator["errors"], [])
        self.assertEqual(probe.schema, [])

    def test_HELD_negative_and_float_boundaries_are_rejected(self):
        doc = self._doc()
        doc["stroke_start_ms"] = -1
        self.assertTrue(in_process(doc)["errors"])
        doc = self._doc()
        doc["stroke_end_ms"] = 1.0
        self.assertTrue(in_process(doc)["errors"], "float end_ms must not count as an integer")


class S4ManifestDuplicateAnnotators(unittest.TestCase):
    """Scenario 4: human_review.independent_annotator_ids with two identical strings."""

    def test_HELD_a_fully_populated_manifest_instance_satisfies_the_schema(self):
        errors = manifest_schema_errors(valid_manifest())
        record(Probe("S4", "baseline manifest instance", "HELD", schema=errors))
        self.assertEqual(errors, [])

    def test_HELD_duplicate_annotator_ids_are_rejected_by_uniqueItems(self):
        manifest = valid_manifest()
        manifest["items"][0]["human_review"]["independent_annotator_ids"] = ["annotator-0001", "annotator-0001"]
        errors = manifest_schema_errors(manifest)
        record(Probe("S4", "two identical annotator ids", "HELD", schema=errors))
        self.assertTrue(any("non-unique elements" in e for e in errors), errors)

    def test_HELD_single_annotator_is_rejected_by_minItems(self):
        manifest = valid_manifest()
        manifest["items"][0]["human_review"]["independent_annotator_ids"] = ["annotator-0001"]
        errors = manifest_schema_errors(manifest)
        self.assertTrue(any("is too short" in e for e in errors), errors)

    def test_DESIGN_annotator_may_equal_the_coach_reviewer(self):
        """Observation: nothing forbids an independent annotator also being the adjudicating coach."""
        manifest = valid_manifest()
        manifest["items"][0]["human_review"]["independent_annotator_ids"] = ["coach-0001", "annotator-0002"]
        errors = manifest_schema_errors(manifest)
        record(Probe("S4", "annotator id == coach_reviewer_id", "DESIGN", schema=errors))
        self.assertEqual(errors, [])


class S5ManifestLicensedMediaRights(unittest.TestCase):
    """Scenario 5: licensed_media whose commercial-training permission is false."""

    def test_HELD_licensed_media_with_all_grants_true_is_accepted(self):
        manifest = valid_manifest()
        manifest["items"][0]["source"] = "licensed_media"
        self.assertEqual(manifest_schema_errors(manifest), [])

    def test_HELD_commercial_model_training_permitted_false_is_rejected(self):
        manifest = valid_manifest()
        manifest["items"][0]["source"] = "licensed_media"
        manifest["items"][0]["rights"]["commercial_model_training_permitted"] = False
        errors = manifest_schema_errors(manifest)
        record(Probe("S5", "licensed_media + commercial_model_training_permitted=false", "HELD", schema=errors))
        self.assertTrue(any("commercial_model_training_permitted: True was expected" in e for e in errors), errors)

    def test_HELD_misspelled_permission_key_is_rejected_as_additional_property(self):
        manifest = valid_manifest()
        manifest["items"][0]["source"] = "licensed_media"
        manifest["items"][0]["rights"]["commercial_training_permitted"] = False
        errors = manifest_schema_errors(manifest)
        record(Probe("S5", "licensed_media + misspelled commercial_training_permitted=false", "HELD", schema=errors))
        self.assertTrue(any("'commercial_training_permitted' was unexpected" in e for e in errors), errors)

    def test_HELD_every_boolean_gate_is_a_const_true(self):
        for key in (
            "derived_feature_use_permitted",
            "third_party_media_clearance_complete",
            "bystander_clearance_complete",
        ):
            with self.subTest(key=key):
                manifest = valid_manifest()
                manifest["items"][0]["rights"][key] = False
                self.assertTrue(manifest_schema_errors(manifest))
        for key in ("commercial_model_training", "product_evaluation", "derived_features", "internal_human_review"):
            with self.subTest(key=key):
                manifest = valid_manifest()
                manifest["items"][0]["consent"][key] = False
                self.assertTrue(manifest_schema_errors(manifest))
        manifest = valid_manifest()
        manifest["items"][0]["training_eligible"] = False
        self.assertTrue(manifest_schema_errors(manifest))
        manifest = valid_manifest()
        manifest["items"][0]["capture_provenance"]["third_party_broadcast"] = True
        self.assertTrue(manifest_schema_errors(manifest))

    def test_HELD_minor_without_guardian_release_is_rejected(self):
        manifest = valid_manifest()
        manifest["items"][0]["consent"]["age_class"] = "minor"
        self.assertTrue(manifest_schema_errors(manifest))
        manifest["items"][0]["consent"]["guardian_release_id"] = "guardian-0001"
        self.assertEqual(manifest_schema_errors(manifest), [])

    def test_HELD_synthetic_source_is_rejected(self):
        manifest = valid_manifest()
        manifest["items"][0]["source"] = "synthetic"
        self.assertTrue(manifest_schema_errors(manifest))

    def test_HELD_split_vocabulary_is_closed(self):
        manifest = valid_manifest()
        manifest["items"][0]["split"] = "holdout"
        self.assertTrue(manifest_schema_errors(manifest))

    def test_DESIGN_manifest_schema_cannot_see_cross_item_athlete_group_leakage(self):
        """Observation (the README's rule 6 is not machine-checked anywhere in ml/): the same
        athlete_group_id in `train` and `locked_holdout` items is schema-valid, and no script in
        ml/scripts validates manifests at all."""
        manifest = valid_manifest()
        leaked = copy.deepcopy(manifest["items"][0])
        leaked["clip_id"] = "clip-attack-0002"
        leaked["split"] = "locked_holdout"
        manifest["items"].append(leaked)
        errors = manifest_schema_errors(manifest)
        record(
            Probe(
                "S5", "same athlete_group_id + session_id + media_sha256 in train AND locked_holdout", "DESIGN",
                schema=errors, note="schema-valid; no executable split-leakage check exists in ml/",
            )
        )
        self.assertEqual(errors, [])


class S6PartialWithNullTechniqueAndCheckpointLabels(unittest.TestCase):
    """Scenario 6: partial + technique null + technique-specific checkpoint labels."""

    def test_DESIGN_partial_null_technique_with_checkpoint_labels_is_accepted_by_both_engines(self):
        doc = negative_doc("partial")
        doc["checkpoint_labels"] = valid_doc()["checkpoint_labels"]
        probe = record(
            Probe(
                "S6", "partial + technique=null + checkpoint_labels", "DESIGN",
                validator=in_process(doc), schema=schema_errors(doc),
                note=(
                    "Both engines accept. The validator's own message for unknown_technique/no_stroke calls "
                    "checkpoint labels 'technique-specific', which makes labels without a technique "
                    "contradictory under the same reasoning; but ml/README frames partial as a first-class "
                    "outcome and the contract text is silent, so this is recorded as a design question, not a bug."
                ),
            )
        )
        self.assertEqual(probe.validator["errors"], [])
        self.assertEqual(probe.schema, [])

    def test_HELD_unknown_technique_and_no_stroke_reject_checkpoint_labels(self):
        for outcome in ("unknown_technique", "no_stroke"):
            doc = negative_doc(outcome)
            doc["checkpoint_labels"] = valid_doc()["checkpoint_labels"]
            errs = in_process(doc)["errors"]
            self.assertTrue(any("cannot carry technique-specific checkpoint labels" in e for e in errs), errs)
            self.assertTrue(schema_errors(doc))

    def test_DESIGN_partial_and_aborted_may_also_keep_a_technique(self):
        for outcome in ("partial", "aborted"):
            doc = valid_doc()
            doc["annotation_outcome"] = outcome
            self.assertEqual(in_process(doc)["errors"], [])
            self.assertEqual(schema_errors(doc), [])


class S7UnknownTechniqueWithAssertedAttributes(unittest.TestCase):
    """Scenario 7: unknown_technique with every orthogonal attribute asserted and full phases."""

    def test_DESIGN_abstention_from_technique_does_not_forbid_attribute_or_phase_assertions(self):
        doc = negative_doc("unknown_technique")  # attributes fully asserted, 6 phases, contact range kept
        probe = record(
            Probe(
                "S7", "unknown_technique + all attributes asserted + 6 phases + contact", "DESIGN",
                validator=in_process(doc), schema=schema_errors(doc),
                note=(
                    "Accepted by both engines. Decision: this is consistent with the contract — attributes are "
                    "explicitly ORTHOGONAL to technique (ml/README 'Canonical labels') and a side/spin/zone can be "
                    "observed without naming a class. Only no_stroke nulls attributes. Not a finding."
                ),
            )
        )
        self.assertEqual(probe.validator["errors"], [])
        self.assertEqual(probe.schema, [])

    def test_HELD_unknown_technique_still_requires_a_real_stroke_window(self):
        doc = negative_doc("unknown_technique")
        doc["stroke_start_ms"] = None
        doc["stroke_end_ms"] = None
        doc["phases"] = []
        doc["contact_range_ms"] = None
        self.assertTrue(in_process(doc)["errors"])
        self.assertTrue(schema_errors(doc))


class S8ClipIdShape(unittest.TestCase):
    """Scenario 8: clip_id 'abc' — validator ok, schema INVALID (minLength 8)."""

    def test_HELD_schema_rejects_short_clip_id(self):
        doc = valid_doc()
        doc["clip_id"] = "abc"
        self.assertTrue(any("'abc' is too short" in e for e in schema_errors(doc)))

    @unittest.expectedFailure
    def test_BROKEN_validator_cli_must_reject_clip_id_abc(self):
        """P2 (F2 divergence): validate() never looks at clip_id; 'abc' prints `ok`."""
        doc = valid_doc()
        doc["clip_id"] = "abc"
        result = run_cli(json.dumps(doc))
        record(
            Probe(
                "S8", "clip_id 'abc'", "BROKEN", validator=in_process(doc), schema=schema_errors(doc), cli=_cli_dict(result),
                note="validator exit 0 / 'ok'; Draft 2020-12 rejects (minLength 8)",
            )
        )
        self.assertEqual(result.exit_code, 1, result.stdout)

    @unittest.expectedFailure
    def test_BROKEN_validator_must_require_clip_id_to_be_a_string(self):
        """P2: null / int / list / object clip_id all validate `ok` — a record with no usable identity."""
        for clip_id in (None, 7, ["a"], {"x": 1}, ""):
            doc = valid_doc()
            doc["clip_id"] = clip_id
            probe = record(Probe("S8", f"clip_id {clip_id!r}", "BROKEN", validator=in_process(doc), schema=schema_errors(doc)))
            self.assertTrue(probe.schema, f"schema must reject {clip_id!r}")
            self.assertNotEqual(probe.validator["errors"], [], f"validator accepted clip_id={clip_id!r}")


class S9FaultSeverityFloatEdges(unittest.TestCase):
    """Scenario 9: fault_severity 1.0000001 and -0.0 on the strict [0,1] range."""

    def _with(self, severity):
        doc = valid_doc()
        doc["checkpoint_labels"][0]["fault_severity"] = severity
        return doc

    def test_HELD_one_plus_epsilon_is_rejected_by_both_engines(self):
        doc = self._with(1.0000001)
        probe = record(Probe("S9", "fault_severity 1.0000001", "HELD", validator=in_process(doc), schema=schema_errors(doc)))
        self.assertTrue(any("[0,1]" in e for e in probe.validator["errors"]))
        self.assertTrue(any("greater than the maximum of 1" in e for e in probe.schema))

    def test_HELD_negative_zero_is_accepted_as_zero_by_both_engines(self):
        doc = self._with(-0.0)
        probe = record(Probe("S9", "fault_severity -0.0", "HELD", validator=in_process(doc), schema=schema_errors(doc)))
        self.assertEqual(probe.validator["errors"], [])
        self.assertEqual(probe.schema, [])
        raw = json.dumps(valid_doc()).replace("0.6", "-0.0")
        self.assertEqual(run_cli(raw).exit_code, 0)

    def test_HELD_negative_denormal_and_exact_bounds(self):
        self.assertTrue(in_process(self._with(-1e-300))["errors"])
        self.assertEqual(in_process(self._with(0))["errors"], [])
        self.assertEqual(in_process(self._with(1))["errors"], [])
        self.assertEqual(in_process(self._with(1.0))["errors"], [])

    def test_HELD_bool_and_string_severity_are_rejected(self):
        self.assertTrue(in_process(self._with(True))["errors"])
        self.assertTrue(in_process(self._with("0.5"))["errors"])

    def test_HELD_non_standard_NaN_and_Infinity_literals_are_rejected_by_the_cli(self):
        """Python's json.loads accepts the non-JSON literals NaN/Infinity; the range check must still fail."""
        for literal in ("NaN", "Infinity", "-Infinity"):
            result = run_cli(json.dumps(valid_doc()).replace("0.6", literal))
            record(Probe("S9", f"fault_severity {literal}", "HELD", cli=_cli_dict(result)))
            self.assertEqual(result.exit_code, 1, literal)
            self.assertIn("fault_severity must be within [0,1]", result.stdout)

    def test_DESIGN_jsonschema_engine_accepts_NaN_severity(self):
        """Observation about the reference engine, not production: NaN compares false to both bounds, so
        Draft 2020-12 minimum/maximum do not reject it. The stdlib validator is stricter here."""
        doc = self._with(float("nan"))
        self.assertEqual(schema_errors(doc), [])


class X1UnhashableValuesCrashTheValidator(unittest.TestCase):
    """Extra: JSON arrays/objects where a scalar enum is expected raise TypeError out of validate()."""

    CASES = [
        ("quality_flags", [["clean"]]),
        ("annotation_outcome", ["recognized_technique"]),
        ("technique", ["drive_forehand"]),
        ("handedness", {"a": 1}),
        ("camera_view", [1]),
    ]

    @unittest.expectedFailure
    def test_BROKEN_top_level_enum_fields_holding_arrays_or_objects_must_yield_INVALID_not_a_traceback(self):
        """P2: `value not in <set>` / `set(list_of_lists)` raise TypeError (validate_annotations.py:174,176,184,186,313)."""
        for field, value in self.CASES:
            doc = valid_doc()
            doc[field] = value
            probe = record(Probe("X1", f"{field} = {value!r}", "BROKEN", validator=in_process(doc), schema=schema_errors(doc)))
            self.assertIsNone(probe.validator["exception"], f"{field}: {probe.validator['exception']}")

    @unittest.expectedFailure
    def test_BROKEN_nested_enum_fields_holding_arrays_must_yield_INVALID_not_a_traceback(self):
        """P2: attributes.<key> (line 208), checkpoint (291), verdict (294), fault_direction (297)."""
        docs = []
        doc = valid_doc(); doc["attributes"]["side"] = ["forehand"]; docs.append(("attributes.side", doc))
        doc = valid_doc(); doc["checkpoint_labels"][0]["checkpoint"] = ["contact_position"]; docs.append(("checkpoint", doc))
        doc = valid_doc(); doc["checkpoint_labels"][0]["verdict"] = ["good"]; docs.append(("verdict", doc))
        doc = valid_doc(); doc["checkpoint_labels"][0]["fault_direction"] = ["late"]; docs.append(("fault_direction", doc))
        for label, doc in docs:
            probe = record(Probe("X1", f"{label} = list", "BROKEN", validator=in_process(doc), schema=schema_errors(doc)))
            self.assertIsNone(probe.validator["exception"], f"{label}: {probe.validator['exception']}")

    def test_HELD_phase_key_as_list_is_reported_not_crashed(self):
        doc = valid_doc()
        doc["phases"][0]["key"] = ["ready"]
        probe = in_process(doc)
        self.assertIsNone(probe["exception"])
        self.assertTrue(any("unknown phase key" in e for e in probe["errors"]))

    @unittest.expectedFailure
    def test_BROKEN_cli_batch_must_report_every_file_even_when_one_crashes_the_validator(self):
        """P2: main() does not catch the TypeError, so the batch aborts with a traceback and the
        remaining files are never reported (exit code is 1, so this is not a false pass — but
        a valid file after a malformed one gets no `ok`/`INVALID` line at all)."""
        bad = valid_doc()
        bad["quality_flags"] = [["clean"]]
        result = run_cli_many([json.dumps(bad), json.dumps(valid_doc())], ["a_bad.json", "b_good.json"])
        record(Probe("X1", "CLI batch: crashing file followed by a valid file", "BROKEN", cli=_cli_dict(result)))
        self.assertEqual(result.exit_code, 1)
        self.assertNotIn("Traceback", result.stderr)
        self.assertIn("b_good.json", result.stdout)


class X2CheckpointLabelSemantics(unittest.TestCase):
    """Extra: contradictory / duplicate checkpoint labels accepted by both engines."""

    @unittest.expectedFailure
    def test_BROKEN_duplicate_checkpoint_with_contradictory_verdicts_must_be_rejected(self):
        """P2 (label handling): two labels for the same checkpoint, `good` and `major_fault` severity 1,
        validate `ok` in both engines. Phases and quality_flags are de-duplicated; checkpoints are not."""
        doc = valid_doc()
        doc["checkpoint_labels"] = [
            {"checkpoint": "contact_position", "verdict": "good"},
            {"checkpoint": "contact_position", "verdict": "major_fault", "fault_direction": "late", "fault_severity": 1},
        ]
        probe = record(Probe("X2", "duplicate checkpoint, good vs major_fault", "BROKEN", validator=in_process(doc), schema=schema_errors(doc)))
        self.assertNotEqual(probe.validator["errors"], [])

    def test_DESIGN_good_verdict_may_carry_fault_direction_and_severity(self):
        doc = valid_doc()
        doc["checkpoint_labels"] = [{"checkpoint": "contact_position", "verdict": "good", "fault_direction": "late", "fault_severity": 0.9}]
        probe = record(Probe("X2", "verdict good + fault_direction late + severity 0.9", "DESIGN", validator=in_process(doc), schema=schema_errors(doc)))
        self.assertEqual(probe.validator["errors"], [])
        doc["checkpoint_labels"] = [{"checkpoint": "contact_position", "verdict": "unobservable", "fault_severity": 0.9}]
        probe = record(Probe("X2", "verdict unobservable + severity 0.9", "DESIGN", validator=in_process(doc), schema=schema_errors(doc)))
        self.assertEqual(probe.validator["errors"], [])

    def test_DESIGN_fault_with_direction_none_is_accepted(self):
        doc = valid_doc()
        doc["checkpoint_labels"] = [{"checkpoint": "contact_position", "verdict": "major_fault", "fault_direction": "none"}]
        self.assertEqual(in_process(doc)["errors"], [])

    def test_HELD_empty_label_object_is_reported(self):
        doc = valid_doc()
        doc["checkpoint_labels"] = [{}]
        errs = in_process(doc)["errors"]
        self.assertTrue(any("unknown checkpoint" in e for e in errs) and any("unknown verdict" in e for e in errs))


class X3OptionalFieldsAreNotValidated(unittest.TestCase):
    @unittest.expectedFailure
    def test_BROKEN_optional_fields_must_be_shape_checked(self):
        """P2 (F2 divergence): player_bbox {'x': 5}, pose_keyframes 'nope', court_keypoints 7,
        primary_coaching_priority 3 all validate `ok`; the schema rejects each one."""
        doc = valid_doc()
        doc["player_bbox"] = {"x": 5}
        doc["pose_keyframes"] = "nope"
        doc["court_keypoints"] = 7
        doc["primary_coaching_priority"] = 3
        probe = record(Probe("X3", "malformed optional fields", "BROKEN", validator=in_process(doc), schema=schema_errors(doc)))
        self.assertEqual(len(probe.schema), 4)
        self.assertNotEqual(probe.validator["errors"], [])

    def test_HELD_unknown_top_level_field_is_rejected(self):
        doc = valid_doc()
        doc["severity"] = 1
        self.assertTrue(any("unknown field 'severity'" in e for e in in_process(doc)["errors"]))


class X4CrossFieldConsistency(unittest.TestCase):
    def test_DESIGN_technique_side_contradiction_is_not_checked(self):
        """Observation: technique drive_backhand with attributes.side forehand, and overhead_smash with
        contact_state after_bounce, pass both engines. No cross-field rule exists in the contract."""
        doc = valid_doc()
        doc["technique"] = "drive_backhand"
        probe = record(Probe("X4", "technique drive_backhand + side forehand", "DESIGN", validator=in_process(doc), schema=schema_errors(doc)))
        self.assertEqual(probe.validator["errors"], [])
        doc = valid_doc()
        doc["technique"] = "overhead_smash"
        self.assertEqual(in_process(doc)["errors"], [])

    def test_DESIGN_contact_range_outside_the_contact_phase_is_accepted(self):
        doc = valid_doc()
        doc["contact_range_ms"] = {"start_ms": 0, "end_ms": 1}  # contact phase is [1000,1090]
        probe = record(Probe("X4", "contact_range {0,1} while contact phase is [1000,1090]", "DESIGN", validator=in_process(doc), schema=schema_errors(doc)))
        self.assertEqual(probe.validator["errors"], [])

    def test_DESIGN_whitespace_only_annotator_is_accepted(self):
        doc = valid_doc()
        doc["annotator"] = "  "
        probe = record(Probe("X4", "annotator '  '", "DESIGN", validator=in_process(doc), schema=schema_errors(doc)))
        self.assertEqual(probe.validator["errors"], [])
        self.assertEqual(probe.schema, [])


class X5EncodingAndTypeEdges(unittest.TestCase):
    def test_HELD_utf8_bom_is_reported_as_unreadable_not_crashed(self):
        result = run_cli("\ufeff" + json.dumps(valid_doc()))
        record(Probe("X5", "UTF-8 BOM prefix", "HELD", cli=_cli_dict(result)))
        self.assertEqual(result.exit_code, 1)
        self.assertIn("unreadable", result.stdout)
        self.assertNotIn("Traceback", result.stderr)

    def test_HELD_non_object_documents_are_reported(self):
        for raw in ("[]", "null", "42", '"x"'):
            result = run_cli(raw)
            self.assertEqual(result.exit_code, 1, raw)
            self.assertIn("annotation must be a JSON object", result.stdout)

    def test_HELD_unicode_confusable_technique_is_rejected(self):
        doc = valid_doc()
        doc["technique"] = "driv\u0435_forehand"  # Cyrillic ie
        self.assertTrue(in_process(doc)["errors"])

    def test_HELD_bool_is_not_an_integer_and_float_is_not_an_integer(self):
        doc = valid_doc()
        doc["revision"] = True
        self.assertTrue(in_process(doc)["errors"])
        doc = valid_doc()
        doc["revision"] = 1.0
        self.assertTrue(in_process(doc)["errors"], "validator is stricter than Draft 2020-12 here (1.0 is a schema integer)")

    def test_HELD_huge_integers_do_not_crash(self):
        doc = valid_doc()
        doc["stroke_end_ms"] = 10**40
        doc["phases"][-1]["end_ms"] = 10**40
        probe = in_process(doc)
        self.assertIsNone(probe["exception"])
        self.assertEqual(probe["errors"], [])

    def test_HELD_missing_file_and_directory_paths_are_reported(self):
        import subprocess, sys, tempfile
        from attack_support import REPO_ROOT, VALIDATOR_PATH

        with tempfile.TemporaryDirectory() as tmp:
            proc = subprocess.run(
                [sys.executable, str(VALIDATOR_PATH), tmp, f"{tmp}/nope.json"], capture_output=True, text=True, cwd=REPO_ROOT
            )
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(proc.stdout.count("INVALID"), 2)
        self.assertNotIn("Traceback", proc.stderr)

    def test_HELD_no_arguments_exits_1(self):
        import subprocess, sys
        from attack_support import REPO_ROOT, VALIDATOR_PATH

        proc = subprocess.run([sys.executable, str(VALIDATOR_PATH)], capture_output=True, text=True, cwd=REPO_ROOT)
        self.assertEqual(proc.returncode, 1)


def tearDownModule():
    print(f"\nevidence: {flush_evidence('validator_probes.json')}")


if __name__ == "__main__":
    unittest.main()
