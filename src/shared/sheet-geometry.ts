import { COLUMN_WIDTHS, PRINT_COLUMNS, SHEET_ROWS, cellStyle, rowHeight, sheetCells } from './invoice-sheet';
import type { CellStyle, Edge } from './invoice-sheet';

// 帳票をExcelの標準表示（100%・96dpi）と同じ寸法で描くための位置と罫線。画面のプレビューと印刷・PDFが同じ値を使う。
// 列幅は標準フォント（ＭＳ Ｐゴシック 11pt）の数字幅 8px でExcelと同じ式により換算し、行の高さは pt をピクセルへ丸める。
const DIGIT = 8;
/** セル内の左右の余白と、字下げ 1 段分の幅（px）。 */
export const PAD = 2, INDENT = 10;
export const COLUMNS = COLUMN_WIDTHS.length;
export const FONTS = [
  { fontFamily: '"ＭＳ Ｐゴシック", "MS PGothic", sans-serif', fontSize: '11pt' },
  { fontFamily: '"ＭＳ Ｐ明朝", "MS PMincho", serif', fontSize: '11pt' },
  { fontFamily: '"ＭＳ Ｐ明朝", "MS PMincho", serif', fontSize: '9pt' },
] as const;
export const fontOf = (index: number): (typeof FONTS)[number] => FONTS[index] ?? FONTS[1];
const widths = COLUMN_WIDTHS.map(width => Math.trunc(((256 * width + Math.trunc(128 / DIGIT)) / 256) * DIGIT));
const heights = Array.from({ length: SHEET_ROWS }, (_, index) => Math.round(rowHeight(index + 1) * 4 / 3));
const offsets = (sizes: readonly number[]): number[] => sizes.reduce<number[]>((all, size) => [...all, (all.at(-1) ?? 0) + size], [0]);
const xs = offsets(widths), ys = offsets(heights);
/** 列の左端・行の上端（px）。column は 0 始まり、row は 1 始まり。 */
export const x = (column: number): number => xs[column] ?? 0, y = (row: number): number => ys[row - 1] ?? 0;
export const w = (column: number): number => widths[column] ?? 0, h = (row: number): number => heights[row - 1] ?? 0;
export const WIDTH = x(COLUMNS), HEIGHT = y(SHEET_ROWS + 1);
/** 印刷範囲（A〜G列）の幅。 */
export const PRINT_WIDTH = x(PRINT_COLUMNS);
export const cellKey = (row: number, column: number): number => row * 16 + column;

// 罫線は入力に依存しないため、空の帳票から一度だけ求める。
const styleAt = new Map<number, CellStyle>(sheetCells({ C2: '', A4: '', B4: '', C4: '', E4: '' }, []).map(cell => [cellKey(cell.row, cell.column), cellStyle(cell.style)]));
const stronger = (a: Edge | undefined, b: Edge | undefined): Edge | undefined => a === 'double' || b === 'double' ? 'double' : a ?? b;
/** 行 row の下端の罫線。 */
export const bottomEdge = (row: number, column: number): Edge | undefined => stronger(styleAt.get(cellKey(row, column))?.border.bottom, styleAt.get(cellKey(row + 1, column))?.border.top);
/** 列 column の左端の罫線。 */
export const leftEdge = (row: number, column: number): Edge | undefined => stronger(styleAt.get(cellKey(row, column - 1))?.border.right, styleAt.get(cellKey(row, column))?.border.left);
/** 罫線の SVG パス。細線は 1px、二重線は 1px の隙間を挟んだ 2 本。 */
export const borderPaths = ((): { readonly thin: string; readonly double: string } => {
  let thin = '', double = '';
  for (let row = 0; row <= SHEET_ROWS; row++) {
    for (let column = 0; column < COLUMNS;) {
      const edge = bottomEdge(row, column); let end = column + 1;
      while (end < COLUMNS && bottomEdge(row, end) === edge) end++;
      const top = y(row + 1);
      if (edge === 'thin') thin += `M${x(column) - 1} ${top - 0.5}H${x(end)}`;
      if (edge === 'double') double += `M${x(column) - 1} ${top - 1.5}H${x(end)}M${x(column) - 1} ${top + 0.5}H${x(end)}`;
      column = end;
    }
  }
  for (let column = 0; column <= COLUMNS; column++) {
    for (let row = 1; row <= SHEET_ROWS;) {
      const edge = leftEdge(row, column); let end = row + 1;
      while (end <= SHEET_ROWS && leftEdge(end, column) === edge) end++;
      if (edge === 'thin') thin += `M${x(column) - 0.5} ${y(row) - 1}V${y(end)}`;
      if (edge === 'double') double += `M${x(column) - 1.5} ${y(row) - 1}V${y(end)}M${x(column) + 0.5} ${y(row) - 1}V${y(end)}`;
      row = end;
    }
  }
  return { thin, double };
})();

/** 左寄せの文字がExcelと同じくはみ出せる列数（自分の列＋右に続く空欄、columns 列目まで。既定はH列まで）。 */
export function overflowColumns(row: number, column: number, empty: (row: number, column: number) => boolean, columns: number = COLUMNS): number {
  let span = 1;
  while (column + span < columns && empty(row, column + span)) span++;
  return span;
}
/** 右揃えの文字がExcelと同じくはみ出せる列数（自分の列＋左に続く空欄、A列まで）。 */
export function overflowColumnsLeft(row: number, column: number, empty: (row: number, column: number) => boolean): number {
  let span = 1;
  while (span <= column && empty(row, column - span)) span++;
  return span;
}
/**
 * 中央揃えの文字がはみ出せる、左右に続く空欄の数（左はA列まで、右は columns 列目まで。既定はH列まで）。
 * 文字はセルの中央に置いたまま、両側へ同じ幅だけはみ出す（片側だけ空欄のときははみ出さない）。
 */
export function overflowSides(row: number, column: number, empty: (row: number, column: number) => boolean, columns: number = COLUMNS): { readonly left: number; readonly right: number } {
  return { left: overflowColumnsLeft(row, column, empty) - 1, right: overflowColumns(row, column, empty, columns) - 1 };
}
/** 中央揃えの文字が両側へ同じ幅ではみ出すときの、片側の幅の上限（px。左右の空欄の幅のうち短い方）。 */
export function sideRoom(column: number, sides: { readonly left: number; readonly right: number }): number {
  let left = 0, right = 0;
  for (let k = 1; k <= sides.left; k++) left += w(column - k);
  for (let k = 1; k <= sides.right; k++) right += w(column + k);
  return Math.min(left, right);
}
