import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { textCell, workbookParts, zipParts } from '../fixtures/xlsx';
import { capture, confirm, fixture, openImport, pick, subject } from './app';
import { evidencePath } from './evidence';
import type { SearchResult } from '../../src/shared/material-search-api';

function workbook(): Buffer {
  const rows = Array.from({ length: 600 }, (_, index) => {
    const row = index + 2;
    return `<row r="${row}">${textCell(`A${row}`, `架空検索材料${String(index).padStart(4, '0')}`)}${textCell(`B${row}`, index === 0 ? '００１－Ａ/Ｂ%_\\' : `MD-${String(index).padStart(5, '0')}`)}${textCell(`C${row}`, '架空 ＭＥＫＡ')}${textCell(`D${row}`, '02 本')}${textCell(`E${row}`, index === 0 ? ' 前後空白\n <img src=x onerror=alert(1)> ' : '架空の仕様と取扱注記。'.repeat(12))}${textCell(`F${row}`, '001.00')}</row>`;
  }).join('');
  return zipParts(workbookParts(rows), true);
}

/** Ctrl+F の材料検索パレット（25件ずつのページ・カテゴリ絞り込み・複数選択。無効材料は出さない）。 */
const palette = (page: Page) => page.getByRole('dialog', { name: '材料検索' });
const paletteField = (page: Page) => palette(page).getByRole('combobox', { name: 'キーワード', exact: true });
/** 検索結果の行（カテゴリの選択肢の option と区別する）。 */
const results = (page: Page) => palette(page).getByRole('listbox', { name: '検索結果' }).getByRole('option');
/** 材料タブの台帳（カテゴリ・無効も表示・25件ページング・件数表示はこちらで検証する）。 */
const ledger = (page: Page) => page.getByRole('region', { name: '材料' });
/** 件数表示（選択の帯の「N件を選択中」の status は除く）。 */
const ledgerStatus = (page: Page) => ledger(page).locator('p[role="status"]:not([aria-label])');
const ledgerTable = (page: Page) => page.getByRole('table', { name: '材料台帳' });
const capped = '600件中 1～25件';

test('material search uses imported originals, keyboard selection, bounded pages and restart persistence', async () => {
  test.setTimeout(90_000);
  const f = await fixture(workbook()); let application = await f.launch();
  try {
    let page = await application.firstWindow();
    await openImport(page, 'first'); await pick(application, page, f.source);
    await expect(page.getByRole('region', { name: '取込確認' })).toContainText('材料候補 600件'); await confirm(page);
    await expect(page.getByRole('region', { name: 'Excelから取込' }).locator('p.status-line[role="status"]')).toContainText('反映 600件');
    const before = f.database();
    let beforeHash: string;
    try { beforeHash = createHash('sha256').update(JSON.stringify(before.prepare('SELECT * FROM materials ORDER BY id').all())).digest('hex'); } finally { before.close(); }
    // パレット：Ctrl+F で入力欄にフォーカス。結果は25件ずつで、総件数と表示範囲は status で示す。
    // パレットの入力欄は設計上 outline なし（styles.css .palette-input）のため、フォーカスと選択行の強調で確認する。
    await page.keyboard.press('Control+f'); const field = paletteField(page); await expect(field).toBeFocused();
    await expect(palette(page).getByRole('status')).toHaveText(capped); await expect(results(page)).toHaveCount(25);
    for (const width of [1280, 720, 375]) { await palette(page).locator('.palette-results').evaluate(element => { element.scrollTop = 0; }); await capture(page, 'search-results', width); await results(page).last().scrollIntoViewIfNeeded(); await capture(page, 'search-list', width); }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.keyboard.press('Escape'); await expect(palette(page)).toHaveCount(0);
    // 25件ページングと件数表示は材料台帳で確認する。
    await page.getByRole('button', { name: '材料', exact: true }).click();
    await expect(ledgerStatus(page)).toHaveText('600件中 1～25件'); await expect(ledgerTable(page).getByRole('row')).toHaveCount(26);
    await page.getByRole('button', { name: '次の25件' }).click(); await expect(ledgerStatus(page)).toHaveText('600件中 26～50件'); await capture(page, 'search-page-two');
    await ledger(page).getByLabel('キーワード', { exact: true }).fill('001-a/b%_\\');
    await expect(ledgerStatus(page)).toHaveText('1件中 1～1件');
    const category = ledger(page).getByRole('group', { name: 'カテゴリ' }).getByRole('button', { name: /^架空材料/ });
    await category.click(); await expect(category).toHaveAttribute('aria-pressed', 'true'); await expect(ledgerStatus(page)).toHaveText('1件中 1～1件');
    // パレットのキーボード操作：入力欄にフォーカスを残したまま、現在行を .active / aria-activedescendant で示す（aria-selected は選択＝チェック）。
    await page.keyboard.press('Control+f'); await field.fill('001-a/b%_\\');
    const options = results(page); await expect(options).toHaveCount(1);
    const selected = palette(page).locator('.search-result.active'); await expect(selected).toHaveCount(1); await expect(selected).toContainText('００１－Ａ/Ｂ%_\\');
    await field.press('ArrowDown'); await expect(selected).toHaveAttribute('id', 'palette-option-0'); await expect(field).toBeFocused(); await expect(field).toHaveAttribute('aria-activedescendant', 'palette-option-0');
    await expect(selected).toHaveCSS('box-shadow', /inset/); await capture(page, 'search-selected');
    // 変換中の Enter では選択しない（請求書へも追加しない）。
    await field.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true }); await expect(palette(page)).toBeVisible(); await expect(options.first()).toHaveAttribute('aria-selected', 'false'); await expect(page.getByRole('region', { name: '請求書編集' })).toHaveCount(0);
    // 旧「選択した材料の詳細」（材料ID・原記録）は廃止。材料台帳の編集ドロワーで登録した値（前後の空白は除き、文中の改行・空白・全角はそのまま）と出典を確認する。
    await page.keyboard.press('Escape'); await ledgerTable(page).getByRole('button', { name: '架空検索材料0000を編集', exact: true }).click();
    const detail = page.getByRole('dialog', { name: '材料を編集' });
    await expect(detail.getByRole('textbox', { name: '型式', exact: true })).toHaveValue('００１－Ａ/Ｂ%_\\');
    await expect(detail.getByRole('textbox', { name: '単価', exact: true })).toHaveValue('001.00');
    await expect(detail.getByRole('textbox', { name: '備考', exact: true })).toHaveValue('前後空白\n <img src=x onerror=alert(1)>');
    await expect(detail.locator('.drawer-head')).toContainText('2行 / left'); expect(await page.locator('img').count()).toBe(0);
    for (const width of [1280, 375]) { await page.setViewportSize({ width, height: 800 }); await detail.getByRole('textbox', { name: '型式', exact: true }).scrollIntoViewIfNeeded(); await capture(page, 'search-detail', width); const source = detail.getByText('前回確認済み取込値と現在値を比較', { exact: true }); if (!await detail.locator('.material-comparison').evaluate(element => (element as HTMLDetailsElement).open)) await source.click(); await detail.locator('.material-comparison table').scrollIntoViewIfNeeded(); await capture(page, 'search-source', width); }
    await page.setViewportSize({ width: 1280, height: 800 });
    await detail.getByRole('button', { name: '編集を取り消す' }).click(); await expect(detail).toHaveCount(0);
    // パレットで Enter：現在行を選び、Ctrl+Enter で選んだ材料を作業中の請求書（なければ新規）へ原記録どおりに追加する。
    await page.keyboard.press('Control+f'); await field.fill('001-a/b%_\\'); await expect(options).toHaveCount(1); await field.press('Enter');
    await expect(options.first()).toHaveAttribute('aria-selected', 'true'); await expect(palette(page)).toBeVisible(); await field.press('Control+Enter');
    await expect(palette(page)).toHaveCount(0); await expect(page.getByRole('region', { name: '請求書編集' })).toBeVisible();
    await expect(page.getByLabel('明細1 型式', { exact: true })).toHaveValue('００１－Ａ/Ｂ%_\\');
    await expect(page.getByRole('status').filter({ hasText: 'を明細1に追加しました' })).toBeVisible();
    await expect(page.getByRole('status', { name: '保存状態' })).toHaveText('保存済み');
    await page.keyboard.press('Control+f'); await field.fill('不存在'); await expect(palette(page).getByRole('status')).toContainText('該当する材料はありません'); await capture(page, 'search-zero');
    const paintDurations: number[] = [];
    for (let i = 0; i < 5; i++) { const started = performance.now(); await field.fill(`架空検索材料000${i}`); await expect(options).toHaveCount(1); await expect(options.first()).toContainText(`架空検索材料000${i}`); await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); paintDurations.push(performance.now() - started); }
    const timing = await page.evaluate(async () => {
      const durations: number[] = [];
      for (let i = 0; i < 40; i++) { const started = performance.now(); const result = await window.appApi.materials.search({ query: i % 2 ? '架空' : '不存在', categoryId: null, includeInactive: false, offset: 0 }); if (result.status !== 'ok') throw new Error('Search measurement failed'); durations.push(performance.now() - started); }
      return durations;
    });
    const after = f.database(); try { expect(createHash('sha256').update(JSON.stringify(after.prepare('SELECT * FROM materials ORDER BY id').all())).digest('hex')).toBe(beforeHash); expect(after.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' }); } finally { after.close(); }
    await application.close(); application = await f.launch(); page = await application.firstWindow(); await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible(); await page.keyboard.press('Control+f'); await expect(palette(page).getByRole('status')).toHaveText(capped); await capture(page, 'search-restarted');
    const sorted = [...timing].sort((a, b) => a - b);
    await writeFile(evidencePath('search-performance.json'), JSON.stringify({ ...subject(), arch: process.arch, node: process.version, rows: 600, remarksCharacters: '架空の仕様と取扱注記。'.repeat(12).length, runs: timing.length, timingMs: timing, medianMs: sorted[20], p95Ms: sorted[37], maximumMs: sorted.at(-1), inputToPaintMs: paintDurations, boundary: 'Renderer invoke through the appApi adapter (Tauri IPC, or HTTP on the bridge target), core SQL normalization/count/page and response; separate inputToPaint includes Playwright, 180ms debounce and two animation frames', persistedAfterRestart: true, originalMaterialRowsUnchanged: true }, null, 2));
  } finally { await application.close(); await f.cleanup(); }
});

test('search handles IME events, stale success and error responses, failure and retry', async () => {
  const f = await fixture(workbook()), application = await f.launch();
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    // 新しいプロファイルでは請求書一覧にバックアップ警告の alert が出るため、status / alert はパレット内に限定する。
    const status = palette(page).getByRole('status'), alert = palette(page).getByRole('alert');
    await page.keyboard.press('Control+f'); await expect(status).toContainText('検索できる材料がありません');
    // 検索の応答を検索語ごとに release まで保留する（old-error と fail は失敗、それ以外は0件を返す）。
    const empty: SearchResult = { status: 'ok', data: { rows: [], categories: [], categoryTotal: 0, total: 0 } };
    const failure: SearchResult = { status: 'error', code: 'DB', message: '検索できませんでした。もう一度検索してください。', correlationId: 'synthetic' };
    await application.intercept('materials:search', { hold: 'test:search:{query}', replace: empty, replaceByQuery: { 'old-error': failure, fail: failure } });
    const field = paletteField(page);
    await field.fill('old'); await expect.poll(() => application.count('test:search:old')).toBe(1);
    await field.fill('new'); await expect.poll(() => application.count('test:search:new')).toBe(1);
    for (const width of [1280, 375]) await capture(page, 'search-loading', width);
    await application.release('test:search:new'); await expect(status).toContainText('該当する材料はありません');
    await field.fill('old-error'); await expect.poll(() => application.count('test:search:old-error')).toBe(1);
    await application.release('test:search:old'); await expect(status).toHaveText('検索しています…');
    await field.fill('latest'); await expect.poll(() => application.count('test:search:latest')).toBe(1);
    await application.release('test:search:latest'); await expect(status).toContainText('該当する材料はありません');
    await application.release('test:search:old-error'); await expect(alert).toHaveCount(0); await expect(field).toHaveValue('latest');
    // 変換中の入力でも検索する。確定しても文字が変わらなければ、検索し直さない（保留中の要求は1件のまま）。
    await field.dispatchEvent('compositionstart'); await field.fill('日本');
    await expect.poll(() => application.count('test:search:日本')).toBe(1); await expect(status).toHaveText('検索しています…'); await capture(page, 'search-composing');
    await field.dispatchEvent('compositionend', { data: '日本' }); await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 400)));
    expect(await application.count('test:search:日本')).toBe(1);
    expect(await application.release('test:search:日本')).toBe(1); await expect(status).toContainText('該当する材料はありません');
    await field.fill('fail'); await expect.poll(() => application.count('test:search:fail')).toBe(1);
    await application.release('test:search:fail'); await expect(alert).toBeVisible();
    for (const width of [1280, 375]) await capture(page, 'search-error', width);
    await palette(page).getByRole('button', { name: '再試行' }).click(); await expect.poll(() => application.count('test:search:fail')).toBe(1);
    // 以後の検索は保留せず0件を返す。保留中の失敗（再試行の1回目）はそのまま失敗で返る。
    await application.intercept('materials:search', { replace: empty }); await application.release('test:search:fail');
    await expect(alert).toBeVisible(); await palette(page).getByRole('button', { name: '再試行' }).click(); await expect(status).toContainText('該当する材料はありません'); await capture(page, 'search-retried');
  } finally { await application.close(); await f.cleanup(); }
});

test('search rejects malformed input through the app adapter', async () => {
  const f = await fixture(workbook()), application = await f.launch();
  try {
    const page = await application.firstWindow();
    expect(await page.evaluate(() => Object.keys(window.appApi.materials))).toEqual(['search', 'categories']);
    expect(await page.evaluate(() => Reflect.apply(window.appApi.materials.search, null, [{ query: "' OR 1=1 --", categoryId: null, includeInactive: false, offset: 0, sql: 'arbitrary' }]))).toMatchObject({ status: 'error', code: 'VALIDATION' });
    // 旧版の「別ウィンドウ（preload 付き）からの要求」に当たる、信頼できない送信元からの要求は拒否する（アプリ版では権限設定でメインウィンドウ以外は ipc を呼べず、さらに本体が送信元を確かめる）。
    expect((await application.untrustedInvoke('materials:search', { query: '', categoryId: null, includeInactive: false, offset: 0 })).value).toMatchObject({ status: 'error' });
  } finally { await application.close(); await f.cleanup(); }
});

test('category intersection, inactive labels, arrow direction and long originals remain readable', async () => {
  const f = await fixture(workbook()), application = await f.launch();
  try {
    const page = await application.firstWindow(); await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    const db = f.database(), firstCategory = randomUUID(), secondCategory = randomUUID();
    try {
      const category = db.prepare('INSERT INTO categories VALUES (?,?,?,?)'); category.run(...[firstCategory, '架空配管', 0, 1] as never[]); category.run(...[secondCategory, '架空電材', 1, 1] as never[]);
      const insert = db.prepare('INSERT INTO materials(id,category_id,name,model,manufacturer,quantity,remarks,unit_price,search_text,active,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
      for (const [categoryId, active] of [[firstCategory, 1], [firstCategory, 0], [secondCategory, 1]]) insert.run(...[randomUUID(), categoryId, '架空長い材料名称'.repeat(12), '000-A/B-'.repeat(8), '架空メーカー', '02 本', '長い架空注記。'.repeat(100), '001.00', 'legacy derived value', active, 1, 'now', 'now'] as never[]);
    } finally { db.close(); }
    // パレット：既定では有効な材料だけ（2件）。
    await page.keyboard.press('Control+f'); const options = results(page); await expect(options).toHaveCount(2);
    const field = paletteField(page); await field.fill('000-a/b-'); await expect(options).toHaveCount(2); await expect(options.first()).toContainText('000-A/B-');
    // 矢印キーは入力欄にフォーカスを残したまま現在行を移動し、先頭・末尾で止まる（旧UIの「↑で末尾へ」はない）。
    const selectedIs = async (index: number) => { await expect(options.nth(index)).toHaveClass(/\bactive\b/); await expect(options.nth(1 - index)).not.toHaveClass(/\bactive\b/); await expect(field).toBeFocused(); await expect(field).toHaveAttribute('aria-activedescendant', `palette-option-${index}`); };
    await selectedIs(0); await field.press('ArrowDown'); await selectedIs(1); await page.keyboard.press('ArrowDown'); await selectedIs(1); await page.keyboard.press('ArrowUp'); await selectedIs(0); await page.keyboard.press('ArrowUp'); await selectedIs(0);
    await page.keyboard.press('Escape'); await expect(palette(page)).toHaveCount(0);
    // カテゴリと無効材料の組合せは材料台帳で確認する。
    await page.getByRole('button', { name: '材料', exact: true }).click();
    await ledger(page).getByLabel('キーワード', { exact: true }).fill('000-a/b-'); await expect(ledgerStatus(page)).toHaveText('2件中 1～2件');
    await ledger(page).getByRole('group', { name: 'カテゴリ' }).getByRole('button', { name: /^架空配管/ }).click(); await expect(ledgerStatus(page)).toHaveText('1件中 1～1件');
    await ledger(page).getByRole('checkbox', { name: '無効も表示' }).check(); await expect(ledgerStatus(page)).toHaveText('2件中 1～2件'); await expect(ledgerTable(page).getByRole('cell', { name: '無効', exact: true })).toHaveCount(1);
    for (const width of [1280, 375]) { await page.setViewportSize({ width, height: 800 }); await ledgerTable(page).scrollIntoViewIfNeeded(); await capture(page, 'search-long', width); }
    await page.keyboard.press('Control+f'); await paletteField(page).fill('不存在'); await paletteField(page).press('Enter'); await expect(palette(page).getByRole('status')).toContainText('該当する材料はありません'); await expect(palette(page)).toBeVisible();
  } finally { await application.close(); await f.cleanup(); }
});

/** 材料をDBへ直接登録する（categories: [id, 名前]、materials: [カテゴリID, 品名, 型式]）。 */
function seedMaterials(f: Awaited<ReturnType<typeof fixture>>, categories: readonly (readonly [string, string])[], materials: readonly (readonly [string, string, string])[]): Map<string, string> {
  const db = f.database(), ids = new Map<string, string>();
  try {
    const category = db.prepare('INSERT INTO categories VALUES (?,?,?,?)');
    categories.forEach(([id, name], order) => category.run(...[id, name, order, 1] as never[]));
    const insert = db.prepare('INSERT INTO materials(id,category_id,name,model,manufacturer,quantity,remarks,unit_price,search_text,active,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const [categoryId, name, model] of materials) { const id = randomUUID(); ids.set(name, id); insert.run(...[id, categoryId, name, model, '架空社', '01 個', '', '', name, 1, 1, 'now', 'now'] as never[]); }
  } finally { db.close(); }
  return ids;
}

test('palette keeps picks across searches, categories and pages and adds them all in one step', async () => {
  test.setTimeout(60_000);
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow(); await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    const piping = randomUUID(), electric = randomUUID();
    const ids = seedMaterials(f, [[piping, '架空配管'], [electric, '架空電材']], [
      ...Array.from({ length: 30 }, (_, i) => [piping, `架空継手${String(i).padStart(2, '0')}`, `PJ-${String(i).padStart(2, '0')}`] as const),
      [electric, '架空電線A', 'DW-A'], [electric, '架空電線B', 'DW-B'],
    ]);
    await page.getByRole('button', { name: '請求書', exact: true }).click(); await page.getByRole('button', { name: '新規請求書', exact: true }).click();
    // 明細の「材料を選んでまとめて追加」からパレットを開く。最初は何も選んでいない。
    await page.getByRole('button', { name: /^材料を選んでまとめて追加/ }).click();
    const field = paletteField(page), options = results(page), status = palette(page).getByRole('status');
    const tray = palette(page).getByRole('region', { name: '選んだ材料' }), addButton = tray.getByRole('button', { name: /明細に追加/ });
    await expect(field).toBeFocused(); await expect(status).toHaveText('32件中 1～25件'); await expect(tray).toContainText('0件を選択中'); await expect(addButton).toBeDisabled();
    // カテゴリで絞り込み、クリックで選ぶ。
    await palette(page).getByRole('combobox', { name: 'カテゴリ' }).selectOption({ label: '架空電材（2）' });
    await expect(status).toHaveText('2件中 1～2件'); await options.filter({ hasText: '架空電線A' }).click();
    await expect(options.filter({ hasText: '架空電線A' })).toHaveAttribute('aria-selected', 'true'); await expect(tray).toContainText('1件を選択中');
    // カテゴリを戻して検索し直しても選択は残る。Enter で現在行を選び、次のページでも選べる。
    await palette(page).getByRole('combobox', { name: 'カテゴリ' }).selectOption({ label: 'すべてのカテゴリ（32）' });
    await field.fill('架空継手'); await expect(status).toHaveText('30件中 1～25件'); await expect(options.first()).toContainText('架空継手00');
    await field.press('Enter'); await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    await palette(page).getByRole('button', { name: '次の25件' }).click(); await expect(status).toHaveText('30件中 26～30件');
    await options.filter({ hasText: '架空継手29' }).click(); await expect(tray).toContainText('3件を選択中');
    await field.fill('架空電線'); await expect(options).toHaveCount(2); await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    // もう一度押すと外れる。チップの × でも外せる。
    await options.nth(1).click(); await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true'); await options.nth(1).click(); await expect(options.nth(1)).toHaveAttribute('aria-selected', 'false');
    await options.nth(1).click(); await expect(tray).toContainText('4件を選択中');
    await tray.getByRole('button', { name: '架空電線B DW-Bの選択を外す' }).click(); await expect(options.nth(1)).toHaveAttribute('aria-selected', 'false');
    await expect(tray.getByRole('listitem')).toHaveText(['架空電線A DW-A×', '架空継手00 PJ-00×', '架空継手29 PJ-29×']);
    for (const width of [1280, 375]) await capture(page, 'search-multi-select', width);
    await page.setViewportSize({ width: 1280, height: 800 });
    // 閉じても選択は残る（誤って閉じても選び直さなくてよい）。
    await page.keyboard.press('Escape'); await expect(palette(page)).toHaveCount(0);
    await page.keyboard.press('Control+f'); await expect(tray).toContainText('3件を選択中');
    // まとめて追加：選んだ順に明細の末尾へ入り、最初に追加した行の数量へフォーカスが移る。
    await addButton.click(); await expect(palette(page)).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: '3件の材料を明細1～3に追加しました' })).toBeVisible();
    for (const [index, name] of ['架空電線A', '架空継手00', '架空継手29'].entries()) await expect(page.getByLabel(`明細${index + 1} 品名`, { exact: true })).toHaveValue(name);
    await expect(page.getByLabel('明細1 数量', { exact: true })).toBeFocused(); await expect(page.locator('.line-cap')).toHaveText('3 / 47行');
    // 追加した材料は選択から外れ、明細にある材料は印で分かる。
    await page.keyboard.press('Control+f'); await expect(tray).toContainText('0件を選択中');
    await field.fill('架空電線'); await expect(options).toHaveCount(2);
    await expect(options.filter({ hasText: '架空電線A' }).getByText('明細にあり', { exact: true })).toBeVisible(); await expect(options.filter({ hasText: '架空電線B' }).getByText('明細にあり', { exact: true })).toHaveCount(0);
    // Ctrl+Enter でも追加できる（既に明細にある材料も追加できる）。
    await field.press('Enter'); await field.press('Control+Enter'); await expect(palette(page)).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: '「架空電線A DW-A」を明細4に追加しました' })).toBeVisible();
    await page.keyboard.press('Control+s'); await expect(page.getByRole('status', { name: '保存状態' })).toHaveText('保存済み');
    const db = f.database();
    try { expect(db.prepare('SELECT material_id AS id FROM document_lines ORDER BY position').all()).toEqual(['架空電線A', '架空継手00', '架空継手29', '架空電線A'].map(name => ({ id: ids.get(name) }))); } finally { db.close(); }
  } finally { await application.close(); await f.cleanup(); }
});

test('palette stops picking at the 500-line limit and adds up to it', async () => {
  test.setTimeout(60_000);
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow(); await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    const category = randomUUID();
    seedMaterials(f, [[category, '架空配管']], [[category, '架空上限材料A', 'LM-A'], [category, '架空上限材料B', 'LM-B']]);
    // 499行の請求書を保存しておき、一覧から開く。
    const saved = await page.evaluate(async () => {
      const opened = await window.appApi.documents.open(null); if (opened.status !== 'ok') throw new Error('open');
      const lines = [];
      for (let i = 0; i < 499; i++) { const added = await window.appApi.documents.addLine({ sessionId: opened.data.sessionId, materialId: null }); if (added.status !== 'ok') throw new Error('addLine'); lines.push(added.data); }
      return await window.appApi.documents.save({ sessionId: opened.data.sessionId, requestNumber: 1, generation: 1, expectedRevision: 0, draft: { ...opened.data.draft, title: '架空上限請求書', lines } });
    });
    expect(saved.status).toBe('ok');
    await page.getByRole('button', { name: '材料', exact: true }).click(); await page.getByRole('button', { name: '請求書', exact: true }).click();
    await page.getByRole('list', { name: '保存済み請求書' }).getByRole('button', { name: /を開く$/ }).click(); await expect(page.locator('.line-cap')).toHaveText('499 / 47行');
    await page.getByRole('button', { name: /^材料を選んでまとめて追加/ }).click();
    const options = results(page), tray = palette(page).getByRole('region', { name: '選んだ材料' });
    await expect(options).toHaveCount(2);
    await options.first().click(); await expect(tray).toContainText('1件を選択中'); await expect(tray).toContainText('これ以上は選べません');
    await options.nth(1).click(); await expect(options.nth(1)).toHaveAttribute('aria-selected', 'false'); await expect(tray).toContainText('1件を選択中');
    await tray.getByRole('button', { name: /^1件を明細に追加/ }).click(); await expect(palette(page)).toHaveCount(0);
    await expect(page.locator('.line-cap')).toHaveText('500 / 47行'); await expect(page.getByLabel('明細500 品名', { exact: true })).toHaveValue('架空上限材料A');
    await expect(page.getByRole('button', { name: /^材料を選んでまとめて追加/ })).toBeDisabled();
  } finally { await application.close(); await f.cleanup(); }
});

test('bulk add stops at a material that became inactive and keeps the rest picked', async () => {
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow(); await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    const category = randomUUID();
    const ids = seedMaterials(f, [[category, '架空配管']], [[category, '架空途中材料A', 'MA-A'], [category, '架空途中材料B', 'MA-B'], [category, '架空途中材料C', 'MA-C']]);
    await page.getByRole('button', { name: '請求書', exact: true }).click(); await page.getByRole('button', { name: '新規請求書', exact: true }).click();
    await page.getByRole('button', { name: /^材料を選んでまとめて追加/ }).click();
    const field = paletteField(page), options = results(page), tray = palette(page).getByRole('region', { name: '選んだ材料' });
    await field.fill('架空途中材料'); await expect(options).toHaveCount(3);
    for (let i = 0; i < 3; i++) await options.nth(i).click();
    await expect(tray).toContainText('3件を選択中');
    // 選んだ後で（パレットを閉じている間に）Bが無効になった。
    await page.keyboard.press('Escape'); await expect(palette(page)).toHaveCount(0);
    const db = f.database(); try { db.prepare('UPDATE materials SET active = 0 WHERE id = ?').run(...[ids.get('架空途中材料B')] as never[]); } finally { db.close(); }
    await page.keyboard.press('Control+f'); await tray.getByRole('button', { name: /^3件を明細に追加/ }).click(); await expect(palette(page)).toHaveCount(0);
    // Aまで追加して止め、理由と件数を示す。B・Cは選んだまま残る。
    await expect(page.getByRole('alert').filter({ hasText: '材料が見つからないか無効です' })).toContainText('選んだ3件のうち1件を追加しました');
    await expect(page.locator('.line-cap')).toHaveText('1 / 47行'); await expect(page.getByLabel('明細1 品名', { exact: true })).toHaveValue('架空途中材料A');
    await page.keyboard.press('Control+f'); await expect(tray.getByRole('listitem')).toHaveText(['架空途中材料B MA-B×', '架空途中材料C MA-C×']);
    await tray.getByRole('button', { name: '架空途中材料B MA-Bの選択を外す' }).click(); await expect(field).toBeFocused();
    await field.press('Control+Enter'); await expect(palette(page)).toHaveCount(0);
    await expect(page.getByLabel('明細2 品名', { exact: true })).toHaveValue('架空途中材料C');
  } finally { await application.close(); await f.cleanup(); }
});

test('257 categories stay browsable in the ledger, material form and palette, and edits keep the chosen category', async () => {
  test.setTimeout(90_000);
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow(); await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    // 旧版は256件を超えると材料の画面を開けなかった。カテゴリ名は作成順（＝並び順）に連番。
    const categories = Array.from({ length: 257 }, (_, i) => [randomUUID(), `架空分類${String(i).padStart(3, '0')}`] as const);
    const last = categories[256], middle = categories[150]; if (!last || !middle) throw new Error('fixture');
    const ids = seedMaterials(f, categories, [[last[0], '架空末尾材料', 'TAIL-1']]);
    await page.getByRole('button', { name: '材料', exact: true }).click();
    // 台帳: カテゴリ候補は100件ずつ。ページ送り・名前の検索で末尾のカテゴリを選べる。
    const group = ledger(page).getByRole('group', { name: 'カテゴリ', exact: true }), categoryStatus = group.getByRole('status', { name: 'カテゴリの候補の件数' });
    const materialStatus = ledger(page).locator('p[role="status"]:not([aria-label])');
    await expect(categoryStatus).toHaveText('257件中 1～100件'); await expect(group.getByRole('button', { name: /^架空分類/ })).toHaveCount(100);
    await group.getByRole('button', { name: '次の100件', exact: true }).click(); await expect(categoryStatus).toHaveText('257件中 101～200件');
    await group.getByRole('button', { name: '次の100件', exact: true }).click(); await expect(categoryStatus).toHaveText('257件中 201～257件');
    await expect(group.getByRole('button', { name: '次の100件', exact: true })).toBeDisabled(); await expect(group.getByRole('button', { name: /^架空分類/ })).toHaveCount(57);
    await group.getByRole('button', { name: /^架空分類256/ }).click(); await expect(materialStatus).toHaveText('1件中 1～1件');
    const categorySearch = group.getByRole('searchbox', { name: 'カテゴリを検索', exact: true });
    await categorySearch.fill('分類15'); await expect(categoryStatus).toHaveText('10件中 1～10件');
    // 候補にない選択中のカテゴリは先頭に残り、選択も絞り込みも変わらない。
    await expect(group.getByRole('button', { name: /^架空分類256/ })).toHaveAttribute('aria-pressed', 'true'); await expect(materialStatus).toHaveText('1件中 1～1件');
    await capture(page, 'categories-257-ledger');
    await categorySearch.fill(''); await expect(categoryStatus).toHaveText('257件中 1～100件');
    // 材料の編集: 最初の候補ページにないカテゴリを保持して開き、ページ送り・検索をしても選択は変わらない。
    await ledgerTable(page).getByRole('button', { name: '架空末尾材料を編集', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '材料を編集' }), select = drawer.getByRole('combobox', { name: 'カテゴリ', exact: true });
    const drawerStatus = drawer.getByRole('status', { name: 'カテゴリの候補の件数' }), drawerSearch = drawer.getByRole('searchbox', { name: 'カテゴリを検索', exact: true });
    await expect(select).toHaveValue(last[0]); await expect(drawerStatus).toHaveText('257件中 1～100件');
    await drawer.getByRole('button', { name: '次の100件', exact: true }).click(); await expect(drawerStatus).toHaveText('257件中 101～200件'); await expect(select).toHaveValue(last[0]);
    await drawerSearch.fill('分類150'); await expect(drawerStatus).toHaveText('1件中 1～1件'); await expect(select).toHaveValue(last[0]);
    await select.selectOption({ label: '架空分類150' }); await expect(select).toHaveValue(middle[0]);
    await drawerSearch.fill(''); await expect(drawerStatus).toHaveText('257件中 1～100件'); await expect(select).toHaveValue(middle[0]);
    await capture(page, 'categories-257-drawer');
    await drawer.getByRole('button', { name: '材料を保存', exact: true }).click(); await expect(page.getByText('材料を保存しました。', { exact: true })).toBeVisible();
    const saved = () => { const db = f.database(); try { return db.prepare('SELECT category_id, revision FROM materials WHERE id=?').get(...[ids.get('架空末尾材料')] as never[]); } finally { db.close(); } };
    expect(saved()).toEqual({ category_id: middle[0], revision: 2 });
    // カテゴリ256の絞り込みからは外れる。すべてに戻して再表示しても、保存したカテゴリのまま。
    await expect(materialStatus).toHaveText('該当する材料はありません。キーワードやカテゴリを変更してください。');
    await group.getByRole('button', { name: /^すべて/ }).click(); await expect(materialStatus).toHaveText('1件中 1～1件');
    await ledgerTable(page).getByRole('button', { name: '架空末尾材料を編集', exact: true }).click();
    await expect(select).toHaveValue(middle[0]); await expect(select.locator('option:checked')).toHaveText('架空分類150');
    await drawer.getByRole('button', { name: '編集を取り消す', exact: true }).click();
    // 新しいカテゴリ名で258件目を作った後も、新規作成の画面を開ける。
    await page.getByRole('button', { name: '手動で追加', exact: true }).click();
    const create = page.getByRole('dialog', { name: '材料を手動追加' });
    await create.getByRole('combobox', { name: 'カテゴリ', exact: true }).selectOption({ label: '新しいカテゴリ' });
    await create.getByLabel('新しいカテゴリ名', { exact: true }).fill('架空258件目'); await create.getByLabel('品名', { exact: true }).fill('架空258材料');
    await create.getByRole('button', { name: '材料を保存', exact: true }).click(); await expect(page.getByText('材料を保存しました。', { exact: true }).last()).toBeVisible();
    await page.getByRole('button', { name: '手動で追加', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '材料を手動追加' }).getByRole('status', { name: 'カテゴリの候補の件数' })).toHaveText('258件中 1～100件');
    await page.getByRole('dialog', { name: '材料を手動追加' }).getByRole('button', { name: '編集を取り消す', exact: true }).click();
    // 材料検索パレット: 候補の検索で末尾のカテゴリを選び、検索を消しても絞り込みは残る。
    await page.getByRole('button', { name: '請求書', exact: true }).click(); await page.getByRole('button', { name: '新規請求書', exact: true }).click();
    await page.getByRole('button', { name: /^材料を選んでまとめて追加/ }).click();
    const paletteSelect = palette(page).getByRole('combobox', { name: 'カテゴリ', exact: true }), paletteCategories = palette(page).getByRole('status', { name: 'カテゴリの候補の件数' });
    await expect(paletteCategories).toHaveText('258件中 1～100件'); await expect(paletteSelect.locator('option').first()).toHaveText('すべてのカテゴリ（2）');
    await palette(page).getByRole('searchbox', { name: 'カテゴリを検索', exact: true }).fill('分類150'); await expect(paletteCategories).toHaveText('1件中 1～1件');
    await paletteSelect.selectOption({ label: '架空分類150（1）' }); await expect(results(page)).toHaveCount(1); await expect(results(page)).toContainText('架空末尾材料');
    await palette(page).getByRole('searchbox', { name: 'カテゴリを検索', exact: true }).fill(''); await expect(paletteCategories).toHaveText('258件中 1～100件');
    await expect(paletteSelect).toHaveValue(middle[0]); await expect(results(page)).toHaveCount(1);
    await capture(page, 'categories-257-palette');
    await writeFile(evidencePath('categories-257.json'), JSON.stringify({ ...subject(), categories: 258, pagedBy: 100, ledgerPaged: true, formOpenedAfter257: true, selectionKeptAcrossPages: true, savedCategory: '架空分類150', newFormAfter258: true, palettePaged: true }, null, 2));
  } finally { await application.close(); await f.cleanup(); }
});

/** 架空のカテゴリ257件（材料はカテゴリ256に1件）の材料台帳を開く。カテゴリ候補の検索・ページ送りの確認用。 */
async function openLedgerWith257Categories(f: Awaited<ReturnType<typeof fixture>>, application: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['launch']>>) {
  const page = await application.firstWindow(); await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
  const categories = Array.from({ length: 257 }, (_, i) => [randomUUID(), `架空分類${String(i).padStart(3, '0')}`] as const), last = categories[256];
  if (!last) throw new Error('fixture');
  seedMaterials(f, categories, [[last[0], '架空末尾材料', 'TAIL-1']]);
  await page.getByRole('button', { name: '材料', exact: true }).click();
  const group = ledger(page).getByRole('group', { name: 'カテゴリ', exact: true }), categoryStatus = group.getByRole('status', { name: 'カテゴリの候補の件数' });
  await expect(categoryStatus).toHaveText('257件中 1～100件');
  return { page, group, categoryStatus, categorySearch: group.getByRole('searchbox', { name: 'カテゴリを検索', exact: true }) };
}

test('category paging waits for the result of the current search and never strands a match on an empty page', async () => {
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const { group, categoryStatus, categorySearch } = await openLedgerWith257Categories(f, application);
    const next = group.getByRole('button', { name: '次の100件', exact: true }), previous = group.getByRole('button', { name: '前の100件', exact: true });
    await expect(next).toBeEnabled();
    // 検索語の応答を止める。応答前（表示は直前の全件のページ）にページ送りを押すと、新しい検索語に開始位置100を付けて
    // 「1件中 101～1件」の空のページになり、前のページへも戻れなかった（レビュー指摘）。応答が届くまでページ送りは押せない。
    await application.intercept('materials:categories', { hold: 'test:category:{query}' });
    await categorySearch.fill('分類256');
    await expect(categoryStatus).toHaveText('カテゴリを読み込んでいます…');
    await expect(next).toBeDisabled(); await expect(previous).toBeDisabled();
    await expect.poll(() => application.release('test:category:分類256')).toBe(1);
    await expect(categoryStatus).toHaveText('1件中 1～1件');
    await expect(group.getByRole('button', { name: /^架空分類256/ })).toBeVisible();
    // 2ページ目を開いている間に検索しても同じ（開始位置は先頭へ戻り、応答まではページ送りを押せない）。
    await categorySearch.fill('');
    await expect.poll(() => application.release('test:category:')).toBe(1); await expect(categoryStatus).toHaveText('257件中 1～100件');
    await next.click(); await expect.poll(() => application.release('test:category:')).toBe(1); await expect(categoryStatus).toHaveText('257件中 101～200件');
    await categorySearch.fill('1'); await expect(next).toBeDisabled(); await expect(previous).toBeDisabled();
    await expect.poll(() => application.release('test:category:1')).toBe(1);
    await expect(categoryStatus).toHaveText('134件中 1～100件'); await expect(previous).toBeDisabled(); await expect(next).toBeEnabled();
    await application.intercept('materials:categories', null);
  } finally { await application.close(); await f.cleanup(); }
});

test('clearing the category search keeps the search box mounted and focused for the next query', async () => {
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const { page, categoryStatus, categorySearch } = await openLedgerWith257Categories(f, application);
    await categorySearch.fill('分類256'); await expect(categoryStatus).toHaveText('1件中 1～1件');
    // 全件の読み直しの応答を止め、その間も検索欄が残ってフォーカスを保つことを確かめる
    // （絞り込み後の1件で検索欄の表示を決めていたため、欄ごと消えてフォーカスが BODY へ移っていた。レビュー指摘）。
    await application.intercept('materials:categories', { hold: 'test:category:{query}' });
    await categorySearch.press('Control+a'); await categorySearch.press('Backspace');
    await expect(categorySearch).toBeFocused(); await expect(categorySearch).toHaveValue('');
    await expect.poll(() => application.release('test:category:')).toBe(1);
    await expect(categoryStatus).toHaveText('257件中 1～100件'); await expect(categorySearch).toBeFocused();
    await application.intercept('materials:categories', null);
    // そのままキーボードで次の検索語を入力できる。
    await page.keyboard.type('分類15');
    await expect(categorySearch).toHaveValue('分類15'); await expect(categoryStatus).toHaveText('10件中 1～10件'); await expect(categorySearch).toBeFocused();
    // 材料の編集ドロワーも同じ部品を使う。検索語を消してもフォーカスを保つ。
    await ledgerTable(page).getByRole('button', { name: '架空末尾材料を編集', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '材料を編集' }), drawerSearch = drawer.getByRole('searchbox', { name: 'カテゴリを検索', exact: true });
    await expect(drawer.getByRole('status', { name: 'カテゴリの候補の件数' })).toHaveText('257件中 1～100件');
    await drawerSearch.fill('分類256'); await expect(drawer.getByRole('status', { name: 'カテゴリの候補の件数' })).toHaveText('1件中 1～1件');
    await drawerSearch.press('Control+a'); await drawerSearch.press('Backspace');
    await expect(drawerSearch).toBeFocused(); await expect(drawer.getByRole('status', { name: 'カテゴリの候補の件数' })).toHaveText('257件中 1～100件'); await expect(drawerSearch).toBeFocused();
  } finally { await application.close(); await f.cleanup(); }
});
