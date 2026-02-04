#Category Persistence & Path Normalization Fix

**Date:** 2026-02-05
**Status:** Resolved

## Issue Description
Users reported that changing a folder's "Category" (e.g., from "General" to "Book") successfully updated the UI, but the setting reverted to the default value ("General") after restarting the application.

## Root Cause Analysis
This bug was caused by a combination of three distinct issues:

1.  **Missing Persistence Layer**: The `category` field existed in the Frontend state but was completely missing from the Backend `FileMetadata` struct, the SQLite database schema, and the persistence logic.
2.  **Path Normalization Mismatch (Critical)**:
    -   **Write Path**: When saving metadata, the app was sending Windows-style paths (e.g., `E:\Photos\Album`).
    -   **Read Path**: During startup/scanning, the app generates queries using Normalized/Unix-style paths (e.g., `E:/Photos/Album`).
    -   **Result**: The SQL query `... WHERE path LIKE 'E:/Photos/Album/%'` failed to match records stored as `E:\Photos\Album`, causing the app to ignore saved metadata.
3.  **Root Node Omission**: The logic responsible for re-attaching metadata (description, tags, category) during a scan was applied to *children* of the scanned folder, but explicitly missed the **root folder** itself.

## Implementation Details

### 1. Database Schema Update
**File**: `src-tauri/src/db/mod.rs`
- Added an automatic migration step in `init_db`.
- Executes `ALTER TABLE file_metadata ADD COLUMN category TEXT` if the column is missing.

### 2. Rust Backend Updates
**File**: `src-tauri/src/db/file_metadata.rs`
- Updated `FileMetadata` struct to include `pub category: Option<String>`.
- Updated all SQL queries (`INSERT`, `SELECT`, `UPDATE`) to handle the new `category` column.

**File**: `src-tauri/src/main.rs`
- **Path Normalization Fix**: Modified `db_upsert_file_metadata` to force normalize the path (replace `\` with `/`) *before* writing to the database.
  ```rust
  // Before saving, ensure path is normalized so LIKE queries work later
  metadata.path = normalize_path(&metadata.path); 
  ```
- **Root Node Logic**: Updated `scan_directory` to specifically look up and attach metadata for the root directory ID, ensuring the top-level folder's category is restored.
- **Fast Startup**: Updated the database-first startup logic (Fast Startup) to map the `category` field from the cached index to the `FileNode`.

### 3. Frontend Updates
**File**: `src/api/tauri-bridge.ts`
- Updated `FileMetadata` interface and `updateFileMetadata` function to support the optional `category` parameter.

**File**: `src/App.tsx`
- Updated `handleUpdateFile` to pass the `category` state to the backend when a change occurs.

## Verification
- **Test**: Set a folder to "Book", restart the app.
- **Result**: The folder correctly shows "Book" type on launch.
- **Logs**: verified `db_upsert_file_metadata` writes normalized paths, and `scan_directory` successfully retrieves `category: Some("book")`.
