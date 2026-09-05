import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * "Has this user seen the three onboarding beats on this device." Per user,
 * so a second account on the same phone gets its own walkthrough. Fails
 * open on storage errors: a broken store must never trap someone in
 * onboarding.
 */
const key = (userId: string) => `fittr:onboarded:${userId}`;

export async function hasOnboarded(userId: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(key(userId))) === '1';
  } catch {
    return true;
  }
}

export async function markOnboarded(userId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(key(userId), '1');
  } catch {
    // Nothing to do: the flag is a convenience, not state the app relies on.
  }
}
