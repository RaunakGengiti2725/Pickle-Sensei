package com.picklesensei.camera

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PoseMotionTest {
  @Test
  fun readinessRequiresSustainedRealFullBodyPose() {
    val evaluator = PoseReadinessEvaluator()
    var snapshot: ReadinessSnapshot? = null
    for (timestamp in 0L..700L step 100L) {
      snapshot = evaluator.ingest(fullPose(timestamp))
    }
    assertEquals(ReadinessState.READY, snapshot?.state)
    assertEquals(700L, snapshot?.stableForMs)
    assertEquals(1.0, snapshot?.jointCoverage ?: 0.0, 0.0001)
  }

  @Test
  fun missingPoseImmediatelyClearsReadinessEvidence() {
    val evaluator = PoseReadinessEvaluator()
    for (timestamp in 0L..700L step 100L) evaluator.ingest(fullPose(timestamp))
    val missing = evaluator.ingestMissing(800)
    assertEquals(ReadinessState.NO_PERSON, missing.state)
    assertEquals(0L, missing.stableForMs)
    assertEquals(PoseReadinessEvaluator.REQUIRED_JOINTS, missing.missingJoints)
    assertEquals(ReadinessState.HOLD_STILL, evaluator.ingest(fullPose(900)).state)
  }

  @Test
  fun temporalDetectorTriggersOnlyAfterDiscreteMotionCompletes() {
    val detector = TemporalMotionDetector()
    assertNull(detector.ingest(fullPose(0, leftWristX = 0.30)))
    assertNull(detector.ingest(fullPose(100, leftWristX = 0.32)))
    assertNull(detector.ingest(fullPose(200, leftWristX = 0.46)))
    assertNull(detector.ingest(fullPose(300, leftWristX = 0.63)))
    val event = detector.ingest(fullPose(400, leftWristX = 0.64))
    assertNotNull(event)
    assertEquals(100L, event?.startMs)
    assertEquals(400L, event?.endMs)
    assertEquals(300L, event?.peakMotionMs)
    assertTrue((event?.confidence ?: 0.0) >= 0.65)
  }

  @Test
  fun lowConfidencePoseCannotTriggerCapture() {
    val detector = TemporalMotionDetector()
    assertNull(detector.ingest(fullPose(0, leftWristX = 0.20, confidence = 0.2)))
    assertNull(detector.ingest(fullPose(300, leftWristX = 0.80, confidence = 0.2)))
  }

  @Test
  fun trailHistoryIsBoundedAndContainsMeasuredSpeedOnly() {
    val trails = PoseTrailAccumulator(
      trackedJoints = setOf("left_wrist"),
      retentionMs = 1_000,
      maximumSamplesPerJoint = 3,
    )
    trails.ingest(fullPose(0, leftWristX = 0.20))
    trails.ingest(fullPose(100, leftWristX = 0.30))
    trails.ingest(fullPose(200, leftWristX = 0.40))
    val snapshot = trails.ingest(fullPose(300, leftWristX = 0.50))

    val wrist = requireNotNull(snapshot["left_wrist"])
    assertEquals(listOf(100L, 200L, 300L), wrist.map(PoseTrailPoint::timestampMs))
    assertEquals(1.0, wrist.last().normalizedSpeedPerSecond, 0.0001)
  }

  @Test
  fun absentJointBreaksTrailBeforeReacquisition() {
    val trails = PoseTrailAccumulator(
      trackedJoints = setOf("left_wrist"),
      retentionMs = 1_000,
    )
    trails.ingest(fullPose(0, leftWristX = 0.20))
    trails.ingest(fullPose(100, leftWristX = 0.30))
    val missingWrist = fullPose(150).let { pose ->
      pose.copy(landmarks = pose.landmarks.filterNot { it.name == "left_wrist" })
    }
    assertNull(trails.ingest(missingWrist)["left_wrist"])

    val reacquired = requireNotNull(
      trails.ingest(fullPose(200, leftWristX = 0.60))["left_wrist"],
    )
    assertEquals(1, reacquired.size)
    assertEquals(0.0, reacquired.single().normalizedSpeedPerSecond, 0.0001)
  }

  @Test
  fun lowVisibilityJointBreaksTrailBeforeReacquisition() {
    val trails = PoseTrailAccumulator(
      trackedJoints = setOf("left_wrist"),
      retentionMs = 1_000,
    )
    trails.ingest(fullPose(0, leftWristX = 0.20))
    trails.ingest(fullPose(100, leftWristX = 0.30))
    val hiddenWrist = fullPose(150).let { pose ->
      pose.copy(
        landmarks = pose.landmarks.map { point ->
          if (point.name == "left_wrist") point.copy(visibility = 0.20) else point
        },
      )
    }
    assertNull(trails.ingest(hiddenWrist)["left_wrist"])

    val reacquired = requireNotNull(
      trails.ingest(fullPose(200, leftWristX = 0.60))["left_wrist"],
    )
    assertEquals(1, reacquired.size)
    assertEquals(0.0, reacquired.single().normalizedSpeedPerSecond, 0.0001)
  }

  @Test
  fun longPairGapCannotCreateAnOcclusionBridge() {
    val trails = PoseTrailAccumulator(
      trackedJoints = setOf("left_wrist"),
      retentionMs = 1_000,
      maximumPairGapMs = 250,
    )
    trails.ingest(fullPose(0, leftWristX = 0.20))
    val afterGap = requireNotNull(
      trails.ingest(fullPose(300, leftWristX = 0.80))["left_wrist"],
    )

    assertEquals(1, afterGap.size)
    assertEquals(0.0, afterGap.single().normalizedSpeedPerSecond, 0.0001)
  }

  @Test
  fun missingPoseClearsEveryTrail() {
    val trails = PoseTrailAccumulator(retentionMs = 1_000)
    assertTrue(trails.ingest(fullPose(0)).isNotEmpty())
    trails.ingestMissing(50)
    val reacquired = trails.ingest(fullPose(100))
    assertTrue(reacquired.values.all { it.size == 1 })
  }

  private fun fullPose(
    timestampMs: Long,
    leftWristX: Double = 0.30,
    confidence: Double = 0.95,
  ) = PoseFrame(
    timestampMs = timestampMs,
    confidence = confidence,
    landmarks = listOf(
      point("left_shoulder", 0.42, 0.25),
      point("right_shoulder", 0.58, 0.25),
      point("left_elbow", 0.35, 0.35),
      point("right_elbow", 0.65, 0.35),
      point("left_wrist", leftWristX, 0.45),
      point("right_wrist", 0.70, 0.45),
      point("left_hip", 0.44, 0.50),
      point("right_hip", 0.56, 0.50),
      point("left_knee", 0.43, 0.68),
      point("right_knee", 0.57, 0.68),
      point("left_ankle", 0.42, 0.85),
      point("right_ankle", 0.58, 0.85),
    ),
  )

  private fun point(name: String, x: Double, y: Double) =
    PosePoint(name, x, y, visibility = 0.95)
}
