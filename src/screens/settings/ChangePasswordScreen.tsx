import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '@env';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../context/AuthContext';
import type { RootStackParamList } from '../../navigation/types';
import { colors, space, typography } from '../../theme/tokens';
import {
  Body,
  Button,
  Display,
  Dock,
  IconCircle,
  Input,
  Label,
  Notice,
  TopBar,
} from '../../theme/ui';

type Props = NativeStackScreenProps<RootStackParamList, 'ChangePassword'>;

const MIN_LENGTH = 8;

type Field = 'current' | 'next' | 'confirm';

interface Problem {
  field: Field;
  text: string;
}

/**
 * The first thing wrong with the form, or null. While typing (`strict`
 * off) empty fields are left alone so the form doesn't shout before the
 * user has started; on submit every rule applies.
 */
function firstProblem(
  current: string,
  next: string,
  confirm: string,
  strict: boolean,
): Problem | null {
  if (strict && !current) {
    return { field: 'current', text: 'Enter your current password.' };
  }
  if ((strict || next) && next.length < MIN_LENGTH) {
    return { field: 'next', text: `At least ${MIN_LENGTH} characters.` };
  }
  if (next && current && next === current) {
    return { field: 'next', text: "That's your current password. Pick a new one." };
  }
  if ((strict || confirm) && confirm !== next) {
    return { field: 'confirm', text: "Doesn't match the new password." };
  }
  return null;
}

function humanizeUpdateError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('reauthentication') || m.includes('nonce')) {
    return "Supabase's secure password change needs an emailed code; turn off 'Secure password change' in Auth settings or contact support.";
  }
  return message;
}

function isWrongPassword(message: string, status: number | undefined): boolean {
  return status === 400 || message.toLowerCase().includes('invalid login credentials');
}

let verifier: SupabaseClient | null = null;

/**
 * A second, non-persisting client used only to prove the current password.
 * Signing in on the app's own client would replace its session: for an
 * account with two-factor on, the fresh session is AAL1, AuthContext flips
 * mfaRequired, and RootNavigator swaps the whole signed-in stack for the
 * code step before updateUser() runs. This client keeps its session in
 * memory, never emits on the app client, and its own storage key means
 * auth-js doesn't treat it as a duplicate.
 */
function passwordVerifier(): SupabaseClient {
  if (!verifier) {
    verifier = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storageKey: 'fittr-password-check',
      },
    });
  }
  return verifier;
}

export function ChangePasswordScreen({ navigation }: Props) {
  const { session } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [strict, setStrict] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const back = () =>
    navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Settings');

  const problem = firstProblem(current, next, confirm, strict);

  const submit = async () => {
    if (submitting) {
      return;
    }
    setError(null);
    setStrict(true);
    if (firstProblem(current, next, confirm, true)) {
      return;
    }
    const email = session?.user.email;
    if (!email) {
      setError(
        "This account has no email address, so the current password can't be checked here.",
      );
      return;
    }

    setSubmitting(true);
    const check = passwordVerifier();
    const { error: checkError } = await check.auth.signInWithPassword({
      email,
      password: current,
    });
    if (checkError) {
      setSubmitting(false);
      setError(
        isWrongPassword(checkError.message, checkError.status)
          ? 'Current password is wrong.'
          : checkError.message,
      );
      return;
    }
    // The proof is done; revoke that throwaway session server-side so it
    // doesn't linger. Local scope touches only the verifier's own session.
    await check.auth.signOut({ scope: 'local' }).catch(() => undefined);

    const { error: updateError } = await supabase.auth.updateUser({ password: next });
    setSubmitting(false);
    if (updateError) {
      setError(humanizeUpdateError(updateError.message));
      return;
    }
    setDone(true);
  };

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
            {done ? 'LOCKED IN.' : 'NEW PASSWORD.'}
          </Display>
        </View>

        {done ? (
          <Body muted>
            Your password has changed. Other devices will need it next time they
            sign in.
          </Body>
        ) : (
          <View style={styles.form}>
            <View style={styles.field}>
              <Input
                placeholder="Current password"
                secureTextEntry
                textContentType="password"
                autoComplete="current-password"
                autoCapitalize="none"
                autoCorrect={false}
                value={current}
                onChangeText={setCurrent}
                returnKeyType="next"
                submitBehavior="submit"
                editable={!submitting}
                accessibilityLabel="Current password"
              />
              {problem?.field === 'current' ? <Helper text={problem.text} error /> : null}
            </View>
            <View style={styles.field}>
              <Input
                placeholder="New password"
                secureTextEntry
                textContentType="newPassword"
                autoComplete="new-password"
                autoCapitalize="none"
                autoCorrect={false}
                value={next}
                onChangeText={setNext}
                returnKeyType="next"
                submitBehavior="submit"
                editable={!submitting}
                accessibilityLabel="New password"
              />
              {problem?.field === 'next' ? (
                <Helper text={problem.text} error />
              ) : (
                <Helper text={`At least ${MIN_LENGTH} characters.`} />
              )}
            </View>
            <View style={styles.field}>
              <Input
                placeholder="Confirm new password"
                secureTextEntry
                textContentType="newPassword"
                autoComplete="new-password"
                autoCapitalize="none"
                autoCorrect={false}
                value={confirm}
                onChangeText={setConfirm}
                returnKeyType="go"
                onSubmitEditing={submit}
                editable={!submitting}
                accessibilityLabel="Confirm new password"
              />
              {problem?.field === 'confirm' ? <Helper text={problem.text} error /> : null}
            </View>
            {error ? <Notice icon="warning">{error}</Notice> : null}
          </View>
        )}
      </ScrollView>
      <Dock>
        {done ? (
          <Button label="BACK TO SETTINGS" onPress={back} />
        ) : (
          <Button label="UPDATE PASSWORD" onPress={submit} loading={submitting} />
        )}
      </Dock>
    </KeyboardAvoidingView>
  );
}

/** Helper line under a field. Lime when it's telling the user what's wrong. */
function Helper({ text, error }: { text: string; error?: boolean }) {
  return (
    <Text
      style={[styles.helper, error && styles.helperError]}
      accessibilityRole={error ? 'alert' : undefined}
    >
      {text}
    </Text>
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
  form: { gap: space.md },
  field: { gap: space.sm },
  helper: { ...typography.helper, paddingHorizontal: space.xs },
  helperError: { color: colors.accent },
});
