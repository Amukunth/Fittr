import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { colors, fonts, offset, radius, space, typography } from './tokens';

/**
 * Presentational primitives only. Nothing in here owns state, talks to the
 * network, or decides anything — screens keep all of that. These exist so
 * the seven screens share one set of weights, spacings and surfaces instead
 * of seven hand-tuned copies.
 */

type Children = { children?: React.ReactNode };
type Styled<T> = { style?: StyleProp<T> };

// ── Layout ──────────────────────────────────────────────────────────────

export function Screen({ children, style }: Children & Styled<ViewStyle>) {
  return <View style={[styles.screen, style]}>{children}</View>;
}

export function Center({ children, style }: Children & Styled<ViewStyle>) {
  return <View style={[styles.center, style]}>{children}</View>;
}

export function Loading() {
  return (
    <Center>
      <ActivityIndicator size="large" color={colors.accent} />
    </Center>
  );
}

/** A card. `raised` is the lighter surface for the thing that matters most. */
export function Plate({
  children,
  raised,
  accent,
  style,
}: Children & Styled<ViewStyle> & { raised?: boolean; accent?: boolean }) {
  return (
    <View
      style={[
        styles.plate,
        raised && styles.plateRaised,
        accent && styles.plateAccent,
        style,
      ]}
    >
      {children}
    </View>
  );
}

// ── Type ────────────────────────────────────────────────────────────────

type TextProps = Children & Styled<TextStyle>;

/** Small accent label that sits above a heading. */
export function Kicker({ children, style }: TextProps) {
  return (
    <Text style={[typography.label, styles.kicker, style]}>{children}</Text>
  );
}

export function Headline({ children, style }: TextProps) {
  return <Text style={[typography.headline, style]}>{children}</Text>;
}

export function Subhead({ children, style }: TextProps) {
  return <Text style={[typography.subhead, style]}>{children}</Text>;
}

export function Label({ children, style }: TextProps) {
  return <Text style={[typography.label, style]}>{children}</Text>;
}

export function Body({ children, style }: TextProps) {
  return <Text style={[typography.body, style]}>{children}</Text>;
}

export function Muted({ children, style }: TextProps) {
  return <Text style={[typography.bodySm, style]}>{children}</Text>;
}

/** Errors print in the accent — there is no red in this system. */
export function ErrorText({ children, style }: TextProps) {
  return (
    <Text style={[typography.bodySm, styles.error, style]} accessibilityRole="alert">
      {children}
    </Text>
  );
}

/** Label over a big tabular number. `accent` marks the key stat. */
export function Stat({
  label,
  value,
  accent,
  onAccent,
  style,
}: Styled<ViewStyle> & {
  label: string;
  value: string | number;
  accent?: boolean;
  onAccent?: boolean;
}) {
  return (
    <View style={style}>
      <Label style={onAccent ? styles.labelOnAccent : undefined}>{label}</Label>
      <Text
        style={[
          typography.stat,
          styles.statValue,
          accent && styles.statAccent,
          onAccent && styles.statOnAccent,
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

/**
 * The typographic wordmark with the landing's registration offset: a second
 * accent layer printed a few pixels down-right of the top layer, the way a
 * two-color screenprint misregisters. Hard-edged, zero blur.
 */
export function Wordmark({ size = 48 }: { size?: number }) {
  const shift = Math.max(2, Math.round(size / 16));
  const face: TextStyle = {
    fontFamily: fonts.display,
    fontWeight: '900',
    fontSize: size,
    lineHeight: size,
    letterSpacing: 0.5,
    includeFontPadding: false,
  };
  return (
    <View
      style={styles.wordmark}
      accessibilityRole="header"
      accessibilityLabel="Fittr"
    >
      <Text
        style={[face, styles.wordmarkInk, { top: shift, left: shift }]}
        importantForAccessibility="no"
        accessibilityElementsHidden
      >
        FITTR
      </Text>
      <Text style={[face, styles.wordmarkTop]}>FITTR</Text>
    </View>
  );
}

// ── Controls ────────────────────────────────────────────────────────────

type ButtonProps = Styled<ViewStyle> & {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** Shows a spinner in place of the label and disables the button. */
  loading?: boolean;
};

/**
 * Accent fill on a print-offset layer. Pressing translates the face onto its
 * offset so the two layers meet — the landing's :active behaviour.
 */
export function PrimaryButton({
  label,
  onPress,
  disabled,
  loading,
  style,
}: ButtonProps) {
  const inactive = Boolean(disabled || loading);
  return (
    <View style={[styles.offsetWrap, style]}>
      <View
        pointerEvents="none"
        style={[styles.offsetLayer, inactive && styles.offsetLayerInactive]}
      />
      <Pressable
        onPress={onPress}
        disabled={inactive}
        accessibilityRole="button"
        accessibilityState={{ disabled: inactive, busy: Boolean(loading) }}
        style={({ pressed }) => [
          styles.primary,
          pressed && styles.primaryPressed,
          disabled && !loading && styles.primaryDisabled,
        ]}
      >
        {loading ? (
          <ActivityIndicator color={colors.onAccent} />
        ) : (
          <Text style={styles.primaryText}>{label}</Text>
        )}
      </Pressable>
    </View>
  );
}

/** Transparent fill, 2px rule. Secondary and destructive actions. */
export function GhostButton({ label, onPress, disabled, style }: ButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      style={({ pressed }) => [
        styles.ghost,
        pressed && styles.ghostPressed,
        disabled && styles.ghostDisabled,
        style,
      ]}
    >
      <Text style={styles.ghostText}>{label}</Text>
    </Pressable>
  );
}

/** Single-select choice. Active fills with the accent. */
export function Chip({
  label,
  active,
  onPress,
  disabled,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled: Boolean(disabled) }}
      style={({ pressed }) => [
        styles.chip,
        active && styles.chipActive,
        pressed && !active && styles.chipPressed,
        disabled && styles.chipDisabled,
      ]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function ChipRow({ children, style }: Children & Styled<ViewStyle>) {
  return <View style={[styles.chipRow, style]}>{children}</View>;
}

/** Dark field, accent caret. Passes every TextInput prop straight through. */
export function Input({ style, ...rest }: TextInputProps) {
  return (
    <TextInput
      placeholderTextColor={colors.textFaint}
      selectionColor={colors.accent}
      cursorColor={colors.accent}
      keyboardAppearance="dark"
      {...rest}
      style={[styles.input, style]}
    />
  );
}

/** One row of the tale of the tape: a name on the left, a figure on the right. */
export function TapeRow({
  left,
  right,
  tag,
  highlight,
  last,
}: {
  left: string;
  right?: string;
  /** Small accent mark after the name, e.g. WINNER. */
  tag?: string;
  /** Sets the figure in the accent. */
  highlight?: boolean;
  last?: boolean;
}) {
  return (
    <View style={[styles.tapeRow, last && styles.tapeRowLast]}>
      <View style={styles.tapeLeft}>
        <Text style={styles.tapeName}>{left}</Text>
        {tag ? <Text style={styles.tapeTag}>{tag}</Text> : null}
      </View>
      {right ? (
        <Text style={[styles.tapeValue, highlight && styles.tapeValueHighlight]}>
          {right}
        </Text>
      ) : null}
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: space.lg - space.xs,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.lg,
    backgroundColor: colors.bg,
  },

  plate: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: space.lg - space.xs,
  },
  plateRaised: {
    backgroundColor: colors.surfaceRaised,
  },
  plateAccent: {
    backgroundColor: colors.accent,
  },

  kicker: { color: colors.accent },
  error: { color: colors.error, fontWeight: '600' },

  statValue: { marginTop: space.xs },
  statAccent: { color: colors.accent },
  statOnAccent: { color: colors.onAccent },
  labelOnAccent: { color: colors.onAccentMuted },

  wordmark: { alignSelf: 'flex-start' },
  wordmarkInk: { position: 'absolute', color: colors.accent },
  wordmarkTop: { color: colors.text },

  offsetWrap: {
    paddingRight: offset,
    paddingBottom: offset,
  },
  offsetLayer: {
    position: 'absolute',
    top: offset,
    left: offset,
    right: 0,
    bottom: 0,
    backgroundColor: colors.text,
    borderRadius: radius.md,
  },
  offsetLayerInactive: { backgroundColor: colors.textFaint },
  primary: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    minHeight: 56,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryPressed: {
    backgroundColor: colors.accentPressed,
    transform: [{ translateX: offset / 2 }, { translateY: offset / 2 }],
  },
  primaryDisabled: { opacity: 0.5 },
  primaryText: { ...typography.button, color: colors.onAccent },

  ghost: {
    borderRadius: radius.md,
    minHeight: 56,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.textMuted,
  },
  ghostPressed: { backgroundColor: colors.surfaceRaised },
  ghostDisabled: { opacity: 0.5 },
  ghostText: { ...typography.button, color: colors.text },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.rule,
    backgroundColor: colors.surface,
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipPressed: { backgroundColor: colors.surfaceRaised },
  chipDisabled: { opacity: 0.5 },
  chipText: { ...typography.button, fontSize: 13, color: colors.textMuted },
  chipTextActive: { color: colors.onAccent },

  input: {
    ...typography.body,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.rule,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md - 2,
    fontVariant: ['tabular-nums'],
  },

  tapeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: space.sm + 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.rule,
  },
  tapeRowLast: { borderBottomWidth: 0 },
  tapeLeft: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  tapeName: { ...typography.body, fontWeight: '600' },
  tapeTag: { ...typography.label, fontSize: 10, color: colors.accent },
  tapeValue: {
    ...typography.body,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  tapeValueHighlight: { color: colors.accent },
});
