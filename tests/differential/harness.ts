// 差分テストの共通部分: 台本（steps）を旧実装・新実装の両方で実行し、ID・時刻・作業フォルダーを置き換えて比べる。
import { appendFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { Request, Runner } from './runners';
import { rustRunner, tsRunner } from './runners';

export const baseline = process.env['POM_BASELINE'] ?? '';
export const harnessBinary = process.env['POM_HARNESS'] ?? path.resolve('src-tauri/target/debug/examples/harness');
// 旧実装を先に実行してから新実装を実行する（連番の識別子を同じ順に振るため、同時には動かさない）。

export interface Context { readonly root: string; readonly saved: Map<string, unknown> }
/** 台本の1手順。値の中の {root} は作業フォルダー、{$name.a.b} は保存した応答の値に置き換える。 */
export type Step = Request & { readonly save?: string; readonly files?: Readonly<Record<string, Buffer | string>>; readonly build?: (saved: Map<string, unknown>) => unknown[]; readonly expect?: 'ok' | 'error' | 'cancelled' | 'blocked' };

function lookup(saved: Map<string, unknown>, reference: string): unknown {
  const [name = '', ...keys] = reference.split('.');
  let value: unknown = saved.get(name);
  for (const key of keys) value = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  return value;
}
function resolve(value: unknown, context: Context): unknown {
  if (typeof value === 'string') {
    const whole = /^\{\$([^}]+)\}$/u.exec(value);
    if (whole?.[1]) return lookup(context.saved, whole[1]);
    return value.replaceAll('{root}', context.root).replace(/\{\$([^}]+)\}/gu, (_m, reference: string) => String(lookup(context.saved, reference)));
  }
  if (Array.isArray(value)) return value.map(item => resolve(item, context));
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, context)]));
  return value;
}

export async function run(runner: Runner, steps: readonly Step[], prefix: string): Promise<{ transcript: unknown[]; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const context: Context = { root, saved: new Map() };
  const transcript: unknown[] = [];
  for (const [index, step] of steps.entries()) {
    for (const [name, content] of Object.entries(step.files ?? {})) {
      const file = path.join(root, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    const { save, files: _files, build, expect: expected, ...request } = step; void _files;
    const resolved = resolve(build ? { ...request, args: build(context.saved) } : request, context) as Request;
    if (process.env['POM_DIFF_DEBUG']) appendFileSync(process.env['POM_DIFF_DEBUG'], `${prefix} ${index} ${JSON.stringify(resolved).slice(0, 300)}\n`);
    const response = await runner.send(resolved);
    if (save) context.saved.set(save, response['value'] ?? response);
    // 台本の前提（成功するはずの手順が成功していること）を旧実装で確かめる。
    const status = (response['value'] as { status?: unknown } | undefined)?.status;
    if (expected && status !== expected) throw new Error(`${prefix} 手順${index}（${String(request['channel'])}）は ${expected} のはずが ${JSON.stringify(response).slice(0, 400)}`);
    if (request.op !== 'dialog' && request.op !== 'release' && request.op !== 'trusted') transcript.push({ step: index, op: request.op, channel: request['channel'], response });
  }
  return { transcript, root };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/gu;

/** 実行ごとに変わる値（UUID・時刻・作業フォルダー）を出現順の名前へ置き換える。 */
export function normalizer(root: string) {
  const ids = new Map<string, string>();
  const text = (value: string): string => value
    .replaceAll(root, '<root>')
    .replace(UUID, id => { const key = id.toLowerCase(); if (!ids.has(key)) ids.set(key, `<id:${ids.size + 1}>`); return ids.get(key) ?? ''; })
    .replace(TIME, '<time>')
    .replace(/state:[0-9a-f]{64}/gu, 'state:<hash>');
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [text(key), visit((value as Record<string, unknown>)[key])]));
    return value;
  };
  return { visit, text, ids };
}

const require = createRequire(path.join(baseline || process.cwd(), 'package.json'));

/** DB の全表を、UUID を伏せた内容順に並べて取り出す（応答で付けた名前を引き継ぐ）。 */
export function dumpDatabase(file: string, normalize: ReturnType<typeof normalizer>): unknown {
  const platform = process.platform === 'win32' ? 'win32-x64' : 'linux-x64';
  const Database = require(`better-sqlite3/${platform}`) as new (file: string, options: { readonly: boolean; fileMustExist: boolean }) => { prepare(sql: string): { all(): unknown[] }; close(): void };
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const tables = ['categories', 'materials', 'documents', 'document_lines', 'import_batches', 'import_items', 'import_decisions', 'settings', 'material_create_receipts', 'schema_migrations'];
    const result: Record<string, unknown> = {};
    for (const table of tables) {
      // 移行後に足したもの（材料の削除の列 deleted_at と、それを足す4版の移行履歴）は旧版にないため外す。
      // 外す列は削除していない材料の空の値だけ（削除した材料があれば、違いとして残る）。並べる前に外し、並び順を両方でそろえる。
      const rows = (db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[])
        .filter(row => table !== 'schema_migrations' || Number(row['version']) <= 3)
        .map(row => { if (table !== 'materials' || row['deleted_at'] !== null) return row; const copy = { ...row }; delete copy['deleted_at']; return copy; });
      const masked = (row: Record<string, unknown>): string => JSON.stringify(row).replace(UUID, '<uuid>').replace(TIME, '<time>');
      const sorted = [...rows].sort((a, b) => masked(a).localeCompare(masked(b)));
      result[table] = sorted.map(row => {
        const copy = { ...row };
        // 請求書の識別子を含む値（作成要求の指紋・更新取込の版の指紋）は実行ごとに変わる。
        if (table === 'material_create_receipts' && typeof copy['request_hash'] === 'string') copy['request_hash'] = '<hash>';
        return normalize.visit(copy);
      });
    }
    return result;
  } finally { db.close(); }
}

export async function both(steps: readonly Step[]): Promise<{ ts: unknown; rust: unknown; tsRoot: string; rustRoot: string }> {
  if (!baseline) throw new Error('POM_BASELINE（旧実装の取得先）を指定してください。');
  const ts = tsRunner(baseline), rust = rustRunner(harnessBinary);
  try {
    const left = await run(ts, steps, 'pom-diff-ts-'), right = await run(rust, steps, 'pom-diff-rs-');
    return { ts: left.transcript, rust: right.transcript, tsRoot: left.root, rustRoot: right.root };
  } finally { await ts.close(); await rust.close(); }
}

export async function cleanup(...roots: string[]): Promise<void> {
  for (const root of roots) if (path.basename(root).startsWith('pom-diff-')) await rm(root, { recursive: true, force: true });
}

/**
 * 移行後に新実装の応答だけに足した項目（旧版にはないため突き合わせから外す）。missingIds: 更新取込でExcelに見当たらない材料。resumeBlocked: 再確認できない理由。
 * categoryTotal: 材料の画面（master:get）・材料検索の応答のカテゴリが全件でないことを示す総数（カテゴリ候補は materials:categories で検索・ページ取得する）。
 */
const ADDED_FIELDS = new Set(['missingIds', 'resumeBlocked', 'categoryTotal']);
function withoutAdded(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAdded);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !ADDED_FIELDS.has(key)).map(([key, item]) => [key, withoutAdded(item)]));
  return value;
}

/**
 * 移行後に変えた並び順（両方を同じ順にそろえてから突き合わせる。中身・件数はそのまま比べる）。
 * 材料の画面（master:get）のカテゴリ: 旧版は作成順（rowid）、新実装はカテゴリ候補のページ取得（materials:categories）と同じ並び順の値・ID 順。
 * ID の置き換え（normalizer）より前に名前順へ並べ、両方で同じ名前が振られるようにする。
 */
function withFormCategoriesByName(transcript: readonly unknown[]): unknown[] {
  return transcript.map(entry => {
    const step = entry as { channel?: unknown; response?: { value?: { data?: { categories?: unknown } } } };
    const categories = step.channel === 'master:get' ? step.response?.value?.data?.categories : undefined;
    if (!Array.isArray(categories)) return entry;
    const sorted = [...(categories as { name: string }[])].sort((a, b) => a.name.localeCompare(b.name));
    return { ...step, response: { ...step.response, value: { ...step.response?.value, data: { ...step.response?.value?.data, categories: sorted } } } };
  });
}

/**
 * 移行後に変えた値の形（利用者の指示、2026年10月15日）: 材料の6項目・請求書の明細と帳票上部の欄・取込の行の値は、前後の空白を除いて登録し、応答する。
 * 旧版は入力のまま残すため、両方の応答と DB の文字列の前後の空白を除いてから突き合わせる（文中の空白・改行の違いは残る）。
 */
export function withoutEdgeSpaces(value: unknown): unknown {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(withoutEdgeSpaces);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutEdgeSpaces(item)]));
  return value;
}

/** 両方の実行結果を正規化して返す（DB も比べる場合は shutdown の後に呼ぶ）。 */
export function compare(result: Awaited<ReturnType<typeof both>>, withDatabase = true): { ts: unknown; rust: unknown } {
  const left = normalizer(result.tsRoot), right = normalizer(result.rustRoot);
  const ts: Record<string, unknown> = { transcript: withoutEdgeSpaces(left.visit(withFormCategoriesByName(result.ts as unknown[]))) };
  const rust: Record<string, unknown> = { transcript: withoutEdgeSpaces(right.visit(withoutAdded(withFormCategoriesByName(result.rust as unknown[])))) };
  if (withDatabase) {
    ts['database'] = withoutEdgeSpaces(dumpDatabase(path.join(result.tsRoot, 'user', 'database', 'app.sqlite'), left));
    rust['database'] = withoutEdgeSpaces(dumpDatabase(path.join(result.rustRoot, 'user', 'database', 'app.sqlite'), right));
  }
  return { ts, rust };
}

export const init = (extra: Record<string, unknown> = {}): Step => ({ op: 'init', userData: '{root}/user', documents: '{root}/docs', appPath: '{root}/app', exeDir: '{root}/app', protected: ['{root}/user', '{root}/app', '{root}/app'], version: '0.1.0', ...extra });
export const invoke = (channel: string, args: unknown[] = [], save?: string): Step => save ? { op: 'invoke', channel, args, save } : { op: 'invoke', channel, args };
export const dialog = (value: unknown): Step => ({ op: 'dialog', value });
export const events: Step = { op: 'events' };
export const shutdown: Step = { op: 'shutdown' };
