use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use serde_json;

/// `file_metadata.source_url` 列的解释规则（P1(b)，设计方案 §4 W2）：
/// - **新写法**：JSON 数组文本，如 `["https://a","https://b"]` —— 一张图可以有多个来源网址；
/// - **旧写法**：裸网址文本（改之前写的那 5 行就是这种）。
///
/// 因为旧写法解析不成数组时按「单条」处理，**不需要任何数据迁移**：
/// 旧行读出来自然等于「只有一个元素的数组」。
pub fn parse_source_urls(raw: Option<&str>) -> Vec<String> {
    let Some(raw) = raw else { return Vec::new() };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if let Ok(list) = serde_json::from_str::<Vec<String>>(trimmed) {
        return list.into_iter().filter(|s| !s.trim().is_empty()).collect();
    }
    // 数组里混了非字符串（历史脏数据）：能转成字符串的留下，其余整条丢弃
    if let Ok(list) = serde_json::from_str::<Vec<serde_json::Value>>(trimmed) {
        return list
            .into_iter()
            .filter_map(|v| match v {
                serde_json::Value::String(s) => Some(s),
                serde_json::Value::Null => None,
                other => Some(other.to_string()),
            })
            .filter(|s| !s.trim().is_empty())
            .collect();
    }
    // 历史遗留：整列就是一个裸网址（不是合法 JSON）
    vec![trimmed.to_string()]
}

/// `parse_source_urls` 的反向：写回列文本。空列表 = 没有来源网址（写 NULL）。
pub fn serialize_source_urls(urls: &[String]) -> Option<String> {
    let cleaned: Vec<String> = urls
        .iter()
        .map(|u| u.trim())
        .filter(|u| !u.is_empty())
        .map(|u| u.to_string())
        .collect();
    if cleaned.is_empty() {
        return None;
    }
    serde_json::to_string(&cleaned).ok()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMetadata {
    pub file_id: String,
    pub path: String,
    pub tags: Option<serde_json::Value>,
    pub description: Option<String>,
    /// 列的原始文本。**不要直接读写它**——见 `parse_source_urls` 的两种写法。
    /// 为了不破坏既有读者（FFI / 前端），对外仍序列化成「第一条网址」。
    #[serde(default)]
    pub source_url: Option<String>,
    /// 来源网址（可多条，顺序即 UI 显示顺序）。**这是多值的对外入口**：
    /// 缺省（None）时按 `source_url` 列的文本解释，向后兼容单值写入。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_urls: Option<Vec<String>>,
    pub ai_data: Option<serde_json::Value>,
    pub category: Option<String>,
    pub updated_at: Option<i64>,
}

impl FileMetadata {
    /// 这张图的所有来源网址（旧的单值行读出来就是长度 1 的数组）。
    pub fn source_urls(&self) -> Vec<String> {
        if let Some(urls) = &self.source_urls {
            return urls.clone();
        }
        parse_source_urls(self.source_url.as_deref())
    }

    /// 覆盖写入来源网址。`[]` = 清空。
    ///
    /// `source_url` 同步成第一条，既是为了老读者（FFI / 前端的 `sourceUrl`），
    /// 也是为了让「读出来又整行写回」不把列的格式带偏。
    pub fn set_source_urls(&mut self, urls: Vec<String>) {
        let cleaned: Vec<String> = urls
            .into_iter()
            .map(|u| u.trim().to_string())
            .filter(|u| !u.is_empty())
            .collect();
        self.source_url = cleaned.first().cloned();
        self.source_urls = Some(cleaned);
    }

    /// 追加一条来源网址（去重）。返回是否真的新增了。
    pub fn push_source_url(&mut self, url: &str) -> bool {
        let url = url.trim();
        if url.is_empty() {
            return false;
        }
        let mut urls = self.source_urls();
        if urls.iter().any(|u| u == url) {
            return false;
        }
        urls.push(url.to_string());
        self.set_source_urls(urls);
        true
    }

    /// 写库用的列文本：`source_urls` 优先（显式多值），否则沿用 `source_url` 原样。
    pub fn source_url_text(&self) -> Option<String> {
        match &self.source_urls {
            Some(urls) => serialize_source_urls(urls),
            None => self.source_url.clone(),
        }
    }
}

pub fn upsert_file_metadata(conn: &Connection, metadata: &FileMetadata) -> Result<()> {
    conn.execute(
        "INSERT INTO file_metadata (file_id, path, tags, description, source_url, ai_data, category, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(file_id) DO UPDATE SET
            path = excluded.path,
            tags = excluded.tags,
            description = excluded.description,
            source_url = excluded.source_url,
            ai_data = excluded.ai_data,
            category = excluded.category,
            updated_at = excluded.updated_at",
        params![
            metadata.file_id,
            metadata.path,
            metadata.tags,
            metadata.description,
            metadata.source_url_text(),
            metadata.ai_data,
            metadata.category,
            metadata.updated_at
        ],
    )?;
    Ok(())
}

/// 行 → `FileMetadata`。四处查询共用（列序一致）。
///
/// `source_url` 列在这里被解释成多条：新写法是 JSON 数组、旧写法是裸网址，
/// 读出来都归一到 `source_urls`，同时把第一条留在 `source_url` 上给老读者。
fn row_to_metadata(row: &rusqlite::Row<'_>) -> Result<FileMetadata> {
    let raw: Option<String> = row.get(4)?;
    let urls = parse_source_urls(raw.as_deref());
    Ok(FileMetadata {
        file_id: row.get(0)?,
        path: row.get(1)?,
        tags: row.get(2)?,
        description: row.get(3)?,
        source_url: urls.first().cloned(),
        source_urls: if urls.is_empty() { None } else { Some(urls) },
        ai_data: row.get(5)?,
        category: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

pub fn get_metadata_by_id(conn: &Connection, file_id: &str) -> Result<Option<FileMetadata>> {
    let mut stmt = conn.prepare(
        "SELECT file_id, path, tags, description, source_url, ai_data, category, updated_at FROM file_metadata WHERE file_id = ?1"
    )?;
    
    let mut rows = stmt.query_map(params![file_id], |row| {
        row_to_metadata(row)
    })?;

    if let Some(result) = rows.next() {
        Ok(Some(result?))
    } else {
        Ok(None)
    }
}

/// 按 file_id 列表批量取元数据（单条 SQL IN 查询，分块防超占位符上限）。
/// 返回 HashMap<file_id, FileMetadata>，查不到的 id 不在映射中——调用方按需给默认值。
/// M6a 互联批量读端点用，避免逐条 N+1 查询。
pub fn get_metadata_by_ids(
    conn: &Connection,
    file_ids: &[String],
) -> Result<std::collections::HashMap<String, FileMetadata>> {
    let mut out = std::collections::HashMap::new();
    if file_ids.is_empty() {
        return Ok(out);
    }
    // SQLite 默认变量上限 999（新版 32766），按 500 分块稳妥。
    const CHUNK: usize = 500;
    for chunk in file_ids.chunks(CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "?").collect();
        let sql = format!(
            "SELECT file_id, path, tags, description, source_url, ai_data, category, updated_at
             FROM file_metadata WHERE file_id IN ({})",
            placeholders.join(",")
        );
        let mut stmt = conn.prepare(&sql)?;
        let params: Vec<&dyn rusqlite::ToSql> = chunk.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params.as_slice(), |row| {
            row_to_metadata(row)
        })?;
        for r in rows {
            let m = r?;
            out.insert(m.file_id.clone(), m);
        }
    }
    Ok(out)
}

pub fn get_all_metadata(conn: &Connection) -> Result<Vec<FileMetadata>> {
    let mut stmt = conn.prepare(
        "SELECT file_id, path, tags, description, source_url, ai_data, category, updated_at FROM file_metadata"
    )?;
    
    let metadata_iter = stmt.query_map([], |row| {
        row_to_metadata(row)
    })?;

    let mut results = Vec::new();
    for item in metadata_iter {
        results.push(item?);
    }
    Ok(results)
}

pub fn get_metadata_under_path(conn: &Connection, root_path: &str) -> Result<Vec<FileMetadata>> {
    let pattern = format!("{}%", root_path.replace("\\", "/"));
    let mut stmt = conn.prepare(
        "SELECT file_id, path, tags, description, source_url, ai_data, category, updated_at FROM file_metadata WHERE path LIKE ?1"
    )?;
    
    let metadata_iter = stmt.query_map(params![pattern], |row| {
        row_to_metadata(row)
    })?;

    let mut results = Vec::new();
    for item in metadata_iter {
        results.push(item?);
    }
    Ok(results)
}

/// 批量更新 category 字段（P1 内容分类用）。
/// 每条记录 (file_id, category) 在单事务内执行 UPDATE，避免长事务锁库。
pub fn update_category_batch(
    conn: &Connection,
    updates: &[(String, String)],
) -> Result<()> {
    if updates.is_empty() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "UPDATE file_metadata SET category = ?1, updated_at = ?2 WHERE file_id = ?3",
        )?;
        let now = chrono::Utc::now().timestamp();
        for (file_id, category) in updates {
            stmt.execute(params![category, now, file_id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// 取出所有有 tags 且在 file_index 中存在的记录的 (file_id, tags_json)，用于 P1 内容分类。
/// JOIN file_index 过滤掉已删除文件的残留 metadata，避免创建指向无效文件的专题。
pub fn get_all_tags_for_classification(conn: &Connection) -> Result<Vec<(String, serde_json::Value)>> {
    let mut stmt = conn.prepare(
        "SELECT m.file_id, m.tags FROM file_metadata m
         INNER JOIN file_index f ON m.file_id = f.file_id
         WHERE m.tags IS NOT NULL",
    )?;
    let iter = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, serde_json::Value>(1)?))
    })?;
    let mut out = Vec::new();
    for r in iter {
        out.push(r?);
    }
    Ok(out)
}

/// 统计每个 category 的数量（仅含 file_index 中存在的文件）。
pub fn get_category_stats(conn: &Connection) -> Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT COALESCE(m.category, ''), COUNT(*)
         FROM file_metadata m
         INNER JOIN file_index f ON m.file_id = f.file_id
         GROUP BY m.category",
    )?;
    let iter = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    let mut out = Vec::new();
    for r in iter {
        out.push(r?);
    }
    Ok(out)
}

/// 返回 file_index 总文件数（用于前端展示"待处理"比例）。
pub fn count_indexed_files(conn: &Connection) -> Result<i64> {
    conn.query_row("SELECT COUNT(*) FROM file_index", [], |row| row.get(0))
}

/// 返回有 tags 的文件数（已跑过 WD14 打标签的）。
pub fn count_files_with_tags(conn: &Connection) -> Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM file_metadata m
         INNER JOIN file_index f ON m.file_id = f.file_id
         WHERE m.tags IS NOT NULL",
        [],
        |row| row.get(0),
    )
}

pub fn delete_metadata_by_path(conn: &Connection, path: &str) -> Result<()> {
    let normalized_path = path.replace("\\", "/");
    
    // 删除单个文件元数据
    conn.execute(
        "DELETE FROM file_metadata WHERE path = ?",
        params![normalized_path],
    )?;
    
    // 如果是目录，递归删除
    let dir_pattern = format!("{}/%", normalized_path.trim_end_matches('/'));
    conn.execute(
        "DELETE FROM file_metadata WHERE path LIKE ?",
        params![dir_pattern],
    )?;
    
    Ok(())
}

pub fn migrate_metadata(conn: &Connection, old_id: &str, new_id: &str, new_path: &str) -> Result<()> {
    let normalized_path = new_path.replace("\\", "/");
    // 清理目标路径残留 (大小写不敏感)
    conn.execute(
        "DELETE FROM file_metadata WHERE lower(path) = lower(?1)",
        params![normalized_path],
    )?;
    conn.execute(
        "UPDATE file_metadata SET file_id = ?1, path = ?2 WHERE file_id = ?3",
        params![new_id, normalized_path, old_id],
    )?;
    Ok(())
}

pub fn copy_metadata(conn: &Connection, src_id: &str, dest_id: &str, dest_path: &str) -> Result<()> {
    let normalized_path = dest_path.replace("\\", "/");
    if let Some(mut meta) = get_metadata_by_id(conn, src_id)? {
        meta.file_id = dest_id.to_string();
        meta.path = normalized_path;
        upsert_file_metadata(conn, &meta)?;
    }
    Ok(())
}

pub fn migrate_metadata_dir(conn: &Connection, old_path: &str, new_path: &str) -> Result<()> {
    let old_normalized = super::normalize_path(old_path);
    let new_normalized = super::normalize_path(new_path);
    
    // 0. 清理目标路径残留 (大小写不敏感)
    let new_dir_prefix_clean = if new_normalized.ends_with('/') { new_normalized.clone() } else { format!("{}/", new_normalized) };
    let new_dir_pattern = format!("{}%", new_dir_prefix_clean);
    conn.execute(
        "DELETE FROM file_metadata WHERE lower(path) = lower(?1) OR lower(path) LIKE lower(?2)",
        params![new_normalized, new_dir_pattern],
    )?;

    // 1. 更新顶层文件夹 (如果有 metadata 的话)
    conn.execute(
        "UPDATE file_metadata SET path = ?1 WHERE path = ?2",
        params![new_normalized, old_normalized],
    )?;

    // 2. 批量更新子文件的路径 (Stable ID: ID remains unchanged)
    let old_dir_prefix = if old_normalized.ends_with('/') { old_normalized.clone() } else { format!("{}/", old_normalized) };
    let new_dir_prefix = if new_normalized.ends_with('/') { new_normalized.clone() } else { format!("{}/", new_normalized) };
    let dir_pattern = format!("{}%", old_dir_prefix);
    
    // SQLite SUBSTR starts at 1. Skip prefix char count.
    // IMPORTANT: SUBSTR in SQLite uses character index, not byte index.
    let skip_len = (old_dir_prefix.chars().count() + 1) as i32;

    conn.execute(
        "UPDATE file_metadata SET path = ?1 || SUBSTR(path, ?2) WHERE path LIKE ?3",
        params![new_dir_prefix, skip_len, dir_pattern],
    )?;
    
    Ok(())
}

pub fn copy_metadata_dir(conn: &Connection, src_path: &str, dest_path: &str) -> Result<()> {    let src_normalized = src_path.replace("\\", "/");
    let dest_normalized = dest_path.replace("\\", "/");
    
    let mut stmt = conn.prepare(
        "SELECT file_id, path FROM file_metadata WHERE path = ?1 OR path LIKE ?2"
    )?;
    
    let dir_pattern = format!("{}/%", src_normalized.trim_end_matches('/'));
    let rows = stmt.query_map(params![src_normalized, dir_pattern], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    
    let mut tasks = Vec::new();
    for row in rows {
        let (src_id, src_full_path) = row?;
        let relative_path = if src_full_path == src_normalized {
            "".to_string()
        } else {
            src_full_path[src_normalized.len()..].to_string()
        };
        
        let dest_full_path = format!("{}{}", dest_normalized, relative_path);
        let dest_id = super::generate_id(&dest_full_path);
        tasks.push((src_id, dest_id, dest_full_path));
    }
    
    for (src_id, dest_id, dest_full_path) in tasks {
        copy_metadata(conn, &src_id, &dest_id, &dest_full_path)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        crate::db::init_db(&conn).expect("init db");
        conn
    }

    #[test]
    fn get_metadata_by_ids_returns_only_requested() {
        let conn = setup();
        for (id, path) in [("id_a", "/a.png"), ("id_b", "/b.png")] {
            upsert_file_metadata(
                &conn,
                &FileMetadata {
                    file_id: id.into(),
                    path: path.into(),
                    tags: Some(serde_json::json!(["t1"])),
                    description: Some("d".into()),
                    source_url: None,
                    source_urls: None,
                    ai_data: None,
                    category: None,
                    updated_at: Some(1),
                },
            )
            .unwrap();
        }

        let got = get_metadata_by_ids(&conn, &["id_a".to_string(), "id_missing".to_string()]).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got["id_a"].description.as_deref(), Some("d"));
        assert!(!got.contains_key("id_missing"));

        // 空入参直接返回空映射
        assert!(get_metadata_by_ids(&conn, &[]).unwrap().is_empty());
    }
}
