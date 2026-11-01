import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { fixture } from './app';

// 日本語の変換中も、すべての検索欄（明細最終行・材料検索パレット・材料台帳・カテゴリ候補・請求書一覧）で、入力に合わせて候補を出す
// （変換の確定を待たない）。変換は CDP の Input.imeSetComposition（変換中）と Input.insertText（確定）で起こす（実際の IME と同じ
// Blink の入口）。imeSetComposition に漢字を渡すのは、IME が変換した文字を確定前のまま欄に表示している状態にあたる。

const saveState = (page: Page) => page.getByRole('status', { name: '保存状態' });
const addStatus = (page: Page) => page.locator('#add-line-suggest').getByRole('status');
const palette = (page: Page) => page.getByRole('dialog', { name: '材料検索' });

async function ime(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  return {
    compose: async (text: string) => { await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length }); },
    commit: async (text: string) => { await cdp.send('Input.insertText', { text }); },
  };
}
/**
 * カテゴリ count 件（架空分類000〜）と、架空分類000の材料を DB へ直接登録する。材料は1件なら「架空継手A」、
 * 複数なら「架空継手00」〜（品名の順に並ぶ）。
 */
function seed(f: Awaited<ReturnType<typeof fixture>>, count = 1, materials = 1): void {
  const db = f.database(), ids = Array.from({ length: count }, () => randomUUID());
  try {
    const category = db.prepare('INSERT INTO categories VALUES (?,?,?,?)');
    ids.forEach((id, order) => category.run(...[id, `架空分類${String(order).padStart(3, '0')}`, order, 1] as never[]));
    const insert = db.prepare('INSERT INTO materials(id,category_id,name,model,manufacturer,quantity,remarks,unit_price,search_text,active,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (let i = 0; i < materials; i += 1) {
      const name = materials === 1 ? '架空継手A' : `架空継手${String(i).padStart(2, '0')}`;
      insert.run(...[randomUUID(), ids[0], name, 'KJ-A', '架空社', '01 個', '', '', name, 1, 1, 'now', 'now'] as never[]);
    }
  } finally { db.close(); }
}
async function newInvoice(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: '新規請求書', exact: true }).click();
  await expect(saveState(page)).toHaveText('保存済み');
}
/** 保存された明細の品名（行の順）。 */
function savedLines(f: Awaited<ReturnType<typeof fixture>>): unknown[] {
  const db = f.database();
  try { return db.prepare('SELECT name FROM document_lines ORDER BY position').all().map(row => row['name']); } finally { db.close(); }
}

test('the add-line search box lists candidates while composing, and a click on a candidate or the empty-line button adds it', async () => {
  test.setTimeout(60_000);
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow();
    seed(f);
    await newInvoice(page);
    const box = page.locator('#add-line-input'), input = await ime(page);
    await box.click();
    await input.compose('架空');
    // 変換を確定しないうちに候補が出る（編集画面は変換中のまま）。
    await expect(addStatus(page)).toHaveText('1件の候補');
    await expect(page.getByRole('listbox', { name: '追加する材料の候補' }).getByRole('option')).toHaveText(/架空継手A/);
    await expect(saveState(page)).toHaveText('変換確定を待っています');
    await expect(box).toBeFocused(); await expect(box).toHaveValue('架空');
    // 候補が出ていても、変換中の Enter は IME のもの（追加しない）。
    await page.keyboard.press('Enter');
    await expect(box).toHaveValue('架空'); await expect(saveState(page)).toHaveText('変換確定を待っています');
    // 変換中のまま候補を押しても追加できる（追加の前に変換を確定する）。
    await page.getByRole('option', { name: /架空継手A/ }).click();
    await expect(page.getByLabel('明細1 品名', { exact: true })).toHaveValue('架空継手A');
    await expect(page.getByLabel('明細1 数量', { exact: true })).toBeFocused();
    await expect(box).toHaveValue('');
    await expect(saveState(page)).toHaveText('保存済み');
    // 「空の明細を追加」も、変換中のまま押せる。
    await box.click();
    await input.compose('か');
    await expect(saveState(page)).toHaveText('変換確定を待っています');
    await page.getByRole('button', { name: '空の明細を追加', exact: true }).click();
    await expect(page.getByLabel('明細2 品名', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('明細2 数量', { exact: true })).toBeFocused();
    await expect(box).toHaveValue('');
    await expect(saveState(page)).toHaveText('保存済み');
    expect(savedLines(f)).toEqual(['架空継手A', '']);
  } finally { await application.close(); await f.cleanup(); }
});

// Windows の IME では、マウスのボタンを押した時点で変換が確定してから mousedown が届く。確定（compositionend）で候補を読み直すと、
// 押した候補が消えてクリックにならない。確定と同時に（待たずに）同じ位置を押して、候補が残っていることを確かめる。
test('a candidate stays clickable when the conversion is committed by the same mouse press', async () => {
  test.setTimeout(60_000);
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow();
    seed(f);
    await newInvoice(page);
    const box = page.locator('#add-line-input'), input = await ime(page);
    await box.click();
    await input.compose('架空');
    await expect(addStatus(page)).toHaveText('1件の候補');
    const area = await page.getByRole('option', { name: /架空継手A/ }).boundingBox();
    if (!area) throw new Error('候補が表示されていません');
    await input.commit('架空');
    await page.mouse.click(area.x + area.width / 2, area.y + area.height / 2);
    await expect(page.getByLabel('明細1 品名', { exact: true })).toHaveValue('架空継手A');
    await expect(saveState(page)).toHaveText('保存済み');
    // パレットでも同じ（確定で読み直すと、押した行が読み込み中の表示に替わって消える。確定で一覧を先頭へ戻す場合は、次のテストで確かめる）。
    await page.keyboard.press('Control+f');
    const field = palette(page).getByLabel('キーワード', { exact: true });
    await expect(field).toBeFocused();
    await input.compose('架空継手');
    const row = palette(page).getByRole('listbox', { name: '検索結果' }).getByRole('option');
    await expect(row).toHaveCount(1);
    const rowArea = await row.boundingBox();
    if (!rowArea) throw new Error('検索結果が表示されていません');
    await input.commit('架空継手');
    await page.mouse.click(rowArea.x + rowArea.width / 2, rowArea.y + rowArea.height / 2);
    await expect(row).toHaveAttribute('aria-selected', 'true');
    await expect(palette(page).getByText('1件を選択中', { exact: true })).toBeVisible();
  } finally { await application.close(); await f.cleanup(); }
});

test('a scrolled palette result stays under the pointer when the conversion is committed by the same mouse press', async () => {
  test.setTimeout(60_000);
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow();
    seed(f, 1, 30);
    await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    await page.keyboard.press('Control+f');
    const field = palette(page).getByLabel('キーワード', { exact: true }), input = await ime(page);
    const rows = palette(page).getByRole('listbox', { name: '検索結果' }).getByRole('option');
    await expect(field).toBeFocused();
    await input.compose('架空継手');
    await expect(palette(page).locator('.palette-status')).toHaveText('30件中 1～25件'); await expect(rows).toHaveCount(25);
    // 結果を末尾までスクロールし、最後の行を押す。確定で一覧を先頭へ戻すと、押した位置に別の行が来る。
    await palette(page).locator('.palette-results').evaluate(element => { element.scrollTop = element.scrollHeight; });
    const last = rows.nth(24), area = await last.boundingBox();
    if (!area) throw new Error('最後の行が表示されていません');
    await input.commit('架空継手');
    await page.mouse.click(area.x + area.width / 2, area.y + area.height / 2);
    await expect(last).toHaveAttribute('aria-selected', 'true');
    await expect(palette(page).getByText('1件を選択中', { exact: true })).toBeVisible();
  } finally { await application.close(); await f.cleanup(); }
});

test('the material palette lists results while composing and a click picks one without ending the conversion', async () => {
  test.setTimeout(60_000);
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow();
    seed(f);
    await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    await page.keyboard.press('Control+f');
    const field = palette(page).getByLabel('キーワード', { exact: true }), input = await ime(page);
    const status = palette(page).locator('.palette-status'), rows = palette(page).getByRole('listbox', { name: '検索結果' }).getByRole('option');
    await expect(field).toBeFocused();
    await input.compose('該当なし');
    await expect(status).toHaveText('該当する材料はありません。キーワードやカテゴリを変更してください。');
    await input.compose('架空継手');
    await expect(status).toHaveText('1件中 1～1件'); await expect(rows).toHaveText(/架空継手A/);
    // 結果が出ていても、変換中の Enter は IME のもの（選ばない）。
    await page.keyboard.press('Enter');
    await expect(palette(page).getByText('0件を選択中', { exact: true })).toBeVisible(); await expect(field).toHaveValue('架空継手');
    // 変換中のまま結果を押して選ぶ。フォーカスは入力欄に残り、変換は続く（続けて入力できる）。
    await rows.click();
    await expect(rows).toHaveAttribute('aria-selected', 'true');
    await expect(palette(page).getByText('1件を選択中', { exact: true })).toBeVisible();
    await expect(field).toBeFocused();
    await input.compose('架空継手A');
    await expect(field).toHaveValue('架空継手A');
    await expect(status).toHaveText('1件中 1～1件'); await expect(rows).toHaveAttribute('aria-selected', 'true');
    // 変換中のまま「1件を明細に追加」を押しても追加できる（押すとフォーカスが移り、変換は確定する）。
    await palette(page).getByRole('button', { name: /^1件を明細に追加/ }).click();
    await expect(palette(page)).toBeHidden();
    await expect(page.getByLabel('明細1 品名', { exact: true })).toHaveValue('架空継手A');
    await expect(saveState(page)).toHaveText('保存済み');
  } finally { await application.close(); await f.cleanup(); }
});

test('the invoice list, the material ledger and the category search filter while composing', async () => {
  test.setTimeout(90_000);
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow();
    seed(f, 120);
    const input = await ime(page);
    // 請求書一覧: タイトルの違う2件を作り、変換中の文字で絞り込む。
    for (const title of ['架空工事の請求', '別件の請求']) {
      await newInvoice(page);
      await page.getByLabel('管理用タイトル', { exact: true }).fill(title);
      await expect(saveState(page)).toHaveText('保存済み');
      await page.getByRole('button', { name: '請求書', exact: true }).click();
    }
    const cards = page.getByRole('list', { name: '保存済み請求書' }).getByRole('article'), filter = page.getByRole('searchbox', { name: '請求書を絞り込む', exact: true });
    await expect(cards).toHaveCount(2);
    await filter.click();
    await input.compose('架空');
    await expect(cards).toHaveCount(1); await expect(cards).toHaveAccessibleName('架空工事の請求');
    await input.compose('別件');
    await expect(cards).toHaveAccessibleName('別件の請求');
    await input.commit('別件');
    await expect(filter).toHaveValue('別件'); await expect(cards).toHaveAccessibleName('別件の請求');
    // 材料台帳: キーワードとカテゴリ候補の検索。
    await page.getByRole('button', { name: '材料', exact: true }).click();
    const ledger = page.getByRole('region', { name: '材料' }), keyword = ledger.getByRole('searchbox', { name: 'キーワード', exact: true });
    const ledgerStatus = ledger.locator('p[role="status"]:not([aria-label])');
    await expect(ledgerStatus).toHaveText('1件中 1～1件');
    await keyword.click();
    await input.compose('該当なし');
    await expect(ledgerStatus).toHaveText('該当する材料はありません。キーワードやカテゴリを変更してください。');
    await input.compose('架空継手');
    await expect(ledgerStatus).toHaveText('1件中 1～1件');
    await expect(page.getByRole('table', { name: '材料台帳' }).getByRole('row', { name: /架空継手A/ })).toBeVisible();
    await input.commit('架空継手');
    const group = ledger.getByRole('group', { name: 'カテゴリ', exact: true }), categoryStatus = group.getByRole('status', { name: 'カテゴリの候補の件数' });
    await expect(categoryStatus).toHaveText('120件中 1～100件');
    await group.getByRole('searchbox', { name: 'カテゴリを検索', exact: true }).click();
    await input.compose('分類11');
    await expect(categoryStatus).toHaveText('10件中 1～10件');
    await expect(group.getByRole('button', { name: /^架空分類11/ })).toHaveCount(10);
    await input.commit('分類11');
    await expect(categoryStatus).toHaveText('10件中 1～10件');
  } finally { await application.close(); await f.cleanup(); }
});

// 変換中は、欄の文字が maxLength（256）を超えることがある（確定のときにブラウザが切り詰める。この前提も確かめる）。
// 本体は256文字を超える検索語を受け付けないため、超えた分は送らず、先頭の256文字で検索する（エラーを出さない）。
test('a conversion that runs past the 256-character limit searches with the first 256 characters instead of failing', async () => {
  test.setTimeout(90_000);
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow();
    seed(f, 120);
    const long = 'あ'.repeat(255), input = await ime(page);
    // 末尾の1文字だけが違う2件ずつ（カテゴリ・材料・請求書）。先頭の256文字で検索すると1件に絞られる。
    const db = f.database();
    try {
      for (const [order, last] of ['か', 'さ'].entries()) {
        const category = randomUUID();
        db.prepare('INSERT INTO categories VALUES (?,?,?,?)').run(...[category, long + last, 200 + order, 1] as never[]);
        db.prepare('INSERT INTO materials(id,category_id,name,model,manufacturer,quantity,remarks,unit_price,search_text,active,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(...[randomUUID(), category, long + last, 'KJ-L', '架空社', '01 個', '', '', long + last, 1, 1, 'now', 'now'] as never[]);
      }
    } finally { db.close(); }
    for (const last of ['か', 'さ']) {
      await newInvoice(page);
      await page.getByLabel('管理用タイトル', { exact: true }).fill(long + last);
      await expect(saveState(page)).toHaveText('保存済み');
      await page.getByRole('button', { name: '請求書', exact: true }).click();
    }
    // 請求書一覧
    const cards = page.getByRole('list', { name: '保存済み請求書' }).getByRole('article'), filter = page.getByRole('searchbox', { name: '請求書を絞り込む', exact: true });
    await filter.fill(long);
    await expect(cards).toHaveCount(2);
    await input.compose('かきく');
    await expect(filter).toHaveValue(long + 'かきく');
    await expect(cards).toHaveCount(1); await expect(cards).toHaveAccessibleName(long + 'か');
    await input.commit('かきく');
    await expect(filter).toHaveValue(long + 'か'); await expect(cards).toHaveAccessibleName(long + 'か');
    // 材料検索パレット（明細最終行・材料台帳のキーワードも同じ検索の部品）
    await page.keyboard.press('Control+f');
    const field = palette(page).getByLabel('キーワード', { exact: true }), status = palette(page).locator('.palette-status');
    await field.fill(long);
    await expect(status).toHaveText('2件中 1～2件');
    await input.compose('かきく');
    await expect(field).toHaveValue(long + 'かきく');
    await expect(status).toHaveText('1件中 1～1件'); await expect(palette(page).getByRole('alert')).toHaveCount(0);
    await input.commit('かきく');
    await expect(field).toHaveValue(long + 'か'); await expect(status).toHaveText('1件中 1～1件');
    await page.keyboard.press('Escape');
    await expect(palette(page)).toBeHidden();
    // 材料台帳のカテゴリ候補
    await page.getByRole('button', { name: '材料', exact: true }).click();
    const group = page.getByRole('region', { name: '材料' }).getByRole('group', { name: 'カテゴリ', exact: true });
    const categoryStatus = group.getByRole('status', { name: 'カテゴリの候補の件数' }), categorySearch = group.getByRole('searchbox', { name: 'カテゴリを検索', exact: true });
    await categorySearch.fill(long);
    await expect(categoryStatus).toHaveText('2件中 1～2件');
    await input.compose('かきく');
    await expect(categorySearch).toHaveValue(long + 'かきく');
    await expect(categoryStatus).toHaveText('1件中 1～1件'); await expect(group.getByRole('alert')).toHaveCount(0);
    await input.commit('かきく');
    await expect(categorySearch).toHaveValue(long + 'か'); await expect(categoryStatus).toHaveText('1件中 1～1件');
  } finally { await application.close(); await f.cleanup(); }
});
