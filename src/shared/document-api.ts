import type { HeaderFormats, LineFormats } from './cell-format';
export const DOCUMENT_CHANNELS = { open: 'documents:open', duplicate: 'documents:duplicate', list: 'documents:list', delete: 'documents:delete', addLine: 'documents:add-line', save: 'documents:save', close: 'documents:close', closeRequested: 'documents:close-requested' } as const;
export interface InvoiceLine {
  readonly id: string;
  readonly materialId: string | null;
  readonly sourceItemId: string | null;
  readonly name: string;
  readonly model: string;
  readonly manufacturer: string;
  readonly quantity: string;
  readonly remarks: string;
  readonly deliveryState: 'unknown' | 'material_only' | 'slip_only' | 'both';
  readonly markOutput: 'unresolved' | 'blank' | 'filled_circle' | 'open_circle' | 'both_mark';
  readonly observedMark: string | null;
  readonly ruleVersion: string;
  /** セルの書式（書式のない明細では省かれる）。 */
  readonly formats?: LineFormats;
}
export interface InvoiceDraft {
  readonly title: string;
  readonly header: Readonly<Record<'C2' | 'A4' | 'B4' | 'C4' | 'E4', string>>;
  readonly templateVersion: string;
  readonly lines: readonly InvoiceLine[];
  /** 帳票上部の入力欄（上部欄・ヘッダー欄・納期）の書式（書式がなければ省かれる）。 */
  readonly formats?: HeaderFormats;
}
export interface EditorSession { readonly sessionId: string; readonly documentId: string | null; readonly revision: number; readonly draft: InvoiceDraft }
export interface SaveDocument { readonly sessionId: string; readonly requestNumber: number; readonly generation: number; readonly expectedRevision: number; readonly draft: InvoiceDraft }
export interface SaveReceipt { readonly sessionId: string; readonly documentId: string; readonly requestNumber: number; readonly generation: number; readonly revision: number }
export interface DocumentHistoryItem { readonly id: string; readonly title: string; readonly updatedAt: string; readonly revision: number; readonly duplicatedFromId: string | null; readonly c2: string; readonly lineCount: number; readonly issueCount: number; readonly exportedRevision: number | null; readonly exportedAt: string | null }
export interface DocumentHistory { readonly items: readonly DocumentHistoryItem[]; readonly page: number; readonly hasMore: boolean }
/** 削除の結果。deleted は今回削除した数（削除済み・存在しない ID は数えない）。 */
export interface DeleteReceipt { readonly deleted: number }
export type DocumentResult<T> = { readonly status: 'ok'; readonly data: T } | { readonly status: 'error'; readonly code: 'VALIDATION' | 'CONFLICT' | 'NOT_FOUND' | 'DB'; readonly message: string; readonly correlationId: string };
export interface DocumentApi {
  readonly open: (id: string | null) => Promise<DocumentResult<EditorSession>>;
  readonly duplicate: (id: string) => Promise<DocumentResult<EditorSession>>;
  readonly list: (page: number, query?: string) => Promise<DocumentResult<DocumentHistory>>;
  /** 請求書をまとめて削除する（1〜100件。すべて削除するか、何も削除しない）。元に戻せない。 */
  readonly delete: (ids: readonly string[]) => Promise<DocumentResult<DeleteReceipt>>;
  readonly addLine: (input: { readonly sessionId: string; readonly materialId: string | null }) => Promise<DocumentResult<InvoiceLine>>;
  readonly save: (input: SaveDocument) => Promise<DocumentResult<SaveReceipt>>;
  readonly onCloseRequested: (callback: (token: string) => void) => () => void;
  readonly close: (token: string) => Promise<DocumentResult<null>>;
}
