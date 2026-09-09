import Foundation
import XCTest

@testable import PickleVisionCore

/// Adversarial matrix for W05-01 (attack branch `devin/pp/w05-01/attack-bbb8b36a`,
/// candidate `bbb8b36a`). Every `testAttack_*` drives the candidate wallet
/// through one failure boundary — interleaved writers, partial persisted
/// state, process death between store writes, replayed envelopes, bridge and
/// shape boundaries, owner isolation — and asserts the behaviour the module's
/// own contract promises. A failing test here is a confirmed break of the
/// candidate; the candidate's code and tests are not touched.
final class OfflineWalletAttackTests: XCTestCase {
  private let ownerA = "0f9d5a7e-3c1b-4a2d-9b8e-1c2d3e4f5a6b"
  private let ownerB = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
  private let safeMaxRevision: Double = 9_007_199_254_740_991

  private struct Crash: Error {}

  private var keyA: String { OfflineWallet.integrityKeyAccount(ownerId: ownerA) }
  private var fenceA: String { OfflineWallet.fenceAccount(ownerId: ownerA) }
  private var walletA: String { OfflineWallet.walletAccount(ownerId: ownerA) }
  private var empty: OfflineWalletContents { OfflineWalletContents(grants: [], receipts: []) }

  // MARK: - Concurrency: two instances racing the owner's first write

  /// The candidate's own races fire the second writer *during a read*. Here
  /// the second instance runs its whole first write *between* the first
  /// instance's key write and fence write (and between its fence write and
  /// wallet write): the store must end with exactly one readable winner, the
  /// loser must fail typed, and the surviving key must seal the surviving
  /// fence and wallet.
  func testAttack_SecondInstanceFirstWriteBetweenKeyFenceAndWalletWritesLeavesOneReadableWinner() throws {
    for trigger in [keyA, fenceA] {
      let store = AttackStore()
      let first = OfflineWallet(store: store)
      let second = OfflineWallet(store: store)
      var fired = false
      var secondOutcome: Result<OfflineWalletSnapshot, Error>?
      store.afterWrite = { account in
        guard !fired, account == trigger else { return }
        fired = true
        secondOutcome = Result {
          try second.replace(
            ownerId: self.ownerA, expectedRevision: 0,
            contents: OfflineWalletContents(grants: [], receipts: [self.receipt(id: "receipt-second")]))
        }
      }
      let firstOutcome = Result {
        try first.replace(
          ownerId: ownerA, expectedRevision: 0,
          contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-first")]))
      }
      store.afterWrite = nil
      XCTAssertTrue(fired, trigger)
      let outcomes = [firstOutcome, try XCTUnwrap(secondOutcome, trigger)]
      let winners = outcomes.compactMap { try? $0.get() }
      XCTAssertEqual(winners.count, 1, "exactly one first write commits — \(trigger)")
      for outcome in outcomes {
        if case .failure(let error) = outcome {
          XCTAssertEqual((error as? OfflineWalletError)?.failure, .revisionConflict, "loser fails typed — \(trigger)")
        }
      }
      let winner = try XCTUnwrap(winners.first, trigger)
      XCTAssertEqual(winner.revision, 1, trigger)
      XCTAssertEqual(try first.load(ownerId: ownerA), winner, "the acknowledged snapshot is what reads back — \(trigger)")
      XCTAssertEqual(try second.load(ownerId: ownerA), winner, trigger)
      XCTAssertEqual(Set(store.items.keys), [keyA, fenceA, walletA], trigger)
      let key = try XCTUnwrap(store.items[keyA], trigger)
      let fence = try OfflineWallet.openFenceState(try XCTUnwrap(store.items[fenceA]), ownerId: ownerA, key: key)
      XCTAssertEqual(fence.revision, 1, "fence sealed by the surviving key — \(trigger)")
      XCTAssertFalse(fence.cleared, trigger)
      XCTAssertEqual(
        try first.replace(ownerId: ownerA, expectedRevision: 1, contents: empty).revision, 2,
        "history continues from the winner — \(trigger)")
    }
  }

  /// Double submit from the same instance: the second identical replace must
  /// conflict and the store must be byte-identical to the first commit.
  func testAttack_DoubleSubmitOfTheSameReplaceConflictsAndLeavesTheFirstCommitUntouched() throws {
    let store = AttackStore()
    let wallet = OfflineWallet(store: store)
    let contents = OfflineWalletContents(grants: [grant(id: "g1")], receipts: [receipt(id: "r1")])
    let committed = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: contents)
    let snapshotBytes = store.items
    let writes = store.writeLog.count

    assertFailure(.revisionConflict) { try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: contents) }
    XCTAssertEqual(store.items, snapshotBytes, "a conflicting replace writes nothing")
    XCTAssertEqual(store.writeLog.count, writes)
    XCTAssertEqual(try wallet.load(ownerId: ownerA), committed)

    try wallet.clear(ownerId: ownerA, expectedRevision: 1)
    assertFailure(.revisionConflict, "the same clear replayed") { try wallet.clear(ownerId: ownerA, expectedRevision: 1) }
    XCTAssertNil(try wallet.load(ownerId: ownerA))
    XCTAssertEqual(try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: empty).revision, 2)
  }

  // MARK: - Concurrency: a reader interleaved with another instance's clear

  /// `clear` writes the fence (marked cleared) before the tombstone. A reader
  /// from another instance that runs entirely inside that window sees a
  /// stable "fence cleared, wallet still present" pair — byte-for-byte the
  /// same state a rollback of the tombstone leaves. Whatever verdict the
  /// reader gets, it must never hand back the fenced-off revision as current,
  /// never commit over it, and the finished clear must read as simply empty.
  /// (Observed on the candidate: both calls surface `.tampered`; the pod's
  /// serial queue keeps this window out of the shipping app.)
  func testAttack_LoadInterleavedWithAnotherInstancesClearNeverResurrectsOrOverwritesTheFencedRevision() throws {
    let store = AttackStore()
    let clearing = OfflineWallet(store: store)
    let reader = OfflineWallet(store: store)
    _ = try clearing.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [grant(id: "g1")], receipts: []))

    var loadOutcome: Result<OfflineWalletSnapshot?, Error>?
    var replaceOutcome: Result<OfflineWalletSnapshot, Error>?
    var fired = false
    store.afterWrite = { account in
      guard !fired, account == self.fenceA else { return }
      fired = true
      loadOutcome = Result { try reader.load(ownerId: self.ownerA) }
      replaceOutcome = Result { try reader.replace(ownerId: self.ownerA, expectedRevision: 1, contents: self.empty) }
    }
    try clearing.clear(ownerId: ownerA, expectedRevision: 1)
    store.afterWrite = nil
    XCTAssertTrue(fired)

    let acceptable: Set<OfflineWalletFailure> = [.revisionConflict, .tampered]
    switch try XCTUnwrap(loadOutcome) {
    case .success(let snapshot):
      XCTAssertNil(snapshot, "revision 1 is fenced off by the clear and must not be returned as current")
    case .failure(let error):
      XCTAssertTrue(
        acceptable.contains((error as? OfflineWalletError)?.failure ?? .storageFailure),
        "unexpected verdict inside the clear window: \(error)")
    }
    switch try XCTUnwrap(replaceOutcome) {
    case .success:
      XCTFail("replace(expectedRevision: 1) must not commit over a clear that already fenced revision 1")
    case .failure(let error):
      XCTAssertTrue(
        acceptable.contains((error as? OfflineWalletError)?.failure ?? .storageFailure),
        "unexpected verdict inside the clear window: \(error)")
    }
    XCTAssertNil(try reader.load(ownerId: ownerA), "once the clear finished the wallet is simply empty")
    assertFailure(.notCorrupt) { try reader.discardCorrupt(ownerId: ownerA) }
  }

  // MARK: - Corrupt / partial persisted state: an empty slot beside a fence that no longer verifies

  /// `load`'s contract: "Stored bytes that do not verify … are a thrown
  /// failure, never nil." With the wallet slot empty and the fence present but
  /// unverifiable (tampered bytes, missing key, or a key of the wrong length),
  /// `replace` refuses the state as corrupt and `discardCorrupt` would remove
  /// it — so `load` must not describe the same state as an empty wallet.
  func testAttack_EmptySlotBesideAnUnverifiableFenceMustNotLoadAsAnEmptyWallet() throws {
    enum Damage: String, CaseIterable {
      case flippedFenceByte
      case missingKey
      case shortKey
    }
    for damage in Damage.allCases {
      let store = AttackStore()
      let wallet = OfflineWallet(store: store)
      _ = try wallet.replace(
        ownerId: ownerA, expectedRevision: 0,
        contents: OfflineWalletContents(grants: [grant(id: "g1")], receipts: [receipt(id: "r1")]))
      store.items.removeValue(forKey: walletA)
      switch damage {
      case .flippedFenceByte:
        var fence = try XCTUnwrap(store.items[fenceA])
        fence[fence.count - 1] ^= 0x01
        store.items[fenceA] = fence
      case .missingKey:
        store.items.removeValue(forKey: keyA)
      case .shortKey:
        store.items[keyA] = Data(repeating: 0x42, count: 31)
      }
      let expected: OfflineWalletFailure = damage == .missingKey ? .integrityKeyMissing : .tampered

      // The module itself judges this state corrupt on the write side …
      assertFailure(expected, damage.rawValue) { try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: empty) }
      assertFailure(expected, damage.rawValue) { try wallet.clear(ownerId: ownerA, expectedRevision: 0) }
      // … so the read side must not fabricate an empty wallet for it.
      let writesBefore = store.writeLog.count
      do {
        let loaded = try wallet.load(ownerId: ownerA)
        XCTFail(
          "\(damage.rawValue): load returned \(String(describing: loaded)) although revision 1 was committed and the fence no longer verifies — fabricated empty history")
      } catch let error as OfflineWalletError {
        XCTAssertEqual(error.failure, expected, damage.rawValue)
      }
      XCTAssertEqual(store.writeLog.count, writesBefore, "load never writes — \(damage.rawValue)")
      XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerA), expected, damage.rawValue)
    }
  }

  // MARK: - Process death inside discardCorrupt / clear

  /// `discardCorrupt` without a verifiable fence deletes wallet, key, fence in
  /// that order. Dying right after the key deletion leaves only the fence.
  /// The next launch must see one consistent verdict from every entry point:
  /// if `replace` refuses the state as `integrity_key_missing`, `load` must
  /// not call the same state an empty wallet.
  func testAttack_DiscardInterruptedAfterKeyDeletionGivesLoadAndReplaceTheSameVerdict() throws {
    let store = AttackStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [grant(id: "g1")], receipts: []))
    var fence = try XCTUnwrap(store.items[fenceA])
    fence[fence.count - 1] ^= 0x01
    store.items[fenceA] = fence
    assertFailure(.tampered) { try wallet.load(ownerId: ownerA) }

    store.afterDelete = { account in
      if account == self.keyA { throw Crash() }
    }
    XCTAssertThrowsError(try wallet.discardCorrupt(ownerId: ownerA))
    store.afterDelete = nil
    XCTAssertEqual(store.deleteLog, [walletA, keyA])
    XCTAssertEqual(Set(store.items.keys), [fenceA], "process died after deleting the wallet and the key")

    // Relaunch.
    let relaunched = OfflineWallet(store: store)
    assertFailure(.integrityKeyMissing) { try relaunched.replace(ownerId: ownerA, expectedRevision: 0, contents: empty) }
    do {
      let loaded = try relaunched.load(ownerId: ownerA)
      XCTFail("load returned \(String(describing: loaded)) for a state replace refuses as integrity_key_missing")
    } catch let error as OfflineWalletError {
      XCTAssertEqual(error.failure, .integrityKeyMissing)
    }
    XCTAssertEqual(try relaunched.discardCorrupt(ownerId: ownerA), .integrityKeyMissing)
    XCTAssertTrue(store.items.isEmpty)
    XCTAssertEqual(try relaunched.replace(ownerId: ownerA, expectedRevision: 0, contents: empty).revision, 1)
  }

  /// `discardCorrupt` with a verifiable fence writes the retired fence first,
  /// then the tombstone. Dying between the two must leave a state a second
  /// discard repairs, with the revision sequence intact.
  func testAttack_DiscardInterruptedBetweenFenceAndTombstoneIsRepairedByTheNextDiscard() throws {
    let store = AttackStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: empty)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 1, contents: OfflineWalletContents(grants: [grant(id: "g1")], receipts: []))
    var bytes = try XCTUnwrap(store.items[walletA])
    bytes[bytes.count - 1] ^= 0x01
    store.items[walletA] = bytes
    assertFailure(.tampered) { try wallet.load(ownerId: ownerA) }

    store.afterWrite = { account in
      if account == self.fenceA { throw Crash() }
    }
    XCTAssertThrowsError(try wallet.discardCorrupt(ownerId: ownerA))
    store.afterWrite = nil
    XCTAssertEqual(store.items[walletA], bytes, "the corrupt envelope is still in the slot")

    let relaunched = OfflineWallet(store: store)
    assertFailure(.tampered) { try relaunched.load(ownerId: ownerA) }
    assertFailure(.tampered) { try relaunched.replace(ownerId: ownerA, expectedRevision: 0, contents: empty) }
    XCTAssertEqual(try relaunched.discardCorrupt(ownerId: ownerA), .tampered)
    XCTAssertNil(try relaunched.load(ownerId: ownerA))
    XCTAssertEqual(
      try relaunched.replace(ownerId: ownerA, expectedRevision: 0, contents: empty).revision, 3,
      "revisions stay monotonic across the interrupted discard")
    assertFailure(.notCorrupt) { try relaunched.discardCorrupt(ownerId: ownerA) }
  }

  /// Dying inside `clear` after the fence commit but before the tombstone:
  /// the contract says the removed wallet reads `tampered` and leaves through
  /// `discardCorrupt`. The next wallet must continue the sequence, and the
  /// envelope being cleared must never come back as current.
  func testAttack_ClearInterruptedAfterTheFenceCommitNeverResurrectsTheClearedWallet() throws {
    let store = AttackStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [grant(id: "g1")], receipts: []))
    let clearedEnvelope = try XCTUnwrap(store.items[walletA])

    store.afterWrite = { account in
      if account == self.fenceA { throw Crash() }
    }
    XCTAssertThrowsError(try wallet.clear(ownerId: ownerA, expectedRevision: 1))
    store.afterWrite = nil
    XCTAssertEqual(store.items[walletA], clearedEnvelope)

    let relaunched = OfflineWallet(store: store)
    assertFailure(.tampered, "fenced-as-cleared envelope must not read as current") { try relaunched.load(ownerId: ownerA) }
    assertFailure(.tampered) { try relaunched.replace(ownerId: ownerA, expectedRevision: 1, contents: empty) }
    assertFailure(.tampered) { try relaunched.replace(ownerId: ownerA, expectedRevision: 0, contents: empty) }
    XCTAssertEqual(try relaunched.discardCorrupt(ownerId: ownerA), .tampered)
    XCTAssertNil(try relaunched.load(ownerId: ownerA))
    XCTAssertEqual(try relaunched.replace(ownerId: ownerA, expectedRevision: 0, contents: empty).revision, 2)
    store.items[walletA] = clearedEnvelope
    assertFailure(.tampered, "the cleared envelope replayed over revision 2 is a rollback") { try relaunched.load(ownerId: ownerA) }
  }

  // MARK: - Storage faults at every step of a write

  /// A store fault (locked keychain, I/O error) at each read and each write of
  /// a replace must surface as the typed failure of that fault, leave the
  /// owner readable or empty (never corrupt), and let the next replace commit.
  func testAttack_StorageFaultAtEveryReadAndWriteStepIsTypedAndLeavesRecoverableState() throws {
    let fault = OfflineWalletError(failure: .storageUnavailable, detail: "device locked", status: -25308)

    for readIndex in 1...3 {
      let store = AttackStore()
      let wallet = OfflineWallet(store: store)
      store.readFault = { _, index in
        if index == readIndex { throw fault }
      }
      let error = assertFailure(.storageUnavailable, "read \(readIndex)") {
        try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: empty)
      }
      XCTAssertEqual(error?.status, -25308, "read \(readIndex)")
      store.readFault = nil
      XCTAssertTrue(store.items.isEmpty, "a failed read writes nothing — read \(readIndex)")
      XCTAssertEqual(try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: empty).revision, 1, "read \(readIndex)")
    }

    for step in 0..<4 {
      let store = AttackStore()
      let wallet = OfflineWallet(store: store)
      var writes = 0
      store.beforeWrite = { _ in
        defer { writes += 1 }
        if writes == step { throw fault }
      }
      assertFailure(.storageUnavailable, "write step \(step)") {
        try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [grant(id: "g1")], receipts: []))
      }
      store.beforeWrite = nil

      let relaunched = OfflineWallet(store: store)
      let observed = try relaunched.load(ownerId: ownerA)
      if step == 3 {
        XCTAssertEqual(observed?.revision, 1, "wallet write is the commit point; fence commit lagging is harmless — step \(step)")
        XCTAssertEqual(observed?.contents.grants.map(\.grantId), ["g1"], "step \(step)")
        XCTAssertEqual(try relaunched.replace(ownerId: ownerA, expectedRevision: 1, contents: empty).revision, 2, "step \(step)")
      } else {
        XCTAssertNil(observed, "nothing committed before the wallet write — step \(step)")
        assertFailure(.notCorrupt, "step \(step)") { try relaunched.discardCorrupt(ownerId: ownerA) }
        XCTAssertEqual(try relaunched.replace(ownerId: ownerA, expectedRevision: 0, contents: empty).revision, 1, "step \(step)")
      }
      let key = try XCTUnwrap(store.items[keyA], "step \(step)")
      let fence = try OfflineWallet.openFenceState(try XCTUnwrap(store.items[fenceA]), ownerId: ownerA, key: key)
      XCTAssertEqual(fence.revision, step == 3 ? 2 : 1, "step \(step)")
    }
  }

  // MARK: - Replay of retired envelopes

  /// Every authentic envelope the owner ever held is put back into the slot
  /// after clear, replace and discard: none may read as current again.
  func testAttack_EveryRetiredAuthenticEnvelopeReplayedIntoTheSlotIsRefused() throws {
    let store = AttackStore()
    let wallet = OfflineWallet(store: store)
    var retired: [(String, Data)] = []

    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [grant(id: "g1")], receipts: []))
    retired.append(("revision 1", try XCTUnwrap(store.items[walletA])))
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 1, contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "r2")]))
    retired.append(("revision 2", try XCTUnwrap(store.items[walletA])))
    try wallet.clear(ownerId: ownerA, expectedRevision: 2)
    retired.append(("tombstone 2", try XCTUnwrap(store.items[walletA])))
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [grant(id: "g3")], receipts: []))
    retired.append(("revision 3", try XCTUnwrap(store.items[walletA])))

    // Corrupt, discard (fence verified: epoch rotates), continue.
    var bytes = try XCTUnwrap(store.items[walletA])
    bytes[bytes.count - 1] ^= 0x01
    store.items[walletA] = bytes
    XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerA), .tampered)
    retired.append(("tombstone 3 (retired epoch)", try XCTUnwrap(store.items[walletA])))
    let current = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [grant(id: "g4")], receipts: []))
    XCTAssertEqual(current.revision, 4)
    let live = try XCTUnwrap(store.items[walletA])

    for (label, envelope) in retired {
      store.items[walletA] = envelope
      assertFailure(.tampered, label) { try wallet.load(ownerId: ownerA) }
      assertFailure(.tampered, label) { try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: empty) }
      assertFailure(.tampered, label) { try wallet.clear(ownerId: ownerA, expectedRevision: 0) }
    }
    store.items[walletA] = live
    XCTAssertEqual(try wallet.load(ownerId: ownerA), current)

    // A tombstone forged at the current revision cannot hide the live wallet.
    store.items[walletA] = retired[2].1
    assertFailure(.tampered, "an old tombstone over live history") { try wallet.load(ownerId: ownerA) }
  }

  // MARK: - Owner isolation

  /// All three of owner A's items copied verbatim under owner B's accounts,
  /// and B's key/fence combined with A's wallet: nothing crosses owners.
  func testAttack_ItemsMovedOrMixedBetweenOwnersNeverVerifyAndNeverTouchTheOtherOwner() throws {
    let store = AttackStore()
    let wallet = OfflineWallet(store: store)
    let a = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [grant(id: "g-a")], receipts: []))
    let b = try wallet.replace(ownerId: ownerB, expectedRevision: 0, contents: OfflineWalletContents(grants: [grant(id: "g-b")], receipts: []))
    let itemsA = [keyA, fenceA, walletA].map { store.items[$0] }
    let accountsB = [
      OfflineWallet.integrityKeyAccount(ownerId: ownerB), OfflineWallet.fenceAccount(ownerId: ownerB),
      OfflineWallet.walletAccount(ownerId: ownerB),
    ]
    let itemsB = accountsB.map { store.items[$0] }

    // Whole triple moved A -> B.
    for (account, item) in zip(accountsB, itemsA) { store.items[account] = item }
    assertFailure(.tampered, "moved triple") { try wallet.load(ownerId: ownerB) }
    assertFailure(.tampered, "moved triple") { try wallet.replace(ownerId: ownerB, expectedRevision: 1, contents: empty) }
    XCTAssertEqual(try wallet.load(ownerId: ownerA), a, "owner A is untouched")
    for (account, item) in zip(accountsB, itemsB) { store.items[account] = item }
    XCTAssertEqual(try wallet.load(ownerId: ownerB), b)

    // Only A's wallet under B's key and fence.
    store.items[accountsB[2]] = itemsA[2]
    assertFailure(.tampered, "foreign wallet under own key") { try wallet.load(ownerId: ownerB) }
    XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerB), .tampered)
    XCTAssertEqual(try wallet.load(ownerId: ownerA), a, "discarding B's corrupt slot never touches A")
    XCTAssertEqual(store.items[keyA], itemsA[0])
    XCTAssertEqual(store.items[fenceA], itemsA[1])
    XCTAssertEqual(store.items[walletA], itemsA[2])

    // Owner aliases are refused before any store access.
    let reads = store.readCount
    for alias in [
      ownerA.uppercased(), ownerA + "\n", " " + ownerA.dropFirst(), String(ownerA.dropLast()) + "G",
      ownerA.replacingOccurrences(of: "-4a2d-", with: "-0a2d-"), ownerA.replacingOccurrences(of: "-9b8e-", with: "-7b8e-"),
      "", "00000000-0000-0000-0000-000000000000",
    ] {
      assertFailure(.invalidOwner, alias) { try wallet.load(ownerId: alias) }
      assertFailure(.invalidOwner, alias) { try wallet.replace(ownerId: alias, expectedRevision: 0, contents: empty) }
      assertFailure(.invalidOwner, alias) { try wallet.clear(ownerId: alias, expectedRevision: 0) }
      assertFailure(.invalidOwner, alias) { try wallet.discardCorrupt(ownerId: alias) }
    }
    XCTAssertEqual(store.readCount, reads, "no store access for a non-canonical owner")
  }

  // MARK: - Boundary values on the bridge

  func testAttack_BridgeRevisionBoundaries() throws {
    XCTAssertEqual(try OfflineWallet.revision(fromBridge: 0), 0)
    XCTAssertEqual(try OfflineWallet.revision(fromBridge: -0.0), 0)
    XCTAssertEqual(try OfflineWallet.revision(fromBridge: 1), 1)
    XCTAssertEqual(try OfflineWallet.revision(fromBridge: safeMaxRevision), 9_007_199_254_740_991)
    XCTAssertEqual(try OfflineWallet.revision(fromBridge: safeMaxRevision - 1), 9_007_199_254_740_990)
    for (label, value) in [
      ("2^53", safeMaxRevision + 1), ("2^53+2", 9_007_199_254_740_994), ("1e300", 1e300), ("-1", -1), ("-0.5", -0.5),
      ("0.5", 0.5), ("1.0000001", 1.0000001), ("nan", Double.nan), ("+inf", Double.infinity), ("-inf", -Double.infinity),
      ("UInt64.max", Double(UInt64.max)), ("smallest subnormal", Double.leastNonzeroMagnitude),
      ("-smallest subnormal", -Double.leastNonzeroMagnitude), ("2^63", 9_223_372_036_854_775_808),
    ] as [(String, Double)] {
      assertFailure(.invalidRevision, label) { try OfflineWallet.revision(fromBridge: value) }
    }
  }

  /// Bridge payload shapes JS could send through `NSDictionary`: wrong types,
  /// missing keys, non-string ids, unknown kinds, `NSNull`, nested junk. Each
  /// must be a typed failure and none may reach the store.
  func testAttack_BridgePayloadTypeConfusionIsTypedAndNeverReachesTheStore() throws {
    let store = AttackStore()
    let wallet = OfflineWallet(store: store)
    let goodGrant: [String: Any] = ["grantId": "g1", "compactJws": grant(id: "g1").compactJws]
    let goodReceipt: [String: Any] = ["receiptId": "r1", "kind": "result", "payloadJson": "{}"]
    let cases: [(String, [String: Any], OfflineWalletFailure)] = [
      ("empty dictionary", [:], .invalidGrant),
      ("grants null", ["grants": NSNull(), "receipts": []], .invalidGrant),
      ("grants string", ["grants": "[]", "receipts": []], .invalidGrant),
      ("grants array of strings", ["grants": ["g1"], "receipts": []], .invalidGrant),
      ("receipts missing", ["grants": []], .invalidReceipt),
      ("receipts dictionary", ["grants": [], "receipts": ["receiptId": "r1"]], .invalidReceipt),
      ("grantId number", ["grants": [["grantId": 1, "compactJws": goodGrant["compactJws"]!]], "receipts": []], .invalidGrant),
      ("compactJws null", ["grants": [["grantId": "g1", "compactJws": NSNull()]], "receipts": []], .invalidGrant),
      ("grant missing jws", ["grants": [["grantId": "g1"]], "receipts": []], .invalidGrant),
      ("kind unknown", ["grants": [], "receipts": [["receiptId": "r1", "kind": "refund", "payloadJson": "{}"]]], .invalidReceipt),
      ("kind wrong case", ["grants": [], "receipts": [["receiptId": "r1", "kind": "Result", "payloadJson": "{}"]]], .invalidReceipt),
      ("kind number", ["grants": [], "receipts": [["receiptId": "r1", "kind": 0, "payloadJson": "{}"]]], .invalidReceipt),
      ("payloadJson object not string", ["grants": [], "receipts": [["receiptId": "r1", "kind": "result", "payloadJson": [:]]]], .invalidReceipt),
      ("payloadJson array text", ["grants": [], "receipts": [["receiptId": "r1", "kind": "result", "payloadJson": "[]"]]], .invalidReceipt),
      ("receiptId empty", ["grants": [], "receipts": [["receiptId": "", "kind": "result", "payloadJson": "{}"]]], .invalidReceipt),
      ("duplicate grants", ["grants": [goodGrant, goodGrant], "receipts": []], .invalidGrant),
      ("duplicate receipts", ["grants": [], "receipts": [goodReceipt, goodReceipt]], .invalidReceipt),
      ("9 grants", ["grants": (0..<9).map { ["grantId": "g\($0)", "compactJws": self.grant(id: "g\($0)").compactJws] }, "receipts": []], .capacityExceeded),
      ("65 receipts", ["grants": [], "receipts": (0..<65).map { ["receiptId": "r\($0)", "kind": "result", "payloadJson": "{}"] }], .capacityExceeded),
    ]
    for (label, payload, expected) in cases {
      assertFailure(expected, label) { try OfflineWalletContents(bridgePayload: payload) }
    }
    XCTAssertEqual(store.readCount, 0)
    XCTAssertTrue(store.writeLog.isEmpty)

    let full = try OfflineWalletContents(bridgePayload: [
      "grants": (0..<8).map { ["grantId": "g\($0)", "compactJws": self.grant(id: "g\($0)").compactJws] },
      "receipts": (0..<64).map { ["receiptId": "r\($0)", "kind": $0 % 2 == 0 ? "result" : "unused_ticket_return", "payloadJson": "{\"i\":\($0)}"] },
    ])
    XCTAssertEqual(full.grants.count, 8)
    XCTAssertEqual(full.receipts.count, 64)
    let stored = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: full)
    XCTAssertEqual(try wallet.load(ownerId: ownerA), stored)
    let roundTrip = try OfflineWalletContents(bridgePayload: [
      "grants": stored.bridgePayload()["grants"] as Any, "receipts": stored.bridgePayload()["receipts"] as Any,
    ])
    XCTAssertEqual(roundTrip, full, "what the bridge hands out parses back into the same contents")
  }

  /// Receipt payloads at the edges of the strict JSON grammar and the byte
  /// limit; a rejected receipt never reaches the store.
  func testAttack_ReceiptPayloadGrammarAndSizeBoundaries() throws {
    let store = AttackStore()
    let wallet = OfflineWallet(store: store)
    let accepted = [
      "{}", " {} ", "\t{\n}\r", "{\"a\":1}", "{\"a\":-0}", "{\"a\":0.5e-3}", "{\"a\":1E+2}", "{\"\":null}", "{\"a\":[[],{},\"\",0,true,false,null]}",
      "{\"a\":\"\\\"\\\\\\/\\b\\f\\n\\r\\t\\u0000\\uD800\\uABCD\"}", "{\"a\":\"\u{7F}\u{2028}\u{2029}\u{FEFF}€😀\"}",
      "{\"a\":1,\"a\":2}", "{\"a\":{\"b\":{\"c\":{\"d\":{}}}}}",
    ]
    for payload in accepted {
      XCTAssertNoThrow(
        try OfflineWallet.validate(OfflineWalletContents(grants: [], receipts: [receipt(id: "r", payloadJson: payload)])), payload)
    }
    let rejected = [
      "", " ", "null", "true", "1", "\"{}\"", "[]", "[{}]", "\u{FEFF}{}", "{}{}", "{},", "{} x", "{\"a\":1}\u{0B}", "{\"a\":1}\u{A0}",
      "{\u{A0}}", "{,}", "{\"a\"}", "{\"a\" 1}", "{\"a\":}", "{\"a\":1,}", "{\"a\":[1,]}", "{\"a\":[,1]}", "{'a':1}", "{a:1}",
      "{\"a\":01}", "{\"a\":1.}", "{\"a\":.5}", "{\"a\":+1}", "{\"a\":-}", "{\"a\":1e}", "{\"a\":1e+}", "{\"a\":0x1}", "{\"a\":Infinity}",
      "{\"a\":NaN}", "{\"a\":tru}", "{\"a\":True}", "{\"a\":nul}", "{\"a\":\"\t\"}", "{\"a\":\"\n\"}", "{\"a\":\"\u{00}\"}", "{\"a\":\"\\x41\"}",
      "{\"a\":\"\\u00zz\"}", "{\"a\":\"\\u123\"}", "{\"a\":\"\\U0041\"}", "{\"a\":\"\\'\"}", "{\"a\":\"unterminated}", "{\"a\":\"\\\"}",
      "{\"a\":1", "{\"a\":[1}", "{\"a\":{]}", "/*c*/{}", "{}//c", "{\"a\":1}}",
    ]
    for payload in rejected {
      assertFailure(.invalidReceipt, payload.debugDescription) {
        try OfflineWallet.validate(OfflineWalletContents(grants: [], receipts: [receipt(id: "r", payloadJson: payload)]))
      }
    }

    // Byte limit: exactly 8192 UTF-8 bytes passes, 8193 fails; multibyte counts by bytes, not characters.
    let filler = String(repeating: "x", count: OfflineWallet.Limits.maxReceiptPayloadBytes - "{\"a\":\"\"}".utf8.count)
    let atLimit = "{\"a\":\"\(filler)\"}"
    XCTAssertEqual(atLimit.utf8.count, OfflineWallet.Limits.maxReceiptPayloadBytes)
    XCTAssertNoThrow(try OfflineWallet.validate(OfflineWalletContents(grants: [], receipts: [receipt(id: "r", payloadJson: atLimit)])))
    assertFailure(.invalidReceipt, "8193 bytes") {
      try OfflineWallet.validate(OfflineWalletContents(grants: [], receipts: [receipt(id: "r", payloadJson: "{\"a\":\"\(filler)x\"}")]))
    }
    let multibyte = "{\"a\":\"\(String(repeating: "€", count: (OfflineWallet.Limits.maxReceiptPayloadBytes - 8) / 3))\"}"
    XCTAssertEqual(multibyte.utf8.count, OfflineWallet.Limits.maxReceiptPayloadBytes)
    XCTAssertNoThrow(try OfflineWallet.validate(OfflineWalletContents(grants: [], receipts: [receipt(id: "r", payloadJson: multibyte)])))
    assertFailure(.invalidReceipt, "8195 bytes of 3-byte scalars") {
      try OfflineWallet.validate(OfflineWalletContents(grants: [], receipts: [receipt(id: "r", payloadJson: multibyte.replacingOccurrences(of: "\"}", with: "€\"}"))]))
    }

    // Nothing above touched the store; a rejected replace does not either.
    assertFailure(.invalidReceipt) {
      try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "r", payloadJson: "[]")]))
    }
    XCTAssertEqual(store.readCount, 0)
    XCTAssertTrue(store.items.isEmpty)
  }

  /// Compact JWS and identifier boundaries: segment counts, padding, the
  /// non-base64url alphabet, per-segment and total byte limits, the canonical
  /// trailing-character rule, and identifier length/alphabet edges.
  func testAttack_GrantJwsAndIdentifierBoundaries() throws {
    let header = String(repeating: "A", count: 1_024)
    let claims = String(repeating: "A", count: 15_272)
    let signature = String(repeating: "A", count: 86)
    let maximal = "\(header).\(claims).\(signature)"
    XCTAssertEqual(maximal.utf8.count, OfflineWallet.Limits.maxGrantJwsBytes)
    XCTAssertNoThrow(try OfflineWallet.validate(OfflineWalletContents(grants: [OfflineStoredGrant(grantId: "g", compactJws: maximal)], receipts: [])))

    let rejectedJws = [
      ("empty", ""), ("two segments", "\(header).\(signature)"), ("four segments", "\(header).\(claims).\(signature)."),
      ("leading dot", ".\(claims).\(signature)"), ("empty claims", "\(header)..\(signature)"),
      ("header 1025", "\(header)A.\(claims).\(signature)"), ("claims 15273", "\(header).\(claims)A.\(signature)"),
      ("signature 85", "\(header).\(claims).\(signature.dropLast())"), ("signature 87", "\(header).\(claims).\(signature)A"),
      ("header 1 char", "A.\(claims).\(signature)"), ("padding", "QQ==.\(claims).\(signature)"),
      ("standard base64 alphabet", "Q+/w.\(claims).\(signature)"), ("whitespace", "QQ .\(claims).\(signature)"),
      ("non-canonical tail %4==2", "QB.\(claims).\(signature)"), ("non-canonical tail %4==3", "QUF.\(claims).\(signature)"),
      ("non-canonical signature tail", "\(header).\(claims).\(signature.dropLast())B"),
      ("length %4==1 header", "QUFBQ.\(claims).\(signature)"), ("unicode digit", "QQ\u{0661}A.\(claims).\(signature)"),
      ("fullwidth A", "\u{FF21}\u{FF21}.\(claims).\(signature)"),
    ]
    for (label, jws) in rejectedJws {
      assertFailure(.invalidGrant, label) {
        try OfflineWallet.validate(OfflineWalletContents(grants: [OfflineStoredGrant(grantId: "g", compactJws: jws)], receipts: []))
      }
    }
    for jws in ["QQ.\(claims).\(signature)", "QUE.\(claims).\(signature)", "QUFB.\(claims).\(signature)", "-_-_.\(claims).\(signature)"] {
      XCTAssertNoThrow(try OfflineWallet.validate(OfflineWalletContents(grants: [OfflineStoredGrant(grantId: "g", compactJws: jws)], receipts: [])), jws)
    }

    let longestId = String(repeating: "a", count: 128)
    XCTAssertNoThrow(try OfflineWallet.validate(OfflineWalletContents(grants: [OfflineStoredGrant(grantId: longestId, compactJws: maximal)], receipts: [])))
    XCTAssertNoThrow(try OfflineWallet.validate(OfflineWalletContents(grants: [], receipts: [receipt(id: "A-Z_a.z:0/9+=")])))
    for (label, id) in [
      ("129", longestId + "a"), ("empty", ""), ("space", "a b"), ("newline", "a\n"), ("unicode letter", "é"), ("emoji", "😀"),
      ("fullwidth digit", "\u{FF11}"), ("combining mark", "a\u{0301}"), ("hash", "a#b"), ("percent", "a%20b"), ("nul", "a\u{00}"),
    ] {
      assertFailure(.invalidGrant, label) {
        try OfflineWallet.validate(OfflineWalletContents(grants: [OfflineStoredGrant(grantId: id, compactJws: maximal)], receipts: []))
      }
      assertFailure(.invalidReceipt, label) {
        try OfflineWallet.validate(OfflineWalletContents(grants: [], receipts: [receipt(id: id)]))
      }
    }

    // Identifier namespaces are independent and case-sensitive; kinds do not de-duplicate.
    XCTAssertNoThrow(
      try OfflineWallet.validate(
        OfflineWalletContents(grants: [OfflineStoredGrant(grantId: "same", compactJws: maximal)], receipts: [receipt(id: "same"), receipt(id: "SAME")])))
    assertFailure(.invalidReceipt, "same id, different kind") {
      try OfflineWallet.validate(
        OfflineWalletContents(grants: [], receipts: [receipt(id: "r", kind: .result), receipt(id: "r", kind: .unusedTicketReturn)]))
    }
  }

  /// The largest wallet the limits allow (8 maximal grants + 64 maximal
  /// receipts) must commit and read back byte-for-byte; one more byte in any
  /// item is refused before any store access.
  func testAttack_MaximalWalletCommitsAndReadsBackAndTheEnvelopeLimitHolds() throws {
    let store = AttackStore()
    let wallet = OfflineWallet(store: store)
    let header = String(repeating: "A", count: 1_024)
    let claims = String(repeating: "A", count: 15_272)
    let signature = String(repeating: "A", count: 86)
    let grants = (0..<OfflineWallet.Limits.maxGrants).map {
      OfflineStoredGrant(grantId: String(repeating: "g", count: 127) + String($0), compactJws: "\(header).\(claims).\(signature)")
    }
    let filler = String(repeating: "x", count: OfflineWallet.Limits.maxReceiptPayloadBytes - "{\"a\":\"\"}".utf8.count)
    let receipts = (0..<OfflineWallet.Limits.maxReceipts).map {
      OfflineStoredReceipt(receiptId: String(repeating: "r", count: 126) + String(format: "%02d", $0), kind: .result, payloadJson: "{\"a\":\"\(filler)\"}")
    }
    let contents = OfflineWalletContents(grants: grants, receipts: receipts)
    let stored = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: contents)
    XCTAssertEqual(stored.contents, contents)
    XCTAssertEqual(try wallet.load(ownerId: ownerA)?.contents, contents)
    XCTAssertLessThanOrEqual(try XCTUnwrap(store.items[walletA]).count, OfflineWallet.Limits.maxEnvelopeBytes)
    XCTAssertEqual(try wallet.replace(ownerId: ownerA, expectedRevision: 1, contents: contents).revision, 2)
    try wallet.clear(ownerId: ownerA, expectedRevision: 2)
    XCTAssertNil(try wallet.load(ownerId: ownerA))
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
      XCTFail("expected OfflineWalletError(\(expected)) but got \(error) \(context)", file: file, line: line)
      return nil
    }
  }

  private func grant(id: String) -> OfflineStoredGrant {
    let header = base64url("{\"alg\":\"ES256\",\"typ\":\"pickle-offline-execution-grant+jwt\",\"kid\":\"kid-1\"}")
    let claims = base64url("{\"jti\":\"\(id)\",\"aud\":\"urn:pickle-sensei:offline-execution:v1\"}")
    return OfflineStoredGrant(grantId: id, compactJws: [header, claims, String(repeating: "A", count: 86)].joined(separator: "."))
  }

  private func receipt(id: String, kind: OfflineStoredReceiptKind = .result, payloadJson: String? = nil) -> OfflineStoredReceipt {
    OfflineStoredReceipt(
      receiptId: id, kind: kind,
      payloadJson: payloadJson ?? "{\"schemaVersion\":\"offline-result-receipt-v1\",\"receiptId\":\"\(id)\"}")
  }

  private func base64url(_ text: String) -> String {
    Data(text.utf8).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}

/// In-memory secure store with fault and crash injection at every step: a
/// hook that throws from `afterWrite` / `afterDelete` models the process
/// dying right after that store mutation landed.
private final class AttackStore: OfflineWalletSecureStore {
  var items: [String: Data] = [:]
  var readCount = 0
  var writeLog: [String] = []
  var deleteLog: [String] = []
  var readFault: ((String, Int) throws -> Void)?
  var beforeWrite: ((String) throws -> Void)?
  var afterWrite: ((String) throws -> Void)?
  var afterDelete: ((String) throws -> Void)?

  func read(account: String) throws -> Data? {
    readCount += 1
    try readFault?(account, readCount)
    return items[account]
  }

  func write(account: String, data: Data, ifUnchangedFrom previous: Data?) throws -> Bool {
    try beforeWrite?(account)
    guard items[account] == previous else { return false }
    items[account] = data
    writeLog.append(account)
    try afterWrite?(account)
    return true
  }

  func delete(account: String, ifUnchangedFrom previous: Data) throws -> Bool {
    guard items[account] == previous else { return false }
    items.removeValue(forKey: account)
    deleteLog.append(account)
    try afterDelete?(account)
    return true
  }
}
