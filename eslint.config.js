// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['node_modules/', '.perftale/', 'coverage/', 'examples/', 'test/fixtures/'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // config files aren't part of tsconfig; lint them via an inferred program
          allowDefaultProject: ['eslint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The trace event shape is wide and dynamic; allow pragmatic escape hatches
      // but keep them visible.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true },
      ],
    },
  },
  // config files run in a Node/tooling context, not type-checked against tsconfig
  {
    files: ['*.config.js', '*.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
