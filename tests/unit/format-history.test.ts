import { expect, it } from 'vitest';
import type { InvoiceDraft, InvoiceLine } from '../../src/shared/document-api';
import { EMPTY_HISTORY, HISTORY_LIMIT, nextRedo, nextUndo, recordFormats, redoFormats, undoFormats } from '../../src/renderer/format-history';
import type { FormatHistory } from '../../src/renderer/format-history';

const line = (id: string): InvoiceLine => ({ id, materialId: null, sourceItemId: null, name: id, model: '', manufacturer: '', quantity: '', remarks: '', deliveryState: 'unknown', markOutput: 'unresolved', observedMark: null, ruleVersion: 'provisional-v1' });
const draft: InvoiceDraft = { title: '', header: { C2: '', A4: '', B4: '', C4: '', E4: '' }, templateVersion: 'excel-v1', lines: [line('a'), line('b')] };
const name = (id: string) => ({ kind: 'line', id, field: 'name' }) as const;
type Result = { readonly history: FormatHistory; readonly draft: InvoiceDraft } | null;
const ok = (result: Result): { readonly history: FormatHistory; readonly draft: InvoiceDraft } => { if (!result) throw new Error('expected a change'); return result; };

it('undoes and redoes one toolbar action as one step and drops empty formats', () => {
  const centered = ok(recordFormats(EMPTY_HISTORY, draft, [{ target: name('a'), format: { horizontal: 'center' } }, { target: name('b'), format: { horizontal: 'center' } }], 1));
  const bold = ok(recordFormats(centered.history, centered.draft, [{ target: { kind: 'header', key: 'C2' }, format: { bold: true } }, { target: name('a'), format: { horizontal: 'center', bold: true } }], 2));
  expect(bold.draft.formats).toEqual({ C2: { bold: true } });
  expect(bold.draft.lines.map(l => l.formats)).toEqual([{ name: { horizontal: 'center', bold: true } }, { name: { horizontal: 'center' } }]);
  const once = ok(undoFormats(bold.history, bold.draft, 3));
  expect(once.draft).toEqual(centered.draft);
  const twice = ok(undoFormats(once.history, once.draft, 4));
  expect(twice.draft).toEqual(draft);
  expect('formats' in (twice.draft.lines[0] ?? {})).toBe(false);
  expect(undoFormats(twice.history, twice.draft, 5)).toBeNull();
  const again = ok(redoFormats(ok(redoFormats(twice.history, twice.draft, 6)).history, centered.draft, 7));
  expect(again.draft).toEqual(bold.draft);
  expect(nextRedo(again.history, again.draft)).toBeUndefined();
  // 取り消した順番（at）が新しくなる。
  expect(nextUndo(again.history, again.draft)?.at).toBe(7);
});

it('ignores no-op changes, clears redo on a new change and keeps at most 100 steps', () => {
  expect(recordFormats(EMPTY_HISTORY, draft, [{ target: name('a'), format: undefined }, { target: name('gone'), format: { bold: true } }], 1)).toBeNull();
  const first = ok(recordFormats(EMPTY_HISTORY, draft, [{ target: name('a'), format: { bold: true } }], 1));
  const undone = ok(undoFormats(first.history, first.draft, 2));
  const other = ok(recordFormats(undone.history, undone.draft, [{ target: name('b'), format: { italic: true } }], 3));
  expect(other.history.redo).toEqual([]);
  let state = { history: EMPTY_HISTORY, draft };
  for (let i = 0; i < HISTORY_LIMIT + 5; i++) state = ok(recordFormats(state.history, state.draft, [{ target: name('a'), format: { size: i % 2 ? 12 : 14 } }], i + 1));
  expect(state.history.undo.length).toBe(HISTORY_LIMIT);
});

it('follows lines by id through reordering and skips steps for deleted lines', () => {
  const a = ok(recordFormats(EMPTY_HISTORY, draft, [{ target: name('a'), format: { bold: true } }], 1));
  const b = ok(recordFormats(a.history, a.draft, [{ target: name('b'), format: { italic: true } }], 2));
  // b を削除し、a を並べ替えた（2行目→1行目のまま）。b の段は戻しても何も変わらないので飛ばし、a の段を戻す。
  const edited: InvoiceDraft = { ...b.draft, lines: b.draft.lines.filter(l => l.id === 'a') };
  expect(nextUndo(b.history, edited)?.at).toBe(1);
  const undone = ok(undoFormats(b.history, edited, 3));
  expect(undone.draft.lines.map(l => l.formats)).toEqual([undefined]);
  expect(undone.history.undo).toEqual([]);
  // 並べ替えても同じ明細の書式を戻す。
  const moved: InvoiceDraft = { ...b.draft, lines: [...b.draft.lines].reverse() };
  expect(ok(undoFormats(b.history, moved, 3)).draft.lines.map(l => [l.id, l.formats])).toEqual([['b', undefined], ['a', { name: { bold: true } }]]);
});
