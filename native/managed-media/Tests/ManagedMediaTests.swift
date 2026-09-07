import Darwin
import Foundation
import XCTest

@testable import PickleManagedMedia

final class ManagedMediaTests: XCTestCase {
  private let owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  private let otherOwner = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  private let operation = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
  private let laterOperation = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
  private let fixedID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
  private var fixture: TemporaryMediaFixture!

  override func setUpWithError() throws {
    fixture = try TemporaryMediaFixture()
  }

  override func tearDownWithError() throws {
    try fixture.cleanup()
    fixture = nil
  }

  func testCreatesNativeVersionedRolesAndOnlyDeletesExplicitCandidates() throws {
    let store = try fixture.store()
    var assets = [ManagedMediaAsset]()
    for role in ManagedMediaRole.allCases {
      let asset = try fixture.create(store, owner: owner, operation: operation, role: role)
      assets.append(asset)
      XCTAssertEqual(asset.relativePath, "managed-v1/\(owner)/\(operation)/\(asset.assetID)/\(role.filename)")
      XCTAssertTrue(ManagedMediaFormat.isUUID(asset.assetID))
      XCTAssertEqual(try fixture.bytes(fixture.url(asset)), Data("native-created".utf8))
    }
    XCTAssertEqual(Set(assets.map(\.assetID)).count, 3)
    let unrelated = fixture.url(assets[0]).deletingLastPathComponent().appendingPathComponent("keep.mov")
    try fixture.writeNew(unrelated)
    let legacy = fixture.captures.appendingPathComponent("stroke-legacy.mov")
    try fixture.writeNew(legacy)
    let foreign = try fixture.create(store, owner: otherOwner, operation: operation)
    XCTAssertEqual(store.delete(owner: owner, candidates: assets.map { .managed($0.reference) }).map(\.status),
                   [.deleted, .deleted, .deleted])
    for asset in assets {
      XCTAssertFalse(fixture.exists(fixture.url(asset)))
      XCTAssertTrue(fixture.exists(fixture.record(asset.assetID)))
      XCTAssertTrue(fixture.exists(fixture.url(asset).deletingLastPathComponent()))
    }
    XCTAssertEqual(try fixture.bytes(unrelated), Data("unrelated".utf8))
    XCTAssertTrue(fixture.exists(legacy))
    XCTAssertTrue(fixture.exists(fixture.url(foreign)))
  }

  func testCanonicalOwnersAndGuestAreAcceptedButSignedOutAndMalformedNamespacesAreNot() throws {
    let store = try fixture.store()
    for version in 1...8 {
      let validOwner = "aaaaaaaa-aaaa-\(version)aaa-8aaa-aaaaaaaaaaaa"
      let asset = try fixture.create(store, owner: validOwner, operation: operation)
      XCTAssertEqual(delete(store, asset, owner: validOwner).status, .deleted)
    }
    let guest = try fixture.create(store, owner: "device-guest", operation: operation)
    XCTAssertEqual(delete(store, guest, owner: "device-guest").status, .deleted)
    let invalidOwners = [
      "", "signed-out", "SIGNED-OUT", "device-guest/..", "device-guest\0", owner.uppercased(),
      " " + owner, owner + " ", "00000000-0000-0000-0000-000000000000",
      "aaaaaaaa-aaaa-9aaa-8aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa",
      "../" + owner, owner + "/x", owner + "%2f", "https://example.invalid", owner + "\n",
    ]
    for invalid in invalidOwners {
      XCTAssertThrowsError(try store.createNewAsset(owner: invalid, operationID: operation, role: .movie, data: Data())) {
        XCTAssertEqual(($0 as? ManagedMediaError)?.issue, .invalidOwner)
      }
      XCTAssertEqual(store.delete(owner: invalid, candidates: [.managed(guest.reference)]).first?.status, .rejectedUnsafe)
    }
    for invalid in invalidOwners + ["device-guest", operation.uppercased(), operation + "%00"] {
      XCTAssertThrowsError(try store.createNewAsset(owner: owner, operationID: invalid, role: .movie, data: Data())) {
        XCTAssertEqual(($0 as? ManagedMediaError)?.issue, .invalidOperation)
      }
    }
  }

  func testWrongOwnerAndGuestCannotDeleteEachOthersAssetsEvenAfterRelaunch() throws {
    let first = try fixture.store()
    let mine = try fixture.create(first, owner: owner, operation: operation)
    let guest = try fixture.create(first, owner: "device-guest", operation: operation)
    let foreign = try fixture.create(first, owner: otherOwner, operation: operation)
    let second = try fixture.store()
    for (asset, requestOwner) in [(mine, otherOwner), (foreign, owner), (guest, owner), (mine, "device-guest")] {
      XCTAssertEqual(delete(second, asset, owner: requestOwner).status, .preservedOtherOwner)
      XCTAssertTrue(fixture.exists(fixture.url(asset)))
    }
    XCTAssertEqual(delete(second, mine).status, .deleted)
    XCTAssertEqual(delete(second, guest, owner: "device-guest").status, .deleted)
    XCTAssertEqual(delete(second, foreign, owner: otherOwner).status, .deleted)
  }

  func testCallerOwnerURIExclusiveClaimNeverEstablishesOwnership() throws {
    let store = try fixture.store()
    let asset = try fixture.create(store, owner: owner, operation: operation)
    for exclusive in [true, false] {
      let candidate = ManagedMediaDeletionCandidate.unverified(owner: owner, uri: fixture.url(asset).absoluteString, exclusive: exclusive)
      XCTAssertEqual(store.delete(owner: owner, candidates: [candidate]).first?.status, .rejectedUnsafe)
    }
    let forged = try JSONSerialization.data(withJSONObject: [
      "owner": owner, "uri": fixture.url(asset).absoluteString, "exclusive": true,
    ], options: [.sortedKeys, .withoutEscapingSlashes])
    XCTAssertEqual(store.delete(owner: owner, candidates: [.managed(.init(serialized: forged))]).first?.status, .rejectedUnsafe)
    XCTAssertEqual(try fixture.bytes(fixture.url(asset)), Data("native-created".utf8))
  }

  func testFlatLegacyFilesAndUnverifiedMissingPathsRemainAmbiguous() throws {
    let store = try fixture.store()
    for name in ["stroke-old.mov", "poster-old.jpg", "pose-old.json"] {
      let url = fixture.captures.appendingPathComponent(name)
      try fixture.writeNew(url)
      for uri in [url.path, url.absoluteString] {
        let candidate = ManagedMediaDeletionCandidate.unverified(owner: owner, uri: uri, exclusive: true)
        XCTAssertEqual(store.delete(owner: owner, candidates: [candidate]).first?.status, .preservedAmbiguous)
      }
      XCTAssertEqual(try fixture.bytes(url), Data("unrelated".utf8))
    }
    let missing = fixture.captures.appendingPathComponent("absent.mov")
    XCTAssertEqual(store.delete(owner: owner, candidates: [.unverified(owner: owner, uri: missing.path, exclusive: true)]).first?.status,
                   .preservedAmbiguous)
    XCTAssertEqual(store.delete(owner: owner, candidates: [.unverified(owner: otherOwner, uri: missing.path, exclusive: true)]).first?.status,
                   .preservedOtherOwner)
  }

  func testAllUnverifiedPathAttacksAreRejectedWithoutTouchingSentinels() throws {
    let store = try fixture.store()
    let inside = fixture.captures.appendingPathComponent("keep.mov")
    let outside = fixture.base.appendingPathComponent("outside.mov")
    try fixture.writeNew(inside)
    try fixture.writeNew(outside)
    let prefix = fixture.captures.path
    let attacks = [
      "../outside.mov", prefix + "/../outside.mov", prefix + "/./keep.mov", prefix + "//keep.mov",
      prefix + "/keep.mov/", prefix + "/keep.mov\0suffix", prefix + "/keep.mov\n", prefix + "/..\\outside.mov",
      prefix + "/%2e%2e/outside.mov", prefix + "/%2E%2E%2foutside.mov", prefix + "/%252e%252e%252foutside.mov",
      prefix + "%2fkeep.mov", prefix + "%2Fkeep.mov", prefix + "/keep.mov%00", prefix + "/keep%5cmov",
      "file://remote.invalid" + prefix + "/keep.mov", "file://localhost" + prefix + "/keep.mov",
      "file://user@localhost" + prefix + "/keep.mov", "file://" + prefix + "/keep.mov?x=y",
      "file://" + prefix + "/keep.mov#fragment", "https://example.invalid/keep.mov", "http://example.invalid/keep.mov",
      "ph://keep.mov", "content://keep.mov", "data:video/quicktime,keep.mov", outside.path,
      prefix + "-sibling/keep.mov", prefix + "/nested/keep.mov", prefix + "/keep.MOV", prefix + "/keep.txt", prefix,
    ]
    for uri in attacks {
      let result = store.delete(owner: owner, candidates: [.unverified(owner: owner, uri: uri, exclusive: true)])
      XCTAssertEqual(result.first?.status, .rejectedUnsafe, uri.debugDescription)
    }
    XCTAssertEqual(try fixture.bytes(inside), Data("unrelated".utf8))
    XCTAssertEqual(try fixture.bytes(outside), Data("unrelated".utf8))
  }

  func testStrictReferencesRejectEveryFieldForgeryAndPathAttack() throws {
    let store = try fixture.store()
    let asset = try fixture.create(store, owner: owner, operation: operation)
    let mutations: [(String, Any)] = [
      ("version", 0), ("version", 2), ("authorityID", fixedID), ("owner", otherOwner),
      ("owner", "device-guest"), ("owner", "signed-out"), ("owner", owner.uppercased()),
      ("operationID", laterOperation), ("operationID", "../escape"), ("assetID", fixedID),
      ("assetID", "../../escape"), ("role", "poster"), ("role", "thumbnail"), ("role", "movie.mov"),
      ("role", "../pose"), ("role", "movie\0"), ("parents", []), ("exclusive", true),
    ]
    for (field, value) in mutations {
      let forged = try mutate(asset.reference) { $0[field] = value }
      XCTAssertEqual(store.delete(owner: owner, candidates: [.managed(forged)]).first?.status, .rejectedUnsafe, field)
    }
    let paths = [
      "../" + asset.relativePath, "/" + asset.relativePath, asset.relativePath + "/", asset.relativePath + "\0",
      asset.relativePath + "?query", asset.relativePath + "#fragment", asset.relativePath.replacingOccurrences(of: "/", with: "%2f"),
      asset.relativePath.replacingOccurrences(of: "/", with: "%2F"), asset.relativePath.replacingOccurrences(of: "/", with: "\\"),
      asset.relativePath.replacingOccurrences(of: "/", with: "//"), "managed-v2/" + asset.relativePath,
      "file://" + fixture.url(asset).path, "https://example.invalid/" + asset.relativePath,
      "managed-v1/\(owner)/\(operation)/\(asset.assetID)/../movie.mov",
      "managed-v1/\(owner)/\(operation)/\(asset.assetID)/%252fmovie.mov",
      "managed-v1/\(owner)/\(operation)/\(asset.assetID)/poster.jpg",
    ]
    for path in paths {
      let forged = try mutate(asset.reference) { $0["relativePath"] = path }
      XCTAssertEqual(store.delete(owner: owner, candidates: [.managed(forged)]).first?.status, .rejectedUnsafe)
    }
    var envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: asset.reference.serialized) as? [String: Any])
    envelope["authentication"] = Data(repeating: 0, count: 32).base64EncodedString()
    let forged = ManagedMediaReference(serialized: try canonicalJSON(envelope))
    XCTAssertEqual(store.delete(owner: owner, candidates: [.managed(forged)]).first?.status, .rejectedUnsafe)
    XCTAssertTrue(fixture.exists(fixture.url(asset)))
  }

  func testMalformedNoncanonicalDuplicateAndOversizedReferencesAreNotMissingSuccess() throws {
    let store = try fixture.store()
    let asset = try fixture.create(store, owner: owner, operation: operation)
    XCTAssertEqual(delete(store, asset).status, .deleted)
    let string = try XCTUnwrap(String(data: asset.reference.serialized, encoding: .utf8))
    let duplicate = string.replacingOccurrences(of: "\"version\":1", with: "\"version\":1,\"version\":1")
    let escaped = string.replacingOccurrences(of: "/", with: "\\/")
    let inputs = [
      Data(), Data("{}".utf8), Data("null".utf8), Data("[]".utf8), Data("https://example.invalid/file.mov".utf8),
      Data("\0".utf8), Data(repeating: 32, count: ManagedMediaFormat.maximumReferenceBytes + 1),
      Data((" " + string).utf8), Data(duplicate.utf8), Data(escaped.utf8),
      try canonicalJSON(["payload": ["owner": owner], "authentication": "not-base64"]),
    ]
    for data in inputs {
      let result = store.delete(owner: owner, candidates: [.managed(.init(serialized: data))])
      XCTAssertEqual(result.first?.status, .rejectedUnsafe)
    }
    XCTAssertEqual(delete(store, asset).status, .alreadyMissing)
  }

  func testReferenceFromAnotherNativeRootCannotAuthorizeDeletion() throws {
    let first = try fixture.store(hooks: .init(makeAssetID: { self.fixedID }))
    let asset = try fixture.create(first, owner: owner, operation: operation)
    let other = try TemporaryMediaFixture()
    defer { XCTAssertNoThrow(try other.cleanup()) }
    let second = try other.store(hooks: .init(makeAssetID: { self.fixedID }))
    let differentAsset = try other.create(second, owner: owner, operation: operation)
    XCTAssertEqual(second.delete(owner: owner, candidates: [.managed(asset.reference)]).first?.status, .rejectedUnsafe)
    XCTAssertEqual(try other.bytes(other.url(differentAsset)), Data("native-created".utf8))
    XCTAssertTrue(fixture.exists(fixture.url(asset)))
  }

  func testExistingUnrecognizedNamespaceIsNeverAdoptedOrRekeyed() throws {
    try fixture.directory(fixture.namespace)
    let legacy = fixture.namespace.appendingPathComponent("keep.mov")
    try fixture.writeNew(legacy)
    XCTAssertThrowsError(try fixture.store())
    XCTAssertTrue(fixture.exists(legacy))
    XCTAssertFalse(fixture.exists(fixture.authority))
    XCTAssertFalse(fixture.exists(fixture.records))
  }

  func testRootURLAttacksAreRejectedAtInitialization() throws {
    let root = fixture.captures.path
    let attacks = [
      "file://remote.invalid" + root, "file://localhost" + root, "https://example.invalid/Captures",
      "file://" + root + "?x=1", "file://" + root + "#x", "file://" + root + "/../Captures",
      "file://" + root.replacingOccurrences(of: "/Captures", with: "%2fCaptures"),
      "file://" + root + "%00", "file://" + root.replacingOccurrences(of: "/Captures", with: "/./Captures"),
    ]
    for value in attacks {
      let url = try XCTUnwrap(URL(string: value))
      XCTAssertThrowsError(try ManagedMediaStore(trustedCapturesRoot: url), value)
    }
    XCTAssertFalse(fixture.exists(fixture.namespace))
  }

  func testSymlinkAtRootOrAnyParentOrLeafIsRejected() throws {
    for level in 0...6 {
      let f = try TemporaryMediaFixture()
      defer { XCTAssertNoThrow(try f.cleanup()) }
      let store = try f.store()
      let asset = try f.create(store, owner: owner, operation: operation)
      let leaf = f.url(asset)
      let directories = [
        f.container, f.captures, f.namespace,
        f.namespace.appendingPathComponent(owner),
        f.namespace.appendingPathComponent(owner).appendingPathComponent(operation),
        leaf.deletingLastPathComponent(), leaf,
      ]
      let target = directories[level]
      let saved = f.base.appendingPathComponent("saved-\(level)")
      try f.move(target, to: saved)
      try f.symlink(target, to: saved)
      XCTAssertEqual(store.delete(owner: owner, candidates: [.managed(asset.reference)]).first?.status, .rejectedUnsafe, "level \(level)")
      XCTAssertTrue(f.exists(target))
      let retained = saved.appendingPathComponent(String(leaf.path.dropFirst(target.path.count)))
      if level == 6 {
        XCTAssertEqual(try f.bytes(saved), Data("native-created".utf8))
      } else {
        XCTAssertEqual(try f.bytes(retained), Data("native-created".utf8))
      }
      if level <= 2 { XCTAssertThrowsError(try ManagedMediaStore(trustedCapturesRoot: f.captures)) }
    }
  }

  func testLeafSymlinkToUnrelatedFileIsNotUnlinkedOrFollowed() throws {
    let store = try fixture.store()
    let asset = try fixture.create(store, owner: owner, operation: operation)
    let sentinel = fixture.base.appendingPathComponent("sentinel.mov")
    try fixture.writeNew(sentinel)
    try fixture.unlink(fixture.url(asset))
    try fixture.symlink(fixture.url(asset), to: sentinel)
    XCTAssertEqual(delete(store, asset).status, .rejectedUnsafe)
    XCTAssertTrue(fixture.exists(fixture.url(asset)))
    XCTAssertEqual(try fixture.bytes(sentinel), Data("unrelated".utf8))
  }

  func testDirectoryAndFIFOLeavesAreRejectedWithoutRecursiveDeletionOrBlocking() throws {
    let store = try fixture.store()
    let directoryAsset = try fixture.create(store, owner: owner, operation: operation)
    let directoryURL = fixture.url(directoryAsset)
    try fixture.unlink(directoryURL)
    try fixture.directory(directoryURL)
    let sentinel = directoryURL.appendingPathComponent("keep.mov")
    try fixture.writeNew(sentinel)
    XCTAssertEqual(delete(store, directoryAsset).status, .rejectedUnsafe)
    XCTAssertTrue(fixture.exists(sentinel))
    let fifoAsset = try fixture.create(store, owner: owner, operation: operation)
    let fifo = fixture.url(fifoAsset)
    try fixture.unlink(fifo)
    XCTAssertEqual(mkfifo(fifo.path, mode_t(0o600)), 0)
    XCTAssertEqual(delete(store, fifoAsset).status, .rejectedUnsafe)
    XCTAssertTrue(fixture.exists(fifo))
    let legacyDirectory = fixture.captures.appendingPathComponent("legacy.mov")
    try fixture.directory(legacyDirectory)
    XCTAssertEqual(store.delete(owner: owner, candidates: [.unverified(owner: owner, uri: legacyDirectory.path, exclusive: true)]).first?.status,
                   .rejectedUnsafe)
  }

  func testHardLinksArePreservedForBothInsideAndOutsideTheManagedNamespace() throws {
    let store = try fixture.store()
    for outside in [false, true] {
      let asset = try fixture.create(store, owner: owner, operation: operation)
      let link = (outside ? fixture.base : fixture.captures).appendingPathComponent("link-\(asset.assetID).mov")
      try fixture.hardlink(link, to: fixture.url(asset))
      let result = delete(store, asset)
      XCTAssertEqual(result.status, .preservedAmbiguous)
      XCTAssertEqual(result.issue, .hardLinked)
      XCTAssertTrue(fixture.exists(fixture.url(asset)))
      XCTAssertEqual(try fixture.bytes(link), Data("native-created".utf8))
    }
  }

  func testNativeSharedMarkerIsIrreversibleAcrossReopenAndOldReferenceReplay() throws {
    let store = try fixture.store()
    let asset = try fixture.create(store, owner: owner, operation: operation)
    XCTAssertThrowsError(try store.preserveAsShared(owner: otherOwner, reference: asset.reference))
    try store.preserveAsShared(owner: owner, reference: asset.reference)
    try store.preserveAsShared(owner: owner, reference: asset.reference)
    let reopened = try fixture.store()
    let result = delete(reopened, asset)
    XCTAssertEqual(result.status, .preservedAmbiguous)
    XCTAssertEqual(result.issue, .shared)
    XCTAssertEqual(try fixture.bytes(fixture.url(asset)), Data("native-created".utf8))
  }

  func testDamagedOrMissingProvenanceNeverAllowsDeletion() throws {
    let store = try fixture.store()
    let missing = try fixture.create(store, owner: owner, operation: operation)
    try fixture.unlink(fixture.record(missing.assetID))
    XCTAssertEqual(delete(store, missing).status, .preservedAmbiguous)
    let damaged = try fixture.create(store, owner: owner, operation: operation)
    try fixture.overwrite(fixture.record(damaged.assetID), Data("{}".utf8))
    XCTAssertEqual(delete(store, damaged).status, .preservedAmbiguous)
    let emptyShared = try fixture.create(store, owner: owner, operation: operation)
    try fixture.writeNew(fixture.shared(emptyShared.assetID), Data())
    XCTAssertEqual(delete(store, emptyShared).status, .preservedAmbiguous)
    for asset in [missing, damaged, emptyShared] { XCTAssertTrue(fixture.exists(fixture.url(asset))) }
  }

  func testAuthorityRecordsAndSharedMarkersCannotBeSymlinksOrHardLinks() throws {
    for targetKind in 0...3 {
      let f = try TemporaryMediaFixture()
      defer { XCTAssertNoThrow(try f.cleanup()) }
      let store = try f.store()
      let asset = try f.create(store, owner: owner, operation: operation)
      let original: URL
      if targetKind == 0 { original = f.authority }
      else if targetKind == 1 { original = f.records }
      else if targetKind == 2 { original = f.record(asset.assetID) }
      else {
        try store.preserveAsShared(owner: owner, reference: asset.reference)
        original = f.shared(asset.assetID)
      }
      let saved = f.base.appendingPathComponent("saved-metadata")
      try f.move(original, to: saved)
      try f.symlink(original, to: saved)
      XCTAssertEqual(store.delete(owner: owner, candidates: [.managed(asset.reference)]).first?.status, .rejectedUnsafe)
      XCTAssertTrue(f.exists(f.url(asset)))
    }
    let store = try fixture.store()
    let asset = try fixture.create(store, owner: owner, operation: operation)
    let link = fixture.base.appendingPathComponent("authority-link")
    try fixture.hardlink(link, to: fixture.authority)
    XCTAssertEqual(delete(store, asset).status, .preservedAmbiguous)
    XCTAssertTrue(fixture.exists(fixture.url(asset)))
  }

  func testRootOrManagedAuthorityReplacementFailsClosed() throws {
    for replaceRoot in [true, false] {
      let f = try TemporaryMediaFixture()
      defer { XCTAssertNoThrow(try f.cleanup()) }
      let store = try f.store()
      let asset = try f.create(store, owner: owner, operation: operation)
      if replaceRoot {
        let saved = f.base.appendingPathComponent("saved-captures")
        try f.move(f.captures, to: saved)
        try f.directory(f.captures)
        XCTAssertEqual(store.delete(owner: owner, candidates: [.managed(asset.reference)]).first?.status, .rejectedUnsafe)
        XCTAssertTrue(f.exists(saved.appendingPathComponent(asset.relativePath)))
      } else {
        let saved = f.base.appendingPathComponent("saved-authority")
        try f.move(f.authority, to: saved)
        try f.writeNew(f.authority, Data("{}".utf8))
        XCTAssertEqual(store.delete(owner: owner, candidates: [.managed(asset.reference)]).first?.status, .rejectedUnsafe)
        XCTAssertTrue(f.exists(f.url(asset)))
      }
    }
  }

  func testReplacementBetweenInspectionAndDeleteIsPreserved() throws {
    var target: URL!
    let saved = fixture.base.appendingPathComponent("original.mov")
    let store = try fixture.store(hooks: .init(afterInspection: { _ in
      try self.fixture.move(target, to: saved)
      try self.fixture.writeNew(target, Data("replacement".utf8))
    }))
    let asset = try fixture.create(store, owner: owner, operation: operation)
    target = fixture.url(asset)
    XCTAssertEqual(delete(store, asset).status, .rejectedUnsafe)
    XCTAssertEqual(try fixture.bytes(target), Data("replacement".utf8))
    XCTAssertEqual(try fixture.bytes(saved), Data("native-created".utf8))
  }

  func testParentReplacementBetweenInspectionAndDeleteIsPreservedAtEveryLevel() throws {
    for level in 0...5 {
      let f = try TemporaryMediaFixture()
      defer { XCTAssertNoThrow(try f.cleanup()) }
      var target: URL!
      let saved = f.base.appendingPathComponent("saved-parent")
      let store = try f.store(hooks: .init(afterInspection: { _ in
        try f.move(target, to: saved)
        try f.directory(target)
      }))
      let asset = try f.create(store, owner: owner, operation: operation)
      let leaf = f.url(asset)
      target = [f.container, f.captures, f.namespace,
                f.namespace.appendingPathComponent(owner),
                f.namespace.appendingPathComponent(owner).appendingPathComponent(operation),
                leaf.deletingLastPathComponent()][level]
      XCTAssertEqual(store.delete(owner: owner, candidates: [.managed(asset.reference)]).first?.status, .rejectedUnsafe, "level \(level)")
      XCTAssertTrue(f.exists(saved.appendingPathComponent(String(leaf.path.dropFirst(target.path.count)))))
    }
  }

  func testHardLinkAndSharedMarkerIntroducedAfterInspectionArePreserved() throws {
    for makeShared in [false, true] {
      let f = try TemporaryMediaFixture()
      defer { XCTAssertNoThrow(try f.cleanup()) }
      var asset: ManagedMediaAsset!
      let link = f.base.appendingPathComponent("late-link.mov")
      let store = try f.store(hooks: .init(afterInspection: { _ in
        if makeShared { try f.writeNew(f.shared(asset.assetID), Data()) }
        else { try f.hardlink(link, to: f.url(asset)) }
      }))
      asset = try f.create(store, owner: owner, operation: operation)
      XCTAssertEqual(store.delete(owner: owner, candidates: [.managed(asset.reference)]).first?.status, .preservedAmbiguous)
      XCTAssertTrue(f.exists(f.url(asset)))
    }
  }

  func testSymlinkIntroducedAfterInspectionIsPreservedWithItsTarget() throws {
    var leaf: URL!
    let sentinel = fixture.base.appendingPathComponent("sentinel.mov")
    try fixture.writeNew(sentinel)
    let store = try fixture.store(hooks: .init(afterInspection: { _ in
      try self.fixture.unlink(leaf)
      try self.fixture.symlink(leaf, to: sentinel)
    }))
    let asset = try fixture.create(store, owner: owner, operation: operation)
    leaf = fixture.url(asset)
    XCTAssertEqual(delete(store, asset).status, .rejectedUnsafe)
    XCTAssertTrue(fixture.exists(leaf))
    XCTAssertEqual(try fixture.bytes(sentinel), Data("unrelated".utf8))
  }

  func testSamePathReuseAndInPlaceMutationAreRejected() throws {
    let store = try fixture.store()
    let reused = try fixture.create(store, owner: owner, operation: operation)
    XCTAssertEqual(delete(store, reused).status, .deleted)
    try fixture.writeNew(fixture.url(reused), Data("native-created".utf8))
    XCTAssertEqual(delete(store, reused).status, .rejectedUnsafe)
    let changed = try fixture.create(store, owner: owner, operation: operation)
    try fixture.overwrite(fixture.url(changed), Data("changed-content".utf8))
    XCTAssertEqual(delete(store, changed).status, .rejectedUnsafe)
    XCTAssertEqual(try fixture.bytes(fixture.url(reused)), Data("native-created".utf8))
    XCTAssertEqual(try fixture.bytes(fixture.url(changed)), Data("changed-content".utf8))
  }

  func testNativeIDCollisionAndDeletedReservationAreNeverReused() throws {
    let store = try fixture.store(hooks: .init(makeAssetID: { self.fixedID }))
    let asset = try fixture.create(store, owner: owner, operation: operation)
    for role in ManagedMediaRole.allCases {
      XCTAssertThrowsError(try store.createNewAsset(owner: owner, operationID: operation, role: role, data: Data())) {
        XCTAssertEqual(($0 as? ManagedMediaError)?.issue, .collision)
      }
    }
    XCTAssertEqual(try fixture.bytes(fixture.url(asset)), Data("native-created".utf8))
    XCTAssertEqual(delete(store, asset).status, .deleted)
    let reopened = try fixture.store(hooks: .init(makeAssetID: { self.fixedID }))
    XCTAssertThrowsError(try reopened.createNewAsset(owner: owner, operationID: operation, role: .movie, data: Data())) {
      XCTAssertEqual(($0 as? ManagedMediaError)?.issue, .collision)
    }
    XCTAssertEqual(delete(reopened, asset).status, .alreadyMissing)
  }

  func testPreexistingAssetDirectoryCollisionPreservesEveryExistingByte() throws {
    let store = try fixture.store(hooks: .init(makeAssetID: { self.fixedID }))
    let ownerDirectory = fixture.namespace.appendingPathComponent(owner)
    let operationDirectory = ownerDirectory.appendingPathComponent(operation)
    let assetDirectory = operationDirectory.appendingPathComponent(fixedID)
    for directory in [ownerDirectory, operationDirectory, assetDirectory] { try fixture.directory(directory) }
    let sentinel = assetDirectory.appendingPathComponent("movie.mov")
    try fixture.writeNew(sentinel)
    fixture.rememberAsset(owner: owner, operation: operation, assetID: fixedID, role: .movie)
    XCTAssertThrowsError(try store.createNewAsset(owner: owner, operationID: operation, role: .movie, data: Data())) {
      XCTAssertEqual(($0 as? ManagedMediaError)?.issue, .collision)
    }
    XCTAssertEqual(try fixture.bytes(sentinel), Data("unrelated".utf8))
    XCTAssertTrue(fixture.exists(fixture.record(fixedID)))
  }

  func testPermissionFailureIsRetryableAndBatchContinuesWithExactPerCandidateOutcomes() throws {
    XCTAssertNotEqual(geteuid(), 0)
    let store = try fixture.store()
    let blocked = try fixture.create(store, owner: owner, operation: operation)
    let healthy = try fixture.create(store, owner: owner, operation: operation, role: .poster)
    let foreign = try fixture.create(store, owner: otherOwner, operation: operation)
    let hardLinked = try fixture.create(store, owner: owner, operation: operation, role: .pose)
    let link = fixture.base.appendingPathComponent("shared-pose.json")
    try fixture.hardlink(link, to: fixture.url(hardLinked))
    let parent = fixture.url(blocked).deletingLastPathComponent()
    try fixture.mode(parent, 0o500)
    let candidates: [ManagedMediaDeletionCandidate] = [
      .managed(blocked.reference), .managed(healthy.reference), .managed(foreign.reference),
      .managed(hardLinked.reference), .managed(.init(serialized: Data("{}".utf8))), .managed(healthy.reference),
    ]
    let results = store.delete(owner: owner, candidates: candidates)
    XCTAssertEqual(results.map(\.status), [.retryable, .deleted, .preservedOtherOwner, .preservedAmbiguous, .rejectedUnsafe, .alreadyMissing])
    XCTAssertEqual(results[0].errnoCode, EACCES)
    XCTAssertTrue(fixture.exists(fixture.url(blocked)))
    XCTAssertTrue(fixture.exists(fixture.url(foreign)))
    XCTAssertTrue(fixture.exists(fixture.url(hardLinked)))
    try fixture.mode(parent, 0o700)
    XCTAssertEqual(delete(store, blocked).status, .deleted)
  }

  func testUnreadableParentsAndCreationPermissionFailureDoNotBecomeMissingSuccess() throws {
    XCTAssertNotEqual(geteuid(), 0)
    let store = try fixture.store()
    let asset = try fixture.create(store, owner: owner, operation: operation)
    let parent = fixture.url(asset).deletingLastPathComponent()
    try fixture.mode(parent, 0o000)
    let denied = delete(store, asset)
    XCTAssertEqual(denied.status, .retryable)
    XCTAssertEqual(denied.errnoCode, EACCES)
    try fixture.mode(parent, 0o700)
    let operationDirectory = parent.deletingLastPathComponent()
    let blockedStore = try fixture.store(hooks: .init(makeAssetID: { self.fixedID }))
    fixture.rememberAsset(owner: owner, operation: operation, assetID: fixedID, role: .movie)
    try fixture.mode(operationDirectory, 0o500)
    XCTAssertThrowsError(try blockedStore.createNewAsset(owner: owner, operationID: operation, role: .movie, data: Data())) {
      XCTAssertEqual(($0 as? ManagedMediaError)?.errnoCode, EACCES)
    }
    try fixture.mode(operationDirectory, 0o700)
    XCTAssertTrue(fixture.exists(fixture.url(asset)))
    XCTAssertTrue(fixture.exists(fixture.record(fixedID)))
  }

  func testOnlyAuthenticatedKnownMissingFilesAndParentsAreIdempotent() throws {
    let store = try fixture.store()
    let asset = try fixture.create(store, owner: owner, operation: operation)
    try fixture.unlink(fixture.url(asset))
    XCTAssertEqual(delete(store, asset).status, .alreadyMissing)
    let parent = fixture.url(asset).deletingLastPathComponent()
    XCTAssertEqual(rmdir(parent.path), 0)
    XCTAssertEqual(delete(store, asset).status, .alreadyMissing)
    try fixture.directory(parent)
    XCTAssertEqual(delete(store, asset).status, .rejectedUnsafe)
    XCTAssertEqual(delete(store, asset, owner: otherOwner).status, .preservedOtherOwner)
  }

  func testLateDeleteAcknowledgementReplayCannotDeleteNewerAssetsOrAnotherOwner() throws {
    let store = try fixture.store()
    let old = try fixture.create(store, owner: owner, operation: operation)
    _ = store.delete(owner: owner, candidates: [.managed(old.reference)])
    let next = try fixture.create(store, owner: owner, operation: laterOperation)
    let foreign = try fixture.create(store, owner: otherOwner, operation: operation)
    let reopened = try fixture.store()
    for _ in 0..<3 {
      XCTAssertEqual(reopened.delete(owner: owner, candidates: [.managed(old.reference), .managed(foreign.reference)]).map(\.status),
                     [.alreadyMissing, .preservedOtherOwner])
    }
    XCTAssertTrue(fixture.exists(fixture.url(next)))
    XCTAssertTrue(fixture.exists(fixture.url(foreign)))
    XCTAssertTrue(fixture.exists(fixture.record(old.assetID)))
  }

  func testStreamingWriterIsClosedAfterSuccessOrFailureAndFailedIDsStayReserved() throws {
    let store = try fixture.store(hooks: .init(makeAssetID: { self.fixedID }))
    fixture.rememberAsset(owner: owner, operation: operation, assetID: fixedID, role: .movie)
    var escaped: ManagedMediaWriter?
    let asset = try store.createNewAsset(owner: owner, operationID: operation, role: .movie) { writer in
      escaped = writer
      try writer.append(Data("first".utf8))
      try writer.append(Data("second".utf8))
    }
    XCTAssertEqual(try fixture.bytes(fixture.url(asset)), Data("firstsecond".utf8))
    XCTAssertThrowsError(try escaped?.append(Data("late".utf8))) {
      XCTAssertEqual(($0 as? ManagedMediaError)?.issue, .writerClosed)
    }
    let failedID = "ffffffff-ffff-4fff-8fff-ffffffffffff"
    let failedStore = try fixture.store(hooks: .init(makeAssetID: { failedID }))
    fixture.rememberAsset(owner: owner, operation: operation, assetID: failedID, role: .pose)
    XCTAssertThrowsError(try failedStore.createNewAsset(owner: owner, operationID: operation, role: .pose) { writer in
      escaped = writer
      try writer.append(Data("partial".utf8))
      throw ManagedMediaError(.ioFailure, errnoCode: EIO)
    })
    XCTAssertThrowsError(try escaped?.append(Data("late".utf8))) {
      XCTAssertEqual(($0 as? ManagedMediaError)?.issue, .writerClosed)
    }
    XCTAssertThrowsError(try failedStore.createNewAsset(owner: owner, operationID: operation, role: .pose, data: Data())) {
      XCTAssertEqual(($0 as? ManagedMediaError)?.issue, .collision)
    }
    XCTAssertEqual(try fixture.bytes(fixture.record(failedID)), Data())
  }

  func testStoreInstancesSerializeDeletionAgainstAnInFlightNativeWriter() throws {
    let first = try fixture.store()
    let second = try fixture.store(hooks: .init(makeAssetID: { self.fixedID }))
    let existing = try fixture.create(first, owner: owner, operation: operation)
    fixture.rememberAsset(owner: owner, operation: operation, assetID: fixedID, role: .poster)
    let started = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)
    let writerDone = DispatchSemaphore(value: 0)
    let deleteStarted = DispatchSemaphore(value: 0)
    let deleteDone = DispatchSemaphore(value: 0)
    let writeError = LockedTestValue<Error?>(nil)
    let deleteResult = LockedTestValue<ManagedMediaDeletionResult?>(nil)
    let requestOwner = owner
    let requestOperation = operation
    DispatchQueue.global().async {
      defer { writerDone.signal() }
      do {
        _ = try second.createNewAsset(owner: requestOwner, operationID: requestOperation, role: .poster) { writer in
          try writer.append(Data("pending".utf8))
          started.signal()
          guard release.wait(timeout: .now() + 5) == .success else { throw ManagedMediaError(.ioFailure) }
          try writer.append(Data("finished".utf8))
        }
      } catch { writeError.set(error) }
    }
    XCTAssertEqual(started.wait(timeout: .now() + 5), .success)
    DispatchQueue.global().async {
      deleteStarted.signal()
      deleteResult.set(first.delete(owner: requestOwner, candidates: [.managed(existing.reference)]).first)
      deleteDone.signal()
    }
    XCTAssertEqual(deleteStarted.wait(timeout: .now() + 5), .success)
    XCTAssertEqual(deleteDone.wait(timeout: .now() + 0.1), .timedOut)
    XCTAssertTrue(fixture.exists(fixture.url(existing)))
    release.signal()
    XCTAssertEqual(writerDone.wait(timeout: .now() + 5), .success)
    XCTAssertEqual(deleteDone.wait(timeout: .now() + 5), .success)
    XCTAssertNil(writeError.value)
    XCTAssertEqual(deleteResult.value?.status, .deleted)
  }

  func testReentrantNativeCallsReturnBusyInsteadOfDeadlockingOrDeleting() throws {
    let store = try fixture.store()
    let writerStore = try fixture.store(hooks: .init(makeAssetID: { self.fixedID }))
    let existing = try fixture.create(store, owner: owner, operation: operation)
    fixture.rememberAsset(owner: owner, operation: operation, assetID: fixedID, role: .poster)
    let created = try writerStore.createNewAsset(owner: owner, operationID: operation, role: .poster) { writer in
      let result = delete(store, existing)
      XCTAssertEqual(result.status, .retryable)
      XCTAssertEqual(result.errnoCode, EBUSY)
      XCTAssertThrowsError(try store.createNewAsset(owner: owner, operationID: operation, role: .pose, data: Data())) {
        XCTAssertEqual(($0 as? ManagedMediaError)?.errnoCode, EBUSY)
      }
      XCTAssertThrowsError(try ManagedMediaStore(trustedCapturesRoot: fixture.captures)) {
        XCTAssertEqual(($0 as? ManagedMediaError)?.errnoCode, EBUSY)
      }
      try writer.append(Data("complete".utf8))
    }
    XCTAssertTrue(fixture.exists(fixture.url(existing)))
    XCTAssertEqual(try fixture.bytes(fixture.url(created)), Data("complete".utf8))
    XCTAssertEqual(delete(store, existing).status, .deleted)
  }

  func testCreationRefusesSymlinkOwnerAndOperationNamespaces() throws {
    for replaceOwner in [true, false] {
      let f = try TemporaryMediaFixture()
      defer { XCTAssertNoThrow(try f.cleanup()) }
      let store = try f.store()
      let existing = try f.create(store, owner: owner, operation: operation)
      let ownerDirectory = f.namespace.appendingPathComponent(owner)
      let target = replaceOwner ? ownerDirectory : ownerDirectory.appendingPathComponent(operation)
      let saved = f.base.appendingPathComponent("saved-namespace")
      try f.move(target, to: saved)
      try f.symlink(target, to: saved)
      XCTAssertThrowsError(try store.createNewAsset(owner: owner, operationID: operation, role: .poster, data: Data())) {
        XCTAssertEqual(($0 as? ManagedMediaError)?.issue, .unsafeNode)
      }
      let retained = saved.appendingPathComponent(String(f.url(existing).path.dropFirst(target.path.count)))
      XCTAssertEqual(try f.bytes(retained), Data("native-created".utf8))
    }
  }

  func testWriterRefusesReplacementOrHardLinkBeforePublishingOwnership() throws {
    for hardLink in [false, true] {
      let f = try TemporaryMediaFixture()
      defer { XCTAssertNoThrow(try f.cleanup()) }
      let store = try f.store(hooks: .init(makeAssetID: { self.fixedID }))
      f.rememberAsset(owner: owner, operation: operation, assetID: fixedID, role: .movie)
      let path = ManagedMediaFormat.relativePath(owner: owner, operation: operation, asset: fixedID, role: .movie)
      let leaf = f.captures.appendingPathComponent(path)
      let saved = f.base.appendingPathComponent("saved-new-file.mov")
      XCTAssertThrowsError(try store.createNewAsset(owner: owner, operationID: operation, role: .movie) { writer in
        try writer.append(Data("first".utf8))
        if hardLink {
          try f.hardlink(saved, to: leaf)
        } else {
          try f.move(leaf, to: saved)
          try f.writeNew(leaf, Data("replacement".utf8))
        }
        try writer.append(Data("second".utf8))
      }) {
        XCTAssertEqual(($0 as? ManagedMediaError)?.issue, hardLink ? .hardLinked : .identityChanged)
      }
      XCTAssertEqual(try f.bytes(f.record(fixedID)), Data())
      XCTAssertEqual(try f.bytes(saved), Data("first".utf8))
      XCTAssertEqual(try f.bytes(leaf), Data((hardLink ? "first" : "replacement").utf8))
    }
  }

  func testReservationsSpanOwnersOperationsAndSurviveMissingAssetDirectories() throws {
    let store = try fixture.store(hooks: .init(makeAssetID: { self.fixedID }))
    let old = try fixture.create(store, owner: owner, operation: operation)
    XCTAssertEqual(delete(store, old).status, .deleted)
    XCTAssertEqual(rmdir(fixture.url(old).deletingLastPathComponent().path), 0)
    for (nextOwner, nextOperation) in [(owner, operation), (owner, laterOperation), (otherOwner, operation)] {
      fixture.rememberAsset(owner: nextOwner, operation: nextOperation, assetID: fixedID, role: .poster)
      XCTAssertThrowsError(try store.createNewAsset(owner: nextOwner, operationID: nextOperation, role: .poster, data: Data())) {
        XCTAssertEqual(($0 as? ManagedMediaError)?.issue, .collision)
      }
    }
    XCTAssertTrue(fixture.exists(fixture.record(fixedID)))
    XCTAssertEqual(delete(store, old).status, .alreadyMissing)
  }

  func testNewAssetsAndAuthorityHavePrivateModesAndBackupExclusion() throws {
    let store = try fixture.store()
    let asset = try fixture.create(store, owner: owner, operation: operation)
    let nodes = [fixture.namespace, fixture.records, fixture.authority, fixture.record(asset.assetID), fixture.url(asset)]
    for node in nodes {
      var info = stat()
      XCTAssertEqual(lstat(node.path, &info), 0)
      XCTAssertEqual(info.st_mode & 0o077, 0)
      XCTAssertEqual(info.st_uid, geteuid())
      XCTAssertEqual(try node.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
      #if os(iOS)
      let descriptor = Darwin.open(node.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
      XCTAssertGreaterThanOrEqual(descriptor, 0)
      if descriptor >= 0 {
        XCTAssertEqual(fcntl(descriptor, F_GETPROTECTIONCLASS), 3)
        Darwin.close(descriptor)
      }
      #endif
    }
    XCTAssertNotEqual(try fixture.captures.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
  }

  private func delete(_ store: ManagedMediaStore, _ asset: ManagedMediaAsset, owner: String? = nil) -> ManagedMediaDeletionResult {
    store.delete(owner: owner ?? self.owner, candidates: [.managed(asset.reference)])[0]
  }

  private func mutate(
    _ reference: ManagedMediaReference, _ mutation: (inout [String: Any]) -> Void
  ) throws -> ManagedMediaReference {
    var envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: reference.serialized) as? [String: Any])
    var payload = try XCTUnwrap(envelope["payload"] as? [String: Any])
    mutation(&payload)
    envelope["payload"] = payload
    return ManagedMediaReference(serialized: try canonicalJSON(envelope))
  }

  private func canonicalJSON(_ object: [String: Any]) throws -> Data {
    try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
  }
}
