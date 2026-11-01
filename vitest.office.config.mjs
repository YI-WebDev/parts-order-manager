import { defineConfig } from 'vitest/config';

// 実際の LibreOffice・Excel を起動する互換性テスト（pnpm test:office）。通常の pnpm test には含めない。
export default defineConfig({ test: { include: ['tests/office/**/*.test.ts'], environment: 'node', testTimeout: 300_000, hookTimeout: 60_000 } });
