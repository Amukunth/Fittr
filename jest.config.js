module.exports = {
  preset: '@react-native/jest-preset',
  setupFiles: ['./jest.setup.js'],
  // The database suites boot a real embedded Postgres per file (~3s) and
  // replay every migration against it; give them room.
  testTimeout: 60000,
  transformIgnorePatterns: [
    'node_modules/(?!(?:.pnpm/)?(@react-native|react-native|@react-navigation|react-native-get-random-values|react-native-url-polyfill|react-native-screens|react-native-safe-area-context|@react-native-async-storage|@quickpose)/)',
  ],
};
