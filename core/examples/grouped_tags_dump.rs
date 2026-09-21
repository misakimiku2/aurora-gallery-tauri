//! M4a 1.3 对照工具：把一份 `(词表, 文件→标签)` 输入喂给 Rust 的标签栈
//! （`db::tags` 建表入库 + `tag_counts` + `collate::group_tags`），打印分组 JSON，
//! 供 `src/utils/__tests__/groupedTags.spec.ts` 与 TS 侧 `groupedTags` 逐字段比对。
//!
//! 用法：`cargo run --release --example grouped_tags_dump <input.json> [locale]`

use std::collections::HashMap;

fn load(path: &str) -> serde_json::Value {
    let text = std::fs::read_to_string(path).expect("读不到对照输入");
    serde_json::from_str(&text).expect("对照输入不是合法 JSON")
}

fn main() {
    let input_path = std::env::args().nth(1).expect("用法: grouped_tags_dump <input.json> [locale]");
    let locale = std::env::args().nth(2).unwrap_or_else(|| "zh".into());
    let input = load(&input_path);

    let conn = rusqlite::Connection::open_in_memory().expect("建内存库");
    aurora_core::db::tags::create_table(&conn).unwrap();

    // 走 `set_file_tags` 会把每个标签都塞进词表，那样就复刻不出「词表里有、文件上没有」
    // 和「文件上有、词表里没有」这两种 React 侧真实存在的状态，所以这里直接写关联表。
    let mut positions: HashMap<String, i64> = HashMap::new();
    for file in input["files"].as_array().expect("files 不是数组") {
        let file_id = file[0].as_str().expect("file_id 不是字符串");
        let mut seen: Vec<String> = Vec::new();
        for tag in file[1].as_array().expect("tags 不是数组") {
            let tag = tag.as_str().expect("tag 不是字符串").to_string();
            if seen.contains(&tag) {
                continue;
            }
            seen.push(tag.clone());
            let position = positions.get(file_id).copied().unwrap_or(0);
            let inserted = conn
                .execute(
                    "INSERT OR IGNORE INTO file_tags (file_id, tag, position) VALUES (?1, ?2, ?3)",
                    rusqlite::params![file_id, tag, position],
                )
                .unwrap();
            // 被 (file_id, tag) 主键挡掉的重复不占位，position 才会连续
            positions.insert(file_id.to_string(), position + i64::from(inserted > 0));
        }
    }
    for tag in input["vocabulary"].as_array().expect("vocabulary 不是数组") {
        conn.execute(
            "INSERT OR IGNORE INTO tags (tag) VALUES (?1)",
            rusqlite::params![tag.as_str().unwrap()],
        )
        .unwrap();
    }

    let counts = aurora_core::db::tags::tag_counts(&conn).unwrap();
    let groups = aurora_core::collate::group_tags(&counts, &locale);

    // 分组**必须**输出成数组：JS 的 `Object.keys()` 会把 "0"…"9" 这类整数样键提到最前，
    // 一旦输出成对象，Rust 排好的组顺序就在解析那一刻丢了。
    let grouped: Vec<serde_json::Value> = groups
        .iter()
        .map(|(key, items)| {
            serde_json::json!({
                "key": key,
                "tags": items.iter().map(|(t, _)| t.as_str()).collect::<Vec<_>>(),
            })
        })
        .collect();
    let counter = serde_json::Map::from_iter(
        groups
            .iter()
            .flat_map(|(_, items)| items.iter().map(|(t, c)| (t.clone(), serde_json::json!(c)))),
    );

    let mut out = serde_json::Map::new();
    out.insert("groups".into(), serde_json::Value::Array(grouped));
    out.insert("counts".into(), serde_json::Value::Object(counter));
    print!("{}", serde_json::to_string(&serde_json::Value::Object(out)).unwrap());
}
