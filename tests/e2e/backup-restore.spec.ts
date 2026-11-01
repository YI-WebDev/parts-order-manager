import { expect, test } from '@playwright/test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { capture, fixture, expectKeyboardFocus, subject, target as testTarget } from './app';
import type { TestApp } from './app';
import { evidencePath } from './evidence';
import { syntheticWorkbook } from '../fixtures/xlsx';

async function shutdown(app: TestApp): Promise<void> { await app.close(); }
async function dialogs(app: TestApp, file: string | null, response = 0): Promise<void> { await app.dialogs(file, response); }
/** app.ts の prepare(...).run・get・all は引数の型が never[] で値を渡せないため、ここで型を合わせる。 */
const values = (...items: (string | number | null)[]): never[] => items as never[];
const tables = ['categories', 'materials', 'documents', 'document_lines', 'import_batches', 'import_items', 'import_decisions', 'settings', 'material_create_receipts', 'schema_migrations'] as const;
function rows(f: Awaited<ReturnType<typeof fixture>>): Record<string, unknown> {
  const db = f.database();
  try { return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])); }
  finally { db.close(); }
}
async function evidence(name: string, detail: Record<string, unknown>): Promise<void> {
  await writeFile(evidencePath(`${name}.json`), JSON.stringify({ ...subject(), fictionalIsolatedData: true, realAppWindow: testTarget === 'webview2', osDialogsMocked: true, realOsIme: false, ...detail }, null, 2));
}

test('backup UI restores raw history snapshots held rows and creation receipts after restart', async () => {
  test.setTimeout(120_000);
  const f = await fixture(syntheticWorkbook()); let app = await f.launch();
  try {
    let page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    await dialogs(app, f.source);
    const seeded = await page.evaluate(async () => {
      const imported = await window.appApi.imports.choose();
      if (imported.status !== 'ok') throw new Error('Synthetic import preview failed');
      const applied = await window.appApi.imports.apply({ batchId: imported.data.batch.id, acceptedIds: imported.data.items.filter(item => item.classification === 'candidate').map(item => item.id) });
      if (applied.status !== 'ok') throw new Error('Synthetic import apply failed');
      const form = await window.appApi.master.get(null);
      if (form.status !== 'ok' || !form.data.createRequestId) throw new Error('Synthetic new material failed');
      const material = await window.appApi.master.save({ createRequestId: form.data.createRequestId, id: null, expectedRevision: 0, categoryId: null, newCategoryName: '架空手動分類', active: true, values: { name: ' 架空復元材料 ', model: '0001-A', manufacturer: '架空社', quantity: '00 本', remarks: '空白 \n改行', unitPrice: '0' } });
      if (material.status !== 'ok') throw new Error('Synthetic material save failed');
      const session = await window.appApi.documents.open(null);
      if (session.status !== 'ok') throw new Error('Synthetic document failed');
      const line = await window.appApi.documents.addLine({ sessionId: session.data.sessionId, materialId: material.data.id });
      if (line.status !== 'ok') throw new Error('Synthetic snapshot failed');
      const saved = await window.appApi.documents.save({ sessionId: session.data.sessionId, requestNumber: 1, generation: 1, expectedRevision: 0, draft: { ...session.data.draft, title: '架空復元請求書', lines: [line.data] } });
      if (saved.status !== 'ok') throw new Error('Synthetic document save failed');
      return { materialId: material.data.id, categoryId: material.data.categoryId };
    });
    const settings = f.database(); try { settings.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run(...values('last_category_id', seeded.categoryId)); } finally { settings.close(); }
    const baseline = rows(f);
    expect(baseline['material_create_receipts']).toHaveLength(1); expect(baseline['document_lines']).toHaveLength(1);
    const target = path.join(f.root, 'fictional.pombak'); await dialogs(app, target);
    await page.getByRole('button', { name: '設定', exact: true }).click();
    const panel = page.getByRole('region', { name: 'バックアップと復元', exact: true }), feedback = panel.locator('p.notice[role="status"]');
    const save = panel.getByRole('button', { name: '今すぐ保存', exact: true });
    await save.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); await expectKeyboardFocus(save);
    for (const width of [1280, 768, 375]) { await save.scrollIntoViewIfNeeded(); await capture(page, 'backup-settings', width); }
    await save.click(); await expect(feedback).toContainText('バックアップを保存しました'); await capture(page, 'backup-saved', 375);
    const changed = f.database(); try { changed.prepare('UPDATE materials SET name=?, revision=revision+1 WHERE id=?').run(...values('バックアップ後の架空変更', seeded.materialId)); changed.prepare('UPDATE documents SET title=?').run(...values('バックアップ後の架空請求書')); } finally { changed.close(); }
    const later = rows(f);
    await panel.getByRole('button', { name: 'ファイルを選んで検査', exact: true }).click();
    await expect(panel.getByRole('heading', { name: '検査したバックアップ' })).toBeVisible();
    for (const width of [1280, 768, 375]) { await page.getByRole('heading', { name: '検査したバックアップ' }).scrollIntoViewIfNeeded(); await capture(page, 'backup-inspection', width); }
    await page.getByRole('button', { name: 'このバックアップへ復元', exact: true }).click();
    await expect(feedback).toContainText('取り消しました'); expect(rows(f)).toEqual(later); await capture(page, 'backup-restore-cancelled', 375);
    await dialogs(app, target, 1);
    const exited = app.waitForExit();
    await page.getByRole('button', { name: 'このバックアップへ復元', exact: true }).click(); await exited;
    await shutdown(app); app = await f.launch(); page = await app.firstWindow(); await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    expect(rows(f)).toEqual(baseline);
    await page.getByRole('button', { name: '請求書', exact: true }).click(); await page.getByRole('article', { name: '架空復元請求書', exact: true }).getByRole('button', { name: /を開く$/ }).click();
    await expect(page.getByLabel('明細1 型式', { exact: true })).toHaveValue('0001-A'); await expect(page.getByLabel('明細1 備考', { exact: true })).toHaveValue('空白 \n改行'); await capture(page, 'backup-restored-document');
    const retained = (await readdir(f.profile)).filter(name => name.startsWith('database-before-')); expect(retained).toHaveLength(1);
    await evidence('backup-restore-workflow', { allTablesEqual: tables, snapshotOriginalExpression: true, cancelledRestoreKeptLaterState: true, restarted: true, retainedOldDatabaseDirectory: true });
  } finally { await shutdown(app); await f.cleanup(); }
});

test('backup cancel existing file malformed input and write failure preserve live state', async () => {
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow(); await page.getByRole('button', { name: '設定', exact: true }).click(); const baseline = rows(f);
    const panel = page.getByRole('region', { name: 'バックアップと復元', exact: true }), feedback = panel.locator('p.notice[role="status"]');
    const save = panel.getByRole('button', { name: '今すぐ保存', exact: true });
    await dialogs(app, null); await save.click(); await expect(feedback).toContainText('取り消しました');
    const target = path.join(f.root, 'existing.pombak'); await writeFile(target, 'FICTIONAL-KEEP'); await dialogs(app, target); await save.click(); await expect(panel.getByRole('alert')).toContainText('上書きしません'); expect(await readFile(target, 'utf8')).toBe('FICTIONAL-KEEP');
    await panel.getByRole('button', { name: 'ファイルを選んで検査', exact: true }).click(); await expect(panel.getByRole('alert')).toBeVisible(); await expect(page.getByRole('button', { name: 'このバックアップへ復元' })).toHaveCount(0);
    for (const width of [1280, 768, 375]) { await panel.getByRole('alert').scrollIntoViewIfNeeded(); await capture(page, 'backup-invalid', width); }
    const fresh = path.join(f.root, 'write-failure.pombak'); await dialogs(app, fresh);
    // 旧版は次の fs.writeFileSync を1回だけ失敗させていた。アプリ版は出力ファイルの書込を1回だけ失敗させる。
    await app.fault('write');
    await save.click(); await expect(panel.getByRole('alert')).toBeVisible();
    // 直前の検査の alert が残っているため、注入した失敗が実際に使われたことも確かめる（旧版の fs の差し替えは同期で失敗していた）。
    await expect.poll(async () => (await app.events()).filter(event => event.type === 'fault').map(event => event['point'])).toEqual(['write']);
    expect((await readdir(f.root)).includes('write-failure.pombak')).toBe(false); expect(rows(f)).toEqual(baseline);
    await save.click(); await expect(feedback).toContainText('バックアップを保存しました');
    await evidence('backup-rejections', { cancelled: true, existingFilePreserved: true, malformedRejected: true, writeFailurePreservedDatabase: true, retrySucceeded: true });
  } finally { await shutdown(app); await f.cleanup(); }
});

test('pending import dialog prevents restore and released request cannot silently switch databases', async () => {
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow(); await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    const target = path.join(f.root, 'gate.pombak'); await dialogs(app, target);
    expect((await page.evaluate(() => window.appApi.backups.create())).status).toBe('ok');
    const inspected = await page.evaluate(() => window.appApi.backups.inspect()); if (inspected.status !== 'ok') throw new Error('Synthetic backup inspection failed');
    const baseline = rows(f);
    // ファイル選択を release まで開いたままにし、閉じたら取消を返す。
    await app.dialog('open', null, 'test:backup-release-dialog');
    await page.evaluate(() => { void window.appApi.imports.choose().then(result => Reflect.set(window, 'pendingImportResult', result)); });
    await expect.poll(() => app.count('test:backup-release-dialog')).toBe(1);
    expect((await page.evaluate(id => window.appApi.backups.restore(id), inspected.data.id)).status).toBe('error'); expect(rows(f)).toEqual(baseline);
    await app.release('test:backup-release-dialog');
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'pendingImportResult'))).toEqual({ status: 'cancelled' });
    await dialogs(app, target, 0); expect((await page.evaluate(id => window.appApi.backups.restore(id), inspected.data.id)).status).toBe('cancelled'); expect(rows(f)).toEqual(baseline);
    await evidence('backup-pending-gate', { pendingImportRejectedRestore: true, cancelledImportSettled: true, gateReleasedForNextOperation: true, databaseUnchanged: true });
  } finally { await shutdown(app); await f.cleanup(); }
});
