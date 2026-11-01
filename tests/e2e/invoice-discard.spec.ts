import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { SaveDocument } from '../../src/shared/document-api';
import { fixture, subject } from './app';
import type { TestApp } from './app';
import { evidencePath } from './evidence';

/** app.ts の prepare(...).run・get・all は引数の型が never[] で値を渡せないため、ここで型を合わせる。 */
const values = (...items: (string | number | null)[]): never[] => items as never[];

const titles = { a: '架空A要求済み', b: '架空B追加入力', c: '架空C次の編集' } as const;
// 'button-focus-shortcut': 新UIには「今すぐ保存」ボタンがないため、入力欄外（「← 請求書一覧」ボタン）にフォーカスした状態の Ctrl+S で保存を始める。
type SaveMode = 'shortcut' | 'button-focus-shortcut' | 'autosave-queued-shortcut';
type Destination = 'navigation' | 'close';

async function shutdown(application: TestApp): Promise<void> {
  await application.close();
}

/** 本物の保存処理を通した後、最初の応答だけを test:discard:release まで保留する。 */
async function delayFirstResponse(application: TestApp): Promise<void> {
  await application.intercept('documents:save', { hold: 'test:discard:release', holdFirstOnly: true });
}

/** アプリ本体に届いた保存要求の管理用タイトル（旧版は Main の console.log で集めていた。ここでは差し込みの呼出し記録から読む）。 */
async function sentTitles(application: TestApp): Promise<string[]> {
  return (await application.events()).filter(event => event.type === 'call' && event['channel'] === 'documents:save').map(event => (event['args'] as [SaveDocument])[0].draft.title);
}

async function beginSave(page: Page, mode: SaveMode): Promise<void> {
  switch (mode) {
    case 'shortcut': await page.keyboard.press('Control+s'); return;
    case 'button-focus-shortcut': {
      const button = page.getByRole('button', { name: '← 請求書一覧', exact: true });
      await button.focus(); await expect(button).toBeFocused();
      await page.keyboard.press('Control+s'); return;
    }
    case 'autosave-queued-shortcut': await page.clock.runFor(500); return;
  }
}

async function leave(application: TestApp, page: Page, destination: Destination): Promise<void> {
  switch (destination) {
    case 'navigation': await page.getByRole('button', { name: '請求書', exact: true }).click(); return;
    case 'close': await application.requestClose(); return;
  }
}

for (const destination of ['navigation', 'close'] as const) {
  for (const mode of ['shortcut', 'button-focus-shortcut', 'autosave-queued-shortcut'] as const) {
    test(`discard never sends B when ${mode} A response is pending during ${destination}`, async () => {
      await exercise(mode, destination, 'discard');
    });
  }
  test(`save and continue saves latest B when A response is pending during ${destination}`, async () => {
    await exercise('shortcut', destination, 'save');
  });
}

async function exercise(mode: SaveMode, destination: Destination, choice: 'discard' | 'save'): Promise<void> {
  const f = await fixture(Buffer.alloc(0));
  let application = await f.launch();
  const rows = () => {
    const db = f.database();
    try { return db.prepare('SELECT title, revision FROM documents').all(); }
    finally { db.close(); }
  };
  try {
    // Given: a real isolated Main save commits A, with only its response held back.
    let page = await application.firstWindow();
    await page.clock.install({ time: 0 });
    await page.clock.pauseAt(1000);
    await page.getByRole('button', { name: '新規請求書', exact: true }).click();
    await page.getByLabel('管理用タイトル', { exact: true }).fill(titles.a);
    await delayFirstResponse(application);
    // 終了の場合、終了の要求（documents:close）を処理の前で止め、終了する前に届いた保存要求を読めるようにする（画面はすべての保存の後に終了を要求する）。
    if (destination === 'close') await application.intercept('documents:close', { hold: 'test:discard:close', holdBefore: true });
    await beginSave(page, mode);
    await expect.poll(() => application.count('test:discard:release')).toBe(1);
    expect(rows()).toEqual([{ title: titles.a, revision: 1 }]);
    await page.getByLabel('管理用タイトル', { exact: true }).fill(titles.b);
    if (mode === 'autosave-queued-shortcut') await page.keyboard.press('Control+s');
    await leave(application, page, destination);
    await expect(page.getByRole('dialog', { name: '未保存の変更があります' })).toBeVisible();

    // When: the user chooses while A is pending, then the real A receipt is delivered.
    await page.getByRole('button', { name: choice === 'discard' ? '未保存分を破棄' : '保存して続ける', exact: true }).click();
    expect(rows()).toEqual([{ title: titles.a, revision: 1 }]);
    const closed = destination === 'close' ? application.waitForExit() : null;
    await application.release('test:discard:release');
    let sent: string[];
    if (closed) {
      await expect.poll(() => application.count('test:discard:close')).toBe(1);
      sent = await sentTitles(application);
      await application.release('test:discard:close');
      await closed;
    } else {
      await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
      sent = await sentTitles(application);
    }

    // Then: only the chosen generations reach Main and disk, including after restart.
    const expectedTitle = choice === 'discard' ? titles.a : titles.b;
    const expectedRevision = choice === 'discard' ? 1 : 2;
    const after = rows();
    const evidence = { ...subject(), synthetic: true, mode, destination, choice, sent, after,
      expectedTitle, expectedRevision, mainHandlerPreserved: true, firstCommittedResponseDelayed: true };
    await writeFile(evidencePath(`discard-${mode}-${destination}-${choice}.json`), JSON.stringify(evidence, null, 2));
    expect(after).toEqual([{ title: expectedTitle, revision: expectedRevision }]);
    expect(sent).toEqual(choice === 'discard' ? [titles.a] : [titles.a, titles.b]);
    let restartedTitle: string = expectedTitle;
    let restartRevision = expectedRevision;
    if (choice === 'discard' && mode === 'button-focus-shortcut' && destination === 'navigation') {
      // 新UIの「請求書」タブは常に一覧へ戻り、「開く」は新しい編集セッションを作る。同じセッションへ戻れる唯一の経路は
      // 材料パレットからの追加（作業中の請求書へ追加して編集画面へ戻る）なので、架空材料を1件登録して使う。
      const seed = f.database();
      try {
        const categoryId = randomUUID();
        seed.prepare('INSERT INTO categories VALUES (?,?,?,?)').run(...values(categoryId, '架空カテゴリ', 0, 1));
        seed.prepare('INSERT INTO materials(id,category_id,name,model,manufacturer,quantity,remarks,unit_price,search_text,active,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...values(randomUUID(), categoryId, '架空再開材料', '002-B', '架空社', '01 個', '', '', '架空再開材料', 1, 1, 'now', 'now'));
      } finally { seed.close(); }
      await page.keyboard.press('Control+f');
      const palette = page.getByRole('dialog', { name: '材料検索' });
      await palette.getByLabel('キーワード', { exact: true }).fill('架空再開材料');
      await page.clock.runFor(200);
      await expect(palette.locator('.search-result')).toHaveCount(1);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Control+Enter');
      await expect(page.getByRole('region', { name: '請求書編集' })).toBeVisible();
      await expect(page.getByLabel('明細1 品名', { exact: true })).toHaveValue('架空再開材料');
      await expect(page.getByLabel('管理用タイトル', { exact: true })).toHaveValue(titles.a);
      await page.getByLabel('管理用タイトル', { exact: true }).fill(titles.c);
      await page.keyboard.press('Control+s');
      await expect(page.getByRole('status', { name: '保存状態' })).toHaveText('保存済み');
      expect(rows()).toEqual([{ title: titles.c, revision: 2 }]);
      restartedTitle = titles.c;
      restartRevision = 2;
    }
    await shutdown(application);
    application = await f.launch(); page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: restartedTitle, exact: true })).toBeVisible();
    await page.getByRole('article', { name: restartedTitle }).getByRole('button', { name: /を開く$/ }).click();
    await expect(page.getByLabel('管理用タイトル', { exact: true })).toHaveValue(restartedTitle);
    const nextTitle = restartedTitle === titles.c ? '架空D再起動後の編集' : titles.c;
    await page.getByLabel('管理用タイトル', { exact: true }).fill(nextTitle);
    await page.keyboard.press('Control+s');
    await expect(page.getByRole('status', { name: '保存状態' })).toHaveText('保存済み');
    expect(rows()).toEqual([{ title: nextTitle, revision: restartRevision + 1 }]);
    await writeFile(evidencePath(`discard-${mode}-${destination}-${choice}.json`), JSON.stringify({ ...evidence, sameSessionNextEditVerified: restartedTitle === titles.c, sameSessionReturnPath: restartedTitle === titles.c ? 'materialPaletteAdd' : null, restartedTitleVerified: restartedTitle, nextEdit: rows(), verdict: 'PASS' }, null, 2));
  } finally { await shutdown(application); await f.cleanup(); }
}
