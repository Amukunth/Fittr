import React, { useEffect, useState } from 'react';
import { DarkTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuth } from '../context/AuthContext';
import { hasOnboarded } from '../lib/onboarding';
import { colors } from '../theme/tokens';
import { Loading } from '../theme/ui';
import type { RootStackParamList } from './types';
import { LoginScreen } from '../screens/LoginScreen';
import { OnboardingScreen } from '../screens/OnboardingScreen';
import { HomeScreen } from '../screens/HomeScreen';
import { FindBoutScreen } from '../screens/FindBoutScreen';
import { SearchingScreen } from '../screens/SearchingScreen';
import { MatchInProgressScreen } from '../screens/MatchInProgressScreen';
import { ResultsScreen } from '../screens/ResultsScreen';
import { ProfileScreen } from '../screens/ProfileScreen';
import { SettingsScreen } from '../screens/settings/SettingsScreen';
import { ChangePasswordScreen } from '../screens/settings/ChangePasswordScreen';
import { TwoFactorScreen } from '../screens/settings/TwoFactorScreen';
import { SessionsScreen } from '../screens/settings/SessionsScreen';
import { ConnectedAccountsScreen } from '../screens/settings/ConnectedAccountsScreen';
import { DepositScreen } from '../screens/settings/DepositScreen';
import { CashoutScreen } from '../screens/settings/CashoutScreen';
import { LinkedAccountsScreen } from '../screens/settings/LinkedAccountsScreen';
import { TransactionsScreen } from '../screens/settings/TransactionsScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * Bouts / Find / Profile are tabs drawn by each screen's own TabBar, but
 * they sit on this one native stack, so without this a tab tap played a
 * full push/pop slide with the tab bar riding along. A tab switch should
 * be instant, like a real tab bar, and the back-swipe should not reveal
 * the previous tab underneath. Searching, match and results screens keep
 * the default slide, since those really are pushed on top.
 */
const TAB_SCREEN = { animation: 'none', gestureEnabled: false } as const;

/** Keeps the container's own ground black, so screen transitions never flash white. */
const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: colors.accent,
    background: colors.bg,
    card: colors.bg,
    text: colors.text,
    border: colors.tabLine,
  },
};

export function RootNavigator() {
  const { session, loading, mfaRequired } = useAuth();
  const userId = session?.user.id ?? null;

  // null while the per-user flag is being read; the signed-in stack is not
  // rendered until it's known, so the first screen is the right one.
  const [onboarded, setOnboarded] = useState<boolean | null>(null);

  useEffect(() => {
    if (!userId) {
      setOnboarded(null);
      return;
    }
    let cancelled = false;
    hasOnboarded(userId).then(value => {
      if (!cancelled) {
        setOnboarded(value);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (loading || (userId && onboarded === null)) {
    return <Loading />;
  }

  // Every screen draws its own chrome (back circles, page heads, the tab
  // bar) exactly where the design puts it, so the native header is off.
  // When the signed-in set replaces Login, React Navigation lands on the
  // FIRST screen listed, which is why Onboarding is ordered ahead of Home
  // for a first-time user.
  const onboarding = (
    <Stack.Screen name="Onboarding" component={OnboardingScreen} />
  );

  // A session that still owes a two-factor code stays on Login, which
  // shows the code step; nothing signed-in is reachable until it clears.
  const signedIn = Boolean(session) && !mfaRequired;

  return (
    <NavigationContainer theme={theme}>
      <Stack.Navigator
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        {signedIn ? (
          <>
            {onboarded ? null : onboarding}
            <Stack.Screen name="Home" component={HomeScreen} options={TAB_SCREEN} />
            {onboarded ? onboarding : null}
            <Stack.Screen name="FindBout" component={FindBoutScreen} options={TAB_SCREEN} />
            {/*
              No back-swipe: leaving the queue has to go through the screen's
              own cancel path (it must learn whether the lobby filled in the
              same instant), which it does by intercepting beforeRemove. A
              gesture that starts the pop before the RPC answers would
              defeat that.
            */}
            <Stack.Screen
              name="Searching"
              component={SearchingScreen}
              options={{ gestureEnabled: false }}
            />
            <Stack.Screen
              name="MatchInProgress"
              component={MatchInProgressScreen}
              options={{ gestureEnabled: false }}
            />
            <Stack.Screen name="Results" component={ResultsScreen} />
            <Stack.Screen name="Profile" component={ProfileScreen} options={TAB_SCREEN} />
            <Stack.Screen name="Settings" component={SettingsScreen} />
            <Stack.Screen name="ChangePassword" component={ChangePasswordScreen} />
            <Stack.Screen name="TwoFactor" component={TwoFactorScreen} />
            <Stack.Screen name="Sessions" component={SessionsScreen} />
            <Stack.Screen name="ConnectedAccounts" component={ConnectedAccountsScreen} />
            <Stack.Screen name="Deposit" component={DepositScreen} />
            <Stack.Screen name="Cashout" component={CashoutScreen} />
            <Stack.Screen name="LinkedAccounts" component={LinkedAccountsScreen} />
            <Stack.Screen name="Transactions" component={TransactionsScreen} />
          </>
        ) : (
          <Stack.Screen name="Login" component={LoginScreen} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
