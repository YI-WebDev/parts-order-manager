import { expect, test } from '@playwright/test';
import { fixture } from './app';

test('renderer crash closes the app instead of leaving an unclosable window', async () => {
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    const closed = application.waitForExit();
    await application.crashRenderer();
    await closed;
  } finally { await application.close(); await f.cleanup(); }
});

test('unresponsive renderer offers a forced close and waiting keeps the window', async () => {
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    // 「待つ」を選ぶとウィンドウは残る。
    await application.dialog('message', 0);
    await application.setUnresponsive(true);
    await application.requestClose();
    await expect.poll(async () => (await application.events()).filter(event => event.type === 'dialog' && event['kind'] === 'message').length).toBe(1);
    const asked = (await application.events()).find(event => event.type === 'dialog' && event['kind'] === 'message');
    expect(asked?.['detail']).toMatchObject({ message: '画面が応答していません。', buttons: ['待つ', '強制終了'] });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(application.running).toBe(true);
    // 「強制終了」を選ぶとアプリが終了する。
    const closed = application.waitForExit();
    await application.dialog('message', 1);
    await application.setUnresponsive(true);
    await application.requestClose();
    await closed;
  } finally { await application.close(); await f.cleanup(); }
});

test('responsive renderer still goes through the normal close confirmation', async () => {
  const f = await fixture(Buffer.alloc(0)), application = await f.launch();
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    // 画面は終了確認（documents:close）を要求する。その要求を処理の前で止め、強制終了の確認が出ていないことを確かめてから通す。
    await application.intercept('documents:close', { hold: 'test:close:confirm', holdBefore: true });
    const closed = application.waitForExit();
    await application.setUnresponsive(true); await application.setUnresponsive(false); await application.requestClose();
    await expect.poll(() => application.count('test:close:confirm')).toBe(1);
    const events = await application.events();
    expect(events.filter(event => event.type === 'call' && event['channel'] === 'documents:close')).toHaveLength(1);
    expect(events.filter(event => event.type === 'dialog' && event['kind'] === 'message')).toEqual([]);
    expect(application.running).toBe(true);
    await application.release('test:close:confirm');
    await closed;
  } finally { await application.close(); await f.cleanup(); }
});
