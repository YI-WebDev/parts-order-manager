import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { capture, expectKeyboardFocus, fixture } from './app';
import type { TestApp } from './app';

// 請求書一覧のカード: カードのどこを押しても開き、複製して編集・削除は「その他の操作」（…）のメニューから選ぶ。
// 状態と操作（メニュー）:
// | 状態         | 操作                                                     | 結果                                                         |
// | 閉じている   | カード（題名・上部欄・印・明細の行数・余白）を押す・Enter | 請求書を開く                                                 |
// | 閉じている   | チェックを押す・右クリック                               | 開かない（チェックは選択だけ変わる）                         |
// | 閉じている   | 「…」を押す・Enter・Space・↓ / ↑                          | 開いて最初 / 最後の項目へフォーカス                          |
// | 開いている   | ↑↓・Home・End                                            | 項目を移る（端で反対の端へ）                                 |
// | 開いている   | → や文字のキー                                           | そのまま（閉じない・フォーカスも動かない）                   |
// | 開いている   | Esc・外を押す・外を右クリック・「…」をもう一度押す        | 閉じて「…」へフォーカス。外にあるもの（別のカード・タブ）は押さない |
// | 開いている   | Tab / Shift+Tab                                          | 閉じて「…」の次 / 前の欄へ                                   |
// | 開いている   | 一覧のスクロール・ウィンドウの大きさの変更                 | 「…」に付いて動く。「…」が見える範囲から外れたら閉じて「…」へ |
// | 開いている   | ほかの欄へフォーカスが移る（Ctrl+F の材料検索）           | 閉じる                                                       |
// | 開いている   | 「複製して編集」・「削除」                                 | 閉じて実行（削除の確認を戻すと「…」へフォーカス）            |
// ダブルクリック（OS が続けて押したと数えた2回目）は、1回目で変わった画面の同じ位置にあるものを押さない:
// 「…」→ メニューは開いたまま。メニューの外 → 閉じるだけ（下の別のカード・タブ・チェックは押さない）。項目 → 削除の確認などに届かない。
// 状態と操作（選択）:
// | 選択                 | 操作                                         | 結果                                                       |
// | なし                 | カードをマウスで押す                         | 開く                                                       |
// | 1件以上（このページ）| カードをマウスで押す（チェックの周りの外も） | そのカードの選択を切り替える（開かない）。ダブルクリックは2回切り替わる |
// | 1件以上              | 開くボタンで Enter（キーボード）              | 開く（キーボードで選ぶのはチェック）                       |
// | 1件以上              | カードを右クリック                           | 何も変わらない                                             |

async function seed(page: Page, titles: readonly string[]): Promise<void> {
  await page.evaluate(async list => {
    for (const title of list) {
      const opened = await window.appApi.documents.open(null); if (opened.status !== 'ok') throw new Error('open');
      const result = await window.appApi.documents.save({ sessionId: opened.data.sessionId, requestNumber: 1, generation: 1, expectedRevision: 0, draft: { ...opened.data.draft, title, header: { ...opened.data.draft.header, C2: `${title}の上部` } } });
      if (result.status !== 'ok') throw new Error('save');
    }
  }, titles);
  await page.reload(); await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('list', { name: '保存済み請求書' })).toBeVisible();
}
const card = (page: Page, title: string) => page.getByRole('article', { name: title, exact: true });
const box = (page: Page, title: string) => card(page, title).getByRole('checkbox', { name: `「${title}」を選択`, exact: true });
const opener = (page: Page, title: string) => card(page, title).getByRole('button', { name: `「${title}」を開く`, exact: true });
const more = (page: Page, title: string) => card(page, title).getByRole('button', { name: `「${title}」のその他の操作`, exact: true });
const menu = (page: Page, title: string) => card(page, title).getByRole('menu');
const item = (page: Page, title: string, name: '複製して編集' | '削除') => menu(page, title).getByRole('menuitem', { name, exact: true });
const editorTitle = (page: Page) => page.getByLabel('管理用タイトル', { exact: true });
async function back(page: Page): Promise<void> { await page.getByRole('button', { name: '← 請求書一覧', exact: true }).click(); await expect(page.getByRole('list', { name: '保存済み請求書' })).toBeVisible(); }
async function closed(page: Page, title: string): Promise<void> { await expect(card(page, title).getByRole('menu')).toHaveCount(0); await expect(more(page, title)).toHaveAttribute('aria-expanded', 'false'); }
async function stop(app: TestApp, f: Awaited<ReturnType<typeof fixture>>): Promise<void> { await app.close(); await f.cleanup(); }
/** 人が押す間隔のダブルクリック（1回目の後に画面が変わってから、OS が続けて押したと数えた2回目が届く）。 */
async function doubleClick(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(120);
  await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 }); await page.waitForTimeout(300);
}
async function center(locator: ReturnType<Page['locator']>): Promise<{ readonly x: number; readonly y: number }> {
  const area = await locator.boundingBox();
  if (!area) throw new Error('layout');
  return { x: area.x + area.width / 2, y: area.y + area.height / 2 };
}

test('the whole card opens the invoice, but the checkbox, the actions button and a right click do not', async () => {
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1120, height: 760 });
    await seed(page, ['架空カードA', '架空カードB', '架空カードC']);
    await app.intercept('documents:open', { record: ['test:open'] });
    const opened = async (): Promise<number> => await app.count('test:open');
    // 開く要求が届くまで少し待ってから、増えていないことを確かめる。
    const unchanged = async (count: number): Promise<void> => { await page.waitForTimeout(300); expect(await opened()).toBe(count); await expect(page.getByRole('list', { name: '保存済み請求書' })).toBeVisible(); };
    await expect(page.getByRole('button', { name: '開く', exact: true })).toHaveCount(0);
    await capture(page, 'invoice-card', 1120);
    // 題名・上部欄・印・明細の行数・カードの右下の角の余白のどこを押しても開く。
    const target = card(page, '架空カードB');
    // 「…」はカードの右上の角、状態の印は下段の右（明細の行数などと同じ行）に置く。
    const frame = await target.boundingBox(), dots = await more(page, '架空カードB').boundingBox(), mark = await target.locator('.badge').last().boundingBox(), meta = await target.locator('.invoice-meta').boundingBox();
    if (!frame || !dots || !mark || !meta) throw new Error('layout');
    expect(dots.y - frame.y).toBeLessThan(16); expect(frame.x + frame.width - (dots.x + dots.width)).toBeLessThan(16);
    expect(frame.x + frame.width - (mark.x + mark.width)).toBeLessThan(20); expect(Math.abs(mark.y + mark.height / 2 - (meta.y + meta.height / 2))).toBeLessThan(4);
    const spots = [target.locator('h2'), target.locator('.card-title .note'), target.locator('.badge').last(), target.locator('.invoice-meta span').first()];
    for (const [index, spot] of spots.entries()) {
      await spot.click({ force: true }); await expect(editorTitle(page)).toHaveValue('架空カードB'); expect(await opened()).toBe(index + 1);
      await back(page);
    }
    const corner = await target.boundingBox();
    if (!corner) throw new Error('layout');
    await page.mouse.click(corner.x + corner.width - 4, corner.y + corner.height - 4); await expect(editorTitle(page)).toHaveValue('架空カードB'); await back(page);
    const count = await opened();
    // チェックは選ぶだけで開かない（チェックの周りの押せる範囲も）。右クリックでも開かない。
    await box(page, '架空カードB').click(); await expect(box(page, '架空カードB')).toBeChecked(); await unchanged(count);
    const select = await card(page, '架空カードB').locator('.card-select').boundingBox();
    if (!select) throw new Error('layout');
    await page.mouse.click(select.x + 2, select.y + 2); await expect(box(page, '架空カードB')).not.toBeChecked(); await unchanged(count);
    await target.locator('h2').click({ button: 'right', force: true }); await unchanged(count);
    await more(page, '架空カードB').click(); await expect(menu(page, '架空カードB')).toBeVisible(); await unchanged(count);
    await page.keyboard.press('Escape'); await closed(page, '架空カードB');
    // 押せることは指したときの枠で示す。チェック・「…」を指しているときは示さない。
    const idle = card(page, '架空カードA');
    await idle.locator('h2').hover({ force: true }); await expect(idle).toHaveCSS('border-top-color', 'rgb(37, 79, 70)'); await expect(idle).not.toHaveCSS('box-shadow', 'none');
    await box(page, '架空カードA').hover(); await expect(idle).toHaveCSS('border-top-color', 'rgb(216, 217, 215)'); await expect(idle).toHaveCSS('box-shadow', 'none');
    await more(page, '架空カードA').hover(); await expect(idle).toHaveCSS('border-top-color', 'rgb(216, 217, 215)'); await expect(idle).toHaveCSS('box-shadow', 'none');
    // キーボードでは チェック → 開く → 「…」の順に移り、開くボタンのフォーカスはカードの周りに出る。Enter・Space で開く。
    await box(page, '架空カードB').focus();
    await page.keyboard.press('Tab'); await expectKeyboardFocus(opener(page, '架空カードB'));
    const ring = await opener(page, '架空カードB').boundingBox(), outer = await target.boundingBox();
    if (!ring || !outer) throw new Error('layout');
    expect(Math.abs(ring.width - outer.width)).toBeLessThanOrEqual(2); expect(Math.abs(ring.height - outer.height)).toBeLessThanOrEqual(2);
    await expect(opener(page, '架空カードB')).toHaveAccessibleDescription(/^明細 0行.*保存版 1/);
    await page.keyboard.press('Tab'); await expect(more(page, '架空カードB')).toBeFocused();
    await page.keyboard.press('Tab'); await expect(box(page, '架空カードA')).toBeFocused();
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Shift+Tab'); await expect(opener(page, '架空カードB')).toBeFocused();
    await page.keyboard.press('Enter'); await expect(editorTitle(page)).toHaveValue('架空カードB'); await back(page);
    await opener(page, '架空カードA').focus(); await page.keyboard.press('Space'); await expect(editorTitle(page)).toHaveValue('架空カードA'); await back(page);
  } finally { await stop(app, f); }
});

test('a double click opens the invoice once, and its second press does not reach the editor that opened under the pointer', async () => {
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1120, height: 760 });
    // 明細のある請求書（開くと、カードの題名の位置に明細の入力欄が来る）。
    await page.evaluate(async () => {
      const opened = await window.appApi.documents.open(null); if (opened.status !== 'ok') throw new Error('open');
      const lines = [];
      for (let i = 0; i < 6; i++) { const added = await window.appApi.documents.addLine({ sessionId: opened.data.sessionId, materialId: null }); if (added.status !== 'ok') throw new Error('line'); lines.push(added.data); }
      const saved = await window.appApi.documents.save({ sessionId: opened.data.sessionId, requestNumber: 1, generation: 1, expectedRevision: 0, draft: { ...opened.data.draft, title: '架空ダブル', lines } });
      if (saved.status !== 'ok') throw new Error('save');
    });
    await page.reload(); await expect(card(page, '架空ダブル')).toBeVisible();
    await app.intercept('documents:open', { record: ['test:open'] });
    const spot = await card(page, '架空ダブル').locator('h2').boundingBox();
    if (!spot) throw new Error('layout');
    const x = spot.x + spot.width / 2, y = spot.y + spot.height / 2;
    // 1回目で編集画面が開いた後に、OS が続けて押したと数えた2回目（clickCount 2）が届く。
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.up();
    await expect(editorTitle(page)).toHaveValue('架空ダブル');
    // 前提: 2回目を押す位置には、編集画面の明細の入力欄がある。
    const under = await page.evaluate(([px, py]) => { const element = document.elementFromPoint(px ?? 0, py ?? 0); return element instanceof HTMLInputElement ? element.getAttribute('aria-label') : null; }, [x, y]);
    expect(under).toMatch(/^明細\d/);
    await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 });
    await page.waitForTimeout(300);
    await expect(page.getByLabel(under ?? '', { exact: true })).not.toBeFocused(); expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    expect(await app.count('test:open')).toBe(1);
    // 捨てるのは続けて押した分だけ。間を空けて押せば、その欄に届く。
    await page.waitForTimeout(1000); await page.mouse.click(x, y); await expect(page.getByLabel(under ?? '', { exact: true })).toBeFocused();
  } finally { await stop(app, f); }
});

test('the actions menu works by keyboard, closes without pressing what lies outside, and runs duplicate and delete', async () => {
  test.setTimeout(60_000);
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1120, height: 800 });
    await seed(page, ['架空メニュー1', '架空メニュー2', '架空メニュー3', '架空メニュー4']);
    // 3列で並ぶ: 1行目 4・3・2、2行目 1。画面の高さは証跡の撮影（capture）と同じにする（大きさが変わるとメニューは閉じる）。
    await app.intercept('documents:open', { record: ['test:open'] });
    const title = '架空メニュー4', button = more(page, title);
    // 押して開くと最初の項目へ。↑↓ は端で反対の端へ、Home・End は端へ。
    await button.click(); await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(item(page, title, '複製して編集')).toBeFocused();
    await expect(menu(page, title).getByRole('menuitem')).toHaveText(['複製して編集', '削除']);
    await capture(page, 'invoice-card-menu', 1120);
    await page.keyboard.press('ArrowDown'); await expectKeyboardFocus(item(page, title, '削除'));
    await page.keyboard.press('ArrowDown'); await expect(item(page, title, '複製して編集')).toBeFocused();
    await page.keyboard.press('ArrowUp'); await expect(item(page, title, '削除')).toBeFocused();
    await page.keyboard.press('Home'); await expect(item(page, title, '複製して編集')).toBeFocused();
    await page.keyboard.press('End'); await expect(item(page, title, '削除')).toBeFocused();
    // 割り当てのないキーでは閉じず、フォーカスも動かない。
    for (const key of ['ArrowRight', 'ArrowLeft', 'a']) { await page.keyboard.press(key); await expect(item(page, title, '削除')).toBeFocused(); await expect(menu(page, title)).toBeVisible(); }
    await page.keyboard.press('Escape'); await closed(page, title); await expectKeyboardFocus(button);
    // 「…」の Enter・Space・↓ は最初の項目、↑ は最後の項目へ。
    for (const [key, first] of [['Enter', '複製して編集'], ['Space', '複製して編集'], ['ArrowDown', '複製して編集'], ['ArrowUp', '削除']] as const) {
      await button.focus(); await page.keyboard.press(key);
      await expect(item(page, title, first)).toBeFocused(); await page.keyboard.press('Escape'); await closed(page, title);
    }
    // Tab は「…」の次の欄（隣のカードのチェック）へ、Shift+Tab は前の欄（このカードを開くボタン）へ進んで閉じる。
    await button.click(); await page.keyboard.press('Tab'); await closed(page, title); await expect(box(page, '架空メニュー3')).toBeFocused();
    await button.click(); await page.keyboard.press('Shift+Tab'); await closed(page, title); await expect(opener(page, title)).toBeFocused();
    // メニューの余白・区切りを押しても、閉じずにフォーカスもメニューに残る。
    await button.click(); await expect(item(page, title, '複製して編集')).toBeFocused();
    for (const inside of [menu(page, title).locator('.menu-separator'), menu(page, title)]) {
      const area = await inside.boundingBox();
      if (!area) throw new Error('layout');
      await page.mouse.click(area.x + 2, area.y + area.height / 2); await expect(item(page, title, '複製して編集')).toBeFocused();
    }
    await page.keyboard.press('Escape'); await closed(page, title);
    // 外（別のカード・別のカードのチェック・見出しのタブ）を押す・右クリックする・「…」をもう一度押すと、閉じるだけ。別の請求書は開かず、チェックもタブも変わらない。
    for (const outside of [card(page, '架空メニュー3').locator('h2'), card(page, '架空メニュー1').locator('.card-select'), page.getByRole('button', { name: '材料', exact: true })]) {
      await button.click(); await expect(menu(page, title)).toBeVisible();
      await outside.click({ force: true }); await closed(page, title); await expect(button).toBeFocused();
    }
    await button.click(); await card(page, '架空メニュー2').locator('h2').click({ button: 'right', force: true }); await closed(page, title); await expect(button).toBeFocused();
    await button.click(); await button.click({ force: true }); await closed(page, title); await expect(button).toBeFocused();
    await page.waitForTimeout(300); expect(await app.count('test:open')).toBe(0);
    await expect(page.getByRole('list', { name: '保存済み請求書' })).toBeVisible(); await expect(box(page, '架空メニュー1')).not.toBeChecked();
    // 一覧のスクロール・ウィンドウの大きさの変更では、メニューは「…」に付いて動く（右端をそろえて、すぐ下）。
    // 押した直後にスクロールが続いても（滑らかなスクロールの途中に押したとき）閉じない。「…」が一覧の見える範囲から外れたら閉じて、「…」へフォーカスを戻す。
    const aligned = async (): Promise<void> => {
      const shown = await menu(page, title).boundingBox(), anchor = await button.boundingBox();
      if (!shown || !anchor) throw new Error('layout');
      expect(Math.abs(shown.x + shown.width - (anchor.x + anchor.width))).toBeLessThanOrEqual(1); expect(Math.abs(shown.y - (anchor.y + anchor.height + 4))).toBeLessThanOrEqual(1);
    };
    const scroller = page.locator('.app-main');
    // 「…」が見える範囲の中ほどに来る位置（この高さでは、一覧の先頭では「…」が見える範囲の下にある）から、滑らかに40px スクロールする。
    await page.setViewportSize({ width: 1120, height: 300 }); await scroller.evaluate(element => { element.scrollTop = 150; });
    await button.evaluate(element => { element.closest('.app-main')?.scrollBy({ top: 40, behavior: 'smooth' }); element.focus({ preventScroll: true }); });
    await page.keyboard.press('Enter');
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(190);
    await expect(item(page, title, '複製して編集')).toBeFocused(); await aligned();
    await page.setViewportSize({ width: 1100, height: 300 }); await expect(menu(page, title)).toBeVisible(); await aligned();
    await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await closed(page, title); await expect(button).toBeFocused();
    await page.setViewportSize({ width: 1120, height: 800 }); await scroller.evaluate(element => { element.scrollTop = 0; });
    // ほかの欄へフォーカスが移ると閉じる（Ctrl+F の材料検索）。
    await button.click(); await page.keyboard.press('Control+f');
    const palette = page.getByRole('dialog', { name: '材料検索' });
    await expect(palette).toBeVisible(); await closed(page, title);
    await page.keyboard.press('Escape'); await expect(palette).toHaveCount(0);
    // メニューは下の行のカードより上に出て、押した項目だけが動く（下のカードは開かない）。
    await box(page, '架空メニュー1').check();
    await button.click();
    const shown = await menu(page, title).boundingBox(), below = await card(page, '架空メニュー1').boundingBox(), anchor = await button.boundingBox();
    if (!shown || !below || !anchor) throw new Error('layout');
    expect(shown.y).toBeGreaterThan(anchor.y + anchor.height); expect(Math.abs(shown.x + shown.width - (anchor.x + anchor.width))).toBeLessThanOrEqual(1);
    const deleteBox = await item(page, title, '削除').boundingBox();
    if (!deleteBox) throw new Error('layout');
    // 前提: 「削除」は下の行のカードに重なっている。
    expect(deleteBox.y + deleteBox.height).toBeGreaterThan(below.y + 4); expect(deleteBox.x).toBeLessThan(below.x + below.width);
    expect(await page.evaluate(([x, y]) => document.elementFromPoint(x ?? 0, y ?? 0)?.closest('[role="menuitem"]')?.textContent, [deleteBox.x + 20, deleteBox.y + deleteBox.height / 2])).toBe('削除');
    // 削除は確認を出し、戻ると「…」へフォーカスが戻る。選んでいたほかのカードの選択は残る。
    await item(page, title, '削除').click();
    const dialog = page.getByRole('dialog', { name: 'この請求書を削除しますか？' });
    await expect(dialog).toContainText(title); await closed(page, title);
    await dialog.getByRole('button', { name: '戻る', exact: true }).click(); await expect(dialog).toHaveCount(0);
    await expect(button).toBeFocused(); await expect(box(page, '架空メニュー1')).toBeChecked();
    expect(await app.count('test:open')).toBe(0);
    // 下に入らないときは上に出す（一覧の最後のカードを画面の下端に寄せる）。
    await page.setViewportSize({ width: 1120, height: 420 });
    const last = more(page, '架空メニュー1');
    await last.evaluate(element => { element.scrollIntoView({ block: 'end' }); });
    await last.click();
    const up = await menu(page, '架空メニュー1').boundingBox(), lastBox = await last.boundingBox();
    if (!up || !lastBox) throw new Error('layout');
    expect(up.y + up.height).toBeLessThanOrEqual(lastBox.y); expect(up.y).toBeGreaterThanOrEqual(0);
    await page.keyboard.press('Escape'); await page.setViewportSize({ width: 1120, height: 800 });
    // 「複製して編集」は複製を開く。
    await button.click(); await item(page, title, '複製して編集').click();
    await expect(editorTitle(page)).toHaveValue(title); await expect(page.getByRole('status', { name: '保存状態' })).toHaveText('保存済み');
    await back(page); await expect(page.getByRole('list', { name: '保存済み請求書' }).locator('article h2')).toHaveText([title, title, '架空メニュー3', '架空メニュー2', '架空メニュー1']);
    await expect(page.getByRole('list', { name: '保存済み請求書' }).locator('article').first().locator('.invoice-meta')).toContainText('複製');
  } finally { await stop(app, f); }
});

test('a double click on the actions button keeps the menu open, and a double click outside an open menu only closes it', async () => {
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1120, height: 800 });
    // 3列で並ぶ: 1行目 4・3・2、2行目 1。
    await seed(page, ['架空連続1', '架空連続2', '架空連続3', '架空連続4']);
    await app.intercept('documents:open', { record: ['test:open'] });
    const title = '架空連続4', button = more(page, title);
    // 「…」のダブルクリック: 2回目はメニューの外（開いたメニューの背後）に当たるが、閉じない。
    const dots = await center(button);
    await doubleClick(page, dots.x, dots.y);
    await expect(menu(page, title)).toBeVisible(); await expect(item(page, title, '複製して編集')).toBeFocused();
    await page.keyboard.press('Escape'); await closed(page, title);
    // メニューを開いたまま外をダブルクリックしても、閉じるだけ。2回目は、閉じた後に下にある別のカード・タブ・チェックを押さない。
    for (const outside of [card(page, '架空連続3').locator('h2'), page.getByRole('button', { name: '材料', exact: true }), card(page, '架空連続1').locator('.card-select')]) {
      await button.click(); await expect(menu(page, title)).toBeVisible();
      const spot = await center(outside);
      await doubleClick(page, spot.x, spot.y);
      await closed(page, title); await expect(button).toBeFocused();
      await expect(page.getByRole('list', { name: '保存済み請求書' })).toBeVisible(); await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    }
    expect(await app.count('test:open')).toBe(0); await expect(box(page, '架空連続1')).not.toBeChecked();
    // 「削除」のダブルクリック: 2回目は、1回目で出た削除の確認（の同じ位置）に届かない。届いた押下は document で数える（捨てるのは window で先に受けたとき）。
    await page.evaluate(() => {
      const counter = window as unknown as { repeated: number }; counter.repeated = 0;
      for (const type of ['mousedown', 'mouseup', 'click']) document.addEventListener(type, event => { if ((event as MouseEvent).detail >= 2) counter.repeated += 1; }, true);
    });
    await button.click();
    const remove = await center(item(page, title, '削除'));
    await doubleClick(page, remove.x, remove.y);
    const dialog = page.getByRole('dialog', { name: 'この請求書を削除しますか？' });
    await expect(dialog).toBeVisible(); expect(await page.evaluate(() => (window as unknown as { repeated: number }).repeated)).toBe(0);
    await dialog.getByRole('button', { name: '戻る', exact: true }).click(); await expect(dialog).toHaveCount(0);
    await expect(button).toBeFocused(); await expect(card(page, title)).toBeVisible();
  } finally { await stop(app, f); }
});

test('while cards are selected, clicking a card toggles its selection instead of opening it, and Enter on the card still opens it', async () => {
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1120, height: 800 });
    await seed(page, ['架空選択A', '架空選択B', '架空選択C']);
    await app.intercept('documents:open', { record: ['test:open'] });
    const count = page.getByRole('group', { name: '請求書の選択' }).locator('.select-count');
    const unopened = async (): Promise<void> => { await page.waitForTimeout(300); expect(await app.count('test:open')).toBe(0); await expect(page.getByRole('list', { name: '保存済み請求書' })).toBeVisible(); };
    // 1件選ぶと、ほかのカードを押しても開かずに選択に加わる。もう一度押すと外れる。
    await box(page, '架空選択A').click(); await expect(count).toHaveText('1件を選択中');
    await card(page, '架空選択B').locator('h2').click({ force: true });
    await expect(box(page, '架空選択B')).toBeChecked(); await expect(card(page, '架空選択B')).toHaveClass(/selected/); await expect(count).toHaveText('2件を選択中'); await unopened();
    await card(page, '架空選択B').locator('.invoice-meta').click({ force: true }); await expect(box(page, '架空選択B')).not.toBeChecked(); await expect(count).toHaveText('1件を選択中'); await unopened();
    // チェックの押せる範囲の少し外（題名との間）を押しても、開かずに選択が切り替わる。
    const select = await card(page, '架空選択A').locator('.card-select').boundingBox();
    if (!select) throw new Error('layout');
    await page.mouse.click(select.x + select.width + 4, select.y + select.height / 2);
    await expect(box(page, '架空選択A')).not.toBeChecked(); await expect(count).toHaveText(''); await unopened();
    // 選んでいる間は、指したときに開くときの影を出さず、チェックの周りを示す。右クリックでは何も変わらない。
    await box(page, '架空選択A').click();
    await card(page, '架空選択B').locator('h2').hover({ force: true });
    await expect(card(page, '架空選択B').locator('.card-select')).toHaveCSS('background-color', 'rgb(220, 232, 218)'); await expect(card(page, '架空選択B')).toHaveCSS('box-shadow', 'none');
    await card(page, '架空選択B').locator('h2').click({ button: 'right', force: true }); await expect(box(page, '架空選択B')).not.toBeChecked(); await unopened();
    // ダブルクリックは2回切り替わる（開かない）。
    const spot = await center(card(page, '架空選択B').locator('h2'));
    await doubleClick(page, spot.x, spot.y); await expect(box(page, '架空選択B')).not.toBeChecked(); await expect(count).toHaveText('1件を選択中'); await unopened();
    // キーボードでは、選んでいる間もカードの開くボタンの Enter で開く（キーボードで選ぶのはチェック）。
    await opener(page, '架空選択C').focus(); await page.keyboard.press('Enter'); await expect(editorTitle(page)).toHaveValue('架空選択C');
    expect(await app.count('test:open')).toBe(1);
    // 選んでいないときは、カードを押すと開く。
    await back(page); await expect(count).toHaveText('');
    await card(page, '架空選択B').locator('h2').click({ force: true }); await expect(editorTitle(page)).toHaveValue('架空選択B');
  } finally { await stop(app, f); }
});
