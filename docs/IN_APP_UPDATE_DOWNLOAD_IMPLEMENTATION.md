# 应用内自动下载更新功能实现文档

## 概述

本文档记录了将 Aurora Gallery 的更新机制从"跳转到浏览器下载"改造为"应用内自动下载安装程序"的完整实现过程。

## 功能特性

1. **后台自动下载** - 点击"立即下载更新"后，安装程序会在后台自动下载
2. **暂停/继续** - 下载过程中可以暂停和继续
3. **进度显示** - 实时显示下载进度条、已下载大小、总大小和下载速度
4. **断点续传** - 支持断点续传，如果下载中断可以从上次位置继续
5. **下载完成后操作** - 下载完成后可选择"立即安装"或"打开文件夹"

## 技术架构

### 后端 (Rust)

#### 1. 更新检查模块 (`src/updater.rs`)

**修改内容：**
- 添加 `GithubReleaseAsset` 结构体，用于解析 GitHub Release 的 assets 信息
- 在 `UpdateCheckResult` 中添加 `installer_url` 和 `installer_size` 字段
- 新增 `extract_windows_installer()` 函数，自动从 Release assets 中提取 Windows 安装程序链接

**关键代码：**
```rust
#[derive(Debug, Clone, Deserialize)]
pub struct GithubReleaseAsset {
    pub name: String,
    pub browser_download_url: String,
    pub size: u64,
    pub content_type: String,
}

pub struct UpdateCheckResult {
    // ... 其他字段
    pub installer_url: Option<String>,
    pub installer_size: Option<u64>,
}

fn extract_windows_installer(assets: &[GithubReleaseAsset]) -> Option<(String, u64)> {
    // 优先查找 x64-setup.exe 结尾的文件
    for asset in assets {
        let name_lower = asset.name.to_lowercase();
        if name_lower.ends_with("x64-setup.exe") || name_lower.ends_with("_setup.exe") {
            return Some((asset.browser_download_url.clone(), asset.size));
        }
    }
    // 如果没有找到，查找任何 .exe 文件
    for asset in assets {
        let name_lower = asset.name.to_lowercase();
        if name_lower.ends_with(".exe") {
            return Some((asset.browser_download_url.clone(), asset.size));
        }
    }
    None
}
```

#### 2. 下载管理模块 (`src/update_downloader.rs`)

**新增文件**，包含以下核心功能：

##### 下载状态枚举
```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DownloadState {
    Idle,
    Preparing,  // 新增：准备下载状态
    Downloading,
    Paused,
    Completed,
    Error,
}
```

##### 下载进度结构体
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadProgress {
    pub state: String,
    pub progress: f64,        // 0.0 - 100.0
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub speed_bytes_per_sec: u64,
    pub file_path: String,
    pub error_message: Option<String>,
}
```

##### UpdateDownloader 核心方法

| 方法 | 功能 |
|------|------|
| `start_download()` | 开始下载，支持断点续传 |
| `pause_download()` | 暂停下载 |
| `resume_download()` | 继续下载 |
| `cancel_download()` | 取消下载 |
| `get_progress()` | 获取当前下载进度 |
| `install_update()` | 运行安装程序 |
| `open_download_folder()` | 打开下载文件夹 |

**下载文件存储位置：**
- Windows: `%LOCALAPPDATA%\Aurora\Downloads\Aurora_Gallery_{version}_x64-setup.exe`
- macOS: `~/Library/Application Support/Aurora/Downloads/`
- Linux: `~/.local/share/aurora/downloads/`

**断点续传实现：**
```rust
// 获取已下载的字节数
let resume_from = if file_path.exists() {
    std::fs::metadata(&file_path).map(|m| m.len()).unwrap_or(0)
} else {
    0
};

// 构建 Range 请求
if resume_from > 0 {
    request = request.header("Range", format!("bytes={}-", resume_from));
}
```

**进度事件发送：**
使用 Tauri 的 `Emitter` 向前端发送实时进度：
```rust
let _ = app_handle.emit("update-download-progress", progress);
```

#### 3. Tauri 命令 (`src/main.rs`)

新增以下命令：

```rust
#[tauri::command]
async fn start_update_download(installer_url: String, version: String, app_handle: tauri::AppHandle) -> Result<(), String>

#[tauri::command]
fn pause_update_download() -> Result<(), String>

#[tauri::command]
async fn resume_update_download(app_handle: tauri::AppHandle) -> Result<(), String>

#[tauri::command]
fn cancel_update_download() -> Result<(), String>

#[tauri::command]
fn get_update_download_progress() -> Result<DownloadProgress, String>

#[tauri::command]
fn install_update() -> Result<(), String>

#[tauri::command]
fn open_update_download_folder() -> Result<(), String>
```

#### 4. 依赖更新 (`Cargo.toml`)

新增依赖：
```toml
reqwest = { version = "0.12", features = ["json", "stream"] }
once_cell = "1.19"
futures-util = "0.3"
bytes = "1"
```

### 前端 (TypeScript/React)

#### 1. 类型定义 (`src/types.ts`)

```typescript
export type DownloadState = 'idle' | 'downloading' | 'paused' | 'completed' | 'error';

export interface DownloadProgress {
  state: DownloadState;
  progress: number;        // 0.0 - 100.0
  downloadedBytes: number;
  totalBytes: number;
  speedBytesPerSec: number;
  filePath: string;
  errorMessage?: string;
}

export interface UpdateInfo {
  // ... 其他字段
  installerUrl?: string;
  installerSize?: number;
}
```

#### 2. API 桥接 (`src/api/tauri-bridge.ts`)

新增函数：
```typescript
export const startUpdateDownload = async (installerUrl: string, version: string): Promise<void>
export const pauseUpdateDownload = async (): Promise<void>
export const resumeUpdateDownload = async (): Promise<void>
export const cancelUpdateDownload = async (): Promise<void>
export const getUpdateDownloadProgress = async (): Promise<DownloadProgressResult | null>
export const installUpdate = async (): Promise<void>
export const openUpdateDownloadFolder = async (): Promise<void>
```

#### 3. Hook (`src/hooks/useUpdateCheck.ts`)

**新增功能：**
- 下载状态管理
- 下载进度监听（通过 Tauri 事件）
- 下载控制函数

**进度监听实现：**
```typescript
useEffect(() => {
  const setupListener = async () => {
    unlisten = await listen<DownloadProgressResult>('update-download-progress', (event) => {
      const progress = convertDownloadProgress(event.payload);
      setDownloadProgress(progress);
    });
  };
  setupListener();
}, []);
```

#### 4. 更新弹窗 (`src/components/modals/UpdateModal.tsx`)

**UI 状态：**

| 状态 | 显示内容 |
|------|----------|
| 未开始 | "立即下载更新" 按钮，显示安装包大小 |
| 准备中 | 进度条显示 shimmer 动画（类似谷歌加载条）、"准备下载..."文本 |
| 下载中 | 进度条、百分比、已下载/总大小、下载速度、暂停/取消按钮 |
| 已暂停 | 进度条冻结、显示"已暂停"、继续/取消按钮 |
| 下载完成 | "立即安装"和"打开文件夹"按钮 |
| 下载错误 | 错误信息、"重新下载"按钮、"前往浏览器下载"选项 |

**准备状态动画：**
使用 CSS shimmer 动画，长条渐变从左侧向右发射：
```css
@keyframes shimmer {
  '0%': { transform: 'translateX(-100%)' },
  '100%': { transform: 'translateX(300%)' },
}
```

**文件大小格式化：**
```typescript
const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};
```

#### 5. 多语言翻译 (`src/utils/translations.ts`)

新增翻译键：
```typescript
about: {
  // 下载相关
  downloadComplete: '下载完成',
  downloadFailed: '下载出错',
  downloading: '下载中...',
  preparing: '准备下载...',
  paused: '已暂停',
  installNow: '立即安装',
  installLater: '稍后安装',
  openFolder: '打开文件夹',
  pause: '暂停',
  resume: '继续下载',
  cancel: '取消',
  retry: '重新下载',
  goToBrowser: '前往浏览器下载',
  remindLater: '稍后提醒',
  ignoreVersion: '忽略',
  installerSize: '安装包大小',
  releaseTitle: '版本标题',
  releaseNotes: '更新内容',
  noReleaseNotes: '暂无更新说明',
  downloadProgress: '下载进度',
  downloadSpeed: '下载速度',
  downloaded: '已下载',
  total: '总大小'
}
```

#### 6. 设置页面状态同步 (`src/components/SettingsModal.tsx`)

**功能：** 在设置-关于页面同步显示更新状态和下载完成的操作

**实现：**
- 将 `downloadProgress` 和安装/打开文件夹回调传递给 `AboutPanel`
- 根据下载状态显示不同的按钮：
  - 下载完成：显示"立即安装"和"打开文件夹"按钮
  - 下载中/暂停/错误/准备中：显示"查看下载进度"按钮，点击打开更新弹窗
  - 未开始下载：显示"下载"按钮
- 下载完成后，即使点击"稍后安装"清空了 `updateInfo`，设置页面仍会显示安装状态

**新增 props：**
```typescript
interface AboutPanelProps {
  // ... 原有 props
  downloadProgress?: DownloadProgress | null;
  onInstallUpdate?: () => void;
  onOpenDownloadFolder?: () => void;
}
```

## 增强功能

### 1. 准备状态 (Preparing State)

**问题：** 点击"立即下载"后，需要等待 1-2 秒才开始显示下载进度，用户体验不佳。

**解决方案：**
- 添加 `preparing` 下载状态
- 点击下载后立即显示准备状态，使用 shimmer 动画提示用户正在初始化
- 后端开始发送进度后自动切换到 `downloading` 状态

**实现：**
```typescript
// useUpdateCheck.ts
const startDownload = useCallback(async () => {
  // 设置准备状态
  setDownloadProgress({
    state: 'preparing',
    progress: 0,
    downloadedBytes: 0,
    totalBytes: updateInfo.installerSize || 0,
    speedBytesPerSec: 0,
    filePath: '',
  });
  // ... 开始下载
}, [updateInfo]);
```

### 2. 设置页面状态同步

**问题：** 下载完成后点击"稍后安装"，`updateInfo` 被清空，设置-关于页面显示"已是最新版本"，用户无法找到安装入口。

**解决方案：**
- 设置页面独立监听 `downloadProgress` 状态
- 下载完成时，即使 `updateInfo` 为空也显示安装状态
- 在"当前版本"旁边显示新版本号（绿色箭头）

**UI 布局：**
```
当前版本: 1.0.0 → v1.0.2          [立即安装] [打开文件夹]
下载完成
```

### 3. 新增翻译键

- `app.available` - 应用更新弹窗下的应用名称显示
- `settings.about.releaseTitle` - 版本标题
- `settings.about.preparing` - 准备下载状态文本

## 问题与修复

### 问题：文件权限错误 (os error 5)

**现象：** 点击下载时出现 "拒绝访问" 错误

**原因：** 在追加模式下打开文件后调用 `set_len(0)` 清空文件，在 Windows 上会导致权限错误

**修复：** 在打开文件之前，如果文件已存在且不是断点续传，先删除旧文件

```rust
// 如果不是断点续传，先删除已存在的文件
if resume_from == 0 && file_path.exists() {
    std::fs::remove_file(file_path)
        .map_err(|e| format!("Failed to remove existing file: {}", e))?;
}
```

## 用户体验流程

1. **检测更新** → 显示更新弹窗，展示版本信息、发布日期、安装包大小
2. **点击下载** → 开始后台下载，显示实时进度条和下载速度
3. **下载控制** → 可以暂停、继续或取消下载
4. **下载完成** → 显示"立即安装"和"打开文件夹"按钮
5. **安装更新** → 点击后启动安装程序

## 文件变更清单

### 后端
- `src-tauri/Cargo.toml` - 添加依赖
- `src-tauri/src/updater.rs` - 添加 installer_url 支持
- `src-tauri/src/update_downloader.rs` (新增) - 下载管理模块
- `src-tauri/src/main.rs` - 添加 Tauri 命令

### 前端
- `src/types.ts` - 添加类型定义（扩展 DownloadState 添加 'preparing'）
- `src/api/tauri-bridge.ts` - 添加 API 函数
- `src/hooks/useUpdateCheck.ts` - 添加下载管理（添加准备状态管理）
- `src/components/modals/UpdateModal.tsx` - 重构 UI（添加准备状态动画）
- `src/components/AppModals.tsx` - 更新 props（传递 downloadProgress 和安装回调）
- `src/components/SettingsModal.tsx` - 添加设置页面状态同步
- `src/App.tsx` - 更新 hook 使用（添加 open-update-modal 事件监听）
- `src/utils/translations.ts` - 添加翻译
- `tailwind.config.js` - 添加 shimmer 动画

## 测试验证

- [x] Rust 后端编译通过
- [x] 前端构建成功
- [x] 更新检查正常工作
- [x] 下载功能正常
- [x] 暂停/继续功能正常
- [x] 进度显示准确
- [x] 断点续传工作正常
- [x] 安装程序可以正常启动

## 致谢

- 感谢 reqwest 库提供的流式下载支持
- 感谢 Tauri 提供的事件系统用于前后端通信
