use rusqlite::{Connection, Result};
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

pub mod persons;

#[derive(Clone)]
pub struct AppDbPool {
    conn: Arc<Mutex<Connection>>,
}

impl AppDbPool {
    pub fn new<P: AsRef<Path>>(path: P) -> std::result::Result<Self, String> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        let conn = Connection::open(path).map_err(|e| e.to_string())?;

        // Performance settings
        let _ = conn.execute("PRAGMA journal_mode=WAL", []);
        let _ = conn.execute("PRAGMA synchronous=NORMAL", []);
        let _ = conn.execute("PRAGMA foreign_keys=ON", []);

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn get_connection(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap()
    }
}

pub fn init_db(conn: &Connection) -> Result<()> {
    // Create persons table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS persons (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            cover_file_id TEXT,
            face_box_x REAL,
            face_box_y REAL,
            face_box_w REAL,
            face_box_h REAL,
            count INTEGER DEFAULT 0,
            description TEXT,
            updated_at INTEGER
        )",
        [],
    )?;

    // Create indexes
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_persons_cover_file ON persons(cover_file_id)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_persons_name ON persons(name)",
        [],
    )?;

    Ok(())
}
