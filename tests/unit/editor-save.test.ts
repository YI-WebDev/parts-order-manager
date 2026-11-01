import { afterEach, expect, test, vi } from 'vitest';
import { EditorStore } from '../../src/renderer/editor-store';
import type { EditorSession, SaveDocument, SaveReceipt, DocumentResult } from '../../src/shared/document-api';
const session: EditorSession = { sessionId: 'session', documentId: null, revision: 0, draft: { title: '', header: { C2: '', A4: '', B4: '', C4: '', E4: '' }, templateVersion: 'excel-v1', lines: [] } };
const ok = (r: SaveDocument): DocumentResult<SaveReceipt> => ({ status: 'ok', data: { sessionId: r.sessionId, documentId: 'document', requestNumber: r.requestNumber, generation: r.generation, revision: r.expectedRevision + 1 } });
afterEach(() => vi.useRealTimers());
test('serializes autosave and Ctrl S while retaining newer edits', async () => {
  vi.useFakeTimers(); let resolve: ((r: DocumentResult<SaveReceipt>) => void) | undefined;
  const calls: SaveDocument[] = [];
  const store = new EditorStore(r => { calls.push(r); return calls.length === 1 ? new Promise(done => { resolve = done; }) : Promise.resolve(ok(r)); });
  store.load(session); store.edit({ ...session.draft, title: 'first' });
  await vi.advanceTimersByTimeAsync(600); expect(calls).toHaveLength(1);
  store.edit({ ...session.draft, title: 'latest' }); const flushed = store.flush();
  expect(store.getSnapshot().status).toBe('saving'); expect(calls).toHaveLength(1);
  const first = calls[0]; if (!first || !resolve) throw Error('Missing request'); resolve(ok(first));
  expect(await flushed).toBe(true); expect(calls).toHaveLength(2);
  expect(calls[1]?.expectedRevision).toBe(1); expect(calls[1]?.draft.title).toBe('latest');
  expect(store.getSnapshot().session?.draft.title).toBe('latest'); expect(store.getSnapshot().status).toBe('saved'); store.dispose();
});
test('replays identical unknown request before saving later edits', async () => {
  vi.useFakeTimers(); const calls: SaveDocument[] = [];
  const store = new EditorStore(async r => { calls.push(r); if (calls.length === 1) throw Error('Lost response'); return ok(r); });
  store.load(session); store.edit({ ...session.draft, title: 'first' }); expect(await store.flush()).toBe(false);
  store.edit({ ...session.draft, title: 'latest' }); expect(await store.flush()).toBe(true);
  expect(calls[1]).toEqual(calls[0]); expect(calls[2]?.draft.title).toBe('latest'); expect(calls[2]?.expectedRevision).toBe(1); store.dispose();
});
test('composition blocks reserved autosave and manual save until composition ends', async () => {
  vi.useFakeTimers(); const save = vi.fn(async (r: SaveDocument) => ok(r)); const store = new EditorStore(save);
  store.load(session); store.edit({ ...session.draft, title: 'old' }); store.compose(true);
  await vi.advanceTimersByTimeAsync(3000); expect(save).not.toHaveBeenCalled(); expect(await store.flush()).toBe(false);
  store.edit({ ...session.draft, title: '日本' }); store.compose(false); await vi.advanceTimersByTimeAsync(600);
  expect(save).toHaveBeenCalledTimes(1); expect(save.mock.calls[0]?.[0].draft.title).toBe('日本'); store.dispose();
});
test('failure preserves input and mismatched response never marks saved', async () => {
  vi.useFakeTimers(); const store = new EditorStore(async r => ({ status: 'ok', data: { sessionId: 'wrong', documentId: 'd', requestNumber: r.requestNumber, generation: r.generation, revision: 1 } }));
  store.load(session); store.edit({ ...session.draft, title: 'retained' }); expect(await store.flush()).toBe(false);
  expect(store.getSnapshot().status).toBe('error'); expect(store.getSnapshot().session?.draft.title).toBe('retained'); store.dispose();
});
test('known validation failure can retry corrected latest input', async () => {
  vi.useFakeTimers(); let calls = 0;
  const store = new EditorStore(async r => ++calls === 1 ? { status: 'error', code: 'VALIDATION', message: 'Too large', correlationId: 'test' } : r.draft.title === 'corrected' ? ok(r) : { status: 'error', code: 'VALIDATION', message: 'Still invalid', correlationId: 'test' });
  store.load(session); store.edit({ ...session.draft, title: 'invalid' }); expect(await store.flush()).toBe(false);
  store.edit({ ...session.draft, title: 'corrected' }); expect(await store.flush()).toBe(true); expect(store.getSnapshot().status).toBe('saved'); store.dispose();
});
test('save before navigation drains latest edit after paused in flight autosave', async () => {
  vi.useFakeTimers(); let resolve: ((r: DocumentResult<SaveReceipt>) => void) | undefined; const requests: SaveDocument[] = [];
  const store = new EditorStore(r => { requests.push(r); return requests.length === 1 ? new Promise(done => { resolve = done; }) : Promise.resolve(ok(r)); });
  store.load(session); store.edit({ ...session.draft, title: 'old' }); await vi.advanceTimersByTimeAsync(600);
  store.edit({ ...session.draft, title: 'new' }); store.pause(true); const done = store.flush();
  const first = requests[0]; if (!first || !resolve) throw Error('Missing request'); resolve(ok(first));
  expect(await done).toBe(true); expect(requests.at(-1)?.draft.title).toBe('new'); store.dispose();
});
for (const manual of [true, false]) {
  test(`discard cancels active and queued manual drains after ${manual ? 'manual' : 'automatic'} save`, async () => {
    vi.useFakeTimers();
    const requests: SaveDocument[] = [];
    let release: ((value: DocumentResult<SaveReceipt>) => void) | undefined;
    const store = new EditorStore(request => {
      requests.push(request);
      return requests.length === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(ok(request));
    });
    store.load(session); store.edit({ ...session.draft, title: 'A' });
    const active = store.flush(manual);
    store.edit({ ...session.draft, title: 'B' });
    const queued = store.flush();
    store.pause(true); const discarded = store.discard();
    const first = requests[0]; if (!first || !release) throw Error('Missing delayed A'); release(ok(first));
    expect(await discarded).toBe(true); await Promise.all([active, queued]);
    expect(requests.map(r => r.draft.title)).toEqual(['A']);
    expect(store.getSnapshot().session?.draft.title).toBe('A');
    expect(store.getSnapshot().status).toBe('saved');
    store.pause(false); store.edit({ ...session.draft, title: 'C' });
    expect(await store.flush()).toBe(true);
    expect(requests.map(r => r.draft.title)).toEqual(['A', 'C']);
    expect(requests[1]?.expectedRevision).toBe(1); store.dispose();
  });
}
test('discard confirms only the identical unknown request and cancels later input', async () => {
  vi.useFakeTimers(); const requests: SaveDocument[] = [];
  const store = new EditorStore(async request => { requests.push(request); if (requests.length === 1) throw Error('Lost A receipt'); return ok(request); });
  store.load(session); store.edit({ ...session.draft, title: 'A' }); expect(await store.flush()).toBe(false);
  store.edit({ ...session.draft, title: 'B' }); store.pause(true);
  expect(await store.discard()).toBe(true); expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  expect(store.getSnapshot().session?.draft.title).toBe('A');
  store.pause(false); store.edit({ ...session.draft, title: 'C' }); expect(await store.flush()).toBe(true);
  expect(requests[2]?.draft.title).toBe('C'); store.dispose();
});
