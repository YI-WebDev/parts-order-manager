export const BACKUP_CHANNELS = { create: 'backups:create', inspect: 'backups:inspect', restore: 'backups:restore', status: 'backups:status' } as const;
export interface BackupInspection {
  readonly id: string;
  readonly createdAt: string;
  readonly materials: number;
  readonly documents: number;
}
export interface BackupStatus { readonly lastCreatedAt: string | null }
export type BackupResult<T> = { readonly status: 'ok'; readonly data: T } | { readonly status: 'cancelled' } | { readonly status: 'error'; readonly message: string };
export interface BackupApi {
  readonly create: () => Promise<BackupResult<string>>;
  readonly inspect: () => Promise<BackupResult<BackupInspection>>;
  readonly restore: (id: string) => Promise<BackupResult<null>>;
  readonly status: () => Promise<BackupResult<BackupStatus>>;
}
