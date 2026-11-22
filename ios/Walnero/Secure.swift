import LocalAuthentication
import Security
import WebKit

/// Tells the app whether to hide the wallet behind a black cover (app switcher, background). The Face ID prompt also makes the
/// app inactive, so Secure sets `authenticating` while that prompt is up and the cover stays off. Only touched on the main thread.
final class PrivacyCover: ObservableObject {
    static let shared = PrivacyCover()
    @Published var authenticating = false
}

/// Face ID unlock. The wallet password is kept in the iOS Keychain, readable only after Face ID passes on this phone, never
/// synced or backed up, and wiped by iOS if the enrolled faces change. Face ID gets iOS's usual two tries; after that the sheet
/// offers "Use Password" and the wallet falls back to typing it.
final class Secure: NSObject, WKScriptMessageHandlerWithReply {
    // The real wallet and the test-network wallet each have their own password, so each gets its own saved copy.
    private var slot = ""
    private var service: String { "walnero.unlock" + slot }
    private let account = "password"
    private var enabledKey: String { "faceIDEnabled" + slot }
    private var askedKey: String { "faceIDAsked" + slot }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.securityOrigin.protocol == "walnero",
              let body = message.body as? [String: Any],
              let op = body["op"] as? String
        else { replyHandler(nil, "Not allowed"); return }
        slot = body["slot"] as? String == "stagenet" ? ".test" : ""

        switch op {
        case "status":
            replyHandler(status(), nil)
        case "asked":
            UserDefaults.standard.set(true, forKey: askedKey)
            replyHandler(nil, nil)
        case "enable":
            guard let password = body["password"] as? String, !password.isEmpty else { replyHandler(nil, "No password"); return }
            enable(password, replyHandler)
        case "unlock":
            unlock(replyHandler)
        case "disable":
            deleteItem()
            UserDefaults.standard.set(false, forKey: enabledKey)
            replyHandler(nil, nil)
        default:
            replyHandler(nil, "Unknown call")
        }
    }

    private func status() -> [String: Any] {
        let context = LAContext()
        var error: NSError?
        let available = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        let kind = context.biometryType == .touchID ? "Touch ID" : "Face ID"
        return [
            "available": available,
            "kind": kind,
            "enabled": available && UserDefaults.standard.bool(forKey: enabledKey),
            "asked": UserDefaults.standard.bool(forKey: askedKey),
        ]
    }

    /// Checks the face first (that's also when iOS asks permission), then saves the password behind it.
    private func enable(_ password: String, _ reply: @escaping (Any?, String?) -> Void) {
        let context = LAContext()
        context.localizedFallbackTitle = ""
        PrivacyCover.shared.authenticating = true
        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "Turn on Face ID for Walnero") { ok, error in
            DispatchQueue.main.async {
                PrivacyCover.shared.authenticating = false
                guard ok else { reply(["ok": false, "error": self.reason(error)], nil); return }
                self.deleteItem()
                guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, nil) else {
                    reply(["ok": false, "error": "keychain"], nil)
                    return
                }
                let query: [String: Any] = [
                    kSecClass as String: kSecClassGenericPassword,
                    kSecAttrService as String: self.service,
                    kSecAttrAccount as String: self.account,
                    kSecValueData as String: Data(password.utf8),
                    kSecAttrAccessControl as String: access,
                    kSecUseAuthenticationContext as String: context,
                ]
                let status = SecItemAdd(query as CFDictionary, nil)
                guard status == errSecSuccess else { reply(["ok": false, "error": "keychain \(status)"], nil); return }
                UserDefaults.standard.set(true, forKey: self.enabledKey)
                UserDefaults.standard.set(true, forKey: self.askedKey)
                reply(["ok": true], nil)
            }
        }
    }

    /// Face ID (iOS gives two tries), then the password comes out of the Keychain with that same check, so there's no second prompt.
    private func unlock(_ reply: @escaping (Any?, String?) -> Void) {
        let context = LAContext()
        context.localizedFallbackTitle = "Use Password"
        PrivacyCover.shared.authenticating = true
        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "Unlock Walnero") { ok, error in
            guard ok else {
                DispatchQueue.main.async {
                    PrivacyCover.shared.authenticating = false
                    reply(["error": self.reason(error)], nil)
                }
                return
            }
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: self.service,
                kSecAttrAccount as String: self.account,
                kSecReturnData as String: true,
                kSecMatchLimit as String: kSecMatchLimitOne,
                kSecUseAuthenticationContext as String: context,
            ]
            var out: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &out)
            DispatchQueue.main.async {
                PrivacyCover.shared.authenticating = false
                if status == errSecSuccess, let data = out as? Data, let password = String(data: data, encoding: .utf8) {
                    reply(["password": password], nil)
                } else {
                    // The faces on the phone changed, so iOS threw the saved password away. Turn it off until it's set up again.
                    self.deleteItem()
                    UserDefaults.standard.set(false, forKey: self.enabledKey)
                    reply(["error": "changed"], nil)
                }
            }
        }
    }

    private func deleteItem() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }

    private func reason(_ error: Error?) -> String {
        guard let code = (error as? LAError)?.code else { return "failed" }
        switch code {
        case .userFallback: return "password"
        case .userCancel, .appCancel, .systemCancel: return "cancel"
        case .biometryLockout: return "lockout"
        case .biometryNotEnrolled, .biometryNotAvailable: return "unavailable"
        default: return "failed"
        }
    }
}
