//! 标签的独立存储（M4a D10=②）。
//!
//! 词表从桌面的 `file_metadata.tags` JSON 列升级为两张表：`tags` 是可查询的词表，
//! `file_tags` 是文件与标签的多对多。**Kotlin 侧的标签只读写这里**，
//! `file_metadata.tags` 那一列在安卓库里不再被写入（桌面路径不受影响）。
//! 单一写入者是 `set_file_tags` / `add_tags_to_files`，UI 侧不许自己拼 JSON。

use rusqlite::{params, Connection, Result, ToSql};

use super::file_index::FileIndexEntry;

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

/// 去掉首尾空白、空串与重复项，保留首次出现的顺序。
/// 所有入口都过这一道，`tags` 列里才会只有一种形态——React 的
/// `handleSaveNewTag`（`useTags.ts:110`）也是先 trim 再存。
fn normalize(tags: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    tags.iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .filter(|t| seen.insert(t.clone()))
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

/// 带**任一**给定标签的图片行（M4a 4.1：侧栏点一个标签要筛出该标签下的全部图）。
///
/// 三个口径都是照 React 抄的，别顺手改：
///  - 多标签是**并集**，不是交集——`useFileSearch.ts:110-113` 用的是 `tags.some(...)`；
///  - 只取 `file_type = 'Image'`，词表里挂到文件夹上的标签不参与；
///  - 顺序 `modified_at DESC`，与 `list_images` 同一条，切进切出筛选时网格不会突然换序。
///
/// 用 `EXISTS` 而不是 JOIN `file_tags`：一张图同时带两个命中标签时，JOIN 会把它
/// 数成两行、网格里就出现两个格子。
pub fn images_with_any_tag(conn: &Connection, tags: &[String]) -> Result<Vec<FileIndexEntry>> {
    let tags = normalize(tags);
    if tags.is_empty() {
        return Ok(Vec::new());
    }
    let marks = (1..=tags.len())
        .map(|i| format!("?{}", i))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT file_id, parent_id, path, name, file_type, size, created_at, modified_at, \
                width, height, format \
         FROM file_index f \
         WHERE f.file_type = 'Image' \
           AND EXISTS (SELECT 1 FROM file_tags t WHERE t.file_id = f.file_id AND t.tag IN ({})) \
         ORDER BY f.modified_at DESC",
        marks
    );
    let mut stmt = conn.prepare(&sql)?;
    let args: Vec<&dyn ToSql> = tags.iter().map(|t| t as &dyn ToSql).collect();
    let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), |row| {
        Ok(FileIndexEntry {
            file_id: row.get(0)?,
            parent_id: row.get(1)?,
            path: row.get(2)?,
            name: row.get(3)?,
            file_type: row.get(4)?,
            size: row.get(5)?,
            created_at: row.get(6)?,
            modified_at: row.get(7)?,
            width: row.get(8)?,
            height: row.get(9)?,
            format: row.get(10)?,
        })
    })?;
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

/// 新增一个词（对齐 `useTags.ts:108` 的 `handleSaveNewTag`：trim 后非空才收，重复静默忽略）。
pub fn add_tag_to_vocabulary(conn: &Connection, tag: &str) -> Result<()> {
    let tag = tag.trim();
    if tag.is_empty() {
        return Ok(());
    }
    upsert_vocabulary(conn, &[tag.to_string()])
}

/// 词表 ∪ 文件上实际出现的标签，配各自的文件数——`App.tsx:1263` 里
/// `new Set(customTags)` ∪ 各文件 `tags` 那一步的 SQL 版。取并集而不是只读词表，
/// 是为了「只删词表不删文件标签」这种库里真能出现的状态下也不丢行。
pub fn tag_counts(conn: &Connection) -> Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT t.tag, COUNT(f.file_id) FROM \
         (SELECT tag FROM tags UNION SELECT DISTINCT tag FROM file_tags) t \
         LEFT JOIN file_tags f ON f.tag = t.tag \
         GROUP BY t.tag",
    )?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?;
    rows.collect()
}

/// 删除标签：词表和所有文件上的它一起删（对齐 `handleConfirmDeleteTags`，`:39-72`
/// 那一支桌面本来就是逐文件落库的），一批文件放一个事务里。
pub fn delete_tags(conn: &Connection, tags: &[String]) -> Result<()> {
    let tags = normalize(tags);
    if tags.is_empty() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    for tag in &tags {
        tx.execute("DELETE FROM file_tags WHERE tag = ?1", params![tag])?;
        tx.execute("DELETE FROM tags WHERE tag = ?1", params![tag])?;
    }
    tx.commit()
}

/// 重命名并级联。
///
/// **与桌面行为有意不同**（D14 选「修正」）：桌面 `handleRenameTag`（`useTags.ts:163`）
/// 只改内存 state，重启后文件标签回到旧名、词表却留下新名。这里词表与所有文件的标签
/// 在同一个事务里改，落库。
///
/// 与桌面保持一致的两点：① 空 new / 新旧同名一律 no-op（`:164`）；② 词表里原本没有
/// 旧名时，不把新名塞进词表（`:178` 的 `if includes`）。
/// 差别只在重名合并：桌面 `.map()` 会让一张图同时出现两个同名标签，关系表的主键不认，
/// 这里合并成一个。
pub fn rename_tag(conn: &Connection, old_tag: &str, new_tag: &str) -> Result<()> {
    let new_tag = new_tag.trim();
    if new_tag.is_empty() || new_tag == old_tag {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    let in_vocabulary: bool = tx.query_row(
        "SELECT 1 FROM tags WHERE tag = ?1",
        params![old_tag],
        |_| Ok(true),
    ).unwrap_or(false);
    if in_vocabulary {
        upsert_vocabulary(&tx, &[new_tag.to_string()])?;
    }
    // 先插后删：目标标签在这张图上已存在时 INSERT OR IGNORE 自然跳过，剩下的旧行删掉
    // 就等于合并；position 沿用旧行的，次序不跳。
    tx.execute(
        "INSERT OR IGNORE INTO file_tags (file_id, tag, position) \
         SELECT file_id, ?2, position FROM file_tags WHERE tag = ?1",
        params![old_tag, new_tag],
    )?;
    tx.execute("DELETE FROM file_tags WHERE tag = ?1", params![old_tag])?;
    tx.execute("DELETE FROM tags WHERE tag = ?1", params![old_tag])?;
    tx.commit()
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

    /// 每个入口都 trim，否则「a」与「 a」会在词表里成两个词、1.3 也无从对齐。
    #[test]
    fn every_entry_point_trims_the_same_way() {
        let c = conn();
        set_file_tags(&c, "f1", &s(&[" 风景 ", "猫  "])).unwrap();
        assert_eq!(get_file_tags(&c, "f1").unwrap(), s(&["风景", "猫"]));
        assert_eq!(get_files_by_tag(&c, "风景").unwrap(), s(&["f1"]));
        add_tag_to_vocabulary(&c, " 风景 ").unwrap();
        assert_eq!(get_vocabulary(&c).unwrap(), s(&["猫", "风景"]));
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

    #[test]
    fn counting_covers_the_union_of_vocabulary_and_file_tags() {
        let c = conn();
        set_file_tags(&c, "f1", &s(&["猫", "风景"])).unwrap();
        set_file_tags(&c, "f2", &s(&["猫"])).unwrap();
        add_tag_to_vocabulary(&c, "只有词表里有").unwrap();
        let mut counts = tag_counts(&c).unwrap();
        counts.sort();
        assert_eq!(
            counts,
            vec![
                ("只有词表里有".to_string(), 0),
                ("猫".to_string(), 2),
                ("风景".to_string(), 1),
            ]
        );
    }

    #[test]
    fn vocabulary_add_trims_and_ignores_blanks_and_duplicates() {
        let c = conn();
        add_tag_to_vocabulary(&c, "  旅行  ").unwrap();
        add_tag_to_vocabulary(&c, "旅行").unwrap();
        add_tag_to_vocabulary(&c, "   ").unwrap();
        assert_eq!(get_vocabulary(&c).unwrap(), s(&["旅行"]));
    }

    /// D14：桌面只改内存不落库，这里必须落到文件上。
    #[test]
    fn rename_cascades_into_every_file_and_persists() {
        let c = conn();
        set_file_tags(&c, "f1", &s(&["旧名", "别的"])).unwrap();
        set_file_tags(&c, "f2", &s(&["旧名"])).unwrap();
        rename_tag(&c, "旧名", "新名").unwrap();
        assert_eq!(get_files_by_tag(&c, "新名").unwrap(), s(&["f1", "f2"]));
        assert!(get_files_by_tag(&c, "旧名").unwrap().is_empty());
        assert_eq!(get_file_tags(&c, "f1").unwrap(), s(&["新名", "别的"]));
        assert_eq!(get_vocabulary(&c).unwrap(), s(&["别的", "新名"]));
    }

    /// 词表里没有旧名时（只在文件上贴过），新名也不进词表——与 `useTags.ts:178` 一致。
    #[test]
    fn rename_does_not_promote_a_word_the_vocabulary_never_had() {
        let c = conn();
        let tx = c.unchecked_transaction().unwrap();
        tx.execute("INSERT OR IGNORE INTO file_tags (file_id, tag, position) VALUES ('f1', '野生', 0)", []).unwrap();
        tx.commit().unwrap();
        rename_tag(&c, "野生", "野生2").unwrap();
        assert_eq!(get_file_tags(&c, "f1").unwrap(), s(&["野生2"]));
        assert!(get_vocabulary(&c).unwrap().is_empty());
    }

    #[test]
    fn renaming_onto_an_existing_tag_merges_instead_of_duplicating() {
        let c = conn();
        set_file_tags(&c, "f1", &s(&["a", "b"])).unwrap();
        rename_tag(&c, "a", "b").unwrap();
        assert_eq!(get_file_tags(&c, "f1").unwrap(), s(&["b"]));
    }

    #[test]
    fn rename_guards_blank_and_no_op() {
        let c = conn();
        set_file_tags(&c, "f1", &s(&["a"])).unwrap();
        rename_tag(&c, "a", "a").unwrap();
        rename_tag(&c, "a", "   ").unwrap();
        assert_eq!(get_file_tags(&c, "f1").unwrap(), s(&["a"]));
    }

    #[test]
    fn deleting_a_tag_removes_it_from_files_and_the_vocabulary() {
        let c = conn();
        set_file_tags(&c, "f1", &s(&["要删", "留下"])).unwrap();
        set_file_tags(&c, "f2", &s(&["要删"])).unwrap();
        delete_tags(&c, &s(&["要删"])).unwrap();
        assert_eq!(get_file_tags(&c, "f1").unwrap(), s(&["留下"]));
        assert!(get_file_tags(&c, "f2").unwrap().is_empty());
        assert!(!get_vocabulary(&c).unwrap().contains(&"要删".to_string()));
        delete_tags(&c, &[]).unwrap();
    }

    // —— images_with_any_tag（M4a 4.1 侧栏点标签的筛选）——

    /// 这条路径要 join `file_index`，所以额外建那张表。
    fn conn_with_index() -> Connection {
        let c = conn();
        super::super::file_index::create_table(&c).unwrap();
        c
    }

    fn add_entry(conn: &Connection, id: &str, modified: i64, file_type: &str) {
        conn.execute(
            "INSERT INTO file_index (file_id, path, name, file_type, size, created_at, modified_at) \
             VALUES (?1, ?2, ?3, ?4, 0, 0, ?5)",
            params![id, format!("/p/{}.jpg", id), id, file_type, modified],
        )
        .unwrap();
    }

    fn ids(rows: &[FileIndexEntry]) -> Vec<String> {
        rows.iter().map(|r| r.file_id.clone()).collect()
    }

    #[test]
    fn tag_filter_returns_only_matching_images_in_modified_order() {
        let c = conn_with_index();
        add_entry(&c, "old", 100, "Image");
        add_entry(&c, "new", 300, "Image");
        add_entry(&c, "other", 200, "Image");
        set_file_tags(&c, "old", &s(&["海边"])).unwrap();
        set_file_tags(&c, "new", &s(&["海边"])).unwrap();
        assert_eq!(ids(&images_with_any_tag(&c, &s(&["海边"])).unwrap()), s(&["new", "old"]));
    }

    #[test]
    fn several_tags_are_unioned_not_intersected() {
        let c = conn_with_index();
        add_entry(&c, "a", 1, "Image");
        add_entry(&c, "b", 2, "Image");
        add_entry(&c, "both", 3, "Image");
        set_file_tags(&c, "a", &s(&["x"])).unwrap();
        set_file_tags(&c, "b", &s(&["y"])).unwrap();
        set_file_tags(&c, "both", &s(&["x", "y"])).unwrap();
        // 并集：三张全中；且 "both" 同时带两个命中标签也**只出现一次**（EXISTS 而非 JOIN）
        assert_eq!(
            ids(&images_with_any_tag(&c, &s(&["x", "y"])).unwrap()),
            s(&["both", "b", "a"])
        );
    }

    #[test]
    fn tag_filter_skips_non_image_rows() {
        let c = conn_with_index();
        add_entry(&c, "img", 1, "Image");
        add_entry(&c, "dir", 2, "Folder");
        set_file_tags(&c, "dir", &s(&["错贴"])).unwrap();
        set_file_tags(&c, "img", &s(&["对"])).unwrap();
        assert_eq!(ids(&images_with_any_tag(&c, &s(&["错贴", "对"])).unwrap()), s(&["img"]));
    }

    #[test]
    fn blank_and_untrimmed_tags_never_match_everything() {
        let c = conn_with_index();
        add_entry(&c, "img", 1, "Image");
        set_file_tags(&c, "img", &s(&["海边"])).unwrap();
        assert!(images_with_any_tag(&c, &[]).unwrap().is_empty());
        assert!(images_with_any_tag(&c, &s(&["", "   "])).unwrap().is_empty());
        // 传进来带空白的词按 trim 后匹配（与写入侧同一套归一化）
        assert_eq!(ids(&images_with_any_tag(&c, &s(&["  海边 "])).unwrap()), s(&["img"]));
    }
}
