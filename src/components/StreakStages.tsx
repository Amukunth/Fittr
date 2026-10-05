import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { fmtScore, rawAtReference, rawUnit } from '../lib/score';
import type { StreakStage } from '../lib/soloModes';
import type { ChallengeType } from '../types/database';
import { Icon } from '../theme/icons';
import { colors, label, numeral, radius, space, typography } from '../theme/tokens';

export type StageStatus = 'cleared' | 'active' | 'failed' | 'locked' | 'idle';

/**
 * The vertical list of stage cards from the reference, in Fittr's colours:
 * one card per stage, its number on the left, the score to beat in the
 * middle, and its state on the right.
 *
 *   active   the stage the run is on: accent border, plain surface.
 *   cleared  a check in the accent.
 *   failed   a filled X badge in the one non-lime colour the system has
 *            (the recording red), and the card dimmed.
 *   locked   a lock, the card faded.
 *   idle     no run yet: every stage plain, nothing marked.
 *
 * Targets are SCORES; the caption under each says roughly what that is in
 * reps or seconds at the reference form quality, because a fighter cannot
 * picture "2,040" but can picture "about 24 reps".
 */
export function StreakStages({
  stages,
  type,
  statusOf,
  scoreOf,
  referenceQualityBp,
}: {
  stages: readonly StreakStage[];
  type: ChallengeType;
  statusOf: (stage: number) => StageStatus;
  /** What was actually scored on this stage, if it has been played. */
  scoreOf?: (stage: number) => number | null;
  referenceQualityBp: number;
}) {
  return (
    <View style={styles.list}>
      {stages.map((s, i) => {
        const status = statusOf(s.stage);
        const done = scoreOf?.(s.stage) ?? null;
        const dimmed = status === 'locked';
        const numberInk =
          status === 'active' ? colors.text : status === 'cleared' ? colors.accent : colors.secondary;
        return (
          <React.Fragment key={s.stage}>
            {i > 0 ? <View style={styles.connector} /> : null}
            <View
              style={[
                styles.card,
                status === 'active' && styles.cardActive,
                status === 'failed' && styles.cardFailed,
                dimmed && styles.cardLocked,
              ]}
              accessibilityLabel={`Stage ${s.stage}, score to beat ${fmtScore(s.target)}, ${status}`}
            >
              <View style={styles.number}>
                <Text style={styles.numberLabel}>STAGE</Text>
                <Text style={[styles.numberValue, { color: numberInk }]}>{String(s.stage)}</Text>
              </View>
              <View style={styles.middle}>
                <Text style={styles.toBeat}>SCORE TO BEAT</Text>
                <Text style={[styles.target, status === 'active' && styles.targetActive]}>
                  {fmtScore(s.target)}
                </Text>
                <Text style={styles.caption}>
                  {done !== null
                    ? `YOU SCORED ${fmtScore(done)}`
                    : `≈ ${rawAtReference(s.target, referenceQualityBp)} ${rawUnit(type)} AT REFERENCE FORM`}
                </Text>
              </View>
              <View style={styles.right}>
                {status === 'cleared' ? (
                  <View style={[styles.badge, styles.badgeCleared]}>
                    <Icon name="check" size={14} color={colors.onAccent} />
                  </View>
                ) : status === 'failed' ? (
                  <View style={[styles.badge, styles.badgeFailed]}>
                    <Icon name="x" size={14} color={colors.text} />
                  </View>
                ) : status === 'locked' ? (
                  <Icon name="lock" size={18} color={colors.dim} />
                ) : status === 'active' ? (
                  <View style={styles.liveDot} />
                ) : null}
              </View>
            </View>
          </React.Fragment>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: {},
  connector: {
    width: 2,
    height: 12,
    marginLeft: 38,
    backgroundColor: colors.slot,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 92,
    borderRadius: radius.card,
    backgroundColor: colors.card,
    borderWidth: 1.5,
    borderColor: 'transparent',
    overflow: 'hidden',
  },
  cardActive: {
    borderColor: colors.accent,
  },
  cardFailed: {
    borderColor: colors.border,
  },
  cardLocked: { opacity: 0.45 },
  number: {
    width: 78,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    backgroundColor: colors.raised,
  },
  numberLabel: { ...label(9, colors.dim, 0.14) },
  numberValue: { ...numeral(30) },
  middle: { flex: 1, paddingVertical: 14, paddingHorizontal: space.lg, gap: 3 },
  toBeat: { ...label(10, colors.secondary, 0.12) },
  target: { ...numeral(28) },
  targetActive: { color: colors.text },
  caption: { ...typography.footnote, marginTop: 2 },
  right: { width: 56, alignItems: 'center', justifyContent: 'center' },
  badge: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeCleared: { backgroundColor: colors.accent },
  badgeFailed: { backgroundColor: colors.recording },
  liveDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.accent,
  },
});
