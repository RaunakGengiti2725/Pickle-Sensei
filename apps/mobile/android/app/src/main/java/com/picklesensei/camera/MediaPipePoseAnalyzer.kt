package com.picklesensei.camera

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Matrix
import android.os.SystemClock
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarker
import java.io.Closeable
import kotlin.math.min

/**
 * Runs the stable MediaPipe Tasks Pose Landmarker entirely on device. CameraX
 * supplies only the newest frame; inference is sequential on the analyzer
 * executor and no image data crosses the React Native bridge or network.
 */
internal class MediaPipePoseAnalyzer(
  context: Context,
  private val onPose: (PoseFrame, Int, Int) -> Unit,
  private val onMissing: (Long) -> Unit,
  private val onFailure: (Throwable) -> Unit,
) : ImageAnalysis.Analyzer, Closeable {
  private val landmarker: PoseLandmarker

  init {
    val baseOptions = BaseOptions.builder()
      .setModelAssetPath(MODEL_ASSET_PATH)
      .build()
    val options = PoseLandmarker.PoseLandmarkerOptions.builder()
      .setBaseOptions(baseOptions)
      .setRunningMode(RunningMode.VIDEO)
      .setNumPoses(1)
      .setMinPoseDetectionConfidence(0.5f)
      .setMinPosePresenceConfidence(0.5f)
      .setMinTrackingConfidence(0.5f)
      .setOutputSegmentationMasks(false)
      .build()
    landmarker = PoseLandmarker.createFromOptions(context.applicationContext, options)
  }

  override fun analyze(imageProxy: ImageProxy) {
    val timestampMs = SystemClock.uptimeMillis()
    var rawBitmap: Bitmap? = null
    var uprightBitmap: Bitmap? = null
    var proxyClosed = false
    try {
      rawBitmap = Bitmap.createBitmap(
        imageProxy.width,
        imageProxy.height,
        Bitmap.Config.ARGB_8888,
      )
      val buffer = imageProxy.planes[0].buffer
      buffer.rewind()
      rawBitmap.copyPixelsFromBuffer(buffer)
      val rotation = imageProxy.imageInfo.rotationDegrees
      imageProxy.close()
      proxyClosed = true

      uprightBitmap = if (rotation == 0) {
        rawBitmap
      } else {
        Bitmap.createBitmap(
          rawBitmap,
          0,
          0,
          rawBitmap.width,
          rawBitmap.height,
          Matrix().apply { postRotate(rotation.toFloat()) },
          true,
        )
      }

      val mpImage = BitmapImageBuilder(uprightBitmap).build()
      val result = try {
        landmarker.detectForVideo(mpImage, timestampMs)
      } finally {
        mpImage.close()
      }
      val detected = result.landmarks().firstOrNull()
      if (detected == null || detected.size < 29) {
        onMissing(timestampMs)
        return
      }

      val points = LANDMARK_INDICES.map { (name, index) ->
        val landmark = detected[index]
        val visible = landmark.visibility().orElse(0f)
        val visibility = min(
          visible,
          landmark.presence().orElse(visible),
        ).toDouble().coerceIn(0.0, 1.0)
        PosePoint(
          name = name,
          x = landmark.x().toDouble(),
          y = landmark.y().toDouble(),
          visibility = visibility,
        )
      }
      val confidence = points
        .filter { it.name in CONFIDENCE_JOINTS }
        .map(PosePoint::visibility)
        .average()
        .takeIf(Double::isFinite)
        ?: 0.0
      onPose(
        PoseFrame(timestampMs, points, confidence),
        uprightBitmap.width,
        uprightBitmap.height,
      )
    } catch (error: Throwable) {
      if (!proxyClosed) imageProxy.close()
      onFailure(error)
    } finally {
      if (uprightBitmap != null && uprightBitmap !== rawBitmap && !uprightBitmap.isRecycled) {
        uprightBitmap.recycle()
      }
      if (rawBitmap != null && !rawBitmap.isRecycled) rawBitmap.recycle()
    }
  }

  override fun close() {
    landmarker.close()
  }

  companion object {
    const val MODEL_VERSION = "mediapipe-pose-landmarker-full-md5-5a9ad889"
    private const val MODEL_ASSET_PATH = "models/pose_landmarker_full.task"

    private val LANDMARK_INDICES = linkedMapOf(
      "left_shoulder" to 11,
      "right_shoulder" to 12,
      "left_elbow" to 13,
      "right_elbow" to 14,
      "left_wrist" to 15,
      "right_wrist" to 16,
      "left_hip" to 23,
      "right_hip" to 24,
      "left_knee" to 25,
      "right_knee" to 26,
      "left_ankle" to 27,
      "right_ankle" to 28,
    )
    private val CONFIDENCE_JOINTS = setOf(
      "left_shoulder", "right_shoulder", "left_hip", "right_hip",
      "left_knee", "right_knee", "left_ankle", "right_ankle",
    )
  }
}
