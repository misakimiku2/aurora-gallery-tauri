use rusqlite::{Connection, Result};
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

pub mod persons;
pub mod file_metadata;
pub mod file_index;

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

    pub fn switch<P: AsRef<Path>>(&self, path: P) -> std::result::Result<(), String> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        let conn = Connection::open(path).map_err(|e| e.to_string())?;

        // Performance settings
        let _ = conn.execute("PRAGMA journal_mode=WAL", []);
        let _ = conn.execute("PRAGMA synchronous=NORMAL", []);
        let _ = conn.execute("PRAGMA foreign_keys=ON", []);

        // Initialize tables for the new database
        init_db(&conn).map_err(|e| e.to_string())?;

        let mut conn_guard = self.conn.lock().unwrap();
        *conn_guard = conn;
        Ok(())
    }
}

pub fn normalize_path(path: &str) -> String {
    let mut normalized = path.replace('\\', "/");
    // Handle Windows leading slash from Tauri/Frontend (e.g. /C:/path -> C:/path)
    if cfg!(windows) && normalized.starts_with('/') && normalized.len() > 2 && normalized.chars().nth(2) == Some(':') {
        normalized = normalized[1..].to_string();
    }
    normalized
}

pub fn generate_id(path: &str) -> String {
    let normalized = normalize_path(path);
    let hash = md5::compute(normalized.as_bytes());
    format!("{:x}", hash)[..9].to_string()
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

    // Create file_metadata table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS file_metadata (
            file_id TEXT PRIMARY KEY,
            path TEXT NOT NULL,
            tags TEXT,
            description TEXT,
            source_url TEXT,
            ai_data TEXT,
            updated_at INTEGER
        )",
        [],
    )?;

    // Create indexes for file_metadata
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_file_metadata_path ON file_metadata(path)",
        [],
    )?;

    // Create file_index table
    file_index::create_table(conn)?;

    Ok(())
}
