//! `container_repairs`：容器原位修复的台账。
//!
//! 为什么必须有这张表：容器修复的每个动作都是**原位改 4 个字节**
//! （`elst`→`free` 遮蔽、`mdat` 长度字段扩写）。文件体积不变、画面数据不动，因此还原
//! 只需要知道「当年在哪个偏移、把什么值改成了什么值」——但这几笔**必须记下来**，
//! 不能靠事后重新解析去猜：
//! - 遮蔽之后 `elst` 这个名字已经不在文件里了，重新扫描只能靠「`edts` 里有个能按 elst
//!   解开来的 `free`」这种启发式去认（见 `mp4_editlist::ContainerVerdict::revert_targets`
//!   的警告）。万一把别人家用来填充的 `free` 判成残留并写回 `elst`，就是凭空造出一个
//!   非法 box，把好好一个文件弄坏。
//! - `mdat` 长度字段更不可能靠反推还原：合并后文件里**没有任何痕迹**指出原来的长度是多少。
//!
//! 所以台账存的是完整的 `(offset, expect, write)` 三元组，还原一律只读台账。
//!
//! 表放在 `.aurora/metadata.db` 里而不是 `user_data.json`：记的是「哪个文件被改过」，
//! 属于随库走的库级事实（同 `import_records` 的取舍）。
//!
//! ## 兼容性
//! 早期版本只有 `offsets` 一列（只存 elst 遮蔽偏移，还原时按 `free`→`elst` 对写）。
//! 新加的 `patches` 列存所有补丁；**旧行照旧可还原**（`patches` 为空时退回 `offsets` 语义），
//! 因此这里带一条 `ALTER TABLE` 迁移而不是重建表。

use rusqlite::{params, Connection, Result};

use crate::mp4_editlist::BytePatch;

/// 一条修复台账。
#[derive(Debug, Clone)]
pub struct ContainerRepair {
    pub path: String,
    /// 被改动的 4 字节字段绝对偏移（旧列，还原时若 `patches` 为空则按 elst 语义回退）。
    pub offsets: Vec<u64>,
    /// 完整补丁账目（新列）。顺序即写入顺序。
    pub patches: Vec<BytePatch>,
    /// 当时被藏起来的毫秒数。
    pub hidden_ms: i64,
    /// 采样表口径时长（毫秒）。
    pub table_ms: i64,
    /// `elst` 口径时长（毫秒）。
    pub elst_ms: i64,
    pub repaired_at: i64,
    /// 谁修的：`desktop` / `android`。排查时能分清是哪一端动过手。
    pub origin: String,
}

pub fn create_table(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS container_repairs (
            path TEXT PRIMARY KEY,
            offsets TEXT NOT NULL,
            hidden_ms INTEGER NOT NULL,
            table_ms INTEGER NOT NULL,
            elst_ms INTEGER NOT NULL,
            repaired_at INTEGER NOT NULL,
            origin TEXT NOT NULL,
            patches TEXT NOT NULL DEFAULT ''
        )",
        [],
    )?;
    // 老库升级：CREATE TABLE IF NOT EXISTS 不会给已存在的表补列，只能自己 ALTER。
    let has_patches = conn
        .prepare("SELECT 1 FROM pragma_table_info('container_repairs') WHERE name = 'patches'")?
        .exists([])?;
    if !has_patches {
        conn.execute(
            "ALTER TABLE container_repairs ADD COLUMN patches TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    Ok(())
}

fn join_offsets(offsets: &[u64]) -> String {
    offsets
        .iter()
        .map(|o| o.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

fn split_offsets(s: &str) -> Vec<u64> {
    s.split(',')
        .filter_map(|p| p.trim().parse::<u64>().ok())
        .collect()
}

fn hex4(b: &[u8; 4]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex4(s: &str) -> Option<[u8; 4]> {
    if s.len() != 8 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 4];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// 补丁编码：`offset:expectHex:writeHex:kind`，多条用 `;` 连。
pub fn encode_patches(patches: &[BytePatch]) -> String {
    patches
        .iter()
        .map(|p| format!("{}:{}:{}:{}", p.offset, hex4(&p.expect), hex4(&p.write), p.kind))
        .collect::<Vec<_>>()
        .join(";")
}

fn kind_from(s: &str) -> &'static str {
    match s {
        "elstMask" => "elstMask",
        "mdatSpan" => "mdatSpan",
        _ => "unknown",
    }
}

/// 解码。**脏数据一律丢掉而不是 panic**：台账是唯一还原依据，
/// 半截解析比不解析更危险（会按错误的偏移去写用户文件）。
pub fn decode_patches(s: &str) -> Vec<BytePatch> {
    if s.trim().is_empty() {
        return Vec::new();
    }
    s.split(';')
        .filter_map(|tok| {
            let mut it = tok.splitn(4, ':');
            let off = it.next()?.trim().parse::<u64>().ok()?;
            let expect = unhex4(it.next()?);
            let write = unhex4(it.next()?);
            let kind = it.next()?.trim();
            Some(BytePatch {
                offset: off,
                expect: expect?,
                write: write?,
                kind: kind_from(kind),
            })
        })
        .collect()
}

/// 记一次修复（同一路径重复修 → 覆盖，只保留最新一次的账）。
pub fn record(conn: &Connection, entry: &ContainerRepair) -> Result<()> {
    conn.execute(
        "INSERT INTO container_repairs (
            path, offsets, hidden_ms, table_ms, elst_ms, repaired_at, origin, patches
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(path) DO UPDATE SET
            offsets = excluded.offsets,
            hidden_ms = excluded.hidden_ms,
            table_ms = excluded.table_ms,
            elst_ms = excluded.elst_ms,
            repaired_at = excluded.repaired_at,
            origin = excluded.origin,
            patches = excluded.patches",
        params![
            entry.path,
            join_offsets(&entry.offsets),
            entry.hidden_ms,
            entry.table_ms,
            entry.elst_ms,
            entry.repaired_at,
            entry.origin,
            encode_patches(&entry.patches)
        ],
    )?;
    Ok(())
}

const COLS: &str = "path, offsets, hidden_ms, table_ms, elst_ms, repaired_at, origin, patches";

fn row_to_entry(row: &rusqlite::Row<'_>) -> Result<ContainerRepair> {
    let offsets_str: String = row.get(1)?;
    let patches_str: String = row.get(7)?;
    Ok(ContainerRepair {
        path: row.get(0)?,
        offsets: split_offsets(&offsets_str),
        hidden_ms: row.get(2)?,
        table_ms: row.get(3)?,
        elst_ms: row.get(4)?,
        repaired_at: row.get(5)?,
        origin: row.get(6)?,
        patches: decode_patches(&patches_str),
    })
}

/// 取某文件当年的修复账（还原用）。
pub fn get(conn: &Connection, path: &str) -> Result<Option<ContainerRepair>> {
    let sql = format!("SELECT {COLS} FROM container_repairs WHERE path = ?1");
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query_map(params![path], row_to_entry)?;
    match rows.next() {
        Some(r) => r.map(Some),
        None => Ok(None),
    }
}

/// 列全部台账（设置面板/还原入口用）。
pub fn list(conn: &Connection) -> Result<Vec<ContainerRepair>> {
    let sql = format!("SELECT {COLS} FROM container_repairs ORDER BY repaired_at DESC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_entry)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// 还原成功后注销。
pub fn remove(conn: &Connection, path: &str) -> Result<()> {
    conn.execute("DELETE FROM container_repairs WHERE path = ?1", params![path])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        create_table(&conn).unwrap();
        conn
    }

    fn entry(path: &str, offsets: &[u64]) -> ContainerRepair {
        ContainerRepair {
            path: path.into(),
            offsets: offsets.to_vec(),
            patches: Vec::new(),
            hidden_ms: 3_582_700,
            table_ms: 4_174_471,
            elst_ms: 591_785,
            repaired_at: 1,
            origin: "desktop".into(),
        }
    }

    fn patch(off: u64, kind: &'static str) -> BytePatch {
        BytePatch {
            offset: off,
            expect: *b"elst",
            write: *b"free",
            kind,
        }
    }

    #[test]
    fn offsets_round_trip_as_csv() {
        let conn = mem();
        record(&conn, &entry("a.mp4", &[1_559_435, 2_360_755, 4294967296])).unwrap();
        let got = get(&conn, "a.mp4").unwrap().unwrap();
        assert_eq!(got.offsets, vec![1_559_435, 2_360_755, 4_294_967_296]);
        assert_eq!(got.origin, "desktop");
    }

    /// 两类补丁混在一条账里也必须逐字节还原得回来。
    #[test]
    fn patches_round_trip_including_mdat_span() {
        let conn = mem();
        let mut e = entry("a.mp4", &[1_559_435]);
        e.patches = vec![
            patch(1_559_435, "elstMask"),
            BytePatch {
                offset: 2_360_779,
                expect: 232_688u32.to_be_bytes(),
                write: 559_992_405u32.to_be_bytes(),
                kind: "mdatSpan",
            },
        ];
        record(&conn, &e).unwrap();
        let got = get(&conn, "a.mp4").unwrap().unwrap();
        assert_eq!(got.patches, e.patches, "补丁必须原样读回（含 4 字节旧值）");
        assert_eq!(got.patches[1].kind, "mdatSpan");
    }

    #[test]
    fn legacy_row_without_patches_still_reads_offsets() {
        let conn = mem();
        record(&conn, &entry("old.mp4", &[42])).unwrap();
        let got = get(&conn, "old.mp4").unwrap().unwrap();
        assert!(got.patches.is_empty(), "旧行的 patches 为空");
        assert_eq!(got.offsets, vec![42], "旧行仍要能按老语义还原");
    }

    /// 老库（没有 patches 列）必须被 ALTER 补上而不是报错。
    #[test]
    fn migrates_a_pre_patches_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE container_repairs (
                path TEXT PRIMARY KEY, offsets TEXT NOT NULL, hidden_ms INTEGER NOT NULL,
                table_ms INTEGER NOT NULL, elst_ms INTEGER NOT NULL,
                repaired_at INTEGER NOT NULL, origin TEXT NOT NULL
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO container_repairs VALUES ('k.mp4','7',1,2,3,4,'desktop')",
            [],
        )
        .unwrap();
        create_table(&conn).unwrap();
        let got = get(&conn, "k.mp4").unwrap().unwrap();
        assert_eq!(got.offsets, vec![7]);
        assert!(got.patches.is_empty());
    }

    #[test]
    fn same_path_overwrites_not_duplicates() {
        let conn = mem();
        record(&conn, &entry("a.mp4", &[10])).unwrap();
        record(&conn, &entry("a.mp4", &[20, 30])).unwrap();
        assert_eq!(list(&conn).unwrap().len(), 1, "同一路径不该堆重复台账");
        assert_eq!(get(&conn, "a.mp4").unwrap().unwrap().offsets, vec![20, 30]);
    }

    #[test]
    fn remove_clears_ledger() {
        let conn = mem();
        record(&conn, &entry("a.mp4", &[10])).unwrap();
        remove(&conn, "a.mp4").unwrap();
        assert!(get(&conn, "a.mp4").unwrap().is_none());
    }

    #[test]
    fn unknown_path_is_none_not_error() {
        let conn = mem();
        assert!(get(&conn, "nope.mp4").unwrap().is_none());
    }

    /// 台账是还原的唯一依据，脏数据必须降级成「空」而不是 panic 或半截值。
    #[test]
    fn malformed_offsets_column_degrades_to_empty() {
        let conn = mem();
        record(&conn, &entry("a.mp4", &[10])).unwrap();
        conn.execute(
            "UPDATE container_repairs SET offsets = 'garbage,,7' WHERE path = 'a.mp4'",
            [],
        )
        .unwrap();
        let got = get(&conn, "a.mp4").unwrap().unwrap();
        assert_eq!(got.offsets, vec![7], "非数字 token 应被丢掉");
    }

    #[test]
    fn malformed_patch_column_degrades_to_empty_not_panic() {
        let conn = mem();
        let mut e = entry("a.mp4", &[]);
        e.patches = vec![patch(1_559_435, "elstMask")];
        record(&conn, &e).unwrap();
        conn.execute(
            "UPDATE container_repairs SET patches = '9:zzzzzzzz:0000free:elstMask;7:00' WHERE path = 'a.mp4'",
            [],
        )
        .unwrap();
        let got = get(&conn, "a.mp4").unwrap().unwrap();
        assert!(got.patches.is_empty(), "hex 不合法/token 残缺的一律丢掉，绝不能拿去写文件");
    }

    #[test]
    fn unknown_kind_is_flagged_not_dropped() {
        let conn = mem();
        let mut e = entry("a.mp4", &[]);
        e.patches = vec![patch(5, "elstMask")];
        record(&conn, &e).unwrap();
        conn.execute(
            "UPDATE container_repairs SET patches = '5:656c7374:66726565:weird' WHERE path='a.mp4'",
            [],
        )
        .unwrap();
        let got = get(&conn, "a.mp4").unwrap().unwrap();
        assert_eq!(got.patches.len(), 1, "kind 认不出不影响字节账本身");
        assert_eq!(got.patches[0].kind, "unknown");
        assert_eq!(got.patches[0].expect, *b"elst");
    }
}
