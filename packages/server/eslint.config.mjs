// Minimal ESLint config — async-correctness rules ONLY (B0.5 起三条):
//   no-floating-promises / await-thenable / no-misused-promises
// Do NOT add style rules: the codebase has no prior lint, a full ruleset would explode.
// All three rules need type information (docs: typeChecked), hence parserOptions.project.
// Violation counts are ratcheted per-rule (only-down) by scripts/eslint-ratchet.mjs
// vs .eslint-baseline.json.
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
      // P1 B0.5 (§8 漏 await 探测网②): 双引擎混迁期 (B1-B5) 的两条 type-checked 兜底 ——
      // await-thenable 抓对非 Promise 的多余 await (互调面), no-misused-promises 抓
      // setImmediate/setTimeout/scheduler 等同步回调位传 async (重灾区)。
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
);
