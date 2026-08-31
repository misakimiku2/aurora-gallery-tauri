use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverCropData {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Topic {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub topic_type: Option<String>,
    pub cover_file_id: Option<String>,
    pub background_file_id: Option<String>,
    pub cover_crop: Option<CoverCropData>,
    pub people_ids: Vec<String>,
    pub file_ids: Vec<String>,
    pub source_url: Option<String>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub source_type: Option<String>,
    pub work_name: Option<String>,
    pub work_name_cn: Option<String>,
    /// 缓存的成员数量。列表查询时填充，避免 split file_ids。
    /// `file_ids` 字段在列表查询时为空，需通过 `get_topic_files` / `get_topic_files_paginated` 懒加载。
    #[serde(default)]
    pub file_count: i32,
}

/// 列表查询返回的专题摘要（不含全量 file_ids）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicSummary {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub topic_type: Option<String>,
    pub cover_file_id: Option<String>,
    pub background_file_id: Option<String>,
    pub cover_crop: Option<CoverCropData>,
    pub people_ids: Vec<String>,
    pub source_url: Option<String>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub source_type: Option<String>,
    pub work_name: Option<String>,
    pub work_name_cn: Option<String>,
    pub file_count: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaginatedFiles {
    pub files: Vec<String>,
    pub total: usize,
    pub has_more: bool,
}

pub fn create_table(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS topics (
            id TEXT PRIMARY KEY,
            parent_id TEXT,
            name TEXT NOT NULL,
            description TEXT,
            topic_type TEXT,
            cover_file_id TEXT,
            background_file_id TEXT,
            cover_crop_x REAL,
            cover_crop_y REAL,
            cover_crop_width REAL,
            cover_crop_height REAL,
            people_ids TEXT,
            file_ids TEXT,
            source_url TEXT,
            created_at INTEGER,
            updated_at INTEGER,
            source_type TEXT,
            work_name TEXT,
            work_name_cn TEXT,
            file_count INTEGER DEFAULT 0
        )",
        [],
    )?;
    Ok(())
}

/// 把单个 topic 行映射为 Topic（file_ids / people_ids 留空，列表场景不填充）。
fn row_to_topic_meta(row: &rusqlite::Row) -> Result<Topic> {
    let cover_crop_x: Option<f64> = row.get(7)?;
    let cover_crop = if let Some(x) = cover_crop_x {
        Some(CoverCropData {
            x,
            y: row.get(8)?,
            width: row.get(9)?,
            height: row.get(10)?,
        })
    } else {
        None
    };

    Ok(Topic {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        name: row.get(2)?,
        description: row.get(3)?,
        topic_type: row.get(4)?,
        cover_file_id: row.get(5)?,
        background_file_id: row.get(6)?,
        cover_crop,
        people_ids: Vec::new(),
        file_ids: Vec::new(),
        source_url: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
        source_type: row.get(16)?,
        work_name: row.get(17)?,
        work_name_cn: row.get(18)?,
        file_count: row.get::<_, Option<i32>>(19)?.unwrap_or(0),
    })
}

const TOPIC_COLUMNS: &str = "id, parent_id, name, description, topic_type,
                cover_file_id, background_file_id,
                cover_crop_x, cover_crop_y, cover_crop_width, cover_crop_height,
                people_ids, file_ids, source_url, created_at, updated_at,
                source_type, work_name, work_name_cn, file_count";

/// 列表查询：返回所有专题，**不填充 file_ids**（保持空），`file_count` 由缓存列提供。
/// `cover_file_id` 为空时，调用方可通过 `get_topic_cover_previews` 取前 N 张。
pub fn get_all_topics(conn: &Connection) -> Result<Vec<Topic>> {
    let mut stmt = conn.prepare(&format!("SELECT {} FROM topics", TOPIC_COLUMNS))?;
    let topic_iter = stmt.query_map([], row_to_topic_meta)?;
    let mut topics = Vec::new();
    for topic in topic_iter {
        topics.push(topic?);
    }
    Ok(topics)
}

/// 写入专题元数据。**不写 file_ids / people_ids 字符串列**（置空），成员关系由
/// `set_topic_files` / `set_topic_people` 维护。`file_count` 不在此更新。
pub fn upsert_topic(conn: &Connection, topic: &Topic) -> Result<()> {
    let (x, y, width, height) = if let Some(crop) = &topic.cover_crop {
        (Some(crop.x), Some(crop.y), Some(crop.width), Some(crop.height))
    } else {
        (None, None, None, None)
    };

    conn.execute(
        "INSERT INTO topics (id, parent_id, name, description, topic_type,
                           cover_file_id, background_file_id,
                           cover_crop_x, cover_crop_y, cover_crop_width, cover_crop_height,
                           people_ids, file_ids, source_url, created_at, updated_at,
                           source_type, work_name, work_name_cn, file_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, NULL, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
         ON CONFLICT(id) DO UPDATE SET
            parent_id = excluded.parent_id,
            name = excluded.name,
            description = excluded.description,
            topic_type = excluded.topic_type,
            cover_file_id = excluded.cover_file_id,
            background_file_id = excluded.background_file_id,
            cover_crop_x = excluded.cover_crop_x,
            cover_crop_y = excluded.cover_crop_y,
            cover_crop_width = excluded.cover_crop_width,
            cover_crop_height = excluded.cover_crop_height,
            people_ids = NULL,
            file_ids = NULL,
            source_url = excluded.source_url,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            source_type = excluded.source_type,
            work_name = excluded.work_name,
            work_name_cn = excluded.work_name_cn,
            file_count = excluded.file_count",
        params![
            topic.id,
            topic.parent_id,
            topic.name,
            topic.description,
            topic.topic_type,
            topic.cover_file_id,
            topic.background_file_id,
            x, y, width, height,
            topic.source_url,
            topic.created_at,
            topic.updated_at,
            topic.source_type,
            topic.work_name,
            topic.work_name_cn,
            topic.file_count
        ],
    )?;
    Ok(())
}

pub fn delete_topic(conn: &Connection, topic_id: &str) -> Result<()> {
    conn.execute("DELETE FROM topics WHERE id = ?1", params![topic_id])?;
    conn.execute("DELETE FROM topic_files WHERE topic_id = ?1", params![topic_id])?;
    conn.execute("DELETE FROM topic_people WHERE topic_id = ?1", params![topic_id])?;
    Ok(())
}

/// 按 source_type 批量删除专题（含级联删 topic_files / topic_people）。
/// P1/P2 重跑前清理旧专题用。返回删除的专题 id 列表。
pub fn delete_topics_by_source_type(conn: &Connection, source_type: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT id FROM topics WHERE source_type = ?1")?;
    let ids: Vec<String> = stmt
        .query_map(params![source_type], |row| row.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);
    for id in &ids {
        delete_topic(conn, id)?;
    }
    Ok(ids)
}

/// 按作品名查专题（元数据，不含成员）。
pub fn find_topic_by_work_name(conn: &Connection, work_name: &str) -> Result<Option<Topic>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM topics WHERE work_name = ?1",
        TOPIC_COLUMNS
    ))?;
    let mut topic_iter = stmt.query_map(params![work_name], row_to_topic_meta)?;
    if let Some(topic) = topic_iter.next() {
        Ok(Some(topic?))
    } else {
        Ok(None)
    }
}

// ============ topic_files 成员关系 ============

/// 全量替换某专题的文件成员（删除旧成员后批量插入）。同时刷新 file_count 缓存。
pub fn set_topic_files(conn: &Connection, topic_id: &str, file_ids: &[String]) -> Result<()> {
    conn.execute("DELETE FROM topic_files WHERE topic_id = ?1", params![topic_id])?;
    insert_topic_files(conn, topic_id, file_ids)?;
    update_file_count(conn, topic_id)?;
    Ok(())
}

/// 追加文件成员（忽略已存在的）。同时刷新 file_count 缓存。
pub fn add_files_to_topic(conn: &Connection, topic_id: &str, file_ids: &[String]) -> Result<()> {
    if file_ids.is_empty() {
        return Ok(());
    }
    insert_topic_files(conn, topic_id, file_ids)?;
    update_file_count(conn, topic_id)?;
    Ok(())
}

/// 移除单个文件成员。同时刷新 file_count 缓存。
pub fn remove_file_from_topic(conn: &Connection, topic_id: &str, file_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM topic_files WHERE topic_id = ?1 AND file_id = ?2",
        params![topic_id, file_id],
    )?;
    update_file_count(conn, topic_id)?;
    Ok(())
}

/// 取某专题的全部文件成员（按 position 排序）。用于需要全量列表的场景（小专题）。
pub fn get_topic_files(conn: &Connection, topic_id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT file_id FROM topic_files WHERE topic_id = ?1 ORDER BY position",
    )?;
    let iter = stmt.query_map(params![topic_id], |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for r in iter {
        out.push(r?);
    }
    Ok(out)
}

/// 分页取文件成员。
pub fn get_topic_files_paginated(
    conn: &Connection,
    topic_id: &str,
    offset: usize,
    limit: usize,
) -> Result<PaginatedFiles> {
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM topic_files WHERE topic_id = ?1",
        params![topic_id],
        |row| row.get(0),
    )?;
    let mut stmt = conn.prepare(
        "SELECT file_id FROM topic_files WHERE topic_id = ?1 ORDER BY position LIMIT ?2 OFFSET ?3",
    )?;
    let iter = stmt.query_map(params![topic_id, limit as i64, offset as i64], |row| {
        row.get::<_, String>(0)
    })?;
    let mut files = Vec::new();
    for r in iter {
        files.push(r?);
    }
    let has_more = offset + files.len() < total as usize;
    Ok(PaginatedFiles {
        files,
        total: total as usize,
        has_more,
    })
}

/// 取多个专题的前 N 张文件作封面预览（按 position 排序）。
/// 返回 HashMap<topic_id, Vec<file_id>>。
pub fn get_topic_cover_previews(
    conn: &Connection,
    topic_ids: &[String],
    preview_count: usize,
) -> Result<HashMap<String, Vec<String>>> {
    let mut out = HashMap::new();
    if topic_ids.is_empty() || preview_count == 0 {
        return Ok(out);
    }
    let mut stmt = conn.prepare(
        "SELECT file_id FROM topic_files WHERE topic_id = ?1 ORDER BY position LIMIT ?2",
    )?;
    for tid in topic_ids {
        let iter = stmt.query_map(params![tid, preview_count as i64], |row| {
            row.get::<_, String>(0)
        })?;
        let mut previews = Vec::new();
        for r in iter {
            previews.push(r?);
        }
        out.insert(tid.clone(), previews);
    }
    Ok(out)
}

/// 反向查：图属于哪些专题（走 idx_topic_files_file 索引）。
pub fn find_topics_containing_file(conn: &Connection, file_id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT topic_id FROM topic_files WHERE file_id = ?1",
    )?;
    let iter = stmt.query_map(params![file_id], |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for r in iter {
        out.push(r?);
    }
    Ok(out)
}

// ============ topic_people 成员关系 ============

/// 全量替换某专题的关联人物。
pub fn set_topic_people(conn: &Connection, topic_id: &str, people_ids: &[String]) -> Result<()> {
    conn.execute("DELETE FROM topic_people WHERE topic_id = ?1", params![topic_id])?;
    insert_topic_people(conn, topic_id, people_ids)?;
    Ok(())
}

/// 追加关联人物（忽略已存在的）。
pub fn add_people_to_topic(conn: &Connection, topic_id: &str, people_ids: &[String]) -> Result<()> {
    if people_ids.is_empty() {
        return Ok(());
    }
    insert_topic_people(conn, topic_id, people_ids)?;
    Ok(())
}

/// 移除单个关联人物。
pub fn remove_person_from_topic(conn: &Connection, topic_id: &str, people_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM topic_people WHERE topic_id = ?1 AND people_id = ?2",
        params![topic_id, people_id],
    )?;
    Ok(())
}

/// 取某专题的全部关联人物（按 position 排序）。
pub fn get_topic_people(conn: &Connection, topic_id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT people_id FROM topic_people WHERE topic_id = ?1 ORDER BY position",
    )?;
    let iter = stmt.query_map(params![topic_id], |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for r in iter {
        out.push(r?);
    }
    Ok(out)
}

// ============ 内部辅助 ============

fn insert_topic_files(conn: &Connection, topic_id: &str, file_ids: &[String]) -> Result<()> {
    if file_ids.is_empty() {
        return Ok(());
    }
    // 起始 position = 当前已有成员数
    let start: i64 = conn.query_row(
        "SELECT COUNT(*) FROM topic_files WHERE topic_id = ?1",
        params![topic_id],
        |row| row.get(0),
    )?;
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO topic_files (topic_id, file_id, position) VALUES (?1, ?2, ?3)",
        )?;
        for (i, fid) in file_ids.iter().enumerate() {
            stmt.execute(params![topic_id, fid, start + i as i64])?;
        }
    }
    tx.commit()?;
    Ok(())
}

fn insert_topic_people(conn: &Connection, topic_id: &str, people_ids: &[String]) -> Result<()> {
    if people_ids.is_empty() {
        return Ok(());
    }
    let start: i64 = conn.query_row(
        "SELECT COUNT(*) FROM topic_people WHERE topic_id = ?1",
        params![topic_id],
        |row| row.get(0),
    )?;
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO topic_people (topic_id, people_id, position) VALUES (?1, ?2, ?3)",
        )?;
        for (i, pid) in people_ids.iter().enumerate() {
            stmt.execute(params![topic_id, pid, start + i as i64])?;
        }
    }
    tx.commit()?;
    Ok(())
}

fn update_file_count(conn: &Connection, topic_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE topics SET file_count = (SELECT COUNT(*) FROM topic_files WHERE topic_id = ?1) WHERE id = ?1",
        params![topic_id],
    )?;
    Ok(())
}

/// 一次性回填：把现有 topics 表 file_ids / people_ids TEXT 列迁移到 topic_files / topic_people。
/// 幂等：若 topic_files 已有数据则跳过该专题。
pub fn backfill_association_tables(conn: &Connection) -> Result<()> {
    // 取出仍有 file_ids / people_ids 字符串的专题（迁移期过渡兼容）
    let mut stmt = conn.prepare(
        "SELECT id, people_ids, file_ids FROM topics
         WHERE people_ids IS NOT NULL OR file_ids IS NOT NULL",
    )?;
    let rows: Vec<(String, Option<String>, Option<String>)> = stmt
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    for (topic_id, people_str, file_str) in rows {
        // 跳过已回填的专题（topic_files 已有成员 且 topic_people 也已回填）
        let already_files: i64 = conn.query_row(
            "SELECT COUNT(*) FROM topic_files WHERE topic_id = ?1",
            params![&topic_id],
            |row| row.get(0),
        )?;
        let already_people: i64 = conn.query_row(
            "SELECT COUNT(*) FROM topic_people WHERE topic_id = ?1",
            params![&topic_id],
            |row| row.get(0),
        )?;

        // 解析 file_ids 字符串（这是迁移期唯一保留 split 的地方）
        let file_ids: Vec<String> = file_str
            .as_deref()
            .map(|s| s.split(',').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect())
            .unwrap_or_default();
        let people_ids: Vec<String> = people_str
            .as_deref()
            .map(|s| s.split(',').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect())
            .unwrap_or_default();

        if already_files == 0 && !file_ids.is_empty() {
            insert_topic_files(conn, &topic_id, &file_ids)?;
        }
        if already_people == 0 && !people_ids.is_empty() {
            insert_topic_people(conn, &topic_id, &people_ids)?;
        }

        // 刷新 file_count 缓存
        update_file_count(conn, &topic_id)?;
    }
    Ok(())
}
