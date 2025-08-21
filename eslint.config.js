export default [
  {
    ignores: ['benchmarks/**/*.js', 'benchmarks/', 'node_modules/**']
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module'
    },
    rules: {
      // Project specific overrides
      'max-lines': 'off',
      'no-multi-spaces': 'error',
      'no-tabs': 'error',
      'no-mixed-spaces-and-tabs': 'error'
    }
  },
  {
    files: ['test/**/*.js'],
    rules: {
      'max-lines': 'off'
    }
  },
  {
    files: ['index.js'],
    rules: {
      'max-lines': 'off'
    }
  }
];
