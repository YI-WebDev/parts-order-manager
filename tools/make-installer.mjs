// Windows 用インストーラー（Inno Setup 6）を作る。`pnpm make` で Tauri の実行ファイルを作った後に動く。
// 入力: src-tauri/target/release/parts-order-manager.exe と THIRD-PARTY-NOTICES.txt
// 出力: out/make/inno-setup/x64/PartsOrderManager-<版>-Setup.exe（作業用の配置は out/package/発注書管理-win32-x64）
// PARTS_ORDER_ISCC に ISCC.exe の場所を指定できる（既定は Inno Setup 6 の標準の導入先）。
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'tools', 'windows-installer.iss');
export const EXE = 'parts-order-manager.exe';

// PARTS_ORDER_ISCC overrides the per-user and all-users locations used by the Inno Setup 6 installer.
export function findCompiler(env) {
  const override = env.PARTS_ORDER_ISCC;
  if (override) {
    if (!path.isAbsolute(override) || path.basename(override).toLowerCase() !== 'iscc.exe') throw new Error('PARTS_ORDER_ISCC must be the absolute path of ISCC.exe');
    return existsSync(override) ? override : undefined;
  }
  return [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), env['ProgramFiles(x86)'], env.ProgramFiles]
    .filter(Boolean).map(root => path.join(root, 'Inno Setup 6', 'ISCC.exe')).find(file => existsSync(file));
}

/** "0.1.0" → "0.1.0.0"（Windows のファイルバージョンは4つの数）。 */
export function fileVersion(version) {
  const parts = version.split(/[.+-]/).slice(0, 4).map(part => Number.parseInt(part, 10));
  if (parts.length < 3 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 65535)) throw new Error(`Unsupported version ${version}`);
  while (parts.length < 4) parts.push(0);
  return parts.join('.');
}

// ISCC mangles quotes in /D values, and braces would be read as Inno Setup constants.
export function compilerArguments({ packagedDir, makeDir, packageJSON, setupIcon }) {
  const defines = {
    AppName: packageJSON.productName, AppVersion: packageJSON.version, FileVersion: fileVersion(packageJSON.version), AppPublisher: packageJSON.author,
    AppExeName: EXE, PackagedDir: packagedDir, SetupIconFile: setupIcon,
  };
  for (const [name, value] of Object.entries(defines)) {
    if (typeof value !== 'string' || !value || /["{}\r\n]/.test(value)) throw new Error(`Installer value ${name} is missing or contains a quote, brace or line break`);
  }
  const outputDir = path.join(makeDir, 'inno-setup', 'x64');
  const baseName = `PartsOrderManager-${packageJSON.version}-Setup`;
  return {
    file: path.join(outputDir, `${baseName}.exe`),
    args: ['/Q', `/O${outputDir}`, `/F${baseName}`, ...Object.entries(defines).map(([name, value]) => `/D${name}=${value}`), SCRIPT],
  };
}

/** インストーラーに入れるファイルを1か所にまとめる（実行ファイルと第三者ライセンス表記）。 */
export function stage(root, packagedDir) {
  const exe = path.join(root, 'src-tauri', 'target', 'release', EXE);
  if (!existsSync(exe)) throw new Error(`${exe} がありません。先に pnpm build（tauri build）を実行してください。`);
  rmSync(packagedDir, { recursive: true, force: true });
  mkdirSync(packagedDir, { recursive: true });
  copyFileSync(exe, path.join(packagedDir, EXE));
  copyFileSync(path.join(root, 'THIRD-PARTY-NOTICES.txt'), path.join(packagedDir, 'THIRD-PARTY-NOTICES.txt'));
  return statSync(path.join(packagedDir, EXE)).size;
}

async function main() {
  if (process.platform !== 'win32') throw new Error('インストーラーは Windows で作成してください（Inno Setup 6 が必要です）。');
  const compiler = findCompiler(process.env);
  if (!compiler) throw new Error('Inno Setup 6（ISCC.exe）が見つかりません。winget install --id JRSoftware.InnoSetup -e --scope user で導入するか、環境変数 PARTS_ORDER_ISCC に ISCC.exe の場所を指定してください。');
  const packageJSON = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const packagedDir = path.join(ROOT, 'out', 'package', `${packageJSON.productName}-win32-x64`);
  const size = stage(ROOT, packagedDir);
  const { file, args } = compilerArguments({ packagedDir, makeDir: path.join(ROOT, 'out', 'make'), packageJSON, setupIcon: path.join(ROOT, 'assets', 'icon', 'icon.ico') });
  mkdirSync(path.dirname(file), { recursive: true });
  await new Promise((resolve, reject) => {
    execFile(compiler, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`Inno Setup compile failed (exit ${error.code})\n${stdout}${stderr}`));
      else resolve();
    });
  });
  const mib = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  console.log(`実行ファイル: ${mib(size)}（${path.join(packagedDir, EXE)}）`);
  console.log(`インストーラー: ${mib(statSync(file).size)}（${file}）`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
