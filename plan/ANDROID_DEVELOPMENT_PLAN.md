# Aurora Gallery Android 开发规划

## 一、技术选型分析

### 推荐方案：Tauri 2.0 Android

**优势**：
- **代码复用率高**：现有 React 前端代码可直接复用，Rust 后端也可编译到 Android
- **已有共享模块**：`src/shared/` 目录已包含可复用的组件和逻辑
- **局域网API已就绪**：桌面端的 HTTP API 已完整实现，安卓端只需调用
- **统一技术栈**：与桌面端保持一致，降低维护成本

**技术架构**：
```
┌─────────────────────────────────────────────────────┐
│                  Android 应用层                      │
│  ┌─────────────────────────────────────────────┐   │
│  │         React Native / React 前端            │   │
│  │  ┌───────────┐  ┌───────────┐  ┌─────────┐  │   │
│  │  │ 共享组件   │  │ Android  │  │  平板   │  │   │
│  │  │ (shared/) │  │ 适配组件  │  │ 专属UI  │  │   │
│  │  └───────────┘  └───────────┘  └─────────┘  │   │
│  └─────────────────────────────────────────────┘   │
│                        │                            │
│              Tauri IPC Bridge                       │
│                        │                            │
│  ┌─────────────────────────────────────────────┐   │
│  │           Rust 后端 (Native)                 │   │
│  │  ┌───────────┐  ┌───────────┐  ┌─────────┐  │   │
│  │  │ 本地文件  │  │  网络层   │  │ 缩略图  │  │   │
│  │  │ 扫描器    │  │ (HTTP)    │  │ 生成器  │  │   │
│  │  └───────────┘  └───────────┘  └─────────┘  │   │
│  └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
                        │
              ┌─────────┴─────────┐
              │                   │
        ┌─────▼─────┐       ┌─────▼─────┐
        │ 本地存储   │       │ 桌面端    │
        │ (图片库)   │       │ LAN API   │
        └───────────┘       └───────────┘
```

---

## 二、功能模块规划

## 二、开发策略

### 核心原则

1. **平板优先**：先完成平板版开发，确保功能完整
2. **平板还原桌面端 UI**：平板屏幕足够大，尽量保持与桌面端一致的布局和交互
3. **手机简化适配**：手机版基于平板版进行 UI 简化，功能保留但交互方式调整

### 开发顺序

```
平板完整版 ──────► 手机简化版
(还原桌面端UI)    (列表视图+抽屉面板)
```

### 功能模块规划

| 功能模块 | 平板版 | 手机版 | 优先级 | 备注 |
|---------|:------:|:------:|:------:|------|
| 本地图片浏览 | ✅ | ✅ | P0 | 已实现（109文件夹/21744图片） |
| 文件夹导航 | ✅ | ✅ | P0 | 已实现 |
| 图片查看器 | ✅ | ✅ | P0 | 已实现（需适配触摸手势） |
| 缩略图显示 | ⚠️ | ⚠️ | P0 | 待实现（当前无缩略图） |
| 局域网发现 | ✅ | ✅ | P0 | |
| 连接桌面端 | ✅ | ✅ | P0 | |
| 远程图片浏览 | ✅ | ✅ | P1 | |
| 上传图片到桌面 | ✅ | ✅ | P1 | |
| 从桌面下载图片 | ✅ | ✅ | P1 | |
| 多选操作 | ✅ | ✅ | P1 | |
| 搜索功能 | ✅ | ✅ | P2 | 手机版简化 UI |
| 颜色搜索 | ✅ | ✅ | P2 | 手机版简化 UI |
| 人物浏览 | ✅ | ✅ | P3 | 手机版使用列表视图 |
| 专题浏览 | ✅ | ✅ | P3 | 手机版使用列表视图 |
| 分屏对比 | ✅ | ❌ | P3 | 手机屏幕太小不适合 |

### 平板 vs 桌面端 UI 对比

| 组件 | 桌面端 | 平板端 | 说明 |
|-----|-------|-------|------|
| 侧边栏 | 左侧固定 | 左侧固定 | 保持一致 |
| 文件网格 | 网格/瀑布流/列表 | 网格/瀑布流/列表 | 保持一致 |
| 图片查看器 | 居中全屏 | 居中全屏 | 保持一致 |
| 元数据面板 | 右侧固定 | 右侧固定 | 保持一致 |
| 标签页 | 顶部标签栏 | 顶部标签栏 | 保持一致 |
| 工具栏 | 顶部工具栏 | 顶部工具栏 | 保持一致 |
| 右键菜单 | 鼠标右键 | 长按触发 | 触发方式不同 |
| 拖拽操作 | 鼠标拖拽 | 长按拖拽 | 触发方式不同 |

---

## 三、开发阶段规划

### 第一阶段：基础架构搭建（预计 2-3 周）

#### 1.1 项目初始化
- [x] 创建 Tauri Android 项目配置
- [x] 配置 Android SDK 和 NDK 环境
- [x] 设置构建脚本和 CI/CD

#### 1.2 核心适配
- [x] 创建 Android 平台适配器（直接在 App.tsx 中实现，非独立文件）
- [x] 实现 Android 文件系统访问（MediaStore API via JNI）
- [x] 配置 Android 权限（存储、网络）

#### 1.3 基础 UI 框架
- [ ] 创建响应式布局系统
- [ ] 实现平板/手机自适应布局
- [x] 移植基础组件（FileCard, FileGrid, ImageViewer）— 复用桌面端组件

**交付物**：
- [x] 可运行的 Android 应用骨架
- [x] 本地图片列表显示
- [x] 基础图片查看功能

---

### 第二阶段：本地功能完善（预计 2 周）

#### 2.1 本地图片管理
- [x] 扫描设备图片库
- [x] 按文件夹/相册分组显示
- [ ] 图片元数据读取（EXIF）

#### 2.2 缩略图系统
- [ ] 实现本地缩略图生成
- [ ] 缩略图缓存机制
- [ ] 内存优化（LRU 缓存）

#### 2.3 基础交互
- [ ] 手势支持（缩放、滑动、双击）
- [ ] 下拉刷新
- [ ] 虚拟滚动优化

**交付物**：
- 完整的本地图片浏览功能
- 流畅的图片查看体验

---

### 第三阶段：局域网连接（预计 2-3 周）

#### 3.1 设备发现
- [ ] 局域网设备扫描
- [ ] 自动发现桌面端服务
- [ ] 手动输入 IP 连接

#### 3.2 连接管理
- [ ] 连接认证（密码验证）
- [ ] 设备列表管理
- [ ] 连接状态监控

#### 3.3 远程浏览
- [ ] 调用桌面端 HTTP API
- [ ] 远程文件夹浏览
- [ ] 远程图片缩略图加载
- [ ] 远程图片查看

**API 对接**：
```typescript
// 复用现有 LAN Share API
const api = new HttpAdapter('http://192.168.1.100:8080');

// 认证
await api.auth('access-code', 'My Tablet');

// 浏览
const browseResult = await api.browse('/folder/path');

// 获取缩略图
const thumbnailUrl = api.getThumbnailUrl('/path/to/image.jpg');

// 获取原图
const imageUrl = api.getImageUrl('/path/to/image.jpg');
```

**交付物**：
- 完整的局域网连接功能
- 远程图片浏览体验

---

### 第四阶段：上传下载功能（预计 2 周）

#### 4.1 上传功能
- [ ] 选择本地图片上传
- [ ] 批量上传支持
- [ ] 上传进度显示
- [ ] 断点续传

#### 4.2 下载功能
- [ ] 下载远程图片到本地
- [ ] 批量下载支持
- [ ] 下载进度显示
- [ ] 下载路径选择

#### 4.3 文件传输优化
- [ ] 压缩传输
- [ ] 并发控制
- [ ] 后台传输

**交付物**：
- 完整的双向文件传输功能

---

### 第五阶段：高级功能开发（预计 2-3 周）

> **目标**：平板版完整还原桌面端功能，手机版进行 UI 简化适配

#### 5.1 平板布局（还原桌面端）
- [ ] 左侧固定侧边栏（文件树）
- [ ] 右侧固定元数据面板
- [ ] 顶部标签页管理
- [ ] 顶部工具栏
- [ ] 网格/瀑布流/列表布局切换

#### 5.2 搜索功能
- [ ] 文本搜索（调用桌面端 API）
- [ ] AI 语义搜索
- [ ] 搜索历史
- [ ] 平板：顶部搜索栏 + 结果网格
- [ ] 手机：顶部搜索栏 + Tab 切换

#### 5.3 颜色搜索
- [ ] 颜色选择器
- [ ] 调色板搜索
- [ ] 颜色预设
- [ ] 平板：完整颜色选择器
- [ ] 手机：预设颜色 + 简化选择器

#### 5.4 人物/专题浏览
- [ ] 人物网格视图（平板）
- [ ] 专题网格视图（平板）
- [ ] 人物列表视图（手机）
- [ ] 专题列表视图（手机）
- [ ] 人物详情页
- [ ] 专题详情页

#### 5.5 图片对比模式（仅平板）
- [ ] 分屏对比
- [ ] 滑动对比
- [ ] 标注功能

#### 5.6 触摸交互适配
- [ ] 长按触发右键菜单
- [ ] 长按拖拽文件
- [ ] 双指缩放图片
- [ ] 滑动切换图片

**交付物**：
- 平板版：完整还原桌面端 UI 和功能
- 搜索、颜色搜索、人物/专题浏览功能
- 平板专属对比功能

---

### 第六阶段：手机版适配（预计 1-2 周）

> **目标**：基于平板版进行 UI 简化，保留所有功能但调整交互方式

#### 6.1 手机布局调整
- [ ] 隐藏左侧侧边栏（改为抽屉式）
- [ ] 隐藏右侧元数据面板（改为底部抽屉）
- [ ] 底部导航栏
- [ ] 单栏主内容区

#### 6.2 搜索功能适配
- [ ] 顶部搜索栏
- [ ] Tab 切换（文本/颜色/AI）
- [ ] 简化的搜索结果网格

#### 6.3 颜色搜索适配
- [ ] 预设颜色选择
- [ ] 简化颜色选择器
- [ ] 颜色搜索结果

#### 6.4 人物/专题适配
- [ ] 列表视图代替网格视图
- [ ] 底部抽屉式详情面板
- [ ] 简化的操作菜单

#### 6.5 交互优化
- [ ] 单手操作优化
- [ ] 手势导航
- [ ] 快速滚动

**交付物**：
- 完整的手机版体验
- 所有功能在手机上可用（除分屏对比）

---

## 四、目录结构规划

```
aurora-gallery-tauri/
├── src/                            # 桌面端前端代码
├── src-tauri/                      # 桌面端 Rust 后端
│
├── mobile/                         # 移动端代码（Android/iOS）[新增]
│   ├── src/                        # 移动端前端代码
│   │   ├── api/
│   │   │   └── adapters/
│   │   │       └── AndroidAdapter.ts  # Android API 适配器
│   │   ├── components/
│   │   │   ├── TabletLayout.tsx    # 平板布局
│   │   │   ├── PhoneLayout.tsx     # 手机布局
│   │   │   ├── DeviceDiscovery.tsx # 设备发现
│   │   │   ├── ConnectionPanel.tsx # 连接面板
│   │   │   └── TransferManager.tsx # 传输管理
│   │   ├── hooks/
│   │   │   ├── useDeviceDiscovery.ts
│   │   │   ├── useConnection.ts
│   │   │   └── useTransfer.ts
│   │   ├── utils/
│   │   │   └── platform.ts         # 平台检测
│   │   ├── styles/
│   │   │   └── mobile.css          # 移动端样式
│   │   ├── App.mobile.tsx          # 移动端入口
│   │   └── types.ts
│   │
│   └── src-tauri/                  # 移动端 Rust 后端 [新增]
│       ├── src/
│       │   └── android/            # Android 专属模块
│       │       ├── mod.rs
│       │       ├── media_store.rs  # MediaStore 访问
│       │       └── thumbnail.rs    # 缩略图生成
│       ├── tauri.conf.json         # Android 配置
│       └── Cargo.toml              # Android 依赖
│
├── src/shared/                     # 共享模块（已存在，移动端可复用）
│   ├── api/
│   │   └── adapters/
│   │       ├── TauriAdapter.ts     # 桌面端
│   │       ├── HttpAdapter.ts      # LAN 客户端
│   │       └── index.ts
│   ├── components/
│   ├── hooks/
│   └── utils/
│
└── src/lan-share/                  # LAN 客户端（已存在）
```

---

## 五、关键技术点

### 5.1 Android 文件访问

```rust
// src-tauri/src/android/media_store.rs
use jni::objects::{JObject, JString};
use jni::JNIEnv;

pub fn scan_device_images(env: &mut JNIEnv) -> Vec<ImageInfo> {
    // 通过 JNI 调用 Android MediaStore
    let content_resolver = ...;
    let cursor = content_resolver.query(
        MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
        projection,
        selection,
        selection_args,
        sort_order
    );
    // 解析结果...
}
```

### 5.2 响应式布局

```tsx
// src/android/components/AdaptiveLayout.tsx
import { useDeviceType } from '../hooks/useDeviceType';

export function AdaptiveLayout() {
  const { isTablet, isPhone } = useDeviceType();
  
  if (isTablet) {
    return <TabletLayout />;
  }
  
  return <PhoneLayout />;
}
```

### 5.3 局域网连接

```tsx
// src/android/hooks/useConnection.ts
export function useConnection() {
  const [devices, setDevices] = useState<LanDevice[]>([]);
  const [connected, setConnected] = useState(false);
  
  const discoverDevices = async () => {
    // 扫描局域网
    const discovered = await scanLanDevices();
    setDevices(discovered);
  };
  
  const connect = async (device: LanDevice, code: string) => {
    const api = new HttpAdapter(`http://${device.ip}:8080`);
    await api.auth(code, 'Aurora Android');
    setConnected(true);
  };
  
  return { devices, connected, discoverDevices, connect };
}
```

---

## 六、流畅度优化策略（首要目标）

> **核心原则**：流畅度 > 功耗优化。无论任何情况，必须保证界面操作的流畅性，这是用户体验的基础。

### 6.1 流畅度目标

| 指标 | 目标值 | 说明 |
|-----|-------|------|
| 缩略图加载 | < 50ms | 滑动到即显示，无明显等待 |
| 滚动帧率 | 60 FPS | 始终保持 60 帧，不卡顿 |
| 页面切换 | < 100ms | 页面切换无感知延迟 |
| 图片打开 | < 200ms | 点击到显示原图的时间 |
| 手势响应 | < 16ms | 触摸到响应的单帧时间 |

### 6.2 缩略图极速加载

#### 6.2.1 多级缓存架构

```
┌─────────────────────────────────────────────────────────────┐
│                    缩略图加载流程                            │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  请求缩略图 ──► 内存缓存 ──► 磁盘缓存 ──► 原图生成          │
│                   │             │            │              │
│                   ▼             ▼            ▼              │
│              命中即返回     异步加载      后台预生成         │
│              (< 1ms)       (< 10ms)      (< 50ms)          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### 6.2.2 缩略图预生成策略

```rust
// 缩略图预生成器
pub struct ThumbnailPreGenerator {
    // 预生成队列
    preload_queue: VecDeque<ImagePath>,
    // 预生成范围（当前可见区域前后各 N 张）
    preload_range: usize,
    // 生成线程池
    workers: ThreadPool,
}

impl ThumbnailPreGenerator {
    // 滚动时触发预生成
    pub fn on_scroll(&mut self, visible_range: Range<usize>, all_images: &[ImagePath]) {
        // 清空旧队列
        self.preload_queue.clear();
        
        // 预生成可见区域前后的图片
        let start = visible_range.start.saturating_sub(self.preload_range);
        let end = (visible_range.end + self.preload_range).min(all_images.len());
        
        for i in start..end {
            if !self.is_cached(&all_images[i]) {
                self.preload_queue.push_back(all_images[i].clone());
            }
        }
        
        // 立即开始生成
        self.start_generation();
    }
}
```

#### 6.2.3 缩略图尺寸优化

| 场景 | 缩略图尺寸 | 质量 | 说明 |
|-----|----------|------|------|
| 快速滑动 | 128x128 | 70% | 最小尺寸，最快加载 |
| 正常浏览 | 256x256 | 85% | 平衡质量和速度 |
| 停止滑动 | 512x512 | 95% | 高清预览 |

```rust
// 动态缩略图尺寸
pub fn get_thumbnail_size(scroll_state: ScrollState) -> (u32, u32, u8) {
    match scroll_state {
        ScrollState::FastScrolling => (128, 128, 70),   // 快速滑动
        ScrollState::Scrolling => (256, 256, 85),       // 正常滑动
        ScrollState::Idle => (512, 512, 95),            // 静止
    }
}
```

### 6.3 滚动流畅度优化

#### 6.3.1 虚拟滚动优化

```tsx
// 高性能虚拟滚动
interface VirtualScrollConfig {
  // 每行项目数
  itemsPerRow: number;
  // 预渲染行数（可见区域外）
  overscanRows: number;
  // 缓冲区大小
  bufferSize: number;
}

const OPTIMAL_CONFIG: VirtualScrollConfig = {
  itemsPerRow: 4,        // 平板：4-6，手机：3-4
  overscanRows: 3,       // 预渲染 3 行
  bufferSize: 50,        // 缓存 50 个组件
};
```

#### 6.3.2 渲染优化

| 优化项 | 实现方式 | 效果 |
|-------|---------|------|
| **组件复用** | React.memo + useCallback | 减少 50% 重渲染 |
| **图片懒加载** | Intersection Observer | 只加载可见图片 |
| **渐进式渲染** | 先低清后高清 | 用户感知更快 |
| **离屏渲染** | requestIdleCallback | 利用空闲时间 |
| **避免布局抖动** | 固定尺寸占位 | 消除跳动 |

#### 6.3.3 手势优化

```tsx
// 手势响应优化
export function useOptimizedGestures() {
  const [isGesturing, setIsGesturing] = useState(false);
  
  // 手势开始时暂停非关键任务
  const onGestureStart = useCallback(() => {
    setIsGesturing(true);
    // 暂停后台任务
    pauseBackgroundTasks();
    // 降低缩略图质量
    setThumbnailQuality('low');
  }, []);
  
  // 手势结束后恢复
  const onGestureEnd = useCallback(() => {
    setIsGesturing(false);
    // 恢复后台任务
    resumeBackgroundTasks();
    // 恢复缩略图质量
    setThumbnailQuality('high');
  }, []);
  
  return { onGestureStart, onGestureEnd };
}
```

### 6.4 图片解码优化

#### 6.4.1 解码策略

```rust
// 图片解码器
pub struct ImageDecoder {
    // 解码线程池
    decode_pool: ThreadPool,
    // 解码优先级队列
    priority_queue: PriorityDecoderQueue,
}

impl ImageDecoder {
    // 快速解码路径（仅 JPEG）
    pub fn fast_decode_jpeg(&self, path: &Path) -> Result<RgbaImage> {
        // 使用 libjpeg-turbo 快速解码
        // 比 image crate 快 3-5 倍
        turbojpeg::decode_file(path)
    }
    
    // 区域解码（大图优化）
    pub fn decode_region(&self, path: &Path, region: Rect) -> Result<RgbaImage> {
        // 只解码需要的区域
        // 适用于大图预览
        let decoder = JpegDecoder::new(File::open(path)?)?;
        decoder.decode_region(region)
    }
}
```

#### 6.4.2 格式支持策略

| 格式 | 优先级 | 解码方式 | 说明 |
|-----|-------|---------|------|
| JPEG | 最高 | libjpeg-turbo | 主流格式，极速解码 |
| PNG | 高 | image crate | 常见格式 |
| WebP | 中 | libwebp | 现代格式 |
| HEIC | 低 | 系统解码 | iOS 格式，依赖系统 |
| AVIF | 低 | libavif | 新格式，可选支持 |
| JXL | 最低 | jxl-oxide | 桌面端支持，移动端可选 |

```rust
// 格式优先级判断
pub fn get_format_priority(format: ImageFormat) -> u8 {
    match format {
        ImageFormat::Jpeg => 100,    // 最高优先
        ImageFormat::Png => 80,
        ImageFormat::WebP => 60,
        ImageFormat::Heic => 40,
        _ => 20,                     // 其他格式最低
    }
}
```

### 6.5 内存优化

#### 6.5.1 内存池管理

```rust
// 缩略图内存池
pub struct ThumbnailMemoryPool {
    // 内存池大小（根据设备内存动态调整）
    pool_size: usize,
    // LRU 缓存
    cache: LruCache<PathBuf, Arc<Thumbnail>>,
    // 当前内存使用
    current_usage: AtomicUsize,
}

impl ThumbnailMemoryPool {
    pub fn new() -> Self {
        // 根据设备内存动态调整
        let total_mem = get_total_memory();
        let pool_size = match total_mem {
            mem if mem >= 8 * 1024 => 256 * 1024 * 1024,  // 8GB+ -> 256MB
            mem if mem >= 4 * 1024 => 128 * 1024 * 1024,  // 4-8GB -> 128MB
            _ => 64 * 1024 * 1024,                         // <4GB -> 64MB
        };
        
        Self {
            pool_size,
            cache: LruCache::new(NonZeroUsize::new(pool_size / 64 / 1024).unwrap()),
            current_usage: AtomicUsize::new(0),
        }
    }
}
```

#### 6.5.2 内存压力响应

```rust
// 内存压力监听
pub struct MemoryPressureMonitor {
    last_pressure: MemoryPressure,
}

impl MemoryPressureMonitor {
    pub fn on_memory_pressure(&mut self, level: MemoryPressure) {
        match level {
            MemoryPressure::Normal => {
                // 正常运行
            }
            MemoryPressure::Warning => {
                // 开始清理缓存
                clear_old_thumbnails(0.3);  // 清理 30%
            }
            MemoryPressure::Critical => {
                // 紧急清理
                clear_old_thumbnails(0.7);  // 清理 70%
                stop_background_tasks();
            }
        }
    }
}
```

### 6.6 流畅度监控

#### 6.6.1 帧率监控

```typescript
interface FrameRateMonitor {
  // 获取当前帧率
  getCurrentFPS(): number;
  
  // 获取帧时间分布
  getFrameTimeDistribution(): FrameTimeStats;
  
  // 监听掉帧
  onFrameDrop(callback: (droppedFrames: number) => void): () => void;
}

interface FrameTimeStats {
  average: number;      // 平均帧时间 (ms)
  p95: number;          // 95 分位
  p99: number;          // 99 分位
  droppedFrames: number; // 掉帧数
}
```

#### 6.6.2 性能指标

| 指标 | 目标 | 警告阈值 | 说明 |
|-----|-----|---------|------|
| 平均帧率 | 60 FPS | < 55 FPS | 主要指标 |
| 掉帧率 | < 1% | > 3% | 连续掉帧比例 |
| 卡顿次数 | 0 | > 5次/分钟 | 明显卡顿 |
| 内存峰值 | < 70% | > 85% | 占设备内存比例 |

### 6.7 流畅度开发任务清单

#### 第一阶段：基础优化
- [ ] 实现多级缩略图缓存
- [ ] 实现虚拟滚动组件
- [ ] 优化 JPEG 解码（libjpeg-turbo）
- [ ] 实现手势响应优化

#### 第二阶段：进阶优化
- [ ] 实现缩略图预生成
- [ ] 实现动态缩略图尺寸
- [ ] 实现内存池管理
- [ ] 实现内存压力响应

#### 第三阶段：监控与调优
- [ ] 实现帧率监控
- [ ] 实现性能指标采集
- [ ] 实现性能问题报警
- [ ] 性能调优测试

---

## 七、功耗优化策略

### 6.1 功耗问题分析

移动端设备电池容量有限，长时间运行图片处理应用会消耗大量电量。主要功耗来源：

| 功耗来源 | 占比 | 说明 |
|---------|:----:|------|
| **CPU 计算** | 35% | 缩略图生成、图片解码、数据库操作 |
| **屏幕显示** | 30% | 图片浏览、动画效果 |
| **网络通信** | 20% | 局域网连接、图片传输 |
| **存储 I/O** | 10% | 文件扫描、缓存读写 |
| **其他** | 5% | 后台任务、系统开销 |

### 6.2 核心优化策略

#### 6.2.1 CPU 功耗优化

| 策略 | 实现方式 | 预期效果 |
|-----|---------|---------|
| **智能并发控制** | 根据 CPU 核心数动态调整线程池大小 | 降低 20-30% CPU 功耗 |
| **任务优先级队列** | 前台任务优先，后台任务延后 | 保证前台流畅，减少后台功耗 |
| **批量处理优化** | 合并小任务，减少 CPU 唤醒次数 | 降低 10-15% 唤醒功耗 |
| **计算结果缓存** | 缓存缩略图、颜色数据，避免重复计算 | 减少 30-50% 重复计算 |

```rust
// 示例：智能并发控制
pub fn get_optimal_thread_count() -> usize {
    let cpu_count = num_cpus::get();
    let battery_level = get_battery_level(); // 获取电量
    
    match battery_level {
        level if level > 50 => (cpu_count / 2).max(2),  // 电量充足
        level if level > 20 => (cpu_count / 4).max(1),  // 电量中等
        _ => 1,  // 低电量模式，单线程
    }
}
```

#### 6.2.2 屏幕功耗优化

| 策略 | 实现方式 | 预期效果 |
|-----|---------|---------|
| **暗色主题** | 默认使用深色主题，OLED 屏幕省电 | 降低 20-40% 屏幕功耗 |
| **动画优化** | 减少不必要的动画，使用硬件加速 | 降低 10-15% GPU 功耗 |
| **自动亮度** | 跟随系统亮度设置 | 用户可控 |
| **息屏暂停** | 屏幕关闭时暂停所有任务 | 避免无效功耗 |

#### 6.2.3 网络功耗优化

| 策略 | 实现方式 | 预期效果 |
|-----|---------|---------|
| **连接复用** | 保持长连接，避免频繁建立连接 | 降低 30-50% 连接开销 |
| **数据压缩** | 传输前压缩图片数据 | 减少 40-60% 传输量 |
| **增量同步** | 只传输变化的数据 | 减少不必要传输 |
| **智能预加载** | 预测用户行为，按需加载 | 减少无效加载 |

```rust
// 示例：智能预加载策略
pub struct PreloadStrategy {
    battery_level: u8,
    network_type: NetworkType,
    user_behavior: BehaviorPattern,
}

impl PreloadStrategy {
    pub fn should_preload(&self) -> bool {
        // 低电量时不预加载
        if self.battery_level < 20 {
            return false;
        }
        // 移动网络时限制预加载
        if self.network_type == NetworkType::Mobile {
            return self.user_behavior.is_likely_to_view();
        }
        // WiFi 下正常预加载
        true
    }
}
```

#### 6.2.4 存储功耗优化

| 策略 | 实现方式 | 预期效果 |
|-----|---------|---------|
| **批量写入** | 合并多次小写入为一次大写入 | 减少 50-70% I/O 次数 |
| **缓存策略** | 内存缓存优先，减少磁盘读取 | 降低 30-50% 磁盘访问 |
| **延迟写入** | 非关键数据延迟写入磁盘 | 减少 CPU 唤醒 |
| **索引优化** | 优化数据库索引，减少查询时间 | 降低查询功耗 |

### 6.3 省电模式设计

#### 6.3.1 三级省电模式

| 模式 | 触发条件 | 行为变化 |
|-----|---------|---------|
| **正常模式** | 电量 > 50% | 全功能运行 |
| **省电模式** | 电量 20-50% | 减少并发数、暂停后台任务、降低缩略图质量 |
| **超省电模式** | 电量 < 20% | 单线程、仅本地浏览、禁用预加载、最低画质 |

#### 6.3.2 省电模式配置

```typescript
interface PowerSavingConfig {
  mode: 'normal' | 'power_saving' | 'ultra_power_saving';
  
  // 并发控制
  maxConcurrentTasks: number;
  
  // 缩略图设置
  thumbnailQuality: 'high' | 'medium' | 'low';
  thumbnailSize: number;
  
  // 预加载设置
  enablePreload: boolean;
  preloadCount: number;
  
  // 后台任务
  enableBackgroundTasks: boolean;
  
  // 动画效果
  enableAnimations: boolean;
  
  // 网络设置
  enableAutoSync: boolean;
}

const POWER_SAVING_CONFIGS: Record<string, PowerSavingConfig> = {
  normal: {
    mode: 'normal',
    maxConcurrentTasks: 4,
    thumbnailQuality: 'high',
    thumbnailSize: 256,
    enablePreload: true,
    preloadCount: 20,
    enableBackgroundTasks: true,
    enableAnimations: true,
    enableAutoSync: true,
  },
  power_saving: {
    mode: 'power_saving',
    maxConcurrentTasks: 2,
    thumbnailQuality: 'medium',
    thumbnailSize: 128,
    enablePreload: true,
    preloadCount: 10,
    enableBackgroundTasks: false,
    enableAnimations: true,
    enableAutoSync: false,
  },
  ultra_power_saving: {
    mode: 'ultra_power_saving',
    maxConcurrentTasks: 1,
    thumbnailQuality: 'low',
    thumbnailSize: 64,
    enablePreload: false,
    preloadCount: 0,
    enableBackgroundTasks: false,
    enableAnimations: false,
    enableAutoSync: false,
  },
};
```

### 6.4 任务调度优化

#### 6.4.1 任务优先级

```rust
pub enum TaskPriority {
    Critical = 0,   // 用户正在查看的图片
    High = 1,       // 可见区域的缩略图
    Normal = 2,     // 预加载的缩略图
    Low = 3,        // 后台索引、颜色提取
    Background = 4, // 可暂停的后台任务
}

pub struct TaskScheduler {
    priority_queues: Vec<VecDeque<Task>>,
    battery_level: u8,
    is_charging: bool,
}

impl TaskScheduler {
    pub fn schedule(&mut self, task: Task) {
        let priority = self.adjust_priority(task.base_priority);
        self.priority_queues[priority as usize].push_back(task);
    }
    
    fn adjust_priority(&self, base: TaskPriority) -> TaskPriority {
        // 低电量时降低后台任务优先级
        if self.battery_level < 20 && base == TaskPriority::Low {
            return TaskPriority::Background;
        }
        base
    }
}
```

#### 6.4.2 任务暂停与恢复

```rust
pub struct PausableTask {
    id: String,
    state: TaskState,
    checkpoint: Option<TaskCheckpoint>,
}

pub enum TaskState {
    Running,
    Paused,
    Completed,
}

impl PausableTask {
    // 屏幕关闭时暂停
    pub fn on_screen_off(&mut self) {
        if self.state == TaskState::Running {
            self.checkpoint = self.save_checkpoint();
            self.state = TaskState::Paused;
        }
    }
    
    // 屏幕打开时恢复
    pub fn on_screen_on(&mut self) {
        if self.state == TaskState::Paused {
            self.restore_from_checkpoint(&self.checkpoint);
            self.state = TaskState::Running;
        }
    }
}
```

### 6.5 监控与统计

#### 6.5.1 功耗监控 API

```typescript
interface PowerMonitor {
  // 获取当前电量
  getBatteryLevel(): Promise<number>;
  
  // 是否正在充电
  isCharging(): Promise<boolean>;
  
  // 获取功耗统计
  getPowerStats(): Promise<PowerStats>;
  
  // 监听电量变化
  onBatteryLevelChange(callback: (level: number) => void): () => void;
  
  // 监听充电状态变化
  onChargingStateChange(callback: (isCharging: boolean) => void): () => void;
}

interface PowerStats {
  cpuUsage: number;        // CPU 使用率
  memoryUsage: number;     // 内存使用量
  networkBytesSent: number;    // 发送字节数
  networkBytesReceived: number; // 接收字节数
  diskReadBytes: number;   // 磁盘读取字节数
  diskWriteBytes: number;  // 磁盘写入字节数
  screenOnTime: number;    // 屏幕开启时间（秒）
  estimatedDrain: number;  // 预估电量消耗（mAh）
}
```

#### 6.5.2 用户可见的功耗信息

```tsx
// 设置面板中的功耗信息展示
function PowerSavingPanel() {
  const [batteryLevel, setBatteryLevel] = useState(0);
  const [isCharging, setIsCharging] = useState(false);
  const [powerMode, setPowerMode] = useState('normal');
  
  return (
    <div className="power-saving-panel">
      <div className="battery-status">
        <BatteryIcon level={batteryLevel} charging={isCharging} />
        <span>{batteryLevel}%</span>
        {isCharging && <span>充电中</span>}
      </div>
      
      <div className="power-mode-selector">
        <label>
          <input type="radio" value="normal" checked={powerMode === 'normal'} />
          正常模式
        </label>
        <label>
          <input type="radio" value="power_saving" checked={powerMode === 'power_saving'} />
          省电模式
        </label>
        <label>
          <input type="radio" value="ultra_power_saving" checked={powerMode === 'ultra_power_saving'} />
          超省电模式
        </label>
      </div>
      
      <div className="auto-switch">
        <label>
          <input type="checkbox" />
          低电量时自动切换省电模式
        </label>
      </div>
    </div>
  );
}
```

### 6.6 开发任务清单

#### 第一阶段功耗优化
- [ ] 实现电量监控 API
- [ ] 实现充电状态监听
- [ ] 实现三级省电模式配置

#### 第二阶段功耗优化
- [ ] 智能并发控制
- [ ] 任务优先级队列
- [ ] 缩略图质量自适应

#### 第三阶段功耗优化
- [ ] 网络连接复用
- [ ] 数据压缩传输
- [ ] 智能预加载策略

#### 第四阶段功耗优化
- [ ] 屏幕关闭暂停任务
- [ ] 任务断点续传
- [ ] 功耗统计面板

---

## 七、开发时间线

```
Week 1-3:   第一阶段 - 基础架构
Week 4-5:   第二阶段 - 本地功能
Week 6-8:   第三阶段 - 局域网连接
Week 9-10:  第四阶段 - 上传下载
Week 11-13: 第五阶段 - 高级功能（平板完整版）
Week 14-15: 第六阶段 - 手机版适配
```

**预计总工期：3.5-4 个月**

### 里程碑

| 里程碑 | 时间点 | 交付物 |
|-------|-------|-------|
| M1 - 基础可用 | Week 5 | 本地图片浏览功能 |
| M2 - 局域网连接 | Week 8 | 远程图片浏览功能 |
| M3 - 传输功能 | Week 10 | 上传下载功能 |
| M4 - 平板完整版 | Week 13 | 平板版还原桌面端 UI |
| M5 - 手机适配版 | Week 15 | 手机版完整体验 |

---

## 八、风险与建议

### 风险点
1. **Tauri Android 成熟度**：Tauri 2.0 Android 支持仍在发展中
2. **性能优化**：移动端内存和 CPU 限制
3. **权限管理**：Android 存储权限政策变化

### 建议
1. **优先实现核心功能**：先保证本地浏览和局域网连接稳定
2. **渐进式开发**：每个阶段独立可测试
3. **性能优先**：移动端需要特别注意内存和电池消耗
4. **考虑 React Native 备选方案**：如果 Tauri Android 遇到阻碍

---

## 九、依赖关系图

```
┌─────────────────────────────────────────────────────────────┐
│                        开发依赖关系                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  第一阶段 ──────► 第二阶段 ──────► 第三阶段                  │
│  (基础架构)      (本地功能)      (局域网连接)                │
│                      │              │                       │
│                      │              ▼                       │
│                      │      第四阶段 (上传下载)              │
│                      │              │                       │
│                      ▼              ▼                       │
│               第五阶段 ◄────────────┘                       │
│               (平板完整版)                                  │
│           还原桌面端 UI + 所有功能                          │
│                      │                                      │
│                      ▼                                      │
│               第六阶段                                       │
│               (手机适配版)                                  │
│           UI 简化 + 交互调整                                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 平板 vs 手机 UI 对比

| 组件 | 平板版（还原桌面端） | 手机版（简化适配） |
|-----|-------------------|------------------|
| 侧边栏 | 左侧固定显示 | 抽屉式（滑动打开） |
| 元数据面板 | 右侧固定显示 | 底部抽屉（滑动打开） |
| 标签页 | 顶部标签栏 | 底部导航栏 |
| 文件网格 | 网格/瀑布流/列表 | 网格（简化） |
| 人物/专题 | 网格视图 | 列表视图 |
| 搜索界面 | 侧边面板 | 全屏页面 |
| 右键菜单 | 长按触发 | 长按触发 |
| 拖拽操作 | 长按拖拽 | 长按拖拽 |

### 功能共享说明

| 功能 | 平板实现 | 手机实现 | 共享代码 |
|-----|---------|---------|---------|
| 搜索 | 网格+侧边面板 | 网格+全屏页面 | API 调用、结果渲染 |
| 颜色搜索 | 完整选择器 | 预设+简化选择器 | 颜色逻辑、结果渲染 |
| 人物 | 网格视图 | 列表视图 | API 调用、详情页 |
| 专题 | 网格视图 | 列表视图 | API 调用、详情页 |
| 对比 | 分屏对比 | 不支持 | - |

---

## 十、手机版 UI 适配方案

### 10.1 搜索功能适配
```
┌─────────────────────────┐
│  🔍 搜索...             │  ← 顶部搜索栏
├─────────────────────────┤
│  [文本] [颜色] [AI]     │  ← Tab 切换
├─────────────────────────┤
│  ┌───┐ ┌───┐ ┌───┐    │
│  │   │ │   │ │   │    │  ← 搜索结果网格
│  └───┘ └───┘ └───┘    │
│  ┌───┐ ┌───┐ ┌───┐    │
│  │   │ │   │ │   │    │
│  └───┘ └───┘ └───┘    │
└─────────────────────────┘
```

### 10.2 颜色搜索适配
```
┌─────────────────────────┐
│  选择颜色               │
├─────────────────────────┤
│  ┌──┐ ┌──┐ ┌──┐ ┌──┐   │  ← 预设颜色
│  │🔴│ │🟢│ │🔵│ │🟡│   │
│  └──┘ └──┘ └──┘ └──┘   │
│                         │
│  [自定义颜色选择器]      │  ← 颜色选择器
│                         │
├─────────────────────────┤
│  搜索结果...            │
└─────────────────────────┘
```

### 10.3 人物/专题适配
```
┌─────────────────────────┐
│  人物 (12)              │  ← 标题和数量
├─────────────────────────┤
│  ┌────┐                 │
│  │头像│ 张三 (24张)  >  │  ← 列表项
│  └────┘                 │
│  ┌────┐                 │
│  │头像│ 李四 (18张)  >  │
│  └────┘                 │
│  ┌────┐                 │
│  │头像│ 王五 (12张)  >  │
│  └────┘                 │
└─────────────────────────┘
```

### 10.4 详情面板（底部抽屉）
```
┌─────────────────────────┐
│                         │
│    [图片查看区域]        │
│                         │
├─────────────────────────┤
│  ──────  ↑ 滑动查看详情  │  ← 抽屉指示器
├─────────────────────────┤
│  文件名: photo.jpg      │
│  大小: 2.4 MB           │
│  标签: [风景] [旅行]    │
│  描述: 美丽的风景...    │
└─────────────────────────┘
```

---

## 十一、资源需求

### 开发环境
- Android Studio (最新版)
- Android SDK 34+
- Android NDK 25+
- JDK 17+

### 测试设备
- Android 平板 (推荐 10寸+)
- Android 手机 (推荐 6寸+)
- 多种 Android 版本测试机 (Android 10+)

### 第三方库
- `tauri` (Android 支持)
- `jni` (Rust JNI 绑定)
- `tokio` (异步运行时)
- `image` (图像处理)

---

**文档版本**: 1.4  
**创建日期**: 2026-03-15  
**更新日期**: 2026-04-16  
**维护者**: Aurora Gallery Team
