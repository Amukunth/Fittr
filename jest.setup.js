/* eslint-env jest */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest'),
);

// Screens read useSafeAreaInsets(); the native module behind it doesn't
// exist under Jest, so the package's own mock provides zero insets. It is
// an ES-module default export, hence the `.default`.
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
