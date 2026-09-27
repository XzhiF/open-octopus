// Minimal ESLint config — ONE rule only: @typescript-eslint/no-floating-promises.
// Do NOT add style rules: the codebase has no prior lint, a full ruleset would explode.
// The rule needs type information (docs: typeChecked), hence parserOptions.project.
// Violation count is ratcheted (only-down) by scripts/eslint-ratchet.mjs vs .eslint-baseline.json.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**'] },
  {
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.base],
    linterOptions: {
      // Legacy `// eslint-disable-next-line no-console` comments predate lint adoption;
      // reporting them as "unused directive" warnings is noise for this single-rule gate.
      reportUnusedDisableDirectives: 'off',
    },
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
);
