import type { BackupApi } from './backup-api';
import type { MasterApi } from './master-api';
export const APP_INFO_CHANNEL = 'app:info';

export interface AppInfo {
  readonly recoveryNotice: string | null;
  readonly version: string;
  readonly userDataPath: string;
  readonly availableFeatures: readonly ('app-info' | 'initial-import' | 'material-search' | 'invoice-editor' | 'excel-export' | 'print-pdf' | 'material-management' | 'backup-restore')[];
}

export interface AppApi {
  readonly backups: BackupApi;
  readonly getInfo: () => Promise<AppInfo>;
  readonly imports: ImportApi;
  readonly master: MasterApi;
  readonly materials: MaterialSearchApi;
  readonly documents: DocumentApi;
  readonly exports: ExportApi;
  readonly printing: PrintApi;
}
import type { ImportApi } from './import-api';
import type { MaterialSearchApi } from './material-search-api';

import type { DocumentApi } from './document-api';

import type { ExportApi } from './export-api';

import type { PrintApi } from './print-api';
