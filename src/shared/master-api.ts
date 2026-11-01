import type { ImportResult, ImportRow, ImportSummary } from './import-api';
export const MASTER_CHANNELS = { get: 'master:get', save: 'master:save', delete: 'master:delete', series: 'reimport:series', choose: 'reimport:choose', chooseFromPath: 'reimport:choose-from-path', list: 'reimport:list', review: 'reimport:review', apply: 'reimport:apply', cancel: 'reimport:cancel', resume: 'reimport:resume' } as const;
export const MATERIAL_FIELDS = ['name', 'model', 'manufacturer', 'quantity', 'remarks', 'unitPrice'] as const;
export type MaterialField = typeof MATERIAL_FIELDS[number];
export type MaterialValues = Readonly<Record<MaterialField, string>>;
export interface ManagedMaterial { readonly id: string; readonly revision: number; readonly categoryId: string; readonly categoryName: string; readonly active: boolean; readonly values: MaterialValues; readonly source: ImportRow | null }
/** categories はカテゴリ候補の先頭ページ（100件まで）、categoryTotal はカテゴリの総数。残りは materials.categories で検索・ページ取得する。 */
export interface MaterialForm { readonly createRequestId:string|null; readonly material: ManagedMaterial | null; readonly categories: readonly { readonly id: string; readonly name: string }[]; readonly categoryTotal: number }
export interface MaterialSave { readonly createRequestId?:string; readonly id: string | null; readonly expectedRevision: number; readonly categoryId: string | null; readonly newCategoryName: string; readonly active: boolean; readonly values: MaterialValues }
/** 材料の削除の結果。deleted は今回削除した数（削除済み・存在しない ID は数えない）。 */
export interface MaterialDeleteReceipt { readonly deleted: number }
export interface SourceAssignment { readonly sourceBatchId:string; readonly itemId:string; readonly materialId:string }
export interface ReimportRow { readonly sourceBatchId:string; readonly source: ImportRow; readonly suggestedIds: readonly string[]; readonly comparison: 'same' | 'changed' | 'ambiguous' | 'unmatched' | 'held' }
export interface ReimportReview { readonly assignments:readonly SourceAssignment[]; readonly batch: ImportSummary; readonly seriesId: string; readonly stale: boolean; readonly decisions: readonly {readonly itemId:string;readonly materialId:string|null;readonly decision:string;readonly selectedFields:readonly string[];readonly reason:string}[]; readonly rows: readonly ReimportRow[]; readonly materials: readonly ManagedMaterial[]; readonly missingIds: readonly string[]; readonly resumeBlocked: string | null }
export type ReimportChoice = { readonly itemId: string; readonly action: 'hold' } | { readonly itemId: string; readonly action: 'new' } | { readonly itemId: string; readonly action: 'map'; readonly materialId: string; readonly fields: readonly MaterialField[] };
export interface ReimportApply { readonly batchId: string; readonly choices: readonly ReimportChoice[]; readonly inactiveIds: readonly string[]; readonly confirmed: true }
export interface MasterApi {
  readonly get: (id: string | null) => Promise<ImportResult<MaterialForm>>;
  readonly save: (request: MaterialSave) => Promise<ImportResult<ManagedMaterial>>;
  /** 材料をまとめて削除する（1〜100件。すべて削除するか、何も削除しない）。元に戻せない。 */
  readonly delete: (ids: readonly string[]) => Promise<ImportResult<MaterialDeleteReceipt>>;
  readonly series: () => Promise<ImportResult<readonly { readonly id: string; readonly label: string }[]>>;
  readonly choose: (seriesId: string) => Promise<ImportResult<ReimportReview>>;
  readonly chooseFile: (seriesId: string, file: File) => Promise<ImportResult<ReimportReview>>;
  readonly list: () => Promise<ImportResult<readonly ImportSummary[]>>;
  readonly review: (batchId: string) => Promise<ImportResult<ReimportReview>>;
  readonly apply: (request: ReimportApply) => Promise<ImportResult<ReimportReview>>;
  readonly cancel: (batchId: string) => Promise<ImportResult<ReimportReview>>;
  readonly resume: (batchId: string) => Promise<ImportResult<ReimportReview>>;
}
