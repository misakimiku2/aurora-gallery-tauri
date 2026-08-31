# -*- coding: utf-8 -*-
"""
M0-S2 数据导出脚本：从桌面版 metadata.db 导出一个子集，生成 poc-data.db。

子集规则：
  - 取 file_index 中 file_type='Folder' 的文件夹（目标 3 个起）
  - 取这些文件夹下（parent_id 属于所选文件夹）的 Image 记录，合计约 200 张
  - 若 3 个文件夹的图片不足 200 张，自动追加更多文件夹
  - 只导出 file_index 表（M0 验证载荷是「列出文件夹与图片」，一张表足够）

用法：
  python scripts/export-poc-data.py [源db] [目标db]

默认：
  源db = %APPDATA%/com.aurora.gallery/metadata.db
  目标db = ffi-poc/poc-data.db
"""
import os
import sqlite3
import sys

SRC_DEFAULT = os.path.join(
    os.environ.get("APPDATA", ""), "com.aurora.gallery", "metadata.db"
)
DST_DEFAULT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "ffi-poc", "poc-data.db",
)

TARGET_FOLDERS = 3
TARGET_IMAGES = 200

COLS = [
    "file_id", "parent_id", "path", "name", "file_type", "size",
    "created_at", "modified_at", "width", "height", "format",
]
COL_DEFS = (
    "file_id TEXT PRIMARY KEY, parent_id TEXT, path TEXT NOT NULL UNIQUE, "
    "name TEXT NOT NULL, file_type TEXT NOT NULL, size INTEGER DEFAULT 0, "
    "created_at INTEGER DEFAULT 0, modified_at INTEGER DEFAULT 0, "
    "width INTEGER, height INTEGER, format TEXT"
)


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else SRC_DEFAULT
    dst = sys.argv[2] if len(sys.argv) > 2 else DST_DEFAULT

    if not os.path.exists(src):
        print(f"[ERROR] 源库不存在: {src}")
        sys.exit(1)

    conn = sqlite3.connect(src)
    conn.row_factory = sqlite3.Row

    # 1. 统计
    dist = conn.execute(
        "SELECT file_type, COUNT(*) FROM file_index GROUP BY file_type"
    ).fetchall()
    print("=== file_index 分布 ===")
    for r in dist:
        print(f"  {r[0]}: {r[1]}")

    # 2. 遍历所有 folder，逐个收集图片，直到凑够 TARGET_IMAGES
    all_folders = conn.execute(
        f"SELECT {','.join(COLS)} FROM file_index "
        "WHERE file_type = 'Folder' ORDER BY path"
    ).fetchall()

    if not all_folders:
        print("[ERROR] 未找到 Folder 记录，无法导出")
        sys.exit(1)

    selected_folders = []
    selected_images = []
    print(f"\n=== 收集文件夹与图片（目标 {TARGET_IMAGES} 张） ===")
    for f in all_folders:
        fid = f["file_id"]
        rows = conn.execute(
            f"SELECT {','.join(COLS)} FROM file_index "
            "WHERE parent_id = ? AND file_type = 'Image' "
            "ORDER BY modified_at DESC",
            (fid,),
        ).fetchall()
        # 至少保证有 3 个文件夹；图片够了就停
        selected_folders.append(f)
        selected_images.extend(rows)
        print(f"  [folder] {f['name']}: {len(rows)} 张图 (累计 {len(selected_images)})")
        if len(selected_folders) >= TARGET_FOLDERS and len(selected_images) >= TARGET_IMAGES:
            break

    selected_images = selected_images[:TARGET_IMAGES]
    print(f"\n=== 最终: {len(selected_folders)} 个文件夹, {len(selected_images)} 张图片 ===")

    # 3. 写出 poc-data.db
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.exists(dst):
        os.remove(dst)

    out = sqlite3.connect(dst)
    out.execute(f"CREATE TABLE file_index ({COL_DEFS})")
    out.execute("CREATE INDEX idx_file_index_parent ON file_index(parent_id)")

    def row_to_tuple(r):
        return tuple(r[c] for c in COLS)

    placeholders = ",".join(["?"] * len(COLS))
    rows = [row_to_tuple(r) for r in selected_folders] + [
        row_to_tuple(r) for r in selected_images
    ]
    out.executemany(
        f"INSERT INTO file_index ({','.join(COLS)}) VALUES ({placeholders})", rows
    )
    out.commit()

    # 4. 校验
    fc = out.execute(
        "SELECT COUNT(*) FROM file_index WHERE file_type='Folder'"
    ).fetchone()[0]
    ic = out.execute(
        "SELECT COUNT(*) FROM file_index WHERE file_type='Image'"
    ).fetchone()[0]
    print(f"\n=== 导出完成: {dst} ===")
    print(f"  Folder: {fc}, Image: {ic}, 总计: {fc + ic}")

    out.close()
    conn.close()


if __name__ == "__main__":
    main()
