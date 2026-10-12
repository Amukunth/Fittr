import SwiftUI

/// Fittr design tokens, transcribed from `src/theme/tokens.ts` in the React
/// Native app. The hex values are identical to the phone's; the watch is the
/// same brand on a smaller screen. Colours are declared in sRGB explicitly so
/// the hex is reproduced exactly (not re-interpreted as Display P3).
///
/// Watch-specific rules (derived from the token contrast maths and Apple's
/// Always On guidance, see watch/README.md):
///   - The screen ground is `Color.black`, not `bg`: #0A0A0B is 10/255 above
///     black and renders as a faintly lit rectangle against the OLED bezel.
///     `bg` stays in use as the ink on lime surfaces (`onAccent`).
///   - `dim` (2.99:1 on black) is decoration only; readable text uses `text`
///     or `secondary` (5.78:1).
///   - Lime budget still applies: one lime CTA per screen.
enum FittrColor {
    /// Ground on the phone. On the watch use `Color.black` for the screen. #0A0A0B
    static let bg = Color(hex: 0x0A0A0B)
    /// Card surface. #17171A
    static let card = Color(hex: 0x17171A)
    /// Card pressed. #1C1C20
    static let cardPressed = Color(hex: 0x1C1C20)
    /// Raised surface: tags, secondary buttons. #202024
    static let raised = Color(hex: 0x202024)
    /// Empty slot bars, progress-ring track. #2A2A2F
    static let slot = Color(hex: 0x2A2A2F)
    /// Sheet handle, secondary button pressed. #3A3A40
    static let handle = Color(hex: 0x3A3A40)
    /// The one accent. #D2FF3C
    static let accent = Color(hex: 0xD2FF3C)
    /// Accent pressed. #E2FF74
    static let accentPressed = Color(hex: 0xE2FF74)
    /// Lime, recessive (Always On, round-number labels). 55% of accent.
    static let accentMuted = Color(hex: 0xD2FF3C, opacity: 0.55)
    /// Ink on an accent surface. #0A0A0B
    static let onAccent = Color(hex: 0x0A0A0B)
    /// Primary text. #FAFAFA
    static let text = Color(hex: 0xFAFAFA)
    /// Secondary text and labels. #8A8A93
    static let secondary = Color(hex: 0x8A8A93)
    /// Dim: decoration only on the watch. #5C5C64
    static let dim = Color(hex: 0x5C5C64)
    /// The recording dot: the only non-lime chroma in the system. #FF3B30
    static let recording = Color(hex: 0xFF3B30)
    /// Loss text and lines. #E5544B
    static let loss = Color(hex: 0xE5544B)
}

extension Color {
    /// sRGB colour from a 24-bit hex literal, e.g. `Color(hex: 0xD2FF3C)`.
    init(hex: UInt32, opacity: Double = 1) {
        let r = Double((hex >> 16) & 0xFF) / 255
        let g = Double((hex >> 8) & 0xFF) / 255
        let b = Double(hex & 0xFF) / 255
        self.init(.sRGB, red: r, green: g, blue: b, opacity: opacity)
    }
}

/// Type styles. Phase 1 uses the system font so the first build needs no
/// font bundling. Phase 2 adds Anton-Regular.ttf and Inter-SemiBold.ttf to the
/// watch target (UIAppFonts in the watch Info.plist) and switches these to
/// `Font.custom("Anton-Regular", fixedSize:)` / `Font.custom("Inter-SemiBold",
/// size:relativeTo:)`. PostScript names verified from the font files.
enum FittrFont {
    /// Wordmark and hero numbers (Anton's job). A brand mark does not scale
    /// with Dynamic Type, so this is a fixed size.
    static func display(_ size: CGFloat) -> Font {
        .system(size: size, weight: .black, design: .rounded)
    }

    /// Button text (Anton 18 on the watch). Scales with Dynamic Type.
    static func button(_ size: CGFloat = 18) -> Font {
        .system(size: size, weight: .heavy, design: .rounded)
    }

    /// All-caps metadata label. watchOS minimum readable size is 12pt
    /// (the phone's 10-11pt labels are not ported).
    static func label(_ size: CGFloat = 12) -> Font {
        .system(size: size, weight: .semibold)
    }
}

/// The primary CTA: full width, lime fill, dark ink, continuous corners.
/// Mirrors `Button` variant "primary" in `src/theme/ui.tsx` (56pt / radius 16
/// on the phone) at the watch's 44pt default control height. The height is a
/// minimum so the button can grow under larger Dynamic Type sizes.
struct FittrPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(FittrFont.button())
            .foregroundStyle(FittrColor.onAccent)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(
                configuration.isPressed ? FittrColor.accentPressed : FittrColor.accent,
                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
            )
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}
