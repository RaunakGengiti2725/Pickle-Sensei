import Foundation
import XCTest

@testable import PickleVisionCore

/// Adversarial matrix for W05-01 (candidate 10af6490). Each test is one attack
/// at a failure boundary of `OfflineWallet`; a failing test is a reproduced
/// break, a passing one is an attack the candidate withstood. The store double
/// mirrors the Keychain adapter's compare-and-swap contract and lets the
/// attacker edit, remove or replant items and inject store errors.
final class OfflineWalletAttackTests: XCTestCase {
  private let ownerA = "0f9d5a7e-3c1b-4a2d-9b8e-1c2d3e4f5a6b"
  private let ownerB = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"

  // MARK: - Attack 1: JSON grammar parity (native scanner vs JSON.parse)

  /// The same corpus is asserted against `JSON.parse` in
  /// apps/mobile/__tests__/offlineWalletAttack.test.ts; the `accepted` column
  /// is the JSON.parse verdict, so a mismatch here is a payload the native
  /// side would store but JS could not read back (or vice versa).
  func testJsonGrammarParityCorpusMatchesJsonParse() {
    for (text, accepted) in OfflineWalletAttackCorpus.jsonParity {
      XCTAssertEqual(
        OfflineWalletShape.isJsonObject(text, maxBytes: OfflineWallet.Limits.maxReceiptPayloadBytes),
        accepted,
        "native verdict differs from JSON.parse for \(text.debugDescription)"
      )
    }
  }

  // MARK: - Attack 2: paired wallet + fence rollback

  /// The implementer claims "rollback to an older authentic envelope reads as
  /// tampered". The fence is a sibling item in the same store under the same
  /// protection, so whoever can replant the wallet can replant the fence.
  func testPairedWalletAndFenceRollbackIsDetected() throws {
    let store = AttackWalletStore()
    let wallet = OfflineWallet(store: store)
    let consumed = OfflineWalletContents(grants: [grant(id: "grant-1")], receipts: [receipt(id: "receipt-1")])
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 0, contents: consumed)
    let oldWallet = try XCTUnwrap(store.items[OfflineWallet.walletAccount(ownerId: ownerA)])
    let oldFence = try XCTUnwrap(store.items[OfflineWallet.fenceAccount(ownerId: ownerA)])

    // The grant is spent and the receipt submitted: revision 2 drops both.
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 1, contents: OfflineWalletContents(grants: [], receipts: []))
    XCTAssertEqual(try wallet.load(ownerId: ownerA)?.revision, 2)

    store.items[OfflineWallet.walletAccount(ownerId: ownerA)] = oldWallet
    store.items[OfflineWallet.fenceAccount(ownerId: ownerA)] = oldFence

    assertFailure(.tampered, "an authentic older wallet+fence pair must not read as current") {
      try wallet.load(ownerId: ownerA)
    }
  }

  // MARK: - Attack 3: fence corruption -> discardCorrupt -> replant

  /// Corrupting only the fence makes the owner unreadable; `discardCorrupt`
  /// then deletes wallet and fence but keeps the integrity key, so every
  /// envelope ever sealed for this owner verifies again once replanted.
  func testFenceCorruptionThenDiscardDoesNotResurrectOlderEnvelopes() throws {
    let store = AttackWalletStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(
      ownerId: ownerA,
      expectedRevision: 0,
      contents: OfflineWalletContents(grants: [grant(id: "grant-1")], receipts: [receipt(id: "receipt-1")])
    )
    let oldWallet = try XCTUnwrap(store.items[OfflineWallet.walletAccount(ownerId: ownerA)])
    let oldFence = try XCTUnwrap(store.items[OfflineWallet.fenceAccount(ownerId: ownerA)])
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 1, contents: OfflineWalletContents(grants: [], receipts: []))

    let fenceAccount = OfflineWallet.fenceAccount(ownerId: ownerA)
    var fence = try XCTUnwrap(store.items[fenceAccount])
    fence[fence.count - 1] ^= 0x01
    store.items[fenceAccount] = fence
    assertFailure(.tampered, "corrupt fence") { try wallet.load(ownerId: ownerA) }

    XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerA), .tampered)
    XCTAssertNil(store.items[OfflineWallet.walletAccount(ownerId: ownerA)])
    XCTAssertNil(store.items[fenceAccount])
    XCTAssertNotNil(store.items[OfflineWallet.integrityKeyAccount(ownerId: ownerA)], "key survives discard")

    store.items[OfflineWallet.walletAccount(ownerId: ownerA)] = oldWallet
    store.items[fenceAccount] = oldFence

    assertFailure(.tampered, "envelopes sealed before a discard must not verify afterwards") {
      try wallet.load(ownerId: ownerA)
    }
  }

  // MARK: - Attack 4: wallet item removed behind the wallet's back

  /// Deleting only the wallet item is indistinguishable from `clear`; the
  /// candidate reads it as "nothing stored". What it does preserve is the
  /// revision sequence: the next write continues after the fence, so a
  /// server that tracks the last seen revision can notice the gap.
  func testWalletItemRemovalLoadsAsAbsentButRevisionsDoNotRestart() throws {
    let store = AttackWalletStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(
      ownerId: ownerA, expectedRevision: 0,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-1")]))
    _ = try wallet.replace(
      ownerId: ownerA, expectedRevision: 1,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-1"), receipt(id: "receipt-2")]))

    store.items.removeValue(forKey: OfflineWallet.walletAccount(ownerId: ownerA))

    XCTAssertNil(try wallet.load(ownerId: ownerA), "a removed wallet item reads as absent (same as after clear)")
    assertFailure(.notCorrupt) { try wallet.discardCorrupt(ownerId: ownerA) }
    let next = try wallet.replace(
      ownerId: ownerA, expectedRevision: 0,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-3")]))
    XCTAssertEqual(next.revision, 3, "revision must continue past the fence, never restart at 1")
  }

  // MARK: - Attack 5: store error on the fence commit after the wallet write

  /// The wallet write is the commit point. If the fence commit then throws a
  /// store error (device locked, keychain I/O), `replace` throws too — but
  /// the new wallet is already stored. A caller that trusts "threw ⇒ nothing
  /// written" (as for every other thrown replace) has a wallet it does not
  /// know about, and its retry with the same expected revision conflicts.
  func testThrownReplaceLeavesStoredStateUnchanged() throws {
    let store = AttackWalletStore()
    let wallet = OfflineWallet(store: store)
    let before = try wallet.replace(
      ownerId: ownerA, expectedRevision: 0,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-1")]))
    let attempted = OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-1"), receipt(id: "receipt-2")])

    store.failWrite = { [ownerA] account in
      account == OfflineWallet.fenceAccount(ownerId: ownerA)
        ? OfflineWalletError(failure: .storageUnavailable, detail: "keychain locked", status: -25308)
        : nil
    }
    assertFailure(.storageUnavailable) {
      try wallet.replace(ownerId: ownerA, expectedRevision: before.revision, contents: attempted)
    }
    store.failWrite = nil

    let after = try wallet.load(ownerId: ownerA)
    XCTAssertEqual(after, before, "a thrown replace must not have committed the new wallet")
    XCTAssertNoThrow(
      try wallet.replace(ownerId: ownerA, expectedRevision: before.revision, contents: attempted),
      "retrying the failed replace with the same expected revision must not conflict"
    )
  }

  // MARK: - Attack 6: interleaved account switch across two instances

  func testInterleavedOwnerSwitchAcrossInstancesKeepsOwnersIsolated() throws {
    let store = AttackWalletStore()
    let first = OfflineWallet(store: store)
    let second = OfflineWallet(store: store)
    let a1 = OfflineWalletContents(grants: [grant(id: "a-grant")], receipts: [receipt(id: "a-receipt-1")])
    let b1 = OfflineWalletContents(grants: [grant(id: "b-grant")], receipts: [receipt(id: "b-receipt-1")])

    XCTAssertEqual(try first.replace(ownerId: ownerA, expectedRevision: 0, contents: a1).revision, 1)
    XCTAssertEqual(try second.replace(ownerId: ownerB, expectedRevision: 0, contents: b1).revision, 1)
    let bBytes = store.snapshot(ownerId: ownerB)

    try first.clear(ownerId: ownerA, expectedRevision: 1)
    XCTAssertEqual(store.snapshot(ownerId: ownerB), bBytes, "clearing A must not touch B's items")
    XCTAssertEqual(try second.load(ownerId: ownerB)?.contents, b1)

    let a2 = try second.replace(
      ownerId: ownerA, expectedRevision: 0,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "a-receipt-2")]))
    XCTAssertEqual(a2.revision, 2, "A's revision continues after its clear")

    let walletA = OfflineWallet.walletAccount(ownerId: ownerA)
    var corrupt = try XCTUnwrap(store.items[walletA])
    corrupt[corrupt.count - 1] ^= 0x01
    store.items[walletA] = corrupt
    assertFailure(.tampered) { try first.load(ownerId: ownerA) }
    XCTAssertEqual(try second.load(ownerId: ownerB)?.contents, b1, "A's corruption is invisible to B")
    XCTAssertEqual(try first.discardCorrupt(ownerId: ownerA), .tampered)
    XCTAssertEqual(store.snapshot(ownerId: ownerB), bBytes, "discarding A must not touch B's items")

    assertFailure(.revisionConflict, "B's revision is not A's") {
      try first.replace(ownerId: ownerB, expectedRevision: 2, contents: b1)
    }
    XCTAssertEqual(try first.replace(ownerId: ownerB, expectedRevision: 1, contents: b1).revision, 2)
    XCTAssertEqual(try second.replace(ownerId: ownerA, expectedRevision: 0, contents: a1).revision, 3)
  }

  // MARK: - Attack 7: bridge revision boundary doubles

  func testBridgeRevisionBoundaryDoubles() {
    let max = Double(OfflineWallet.maxRevision)
    XCTAssertEqual(try OfflineWallet.revision(fromBridge: -0.0), 0)
    XCTAssertEqual(try OfflineWallet.revision(fromBridge: max), OfflineWallet.maxRevision)
    XCTAssertEqual(try OfflineWallet.revision(fromBridge: max.nextDown), OfflineWallet.maxRevision - 1)
    XCTAssertEqual(try OfflineWallet.revision(fromBridge: 4_294_967_296), 1 << 32)

    let rejected: [Double] = [
      max.nextUp,  // 2^53, Number.MAX_SAFE_INTEGER + 1
      max + 2,
      -1,
      -Double.leastNonzeroMagnitude,
      Double.leastNonzeroMagnitude,
      0.5,
      1.0000000000000002,
      4_503_599_627_370_495.5,
      1e308,
      Double.greatestFiniteMagnitude,
      Double(UInt64.max),
      Double.infinity,
      -Double.infinity,
      Double.nan,
      Double.signalingNaN,
    ]
    for value in rejected {
      assertFailure(.invalidRevision, "\(value)") { try OfflineWallet.revision(fromBridge: value) }
    }
  }

  // MARK: - Attack 8: receipt identity replay across revisions

  /// A receipt id removed in one revision and re-added later is accepted: the
  /// wallet is storage, replay protection belongs to the server. Recorded so
  /// the boundary is explicit; a break would be a duplicate inside one wallet.
  func testReceiptIdentityReplayAcrossRevisionsIsStoredButNeverDuplicatedWithinAWallet() throws {
    let store = AttackWalletStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(
      ownerId: ownerA, expectedRevision: 0,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-1")]))
    _ = try wallet.replace(ownerId: ownerA, expectedRevision: 1, contents: OfflineWalletContents(grants: [], receipts: []))
    let replayed = try wallet.replace(
      ownerId: ownerA, expectedRevision: 2,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-1", kind: .unusedTicketReturn)]))
    XCTAssertEqual(replayed.revision, 3)
    XCTAssertEqual(replayed.contents.receipts.map(\.receiptId), ["receipt-1"])

    assertFailure(.invalidReceipt, "same id twice in one wallet") {
      try wallet.replace(
        ownerId: ownerA, expectedRevision: 3,
        contents: OfflineWalletContents(
          grants: [],
          receipts: [receipt(id: "receipt-1"), receipt(id: "receipt-1", kind: .unusedTicketReturn)]))
    }
    XCTAssertEqual(try wallet.load(ownerId: ownerA), replayed, "a rejected replace writes nothing")
    XCTAssertNoThrow(
      try wallet.replace(
        ownerId: ownerA, expectedRevision: 3,
        contents: OfflineWalletContents(grants: [grant(id: "shared-id")], receipts: [receipt(id: "shared-id")])),
      "grant and receipt namespaces are independent"
    )
  }

  // MARK: - Attack 9: integrity key swapped for an attacker-known key

  /// Replacing the 32-byte key with another 32-byte key makes wallet and
  /// fence unreadable; `discardCorrupt` then keeps the attacker's key because
  /// it has the right length, so everything the owner writes afterwards is
  /// sealed under a key the attacker knows.
  func testDiscardAfterKeySwapDoesNotKeepTheForeignKey() throws {
    let store = AttackWalletStore()
    let wallet = OfflineWallet(store: store)
    _ = try wallet.replace(
      ownerId: ownerA, expectedRevision: 0,
      contents: OfflineWalletContents(grants: [], receipts: [receipt(id: "receipt-1")]))
    let keyAccount = OfflineWallet.integrityKeyAccount(ownerId: ownerA)
    let foreignKey = Data(repeating: 0x42, count: OfflineWallet.integrityKeyBytes)
    store.items[keyAccount] = foreignKey

    assertFailure(.tampered) { try wallet.load(ownerId: ownerA) }
    XCTAssertEqual(try wallet.discardCorrupt(ownerId: ownerA), .tampered)
    XCTAssertNotEqual(store.items[keyAccount], foreignKey, "discard must not keep a key that verified nothing")
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

  private func base64url(_ text: String) -> String {
    Data(text.utf8).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}

/// Store double with the Keychain adapter's compare-and-swap contract. The
/// attacker edits `items` directly; `failWrite` throws a store error for a
/// chosen account BEFORE the write lands.
private final class AttackWalletStore: OfflineWalletSecureStore {
  var items: [String: Data] = [:]
  var failWrite: ((String) -> OfflineWalletError?)?

  func read(account: String) throws -> Data? {
    items[account]
  }

  func write(account: String, data: Data, ifUnchangedFrom previous: Data?) throws -> Bool {
    if let failure = failWrite?(account) { throw failure }
    guard items[account] == previous else { return false }
    items[account] = data
    return true
  }

  func delete(account: String, ifUnchangedFrom previous: Data) throws -> Bool {
    guard items[account] == previous else { return false }
    items.removeValue(forKey: account)
    return true
  }

  func snapshot(ownerId: String) -> [String: Data] {
    items.filter { $0.key.hasSuffix(".\(ownerId)") }
  }
}

/// Corpus shared with apps/mobile/__tests__/offlineWalletAttack.test.ts. The
/// second column is what `JSON.parse` + "is a non-array object" says for the
/// text (asserted there); the native scanner must agree byte for byte.
enum OfflineWalletAttackCorpus {
  static let jsonParity: [(String, Bool)] = [
    ("{}", true),
    ("{\"a\":1}", true),
    (" \t\n\r{\"a\":1}\r\n\t ", true),
    ("{\"a\":0e0}", true),
    ("{\"a\":-0.0e-0}", true),
    ("{\"a\":1E+0}", true),
    ("{\"a\":1e007}", true),
    ("{\"a\":1e400}", true),
    ("{\"a\":123456789012345678901234567890}", true),
    ("{\"a\":\"\\u0000\"}", true),
    ("{\"a\":\"\\uD83D\\uDE00\"}", true),
    ("{\"a\":\"\\ud800\"}", true),
    ("{\"a\":\"\\/\\b\\f\\n\\r\\t\\\"\\\\\"}", true),
    ("{\"a\":\"\u{7f}\"}", true),
    ("{\"a\":\"\u{2028}\u{2029}\"}", true),
    ("{\"a\u{200b}\":1}", true),
    ("{\"\":{\"\":{\"\":{}}}}", true),
    ("{\"a\":[{\"b\":[{\"c\":{}}]}]}", true),
    ("{\"a\":1,\"a\":2}", true),
    ("{\"__proto__\":1}", true),
    ("{\"a\":\"\\\"}\"}", true),
    ("{\"a\":[]}", true),
    ("{\"a\":null,\"b\":true,\"c\":false}", true),
    ("", false),
    (" ", false),
    ("{", false),
    ("{\"a\":1", false),
    ("{\"a\":\"", false),
    ("{\"a\":\"\\\"}", false),
    ("[{}]", false),
    ("\"str\"", false),
    ("1", false),
    ("null", false),
    ("{\"a\":1}}", false),
    ("{{\"a\":1}}", false),
    ("{\"a\":1}\u{0}", false),
    ("{\"a\":1}\u{2028}", false),
    ("\u{feff}{\"a\":1}", false),
    ("\u{a0}{\"a\":1}", false),
    ("\u{b}{\"a\":1}", false),
    ("\u{c}{\"a\":1}", false),
    ("{\"a\":\"\t\"}", false),
    ("{\"a\":\"\n\"}", false),
    ("{\"a\":\"\u{1}\"}", false),
    ("{\"a\":.5}", false),
    ("{\"a\":5.}", false),
    ("{\"a\":05}", false),
    ("{\"a\":+5}", false),
    ("{\"a\":-}", false),
    ("{\"a\":-01}", false),
    ("{\"a\":1.5e}", false),
    ("{\"a\":1e-}", false),
    ("{\"a\":1e5.5}", false),
    ("{\"a\":0x10}", false),
    ("{\"a\":Infinity}", false),
    ("{\"a\":NaN}", false),
    ("{\"a\":nul}", false),
    ("{\"a\":NULL}", false),
    ("{\"a\":truE}", false),
    ("{\"a\":nulls}", false),
    ("{\"a\":\"\\'\"}", false),
    ("{\"a\":\"\\U0041\"}", false),
    ("{\"a\":\"\\u004\"}", false),
    ("{\"a\":\"\\uZZZZ\"}", false),
    ("{\"a\":\"\\a\"}", false),
    ("{'a':1}", false),
    ("{\"a\":1,}", false),
    ("{,}", false),
    ("{\"a\"}", false),
    ("{\"a\":}", false),
    ("{\"a\" 1}", false),
    ("{\"a\":1 \"b\":2}", false),
    ("{\"a\":[1,2,]}", false),
    ("{\"a\":[,1]}", false),
    ("{\"a\":[1 2]}", false),
    ("{\"a\":{\"b\":1,}}", false),
    ("{\"a\":{,\"b\":1}}", false),
    ("{\"a\":[1}", false),
    ("{\"a\":{1]}", false),
    ("{]", false),
    ("{\"a\":1}/**/", false),
    ("{\"a\":1}//", false),
    ("{\"a\":\"x\"}garbage", false),
  ]
}
