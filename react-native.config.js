/**
 * Native asset linking. `npx react-native-asset` reads this and copies
 * assets/fonts into android/app/src/main/assets/fonts and registers each
 * face in the Xcode project + Info.plist (UIAppFonts). Re-run it whenever a
 * font file is added or removed, then rebuild both apps.
 */
module.exports = {
  assets: ['./assets/fonts'],
};
