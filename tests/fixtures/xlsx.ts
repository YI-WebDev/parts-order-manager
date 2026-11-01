import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

export function zipParts(parts: Readonly<Record<string, string>>, compress = false): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [file, value] of Object.entries(parts)) {
    const name = Buffer.from(file), raw = Buffer.from(value), data = compress ? deflateRawSync(raw) : raw;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(compress ? 8 : 0, 8); header.writeUInt32LE(crc32(raw), 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(raw.length, 22); header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(compress ? 8 : 0, 10); directory.writeUInt32LE(crc32(raw), 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(raw.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, name, data); central.push(directory, name); offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(parts).length, 8); end.writeUInt16LE(Object.keys(parts).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
export const escapeXml = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export const textCell = (ref: string, text: string): string => `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
export const numberCell = (ref: string, value: string, style = 0): string => `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
export const headers = ['品名', '形式又はタイプ', 'メーカー', '数量', '備考', '単価'];
export const headerRow = (): string => `<row r="1">${['A','B','C','D','E','F','H','I','J','K','L','M'].map((col, i) => textCell(`${col}1`, headers[i % 6] ?? '')).join('')}</row>`;
export function workbookParts(rows: string, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  return {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="架空材料" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/styles.xml': `<styleSheet xmlns="${ns}"><numFmts count="2"><numFmt numFmtId="164" formatCode="00000"/><numFmt numFmtId="176" formatCode="#,##0;[Red]#,##0"/></numFmts><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="176"/><xf numFmtId="56"/></cellXfs></styleSheet>`,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="${ns}"><sheetData>${headerRow()}${rows}</sheetData></worksheet>`, ...extra,
  };
}
export function syntheticWorkbook(): Buffer {
  const row = (n: number): string => `<row r="${n}">${textCell(`A${n}`, ' 架空材料 ')}${textCell(`B${n}`, '001-A')}${textCell(`D${n}`, '02 本')}${numberCell(`F${n}`, '0')}${textCell(`H${n}`, '右の架空材料')}${textCell(`I${n}`, 'R-01')}${numberCell(`K${n}`, '12', 1)}</row>`;
  return zipParts(workbookParts(row(2) + `<row r="3">${textCell('C3', '架空注記')}${textCell('G3', '架空の未確定補足')}</row>` + row(5)), true);
}
/**
 * zipParts で作った ZIP の部品 name の中央ディレクトリ項目で、圧縮後サイズを ZIP64 拡張情報の値 compressedSize に置き換える
 * （32bit 欄を 0xFFFFFFFF にして拡張情報を足し、終端記録の中央ディレクトリの大きさも直す。src-tauri/core/tests/import_support の with_zip64 と同じ形）。
 */
export function withZip64CompressedSize(bytes: Buffer, name: string, compressedSize: bigint): Buffer {
  const end = bytes.length - 22, start = bytes.readUInt32LE(end + 16), entries: Buffer[] = [];
  let at = start, found = false;
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    const nameLength = bytes.readUInt16LE(at + 28), extraLength = bytes.readUInt16LE(at + 30), length = 46 + nameLength + extraLength + bytes.readUInt16LE(at + 32);
    let entry = Buffer.from(bytes.subarray(at, at + length));
    if (entry.subarray(46, 46 + nameLength).toString() === name) {
      found = true;
      const extra = Buffer.alloc(12); extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(8, 2); extra.writeBigUInt64LE(compressedSize, 4);
      entry.writeUInt32LE(0xffffffff, 20); entry.writeUInt16LE(extraLength + extra.length, 30);
      entry = Buffer.concat([entry.subarray(0, 46 + nameLength + extraLength), extra, entry.subarray(46 + nameLength + extraLength)]);
    }
    entries.push(entry); at += length;
  }
  if (!found) throw new Error(`missing entry ${name}`);
  const central = Buffer.concat(entries), record = Buffer.from(bytes.subarray(end)); record.writeUInt32LE(central.length, 12);
  return Buffer.concat([bytes.subarray(0, start), central, record]);
}

/** 出力したxlsx（ZIP）の全パートを読む。旧版は yauzl を使っていたが、依存から外れたため中央ディレクトリを直接たどる（無圧縮・deflate のみ。CRC と大きさも確かめる）。 */
export async function allXml(bytes: Buffer): Promise<ReadonlyMap<string, string>> {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > bytes.length) throw new Error('Missing ZIP end of central directory');
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const parts = new Map<string, string>();
  for (let index = 0; index < count; index++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Broken ZIP central directory');
    const method = bytes.readUInt16LE(offset + 10), crc = bytes.readUInt32LE(offset + 16), compressedSize = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32), local = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (bytes.readUInt32LE(local) !== 0x04034b50) throw new Error(`Broken ZIP local header: ${name}`);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const stored = bytes.subarray(start, start + compressedSize);
    const data = method === 0 ? stored : method === 8 ? inflateRawSync(stored) : null;
    if (!data) throw new Error(`Unsupported ZIP method ${method}: ${name}`);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`Broken ZIP entry: ${name}`);
    if (parts.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`);
    parts.set(name, data.toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return parts;
}
