import React, { useCallback, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { QrCode } from '../../components/QrCode';
import { relativeDay } from '../../lib/format';
import {
  confirmEnrollment,
  listFactors,
  removeFactor,
  startEnrollment,
  type Enrollment,
  type TotpFactor,
} from '../../lib/mfa';
import type { RootStackParamList } from '../../navigation/types';
import { colors, fonts, radius, space } from '../../theme/tokens';
import {
  Body,
  Button,
  Card,
  Display,
  Dock,
  IconCircle,
  Input,
  Label,
  Notice,
  RowGroup,
  SettingsRow,
  Skeleton,
  TopBar,
} from '../../theme/ui';

type Props = NativeStackScreenProps<RootStackParamList, 'TwoFactor'>;

type Busy = 'start' | 'confirm' | 'cancel' | 'remove' | null;

const CODE_LENGTH = 6;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** "ABCD EFGH IJKL": the setup key in fours, the way authenticator apps print it. */
function groupKey(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, '$1 ');
}

/** "Added Today" reads wrong, so only the day words drop their capital. */
function addedWhen(iso: string): string {
  const day = relativeDay(iso);
  const word = day === 'Today' || day === 'Yesterday' ? day.toLowerCase() : day;
  return word ? `Added ${word}` : 'Added';
}

/**
 * Two-factor authentication (TOTP via Supabase Auth MFA). The screen only
 * ever says 2FA is on when the server lists a verified factor: an
 * unverified leftover from an abandoned enrolment counts as off, and
 * startEnrollment() sweeps it before creating a new one.
 */
export function TwoFactorScreen({ navigation }: Props) {
  const [factors, setFactors] = useState<TotpFactor[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [justEnabled, setJustEnabled] = useState(false);

  const back = () =>
    navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Settings');

  const load = useCallback(async () => {
    try {
      const next = await listFactors();
      setFactors(next);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, []);

  // Runs on mount and every time the screen regains focus.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const start = async () => {
    setError(null);
    setJustEnabled(false);
    setBusy('start');
    try {
      const next = await startEnrollment();
      setCode('');
      setEnrollment(next);
    } catch (e) {
      // Already human: humanizeAuthError covers "TOTP not enabled on this
      // project" and friends.
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const confirm = async () => {
    if (!enrollment || busy) {
      return;
    }
    const clean = code.replace(/\D/g, '');
    if (clean.length !== CODE_LENGTH) {
      setError(`Enter the ${CODE_LENGTH}-digit code from your authenticator.`);
      return;
    }
    setError(null);
    setBusy('confirm');
    try {
      await confirmEnrollment(enrollment.factorId, clean);
      // The server has just verified this factor. Reflect that at once so the
      // screen doesn't flash "Off" while the list refetches, then reconcile.
      const verifiedNow: TotpFactor = {
        id: enrollment.factorId,
        friendlyName: 'Fittr',
        status: 'verified',
        createdAt: new Date().toISOString(),
      };
      setFactors(prev => [
        ...(prev ?? []).filter(f => f.id !== enrollment.factorId),
        verifiedNow,
      ]);
      setEnrollment(null);
      setCode('');
      setJustEnabled(true);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    if (!enrollment || busy) {
      return;
    }
    setError(null);
    setBusy('cancel');
    try {
      await removeFactor(enrollment.factorId);
    } catch {
      // An unverified factor left behind is harmless (it never counts as
      // "on") and the next startEnrollment() removes it.
    }
    setEnrollment(null);
    setCode('');
    setBusy(null);
    await load();
  };

  const remove = async (id: string) => {
    setError(null);
    setJustEnabled(false);
    setBusy('remove');
    try {
      await removeFactor(id);
      setFactors(prev => (prev ? prev.filter(f => f.id !== id) : prev));
      await load();
    } catch (e) {
      // removeFactor() already humanises the AAL2 case: "Verify with your
      // authenticator first, then try again."
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const turnOff = (factor: TotpFactor) => {
    Alert.alert(
      'Turn off two-factor?',
      'Your password alone will get in until you set it up again.',
      [
        { text: 'Keep it on', style: 'cancel' },
        {
          text: 'Turn off',
          style: 'destructive',
          onPress: () => {
            remove(factor.id).catch(() => undefined);
          },
        },
      ],
    );
  };

  const shareKey = () => {
    if (!enrollment) {
      return;
    }
    Share.share({ message: enrollment.secret }).catch(() => undefined);
  };

  const verified = factors?.find(f => f.status === 'verified') ?? null;

  let body: React.ReactNode;
  let dock: React.ReactNode;

  if (enrollment) {
    body = (
      <>
        <Card>
          <Label>SCAN WITH YOUR AUTHENTICATOR</Label>
          <View style={styles.qr}>
            <QrCode value={enrollment.uri} size={200} />
          </View>
          <Label style={styles.keyLabel}>OR ENTER THIS KEY</Label>
          <Text
            selectable
            style={styles.secret}
            accessibilityLabel={`Setup key ${groupKey(enrollment.secret)}`}
          >
            {groupKey(enrollment.secret)}
          </Text>
          <Button
            label="SHARE KEY"
            variant="secondary"
            size="sm"
            icon="share"
            onPress={shareKey}
            style={styles.shareButton}
          />
        </Card>
        <View style={styles.field}>
          <Label>ENTER THE 6-DIGIT CODE</Label>
          <Input
            placeholder="000000"
            keyboardType="number-pad"
            maxLength={CODE_LENGTH}
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            value={code}
            onChangeText={setCode}
            returnKeyType="done"
            onSubmitEditing={confirm}
            editable={busy === null}
            accessibilityLabel="6-digit code"
            style={styles.codeInput}
          />
        </View>
        {error ? <Notice icon="warning">{error}</Notice> : null}
      </>
    );
    dock = (
      <>
        <Button
          label="CONFIRM"
          onPress={confirm}
          loading={busy === 'confirm'}
          disabled={busy !== null && busy !== 'confirm'}
        />
        <Pressable
          onPress={cancel}
          disabled={busy !== null}
          accessibilityRole="button"
          accessibilityLabel="Not now"
          style={styles.link}
        >
          <Text style={[styles.linkText, busy !== null && styles.linkTextDisabled]}>
            {busy === 'cancel' ? 'Cancelling…' : 'Not now'}
          </Text>
        </Pressable>
      </>
    );
  } else if (factors === null) {
    body = loadError ? (
      <Notice icon="warning">{loadError}</Notice>
    ) : (
      <>
        <Skeleton width="100%" height={44} radius={radius.control} />
        <Skeleton width="70%" height={16} />
      </>
    );
    dock = loadError ? (
      <Button label="TRY AGAIN" variant="secondary" onPress={() => load()} />
    ) : null;
  } else if (verified) {
    body = (
      <>
        {justEnabled ? (
          <Notice icon="check" iconColor={colors.accent}>
            Two-factor is on.
          </Notice>
        ) : null}
        {loadError ? <Notice icon="warning">{loadError}</Notice> : null}
        <RowGroup>
          <SettingsRow
            icon="shield"
            title="Authenticator app"
            subtitle={addedWhen(verified.createdAt)}
            value="On"
          />
        </RowGroup>
        <Body muted>
          You'll enter a code from your authenticator after your password when
          signing in.
        </Body>
        {error ? <Notice icon="warning">{error}</Notice> : null}
      </>
    );
    dock = (
      <Button
        label="TURN OFF"
        variant="outline"
        onPress={() => turnOff(verified)}
        loading={busy === 'remove'}
        disabled={busy !== null && busy !== 'remove'}
      />
    );
  } else {
    body = (
      <>
        <Notice icon="shield">
          Off. Add an authenticator app so a stolen password alone can't get in.
        </Notice>
        {loadError ? <Notice icon="warning">{loadError}</Notice> : null}
        <Body muted>
          Works with Google Authenticator, 1Password, Authy or any app that
          makes one-time codes.
        </Body>
        {error ? <Notice icon="warning">{error}</Notice> : null}
      </>
    );
    dock = (
      <Button
        label="SET UP AUTHENTICATOR"
        onPress={start}
        loading={busy === 'start'}
        disabled={busy !== null && busy !== 'start'}
      />
    );
  }

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
          <Label size={11}>ACCOUNT & SECURITY</Label>
          <Display size={40} style={styles.title}>
            TWO-FACTOR.
          </Display>
        </View>
        {body}
      </ScrollView>
      {dock ? <Dock style={styles.dock}>{dock}</Dock> : null}
    </KeyboardAvoidingView>
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
  qr: { alignItems: 'center', marginTop: space.lg },
  keyLabel: { marginTop: space.xl },
  secret: {
    fontFamily: fonts.medium,
    fontSize: 15,
    lineHeight: 22,
    letterSpacing: 1,
    color: colors.text,
    marginTop: space.sm,
  },
  shareButton: { alignSelf: 'flex-start', marginTop: space.md },
  field: { gap: space.sm + 2 },
  codeInput: { textAlign: 'center', fontSize: 20, letterSpacing: 6 },
  dock: { gap: space.sm + 2 },
  link: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  linkText: {
    fontFamily: fonts.medium,
    fontSize: 13,
    lineHeight: 19,
    color: colors.secondary,
  },
  linkTextDisabled: { color: colors.dim },
});
