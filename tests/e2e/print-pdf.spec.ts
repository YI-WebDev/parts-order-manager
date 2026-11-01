import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile, writeFile, copyFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { expectInBackground, fixture, capture, subject, target } from './app';
import type { TestApp } from './app';
import { evidencePath } from './evidence';
async function start(page: Page): Promise<void> { await page.getByRole('button', { name: '請求書', exact: true }).click(); await page.getByRole('button', { name: '新規請求書', exact: true }).click(); }
async function addEmptyLine(page: Page): Promise<void> { await page.getByLabel('材料を検索して明細に追加', { exact: true }).click(); await page.getByRole('button', { name: '空の明細を追加', exact: true }).click(); }
function checkRadio(page: Page, name: string) { return page.getByRole('radiogroup', { name: '明細1 チェック状態', exact: true }).getByRole('radio', { name, exact: true }); }
/** 印刷プレビューは画面側の事前判定を持たず Main が blocked を返す。その結果は、Excel出力と同じ確認事項の一覧に出る（O-07）。 */
function printBlocked(page: Page) { return page.getByRole('alert', { name: '出力前の確認事項' }).filter({ hasText: '確認が必要なため印刷プレビューを止めました' }); }
async function stop(app: TestApp): Promise<void> { await app.close(); }
async function destination(app: TestApp, selected: string | null, overwrite = true): Promise<void> { await app.dialog('save', selected); await app.dialog('message', overwrite ? 1 : 0); }
async function preview(app: TestApp, page: Page): Promise<Page> { await page.getByRole('button', { name: '印刷プレビュー・PDF', exact: true }).click(); const p = await app.waitForPreview(); await p.getByRole('link', { name: 'PDFとして保存', exact: true }).waitFor(); return p; }
/** 出力を止めた操作でファイル選択が開かれていないこと（旧版は showSaveDialog が呼ばれたら失敗にしていた）。 */
async function expectNoFileDialog(app: TestApp): Promise<void> { expect((await app.events()).filter(event => event.type === 'dialog' && event['kind'] === 'save')).toEqual([]); }
async function save(p: Page, expected: string): Promise<void> { await Promise.all([p.waitForEvent('domcontentloaded'), p.getByRole('link', { name: 'PDFとして保存', exact: true }).click()]); await expect(p.getByRole('status')).toContainText(expected); }
async function record(name: string, value: object): Promise<void> { await writeFile(evidencePath(name), JSON.stringify({ ...subject(), isolatedSynthetic: true, dialogsMocked: true, realPdfEngine: target === 'webview2', ...value }, null, 2)); }

test('PDF zero and one row: latest save, literal content, cancellation, overwrite, failure and preview boundary', async () => {
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow(); await start(page);
    await page.getByLabel('管理用タイトル', { exact: true }).fill('PRIVATE-TITLE-NOT-OUTPUT');
    const zero = path.join(f.root, 'zero.pdf'); await destination(app, zero);
    let p = await preview(app, page);
    await expect(page.getByLabel('管理用タイトル', { exact: true })).toBeDisabled();
    // プレビューはスクリプトを含まない（アプリ版はスクリプト無効の別ウィンドウ。CSP でもスクリプトを禁止している）。
    await expect(p.locator('script')).toHaveCount(0);
    expect((await app.windows()).map(w => w.label).sort()).toEqual(['main', 'preview']); await expectInBackground(app);
    await save(p, 'PDFを保存しました'); await copyFile(zero, evidencePath('zero.pdf')); await capture(p, 'preview-zero', 960);
    await p.getByRole('link', { name: '閉じる', exact: true }).click(); await expect(page.getByLabel('管理用タイトル', { exact: true })).toBeEnabled(); await expectInBackground(app);
    await addEmptyLine(page);
    await page.getByLabel('上部欄', { exact: true }).fill('架空帳票一号');
    await page.getByLabel('ヘッダー欄（左）', { exact: true }).fill('001');
    await page.getByLabel('納期', { exact: true }).fill('2026/9/25');
    await page.getByLabel('明細1 品名', { exact: true }).fill('=SUM(1,2)');
    await page.getByLabel('明細1 型式', { exact: true }).fill('001-A');
    await page.getByLabel('明細1 メーカー', { exact: true }).fill('架空メーカー');
    await page.getByLabel('明細1 数量', { exact: true }).fill('02 本');
    await page.getByLabel('明細1 備考', { exact: true }).fill('前半\n後半 <script>無害</script>');
    await checkRadio(page, '材料のみ（●）').click(); await expect(checkRadio(page, '材料のみ（●）')).toHaveAttribute('aria-checked', 'true');
    const one = path.join(f.root, 'one.pdf'); await destination(app, null); p = await preview(app, page); await save(p, '取り消しました');
    await destination(app, one); await save(p, 'PDFを保存しました'); await copyFile(one, evidencePath('one.pdf')); const original = await readFile(one);
    await destination(app, one, false); await save(p, '上書きを取り消しました'); expect(await readFile(one)).toEqual(original);
    await destination(app, one); await save(p, 'PDFを保存しました');
    await destination(app, path.join(f.root, 'missing', 'failed.pdf')); await save(p, '保存できません'); await capture(p, 'preview-write-failure', 768);
    expect((await readdir(f.root)).filter(v => v.startsWith('.parts-order-'))).toEqual([]);
    await p.getByRole('link', { name: '閉じる', exact: true }).click();
    await destination(app, path.join(f.root, 'one.xlsx')); await page.getByRole('button', { name: 'Excelへ出力', exact: true }).click(); await expect(page.getByRole('status', { name: 'Excel出力状態' })).toContainText('出力しました'); await copyFile(path.join(f.root, 'one.xlsx'), evidencePath('one.xlsx'));
    await record('print-basic.json', { zero: true, one: true, cancel: true, overwriteDeclinedAndAccepted: true, writeFailure: true, savedBeforePreview: true });
  } finally { await stop(app); await f.cleanup(); }
});

// PDF・印刷はExcelプレビューと同じ帳票の形でA4縦1ページに収める。セルに入りきらない長文はExcelと同じく途中で切れる（保存内容は変わらない）。
test('47 lines with long text fit one sheet page; 48 are blocked while an unselected check is not an issue', async () => {
  test.setTimeout(90000);
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow(); await start(page);
    const saved = await page.evaluate(async () => {
      const opened = await window.appApi.documents.open(null); if (opened.status !== 'ok') throw new Error('open');
      const bases = []; for (let i = 0; i < 47; i++) { const added = await window.appApi.documents.addLine({ sessionId: opened.data.sessionId, materialId: null }); if (added.status !== 'ok') throw new Error('line'); bases.push(added.data); }
      const lines = bases.map((base, i) => ({ ...base, name: `架空材料${String(i + 1).padStart(2, '0')}`, model: `00${i}-A`, manufacturer: '架空製造', quantity: '02 本', remarks: i === 0 ? Array.from({length: 80}, (_, n) => `長文${String(n + 1).padStart(2, '0')} 日本語折り返しと改行の確認`).join('\n') : `注記${i + 1}`, deliveryState: i % 2 ? 'slip_only' as const : 'material_only' as const, markOutput: i % 2 ? 'open_circle' as const : 'filled_circle' as const }));
      const result = await window.appApi.documents.save({ sessionId: opened.data.sessionId, requestNumber: 1, generation: 1, expectedRevision: 0, draft: { ...opened.data.draft, title: '架空47行', header: { ...opened.data.draft.header, C2: '架空長文帳票' }, lines } });
      if (result.status !== 'ok') throw new Error('save'); return result.data;
    });
    await page.reload(); await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible(); await page.getByRole('article', { name: '架空47行' }).getByRole('button', { name: /を開く$/ }).click();
    await destination(app, path.join(f.root, 'long47.pdf')); const p = await preview(app, page); await save(p, 'PDFを保存しました'); await copyFile(path.join(f.root, 'long47.pdf'), evidencePath('long47.pdf')); await capture(p, 'preview-long47', 960); await p.getByRole('link', { name: '閉じる', exact: true }).click();
    await destination(app, path.join(f.root, 'long47.xlsx')); await page.getByRole('button', { name: 'Excelへ出力', exact: true }).click(); await expect(page.getByRole('status', { name: 'Excel出力状態' })).toContainText('出力しました'); await copyFile(path.join(f.root, 'long47.xlsx'), evidencePath('long47.xlsx'));
    await addEmptyLine(page); await expect(page.locator('.line-cap')).toHaveText('48 / 47行'); await page.getByRole('button', { name: '印刷プレビュー・PDF', exact: true }).click(); await expect(printBlocked(page)).toContainText('47行'); expect(await app.windows()).toHaveLength(1);
    // Excel出力は画面の事前判定で止まり（Main を呼ばない）、確認事項は47行超過だけ（チェックは任意の項目のため、未選択の明細48は並ばない）。
    await app.clearDialog('save'); await app.clearEvents();
    await page.getByRole('button', { name: 'Excelへ出力', exact: true }).click();
    const issues = page.getByRole('alert', { name: '出力前の確認事項' });
    await expect(issues).toContainText('明細が47行を1行超えています'); await expect(issues.getByRole('listitem')).toHaveCount(1); await expectNoFileDialog(app);
    await record('print-long.json', { saved, fortySevenWithLongFirstLine: true, fortyEightBlocked: true, unselectedCheckNotIssue: true, excelPrecheckPopover: true });
  } finally { await stop(app); await f.cleanup(); }
});

// O-07: 止めた理由は全件をつなげた警告にせず、Excel出力と同じ確認事項の一覧（件数・スクロール・該当行への移動）で示す。
// 明細の下の方にいたまま（数量でEnterを続けた状態）印刷し、編集画面が押し出されないこと・一覧が画面内に収まることを確かめる。
// チェックは任意の項目（利用者の指示、2026年10月16日）のため、止まるのは記号を決める前に保存した「共に納品」（記号未確定）の45行だけで、未選択の明細46は並ばない。
test('blocked print lists 45 unresolved marks in the issues popover without pushing the editor', async () => {
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow(); await start(page);
    const ids = await page.evaluate(async () => {
      const opened = await window.appApi.documents.open(null); if (opened.status !== 'ok') throw new Error('open');
      const lines = []; for (let i = 0; i < 46; i++) { const added = await window.appApi.documents.addLine({ sessionId: opened.data.sessionId, materialId: null }); if (added.status !== 'ok') throw new Error('line'); lines.push(added.data); }
      const result = await window.appApi.documents.save({ sessionId: opened.data.sessionId, requestNumber: 1, generation: 1, expectedRevision: 0, draft: { ...opened.data.draft, title: '架空46行', lines } });
      if (result.status !== 'ok') throw new Error('save');
      return lines.slice(0, 45).map(line => line.id);
    });
    // 画面からは作れない記号未確定の明細（「共に納品」の記号を決める前の版で保存したもの）を DB で作る。
    const db = f.database(); try { for (const id of ids) db.prepare("UPDATE document_lines SET delivery_state='both', mark_output='unresolved' WHERE id=?").run(id); } finally { db.close(); }
    await page.reload(); await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible(); await page.getByRole('article', { name: '架空46行' }).getByRole('button', { name: /を開く$/ }).click();
    await page.getByLabel('明細46 数量', { exact: true }).focus();
    const editor = page.getByRole('region', { name: '請求書編集' }), scroller = page.locator('.editor-scroll');
    const before = { top: (await editor.boundingBox())?.y, scroll: await scroller.evaluate(element => element.scrollTop) };
    expect(before.scroll).toBeGreaterThan(0);
    await app.clearDialog('save'); await app.clearEvents();
    const print = page.getByRole('button', { name: '印刷プレビュー・PDF', exact: true });
    await print.click();
    // 本体の判定が返り、操作できる状態に戻るまで待ってから、画面の位置を比べる（旧版はここで上部に巨大な警告が入り、編集画面が押し出された）。
    await expect(page.getByLabel('明細1 品名', { exact: true })).toBeEnabled();
    await expect(print).toBeFocused();
    await expect(page.locator('.app-message')).toHaveCount(0);
    expect({ top: (await editor.boundingBox())?.y, scroll: await scroller.evaluate(element => element.scrollTop) }).toEqual(before);
    const issues = page.getByRole('alert', { name: '出力前の確認事項' });
    await expect(issues).toContainText('確認が必要なため印刷プレビューを止めました');
    await expect(issues.getByRole('listitem')).toHaveCount(45);
    await expect(issues).toContainText('明細45「（品名なし）」のチェック記号が未確定（材料・伝票とも。「⦿」を選び直してください）');
    await expect(issues).not.toContainText('明細46');
    // 本体の長い理由（「空欄へ自動変換せず…」）は、画面の短い項目と同じ行のものとしてまとめ、重ねて出さない。
    await expect(issues).not.toContainText('空欄へ自動変換せず');
    expect(await app.windows()).toHaveLength(1); await expectNoFileDialog(app);
    // 一覧は画面の高さに収め、見出しを残したまま項目だけをスクロールする。
    const height = await page.evaluate(() => window.innerHeight), box = await issues.boundingBox();
    expect(box && box.y >= 0 && box.y + box.height <= height).toBe(true);
    const list = issues.getByRole('list');
    expect(await list.evaluate(element => { element.scrollTop = element.scrollHeight; return element.scrollTop > 0; })).toBe(true);
    await expect(issues.getByText('確認が必要なため印刷プレビューを止めました', { exact: true })).toBeInViewport();
    await capture(page, 'print-blocked-issues', 1120);
    // 項目から該当の明細へ移動できる（一覧は閉じる）。
    await issues.getByRole('button', { name: '明細1「（品名なし）」のチェック記号が未確定（材料・伝票とも。「⦿」を選び直してください）', exact: true }).click();
    await expect(issues).toHaveCount(0);
    // 記号未確定の明細は「共に納品」の記号が選び直す先（矢印キーで移れる位置）になっている。
    await expect(page.getByRole('radiogroup', { name: '明細1 チェック状態', exact: true }).getByRole('radio', { name: '材料・伝票とも納品（⦿）', exact: true })).toBeFocused();
    // 続けてExcel出力を押すと、見出しは印刷のものから変わる。
    await page.getByRole('button', { name: 'Excelへ出力', exact: true }).click();
    await expect(issues).toContainText('Excel出力の前に確認してください'); await expect(issues).not.toContainText('印刷プレビュー');
    await expectNoFileDialog(app);
  } finally { await stop(app); await f.cleanup(); }
});

test('printing is explicit non-silent with cancel and failure; revision changes block later actions', async () => {
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow(); await start(page); const p = await preview(app, page);
    for (const mode of ['cancel', 'failure', 'success']) {
      // プリンターの選択ダイアログの結果（アプリ版は Windows の印刷ダイアログ → WebView2 の印刷。ここでは結果だけを差し替える）。
      await app.printOutcome(mode as 'cancel' | 'failure' | 'success');
      await p.getByRole('link', { name: 'プリンターを選んで印刷', exact: true }).click();
      await expect(p.getByRole('status')).toContainText(mode === 'cancel' ? '取り消しました' : mode === 'failure' ? '確認できません' : '受け付けました');
    }
    expect((await app.events()).filter(event => event.type === 'print').map(event => event['silent'])).toEqual([false, false, false]);
    await capture(p, 'print-request-accepted-not-physical', 960);
    await page.evaluate(async () => {
      const list = await window.appApi.documents.list(0); if (list.status !== 'ok' || !list.data.items[0]) throw new Error('list');
      const opened = await window.appApi.documents.open(list.data.items[0].id); if (opened.status !== 'ok') throw new Error('open');
      const result = await window.appApi.documents.save({sessionId:opened.data.sessionId,requestNumber:1,generation:1,expectedRevision:opened.data.revision,draft:{...opened.data.draft,title:'競合後'}}); if (result.status !== 'ok') throw new Error('save');
    });
    await destination(app, path.join(f.root, 'conflict.pdf')); await save(p, '完了できません'); expect(await readdir(f.root)).not.toContain('conflict.pdf');
    await p.getByRole('link', { name: '閉じる', exact: true }).click();
    expect(await page.evaluate(() => Reflect.apply(window.appApi.printing.preview, null, [{ documentId: 'bad', revision: 1, path: 'C:/x.pdf' }]))).toMatchObject({ status: 'error' });
    await record('print-actions.json', { printCallsMocked: true, physicalPrint: 'not executed', silentFalse: true, printerNotPreset: true, cancelAndFailure: true, revisionConflictBlocked: true, arbitraryPathRejected: true });
  } finally { await stop(app); await f.cleanup(); }
});

test('PDF cleanup warnings preserve output and targeted cleanup restores overwrite', async () => {
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow(); await start(page); const target = path.join(f.root, 'cleanup.pdf'); await destination(app, target); const p = await preview(app, page);
    await app.fault('unlink');
    if (process.platform === 'win32') {
      // Windows は新規PDFを一時ファイルの移動で確定するため、一時ファイルが残らず、差し込んだ削除の失敗も使われない。
      await save(p, 'PDFを保存しました'); expect((await readdir(f.root)).filter(name => name.startsWith('.parts-order-'))).toEqual([]);
      expect((await app.events()).filter(event => event.type === 'fault')).toEqual([]); await capture(p, 'pdf-cleanup-committed', 960);
    } else {
      await save(p, '出力確定済み'); const original = await readFile(target); const temp = (await readdir(f.root)).find(name => name.startsWith('.parts-order-')); if (!temp) throw new Error('Missing temp');
      await expect(p.getByRole('status')).toContainText(temp); await capture(p, 'pdf-cleanup-committed', 960);
      await save(p, '出力先を確認'); expect(await readFile(target)).toEqual(original);
      await unlink(path.join(f.root, temp));
      expect(await readFile(target)).toEqual(original); await save(p, 'PDFを保存しました');
    }
    await app.fault('write'); await app.fault('unlink');
    const before = await readFile(target); await save(p, '出力未確定'); expect(await readFile(target)).toEqual(before); await capture(p, 'pdf-cleanup-uncommitted', 960);
    const remaining = (await readdir(f.root)).find(name => name.startsWith('.parts-order-')); if (!remaining) throw new Error('Missing temp');
    await unlink(path.join(f.root, remaining)); await save(p, 'PDFを保存しました');
    await record('print-cleanup.json', { committedAndUncommitted: true, exactTemporaryName: true, originalPreserved: true, targetOnlyCleanupAndRetry: true });
  } finally { await stop(app); await f.cleanup(); }
});

test('PDF previews an unselected check as blank, rejects invalid date and foreign sender before preview; both prints as ⦿', async () => {
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow(); await start(page); await addEmptyLine(page);
    // 追加直後の明細は未選択（どの radio も aria-checked=false）。チェックは任意の項目（利用者の指示、2026年10月16日）のため止めずに、チェック欄を空欄で描く。
    for (const name of ['材料のみ（●）', '伝票のみ（○）', '材料・伝票とも納品（⦿）']) await expect(checkRadio(page, name)).toHaveAttribute('aria-checked', 'false');
    const blank = await preview(app, page);
    await expect(blank.locator('div.t.r6')).toHaveCount(0); await expect(blank.locator('div.t.r53').filter({ hasText: '材料のみ' })).toHaveCount(1);
    await blank.getByRole('link', { name: '閉じる', exact: true }).click(); await expect(page.getByLabel('管理用タイトル', { exact: true })).toBeEnabled();
    await app.clearDialog('save'); await app.clearEvents();
    // 材料・伝票とも納品は凡例どおり ⦿ で出力できる。止まるのは納期だけ。
    await checkRadio(page, '材料・伝票とも納品（⦿）').click(); await expect(checkRadio(page, '材料・伝票とも納品（⦿）')).toHaveAttribute('aria-checked', 'true'); await page.getByLabel('納期', { exact: true }).fill('2026-02-30');
    await page.getByRole('button', { name: '印刷プレビュー・PDF', exact: true }).click(); await expect(printBlocked(page)).toContainText('納期'); await expect(printBlocked(page)).not.toContainText('チェック'); expect(await app.windows()).toHaveLength(1);
    await expectNoFileDialog(app);
    expect(await page.evaluate(() => window.appApi.printing.preview({ documentId: 'bad', revision: 1 }))).toMatchObject({ status: 'error' });
    // 旧版の「別ウィンドウ（preload 付き）からの要求」に当たる、信頼できない送信元からの要求は拒否する（アプリ版では権限設定でメインウィンドウ以外は ipc を呼べず、さらに本体が送信元を確かめる）。
    expect((await app.untrustedInvoke('documents:print-preview', { documentId: 'bad', revision: 1 })).value).toMatchObject({ status: 'error' });
    await record('print-blocked.json', { unselectedPreviewedBlank: true, bothPrintsAsCircledBullet: true, invalidDate: true, malformedRequestRejected: true, foreignSenderRejected: true, noPreview: true });
  } finally { await stop(app); await f.cleanup(); }
});
