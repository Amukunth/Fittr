import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../navigation/types';
import {
  DEPOSIT_METHODS,
  DEPOSIT_PRESETS_USD,
  REAL_MONEY_NOTICE,
  type DepositMethodDef,
} from '../../theme/copy';
import { Icon } from '../../theme/icons';
import { colors, fonts, radius, space, typography } from '../../theme/tokens';
import {
  Button,
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

type Props = NativeStackScreenProps<RootStackParamList, 'Deposit'>;

/** Deposit bounds, in whole dollars. Client-side hints only. */
const MIN_USD = 5;
const MAX_USD = 500;

type AmountPick = number | 'custom' | null;

/**
 * Add funds, built to the design while the app runs on points. Amount and
 * method are picked locally so the flow reads as finished, but nothing is
 * sent anywhere: real-money play is a server-side switch that is off, so
 * the primary action stays disabled and says so.
 */
export function DepositScreen({ navigation }: Props) {
  const [pick, setPick] = useState<AmountPick>(null);
  const [custom, setCustom] = useState('');
  const [method, setMethod] = useState<DepositMethodDef['key'] | null>(null);

  const back = () =>
    navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Settings');

  const problem = pick === 'custom' ? amountProblem(custom) : null;

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
            ADD FUNDS.
          </Display>
        </View>

        <Notice icon="clock" iconColor={colors.secondary}>
          {REAL_MONEY_NOTICE}
        </Notice>

        <View>
          <SectionHead>AMOUNT</SectionHead>
          <View style={styles.tiles}>
            {DEPOSIT_PRESETS_USD.map(usd => {
              const on = pick === usd;
              return (
                <Pressable
                  key={usd}
                  onPress={() => setPick(usd)}
                  accessibilityRole="button"
                  accessibilityLabel={`$${usd}`}
                  accessibilityState={{ selected: on }}
                  style={({ pressed }) => [
                    styles.tile,
                    on ? styles.tileOn : pressed && styles.tilePressed,
                  ]}
                >
                  <Numeral size={22} color={on ? colors.onAccent : colors.text}>
                    {`$${usd}`}
                  </Numeral>
                </Pressable>
              );
            })}
            <Pressable
              onPress={() => setPick('custom')}
              accessibilityRole="button"
              accessibilityLabel="Custom amount"
              accessibilityState={{ selected: pick === 'custom' }}
              style={({ pressed }) => [
                styles.tile,
                pick === 'custom' ? styles.tileOn : pressed && styles.tilePressed,
              ]}
            >
              <Display
                size={15}
                tracking={0.04}
                color={pick === 'custom' ? colors.onAccent : colors.text}
              >
                CUSTOM
              </Display>
            </Pressable>
          </View>
          {pick === 'custom' ? (
            <View style={styles.customBlock}>
              <View style={styles.amountWrap}>
                <View style={styles.amountPrefix} pointerEvents="none">
                  <Text style={styles.amountPrefixText}>$</Text>
                </View>
                <Input
                  value={custom}
                  onChangeText={setCustom}
                  keyboardType="decimal-pad"
                  inputMode="decimal"
                  placeholder="0.00"
                  autoFocus
                  accessibilityLabel="Custom amount in dollars"
                  style={styles.amountInput}
                />
              </View>
              {problem ? (
                <ErrorText style={styles.problem}>{problem}</ErrorText>
              ) : (
                <Text style={styles.helper}>
                  {`Between $${MIN_USD} and $${MAX_USD}. Whole dollars or cents.`}
                </Text>
              )}
            </View>
          ) : null}
        </View>

        <View>
          <SectionHead>PAY WITH</SectionHead>
          <RowGroup>
            {DEPOSIT_METHODS.map(m => {
              const on = method === m.key;
              return (
                <SettingsRow
                  key={m.key}
                  icon={m.key === 'card' ? 'card' : 'wallet'}
                  title={m.label}
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

        <Text style={styles.footnote}>
          Deposits are held in your Fittr wallet and can be withdrawn at any
          time, minus anything locked in a live bout.
        </Text>
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
 * decimal pads produce one.
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
  if (usd < MIN_USD) {
    return `Minimum is $${MIN_USD}.`;
  }
  if (usd > MAX_USD) {
    return `Maximum is $${MAX_USD}.`;
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

  tiles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  tile: {
    flexGrow: 1,
    flexBasis: '30%',
    height: 60,
    borderRadius: radius.control,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileOn: { backgroundColor: colors.accent },
  tilePressed: { backgroundColor: colors.cardPressed },

  customBlock: { marginTop: space.md },
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

  footnote: { ...typography.footnote, paddingHorizontal: space.xs },
});
