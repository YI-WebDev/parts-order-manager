import { defineConfig } from 'vitest/config';

// 実際のアプリ（Tauri + WebKitGTK）を WebDriver で操作する確認（Linux。pnpm test:tauri）。先に pnpm build:e2e が必要。
export default defineConfig({ test: { include: ['tests/tauri/**/*.test.ts'], environment: 'node', testTimeout: 180_000, hookTimeout: 60_000, fileParallelism: false } });
