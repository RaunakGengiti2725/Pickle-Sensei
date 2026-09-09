// Adversarial probe (W05-01 attack 13): a stored wallet whose revision is
// UInt64.max is accepted by `load`, and the next `replace` computes
// `currentRevision + 1`. Run out of process because an overflow trap would
// kill the whole XCTest bundle. Build with the wallet source in the SAME
// module so the internal HMAC helper is reachable:
//
//   swiftc -parse-as-library \
//     native/vision-core/Sources/OfflineWallet.swift \
//     native/vision-core/Tests/OfflineWalletAttackProbe/main.swift \
//     -o /tmp/wallet-overflow-probe && /tmp/wallet-overflow-probe; echo "exit=$?"
//
// Expected (correct) behaviour: exit 0 with a typed OfflineWalletError.
// A non-zero exit from a runtime trap (SIGILL/SIGTRAP) is the break.
import Foundation

final class ProbeStore: OfflineWalletSecureStore {
  var items: [String: Data] = [:]
  func read(account: String) throws -> Data? { items[account] }
  func write(account: String, data: Data) throws { items[account] = data }
  func delete(account: String) throws { items.removeValue(forKey: account) }
}

@main
enum Probe {
  static func main() {
    setvbuf(stdout, nil, _IONBF, 0)
    let ownerId = "0f9d5a7e-3c1b-4a2d-9b8e-1c2d3e4f5a6b"
    let store = ProbeStore()
    let wallet = OfflineWallet(store: store)
    do {
      _ = try wallet.replace(ownerId: ownerId, expectedRevision: 0, contents: .init(grants: [], receipts: []))
      let key = store.items[OfflineWallet.integrityKeyAccount]!
      let account = OfflineWallet.walletAccount(ownerId: ownerId)
      let payload = Data("{\"grants\":[],\"ownerId\":\"\(ownerId)\",\"receipts\":[],\"revision\":\(UInt64.max)}".utf8)
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
      store.items[account] = try JSONSerialization.data(withJSONObject: envelope)

      let loaded = try wallet.load(ownerId: ownerId)
      print("load accepted stored revision:", loaded?.revision ?? 0)
      FileHandle.standardOutput.synchronizeFile()

      let next = try wallet.replace(ownerId: ownerId, expectedRevision: .max, contents: .init(grants: [], receipts: []))
      print("replace returned revision:", next.revision)
    } catch let error as OfflineWalletError {
      print("typed failure:", error.failure.code, "-", error.detail)
    } catch {
      print("untyped failure:", error)
      exit(2)
    }
  }
}
