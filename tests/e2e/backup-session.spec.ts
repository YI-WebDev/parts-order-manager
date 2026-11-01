import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fixture } from './app';
import type { SaveDocument } from '../../src/shared/document-api';

test('restore terminates the old session and rejects its delayed save after restart', async () => {
  const f = await fixture(Buffer.alloc(0)); let app = await f.launch();
  try {
    let page = await app.firstWindow(); await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    const target = path.join(f.root, 'session.pombak');
    await app.dialogs(target, 1);
    const old = await page.evaluate(() => window.appApi.documents.open(null)); if (old.status !== 'ok') throw new Error('session');
    const request: SaveDocument = { sessionId: old.data.sessionId, requestNumber: 1, generation: 1, expectedRevision: 0, draft: { ...old.data.draft, title: '復元前の遅延要求' } };
    expect((await page.evaluate(() => window.appApi.backups.create())).status).toBe('ok');
    const inspection = await page.evaluate(() => window.appApi.backups.inspect()); if (inspection.status !== 'ok') throw new Error('inspection');
    const closed = app.waitForExit();
    await page.evaluate(id => window.appApi.backups.restore(id), inspection.data.id).catch(() => undefined); await closed;
    await app.close(); app = await f.launch(); page = await app.firstWindow(); await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    expect((await page.evaluate(value => window.appApi.documents.save(value), request)).status).toBe('error');
    const db = f.database(); expect(db.prepare('SELECT count(*) AS n FROM documents').get()).toEqual({ n: 0 }); db.close();
    await page.getByRole('button', { name: '新規請求書', exact: true }).click();
    await page.getByLabel('管理用タイトル', { exact: true }).fill('復元後の新規編集'); await page.keyboard.press('Control+s');
    await expect(page.getByRole('status', { name: '保存状態' })).toHaveText('保存済み');
  } finally { await app.close(); await f.cleanup(); }
});

test('unsaved discard on settings navigation excludes pending text from backup', async () => {
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow(); await page.clock.install({ time: 0 }); await page.clock.pauseAt(1000);
    await page.getByRole('button', { name: '新規請求書', exact: true }).click();
    await page.getByLabel('管理用タイトル', { exact: true }).fill('保存済みA'); await page.keyboard.press('Control+s');
    await expect(page.getByRole('status', { name: '保存状態' })).toHaveText('保存済み');
    await page.getByLabel('管理用タイトル', { exact: true }).fill('破棄するB');
    await page.getByRole('button', { name: '設定', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '未保存の変更があります' })).toBeVisible();
    await page.getByRole('button', { name: '未保存分を破棄', exact: true }).click();
    await expect(page.getByRole('heading', { name: '設定', exact: true })).toBeVisible();
    const target = path.join(f.root, 'discard.pombak');
    await app.dialog('save', target);
    const panel = page.getByRole('region', { name: 'バックアップと復元', exact: true });
    await panel.getByRole('button', { name: '今すぐ保存', exact: true }).click();
    await expect(panel.locator('p.notice[role="status"]')).toContainText('バックアップを保存しました');
    const db = f.database(); expect(db.prepare('SELECT title,revision FROM documents').all()).toEqual([{ title: '保存済みA', revision: 1 }]); db.close();
  } finally { await app.close(); await f.cleanup(); }
});
