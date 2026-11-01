import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { allXml } from '../fixtures/xlsx';
import { fixture, subject } from './app';
import type { TestApp } from './app';
import { evidencePath } from './evidence';

// 明細のチェックは任意の項目（利用者の指示、2026年10月16日）。選ばない明細は確認事項にせず、チェック欄を空欄で出力する。
// 壊しに行く操作: チェックのボタンにフォーカスしたまま Space で選んでは外し、フォーカスを動かさずに確認事項とプレビューが追従すること。

async function startInvoice(page: Page): Promise<void> {
  await page.getByRole('button', { name: '請求書', exact: true }).click();
  await page.getByRole('button', { name: '新規請求書', exact: true }).click();
  await expect(page.getByLabel('管理用タイトル', { exact: true })).toBeVisible();
}
async function addEmptyLine(page: Page): Promise<void> {
  await page.getByLabel('材料を検索して明細に追加', { exact: true }).click();
  await page.getByRole('button', { name: '空の明細を追加', exact: true }).click();
}
async function destination(application: TestApp, selected: string): Promise<void> {
  await application.dialog('save', selected);
  await application.dialog('message', 1);
}
const radio = (page: Page, name: string) => page.getByRole('radiogroup', { name: '明細1 チェック状態', exact: true }).getByRole('radio', { name, exact: true });
const previewMark = (page: Page) => page.locator('.sheet-texts [data-cell="A6"]');

test('an unselected check is optional: no issue, and Excel and PDF output leave the check cell blank', async () => {
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow(); await startInvoice(page);
    await page.getByLabel('管理用タイトル', { exact: true }).fill('架空任意');
    await addEmptyLine(page);
    await page.getByLabel('明細1 品名', { exact: true }).fill('架空任意材料');
    // 追加直後の明細は未選択。確認事項・警告の色・プレビューの印はなく、出力の準備ができている。
    for (const name of ['材料のみ（●）', '伝票のみ（○）', '材料・伝票とも納品（⦿）']) await expect(radio(page, name)).toHaveAttribute('aria-checked', 'false');
    const ready = page.getByRole('button', { name: '出力の準備ができています', exact: true });
    await expect(ready).toBeDisabled();
    const row = page.locator('.lines tbody tr[id^="line-row-"]');
    await expect(row).toHaveCount(1); await expect(row).not.toHaveClass(/warn/u);
    await expect(page.locator('.check-toggle.unset')).toHaveCount(0);
    await expect(page.locator('.sheet-issue')).toHaveCount(0);
    await expect(previewMark(page)).toHaveCount(0);

    // フォーカスをチェックのボタンに置いたまま、Space で選んで外す。
    const filled = radio(page, '材料のみ（●）');
    await filled.focus(); await page.keyboard.press('Space');
    await expect(filled).toHaveAttribute('aria-checked', 'true'); await expect(filled).toBeFocused();
    await expect(previewMark(page)).toHaveText('●');
    await page.keyboard.press('Space');
    await expect(filled).toHaveAttribute('aria-checked', 'false'); await expect(filled).toBeFocused();
    await expect(previewMark(page)).toHaveCount(0);
    await expect(ready).toBeDisabled(); await expect(row).not.toHaveClass(/warn/u);
    await expect(page.locator('.check-toggle.unset')).toHaveCount(0);
    await expect(page.locator('.sheet-issue')).toHaveCount(0);

    // Excel出力は止まらず、チェック欄（A6）は値を持たない書式だけのセル、品名（B6）はそのまま。
    const target = path.join(f.root, 'optional.xlsx');
    await destination(application, target); await page.getByRole('button', { name: 'Excelへ出力', exact: true }).click();
    await expect(page.getByRole('status', { name: 'Excel出力状態' })).toContainText('をExcelへ出力しました');
    const sheet = (await allXml(await readFile(target))).get('xl/worksheets/sheet1.xml') ?? '';
    expect(sheet).toMatch(/<c r="A6" s="\d+"\/>/u);
    expect(sheet).toMatch(/<c r="B6" s="\d+" t="inlineStr"><is><t xml:space="preserve">架空任意材料<\/t><\/is><\/c>/u);

    // 印刷プレビュー（PDF）も止まらず、チェック欄に文字を置かない。
    await destination(application, path.join(f.root, 'optional.pdf'));
    await page.getByRole('button', { name: '印刷プレビュー・PDF', exact: true }).click();
    const p = await application.waitForPreview(); await p.getByRole('link', { name: 'PDFとして保存', exact: true }).waitFor();
    // 行6の文字は品名だけ（品名は空いたチェック欄へはみ出して中央に置かれる）。
    await expect(p.locator('div.t.r6')).toHaveText(['架空任意材料']);
    await Promise.all([p.waitForEvent('domcontentloaded'), p.getByRole('link', { name: 'PDFとして保存', exact: true }).click()]);
    await expect(p.getByRole('status')).toContainText('PDFを保存しました');
    await p.getByRole('link', { name: '閉じる', exact: true }).click();

    // 請求書一覧でも確認の件数に数えない。
    await page.getByRole('button', { name: '← 請求書一覧', exact: true }).click();
    const card = page.getByRole('article', { name: '架空任意' });
    await expect(card).toContainText('出力済み'); await expect(card).not.toContainText('確認');
    await writeFile(evidencePath('optional-check.json'), JSON.stringify({ ...subject(), isolatedSynthetic: true, unselectedNotIssue: true, keyboardDeselectKeepsFocus: true, excelBlankMark: true, pdfBlankMark: true, historyNotCounted: true }, null, 2));
  } finally { await application.close(); await f.cleanup(); }
});
