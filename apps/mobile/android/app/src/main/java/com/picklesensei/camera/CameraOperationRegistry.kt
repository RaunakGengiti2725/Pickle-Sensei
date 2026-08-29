package com.picklesensei.camera

import android.os.Handler
import android.os.Looper
import java.lang.ref.WeakReference
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Process-local handoff between the React Native bridge and the two native
 * activities. It deliberately carries only structured state, never frames.
 */
internal object CameraOperationRegistry {
  interface ActiveOperation {
    fun cancelFromBridge()
  }

  @Volatile
  private var activeOperation = WeakReference<ActiveOperation>(null)

  @Volatile
  private var cancellationRequested = false

  @Volatile
  private var eventSink: ((Map<String, Any?>) -> Unit)? = null

  private val mainHandler = Handler(Looper.getMainLooper())

  fun setEventSink(sink: ((Map<String, Any?>) -> Unit)?) {
    eventSink = sink
  }

  fun register(operation: ActiveOperation) {
    activeOperation = WeakReference(operation)
    if (cancellationRequested) {
      cancellationRequested = false
      mainHandler.post { operation.cancelFromBridge() }
    }
  }

  fun unregister(operation: ActiveOperation) {
    if (activeOperation.get() === operation) activeOperation.clear()
    cancellationRequested = false
  }

  fun requestCancellation() {
    val operation = activeOperation.get()
    if (operation == null) cancellationRequested = true
    else mainHandler.post { operation.cancelFromBridge() }
  }

  fun emit(type: String, captureId: String?, values: Map<String, Any?> = emptyMap()) {
    val payload = LinkedHashMap<String, Any?>(values.size + 3)
    payload.putAll(values)
    payload["type"] = type
    if (captureId != null) payload["captureId"] = captureId
    payload["emittedAtIso"] = iso8601Now()
    eventSink?.invoke(payload)
  }
}

/** API-24-safe UTC timestamp; avoids java.time, which starts at API 26. */
internal fun iso8601Now(): String = SimpleDateFormat(
  "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
  Locale.US,
).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())
