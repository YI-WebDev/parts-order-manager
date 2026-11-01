import type { AppApi } from '../shared/app-api';

declare global {
  interface Window {
    readonly appApi: AppApi;
  }
}
