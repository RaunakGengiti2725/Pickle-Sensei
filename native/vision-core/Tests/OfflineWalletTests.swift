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
  private let safeMaxRevision: UInt64 = 9_007_199_254_740_991

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
      [
        OfflineWallet.integrityKeyAccount(ownerId: ownerA),
        OfflineWallet.fenceAccount(ownerId: ownerA),
        OfflineWallet.walletAccount(ownerId: ownerA),
      ]
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
    XCTAssertNotEqual(
      store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerA)],
      store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerB)],
      "each owner seals with its own integrity key"
    )
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
      assertFailure(.invalidOwner) { try wallet.discardCorrupt(ownerId: bad) }
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
    let walletAccount = OfflineWallet.walletAccount(ownerId: ownerA)
    let keyAccount = OfflineWallet.integrityKeyAccount(ownerId: ownerA)
    let fenceAccount = OfflineWallet.fenceAccount(ownerId: ownerA)

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
    XCTAssertEqual(store.writesByAccount[keyAccount], 1)
    XCTAssertEqual(store.writesByAccount[walletAccount], 1)
    XCTAssertEqual(store.writesByAccount[fenceAccount], 2, "fence is initialised before and committed after the wallet")
    XCTAssertEqual(
      store.writeOrder, [keyAccount, fenceAccount, walletAccount, fenceAccount],
      "the wallet item is written after its key and fence exist, then the fence is advanced"
    )

    _ = try wallet.replace(
      ownerId: ownerA,
      expectedRevision: 1,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-1"), receipt(id: "receipt-2")])
    )
    XCTAssertEqual(store.writesByAccount[walletAccount], 2, "a replace is exactly one wallet item write")
    XCTAssertEqual(store.writesByAccount[fenceAccount], 3, "plus one fence advance")
    XCTAssertEqual(store.writesByAccount[keyAccount], 1, "integrity key is created once")
    XCTAssertEqual(Array(store.writeOrder.suffix(2)), [walletAccount, fenceAccount])
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

  func testStoreReadFaultsAreTypedNotTreatedAsEmpty() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(
      ownerId: ownerA,
      expectedRevision: 0,
      contents: OfflineWalletContents(grants: [grant(id: "grant-1")], receipts: [])
    )

    for failure in [OfflineWalletFailure.storageUnavailable, .storageDenied, .storageFailure] {
      store.failNextRead = OfflineWalletError(failure: failure, detail: "fault", status: -1)
      assertFailure(failure, "load") { try wallet.load(ownerId: ownerA) }
      store.failNextRead = OfflineWalletError(failure: failure, detail: "fault", status: -1)
      assertFailure(failure, "replace") {
        try wallet.replace(ownerId: ownerA, expectedRevision: 1, contents: OfflineWalletContents(grants: [], receipts: []))
      }
      store.failNextRead = OfflineWalletError(failure: failure, detail: "fault", status: -1)
      assertFailure(failure, "clear") { try wallet.clear(ownerId: ownerA, expectedRevision: 1) }
      store.failNextRead = OfflineWalletError(failure: failure, detail: "fault", status: -1)
      assertFailure(failure, "discard") { try wallet.discardCorrupt(ownerId: ownerA) }
    }
    XCTAssertEqual(try XCTUnwrap(try wallet.load(ownerId: ownerA)).revision, 1)
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

  // MARK: - Concurrency (compare-and-swap, not just the bridge queue)

  func testInterleavedReplaceFromASecondInstanceConflictsAndKeepsTheCommittedReceipt() throws {
    let store = MemoryWalletStore()
    let first = OfflineWallet(store: store)
    let second = OfflineWallet(store: store)
    _ = try first.replace(
      ownerId: ownerA,
      expectedRevision: 0,
      contents: OfflineWalletContents(grants: [grant(id: "grant-1")], receipts: [])
    )

    var interleaved = false
    var secondResult: OfflineWalletSnapshot?
    store.onReadWalletAccount = { [ownerA] account in
      guard !interleaved, account == OfflineWallet.walletAccount(ownerId: ownerA) else { return }
      interleaved = true
      secondResult = try second.replace(
        ownerId: ownerA,
        expectedRevision: 1,
        contents: OfflineWalletContents(grants: [], receipts: [self.receipt(id: "receipt-from-second")])
      )
    }

    assertFailure(.revisionConflict, "first writer must lose after second committed") {
      try first.replace(
        ownerId: ownerA,
        expectedRevision: 1,
        contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-from-first")])
      )
    }
    XCTAssertEqual(secondResult?.revision, 2)
    store.onReadWalletAccount = nil
    let stored = try XCTUnwrap(try first.load(ownerId: ownerA))
    XCTAssertEqual(stored.revision, 2)
    XCTAssertEqual(stored.contents.receipts.map(\.receiptId), ["receipt-from-second"])
  }

  func testInterleavedClearConflictsInsteadOfDroppingAConcurrentWrite() throws {
    let store = MemoryWalletStore()
    let first = OfflineWallet(store: store)
    let second = OfflineWallet(store: store)
    _ = try first.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))

    var interleaved = false
    store.onReadWalletAccount = { [ownerA] account in
      guard !interleaved, account == OfflineWallet.walletAccount(ownerId: ownerA) else { return }
      interleaved = true
      _ = try second.replace(
        ownerId: ownerA,
        expectedRevision: 1,
        contents: OfflineWalletContents(grants: [], receipts: [self.receipt(id: "receipt-late")])
      )
    }
    assertFailure(.revisionConflict) { try first.clear(ownerId: ownerA, expectedRevision: 1) }
    store.onReadWalletAccount = nil
    XCTAssertEqual(try XCTUnwrap(try first.load(ownerId: ownerA)).contents.receipts.map(\.receiptId), ["receipt-late"])
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
    let marker = Data("receipt-1".utf8)
    let range = try XCTUnwrap(bytes.range(of: marker))
    bytes.replaceSubrange(range, with: Data("receipt-9".utf8))
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
    let account = OfflineWallet.walletAccount(ownerId: ownerA)

    store.items[account] = Data([0xFF, 0x00, 0x7B])
    assertFailure(.tampered, "too short") { try wallet.load(ownerId: ownerA) }

    store.items[account] = Data([OfflineWallet.envelopeVersion]) + Data(repeating: 0, count: 32) + Data("{}".utf8)
    assertFailure(.tampered, "zero tag") { try wallet.load(ownerId: ownerA) }

    store.items[account] = Data([0]) + Data(repeating: 0, count: 32) + Data("{}".utf8)
    assertFailure(.tampered, "version zero") { try wallet.load(ownerId: ownerA) }

    let key = try XCTUnwrap(store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerA)])
    store.items[account] = OfflineWallet.seal(payload: Data("not json".utf8), account: account, key: key)
    assertFailure(.tampered, "authentic envelope around an undecodable payload") { try wallet.load(ownerId: ownerA) }

    store.items[account] = forgeWallet(store: store, ownerId: ownerA, revision: 1, grants: [grant(id: "g"), grant(id: "g")])
    assertFailure(.tampered, "authentic envelope violating its own shape rules") { try wallet.load(ownerId: ownerA) }
  }

  func testWalletBytesMovedBetweenOwnersAreTampered() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let a = try wallet.replace(
      ownerId: ownerA,
      expectedRevision: 0,
      contents: OfflineWalletContents(grants: [grant(id: "grant-a")], receipts: [])
    )
    for account in [
      OfflineWallet.walletAccount(ownerId:), OfflineWallet.integrityKeyAccount(ownerId:), OfflineWallet.fenceAccount(ownerId:),
    ] {
      store.items[account(ownerB)] = store.items[account(ownerA)]
    }

    assertFailure(.tampered, "all three items copied verbatim still fail: the account is under the tag") {
      try wallet.load(ownerId: ownerB)
    }
    XCTAssertEqual(try wallet.load(ownerId: ownerA), a)
    XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerB), .tampered)
    XCTAssertNil(try wallet.load(ownerId: ownerB))
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
    store.items.removeValue(forKey: OfflineWallet.integrityKeyAccount(ownerId: ownerA))
    let writesBefore = store.writeCount

    assertFailure(.integrityKeyMissing) { try wallet.load(ownerId: ownerA) }
    assertFailure(.integrityKeyMissing) {
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
    }
    assertFailure(.integrityKeyMissing) { try wallet.clear(ownerId: ownerA, expectedRevision: 0) }
    XCTAssertEqual(store.writeCount, writesBefore, "no new key is minted over an unreadable wallet")

    XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerA), .integrityKeyMissing)
    XCTAssertTrue(store.items.isEmpty, "the unverifiable fence leaves with the wallet")
    XCTAssertEqual(try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [])).revision, 1)
  }

  func testUnsupportedEnvelopeVersionIsRejectedAndDiscardable() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
    let account = OfflineWallet.walletAccount(ownerId: ownerA)
    var bytes = try XCTUnwrap(store.items[account])
    bytes[bytes.startIndex] = 2
    store.items[account] = bytes

    assertFailure(.unsupportedVersion) { try wallet.load(ownerId: ownerA) }
    assertFailure(.unsupportedVersion) {
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
    }
    XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerA), .unsupportedVersion)
    XCTAssertNil(try wallet.load(ownerId: ownerA))
    XCTAssertEqual(try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [])).revision, 2)
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
    assertFailure(.notCorrupt) { try wallet.discardCorrupt(ownerId: ownerB) }
  }

  // MARK: - Integrity key corruption has a bounded recovery per owner

  func testCorruptIntegrityKeyWithoutWalletIsDiscardableAndWritesRecover() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    for badLength in [0, 31, 33, 64] {
      store.items = [OfflineWallet.integrityKeyAccount(ownerId: ownerA): Data(repeating: 0xAB, count: badLength)]

      assertFailure(.tampered, "load with a \(badLength)-byte key is a fault, not an empty wallet") {
        try wallet.load(ownerId: ownerA)
      }
      assertFailure(.tampered, "replace with a \(badLength)-byte key") {
        try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
      }
      assertFailure(.tampered, "clear with a \(badLength)-byte key") { try wallet.clear(ownerId: ownerA, expectedRevision: 0) }

      XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerA), .tampered, "the unusable key is discardable")
      XCTAssertTrue(store.items.isEmpty)
      let recovered = try wallet.replace(
        ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [grant(id: "g")], receipts: []))
      XCTAssertEqual(recovered.revision, 1)
      XCTAssertEqual(store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerA)]?.count, 32)
    }
  }

  func testCorruptIntegrityKeyWithWalletIsIsolatedToThatOwnerAndRecoversAfterDiscard() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(
      ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [grant(id: "g")], receipts: []))
    let b = try wallet.replace(
      ownerId: ownerB, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "r-b")]))
    store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerA)] = Data(repeating: 0xCD, count: 33)

    assertFailure(.tampered) { try wallet.load(ownerId: ownerA) }
    assertFailure(.tampered) {
      try wallet.replace(ownerId: ownerA, expectedRevision: 1, contents: OfflineWalletContents(grants: [], receipts: []))
    }
    XCTAssertEqual(try wallet.load(ownerId: ownerB), b, "owner B's wallet is untouched by owner A's corrupt key")
    assertFailure(.notCorrupt) { try wallet.discardCorrupt(ownerId: ownerB) }

    XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerA), .tampered)
    XCTAssertNil(store.items[OfflineWallet.walletAccount(ownerId: ownerA)])
    XCTAssertNil(store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerA)], "the corrupt key leaves with the wallet")
    XCTAssertNil(store.items[OfflineWallet.fenceAccount(ownerId: ownerA)], "a fence sealed by a lost key is unverifiable")
    XCTAssertNil(try wallet.load(ownerId: ownerA))

    XCTAssertEqual(
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [])).revision, 1)
    XCTAssertEqual(try wallet.load(ownerId: ownerB), b)
    XCTAssertEqual(
      try wallet.replace(ownerId: ownerB, expectedRevision: 1, contents: OfflineWalletContents(grants: [], receipts: [])).revision, 2)
  }

  func testMissingKeyWithOrphanedFenceBlocksWritesUntilDiscard() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
    try wallet.clear(ownerId: ownerA, expectedRevision: 1)
    store.items.removeValue(forKey: OfflineWallet.integrityKeyAccount(ownerId: ownerA))

    assertFailure(.integrityKeyMissing, "the cleared envelope cannot be verified without its key") { try wallet.load(ownerId: ownerA) }
    assertFailure(.integrityKeyMissing) {
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
    }
    XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerA), .integrityKeyMissing)
    XCTAssertTrue(store.items.isEmpty)
    XCTAssertEqual(
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [])).revision, 1)
  }

  func testUnverifiableFenceWithoutAWalletIsAFaultNotAnEmptyWallet() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let keyAccount = OfflineWallet.integrityKeyAccount(ownerId: ownerA)
    let fenceAccount = OfflineWallet.fenceAccount(ownerId: ownerA)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
    let fence = try XCTUnwrap(store.items[fenceAccount])

    // Fence left behind by a lost wallet and a lost key: the history it
    // records cannot be checked, so the owner is neither empty nor writable.
    store.items = [fenceAccount: fence]
    assertFailure(.integrityKeyMissing) { try wallet.load(ownerId: ownerA) }
    assertFailure(.integrityKeyMissing) {
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
    }
    XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerA), .integrityKeyMissing)
    XCTAssertTrue(store.items.isEmpty)

    // Fence beside a key that does not verify it (another owner's history or
    // a flipped key byte) and no wallet.
    store.items = [fenceAccount: fence, keyAccount: Data(repeating: 0x5A, count: 32)]
    assertFailure(.tampered) { try wallet.load(ownerId: ownerA) }
    assertFailure(.tampered) {
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
    }
    assertFailure(.tampered) { try wallet.clear(ownerId: ownerA, expectedRevision: 0) }
    XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerA), .tampered)
    XCTAssertTrue(store.items.isEmpty)
    XCTAssertNil(try wallet.load(ownerId: ownerA))
    XCTAssertEqual(
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [grant(id: "g")], receipts: [])).revision, 1)
  }

  func testCrashBetweenKeyMintAndWalletWriteRecovers() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let keyAccount = OfflineWallet.integrityKeyAccount(ownerId: ownerA)

    store.items = [keyAccount: Data(repeating: 0x42, count: 32)]
    XCTAssertNil(try wallet.load(ownerId: ownerA))
    assertFailure(.notCorrupt) { try wallet.discardCorrupt(ownerId: ownerA) }
    XCTAssertEqual(
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [])).revision, 1)
    XCTAssertEqual(
      store.items[keyAccount], Data(repeating: 0x42, count: 32),
      "a usable key is kept; the fence's fresh epoch is what retires anything sealed before it")
    XCTAssertNil(store.writesByAccount[keyAccount], "no second key is ever minted for an owner that has one")

    store.items.removeValue(forKey: OfflineWallet.walletAccount(ownerId: ownerA))
    store.items[OfflineWallet.fenceAccount(ownerId: ownerA)] = forgeFence(store: store, ownerId: ownerA, revision: 0)
    XCTAssertNil(try wallet.load(ownerId: ownerA), "key + initialised fence but no wallet = crash before the first wallet write")
    assertFailure(.notCorrupt) { try wallet.discardCorrupt(ownerId: ownerA) }
    XCTAssertEqual(
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [])).revision, 1)
  }

  // MARK: - Anti-rollback fence

  func testRollbackToEarlierAuthenticEnvelopeIsTamperedAndDiscardKeepsTheFence() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let account = OfflineWallet.walletAccount(ownerId: ownerA)
    let spent = grant(id: "grant-spent-later")
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [spent], receipts: []))
    let revisionOneBytes = try XCTUnwrap(store.items[account])
    let revisionTwo = try wallet.replace(
      ownerId: ownerA,
      expectedRevision: 1,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-proving-spend")])
    )
    XCTAssertEqual(revisionTwo.revision, 2)

    store.items[account] = revisionOneBytes

    let error = assertFailure(.tampered, "an older authentic envelope must not read as current state") {
      try wallet.load(ownerId: ownerA)
    }
    XCTAssertTrue(error?.detail.contains("rolled back") ?? false, error?.detail ?? "")
    assertFailure(.tampered) {
      try wallet.replace(ownerId: ownerA, expectedRevision: 1, contents: OfflineWalletContents(grants: [spent], receipts: []))
    }
    assertFailure(.tampered) { try wallet.clear(ownerId: ownerA, expectedRevision: 1) }
    XCTAssertEqual(store.items[account], revisionOneBytes, "rolled-back bytes stay for reconciliation")

    XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerA), .tampered)
    XCTAssertNil(try wallet.load(ownerId: ownerA))
    XCTAssertNotNil(store.items[OfflineWallet.fenceAccount(ownerId: ownerA)], "a verified fence survives discard")
    let fresh = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
    XCTAssertEqual(fresh.revision, 3, "revisions continue above the fence, never back to 1")
  }

  func testFenceSurvivesClearSoRevisionsNeverRestart() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let account = OfflineWallet.walletAccount(ownerId: ownerA)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [grant(id: "g")], receipts: []))
    let revisionOneBytes = try XCTUnwrap(store.items[account])
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 1, contents: OfflineWalletContents(grants: [], receipts: []))
    try wallet.clear(ownerId: ownerA, expectedRevision: 2)
    XCTAssertNil(try wallet.load(ownerId: ownerA))
    XCTAssertNotNil(store.items[OfflineWallet.fenceAccount(ownerId: ownerA)])

    store.items[account] = revisionOneBytes
    assertFailure(.tampered, "restoring a pre-clear envelope is a rollback") { try wallet.load(ownerId: ownerA) }
    XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerA), .tampered)

    let next = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
    XCTAssertEqual(next.revision, 3)
  }

  func testWalletAheadOfFenceIsReadableAndTheFenceIsRepairedOnTheNextWrite() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let fenceAccount = OfflineWallet.fenceAccount(ownerId: ownerA)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
    let fenceAtOne = try XCTUnwrap(store.items[fenceAccount])
    let two = try wallet.replace(ownerId: ownerA, expectedRevision: 1, contents: OfflineWalletContents(grants: [grant(id: "g")], receipts: []))

    store.items[fenceAccount] = fenceAtOne
    XCTAssertEqual(try wallet.load(ownerId: ownerA), two, "a crash between the wallet write and the fence advance loses nothing")
    let three = try wallet.replace(ownerId: ownerA, expectedRevision: 2, contents: OfflineWalletContents(grants: [], receipts: []))
    XCTAssertEqual(three.revision, 3)
    XCTAssertEqual(try OfflineWallet.openFence(
      try XCTUnwrap(store.items[fenceAccount]), ownerId: ownerA,
      key: try XCTUnwrap(store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerA)])), 3)
  }

  func testMissingOrCorruptFenceBesideAWalletIsTamperedAndDiscardable() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let fenceAccount = OfflineWallet.fenceAccount(ownerId: ownerA)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [grant(id: "g")], receipts: []))
    let good = try XCTUnwrap(store.items[fenceAccount])

    store.items.removeValue(forKey: fenceAccount)
    assertFailure(.tampered, "missing fence") { try wallet.load(ownerId: ownerA) }

    store.items[fenceAccount] = Data([0x01, 0x02])
    assertFailure(.tampered, "garbage fence") { try wallet.load(ownerId: ownerA) }

    var flipped = good
    flipped[flipped.index(before: flipped.endIndex)] ^= 0x01
    store.items[fenceAccount] = flipped
    assertFailure(.tampered, "flipped fence byte") { try wallet.load(ownerId: ownerA) }

    store.items[fenceAccount] = forgeFence(store: store, ownerId: ownerA, revision: 9_007_199_254_740_992)
    assertFailure(.tampered, "fence beyond the bridge range") { try wallet.load(ownerId: ownerA) }

    XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerA), .tampered)
    XCTAssertNil(store.items[fenceAccount], "an unverifiable fence is discarded with the wallet")
    XCTAssertNil(
      store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerA)], "the key that sealed an unverifiable fence is retired with it")
    XCTAssertEqual(
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [])).revision, 1)
  }

  func testClearAfterCrashBetweenWalletWriteAndFenceCommitDoesNotReuseARevision() throws {
    let store = MemoryWalletStore()
    let account = OfflineWallet.walletAccount(ownerId: ownerA)
    let fenceAccount = OfflineWallet.fenceAccount(ownerId: ownerA)
    let crashed = OfflineWallet(store: store)
    _ = try crashed.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [grant(id: "g")], receipts: []))
    let fenceAtOne = try XCTUnwrap(store.items[fenceAccount])
    _ = try crashed.replace(
      ownerId: ownerA, expectedRevision: 1,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-spent")])
    )
    store.items[fenceAccount] = fenceAtOne
    let revisionTwoBytes = try XCTUnwrap(store.items[account])

    let relaunched = OfflineWallet(store: store)
    XCTAssertEqual(try XCTUnwrap(try relaunched.load(ownerId: ownerA)).revision, 2)
    try relaunched.clear(ownerId: ownerA, expectedRevision: 2)
    XCTAssertNil(try relaunched.load(ownerId: ownerA))
    let key = try XCTUnwrap(store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerA)])
    XCTAssertEqual(
      try OfflineWallet.openFence(try XCTUnwrap(store.items[fenceAccount]), ownerId: ownerA, key: key), 2,
      "clear commits the fence to the revision it observed")

    let next = try relaunched.replace(
      ownerId: ownerA, expectedRevision: 0,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-unsent")])
    )
    XCTAssertEqual(next.revision, 3, "revision 2 was already handed out")

    store.items[account] = revisionTwoBytes
    assertFailure(.tampered, "the pre-clear envelope must not replay as current state") { try relaunched.load(ownerId: ownerA) }
    XCTAssertEqual(try relaunched.discardCorrupt(ownerId: ownerA), .tampered)
    XCTAssertEqual(
      try relaunched.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [])).revision, 4)
  }

  func testClearOfAnAbsentWalletLeavesTheFenceAlone() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    try wallet.clear(ownerId: ownerA, expectedRevision: 0)
    XCTAssertEqual(store.writeCount, 0)
    XCTAssertTrue(store.items.isEmpty)

    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
    try wallet.clear(ownerId: ownerA, expectedRevision: 1)
    let fenceAfterClear = try XCTUnwrap(store.items[OfflineWallet.fenceAccount(ownerId: ownerA)])
    let writes = store.writeCount
    try wallet.clear(ownerId: ownerA, expectedRevision: 0)
    XCTAssertEqual(store.writeCount, writes, "clearing nothing writes nothing")
    XCTAssertEqual(store.items[OfflineWallet.fenceAccount(ownerId: ownerA)], fenceAfterClear)
  }

  func testClearRacingAReplaceThatAlreadyAdvancedTheFenceStillConflicts() throws {
    let store = MemoryWalletStore()
    let first = OfflineWallet(store: store)
    let second = OfflineWallet(store: store)
    _ = try first.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))

    var interleaved = false
    store.onReadWalletAccount = { [ownerA] account in
      guard !interleaved, account == OfflineWallet.walletAccount(ownerId: ownerA) else { return }
      interleaved = true
      _ = try second.replace(
        ownerId: ownerA, expectedRevision: 1,
        contents: OfflineWalletContents(grants: [], receipts: [self.receipt(id: "receipt-late")])
      )
    }
    assertFailure(.revisionConflict) { try first.clear(ownerId: ownerA, expectedRevision: 1) }
    store.onReadWalletAccount = nil
    let kept = try XCTUnwrap(try first.load(ownerId: ownerA))
    XCTAssertEqual(kept.revision, 2)
    XCTAssertEqual(kept.contents.receipts.map(\.receiptId), ["receipt-late"])
  }

  // MARK: - Clear retires the revision it removes; recovery retires the history

  func testEnvelopeRemovedByClearIsARollbackNotCurrentState() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let account = OfflineWallet.walletAccount(ownerId: ownerA)
    let spent = grant(id: "grant-spent-offline")
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [spent], receipts: []))
    let two = try wallet.replace(
      ownerId: ownerA, expectedRevision: 1,
      contents: OfflineWalletContents(grants: [spent], receipts: [receipt(id: "receipt-submitted")])
    )
    XCTAssertEqual(two.revision, 2)
    let removedEnvelope = try XCTUnwrap(store.items[account])

    try wallet.clear(ownerId: ownerA, expectedRevision: 2)
    XCTAssertNil(try wallet.load(ownerId: ownerA))

    store.items[account] = removedEnvelope
    let replayed = assertFailure(.tampered, "the exact envelope clear removed must read as a rollback") {
      try wallet.load(ownerId: ownerA)
    }
    XCTAssertTrue(replayed?.detail.contains("rolled back") ?? false, replayed?.detail ?? "loaded without failure")
    assertFailure(.tampered, "a replayed spent wallet is not a valid base for the next write") {
      try wallet.replace(ownerId: ownerA, expectedRevision: 2, contents: OfflineWalletContents(grants: [], receipts: []))
    }
    assertFailure(.tampered) { try wallet.clear(ownerId: ownerA, expectedRevision: 2) }
    XCTAssertEqual(store.items[account], removedEnvelope, "replayed bytes stay for reconciliation")

    XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerA), .tampered)
    XCTAssertNil(try wallet.load(ownerId: ownerA))
    let next = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
    XCTAssertGreaterThan(next.revision, 2, "revision 2 was spent by the cleared wallet")
    store.items[account] = removedEnvelope
    assertFailure(.tampered, "still a rollback after the owner wrote again") { try wallet.load(ownerId: ownerA) }
  }

  func testEnvelopeRemovedByClearOverALaggingFenceIsARollback() throws {
    let store = MemoryWalletStore()
    let account = OfflineWallet.walletAccount(ownerId: ownerA)
    let fenceAccount = OfflineWallet.fenceAccount(ownerId: ownerA)
    let crashed = OfflineWallet(store: store)
    _ = try crashed.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [grant(id: "g")], receipts: []))
    let fenceAtOne = try XCTUnwrap(store.items[fenceAccount])
    _ = try crashed.replace(
      ownerId: ownerA, expectedRevision: 1,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-spent")])
    )
    store.items[fenceAccount] = fenceAtOne
    let removedEnvelope = try XCTUnwrap(store.items[account])

    let relaunched = OfflineWallet(store: store)
    XCTAssertEqual(try XCTUnwrap(try relaunched.load(ownerId: ownerA)).revision, 2)
    try relaunched.clear(ownerId: ownerA, expectedRevision: 2)
    XCTAssertNil(try relaunched.load(ownerId: ownerA))

    store.items[account] = removedEnvelope
    let replayed = assertFailure(.tampered, "clear over a lagging fence must still retire the revision it removed") {
      try relaunched.load(ownerId: ownerA)
    }
    XCTAssertTrue(replayed?.detail.contains("rolled back") ?? false, replayed?.detail ?? "loaded without failure")
    assertFailure(.tampered) {
      try relaunched.replace(ownerId: ownerA, expectedRevision: 2, contents: OfflineWalletContents(grants: [], receipts: []))
    }
  }

  func testClearInterruptedBetweenItsWritesNeverLetsTheRemovedEnvelopeReadAsCurrent() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let account = OfflineWallet.walletAccount(ownerId: ownerA)
    let fenceAccount = OfflineWallet.fenceAccount(ownerId: ownerA)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [grant(id: "g")], receipts: []))
    let two = try wallet.replace(
      ownerId: ownerA, expectedRevision: 1,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-spent")])
    )
    XCTAssertEqual(two.revision, 2)
    let fenceBefore = try XCTUnwrap(store.items[fenceAccount])
    let removedEnvelope = try XCTUnwrap(store.items[account])

    try wallet.clear(ownerId: ownerA, expectedRevision: 2)
    XCTAssertNotEqual(store.items[fenceAccount], fenceBefore, "clear commits the fence")
    XCTAssertNotNil(store.items[account], "clear leaves an envelope in the slot")
    let writesToClear = store.writeCount
    // Process death after clear's first write (the fence) and before its
    // second (the slot): the wallet being removed is still in the slot.
    store.items[account] = removedEnvelope

    let relaunched = OfflineWallet(store: store)
    let interrupted = assertFailure(.tampered, "the wallet clear was removing must not come back as current state") {
      try relaunched.load(ownerId: ownerA)
    }
    XCTAssertTrue(interrupted?.detail.contains("rolled back") ?? false, interrupted?.detail ?? "loaded without failure")
    assertFailure(.tampered) {
      try relaunched.replace(ownerId: ownerA, expectedRevision: 2, contents: OfflineWalletContents(grants: [], receipts: []))
    }
    assertFailure(.tampered) { try relaunched.clear(ownerId: ownerA, expectedRevision: 2) }
    XCTAssertEqual(store.writeCount, writesToClear, "nothing is written until the owner reconciles")

    XCTAssertEqual(try relaunched.discardCorrupt(ownerId: ownerA), .tampered)
    XCTAssertNil(try relaunched.load(ownerId: ownerA))
    let next = try relaunched.replace(
      ownerId: ownerA, expectedRevision: 0,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-unsent")])
    )
    XCTAssertEqual(next.revision, 3, "revision 2 stays spent")
    XCTAssertEqual(try relaunched.load(ownerId: ownerA), next)
    store.items[account] = removedEnvelope
    assertFailure(.tampered) { try relaunched.load(ownerId: ownerA) }
  }

  func testLosingTheFenceBesideTheWalletRetiresEveryOlderEnvelope() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let account = OfflineWallet.walletAccount(ownerId: ownerA)
    let fenceAccount = OfflineWallet.fenceAccount(ownerId: ownerA)
    let spent = grant(id: "grant-spent-offline")
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [spent], receipts: []))
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 1, contents: OfflineWalletContents(grants: [spent], receipts: []))
    let three = try wallet.replace(ownerId: ownerA, expectedRevision: 2, contents: OfflineWalletContents(grants: [spent], receipts: []))
    XCTAssertEqual(three.revision, 3)
    let envelopeThree = try XCTUnwrap(store.items[account])
    _ = try wallet.replace(
      ownerId: ownerA, expectedRevision: 3,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-spend")])
    )
    let originalKey = try XCTUnwrap(store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerA)])

    store.items.removeValue(forKey: fenceAccount)
    store.items.removeValue(forKey: account)

    // With only the key left nothing distinguishes this from a crash after
    // the key mint, so the owner starts over — but under a history in which
    // no envelope issued before the loss can ever verify.
    XCTAssertNil(try wallet.load(ownerId: ownerA))
    let keyWrites = store.writesByAccount[OfflineWallet.integrityKeyAccount(ownerId: ownerA)]
    let fresh = try wallet.replace(
      ownerId: ownerA, expectedRevision: 0,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-new")])
    )
    XCTAssertEqual(fresh.revision, 1)
    XCTAssertEqual(store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerA)], originalKey, "the usable key is kept")
    XCTAssertEqual(store.writesByAccount[OfflineWallet.integrityKeyAccount(ownerId: ownerA)], keyWrites)
    store.items[account] = envelopeThree
    assertFailure(.tampered, "an envelope from before the fence was lost must never verify again") {
      try wallet.load(ownerId: ownerA)
    }
    assertFailure(.tampered) {
      try wallet.replace(ownerId: ownerA, expectedRevision: 3, contents: OfflineWalletContents(grants: [], receipts: []))
    }
  }

  func testDiscardingACorruptFenceRetiresEveryOlderEnvelope() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let account = OfflineWallet.walletAccount(ownerId: ownerA)
    let fenceAccount = OfflineWallet.fenceAccount(ownerId: ownerA)
    let spent = grant(id: "grant-spent-offline")
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [spent], receipts: []))
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 1, contents: OfflineWalletContents(grants: [spent], receipts: []))
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 2, contents: OfflineWalletContents(grants: [spent], receipts: []))
    let envelopeThree = try XCTUnwrap(store.items[account])
    _ = try wallet.replace(
      ownerId: ownerA, expectedRevision: 3,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-spend")])
    )

    let originalKey = try XCTUnwrap(store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerA)])

    var flipped = try XCTUnwrap(store.items[fenceAccount])
    flipped[flipped.index(before: flipped.endIndex)] ^= 0x01
    store.items[fenceAccount] = flipped
    assertFailure(.tampered) { try wallet.load(ownerId: ownerA) }
    XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerA), .tampered)
    XCTAssertNil(store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerA)], "the key leaves with the unverifiable fence")
    XCTAssertNil(try wallet.load(ownerId: ownerA))

    let fresh = try wallet.replace(
      ownerId: ownerA, expectedRevision: 0,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-new")])
    )
    XCTAssertEqual(fresh.revision, 1)
    XCTAssertNotEqual(store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerA)], originalKey)
    store.items[account] = envelopeThree
    assertFailure(.tampered, "recovery from an unverifiable fence must not revive already-issued envelopes") {
      try wallet.load(ownerId: ownerA)
    }
  }

  func testDiscardingACorruptWalletRetiresEveryOlderEnvelopeIncludingOnesAheadOfTheFence() throws {
    let store = MemoryWalletStore()
    let account = OfflineWallet.walletAccount(ownerId: ownerA)
    let fenceAccount = OfflineWallet.fenceAccount(ownerId: ownerA)
    let crashed = OfflineWallet(store: store)
    _ = try crashed.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [grant(id: "g")], receipts: []))
    let fenceAtOne = try XCTUnwrap(store.items[fenceAccount])
    _ = try crashed.replace(
      ownerId: ownerA, expectedRevision: 1,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-spent")])
    )
    // Crash before the fence commit: revision 2 exists but the fence says 1.
    store.items[fenceAccount] = fenceAtOne
    let envelopeTwo = try XCTUnwrap(store.items[account])

    store.items[account] = Data([0x00])
    let relaunched = OfflineWallet(store: store)
    assertFailure(.tampered) { try relaunched.load(ownerId: ownerA) }
    XCTAssertEqual(try relaunched.discardCorrupt(ownerId: ownerA), .tampered)
    XCTAssertNil(try relaunched.load(ownerId: ownerA))
    XCTAssertNotNil(store.items[fenceAccount], "a verified fence survives discard")

    store.items[account] = envelopeTwo
    assertFailure(.tampered, "an envelope issued before discard must not verify, even one the fence never recorded") {
      try relaunched.load(ownerId: ownerA)
    }
    XCTAssertEqual(try relaunched.discardCorrupt(ownerId: ownerA), .tampered)
    let fresh = try relaunched.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
    XCTAssertGreaterThan(fresh.revision, 1, "revisions continue above the fence")
    store.items[account] = envelopeTwo
    assertFailure(.tampered) { try relaunched.load(ownerId: ownerA) }
  }

  func testWalletVanishingWithoutClearIsAFaultNotAnEmptyWallet() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let account = OfflineWallet.walletAccount(ownerId: ownerA)
    _ = try wallet.replace(
      ownerId: ownerA, expectedRevision: 0,
      contents: OfflineWalletContents(grants: [grant(id: "g")], receipts: [receipt(id: "receipt-unsent")])
    )
    store.items.removeValue(forKey: account)
    let writesBefore = store.writeCount

    let vanished = assertFailure(.tampered, "a wallet that disappeared without clear is not empty history") {
      try wallet.load(ownerId: ownerA)
    }
    XCTAssertTrue(vanished?.detail.contains("missing") ?? false, vanished?.detail ?? "loaded without failure")
    assertFailure(.tampered, "nothing is written over a vanished wallet until the owner reconciles") {
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
    }
    assertFailure(.tampered) {
      try wallet.replace(ownerId: ownerA, expectedRevision: 1, contents: OfflineWalletContents(grants: [], receipts: []))
    }
    assertFailure(.tampered) { try wallet.clear(ownerId: ownerA, expectedRevision: 0) }
    XCTAssertEqual(store.writeCount, writesBefore)

    XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerA), .tampered)
    XCTAssertNil(try wallet.load(ownerId: ownerA))
    assertFailure(.notCorrupt) { try wallet.discardCorrupt(ownerId: ownerA) }
    let next = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
    XCTAssertGreaterThan(next.revision, 1, "the lost revision is not handed out again")
  }

  func testVanishedWalletIsIsolatedToItsOwner() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [grant(id: "a")], receipts: []))
    let b = try wallet.replace(ownerId: ownerB, expectedRevision: 0, contents: OfflineWalletContents(grants: [grant(id: "b")], receipts: []))
    store.items.removeValue(forKey: OfflineWallet.walletAccount(ownerId: ownerA))

    assertFailure(.tampered) { try wallet.load(ownerId: ownerA) }
    XCTAssertEqual(try wallet.load(ownerId: ownerB), b)
    assertFailure(.notCorrupt) { try wallet.discardCorrupt(ownerId: ownerB) }
    XCTAssertEqual(
      try wallet.replace(ownerId: ownerB, expectedRevision: 1, contents: OfflineWalletContents(grants: [], receipts: [])).revision, 2)
  }

  // MARK: - Multi-instance races around an owner's first write

  /// Runs `second`'s first write for `ownerA` while `first` is between its
  /// reads of the owner's items (`triggerAccount` is the read that fires it).
  private func armFirstWriteRace(
    store: MemoryWalletStore, second: OfflineWallet, triggerAccount: String, receiptId: String
  ) -> () -> Bool {
    var fired = false
    store.onReadWalletAccount = { account in
      guard !fired, account == triggerAccount else { return }
      fired = true
      _ = try second.replace(
        ownerId: self.ownerA, expectedRevision: 0,
        contents: OfflineWalletContents(grants: [], receipts: [self.receipt(id: receiptId)])
      )
    }
    return { fired }
  }

  func testLoadRacingAnotherInstancesFirstWriteIsNotReportedAsUnreadable() throws {
    for trigger in [OfflineWallet.integrityKeyAccount(ownerId: ownerA), OfflineWallet.fenceAccount(ownerId: ownerA)] {
      let store = MemoryWalletStore()
      let first = OfflineWallet(store: store)
      let second = OfflineWallet(store: store)
      let fired = armFirstWriteRace(store: store, second: second, triggerAccount: trigger, receiptId: "receipt-unsent")

      let observed = try first.load(ownerId: ownerA)
      XCTAssertTrue(fired(), trigger)
      if let observed {
        XCTAssertEqual(observed.revision, 1, trigger)
        XCTAssertEqual(observed.contents.receipts.map(\.receiptId), ["receipt-unsent"], trigger)
      }
      store.onReadWalletAccount = nil
      XCTAssertEqual(try XCTUnwrap(try first.load(ownerId: ownerA)).contents.receipts.map(\.receiptId), ["receipt-unsent"], trigger)
    }
  }

  func testDiscardCorruptRacingAnotherInstancesFirstWriteNeverDeletesAHealthyWallet() throws {
    for trigger in [OfflineWallet.integrityKeyAccount(ownerId: ownerA), OfflineWallet.fenceAccount(ownerId: ownerA)] {
      let store = MemoryWalletStore()
      let first = OfflineWallet(store: store)
      let second = OfflineWallet(store: store)
      let fired = armFirstWriteRace(store: store, second: second, triggerAccount: trigger, receiptId: "receipt-unsent")

      assertFailure(.notCorrupt, trigger) { try first.discardCorrupt(ownerId: ownerA) }
      XCTAssertTrue(fired(), trigger)
      store.onReadWalletAccount = nil
      XCTAssertEqual(store.items.count, 3, "key, fence and wallet all survive — \(trigger)")
      let kept = try XCTUnwrap(try first.load(ownerId: ownerA), trigger)
      XCTAssertEqual(kept.revision, 1, trigger)
      XCTAssertEqual(kept.contents.receipts.map(\.receiptId), ["receipt-unsent"], trigger)
    }
  }

  func testReplaceRacingAnotherInstancesFirstWriteConflictsAndKeepsTheirReceipt() throws {
    for trigger in [OfflineWallet.integrityKeyAccount(ownerId: ownerA), OfflineWallet.fenceAccount(ownerId: ownerA)] {
      let store = MemoryWalletStore()
      let first = OfflineWallet(store: store)
      let second = OfflineWallet(store: store)
      let fired = armFirstWriteRace(store: store, second: second, triggerAccount: trigger, receiptId: "receipt-unsent")

      assertFailure(.revisionConflict, trigger) {
        try first.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [grant(id: "g")], receipts: []))
      }
      XCTAssertTrue(fired(), trigger)
      store.onReadWalletAccount = nil
      XCTAssertEqual(store.items.count, 3, trigger)
      let kept = try XCTUnwrap(try first.load(ownerId: ownerA), trigger)
      XCTAssertEqual(kept.revision, 1, trigger)
      XCTAssertEqual(kept.contents.receipts.map(\.receiptId), ["receipt-unsent"], trigger)
      XCTAssertEqual(store.writesByAccount[OfflineWallet.integrityKeyAccount(ownerId: ownerA)], 1, "one key per owner — \(trigger)")
    }
  }

  func testGenuinelyCorruptStateIsStillReportedAfterARaceFreeReRead() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [grant(id: "g")], receipts: []))
    store.items.removeValue(forKey: OfflineWallet.integrityKeyAccount(ownerId: ownerA))
    assertFailure(.integrityKeyMissing) { try wallet.load(ownerId: ownerA) }
    XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerA), .integrityKeyMissing)
    XCTAssertTrue(store.items.isEmpty)
  }

  func testStateThatNeverSettlesFailsTypedAndDeletesNothing() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [grant(id: "g")], receipts: []))
    let keyAccount = OfflineWallet.integrityKeyAccount(ownerId: ownerA)
    let walletAccount = OfflineWallet.walletAccount(ownerId: ownerA)
    let fenceAccount = OfflineWallet.fenceAccount(ownerId: ownerA)
    let healthy = store.items
    let key = try XCTUnwrap(healthy[keyAccount])
    let goodWallet = try XCTUnwrap(healthy[walletAccount])

    // Every pass observes a different, individually corrupt-looking state:
    // key gone with a good wallet, then key back with a garbage wallet, ...
    store.items.removeValue(forKey: keyAccount)
    var walletReads = 0
    store.onReadWalletAccount = { account in
      guard account == walletAccount else { return }
      walletReads += 1
      if walletReads % 2 == 1 {
        store.items[keyAccount] = key
        store.items[walletAccount] = Data(repeating: UInt8(truncatingIfNeeded: walletReads), count: 8)
      } else {
        store.items.removeValue(forKey: keyAccount)
        store.items[walletAccount] = goodWallet
      }
    }
    assertFailure(.revisionConflict, "load") { try wallet.load(ownerId: ownerA) }
    XCTAssertGreaterThanOrEqual(walletReads, 2, "the state was re-read before giving up")
    let readsBeforeDiscard = walletReads
    assertFailure(.revisionConflict, "discardCorrupt") { try wallet.discardCorrupt(ownerId: ownerA) }
    XCTAssertGreaterThan(walletReads, readsBeforeDiscard)
    XCTAssertNotNil(store.items[walletAccount], "nothing is deleted while the state is still moving")
    XCTAssertNotNil(store.items[fenceAccount], "nothing is deleted while the state is still moving")
    store.onReadWalletAccount = nil
    store.items = healthy
    XCTAssertEqual(try XCTUnwrap(try wallet.load(ownerId: ownerA)).contents.grants.map(\.grantId), ["g"])
  }

  func testConcurrentFirstWritesKeepOneKeyAndConflictTheLoser() throws {
    let store = MemoryWalletStore()
    let first = OfflineWallet(store: store)
    let second = OfflineWallet(store: store)
    let fired = armFirstWriteRace(
      store: store, second: second, triggerAccount: OfflineWallet.walletAccount(ownerId: ownerA), receiptId: "receipt-second")

    assertFailure(.revisionConflict) {
      try first.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-first")]))
    }
    XCTAssertTrue(fired())
    store.onReadWalletAccount = nil
    XCTAssertEqual(store.writesByAccount[OfflineWallet.integrityKeyAccount(ownerId: ownerA)], 1)
    XCTAssertEqual(try XCTUnwrap(try first.load(ownerId: ownerA)).contents.receipts.map(\.receiptId), ["receipt-second"])
  }

  /// Two instances' first writes straddling each other: the second reads the
  /// owner after the first's key write and acts on that read only after the
  /// first has also sealed its fence. Whatever the second does with the key it
  /// read must not make the first's committed wallet unreadable.
  func testFirstWriteStraddledByASecondInstancesFirstWriteLeavesTheWinnerReadable() throws {
    let store = MemoryWalletStore()
    let first = OfflineWallet(store: store)
    let second = OfflineWallet(store: store)
    let keyAccount = OfflineWallet.integrityKeyAccount(ownerId: ownerA)
    let fenceAccount = OfflineWallet.fenceAccount(ownerId: ownerA)
    let walletAccount = OfflineWallet.walletAccount(ownerId: ownerA)
    let script = StraddleScript()
    let secondMayStart = DispatchSemaphore(value: 0)
    let secondHasRead = DispatchSemaphore(value: 0)
    let secondMayWrite = DispatchSemaphore(value: 0)
    let secondFinished = DispatchSemaphore(value: 0)
    let secondContents = OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-second")])
    let ownerId = ownerA

    // The two instances strictly alternate; every hand-over is a semaphore, so
    // the store double is never touched by both threads at once.
    let runner = Thread {
      secondMayStart.wait()
      script.secondOutcome = Result { try second.replace(ownerId: ownerId, expectedRevision: 0, contents: secondContents) }
      secondFinished.signal()
    }
    store.onWrite = { account in
      if script.step == 0, account == keyAccount {
        // first: key written → second starts and reads the owner's items.
        script.step = 1
        secondMayStart.signal()
        secondHasRead.wait()
      } else if script.step == 2, account == fenceAccount {
        // first: fence sealed under the key it minted → second acts on its read.
        script.step = 3
        secondMayWrite.signal()
        secondFinished.wait()
      }
    }
    store.onReadWalletAccount = { account in
      guard script.step == 1, account == walletAccount else { return }
      // second: finished reading (key present, no fence, no wallet) → pause.
      script.step = 2
      secondHasRead.signal()
      secondMayWrite.wait()
    }
    runner.start()

    let written = try first.replace(
      ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-first")]))
    store.onWrite = nil
    store.onReadWalletAccount = nil
    XCTAssertEqual(script.step, 3, "the second instance read between the first's key and fence writes")
    XCTAssertEqual(written.revision, 1)
    switch script.secondOutcome {
    case .failure(let error as OfflineWalletError):
      XCTAssertEqual(error.failure, .revisionConflict)
    case let other:
      XCTFail("the straddling first write must lose with revision_conflict, got \(String(describing: other))")
    }
    XCTAssertEqual(store.writesByAccount[keyAccount], 1, "one key per owner")
    XCTAssertEqual(store.items.count, 3)
    let stored = try XCTUnwrap(try first.load(ownerId: ownerA), "the first write committed and must stay readable")
    XCTAssertEqual(stored, written)
    XCTAssertEqual(stored.contents.receipts.map(\.receiptId), ["receipt-first"])
    let next = try first.replace(
      ownerId: ownerA, expectedRevision: 1, contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-first"), receipt(id: "receipt-second")]))
    XCTAssertEqual(next.revision, 2)
  }

  func testLaggingFenceCommitBehindAFasterWriterNeitherRegressesNorFails() throws {
    let store = MemoryWalletStore()
    let slow = OfflineWallet(store: store)
    let fast = OfflineWallet(store: store)
    let walletAccount = OfflineWallet.walletAccount(ownerId: ownerA)
    let fenceAccount = OfflineWallet.fenceAccount(ownerId: ownerA)
    _ = try slow.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))

    var fired = false
    store.onWrite = { [ownerA] account in
      guard !fired, account == walletAccount else { return }
      fired = true
      _ = try fast.replace(
        ownerId: ownerA, expectedRevision: 2,
        contents: OfflineWalletContents(grants: [], receipts: [self.receipt(id: "receipt-fast")])
      )
    }
    let two = try slow.replace(ownerId: ownerA, expectedRevision: 1, contents: OfflineWalletContents(grants: [self.grant(id: "g")], receipts: []))
    XCTAssertEqual(two.revision, 2)
    XCTAssertTrue(fired)
    store.onWrite = nil

    let key = try XCTUnwrap(store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerA)])
    XCTAssertEqual(try OfflineWallet.openFence(try XCTUnwrap(store.items[fenceAccount]), ownerId: ownerA, key: key), 3)
    let current = try XCTUnwrap(try slow.load(ownerId: ownerA))
    XCTAssertEqual(current.revision, 3)
    XCTAssertEqual(current.contents.receipts.map(\.receiptId), ["receipt-fast"])
  }

  // MARK: - Revision bounds

  func testStoredRevisionBeyondBridgeRangeIsTamperedNotReadableOrTrapping() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let account = OfflineWallet.walletAccount(ownerId: ownerA)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))

    for revision in [safeMaxRevision + 1, UInt64.max] {
      store.items[account] = forgeWallet(store: store, ownerId: ownerA, revision: revision, grants: [])
      assertFailure(.tampered, "revision \(revision)") { try wallet.load(ownerId: ownerA) }
      assertFailure(.tampered, "replace over revision \(revision) must not overflow") {
        try wallet.replace(ownerId: ownerA, expectedRevision: revision, contents: OfflineWalletContents(grants: [], receipts: []))
      }
      assertFailure(.tampered) { try wallet.clear(ownerId: ownerA, expectedRevision: revision) }
      XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerA), .tampered)
      XCTAssertNil(try wallet.load(ownerId: ownerA))
      _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
    }

    store.items[account] = forgeWallet(store: store, ownerId: ownerA, revision: 0, grants: [])
    assertFailure(.tampered, "revision 0 means absent and can never be stored") { try wallet.load(ownerId: ownerA) }
  }

  func testReplaceAtTheLastSafeRevisionFailsTypedInsteadOfProducingAnUnrepresentableRevision() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let account = OfflineWallet.walletAccount(ownerId: ownerA)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
    store.items[account] = forgeWallet(store: store, ownerId: ownerA, revision: safeMaxRevision, grants: [])

    let loaded = try XCTUnwrap(try wallet.load(ownerId: ownerA))
    XCTAssertEqual(loaded.revision, safeMaxRevision)
    XCTAssertNoThrow(try OfflineWallet.revision(fromBridge: Double(loaded.revision)))
    let error = assertFailure(.capacityExceeded, "the next revision would not be representable") {
      try wallet.replace(ownerId: ownerA, expectedRevision: safeMaxRevision, contents: OfflineWalletContents(grants: [], receipts: []))
    }
    XCTAssertTrue(error?.detail.contains("revision space") ?? false, error?.detail ?? "")
    XCTAssertEqual(try wallet.load(ownerId: ownerA), loaded, "nothing was written")
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
    ] + jsCannotParse.map { OfflineStoredReceipt(receiptId: "receipt-1", kind: .result, payloadJson: $0) }
    for candidate in cases {
      assertFailure(.invalidReceipt, "\(candidate.receiptId) \(candidate.payloadJson.prefix(16))") {
        try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [candidate]))
      }
    }
    assertFailure(.invalidReceipt, "duplicate receipt id") {
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [good, good]))
    }
    XCTAssertEqual(store.writeCount, 0)

    let accepted = try wallet.replace(
      ownerId: ownerA, expectedRevision: 0,
      contents: OfflineWalletContents(
        grants: [],
        receipts: jsParsesAsObject.enumerated().map { OfflineStoredReceipt(receiptId: "receipt-\($0.offset)", kind: .result, payloadJson: $0.element) }
      )
    )
    XCTAssertEqual(accepted.contents.receipts.map(\.payloadJson), jsParsesAsObject, "strict JSON that JSON.parse accepts stays accepted")
  }

  /// Receipt payload texts `JSON.parse` throws on (verified with node 22) even
  /// though lenient parsers such as Foundation's `JSONSerialization` accept
  /// some of them. Anything the native side commits must read back through the
  /// typed bridge, so every one of these is `invalidReceipt` before any write.
  private var jsCannotParse: [String] {
    [
      "\u{FEFF}{\"a\":1}",
      "{\"a\":1,}",
      "{\"a\":[1,]}",
      "{'a':1}",
      "{a:1}",
      "{\"a\":01}",
      "{\"a\":+1}",
      "{\"a\":0x1}",
      "{\"a\":NaN}",
      "{\"a\":Infinity}",
      "{\"a\":1.}",
      "{\"a\":.5}",
      "{\"a\":-}",
      "{\"a\":1}//c",
      "{/*c*/\"a\":1}",
      "{\"a\":1}x",
      "{}{}",
      "{\"a\":1}\u{0}",
      "\u{A0}{\"a\":1}",
      "{\"a\":\u{A0}1}",
      "\u{0C}{\"a\":1}",
      "{\"a\":\u{0B}1}",
      "{\"a\":\u{2028}1}",
      "{\"a\":\"x\ty\"}",
      "{\"a\":\"x\ny\"}",
      "{\"a\":\"x\u{01}y\"}",
      "{\"a\":\"\\x41\"}",
      "{\"a\":\"\\u12G4\"}",
      "{\"a\":\"\\u12\"}",
      "{\"a\":True}",
      "{\"a\":undefined}",
      "{\"a\" 1}",
      "{\"a\":}",
      "{,}",
      "{\"a\":1,,\"b\":2}",
      "{\"a\":[,1]}",
      "{\"a\":tru}",
      "{\"a\":\"unterminated}",
      "{\"a\":1",
      "{\"a\":[1}",
      " ",
      "{\"a\":1e}",
      "{\"a\":1e+}",
      "{\"a\":--1}",
      "{\"a\":\"\u{7F}\"x}",
    ]
  }

  /// Strict JSON objects `JSON.parse` accepts (verified with node 22); the
  /// native validator must accept exactly these shapes too.
  private var jsParsesAsObject: [String] {
    [
      "{}",
      "{\"\":1}",
      "{\"a\":1,\"a\":2}",
      "{\"a\":{\"b\":[1,2,{\"c\":null}]}}",
      " \t\r\n{ \"a\" : 1 , \"b\" : [ true , false , null , -0.5e+3 ] } \n",
      "{\"a\":1E5,\"b\":1e-5,\"c\":-0,\"d\":0.0,\"e\":12345678901234567890}",
      "{\"a\":\"\\\"\\\\\\/\\b\\f\\n\\r\\t\\u00e9\\uD83D\\uDE00\"}",
      "{\"a\":\"\\uD800\"}",
      "{\"a\":\"\u{7F}\u{E9}\u{1F600}\"}",
      "{\"a\":" + String(repeating: "[", count: 100) + String(repeating: "]", count: 100) + "}",
      "{\"a\":[]}",
      "{\"a\":[[],{}]}",
    ]
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

  func testEveryValidatedWalletIsStorableEvenAtWorstCaseEscaping() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let limits = OfflineWallet.Limits.self
    let grants = (0..<limits.maxGrants).map { maximalGrant(index: $0) }

    // Every receipt at the byte limit whose payload is almost entirely escaped
    // quotes and backslashes (each doubles when re-embedded as a JSON string).
    let receipts = (0..<limits.maxReceipts).map { index -> OfflineStoredReceipt in
      let id = String(repeating: "/", count: 126) + String(format: "%02d", index)
      let shell = "{\"r\":\"\"}"
      let body = String(repeating: "\\\"\\\\", count: (limits.maxReceiptPayloadBytes - shell.utf8.count) / 4)
      let payload = "{\"r\":\"\(body)\"}"
      XCTAssertLessThanOrEqual(payload.utf8.count, limits.maxReceiptPayloadBytes)
      XCTAssertGreaterThan(payload.utf8.count, limits.maxReceiptPayloadBytes - 4)
      return OfflineStoredReceipt(receiptId: id, kind: .result, payloadJson: payload)
    }

    let contents = OfflineWalletContents(grants: grants, receipts: receipts)
    XCTAssertNoThrow(try OfflineWallet.validate(contents))
    let stored = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: contents)
    XCTAssertEqual(stored.contents, contents)
    XCTAssertEqual(try wallet.load(ownerId: ownerA), stored)
    let envelope = try XCTUnwrap(store.items[OfflineWallet.walletAccount(ownerId: ownerA)])
    XCTAssertLessThanOrEqual(envelope.count, limits.maxEnvelopeBytes)
    XCTAssertGreaterThan(
      envelope.count, limits.maxReceipts * limits.maxReceiptPayloadBytes + limits.maxGrants * limits.maxGrantJwsBytes,
      "the worst case really is larger than the raw payload bytes"
    )

    // Realistic receipts (quoted JSON fields) at every limit also store.
    let realistic = (0..<limits.maxReceipts).map { index -> OfflineStoredReceipt in
      var payload = "{\"schemaVersion\":\"offline-result-receipt-v1\",\"receiptId\":\"receipt-\(index)\",\"fields\":{"
      var field = 0
      while payload.utf8.count + 40 < limits.maxReceiptPayloadBytes {
        payload += "\"k\(field)\":\"v\(field)\","
        field += 1
      }
      payload.removeLast()
      payload += "}}"
      return OfflineStoredReceipt(receiptId: "receipt-\(index)", kind: .result, payloadJson: payload)
    }
    let realisticContents = OfflineWalletContents(grants: grants, receipts: realistic)
    XCTAssertEqual(
      try wallet.replace(ownerId: ownerA, expectedRevision: 1, contents: realisticContents).contents, realisticContents)
  }

  func testCanonicalBase64UrlTailsAreAccepted() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let signature = String(repeating: "A", count: 86)
    var revision: UInt64 = 0
    for claims in ["e30", "e30w", "eyJhIjoxfQ", base64url("{\"jti\":\"grant-1\"}")] {
      let jws = [base64url("{\"alg\":\"ES256\"}"), claims, signature].joined(separator: ".")
      let contents = OfflineWalletContents(grants: [OfflineStoredGrant(grantId: claims, compactJws: jws)], receipts: [])
      let stored = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: contents)
      XCTAssertEqual(stored.contents, contents)
      XCTAssertEqual(stored.revision, revision + 1, "revisions continue across clear")
      revision = stored.revision
      try wallet.clear(ownerId: ownerA, expectedRevision: revision)
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
    assertFailure(.invalidRevision) { try OfflineWallet.revision(fromBridge: -0.5) }
    assertFailure(.invalidRevision) { try OfflineWallet.revision(fromBridge: 1.5) }
    assertFailure(.invalidRevision) { try OfflineWallet.revision(fromBridge: Double.nan) }
    assertFailure(.invalidRevision) { try OfflineWallet.revision(fromBridge: Double.infinity) }
    assertFailure(.invalidRevision) { try OfflineWallet.revision(fromBridge: -Double.infinity) }
    assertFailure(.invalidRevision) { try OfflineWallet.revision(fromBridge: Double.greatestFiniteMagnitude) }
    XCTAssertEqual(try OfflineWallet.revision(fromBridge: 9_007_199_254_740_991), 9_007_199_254_740_991)
    XCTAssertEqual(OfflineWallet.maxRevision, 9_007_199_254_740_991, "the core never stores what JS cannot fence")
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
    XCTAssertEqual(
      OfflineWalletFailure.allCases.filter(\.isUnreadableState),
      [.tampered, .integrityKeyMissing, .unsupportedVersion],
      "exactly these may be returned by discardCorrupt"
    )
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

  func testSealedEnvelopeBindsVersionAccountAndKey() throws {
    let key = Data(repeating: 0x11, count: 32)
    let payload = Data("{\"a\":1}".utf8)
    let sealed = OfflineWallet.seal(payload: payload, account: "wallet.v1.x", key: key)
    XCTAssertEqual(sealed.count, 1 + 32 + payload.count)
    XCTAssertEqual(sealed.first, OfflineWallet.envelopeVersion)
    XCTAssertEqual(try OfflineWallet.open(sealed, account: "wallet.v1.x", key: key), payload)

    assertFailure(.tampered, "other account") { try OfflineWallet.open(sealed, account: "fence.v1.x", key: key) }
    assertFailure(.tampered, "other key") { try OfflineWallet.open(sealed, account: "wallet.v1.x", key: Data(repeating: 0x12, count: 32)) }
    var flippedVersion = sealed
    flippedVersion[flippedVersion.startIndex] = 2
    assertFailure(.unsupportedVersion) { try OfflineWallet.open(flippedVersion, account: "wallet.v1.x", key: key) }
    var flippedPayload = sealed
    flippedPayload[flippedPayload.index(before: flippedPayload.endIndex)] ^= 0x01
    assertFailure(.tampered, "payload") { try OfflineWallet.open(flippedPayload, account: "wallet.v1.x", key: key) }
    var flippedTag = sealed
    flippedTag[flippedTag.startIndex + 5] ^= 0x01
    assertFailure(.tampered, "tag") { try OfflineWallet.open(flippedTag, account: "wallet.v1.x", key: key) }
    assertFailure(.tampered, "header only") { try OfflineWallet.open(sealed.prefix(33), account: "wallet.v1.x", key: key) }
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
      XCTAssertNil(query[kSecAttrGeneric as String], "an unconditional read matches any version of the item")

      let attributes = store.addAttributes(account: account, data: Data([1]))
      XCTAssertEqual(
        attributes[kSecAttrAccessible as String] as? String,
        kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String
      )
      XCTAssertEqual(attributes[kSecAttrSynchronizable as String] as? Bool, false)
      XCTAssertEqual(attributes[kSecValueData as String] as? Data, Data([1]))
      XCTAssertEqual(attributes[kSecAttrGeneric as String] as? Data, OfflineWalletIntegrity.sha256(Data([1])))
      XCTAssertEqual(attributes[kSecAttrService as String] as? String, "com.picklesensei.offline.wallet")

      let update = store.updateAttributes(data: Data([2]))
      XCTAssertEqual(
        update[kSecAttrAccessible as String] as? String,
        kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String,
        "every replace re-asserts the protection class, not only the first add"
      )
      XCTAssertEqual(update[kSecValueData as String] as? Data, Data([2]))
      XCTAssertEqual(update[kSecAttrGeneric as String] as? Data, OfflineWalletIntegrity.sha256(Data([2])))
      XCTAssertEqual(update.count, 3, "an update never rewrites the item's identity attributes")

      let conditional = store.conditionalQuery(account: account, previous: Data([1]))
      XCTAssertEqual(conditional[kSecAttrGeneric as String] as? Data, OfflineWalletIntegrity.sha256(Data([1])))
      XCTAssertEqual(conditional[kSecAttrAccount as String] as? String, account)
      XCTAssertEqual(conditional.count, query.count + 1, "a conditional write matches the item AND the bytes last read")
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

  /// A grant whose JWS is exactly `Limits.maxGrantJwsBytes` (1024-char header,
  /// 15 272-char claims, 86-char signature) with a maximal id made of the one
  /// identifier character JSON escapes (`/`).
  private func maximalGrant(index: Int) -> OfflineStoredGrant {
    func json(_ prefix: String, bytes: Int) -> String {
      prefix + String(repeating: "p", count: bytes - prefix.utf8.count - 2) + "\"}"
    }
    let header = base64url(json("{\"alg\":\"ES256\",\"kid\":\"", bytes: 768))
    let claims = base64url(json("{\"jti\":\"maximal-\(index)\",\"pad\":\"", bytes: 11_454))
    let signature = String(repeating: "A", count: 86)
    let jws = [header, claims, signature].joined(separator: ".")
    precondition(jws.utf8.count == OfflineWallet.Limits.maxGrantJwsBytes)
    return OfflineStoredGrant(grantId: String(repeating: "/", count: 127) + String(index), compactJws: jws)
  }

  private func receipt(id: String, kind: OfflineStoredReceiptKind = .result) -> OfflineStoredReceipt {
    OfflineStoredReceipt(
      receiptId: id,
      kind: kind,
      payloadJson: "{\"schemaVersion\":\"offline-result-receipt-v1\",\"receiptId\":\"\(id)\"}"
    )
  }

  /// An authentic wallet envelope for `ownerId` sealed with the owner's stored
  /// key, so only the payload (not the tag) is under the test's control.
  private func forgeWallet(
    store: MemoryWalletStore, ownerId: String, revision: UInt64, grants: [OfflineStoredGrant], cleared: Bool = false
  ) -> Data {
    let key = store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerId)] ?? Data()
    let grantsJson = grants.map { "{\"compactJws\":\"\($0.compactJws)\",\"grantId\":\"\($0.grantId)\"}" }.joined(separator: ",")
    let payload =
      "{\"cleared\":\(cleared),\"epoch\":\"\(currentEpoch(store: store, ownerId: ownerId))\",\"grants\":[\(grantsJson)],"
      + "\"ownerId\":\"\(ownerId)\",\"receipts\":[],\"revision\":\(revision)}"
    return OfflineWallet.seal(payload: Data(payload.utf8), account: OfflineWallet.walletAccount(ownerId: ownerId), key: key)
  }

  private func forgeFence(
    store: MemoryWalletStore, ownerId: String, revision: UInt64, epoch: String? = nil, cleared: Bool = false
  ) -> Data {
    let key = store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerId)] ?? Data()
    let payload =
      "{\"cleared\":\(cleared),\"epoch\":\"\(epoch ?? currentEpoch(store: store, ownerId: ownerId))\","
      + "\"ownerId\":\"\(ownerId)\",\"revision\":\(revision)}"
    return OfflineWallet.seal(payload: Data(payload.utf8), account: OfflineWallet.fenceAccount(ownerId: ownerId), key: key)
  }

  /// The history epoch of the owner's stored fence, or a fixed well-formed one
  /// when there is none to read.
  private func currentEpoch(store: MemoryWalletStore, ownerId: String) -> String {
    guard let key = store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerId)],
      let fence = store.items[OfflineWallet.fenceAccount(ownerId: ownerId)],
      let state = try? OfflineWallet.openFenceState(fence, ownerId: ownerId, key: key)
    else {
      return String(repeating: "0", count: OfflineWallet.epochBytes * 2)
    }
    return state.epoch
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

/// In-memory double with the same compare-and-swap contract as the Keychain
/// adapter, plus counters, fault injection and a read hook for interleaving a
/// second writer between a read and its dependent write.
private final class MemoryWalletStore: OfflineWalletSecureStore {
  var items: [String: Data] = [:]
  var readCount = 0
  var writeCount = 0
  var writesByAccount: [String: Int] = [:]
  var writeOrder: [String] = []
  var failNextWrite: OfflineWalletError?
  var failNextRead: OfflineWalletError?
  var onReadWalletAccount: ((String) throws -> Void)?
  var onWrite: ((String) throws -> Void)?

  func read(account: String) throws -> Data? {
    if let failure = failNextRead {
      failNextRead = nil
      throw failure
    }
    readCount += 1
    let value = items[account]
    try onReadWalletAccount?(account)
    return value
  }

  func write(account: String, data: Data, ifUnchangedFrom previous: Data?) throws -> Bool {
    if let failure = failNextWrite {
      failNextWrite = nil
      throw failure
    }
    guard items[account] == previous else { return false }
    writeCount += 1
    writesByAccount[account, default: 0] += 1
    writeOrder.append(account)
    items[account] = data
    try onWrite?(account)
    return true
  }

  func delete(account: String, ifUnchangedFrom previous: Data) throws -> Bool {
    guard items[account] == previous else { return false }
    items.removeValue(forKey: account)
    return true
  }
}

/// Shared state of the two-thread straddle test. Every access is separated by
/// a semaphore hand-over, so the threads never touch it at the same time.
private final class StraddleScript: @unchecked Sendable {
  var step = 0
  var secondOutcome: Result<OfflineWalletSnapshot, Error>?
}
