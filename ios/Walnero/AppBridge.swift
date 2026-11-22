import UIKit
import UniformTypeIdentifiers
import WebKit

/// The few things the wallet page asks of the app itself:
/// - which network it's on (real Monero or the free test network). The choice is kept here and handed to the page before any
///   of its scripts run; switching saves it and reloads the page, so the wallet engine starts fresh on the other network.
/// - free test coins from CypherFaucet's keyless API (built for testing), which doesn't let web pages call it directly.
/// - copying a secret (like the recovery words) to the clipboard. It stays off other devices and iOS clears it after 60 seconds.
final class AppBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let networkKey = "walneroNet"
    weak var webView: WKWebView?

    /// "mainnet" or "stagenet".
    static var network: String {
        UserDefaults.standard.string(forKey: networkKey) == "stagenet" ? "stagenet" : "mainnet"
    }

    /// Runs before the page's own scripts on every load.
    static func networkScript() -> WKUserScript {
        WKUserScript(source: "window.__walneroNet = '\(network)';", injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.securityOrigin.protocol == "walnero",
              let body = message.body as? [String: Any],
              let op = body["op"] as? String
        else { replyHandler(nil, "Not allowed"); return }

        switch op {
        case "setNet":
            let net = body["net"] as? String == "stagenet" ? "stagenet" : "mainnet"
            UserDefaults.standard.set(net, forKey: Self.networkKey)
            replyHandler(nil, nil)
            DispatchQueue.main.async {
                guard let web = self.webView else { return }
                web.configuration.userContentController.removeAllUserScripts()
                web.configuration.userContentController.addUserScript(Self.networkScript())
                web.load(URLRequest(url: URL(string: "walnero://app/index.html")!))
            }
        case "faucet":
            guard Self.network == "stagenet", let address = body["address"] as? String, !address.isEmpty else {
                replyHandler(["ok": false, "message": "Test coins only go to the test network."], nil)
                return
            }
            claim(address, replyHandler)
        case "copySecret":
            guard let text = body["text"] as? String, !text.isEmpty else {
                replyHandler(["ok": false], nil)
                return
            }
            DispatchQueue.main.async {
                // localOnly keeps it off Universal Clipboard. The expiry date makes iOS wipe it after a minute.
                UIPasteboard.general.setItems([[UTType.plainText.identifier: text]],
                                              options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(60)])
                replyHandler(["ok": true], nil)
            }
        default:
            replyHandler(nil, "Unknown call")
        }
    }

    private func claim(_ address: String, _ reply: @escaping (Any?, String?) -> Void) {
        var request = URLRequest(url: URL(string: "https://cypherfaucet.com/api/v1/claim")!, timeoutInterval: 30)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["network": "xmr-stagenet", "address": address])
        URLSession.shared.dataTask(with: request) { data, _, error in
            var result: [String: Any] = ["ok": false, "message": "The faucet didn't answer. Try again in a bit."]
            if let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                if json["ok"] as? Bool == true {
                    result = ["ok": true, "amount": json["amount"] as? String ?? "0.01", "txid": json["txid"] as? String ?? ""]
                } else {
                    result = ["ok": false, "message": json["error"] as? String ?? json["message"] as? String ?? "The faucet said no. It gives once an hour."]
                }
            } else if let error {
                result["message"] = error.localizedDescription
            }
            DispatchQueue.main.async { reply(result, nil) }
        }.resume()
    }
}
