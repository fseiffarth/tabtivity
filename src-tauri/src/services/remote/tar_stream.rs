//! A streaming reader for the tar archives a host's `tar -cf -` writes, so a
//! remote project's tree can be packed straight from an SSH pipe
//! (`commands::project_transfer`, "the host's copy") without landing on disk
//! first.
//!
//! Reads what GNU tar and bsdtar emit by default: ustar headers (with the
//! `prefix` field), GNU long names and link names (`L`/`K`), pax extended
//! headers (`x`: `path`, `linkpath`, `size`; global `g` headers are skipped),
//! and base-256 sizes. Every header's checksum is verified: a pipe that
//! breaks mid-archive is an error, never a silently shorter tree.
//!
//! Paths are returned as the archive spells them; the caller decides what is
//! safe to write. AppHandle-free.

use std::io::{self, Read};

const BLOCK: usize = 512;
/// The longest GNU long name or pax header body read into memory.
const MAX_META: u64 = 1 << 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kind {
    File,
    Dir,
    Symlink(String),
    /// A hard link to an earlier member of the same archive.
    HardLink(String),
    /// A FIFO, device or anything else with no content to carry.
    Special,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Header {
    pub path: String,
    pub kind: Kind,
    pub mode: u32,
    pub size: u64,
}

pub struct TarReader<R: Read> {
    inner: R,
    /// Unread bytes of the current member, padding included.
    pending: u64,
    done: bool,
}

impl<R: Read> TarReader<R> {
    pub fn new(inner: R) -> Self {
        TarReader {
            inner,
            pending: 0,
            done: false,
        }
    }

    /// The next member's header, skipping whatever of the previous member's
    /// content was not read. `None` at the end of the archive.
    pub fn next_header(&mut self) -> io::Result<Option<Header>> {
        let mut long_name: Option<String> = None;
        let mut long_link: Option<String> = None;
        let mut pax_path: Option<String> = None;
        let mut pax_link: Option<String> = None;
        let mut pax_size: Option<u64> = None;
        loop {
            self.skip_pending()?;
            if self.done {
                return Ok(None);
            }
            let mut block = [0u8; BLOCK];
            if !read_block(&mut self.inner, &mut block)? {
                // An archive cut before its end marker.
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "archive ended early"));
            }
            if block.iter().all(|b| *b == 0) {
                self.done = true;
                return Ok(None);
            }
            verify_checksum(&block)?;
            let size = parse_size(&block[124..136])?;
            let typeflag = block[156];
            match typeflag {
                b'L' | b'K' | b'x' | b'g' => {
                    let body = self.read_meta(size)?;
                    match typeflag {
                        b'L' => long_name = Some(cstr(&body)),
                        b'K' => long_link = Some(cstr(&body)),
                        b'x' => {
                            for (key, value) in pax_records(&body) {
                                match key.as_str() {
                                    "path" => pax_path = Some(value),
                                    "linkpath" => pax_link = Some(value),
                                    "size" => pax_size = value.parse().ok(),
                                    _ => {}
                                }
                            }
                        }
                        _ => {}
                    }
                    continue;
                }
                _ => {}
            }
            let size = pax_size.unwrap_or(size);
            let name = cstr(&block[0..100]);
            let ustar = &block[257..263] == b"ustar\0";
            let path = pax_path.or(long_name).unwrap_or_else(|| {
                let prefix = if ustar { cstr(&block[345..500]) } else { String::new() };
                if prefix.is_empty() {
                    name
                } else {
                    format!("{prefix}/{name}")
                }
            });
            let link = pax_link.or(long_link).unwrap_or_else(|| cstr(&block[157..257]));
            let mode = parse_octal(&block[100..108]).unwrap_or(0o644) as u32 & 0o7777;
            let kind = match typeflag {
                b'0' | 0 | b'7' => Kind::File,
                b'5' => Kind::Dir,
                b'2' => Kind::Symlink(link),
                b'1' => Kind::HardLink(link),
                _ => Kind::Special,
            };
            // Old archives mark a directory only by its trailing slash.
            let kind = if kind == Kind::File && path.ends_with('/') {
                Kind::Dir
            } else {
                kind
            };
            let size = if matches!(kind, Kind::File) { size } else { 0 };
            self.pending = padded(size);
            return Ok(Some(Header {
                path,
                kind,
                mode,
                size,
            }));
        }
    }

    /// The current member's content. Read it fully or not at all; what is left
    /// is skipped by the next [`TarReader::next_header`].
    pub fn content(&mut self, size: u64) -> impl Read + '_ {
        let size = size.min(self.pending);
        self.pending -= size;
        (&mut self.inner).take(size)
    }

    fn skip_pending(&mut self) -> io::Result<()> {
        if self.pending > 0 {
            let want = self.pending;
            let skipped = io::copy(&mut (&mut self.inner).take(want), &mut io::sink())?;
            if skipped < want {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "archive ended early"));
            }
            self.pending = 0;
        }
        Ok(())
    }

    fn read_meta(&mut self, size: u64) -> io::Result<Vec<u8>> {
        if size > MAX_META {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "oversized tar header"));
        }
        let mut body = vec![0u8; size as usize];
        self.inner.read_exact(&mut body)?;
        self.pending = padded(size) - size;
        Ok(body)
    }
}

fn padded(size: u64) -> u64 {
    size.div_ceil(BLOCK as u64) * BLOCK as u64
}

/// `false` on a clean end of input before the first byte.
fn read_block(r: &mut impl Read, block: &mut [u8; BLOCK]) -> io::Result<bool> {
    let mut filled = 0;
    while filled < BLOCK {
        match r.read(&mut block[filled..]) {
            Ok(0) if filled == 0 => return Ok(false),
            Ok(0) => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "archive ended early")),
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(true)
}

fn cstr(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

fn parse_octal(field: &[u8]) -> Option<u64> {
    let text = cstr(field);
    let text = text.trim_matches(|c: char| c == ' ' || c == '\0');
    if text.is_empty() {
        return Some(0);
    }
    u64::from_str_radix(text, 8).ok()
}

/// A size field: octal, or GNU base-256 (high bit of the first byte set).
fn parse_size(field: &[u8]) -> io::Result<u64> {
    if field[0] & 0x80 != 0 {
        let mut value: u64 = (field[0] & 0x7f) as u64;
        for b in &field[1..] {
            value = value
                .checked_mul(256)
                .and_then(|v| v.checked_add(*b as u64))
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "tar size overflows"))?;
        }
        return Ok(value);
    }
    parse_octal(field).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "bad tar size"))
}

fn verify_checksum(block: &[u8; BLOCK]) -> io::Result<()> {
    let stored = parse_octal(&block[148..156])
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "bad tar checksum field"))?;
    let sum: u64 = block
        .iter()
        .enumerate()
        .map(|(i, b)| if (148..156).contains(&i) { b' ' as u64 } else { *b as u64 })
        .sum();
    if sum != stored {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "tar header checksum mismatch"));
    }
    Ok(())
}

/// `"<len> <key>=<value>\n"` records of a pax header.
fn pax_records(body: &[u8]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = body;
    while !rest.is_empty() {
        let Some(space) = rest.iter().position(|b| *b == b' ') else { break };
        let Some(len) = std::str::from_utf8(&rest[..space]).ok().and_then(|s| s.parse::<usize>().ok()) else {
            break;
        };
        if len <= space + 1 || len > rest.len() {
            break;
        }
        let record = &rest[space + 1..len];
        let record = record.strip_suffix(b"\n").unwrap_or(record);
        if let Some(eq) = record.iter().position(|b| *b == b'=') {
            out.push((
                String::from_utf8_lossy(&record[..eq]).into_owned(),
                String::from_utf8_lossy(&record[eq + 1..]).into_owned(),
            ));
        }
        rest = &rest[len..];
    }
    out
}

#[cfg(test)]
pub(crate) mod testing {
    /// One ustar header block for tests.
    pub fn header(name: &str, typeflag: u8, size: u64, link: &str, gnu: bool) -> Vec<u8> {
        let mut b = vec![0u8; 512];
        b[..name.len()].copy_from_slice(name.as_bytes());
        b[100..107].copy_from_slice(format!("{:07o}", 0o644).as_bytes());
        b[124..135].copy_from_slice(format!("{size:011o}").as_bytes());
        b[156] = typeflag;
        b[157..157 + link.len()].copy_from_slice(link.as_bytes());
        if gnu {
            b[257..265].copy_from_slice(b"ustar  \0");
        } else {
            b[257..263].copy_from_slice(b"ustar\0");
            b[263..265].copy_from_slice(b"00");
        }
        b[148..156].copy_from_slice(b"        ");
        let sum: u64 = b.iter().map(|x| *x as u64).sum();
        b[148..155].copy_from_slice(format!("{sum:06o}\0").as_bytes());
        b
    }

    pub fn member(out: &mut Vec<u8>, name: &str, typeflag: u8, body: &[u8], link: &str, gnu: bool) {
        out.extend(header(name, typeflag, body.len() as u64, link, gnu));
        out.extend_from_slice(body);
        out.resize(out.len().div_ceil(512) * 512, 0);
    }

    pub fn end(out: &mut Vec<u8>) {
        out.extend(vec![0u8; 1024]);
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;

    fn read_all(bytes: &[u8]) -> io::Result<Vec<(Header, Vec<u8>)>> {
        let mut tar = TarReader::new(bytes);
        let mut out = Vec::new();
        while let Some(h) = tar.next_header()? {
            let mut body = Vec::new();
            tar.content(h.size).read_to_end(&mut body)?;
            out.push((h, body));
        }
        Ok(out)
    }

    #[test]
    fn files_dirs_links_and_long_names_are_read() {
        let mut a = Vec::new();
        member(&mut a, "./", b'5', b"", "", true);
        member(&mut a, "./src/", b'5', b"", "", true);
        member(&mut a, "./src/main.rs", b'0', b"fn main() {}\n", "", true);
        member(&mut a, "./link", b'2', b"", "src/main.rs", true);
        member(&mut a, "./pipe", b'6', b"", "", true);
        let long = format!("./{}/deep.txt", "d".repeat(150));
        member(&mut a, "././@LongLink", b'L', format!("{long}\0").as_bytes(), "", true);
        member(&mut a, "./ddd", b'0', b"x", "", true);
        let record = " path=./pax-named.txt\n";
        let pax = format!("{}{record}", 2 + record.len());
        member(&mut a, "./PaxHeaders/x", b'x', pax.as_bytes(), "", false);
        member(&mut a, "./short", b'0', b"pax body", "", false);
        member(&mut a, "./hard", b'1', b"", "./src/main.rs", true);
        end(&mut a);

        let got = read_all(&a).unwrap();
        let names: Vec<(&str, &Kind)> = got.iter().map(|(h, _)| (h.path.as_str(), &h.kind)).collect();
        assert_eq!(names[0], ("./", &Kind::Dir));
        assert_eq!(names[2], ("./src/main.rs", &Kind::File));
        assert_eq!(got[2].1, b"fn main() {}\n");
        assert_eq!(names[3], ("./link", &Kind::Symlink("src/main.rs".into())));
        assert_eq!(names[4], ("./pipe", &Kind::Special));
        assert_eq!(names[5].0, long);
        assert_eq!(got[5].1, b"x");
        assert_eq!(names[6].0, "./pax-named.txt");
        assert_eq!(got[6].1, b"pax body");
        assert_eq!(names[7], ("./hard", &Kind::HardLink("./src/main.rs".into())));
    }

    #[test]
    fn unread_content_is_skipped() {
        let mut a = Vec::new();
        member(&mut a, "big", b'0', &[7u8; 1500], "", false);
        member(&mut a, "next", b'0', b"n", "", false);
        end(&mut a);
        let mut tar = TarReader::new(&a[..]);
        assert_eq!(tar.next_header().unwrap().unwrap().path, "big");
        let next = tar.next_header().unwrap().unwrap();
        assert_eq!(next.path, "next");
    }

    #[test]
    fn a_broken_archive_is_an_error_not_a_shorter_tree() {
        let mut a = Vec::new();
        member(&mut a, "a", b'0', b"hello", "", false);
        // Cut before the end marker.
        assert!(read_all(&a).is_err());
        // A corrupted header.
        let mut b = Vec::new();
        member(&mut b, "a", b'0', b"hello", "", false);
        b[0] = b'z';
        end(&mut b);
        assert!(read_all(&b).is_err());
    }

    #[test]
    fn base256_sizes_are_read() {
        let mut field = [0u8; 12];
        field[0] = 0x80;
        field[10] = 0x01;
        field[11] = 0x00;
        assert_eq!(parse_size(&field).unwrap(), 256);
    }
}
