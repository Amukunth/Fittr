/**
 * Fittr
 *
 * @format
 */

import React from 'react';
import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from './src/context/AuthContext';
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
        <RootNavigator />
      </AuthProvider>
    </SafeAreaProvider>
  );
}

export default App;
