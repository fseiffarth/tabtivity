//! A file's bytes as the phone is handed them: one byte range on request
//! (`Range` → 206, `If-Range`), a strong validator (`ETag`, `If-None-Match`
//! → 304) and, for this computer's files, a body streamed from the
//! descriptor the caller already proved — never a reopened path.
//!
//! iOS plays no `<video>` from a server that cannot answer a range, and a
//! picture seen once should revalidate rather than come down the link again.
//! Several ranges in one request are answered whole: no phone browser needs
//! a multipart answer.

use std::io::SeekFrom;

use axum::{
    body::Body,
    http::{header, HeaderMap, Response, StatusCode},
};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

/// The cache policy of a validated answer: this device only, asked again
/// each time (a cheap 304 while the file is unchanged).
pub const REVALIDATE: &str = "private, no-cache";

/// How much of a streamed body is read per step.
const CHUNK: usize = 64 * 1024;

/// What a request asks of a `len`-byte body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wanted {
    Whole,
    /// Inclusive bounds, already clamped to the body.
    Part { start: u64, end: u64 },
    Unsatisfiable,
}

/// The range a request's headers ask for. An `If-Range` that does not name
/// `etag` (or any `If-Range` when there is no validator) asks for the whole.
pub fn wanted(headers: &HeaderMap, len: u64, etag: Option<&str>) -> Wanted {
    let Some(range) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()) else {
        return Wanted::Whole;
    };
    if let Some(if_range) = headers.get(header::IF_RANGE) {
        if etag.is_none_or(|tag| if_range.to_str().ok().map(str::trim) != Some(tag)) {
            return Wanted::Whole;
        }
    }
    parse_range(range, len)
}

/// One `bytes=` range against a `len`-byte body. A value this does not
/// understand is ignored (the whole body), as HTTP says a server may.
pub fn parse_range(value: &str, len: u64) -> Wanted {
    let Some(spec) = value.trim().strip_prefix("bytes=") else {
        return Wanted::Whole;
    };
    if spec.contains(',') {
        return Wanted::Whole;
    }
    let Some((first, last)) = spec.split_once('-') else {
        return Wanted::Whole;
    };
    let (first, last) = (first.trim(), last.trim());
    if first.is_empty() {
        // `-n`: the last n bytes.
        let Ok(n) = last.parse::<u64>() else { return Wanted::Whole };
        if n == 0 || len == 0 {
            return Wanted::Unsatisfiable;
        }
        let n = n.min(len);
        return Wanted::Part { start: len - n, end: len - 1 };
    }
    let Ok(start) = first.parse::<u64>() else { return Wanted::Whole };
    let end = if last.is_empty() {
        u64::MAX
    } else {
        match last.parse::<u64>() {
            Ok(end) if end >= start => end,
            _ => return Wanted::Whole,
        }
    };
    if start >= len {
        return Wanted::Unsatisfiable;
    }
    Wanted::Part { start, end: end.min(len - 1) }
}

/// A strong validator for a file as it stands: size, modification time to
/// the nanosecond and, where the OS has one, the inode — a file replaced
/// under the same name and size changes it.
pub fn etag(meta: &std::fs::Metadata) -> String {
    let modified = meta
        .modified()
        .ok()
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|at| at.as_nanos())
        .unwrap_or(0);
    #[cfg(unix)]
    let inode = std::os::unix::fs::MetadataExt::ino(meta);
    #[cfg(not(unix))]
    let inode = 0u64;
    format!("\"{:x}-{:x}-{:x}\"", meta.len(), modified, inode)
}

/// Whether `If-None-Match` already names `etag` (weak comparison, as HTTP
/// asks for this header).
pub fn fresh(headers: &HeaderMap, etag: &str) -> bool {
    let Some(value) = headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let bare = |tag: &str| tag.trim().trim_start_matches("W/").to_string();
    value.split(',').any(|tag| tag.trim() == "*" || bare(tag) == bare(etag))
}

/// The headers every answer of one file carries.
pub struct Head<'a> {
    pub kind: &'static str,
    pub disposition: String,
    /// `None`: no validator, and no cache policy of this module's.
    pub etag: Option<&'a str>,
}

fn builder(status: StatusCode, head: &Head<'_>) -> axum::http::response::Builder {
    let mut builder = Response::builder()
        .status(status)
        .header(header::ACCEPT_RANGES, "bytes");
    if let Some(tag) = head.etag {
        builder = builder.header(header::ETAG, tag).header(header::CACHE_CONTROL, REVALIDATE);
    }
    builder
}

fn failed() -> Response<Body> {
    Response::builder()
        .status(StatusCode::INTERNAL_SERVER_ERROR)
        .body(Body::empty())
        .unwrap_or_default()
}

fn not_modified(head: &Head<'_>) -> Response<Body> {
    builder(StatusCode::NOT_MODIFIED, head).body(Body::empty()).unwrap_or_else(|_| failed())
}

fn unsatisfiable(len: u64, head: &Head<'_>) -> Response<Body> {
    builder(StatusCode::RANGE_NOT_SATISFIABLE, head)
        .header(header::CONTENT_RANGE, format!("bytes */{len}"))
        .body(Body::empty())
        .unwrap_or_else(|_| failed())
}

/// The status line and length headers of a body of `count` bytes from
/// `start`, out of `total` (a 206 when that is not the whole).
fn framed(start: u64, count: u64, total: u64, head: &Head<'_>) -> axum::http::response::Builder {
    let whole = start == 0 && count == total;
    let mut builder = builder(if whole { StatusCode::OK } else { StatusCode::PARTIAL_CONTENT }, head)
        .header(header::CONTENT_TYPE, head.kind)
        .header(header::CONTENT_DISPOSITION, head.disposition.as_str())
        .header(header::CONTENT_LENGTH, count);
    if !whole {
        let last = (start + count).saturating_sub(1);
        builder = builder.header(header::CONTENT_RANGE, format!("bytes {start}-{last}/{total}"));
    }
    builder
}

/// A body already in memory (a drop box's bounded read), answered whole or
/// by the one range asked.
pub fn from_bytes(headers: &HeaderMap, bytes: Vec<u8>, head: &Head<'_>) -> Response<Body> {
    if head.etag.is_some_and(|tag| fresh(headers, tag)) {
        return not_modified(head);
    }
    let total = bytes.len() as u64;
    match wanted(headers, total, head.etag) {
        Wanted::Whole => framed(0, total, total, head).body(Body::from(bytes)).unwrap_or_else(|_| failed()),
        Wanted::Part { start, end } => {
            let part = bytes[start as usize..=end as usize].to_vec();
            framed(start, end - start + 1, total, head).body(Body::from(part)).unwrap_or_else(|_| failed())
        }
        Wanted::Unsatisfiable => unsatisfiable(total, head),
    }
}

/// A part read on its own (the remote side's ranged read): `bytes` start at
/// `start` of a `total`-byte file.
pub fn from_part(bytes: Vec<u8>, start: u64, total: u64, head: &Head<'_>) -> Response<Body> {
    let count = bytes.len() as u64;
    framed(start, count, total, head).body(Body::from(bytes)).unwrap_or_else(|_| failed())
}

/// The 416 for a `total`-byte file.
pub fn out_of_range(total: u64, head: &Head<'_>) -> Response<Body> {
    unsatisfiable(total, head)
}

/// The first `len` bytes of an open, already proven file (`len` may stop
/// short of its end: a long text's head), streamed — answered whole or by
/// the one range asked.
pub async fn from_file(headers: &HeaderMap, file: std::fs::File, len: u64, head: &Head<'_>) -> Response<Body> {
    if head.etag.is_some_and(|tag| fresh(headers, tag)) {
        return not_modified(head);
    }
    let (start, end) = match wanted(headers, len, head.etag) {
        Wanted::Whole if len == 0 => return framed(0, 0, 0, head).body(Body::empty()).unwrap_or_else(|_| failed()),
        Wanted::Whole => (0, len - 1),
        Wanted::Part { start, end } => (start, end),
        Wanted::Unsatisfiable => return unsatisfiable(len, head),
    };
    let mut file = tokio::fs::File::from_std(file);
    if file.seek(SeekFrom::Start(start)).await.is_err() {
        return failed();
    }
    let count = end - start + 1;
    // A file that shrinks under the read ends the body short; the phone sees
    // a cut transfer, never another file's bytes.
    let stream = futures_util::stream::unfold((file, count), |(mut file, left)| async move {
        if left == 0 {
            return None;
        }
        let mut buf = vec![0u8; CHUNK.min(usize::try_from(left).unwrap_or(CHUNK))];
        match file.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok::<_, std::io::Error>(bytes::Bytes::from(buf)), (file, left - n as u64)))
            }
            Err(error) => Some((Err(error), (file, 0))),
        }
    });
    framed(start, count, len, head).body(Body::from_stream(stream)).unwrap_or_else(|_| failed())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use std::io::Write;

    fn asking(pairs: &[(header::HeaderName, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.insert(name.clone(), HeaderValue::from_str(value).unwrap());
        }
        headers
    }

    #[test]
    fn a_range_is_read_as_http_says_and_anything_odd_is_the_whole() {
        assert_eq!(parse_range("bytes=0-1", 10), Wanted::Part { start: 0, end: 1 });
        assert_eq!(parse_range("bytes=4-", 10), Wanted::Part { start: 4, end: 9 });
        assert_eq!(parse_range("bytes=4-99", 10), Wanted::Part { start: 4, end: 9 });
        assert_eq!(parse_range("bytes=-3", 10), Wanted::Part { start: 7, end: 9 });
        assert_eq!(parse_range("bytes=-30", 10), Wanted::Part { start: 0, end: 9 });
        assert_eq!(parse_range("bytes=10-", 10), Wanted::Unsatisfiable);
        assert_eq!(parse_range("bytes=-0", 10), Wanted::Unsatisfiable);
        assert_eq!(parse_range("bytes=0-", 0), Wanted::Unsatisfiable);
        assert_eq!(parse_range("bytes=5-2", 10), Wanted::Whole);
        assert_eq!(parse_range("bytes=0-1,4-5", 10), Wanted::Whole);
        assert_eq!(parse_range("items=0-1", 10), Wanted::Whole);
        assert_eq!(parse_range("bytes=a-b", 10), Wanted::Whole);
    }

    #[test]
    fn if_range_must_name_the_validator() {
        let tag = "\"a-b-c\"";
        let ranged = asking(&[(header::RANGE, "bytes=1-2"), (header::IF_RANGE, tag)]);
        assert_eq!(wanted(&ranged, 10, Some(tag)), Wanted::Part { start: 1, end: 2 });
        assert_eq!(wanted(&ranged, 10, Some("\"other\"")), Wanted::Whole);
        assert_eq!(wanted(&ranged, 10, None), Wanted::Whole);
        assert!(fresh(&asking(&[(header::IF_NONE_MATCH, "\"x\", W/\"a-b-c\"")]), tag));
        assert!(fresh(&asking(&[(header::IF_NONE_MATCH, "*")]), tag));
        assert!(!fresh(&asking(&[(header::IF_NONE_MATCH, "\"x\"")]), tag));
        assert!(!fresh(&HeaderMap::new(), tag));
    }

    #[test]
    fn a_rewritten_file_gets_a_new_validator() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.bin");
        std::fs::write(&path, b"one").unwrap();
        let first = etag(&std::fs::metadata(&path).unwrap());
        let file = std::fs::File::options().write(true).open(&path).unwrap();
        file.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(5)).unwrap();
        let second = etag(&std::fs::metadata(&path).unwrap());
        assert_ne!(first, second);
        assert!(first.starts_with('"') && first.ends_with('"'));
    }

    async fn body_of(response: Response<Body>) -> Vec<u8> {
        axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec()
    }

    fn head(etag: Option<&str>) -> Head<'_> {
        Head { kind: "video/mp4", disposition: "inline".into(), etag }
    }

    #[tokio::test]
    async fn a_streamed_file_answers_its_range_and_its_validator() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("film.mp4");
        let content: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::File::create(&path).unwrap().write_all(&content).unwrap();
        let tag = "\"t\"";
        let open = || std::fs::File::open(&path).unwrap();

        let whole = from_file(&HeaderMap::new(), open(), content.len() as u64, &head(Some(tag))).await;
        assert_eq!(whole.status(), StatusCode::OK);
        assert_eq!(whole.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(whole.headers()[header::ETAG], tag);
        assert_eq!(whole.headers()[header::CACHE_CONTROL], REVALIDATE);
        assert_eq!(body_of(whole).await, content);

        let part = from_file(&asking(&[(header::RANGE, "bytes=70000-70009")]), open(), content.len() as u64, &head(Some(tag))).await;
        assert_eq!(part.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(part.headers()[header::CONTENT_RANGE], "bytes 70000-70009/200000");
        assert_eq!(part.headers()[header::CONTENT_LENGTH], "10");
        assert_eq!(body_of(part).await, content[70000..70010]);

        let none = from_file(&asking(&[(header::RANGE, "bytes=300000-")]), open(), content.len() as u64, &head(Some(tag))).await;
        assert_eq!(none.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(none.headers()[header::CONTENT_RANGE], "bytes */200000");

        let kept = from_file(&asking(&[(header::IF_NONE_MATCH, tag)]), open(), content.len() as u64, &head(Some(tag))).await;
        assert_eq!(kept.status(), StatusCode::NOT_MODIFIED);
        assert!(body_of(kept).await.is_empty());

        // A long text's head: the body stops at `len`, not at the file's end.
        let headed = from_file(&HeaderMap::new(), open(), 1000, &head(Some(tag))).await;
        assert_eq!(headed.headers()[header::CONTENT_LENGTH], "1000");
        assert_eq!(body_of(headed).await, content[..1000]);
    }

    #[tokio::test]
    async fn a_buffered_body_is_sliced_for_a_range() {
        let bytes = b"0123456789".to_vec();
        let part = from_bytes(&asking(&[(header::RANGE, "bytes=2-4")]), bytes.clone(), &head(None));
        assert_eq!(part.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(part.headers()[header::CONTENT_RANGE], "bytes 2-4/10");
        assert!(part.headers().get(header::CACHE_CONTROL).is_none());
        assert_eq!(body_of(part).await, b"234");
        let whole = from_bytes(&HeaderMap::new(), bytes, &head(None));
        assert_eq!(whole.status(), StatusCode::OK);
        assert_eq!(body_of(whole).await, b"0123456789");
    }
}
