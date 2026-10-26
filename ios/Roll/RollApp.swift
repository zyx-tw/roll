import AVFoundation
import SwiftUI

@main
struct RollApp: App {
    @State private var account = Account()
    @State private var uploader = Uploader()

    init() {
        // Videos play with sound even with the ring switch on silent, as in Photos.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(account)
                .environment(uploader)
        }
    }
}
