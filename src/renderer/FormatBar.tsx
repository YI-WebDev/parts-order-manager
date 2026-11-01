import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { FONT_SIZES, PALETTE, colorName, visibleAlign } from '../shared/cell-format';
import type { HorizontalAlign, ResolvedStyle, VerticalAlign } from '../shared/cell-format';
import type { FormatHistoryControls } from './useFormatHistory';

export type FormatToggle = 'bold' | 'italic' | 'underline';
export interface FormatActions {
  readonly toggle: (key: FormatToggle) => void;
  readonly size: (size: number) => void;
  readonly color: (code: string | undefined) => void;
  readonly fill: (code: string | undefined) => void;
  readonly horizontal: (align: HorizontalAlign) => void;
  readonly vertical: (align: VerticalAlign | undefined) => void;
  readonly clear: () => void;
}

// 押しても入力欄のフォーカスを動かさない（Excelのリボンと同じく、入力を続けられるようにする）。
const keepFocus = (event: MouseEvent): void => { event.preventDefault(); };
const BASIC = PALETTE.slice(0, 8), STANDARD = PALETTE.slice(8), POPOVER_WIDTH = 236;

const icon = (children: ReactNode): ReactNode => <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16">{children}</svg>;
const ALIGN_ICONS: Readonly<Record<HorizontalAlign, ReactNode>> = {
  left: icon(<path d="M2 3.5h12M2 6.5h8M2 9.5h12M2 12.5h8"/>),
  center: icon(<path d="M2 3.5h12M4 6.5h8M2 9.5h12M4 12.5h8"/>),
  right: icon(<path d="M2 3.5h12M6 6.5h8M2 9.5h12M6 12.5h8"/>),
};
const VERTICAL_ICONS: Readonly<Record<VerticalAlign | 'bottom', ReactNode>> = {
  top: icon(<><path d="M2 1.5h12"/><path className="bar" d="M5 4.5h6"/></>),
  center: icon(<><path d="M2 1.5h12M2 14.5h12"/><path className="bar" d="M5 8h6"/></>),
  bottom: icon(<><path d="M2 14.5h12"/><path className="bar" d="M5 11.5h6"/></>),
};
const HORIZONTAL: readonly { readonly value: HorizontalAlign; readonly label: string }[] = [{ value: 'left', label: '左揃え' }, { value: 'center', label: '中央揃え' }, { value: 'right', label: '右揃え' }];
const VERTICAL: readonly { readonly value: VerticalAlign | 'bottom'; readonly label: string }[] = [{ value: 'top', label: '上揃え' }, { value: 'center', label: '上下中央揃え' }, { value: 'bottom', label: '下揃え' }];

/**
 * セルの書式のツールバー（Excelの［ホーム］タブの主な書式）。style は選択中のセル（範囲ではアクティブなセル）の見た目で、
 * null のときは書式を変えられるセルを選んでいない。
 */
export function FormatBar({ style, disabled, actions, history }: { readonly style: ResolvedStyle | null; readonly disabled: boolean; readonly actions: FormatActions; readonly history: FormatHistoryControls }) {
  const off = disabled || !style;
  const title = (label: string): string => style ? label : `${label}（書式を変えるセルを選んでください）`;
  const align = style ? visibleAlign(style) : null, vertical = style ? style.vertical ?? 'bottom' : null;
  return <div className="format-bar" role="group" aria-label="セルの書式">
    <span className="format-group">
      <button type="button" className="format-button" aria-label="書式を元に戻す" title="書式の変更を元に戻す（Ctrl+Z）" aria-keyshortcuts="Control+Z" disabled={disabled || !history.canUndo} onMouseDown={keepFocus} onClick={history.undo}>
        {icon(<path d="M5.5 3.5L2.5 6.5l3 3M2.5 6.5h7a4 4 0 010 8H7"/>)}
      </button>
      <button type="button" className="format-button" aria-label="書式をやり直す" title="元に戻した書式の変更をやり直す（Ctrl+Y）" aria-keyshortcuts="Control+Y" disabled={disabled || !history.canRedo} onMouseDown={keepFocus} onClick={history.redo}>
        {icon(<path d="M10.5 3.5l3 3-3 3M13.5 6.5h-7a4 4 0 000 8H9"/>)}
      </button>
    </span>
    <select className="format-size" aria-label="フォントサイズ" title={title('フォントサイズ')} disabled={off} value={style ? String(style.size) : ''} onChange={event => actions.size(Number(event.target.value))}>
      {!style && <option value="">-</option>}
      {FONT_SIZES.map(size => <option key={size} value={size}>{size}</option>)}
    </select>
    <span className="format-group">
      <button type="button" className="format-button bold" aria-label="太字" title={title('太字（Ctrl+B）')} aria-keyshortcuts="Control+B" aria-pressed={style?.bold ?? false} disabled={off} onMouseDown={keepFocus} onClick={() => actions.toggle('bold')}>B</button>
      <button type="button" className="format-button italic" aria-label="斜体" title={title('斜体（Ctrl+I）')} aria-keyshortcuts="Control+I" aria-pressed={style?.italic ?? false} disabled={off} onMouseDown={keepFocus} onClick={() => actions.toggle('italic')}>I</button>
      <button type="button" className="format-button underline" aria-label="下線" title={title('下線（Ctrl+U）')} aria-keyshortcuts="Control+U" aria-pressed={style?.underline ?? false} disabled={off} onMouseDown={keepFocus} onClick={() => actions.toggle('underline')}>U</button>
    </span>
    <span className="format-group">
      <ColorPicker label="文字の色" automatic="自動（黒）" value={style?.color} disabled={off} title={title('文字の色')} onPick={actions.color}
        icon={<span className="color-letter" aria-hidden="true">A</span>}/>
      <ColorPicker label="塗りつぶしの色" automatic="塗りつぶしなし" value={style?.fill} disabled={off} title={title('塗りつぶしの色')} onPick={actions.fill}
        icon={icon(<path className="bucket" d="M3 8.5l5-5 5 5-5 5zM8 3.5V1"/>)}/>
    </span>
    <span className="format-group" role="group" aria-label="横位置">
      {HORIZONTAL.map(item => <button key={item.value} type="button" className="format-button" aria-label={item.label} title={title(item.label)} aria-pressed={align === item.value} disabled={off} onMouseDown={keepFocus} onClick={() => actions.horizontal(item.value)}>{ALIGN_ICONS[item.value]}</button>)}
    </span>
    <span className="format-group" role="group" aria-label="縦位置">
      {VERTICAL.map(item => <button key={item.value} type="button" className="format-button" aria-label={item.label} title={title(item.label)} aria-pressed={vertical === item.value} disabled={off} onMouseDown={keepFocus} onClick={() => actions.vertical(item.value === 'bottom' ? undefined : item.value)}>{VERTICAL_ICONS[item.value]}</button>)}
    </span>
    <button type="button" className="format-button" aria-label="書式をクリア" title={title('書式をクリア（帳票の既定の書式に戻す）')} disabled={off} onMouseDown={keepFocus} onClick={actions.clear}>
      {icon(<path d="M9.5 2.5l4 4-6.5 6.5H4.5L2.5 11zM6.5 5.5l4 4M8 13.5h6"/>)}
    </button>
  </div>;
}

/** 色を選ぶボタンと色の一覧（Escape・一覧の外を押すと閉じる）。 */
function ColorPicker({ label, automatic, value, disabled, title, icon: content, onPick }: {
  readonly label: string; readonly automatic: string; readonly value: string | undefined; readonly disabled: boolean; readonly title: string; readonly icon: ReactNode; readonly onPick: (code: string | undefined) => void;
}) {
  // 一覧はツールバーの横スクロール（狭い画面）で切れないよう、ボタンの位置に固定して表示する。
  const [open, setOpen] = useState<CSSProperties | null>(null);
  const root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null);
  const shown = open !== null && !disabled;
  useEffect(() => {
    if (!shown) return;
    const close = (): void => { setOpen(null); };
    const outside = (event: globalThis.MouseEvent): void => { if (!(event.target instanceof Node) || !root.current?.contains(event.target)) close(); };
    const key = (event: globalThis.KeyboardEvent): void => { if (event.key === 'Escape' && !event.isComposing) { event.stopPropagation(); close(); button.current?.focus(); } };
    const moved = (event: Event): void => { if (!(event.target instanceof Node) || !root.current?.contains(event.target)) close(); };
    window.addEventListener('mousedown', outside); window.addEventListener('keydown', key, true); window.addEventListener('resize', close); window.addEventListener('scroll', moved, true);
    return () => { window.removeEventListener('mousedown', outside); window.removeEventListener('keydown', key, true); window.removeEventListener('resize', close); window.removeEventListener('scroll', moved, true); };
  }, [shown]);
  function toggle(): void {
    const box = button.current?.getBoundingClientRect();
    setOpen(current => current || !box ? null : { top: box.bottom + 4, left: Math.max(8, Math.min(box.left, window.innerWidth - POPOVER_WIDTH - 8)) });
  }
  function pick(code: string | undefined): void { setOpen(null); onPick(code); }
  const swatch = (color: (typeof PALETTE)[number]) => <button key={color.code} type="button" className="color-swatch" aria-label={color.name} title={color.name} aria-pressed={value === color.code} style={{ background: `#${color.code}` }} onMouseDown={keepFocus} onClick={() => pick(color.code)}/>;
  return <div className="color-picker" ref={root}>
    <button ref={button} type="button" className="format-button color-button" aria-label={`${label}（${value ? colorName(value) : automatic}）`} title={title} aria-haspopup="true" aria-expanded={shown} disabled={disabled} onMouseDown={keepFocus} onClick={toggle}>
      {content}<span className="color-bar" aria-hidden="true" style={value ? { background: `#${value}` } : undefined}/><span className="color-caret" aria-hidden="true">▾</span>
    </button>
    {shown && <div className="color-popover" role="group" aria-label={label} style={open}>
      <button type="button" className="color-auto" aria-pressed={value === undefined} onMouseDown={keepFocus} onClick={() => pick(undefined)}>{automatic}</button>
      <span className="color-heading">基本の色</span>
      <div className="color-swatches">{BASIC.map(swatch)}</div>
      <span className="color-heading">標準の色</span>
      <div className="color-swatches">{STANDARD.map(swatch)}</div>
    </div>}
  </div>;
}
