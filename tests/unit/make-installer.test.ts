import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error -- ビルド用の素の ES モジュール（型定義なし）
import * as maker from '../../tools/make-installer.mjs';

const installer = maker as {
  readonly EXE: string;
  readonly findCompiler: (env: Readonly<Record<string, string | undefined>>) => string | undefined;
  readonly fileVersion: (version: string) => string;
  readonly compilerArguments: (options: { readonly packagedDir: string; readonly makeDir: string; readonly setupIcon: string; readonly packageJSON: Readonly<Record<string, unknown>> }) => { readonly file: string; readonly args: readonly string[] };
};
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const options = { packagedDir: path.join('Fiction', 'out', 'package', '発注書管理-win32-x64'), makeDir: path.join('Fiction', 'out', 'make'), setupIcon: path.join('Fiction', 'icon.ico'), packageJSON: { productName: '発注書管理', version: '0.2.0', author: '架空プロジェクト' } };

it('passes the packaged app and the Japanese product name to the installer script', () => {
  const { file, args } = installer.compilerArguments(options);
  const output = path.join('Fiction', 'out', 'make', 'inno-setup', 'x64');
  expect(file).toBe(path.join(output, 'PartsOrderManager-0.2.0-Setup.exe'));
  expect(args).toEqual([
    '/Q', `/O${output}`, '/FPartsOrderManager-0.2.0-Setup',
    '/DAppName=発注書管理', '/DAppVersion=0.2.0', '/DFileVersion=0.2.0.0', '/DAppPublisher=架空プロジェクト',
    '/DAppExeName=parts-order-manager.exe', `/DPackagedDir=${options.packagedDir}`, `/DSetupIconFile=${options.setupIcon}`,
    path.resolve('tools/windows-installer.iss'),
  ]);
});

it('refuses installer values the compiler would misread', () => {
  for (const productName of ['発注"書管理', '{app}', '発注\n書管理', '', undefined]) {
    expect(() => installer.compilerArguments({ ...options, packageJSON: { ...options.packageJSON, productName } })).toThrow('AppName');
  }
  expect(installer.fileVersion('1.2.3')).toBe('1.2.3.0');
  for (const version of ['1.2', 'x.1.0', '70000.0.0']) expect(() => installer.fileVersion(version)).toThrow();
});

it('finds Inno Setup 6 in the per-user location and validates an explicit compiler path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'make-installer-'));
  roots.push(root);
  const compiler = path.join(root, 'Programs', 'Inno Setup 6', 'ISCC.exe');
  expect(installer.findCompiler({ LOCALAPPDATA: root })).toBeUndefined();
  await mkdir(path.dirname(compiler), { recursive: true });
  await writeFile(compiler, '');
  expect(installer.findCompiler({ LOCALAPPDATA: root })).toBe(compiler);
  expect(installer.findCompiler({ PARTS_ORDER_ISCC: compiler })).toBe(compiler);
  expect(installer.findCompiler({ PARTS_ORDER_ISCC: path.join(root, 'missing', 'ISCC.exe') })).toBeUndefined();
  expect(() => installer.findCompiler({ PARTS_ORDER_ISCC: 'ISCC.exe' })).toThrow();
  expect(() => installer.findCompiler({ PARTS_ORDER_ISCC: path.join(root, 'other.exe') })).toThrow();
});

it('keeps the shortcut AppUserModelID, executable name and version in step with the app', async () => {
  const script = await readFile('tools/windows-installer.iss', 'utf8');
  const id = /#define AppUserModelId "([^"]+)"/.exec(script)?.[1];
  expect(id).toBeTruthy();
  expect(await readFile('src-tauri/src/win.rs', 'utf8')).toContain(`SetCurrentProcessExplicitAppUserModelID(&HSTRING::from("${String(id)}"))`);
  const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')) as { mainBinaryName: string; version: string; productName: string };
  const packageJSON = JSON.parse(await readFile('package.json', 'utf8')) as { version: string; productName: string };
  expect(`${config.mainBinaryName}.exe`).toBe(installer.EXE);
  // 版は package.json だけを正とする（tauri.conf.json は参照、Cargo.toml との一致は version-source.test.ts）。
  expect(config.version).toBe('../package.json');
  expect(config.productName).toBe(packageJSON.productName);
  expect(/^version = "([^"]+)"/m.exec(await readFile('src-tauri/Cargo.toml', 'utf8'))?.[1]).toBe(packageJSON.version);
  // 旧 Electron 版と同じインストール先を使うため、AppId は変えない。
  expect(script).toContain('AppId={{2A828729-E846-49AD-AC60-711CE689FCC2}');
});
