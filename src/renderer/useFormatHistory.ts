import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { InvoiceDraft } from '../shared/document-api';
import { EMPTY_HISTORY, nextRedo, nextUndo, recordFormats, redoFormats, undoFormats } from './format-history';
import type { FormatChange, FormatHistory } from './format-history';

/** 請求書の編集画面のキー操作か（フォーカスが編集画面の中、またはどこにもないとき）。ダイアログ・材料パレットでは反応しない。 */
export const inEditor = (target: EventTarget | null): boolean => target === document.body || (target instanceof Element && target.closest('.editor-layout') !== null);
/** 帳票の内容を入力する文字の入力欄（材料の検索欄・チェックボックスなどは除く）。 */
const textField = (target: EventTarget | null): target is HTMLInputElement | HTMLTextAreaElement =>
  (target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && (target.type === 'text' || target.type === 'search'))) && target.id !== 'add-line-input';
/** 文字の入力1回分（入力欄の標準の取り消し1段に当たる）。at は入力（やり直しの段は取り消し）をした順番。 */
interface TextMark { readonly field: Element; readonly at: number }
const TEXT_LIMIT = 500;
function lastOf(marks: readonly TextMark[], field: Element): TextMark | undefined {
  for (let index = marks.length - 1; index >= 0; index--) if (marks[index]?.field === field) return marks[index];
  return undefined;
}

export interface FormatHistoryControls { readonly canUndo: boolean; readonly canRedo: boolean; readonly undo: () => void; readonly redo: () => void }

/**
 * 書式の変更の履歴と、元に戻す（Ctrl+Z）・やり直し（Ctrl+Y / Ctrl+Shift+Z）。
 * 文字の入力欄で押したときは、その欄の文字の入力と書式の変更のうち新しい方から戻す（やり直しは戻した順の逆）。
 * 文字は入力欄の標準の取り消し・やり直しに任せ、ここでは欄ごとの順番だけを追う（標準の取り消しで欄の中を行き来した分も追う）。
 * typed は編集画面の input イベントで呼ぶ。新しく文字を入力すると、書式のやり直しの履歴は消える。
 */
export function useFormatHistory(draft: InvoiceDraft | undefined, edit: (draft: InvoiceDraft) => void, locked: boolean) {
  const [history, setHistory] = useState<FormatHistory>(EMPTY_HISTORY);
  // 書式の変更と文字の入力に通し番号を付け、どちらが後かを比べる。
  const clock = useRef(0), key = useRef<(event: KeyboardEvent) => void>(() => undefined);
  const textUndo = useRef<TextMark[]>([]), textRedo = useRef<TextMark[]>([]);
  // 続けて入力している欄（入力欄の標準の取り消しは続けて入力した文字をまとめて戻すため、同じ1段として数える）。
  const typing = useRef<Element | null>(null), nativeSteps = useRef(0);
  const tick = (): number => { clock.current += 1; return clock.current; };
  const push = (marks: TextMark[], mark: TextMark): TextMark[] => [...marks, mark].slice(-TEXT_LIMIT);
  const without = (marks: TextMark[], mark: TextMark | undefined): TextMark[] => marks.filter(item => item !== mark);
  function apply(result: { readonly history: FormatHistory; readonly draft: InvoiceDraft } | null): void {
    if (!result) return;
    typing.current = null;
    setHistory(result.history); edit(result.draft);
  }
  const record = (changes: readonly FormatChange[]): void => { if (draft && !locked) apply(recordFormats(history, draft, changes, tick())); };
  const undo = (): void => { if (draft && !locked) apply(undoFormats(history, draft, tick())); };
  const redo = (): void => { if (draft && !locked) apply(redoFormats(history, draft, tick())); };
  function typed(event: FormEvent<HTMLElement>): void {
    const field = event.target;
    if (!textField(field)) return;
    const kind = event.nativeEvent instanceof InputEvent ? event.nativeEvent.inputType : '';
    if (kind === 'historyUndo' || kind === 'historyRedo') {
      // 入力欄の標準の取り消し・やり直し: その欄の文字の1段を、もう一方の履歴へ移す。
      nativeSteps.current += 1; typing.current = null;
      const [from, to] = kind === 'historyUndo' ? [textUndo, textRedo] : [textRedo, textUndo];
      from.current = without(from.current, lastOf(from.current, field));
      to.current = push(to.current, { field, at: tick() });
      return;
    }
    textRedo.current = textRedo.current.filter(mark => mark.field !== field);
    const last = textUndo.current.at(-1);
    if (typing.current === field && last?.field === field) textUndo.current = [...textUndo.current.slice(0, -1), { field, at: tick() }];
    else textUndo.current = push(textUndo.current, { field, at: tick() });
    typing.current = field;
    if (history.redo.length) setHistory(current => ({ undo: current.undo, redo: [] }));
  }
  /** 入力欄の標準の取り消し（やり直し）に任せた後、その欄に戻せる文字がなかったら、その欄の古い記録を捨てて次は書式へ進めるようにする。 */
  function expectNative(field: Element, marks: { current: TextMark[] }): void {
    const before = nativeSteps.current;
    window.setTimeout(() => { if (nativeSteps.current === before) marks.current = marks.current.filter(mark => mark.field !== field); }, 0);
  }
  useLayoutEffect(() => {
    key.current = event => {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.isComposing || event.keyCode === 229 || locked || !draft || !inEditor(event.target)) return;
      const name = event.key.toLowerCase(), redoing = name === 'y' || (name === 'z' && event.shiftKey);
      if (name !== 'z' && !redoing) return;
      if (event.target instanceof HTMLElement && event.target.id === 'add-line-input') return;
      const step = redoing ? nextRedo(history, draft) : nextUndo(history, draft);
      const field = textField(event.target) ? event.target : null, marks = redoing ? textRedo : textUndo;
      const text = field ? lastOf(marks.current, field) : undefined;
      if (!step || (field && text && text.at > step.at)) { if (field && text) expectNative(field, marks); return; }
      event.preventDefault();
      if (redoing) redo(); else undo();
    };
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => { key.current(event); };
    window.addEventListener('keydown', listener);
    return () => { window.removeEventListener('keydown', listener); };
  }, []);
  const controls: FormatHistoryControls = { canUndo: !locked && draft !== undefined && nextUndo(history, draft) !== undefined, canRedo: !locked && draft !== undefined && nextRedo(history, draft) !== undefined, undo, redo };
  return { record, typed, controls };
}
