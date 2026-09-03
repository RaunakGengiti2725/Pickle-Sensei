package com.picklesensei.camera

import android.content.Context
import android.graphics.Color
import android.graphics.Matrix
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
 * local-only: nothing here uploads or copies the clip. JS drives `playing`,
 * `seekMs`, `rate` and `resizeMode`; real positions are mirrored back
 * through onClipProgress.
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
  /** 'cover' keeps the historical fill behavior; 'contain' letterboxes. */
  private var resizeMode = "cover"
  /** Playback speed (1 = real time); applied only while playing. */
  private var rate = 1f
  private var videoWidth = 0
  private var videoHeight = 0

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
        applyTransform()
      }

      override fun onSurfaceTextureSizeChanged(texture: SurfaceTexture, width: Int, height: Int) {
        applyTransform()
      }

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

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    applyTransform()
  }

  fun setSourceUri(uri: String?) {
    if (uri == sourceUri) return
    sourceUri = uri
    releasePlayer()
    if (uri.isNullOrBlank()) return
    val mediaPlayer = MediaPlayer()
    player = mediaPlayer
    prepared = false
    videoWidth = 0
    videoHeight = 0
    try {
      mediaPlayer.setDataSource(context, Uri.parse(uri))
      mediaPlayer.setVolume(0f, 0f)
      surface?.let { mediaPlayer.setSurface(it) }
      mediaPlayer.setOnPreparedListener { mp ->
        prepared = true
        videoWidth = mp.videoWidth
        videoHeight = mp.videoHeight
        applyTransform()
        emit("onClipLoad") { putDouble("durationMs", mp.duration.toDouble()) }
        if (pendingSeekMs >= 0) {
          seekInternal(pendingSeekMs)
          pendingSeekMs = -1.0
        }
        if (playWhenReady) startPlayback()
      }
      mediaPlayer.setOnVideoSizeChangedListener { _, width, height ->
        videoWidth = width
        videoHeight = height
        applyTransform()
      }
      mediaPlayer.setOnCompletionListener {
        progressHandler.removeCallbacks(progressTick)
        emit("onClipEnd") {}
      }
      mediaPlayer.setOnErrorListener { _, what, extra ->
        // A clip that cannot open or decode is reported as such (the JS side
        // says so instead of showing a black surface) and as an ended clip so
        // its measured-timeline fallback still settles. Never a crash.
        emit("onClipError") { putString("message", "MediaPlayer error $what/$extra") }
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

  /** 'contain' letterboxes the frame inside the view; anything else is 'cover'. */
  fun setResizeMode(mode: String?) {
    val next = if (mode == "contain") "contain" else "cover"
    if (next == resizeMode) return
    resizeMode = next
    applyTransform()
  }

  /**
   * Playback speed. `setPlaybackParams` starts playback on a prepared player,
   * so the speed is only pushed to MediaPlayer while it is already playing;
   * otherwise it is remembered and applied by the next start.
   */
  fun setRate(value: Double) {
    val next = if (value.isFinite() && value > 0) value.toFloat() else 1f
    if (next == rate) return
    rate = next
    val active = player ?: return
    if (prepared && active.isPlaying) applyRate(active)
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
    applyRate(active)
    progressHandler.removeCallbacks(progressTick)
    progressHandler.post(progressTick)
  }

  private fun applyRate(active: MediaPlayer) {
    if (android.os.Build.VERSION.SDK_INT < 23) return
    try {
      active.playbackParams = active.playbackParams.setSpeed(rate)
    } catch (_: Exception) {
      // Unsupported speed for this codec/state: real-time playback continues.
    }
  }

  /**
   * The TextureView fills the view; MediaPlayer stretches the frame to it.
   * For 'contain' a scale about the view center shrinks one axis so the
   * frame keeps its aspect ratio, centered and letterboxed. 'cover' keeps
   * the historical identity transform.
   */
  private fun applyTransform() {
    val viewWidth = width.toFloat()
    val viewHeight = height.toFloat()
    val matrix = Matrix()
    if (
      resizeMode == "contain" &&
      videoWidth > 0 &&
      videoHeight > 0 &&
      viewWidth > 0f &&
      viewHeight > 0f
    ) {
      val viewAspect = viewWidth / viewHeight
      val videoAspect = videoWidth.toFloat() / videoHeight.toFloat()
      val scaleX: Float
      val scaleY: Float
      if (videoAspect > viewAspect) {
        // Wider than the view: full width, letterbox top and bottom.
        scaleX = 1f
        scaleY = viewAspect / videoAspect
      } else {
        // Taller than the view: full height, pillarbox left and right.
        scaleX = videoAspect / viewAspect
        scaleY = 1f
      }
      matrix.setScale(scaleX, scaleY, viewWidth / 2f, viewHeight / 2f)
    }
    textureView.setTransform(matrix)
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
