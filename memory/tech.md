# 技术栈和工具文档

## 前端技术栈

### 核心框架
- **React**: v18.2.0 - 用于构建用户界面的 JavaScript 库
- **TypeScript**: v5.2.2 - 带类型检查的 JavaScript 超集
- **Vite**: v5.1.4 - 下一代前端构建工具，提供快速的开发服务器和优化的构建

### UI 和样式
- **Tailwind CSS**: v3.4.1 - 实用优先的 CSS 框架
- **PostCSS**: v8.4.35 - CSS 处理器
- **Autoprefixer**: v10.4.18 - 自动添加 CSS 前缀

### 图标库
- **Lucide React**: v0.344.0 - 现代化图标集合

### 工具库
- **md5**: v2.3.0 - MD5 哈希计算
- **@vladmandic/face-api**: v1.7.12 - 人脸检测和识别 (浏览器端)

## 后端技术栈

### Tauri 生态
- **Tauri**: v2.0.0 - 桌面应用框架
- **Tauri CLI**: v2.0.0 - 命令行工具
- **Tauri 插件**:
  - `@tauri-apps/plugin-log`: v2.7.1 - 日志记录
  - `@tauri-apps/plugin-dialog`: v2.0.0-beta - 文件对话框
  - `tauri-plugin-dialog`: v2 - 对话框插件
  - `tauri-plugin-fs`: v2 - 文件系统插件
  - `tauri-plugin-shell`: v2 - Shell 插件
  - `tauri-plugin-log`: v2 - 日志插件

### Rust 核心依赖
```toml
[dependencies]
tauri = { version = "2.0", features = ["protocol-asset", "custom-protocol", "tray-icon"] }
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"
tauri-plugin-shell = "2"
tauri-plugin-log = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
walkdir = "2"                    # 目录遍历
image = { version = "0.24", features = ["jpeg", "png", "gif", "webp"] }  # 图片处理
webp = "0.2"                     # WebP 编码
fast_image_resize = "3.0"        # 高性能图片缩放
rayon = "1.8"                    # 并行处理
base64 = "0.21"                  # Base64 编码
md5 = "0.7"                      # MD5 哈希
chrono = { version = "0.4", features = ["serde"] }  # 时间处理
tokio = { version = "1", features = ["full"] }      # 异步运行时
urlencoding = "2.1"              # URL 编码
```

## 开发工具

### 构建和开发
- **Node.js**: v18+ (推荐 v20)
- **npm**: 包管理器
- **Vite**: 开发服务器和构建工具
- **TypeScript Compiler**: 类型检查和编译

### 代码质量
- **ESLint**: JavaScript/TypeScript 代码检查
- **Prettier**: 代码格式化
- **Tailwind CSS**: 样式工具

### 调试工具
- **React DevTools**: React 组件调试
- **Tauri Dev Tools**: 桌面应用调试
- **浏览器开发者工具**: 前端调试
- **Rust 调试器**: 后端调试

## 性能优化技术

### 图片处理优化
1. **fast_image_resize**: 使用 SIMD 指令的高性能图片缩放
2. **Rayon**: 数据并行处理，充分利用多核 CPU
3. **流式处理**: 大文件不一次性加载到内存
4. **格式优化**: JPEG/WebP 自动选择，透明度检测

### 内存管理
1. **对象复用**: 减少内存分配和释放
2. **懒加载**: 按需加载图片和数据
3. **虚拟滚动**: 大列表性能优化
4. **缓存策略**: 多级缓存减少重复计算

### 异步处理
1. **Tokio**: Rust 异步运行时
2. **React Hooks**: useEffect, useMemo, useCallback
3. **Web Workers**: 复杂计算异步化
4. **防抖节流**: 减少不必要的计算

## 数据存储方案

### 本地存储
1. **JSON 文件**: 用户数据持久化
   - 路径: `%APPDATA%/Aurora Gallery/user_data.json`
   - 格式: 结构化 JSON 数据
   - 同步: 自动保存，防抖机制

2. **缩略图缓存**: 
   - 路径: `%APPDATA%/Aurora Gallery/.Aurora_Cache/`
   - 格式: JPEG (无透明度) / WebP (有透明度)
   - 命名: `{hash}.{ext}` (基于文件特征)

### 内存存储
1. **文件树**: 完整的文件系统结构
2. **人物数据**: 人物信息和关联
3. **标签数据**: 标签定义和使用统计
4. **任务队列**: 进行中的操作状态

## 通信协议

### 前后端通信
```typescript
// 命令调用模式
const result = await invoke<T>('command_name', { param1, param2 });

// 事件监听模式
const unlisten = await listen('event-name', (event) => {
  // 处理事件
});
```

### 数据格式
```typescript
// 文件节点
interface FileNode {
  id: string;
  parent_id: string | null;
  name: string;
  type: 'image' | 'folder' | 'unknown';
  path: string;
  size?: number;
  children?: string[];
  tags: string[];
  created_at?: string;
  updated_at?: string;
  url?: string;
  meta?: ImageMeta;
}

// AI 分析结果
interface AIResult {
  description: string;
  tags: string[];
  sceneCategory: string;
  objects: string[];
  dominantColors: string[];
  people: string[];
  extractedText?: string;
  translatedText?: string;
  faces?: AiFace[];
}
```

## 安全机制

### 权限控制
1. **文件系统**: 只访问用户选择的目录
2. **网络访问**: AI 功能需要，可配置
3. **系统资源**: 最小化使用，避免阻塞

### 数据安全
1. **API 密钥**: 存储在系统密钥环
2. **输入验证**: 防止注入和恶意输入
3. **错误隔离**: 单个功能失败不影响整体
4. **数据加密**: 敏感信息加密存储

## 部署技术

### 构建流程
```bash
# 开发构建
npm run dev

# 生产构建
npm run build

# 清理缓存
npm run clean
```

### 打包格式
- **Windows**: MSI 安装包
- **macOS**: DMG 包
- **Linux**: AppImage, DEB, RPM

### 自动更新
- **Tauri Updater**: 内置更新机制
- **签名验证**: 确保更新包安全
- **增量更新**: 减少下载大小

## 测试策略

### 单元测试
- **Rust**: 使用 `cargo test`
- **TypeScript**: Jest + React Testing Library

### 集成测试
- **端到端**: Playwright 或 Cypress
- **API 测试**: Tauri 命令测试

### 手动测试
- **UI 交互**: 组件交互测试
- **性能测试**: 内存和 CPU 使用
- **兼容性**: 不同操作系统测试

## 监控和日志

### 日志级别
1. **Error**: 错误信息
2. **Warn**: 警告信息
3. **Info**: 一般信息
4. **Debug**: 调试信息
5. **Trace**: 详细跟踪

### 性能监控
- **内存使用**: 峰值和趋势
- **CPU 占用**: 处理效率
- **响应时间**: UI 和操作延迟
- **错误率**: 失败操作统计

## 开发环境配置

### 环境变量
```bash
# 开发模式
VITE_DEV_MODE=true

# AI 配置 (可选)
VITE_OPENAI_API_KEY=sk-...
VITE_OLLAMA_ENDPOINT=http://localhost:11434
VITE_LMSTUDIO_ENDPOINT=http://localhost:1234/v1
```

### VS Code 配置
```json
{
  "typescript.preferences.importModuleSpecifier": "relative",
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  }
}
```

## 未来技术规划

### 短期 (1-3 个月)
- **WebP 支持**: 更好的压缩和质量
- **AVIF 支持**: 下一代图片格式
- **GPU 加速**: 更高效的图片处理

### 中期 (3-6 个月)
- **云同步**: 跨设备数据同步
- **插件系统**: 扩展性架构
- **高级编辑**: 图片编辑功能

### 长期 (6-12 个月)
- **AI 增强**: 更多 AI 功能
- **协作功能**: 多用户支持
- **移动端**: 移动应用版本

---

*本文档记录了 Aurora Gallery Tauri 使用的所有技术栈、工具和最佳实践。*