import { expect, it } from 'vitest';
import { BOTH_MARK, lineMark, sheetCells } from '../../src/shared/invoice-sheet';
import type { SheetLine } from '../../src/shared/invoice-sheet';

// 明細のチェック（任意の項目。利用者の指示、2026年10月16日）。状態と記号の組合せごとの扱い:
// | 状態・記号                           | 帳票のチェック欄 | 出力前の確認・出力       |
// | 未選択（unknown・unresolved）         | 空欄             | 確認事項にせず出力する   |
// | 3択のどれか（状態と記号がそろう）     | ● ○ ⦿            | 確認事項にせず出力する   |
// | 記号未確定（both・unresolved）        | 空欄（描かない） | 確認事項にして出力を止める |
// | そのほかの不一致・規則の版が違う       | 空欄（描かない） | 確認事項にして出力を止める |
// 本体（Rust: pom-core の sheet::line_mark）も同じ規則で、excel_workbook.rs で同じ組合せを確かめている。
const STATES = ['unknown', 'material_only', 'slip_only', 'both'] as const;
const MARKS = ['unresolved', 'blank', 'filled_circle', 'open_circle', 'both_mark'] as const;
const EXPECTED: Readonly<Record<string, string>> = { 'unknown/unresolved': '', 'material_only/filled_circle': '●', 'slip_only/open_circle': '○', 'both/both_mark': BOTH_MARK };

it('treats an unselected check as a blank mark and stops only unresolved or mismatched marks', () => {
  for (const deliveryState of STATES) for (const markOutput of MARKS) {
    const key = `${deliveryState}/${markOutput}`;
    expect(lineMark({ deliveryState, markOutput, ruleVersion: 'provisional-v1' }), key).toBe(EXPECTED[key] ?? null);
    expect(lineMark({ deliveryState, markOutput, ruleVersion: 'other' }), key).toBeNull();
  }
});

it('leaves the check cell of an unselected line empty while keeping the other values', () => {
  const header = { C2: '', A4: '', B4: '', C4: '', E4: '' };
  const line: SheetLine = { mark: lineMark({ deliveryState: 'unknown', markOutput: 'unresolved', ruleVersion: 'provisional-v1' }) ?? 'stopped', name: '架空材料', model: '', manufacturer: '', quantity: '', remarks: '' };
  const cells = sheetCells(header, [line]);
  expect(cells.find(cell => cell.ref === 'A6')).toMatchObject({ value: null, source: { kind: 'line', index: 0, field: 'mark' } });
  expect(cells.find(cell => cell.ref === 'B6')?.value).toEqual({ kind: 'text', text: '架空材料' });
});
