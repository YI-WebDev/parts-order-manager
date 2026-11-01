// 旧実装（Electron の Main プロセス）と新実装（Rust）に同じ操作を順に送り、応答・ダイアログ・DB の内容が一致することを確かめる。
import { writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { both, cleanup, compare, dialog, events, init, invoke, shutdown } from './harness';
import type { Step } from './harness';
import { numberCell, syntheticWorkbook, textCell, workbookParts, zipParts } from '../fixtures/xlsx';
import type * as Crypto from 'node:crypto';

// 識別子を連番にする（新実装の harness も同じ順の連番）。同じ内容の材料の並びなど、識別子の大小で決まる順序をそろえる。
vi.mock('node:crypto', async original => {
  const actual = await original<typeof Crypto>();
  const shared = globalThis as typeof globalThis & { __pomUuid?: number };
  const randomUUID = (): string => { shared.__pomUuid = (shared.__pomUuid ?? 0) + 1; return `00000000-0000-4000-8000-${shared.__pomUuid.toString(16).padStart(12, '0')}`; };
  return { ...actual, randomUUID, default: { ...actual, randomUUID } };
});

async function check(steps: readonly Step[], withDatabase = true): Promise<void> {
  const result = await both(steps);
  try {
    const { ts, rust } = compare(result, withDatabase);
    if (process.env['POM_DIFF_DUMP']) writeFileSync(process.env['POM_DIFF_DUMP'], JSON.stringify({ ts, rust }, null, 1));
    expect(rust).toEqual(ts);
  } finally { await cleanup(result.tsRoot, result.rustRoot); }
}

type Saved = Map<string, unknown>;
type Json = Record<string, unknown>;
const at = (value: unknown, ...keys: (string | number)[]): unknown => keys.reduce<unknown>((current, key) => (current as Json | undefined)?.[key as string], value);
const data = (saved: Saved, name: string): Json => at(saved.get(name), 'data') as Json;
const items = (saved: Saved, name: string): Json[] => (at(saved.get(name), 'data', 'items') as Json[] | undefined) ?? [];
const candidates = (saved: Saved, name: string): string[] => items(saved, name).filter(item => item['classification'] === 'candidate' && !item['applied']).map(item => String(item['id']));
const held = (saved: Saved, name: string): string[] => items(saved, name).filter(item => item['classification'] === 'held').map(item => String(item['id']));
const step = (channel: string, build: (saved: Saved) => unknown[], options: { save?: string; expect?: NonNullable<Step['expect']> } = {}): Step => ({ op: 'invoke', channel, args: [], build, ...options });
const ok = (channel: string, args: unknown[] = [], save?: string): Step => ({ ...invoke(channel, args, save), expect: 'ok' });
const search = (query = '', includeInactive = false, save?: string): Step => ({ ...invoke('materials:search', [{ query, categoryId: null, includeInactive, offset: 0 }], save), expect: 'ok' });
const LINE_FIELDS = ['id', 'materialId', 'sourceItemId', 'name', 'model', 'manufacturer', 'quantity', 'remarks', 'deliveryState', 'markOutput', 'observedMark', 'ruleVersion'];
const line = (saved: Saved, name: string, changes: Json = {}): Json => ({ ...Object.fromEntries(LINE_FIELDS.map(field => [field, data(saved, name)[field]])), ...changes });
const header = (changes: Json = {}): Json => ({ C2: '架空宛先', A4: 'A', B4: 'B', C4: 'C', E4: '2026/9/13', ...changes });
const save = (session: string, requestNumber: number, expectedRevision: number, draft: (saved: Saved) => Json, options: { save?: string; expect?: NonNullable<Step['expect']> } = {}): Step =>
  step('documents:save', saved => [{ sessionId: data(saved, session)['sessionId'], requestNumber, generation: requestNumber, expectedRevision, draft: { templateVersion: 'excel-v1', ...draft(saved) } }], options);

const changedWorkbook = (): Buffer => zipParts(workbookParts(
  `<row r="2">${textCell('A2', ' 架空材料 ')}${textCell('B2', '001-A')}${textCell('D2', '03 本')}${numberCell('F2', '0')}${textCell('H2', '右の架空材料')}${textCell('I2', 'R-01')}${numberCell('K2', '12', 1)}</row>`
  + `<row r="5">${textCell('A5', '新しい架空材料')}${textCell('B5', 'N-01')}${textCell('C5', '新社')}</row>`), true);
const importAll = (name = 'first'): Step[] => [
  dialog('{root}/in/架空.xlsx'), { ...invoke('imports:choose', [], name), expect: 'ok' },
  step('imports:apply', saved => [{ batchId: data(saved, name)['batch'] && (data(saved, name)['batch'] as Json)['id'], acceptedIds: candidates(saved, name) }], { save: `${name}Applied`, expect: 'ok' }),
];

it('app info, sender checks, unknown channels and argument shapes', async () => {
  await check([
    init(), invoke('app:info'), invoke('app:info', [1]), invoke('missing:channel'),
    { op: 'trusted', value: false }, invoke('app:info'), invoke('materials:search', [{ query: '', categoryId: null, includeInactive: false, offset: 0 }]),
    invoke('documents:list', [0]), invoke('imports:list'), invoke('reimport:list'), invoke('backups:status'), invoke('documents:export-excel', [{ documentId: '00000000-0000-4000-8000-000000000000', revision: 1 }]),
    invoke('documents:print-preview', [{ documentId: '00000000-0000-4000-8000-000000000000', revision: 1 }]),
    { op: 'trusted', value: true },
    invoke('materials:search', []), invoke('materials:search', [{ query: '', categoryId: null, includeInactive: false, offset: 0, extra: 1 }]), invoke('materials:search', [{ query: 'x'.repeat(257), categoryId: null, includeInactive: false, offset: 0 }]),
    invoke('materials:search', [{ query: 'a\u0000', categoryId: null, includeInactive: false, offset: 0 }]), invoke('materials:search', [{ query: '', categoryId: 'bad', includeInactive: false, offset: 0 }]), invoke('materials:search', [{ query: '', categoryId: null, includeInactive: false, offset: 1.5 }]),
    invoke('materials:search', [{ query: '𠮷'.repeat(128), categoryId: null, includeInactive: false, offset: 0 }]), invoke('materials:search', [{ query: '𠮷'.repeat(129), categoryId: null, includeInactive: false, offset: 0 }]),
    invoke('documents:list', []), invoke('documents:list', [0, null]), invoke('documents:list', [-1]), invoke('documents:list', [0, 'x', 1]), invoke('documents:list', [100_001]), invoke('documents:open', [123]), invoke('documents:open', []),
    invoke('imports:review', ['bad']), invoke('imports:review', ['00000000-0000-4000-8000-000000000000']), invoke('imports:list', [1]), invoke('imports:cancel', ['00000000-0000-4000-8000-000000000000']),
    invoke('imports:apply', [{ batchId: '00000000-0000-4000-8000-000000000000', acceptedIds: [], extra: true }]), invoke('imports:choose-from-path', [123]), invoke('imports:choose-from-path', ['//server/share/a.xlsx']),
    invoke('master:get', [null]), invoke('master:get', ['00000000-0000-4000-8000-000000000000']), invoke('master:get', []), invoke('reimport:series'), invoke('reimport:review', ['00000000-0000-4000-8000-000000000000']),
    invoke('master:save', [{}]), invoke('master:save', [{ id: null, expectedRevision: 0, categoryId: null, newCategoryName: '', active: true, values: { name: '', model: '', manufacturer: '', quantity: '', remarks: '', unitPrice: '' } }]),
    invoke('reimport:apply', [{ batchId: 'bad' }]), invoke('reimport:choose-from-path', ['00000000-0000-4000-8000-000000000000', '/tmp/a.xlsx']),
    invoke('backups:status', [1]), invoke('backups:restore', ['00000000-0000-4000-8000-000000000000']), invoke('backups:restore', ['bad']), invoke('backups:create', [1]), invoke('backups:inspect', [1]),
    invoke('documents:export-excel', []), invoke('documents:export-excel', [{ documentId: 'bad', revision: 1 }]), invoke('documents:export-excel', [{ documentId: '00000000-0000-4000-8000-000000000000', revision: 1 }]),
    invoke('documents:close', ['00000000-0000-4000-8000-000000000000']), invoke('documents:add-line', [{ sessionId: '00000000-0000-4000-8000-000000000000', materialId: null }]),
    events, shutdown,
  ]);
});

it('initial import: cancel, choose, partial apply, resume, search and materials', async () => {
  await check([
    { ...init(), files: { 'in/架空.xlsx': syntheticWorkbook(), 'in/other.xlsx': changedWorkbook(), 'in/text.csv': 'a,b', 'in/bad.xlsx': 'not a zip' } },
    dialog(null), { ...invoke('imports:choose'), expect: 'cancelled' },
    dialog('{root}/in/bad.xlsx'), invoke('imports:choose'),
    dialog('{root}/in/架空.xlsx'), { ...invoke('imports:choose', [], 'first'), expect: 'ok' },
    dialog('{root}/in/架空.xlsx'), { ...invoke('imports:choose'), expect: 'ok' },
    ok('imports:list'), ok('imports:review', ['{$first.data.batch.id}']),
    invoke('imports:choose-from-path', ['{root}/in/other.xlsx']), invoke('imports:choose-from-path', ['relative.xlsx']), invoke('imports:choose-from-path', ['{root}/in/text.csv']),
    step('imports:apply', saved => [{ batchId: (data(saved, 'first')['batch'] as Json)['id'], acceptedIds: held(saved, 'first').slice(0, 1) }]),
    step('imports:apply', saved => [{ batchId: (data(saved, 'first')['batch'] as Json)['id'], acceptedIds: [candidates(saved, 'first')[0], candidates(saved, 'first')[0]] }]),
    step('imports:apply', saved => [{ batchId: (data(saved, 'first')['batch'] as Json)['id'], acceptedIds: ['00000000-0000-4000-8000-000000000000'] }]),
    step('imports:apply', saved => [{ batchId: (data(saved, 'first')['batch'] as Json)['id'], acceptedIds: candidates(saved, 'first').slice(0, 1) }], { save: 'applied', expect: 'ok' }),
    step('imports:apply', saved => [{ batchId: (data(saved, 'first')['batch'] as Json)['id'], acceptedIds: [] }], { expect: 'ok' }),
    { ...invoke('imports:resume', ['{$first.data.batch.id}'], 'resumed'), expect: 'ok' },
    { ...invoke('imports:resume', ['{$first.data.batch.id}']), expect: 'ok' },
    step('imports:apply', saved => [{ batchId: (data(saved, 'resumed')['batch'] as Json)['id'], acceptedIds: candidates(saved, 'resumed').slice(0, 2) }], { expect: 'ok' }),
    invoke('imports:resume', ['{$resumed.data.batch.id}'], 'again'),
    ok('imports:list'),
    { ...search('', false, 'search') },
    search('ＲＩＧＨＴ', true), search('架空材料'), search('%'), search('_'), search('  架空　材料  '),
    step('materials:search', saved => [{ query: '', categoryId: (at(saved.get('search'), 'data', 'categories', 0, 'id') as string), includeInactive: false, offset: 0 }], { expect: 'ok' }),
    step('master:get', saved => [at(saved.get('search'), 'data', 'rows', 0, 'id')], { expect: 'ok' }), { ...invoke('master:get', [null], 'form'), expect: 'ok' },
    step('master:save', saved => [{ createRequestId: data(saved, 'form')['createRequestId'], id: null, expectedRevision: 0, categoryId: null, newCategoryName: '手動カテゴリ', active: false, values: { name: '手動', model: 'M-1', manufacturer: '', quantity: '1', remarks: '', unitPrice: '' } }], { save: 'created', expect: 'ok' }),
    step('master:save', saved => [{ createRequestId: data(saved, 'form')['createRequestId'], id: null, expectedRevision: 0, categoryId: null, newCategoryName: '手動カテゴリ', active: false, values: { name: '手動', model: 'M-1', manufacturer: '', quantity: '1', remarks: '', unitPrice: '' } }], { expect: 'ok' }),
    step('master:save', saved => [{ createRequestId: data(saved, 'form')['createRequestId'], id: null, expectedRevision: 0, categoryId: null, newCategoryName: '手動カテゴリ', active: true, values: { name: '手動', model: 'M-1', manufacturer: '', quantity: '1', remarks: '', unitPrice: '' } }]),
    step('master:save', () => [{ createRequestId: '00000000-0000-4000-8000-000000000000', id: null, expectedRevision: 0, categoryId: null, newCategoryName: '失効', active: true, values: { name: '手動', model: '', manufacturer: '', quantity: '', remarks: '', unitPrice: '' } }]),
    step('master:save', saved => [{ id: data(saved, 'created')['id'], expectedRevision: 1, categoryId: data(saved, 'created')['categoryId'], newCategoryName: '', active: true, values: { name: '手動2', model: 'M-1', manufacturer: '', quantity: '1', remarks: '', unitPrice: '' } }]),
    step('master:save', saved => [{ id: data(saved, 'created')['id'], expectedRevision: 2, categoryId: data(saved, 'created')['categoryId'], newCategoryName: '', active: true, values: { name: '手動2', model: 'M-1', manufacturer: '', quantity: '1', remarks: '', unitPrice: '' } }], { expect: 'ok' }),
    step('master:save', saved => [{ id: data(saved, 'created')['id'], expectedRevision: 2, categoryId: data(saved, 'created')['categoryId'], newCategoryName: '', active: true, values: { name: '衝突', model: 'M-1', manufacturer: '', quantity: '1', remarks: '', unitPrice: '' } }]),
    step('master:save', saved => [{ id: data(saved, 'created')['id'], expectedRevision: 3, categoryId: data(saved, 'created')['categoryId'], newCategoryName: 'x', active: true, values: { name: '両方', model: '', manufacturer: '', quantity: '', remarks: '', unitPrice: '' } }]),
    step('master:save', saved => [{ createRequestId: data(saved, 'form')['createRequestId'], id: data(saved, 'created')['id'], expectedRevision: 3, categoryId: data(saved, 'created')['categoryId'], newCategoryName: '', active: true, values: { name: '要求付き', model: '', manufacturer: '', quantity: '', remarks: '', unitPrice: '' } }]),
    invoke('master:save', [{ id: null, expectedRevision: 0, categoryId: null, newCategoryName: ' ', active: true, values: { name: 'x', model: '', manufacturer: '', quantity: '', remarks: '', unitPrice: '' } }]),
    search('手動', true), ok('master:get', [null]),
    events, shutdown,
  ]);
});

it('invoice editing, history and Excel export with overwrite and blocking', async () => {
  await check([
    { ...init(), files: { 'in/架空.xlsx': syntheticWorkbook(), 'out/foreign.xlsx': 'FOREIGN', 'out/fake.xlsx': zipParts({ a: 'b' }) } },
    ...importAll(),
    search('', false, 'search'),
    { ...invoke('documents:open', [null], 'session'), expect: 'ok' },
    step('documents:add-line', saved => [{ sessionId: data(saved, 'session')['sessionId'], materialId: at(saved.get('search'), 'data', 'rows', 0, 'id') }], { save: 'line', expect: 'ok' }),
    step('documents:add-line', saved => [{ sessionId: data(saved, 'session')['sessionId'], materialId: null }], { save: 'blank', expect: 'ok' }),
    step('documents:add-line', saved => [{ sessionId: data(saved, 'session')['sessionId'], materialId: '00000000-0000-4000-8000-000000000000' }]),
    save('session', 1, 0, saved => ({ title: '架空請求書', header: header(), lines: [line(saved, 'line', { deliveryState: 'material_only', markOutput: 'filled_circle' })] }), { save: 'receipt', expect: 'ok' }),
    save('session', 1, 0, saved => ({ title: '架空請求書', header: header(), lines: [line(saved, 'line', { deliveryState: 'material_only', markOutput: 'filled_circle' })] }), { expect: 'ok' }),
    save('session', 1, 0, saved => ({ title: '別内容', header: header(), lines: [line(saved, 'line', { deliveryState: 'material_only', markOutput: 'filled_circle' })] })),
    save('session', 2, 1, saved => ({ title: '架空請求書2', header: header({ E4: '翌週' }), lines: [line(saved, 'line', { deliveryState: 'both', markOutput: 'unresolved' })] })),
    save('session', 2, 1, saved => ({ title: '架空請求書2', header: header({ E4: '翌週' }), lines: [line(saved, 'line', { materialId: null })] })),
    save('session', 2, 1, saved => ({ title: '架空請求書2', header: header({ E4: '翌週' }), lines: [line(saved, 'line'), line(saved, 'line')] })),
    // 移行後に変えた規則（利用者の指示、2026年10月16日）: チェックは任意の項目で、未選択の明細は出力を止めない（旧版は止める）。
    // 両方が同じ応答（一覧の確認の件数・出力を止めた理由）になるよう、止める理由は納期だけにする。
    save('session', 2, 1, saved => ({ title: '架空請求書2', header: header({ E4: '翌週' }), lines: [line(saved, 'line', { deliveryState: 'both', markOutput: 'both_mark' }), line(saved, 'blank', { deliveryState: 'slip_only', markOutput: 'open_circle' })] }), { save: 'second', expect: 'ok' }),
    ok('documents:list', [0]), ok('documents:list', [0, ' 架空宛 ']), ok('documents:list', [0, '_']), ok('documents:list', [0, '架空請求書2']), ok('documents:list', [1]),
    step('documents:export-excel', saved => [{ documentId: data(saved, 'second')['documentId'], revision: 2 }], { expect: 'blocked' }),
    step('documents:print-preview', saved => [{ documentId: data(saved, 'second')['documentId'], revision: 2 }], { expect: 'blocked' }),
    save('session', 3, 2, saved => ({ title: '架空請求書3', header: header({ A4: 'A&<>', E4: '2024/2/29' }), lines: [line(saved, 'line', { deliveryState: 'both', markOutput: 'both_mark' }), line(saved, 'blank', { name: '_x0041_\r改行\n', deliveryState: 'slip_only', markOutput: 'open_circle' })] }), { save: 'third', expect: 'ok' }),
    dialog(null), step('documents:export-excel', saved => [{ documentId: data(saved, 'third')['documentId'], revision: 3 }], { expect: 'cancelled' }),
    dialog('{root}/out/請求書.xlsx'), step('documents:export-excel', saved => [{ documentId: data(saved, 'third')['documentId'], revision: 3 }], { expect: 'ok' }),
    dialog('{root}/out/請求書.xlsx'), dialog(0), step('documents:export-excel', saved => [{ documentId: data(saved, 'third')['documentId'], revision: 3 }], { expect: 'cancelled' }),
    dialog('{root}/out/請求書.xlsx'), dialog(1), step('documents:export-excel', saved => [{ documentId: data(saved, 'third')['documentId'], revision: 3 }], { expect: 'ok' }),
    dialog('{root}/out/foreign.xlsx'), step('documents:export-excel', saved => [{ documentId: data(saved, 'third')['documentId'], revision: 3 }], { expect: 'error' }),
    dialog('{root}/out/fake.xlsx'), step('documents:export-excel', saved => [{ documentId: data(saved, 'third')['documentId'], revision: 3 }], { expect: 'error' }),
    dialog('{root}/out/no-extension'), step('documents:export-excel', saved => [{ documentId: data(saved, 'third')['documentId'], revision: 3 }], { expect: 'error' }),
    dialog('{root}/user/inside.xlsx'), step('documents:export-excel', saved => [{ documentId: data(saved, 'third')['documentId'], revision: 3 }], { expect: 'error' }),
    dialog('{root}/out/CON.xlsx'), step('documents:export-excel', saved => [{ documentId: data(saved, 'third')['documentId'], revision: 3 }]),
    dialog('{root}/out/trailing.xlsx '), step('documents:export-excel', saved => [{ documentId: data(saved, 'third')['documentId'], revision: 3 }]),
    dialog('{root}/missing/dir/a.xlsx'), step('documents:export-excel', saved => [{ documentId: data(saved, 'third')['documentId'], revision: 3 }], { expect: 'error' }),
    step('documents:export-excel', saved => [{ documentId: data(saved, 'third')['documentId'], revision: 2 }], { expect: 'error' }),
    step('documents:export-excel', saved => [{ documentId: data(saved, 'third')['documentId'], revision: 3, path: 'x' }], { expect: 'error' }),
    ok('documents:list', [0]),
    step('documents:duplicate', saved => [data(saved, 'third')['documentId']], { save: 'copy', expect: 'ok' }),
    step('documents:save', saved => [{ sessionId: data(saved, 'copy')['sessionId'], requestNumber: 1, generation: 1, expectedRevision: 0, draft: data(saved, 'copy')['draft'] }], { expect: 'ok' }),
    step('documents:open', saved => [data(saved, 'third')['documentId']], { expect: 'ok' }),
    step('documents:save', saved => [{ sessionId: data(saved, 'copy')['sessionId'], requestNumber: 2, generation: 2, expectedRevision: 1, draft: data(saved, 'copy')['draft'] }]),
    ok('documents:list', [0]),
    events, shutdown,
  ]);
});

it('backups: create, refuse overwrite, inspect, restore and recover on restart', async () => {
  await check([
    { ...init(), files: { 'in/架空.xlsx': syntheticWorkbook(), 'out/existing.pombak': 'x', 'out/broken.pombak': 'POMBAK01xxxxxxxx', 'out/short.pombak': 'POMB' } },
    ...importAll(),
    ok('backups:status'),
    dialog(null), { ...invoke('backups:create'), expect: 'cancelled' },
    dialog('{root}/out/existing.pombak'), { ...invoke('backups:create'), expect: 'error' },
    dialog('{root}/out/a.txt'), { ...invoke('backups:create'), expect: 'error' },
    dialog('{root}/user/a.pombak'), { ...invoke('backups:create'), expect: 'error' },
    dialog('{root}/out/new.pombak'), { ...invoke('backups:create'), expect: 'ok' },
    dialog(null), { ...invoke('backups:inspect'), expect: 'cancelled' },
    dialog('{root}/out/broken.pombak'), { ...invoke('backups:inspect'), expect: 'error' },
    dialog('{root}/out/short.pombak'), { ...invoke('backups:inspect'), expect: 'error' },
    dialog('{root}/out/new.pombak'), { ...invoke('backups:inspect', [], 'inspected'), expect: 'ok' },
    search('', false, 'search'),
    step('master:get', saved => [at(saved.get('search'), 'data', 'rows', 0, 'id')], { save: 'm', expect: 'ok' }),
    step('master:save', saved => { const m = data(saved, 'm')['material'] as Json; return [{ id: m['id'], expectedRevision: 1, categoryId: m['categoryId'], newCategoryName: '', active: true, values: { name: '復元前の変更', model: 'x', manufacturer: '', quantity: '', remarks: '', unitPrice: '' } }]; }, { expect: 'ok' }),
    dialog(0), { ...invoke('backups:restore', ['{$inspected.data.id}']), expect: 'cancelled' },
    dialog(1), dialog(0), { ...invoke('backups:restore', ['{$inspected.data.id}']), expect: 'ok' },
    invoke('backups:restore', ['{$inspected.data.id}']),
    invoke('materials:search', [{ query: '', categoryId: null, includeInactive: false, offset: 0 }]),
    events, shutdown,
    init(), invoke('app:info'), search(''), ok('backups:status'),
    events, shutdown,
  ]);
});

it('reimport: series, changed workbook, apply errors, cancel, stale and resume', async () => {
  await check([
    { ...init(), files: { 'in/架空.xlsx': syntheticWorkbook(), 'in/変更.xlsx': changedWorkbook() } },
    ...importAll(),
    { ...invoke('reimport:series', [], 'series'), expect: 'ok' },
    invoke('reimport:choose', ['00000000-0000-4000-8000-000000000000']),
    dialog(null), step('reimport:choose', saved => [at(saved.get('series'), 'data', 0, 'id')], { expect: 'cancelled' }),
    dialog('{root}/in/変更.xlsx'), step('reimport:choose', saved => [at(saved.get('series'), 'data', 0, 'id')], { save: 'stage', expect: 'ok' }),
    dialog('{root}/in/変更.xlsx'), step('reimport:choose', saved => [at(saved.get('series'), 'data', 0, 'id')], { expect: 'ok' }),
    ok('reimport:list'),
    step('reimport:apply', saved => [{ batchId: (data(saved, 'stage')['batch'] as Json)['id'], choices: [], inactiveIds: [], confirmed: true }]),
    step('reimport:apply', saved => [{ batchId: (data(saved, 'stage')['batch'] as Json)['id'], choices: [], inactiveIds: [], confirmed: false }]),
    step('reimport:apply', saved => [{ batchId: (data(saved, 'stage')['batch'] as Json)['id'], choices: [{ itemId: '00000000-0000-4000-8000-000000000000', action: 'drop' }], inactiveIds: [], confirmed: true }]),
    { ...invoke('reimport:cancel', ['{$stage.data.batch.id}']), expect: 'ok' },
    { ...invoke('reimport:resume', ['{$stage.data.batch.id}'], 'resumed'), expect: 'ok' },
    { ...invoke('reimport:review', ['{$resumed.data.batch.id}']), expect: 'ok' },
    invoke('imports:resume', ['{$first.data.batch.id}']),
    ok('imports:review', ['{$first.data.batch.id}']),
    invoke('imports:resume', ['{$first.data.batch.id}']),
    ok('reimport:series'), ok('reimport:list'), ok('imports:list'),
    events, shutdown,
  ]);
});

it('reimport apply with map, new, hold and inactivation, then a second round', async () => {
  const rows = (saved: Saved, name: string): Json[] => (at(saved.get(name), 'data', 'rows') as Json[] | undefined) ?? [];
  const choices = (saved: Saved, name: string): Json[] => {
    const used = new Set<string>();
    return rows(saved, name).map((row, index) => {
      const source = row['source'] as Json, itemId = source['id'];
      if (source['classification'] !== 'candidate') return { itemId, action: 'hold' };
      const suggested = (row['suggestedIds'] as string[]).find(id => !used.has(id));
      if (suggested && index % 2 === 0) { used.add(suggested); return { itemId, action: 'map', materialId: suggested, fields: ['quantity', 'name'] }; }
      return index % 3 === 0 ? { itemId, action: 'hold' } : { itemId, action: 'new' };
    });
  };
  const unmapped = (saved: Saved, name: string): string[] => {
    const mapped = new Set(choices(saved, name).flatMap(choice => choice['action'] === 'map' ? [String(choice['materialId'])] : []));
    return ((at(saved.get(name), 'data', 'materials') as Json[] | undefined) ?? []).map(m => String(m['id'])).filter(id => !mapped.has(id)).slice(0, 1);
  };
  await check([
    { ...init(), files: { 'in/架空.xlsx': syntheticWorkbook(), 'in/変更.xlsx': changedWorkbook(), 'in/元に戻す.xlsx': syntheticWorkbook() } },
    ...importAll(),
    { ...invoke('reimport:series', [], 'series'), expect: 'ok' },
    dialog('{root}/in/変更.xlsx'), step('reimport:choose', saved => [at(saved.get('series'), 'data', 0, 'id')], { save: 'stage', expect: 'ok' }),
    step('reimport:apply', saved => [{ batchId: (data(saved, 'stage')['batch'] as Json)['id'], confirmed: true, inactiveIds: unmapped(saved, 'stage'), choices: choices(saved, 'stage') }], { save: 'applied', expect: 'ok' }),
    step('reimport:apply', saved => [{ batchId: (data(saved, 'stage')['batch'] as Json)['id'], confirmed: true, inactiveIds: [], choices: [] }], { expect: 'ok' }),
    ok('reimport:review', ['{$stage.data.batch.id}']),
    search('', true), ok('reimport:series'),
    dialog('{root}/in/元に戻す.xlsx'), step('reimport:choose', saved => [at(saved.get('series'), 'data', 0, 'id')], { save: 'stage2', expect: 'ok' }),
    step('reimport:apply', saved => [{ batchId: (data(saved, 'stage2')['batch'] as Json)['id'], confirmed: true, inactiveIds: [], choices: choices(saved, 'stage2') }]),
    search('', true), ok('reimport:list'),
    events, shutdown,
  ]);
});

it('close confirmation tokens', async () => {
  await check([
    init(), { op: 'close' }, events, { op: 'close' }, events,
    invoke('documents:close', ['00000000-0000-4000-8000-000000000000']),
    invoke('documents:close', ['bad']),
    events, shutdown,
  ], false);
});

it('pending dialogs keep other requests working and reject duplicates', async () => {
  await check([
    { ...init(), files: { 'in/架空.xlsx': syntheticWorkbook() } },
    { ...invoke('documents:open', [null], 'session'), expect: 'ok' },
    save('session', 1, 0, () => ({ title: '競合', header: header(), lines: [] }), { save: 'receipt', expect: 'ok' }),
    dialog({ hold: 'export', value: '{root}/conflict.xlsx' }), { op: 'start', id: 'export', channel: 'documents:export-excel', args: [{ documentId: '{$receipt.data.documentId}', revision: 1 }] },
    step('documents:export-excel', saved => [{ documentId: data(saved, 'receipt')['documentId'], revision: 1 }], { expect: 'error' }),
    ok('documents:list', [0]),
    { ...invoke('backups:create'), expect: 'error' },
    save('session', 2, 1, () => ({ title: '競合後', header: header(), lines: [] }), { expect: 'ok' }),
    { op: 'release', name: 'export' }, { op: 'await', id: 'export' },
    dialog({ hold: 'pick', value: null }), { op: 'start', id: 'pick', channel: 'imports:choose', args: [] },
    { ...invoke('imports:choose'), expect: 'error' },
    { ...invoke('imports:choose-from-path', ['{root}/in/架空.xlsx']), expect: 'error' },
    { ...invoke('backups:inspect'), expect: 'cancelled' },
    { op: 'release', name: 'pick' }, { op: 'await', id: 'pick' },
    ok('backups:status'),
    events, shutdown,
  ], false);
});
