package com.picklesensei.camera

import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

internal class ClipStoreException(message: String, cause: Throwable? = null) :
  Exception(message, cause)

/** Private, app-owned media persistence and measured metadata extraction. */
internal object AndroidClipStore {
  fun makeObservationFile(context: Context): File {
    val directory = File(context.cacheDir, "guided-observation")
    if (!directory.exists() && !directory.mkdirs()) {
      throw ClipStoreException("A private recording directory could not be created.")
    }
    return File(directory, "observation-${UUID.randomUUID()}.mp4")
  }

  fun removeIfPresent(file: File?) {
    if (file?.exists() == true) file.delete()
  }

  fun persistImportedVideo(context: Context, source: Uri): File {
    val directory = capturesDirectory(context)
    val extension = safeImportExtension(context, source)
    val destination = File(directory, "import-${UUID.randomUUID()}.$extension")
    try {
      val input = context.contentResolver.openInputStream(source)
        ?: throw ClipStoreException("The selected video could not be opened.")
      input.use { stream ->
        FileOutputStream(destination).use { output -> stream.copyTo(output) }
      }
      if (destination.length() <= 0) throw ClipStoreException("The selected video is empty.")
      return destination
    } catch (error: Throwable) {
      removeIfPresent(destination)
      if (error is ClipStoreException) throw error
      throw ClipStoreException("The selected video could not be copied privately.", error)
    }
  }

  fun importedPayload(file: File): JSONObject = measuredPayload(
    file = file,
    captureMode = "imported_video",
    additional = mapOf(
      "recognition" to JSONObject()
        .put("status", "unknown")
        .put("reason", "analysis_not_run"),
      "ballSpeed" to unavailableBallSpeed("analysis_not_run"),
    ),
  )

  /**
   * Remuxes the real CameraX recording around the detected temporal motion.
   * Seeking to the previous sync frame may retain slightly more pre-roll than
   * requested; the returned trigger/pre/post values describe the actual file.
   */
  fun exportMotionWindow(
    context: Context,
    observation: File,
    recordingStartTimestampMs: Long,
    event: MotionEvent,
    captureEvidence: CaptureEvidenceSummary,
    poseHistory: List<PoseFrame>,
    poseModelVersion: String,
    preRollMs: Long,
    postRollMs: Long,
  ): JSONObject {
    val destination = File(capturesDirectory(context), "stroke-${UUID.randomUUID()}.mp4")
    val requestedStartUs = (
      event.startMs - preRollMs - recordingStartTimestampMs
      ).coerceAtLeast(0) * 1_000
    val requestedEndUs = (
      event.endMs + postRollMs - recordingStartTimestampMs
      ).coerceAtLeast(1) * 1_000
    if (requestedEndUs <= requestedStartUs) {
      throw ClipStoreException("The detected motion window is invalid.")
    }

    var actualStartUs = requestedStartUs
    val extractor = MediaExtractor()
    var muxer: MediaMuxer? = null
    try {
      extractor.setDataSource(observation.absolutePath)
      val videoTrack = (0 until extractor.trackCount).firstOrNull { index ->
        extractor.getTrackFormat(index)
          .getString(MediaFormat.KEY_MIME)
          ?.startsWith("video/") == true
      } ?: throw ClipStoreException("The camera recording contains no video track.")
      val inputFormat = extractor.getTrackFormat(videoTrack)
      extractor.selectTrack(videoTrack)
      extractor.seekTo(requestedStartUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
      actualStartUs = extractor.sampleTime.takeIf { it >= 0 } ?: requestedStartUs

      muxer = MediaMuxer(destination.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      if (inputFormat.containsKey(MediaFormat.KEY_ROTATION)) {
        muxer.setOrientationHint(inputFormat.getInteger(MediaFormat.KEY_ROTATION))
      }
      val outputTrack = muxer.addTrack(inputFormat)
      muxer.start()

      val capacity = if (inputFormat.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) {
        inputFormat.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE).coerceAtLeast(DEFAULT_BUFFER_BYTES)
      } else {
        DEFAULT_BUFFER_BYTES
      }
      val buffer = ByteBuffer.allocateDirect(capacity)
      val info = MediaCodec.BufferInfo()
      while (true) {
        val sampleTimeUs = extractor.sampleTime
        if (sampleTimeUs < 0 || sampleTimeUs > requestedEndUs) break
        buffer.clear()
        val sampleSize = extractor.readSampleData(buffer, 0)
        if (sampleSize < 0) break
        info.offset = 0
        info.size = sampleSize
        info.presentationTimeUs = (sampleTimeUs - actualStartUs).coerceAtLeast(0)
        // MediaExtractor and MediaCodec use different flag domains. Camera
        // samples only need their real sync-frame bit carried into the muxer;
        // forwarding the raw extractor value can mislabel encryption/partial
        // flags as codec configuration or end-of-stream markers.
        info.flags = if (
          extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0
        ) {
          MediaCodec.BUFFER_FLAG_KEY_FRAME
        } else {
          0
        }
        muxer.writeSampleData(outputTrack, buffer, info)
        if (!extractor.advance()) break
      }
    } catch (error: Throwable) {
      removeIfPresent(destination)
      if (error is ClipStoreException) throw error
      throw ClipStoreException("The captured motion window could not be prepared.", error)
    } finally {
      extractor.release()
      try {
        muxer?.stop()
      } catch (_: Throwable) {
        removeIfPresent(destination)
      }
      try {
        muxer?.release()
      } catch (_: Throwable) {
        // Release is best-effort after a failed codec/muxer operation.
      }
    }

    if (!destination.exists() || destination.length() <= 0) {
      removeIfPresent(destination)
      throw ClipStoreException("The captured motion window is empty.")
    }

    try {
      val base = measuredPayload(destination, "automatic_pose_trigger")
      val durationMs = base.getLong("durationMs")
      val actualSourceStartMs = recordingStartTimestampMs + actualStartUs / 1_000
      val triggerStartMs = (event.startMs - actualSourceStartMs).coerceIn(0, durationMs)
      val triggerEndMs = (event.endMs - actualSourceStartMs)
        .coerceIn(triggerStartMs, durationMs)
      val trigger = JSONObject()
        .put("startMs", triggerStartMs)
        .put("endMs", triggerEndMs)
        .put("confidence", event.confidence)
        .put("source", "temporal_pose_motion")
        .put("modelVersion", TemporalMotionDetector.MODEL_VERSION)
      trigger.put(
        "peakMotionMs",
        (event.peakMotionMs - actualSourceStartMs).coerceIn(triggerStartMs, triggerEndMs),
      )
      base
        .put("preRollMs", triggerStartMs)
        .put("postRollMs", (durationMs - triggerEndMs).coerceAtLeast(0))
        .put("trigger", trigger)
        .put("captureEvidence", captureEvidencePayload(captureEvidence))
        .put("ballSpeed", unavailableBallSpeed("calibrated_ball_tracker_unavailable"))
        .put(
          "recognition",
          JSONObject()
            .put("status", "unknown")
            .put("reason", "validated_classifier_unavailable"),
        )
      writePoseSequenceSidecar(
        clipFile = destination,
        clipMetadata = base,
        poseHistory = poseHistory,
        poseModelVersion = poseModelVersion,
        windowStartTimestampMs = actualSourceStartMs,
        windowEndTimestampMs = actualSourceStartMs + durationMs,
      )?.let { base.put("poseSequence", it) }
      removeIfPresent(observation)
      return base
    } catch (error: Throwable) {
      removeIfPresent(destination)
      if (error is ClipStoreException) throw error
      throw ClipStoreException("The saved clip metadata could not be measured.", error)
    }
  }

  /**
   * Writes the measured pose sequence beside the clip in the canonical
   * framework-neutral wire format (`pickle.pose-sequence.v1`) so any future
   * model can reprocess this capture. Timestamps become clip-relative. When
   * no frames landed inside the window, no sidecar is written — an honest
   * absence, never an empty fabrication.
   */
  private fun writePoseSequenceSidecar(
    clipFile: File,
    clipMetadata: JSONObject,
    poseHistory: List<PoseFrame>,
    poseModelVersion: String,
    windowStartTimestampMs: Long,
    windowEndTimestampMs: Long,
  ): JSONObject? {
    val frames = JSONArray()
    var frameIndex = 0
    var previousTimestamp = Long.MIN_VALUE
    for (pose in poseHistory) {
      if (pose.timestampMs < windowStartTimestampMs || pose.timestampMs > windowEndTimestampMs) {
        continue
      }
      if (pose.timestampMs <= previousTimestamp) continue
      previousTimestamp = pose.timestampMs
      val landmarks = JSONArray()
      for (mark in pose.landmarks) {
        landmarks.put(
          JSONObject()
            .put("n", mark.name)
            .put("x", mark.x)
            .put("y", mark.y)
            .put("v", mark.visibility),
        )
      }
      frames.put(
        JSONObject()
          .put("i", frameIndex)
          .put("t", pose.timestampMs - windowStartTimestampMs)
          .put("c", pose.confidence)
          .put("l", landmarks),
      )
      frameIndex += 1
    }
    if (frames.length() == 0) return null

    val document = JSONObject()
      .put("schemaVersion", 1)
      .put("format", "pickle.pose-sequence.v1")
      .put("coordinateSystem", "normalized_image_top_left")
      .put("poseModelVersion", poseModelVersion)
      .put(
        "video",
        JSONObject()
          .put("w", clipMetadata.getInt("width"))
          .put("h", clipMetadata.getInt("height"))
          .put("fps", clipMetadata.getDouble("fps")),
      )
      .put("frames", frames)
    val bytes = document.toString().toByteArray(Charsets.UTF_8)
    val sidecar = File(clipFile.parentFile, "${clipFile.nameWithoutExtension}.pose.json")
    FileOutputStream(sidecar).use { it.write(bytes) }
    val digest = java.security.MessageDigest.getInstance("SHA-256")
      .digest(bytes)
      .joinToString("") { "%02x".format(it) }

    return JSONObject()
      .put("schemaVersion", 1)
      .put("format", "pickle.pose-sequence.v1")
      .put("uri", Uri.fromFile(sidecar).toString())
      .put("frameCount", frames.length())
      .put("sha256", digest)
      .put("coordinateSystem", "normalized_image_top_left")
      .put("poseModelVersion", poseModelVersion)
  }

  private fun measuredPayload(
    file: File,
    captureMode: String,
    additional: Map<String, Any> = emptyMap(),
  ): JSONObject {
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(file.absolutePath)
      val durationMs = retriever
        .extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
        ?.toLongOrNull()
        ?.takeIf { it > 0 }
        ?: throw ClipStoreException("The video duration could not be measured.")
      var width = retriever
        .extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)
        ?.toIntOrNull()
        ?: 0
      var height = retriever
        .extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)
        ?.toIntOrNull()
        ?: 0
      val rotation = retriever
        .extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)
        ?.toIntOrNull()
        ?: 0
      if (rotation == 90 || rotation == 270) {
        val originalWidth = width
        width = height
        height = originalWidth
      }
      if (width <= 0 || height <= 0) {
        throw ClipStoreException("The video dimensions could not be measured.")
      }
      val fps = retriever
        .extractMetadata(MediaMetadataRetriever.METADATA_KEY_CAPTURE_FRAMERATE)
        ?.toDoubleOrNull()
        ?.takeIf { it.isFinite() && it >= 0 }
        ?: 0.0

      return JSONObject()
        .put("uri", Uri.fromFile(file).toString())
        .put("durationMs", durationMs)
        .put("fps", fps)
        .put("width", width)
        .put("height", height)
        .put("byteSize", file.length())
        .put("capturedAtIso", iso8601Now())
        .put("captureMode", captureMode)
        .also { payload -> additional.forEach(payload::put) }
    } catch (error: Throwable) {
      if (error is ClipStoreException) throw error
      throw ClipStoreException("The selected file is not a supported video.", error)
    } finally {
      retriever.release()
    }
  }

  private fun captureEvidencePayload(evidence: CaptureEvidenceSummary): JSONObject {
    val jointMotion = JSONArray()
    evidence.jointMotion.forEach { measurement ->
      jointMotion.put(
        JSONObject()
          .put("joint", measurement.joint)
          .put("sampleCount", measurement.sampleCount)
          .put("meanNormalizedPerSecond", measurement.meanNormalizedPerSecond)
          .put("peakNormalizedPerSecond", measurement.peakNormalizedPerSecond),
      )
    }
    return JSONObject()
      .put("schemaVersion", evidence.schemaVersion)
      .put("window", evidence.window)
      .put("poseSource", evidence.poseSource)
      .put("poseModelVersion", evidence.poseModelVersion)
      .put("triggerAlgorithmVersion", evidence.triggerAlgorithmVersion)
      .put("motionUnit", evidence.motionUnit)
      .put("analysisInputFrameCount", evidence.analysisInputFrameCount)
      .put("poseFrameCount", evidence.poseFrameCount)
      .put("poseMissingFrameCount", evidence.poseMissingFrameCount)
      .put("trackedDurationMs", evidence.trackedDurationMs)
      .put("meanCanonicalJointVisibility", evidence.meanCanonicalJointVisibility)
      .put("meanJointCoverage", evidence.meanJointCoverage)
      .put("minimumJointCoverage", evidence.minimumJointCoverage)
      .put("fullBodyVisibleFrameCount", evidence.fullBodyVisibleFrameCount)
      .put("jointMotion", jointMotion)
  }

  private fun unavailableBallSpeed(reason: String): JSONObject = JSONObject()
    .put("status", "unavailable")
    .put("reason", reason)

  private fun capturesDirectory(context: Context): File {
    val directory = File(context.filesDir, "captures")
    if (!directory.exists() && !directory.mkdirs()) {
      throw ClipStoreException("A private captures directory could not be created.")
    }
    return directory
  }

  private fun safeImportExtension(context: Context, source: Uri): String {
    var displayName: String? = null
    context.contentResolver.query(
      source,
      arrayOf(OpenableColumns.DISPLAY_NAME),
      null,
      null,
      null,
    )?.use { cursor ->
      if (cursor.moveToFirst()) displayName = cursor.getString(0)
    }
    val extension = displayName
      ?.substringAfterLast('.', missingDelimiterValue = "")
      ?.lowercase()
    val mimeExtension = MimeTypeMap.getSingleton()
      .getExtensionFromMimeType(context.contentResolver.getType(source))
      ?.lowercase()
    return extension?.takeIf(SAFE_VIDEO_EXTENSIONS::contains)
      ?: mimeExtension?.takeIf(SAFE_VIDEO_EXTENSIONS::contains)
      ?: "mp4"
  }

  private const val DEFAULT_BUFFER_BYTES = 8 * 1024 * 1024
  private val SAFE_VIDEO_EXTENSIONS = setOf("mp4", "mov", "m4v", "webm", "3gp", "mkv")
}
