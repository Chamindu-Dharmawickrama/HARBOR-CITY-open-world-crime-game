import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const MATH_RANDOM = { object: 'Math', property: 'random', message: 'Use core/rng streams (deterministic).' };

/** Simulation domains must use the sim clock, never wall-clock time. */
const SIM_DOMAINS = 'src/{ecs,physics,world,characters,vehicles,combat,ai,police,missions,content}/**/*.ts';

export default defineConfig(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'test-results/**',
      'playwright-report/**',
      'bench-results/**',
      'coverage/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['vite.config.ts', 'playwright.config.ts'],
          defaultProject: 'tsconfig.node.json',
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-warning-comments': ['error', { terms: ['todo', 'fixme', 'xxx', 'hack'], location: 'anywhere' }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: { globals: globals.browser },
    rules: {
      'no-restricted-properties': ['error', MATH_RANDOM],
      'no-restricted-syntax': [
        'error',
        { selector: 'ExportDefaultDeclaration', message: 'Named exports only.' },
      ],
      'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
      '@typescript-eslint/prefer-readonly': 'error',
    },
  },
  {
    files: [SIM_DOMAINS],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        MATH_RANDOM,
        { object: 'Date', property: 'now', message: 'Use the sim clock.' },
        { object: 'performance', property: 'now', message: 'Use the sim clock.' },
      ],
    },
  },
  {
    files: ['*.config.{ts,js}', '.dependency-cruiser.cjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // Automation scripts run in Node but pass callbacks to page.evaluate() that run in the browser.
    files: ['e2e/**/*.ts', 'scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
