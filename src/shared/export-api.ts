export const EXPORT_CHANNEL = 'documents:export-excel';
export interface ExportRequest { readonly documentId: string; readonly revision: number }
/** 出力を止める理由の欄（本体との約束事。spec/03-ipc-api.md）。`lines.<番号>.mark` の番号は0始まりの明細の位置。 */
export type ExportIssueField = 'templateVersion' | 'E4' | 'lines' | `lines.${number}.mark`;
export interface ExportIssue { readonly field: ExportIssueField; readonly message: string }
export interface ExportCleanup { readonly temporaryName: string }
export type ExportResult =
  | { readonly status: 'ok'; readonly cleanup: ExportCleanup | null; readonly documentId: string; readonly revision: number }
  | { readonly status: 'cancelled' }
  | { readonly status: 'blocked'; readonly issues: readonly ExportIssue[] }
  | { readonly status: 'error'; readonly code: 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'IO' | 'BUSY'; readonly message: string; readonly correlationId: string; readonly cleanup?: ExportCleanup };
export interface ExportApi { readonly excel: (request: ExportRequest) => Promise<ExportResult> }
