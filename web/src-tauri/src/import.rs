//! EPUB 原生导入(ADR-0004 选项 B):WebView 持有 `File` 并在 JS 侧抽取文本;原生只接收分块字节 →
//! 暂存 `<data_root>/import/<op_id>/part-NNNNNN` → finalize 拼装、校验、建书行并原子落到受管目录
//! `<data_root>/books/<book_id>.epub`。以 op_id 幂等;失败不留书行;崩溃后暂存目录可清理。
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use book_learner_core::models::{self, BookType};
use book_learner_core::orchestrate::validate_client_id;
use book_learner_core::CoreError;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};

use crate::error::IpcError;

/// 单个 EPUB 大小上限(默认 200 MiB)。
pub const DEFAULT_MAX_EPUB_BYTES: u64 = 200 * 1024 * 1024;
/// 单个分块上限(前端按 4 MiB 分块;留余量)。
pub const MAX_CHUNK_BYTES: usize = 8 * 1024 * 1024;
/// zip 条目数上限(防 zip 炸弹式目录)。
pub const MAX_ENTRIES: usize = 5000;
/// 暂存目录超过该时长未完成即视为崩溃残留。
pub const STALE_STAGING: Duration = Duration::from_secs(24 * 3600);
const EPUB_MIMETYPE: &str = "application/epub+zip";

pub struct ImportStore {
    staging_root: PathBuf,
    books_dir: PathBuf,
    max_epub_bytes: u64,
}

fn io_error(error: std::io::Error) -> IpcError {
    IpcError::from(CoreError::Io(error))
}

fn db_error(error: rusqlite::Error) -> IpcError {
    IpcError::from(CoreError::from(error))
}

fn invalid(message: &str, cause: impl Into<String>) -> IpcError {
    IpcError::invalid_request(message, cause)
}

impl ImportStore {
    pub fn new(data_root: &Path) -> Self {
        Self {
            staging_root: data_root.join("import"),
            books_dir: data_root.join("books"),
            max_epub_bytes: DEFAULT_MAX_EPUB_BYTES,
        }
    }

    pub fn with_max_epub_bytes(mut self, max_epub_bytes: u64) -> Self {
        self.max_epub_bytes = max_epub_bytes;
        self
    }

    pub fn books_dir(&self) -> &Path {
        &self.books_dir
    }

    /// 受管 EPUB 路径:只由 book_id 决定,前端永远拿不到任意源路径。
    pub fn book_path(&self, book_id: i64) -> PathBuf {
        self.books_dir.join(format!("{book_id}.epub"))
    }

    fn staging_dir(&self, op_id: &str) -> Result<PathBuf, IpcError> {
        validate_client_id(op_id).map_err(IpcError::from)?;
        Ok(self.staging_root.join(op_id))
    }

    /// 写入一个分块(同目录临时文件 + fsync + rename);返回该 op 已暂存的总字节数。
    pub fn stage_chunk(&self, op_id: &str, index: u64, bytes: &[u8]) -> Result<u64, IpcError> {
        let dir = self.staging_dir(op_id)?;
        if bytes.is_empty() {
            return Err(invalid(
                "导入分块为空",
                format!("empty chunk {index} for {op_id}"),
            ));
        }
        if bytes.len() > MAX_CHUNK_BYTES {
            return Err(invalid(
                "导入分块过大",
                format!(
                    "chunk {index} has {} bytes (limit {MAX_CHUNK_BYTES})",
                    bytes.len()
                ),
            ));
        }
        fs::create_dir_all(&dir).map_err(io_error)?;
        let part = dir.join(format!("part-{index:06}"));
        let temp = dir.join(format!("part-{index:06}.tmp"));
        {
            let mut file = File::create(&temp).map_err(io_error)?;
            file.write_all(bytes).map_err(io_error)?;
            file.sync_all().map_err(io_error)?;
        }
        fs::rename(&temp, &part).map_err(io_error)?;
        let total: u64 = self.parts(&dir)?.iter().map(|(_, size, _)| size).sum();
        if total > self.max_epub_bytes {
            let _ = fs::remove_dir_all(&dir);
            return Err(invalid(
                "EPUB 超过大小上限",
                format!(
                    "{total} bytes staged for {op_id} (limit {})",
                    self.max_epub_bytes
                ),
            ));
        }
        Ok(total)
    }

    /// 已暂存分块 (index, size, path),按 index 升序。
    fn parts(&self, dir: &Path) -> Result<Vec<(u64, u64, PathBuf)>, IpcError> {
        let mut parts = Vec::new();
        for entry in fs::read_dir(dir).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let Some(index) = name
                .strip_prefix("part-")
                .and_then(|rest| rest.parse::<u64>().ok())
            else {
                continue;
            };
            let size = entry.metadata().map_err(io_error)?.len();
            parts.push((index, size, entry.path()));
        }
        parts.sort_by_key(|(index, _, _)| *index);
        Ok(parts)
    }

    /// 分块必须为 0..n 连续;拼装到 `assembled.epub`。
    fn assemble(&self, dir: &Path) -> Result<PathBuf, IpcError> {
        let parts = self.parts(dir)?;
        if parts.is_empty() {
            return Err(invalid("没有可完成的导入分块", "no staged parts"));
        }
        for (expected, (index, _, _)) in parts.iter().enumerate() {
            if *index != expected as u64 {
                return Err(invalid(
                    "导入分块不连续,请重新导入",
                    format!("expected part {expected}, found {index}"),
                ));
            }
        }
        let assembled = dir.join("assembled.epub");
        let mut output = File::create(&assembled).map_err(io_error)?;
        for (_, _, path) in &parts {
            let mut input = File::open(path).map_err(io_error)?;
            std::io::copy(&mut input, &mut output).map_err(io_error)?;
        }
        output.sync_all().map_err(io_error)?;
        Ok(assembled)
    }

    /// EPUB 结构校验:zip 魔数、条目数上限、无遍历/绝对路径条目、首条目 `mimetype` 为
    /// `application/epub+zip`、存在 `META-INF/container.xml`。不解压正文。
    pub fn validate_epub(path: &Path) -> Result<(), IpcError> {
        let file = File::open(path).map_err(io_error)?;
        let mut magic = [0u8; 4];
        if (&file).read_exact(&mut magic).is_err() || &magic != b"PK\x03\x04" {
            return Err(invalid(
                "不是有效的 EPUB 文件",
                "missing zip local header magic",
            ));
        }
        let mut archive = zip::ZipArchive::new(file)
            .map_err(|error| invalid("不是有效的 EPUB 文件", format!("zip: {error}")))?;
        if archive.is_empty() || archive.len() > MAX_ENTRIES {
            return Err(invalid(
                "EPUB 结构异常",
                format!("{} entries (limit {MAX_ENTRIES})", archive.len()),
            ));
        }
        for index in 0..archive.len() {
            let name = archive.name_for_index(index).unwrap_or("");
            if name.is_empty()
                || name.starts_with('/')
                || name.contains('\\')
                || name.split('/').any(|component| component == "..")
            {
                return Err(invalid(
                    "EPUB 含不安全的条目路径",
                    format!("entry {index}: {name:?}"),
                ));
            }
        }
        {
            let first = archive
                .by_index(0)
                .map_err(|error| invalid("EPUB 结构异常", format!("entry 0: {error}")))?;
            if first.name() != "mimetype" {
                return Err(invalid(
                    "EPUB 结构异常",
                    format!("first entry is {:?}, not mimetype", first.name()),
                ));
            }
            let mut mimetype = String::new();
            first
                .take(64)
                .read_to_string(&mut mimetype)
                .map_err(|error| invalid("EPUB 结构异常", format!("mimetype: {error}")))?;
            if mimetype.trim() != EPUB_MIMETYPE {
                return Err(invalid(
                    "EPUB 结构异常",
                    format!("mimetype is {:?}", mimetype.trim()),
                ));
            }
        }
        if archive.index_for_name("META-INF/container.xml").is_none() {
            return Err(invalid("EPUB 结构异常", "META-INF/container.xml missing"));
        }
        Ok(())
    }

    /// 从 OPF 读 `dc:title` / `dc:creator`(容错:任一步失败都返回 None,不影响导入)。
    /// 只做最小化的字符串解析(不引入 XML 依赖):container.xml 的 `full-path` → OPF 文本 → 首个 `<dc:title>` / `<dc:creator>`。
    pub fn epub_metadata(path: &Path) -> (Option<String>, Option<String>) {
        fn read_entry(archive: &mut zip::ZipArchive<File>, name: &str) -> Option<String> {
            let mut entry = archive.by_name(name).ok()?;
            let mut text = String::new();
            entry.take(2 * 1024 * 1024).read_to_string(&mut text).ok()?;
            Some(text)
        }
        fn attr(text: &str, name: &str) -> Option<String> {
            let start = text.find(&format!("{name}=\""))? + name.len() + 2;
            let end = text[start..].find('"')? + start;
            Some(text[start..end].to_string())
        }
        fn element_text(text: &str, tag: &str) -> Option<String> {
            let open = text.find(&format!("<{tag}"))?;
            let body_start = text[open..].find('>')? + open + 1;
            let close = text[body_start..].find(&format!("</{tag}"))? + body_start;
            let raw = text[body_start..close].trim();
            if raw.is_empty() {
                return None;
            }
            let decoded = raw
                .replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&apos;", "'")
                .replace("&#39;", "'");
            let collapsed = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
            Some(collapsed.chars().take(200).collect())
        }
        let Ok(file) = File::open(path) else {
            return (None, None);
        };
        let Ok(mut archive) = zip::ZipArchive::new(file) else {
            return (None, None);
        };
        let Some(container) = read_entry(&mut archive, "META-INF/container.xml") else {
            return (None, None);
        };
        let Some(rootfile) = attr(&container, "full-path") else {
            return (None, None);
        };
        let Some(opf) = read_entry(&mut archive, &rootfile) else {
            return (None, None);
        };
        (element_text(&opf, "dc:title"), element_text(&opf, "dc:creator"))
    }

    /// 完成导入:同 op_id 重复调用返回同一 book_id;校验失败 → 无书行且暂存清理;
    /// 落盘失败 → 回滚书行。书行 `import_state='staged'`(已落盘、待抽取)。
    pub fn finalize(
        &self,
        conn: &Connection,
        op_id: &str,
        book_type: BookType,
        title: &str,
    ) -> Result<i64, IpcError> {
        let dir = self.staging_dir(op_id)?;
        let slug = format!("import-{op_id}");
        let existing: Option<i64> = conn
            .query_row("SELECT id FROM book WHERE slug=?1", [&slug], |row| {
                row.get(0)
            })
            .optional()
            .map_err(db_error)?;
        if let Some(book_id) = existing {
            let _ = fs::remove_dir_all(&dir);
            return Ok(book_id);
        }
        if !dir.is_dir() {
            return Err(invalid(
                "没有可完成的导入分块",
                format!("no staging directory for {op_id}"),
            ));
        }
        let assembled = match self
            .assemble(&dir)
            .and_then(|assembled| Self::validate_epub(&assembled).map(|()| assembled))
        {
            Ok(assembled) => assembled,
            Err(error) => {
                let _ = fs::remove_dir_all(&dir);
                return Err(error);
            }
        };
        // 书名优先取 OPF 的 dc:title(m2 门禁发现:书架显示的是文件名);作者取 dc:creator
        let (opf_title, opf_author) = Self::epub_metadata(&assembled);
        let fallback = title.trim();
        let title = opf_title
            .as_deref()
            .filter(|t| !t.trim().is_empty())
            .unwrap_or(if fallback.is_empty() {
                "未命名书籍"
            } else {
                fallback
            });
        let author = opf_author.as_deref().unwrap_or("待识别");
        let book_id = {
            let transaction = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
                .map_err(db_error)?;
            let book_id = models::insert_book(&transaction, title, author, book_type, &slug)?;
            transaction
                .execute(
                    "UPDATE book SET import_state='staged' WHERE id=?1",
                    [book_id],
                )
                .map_err(db_error)?;
            transaction.commit().map_err(db_error)?;
            book_id
        };
        let placed = fs::create_dir_all(&self.books_dir)
            .and_then(|()| fs::rename(&assembled, self.book_path(book_id)));
        if let Err(error) = placed {
            let _ = conn.execute("DELETE FROM book WHERE id=?1", [book_id]);
            let _ = fs::remove_dir_all(&dir);
            return Err(io_error(error));
        }
        let _ = fs::remove_dir_all(&dir);
        Ok(book_id)
    }

    /// 删除 `now - STALE_STAGING` 之前的暂存目录(崩溃恢复);返回删除数。
    pub fn cleanup_stale(&self, now: SystemTime) -> Result<usize, IpcError> {
        let Ok(entries) = fs::read_dir(&self.staging_root) else {
            return Ok(0);
        };
        let mut removed = 0;
        for entry in entries {
            let entry = entry.map_err(io_error)?;
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .map_err(io_error)?;
            if now.duration_since(modified).unwrap_or_default() > STALE_STAGING {
                fs::remove_dir_all(entry.path()).map_err(io_error)?;
                removed += 1;
            }
        }
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use std::io::Cursor;
    use zip::write::SimpleFileOptions;
    use zip::CompressionMethod;

    /// 造一个 zip:条目按给定顺序、全部 stored。
    fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (name, body) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(body).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    pub(crate) fn valid_epub() -> Vec<u8> {
        zip_bytes(&[
            ("mimetype", EPUB_MIMETYPE.as_bytes()),
            ("META-INF/container.xml", b"<container/>"),
            ("OEBPS/ch0.xhtml", b"<html>ch0</html>"),
        ])
    }

    fn epub_with_metadata(title: &str, creator: Option<&str>) -> Vec<u8> {
        let creator = creator
            .map(|c| format!("<dc:creator opf:role=\"aut\">{c}</dc:creator>"))
            .unwrap_or_default();
        let opf = format!(
            "<?xml version=\"1.0\"?><package xmlns=\"http://www.idpf.org/2007/opf\" version=\"3.0\">\
             <metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:title id=\"t\">{title}</dc:title>{creator}\
             </metadata><manifest/><spine/></package>"
        );
        zip_bytes(&[
            ("mimetype", EPUB_MIMETYPE.as_bytes()),
            (
                "META-INF/container.xml",
                b"<?xml version=\"1.0\"?><container version=\"1.0\"><rootfiles><rootfile full-path=\"OEBPS/content.opf\" media-type=\"application/oebps-package+xml\"/></rootfiles></container>",
            ),
            ("OEBPS/content.opf", opf.as_bytes()),
            ("OEBPS/ch0.xhtml", b"<html>ch0</html>"),
        ])
    }

    #[test]
    fn finalize_prefers_opf_title_and_creator_over_the_file_name() {
        let dir = tempfile::tempdir().unwrap();
        let (store, conn) = store(dir.path());
        store
            .stage_chunk("op-meta", 0, &epub_with_metadata("道德經 &amp; 注", Some("  老子 ")))
            .unwrap();
        let book_id = store
            .finalize(&conn, "op-meta", BookType::Humanities, "book-24039")
            .unwrap();
        let (title, author): (String, String) = conn
            .query_row("SELECT title,author FROM book WHERE id=?1", [book_id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((title.as_str(), author.as_str()), ("道德經 & 注", "老子"));

        // 无 OPF 元数据 / 空标题 → 沿用文件名派生的标题与"待识别"
        store.stage_chunk("op-plain", 0, &valid_epub()).unwrap();
        let plain = store
            .finalize(&conn, "op-plain", BookType::Textbook, "book-7337")
            .unwrap();
        let (title, author): (String, String) = conn
            .query_row("SELECT title,author FROM book WHERE id=?1", [plain], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((title.as_str(), author.as_str()), ("book-7337", "待识别"));
        store
            .stage_chunk("op-empty", 0, &epub_with_metadata("  ", None))
            .unwrap();
        let empty = store
            .finalize(&conn, "op-empty", BookType::Textbook, "")
            .unwrap();
        let title: String = conn
            .query_row("SELECT title FROM book WHERE id=?1", [empty], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "未命名书籍");
    }

    fn store(dir: &Path) -> (ImportStore, Connection) {
        let conn = book_learner_core::db::open(&dir.join("app.db")).unwrap();
        (ImportStore::new(dir), conn)
    }

    #[test]
    fn stage_assemble_validate_and_finalize_place_the_epub_under_books() {
        let dir = tempfile::tempdir().unwrap();
        let (store, conn) = store(dir.path());
        let epub = valid_epub();
        let (a, b) = epub.split_at(epub.len() / 2);
        assert_eq!(store.stage_chunk("op-1", 0, a).unwrap(), a.len() as u64);
        assert_eq!(store.stage_chunk("op-1", 1, b).unwrap(), epub.len() as u64);
        let book_id = store
            .finalize(&conn, "op-1", BookType::Textbook, "  微观经济学 ")
            .unwrap();
        let placed = store.book_path(book_id);
        assert_eq!(fs::read(&placed).unwrap(), epub);
        assert!(!dir.path().join("import").join("op-1").exists());
        let (title, state, slug): (String, String, String) = conn
            .query_row(
                "SELECT title,import_state,slug FROM book WHERE id=?1",
                [book_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (title.as_str(), state.as_str(), slug.as_str()),
            ("微观经济学", "staged", "import-op-1")
        );
        // 同 op 再次 finalize → 同一 book,不再要求暂存存在
        assert_eq!(
            store
                .finalize(&conn, "op-1", BookType::Textbook, "x")
                .unwrap(),
            book_id
        );
        assert_eq!(
            store
                .finalize(&conn, "op-9", BookType::Textbook, "x")
                .unwrap_err()
                .code,
            ErrorCode::InvalidRequest
        );
    }

    #[test]
    fn corrupt_or_unsafe_epubs_are_rejected_without_a_book_row() {
        let dir = tempfile::tempdir().unwrap();
        let (store, conn) = store(dir.path());
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("not-zip", b"hello world, definitely not a zip".to_vec()),
            (
                "no-container",
                zip_bytes(&[("mimetype", EPUB_MIMETYPE.as_bytes()), ("a.xhtml", b"x")]),
            ),
            (
                "bad-mimetype",
                zip_bytes(&[
                    ("mimetype", b"text/plain"),
                    ("META-INF/container.xml", b"x"),
                ]),
            ),
            (
                "mimetype-not-first",
                zip_bytes(&[
                    ("META-INF/container.xml", b"x"),
                    ("mimetype", EPUB_MIMETYPE.as_bytes()),
                ]),
            ),
            (
                "traversal",
                zip_bytes(&[
                    ("mimetype", EPUB_MIMETYPE.as_bytes()),
                    ("META-INF/container.xml", b"x"),
                    ("../evil.txt", b"x"),
                ]),
            ),
            (
                "absolute",
                zip_bytes(&[
                    ("mimetype", EPUB_MIMETYPE.as_bytes()),
                    ("META-INF/container.xml", b"x"),
                    ("/etc/passwd", b"x"),
                ]),
            ),
        ];
        for (op_id, bytes) in cases {
            store.stage_chunk(op_id, 0, &bytes).unwrap();
            let error = store
                .finalize(&conn, op_id, BookType::Textbook, op_id)
                .unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidRequest, "{op_id}");
            assert!(!dir.path().join("import").join(op_id).exists(), "{op_id}");
        }
        let books: i64 = conn
            .query_row("SELECT count(*) FROM book", [], |row| row.get(0))
            .unwrap();
        assert_eq!(books, 0);
    }

    #[test]
    fn too_many_entries_missing_chunks_and_oversize_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let (store, conn) = store(dir.path());
        let mut entries: Vec<(String, Vec<u8>)> = vec![
            ("mimetype".into(), EPUB_MIMETYPE.as_bytes().to_vec()),
            ("META-INF/container.xml".into(), b"x".to_vec()),
        ];
        for index in 0..MAX_ENTRIES {
            entries.push((format!("e/{index}.xhtml"), b"x".to_vec()));
        }
        let borrowed: Vec<(&str, &[u8])> = entries
            .iter()
            .map(|(name, body)| (name.as_str(), body.as_slice()))
            .collect();
        store.stage_chunk("many", 0, &zip_bytes(&borrowed)).unwrap();
        assert_eq!(
            store
                .finalize(&conn, "many", BookType::Textbook, "x")
                .unwrap_err()
                .code,
            ErrorCode::InvalidRequest
        );

        let epub = valid_epub();
        store.stage_chunk("gap", 0, &epub[..4]).unwrap();
        store.stage_chunk("gap", 2, &epub[4..]).unwrap();
        assert_eq!(
            store
                .finalize(&conn, "gap", BookType::Textbook, "x")
                .unwrap_err()
                .code,
            ErrorCode::InvalidRequest
        );

        let small = ImportStore::new(dir.path()).with_max_epub_bytes(8);
        assert_eq!(
            small.stage_chunk("big", 0, &epub).unwrap_err().code,
            ErrorCode::InvalidRequest
        );
        assert!(!dir.path().join("import").join("big").exists());
        assert_eq!(
            store.stage_chunk("bad id/../x", 0, b"x").unwrap_err().code,
            ErrorCode::InvalidRequest
        );
        assert_eq!(
            store.stage_chunk("empty", 0, b"").unwrap_err().code,
            ErrorCode::InvalidRequest
        );
    }

    #[test]
    fn stale_staging_directories_are_removed_on_cleanup() {
        let dir = tempfile::tempdir().unwrap();
        let (store, _) = store(dir.path());
        store.stage_chunk("fresh", 0, b"partial").unwrap();
        assert_eq!(store.cleanup_stale(SystemTime::now()).unwrap(), 0);
        assert!(dir.path().join("import").join("fresh").exists());
        let later = SystemTime::now() + STALE_STAGING + Duration::from_secs(60);
        assert_eq!(store.cleanup_stale(later).unwrap(), 1);
        assert!(!dir.path().join("import").join("fresh").exists());
        assert_eq!(store.cleanup_stale(later).unwrap(), 0);
    }
}
