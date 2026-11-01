//! 名前空間対応の XML 読込。旧実装（saxes 6、xmlns: true、エラー処理なし＝最初の不正で停止）と同じ範囲を受け付け、
//! ドキュメント型宣言（DTD）は取込の形式エラー、要素数・深さの上限は上限エラーにする。それ以外の構文不正は汎用エラー。

use indexmap::IndexMap;

use crate::error::{Error, ImportCode, Result};

pub const XML_NAMESPACE: &str = "http://www.w3.org/XML/1998/namespace";
pub const XMLNS_NAMESPACE: &str = "http://www.w3.org/2000/xmlns/";

#[derive(Debug, Clone, Default, PartialEq)]
pub struct XmlNode {
    /// ローカル名
    pub name: String,
    pub uri: String,
    /// 属性（修飾名 → 値）。名前空間宣言も含む。
    pub attrs: IndexMap<String, String>,
    pub children: Vec<XmlNode>,
    pub text: String,
}

impl XmlNode {
    pub fn attr(&self, name: &str) -> Option<&str> { self.attrs.get(name).map(String::as_str) }
    /// 同じ名前空間の最初の子要素
    pub fn child(&self, name: &str) -> Option<&XmlNode> { self.children.iter().find(|c| c.name == name && c.uri == self.uri) }
    /// 同じ名前空間の子要素
    pub fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a XmlNode> + 'a { self.children.iter().filter(move |c| c.name == name && c.uri == self.uri) }
}

const EOC: u32 = u32::MAX;
/// CR（と CR LF）。テキストでは LF として扱う。
const NL_LIKE: u32 = 0x11_0001;
const NL: u32 = 0x0A;
const CR: u32 = 0x0D;
const TAB: u32 = 0x09;
const NEL: u32 = 0x85;
const LS: u32 = 0x2028;

fn malformed(message: &str) -> Error { Error::other(format!("xml: {message}")) }

fn is_s(c: u32) -> bool { c == 0x20 || c == NL || c == CR || c == TAB }

fn is_name_start(c: u32) -> bool {
    matches!(c, 0x3A | 0x41..=0x5A | 0x5F | 0x61..=0x7A | 0xC0..=0xD6 | 0xD8..=0xF6 | 0xF8..=0x2FF | 0x370..=0x37D | 0x37F..=0x1FFF | 0x200C..=0x200D | 0x2070..=0x218F | 0x2C00..=0x2FEF | 0x3001..=0xD7FF | 0xF900..=0xFDCF | 0xFDF0..=0xFFFD | 0x10000..=0xEFFFF)
}
fn is_name_char(c: u32) -> bool {
    is_name_start(c) || matches!(c, 0x2D | 0x2E | 0x30..=0x39 | 0xB7 | 0x300..=0x36F | 0x203F..=0x2040)
}
fn is_ncname_start(c: u32) -> bool { c != 0x3A && is_name_start(c) }
fn is_ncname_char(c: u32) -> bool { c != 0x3A && is_name_char(c) }
fn is_ncname(text: &str) -> bool {
    let mut chars = text.chars().map(|c| c as u32);
    matches!(chars.next(), Some(c) if is_ncname_start(c)) && chars.all(is_ncname_char)
}
fn is_char10(c: u32) -> bool { matches!(c, 0x9 | 0xA | 0xD | 0x20..=0xD7FF | 0xE000..=0xFFFD | 0x10000..=0x10FFFF) }
fn is_char11(c: u32) -> bool { matches!(c, 0x1..=0xD7FF | 0xE000..=0xFFFD | 0x10000..=0x10FFFF) }

fn push_code(out: &mut String, c: u32) {
    if c == NL_LIKE { out.push('\n') } else if let Some(ch) = char::from_u32(c) { out.push(ch) }
}

struct Tag { name: String, prefix: String, local: String, ns: IndexMap<String, String>, attributes: Vec<(String, String)> }

struct Parser<'a> {
    src: &'a str,
    i: usize,
    prev: usize,
    xml11: bool,
    xml_decl_possible: bool,
    saw_root: bool,
    closed_root: bool,
    doctype: bool,
    open: Vec<(Tag, XmlNode)>,
    root: Option<XmlNode>,
    count: usize,
    text: String,
}

impl<'a> Parser<'a> {
    /// 1 文字読む（行末の正規化と文字の検査を含む）。
    fn code(&mut self) -> Result<u32> {
        self.prev = self.i;
        let Some(ch) = self.src[self.i..].chars().next() else { return Ok(EOC) };
        self.i += ch.len_utf8();
        let c = ch as u32;
        let next = |p: &Parser| p.src[p.i..].chars().next().map(|c| c as u32);
        if !self.xml11 {
            if c >= 0x20 && c < 0xD800 || c == TAB { return Ok(c); }
            match c {
                NL => Ok(NL),
                CR => { if next(self) == Some(NL) { self.i += 1; } Ok(NL_LIKE) }
                _ if c < 0x20 => Err(malformed("disallowed character.")),
                _ if (0xE000..=0xFFFD).contains(&c) || c >= 0x10000 => Ok(c),
                _ => Err(malformed("disallowed character.")),
            }
        } else {
            if c < 0xD800 && ((c > 0x1F && c < 0x7F) || (c > 0x9F && c != LS) || c == TAB) { return Ok(c); }
            match c {
                NL => Ok(NL),
                CR => { if matches!(next(self), Some(NL) | Some(NEL)) { self.i += if next(self) == Some(NL) { 1 } else { 2 }; } Ok(NL_LIKE) }
                NEL | LS => Ok(NL_LIKE),
                _ if (0xE000..=0xFFFD).contains(&c) || c >= 0x10000 => Ok(c),
                _ => Err(malformed("disallowed character.")),
            }
        }
    }
    fn code_norm(&mut self) -> Result<u32> { let c = self.code()?; Ok(if c == NL_LIKE { NL } else { c }) }
    fn unget(&mut self) { self.i = self.prev; }
    fn skip_spaces(&mut self) -> Result<u32> { loop { let c = self.code_norm()?; if c == EOC || !is_s(c) { return Ok(c); } } }

    fn capture_name(&mut self) -> Result<(String, u32)> {
        let mut name = String::new();
        loop {
            let c = self.code()?;
            if c == EOC { return Ok((name, EOC)); }
            if !is_name_char(c) { return Ok((name, if c == NL_LIKE { NL } else { c })); }
            push_code(&mut name, c);
        }
    }

    fn parse(mut self) -> Result<XmlNode> {
        // 先頭の BOM（U+FEFF）は 1 つだけ読み飛ばす。
        if self.src.starts_with('\u{FEFF}') { self.i = 3; }
        // 先頭の空白（空白があると XML 宣言は置けない）
        let before = self.i;
        let c = self.skip_spaces()?;
        if self.prev != before { self.xml_decl_possible = false; }
        if c == EOC { return self.end(); }
        if c == '<' as u32 { self.open_waka()?; } else { self.unget(); self.xml_decl_possible = false; }
        loop {
            let c = self.code()?;
            if c == EOC { return self.end(); }
            self.unget();
            if self.open.is_empty() { self.text_outside_root()?; } else { self.text_in_root()?; }
        }
    }

    fn flush_text(&mut self) {
        if self.text.is_empty() { return; }
        let text = std::mem::take(&mut self.text);
        if let Some((_, node)) = self.open.last_mut() { node.text.push_str(&text); }
    }

    fn text_in_root(&mut self) -> Result<()> {
        // ]]> を検出しながら、< までの文字データを読む。
        let mut brackets = 0;
        loop {
            let c = self.code()?;
            match c {
                EOC => return Ok(()),
                0x3C => { self.flush_text(); return self.open_waka(); }
                0x26 => { let parsed = self.entity()?; self.text.push_str(&parsed); brackets = 0; }
                0x5D => { brackets = (brackets + 1).min(2); self.text.push(']'); }
                0x3E => { if brackets == 2 { return Err(malformed("the string \"]]>\" is disallowed in char data.")); } brackets = 0; self.text.push('>'); }
                _ => { brackets = 0; push_code(&mut self.text, c); }
            }
        }
    }

    fn text_outside_root(&mut self) -> Result<()> {
        let mut non_space = false;
        loop {
            let c = self.code()?;
            match c {
                EOC => break,
                0x3C => { self.text.clear(); if non_space { break; } return self.open_waka(); }
                0x26 => { non_space = true; break; }
                NL_LIKE => {}
                _ => { if !is_s(c) { non_space = true; break; } }
            }
        }
        if non_space { return Err(malformed("text data outside of root node.")); }
        Ok(())
    }

    fn entity(&mut self) -> Result<String> {
        let mut entity = String::new();
        loop {
            let c = self.code()?;
            match c {
                EOC => return Err(malformed("unexpected end.")),
                0x3B => break,
                _ => push_code(&mut entity, c),
            }
        }
        if entity.is_empty() { return Err(malformed("empty entity name.")); }
        if !entity.starts_with('#') {
            return match entity.as_str() {
                "amp" => Ok("&".into()), "lt" => Ok("<".into()), "gt" => Ok(">".into()), "quot" => Ok("\"".into()), "apos" => Ok("'".into()),
                _ => Err(malformed(if is_ncname(&entity) { "undefined entity." } else { "disallowed character in entity name." })),
            };
        }
        let digits = &entity[1..];
        let number = if let Some(hex) = digits.strip_prefix('x') {
            if !hex.is_empty() && hex.bytes().all(|b| b.is_ascii_hexdigit()) { u32::from_str_radix(hex, 16).ok() } else { None }
        } else if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) { digits.parse::<u32>().ok() } else { None };
        let valid = |n: u32| if self.xml11 { is_char11(n) } else { is_char10(n) };
        match number.filter(|n| valid(*n)).and_then(char::from_u32) {
            Some(ch) => Ok(ch.to_string()),
            None => Err(malformed("malformed character entity.")),
        }
    }

    fn open_waka(&mut self) -> Result<()> {
        let c = self.code()?;
        if is_name_start(c) { self.unget(); self.xml_decl_possible = false; return self.open_tag(); }
        match c {
            0x2F => { self.xml_decl_possible = false; self.close_tag() }
            0x21 => { self.xml_decl_possible = false; self.open_waka_bang() }
            0x3F => self.pi(),
            _ => Err(malformed("disallowed character in tag name")),
        }
    }

    fn open_waka_bang(&mut self) -> Result<()> {
        let mut bang = String::new();
        loop {
            let c = self.code_norm()?;
            if c == EOC { return Err(malformed("unexpected end.")); }
            push_code(&mut bang, c);
            match bang.as_str() {
                "[CDATA[" => {
                    if !self.saw_root || self.closed_root { return Err(malformed("text data outside of root node.")); }
                    return self.cdata();
                }
                "--" => return self.comment(),
                "DOCTYPE" => {
                    if self.doctype || self.saw_root { return Err(malformed("inappropriately located doctype declaration.")); }
                    return self.doctype();
                }
                _ => { if bang.chars().count() >= 7 { return Err(malformed("incorrect syntax.")); } }
            }
        }
    }

    fn comment(&mut self) -> Result<()> {
        loop {
            let c = self.code_norm()?;
            if c == EOC { return Err(malformed("unexpected end.")); }
            if c != 0x2D { continue; }
            let c = self.code_norm()?;
            if c == EOC { return Err(malformed("unexpected end.")); }
            if c != 0x2D { continue; }
            let c = self.code_norm()?;
            if c == EOC { return Err(malformed("unexpected end.")); }
            if c != 0x3E { return Err(malformed("malformed comment.")); }
            return Ok(());
        }
    }

    fn cdata(&mut self) -> Result<()> {
        let mut data = String::new();
        loop {
            let c = self.code()?;
            if c == EOC { return Err(malformed("unexpected end.")); }
            if c != 0x5D { push_code(&mut data, c); continue; }
            // ]
            let mut c = self.code_norm()?;
            if c != 0x5D { data.push(']'); if c == EOC { return Err(malformed("unexpected end.")); } push_code(&mut data, c); continue; }
            // ]]
            loop {
                c = self.code_norm()?;
                match c {
                    0x3E => { self.text.push_str(&data); return Ok(()); }
                    0x5D => data.push(']'),
                    EOC => return Err(malformed("unexpected end.")),
                    _ => { data.push_str("]]"); push_code(&mut data, c); break; }
                }
            }
        }
    }

    /// <!DOCTYPE ...> を最後まで読み、旧実装と同じく形式エラーにする（saxes の DTD 読み飛ばしと同じ区切り方）。
    fn doctype(&mut self) -> Result<()> {
        fn until(p: &mut Parser, q: u32) -> Result<()> {
            loop { let c = p.code_norm()?; if c == EOC { return Err(malformed("unexpected end.")); } if c == q { return Ok(()); } }
        }
        fn next(p: &mut Parser) -> Result<u32> {
            let c = p.code_norm()?;
            if c == EOC { Err(malformed("unexpected end.")) } else { Ok(c) }
        }
        loop {
            match next(self)? {
                0x3E => return Err(Error::import(ImportCode::Format, "DTDを含むXMLは読み込めません。")),
                q @ (0x22 | 0x27) => until(self, q)?,
                0x5B => loop {
                    match next(self)? {
                        0x5D => break,
                        q @ (0x22 | 0x27) => until(self, q)?,
                        0x3C => match next(self)? {
                            0x21 => {
                                if next(self)? == 0x2D && next(self)? == 0x2D {
                                    // DTD 内のコメント
                                    loop {
                                        until(self, 0x2D)?;
                                        if next(self)? != 0x2D { continue; }
                                        if next(self)? != 0x3E { return Err(malformed("malformed comment.")); }
                                        break;
                                    }
                                }
                            }
                            0x3F => { until(self, 0x3F)?; until(self, 0x3E)?; }
                            _ => {}
                        },
                        _ => {}
                    }
                },
                _ => {}
            }
        }
    }

    fn pi(&mut self) -> Result<()> {
        let c = self.code_norm()?;
        if c == EOC { return Err(malformed("unexpected end.")); }
        if !is_ncname_start(c) {
            return Err(malformed(if c == 0x3F || is_s(c) { "processing instruction without a target." } else { "disallowed character in processing instruction name." }));
        }
        let mut target = String::new();
        push_code(&mut target, c);
        let end;
        loop {
            let c = self.code_norm()?;
            if c == EOC { return Err(malformed("unexpected end.")); }
            if is_ncname_char(c) { push_code(&mut target, c); continue; }
            if c == 0x3F || is_s(c) { end = c; break; }
            return Err(malformed("disallowed character in processing instruction name."));
        }
        if target == "xml" {
            if !self.xml_decl_possible { return Err(malformed("an XML declaration must be at the start of the document.")); }
            return self.xml_decl(end == 0x3F);
        }
        // 本体は最初の ?> まで（?? の後の > も終端）。
        let mut ending = end == 0x3F;
        loop {
            let c = self.code_norm()?;
            if c == EOC { return Err(malformed("unexpected end.")); }
            if ending {
                if c == 0x3E { break; }
                ending = c == 0x3F;
            } else if c == 0x3F {
                ending = true;
            }
        }
        self.xml_decl_possible = false;
        if target.to_lowercase() == "xml" { return Err(malformed("the XML declaration must appear at the start of the document.")); }
        Ok(())
    }

    fn xml_decl(&mut self, ending: bool) -> Result<()> {
        let mut expects: Vec<&str> = vec!["version"];
        let mut saw_version = false;
        while !ending {
            let c = self.skip_spaces()?;
            if c == EOC { return Err(malformed("unexpected end.")); }
            if c == 0x3F { break; }
            // 名前
            let mut name = String::new();
            push_code(&mut name, c);
            let mut c;
            loop {
                c = self.code_norm()?;
                if c == EOC { return Err(malformed("unexpected end.")); }
                if c == 0x3D || c == 0x3F || is_s(c) { break; }
                push_code(&mut name, c);
            }
            if c == 0x3F { return Err(malformed("XML declaration is incomplete.")); }
            if !expects.contains(&name.as_str()) { return Err(malformed("unexpected name in XML declaration.")); }
            if c != 0x3D {
                loop {
                    c = self.code_norm()?;
                    if c == EOC { return Err(malformed("unexpected end.")); }
                    if c == 0x3F { return Err(malformed("XML declaration is incomplete.")); }
                    if is_s(c) { continue; }
                    if c != 0x3D { return Err(malformed("value required.")); }
                    break;
                }
            }
            let quote = loop {
                let c = self.code_norm()?;
                if c == EOC { return Err(malformed("unexpected end.")); }
                if c == 0x3F { return Err(malformed("XML declaration is incomplete.")); }
                if is_s(c) { continue; }
                if c != 0x22 && c != 0x27 { return Err(malformed("value must be quoted.")); }
                break c;
            };
            let mut value = String::new();
            loop {
                let c = self.code_norm()?;
                if c == EOC { return Err(malformed("unexpected end.")); }
                if c == 0x3F { return Err(malformed("XML declaration is incomplete.")); }
                if c == quote { break; }
                push_code(&mut value, c);
            }
            match name.as_str() {
                "version" => {
                    expects = vec!["encoding", "standalone"];
                    saw_version = true;
                    let valid = value.len() > 2 && value.starts_with("1.") && value[2..].bytes().all(|b| b.is_ascii_digit());
                    if !valid { return Err(malformed("version number must match /^1\\.[0-9]+$/.")); }
                    self.xml11 = value != "1.0";
                }
                "encoding" => {
                    let b = value.as_bytes();
                    if b.is_empty() || !b[0].is_ascii_alphabetic() || !b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-')) { return Err(malformed("encoding value is invalid.")); }
                    expects = vec!["standalone"];
                }
                _ => {
                    if value != "yes" && value != "no" { return Err(malformed("standalone value must match \"yes\" or \"no\".")); }
                    expects = vec![];
                }
            }
            let c = self.code_norm()?;
            if c == EOC { return Err(malformed("unexpected end.")); }
            if c == 0x3F { break; }
            if !is_s(c) { return Err(malformed("whitespace required.")); }
        }
        let c = self.code_norm()?;
        if c != 0x3E { return Err(malformed("The character ? is disallowed anywhere in XML declarations.")); }
        if !saw_version { return Err(malformed("XML declaration must contain a version.")); }
        self.xml_decl_possible = false;
        Ok(())
    }

    fn resolve(&self, tag: &Tag, prefix: &str) -> Option<String> {
        if let Some(uri) = tag.ns.get(prefix) { return Some(uri.clone()); }
        for (open, _) in self.open.iter().rev() { if let Some(uri) = open.ns.get(prefix) { return Some(uri.clone()); } }
        match prefix { "xml" => Some(XML_NAMESPACE.into()), "xmlns" => Some(XMLNS_NAMESPACE.into()), _ => None }
    }

    fn qname(name: &str) -> Result<(String, String)> {
        match name.find(':') {
            None => Ok((String::new(), name.to_string())),
            Some(colon) => {
                let (prefix, local) = (&name[..colon], &name[colon + 1..]);
                if prefix.is_empty() || local.is_empty() || local.contains(':') { return Err(malformed("malformed name.")); }
                Ok((prefix.to_string(), local.to_string()))
            }
        }
    }

    fn push_attribute(&mut self, tag: &mut Tag, name: String, value: String) -> Result<()> {
        let (prefix, local) = Self::qname(&name)?;
        if prefix == "xmlns" {
            let trimmed = value.trim_matches(|c: char| crate::js::is_js_space(c)).to_string();
            if !self.xml11 && trimmed.is_empty() { return Err(malformed("invalid attempt to undefine prefix in XML 1.0")); }
            ns_pair_check(&local, &trimmed)?;
            tag.ns.insert(local, trimmed);
        } else if name == "xmlns" {
            let trimmed = value.trim_matches(|c: char| crate::js::is_js_space(c)).to_string();
            ns_pair_check("", &trimmed)?;
            tag.ns.insert(String::new(), trimmed);
        }
        tag.attributes.push((name, value));
        Ok(())
    }

    fn open_tag(&mut self) -> Result<()> {
        let (name, mut c) = self.capture_name()?;
        if c == EOC { return Err(malformed("unexpected end.")); }
        let mut tag = Tag { name, prefix: String::new(), local: String::new(), ns: IndexMap::new(), attributes: Vec::new() };
        self.saw_root = true;
        if self.closed_root { return Err(malformed("documents may contain only one root.")); }
        let self_closing;
        // 属性
        if c != 0x3E && c != 0x2F && !is_s(c) { return Err(malformed("disallowed character in tag name.")); }
        loop {
            match c {
                0x3E => { self_closing = false; break; }
                0x2F => {
                    if self.code()? != 0x3E { return Err(malformed("forward-slash in opening tag not followed by >.")); }
                    self_closing = true;
                    break;
                }
                _ => {}
            }
            // 空白の後
            c = self.skip_spaces()?;
            if c == EOC { return Err(malformed("unexpected end.")); }
            if c == 0x3E || c == 0x2F { continue; }
            if !is_name_start(c) { return Err(malformed("disallowed character in attribute name.")); }
            self.unget();
            let (attr, mut after) = self.capture_name()?;
            if after == EOC { return Err(malformed("unexpected end.")); }
            if is_s(after) { after = self.skip_spaces()?; if after == EOC { return Err(malformed("unexpected end.")); } }
            if after != 0x3D { return Err(malformed(if after == 0x3E || is_s(after) || is_name_start(after) { "attribute without value." } else { "disallowed character in attribute name." })); }
            // 値
            let quote = loop {
                let q = self.code_norm()?;
                if q == EOC { return Err(malformed("unexpected end.")); }
                if q == 0x22 || q == 0x27 { break q; }
                if !is_s(q) { return Err(malformed("unquoted attribute value.")); }
            };
            let mut value = String::new();
            loop {
                let v = self.code()?;
                match v {
                    EOC => return Err(malformed("unexpected end.")),
                    _ if v == quote => break,
                    0x26 => { let parsed = self.entity()?; value.push_str(&parsed); }
                    NL | NL_LIKE | TAB => value.push(' '),
                    0x3C => return Err(malformed("disallowed character.")),
                    _ => push_code(&mut value, v),
                }
            }
            self.push_attribute(&mut tag, attr, value)?;
            c = self.code_norm()?;
            if c == EOC { return Err(malformed("unexpected end.")); }
            if is_s(c) || c == 0x3E || c == 0x2F { continue; }
            return Err(malformed(if is_name_start(c) { "no whitespace between attributes." } else { "disallowed character in attribute name." }));
        }
        self.process_attributes(&mut tag)?;
        self.flush_text();
        self.count += 1;
        if self.count > 250_000 || self.open.len() >= 64 { return Err(Error::import(ImportCode::Limit, "XMLの構造が読取上限を超えています。")); }
        let uri = self.resolve(&tag, &tag.prefix).unwrap_or_default();
        let mut attrs = IndexMap::new();
        for (key, value) in &tag.attributes { attrs.insert(key.clone(), value.clone()); }
        let node = XmlNode { name: tag.local.clone(), uri, attrs, children: Vec::new(), text: String::new() };
        if self_closing {
            self.attach(node);
            if self.open.is_empty() { self.closed_root = true; }
        } else {
            self.open.push((tag, node));
        }
        Ok(())
    }

    fn process_attributes(&mut self, tag: &mut Tag) -> Result<()> {
        let (prefix, local) = Self::qname(&tag.name)?;
        tag.prefix = prefix.clone();
        tag.local = local;
        let uri = self.resolve(tag, &prefix).unwrap_or_default();
        if !prefix.is_empty() {
            if prefix == "xmlns" { return Err(malformed("tags may not have \"xmlns\" as prefix.")); }
            if uri.is_empty() { return Err(malformed("unbound namespace prefix.")); }
        }
        let mut seen = std::collections::HashSet::new();
        let mut attributes = Vec::with_capacity(tag.attributes.len());
        for (name, value) in std::mem::take(&mut tag.attributes) {
            let (prefix, local) = Self::qname(&name)?;
            let expanded = if prefix.is_empty() { name.clone() } else {
                let Some(uri) = self.resolve(tag, &prefix) else { return Err(malformed("unbound namespace prefix.")) };
                format!("{{{uri}}}{local}")
            };
            if !seen.insert(expanded) { return Err(malformed("duplicate attribute.")); }
            attributes.push((name, value));
        }
        tag.attributes = attributes;
        Ok(())
    }

    fn attach(&mut self, node: XmlNode) {
        match self.open.last_mut() {
            Some((_, parent)) => parent.children.push(node),
            None => self.root = Some(node),
        }
    }

    fn close_tag(&mut self) -> Result<()> {
        let (name, c) = self.capture_name()?;
        let c = if is_s(c) { self.skip_spaces()? } else { c };
        if c == EOC { return Err(malformed("unexpected end.")); }
        if c != 0x3E { return Err(malformed("disallowed character in closing tag.")); }
        if name.is_empty() { return Err(malformed("weird empty close tag.")); }
        self.flush_text();
        let Some((tag, node)) = self.open.pop() else { return Err(malformed("unmatched closing tag.")) };
        if tag.name != name { return Err(malformed("unexpected close tag.")); }
        self.attach(node);
        if self.open.is_empty() { self.closed_root = true; }
        Ok(())
    }

    fn end(mut self) -> Result<XmlNode> {
        if !self.saw_root { return Err(malformed("document must contain a root element.")); }
        if !self.open.is_empty() { return Err(malformed("unclosed tag.")); }
        self.text.clear();
        self.root.take().ok_or_else(|| malformed("document must contain a root element."))
    }
}

fn ns_pair_check(prefix: &str, uri: &str) -> Result<()> {
    if prefix == "xml" && uri != XML_NAMESPACE { return Err(malformed("xml prefix must be bound to the XML namespace.")); }
    if prefix == "xmlns" && uri != XMLNS_NAMESPACE { return Err(malformed("xmlns prefix must be bound to the xmlns namespace.")); }
    if uri == XMLNS_NAMESPACE { return Err(malformed("may not assign the xmlns namespace.")); }
    if uri == XML_NAMESPACE && prefix != "xml" { return Err(malformed("may not assign the xml namespace to another prefix.")); }
    Ok(())
}

/// XML を読む（`parseXml`）。UTF-8 以外・構文不正は汎用エラー。
pub fn parse_xml(bytes: &[u8]) -> Result<XmlNode> {
    // TextDecoder('utf-8', { fatal: true }) は先頭の BOM を 1 つ取り除く。
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let source = std::str::from_utf8(bytes).map_err(|_| Error::other("xml: invalid utf-8"))?;
    Parser { src: source, i: 0, prev: 0, xml11: false, xml_decl_possible: true, saw_root: false, closed_root: false, doctype: false, open: Vec::new(), root: None, count: 0, text: String::new() }.parse()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(xml: &str) -> XmlNode { parse_xml(xml.as_bytes()).unwrap_or_else(|e| panic!("{xml}: {e}")) }
    fn bad(xml: &str) -> Error { parse_xml(xml.as_bytes()).err().unwrap_or_else(|| panic!("accepted {xml}")) }

    #[test]
    fn reads_namespaces_text_and_attributes() {
        let root = ok("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n<a xmlns=\"urn:x\" xmlns:r=\"urn:r\"><b r:id=\"1\" v=\"a&amp;b\tc\r\nd\">x&lt;y<![CDATA[<z>]]>\r\n<!-- c --><?pi body?></b><r:c/></a>");
        assert_eq!(root.name, "a");
        assert_eq!(root.uri, "urn:x");
        let b = root.child("b").unwrap();
        assert_eq!(b.attr("r:id"), Some("1"));
        assert_eq!(b.attr("v"), Some("a&b c d"));
        assert_eq!(b.text, "x<y<z>\n");
        assert_eq!(root.children[1].uri, "urn:r");
        assert!(root.child("c").is_none());
        assert_eq!(root.attr("xmlns"), Some("urn:x"));
    }

    #[test]
    fn rejects_malformed_documents() {
        for xml in ["", "<a>", "<a></b>", "<a/><b/>", "text<a/>", "<a/>text", "<a b=\"1\" b=\"2\"/>", "<a b=1/>", "<x:a/>", "<a>&unknown;</a>", "<a>]]></a>", "<a>&#0;</a>", "<a>\u{1}</a>", " <?xml version=\"1.0\"?><a/>", "<a><?XML x?></a>", "<!-- a -- b --><a/>", "<![CDATA[x]]><a/>", "<a></a><!DOCTYPE a>"] {
            assert!(matches!(bad(xml), Error::Other(_)), "{xml:?}");
        }
    }

    #[test]
    fn doctype_is_an_import_format_error() {
        assert!(matches!(bad("<!DOCTYPE a [<!ENTITY x \"secret\">]><a>&x;</a>"), Error::Import(ImportCode::Format, _)));
    }

    #[test]
    fn limits_depth_and_count() {
        let deep = format!("{}{}", "<a>".repeat(64), "</a>".repeat(64));
        assert!(parse_xml(deep.as_bytes()).is_ok());
        let deeper = format!("{}{}", "<a>".repeat(65), "</a>".repeat(65));
        assert!(matches!(parse_xml(deeper.as_bytes()), Err(Error::Import(ImportCode::Limit, _))));
        let many = format!("<a>{}</a>", "<b/>".repeat(250_000));
        assert!(matches!(parse_xml(many.as_bytes()), Err(Error::Import(ImportCode::Limit, _))));
        let enough = format!("<a>{}</a>", "<b/>".repeat(249_999));
        assert!(parse_xml(enough.as_bytes()).is_ok());
    }

    #[test]
    fn strips_one_bom_and_rejects_invalid_utf8() {
        assert_eq!(parse_xml(b"\xEF\xBB\xBF<a/>").unwrap().name, "a");
        assert_eq!(parse_xml("\u{FEFF}\u{FEFF}<a/>".as_bytes()).unwrap().name, "a");
        assert!(parse_xml(b"<a>\xff</a>").is_err());
    }
}
