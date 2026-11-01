import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveStyle } from '../../src/shared/cell-format';
import type { CellFormat } from '../../src/shared/cell-format';
import { validDateText } from '../../src/shared/date-text';
import * as sheet from '../../src/shared/invoice-sheet';
import * as geometry from '../../src/shared/sheet-geometry';

// 帳票の定義と判定は TS（src/shared）と Rust（pom-core の sheet.rs・format.rs）に二重にある（TD-01）。
// Rust のハーネス（examples/harness の sheetDefinitions）が出す値を、今の src/shared の値・関数と1項目ずつ突き合わせる。
// ハーネスを作れない・動かせない場合は、飛ばさず失敗させる。作り済みのハーネスを使うときは POM_HARNESS にパスを渡す。
const ROOT = path.resolve(__dirname, '../..');
const binary = process.env['POM_HARNESS'] ?? path.join(ROOT, 'src-tauri', 'target', 'debug', 'examples', process.platform === 'win32' ? 'harness.exe' : 'harness');

type Json = Record<string, unknown>;
let rust: Json = {};
// JSON を通して undefined を落とし、Rust 側の出力と同じ型にそろえる。
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value === undefined ? null : value));
const nul = <T>(value: T | undefined): T | null => value ?? null;

beforeAll(() => {
  if (!process.env['POM_HARNESS']) {
    const build = spawnSync('cargo', ['build', '--manifest-path', path.join(ROOT, 'src-tauri', 'Cargo.toml'), '-p', 'pom-core', '--example', 'harness', '--features', 'sequential-ids'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (build.status !== 0) throw new Error(`Rust のハーネスを作れませんでした（cargo が必要です）: ${build.error?.message ?? ''}\n${build.stderr}`);
  }
  const run = spawnSync(binary, [], { input: `${JSON.stringify({ op: 'pure', fn: 'sheetDefinitions', input: {} })}\n`, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`Rust のハーネスを動かせませんでした: ${run.error?.message ?? ''}\n${run.stderr}`);
  const response = JSON.parse(run.stdout.split('\n')[0] ?? '') as { value: Json };
  if ('error' in response.value) throw new Error(`ハーネスの応答が不正です: ${JSON.stringify(response.value)}`);
  rust = response.value;
}, 600_000);

describe('sheet definitions: src/shared matches the app core (Rust)', () => {
  it('has the same constants, fonts and number formats', () => {
    expect(rust['sheetName']).toBe(sheet.SHEET_NAME);
    expect(rust['columnWidths']).toEqual([...sheet.COLUMN_WIDTHS]);
    expect(rust['printColumns']).toBe(sheet.PRINT_COLUMNS);
    expect(rust['sheetRows']).toBe(sheet.SHEET_ROWS);
    expect(rust['lineFirstRow']).toBe(sheet.LINE_FIRST_ROW);
    expect(rust['lineRows']).toBe(sheet.LINE_ROWS);
    expect(rust['defaultRowHeight']).toBe(sheet.DEFAULT_ROW_HEIGHT);
    expect(rust['bothMark']).toBe(sheet.BOTH_MARK);
    expect(rust['fonts']).toEqual(plain(sheet.FONTS));
    expect(rust['numberFormats']).toEqual(plain(sheet.NUMBER_FORMATS));
    expect(rust['cssFonts']).toEqual(plain(geometry.FONTS));
    expect([rust['pad'], rust['indent'], rust['columns']]).toEqual([geometry.PAD, geometry.INDENT, geometry.COLUMNS]);
  });

  it('has the same row heights, pixel positions and border paths', () => {
    expect(rust['rowHeights']).toEqual(Array.from({ length: sheet.SHEET_ROWS }, (_, i) => sheet.rowHeight(i + 1)));
    expect(rust['px']).toEqual({
      w: Array.from({ length: geometry.COLUMNS }, (_, c) => geometry.w(c)), x: Array.from({ length: geometry.COLUMNS + 1 }, (_, c) => geometry.x(c)),
      h: Array.from({ length: sheet.SHEET_ROWS }, (_, r) => geometry.h(r + 1)), y: Array.from({ length: sheet.SHEET_ROWS + 1 }, (_, r) => geometry.y(r + 1)),
      width: geometry.WIDTH, height: geometry.HEIGHT, printWidth: geometry.PRINT_WIDTH,
    });
    expect(rust['borderPaths']).toEqual(geometry.borderPaths);
  });

  it('has the same default style (borders, alignment, number format) for every style name', () => {
    expect(rust['styles']).toEqual(sheet.STYLE_NAMES.map(name => {
      const s = sheet.cellStyle(name);
      return { name, font: s.font, numFmt: s.numFmt, align: s.align, indent: nul(s.indent), border: { left: nul(s.border.left), right: nul(s.border.right), top: nul(s.border.top), bottom: nul(s.border.bottom) } };
    }));
  });

  it('decides the check mark the same way for every state', () => {
    const marks = rust['marks'] as { state: string; output: string; rule: string; mark: string | null }[];
    expect(marks.length).toBeGreaterThan(40);
    expect(marks.some(m => m.mark === '●') && marks.some(m => m.mark === '') && marks.some(m => m.mark === null)).toBe(true);
    for (const { state, output, rule, mark } of marks) expect(sheet.lineMark({ deliveryState: state, markOutput: output, ruleVersion: rule }), `${state}/${output}/${rule}`).toBe(mark);
  });

  it('judges delivery date text and its cell value the same way', () => {
    const dates = rust['dates'] as { input: string; valid: boolean; value: unknown }[];
    expect(dates.some(d => d.valid) && dates.some(d => !d.valid)).toBe(true);
    for (const { input, valid, value } of dates) {
      expect(validDateText(input), input).toBe(valid);
      expect(plain(sheet.dateValue(input)), input).toEqual(value);
    }
  });

  it('decides overflow columns and room the same way', () => {
    const cases = rust['overflow'] as { filled: number[]; column: number; columns: number; right: number; left: number; sides: [number, number]; room: number }[];
    expect(cases.length).toBeGreaterThan(50);
    for (const c of cases) {
      const empty = (_row: number, column: number): boolean => !c.filled.includes(column);
      const sides = geometry.overflowSides(6, c.column, empty, c.columns);
      const label = JSON.stringify([c.filled, c.column, c.columns]);
      expect([geometry.overflowColumns(6, c.column, empty, c.columns), geometry.overflowColumnsLeft(6, c.column, empty), [sides.left, sides.right], geometry.sideRoom(c.column, sides)], label).toEqual([c.right, c.left, c.sides, c.room]);
    }
  });

  it('lays out the same cells and display text', () => {
    const header = { C2: '宛先', A4: 'オーダー', B4: '案件', C4: '備考', E4: '2026-09-13' };
    const lines = [
      { name: '品A', model: 'M-1', manufacturer: '社A', quantity: '12', remarks: '前\r\n後', mark: '●' },
      { name: '品B', model: '', manufacturer: '', quantity: '', remarks: '', mark: '⦿' },
    ];
    expect(rust['cells']).toEqual(sheet.sheetCells(header, lines).map(cell => ({
      ref: cell.ref, row: cell.row, column: cell.column, style: cell.style, display: sheet.displayText(cell.value), dateValue: cell.value?.kind === 'date' ? cell.value.serial : null,
    })));
  });

  it('resolves cell formats over the form style the same way', () => {
    const resolved = rust['resolved'] as { style: sheet.StyleName; format: CellFormat; [key: string]: unknown }[];
    expect(resolved.length).toBeGreaterThan(5);
    for (const { style, format, ...expected } of resolved) {
      const r = resolveStyle(style, format);
      expect({ ...expected }, `${style} ${JSON.stringify(format)}`).toEqual({
        size: r.size, bold: r.bold, italic: r.italic, underline: r.underline, color: nul(r.color), fill: nul(r.fill), align: r.align, vertical: nul(r.vertical), indent: nul(r.indent),
        fontChanged: r.size !== sheet.FONTS[r.base.font]?.size || r.bold || r.italic || r.underline || r.color !== undefined,
      });
    }
  });
});
