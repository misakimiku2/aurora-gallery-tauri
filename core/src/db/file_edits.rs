use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 轻量非破坏图片调整(设计文档 docs/superpowers/specs/2026-11-13-lightweight-image-adjust-design.md §5):
/// 每图一组 AdjustParams JSON,原图永不写回。本表是调整的唯一事实源。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEditEntry {
    pub file_id: String,
    /// AdjustParams JSON 文本(src-tauri/src/image_adjust.rs 是权威 schema)。
    pub params: String,
    pub updated_at: i64,
}

pub fn create_table(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS file_edits (
            file_id TEXT PRIMARY KEY,
            params TEXT NOT NULL,
            updated_at INTEGER
        )",
        [],
    )?;
    Ok(())
}

/// 读单图参数(无调整返回 None)。
pub fn get_params(conn: &Connection, file_id: &str) -> Result<Option<String>> {
    conn.query_row(
        "SELECT params FROM file_edits WHERE file_id = ?1",
        params![file_id],
        |row| row.get(0),
    )
    .optional()
}

/// 写/覆盖单图参数(全默认时应改走 clear_params,不落行)。
pub fn set_params(conn: &Connection, file_id: &str, params_json: &str) -> Result<()> {
    let now = chrono::Utc::now().timestamp();
    conn.execute(
        "INSERT INTO file_edits (file_id, params, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(file_id) DO UPDATE SET params = excluded.params, updated_at = excluded.updated_at",
        params![file_id, params_json, now],
    )?;
    Ok(())
}

/// 清除单图参数(重置)。返回是否真的删了行。
pub fn clear_params(conn: &Connection, file_id: &str) -> Result<bool> {
    let n = conn.execute("DELETE FROM file_edits WHERE file_id = ?1", params![file_id])?;
    Ok(n > 0)
}

/// 按文件路径取参数(缩略图管线按路径查;file_index.path 与传入路径可能存在
/// 反斜杠/斜杠差异,两个形态都试,命中即用)。
pub fn get_params_by_path(conn: &Connection, path: &str) -> Result<Option<String>> {
    let normalized = super::normalize_path(path);
    if normalized == path {
        return conn
            .query_row(
                "SELECT fe.params FROM file_edits fe
                 JOIN file_index fi ON fi.file_id = fe.file_id
                 WHERE fi.path = ?1",
                params![path],
                |row| row.get(0),
            )
            .optional();
    }
    conn.query_row(
        "SELECT fe.params FROM file_edits fe
         JOIN file_index fi ON fi.file_id = fe.file_id
         WHERE fi.path = ?1 OR fi.path = ?2",
        params![path, normalized],
        |row| row.get(0),
    )
    .optional()
}

/// 全量拉取(前端启动/bootstrap 用;只有调过的图才有行,量级可控)。
pub fn get_all(conn: &Connection) -> Result<Vec<FileEditEntry>> {
    let mut stmt = conn.prepare("SELECT file_id, params, updated_at FROM file_edits")?;
    let rows = stmt.query_map([], |row| {
        Ok(FileEditEntry {
            file_id: row.get(0)?,
            params: row.get(1)?,
            updated_at: row.get(2)?,
        })
    })?;
    rows.collect()
}

/// 批量按路径取参数(缩略图批量命令一次查齐,避免 rayon 并发抢同一把连接锁)。
/// 返回 path → params JSON;传入路径里命中不了的(没调过)不出现。
pub fn load_params_for_paths(conn: &Connection, paths: &[String]) -> Result<HashMap<String, String>> {
    let mut out = HashMap::new();
    for chunk in paths.chunks(500) {
        // 每个路径两个形态(原始/归一化),IN 占位符动态拼
        let placeholders = chunk
            .iter()
            .chain(chunk.iter())
            .enumerate()
            .map(|(i, _)| format!("?{}", i + 1))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT fi.path, fe.params FROM file_edits fe
             JOIN file_index fi ON fi.file_id = fe.file_id
             WHERE fi.path IN ({})",
            placeholders
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut all_params: Vec<String> = Vec::with_capacity(chunk.len() * 2);
        for p in chunk {
            all_params.push(p.clone());
            all_params.push(super::normalize_path(p));
        }
        let mut rows = stmt.query(rusqlite::params_from_iter(all_params.iter()))?;
        while let Some(row) = rows.next()? {
            let path: String = row.get(0)?;
            let params: String = row.get(1)?;
            out.entry(path).or_insert(params);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        super::super::file_index::create_table(&conn).expect("create file_index");
        create_table(&conn).expect("create file_edits");
        conn
    }

    fn insert_file(conn: &Connection, file_id: &str, path: &str) {
        conn.execute(
            "INSERT INTO file_index (file_id, path, name, file_type) VALUES (?1, ?2, 'a.jpg', 'Image')",
            params![file_id, path],
        )
        .expect("insert file_index");
    }

    #[test]
    fn set_get_clear_roundtrip() {
        let conn = setup();
        insert_file(&conn, "f1", "C:/pics/a.jpg");
        assert_eq!(get_params(&conn, "f1").unwrap(), None);
        set_params(&conn, "f1", r#"{"v":1}"#).unwrap();
        assert_eq!(get_params(&conn, "f1").unwrap(), Some(r#"{"v":1}"#.to_string()));
        // 覆盖写
        set_params(&conn, "f1", r#"{"v":2}"#).unwrap();
        assert_eq!(get_params(&conn, "f1").unwrap(), Some(r#"{"v":2}"#.to_string()));
        assert!(clear_params(&conn, "f1").unwrap());
        assert!(!clear_params(&conn, "f1").unwrap());
        assert_eq!(get_params(&conn, "f1").unwrap(), None);
    }

    #[test]
    fn get_params_by_path_normalizes_separators() {
        let conn = setup();
        // file_index 里存的是归一化斜杠路径
        insert_file(&conn, "f1", "C:/pics/a.jpg");
        // 传入 Windows 反斜杠形态也能命中
        let got = get_params_by_path(&conn, "C:\\pics\\a.jpg").unwrap();
        assert!(got.is_none(), "未写过参数时应为 None");
        set_params(&conn, "f1", r#"{"v":1}"#).unwrap();
        let got = get_params_by_path(&conn, "C:\\pics\\a.jpg").unwrap();
        assert_eq!(got, Some(r#"{"v":1}"#.to_string()));
    }

    #[test]
    fn load_params_for_paths_chunks_and_maps() {
        let conn = setup();
        for i in 0..600 {
            insert_file(&conn, &format!("f{}", i), &format!("C:/pics/{}.jpg", i));
            set_params(&conn, &format!("f{}", i), "{}").unwrap();
        }
        let paths: Vec<String> = (0..600).map(|i| format!("C:/pics/{}.jpg", i)).collect();
        let map = load_params_for_paths(&conn, &paths).unwrap();
        assert_eq!(map.len(), 600, "跨 500 分块也要全部命中");
    }
}
