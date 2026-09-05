import { StyleSheet, type TextStyle } from 'react-native';

/**
 * Fittr mobile tokens, transcribed from the Claude Design canvas
 * ("Fittr App.dc.html" / "Fittr Screen.dc.html", turn 1).
 *
 * The design's own summary, kept here so the numbers have a source:
 *   - Ground #0A0A0B · Card #17171A · Raised #202024 · Lime #D2FF3C.
 *   - Anton for headlines, numbers and buttons (uppercase, tight). Inter
 *     400/500/600 for body, handles and metadata. Labels are Inter 600 at
 *     10–11px with .12–.14em tracking, all caps, dim gray.
 *   - Scoreboard scale: card stake 36 · detail 40 · profile balance 84 ·
 *     results delta 120 · camera rep counter 200.
 *   - Spacing 4/8/12/16/20/24/32. Screen gutter 20. Card padding 18.
 *     Radii: 20 cards, 16 buttons and inputs, 14 controls, 7 tags, pill 999.
 *   - Lime budget: one primary CTA per screen, the live dot, key numbers,
 *     the active tab and the selected stake. The win screen is the single
 *     lime flood.
 *   - Thumb zone: primary actions in the bottom 120px; back/close are 44px
 *     circles; nothing tappable under 44px.
 */

export const colors = {
  /** Ground. */
  bg: '#0A0A0B',
  /** Card surface. */
  card: '#17171A',
  /** Card hover/pressed. */
  cardPressed: '#1C1C20',
  /** Raised surface: tags, segmented controls, secondary buttons. */
  raised: '#202024',
  /** Empty slot bars, dashed outlines, the loss-state bars. */
  slot: '#2A2A2F',
  /** Sheet handle, inactive blitz pips. */
  handle: '#3A3A40',

  /** The one accent. */
  accent: '#D2FF3C',
  /** Accent pressed (the design's hover). */
  accentPressed: '#E2FF74',
  accentTint: 'rgba(210,255,60,0.12)',
  accentTintStrong: 'rgba(210,255,60,0.16)',
  accentOutline: 'rgba(210,255,60,0.4)',
  accentGlow: 'rgba(210,255,60,0.25)',

  /** Ink on an accent surface, at the opacities the design uses. */
  onAccent: '#0A0A0B',
  onAccentMuted: 'rgba(10,10,11,0.7)',
  onAccentFaint: 'rgba(10,10,11,0.45)',
  onAccentGhost: 'rgba(10,10,11,0.12)',
  onAccentWash: 'rgba(10,10,11,0.08)',
  onAccentWatermark: 'rgba(10,10,11,0.07)',

  text: '#FAFAFA',
  secondary: '#8A8A93',
  dim: '#5C5C64',
  watermark: 'rgba(255,255,255,0.025)',

  /** Row rules. */
  line: 'rgba(255,255,255,0.05)',
  /** Input border. */
  border: 'rgba(255,255,255,0.08)',
  /** Tab bar top rule. */
  tabLine: 'rgba(255,255,255,0.06)',
  /** Translucent pills over the camera. */
  glass: 'rgba(23,23,26,0.85)',
  /** Sheet backdrop. */
  scrim: 'rgba(0,0,0,0.6)',
  /** Camera overlay backdrop. */
  overlay: 'rgba(10,10,11,0.86)',
  /** The recording dot. The only non-lime chroma in the system. */
  recording: '#FF3B30',
  whiteTint: 'rgba(250,250,250,0.14)',
} as const;

/**
 * Bundled faces (assets/fonts, linked by react-native.config.js). Android
 * resolves a family by file name, iOS by PostScript name, and these files
 * are named so both agree. Never add fontWeight on top of these: Anton has
 * one weight, and Android would synthesise a fake bold over Inter.
 */
export const fonts = {
  display: 'Anton-Regular',
  body: 'Inter-Regular',
  medium: 'Inter-Medium',
  semibold: 'Inter-SemiBold',
  bold: 'Inter-Bold',
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  /** Screen gutter. */
  gutter: 20,
  /** Card padding. */
  cardPad: 18,
} as const;

export const radius = {
  card: 20,
  hero: 24,
  sheet: 28,
  button: 16,
  control: 14,
  tile: 10,
  tag: 7,
  pill: 999,
} as const;

export const sizes = {
  button: 56,
  buttonMd: 52,
  buttonSm: 36,
  circle: 44,
  chip: 34,
  input: 56,
} as const;

/** Anton at a size. Tracking is in em, the design's -.01em default. */
export function anton(
  size: number,
  opts: { tracking?: number; color?: string; uppercase?: boolean } = {},
): TextStyle {
  const { tracking = -0.01, color = colors.text, uppercase = true } = opts;
  return {
    fontFamily: fonts.display,
    fontSize: size,
    lineHeight: size,
    letterSpacing: Math.round(size * tracking * 100) / 100,
    color,
    textTransform: uppercase ? 'uppercase' : 'none',
    includeFontPadding: false,
  };
}

/** Anton numbers: tighter tracking, tabular digits, no case transform. */
export function numeral(size: number, color: string = colors.text): TextStyle {
  return {
    ...anton(size, { tracking: -0.03, color, uppercase: false }),
    fontVariant: ['tabular-nums'],
  };
}

/** Inter 600 caps label. 10px at .14em by default, 11px at .12–.14em. */
export function label(
  size: number = 10,
  color: string = colors.dim,
  trackingEm: number = 0.14,
): TextStyle {
  return {
    fontFamily: fonts.semibold,
    fontSize: size,
    lineHeight: size + 2,
    letterSpacing: Math.round(size * trackingEm * 100) / 100,
    textTransform: 'uppercase',
    color,
    includeFontPadding: false,
  };
}

export const typography = StyleSheet.create({
  /** Inter 400 15/1.5. */
  body: {
    fontFamily: fonts.body,
    fontSize: 15,
    lineHeight: 22,
    color: colors.text,
  },
  bodyMuted: {
    fontFamily: fonts.body,
    fontSize: 15,
    lineHeight: 22,
    color: colors.secondary,
  },
  /** Inter 400 13/1.45 secondary. */
  small: {
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: 19,
    color: colors.secondary,
  },
  /** Inter 500 13. Handles, list rows. */
  meta: {
    fontFamily: fonts.medium,
    fontSize: 13,
    lineHeight: 17,
    color: colors.text,
  },
  /** Inter 600 14. Row names. */
  rowTitle: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    lineHeight: 18,
    color: colors.text,
  },
  /** Inter 400 11/1.5 dim. Footnotes. */
  footnote: {
    fontFamily: fonts.body,
    fontSize: 11,
    lineHeight: 16,
    color: colors.dim,
  },
  /** Inter 400 12/1.4 dim. Helper text under controls. */
  helper: {
    fontFamily: fonts.body,
    fontSize: 12,
    lineHeight: 17,
    color: colors.dim,
  },
});
