import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFitnessProfile } from '../../hooks/useFitnessProfile';
import { fmtPoints } from '../../lib/format';
import type { RootStackParamList } from '../../navigation/types';
import {
  CASHOUT_METHODS,
  REAL_MONEY_NOTICE,
  UNIT,
  type CashoutMethodDef,
} from '../../theme/copy';
import { Icon } from '../../theme/icons';
import { colors, fonts, space, typography } from '../../theme/tokens';
import {
  Button,
  Card,
  Display,
  Dock,
  ErrorText,
  IconCircle,
  Input,
  Label,
  Notice,
  Numeral,
  RowGroup,
  SectionHead,
  SettingsRow,
  TopBar,
} from '../../theme/ui';

type Props = NativeStackScreenProps<RootStackParamList, 'Cashout'>;

/** Withdrawal floor, in whole dollars. Client-side hint only. */
const MIN_USD = 5;

/**
 * What can be withdrawn right now. Points have no cash value, so this is
 * zero until real-money play is switched on server-side; at that point the
 * figure comes from the server, never from here.
 */
const WITHDRAWABLE_USD = 0;

/**
 * Cash out, built to the design while the app runs on points. The balance
 * shown is the live points purse; the amount and destination are local
 * picks so the flow reads as finished. Nothing is submitted: the primary
 * action stays disabled and says so.
 */
export function CashoutScreen({ navigation }: Props) {
  const { profile, error } = useFitnessProfile();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<CashoutMethodDef['key'] | null>(null);

  const back = () =>
    navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Settings');

  const problem = amountProblem(amount);

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="padding">
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
            CASH OUT.
          </Display>
        </View>

        <Notice icon="clock" iconColor={colors.secondary}>
          {REAL_MONEY_NOTICE}
        </Notice>

        <Card pad={space.lg}>
          <Label size={11}>AVAILABLE</Label>
          <View style={styles.balanceRow}>
            <Numeral size={44} color={colors.accent}>
              {profile ? fmtPoints(profile.points_balance) : '—'}
            </Numeral>
            <Label size={11} color={colors.secondary} tracking={0.2}>
              {UNIT}
            </Label>
          </View>
          <Text style={styles.balanceNote}>
            Points have no cash value during the pilot.
          </Text>
        </Card>

        {error ? <Notice icon="warning">{error}</Notice> : null}

        <View>
          <SectionHead>AMOUNT</SectionHead>
          <View style={styles.amountWrap}>
            <View style={styles.amountPrefix} pointerEvents="none">
              <Text style={styles.amountPrefixText}>$</Text>
            </View>
            <Input
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              inputMode="decimal"
              placeholder="0.00"
              accessibilityLabel="Amount to withdraw in dollars"
              style={styles.amountInput}
            />
          </View>
          {problem ? (
            <ErrorText style={styles.problem}>{problem}</ErrorText>
          ) : (
            <Text style={styles.helper}>
              {WITHDRAWABLE_USD > 0
                ? `Between $${MIN_USD} and $${WITHDRAWABLE_USD}. Whole dollars or cents.`
                : 'Nothing withdrawable yet.'}
            </Text>
          )}
        </View>

        <View>
          <SectionHead>SEND TO</SectionHead>
          <RowGroup>
            {CASHOUT_METHODS.map(m => {
              const on = method === m.key;
              return (
                <SettingsRow
                  key={m.key}
                  icon={m.key === 'debit' ? 'card' : 'wallet'}
                  title={m.label}
                  subtitle={m.time}
                  onPress={() => setMethod(m.key)}
                  right={
                    <View style={styles.checkSlot}>
                      {on ? <Icon name="check" size={16} color={colors.accent} /> : null}
                    </View>
                  }
                />
              );
            })}
          </RowGroup>
        </View>
      </ScrollView>
      <Dock>
        <Button label="NOT AVAILABLE YET" disabled />
      </Dock>
    </KeyboardAvoidingView>
  );
}

/**
 * Format and range check for a typed amount. Null while the field is empty
 * or the amount is fine. A comma decimal separator is accepted: some
 * decimal pads produce one. With nothing withdrawable, any amount is over
 * the ceiling, and that is what the helper says.
 */
function amountProblem(raw: string): string | null {
  const text = raw.trim().replace(',', '.');
  if (!text) {
    return null;
  }
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    return 'Enter whole dollars or dollars and cents, like 20 or 12.50.';
  }
  const usd = Number(text);
  if (usd > WITHDRAWABLE_USD) {
    return WITHDRAWABLE_USD > 0
      ? `Maximum is $${WITHDRAWABLE_USD}.`
      : 'Nothing withdrawable yet.';
  }
  if (usd < MIN_USD) {
    return `Minimum is $${MIN_USD}.`;
  }
  return null;
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

  balanceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.sm,
    marginTop: space.sm,
  },
  balanceNote: { ...typography.footnote, marginTop: space.sm },

  amountWrap: { justifyContent: 'center' },
  amountPrefix: {
    position: 'absolute',
    left: space.cardPad,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    zIndex: 1,
  },
  amountPrefixText: {
    fontFamily: fonts.medium,
    fontSize: 16,
    color: colors.secondary,
    includeFontPadding: false,
  },
  amountInput: { paddingLeft: space.cardPad + space.lg },
  helper: { ...typography.helper, marginTop: space.sm, paddingHorizontal: space.xs },
  problem: { marginTop: space.sm, paddingHorizontal: space.xs },

  checkSlot: { width: 16, alignItems: 'center' },
});
