import AVFoundation
import React
import UIKit

/// Live camera preview for an ACTIVE session capture (Live Court).
///
/// Renders the REAL AVCaptureSession the rolling session recording uses — no
/// second camera session, no synthetic frames — and draws the same body heat
/// map overlay guided capture uses, fed by the coordinator's measured poses.
/// When no active coordinator matches `sessionCaptureId` (session ended,
/// stale id), the surface stays black and reports `attached: false` through
/// `onPreviewState` so JS renders an honest state instead of pretending a
/// camera is live.
@objc(PickleSessionPreviewView)
final class PickleSessionPreviewView: UIView {
  private var previewLayer: AVCaptureVideoPreviewLayer?
  private let overlayView = PoseOverlayView()
  private weak var coordinator: SessionCaptureCoordinator?
  private var consecutivePoseMisses = 0
  /// Consecutive no-pose frames after which the heat map clears — the
  /// athlete left the frame; stale glows must not linger over empty court.
  private static let poseMissClearThreshold = 6

  @objc var onPreviewState: RCTDirectEventBlock?

  @objc var sessionCaptureId: NSString? {
    didSet {
      guard (sessionCaptureId as String?) != (oldValue as String?) else { return }
      attach()
    }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .black
    clipsToBounds = true
    overlayView.setCaptureState(.capturing)
    addSubview(overlayView)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  deinit {
    detachCoordinator()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    previewLayer?.frame = bounds
    CATransaction.commit()
    overlayView.frame = bounds
  }

  override func willMove(toWindow newWindow: UIWindow?) {
    super.willMove(toWindow: newWindow)
    if newWindow == nil { detachCoordinator() }
  }

  private func attach() {
    assert(Thread.isMainThread)
    detachCoordinator()
    previewLayer?.removeFromSuperlayer()
    previewLayer = nil
    overlayView.clear()

    guard
      let id = sessionCaptureId as String?, !id.isEmpty,
      let active = SessionCaptureCoordinator.active(withId: id)
    else {
      onPreviewState?(["attached": false])
      return
    }

    let layer = active.makePreviewLayer()
    layer.frame = bounds
    self.layer.insertSublayer(layer, at: 0)
    previewLayer = layer
    overlayView.previewLayer = layer

    coordinator = active
    consecutivePoseMisses = 0
    active.onPoseFrame = { [weak self] pose in
      DispatchQueue.main.async { self?.handlePoseFrame(pose) }
    }
    onPreviewState?(["attached": true])
  }

  private func detachCoordinator() {
    if let current = coordinator {
      current.onPoseFrame = nil
      coordinator = nil
    }
  }

  private func handlePoseFrame(_ pose: PoseFrame?) {
    guard let pose else {
      consecutivePoseMisses += 1
      if consecutivePoseMisses == Self.poseMissClearThreshold {
        overlayView.clear()
      }
      return
    }
    consecutivePoseMisses = 0
    overlayView.update(pose: pose)
  }
}

@objc(PickleSessionPreviewViewManager)
final class PickleSessionPreviewViewManager: RCTViewManager {
  override func view() -> UIView! { PickleSessionPreviewView() }
  override static func requiresMainQueueSetup() -> Bool { true }
}
