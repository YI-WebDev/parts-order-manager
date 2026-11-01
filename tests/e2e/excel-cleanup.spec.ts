import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { capture, fixture, subject, target as appTarget } from './app';
import { evidencePath } from './evidence';

/** 新規出力の確定方法。Windows は一時ファイルを移動して確定し（exFAT・FAT32 でも動く）、一時ファイルが残らない。ほかのOSはハードリンクで確定し、一時ファイルを後で消す。 */
const movesNewOutput = process.platform === 'win32';

for (const phase of ['committed', 'write', 'rename'] as const) {
  test(`cleanup recovery identifies own temp and preserves xlsx during ${phase}`, async () => {
    const f = await fixture(Buffer.alloc(0)), application = await f.launch();
    try {
      const page = await application.firstWindow(), target = path.join(f.root, 'cleanup.xlsx');
      await page.getByRole('button', { name: '請求書', exact: true }).click();
      await page.getByRole('button', { name: '新規請求書', exact: true }).click();
      await page.getByLabel('上部欄', { exact: true }).fill('架空の初版');
      // 保存先の選択と上書き確認（「上書きする」）の答え。
      await application.dialog('save', target);
      await application.dialog('message', 1);
      const button = page.getByRole('button', { name: 'Excelへ出力', exact: true });
      let original: Buffer | null = null;
      if (phase !== 'committed') {
        await button.click(); await expect(page.getByRole('status', { name: 'Excel出力状態' })).toContainText('をExcelへ出力しました');
        original = await readFile(target);
        await page.getByLabel('上部欄', { exact: true }).fill('架空の改訂版');
      }
      const other = path.join(f.root, 'other.tmp'); await writeFile(other, 'KEEP-OTHER');
      // 一時ファイルの削除を1回だけ失敗させる。write・rename では、その前の書込・置換も1回だけ失敗させる（旧版の fs の一回限りの差し替え）。
      await application.fault('unlink');
      if (phase === 'write') await application.fault('write');
      if (phase === 'rename') await application.fault('rename');
      await button.click();
      if (phase === 'committed' && movesNewOutput) {
        // 移動で確定した新規出力は一時ファイルが残らないため、差し込んだ削除の失敗は使われず、残留の案内も出ない。
        await expect(page.getByRole('status', { name: 'Excel出力状態' })).toContainText('をExcelへ出力しました');
        await expect(page.getByRole('alert', { name: 'Excel出力の一時ファイル' })).toHaveCount(0);
        expect((await readdir(f.root)).filter(name => name.startsWith('.parts-order-'))).toEqual([]);
        expect((await stat(target)).nlink).toBe(1);
        expect((await application.events()).filter(event => event.type === 'fault')).toEqual([]);
        expect(await readFile(other, 'utf8')).toBe('KEEP-OTHER');
        await writeFile(evidencePath(`cleanup-${phase}.json`), JSON.stringify({ ...subject(), phase, isolatedSynthetic: true, realPackagedHandler: appTarget === 'webview2', osDialogsMocked: true, movedIntoPlace: true, temporaryLeft: false, unlinkFaultUnused: true, unrelatedTempPreserved: true, afterHash: createHash('sha256').update(await readFile(target)).digest('hex') }, null, 2));
        return;
      }
      // 出力確定後に一時ファイルが残った場合は、成功トースト（Excel出力状態）とは別の alert「Excel出力の一時ファイル」に手順が出る。
      if (phase === 'committed') await expect(page.getByRole('status', { name: 'Excel出力状態' })).toContainText('をExcelへ出力しました');
      const feedback = page.getByRole('alert', { name: phase === 'committed' ? 'Excel出力の一時ファイル' : 'Excel出力エラー' });
      await expect(feedback).toContainText(phase === 'committed' ? '出力は確定済み' : '今回の出力は未確定');
      const names = (await readdir(f.root)).filter(name => name.startsWith('.parts-order-'));
      expect(names).toHaveLength(1); const name = names[0]; if (!name) throw new Error('Missing own temp');
      await expect(feedback).toContainText(name);
      await expect(feedback).toContainText('完全に一致する一時ファイルだけ');
      await expect(feedback).toContainText('完成したxlsxや他のtmpは削除しない');
      await expect(button).toBeFocused();
      const beforeCleanup = await readFile(target);
      if (original) expect(beforeCleanup).toEqual(original);
      expect((await stat(target)).nlink).toBe(phase === 'committed' ? 2 : 1);
      for (const width of [1280, 768, 375]) {
        await page.locator('.editor-scroll').evaluate(element => { element.scrollTop = 0; });
        await capture(page, `cleanup-${phase}`, width);
        await feedback.locator('li').last().scrollIntoViewIfNeeded();
        await capture(page, `cleanup-${phase}-instructions`, width);
      }
      if (phase === 'committed') {
        await button.click(); await expect(page.getByRole('alert', { name: 'Excel出力エラー' })).toBeVisible();
        expect(await readFile(target)).toEqual(beforeCleanup);
      }
      await unlink(path.join(f.root, name));
      await button.click(); await expect(page.getByRole('status', { name: 'Excel出力状態' })).toContainText('をExcelへ出力しました');
      await expect(page.getByRole('alert', { name: 'Excel出力エラー' })).toHaveCount(0);
      await expect(page.getByRole('alert', { name: 'Excel出力の一時ファイル' })).toHaveCount(0);
      expect((await stat(target)).nlink).toBe(1);
      const after = await readFile(target);
      if (phase === 'committed') expect(after).toEqual(beforeCleanup); else expect(after).not.toEqual(beforeCleanup);
      expect(await readFile(other, 'utf8')).toBe('KEEP-OTHER');
      await writeFile(evidencePath(`cleanup-${phase}.json`), JSON.stringify({ ...subject(), phase, isolatedSynthetic: true, realPackagedHandler: appTarget === 'webview2', osDialogsMocked: true, unlinkAndPrecommitFaultInjected: true, temporaryName: name, specificTempOnlyRemoved: true, originalPreserved: true, retrySucceeded: true, unrelatedTempPreserved: true, beforeHash: createHash('sha256').update(beforeCleanup).digest('hex'), afterHash: createHash('sha256').update(after).digest('hex') }, null, 2));
    } finally {
      await application.close(); await f.cleanup();
    }
  });
}
