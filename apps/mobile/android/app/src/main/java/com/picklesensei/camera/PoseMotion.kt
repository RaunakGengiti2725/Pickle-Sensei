package com.picklesensei.camera

import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

internal data class PosePoint(
  val name: String,
  val x: Double,
  val y: Double,
  val visibility: Double,
)

internal data class PoseFrame(
  val timestampMs: Long,
  val landmarks: List<PosePoint>,
  val confidence: Double,
)

internal enum class ReadinessState(val wireValue: String) {
  NO_PERSON("no_person"),
  FULL_BODY_REQUIRED("full_body_required"),
  MOVE_CLOSER("move_closer"),
  MOVE_FARTHER("move_farther"),
  HOLD_STILL("hold_still"),
  READY("ready"),
}

internal data class ReadinessSnapshot(
  val state: ReadinessState,
  val timestampMs: Long,
  val poseConfidence: Double,
  val jointCoverage: Double,
  val stableForMs: Long,
  val missingJoints: List<String>,
  val landmarks: List<PosePoint>,
) {
  val isReady: Boolean get() = state == ReadinessState.READY
}

/** The four user-visible phases of the automatic guided-capture loop. */
internal enum class CaptureOverlayPhase {
  POSITIONING,
  BODY_LOCKED,
  CAPTURED,
  SAVING,
}

internal data class PoseTrailPoint(
  val timestampMs: Long,
  val x: Double,
  val y: Double,
  /** Measured in normalized image units per second, never physical speed. */
  val normalizedSpeedPerSecond: Double,
)

/**
 * Keeps a small, short-lived history of observed pose points for the live
 * overlay. Missing or low-visibility joints are cleared immediately, so the
 * rendered path can never imply motion that MediaPipe did not observe.
 */
internal class PoseTrailAccumulator(
  private val trackedJoints: Set<String> = DEFAULT_TRACKED_JOINTS,
  private val minimumVisibility: Double = 0.35,
  private val retentionMs: Long = 480,
  private val maximumSamplesPerJoint: Int = 8,
  private val maximumPairGapMs: Long = 250,
) {
  private val samplesByJoint = mutableMapOf<String, ArrayDeque<PoseTrailPoint>>()
  private var latestTimestampMs: Long? = null

  init {
    require(retentionMs > 0)
    require(maximumSamplesPerJoint >= 2)
    require(maximumPairGapMs > 0)
  }

  fun ingest(pose: PoseFrame): Map<String, List<PoseTrailPoint>> {
    val latest = latestTimestampMs
    if (latest != null && pose.timestampMs <= latest) return snapshot()
    latestTimestampMs = pose.timestampMs

    val visible = pose.landmarks
      .asSequence()
      .filter { point ->
        point.name in trackedJoints &&
          point.visibility.isFinite() &&
          point.visibility >= minimumVisibility &&
          point.x.isFinite() &&
          point.y.isFinite() &&
          point.x in 0.0..1.0 &&
          point.y in 0.0..1.0
      }
      .associateBy(PosePoint::name)

    for (joint in trackedJoints) {
      val point = visible[joint]
      if (point == null) {
        samplesByJoint.remove(joint)
        continue
      }

      val samples = samplesByJoint.getOrPut(joint, ::ArrayDeque)
      val previous = samples.lastOrNull()
      val elapsedMs = previous?.let { pose.timestampMs - it.timestampMs }
      if (elapsedMs != null && elapsedMs > maximumPairGapMs) samples.clear()
      val prior = samples.lastOrNull()
      val pairDurationMs = prior?.let { pose.timestampMs - it.timestampMs }
      val speed = if (prior != null && pairDurationMs != null && pairDurationMs in 1..maximumPairGapMs) {
        hypot(point.x - prior.x, point.y - prior.y) / (pairDurationMs / 1_000.0)
      } else {
        0.0
      }
      samples.addLast(
        PoseTrailPoint(
          timestampMs = pose.timestampMs,
          x = point.x,
          y = point.y,
          normalizedSpeedPerSecond = speed.takeIf(Double::isFinite) ?: 0.0,
        ),
      )
      while (samples.size > maximumSamplesPerJoint) samples.removeFirst()
    }

    prune(pose.timestampMs)
    return snapshot()
  }

  fun ingestMissing(timestampMs: Long) {
    if (latestTimestampMs == null || timestampMs > requireNotNull(latestTimestampMs)) {
      latestTimestampMs = timestampMs
    }
    samplesByJoint.clear()
  }

  fun clear() {
    samplesByJoint.clear()
    latestTimestampMs = null
  }

  private fun prune(timestampMs: Long) {
    val cutoff = timestampMs - retentionMs
    val iterator = samplesByJoint.iterator()
    while (iterator.hasNext()) {
      val samples = iterator.next().value
      while (samples.firstOrNull()?.timestampMs?.let { it < cutoff } == true) {
        samples.removeFirst()
      }
      if (samples.isEmpty()) iterator.remove()
    }
  }

  private fun snapshot() = samplesByJoint.mapValues { (_, samples) -> samples.toList() }

  companion object {
    val DEFAULT_TRACKED_JOINTS = setOf(
      "left_elbow",
      "right_elbow",
      "left_wrist",
      "right_wrist",
      "left_hip",
      "right_hip",
      "left_ankle",
      "right_ankle",
    )
  }
}

/**
 * Evidence gate shared in behavior with iOS. `ready` requires a real pose,
 * sufficient visible full-body coverage, safe frame margins, usable scale, and
 * sustained low jitter. A missing result clears all accumulated readiness.
 */
internal class PoseReadinessEvaluator(
  private val minimumJointVisibility: Double = 0.35,
  private val minimumPoseConfidence: Double = 0.50,
  private val minimumBodyHeight: Double = 0.32,
  private val maximumBodyHeight: Double = 0.88,
  private val maximumBodyWidth: Double = 0.80,
  private val frameMargin: Double = 0.025,
  private val stableDurationMs: Long = 700,
  private val maximumCenterTravel: Double = 0.045,
  private val maximumScaleChange: Double = 0.08,
) {
  private data class StableSample(
    val timestampMs: Long,
    val centerX: Double,
    val centerY: Double,
    val height: Double,
  )

  private val stableSamples = ArrayDeque<StableSample>()

  fun ingestMissing(timestampMs: Long): ReadinessSnapshot {
    stableSamples.clear()
    return ReadinessSnapshot(
      state = ReadinessState.NO_PERSON,
      timestampMs = timestampMs,
      poseConfidence = 0.0,
      jointCoverage = 0.0,
      stableForMs = 0,
      missingJoints = REQUIRED_JOINTS,
      landmarks = emptyList(),
    )
  }

  fun ingest(pose: PoseFrame): ReadinessSnapshot {
    if (pose.confidence < minimumPoseConfidence) return ingestMissing(pose.timestampMs)

    val visible = pose.landmarks
      .filter { it.visibility >= minimumJointVisibility }
      .associateBy { it.name }
    val missing = REQUIRED_JOINTS.filterNot(visible::containsKey)
    val coverage = (REQUIRED_JOINTS.size - missing.size).toDouble() / REQUIRED_JOINTS.size
    if (coverage < 0.83 || !MANDATORY_JOINTS.all(visible::containsKey)) {
      stableSamples.clear()
      return snapshot(ReadinessState.FULL_BODY_REQUIRED, pose, coverage, 0, missing)
    }

    val points = REQUIRED_JOINTS.mapNotNull(visible::get)
    val minX = points.minOf { it.x }
    val maxX = points.maxOf { it.x }
    val minY = points.minOf { it.y }
    val maxY = points.maxOf { it.y }
    val width = maxX - minX
    val height = maxY - minY

    if (minX <= frameMargin || maxX >= 1 - frameMargin ||
      minY <= frameMargin || maxY >= 1 - frameMargin
    ) {
      stableSamples.clear()
      return snapshot(ReadinessState.FULL_BODY_REQUIRED, pose, coverage, 0, missing)
    }
    if (height < minimumBodyHeight) {
      stableSamples.clear()
      return snapshot(ReadinessState.MOVE_CLOSER, pose, coverage, 0, missing)
    }
    if (height > maximumBodyHeight || width > maximumBodyWidth) {
      stableSamples.clear()
      return snapshot(ReadinessState.MOVE_FARTHER, pose, coverage, 0, missing)
    }

    val sample = StableSample(
      timestampMs = pose.timestampMs,
      centerX = (minX + maxX) / 2,
      centerY = (minY + maxY) / 2,
      height = height,
    )
    stableSamples.addLast(sample)
    val cutoff = pose.timestampMs - stableDurationMs
    while (stableSamples.firstOrNull()?.timestampMs?.let { it < cutoff } == true) {
      stableSamples.removeFirst()
    }

    val stableFor = max(0, pose.timestampMs - (stableSamples.firstOrNull()?.timestampMs ?: pose.timestampMs))
    var centerTravel = 0.0
    for (first in stableSamples) {
      for (second in stableSamples) {
        centerTravel = max(centerTravel, hypot(first.centerX - second.centerX, first.centerY - second.centerY))
      }
    }
    val minHeight = stableSamples.minOfOrNull { it.height } ?: height
    val maxHeight = stableSamples.maxOfOrNull { it.height } ?: height
    val scaleChange = maxHeight - minHeight
    val isStable = stableFor >= stableDurationMs &&
      centerTravel <= maximumCenterTravel &&
      scaleChange <= maximumScaleChange

    if (!isStable && (centerTravel > maximumCenterTravel || scaleChange > maximumScaleChange)) {
      stableSamples.clear()
      stableSamples.addLast(sample)
    }
    return snapshot(
      if (isStable) ReadinessState.READY else ReadinessState.HOLD_STILL,
      pose,
      coverage,
      if (isStable) stableFor else 0,
      missing,
    )
  }

  fun reset() = stableSamples.clear()

  private fun snapshot(
    state: ReadinessState,
    pose: PoseFrame,
    coverage: Double,
    stableForMs: Long,
    missing: List<String>,
  ) = ReadinessSnapshot(
    state = state,
    timestampMs = pose.timestampMs,
    poseConfidence = pose.confidence,
    jointCoverage = coverage,
    stableForMs = stableForMs,
    missingJoints = missing,
    landmarks = pose.landmarks,
  )

  companion object {
    val REQUIRED_JOINTS = listOf(
      "left_shoulder", "right_shoulder",
      "left_elbow", "right_elbow",
      "left_wrist", "right_wrist",
      "left_hip", "right_hip",
      "left_knee", "right_knee",
      "left_ankle", "right_ankle",
    )
    private val MANDATORY_JOINTS = listOf(
      "left_shoulder", "right_shoulder", "left_hip", "right_hip",
      "left_knee", "right_knee", "left_ankle", "right_ankle",
    )
  }
}

internal data class MotionEvent(
  val startMs: Long,
  val endMs: Long,
  val peakMotionMs: Long,
  val confidence: Double,
)

internal data class CaptureJointMotionEvidence(
  val joint: String,
  val sampleCount: Int,
  val meanNormalizedPerSecond: Double,
  val peakNormalizedPerSecond: Double,
)

internal data class CaptureEvidenceSummary(
  val schemaVersion: Int,
  val window: String,
  val poseSource: String,
  val poseModelVersion: String,
  val triggerAlgorithmVersion: String,
  val motionUnit: String,
  val analysisInputFrameCount: Int,
  val poseFrameCount: Int,
  val poseMissingFrameCount: Int,
  val trackedDurationMs: Long,
  val meanCanonicalJointVisibility: Double,
  val meanJointCoverage: Double,
  val minimumJointCoverage: Double,
  val fullBodyVisibleFrameCount: Int,
  val jointMotion: List<CaptureJointMotionEvidence>,
)

/**
 * Bounded evidence buffer for the real frames submitted to pose inference.
 * It counts analyzer attempts, not camera/movie frames. Summaries contain only
 * normalized-image measurements inside the completed detector event; none of
 * these values represent physical speed, power, or ball/paddle tracking.
 */
internal class CaptureEvidenceAccumulator(
  private val poseSource: String,
  private val poseModelVersion: String,
  private val triggerAlgorithmVersion: String,
  private val retentionMs: Long = 4_000,
  private val minimumJointVisibility: Double = 0.35,
  private val maximumMotionPairGapMs: Long = 250,
) {
  private data class EvidenceFrame(
    val timestampMs: Long,
    val pose: Map<String, PosePoint>?,
  )

  private data class VisiblePoint(
    val timestampMs: Long,
    val x: Double,
    val y: Double,
  )

  private val frames = ArrayDeque<EvidenceFrame>()
  private var latestTimestampMs: Long? = null

  fun ingestPose(pose: PoseFrame) {
    val byName = mutableMapOf<String, PosePoint>()
    for (point in pose.landmarks) {
      if (point.name !in CANONICAL_JOINT_SET ||
        !point.visibility.isFinite() ||
        !point.x.isFinite() ||
        !point.y.isFinite() ||
        point.x !in 0.0..1.0 ||
        point.y !in 0.0..1.0
      ) {
        continue
      }
      val normalized = point.copy(visibility = point.visibility.coerceIn(0.0, 1.0))
      val existing = byName[point.name]
      if (existing == null || normalized.visibility > existing.visibility) {
        byName[point.name] = normalized
      }
    }
    append(EvidenceFrame(pose.timestampMs, byName))
  }

  fun ingestMissing(timestampMs: Long) {
    append(EvidenceFrame(timestampMs, null))
  }

  fun summarize(event: MotionEvent): CaptureEvidenceSummary? {
    if (event.endMs < event.startMs) return null
    val selected = frames
      .filter { it.timestampMs in event.startMs..event.endMs }
      .sortedBy(EvidenceFrame::timestampMs)
    if (selected.isEmpty()) return null
    val poseFrames = selected.filter { it.pose != null }
    if (poseFrames.isEmpty()) return null

    val visibilityMeans = mutableListOf<Double>()
    val coverages = mutableListOf<Double>()
    var fullBodyVisibleFrameCount = 0
    for (frame in poseFrames) {
      val points = requireNotNull(frame.pose)
      var visibilitySum = 0.0
      var visibleJointCount = 0
      for (joint in CANONICAL_JOINTS) {
        val visibility = points[joint]
          ?.visibility
          ?.takeIf(Double::isFinite)
          ?.coerceIn(0.0, 1.0)
          ?: 0.0
        visibilitySum += visibility
        if (visibility >= minimumJointVisibility) visibleJointCount += 1
      }
      visibilityMeans += visibilitySum / CANONICAL_JOINTS.size
      val coverage = visibleJointCount.toDouble() / CANONICAL_JOINTS.size
      coverages += coverage
      if (visibleJointCount == CANONICAL_JOINTS.size) fullBodyVisibleFrameCount += 1
    }

    val jointMotion = CANONICAL_JOINTS.mapNotNull { joint ->
      val speeds = mutableListOf<Double>()
      var previous: VisiblePoint? = null
      for (frame in selected) {
        val points = frame.pose
        if (points == null) {
          previous = null
          continue
        }
        val point = points[joint]
          ?.takeIf { it.visibility >= minimumJointVisibility }
        if (point == null) {
          previous = null
          continue
        }
        val current = VisiblePoint(frame.timestampMs, point.x, point.y)
        val prior = previous
        if (prior != null) {
          val elapsedMs = current.timestampMs - prior.timestampMs
          if (elapsedMs in 1..maximumMotionPairGapMs) {
            val speed = hypot(current.x - prior.x, current.y - prior.y) /
              (elapsedMs / 1_000.0)
            if (speed.isFinite()) speeds += speed
          }
        }
        previous = current
      }
      if (speeds.isEmpty()) null
      else CaptureJointMotionEvidence(
        joint = joint,
        sampleCount = speeds.size,
        meanNormalizedPerSecond = speeds.average(),
        peakNormalizedPerSecond = speeds.max(),
      )
    }

    return CaptureEvidenceSummary(
      schemaVersion = SCHEMA_VERSION,
      window = WINDOW,
      poseSource = poseSource,
      poseModelVersion = poseModelVersion,
      triggerAlgorithmVersion = triggerAlgorithmVersion,
      motionUnit = MOTION_UNIT,
      analysisInputFrameCount = selected.size,
      poseFrameCount = poseFrames.size,
      poseMissingFrameCount = selected.size - poseFrames.size,
      trackedDurationMs = poseFrames.last().timestampMs - poseFrames.first().timestampMs,
      meanCanonicalJointVisibility = visibilityMeans.average(),
      meanJointCoverage = coverages.average(),
      minimumJointCoverage = coverages.min(),
      fullBodyVisibleFrameCount = fullBodyVisibleFrameCount,
      jointMotion = jointMotion,
    )
  }

  fun reset() {
    frames.clear()
    latestTimestampMs = null
  }

  private fun append(frame: EvidenceFrame) {
    latestTimestampMs = max(latestTimestampMs ?: frame.timestampMs, frame.timestampMs)
    frames.addLast(frame)
    val cutoff = requireNotNull(latestTimestampMs) - retentionMs
    frames.removeAll { it.timestampMs < cutoff }
  }

  companion object {
    const val SCHEMA_VERSION = 1
    const val WINDOW = "detected_motion"
    const val MOTION_UNIT = "normalized_image_units_per_second"
    val CANONICAL_JOINTS: List<String> = PoseReadinessEvaluator.REQUIRED_JOINTS
    private val CANONICAL_JOINT_SET = CANONICAL_JOINTS.toSet()
  }
}

/**
 * Automatic clip trigger only. It detects a discrete high-speed wrist motion;
 * it does not classify a pickleball stroke or provide coaching measurements.
 */
internal class TemporalMotionDetector(
  private val triggerWristSpeed: Double = 0.9,
  private val endWristSpeed: Double = 0.25,
  private val minMotionMs: Long = 250,
  private val maxMotionMs: Long = 2_200,
  private val refractoryMs: Long = 700,
  private val minPoseConfidence: Double = 0.5,
) {
  private enum class State { IDLE, CANDIDATE }
  private data class LastPoint(val x: Double, val y: Double, val timestampMs: Long)

  private var state = State.IDLE
  private val lastPoints = mutableMapOf<String, LastPoint>()
  private var motionStartMs = 0L
  private var peakSpeedMs = 0L
  private var peakSpeed = 0.0
  private var refractoryUntilMs = 0L

  fun ingest(pose: PoseFrame): MotionEvent? {
    if (pose.confidence < minPoseConfidence) return null
    val points = pose.landmarks.filter {
      (it.name == "left_wrist" || it.name == "right_wrist") && it.visibility >= 0.35
    }
    if (points.isEmpty()) return null

    val speeds = mutableListOf<Pair<Double, Long>>()
    for (point in points) {
      val previous = lastPoints[point.name]
      if (previous != null && pose.timestampMs > previous.timestampMs) {
        val elapsed = pose.timestampMs - previous.timestampMs
        if (elapsed <= 250) {
          speeds += (hypot(point.x - previous.x, point.y - previous.y) / (elapsed / 1_000.0)) to previous.timestampMs
        }
      }
      lastPoints[point.name] = LastPoint(point.x, point.y, pose.timestampMs)
    }
    val fastest = speeds.maxByOrNull { it.first } ?: return null
    val speed = fastest.first

    return when (state) {
      State.IDLE -> {
        if (pose.timestampMs >= refractoryUntilMs && speed >= triggerWristSpeed) {
          state = State.CANDIDATE
          motionStartMs = fastest.second
          peakSpeed = speed
          peakSpeedMs = pose.timestampMs
        }
        null
      }
      State.CANDIDATE -> {
        if (speed > peakSpeed) {
          peakSpeed = speed
          peakSpeedMs = pose.timestampMs
        }
        val elapsed = pose.timestampMs - motionStartMs
        when {
          elapsed > maxMotionMs -> {
            state = State.IDLE
            null
          }
          speed <= endWristSpeed && elapsed >= minMotionMs -> {
            state = State.IDLE
            refractoryUntilMs = pose.timestampMs + refractoryMs
            MotionEvent(
              startMs = motionStartMs,
              endMs = pose.timestampMs,
              peakMotionMs = peakSpeedMs,
              confidence = min(0.95, 0.5 + peakSpeed / (triggerWristSpeed * 4)),
            )
          }
          else -> null
        }
      }
    }
  }

  fun reset() {
    state = State.IDLE
    lastPoints.clear()
    refractoryUntilMs = 0
  }

  companion object {
    const val MODEL_VERSION = "temporal-pose-motion-android-1"
  }
}
