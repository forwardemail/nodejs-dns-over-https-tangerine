export default {
  prettier: true,
  space: 2,
  ignores: ['benchmarks/**/*.js', 'benchmarks/'],
  rules: {
    'max-lines': 'off',
    'ava/no-todo-test': 'off',
    '@stylistic/max-len': 'off',
    '@stylistic/indent': ['error', 2],
    '@stylistic/no-tabs': 'error',
    '@stylistic/no-mixed-spaces-and-tabs': 'off'
  }
};
