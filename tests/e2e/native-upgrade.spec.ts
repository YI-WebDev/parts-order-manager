import { expect, test } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { launch, openDatabase, subject } from './app';
import { evidencePath } from './evidence';

/** app.ts の prepare(...).run・get・all は引数の型が never[] で値を渡せないため、ここで型を合わせる。 */
const values = (...items: (string | number | null)[]): never[] => items as never[];
/** 読み取り専用で開く（旧版の better-sqlite3 の { readonly: true, fileMustExist: true }。app.ts の openDatabase は読み書き用のため）。 */
function readonly(file: string) { return new DatabaseSync(file, { readOnly: true }); }
function pragma(db: DatabaseSync, name: string): unknown { return db.prepare(`PRAGMA ${name}`).get()?.[name]; }

test('app migrates a referenced version1 database and preserves its backup', async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'pom-e2e-upgrade-'));
  if (path.dirname(profile) !== path.resolve(os.tmpdir()) || !path.basename(profile).startsWith('pom-e2e-upgrade-')) throw new Error('Unexpected fixture root');
  const directory = path.join(profile, 'database');
  await mkdir(directory);
  const file = path.join(directory, 'app.sqlite');
  // 移行SQLは旧版の src/main/db/migrations からアプリ本体（pom-core）へ移った。
  const sql = await readFile('src-tauri/core/migrations/0001.sql', 'utf8');
  const hash = createHash('sha256').update(sql.replaceAll('\r\n', '\n')).digest('hex');
  const batch = randomUUID();
  const item = randomUUID();
  const old = openDatabase(file);
  try {
    old.exec('PRAGMA foreign_keys=ON');
    old.exec(sql);
    old.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(...values(1, hash));
    old.exec('PRAGMA application_id=1347374385');
    old.exec('PRAGMA user_version=1');
    old.prepare('INSERT INTO import_batches VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(...values(batch, randomUUID(), null, 'initial', 'a'.repeat(64), 'synthetic.xlsx', '1', 'preview', '[]', '{}', '{}', 'fixture'));
    old.prepare('INSERT INTO import_items VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(...values(item, batch, 'row', '架空シート', 0, 3, 'left', 'A3', '{"A":{"displayText":" 001 "}}', 'review', 'fixture'));
  } finally { old.close(); }
  try {
    const app = await launch(profile);
    try {
      await expect((await app.firstWindow()).getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
      const updated = openDatabase(file);
      try {
        expect(updated.prepare('PRAGMA user_version').get()?.['user_version']).toBe(4);
        expect(updated.prepare('SELECT hash FROM schema_migrations WHERE version=1').get()).toEqual({ hash });
        expect(updated.prepare('SELECT batch_id, raw_cells FROM import_items WHERE id=?').get(...values(item))).toEqual({ batch_id: batch, raw_cells: '{"A":{"displayText":" 001 "}}' });
        expect(updated.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        updated.prepare('UPDATE import_batches SET status=? WHERE id=?').run(...values('failed', batch));
      } finally { updated.close(); }
    } finally { await app.close(); }
    const restarted = await launch(profile);
    try {
      await expect((await restarted.firstWindow()).getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
      const current = readonly(file);
      try { expect(current.prepare('SELECT status FROM import_batches WHERE id=?').get(batch)).toEqual({ status: 'failed' }); }
      finally { current.close(); }
      const backups = await readdir(path.join(directory, 'migration-backups'));
      expect(backups).toHaveLength(1);
      const backup = readonly(path.join(directory, 'migration-backups', backups[0] ?? '', 'before.sqlite'));
      try {
        expect(pragma(backup, 'user_version')).toBe(1);
        expect(backup.prepare('SELECT status FROM import_batches WHERE id=?').get(batch)).toEqual({ status: 'preview' });
        expect(backup.prepare('SELECT count(*) AS n FROM import_items').get()).toEqual({ n: 1 });
        expect(pragma(backup, 'integrity_check')).toBe('ok');
      } finally { backup.close(); }
      await mkdir(path.dirname(evidencePath('native-upgrade.json')), { recursive: true });
      await writeFile(evidencePath('native-upgrade.json'), JSON.stringify({ ...subject(), from: 1, to: 2, originalHistoryHash: hash, rawItemPreserved: true, backupVersion: 1, restartStatus: 'failed' }, null, 2));
    } finally { await restarted.close(); }
  } finally { await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
});
