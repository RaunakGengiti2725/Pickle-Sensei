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

      XCTAssertNil(try wallet.load(ownerId: ownerA), "nothing stored is still nothing stored")
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

    XCTAssertNil(try wallet.load(ownerId: ownerA))
    assertFailure(.integrityKeyMissing) {
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
    }
    XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerA), .integrityKeyMissing)
    XCTAssertTrue(store.items.isEmpty)
    XCTAssertEqual(
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [])).revision, 1)
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
    XCTAssertEqual(store.items[keyAccount], Data(repeating: 0x42, count: 32), "an orphaned usable key is reused, not replaced")

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
    XCTAssertNotNil(store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerA)], "a usable key stays")
    XCTAssertEqual(
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [])).revision, 1)
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

  // MARK: - Bridge parity: native accepts only what JSON.parse reads back

  /// Every receipt the native side stores is read back through the JS bridge
  /// with `JSON.parse`. A payload the native parser tolerates but JSON.parse
  /// rejects would be committed natively and then be unreadable from JS for
  /// good (load -> bridge_contract, discardCorrupt -> not_corrupt, clear needs
  /// a revision the caller never received). Native validation must therefore
  /// be at least as strict as JSON.parse and refuse these before writing.
  func testReplaceRefusesReceiptPayloadsJsonParseRejectsAndWritesNothing() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let rejected: [(String, String)] = [
      ("UTF-8 BOM", "\u{FEFF}{\"schemaVersion\":\"offline-result-receipt-v1\",\"receiptId\":\"r\"}"),
      ("trailing comma in object", "{\"a\":1,}"),
      ("trailing comma in array", "{\"a\":[1,]}"),
      ("leading comma", "{,\"a\":1}"),
      ("single-quoted string", "{'a':1}"),
      ("unquoted key", "{a:1}"),
      ("NaN literal", "{\"a\":NaN}"),
      ("Infinity literal", "{\"a\":-Infinity}"),
      ("undefined literal", "{\"a\":undefined}"),
      ("capitalised literal", "{\"a\":True}"),
      ("line comment", "{\"a\":1}//x"),
      ("block comment", "{/*c*/\"a\":1}"),
      ("leading zero", "{\"a\":01}"),
      ("leading plus", "{\"a\":+1}"),
      ("bare fraction", "{\"a\":.5}"),
      ("dangling fraction", "{\"a\":1.}"),
      ("dangling exponent", "{\"a\":1e}"),
      ("hex number", "{\"a\":0x10}"),
      ("lone minus", "{\"a\":-}"),
      ("raw tab in string", "{\"a\":\"x\ty\"}"),
      ("raw newline in string", "{\"a\":\"x\ny\"}"),
      ("raw NUL in string", "{\"a\":\"x\u{0}y\"}"),
      ("unknown escape", "{\"a\":\"\\x41\"}"),
      ("short unicode escape", "{\"a\":\"\\u12\"}"),
      ("non-hex unicode escape", "{\"a\":\"\\u12G4\"}"),
      ("unterminated string", "{\"a\":\"x}"),
      ("missing colon", "{\"a\" 1}"),
      ("missing value", "{\"a\":}"),
      ("unclosed object", "{\"a\":1"),
      ("mismatched close", "{\"a\":[1}"),
      ("trailing garbage", "{\"a\":1} x"),
      ("second document", "{\"a\":1}{\"b\":2}"),
      ("no-break space as whitespace", "{\u{00A0}\"a\":1}"),
      ("line separator as whitespace", "{\"a\":\u{2028}1}"),
      ("vertical tab as whitespace", "{\u{0B}\"a\":1}"),
      ("form feed as whitespace", "{\u{0C}\"a\":1}"),
      ("NUL after document", "{\"a\":1}\u{0}"),
      ("array at top level", "[{\"a\":1}]"),
      ("string at top level", "\"{}\""),
      ("null at top level", "null"),
      ("empty", ""),
      ("whitespace only", " \n"),
    ]
    for (name, payload) in rejected {
      let error = assertFailure(.invalidReceipt, name) {
        try wallet.replace(
          ownerId: ownerA,
          expectedRevision: 0,
          contents: OfflineWalletContents(
            grants: [],
            receipts: [OfflineStoredReceipt(receiptId: "r", kind: .result, payloadJson: payload)]
          )
        )
      }
      XCTAssertEqual(error?.detail, "receipt payload is not a bounded JSON object", name)
    }
    XCTAssertEqual(store.writeCount, 0, "a refused receipt must never reach the store")
    XCTAssertTrue(store.items.isEmpty, "not even the integrity key may be minted for a refused write")
    XCTAssertNil(try wallet.load(ownerId: ownerA))
  }

  /// The strict native grammar must not over-reject: every payload JSON.parse
  /// reads back as a plain object still round-trips through native storage.
  func testReplaceStoresEveryReceiptPayloadJsonParseAccepts() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let deep = String(repeating: "[", count: OfflineWallet.Limits.maxReceiptJsonDepth - 1)
      + String(repeating: "]", count: OfflineWallet.Limits.maxReceiptJsonDepth - 1)
    let accepted: [String] = [
      "{}",
      " \t\r\n{ \t\r\n} \t\r\n",
      "{\"a\":1,\"b\":[],\"c\":{},\"d\":[[[]]],\"e\":{\"f\":{\"g\":null}}}",
      "{\"n\":[0,-0,1,-1,10,1.5,-0.25,1e5,1E+5,1e-5,1.25e10,123456789012345678901234567890,1e400]}",
      "{\"l\":[true,false,null]}",
      "{\"s\":\"\\\"\\\\\\/\\b\\f\\n\\r\\t\\u0000\\u001f\\u00e9\\uD83D\\uDE00\\ud800\\uDC00\\uFFFF\"}",
      "{\"u\":\"é ñ 日本 😀 \u{2028} \u{2029} \u{7F} \u{FEFF} \u{FFFD}\"}",
      "{\"\":\"\",\"k\":\"\",\"dup\":1,\"dup\":2}",
      "{\"deep\":\(deep)}",
      "{\"schemaVersion\":\"offline-result-receipt-v1\",\"receiptId\":\"r\",\"operationId\":\"op\",\"amount\":1}",
      "{\"kv\" : 1 , \"kw\" : [ 1 , 2 ] }",
      "{\"pad\":\"" + String(repeating: "x", count: OfflineWallet.Limits.maxReceiptPayloadBytes - 10) + "\"}",
    ]
    var revision: UInt64 = 0
    for payload in accepted {
      precondition(payload.utf8.count <= OfflineWallet.Limits.maxReceiptPayloadBytes)
      let receipt = OfflineStoredReceipt(receiptId: "r", kind: .result, payloadJson: payload)
      let snapshot = try wallet.replace(
        ownerId: ownerA,
        expectedRevision: revision,
        contents: OfflineWalletContents(grants: [], receipts: [receipt])
      )
      revision = snapshot.revision
      XCTAssertEqual(snapshot.contents.receipts.first?.payloadJson, payload)
      XCTAssertEqual(try wallet.load(ownerId: ownerA)?.contents.receipts.first?.payloadJson, payload, payload)
    }
    XCTAssertEqual(revision, UInt64(accepted.count))
  }

  func testReceiptPayloadNestingIsBoundedWithoutRecursion() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let depth = OfflineWallet.Limits.maxReceiptJsonDepth
    XCTAssertGreaterThanOrEqual(depth, 16, "receipts nest a few levels; the bound must leave headroom")

    func nested(_ containers: Int) -> String {
      "{\"d\":" + String(repeating: "{\"k\":", count: containers - 2)
        + "[]" + String(repeating: "}", count: containers - 2) + "}"
    }
    _ = try wallet.replace(
      ownerId: ownerA,
      expectedRevision: 0,
      contents: OfflineWalletContents(
        grants: [],
        receipts: [OfflineStoredReceipt(receiptId: "r", kind: .result, payloadJson: nested(depth))]
      )
    )
    assertFailure(.invalidReceipt, "one level past the bound") {
      try wallet.replace(
        ownerId: ownerA,
        expectedRevision: 1,
        contents: OfflineWalletContents(
          grants: [],
          receipts: [OfflineStoredReceipt(receiptId: "r", kind: .result, payloadJson: nested(depth + 1))]
        )
      )
    }
    let hostile = String(repeating: "[", count: OfflineWallet.Limits.maxReceiptPayloadBytes - 6)
    assertFailure(.invalidReceipt, "thousands of open brackets must be refused, never recursed into") {
      try wallet.replace(
        ownerId: ownerA,
        expectedRevision: 1,
        contents: OfflineWalletContents(
          grants: [],
          receipts: [OfflineStoredReceipt(receiptId: "r", kind: .result, payloadJson: "{\"a\":\(hostile)")]
        )
      )
    }
    XCTAssertEqual(try wallet.load(ownerId: ownerA)?.revision, 1)
  }

  /// A receipt stored under an earlier build's looser grammar must not be
  /// misread later: the stricter validator is applied on load as well, so the
  /// wallet reports tampered instead of returning bytes JS cannot parse.
  func testStoredReceiptFailingTheStrictGrammarIsUnreadableNotSilentlyReturned() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
    let key = try XCTUnwrap(store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerA)])
    let payload = "{\"grants\":[],\"ownerId\":\"\(ownerA)\",\"receipts\":[{\"kind\":\"result\",\"payloadJson\":\"{\\\"a\\\":1,}\",\"receiptId\":\"r\"}],\"revision\":2}"
    store.items[OfflineWallet.walletAccount(ownerId: ownerA)] = OfflineWallet.seal(
      payload: Data(payload.utf8),
      account: OfflineWallet.walletAccount(ownerId: ownerA),
      key: key
    )
    assertFailure(.tampered) { try wallet.load(ownerId: ownerA) }
    XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerA), .tampered)
  }

  // MARK: - Two instances racing an owner's first write

  /// The bridge serialises one instance, but the header promises safety across
  /// instances/processes. `readState` reads key -> fence -> wallet separately,
  /// so a reader that saw "no key" before another instance's first write and
  /// then sees that write's fence/wallet must re-read rather than call the
  /// healthy result "integrity key missing".
  func testLoadRacingAnotherInstancesFirstWriteIsNilOrTheCommittedSnapshotNeverUnreadable() throws {
    let store = MemoryWalletStore()
    let reader = OfflineWallet(store: store)
    let writer = OfflineWallet(store: store)
    let keyAccount = OfflineWallet.integrityKeyAccount(ownerId: ownerA)
    var fired = false
    store.onReadWalletAccount = { account in
      guard account == keyAccount, !fired else { return }
      fired = true
      store.onReadWalletAccount = nil
      _ = try writer.replace(
        ownerId: self.ownerA,
        expectedRevision: 0,
        contents: OfflineWalletContents(grants: [], receipts: [self.receipt(id: "receipt-unsent")])
      )
    }

    let observed = try reader.load(ownerId: ownerA)
    XCTAssertTrue(fired)
    if let observed {
      XCTAssertEqual(observed.revision, 1)
      XCTAssertEqual(observed.contents.receipts.map(\.receiptId), ["receipt-unsent"])
    }
    XCTAssertEqual(try reader.load(ownerId: ownerA)?.revision, 1, "the committed write is visible afterwards")
  }

  func testDiscardCorruptRacingAnotherInstancesFirstWriteNeverDeletesTheHealthyWallet() throws {
    let store = MemoryWalletStore()
    let discarder = OfflineWallet(store: store)
    let writer = OfflineWallet(store: store)
    let keyAccount = OfflineWallet.integrityKeyAccount(ownerId: ownerA)
    var fired = false
    store.onReadWalletAccount = { account in
      guard account == keyAccount, !fired else { return }
      fired = true
      store.onReadWalletAccount = nil
      _ = try writer.replace(
        ownerId: self.ownerA,
        expectedRevision: 0,
        contents: OfflineWalletContents(grants: [], receipts: [self.receipt(id: "receipt-unsent")])
      )
    }

    assertFailure(.notCorrupt, "a healthy wallet must never be discarded") {
      try discarder.discardCorrupt(ownerId: ownerA)
    }
    XCTAssertTrue(fired)
    XCTAssertNotNil(store.items[OfflineWallet.walletAccount(ownerId: ownerA)], "healthy wallet must survive")
    XCTAssertNotNil(store.items[OfflineWallet.fenceAccount(ownerId: ownerA)], "verified fence must survive")
    XCTAssertNotNil(store.items[keyAccount])
    let snapshot = try XCTUnwrap(try discarder.load(ownerId: ownerA))
    XCTAssertEqual(snapshot.revision, 1)
    XCTAssertEqual(snapshot.contents.receipts.map(\.receiptId), ["receipt-unsent"])
  }

  /// The re-read must not mask a genuinely missing key: when the torn view is
  /// stable across reads it is corruption and stays reportable/discardable.
  func testGenuinelyMissingIntegrityKeyIsStillReportedAfterTheReread() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [grant(id: "g")], receipts: []))
    store.items.removeValue(forKey: OfflineWallet.integrityKeyAccount(ownerId: ownerA))

    assertFailure(.integrityKeyMissing) { try wallet.load(ownerId: ownerA) }
    XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerA), .integrityKeyMissing)
    XCTAssertNil(store.items[OfflineWallet.walletAccount(ownerId: ownerA)])
    XCTAssertNil(try wallet.load(ownerId: ownerA))
  }

  /// A store whose owner items change on every read (a writer storm or a
  /// misbehaving backend) never settles into a classifiable state; that is a
  /// storage failure the caller retries, never a verdict that deletes items.
  func testOwnerStateThatNeverSettlesIsAStorageFailureNotAVerdict() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "r")]))
    let keyAccount = OfflineWallet.integrityKeyAccount(ownerId: ownerA)
    let key = try XCTUnwrap(store.items[keyAccount])
    let walletBytes = try XCTUnwrap(store.items[OfflineWallet.walletAccount(ownerId: ownerA)])
    var flips = 0
    store.onReadWalletAccount = { account in
      guard account == keyAccount else { return }
      flips += 1
      if store.items[keyAccount] == nil { store.items[keyAccount] = key } else { store.items.removeValue(forKey: keyAccount) }
    }

    assertFailure(.storageFailure, "an unstable view is neither healthy nor corrupt") { try wallet.load(ownerId: ownerA) }
    assertFailure(.storageFailure) { try wallet.discardCorrupt(ownerId: ownerA) }
    XCTAssertGreaterThan(flips, 1)
    XCTAssertEqual(store.items[OfflineWallet.walletAccount(ownerId: ownerA)], walletBytes, "nothing may be deleted on an unstable view")
    XCTAssertNotNil(store.items[OfflineWallet.fenceAccount(ownerId: ownerA)])

    store.onReadWalletAccount = nil
    store.items[keyAccount] = key
    XCTAssertEqual(try wallet.load(ownerId: ownerA)?.contents.receipts.map(\.receiptId), ["r"])
  }

  // MARK: - clear repairs a lagging fence

  /// A crash between the wallet write and the fence commit leaves the fence one
  /// behind the wallet. `clear` must advance the fence to the observed wallet
  /// revision before deleting (as `replace` does), otherwise the next replace
  /// hands out the same revision again and the pre-clear authentic envelope
  /// replays as current state.
  func testClearAfterCrashBetweenWalletWriteAndFenceCommitRepairsTheFenceSoNoRevisionIsReused() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let walletAccount = OfflineWallet.walletAccount(ownerId: ownerA)
    let fenceAccount = OfflineWallet.fenceAccount(ownerId: ownerA)

    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
    let fenceAtOne = try XCTUnwrap(store.items[fenceAccount])
    let crashed = try wallet.replace(
      ownerId: ownerA,
      expectedRevision: 1,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-submitted-later")])
    )
    XCTAssertEqual(crashed.revision, 2)
    let crashedEnvelope = try XCTUnwrap(store.items[walletAccount])
    store.items[fenceAccount] = fenceAtOne

    let relaunched = OfflineWallet(store: store)
    XCTAssertEqual(try relaunched.load(ownerId: ownerA)?.revision, 2, "wallet ahead of fence is the crash window, not tampering")
    try relaunched.clear(ownerId: ownerA, expectedRevision: 2)
    XCTAssertNil(store.items[walletAccount])
    XCTAssertNotEqual(store.items[fenceAccount], fenceAtOne, "clear must have committed the fence to revision 2")
    XCTAssertNil(try relaunched.load(ownerId: ownerA))

    let next = try relaunched.replace(
      ownerId: ownerA,
      expectedRevision: 0,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-unsent")])
    )
    XCTAssertEqual(next.revision, 3, "revision 2 was already handed out for this owner and must never be reused")

    store.items[walletAccount] = crashedEnvelope
    assertFailure(.tampered, "an older authentic envelope must not read as current state") {
      try relaunched.load(ownerId: ownerA)
    }
    XCTAssertEqual(try relaunched.discardCorrupt(ownerId: ownerA), .tampered)
  }

  func testClearWithACurrentFenceWritesTheFenceOnlyWhenItLags() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let fenceAccount = OfflineWallet.fenceAccount(ownerId: ownerA)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
    let fenceWrites = store.writesByAccount[fenceAccount]
    try wallet.clear(ownerId: ownerA, expectedRevision: 1)
    XCTAssertEqual(store.writesByAccount[fenceAccount], fenceWrites, "a current fence is not rewritten by clear")
    XCTAssertNil(try wallet.load(ownerId: ownerA))
  }

  /// The fence commit after a wallet write may lose its compare-and-swap to a
  /// faster writer that already moved the fence further; it must then accept
  /// the newer fence, and when the fence was moved to an OLDER value by a
  /// lagging peer it must retry rather than fail the committed write.
  func testFenceCommitRetriesPastAConcurrentFenceMoveInsteadOfFailingTheCommittedWrite() throws {
    let store = MemoryWalletStore()
    let wallet = OfflineWallet(store: store)
    let fenceAccount = OfflineWallet.fenceAccount(ownerId: ownerA)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 1, contents: OfflineWalletContents(grants: [], receipts: []))
    let fenceAtTwo = try XCTUnwrap(store.items[fenceAccount])
    let fenceAtOne = forgeFence(store: store, ownerId: ownerA, revision: 1)

    var interposed = false
    store.onReadWalletAccount = { account in
      guard account == fenceAccount, !interposed, store.items[fenceAccount] == fenceAtTwo else { return }
      interposed = true
      store.items[fenceAccount] = fenceAtOne
    }
    let third = try wallet.replace(ownerId: ownerA, expectedRevision: 2, contents: OfflineWalletContents(grants: [grant(id: "g")], receipts: []))
    store.onReadWalletAccount = nil
    XCTAssertEqual(third.revision, 3)
    XCTAssertTrue(interposed)
    XCTAssertEqual(try wallet.load(ownerId: ownerA)?.revision, 3)
    store.items[OfflineWallet.walletAccount(ownerId: ownerA)] = forgeWallet(store: store, ownerId: ownerA, revision: 2, grants: [])
    assertFailure(.tampered, "the fence ends at 3 after the retry, so revision 2 is a rollback") {
      try wallet.load(ownerId: ownerA)
    }
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
  private func forgeWallet(store: MemoryWalletStore, ownerId: String, revision: UInt64, grants: [OfflineStoredGrant]) -> Data {
    let key = store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerId)] ?? Data()
    let grantsJson = grants.map { "{\"compactJws\":\"\($0.compactJws)\",\"grantId\":\"\($0.grantId)\"}" }.joined(separator: ",")
    let payload = "{\"grants\":[\(grantsJson)],\"ownerId\":\"\(ownerId)\",\"receipts\":[],\"revision\":\(revision)}"
    return OfflineWallet.seal(payload: Data(payload.utf8), account: OfflineWallet.walletAccount(ownerId: ownerId), key: key)
  }

  private func forgeFence(store: MemoryWalletStore, ownerId: String, revision: UInt64) -> Data {
    let key = store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerId)] ?? Data()
    let payload = "{\"ownerId\":\"\(ownerId)\",\"revision\":\(revision)}"
    return OfflineWallet.seal(payload: Data(payload.utf8), account: OfflineWallet.fenceAccount(ownerId: ownerId), key: key)
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
    return true
  }

  func delete(account: String, ifUnchangedFrom previous: Data) throws -> Bool {
    guard items[account] == previous else { return false }
    items.removeValue(forKey: account)
    return true
  }
}
