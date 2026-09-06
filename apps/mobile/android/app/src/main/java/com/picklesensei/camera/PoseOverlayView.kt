package com.picklesensei.camera

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.util.AttributeSet
import android.view.View
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * Draws only current, measured landmarks and short-lived measured paths.
 * The athlete renders as a bounded motion map with crisp, contoured bones
 * and local joint outlines rather than additive glows. Neutral chalk moves
 * toward optic volt as measured movement rises; fault emphasis is separate.
 * Every marker center is an observed landmark and each bone connects two
 * observed endpoints. Every intensity comes from measured movement speed;
 * no missing landmark or trajectory is synthesized.
 */
internal class PoseOverlayView @JvmOverloads constructor(
  context: Context,
  attrs: AttributeSet? = null,
) : View(context, attrs) {
  private val guidePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.argb(130, 255, 255, 255)
    style = Paint.Style.STROKE
    strokeWidth = dp(1.4f)
    strokeCap = Paint.Cap.ROUND
  }
  private val guideConfirmationPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.rgb(83, 217, 155)
    style = Paint.Style.STROKE
    strokeWidth = dp(7f)
    strokeCap = Paint.Cap.ROUND
  }
  private val trailPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeCap = Paint.Cap.ROUND
    strokeJoin = Paint.Join.ROUND
  }
  private val heatPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeCap = Paint.Cap.ROUND
  }
  private val bonePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeCap = Paint.Cap.ROUND
    color = Color.rgb(248, 250, 245)
  }
  private val contourPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeCap = Paint.Cap.ROUND
    color = Color.rgb(7, 23, 16)
  }
  private val guidePath = Path()
  private val guideRect = RectF()
  // Shoulders and knees are tracked in addition to the default joints so the
  // whole heat map is backed by per-joint MEASURED speeds — never a guessed
  // intensity for an untracked region.
  private val trailAccumulator = PoseTrailAccumulator(
    trackedJoints = PoseTrailAccumulator.DEFAULT_TRACKED_JOINTS +
      setOf("left_shoulder", "right_shoulder", "left_knee", "right_knee"),
  )

  private var landmarks = emptyMap<String, PosePoint>()
  private var trails = emptyMap<String, List<PoseTrailPoint>>()
  private var latestPoseTimestampMs = 0L
  private var imageWidth = 0
  private var imageHeight = 0
  private var renderedWidth = 0f
  private var renderedHeight = 0f
  private var renderedOffsetX = 0f
  private var renderedOffsetY = 0f
  private var readinessState = ReadinessState.NO_PERSON
  private var jointCoverage = 0f
  private var phase = CaptureOverlayPhase.POSITIONING
  private var lockConfirmationStartedAtMs: Long? = null

  init {
    isClickable = false
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }

  fun update(
    snapshot: ReadinessSnapshot,
    sourceWidth: Int,
    sourceHeight: Int,
    capturePhase: CaptureOverlayPhase,
  ) {
    post {
      latestPoseTimestampMs = snapshot.timestampMs
      readinessState = snapshot.state
      jointCoverage = snapshot.jointCoverage.toFloat().coerceIn(0f, 1f)
      if (snapshot.state == ReadinessState.NO_PERSON) {
        trailAccumulator.ingestMissing(snapshot.timestampMs)
        trails = emptyMap()
        landmarks = emptyMap()
      } else {
        val validPoints = snapshot.landmarks.filter(::isDrawable)
        landmarks = validPoints.associateBy(PosePoint::name)
        trails = trailAccumulator.ingest(
          PoseFrame(snapshot.timestampMs, validPoints, snapshot.poseConfidence),
        )
      }
      if (sourceWidth > 0 && sourceHeight > 0) {
        imageWidth = sourceWidth
        imageHeight = sourceHeight
      }
      updatePhase(capturePhase)
      invalidate()
    }
  }

  fun setCapturePhase(capturePhase: CaptureOverlayPhase) {
    post {
      if (updatePhase(capturePhase)) invalidate()
    }
  }

  fun clear() {
    post {
      trailAccumulator.clear()
      landmarks = emptyMap()
      trails = emptyMap()
      latestPoseTimestampMs = 0L
      readinessState = ReadinessState.NO_PERSON
      jointCoverage = 0f
      phase = CaptureOverlayPhase.POSITIONING
      lockConfirmationStartedAtMs = null
      invalidate()
    }
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val nowMs = SystemClock.uptimeMillis()
    drawFramingGuide(canvas, nowMs)
    if (imageWidth <= 0 || imageHeight <= 0 || landmarks.isEmpty()) {
      continueFiniteLockConfirmation(nowMs)
      return
    }
    updatePreviewMapping()

    drawBodyHeatMap(canvas)
    drawMeasuredTrails(canvas)
    continueFiniteLockConfirmation(nowMs)
  }

  /**
   * Per-joint heat: the newest measured speed, normalized to the full-swing
   * ceiling and faded by sample age. A joint with no fresh measurement has
   * zero heat — it retains the neutral observed mark, nothing hotter.
   */
  private fun measuredHeatByJoint(): Map<String, Float> {
    val heat = HashMap<String, Float>(trails.size)
    for ((joint, samples) in trails) {
      val sample = samples.lastOrNull() ?: continue
      val speed = min(1.0, sample.normalizedSpeedPerSecond / MOTION_DISPLAY_CEILING).toFloat()
      val ageMs = (latestPoseTimestampMs - sample.timestampMs).coerceAtLeast(0)
      val freshness = (1f - ageMs.toFloat() / TRAIL_RETENTION_MS).coerceIn(0f, 1f)
      heat[joint] = speed.coerceIn(0f, 1f) * (0.4f + 0.6f * freshness)
    }
    return heat
  }

  private fun drawBodyHeatMap(canvas: Canvas) {
    val heatByJoint = measuredHeatByJoint()
    fun heat(name: String) = heatByJoint[name] ?: 0f

    // Global brightness: dimmer while positioning, full once locked, calm
    // while saving; partial joint coverage dims everything proportionally.
    val phaseAlpha = when (phase) {
      CaptureOverlayPhase.POSITIONING -> 0.8f
      CaptureOverlayPhase.BODY_LOCKED, CaptureOverlayPhase.CAPTURED -> 1f
      CaptureOverlayPhase.SAVING -> 0.62f
    }
    val coverageAlpha = min(1f, max(0.52f, jointCoverage))
    val globalAlpha = phaseAlpha * coverageAlpha

    // Marker size follows the observed body scale (torso extent in view
    // pixels) so local emphasis stays proportional whether near or far.
    val leftShoulder = visibleLandmark("left_shoulder")
    val rightShoulder = visibleLandmark("right_shoulder")
    val leftHip = visibleLandmark("left_hip")
    val rightHip = visibleLandmark("right_hip")
    val radiusUnit: Float
    if (leftShoulder != null && rightShoulder != null && leftHip != null && rightHip != null) {
      val shoulderMidX = (mapX(leftShoulder.x) + mapX(rightShoulder.x)) / 2f
      val shoulderMidY = (mapY(leftShoulder.y) + mapY(rightShoulder.y)) / 2f
      val hipMidX = (mapX(leftHip.x) + mapX(rightHip.x)) / 2f
      val hipMidY = (mapY(leftHip.y) + mapY(rightHip.y)) / 2f
      val torsoLength = hypot(
        (hipMidX - shoulderMidX).toDouble(),
        (hipMidY - shoulderMidY).toDouble(),
      ).toFloat()
      radiusUnit = (torsoLength * 0.17f).coerceIn(dp(9f), dp(30f))

      // Torso motion remains on the observed shoulder and hip segments.
    } else {
      radiusUnit = dp(15f)
    }

    val scale = (radiusUnit / dp(15f)).coerceIn(0.6f, 1.6f)
    bonePaint.strokeWidth = dp(2.6f) * scale
    bonePaint.alpha = (0.92f * globalAlpha * 255f).toInt()
    contourPaint.strokeWidth = dp(4.8f) * scale
    contourPaint.alpha = (globalAlpha * 255f).toInt()

    // Limb heat stays between each segment's two OBSERVED endpoints.
    for ((startName, endName) in SEGMENTS) {
      val start = visibleLandmark(startName) ?: continue
      val end = visibleLandmark(endName) ?: continue
      val startX = mapX(start.x)
      val startY = mapY(start.y)
      val endX = mapX(end.x)
      val endY = mapY(end.y)
      val intensity = (heat(startName) + heat(endName)) / 2f
      if (intensity >= 0.2f) {
        heatPaint.color = Color.rgb(215, 250, 69)
        heatPaint.alpha = ((0.1f + 0.14f * intensity) * globalAlpha * 255f).toInt()
        heatPaint.strokeWidth = max(dp(4f), radiusUnit * (0.4f + 0.3f * intensity))
        canvas.drawLine(startX, startY, endX, endY, heatPaint)
      }
      canvas.drawLine(startX, startY, endX, endY, contourPaint)
      canvas.drawLine(startX, startY, endX, endY, bonePaint)
    }

    // Joint cores: bounded outlines at each observed landmark.
    for (name in JOINT_CORE_NAMES) {
      val landmark = visibleLandmark(name) ?: continue
      val visibilityAlpha =
        0.5f + 0.5f * (((landmark.visibility.toFloat() - 0.35f) / 0.65f).coerceIn(0f, 1f))
      val jointHeat = heat(name)
      drawGlow(
        canvas,
        mapX(landmark.x),
        mapY(landmark.y),
        radiusUnit * (0.4f + 0.4f * jointHeat),
        jointHeat,
        (0.17f + 0.21f * jointHeat) * visibilityAlpha * globalAlpha,
      )
    }
  }

  /** One bounded motion outline. Reuses its paint instead of additive shaders,
   * with size and opacity retaining the observed joint's motion intensity. */
  private fun drawGlow(canvas: Canvas, x: Float, y: Float, radius: Float, heat: Float, alpha: Float) {
    if (alpha <= 0.015f || radius <= 1f) return
    heatPaint.color = heatColor(heat)
    heatPaint.strokeWidth = dp(1f + heat.coerceIn(0f, 1f))
    heatPaint.alpha = (alpha.coerceIn(0f, 1f) * 255f).toInt()
    canvas.drawCircle(x, y, radius, heatPaint)
  }

  /** Measured-speed ramp: neutral chalk → optic volt, separate from faults. */
  private fun heatColor(t: Float): Int =
    blend(Color.rgb(248, 250, 245), Color.rgb(215, 250, 69), t.coerceIn(0f, 1f))

  private fun drawMeasuredTrails(canvas: Canvas) {
    for (samples in trails.values) {
      if (samples.size < 2) continue
      for (index in 1 until samples.size) {
        val previous = samples[index - 1]
        val current = samples[index]
        val speed = max(previous.normalizedSpeedPerSecond, current.normalizedSpeedPerSecond)
        if (speed < MIN_VISIBLE_TRAIL_SPEED) continue
        val ageMs = (latestPoseTimestampMs - current.timestampMs).coerceAtLeast(0)
        val freshness = (1f - ageMs.toFloat() / TRAIL_RETENTION_MS).coerceIn(0f, 1f)
        if (freshness <= 0f) continue
        val intensity = min(1.0, speed / MOTION_DISPLAY_CEILING).toFloat()
        trailPaint.color = heatColor(intensity)
        trailPaint.alpha = ((34 + 150 * intensity) * freshness).toInt().coerceIn(0, 255)
        trailPaint.strokeWidth = dp(1.7f + 3.2f * intensity)
        canvas.drawLine(
          mapX(previous.x),
          mapY(previous.y),
          mapX(current.x),
          mapY(current.y),
          trailPaint,
        )
      }
    }
  }

  private fun drawFramingGuide(canvas: Canvas, nowMs: Long) {
    val insetX = width * 0.12f
    val top = height * 0.16f
    val bottom = height * 0.84f
    guideRect.set(insetX, top, width - insetX, bottom)
    val corner = dp(28f)
    val segment = dp(32f)
    guidePath.rewind()
    guidePath.apply {
      moveTo(guideRect.left, guideRect.top + corner + segment)
      lineTo(guideRect.left, guideRect.top + corner)
      quadTo(guideRect.left, guideRect.top, guideRect.left + corner, guideRect.top)
      lineTo(guideRect.left + corner + segment, guideRect.top)

      moveTo(guideRect.right - corner - segment, guideRect.top)
      lineTo(guideRect.right - corner, guideRect.top)
      quadTo(guideRect.right, guideRect.top, guideRect.right, guideRect.top + corner)
      lineTo(guideRect.right, guideRect.top + corner + segment)

      moveTo(guideRect.right, guideRect.bottom - corner - segment)
      lineTo(guideRect.right, guideRect.bottom - corner)
      quadTo(guideRect.right, guideRect.bottom, guideRect.right - corner, guideRect.bottom)
      lineTo(guideRect.right - corner - segment, guideRect.bottom)

      moveTo(guideRect.left + corner + segment, guideRect.bottom)
      lineTo(guideRect.left + corner, guideRect.bottom)
      quadTo(guideRect.left, guideRect.bottom, guideRect.left, guideRect.bottom - corner)
      lineTo(guideRect.left, guideRect.bottom - corner - segment)
    }

    guidePaint.color = when (phase) {
      CaptureOverlayPhase.POSITIONING -> when (readinessState) {
        ReadinessState.READY -> Color.rgb(83, 217, 155)
        ReadinessState.HOLD_STILL -> Color.rgb(215, 250, 69)
        else -> Color.WHITE
      }
      CaptureOverlayPhase.BODY_LOCKED -> Color.rgb(83, 217, 155)
      CaptureOverlayPhase.CAPTURED -> Color.rgb(215, 250, 69)
      CaptureOverlayPhase.SAVING -> Color.WHITE
    }
    guidePaint.alpha = when (phase) {
      CaptureOverlayPhase.POSITIONING -> (82 + jointCoverage * 92).toInt()
      CaptureOverlayPhase.BODY_LOCKED -> 205
      CaptureOverlayPhase.CAPTURED -> 215
      CaptureOverlayPhase.SAVING -> 74
    }
    guidePaint.strokeWidth = when (phase) {
      CaptureOverlayPhase.POSITIONING -> dp(1.4f)
      CaptureOverlayPhase.BODY_LOCKED, CaptureOverlayPhase.CAPTURED -> dp(2.1f)
      CaptureOverlayPhase.SAVING -> dp(1.2f)
    }
    canvas.drawPath(guidePath, guidePaint)

    val lockStart = lockConfirmationStartedAtMs ?: return
    val elapsed = nowMs - lockStart
    if (elapsed !in 0..LOCK_CONFIRMATION_DURATION_MS) return
    val linear = elapsed.toFloat() / LOCK_CONFIRMATION_DURATION_MS
    val eased = 1f - (1f - linear) * (1f - linear) * (1f - linear)
    guideConfirmationPaint.alpha = (112 * (1f - eased)).toInt().coerceIn(0, 255)
    guideConfirmationPaint.strokeWidth = dp(7f - 4f * eased)
    canvas.drawPath(guidePath, guideConfirmationPaint)
  }

  private fun visibleLandmark(name: String): PosePoint? {
    val point = landmarks[name] ?: return null
    if (point.visibility < 0.35) return null
    return point
  }

  // PreviewView uses FILL_CENTER; mirror its center-crop transform for upright
  // frames produced by the analyzer.
  private fun updatePreviewMapping() {
    val scale = max(width.toFloat() / imageWidth, height.toFloat() / imageHeight)
    renderedWidth = imageWidth * scale
    renderedHeight = imageHeight * scale
    renderedOffsetX = (width - renderedWidth) / 2f
    renderedOffsetY = (height - renderedHeight) / 2f
  }

  private fun mapX(x: Double) = renderedOffsetX + x.toFloat() * renderedWidth

  private fun mapY(y: Double) = renderedOffsetY + y.toFloat() * renderedHeight

  private fun isDrawable(point: PosePoint) =
    point.visibility.isFinite() && point.x.isFinite() && point.y.isFinite() &&
      point.x in 0.0..1.0 && point.y in 0.0..1.0

  private fun updatePhase(next: CaptureOverlayPhase): Boolean {
    if (phase == next) return false
    phase = next
    lockConfirmationStartedAtMs = if (
      next == CaptureOverlayPhase.BODY_LOCKED && systemAnimationsEnabled()
    ) {
      SystemClock.uptimeMillis()
    } else {
      null
    }
    return true
  }

  private fun continueFiniteLockConfirmation(nowMs: Long) {
    val startedAt = lockConfirmationStartedAtMs ?: return
    if (nowMs - startedAt < LOCK_CONFIRMATION_DURATION_MS) {
      postInvalidateOnAnimation()
    } else {
      lockConfirmationStartedAtMs = null
    }
  }

  private fun systemAnimationsEnabled(): Boolean {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      ValueAnimator.areAnimatorsEnabled()
    } else {
      Settings.Global.getFloat(
        context.contentResolver,
        Settings.Global.ANIMATOR_DURATION_SCALE,
        1f,
      ) > 0f
    }
  }

  private fun blend(start: Int, end: Int, fraction: Float): Int {
    val amount = fraction.coerceIn(0f, 1f)
    return Color.rgb(
      (Color.red(start) + (Color.red(end) - Color.red(start)) * amount).toInt(),
      (Color.green(start) + (Color.green(end) - Color.green(start)) * amount).toInt(),
      (Color.blue(start) + (Color.blue(end) - Color.blue(start)) * amount).toInt(),
    )
  }

  private fun dp(value: Float) = value * resources.displayMetrics.density

  companion object {
    private const val TRAIL_RETENTION_MS = 480f
    private const val MOTION_DISPLAY_CEILING = 1.2
    private const val MIN_VISIBLE_TRAIL_SPEED = 0.06
    private const val LOCK_CONFIRMATION_DURATION_MS = 280L
    private val SEGMENTS = listOf(
      "left_shoulder" to "right_shoulder",
      "left_shoulder" to "left_elbow",
      "left_elbow" to "left_wrist",
      "right_shoulder" to "right_elbow",
      "right_elbow" to "right_wrist",
      "left_shoulder" to "left_hip",
      "right_shoulder" to "right_hip",
      "left_hip" to "right_hip",
      "left_hip" to "left_knee",
      "left_knee" to "left_ankle",
      "right_hip" to "right_knee",
      "right_knee" to "right_ankle",
    )
    private val JOINT_CORE_NAMES =
      SEGMENTS.flatMap { listOf(it.first, it.second) }.toSet()
  }
}

internal class CenteredCloseButton(context: Context) : View(context) {
  private val backgroundPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.argb(150, 3, 14, 10)
    style = Paint.Style.FILL
  }
  private val linePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.WHITE
    style = Paint.Style.STROKE
    strokeWidth = resources.displayMetrics.density * 2.2f
    strokeCap = Paint.Cap.ROUND
  }

  init {
    isClickable = true
    isFocusable = true
    contentDescription = "Cancel guided capture"
    setBackgroundColor(Color.TRANSPARENT)
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val cx = width / 2f
    val cy = height / 2f
    canvas.drawCircle(cx, cy, minOf(width, height) * 0.48f, backgroundPaint)
    val radius = minOf(width, height) * 0.17f
    canvas.drawLine(cx - radius, cy - radius, cx + radius, cy + radius, linePaint)
    canvas.drawLine(cx + radius, cy - radius, cx - radius, cy + radius, linePaint)
  }
}
