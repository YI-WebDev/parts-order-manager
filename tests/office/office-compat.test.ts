import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CellFormat, HeaderFormats, LineFormats } from '../../src/shared/cell-format';
import { numberCell, textCell, workbookParts, zipParts } from '../fixtures/xlsx';

// 実際の LibreOffice・Excel で、出力した請求書を開く・印刷する・値を読む、材料表を保存し直して取り込む。
// その環境にないアプリの分は飛ばす（LibreOffice は PATH か既定の場所、Excel は Windows の COM で探す）。
// 実行: pnpm test:office（Excel の生成・取込はアプリ本体の Rust 実装を、pom-core の examples/harness 経由で呼ぶ）

interface PrintModel {
  readonly documentId: string; readonly revision: number; readonly templateVersion: string; readonly header: Readonly<Record<'C2' | 'A4' | 'B4' | 'C4' | 'E4', string>>;
  readonly lines: readonly { readonly name: string; readonly model: string; readonly manufacturer: string; readonly quantity: string; readonly remarks: string; readonly mark: string; readonly formats?: LineFormats }[];
  readonly formats?: HeaderFormats;
}
const harness = process.env['POM_HARNESS'] ?? path.resolve('src-tauri/target/debug/examples', process.platform === 'win32' ? 'harness.exe' : 'harness');
/** Rust 実装の関数を呼ぶ（1要求1行の JSON）。 */
function core(fn: string, input: unknown): Record<string, unknown> {
  const result = spawnSync(harness, [], { input: `${JSON.stringify({ op: 'pure', fn, input })}\n`, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`harness failed: ${result.stderr}`);
  const response = JSON.parse(result.stdout.split('\n')[0] ?? '') as { value: Record<string, unknown> };
  if ('error' in response.value) throw new Error(`core error: ${JSON.stringify(response.value)}`);
  return response.value;
}
const buildWorkbook = (model: PrintModel): Buffer => Buffer.from(String(core('buildWorkbookBytes', model)['bytes']), 'base64');
const parseWorkbook = async (bytes: Buffer): Promise<{ counts: unknown; items: { block: string; rowIndex: number; classification: string; values: string[] }[] }> =>
  await Promise.resolve(core('parseWorkbook', { bytes: bytes.toString('base64') }) as never);

const header = { C2: '架空電気　架空様へ　　　　　　　（株）架空商事', A4: 'オーダー', B4: '2607-架空ING2D', C4: '2026. 07月分伝票にて', E4: '2026-06-22' };
const marks = ['●', '○', '⦿'] as const;
const invoice: PrintModel = {
  documentId: 'office-compat', revision: 1, templateVersion: 'excel-v1', header,
  lines: Array.from({ length: 47 }, (_, i) => i === 0
    ? { name: '=1+1', model: '+001', manufacturer: ' 架空製造 ', quantity: '0', remarks: '前半\n後半', mark: '●' }
    : { name: `架空材料${i + 1}`, model: `00${i}-A`, manufacturer: '架空製造', quantity: i % 2 ? String(i + 1) : `${i + 1} 本`, remarks: '', mark: marks[i % 3] ?? '●' }),
};
/** セルの書式を付けた請求書（帳票上部: 斜体・下線・14pt・赤字・淡い黄の塗りつぶし・上下中央、明細1: 品名の中央揃え・太字・上揃え、数量の右揃え）。 */
const center: CellFormat = { horizontal: 'center', vertical: 'top', bold: true };
const formatted: PrintModel = {
  ...invoice,
  formats: { C2: { vertical: 'center', italic: true, underline: true, size: 14, color: 'FF0000', fill: 'FFF2CC' } },
  lines: invoice.lines.map((line, index) => index === 0 ? { ...line, formats: { name: center, quantity: { horizontal: 'right' } } } : line),
};
/** 期待する表示文字列（セル番地 → Excel・LibreOffice で見える文字）。 */
const shown: Readonly<Record<string, string>> = {
  C2: header.C2, A4: 'オーダー', D4: '納期', E4: '6月22日', A5: 'チェック', B5: '品　　　名', F5: '備　考',
  A6: '●', B6: '=1+1', C6: '+001', D6: ' 架空製造 ', E6: '0', B7: '架空材料2', E7: '2', A8: '⦿', E8: '3 本', C55: '材料伝票共に納品⦿',
};

// 材料表（Excel が保存する形）: 書式付き数値（先頭ゼロ・桁区切り・赤字負数・小数）、文字の数量、改行、数式。
const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const materialStyles = `<styleSheet xmlns="${ns}"><numFmts count="3"><numFmt numFmtId="164" formatCode="00000"/><numFmt numFmtId="176" formatCode="#,##0;[Red]#,##0"/><numFmt numFmtId="177" formatCode="0.00"/></numFmts><fonts count="1"><font><sz val="11"/><name val="ＭＳ Ｐゴシック"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="176" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="177" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="標準" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
const materialRows = [
  `<row r="2">${textCell('A2', '配線ダクト')}${textCell('B2', 'ZZ-410W')}${textCell('C2', '架空化成')}${numberCell('D2', '2')}${numberCell('F2', '1200', 2)}${textCell('H2', '圧着端子')}${textCell('I2', 'R100-10')}${textCell('J2', '架空端子')}${numberCell('K2', '12', 1)}${textCell('L2', '100個入')}${numberCell('M2', '-350', 2)}</row>`,
  `<row r="3">${textCell('A3', '単線')}${textCell('B3', 'KIV 22sq 黒')}${textCell('C3', '架空電線')}${textCell('D3', '10m')}${textCell('E3', '前半\n後半')}${numberCell('F3', '12345', 3)}${textCell('H3', '絶縁キャップ')}${textCell('I3', '１００SQ　白色')}${textCell('J3', 'ニチフ')}<c r="K3" s="4" t="inlineStr"><is><t>007</t></is></c>${numberCell('M3', '1.5', 5)}</row>`,
  `<row r="4">${textCell('A4', '計算あり')}${textCell('B4', 'F-01')}<c r="D4"><f>1+1</f><v>2</v></c></row>`,
].join('');
const materialWorkbook = (): Buffer => zipParts({
  ...workbookParts(materialRows),
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
  'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  'xl/styles.xml': materialStyles,
}, true);
/** 取込結果のうち、保存したアプリによって変わってはいけない部分（分類・表示値・表示を確認できたか）。 */
async function importView(bytes: Buffer) {
  const parsed = await parseWorkbook(bytes);
  return { counts: parsed.counts, rows: parsed.items.map(item => ({ at: `${item.block}:${item.rowIndex}`, classification: item.classification, values: item.values })) };
}

const pdfPages = (file: string): number => (readFileSync(file).toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/gu) ?? []).length;
function csvRows(text: string): string[][] {
  const rows: string[][] = [[]]; let field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) { if (char === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (char === '"') quoted = false; else field += char; continue; }
    if (char === '"') quoted = true;
    else if (char === ',') { rows.at(-1)?.push(field); field = ''; }
    else if (char === '\n') { rows.at(-1)?.push(field); field = ''; rows.push([]); }
    else if (char !== '\r') field += char;
  }
  rows.at(-1)?.push(field);
  return rows;
}
const cellOf = (rows: string[][], ref: string): string => {
  const match = /^([A-Z])(\d+)$/u.exec(ref);
  return rows[Number(match?.[2] ?? 0) - 1]?.[(match?.[1] ?? 'A').charCodeAt(0) - 65] ?? '';
};

function findSoffice(): string | null {
  const candidates = process.platform === 'win32'
    ? [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']].filter((dir): dir is string => Boolean(dir)).flatMap(dir => [path.join(dir, 'LibreOffice', 'program', 'soffice.com'), path.join(dir, 'LibreOffice', 'program', 'soffice.exe')])
    : ['/usr/bin/soffice', '/usr/local/bin/soffice', '/opt/libreoffice/program/soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice'];
  return candidates.find(file => existsSync(file)) ?? null;
}
const soffice = findSoffice();
const excel = process.platform === 'win32' && spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$x = New-Object -ComObject Excel.Application; $x.Quit()'], { timeout: 60_000 }).status === 0;

let work = '';
beforeAll(() => { work = mkdtempSync(path.join(os.tmpdir(), 'office-compat-')); });
afterAll(() => { if (work && path.basename(work).startsWith('office-compat-')) rmSync(work, { recursive: true, force: true }); });

describe.skipIf(!soffice)('LibreOffice', () => {
  // 開いている LibreOffice と干渉しないよう、専用のユーザープロファイルで変換する。
  function convert(file: string, filter: string, outDir: string): void {
    const result = spawnSync(soffice ?? 'soffice', [`-env:UserInstallation=${pathToFileURL(path.join(work, 'lo-profile')).href}`, '--headless', '--convert-to', filter, '--outdir', outDir, file], { timeout: 180_000, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`LibreOffice conversion failed: ${result.stderr || result.stdout}`);
  }
  it('opens the exported invoice, shows the same text and prints it on one page', () => {
    const file = path.join(work, 'invoice.xlsx'); writeFileSync(file, buildWorkbook(invoice));
    convert(file, 'pdf', work);
    expect(pdfPages(path.join(work, 'invoice.pdf'))).toBe(1);
    convert(file, 'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,true', work);
    const rows = csvRows(readFileSync(path.join(work, 'invoice.csv'), 'utf8').replace(/^\uFEFF/u, ''));
    for (const [ref, value] of Object.entries(shown)) expect(cellOf(rows, ref), ref).toBe(value);
  });
  it('opens an invoice with cell formats, keeps the formats and prints it on one page', () => {
    const file = path.join(work, 'formatted.xlsx'); writeFileSync(file, buildWorkbook(formatted));
    convert(file, 'pdf', work);
    expect(pdfPages(path.join(work, 'formatted.pdf'))).toBe(1);
    convert(file, 'fods', work);
    const flat = readFileSync(path.join(work, 'formatted.fods'), 'utf8');
    for (const property of ['fo:font-weight="bold"', 'fo:font-style="italic"', 'style:text-underline-style="solid"', 'fo:font-size="14pt"', 'fo:color="#ff0000"', 'fo:background-color="#fff2cc"', 'style:vertical-align="top"', 'style:vertical-align="middle"', 'fo:text-align="end"']) {
      expect(flat, property).toContain(property);
    }
  });
  it('imports a material workbook saved by LibreOffice the same as the original', async () => {
    const source = path.join(work, 'material.xlsx'), outDir = path.join(work, 'lo-saved');
    writeFileSync(source, materialWorkbook());
    convert(source, 'xlsx:Calc MS Excel 2007 XML', outDir);
    expect(await importView(readFileSync(path.join(outDir, 'material.xlsx')))).toEqual(await importView(readFileSync(source)));
  });
});

describe.skipIf(!excel)('Excel (Windows)', () => {
  // Excel を COM で操作する。結果は UTF-8 の JSON ファイルで受け取る（コンソールの文字コードに左右されない）。
  function runExcel(script: string, env: Record<string, string>): unknown {
    const out = path.join(work, `excel-${Date.now()}.json`);
    const body = `$ErrorActionPreference = 'Stop'; $xl = New-Object -ComObject Excel.Application; $xl.Visible = $false; $xl.DisplayAlerts = $false
try { ${script} | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 -FilePath $env:OC_OUT } finally { $xl.Quit(); [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl) }`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', body], { timeout: 180_000, encoding: 'utf8', env: { ...process.env, ...env, OC_OUT: out } });
    if (result.status !== 0) throw new Error(`Excel automation failed: ${result.stderr || result.stdout}`);
    return JSON.parse(readFileSync(out, 'utf8').replace(/^\uFEFF/u, ''));
  }
  it('opens the exported invoice, shows the same text, keeps automatic calculation and prints it on one page', () => {
    const file = path.join(work, 'invoice-excel.xlsx'), pdf = path.join(work, 'invoice-excel.pdf'); writeFileSync(file, buildWorkbook(invoice));
    const refs = Object.keys(shown).join(',');
    const result = runExcel(`$wb = $xl.Workbooks.Open($env:OC_FILE, 0, $true); $ws = $wb.Worksheets.Item(1)
$texts = [ordered]@{}; foreach ($ref in $env:OC_REFS.Split(',')) { $texts[$ref] = $ws.Range($ref).Text }
$pages = $null; try { $pages = $ws.PageSetup.Pages.Count } catch { }
$wb.ExportAsFixedFormat(0, $env:OC_PDF)
$o = [ordered]@{ sheet = $ws.Name; calculation = $xl.Calculation; pages = $pages; texts = $texts }; $wb.Close($false); $o`, { OC_FILE: file, OC_PDF: pdf, OC_REFS: refs }) as { sheet: string; calculation: number; pages: number | null; texts: Record<string, string> };
    expect(result.sheet).toBe('請求書');
    expect(result.calculation).toBe(-4105); // xlCalculationAutomatic: 先に開いても他のブックを手動計算にしない
    for (const [ref, value] of Object.entries(shown)) expect(result.texts[ref], ref).toBe(value);
    expect(result.pages ?? pdfPages(pdf)).toBe(1);
  });
  it('opens an invoice with cell formats and keeps alignment, font and fill', () => {
    const file = path.join(work, 'formatted-excel.xlsx'); writeFileSync(file, buildWorkbook(formatted));
    const result = runExcel(`$wb = $xl.Workbooks.Open($env:OC_FILE, 0, $true); $ws = $wb.Worksheets.Item(1)
$c2 = $ws.Range('C2'); $b6 = $ws.Range('B6'); $e6 = $ws.Range('E6'); $b7 = $ws.Range('B7')
$o = [ordered]@{ c2 = @($c2.Font.Italic, $c2.Font.Underline, $c2.Font.Size, $c2.Font.Color, $c2.Interior.Color, $c2.VerticalAlignment); b6 = @($b6.HorizontalAlignment, $b6.VerticalAlignment, $b6.Font.Bold, $b6.IndentLevel); e6 = $e6.HorizontalAlignment; b7 = @($b7.HorizontalAlignment, $b7.Font.Bold, $b7.IndentLevel); pages = $ws.PageSetup.Pages.Count }
$wb.Close($false); $o`, { OC_FILE: file }) as { c2: unknown[]; b6: unknown[]; e6: number; b7: unknown[]; pages: number };
    // Excel の色は BGR の整数（赤 0x0000FF・淡い黄 0xCCF2FF）。配置は xlCenter -4108・xlTop -4160・xlRight -4152・xlLeft -4131、下線は xlUnderlineStyleSingle 2。
    expect(result.c2).toEqual([true, 2, 14, 0x0000ff, 0xccf2ff, -4108]);
    expect(result.b6).toEqual([-4108, -4160, true, 0]);
    expect(result.e6).toBe(-4152);
    expect(result.b7).toEqual([-4131, false, 1]);
    expect(result.pages).toBe(1);
  });
  it('imports a material workbook saved by Excel the same as the original', async () => {
    const source = path.join(work, 'material-src.xlsx'), saved = path.join(work, 'material-excel.xlsx');
    writeFileSync(source, materialWorkbook());
    runExcel('$wb = $xl.Workbooks.Open($env:OC_FILE); $wb.SaveAs($env:OC_SAVED, 51); $wb.Close($false); @{ saved = $true }', { OC_FILE: source, OC_SAVED: saved });
    expect(await importView(readFileSync(saved))).toEqual(await importView(readFileSync(source)));
  });
});

// どちらも無い環境で「全部通った」と誤解しないよう、確認した対象を記録に残す。
console.info(`office compatibility checked with: ${[soffice && `LibreOffice (${soffice})`, excel && 'Excel (COM)'].filter(Boolean).join(', ') || 'none (install LibreOffice or Excel to run the checks)'}`);
// POM_REQUIRE_OFFICE=1 では、LibreOffice（Windows では Excel も）が無いために上の確認が飛ばされることを失敗にする。
const missing = [soffice ? null : 'LibreOffice', process.platform === 'win32' && !excel ? 'Excel (COM)' : null].filter(Boolean);
it.runIf(process.env['POM_REQUIRE_OFFICE'] === '1')('has every office application that POM_REQUIRE_OFFICE demands', () => {
  expect(missing, '必要なアプリが見つからないため、互換性テストを飛ばせません').toEqual([]);
});
