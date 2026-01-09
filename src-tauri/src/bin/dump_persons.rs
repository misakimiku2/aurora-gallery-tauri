use rusqlite::Connection;
use std::env;
use std::path::PathBuf;

fn main() {
    let appdata = env::var("APPDATA").unwrap_or_else(|_| "".to_string());
    let mut db_path = if !appdata.is_empty() {
        let mut p = PathBuf::from(appdata);
        p.push("com.aurora.gallery");
        p.push("metadata.db");
        p
    } else {
        PathBuf::from("metadata.db")
    };

    if !db_path.exists() {
        eprintln!("DB not found at {}", db_path.display());
        std::process::exit(1);
    }

    let conn = Connection::open(db_path).expect("failed to open db");

    let count: i64 = conn.query_row("SELECT COUNT(*) FROM persons", [], |r| r.get(0)).unwrap_or(0);
    println!("persons count: {}", count);

    let mut stmt = conn.prepare("SELECT id, name, cover_file_id, count, face_box_x, face_box_y, face_box_w, face_box_h, updated_at FROM persons ORDER BY name LIMIT 50").expect("prepare");
    let mut rows = stmt.query([]).expect("query");
    while let Some(row) = rows.next().expect("next") {
        let id: String = row.get(0).unwrap_or_default();
        let name: String = row.get(1).unwrap_or_default();
        let cover: Option<String> = row.get(2).ok();
        let cnt: Option<i64> = row.get(3).ok();
        let bx: Option<f64> = row.get(4).ok();
        let by: Option<f64> = row.get(5).ok();
        let bw: Option<f64> = row.get(6).ok();
        let bh: Option<f64> = row.get(7).ok();
        let updated: Option<i64> = row.get(8).ok();
        println!("- {} | {} | cover={} | count={} | box={:?}", id, name, cover.unwrap_or_default(), cnt.unwrap_or(0), (bx,by,bw,bh));
    }
}