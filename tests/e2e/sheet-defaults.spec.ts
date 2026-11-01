import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { syntheticWorkbook } from '../fixtures/xlsx';
import { confirm, fixture, openImport, pick, subject } from './app';
import type { TestApp } from './app';
import { evidencePath } from './evidence';

// 帳票の既定の揃え（文字のあるセルはすべて中央揃え）と、登録する値の前後の空白の削除（利用者の指示、2026年10月15日）。
// 壊しに行く操作: 入力欄にフォーカスしたまま、前後に空白を付けて打ち続ける。欄の文字は変えず、プレビューと保存だけが除いた形になること。

async function startInvoice(page: Page): Promise<void> {
  await page.getByRole('button', { name: '請求書', exact: true }).click();
  await page.getByRole('button', { name: '新規請求書', exact: true }).click();
  await expect(page.getByLabel('管理用タイトル', { exact: true })).toBeVisible();
}
async function addEmptyLine(page: Page): Promise<void> {
  await page.getByLabel('材料を検索して明細に追加', { exact: true }).click();
  await page.getByRole('button', { name: '空の明細を追加', exact: true }).click();
}
async function saved(page: Page): Promise<void> {
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('status', { name: '保存状態' })).toHaveText('保存済み');
}
const hit = (page: Page, row: number, column: number): Locator => page.locator(`.sheet-hits [data-row="${row}"][data-column="${column}"]`);
const text = (page: Page, ref: string): Locator => page.locator(`.sheet-texts [data-cell="${ref}"]`);
async function box(locator: Locator): Promise<{ x: number; width: number }> {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error('Missing box');
  return { x: rect.x, width: rect.width };
}
async function shutdown(application: TestApp): Promise<void> { await application.close(); }

test('typed edge spaces stay in the field while the preview and the save use the trimmed, centred value', async () => {
  const f = await fixture(Buffer.alloc(0)); const application = await f.launch();
  try {
    const page = await application.firstWindow(); await startInvoice(page);
    await addEmptyLine(page);
    await page.getByLabel('明細1 型式', { exact: true }).fill(' 001-A\t');
    await page.getByLabel('明細1 数量', { exact: true }).fill(' 2 ');
    await page.getByLabel('明細1 備考', { exact: true }).fill(' 備考 中 ');
    await page.getByRole('radiogroup', { name: '明細1 チェック状態', exact: true }).getByRole('radio', { name: '材料のみ（●）', exact: true }).click();
    await page.getByLabel('上部欄', { exact: true }).fill('　架空宛先 ');
    await page.getByLabel('納期', { exact: true }).fill(' 2026-01-02 ');
    // 品名は全角の空白で囲んで打ち、フォーカスしたまま続きを打つ。欄の文字は入力したまま。
    const name = page.getByLabel('明細1 品名', { exact: true });
    await name.fill('　リレー　');
    await name.press('End'); await page.keyboard.type('X');
    await expect(name).toHaveValue('　リレー　X');
    await expect(name).toBeFocused();
    // プレビューは登録される形（前後の空白なし。文中の空白は残る）で、既定の中央揃え。
    await expect(text(page, 'B6')).toHaveText('リレー　X');
    await expect(text(page, 'B6')).toHaveCSS('justify-content', 'center');
    await expect(text(page, 'C6')).toHaveText('001-A');
    await expect(text(page, 'E6')).toHaveText('2');
    await expect(text(page, 'F6')).toHaveText('備考 中');
    await expect(text(page, 'C2')).toHaveText('架空宛先');
    for (const ref of ['C6', 'E6', 'F6', 'C2', 'A6']) await expect(text(page, ref)).toHaveCSS('justify-content', 'center');
    // 納期は前後の空白を除いて判定するため、日付として表示し、出力前の確認はない。
    await expect(text(page, 'E4')).toHaveText('1月2日');
    await expect(page.locator('.issues-pill')).toBeDisabled();
    await expect(name).toBeFocused();
    await saved(page);
    const db = f.database();
    try {
      expect(db.prepare('SELECT name, model, quantity, remarks FROM document_lines').get()).toEqual({ name: 'リレー　X', model: '001-A', quantity: '2', remarks: '備考 中' });
      const header = JSON.parse(String((db.prepare('SELECT header FROM documents').get() as { header: string }).header)) as Record<string, string>;
      expect([header['C2'], header['E4']]).toEqual(['架空宛先', '2026-01-02']);
    } finally { db.close(); }
    // 開き直すと、入力欄も除いた形になる。
    await page.getByRole('button', { name: '← 請求書一覧', exact: true }).click();
    await page.getByRole('list', { name: '保存済み請求書' }).getByRole('button', { name: /を開く$/ }).first().click();
    await expect(page.getByLabel('明細1 品名', { exact: true })).toHaveValue('リレー　X');
    await expect(page.getByLabel('上部欄', { exact: true })).toHaveValue('架空宛先');
    await expect(page.getByLabel('納期', { exact: true })).toHaveValue('2026-01-02');
    await writeFile(evidencePath('sheet-defaults-trim.json'), JSON.stringify({ ...subject(), isolatedSynthetic: true, fieldKeepsTypedText: true, previewTrimmed: true, savedTrimmed: true, dateCheckTrimmed: true, reopenTrimmed: true }, null, 2));
  } finally { await shutdown(application); await f.cleanup(); }
});

test('a long centred top field spills evenly into the empty cells on both sides in the preview and the print page', async () => {
  const f = await fixture(Buffer.alloc(0)); const application = await f.launch();
  try {
    const page = await application.firstWindow(); await startInvoice(page);
    await addEmptyLine(page);
    // 品名は長くても、左隣（チェック記号）が埋まっているためはみ出さない。
    await page.getByLabel('明細1 品名', { exact: true }).fill('架空の長い品名の材料で隣の型式が空欄のまま');
    await page.getByRole('radiogroup', { name: '明細1 チェック状態', exact: true }).getByRole('radio', { name: '材料のみ（●）', exact: true }).click();
    await page.getByLabel('上部欄', { exact: true }).fill('架空電機製作所架空事業部架空営業所御中');
    await page.getByLabel('管理用タイトル', { exact: true }).click();
    const cell = await box(hit(page, 2, 2)), spilled = await box(text(page, 'C2'));
    expect(spilled.x).toBeLessThan(cell.x - 8);
    expect(spilled.x + spilled.width).toBeGreaterThan(cell.x + cell.width + 8);
    // 両側へ同じ幅: 文字の箱の中心はセルの中心のまま。
    expect(Math.abs(spilled.x + spilled.width / 2 - (cell.x + cell.width / 2))).toBeLessThan(2);
    const nameCell = await box(hit(page, 6, 1)), nameText = await box(text(page, 'B6'));
    expect(Math.abs(nameText.x - nameCell.x)).toBeLessThan(2);
    expect(Math.abs(nameText.width - (nameCell.width - 1))).toBeLessThan(2);
    await saved(page);
    // 印刷HTML: 宛先は列と左右の空欄の数のクラス（左 A・B、右 D〜G）、品名はセルの幅のまま中央。
    await page.getByRole('button', { name: '印刷プレビュー・PDF', exact: true }).click();
    const preview = await application.waitForPreview();
    await preview.getByRole('link', { name: 'PDFとして保存', exact: true }).waitFor();
    // 凡例（C54・C55）も左右が空欄のため同じクラスになる。文字で絞って確かめる。
    const printedTop = preview.locator('.t.m2-2-4.center', { hasText: '架空電機製作所' }), printedName = preview.locator('.t.c1.s1-1.center', { hasText: '架空の長い品名' });
    await expect(printedTop).toHaveCount(1);
    await expect(printedName).toHaveCount(1);
    const previewCell = await printedTop.evaluate(element => { const style = getComputedStyle(element); return { left: parseFloat(style.left), width: parseFloat(style.width) }; });
    const column = await printedName.evaluate(element => parseFloat(getComputedStyle(element).left));
    // 宛先の箱は B 列（品名の列）の左端より左から始まり、C 列より広い。
    expect(previewCell.left).toBeLessThan(column);
    expect(previewCell.width).toBeGreaterThan(196);
    await preview.getByRole('link', { name: '閉じる', exact: true }).click();
    await expect(page.getByLabel('管理用タイトル', { exact: true })).toBeEnabled();
    await writeFile(evidencePath('sheet-defaults-spill.json'), JSON.stringify({ ...subject(), isolatedSynthetic: true, previewSymmetricSpill: true, blockedSideNoSpill: true, printClasses: true }, null, 2));
  } finally { await shutdown(application); await f.cleanup(); }
});

test('materials registered from Excel and by hand are stored without edge spaces', async () => {
  const f = await fixture(syntheticWorkbook()); const application = await f.launch();
  try {
    const page = await application.firstWindow();
    await openImport(page, 'first'); await pick(application, page, f.source);
    // 元のセルは「 架空材料 」。確認の表は除いた形で示す。
    await expect(page.getByRole('region', { name: '取込確認' })).toContainText('架空材料');
    await page.getByRole('button', { name: '候補をすべて選択' }).click();
    await confirm(page);
    const db = f.database();
    try {
      const names = (db.prepare('SELECT name FROM materials ORDER BY name').all() as { name: string }[]).map(row => row.name);
      expect(names.length).toBeGreaterThan(0);
      expect(names).toContain('架空材料');
      expect(names.every(value => value === value.trim())).toBe(true);
    } finally { db.close(); }
    await page.getByRole('button', { name: '材料', exact: true }).click();
    const table = page.getByRole('table', { name: '材料台帳' });
    await expect(table.getByRole('cell', { name: '架空材料', exact: true }).first()).toBeVisible();
    // 手動追加: 全角の空白で囲んだ品名と、前後に空白のある型式。
    await page.getByRole('button', { name: '手動で追加', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '材料を手動追加' });
    await drawer.getByLabel('品名', { exact: true }).fill('　手動材料　');
    await drawer.getByLabel('型式', { exact: true }).fill(' M-1 ');
    await drawer.getByRole('button', { name: '材料を保存', exact: true }).click();
    await expect(page.getByText('材料を保存しました。', { exact: true })).toBeVisible();
    await expect(table.getByRole('cell', { name: '手動材料', exact: true })).toBeVisible();
    const after = f.database();
    try { expect(after.prepare("SELECT name, model FROM materials WHERE model = 'M-1'").get()).toEqual({ name: '手動材料', model: 'M-1' }); } finally { after.close(); }
    await writeFile(evidencePath('sheet-defaults-materials.json'), JSON.stringify({ ...subject(), isolatedSynthetic: true, importTrimmed: true, manualTrimmed: true }, null, 2));
  } finally { await shutdown(application); await f.cleanup(); }
});
