import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../navigation/types';
import { REAL_MONEY_NOTICE } from '../../theme/copy';
import { colors, radius, space } from '../../theme/tokens';
import {
  Body,
  Button,
  Display,
  Dock,
  EmptyRing,
  IconCircle,
  Label,
  Notice,
  TopBar,
} from '../../theme/ui';

type Props = NativeStackScreenProps<RootStackParamList, 'LinkedAccounts'>;

/**
 * Saved payment methods. There is no payment provider and nothing on file
 * while the app runs on points, so this is the empty state and the add
 * action is disabled rather than a list that pretends to save something.
 */
export function LinkedAccountsScreen({ navigation }: Props) {
  const back = () =>
    navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Settings');

  return (
    <View style={styles.screen}>
      <TopBar
        left={<IconCircle icon="arrow-left" accessibilityLabel="Back" onPress={back} />}
      />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View>
          <Label size={11}>PAYMENT METHODS</Label>
          <Display size={40} style={styles.title}>
            LINKED ACCOUNTS.
          </Display>
        </View>

        <Notice icon="clock" iconColor={colors.secondary}>
          {REAL_MONEY_NOTICE}
        </Notice>

        <View style={styles.empty}>
          <EmptyRing />
          <Display size={36} style={styles.emptyHead}>
            NOTHING{'\n'}ON FILE.
          </Display>
          <Body muted style={styles.emptyBody}>
            Saved cards and payout accounts appear here once real-money play
            is switched on.
          </Body>
        </View>
      </ScrollView>
      <Dock>
        <Button label="ADD PAYMENT METHOD" variant="secondary" disabled />
      </Dock>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: {
    paddingTop: space.md,
    paddingHorizontal: space.gutter,
    paddingBottom: space.xxxl,
    gap: space.xl,
  },
  title: { marginTop: space.sm },

  empty: {
    borderRadius: radius.card,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.slot,
    paddingVertical: 28,
    paddingHorizontal: 22,
    alignItems: 'flex-start',
  },
  emptyHead: { marginTop: space.xxl },
  emptyBody: { marginTop: space.md },
});
