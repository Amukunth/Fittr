import React, { useEffect, useRef } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LEAGUE_COLOR, LEAGUE_LABEL } from '../lib/league';
import type { LeagueTier } from '../types/database';
import { Icon } from '../theme/icons';
import { alpha, anton, colors, fonts, radius, space } from '../theme/tokens';

/** How long the whole thing is on screen. */
const LIFETIME_MS = 2600;

/** Enough to read as a burst, few enough to stay cheap on an old phone. */
const PIPS = 16;

interface CelebrationProps {
  /** Changes for each new event, which is what restarts the animation. */
  eventKey: number;
  /** Trophies gained. Negative is not celebrated; the screen filters those. */
  delta: number;
  league: LeagueTier;
  promoted: boolean;
  onDone: () => void;
}

/**
 * The burst when trophies land while the fighter is looking at this screen.
 *
 * A promotion gets the league's own colour and its name; a plain gain gets
 * the app's lime and the number. Both are the same shape, because a
 * promotion is a bigger version of the same news and not a different kind
 * of event.
 *
 * pointerEvents is off throughout: this is an announcement, never a thing
 * to dismiss, and it must not eat a tap meant for the leaderboard under it.
 */
export function Celebration({
  eventKey,
  delta,
  league,
  promoted,
  onDone,
}: CelebrationProps) {
  const insets = useSafeAreaInsets();
  const run = useRef(new Animated.Value(0)).current;
  const toast = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    run.setValue(0);
    toast.setValue(0);

    const animation = Animated.parallel([
      Animated.timing(run, {
        toValue: 1,
        duration: 1500,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.sequence([
        Animated.timing(toast, {
          toValue: 1,
          duration: 260,
          easing: Easing.out(Easing.back(1.6)),
          useNativeDriver: true,
        }),
        Animated.delay(LIFETIME_MS - 260 - 260),
        Animated.timing(toast, {
          toValue: 0,
          duration: 260,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    ]);

    animation.start(({ finished }) => {
      if (finished) {
        onDone();
      }
    });
    return () => animation.stop();
  }, [eventKey, onDone, run, toast]);

  const message = promoted
    ? `Promoted to ${LEAGUE_LABEL[league]}`
    : `${delta} ${delta === 1 ? 'trophy' : 'trophies'} earned`;

  // Screen readers get the news as an announcement; there is nothing for
  // them in the pips, and the toast is gone before focus could reach it.
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(message);
  }, [eventKey, message]);

  const tint = promoted ? LEAGUE_COLOR[league] : colors.accent;
  const ink = promoted ? LEAGUE_COLOR[league] : colors.onAccent;

  return (
    <View style={styles.layer} pointerEvents="none" accessibilityElementsHidden>
      <View style={styles.burst}>
        {Array.from({ length: PIPS }, (_, i) => (
          <Pip key={i} index={i} run={run} tint={tint} />
        ))}
      </View>

      <Animated.View
        style={[
          styles.toast,
          promoted ? styles.toastPromoted : styles.toastGain,
          promoted ? { borderColor: tint } : null,
          {
            top: insets.top + space.xl,
            opacity: toast,
            transform: [
              {
                translateY: toast.interpolate({
                  inputRange: [0, 1],
                  outputRange: [-28, 0],
                }),
              },
            ],
          },
        ]}
      >
        <Icon name={promoted ? 'arrow-up' : 'trophy'} size={16} color={ink} />
        <Text style={[styles.toastText, { color: ink }]} numberOfLines={1}>
          {promoted ? `${LEAGUE_LABEL[league]} league` : `+${delta}`}
        </Text>
        <Text
          style={[
            styles.toastNote,
            { color: promoted ? colors.secondary : colors.onAccentMuted },
          ]}
          numberOfLines={1}
        >
          {promoted ? 'PROMOTED' : 'TROPHIES'}
        </Text>
      </Animated.View>
    </View>
  );
}

/**
 * One pip of the burst. The angle and the distance come from the index
 * rather than from Math.random, so the shape is the same every time and a
 * re-render mid-flight cannot teleport one.
 */
function Pip({
  index,
  run,
  tint,
}: {
  index: number;
  run: Animated.Value;
  tint: string;
}) {
  const angle = (index / PIPS) * Math.PI * 2 + (index % 3) * 0.22;
  const reach = 96 + (index % 4) * 34;
  const size = index % 3 === 0 ? 9 : 6;

  return (
    <Animated.View
      style={[
        styles.pip,
        {
          width: size,
          height: size * (index % 2 === 0 ? 1 : 2.2),
          backgroundColor: index % 4 === 0 ? alpha(tint, 0.55) : tint,
        opacity: run.interpolate({
          inputRange: [0, 0.15, 0.75, 1],
          outputRange: [0, 1, 1, 0],
        }),
        transform: [
          {
            translateX: run.interpolate({
              inputRange: [0, 1],
              outputRange: [0, Math.cos(angle) * reach],
            }),
          },
          {
            // Up first, then gravity takes the tail of the arc back down.
            translateY: run.interpolate({
              inputRange: [0, 0.55, 1],
              outputRange: [
                0,
                Math.sin(angle) * reach * 0.75 - 30,
                Math.sin(angle) * reach + 54,
              ],
            }),
          },
          {
            rotate: run.interpolate({
              inputRange: [0, 1],
              outputRange: ['0deg', `${index % 2 === 0 ? 300 : -260}deg`],
            }),
          },
          {
            scale: run.interpolate({
              inputRange: [0, 0.2, 1],
              outputRange: [0.4, 1, 0.85],
            }),
          },
          ],
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  layer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
  },
  // Over the hero badge, which is where the eye already is.
  burst: {
    position: 'absolute',
    top: '26%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  toast: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderRadius: radius.control,
    maxWidth: '86%',
  },
  toastGain: { backgroundColor: colors.accent },
  toastPromoted: { backgroundColor: colors.card, borderWidth: 1 },
  pip: { position: 'absolute', borderRadius: 2 },
  toastText: { ...anton(20, { tracking: 0.02 }) },
  toastNote: {
    fontFamily: fonts.semibold,
    fontSize: 10,
    letterSpacing: 1.3,
    includeFontPadding: false,
  },
});
