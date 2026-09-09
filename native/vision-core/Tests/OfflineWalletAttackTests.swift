import Foundation
import XCTest

@testable import PickleVisionCore

/// Adversarial matrix for W05-01 (candidate 6cdd3ab9). Every test here is an
/// attack at a failure boundary the candidate's own suite does not pin:
/// replay of the envelope `clear` deleted, silent reset of rollback
/// protection when the fence item is lost or corrupt, a vanished wallet
/// reading as an empty one, crash-at-every-write recovery, cross-owner
/// interleaving, corrupt-byte matrices, bridge revision boundaries and the
/// JS `JSON.parse` parity corpus shared with
/// `apps/mobile/__tests__/offlineWalletAttack.test.ts`.
///
/// Tests whose name starts with `testBreak` are EXPECTED TO FAIL on the
/// candidate: their assertions state the behaviour the module documents
/// (`clear`: "the deleted envelope reads as a rollback if it ever reappears";
/// header: "the fence survives `clear`, so revisions never restart for an
/// owner on this installation"). Tests named
/// `testAttack…` passed against the candidate and are recorded as attacks
/// that did not break anything.
final class OfflineWalletAttackTests: XCTestCase {
  private let ownerA = "0f9d5a7e-3c1b-4a2d-9b8e-1c2d3e4f5a6b"
  private let ownerB = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
  private let safeMaxRevision: UInt64 = 9_007_199_254_740_991

  // MARK: - Replay / rollback

  /// Attack 1 — replay of the exact envelope `clear` deleted.
  /// `clear(N)` leaves the fence at N and deletes wallet N. Re-inserting that
  /// deleted envelope (spent grants, already-submitted receipts) satisfies
  /// `payload.revision >= fence` (N >= N) and reads as CURRENT state, although
  /// `clear`'s own contract says "the deleted envelope reads as a rollback if
  /// it ever reappears".
  func testBreak_EnvelopeDeletedByClearReplaysAsCurrentState() throws {
    let store = AttackWalletStore()
    let wallet = OfflineWallet(store: store)
    let account = OfflineWallet.walletAccount(ownerId: ownerA)
    let spent = grant(id: "grant-spent-offline")
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [spent], receipts: []))
    let two = try wallet.replace(
      ownerId: ownerA, expectedRevision: 1,
      contents: OfflineWalletContents(grants: [spent], receipts: [receipt(id: "receipt-submitted")])
    )
    XCTAssertEqual(two.revision, 2)
    let deletedEnvelope = try XCTUnwrap(store.items[account])

    try wallet.clear(ownerId: ownerA, expectedRevision: 2)
    XCTAssertNil(try wallet.load(ownerId: ownerA))

    store.items[account] = deletedEnvelope
    let replayed = assertFailure(.tampered, "the envelope clear deleted must read as a rollback") {
      try wallet.load(ownerId: ownerA)
    }
    XCTAssertTrue(replayed?.detail.contains("rolled back") ?? false, replayed?.detail ?? "loaded without failure")
    assertFailure(.tampered, "a replayed spent wallet must not be a valid base for the next write") {
      try wallet.replace(ownerId: ownerA, expectedRevision: 2, contents: OfflineWalletContents(grants: [], receipts: []))
    }
  }

  /// Attack 1b — the same replay on the crash path `clear` documents: fence
  /// lagging at 1, wallet at 2; `clear` commits the fence to 2 then deletes.
  /// The deleted revision-2 envelope still reads as current afterwards.
  func testBreak_EnvelopeDeletedByClearAfterLaggingFenceReplaysAsCurrentState() throws {
    let store = AttackWalletStore()
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
    try relaunched.clear(ownerId: ownerA, expectedRevision: 2)
    let key = try XCTUnwrap(store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerA)])
    XCTAssertEqual(try OfflineWallet.openFence(try XCTUnwrap(store.items[fenceAccount]), ownerId: ownerA, key: key), 2)

    store.items[account] = revisionTwoBytes
    assertFailure(.tampered, "the pre-clear envelope must not replay as current state without an intervening replace") {
      try relaunched.load(ownerId: ownerA)
    }
  }

  /// Attack 2 — rollback protection resets when the fence ITEM is lost while
  /// the integrity key stays. Deleting fence + wallet (no forging, no key)
  /// leaves "healthy absent" state; the next replace mints fence 0 and wallet
  /// revision 1 under the SAME key, so every older authentic envelope of this
  /// owner (revision >= 1) verifies again and replays as current state.
  func testBreak_LosingTheFenceItemResetsRollbackProtectionUnderTheSameKey() throws {
    let store = AttackWalletStore()
    let wallet = OfflineWallet(store: store)
    let account = OfflineWallet.walletAccount(ownerId: ownerA)
    let fenceAccount = OfflineWallet.fenceAccount(ownerId: ownerA)
    let keyAccount = OfflineWallet.integrityKeyAccount(ownerId: ownerA)
    let spent = grant(id: "grant-spent-offline")
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [spent], receipts: []))
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 1, contents: OfflineWalletContents(grants: [spent], receipts: []))
    let three = try wallet.replace(ownerId: ownerA, expectedRevision: 2, contents: OfflineWalletContents(grants: [spent], receipts: []))
    XCTAssertEqual(three.revision, 3)
    let envelopeThree = try XCTUnwrap(store.items[account])
    let originalKey = try XCTUnwrap(store.items[keyAccount])
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 3, contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-spend")]))

    // Attacker (or a Keychain fault) removes the fence and wallet items only.
    store.items.removeValue(forKey: fenceAccount)
    store.items.removeValue(forKey: account)

    // Either the loss is visible as a fault, or the next first write must not
    // continue under a key that still verifies every earlier envelope.
    var visibleFault = false
    do {
      let loaded = try wallet.load(ownerId: ownerA)
      XCTAssertNil(loaded)
    } catch {
      visibleFault = true
    }
    if !visibleFault {
      let next = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-new")]))
      XCTAssertNotEqual(
        store.items[keyAccount], originalKey,
        "a first write after the fence vanished must mint a new integrity key, or revisions restart at \(next.revision) under the old one")
    }
    store.items[account] = envelopeThree
    assertFailure(.tampered, "an older authentic envelope must never verify again after the fence was lost") {
      try wallet.load(ownerId: ownerA)
    }
  }

  /// Attack 2b — the same reset through the supported recovery path: one
  /// flipped fence byte -> `tampered` -> `discardCorrupt` deletes wallet and
  /// fence but keeps the key -> replace(0) writes revision 1 -> an older
  /// authentic envelope (revision 3) verifies again and replaces the new
  /// wallet (its unsent receipt) as if it were current.
  func testBreak_DiscardingACorruptFenceKeepsTheKeyThatVerifiesOlderEnvelopes() throws {
    let store = AttackWalletStore()
    let wallet = OfflineWallet(store: store)
    let account = OfflineWallet.walletAccount(ownerId: ownerA)
    let fenceAccount = OfflineWallet.fenceAccount(ownerId: ownerA)
    let keyAccount = OfflineWallet.integrityKeyAccount(ownerId: ownerA)
    let spent = grant(id: "grant-spent-offline")
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [spent], receipts: []))
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 1, contents: OfflineWalletContents(grants: [spent], receipts: []))
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 2, contents: OfflineWalletContents(grants: [spent], receipts: []))
    let envelopeThree = try XCTUnwrap(store.items[account])
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 3, contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-spend")]))
    let originalKey = try XCTUnwrap(store.items[keyAccount])

    var flipped = try XCTUnwrap(store.items[fenceAccount])
    flipped[flipped.index(before: flipped.endIndex)] ^= 0x01
    store.items[fenceAccount] = flipped
    assertFailure(.tampered) { try wallet.load(ownerId: ownerA) }
    XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerA), .tampered)
    XCTAssertNil(store.items[fenceAccount])

    let fresh = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-new")]))
    XCTAssertNotEqual(
      store.items[keyAccount], originalKey,
      "discarding an unverifiable fence must retire the key, or revision \(fresh.revision) restarts below already-issued envelopes")

    store.items[account] = envelopeThree
    assertFailure(.tampered, "an older authentic envelope must not replace the fresh wallet after fence recovery") {
      try wallet.load(ownerId: ownerA)
    }
  }

  // MARK: - Vanished wallet

  /// Attack 3 — a wallet that vanished without `clear` (Keychain fault or
  /// attacker deleting one item) is indistinguishable from a cleared one:
  /// key + fence N + no wallet reads as "nothing stored", so unsent receipts
  /// disappear with no typed signal and the next write proceeds as if the
  /// owner had reconciled.
  func testBreak_WalletVanishingWithoutClearReadsAsEmptyNotAsAFault() throws {
    let store = AttackWalletStore()
    let wallet = OfflineWallet(store: store)
    let account = OfflineWallet.walletAccount(ownerId: ownerA)
    _ = try wallet.replace(
      ownerId: ownerA, expectedRevision: 0,
      contents: OfflineWalletContents(grants: [grant(id: "g")], receipts: [receipt(id: "receipt-unsent")])
    )
    store.items.removeValue(forKey: account)

    var outcome = "load returned nil (empty wallet)"
    do {
      if let snapshot = try wallet.load(ownerId: ownerA) {
        outcome = "load returned revision \(snapshot.revision)"
      }
    } catch let error as OfflineWalletError {
      outcome = "typed \(error.failure)"
    }
    XCTAssertNotEqual(outcome, "load returned nil (empty wallet)", "a wallet that disappeared without clear must not read as empty history")
    do {
      let written = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
      XCTFail("writing over a vanished wallet must be refused until the owner is reconciled; wrote revision \(written.revision)")
    } catch let error as OfflineWalletError {
      XCTAssertTrue(error.failure.isUnreadableState, "\(error.failure)")
    }
  }

  // MARK: - Process death at every write

  /// Attack 4 — crash immediately after each persisted write of the first
  /// replace (key, fence 0, wallet 1, fence 1), of a second replace (wallet 2,
  /// fence 2) and of a clear over a lagging fence (fence, delete). After every
  /// crash a relaunched instance must read either the pre- or the post-state
  /// (never a fault, never a trap), the committed receipt must survive, and
  /// the next replace must continue the revision sequence strictly upward.
  func testAttack_CrashAfterEveryWriteStepRecoversWithoutLosingCommittedState() throws {
    let unsent = receipt(id: "receipt-unsent")
    for crashAt in 1...4 {
      let store = AttackWalletStore()
      let crashing = OfflineWallet(store: store)
      store.crashAfterWrite(crashAt)
      XCTAssertThrowsError(
        try crashing.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [unsent])),
        "first replace, crash after write \(crashAt)")
      store.clearCrash()

      let relaunched = OfflineWallet(store: store)
      let recovered = try relaunched.load(ownerId: ownerA)
      if crashAt >= 3 {
        XCTAssertEqual(recovered?.revision, 1, "wallet write is the commit point (crash after write \(crashAt))")
        XCTAssertEqual(recovered?.contents.receipts, [unsent])
        let next = try relaunched.replace(ownerId: ownerA, expectedRevision: 1, contents: OfflineWalletContents(grants: [], receipts: [unsent, receipt(id: "receipt-2")]))
        XCTAssertEqual(next.revision, 2)
      } else {
        XCTAssertNil(recovered, "nothing committed yet (crash after write \(crashAt))")
        let next = try relaunched.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [unsent]))
        XCTAssertEqual(next.revision, 1)
      }
      XCTAssertEqual(store.writesByAccount[OfflineWallet.integrityKeyAccount(ownerId: ownerA)], 1, "exactly one key per owner")
      XCTAssertEqual(try relaunched.load(ownerId: ownerA)?.contents.receipts.first, unsent)
    }

    for crashAt in 1...2 {
      let store = AttackWalletStore()
      let wallet = OfflineWallet(store: store)
      _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [unsent]))
      store.crashAfterWrite(crashAt)
      XCTAssertThrowsError(
        try wallet.replace(ownerId: ownerA, expectedRevision: 1, contents: OfflineWalletContents(grants: [grant(id: "g")], receipts: [unsent])),
        "second replace, crash after write \(crashAt)")
      store.clearCrash()
      let relaunched = OfflineWallet(store: store)
      let recovered = try XCTUnwrap(try relaunched.load(ownerId: ownerA))
      XCTAssertEqual(recovered.revision, 2, "wallet write committed before the crash (write \(crashAt))")
      XCTAssertEqual(recovered.contents.receipts, [unsent])
      let next = try relaunched.replace(ownerId: ownerA, expectedRevision: 2, contents: OfflineWalletContents(grants: [], receipts: []))
      XCTAssertEqual(next.revision, 3)
      let key = try XCTUnwrap(store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerA)])
      XCTAssertEqual(try OfflineWallet.openFence(try XCTUnwrap(store.items[OfflineWallet.fenceAccount(ownerId: ownerA)]), ownerId: ownerA, key: key), 3)
    }

    // clear over a lagging fence: crash after the fence commit, before delete.
    let store = AttackWalletStore()
    let wallet = OfflineWallet(store: store)
    let fenceAccount = OfflineWallet.fenceAccount(ownerId: ownerA)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [unsent]))
    let fenceAtOne = try XCTUnwrap(store.items[fenceAccount])
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 1, contents: OfflineWalletContents(grants: [], receipts: [unsent]))
    store.items[fenceAccount] = fenceAtOne
    store.crashAfterWrite(1)
    XCTAssertThrowsError(try wallet.clear(ownerId: ownerA, expectedRevision: 2))
    store.clearCrash()
    let relaunched = OfflineWallet(store: store)
    XCTAssertEqual(try relaunched.load(ownerId: ownerA)?.revision, 2, "an interrupted clear leaves the wallet readable")
    try relaunched.clear(ownerId: ownerA, expectedRevision: 2)
    XCTAssertNil(try relaunched.load(ownerId: ownerA))
    XCTAssertEqual(try relaunched.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [])).revision, 3)
  }

  // MARK: - Interleaved account switch

  /// Attack 5 — owner B's first write lands between each of owner A's three
  /// reads during A's replace / clear / load / discardCorrupt. A's outcome
  /// must be exactly what it would be without B, and B's wallet must survive.
  func testAttack_AnotherOwnersFirstWriteBetweenReadsNeverLeaksAcrossOwners() throws {
    let triggers = [
      OfflineWallet.integrityKeyAccount(ownerId: ownerA),
      OfflineWallet.fenceAccount(ownerId: ownerA),
      OfflineWallet.walletAccount(ownerId: ownerA),
    ]
    for trigger in triggers {
      let store = AttackWalletStore()
      let a = OfflineWallet(store: store)
      let b = OfflineWallet(store: store)
      _ = try a.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [grant(id: "grant-a")], receipts: []))

      var fired = false
      store.onRead = { [ownerB] account in
        guard !fired, account == trigger else { return }
        fired = true
        _ = try b.replace(ownerId: ownerB, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [self.receipt(id: "receipt-b")]))
      }
      let two = try a.replace(ownerId: ownerA, expectedRevision: 1, contents: OfflineWalletContents(grants: [grant(id: "grant-a")], receipts: [receipt(id: "receipt-a")]))
      XCTAssertTrue(fired, trigger)
      XCTAssertEqual(two.revision, 2, trigger)
      store.onRead = nil

      let loadedA = try XCTUnwrap(try a.load(ownerId: ownerA), trigger)
      XCTAssertEqual(loadedA.ownerId, ownerA)
      XCTAssertEqual(loadedA.contents.receipts.map(\.receiptId), ["receipt-a"], trigger)
      let loadedB = try XCTUnwrap(try b.load(ownerId: ownerB), trigger)
      XCTAssertEqual(loadedB.ownerId, ownerB)
      XCTAssertEqual(loadedB.revision, 1, trigger)
      XCTAssertEqual(loadedB.contents.receipts.map(\.receiptId), ["receipt-b"], trigger)
      XCTAssertNotEqual(
        store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerA)],
        store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerB)], trigger)

      fired = false
      store.onRead = { [ownerB] account in
        guard !fired, account == trigger else { return }
        fired = true
        try b.clear(ownerId: ownerB, expectedRevision: 1)
      }
      assertFailure(.notCorrupt, trigger) { try a.discardCorrupt(ownerId: ownerA) }
      XCTAssertTrue(fired, trigger)
      store.onRead = nil
      XCTAssertEqual(try a.load(ownerId: ownerA), loadedA, "A untouched by B's clear — \(trigger)")
      XCTAssertNil(try b.load(ownerId: ownerB), trigger)
      XCTAssertEqual(store.items.count, 5, "A: key, fence, wallet; B: key, fence — \(trigger)")
    }
  }

  // MARK: - Corrupt / partial persisted state matrix

  /// Attack 6 — every item x every byte-level mutation. Each must be a typed
  /// unreadable failure (never a trap, never a successful read of altered
  /// contents), `discardCorrupt` must return the same failure, and the
  /// original grants/receipts must never resurface as current state.
  func testAttack_CorruptByteMatrixIsAlwaysTypedAndNeverReadsAlteredContents() throws {
    let accounts = [
      ("key", OfflineWallet.integrityKeyAccount(ownerId: ownerA)),
      ("fence", OfflineWallet.fenceAccount(ownerId: ownerA)),
      ("wallet", OfflineWallet.walletAccount(ownerId: ownerA)),
    ]
    let mutations: [(String, (Data) -> Data)] = [
      ("empty", { _ in Data() }),
      ("one byte", { _ in Data([0x01]) }),
      ("header only", { Data($0.prefix(33)) }),
      ("truncated tail", { Data($0.dropLast()) }),
      ("appended byte", { $0 + Data([0x00]) }),
      ("prepended byte", { Data([0x01]) + $0 }),
      ("version 0", { var d = $0; if !d.isEmpty { d[d.startIndex] = 0 }; return d }),
      ("version 255", { var d = $0; if !d.isEmpty { d[d.startIndex] = 255 }; return d }),
      ("first tag byte", { var d = $0; if d.count > 1 { d[d.startIndex + 1] ^= 0x80 }; return d }),
      ("last tag byte", { var d = $0; if d.count > 32 { d[d.startIndex + 32] ^= 0x01 }; return d }),
      ("first payload byte", { var d = $0; if d.count > 33 { d[d.startIndex + 33] ^= 0x01 }; return d }),
      ("last payload byte", { var d = $0; d[d.index(before: d.endIndex)] ^= 0x01; return d }),
      ("all zero same length", { Data(repeating: 0, count: $0.count) }),
    ]
    for (itemName, account) in accounts {
      for (mutationName, mutate) in mutations {
        let context = "\(itemName) / \(mutationName)"
        let store = AttackWalletStore()
        let wallet = OfflineWallet(store: store)
        _ = try wallet.replace(
          ownerId: ownerA, expectedRevision: 0,
          contents: OfflineWalletContents(grants: [grant(id: "grant-original")], receipts: [receipt(id: "receipt-original")])
        )
        let healthy = store.items
        let original = try XCTUnwrap(healthy[account])
        let mutated = mutate(original)
        if mutated == original { continue }
        store.items[account] = mutated

        var loadFailure: OfflineWalletFailure?
        do {
          let loaded = try wallet.load(ownerId: ownerA)
          XCTAssertNil(loaded, "mutated \(context) must never load as current state")
          XCTFail("mutated \(context) loaded (nil) instead of failing typed")
        } catch let error as OfflineWalletError {
          loadFailure = error.failure
          XCTAssertTrue(error.failure.isUnreadableState, "\(context): \(error.failure)")
        }
        assertFailure(loadFailure ?? .tampered, "replace over \(context)") {
          try wallet.replace(ownerId: ownerA, expectedRevision: 1, contents: OfflineWalletContents(grants: [], receipts: []))
        }
        assertFailure(loadFailure ?? .tampered, "clear over \(context)") { try wallet.clear(ownerId: ownerA, expectedRevision: 1) }
        XCTAssertEqual(store.items[account], mutated, "refused operations write nothing — \(context)")
        XCTAssertEqual(Optional(try wallet.discardCorrupt(ownerId: ownerA)), loadFailure, context)
        XCTAssertNil(store.items[OfflineWallet.walletAccount(ownerId: ownerA)], "wallet gone after discard — \(context)")
        XCTAssertNil(try wallet.load(ownerId: ownerA), context)
        let fresh = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
        XCTAssertTrue(fresh.contents.grants.isEmpty && fresh.contents.receipts.isEmpty, context)
        XCTAssertGreaterThanOrEqual(fresh.revision, 1, context)
      }
    }
  }

  /// Attack 6b — swap items between slots of the same owner and between
  /// owners (all three of A's items into B's slots, A's key alone into B's
  /// slot). Nothing may verify under the wrong account.
  func testAttack_SwappedAndCrossOwnerItemsNeverVerify() throws {
    let store = AttackWalletStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(
      ownerId: ownerA, expectedRevision: 0,
      contents: OfflineWalletContents(grants: [grant(id: "grant-a")], receipts: [receipt(id: "receipt-a")])
    )
    let healthy = store.items
    let keyA = OfflineWallet.integrityKeyAccount(ownerId: ownerA)
    let fenceA = OfflineWallet.fenceAccount(ownerId: ownerA)
    let walletA = OfflineWallet.walletAccount(ownerId: ownerA)

    store.items[fenceA] = healthy[walletA]
    store.items[walletA] = healthy[fenceA]
    assertFailure(.tampered, "wallet <-> fence swap") { try wallet.load(ownerId: ownerA) }
    store.items = healthy

    for (name, slotB) in [("all of A into B", true), ("A's key only into B", false)] {
      store.items = healthy
      store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerB)] = healthy[keyA]
      if slotB {
        store.items[OfflineWallet.fenceAccount(ownerId: ownerB)] = healthy[fenceA]
        store.items[OfflineWallet.walletAccount(ownerId: ownerB)] = healthy[walletA]
        assertFailure(.tampered, name) { try wallet.load(ownerId: ownerB) }
        XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerB), .tampered, name)
        XCTAssertNil(store.items[OfflineWallet.walletAccount(ownerId: ownerB)], name)
        XCTAssertNil(store.items[OfflineWallet.fenceAccount(ownerId: ownerB)], "an unverifiable fence goes — \(name)")
      } else {
        XCTAssertNil(try wallet.load(ownerId: ownerB), name)
      }
      let b = try wallet.replace(ownerId: ownerB, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-b")]))
      XCTAssertEqual(b.ownerId, ownerB, name)
      XCTAssertEqual(try XCTUnwrap(try wallet.load(ownerId: ownerA)).contents.grants.map(\.grantId), ["grant-a"], "A intact — \(name)")
      XCTAssertEqual(try XCTUnwrap(try wallet.load(ownerId: ownerB)).contents.receipts.map(\.receiptId), ["receipt-b"], name)
      // B's wallet sealed under A's key must still not verify in A's slot.
      store.items[walletA] = store.items[OfflineWallet.walletAccount(ownerId: ownerB)]
      assertFailure(.tampered, "B's wallet in A's slot — \(name)") { try wallet.load(ownerId: ownerA) }
    }
  }

  // MARK: - Boundary values

  /// Attack 7 — bridge revision doubles at the representable edges: signed
  /// zero, subnormals, 2^52 + 0.5, 2^53 - 1 (max), 2^53, nextUp/nextDown,
  /// huge, NaN, infinities. Only exact non-negative safe integers pass.
  func testAttack_BridgeRevisionEdgeDoubles() throws {
    let maxDouble = Double(safeMaxRevision)
    let accepted: [(Double, UInt64)] = [
      (0, 0), (-0.0, 0), (1, 1), (4_503_599_627_370_496, 4_503_599_627_370_496),
      (maxDouble, safeMaxRevision), (maxDouble.nextDown, safeMaxRevision - 1),
    ]
    for (value, expected) in accepted {
      XCTAssertEqual(try OfflineWallet.revision(fromBridge: value), expected, "\(value)")
    }
    let rejected: [Double] = [
      -1, -0.5, 0.5, 4_503_599_627_370_495.5, maxDouble.nextUp, 9_007_199_254_740_992,
      1e300, -1e300, .leastNonzeroMagnitude, -.leastNonzeroMagnitude, .leastNormalMagnitude,
      .nan, .signalingNaN, .infinity, -.infinity, Double(UInt64.max), Double(Int64.min),
    ]
    for value in rejected {
      assertFailure(.invalidRevision, "\(value)") { try OfflineWallet.revision(fromBridge: value) }
    }
  }

  /// Attack 8 — size limits at exactly the edge, with the escaping that
  /// doubles inside the sealed envelope (`\n` whitespace, quotes,
  /// backslashes and slashes), and one byte over each limit.
  func testAttack_ByteLimitsAtTheEdgeWithWorstCaseEscaping() throws {
    let maxPayload = OfflineWallet.Limits.maxReceiptPayloadBytes
    func padded(_ prefix: String, _ filler: String, _ suffix: String, to bytes: Int) -> String {
      let fillerBytes = filler.utf8.count
      let room = bytes - prefix.utf8.count - suffix.utf8.count
      precondition(room >= 0 && room % fillerBytes == 0)
      return prefix + String(repeating: filler, count: room / fillerBytes) + suffix
    }
    let edgePayloads = [
      padded("{\"a\":1", "\n", "}", to: maxPayload),
      padded("{\"k\":\"", "\\\"", "\"}", to: maxPayload),
      padded("{\"k\":\"", "\\\\", "\"}", to: maxPayload),
      padded("{\"k\":\"", "/", "\"}", to: maxPayload),
      padded("{\"k\":\"", "\u{7F}", "\"}", to: maxPayload),
      padded("{\"k\":\"", "\u{E9}", "\"}", to: maxPayload),
      padded("{\"k\":\"", "😀", "\"}", to: maxPayload),
      padded("{\"k\":\"", "\\u0000", "\"}", to: maxPayload),
    ]
    for payload in edgePayloads {
      XCTAssertLessThanOrEqual(payload.utf8.count, maxPayload)
      XCTAssertTrue(OfflineWalletShape.isJsonObject(payload, maxBytes: maxPayload), String(payload.prefix(24)))
      XCTAssertFalse(OfflineWalletShape.isJsonObject(payload, maxBytes: payload.utf8.count - 1), "one byte over")
    }
    let overByOne = padded("{\"a\":1", "\n", "}", to: maxPayload + 1)
    assertFailure(.invalidReceipt, "8193-byte payload") {
      try OfflineWallet.validate(OfflineWalletContents(grants: [], receipts: [receipt(id: "r", payloadJson: overByOne)]))
    }

    // A full wallet of edge receipts plus maximal grants must still seal.
    let store = AttackWalletStore()
    let wallet = OfflineWallet(store: store)
    let uniqueReceipts = (0..<OfflineWallet.Limits.maxReceipts).map { index in
      OfflineStoredReceipt(
        receiptId: String(repeating: "/", count: 128 - String(index).count) + String(index),
        kind: index % 2 == 0 ? .result : .unusedTicketReturn,
        payloadJson: edgePayloads[index % edgePayloads.count]
      )
    }
    let grants = (0..<OfflineWallet.Limits.maxGrants).map(maximalGrant(index:))
    let full = OfflineWalletContents(grants: grants, receipts: uniqueReceipts)
    XCTAssertNoThrow(try OfflineWallet.validate(full))
    let one = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: full)
    XCTAssertEqual(try wallet.load(ownerId: ownerA), one)
    XCTAssertLessThanOrEqual(store.items[OfflineWallet.walletAccount(ownerId: ownerA)]?.count ?? .max, OfflineWallet.Limits.maxEnvelopeBytes)
    let two = try wallet.replace(ownerId: ownerA, expectedRevision: 1, contents: full)
    XCTAssertEqual(two.revision, 2)
    try wallet.clear(ownerId: ownerA, expectedRevision: 2)
    XCTAssertNil(try wallet.load(ownerId: ownerA))

    // Identifier and JWS one-over boundaries.
    assertFailure(.invalidReceipt, "129-scalar receiptId") {
      try OfflineWallet.validate(OfflineWalletContents(grants: [], receipts: [receipt(id: String(repeating: "a", count: 129))]))
    }
    assertFailure(.invalidGrant, "129-scalar grantId") {
      try OfflineWallet.validate(OfflineWalletContents(grants: [OfflineStoredGrant(grantId: String(repeating: "a", count: 129), compactJws: grant(id: "g").compactJws)], receipts: []))
    }
    let maximal = maximalGrant(index: 0)
    XCTAssertEqual(maximal.compactJws.utf8.count, OfflineWallet.Limits.maxGrantJwsBytes)
    assertFailure(.invalidGrant, "JWS one byte over via a 4-char longer header") {
      let segments = maximal.compactJws.split(separator: ".", omittingEmptySubsequences: false)
      let jws = [String(segments[0]) + "AAAA", String(segments[1]), String(segments[2])].joined(separator: ".")
      try OfflineWallet.validate(OfflineWalletContents(grants: [OfflineStoredGrant(grantId: "g", compactJws: jws)], receipts: []))
    }
    // Bridge round trip of the full wallet keeps every byte.
    let roundTripped = try OfflineWalletContents(bridgePayload: one.bridgePayload())
    XCTAssertEqual(roundTripped, full)
  }

  // MARK: - JSON parity corpus (mirrored in offlineWalletAttack.test.ts)

  /// Attack 9 — the native strict scanner must give exactly the verdict
  /// `JSON.parse` gives for the same text (object => accepted). The corpus is
  /// duplicated byte-for-byte in the Jest attack file; a divergence on either
  /// side is a wallet native commits that JS cannot read, or vice versa.
  func testAttack_StrictJsonScannerMatchesJsonParseCorpus() {
    for (text, expected) in OfflineWalletAttackJsonCorpus.cases {
      XCTAssertEqual(
        OfflineWalletShape.isJsonObject(text, maxBytes: OfflineWallet.Limits.maxReceiptPayloadBytes), expected,
        "corpus case: \(text.debugDescription)")
    }
    let deep = "{\"a\":" + String(repeating: "[", count: 4_000) + String(repeating: "]", count: 4_000) + "}"
    XCTAssertTrue(OfflineWalletShape.isJsonObject(deep, maxBytes: OfflineWallet.Limits.maxReceiptPayloadBytes), "4000-deep nesting")
    let deepObjects = String(repeating: "{\"a\":", count: 1_000) + "1" + String(repeating: "}", count: 1_000)
    XCTAssertTrue(OfflineWalletShape.isJsonObject(deepObjects, maxBytes: OfflineWallet.Limits.maxReceiptPayloadBytes), "1000-deep objects")
    let unbalanced = "{\"a\":" + String(repeating: "[", count: 4_000) + String(repeating: "]", count: 3_999) + "}"
    XCTAssertFalse(OfflineWalletShape.isJsonObject(unbalanced, maxBytes: OfflineWallet.Limits.maxReceiptPayloadBytes), "unbalanced deep nesting")
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

  private func receipt(id: String, kind: OfflineStoredReceiptKind = .result, payloadJson: String? = nil) -> OfflineStoredReceipt {
    OfflineStoredReceipt(
      receiptId: id,
      kind: kind,
      payloadJson: payloadJson ?? "{\"schemaVersion\":\"offline-result-receipt-v1\",\"receiptId\":\"\(id)\"}"
    )
  }

  private func base64url(_ text: String) -> String {
    Data(text.utf8).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}

/// Shared with `apps/mobile/__tests__/offlineWalletAttack.test.ts` — keep the
/// two lists identical (same order, same texts, same verdicts).
enum OfflineWalletAttackJsonCorpus {
  static let cases: [(String, Bool)] = [
    ("{}", true),
    (" {} ", true),
    ("\t\n\r {}", true),
    ("{ }", true),
    ("{\"a\":1}", true),
    ("{\"a\":1}\n", true),
    ("{\"\":1}", true),
    ("{\"a\":1,\"a\":2}", true),
    ("{\"__proto__\":1}", true),
    ("{\"a\":-0}", true),
    ("{\"a\":1e5}", true),
    ("{\"a\":1E+5}", true),
    ("{\"a\":-1.5e-3}", true),
    ("{\"a\":1.0}", true),
    ("{\"a\":1e999}", true),
    ("{\"a\":true,\"b\":false,\"c\":null}", true),
    ("{\"a\":[]}", true),
    ("{\"a\":{}}", true),
    ("{\"a\":[1,{\"b\":null}]}", true),
    ("{\"a\":\"\\u00e9\"}", true),
    ("{\"a\":\"\\ud800\"}", true),
    ("{\"a\":\"\\ud83d\\ude00\"}", true),
    ("{\"a\":\"😀\"}", true),
    ("{\"a\":\"\\/\"}", true),
    ("{\"a\":\"\\b\\f\\n\\r\\t\\\"\\\\\"}", true),
    ("{\"a\":\"\\u0000\"}", true),
    ("{\"a\":\"\u{7F}\"}", true),
    ("{\"a\":\"\u{2028}\u{2029}\"}", true),
    ("\u{FEFF}{}", false),
    ("{\"a\":1,}", false),
    ("[1]", false),
    ("[]", false),
    ("null", false),
    ("\"text\"", false),
    ("1", false),
    ("", false),
    (" ", false),
    ("{", false),
    ("}", false),
    ("{\"a\":01}", false),
    ("{\"a\":1.}", false),
    ("{\"a\":.5}", false),
    ("{\"a\":-}", false),
    ("{\"a\":+1}", false),
    ("{\"a\":0x10}", false),
    ("{\"a\":1e}", false),
    ("{\"a\":NaN}", false),
    ("{\"a\":Infinity}", false),
    ("{\"a\":tru}", false),
    ("{\"a\":True}", false),
    ("{\"a\":nul}", false),
    ("{a:1}", false),
    ("{'a':1}", false),
    ("{\"a\":'1'}", false),
    ("{\"a\":1}//c", false),
    ("{\"a\":1}/*c*/", false),
    ("{\"a\":1} {}", false),
    ("{\"a\":1}\u{0}", false),
    ("\u{A0}{}", false),
    ("{\"a\":[1,]}", false),
    ("{\"a\":[,1]}", false),
    ("{\"a\" 1}", false),
    ("{\"a\":1 \"b\":2}", false),
    ("{\"a\":\"\\u12\"}", false),
    ("{\"a\":\"\\uGGGG\"}", false),
    ("{\"a\":\"\\x41\"}", false),
    ("{\"a\":\"\\'\"}", false),
    ("{\"a\":\"x", false),
    ("{\"a\":\"tab\there\"}", false),
    ("{\"a\":\"new\nline\"}", false),
    ("{\"a\":\"nul\u{0}byte\"}", false),
    ("{\"a\":[}", false),
    ("{\"a\":}", false),
    ("{,}", false),
    ("{\"a\"}", false),
    ("{\"a\":1,,\"b\":2}", false),
    ("{\"a\":1]", false),
    ("{\"a\":[1}}", false),
  ]
}

/// In-memory double with the Keychain adapter's compare-and-swap contract,
/// a read hook for interleaving a second writer, and a crash injector that
/// throws AFTER the k-th write has been persisted (the process died before
/// the next step ran).
private final class AttackWalletStore: OfflineWalletSecureStore {
  var items: [String: Data] = [:]
  var writesByAccount: [String: Int] = [:]
  var onRead: ((String) throws -> Void)?
  private var writesUntilCrash: Int?

  func crashAfterWrite(_ count: Int) { writesUntilCrash = count }
  func clearCrash() { writesUntilCrash = nil }

  func read(account: String) throws -> Data? {
    let value = items[account]
    try onRead?(account)
    return value
  }

  func write(account: String, data: Data, ifUnchangedFrom previous: Data?) throws -> Bool {
    guard items[account] == previous else { return false }
    items[account] = data
    writesByAccount[account, default: 0] += 1
    try crashIfArmed()
    return true
  }

  func delete(account: String, ifUnchangedFrom previous: Data) throws -> Bool {
    guard items[account] == previous else { return false }
    items.removeValue(forKey: account)
    try crashIfArmed()
    return true
  }

  private func crashIfArmed() throws {
    guard let remaining = writesUntilCrash else { return }
    if remaining <= 1 {
      writesUntilCrash = nil
      throw OfflineWalletError(failure: .storageFailure, detail: "simulated process death after a persisted write")
    }
    writesUntilCrash = remaining - 1
  }
}
