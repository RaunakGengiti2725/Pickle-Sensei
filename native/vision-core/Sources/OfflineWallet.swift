import Foundation

#if canImport(CryptoKit)
  import CryptoKit
#endif
#if canImport(Security)
  import Security
#endif

/// Offline wallet (W05): the device-side vault for signed offline execution
/// grants and receipts that have not yet reached the server. Every owner has
/// three Keychain items in the wallet's own `THIS_DEVICE_ONLY` service
/// (distinct from the session vault, never synchronised):
///
/// - `wallet.v1.<owner>` — the whole wallet in one sealed envelope, so a
///   replace is a single compare-and-swap item write: either the previous
///   wallet or the new one is on disk, never a mix, and a concurrent writer
///   (another `OfflineWallet` instance, another process) gets
///   `revision_conflict` instead of silently overwriting unsent receipts.
/// - `integrity-key.v1.<owner>` — a random per-owner key for the HMAC that
///   seals the wallet and the fence. A corrupt key affects one owner only and
///   leaves through `discardCorrupt` like any other corruption.
/// - `fence.v1.<owner>` — the owner's revision history: the highest revision
///   ever committed and whether a wallet at that revision may exist
///   (`present`), is being retired by a `clear` that has not finished
///   (`clearing`) or was retired by `clear` (`cleared`). A wallet behind its
///   fence, or at a revision the fence has retired, was rolled back to an
///   older (authentic) envelope and is reported `tampered`; the fence survives
///   `clear`, so revisions never restart for an owner under one key.
///
/// The fence and the key are one history: losing the fence retires the key
/// (the next first write mints a fresh one), and `discardCorrupt` removes the
/// wallet, fence and key together, so an envelope sealed under an earlier
/// history can never verify again. A wallet item that vanishes while its
/// fence still says one exists is `wallet_missing`, never an empty wallet.
///
/// Flipped bytes, a wallet copied between owners, a payload whose key is
/// gone, an unsupported envelope version, a rolled-back wallet and a vanished
/// wallet are typed failures — never an empty wallet, and never overwritten
/// without an explicit `discardCorrupt` after reconciliation. Signature and
/// policy verification of the grant itself is the caller's job; the wallet
/// only guarantees shape, integrity, monotonicity and isolation of what it
/// was asked to keep.
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
  case walletMissing = "wallet_missing"
  case notCorrupt = "not_corrupt"
  case storageUnavailable = "storage_unavailable"
  case storageDenied = "storage_denied"
  case storageFailure = "storage_failure"

  /// Stable bridge error code (`wallet.<failure>`).
  public var code: String { "wallet.\(rawValue)" }

  /// Failures that mean "what is stored cannot be trusted"; only these are
  /// ever returned by `discardCorrupt`.
  public var isUnreadableState: Bool {
    switch self {
    case .tampered, .integrityKeyMissing, .unsupportedVersion, .walletMissing:
      return true
    default:
      return false
    }
  }

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
  /// Monotonic per-owner write counter (never above `OfflineWallet.maxRevision`
  /// so JS can represent it exactly); 0 means "no wallet stored".
  public let revision: UInt64
  public let contents: OfflineWalletContents

  public init(ownerId: String, revision: UInt64, contents: OfflineWalletContents) {
    self.ownerId = ownerId
    self.revision = revision
    self.contents = contents
  }
}

/// What the fence says about its revision: a wallet at that revision may
/// exist (`present`; the wallet may also be one ahead while a replace's fence
/// commit is pending), a `clear` of that revision is committed but its delete
/// and final fence write may not have landed (`clearing`; a wallet still at
/// that revision is the clear's remnant and reads as no wallet, only a
/// strictly newer wallet is current) or the revision was retired by a
/// finished `clear` (`cleared`; a wallet at or below it is a rollback). A
/// fresh owner starts at `cleared` 0.
enum OfflineWalletFenceSlot: String, Codable, Equatable {
  case present
  case clearing
  case cleared
}

struct OfflineWalletFence: Equatable {
  let revision: UInt64
  let slot: OfflineWalletFenceSlot
}

/// One secure item store with compare-and-swap semantics. Implementations
/// throw `OfflineWalletError` for storage faults and must make each write or
/// delete conditional on the item still holding exactly the bytes the caller
/// last read (`nil` = the item must be absent), returning `false` — having
/// changed nothing — when that precondition no longer holds. The Keychain
/// does this per item via a digest attribute in the update/delete query.
public protocol OfflineWalletSecureStore {
  func read(account: String) throws -> Data?
  func write(account: String, data: Data, ifUnchangedFrom previous: Data?) throws -> Bool
  func delete(account: String, ifUnchangedFrom previous: Data) throws -> Bool
}

public final class OfflineWallet {
  public enum Limits {
    public static let maxGrants = 8
    public static let maxReceipts = 64
    public static let maxGrantJwsBytes = 16_384
    public static let maxReceiptPayloadBytes = 8_192
    /// Sealed-envelope budget. Sized so that a wallet at every other limit
    /// (8 maximal grants with maximal ids, 64 maximal receipts with maximal
    /// ids) fits even when every receipt byte doubles under JSON escaping:
    /// 33 B header + 8 × (16 384 + 2 × 128 + 64) + 64 × (2 × 8 192 + 2 × 128 + 96)
    /// ≈ 1.15 MiB, rounded up to 1.25 MiB.
    public static let maxEnvelopeBytes = 1_310_720
  }

  public static let keychainService = "com.picklesensei.offline.wallet"
  public static let envelopeVersion: UInt8 = 1
  /// Largest revision the JS side can represent exactly (`Number.MAX_SAFE_INTEGER`).
  public static let maxRevision: UInt64 = 9_007_199_254_740_991
  static let integrityKeyBytes = 32
  private static let tagBytes = 32
  private static let headerBytes = 1 + tagBytes
  private static let integrityDomain = Data("pickle-offline-wallet-v1".utf8)

  static func walletAccount(ownerId: String) -> String { "wallet.v1.\(ownerId)" }
  static func integrityKeyAccount(ownerId: String) -> String { "integrity-key.v1.\(ownerId)" }
  static func fenceAccount(ownerId: String) -> String { "fence.v1.\(ownerId)" }

  private let store: OfflineWalletSecureStore

  public init(store: OfflineWalletSecureStore) {
    self.store = store
  }

  /// `nil` means no wallet is stored for this owner: nothing was ever written,
  /// or the last wallet was retired by `clear`. Stored bytes that do not
  /// verify (wallet, fence or key — with no verified fence nothing is known
  /// about the owner), and a wallet the fence says should exist but is gone,
  /// are a thrown failure, never `nil`. Never writes.
  public func load(ownerId: String) throws -> OfflineWalletSnapshot? {
    try OfflineWallet.validateOwner(ownerId)
    let state = try readState(ownerId: ownerId)
    if let fault = state.fault { throw fault }
    return state.wallet?.snapshot
  }

  /// Replaces the whole wallet in one compare-and-swap item write.
  /// `expectedRevision` must match the stored revision (0 when absent) and the
  /// stored bytes must be unchanged since they were read, or nothing is
  /// written and `revision_conflict` is thrown. The new revision is one above
  /// the greater of the stored revision and the owner's fence, so it is
  /// strictly newer than anything `clear` retired.
  public func replace(
    ownerId: String,
    expectedRevision: UInt64,
    contents: OfflineWalletContents
  ) throws -> OfflineWalletSnapshot {
    try OfflineWallet.validateOwner(ownerId)
    try OfflineWallet.validate(contents)
    let state = try readState(ownerId: ownerId)
    if let fault = state.fault { throw fault }
    let currentRevision = state.wallet?.revision ?? 0
    guard currentRevision == expectedRevision else {
      throw OfflineWalletError(
        failure: .revisionConflict,
        detail: "stored revision \(currentRevision) != expected \(expectedRevision)"
      )
    }

    let key: Data
    if let existing = state.key, state.fenceBytes != nil {
      key = existing
    } else {
      // No fence means no history: a key alone (crash between the key mint
      // and the fence write, or a fence item that was lost) must not go on
      // sealing, or every envelope it ever sealed would verify again once
      // revisions restart. Mint a fresh key in its place.
      key = OfflineWallet.mintIntegrityKey()
      guard try storeWrite(account: OfflineWallet.integrityKeyAccount(ownerId: ownerId), data: key, previous: state.keyBytes) else {
        throw OfflineWalletError(failure: .revisionConflict, detail: "integrity key was created concurrently")
      }
    }

    var fenceBytes = state.fenceBytes
    if fenceBytes == nil {
      let initial = try OfflineWallet.sealFence(ownerId: ownerId, fence: OfflineWalletFence(revision: 0, slot: .cleared), key: key)
      guard try storeWrite(account: OfflineWallet.fenceAccount(ownerId: ownerId), data: initial, previous: nil) else {
        throw OfflineWalletError(failure: .revisionConflict, detail: "revision fence was created concurrently")
      }
      fenceBytes = initial
    }

    let base = max(currentRevision, state.fence?.revision ?? 0)
    guard base < OfflineWallet.maxRevision else {
      throw OfflineWalletError(failure: .capacityExceeded, detail: "revision space exhausted for this owner")
    }
    let payload = WalletPayload(
      ownerId: ownerId,
      revision: base + 1,
      grants: contents.grants,
      receipts: contents.receipts
    )
    let account = OfflineWallet.walletAccount(ownerId: ownerId)
    let bytes = try OfflineWallet.sealWallet(payload: payload, account: account, key: key)
    guard try storeWrite(account: account, data: bytes, previous: state.walletBytes) else {
      throw OfflineWalletError(failure: .revisionConflict, detail: "wallet changed while this replace was prepared")
    }
    try commitFence(
      ownerId: ownerId,
      fence: OfflineWalletFence(revision: payload.revision, slot: .present),
      previous: fenceBytes,
      key: key
    )
    return payload.snapshot
  }

  /// Removes a readable wallet whose revision matches, in three store
  /// mutations: the fence is committed to `clearing` at the wallet's revision
  /// BEFORE the wallet item is deleted, and to `cleared` after it. The first
  /// fence write is the point of no return: from then on the envelope at that
  /// revision is never current state again — while the fence says `clearing`
  /// it is the clear's own remnant (reads as no wallet, is swapped out by the
  /// next replace or removed by the next clear, which also finishes the fence);
  /// once it says `cleared` the same envelope is a rollback (`tampered`). The
  /// next replace mints a strictly newer revision either way. Clearing an
  /// owner with no wallet finishes an interrupted clear and otherwise writes
  /// nothing. Corrupt state is refused here so it can only leave through
  /// `discardCorrupt`.
  public func clear(ownerId: String, expectedRevision: UInt64) throws {
    try OfflineWallet.validateOwner(ownerId)
    let state = try readState(ownerId: ownerId)
    if let fault = state.fault { throw fault }
    let currentRevision = state.wallet?.revision ?? 0
    guard currentRevision == expectedRevision else {
      throw OfflineWalletError(
        failure: .revisionConflict,
        detail: "stored revision \(currentRevision) != expected \(expectedRevision)"
      )
    }
    guard let key = state.key, let fence = state.fence else { return }
    let retired: UInt64
    var fenceBytes = state.fenceBytes
    if let wallet = state.wallet {
      retired = wallet.revision
      fenceBytes = try commitFence(
        ownerId: ownerId,
        fence: OfflineWalletFence(revision: retired, slot: .clearing),
        previous: fenceBytes,
        key: key
      )
    } else if fence.slot == .clearing {
      retired = fence.revision
    } else {
      return
    }
    if let walletBytes = state.walletBytes {
      guard try storeDelete(account: OfflineWallet.walletAccount(ownerId: ownerId), previous: walletBytes) else {
        throw OfflineWalletError(failure: .revisionConflict, detail: "wallet changed while this clear was prepared")
      }
    }
    try commitFence(
      ownerId: ownerId,
      fence: OfflineWalletFence(revision: retired, slot: .cleared),
      previous: fenceBytes,
      key: key
    )
  }

  /// Deletes every item of an owner whose state is unreadable — fence, then
  /// integrity key, then wallet, each compare-and-swap against the bytes that
  /// were judged — and returns the failure the owner had. The key always goes
  /// with the fence: once the history is discarded, nothing sealed under it
  /// may verify again, so the next replace starts a fresh history at revision
  /// 1 under a fresh key. Healthy (or absent) state is left alone with
  /// `.notCorrupt`. Callers invoke this only after the server has reconciled
  /// the owner.
  @discardableResult
  public func discardCorrupt(ownerId: String) throws -> OfflineWalletFailure {
    try OfflineWallet.validateOwner(ownerId)
    let state = try readState(ownerId: ownerId)
    guard let fault = state.fault, fault.failure.isUnreadableState else {
      throw OfflineWalletError(failure: .notCorrupt, detail: "wallet verifies; use clear")
    }
    let conflict = OfflineWalletError(failure: .revisionConflict, detail: "state changed while corrupt items were discarded")
    if let fenceBytes = state.fenceBytes {
      guard try storeDelete(account: OfflineWallet.fenceAccount(ownerId: ownerId), previous: fenceBytes) else {
        throw conflict
      }
    }
    if let keyBytes = state.keyBytes {
      guard try storeDelete(account: OfflineWallet.integrityKeyAccount(ownerId: ownerId), previous: keyBytes) else {
        throw conflict
      }
    }
    if let walletBytes = state.walletBytes {
      guard try storeDelete(account: OfflineWallet.walletAccount(ownerId: ownerId), previous: walletBytes) else {
        throw conflict
      }
    }
    return fault.failure
  }

  // MARK: - Bridge helpers

  /// JS revisions arrive as doubles; only exact non-negative safe integers
  /// are accepted.
  public static func revision(fromBridge value: Double) throws -> UInt64 {
    guard value.isFinite, value >= 0, value <= Double(maxRevision),
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

  private struct FencePayload: Codable {
    let ownerId: String
    let revision: UInt64
    let slot: OfflineWalletFenceSlot
  }

  /// Everything read for one owner in one pass. `fault` is the corruption
  /// found, if any: with a wallet present it makes the wallet unreadable; with
  /// no wallet it blocks writes until `discardCorrupt` removes the bad items.
  private struct OwnerState {
    let walletBytes: Data?
    let keyBytes: Data?
    let fenceBytes: Data?
    /// Usable integrity key (exactly `integrityKeyBytes`), else `nil`.
    let key: Data?
    /// Verified fence; `nil` when absent or unverifiable.
    let fence: OfflineWalletFence?
    /// Verified current wallet; `nil` when absent, unreadable, or the remnant
    /// of a clear that is still `clearing` (its bytes stay in `walletBytes`
    /// so the next write swaps or removes exactly them).
    let wallet: WalletPayload?
    let fault: OfflineWalletError?

    /// A key with neither fence nor wallet: either a first write in flight
    /// (key minted, fence not yet written) or a history whose fence is gone.
    var isKeyWithoutHistory: Bool {
      keyBytes != nil && fenceBytes == nil && walletBytes == nil
    }
  }

  /// Raw bytes of an owner's three items from one pass over the store.
  private struct RawOwnerItems: Equatable {
    let keyBytes: Data?
    let fenceBytes: Data?
    let walletBytes: Data?
  }

  /// Upper bound on passes `readState` spends waiting for another writer's
  /// in-flight first write (key, fence, wallet) to become visible as a whole.
  ///
  /// The three reads are not one transaction: an owner's FIRST write (key,
  /// fence, wallet by another instance or process) can land between them and
  /// look like a wallet without its key, or like a key without its fence.
  /// Such a verdict is therefore only accepted once two consecutive passes
  /// observe identical bytes — a genuinely corrupt or orphaned item is
  /// stable, a write in flight is not. State that keeps changing is a
  /// `revision_conflict` for the caller to retry, never something to discard
  /// or re-key.
  private static let maxReadPasses = 4

  /// Reads key, fence, then wallet — the reverse of the write order (wallet,
  /// then fence) — so a concurrent legitimate replace can only ever be seen as
  /// "wallet ahead of fence" (harmless), never as a spurious rollback.
  private func readState(ownerId: String) throws -> OwnerState {
    var raw = try readRawItems(ownerId: ownerId)
    var state = try OfflineWallet.classify(raw, ownerId: ownerId)
    var passes = 1
    while OfflineWallet.needsSettledRead(state), passes < OfflineWallet.maxReadPasses {
      let again = try readRawItems(ownerId: ownerId)
      if again == raw { return state }
      raw = again
      state = try OfflineWallet.classify(raw, ownerId: ownerId)
      passes += 1
    }
    if OfflineWallet.needsSettledRead(state), passes >= OfflineWallet.maxReadPasses {
      throw OfflineWalletError(failure: .revisionConflict, detail: "owner state kept changing while it was read")
    }
    return state
  }

  private static func needsSettledRead(_ state: OwnerState) -> Bool {
    state.fault != nil || state.isKeyWithoutHistory
  }

  private func readRawItems(ownerId: String) throws -> RawOwnerItems {
    let keyBytes = try storeRead(account: OfflineWallet.integrityKeyAccount(ownerId: ownerId))
    let fenceBytes = try storeRead(account: OfflineWallet.fenceAccount(ownerId: ownerId))
    let walletBytes = try storeRead(account: OfflineWallet.walletAccount(ownerId: ownerId))
    return RawOwnerItems(keyBytes: keyBytes, fenceBytes: fenceBytes, walletBytes: walletBytes)
  }

  /// Verifies one pass of raw items; pure, so re-reading is the only way a
  /// verdict can change.
  private static func classify(_ raw: RawOwnerItems, ownerId: String) throws -> OwnerState {
    let walletAccount = OfflineWallet.walletAccount(ownerId: ownerId)
    let keyBytes = raw.keyBytes
    let fenceBytes = raw.fenceBytes
    let walletBytes = raw.walletBytes

    var key: Data?
    var keyFault: OfflineWalletError?
    if let keyBytes {
      if keyBytes.count == OfflineWallet.integrityKeyBytes {
        key = keyBytes
      } else {
        keyFault = OfflineWalletError(failure: .tampered, detail: "integrity key has unexpected length")
      }
    }

    var fence: OfflineWalletFence?
    var fenceFault: OfflineWalletError?
    if let fenceBytes {
      if let key {
        do {
          fence = try OfflineWallet.openFence(fenceBytes, ownerId: ownerId, key: key)
        } catch let error as OfflineWalletError {
          fenceFault = error
        }
      } else if keyFault == nil {
        fenceFault = OfflineWalletError(
          failure: .integrityKeyMissing, detail: "revision fence present without its integrity key")
      }
    }

    var wallet: WalletPayload?
    var walletFault: OfflineWalletError?
    if let walletBytes {
      if keyBytes == nil {
        walletFault = OfflineWalletError(failure: .integrityKeyMissing, detail: "wallet present without its integrity key")
      } else if let key {
        do {
          let payload = try OfflineWallet.openWallet(walletBytes, ownerId: ownerId, account: walletAccount, key: key)
          if let fenceFault {
            throw fenceFault
          }
          guard let fence else {
            throw OfflineWalletError(failure: .tampered, detail: "wallet present without its revision fence")
          }
          switch fence.slot {
          case .present:
            guard payload.revision >= fence.revision else {
              throw OfflineWalletError(
                failure: .tampered,
                detail: "wallet revision \(payload.revision) is behind committed revision \(fence.revision) (rolled back)"
              )
            }
            wallet = payload
          case .clearing:
            guard payload.revision >= fence.revision else {
              throw OfflineWalletError(
                failure: .tampered,
                detail: "wallet revision \(payload.revision) is behind the revision being cleared, \(fence.revision) (rolled back)"
              )
            }
            // At exactly the fence revision the clear of this envelope is
            // committed and only its delete is outstanding: a remnant, not
            // current state.
            wallet = payload.revision == fence.revision ? nil : payload
          case .cleared:
            guard payload.revision > fence.revision else {
              throw OfflineWalletError(
                failure: .tampered,
                detail: "wallet revision \(payload.revision) was retired by clear at revision \(fence.revision) (rolled back)"
              )
            }
            wallet = payload
          }
        } catch let error as OfflineWalletError {
          walletFault = error
        }
      }
    } else if let fence, fence.slot == .present, fence.revision > 0, fenceFault == nil, keyFault == nil {
      walletFault = OfflineWalletError(
        failure: .walletMissing,
        detail: "wallet at committed revision \(fence.revision) is gone without clear"
      )
    }

    let fault = walletFault ?? keyFault ?? fenceFault
    return OwnerState(
      walletBytes: walletBytes,
      keyBytes: keyBytes,
      fenceBytes: fenceBytes,
      key: key,
      fence: fence,
      wallet: fault == nil ? wallet : nil,
      fault: fault
    )
  }

  /// Writes `fence` over `previous` and returns the bytes now on disk.
  @discardableResult
  private func commitFence(ownerId: String, fence: OfflineWalletFence, previous: Data?, key: Data) throws -> Data {
    let account = OfflineWallet.fenceAccount(ownerId: ownerId)
    let bytes = try OfflineWallet.sealFence(ownerId: ownerId, fence: fence, key: key)
    if try storeWrite(account: account, data: bytes, previous: previous) { return bytes }
    // Another writer moved the fence meanwhile. For a replace the wallet
    // write above is the commit point, so it succeeded as long as the fence
    // is not behind it; a clear only starts once its exact retirement is the
    // committed history, and once its delete is done the history may only
    // have moved past it.
    if let current = try storeRead(account: account),
      let committed = try? OfflineWallet.openFence(current, ownerId: ownerId, key: key)
    {
      switch fence.slot {
      case .present where committed.revision >= fence.revision:
        return current
      case .clearing where committed == fence:
        return current
      case .cleared where committed == fence || committed.revision > fence.revision:
        return current
      default:
        break
      }
    }
    if fence.slot == .clearing {
      throw OfflineWalletError(failure: .revisionConflict, detail: "history moved while this clear was prepared")
    }
    throw OfflineWalletError(failure: .storageFailure, detail: "revision fence could not be committed")
  }

  private static func mintIntegrityKey() -> Data {
    var generator = SystemRandomNumberGenerator()
    return Data((0..<integrityKeyBytes).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
  }

  private static func openWallet(_ bytes: Data, ownerId: String, account: String, key: Data) throws -> WalletPayload {
    let payloadBytes = try open(bytes, account: account, key: key)
    guard let payload = try? JSONDecoder().decode(WalletPayload.self, from: payloadBytes) else {
      throw OfflineWalletError(failure: .tampered, detail: "wallet payload is not decodable")
    }
    guard payload.ownerId == ownerId else {
      throw OfflineWalletError(failure: .tampered, detail: "wallet payload does not belong to this owner")
    }
    guard payload.revision >= 1, payload.revision <= maxRevision else {
      throw OfflineWalletError(failure: .tampered, detail: "wallet revision is outside the supported range")
    }
    do {
      try validate(OfflineWalletContents(grants: payload.grants, receipts: payload.receipts))
    } catch {
      throw OfflineWalletError(failure: .tampered, detail: "wallet payload violates its own shape rules")
    }
    return payload
  }

  static func openFence(_ bytes: Data, ownerId: String, key: Data) throws -> OfflineWalletFence {
    let payloadBytes = try open(bytes, account: fenceAccount(ownerId: ownerId), key: key)
    guard let payload = try? JSONDecoder().decode(FencePayload.self, from: payloadBytes) else {
      throw OfflineWalletError(failure: .tampered, detail: "revision fence is not decodable")
    }
    guard payload.ownerId == ownerId else {
      throw OfflineWalletError(failure: .tampered, detail: "revision fence does not belong to this owner")
    }
    guard payload.revision <= maxRevision else {
      throw OfflineWalletError(failure: .tampered, detail: "revision fence is outside the supported range")
    }
    return OfflineWalletFence(revision: payload.revision, slot: payload.slot)
  }

  private static func sealWallet(payload: WalletPayload, account: String, key: Data) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    guard let payloadBytes = try? encoder.encode(payload) else {
      throw OfflineWalletError(failure: .storageFailure, detail: "wallet could not be encoded")
    }
    let bytes = seal(payload: payloadBytes, account: account, key: key)
    guard bytes.count <= Limits.maxEnvelopeBytes else {
      throw OfflineWalletError(failure: .capacityExceeded, detail: "wallet exceeds \(Limits.maxEnvelopeBytes) bytes")
    }
    return bytes
  }

  private static func sealFence(ownerId: String, fence: OfflineWalletFence, key: Data) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let payload = FencePayload(ownerId: ownerId, revision: fence.revision, slot: fence.slot)
    guard let payloadBytes = try? encoder.encode(payload) else {
      throw OfflineWalletError(failure: .storageFailure, detail: "revision fence could not be encoded")
    }
    return seal(payload: payloadBytes, account: fenceAccount(ownerId: ownerId), key: key)
  }

  /// Sealed envelope: `[version][tag: 32 bytes][payload]`. The tag is an HMAC
  /// over the domain, the item account, the version byte and the payload, so
  /// the version is covered too and the same bytes under another account (a
  /// wallet copied between owners, a fence swapped for a wallet) do not verify.
  static func seal(payload: Data, account: String, key: Data) -> Data {
    var bytes = Data([envelopeVersion])
    bytes.append(tag(account: account, version: envelopeVersion, payload: payload, key: key))
    bytes.append(payload)
    return bytes
  }

  static func open(_ bytes: Data, account: String, key: Data) throws -> Data {
    let raw = [UInt8](bytes)
    guard raw.count > headerBytes else {
      throw OfflineWalletError(failure: .tampered, detail: "sealed envelope is too short")
    }
    let version = raw[0]
    guard version == envelopeVersion else {
      if version > envelopeVersion {
        throw OfflineWalletError(failure: .unsupportedVersion, detail: "sealed envelope version \(version)")
      }
      throw OfflineWalletError(failure: .tampered, detail: "sealed envelope version is invalid")
    }
    let storedTag = Data(raw[1..<headerBytes])
    let payload = Data(raw[headerBytes...])
    let expected = tag(account: account, version: version, payload: payload, key: key)
    guard OfflineWalletIntegrity.constantTimeEquals(expected, storedTag) else {
      throw OfflineWalletError(failure: .tampered, detail: "sealed envelope integrity tag mismatch")
    }
    return payload
  }

  private static func tag(account: String, version: UInt8, payload: Data, key: Data) -> Data {
    var message = integrityDomain
    message.append(0)
    message.append(Data(account.utf8))
    message.append(0)
    message.append(version)
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

  private func storeWrite(account: String, data: Data, previous: Data?) throws -> Bool {
    do {
      return try store.write(account: account, data: data, ifUnchangedFrom: previous)
    } catch let error as OfflineWalletError {
      throw error
    } catch {
      throw OfflineWalletError(failure: .storageFailure, detail: "secure store write failed")
    }
  }

  private func storeDelete(account: String, previous: Data) throws -> Bool {
    do {
      return try store.delete(account: account, ifUnchangedFrom: previous)
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
    guard scalars.allSatisfy({ isAlphanumeric($0) || $0 == "-" || $0 == "_" }) else { return false }
    guard let last = scalars.last else { return false }
    switch scalars.count % 4 {
    case 2:
      return "AQgw".unicodeScalars.contains(last)
    case 3:
      return "AEIMQUYcgkosw048".unicodeScalars.contains(last)
    default:
      return true
    }
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

  /// Strict RFC 8259 check — exactly what `JSON.parse` accepts — so a payload
  /// the native side commits is always readable through the JS bridge.
  /// Foundation's `JSONSerialization` is deliberately not used here: it
  /// tolerates a byte-order mark and (on some platforms) other extensions
  /// that `JSON.parse` rejects.
  static func isJsonObject(_ value: String, maxBytes: Int) -> Bool {
    let bytes = Array(value.utf8)
    guard !bytes.isEmpty, bytes.count <= maxBytes else { return false }
    var scanner = StrictJsonScanner(bytes)
    return scanner.isObjectDocument()
  }

  /// Non-recursive validator for the JSON text grammar. Only the four JSON
  /// whitespace bytes are skipped, strings must not contain raw control
  /// characters and only carry the nine JSON escapes (`\uXXXX` with exactly
  /// four hex digits), numbers follow the JSON number production exactly, and
  /// nothing may follow the closing brace but whitespace.
  private struct StrictJsonScanner {
    private let bytes: [UInt8]
    private var index = 0

    init(_ bytes: [UInt8]) {
      self.bytes = bytes
    }

    mutating func isObjectDocument() -> Bool {
      skipWhitespace()
      guard peek() == UInt8(ascii: "{") else { return false }
      guard scanValue() else { return false }
      skipWhitespace()
      return index == bytes.count
    }

    private enum Container {
      case object
      case array
    }

    /// Scans one value starting at `index`; containers are walked with an
    /// explicit stack so payload nesting can never exhaust the call stack.
    private mutating func scanValue() -> Bool {
      var stack: [Container] = []
      var expectValue = true
      while true {
        skipWhitespace()
        guard let byte = peek() else { return false }
        if expectValue {
          switch byte {
          case UInt8(ascii: "{"):
            index += 1
            stack.append(.object)
            skipWhitespace()
            if peek() == UInt8(ascii: "}") {
              index += 1
              stack.removeLast()
              expectValue = false
            } else {
              guard scanMemberName() else { return false }
            }
          case UInt8(ascii: "["):
            index += 1
            stack.append(.array)
            skipWhitespace()
            if peek() == UInt8(ascii: "]") {
              index += 1
              stack.removeLast()
              expectValue = false
            }
          case UInt8(ascii: "\""):
            guard scanString() else { return false }
            expectValue = false
          case UInt8(ascii: "-"), UInt8(ascii: "0")...UInt8(ascii: "9"):
            guard scanNumber() else { return false }
            expectValue = false
          case UInt8(ascii: "t"):
            guard scanLiteral("true") else { return false }
            expectValue = false
          case UInt8(ascii: "f"):
            guard scanLiteral("false") else { return false }
            expectValue = false
          case UInt8(ascii: "n"):
            guard scanLiteral("null") else { return false }
            expectValue = false
          default:
            return false
          }
        } else {
          guard let container = stack.last else { return false }
          switch (container, byte) {
          case (.object, UInt8(ascii: ",")):
            index += 1
            guard scanMemberName() else { return false }
            expectValue = true
          case (.object, UInt8(ascii: "}")), (.array, UInt8(ascii: "]")):
            index += 1
            stack.removeLast()
          case (.array, UInt8(ascii: ",")):
            index += 1
            expectValue = true
          default:
            return false
          }
        }
        if !expectValue, stack.isEmpty { return true }
      }
    }

    /// `ws string ws ':'` — leaves `index` on the member's value.
    private mutating func scanMemberName() -> Bool {
      skipWhitespace()
      guard peek() == UInt8(ascii: "\"") else { return false }
      guard scanString() else { return false }
      skipWhitespace()
      guard peek() == UInt8(ascii: ":") else { return false }
      index += 1
      return true
    }

    private mutating func scanString() -> Bool {
      index += 1
      while index < bytes.count {
        let byte = bytes[index]
        switch byte {
        case UInt8(ascii: "\""):
          index += 1
          return true
        case UInt8(ascii: "\\"):
          index += 1
          guard index < bytes.count else { return false }
          switch bytes[index] {
          case UInt8(ascii: "\""), UInt8(ascii: "\\"), UInt8(ascii: "/"), UInt8(ascii: "b"),
            UInt8(ascii: "f"), UInt8(ascii: "n"), UInt8(ascii: "r"), UInt8(ascii: "t"):
            index += 1
          case UInt8(ascii: "u"):
            index += 1
            guard index + 4 <= bytes.count, bytes[index..<index + 4].allSatisfy(StrictJsonScanner.isHexDigit) else {
              return false
            }
            index += 4
          default:
            return false
          }
        case 0x00...0x1F:
          return false
        default:
          index += 1
        }
      }
      return false
    }

    private mutating func scanNumber() -> Bool {
      if peek() == UInt8(ascii: "-") { index += 1 }
      guard let first = peek(), StrictJsonScanner.isDigit(first) else { return false }
      if first == UInt8(ascii: "0") {
        index += 1
      } else {
        skipDigits()
      }
      if peek() == UInt8(ascii: ".") {
        index += 1
        guard let fraction = peek(), StrictJsonScanner.isDigit(fraction) else { return false }
        skipDigits()
      }
      if let exponent = peek(), exponent == UInt8(ascii: "e") || exponent == UInt8(ascii: "E") {
        index += 1
        if let sign = peek(), sign == UInt8(ascii: "+") || sign == UInt8(ascii: "-") { index += 1 }
        guard let digit = peek(), StrictJsonScanner.isDigit(digit) else { return false }
        skipDigits()
      }
      return true
    }

    private mutating func scanLiteral(_ literal: String) -> Bool {
      let expected = Array(literal.utf8)
      guard index + expected.count <= bytes.count, Array(bytes[index..<index + expected.count]) == expected else {
        return false
      }
      index += expected.count
      return true
    }

    private mutating func skipDigits() {
      while let byte = peek(), StrictJsonScanner.isDigit(byte) { index += 1 }
    }

    private mutating func skipWhitespace() {
      while let byte = peek(), byte == 0x20 || byte == 0x09 || byte == 0x0A || byte == 0x0D { index += 1 }
    }

    private func peek() -> UInt8? {
      index < bytes.count ? bytes[index] : nil
    }

    private static func isDigit(_ byte: UInt8) -> Bool {
      (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte)
    }

    private static func isHexDigit(_ byte: UInt8) -> Bool {
      isDigit(byte) || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains(byte) || (UInt8(ascii: "A")...UInt8(ascii: "F")).contains(byte)
    }
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
  /// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (re-asserted on every
  /// write), never synchronised, data-protection keychain on every platform.
  /// Compare-and-swap rides on `kSecAttrGeneric`: every item carries the
  /// SHA-256 of its own value, and a conditional update or delete queries for
  /// the digest of the bytes the caller last read, so the Keychain itself
  /// refuses the write (`errSecItemNotFound`) once another writer has moved
  /// the item. A first write is `SecItemAdd`, which the Keychain refuses
  /// (`errSecDuplicateItem`) when the item appeared meanwhile.
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

    /// Query that only matches the item while it still holds `previous`.
    func conditionalQuery(account: String, previous: Data) -> [String: Any] {
      var query = itemQuery(account: account)
      query[kSecAttrGeneric as String] = OfflineWalletIntegrity.sha256(previous)
      return query
    }

    func updateAttributes(data: Data) -> [String: Any] {
      [
        kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String,
        kSecAttrGeneric as String: OfflineWalletIntegrity.sha256(data),
        kSecValueData as String: data,
      ]
    }

    func addAttributes(account: String, data: Data) -> [String: Any] {
      var attributes = itemQuery(account: account)
      attributes.merge(updateAttributes(data: data)) { _, new in new }
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

    public func write(account: String, data: Data, ifUnchangedFrom previous: Data?) throws -> Bool {
      let status: OSStatus
      let refused: OSStatus
      if let previous {
        status = SecItemUpdate(
          conditionalQuery(account: account, previous: previous) as CFDictionary,
          updateAttributes(data: data) as CFDictionary)
        refused = errSecItemNotFound
      } else {
        status = SecItemAdd(addAttributes(account: account, data: data) as CFDictionary, nil)
        refused = errSecDuplicateItem
      }
      switch status {
      case errSecSuccess:
        return true
      case refused:
        return false
      default:
        throw OfflineWalletError(
          failure: OfflineWalletFailure(keychainStatus: status), detail: "keychain write failed", status: status)
      }
    }

    public func delete(account: String, ifUnchangedFrom previous: Data) throws -> Bool {
      let status = SecItemDelete(conditionalQuery(account: account, previous: previous) as CFDictionary)
      switch status {
      case errSecSuccess:
        return true
      case errSecItemNotFound:
        return false
      default:
        throw OfflineWalletError(
          failure: OfflineWalletFailure(keychainStatus: status), detail: "keychain delete failed", status: status)
      }
    }
  }
#endif
