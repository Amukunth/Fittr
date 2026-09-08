import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../context/AuthContext';
import { useFitnessProfile } from '../../hooks/useFitnessProfile';
import { useBoutHistory } from '../../hooks/useBoutHistory';
import { useUserSettings } from '../../hooks/useUserSettings';
import { fmtPoints } from '../../lib/format';
import { ownHandle } from '../../lib/identity';
import { twoFactorEnabled } from '../../lib/mfa';
import { profileHandle } from '../../lib/profile';
import {
  biometryLabel,
  disableBiometricLock,
  enableBiometricLock,
  isBiometricLockEnabled,
  supportedBiometry,
  type BiometryKind,
} from '../../lib/secureStore';
import type { RootStackParamList } from '../../navigation/types';
import type { PointsLedgerEntryRow } from '../../types/database';
import { NOTIFICATION_PREFS, REAL_MONEY_NOTICE, UNIT } from '../../theme/copy';
import { colors, fonts, sizes, space, typography } from '../../theme/tokens';
import {
  Button,
  Card,
  Display,
  IconCircle,
  Label,
  Loading,
  Notice,
  Numeral,
  RowGroup,
  SectionHead,
  SettingsRow,
  Small,
  Toggle,
  TopBar,
} from '../../theme/ui';
import { ProfileEditor } from './ProfileEditor';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

const { version: APP_VERSION } = require('../../../package.json') as { version: string };

const DELETE_COPY =
  'Your profile, photo and settings are erased and this account can never sign in again. ' +
  "Finished bouts stay on your opponents' records without your name. This cannot be undone.";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function SettingsScreen({ navigation }: Props) {
  const { session, signOut } = useAuth();
  const { profile, error: profileError, refresh: refreshProfile } = useFitnessProfile();
  const { stats } = useBoutHistory();
  const {
    notifications,
    loading: settingsLoading,
    error: settingsError,
    setNotification,
  } = useUserSettings();
  const userId = session?.user.id ?? null;
  const email = session?.user.email ?? '';

  const back = () =>
    navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Profile');

  // ── Account & security ────────────────────────────────────────────────
  const [twoFactor, setTwoFactor] = useState<boolean | null>(null);
  const [biometry, setBiometry] = useState<BiometryKind | null>(null);
  const [biometricOn, setBiometricOn] = useState(false);
  const [biometricBusy, setBiometricBusy] = useState(false);
  const [securityError, setSecurityError] = useState<string | null>(null);

  // Both are changed on sub-screens (TwoFactor) or by the OS, so re-read on
  // every focus rather than once.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      twoFactorEnabled()
        .then(on => {
          if (active) {
            setTwoFactor(on);
          }
        })
        .catch(() => {
          if (active) {
            setTwoFactor(null);
          }
        });
      Promise.all([supportedBiometry(), isBiometricLockEnabled()])
        .then(([kind, on]) => {
          if (active) {
            setBiometry(kind);
            setBiometricOn(kind !== 'none' && on);
          }
        })
        .catch(() => {
          if (active) {
            setBiometry('none');
            setBiometricOn(false);
          }
        });
      return () => {
        active = false;
      };
    }, []),
  );

  const biometricsAvailable = biometry !== null && biometry !== 'none';
  const biometricName = biometryLabel(biometry ?? 'none');

  const toggleBiometric = async (next: boolean) => {
    setSecurityError(null);
    setBiometricBusy(true);
    try {
      if (next) {
        const ok = await enableBiometricLock();
        setBiometricOn(ok);
        if (!ok) {
          setSecurityError(`Couldn't turn on ${biometricName}.`);
        }
      } else {
        await disableBiometricLock();
        setBiometricOn(false);
      }
    } catch (e) {
      setBiometricOn(false);
      setSecurityError(next ? `Couldn't turn on ${biometricName}.` : errorMessage(e));
    } finally {
      setBiometricBusy(false);
    }
  };

  const linkedProviders = (session?.user.identities ?? []).filter(
    i => i.provider !== 'email',
  ).length;

  // ── Purse ─────────────────────────────────────────────────────────────
  const [bonus, setBonus] = useState<number | null>(null);
  const [purseError, setPurseError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!userId) {
        return undefined;
      }
      let active = true;
      (async () => {
        const { data, error: queryError } = await supabase
          .from('points_ledger_entries')
          .select('amount')
          .eq('user_id', userId)
          .eq('reason', 'bonus');
        if (!active) {
          return;
        }
        if (queryError) {
          setPurseError(queryError.message);
          return;
        }
        setPurseError(null);
        const rows = (data ?? []) as Array<Pick<PointsLedgerEntryRow, 'amount'>>;
        setBonus(rows.reduce((sum, row) => sum + row.amount, 0));
      })();
      return () => {
        active = false;
      };
    }, [userId]),
  );

  // ── Log out / delete ──────────────────────────────────────────────────
  const [signingOut, setSigningOut] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);

  const logOut = async () => {
    setAccountError(null);
    setSigningOut(true);
    try {
      await signOut();
    } catch (e) {
      setSigningOut(false);
      setAccountError(errorMessage(e));
    }
  };

  const deleteAccount = async () => {
    setAccountError(null);
    setDeleting(true);
    try {
      const { error: rpcError } = await supabase.rpc('delete_my_account');
      if (rpcError) {
        setDeleting(false);
        setAccountError(
          rpcError.message.includes('live_bouts')
            ? 'Finish or settle your live bouts first.'
            : rpcError.message,
        );
        return;
      }
      await signOut();
    } catch (e) {
      setDeleting(false);
      setAccountError(errorMessage(e));
    }
  };

  const confirmDelete = () => {
    Alert.alert('Delete your account?', DELETE_COPY, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          deleteAccount();
        },
      },
    ]);
  };

  if (!profile) {
    return <Loading />;
  }

  const fallbackHandle = ownHandle(session);
  const handle = profileHandle(profile, fallbackHandle);
  const busy = signingOut || deleting;

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
          <Label size={11} style={styles.handle}>
            {handle}
          </Label>
          <Display size={44} style={styles.title}>
            SETTINGS
          </Display>
        </View>

        {profileError ? <Notice icon="warning">{profileError}</Notice> : null}

        <View>
          <SectionHead>PROFILE</SectionHead>
          <ProfileEditor
            profile={profile}
            fallbackHandle={fallbackHandle}
            wins={stats?.wins ?? null}
            onChanged={refreshProfile}
          />
        </View>

        <View>
          <SectionHead>ACCOUNT & SECURITY</SectionHead>
          <RowGroup>
            <SettingsRow
              icon="key"
              title="Change password"
              subtitle={email || undefined}
              onPress={() => navigation.navigate('ChangePassword')}
            />
            <SettingsRow
              icon="shield"
              title="Two-factor authentication"
              value={twoFactor === null ? undefined : twoFactor ? 'On' : 'Off'}
              onPress={() => navigation.navigate('TwoFactor')}
            />
            <SettingsRow
              icon="scan"
              title="Biometric login"
              subtitle={
                biometry === null
                  ? 'Checking this device…'
                  : biometricsAvailable
                    ? `Unlock Fittr with ${biometricName}`
                    : 'Not available on this device'
              }
              disabled={biometry !== null && !biometricsAvailable}
              right={
                <Toggle
                  value={biometricOn}
                  onValueChange={toggleBiometric}
                  disabled={!biometricsAvailable || biometricBusy}
                  accessibilityLabel="Biometric login"
                />
              }
            />
            <SettingsRow
              icon="link"
              title="Connected accounts"
              value={linkedProviders > 0 ? String(linkedProviders) : 'None'}
              onPress={() => navigation.navigate('ConnectedAccounts')}
            />
            <SettingsRow
              icon="devices"
              title="Active sessions"
              subtitle="Devices signed in to this account"
              onPress={() => navigation.navigate('Sessions')}
            />
          </RowGroup>
          {securityError ? (
            <Notice icon="warning" style={styles.afterGroup}>
              {securityError}
            </Notice>
          ) : null}
        </View>

        <View>
          <SectionHead>PAYMENT METHODS</SectionHead>
          <Card style={styles.purse}>
            <View style={styles.purseTop}>
              <View style={styles.purseFigures}>
                <View>
                  <Label>BALANCE</Label>
                  <View style={styles.figure}>
                    <Numeral size={44} color={colors.accent}>
                      {fmtPoints(profile.points_balance)}
                    </Numeral>
                    <Label size={11} color={colors.secondary} tracking={0.2}>
                      {UNIT}
                    </Label>
                  </View>
                </View>
                <View>
                  <Label>BONUS CREDIT</Label>
                  <View style={styles.figure}>
                    <Numeral size={22} color={colors.secondary}>
                      {bonus === null ? '—' : fmtPoints(bonus)}
                    </Numeral>
                    <Label size={11} color={colors.secondary} tracking={0.2}>
                      {UNIT}
                    </Label>
                  </View>
                </View>
              </View>
              <View style={styles.purseActions}>
                <Button
                  label="ADD"
                  variant="secondary"
                  size="sm"
                  style={styles.purseButton}
                  onPress={() => navigation.navigate('Deposit')}
                />
                <Button
                  label="CASH OUT"
                  variant="outline"
                  size="sm"
                  style={styles.purseButton}
                  onPress={() => navigation.navigate('Cashout')}
                />
              </View>
            </View>
            {purseError ? (
              <Notice icon="warning" style={styles.purseError}>
                {purseError}
              </Notice>
            ) : null}
            <Small style={styles.purseNote}>{REAL_MONEY_NOTICE}</Small>
          </Card>
          <RowGroup style={styles.afterGroup}>
            <SettingsRow
              icon="plus-circle"
              title="Deposit"
              subtitle="Add funds"
              onPress={() => navigation.navigate('Deposit')}
            />
            <SettingsRow
              icon="wallet"
              title="Cashout"
              subtitle="Withdraw to Venmo, PayPal, debit or bank"
              onPress={() => navigation.navigate('Cashout')}
            />
            <SettingsRow
              icon="card"
              title="Linked accounts"
              subtitle="Saved payment methods"
              onPress={() => navigation.navigate('LinkedAccounts')}
            />
            <SettingsRow
              icon="list"
              title="Transaction history"
              subtitle="Every bonus, wager and win"
              onPress={() => navigation.navigate('Transactions')}
            />
          </RowGroup>
        </View>

        <View>
          <SectionHead>NOTIFICATIONS</SectionHead>
          <RowGroup>
            {NOTIFICATION_PREFS.map(pref => (
              <SettingsRow
                key={pref.key}
                title={pref.label}
                subtitle={pref.desc}
                right={
                  <Toggle
                    value={notifications[pref.key]}
                    onValueChange={next => setNotification(pref.key, next)}
                    disabled={settingsLoading}
                    accessibilityLabel={pref.label}
                  />
                }
              />
            ))}
          </RowGroup>
          {settingsError ? (
            <Notice icon="warning" style={styles.afterGroup}>
              {settingsError}
            </Notice>
          ) : null}
          <Text style={styles.footnote}>
            Saved to your account. Push delivery arrives with the next release.
          </Text>
        </View>

        <View style={styles.footer}>
          {accountError ? <Notice icon="warning">{accountError}</Notice> : null}
          <Button
            label="LOG OUT"
            variant="secondary"
            size="md"
            onPress={logOut}
            loading={signingOut}
            disabled={deleting}
          />
          <Pressable
            onPress={confirmDelete}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Delete account"
            accessibilityState={{ disabled: busy, busy: deleting }}
            style={({ pressed }) => [styles.deleteButton, pressed && styles.pressed]}
          >
            {deleting ? (
              <ActivityIndicator color={colors.dim} />
            ) : (
              <Text style={styles.deleteText}>Delete account</Text>
            )}
          </Pressable>
          <Label size={10} color={colors.slot} style={styles.version}>
            {`FITTR ${APP_VERSION}`}
          </Label>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: {
    paddingTop: space.md,
    paddingHorizontal: space.gutter,
    paddingBottom: space.xxxl,
    gap: 22,
  },
  handle: { textTransform: 'none' },
  title: { marginTop: space.sm },
  afterGroup: { marginTop: space.sm + 2 },

  purse: { paddingVertical: space.cardPad, paddingHorizontal: space.lg },
  purseTop: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  purseFigures: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: space.xl,
    rowGap: space.md,
  },
  figure: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 5,
    marginTop: space.sm,
  },
  purseActions: { gap: space.sm, alignItems: 'stretch' },
  purseButton: { height: 38 },
  purseError: { marginTop: space.md },
  purseNote: {
    marginTop: space.md + 2,
    paddingTop: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },

  footnote: {
    ...typography.footnote,
    marginTop: space.sm + 2,
    paddingHorizontal: space.xs,
  },

  footer: { gap: 10 },
  deleteButton: {
    minHeight: sizes.circle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.7 },
  deleteText: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    lineHeight: 16,
    color: colors.dim,
  },
  version: { textAlign: 'center', paddingBottom: space.sm },
});
