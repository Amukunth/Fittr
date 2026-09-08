import React, { useCallback, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useFitnessProfile } from '../hooks/useFitnessProfile';
import { useBoutHistory } from '../hooks/useBoutHistory';
import type { BoutSummary, HistoryMark } from '../lib/boutStats';
import { fmtPoints, fmtSigned, relativeDay } from '../lib/format';
import { initialsOf, ownHandle, peerHandle } from '../lib/identity';
import type { RootStackParamList } from '../navigation/types';
import type { StrengthTier } from '../types/database';
import { TabBar } from '../components/TabBar';
import {
  EXERCISE_LABEL,
  TIERS,
  TIER_COLOR,
  TIER_DESC,
  TIER_LABEL,
  UNIT,
} from '../theme/copy';
import { Icon } from '../theme/icons';
import { colors, fonts, label, radius, space, typography } from '../theme/tokens';
import {
  Avatar,
  Button,
  Card,
  Display,
  IconCircle,
  Label,
  Loading,
  Notice,
  Numeral,
  Small,
  TierPill,
} from '../theme/ui';

type Props = NativeStackScreenProps<RootStackParamList, 'Profile'>;

const HISTORY_SLOTS = 12;

export function ProfileScreen({ navigation }: Props) {
  const { session, signOut } = useAuth();
  const { profile, loading, error, refresh } = useFitnessProfile();
  const { stats, refresh: refreshHistory } = useBoutHistory();
  const insets = useSafeAreaInsets();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [updatingTier, setUpdatingTier] = useState(false);

  useFocusEffect(
    useCallback(() => {
      refreshHistory();
    }, [refreshHistory]),
  );

  const setTier = async (tier: StrengthTier) => {
    setSheetOpen(false);
    if (!profile || tier === profile.strength_tier) {
      return;
    }
    setUpdatingTier(true);
    await supabase
      .from('fitness_profiles')
      .update({ strength_tier: tier })
      .eq('user_id', profile.user_id);
    setUpdatingTier(false);
    await refresh();
  };

  const settings = () => navigation.navigate('Settings');

  if (loading || !profile) {
    return <Loading />;
  }

  const handle = ownHandle(session);
  const name = handle.slice(1).replace(/[._-]+/g, ' ');
  const tier = profile.strength_tier;
  const hasBouts = Boolean(stats && stats.bouts.length > 0);
  const marks: Array<HistoryMark | null> = stats
    ? [
        ...Array<null>(Math.max(0, HISTORY_SLOTS - stats.history.length)).fill(null),
        ...stats.history.slice(-HISTORY_SLOTS),
      ]
    : Array<null>(HISTORY_SLOTS).fill(null);
  const pad = { paddingTop: insets.top + space.xl };

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={[styles.content, pad]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <View style={styles.identity}>
            <Avatar initials={initialsOf(handle)} size={56} tone="accent" />
            <View style={styles.identityText}>
              <Display size={28} numberOfLines={1}>
                {name}
              </Display>
              <View style={styles.handleRow}>
                <Text style={styles.handle}>{handle}</Text>
                <TierPill
                  tier={tier}
                  editable
                  onPress={updatingTier ? undefined : () => setSheetOpen(true)}
                />
              </View>
            </View>
          </View>
          <IconCircle
            icon="gear"
            color={colors.secondary}
            accessibilityLabel="Settings"
            onPress={settings}
          />
        </View>

        <Card radius={radius.hero} pad={space.xl} style={styles.balanceCard}>
          <Label size={11}>BALANCE</Label>
          <View style={styles.balanceRow}>
            <Numeral size={84} color={colors.accent}>
              {fmtPoints(profile.points_balance)}
            </Numeral>
            <Label size={12} color={colors.secondary} tracking={0.2}>
              {UNIT}
            </Label>
          </View>
          <View style={styles.record}>
            <View style={styles.recordCell}>
              <Label>WINS</Label>
              <Numeral size={32} style={styles.recordValue}>
                {stats ? String(stats.wins) : '—'}
              </Numeral>
            </View>
            <View style={styles.recordCell}>
              <Label>LOSSES</Label>
              <Numeral size={32} color={colors.secondary} style={styles.recordValue}>
                {stats ? String(stats.losses) : '—'}
              </Numeral>
            </View>
            <View style={styles.recordCell}>
              <Label>WIN RATE</Label>
              <Numeral size={32} style={styles.recordValue}>
                {stats?.winRate != null ? `${stats.winRate}%` : '—'}
              </Numeral>
            </View>
          </View>
        </Card>

        {error ? <Notice icon="warning">{error}</Notice> : null}

        {hasBouts && stats ? (
          <>
            <Card>
              <View style={styles.cardHead}>
                <Label>RANK HISTORY · LAST 12 BOUTS</Label>
                <Label size={11} color={colors.accent} tracking={0.08}>
                  {`STREAK ${stats.streak}`}
                </Label>
              </View>
              <View style={styles.bars}>
                {marks.map((mark, i) => (
                  <View key={i} style={[styles.bar, barStyle(mark, i)]} />
                ))}
              </View>
              <View style={styles.legend}>
                <Label size={9} tracking={0.12}>
                  W = LIME
                </Label>
                <Label size={9} tracking={0.12}>
                  L = GRAY
                </Label>
              </View>
            </Card>

            {stats.rivals.length > 0 ? (
              <View>
                <View style={styles.sectionHead}>
                  <Label>RIVALS</Label>
                </View>
                <View style={styles.rivals}>
                  {stats.rivals.slice(0, 3).map(r => {
                    const rivalHandle = peerHandle(r.userId);
                    const ahead = r.wins > r.losses;
                    return (
                      <View key={r.userId} style={styles.rival}>
                        <Avatar initials={initialsOf(rivalHandle)} size={36} />
                        <View style={styles.rivalText}>
                          <Text style={typography.rowTitle}>{rivalHandle}</Text>
                          <Text style={styles.rivalRecord}>
                            VS ·{' '}
                            <Text style={ahead ? styles.ahead : styles.behind}>
                              {`${r.wins}–${r.losses}`}
                            </Text>
                          </Text>
                        </View>
                        <Button
                          label="CALL OUT"
                          variant="outline"
                          size="sm"
                          onPress={() => navigation.navigate('FindBout')}
                        />
                      </View>
                    );
                  })}
                </View>
              </View>
            ) : null}

            <View>
              <View style={styles.sectionHead}>
                <Label>RECENT BOUTS</Label>
              </View>
              <View>
                {stats.bouts.slice(0, 6).map(b => (
                  <RecentRow key={b.matchId} bout={b} />
                ))}
              </View>
            </View>
          </>
        ) : (
          <>
            <View style={styles.emptyCard}>
              <Display size={36}>NO FIGHTS{'\n'}ON THE CARD.</Display>
              <Small style={styles.emptyBody}>
                Your record starts with your first bout. Your rank starts the
                second it settles.
              </Small>
              <Button
                label="TAKE A BOUT"
                size="md"
                onPress={() => navigation.navigate('FindBout')}
                style={styles.emptyButton}
              />
            </View>
            <Card>
              <Label>RANK HISTORY</Label>
              <View style={styles.bars}>
                {marks.map((_, i) => (
                  <View key={i} style={[styles.bar, styles.barEmpty]} />
                ))}
              </View>
              <Text style={styles.helper}>
                Unranked until your first verified bout.
              </Text>
            </Card>
          </>
        )}

        <Pressable onPress={() => signOut()} style={styles.logout} accessibilityRole="button">
          <Label size={11} color={colors.dim}>
            LOG OUT
          </Label>
        </Pressable>
      </ScrollView>
      <TabBar active="profile" />

      <TierSheet
        visible={sheetOpen}
        current={tier}
        onPick={setTier}
        onClose={() => setSheetOpen(false)}
      />
    </View>
  );
}

function barStyle(mark: HistoryMark | null, i: number) {
  if (mark === 'W') {
    return { height: 28 + ((i * 17) % 36), backgroundColor: colors.accent };
  }
  if (mark === 'L') {
    return { height: 10 + ((i * 13) % 14), backgroundColor: colors.slot };
  }
  if (mark === 'T') {
    return { height: 18, backgroundColor: colors.secondary };
  }
  return { height: 6, backgroundColor: colors.raised };
}

function RecentRow({ bout }: { bout: BoutSummary }) {
  const letter =
    bout.outcome === 'win'
      ? 'W'
      : bout.outcome === 'loss'
        ? 'L'
        : bout.outcome === 'tie'
          ? 'T'
          : bout.outcome === 'review'
            ? '?'
            : '·';
  const won = bout.outcome === 'win';
  const versus = bout.opponentId ? peerHandle(bout.opponentId) : 'open seat';
  return (
    <View style={styles.recent}>
      <View style={[styles.recentTile, won ? styles.recentTileWin : styles.recentTileOther]}>
        <Display size={15} color={won ? colors.accent : colors.secondary}>
          {letter}
        </Display>
      </View>
      <View style={styles.recentText}>
        <Text style={typography.rowTitle}>
          {EXERCISE_LABEL[bout.type]} <Text style={styles.vs}>vs</Text> {versus}
        </Text>
        <Text style={styles.when}>{relativeDay(bout.createdAt)}</Text>
      </View>
      <Numeral size={20} color={won ? colors.accent : colors.secondary}>
        {fmtSigned(bout.delta)}
      </Numeral>
    </View>
  );
}

/** Bottom sheet: pick a strength tier. */
function TierSheet({
  visible,
  current,
  onPick,
  onClose,
}: {
  visible: boolean;
  current: StrengthTier;
  onPick: (tier: StrengthTier) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const pad = { paddingBottom: Math.max(insets.bottom, space.lg) + space.xxxl };
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close">
        <Pressable style={[styles.sheet, pad]} onPress={() => undefined}>
          <View style={styles.grip} />
          <Label size={11}>STRENGTH TIER</Label>
          <Display size={32} style={styles.sheetTitle}>
            WHERE DO YOU FIGHT?
          </Display>
          <Small style={styles.sheetBody}>
            Sets who you get matched with. Your verified bouts will move you if
            you're lying.
          </Small>
          <View style={styles.tierList}>
            {TIERS.map(t => {
              const on = t === current;
              const color = TIER_COLOR[t];
              const dot = { backgroundColor: color };
              return (
                <Pressable
                  key={t}
                  onPress={() => onPick(t)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  style={[styles.tierOption, on && styles.tierOptionOn]}
                >
                  <View style={[styles.tierDot, dot]} />
                  <View style={styles.tierText}>
                    <Display size={18} color={color}>
                      {TIER_LABEL[t]}
                    </Display>
                    <Text style={styles.tierDesc}>{TIER_DESC[t]}</Text>
                  </View>
                  {on ? <Icon name="check" size={16} color={colors.accent} /> : null}
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: {
    paddingHorizontal: space.gutter,
    paddingBottom: space.gutter,
    gap: space.xl,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 14, flex: 1 },
  identityText: { flex: 1 },
  handleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.xs,
  },
  handle: { ...typography.meta, color: colors.secondary },

  balanceCard: {},
  balanceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.sm,
    marginTop: space.sm,
  },
  record: {
    flexDirection: 'row',
    gap: space.sm,
    marginTop: space.cardPad,
    paddingTop: space.cardPad,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  recordCell: { flex: 1 },
  recordValue: { marginTop: 6 },

  cardHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  bars: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 5,
    height: 64,
    marginTop: space.lg,
  },
  bar: { flex: 1, borderRadius: 3 },
  barEmpty: { height: 6, backgroundColor: colors.raised },
  legend: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: space.sm,
  },
  helper: { ...typography.helper, marginTop: space.sm + 2 },

  sectionHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: space.xs,
    paddingBottom: space.sm + 2,
  },
  rivals: { gap: 6 },
  rival: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: 14,
    borderRadius: radius.button,
    backgroundColor: colors.card,
  },
  rivalText: { flex: 1 },
  rivalRecord: { ...label(10, colors.dim, 0.12), marginTop: 3 },
  ahead: { color: colors.accent },
  behind: { color: colors.secondary },

  recent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  recentTile: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recentTileWin: { backgroundColor: colors.accentTint },
  recentTileOther: { backgroundColor: colors.raised },
  recentText: { flex: 1 },
  vs: { color: colors.dim },
  when: { ...typography.footnote, marginTop: 2 },

  emptyCard: {
    borderRadius: radius.card,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.slot,
    paddingVertical: 28,
    paddingHorizontal: 22,
  },
  emptyBody: { marginTop: space.sm + 2 },
  emptyButton: { marginTop: space.xl, alignSelf: 'flex-start' },

  logout: { alignItems: 'center', paddingVertical: space.md },

  scrim: {
    flex: 1,
    backgroundColor: colors.scrim,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    paddingTop: 14,
    paddingHorizontal: space.gutter,
  },
  grip: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.handle,
    alignSelf: 'center',
    marginBottom: space.cardPad,
  },
  sheetTitle: { marginTop: space.sm },
  sheetBody: { marginTop: 6 },
  tierList: { marginTop: space.cardPad, gap: space.sm },
  tierOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: space.lg,
    borderRadius: radius.button,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tierOptionOn: { backgroundColor: colors.raised, borderColor: colors.accent },
  tierDot: { width: 10, height: 10, borderRadius: 5 },
  tierText: { flex: 1 },
  tierDesc: {
    fontFamily: fonts.body,
    fontSize: 12,
    lineHeight: 16,
    color: colors.secondary,
    marginTop: space.xs,
  },
});
