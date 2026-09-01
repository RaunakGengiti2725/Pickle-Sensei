import Foundation
import React
import StoreKit
import UIKit

/// In-app App Store rating request. Hands the ask to StoreKit; iOS alone
/// decides whether the sheet actually appears (at most ~3 prompts per 365
/// days, silenced entirely once the person has rated or reviewed the app on
/// this device — Apple's own "stop after review" behavior). Resolves true
/// when the request was submitted to StoreKit, false when no window scene
/// exists to present from. Never rejects: a missing prompt is not an error.
@objc(PickleStoreReview)
class PickleStoreReview: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { true }

  @objc func requestReview(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      let scenes = UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
      guard
        let scene = scenes.first(where: { $0.activationState == .foregroundActive })
          ?? scenes.first
      else {
        resolve(false)
        return
      }
      if #available(iOS 16.0, *) {
        // StoreKit 2 replacement for the UIKit path (SKStoreReviewController
        // is deprecated as of iOS 18).
        AppStore.requestReview(in: scene)
      } else {
        SKStoreReviewController.requestReview(in: scene)
      }
      resolve(true)
    }
  }
}
