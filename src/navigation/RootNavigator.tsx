import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuth } from '../context/AuthContext';
import { navigationRef } from '../lib/navigationRef';
import { MatchFoundWatcher } from '../components/MatchFoundWatcher';
import { colors, fonts } from '../theme/tokens';
import type { RootStackParamList } from './types';
import { LoginScreen } from '../screens/LoginScreen';
import { HomeScreen } from '../screens/HomeScreen';
import { CreateChallengeScreen } from '../screens/CreateChallengeScreen';
import { ChallengeDetailScreen } from '../screens/ChallengeDetailScreen';
import { MatchInProgressScreen } from '../screens/MatchInProgressScreen';
import { ResultsScreen } from '../screens/ResultsScreen';
import { ProfileScreen } from '../screens/ProfileScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();

export function RootNavigator() {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  return (
    <NavigationContainer ref={navigationRef}>
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerShadowVisible: false,
          headerTintColor: colors.accent,
          // headerTitleStyle only accepts family/size/weight/color, so the
          // titles below are written in caps rather than transformed.
          headerTitleStyle: styles.headerTitle,
          headerBackButtonDisplayMode: 'minimal',
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        {session ? (
          <>
            <Stack.Screen
              name="Home"
              component={HomeScreen}
              options={{ title: 'FIGHT CARD' }}
            />
            <Stack.Screen
              name="CreateChallenge"
              component={CreateChallengeScreen}
              options={{ title: 'CALL OUT' }}
            />
            <Stack.Screen
              name="ChallengeDetail"
              component={ChallengeDetailScreen}
              options={{ title: 'THE BOUT' }}
            />
            <Stack.Screen
              name="MatchInProgress"
              component={MatchInProgressScreen}
              options={{ title: 'IN THE RING', headerBackVisible: false }}
            />
            <Stack.Screen
              name="Results"
              component={ResultsScreen}
              options={{ title: 'DECISION' }}
            />
            <Stack.Screen
              name="Profile"
              component={ProfileScreen}
              options={{ title: 'YOUR CORNER' }}
            />
          </>
        ) : (
          <Stack.Screen
            name="Login"
            component={LoginScreen}
            options={{ headerShown: false }}
          />
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

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  headerTitle: {
    fontFamily: fonts.display,
    fontWeight: '800',
    fontSize: 22,
    color: colors.text,
  },
});
