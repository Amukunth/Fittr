import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors } from '../theme/tokens';

/**
 * A circular progress indicator, drawn from two clipped half-rings.
 *
 * No SVG runtime is linked in this app (see theme/icons.tsx), so the arc is
 * made the way it was before SVG: a ring whose top and right borders are
 * coloured covers a 180-degree span starting 45 degrees anticlockwise of
 * vertical. Put one of those inside a half-width container with overflow
 * hidden and rotate it, and the visible part is exactly the arc wanted.
 *
 * Right half shows the first 50%, left half the rest:
 *
 *   right: span [a-180, a] intersected with the visible [0, 180]  -> [0, a]
 *   left:  span [b, b+180] intersected with the visible [180, 360] -> [180, 180+b]
 *
 * which is where the two rotation constants below come from. Angles run
 * clockwise from twelve o'clock, like a clock face and like the eye expects
 * a progress arc to.
 */

interface ProgressRingProps {
  /** 0..1. Clamped. */
  progress: number;
  size?: number;
  thickness?: number;
  color?: string;
  trackColor?: string;
  /** Rendered in the middle of the ring. */
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function ProgressRing({
  progress,
  size = 84,
  thickness = 7,
  color = colors.accent,
  trackColor = colors.raised,
  children,
  style,
}: ProgressRingProps) {
  const d = size;
  const p = Math.max(0, Math.min(1, progress));
  const first = Math.min(p, 0.5) * 360;
  const second = Math.max(p - 0.5, 0) * 360;

  const ring = (rotate: number, offset: number): ViewStyle => ({
    left: offset,
    width: d,
    height: d,
    borderRadius: d / 2,
    borderWidth: thickness,
    borderTopColor: color,
    borderRightColor: color,
    transform: [{ rotate: `${rotate}deg` }],
  });

  const clip = (side: 'left' | 'right'): ViewStyle => ({
    left: side === 'left' ? 0 : d / 2,
    width: d / 2,
    height: d,
  });

  const track: ViewStyle = {
    width: d,
    height: d,
    borderRadius: d / 2,
    borderWidth: thickness,
    borderColor: trackColor,
  };

  return (
    <View style={[styles.frame, { width: d, height: d }, style]}>
      <View style={[styles.layer, track]} />
      {/* The left half is drawn first so the second lap's arc cannot sit on
          top of the first lap's start where they meet at twelve o'clock. */}
      <View style={[styles.clip, clip('left')]} pointerEvents="none">
        <View style={[styles.layer, styles.arc, ring(second + 45, 0)]} />
      </View>
      <View style={[styles.clip, clip('right')]} pointerEvents="none">
        <View style={[styles.layer, styles.arc, ring(first - 135, -d / 2)]} />
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { alignItems: 'center', justifyContent: 'center' },
  layer: { position: 'absolute', top: 0 },
  clip: { position: 'absolute', top: 0, overflow: 'hidden' },
  // Only the top and right edges are painted by `ring`; the other two have
  // to be transparent or the ring would be a full circle.
  arc: { borderColor: 'transparent' },
});
