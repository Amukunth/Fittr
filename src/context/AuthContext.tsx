import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { normalizeHandle } from '../lib/identity';
import { assuranceLevel, verifySignInCode } from '../lib/mfa';
import { registerDevice } from '../lib/device';

interface AuthContextValue {
  session: Session | null;
  loading: boolean;
  /**
   * The password was right but the account has two-factor authentication
   * on, so the session is only AAL1. Nothing signed-in is shown until
   * verifyMfaCode() lifts it to AAL2 (or the user signs out).
   */
  mfaRequired: boolean;
  signInWithPassword: (
    email: string,
    password: string,
  ) => Promise<{ error: string | null }>;
  /**
   * `handle` is stored in the auth user's metadata as well as on the
   * profile (fitness_profiles.username, unique). ownHandle() reads the
   * metadata copy; Settings keeps both in step.
   */
  signUpWithPassword: (
    email: string,
    password: string,
    handle?: string,
  ) => Promise<{ error: string | null; needsConfirmation: boolean }>;
  verifyMfaCode: (code: string) => Promise<{ error: string | null }>;
  /** Re-reads the user from the server (after updateUser, identity changes). */
  refreshSession: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [mfaRequired, setMfaRequired] = useState(false);

  // getAuthenticatorAssuranceLevel() reads the JWT locally: no network.
  const evaluateMfa = useCallback(async (next: Session | null) => {
    if (!next) {
      setMfaRequired(false);
      return;
    }
    const aal = await assuranceLevel();
    setMfaRequired(aal.next === 'aal2' && aal.current !== 'aal2');
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      await evaluateMfa(data.session);
      setLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event, nextSession) => {
        setSession(nextSession);
        evaluateMfa(nextSession);
      },
    );

    return () => subscription.subscription.unsubscribe();
  }, [evaluateMfa]);

  // Record this device against the account once the session is fully
  // signed in. Best effort: a failed write must never block the app.
  const userId = session?.user.id ?? null;
  useEffect(() => {
    if (userId && !mfaRequired) {
      registerDevice(userId).catch(() => undefined);
    }
  }, [userId, mfaRequired]);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      loading,
      mfaRequired,
      signInWithPassword: async (email, password) => {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        return { error: error?.message ?? null };
      },
      signUpWithPassword: async (email, password, handle) => {
        const normalized = handle ? normalizeHandle(handle) : '';
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: normalized ? { data: { handle: normalized } } : undefined,
        });
        return {
          error: error?.message ?? null,
          // With email confirmation on, Supabase returns a user but no
          // session; the account exists and needs the link tapped.
          needsConfirmation: !error && !data.session,
        };
      },
      verifyMfaCode: async code => {
        try {
          await verifySignInCode(code);
          // challengeAndVerify() emits MFA_CHALLENGE_VERIFIED with the AAL2
          // session, which the listener above picks up; this just makes the
          // flip immediate for the caller.
          setMfaRequired(false);
          return { error: null };
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },
      refreshSession: async () => {
        const { data } = await supabase.auth.refreshSession();
        if (data.session) {
          setSession(data.session);
        }
      },
      signOut: async () => {
        await supabase.auth.signOut();
      },
    }),
    [session, loading, mfaRequired],
  );

  return (
    <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
