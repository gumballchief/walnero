import XCTest

// Runs on a cloud Mac's iPhone simulator: makes a brand new, empty real-Monero wallet (nothing is ever sent), waits until it's
// up to date, opens Receive, then closes the app and reopens it to prove the wallet comes back from the app's own files.
// Each step leaves a screenshot.
final class WalletFlowTests: XCTestCase {
    private func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func type(_ field: XCUIElement, _ text: String) {
        XCTAssertTrue(field.waitForExistence(timeout: 20), "missing field \(field)")
        field.tap()
        sleep(1) // let the keyboard finish opening
        field.typeText(text)
    }

    func testMakeCloseAndReopenAWallet() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()

        let create = app.webViews.buttons["Create a wallet"]
        XCTAssertTrue(create.waitForExistence(timeout: 40), "the welcome screen never showed")
        sleep(1)
        shot(app, "1-welcome")
        create.tap()

        // The keyboard covers the bottom of the screen while it's open, so finish with Return, the way a person would.
        type(app.webViews.secureTextFields["Password"], "phone-test-password")
        type(app.webViews.secureTextFields["Same password again"], "phone-test-password\n")

        let wrote = app.webViews.buttons["I wrote them down"]
        XCTAssertTrue(wrote.waitForExistence(timeout: 120), "the recovery words never showed")
        sleep(1)
        shot(app, "2-words")
        wrote.tap()

        XCTAssertTrue(app.webViews.staticTexts["Up to date"].waitForExistence(timeout: 300), "never got up to date")
        sleep(2)
        shot(app, "3-home")

        app.webViews.buttons["Receive"].tap()
        XCTAssertTrue(app.webViews.buttons["Copy address"].waitForExistence(timeout: 60), "Receive never showed")
        sleep(2)
        shot(app, "4-receive")

        // Close it for real and open it again: the wallet has to come back from its saved files, locked.
        app.terminate()
        app.launch()
        XCTAssertTrue(app.webViews.staticTexts["Welcome back."].waitForExistence(timeout: 40), "the saved wallet didn't come back")
        sleep(1)
        shot(app, "5-reopened")
        type(app.webViews.secureTextFields["Password"], "phone-test-password\n")
        XCTAssertTrue(app.webViews.staticTexts["Up to date"].waitForExistence(timeout: 180), "never got up to date after reopening")
        sleep(2)
        shot(app, "6-unlocked")

        // Tap the balance: every amount turns to stars. Tap again to bring it back.
        let hide = app.webViews.buttons["Hide balance"]
        XCTAssertTrue(hide.waitForExistence(timeout: 10), "the balance isn't tappable")
        hide.tap()
        let show = app.webViews.buttons["Show balance"]
        XCTAssertTrue(show.waitForExistence(timeout: 10), "tapping didn't hide the balance")
        sleep(1)
        shot(app, "7-hidden")
        show.tap()
        XCTAssertTrue(hide.waitForExistence(timeout: 10), "tapping again didn't show it")

        // Tap Monero: its own screen with the price chart, Info and activity. Then the three lines next to Tokens.
        app.webViews.buttons["Monero"].tap()
        XCTAssertTrue(app.webViews.staticTexts["Your balance"].waitForExistence(timeout: 15), "the Monero screen didn't open")
        XCTAssertTrue(app.webViews.staticTexts["Past day"].waitForExistence(timeout: 20), "the Monero screen has no price")
        sleep(3)
        shot(app, "8-monero")
        app.webViews.buttons["Back"].tap()
        app.webViews.buttons["Manage tokens"].tap()
        XCTAssertTrue(app.webViews.staticTexts["Manage tokens"].waitForExistence(timeout: 10), "Manage tokens didn't open")
        sleep(1)
        shot(app, "9-manage-tokens")
        app.webViews.buttons["Back"].tap()
        XCTAssertTrue(hide.waitForExistence(timeout: 10), "didn't come back to Home")

        // Settings, Network, Node: every node listed with Automatic on top, like Cake Wallet's Manage nodes.
        app.webViews.buttons["Settings"].tap()
        let network = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Network'")).firstMatch
        XCTAssertTrue(network.waitForExistence(timeout: 10), "no Network row")
        network.tap()
        let node = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Node'")).firstMatch
        XCTAssertTrue(node.waitForExistence(timeout: 10), "no Node row")
        node.tap()
        XCTAssertTrue(app.webViews.staticTexts["Automatic"].waitForExistence(timeout: 10), "the Node screen didn't open")
        sleep(4)
        shot(app, "10-node")
        app.webViews.buttons["Back"].tap()
        app.webViews.buttons["Back"].tap()

        // Settings, Wallets: the wallet list with Add a wallet, like Phantom's accounts.
        let walletsRow = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Wallets'")).firstMatch
        XCTAssertTrue(walletsRow.waitForExistence(timeout: 10), "no Wallets row")
        walletsRow.tap()
        XCTAssertTrue(app.webViews.buttons["Add a wallet"].waitForExistence(timeout: 10), "the Wallets screen didn't open")
        sleep(1)
        shot(app, "10a-wallets")

        // Add a wallet, Import from keys: address, view key, and the spend key only for a wallet that can send.
        app.webViews.buttons["Add a wallet"].tap()
        let importKeys = app.webViews.buttons["Import from keys"]
        XCTAssertTrue(importKeys.waitForExistence(timeout: 10), "no Import from keys")
        importKeys.tap()
        XCTAssertTrue(app.webViews.buttons["Import view-only wallet"].waitForExistence(timeout: 10), "the Import from keys page didn't open")
        sleep(1)
        shot(app, "10a2-import-keys")
        app.webViews.buttons["Back"].tap()
        app.webViews.buttons["Back"].tap()
        XCTAssertTrue(app.webViews.buttons["Add a wallet"].waitForExistence(timeout: 10), "didn't come back to Wallets")
        app.webViews.buttons["Back"].tap()

        // Settings, Developer settings: switch to the test network. The app restarts on it, on its own fresh wallet.
        let developer = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Developer settings'")).firstMatch
        XCTAssertTrue(developer.waitForExistence(timeout: 10), "no Developer settings row")
        sleep(1)
        shot(app, "10b-settings")
        developer.tap()
        var toggle = app.webViews.switches["Test network"]
        if !toggle.waitForExistence(timeout: 5) { toggle = app.webViews.buttons["Test network"] }
        XCTAssertTrue(toggle.waitForExistence(timeout: 10), "no Test network switch")
        sleep(1)
        shot(app, "11-developer")
        toggle.tap()
        XCTAssertTrue(app.webViews.staticTexts["Test network. These coins have no value."].waitForExistence(timeout: 30), "the test network didn't start")
        XCTAssertTrue(app.webViews.buttons["Create a wallet"].waitForExistence(timeout: 30), "the test network didn't start on a fresh wallet")
        sleep(1)
        shot(app, "12-test-network")

        // Switch back: the real wallet is right where it was, locked.
        app.webViews.buttons["Switch back"].tap()
        XCTAssertTrue(app.webViews.staticTexts["Welcome back."].waitForExistence(timeout: 30), "didn't come back to the real wallet")
        sleep(1)
        shot(app, "13-back-to-real")
    }
}
