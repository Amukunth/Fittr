import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuth } from '../context/AuthContext';
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
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <NavigationContainer>
      <Stack.Navigator>
        {session ? (
          <>
            <Stack.Screen
              name="Home"
              component={HomeScreen}
              options={{ title: 'Open Challenges' }}
            />
            <Stack.Screen
              name="CreateChallenge"
              component={CreateChallengeScreen}
              options={{ title: 'New Challenge' }}
            />
            <Stack.Screen
              name="ChallengeDetail"
              component={ChallengeDetailScreen}
              options={{ title: 'Challenge' }}
            />
            <Stack.Screen
              name="MatchInProgress"
              component={MatchInProgressScreen}
              options={{ title: 'Match', headerBackVisible: false }}
            />
            <Stack.Screen
              name="Results"
              component={ResultsScreen}
              options={{ title: 'Results' }}
            />
            <Stack.Screen
              name="Profile"
              component={ProfileScreen}
              options={{ title: 'Profile' }}
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
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
