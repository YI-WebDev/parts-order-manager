import path from 'node:path';
import { defineConfig } from 'vitest/config';

// 旧実装（Electron の Main プロセス）と新実装（Rust）の差分テスト（pnpm test:differential）。
// 旧実装の取得先は POM_BASELINE（tools/differential.mjs が用意する）。
const baseline = process.env.POM_BASELINE ?? '';
const linuxSqlite = process.platform === 'win32' ? [] : [{ find: /^better-sqlite3\/win32-x64$/, replacement: 'better-sqlite3/linux-x64' }];
// 出力先の検査は Windows のドライブ文字（C:\）を前提にしている。Windows 以外では新実装と同じく / から始まる絶対パスを受け付けるよう読み替えて、
// それ以外の判定（拡張子・保護領域・既存ファイルの指紋・一時ファイル）を比べる。
const posixDestination = {
  name: 'posix-destination',
  enforce: 'pre',
  transform(code, id) {
    if (process.platform === 'win32' || !id.endsWith('/src/main/exports/files.ts')) return null;
    const rule = "path.parse(selected).root.length !== 3 || selected[1] !== ':'";
    if (!code.includes(rule)) throw new Error('files.ts の出力先規則が見つかりません');
    return code.replace(rule, "!selected.startsWith('/') || selected.startsWith('//')");
  },
};
export default defineConfig({
  plugins: [posixDestination],
  resolve: { alias: [{ find: /^electron$/, replacement: path.resolve('tests/differential/electron-mock.ts') }, ...linuxSqlite] },
  server: { fs: { allow: [process.cwd(), baseline].filter(Boolean) } },
  test: { include: ['tests/differential/**/*.test.ts'], environment: 'node', testTimeout: 300_000, fileParallelism: false },
});
