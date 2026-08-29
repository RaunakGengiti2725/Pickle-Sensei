package com.picklesensei.camera

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CaptureEvidenceAccumulatorTest {
  @Test
  fun summaryUsesInclusiveMotionWindowAndCountsRealInferenceAttempts() {
    val accumulator = accumulator()
    accumulator.ingestPose(fullPose(900, visibility = 0.1))
    accumulator.ingestPose(fullPose(1_000, visibility = 0.8))
    accumulator.ingestMissing(1_050)
    accumulator.ingestPose(
      fullPose(
        timestampMs = 1_100,
        visibility = 0.8,
        missing = setOf("left_wrist"),
        visibilityOverrides = mapOf("right_ankle" to 0.2),
      ),
    )
    accumulator.ingestPose(fullPose(1_300, visibility = 0.9))
    accumulator.ingestMissing(1_400)

    val summary = requireNotNull(accumulator.summarize(event(1_000, 1_300)))

    assertEquals(1, summary.schemaVersion)
    assertEquals("detected_motion", summary.window)
    assertEquals("test_pose", summary.poseSource)
    assertEquals("pose-v1", summary.poseModelVersion)
    assertEquals("motion-v1", summary.triggerAlgorithmVersion)
    assertEquals("normalized_image_units_per_second", summary.motionUnit)
    assertEquals(4, summary.analysisInputFrameCount)
    assertEquals(3, summary.poseFrameCount)
    assertEquals(1, summary.poseMissingFrameCount)
    assertEquals(300L, summary.trackedDurationMs)
    assertEquals(28.6 / 36.0, summary.meanCanonicalJointVisibility, 0.000001)
    assertEquals(34.0 / 36.0, summary.meanJointCoverage, 0.000001)
    assertEquals(10.0 / 12.0, summary.minimumJointCoverage, 0.000001)
    assertEquals(2, summary.fullBodyVisibleFrameCount)
  }

  @Test
  fun trackedDurationUsesFirstAndLastUsablePoseInsteadOfMissingBoundaries() {
    val accumulator = accumulator()
    accumulator.ingestMissing(1_000)
    accumulator.ingestPose(sparsePose(1_050, point("left_wrist", 0.1, 0.4)))
    accumulator.ingestPose(sparsePose(1_200, point("left_wrist", 0.2, 0.4)))
    accumulator.ingestMissing(1_300)

    val summary = requireNotNull(accumulator.summarize(event(1_000, 1_300)))
    assertEquals(4, summary.analysisInputFrameCount)
    assertEquals(2, summary.poseFrameCount)
    assertEquals(2, summary.poseMissingFrameCount)
    assertEquals(150L, summary.trackedDurationMs)
  }

  @Test
  fun jointMotionIsSparseAndKeepsCanonicalOrderWithMeasuredMeanAndPeak() {
    val accumulator = accumulator()
    accumulator.ingestPose(
      sparsePose(
        1_000,
        point("left_wrist", 0.0, 0.4),
        point("right_shoulder", 0.2, 0.2),
        point("right_wrist", 0.7, 0.4),
      ),
    )
    accumulator.ingestPose(
      sparsePose(
        1_100,
        point("left_wrist", 0.1, 0.4),
        point("right_shoulder", 0.25, 0.2),
      ),
    )
    accumulator.ingestPose(
      sparsePose(
        1_200,
        point("left_wrist", 0.3, 0.4),
        point("right_shoulder", 0.3, 0.2),
      ),
    )

    val summary = requireNotNull(accumulator.summarize(event(1_000, 1_200)))
    assertEquals(listOf("right_shoulder", "left_wrist"), summary.jointMotion.map { it.joint })

    val shoulder = summary.jointMotion.first()
    assertEquals(2, shoulder.sampleCount)
    assertEquals(0.5, shoulder.meanNormalizedPerSecond, 0.000001)
    assertEquals(0.5, shoulder.peakNormalizedPerSecond, 0.000001)

    val wrist = summary.jointMotion.last()
    assertEquals(2, wrist.sampleCount)
    assertEquals(1.5, wrist.meanNormalizedPerSecond, 0.000001)
    assertEquals(2.0, wrist.peakNormalizedPerSecond, 0.000001)
  }

  @Test
  fun missingOrInvisibleJointBreaksMotionPairContinuity() {
    val accumulator = accumulator()
    accumulator.ingestPose(sparsePose(1_000, point("left_wrist", 0.1, 0.4)))
    accumulator.ingestMissing(1_050)
    accumulator.ingestPose(sparsePose(1_100, point("left_wrist", 0.5, 0.4)))
    accumulator.ingestPose(
      sparsePose(
        1_150,
        PosePoint("left_wrist", 0.7, 0.4, visibility = 0.2),
      ),
    )
    accumulator.ingestPose(sparsePose(1_200, point("left_wrist", 0.9, 0.4)))

    val summary = requireNotNull(accumulator.summarize(event(1_000, 1_200)))
    assertTrue(summary.jointMotion.isEmpty())
  }

  @Test
  fun motionPairsLongerThanTwoHundredFiftyMillisecondsAreNotMeasured() {
    val accumulator = accumulator()
    accumulator.ingestPose(sparsePose(1_000, point("left_wrist", 0.1, 0.4)))
    accumulator.ingestPose(sparsePose(1_251, point("left_wrist", 0.8, 0.4)))

    val summary = requireNotNull(accumulator.summarize(event(1_000, 1_251)))
    assertTrue(summary.jointMotion.isEmpty())
  }

  @Test
  fun resetRemovesEarlierFramesAndMotionPairs() {
    val accumulator = accumulator()
    accumulator.ingestPose(sparsePose(1_000, point("left_wrist", 0.1, 0.4)))
    accumulator.ingestPose(sparsePose(1_100, point("left_wrist", 0.3, 0.4)))
    accumulator.reset()
    accumulator.ingestPose(sparsePose(1_200, point("left_wrist", 0.5, 0.4)))

    val summary = requireNotNull(accumulator.summarize(event(1_000, 1_200)))
    assertEquals(1, summary.analysisInputFrameCount)
    assertEquals(1, summary.poseFrameCount)
    assertEquals(0L, summary.trackedDurationMs)
    assertTrue(summary.jointMotion.isEmpty())
  }

  @Test
  fun rollingRetentionDropsExpiredFramesAndEmptyWindowsAbstain() {
    val accumulator = accumulator(retentionMs = 300)
    accumulator.ingestPose(sparsePose(1_000, point("left_wrist", 0.1, 0.4)))
    accumulator.ingestMissing(1_200)
    accumulator.ingestPose(sparsePose(1_401, point("left_wrist", 0.2, 0.4)))

    assertNull(accumulator.summarize(event(1_000, 1_100)))
    val retained = accumulator.summarize(event(1_000, 1_401))
    assertNotNull(retained)
    assertEquals(2, retained?.analysisInputFrameCount)
    assertEquals(1, retained?.poseFrameCount)
    assertEquals(1, retained?.poseMissingFrameCount)
  }

  @Test
  fun normalizedEvidenceRejectsOffImageCoordinates() {
    val accumulator = accumulator()
    accumulator.ingestPose(
      sparsePose(
        1_000,
        point("left_wrist", 0.2, 0.4),
        point("right_wrist", 1.2, 0.4),
      ),
    )
    accumulator.ingestPose(
      sparsePose(
        1_100,
        point("left_wrist", 0.3, 0.4),
        point("right_wrist", 0.8, -0.1),
      ),
    )

    val summary = requireNotNull(accumulator.summarize(event(1_000, 1_100)))
    assertEquals(listOf("left_wrist"), summary.jointMotion.map { it.joint })
    assertEquals(1.0, summary.jointMotion.single().peakNormalizedPerSecond, 0.000001)
  }

  private fun accumulator(retentionMs: Long = 3_000) = CaptureEvidenceAccumulator(
    poseSource = "test_pose",
    poseModelVersion = "pose-v1",
    triggerAlgorithmVersion = "motion-v1",
    retentionMs = retentionMs,
  )

  private fun event(startMs: Long, endMs: Long) = MotionEvent(
    startMs = startMs,
    endMs = endMs,
    peakMotionMs = endMs,
    confidence = 0.8,
  )

  private fun fullPose(
    timestampMs: Long,
    visibility: Double,
    missing: Set<String> = emptySet(),
    visibilityOverrides: Map<String, Double> = emptyMap(),
  ) = PoseFrame(
    timestampMs = timestampMs,
    confidence = 0.95,
    landmarks = CaptureEvidenceAccumulator.CANONICAL_JOINTS.mapIndexedNotNull { index, joint ->
      if (joint in missing) null
      else PosePoint(
        name = joint,
        x = 0.2 + index * 0.03,
        y = 0.2 + index * 0.04,
        visibility = visibilityOverrides[joint] ?: visibility,
      )
    },
  )

  private fun sparsePose(timestampMs: Long, vararg points: PosePoint) = PoseFrame(
    timestampMs = timestampMs,
    confidence = 0.95,
    landmarks = points.toList(),
  )

  private fun point(name: String, x: Double, y: Double) = PosePoint(
    name = name,
    x = x,
    y = y,
    visibility = 0.95,
  )
}
