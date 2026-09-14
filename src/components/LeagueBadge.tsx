import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { LEAGUE_COLOR, leagueIndex } from '../lib/league';
import type { LeagueTier } from '../types/database';
import { alpha, colors } from '../theme/tokens';

/**
 * The league medallion, drawn from Views like everything in theme/icons.tsx
 * -- no icon font and no SVG runtime is linked in this app, and adding
 * either is a native change.
 *
 * The silhouette elaborates as the league climbs rather than changing
 * shape: every badge is the same medallion, and Gold adds the star points
 * behind it, Platinum adds a second ring and the crown pips, Diamond adds
 * the shimmer. So the five read as one family and as an order, which is
 * what a ladder has to look like -- rather than five unrelated emblems
 * where only the colour says which is higher.
 *
 * The chevron stack in the middle counts the league (one for Bronze, five
 * for Diamond) and is dropped below `MARK_MIN`, where five 3px chevrons
 * would be mush. At that size the colour and the silhouette carry it, which
 * is all a 20px leaderboard row needs.
 */

/** Below this the chevron count is replaced by a solid centre. */
const MARK_MIN = 56;

interface LeagueBadgeProps {
  tier: LeagueTier;
  size?: number;
  /** Runs the halo (and Diamond's shimmer). Off for static, small badges. */
  animated?: boolean;
  style?: StyleProp<ViewStyle>;
  /** Drawn in grey, for a league not reached yet. */
  locked?: boolean;
}

export function LeagueBadge({
  tier,
  size = 40,
  animated = false,
  locked = false,
  style,
}: LeagueBadgeProps) {
  const s = size;
  const rank = leagueIndex(tier);
  const color = locked ? colors.handle : LEAGUE_COLOR[tier];

  const hasPoints = rank >= 2; // Gold and up
  const hasCrown = rank >= 3; // Platinum and up
  const hasShimmer = rank >= 4 && animated && !locked; // Diamond only

  const halo = useRef(new Animated.Value(0)).current;
  const sweep = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!animated) {
      return;
    }
    // Breathing rather than blinking: a slow ease in and out, and the
    // opacity never reaches zero, so a glance never catches it "off".
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(halo, {
          toValue: 1,
          duration: 1600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(halo, {
          toValue: 0,
          duration: 1600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [animated, halo]);

  useEffect(() => {
    if (!hasShimmer) {
      return;
    }
    // A highlight crossing the face, then a long pause before the next
    // pass. Diamond is the top of the ladder; it should catch the light,
    // not strobe.
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(sweep, {
          toValue: 1,
          duration: 1100,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.delay(1700),
      ]),
    );
    sweep.setValue(0);
    loop.start();
    return () => loop.stop();
  }, [hasShimmer, sweep]);

  const box: ViewStyle = { width: s, height: s };
  const centred: ViewStyle = { alignItems: 'center', justifyContent: 'center' };

  const plate = (rotate: number): ViewStyle => ({
    position: 'absolute',
    width: s * 0.66,
    height: s * 0.66,
    borderRadius: s * 0.11,
    borderWidth: Math.max(1, s * 0.022),
    borderColor: alpha(color, locked ? 0.3 : 0.45),
    transform: [{ rotate: `${rotate}deg` }],
  });

  const ring: ViewStyle = {
    position: 'absolute',
    width: s * 0.74,
    height: s * 0.74,
    borderRadius: s * 0.37,
    borderWidth: Math.max(1.5, s * 0.045),
    borderColor: color,
    backgroundColor: alpha(color, locked ? 0.05 : 0.14),
    overflow: 'hidden',
    ...centred,
  };

  const inner: ViewStyle = {
    position: 'absolute',
    width: s * 0.56,
    height: s * 0.56,
    borderRadius: s * 0.28,
    borderWidth: Math.max(1, s * 0.014),
    borderColor: alpha(color, locked ? 0.25 : 0.4),
  };

  /** One chevron of the count stack. */
  const chevron = (i: number): ViewStyle => {
    const w = s * 0.2;
    return {
      width: w,
      height: w * 0.55,
      borderLeftWidth: Math.max(1.5, s * 0.03),
      borderTopWidth: Math.max(1.5, s * 0.03),
      borderColor: color,
      borderTopLeftRadius: 1,
      transform: [{ rotate: '45deg' }],
      marginTop: i === 0 ? 0 : -w * 0.16,
    };
  };

  const pip = (offset: number, scale: number): ViewStyle => ({
    position: 'absolute',
    top: s * 0.005,
    left: s * 0.5 - (s * 0.05 * scale) / 2 + offset,
    width: s * 0.05 * scale,
    height: s * 0.05 * scale,
    borderRadius: s * 0.025 * scale,
    backgroundColor: color,
  });

  const haloStyle = {
    position: 'absolute' as const,
    width: s * 0.86,
    height: s * 0.86,
    borderRadius: s * 0.43,
    backgroundColor: alpha(color, 0.22),
    opacity: halo.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.7] }),
    transform: [
      { scale: halo.interpolate({ inputRange: [0, 1], outputRange: [0.95, 1.28] }) },
    ],
  };

  const sweepStyle = {
    position: 'absolute' as const,
    width: s * 0.22,
    height: s * 1.4,
    backgroundColor: alpha('#FFFFFF', 0.5),
    transform: [
      { rotate: '22deg' },
      {
        translateX: sweep.interpolate({
          inputRange: [0, 1],
          outputRange: [-s * 0.8, s * 0.8],
        }),
      },
    ],
  };

  return (
    <View style={[box, centred, style]} pointerEvents="none">
      {animated && !locked ? <Animated.View style={haloStyle} /> : null}

      {hasPoints ? (
        <>
          <View style={plate(0)} />
          <View style={plate(45)} />
        </>
      ) : null}

      {hasCrown ? (
        <>
          <View style={pip(-s * 0.15, 0.8)} />
          <View style={pip(0, 1)} />
          <View style={pip(s * 0.15, 0.8)} />
        </>
      ) : null}

      <View style={ring}>
        {hasShimmer ? <Animated.View style={sweepStyle} /> : null}
      </View>
      {hasCrown ? <View style={inner} /> : null}

      {s >= MARK_MIN ? (
        <View style={styles.mark}>
          {Array.from({ length: rank + 1 }, (_, i) => (
            <View key={i} style={chevron(i)} />
          ))}
        </View>
      ) : (
        <View
          style={{
            width: s * 0.2,
            height: s * 0.2,
            borderRadius: s * 0.1,
            backgroundColor: color,
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  mark: { alignItems: 'center', justifyContent: 'center' },
});
