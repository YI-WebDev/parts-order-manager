// 第三者ソフトウェアのライセンス表記（THIRD-PARTY-NOTICES.txt）を作る: pnpm notices
// 対象: 配布する実行ファイル（Windows 版 parts-order-manager.exe）に組み込まれる Rust のクレートと、画面に同梱される npm パッケージ。
// クレートの一覧は cargo tree（通常の依存・Windows 向け、手続きマクロを除く）、ライセンス文はクレートに同梱のファイルから取る。
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'src-tauri', 'Cargo.toml');
const OWN = new Set(['parts-order-manager', 'pom-core']);
const NPM = ['react', 'react-dom', 'scheduler', '@tauri-apps/api', 'tailwindcss'];

const run = (command, args) => execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function crates() {
  const tree = run('cargo', ['tree', '--manifest-path', MANIFEST, '-p', 'parts-order-manager', '-e', 'normal', '--target', 'x86_64-pc-windows-msvc', '--prefix', 'none', '--format', '{p}']);
  const names = new Set();
  for (const line of tree.split('\n')) {
    if (!line.trim() || line.includes('(proc-macro)')) continue;
    const [name, version] = line.replace(' (*)', '').trim().split(' ');
    if (name && version && !OWN.has(name)) names.add(`${name} ${version.replace(/^v/, '')}`);
  }
  const metadata = JSON.parse(run('cargo', ['metadata', '--manifest-path', MANIFEST, '--format-version', '1', '--filter-platform', 'x86_64-pc-windows-msvc']));
  const byKey = new Map(metadata.packages.map(p => [`${p.name} ${p.version}`, p]));
  return [...names].sort((a, b) => a.localeCompare(b, 'en')).map(key => {
    const info = byKey.get(key);
    if (!info) throw new Error(`Missing metadata for ${key}`);
    return { key, license: info.license ?? info.license_file ?? 'UNKNOWN', repository: info.repository ?? '', directory: path.dirname(info.manifest_path), licenseFile: info.license_file };
  });
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense)([-._].*)?$/i;
function licenseTexts(directory, extra) {
  const files = readdirSync(directory).filter(name => LICENSE_FILE.test(name) && !name.endsWith('.spdx')).sort();
  if (extra && !files.includes(extra)) files.push(extra);
  return files.map(name => path.join(directory, name)).filter(file => existsSync(file)).map(file => readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim());
}

const MICROSOFT_WEBVIEW2 = `Copyright (C) Microsoft Corporation. All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted
provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this list of conditions
  and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright notice, this list of conditions
  and the following disclaimer in the documentation and/or other materials provided with the distribution.
* The name of Microsoft Corporation, or the names of its contributors may not be used to endorse or promote products
  derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE
USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

function main() {
  const groups = new Map();
  const add = (owner, texts) => { for (const text of texts) { const users = groups.get(text) ?? []; users.push(owner); groups.set(text, users); } };
  const list = crates();
  const missing = [];
  for (const crate of list) {
    const texts = licenseTexts(crate.directory, crate.licenseFile);
    if (texts.length === 0) missing.push(crate);
    add(crate.key, texts);
  }
  const npm = NPM.map(name => {
    const directory = path.join(ROOT, 'node_modules', name);
    const info = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const key = `${name} ${info.version}`;
    add(key, licenseTexts(directory));
    return { key, license: info.license ?? 'UNKNOWN' };
  });
  add('Microsoft Edge WebView2 SDK（WebView2LoaderStatic.lib。webview2-com-sys が同梱し、実行ファイルに静的リンク）', [MICROSOFT_WEBVIEW2]);

  const lines = [
    '発注書管理（Tauri / WebView2 版） 第三者ソフトウェアのライセンス表記 / Third-party notices',
    '',
    'この実行ファイルには、以下のオープンソースソフトウェアが含まれています。各ライセンスの全文は後半にあります。',
    '画面の表示には Windows に含まれる Microsoft Edge WebView2 ランタイムを使います（同梱していません）。',
    'SQLite（libsqlite3-sys が同梱するソース）はパブリックドメインです。',
    'MPL-2.0 のクレートは改変せずに使っています。ソースコードは一覧の各リポジトリ（または crates.io の同じ版）から入手できます。',
    '',
    '== Rust crates ==',
    ...list.map(c => `${c.key} — ${c.license}${c.repository ? ` — ${c.repository}` : ''}`),
    '',
    '== npm packages (screen) ==',
    ...npm.map(p => `${p.key} — ${p.license}`),
    '',
    '== License texts ==',
  ];
  for (const [text, users] of groups) {
    lines.push('', '='.repeat(78), `Used by: ${users.join(', ')}`, '-'.repeat(78), text);
  }
  if (missing.length) {
    lines.push('', '='.repeat(78), 'The following crates do not ship a license file; their license is given by the SPDX expression above:', ...missing.map(c => `${c.key} — ${c.license}${c.repository ? ` — ${c.repository}` : ''}`));
  }
  lines.push('', '='.repeat(78), readFileSync(path.join(ROOT, 'tools', 'notices-derived.txt'), 'utf8').trim(), '');
  writeFileSync(path.join(ROOT, 'THIRD-PARTY-NOTICES.txt'), lines.join('\n'));
  console.log(`THIRD-PARTY-NOTICES.txt: ${list.length} crates, ${npm.length} npm packages, ${groups.size} license texts${missing.length ? `, ${missing.length} without a license file` : ''}`);
}

main();
