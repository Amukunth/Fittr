import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useBoutHistory } from '../hooks/useBoutHistory';
import { useFitnessProfile } from '../hooks/useFitnessProfile';
import type { BoutSummary } from '../lib/boutStats';
import type { CompeteMode, RootStackParamList } from '../navigation/types';
import {
  COMPETE_MODES,
  EXERCISE_ICON,
  EXERCISE_LABEL,
  MODE_ICON,
  MODE_LABEL,
  VERIFIABLE_TYPES,
} from '../theme/copy';
import { Icon } from '../theme/icons';
import { colors, space } from '../theme/tokens';
import { Body, Button, Display, Dock, IconCircle, Label, PillTabs, TopBar } from '../theme/ui';
import { OneVOnePane } from './modes/OneVOnePane';
import { BlitzPane } from './modes/BlitzPane';
import { StreakPane } from './modes/StreakPane';

type Props = NativeStackScreenProps<RootStackParamList, 'ExerciseModes'>;

/**
 * One exercise, three modes. Pill tabs across the top and a horizontal
 * pager underneath, kept in step both ways: tapping a pill scrolls the
 * pager, swiping the pager moves the pill. Each pane owns its own reads and
 * its own dock, so the stake control and the CTA are always the ones for
 * the mode on screen.
 *
 * Mirrors `_mm_open_round_blocks_for()` in the matchmaking migration: a bout
 * you have not played yet blocks starting anything until it is this old.
 * Found here once and handed to all three panes, so each can disable its
 * CTA and offer the way back into that round instead of a start that would
 * be refused on arrival.
 */
const OPEN_ROUND_BLOCKS_FOR_MS = 24 * 60 * 60 * 1000;

export function ExerciseModesScreen({ route, navigation }: Props) {
  const { exerciseType, mode: initialMode = '1v1', fresh = false } = route.params;
  const { width } = useWindowDimensions();
  const { profile } = useFitnessProfile();
  const { stats } = useBoutHistory();
  const [mode, setMode] = useState<CompeteMode>(initialMode);
  const [pagerHeight, setPagerHeight] = useState(0);
  const pagerRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const initialIndex = Math.max(0, COMPETE_MODES.indexOf(initialMode));

  const balance = profile?.points_balance ?? null;

  const openRound: BoutSummary | null = useMemo(() => {
    if (!stats) {
      return null;
    }
    const cutoff = Date.now() - OPEN_ROUND_BLOCKS_FOR_MS;
    return (
      stats.active.find(
        b => b.myScore === null && new Date(b.createdAt).getTime() > cutoff,
      ) ?? null
    );
  }, [stats]);

  const select = useCallback(
    (next: CompeteMode) => {
      setMode(next);
      pagerRef.current?.scrollTo({
        x: COMPETE_MODES.indexOf(next) * width,
        animated: true,
      });
    },
    [width],
  );

  const onMomentumEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const index = Math.round(e.nativeEvent.contentOffset.x / Math.max(1, width));
      const next = COMPETE_MODES[Math.max(0, Math.min(COMPETE_MODES.length - 1, index))];
      if (next && next !== mode) {
        setMode(next);
      }
    },
    [width, mode],
  );

  // Land on the requested tab without an animation, and stay on the right
  // page if the window is resized (a rotation, a split view).
  useEffect(() => {
    pagerRef.current?.scrollTo({ x: COMPETE_MODES.indexOf(mode) * width, animated: false });
    // Only the width matters here: a mode change scrolls itself in select().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width]);

  const onPagerLayout = (e: LayoutChangeEvent) => setPagerHeight(e.nativeEvent.layout.height);

  const goToRound = useCallback(() => {
    if (openRound) {
      navigation.navigate('MatchInProgress', { matchId: openRound.matchId });
    }
  }, [openRound, navigation]);

  const verifiable = VERIFIABLE_TYPES.has(exerciseType);

  return (
    <View style={styles.screen}>
      <TopBar
        left={
          <IconCircle
            icon="arrow-left"
            accessibilityLabel="Back"
            onPress={() => navigation.goBack()}
          />
        }
        right={
          <View style={styles.headRight}>
            <Icon name={EXERCISE_ICON[exerciseType]} size={16} color={colors.secondary} />
            <Label size={11}>{EXERCISE_LABEL[exerciseType].toUpperCase()}</Label>
          </View>
        }
      />
      <View style={styles.head}>
        <Label size={11}>COMPETE</Label>
        <Display size={40} style={styles.title}>
          {EXERCISE_LABEL[exerciseType]}
        </Display>
      </View>

      {!verifiable ? (
        <>
          <View style={styles.blocked}>
            <Display size={44}>NOT ON{'\n'}THE CARD YET.</Display>
            <Body muted style={styles.blockedBody}>
              Race needs the watch-verified pace that isn't wired yet. Push-ups, plank and
              wall-sit are on the card now.
            </Body>
          </View>
          <Dock>
            <Button label="BACK" variant="card" onPress={() => navigation.goBack()} />
          </Dock>
        </>
      ) : (
        <>
          <PillTabs
            items={COMPETE_MODES.map(m => ({ key: m, label: MODE_LABEL[m], icon: MODE_ICON[m] }))}
            value={mode}
            onChange={select}
            style={styles.tabs}
          />
          <ScrollView
            ref={pagerRef}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={onMomentumEnd}
            onLayout={onPagerLayout}
            contentOffset={{ x: initialIndex * width, y: 0 }}
            style={styles.pager}
            accessibilityLabel="Modes"
          >
            <View style={{ width, height: pagerHeight || undefined }}>
              <OneVOnePane
                exerciseType={exerciseType}
                navigation={navigation}
                balance={balance}
                openRound={openRound}
                onGoToRound={goToRound}
              />
            </View>
            <View style={{ width, height: pagerHeight || undefined }}>
              <BlitzPane
                exerciseType={exerciseType}
                navigation={navigation}
                balance={balance}
                openRound={openRound}
                onGoToRound={goToRound}
              />
            </View>
            <View style={{ width, height: pagerHeight || undefined }}>
              <StreakPane
                exerciseType={exerciseType}
                navigation={navigation}
                balance={balance}
                openRound={openRound}
                onGoToRound={goToRound}
                fresh={fresh}
              />
            </View>
          </ScrollView>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  headRight: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  head: { paddingHorizontal: space.gutter, paddingTop: space.md },
  title: { marginTop: space.xs },
  tabs: { paddingHorizontal: space.gutter, marginTop: space.lg },
  pager: { flex: 1, marginTop: space.sm },
  blocked: { flex: 1, paddingTop: space.xxl, paddingHorizontal: space.xxl },
  blockedBody: { marginTop: space.lg },
});
