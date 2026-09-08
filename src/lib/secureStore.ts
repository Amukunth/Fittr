import * as Keychain from 'react-native-keychain';

/**
 * Biometric app lock, on top of the OS keychain (react-native-keychain: the
 * iOS Keychain and Android Keystore, the bare-RN equivalent of SecureStore).
 *
 * Two items:
 *   - a flag item, readable without a prompt, that says the lock is on;
 *   - a random secret stored behind BIOMETRY_CURRENT_SET, so reading it back
 *     is exactly one Face ID / Touch ID / fingerprint prompt. Unlocking is
 *     "the secret came back". Re-enrolling biometrics on the device
 *     invalidates the secret, and the lock falls back to off.
 */

const FLAG_SERVICE = 'fittr.biometric-lock.flag';
const SECRET_SERVICE = 'fittr.biometric-lock.secret';

export type BiometryKind = 'face' | 'touch' | 'fingerprint' | 'iris' | 'none';

export function biometryLabel(kind: BiometryKind): string {
  switch (kind) {
    case 'face':
      return 'Face ID';
    case 'touch':
      return 'Touch ID';
    case 'fingerprint':
      return 'Fingerprint';
    case 'iris':
      return 'Iris';
    case 'none':
      return 'Biometrics';
  }
}

export async function supportedBiometry(): Promise<BiometryKind> {
  try {
    const type = await Keychain.getSupportedBiometryType();
    switch (type) {
      case Keychain.BIOMETRY_TYPE.FACE_ID:
      case Keychain.BIOMETRY_TYPE.FACE:
        return 'face';
      case Keychain.BIOMETRY_TYPE.TOUCH_ID:
        return 'touch';
      case Keychain.BIOMETRY_TYPE.FINGERPRINT:
        return 'fingerprint';
      case Keychain.BIOMETRY_TYPE.IRIS:
        return 'iris';
      default:
        return 'none';
    }
  } catch {
    return 'none';
  }
}

export async function isBiometricLockEnabled(): Promise<boolean> {
  try {
    const flag = await Keychain.getGenericPassword({ service: FLAG_SERVICE });
    return Boolean(flag && flag.password === '1');
  } catch {
    return false;
  }
}

function randomSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Turns the lock on. Stores the secret, then immediately reads it back so
 * the user proves the prompt works on this device before the flag is set;
 * a failed or cancelled prompt leaves the lock off.
 */
export async function enableBiometricLock(): Promise<boolean> {
  const secret = randomSecret();
  const stored = await Keychain.setGenericPassword('fittr', secret, {
    service: SECRET_SERVICE,
    accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  if (!stored) {
    return false;
  }
  const ok = await unlockWithBiometrics();
  if (!ok) {
    await Keychain.resetGenericPassword({ service: SECRET_SERVICE }).catch(() => undefined);
    return false;
  }
  await Keychain.setGenericPassword('fittr', '1', {
    service: FLAG_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return true;
}

export async function disableBiometricLock(): Promise<void> {
  await Promise.all([
    Keychain.resetGenericPassword({ service: FLAG_SERVICE }).catch(() => undefined),
    Keychain.resetGenericPassword({ service: SECRET_SERVICE }).catch(() => undefined),
  ]);
}

/** One biometric prompt. True when the OS let the secret out. */
export async function unlockWithBiometrics(): Promise<boolean> {
  try {
    const result = await Keychain.getGenericPassword({
      service: SECRET_SERVICE,
      authenticationPrompt: { title: 'Unlock Fittr', cancel: 'Cancel' },
    });
    return Boolean(result && result.password);
  } catch {
    return false;
  }
}
