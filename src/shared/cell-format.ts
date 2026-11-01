import { FONTS, cellStyle } from './invoice-sheet';
import type { CellStyle, HeaderKey, LineField, StyleName } from './invoice-sheet';

// セルの書式（src-tauri/core/src/format.rs と同じ定義）。Excelプレビューのツールバーで、入力したセル（上部欄・ヘッダー欄・納期と明細のセル）に付ける。
// 帳票の既定の書式（invoice-sheet.ts の STYLES）は変えず、セルごとの差分だけを持つ。指定のない項目は帳票の既定のまま。

export type HorizontalAlign = 'left' | 'center' | 'right';
/** 縦の配置。指定なしはExcelの既定の「下揃え」。 */
export type VerticalAlign = 'top' | 'center';
/** 1つのセルの書式。キーの並びは format.rs の CellFormat と同じ。太字などは true だけを持つ（指定しないことが「なし」）。 */
export interface CellFormat {
  readonly horizontal?: HorizontalAlign;
  readonly vertical?: VerticalAlign;
  readonly bold?: true;
  readonly italic?: true;
  readonly underline?: true;
  readonly size?: number;
  readonly color?: string;
  readonly fill?: string;
}
export type HeaderFormats = Readonly<Partial<Record<HeaderKey, CellFormat>>>;
export type LineFormats = Readonly<Partial<Record<LineField, CellFormat>>>;

/** 選べる文字の大きさ（pt）。行の高さは帳票で固定のため、行に収まる大きさまで。 */
export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16] as const;
export interface PaletteColor { readonly code: string; readonly name: string }
/** 文字の色・塗りつぶしの色（RRGGBB）。先頭8色は淡い色と白・灰色、残り10色はExcelの「標準の色」。並びは format.rs の PALETTE と同じ。 */
export const PALETTE: readonly PaletteColor[] = [
  { code: 'FFFFFF', name: '白' }, { code: 'D9D9D9', name: '淡い灰色' }, { code: '808080', name: '灰色' },
  { code: 'FFF2CC', name: '淡い黄' }, { code: 'FCE4D6', name: '淡いオレンジ' }, { code: 'E2EFDA', name: '淡い緑' },
  { code: 'DDEBF7', name: '淡い青' }, { code: 'E4DFEC', name: '淡い紫' },
  { code: 'C00000', name: '濃い赤' }, { code: 'FF0000', name: '赤' }, { code: 'FFC000', name: 'オレンジ' }, { code: 'FFFF00', name: '黄' },
  { code: '92D050', name: '薄い緑' }, { code: '00B050', name: '緑' }, { code: '00B0F0', name: '薄い青' }, { code: '0070C0', name: '青' },
  { code: '002060', name: '濃い青' }, { code: '7030A0', name: '紫' },
];
export const colorName = (code: string | undefined): string => PALETTE.find(color => color.code === code)?.name ?? '';

/** 書式を当てたセルの見た目（format.rs・sheet.rs の resolve と同じ規則）。align の general は文字なら左揃えと同じ見た目。 */
export interface ResolvedStyle {
  readonly base: CellStyle; readonly size: number; readonly bold: boolean; readonly italic: boolean; readonly underline: boolean;
  readonly color: string | undefined; readonly fill: string | undefined;
  readonly align: CellStyle['align'] | 'right'; readonly vertical: VerticalAlign | undefined; readonly indent: number | undefined;
}

/** 帳票の既定の書式に、セルの書式を重ねる。字下げは既定と同じ左揃えのときだけ残す（Excelでも中央揃えにすると字下げは外れる）。 */
export function resolveStyle(name: StyleName, format: CellFormat | null | undefined): ResolvedStyle {
  const base = cellStyle(name), align = format?.horizontal ?? base.align;
  const indent = !format?.horizontal || (align === 'left' && base.align === 'left') ? base.indent : undefined;
  return {
    base, size: format?.size ?? FONTS[base.font]?.size ?? 11, bold: format?.bold === true, italic: format?.italic === true, underline: format?.underline === true,
    color: format?.color, fill: format?.fill, align, vertical: format?.vertical, indent,
  };
}

/** 画面で見える横の配置（標準の general は左揃えに見える）。 */
export const visibleAlign = (style: ResolvedStyle): HorizontalAlign => style.align === 'general' ? 'left' : style.align;

/** 帳票の既定と同じ指定を外し、空なら undefined にする（保存する書式を最小にそろえる）。 */
export function normalizeFormat(name: StyleName, format: CellFormat | undefined): CellFormat | undefined {
  if (!format) return undefined;
  const base = cellStyle(name), baseAlign = base.align === 'general' ? 'left' : base.align;
  const next: CellFormat = {
    ...(format.horizontal && format.horizontal !== baseAlign ? { horizontal: format.horizontal } : {}),
    ...(format.vertical ? { vertical: format.vertical } : {}),
    ...(format.bold ? { bold: true } : {}), ...(format.italic ? { italic: true } : {}), ...(format.underline ? { underline: true } : {}),
    ...(format.size !== undefined && format.size !== FONTS[base.font]?.size ? { size: format.size } : {}),
    ...(format.color ? { color: format.color } : {}), ...(format.fill ? { fill: format.fill } : {}),
  };
  return Object.keys(next).length ? next : undefined;
}
