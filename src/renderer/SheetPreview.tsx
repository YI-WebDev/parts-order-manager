import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TEXT_MAX_LENGTH } from '../shared/limits';
import type { CSSProperties, MouseEvent } from 'react';
import type { InvoiceDraft } from '../shared/document-api';
import { exportIssues, issueMessage, markIndex } from '../shared/export-issues';
import { normalizeFormat, resolveStyle } from '../shared/cell-format';
import type { CellFormat, ResolvedStyle } from '../shared/cell-format';
import { LINE_FIRST_ROW, LINE_ROWS, SHEET_ROWS, columnName, displayText, lineMark, sheetCells } from '../shared/invoice-sheet';
import type { CellSource, HeaderKey, LineField, SheetCell } from '../shared/invoice-sheet';
import { COLUMNS, HEIGHT, INDENT, PAD, WIDTH, borderPaths, bottomEdge, cellKey, fontOf, h, leftEdge, overflowColumns, overflowColumnsLeft, overflowSides, sideRoom, w, x, y } from '../shared/sheet-geometry';
import { FormatBar } from './FormatBar';
import type { FormatActions, FormatToggle } from './FormatBar';
import { inEditor } from './useFormatHistory';
import type { FormatHistoryControls } from './useFormatHistory';

// Excel出力（main/exports/workbook.ts）と同じ帳票定義を、Excelの標準表示と同じ寸法（shared/sheet-geometry.ts）で描く。
const HEAD_W = 32, HEAD_H = 20;
const ZOOMS = [0.3, 0.4, 0.5, 0.6, 0.75, 0.9, 1, 1.25, 1.5, 2];
const LINE_FIELDS: readonly LineField[] = ['mark', 'name', 'model', 'manufacturer', 'quantity', 'remarks'];
const FIELD_LABELS: Readonly<Record<LineField, string>> = { mark: 'チェック', name: '品名', model: '型式', manufacturer: 'メーカー', quantity: '数量', remarks: '備考' };
const HEADER_FIELDS: readonly { readonly key: HeaderKey; readonly label: string; readonly placeholder: string }[] = [
  { key: 'C2', label: '上部欄', placeholder: '宛先など' },
  { key: 'A4', label: 'ヘッダー欄（左）', placeholder: '入力' },
  { key: 'B4', label: 'ヘッダー欄（中央）', placeholder: '入力' },
  { key: 'C4', label: 'ヘッダー欄（右）', placeholder: '入力' },
  { key: 'E4', label: '納期', placeholder: '日付' },
];
const HEADER_POSITION: Readonly<Record<HeaderKey, readonly [number, number]>> = { C2: [2, 2], A4: [4, 0], B4: [4, 1], C4: [4, 2], E4: [4, 4] };

const template = sheetCells({ C2: '', A4: '', B4: '', C4: '', E4: '' }, []);

let canvas: CanvasRenderingContext2D | null | undefined;
function textWidth(text: string, style: ResolvedStyle): number {
  canvas ??= document.createElement('canvas').getContext('2d');
  if (!canvas) return text.length * 15;
  canvas.font = `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${style.size}pt ${fontOf(style.base.font).fontFamily}`;
  return canvas.measureText(text).width;
}
/** 書式を当てた文字の CSS（文字の大きさ・太字・斜体・色）。 */
function fontCss(style: ResolvedStyle): CSSProperties {
  return { fontFamily: fontOf(style.base.font).fontFamily, fontSize: `${style.size}pt`, ...(style.bold ? { fontWeight: 700 } : {}), ...(style.italic ? { fontStyle: 'italic' } : {}), ...(style.color ? { color: `#${style.color}` } : {}) };
}
const JUSTIFY = { general: 'flex-start', left: 'flex-start', center: 'center', right: 'flex-end' } as const;
/** 書式の1項目を変えた書式（value が undefined なら外す）。 */
function withValue<K extends keyof CellFormat>(format: CellFormat, key: K, value: CellFormat[K] | undefined): CellFormat {
  const next: Record<string, unknown> = { ...format };
  if (value === undefined) delete next[key]; else next[key] = value;
  return next as CellFormat;
}
/** 書式を変えるセルと、変えた後の書式（undefined は既定の書式に戻す）。 */
export interface FormatUpdate { readonly source: CellSource; readonly format: CellFormat | undefined }
/** 入力欄へのフォーカス。seq はフォーカスのたびに増え、同じ欄へ戻ったときも選択し直す。 */
export interface SheetFocus { readonly source: CellSource; readonly seq: number }
const sameFocus = (a: SheetFocus | null, b: SheetFocus | null): boolean => JSON.stringify(a) === JSON.stringify(b);
function position(source: CellSource): { readonly row: number; readonly column: number } | null {
  if (source.kind === 'header') { const [row, column] = HEADER_POSITION[source.key]; return { row, column }; }
  return source.index < LINE_ROWS ? { row: LINE_FIRST_ROW + source.index, column: LINE_FIELDS.indexOf(source.field) } : null;
}
/** 選択範囲。row・column はアクティブなセル（範囲の起点。名前ボックスと書式の表示に使う）、endRow・endColumn は範囲のもう一方の角。 */
interface Selection { readonly row: number; readonly column: number; readonly endRow: number; readonly endColumn: number; readonly reveal: boolean }
const single = (row: number, column: number, reveal: boolean): Selection => ({ row, column, endRow: row, endColumn: column, reveal });
function bounds(selection: Selection): { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number } {
  return { top: Math.min(selection.row, selection.endRow), bottom: Math.max(selection.row, selection.endRow), left: Math.min(selection.column, selection.endColumn), right: Math.max(selection.column, selection.endColumn) };
}
/** 描く文字と、その箱の位置・幅（px。はみ出す分を含む）。 */
interface Text { readonly cell: SheetCell; readonly style: ResolvedStyle; readonly text: string; readonly left: number; readonly width: number; readonly placeholder: boolean }

/**
 * 出力されるExcel帳票のリアルタイムプレビュー。セル番地の代わりに見た目の位置で入力できるよう、
 * 帳票の上部（上部欄・ヘッダー欄・納期）はプレビューのセルへ直接入力する。明細のセルを選ぶと左の明細表の該当欄へ移動する。
 * セル（ドラッグ・Shift+クリック・列や行の見出しで範囲）を選び、ツールバーで書式（配置・文字・色）を付けられる。書式は入力欄のセルにだけ付く。
 */
export function SheetPreview({ draft, disabled, focus, onHeaderChange, onPick, onFormat, history }: {
  readonly draft: InvoiceDraft; readonly disabled: boolean; readonly focus: SheetFocus | null;
  readonly onHeaderChange: (key: HeaderKey, value: string) => void; readonly onPick: (source: CellSource) => void;
  readonly onFormat: (updates: readonly FormatUpdate[]) => void; readonly history: FormatHistoryControls;
}) {
  const viewport = useRef<HTMLDivElement>(null), cellsLayer = useRef<HTMLDivElement>(null), stopDrag = useRef<(() => void) | null>(null);
  const [zoomMode, setZoomMode] = useState<'fit' | number>('fit'), [available, setAvailable] = useState(0);
  const [guide, setGuide] = useState(true), [editing, setEditing] = useState<HeaderKey | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null), [seenFocus, setSeenFocus] = useState<SheetFocus | null>(null);
  if (!sameFocus(seenFocus, focus)) {
    setSeenFocus(focus);
    const target = focus && position(focus.source);
    if (target) setSelection(single(target.row, target.column, true));
    else if (focus) setSelection(null);
  }
  const fit = available > 0 ? Math.min(2, Math.max(0.3, (available - 4) / (HEAD_W + WIDTH))) : 0.6;
  const zoom = zoomMode === 'fit' ? fit : zoomMode;

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setAvailable(element.clientWidth));
    observer.observe(element); setAvailable(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  // 選択したセルが表示範囲の外にあるときだけ、そのセルが見える位置までスクロールする。
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!selection?.reveal || !element) return;
    const left = (HEAD_W + x(selection.column)) * zoom, right = (HEAD_W + x(selection.column + 1)) * zoom;
    const top = (HEAD_H + y(selection.row)) * zoom, bottom = (HEAD_H + y(selection.row + 1)) * zoom, margin = 24 * zoom;
    if (top - HEAD_H * zoom < element.scrollTop) element.scrollTop = top - HEAD_H * zoom - margin;
    else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight + margin;
    if (left - HEAD_W * zoom < element.scrollLeft) element.scrollLeft = left - HEAD_W * zoom - margin;
    else if (right > element.scrollLeft + element.clientWidth) element.scrollLeft = right - element.clientWidth + margin;
  }, [selection, zoom]);

  const lines = draft.lines.map(line => ({ mark: lineMark(line) ?? '', name: line.name, model: line.model, manufacturer: line.manufacturer, quantity: line.quantity, remarks: line.remarks, formats: line.formats }));
  const cells = sheetCells(draft.header, lines, draft.formats);
  const byPosition = new Map(cells.map(cell => [cellKey(cell.row, cell.column), cell]));
  const empty = (row: number, column: number): boolean => displayText(byPosition.get(cellKey(row, column))?.value ?? null) === '';
  const issues = new Map<number, string>();
  // チェックは任意の項目のため、未選択（空欄）は確認事項にしない。
  // 印は帳票に入る欄（記号は先頭47行、納期）だけ。47行の超過と帳票形式は印を付ける欄がない。
  for (const issue of exportIssues(draft)) {
    const index = markIndex(issue.field);
    if (index !== null && index < LINE_ROWS) issues.set(cellKey(LINE_FIRST_ROW + index, 0), issueMessage(issue, draft));
    else if (issue.field === 'E4') issues.set(cellKey(4, 4), issueMessage(issue, draft));
  }

  // 左寄せの文字は右隣が、右揃えの文字は左隣が、中央揃えの文字は左右の隣が空欄なら、Excelと同じくはみ出して表示し、はみ出した範囲の枠線（グリッド線）を消す。
  // spilled は、左端の線を消すセル（文字がその線を越えて広がるセル）。
  const texts: Text[] = [], spilled = new Set<number>();
  for (const cell of cells) {
    const style = resolveStyle(cell.style, cell.format), value = displayText(cell.value);
    const placeholder = guide && value === '' && cell.source?.kind === 'header' ? placeholderOf(cell.source.key) : '';
    if (!value && !placeholder) continue;
    let left = x(cell.column), width = w(cell.column) - 1;
    if (value && cell.value?.kind === 'text') {
      const needed = PAD * 2 + (style.indent ?? 0) * INDENT + textWidth(value, style);
      if (style.align === 'center') {
        // 文字はセルの中央に置いたまま、左右へ同じ幅だけ（短い側の空欄の幅まで）はみ出す。
        const spill = Math.min(Math.ceil(Math.max(0, needed - w(cell.column)) / 2), sideRoom(cell.column, overflowSides(cell.row, cell.column, empty)));
        if (spill > 0) {
          left -= spill; width += spill * 2;
          for (let column = cell.column, covered = 0; column > 0 && covered < spill; column--) { spilled.add(cellKey(cell.row, column)); covered += w(column - 1); }
          for (let column = cell.column + 1, covered = 0; column < COLUMNS && covered < spill; column++) { spilled.add(cellKey(cell.row, column)); covered += w(column); }
        }
      } else {
        const right = style.align === 'right', limit = right ? overflowColumnsLeft(cell.row, cell.column, empty) : overflowColumns(cell.row, cell.column, empty);
        let start = cell.column, span = 1, room = w(cell.column);
        while (room < needed && span < limit) {
          if (right) { spilled.add(cellKey(cell.row, start)); start--; room += w(start); } else { spilled.add(cellKey(cell.row, cell.column + span)); room += w(cell.column + span); }
          span++;
        }
        left = x(start); width = x(start + span) - x(start) - 1;
      }
    }
    texts.push({ cell, style, text: value || placeholder, left, width, placeholder: !value });
  }
  let grid = '';
  for (let row = 1; row <= SHEET_ROWS; row++) {
    for (let column = 0; column < COLUMNS; column++) {
      if (!bottomEdge(row, column)) grid += `M${x(column) - 1} ${y(row + 1) - 0.5}h${w(column) + 1}`;
      if (column > 0 && !leftEdge(row, column) && !spilled.has(cellKey(row, column))) grid += `M${x(column) - 0.5} ${y(row) - 1}v${h(row) + 1}`;
    }
  }
  if (!leftEdge(1, COLUMNS)) grid += `M${WIDTH - 0.5} 0V${HEIGHT}`;

  const selectedCell = selection ? byPosition.get(cellKey(selection.row, selection.column)) : undefined;
  const area = selection ? bounds(selection) : null, ranged = area !== null && (area.top !== area.bottom || area.left !== area.right);
  // 書式を変えられるのは、範囲の中の入力欄のセル（帳票上部の欄と、明細のある行のセル）。ツールバーはアクティブなセル（入力欄でなければ範囲の最初の入力欄）の書式を示す。
  const targets: { readonly cell: SheetCell; readonly source: CellSource }[] = [];
  if (area) for (let row = area.top; row <= area.bottom; row++) for (let column = area.left; column <= area.right; column++) {
    const cell = byPosition.get(cellKey(row, column));
    if (cell?.source) targets.push({ cell, source: cell.source });
  }
  const active = targets.find(target => target.cell === selectedCell) ?? targets[0];
  const activeStyle = active ? resolveStyle(active.cell.style, active.cell.format) : null;
  function apply(change: (format: CellFormat) => CellFormat): void {
    if (disabled || targets.length === 0) return;
    onFormat(targets.map(({ cell, source }) => ({ source, format: normalizeFormat(cell.style, change(cell.format ?? {})) })));
  }
  const actions: FormatActions = {
    toggle: (key: FormatToggle) => { const on = !activeStyle?.[key]; apply(format => withValue(format, key, on ? true : undefined)); },
    size: size => apply(format => withValue(format, 'size', size)),
    color: code => apply(format => withValue(format, 'color', code)),
    fill: code => apply(format => withValue(format, 'fill', code)),
    horizontal: align => apply(format => withValue(format, 'horizontal', align)),
    vertical: align => apply(format => withValue(format, 'vertical', align)),
    clear: () => apply(() => ({})),
  };
  // Ctrl+B・Ctrl+I・Ctrl+U（請求書の編集画面のどこにフォーカスがあっても、選択中のセルへ）。
  const shortcut = useRef<(key: FormatToggle) => boolean>(() => false);
  useLayoutEffect(() => { shortcut.current = key => { if (disabled || targets.length === 0) return false; actions.toggle(key); return true; }; });
  useEffect(() => {
    const keys: Readonly<Record<string, FormatToggle>> = { b: 'bold', i: 'italic', u: 'underline' };
    const key = (event: globalThis.KeyboardEvent): void => {
      const toggle = keys[event.key.toLowerCase()];
      if (!toggle || !event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      if (!inEditor(event.target)) return;
      if (shortcut.current(toggle)) event.preventDefault();
    };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); };
  }, []);
  useEffect(() => () => stopDrag.current?.(), []);
  // 48行目以降の明細は帳票に入らないため、選択の代わりにその旨を表示する。
  const outside = !selection && focus?.source.kind === 'line' ? focus.source.index + 1 : null;
  const name = outside ? { label: `明細${outside}`, value: `帳票は${LINE_ROWS}行までのため、この明細はExcelに入りません` }
    : area && ranged ? { label: `${columnName(area.left)}${area.top}:${columnName(area.right)}${area.bottom}`, value: `${(area.bottom - area.top + 1) * (area.right - area.left + 1)}セルを選択中（書式を変えられる入力欄 ${targets.length}セル）`, hint: undefined }
    : describe(selection, selectedCell, draft.header);
  const issue = selection && !ranged ? issues.get(cellKey(selection.row, selection.column)) : undefined;
  const nameValue = issue ?? (name.value || (guide && name.hint ? name.hint : ''));
  const hits = useMemo(() => Array.from({ length: SHEET_ROWS * COLUMNS }, (_, index) => {
    const row = Math.floor(index / COLUMNS) + 1, column = index % COLUMNS;
    return <div key={index} data-row={row} data-column={column} style={{ left: x(column), top: y(row), width: w(column), height: h(row) }}/>;
  }), []);
  function cellAt(element: Element | null): { readonly row: number; readonly column: number } | null {
    const target = element instanceof HTMLElement ? element.closest<HTMLElement>('[data-row][data-column]') : null;
    if (!target || !cellsLayer.current?.contains(target)) return null;
    return { row: Number(target.dataset['row']), column: Number(target.dataset['column']) };
  }
  /** ボタンを離すまで、ポインターの下のセルまで範囲を広げる。 */
  function drag(): void {
    stopDrag.current?.();
    const move = (event: globalThis.MouseEvent): void => {
      if ((event.buttons & 1) === 0) { stop(); return; }
      const cell = cellAt(document.elementFromPoint(event.clientX, event.clientY));
      if (cell) setSelection(current => current && (current.endRow !== cell.row || current.endColumn !== cell.column) ? { ...current, endRow: cell.row, endColumn: cell.column, reveal: false } : current);
    };
    const stop = (): void => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', stop); stopDrag.current = null; };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', stop); stopDrag.current = stop;
  }
  function extend(row: number, column: number): void { setSelection(current => current ? { ...current, endRow: row, endColumn: column, reveal: false } : single(row, column, false)); }
  function pick(event: MouseEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    const cell = cellAt(event.target instanceof Element ? event.target : null);
    if (!cell) return;
    const { row, column } = cell;
    if (event.shiftKey && selection) { event.preventDefault(); extend(row, column); drag(); return; }
    setSelection(single(row, column, false)); drag();
    const source = byPosition.get(cellKey(row, column))?.source;
    if (source?.kind === 'line') { event.preventDefault(); onPick(source); }
  }
  /** 列・行の見出し（Shift+クリックで範囲を広げる）。 */
  function pickColumn(event: MouseEvent, column: number): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const from = event.shiftKey && selection ? selection.column : column;
    setSelection({ row: 1, column: from, endRow: SHEET_ROWS, endColumn: column, reveal: false });
  }
  function pickRow(event: MouseEvent, row: number): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const from = event.shiftKey && selection ? selection.row : row;
    setSelection({ row: from, column: 0, endRow: row, endColumn: COLUMNS - 1, reveal: false });
  }
  const step = (direction: 1 | -1): void => setZoomMode(direction > 0 ? ZOOMS.find(value => value > zoom + 0.001) ?? 2 : [...ZOOMS].reverse().find(value => value < zoom - 0.001) ?? 0.3);
  const overflow = draft.lines.length - LINE_ROWS;

  return <aside className="sheet-pane" aria-label="Excelプレビュー">
    <div className="sheet-toolbar">
      <div className="sheet-title"><span className="strong">Excelプレビュー</span><span className="note">出力されるExcelと同じ配置・書式です。入力するとすぐに反映されます。</span></div>
      <div className="sheet-tools">
        <label className="check-control compact"><input type="checkbox" checked={guide} onChange={event => setGuide(event.target.checked)}/>入力欄に色を付ける</label>
        <div className="sheet-zoom" role="group" aria-label="表示倍率">
          <button type="button" aria-label="縮小" disabled={zoom <= 0.3} onClick={() => step(-1)}>−</button>
          <span>{Math.round(zoom * 100)}%</span>
          <button type="button" aria-label="拡大" disabled={zoom >= 2} onClick={() => step(1)}>＋</button>
          <button type="button" aria-pressed={zoomMode === 'fit'} onClick={() => setZoomMode('fit')}>幅に合わせる</button>
        </div>
      </div>
    </div>
    <FormatBar style={activeStyle} disabled={disabled} actions={actions} history={history}/>
    <div className="sheet-namebar" role="status" aria-label="選択中のセル">
      <span className="sheet-name">{name.label}</span>
      {/* 幅が足りずに省略した値・案内は、ポインターを置くと全文を見られる。 */}
      <span className={`sheet-value${issue ? ' issue' : ''}`} title={nameValue || undefined}>{nameValue}</span>
    </div>
    {overflow > 0 && <p className="sheet-overflow" role="alert">明細が{LINE_ROWS}行を{overflow}行超えています。{LINE_ROWS + 1}行目以降は帳票に入りません。</p>}
    <div className="sheet-viewport" ref={viewport}>
      <div className={`sheet${guide ? ' guide' : ''}`} style={{ zoom, width: HEAD_W + WIDTH, height: HEAD_H + HEIGHT }}>
        <div className="sheet-corner" aria-hidden="true" title="すべて選択" onMouseDown={event => { if (event.button === 0) { event.preventDefault(); setSelection({ row: 1, column: 0, endRow: SHEET_ROWS, endColumn: COLUMNS - 1, reveal: false }); } }}/>
        <div className="sheet-colhead" aria-hidden="true">{Array.from({ length: COLUMNS }, (_, column) => <span key={column} className={area && column >= area.left && column <= area.right ? 'active' : undefined} style={{ left: x(column), width: w(column) }} onMouseDown={event => pickColumn(event, column)}>{columnName(column)}</span>)}</div>
        <div className="sheet-rowhead" aria-hidden="true">{Array.from({ length: SHEET_ROWS }, (_, index) => <span key={index} className={area && index + 1 >= area.top && index + 1 <= area.bottom ? 'active' : undefined} style={{ top: y(index + 1), height: h(index + 1) }} onMouseDown={event => pickRow(event, index + 1)}>{index + 1}</span>)}</div>
        <div className="sheet-cells" ref={cellsLayer}>
          <svg className="sheet-grid" aria-hidden="true" width={WIDTH} height={HEIGHT}><path d={grid}/></svg>
          {guide && <div className="sheet-editable" aria-hidden="true">{HEADER_FIELDS.map(field => { const [row, column] = HEADER_POSITION[field.key]; return <span key={field.key} style={{ left: x(column), top: y(row), width: w(column) - 1, height: h(row) - 1 }}/>; })}</div>}
          {/* 塗りつぶしはセルの枠（グリッド線）まで覆い、罫線はその上に描く（Excelと同じ）。 */}
          <div className="sheet-fills" aria-hidden="true">{cells.filter(cell => cell.format?.fill).map(cell => <span key={cell.ref} data-fill={cell.ref} style={{ left: x(cell.column) - 1, top: y(cell.row) - 1, width: w(cell.column) + 1, height: h(cell.row) + 1, background: `#${cell.format?.fill ?? ''}` }}/>)}</div>
          <div className="sheet-texts" aria-hidden="true">{texts.map(({ cell, style, text, left, width, placeholder }) => {
            const source = cell.source, editable = source?.kind === 'header';
            const css: CSSProperties = {
              left, top: y(cell.row), width, height: h(cell.row) - 1, ...fontCss(style),
              justifyContent: JUSTIFY[style.align], paddingLeft: PAD + (style.indent ?? 0) * INDENT, ...(style.vertical ? { alignItems: style.vertical === 'top' ? 'flex-start' : 'center' } : {}),
            };
            return <div key={cell.ref} data-cell={cell.ref} className={`${placeholder ? 'placeholder' : ''}${editable && editing === source.key ? ' hidden' : ''}`} style={css}><span style={style.underline ? { textDecoration: 'underline' } : undefined}>{text}</span></div>;
          })}</div>
          <svg className="sheet-borders" aria-hidden="true" width={WIDTH} height={HEIGHT}><path className="thin" d={borderPaths.thin}/><path className="double" d={borderPaths.double}/></svg>
          <div className="sheet-hits" aria-hidden="true" onMouseDown={pick}>{hits}</div>
          {[...issues.keys()].map(at => { const row = Math.floor(at / 16), column = at % 16; return <span key={at} className="sheet-issue" aria-hidden="true" style={{ left: x(column), top: y(row) }}/>; })}
          {area && ranged && <div className="sheet-range" aria-hidden="true" style={{ left: x(area.left), top: y(area.top), width: x(area.right + 1) - x(area.left) - 1, height: y(area.bottom + 1) - y(area.top) - 1 }}/>}
          {area && <div className="sheet-selection" aria-hidden="true" style={{ left: x(area.left) - 2, top: y(area.top) - 2, width: x(area.right + 1) - x(area.left) + 3, height: y(area.bottom + 1) - y(area.top) + 3 }}/>}
          {HEADER_FIELDS.map(field => {
            const [row, column] = HEADER_POSITION[field.key], style = resolveStyle(template.find(cell => cell.ref === field.key)?.style ?? 'text', draft.formats?.[field.key]);
            const wide = field.key === 'C2' && editing === 'C2';
            return <input key={field.key} id={`header-${field.key}`} data-header={field.key} data-row={row} data-column={column} className="sheet-input" aria-label={field.label} title={`${field.label}（クリックして入力）`} maxLength={TEXT_MAX_LENGTH} disabled={disabled}
              placeholder={guide ? field.placeholder : undefined} value={draft.header[field.key]}
              style={{ left: x(column), top: y(row), width: (wide ? WIDTH - x(column) : w(column)) - 1, height: h(row) - 1, ...fontCss(style), textAlign: style.align === 'general' ? 'left' : style.align, paddingLeft: PAD + (style.indent ?? 0) * INDENT, ...(style.underline ? { textDecoration: 'underline' } : {}), ...(style.fill ? { background: `#${style.fill}` } : {}) }}
              onMouseDown={event => { if (event.button !== 0) return; if (event.shiftKey && selection) { event.preventDefault(); extend(row, column); } else setSelection(single(row, column, false)); }}
              onFocus={() => setEditing(field.key)} onBlur={() => setEditing(null)}
              onChange={event => onHeaderChange(field.key, event.target.value)}/>;
          })}
        </div>
      </div>
    </div>
  </aside>;
}

const placeholderOf = (key: HeaderKey): string => HEADER_FIELDS.find(field => field.key === key)?.placeholder ?? '';
function describe(selection: Selection | null, cell: SheetCell | undefined, header: InvoiceDraft['header']): { readonly label: string; readonly value: string; readonly hint?: string } {
  if (!selection) return { label: 'セル未選択', value: '', hint: '色付きのセルはクリックして直接入力できます。明細のセルを選ぶと左の明細表へ移動します。セルを選ぶと上のボタンで書式を変えられます。' };
  const source = cell?.source, value = displayText(cell?.value ?? null);
  if (source?.kind === 'header') {
    const label = HEADER_FIELDS.find(item => item.key === source.key)?.label ?? '', raw = header[source.key];
    return { label, value: cell?.value?.kind === 'date' ? `${raw}（Excelでは日付「${value}」と表示）` : raw, hint: 'このセルに直接入力できます' };
  }
  if (source?.kind === 'line') return { label: `明細${source.index + 1}・${FIELD_LABELS[source.field]}`, value, hint: '左の明細表で編集します' };
  if (selection.row >= LINE_FIRST_ROW && selection.row < LINE_FIRST_ROW + LINE_ROWS) return { label: `明細${selection.row - LINE_FIRST_ROW + 1}`, value: '', hint: '空き行です' };
  return { label: value ? '見出し（固定）' : '空欄', value };
}
