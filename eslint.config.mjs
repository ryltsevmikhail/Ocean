import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      eqeqeq: ['error', 'always'],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['*/src/*', '@runnets/*/*'],
              message:
                'Import another package through its public entry point (@runnets/<name>), not its internals.',
            },
          ],
        },
      ],
    },
  },
  {
    // Tests and root config files are intentionally outside the build projects,
    // so they are linted without type information instead of failing to parse.
    files: ['**/*.test.ts', '*.config.ts', 'eslint.config.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      parserOptions: { projectService: false, project: false },
    },
  },
);
