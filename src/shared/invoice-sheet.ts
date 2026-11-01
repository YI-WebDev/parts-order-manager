import { validDateText } from './date-text';
import { LINE_ROWS } from './limits';
import type { CellFormat, HeaderFormats, LineFormats } from './cell-format';
import type { InvoiceLine } from './document-api';

// 請求書Excel（excel-v1）の帳票レイアウト。利用者の見本帳票（シート「請求書」・印刷範囲 A1:H56）を写した固定定義で、
// Excel出力（main/exports）と画面のリアルタイムプレビュー（renderer/SheetPreview）が同じ定義を使う。
// 見本にある行ごとの書式の揺れ（塗りつぶし・一部の文字サイズ）は手作業の名残とみなし、明細行は先頭行の書式にそろえる。
// 文字のあるセルの横位置は、利用者の指示（2026年10月15日）で見本の左揃え・字下げをやめ、すべて中央揃えを既定にした（縦位置はExcelの既定の下揃え）。
// セルごとの書式（cell-format.ts）で、入力欄のセルだけ既定から変えられる。

export type HeaderKey = 'C2' | 'A4' | 'B4' | 'C4' | 'E4';
export type LineField = 'mark' | 'name' | 'model' | 'manufacturer' | 'quantity' | 'remarks';
export type SheetHeader = Readonly<Record<HeaderKey, string>>;
/** 明細1行の値と、セルの書式（cell-format.ts）。 */
export type SheetLine = Readonly<Record<LineField, string>> & { readonly formats?: LineFormats | undefined };

export const SHEET_NAME = '請求書';
/** 列 A〜H の幅（Excelの文字数単位）。H列は見本で印刷範囲の右端の余白だった空欄の列。 */
export const COLUMN_WIDTHS = [7, 27.33203125, 24.44140625, 9.88671875, 11.109375, 23.77734375, 9, 9] as const;
/** 印刷する列数（A〜G）。見本の印刷範囲は空欄のH列まであるが、罫線のある表が用紙の左右中央に来るようG列までにする。 */
export const PRINT_COLUMNS = 7;
export const SHEET_ROWS = 56;
export const LINE_FIRST_ROW = 6;
export { LINE_ROWS };
export const DEFAULT_ROW_HEIGHT = 13.2;
/** 行の高さ（pt）。 */
export const rowHeight = (row: number): number => row === 2 ? 27 : row >= 4 && row <= 52 ? 21.15 : DEFAULT_ROW_HEIGHT;
export const columnName = (column: number): string => String.fromCharCode(65 + column);

export type Edge = 'thin' | 'double';
export interface Border { readonly left?: Edge; readonly right?: Edge; readonly top?: Edge; readonly bottom?: Edge }
export interface CellStyle { readonly font: number; readonly numFmt: number; readonly border: Border; readonly align: 'general' | 'left' | 'center'; readonly indent?: number }

/** 0 は標準スタイル（列幅の基準になる既定フォント）。セルは明朝体を使う。 */
export const FONTS = [
  { name: 'ＭＳ Ｐゴシック', size: 11, family: 3 },
  { name: 'ＭＳ Ｐ明朝', size: 11, family: 1 },
  { name: 'ＭＳ Ｐ明朝', size: 9, family: 1 },
] as const;
export const NUMBER_FORMATS = [
  { id: 176, code: '#,##0;[Red]#,##0' },
  { id: 177, code: 'm"月"d"日"' },
] as const;
const QUANTITY_FORMAT = 176, DATE_FORMAT = 177;

const STYLES = {
  normal: { font: 0, numFmt: 0, border: {}, align: 'general' },
  text: { font: 1, numFmt: 0, border: {}, align: 'center' },
  headFirst: { font: 1, numFmt: 0, border: { left: 'thin', top: 'thin', bottom: 'double' }, align: 'center' },
  head: { font: 1, numFmt: 0, border: { left: 'thin', right: 'thin', top: 'thin', bottom: 'double' }, align: 'center' },
  headLabel: { font: 1, numFmt: 0, border: { top: 'thin', bottom: 'double' }, align: 'center' },
  headDate: { font: 1, numFmt: DATE_FORMAT, border: { left: 'thin', right: 'thin', top: 'thin', bottom: 'double' }, align: 'center' },
  headEnd: { font: 1, numFmt: 0, border: { bottom: 'double' }, align: 'center' },
  titleFirst: { font: 1, numFmt: 0, border: { left: 'thin', top: 'double', bottom: 'double' }, align: 'center' },
  title: { font: 1, numFmt: 0, border: { left: 'thin', top: 'double', bottom: 'double' }, align: 'center' },
  titleQuantity: { font: 1, numFmt: QUANTITY_FORMAT, border: { left: 'thin', top: 'double', bottom: 'double' }, align: 'center' },
  titleBox: { font: 1, numFmt: 0, border: { left: 'thin', right: 'thin', top: 'double', bottom: 'double' }, align: 'center' },
  mark: { font: 2, numFmt: 0, border: { left: 'thin', right: 'thin', bottom: 'thin' }, align: 'center' },
  lineText: { font: 1, numFmt: 0, border: { left: 'thin', bottom: 'thin' }, align: 'center' },
  lineCenter: { font: 1, numFmt: 0, border: { left: 'thin', bottom: 'thin' }, align: 'center' },
  lineQuantity: { font: 1, numFmt: QUANTITY_FORMAT, border: { left: 'thin', bottom: 'thin' }, align: 'center' },
  lineRemarks: { font: 1, numFmt: 0, border: { left: 'thin', right: 'thin', bottom: 'thin' }, align: 'center' },
  lineEnd: { font: 1, numFmt: 0, border: { left: 'thin', right: 'thin', bottom: 'thin' }, align: 'center' },
} as const satisfies Record<string, CellStyle>;
export type StyleName = keyof typeof STYLES;
/** cellXfs の並び順。0 番は標準スタイル。 */
export const STYLE_NAMES = Object.keys(STYLES) as readonly StyleName[];
export const cellStyle = (name: StyleName): CellStyle => STYLES[name];

export type SheetValue = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'date'; readonly serial: number; readonly month: number; readonly day: number };
export type CellSource = { readonly kind: 'header'; readonly key: HeaderKey } | { readonly kind: 'line'; readonly index: number; readonly field: LineField };
/** format は入力欄（帳票上部と明細）のセルに付けた書式（なければ null）。 */
export interface SheetCell { readonly row: number; readonly column: number; readonly ref: string; readonly style: StyleName; readonly value: SheetValue | null; readonly source: CellSource | null; readonly format: CellFormat | null }

const LINE_COLUMNS: readonly (readonly [LineField | null, StyleName])[] = [['mark', 'mark'], ['name', 'lineText'], ['model', 'lineText'], ['manufacturer', 'lineCenter'], ['quantity', 'lineQuantity'], ['remarks', 'lineRemarks'], [null, 'lineEnd']];
const text = (value: string): SheetValue | null => value === '' ? null : { kind: 'text', text: value };
/**
 * 帳票に置く入力値（帳票上部の欄と明細の値）。前後の空白（全角・半角）を除く。
 * 本体は保存のときに同じ規則で前後の空白を除いて登録するため、入力欄に空白が残っていても、プレビューは登録される形で描く。
 */
export const entered = (value: string): string => value.trim();
const EXCEL_EPOCH = Date.UTC(1899, 11, 30), DAY = 86_400_000;

/**
 * 「材料伝票共に納品」の記号。見本の凡例は白い円の中に黒い円を重ねた図形で、同じ形の全角文字 ⦿（U+29BF）を使う。
 * よく似た ◉（U+25C9）は日本語フォント（JIS X 0213）では小さな半角の行頭記号の字形のため使わない。
 */
export const BOTH_MARK = '⦿';
export type LineMark = '●' | '○' | typeof BOTH_MARK;
/** チェックの状態と記号の対応表（規則 provisional-v1）。状態と記号の対応はここだけで定義する（本体は sheet.rs の CHECK_STATES）。 */
export const CHECK_STATES = [
  { deliveryState: 'unknown', markOutput: 'unresolved', mark: '' },
  { deliveryState: 'material_only', markOutput: 'filled_circle', mark: '●' },
  { deliveryState: 'slip_only', markOutput: 'open_circle', mark: '○' },
  { deliveryState: 'both', markOutput: 'both_mark', mark: BOTH_MARK },
] as const satisfies readonly { readonly deliveryState: InvoiceLine['deliveryState']; readonly markOutput: InvoiceLine['markOutput']; readonly mark: LineMark | '' }[];
/**
 * 明細のチェック記号（規則 provisional-v1）。帳票の凡例どおり、材料のみ ●・伝票のみ ○・材料伝票共に納品 ⦿。
 * チェックは任意の項目で、選んでいない明細（未選択）は空欄 ''（利用者の指示、2026年10月16日。それまでは出力を止めていた）。
 * 記号未確定（「共に納品」の記号を決める前に保存した明細）・状態と記号の不一致は null（出力を止める）。
 */
export function lineMark(line: { readonly deliveryState: string; readonly markOutput: string; readonly ruleVersion: string }): LineMark | '' | null {
  if (line.ruleVersion !== 'provisional-v1') return null;
  return CHECK_STATES.find(entry => entry.deliveryState === line.deliveryState && entry.markOutput === line.markOutput)?.mark ?? null;
}

/** 納期（E4）。実在する日付は見本と同じく日付シリアル値（表示は m月d日）、それ以外は入力文字列のまま。 */
export function dateValue(input: string): SheetValue | null {
  if (input === '') return null;
  if (validDateText(input)) {
    const [year = 0, month = 0, day = 0] = input.split(/[-/]/u).map(Number);
    // 1900年2月以前はExcelの日付シリアル値が実際の日付とずれるため文字列で出力する。
    if (year > 1900 || (year === 1900 && month >= 3)) return { kind: 'date', serial: (Date.UTC(year, month - 1, day) - EXCEL_EPOCH) / DAY, month, day };
  }
  return { kind: 'text', text: input };
}

/** 帳票の全セル（行優先・列順）。lines は先頭 47 行までを帳票に配置する（超過の扱いは呼び出し側で判定する）。formats は帳票上部の入力欄の書式。 */
export function sheetCells(header: SheetHeader, lines: readonly SheetLine[], formats: HeaderFormats = {}): readonly SheetCell[] {
  const cells: SheetCell[] = [];
  const put = (row: number, column: number, style: StyleName, value: SheetValue | null, source: CellSource | null = null): void => {
    const format = source?.kind === 'header' ? formats[source.key] : source?.kind === 'line' ? lines[source.index]?.formats?.[source.field] : undefined;
    cells.push({ row, column, ref: `${columnName(column)}${row}`, style, value, source, format: format && Object.keys(format).length ? format : null });
  };
  const head = (key: HeaderKey): CellSource => ({ kind: 'header', key });
  put(2, 2, 'text', text(entered(header.C2)), head('C2'));
  put(4, 0, 'headFirst', text(entered(header.A4)), head('A4')); put(4, 1, 'head', text(entered(header.B4)), head('B4')); put(4, 2, 'head', text(entered(header.C4)), head('C4'));
  put(4, 3, 'headLabel', text('納期')); put(4, 4, 'headDate', dateValue(entered(header.E4)), head('E4')); put(4, 5, 'headEnd', null);
  put(5, 0, 'titleFirst', text('チェック'));
  for (const [column, label] of ['品　　　名', '形式又はタイプ', 'メーカー'].entries()) put(5, column + 1, 'title', text(label));
  put(5, 4, 'titleQuantity', text('数量')); put(5, 5, 'titleBox', text('備　考')); put(5, 6, 'titleBox', null);
  for (let index = 0; index < LINE_ROWS; index++) {
    const line = lines[index];
    LINE_COLUMNS.forEach(([field, style], column) => put(LINE_FIRST_ROW + index, column, style, line && field ? text(entered(line[field])) : null, line && field ? { kind: 'line', index, field } : null));
  }
  put(53, 1, 'text', text('チェック欄記入　　')); put(53, 2, 'text', text('材料のみ　●'));
  put(54, 2, 'text', text('伝票のみ　○'));
  // 見本では「共に納品」の記号を図形で重ねている。図形を使わず同じ位置に同じ形の文字で置く。
  put(55, 2, 'text', text(`材料伝票共に納品${BOTH_MARK}`));
  return cells;
}

/** セルの表示文字列。折り返しなしのExcelでは改行は表示されないため除く。 */
export function displayText(value: SheetValue | null): string {
  if (!value) return '';
  return value.kind === 'date' ? `${value.month}月${value.day}日` : value.text.replace(/[\r\n]/gu, '');
}
