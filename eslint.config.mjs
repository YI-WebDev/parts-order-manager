import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['node_modules/**', '.vite/**', 'dist/**', 'out/**', 'private/**', 'artifacts/**', 'test-results/**', 'playwright-report/**', '.codegraph/**', '.differential/**', 'src-tauri/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { parserOptions: { project: './tsconfig.json' } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error'
    }
  },
  // Node.js で動かすツール（ビルド・ライセンス表記・アイコン・設定ファイル）。
  { files: ['tools/*.mjs', 'assets/icon/*.mjs', '*.mjs'], languageOptions: { globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', URL: 'readonly' } } }
);
