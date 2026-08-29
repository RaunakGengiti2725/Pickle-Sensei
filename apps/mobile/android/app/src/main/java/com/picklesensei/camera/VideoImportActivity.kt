package com.picklesensei.camera

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import com.picklesensei.R
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

internal class VideoImportActivity : ComponentActivity(), CameraOperationRegistry.ActiveOperation {
  private val captureId = UUID.randomUUID().toString().lowercase()
  private val terminal = AtomicBoolean(false)
  private val worker = Executors.newSingleThreadExecutor()
  private var persistedFile: File? = null

  private val picker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
    if (terminal.get()) return@registerForActivityResult
    if (uri == null) {
      fail(
        code = "camera.cancelled",
        message = "Video import was canceled.",
        abstention = "user_cancelled",
      )
      return@registerForActivityResult
    }

    CameraOperationRegistry.emit("import", captureId, mapOf("state" to "copying"))
    worker.execute {
      try {
        val file = AndroidClipStore.persistImportedVideo(this, uri)
        persistedFile = file
        val payload = AndroidClipStore.importedPayload(file)
        runOnUiThread {
          if (terminal.compareAndSet(false, true)) {
            CameraOperationRegistry.emit("import", captureId, mapOf("state" to "completed"))
            setResult(
              Activity.RESULT_OK,
              Intent().putExtra(PickleVideoCaptureModule.EXTRA_RESULT_JSON, payload.toString()),
            )
            finish()
          } else {
            AndroidClipStore.removeIfPresent(file)
          }
        }
      } catch (error: Throwable) {
        runOnUiThread {
          fail(
            code = "camera.import_failed",
            message = error.message ?: "The selected video could not be imported.",
            abstention = "import_failure",
          )
        }
      }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    CameraOperationRegistry.register(this)
    setContentView(buildLoadingView())
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() = cancelFromBridge()
    })
    CameraOperationRegistry.emit("import", captureId, mapOf("state" to "selecting"))
    picker.launch(arrayOf("video/*"))
  }

  override fun cancelFromBridge() {
    runOnUiThread {
      fail(
        code = "camera.cancelled",
        message = "Video import was canceled.",
        abstention = "user_cancelled",
      )
    }
  }

  override fun onDestroy() {
    CameraOperationRegistry.unregister(this)
    worker.shutdownNow()
    super.onDestroy()
  }

  private fun fail(code: String, message: String, abstention: String) {
    if (!terminal.compareAndSet(false, true)) return
    AndroidClipStore.removeIfPresent(persistedFile)
    CameraOperationRegistry.emit(
      "abstained",
      captureId,
      mapOf("reason" to abstention, "message" to message),
    )
    setResult(
      Activity.RESULT_CANCELED,
      Intent()
        .putExtra(PickleVideoCaptureModule.EXTRA_ERROR_CODE, code)
        .putExtra(PickleVideoCaptureModule.EXTRA_ERROR_MESSAGE, message),
    )
    finish()
  }

  private fun buildLoadingView(): FrameLayout {
    val root = FrameLayout(this).apply { setBackgroundColor(Color.rgb(6, 19, 14)) }
    val progress = ProgressBar(this).apply {
      isIndeterminate = true
      indeterminateTintList = android.content.res.ColorStateList.valueOf(Color.rgb(215, 250, 69))
    }
    root.addView(progress, FrameLayout.LayoutParams(dp(44), dp(44), Gravity.CENTER))
    val label = TextView(this).apply {
      text = getString(R.string.video_import_preparing_private)
      setTextColor(Color.WHITE)
      textSize = 15f
      gravity = Gravity.CENTER
      typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
    }
    root.addView(
      label,
      FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        dp(56),
        Gravity.CENTER,
      ).apply { topMargin = dp(82); marginStart = dp(24); marginEnd = dp(24) },
    )
    return root
  }

  private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
}
