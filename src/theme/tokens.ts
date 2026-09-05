import { Platform, StyleSheet } from 'react-native';

/**
 * Fittr brand tokens — "The Fight Card".
 *
 * The brand's source of truth is FittrLanding/DESIGN.md (the web system:
 * black card stock, one acid ink, condensed poster lettering). Where the app
 * brief and that document disagree, the brief wins, and each divergence is a
 * single token here so the decision can be flipped in one line:
 *
 *   - accent: #D2FF3C per the brief. The landing's "voltage" is #C8FF2E.
 *   - surfaces / text: neutral near-blacks and light grays per the brief. The
 *     landing has a No-Gray Rule and tints everything from bone (#EFE8D8).
 *   - corners: rounded per the brief. The landing is 0-radius everywhere.
 *
 * One rule carried over from the landing that the brief is silent on: there
 * is no second accent. Errors are set in the accent, not red — the landing's
 * "this system has no red" rule. See `colors.error`.
 */

export const colors = {
  /** Card stock. The ground of every screen. */
  bg: '#0A0A0B',
  /** A heavier press of the same stock: controls rail, deepest insets. */
  bgDeep: '#050506',
  /** Card surface. */
  surface: '#17171A',
  /** Raised card surface. */
  surfaceRaised: '#202024',
  /** Rules and chip borders. Never a hairline: 1px on cards, 2px on ghosts. */
  rule: '#2C2C33',

  /** The one ink. CTAs, active states, key stats, the wordmark's offset. */
  accent: '#D2FF3C',
  /** Pressed state of any accent surface — more ink laid down, not dimmer. */
  accentPressed: '#B7E22C',
  /** Text on an accent surface. */
  onAccent: '#0A0A0B',
  /** Secondary text on an accent surface (derived from the accent hue). */
  onAccentMuted: '#3A4A00',

  /** Body text on dark. */
  text: '#E9E9EE',
  /** Secondary text on dark. */
  textMuted: '#9C9CA6',
  /** Tertiary: placeholders, disabled, tape dividers. The floor. */
  textFaint: '#6A6A74',

  /** Errors print in the accent. No red in this system. */
  error: '#D2FF3C',
} as const;

/**
 * Typefaces. The landing sets Big Shoulders Display over Archivo; neither is
 * bundled in this app, and bundling a font is a native-asset change (a
 * react-native.config.js entry plus a rebuild), out of scope for a visual
 * pass. The stand-ins below are the condensed faces each platform ships with
 * and need no linking: Avenir Next Condensed on iOS, Roboto Condensed on
 * Android. Swap `display` for 'BigShouldersDisplay-ExtraBold' once the file
 * is linked; nothing else in the app has to change.
 */
export const fonts = {
  display: Platform.select<string | undefined>({
    ios: 'Avenir Next Condensed',
    android: 'sans-serif-condensed',
    default: undefined,
  }),
  /** Body stays on the platform system face. */
  body: undefined as string | undefined,
};

/** 8px rhythm, matching the landing's spacing scale. */
export const space = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

/** Rounded per the brief. Set every value to 0 to match the landing. */
export const radius = {
  sm: 6,
  md: 12,
  lg: 16,
} as const;

/** Depth is a hard-edged second ink layer, offset down-right. Never a blur. */
export const offset = 4;

/**
 * Type roles, mapped from the landing's ramp to phone sizes. Display roles
 * are uppercase and tightly stacked; every number that ticks or gets
 * compared is tabular (the landing's Tabular Rule).
 */
export const typography = StyleSheet.create({
  display: {
    fontFamily: fonts.display,
    fontWeight: '800',
    fontSize: 44,
    lineHeight: 44,
    letterSpacing: -0.5,
    textTransform: 'uppercase',
    color: colors.text,
    includeFontPadding: false,
  },
  headline: {
    fontFamily: fonts.display,
    fontWeight: '800',
    fontSize: 32,
    lineHeight: 33,
    letterSpacing: -0.25,
    textTransform: 'uppercase',
    color: colors.text,
    includeFontPadding: false,
  },
  subhead: {
    fontFamily: fonts.display,
    fontWeight: '800',
    fontSize: 22,
    lineHeight: 24,
    textTransform: 'uppercase',
    color: colors.text,
    includeFontPadding: false,
  },
  numeral: {
    fontFamily: fonts.display,
    fontWeight: '900',
    fontSize: 56,
    lineHeight: 56,
    fontVariant: ['tabular-nums'],
    color: colors.text,
    includeFontPadding: false,
  },
  stat: {
    fontFamily: fonts.display,
    fontWeight: '900',
    fontSize: 32,
    lineHeight: 34,
    fontVariant: ['tabular-nums'],
    color: colors.text,
    includeFontPadding: false,
  },
  title: {
    fontFamily: fonts.body,
    fontWeight: '800',
    fontSize: 16,
    lineHeight: 20,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: colors.text,
  },
  body: {
    fontFamily: fonts.body,
    fontSize: 16,
    lineHeight: 23,
    color: colors.text,
  },
  bodySm: {
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 20,
    color: colors.textMuted,
  },
  label: {
    fontFamily: fonts.body,
    fontWeight: '700',
    fontSize: 12,
    lineHeight: 14,
    letterSpacing: 1.8,
    textTransform: 'uppercase',
    fontVariant: ['tabular-nums'],
    color: colors.textMuted,
  },
  button: {
    fontFamily: fonts.body,
    fontWeight: '800',
    fontSize: 14,
    lineHeight: 18,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
});
