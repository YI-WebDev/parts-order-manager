import { describe, expect, it } from 'vitest';
import type { InvoiceDraft, InvoiceLine } from '../../src/shared/document-api';
import { exportIssues, issueMessage, markIndex } from '../../src/shared/export-issues';
import { CHECK_STATES, LINE_ROWS, lineMark } from '../../src/shared/invoice-sheet';

// 出力前の確認（TD-03）。本体（Rust: exports::blocking_issues）と同じ規則・同じ文言。状態と止める理由の表:
// | 状態・記号                                   | 規則の版        | 理由           |
// | 未選択・3択の組合せ（状態と記号がそろう）      | provisional-v1  | なし           |
// | 共に納品で記号が未確定・共に納品で記号が違う   | provisional-v1  | markUnresolved |
// | ほかの状態で記号が違う                        | provisional-v1  | markMismatch   |
// | 状態と記号がそろっていても規則の版が違う       | それ以外        | 状態により上の2つ |
const line = (patch: Partial<InvoiceLine> = {}): InvoiceLine => ({ id: 'a', materialId: null, sourceItemId: null, name: '架空材料', model: '', manufacturer: '', quantity: '', remarks: '', deliveryState: 'unknown', markOutput: 'unresolved', observedMark: null, ruleVersion: 'provisional-v1', ...patch });
const draft = (lines: readonly InvoiceLine[] = [line()], header: Partial<InvoiceDraft['header']> = {}, templateVersion = 'excel-v1'): InvoiceDraft => ({ title: '', header: { C2: '', A4: '', B4: '', C4: '', E4: '', ...header }, templateVersion, lines });
const DELIVERY = ['unknown', 'material_only', 'slip_only', 'both'] as const;
const OUTPUT = ['unresolved', 'blank', 'filled_circle', 'open_circle', 'both_mark'] as const;

describe('exportIssues', () => {
  it('derives the mark issue from the single check-state table for every state and mark', () => {
    for (const deliveryState of DELIVERY) for (const markOutput of OUTPUT) for (const ruleVersion of ['provisional-v1', 'v0']) {
      const target = draft([line({ deliveryState, markOutput, ruleVersion })]);
      const valid = ruleVersion === 'provisional-v1' && CHECK_STATES.some(entry => entry.deliveryState === deliveryState && entry.markOutput === markOutput);
      const expected = valid ? [] : [{ field: 'lines.0.mark', kind: deliveryState === 'both' ? 'markUnresolved' : 'markMismatch' }];
      expect(exportIssues(target), `${deliveryState}/${markOutput}/${ruleVersion}`).toEqual(expected);
      expect(lineMark(target.lines[0] as InvoiceLine) === null).toBe(!valid);
    }
  });

  it('does not stop on an unselected check and counts each broken line separately', () => {
    expect(exportIssues(draft([line(), line({ deliveryState: 'both' }), line({ deliveryState: 'slip_only', markOutput: 'both_mark' })]))).toEqual([
      { field: 'lines.1.mark', kind: 'markUnresolved' }, { field: 'lines.2.mark', kind: 'markMismatch' },
    ]);
  });

  it('judges the due date after trimming JavaScript whitespace', () => {
    for (const [E4, blocked] of [['', false], ['　', false], ['　 2026/10/31 ﻿', false], ['2026-02-30', true], ['　2026-02-30 ', true], ['​2026-10-31', true], ['翌週', true]] as const) {
      expect(exportIssues(draft([line()], { E4 })), JSON.stringify(E4)).toEqual(blocked ? [{ field: 'E4', kind: 'dueDate' }] : []);
    }
  });

  it('stops only above the sheet line limit and on an unknown template, in the list order mark, overflow, date, template', () => {
    expect(exportIssues(draft(Array.from({ length: LINE_ROWS }, () => line())))).toEqual([]);
    const lines = Array.from({ length: LINE_ROWS + 1 }, (_, index) => line(index === 0 ? { deliveryState: 'both' } : {}));
    expect(exportIssues(draft(lines, { E4: 'x' }, 'excel-v0')).map(issue => issue.field)).toEqual(['lines.0.mark', 'lines', 'E4', 'templateVersion']);
  });
});

describe('issueMessage', () => {
  it('uses one wording per kind (the same text as the main process)', () => {
    const lines = Array.from({ length: LINE_ROWS + 2 }, (_, index) => line(index === 0 ? { deliveryState: 'both', name: ' 品　\n名 ' } : index === 1 ? { deliveryState: 'material_only', markOutput: 'open_circle', name: '' } : {}));
    const target = draft(lines, { E4: 'x' }, 'excel-v0');
    expect(exportIssues(target).map(issue => issueMessage(issue, target))).toEqual([
      '明細1「品 名」のチェック記号が未確定（材料・伝票とも。「⦿」を選び直してください）',
      '明細2「（品名なし）」のチェック状態と記号が一致していません',
      '明細が47行を2行超えています（出力方法は未確定）',
      '納期の形式（実在する日付を YYYY-MM-DD または YYYY/M/D）',
      'この帳票形式のExcel出力には対応していません',
    ]);
  });

  it('reads the line position only from a mark field', () => {
    expect([markIndex('lines.12.mark'), markIndex('lines'), markIndex('E4'), markIndex('templateVersion')]).toEqual([12, null, null, null]);
  });
});
