import SwiftUI

/// Entry point of the Fittr watch app (Xcode target "Fittr Watch App",
/// bundle id com.fittr.app.watchkitapp, companion com.fittr.app).
///
/// Phase 1: a single screen with a START button that does nothing.
/// Phase 2 starts an HKWorkoutSession from that button.
@main
struct FittrWatchApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
