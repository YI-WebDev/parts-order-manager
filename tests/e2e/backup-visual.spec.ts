import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, expectKeyboardFocus, subject, target as testTarget } from './app';
import { evidencePath } from './evidence';

async function shots(page: Page, state: string): Promise<void> {
  const scroll = page.locator('main.app-main');
  for (const width of [1280, 768, 375]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const extent = await scroll.evaluate(element => ({ height: element.clientHeight, total: element.scrollHeight }));
    for (let offset = 0, slice = 0; offset < extent.total; offset += Math.max(100, extent.height - 80), slice++) {
      await scroll.evaluate((element, top) => { element.scrollTop = top; }, offset);
      await page.screenshot({ path: evidencePath(`${state}-slice-${slice}-${width}.png`), mask: [page.locator('.path')] });
    }
  }
}

test('backup complete lower content notices busy cancellation and keyboard focus', async () => {
  test.setTimeout(120_000);
  const f = await fixture(Buffer.alloc(0)), app = await f.launch();
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '設定', exact: true }).click();
    const panel = page.getByRole('region', { name: 'バックアップと復元', exact: true });
    const save = panel.getByRole('button', { name: '今すぐ保存', exact: true });
    await panel.locator('summary').click();
    await shots(page, 'backup-expanded-notices');
    await save.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); await expectKeyboardFocus(save);
    await save.scrollIntoViewIfNeeded(); await page.screenshot({ path: evidencePath('backup-keyboard-focus-375.png'), mask: [page.locator('.path')] });
    // 保存先の選択を release まで開いたままにし、閉じたら取消を返す。
    await app.dialog('save', null, 'test:visual-save-release');
    await page.keyboard.press('Enter');
    await expect.poll(() => app.count('test:visual-save-release')).toBe(1);
    await expect(save).toBeDisabled(); await expect(panel.locator('p.status-line[role="status"]')).toContainText('処理しています');
    await shots(page, 'backup-busy');
    await app.release('test:visual-save-release');
    await expect(panel.locator('p.notice[role="status"]')).toContainText('取り消しました'); await expect(save).toBeEnabled();
    await shots(page, 'backup-save-cancelled');
    const target = path.join(f.root, 'fictional-visual.pombak');
    await app.dialogs(target, 0);
    await save.click(); await expect(panel.locator('p.notice[role="status"]')).toContainText('バックアップを保存しました');
    await panel.getByRole('button', { name: 'ファイルを選んで検査', exact: true }).click();
    await expect(panel.getByRole('heading', { name: '検査したバックアップ' })).toBeVisible();
    await shots(page, 'backup-inspection-complete');
    const restore = panel.getByRole('button', { name: 'このバックアップへ復元', exact: true });
    await restore.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); await expectKeyboardFocus(restore);
    await restore.scrollIntoViewIfNeeded(); await page.screenshot({ path: evidencePath('backup-restore-focus-375.png'), mask: [page.locator('.path')] });
    await page.keyboard.press('Enter'); await expect(panel.locator('p.notice[role="status"]')).toContainText('取り消しました');
    const invalid = path.join(f.root, 'invalid.pombak'); await writeFile(invalid, 'FICTIONAL INVALID BACKUP');
    await app.dialog('open', invalid);
    await panel.getByRole('button', { name: 'ファイルを選んで検査', exact: true }).click();
    await expect(panel.getByRole('alert')).toBeVisible(); await expect(restore).toHaveCount(0);
    await shots(page, 'backup-error-complete');
    await writeFile(evidencePath('visual-result.json'), JSON.stringify({ ...subject(), fictionalData: true, realAppWindow: testTarget === 'webview2', osDialogsMocked: true, realOsIme: false, widths: [1280, 768, 375], overlappingScrollViewports: true, expandedNotices: true, busyDialogDeferred: true, keyboardEnterSaveAndRestoreCancel: true, pathMask: '.path' }, null, 2));
  } finally {
    await app.close();
    await f.cleanup();
  }
});
