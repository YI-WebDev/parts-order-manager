import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { capture, fixture, subject } from './app';
import type { TestApp } from './app';
import { evidencePath } from './evidence';
async function start(page: Page): Promise<void> {
  await page.getByRole('button', { name: '請求書', exact: true }).click();
  await page.getByRole('button', { name: '新規請求書', exact: true }).click();
  await expect(page.getByLabel('管理用タイトル', { exact: true })).toBeVisible();
}
async function cleanup(application: TestApp): Promise<void> {
  await application.close();
}
/** ウィンドウの「閉じる」から終了確認で選んだ後、アプリの終了を待つ。
 * 選んだ直後にウィンドウが閉じてクリック処理が終わらないことがある（WebView2）ので、閉じた場合だけ失敗扱いにしない。中継では画面は残り、アプリだけが終了する。 */
async function chooseAndExit(application: TestApp, page: Page, name: string): Promise<void> {
  await Promise.all([application.waitForExit(), page.getByRole('button', { name, exact: true }).click().catch((error: unknown) => { if (!page.isClosed()) throw error; })]);
}

test('packaged document IPC rejects extra keys foreign frames forged provenance and wrong close tokens', async () => {
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow();
    const outcomes = await page.evaluate(async (fakeId) => {
      const opened = await window.appApi.documents.open(null);
      if (opened.status !== 'ok') throw new Error('Synthetic editor open failed');
      const added = await window.appApi.documents.addLine({ sessionId: opened.data.sessionId, materialId: null });
      if (added.status !== 'ok') throw new Error('Synthetic line allocation failed');
      const input = { sessionId: opened.data.sessionId, requestNumber: 1, generation: 1, expectedRevision: 0, draft: { ...opened.data.draft, lines: [added.data] } };
      return {
        extra: await Reflect.apply(window.appApi.documents.save, null, [{ ...input, sql: 'arbitrary' }]),
        source: await window.appApi.documents.save({ ...input, draft: { ...input.draft, lines: [{ ...added.data, sourceItemId: fakeId }] } }),
        close: await window.appApi.documents.close(fakeId),
        list: await Reflect.apply(window.appApi.documents.list, null, [-1]),
      };
    }, randomUUID());
    expect(outcomes.extra).toMatchObject({ status: 'error', code: 'VALIDATION' });
    expect(outcomes.source).toMatchObject({ status: 'error', code: 'VALIDATION' });
    expect(outcomes.close).toMatchObject({ status: 'error', code: 'VALIDATION' });
    expect(outcomes.list).toMatchObject({ status: 'error', code: 'VALIDATION' });
    // 旧版の「別ウィンドウ（preload 付き）からの要求」に当たる、信頼できない送信元からの要求は拒否する（アプリ版では権限設定でメインウィンドウ以外は ipc を呼べず、さらに本体が送信元を確かめる）。
    expect((await application.untrustedInvoke('documents:open', null)).value).toMatchObject({ status: 'error' });
    const db = f.database(); try { expect(db.prepare('SELECT COUNT(*) AS count FROM documents').get()).toEqual({ count: 0 }); } finally { db.close(); }
    await writeFile(evidencePath('invoice-boundary.json'), JSON.stringify({ ...subject(), isolatedSynthetic: true, extraKeysRejected: true, spoofedSourceRejected: true, foreignWindowRejected: true, wrongCloseTokenRejected: true, noDocumentWrites: true }, null, 2));
  } finally { await cleanup(application); await f.cleanup(); }
});

test('lost successful first response retries the identical request then saves only the latest generation', async () => {
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow(); await start(page);
    // 本物の保存処理を通した後、最初の1回だけ応答を失わせる（画面には失敗が届く）。
    await application.intercept('documents:save', { dropFirst: true });
    await page.getByLabel('管理用タイトル', { exact: true }).fill('応答喪失前の架空入力'); await page.keyboard.press('Control+s');
    await expect(page.getByRole('status', { name: '保存状態' })).toHaveText('保存失敗');
    await expect(page.getByRole('region', { name: '請求書編集' }).getByRole('alert')).toContainText('保存結果が不明');
    await page.getByLabel('管理用タイトル', { exact: true }).fill('喪失後の最新架空入力');
    await capture(page, 'invoice-unknown-result');
    await page.getByRole('button', { name: '保存を再試行', exact: true }).click();
    await expect(page.getByRole('status', { name: '保存状態' })).toHaveText('保存済み');
    await expect(page.getByLabel('管理用タイトル', { exact: true })).toHaveValue('喪失後の最新架空入力');
    const db = f.database(); try { expect(db.prepare('SELECT title, revision FROM documents').all()).toEqual([{ title: '喪失後の最新架空入力', revision: 2 }]); } finally { db.close(); }
    await writeFile(evidencePath('invoice-response-loss.json'), JSON.stringify({ syntheticResponseExceptionAfterRealCommit: true, latestInputPreserved: true, documents: 1, revision: 2, duplicateInitialSavePrevented: true }, null, 2));
  } finally { await cleanup(application); await f.cleanup(); }
});

test('save on close persists the newest draft and discard on close keeps the last saved version', async () => {
  const f = await fixture(Buffer.alloc(0)); let application = await f.launch();
  try {
    let page = await application.firstWindow(); await start(page);
    await page.clock.install(); await page.clock.pauseAt(new Date());
    await page.getByLabel('管理用タイトル', { exact: true }).fill('終了保存した架空請求書');
    await application.requestClose();
    await expect(page.getByRole('dialog', { name: '未保存の変更があります' })).toBeVisible();
    await capture(page, 'invoice-close-save-guard');
    await chooseAndExit(application, page, '保存して続ける');
    await application.close(); application = await f.launch(); page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: '終了保存した架空請求書', exact: true })).toBeVisible();
    await page.getByRole('article', { name: '終了保存した架空請求書' }).getByRole('button', { name: /を開く$/ }).click();
    await page.clock.install(); await page.clock.pauseAt(new Date());
    await page.getByLabel('管理用タイトル', { exact: true }).fill('終了時に破棄する架空入力');
    await application.requestClose();
    await expect(page.getByRole('dialog', { name: '未保存の変更があります' })).toBeVisible();
    // 破棄は保存を待たずにすぐ閉じるため、クリック処理の完了前にウィンドウが閉じることがある（保存の場合も同じ）。閉じた場合だけ失敗扱いにしない。
    await chooseAndExit(application, page, '未保存分を破棄');
    await application.close(); application = await f.launch(); page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: '終了保存した架空請求書', exact: true })).toBeVisible();
    const db = f.database(); try { expect(db.prepare('SELECT title FROM documents').all()).toEqual([{ title: '終了保存した架空請求書' }]); } finally { db.close(); }
    await capture(page, 'invoice-close-restarted');
    await writeFile(evidencePath('invoice-close.json'), JSON.stringify({ isolatedSynthetic: true, closeRequestedViaBrowserWindow: true, rendererChoiceClicked: true, saveCloseRestartPreserved: true, discardCloseRestartPreservedLastSaved: true, rendererClockPausedToPreventAutosaveBeforeClose: true }, null, 2));
  } finally { await cleanup(application); await f.cleanup(); }
});

test('cancelled navigation retains the current input and editor session', async () => {
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow(); await start(page);
    await page.clock.install(); await page.clock.pauseAt(new Date());
    await page.getByLabel('管理用タイトル', { exact: true }).fill('移動を取り消す架空入力');
    await page.getByRole('button', { name: '請求書', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '未保存の変更があります' })).toBeVisible();
    await page.getByRole('button', { name: '戻る', exact: true }).click();
    await expect(page.getByRole('region', { name: '請求書編集' })).toBeVisible();
    await expect(page.getByLabel('管理用タイトル', { exact: true })).toHaveValue('移動を取り消す架空入力');
    await page.keyboard.press('Control+s');
    await expect(page.getByRole('status', { name: '保存状態' })).toHaveText('保存済み');
    await capture(page, 'invoice-navigation-cancelled');
  } finally { await cleanup(application); await f.cleanup(); }
});
