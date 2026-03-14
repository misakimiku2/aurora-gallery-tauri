# Changelog

All notable changes to this project will be documented in this file.

## [1.1.3] - 2026-03-14

### ✨ New Features

#### 局域网共享功能
- 内置 HTTP 服务器，支持局域网图片共享
- Token 认证机制，支持密码保护
- 支持多设备同时连接浏览
- 远程缩略图预览和图片查看
- 可选的远程编辑权限控制
- 可选的远程上传权限控制
- 连接设备管理和状态监控
- 自动获取本机局域网 IP 地址
- 端口可用性检查
- 设置界面支持服务开关和参数配置
- 独立的 LAN Share 客户端应用（基于 Vite 单独构建）
- 共享模块设计（主应用与 LAN Share 客户端共用组件）

### 🔧 Technical

- 新增 `src-tauri/src/lan_share/` 模块
  - `server.rs` - HTTP 服务器实现
  - `handlers.rs` - 请求处理器（认证、浏览、缩略图等）
  - `session.rs` - 会话管理（Token、过期时间）
  - `device_manager.rs` - 连接设备管理
  - `types.rs` - 类型定义
- 新增 `src-tauri/src/lan_share_commands.rs` 命令模块
- 新增 `src/lan-share/` 独立客户端应用
- 新增 `src/shared/` 共享模块（组件、Hooks、工具）
- 新增 `src/components/settings/LanSharePanel.tsx` 设置面板
- 新增依赖：axum, tower, tower-http, local-ip-address, uuid
- 新增构建脚本 `vite.config.lan-share.ts`

---

## [1.1.2] - 2026-03-11

### ✨ New Features

#### 智能创建专题功能
- 根据 WD14 V3 模型的角色标签格式，自动从角色名中提取作品名
- 创建专题并关联相关人物和图片
- 支持中英文双语作品名提取
- 内置 450+ 作品名中英文映射表（series_names.json）
- 作品列表支持虚拟滚动和多选
- 显示每个作品的角色数量和图片数量
- 预览选中作品的角色和图片
- 全选/取消全选按钮
- 自动过滤已创建的同名专题
- 检测阈值滑块（0.01 - 0.5）
- 作品搜索功能
- 自定义专题分类支持

### 🐛 Bug Fixes

- 修复图片添加到人物时，人物列表超出窗口范围的问题
- 修复智能创建专题后专题为空的问题
- 修复数据库死锁问题
- 修复已存在人物无法关联文件的问题
- 修复排序错误 `localeCompare is not a function`
- 修复图片数量显示为 0 的问题

### 💄 UI/UX Improvements

- 优化自动设置的人物头像、专题封面的锯齿问题
- 优化颜色搜索显示，不再直接在搜索框输出颜色值
- 重新设计标签界面的索引，从竖向改为居中横向布局
- 智能创建专题模态框 UI 优化：
  - 列表行高调整为 104px
  - 侧边栏宽度设置为 360px
  - 预览封面尺寸调整为 3:4 比例
  - "已创建"标签样式更新（绿色背景白色文字）
  - 预览区域使用缩略图替代原图，降低显存压力

### 🔧 Technical

- 新增 `src-tauri/src/work_extractor.rs` 作品名提取模块
- 新增命令 `clip_get_work_topics` 和 `clip_create_work_topics`
- 扩展 Topic 数据结构（source_type, work_name, work_name_cn）
- 扩展 Person 数据结构（character_tag_name, character_tag_index）
- 修复 react-window 兼容性问题

---

## [1.1.1] - 2026-03-05

### Bug Fixes
- Minor bug fixes and stability improvements

---

## [1.1.0] - 2026-02-28

### New Features
- WD14 Tagger integration for automatic tag generation
- CLIP model integration for semantic image search
- AI-powered image analysis and description generation

### Improvements
- Performance optimizations for large image libraries
- Enhanced thumbnail caching system

---

## [1.0.0] - 2026-01-15

### Initial Release
- Multi-library management
- Fast search with multiple dimensions
- Color search based on CIEDE2000 algorithm
- Face recognition and person grouping
- Topic management
- Custom tag system
- AI intelligent features
- Multiple view modes
- Image comparison
- Dark theme support
- Multi-language support (Chinese/English)
- Auto-update functionality
