import type { ExportIssue, ExportRequest } from './export-api';
export const PRINT_CHANNEL = 'documents:print-preview';
export type PrintResult = { readonly status: 'closed' } | { readonly status: 'blocked'; readonly issues: readonly ExportIssue[] } | { readonly status: 'error'; readonly message: string };
export interface PrintApi { readonly preview: (request: ExportRequest) => Promise<PrintResult> }
