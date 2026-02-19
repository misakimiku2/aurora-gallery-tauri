# main.rs 模块拆分重构记录

## 概述

本次重构将 `src-tauri/src/main.rs` 从 **3865 行** 拆分为 **311 行**，减少了 **91.9%** 的代码量，显著提升了代码的可维护性和可读性。

## 重构日期

2026-02-19

## 重构前状态

- **文件**: `src-tauri/src/main.rs`
- **总行数**: 3865 行
- **Tauri 命令数**: 69 个
- **问题**: 单文件过于庞大，难以维护和导航

## 重构后状态

- **main.rs 行数**: 311 行
- **新增模块数**: 10 个
- **代码减少**: 91.9%

## 新增模块详情

### 1. `file_types.rs` - 核心类型定义模块 (~60 行)

**功能**: 核心数据结构定义

**导出内容**:
- `SavedWindowState` - 窗口状态保存结构体
- `FileType` - 文件类型枚举 (Image, Folder, Unknown)
- `ImageMeta` - 图像元数据结构体
- `FileNode` - 文件节点结构体
- `ScanProgress` - 扫描进度结构体
- `SUPPORTED_EXTENSIONS` - 支持的图像扩展名常量
- `is_supported_image()` - 判断是否为支持的图像格式

**依赖**: `serde`, `chrono`

---

### 2. `image_utils.rs` - 图像工具模块 (~150 行)

**功能**: 图像格式检测、尺寸获取、特殊格式预览

**导出内容**:
- `is_jxl()` - 判断是否为 JXL 格式
- `is_avif()` - 判断是否为 AVIF 格式
- `get_image_dimensions()` - 获取图像尺寸
- `get_avif_preview()` - AVIF 预览命令 (Tauri Command)
- `get_jxl_preview()` - JXL 预览命令 (Tauri Command)
- `ACTIVE_HEAVY_DECODES` - 并发解码计数器
- `MAX_CONCURRENT_HEAVY_DECODES` - 最大并发解码数

**依赖**: `image`, `jxl_oxide`, `base64`, `fast_image_resize`, `rayon`

---

### 3. `scanner.rs` - 目录扫描模块 (~600 行)

**功能**: 目录扫描、HDD 检测、文件索引

**导出内容**:
- `scan_directory()` - 主扫描命令 (Tauri Command)
- `force_rescan()` - 强制重扫命令 (Tauri Command)

**内部实现**:
- HDD 检测缓存机制
- 并行扫描优化
- 增量更新支持
- 后台索引处理

**依赖**: `jwalk`, `rayon`, `crossbeam-channel`, `chrono`, `tauri`

---

### 4. `file_operations.rs` - 文件操作命令模块 (~750 行)

**功能**: 文件系统操作相关命令

**导出内容**:
- `scan_file()` - 单文件扫描命令
- `ensure_directory()` - 确保目录存在
- `file_exists()` - 文件存在检查
- `create_folder()` - 创建文件夹
- `rename_file()` - 重命名文件
- `db_copy_file_metadata()` - 复制元数据
- `delete_file()` - 删除文件
- `copy_image_colors()` - 复制图片颜色
- `copy_image_to_clipboard()` - 复制到剪贴板
- `copy_file()` - 复制文件
- `move_file()` - 移动文件
- `write_file_from_bytes()` - 写入文件

**依赖**: `arboard`, `fs`, `tokio`, `tauri`

---

### 5. `clip_commands.rs` - CLIP 命令模块 (~650 行)

**功能**: CLIP AI 搜索相关命令

**导出内容**:
- `clip_search_by_text()` - 文本搜索
- `clip_search_by_image()` - 以图搜图
- `clip_generate_embedding()` - 生成嵌入向量
- `clip_get_embedding_status()` - 获取嵌入状态
- `clip_load_model()` - 加载模型
- `clip_unload_model()` - 卸载模型
- `clip_is_model_loaded()` - 检查模型是否加载
- `clip_get_embedding_count()` - 获取嵌入数量
- `clip_get_model_status()` - 获取模型状态
- `clip_delete_model()` - 删除模型
- `clip_open_model_folder()` - 打开模型文件夹
- `clip_generate_embeddings_batch()` - 批量生成嵌入
- `clip_cancel_embedding_generation()` - 取消生成
- `clip_pause_embedding_generation()` - 暂停生成
- `clip_resume_embedding_generation()` - 继续生成
- `clip_update_config()` - 更新配置
- `get_all_image_files()` - 获取所有图像文件

**依赖**: `clip` 模块, `tauri`, `once_cell`, `tokio`

---

### 6. `db_commands.rs` - 数据库命令模块 (~230 行)

**功能**: 数据库相关 Tauri 命令

**导出内容**:
- `force_wal_checkpoint()` - 强制 WAL 检查点
- `get_wal_info()` - 获取 WAL 信息
- `save_user_data()` - 保存用户数据
- `load_user_data()` - 加载用户数据
- `db_get_all_people()` - 获取所有人物
- `db_upsert_person()` - 更新/插入人物
- `db_delete_person()` - 删除人物
- `db_update_person_avatar()` - 更新人物头像
- `db_get_all_topics()` - 获取所有专题
- `db_upsert_topic()` - 更新/插入专题
- `db_delete_topic()` - 删除专题
- `db_upsert_file_metadata()` - 更新/插入文件元数据
- `switch_root_database()` - 切换根数据库
- `get_color_db_stats()` - 获取颜色数据库统计
- `get_color_db_error_files()` - 获取错误文件列表
- `retry_color_extraction()` - 重试颜色提取
- `delete_color_db_error_files()` - 删除错误文件记录

**依赖**: `db` 模块, `color_db` 模块, `tauri`

---

### 7. `system_commands.rs` - 系统工具命令模块 (~200 行)

**功能**: 系统级工具命令

**导出内容**:
- `get_default_paths()` - 获取默认路径
- `open_path()` - 打开路径（资源管理器）
- `read_file_as_base64()` - 读取文件为 Base64
- `open_external_link()` - 打开外部链接
- `proxy_http_request()` - HTTP 请求代理

**依赖**: `reqwest`, `base64`, `tauri`

---

### 8. `window_commands.rs` - 窗口控制命令模块 (~90 行)

**功能**: 窗口状态管理和控制

**导出内容**:
- `get_window_state_path()` - 获取窗口状态路径
- `get_initial_db_paths()` - 获取初始数据库路径
- `save_window_state()` - 保存窗口状态
- `hide_window()` - 隐藏窗口 (Tauri Command)
- `show_window()` - 显示窗口 (Tauri Command)
- `set_window_min_size()` - 设置窗口最小尺寸 (Tauri Command)
- `exit_app()` - 退出应用 (Tauri Command)

**依赖**: `tauri`

---

### 9. `color_commands.rs` - 颜色相关命令模块 (~100 行)

**功能**: 颜色提取相关命令

**导出内容**:
- `get_dominant_colors()` - 获取主色调 (Tauri Command)
- `add_pending_files_to_db()` - 添加待处理文件 (Tauri Command)

**依赖**: `color_extractor`, `color_db`, `color_worker`, `tauri`

---

### 10. `update_commands.rs` - 更新相关命令模块 (~70 行)

**功能**: 应用更新相关命令

**导出内容**:
- `check_for_updates_command()` - 检查更新 (Tauri Command)
- `start_update_download()` - 开始下载更新 (Tauri Command)
- `pause_update_download()` - 暂停下载 (Tauri Command)
- `resume_update_download()` - 继续下载 (Tauri Command)
- `cancel_update_download()` - 取消下载 (Tauri Command)
- `get_update_download_progress()` - 获取下载进度 (Tauri Command)
- `install_update()` - 安装更新 (Tauri Command)
- `open_update_download_folder()` - 打开下载文件夹 (Tauri Command)

**依赖**: `updater`, `update_downloader`, `tauri`

---

## 重构后的 main.rs 结构

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// 标准库导入
use std::fs;
use std::path::Path;
use std::sync::Arc;

// Tauri 导入
use tauri::Manager;
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::menu::{Menu, MenuItem};

// 已有模块声明
mod color_extractor;
mod color_db;
mod color_worker;
mod db;
mod color_search;
mod thumbnail;
mod updater;
mod update_downloader;
mod clip;

// 新拆分的模块声明
mod file_types;
mod image_utils;
mod scanner;
mod file_operations;
mod clip_commands;
mod db_commands;
mod system_commands;
mod window_commands;
mod color_commands;
mod update_commands;

// 导入和使用语句
use crate::thumbnail::{...};
use crate::color_search::{...};
use crate::file_types::SavedWindowState;
use crate::window_commands::{...};
use db::AppDbPool;

fn main() {
    tauri::Builder::default()
        .plugin(...)
        .invoke_handler(tauri::generate_handler![
            // 所有命令注册
        ])
        .setup(|app| {
            // 初始化逻辑
        })
        .on_window_event(...)
        .run(...)
}
```

---

## 依赖关系修复

重构过程中需要修复以下依赖关系：

### color_worker.rs
```rust
// 修改前
use crate::{is_jxl, ACTIVE_HEAVY_DECODES, MAX_CONCURRENT_HEAVY_DECODES};

// 修改后
use crate::image_utils::{is_jxl, ACTIVE_HEAVY_DECODES, MAX_CONCURRENT_HEAVY_DECODES};
```

### thumbnail.rs
```rust
// 修改前
use crate::ACTIVE_HEAVY_DECODES;

// 修改后
use crate::image_utils::ACTIVE_HEAVY_DECODES;
```

---

## 编译验证

重构后执行 `cargo check` 验证：

```
✅ 编译成功
⚠️ 存在一些未使用代码的警告（预留功能）
```

---

## 模块依赖图

```
main.rs
├── file_types.rs (基础类型，无内部依赖)
├── image_utils.rs (基础工具，无内部依赖)
├── scanner.rs
│   ├── file_types
│   ├── image_utils
│   └── db
├── file_operations.rs
│   ├── file_types
│   ├── image_utils
│   ├── db
│   └── color_db
├── clip_commands.rs
│   └── clip
├── db_commands.rs
│   ├── db
│   └── color_db
├── system_commands.rs (无内部依赖)
├── window_commands.rs
│   └── file_types
├── color_commands.rs
│   ├── color_extractor
│   ├── color_db
│   └── color_worker
└── update_commands.rs
    ├── updater
    └── update_downloader
```

---

## 收益总结

1. **可维护性提升**: 每个模块职责单一，便于理解和修改
2. **编译速度**: 修改单个模块时只需重新编译该模块
3. **代码导航**: IDE 可以更快速地定位代码
4. **团队协作**: 不同开发者可以独立修改不同模块
5. **测试隔离**: 可以针对单个模块进行单元测试

---

## 后续建议

1. 考虑为每个新模块添加单元测试
2. 可以进一步拆分 `clip` 模块中的子模块
3. 考虑将 `db` 模块中的各个子模块也拆分为独立文件
4. 添加模块级别的文档注释

---

**文档版本**: 1.0  
**创建日期**: 2026-02-19  
**作者**: Aurora Gallery Team
