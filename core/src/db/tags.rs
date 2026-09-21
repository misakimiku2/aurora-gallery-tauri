//! 标签的独立存储（M4a D10=②）。
//!
//! 词表从桌面的 `file_metadata.tags` JSON 列升级为两张表：`tags` 是可查询的词表，
//! `file_tags` 是文件与标签的多对多。**Kotlin 侧的标签只读写这里**，
//! `file_metadata.tags` 那一列在安卓库里不再被写入（桌面路径不受影响）。
//! 单一写入者是 `set_file_tags` / `add_tags_to_files`，UI 侧不许自己拼 JSON。

use rusqlite::{params, Connection, Result};

/// 关联表里 `position` 的语义 = 该标签在这张图上的先后次序（TagEditDialog 的显示顺序）。
pub fn create_table(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS tags (
            tag TEXT PRIMARY KEY
        )",
        [],
    )?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS file_tags (
            file_id TEXT NOT NULL,
            tag TEXT NOT NULL,
            position INTEGER NOT NULL,
            PRIMARY KEY (file_id, tag)
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag)",
        [],
    )?;
    Ok(())
}

/// 去掉空串与重复项，保留首次出现的顺序。
fn normalize(tags: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    tags.iter()
        .filter(|t| !t.trim().is_empty())
        .filter(|t| seen.insert(t.clone()))
        .cloned()
        .collect()
}

fn upsert_vocabulary(conn: &Connection, tags: &[String]) -> Result<()> {
    let mut stmt = conn.prepare_cached("INSERT OR IGNORE INTO tags (tag) VALUES (?1)")?;
    for tag in tags {
        stmt.execute(params![tag])?;
    }
    Ok(())
}

fn next_position(conn: &Connection, file_id: &str) -> Result<i64> {
    conn.query_row(
        "SELECT COALESCE(MAX(position) + 1, 0) FROM file_tags WHERE file_id = ?1",
        params![file_id],
        |row| row.get(0),
    )
}

fn insert_membership(conn: &Connection, file_id: &str, tag: &str, position: i64) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO file_tags (file_id, tag, position) VALUES (?1, ?2, ?3)",
        params![file_id, tag, position],
    )?;
    Ok(())
}

/// 设置某张图的完整标签集合（整体替换）。空集合 = 该图不再有标签。
///
/// 词表只增不删：把最后一个文件上的某标签去掉，这个词仍留在 `tags` 里、计数为 0
/// （对齐 React 侧「词表里有但没文件用的标签仍出现在分组里」）。删词是 `remove_tag`。
pub fn set_file_tags(conn: &Connection, file_id: &str, tags: &[String]) -> Result<()> {
    let tags = normalize(tags);
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM file_tags WHERE file_id = ?1", params![file_id])?;
    upsert_vocabulary(&tx, &tags)?;
    for (i, tag) in tags.iter().enumerate() {
        insert_membership(&tx, file_id, tag, i as i64)?;
    }
    tx.commit()
}

/// 批量贴标签（查看器长按菜单 / 选择栏「更多」的粘贴）：**一个事务**内完成，
/// 不做 N 次整行写。已有该标签的文件跳过，不重复也不改变原有次序。
pub fn add_tags_to_files(conn: &Connection, file_ids: &[String], tags: &[String]) -> Result<()> {
    let tags = normalize(tags);
    if tags.is_empty() || file_ids.is_empty() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    upsert_vocabulary(&tx, &tags)?;
    {
        let mut has_tag =
            tx.prepare_cached("SELECT 1 FROM file_tags WHERE file_id = ?1 AND tag = ?2")?;
        for file_id in file_ids {
            let mut position = next_position(&tx, file_id)?;
            for tag in &tags {
                let exists = has_tag
                    .query_row(params![file_id, tag], |_| Ok(()))
                    .is_ok();
                if exists {
                    continue;
                }
                insert_membership(&tx, file_id, tag, position)?;
                position += 1;
            }
        }
    }
    tx.commit()
}

pub fn get_file_tags(conn: &Connection, file_id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT tag FROM file_tags WHERE file_id = ?1 ORDER BY position, rowid",
    )?;
    let rows = stmt.query_map(params![file_id], |row| row.get::<_, String>(0))?;
    rows.collect()
}

pub fn get_files_by_tag(conn: &Connection, tag: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT file_id FROM file_tags WHERE tag = ?1 ORDER BY file_id")?;
    let rows = stmt.query_map(params![tag], |row| row.get::<_, String>(0))?;
    rows.collect()
}

/// 全量「文件 → 标签」映射（标签过滤与 1.3 一致性对照的输入）。
pub fn get_all_file_tags(conn: &Connection) -> Result<Vec<(String, Vec<String>)>> {
    let mut stmt = conn.prepare("SELECT file_id, tag FROM file_tags ORDER BY file_id, position, rowid")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut order: Vec<String> = Vec::new();
    let mut map = std::collections::HashMap::<String, Vec<String>>::new();
    for row in rows {
        let (file_id, tag) = row?;
        if !map.contains_key(&file_id) {
            order.push(file_id.clone());
        }
        map.entry(file_id).or_default().push(tag);
    }
    Ok(order.into_iter().map(|f| (f.clone(), map.remove(&f).unwrap_or_default())).collect())
}

/// 词表全集（含计数为 0 的词）。
pub fn get_vocabulary(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT tag FROM tags ORDER BY tag")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        create_table(&c).unwrap();
        c
    }

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|i| i.to_string()).collect()
    }

    #[test]
    fn set_then_read_preserves_order() {
        let c = conn();
        set_file_tags(&c, "f1", &s(&["风景", "猫", "a"])).unwrap();
        assert_eq!(get_file_tags(&c, "f1").unwrap(), s(&["风景", "猫", "a"]));
    }

    #[test]
    fn set_replaces_wholesale_and_drops_removed() {
        let c = conn();
        set_file_tags(&c, "f1", &s(&["a", "b"])).unwrap();
        set_file_tags(&c, "f1", &s(&["b", "c"])).unwrap();
        assert_eq!(get_file_tags(&c, "f1").unwrap(), s(&["b", "c"]));
        assert_eq!(get_files_by_tag(&c, "a").unwrap(), Vec::<String>::new());
    }

    #[test]
    fn duplicates_and_blanks_are_dropped() {
        let c = conn();
        set_file_tags(&c, "f1", &s(&["a", "a", "  ", "", "b"])).unwrap();
        assert_eq!(get_file_tags(&c, "f1").unwrap(), s(&["a", "b"]));
    }

    #[test]
    fn vocabulary_keeps_a_word_that_no_file_uses() {
        let c = conn();
        set_file_tags(&c, "f1", &s(&["临时"])).unwrap();
        set_file_tags(&c, "f1", &s(&[])).unwrap();
        assert!(get_vocabulary(&c).unwrap().contains(&"临时".to_string()));
        assert_eq!(get_files_by_tag(&c, "临时").unwrap().len(), 0);
    }

    #[test]
    fn batch_add_touches_every_file_once() {
        let c = conn();
        add_tags_to_files(&c, &s(&["f1", "f2", "f3"]), &s(&["旅行", "精选"])).unwrap();
        for f in ["f1", "f2", "f3"] {
            assert_eq!(get_file_tags(&c, f).unwrap(), s(&["旅行", "精选"]));
        }
        assert_eq!(get_files_by_tag(&c, "旅行").unwrap(), s(&["f1", "f2", "f3"]));
    }

    /// 粘贴到已有部分标签的图上：不重复、原次序不动、新标签追加在后面。
    #[test]
    fn batch_add_keeps_existing_tags_and_appends() {
        let c = conn();
        set_file_tags(&c, "f1", &s(&["夜景", "旅行"])).unwrap();
        add_tags_to_files(&c, &s(&["f1", "f2"]), &s(&["旅行", "精选"])).unwrap();
        assert_eq!(get_file_tags(&c, "f1").unwrap(), s(&["夜景", "旅行", "精选"]));
        assert_eq!(get_file_tags(&c, "f2").unwrap(), s(&["旅行", "精选"]));
    }

    #[test]
    fn batch_add_with_nothing_to_do_is_a_no_op() {
        let c = conn();
        set_file_tags(&c, "f1", &s(&["a"])).unwrap();
        add_tags_to_files(&c, &[], &s(&["x"])).unwrap();
        add_tags_to_files(&c, &s(&["f1"]), &[]).unwrap();
        add_tags_to_files(&c, &s(&["f1"]), &s(&["  "])).unwrap();
        assert_eq!(get_file_tags(&c, "f1").unwrap(), s(&["a"]));
        assert_eq!(get_vocabulary(&c).unwrap(), s(&["a"]));
    }

    #[test]
    fn all_file_tags_groups_by_file_in_order() {
        let c = conn();
        set_file_tags(&c, "b", &s(&["z", "y"])).unwrap();
        set_file_tags(&c, "a", &s(&["x"])).unwrap();
        let all = get_all_file_tags(&c).unwrap();
        assert_eq!(
            all,
            vec![
                ("a".to_string(), s(&["x"])),
                ("b".to_string(), s(&["z", "y"])),
            ]
        );
    }

    #[test]
    fn table_setup_is_idempotent() {
        let c = conn();
        create_table(&c).unwrap();
    }
}
