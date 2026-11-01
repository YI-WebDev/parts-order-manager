import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { allXml, textCell, workbookParts, zipParts } from '../fixtures/xlsx';
import { capture, confirm, fixture, openImport, pick, subject } from './app';
import type { TestApp } from './app';
import { evidencePath } from './evidence';

/** app.ts の prepare(...).run・get・all は引数の型が never[] で値を渡せないため、ここで型を合わせる。 */
const values = (...items: (string | number | null)[]): never[] => items as never[];

/** ウィンドウの「閉じる」（旧版の BrowserWindow.close）で終了し、終了コードを返す。 */
async function normalClose(application: TestApp): Promise<number | null> {
  const exited = application.waitForExit();
  await application.requestClose();
  return exited;
}

test('release workflow imports searches edits saves restarts and exports only the saved snapshot', async () => {
  test.setTimeout(90_000);
  // Given: a fictional workbook with an intentionally unselected material and private price marker.
  const input = zipParts(workbookParts(`<row r="2">${textCell('A2', '架空一貫材料')}${textCell('B2', '0007-A')}${textCell('C2', '架空製造社')}${textCell('D2', '02 本')}${textCell('E2', '原備考')}${textCell('F2', 'PRIVATE-PRICE-RELEASE')}${textCell('H2', 'UNSELECTED-RELEASE-MATERIAL')}${textCell('I2', '009-X')}</row>`));
  const remarks = ['=SUM(1,2)', '架空の出力注記'].join(String.fromCharCode(10));
  const f = await fixture(input);
  let application = await f.launch();
  try {
    let page = await application.firstWindow();
    page.setDefaultTimeout(10_000);
    await test.step('UI initial material import', async () => {
      await openImport(page, 'first');
      await pick(application, page, f.source);
      await expect(page.getByRole('checkbox', { name: /を採用$/, checked: true })).toHaveCount(2);
      await confirm(page);
      await expect(page.getByRole('status').filter({ hasText: '・保留' })).toContainText('反映 2件');
    });
    await test.step('Create invoice and search for imported material', async () => {
      await page.getByRole('button', { name: '請求書', exact: true }).click();
      await page.getByRole('button', { name: '新規請求書', exact: true }).click();
      await page.getByLabel('管理用タイトル', { exact: true }).fill('INTERNAL-RELEASE-TITLE');
      await page.keyboard.press('Control+s');
      await expect(page.getByRole('status', { name: '保存状態' })).toHaveText('保存済み');
      await page.keyboard.press('Control+f');
      await page.getByLabel('キーワード', { exact: true }).fill('0007-A');
      await expect(page.locator('.search-result')).toHaveCount(1);
      await page.locator('.search-result').first().click();
      await page.getByRole('dialog', { name: '材料検索', exact: true }).getByRole('button', { name: /^1件を明細に追加/ }).click();
      await expect(page.getByRole('dialog', { name: '材料検索', exact: true })).toHaveCount(0);
      await expect(page.getByLabel('明細1 数量', { exact: true })).toHaveValue('02 本');
    });
    await page.getByLabel('明細1 数量', { exact: true }).fill('003 箱');
    await page.getByLabel('明細1 備考', { exact: true }).fill(remarks);
    const materialOnly = page.getByRole('radiogroup', { name: '明細1 チェック状態', exact: true }).getByRole('radio', { name: '材料のみ（●）', exact: true });
    await materialOnly.click();
    await expect(materialOnly).toHaveAttribute('aria-checked', 'true');
    // 帳票の上部はExcelプレビューのセルへ直接入力する。
    await page.getByLabel('納期', { exact: true }).fill('2026-10-01');
    await page.keyboard.press('Control+s');
    await expect(page.getByRole('status', { name: '保存状態' })).toHaveText('保存済み');
    const before = await page.evaluate(async () => {
      const list = await window.appApi.documents.list(0);
      if (list.status !== 'ok' || !list.data.items[0]) throw new Error('Saved fictional invoice missing');
      return list.data.items[0];
    });
    await capture(page, 'release-workflow-saved');
    // When: normal window close, relaunch the same isolated profile, reopen and explicitly export.
    const closeExit = await normalClose(application);
    expect(closeExit).toBe(0);
    application = await f.launch(); page = await application.firstWindow();
    await page.getByRole('button', { name: '請求書', exact: true }).click();
    await page.getByRole('article', { name: 'INTERNAL-RELEASE-TITLE', exact: true }).getByRole('button', { name: /を開く$/ }).click();
    await expect(page.getByLabel('明細1 品名', { exact: true })).toHaveValue('架空一貫材料');
    await expect(page.getByLabel('明細1 型式', { exact: true })).toHaveValue('0007-A');
    await expect(page.getByLabel('明細1 数量', { exact: true })).toHaveValue('003 箱');
    await expect(page.getByLabel('明細1 備考', { exact: true })).toHaveValue(remarks);
    const target = path.join(f.root, 'release-workflow.xlsx');
    await application.dialog('save', target);
    await page.getByRole('button', { name: 'Excelへ出力', exact: true }).click();
    await expect(page.getByRole('status', { name: 'Excel出力状態' })).toContainText('をExcelへ出力しました');
    await capture(page, 'release-workflow-exported');
    const after = await page.evaluate(async () => {
      const list = await window.appApi.documents.list(0);
      if (list.status !== 'ok' || !list.data.items[0]) throw new Error('Reopened fictional invoice missing');
      return list.data.items[0];
    });
    // Then: same saved revision and original master, complete text cells, no unused/private package content.
    expect(after.id).toBe(before.id); expect(after.revision).toBe(before.revision);
    const bytes = await readFile(target), parts = await allXml(bytes);
    expect([...parts.keys()].sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'].sort());
    const sheet = parts.get('xl/worksheets/sheet1.xml');
    if (!sheet) throw new Error('Exported worksheet missing');
    // 納期は見本帳票と同じく日付シリアル値（2026-10-01 = 46296、表示は m月d日）。
    expect(sheet).toMatch(/<c r="E4" s="\d+"><v>46296<\/v><\/c>/);
    for (const [ref, value] of Object.entries({ A6: '●', B6: '架空一貫材料', C6: '0007-A', D6: '架空製造社', E6: '003 箱', F6: remarks })) {
      const cellStart = sheet.indexOf('<c r="' + ref + '"');
      const cellEnd = sheet.indexOf('</c>', cellStart);
      const cell = sheet.slice(cellStart, cellEnd);
      expect(cell).toContain('t="inlineStr"');
      expect(cell.slice(cell.indexOf('<t xml:space="preserve">') + '<t xml:space="preserve">'.length, cell.indexOf('</t>')), ref).toBe(value);
    }
    const contents = [...parts.values()].join('\n');
    for (const forbidden of ['PRIVATE-PRICE-RELEASE', 'UNSELECTED-RELEASE-MATERIAL', 'INTERNAL-RELEASE-TITLE', '原備考', f.source, '<f>', 'TargetMode="External"']) expect(contents).not.toContain(forbidden);
    const db = f.database();
    try {
      expect(db.prepare('SELECT name,model,quantity,remarks,unit_price FROM materials WHERE model=?').get(...values('0007-A'))).toEqual({ name: '架空一貫材料', model: '0007-A', quantity: '02 本', remarks: '原備考', unit_price: 'PRIVATE-PRICE-RELEASE' });
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally { db.close(); }
    expect(await readFile(f.source)).toEqual(input);
    await writeFile(evidencePath('release-workflow.xlsx'), bytes);
    await writeFile(evidencePath('release-workflow.json'), JSON.stringify({ ...subject(), synthetic: true, normalCloseExit: closeExit, documentId: after.id, revision: after.revision, steps: ['UI import', 'UI search', 'UI add', 'UI edit', 'Ctrl+S', 'normal close', 'restart', 'UI reopen', 'UI Excel output'], sourceUnchanged: true, masterUnchanged: true, outputContainsOnlySelectedSnapshot: true, allZipPartsChecked: [...parts.keys()], dialogs: 'Open/save dialogs mocked at OS boundary; real UI/core/parser/SQLite/output', realOsIme: false, offline: 'Not tested by this case', outputSha256: createHash('sha256').update(bytes).digest('hex') }, null, 2));
  } finally {
    await application.close();
    await f.cleanup();
  }
});
