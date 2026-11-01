import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { capture, fixture } from './app';
import type { TestApp } from './app';

// 請求書の削除（1件ずつ・選んでまとめて）。組合せは、選択（ページ・絞り込みごと）× 確認（戻る・Esc・削除）× 結果（成功・失敗・応答なし）
// × 開いている請求書・複製元の削除。どれも一覧にいたまま（フォーカスを動かさずに）操作する。

/** app.ts の prepare(...).run は引数の型が never[] で値を渡せないため、ここで型を合わせる。 */
const values = (...items: (string | number | null)[]): never[] => items as never[];
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** 題名ごとに請求書を保存し、後ろほど新しい（一覧の上に来る）更新日時にそろえて、一覧を開き直す。 */
async function seed(f: Fixture, page: Page, titles: readonly string[]): Promise<string[]> {
  const ids = await page.evaluate(async list => {
    const created: string[] = [];
    for (const title of list) {
      const opened = await window.appApi.documents.open(null); if (opened.status !== 'ok') throw new Error('open');
      const result = await window.appApi.documents.save({ sessionId: opened.data.sessionId, requestNumber: 1, generation: 1, expectedRevision: 0, draft: { ...opened.data.draft, title, header: { ...opened.data.draft.header, C2: `${title}の上部` } } });
      if (result.status !== 'ok') throw new Error('save'); created.push(result.data.documentId);
    }
    return created;
  }, titles);
  const db = f.database();
  try { ids.forEach((id, index) => db.prepare('UPDATE documents SET updated_at=? WHERE id=?').run(...values(new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(), id))); } finally { db.close(); }
  await page.reload(); await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('list', { name: '保存済み請求書' })).toBeVisible();
  return ids;
}
const card = (page: Page, title: string) => page.getByRole('article', { name: title, exact: true });
const box = (page: Page, title: string) => card(page, title).getByRole('checkbox', { name: `「${title}」を選択`, exact: true });
const more = (page: Page, title: string) => card(page, title).getByRole('button', { name: `「${title}」のその他の操作`, exact: true });
/** カードの「その他の操作」（…）から「削除」を選ぶ。 */
async function trash(page: Page, title: string): Promise<void> { await more(page, title).click(); await card(page, title).getByRole('menu').getByRole('menuitem', { name: '削除', exact: true }).click(); }
const titles = (page: Page) => page.getByRole('list', { name: '保存済み請求書' }).locator('article h2');
const all = (page: Page) => page.getByRole('checkbox', { name: 'このページをすべて選択', exact: true });
const count = (page: Page) => page.getByRole('group', { name: '請求書の選択' }).locator('.select-count');
const lines = (f: Fixture, id: string): number => { const db = f.database(); try { return (db.prepare('SELECT count(*) AS n FROM document_lines WHERE document_id=?').get(...values(id)) as { n: number }).n; } finally { db.close(); } };
async function stop(app: TestApp, f: Fixture): Promise<void> { await app.close(); await f.cleanup(); }

test('single delete asks first, keeps the invoice on 戻る or Esc, and leaves focus on the card that took its place', async () => {
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow();
    const [a, b] = await seed(f, page, ['架空削除A', '架空削除B', '架空削除C']);
    if (!a || !b) throw new Error('seed');
    await page.evaluate(async id => { const opened = await window.appApi.documents.open(id); if (opened.status !== 'ok') throw new Error('open'); await window.appApi.documents.addLine({ sessionId: opened.data.sessionId, materialId: null }).then(line => { if (line.status !== 'ok') throw new Error('line'); return window.appApi.documents.save({ sessionId: opened.data.sessionId, requestNumber: 1, generation: 1, expectedRevision: 1, draft: { ...opened.data.draft, lines: [line.data] } }); }); }, b);
    await page.reload(); await expect(titles(page)).toHaveText(['架空削除B', '架空削除C', '架空削除A']);
    expect(lines(f, b)).toBe(1);
    const dialog = page.getByRole('dialog', { name: 'この請求書を削除しますか？' });
    // 戻る・Esc では何も削除せず、削除を選んだ「その他の操作」（…）へフォーカスが戻る。
    for (const close of ['戻る', 'Escape']) {
      await trash(page, '架空削除B');
      await expect(dialog).toContainText('架空削除B'); await expect(dialog).toContainText('架空削除Bの上部 ・ 明細 1行');
      await expect(dialog.getByRole('button', { name: '戻る', exact: true })).toBeFocused();
      if (close === 'Escape') await page.keyboard.press('Escape'); else await dialog.getByRole('button', { name: '戻る', exact: true }).click();
      await expect(dialog).toHaveCount(0); await expect(more(page, '架空削除B')).toBeFocused();
      await expect(titles(page)).toHaveText(['架空削除B', '架空削除C', '架空削除A']);
    }
    await trash(page, '架空削除B');
    await capture(page, 'invoice-delete-confirm', 1120);
    await dialog.getByRole('button', { name: '削除する', exact: true }).click();
    await expect(titles(page)).toHaveText(['架空削除C', '架空削除A']);
    await expect(page.getByRole('status').filter({ hasText: '「架空削除B」を削除しました' })).toBeVisible();
    // 消えたカードの位置に来たカード（架空削除C）のチェックへフォーカスを移す。
    await expect(box(page, '架空削除C')).toBeFocused();
    expect(lines(f, b)).toBe(0);
    expect(await page.evaluate(id => window.appApi.documents.open(id).then(result => result.status === 'error' ? result.code : 'ok'), b)).toBe('NOT_FOUND');
    // 最後のカードを消したときは直前のカードへ。すべて消したら「新規請求書」へ。
    await trash(page, '架空削除A'); await dialog.getByRole('button', { name: '削除する', exact: true }).click();
    await expect(titles(page)).toHaveText(['架空削除C']); await expect(box(page, '架空削除C')).toBeFocused();
    await trash(page, '架空削除C'); await dialog.getByRole('button', { name: '削除する', exact: true }).click();
    await expect(page.getByText('保存済みの請求書はありません。「新規請求書」から作成してください。')).toBeVisible();
    await expect(page.getByRole('button', { name: /^新規請求書/ })).toBeFocused();
    await page.reload(); await expect(page.getByText('保存済みの請求書はありません。「新規請求書」から作成してください。')).toBeVisible();
  } finally { await stop(app, f); }
});

test('bulk delete removes only the chosen invoices; select all toggles and the count follows the visible page', async () => {
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow();
    await seed(f, page, ['架空D1', '架空D2', '架空D3', '架空D4']);
    await expect(titles(page)).toHaveText(['架空D4', '架空D3', '架空D2', '架空D1']);
    await expect(all(page)).not.toBeChecked(); await expect(count(page)).toHaveText('');
    await expect(page.getByRole('button', { name: /^選択した/ })).toHaveCount(0);
    // キーボード（Space）でもマウスでも選べる。一部だけ選ぶと「すべて選択」は中間の表示になる。
    await box(page, '架空D3').focus(); await page.keyboard.press('Space');
    await expect(box(page, '架空D3')).toBeChecked(); await expect(card(page, '架空D3')).toHaveClass(/selected/);
    await expect(count(page)).toHaveText('1件を選択中');
    expect(await all(page).evaluate(element => (element as HTMLInputElement).indeterminate)).toBe(true);
    await box(page, '架空D1').click(); await expect(count(page)).toHaveText('2件を選択中');
    await capture(page, 'invoice-delete-selected', 1120);
    await all(page).click(); await expect(count(page)).toHaveText('4件を選択中'); await expect(all(page)).toBeChecked();
    expect(await all(page).evaluate(element => (element as HTMLInputElement).indeterminate)).toBe(false);
    await all(page).click(); await expect(count(page)).toHaveText(''); await expect(box(page, '架空D3')).not.toBeChecked();
    await box(page, '架空D4').click(); await page.getByRole('button', { name: '選択を解除', exact: true }).click(); await expect(count(page)).toHaveText('');
    // 「選択を解除」は押すと消えるため、フォーカスは「このページをすべて選択」へ移す。
    await expect(all(page)).toBeFocused();
    // 同じ題名の請求書（複製など）も、チェック・「その他の操作」の説明（明細の行数・保存版・更新日時）で見分けられる。
    await expect(box(page, '架空D4')).toHaveAccessibleDescription(/明細 0行.*保存版 1.*10\/01/); await expect(more(page, '架空D4')).toHaveAccessibleDescription(/^明細 0行/);
    await box(page, '架空D1').click(); await box(page, '架空D3').click();
    // 選んでいないカードを1件だけ削除しても、ほかの選択は残る。
    await trash(page, '架空D2'); await page.getByRole('dialog').getByRole('button', { name: '削除する', exact: true }).click();
    await expect(titles(page)).toHaveText(['架空D4', '架空D3', '架空D1']); await expect(count(page)).toHaveText('2件を選択中');
    await page.getByRole('button', { name: '選択した2件を削除', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '2件の請求書を削除しますか？' });
    // 対象は選んだ順ではなく、一覧の表示順に並べる。
    await expect(dialog.getByRole('list', { name: '削除する請求書' }).getByRole('listitem')).toHaveText([/^架空D3/, /^架空D1/]);
    await dialog.getByRole('button', { name: '2件を削除する', exact: true }).click();
    await expect(titles(page)).toHaveText(['架空D4']);
    await expect(page.getByRole('status').filter({ hasText: '2件の請求書を削除しました' })).toBeVisible();
    await expect(count(page)).toHaveText(''); await expect(all(page)).not.toBeChecked();
    await expect(box(page, '架空D4')).toBeFocused();
    await page.reload(); await expect(titles(page)).toHaveText(['架空D4']);
  } finally { await stop(app, f); }
});

test('selection is cleared by paging and filtering, and deleting a whole later page goes back a page', async () => {
  test.setTimeout(60_000);
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow();
    await seed(f, page, Array.from({ length: 22 }, (_, index) => `架空頁${String(index + 1).padStart(2, '0')}`));
    await expect(titles(page)).toHaveCount(20);
    // 対象が多く一覧がスクロールする確認でも、既定のフォーカスは「戻る」（Enter で削除が始まらない）。
    await all(page).click(); await page.getByRole('button', { name: '選択した20件を削除', exact: true }).click();
    const many = page.getByRole('dialog', { name: '20件の請求書を削除しますか？' });
    await expect(many.getByRole('listitem')).toHaveCount(20); await expect(many.getByRole('button', { name: '戻る', exact: true })).toBeFocused();
    await page.keyboard.press('Enter'); await expect(many).toHaveCount(0); await expect(titles(page)).toHaveCount(20);
    await page.getByRole('button', { name: '選択を解除', exact: true }).click();
    await box(page, '架空頁22').click(); await expect(count(page)).toHaveText('1件を選択中');
    await page.getByRole('button', { name: '次の20件', exact: true }).click();
    await expect(titles(page)).toHaveText(['架空頁02', '架空頁01']); await expect(count(page)).toHaveText('');
    await page.getByRole('button', { name: '前の20件', exact: true }).click();
    await expect(titles(page)).toHaveCount(20); await expect(box(page, '架空頁22')).not.toBeChecked(); await expect(count(page)).toHaveText('');
    await box(page, '架空頁21').click(); await expect(count(page)).toHaveText('1件を選択中');
    await page.getByLabel('請求書を絞り込む', { exact: true }).fill('架空頁2');
    await expect(titles(page)).toHaveText(['架空頁22', '架空頁21', '架空頁20']); await expect(count(page)).toHaveText(''); await expect(box(page, '架空頁21')).not.toBeChecked();
    await page.getByLabel('請求書を絞り込む', { exact: true }).fill('');
    await expect(titles(page)).toHaveCount(20);
    await page.getByRole('button', { name: '次の20件', exact: true }).click(); await expect(titles(page)).toHaveCount(2);
    await all(page).click(); await page.getByRole('button', { name: '選択した2件を削除', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '2件を削除する', exact: true }).click();
    // 残りは20件ちょうど（1ページ）なので、ページ送りは出ない。フォーカスは、消した位置にいちばん近い前のページの最後のカードへ。
    await expect(titles(page)).toHaveCount(20); await expect(page.getByText('保存済みの請求書はありません')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '次の20件', exact: true })).toHaveCount(0); await expect(box(page, '架空頁03')).toBeFocused();
  } finally { await stop(app, f); }
});

test('with more pages, deleting the last card or the whole first page focuses the card that moves into place without flashing the empty list', async () => {
  test.setTimeout(60_000);
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow();
    await seed(f, page, Array.from({ length: 22 }, (_, index) => `架空頁${String(index + 1).padStart(2, '0')}`));
    await page.evaluate(() => {
      const flags = window as unknown as { emptyShown: boolean }; flags.emptyShown = false;
      new MutationObserver(() => { if (document.querySelector('.empty-state')) flags.emptyShown = true; }).observe(document.body, { childList: true, subtree: true });
    });
    // ページの最後のカードを消すと、次のページから繰り上がったカードがその位置に来る。
    await trash(page, '架空頁03'); await page.getByRole('dialog').getByRole('button', { name: '削除する', exact: true }).click();
    await expect(titles(page).last()).toHaveText('架空頁02'); await expect(box(page, '架空頁02')).toBeFocused();
    await all(page).click(); await page.getByRole('button', { name: '選択した20件を削除', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '20件を削除する', exact: true }).click();
    await expect(titles(page)).toHaveText(['架空頁01']); await expect(box(page, '架空頁01')).toBeFocused();
    expect(await page.evaluate(() => (window as unknown as { emptyShown: boolean }).emptyShown)).toBe(false);
  } finally { await stop(app, f); }
});

test('focus waits for the reload after a delete, but never takes focus the user moved, and paging or filtering cancels it', async () => {
  test.setTimeout(60_000);
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow();
    await seed(f, page, Array.from({ length: 23 }, (_, index) => `架空頁${String(index + 1).padStart(2, '0')}`));
    const filter = page.getByLabel('請求書を絞り込む', { exact: true }), heading = page.getByRole('heading', { name: '請求書', exact: true, level: 1 });
    const confirm = async (title: string): Promise<void> => { await trash(page, title); await page.getByRole('dialog').getByRole('button', { name: '削除する', exact: true }).click(); };
    const bodyFocused = (): Promise<boolean> => page.evaluate(() => document.activeElement === document.body);
    // 削除の後の読み直しを保留し、その間に絞り込み欄へ移る。読み直しが終わっても、絞り込み欄からフォーカスを奪わない。
    await app.intercept('documents:list', { hold: 'test:list:moved', holdFirstOnly: true });
    await confirm('架空頁04'); await expect(card(page, '架空頁04')).toHaveCount(0);
    await filter.click();
    await app.release('test:list:moved'); await expect(titles(page).last()).toHaveText('架空頁03');
    await expect(filter).toBeFocused();
    // 読み直しの間にページを送ったら、移す予定を取り消す（2ページ目のカードへ飛ばない）。
    await app.intercept('documents:list', { hold: 'test:list:paged', holdFirstOnly: true });
    await confirm('架空頁10');
    await page.getByRole('button', { name: '次の20件', exact: true }).click(); await expect(titles(page)).toHaveText(['架空頁01']);
    expect(await bodyFocused()).toBe(true);
    await app.release('test:list:paged');
    await page.getByRole('button', { name: '前の20件', exact: true }).click(); await expect(titles(page)).toHaveCount(20);
    // 読み直しの間に絞り込んだら、移す予定を取り消す（入力した後にほかの所を押しても、絞り込んだ一覧のカードへ飛ばない）。
    await app.intercept('documents:list', { hold: 'test:list:filtered', holdFirstOnly: true });
    await confirm('架空頁20');
    await filter.fill('架空頁1'); await heading.click(); expect(await bodyFocused()).toBe(true);
    await expect(titles(page)).toHaveText(['架空頁19', '架空頁18', '架空頁17', '架空頁16', '架空頁15', '架空頁14', '架空頁13', '架空頁12', '架空頁11']);
    expect(await bodyFocused()).toBe(true);
    await app.release('test:list:filtered'); await filter.fill(''); await expect(titles(page)).toHaveCount(20);
    // 読み直しに失敗したら移さず、「一覧を再試行」で読めたときに、消した位置のカードへ移す。
    await app.intercept('documents:list', { replace: { status: 'error', code: 'DB', message: '架空の一覧の失敗です。', correlationId: 'test' } });
    await confirm('架空頁22');
    await expect(page.getByRole('alert').filter({ hasText: '架空の一覧の失敗です。' })).toBeVisible(); expect(await bodyFocused()).toBe(true);
    await app.intercept('documents:list', null);
    await page.getByRole('button', { name: '一覧を再試行', exact: true }).click();
    await expect(box(page, '架空頁21')).toBeFocused();
  } finally { await stop(app, f); }
});

test('the sticky selection bar never covers the control focused while tabbing back through the list', async () => {
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow();
    await seed(f, page, Array.from({ length: 20 }, (_, index) => `架空S${String(index + 1).padStart(2, '0')}`));
    const frames = (): Promise<void> => page.evaluate(() => new Promise<void>(resolve => { requestAnimationFrame(() => requestAnimationFrame(() => resolve())); }));
    const hiddenFocus = (): Promise<string | null> => page.evaluate(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement) || !element.closest('.invoice-cards')) return null;
      const rect = element.getBoundingClientRect(), x = rect.left + rect.width / 2;
      const visible = [rect.top + 1, rect.top + rect.height / 2, rect.bottom - 1].every(y => { const hit = document.elementFromPoint(x, y); return hit !== null && (element.contains(hit) || hit.contains(element)); });
      return visible ? null : element.getAttribute('aria-label') ?? element.textContent;
    });
    // フォーカス中の一覧の欄の見え方: 見える範囲の外（outside）・全部見えている（visible）・見える範囲に掛かっているのに一部でも隠れている（covered）。
    const focusState = (): Promise<'outside' | 'visible' | 'covered'> => page.evaluate(() => {
      const element = document.activeElement, area = document.querySelector('.app-main');
      if (!(element instanceof HTMLElement) || !element.closest('.invoice-cards') || !area) throw new Error('focus');
      const rect = element.getBoundingClientRect(), view = area.getBoundingClientRect(), x = rect.left + rect.width / 2;
      if (rect.bottom <= view.top || rect.top >= view.bottom) return 'outside';
      const probes = [rect.top + 1, rect.top + rect.height / 2, rect.bottom - 1];
      return probes.every(y => { const hit = y > view.top && y < view.bottom ? document.elementFromPoint(x, y) : null; return hit !== null && (element.contains(hit) || hit.contains(element)); }) ? 'visible' : 'covered';
    });
    const scroller = page.locator('.app-main');
    const barHeight = (): Promise<number> => page.getByRole('group', { name: '請求書の選択' }).evaluate(element => (element as HTMLElement).offsetHeight);
    for (const width of [1120, 600]) {
      await page.setViewportSize({ width, height: width === 1120 ? 760 : 600 });
      await box(page, '架空S05').check();
      await more(page, '架空S01').focus();
      const covered: string[] = [];
      for (let step = 0; step < 60; step++) {
        await page.keyboard.press('Shift+Tab');
        const hidden = await hiddenFocus();
        if (hidden) covered.push(hidden);
      }
      expect(covered, `幅 ${width}`).toEqual([]);
      // 選んでいない帯のすぐ下のチェックを Space で選ぶと、狭い幅では帯が2段に伸びる。そのときもフォーカス中のチェックを隠さない。
      // 解除で縮んだ帯を描画させてから置き直す（描画をはさまずに 伸びる→縮む→伸びる と変わると、ResizeObserver は変化なしとみなして呼ばれない）。
      await page.getByRole('button', { name: '選択を解除', exact: true }).click(); await frames();
      const target = box(page, '架空S14');
      await target.evaluate(element => { const scroller = element.closest('.app-main'); if (!(scroller instanceof HTMLElement)) throw new Error('scroller'); scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 66; (element as HTMLElement).focus({ preventScroll: true }); });
      const idle = await barHeight();
      await expect(target).toBeFocused();
      expect(await hiddenFocus(), `幅 ${width}: 前提: 選ぶ前は隠れていない（帯の高さや余白が変わってテストの置き方が合わなくなった、またはほかの要素に覆われた・見える範囲の外にある）`).toBeNull();
      await page.keyboard.press('Space'); await expect(target).toBeChecked();
      // 帯の高さの変化への対応（ResizeObserver）は描画の前に動く前提。2回描画を待ったら、隠れていてはいけない。
      // 確かめる時点は選んでから少なくとも2フレーム後（選んでから待ちが始まるまで、また待ちが終わってから確かめるまでに入った描画の数だけ後ろへずれる。帯の色の切り替え（0.15秒）の間は
      // 描画が続くため、テストの応答が遅いとさらに後になる）で、それまでに直らない遅れはここで見つける。それより短い遅れはここを通ることがあるが、
      // 後の最初の描画の確認が、遅れの長さによらず見つける。広い幅では帯の高さが変わらないため、ここは必ず通る（遅れの説明は狭い幅のもの）。
      await frames();
      expect(await hiddenFocus(), `幅 ${width}: 選んで2回描画した後も、フォーカス中のチェックが帯の下に隠れている（戻す処理が動いていない・足りない、または2回描画を待っても間に合わないほど遅れた）`).toBeNull(); await expect(target).toBeFocused();
      // 前提: 狭い幅では、選ぶと帯が2段に伸びる（伸びないと、この確認は高さの変化を通らない）。
      if (width === 600) expect(await barHeight()).toBeGreaterThan(idle + 20);
      // 解除で縮んだ帯を描画させてから選ぶ（描画をはさまずに 伸びる→縮む→伸びる と変わると、ResizeObserver は変化なしとみなして呼ばれない。人の操作では起きない）。
      await page.getByRole('button', { name: '選択を解除', exact: true }).click(); await frames();
      // 前提そのもの: 帯の大きさの変化への対応（画面の ResizeObserver）は、変化の後の最初の描画より前に済む（1フレームでも帯の下に隠れて描かれない）。
      // 画面の後に作った ResizeObserver は、同じ描画の更新の中で画面の後に呼ばれる（作った順）。そこで読む位置が、最初に描かれる位置。
      // その時点で、描画の更新の rAF は済み、rAF から送ったタスクはまだ動いていない（＝描画の前）ことも確かめる（ブラウザ側の前提）。
      // 狭い幅では、測った描画で帯がもう伸びていることも確かめる（選んだ結果が最初の描画に間に合っている前提）。
      // 広い幅では帯の高さは変わらないため、位置の確認は必ず通る。確かめるのは、同じ描画の更新の中で読んでいることだけ。
      const first = await target.evaluate(element => new Promise<{ readonly before: number; readonly top: number; readonly barBottom: number; readonly height: number; readonly sameUpdate: boolean }>((resolve, reject) => {
        const area = element.closest('.app-main'), bar = document.querySelector('.select-bar');
        if (!(area instanceof HTMLElement) || !(element instanceof HTMLInputElement) || !bar) { reject(new Error('elements')); return; }
        area.scrollTop += element.getBoundingClientRect().top - area.getBoundingClientRect().top - 66; element.focus({ preventScroll: true });
        const before = element.getBoundingClientRect().top;
        let framed = false, afterUpdate = false;
        requestAnimationFrame(() => { framed = true; const channel = new MessageChannel(); channel.port1.onmessage = () => { afterUpdate = true; channel.port1.close(); }; channel.port2.postMessage(0); });
        const probe = new ResizeObserver(() => { probe.disconnect(); resolve({ before, top: element.getBoundingClientRect().top, barBottom: bar.getBoundingClientRect().bottom, height: (bar as HTMLElement).offsetHeight, sameUpdate: framed && !afterUpdate }); });
        probe.observe(bar); element.click();
      }));
      expect(first.sameUpdate, `幅 ${width}`).toBe(true);
      // 広い幅は帯の下に隠れていないことだけ。狭い幅は、原因を示す位置の確認で（帯の下端 + 16px にあれば隠れていない）。
      if (width === 1120) expect(first.top, `幅 ${width}`).toBeGreaterThanOrEqual(first.barBottom);
      if (width === 600) {
        expect(first.height, '幅 600: 測った描画で帯がまだ伸びていない（選んだ結果が最初の描画に間に合う前提が崩れた）').toBeGreaterThan(idle + 20);
        // 最初の描画で戻す処理が動いた: チェックの上端が帯の下端から余白（16px）の位置にある（スクロールアンカーで一覧が保たれ、帯の下に入った欄を戻した）。
        // 失敗したときは、選ぶ前からの動きで原因を示す（帯の伸びた分だけ動いたなら、スクロールアンカーで一覧が保たれる前提が崩れて一覧ごと下へずれた可能性）。
        const gap = first.top - (first.barBottom + 16), moved = first.top - first.before, grown = first.height - idle;
        // 最後の位置だけで見分けるため、アンカーが効いていても、戻す処理が一覧を帯の伸びた分だけしか動かさなかった場合（目標の帯の下端 + 16px より手前で止まる）も同じ値になる。
        const cause = Math.abs(moved - grown) < 1 ? 'スクロールアンカーで一覧が保たれる前提が崩れ、一覧が帯の伸びた分だけ下へずれた可能性（戻す処理が一覧を帯の伸びた分だけ動かした場合も同じ値）' : gap < 0 ? '最初の描画までに戻す処理が動いていない（遅れた場合を含む）・足りない' : '戻しすぎ';
        expect(Math.abs(gap), `幅 600: 最初の描画でチェックが帯の下端 + 16px から ${gap.toFixed(2)}px ずれた（${cause}。選ぶ前からの動き ${moved.toFixed(2)}px、帯の伸び ${grown}px）`).toBeLessThan(1);
      }
      await page.getByRole('button', { name: '選択を解除', exact: true }).click();
    }
    // 帯が上に固定されていない一覧の先頭で、画面の下端近くのチェックを Space で選ぶと、狭い幅では帯が2段に伸びて一覧が下へずれる。
    // そのときも、チェックを見える範囲の下へ押し出したままにしない。
    await page.setViewportSize({ width: 600, height: 560 }); await scroller.evaluate(element => { element.scrollTop = 0; }); await frames();
    // 架空S19 のチェックの下端が見える範囲の下端から 22px 上に来るよう、高さを合わせる（見出しなど一覧の上にあるものの高さによらず、帯の伸び（約46px）より近くに置く）。
    const offset = await box(page, '架空S19').evaluate(element => { const area = element.closest('.app-main'); if (!area) throw new Error('scroller'); return area.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom; });
    await page.setViewportSize({ width: 600, height: 560 - Math.round(offset) + 22 }); await frames();
    await more(page, '架空S20').focus(); await page.keyboard.press('Tab'); await expect(box(page, '架空S19')).toBeFocused();
    expect(await scroller.evaluate(element => element.scrollTop)).toBe(0);
    const nearBottom = await box(page, '架空S19').evaluate(element => { const area = element.closest('.app-main'); if (!area) throw new Error('scroller'); return area.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom; });
    const before = await barHeight();
    expect(nearBottom).toBeGreaterThan(0);
    await page.keyboard.press('Space'); await frames();
    // 前提: 帯が伸びた分が、チェックの下端から見える範囲の下端までより大きい（直さないと押し出される）。
    expect(await barHeight() - before).toBeGreaterThan(nearBottom); expect(await focusState()).toBe('visible');
    // 戻す処理が動いた: チェックの下端が、見える範囲の下端にそろう。
    expect(Math.abs(await box(page, '架空S19').evaluate(element => { const area = element.closest('.app-main'); if (!area) throw new Error('scroller'); return area.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom; }))).toBeLessThan(1);
    await page.getByRole('button', { name: '選択を解除', exact: true }).click();
    // 帯が伸びても、見える範囲の下へ大きく外れているフォーカス中の欄へは、一覧を引き戻さない。
    await page.setViewportSize({ width: 1120, height: 760 }); await box(page, '架空S01').check();
    await scroller.evaluate(element => { element.scrollTop = 0; }); await frames();
    await box(page, '架空S02').evaluate(element => { (element as HTMLElement).focus({ preventScroll: true }); });
    expect(await focusState()).toBe('outside');
    const grownFrom = await barHeight();
    await page.setViewportSize({ width: 600, height: 560 }); await frames();
    expect(await barHeight()).toBeGreaterThan(grownFrom + 20);
    expect(await scroller.evaluate(element => element.scrollTop)).toBe(0); expect(await focusState()).toBe('outside');
    await page.getByRole('button', { name: '選択を解除', exact: true }).click();
    // 幅が変わっても（帯が1段⇔2段に変わるときを含む）、読み進めて見える範囲の外にあるフォーカス中の欄へ、一覧を引き戻さない。
    await page.setViewportSize({ width: 1120, height: 760 });
    // 1120→960 は、スクロールバーが幅を取るかどうかに関わらず3列から2列に変わる（一覧が伸び、スクロールアンカーで位置が下へ動く）。
    for (const [from, to, picked] of [[1120, 960, false], [1120, 600, true], [600, 1120, true]] as const) {
      await page.setViewportSize({ width: from, height: 760 }); await frames();
      if (picked) await box(page, '架空S01').check();
      await box(page, '架空S20').focus();
      const before = await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; return element.scrollTop; });
      expect(before).toBeGreaterThan(200);
      await page.setViewportSize({ width: to, height: 760 }); await frames();
      // フォーカス中の欄（上へ外れている）の方へは動かない。並びの変化でスクロールの位置は変わることがある（一覧が縮むと最大の位置に詰められる。
      // 列が減って一覧が伸びると、1120→960 ではスクロールアンカーで下へ動き、一覧の余白も変わる 760px 以下への変化（1120→600）ではアンカーが止まって動かない）。
      expect(await scroller.evaluate(element => element.scrollTop), `${from}→${to}`).toBeGreaterThanOrEqual(await scroller.evaluate((element, start) => Math.min(start, element.scrollHeight - element.clientHeight), before));
      expect(await focusState(), `${from}→${to}`).toBe('outside');
      if (picked) await page.getByRole('button', { name: '選択を解除', exact: true }).click();
    }
    // 幅だけが変わって並びが変わり、帯のすぐ下にあったフォーカス中のチェックが帯の下に入ったときは、見える位置へ戻す
    // （この並びと高さ600px では、架空S11 は戻さないと、見える範囲に掛かったまま帯の下に隠れる。高さ760px では、一覧が縮んで最大の位置に詰められ、帯の下に入らない）。
    await page.setViewportSize({ width: 760, height: 600 }); await frames();
    await box(page, '架空S11').evaluate(element => { const area = element.closest('.app-main'); if (!(area instanceof HTMLElement)) throw new Error('scroller'); area.scrollTop += element.getBoundingClientRect().top - area.getBoundingClientRect().top - 66; (element as HTMLElement).focus({ preventScroll: true }); });
    await page.setViewportSize({ width: 1120, height: 600 }); await frames();
    expect(await focusState(), '760→1120').toBe('visible');
    // 戻す処理が動いた: チェックの上端が、帯の下端から余白（16px）の位置にそろう。
    expect(Math.abs(await box(page, '架空S11').evaluate(element => { const bar = document.querySelector('.select-bar'); if (!bar) throw new Error('bar'); return element.getBoundingClientRect().top - (bar.getBoundingClientRect().bottom + 16); }))).toBeLessThan(1);
    // 帯の余白は、帯があるときだけ取る（帯の高さ + 16px）。一覧が空のとき・ほかの画面では取らない。
    const padding = (): Promise<string> => scroller.evaluate(element => getComputedStyle(element).scrollPaddingTop);
    const barPadding = async (): Promise<string> => `${await page.getByRole('group', { name: '請求書の選択' }).evaluate(element => (element as HTMLElement).offsetHeight) + 16}px`;
    await frames(); expect(await padding()).toBe(await barPadding());
    await page.getByLabel('請求書を絞り込む', { exact: true }).fill('該当しない架空の語');
    await expect(page.getByText('条件に合う請求書はありません。絞り込みを変更してください。')).toBeVisible(); expect(await padding()).toBe('auto');
    await page.getByLabel('請求書を絞り込む', { exact: true }).fill(''); await expect(titles(page)).toHaveCount(20); await frames(); expect(await padding()).toBe(await barPadding());
    await page.getByRole('button', { name: '材料', exact: true }).click(); await expect(page.getByRole('checkbox', { name: '無効も表示', exact: true })).toBeVisible();
    expect(await padding()).toBe('auto');
    await page.getByRole('button', { name: '請求書', exact: true }).click(); await expect(titles(page)).toHaveCount(20); await frames(); expect(await padding()).toBe(await barPadding());
  } finally { await stop(app, f); }
});

test('Ctrl+N starts a new invoice from a list checkbox, but not from the filter or from checkboxes on other screens', async () => {
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow();
    await seed(f, page, ['架空N1']);
    // 新しい請求書を開く要求（documents:open）を数える。画面が移る前に確かめても見逃さないよう、要求の回数で判定する。
    await app.intercept('documents:open', { record: ['test:new-invoice'] });
    // 受け付けたときの要求が届くまで少し待ってから、0回のままかを確かめる（失敗の理由がそのまま分かるように）。
    const unchanged = async (): Promise<void> => { await page.waitForTimeout(300); expect(await app.count('test:new-invoice')).toBe(0); };
    await page.getByLabel('請求書を絞り込む', { exact: true }).focus(); await page.keyboard.press('Control+n'); await unchanged();
    await page.getByRole('button', { name: '材料', exact: true }).click();
    const inactive = page.getByRole('checkbox', { name: '無効も表示', exact: true });
    await inactive.focus(); await page.keyboard.press('Control+n'); await unchanged();
    await expect(inactive).toBeVisible();
    await page.getByRole('button', { name: '請求書', exact: true }).click();
    await box(page, '架空N1').focus();
    expect(await app.count('test:new-invoice')).toBe(0);
    await page.keyboard.press('Control+n');
    await expect(page.getByLabel('管理用タイトル', { exact: true })).toBeVisible(); expect(await app.count('test:new-invoice')).toBe(1);
  } finally { await stop(app, f); }
});

test('deleting the open invoice closes it so the next palette add starts a new one; deleting a copy source keeps the copy and backups', async () => {
  test.setTimeout(60_000);
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow();
    const categoryId = randomUUID(), db = f.database();
    try {
      db.prepare('INSERT INTO categories VALUES (?,?,?,?)').run(...values(categoryId, '架空カテゴリ', 0, 1));
      db.prepare('INSERT INTO materials(id,category_id,name,model,manufacturer,quantity,remarks,unit_price,search_text,active,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...values(randomUUID(), categoryId, '架空削除材料', '001-A', '架空社', '1', '', '', '架空削除材料', 1, 1, 'now', 'now'));
    } finally { db.close(); }
    await page.getByRole('button', { name: /^新規請求書/ }).click();
    await page.getByLabel('管理用タイトル', { exact: true }).fill('架空開いている');
    await page.keyboard.press('Control+s'); await expect(page.getByRole('status', { name: '保存状態' })).toHaveText('保存済み');
    await page.getByRole('button', { name: '← 請求書一覧', exact: true }).click();
    await expect(card(page, '架空開いている')).toHaveClass(/current/);
    await trash(page, '架空開いている'); await page.getByRole('dialog').getByRole('button', { name: '削除する', exact: true }).click();
    await expect(card(page, '架空開いている')).toHaveCount(0);
    // 一覧から材料パレットで追加すると、削除した請求書へ入れようとせず（エラーや復活をせず）、新しい請求書になる。
    await page.keyboard.press('Control+f');
    const palette = page.getByRole('dialog', { name: '材料検索' });
    await palette.getByLabel('キーワード', { exact: true }).fill('架空削除材料');
    await palette.locator('.search-result').first().click(); await palette.getByRole('button', { name: /^1件を明細に追加/ }).click();
    await expect(page.getByLabel('明細1 品名', { exact: true })).toHaveValue('架空削除材料');
    await expect(page.getByLabel('管理用タイトル', { exact: true })).toHaveValue('');
    await page.keyboard.press('Control+s'); await expect(page.getByRole('status', { name: '保存状態' })).toHaveText('保存済み');
    await expect(page.locator('.app-message')).toHaveCount(0);
    await page.getByRole('button', { name: '← 請求書一覧', exact: true }).click();
    await expect(titles(page)).toHaveText(['（タイトルなし）']);
    // 題名のない請求書のチェック・「その他の操作」は、上部欄と更新日時を添えた名前で見分けられる。
    await expect(card(page, '（タイトルなし）').getByRole('checkbox')).toHaveAccessibleName(/^「（タイトルなし）」（上部欄 未入力・\d\d\/\d\d \d\d:\d\d）を選択$/);
    await expect(card(page, '（タイトルなし）').getByRole('button', { name: /^「（タイトルなし）」（上部欄 未入力・.+）のその他の操作$/ })).toBeVisible();
    // 複製元を削除しても複製は残り（「複製」の表示だけが外れる）、外部キーの検査があるバックアップも作れる。
    const [source] = await seed(f, page, ['架空複製元']);
    if (!source) throw new Error('seed');
    await page.evaluate(async id => { const copy = await window.appApi.documents.duplicate(id); if (copy.status !== 'ok') throw new Error('duplicate'); const saved = await window.appApi.documents.save({ sessionId: copy.data.sessionId, requestNumber: 1, generation: 1, expectedRevision: 0, draft: { ...copy.data.draft, title: '架空複製' } }); if (saved.status !== 'ok') throw new Error('save'); }, source);
    await page.reload(); await expect(card(page, '架空複製')).toContainText('複製');
    await trash(page, '架空複製元'); await page.getByRole('dialog').getByRole('button', { name: '削除する', exact: true }).click();
    await expect(card(page, '架空複製元')).toHaveCount(0); await expect(card(page, '架空複製').locator('.invoice-meta')).not.toContainText('複製');
    await app.dialog('save', path.join(f.root, 'after-delete.pombak'));
    expect((await page.evaluate(() => window.appApi.backups.create())).status).toBe('ok');
  } finally { await stop(app, f); }
});

test('a failed or lost delete keeps the selection, reloads the list, and the controls are locked while it runs', async () => {
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow();
    const [, second] = await seed(f, page, ['架空失敗1', '架空失敗2', '架空失敗3']);
    const confirm = async (label: string): Promise<void> => { await page.getByRole('dialog').getByRole('button', { name: label, exact: true }).click(); };
    // 本体がエラーを返す: 何も消えず、選択も残る。
    await app.intercept('documents:delete', { replace: { status: 'error', code: 'DB', message: '架空の削除失敗です。', correlationId: 'test' } });
    await box(page, '架空失敗1').click(); await box(page, '架空失敗3').click();
    await page.getByRole('button', { name: '選択した2件を削除', exact: true }).click(); await confirm('2件を削除する');
    await expect(page.getByRole('alert').filter({ hasText: '架空の削除失敗です。' })).toBeVisible();
    await expect(titles(page)).toHaveText(['架空失敗3', '架空失敗2', '架空失敗1']); await expect(count(page)).toHaveText('2件を選択中');
    await expect(page.getByRole('button', { name: '選択した2件を削除', exact: true })).toBeFocused();
    // 削除の処理中は、チェック・開く・「その他の操作」を押せない。
    await app.intercept('documents:delete', { hold: 'test:delete:release' });
    await page.getByRole('button', { name: '選択した2件を削除', exact: true }).click(); await confirm('2件を削除する');
    await expect(box(page, '架空失敗2')).toBeDisabled(); await expect(all(page)).toBeDisabled();
    await expect(card(page, '架空失敗2').getByRole('button', { name: /を開く$/ })).toBeDisabled(); await expect(more(page, '架空失敗2')).toBeDisabled();
    await app.release('test:delete:release');
    await expect(titles(page)).toHaveText(['架空失敗2']); await expect(count(page)).toHaveText('');
    await expect(page.locator('.app-message')).toHaveCount(0);
    // 削除は本体で済んだが応答が届かない: 結果を確認できない旨を出し、読み直した一覧で消えたことが分かる。
    await app.intercept('documents:delete', { dropFirst: true });
    await trash(page, '架空失敗2'); await confirm('削除する');
    await expect(page.getByRole('alert').filter({ hasText: '削除の結果を確認できませんでした。' })).toBeVisible();
    await expect(page.getByText('保存済みの請求書はありません。「新規請求書」から作成してください。')).toBeVisible();
    await expect(page.getByRole('button', { name: /^新規請求書/ })).toBeFocused();
    // 届く前に失われた（本体が削除していない）ときも結果は分からないため、開いている請求書は閉じる（一覧には残る）。
    const [kept] = await seed(f, page, ['架空開いたまま']);
    await card(page, '架空開いたまま').getByRole('button', { name: /を開く$/ }).click();
    await page.getByRole('button', { name: '← 請求書一覧', exact: true }).click(); await expect(card(page, '架空開いたまま')).toHaveClass(/current/);
    await app.intercept('documents:delete', { reject: true });
    await trash(page, '架空開いたまま'); await confirm('削除する');
    await expect(page.getByRole('alert').filter({ hasText: '削除の結果を確認できませんでした。' })).toBeVisible();
    await expect(card(page, '架空開いたまま')).toBeVisible(); await expect(card(page, '架空開いたまま')).not.toHaveClass(/current/);
    await expect(box(page, '架空開いたまま')).toBeFocused();
    // 処理中は絞り込み欄も使えない（入力した欄から、終わった後にフォーカスを奪わないため）。終わったらフォーカスは「新規請求書」へ。
    await app.intercept('documents:delete', { hold: 'test:delete:filter' });
    await trash(page, '架空開いたまま'); await confirm('削除する');
    await expect(box(page, '架空開いたまま')).toBeDisabled(); await expect(page.getByLabel('請求書を絞り込む', { exact: true })).toBeDisabled();
    await app.release('test:delete:filter');
    await expect(page.getByText('保存済みの請求書はありません。「新規請求書」から作成してください。')).toBeVisible();
    await expect(page.getByRole('button', { name: /^新規請求書/ })).toBeFocused(); await expect(page.getByLabel('請求書を絞り込む', { exact: true })).toBeEnabled();
    expect(kept).toBeTruthy();
    // 同じ ID の再送は成功にする（削除済みは数えない）。
    await app.intercept('documents:delete', null);
    expect(await page.evaluate(id => window.appApi.documents.delete([id]), second ?? '')).toEqual({ status: 'ok', data: { deleted: 0 } });
  } finally { await stop(app, f); }
});
