export const IMPORT_CHANNELS = { choose: 'imports:choose', chooseFromPath: 'imports:choose-from-path', list: 'imports:list', review: 'imports:review', apply: 'imports:apply', cancel: 'imports:cancel', resume: 'imports:resume' } as const;
export interface ImportCounts { readonly candidates: number; readonly held: number; readonly supplements: number; readonly excluded: number; readonly empty: number; readonly applied: number }
export type ImportStatus = 'preview' | 'applied' | 'cancelled' | 'failed';
export interface ImportSummary { readonly id: string; readonly displayName: string; readonly createdAt: string; readonly status: ImportStatus; readonly counts: ImportCounts }
export interface ImportRow {
  readonly id: string; readonly sheetName: string; readonly sheetOrder: number; readonly rowIndex: number; readonly block: string;
  readonly classification: 'candidate' | 'held' | 'supplement' | 'header'; readonly reason: string;
  readonly values: readonly string[];
  readonly applied: boolean;
  readonly cells: readonly { readonly column: string; readonly rawValue: string | null; readonly displayText: string; readonly formatCode: string | null; readonly kind: string; readonly presence: string; readonly displayVerified: boolean }[];
}
/** resumeBlocked: 確認中でない記録から再確認できない理由（再確認できるとき・確認中のときは null）。 */
export interface ImportReview { readonly batch: ImportSummary; readonly items: readonly ImportRow[]; readonly resumeBlocked: string | null }
export type ImportResult<T> = { readonly status: 'ok'; readonly data: T } | { readonly status: 'cancelled' } | { readonly status: 'error'; readonly code: string; readonly message: string; readonly correlationId: string };
export interface ImportApi {
  readonly choose: () => Promise<ImportResult<ImportReview>>;
  /** ドロップしたファイル。パスはpreloadで取り出してMainへ渡し、Mainで検証する（rendererへは渡さない）。 */
  readonly chooseFile: (file: File) => Promise<ImportResult<ImportReview>>;
  readonly list: () => Promise<ImportResult<readonly ImportSummary[]>>;
  readonly review: (batchId: string) => Promise<ImportResult<ImportReview>>;
  readonly apply: (input: { readonly batchId: string; readonly acceptedIds: readonly string[] }) => Promise<ImportResult<ImportReview>>;
  readonly cancel: (batchId: string) => Promise<ImportResult<ImportReview>>;
  readonly resume: (batchId: string) => Promise<ImportResult<ImportReview>>;
}
