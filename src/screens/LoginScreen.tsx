import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
} from 'react-native';
import { useAuth } from '../context/AuthContext';
import { colors, space, typography } from '../theme/tokens';
import {
  Body,
  ErrorText,
  Headline,
  Input,
  Kicker,
  Label,
  Muted,
  PrimaryButton,
  Wordmark,
} from '../theme/ui';

export function LoginScreen() {
  const { signInWithPassword, signUpWithPassword } = useAuth();
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setInfo(null);
    if (!email.trim() || !password) {
      setError('Enter an email and password.');
      return;
    }

    setSubmitting(true);
    const result =
      mode === 'sign-in'
        ? await signInWithPassword(email.trim(), password)
        : await signUpWithPassword(email.trim(), password);
    setSubmitting(false);

    if (result.error) {
      setError(result.error);
    } else if (mode === 'sign-up') {
      setInfo('Account created. Confirm it from your email, then log in.');
    }
  };

  const signingIn = mode === 'sign-in';

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Wordmark size={56} />
      <Kicker style={styles.kicker}>Verified, not guessed.</Kicker>

      <Headline>{signingIn ? 'Back in the ring' : 'Weigh in'}</Headline>
      <Muted style={styles.lede}>
        {signingIn
          ? 'Log in. Somebody on the card is waiting on you.'
          : 'Make your account, then call somebody out.'}
      </Muted>

      <Label style={styles.fieldLabel}>Email</Label>
      <Input
        placeholder="you@example.com"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <Label style={styles.fieldLabel}>Password</Label>
      <Input
        placeholder="••••••••"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />

      {error ? <ErrorText style={styles.message}>{error}</ErrorText> : null}
      {info ? <Body style={styles.message}>{info}</Body> : null}

      <PrimaryButton
        style={styles.cta}
        label={signingIn ? 'Log in' : 'Create account'}
        onPress={submit}
        loading={submitting}
      />

      <TouchableOpacity
        onPress={() => {
          setError(null);
          setInfo(null);
          setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in');
        }}
      >
        <Text style={styles.switchModeText}>
          {signingIn ? 'First time here? Weigh in' : 'Already weighed in? Log in'}
        </Text>
      </TouchableOpacity>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    backgroundColor: colors.bg,
  },
  kicker: { marginTop: space.md, marginBottom: space.xl },
  lede: { marginTop: space.sm, marginBottom: space.lg },
  fieldLabel: { marginTop: space.md, marginBottom: space.sm },
  message: { marginTop: space.md },
  cta: { marginTop: space.lg },
  switchModeText: {
    ...typography.bodySm,
    textAlign: 'center',
    marginTop: space.lg,
  },
});
