import Foundation
import XCTest

@testable import PickleVisionCore

/// Adversarial matrix for the native offline wallet (W05-01, candidate
/// 64f7353e). Every test asserts the behaviour the wallet SHOULD have at a
/// failure boundary; a failing test here is a confirmed break, a passing test
/// is an attack that did not land. The candidate's own tests are untouched.
///
/// Attacks covered: corrupt/partial persisted state (integrity key length,
/// rollback of an older valid envelope, envelope version flip), boundary
/// values (documented capacity, revisions beyond the JS-safe range, extreme
/// bridge doubles), concurrency (unserialised replace), owner interleaving,
/// duplicate identities and crash-between-steps recovery.
final class OfflineWalletAttackTests: XCTestCase {
  private let ownerA = "0f9d5a7e-3c1b-4a2d-9b8e-1c2d3e4f5a6b"
  private let ownerB = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"

  // MARK: - Attack 1: corrupt integrity key with no wallet -> permanent brick?

  func testAttack01_CorruptIntegrityKeyWithoutWalletHasRecoveryPath() throws {
    let store = AttackMemoryStore()
    let wallet = OfflineWallet(store: store)
    store.items[OfflineWallet.integrityKeyAccount] = Data(repeating: 0x41, count: 31)

    // First write is refused as tampered even though this owner has no wallet.
    assertFailure(.tampered, "replace with short key") {
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: .init(grants: [], receipts: []))
    }
    // load says "nothing stored" (nil) — the caller cannot even see the corruption.
    XCTAssertNil(try wallet.load(ownerId: ownerA))

    // The only documented exit for corrupt state is discardCorrupt; it must
    // either remove the corrupt key or report a failure the caller can act on.
    let discardOutcome: OfflineWalletFailure?
    do {
      discardOutcome = try wallet.discardCorrupt(ownerId: ownerA)
    } catch let error as OfflineWalletError {
      discardOutcome = error.failure
    }
    XCTAssertNotEqual(
      discardOutcome, .notCorrupt,
      "discardCorrupt claims the wallet is not corrupt while every write is refused as tampered"
    )

    // After the explicit recovery step the owner must be able to write again.
    XCTAssertNoThrow(
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: .init(grants: [], receipts: [])),
      "no API sequence recovers a wallet whose integrity key has the wrong length"
    )
  }

  // MARK: - Attack 2: corrupt integrity key with a wallet -> discard deletes data, key stays

  func testAttack02_CorruptIntegrityKeyWithWalletRecoversAfterDiscard() throws {
    let store = AttackMemoryStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(
      ownerId: ownerA, expectedRevision: 0,
      contents: .init(grants: [grant(id: "grant-1")], receipts: [receipt(id: "receipt-1")])
    )
    store.items[OfflineWallet.integrityKeyAccount] = Data(repeating: 0x41, count: 33)

    assertFailure(.tampered, "load with long key") { try wallet.load(ownerId: ownerA) }
    XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerA), .tampered)
    XCTAssertNil(store.items[OfflineWallet.walletAccount(ownerId: ownerA)], "wallet item deleted")

    // The corrupt key survives discardCorrupt, so the owner is still bricked.
    XCTAssertNoThrow(
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: .init(grants: [], receipts: [])),
      "discardCorrupt removed the (intact) wallet but left the corrupt key: every future write is tampered"
    )
    // And owner B — who never had a wallet — is bricked by owner A's key state too.
    XCTAssertNoThrow(
      try wallet.replace(ownerId: ownerB, expectedRevision: 0, contents: .init(grants: [], receipts: [])),
      "a corrupt device key blocks every owner, and discardCorrupt(ownerB) reports not_corrupt"
    )
  }

  // MARK: - Attack 3: rollback — restore an older, validly tagged envelope

  func testAttack03_RollbackToEarlierValidEnvelopeIsDetected() throws {
    let store = AttackMemoryStore()
    let wallet = OfflineWallet(store: store)
    let account = OfflineWallet.walletAccount(ownerId: ownerA)

    let first = try wallet.replace(
      ownerId: ownerA, expectedRevision: 0,
      contents: .init(grants: [grant(id: "grant-spent-later")], receipts: [])
    )
    XCTAssertEqual(first.revision, 1)
    let revision1Bytes = try XCTUnwrap(store.items[account])

    // The grant is spent: the wallet moves to revision 2 without it, holding
    // the receipt that proves the spend.
    let second = try wallet.replace(
      ownerId: ownerA, expectedRevision: 1,
      contents: .init(grants: [], receipts: [receipt(id: "receipt-for-spent-grant")])
    )
    XCTAssertEqual(second.revision, 2)

    // Same-device backup restore / attacker replays the revision-1 item bytes.
    store.items[account] = revision1Bytes

    let rolledBack = try wallet.load(ownerId: ownerA)
    XCTAssertNil(
      rolledBack?.contents.grants.first(where: { $0.grantId == "grant-spent-later" }),
      "a spent grant re-appears as available after restoring an older envelope (no anti-rollback)"
    )
    XCTAssertFalse(
      rolledBack?.contents.receipts.isEmpty ?? false,
      "the unsent receipt proving the spend vanished silently"
    )
  }

  // MARK: - Attack 4: documented per-item limits at full capacity

  func testAttack04_DocumentedCapacityIsStorable() throws {
    let store = AttackMemoryStore()
    let wallet = OfflineWallet(store: store)

    let grants = (0..<OfflineWallet.Limits.maxGrants).map { maxSizeGrant(index: $0) }
    let receipts = (0..<OfflineWallet.Limits.maxReceipts).map { maxSizeReceipt(index: $0) }
    for g in grants {
      XCTAssertLessThanOrEqual(g.compactJws.utf8.count, OfflineWallet.Limits.maxGrantJwsBytes)
    }
    for r in receipts {
      XCTAssertLessThanOrEqual(r.payloadJson.utf8.count, OfflineWallet.Limits.maxReceiptPayloadBytes)
    }
    let contents = OfflineWalletContents(grants: grants, receipts: receipts)

    // Shape/capacity validation accepts this wallet ...
    XCTAssertNoThrow(try OfflineWallet.validate(contents))

    // ... so replace must store it, or the documented limits are not real.
    do {
      let snapshot = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: contents)
      XCTAssertEqual(snapshot.contents, contents)
    } catch let error as OfflineWalletError {
      // Find how many such receipts actually fit beside 8 maximal grants.
      var fits = 0
      for count in stride(from: receipts.count - 1, through: 0, by: -1) {
        let probe = OfflineWallet(store: AttackMemoryStore())
        if (try? probe.replace(
          ownerId: ownerA, expectedRevision: 0,
          contents: .init(grants: grants, receipts: Array(receipts.prefix(count)))
        )) != nil {
          fits = count
          break
        }
      }
      XCTFail(
        "wallet within all documented per-item limits (\(grants.count) grants ≤ \(OfflineWallet.Limits.maxGrantJwsBytes) B, "
          + "\(receipts.count) receipts ≤ \(OfflineWallet.Limits.maxReceiptPayloadBytes) B) was refused: "
          + "\(error.failure) — \(error.detail); only \(fits) such receipts fit beside \(grants.count) maximal grants"
      )
    }
  }

  func testAttack04b_QuoteFreeReceiptsAtCapacityStore() throws {
    // Control: the same counts with quote-free payloads fit, proving the
    // refusal above comes from JSON escaping inflating the envelope.
    let store = AttackMemoryStore()
    let wallet = OfflineWallet(store: store)
    let grants = (0..<OfflineWallet.Limits.maxGrants).map { maxSizeGrant(index: $0) }
    let receipts = (0..<OfflineWallet.Limits.maxReceipts).map { index in
      OfflineStoredReceipt(
        receiptId: "receipt-\(index)",
        kind: .result,
        payloadJson: "{\"k\":\"" + String(repeating: "x", count: 8_000) + "\"}"
      )
    }
    XCTAssertNoThrow(
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: .init(grants: grants, receipts: receipts))
    )
  }

  // MARK: - Attack 5: stored revision beyond the JS-safe range

  func testAttack05_StoredRevisionBeyondBridgeRangeIsNotAcceptedAsReadable() throws {
    let store = AttackMemoryStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: .init(grants: [], receipts: []))

    // Replace the stored item with a validly tagged payload at revision 2^53
    // (anything a same-store writer can do, or 2^53 - 1 legitimate replaces).
    let unsafeRevision: UInt64 = 9_007_199_254_740_992
    store.items[OfflineWallet.walletAccount(ownerId: ownerA)] = forgeEnvelope(
      store: store, ownerId: ownerA, revision: unsafeRevision
    )

    let loaded = try wallet.load(ownerId: ownerA)
    XCTAssertEqual(loaded?.revision, unsafeRevision, "core reads the wallet fine")

    // The bridge refuses that revision as an input, so JS can never fence a
    // replace or clear against it ...
    assertFailure(.invalidRevision) { try OfflineWallet.revision(fromBridge: Double(unsafeRevision)) }

    // ... and the wallet must therefore not be considered healthy: either load
    // refuses it or discardCorrupt removes it.
    let outcome: OfflineWalletFailure?
    do {
      outcome = try wallet.discardCorrupt(ownerId: ownerA)
    } catch let error as OfflineWalletError {
      outcome = error.failure
    }
    XCTAssertNotEqual(
      outcome, .notCorrupt,
      "wallet at revision 2^53 is unreachable from JS (invalid_revision on every fence) yet reported not_corrupt"
    )
  }

  func testAttack05b_LegitimateReplaceAtSafeMaxProducesUnrepresentableRevision() throws {
    let store = AttackMemoryStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: .init(grants: [], receipts: []))
    let safeMax: UInt64 = 9_007_199_254_740_991
    store.items[OfflineWallet.walletAccount(ownerId: ownerA)] = forgeEnvelope(store: store, ownerId: ownerA, revision: safeMax)

    let expected = try OfflineWallet.revision(fromBridge: Double(safeMax))
    let next = try wallet.replace(ownerId: ownerA, expectedRevision: expected, contents: .init(grants: [], receipts: []))
    // The bridge payload carries this revision to JS where it is rejected as a
    // contract breach (Number.isSafeInteger fails) although the write happened.
    XCTAssertLessThanOrEqual(
      next.revision, safeMax,
      "replace at the last JS-safe revision succeeded and produced revision \(next.revision), which the JS side rejects and can never fence again"
    )
  }

  // MARK: - Attack 6: unserialised concurrent replace (lost update)

  func testAttack06_InterleavedReplaceWithoutSerialQueueConflicts() throws {
    let store = AttackMemoryStore()
    let first = OfflineWallet(store: store)
    let second = OfflineWallet(store: store)
    _ = try first.replace(ownerId: ownerA, expectedRevision: 0, contents: .init(grants: [grant(id: "g0")], receipts: []))

    // Between `first`'s verified read and its write, `second` commits.
    var interleaved = false
    let secondContents = OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-from-second")])
    store.onReadWalletAccount = { [ownerA] account in
      guard !interleaved, account == OfflineWallet.walletAccount(ownerId: ownerA) else { return }
      interleaved = true
      _ = try second.replace(ownerId: ownerA, expectedRevision: 1, contents: secondContents)
    }

    let outcome: Result<OfflineWalletSnapshot, Error> = Result {
      try first.replace(ownerId: ownerA, expectedRevision: 1, contents: .init(grants: [grant(id: "g0")], receipts: []))
    }
    store.onReadWalletAccount = nil

    switch outcome {
    case .success(let snapshot):
      XCTFail("first replace succeeded at revision \(snapshot.revision) and silently dropped second's receipt (lost update)")
    case .failure(let error):
      XCTAssertEqual((error as? OfflineWalletError)?.failure, .revisionConflict)
    }
    let final = try XCTUnwrap(try first.load(ownerId: ownerA))
    XCTAssertEqual(final.contents.receipts.map(\.receiptId), ["receipt-from-second"])
  }

  // MARK: - Attack 7: envelope version flip (v is outside the MAC)

  func testAttack07_EnvelopeVersionFlipIsRefusedAndDiscardable() throws {
    let store = AttackMemoryStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: .init(grants: [grant(id: "g")], receipts: []))
    let account = OfflineWallet.walletAccount(ownerId: ownerA)
    var object = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: XCTUnwrap(store.items[account])) as? [String: Any]
    )
    object["v"] = 2
    store.items[account] = try JSONSerialization.data(withJSONObject: object)

    assertFailure(.unsupportedVersion) { try wallet.load(ownerId: ownerA) }
    assertFailure(.unsupportedVersion) { try wallet.clear(ownerId: ownerA, expectedRevision: 1) }
    assertFailure(.unsupportedVersion) {
      try wallet.replace(ownerId: ownerA, expectedRevision: 1, contents: .init(grants: [], receipts: []))
    }
    XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerA), .unsupportedVersion)
    XCTAssertNil(try wallet.load(ownerId: ownerA))
    XCTAssertEqual(
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: .init(grants: [], receipts: [])).revision, 1
    )
  }

  // MARK: - Attack 8: owner interleaving while one owner is corrupt

  func testAttack08_CorruptOwnerDoesNotBlockOrLeakIntoOtherOwner() throws {
    let store = AttackMemoryStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: .init(grants: [grant(id: "a")], receipts: []))
    _ = try wallet.replace(ownerId: ownerB, expectedRevision: 0, contents: .init(grants: [grant(id: "b")], receipts: []))

    let accountA = OfflineWallet.walletAccount(ownerId: ownerA)
    var bytes = try XCTUnwrap(store.items[accountA])
    bytes[bytes.count / 2] ^= 0x01
    store.items[accountA] = bytes

    assertFailure(.tampered) { try wallet.load(ownerId: ownerA) }
    XCTAssertEqual(try wallet.load(ownerId: ownerB)?.contents.grants.map(\.grantId), ["b"])
    XCTAssertEqual(
      try wallet.replace(ownerId: ownerB, expectedRevision: 1, contents: .init(grants: [], receipts: [receipt(id: "rb")]))
        .revision,
      2
    )
    assertFailure(.notCorrupt) { try wallet.discardCorrupt(ownerId: ownerB) }
    XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerA), .tampered)
    XCTAssertEqual(try wallet.load(ownerId: ownerB)?.revision, 2)
    XCTAssertNotNil(store.items[OfflineWallet.walletAccount(ownerId: ownerB)])
  }

  // MARK: - Attack 9: duplicate identities across owners and within an owner

  func testAttack09_DuplicateIdentitiesAreRejectedPerOwnerBeforeStorage() throws {
    let store = AttackMemoryStore()
    let wallet = OfflineWallet(store: store)

    assertFailure(.invalidGrant) {
      try wallet.replace(
        ownerId: ownerA, expectedRevision: 0,
        contents: .init(grants: [grant(id: "dup"), grant(id: "dup")], receipts: [])
      )
    }
    assertFailure(.invalidReceipt) {
      try wallet.replace(
        ownerId: ownerA, expectedRevision: 0,
        contents: .init(grants: [], receipts: [receipt(id: "dup"), receipt(id: "dup", kind: .unusedTicketReturn)])
      )
    }
    XCTAssertEqual(store.readCount, 0, "duplicate identities must be refused before any store access")
    XCTAssertEqual(store.writeCount, 0)

    // The same grant id in two owners' wallets is legitimate (per-owner scope).
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: .init(grants: [grant(id: "shared")], receipts: []))
    _ = try wallet.replace(ownerId: ownerB, expectedRevision: 0, contents: .init(grants: [grant(id: "shared")], receipts: []))
    XCTAssertEqual(try wallet.load(ownerId: ownerA)?.contents.grants.count, 1)
    XCTAssertEqual(try wallet.load(ownerId: ownerB)?.contents.grants.count, 1)
  }

  // MARK: - Attack 10: bridge revision boundary doubles

  func testAttack10_BridgeRevisionBoundaryDoubles() throws {
    XCTAssertEqual(try OfflineWallet.revision(fromBridge: -0.0), 0)
    XCTAssertEqual(try OfflineWallet.revision(fromBridge: 9_007_199_254_740_991), 9_007_199_254_740_991)
    for bad in [
      Double.nan, .infinity, -.infinity, -1, -0.5, 0.5, 1e-9, Double.leastNonzeroMagnitude,
      9_007_199_254_740_992, 1.8446744073709552e19, Double.greatestFiniteMagnitude,
    ] {
      assertFailure(.invalidRevision, "value \(bad)") { try OfflineWallet.revision(fromBridge: bad) }
    }

    // Extreme UInt64 fences against an absent wallet must be a typed conflict,
    // never a trap.
    let wallet = OfflineWallet(store: AttackMemoryStore())
    assertFailure(.revisionConflict) {
      try wallet.replace(ownerId: ownerA, expectedRevision: .max, contents: .init(grants: [], receipts: []))
    }
    assertFailure(.revisionConflict) { try wallet.clear(ownerId: ownerA, expectedRevision: .max) }
  }

  // MARK: - Attack 11: crash between integrity-key mint and wallet write

  func testAttack11_CrashBetweenKeyMintAndWalletWriteRecovers() throws {
    let store = AttackMemoryStore()
    let wallet = OfflineWallet(store: store)
    store.failWriteForAccount = OfflineWallet.walletAccount(ownerId: ownerA)

    assertFailure(.storageFailure) {
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: .init(grants: [grant(id: "g")], receipts: []))
    }
    XCTAssertEqual(Set(store.items.keys), [OfflineWallet.integrityKeyAccount], "key minted, wallet absent")
    let mintedKey = store.items[OfflineWallet.integrityKeyAccount]

    XCTAssertNil(try wallet.load(ownerId: ownerA))
    let written = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: .init(grants: [grant(id: "g")], receipts: []))
    XCTAssertEqual(written.revision, 1)
    XCTAssertEqual(store.items[OfflineWallet.integrityKeyAccount], mintedKey, "the orphaned key is reused, not replaced")
    XCTAssertEqual(try wallet.load(ownerId: ownerA), written)
  }

  // MARK: - Attack 12: store faults surface as typed failures, never as empty

  func testAttack12_StoreReadFaultsAreTypedNotEmpty() throws {
    let store = AttackMemoryStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: .init(grants: [grant(id: "g")], receipts: []))

    store.failNextRead = OfflineWalletError(failure: .storageDenied, detail: "locked", status: -25308)
    let denied = assertFailure(.storageDenied) { try wallet.load(ownerId: ownerA) }
    XCTAssertEqual(denied?.status, -25308)

    struct Alien: Error {}
    store.failNextReadAlien = Alien()
    assertFailure(.storageFailure) { try wallet.load(ownerId: ownerA) }

    // A read fault during discardCorrupt must not delete anything.
    store.failNextRead = OfflineWalletError(failure: .storageUnavailable, detail: "interaction not allowed", status: -25308)
    assertFailure(.storageUnavailable) { try wallet.discardCorrupt(ownerId: ownerA) }
    XCTAssertNotNil(store.items[OfflineWallet.walletAccount(ownerId: ownerA)])
    XCTAssertEqual(try wallet.load(ownerId: ownerA)?.revision, 1)
  }

  // MARK: - Helpers

  @discardableResult
  private func assertFailure<T>(
    _ expected: OfflineWalletFailure,
    _ context: String = "",
    file: StaticString = #filePath,
    line: UInt = #line,
    _ body: () throws -> T
  ) -> OfflineWalletError? {
    do {
      _ = try body()
      XCTFail("expected \(expected) \(context)", file: file, line: line)
      return nil
    } catch let error as OfflineWalletError {
      XCTAssertEqual(error.failure, expected, context, file: file, line: line)
      return error
    } catch {
      XCTFail("expected OfflineWalletError(\(expected)) got \(error) \(context)", file: file, line: line)
      return nil
    }
  }

  private func grant(id: String) -> OfflineStoredGrant {
    let header = base64url("{\"alg\":\"ES256\",\"typ\":\"pickle-offline-execution-grant+jwt\",\"kid\":\"kid-1\"}")
    let claims = base64url("{\"jti\":\"\(id)\",\"aud\":\"urn:pickle-sensei:offline-execution:v1\"}")
    let signature = String(repeating: "A", count: 86)
    return OfflineStoredGrant(grantId: id, compactJws: [header, claims, signature].joined(separator: "."))
  }

  private func receipt(id: String, kind: OfflineStoredReceiptKind = .result) -> OfflineStoredReceipt {
    OfflineStoredReceipt(
      receiptId: id,
      kind: kind,
      payloadJson: "{\"schemaVersion\":\"offline-result-receipt-v1\",\"receiptId\":\"\(id)\"}"
    )
  }

  /// A grant whose compact JWS is exactly `maxGrantJwsBytes` bytes
  /// (1024-char header, 15272-char claims, 86-char signature, two dots).
  private func maxSizeGrant(index: Int) -> OfflineStoredGrant {
    let header = String(repeating: "A", count: 1_024)
    let claims = String(repeating: "B", count: 15_272)
    let signature = String(repeating: "A", count: 86)
    return OfflineStoredGrant(grantId: "grant-\(index)", compactJws: [header, claims, signature].joined(separator: "."))
  }

  /// A receipt payload just under `maxReceiptPayloadBytes` shaped like a real
  /// receipt: a flat JSON object of short string fields (≈ 40 % quote bytes).
  private func maxSizeReceipt(index: Int) -> OfflineStoredReceipt {
    var fields: [String] = ["\"schemaVersion\":\"offline-result-receipt-v1\"", "\"receiptId\":\"receipt-\(index)\""]
    var size = 2 + fields.joined(separator: ",").utf8.count
    var n = 0
    while true {
      let field = "\"f\(n)\":\"v\(n)\""
      let next = size + 1 + field.utf8.count
      if next > OfflineWallet.Limits.maxReceiptPayloadBytes { break }
      fields.append(field)
      size = next
      n += 1
    }
    return OfflineStoredReceipt(receiptId: "receipt-\(index)", kind: .result, payloadJson: "{" + fields.joined(separator: ",") + "}")
  }

  /// Produces envelope bytes the wallet accepts for `ownerId` at `revision`,
  /// using the integrity key that sits in the same store (same-store writers
  /// can always do this — the MAC only binds account + payload).
  private func forgeEnvelope(store: AttackMemoryStore, ownerId: String, revision: UInt64) -> Data {
    let key = store.items[OfflineWallet.integrityKeyAccount]!
    let account = OfflineWallet.walletAccount(ownerId: ownerId)
    let payload = Data("{\"grants\":[],\"ownerId\":\"\(ownerId)\",\"receipts\":[],\"revision\":\(revision)}".utf8)
    var message = Data("pickle-offline-wallet-v1".utf8)
    message.append(0)
    message.append(Data(account.utf8))
    message.append(0)
    message.append(payload)
    let tag = OfflineWalletIntegrity.hmacSHA256(key: key, message: message)
    let envelope: [String: Any] = [
      "v": OfflineWallet.envelopeVersion,
      "payload": payload.base64EncodedString(),
      "tag": tag.base64EncodedString(),
    ]
    return try! JSONSerialization.data(withJSONObject: envelope)
  }

  private func base64url(_ text: String) -> String {
    Data(text.utf8).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}

private final class AttackMemoryStore: OfflineWalletSecureStore {
  var items: [String: Data] = [:]
  var readCount = 0
  var writeCount = 0
  var failNextRead: OfflineWalletError?
  var failNextReadAlien: Error?
  var failWriteForAccount: String?
  var onReadWalletAccount: ((String) throws -> Void)?

  func read(account: String) throws -> Data? {
    readCount += 1
    if let failure = failNextRead {
      failNextRead = nil
      throw failure
    }
    if let alien = failNextReadAlien {
      failNextReadAlien = nil
      throw alien
    }
    let value = items[account]
    try onReadWalletAccount?(account)
    return value
  }

  func write(account: String, data: Data) throws {
    if account == failWriteForAccount {
      failWriteForAccount = nil
      throw OfflineWalletError(failure: .storageFailure, detail: "simulated crash before wallet write", status: -25299)
    }
    writeCount += 1
    items[account] = data
  }

  func delete(account: String) throws {
    items.removeValue(forKey: account)
  }
}
