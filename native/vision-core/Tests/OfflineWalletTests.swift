import Foundation
import XCTest

@testable import PickleVisionCore

#if canImport(Security)
  import Security
#endif

/// Regression matrix for the native offline wallet (W05-01): Keychain-backed
/// storage of signed grants and unsent receipts with atomic replace, tamper
/// detection, owner isolation and typed failures. The store is an in-memory
/// double so every branch runs on macOS, iOS Simulator and Linux alike; the
/// Keychain adapter's query attributes are asserted separately where Security
/// is available.
final class OfflineWalletTests: XCTestCase {
  private let ownerA = "0f9d5a7e-3c1b-4a2d-9b8e-1c2d3e4f5a6b"
  private let ownerB = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"

  // MARK: - Empty / present / owner isolation

  func testAbsentWalletLoadsAsNilWithoutWriting() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)

    XCTAssertNil(try wallet.load(ownerId: ownerA))
    XCTAssertEqual(store.writeCount, 0)
    XCTAssertTrue(store.items.isEmpty)
  }

  func testReplacePersistsGrantsAndReceiptsAndBumpsRevision() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let contents = OfflineWalletContents(
      grants: [grant(id: "grant-1")],
      receipts: [receipt(id: "receipt-1"), receipt(id: "receipt-2", kind: .unusedTicketReturn)]
    )

    let written = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: contents)
    XCTAssertEqual(written.ownerId, ownerA)
    XCTAssertEqual(written.revision, 1)
    XCTAssertEqual(written.contents, contents)

    let loaded = try XCTUnwrap(try wallet.load(ownerId: ownerA))
    XCTAssertEqual(loaded, written)

    XCTAssertEqual(
      Set(store.items.keys),
      [OfflineWallet.integrityKeyAccount, OfflineWallet.walletAccount(ownerId: ownerA)]
    )

    let next = try wallet.replace(
      ownerId: ownerA,
      expectedRevision: 1,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-2")])
    )
    XCTAssertEqual(next.revision, 2)
    XCTAssertEqual(try wallet.load(ownerId: ownerA), next)
  }

  func testOwnersAreIsolated() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(
      ownerId: ownerA,
      expectedRevision: 0,
      contents: OfflineWalletContents(grants: [grant(id: "grant-a")], receipts: [])
    )

    XCTAssertNil(try wallet.load(ownerId: ownerB))

    let b = try wallet.replace(
      ownerId: ownerB,
      expectedRevision: 0,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-b")])
    )
    XCTAssertEqual(b.revision, 1)
    XCTAssertEqual(try XCTUnwrap(try wallet.load(ownerId: ownerA)).contents.grants.map(\.grantId), ["grant-a"])
    XCTAssertEqual(try XCTUnwrap(try wallet.load(ownerId: ownerB)).contents.receipts.map(\.receiptId), ["receipt-b"])
  }

  func testOwnerIdMustBeCanonicalBeforeAnyStoreAccess() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    for bad in ["", "user-1", ownerA.uppercased(), "0f9d5a7e-3c1b-0a2d-9b8e-1c2d3e4f5a6b", "0f9d5a7e-3c1b-4a2d-1b8e-1c2d3e4f5a6b"] {
      assertFailure(.invalidOwner) { try wallet.load(ownerId: bad) }
      assertFailure(.invalidOwner) {
        try wallet.replace(ownerId: bad, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
      }
      assertFailure(.invalidOwner) { try wallet.clear(ownerId: bad, expectedRevision: 0) }
    }
    XCTAssertEqual(store.readCount, 0)
    XCTAssertEqual(store.writeCount, 0)
  }

  // MARK: - Atomic replace

  func testReplaceRejectsStaleRevisionAndLeavesStoredStateUntouched() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let first = try wallet.replace(
      ownerId: ownerA,
      expectedRevision: 0,
      contents: OfflineWalletContents(grants: [grant(id: "grant-1")], receipts: [])
    )
    let writesAfterFirst = store.writeCount

    assertFailure(.revisionConflict) {
      try wallet.replace(
        ownerId: ownerA,
        expectedRevision: 0,
        contents: OfflineWalletContents(grants: [], receipts: [])
      )
    }
    assertFailure(.revisionConflict) {
      try wallet.replace(
        ownerId: ownerA,
        expectedRevision: 2,
        contents: OfflineWalletContents(grants: [], receipts: [])
      )
    }
    assertFailure(.revisionConflict) { try wallet.clear(ownerId: ownerA, expectedRevision: 0) }

    XCTAssertEqual(store.writeCount, writesAfterFirst)
    XCTAssertEqual(try wallet.load(ownerId: ownerA), first)
  }

  func testReplaceWritesTheWholeWalletInOneStoreWriteAfterValidation() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)

    assertFailure(.invalidGrant) {
      try wallet.replace(
        ownerId: ownerA,
        expectedRevision: 0,
        contents: OfflineWalletContents(grants: [OfflineStoredGrant(grantId: "g", compactJws: "not.a.jws")], receipts: [])
      )
    }
    XCTAssertEqual(store.writeCount, 0, "invalid input must not touch storage")

    _ = try wallet.replace(
      ownerId: ownerA,
      expectedRevision: 0,
      contents: OfflineWalletContents(grants: [grant(id: "grant-1")], receipts: [receipt(id: "receipt-1")])
    )
    let writesAfterCreate = store.writeCount
    XCTAssertEqual(store.writesByAccount[OfflineWallet.integrityKeyAccount], 1)
    XCTAssertEqual(store.writesByAccount[OfflineWallet.walletAccount(ownerId: ownerA)], 1)

    _ = try wallet.replace(
      ownerId: ownerA,
      expectedRevision: 1,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-1"), receipt(id: "receipt-2")])
    )
    XCTAssertEqual(store.writeCount, writesAfterCreate + 1, "a replace is exactly one item write")
    XCTAssertEqual(store.writesByAccount[OfflineWallet.integrityKeyAccount], 1, "integrity key is created once")
  }

  func testFailedStoreWriteSurfacesTypedFailureAndKeepsPreviousState() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let first = try wallet.replace(
      ownerId: ownerA,
      expectedRevision: 0,
      contents: OfflineWalletContents(grants: [grant(id: "grant-1")], receipts: [])
    )

    store.failNextWrite = OfflineWalletError(failure: .storageUnavailable, detail: "locked", status: -25308)
    let error = assertFailure(.storageUnavailable) {
      try wallet.replace(
        ownerId: ownerA,
        expectedRevision: 1,
        contents: OfflineWalletContents(grants: [], receipts: [])
      )
    }
    XCTAssertEqual(error?.status, -25308)
    XCTAssertEqual(try wallet.load(ownerId: ownerA), first)

    store.failNextWrite = nil
    let recovered = try wallet.replace(
      ownerId: ownerA,
      expectedRevision: 1,
      contents: OfflineWalletContents(grants: [], receipts: [])
    )
    XCTAssertEqual(recovered.revision, 2)
  }

  func testClearRemovesOnlyThatOwnerAndRequiresCurrentRevision() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(
      ownerId: ownerA,
      expectedRevision: 0,
      contents: OfflineWalletContents(grants: [grant(id: "grant-a")], receipts: [])
    )
    let b = try wallet.replace(
      ownerId: ownerB,
      expectedRevision: 0,
      contents: OfflineWalletContents(grants: [grant(id: "grant-b")], receipts: [])
    )

    assertFailure(.revisionConflict) { try wallet.clear(ownerId: ownerA, expectedRevision: 5) }
    try wallet.clear(ownerId: ownerA, expectedRevision: 1)
    XCTAssertNil(try wallet.load(ownerId: ownerA))
    XCTAssertEqual(try wallet.load(ownerId: ownerB), b)
    assertFailure(.revisionConflict) { try wallet.clear(ownerId: ownerA, expectedRevision: 1) }
    try wallet.clear(ownerId: ownerA, expectedRevision: 0)
  }

  // MARK: - Tamper detection

  func testFlippedPayloadByteIsTamperedNotEmptyAndCannotBeOverwrittenSilently() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(
      ownerId: ownerA,
      expectedRevision: 0,
      contents: OfflineWalletContents(grants: [grant(id: "grant-1")], receipts: [receipt(id: "receipt-1")])
    )

    let account = OfflineWallet.walletAccount(ownerId: ownerA)
    var bytes = try XCTUnwrap(store.items[account])
    let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
    let payloadBase64 = try XCTUnwrap(envelope["payload"] as? String)
    var payload = try XCTUnwrap(Data(base64Encoded: payloadBase64))
    let marker = Data("receipt-1".utf8)
    let range = try XCTUnwrap(payload.range(of: marker))
    payload.replaceSubrange(range, with: Data("receipt-9".utf8))
    var tampered = envelope
    tampered["payload"] = payload.base64EncodedString()
    bytes = try JSONSerialization.data(withJSONObject: tampered)
    store.items[account] = bytes

    assertFailure(.tampered) { try wallet.load(ownerId: ownerA) }
    assertFailure(.tampered) {
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
    }
    assertFailure(.tampered) {
      try wallet.replace(ownerId: ownerA, expectedRevision: 1, contents: OfflineWalletContents(grants: [], receipts: []))
    }
    assertFailure(.tampered) { try wallet.clear(ownerId: ownerA, expectedRevision: 0) }
    XCTAssertEqual(store.items[account], bytes, "corrupt state is preserved for reconciliation")
  }

  func testUndecodableBytesAreTampered() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
    store.items[OfflineWallet.walletAccount(ownerId: ownerA)] = Data([0xFF, 0x00, 0x7B])
    assertFailure(.tampered) { try wallet.load(ownerId: ownerA) }

    store.items[OfflineWallet.walletAccount(ownerId: ownerA)] = Data("{\"v\":1,\"payload\":\"AA==\",\"tag\":\"AA==\"}".utf8)
    assertFailure(.tampered) { try wallet.load(ownerId: ownerA) }
  }

  func testWalletBytesMovedBetweenOwnersAreTampered() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let a = try wallet.replace(
      ownerId: ownerA,
      expectedRevision: 0,
      contents: OfflineWalletContents(grants: [grant(id: "grant-a")], receipts: [])
    )
    store.items[OfflineWallet.walletAccount(ownerId: ownerB)] = store.items[OfflineWallet.walletAccount(ownerId: ownerA)]

    assertFailure(.tampered) { try wallet.load(ownerId: ownerB) }
    XCTAssertEqual(try wallet.load(ownerId: ownerA), a)
  }

  func testMissingIntegrityKeyIsReportedNotTreatedAsEmpty() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(
      ownerId: ownerA,
      expectedRevision: 0,
      contents: OfflineWalletContents(grants: [grant(id: "grant-1")], receipts: [])
    )
    store.items.removeValue(forKey: OfflineWallet.integrityKeyAccount)

    assertFailure(.integrityKeyMissing) { try wallet.load(ownerId: ownerA) }
    assertFailure(.integrityKeyMissing) {
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
    }
    XCTAssertEqual(store.writeCount, 2, "no new key is minted over an unreadable wallet")
  }

  func testUnsupportedEnvelopeVersionIsRejected() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
    store.items[OfflineWallet.walletAccount(ownerId: ownerA)] = Data("{\"v\":2,\"payload\":\"AA==\",\"tag\":\"AA==\"}".utf8)
    assertFailure(.unsupportedVersion) { try wallet.load(ownerId: ownerA) }
  }

  func testDiscardCorruptOnlyRemovesUnreadableWallets() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(
      ownerId: ownerA,
      expectedRevision: 0,
      contents: OfflineWalletContents(grants: [grant(id: "grant-1")], receipts: [])
    )
    let b = try wallet.replace(ownerId: ownerB, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))

    assertFailure(.notCorrupt) { try wallet.discardCorrupt(ownerId: ownerA) }
    XCTAssertNotNil(try wallet.load(ownerId: ownerA))

    store.items[OfflineWallet.walletAccount(ownerId: ownerA)] = Data([0x00])
    let discarded = try wallet.discardCorrupt(ownerId: ownerA)
    XCTAssertEqual(discarded, .tampered)
    XCTAssertNil(try wallet.load(ownerId: ownerA))
    XCTAssertEqual(try wallet.load(ownerId: ownerB), b)

    assertFailure(.notCorrupt) { try wallet.discardCorrupt(ownerId: ownerA) }
  }

  // MARK: - Shape validation

  func testGrantShapeValidation() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let good = grant(id: "grant-1")
    let cases: [OfflineStoredGrant] = [
      OfflineStoredGrant(grantId: "", compactJws: good.compactJws),
      OfflineStoredGrant(grantId: String(repeating: "g", count: 129), compactJws: good.compactJws),
      OfflineStoredGrant(grantId: "grant 1", compactJws: good.compactJws),
      OfflineStoredGrant(grantId: "grant-1", compactJws: ""),
      OfflineStoredGrant(grantId: "grant-1", compactJws: "a.b"),
      OfflineStoredGrant(grantId: "grant-1", compactJws: good.compactJws + ".extra"),
      OfflineStoredGrant(grantId: "grant-1", compactJws: good.compactJws.replacingOccurrences(of: "A", with: "+")),
      OfflineStoredGrant(grantId: "grant-1", compactJws: good.compactJws + "A"),
      OfflineStoredGrant(grantId: "grant-1", compactJws: String(good.compactJws.dropLast()) + "B"),
      OfflineStoredGrant(
        grantId: "grant-1",
        compactJws: [base64url("{\"alg\":\"ES256\"}"), "e3B", String(repeating: "A", count: 86)].joined(separator: ".")
      ),
      OfflineStoredGrant(
        grantId: "grant-1",
        compactJws: [
          base64url("{\"alg\":\"ES256\"}"), base64url(String(repeating: "x", count: 16_384)), String(repeating: "A", count: 86),
        ].joined(separator: ".")
      ),
    ]
    for candidate in cases {
      assertFailure(.invalidGrant, "\(candidate)") {
        try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [candidate], receipts: []))
      }
    }
    assertFailure(.invalidGrant, "duplicate grant id") {
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [good, good], receipts: []))
    }
    XCTAssertEqual(store.writeCount, 0)
  }

  func testReceiptShapeValidation() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let good = receipt(id: "receipt-1")
    let cases: [OfflineStoredReceipt] = [
      OfflineStoredReceipt(receiptId: "", kind: .result, payloadJson: good.payloadJson),
      OfflineStoredReceipt(receiptId: "receipt 1", kind: .result, payloadJson: good.payloadJson),
      OfflineStoredReceipt(receiptId: "receipt-1", kind: .result, payloadJson: ""),
      OfflineStoredReceipt(receiptId: "receipt-1", kind: .result, payloadJson: "[]"),
      OfflineStoredReceipt(receiptId: "receipt-1", kind: .result, payloadJson: "\"text\""),
      OfflineStoredReceipt(receiptId: "receipt-1", kind: .result, payloadJson: "{not json"),
      OfflineStoredReceipt(
        receiptId: "receipt-1", kind: .result,
        payloadJson: "{\"blob\":\"\(String(repeating: "x", count: OfflineWallet.Limits.maxReceiptPayloadBytes))\"}"
      ),
    ]
    for candidate in cases {
      assertFailure(.invalidReceipt, "\(candidate.receiptId) \(candidate.payloadJson.prefix(16))") {
        try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [candidate]))
      }
    }
    assertFailure(.invalidReceipt, "duplicate receipt id") {
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [good, good]))
    }
    XCTAssertEqual(store.writeCount, 0)
  }

  func testCapacityLimitsAreEnforced() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let tooManyGrants = (0...OfflineWallet.Limits.maxGrants).map { grant(id: "grant-\($0)") }
    assertFailure(.capacityExceeded) {
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: tooManyGrants, receipts: []))
    }
    let tooManyReceipts = (0...OfflineWallet.Limits.maxReceipts).map { receipt(id: "receipt-\($0)") }
    assertFailure(.capacityExceeded) {
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: tooManyReceipts))
    }
    XCTAssertEqual(store.writeCount, 0)

    let atLimit = OfflineWalletContents(
      grants: Array(tooManyGrants.dropLast()),
      receipts: Array(tooManyReceipts.dropLast())
    )
    XCTAssertEqual(try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: atLimit).contents, atLimit)
  }

  func testCanonicalBase64UrlTailsAreAccepted() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let signature = String(repeating: "A", count: 86)
    for claims in ["e30", "e30w", "eyJhIjoxfQ", base64url("{\"jti\":\"grant-1\"}")] {
      let jws = [base64url("{\"alg\":\"ES256\"}"), claims, signature].joined(separator: ".")
      let contents = OfflineWalletContents(grants: [OfflineStoredGrant(grantId: claims, compactJws: jws)], receipts: [])
      let stored = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: contents)
      XCTAssertEqual(stored.contents, contents)
      try wallet.clear(ownerId: ownerA, expectedRevision: 1)
    }
  }

  // MARK: - Bridge payloads

  func testBridgePayloadRoundTrip() throws {
    let contents = OfflineWalletContents(
      grants: [grant(id: "grant-1")],
      receipts: [receipt(id: "receipt-1"), receipt(id: "receipt-2", kind: .unusedTicketReturn)]
    )
    let snapshot = OfflineWalletSnapshot(ownerId: ownerA, revision: 7, contents: contents)
    let payload = snapshot.bridgePayload()
    XCTAssertEqual(payload["ownerId"] as? String, ownerA)
    XCTAssertEqual(payload["revision"] as? UInt64, 7)
    XCTAssertTrue(JSONSerialization.isValidJSONObject(payload))

    let parsed = try OfflineWalletContents(bridgePayload: payload)
    XCTAssertEqual(parsed, contents)

    let receipts = try XCTUnwrap(payload["receipts"] as? [[String: Any]])
    XCTAssertEqual(receipts.map { $0["kind"] as? String }, ["result", "unused_ticket_return"])
  }

  func testBridgePayloadRejectsMalformedShapesWithTypedFailures() throws {
    let grantPayload: [String: Any] = ["grantId": "grant-1", "compactJws": grant(id: "grant-1").compactJws]
    let receiptPayload: [String: Any] = ["receiptId": "receipt-1", "kind": "result", "payloadJson": "{}"]

    assertFailure(.invalidGrant) { try OfflineWalletContents(bridgePayload: ["receipts": [receiptPayload]]) }
    assertFailure(.invalidGrant) { try OfflineWalletContents(bridgePayload: ["grants": "nope", "receipts": []]) }
    assertFailure(.invalidGrant) { try OfflineWalletContents(bridgePayload: ["grants": [["grantId": 1]], "receipts": []]) }
    assertFailure(.invalidReceipt) { try OfflineWalletContents(bridgePayload: ["grants": [grantPayload]]) }
    assertFailure(.invalidReceipt) {
      try OfflineWalletContents(bridgePayload: ["grants": [], "receipts": [["receiptId": "r", "kind": "refund", "payloadJson": "{}"]]])
    }
    assertFailure(.invalidReceipt) {
      try OfflineWalletContents(bridgePayload: ["grants": [], "receipts": [["receiptId": "r", "kind": "result"]]])
    }

    let parsed = try OfflineWalletContents(bridgePayload: ["grants": [grantPayload], "receipts": [receiptPayload]])
    XCTAssertEqual(parsed.grants.count, 1)
    XCTAssertEqual(parsed.receipts.count, 1)
  }

  func testRevisionBridgeParsing() throws {
    XCTAssertEqual(try OfflineWallet.revision(fromBridge: 0), 0)
    XCTAssertEqual(try OfflineWallet.revision(fromBridge: 12), 12)
    assertFailure(.invalidRevision) { try OfflineWallet.revision(fromBridge: -1) }
    assertFailure(.invalidRevision) { try OfflineWallet.revision(fromBridge: 1.5) }
    assertFailure(.invalidRevision) { try OfflineWallet.revision(fromBridge: Double.nan) }
    XCTAssertEqual(try OfflineWallet.revision(fromBridge: 9_007_199_254_740_991), 9_007_199_254_740_991)
    assertFailure(.invalidRevision) { try OfflineWallet.revision(fromBridge: 9_007_199_254_740_992) }
  }

  // MARK: - Typed failures and integrity primitives

  func testFailureCodesAreStableAndDistinct() {
    let codes = OfflineWalletFailure.allCases.map(\.code)
    XCTAssertEqual(Set(codes).count, codes.count)
    for code in codes {
      XCTAssertTrue(code.hasPrefix("wallet."), code)
      XCTAssertNil(code.range(of: "[^a-z._]", options: .regularExpression), code)
    }
    XCTAssertEqual(OfflineWalletFailure.tampered.code, "wallet.tampered")
    XCTAssertEqual(OfflineWalletFailure.revisionConflict.code, "wallet.revision_conflict")
    XCTAssertEqual(OfflineWalletFailure.storageUnavailable.code, "wallet.storage_unavailable")
  }

  func testKeychainStatusMapping() {
    XCTAssertEqual(OfflineWalletFailure(keychainStatus: -25308), .storageUnavailable)
    XCTAssertEqual(OfflineWalletFailure(keychainStatus: -25291), .storageUnavailable)
    XCTAssertEqual(OfflineWalletFailure(keychainStatus: -34018), .storageDenied)
    XCTAssertEqual(OfflineWalletFailure(keychainStatus: -25293), .storageDenied)
    XCTAssertEqual(OfflineWalletFailure(keychainStatus: -25243), .storageDenied)
    XCTAssertEqual(OfflineWalletFailure(keychainStatus: -50), .storageFailure)
    XCTAssertEqual(OfflineWalletFailure(keychainStatus: -25300), .storageFailure)
  }

  func testIntegrityPrimitivesMatchPublishedVectors() {
    XCTAssertEqual(
      hex(OfflineWalletIntegrity.sha256(Data("abc".utf8))),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )
    XCTAssertEqual(
      hex(OfflineWalletIntegrity.sha256(Data())),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    )
    XCTAssertEqual(
      hex(OfflineWalletIntegrity.hmacSHA256(key: Data("Jefe".utf8), message: Data("what do ya want for nothing?".utf8))),
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
    )
    XCTAssertEqual(
      hex(
        OfflineWalletIntegrity.hmacSHA256(
          key: Data(repeating: 0x0B, count: 20), message: Data("Hi There".utf8))),
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
    )
    let longKey = Data(repeating: 0xAA, count: 131)
    XCTAssertEqual(
      hex(
        OfflineWalletIntegrity.hmacSHA256(
          key: longKey, message: Data("Test Using Larger Than Block-Size Key - Hash Key First".utf8))),
      "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
    )
    XCTAssertTrue(OfflineWalletIntegrity.constantTimeEquals(Data([1, 2, 3]), Data([1, 2, 3])))
    XCTAssertFalse(OfflineWalletIntegrity.constantTimeEquals(Data([1, 2, 3]), Data([1, 2, 4])))
    XCTAssertFalse(OfflineWalletIntegrity.constantTimeEquals(Data([1, 2, 3]), Data([1, 2])))
  }

  #if canImport(Security)
    func testKeychainQueriesPinDeviceOnlyAfterFirstUnlockAndDistinctService() {
      let store = KeychainOfflineWalletStore()
      let account = OfflineWallet.walletAccount(ownerId: ownerA)
      let query = store.itemQuery(account: account)
      XCTAssertEqual(query[kSecClass as String] as? String, kSecClassGenericPassword as String)
      XCTAssertEqual(query[kSecAttrService as String] as? String, "com.picklesensei.offline.wallet")
      XCTAssertEqual(query[kSecAttrAccount as String] as? String, account)
      XCTAssertEqual(query[kSecAttrSynchronizable as String] as? Bool, false)
      XCTAssertEqual(query[kSecUseDataProtectionKeychain as String] as? Bool, true)

      let attributes = store.addAttributes(account: account, data: Data([1]))
      XCTAssertEqual(
        attributes[kSecAttrAccessible as String] as? String,
        kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String
      )
      XCTAssertEqual(attributes[kSecAttrSynchronizable as String] as? Bool, false)
      XCTAssertEqual(attributes[kSecValueData as String] as? Data, Data([1]))
      XCTAssertEqual(attributes[kSecAttrService as String] as? String, "com.picklesensei.offline.wallet")

      let update = store.updateAttributes(data: Data([2]))
      XCTAssertEqual(
        update[kSecAttrAccessible as String] as? String,
        kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String,
        "every replace re-asserts the protection class, not only the first add"
      )
      XCTAssertEqual(update[kSecValueData as String] as? Data, Data([2]))
      XCTAssertEqual(update.count, 2, "an update never rewrites the item's identity attributes")
      XCTAssertNotEqual(OfflineWallet.keychainService, "com.picklesensei.auth.session")
    }
  #endif

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

  private func base64url(_ text: String) -> String {
    Data(text.utf8).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  private func hex(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
  }
}

private final class MemoryWalletStore: OfflineWalletSecureStore {
  var items: [String: Data] = [:]
  var readCount = 0
  var writeCount = 0
  var writesByAccount: [String: Int] = [:]
  var failNextWrite: OfflineWalletError?

  func read(account: String) throws -> Data? {
    readCount += 1
    return items[account]
  }

  func write(account: String, data: Data) throws {
    if let failure = failNextWrite {
      failNextWrite = nil
      throw failure
    }
    writeCount += 1
    writesByAccount[account, default: 0] += 1
    items[account] = data
  }

  func delete(account: String) throws {
    items.removeValue(forKey: account)
  }
}
