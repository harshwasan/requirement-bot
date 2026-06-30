module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^node-fetch$': '<rootDir>/src/__tests__/__mocks__/node-fetch.ts',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/__tests__/**',
    '!src/index.ts',
  ],
  coverageReporters: ['text', 'lcov'],
}
