import SwiftUI

@main
struct RollApp: App {
    @State private var account = Account()
    @State private var uploader = Uploader()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(account)
                .environment(uploader)
        }
    }
}
