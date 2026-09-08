import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  type AppStateStatus,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import {
  biometryLabel,
  isBiometricLockEnabled,
  supportedBiometry,
  unlockWithBiometrics,
  type BiometryKind,
} from '../lib/secureStore';
import { colors, fonts, space } from '../theme/tokens';
import { Body, Button, Display, Notice } from '../theme/ui';

const logo = require('../../assets/images/fittr-logo.png');

/** Away longer than this and coming back asks for biometrics again. */
const RELOCK_AFTER_MS = 60_000;

/**
 * Biometric app lock. Sits between AuthProvider and the navigator so it can
 * cover every signed-in screen at once.
 *
 * Locks on a cold start that already has a session, and again whenever the
 * app comes back after more than a minute in the background. The lock is
 * drawn over the children rather than in place of them: a re-lock must not
 * throw away navigation state or a bout that was mid-capture, so the tree
 * underneath stays mounted, untouchable and hidden from screen readers
 * until the prompt succeeds. Nothing here runs when nobody is signed in or
 * the setting is off (the flag is re-read on every re-lock, so toggling it
 * in Settings takes effect on the next return).
 */
export function BiometricGate({ children }: { children: React.ReactNode }) {
  const { session, loading, mfaRequired, signOut } = useAuth();
  // A session still owed a two-factor code shows nothing but the code step;
  // there is nothing to protect yet, and a prompt over it is one auth too many.
  const signedIn = Boolean(session) && !mfaRequired;

  const [locked, setLocked] = useState(false);
  const [prompting, setPrompting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [kind, setKind] = useState<BiometryKind>('none');

  const alive = useRef(true);
  const signedInRef = useRef(signedIn);
  const promptingRef = useRef(false);
  const backgroundedAt = useRef<number | null>(null);
  const startupChecked = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    signedInRef.current = signedIn;
  }, [signedIn]);

  useEffect(() => {
    supportedBiometry().then(next => {
      if (alive.current) {
        setKind(next);
      }
    });
  }, []);

  /** One prompt. Success unlocks; anything else stays locked with a nudge. */
  const prompt = useCallback(async () => {
    // A prompt from the background cannot succeed; the UNLOCK button is
    // there for when the app is actually in front.
    if (promptingRef.current || AppState.currentState === 'background') {
      return;
    }
    promptingRef.current = true;
    setPrompting(true);
    setFailed(false);
    const ok = await unlockWithBiometrics();
    promptingRef.current = false;
    if (!alive.current) {
      return;
    }
    setPrompting(false);
    if (ok) {
      setLocked(false);
    } else {
      setFailed(true);
    }
  }, []);

  /** Lock and prompt, if someone is signed in and the setting is on. */
  const lockIfEnabled = useCallback(async () => {
    if (!signedInRef.current) {
      return;
    }
    const enabled = await isBiometricLockEnabled();
    if (!alive.current || !enabled || !signedInRef.current) {
      return;
    }
    setLocked(true);
    prompt();
  }, [prompt]);

  // Cold start. Only the session the app woke up with counts: someone who
  // just typed their password has proved who they are.
  useEffect(() => {
    if (loading || startupChecked.current) {
      return;
    }
    startupChecked.current = true;
    if (signedIn) {
      lockIfEnabled();
    }
  }, [loading, signedIn, lockIfEnabled]);

  // Sign-out (from the lock view or anywhere else) is what lifts the lock.
  useEffect(() => {
    if (!signedIn) {
      setLocked(false);
      setFailed(false);
      setSigningOut(false);
      backgroundedAt.current = null;
    }
  }, [signedIn]);

  // Re-lock on return. Only 'background' counts as leaving: iOS reports
  // 'inactive' for the biometric sheet itself, the app switcher and control
  // centre, none of which should start the clock.
  useEffect(() => {
    const subscription = AppState.addEventListener(
      'change',
      (next: AppStateStatus) => {
        if (next === 'background') {
          backgroundedAt.current = Date.now();
          return;
        }
        if (next !== 'active' || backgroundedAt.current === null) {
          return;
        }
        const away = Date.now() - backgroundedAt.current;
        backgroundedAt.current = null;
        if (away > RELOCK_AFTER_MS) {
          lockIfEnabled();
        }
      },
    );
    return () => subscription.remove();
  }, [lockIfEnabled]);

  // Not unlocked here: the session going away does that (see above). If the
  // sign-out never lands, the lock stays, which is the safe side.
  const signOutInstead = async () => {
    setSigningOut(true);
    setFailed(false);
    try {
      await signOut();
    } catch {
      // AuthContext.signOut has no error surface; the lock simply stays.
    }
    if (alive.current) {
      setSigningOut(false);
    }
  };

  return (
    <View style={styles.fill}>
      <View
        style={styles.fill}
        pointerEvents={locked ? 'none' : 'auto'}
        accessibilityElementsHidden={locked}
        importantForAccessibility={locked ? 'no-hide-descendants' : 'auto'}
      >
        {children}
      </View>
      {locked ? (
        <LockView
          kind={kind}
          prompting={prompting}
          failed={failed}
          signingOut={signingOut}
          onUnlock={prompt}
          onSignOut={signOutInstead}
        />
      ) : null}
    </View>
  );
}

function LockView({
  kind,
  prompting,
  failed,
  signingOut,
  onUnlock,
  onSignOut,
}: {
  kind: BiometryKind;
  prompting: boolean;
  failed: boolean;
  signingOut: boolean;
  onUnlock: () => void;
  onSignOut: () => void;
}) {
  const insets = useSafeAreaInsets();
  const pad = {
    paddingTop: insets.top + space.xxxl + space.sm,
    paddingBottom: Math.max(insets.bottom, space.lg) + space.xxl,
  };
  return (
    <View style={[styles.lock, pad]} accessibilityViewIsModal>
      <View style={styles.brand}>
        <Image source={logo} style={styles.logo} accessibilityLabel="Fittr" />
        <Text style={styles.wordmark}>FITTR</Text>
      </View>

      <View style={styles.spacer} />

      <Display size={52}>LOCKED.</Display>
      <Body muted style={styles.sub}>
        {`Unlock with ${biometryLabel(kind)} to continue.`}
      </Body>

      <View style={styles.actions}>
        {failed ? <Notice icon="warning">Try again.</Notice> : null}
        <Button
          label="UNLOCK"
          onPress={onUnlock}
          loading={prompting}
          disabled={signingOut}
        />
      </View>

      <Pressable
        onPress={onSignOut}
        disabled={prompting || signingOut}
        accessibilityRole="button"
        accessibilityState={{ disabled: prompting || signingOut, busy: signingOut }}
        style={styles.signOut}
      >
        <Text style={styles.signOutText}>
          {signingOut ? 'Signing out…' : 'Sign out instead'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  lock: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.bg,
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
  actions: { marginTop: space.xxxl, gap: space.sm + 2 },
  signOut: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    marginTop: space.md,
  },
  signOutText: {
    fontFamily: fonts.medium,
    fontSize: 13,
    lineHeight: 19,
    color: colors.accent,
  },
});
