import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { fixture } from './app';
import type { TestApp } from './app';

// 日本語の変換（IME）の始まりと終わり方の組合せ。変換は CDP の Input.imeSetComposition（変換中）と Input.insertText（確定）で起こす
// （実際の IME と同じ Blink の入口）。compositionend が届かない終わり方（変換の開始と同時に欄が無効になる・ダイアログごと閉じる・
// 確定しないままフォーカスが外れる）でも、編集画面が「変換確定を待っています」のまま固まらないことを確かめる。

const saveState = (page: Page) => page.getByRole('status', { name: '保存状態' });
const toast = (page: Page) => page.locator('.toast');

async function ime(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  return {
    compose: async (text: string) => { await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length }); },
    commit: async (text: string) => { await cdp.send('Input.insertText', { text }); },
  };
}
async function newInvoice(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: '新規請求書', exact: true }).click();
  await expect(saveState(page)).toHaveText('保存済み');
}
async function exits(application: TestApp): Promise<boolean> {
  return await Promise.race([application.waitForExit().then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 10_000))]);
}
/** 材料を1件だけDBへ直接登録する。 */
function seedMaterial(f: Awaited<ReturnType<typeof fixture>>, name: string): void {
  const db = f.database(), category = randomUUID();
  try {
    db.prepare('INSERT INTO categories VALUES (?,?,?,?)').run(category, '架空配管', 0, 1);
    db.prepare('INSERT INTO materials(id,category_id,name,model,manufacturer,quantity,remarks,unit_price,search_text,active,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), category, name, 'KJ-A', '架空社', '01 個', '', '', name, 1, 1, 'now', 'now');
  } finally { db.close(); }
}
/** これから届く compositionend を数える。 */
async function countCompositionEnd(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => { const w = window as unknown as { __ends: number }; w.__ends = 0; document.addEventListener('compositionend', () => { w.__ends += 1; }, true); });
  return async () => await page.evaluate(() => (window as unknown as { __ends: number }).__ends);
}

test('Japanese input in the add-line search box keeps the box usable and adds the chosen material', async () => {
  test.setTimeout(60_000);
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow();
    seedMaterial(f, '架空継手A');
    await newInvoice(page);
    const box = page.locator('#add-line-input'), input = await ime(page);
    await box.click();
    await input.compose('か');
    // 変換を始めても欄は使えるまま（以前は変換の開始と同時に無効になり、変換が失われた）。
    await expect(box).toBeEnabled(); await expect(box).toBeFocused();
    await expect(saveState(page)).toHaveText('変換確定を待っています');
    // この欄で変換中に閉じようとしても、黙って無視せず確定を求める（変換は続く）。
    await application.requestClose();
    await expect(toast(page)).toContainText('日本語の変換を確定してから、もう一度閉じてください。');
    expect(application.running).toBe(true);
    await expect(box).toBeFocused();
    await input.compose('かくう'); await input.commit('架空');
    await expect(box).toHaveValue('架空');
    await expect(page.locator('#add-line-suggest').getByRole('status')).toHaveText('1件の候補');
    await box.press('Enter');
    await expect(page.getByLabel('明細1 品名', { exact: true })).toHaveValue('架空継手A');
    await expect(saveState(page)).toHaveText('保存済み');
    const saved = f.database();
    try { expect(saved.prepare('SELECT name FROM document_lines').all().map(row => row['name'])).toEqual(['架空継手A']); } finally { saved.close(); }
    await application.requestClose();
    expect(await exits(application)).toBe(true);
  } finally { await application.close(); await f.cleanup(); }
});

test('a composition that loses focus without compositionend no longer freezes saving, shortcuts or closing', async () => {
  test.setTimeout(60_000);
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow();
    await newInvoice(page);
    const title = page.getByLabel('管理用タイトル', { exact: true });
    await title.click();
    // compositionend を送らずに変換を始め、確定しないままフォーカスを外す。
    await title.dispatchEvent('compositionstart');
    await expect(saveState(page)).toHaveText('変換確定を待っています');
    await page.keyboard.press('Tab');
    await expect(saveState(page)).not.toHaveText('変換確定を待っています');
    // 同じ欄へ戻って入力しても、変換中とはみなさない（保存・ショートカット・終了が効く）。
    await title.fill('架空タイトル');
    // Ctrl+S が受け付けられたか（自動保存でも「保存済み」になるため、キーが処理されたことを確かめる）。
    await page.evaluate(() => { const w = window as unknown as { __saveKey: boolean | null }; w.__saveKey = null; window.addEventListener('keydown', event => { if (event.ctrlKey && event.key.toLowerCase() === 's') setTimeout(() => { w.__saveKey = event.defaultPrevented; }); }, true); });
    await page.keyboard.press('Control+s');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __saveKey: boolean | null }).__saveKey)).toBe(true);
    await expect(saveState(page)).toHaveText('保存済み');
    const saved = f.database();
    try { expect(saved.prepare('SELECT title FROM documents').get()?.['title']).toBe('架空タイトル'); } finally { saved.close(); }
    await page.keyboard.press('Control+f');
    await expect(page.getByRole('dialog', { name: '材料検索' })).toBeVisible();
    await page.keyboard.press('Escape');
    await application.requestClose();
    expect(await exits(application)).toBe(true);
  } finally { await application.close(); await f.cleanup(); }
});

test('closing the window while composing asks to finish the conversion instead of being ignored', async () => {
  test.setTimeout(60_000);
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow();
    await newInvoice(page);
    const title = page.getByLabel('管理用タイトル', { exact: true }), input = await ime(page);
    await title.click();
    await input.compose('か');
    await application.requestClose();
    await expect(toast(page)).toContainText('日本語の変換を確定してから、もう一度閉じてください。');
    expect(application.running).toBe(true);
    // 変換は続いており、確定した文字は保存される。
    await expect(title).toBeFocused();
    await input.compose('かくう'); await input.commit('架空');
    await expect(title).toHaveValue('架空');
    await expect(saveState(page)).toHaveText('保存済み');
    await application.requestClose();
    expect(await exits(application)).toBe(true);
    const saved = f.database();
    try { expect(saved.prepare('SELECT title FROM documents').get()?.['title']).toBe('架空'); } finally { saved.close(); }
  } finally { await application.close(); await f.cleanup(); }
});

test('closing the material palette with a click outside while composing keeps shortcuts and closing working', async () => {
  test.setTimeout(60_000);
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    await page.keyboard.press('Control+f');
    const palette = page.getByRole('dialog', { name: '材料検索' }), input = await ime(page);
    await expect(palette.getByLabel('キーワード', { exact: true })).toBeFocused();
    const ends = await countCompositionEnd(page);
    await input.compose('か');
    // パレットの外（背景）を押して閉じる。変換中の欄がダイアログごと外れ、compositionend は届かない（この前提も確かめる）。
    await page.mouse.click(5, 5);
    await expect(palette).toBeHidden();
    expect(await ends()).toBe(0);
    await page.keyboard.press('Control+f');
    await expect(palette).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
    expect(await ends()).toBe(0);
    await application.requestClose();
    expect(await exits(application)).toBe(true);
  } finally { await application.close(); await f.cleanup(); }
});

// 防御のためのテスト: Chromium は実際にウィンドウやページを切り替えると変換を確定する（compositionend が届く）ため、この状態は
// ふだんは起きない。欄にフォーカスが残ったまま blur・focusout だけが届いても、変換中を解除しないことを確かめる。
test('blur events that leave focus on the composing field keep the conversion in progress', async () => {
  test.setTimeout(60_000);
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow();
    await newInvoice(page);
    const title = page.getByLabel('管理用タイトル', { exact: true }), input = await ime(page);
    await title.click();
    await input.compose('か');
    // 欄にフォーカスが残ったまま blur・focusout が届く。
    await title.dispatchEvent('blur'); await title.dispatchEvent('focusout');
    await expect(title).toBeFocused();
    await expect(saveState(page)).toHaveText('変換確定を待っています');
    await application.requestClose();
    await expect(toast(page)).toContainText('日本語の変換を確定してから、もう一度閉じてください。');
    expect(application.running).toBe(true);
    await input.compose('かくう'); await input.commit('架空');
    await expect(saveState(page)).toHaveText('保存済み');
    const saved = f.database();
    try { expect(saved.prepare('SELECT title FROM documents').get()?.['title']).toBe('架空'); } finally { saved.close(); }
  } finally { await application.close(); await f.cleanup(); }
});

test('the add-line search box recovers when a conversion ends without compositionend', async () => {
  test.setTimeout(60_000);
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow();
    seedMaterial(f, '架空継手A');
    await newInvoice(page);
    const box = page.locator('#add-line-input');
    await box.click();
    // compositionend を送らずに変換を始め、確定しないまま欄を離れて戻る。
    await box.dispatchEvent('compositionstart');
    await page.keyboard.press('Shift+Tab');
    await expect(box).not.toBeFocused();
    await box.click();
    await box.fill('架空');
    await expect(page.locator('#add-line-suggest').getByRole('status')).toHaveText('1件の候補');
    await box.press('Enter');
    await expect(page.getByLabel('明細1 品名', { exact: true })).toHaveValue('架空継手A');
    await expect(saveState(page)).toHaveText('保存済み');
  } finally { await application.close(); await f.cleanup(); }
});

test('closing the material drawer with a click outside while composing keeps shortcuts and closing working', async () => {
  test.setTimeout(60_000);
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow();
    await page.getByRole('button', { name: '材料', exact: true }).click();
    await page.getByRole('button', { name: '手動で追加', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '材料を手動追加' }), input = await ime(page);
    await drawer.getByRole('textbox', { name: '品名', exact: true }).click();
    const ends = await countCompositionEnd(page);
    await input.compose('か');
    await page.mouse.click(5, 5);
    await expect(drawer).toBeHidden();
    expect(await ends()).toBe(0);
    await page.keyboard.press('Control+f');
    await expect(page.getByRole('dialog', { name: '材料検索' })).toBeVisible();
    await page.keyboard.press('Escape');
    expect(await ends()).toBe(0);
    await application.requestClose();
    expect(await exits(application)).toBe(true);
  } finally { await application.close(); await f.cleanup(); }
});

test('closing the window while composing a search term in the palette closes as usual', async () => {
  test.setTimeout(60_000);
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    await page.keyboard.press('Control+f');
    const palette = page.getByRole('dialog', { name: '材料検索' }), input = await ime(page);
    await expect(palette.getByLabel('キーワード', { exact: true })).toBeFocused();
    await input.compose('か');
    // 編集画面の外の変換（検索語）では、確定を求めずに通常どおり終了する（モーダルの裏の通知は見えにくいため）。
    await application.requestClose();
    expect(await exits(application)).toBe(true);
  } finally { await application.close(); await f.cleanup(); }
});

// 防御のためのテスト（上の blur のテストと同じ理由）: 明細最終行の検索欄でも、フォーカスが残ったままの blur では変換中を解除しない。
test('blur events that leave focus on the add-line search box keep its conversion in progress', async () => {
  test.setTimeout(60_000);
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow();
    seedMaterial(f, '架空継手A');
    await newInvoice(page);
    const box = page.locator('#add-line-input'), input = await ime(page), status = page.locator('#add-line-suggest').getByRole('status');
    await box.click();
    await input.compose('か');
    await box.dispatchEvent('blur'); await box.dispatchEvent('focusout');
    await expect(box).toBeFocused();
    // 編集画面は変換中のまま（解除していれば、×で確定を求めずに終了確認へ進む）。
    await expect(saveState(page)).toHaveText('変換確定を待っています');
    await application.requestClose();
    await expect(toast(page)).toContainText('日本語の変換を確定してから、もう一度閉じてください。');
    expect(application.running).toBe(true);
    // 変換中も候補は出る。検索欄も変換中のまま（解除していれば、isComposing の付かない Enter で候補を追加しようとし、
    // 編集画面が変換中のため追加はされずに、欄の文字だけが消える）。
    await input.compose('架空');
    await expect(status).toHaveText('1件の候補');
    await box.dispatchEvent('keydown', { key: 'Enter', code: 'Enter' });
    await expect(box).toHaveValue('架空'); await expect(saveState(page)).toHaveText('変換確定を待っています');
    await input.commit('架空');
    await expect(status).toHaveText('1件の候補');
    await box.press('Enter');
    await expect(page.getByLabel('明細1 品名', { exact: true })).toHaveValue('架空継手A');
    await expect(saveState(page)).toHaveText('保存済み');
  } finally { await application.close(); await f.cleanup(); }
});
