//! ZIP の読み書き。読込は旧実装が使っていた yauzl 3.4.0（strictFileNames・validateEntrySizes）と同じ検査を同じ順で行い、
//! 書込は出力用の決まった形（UTF-8 名・deflate・日時 1980-01-01）だけを作る。

/// 読込の失敗。`Open` はブック全体の構造（中央ディレクトリの終端）を読めない場合で、旧実装では呼び出し側の分類を経ずに伝わっていた。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ZipError { Open(String), Entry(String) }

impl ZipError {
    pub fn message(&self) -> &str { match self { ZipError::Open(m) | ZipError::Entry(m) => m } }
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub file_name: String,
    pub general_purpose_bit_flag: u16,
    pub compression_method: u16,
    pub crc32: u32,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
    pub external_file_attributes: u32,
    pub relative_offset_of_local_header: u64,
}

impl Entry {
    pub fn is_encrypted(&self) -> bool { self.general_purpose_bit_flag & 1 != 0 }
}

pub struct Archive<'a> {
    bytes: &'a [u8],
    cursor: u64,
    entry_count: u64,
    entries_read: u64,
    failed: bool,
}

fn u16_at(b: &[u8], at: usize) -> u16 { u16::from_le_bytes([b[at], b[at + 1]]) }
fn u32_at(b: &[u8], at: usize) -> u32 { u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]]) }
fn u64_at(b: &[u8], at: usize) -> u64 {
    // yauzl の readUInt64LE は上位 32bit を 0x100000000 倍して足す（Number の精度内）。
    u32_at(b, at) as u64 + (u32_at(b, at + 4) as u64) * 0x1_0000_0000
}

impl<'a> Archive<'a> {
    /// 範囲 [position, position + length) の内容。ファイルの外・桁あふれは Err（長さ 0 でも末尾より先の位置は Err）。
    fn read(&self, position: u64, length: usize) -> Result<&'a [u8], String> {
        let start = usize::try_from(position).map_err(|_| "unexpected EOF".to_string())?;
        let end = start.checked_add(length).ok_or("unexpected EOF")?;
        self.bytes.get(start..end).ok_or_else(|| "unexpected EOF".into())
    }

    /// yauzl の fromBuffer（中央ディレクトリの終端の検索）。
    pub fn open(bytes: &'a [u8]) -> Result<Self, ZipError> {
        const EOCDR: usize = 22;
        const LOCATOR: usize = 20;
        let total = bytes.len();
        let buffer_size = (LOCATOR + EOCDR + 0xffff).min(total);
        let buffer = &bytes[total - buffer_size..];
        if buffer_size < EOCDR { return Err(ZipError::Open("End of central directory record signature not found.".into())); }
        let mut i = buffer_size - EOCDR;
        loop {
            if u32_at(buffer, i) == 0x0605_4b50 {
                let eocdr = &buffer[i..];
                let mut disk_number = u16_at(eocdr, 4) as u32;
                let mut entry_count = u16_at(eocdr, 10) as u64;
                let mut central_directory_offset = u32_at(eocdr, 16) as u64;
                let comment_length = u16_at(eocdr, 20) as usize;
                if comment_length != eocdr.len() - EOCDR { return Err(ZipError::Open("Invalid comment length.".into())); }
                if i >= LOCATOR && u32_at(buffer, i - LOCATOR) == 0x0706_4b50 {
                    let locator = &buffer[i - LOCATOR..i];
                    let record_offset = u64_at(locator, 8);
                    let archive = Archive { bytes, cursor: 0, entry_count: 0, entries_read: 0, failed: false };
                    let record = archive.read(record_offset, 56).map_err(ZipError::Open)?;
                    if u32_at(record, 0) != 0x0606_4b50 { return Err(ZipError::Open("invalid zip64 end of central directory record signature".into())); }
                    disk_number = u32_at(record, 16);
                    if disk_number != 0 { return Err(ZipError::Open("multi-disk zip files are not supported".into())); }
                    entry_count = u64_at(record, 32);
                    central_directory_offset = u64_at(record, 48);
                    return Ok(Archive { bytes, cursor: central_directory_offset, entry_count, entries_read: 0, failed: false });
                }
                if disk_number != 0 { return Err(ZipError::Open("multi-disk zip files are not supported".into())); }
                return Ok(Archive { bytes, cursor: central_directory_offset, entry_count, entries_read: 0, failed: false });
            }
            if i == 0 { break; }
            i -= 1;
        }
        Err(ZipError::Open("End of central directory record signature not found. Either not a zip file, or file is truncated.".into()))
    }

    /// 次の中央ディレクトリ項目。全項目を読み終えたら None。
    pub fn next_entry(&mut self) -> Option<Result<Entry, ZipError>> {
        if self.failed { return None; }
        if self.entries_read == self.entry_count { return None; }
        let result = self.read_entry();
        if result.is_err() { self.failed = true; }
        Some(result.map_err(ZipError::Entry))
    }

    fn read_entry(&mut self) -> Result<Entry, String> {
        let header = self.read(self.cursor, 46)?;
        let signature = u32_at(header, 0);
        if signature != 0x0201_4b50 { return Err(format!("invalid central directory file header signature: 0x{signature:x}")); }
        let general_purpose_bit_flag = u16_at(header, 8);
        let compression_method = u16_at(header, 10);
        let crc32 = u32_at(header, 16);
        let mut compressed_size = u32_at(header, 20) as u64;
        let mut uncompressed_size = u32_at(header, 24) as u64;
        let file_name_length = u16_at(header, 28) as usize;
        let extra_field_length = u16_at(header, 30) as usize;
        let file_comment_length = u16_at(header, 32) as usize;
        let external_file_attributes = u32_at(header, 38);
        let mut relative_offset_of_local_header = u32_at(header, 42) as u64;
        if general_purpose_bit_flag & 0x40 != 0 { return Err("strong encryption is not supported".into()); }
        // 位置の加算は read が範囲を確かめた後だが、ZIP64 の値（64bit 全体を取り得る）と同じく桁あふれを確かめる。
        self.cursor = self.cursor.checked_add(46).ok_or("unexpected EOF")?;
        let variable = self.read(self.cursor, file_name_length + extra_field_length + file_comment_length)?;
        let file_name_raw = &variable[..file_name_length];
        let extra_raw = &variable[file_name_length..file_name_length + extra_field_length];
        let extra_fields = parse_extra_fields(extra_raw)?;
        let file_name = file_name(general_purpose_bit_flag, file_name_raw, &extra_fields);
        validate_file_name(&file_name)?;
        self.cursor = self.cursor.checked_add(variable.len() as u64).ok_or("unexpected EOF")?;
        self.entries_read += 1;
        if let Some((_, data)) = extra_fields.iter().find(|(id, _)| *id == 0x0001) {
            let mut index = 0;
            if uncompressed_size == 0xffff_ffff {
                if index + 8 > data.len() { return Err("zip64 extended information extra field does not include uncompressed size".into()); }
                uncompressed_size = u64_at(data, index); index += 8;
            }
            if compressed_size == 0xffff_ffff {
                if index + 8 > data.len() { return Err("zip64 extended information extra field does not include compressed size".into()); }
                compressed_size = u64_at(data, index); index += 8;
            }
            if relative_offset_of_local_header == 0xffff_ffff {
                if index + 8 > data.len() { return Err("zip64 extended information extra field does not include relative header offset".into()); }
                relative_offset_of_local_header = u64_at(data, index);
            }
        }
        let entry = Entry { file_name, general_purpose_bit_flag, compression_method, crc32, compressed_size, uncompressed_size, external_file_attributes, relative_offset_of_local_header };
        if compression_method == 0 {
            // 暗号化ヘッダーの 12 バイトを足すと u64 を超える値は、どの圧縮後サイズとも一致しない（桁あふれで一致させない）。
            let expected = uncompressed_size.checked_add(if entry.is_encrypted() { 12 } else { 0 });
            if expected != Some(compressed_size) { return Err("compressed/uncompressed size mismatch for stored file".into()); }
        }
        Ok(entry)
    }

    /// 項目の内容（yauzl の openReadStream ＋ validateEntrySizes）。
    pub fn read_entry_data(&self, entry: &Entry) -> Result<Vec<u8>, ZipError> {
        let fail = |m: &str| ZipError::Entry(m.to_string());
        let raw = entry.compression_method == 0 && !entry.is_encrypted();
        if entry.is_encrypted() && !raw { return Err(fail("entry is encrypted")); }
        if !raw && entry.compression_method != 8 { return Err(fail("unsupported compression method")); }
        let local = self.read(entry.relative_offset_of_local_header, 30).map_err(ZipError::Entry)?;
        if u32_at(local, 0) != 0x0403_4b50 { return Err(fail("invalid local file header signature")); }
        let data = self.entry_bytes(entry, local).ok_or_else(|| fail("file data overflows file bounds"))?;
        if raw { return Ok(data.to_vec()); }
        let limit = usize::try_from(entry.uncompressed_size).unwrap_or(usize::MAX);
        let inflated = miniz_oxide::inflate::decompress_to_vec_with_limit(data, limit).map_err(|error| match error.status {
            miniz_oxide::inflate::TINFLStatus::HasMoreOutput => fail("too many bytes in the stream"),
            _ => fail("invalid deflate data"),
        })?;
        if (inflated.len() as u64) < entry.uncompressed_size { return Err(fail("not enough bytes in the stream")); }
        Ok(inflated)
    }

    /// 項目のデータ部分（ローカルヘッダー・名前・追加フィールドの後から、圧縮後サイズ分）。
    /// ZIP64 の位置・大きさは 64bit 全体を取り得るため、加算はすべて桁あふれを確かめ、ファイルの外（0 バイトでも末尾より先）は None にする。
    fn entry_bytes(&self, entry: &Entry, local: &[u8]) -> Option<&'a [u8]> {
        let start = entry.relative_offset_of_local_header.checked_add(30)?.checked_add(u16_at(local, 26) as u64)?.checked_add(u16_at(local, 28) as u64)?;
        let end = start.checked_add(entry.compressed_size)?;
        self.bytes.get(usize::try_from(start).ok()?..usize::try_from(end).ok()?)
    }
}

fn parse_extra_fields(buffer: &[u8]) -> Result<Vec<(u16, &[u8])>, String> {
    let mut fields = Vec::new();
    let mut i = 0usize;
    while i + 3 < buffer.len() {
        let id = u16_at(buffer, i);
        let size = u16_at(buffer, i + 2) as usize;
        let start = i + 4;
        let end = start + size;
        if end > buffer.len() { return Err("extra field length exceeds extra field buffer size".into()); }
        fields.push((id, &buffer[start..end]));
        i = end;
    }
    Ok(fields)
}

fn file_name(flag: u16, raw: &[u8], extra: &[(u16, &[u8])]) -> String {
    for (id, data) in extra {
        if *id != 0x7075 || data.len() < 6 || data[0] != 1 { continue; }
        if crc32fast::hash(raw) != u32_at(data, 1) { continue; }
        return String::from_utf8_lossy(&data[5..]).into_owned();
    }
    if flag & 0x800 != 0 { String::from_utf8_lossy(raw).into_owned() } else { cp437(raw) }
}

fn validate_file_name(name: &str) -> Result<(), String> {
    if name.contains('\\') { return Err(format!("invalid characters in fileName: {name}")); }
    let b = name.as_bytes();
    if (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':') || name.starts_with('/') { return Err(format!("absolute path: {name}")); }
    if name.split('/').any(|part| part == "..") { return Err(format!("invalid relative path: {name}")); }
    Ok(())
}

const CP437_HIGH: &str = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u{A0}";
const CP437_LOW: &str = "\u{0}☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼";

/// yauzl の decodeBuffer（UTF-8 でない名前は CP437。0x00〜0x1F と 0x7F も CP437 の図形文字として読む）。
fn cp437(raw: &[u8]) -> String {
    if raw.iter().all(|b| (0x20..0x7f).contains(b)) { return String::from_utf8_lossy(raw).into_owned(); }
    let low: Vec<char> = CP437_LOW.chars().collect();
    let high: Vec<char> = CP437_HIGH.chars().collect();
    raw.iter().map(|&b| match b {
        0x00..=0x1f => low[b as usize],
        0x7f => '⌂',
        0x80..=0xff => high[(b - 0x80) as usize],
        _ => b as char,
    }).collect()
}

/// 出力用の ZIP（[名前, 内容] の順に格納）。旧実装の zipXml と同じヘッダー値を使う。
pub fn write(parts: &[(&str, &[u8])]) -> Vec<u8> {
    let mut local: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();
    for (name, raw) in parts {
        let offset = local.len() as u32;
        let data = miniz_oxide::deflate::compress_to_vec(raw, 6);
        let checksum = crc32fast::hash(raw);
        let name = name.as_bytes();
        let mut header = [0u8; 30];
        header[0..4].copy_from_slice(&0x0403_4b50u32.to_le_bytes());
        header[4..6].copy_from_slice(&20u16.to_le_bytes());
        header[6..8].copy_from_slice(&0x800u16.to_le_bytes());
        header[8..10].copy_from_slice(&8u16.to_le_bytes());
        header[12..14].copy_from_slice(&33u16.to_le_bytes());
        header[14..18].copy_from_slice(&checksum.to_le_bytes());
        header[18..22].copy_from_slice(&(data.len() as u32).to_le_bytes());
        header[22..26].copy_from_slice(&(raw.len() as u32).to_le_bytes());
        header[26..28].copy_from_slice(&(name.len() as u16).to_le_bytes());
        let mut directory = [0u8; 46];
        directory[0..4].copy_from_slice(&0x0201_4b50u32.to_le_bytes());
        directory[4..6].copy_from_slice(&20u16.to_le_bytes());
        directory[6..8].copy_from_slice(&20u16.to_le_bytes());
        directory[8..10].copy_from_slice(&0x800u16.to_le_bytes());
        directory[10..12].copy_from_slice(&8u16.to_le_bytes());
        directory[14..16].copy_from_slice(&33u16.to_le_bytes());
        directory[16..20].copy_from_slice(&checksum.to_le_bytes());
        directory[20..24].copy_from_slice(&(data.len() as u32).to_le_bytes());
        directory[24..28].copy_from_slice(&(raw.len() as u32).to_le_bytes());
        directory[28..30].copy_from_slice(&(name.len() as u16).to_le_bytes());
        directory[42..46].copy_from_slice(&offset.to_le_bytes());
        local.extend_from_slice(&header); local.extend_from_slice(name); local.extend_from_slice(&data);
        central.extend_from_slice(&directory); central.extend_from_slice(name);
    }
    let mut end = [0u8; 22];
    end[0..4].copy_from_slice(&0x0605_4b50u32.to_le_bytes());
    end[8..10].copy_from_slice(&(parts.len() as u16).to_le_bytes());
    end[10..12].copy_from_slice(&(parts.len() as u16).to_le_bytes());
    end[12..16].copy_from_slice(&(central.len() as u32).to_le_bytes());
    end[16..20].copy_from_slice(&(local.len() as u32).to_le_bytes());
    let mut out = local;
    out.extend_from_slice(&central);
    out.extend_from_slice(&end);
    out
}

/// テスト用: tests/fixtures/xlsx.ts の zipParts と同じ形（無圧縮または deflate）。
pub fn write_fixture(parts: &[(&str, &[u8])], compress: bool) -> Vec<u8> {
    if compress { return write(parts); }
    let mut local: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();
    for (name, raw) in parts {
        let offset = local.len() as u32;
        let checksum = crc32fast::hash(raw);
        let name = name.as_bytes();
        let mut header = [0u8; 30];
        header[0..4].copy_from_slice(&0x0403_4b50u32.to_le_bytes());
        header[4..6].copy_from_slice(&20u16.to_le_bytes());
        header[6..8].copy_from_slice(&0x800u16.to_le_bytes());
        header[14..18].copy_from_slice(&checksum.to_le_bytes());
        header[18..22].copy_from_slice(&(raw.len() as u32).to_le_bytes());
        header[22..26].copy_from_slice(&(raw.len() as u32).to_le_bytes());
        header[26..28].copy_from_slice(&(name.len() as u16).to_le_bytes());
        let mut directory = [0u8; 46];
        directory[0..4].copy_from_slice(&0x0201_4b50u32.to_le_bytes());
        directory[4..6].copy_from_slice(&20u16.to_le_bytes());
        directory[6..8].copy_from_slice(&20u16.to_le_bytes());
        directory[8..10].copy_from_slice(&0x800u16.to_le_bytes());
        directory[16..20].copy_from_slice(&checksum.to_le_bytes());
        directory[20..24].copy_from_slice(&(raw.len() as u32).to_le_bytes());
        directory[24..28].copy_from_slice(&(raw.len() as u32).to_le_bytes());
        directory[28..30].copy_from_slice(&(name.len() as u16).to_le_bytes());
        directory[42..46].copy_from_slice(&offset.to_le_bytes());
        local.extend_from_slice(&header); local.extend_from_slice(name); local.extend_from_slice(raw);
        central.extend_from_slice(&directory); central.extend_from_slice(name);
    }
    let mut end = [0u8; 22];
    end[0..4].copy_from_slice(&0x0605_4b50u32.to_le_bytes());
    end[8..10].copy_from_slice(&(parts.len() as u16).to_le_bytes());
    end[10..12].copy_from_slice(&(parts.len() as u16).to_le_bytes());
    end[12..16].copy_from_slice(&(central.len() as u32).to_le_bytes());
    end[16..20].copy_from_slice(&(local.len() as u32).to_le_bytes());
    let mut out = local;
    out.extend_from_slice(&central);
    out.extend_from_slice(&end);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_written_parts() {
        let bytes = write(&[("a.xml", b"<a/>"), ("dir/b.xml", "架空".as_bytes())]);
        let mut archive = Archive::open(&bytes).unwrap();
        let mut seen = Vec::new();
        while let Some(entry) = archive.next_entry() {
            let entry = entry.unwrap();
            seen.push((entry.file_name.clone(), archive.read_entry_data(&entry).unwrap()));
        }
        assert_eq!(seen, vec![("a.xml".to_string(), b"<a/>".to_vec()), ("dir/b.xml".to_string(), "架空".as_bytes().to_vec())]);
    }

    #[test]
    fn rejects_non_zip_at_open() {
        assert!(matches!(Archive::open(b"not a zip"), Err(ZipError::Open(_))));
        assert!(matches!(Archive::open(b""), Err(ZipError::Open(_))));
    }

    #[test]
    fn rejects_traversal_names_and_backslashes() {
        for name in ["../x.xml", "a\\b.xml", "/abs.xml", "C:x.xml"] {
            let bytes = write_fixture(&[(name, b"x")], false);
            let mut archive = Archive::open(&bytes).unwrap();
            assert!(matches!(archive.next_entry(), Some(Err(ZipError::Entry(_)))), "{name}");
        }
    }

    #[test]
    fn detects_size_mismatch_after_inflate() {
        let mut bytes = write(&[("a.xml", b"abcdef")]);
        // 中央ディレクトリの展開後サイズを 1 減らす。
        let central = bytes.windows(4).position(|w| w == [0x50, 0x4b, 0x01, 0x02]).unwrap();
        bytes[central + 24] -= 1;
        let mut archive = Archive::open(&bytes).unwrap();
        let entry = archive.next_entry().unwrap().unwrap();
        assert_eq!(archive.read_entry_data(&entry), Err(ZipError::Entry("too many bytes in the stream".into())));
    }
}

#[cfg(test)]
mod empty_tests {
    use super::*;

    #[test]
    fn empty_deflated_entry_reads_as_empty() {
        let bytes = write(&[("empty.xml", b"")]);
        let mut archive = Archive::open(&bytes).unwrap();
        let entry = archive.next_entry().unwrap().unwrap();
        assert_eq!(archive.read_entry_data(&entry).unwrap(), Vec::<u8>::new());
    }
}
