import type { DocumentHistoryItem } from '../shared/document-api';
// 請求書一覧と削除の確認で、同じ請求書を同じ表記で示す。
const updatedFormat = new Intl.DateTimeFormat('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
export function formatUpdatedAt(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : updatedFormat.format(date); }
export function documentTitle(item: Pick<DocumentHistoryItem, 'title'>): string { return item.title || '（タイトルなし）'; }
/** 読み上げ用の名前（題名のない請求書は、上部欄と更新日時を添えて見分けられるようにする）。 */
export function documentLabel(item: Pick<DocumentHistoryItem, 'title' | 'c2' | 'updatedAt'>): string {
  return item.title ? `「${item.title}」` : `「（タイトルなし）」（${item.c2 || '上部欄 未入力'}・${formatUpdatedAt(item.updatedAt)}）`;
}
