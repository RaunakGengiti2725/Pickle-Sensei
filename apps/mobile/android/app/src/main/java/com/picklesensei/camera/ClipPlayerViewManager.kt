package com.picklesensei.camera

import com.facebook.react.common.MapBuilder
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

/** Exposes ClipPlayerView to JS as <PickleClipPlayerView /> (interop). */
class ClipPlayerViewManager : SimpleViewManager<ClipPlayerView>() {

  override fun getName(): String = "PickleClipPlayerView"

  override fun createViewInstance(reactContext: ThemedReactContext): ClipPlayerView =
    ClipPlayerView(reactContext)

  override fun onDropViewInstance(view: ClipPlayerView) {
    super.onDropViewInstance(view)
    view.release()
  }

  @ReactProp(name = "sourceUri")
  fun setSourceUri(view: ClipPlayerView, uri: String?) {
    view.setSourceUri(uri)
  }

  @ReactProp(name = "playing")
  fun setPlaying(view: ClipPlayerView, playing: Boolean) {
    view.setPlaying(playing)
  }

  @ReactProp(name = "seekMs", defaultDouble = -1.0)
  fun setSeekMs(view: ClipPlayerView, seekMs: Double) {
    view.setSeekMs(seekMs)
  }

  override fun getExportedCustomDirectEventTypeConstants(): Map<String, Any> =
    MapBuilder.of(
      "onClipProgress",
      MapBuilder.of("registrationName", "onClipProgress"),
      "onClipLoad",
      MapBuilder.of("registrationName", "onClipLoad"),
      "onClipEnd",
      MapBuilder.of("registrationName", "onClipEnd"),
    )
}
