import { useEffect, useRef, useState } from 'react';
import { SEARCH_DEBOUNCE_MS } from '../shared/limits';
import type { SearchData, SearchInput } from '../shared/material-search-api';
import { clipQuery } from './search-query';

export type SearchState = { readonly status: 'loading' } | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly data: SearchData };
const initial: SearchInput = { query: '', categoryId: null, includeInactive: false, offset: 0 };

/**
 * 材料検索（パレット・明細のインライン追加・材料台帳で共有）。入力は180ms待ってから検索し、古い応答は世代で捨てる。カテゴリの候補は useCategoryPage で取る。
 * IMEの変換中も、確定を待たずに今の文字で検索する（composing は、変換中のキー操作を IME に任せること（パレット・明細の追加欄）と、明細の追加欄で変換中に候補や「空の明細を追加」を押したときに先に確定させることに使う）。
 */
export function useMaterialSearch(options: { readonly enabled?: boolean } = {}) {
  const enabled = options.enabled ?? true;
  const [input, setInput] = useState(initial);
  const [request, setRequest] = useState({ input: initial, generation: 0, immediate: true });
  const [state, setState] = useState<SearchState>({ status: 'loading' });
  const generation = useRef(0), composing = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const timer = window.setTimeout(() => {
      if (!active || generation.current !== request.generation) return;
      void window.appApi.materials.search(request.input).then(result => {
        if (!active || generation.current !== request.generation) return;
        switch (result.status) {
          case 'ok': setState({ status: 'ready', data: result.data }); break;
          case 'error': setState({ status: 'error', message: result.message }); break;
        }
      }, () => {
        if (active && generation.current === request.generation) setState({ status: 'error', message: '検索できませんでした。もう一度検索してください。' });
      });
    }, request.immediate ? 0 : SEARCH_DEBOUNCE_MS);
    return () => { active = false; window.clearTimeout(timer); };
  }, [request, enabled]);

  function change(next: SearchInput, immediate = false): void {
    generation.current += 1;
    setInput(next); setState({ status: 'loading' });
    setRequest({ input: { ...next, query: clipQuery(next.query) }, generation: generation.current, immediate });
  }
  return {
    input, state, composing,
    change,
    setQuery: (query: string) => { change({ ...input, query, offset: 0 }); },
    retry: () => { change(input, true); },
    /** 外部の変更（保存など）の後に同じ条件で再検索する。 */
    refresh: () => { change(input, true); },
    /** 同じ条件で読み直す（refresh と違い、読み直す間も今の結果を表示したままにする。削除の後に、一覧のスクロール位置とフォーカス先を残すため）。 */
    reload: () => { generation.current += 1; setRequest({ input: request.input, generation: generation.current, immediate: true }); },
    compositionStart: () => { composing.current = true; },
    /**
     * 変換の終わり。変換中の入力ですでに検索しているため、確定した文字が今の検索語と同じなら検索し直さない
     * （読み直すと、確定と同時に押した候補が読み込み中の表示に替わって押せなくなる）。検索語を変えたら true を返す。
     */
    compositionEnd: (value: string): boolean => {
      composing.current = false;
      if (value === input.query) return false;
      change({ ...input, query: value, offset: 0 }); return true;
    },
  };
}

/** キー操作がIMEの変換中かどうか。 */
export function isComposingKey(event: { readonly nativeEvent: KeyboardEvent }, composing: boolean): boolean {
  return composing || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
}
