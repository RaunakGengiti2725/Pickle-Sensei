import AVFoundation
import React
import UIKit

/// Inline AVPlayer view for the on-device captured clip.
///
/// Renders REAL video frames from the private capture file (`file://` URL in
/// app storage). Playback is muted and local-only: nothing here uploads,
/// transcodes, or copies the clip. The JS ReplayCard / Form Review drive
/// `playing`, `seekMs`, `rate` and `resizeMode`, and mirror real positions
/// back through `onClipProgress`.
@objc(PickleClipPlayerView)
final class PickleClipPlayerView: UIView {
  private let player = AVPlayer()
  private var timeObserver: Any?
  private var endObserver: NSObjectProtocol?
  private var statusObservation: NSKeyValueObservation?
  private var currentUri: String?

  @objc var onClipProgress: RCTDirectEventBlock?
  @objc var onClipLoad: RCTDirectEventBlock?
  @objc var onClipEnd: RCTDirectEventBlock?

  override static var layerClass: AnyClass { AVPlayerLayer.self }
  private var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .black
    player.isMuted = true
    player.actionAtItemEnd = .pause
    playerLayer.player = player
    playerLayer.videoGravity = .resizeAspectFill

    timeObserver = player.addPeriodicTimeObserver(
      forInterval: CMTime(value: 1, timescale: 30),
      queue: .main
    ) { [weak self] time in
      guard let self, self.player.rate != 0, time.seconds.isFinite else { return }
      self.onClipProgress?(["positionMs": time.seconds * 1000.0])
    }
    endObserver = NotificationCenter.default.addObserver(
      forName: .AVPlayerItemDidPlayToEndTime,
      object: nil,
      queue: .main
    ) { [weak self] notification in
      guard
        let self,
        let item = notification.object as? AVPlayerItem,
        item === self.player.currentItem
      else { return }
      self.onClipEnd?([:])
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  deinit {
    if let timeObserver { player.removeTimeObserver(timeObserver) }
    if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
    statusObservation?.invalidate()
  }

  @objc var sourceUri: NSString? {
    didSet {
      let uri = sourceUri as String?
      guard uri != currentUri else { return }
      currentUri = uri
      statusObservation?.invalidate()
      statusObservation = nil
      guard let uri, let url = Self.fileUrl(from: uri) else {
        player.replaceCurrentItem(with: nil)
        return
      }
      let item = AVPlayerItem(url: url)
      statusObservation = item.observe(\.status, options: [.new]) { [weak self] observed, _ in
        guard let self, observed.status == .readyToPlay else { return }
        let seconds = observed.duration.seconds
        DispatchQueue.main.async {
          self.onClipLoad?([
            "durationMs": seconds.isFinite ? seconds * 1000.0 : 0,
          ])
        }
      }
      player.replaceCurrentItem(with: item)
    }
  }

  /// `AVPlayer.play()` always runs at 1.0, so playback starts by setting the
  /// rate directly (a non-zero rate starts playback at exactly that rate) and
  /// slow motion stays in effect across pause/resume.
  @objc var playing: Bool = false {
    didSet {
      guard playing != oldValue else { return }
      if playing {
        restartIfAtEnd()
        player.rate = playbackRate
      } else {
        player.pause()
      }
    }
  }

  /// Playback rate (1 = real time; 0.5 / 0.25 = slow motion). Applied
  /// immediately while playing; otherwise remembered for the next play.
  /// Non-positive or non-finite values fall back to real time.
  @objc var rate: Double = 1 {
    didSet {
      guard rate != oldValue, playing, player.rate != 0 else { return }
      player.rate = playbackRate
    }
  }

  /// 'cover' (default) crops to fill like before; 'contain' letterboxes so the
  /// whole frame — and any overlay drawn in video coordinates — is visible.
  @objc var resizeMode: NSString? {
    didSet {
      playerLayer.videoGravity =
        (resizeMode as String?) == "contain" ? .resizeAspect : .resizeAspectFill
    }
  }

  private var playbackRate: Float {
    guard rate.isFinite, rate > 0 else { return 1 }
    return Float(rate)
  }

  /// Seek request in clip milliseconds; negative values mean "no request".
  /// Every scrub move updates this, so paused scrubbing renders live frames.
  @objc var seekMs: Double = -1 {
    didSet {
      guard seekMs >= 0, seekMs != oldValue else { return }
      let time = CMTime(seconds: seekMs / 1000.0, preferredTimescale: 600)
      player.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero)
    }
  }

  private func restartIfAtEnd() {
    guard let item = player.currentItem, item.duration.seconds.isFinite else { return }
    if item.currentTime().seconds >= item.duration.seconds - 0.05 {
      player.seek(to: .zero, toleranceBefore: .zero, toleranceAfter: .zero)
    }
  }

  private static func fileUrl(from uri: String) -> URL? {
    if uri.hasPrefix("file://") { return URL(string: uri) }
    if uri.hasPrefix("/") { return URL(fileURLWithPath: uri) }
    return URL(string: uri)
  }
}

@objc(PickleClipPlayerViewManager)
final class PickleClipPlayerViewManager: RCTViewManager {
  override func view() -> UIView! { PickleClipPlayerView() }
  override static func requiresMainQueueSetup() -> Bool { true }
}
