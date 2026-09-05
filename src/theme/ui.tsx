import React, { useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextProps as RNTextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { StrengthTier } from '../types/database';
import { TIER_COLOR, TIER_LABEL } from './copy';
import { Icon, type IconName } from './icons';
import {
  anton,
  colors,
  fonts,
  label as labelStyle,
  numeral,
  radius,
  sizes,
  space,
  typography,
} from './tokens';

/**
 * Presentational primitives only. Nothing in here owns state, talks to the
 * network, or decides anything: screens keep all of that. These exist so
 * the screens share one set of surfaces, weights and spacings, transcribed
 * from the design canvas, instead of eight hand-tuned copies.
 */

type Children = { children?: React.ReactNode };
type Styled<T> = { style?: StyleProp<T> };

// ── Layout ──────────────────────────────────────────────────────────────

export function Screen({ children, style }: Children & Styled<ViewStyle>) {
  return <View style={[styles.screen, style]}>{children}</View>;
}

export function Loading() {
  return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={colors.accent} />
    </View>
  );
}

export function Row({
  children,
  gap = space.sm,
  align = 'center',
  justify = 'flex-start',
  style,
}: Children &
  Styled<ViewStyle> & {
    gap?: number;
    align?: ViewStyle['alignItems'];
    justify?: ViewStyle['justifyContent'];
  }) {
  const dyn: ViewStyle = {
    flexDirection: 'row',
    alignItems: align,
    justifyContent: justify,
    gap,
  };
  return <View style={[dyn, style]}>{children}</View>;
}

/** Chrome row under the status bar: back circle on the left, actions on the right. */
export function TopBar({
  left,
  right,
  style,
}: Styled<ViewStyle> & { left?: React.ReactNode; right?: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const pad: ViewStyle = { paddingTop: insets.top + space.md };
  return (
    <View style={[styles.topBar, pad, style]}>
      <View style={styles.topBarSide}>{left}</View>
      <View style={[styles.topBarSide, styles.topBarRight]}>{right}</View>
    </View>
  );
}

/** Page title block: a small label over a 40px Anton head. */
export function PageHead({
  kicker,
  title,
  right,
  style,
}: Styled<ViewStyle> & {
  kicker?: React.ReactNode;
  title: string;
  right?: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const pad: ViewStyle = { paddingTop: insets.top + space.xl };
  return (
    <View style={[styles.pageHead, pad, style]}>
      <View style={styles.pageHeadText}>
        {typeof kicker === 'string' ? <Label size={11}>{kicker}</Label> : kicker}
        <Text style={styles.pageTitle}>{title}</Text>
      </View>
      {right}
    </View>
  );
}

/** Bottom action area in the thumb zone. */
export function Dock({
  children,
  transparent,
  style,
}: Children & Styled<ViewStyle> & { transparent?: boolean }) {
  const insets = useSafeAreaInsets();
  const dyn: ViewStyle = {
    paddingBottom: Math.max(insets.bottom, space.lg) + space.md,
    backgroundColor: transparent ? 'transparent' : colors.bg,
  };
  return <View style={[styles.dock, dyn, style]}>{children}</View>;
}

export function Divider({ style }: Styled<ViewStyle>) {
  return <View style={[styles.divider, style]} />;
}

// ── Type ────────────────────────────────────────────────────────────────

type TextProps = RNTextProps & Children;

/** Anton, uppercase. Sizes per the design's scale. */
export function Display({
  size = 40,
  tracking,
  color,
  style,
  ...rest
}: TextProps & { size?: number; tracking?: number; color?: string }) {
  const base = anton(size, { tracking, color });
  return <Text {...rest} style={[base, style]} />;
}

/** Anton numbers: tabular, tight, case untouched. */
export function Numeral({
  size = 36,
  color,
  style,
  ...rest
}: TextProps & { size?: number; color?: string }) {
  const base = numeral(size, color);
  return <Text {...rest} style={[base, style]} />;
}

/** Inter 600 caps label. */
export function Label({
  size = 10,
  color,
  tracking,
  style,
  ...rest
}: TextProps & { size?: number; color?: string; tracking?: number }) {
  const base = labelStyle(size, color, tracking);
  return <Text {...rest} style={[base, style]} />;
}

export function Body({ muted, style, ...rest }: TextProps & { muted?: boolean }) {
  return (
    <Text
      {...rest}
      style={[muted ? typography.bodyMuted : typography.body, style]}
    />
  );
}

export function Small({ style, ...rest }: TextProps) {
  return <Text {...rest} style={[typography.small, style]} />;
}

export function Meta({ style, ...rest }: TextProps) {
  return <Text {...rest} style={[typography.meta, style]} />;
}

export function ErrorText({ style, ...rest }: TextProps) {
  return <Text accessibilityRole="alert" {...rest} style={[styles.error, style]} />;
}

// ── Controls ────────────────────────────────────────────────────────────

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'card'
  | 'white'
  | 'onAccentGhost'
  | 'onAccentDark'
  | 'outline';

const VARIANT: Record<
  ButtonVariant,
  { bg: string; pressed: string; fg: string; border?: string }
> = {
  primary: { bg: colors.accent, pressed: colors.accentPressed, fg: colors.onAccent },
  secondary: { bg: colors.raised, pressed: colors.handle, fg: colors.text },
  card: { bg: colors.card, pressed: colors.raised, fg: colors.text },
  white: { bg: colors.text, pressed: colors.accent, fg: colors.onAccent },
  onAccentGhost: {
    bg: colors.onAccentGhost,
    pressed: colors.onAccentFaint,
    fg: colors.onAccent,
  },
  onAccentDark: { bg: colors.onAccent, pressed: colors.raised, fg: colors.text },
  outline: {
    bg: 'transparent',
    pressed: colors.accentTint,
    fg: colors.accent,
    border: colors.accentOutline,
  },
};

/** 56px Anton button. One primary per screen. */
export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  icon,
  size = 'lg',
  style,
}: Styled<ViewStyle> & {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  icon?: IconName;
  size?: 'lg' | 'md' | 'sm';
}) {
  const inactive = Boolean(disabled || loading);
  const v = VARIANT[variant];
  const height =
    size === 'lg' ? sizes.button : size === 'md' ? sizes.buttonMd : sizes.buttonSm;
  const fontSize = size === 'lg' ? 20 : size === 'md' ? 18 : 14;
  const fg = inactive ? colors.dim : v.fg;
  const textStyle = anton(fontSize, { tracking: 0.04, color: fg });
  const shape: ViewStyle = {
    height,
    borderRadius: size === 'sm' ? radius.tile : radius.button,
    paddingHorizontal: size === 'sm' ? space.md + 2 : space.xxl,
    borderWidth: v.border ? 1 : 0,
    borderColor: inactive ? colors.border : v.border,
  };
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: Boolean(loading) }}
      style={({ pressed }) => {
        const fill: ViewStyle = {
          backgroundColor: inactive
            ? variant === 'outline'
              ? 'transparent'
              : colors.card
            : pressed
              ? v.pressed
              : v.bg,
        };
        return [styles.button, shape, fill, style];
      }}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          {icon ? <Icon name={icon} size={fontSize * 0.9} color={fg} /> : null}
          <Text style={textStyle} numberOfLines={1}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

/** 44px circular icon button. Back, close, share, settings. */
export function IconCircle({
  icon,
  onPress,
  color = colors.text,
  bg = colors.card,
  size = sizes.circle,
  accessibilityLabel,
  style,
}: Styled<ViewStyle> & {
  icon: IconName;
  onPress?: () => void;
  color?: string;
  bg?: string;
  size?: number;
  accessibilityLabel: string;
}) {
  const dyn: ViewStyle = {
    width: size,
    height: size,
    borderRadius: size / 2,
    backgroundColor: bg,
  };
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={6}
      style={({ pressed }) => [styles.circle, dyn, pressed && styles.pressedDim, style]}
    >
      <Icon name={icon} size={18} color={color} />
    </Pressable>
  );
}

/** Pill filter. Active is white on black. */
export function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [
        styles.chip,
        active ? styles.chipActive : pressed && styles.chipPressed,
      ]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

/** 56px field. Passes every TextInput prop straight through. */
export function Input({ style, ...rest }: TextInputProps) {
  return (
    <TextInput
      placeholderTextColor={colors.dim}
      selectionColor={colors.accent}
      cursorColor={colors.accent}
      keyboardAppearance="dark"
      {...rest}
      style={[styles.input, style]}
    />
  );
}

// ── Surfaces ────────────────────────────────────────────────────────────

export function Card({
  children,
  raised,
  pad = space.cardPad,
  radius: r = radius.card,
  style,
}: Children &
  Styled<ViewStyle> & { raised?: boolean; pad?: number; radius?: number }) {
  const dyn: ViewStyle = {
    padding: pad,
    borderRadius: r,
    backgroundColor: raised ? colors.raised : colors.card,
  };
  return <View style={[dyn, style]}>{children}</View>;
}

/** Small caps tag: the format on a bout card. */
export function Tag({
  label,
  tone = 'raised',
  style,
}: Styled<ViewStyle> & {
  label: string;
  tone?: 'raised' | 'accent' | 'dark';
}) {
  const bg =
    tone === 'accent' ? colors.accentTint : tone === 'dark' ? colors.bg : colors.raised;
  const fg = tone === 'accent' ? colors.accent : colors.text;
  const dyn: ViewStyle = { backgroundColor: bg };
  const text = labelStyle(10, fg, 0.12);
  return (
    <View style={[styles.tag, dyn, style]}>
      <Text style={text}>{label}</Text>
    </View>
  );
}

/** Outlined tier marker in the tier's own colour. */
export function TierPill({
  tier,
  editable,
  onPress,
  style,
}: Styled<ViewStyle> & {
  tier: StrengthTier;
  editable?: boolean;
  onPress?: () => void;
}) {
  const color = TIER_COLOR[tier];
  const dyn: ViewStyle = { borderColor: color };
  const text = labelStyle(10, color, 0.12);
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${TIER_LABEL[tier]} tier`}
      hitSlop={8}
      style={[styles.tierPill, dyn, style]}
    >
      <Text style={text}>{TIER_LABEL[tier]}</Text>
      {editable ? <Icon name="pencil" size={10} color={color} /> : null}
    </Pressable>
  );
}

const AVATAR_TONE = {
  raised: [colors.raised, colors.secondary],
  accent: [colors.accent, colors.onAccent],
  dark: [colors.onAccent, colors.text],
  empty: ['transparent', colors.dim],
} as const;

export function Avatar({
  initials,
  size = 26,
  tone = 'raised',
  style,
}: Styled<ViewStyle> & {
  initials: string;
  size?: number;
  tone?: keyof typeof AVATAR_TONE;
}) {
  const [bg, fg] = AVATAR_TONE[tone];
  const dyn: ViewStyle = {
    width: size,
    height: size,
    borderRadius: size / 2,
    backgroundColor: bg,
    borderWidth: tone === 'empty' ? 2 : 0,
    borderStyle: tone === 'empty' ? 'dashed' : 'solid',
    borderColor: colors.slot,
  };
  const text: TextStyle = {
    fontFamily: fonts.semibold,
    fontSize: Math.round(size * 0.38),
    color: fg,
    includeFontPadding: false,
  };
  return (
    <View style={[styles.avatar, dyn, style]}>
      <Text style={text}>{initials}</Text>
    </View>
  );
}

/** The spots-claimed bar: one segment per seat. */
export function Slots({
  filled,
  max,
  height = 4,
  gap = 3,
  style,
}: Styled<ViewStyle> & {
  filled: number;
  max: number;
  height?: number;
  gap?: number;
}) {
  const row: ViewStyle = { flexDirection: 'row', gap };
  const cell: ViewStyle = { flex: 1, height, borderRadius: height / 2 };
  return (
    <View style={[row, style]}>
      {Array.from({ length: max }, (_, i) => (
        <View key={i} style={[cell, i < filled ? styles.slotOn : styles.slotOff]} />
      ))}
    </View>
  );
}

/** Label over a big number, with its unit. */
export function StatCard({
  label,
  value,
  unit,
  accent,
  size = 40,
  style,
}: Styled<ViewStyle> & {
  label: string;
  value: string;
  unit?: string;
  accent?: boolean;
  size?: number;
}) {
  return (
    <Card pad={space.lg} style={style}>
      <Label>{label}</Label>
      <View style={styles.statRow}>
        <Numeral size={size} color={accent ? colors.accent : colors.text}>
          {value}
        </Numeral>
        {unit ? (
          <Label size={11} color={colors.secondary} tracking={0.1}>
            {unit}
          </Label>
        ) : null}
      </View>
    </Card>
  );
}

/** Raised strip with an icon: warnings, waits, small system notes. */
export function Notice({
  icon,
  iconColor = colors.text,
  tone = 'raised',
  children,
  style,
}: Children &
  Styled<ViewStyle> & {
    icon?: IconName;
    iconColor?: string;
    tone?: 'raised' | 'card';
  }) {
  return (
    <View style={[styles.notice, tone === 'card' && styles.noticeCard, style]}>
      {icon ? <Icon name={icon} size={16} color={iconColor} /> : null}
      <Text style={styles.noticeText}>{children}</Text>
    </View>
  );
}

/** Dashed empty-state ring with a zero in it. */
export function EmptyRing({ children = '0' }: Children) {
  return (
    <View style={styles.emptyRing}>
      <Text style={styles.emptyRingText}>{children}</Text>
    </View>
  );
}

// ── Motion ──────────────────────────────────────────────────────────────

/** The live dot. Pulses forever; unmounting stops it. */
export function LiveDot({
  color = colors.accent,
  size = 6,
  period = 1400,
}: {
  color?: string;
  size?: number;
  period?: number;
}) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.25,
          duration: period / 2,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: period / 2,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity, period]);
  const dyn = {
    width: size,
    height: size,
    borderRadius: size / 2,
    backgroundColor: color,
    opacity,
  };
  return <Animated.View style={dyn} />;
}

/** Loading placeholder block. */
export function Skeleton({
  width,
  height,
  radius: r = 6,
  style,
}: Styled<ViewStyle> & {
  width: number | `${number}%`;
  height: number;
  radius?: number;
}) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.45,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  const dyn = {
    width,
    height,
    borderRadius: r,
    backgroundColor: colors.raised,
    opacity,
  };
  return <Animated.View style={[dyn, style]} />;
}

// ── Styles ──────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },

  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: space.lg,
  },
  topBarSide: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  topBarRight: { justifyContent: 'flex-end' },

  pageHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingHorizontal: space.gutter,
  },
  pageHeadText: { flex: 1 },
  pageTitle: { ...anton(40), marginTop: space.sm },

  dock: {
    paddingTop: space.md,
    paddingHorizontal: space.gutter,
  },
  divider: { height: 1, backgroundColor: colors.line },

  error: {
    fontFamily: fonts.medium,
    fontSize: 13,
    lineHeight: 18,
    color: colors.accent,
  },

  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm + 2,
  },
  circle: { alignItems: 'center', justifyContent: 'center' },
  pressedDim: { opacity: 0.7 },

  chip: {
    height: sizes.chip,
    paddingHorizontal: space.lg - 2,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
  },
  chipActive: { backgroundColor: colors.text },
  chipPressed: { backgroundColor: colors.raised },
  chipText: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    letterSpacing: 0.5,
    color: colors.secondary,
    includeFontPadding: false,
  },
  chipTextActive: { color: colors.onAccent },

  input: {
    height: sizes.input,
    borderRadius: radius.button,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    paddingHorizontal: space.cardPad,
    fontFamily: fonts.medium,
    fontSize: 16,
    color: colors.text,
  },

  tag: {
    paddingVertical: 7,
    paddingHorizontal: 9,
    borderRadius: radius.tag,
    alignSelf: 'flex-start',
  },
  tierPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderRadius: 6,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  slotOn: { backgroundColor: colors.accent },
  slotOff: { backgroundColor: colors.slot },
  statRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 5,
    marginTop: space.sm,
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 2,
    backgroundColor: colors.raised,
    borderRadius: radius.control,
    paddingVertical: space.md,
    paddingHorizontal: space.lg - 2,
  },
  noticeCard: { backgroundColor: colors.card },
  noticeText: {
    flex: 1,
    fontFamily: fonts.medium,
    fontSize: 13,
    lineHeight: 18,
    color: colors.text,
  },
  emptyRing: {
    width: 96,
    height: 96,
    borderRadius: 48,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.slot,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyRingText: { ...anton(40, { color: colors.slot }) },
});
