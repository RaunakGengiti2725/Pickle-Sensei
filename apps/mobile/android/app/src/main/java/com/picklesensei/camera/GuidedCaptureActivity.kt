package com.picklesensei.camera

import android.Manifest
import android.animation.ValueAnimator
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.Surface
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FallbackStrategy
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.updateLayoutParams
import com.picklesensei.R
import java.io.File
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

/**
 * Full-screen CameraX guided capture. Pose inference, readiness, temporal
 * motion detection, overlay rendering, and clip preparation stay native.
 */
internal class GuidedCaptureActivity : ComponentActivity(), CameraOperationRegistry.ActiveOperation {
  private val captureId = UUID.randomUUID().toString().lowercase()
  private val mainHandler = Handler(Looper.getMainLooper())
  private val analyzerExecutor: ExecutorService = Executors.newSingleThreadExecutor()
  private val mediaExecutor: ExecutorService = Executors.newSingleThreadExecutor()
  private val terminal = AtomicBoolean(false)
  private val processing = AtomicBoolean(false)
  private val readinessEvaluator = PoseReadinessEvaluator()
  private val motionDetector = TemporalMotionDetector()
  private val poseHistory = ArrayDeque<PoseFrame>()
  private val captureEvidenceAccumulator = CaptureEvidenceAccumulator(
    poseSource = POSE_SOURCE,
    poseModelVersion = MediaPipePoseAnalyzer.MODEL_VERSION,
    triggerAlgorithmVersion = TemporalMotionDetector.MODEL_VERSION,
  )
  private val manropeMedium by lazy {
    loadTypeface("fonts/Manrope-Medium.ttf", Typeface.NORMAL)
  }
  private val manropeSemiBold by lazy {
    loadTypeface("fonts/Manrope-SemiBold.ttf", Typeface.BOLD)
  }

  private lateinit var root: FrameLayout
  private lateinit var previewView: PreviewView
  private lateinit var overlayView: PoseOverlayView
  private lateinit var statusPill: LinearLayout
  private lateinit var phaseLabel: TextView
  private lateinit var statusLabel: TextView
  private lateinit var detailLabel: TextView
  private lateinit var closeButton: CenteredCloseButton

  private var cameraProvider: ProcessCameraProvider? = null
  private var imageAnalysis: ImageAnalysis? = null
  private var poseAnalyzer: MediaPipePoseAnalyzer? = null
  private var recording: Recording? = null
  private var observationFile: File? = null

  @Volatile private var recordingActive = false
  @Volatile private var recordingStartTimestampMs = 0L
  @Volatile private var armed = false
  @Volatile private var pendingMotion: MotionEvent? = null
  @Volatile private var pendingCaptureEvidence: CaptureEvidenceSummary? = null
  @Volatile private var lastSourceWidth = 0
  @Volatile private var lastSourceHeight = 0
  @Volatile private var capturePhase = CaptureOverlayPhase.POSITIONING

  private var lastReadinessEventState: ReadinessState? = null
  private var lastReadinessEventAtMs = 0L

  private val observationTimeout = Runnable {
    fail(
      code = "camera.no_stroke_detected",
      message = "No clear swing motion was detected. Reframe the camera and try again.",
      abstention = "no_stroke_detected",
    )
  }
  private val stopAfterMotion = Runnable {
    if (!terminal.get() && pendingMotion != null) recording?.stop()
  }

  private val permissionRequest = registerForActivityResult(
    ActivityResultContracts.RequestPermission(),
  ) { granted ->
    if (terminal.get()) return@registerForActivityResult
    if (granted) {
      CameraOperationRegistry.emit("permission", captureId, mapOf("state" to "granted"))
      configureCamera()
    } else {
      CameraOperationRegistry.emit("permission", captureId, mapOf("state" to "denied"))
      fail(
        code = "camera.permission_denied",
        message = "Allow camera access in Settings to analyze a stroke.",
        abstention = "permission_denied",
      )
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    WindowCompat.setDecorFitsSystemWindows(window, false)
    WindowInsetsControllerCompat(window, window.decorView).apply {
      hide(WindowInsetsCompat.Type.statusBars())
      systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }
    CameraOperationRegistry.register(this)
    buildCameraView()
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() = cancelFromBridge()
    })

    CameraOperationRegistry.emit("permission", captureId, mapOf("state" to "requesting"))
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
      PackageManager.PERMISSION_GRANTED
    ) {
      CameraOperationRegistry.emit("permission", captureId, mapOf("state" to "granted"))
      configureCamera()
    } else {
      permissionRequest.launch(Manifest.permission.CAMERA)
    }
  }

  override fun onStop() {
    super.onStop()
    if (!isChangingConfigurations && recordingActive && !processing.get() && !terminal.get()) {
      fail(
        code = "camera.backgrounded",
        message = "Guided capture stopped when the app left the foreground.",
        abstention = "app_backgrounded",
      )
    }
  }

  override fun onDestroy() {
    mainHandler.removeCallbacksAndMessages(null)
    CameraOperationRegistry.unregister(this)
    imageAnalysis?.clearAnalyzer()
    cameraProvider?.unbindAll()
    val analyzer = poseAnalyzer
    poseAnalyzer = null
    analyzerExecutor.execute {
      try {
        analyzer?.close()
      } finally {
        analyzerExecutor.shutdown()
      }
    }
    mediaExecutor.shutdownNow()
    super.onDestroy()
  }

  override fun cancelFromBridge() {
    runOnUiThread {
      if (processing.get()) return@runOnUiThread
      fail(
        code = "camera.cancelled",
        message = "Guided capture was canceled.",
        abstention = "user_cancelled",
      )
    }
  }

  private fun configureCamera() {
    if (terminal.get()) return
    CameraOperationRegistry.emit("session", captureId, mapOf("state" to "starting"))
    setCaptureStatus(
      CaptureOverlayPhase.POSITIONING,
      "Opening camera…",
      "ON-DEVICE POSE  ·  Waiting for camera",
    )

    val providerFuture = ProcessCameraProvider.getInstance(this)
    providerFuture.addListener({
      if (terminal.get()) return@addListener
      try {
        val provider = providerFuture.get()
        cameraProvider = provider
        val preview = Preview.Builder()
          .setTargetRotation(Surface.ROTATION_0)
          .build()
          .also { it.surfaceProvider = previewView.surfaceProvider }

        val recorder = Recorder.Builder()
          .setQualitySelector(
            QualitySelector.fromOrderedList(
              listOf(Quality.HD, Quality.SD),
              FallbackStrategy.higherQualityOrLowerThan(Quality.HD),
            ),
          )
          .build()
        val videoCapture = VideoCapture.withOutput(recorder)
        videoCapture.targetRotation = Surface.ROTATION_0

        val analysis = ImageAnalysis.Builder()
          .setTargetRotation(Surface.ROTATION_0)
          .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
          .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
          .build()
        val analyzer = MediaPipePoseAnalyzer(
          context = this,
          onPose = ::handlePose,
          onMissing = ::handleMissingPose,
          onFailure = ::handlePoseFailure,
        )
        poseAnalyzer = analyzer
        imageAnalysis = analysis
        analysis.setAnalyzer(analyzerExecutor, analyzer)

        provider.unbindAll()
        val camera = provider.bindToLifecycle(
          this,
          CameraSelector.DEFAULT_BACK_CAMERA,
          preview,
          videoCapture,
          analysis,
        )
        camera.cameraInfo.cameraState.observe(this) { state ->
          val error = state.error ?: return@observe
          if (!terminal.get()) {
            CameraOperationRegistry.emit(
              "session",
              captureId,
              mapOf("state" to "interrupted", "reason" to "camera_state_${error.code}"),
            )
            fail(
              code = "camera.interrupted",
              message = "The camera became unavailable. Close other camera apps and try again.",
              abstention = "camera_interrupted",
            )
          }
        }

        CameraOperationRegistry.emit("session", captureId, mapOf("state" to "configured"))
        startContinuousRecording(recorder)
      } catch (error: Throwable) {
        fail(
          code = "camera.configuration_failed",
          message = error.message ?: "No usable rear camera or pose runtime is available.",
          abstention = "camera_configuration_failure",
        )
      }
    }, ContextCompat.getMainExecutor(this))
  }

  private fun startContinuousRecording(recorder: Recorder) {
    try {
      val file = AndroidClipStore.makeObservationFile(this)
      observationFile = file
      val options = FileOutputOptions.Builder(file).build()
      recording = recorder.prepareRecording(this, options).start(
        ContextCompat.getMainExecutor(this),
        ::handleRecordingEvent,
      )
    } catch (error: Throwable) {
      fail(
        code = "camera.storage_failed",
        message = error.message ?: "A private recording file could not be created.",
        abstention = "storage_failure",
      )
    }
  }

  private fun handleRecordingEvent(event: VideoRecordEvent) {
    when (event) {
      is VideoRecordEvent.Start -> {
        recordingActive = true
        recordingStartTimestampMs = SystemClock.uptimeMillis()
        CameraOperationRegistry.emit("session", captureId, mapOf("state" to "observing"))
        setCaptureStatus(
          CaptureOverlayPhase.POSITIONING,
          "Step fully into frame",
          "ON-DEVICE POSE  ·  Waiting for body",
        )
        mainHandler.postDelayed(observationTimeout, OBSERVATION_TIMEOUT_MS)
      }
      is VideoRecordEvent.Finalize -> {
        recordingActive = false
        recording = null
        mainHandler.removeCallbacks(observationTimeout)
        if (terminal.get()) {
          AndroidClipStore.removeIfPresent(observationFile)
          return
        }
        if (event.hasError()) {
          fail(
            code = "camera.capture_failed",
            message = event.cause?.message ?: "The camera recording could not be completed.",
            abstention = "recording_failure",
          )
          return
        }
        val motion = pendingMotion
        val captureEvidence = pendingCaptureEvidence
        val file = observationFile
        if (motion == null || captureEvidence == null || file == null) {
          AndroidClipStore.removeIfPresent(file)
          fail(
            code = "camera.no_stroke_detected",
            message = "No complete swing motion was detected before capture ended.",
            abstention = "no_stroke_detected",
          )
          return
        }
        prepareClip(file, motion, captureEvidence)
      }
    }
  }

  private fun handlePose(pose: PoseFrame, sourceWidth: Int, sourceHeight: Int) {
    if (terminal.get()) return
    lastSourceWidth = sourceWidth
    lastSourceHeight = sourceHeight
    val snapshot = readinessEvaluator.ingest(pose)
    if (snapshot.state == ReadinessState.NO_PERSON) {
      captureEvidenceAccumulator.ingestMissing(pose.timestampMs)
    } else {
      captureEvidenceAccumulator.ingestPose(pose)
    }
    retainPose(pose)
    handleReadiness(snapshot)
    considerMotion(pose, snapshot)
  }

  /**
   * Full measured pose sequence (session-relative timestamps), bounded to the
   * last [POSE_HISTORY_WINDOW_MS]. Persisted beside the clip so any future
   * model can reprocess this swing — temporal data is never collapsed to
   * aggregates. Strictly increasing timestamps are a schema invariant.
   */
  private fun retainPose(pose: PoseFrame) {
    synchronized(poseHistory) {
      val last = poseHistory.lastOrNull()
      if (last != null && pose.timestampMs <= last.timestampMs) return
      poseHistory.addLast(pose)
      val cutoff = pose.timestampMs - POSE_HISTORY_WINDOW_MS
      while (poseHistory.isNotEmpty() && poseHistory.first().timestampMs < cutoff) {
        poseHistory.removeFirst()
      }
    }
  }

  private fun handleMissingPose(timestampMs: Long) {
    if (terminal.get()) return
    captureEvidenceAccumulator.ingestMissing(timestampMs)
    motionDetector.reset()
    val snapshot = readinessEvaluator.ingestMissing(timestampMs)
    handleReadiness(snapshot)
    if (armed) disarm(snapshot.state)
  }

  private fun handlePoseFailure(error: Throwable) {
    runOnUiThread {
      if (!terminal.get()) {
        fail(
          code = "camera.pose_inference_failed",
          message = error.message ?: "On-device pose tracking stopped unexpectedly.",
          abstention = "pose_inference_failure",
        )
      }
    }
  }

  private fun handleReadiness(snapshot: ReadinessSnapshot) {
    overlayView.update(
      snapshot,
      lastSourceWidth,
      lastSourceHeight,
      capturePhase,
    )

    if (!armed && pendingMotion == null) {
      setCaptureStatus(
        CaptureOverlayPhase.POSITIONING,
        messageFor(snapshot.state),
        readinessDetail(snapshot),
      )
    }
    val shouldEmit = snapshot.state != lastReadinessEventState ||
      snapshot.timestampMs - lastReadinessEventAtMs >= 500
    if (!shouldEmit) return
    lastReadinessEventState = snapshot.state
    lastReadinessEventAtMs = snapshot.timestampMs
    CameraOperationRegistry.emit(
      "readiness",
      captureId,
      mapOf(
        "state" to snapshot.state.wireValue,
        "poseConfidence" to snapshot.poseConfidence,
        "jointCoverage" to snapshot.jointCoverage,
        "stableForMs" to snapshot.stableForMs,
        "missingJoints" to snapshot.missingJoints,
        "source" to POSE_SOURCE,
        "modelVersion" to MediaPipePoseAnalyzer.MODEL_VERSION,
      ),
    )
  }

  private fun considerMotion(pose: PoseFrame, snapshot: ReadinessSnapshot) {
    if (!recordingActive || terminal.get() || pendingMotion != null) return
    val hasPreRoll = pose.timestampMs - recordingStartTimestampMs >= PRE_ROLL_MS
    if (!armed) {
      if (!snapshot.isReady || !hasPreRoll) {
        motionDetector.reset()
        return
      }
      armed = true
      setCaptureStatus(
        CaptureOverlayPhase.BODY_LOCKED,
        "Body locked — swing when ready",
        readinessDetail(snapshot),
      )
      runOnUiThread {
        statusPill.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
      }
      CameraOperationRegistry.emit("session", captureId, mapOf("state" to "armed"))
    } else if (
      snapshot.state == ReadinessState.NO_PERSON ||
      snapshot.state == ReadinessState.FULL_BODY_REQUIRED
    ) {
      disarm(snapshot.state)
      return
    }

    val event = motionDetector.ingest(pose) ?: return
    if (event.confidence < MIN_TRIGGER_CONFIDENCE || pendingMotion != null) return
    val captureEvidence = captureEvidenceAccumulator.summarize(event)
    if (captureEvidence == null) {
      runOnUiThread {
        fail(
          code = "camera.evidence_unavailable",
          message = "The detected motion did not contain enough tracked pose evidence.",
          abstention = "capture_evidence_unavailable",
        )
      }
      return
    }
    pendingMotion = event
    pendingCaptureEvidence = captureEvidence
    val recognition = mapOf(
      "status" to "unknown",
      "reason" to "validated_classifier_unavailable",
    )
    CameraOperationRegistry.emit(
      "stroke_detected",
      captureId,
      mapOf(
        "startTimestampMs" to event.startMs,
        "endTimestampMs" to event.endMs,
        "peakMotionTimestampMs" to event.peakMotionMs,
        "confidence" to event.confidence,
        "detectionModelVersion" to TemporalMotionDetector.MODEL_VERSION,
        "recognition" to recognition,
      ),
    )
    runOnUiThread {
      setCaptureStatus(
        CaptureOverlayPhase.CAPTURED,
        "Motion captured",
        "MEASURED POSE WINDOW  ·  Finishing capture",
      )
      closeButton.isEnabled = false
      closeButton.alpha = 0.5f
      statusPill.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
    }
    val delay = (event.endMs + POST_ROLL_MS - SystemClock.uptimeMillis()).coerceAtLeast(0)
    mainHandler.postDelayed(stopAfterMotion, delay)
  }

  private fun disarm(state: ReadinessState) {
    if (!armed) return
    armed = false
    motionDetector.reset()
    CameraOperationRegistry.emit(
      "session",
      captureId,
      mapOf("state" to "disarmed", "reason" to state.wireValue),
    )
    setCaptureStatus(
      CaptureOverlayPhase.POSITIONING,
      messageFor(state),
      "ON-DEVICE POSE  ·  Reacquiring body",
    )
  }

  private fun prepareClip(
    file: File,
    motion: MotionEvent,
    captureEvidence: CaptureEvidenceSummary,
  ) {
    processing.set(true)
    setCaptureStatus(
      CaptureOverlayPhase.SAVING,
      "Preparing your clip",
      "SAVING  ·  Captured video and pose evidence",
    )
    CameraOperationRegistry.emit("processing", captureId, mapOf("state" to "preparing_clip"))
    mediaExecutor.execute {
      try {
        val retainedPoseHistory = synchronized(poseHistory) { poseHistory.toList() }
        val payload = AndroidClipStore.exportMotionWindow(
          context = this,
          observation = file,
          recordingStartTimestampMs = recordingStartTimestampMs,
          event = motion,
          captureEvidence = captureEvidence,
          poseHistory = retainedPoseHistory,
          poseModelVersion = MediaPipePoseAnalyzer.MODEL_VERSION,
          preRollMs = PRE_ROLL_MS,
          postRollMs = POST_ROLL_MS,
        )
        runOnUiThread { succeed(payload) }
      } catch (error: Throwable) {
        runOnUiThread {
          fail(
            code = "camera.processing_failed",
            message = error.message ?: "The captured motion window could not be prepared.",
            abstention = "clip_processing_failure",
          )
        }
      }
    }
  }

  private fun succeed(payload: JSONObject) {
    if (!terminal.compareAndSet(false, true)) return
    mainHandler.removeCallbacksAndMessages(null)
    CameraOperationRegistry.emit(
      "completed",
      captureId,
      mapOf(
        "recognition" to mapOf(
          "status" to "unknown",
          "reason" to "validated_classifier_unavailable",
        ),
      ),
    )
    CameraOperationRegistry.emit("session", captureId, mapOf("state" to "stopped"))
    setResult(
      Activity.RESULT_OK,
      Intent().putExtra(PickleVideoCaptureModule.EXTRA_RESULT_JSON, payload.toString()),
    )
    finish()
  }

  private fun fail(code: String, message: String, abstention: String) {
    if (!terminal.compareAndSet(false, true)) return
    mainHandler.removeCallbacksAndMessages(null)
    CameraOperationRegistry.emit(
      "abstained",
      captureId,
      mapOf("reason" to abstention, "message" to message),
    )
    CameraOperationRegistry.emit("session", captureId, mapOf("state" to "stopped"))
    val activeRecording = recording
    if (activeRecording != null) activeRecording.stop()
    else AndroidClipStore.removeIfPresent(observationFile)
    setResult(
      Activity.RESULT_CANCELED,
      Intent()
        .putExtra(PickleVideoCaptureModule.EXTRA_ERROR_CODE, code)
        .putExtra(PickleVideoCaptureModule.EXTRA_ERROR_MESSAGE, message),
    )
    finish()
  }

  private fun buildCameraView() {
    root = FrameLayout(this).apply {
      setBackgroundColor(Color.BLACK)
      fitsSystemWindows = false
    }
    previewView = PreviewView(this).apply {
      implementationMode = PreviewView.ImplementationMode.COMPATIBLE
      scaleType = PreviewView.ScaleType.FILL_CENTER
    }
    root.addView(
      previewView,
      FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT,
      ),
    )

    overlayView = PoseOverlayView(this)
    root.addView(
      overlayView,
      FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT,
      ),
    )

    val topShade = View(this).apply {
      background = GradientDrawable(
        GradientDrawable.Orientation.TOP_BOTTOM,
        intArrayOf(Color.argb(190, 2, 12, 8), Color.TRANSPARENT),
      )
    }
    root.addView(
      topShade,
      FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, dp(190), Gravity.TOP),
    )
    val bottomShade = View(this).apply {
      background = GradientDrawable(
        GradientDrawable.Orientation.BOTTOM_TOP,
        intArrayOf(Color.argb(215, 2, 12, 8), Color.TRANSPARENT),
      )
    }
    root.addView(
      bottomShade,
      FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, dp(190), Gravity.BOTTOM),
    )

    closeButton = CenteredCloseButton(this).apply { setOnClickListener { cancelFromBridge() } }
    root.addView(
      closeButton,
      FrameLayout.LayoutParams(dp(48), dp(48), Gravity.TOP or Gravity.START).apply {
        marginStart = dp(18)
        topMargin = dp(18)
      },
    )

    phaseLabel = TextView(this).apply {
      text = phaseText(CaptureOverlayPhase.POSITIONING)
      setTextColor(Color.rgb(215, 250, 69))
      textSize = 11f
      letterSpacing = 0.12f
      gravity = Gravity.CENTER
      typeface = manropeSemiBold
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    statusLabel = TextView(this).apply {
      text = getString(R.string.camera_status_opening)
      setTextColor(Color.WHITE)
      textSize = 17f
      gravity = Gravity.CENTER
      typeface = manropeSemiBold
      setPadding(0, dp(3), 0, 0)
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    statusPill = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      setPadding(dp(20), dp(10), dp(20), dp(11))
      background = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        cornerRadius = dp(24).toFloat()
        color = ColorStateList.valueOf(Color.argb(180, 3, 17, 12))
        setStroke(dp(1), Color.argb(45, 255, 255, 255))
      }
      elevation = dp(5).toFloat()
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
      accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
      contentDescription = "Positioning. Opening camera."
      addView(phaseLabel, LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.WRAP_CONTENT,
        LinearLayout.LayoutParams.WRAP_CONTENT,
      ))
      addView(statusLabel, LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.WRAP_CONTENT,
        LinearLayout.LayoutParams.WRAP_CONTENT,
      ))
    }
    root.addView(
      statusPill,
      FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.WRAP_CONTENT,
        FrameLayout.LayoutParams.WRAP_CONTENT,
        Gravity.TOP or Gravity.CENTER_HORIZONTAL,
      ).apply { topMargin = dp(82); marginStart = dp(24); marginEnd = dp(24) },
    )

    detailLabel = TextView(this).apply {
      text = getString(R.string.camera_detail_waiting)
      setTextColor(Color.argb(220, 255, 255, 255))
      textSize = 13f
      gravity = Gravity.CENTER
      typeface = manropeMedium
      setPadding(dp(26), dp(10), dp(26), dp(10))
      contentDescription = "On-device pose. Waiting for camera."
    }
    root.addView(
      detailLabel,
      FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.WRAP_CONTENT,
        Gravity.BOTTOM,
      ).apply { bottomMargin = dp(24) },
    )

    root.setOnApplyWindowInsetsListener { _, insets ->
      val bars = WindowInsetsCompat.toWindowInsetsCompat(insets)
        .getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      closeButton.updateLayoutParams<FrameLayout.LayoutParams> {
        topMargin = bars.top + dp(14)
      }
      statusPill.updateLayoutParams<FrameLayout.LayoutParams> {
        topMargin = bars.top + dp(78)
      }
      detailLabel.updateLayoutParams<FrameLayout.LayoutParams> {
        bottomMargin = bars.bottom + dp(20)
      }
      insets
    }
    setContentView(root)
  }

  private fun setCaptureStatus(
    nextPhase: CaptureOverlayPhase,
    message: String,
    detail: String,
  ) {
    capturePhase = nextPhase
    if (::overlayView.isInitialized) overlayView.setCapturePhase(nextPhase)
    runOnUiThread {
      val nextPhaseText = phaseText(nextPhase)
      val statusChanged = phaseLabel.text != nextPhaseText || statusLabel.text != message
      if (detailLabel.text != detail) {
        detailLabel.text = detail
        detailLabel.contentDescription = detail.replace("  ·  ", ". ")
      }
      if (!statusChanged) return@runOnUiThread

      val applyStatus = {
        phaseLabel.text = nextPhaseText
        phaseLabel.setTextColor(phaseColor(nextPhase))
        statusLabel.text = message
        statusPill.contentDescription = "$nextPhaseText. $message."
      }
      statusPill.animate().cancel()
      applyStatus()
      if (!systemAnimationsEnabled()) {
        statusPill.alpha = 1f
        statusPill.translationY = 0f
        return@runOnUiThread
      }
      statusPill.alpha = 0.66f
      statusPill.translationY = dp(3).toFloat()
      statusPill.animate()
        .alpha(1f)
        .translationY(0f)
        .setDuration(150)
        .start()
    }
  }

  private fun messageFor(state: ReadinessState) = when (state) {
    ReadinessState.NO_PERSON -> "Step fully into frame"
    ReadinessState.FULL_BODY_REQUIRED -> "Keep your full body visible"
    ReadinessState.MOVE_CLOSER -> "Move a little closer"
    ReadinessState.MOVE_FARTHER -> "Move a little farther back"
    ReadinessState.HOLD_STILL -> "Hold still for a moment"
    ReadinessState.READY -> "Ready — swing when comfortable"
  }

  private fun readinessDetail(snapshot: ReadinessSnapshot): String {
    if (snapshot.state == ReadinessState.NO_PERSON) {
      return "ON-DEVICE POSE  ·  Waiting for body"
    }
    val tracked = (PoseReadinessEvaluator.REQUIRED_JOINTS.size - snapshot.missingJoints.size)
      .coerceIn(0, PoseReadinessEvaluator.REQUIRED_JOINTS.size)
    return "$tracked/${PoseReadinessEvaluator.REQUIRED_JOINTS.size} JOINTS TRACKED  ·  ON-DEVICE"
  }

  private fun phaseText(phase: CaptureOverlayPhase) = when (phase) {
    CaptureOverlayPhase.POSITIONING -> "POSITIONING"
    CaptureOverlayPhase.BODY_LOCKED -> "BODY LOCKED"
    CaptureOverlayPhase.CAPTURED -> "MOTION CAPTURED"
    CaptureOverlayPhase.SAVING -> "SAVING"
  }

  private fun phaseColor(phase: CaptureOverlayPhase) = when (phase) {
    CaptureOverlayPhase.POSITIONING -> Color.rgb(215, 250, 69)
    CaptureOverlayPhase.BODY_LOCKED -> Color.rgb(73, 239, 153)
    CaptureOverlayPhase.CAPTURED -> Color.rgb(215, 250, 69)
    CaptureOverlayPhase.SAVING -> Color.WHITE
  }

  private fun systemAnimationsEnabled(): Boolean {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      ValueAnimator.areAnimatorsEnabled()
    } else {
      Settings.Global.getFloat(
        contentResolver,
        Settings.Global.ANIMATOR_DURATION_SCALE,
        1f,
      ) > 0f
    }
  }

  private fun loadTypeface(assetPath: String, fallbackStyle: Int): Typeface {
    return runCatching { Typeface.createFromAsset(assets, assetPath) }
      .getOrElse { Typeface.create("sans-serif-medium", fallbackStyle) }
  }

  private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

  companion object {
    private const val POSE_SOURCE = "mediapipe_pose_landmarker"
    private const val PRE_ROLL_MS = 2_000L
    private const val POST_ROLL_MS = 1_500L
    private const val POSE_HISTORY_WINDOW_MS = 15_000L
    private const val OBSERVATION_TIMEOUT_MS = 55_000L
    private const val MIN_TRIGGER_CONFIDENCE = 0.65
  }
}
