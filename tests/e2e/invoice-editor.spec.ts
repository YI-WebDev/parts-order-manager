import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { capture, fixture, subject } from './app';
import type { TestApp } from './app';
import { evidencePath } from './evidence';

/** app.ts の prepare(...).run・get・all は引数の型が never[] で値を渡せないため、ここで型を合わせる。 */
const values = (...items: (string | number | null)[]): never[] => items as never[];

async function startInvoice(page: Page): Promise<void> {
  await page.getByRole('button', { name: '請求書', exact: true }).click();
  await page.getByRole('button', { name: '新規請求書', exact: true }).click();
  await expect(page.getByLabel('管理用タイトル', { exact: true })).toBeVisible();
}
async function saved(page: Page): Promise<void> {
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('status', { name: '保存状態' })).toHaveText('保存済み');
}
function checkRadio(page: Page, line: number, name: string) {
  return page.getByRole('radiogroup', { name: `明細${line} チェック状態`, exact: true }).getByRole('radio', { name, exact: true });
}
async function shutdown(application: TestApp): Promise<void> {
  await application.close();
}

test('invoice snapshots survive edits restart and duplication without touching material originals', async () => {
  test.setTimeout(90_000);
  const f = await fixture(Buffer.alloc(0)); let application = await f.launch();
  try {
    let page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    const categoryId = randomUUID(), materialId = randomUUID(), db = f.database();
    try {
      db.prepare('INSERT INTO categories VALUES (?,?,?,?)').run(...values(categoryId, '架空カテゴリ', 0, 1));
      db.prepare('INSERT INTO materials(id,category_id,name,model,manufacturer,quantity,remarks,unit_price,search_text,active,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...values(materialId, categoryId, '架空請求材料', '001-A', '架空社', '02 本', '架空原備考', 'PRIVATE-PRICE-MARKER', '架空請求材料', 1, 1, 'now', 'now'));
    } finally { db.close(); }
    await startInvoice(page);
    await page.getByLabel('管理用タイトル', { exact: true }).fill('架空保存請求書');
    await page.getByLabel('上部欄', { exact: true }).fill('架空上部');
    await saved(page);
    // 追加経路: パレットでクリックして選び「明細に追加」/ パレットでEnterで選び Ctrl+Enter / 明細最終行の検索欄でEnter（ダブルクリック追加は廃止）。
    for (const [index, mode] of ['paletteClick', 'paletteEnter', 'inlineEnter'].entries()) {
      if (mode === 'inlineEnter') {
        const inline = page.getByLabel('材料を検索して明細に追加', { exact: true });
        await inline.fill('架空請求材料');
        await expect(page.getByRole('listbox', { name: '追加する材料の候補' }).getByRole('option')).toHaveCount(1);
        await inline.press('Enter');
      } else {
        await page.keyboard.press('Control+f');
        const palette = page.getByRole('dialog', { name: '材料検索' });
        const input = palette.getByLabel('キーワード', { exact: true });
        await input.fill('架空請求材料');
        await expect(palette.locator('.search-result')).toHaveCount(1);
        const result = palette.locator('.search-result').first();
        if (mode === 'paletteEnter') { await input.press('ArrowDown'); await page.keyboard.press('Enter'); await expect(result).toHaveAttribute('aria-selected', 'true'); await page.keyboard.press('Control+Enter'); }
        else { await result.click(); await expect(result).toHaveAttribute('aria-selected', 'true'); await palette.getByRole('button', { name: /^1件を明細に追加/ }).click(); }
        await expect(palette).toHaveCount(0);
      }
      await expect(page.getByRole('region', { name: '請求書編集' })).toBeVisible();
      await expect(page.getByLabel(`明細${index + 1} 数量`, { exact: true })).toBeFocused();
      await saved(page);
    }
    await expect(page.locator('.line-cap')).toHaveText('3 / 47行');
    await page.getByLabel('明細1 数量', { exact: true }).fill('03 箱');
    await page.getByLabel('明細1 数量', { exact: true }).press('Enter');
    await expect(page.getByLabel('明細2 数量', { exact: true })).toBeFocused();
    await page.getByLabel('明細1 備考', { exact: true }).fill('架空変更備考\n2行目');
    await checkRadio(page, 1, '材料のみ（●）').click();
    await expect(checkRadio(page, 1, '材料のみ（●）')).toHaveAttribute('aria-checked', 'true');
    await page.getByLabel('明細1 型式', { exact: true }).focus();
    await page.keyboard.press('Home'); await page.keyboard.press('Delete');
    await expect(page.locator('.line-cap')).toHaveText('3 / 47行');
    await page.getByLabel('明細1 型式', { exact: true }).fill('001-A');
    await page.getByRole('button', { name: '明細3を削除', exact: true }).click();
    await expect(page.getByRole('button', { name: '戻る', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '明細3を削除', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible(); for (const width of [1280, 768, 375]) await capture(page, 'invoice-delete-confirm', width);
    await page.getByRole('button', { name: '明細を削除', exact: true }).click();
    // 旧「明細1を下へ」→ 並べ替えハンドルで Alt+↓（移動後も同じ明細のハンドルにフォーカス）。
    await page.getByRole('button', { name: '明細1を並べ替え（Alt+↑↓）', exact: true }).focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect(page.getByRole('button', { name: '明細2を並べ替え（Alt+↑↓）', exact: true })).toBeFocused();
    await expect(page.getByLabel('明細2 数量', { exact: true })).toHaveValue('03 箱');
    await saved(page);
    for (const width of [1280, 768, 375]) { await page.locator('.editor-scroll').evaluate(element => { element.scrollTop = 0; }); await capture(page, 'invoice-editor', width); }
    await page.getByLabel('明細2 備考', { exact: true }).scrollIntoViewIfNeeded(); await capture(page, 'invoice-lines', 375);
    await page.setViewportSize({ width: 1280, height: 800 });
    const stored = f.database();
    let originalId: string;
    try {
      const row = stored.prepare('SELECT id FROM documents WHERE title=?').get(...values('架空保存請求書'));
      const id = row?.['id'];
      if (typeof id !== 'string') throw new Error('Missing synthetic document');
      originalId = id;
      expect(stored.prepare('SELECT name,quantity,remarks,unit_price FROM materials WHERE id=?').get(...values(materialId))).toEqual({ name: '架空請求材料', quantity: '02 本', remarks: '架空原備考', unit_price: 'PRIVATE-PRICE-MARKER' });
      stored.prepare('UPDATE materials SET name=?, active=0, revision=2 WHERE id=?').run(...values('後日変更された架空材料', materialId));
    } finally { stored.close(); }
    await shutdown(application); application = await f.launch(); page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: '架空保存請求書', exact: true })).toBeVisible();
    for (const width of [1280, 768, 375]) await capture(page, 'invoice-history', width);
    await page.getByRole('article', { name: '架空保存請求書' }).getByRole('button', { name: /を開く$/ }).click();
    await expect(page.getByLabel('明細2 数量', { exact: true })).toHaveValue('03 箱');
    await expect(page.getByLabel('明細2 品名', { exact: true })).toHaveValue('架空請求材料');
    await expect(checkRadio(page, 2, '材料のみ（●）')).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: '請求書', exact: true }).click();
    await page.getByRole('article', { name: '架空保存請求書' }).getByRole('button', { name: /のその他の操作$/ }).click(); await page.getByRole('article', { name: '架空保存請求書' }).getByRole('menuitem', { name: '複製して編集', exact: true }).click();
    await page.getByLabel('管理用タイトル', { exact: true }).fill('架空複製請求書'); await saved(page);
    const copied = f.database();
    try {
      expect(copied.prepare('SELECT title FROM documents WHERE id=?').get(...values(originalId))).toEqual({ title: '架空保存請求書' });
      expect(copied.prepare('SELECT duplicated_from_id FROM documents WHERE title=?').get(...values('架空複製請求書'))).toEqual({ duplicated_from_id: originalId });
      expect(copied.prepare('SELECT COUNT(*) AS count FROM document_lines').get()).toEqual({ count: 4 });
      expect(copied.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally { copied.close(); }
    await capture(page, 'invoice-duplicated');
    await writeFile(evidencePath('invoice-workflow.json'), JSON.stringify({ ...subject(), synthetic: true, addModes: ['paletteClick', 'paletteEnter', 'inlineEnter'], textDeleteDidNotRemoveLine: true, materialMasterUnchangedByInvoice: true, materialLaterInactiveSnapshotPreserved: true, restarted: true, duplicatedWithoutChangingOriginal: true }, null, 2));
  } finally { await shutdown(application); await f.cleanup(); }
});

test('invoice failure keeps input and navigation choices wait for a successful retry', async () => {
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow(); await startInvoice(page);
    await page.getByLabel('管理用タイトル', { exact: true }).fill('架空保存前'); await saved(page);
    const db = f.database(); try { db.exec("CREATE TRIGGER fail_invoice BEFORE UPDATE ON documents BEGIN SELECT RAISE(ABORT,'synthetic blocked write'); END"); } finally { db.close(); }
    await page.getByLabel('管理用タイトル', { exact: true }).fill('架空失敗中の最新入力');
    await page.keyboard.press('Control+s');
    await expect(page.getByRole('status', { name: '保存状態' })).toHaveText('保存失敗');
    await expect(page.getByLabel('管理用タイトル', { exact: true })).toHaveValue('架空失敗中の最新入力');
    for (const width of [1280, 375]) await capture(page, 'invoice-save-error', width);
    await page.getByRole('button', { name: '請求書', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '未保存の変更があります' })).toBeVisible();
    for (const width of [1280, 768, 375]) await capture(page, 'invoice-unsaved-guard', width);
    await page.getByRole('button', { name: '保存して続ける', exact: true }).click();
    await expect(page.getByRole('region', { name: '請求書編集' })).toBeVisible();
    
    await expect(page.getByLabel('管理用タイトル', { exact: true })).toHaveValue('架空失敗中の最新入力');
    const recovery = f.database(); try { recovery.exec('DROP TRIGGER fail_invoice'); } finally { recovery.close(); }
    const dialog = page.getByRole('dialog', { name: '未保存の変更があります' });
    // 保存に失敗した「保存して続ける」では確認ダイアログは閉じ、編集画面に留まる（guard() が false を返す）。
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: '保存を再試行', exact: true }).click();
    await expect(page.getByRole('status', { name: '保存状態' })).toHaveText('保存済み');
    await page.getByLabel('管理用タイトル', { exact: true }).fill('破棄する架空編集');
    await page.getByRole('button', { name: '請求書', exact: true }).click();
    await page.getByRole('button', { name: '未保存分を破棄', exact: true }).click();
    await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: '架空失敗中の最新入力', exact: true })).toBeVisible();
    await capture(page, 'invoice-retry-history');
  } finally { await shutdown(application); await f.cleanup(); }
});

test('invoice delayed success never overwrites newer edits and close waits for the latest save', async () => {
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow(); await startInvoice(page);
    // 本物の保存処理を通した後、毎回の応答を test:invoice:release まで保留する。
    await application.intercept('documents:save', { hold: 'test:invoice:release' });
    await page.getByLabel('管理用タイトル', { exact: true }).fill('遅延前の架空入力'); await page.keyboard.press('Control+s');
    await expect.poll(() => application.count('test:invoice:release')).toBe(1);
    await page.getByLabel('管理用タイトル', { exact: true }).fill('遅延中の最新架空入力'); await page.keyboard.press('Control+s');
    await expect(page.getByRole('status', { name: '保存状態' })).toHaveText('保存中…'); for (const width of [1280, 768, 375]) await capture(page, 'invoice-saving', width);
    await application.release('test:invoice:release');
    await expect.poll(() => application.count('test:invoice:release')).toBe(1);
    await expect(page.getByLabel('管理用タイトル', { exact: true })).toHaveValue('遅延中の最新架空入力');
    await expect(page.getByRole('status', { name: '保存状態' })).not.toHaveText('保存済み');
    await application.requestClose();
    await expect(page.getByRole('dialog', { name: '未保存の変更があります' })).toBeVisible();
    await page.getByRole('button', { name: '戻る', exact: true }).click();
    await application.release('test:invoice:release');
    await expect(page.getByRole('status', { name: '保存状態' })).toHaveText('保存済み');
    const db = f.database(); try { expect(db.prepare('SELECT title, revision FROM documents').get()).toEqual({ title: '遅延中の最新架空入力', revision: 2 }); } finally { db.close(); }
    await writeFile(evidencePath('invoice-delayed.json'), JSON.stringify({ ...subject(), synthetic: true, mainSaveHandlerPreserved: true, responseDeliveryInstrumented: true, newInputPreserved: true, revision: 2, closeCancelledDuringPendingSave: true, realOsIme: false }, null, 2));
  } finally { await shutdown(application); await f.cleanup(); }
});
