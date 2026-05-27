module.exports = {
  setupFiles: ['./test/helpers/setup.js'],
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'tsx', 'js'],
  transform: {
    '^.+\\.(ts|tsx)$': 'ts-jest',
  },
  testMatch: ['**/test/**/*.spec.(ts|js)'],
  testTimeout: 120000,
  // postmark v4 ships ESM-only and our utils/mails.ts pulls it transitively.
  // Jest 27 + ts-jest run in CJS mode, so the ESM `import axios from ...` in
  // postmark's source blows up the suite. Mail flows aren't part of any
  // security test path, so we swap the module for a no-op stub.
  moduleNameMapper: {
    '^postmark$': '<rootDir>/test/helpers/stub-postmark.js',
  },
  globals: {
    'ts-jest': {
      tsconfig: 'tsconfig.json',
    },
  },
};
