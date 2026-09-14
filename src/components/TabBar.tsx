import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTrophyBadge } from '../hooks/useTrophyBadge';
import { compactPoints } from '../lib/format';
import type { RootStackParamList } from '../navigation/types';
import { Icon, type IconName } from '../theme/icons';
import { colors, fonts, label, radius, space } from '../theme/tokens';

export type Tab = 'home' | 'find' | 'rank' | 'profile';

const TABS: ReadonlyArray<{
  key: Tab;
  label: string;
  icon: IconName;
  route: keyof RootStackParamList;
}> = [
  { key: 'home', label: 'BOUTS', icon: 'bolt', route: 'Home' },
  { key: 'find', label: 'FIND', icon: 'crosshair', route: 'FindBout' },
  { key: 'rank', label: 'RANK', icon: 'trophy', route: 'Rank' },
  { key: 'profile', label: 'PROFILE', icon: 'user', route: 'Profile' },
];

/**
 * Bouts / Find / Rank / Profile. Rendered by the four top-level screens
 * rather than by a tab navigator: the app is one native stack, and
 * `navigate` to a route already on it pops back rather than pushing, so the
 * stack never grows past those four.
 */
export function TabBar({ active }: { active: Tab }) {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const insets = useSafeAreaInsets();
  const badge = useTrophyBadge();
  const pad = { paddingBottom: Math.max(insets.bottom, space.md) + space.xs };

  return (
    <View style={[styles.bar, pad]}>
      {TABS.map(tab => {
        const selected = tab.key === active;
        const color = selected ? colors.accent : colors.dim;
        const text = { ...label(10, color), marginTop: 5 };
        const count =
          tab.key === 'rank' && badge !== null && badge !== 'dot' ? badge : null;
        return (
          <Pressable
            key={tab.key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={
              count !== null
                ? `${tab.label.toLowerCase()}, ${count} trophies`
                : badge === 'dot' && tab.key === 'rank'
                  ? 'rank, new league reached'
                  : tab.label.toLowerCase()
            }
            onPress={() => {
              if (!selected) {
                navigation.navigate(tab.route as 'Home');
              }
            }}
            style={styles.tab}
          >
            <View>
              <Icon name={tab.icon} size={22} color={color} />
              {tab.key === 'rank' && badge !== null ? (
                <Badge content={badge} />
              ) : null}
            </View>
            <Text style={text}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The trophy count, or a bare dot when the league has moved since the
 * fighter last opened Rank. The dot wins because "you ranked up" is the
 * thing worth crossing the screen for, and a number that has ticked from
 * 296 to 312 does not read as that on a 22px icon.
 */
function Badge({ content }: { content: number | 'dot' }) {
  if (content === 'dot') {
    return <View style={styles.dot} />;
  }
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText} numberOfLines={1}>
        {compactPoints(content)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    paddingTop: space.sm + 2,
    paddingHorizontal: space.sm,
    borderTopWidth: 1,
    borderTopColor: colors.tabLine,
    backgroundColor: colors.bg,
  },
  // Four tabs share the width evenly. Each is well over the 44px minimum.
  tab: {
    flex: 1,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: -6,
    left: 12,
    minWidth: 18,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    fontFamily: fonts.bold,
    fontSize: 9,
    letterSpacing: 0.2,
    color: colors.onAccent,
    includeFontPadding: false,
  },
  dot: {
    position: 'absolute',
    top: -3,
    right: -3,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
});
