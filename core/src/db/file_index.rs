use rusqlite::{params, Connection, Result};
use std::path::Path;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileIndexEntry {
    pub file_id: String,
    pub parent_id: Option<String>,
    pub path: String,
    pub name: String,
    pub file_type: String, // "Image", "Folder", "Unknown"
    pub size: u64,
    pub created_at: i64,
    pub modified_at: i64,
    // Image specific
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub format: Option<String>,
}

pub fn create_table(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS file_index (
            file_id TEXT PRIMARY KEY,
            parent_id TEXT,
            path TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            file_type TEXT NOT NULL,
            size INTEGER DEFAULT 0,
            created_at INTEGER DEFAULT 0,
            modified_at INTEGER DEFAULT 0,
            width INTEGER,
            height INTEGER,
            format TEXT
        )",
        [],
    )?;
    
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_file_index_path ON file_index(path)",
        [],
    )?;
    
    // 复合索引服务两类热查询（几万张图的库上单列 parent 索引要逐子行回表 +
    // 每文件夹排序，list_folders 一次数秒）：
    //   - list_folders 每文件夹四个子查询：COUNT / 封面(modified_at DESC LIMIT 1)
    //     / MAX(created_at) / MAX(modified_at)
    //   - list_images：parent_id + file_type 等值，modified_at DESC 直接走索引序
    // 单列 parent 索引被最左前缀覆盖，删掉省一份对账逐行索引维护。
    conn.execute("DROP INDEX IF EXISTS idx_file_index_parent", [])?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_file_index_parent_type_modified ON file_index(parent_id, file_type, modified_at)",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_file_index_parent_type_created ON file_index(parent_id, file_type, created_at)",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_file_index_name ON file_index(name)",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_file_index_type ON file_index(file_type)",
        [],
    )?;

    Ok(())
}

pub fn batch_upsert(conn: &mut Connection, entries: &[FileIndexEntry]) -> Result<()> {
    let tx = conn.transaction()?;
    
    {
        let mut stmt = tx.prepare(
            "INSERT INTO file_index (
                file_id, parent_id, path, name, file_type, size, 
                created_at, modified_at, width, height, format
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            ON CONFLICT(file_id) DO UPDATE SET
                parent_id = excluded.parent_id,
                path = excluded.path,
                name = excluded.name,
                file_type = excluded.file_type,
                size = excluded.size,
                created_at = excluded.created_at,
                modified_at = excluded.modified_at,
                width = excluded.width,
                height = excluded.height,
                format = excluded.format"
        )?;

        for entry in entries {
            stmt.execute(params![
                entry.file_id,
                entry.parent_id,
                entry.path,
                entry.name,
                entry.file_type,
                entry.size,
                entry.created_at,
                entry.modified_at,
                entry.width,
                entry.height,
                entry.format
            ])?;
        }
    }
    
    tx.commit()?;
    Ok(())
}

pub fn get_entries_under_path(conn: &Connection, root_path: &str) -> Result<Vec<FileIndexEntry>> {
    let pattern = format!("{}%", root_path);
    let mut stmt = conn.prepare("SELECT file_id, parent_id, path, name, file_type, size, created_at, modified_at, width, height, format FROM file_index WHERE path LIKE ?1")?;
    let rows = stmt.query_map(params![pattern], |row| {
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

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row?);
    }
    Ok(entries)
}

pub fn get_all_entries(conn: &Connection) -> Result<Vec<FileIndexEntry>> {
    let mut stmt = conn.prepare("SELECT file_id, parent_id, path, name, file_type, size, created_at, modified_at, width, height, format FROM file_index")?;
    let rows = stmt.query_map([], |row| {
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

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row?);
    }
    Ok(entries)
}

/// 获取所有图片文件（file_type = "Image"）
/// 用于 CLIP 嵌入向量生成
pub fn get_all_image_files(conn: &Connection) -> Result<Vec<FileIndexEntry>> {
    let mut stmt = conn.prepare(
        "SELECT file_id, parent_id, path, name, file_type, size, created_at, modified_at, width, height, format 
         FROM file_index 
         WHERE file_type = 'Image'"
    )?;
    let rows = stmt.query_map([], |row| {
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

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row?);
    }
    Ok(entries)
}

/// 按 id 集合取图片（M4a 3.2）。**保留入参顺序**、不在库中的 id 静默跳过——调用方
/// 是专题：成员 id 来自 `topic_files`，而 MediaStore 对账可能已把对应行清掉（用户删了图），
/// 这时该成员自然消失，不该报错炸掉整个专题详情。
/// 只认 `file_type = 'Image'`：专题理论上可能挂了文件夹/视频 id，网格只吃图片。
pub fn images_by_ids(conn: &Connection, file_ids: &[String]) -> Result<Vec<FileIndexEntry>> {
    use rusqlite::{params_from_iter, ToSql};
    use std::collections::HashMap;

    if file_ids.is_empty() {
        return Ok(Vec::new());
    }
    let marks = (1..=file_ids.len())
        .map(|i| format!("?{}", i))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT file_id, parent_id, path, name, file_type, size, created_at, modified_at, \
                width, height, format \
         FROM file_index \
         WHERE file_type = 'Image' AND file_id IN ({})",
        marks
    );
    let mut stmt = conn.prepare(&sql)?;
    let args: Vec<&dyn ToSql> = file_ids.iter().map(|t| t as &dyn ToSql).collect();
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
    let mut by_id: HashMap<String, FileIndexEntry> = HashMap::new();
    for row in rows {
        let e = row?;
        by_id.insert(e.file_id.clone(), e);
    }
    // IN (...) 不保序；按入参顺序重排（专题成员的先后 = 加入时的次序，就是详情网格的
    // 次序）。重复入参各自解析到同一行（输出与入参 1:1 对齐），缺的静默跳过。
    Ok(file_ids
        .iter()
        .filter_map(|id| by_id.get(id).cloned())
        .collect())
}

/// 通过 file_id 获取文件路径
pub fn get_path_by_id(conn: &Connection, file_id: &str) -> Result<Option<String>> {
    let result = conn.query_row(
        "SELECT path FROM file_index WHERE file_id = ?1",
        params![file_id],
        |row| row.get(0),
    );
    
    match result {
        Ok(path) => Ok(Some(path)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Lightweight query that only selects the minimal columns needed for UI-first-paint
/// (used to demonstrate/measure a fast-start strategy). Returns `FileIndexEntry` with
/// non-essential fields left empty to keep the shape consistent.
pub fn get_minimal_entries_under_path(conn: &Connection, root_path: &str) -> Result<Vec<FileIndexEntry>> {
    let pattern = format!("{}%", root_path);
    let mut stmt = conn.prepare("SELECT file_id, path, file_type, size, modified_at FROM file_index WHERE path LIKE ?1")?;
    let rows = stmt.query_map(params![pattern], |row| {
        Ok(FileIndexEntry {
            file_id: row.get(0)?,
            parent_id: None,
            path: row.get(1)?,
            name: String::new(),
            file_type: row.get(2)?,
            size: row.get(3)?,
            created_at: 0,
            modified_at: row.get(4)?,
            width: None,
            height: None,
            format: None,
        })
    })?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row?);
    }
    Ok(entries)
}

/// 批量获取指定路径列表的图片尺寸信息
/// 返回 (path -> (width, height)) 的映射
pub fn get_image_dimensions_batch(conn: &Connection, paths: &[String]) -> Result<std::collections::HashMap<String, (Option<u32>, Option<u32>)>> {
    let mut result = std::collections::HashMap::new();
    
    if paths.is_empty() {
        return Ok(result);
    }
    
    let placeholders: Vec<String> = paths.iter().map(|_| "?".to_string()).collect();
    let sql = format!(
        "SELECT path, width, height FROM file_index WHERE path IN ({})",
        placeholders.join(",")
    );
    
    let mut stmt = conn.prepare(&sql)?;
    let params: Vec<&dyn rusqlite::ToSql> = paths.iter().map(|p| p as &dyn rusqlite::ToSql).collect();
    
    let rows = stmt.query_map(params.as_slice(), |row| {
        let path: String = row.get(0)?;
        let width: Option<u32> = row.get(1)?;
        let height: Option<u32> = row.get(2)?;
        Ok((path, width, height))
    })?;
    
    for row in rows {
        let (path, width, height) = row?;
        result.insert(path, (width, height));
    }
    
    Ok(result)
}


#[cfg(test)]
mod reconcile_tests {
    use super::*;
    use rusqlite::Connection;

    fn entry(id: &str, parent: Option<&str>, path: &str, name: &str, ftype: &str) -> FileIndexEntry {
        FileIndexEntry {
            file_id: id.into(),
            parent_id: parent.map(|p| p.into()),
            path: path.into(),
            name: name.into(),
            file_type: ftype.into(),
            size: 1,
            created_at: 0,
            modified_at: 0,
            width: None,
            height: None,
            format: None,
        }
    }

    #[test]
    fn reconcile_keeps_snapshot_and_prunes_stale() {
        let mut conn = Connection::open_in_memory().expect("open in-memory db");
        // 对账现在会连带清理 topic_files 孤儿（M4b 1.2），测试库需要全量建表（生产
        // 顺序也是 init_db 全量建表在前）
        crate::db::init_db(&conn).expect("init db");

        // 旧索引：folder A（图 a1）、folder B（图 b1）+ 一张父已不存在的孤儿图
        let stale = vec![
            entry("A", None, "/storage/A", "A", "Folder"),
            entry("B", None, "/storage/B", "B", "Folder"),
            entry("a1", Some("A"), "uri://a1", "a1.jpg", "Image"),
            entry("b1", Some("B"), "uri://b1", "b1.jpg", "Image"),
            entry("ghost", Some("B"), "uri://ghost", "ghost.jpg", "Image"),
        ];
        batch_upsert(&mut conn, &stale).expect("seed stale rows");

        // 新快照：A 仍在（a1 更新 + 新增 a2）；B 从 MediaStore 消失（删除/改名）
        let folders = vec![entry("A", None, "/storage/A", "A", "Folder")];
        let images = vec![
            entry("a1", Some("A"), "uri://a1", "a1.jpg", "Image"),
            entry("a2", Some("A"), "uri://a2", "a2.jpg", "Image"),
        ];
        reconcile_mediastore_snapshot(&mut conn, &folders, &images).expect("reconcile");

        let mut ids: Vec<String> = get_all_entries(&conn)
            .expect("read back")
            .into_iter()
            .map(|e| e.file_id)
            .collect();
        ids.sort();
        // B/b1/ghost（快照外）被清理；A/a1/a2（快照内）保留
        assert_eq!(ids, vec!["A".to_string(), "a1".to_string(), "a2".to_string()]);
    }

    #[test]
    fn reconcile_repeat_run_is_idempotent() {
        let mut conn = Connection::open_in_memory().expect("open in-memory db");
        crate::db::init_db(&conn).expect("init db");

        let folders = vec![entry("A", None, "/storage/A", "A", "Folder")];
        let images = vec![entry("a1", Some("A"), "uri://a1", "a1.jpg", "Image")];

        reconcile_mediastore_snapshot(&mut conn, &folders, &images).expect("first run");
        reconcile_mediastore_snapshot(&mut conn, &folders, &images).expect("second run");

        let count = get_all_entries(&conn).expect("read back").len();
        assert_eq!(count, 2, "重复对账不产生累积或丢失");
    }

    #[test]
    fn images_by_ids_preserves_order_and_skips_missing() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        create_table(&conn).expect("create table");

        let seed = vec![
            entry("i2", None, "uri://i2", "i2.jpg", "Image"),
            entry("i1", None, "uri://i1", "i1.jpg", "Image"),
            // 非图片与库外 id：一个要被过滤，一个要被跳过
            entry("fold", None, "uri://fold", "fold", "Folder"),
            entry("i3", None, "uri://i3", "i3.jpg", "Image"),
        ];
        let mut conn = conn;
        batch_upsert(&mut conn, &seed).expect("seed rows");

        let ids = vec![
            "i2".to_string(),
            "gone".to_string(), // 不在库里：静默跳过
            "i1".to_string(),
            "fold".to_string(), // Folder：只认 Image，滤掉
            "i2".to_string(),   // 重复入参：按顺序重复出现（行为可预期即可）
        ];
        let out = images_by_ids(&conn, &ids).expect("query");
        let got: Vec<&str> = out.iter().map(|e| e.file_id.as_str()).collect();
        assert_eq!(got, vec!["i2", "i1", "i2"], "保留入参顺序、跳缺失、滤非图片");
    }

    /// M4b 1.2 顺手核对（M4a 顺延项 7）：对账要清掉指向已消失图片的 topic_files
    /// 孤儿成员，并把 topics.file_count 缓存对齐实际成员数（「卡片 2 vs 详情 1」的
    /// 偏大方向根因）。
    #[test]
    fn reconcile_prunes_orphan_topic_members_and_refreshes_count() {
        use crate::db::topics;
        let mut conn = Connection::open_in_memory().expect("open in-memory db");
        crate::db::init_db(&conn).expect("init db");

        let folders = vec![entry("A", None, "/storage/A", "A", "Folder")];
        let images = vec![
            entry("img1", Some("A"), "uri://img1", "a.jpg", "Image"),
            entry("img2", Some("A"), "uri://img2", "b.jpg", "Image"),
        ];
        reconcile_mediastore_snapshot(&mut conn, &folders, &images).expect("reconcile");

        let topic = topics::Topic {
            id: "t1".into(),
            parent_id: None,
            name: "专题".into(),
            description: None,
            topic_type: Some("TOPIC".into()),
            cover_file_id: None,
            background_file_id: None,
            cover_crop: None,
            people_ids: vec![],
            file_ids: vec![],
            source_url: None,
            created_at: Some(0),
            updated_at: Some(0),
            source_type: None,
            work_name: None,
            work_name_cn: None,
            file_count: 0,
        };
        topics::upsert_topic(&conn, &topic).expect("create topic");
        topics::set_topic_files(&conn, "t1", &["img1".into(), "img2".into(), "ghost".into()])
            .expect("set members");
        // set 后缓存 = 3（原始行数，含 ghost）
        let (count, members) = topic_state(&conn, "t1");
        assert_eq!(count, 3, "set_topic_files 后缓存=原始行数");
        assert_eq!(members.len(), 3);

        // 新快照里 img2 消失（被删）：对账应清掉它的成员行（ghost 也是），缓存对齐 1
        let images = vec![entry("img1", Some("A"), "uri://img1", "a.jpg", "Image")];
        reconcile_mediastore_snapshot(&mut conn, &folders, &images).expect("reconcile 2");

        let (count, members) = topic_state(&conn, "t1");
        assert_eq!(members, vec!["img1".to_string()], "孤儿成员被清掉");
        assert_eq!(count, 1, "file_count 缓存对齐实际成员数");

        // upsert_topic（改名字等元数据）不得用调用方快照的过期 fileCount 打回缓存
        let mut stale = topic.clone();
        stale.name = "改名".into();
        stale.file_count = 999;
        topics::upsert_topic(&conn, &stale).expect("upsert with stale count");
        let (count, _) = topic_state(&conn, "t1");
        assert_eq!(count, 1, "upsert_topic 保留缓存列，不写入调用方值");

        fn topic_state(conn: &Connection, id: &str) -> (i32, Vec<String>) {
            let count: i32 = conn
                .query_row(
                    "SELECT file_count FROM topics WHERE id = ?1",
                    [id],
                    |r| r.get(0),
                )
                .expect("read count");
            let members = topics::get_topic_files(conn, id).expect("members");
            (count, members)
        }
    }
}

#[cfg(test)]
mod bench_tests {
    use super::*;
    use rusqlite::Connection;
    use std::time::Instant;
    use std::fs;
    use std::env;

    #[test]
    fn bench_entries_fetch() {
        // 可通过环境变量 AURORA_BENCH_COUNT 调整样本大小（默认 68k）
        let n: usize = env::var("AURORA_BENCH_COUNT").ok().and_then(|s| s.parse().ok()).unwrap_or(68000);
        let tmpdir = env::temp_dir().join(format!("aurora_bench_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmpdir);
        fs::create_dir_all(&tmpdir).unwrap();
        let db_path = tmpdir.join("bench.db");

        let mut conn = Connection::open(db_path).expect("open db");
        create_table(&conn).expect("create table");

        // 生成伪索引数据
        let mut entries = Vec::with_capacity(n);
        for i in 0..n {
            let path = format!("/bench/root/dir{}/file{}.jpg", i / 100, i);
            entries.push(FileIndexEntry {
                file_id: format!("id{}", i),
                parent_id: None,
                path: path.clone(),
                name: format!("file{}.jpg", i),
                file_type: "Image".into(),
                size: 1024,
                created_at: 0,
                modified_at: i as i64,
                width: Some(800),
                height: Some(600),
                format: Some("jpg".into()),
            });
        }

        // 批量写入（衡量写入成本不在此次基准主要关注点，但仍需要）
        batch_upsert(&mut conn, &entries).expect("batch upsert");

        // 测量当前（重字段）查询
        let t0 = Instant::now();
        let all = get_entries_under_path(&conn, "/bench/root").expect("get_entries_under_path");
        let dur_all = t0.elapsed();

        // 测量轻量查询
        let t1 = Instant::now();
        let minimal = get_minimal_entries_under_path(&conn, "/bench/root").expect("get_minimal_entries_under_path");
        let dur_min = t1.elapsed();

        println!("bench: inserted={}, get_entries_under_path -> {:?} (count={}), get_minimal -> {:?} (count={})", n, dur_all, all.len(), dur_min, minimal.len());

        assert_eq!(all.len(), minimal.len(), "row counts must match");

        // 清理
        let _ = fs::remove_dir_all(&tmpdir);
    }
}

/// MediaStore 全量对账写入：单事务内完成「upsert 当前快照 + 清理快照外的陈旧行」。
///
/// Kotlin 扫描的 MediaStore 是设备当前的全量快照，`upsert_media_images` 传入后：
/// 1. upsert 快照里的全部 bucket 文件夹与图片行；
/// 2. 把快照的合法 file_id 存入连接级临时表（2 万行的 NOT IN 参数列表会撞变量上限，
///    临时表走子查询不走绑定参数）；
/// 3. 删除不在快照中的 Folder / Image 行——被删除/改名的相册（bucket_id 随路径派生，
///    改名即新 id、旧行成幽灵）、已消失的图片。不做对账索引只增不减，总览会留下
///    点进去为空的幽灵文件夹。
///
/// 单事务保证原子性：任一步失败整体回滚，索引保持上一次一致状态。
/// 临时表挂在连接上；池只有一个连接，IF NOT EXISTS + 先清空即可重入。
/// 只触碰 'Folder' / 'Image' 两种类型，其他 file_type 的行不属于 MediaStore 管辖。
pub fn reconcile_mediastore_snapshot(
    conn: &mut Connection,
    folder_entries: &[FileIndexEntry],
    image_entries: &[FileIndexEntry],
) -> Result<()> {
    let tx = conn.transaction()?;
    {
        let mut upsert = tx.prepare(
            "INSERT INTO file_index (
                file_id, parent_id, path, name, file_type, size,
                created_at, modified_at, width, height, format
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            ON CONFLICT(file_id) DO UPDATE SET
                parent_id = excluded.parent_id,
                path = excluded.path,
                name = excluded.name,
                file_type = excluded.file_type,
                size = excluded.size,
                created_at = excluded.created_at,
                modified_at = excluded.modified_at,
                width = excluded.width,
                height = excluded.height,
                format = excluded.format"
        )?;
        for entry in folder_entries.iter().chain(image_entries) {
            upsert.execute(params![
                entry.file_id,
                entry.parent_id,
                entry.path,
                entry.name,
                entry.file_type,
                entry.size,
                entry.created_at,
                entry.modified_at,
                entry.width,
                entry.height,
                entry.format
            ])?;
        }

        tx.execute(
            "CREATE TEMP TABLE IF NOT EXISTS current_snapshot_ids(id TEXT PRIMARY KEY)",
            [],
        )?;
        tx.execute("DELETE FROM current_snapshot_ids", [])?;
        let mut insert_id =
            tx.prepare("INSERT OR IGNORE INTO current_snapshot_ids(id) VALUES (?1)")?;
        for entry in folder_entries.iter().chain(image_entries) {
            insert_id.execute(params![entry.file_id])?;
        }

        tx.execute(
            "DELETE FROM file_index WHERE file_type = 'Folder' AND file_id NOT IN (SELECT id FROM current_snapshot_ids)",
            [],
        )?;
        tx.execute(
            "DELETE FROM file_index WHERE file_type = 'Image' AND file_id NOT IN (SELECT id FROM current_snapshot_ids)",
            [],
        )?;

        // M4b 1.2 顺手核对（M4a 顺延项 7）：图片从索引消失（被删/被对账清掉）后，
        // topic_files 里的成员行没人清——「卡片 fileCount 2 vs 详情 1」的偏大方向即
        // 由此而来（卡片数 = 缓存列 = 原始行数，详情 = list_images_by_ids 静默跳过
        // 缺行）。这里清掉孤儿成员并把 file_count 缓存对齐实际成员数。此函数只有
        // 安卓 MediaStore 对账调用（桌面走文件系统同步，不经这里）。
        tx.execute(
            "DELETE FROM topic_files WHERE file_id NOT IN (
                SELECT file_id FROM file_index WHERE file_type = 'Image')",
            [],
        )?;
        tx.execute(
            "UPDATE topics SET file_count = (
                SELECT COUNT(*) FROM topic_files WHERE topic_id = topics.id)",
            [],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn delete_entries_by_ids(conn: &mut Connection, ids: &[String]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    
    let tx = conn.transaction()?;
    {
         for chunk in ids.chunks(900) {
             let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
             let sql = format!("DELETE FROM file_index WHERE file_id IN ({})", placeholders);
             let mut stmt = tx.prepare(&sql)?;
             stmt.execute(rusqlite::params_from_iter(chunk))?;
         }
    }
    tx.commit()?;
    Ok(())
}

pub fn delete_entries_by_path(conn: &Connection, path: &str) -> Result<()> {
    // 规范化路径
    let normalized_path = path.replace("\\", "/");
    
    // 删除记录
    conn.execute(
        "DELETE FROM file_index WHERE path = ? OR path LIKE ?",
        params![normalized_path, format!("{}/%", normalized_path.trim_end_matches('/'))],
    )?;
    
    Ok(())
}

pub fn delete_orphaned_entries(conn: &mut Connection, root_path: &str, existing_paths: &[String]) -> Result<usize> {
    use std::collections::HashSet;
    let tx = conn.transaction()?;
    
    let deleted_count = {
        // 1. 快速索引：将磁盘路径存入 HashSet，查找速度从 O(N) 变为 O(1)
        let existing_set: HashSet<&String> = existing_paths.iter().collect();

        // 2. 找出该目录下所有已经在数据库中的路径
        let pattern = format!("{}%", root_path);
        let mut stmt = tx.prepare("SELECT path FROM file_index WHERE path = ?1 OR path LIKE ?2")?;
        let db_paths: Vec<String> = stmt.query_map(params![root_path, pattern], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();
            
        // 3. 找出在数据库中但不在磁盘上的路径
        let to_delete: Vec<String> = db_paths.into_iter()
            .filter(|p| !existing_set.contains(p))
            .collect();
            
        let count = to_delete.len();
        
        // 分批删除
        for chunk in to_delete.chunks(900) {
            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!("DELETE FROM file_index WHERE path IN ({})", placeholders);
            let mut stmt = tx.prepare(&sql)?;
            stmt.execute(rusqlite::params_from_iter(chunk))?;
        }
        count
    };
    
    tx.commit()?;
    Ok(deleted_count)
}

pub fn migrate_index_dir(conn: &Connection, old_path: &str, new_path: &str) -> Result<()> {
    let old_normalized = super::normalize_path(old_path);
    let new_normalized = super::normalize_path(new_path);
    
    // 找出新文件夹的名称
    let new_name = Path::new(&new_normalized)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    // 0. 清理目标路径及其子项的残留项（防止 UNIQUE 约束冲突）
    // 使用 lower() 确保大小写不敏感匹配，防止 abc -> ABC 这种重命名失败
    let new_dir_prefix_clean = if new_normalized.ends_with('/') { new_normalized.clone() } else { format!("{}/", new_normalized) };
    let new_dir_pattern = format!("{}%", new_dir_prefix_clean);
    conn.execute(
        "DELETE FROM file_index WHERE lower(path) = lower(?1) OR lower(path) LIKE lower(?2)",
        params![new_normalized, new_dir_pattern],
    )?;

    // 1. 更新顶层文件夹的路径和名称
    // ID 不变，ParentID 不变
    conn.execute(
        "UPDATE file_index SET path = ?1, name = ?2 WHERE path = ?3",
        params![new_normalized, new_name, old_normalized],
    )?;

    // 2. 批量更新子文件的路径 (Stable ID: ID and ParentID remain unchanged)
    // 使用 SQL 字符串拼接功能：new_path_prefix + SUBSTR(old_path, length(old_path_prefix) + 1)
    let old_dir_prefix = if old_normalized.ends_with('/') { old_normalized.clone() } else { format!("{}/", old_normalized) };
    let new_dir_prefix = if new_normalized.ends_with('/') { new_normalized.clone() } else { format!("{}/", new_normalized) };
    let dir_pattern = format!("{}%", old_dir_prefix);

    // SQLite SUBSTR starts at 1. We want to skip old_dir_prefix.
    // So if prefix char count is N, we want from N+1.
    // IMPORTANT: SUBSTR in SQLite uses character index, not byte index.
    let skip_len = (old_dir_prefix.chars().count() + 1) as i32;

    conn.execute(
        "UPDATE file_index SET path = ?1 || SUBSTR(path, ?2) WHERE path LIKE ?3",
        params![new_dir_prefix, skip_len, dir_pattern],
    )?;
    
    Ok(())
}

pub fn search_by_name(conn: &Connection, query: &str, scope: &str) -> Result<Vec<FileIndexEntry>> {
    let search_pattern = format!("%{}%", query.to_lowercase());
    
    let sql = match scope {
        "file" => "SELECT file_id, parent_id, path, name, file_type, size, created_at, modified_at, width, height, format FROM file_index WHERE lower(name) LIKE ?1 AND file_type = 'Image'",
        "folder" => "SELECT file_id, parent_id, path, name, file_type, size, created_at, modified_at, width, height, format FROM file_index WHERE lower(name) LIKE ?1 AND file_type = 'Folder'",
        _ => "SELECT file_id, parent_id, path, name, file_type, size, created_at, modified_at, width, height, format FROM file_index WHERE lower(name) LIKE ?1",
    };
    
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params![search_pattern], |row| {
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

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row?);
    }
    Ok(entries)
}

pub fn get_children_by_parent_path(conn: &Connection, parent_path: &str) -> Result<Vec<FileIndexEntry>> {
    let parent_id = crate::db::generate_id(parent_path);
    
    let mut stmt = conn.prepare(
        "SELECT file_id, parent_id, path, name, file_type, size, created_at, modified_at, width, height, format 
         FROM file_index WHERE parent_id = ?1"
    )?;
    
    let rows = stmt.query_map(params![parent_id], |row| {
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

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row?);
    }
    Ok(entries)
}

pub fn get_folder_preview_images(conn: &Connection, folder_path: &str, limit: usize) -> Result<Vec<String>> {
    let folder_id = crate::db::generate_id(folder_path);
    
    let sql = format!(
        "SELECT path FROM file_index WHERE parent_id = ?1 AND file_type = 'Image' ORDER BY modified_at DESC LIMIT {}", 
        limit
    );
    
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![folder_id], |row| {
        row.get::<_, String>(0)
    })?;

    let mut paths = Vec::new();
    for row in rows {
        paths.push(row?);
    }
    Ok(paths)
}

pub fn get_folder_file_count(conn: &Connection, folder_path: &str) -> Result<u64> {
    let folder_id = crate::db::generate_id(folder_path);
    
    let count: u64 = conn.query_row(
        "SELECT COUNT(*) FROM file_index WHERE parent_id = ?1",
        params![folder_id],
        |row| row.get(0),
    )?;
    
    Ok(count)
}

/// 预览图排序口径（LAN browse 的 `sort_by`/`sort_dir` 参数解析结果）。
///
/// `None`（或参数不合法）= 维持既有行为 `modified_at DESC`，旧客户端兼容。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FolderPreviewSort {
    pub sort_by: &'static str,
    pub sort_dir: &'static str,
}

/// 把 LAN 协议的 `sort_by`/`sort_dir` 参数解析为排序口径；缺省/非法值返回 `None`
/// （调用方据此维持 `modified_at DESC` 的既有 SQL，行为与旧版完全一致）。
pub fn parse_folder_preview_sort(sort_by: Option<&str>, sort_dir: Option<&str>) -> Option<FolderPreviewSort> {
    let by = match sort_by? {
        "name" => "name",
        "date" => "date",
        "size" => "size",
        _ => return None,
    };
    let dir = match sort_dir.unwrap_or("desc") {
        "asc" => "asc",
        "desc" => "desc",
        _ => return None,
    };
    Some(FolderPreviewSort { sort_by: by, sort_dir: dir })
}

/// 预览排序口径 → SQL ORDER BY 片段（只允许白名单里的列，防注入）。
fn preview_order_clause(sort: Option<FolderPreviewSort>) -> &'static str {
    match sort {
        Some(s) => match (s.sort_by, s.sort_dir) {
            ("name", "asc") => "name COLLATE NOCASE ASC",
            ("name", "desc") => "name COLLATE NOCASE DESC",
            ("date", "asc") => "created_at ASC",
            ("date", "desc") => "created_at DESC",
            ("size", "asc") => "size ASC",
            ("size", "desc") => "size DESC",
            // parse 已兜住非法值，这里只是穷举兜底
            _ => "modified_at DESC",
        },
        // 缺省 = 既有行为
        None => "modified_at DESC",
    }
}

pub fn get_folder_info_batch(
    conn: &Connection,
    folder_ids: &[String],
    sort: Option<FolderPreviewSort>,
) -> Result<std::collections::HashMap<String, (Vec<String>, u64, i64)>> {
    if folder_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }

    let mut result: std::collections::HashMap<String, (Vec<String>, u64, i64)> = std::collections::HashMap::new();
    for id in folder_ids {
        result.insert(id.clone(), (Vec::new(), 0, 0));
    }

    let placeholders: Vec<String> = folder_ids.iter().map(|_| "?".to_string()).collect();

    let count_sql = format!(
        "SELECT parent_id, COUNT(*) as cnt FROM file_index WHERE parent_id IN ({}) GROUP BY parent_id",
        placeholders.join(",")
    );

    let params: Vec<&dyn rusqlite::ToSql> = folder_ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();

    let mut count_stmt = conn.prepare(&count_sql)?;
    let count_rows = count_stmt.query_map(params.as_slice(), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
    })?;

    for row in count_rows {
        let (parent_id, count) = row?;
        if let Some(entry) = result.get_mut(&parent_id) {
            entry.1 = count;
        }
    }

    // 直接子图的最新创建时间（LAN 协议 latest_created_at：不递归嵌套，仅 file_type='Image'）
    let latest_sql = format!(
        "SELECT parent_id, MAX(created_at) FROM file_index WHERE parent_id IN ({}) AND file_type = 'Image' GROUP BY parent_id",
        placeholders.join(",")
    );
    let mut latest_stmt = conn.prepare(&latest_sql)?;
    let latest_rows = latest_stmt.query_map(params.as_slice(), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
    })?;

    for row in latest_rows {
        let (parent_id, latest) = row?;
        if let Some(entry) = result.get_mut(&parent_id) {
            entry.2 = latest.unwrap_or(0);
        }
    }

    let preview_sql = format!(
        "SELECT parent_id, path FROM (SELECT parent_id, path, ROW_NUMBER() OVER (PARTITION BY parent_id ORDER BY {}) as rn FROM file_index WHERE parent_id IN ({}) AND file_type = 'Image') WHERE rn <= 3",
        preview_order_clause(sort),
        placeholders.join(",")
    );

    let mut preview_stmt = conn.prepare(&preview_sql)?;
    let preview_rows = preview_stmt.query_map(params.as_slice(), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;

    for row in preview_rows {
        let (parent_id, path) = row?;
        if let Some(entry) = result.get_mut(&parent_id) {
            entry.0.push(path);
        }
    }

    Ok(result)
}

#[cfg(test)]
mod folder_info_batch_tests {
    use super::*;
    use rusqlite::Connection;

    fn img(id: &str, parent: &str, name: &str, size: u64, created: i64, modified: i64) -> FileIndexEntry {
        FileIndexEntry {
            file_id: id.into(),
            parent_id: Some(parent.into()),
            path: format!("uri://{}", id),
            name: name.into(),
            file_type: "Image".into(),
            size,
            created_at: created,
            modified_at: modified,
            width: None,
            height: None,
            format: None,
        }
    }

    fn folder(id: &str, name: &str) -> FileIndexEntry {
        FileIndexEntry {
            file_id: id.into(),
            parent_id: None,
            path: format!("/storage/{}", name),
            name: name.into(),
            file_type: "Folder".into(),
            size: 0,
            created_at: 0,
            modified_at: 0,
            width: None,
            height: None,
            format: None,
        }
    }

    /// 建库并塞入：F1 有三张子图（created: a=100, b=300, c=200；size: a=30, b=10, c=20；
    /// modified: a=1, b=2, c=3），F2 无子图。
    fn seed() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open in-memory db");
        create_table(&conn).expect("create table");
        let rows = vec![
            folder("F1", "F1"),
            folder("F2", "F2"),
            img("a", "F1", "a.jpg", 30, 100, 1),
            img("b", "F1", "b.jpg", 10, 300, 2),
            img("c", "F1", "c.jpg", 20, 200, 3),
        ];
        batch_upsert(&mut conn, &rows).expect("seed rows");
        conn
    }

    fn previews(conn: &Connection, sort: Option<FolderPreviewSort>) -> std::collections::HashMap<String, (Vec<String>, u64, i64)> {
        get_folder_info_batch(conn, &["F1".to_string(), "F2".to_string()], sort).expect("query")
    }

    fn first_preview(info: &std::collections::HashMap<String, (Vec<String>, u64, i64)>) -> &str {
        let (paths, _, _) = info.get("F1").expect("F1 present");
        paths.first().map(|s| s.as_str()).expect("has preview")
    }

    #[test]
    fn default_keeps_modified_desc_and_latest_is_max_created() {
        let conn = seed();
        let info = previews(&conn, None);
        // 既有行为：preview 按 modified_at DESC（c=3 最新）
        assert_eq!(first_preview(&info), "uri://c");
        // latest_created_at = 直接子图 MAX(created_at) = 300
        assert_eq!(info.get("F1").unwrap().2, 300);
        // 无直接子图的文件夹 latest = 0
        assert_eq!(info.get("F2").unwrap().2, 0);
    }

    #[test]
    fn date_sort_picks_first_by_created_at() {
        let conn = seed();
        let desc = parse_folder_preview_sort(Some("date"), Some("desc")).unwrap();
        let asc = parse_folder_preview_sort(Some("date"), Some("asc")).unwrap();
        assert_eq!(first_preview(&previews(&conn, Some(desc))), "uri://b", "date desc = created 300");
        assert_eq!(first_preview(&previews(&conn, Some(asc))), "uri://a", "date asc = created 100");
    }

    #[test]
    fn name_sort_is_case_insensitive() {
        let mut conn = Connection::open_in_memory().expect("open in-memory db");
        create_table(&conn).expect("create table");
        let rows = vec![
            folder("F1", "F1"),
            img("x", "F1", "BRAVO.jpg", 1, 1, 1),
            img("y", "F1", "alpha.jpg", 1, 2, 2),
        ];
        batch_upsert(&mut conn, &rows).expect("seed rows");

        let asc = parse_folder_preview_sort(Some("name"), Some("asc")).unwrap();
        let desc = parse_folder_preview_sort(Some("name"), Some("desc")).unwrap();
        let info = get_folder_info_batch(&conn, &["F1".to_string()], Some(asc)).expect("asc");
        assert_eq!(info.get("F1").unwrap().0[0], "uri://y", "NOCASE 下 alpha < BRAVO");
        let info = get_folder_info_batch(&conn, &["F1".to_string()], Some(desc)).expect("desc");
        assert_eq!(info.get("F1").unwrap().0[0], "uri://x");
    }

    #[test]
    fn size_sort_picks_first_by_bytes() {
        let conn = seed();
        let asc = parse_folder_preview_sort(Some("size"), Some("asc")).unwrap();
        let desc = parse_folder_preview_sort(Some("size"), Some("desc")).unwrap();
        assert_eq!(first_preview(&previews(&conn, Some(asc))), "uri://b", "size asc = 10 bytes");
        assert_eq!(first_preview(&previews(&conn, Some(desc))), "uri://a", "size desc = 30 bytes");
    }

    #[test]
    fn parse_rejects_missing_or_invalid_params() {
        assert!(parse_folder_preview_sort(None, None).is_none());
        assert!(parse_folder_preview_sort(Some("bogus"), Some("asc")).is_none());
        assert!(parse_folder_preview_sort(Some("name"), Some("sideways")).is_none());
        // sort_dir 缺省 = desc（协议约定方向可缺省）
        let s = parse_folder_preview_sort(Some("date"), None).unwrap();
        assert_eq!((s.sort_by, s.sort_dir), ("date", "desc"));
    }

    /// 与 `list_folders` 同口径（内容最新时间语义）：MAX 只看直接子图，不递归嵌套。
    #[test]
    fn latest_created_at_ignores_nested_folders() {
        let mut conn = Connection::open_in_memory().expect("open in-memory db");
        create_table(&conn).expect("create table");
        let rows = vec![
            folder("P", "P"),
            img("p1", "P", "p1.jpg", 1, 10, 1),
            {
                let mut nested = folder("C", "C");
                nested.parent_id = Some("P".into());
                nested
            },
            img("c1", "C", "c1.jpg", 1, 999, 9), // 嵌套子图：不计入 P 的 latest
        ];
        batch_upsert(&mut conn, &rows).expect("seed rows");
        let info = get_folder_info_batch(&conn, &["P".to_string()], None).expect("query");
        assert_eq!(info.get("P").unwrap().2, 10, "嵌套子文件夹里的图不计入");
    }
}
