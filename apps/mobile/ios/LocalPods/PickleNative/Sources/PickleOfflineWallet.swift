import Foundation
import React
import os

private let offlineWalletLogger = Logger(
  subsystem: Bundle.main.bundleIdentifier ?? "com.picklesensei",
  category: "OfflineWallet"
)

/// React Native surface of `OfflineWallet` (Sources/Core/OfflineWallet.swift):
/// Keychain-backed signed grants and unsent receipts, one atomic item write
/// per replace, revision fencing, tamper detection. All calls run on one
/// serial queue so JS never races two writes for the same owner. Rejections
/// carry the stable code `wallet.<failure>` (see `OfflineWalletFailure`),
/// a non-secret message, and an NSError whose `code` is the Keychain
/// `OSStatus` when one was involved (0 otherwise).
@objc(PickleOfflineWallet)
final class PickleOfflineWallet: NSObject {
  private let queue = DispatchQueue(label: "com.picklesensei.offline.wallet", qos: .userInitiated)
  private let wallet = OfflineWallet(store: KeychainOfflineWalletStore())

  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc func loadWallet(
    _ ownerId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    perform("load", resolve: resolve, reject: reject) {
      guard let snapshot = try wallet.load(ownerId: ownerId) else { return NSNull() }
      return snapshot.bridgePayload()
    }
  }

  @objc func replaceWallet(
    _ ownerId: String,
    expectedRevision: NSNumber,
    contents: NSDictionary,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    perform("replace", resolve: resolve, reject: reject) {
      let revision = try OfflineWallet.revision(fromBridge: expectedRevision.doubleValue)
      let parsed = try OfflineWalletContents(bridgePayload: (contents as? [String: Any]) ?? [:])
      return try wallet.replace(ownerId: ownerId, expectedRevision: revision, contents: parsed).bridgePayload()
    }
  }

  @objc func clearWallet(
    _ ownerId: String,
    expectedRevision: NSNumber,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    perform("clear", resolve: resolve, reject: reject) {
      let revision = try OfflineWallet.revision(fromBridge: expectedRevision.doubleValue)
      try wallet.clear(ownerId: ownerId, expectedRevision: revision)
      return NSNull()
    }
  }

  @objc func discardCorruptWallet(
    _ ownerId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    perform("discard_corrupt", resolve: resolve, reject: reject) {
      try wallet.discardCorrupt(ownerId: ownerId).rawValue
    }
  }

  private func perform(
    _ operation: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock,
    _ body: @escaping () throws -> Any
  ) {
    queue.async {
      do {
        resolve(try body())
      } catch let error as OfflineWalletError {
        offlineWalletLogger.error(
          "op=\(operation, privacy: .public) code=\(error.failure.code, privacy: .public) status=\(Int(error.status ?? 0), privacy: .public)"
        )
        reject(error.failure.code, error.detail, PickleOfflineWallet.nsError(for: error))
      } catch {
        let failure = OfflineWalletFailure.storageFailure
        offlineWalletLogger.error("op=\(operation, privacy: .public) code=\(failure.code, privacy: .public) unexpected")
        reject(failure.code, "offline wallet operation failed", error)
      }
    }
  }

  private static func nsError(for error: OfflineWalletError) -> NSError {
    var userInfo: [String: Any] = [
      NSLocalizedDescriptionKey: error.detail,
      "failure": error.failure.rawValue,
    ]
    if let status = error.status {
      userInfo["status"] = Int(status)
    }
    return NSError(domain: "PickleOfflineWallet", code: Int(error.status ?? 0), userInfo: userInfo)
  }
}
