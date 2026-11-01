// 差分テスト: 移行前の TypeScript 実装（Electron 版の Main プロセス）と Rust 実装に同じ要求を送り、応答・ダイアログ・DB の中身を突き合わせる。
// 実行: pnpm test:differential
// 1. 移行前のコミットを .differential/baseline に取り出す（POM_BASELINE で別の場所を指定できる）
// 2. 旧実装の依存を入れる（Electron 本体は不要なので外す）
// 3. Rust 側の実行器（pom-core の examples/harness）を作る
// 4. vitest（vitest.differential.config.mjs）で突き合わせる。乱数の種・件数は POM_DIFF_SEED・POM_DIFF_CASES で変えられる。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 移行前（Electron 版）の最後のコミット */
const BASE_COMMIT = 'ad7f05a';
const baseline = path.resolve(process.env.POM_BASELINE ?? path.join(ROOT, '.differential', 'baseline'));
const windows = process.platform === 'win32';
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: windows && !command.endsWith('.exe'), ...options });

if (!existsSync(path.join(baseline, 'package.json'))) {
  console.log(`旧実装を取り出します: ${BASE_COMMIT} → ${baseline}`);
  run('git', ['worktree', 'add', '--detach', baseline, BASE_COMMIT]);
}
if (!existsSync(path.join(baseline, 'node_modules', 'better-sqlite3'))) {
  const file = path.join(baseline, 'package.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  for (const name of Object.keys(manifest.devDependencies ?? {})) if (name === 'electron' || name.startsWith('@electron-forge/')) delete manifest.devDependencies[name];
  if (manifest.pnpm) { delete manifest.pnpm.patchedDependencies; manifest.pnpm.onlyBuiltDependencies = ['esbuild']; }
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  run('pnpm', ['install', '--no-frozen-lockfile'], { cwd: baseline });
}
run('cargo', ['build', '--manifest-path', path.join('src-tauri', 'Cargo.toml'), '-p', 'pom-core', '--example', 'harness', '--features', 'sequential-ids']);
run('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.differential.config.mjs', ...process.argv.slice(2)], { env: { ...process.env, POM_BASELINE: baseline, POM_HARNESS: path.join(ROOT, 'src-tauri', 'target', 'debug', 'examples', windows ? 'harness.exe' : 'harness') } });
