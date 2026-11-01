import { mkdirSync } from 'node:fs';
import path from 'node:path';

export function evidencePath(name: string): string {
  const directory = process.env['POM_E2E_EVIDENCE'] ?? 'artifacts/e2e';
  // 証跡をJSONで直接書くテストが最初に動いても失敗しないよう、出力先を必ず作る（スクリーンショットだけはPlaywrightが自動で作る）。
  mkdirSync(directory, { recursive: true });
  return path.join(directory, name);
}
