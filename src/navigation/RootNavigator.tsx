import React, { useEffect, useState } from 'react';
import { DarkTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuth } from '../context/AuthContext';
import { navigationRef } from '../lib/navigationRef';
import { hasOnboarded } from '../lib/onboarding';
import { MatchFoundWatcher } from '../components/MatchFoundWatcher';
import { colors } from '../theme/tokens';
import { Loading } from '../theme/ui';
import type { RootStackParamList } from './types';
import { LoginScreen } from '../screens/LoginScreen';
import { OnboardingScreen } from '../screens/OnboardingScreen';
import { HomeScreen } from '../screens/HomeScreen';
import { CreateChallengeScreen } from '../screens/CreateChallengeScreen';
import { ChallengeDetailScreen } from '../screens/ChallengeDetailScreen';
import { MatchInProgressScreen } from '../screens/MatchInProgressScreen';
import { ResultsScreen } from '../screens/ResultsScreen';
import { ProfileScreen } from '../screens/ProfileScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * Bouts / Create / Profile are tabs drawn by each screen's own TabBar, but
 * they sit on this one native stack, so without this a tab tap played a
 * full push/pop slide with the tab bar riding along. A tab switch should
 * be instant, like a real tab bar, and the back-swipe should not reveal
 * the previous tab underneath. Detail, match and results screens keep the
 * default slide, since those really are pushed on top.
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
  const { session, loading } = useAuth();
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

  return (
    <NavigationContainer ref={navigationRef} theme={theme}>
      <Stack.Navigator
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        {session ? (
          <>
            {onboarded ? null : onboarding}
            <Stack.Screen name="Home" component={HomeScreen} options={TAB_SCREEN} />
            {onboarded ? onboarding : null}
            <Stack.Screen
              name="CreateChallenge"
              component={CreateChallengeScreen}
              options={TAB_SCREEN}
            />
            <Stack.Screen
              name="ChallengeDetail"
              component={ChallengeDetailScreen}
            />
            <Stack.Screen
              name="MatchInProgress"
              component={MatchInProgressScreen}
              options={{ gestureEnabled: false }}
            />
            <Stack.Screen name="Results" component={ResultsScreen} />
            <Stack.Screen name="Profile" component={ProfileScreen} options={TAB_SCREEN} />
          </>
        ) : (
          <Stack.Screen name="Login" component={LoginScreen} />
        )}
      </Stack.Navigator>
      {/*
        Sibling of the navigator, not a screen: it has to keep listening for
        "your challenge was accepted" no matter which screen is mounted, and
        its banner overlays whatever is on top.
      */}
      <MatchFoundWatcher />
    </NavigationContainer>
  );
}
