import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { allXml } from '../fixtures/xlsx';
import { capture, fixture, subject } from './app';
import type { TestApp } from './app';
import { evidencePath } from './evidence';

// Excelプレビューのツールバーで付けたセルの書式（配置・文字・色）が、画面・保存・Excel出力・印刷・複製に同じく反映されること。

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
const button = (page: Page, name: string): Locator => page.getByRole('group', { name: 'セルの書式', exact: true }).getByRole('button', { name, exact: true });
async function drag(page: Page, from: Locator, to: Locator): Promise<void> {
  const a = await from.boundingBox(), b = await to.boundingBox();
  if (!a || !b) throw new Error('Missing cell box');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 }); await page.mouse.up();
}
async function pickColor(page: Page, kind: '文字の色' | '塗りつぶしの色', name: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^${kind}（`) }).click();
  await page.getByRole('group', { name: kind, exact: true }).getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('group', { name: kind, exact: true })).toHaveCount(0);
}
async function expectFormatted(page: Page): Promise<void> {
  // 帳票の既定は中央揃えのため、変えた書式として左揃えを使う。
  await expect(text(page, 'B6')).toHaveCSS('justify-content', 'flex-start');
  for (const ref of ['B6', 'C6', 'B7', 'C7']) await expect(text(page, ref)).toHaveCSS('font-weight', '700');
  await expect(text(page, 'E6')).toHaveCSS('justify-content', 'flex-end');
  await expect(text(page, 'C2')).toHaveCSS('color', 'rgb(255, 0, 0)');
  await expect(text(page, 'C2')).toHaveCSS('font-size', '18.6667px');
  await expect(page.locator('.sheet-fills [data-fill="C2"]')).toHaveCSS('background-color', 'rgb(255, 242, 204)');
}
async function shutdown(application: TestApp): Promise<void> { await application.close(); }

test('cell formats from the preview toolbar are saved and reach Excel, print, reopen and duplicates', async () => {
  test.setTimeout(90_000);
  const f = await fixture(Buffer.alloc(0)); let application = await f.launch();
  try {
    let page = await application.firstWindow(); await startInvoice(page);
    await page.getByLabel('管理用タイトル', { exact: true }).fill('架空書式請求書');
    // セルを選ぶまでは書式を変えられない。
    await expect(button(page, '太字')).toBeDisabled();
    await addEmptyLine(page); await addEmptyLine(page);
    for (const [line, name, model, quantity] of [[1, '架空左寄材料', 'A-1', '1'], [2, '架空二行目', 'B-2', '20']] as const) {
      await page.getByLabel(`明細${line} 品名`, { exact: true }).fill(name);
      await page.getByLabel(`明細${line} 型式`, { exact: true }).fill(model);
      await page.getByLabel(`明細${line} 数量`, { exact: true }).fill(quantity);
      await page.getByRole('radiogroup', { name: `明細${line} チェック状態`, exact: true }).getByRole('radio', { name: '材料のみ（●）', exact: true }).click();
    }
    // 見出し（固定）のセルは書式の対象外。
    await hit(page, 5, 1).click();
    await expect(button(page, '中央揃え')).toBeDisabled();

    // 1つのセル: プレビューで選ぶと明細表の欄へ移動し、ボタンを押しても入力欄のフォーカスはそのまま。
    await hit(page, 6, 1).click();
    await expect(page.getByLabel('明細1 品名', { exact: true })).toBeFocused();
    // 既定は中央揃え（ツールバーもそう示す）。左揃えに変える。
    await expect(text(page, 'B6')).toHaveCSS('justify-content', 'center');
    await expect(button(page, '中央揃え')).toHaveAttribute('aria-pressed', 'true');
    await button(page, '左揃え').click();
    await expect(text(page, 'B6')).toHaveCSS('justify-content', 'flex-start');
    await expect(button(page, '左揃え')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByLabel('明細1 品名', { exact: true })).toBeFocused();

    // 範囲（ドラッグ）と Ctrl+B。
    await drag(page, hit(page, 6, 1), hit(page, 7, 2));
    await expect(page.getByRole('status', { name: '選択中のセル', exact: true })).toContainText('B6:C7');
    await page.keyboard.press('Control+b');
    for (const ref of ['B6', 'C6', 'B7', 'C7']) await expect(text(page, ref)).toHaveCSS('font-weight', '700');
    await expect(button(page, '太字')).toHaveAttribute('aria-pressed', 'true');

    // 列の見出しで列全体を選ぶ（書式は入力欄だけ: 納期と、明細のある行の数量）。数量（中央揃えの列）を右揃えに。
    await page.locator('.sheet-colhead span', { hasText: /^E$/u }).click();
    await expect(page.getByRole('status', { name: '選択中のセル', exact: true })).toContainText('E1:E56');
    await expect(page.getByRole('status', { name: '選択中のセル', exact: true })).toContainText('書式を変えられる入力欄 3セル');
    await button(page, '右揃え').click();
    for (const ref of ['E6', 'E7']) await expect(text(page, ref)).toHaveCSS('justify-content', 'flex-end');

    // 帳票上部の欄: 文字の色・塗りつぶし・大きさ。
    await page.getByLabel('上部欄', { exact: true }).fill('架空宛先');
    await pickColor(page, '文字の色', '赤');
    // 色の一覧（狭い画面でも画面の外へはみ出さない）。
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole('button', { name: /^塗りつぶしの色（/u }).click();
    await expect(page.getByRole('group', { name: '塗りつぶしの色', exact: true }).getByRole('button', { name: '塗りつぶしなし', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await capture(page, 'cell-format-palette', 1280);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('group', { name: '塗りつぶしの色', exact: true })).toHaveCount(0);
    await pickColor(page, '塗りつぶしの色', '淡い黄');
    await page.getByLabel('フォントサイズ', { exact: true }).selectOption('14');
    await expect(page.getByLabel('フォントサイズ', { exact: true })).toHaveValue('14');
    await page.getByLabel('管理用タイトル', { exact: true }).click();
    await expectFormatted(page);
    for (const width of [1280, 768, 375]) await capture(page, 'cell-format-editor', width);
    await page.setViewportSize({ width: 1120, height: 760 });
    await saved(page);

    const db = f.database();
    let documentId = '';
    try {
      const row = db.prepare('SELECT id, header FROM documents').get() as { id: string; header: string };
      documentId = row.id;
      const header = JSON.parse(row.header) as { C2: string; formats: { header: unknown; lines: Record<string, unknown> } };
      expect(header.C2).toBe('架空宛先');
      expect(header.formats.header).toEqual({ C2: { size: 14, color: 'FF0000', fill: 'FFF2CC' }, E4: { horizontal: 'right' } });
      const lines = db.prepare('SELECT id FROM document_lines ORDER BY position').all() as { id: string }[];
      expect(Object.keys(header.formats.lines).sort()).toEqual(lines.map(line => line.id).sort());
      expect(header.formats.lines[lines[0]?.id ?? '']).toEqual({ name: { horizontal: 'left', bold: true }, model: { bold: true }, quantity: { horizontal: 'right' } });
    } finally { db.close(); }

    // Excel出力: 書式ごとの xf（既定の17個の後ろ）と、フォント・塗りつぶし。
    const target = path.join(f.root, '書式.xlsx');
    await application.dialog('save', target); await application.dialog('message', 1);
    await page.getByRole('button', { name: 'Excelへ出力', exact: true }).click();
    await expect(page.getByRole('status', { name: 'Excel出力状態' })).toContainText('をExcelへ出力しました');
    let parts = await allXml(await readFile(target));
    const styles = parts.get('xl/styles.xml') ?? '', sheet = parts.get('xl/worksheets/sheet1.xml') ?? '';
    expect(styles).toContain('<!-- parts-order-manager:formats ');
    expect(styles).toContain('<alignment horizontal="left"/>');
    expect(styles).toContain('<alignment horizontal="right"/>');
    expect(styles).toContain('<font><b/><sz val="11"/><name val="ＭＳ Ｐ明朝"/>');
    expect(styles).toContain('<font><sz val="14"/><color rgb="FFFF0000"/><name val="ＭＳ Ｐ明朝"/>');
    expect(styles).toContain('<fgColor rgb="FFFFF2CC"/>');
    const styleOf = (ref: string): number => Number(new RegExp(`<c r="${ref}" s="(\\d+)"`, 'u').exec(sheet)?.[1] ?? -1);
    for (const ref of ['C2', 'E4', 'B6', 'C6', 'E6', 'B7', 'C7', 'E7']) expect(styleOf(ref)).toBeGreaterThanOrEqual(17);
    for (const ref of ['A4', 'D6', 'F6', 'B8']) expect(styleOf(ref)).toBeLessThan(17);

    // 書式を変えて同じファイルへ上書きできる（既存ファイルの styles.xml もこのアプリの出力と確かめられる）。
    await hit(page, 6, 1).click();
    await button(page, '書式をクリア').click();
    await expect(text(page, 'B6')).toHaveCSS('justify-content', 'center');
    await expect(text(page, 'B6')).toHaveCSS('font-weight', '400');
    await application.dialog('save', target); await application.dialog('message', 1);
    await page.getByRole('button', { name: 'Excelへ出力', exact: true }).click();
    await expect.poll(async () => { parts = await allXml(await readFile(target)); return Number(/<c r="B6" s="(\d+)"/u.exec(parts.get('xl/worksheets/sheet1.xml') ?? '')?.[1]); }).toBeLessThan(17);
    await expect(page.getByRole('status', { name: 'Excel出力状態' })).toContainText('をExcelへ出力しました');
    expect(parts.get('xl/styles.xml')).toContain('<!-- parts-order-manager:formats ');
    await hit(page, 6, 1).click();
    await button(page, '左揃え').click(); await page.keyboard.press('Control+b');
    await saved(page);

    // 印刷プレビュー: 書式のクラスと塗りつぶし（スクリプトなし・CSPの固定スタイル）。左揃えは既定の center のクラスが付かない。
    await page.getByRole('button', { name: '印刷プレビュー・PDF', exact: true }).click();
    const preview = await application.waitForPreview();
    await preview.getByRole('link', { name: 'PDFとして保存', exact: true }).waitFor();
    await expect(preview.locator('.t.b', { hasText: '架空左寄材料' })).toHaveCount(1);
    await expect(preview.locator('.t.b', { hasText: '架空左寄材料' })).not.toHaveClass(/center/u);
    await expect(preview.locator('.t.right', { hasText: /^20$/u })).toHaveCount(1);
    await expect(preview.locator('.t.k9.z14', { hasText: '架空宛先' })).toHaveCount(1);
    await expect(preview.locator('.fill.g3')).toHaveCSS('background-color', 'rgb(255, 242, 204)');
    await expect(preview.locator('.t.k9.z14')).toHaveCSS('color', 'rgb(255, 0, 0)');
    await capture(preview, 'cell-format-print', 960);
    await preview.getByRole('link', { name: '閉じる', exact: true }).click();
    await expect(page.getByLabel('管理用タイトル', { exact: true })).toBeEnabled();

    // 再起動して開き直しても、複製しても書式は残る。
    await shutdown(application); application = await f.launch(); page = await application.firstWindow();
    await page.getByRole('article', { name: '架空書式請求書' }).getByRole('button', { name: /を開く$/ }).click();
    await expectFormatted(page);
    await page.getByRole('button', { name: '請求書', exact: true }).click();
    await page.getByRole('article', { name: '架空書式請求書' }).getByRole('button', { name: /のその他の操作$/ }).click(); await page.getByRole('article', { name: '架空書式請求書' }).getByRole('menuitem', { name: '複製して編集', exact: true }).click();
    await page.getByLabel('管理用タイトル', { exact: true }).fill('架空書式複製'); await saved(page);
    await expectFormatted(page);
    const copied = f.database();
    try {
      const rows = copied.prepare('SELECT id, header FROM documents ORDER BY title').all() as { id: string; header: string }[];
      expect(rows.length).toBe(2);
      const copy = rows.find(row => row.id !== documentId);
      const lineIds = (copied.prepare('SELECT id FROM document_lines WHERE document_id=? ORDER BY position').all(...([copy?.id ?? ''] as never[])) as { id: string }[]).map(line => line.id);
      expect(Object.keys((JSON.parse(copy?.header ?? '{}') as { formats: { lines: Record<string, unknown> } }).formats.lines).sort()).toEqual([...lineIds].sort());
    } finally { copied.close(); }
    await writeFile(evidencePath('cell-format.json'), JSON.stringify({ ...subject(), isolatedSynthetic: true, toolbar: true, range: true, shortcut: true, excel: true, overwrite: true, print: true, reopen: true, duplicate: true }, null, 2));
  } finally { await shutdown(application); await f.cleanup(); }
});

test('Ctrl+Z and Ctrl+Y undo and redo format changes in order with typed text', async () => {
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow(); await startInvoice(page);
    await addEmptyLine(page);
    const name = page.getByLabel('明細1 品名', { exact: true });
    await name.fill('架空取消');
    await hit(page, 6, 1).click();
    await expect(name).toBeFocused();
    await expect(button(page, '書式を元に戻す')).toBeDisabled();
    await button(page, '左揃え').click();
    await expect(text(page, 'B6')).toHaveCSS('justify-content', 'flex-start');
    // 書式の後に文字を入力し、また書式を変える。
    await name.press('End'); await page.keyboard.type('X');
    await page.keyboard.press('Control+b');
    await expect(text(page, 'B6')).toHaveCSS('font-weight', '700');
    // 入力欄で Ctrl+Z: 直前が書式なら書式を戻し、次は入力欄の標準の取り消し（文字）になる。
    await page.keyboard.press('Control+z');
    await expect(text(page, 'B6')).toHaveCSS('font-weight', '400');
    await expect(name).toHaveValue('架空取消X');
    await page.keyboard.press('Control+z');
    await expect(name).toHaveValue('架空取消');
    await expect(text(page, 'B6')).toHaveCSS('justify-content', 'flex-start');
    // ボタンはいつでも書式を戻す（既定の中央揃えに戻る）。
    await button(page, '書式を元に戻す').click();
    await expect(text(page, 'B6')).toHaveCSS('justify-content', 'center');
    await expect(button(page, '書式を元に戻す')).toBeDisabled();
    await expect(button(page, '書式をやり直す')).toBeEnabled();
    for (const width of [1280, 768]) await capture(page, 'cell-format-undo', width);
    await page.setViewportSize({ width: 1120, height: 760 });
    // 入力欄の外（見出しのセルを選んだ後）では Ctrl+Y・Ctrl+Shift+Z で、戻した順の逆にやり直す。
    await hit(page, 5, 1).click();
    await expect(name).not.toBeFocused();
    await page.keyboard.press('Control+y');
    await expect(text(page, 'B6')).toHaveCSS('justify-content', 'flex-start');
    await expect(text(page, 'B6')).toHaveCSS('font-weight', '400');
    await page.keyboard.press('Control+Shift+z');
    await expect(text(page, 'B6')).toHaveCSS('font-weight', '700');
    await expect(button(page, '書式をやり直す')).toBeDisabled();
    await saved(page);
    const db = f.database();
    try {
      const header = JSON.parse(String((db.prepare('SELECT header FROM documents').get() ?? {})['header'])) as { formats: { lines: Record<string, unknown> } };
      expect(Object.values(header.formats.lines)).toEqual([{ name: { horizontal: 'left', bold: true } }]);
    } finally { db.close(); }
    // 新しく文字を入力すると、書式のやり直しはできなくなる。
    await page.keyboard.press('Control+z');
    await expect(text(page, 'B6')).toHaveCSS('font-weight', '400');
    await expect(button(page, '書式をやり直す')).toBeEnabled();
    await name.press('End'); await page.keyboard.type('Y');
    await expect(button(page, '書式をやり直す')).toBeDisabled();
    await writeFile(evidencePath('cell-format-undo.json'), JSON.stringify({ ...subject(), isolatedSynthetic: true, undoRedoShortcuts: true, typedTextOrder: true, toolbarButtons: true, saved: true }, null, 2));
  } finally { await shutdown(application); await f.cleanup(); }
});

// 入力欄にフォーカスしたまま、書式と文字の取り消し・やり直しを1本の順番で往復できる（文字は入力欄の標準の取り消し）。
test('undo and redo walk format changes and typed text in one order while the field keeps focus', async () => {
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow(); await startInvoice(page);
    await addEmptyLine(page);
    const name = page.getByLabel('明細1 品名', { exact: true });
    await name.fill('Review');
    // 書式 → 文字 → 書式 の順に操作する。
    await hit(page, 6, 1).click();
    await button(page, '左揃え').click();
    await name.press('End'); await page.keyboard.type('X');
    await page.keyboard.press('Control+b');
    await expect(text(page, 'B6')).toHaveCSS('font-weight', '700');
    // Ctrl+Z を3回: 太字 → 入力した文字 → 左揃え の順に戻り、それより前の入力（Review）は残る。
    await page.keyboard.press('Control+z');
    await expect(text(page, 'B6')).toHaveCSS('font-weight', '400');
    await expect(name).toHaveValue('ReviewX');
    await page.keyboard.press('Control+z');
    await expect(name).toHaveValue('Review');
    await expect(text(page, 'B6')).toHaveCSS('justify-content', 'flex-start');
    await page.keyboard.press('Control+z');
    await expect(text(page, 'B6')).toHaveCSS('justify-content', 'center');
    await expect(name).toHaveValue('Review');
    await expect(name).toBeFocused();
    // Ctrl+Y を3回: 戻した順の逆（左揃え → 文字 → 太字）にやり直す。
    await page.keyboard.press('Control+y');
    await expect(text(page, 'B6')).toHaveCSS('justify-content', 'flex-start');
    await expect(name).toHaveValue('Review');
    await page.keyboard.press('Control+y');
    await expect(name).toHaveValue('ReviewX');
    await expect(text(page, 'B6')).toHaveCSS('font-weight', '400');
    await page.keyboard.press('Control+y');
    await expect(text(page, 'B6')).toHaveCSS('font-weight', '700');
    await expect(button(page, '書式をやり直す')).toBeDisabled();
    // もう一度戻すときも同じ順番。
    await page.keyboard.press('Control+z');
    await expect(text(page, 'B6')).toHaveCSS('font-weight', '400');
    await page.keyboard.press('Control+z');
    await expect(name).toHaveValue('Review');
    await page.keyboard.press('Control+z');
    await expect(text(page, 'B6')).toHaveCSS('justify-content', 'center');
  } finally { await shutdown(application); await f.cleanup(); }
});

test('display-only controls keep the format redo history', async () => {
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow(); await startInvoice(page);
    await addEmptyLine(page);
    await page.getByLabel('明細1 品名', { exact: true }).fill('架空表示');
    await hit(page, 6, 1).click();
    await button(page, '太字').click();
    await page.keyboard.press('Control+z');
    await expect(text(page, 'B6')).toHaveCSS('font-weight', '400');
    await expect(button(page, '書式をやり直す')).toBeEnabled();
    // 「入力欄に色を付ける」は表示だけの切り替え。帳票の内容ではないため、やり直しの履歴は残る。
    const guide = page.getByRole('checkbox', { name: '入力欄に色を付ける' });
    await guide.uncheck(); await guide.check();
    await expect(button(page, '書式をやり直す')).toBeEnabled();
    await button(page, '書式をやり直す').click();
    await expect(text(page, 'B6')).toHaveCSS('font-weight', '700');
  } finally { await shutdown(application); await f.cleanup(); }
});
