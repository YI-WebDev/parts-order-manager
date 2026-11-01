import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launch, openDatabase, subject } from './app';
import { evidencePath } from './evidence';

/** app.ts の prepare(...).run・get・all は引数の型が never[] で値を渡せないため、ここで型を合わせる。 */
const values = (...items: (string | number | null)[]): never[] => items as never[];

// 旧版は Electron の Main プロセスで better-sqlite3（ネイティブモジュール）を読み込み、Electron・ABI・N-API の版と .node の SHA-256 を確かめていた。
// アプリ版の SQLite はアプリ本体（Rust の pom-core、rusqlite）に組み込まれ、別のネイティブモジュールを読み込まないため、これらの確認は当てはまらない。
// 代わりに、アプリ本体が作ったDBをテスト側（node:sqlite）から読み書きし、再起動後にアプリ本体がその内容を読めることを確かめる。
test('native SQLite reads, writes and survives a complete app restart', async () => {
  test.setTimeout(60_000);
  const profile = await mkdtemp(path.join(os.tmpdir(), 'pom-e2e-native-'));
  if (path.dirname(profile) !== path.resolve(os.tmpdir()) || !path.basename(profile).startsWith('pom-e2e-native-')) throw new Error('Unexpected fixture root');
  const file = path.join(profile, 'database/app.sqlite');
  try {
    const first = await launch(profile);
    let firstResult: unknown;
    try {
      await expect((await first.firstWindow()).getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
      const db = openDatabase(file);
      try {
        const empty = db.prepare('SELECT count(*) AS n FROM materials').get();
        db.prepare('INSERT INTO categories VALUES (?, ?, ?, ?)').run(...values('123e4567-e89b-42d3-a456-426614174000', '架空native再起動', 0, 1));
        db.prepare('INSERT INTO import_batches VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(...values(randomUUID(), randomUUID(), null, 'initial', 'a'.repeat(64), 'synthetic.xlsx', '1', 'failed', '[]', '{}', '{}', 'fixture'));
        firstResult = { schemaVersion: db.prepare('PRAGMA user_version').get()?.['user_version'], empty };
      } finally { db.close(); }
      expect(firstResult).toEqual({ schemaVersion: 4, empty: { n: 0 } });
    } finally { await first.close(); }
    const second = await launch(profile);
    try {
      const page = await second.firstWindow();
      await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
      const db = openDatabase(file);
      let persisted: unknown;
      try { persisted = { row: db.prepare('SELECT name FROM categories').get(), batch: db.prepare('SELECT status FROM import_batches').get(), integrity: db.integrity(), history: db.prepare('SELECT count(*) AS n FROM schema_migrations').get() }; }
      finally { db.close(); }
      expect(persisted).toEqual({ row: { name: '架空native再起動' }, batch: { status: 'failed' }, integrity: 'ok', history: { n: 4 } });
      // 再起動したアプリ本体の SQLite も、前回書いた分類を読める（旧版の「パッケージ内のネイティブモジュールで読める」に当たる確認）。
      const form = await page.evaluate(() => window.appApi.master.get(null));
      expect(form.status === 'ok' ? form.data.categories.map(category => category.name) : form).toEqual(['架空native再起動']);
      await mkdir(path.dirname(evidencePath('native.json')), { recursive: true });
      await writeFile(evidencePath('native.json'), JSON.stringify({ ...subject(), first: firstResult, restart: persisted }, null, 2));
    } finally { await second.close(); }
  } finally { await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
});
