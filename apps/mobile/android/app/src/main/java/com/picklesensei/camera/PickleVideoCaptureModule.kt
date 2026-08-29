package com.picklesensei.camera

import android.app.Activity
import android.content.Intent
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONArray
import org.json.JSONObject

internal class PickleVideoCaptureModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext), ActivityEventListener {
  private var pendingPromise: Promise? = null
  private var pendingRequestCode: Int? = null
  @Volatile private var listenerCount = 0

  init {
    reactContext.addActivityEventListener(this)
    CameraOperationRegistry.setEventSink(::emitEvent)
  }

  override fun getName() = "PickleVideoCapture"

  @ReactMethod
  fun capture(promise: Promise) {
    launch(GuidedCaptureActivity::class.java, REQUEST_CAPTURE, promise)
  }

  @ReactMethod
  fun importVideo(promise: Promise) {
    launch(VideoImportActivity::class.java, REQUEST_IMPORT, promise)
  }

  @ReactMethod
  @Synchronized
  fun cancel() {
    // Ignore cleanup calls when no operation exists; otherwise a stale cancel
    // could be consumed by the next camera screen.
    if (pendingPromise != null) CameraOperationRegistry.requestCancellation()
  }

  /**
   * Reads a capture artifact (e.g. a pose-sequence sidecar) as UTF-8 text.
   * Restricted to the app's private capture storage — this is an artifact
   * reader for the analysis pipeline, not a general file API.
   */
  @ReactMethod
  fun readTextFile(uri: String, promise: Promise) {
    Thread {
      try {
        val parsed = android.net.Uri.parse(uri)
        if (parsed.scheme != "file" || parsed.path.isNullOrEmpty()) {
          promise.reject("file.invalid_uri", "Only file:// URIs can be read.")
          return@Thread
        }
        val requested = java.io.File(parsed.path!!).canonicalFile
        val capturesRoot = java.io.File(reactContext.filesDir, "captures").canonicalFile
        if (!requested.path.startsWith(capturesRoot.path + java.io.File.separator)) {
          promise.reject(
            "file.outside_captures",
            "Only private capture artifacts can be read.",
          )
          return@Thread
        }
        promise.resolve(requested.readText(Charsets.UTF_8))
      } catch (error: Throwable) {
        promise.reject("file.read_failed", "The capture artifact could not be read.", error)
      }
    }.start()
  }

  // Required by NativeEventEmitter. React Native owns subscription lifecycle.
  @ReactMethod
  fun addListener(eventType: String) {
    if (eventType == EVENT_NAME) listenerCount += 1
  }

  @ReactMethod
  fun removeListeners(count: Int) {
    listenerCount = (listenerCount - count).coerceAtLeast(0)
  }

  @Synchronized
  private fun launch(activityClass: Class<out Activity>, requestCode: Int, promise: Promise) {
    if (pendingPromise != null) {
      promise.reject("camera.busy", "Another camera operation is already active.")
      return
    }
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.reject("camera.presentation_failed", "The camera cannot open without an active screen.")
      return
    }
    pendingPromise = promise
    pendingRequestCode = requestCode
    try {
      activity.startActivityForResult(Intent(activity, activityClass), requestCode)
    } catch (error: Throwable) {
      clearPending()?.reject(
        "camera.presentation_failed",
        "The native camera screen could not be opened.",
        error,
      )
    }
  }

  override fun onActivityResult(
    activity: Activity,
    requestCode: Int,
    resultCode: Int,
    data: Intent?,
  ) {
    if (requestCode != pendingRequestCode) return
    val promise = clearPending() ?: return
    if (resultCode == Activity.RESULT_OK) {
      val json = data?.getStringExtra(EXTRA_RESULT_JSON)
      if (json == null) {
        promise.reject("camera.invalid_result", "The native camera returned no measured clip.")
        return
      }
      try {
        promise.resolve(jsonObjectToWritable(JSONObject(json)))
      } catch (error: Throwable) {
        promise.reject("camera.invalid_result", "The native camera result was malformed.", error)
      }
      return
    }
    val code = data?.getStringExtra(EXTRA_ERROR_CODE) ?: "camera.cancelled"
    val message = data?.getStringExtra(EXTRA_ERROR_MESSAGE) ?: "The camera operation was canceled."
    promise.reject(code, message)
  }

  override fun onNewIntent(intent: Intent) = Unit

  @Synchronized
  private fun clearPending(): Promise? {
    val promise = pendingPromise
    pendingPromise = null
    pendingRequestCode = null
    return promise
  }

  private fun emitEvent(payload: Map<String, Any?>) {
    if (listenerCount <= 0 || !reactContext.hasActiveReactInstance()) return
    reactContext.runOnUiQueueThread {
      if (listenerCount <= 0 || !reactContext.hasActiveReactInstance()) return@runOnUiQueueThread
      reactContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(EVENT_NAME, mapToWritable(payload))
    }
  }

  override fun invalidate() {
    CameraOperationRegistry.setEventSink(null)
    reactContext.removeActivityEventListener(this)
    val pending = clearPending()
    if (pending != null) {
      CameraOperationRegistry.requestCancellation()
      pending.reject("camera.bridge_invalidated", "The camera bridge was reloaded.")
    }
    super.invalidate()
  }

  companion object {
    const val EXTRA_RESULT_JSON = "com.picklesensei.camera.RESULT_JSON"
    const val EXTRA_ERROR_CODE = "com.picklesensei.camera.ERROR_CODE"
    const val EXTRA_ERROR_MESSAGE = "com.picklesensei.camera.ERROR_MESSAGE"

    private const val REQUEST_CAPTURE = 7_301
    private const val REQUEST_IMPORT = 7_302
    private const val EVENT_NAME = "PickleCameraEvent"

    private fun jsonObjectToWritable(value: JSONObject): WritableMap {
      val output = Arguments.createMap()
      val keys = value.keys()
      while (keys.hasNext()) {
        val key = keys.next()
        putWritable(output, key, value.opt(key))
      }
      return output
    }

    private fun jsonArrayToWritable(value: JSONArray): WritableArray {
      val output = Arguments.createArray()
      for (index in 0 until value.length()) {
        when (val item = value.opt(index)) {
          null, JSONObject.NULL -> output.pushNull()
          is Boolean -> output.pushBoolean(item)
          is Int -> output.pushInt(item)
          is Long -> output.pushDouble(item.toDouble())
          is Number -> output.pushDouble(item.toDouble())
          is String -> output.pushString(item)
          is JSONObject -> output.pushMap(jsonObjectToWritable(item))
          is JSONArray -> output.pushArray(jsonArrayToWritable(item))
          else -> output.pushString(item.toString())
        }
      }
      return output
    }

    private fun putWritable(output: WritableMap, key: String, item: Any?) {
      when (item) {
        null, JSONObject.NULL -> output.putNull(key)
        is Boolean -> output.putBoolean(key, item)
        is Int -> output.putInt(key, item)
        is Long -> output.putDouble(key, item.toDouble())
        is Number -> output.putDouble(key, item.toDouble())
        is String -> output.putString(key, item)
        is JSONObject -> output.putMap(key, jsonObjectToWritable(item))
        is JSONArray -> output.putArray(key, jsonArrayToWritable(item))
        else -> output.putString(key, item.toString())
      }
    }

    private fun mapToWritable(value: Map<String, Any?>): WritableMap {
      val output = Arguments.createMap()
      for ((key, item) in value) putAny(output, key, item)
      return output
    }

    private fun putAny(output: WritableMap, key: String, item: Any?) {
      when (item) {
        null -> output.putNull(key)
        is Boolean -> output.putBoolean(key, item)
        is Int -> output.putInt(key, item)
        is Long -> output.putDouble(key, item.toDouble())
        is Float -> output.putDouble(key, item.toDouble())
        is Double -> output.putDouble(key, item)
        is String -> output.putString(key, item)
        is Map<*, *> -> {
          @Suppress("UNCHECKED_CAST")
          output.putMap(key, mapToWritable(item as Map<String, Any?>))
        }
        is List<*> -> {
          val array = Arguments.createArray()
          item.forEach { entry ->
            when (entry) {
              null -> array.pushNull()
              is Boolean -> array.pushBoolean(entry)
              is Int -> array.pushInt(entry)
              is Number -> array.pushDouble(entry.toDouble())
              is String -> array.pushString(entry)
              else -> array.pushString(entry.toString())
            }
          }
          output.putArray(key, array)
        }
        else -> output.putString(key, item.toString())
      }
    }
  }
}
