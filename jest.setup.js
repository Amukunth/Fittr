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

// Native modules behind Settings. Neither has a JS fallback under Jest, so
// they are stubbed to "nothing available / user cancelled".
jest.mock('react-native-keychain', () => ({
  ACCESS_CONTROL: { BIOMETRY_CURRENT_SET: 'BiometryCurrentSet' },
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'AccessibleWhenUnlockedThisDeviceOnly' },
  AUTHENTICATION_TYPE: { BIOMETRICS: 'AuthenticationWithBiometrics' },
  BIOMETRY_TYPE: {
    TOUCH_ID: 'TouchID',
    FACE_ID: 'FaceID',
    OPTIC_ID: 'OpticID',
    FINGERPRINT: 'Fingerprint',
    FACE: 'Face',
    IRIS: 'Iris',
  },
  getSupportedBiometryType: jest.fn(async () => null),
  getGenericPassword: jest.fn(async () => false),
  setGenericPassword: jest.fn(async () => ({ service: '', storage: '' })),
  resetGenericPassword: jest.fn(async () => true),
  hasGenericPassword: jest.fn(async () => false),
}));

jest.mock('react-native-image-picker', () => ({
  launchCamera: jest.fn(async () => ({ didCancel: true })),
  launchImageLibrary: jest.fn(async () => ({ didCancel: true })),
}));
