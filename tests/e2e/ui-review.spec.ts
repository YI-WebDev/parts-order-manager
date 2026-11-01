import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { syntheticWorkbook, textCell, workbookParts, zipParts } from '../fixtures/xlsx';
import { fixture, openImport, pick } from './app';

// 画面全体の UI/UX の見直しで直した表示（2026年10月19日）。
// - 材料が1件もないときの材料台帳・材料パレットは、条件の変更ではなく登録の仕方を案内する（空白だけのキーワードは絞り込みとみなさない）。
// - 取込ウィザードの「この取込を取り消す」は、取り消す取込（解析した確認中の記録）ができてから出す。確定前の件数は、0件を注意の色で出さない。
// - 最小のウィンドウ幅（720px）でも見出しと編集画面のフッターを1段に収める。省略した値は「…」で示す。
// - バックアップの注意はエラーの赤でなく注意の色で出し、開いている請求書は一覧のカードに文字でも示す。
// 状態と表示（取込ウィザードのフッター）:
// | 段階                         | 取込の記録        | 「この取込を取り消す」 |
// | 1. 種類・2. ファイル         | なし              | 出さない               |
// | 2. ファイル（解析に失敗）    | なし              | 出さない               |
// | 3. 内容を確認・4. 確定       | 確認中            | 出す                   |

const FILTERED = '該当する材料はありません。キーワードやカテゴリを変更してください。';
const palette = (page: Page) => page.getByRole('dialog', { name: '材料検索' });
const paletteStatus = (page: Page) => palette(page).locator('.palette-status');
const paletteField = (page: Page) => palette(page).getByRole('combobox', { name: 'キーワード', exact: true });
const ledger = (page: Page) => page.getByRole('region', { name: '材料' });
/** 材料台帳の件数・空の表示（選択の帯の「N件を選択中」の status は除く）。 */
const ledgerStatus = (page: Page) => ledger(page).locator('p[role="status"]:not([aria-label])');
const wizard = (page: Page) => page.getByRole('region', { name: 'Excelから取込' });
const cancelImport = (page: Page) => page.getByRole('button', { name: 'この取込を取り消す', exact: true });
const heldCard = (page: Page) => page.locator('.summary-cards > div').filter({ hasText: '要確認・補足（保留）' });

/** 材料候補だけの架空の材料表（2行目は備考あり、3行目は備考なし）。 */
function cleanWorkbook(): Buffer {
  return zipParts(workbookParts(`<row r="2">${textCell('A2', '架空清書A')}${textCell('B2', 'K-1')}${textCell('C2', '架空社')}${textCell('D2', '1 個')}${textCell('E2', '架空の備考')}</row>`
    + `<row r="3">${textCell('A3', '架空清書B')}${textCell('B3', 'K-2')}${textCell('C3', '架空社')}${textCell('D3', '2 個')}</row>`), true);
}

test('with no materials the ledger and palette explain how to register, and the import wizard offers cancel only for an import it can cancel', async () => {
  test.setTimeout(90_000);
  const f = await fixture(syntheticWorkbook()), app = await f.launch();
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    // 材料パレット: 何も絞り込まずに0件なら登録の仕方。空白だけ（全角を含む）のキーワードも絞り込みではない。キーワードで0件なら従来どおり条件の変更。
    await page.keyboard.press('Control+f');
    const unregistered = '検索できる材料がありません。「材料」タブの「Excelから取込」または「手動で追加」から登録してください。';
    await expect(paletteStatus(page)).toHaveText(unregistered);
    await paletteField(page).fill('　 '); await expect(paletteStatus(page)).toHaveText(unregistered);
    await paletteField(page).fill('架空該当なし'); await expect(paletteStatus(page)).toHaveText(FILTERED);
    await paletteField(page).fill(''); await expect(paletteStatus(page)).toHaveText(unregistered);
    await page.keyboard.press('Escape'); await expect(palette(page)).toHaveCount(0);
    // 材料台帳: 無効を隠しているときは「無効も表示」にも触れる。キーワードで0件なら従来どおり（空の表示の枠は付けない）。
    await page.getByRole('button', { name: '材料', exact: true }).click();
    await expect(ledgerStatus(page)).toHaveText('表示できる材料はありません。「Excelから取込」または「手動で追加」から登録してください（無効にした材料は「無効も表示」で表示できます）。');
    await expect(ledgerStatus(page)).toHaveClass('empty-state');
    await ledger(page).getByRole('checkbox', { name: '無効も表示', exact: true }).check();
    await expect(ledgerStatus(page)).toHaveText('材料はまだ登録されていません。「Excelから取込」または「手動で追加」から登録してください。');
    await ledger(page).getByRole('searchbox', { name: 'キーワード', exact: true }).fill('架空該当なし');
    await expect(ledgerStatus(page)).toHaveText(FILTERED); await expect(ledgerStatus(page)).toHaveClass('note');
    await ledger(page).getByRole('searchbox', { name: 'キーワード', exact: true }).fill('');

    // 取込ウィザード: 種類・ファイルの段階では取り消す記録がないので出さない（解析に失敗しても出さない）。解析すると出る。
    await ledger(page).getByRole('button', { name: 'Excelから取込', exact: true }).click();
    await expect(wizard(page).getByRole('heading', { name: '何を取り込みますか' })).toBeVisible();
    await expect(cancelImport(page)).toHaveCount(0); await expect(page.getByRole('button', { name: '戻る', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '次へ', exact: true }).click();
    await expect(wizard(page).getByRole('heading', { name: 'Excelファイルを選択' })).toBeVisible(); await expect(cancelImport(page)).toHaveCount(0);
    const broken = path.join(f.root, '破損.xlsx'); await writeFile(broken, 'synthetic broken zip');
    await pick(app, page, broken); await expect(wizard(page).getByRole('alert')).toBeVisible(); await expect(cancelImport(page)).toHaveCount(0);
    // 戻っても出ない（その場にとどまる操作）。
    await page.getByRole('button', { name: '戻る', exact: true }).click(); await expect(wizard(page).getByRole('heading', { name: '何を取り込みますか' })).toBeVisible(); await expect(cancelImport(page)).toHaveCount(0);
    await page.getByRole('button', { name: '次へ', exact: true }).click();
    await pick(app, page, f.source); await expect(page.getByRole('region', { name: '取込確認' })).toBeVisible(); await expect(cancelImport(page)).toBeEnabled();
    // 確定の段階: 保留する要確認・補足があるときだけ注意の色。
    await page.getByRole('button', { name: '次へ', exact: true }).click();
    await expect(heldCard(page)).not.toContainText('0件'); await expect(heldCard(page)).toHaveClass('warn');
    await cancelImport(page).click(); await expect(page.getByRole('table', { name: '取込履歴' })).toContainText('取消');

    // 材料候補だけの材料表では、保留する要確認・補足は0件で、注意の色を付けない。
    const clean = path.join(f.root, '架空清書.xlsx'); await writeFile(clean, cleanWorkbook());
    await openImport(page, 'first'); await pick(app, page, clean); await expect(page.getByRole('region', { name: '取込確認' })).toContainText('材料候補 2件');
    await page.getByRole('button', { name: '次へ', exact: true }).click();
    await expect(heldCard(page).locator('dd')).toHaveText('0件'); await expect(heldCard(page)).not.toHaveAttribute('class');
    await page.getByRole('checkbox', { name: '件数と内容を確認しました' }).check();
    await page.getByRole('button', { name: '選択した候補を確定', exact: true }).click(); await expect(wizard(page).locator('p.status-line[role="status"]')).toContainText('反映 2件');

    // 登録した後は件数を出す（空の表示ではない）。材料パレットの結果は、空欄の備考を「備考なし」と出さない。
    await page.getByRole('button', { name: '材料台帳を開く', exact: true }).click();
    await expect(ledgerStatus(page)).toHaveText('2件中 1～2件'); await expect(ledgerStatus(page)).toHaveClass('note');
    await page.keyboard.press('Control+f'); await paletteField(page).fill('架空清書');
    const notes = palette(page).getByRole('listbox', { name: '検索結果' }).getByRole('option').locator('.result-main .note');
    await expect(notes).toHaveText(['K-1 ・ 架空社 ・ 架空の備考', 'K-2 ・ 架空社']);
  } finally { await app.close(); await f.cleanup(); }
});

test('the minimum window keeps the header and the editor footer on one row, and the list marks the open invoice and shows the backup reminder as a caution', async () => {
  test.setTimeout(60_000);
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow();
    // 別の請求書を1件保存しておく（開いている請求書だけに印が付くことを確かめる）。
    await page.evaluate(async () => {
      const opened = await window.appApi.documents.open(null); if (opened.status !== 'ok') throw new Error('open');
      const saved = await window.appApi.documents.save({ sessionId: opened.data.sessionId, requestNumber: 1, generation: 1, expectedRevision: 0, draft: { ...opened.data.draft, title: '架空の別件' } });
      if (saved.status !== 'ok') throw new Error('save');
    });
    await page.reload(); await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    // バックアップの記録がない注意は、エラーの赤ではなく注意の色。設定へ移るボタンは削除・取消の色にしない。
    const warning = page.getByRole('alert').filter({ hasText: 'この端末で作成したバックアップの記録がありません。' });
    await expect(warning).toHaveCSS('border-left-color', 'rgb(107, 77, 0)'); await expect(warning).toHaveCSS('color', 'rgb(107, 77, 0)');
    await expect(warning.getByRole('button', { name: 'バックアップへ', exact: true })).toHaveCSS('color', 'rgb(37, 79, 70)');

    // 見出し: 720px では1段（材料を検索…も同じ段）。375px では検索が次の段へ回り、横にはみ出さない。
    const header = page.locator('.app-header'), launcher = page.getByRole('button', { name: '材料を検索…', exact: true });
    const tab = page.getByRole('navigation', { name: 'メインナビゲーション' }).getByRole('button', { name: '設定', exact: true });
    await page.setViewportSize({ width: 720, height: 520 });
    expect(await header.evaluate(element => (element as HTMLElement).offsetHeight)).toBeLessThanOrEqual(57);
    const [launcherBox, tabBox] = [await launcher.boundingBox(), await tab.boundingBox()];
    expect(launcherBox && tabBox && launcherBox.y < tabBox.y + tabBox.height && launcherBox.x > tabBox.x + tabBox.width).toBe(true);
    await page.setViewportSize({ width: 375, height: 720 });
    const [narrowLauncher, narrowTab] = [await launcher.boundingBox(), await tab.boundingBox()];
    expect(narrowLauncher && narrowTab && narrowLauncher.y >= narrowTab.y + narrowTab.height).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.setViewportSize({ width: 1120, height: 760 });
    await page.getByRole('button', { name: '新規請求書', exact: true }).click();
    await page.getByLabel('管理用タイトル', { exact: true }).fill('架空の編集中');
    await page.getByLabel('材料を検索して明細に追加', { exact: true }).click(); await page.getByRole('button', { name: '空の明細を追加', exact: true }).click();
    const maker = page.getByLabel('明細1 メーカー', { exact: true });
    await maker.fill('架空の長いメーカー名'.repeat(8));
    // 列に収まらない1行の値は「…」で省略を示す。
    await expect(maker).toHaveCSS('text-overflow', 'ellipsis');
    expect(await maker.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    const footer = page.locator('.editor-footer'), saved = footer.getByRole('status', { name: '保存状態' });
    await expect(saved).toHaveText('保存済み');
    // 広い幅では Ctrl+S の説明も出す。720px では説明を省いてフッターを1段に収める（ボタンは44px）。
    await expect(footer.locator('.note')).toHaveText(/^保存版 \d+ ・ Ctrl\+Sで今すぐ保存$/); await expect(footer.locator('.footer-hint')).toBeVisible();
    await page.setViewportSize({ width: 720, height: 520 });
    await expect(footer.locator('.footer-hint')).toBeHidden(); await expect(footer.locator('.note')).toBeVisible();
    expect(await footer.evaluate(element => (element as HTMLElement).offsetHeight)).toBeLessThan(80);
    // 数式バーの値・案内は「…」で省略し、全文は title で見られる。
    const value = page.getByRole('status', { name: '選択中のセル', exact: true }).locator('.sheet-value');
    await expect(value).toHaveCSS('text-overflow', 'ellipsis');
    const text = await value.textContent();
    expect(text).not.toBe(''); await expect(value).toHaveAttribute('title', text ?? '');
    expect(await value.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 1120, height: 760 });

    // 一覧へ戻ると、開いている請求書のカードにだけ「編集中」。
    await page.getByRole('button', { name: '← 請求書一覧', exact: true }).click();
    const card = (title: string) => page.getByRole('article', { name: title, exact: true });
    await expect(card('架空の編集中').locator('.badge.editing')).toHaveText('編集中');
    await expect(card('架空の別件')).toBeVisible(); await expect(card('架空の別件').locator('.badge.editing')).toHaveCount(0);
    // 別の請求書を開くと、印もそちらへ移る。
    await card('架空の別件').getByRole('button', { name: /を開く$/ }).click(); await expect(page.getByLabel('管理用タイトル', { exact: true })).toHaveValue('架空の別件');
    await page.getByRole('button', { name: '← 請求書一覧', exact: true }).click();
    await expect(card('架空の別件').locator('.badge.editing')).toHaveText('編集中'); await expect(card('架空の編集中').locator('.badge.editing')).toHaveCount(0);
  } finally { await app.close(); await f.cleanup(); }
});
