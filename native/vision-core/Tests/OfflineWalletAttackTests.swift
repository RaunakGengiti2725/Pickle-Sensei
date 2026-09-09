import Foundation
import XCTest

@testable import PickleVisionCore

/// Adversarial probes for the offline wallet (W05-01, candidate 1549b6aa).
/// Each test asserts the behaviour the wallet's own documentation promises at
/// a failure boundary — process death between store steps, two instances
/// racing on one owner, payloads the JS side of the bridge cannot read back,
/// full-state rollback — so a failing test here is a reproducible break of
/// that promise, not a style opinion. The store double keeps the candidate
/// suite's compare-and-swap contract and adds read/write hooks so a second
/// writer can be interleaved at any exact step.
final class OfflineWalletAttackTests: XCTestCase {
  private let owner = "0f9d5a7e-3c1b-4a2d-9b8e-1c2d3e4f5a6b"

  // MARK: - Bridge parser mismatch (native accepts what JS refuses)

  /// `OfflineWalletShape.isJsonObject` delegates to `JSONSerialization`, which
  /// tolerates a UTF-8 byte-order mark; `JSON.parse` on the JS side does not.
  /// A receipt that passes native validation but fails `parseSnapshot` makes
  /// the replace rejection `bridge_contract` although the wallet was written,
  /// and every later `loadOfflineWallet` rejects the same way while
  /// `discardCorrupt` reports `not_corrupt`. The wallet must refuse it up
  /// front as `invalid_receipt`.
  func testReplaceRejectsReceiptPayloadWithByteOrderMarkThatJsCannotParse() throws {
    let store = AttackStore()
    let wallet = OfflineWallet(store: store)
    let bom = OfflineStoredReceipt(
      receiptId: "receipt-bom",
      kind: .result,
      payloadJson: "\u{FEFF}{\"schemaVersion\":\"offline-result-receipt-v1\",\"receiptId\":\"receipt-bom\"}"
    )

    assertFailure(.invalidReceipt, "a payload JSON.parse rejects must not be stored") {
      try wallet.replace(ownerId: owner, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [bom]))
    }
    XCTAssertNil(store.items[OfflineWallet.walletAccount(ownerId: owner)], "nothing may be written for a refused receipt")
  }

  /// Same boundary, trailing comma inside the object: `JSON.parse` rejects
  /// `{"a":1,}`. (Accepted by the Linux `JSONSerialization`; Apple's parser
  /// must be checked on the Mac runner.)
  func testReplaceRejectsReceiptPayloadWithTrailingCommaThatJsCannotParse() throws {
    let store = AttackStore()
    let wallet = OfflineWallet(store: store)
    let trailing = OfflineStoredReceipt(receiptId: "receipt-trailing", kind: .result, payloadJson: "{\"a\":1,}")

    assertFailure(.invalidReceipt, "a payload JSON.parse rejects must not be stored") {
      try wallet.replace(ownerId: owner, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: [trailing]))
    }
    XCTAssertNil(store.items[OfflineWallet.walletAccount(ownerId: owner)])
  }

  // MARK: - Process death between the wallet write and the fence commit

  /// Documented: "the fence survives `clear`, so revisions never restart for an
  /// owner on this installation". After a crash between the wallet write
  /// (revision 2) and the fence advance (still 1), `clear(expectedRevision: 2)`
  /// deletes the wallet without repairing the fence, so the next replace is
  /// numbered 2 again and the pre-clear authentic revision-2 envelope (with
  /// its already-submitted receipt) reads back as current state.
  func testClearAfterCrashBetweenWalletWriteAndFenceCommitDoesNotReuseARevision() throws {
    let store = AttackStore()
    let wallet = OfflineWallet(store: store)
    let walletAccount = OfflineWallet.walletAccount(ownerId: owner)
    let fenceAccount = OfflineWallet.fenceAccount(ownerId: owner)

    _ = try wallet.replace(ownerId: owner, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))
    let fenceAtOne = try XCTUnwrap(store.items[fenceAccount])
    let crashed = try wallet.replace(
      ownerId: owner,
      expectedRevision: 1,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-submitted-later")])
    )
    XCTAssertEqual(crashed.revision, 2)
    store.items[fenceAccount] = fenceAtOne  // process died before the fence advanced
    let staleRevisionTwo = try XCTUnwrap(store.items[walletAccount])

    let relaunched = OfflineWallet(store: store)
    XCTAssertEqual(try relaunched.load(ownerId: owner)?.revision, 2, "wallet ahead of fence is readable")
    try relaunched.clear(ownerId: owner, expectedRevision: 2)

    let next = try relaunched.replace(
      ownerId: owner,
      expectedRevision: 0,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-unsent")])
    )
    XCTAssertEqual(next.revision, 3, "revision 2 was already handed out for this owner and must never be reused")

    store.items[walletAccount] = staleRevisionTwo
    assertFailure(.tampered, "an older authentic envelope must not read as current state") {
      try relaunched.load(ownerId: owner)
    }
  }

  // MARK: - Two instances racing on a fresh owner

  /// `readState` reads key, fence, wallet as three separate store reads. If a
  /// second instance performs the owner's first replace between the key read
  /// and the fence read, the reader sees "fence and wallet without a key" and
  /// reports `integrity_key_missing` — an unreadable-state failure that tells
  /// the caller to reconcile and discard — for a wallet that is perfectly
  /// healthy.
  func testLoadRacingAnotherInstancesFirstWriteIsNotReportedAsUnreadable() throws {
    let store = AttackStore()
    let reader = OfflineWallet(store: store)
    let writer = OfflineWallet(store: store)
    let keyAccount = OfflineWallet.integrityKeyAccount(ownerId: owner)
    var armed = true
    store.afterRead = { [owner] account, _ in
      guard armed, account == keyAccount else { return }
      armed = false
      _ = try writer.replace(
        ownerId: owner,
        expectedRevision: 0,
        contents: OfflineWalletContents(grants: [], receipts: [self.receipt(id: "receipt-first")])
      )
    }

    do {
      let seen = try reader.load(ownerId: owner)
      XCTAssertTrue(seen == nil || seen?.revision == 1, "either view of a healthy owner is acceptable")
    } catch let error as OfflineWalletError {
      XCTFail("a concurrent legitimate first write must never surface as \(error.failure) (\(error.detail))")
    }
  }

  /// Same race inside `discardCorrupt`: the misreported `integrity_key_missing`
  /// satisfies `isUnreadableState`, so the just-written wallet (with its unsent
  /// receipt) and the fence are deleted although nothing was corrupt.
  func testDiscardCorruptRacingAnotherInstancesFirstWriteNeverDeletesAHealthyWallet() throws {
    let store = AttackStore()
    let discarder = OfflineWallet(store: store)
    let writer = OfflineWallet(store: store)
    let keyAccount = OfflineWallet.integrityKeyAccount(ownerId: owner)
    let walletAccount = OfflineWallet.walletAccount(ownerId: owner)
    let fenceAccount = OfflineWallet.fenceAccount(ownerId: owner)
    var armed = true
    store.afterRead = { [owner] account, _ in
      guard armed, account == keyAccount else { return }
      armed = false
      _ = try writer.replace(
        ownerId: owner,
        expectedRevision: 0,
        contents: OfflineWalletContents(grants: [], receipts: [self.receipt(id: "receipt-unsent")])
      )
    }

    do {
      let outcome = try discarder.discardCorrupt(ownerId: owner)
      XCTFail("nothing was corrupt, yet discardCorrupt reported \(outcome) and deleted items")
    } catch let error as OfflineWalletError {
      XCTAssertEqual(error.failure, .notCorrupt)
    }
    store.afterRead = nil
    XCTAssertNotNil(store.items[walletAccount], "healthy wallet must survive")
    XCTAssertNotNil(store.items[fenceAccount], "verified fence must survive")
    let stored = try XCTUnwrap(try writer.load(ownerId: owner))
    XCTAssertEqual(stored.revision, 1)
    XCTAssertEqual(stored.contents.receipts.map(\.receiptId), ["receipt-unsent"])
  }

  /// Two instances both see an absent owner and both try the first write. Only
  /// one integrity key may exist afterwards and exactly one wallet; the loser
  /// gets `revision_conflict` and the winner's receipt is intact.
  func testConcurrentFirstWritesKeepOneKeyOneWalletAndConflictTheLoser() throws {
    let store = AttackStore()
    let first = OfflineWallet(store: store)
    let second = OfflineWallet(store: store)
    let keyAccount = OfflineWallet.integrityKeyAccount(ownerId: owner)
    let walletAccount = OfflineWallet.walletAccount(ownerId: owner)
    var armed = true
    var secondResult: OfflineWalletSnapshot?
    store.afterRead = { [owner] account, _ in
      guard armed, account == walletAccount else { return }
      armed = false
      secondResult = try second.replace(
        ownerId: owner,
        expectedRevision: 0,
        contents: OfflineWalletContents(grants: [], receipts: [self.receipt(id: "receipt-second")])
      )
    }
    assertFailure(.revisionConflict, "the instance that read stale absence must lose") {
      try first.replace(
        ownerId: owner,
        expectedRevision: 0,
        contents: OfflineWalletContents(grants: [], receipts: [self.receipt(id: "receipt-first")])
      )
    }
    store.afterRead = nil
    let secondKey = try XCTUnwrap(store.items[keyAccount])
    XCTAssertEqual(secondResult?.revision, 1)
    XCTAssertEqual(store.writesByAccount[keyAccount], 1, "the loser must not replace the winner's key")
    XCTAssertEqual(store.items[keyAccount], secondKey)
    let stored = try XCTUnwrap(try first.load(ownerId: owner))
    XCTAssertEqual(stored.contents.receipts.map(\.receiptId), ["receipt-second"])
  }

  /// A second instance replaces between the first instance's wallet write and
  /// its fence commit (it sees wallet ahead of fence and builds on it). The
  /// first instance's lagging fence commit must neither regress the fence nor
  /// turn a committed write into a failure.
  func testLaggingFenceCommitBehindAFasterWriterNeitherRegressesNorFails() throws {
    let store = AttackStore()
    let first = OfflineWallet(store: store)
    let second = OfflineWallet(store: store)
    let walletAccount = OfflineWallet.walletAccount(ownerId: owner)
    let fenceAccount = OfflineWallet.fenceAccount(ownerId: owner)
    let keyAccount = OfflineWallet.integrityKeyAccount(ownerId: owner)
    _ = try first.replace(ownerId: owner, expectedRevision: 0, contents: OfflineWalletContents(grants: [], receipts: []))

    var armed = true
    var secondResult: OfflineWalletSnapshot?
    store.afterWrite = { [owner] account in
      guard armed, account == walletAccount else { return }
      armed = false
      secondResult = try second.replace(
        ownerId: owner,
        expectedRevision: 2,
        contents: OfflineWalletContents(grants: [], receipts: [self.receipt(id: "receipt-a"), self.receipt(id: "receipt-b")])
      )
    }
    let firstResult = try first.replace(
      ownerId: owner,
      expectedRevision: 1,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-a")])
    )
    store.afterWrite = nil
    XCTAssertEqual(firstResult.revision, 2)
    XCTAssertEqual(secondResult?.revision, 3)
    let fence = try OfflineWallet.openFence(
      try XCTUnwrap(store.items[fenceAccount]), ownerId: owner, key: try XCTUnwrap(store.items[keyAccount]))
    XCTAssertEqual(fence, 3, "the slower fence commit must not move the fence backwards")
    let stored = try XCTUnwrap(try first.load(ownerId: owner))
    XCTAssertEqual(stored.revision, 3)
    XCTAssertEqual(stored.contents.receipts.map(\.receiptId), ["receipt-a", "receipt-b"])
  }

  // MARK: - Full-state rollback

  /// Restoring the wallet AND its fence from the same earlier point (both
  /// authentic, both from this owner) is indistinguishable from current state
  /// because the fence lives in the same store as the item it fences. The
  /// anti-rollback claim therefore only covers a partial restore.
  func testRestoringWalletAndFenceTogetherIsDetectedAsRollback() throws {
    let store = AttackStore()
    let wallet = OfflineWallet(store: store)
    let walletAccount = OfflineWallet.walletAccount(ownerId: owner)
    let fenceAccount = OfflineWallet.fenceAccount(ownerId: owner)
    _ = try wallet.replace(
      ownerId: owner, expectedRevision: 0,
      contents: OfflineWalletContents(grants: [grant(id: "grant-spent-later")], receipts: []))
    let walletAtOne = try XCTUnwrap(store.items[walletAccount])
    let fenceAtOne = try XCTUnwrap(store.items[fenceAccount])
    _ = try wallet.replace(
      ownerId: owner, expectedRevision: 1,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-proving-spend")]))

    store.items[walletAccount] = walletAtOne
    store.items[fenceAccount] = fenceAtOne
    assertFailure(.tampered, "a spent grant restored with its matching fence must not read as current") {
      try wallet.load(ownerId: owner)
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

  private func receipt(id: String) -> OfflineStoredReceipt {
    OfflineStoredReceipt(
      receiptId: id,
      kind: .result,
      payloadJson: "{\"schemaVersion\":\"offline-result-receipt-v1\",\"receiptId\":\"\(id)\"}"
    )
  }

  private func base64url(_ text: String) -> String {
    Data(text.utf8).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}

/// Compare-and-swap store double with hooks that run AFTER a read has taken
/// its value or AFTER a write has landed, so another `OfflineWallet` instance
/// can be interleaved at an exact store step.
private final class AttackStore: OfflineWalletSecureStore {
  var items: [String: Data] = [:]
  var writesByAccount: [String: Int] = [:]
  var afterRead: ((String, Data?) throws -> Void)?
  var afterWrite: ((String) throws -> Void)?

  func read(account: String) throws -> Data? {
    let value = items[account]
    try afterRead?(account, value)
    return value
  }

  func write(account: String, data: Data, ifUnchangedFrom previous: Data?) throws -> Bool {
    guard items[account] == previous else { return false }
    writesByAccount[account, default: 0] += 1
    items[account] = data
    try afterWrite?(account)
    return true
  }

  func delete(account: String, ifUnchangedFrom previous: Data) throws -> Bool {
    guard items[account] == previous else { return false }
    items.removeValue(forKey: account)
    return true
  }
}
