import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { FONT_SIZES, PALETTE, normalizeFormat, resolveStyle } from '../../src/shared/cell-format';
import { STYLE_NAMES, cellStyle, displayText, sheetCells } from '../../src/shared/invoice-sheet';

// セルの書式は画面（プレビュー）と本体（Rust: pom-core の format.rs・sheet.rs の resolve）で同じ定義・規則。
const rust = readFileSync(new URL('../../src-tauri/core/src/format.rs', import.meta.url), 'utf8');

it('uses the same colors and font sizes as the app core', () => {
  const colors = [...rust.matchAll(/Color \{ code: "([0-9A-F]{6})", name: "([^"]+)" \}/gu)].map(([, code, name]) => ({ code, name }));
  expect(colors).toEqual(PALETTE);
  expect(/FONT_SIZES: \[u32; \d+\] = \[([^\]]+)\]/u.exec(rust)?.[1]?.split(',').map(Number)).toEqual([...FONT_SIZES]);
});

// 帳票の既定（利用者の指示、2026年10月15日）: 文字のあるセルはすべて中央揃えで、字下げはない。標準スタイル（空欄の既定）だけが general。
it('centres every form style that holds text, without indent', () => {
  for (const name of STYLE_NAMES) {
    expect(cellStyle(name).align, name).toBe(name === 'normal' ? 'general' : 'center');
    expect(cellStyle(name).indent, name).toBeUndefined();
  }
  // 本体（Rust: sheet.rs の cell_style）も同じ既定。
  const sheet = readFileSync(new URL('../../src-tauri/core/src/sheet.rs', import.meta.url), 'utf8');
  const aligns = [...sheet.matchAll(/StyleName::(\w+) => style\([^)]*?, (General|Left|Center|Right), (None|Some\(\d+\))\)/gu)].map(([, name, align, indent]) => [name, align, indent]);
  expect(aligns.length).toBe(STYLE_NAMES.length);
  for (const [name, align, indent] of aligns) { expect(align, name).toBe(name === 'Normal' ? 'General' : 'Center'); expect(indent, name).toBe('None'); }
});

it('overlays a cell format on the centred form style', () => {
  expect(resolveStyle('lineText', undefined)).toMatchObject({ align: 'center', indent: undefined, size: 11, bold: false });
  expect(resolveStyle('lineText', { horizontal: 'left', bold: true })).toMatchObject({ align: 'left', indent: undefined, bold: true });
  expect(resolveStyle('lineText', { horizontal: 'right' })).toMatchObject({ align: 'right', indent: undefined });
  expect(resolveStyle('mark', { size: 12, color: 'FF0000' })).toMatchObject({ align: 'center', size: 12, color: 'FF0000' });
  expect(resolveStyle('mark', undefined).size).toBe(9);
});

it('stores only what differs from the form style', () => {
  expect(normalizeFormat('lineCenter', { horizontal: 'center', size: 11 })).toBeUndefined();
  expect(normalizeFormat('text', { horizontal: 'center' })).toBeUndefined();
  expect(normalizeFormat('lineText', { horizontal: 'left' })).toEqual({ horizontal: 'left' });
  expect(normalizeFormat('lineCenter', { horizontal: 'left', bold: true })).toEqual({ horizontal: 'left', bold: true });
  expect(normalizeFormat('mark', { size: 11, fill: 'FFF2CC' })).toEqual({ size: 11, fill: 'FFF2CC' });
  expect(normalizeFormat('mark', {})).toBeUndefined();
});

// 帳票に置く値は前後の空白（全角・半角）を除く（本体が保存のときに除くのと同じ規則。入力欄に空白が残っていてもプレビューは登録される形で描く）。
it('places header and line values without leading or trailing spaces', () => {
  const line = { mark: '●', name: '　リレー　', model: ' 001-A\t', manufacturer: ' 架空社　', quantity: ' 2 ', remarks: '備考 中 ', formats: undefined };
  const cells = sheetCells({ C2: '　架空宛先 ', A4: ' A', B4: 'B ', C4: '　', E4: ' 2026-01-02 ' }, [line]);
  const shown = (ref: string): string => displayText(cells.find(cell => cell.ref === ref)?.value ?? null);
  expect(['C2', 'A4', 'B4', 'C4', 'E4'].map(shown)).toEqual(['架空宛先', 'A', 'B', '', '1月2日']);
  expect(['A6', 'B6', 'C6', 'D6', 'E6', 'F6'].map(shown)).toEqual(['●', 'リレー', '001-A', '架空社', '2', '備考 中']);
  // 空白だけの欄は空欄になる（セルの値を持たない）。
  expect(cells.find(cell => cell.ref === 'C4')?.value).toBeNull();
});

it('attaches formats only to input cells', () => {
  const line = { mark: '●', name: '架空', model: '', manufacturer: '', quantity: '1', remarks: '', formats: { name: { bold: true as const }, quantity: {} } };
  const cells = sheetCells({ C2: '', A4: '', B4: '', C4: '', E4: '' }, [line], { C2: { italic: true } });
  const format = (ref: string) => cells.find(cell => cell.ref === ref)?.format;
  expect([format('C2'), format('B6'), format('E6'), format('B7'), format('B5')]).toEqual([{ italic: true }, { bold: true }, null, null, null]);
});
