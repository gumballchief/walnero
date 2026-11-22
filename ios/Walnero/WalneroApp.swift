import SwiftUI

// Walnero for iPhone. The wallet itself (Monero's wallet engine, the instant-open scanner and the screens) is the same code as
// the Chrome extension, bundled in web/ and run in a web view. Swift supplies the window, the files and the storage.
@main
struct WalneroApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject private var privacy = PrivacyCover.shared

    var body: some Scene {
        WindowGroup {
            WalletView()
                .ignoresSafeArea()
                .background(Color.black)
                .preferredColorScheme(.dark)
                // Hides the wallet in the app switcher and when the app is in the background. Not shown during Face ID.
                .overlay {
                    if scenePhase != .active && !privacy.authenticating {
                        Color.black.ignoresSafeArea()
                    }
                }
        }
    }
}
