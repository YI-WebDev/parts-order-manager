import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, subject } from './app';
import { evidencePath } from './evidence';

/** app.ts の prepare(...).run・get・all は引数の型が never[] で値を渡せないため、ここで型を合わせる。 */
const values = (...items: (string | number | null)[]): never[] => items as never[];

for (const point of ['retained', 'installed', 'committed'] as const) {
  test(`abrupt process exit at restore ${point} recovers consistently`, async () => {
    test.setTimeout(90_000);
    const f = await fixture(Buffer.alloc(0));
    let application = await f.launch();
    try {
      const page = await application.firstWindow();
      await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
      const target = path.join(f.root, 'fictional.pombak');
      let db = f.database();
      db.prepare('INSERT INTO categories VALUES (?,?,?,?)').run(...values('fictional', 'バックアップ時点', 0, 1)); db.close();
      await application.dialog('save', target);
      expect((await page.evaluate(() => window.appApi.backups.create())).status).toBe('ok');
      db = f.database(); db.prepare('UPDATE categories SET name=?').run(...values('復元直前保持')); db.close();
      await application.dialog('open', target);
      await application.dialog('message', 1);
      const inspected = await page.evaluate(() => window.appApi.backups.inspect());
      if (inspected.status !== 'ok') throw new Error('Inspection failed');
      // 旧版は fs.rename の直後に process.exit(77) していた。アプリ版は復元の各段階（src-tauri/core/src/backups.rs の begin_restore）で同じく終了させる。
      // retained: 現在のDBを database-before-<id> へ退避した直後、installed: 候補を database へ移した直後、committed: 完了記録を書いた直後。
      await application.fault(`restore:${point}`, { exit: 77 });
      const closed = application.waitForExit();
      await page.evaluate(id => window.appApi.backups.restore(id), inspected.data.id).catch(() => undefined);
      await closed;
      const exitCode = application.processExitCode;
      expect(exitCode).toBe(77);
      await application.close();
      application = await f.launch();
      const reopened = await application.firstWindow();
      await expect(reopened.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
      db = f.database();
      const actual = db.prepare('SELECT name FROM categories').get();
      expect(actual).toEqual({ name: point === 'committed' ? 'バックアップ時点' : '復元直前保持' });
      expect(db.integrity()).toBe('ok'); db.close();
      const info = await reopened.evaluate(() => window.appApi.getInfo());
      expect(info.recoveryNotice).toContain(point === 'committed' ? '復元済み' : '中断した復元');
      await application.close();
      application = await f.launch();
      await expect((await application.firstWindow()).getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
      db = f.database(); expect(db.prepare('SELECT name FROM categories').get()).toEqual(actual); db.close();
      await writeFile(evidencePath(`backup-crash-${point}.json`), JSON.stringify({ ...subject(), point, injectedProcessExit: exitCode, afterRecovery: actual, secondRestart: true, actualOsDialog: false }, null, 2));
    } finally { await application.close(); await f.cleanup(); }
  });
}

test('backup write failure retains existing data and permits retry', async () => {
  const f = await fixture(Buffer.alloc(0)); const application = await f.launch();
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    const target = path.join(f.root, 'failure.pombak');
    await application.dialog('save', target);
    // 旧版は .pombak の内容（先頭が POMBAK01）を書く fs.writeFileSync を1回だけ失敗させていた。アプリ版は出力ファイルの書込を1回だけ失敗させる。
    await application.fault('write');
    expect((await page.evaluate(() => window.appApi.backups.create())).status).toBe('error');
    await expect(readFile(target)).rejects.toThrow();
    expect((await page.evaluate(() => window.appApi.backups.create())).status).toBe('ok');
    const db = f.database(); expect(db.integrity()).toBe('ok'); db.close();
  } finally { await application.close(); await f.cleanup(); }
});
