/**
 * Fittr
 *
 * @format
 */

import React from 'react';
import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from './src/context/AuthContext';
import { BiometricGate } from './src/components/BiometricGate';
import { RootNavigator } from './src/navigation/RootNavigator';

function App() {
  return (
    <SafeAreaProvider>
      {/* The card stock is black in every system theme, so the bar is always
          light-on-dark rather than following useColorScheme(). RN 0.87 is
          edge-to-edge by default, so the bar draws over the screen's own
          background — no backgroundColor prop needed (or accepted). */}
      <StatusBar barStyle="light-content" />
      <AuthProvider>
        {/* Inside AuthProvider (it needs the session) and around the
            navigator, so the biometric lock covers every signed-in screen. */}
        <BiometricGate>
          <RootNavigator />
        </BiometricGate>
      </AuthProvider>
    </SafeAreaProvider>
  );
}

export default App;
