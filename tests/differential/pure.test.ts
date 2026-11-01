// 関数単位の差分テスト: 乱数で作った入力（Excel の取込ファイル・出力内容・表示文字列）を旧実装と新実装に渡し、結果を比べる。
// 乱数は種を固定しているので、失敗した入力は同じ種で再現できる（POM_DIFF_SEED・POM_DIFF_CASES で変更可）。
import { deflateRawSync, crc32 } from 'node:zlib';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { baseline, harnessBinary } from './harness';
import { rustRunner } from './runners';
import type { Runner } from './runners';

type Module = Record<string, unknown>;
const load = async (file: string): Promise<Module> => await import(/* @vite-ignore */ path.join(baseline, 'src', file)) as Module;
const fn = <T extends (...args: never[]) => unknown>(module: Module, name: string): T => { const value = module[name]; if (typeof value !== 'function') throw new Error(name); return value as T; };

let rust: Runner;
beforeAll(() => { rust = rustRunner(harnessBinary); });
afterAll(async () => { await rust.close(); });
const pure = async (name: string, input: unknown): Promise<unknown> => (await rust.send({ op: 'pure', fn: name, input }))['value'];

// ---- 乱数 ----
const SEED = Number(process.env['POM_DIFF_SEED'] ?? 20261012), CASES = Number(process.env['POM_DIFF_CASES'] ?? 300);
function random(seed: number) {
  let state = seed >>> 0;
  const next = (): number => { state = (state + 0x6D2B79F5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (max: number): number => Math.floor(next() * max);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)] as T;
  const chance = (p: number): boolean => next() < p;
  return { next, int, pick, chance };
}
type Random = ReturnType<typeof random>;
const PIECES = ['架空', '部品', 'ﾀｲﾌﾟ', 'ＡＢＣ', 'abc', 'ABC', ' ', '　', '\t', '\n', '\r\n', '001', '-', '_', '%', '&', '<', '>', '"', "'", '⦿', '●', '𠮷', '😀', 'é', 'é', 'Σ', 'ß', 'İ', 'ﬁ', '①', '㈱', ' ', '​', '﻿', '_x0041_', '_x000D_', ']]>', '2026/9/13', '2024-02-29', '0', '1.5', '-0', '品名', '形式又はタイプ', 'メーカー', '数量', '備考', '単価'];
const text = (r: Random, max = 6): string => Array.from({ length: r.int(max) }, () => r.pick(PIECES)).join('');
const xml = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// ---- Excel（取込） ----
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const HEADERS = ['品名', '形式又はタイプ', 'メーカー', '数量', '備考', '単価'];
const COLUMNS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'P'];
const NUMBERS = ['0', '-0', '12', '-1234', '00012', '1.25', '1.24', '9.99', '999.95', '1234567.891', '1e3', '-.5', '12345678901234567890123', '0.5', ' 1', '1,000', 'abc', ''];
const FORMATS = ['General', '@', '0', '00000', '0.0', '0.00', '#,##0', '#,##0.00', '#,##0;[Red]#,##0', '#,##0;[RED]#,##0', '0%', 'yyyy/m/d', '0.000000000', '0000000000000000000'];
function workbook(r: Random): Buffer {
  // 半数は壊れた要素を含めない（正常に読める入力も十分に比べるため）。
  const noisy = r.chance(0.5), bad = (p: number): boolean => noisy && r.chance(p);
  const strings: string[] = [];
  const shared = (value: string): number => { strings.push(value); return strings.length - 1; };
  const numFmts = FORMATS.map((code, index) => `<numFmt numFmtId="${164 + index}" formatCode="${xml(code)}"/>`).join('');
  const xfs = Array.from({ length: 6 }, () => `<xf numFmtId="${r.chance(0.3) ? r.pick(['0', '1', '3', '49', '14']) : 164 + r.int(FORMATS.length)}"/>`).join('');
  const cell = (ref: string): string => {
    const style = r.chance(0.5) ? ` s="${bad(0.1) ? r.pick(['9', 'x', '', '-0', '1.0']) : r.int(6)}"` : '';
    const kind = r.int(10);
    if (kind < 3) return `<c r="${ref}"${style} t="inlineStr"><is>${r.chance(0.3) ? `<r><t>${xml(text(r))}</t></r><r><t xml:space="preserve">${xml(text(r))}</t></r>` : `<t xml:space="preserve">${xml(text(r))}</t>`}${r.chance(0.2) ? `<rPh sb="0" eb="1"><t>${xml(text(r, 2))}</t></rPh>` : ''}</is></c>`;
    if (kind < 5) return `<c r="${ref}"${style} t="s"><v>${bad(0.05) ? r.pick(['99', '-1', 'x', ' 0']) : shared(text(r))}</v></c>`;
    if (kind < 7) return `<c r="${ref}"${style}><v>${xml(r.pick(NUMBERS))}</v></c>`;
    if (kind < 8) return `<c r="${ref}"${style}${r.chance(0.5) ? ' t="str"' : ''}><f${r.chance(0.3) ? r.pick(bad(0.3) ? [' t="shared" si="0"', ' aca="maybe"'] : [' aca="false"', ' ca="1"', ' ca="true"']) : ''}>${xml(r.pick(['1+1', 'A1&B1', 'SUM(A1:A3)']))}</f><v>${xml(r.pick(NUMBERS))}</v></c>`;
    if (kind < 9) return `<c r="${ref}"${style} t="${r.pick(['b', 'e', 'd', 'str'])}"><v>${xml(r.pick(['1', '#N/A', '2026-01-01', 'x']))}</v></c>`;
    return `<c r="${ref}"${style}/>`;
  };
  const sheets = Array.from({ length: 1 + r.int(3) }, (_, index) => {
    const invoice = r.chance(0.15);
    const header = invoice ? `<row r="5">${['B', 'C', 'D', 'E', 'F'].map((column, i) => `<c r="${column}5" t="inlineStr"><is><t>${HEADERS[i]}</t></is></c>`).join('')}</row>`
      : `<row r="1">${['A', 'B', 'C', 'D', 'E', 'F', 'H', 'I', 'J', 'K', 'L', 'M'].map((column, i) => `<c r="${column}1" t="inlineStr"><is><t xml:space="preserve">${xml(bad(0.03) ? text(r, 2) : r.chance(0.2) ? ` ${HEADERS[i % 6] ?? ''}\u3000` : HEADERS[i % 6] ?? '')}</t></is></c>`).join('')}</row>`;
    const rows = [...new Set(Array.from({ length: r.int(12) }, () => 2 + r.int(30)))].sort((a, b) => a - b).map(row => {
      const cells = [...new Set(Array.from({ length: r.int(8) }, () => r.pick(COLUMNS)))].sort().map(column => cell(`${column}${row}`)).join('');
      return `<row r="${row}"${r.chance(0.1) ? ` hidden="${r.pick(['1', 'true', '0'])}"` : ''}>${cells}</row>`;
    }).join('');
    const extras = `${r.chance(0.1) ? '<cols><col min="2" max="2" hidden="1"/></cols>' : ''}`;
    const merge = r.chance(0.1) ? '<mergeCells count="1"><mergeCell ref="A2:B2"/></mergeCells>' : '';
    return { name: invoice ? '請求書' : `${text(r, 2) || 'シート'}${index}`, state: r.chance(0.1) ? r.pick(['hidden', 'veryHidden', 'visible']) : undefined, xml: `<worksheet xmlns="${NS}">${extras}<sheetData>${header}${rows}</sheetData>${merge}</worksheet>` };
  });
  const newline = r.chance(0.3) ? '\r\n' : '';
  const decl = r.chance(0.5) ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${newline}` : '';
  const parts: Record<string, string> = {
    '[Content_Types].xml': `${decl}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.${bad(0.05) ? 'macroEnabled' : 'main'}+xml"/></Types>`,
    'xl/workbook.xml': `${decl}<workbook xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, i) => `<sheet name="${xml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"${sheet.state ? ` state="${sheet.state}"` : ''}/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `${decl}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${bad(0.05) ? '../outside.xml' : r.chance(0.1) ? `/xl/worksheets/sheet${i + 1}.xml` : `worksheets/sheet${i + 1}.xml`}"/>`).join('')}</Relationships>`,
    'xl/styles.xml': `${decl}<styleSheet xmlns="${NS}"><numFmts count="${FORMATS.length}">${numFmts}</numFmts><cellXfs count="6">${xfs}</cellXfs></styleSheet>`,
    ...Object.fromEntries(sheets.map((sheet, i) => [`xl/worksheets/sheet${i + 1}.xml`, `${decl}${sheet.xml}`])),
    'xl/sharedStrings.xml': `${decl}<sst xmlns="${NS}">${strings.map(value => `<si>${r.chance(0.2) ? `<r><t>${xml(value)}</t></r>` : `<t xml:space="preserve">${xml(value)}</t>`}</si>`).join('')}</sst>`,
  };
  if (bad(0.05)) parts['xl/vbaProject.bin'] = 'x';
  const bytes = zip(parts, r, noisy);
  if (bad(0.15)) { const at = r.int(bytes.length); bytes[at] = (bytes[at] ?? 0) ^ (1 + r.int(255)); }
  return bytes;
}
function zip(parts: Readonly<Record<string, string>>, r: Random, noisy: boolean): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  const entries = Object.entries(parts);
  if (noisy && r.chance(0.05)) entries.push(entries[0] ?? ['x', 'y']);
  for (const [file, value] of entries) {
    const compress = r.chance(0.7), name = Buffer.from(file), raw = Buffer.from((r.chance(0.03) ? '﻿' : '') + value), data = compress ? deflateRawSync(raw) : raw;
    const flags = 0x800 | (noisy && r.chance(0.02) ? 1 : 0);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(flags, 6); header.writeUInt16LE(compress ? 8 : 0, 8); header.writeUInt32LE(crc32(raw), 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(raw.length, 22); header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(flags, 8); directory.writeUInt16LE(compress ? 8 : 0, 10); directory.writeUInt32LE(crc32(raw), 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(raw.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, name, data); central.push(directory, name); offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function errorOf(error: unknown): unknown {
  if (error && typeof error === 'object' && 'name' in error) {
    const named = error as { name: string; code?: string; message: string };
    if (named.name === 'ImportError') return { error: 'import', code: named.code, message: named.message };
    if (named.name === 'WorkbookError') return { error: 'workbook', code: named.code };
  }
  return { error: 'other' };
}
const comparable = (value: unknown): unknown => value && typeof value === 'object' && (value as { error?: unknown }).error === 'other' ? { error: 'other' } : value;
/**
 * 移行後に変えた値の形（利用者の指示、2026年10月15日）: 行の値 values は表示文字列の前後の空白を除いたもの（原セル rawCells は元のまま）。
 * 旧版の解析結果の values を同じ形にそろえてから比べる（分類は旧版も前後の空白を除いて判定していたため同じ）。
 */
function withTrimmedValues(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { items?: unknown }).items)) return parsed;
  const items = (parsed as { items: { values?: unknown }[] }).items.map(item => Array.isArray(item.values) ? { ...item, values: item.values.map(value => typeof value === 'string' ? value.trim() : value) } : item);
  return { ...parsed, items };
}

it('parses random workbooks the same way, including malformed and corrupted files', async () => {
  const { parseWorkbook } = await load('main/imports/workbook.ts') as { parseWorkbook: (bytes: Buffer) => Promise<unknown> };
  const r = random(SEED);
  let parsed = 0;
  for (let index = 0; index < CASES; index++) {
    const bytes = workbook(r);
    let expected: unknown;
    try { expected = withTrimmedValues(JSON.parse(JSON.stringify(await parseWorkbook(bytes)))); parsed++; } catch (error) { expected = errorOf(error); }
    const actual = comparable(await pure('parseWorkbook', { bytes: bytes.toString('base64') }));
    expect(actual, `ケース${index}（種 ${SEED}）`).toEqual(expected);
  }
  expect(parsed).toBeGreaterThan(CASES / 3);
  expect(parsed).toBeLessThan(CASES);
});

// ---- Excel 出力・印刷 ----
function model(r: Random): Record<string, unknown> {
  const mark = (): string => r.pick(['●', '○', '⦿']);
  return {
    documentId: '00000000-0000-4000-8000-000000000001', revision: 1 + r.int(5), templateVersion: r.chance(0.95) ? 'excel-v1' : 'excel-v0',
    header: { C2: text(r, 12), A4: text(r), B4: text(r), C4: text(r), E4: r.pick(['', '2026/9/13', '2024-02-29', '1900-02-28', '1900/3/1', '0001-01-01', '翌週', text(r, 2)]) },
    lines: Array.from({ length: r.chance(0.05) ? 48 : r.int(12) }, () => ({ name: r.chance(0.02) ? '\u0001' : text(r, r.chance(0.1) ? 60 : 6), model: text(r), manufacturer: text(r), quantity: r.pick(['1', '02 本', '-3', '']), remarks: text(r, 20), mark: mark() })),
  };
}

// 帳票の既定の揃え（利用者の指示、2026年10月15日）は旧版（左揃え・字下げ）と違うため、既定の書式（xl/styles.xml）と印刷HTMLは旧版と一致しない。
// 書式以外の部品（シート本体・ブック・部品構成）だけを比べる。印刷HTMLの突き合わせは対象外（印刷HTMLは print_html.rs・cell_format.rs のテストで確かめる）。
const withoutStyles = (parts: unknown): unknown => parts && typeof parts === 'object' && 'xl/styles.xml' in parts ? Object.fromEntries(Object.entries(parts).filter(([name]) => name !== 'xl/styles.xml')) : parts;

it('builds the same workbook parts except the default styles for random saved invoices', async () => {
  const { buildWorkbook } = await load('main/exports/workbook.ts') as { buildWorkbook: (model: unknown) => Buffer };
  const { workbookEnvelope } = await load('main/exports/envelope.ts') as { workbookEnvelope: (bytes: Buffer) => Promise<Map<string, Buffer>> };
  const r = random(SEED + 1);
  for (let index = 0; index < CASES; index++) {
    const value = model(r);
    let expected: unknown;
    try { expected = Object.fromEntries([...(await workbookEnvelope(buildWorkbook(value))).entries()].map(([name, bytes]) => [name, bytes.toString('utf8')])); } catch (error) { expected = errorOf(error); }
    expect(withoutStyles(comparable(await pure('buildWorkbook', value))), `ケース${index}`).toEqual(withoutStyles(expected));
  }
});

it('uses the same borders and workbook parts', async () => {
  const { borderPaths } = await load('shared/sheet-geometry.ts') as { borderPaths: { thin: string; double: string } };
  const { workbookXml } = await load('main/exports/workbook.ts') as { workbookXml: (legacy?: unknown) => string };
  expect(await pure('styles', {})).toMatchObject({ thin: borderPaths.thin, double: borderPaths.double, workbook: workbookXml(), legacy: [workbookXml({ manualCalc: true, printThroughH: true }), workbookXml({ printThroughH: true })] });
});

// ---- 表示文字列 ----
it('formats numbers like the old reader for random lexemes and formats', async () => {
  const cells = await load('main/imports/cells.ts');
  const readCell = fn<(node: unknown, strings: unknown[], styles: string[]) => { displayText: string; displayVerified: boolean }>(cells, 'readCell');
  const r = random(SEED + 2);
  const digits = (n: number): string => Array.from({ length: n }, () => String(r.int(10))).join('');
  for (let index = 0; index < CASES * 5; index++) {
    const raw = r.chance(0.7) ? `${r.chance(0.3) ? '-' : ''}${digits(1 + r.int(r.chance(0.1) ? 35 : 8))}${r.chance(0.5) ? `.${digits(1 + r.int(r.chance(0.1) ? 35 : 6))}` : ''}` : r.pick(NUMBERS);
    const format = r.chance(0.8) ? r.pick(FORMATS) : `${'0'.repeat(1 + r.int(17))}${r.chance(0.5) ? `.${'0'.repeat(1 + r.int(9))}` : ''}`;
    const node = { name: 'c', uri: NS, attrs: { s: '0' }, children: [{ name: 'v', uri: NS, attrs: {}, children: [], text: raw }], text: '' };
    const expected = readCell(node, [], [format]);
    expect(await pure('numericDisplay', { raw, format }), `${raw} ${format}`).toEqual({ text: expected.displayText, verified: expected.displayVerified });
  }
});

it('normalizes search text, headings and dates like JavaScript', async () => {
  const { validDateText } = await load('shared/date-text.ts') as { validDateText: (value: string) => boolean };
  const { dateValue } = await load('shared/invoice-sheet.ts') as { dateValue: (value: string) => unknown };
  const r = random(SEED + 3);
  const samples: string[] = [];
  for (let code = 0; code < 0x3100; code += 1 + (code < 0x500 ? 0 : 7)) samples.push(String.fromCodePoint(code) + 'A' + String.fromCodePoint(code));
  for (const code of [0x1e9e, 0x2126, 0x212a, 0x212b, 0xfb00, 0xff21, 0xff41, 0xffe5, 0x1d400, 0x1f600, 0x10400, 0x0130, 0x03a3, 0x0345]) samples.push(`a${String.fromCodePoint(code)}Σ ${String.fromCodePoint(code)}`);
  for (let index = 0; index < CASES; index++) samples.push(text(r, 10));
  for (const value of ['2026/9/13', '2026-9-13', '2024/02/29', '2023-02-29', '0000-01-01', '1900-02-28', '1900-03-01', '9999/12/31', '2026/9-13', '2026-13-01', ' 2026-01-01', '２０２６-01-01', '2026/1/1\n', '2026-001-01']) samples.push(value);
  for (const value of samples) {
    const searchText = [value, value, '', '', value].join(' ').normalize('NFKC').trim().toLocaleLowerCase('en-US');
    const expected = {
      normalize: value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim(), searchText,
      heading: value.normalize('NFKC').replace(/\s+/g, ''), validDate: validDateText(value), dateValue: dateValue(value) ?? null, trim: value.trim(),
    };
    expect(await pure('text', { value }), JSON.stringify(value)).toEqual(JSON.parse(JSON.stringify(expected)));
  }
});
