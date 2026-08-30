package com.picklesensei.camera

import android.content.Context
import android.graphics.Color
import android.graphics.SurfaceTexture
import android.media.MediaPlayer
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.Surface
import android.view.TextureView
import android.widget.FrameLayout
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.events.Event

/**
 * Inline video player for the on-device captured clip.
 *
 * Renders REAL frames from the private capture file. Playback is muted and
 * local-only: nothing here uploads or copies the clip. JS drives `playing`
 * and `seekMs`; real positions are mirrored back through onClipProgress.
 */
class ClipPlayerView(context: Context) : FrameLayout(context) {

  private val textureView = TextureView(context)
  private var player: MediaPlayer? = null
  private var surface: Surface? = null
  private var sourceUri: String? = null
  private var prepared = false
  private var playWhenReady = false
  private var pendingSeekMs = -1.0
  private var lastSeekMs = -1.0

  private val progressHandler = Handler(Looper.getMainLooper())
  private val progressTick = object : Runnable {
    override fun run() {
      val active = player ?: return
      if (prepared && active.isPlaying) {
        emit("onClipProgress") { putDouble("positionMs", active.currentPosition.toDouble()) }
        progressHandler.postDelayed(this, 33L)
      }
    }
  }

  init {
    setBackgroundColor(Color.BLACK)
    textureView.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
      override fun onSurfaceTextureAvailable(texture: SurfaceTexture, width: Int, height: Int) {
        surface = Surface(texture)
        player?.setSurface(surface)
      }

      override fun onSurfaceTextureSizeChanged(texture: SurfaceTexture, width: Int, height: Int) = Unit

      override fun onSurfaceTextureDestroyed(texture: SurfaceTexture): Boolean {
        player?.setSurface(null)
        surface?.release()
        surface = null
        return true
      }

      override fun onSurfaceTextureUpdated(texture: SurfaceTexture) = Unit
    }
    addView(
      textureView,
      LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT),
    )
  }

  fun setSourceUri(uri: String?) {
    if (uri == sourceUri) return
    sourceUri = uri
    releasePlayer()
    if (uri.isNullOrBlank()) return
    val mediaPlayer = MediaPlayer()
    player = mediaPlayer
    prepared = false
    try {
      mediaPlayer.setDataSource(context, Uri.parse(uri))
      mediaPlayer.setVolume(0f, 0f)
      surface?.let { mediaPlayer.setSurface(it) }
      mediaPlayer.setOnPreparedListener { mp ->
        prepared = true
        emit("onClipLoad") { putDouble("durationMs", mp.duration.toDouble()) }
        if (pendingSeekMs >= 0) {
          seekInternal(pendingSeekMs)
          pendingSeekMs = -1.0
        }
        if (playWhenReady) startPlayback()
      }
      mediaPlayer.setOnCompletionListener {
        progressHandler.removeCallbacks(progressTick)
        emit("onClipEnd") {}
      }
      mediaPlayer.setOnErrorListener { _, _, _ ->
        // A frame that cannot decode is reported as an ended clip; the JS
        // side keeps its measured-timeline fallback. Never a crash.
        emit("onClipEnd") {}
        true
      }
      mediaPlayer.prepareAsync()
    } catch (_: Exception) {
      releasePlayer()
    }
  }

  fun setPlaying(playing: Boolean) {
    playWhenReady = playing
    val active = player ?: return
    if (!prepared) return
    if (playing) {
      startPlayback()
    } else if (active.isPlaying) {
      active.pause()
      progressHandler.removeCallbacks(progressTick)
    }
  }

  fun setSeekMs(ms: Double) {
    if (ms < 0 || ms == lastSeekMs) return
    lastSeekMs = ms
    if (!prepared) {
      pendingSeekMs = ms
      return
    }
    seekInternal(ms)
  }

  fun release() {
    releasePlayer()
    surface?.release()
    surface = null
  }

  private fun startPlayback() {
    val active = player ?: return
    if (active.duration in 1..active.currentPosition + 50) active.seekTo(0)
    active.start()
    progressHandler.removeCallbacks(progressTick)
    progressHandler.post(progressTick)
  }

  private fun seekInternal(ms: Double) {
    val active = player ?: return
    if (android.os.Build.VERSION.SDK_INT >= 26) {
      active.seekTo(ms.toLong(), MediaPlayer.SEEK_CLOSEST)
    } else {
      active.seekTo(ms.toInt())
    }
  }

  private fun releasePlayer() {
    progressHandler.removeCallbacks(progressTick)
    prepared = false
    player?.release()
    player = null
  }

  private fun emit(name: String, build: WritableMap.() -> Unit) {
    val reactContext = context as? ReactContext ?: return
    val dispatcher =
      UIManagerHelper.getEventDispatcherForReactTag(reactContext, id) ?: return
    val surfaceId = UIManagerHelper.getSurfaceId(reactContext)
    dispatcher.dispatchEvent(
      ClipPlayerEvent(surfaceId, id, name, Arguments.createMap().apply(build)),
    )
  }
}

private class ClipPlayerEvent(
  surfaceId: Int,
  viewId: Int,
  private val name: String,
  private val payload: WritableMap,
) : Event<ClipPlayerEvent>(surfaceId, viewId) {
  override fun getEventName(): String = name

  override fun getEventData(): WritableMap = payload
}
