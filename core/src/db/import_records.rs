//! `import_records`：迁移记录表（设计方案 §6.5）。
//!
//! 放 `.aurora/metadata.db` 而不是 `user_data.json`，是因为**记录要跟着库走**：换根目录
//! 不会误判「已迁过」，也不会把 A 库的迁移记到 B 库头上。
//!
//! 作用只有两个——信息展示（设置-存储面板的「上次导入报告」）+ 阻止自动弹提示。
//! **不是硬阻断**：合并是纯增量的，同 `source + source_root` 已有记录时按钮文案变成
//! 「已导入过，可重新导入（增量）」，重跑安全（§6.1 第 3 条末）。

use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRecord {
    pub id: i64,
    /// 来源标识：`pixcall`（二期是 `eagle`）
    pub source: String,
    /// 源库根路径（`.pixcall` 所在目录），normalize 后存
    pub source_root: String,
    /// 源侧格式版本（PixCall 是 `kvs['schema_version']`，本机 22）
    pub source_schema_version: String,
    pub imported_at: i64,
    /// §4.7 的完整报告，UI 的「上次导入报告」展开区读这一列（含 `excludedTrashNames`）
    pub report_json: String,
    pub matched: i64,
    pub unmatched: i64,
    /// 因我们侧已有内容而让位的总数（描述 + 来源链接两栏之和）
    pub skipped_existing: i64,
    pub skipped_unsupported_type: i64,
    pub topic_members_skipped_type: i64,
}

pub fn create_table(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS import_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            source_root TEXT NOT NULL,
            source_schema_version TEXT NOT NULL,
            imported_at INTEGER NOT NULL,
            report_json TEXT NOT NULL,
            matched INTEGER NOT NULL DEFAULT 0,
            unmatched INTEGER NOT NULL DEFAULT 0,
            skipped_existing INTEGER NOT NULL DEFAULT 0,
            skipped_unsupported_type INTEGER NOT NULL DEFAULT 0,
            topic_members_skipped_type INTEGER NOT NULL DEFAULT 0
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_import_records_source_root \
         ON import_records(source, source_root, imported_at DESC)",
        [],
    )?;
    Ok(())
}

/// 记一次导入。`report_json` 直接存 §4.7 报告，前端按需渲染，不在库里拆列。
pub fn insert(
    conn: &Connection,
    source: &str,
    source_root: &str,
    source_schema_version: &str,
    report_json: &str,
    summary: &InsertSummary,
    imported_at: i64,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO import_records (
            source, source_root, source_schema_version, imported_at, report_json,
            matched, unmatched, skipped_existing, skipped_unsupported_type,
            topic_members_skipped_type
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            source,
            source_root,
            source_schema_version,
            imported_at,
            report_json,
            summary.matched,
            summary.unmatched,
            summary.skipped_existing,
            summary.skipped_unsupported_type,
            summary.topic_members_skipped_type
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

#[derive(Debug, Clone, Copy, Default)]
pub struct InsertSummary {
    pub matched: i64,
    pub unmatched: i64,
    pub skipped_existing: i64,
    pub skipped_unsupported_type: i64,
    pub topic_members_skipped_type: i64,
}

/// 同 `source + source_root` 的最近一条记录：判定「已迁移过」（§6.5），
/// 也是设置面板「上次导入报告」的数据源（§6.1 第 4 条）。
pub fn latest_for(
    conn: &Connection,
    source: &str,
    source_root: &str,
) -> Result<Option<ImportRecord>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM import_records WHERE source = ?1 AND source_root = ?2 \
         ORDER BY imported_at DESC, id DESC LIMIT 1",
        COLUMNS
    ))?;
    let mut rows = stmt.query_map(params![source, source_root], row_to_record)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// 本库全部导入记录（换过源库根目录时 UI 要能都列出来）。
pub fn list_all(conn: &Connection) -> Result<Vec<ImportRecord>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM import_records ORDER BY imported_at DESC, id DESC",
        COLUMNS
    ))?;
    let rows = stmt.query_map([], row_to_record)?;
    rows.collect()
}

const COLUMNS: &str = "id, source, source_root, source_schema_version, imported_at, report_json, \
     matched, unmatched, skipped_existing, skipped_unsupported_type, topic_members_skipped_type";

fn row_to_record(row: &rusqlite::Row) -> Result<ImportRecord> {
    Ok(ImportRecord {
        id: row.get(0)?,
        source: row.get(1)?,
        source_root: row.get(2)?,
        source_schema_version: row.get(3)?,
        imported_at: row.get(4)?,
        report_json: row.get(5)?,
        matched: row.get(6)?,
        unmatched: row.get(7)?,
        skipped_existing: row.get(8)?,
        skipped_unsupported_type: row.get(9)?,
        topic_members_skipped_type: row.get(10)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        create_table(&c).unwrap();
        c
    }

    #[test]
    fn latest_is_per_source_root() {
        let c = conn();
        insert(&c, "pixcall", "C:/LibA", "22", "{}", &InsertSummary::default(), 100).unwrap();
        insert(&c, "pixcall", "C:/LibB", "22", "{}", &InsertSummary::default(), 200).unwrap();
        let hit = latest_for(&c, "pixcall", "C:/LibA").unwrap().unwrap();
        assert_eq!(hit.imported_at, 100, "换根目录不能把 B 库的记录算到 A 库头上（§6.5）");
        assert_eq!(latest_for(&c, "pixcall", "C:/LibC").unwrap(), None);
    }

    #[test]
    fn latest_picks_the_newest_when_reimported() {
        let c = conn();
        insert(&c, "pixcall", "C:/LibA", "22", r#"{"a":1}"#, &InsertSummary::default(), 100).unwrap();
        insert(&c, "pixcall", "C:/LibA", "23", r#"{"a":2}"#, &InsertSummary::default(), 300).unwrap();
        let hit = latest_for(&c, "pixcall", "C:/LibA").unwrap().unwrap();
        assert_eq!(hit.imported_at, 300);
        assert_eq!(hit.source_schema_version, "23");
        assert_eq!(hit.report_json, r#"{"a":2}"#);
    }

    #[test]
    fn summary_columns_round_trip() {
        let c = conn();
        let summary = InsertSummary {
            matched: 13,
            unmatched: 0,
            skipped_existing: 1,
            skipped_unsupported_type: 52,
            topic_members_skipped_type: 0,
        };
        insert(&c, "pixcall", "C:/NVIDIA", "22", "{}", &summary, 1).unwrap();
        let got = latest_for(&c, "pixcall", "C:/NVIDIA").unwrap().unwrap();
        assert_eq!((got.matched, got.unmatched, got.skipped_existing), (13, 0, 1));
        assert_eq!(
            (got.skipped_unsupported_type, got.topic_members_skipped_type),
            (52, 0)
        );
        assert_eq!(list_all(&c).unwrap().len(), 1);
    }

    /// `init_db` 每次开库都跑一遍，建表必须幂等。
    #[test]
    fn create_table_is_idempotent() {
        let c = conn();
        create_table(&c).unwrap();
    }
}
