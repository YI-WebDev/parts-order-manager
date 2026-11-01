import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { capture, fixture, subject } from './app';
import { evidencePath } from './evidence';

test('search runs during composition after the same wait, only the latest term is sent, and ending the composition sends nothing more', async () => {
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    await page.keyboard.press('Control+f');
    // 一覧の status（0件表示）やバックアップ警告と区別するため、パレット（dialog '材料検索'）内にスコープする。
    const palette = page.getByRole('dialog', { name: '材料検索' });
    await expect(palette.getByRole('status')).toContainText('検索できる材料がありません');
    // 検索の要求は本体へ渡さずに空の結果を返し、送られた回数（全体・検索語ごと）を記録する。
    await application.intercept('materials:search', { replace: { status: 'ok', data: { rows: [], categories: [], total: 0 } }, record: ['test:ime:sent', 'test:ime:{query}'] });
    const counts = async () => ({ total: await application.count('test:ime:sent'), pending: await application.count('test:ime:pending'), reading: await application.count('test:ime:に'), latest: await application.count('test:ime:日本') });
    await page.clock.install(); await page.clock.pauseAt(new Date());
    const field = palette.getByLabel('キーワード', { exact: true });
    await field.fill('pending'); await expect(palette.getByRole('status')).toHaveText('検索しています…');
    await page.clock.runFor(50);
    // 変換中の入力も、確定していない入力と同じく 180ms 待ってから検索する（待つ間に次の入力があれば、前の検索語は送らない）。
    await field.dispatchEvent('compositionstart');
    await field.fill('に'); await expect(palette.getByRole('status')).toHaveText('検索しています…');
    await page.clock.runFor(50);
    await field.fill('日本');
    await page.clock.runFor(179); await page.evaluate(() => window.appApi.getInfo());
    expect(await counts()).toEqual({ total: 0, pending: 0, reading: 0, latest: 0 });
    await page.clock.runFor(2); await page.evaluate(() => window.appApi.getInfo());
    await expect.poll(counts).toEqual({ total: 1, pending: 0, reading: 0, latest: 1 });
    const during = await counts();
    await writeFile(evidencePath('ime-during.json'), JSON.stringify(during));
    await expect(palette.getByRole('status')).toContainText('該当する材料はありません');
    await capture(page, 'ime-searched-while-composing');
    // 確定しても文字が変わらなければ、検索し直さない。
    await field.dispatchEvent('compositionend', { data: '日本' });
    await page.clock.runFor(1000); await page.evaluate(() => window.appApi.getInfo());
    expect(await counts()).toEqual({ total: 1, pending: 0, reading: 0, latest: 1 });
    await expect(field).toHaveValue('日本');
    await expect(palette.getByRole('status')).toContainText('該当する材料はありません');
    // 確定した文字が検索語と違えば（入力イベントなしに欄の文字が変わった場合）、確定した文字で検索し直す。
    await field.dispatchEvent('compositionstart');
    await field.evaluate(element => { (element as HTMLInputElement).value = '日本語'; });
    await field.dispatchEvent('compositionend', { data: '日本語' });
    await page.clock.runFor(181); await page.evaluate(() => window.appApi.getInfo());
    await expect.poll(() => application.count('test:ime:日本語')).toBe(1);
    await expect(field).toHaveValue('日本語');
    await page.clock.resume(); await capture(page, 'ime-latest-completed');
    await writeFile(evidencePath('ime-result.json'), JSON.stringify({ ...subject(), node: process.version, timing: { beforeCompositionMs: 50, betweenReadingAndTermMs: 50, beforeDebounceMs: 179, afterDebounceMs: 2, afterEndMs: 1000, afterChangedEndMs: 181 }, during, after: { ...await counts(), changedOnEnd: await application.count('test:ime:日本語') }, control: 'Actual renderer and appApi adapter, intercepted search channel (e2e record counters), virtual renderer clock and synthetic composition events; not OS IME operation' }, null, 2));
  } finally { await application.close(); await f.cleanup(); }
});
