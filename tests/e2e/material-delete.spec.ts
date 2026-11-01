import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { capture, fixture } from './app';
import type { TestApp } from './app';

// 材料の削除（材料台帳から1件ずつ・選んでまとめて）。組合せは、選択（ページ・検索条件ごと。編集の保存の後は残す）× 確認（戻る・Esc・Enter・削除）
// × 結果（成功・失敗・応答なし・バックアップ中）× 削除の後のページ（行が残る・後ろの行が繰り上がる・前のページへ戻る・何も残らない）
// × 削除した材料の行方（材料検索・カテゴリの件数・材料パレットの選択・作成済みの請求書）。どれも材料台帳にいたまま（フォーカスを動かさずに）操作する。
// 前提にした画面の動き: フォーカスしていた行を消すとフォーカスは body に落ちる（読み直しを保留して確かめる）。

/** app.ts の prepare(...).run は引数の型が never[] で値を渡せないため、ここで型を合わせる。 */
const values = (...items: (string | number | null)[]): never[] => items as never[];
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** カテゴリ1つに材料（[品名, 型式, 有効か]）をDBへ直接登録し、品名ごとの ID を返す。架空配管以外のカテゴリは、架空配管の後に並べる。 */
function seed(f: Fixture, materials: readonly (readonly [string, string, boolean?])[], categoryName = '架空配管'): Map<string, string> {
  const db = f.database(), ids = new Map<string, string>(), category = randomUUID();
  try {
    db.prepare('INSERT INTO categories VALUES (?,?,?,?)').run(...values(category, categoryName, categoryName === '架空配管' ? 0 : 1, 1));
    const insert = db.prepare('INSERT INTO materials(id,category_id,name,model,manufacturer,quantity,remarks,unit_price,search_text,active,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const [name, model, active = true] of materials) { const id = randomUUID(); ids.set(name, id); insert.run(...values(id, category, name, model, '架空社', '01 個', '', '', name, active ? 1 : 0, 1, 'now', 'now')); }
  } finally { db.close(); }
  return ids;
}
/** 削除した日時（削除していなければ null）。 */
const deletedAt = (f: Fixture, id: string): unknown => { const db = f.database(); try { return db.prepare('SELECT deleted_at FROM materials WHERE id=?').get(...values(id))?.['deleted_at']; } finally { db.close(); } };

const ledger = (page: Page) => page.getByRole('region', { name: '材料' });
const table = (page: Page) => page.getByRole('table', { name: '材料台帳' });
const names = (page: Page) => table(page).locator('tbody tr td:nth-child(2)');
const box = (page: Page, label: string) => table(page).getByRole('checkbox', { name: `${label}を選択`, exact: true });
const trash = (page: Page, label: string) => table(page).getByRole('button', { name: `${label}を削除`, exact: true });
const all = (page: Page) => ledger(page).getByRole('checkbox', { name: 'このページをすべて選択', exact: true });
const count = (page: Page) => ledger(page).getByRole('group', { name: '材料の選択' }).locator('.select-count');
const status = (page: Page) => ledger(page).locator('p[role="status"]:not([aria-label])');
const keyword = (page: Page) => ledger(page).getByRole('searchbox', { name: 'キーワード', exact: true });
const categoryButton = (page: Page, name: string) => ledger(page).getByRole('group', { name: 'カテゴリ' }).getByRole('button', { name: new RegExp(`^${name}`) });
const palette = (page: Page) => page.getByRole('dialog', { name: '材料検索' });
const bodyFocused = (page: Page): Promise<boolean> => page.evaluate(() => document.activeElement === document.body);
/** 材料台帳を開き直す（DBへ直接登録した材料を読み込む）。 */
async function openLedger(page: Page): Promise<void> {
  await page.getByRole('button', { name: '請求書', exact: true }).click(); await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: '材料', exact: true }).click(); await expect(table(page).or(ledger(page).getByText(/^(該当する|表示できる)材料はありません/))).toBeVisible();
}
async function confirm(page: Page, label: string): Promise<void> { await page.getByRole('dialog').getByRole('button', { name: label, exact: true }).click(); }
async function stop(app: TestApp, f: Fixture): Promise<void> { await app.close(); await f.cleanup(); }

test('single delete asks first, keeps the material on 戻る, Esc or Enter, hides it from search and counts, and focuses the row that took its place', async () => {
  test.setTimeout(60_000);
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow();
    const ids = seed(f, [['架空削除A', 'A-1'], ['架空削除B', 'B-1'], ['架空削除C', 'C-1']]);
    const b = ids.get('架空削除B') ?? '';
    // 架空削除B を明細に持つ請求書（削除しても明細の値は変わらない）。
    await page.evaluate(async id => {
      const opened = await window.appApi.documents.open(null); if (opened.status !== 'ok') throw new Error('open');
      const line = await window.appApi.documents.addLine({ sessionId: opened.data.sessionId, materialId: id }); if (line.status !== 'ok') throw new Error('line');
      const saved = await window.appApi.documents.save({ sessionId: opened.data.sessionId, requestNumber: 1, generation: 1, expectedRevision: 0, draft: { ...opened.data.draft, title: '架空明細あり', lines: [line.data] } });
      if (saved.status !== 'ok') throw new Error('save');
    }, b);
    await openLedger(page);
    await expect(names(page)).toHaveText(['架空削除A', '架空削除B', '架空削除C']);
    const dialog = page.getByRole('dialog', { name: 'この材料を削除しますか？' });
    // 戻る・Esc・Enter（既定のフォーカスは「戻る」）では何も削除せず、押したボタンへフォーカスが戻る。確認の間は Ctrl+F で材料パレットを開かない。
    for (const close of ['戻る', 'Escape', 'Enter']) {
      await trash(page, '架空削除B B-1').click();
      await expect(dialog.getByRole('list', { name: '削除する材料' }).getByRole('listitem')).toHaveText(['架空削除BB-1 ・ 架空社 ・ 架空配管']);
      await expect(dialog.getByRole('button', { name: '戻る', exact: true })).toBeFocused();
      await page.keyboard.press('Control+f'); await expect(palette(page)).toHaveCount(0);
      await expect(page.getByRole('button', { name: '請求書', exact: true })).toBeDisabled();
      if (close === '戻る') await dialog.getByRole('button', { name: '戻る', exact: true }).click(); else await page.keyboard.press(close);
      await expect(dialog).toHaveCount(0); await expect(trash(page, '架空削除B B-1')).toBeFocused();
      await expect(names(page)).toHaveText(['架空削除A', '架空削除B', '架空削除C']);
    }
    expect(deletedAt(f, b)).toBeNull();
    await trash(page, '架空削除B B-1').click();
    await capture(page, 'material-delete-confirm', 1120);
    await confirm(page, '削除する');
    await expect(names(page)).toHaveText(['架空削除A', '架空削除C']);
    await expect(page.getByRole('status').filter({ hasText: '「架空削除B B-1」を削除しました' })).toBeVisible();
    // 消えた行の位置に来た行（架空削除C）のチェックへフォーカスを移す。件数・カテゴリの件数も変わる。
    await expect(box(page, '架空削除C C-1')).toBeFocused();
    await expect(status(page)).toHaveText('2件中 1～2件');
    await expect(categoryButton(page, '架空配管').locator('.count')).toHaveText('2'); await expect(categoryButton(page, 'すべて').locator('.count')).toHaveText('2');
    expect(deletedAt(f, b)).toEqual(expect.any(String));
    // 無効も表示しても、材料パレットでも出ない。
    await ledger(page).getByRole('checkbox', { name: '無効も表示', exact: true }).check(); await expect(names(page)).toHaveText(['架空削除A', '架空削除C']);
    await ledger(page).getByRole('checkbox', { name: '無効も表示', exact: true }).uncheck();
    await page.keyboard.press('Control+f'); await palette(page).getByRole('combobox', { name: 'キーワード', exact: true }).fill('架空削除');
    await expect(palette(page).getByRole('listbox', { name: '検索結果' }).getByRole('option')).toHaveCount(2); await page.keyboard.press('Escape');
    // 最後の行を消したら直前の行へ。すべて消したらキーワード欄へ。
    await trash(page, '架空削除C C-1').click(); await confirm(page, '削除する');
    await expect(names(page)).toHaveText(['架空削除A']); await expect(box(page, '架空削除A A-1')).toBeFocused();
    await trash(page, '架空削除A A-1').click(); await confirm(page, '削除する');
    await expect(status(page)).toHaveText('表示できる材料はありません。「Excelから取込」または「手動で追加」から登録してください（無効にした材料は「無効も表示」で表示できます）。');
    await expect(keyword(page)).toBeFocused(); await expect(categoryButton(page, '架空配管').locator('.count')).toHaveText('0');
    // 削除した材料を明細に持つ請求書は、明細の値のまま開ける。
    await page.getByRole('button', { name: '請求書', exact: true }).click();
    await page.getByRole('article', { name: '架空明細あり', exact: true }).getByRole('button', { name: /を開く$/ }).click();
    await expect(page.getByLabel('明細1 品名', { exact: true })).toHaveValue('架空削除B'); await expect(page.getByLabel('明細1 型式', { exact: true })).toHaveValue('B-1');
    await page.getByRole('button', { name: '材料', exact: true }).click();
    await expect(status(page)).toHaveText('表示できる材料はありません。「Excelから取込」または「手動で追加」から登録してください（無効にした材料は「無効も表示」で表示できます）。');
  } finally { await stop(app, f); }
});

test('bulk delete removes only the chosen materials in display order; select all toggles and the count follows the visible page', async () => {
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow();
    seed(f, [['架空D1', 'D-1'], ['架空D2', 'D-2'], ['架空D3', 'D-3', false], ['架空D4', 'D-4']]);
    await openLedger(page);
    await ledger(page).getByRole('checkbox', { name: '無効も表示', exact: true }).check();
    await expect(names(page)).toHaveText(['架空D1', '架空D2', '架空D3', '架空D4']);
    await expect(all(page)).not.toBeChecked(); await expect(count(page)).toHaveText('');
    await expect(ledger(page).getByRole('button', { name: /^選択した/ })).toHaveCount(0);
    // キーボード（Space）でもマウスでも選べる。一部だけ選ぶと「すべて選択」は中間の表示になる。
    await box(page, '架空D3 D-3').focus(); await page.keyboard.press('Space');
    await expect(box(page, '架空D3 D-3')).toBeChecked(); await expect(table(page).locator('tbody tr').nth(2)).toHaveClass(/selected/);
    await expect(count(page)).toHaveText('1件を選択中');
    expect(await all(page).evaluate(element => (element as HTMLInputElement).indeterminate)).toBe(true);
    await box(page, '架空D1 D-1').click(); await expect(count(page)).toHaveText('2件を選択中');
    for (const width of [1120, 375]) await capture(page, 'material-delete-selected', width);
    await page.setViewportSize({ width: 1120, height: 760 });
    await all(page).click(); await expect(count(page)).toHaveText('4件を選択中'); await expect(all(page)).toBeChecked();
    expect(await all(page).evaluate(element => (element as HTMLInputElement).indeterminate)).toBe(false);
    await all(page).click(); await expect(count(page)).toHaveText(''); await expect(box(page, '架空D3 D-3')).not.toBeChecked();
    // 「選択を解除」は押すと消えるため、フォーカスは「このページをすべて選択」へ移す。
    await box(page, '架空D4 D-4').click(); await ledger(page).getByRole('button', { name: '選択を解除', exact: true }).click();
    await expect(count(page)).toHaveText(''); await expect(all(page)).toBeFocused();
    // 選んでいない行を1件だけ削除しても、ほかの選択は残る。
    await box(page, '架空D3 D-3').click(); await box(page, '架空D1 D-1').click();
    await trash(page, '架空D2 D-2').click(); await confirm(page, '削除する');
    await expect(names(page)).toHaveText(['架空D1', '架空D3', '架空D4']); await expect(count(page)).toHaveText('2件を選択中');
    await ledger(page).getByRole('button', { name: '選択した2件を削除', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '2件の材料を削除しますか？' });
    // 対象は選んだ順ではなく、一覧の表示順に並べる。無効の材料はその旨を添える。
    await expect(dialog.getByRole('list', { name: '削除する材料' }).getByRole('listitem')).toHaveText(['架空D1D-1 ・ 架空社 ・ 架空配管', '架空D3D-3 ・ 架空社 ・ 架空配管 ・ 無効']);
    await confirm(page, '2件を削除する');
    await expect(names(page)).toHaveText(['架空D4']);
    await expect(page.getByRole('status').filter({ hasText: '2件の材料を削除しました' })).toBeVisible();
    await expect(count(page)).toHaveText(''); await expect(all(page)).not.toBeChecked();
    await expect(box(page, '架空D4 D-4')).toBeFocused();
    await openLedger(page); await expect(names(page)).toHaveText(['架空D4']);
  } finally { await stop(app, f); }
});

test('selection is cleared by every search change but kept after an edit, and deleting whole pages shifts rows in or goes back a page', async () => {
  test.setTimeout(90_000);
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow();
    seed(f, Array.from({ length: 52 }, (_, index) => [`架空頁${String(index + 1).padStart(2, '0')}`, `P-${index + 1}`] as const));
    seed(f, [['架空別カテゴリ', 'X-1']], '架空電材');
    await openLedger(page);
    await expect(status(page)).toHaveText('53件中 1～25件');
    const select = async (name: string): Promise<void> => { await box(page, `${name} P-${Number(name.slice(-2))}`).click(); await expect(count(page)).toHaveText('1件を選択中'); };
    // 検索語・カテゴリ・無効の表示・ページを変えると、選択を外す（戻しても選び直さない）。
    await select('架空頁01'); await keyword(page).fill('架空頁0'); await expect(names(page)).toHaveCount(9); await expect(count(page)).toHaveText('');
    await keyword(page).fill(''); await expect(names(page)).toHaveCount(25); await expect(box(page, '架空頁01 P-1')).not.toBeChecked();
    await select('架空頁02'); await categoryButton(page, '架空配管').click(); await expect(status(page)).toHaveText('52件中 1～25件'); await expect(count(page)).toHaveText('');
    await select('架空頁03'); await ledger(page).getByRole('checkbox', { name: '無効も表示', exact: true }).check(); await expect(count(page)).toHaveText('');
    await ledger(page).getByRole('checkbox', { name: '無効も表示', exact: true }).uncheck();
    await select('架空頁04'); await ledger(page).getByRole('button', { name: '次の25件', exact: true }).click();
    await expect(status(page)).toHaveText('52件中 26～50件'); await expect(count(page)).toHaveText('');
    await ledger(page).getByRole('button', { name: '前の25件', exact: true }).click(); await expect(box(page, '架空頁04 P-4')).not.toBeChecked();
    // 別の材料を編集して保存した後の読み直しでは、選択は残る。
    await select('架空頁05');
    await table(page).getByRole('button', { name: '架空頁06を編集', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '材料を編集' });
    await drawer.getByRole('textbox', { name: '備考', exact: true }).fill('架空の備考'); await drawer.getByRole('button', { name: '材料を保存', exact: true }).click();
    await expect(drawer).toHaveCount(0); await expect(table(page).locator('tbody tr').nth(5)).toContainText('架空の備考');
    await expect(box(page, '架空頁05 P-5')).toBeChecked(); await expect(count(page)).toHaveText('1件を選択中');
    await ledger(page).getByRole('button', { name: '選択を解除', exact: true }).click();
    // 先頭のページを全部消すと、後ろのページの行が繰り上がる（空の表示を出さない）。フォーカスは先頭の行へ。
    await page.evaluate(() => {
      const flags = window as unknown as { emptyShown: boolean }; flags.emptyShown = false;
      new MutationObserver(() => { if (/該当する材料はありません|表示できる材料はありません|材料はまだ登録されていません/.test(document.querySelector('.page-materials')?.textContent ?? '')) flags.emptyShown = true; }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await all(page).click(); await ledger(page).getByRole('button', { name: '選択した25件を削除', exact: true }).click();
    const many = page.getByRole('dialog', { name: '25件の材料を削除しますか？' });
    await expect(many.getByRole('listitem')).toHaveCount(25); await expect(many.getByRole('button', { name: '戻る', exact: true })).toBeFocused();
    await confirm(page, '25件を削除する');
    await expect(status(page)).toHaveText('27件中 1～25件'); await expect(names(page).first()).toHaveText('架空頁26');
    await expect(box(page, '架空頁26 P-26')).toBeFocused();
    expect(await page.evaluate(() => (window as unknown as { emptyShown: boolean }).emptyShown)).toBe(false);
    // 最後のページ（先頭以外）を全部消すと、前のページへ戻る。フォーカスはそのページの最後の行へ。
    await ledger(page).getByRole('button', { name: '次の25件', exact: true }).click(); await expect(names(page)).toHaveText(['架空頁51', '架空頁52']);
    await all(page).click(); await ledger(page).getByRole('button', { name: '選択した2件を削除', exact: true }).click(); await confirm(page, '2件を削除する');
    await expect(status(page)).toHaveText('25件中 1～25件'); await expect(ledger(page).getByRole('button', { name: '次の25件', exact: true })).toHaveCount(0);
    await expect(box(page, '架空頁50 P-50')).toBeFocused(); await expect(count(page)).toHaveText('');
    expect(await page.evaluate(() => (window as unknown as { emptyShown: boolean }).emptyShown)).toBe(false);
    // 1ページだけのときに一部を消すと、残りの行を表示したまま読み直す（カテゴリの件数も読み直す）。
    await expect(categoryButton(page, '架空配管').locator('.count')).toHaveText('25');
  } finally { await stop(app, f); }
});

test('focus waits for the reload after a delete, but never takes focus the user moved, and a search change cancels it', async () => {
  test.setTimeout(60_000);
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow();
    seed(f, Array.from({ length: 8 }, (_, index) => [`架空F${index + 1}`, `F-${index + 1}`] as const));
    await openLedger(page);
    // 読み直しを保留しても、消した行はすぐに外れ、フォーカスは body に落ちる（前提）。その間にキーワード欄へ移ったら、読み直しが終わっても奪わない。
    await app.intercept('materials:search', { hold: 'test:search:moved', holdFirstOnly: true });
    await trash(page, '架空F2 F-2').click(); await confirm(page, '削除する');
    await expect(names(page)).toHaveText(['架空F1', '架空F3', '架空F4', '架空F5', '架空F6', '架空F7', '架空F8']);
    await expect(status(page)).toHaveText('7件中 1～7件');
    expect(await bodyFocused(page)).toBe(true);
    await expect.poll(() => app.count('test:search:moved')).toBe(1);
    await keyword(page).click();
    await app.release('test:search:moved'); await expect.poll(() => app.count('test:search:moved')).toBe(0);
    await expect(names(page)).toHaveCount(7); await expect(keyword(page)).toBeFocused();
    // 読み直しの間に検索語を変えたら、移す予定を取り消す（入力した後にほかの所を押しても、新しい結果の行へ飛ばない）。
    await app.intercept('materials:search', { hold: 'test:search:changed', holdFirstOnly: true });
    await trash(page, '架空F4 F-4').click(); await confirm(page, '削除する');
    await expect.poll(() => app.count('test:search:changed')).toBe(1);
    await keyword(page).fill('架空F'); await page.getByRole('heading', { name: '材料', exact: true, level: 1 }).click(); expect(await bodyFocused(page)).toBe(true);
    await expect(names(page)).toHaveText(['架空F1', '架空F3', '架空F5', '架空F6', '架空F7', '架空F8']);
    expect(await bodyFocused(page)).toBe(true);
    await app.release('test:search:changed');
    await expect(names(page)).toHaveCount(6); expect(await bodyFocused(page)).toBe(true);
    // 読み直しに失敗したら移さず、「再試行」で読めたときに、消した位置の行へ移す。
    await app.intercept('materials:search', { replace: { status: 'error', code: 'DB', message: '架空の検索失敗です。', correlationId: 'test' } });
    await trash(page, '架空F6 F-6').click(); await confirm(page, '削除する');
    await expect(ledger(page).getByRole('alert').filter({ hasText: '架空の検索失敗です。' })).toBeVisible(); expect(await bodyFocused(page)).toBe(true);
    await app.intercept('materials:search', null);
    await ledger(page).getByRole('button', { name: '再試行', exact: true }).click();
    await expect(names(page)).toHaveText(['架空F1', '架空F3', '架空F5', '架空F7', '架空F8']); await expect(box(page, '架空F7 F-7')).toBeFocused();
  } finally { await stop(app, f); }
});

test('a failed or lost delete keeps the selection, locks the screen while it runs, and waits for a running backup', async () => {
  test.setTimeout(60_000);
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow();
    const ids = seed(f, [['架空失敗1', 'E-1'], ['架空失敗2', 'E-2'], ['架空失敗3', 'E-3']]);
    await openLedger(page);
    // 本体がエラーを返す: 何も消えず、選択も残り、押したボタンにフォーカスが残る（読み直さない）。
    await app.intercept('master:delete', { replace: { status: 'error', code: 'DB', message: '架空の削除失敗です。', correlationId: 'test' } });
    await box(page, '架空失敗1 E-1').click(); await box(page, '架空失敗3 E-3').click();
    await ledger(page).getByRole('button', { name: '選択した2件を削除', exact: true }).click(); await confirm(page, '2件を削除する');
    await expect(ledger(page).getByRole('alert').filter({ hasText: '架空の削除失敗です。' })).toBeVisible();
    await expect(names(page)).toHaveText(['架空失敗1', '架空失敗2', '架空失敗3']); await expect(count(page)).toHaveText('2件を選択中');
    await expect(ledger(page).getByRole('button', { name: '選択した2件を削除', exact: true })).toBeFocused();
    // 削除の処理中は、台帳の操作・検索の欄・タブ・材料パレットを使えない。
    await app.intercept('master:delete', { hold: 'test:delete:release' });
    await ledger(page).getByRole('button', { name: '選択した2件を削除', exact: true }).click(); await confirm(page, '2件を削除する');
    await expect.poll(() => app.count('test:delete:release')).toBe(1);
    for (const control of [box(page, '架空失敗2 E-2'), all(page), trash(page, '架空失敗2 E-2'), table(page).getByRole('button', { name: '架空失敗2を編集', exact: true }), keyword(page),
      categoryButton(page, '架空配管'), ledger(page).getByRole('checkbox', { name: '無効も表示', exact: true }), ledger(page).getByRole('button', { name: '手動で追加', exact: true }), page.getByRole('button', { name: '請求書', exact: true })]) await expect(control).toBeDisabled();
    await page.keyboard.press('Control+f'); await expect(palette(page)).toHaveCount(0);
    await app.release('test:delete:release');
    await expect(names(page)).toHaveText(['架空失敗2']); await expect(count(page)).toHaveText('');
    await expect(ledger(page).getByRole('alert')).toHaveCount(0);
    await expect(box(page, '架空失敗2 E-2')).toBeFocused();
    // 削除は本体で済んだが応答が届かない: 結果を確認できない旨を出し、読み直した一覧で消えたことが分かる。
    seed(f, [['架空不明', 'U-1']], '架空電材');
    await openLedger(page);
    await app.intercept('master:delete', { dropFirst: true });
    await trash(page, '架空失敗2 E-2').click(); await confirm(page, '削除する');
    await expect(ledger(page).getByRole('alert').filter({ hasText: '削除の結果を確認できませんでした。' })).toBeVisible();
    await expect(names(page)).toHaveText(['架空不明']); await expect(box(page, '架空不明 U-1')).toBeFocused();
    expect(deletedAt(f, ids.get('架空失敗2') ?? '')).toEqual(expect.any(String));
    // 届く前に失われた（本体が削除していない）ときは、読み直した一覧に残っている。
    await app.intercept('master:delete', { reject: true });
    await trash(page, '架空不明 U-1').click(); await confirm(page, '削除する');
    await expect(ledger(page).getByRole('alert').filter({ hasText: '削除の結果を確認できませんでした。' })).toBeVisible();
    await expect(names(page)).toHaveText(['架空不明']); await expect(box(page, '架空不明 U-1')).toBeFocused();
    await app.intercept('master:delete', null);
    // 同じ ID の再送は成功にする（削除済みは数えない）。
    expect(await page.evaluate(id => window.appApi.master.delete([id]), ids.get('架空失敗2') ?? '')).toEqual({ status: 'ok', data: { deleted: 0 } });
    // バックアップの保存先を選んでいる間は削除しない（バックアップと同時にDBを変えない）。
    await app.dialog('save', null, 'test:backup:hold');
    await page.evaluate(() => { void window.appApi.backups.create(); });
    await expect.poll(() => app.count('test:backup:hold')).toBe(1);
    expect(await page.evaluate(id => window.appApi.master.delete([id]), ids.get('架空不明') ?? '')).toMatchObject({ status: 'error', code: 'DB', message: 'バックアップ・復元中です。完了までお待ちください。' });
    await app.release('test:backup:hold');
    await openLedger(page); await expect(names(page)).toHaveText(['架空不明']);
  } finally { await stop(app, f); }
});

test('deleted materials leave the palette picks, cannot be edited from a stale form, and new backups keep them out of the count', async () => {
  test.setTimeout(60_000);
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow();
    const ids = seed(f, [['架空選択A', 'S-1'], ['架空選択B', 'S-2'], ['架空選択C', 'S-3']]);
    await openLedger(page);
    // 材料パレットで2件選んでおき、そのうち1件を台帳で削除すると、パレットの選択から外れる（もう1件は残る）。
    await page.keyboard.press('Control+f');
    const field = palette(page).getByRole('combobox', { name: 'キーワード', exact: true }), options = palette(page).getByRole('listbox', { name: '検索結果' }).getByRole('option');
    await field.fill('架空選択'); await expect(options).toHaveCount(3);
    await options.filter({ hasText: '架空選択A' }).click(); await options.filter({ hasText: '架空選択B' }).click();
    const tray = palette(page).getByRole('region', { name: '選んだ材料' });
    await expect(tray).toContainText('2件を選択中'); await page.keyboard.press('Escape');
    await trash(page, '架空選択A S-1').click(); await confirm(page, '削除する');
    await expect(names(page)).toHaveText(['架空選択B', '架空選択C']);
    await page.keyboard.press('Control+f'); await expect(tray).toContainText('1件を選択中');
    await expect(tray.getByRole('listitem')).toHaveText(['架空選択B S-2×']);
    await tray.getByRole('button', { name: /^1件を明細に追加/ }).click();
    await expect(page.getByLabel('明細1 品名', { exact: true })).toHaveValue('架空選択B'); await expect(page.locator('.app-message')).toHaveCount(0);
    await page.keyboard.press('Control+s'); await expect(page.getByRole('status', { name: '保存状態' })).toHaveText('保存済み');
    // 開いていた編集の画面から、削除した材料を保存することはできない（版が合っていても）。
    const form = await page.evaluate(id => window.appApi.master.get(id), ids.get('架空選択C') ?? '');
    if (form.status !== 'ok' || !form.data.material) throw new Error('form');
    const material = form.data.material;
    await page.getByRole('button', { name: '材料', exact: true }).click();
    await trash(page, '架空選択C S-3').click(); await confirm(page, '削除する');
    await expect(names(page)).toHaveText(['架空選択B']);
    expect(await page.evaluate(m => window.appApi.master.save({ id: m.id, expectedRevision: m.revision + 1, categoryId: m.categoryId, newCategoryName: '', active: true, values: m.values }), material)).toMatchObject({ status: 'error', message: '材料は変更されています。再読込してください。' });
    expect(await page.evaluate(id => window.appApi.master.get(id), material.id)).toMatchObject({ status: 'error', message: '材料が見つかりません。' });
    // バックアップの件数には、削除した材料を数えない（行は保存されている）。
    await app.dialogs(path.join(f.root, 'after-material-delete.pombak'));
    expect((await page.evaluate(() => window.appApi.backups.create())).status).toBe('ok');
    const inspected = await page.evaluate(() => window.appApi.backups.inspect());
    expect(inspected).toMatchObject({ status: 'ok', data: { materials: 1, documents: 1 } });
  } finally { await stop(app, f); }
});
