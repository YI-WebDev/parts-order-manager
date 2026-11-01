import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { withZip64CompressedSize } from '../fixtures/xlsx';
import { capture, fixture, subject } from './app';
import type { TestApp } from './app';
import { evidencePath } from './evidence';

async function start(page: Page): Promise<void> {
  await page.getByRole('button', { name: '請求書', exact: true }).click();
  await page.getByRole('button', { name: '新規請求書', exact: true }).click();
  await expect(page.getByLabel('管理用タイトル', { exact: true })).toBeVisible();
}
async function stop(application: TestApp): Promise<void> {
  await application.close();
}
async function destination(application: TestApp, selected: string | null, overwrite = true): Promise<void> {
  // 保存先の選択（null は取消）と上書き確認（1＝上書きする、0＝戻る）の答え。
  await application.dialog('save', selected);
  await application.dialog('message', overwrite ? 1 : 0);
}
/** 出力を止めた操作でファイル選択が開かれていないこと（旧版は showSaveDialog が呼ばれたら例外にしていた）。 */
async function expectNoFileDialog(application: TestApp): Promise<void> {
  expect((await application.events()).filter(event => event.type === 'dialog' && event['kind'] === 'save')).toEqual([]);
}
async function addEmptyLine(page: Page): Promise<void> {
  await page.getByLabel('材料を検索して明細に追加', { exact: true }).click();
  await page.getByRole('button', { name: '空の明細を追加', exact: true }).click();
}
async function exportClick(page: Page): Promise<void> { await page.getByRole('button', { name: 'Excelへ出力', exact: true }).click(); }
async function record(name: string, data: object): Promise<void> {
  await writeFile(evidencePath(name), JSON.stringify({ ...subject(), isolatedSynthetic: true, productionMainHandler: true, dialogsMockedAtOsBoundary: true, ...data }, null, 2));
}

test('zero line export saves latest draft and cancellation preserves the saved document', async () => {
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow(); await start(page);
    await page.clock.install({ time: 0 }); await page.clock.pauseAt(1000);
    await page.getByLabel('管理用タイトル', { exact: true }).fill('NOT-FOR-EXPORT-TITLE');
    await destination(application, null); await exportClick(page);
    await expect(page.getByRole('status', { name: 'Excel出力状態' })).toContainText('取り消しました');
    await expect(page.getByRole('status', { name: '保存状態' })).toHaveText('保存済み');
    await expect(page.getByRole('button', { name: 'Excelへ出力', exact: true })).toBeFocused();
    for (const width of [1280, 768, 375]) await capture(page, 'export-cancelled', width);
    const target = path.join(f.root, 'zero.xlsx');
    await destination(application, target); await exportClick(page);
    await expect(page.getByRole('status', { name: 'Excel出力状態' })).toContainText('をExcelへ出力しました');
    expect((await readFile(target)).subarray(0, 2).toString()).toBe('PK');
    const db = f.database(); try { expect(db.prepare('SELECT title FROM documents').all()).toEqual([{ title: 'NOT-FOR-EXPORT-TITLE' }]); } finally { db.close(); }
    await expect(page.getByRole('button', { name: 'Excelへ出力', exact: true })).toBeFocused();
    await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Excelへ出力', exact: true })).toBeFocused();
    expect(await page.getByRole('button', { name: 'Excelへ出力', exact: true }).evaluate(element => element.matches(':focus-visible'))).toBe(true);
    for (const width of [1280, 768, 375]) await capture(page, 'export-zero-success', width);
    await record('export-zero.json', { savedBeforeDialog: true, cancelPreservedDocument: true, exported: true });
  } finally { await stop(application); await f.cleanup(); }
});

test('invalid date output stops before file selection and keeps editable draft; an unselected check is not an issue', async () => {
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow(); await start(page);
    await page.getByLabel('納期', { exact: true }).fill('2026-02-30');
    await addEmptyLine(page);
    // 旧版はファイル選択が開かれたら例外にしていた。ここでは答えを外し（開かれたら取消になる）、開かれていないことを記録で確かめる。
    await application.clearDialog('save'); await application.clearEvents();
    await exportClick(page);
    // 画面の事前判定: Main を呼ばずに確認事項ポップオーバーを開き、保存だけは確定する。
    const issues = page.getByRole('alert', { name: '出力前の確認事項' });
    await expect(issues).toContainText('Excel出力の前に確認してください');
    await expect(issues).toContainText('納期の形式');
    // チェックは任意の項目（利用者の指示、2026年10月16日）。未選択の明細は確認事項にしない。
    await expect(issues).not.toContainText('チェック');
    await expect(page.getByRole('button', { name: '出力前の確認 1件', exact: true })).toBeVisible();
    await expect(page.getByRole('status', { name: '保存状態' })).toHaveText('保存済み');
    await expect(page.getByLabel('明細1 品名', { exact: true })).toBeEnabled();
    await expect(page.getByLabel('納期', { exact: true })).toHaveValue('2026-02-30');
    await expect(page.getByRole('button', { name: 'Excelへ出力', exact: true })).toBeFocused();
    for (const width of [1280, 768, 375]) await capture(page, 'export-blocked', width);
    // Main 自身の判定: 保存版を直接出力要求しても、ファイル選択（例外を投げる差し替え）の前に blocked で止まる。
    const main = await page.evaluate(async () => {
      const listed = await window.appApi.documents.list(0); if (listed.status !== 'ok' || !listed.data.items[0]) throw new Error('Missing synthetic saved document');
      const doc = listed.data.items[0]; return window.appApi.exports.excel({ documentId: doc.id, revision: doc.revision });
    });
    expect(main).toEqual({ status: 'blocked', issues: [expect.objectContaining({ field: 'E4' })] });
    await expectNoFileDialog(application);
    await record('export-blocked.json', { invalidDateBlocked: true, unselectedCheckNotIssue: true, rendererPrecheckPopover: true, mainBlockedDirectRequest: true, noDialog: true, draftEditable: true });
  } finally { await stop(application); await f.cleanup(); }
});

test('resolved one line output confirms overwrite and failed or foreign destinations preserve files', async () => {
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow(); await start(page);
    await addEmptyLine(page);
    await page.getByLabel('上部欄', { exact: true }).fill('架空上部');
    await page.getByLabel('納期', { exact: true }).fill('2026/9/13');
    await page.getByLabel('明細1 品名', { exact: true }).fill('=SUM(1,2)');
    await page.getByLabel('明細1 型式', { exact: true }).fill('001-A');
    await page.getByLabel('明細1 数量', { exact: true }).fill('02 本');
    await page.getByRole('radiogroup', { name: '明細1 チェック状態', exact: true }).getByRole('radio', { name: '材料のみ（●）', exact: true }).click();
    await expect(page.getByRole('button', { name: '出力の準備ができています', exact: true })).toBeDisabled();
    const target = path.join(f.root, 'one.xlsx'); await destination(application, target); await exportClick(page);
    await expect(page.getByRole('status', { name: 'Excel出力状態' })).toContainText('をExcelへ出力しました');
    const original = await readFile(target);
    await page.getByLabel('明細1 品名', { exact: true }).fill('架空改訂材料');
    await destination(application, target, false); await exportClick(page);
    await expect(page.getByRole('status', { name: 'Excel出力状態' })).toContainText('取り消しました');
    expect(await readFile(target)).toEqual(original);
    await destination(application, target); await exportClick(page);
    await expect(page.getByRole('status', { name: 'Excel出力状態' })).toContainText('をExcelへ出力しました');
    expect(await readFile(target)).not.toEqual(original);
    const foreign = path.join(f.root, 'foreign.xlsx'), secret = Buffer.from('PRIVATE-FOREIGN-SENTINEL'); await writeFile(foreign, secret);
    await destination(application, foreign); await exportClick(page);
    await expect(page.getByRole('alert', { name: 'Excel出力エラー' })).toBeVisible(); expect(await readFile(foreign)).toEqual(secret);
    // シート本体の圧縮後サイズを ZIP64 の最大値にした既存ファイルも、上書き前の検査で止め、ファイルを変えずにアプリは動き続ける。
    const abnormal = path.join(f.root, 'zip64.xlsx'), damaged = withZip64CompressedSize(original, 'xl/worksheets/sheet1.xml', 0xffff_ffff_ffff_ffffn); await writeFile(abnormal, damaged);
    await destination(application, abnormal); await exportClick(page);
    await expect(page.getByRole('alert', { name: 'Excel出力エラー' })).toContainText('確認済みの出力形式ではありません'); expect(await readFile(abnormal)).toEqual(damaged);
    await destination(application, path.join(f.root, 'after-zip64.xlsx')); await exportClick(page);
    await expect(page.getByRole('status', { name: 'Excel出力状態' })).toContainText('をExcelへ出力しました');
    await destination(application, path.join(f.root, 'missing', 'failure.xlsx')); await exportClick(page);
    await expect(page.getByRole('alert', { name: 'Excel出力エラー' })).toBeVisible();
    await expect(page.getByLabel('明細1 品名', { exact: true })).toHaveValue('架空改訂材料');
    await expect(page.getByRole('button', { name: 'Excelへ出力', exact: true })).toBeFocused();
    for (const width of [1280, 768, 375]) await capture(page, 'export-write-error', width);
    await record('export-overwrite.json', { explicitOverwrite: true, overwriteCancelPreserved: true, foreignPreserved: true, abnormalZip64Preserved: true, exportAfterZip64: true, missingParentFailed: true });
  } finally { await stop(application); await f.cleanup(); }
});

test('open output dialog locks UI close and duplicate export while changed saved revision is rejected', async () => {
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow(); await start(page);
    await page.getByLabel('管理用タイトル', { exact: true }).fill('架空競合前');
    const target = path.join(f.root, 'conflict.xlsx');
    // ファイル選択を開いたまま（release まで閉じない）にする。
    await application.dialog('save', target, 'test:export:release');
    await exportClick(page);
    await expect.poll(() => application.count('test:export:release')).toBe(1);
    await expect(page.getByLabel('管理用タイトル', { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '請求書', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Excelへ出力', exact: true })).toBeDisabled();
    await application.requestClose();
    expect(page.isClosed()).toBe(false); expect(application.running).toBe(true);
    for (const width of [1280, 768, 375]) await capture(page, 'export-working', width);
    const result = await page.evaluate(async () => {
      const listed = await window.appApi.documents.list(0); if (listed.status !== 'ok' || !listed.data.items[0]) throw new Error('Missing synthetic saved document');
      const doc = listed.data.items[0]; const busy = await window.appApi.exports.excel({ documentId: doc.id, revision: doc.revision });
      const opened = await window.appApi.documents.open(doc.id); if (opened.status !== 'ok') throw new Error('Missing synthetic session');
      const saved = await window.appApi.documents.save({ sessionId: opened.data.sessionId, requestNumber: 1, generation: 1, expectedRevision: doc.revision, draft: { ...opened.data.draft, title: '架空競合後' } });
      return { busy, saved };
    });
    expect(result.busy).toMatchObject({ status: 'error', code: 'BUSY' }); expect(result.saved).toMatchObject({ status: 'ok' });
    await application.release('test:export:release');
    await expect(page.getByRole('alert', { name: 'Excel出力エラー' })).toBeVisible();
    expect(await readdir(f.root)).not.toContain('conflict.xlsx');
    await record('export-conflict.json', { uiLocked: true, closeDeferred: true, duplicateRejected: true, changedRevisionRejected: true, noFileWritten: true });
  } finally { await stop(application); await f.cleanup(); }
});

test('export boundary rejects renderer paths drafts and foreign windows', async () => {
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow(); await start(page); await page.keyboard.press('Control+s');
    await expect(page.getByRole('status', { name: '保存状態' })).toHaveText('保存済み');
    const extra = await page.evaluate(async () => {
      const listed = await window.appApi.documents.list(0); if (listed.status !== 'ok' || !listed.data.items[0]) throw new Error('Missing synthetic document');
      const doc = listed.data.items[0]; return Reflect.apply(window.appApi.exports.excel, null, [{ documentId: doc.id, revision: doc.revision, path: 'C:/arbitrary.xlsx', draft: {} }]);
    });
    expect(extra).toMatchObject({ status: 'error', code: 'VALIDATION' });
    expect(await page.evaluate(() => window.appApi.exports.excel({ documentId: 'bad', revision: 1 }).then(result => result.status))).toBe('error');
    // 旧版の「別ウィンドウ（preload 付き）からの要求」に当たる、信頼できない送信元からの要求は拒否する（アプリ版では権限設定でメインウィンドウ以外は ipc を呼べず、さらに本体が送信元を確かめる）。
    expect((await application.untrustedInvoke('documents:export-excel', { documentId: 'bad', revision: 1 })).value).toMatchObject({ status: 'error' });
    await record('export-boundary.json', { extraPathAndDraftRejected: true, foreignWindowRejected: true, malformedRequestRejected: true });
  } finally { await stop(application); await f.cleanup(); }
});
