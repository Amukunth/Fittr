import { supabase } from './supabase';

/**
 * Two-factor authentication on top of Supabase Auth MFA (TOTP). Enrolment
 * yields a secret + otpauth URI the user adds to an authenticator app, a
 * six-digit code proves it, and from then on a password sign-in only
 * reaches AAL2 after a code (see AuthContext.mfaRequired + LoginScreen).
 */

export interface TotpFactor {
  id: string;
  friendlyName: string | null;
  status: 'verified' | 'unverified';
  createdAt: string;
}

export interface Enrollment {
  factorId: string;
  secret: string;
  uri: string;
}

export async function listFactors(): Promise<TotpFactor[]> {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) {
    throw new Error(humanizeAuthError(error.message));
  }
  return data.all
    .filter(f => f.factor_type === 'totp')
    .map(f => ({
      id: f.id,
      friendlyName: f.friendly_name ?? null,
      status: f.status,
      createdAt: f.created_at,
    }));
}

/** Any verified TOTP factor means 2FA is on. */
export async function twoFactorEnabled(): Promise<boolean> {
  const factors = await listFactors();
  return factors.some(f => f.status === 'verified');
}

/**
 * Starts enrolment. Unverified leftovers from an abandoned attempt are
 * removed first, because Supabase refuses a second factor with the same
 * friendly name.
 */
export async function startEnrollment(): Promise<Enrollment> {
  const existing = await listFactors();
  for (const f of existing.filter(x => x.status === 'unverified')) {
    await supabase.auth.mfa.unenroll({ factorId: f.id });
  }
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'Fittr',
  });
  if (error) {
    throw new Error(humanizeAuthError(error.message));
  }
  return { factorId: data.id, secret: data.totp.secret, uri: data.totp.uri };
}

/** Proves the authenticator has the secret; the session becomes AAL2. */
export async function confirmEnrollment(factorId: string, code: string): Promise<void> {
  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId,
    code: code.replace(/\s/g, ''),
  });
  if (error) {
    throw new Error(humanizeAuthError(error.message));
  }
}

export async function removeFactor(factorId: string): Promise<void> {
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error) {
    throw new Error(humanizeAuthError(error.message));
  }
}

export type Aal = 'aal1' | 'aal2' | null;

export interface AssuranceState {
  current: Aal;
  next: Aal;
}

function asAal(level: string | null | undefined): Aal {
  return level === 'aal1' || level === 'aal2' ? level : null;
}

export async function assuranceLevel(): Promise<AssuranceState> {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error || !data) {
    return { current: null, next: null };
  }
  return { current: asAal(data.currentLevel), next: asAal(data.nextLevel) };
}

/** Sign-in step two: a code against the user's verified factor. */
export async function verifySignInCode(code: string): Promise<void> {
  const factors = await listFactors();
  const factor = factors.find(f => f.status === 'verified');
  if (!factor) {
    throw new Error('No authenticator is set up on this account.');
  }
  await confirmEnrollment(factor.id, code);
}

export function humanizeAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('invalid totp') || m.includes('invalid code') || m.includes('code is invalid')) {
    return "That code didn't match. Check the time on your phone and try the next one.";
  }
  if (m.includes('mfa') && (m.includes('disabled') || m.includes('not enabled'))) {
    return 'Two-factor authentication is not enabled for this project yet. Turn on TOTP under Authentication → Multi-factor in the Supabase dashboard.';
  }
  if (m.includes('aal2') || m.includes('assurance')) {
    return 'Verify with your authenticator first, then try again.';
  }
  if (m.includes('friendly name')) {
    return 'An authenticator with that name already exists. Remove it first.';
  }
  return message;
}
