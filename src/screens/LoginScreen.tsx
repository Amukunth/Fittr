import React, { useState } from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { colors, fonts, space, typography } from '../theme/tokens';
import { Body, Button, Display, Input, Notice, Small } from '../theme/ui';

const logo = require('../../assets/images/fittr-logo.png');

/**
 * Email-first auth, one screen for both modes. Sign-up adds a handle field
 * (stored on the auth user, see AuthContext). Passwords stay: the backend
 * is Supabase email/password, so "continue with email" here means log in.
 */
export function LoginScreen() {
  const { signInWithPassword, signUpWithPassword } = useAuth();
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [handle, setHandle] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const signup = mode === 'signup';

  const submit = async () => {
    setError(null);
    setInfo(null);
    if (signup && !handle.trim()) {
      setError('Pick a handle. It goes on the card.');
      return;
    }
    if (!email.trim() || !password) {
      setError('Enter an email and password.');
      return;
    }

    setSubmitting(true);
    if (signup) {
      const result = await signUpWithPassword(
        email.trim(),
        password,
        handle.trim(),
      );
      setSubmitting(false);
      if (result.error) {
        setError(result.error);
      } else if (result.needsConfirmation) {
        setInfo('Account created. Tap the link in your email, then log in.');
        setMode('login');
      }
    } else {
      const result = await signInWithPassword(email.trim(), password);
      setSubmitting(false);
      if (result.error) {
        setError(result.error);
      }
    }
  };

  const switchMode = () => {
    setError(null);
    setInfo(null);
    setMode(signup ? 'login' : 'signup');
  };

  const pad = {
    paddingTop: insets.top + space.xxxl + space.sm,
    paddingBottom: Math.max(insets.bottom, space.lg) + space.xxl,
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      // 'padding' on both platforms: with edge-to-edge on Android the window
      // no longer resizes for the keyboard, so without this the form sits
      // under it.
      behavior="padding"
    >
      <ScrollView
        contentContainerStyle={[styles.content, pad]}
        keyboardShouldPersistTaps="handled"
        bounces={false}
      >
        <View style={styles.brand}>
          <Image source={logo} style={styles.logo} accessibilityLabel="Fittr" />
          <Text style={styles.wordmark}>FITTR</Text>
        </View>

        <View style={styles.spacer} />

        <Display size={52}>
          {signup
            ? 'PUT YOUR NAME ON THE CARD.'
            : 'SOMEBODY YOU KNOW IS ABOUT TO LOSE.'}
        </Display>
        <Body muted style={styles.sub}>
          {signup
            ? 'Handle, email, done. Your first purse is waiting.'
            : 'Log in. Your record is waiting for you.'}
        </Body>

        <View style={styles.form}>
          {signup ? (
            <Input
              placeholder="@handle"
              autoCapitalize="none"
              autoCorrect={false}
              value={handle}
              onChangeText={setHandle}
              returnKeyType="next"
            />
          ) : null}
          <Input
            placeholder="you@email.com"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
            value={email}
            onChangeText={setEmail}
            returnKeyType="next"
          />
          <Input
            placeholder="Password"
            secureTextEntry
            textContentType={signup ? 'newPassword' : 'password'}
            value={password}
            onChangeText={setPassword}
            returnKeyType="go"
            onSubmitEditing={submit}
          />
          {error ? <Notice icon="warning">{error}</Notice> : null}
          {info ? <Notice icon="seal-check" iconColor={colors.accent}>{info}</Notice> : null}
          <Button
            label={signup ? 'CREATE ACCOUNT' : 'LOG IN'}
            onPress={submit}
            loading={submitting}
          />
        </View>

        <View style={styles.switchRow}>
          <Small>{signup ? 'Already fighting?' : 'New here?'}</Small>
          <Pressable onPress={switchMode} hitSlop={8} accessibilityRole="button">
            <Text style={styles.switchLink}>{signup ? 'Log in' : 'Sign up'}</Text>
          </Pressable>
        </View>
        <Text style={styles.footnote}>
          18+ only. Points have no cash value during pilot.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: {
    flexGrow: 1,
    paddingHorizontal: space.xxl,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  logo: { width: 40, height: 40, borderRadius: 10 },
  wordmark: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    letterSpacing: 4.2,
    color: colors.text,
    includeFontPadding: false,
  },
  spacer: { flex: 1, minHeight: space.xxxl },
  sub: { marginTop: 14 },
  form: { marginTop: space.xxxl, gap: space.sm + 2 },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
    marginTop: 22,
  },
  switchLink: {
    fontFamily: fonts.medium,
    fontSize: 13,
    lineHeight: 19,
    color: colors.accent,
  },
  footnote: {
    ...typography.footnote,
    textAlign: 'center',
    marginTop: space.cardPad,
  },
});
