import { useEffect, useRef } from 'react';
import type { DocumentHistoryItem } from '../shared/document-api';
import type { SearchRow } from '../shared/material-search-api';
import { documentTitle, formatUpdatedAt } from './document-labels';
export type ConfirmChoice = 'save' | 'discard' | 'cancel';
/** 確認の種類。delete は明細の削除、delete-documents は請求書の削除、delete-materials は材料の削除（対象を表示順に）。 */
export type ConfirmRequest = { readonly kind: 'leave' | 'delete' } | { readonly kind: 'delete-documents'; readonly documents: readonly DocumentHistoryItem[] }
  | { readonly kind: 'delete-materials'; readonly materials: readonly SearchRow[] };
export type Confirmation = ConfirmRequest & { readonly resolve: (choice: ConfirmChoice) => void };
export function ConfirmDialog({ confirmation }: { readonly confirmation: Confirmation }) {
  const ref = useRef<HTMLDialogElement>(null);
  // 既定のボタン（data-autofocus）へは showModal の後に移す（React の autoFocus は開く前に効かず、showModal が選ぶ最初の要素は、スクロールする一覧のこともあるため）。
  useEffect(() => { const dialog = ref.current; const previous = document.activeElement; dialog?.showModal(); dialog?.querySelector<HTMLElement>('[data-autofocus]')?.focus(); return () => { dialog?.close(); if (previous instanceof HTMLElement) previous.focus(); }; }, []);
  return <dialog ref={ref} className="confirm-dialog" aria-labelledby="confirm-title" onCancel={event => { event.preventDefault(); confirmation.resolve('cancel'); }}>
    {confirmation.kind === 'delete-documents' ? <DeleteDocuments documents={confirmation.documents} resolve={confirmation.resolve}/>
      : confirmation.kind === 'delete-materials' ? <DeleteMaterials materials={confirmation.materials} resolve={confirmation.resolve}/> : <div className="stack"><h2 id="confirm-title">{confirmation.kind === 'delete' ? 'この明細を削除しますか？' : '未保存の変更があります'}</h2>
      <p>{confirmation.kind === 'delete' ? '材料マスターは変更されません。' : '保存して続けるか、未保存分を破棄してください。処理中の保存結果が不明な場合は先に確認します。'}</p>
      <div className="actions"><button className="btn" data-autofocus onClick={() => confirmation.resolve('cancel')}>戻る</button>
        {confirmation.kind === 'leave' && <button className="btn primary" onClick={() => confirmation.resolve('save')}>保存して続ける</button>}
        <button className="btn danger" onClick={() => confirmation.resolve('discard')}>{confirmation.kind === 'delete' ? '明細を削除' : '未保存分を破棄'}</button></div>
    </div>}
  </dialog>;
}

/** 請求書の削除の確認。題名のない請求書も見分けられるよう、上部欄・明細の行数・更新日時を添える。既定のフォーカスは「戻る」。 */
function DeleteDocuments({ documents, resolve }: { readonly documents: readonly DocumentHistoryItem[]; readonly resolve: (choice: ConfirmChoice) => void }) {
  const count = documents.length;
  return <div className="stack">
    <h2 id="confirm-title">{count === 1 ? 'この請求書を削除しますか？' : `${count}件の請求書を削除しますか？`}</h2>
    <ul className="delete-targets" aria-label="削除する請求書">{documents.map(item => <li key={item.id}>
      <span className="strong original-text">{documentTitle(item)}</span>
      <span className="note"><span className="original-text">{item.c2 || '上部欄 未入力'}</span> ・ 明細 {item.lineCount}行 ・ {formatUpdatedAt(item.updatedAt)}</span>
    </li>)}</ul>
    <p>削除した請求書は元に戻せません。明細とセルの書式も一緒に削除されます。材料マスターと、出力済みのExcel・PDFファイルは変わりません。</p>
    <div className="actions"><button className="btn" data-autofocus onClick={() => resolve('cancel')}>戻る</button>
      <button className="btn danger solid" onClick={() => resolve('discard')}>{count === 1 ? '削除する' : `${count}件を削除する`}</button></div>
  </div>;
}

/** 材料の削除の確認。品名が同じ材料も見分けられるよう、型式・メーカー・カテゴリ（無効ならその旨）を添える。既定のフォーカスは「戻る」。 */
function DeleteMaterials({ materials, resolve }: { readonly materials: readonly SearchRow[]; readonly resolve: (choice: ConfirmChoice) => void }) {
  const count = materials.length;
  return <div className="stack">
    <h2 id="confirm-title">{count === 1 ? 'この材料を削除しますか？' : `${count}件の材料を削除しますか？`}</h2>
    <ul className="delete-targets" aria-label="削除する材料">{materials.map(row => <li key={row.id}>
      <span className="strong original-text">{row.name || '（品名なし）'}</span>
      <span className="note"><span className="original-text">{[row.model, row.manufacturer].filter(Boolean).join(' ・ ') || '型式・メーカー 未入力'}</span> ・ <span className="original-text">{row.categoryName}</span>{row.active ? '' : ' ・ 無効'}</span>
    </li>)}</ul>
    <p>削除した材料は元に戻せません。材料台帳・材料検索に出なくなり、請求書へ追加できなくなります。作成済みの請求書の明細と、取込履歴は変わりません。</p>
    <div className="actions"><button className="btn" data-autofocus onClick={() => resolve('cancel')}>戻る</button>
      <button className="btn danger solid" onClick={() => resolve('discard')}>{count === 1 ? '削除する' : `${count}件を削除する`}</button></div>
  </div>;
}
