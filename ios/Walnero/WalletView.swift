import SwiftUI
import WebKit

// The wallet runs at walnero://app/, served straight out of the app bundle, so it works with no server and nothing to
// download. Its storage calls come here (Storage) instead of web storage, which iOS is allowed to clear.
struct WalletView: UIViewRepresentable {
    func makeCoordinator() -> Links { Links() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(BundleFiles(), forURLScheme: "walnero")
        config.userContentController.addScriptMessageHandler(Storage(), contentWorld: .page, name: "kv")
        config.userContentController.addScriptMessageHandler(Secure(), contentWorld: .page, name: "secure")
        let bridge = AppBridge()
        config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "app")
        config.userContentController.addUserScript(AppBridge.networkScript())
        config.websiteDataStore = .default()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false

        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = .black
        web.scrollView.backgroundColor = .black
        web.scrollView.bounces = false
        // The wallet's screens never scroll as a whole (lists scroll inside themselves), so the page can't drift.
        web.scrollView.isScrollEnabled = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.allowsLinkPreview = false
        web.uiDelegate = context.coordinator
        bridge.webView = web
        web.navigationDelegate = context.coordinator
        web.load(URLRequest(url: URL(string: "walnero://app/index.html")!))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {}
}

/// Links out of the wallet (the test faucet, a block explorer) open in Safari, so the wallet page itself never navigates away.
final class Links: NSObject, WKUIDelegate, WKNavigationDelegate {
    private func isWeb(_ url: URL?) -> Bool { url?.scheme == "https" || url?.scheme == "http" }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, isWeb(url) { UIApplication.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, isWeb(url) {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }
}

/// Serves the bundled wallet files at walnero://app/.
final class BundleFiles: NSObject, WKURLSchemeHandler {
    private let root = Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true).standardizedFileURL
    private let types = [
        "html": "text/html", "js": "text/javascript", "css": "text/css", "wasm": "application/wasm", "png": "image/png",
        "svg": "image/svg+xml", "woff2": "font/woff2", "json": "application/json",
    ]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        let path = url.path.isEmpty || url.path == "/" ? "index.html" : String(url.path.dropFirst())
        let file = root.appendingPathComponent(path).standardizedFileURL
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
            task.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: [:])!)
            task.didFinish()
            return
        }
        let headers = [
            "Content-Type": types[file.pathExtension.lowercased()] ?? "application/octet-stream",
            "Content-Length": String(data.count),
            "Cache-Control": "no-cache",
        ]
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

/// The wallet's saved data: the vault, the wallet file, the last balance, saved names. All of it arrives already encrypted
/// with a key made from the password. Kept in the app's own files, protected by iOS while the phone is locked, and left out
/// of iCloud backups (the recovery words are the backup).
final class Storage: NSObject, WKScriptMessageHandlerWithReply {
    private let dir: URL = {
        var url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("wallet", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
        return url
    }()

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        // Only the wallet's own page may touch its files.
        guard message.frameInfo.securityOrigin.protocol == "walnero",
              let body = message.body as? [String: Any],
              let op = body["op"] as? String,
              let key = body["key"] as? String,
              key.range(of: "^[A-Za-z0-9-]{1,64}$", options: .regularExpression) != nil
        else { replyHandler(nil, "Not allowed"); return }

        let file = dir.appendingPathComponent(key + ".json")
        switch op {
        case "get":
            replyHandler(try? String(contentsOf: file, encoding: .utf8), nil)
        case "set":
            guard let value = body["value"] as? String else { replyHandler(nil, "Nothing to save"); return }
            do {
                try Data(value.utf8).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                replyHandler(nil, nil)
            } catch {
                replyHandler(nil, error.localizedDescription)
            }
        case "del":
            try? FileManager.default.removeItem(at: file)
            replyHandler(nil, nil)
        default:
            replyHandler(nil, "Unknown storage call")
        }
    }
}
