import SwiftUI

/// Phase 1 screen: the wordmark, one label, one lime START button.
/// Layout mirrors the phone's page head (label over a 40pt display head at
/// the gutter) and dock (the primary action pinned to the bottom), at the
/// watch's 8pt gutter. The button deliberately does nothing yet; Phase 2
/// replaces the empty action with event selection and an HKWorkoutSession.
struct ContentView: View {
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 0) {
                Text("FITTR")
                    .font(FittrFont.display(40))
                    .tracking(-0.4)
                    .foregroundStyle(FittrColor.text)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .accessibilityAddTraits(.isHeader)

                Text("WATCH-VERIFIED")
                    .font(FittrFont.label())
                    .tracking(1.44)
                    .foregroundStyle(FittrColor.secondary)
                    .padding(.top, 8)

                Spacer(minLength: 16)

                Button("START") {
                    // Phase 1: intentionally does nothing.
                    print("START tapped (Phase 1: no-op)")
                }
                .buttonStyle(FittrPrimaryButtonStyle())
                .accessibilityLabel("Start run")
                .accessibilityHint("Not wired yet")
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 8)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(Color.black.ignoresSafeArea())
        }
    }
}

#Preview {
    ContentView()
}
