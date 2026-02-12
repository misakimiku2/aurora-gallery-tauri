## 修复计划

### 需要修复的高风险 unwrap() 调用：

#### 1. main.rs:347-349 - 图像处理 unwrap

**位置**: `generate_drag_preview` 函数中
**问题**: `RgbImage::from_raw()` 和 `RgbaImage::from_raw()` 返回 `Option`，使用 `unwrap()` 可能导致 panic
**修复方案**: 使用 `ok_or()` 转换为错误处理，返回错误而不是 panic

#### 2. main.rs:2450 - 托盘图标 expect

**位置**: 托盘图标创建
**问题**: `app.default_window_icon().expect("No default window icon")` 如果没有默认图标会 panic
**修复方案**: 使用 `ok_or()` 处理，如果失败则打印警告并使用备用方案

#### 3. color\_db.rs:88 - 文件名获取 unwrap

**位置**: `ColorDbPool::new` 函数中
**问题**: `path.file_name().unwrap()` 如果路径以 `/` 或 `..` 结尾会 panic
**修复方案**: 使用 `ok_or()` 或提供默认值

#### 4. color\_db.rs:811 - 文件名获取 unwrap

**位置**: `get_db_file_sizes` 函数中
**问题**: 同上
**修复方案**: 同上

### 修改文件列表：

1. `src-tauri/src/main.rs` - 修复图像处理和托盘图标
2. `src-tauri/src/color_db.rs` - 修复文件名获取

### 修复后效果：

* 处理异常图片时不会 panic，而是返回错误

* 托盘图标创建失败时不会 panic，而是打印警告

* 数据库路径异常时不会 panic，而是返回错误

