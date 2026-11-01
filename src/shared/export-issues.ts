import type { InvoiceDraft } from './document-api';
import type { ExportIssueField } from './export-api';
import { validDateText } from './date-text';
import { BOTH_MARK, LINE_ROWS, entered, lineMark } from './invoice-sheet';

// 出力前の確認（出力を止める理由）の規則。画面（InvoicePanel・SheetPreview）はこの1か所を使う。
// 本体（src-tauri/core/src/exports/mod.rs の blocking_issues）が同じ規則・同じ文言で、Excel出力・印刷・一覧の件数を判定する。
// 止める理由は 記号未確定・状態と記号の不一致・47行の超過・納期の形式・帳票形式の5種類。チェックの未選択は止めない。

export type ExportIssueKind = 'markUnresolved' | 'markMismatch' | 'overflow' | 'dueDate' | 'template';
export interface DraftIssue { readonly field: ExportIssueField; readonly kind: ExportIssueKind }
type IssueDraft = Pick<InvoiceDraft, 'header' | 'lines' | 'templateVersion'>;

const MARK_FIELD = /^lines\.(\d+)\.mark$/u;
/** `lines.<番号>.mark` の明細の位置（0始まり）。ほかの欄は null。 */
export function markIndex(field: ExportIssueField): number | null {
  const match = MARK_FIELD.exec(field);
  return match ? Number(match[1]) : null;
}

/**
 * 下書きから、出力を止める理由を求める（並びは 記号 → 47行超過 → 納期 → 帳票形式。画面の一覧の並び）。
 * 納期は本体と同じく前後の空白を除いた値で判定する。記号は「共に納品」で記号未確定のとき markUnresolved、そのほかの不一致は markMismatch。
 */
export function exportIssues(draft: IssueDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  draft.lines.forEach((line, index) => {
    if (lineMark(line) === null) issues.push({ field: `lines.${index}.mark`, kind: line.deliveryState === 'both' ? 'markUnresolved' : 'markMismatch' });
  });
  if (draft.lines.length > LINE_ROWS) issues.push({ field: 'lines', kind: 'overflow' });
  const dueDate = entered(draft.header.E4);
  if (dueDate !== '' && !validDateText(dueDate)) issues.push({ field: 'E4', kind: 'dueDate' });
  if (draft.templateVersion !== 'excel-v1') issues.push({ field: 'templateVersion', kind: 'template' });
  return issues;
}

/** 文言の表（本体の blocking_issues と同じ）。明細の記号は「明細N「品名」…」の形。 */
export function issueMessage(issue: DraftIssue, draft: Pick<InvoiceDraft, 'lines'>): string {
  const index = markIndex(issue.field);
  const name = index === null ? '' : (draft.lines[index]?.name.replace(/\s+/gu, ' ').trim() || '（品名なし）');
  switch (issue.kind) {
    case 'markUnresolved': return `明細${(index ?? 0) + 1}「${name}」のチェック記号が未確定（材料・伝票とも。「${BOTH_MARK}」を選び直してください）`;
    case 'markMismatch': return `明細${(index ?? 0) + 1}「${name}」のチェック状態と記号が一致していません`;
    case 'overflow': return `明細が${LINE_ROWS}行を${draft.lines.length - LINE_ROWS}行超えています（出力方法は未確定）`;
    case 'dueDate': return '納期の形式（実在する日付を YYYY-MM-DD または YYYY/M/D）';
    case 'template': return 'この帳票形式のExcel出力には対応していません';
  }
}
