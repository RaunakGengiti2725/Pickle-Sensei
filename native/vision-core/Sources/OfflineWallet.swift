import Foundation

#if canImport(CryptoKit)
  import CryptoKit
#endif
#if canImport(Security)
  import Security
#endif

/// Offline wallet (W05): the device-side vault for signed offline execution
/// grants and receipts that have not yet reached the server. One Keychain
/// item per owner holds the whole wallet, so a replace is a single
/// SecItemUpdate — either the previous wallet or the new one is on disk,
/// never a mix. The item lives in its own `THIS_DEVICE_ONLY` service
/// (distinct from the session vault), is never synchronised, and carries an
/// HMAC over `(account, payload)` keyed by a per-installation random key in a
/// sibling item: flipped bytes, a wallet copied between owners, or a payload
/// whose key is gone are reported as typed failures — never as an empty
/// wallet, and never overwritten without an explicit discard after
/// reconciliation. Signature and policy verification of the grant itself is
/// the caller's job; the wallet only guarantees shape, integrity and
/// isolation of what it was asked to keep.
public enum OfflineWalletFailure: String, CaseIterable, Codable, Sendable {
  case invalidOwner = "invalid_owner"
  case invalidGrant = "invalid_grant"
  case invalidReceipt = "invalid_receipt"
  case invalidRevision = "invalid_revision"
  case capacityExceeded = "capacity_exceeded"
  case revisionConflict = "revision_conflict"
  case tampered = "tampered"
  case integrityKeyMissing = "integrity_key_missing"
  case unsupportedVersion = "unsupported_version"
  case notCorrupt = "not_corrupt"
  case storageUnavailable = "storage_unavailable"
  case storageDenied = "storage_denied"
  case storageFailure = "storage_failure"

  /// Stable bridge error code (`wallet.<failure>`).
  public var code: String { "wallet.\(rawValue)" }

  /// Maps a Security framework `OSStatus` onto the three storage failures the
  /// caller can act on: retry later (device locked / keychain unavailable),
  /// give up (entitlement or ACL refusal), or report (anything else).
  public init(keychainStatus: Int32) {
    switch keychainStatus {
    case -25308, -25291:
      self = .storageUnavailable
    case -34018, -25293, -25243:
      self = .storageDenied
    default:
      self = .storageFailure
    }
  }
}

public struct OfflineWalletError: Error, Equatable, Sendable {
  public let failure: OfflineWalletFailure
  /// Short operator-facing reason; never contains grant or receipt material.
  public let detail: String
  /// `OSStatus` of the failing Keychain call when one caused this failure.
  public let status: Int32?

  public init(failure: OfflineWalletFailure, detail: String, status: Int32? = nil) {
    self.failure = failure
    self.detail = detail
    self.status = status
  }
}

public struct OfflineStoredGrant: Codable, Equatable, Sendable {
  public let grantId: String
  public let compactJws: String

  public init(grantId: String, compactJws: String) {
    self.grantId = grantId
    self.compactJws = compactJws
  }
}

public enum OfflineStoredReceiptKind: String, Codable, CaseIterable, Sendable {
  case result = "result"
  case unusedTicketReturn = "unused_ticket_return"
}

public struct OfflineStoredReceipt: Codable, Equatable, Sendable {
  public let receiptId: String
  public let kind: OfflineStoredReceiptKind
  /// Serialized receipt object exactly as the caller will submit it.
  public let payloadJson: String

  public init(receiptId: String, kind: OfflineStoredReceiptKind, payloadJson: String) {
    self.receiptId = receiptId
    self.kind = kind
    self.payloadJson = payloadJson
  }
}

public struct OfflineWalletContents: Codable, Equatable, Sendable {
  public let grants: [OfflineStoredGrant]
  public let receipts: [OfflineStoredReceipt]

  public init(grants: [OfflineStoredGrant], receipts: [OfflineStoredReceipt]) {
    self.grants = grants
    self.receipts = receipts
  }
}

public struct OfflineWalletSnapshot: Equatable, Sendable {
  public let ownerId: String
  /// Monotonic per-owner write counter; 0 means "no wallet stored".
  public let revision: UInt64
  public let contents: OfflineWalletContents

  public init(ownerId: String, revision: UInt64, contents: OfflineWalletContents) {
    self.ownerId = ownerId
    self.revision = revision
    self.contents = contents
  }
}

/// One secure item store. `write` must replace the item's value atomically
/// (the Keychain does so per item); implementations throw
/// `OfflineWalletError` for storage faults.
public protocol OfflineWalletSecureStore {
  func read(account: String) throws -> Data?
  func write(account: String, data: Data) throws
  func delete(account: String) throws
}

public final class OfflineWallet {
  public enum Limits {
    public static let maxGrants = 8
    public static let maxReceipts = 64
    public static let maxGrantJwsBytes = 16_384
    public static let maxReceiptPayloadBytes = 8_192
    public static let maxEnvelopeBytes = 1_048_576
  }

  public static let keychainService = "com.picklesensei.offline.wallet"
  public static let envelopeVersion = 1
  static let integrityKeyAccount = "integrity-key.v1"
  static let integrityKeyBytes = 32
  private static let integrityDomain = Data("pickle-offline-wallet-v1".utf8)

  static func walletAccount(ownerId: String) -> String { "wallet.v1.\(ownerId)" }

  private let store: OfflineWalletSecureStore

  public init(store: OfflineWalletSecureStore) {
    self.store = store
  }

  /// `nil` means no wallet is stored for this owner. Any stored bytes that do
  /// not verify are a thrown failure, never `nil`.
  public func load(ownerId: String) throws -> OfflineWalletSnapshot? {
    try OfflineWallet.validateOwner(ownerId)
    guard let stored = try readVerified(ownerId: ownerId) else { return nil }
    return stored.snapshot
  }

  /// Replaces the whole wallet in one item write. `expectedRevision` must
  /// match the stored revision (0 when absent) or nothing is written.
  public func replace(
    ownerId: String,
    expectedRevision: UInt64,
    contents: OfflineWalletContents
  ) throws -> OfflineWalletSnapshot {
    try OfflineWallet.validateOwner(ownerId)
    try OfflineWallet.validate(contents)
    let current = try readVerified(ownerId: ownerId)
    let currentRevision = current?.payload.revision ?? 0
    guard currentRevision == expectedRevision else {
      throw OfflineWalletError(
        failure: .revisionConflict,
        detail: "stored revision \(currentRevision) != expected \(expectedRevision)"
      )
    }
    let key = try current?.key ?? loadOrMintIntegrityKey()
    let payload = WalletPayload(
      ownerId: ownerId,
      revision: currentRevision + 1,
      grants: contents.grants,
      receipts: contents.receipts
    )
    let account = OfflineWallet.walletAccount(ownerId: ownerId)
    let bytes = try OfflineWallet.encodeEnvelope(payload: payload, account: account, key: key)
    try storeWrite(account: account, data: bytes)
    return payload.snapshot
  }

  /// Removes a readable wallet whose revision matches. Corrupt wallets are
  /// refused here so they can only leave through `discardCorrupt`.
  public func clear(ownerId: String, expectedRevision: UInt64) throws {
    try OfflineWallet.validateOwner(ownerId)
    let current = try readVerified(ownerId: ownerId)
    let currentRevision = current?.payload.revision ?? 0
    guard currentRevision == expectedRevision else {
      throw OfflineWalletError(
        failure: .revisionConflict,
        detail: "stored revision \(currentRevision) != expected \(expectedRevision)"
      )
    }
    guard current != nil else { return }
    try storeDelete(account: OfflineWallet.walletAccount(ownerId: ownerId))
  }

  /// Deletes a wallet that fails verification and returns the failure it
  /// had; a readable (or absent) wallet is left alone with `.notCorrupt`.
  /// Callers invoke this only after the server has reconciled the owner.
  @discardableResult
  public func discardCorrupt(ownerId: String) throws -> OfflineWalletFailure {
    try OfflineWallet.validateOwner(ownerId)
    do {
      _ = try readVerified(ownerId: ownerId)
    } catch let error as OfflineWalletError {
      switch error.failure {
      case .tampered, .integrityKeyMissing, .unsupportedVersion:
        try storeDelete(account: OfflineWallet.walletAccount(ownerId: ownerId))
        return error.failure
      default:
        throw error
      }
    }
    throw OfflineWalletError(failure: .notCorrupt, detail: "wallet verifies; use clear")
  }

  // MARK: - Bridge helpers

  /// JS revisions arrive as doubles; only exact non-negative safe integers
  /// are accepted.
  public static func revision(fromBridge value: Double) throws -> UInt64 {
    guard value.isFinite, value >= 0, value <= 9_007_199_254_740_991,
      value.rounded(.towardZero) == value
    else {
      throw OfflineWalletError(failure: .invalidRevision, detail: "revision must be a non-negative safe integer")
    }
    return UInt64(value)
  }

  // MARK: - Verification

  private struct WalletPayload: Codable {
    let ownerId: String
    let revision: UInt64
    let grants: [OfflineStoredGrant]
    let receipts: [OfflineStoredReceipt]

    var snapshot: OfflineWalletSnapshot {
      OfflineWalletSnapshot(
        ownerId: ownerId,
        revision: revision,
        contents: OfflineWalletContents(grants: grants, receipts: receipts)
      )
    }
  }

  private struct Envelope: Codable {
    let v: Int
    let payload: Data
    let tag: Data
  }

  private struct EnvelopeVersion: Decodable {
    let v: Int
  }

  private struct VerifiedWallet {
    let payload: WalletPayload
    let key: Data
    var snapshot: OfflineWalletSnapshot { payload.snapshot }
  }

  private func readVerified(ownerId: String) throws -> VerifiedWallet? {
    let account = OfflineWallet.walletAccount(ownerId: ownerId)
    guard let bytes = try storeRead(account: account) else { return nil }

    let decoder = JSONDecoder()
    guard let version = try? decoder.decode(EnvelopeVersion.self, from: bytes) else {
      throw OfflineWalletError(failure: .tampered, detail: "wallet envelope is not decodable")
    }
    guard version.v == OfflineWallet.envelopeVersion else {
      throw OfflineWalletError(failure: .unsupportedVersion, detail: "wallet envelope version \(version.v)")
    }
    guard let envelope = try? decoder.decode(Envelope.self, from: bytes) else {
      throw OfflineWalletError(failure: .tampered, detail: "wallet envelope is malformed")
    }
    guard let key = try storeRead(account: OfflineWallet.integrityKeyAccount) else {
      throw OfflineWalletError(failure: .integrityKeyMissing, detail: "wallet present without its integrity key")
    }
    guard key.count == OfflineWallet.integrityKeyBytes else {
      throw OfflineWalletError(failure: .tampered, detail: "integrity key has unexpected length")
    }
    let expected = OfflineWallet.tag(account: account, payload: envelope.payload, key: key)
    guard OfflineWalletIntegrity.constantTimeEquals(expected, envelope.tag) else {
      throw OfflineWalletError(failure: .tampered, detail: "wallet integrity tag mismatch")
    }
    guard let payload = try? decoder.decode(WalletPayload.self, from: envelope.payload) else {
      throw OfflineWalletError(failure: .tampered, detail: "wallet payload is not decodable")
    }
    guard payload.ownerId == ownerId, payload.revision > 0 else {
      throw OfflineWalletError(failure: .tampered, detail: "wallet payload does not belong to this owner")
    }
    do {
      try OfflineWallet.validate(OfflineWalletContents(grants: payload.grants, receipts: payload.receipts))
    } catch {
      throw OfflineWalletError(failure: .tampered, detail: "wallet payload violates its own shape rules")
    }
    return VerifiedWallet(payload: payload, key: key)
  }

  private func loadOrMintIntegrityKey() throws -> Data {
    if let existing = try storeRead(account: OfflineWallet.integrityKeyAccount) {
      guard existing.count == OfflineWallet.integrityKeyBytes else {
        throw OfflineWalletError(failure: .tampered, detail: "integrity key has unexpected length")
      }
      return existing
    }
    var generator = SystemRandomNumberGenerator()
    let key = Data((0..<OfflineWallet.integrityKeyBytes).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
    try storeWrite(account: OfflineWallet.integrityKeyAccount, data: key)
    return key
  }

  private static func encodeEnvelope(payload: WalletPayload, account: String, key: Data) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let payloadBytes: Data
    let bytes: Data
    do {
      payloadBytes = try encoder.encode(payload)
      let envelope = Envelope(
        v: OfflineWallet.envelopeVersion,
        payload: payloadBytes,
        tag: tag(account: account, payload: payloadBytes, key: key)
      )
      bytes = try encoder.encode(envelope)
    } catch {
      throw OfflineWalletError(failure: .storageFailure, detail: "wallet could not be encoded")
    }
    guard bytes.count <= Limits.maxEnvelopeBytes else {
      throw OfflineWalletError(failure: .capacityExceeded, detail: "wallet exceeds \(Limits.maxEnvelopeBytes) bytes")
    }
    return bytes
  }

  private static func tag(account: String, payload: Data, key: Data) -> Data {
    var message = integrityDomain
    message.append(0)
    message.append(Data(account.utf8))
    message.append(0)
    message.append(payload)
    return OfflineWalletIntegrity.hmacSHA256(key: key, message: message)
  }

  // MARK: - Store access

  private func storeRead(account: String) throws -> Data? {
    do {
      return try store.read(account: account)
    } catch let error as OfflineWalletError {
      throw error
    } catch {
      throw OfflineWalletError(failure: .storageFailure, detail: "secure store read failed")
    }
  }

  private func storeWrite(account: String, data: Data) throws {
    do {
      try store.write(account: account, data: data)
    } catch let error as OfflineWalletError {
      throw error
    } catch {
      throw OfflineWalletError(failure: .storageFailure, detail: "secure store write failed")
    }
  }

  private func storeDelete(account: String) throws {
    do {
      try store.delete(account: account)
    } catch let error as OfflineWalletError {
      throw error
    } catch {
      throw OfflineWalletError(failure: .storageFailure, detail: "secure store delete failed")
    }
  }

  // MARK: - Shape rules (mirror packages/shared-types offlineAuthorization.ts)

  static func validateOwner(_ ownerId: String) throws {
    guard OfflineWalletShape.isCanonicalOwner(ownerId) else {
      throw OfflineWalletError(failure: .invalidOwner, detail: "owner id is not a canonical account id")
    }
  }

  static func validate(_ contents: OfflineWalletContents) throws {
    guard contents.grants.count <= Limits.maxGrants else {
      throw OfflineWalletError(failure: .capacityExceeded, detail: "more than \(Limits.maxGrants) grants")
    }
    guard contents.receipts.count <= Limits.maxReceipts else {
      throw OfflineWalletError(failure: .capacityExceeded, detail: "more than \(Limits.maxReceipts) receipts")
    }
    var grantIds = Set<String>()
    for grant in contents.grants {
      guard OfflineWalletShape.isIdentifier(grant.grantId) else {
        throw OfflineWalletError(failure: .invalidGrant, detail: "grant id is not an identifier")
      }
      guard OfflineWalletShape.isCompactJws(grant.compactJws) else {
        throw OfflineWalletError(failure: .invalidGrant, detail: "grant is not a compact ES256 JWS")
      }
      guard grantIds.insert(grant.grantId).inserted else {
        throw OfflineWalletError(failure: .invalidGrant, detail: "duplicate grant id")
      }
    }
    var receiptIds = Set<String>()
    for receipt in contents.receipts {
      guard OfflineWalletShape.isIdentifier(receipt.receiptId) else {
        throw OfflineWalletError(failure: .invalidReceipt, detail: "receipt id is not an identifier")
      }
      guard OfflineWalletShape.isJsonObject(receipt.payloadJson, maxBytes: Limits.maxReceiptPayloadBytes) else {
        throw OfflineWalletError(failure: .invalidReceipt, detail: "receipt payload is not a bounded JSON object")
      }
      guard receiptIds.insert(receipt.receiptId).inserted else {
        throw OfflineWalletError(failure: .invalidReceipt, detail: "duplicate receipt id")
      }
    }
  }
}

extension OfflineWalletContents {
  /// Parses the JS-side `{grants: [{grantId, compactJws}], receipts:
  /// [{receiptId, kind, payloadJson}]}` shape with typed failures.
  public init(bridgePayload: [String: Any]) throws {
    guard let rawGrants = bridgePayload["grants"] as? [[String: Any]] else {
      throw OfflineWalletError(failure: .invalidGrant, detail: "grants must be an array of objects")
    }
    guard let rawReceipts = bridgePayload["receipts"] as? [[String: Any]] else {
      throw OfflineWalletError(failure: .invalidReceipt, detail: "receipts must be an array of objects")
    }
    let grants = try rawGrants.map { raw -> OfflineStoredGrant in
      guard let grantId = raw["grantId"] as? String, let compactJws = raw["compactJws"] as? String else {
        throw OfflineWalletError(failure: .invalidGrant, detail: "grant needs string grantId and compactJws")
      }
      return OfflineStoredGrant(grantId: grantId, compactJws: compactJws)
    }
    let receipts = try rawReceipts.map { raw -> OfflineStoredReceipt in
      guard let receiptId = raw["receiptId"] as? String,
        let rawKind = raw["kind"] as? String,
        let kind = OfflineStoredReceiptKind(rawValue: rawKind),
        let payloadJson = raw["payloadJson"] as? String
      else {
        throw OfflineWalletError(failure: .invalidReceipt, detail: "receipt needs receiptId, known kind and payloadJson")
      }
      return OfflineStoredReceipt(receiptId: receiptId, kind: kind, payloadJson: payloadJson)
    }
    let contents = OfflineWalletContents(grants: grants, receipts: receipts)
    try OfflineWallet.validate(contents)
    self = contents
  }
}

extension OfflineWalletSnapshot {
  public func bridgePayload() -> [String: Any] {
    [
      "ownerId": ownerId,
      "revision": revision,
      "grants": contents.grants.map { ["grantId": $0.grantId, "compactJws": $0.compactJws] },
      "receipts": contents.receipts.map {
        ["receiptId": $0.receiptId, "kind": $0.kind.rawValue, "payloadJson": $0.payloadJson]
      },
    ]
  }
}

enum OfflineWalletShape {
  static func isCanonicalOwner(_ value: String) -> Bool {
    let scalars = Array(value.unicodeScalars)
    guard scalars.count == 36 else { return false }
    for (index, scalar) in scalars.enumerated() {
      switch index {
      case 8, 13, 18, 23:
        guard scalar == "-" else { return false }
      case 14:
        guard ("1"..."8").contains(scalar) else { return false }
      case 19:
        guard scalar == "8" || scalar == "9" || scalar == "a" || scalar == "b" else { return false }
      default:
        guard isLowerHex(scalar) else { return false }
      }
    }
    return true
  }

  static func isIdentifier(_ value: String) -> Bool {
    let scalars = value.unicodeScalars
    guard !scalars.isEmpty, scalars.count <= 128 else { return false }
    return scalars.allSatisfy { isAlphanumeric($0) || "._:/+=-".unicodeScalars.contains($0) }
  }

  static func isBase64Url(_ value: Substring, maximumLength: Int) -> Bool {
    let scalars = value.unicodeScalars
    guard scalars.count >= 2, scalars.count <= maximumLength, scalars.count % 4 != 1 else { return false }
    return scalars.allSatisfy { isAlphanumeric($0) || $0 == "-" || $0 == "_" }
  }

  static func isCompactJws(_ value: String) -> Bool {
    guard !value.isEmpty, value.utf8.count <= OfflineWallet.Limits.maxGrantJwsBytes else { return false }
    let segments = value.split(separator: ".", omittingEmptySubsequences: false)
    guard segments.count == 3 else { return false }
    return isBase64Url(segments[0], maximumLength: 1_024)
      && isBase64Url(segments[1], maximumLength: 15_272)
      && isBase64Url(segments[2], maximumLength: 86)
      && segments[2].unicodeScalars.count == 86
  }

  static func isJsonObject(_ value: String, maxBytes: Int) -> Bool {
    let bytes = Data(value.utf8)
    guard !bytes.isEmpty, bytes.count <= maxBytes else { return false }
    guard let parsed = try? JSONSerialization.jsonObject(with: bytes, options: []) else { return false }
    return parsed is [String: Any]
  }

  private static func isLowerHex(_ scalar: Unicode.Scalar) -> Bool {
    ("0"..."9").contains(scalar) || ("a"..."f").contains(scalar)
  }

  private static func isAlphanumeric(_ scalar: Unicode.Scalar) -> Bool {
    ("0"..."9").contains(scalar) || ("a"..."z").contains(scalar) || ("A"..."Z").contains(scalar)
  }
}

/// SHA-256 / HMAC-SHA256 for the wallet integrity tag. Apple platforms use
/// CryptoKit; the portable implementation only exists so the same module and
/// tests build on Linux hosts.
enum OfflineWalletIntegrity {
  static func sha256(_ data: Data) -> Data {
    #if canImport(CryptoKit)
      return Data(SHA256.hash(data: data))
    #else
      return PortableSHA256.digest(data)
    #endif
  }

  static func hmacSHA256(key: Data, message: Data) -> Data {
    #if canImport(CryptoKit)
      return Data(HMAC<SHA256>.authenticationCode(for: message, using: SymmetricKey(data: key)))
    #else
      let blockSize = 64
      var paddedKey = key.count > blockSize ? sha256(key) : key
      if paddedKey.count < blockSize {
        paddedKey.append(Data(repeating: 0, count: blockSize - paddedKey.count))
      }
      var inner = Data(paddedKey.map { $0 ^ 0x36 })
      inner.append(message)
      var outer = Data(paddedKey.map { $0 ^ 0x5C })
      outer.append(sha256(inner))
      return sha256(outer)
    #endif
  }

  static func constantTimeEquals(_ lhs: Data, _ rhs: Data) -> Bool {
    guard lhs.count == rhs.count else { return false }
    var difference: UInt8 = 0
    for (left, right) in zip(lhs, rhs) {
      difference |= left ^ right
    }
    return difference == 0
  }
}

#if !canImport(CryptoKit)
  private enum PortableSHA256 {
    private static let roundConstants: [UInt32] = [
      0x428a_2f98, 0x7137_4491, 0xb5c0_fbcf, 0xe9b5_dba5, 0x3956_c25b, 0x59f1_11f1, 0x923f_82a4, 0xab1c_5ed5,
      0xd807_aa98, 0x1283_5b01, 0x2431_85be, 0x550c_7dc3, 0x72be_5d74, 0x80de_b1fe, 0x9bdc_06a7, 0xc19b_f174,
      0xe49b_69c1, 0xefbe_4786, 0x0fc1_9dc6, 0x240c_a1cc, 0x2de9_2c6f, 0x4a74_84aa, 0x5cb0_a9dc, 0x76f9_88da,
      0x983e_5152, 0xa831_c66d, 0xb003_27c8, 0xbf59_7fc7, 0xc6e0_0bf3, 0xd5a7_9147, 0x06ca_6351, 0x1429_2967,
      0x27b7_0a85, 0x2e1b_2138, 0x4d2c_6dfc, 0x5338_0d13, 0x650a_7354, 0x766a_0abb, 0x81c2_c92e, 0x9272_2c85,
      0xa2bf_e8a1, 0xa81a_664b, 0xc24b_8b70, 0xc76c_51a3, 0xd192_e819, 0xd699_0624, 0xf40e_3585, 0x106a_a070,
      0x19a4_c116, 0x1e37_6c08, 0x2748_774c, 0x34b0_bcb5, 0x391c_0cb3, 0x4ed8_aa4a, 0x5b9c_ca4f, 0x682e_6ff3,
      0x748f_82ee, 0x78a5_636f, 0x84c8_7814, 0x8cc7_0208, 0x90be_fffa, 0xa450_6ceb, 0xbef9_a3f7, 0xc671_78f2,
    ]

    static func digest(_ message: Data) -> Data {
      var state: [UInt32] = [
        0x6a09_e667, 0xbb67_ae85, 0x3c6e_f372, 0xa54f_f53a, 0x510e_527f, 0x9b05_688c, 0x1f83_d9ab, 0x5be0_cd19,
      ]
      var padded = [UInt8](message)
      let bitLength = UInt64(message.count) * 8
      padded.append(0x80)
      while padded.count % 64 != 56 {
        padded.append(0)
      }
      for shift in stride(from: 56, through: 0, by: -8) {
        padded.append(UInt8(truncatingIfNeeded: bitLength >> UInt64(shift)))
      }

      var schedule = [UInt32](repeating: 0, count: 64)
      for chunkStart in stride(from: 0, to: padded.count, by: 64) {
        for index in 0..<16 {
          let offset = chunkStart + index * 4
          schedule[index] =
            UInt32(padded[offset]) << 24 | UInt32(padded[offset + 1]) << 16 | UInt32(padded[offset + 2]) << 8
            | UInt32(padded[offset + 3])
        }
        for index in 16..<64 {
          let w15 = schedule[index - 15]
          let w2 = schedule[index - 2]
          let s0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >> 3)
          let s1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >> 10)
          schedule[index] = schedule[index - 16] &+ s0 &+ schedule[index - 7] &+ s1
        }

        var a = state[0]
        var b = state[1]
        var c = state[2]
        var d = state[3]
        var e = state[4]
        var f = state[5]
        var g = state[6]
        var h = state[7]
        for index in 0..<64 {
          let bigSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
          let choose = (e & f) ^ (~e & g)
          let temp1 = h &+ bigSigma1 &+ choose &+ roundConstants[index] &+ schedule[index]
          let bigSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
          let majority = (a & b) ^ (a & c) ^ (b & c)
          let temp2 = bigSigma0 &+ majority
          h = g
          g = f
          f = e
          e = d &+ temp1
          d = c
          c = b
          b = a
          a = temp1 &+ temp2
        }
        state[0] &+= a
        state[1] &+= b
        state[2] &+= c
        state[3] &+= d
        state[4] &+= e
        state[5] &+= f
        state[6] &+= g
        state[7] &+= h
      }

      var output = Data(capacity: 32)
      for word in state {
        output.append(UInt8(truncatingIfNeeded: word >> 24))
        output.append(UInt8(truncatingIfNeeded: word >> 16))
        output.append(UInt8(truncatingIfNeeded: word >> 8))
        output.append(UInt8(truncatingIfNeeded: word))
      }
      return output
    }

    private static func rotateRight(_ value: UInt32, _ amount: UInt32) -> UInt32 {
      (value >> amount) | (value << (32 - amount))
    }
  }
#endif

#if canImport(Security)
  /// Keychain adapter: generic-password items in the wallet's own service,
  /// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, never synchronised,
  /// data-protection keychain on every platform. `write` is update-first so an
  /// existing item is replaced in one call; only a first write adds.
  public final class KeychainOfflineWalletStore: OfflineWalletSecureStore {
    private let service: String

    public init(service: String = OfflineWallet.keychainService) {
      self.service = service
    }

    func itemQuery(account: String) -> [String: Any] {
      [
        kSecClass as String: kSecClassGenericPassword as String,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecAttrSynchronizable as String: false,
        kSecUseDataProtectionKeychain as String: true,
      ]
    }

    func addAttributes(account: String, data: Data) -> [String: Any] {
      var attributes = itemQuery(account: account)
      attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String
      attributes[kSecValueData as String] = data
      return attributes
    }

    public func read(account: String) throws -> Data? {
      var query = itemQuery(account: account)
      query[kSecReturnData as String] = true
      query[kSecMatchLimit as String] = kSecMatchLimitOne as String
      var result: CFTypeRef?
      let status = SecItemCopyMatching(query as CFDictionary, &result)
      switch status {
      case errSecSuccess:
        guard let data = result as? Data else {
          throw OfflineWalletError(failure: .storageFailure, detail: "keychain returned a non-data item", status: status)
        }
        return data
      case errSecItemNotFound:
        return nil
      default:
        throw OfflineWalletError(
          failure: OfflineWalletFailure(keychainStatus: status), detail: "keychain read failed", status: status)
      }
    }

    public func write(account: String, data: Data) throws {
      let update = [kSecValueData as String: data] as [String: Any]
      var status = SecItemUpdate(itemQuery(account: account) as CFDictionary, update as CFDictionary)
      if status == errSecItemNotFound {
        status = SecItemAdd(addAttributes(account: account, data: data) as CFDictionary, nil)
        if status == errSecDuplicateItem {
          status = SecItemUpdate(itemQuery(account: account) as CFDictionary, update as CFDictionary)
        }
      }
      guard status == errSecSuccess else {
        throw OfflineWalletError(
          failure: OfflineWalletFailure(keychainStatus: status), detail: "keychain write failed", status: status)
      }
    }

    public func delete(account: String) throws {
      let status = SecItemDelete(itemQuery(account: account) as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else {
        throw OfflineWalletError(
          failure: OfflineWalletFailure(keychainStatus: status), detail: "keychain delete failed", status: status)
      }
    }
  }
#endif
