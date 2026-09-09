import Foundation
import XCTest

@testable import PickleVisionCore

/// Adversarial matrix for the W05-01 offline wallet (candidate 2376305d).
/// Every test drives the public `OfflineWallet` API over an in-memory store
/// that can crash or fault after any individual mutation and can inject a
/// competing writer between a read and its dependent write. Attacks that the
/// candidate survives assert the invariant it claims; attacks that break it
/// fail with the observed behaviour in the message.
final class OfflineWalletAttackTests: XCTestCase {
  private let ownerA = "0f9d5a7e-3c1b-4a2d-9b8e-1c2d3e4f5a6b"
  private let ownerB = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"

  // MARK: - Attack 1: crash after the wallet write, before the fence commit

  /// `commitFence` documents the wallet write as the commit point. When the
  /// fence write that follows it fails with a Keychain error, the wallet has
  /// already moved (load returns the new revision) but replace() rethrows the
  /// storage error — a caller that retries per the `storage_unavailable`
  /// contract then gets `revision_conflict` for its own committed write.
  func testAttack1_FenceCommitFailureAfterWalletWriteIsReportedAsFailureAlthoughTheWalletMoved() throws {
    let store = AttackWalletStore()
    let wallet = OfflineWallet(store: store)
    let first = try wallet.replace(
      ownerId: ownerA, expectedRevision: 0,
      contents: OfflineWalletContents(grants: [grant(id: "grant-1")], receipts: []))
    XCTAssertEqual(first.revision, 1)

    let fenceAccount = OfflineWallet.fenceAccount(ownerId: ownerA)
    store.failWrite = { account in
      account == fenceAccount
        ? OfflineWalletError(failure: .storageUnavailable, detail: "locked", status: -25308) : nil
    }
    let outcome = Outcome {
      try wallet.replace(
        ownerId: ownerA, expectedRevision: 1,
        contents: OfflineWalletContents(grants: [grant(id: "grant-1")], receipts: [receipt(id: "receipt-1")]))
    }
    store.failWrite = nil

    let visible = try XCTUnwrap(try wallet.load(ownerId: ownerA))
    XCTAssertEqual(visible.revision, 2, "the wallet write landed: revision 2 is what every later read sees")
    XCTAssertEqual(visible.contents.receipts.map(\.receiptId), ["receipt-1"])
    XCTAssertEqual(
      outcome, .value(visible),
      "replace() reported \(outcome) for a write that committed; a caller retrying with expectedRevision 1 now gets revision_conflict and cannot distinguish 'not written' from 'written, fence lagging'"
    )
  }

  // MARK: - Attack 2: rollback inside the lagging-fence window

  /// The header promises that a wallet rolled back to an older authentic
  /// envelope reads `tampered` and that the fence holds "the highest revision
  /// ever committed". While the fence lags the wallet (a crash or storage
  /// fault between the two writes of a replace), the previously committed
  /// envelope still verifies against the fence: restoring it silently drops
  /// the newer receipt and the next replace re-issues the same revision number
  /// for different contents.
  func testAttack2_RestoringThePreviousEnvelopeWhileTheFenceLagsReadsAsCurrent() throws {
    let store = AttackWalletStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(
      ownerId: ownerA, expectedRevision: 0,
      contents: OfflineWalletContents(grants: [grant(id: "grant-1")], receipts: []))
    let walletAccount = OfflineWallet.walletAccount(ownerId: ownerA)
    let previousEnvelope = try XCTUnwrap(store.items[walletAccount])

    let fenceAccount = OfflineWallet.fenceAccount(ownerId: ownerA)
    store.crashBeforeWrite = { $0 == fenceAccount }
    _ = Outcome {
      try wallet.replace(
        ownerId: ownerA, expectedRevision: 1,
        contents: OfflineWalletContents(grants: [grant(id: "grant-1")], receipts: [receipt(id: "receipt-1")]))
    }
    store.crashBeforeWrite = nil
    XCTAssertEqual(try XCTUnwrap(try wallet.load(ownerId: ownerA)).revision, 2, "precondition: revision 2 committed (wallet write landed)")
    XCTAssertEqual(store.snapshotRevisions(ownerId: ownerA).sorted(), [1, 2], "precondition: fence still records revision 1")
    XCTAssertTrue(store.everyRevisionEverSealed.contains(2))

    // The revision-1 envelope (authentic, retired) is put back in the slot.
    store.items[walletAccount] = previousEnvelope
    let restarted = OfflineWallet(store: store)
    let verdict = Outcome { try restarted.load(ownerId: ownerA) }
    XCTAssertEqual(
      verdict, .failure(.tampered),
      "revision 1 reads as current after revision 2 was committed: \(verdict); receipt-1 is gone without a fault"
    )
    // And the history re-issues revision 2 for different contents.
    let reissued = Outcome {
      try restarted.replace(
        ownerId: ownerA, expectedRevision: verdict.value??.revision ?? 0,
        contents: OfflineWalletContents(grants: [grant(id: "grant-1")], receipts: [receipt(id: "receipt-other")]))
    }
    if let snapshot = reissued.value {
      XCTAssertNotEqual(snapshot.revision, 2, "revision 2 was issued twice: first with receipt-1, now with receipt-other")
    }
  }

  // MARK: - Attack 3: interleaved writers at every step of every operation

  /// A second instance (another process) performs load + replace between each
  /// mutation of the first instance's operation. Exactly one writer may win a
  /// revision, the loser must see revision_conflict (never a fabricated
  /// success and never a corruption verdict), and the store must end readable
  /// with a revision above both attempts.
  func testAttack3_CompetingWriterInjectedAfterEveryMutationNeverLosesOrCorruptsState() throws {
    for startState in [StartState.empty, .stored, .cleared] {
      var step = 0
      while true {
        let store = AttackWalletStore()
        let first = OfflineWallet(store: store)
        let second = OfflineWallet(store: store)
        try prepare(startState, wallet: first, store: store)
        let baseRevision = try first.load(ownerId: ownerA)?.revision ?? 0
        let beforeRevisions = store.snapshotRevisions(ownerId: ownerA)

        var secondOutcome: Outcome<OfflineWalletSnapshot>?
        var fired = false
        let target = step
        var mutations = 0
        store.onMutation = { _ in
          mutations += 1
          guard mutations == target + 1, !fired else { return }
          fired = true
          secondOutcome = Outcome<OfflineWalletSnapshot> {
            let current = try second.load(ownerId: self.ownerA)
            return try second.replace(
              ownerId: self.ownerA, expectedRevision: current?.revision ?? 0,
              contents: OfflineWalletContents(grants: [], receipts: [self.receipt(id: "second")]))
          }
        }
        let firstOutcome = Outcome {
          try first.replace(
            ownerId: ownerA, expectedRevision: baseRevision,
            contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "first")]))
        }
        store.onMutation = nil
        if !fired { break }  // fewer mutations than `step`: every interleaving covered
        step += 1

        let context = "start=\(startState) step=\(target) first=\(firstOutcome) second=\(String(describing: secondOutcome))"
        let final = try XCTUnwrap(try OfflineWallet(store: store).load(ownerId: ownerA), "final state unreadable: \(context)")
        let outcomes = [firstOutcome] + (secondOutcome.map { [$0] } ?? [])
        let issued = outcomes.compactMap(\.value)
        XCTAssertGreaterThanOrEqual(issued.count, 1, "nobody won: \(context)")
        for snapshot in issued {
          XCTAssertGreaterThan(snapshot.revision, beforeRevisions.max() ?? 0, "revision reused: \(context)")
        }
        for outcome in outcomes {
          if case .failure(let failure) = outcome {
            XCTAssertEqual(failure, .revisionConflict, "loser saw \(failure) instead of revision_conflict: \(context)")
          }
        }
        let winners = issued.map(\.revision)
        XCTAssertEqual(Set(winners).count, winners.count, "two writers were issued the same revision: \(context)")
        XCTAssertEqual(final.revision, winners.max(), "final revision differs from the last win: \(context)")
        XCTAssertEqual(
          final.contents.receipts.map(\.receiptId),
          issued.max(by: { $0.revision < $1.revision })?.contents.receipts.map(\.receiptId),
          "final contents are not the highest issued revision's: \(context)"
        )
        // The reported success (wallet write = commit point) must match what the store holds.
        if secondOutcome?.value != nil, firstOutcome.value != nil {
          XCTAssertEqual(final, issued.max(by: { $0.revision < $1.revision }), "both reported success but the store agrees with neither: \(context)")
        }
      }
      XCTAssertGreaterThanOrEqual(step, 2, "start=\(startState): interleavings were not exercised")
    }
  }

  // MARK: - Attack 4: process death after every mutation of every operation

  /// After a crash following any single write/delete, a fresh instance must
  /// give the SAME verdict on load, replace, clear and discardCorrupt, recovery
  /// must succeed through exactly the documented path, and the revision issued
  /// after recovery must exceed every revision ever issued for the owner.
  func testAttack4_CrashAfterEveryMutationLeavesAllEntryPointsAgreeingAndRecoverable() throws {
    let scenarios: [(String, (OfflineWallet, AttackWalletStore) throws -> Void, (OfflineWallet) throws -> Void)] = [
      ("first replace", { _, _ in }, { _ = try $0.replace(ownerId: self.ownerA, expectedRevision: 0, contents: self.contents("r1")) }),
      ("second replace", { w, s in try self.prepare(.stored, wallet: w, store: s) },
       { _ = try $0.replace(ownerId: self.ownerA, expectedRevision: 1, contents: self.contents("r2")) }),
      ("clear", { w, s in try self.prepare(.stored, wallet: w, store: s) },
       { try $0.clear(ownerId: self.ownerA, expectedRevision: 1) }),
      ("clear then replace", { w, s in try self.prepare(.stored, wallet: w, store: s) },
       {
         try $0.clear(ownerId: self.ownerA, expectedRevision: 1)
         _ = try $0.replace(ownerId: self.ownerA, expectedRevision: 0, contents: self.contents("r4"))
       }),
      ("replace after clear", { w, s in try self.prepare(.cleared, wallet: w, store: s) },
       { _ = try $0.replace(ownerId: self.ownerA, expectedRevision: 0, contents: self.contents("r3")) }),
      ("discard (verified fence)", { w, s in
        try self.prepare(.stored, wallet: w, store: s)
        s.flipPayloadByte(account: OfflineWallet.walletAccount(ownerId: self.ownerA))
      }, { _ = try $0.discardCorrupt(ownerId: self.ownerA) }),
      ("discard (corrupt fence)", { w, s in
        try self.prepare(.stored, wallet: w, store: s)
        s.flipPayloadByte(account: OfflineWallet.fenceAccount(ownerId: self.ownerA))
      }, { _ = try $0.discardCorrupt(ownerId: self.ownerA) }),
      ("discard (corrupt key)", { w, s in
        try self.prepare(.stored, wallet: w, store: s)
        s.items[OfflineWallet.integrityKeyAccount(ownerId: self.ownerA)] = Data([1, 2, 3])
      }, { _ = try $0.discardCorrupt(ownerId: self.ownerA) }),
    ]

    for (name, setup, operation) in scenarios {
      var crashAt = 1
      while true {
        let store = AttackWalletStore()
        let wallet = OfflineWallet(store: store)
        try setup(wallet, store)
        let keyBefore = store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerA)]
        let mutationsBefore = store.mutationLog.count
        var mutations = 0
        let target = crashAt
        store.onMutation = { _ in
          mutations += 1
          if mutations == target { throw Crash() }
        }
        let crashed = Outcome<Bool> {
          try operation(wallet)
          return true
        }
        store.onMutation = nil
        if mutations < target { break }
        crashAt += 1
        let issuedAtCrash = store.everyRevisionEverSealed
        let crashLog = store.mutationLog.dropFirst(mutationsBefore)
        let context = "\(name), crash after mutation \(target) (\(crashLog.joined(separator: ",")))"
        XCTAssertEqual(crashed, .failure(.storageFailure), "\(context): an interrupted operation must surface a storage failure, got \(crashed)")

        let restarted = OfflineWallet(store: store)
        let load = Outcome { try restarted.load(ownerId: ownerA) }
        let expectedRevision = load.value.flatMap { $0 }?.revision ?? 0
        let replace = Outcome { try restarted.replace(ownerId: ownerA, expectedRevision: expectedRevision, contents: contents("probe")) }
        switch load {
        case .failure(let failure):
          XCTAssertTrue(failure.isUnreadableState, "\(context): load fault \(failure) is not an unreadable-state verdict")
          XCTAssertEqual(replace, .failure(failure), "\(context): replace disagrees with load")
          XCTAssertEqual(
            Outcome<Bool> {
              try restarted.clear(ownerId: ownerA, expectedRevision: 0)
              return true
            }, .failure(failure), "\(context): clear disagrees with load")
          XCTAssertEqual(Outcome { try restarted.discardCorrupt(ownerId: ownerA) }, .value(failure), "\(context): discardCorrupt disagrees with load")
          XCTAssertNil(try OfflineWallet(store: store).load(ownerId: ownerA), "\(context): discard left something readable")
        case .value:
          XCTAssertEqual(Outcome { try restarted.discardCorrupt(ownerId: ownerA) }, .failure(.notCorrupt), "\(context): readable state was discardable")
          XCTAssertNotNil(replace.value, "\(context): replace at the loaded revision failed: \(replace)")
        case .other(let text):
          XCTFail("\(context): load escaped an untyped error: \(text)")
        }
        let recovered = try OfflineWallet(store: store).replace(
          ownerId: ownerA, expectedRevision: try OfflineWallet(store: store).load(ownerId: ownerA)?.revision ?? 0,
          contents: contents("recovered"))
        if crashLog.contains("delete:fence") || store.mutationLog.contains("delete:fence") {
          // The documented exception: an unverifiable fence leaves with its key,
          // so the history restarts — but never under the key that sealed it.
          XCTAssertNotEqual(store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerA)], keyBefore, "\(context): key reused across histories")
        } else {
          XCTAssertGreaterThan(recovered.revision, issuedAtCrash.max() ?? 0, "\(context): recovery reused a revision")
          XCTAssertFalse(issuedAtCrash.contains(recovered.revision), "\(context): revision \(recovered.revision) was issued before the crash")
        }
        XCTAssertEqual(try OfflineWallet(store: store).load(ownerId: ownerA), recovered, "\(context): recovered wallet not readable")
      }
      XCTAssertGreaterThanOrEqual(crashAt, 3, "\(name): crash points were not exercised")
    }
  }

  // MARK: - Attack 5: boundary values on the bridge and the revision space

  func testAttack5_BridgeRevisionBoundariesAndRevisionSpaceExhaustion() throws {
    let rejected: [Double] = [
      .nan, .infinity, -.infinity, -1, -0.5, 0.5, 1.5, 9_007_199_254_740_992, 1e300, .leastNonzeroMagnitude,
      .greatestFiniteMagnitude, Double(UInt64.max),
    ]
    for value in rejected {
      let outcome = Outcome { try OfflineWallet.revision(fromBridge: value) }
      XCTAssertEqual(outcome, .failure(.invalidRevision), "bridge accepted \(value): \(outcome)")
    }
    XCTAssertEqual(try OfflineWallet.revision(fromBridge: -0.0), 0)
    XCTAssertEqual(try OfflineWallet.revision(fromBridge: 9_007_199_254_740_991), OfflineWallet.maxRevision)

    // An owner whose fence reaches maxRevision can never store again — and
    // clear() happily commits that terminal fence, which the candidate accepts.
    let store = AttackWalletStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: contents("seed"))
    store.rewriteRevisions(ownerId: ownerA, to: OfflineWallet.maxRevision - 1)
    let last = try wallet.replace(ownerId: ownerA, expectedRevision: OfflineWallet.maxRevision - 1, contents: contents("last"))
    XCTAssertEqual(last.revision, OfflineWallet.maxRevision)
    XCTAssertEqual(
      Outcome { try wallet.replace(ownerId: ownerA, expectedRevision: OfflineWallet.maxRevision, contents: contents("over")) },
      .failure(.capacityExceeded))
    try wallet.clear(ownerId: ownerA, expectedRevision: OfflineWallet.maxRevision)
    XCTAssertNil(try wallet.load(ownerId: ownerA))
    XCTAssertEqual(
      Outcome { try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: contents("after")) },
      .failure(.capacityExceeded), "revision space stays exhausted after clear (typed, not a trap)")
    XCTAssertEqual(Outcome { try wallet.discardCorrupt(ownerId: ownerA) }, .failure(.notCorrupt))
  }

  // MARK: - Attack 6: differential JSON grammar (native scanner vs JSON.parse)

  /// Every entry's verdict is what V8's `JSON.parse` gives (recorded by
  /// `apps/mobile/__tests__/offlineWalletAttack.test.ts` for the same corpus).
  /// A native acceptance that JS rejects would make a committed receipt
  /// unreadable through the bridge (`bridge_contract` on load).
  func testAttack6_NativeJsonObjectScannerMatchesJsonParseOnEdgeCases() {
    for (text, expected) in Self.jsonCorpus {
      XCTAssertEqual(
        OfflineWalletShape.isJsonObject(text, maxBytes: OfflineWallet.Limits.maxReceiptPayloadBytes), expected,
        "scanner disagrees with JSON.parse on \(text.debugDescription)")
    }
    let deep = "{\"a\":" + String(repeating: "[", count: 4_093) + String(repeating: "]", count: 4_093) + "}"
    XCTAssertEqual(deep.utf8.count, 8_192)
    XCTAssertTrue(OfflineWalletShape.isJsonObject(deep, maxBytes: OfflineWallet.Limits.maxReceiptPayloadBytes))
    XCTAssertFalse(OfflineWalletShape.isJsonObject(deep + " ", maxBytes: OfflineWallet.Limits.maxReceiptPayloadBytes), "size limit off by one")
    XCTAssertFalse(OfflineWalletShape.isJsonObject("{\"a\":\"\u{E9}\"}", maxBytes: 9), "byte (not scalar) limit")
    XCTAssertTrue(OfflineWalletShape.isJsonObject("{\"a\":\"\u{E9}\"}", maxBytes: 10))
  }

  // MARK: - Attack 7: exhaustive single-byte corruption and truncation

  /// Every single-byte flip and every truncation of each stored item must be a
  /// typed unreadable fault on every entry point (never nil, never a snapshot,
  /// never a trap), preserved until discardCorrupt, and recoverable afterwards.
  func testAttack7_EverySingleByteFlipAndTruncationIsAnUnreadableFaultOnEveryEntryPoint() throws {
    let accounts = [
      OfflineWallet.walletAccount(ownerId: ownerA),
      OfflineWallet.fenceAccount(ownerId: ownerA),
      OfflineWallet.integrityKeyAccount(ownerId: ownerA),
    ]
    let pristine = AttackWalletStore()
    _ = try OfflineWallet(store: pristine).replace(
      ownerId: ownerA, expectedRevision: 0,
      contents: OfflineWalletContents(grants: [grant(id: "grant-1")], receipts: [receipt(id: "receipt-1")]))
    _ = try OfflineWallet(store: pristine).replace(ownerId: ownerB, expectedRevision: 0, contents: contents("b"))

    var faults: [OfflineWalletFailure: Int] = [:]
    for account in accounts {
      let original = try XCTUnwrap(pristine.items[account])
      var mutations: [Data?] = []
      for index in original.indices {
        for bit in [0x01, 0x80] as [UInt8] {
          var bytes = original
          bytes[index] ^= bit
          mutations.append(bytes)
        }
      }
      for length in 0..<original.count { mutations.append(original.prefix(length)) }
      mutations.append(original + Data([0]))
      // A byte-for-byte swap with the other slots (account binding).
      for other in accounts where other != account { mutations.append(try XCTUnwrap(pristine.items[other])) }
      // Owner B's same slot (owner binding) and the item deleted outright.
      mutations.append(try XCTUnwrap(pristine.items[account.replacingOccurrences(of: ownerA, with: ownerB)]))
      mutations.append(nil)

      for mutated in mutations {
        let store = pristine.copy()
        if let mutated { store.items[account] = mutated } else { store.items.removeValue(forKey: account) }
        let wallet = OfflineWallet(store: store)
        let context = "\(account) -> \(mutated.map { "\($0.count) bytes \($0.prefix(4).map { String($0) })" } ?? "absent")"
        let load = Outcome { try wallet.load(ownerId: ownerA) }
        guard case .failure(let failure) = load else {
          XCTFail("\(context): corrupt item read as \(load)")
          continue
        }
        XCTAssertTrue(failure.isUnreadableState, "\(context): \(failure)")
        faults[failure, default: 0] += 1
        XCTAssertEqual(Outcome { try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: contents("x")) }, .failure(failure), context)
        XCTAssertEqual(Outcome { try wallet.replace(ownerId: ownerA, expectedRevision: 1, contents: contents("x")) }, .failure(failure), context)
        XCTAssertEqual(
          Outcome<Bool> {
            try wallet.clear(ownerId: ownerA, expectedRevision: 1)
            return true
          }, .failure(failure), context)
        XCTAssertEqual(store.items[account], mutated, "\(context): refused call modified the store")
        XCTAssertEqual(try wallet.load(ownerId: ownerB)?.revision, 1, "\(context): owner B affected")
        XCTAssertEqual(Outcome { try wallet.discardCorrupt(ownerId: ownerA) }, .value(failure), context)
        XCTAssertNil(try wallet.load(ownerId: ownerA), context)
        let recovered = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: contents("recovered"))
        XCTAssertGreaterThanOrEqual(recovered.revision, 1, context)
        XCTAssertEqual(try wallet.load(ownerId: ownerA), recovered, context)
        XCTAssertEqual(try wallet.load(ownerId: ownerB)?.revision, 1, "\(context): owner B affected by recovery")
      }
    }
    XCTAssertEqual(Set(faults.keys), [.tampered, .unsupportedVersion, .integrityKeyMissing], "unexpected fault classes: \(faults)")
  }

  // MARK: - Attack 10: owner id canonical form

  /// Owner ids must be one canonical spelling so two spellings of one account
  /// can never address two wallets; every non-canonical form is `invalid_owner`
  /// on every entry point before any store access.
  func testAttack10_NonCanonicalOwnerIdsAreRefusedBeforeAnyStoreAccess() {
    let hostile = [
      "", " ", ownerA.uppercased(), " " + ownerA, ownerA + " ", ownerA + "\u{0}", ownerA.replacingOccurrences(of: "-", with: ""),
      ownerA.replacingOccurrences(of: "-", with: "_"), String(ownerA.dropLast()), ownerA + "a",
      "00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff",
      "0f9d5a7e-3c1b-4a2d-7b8e-1c2d3e4f5a6b", "0f9d5a7e-3c1b-0a2d-9b8e-1c2d3e4f5a6b", "0f9d5a7e-3c1b-9a2d-9b8e-1c2d3e4f5a6b",
      "0f9d5a7e-3c1b-4a2d-9b8e-1c2d3e4f5a6\u{FF42}", "0f9d5a7e-3c1b-4a2d-9b8e-1c2d3e4f5a\u{0661}b", "0f9d5a7e\u{2010}3c1b-4a2d-9b8e-1c2d3e4f5a6b",
      "0f9d5a7e-3c1b-4a2d-9b8e-1c2d3e4f5a6\u{62}\u{301}", "wallet.v1." + ownerA, ownerA + ".", "../" + ownerA,
    ]
    for owner in hostile where owner != ownerA {
      let store = AttackWalletStore()
      let wallet = OfflineWallet(store: store)
      XCTAssertEqual(Outcome { try wallet.load(ownerId: owner) }, .failure(.invalidOwner), owner.debugDescription)
      XCTAssertEqual(Outcome { try wallet.replace(ownerId: owner, expectedRevision: 0, contents: contents("x")) }, .failure(.invalidOwner), owner.debugDescription)
      XCTAssertEqual(Outcome<Bool> { try wallet.clear(ownerId: owner, expectedRevision: 0); return true }, .failure(.invalidOwner), owner.debugDescription)
      XCTAssertEqual(Outcome { try wallet.discardCorrupt(ownerId: owner) }, .failure(.invalidOwner), owner.debugDescription)
      XCTAssertTrue(store.items.isEmpty && store.reads == 0, "\(owner.debugDescription): store touched")
    }
  }

  // MARK: - Attack 8: replay of retired envelopes and cross-owner transplant

  func testAttack8_RetiredEnvelopesAndTransplantedOwnerStateNeverReadAsCurrent() throws {
    let store = AttackWalletStore()
    let wallet = OfflineWallet(store: store)
    let walletAccount = OfflineWallet.walletAccount(ownerId: ownerA)
    let fenceAccount = OfflineWallet.fenceAccount(ownerId: ownerA)
    let keyAccount = OfflineWallet.integrityKeyAccount(ownerId: ownerA)

    var envelopes: [Data] = []
    var fences: [Data] = []
    var expected: UInt64 = 0
    for index in 1...4 {
      let snapshot = try wallet.replace(ownerId: ownerA, expectedRevision: expected, contents: contents("v\(index)"))
      expected = snapshot.revision
      envelopes.append(try XCTUnwrap(store.items[walletAccount]))
      fences.append(try XCTUnwrap(store.items[fenceAccount]))
    }
    try wallet.clear(ownerId: ownerA, expectedRevision: expected)
    let tombstone = try XCTUnwrap(store.items[walletAccount])
    let clearedFence = try XCTUnwrap(store.items[fenceAccount])
    let after = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: contents("v5"))
    XCTAssertEqual(after.revision, 5)
    let currentEnvelope = try XCTUnwrap(store.items[walletAccount])
    let currentFence = try XCTUnwrap(store.items[fenceAccount])

    // Every older envelope, alone, is a rollback.
    for (index, envelope) in (envelopes + [tombstone]).enumerated() {
      store.items[walletAccount] = envelope
      XCTAssertEqual(Outcome { try wallet.load(ownerId: ownerA) }, .failure(.tampered), "envelope \(index) replayed")
      XCTAssertEqual(Outcome { try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: contents("x")) }, .failure(.tampered))
    }
    // An older fence beside the current wallet is harmless (wallet ahead).
    store.items[walletAccount] = currentEnvelope
    for fence in fences + [clearedFence] {
      store.items[fenceAccount] = fence
      XCTAssertEqual(try wallet.load(ownerId: ownerA)?.revision, 5)
    }
    store.items[fenceAccount] = currentFence
    // Older fence + matching older envelope from the same snapshot: this is a
    // consistent point-in-time restore of BOTH items — recorded as accepted.
    store.items[walletAccount] = envelopes[2]
    store.items[fenceAccount] = fences[2]
    let restored = Outcome { try wallet.load(ownerId: ownerA) }
    XCTAssertEqual(restored.value??.revision, 3, "a consistent two-item restore is indistinguishable from history: \(restored)")
    store.items[walletAccount] = currentEnvelope
    store.items[fenceAccount] = currentFence

    // Transplant the whole owner-A triple into owner B's slots.
    _ = try wallet.replace(ownerId: ownerB, expectedRevision: 0, contents: contents("b1"))
    store.items[OfflineWallet.walletAccount(ownerId: ownerB)] = currentEnvelope
    store.items[OfflineWallet.fenceAccount(ownerId: ownerB)] = currentFence
    store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerB)] = store.items[keyAccount]
    XCTAssertEqual(Outcome { try wallet.load(ownerId: ownerB) }, .failure(.tampered), "owner A's triple verified for owner B")
    XCTAssertEqual(try wallet.load(ownerId: ownerA)?.revision, 5)
    XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerB), .tampered)
    XCTAssertNil(try wallet.load(ownerId: ownerB))
    XCTAssertEqual(try wallet.load(ownerId: ownerA)?.revision, 5, "discarding B touched A")
  }

  // MARK: - Attack 9: shape limits at their exact boundaries

  func testAttack9_ShapeLimitsAtExactBoundaries() throws {
    let store = AttackWalletStore()
    let wallet = OfflineWallet(store: store)
    func attempt(_ contents: OfflineWalletContents) -> Outcome<OfflineWalletSnapshot> {
      Outcome { try wallet.replace(ownerId: self.ownerA, expectedRevision: try wallet.load(ownerId: self.ownerA)?.revision ?? 0, contents: contents) }
    }
    let id128 = String(repeating: "a", count: 128)
    XCTAssertNotNil(attempt(OfflineWalletContents(grants: [grant(id: id128)], receipts: [])).value)
    XCTAssertEqual(attempt(OfflineWalletContents(grants: [grant(id: id128 + "a")], receipts: [])), .failure(.invalidGrant))
    XCTAssertEqual(attempt(OfflineWalletContents(grants: [grant(id: "gr ant")], receipts: [])), .failure(.invalidGrant))
    XCTAssertEqual(attempt(OfflineWalletContents(grants: [grant(id: "\u{E9}")], receipts: [])), .failure(.invalidGrant))
    XCTAssertEqual(attempt(OfflineWalletContents(grants: [grant(id: "e\u{301}"), grant(id: "\u{E9}")], receipts: [])), .failure(.invalidGrant))

    // Signature segment: 85 / 87 chars, non-canonical tail, padding.
    let parts = grant(id: "g").compactJws.split(separator: ".").map(String.init)
    for signature in [String(repeating: "A", count: 85), String(repeating: "A", count: 87), String(repeating: "A", count: 85) + "B", String(repeating: "A", count: 84) + "=="] {
      let jws = [parts[0], parts[1], signature].joined(separator: ".")
      XCTAssertEqual(attempt(OfflineWalletContents(grants: [OfflineStoredGrant(grantId: "g", compactJws: jws)], receipts: [])), .failure(.invalidGrant), signature)
    }
    let ok = [parts[0], parts[1], String(repeating: "A", count: 85) + "w"].joined(separator: ".")
    XCTAssertNotNil(attempt(OfflineWalletContents(grants: [OfflineStoredGrant(grantId: "g", compactJws: ok)], receipts: [])).value)
    XCTAssertEqual(attempt(OfflineWalletContents(grants: [OfflineStoredGrant(grantId: "g", compactJws: ok + ".")], receipts: [])), .failure(.invalidGrant))
    XCTAssertEqual(attempt(OfflineWalletContents(grants: [OfflineStoredGrant(grantId: "g", compactJws: "." + ok)], receipts: [])), .failure(.invalidGrant))

    // Receipt payload exactly at / one over the byte limit.
    let filler = String(repeating: "x", count: OfflineWallet.Limits.maxReceiptPayloadBytes - 8)
    let atLimit = "{\"a\":\"\(filler)\"}"
    XCTAssertEqual(atLimit.utf8.count, OfflineWallet.Limits.maxReceiptPayloadBytes)
    XCTAssertNotNil(attempt(OfflineWalletContents(grants: [], receipts: [OfflineStoredReceipt(receiptId: "r", kind: .result, payloadJson: atLimit)])).value)
    XCTAssertEqual(
      attempt(OfflineWalletContents(grants: [], receipts: [OfflineStoredReceipt(receiptId: "r", kind: .result, payloadJson: atLimit + " ")])),
      .failure(.invalidReceipt))
    // Counts: 8/9 grants, 64/65 receipts.
    XCTAssertNotNil(attempt(OfflineWalletContents(grants: (0..<8).map { grant(id: "g\($0)") }, receipts: (0..<64).map { receipt(id: "r\($0)") })).value)
    XCTAssertEqual(attempt(OfflineWalletContents(grants: (0..<9).map { grant(id: "g\($0)") }, receipts: [])), .failure(.capacityExceeded))
    XCTAssertEqual(attempt(OfflineWalletContents(grants: [], receipts: (0..<65).map { receipt(id: "r\($0)") })), .failure(.capacityExceeded))
    // A refused write never advances the revision.
    XCTAssertEqual(try wallet.load(ownerId: ownerA)?.revision, 4)
  }

  // MARK: - Helpers

  private enum StartState { case empty, stored, cleared }

  private func prepare(_ state: StartState, wallet: OfflineWallet, store: AttackWalletStore) throws {
    switch state {
    case .empty: return
    case .stored:
      _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: contents("seed"))
    case .cleared:
      _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: contents("seed"))
      try wallet.clear(ownerId: ownerA, expectedRevision: 1)
    }
  }

  private func contents(_ tag: String) -> OfflineWalletContents {
    OfflineWalletContents(grants: [grant(id: "grant-\(tag)")], receipts: [receipt(id: "receipt-\(tag)")])
  }

  private func grant(id: String) -> OfflineStoredGrant {
    let header = base64url("{\"alg\":\"ES256\",\"typ\":\"pickle-offline-execution-grant+jwt\",\"kid\":\"kid-1\"}")
    let claims = base64url("{\"jti\":\"\(id)\",\"aud\":\"urn:pickle-sensei:offline-execution:v1\"}")
    return OfflineStoredGrant(grantId: id, compactJws: [header, claims, String(repeating: "A", count: 86)].joined(separator: "."))
  }

  private func receipt(id: String, kind: OfflineStoredReceiptKind = .result) -> OfflineStoredReceipt {
    OfflineStoredReceipt(receiptId: id, kind: kind, payloadJson: "{\"schemaVersion\":\"offline-result-receipt-v1\",\"receiptId\":\"\(id)\"}")
  }

  private func base64url(_ text: String) -> String {
    Data(text.utf8).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  static let jsonCorpus: [(String, Bool)] = [
    ("{}", true),
    (" {} ", true),
    ("\u{9}{\u{A}}\u{D}", true),
    ("{\"a\":1}", true),
    ("{\"a\":01}", false),
    ("{\"a\":1.}", false),
    ("{\"a\":.5}", false),
    ("{\"a\":-0}", true),
    ("{\"a\":-}", false),
    ("{\"a\":1e5}", true),
    ("{\"a\":1E+5}", true),
    ("{\"a\":1e}", false),
    ("{\"a\":+1}", false),
    ("{\"a\":1e400}", true),
    ("{\"a\":-0.0e-0}", true),
    ("{\"a\":\"\\u0000\"}", true),
    ("{\"a\":\"\\uD800\"}", true),
    ("{\"a\":\"\\ud800\\udc00\"}", true),
    ("{\"a\":\"\\uZZZZ\"}", false),
    ("{\"a\":\"\\u12\"}", false),
    ("{\"a\":\"\\x41\"}", false),
    ("{\"a\":\"\\/\"}", true),
    ("{\"a\":\"\\a\"}", false),
    ("{\"a\":\"\\'\"}", false),
    ("{\"a\":\"\u{9}\"}", false),
    ("{\"a\":\"\u{7F}\"}", true),
    ("{\"a\":\"\u{E9}\"}", true),
    ("{\"a\":\"\u{2028}\u{2029}\"}", true),
    ("{\"a\":[]}", true),
    ("{\"a\":[1,]}", false),
    ("{\"a\":[,1]}", false),
    ("{\"a\":[1 2]}", false),
    ("{\"a\":{}}", true),
    ("{\"a\":{\"b\":}}", false),
    ("{\"a\":1,}", false),
    ("{,\"a\":1}", false),
    ("{\"a\" 1}", false),
    ("{a:1}", false),
    ("{\"a\":1}{}", false),
    ("{\"a\":1} 1", false),
    ("{\"a\":true}", true),
    ("{\"a\":True}", false),
    ("{\"a\":nul}", false),
    ("{\"a\":null}", true),
    ("{\"a\":NaN}", false),
    ("{\"a\":Infinity}", false),
    ("{\"a\":undefined}", false),
    ("{\"\":1}", true),
    ("{\"a\":1,\"a\":2}", true),
    ("{\"__proto__\":1}", true),
    ("[]", false),
    ("null", false),
    ("1", false),
    ("\"x\"", false),
    ("", false),
    (" ", false),
    ("\u{FEFF}{}", false),
    ("{}\u{0}", false),
    ("{\"a\":\"\u{0}\"}", false),
    ("{\"a\":\"\\\"}", false),
    ("{\"a\":\"\\", false),
    ("{\"a\":\"", false),
    ("{\"a\":\"\\u00\"}", false),
    ("{\"a\":\"\\uABCD\"}", true),
    ("{\"a\":\"\\uabcd\"}", true),
    ("{\"a\":[[[[[[[[[[]]]]]]]]]]}", true),
    ("{\"a\":[[[]]}", false),
    ("{\"a\":[[]]]}", false),
    ("{\"a\":1 , \"b\" : [ 2 , 3 ] }", true),
    ("{\"a\":\"}\"}", true),
    ("{\"a\":\"\\\\\"}", true),
    ("{\"a\": -12.5e-3}", true),
    ("{\"a\":00}", false),
    ("{\"a\":0}", true),
    ("{\"a\":1.0}", true),
    ("\u{A0}{}", false),
    ("\u{2028}{}", false),
    ("{}\u{B}", false),
    ("{\"a\":1}//c", false),
    ("{\"a\":1}/*c*/", false),
    ("{\"a\":'b'}", false),
  ]
}

private struct Crash: Error {}

/// Outcome of one wallet call: the value, a typed wallet failure, or anything
/// else (which the wallet must never let escape).
private enum Outcome<Value: Equatable>: Equatable, CustomStringConvertible {
  case value(Value)
  case failure(OfflineWalletFailure)
  case other(String)

  init(_ body: () throws -> Value) {
    do {
      self = .value(try body())
    } catch let error as OfflineWalletError {
      self = .failure(error.failure)
    } catch {
      self = .other(String(describing: error))
    }
  }

  var value: Value? {
    if case .value(let value) = self { return value }
    return nil
  }

  var description: String {
    switch self {
    case .value(let value): return "value(\(value))"
    case .failure(let failure): return "failure(\(failure.rawValue))"
    case .other(let text): return "other(\(text))"
    }
  }
}

/// In-memory store with the Keychain adapter's compare-and-swap contract plus
/// crash and fault injection after (or before) any mutation.
private final class AttackWalletStore: OfflineWalletSecureStore {
  var items: [String: Data] = [:]
  var reads = 0
  var mutationLog: [String] = []
  var everyRevisionEverSealed: Set<UInt64> = []
  /// Called after a write or delete has landed; throwing simulates a crash.
  var onMutation: ((String) throws -> Void)?
  var failWrite: ((String) -> OfflineWalletError?)?
  var crashBeforeWrite: ((String) -> Bool)?

  func copy() -> AttackWalletStore {
    let store = AttackWalletStore()
    store.items = items
    store.everyRevisionEverSealed = everyRevisionEverSealed
    return store
  }

  func read(account: String) throws -> Data? {
    reads += 1
    return items[account]
  }

  func write(account: String, data: Data, ifUnchangedFrom previous: Data?) throws -> Bool {
    if let failure = failWrite?(account) { throw failure }
    if crashBeforeWrite?(account) == true { throw Crash() }
    guard items[account] == previous else { return false }
    items[account] = data
    mutationLog.append("write:\(account.split(separator: ".").first ?? "")")
    if let revision = Self.revision(in: data) { everyRevisionEverSealed.insert(revision) }
    try onMutation?(account)
    return true
  }

  func delete(account: String, ifUnchangedFrom previous: Data) throws -> Bool {
    guard items[account] == previous else { return false }
    items.removeValue(forKey: account)
    mutationLog.append("delete:\(account.split(separator: ".").first ?? "")")
    try onMutation?(account)
    return true
  }

  /// Revisions of every sealed envelope currently stored for the owner.
  func snapshotRevisions(ownerId: String) -> [UInt64] {
    [OfflineWallet.walletAccount(ownerId: ownerId), OfflineWallet.fenceAccount(ownerId: ownerId)]
      .compactMap { items[$0] }.compactMap(Self.revision(in:))
  }

  func flipPayloadByte(account: String) {
    guard var bytes = items[account] else { return }
    bytes[bytes.count - 1] ^= 0x01
    items[account] = bytes
  }

  /// Re-seals the owner's wallet and fence at `revision` with the stored key.
  func rewriteRevisions(ownerId: String, to revision: UInt64) {
    let key = items[OfflineWallet.integrityKeyAccount(ownerId: ownerId)] ?? Data()
    for account in [OfflineWallet.walletAccount(ownerId: ownerId), OfflineWallet.fenceAccount(ownerId: ownerId)] {
      guard let sealed = items[account], let payload = try? OfflineWallet.open(sealed, account: account, key: key),
        var text = String(data: payload, encoding: .utf8),
        let range = text.range(of: "\"revision\":1")
      else { continue }
      text.replaceSubrange(range, with: "\"revision\":\(revision)")
      items[account] = OfflineWallet.seal(payload: Data(text.utf8), account: account, key: key)
    }
  }

  private static func revision(in sealed: Data) -> UInt64? {
    guard sealed.count > 33, let text = String(data: sealed.suffix(from: 33), encoding: .utf8),
      let range = text.range(of: "\"revision\":")
    else { return nil }
    let digits = text[range.upperBound...].prefix { $0.isNumber }
    return UInt64(digits)
  }
}
