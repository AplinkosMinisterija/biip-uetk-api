module.exports = {
  setupFiles: ['./test/helpers/setup.js'],
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'tsx', 'js'],
  transform: {
    '^.+\\.(ts|tsx)$': 'ts-jest',
  },
  testMatch: ['**/test/**/*.spec.(ts|js)'],
  testTimeout: 120000,
  globals: {
    'ts-jest': {
      tsconfig: 'tsconfig.json',
    },
  },
};
