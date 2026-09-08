import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { RootStackParamList } from '../navigation/types';
import { Icon, type IconName } from '../theme/icons';
import { colors, label, space } from '../theme/tokens';

export type Tab = 'home' | 'find' | 'profile';

const TABS: ReadonlyArray<{
  key: Tab;
  label: string;
  icon: IconName;
  route: keyof RootStackParamList;
}> = [
  { key: 'home', label: 'BOUTS', icon: 'bolt', route: 'Home' },
  { key: 'find', label: 'FIND', icon: 'crosshair', route: 'FindBout' },
  { key: 'profile', label: 'PROFILE', icon: 'user', route: 'Profile' },
];

/**
 * Bouts / Find / Profile. Rendered by the three top-level screens rather
 * than by a tab navigator: the app is one native stack, and `navigate` to a
 * route already on it pops back rather than pushing, so the stack never
 * grows past those three.
 */
export function TabBar({ active }: { active: Tab }) {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const insets = useSafeAreaInsets();
  const pad = { paddingBottom: Math.max(insets.bottom, space.md) + space.xs };

  return (
    <View style={[styles.bar, pad]}>
      {TABS.map(tab => {
        const selected = tab.key === active;
        const color = selected ? colors.accent : colors.dim;
        const text = { ...label(10, color), marginTop: 5 };
        return (
          <Pressable
            key={tab.key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => {
              if (!selected) {
                navigation.navigate(tab.route as 'Home');
              }
            }}
            style={styles.tab}
          >
            <Icon name={tab.icon} size={22} color={color} />
            <Text style={text}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingTop: space.sm + 2,
    paddingHorizontal: space.sm,
    borderTopWidth: 1,
    borderTopColor: colors.tabLine,
    backgroundColor: colors.bg,
  },
  tab: {
    width: 96,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
