use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};

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
    pub topic_type: Option<String>,
    pub cover_file_id: Option<String>,
    pub background_file_id: Option<String>,
    pub cover_crop: Option<CoverCropData>,
    pub people_ids: Vec<String>,
    pub file_ids: Vec<String>,
    pub source_url: Option<String>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
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
            updated_at INTEGER
        )",
        [],
    )?;
    Ok(())
}

pub fn get_all_topics(conn: &Connection) -> Result<Vec<Topic>> {
    let mut stmt = conn.prepare(
        "SELECT id, parent_id, name, description, topic_type, 
                cover_file_id, background_file_id,
                cover_crop_x, cover_crop_y, cover_crop_width, cover_crop_height,
                people_ids, file_ids, source_url, created_at, updated_at 
         FROM topics"
    )?;

    let topic_iter = stmt.query_map([], |row| {
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

        let people_ids_str: Option<String> = row.get(11)?;
        let people_ids = people_ids_str
            .map(|s| s.split(',').map(|id| id.to_string()).collect())
            .unwrap_or_default();

        let file_ids_str: Option<String> = row.get(12)?;
        let file_ids = file_ids_str
            .map(|s| s.split(',').map(|id| id.to_string()).collect())
            .unwrap_or_default();

        Ok(Topic {
            id: row.get(0)?,
            parent_id: row.get(1)?,
            name: row.get(2)?,
            description: row.get(3)?,
            topic_type: row.get(4)?,
            cover_file_id: row.get(5)?,
            background_file_id: row.get(6)?,
            cover_crop,
            people_ids,
            file_ids,
            source_url: row.get(13)?,
            created_at: row.get(14)?,
            updated_at: row.get(15)?,
        })
    })?;

    let mut topics = Vec::new();
    for topic in topic_iter {
        topics.push(topic?);
    }
    Ok(topics)
}

pub fn upsert_topic(conn: &Connection, topic: &Topic) -> Result<()> {
    let (x, y, width, height) = if let Some(crop) = &topic.cover_crop {
        (Some(crop.x), Some(crop.y), Some(crop.width), Some(crop.height))
    } else {
        (None, None, None, None)
    };

    let people_ids_str = if topic.people_ids.is_empty() {
        None
    } else {
        Some(topic.people_ids.join(","))
    };

    let file_ids_str = if topic.file_ids.is_empty() {
        None
    } else {
        Some(topic.file_ids.join(","))
    };

    conn.execute(
        "INSERT INTO topics (id, parent_id, name, description, topic_type, 
                           cover_file_id, background_file_id,
                           cover_crop_x, cover_crop_y, cover_crop_width, cover_crop_height,
                           people_ids, file_ids, source_url, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
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
            people_ids = excluded.people_ids,
            file_ids = excluded.file_ids,
            source_url = excluded.source_url,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at",
        params![
            topic.id,
            topic.parent_id,
            topic.name,
            topic.description,
            topic.topic_type,
            topic.cover_file_id,
            topic.background_file_id,
            x, y, width, height,
            people_ids_str,
            file_ids_str,
            topic.source_url,
            topic.created_at,
            topic.updated_at
        ],
    )?;
    Ok(())
}

pub fn delete_topic(conn: &Connection, topic_id: &str) -> Result<()> {
    conn.execute("DELETE FROM topics WHERE id = ?1", params![topic_id])?;
    Ok(())
}
