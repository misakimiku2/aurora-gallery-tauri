# Aurora Gallery 自动更新检查功能实现文档

## 概述

本文档记录了为 Aurora Gallery 实现的 GitHub Releases 自动更新检查功能的完整实现过程、遇到的问题及解决方案。

## 实现时间

2026-02-13

## 功能需求

1. 应用启动时自动检查 GitHub Releases 是否有新版本
2. 在设置面板的"关于"页面添加手动检查更新按钮
3. 发现新版本时显示更新提醒模态框
4. 支持"忽略此版本"功能

---

## 修改的文件列表

### 1. 后端 Rust 代码

#### `src-tauri/Cargo.toml`
**添加依赖:**
```toml
reqwest = { version = "0.12", features = ["json"] }
```

#### `src-tauri/src/updater.rs` (新增文件)
**功能:** 更新检查核心模块
- `GithubRelease` 结构体 - 解析 GitHub API 响应
- `UpdateCheckResult` 结构体 - 返回给前端的更新信息
- `SemVer` 结构体 - 语义化版本号解析和比较
- `check_for_updates()` - 主检查函数，三层降级策略
- `check_github_api_latest()` - 使用 GitHub API /releases/latest
- `check_github_api_list()` - 使用 GitHub API /releases 列表
- `check_github_fallback()` - 网页抓取备用方案
- `extract_version_from_redirect_url()` - 从重定向 URL 提取版本号
- `extract_version_from_html()` - 从 HTML 提取版本号

#### `src-tauri/src/main.rs`
**修改内容:**
1. 添加模块导入: `mod updater;`
2. 添加 Tauri 命令:
   - `check_for_updates_command` - 检查更新
   - `open_external_link` - 打开外部链接
3. 使用 GitHub API 检查更新（仓库已公开，无需 Token 即可访问 releases）

### 2. 前端 TypeScript 代码

#### `src/types.ts`
**添加类型定义:**
```typescript
export type SettingsCategory = 'general' | 'appearance' | 'network' | 'storage' | 'ai' | 'performance' | 'about';

export interface UpdateInfo {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  downloadUrl: string;
  releaseNotes: string;
  publishedAt: string;
}

export interface UpdateSettings {
  autoCheck: boolean;
  checkFrequency: 'startup' | 'daily' | 'weekly';
  ignoredVersions: string[];
  lastCheckTime?: number;
}
```

#### `src/api/tauri-bridge.ts`
**添加函数:**
- `checkForUpdates()` - 调用 Rust 后端检查更新（**已移除 Token 参数**）
- `openExternalLink()` - 使用系统浏览器打开链接

#### `src/hooks/useUpdateCheck.ts` (新增文件)
**功能:** 更新检查 Hook
- 自动检查更新逻辑
- 本地存储管理（忽略的版本、设置）
- 检查频率控制（启动时/每天/每周）
- **(2026-02-13 更新)** 移除了 GitHub Token 相关代码
- 返回状态: `updateInfo`, `isChecking`, `checkUpdate`, `ignoreVersion`, `downloadUpdate`, `dismissUpdate`

#### `src/components/modals/UpdateModal.tsx` (新增文件)
**功能:** 更新提醒模态框
- 显示新版本信息（版本号、发布日期、更新日志）
- 三个操作按钮:
  - **立即下载** - 打开浏览器跳转到 Release 页面
  - **稍后提醒** - 关闭弹窗，下次启动再次检查
  - **忽略此版本** - 不再提醒该版本

#### `src/components/SettingsModal.tsx`
**修改内容:**
1. 添加导入: `Info`, `Github`, `ExternalLink`, `RefreshCwIcon`, `Package`, `Heart`, `Code2`, `Shield` 图标
2. 添加 `AboutPanel` 组件（内嵌在文件中）
3. 在侧边栏添加"关于"导航按钮
4. 添加 AboutPanel 渲染逻辑
5. **(2026-02-13 更新)** 移除了 GitHub Token 输入框

**AboutPanel 包含:**
- 软件信息卡片（Logo、名称、版本 v1.0.0、稳定版标签）
- 技术栈版本信息（应用版本、Tauri、React）
- 检查更新区域（当前版本、检查按钮、更新提示）
- 相关链接（GitHub、问题反馈）
- 致谢信息

#### `src/components/AppModals.tsx`
**修改内容:**
1. 添加 Props:
   - `updateInfo: UpdateInfo | null`
   - `onDownloadUpdate: () => void`
   - `onIgnoreUpdate: () => void`
   - `onDismissUpdate: () => void`
   - `onCheckUpdate: () => void`
   - `isCheckingUpdate: boolean`
2. 添加 UpdateModal 渲染
3. 向 SettingsModal 传递更新相关 props
4. **(2026-02-13 更新)** 移除了 GitHub Token 相关 props

#### `src/App.tsx`
**修改内容:**
1. 添加导入: `useUpdateCheck` hook
2. 使用 `useUpdateCheck` 获取更新状态和函数
3. 添加 useEffect: 检测到有更新时显示更新模态框
4. 向 AppModals 传递更新相关 props
5. **(2026-02-13 更新)** 移除了 GitHub Token 相关代码

#### `src/utils/translations.ts`
**添加翻译（中文和英文）:**
```typescript
settings: {
  catAbout: '关于',
  about: {
    tagline: '现代化的图片管理与浏览工具',
    stable: '稳定版',
    versions: '技术栈版本',
    appVersion: '应用版本',
    update: '软件更新',
    currentVersion: '当前版本',
    checkUpdate: '检查更新',
    checking: '检查中...',
    upToDate: '已是最新版本',
    newVersionAvailable: '发现新版本 {version}',
    newVersion: '新版本',
    publishedAt: '发布日期',
    download: '下载更新',
    links: '相关链接',
    viewSource: '查看源代码',
    issues: '问题反馈',
    reportBug: '报告 Bug 或建议',
    madeWith: '用',
    by: 'by'
  }
}
```

---

## 更新检查策略

### 三层降级策略

1. **第一层: GitHub API /releases/latest**
   - URL: `https://api.github.com/repos/{owner}/{repo}/releases/latest`
   - 优点: 返回完整的 release 信息
   - 缺点: 受速率限制（每小时 60 次，使用 Token 后 5000 次）

2. **第二层: GitHub API /releases 列表**
   - URL: `https://api.github.com/repos/{owner}/{repo}/releases?per_page=1`
   - 优点: 可以获取预发布版本
   - 缺点: 同样受速率限制

3. **第三层: 网页抓取备用方案**
   - URL: `https://github.com/{owner}/{repo}/releases/latest`
   - 方法: 捕获 302 重定向，从重定向 URL 提取版本号
   - 优点: 不受 API 速率限制
   - 缺点: 需要解析 HTML 或重定向 URL

### 请求头配置

备用方案使用完整的浏览器请求头来模拟真实 Chrome 浏览器:
```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36...
Accept: text/html,application/xhtml+xml,application/xml;q=0.9...
Accept-Language: en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7
Accept-Encoding: gzip, deflate, br
Cache-Control: no-cache
Pragma: no-cache
Sec-Ch-Ua: "Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"
Sec-Ch-Ua-Mobile: ?0
Sec-Ch-Ua-Platform: "Windows"
Sec-Fetch-Dest: document
Sec-Fetch-Mode: navigate
Sec-Fetch-Site: none
Sec-Fetch-User: ?1
Upgrade-Insecure-Requests: 1
```

---

## 遇到的问题

### 问题 1: GitHub API 403 速率限制
**现象:** `GitHub API rate limit exceeded. Please try again later.`
**原因:** 未认证的 GitHub API 请求限制为每小时 60 次
**解决方案:** 
- 实现三层降级策略，当 API 被限制时使用备用方案
- 仓库已公开，无需 Token 即可访问 releases，速率限制足够更新检查使用

### 问题 2: 备用方案返回 404
**现象:** `GitHub fallback response status: 404 Not Found`
**原因:** 
- GitHub 可能根据 User-Agent 或其他头信息返回不同响应
- 某些网络环境下 GitHub 页面访问被限制
**尝试的解决方案:**
- 禁用自动重定向，手动捕获 302 响应
- 添加完整的浏览器请求头
- 结果: 仍然返回 404，问题未完全解决

### 问题 3: Release 被标记为预发布
**现象:** `/releases/latest` API 返回 404，但页面有 Latest 标签
**原因:** Release 被标记为 "Pre-release"
**解决方案:** 添加 `/releases?per_page=1` 作为第二层检查，获取所有 releases

### 问题 4: 前端按钮无响应
**现象:** 点击"检查更新"按钮没有任何反应
**原因:** `onCheckUpdate` 回调被错误地绑定到 `onDownloadUpdate`
**解决方案:** 修复 AppModals.tsx 和 App.tsx 中的 props 传递

### 问题 5: 仓库为私有导致 API 返回 404
**现象:** API 返回 `Repository or release not found (404)`，但 Release 页面存在
**原因:** 仓库设置为私有，API 无法访问
**解决方案:** 将仓库设置为公开

---

## 当前状态

### 已完成功能
✅ 后端 Rust API 实现
✅ 前端 Hook 和状态管理
✅ 更新提醒模态框
✅ 关于页面和检查更新按钮
✅ 多语言翻译支持
✅ 三层降级策略框架
✅ 仓库已公开，无需 Token 即可检查更新

### 待解决问题
❌ 备用方案（网页抓取）在特定网络环境下返回 404
❌ 需要进一步调查 GitHub 页面访问限制的原因

### 临时解决方案
- 当所有方案都失败时，返回"暂无发布版本"而不是报错
- 用户可以在浏览器中手动访问 GitHub Releases 页面检查更新

---

## 建议的后续改进

1. **本地缓存**
   - 缓存最后一次成功的更新检查结果
   - 避免频繁请求 GitHub

2. **添加代理支持**
   - 允许用户配置 HTTP 代理
   - 解决某些网络环境下无法访问 GitHub 的问题

3. **手动更新检查**
   - 在关于页面添加"前往 GitHub 查看"按钮
   - 直接打开浏览器访问 releases 页面

---

## 相关链接

- GitHub Releases: https://github.com/misakimiku2/aurora-gallery-tauri/releases
- GitHub API 文档: https://docs.github.com/en/rest/releases/releases

---

## 更新日志

### 2026-02-13
- ✅ 仓库已设置为公开，移除 GitHub Token 相关代码
- ✅ 更新实现文档

---

## 备注

仓库已公开，更新检查功能无需 Token 即可正常工作。公开仓库的 API 速率限制（每小时 60 次）对于更新检查场景已经足够。备用方案（网页抓取）在特定网络环境下可能仍然存在问题，建议后续考虑添加代理支持。
