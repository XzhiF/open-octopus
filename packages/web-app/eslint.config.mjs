import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.next/**',
      'test-results/**',
      'playwright-report/**',
      'public/prototype/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      'no-empty': 'off',
      'no-useless-escape': 'off',
      'no-control-regex': 'off',
      'no-cond-assign': 'off',
      'no-fallthrough': 'off',
      'no-case-declarations': 'off',
      'no-constant-condition': 'off',
      'no-inner-declarations': 'off',
      'no-prototype-builtins': 'off',
      'no-useless-catch': 'off',
      'no-self-assign': 'off',
      'no-async-promise-executor': 'off',
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
      'prefer-const': 'off',
      'no-var': 'off',
    },
  },
)
