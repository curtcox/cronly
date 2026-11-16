module.exports = {
  root: true, env: { es2022: true, browser: true, node: true },
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  extends: ['eslint:recommended'],
  globals: { crypto: 'readonly', structuredClone: 'readonly' },
  rules: { 'no-constant-condition': ['error', { checkLoops: false }], 'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }] }
};
