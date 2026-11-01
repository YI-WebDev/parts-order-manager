import type { CellFormat } from '../shared/cell-format';
import type { InvoiceDraft } from '../shared/document-api';
import type { HeaderKey, LineField } from '../shared/invoice-sheet';

// セルの書式の「元に戻す」「やり直し」。書式の変更1回（ボタン1回・ショートカット1回）を1段として、変更前と変更後の書式を持つ。
// 履歴は編集セッションの間だけ持つ（請求書を開き直すと消える。Excelでブックを閉じたときと同じ）。

/** 書式を付けるセル。明細は並べ替え・削除しても同じ明細を指すよう ID で持つ。 */
export type FormatTarget = { readonly kind: 'header'; readonly key: HeaderKey } | { readonly kind: 'line'; readonly id: string; readonly field: LineField };
/** セルと、そのセルに付ける書式（undefined は帳票の既定の書式）。 */
export interface FormatChange { readonly target: FormatTarget; readonly format: CellFormat | undefined }
/** 履歴の1段。at は変更（やり直しの段は取り消し）をした順番で、文字の入力との前後を比べるのに使う。 */
export interface FormatStep { readonly before: readonly FormatChange[]; readonly after: readonly FormatChange[]; readonly at: number }
export interface FormatHistory { readonly undo: readonly FormatStep[]; readonly redo: readonly FormatStep[] }
export const EMPTY_HISTORY: FormatHistory = { undo: [], redo: [] };
/** 元に戻せる回数（Excelの既定と同じ100回）。 */
export const HISTORY_LIMIT = 100;

const FORMAT_KEYS = ['horizontal', 'vertical', 'bold', 'italic', 'underline', 'size', 'color', 'fill'] as const;
const sameFormat = (a: CellFormat | undefined, b: CellFormat | undefined): boolean => FORMAT_KEYS.every(key => a?.[key] === b?.[key]);
const exists = (draft: InvoiceDraft, target: FormatTarget): boolean => target.kind === 'header' || draft.lines.some(line => line.id === target.id);

/** 下書きでのセルの書式。 */
export function formatAt(draft: InvoiceDraft, target: FormatTarget): CellFormat | undefined {
  return target.kind === 'header' ? draft.formats?.[target.key] : draft.lines.find(line => line.id === target.id)?.formats?.[target.field];
}

/** 書式の一覧（formats）を差し替える。空になったら formats ごと外す（保存内容を書式のない帳票と同じ形に保つ）。 */
function withFormats<T extends object>(item: T, formats: Readonly<Record<string, CellFormat | undefined>>): T {
  const kept = Object.fromEntries(Object.entries(formats).filter(([, format]) => format !== undefined));
  const next: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  if (Object.keys(kept).length) next['formats'] = kept; else delete next['formats'];
  return next as T;
}

/** 書式を下書きへ反映する（削除した明細のセルは飛ばす）。 */
export function applyFormats(draft: InvoiceDraft, changes: readonly FormatChange[]): InvoiceDraft {
  const header: Record<string, CellFormat | undefined> = { ...draft.formats }, lines = new Map<string, Record<string, CellFormat | undefined>>();
  for (const { target, format } of changes) {
    if (target.kind === 'header') header[target.key] = format;
    else lines.set(target.id, { ...lines.get(target.id), [target.field]: format });
  }
  const next = draft.lines.map(line => { const changed = lines.get(line.id); return changed ? withFormats(line, { ...line.formats, ...changed }) : line; });
  return withFormats({ ...draft, lines: next }, header);
}

/** 書式を変えて履歴に1段積む（やり直しの履歴は消える）。何も変わらなければ null。 */
export function recordFormats(history: FormatHistory, draft: InvoiceDraft, changes: readonly FormatChange[], at: number): { readonly history: FormatHistory; readonly draft: InvoiceDraft } | null {
  const after = changes.filter(change => exists(draft, change.target) && !sameFormat(formatAt(draft, change.target), change.format));
  if (after.length === 0) return null;
  const before = after.map(change => ({ target: change.target, format: formatAt(draft, change.target) }));
  return { history: { undo: [...history.undo, { before, after, at }].slice(-HISTORY_LIMIT), redo: [] }, draft: applyFormats(draft, after) };
}

/** 次に元に戻す（やり直す）段。明細を削除して何も変えられなくなった段は飛ばす。 */
function next(stack: readonly FormatStep[], draft: InvoiceDraft, side: 'before' | 'after'): number {
  for (let index = stack.length - 1; index >= 0; index--) {
    const step = stack[index];
    if (step?.[side].some(change => exists(draft, change.target) && !sameFormat(formatAt(draft, change.target), change.format))) return index;
  }
  return -1;
}
export const nextUndo = (history: FormatHistory, draft: InvoiceDraft): FormatStep | undefined => history.undo[next(history.undo, draft, 'before')];
export const nextRedo = (history: FormatHistory, draft: InvoiceDraft): FormatStep | undefined => history.redo[next(history.redo, draft, 'after')];

/** 書式の変更を1段元に戻す。戻せる段がなければ null。 */
export function undoFormats(history: FormatHistory, draft: InvoiceDraft, at: number): { readonly history: FormatHistory; readonly draft: InvoiceDraft } | null {
  const index = next(history.undo, draft, 'before'), step = history.undo[index];
  if (!step) return null;
  return { history: { undo: history.undo.slice(0, index), redo: [...history.redo, { ...step, at }] }, draft: applyFormats(draft, step.before) };
}

/** 元に戻した書式の変更を1段やり直す。やり直せる段がなければ null。 */
export function redoFormats(history: FormatHistory, draft: InvoiceDraft, at: number): { readonly history: FormatHistory; readonly draft: InvoiceDraft } | null {
  const index = next(history.redo, draft, 'after'), step = history.redo[index];
  if (!step) return null;
  return { history: { undo: [...history.undo, { ...step, at }], redo: history.redo.slice(0, index) }, draft: applyFormats(draft, step.after) };
}
