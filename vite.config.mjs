import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  publicDir: false,
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    fs: { strict: true, deny: ['.env', '.env.*', '**/.git/**', '**/private/**', '**/docs/**', '**/reference/**', '**/*.{xlsx,xls,xlsm,db,sqlite,sqlite3,pdf}'] },
    watch: { ignored: ['**/private/**', '**/out/**', '**/artifacts/**', '**/src-tauri/**', '**/dist/**'] },
  },
  // Tauri が実行ファイルへ埋め込む出力先（src-tauri/tauri.conf.json の frontendDist）。
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, target: 'es2022' },
  clearScreen: false,
});
