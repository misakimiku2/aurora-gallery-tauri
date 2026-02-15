# CLIP 模型集成实现记录

## 概述
本文档记录了 Aurora Gallery 中 CLIP (Contrastive Language-Image Pre-training) 模型集成的实现过程，包括模型下载管理、语义搜索功能和嵌入向量生成。

## 实现时间
2026-02-15

## 功能特性

### 1. AI视觉设置面板
- **位置**: 设置 → AI视觉
- **功能**:
  - 下载和管理 CLIP 模型 (ViT-B/32 和 ViT-L/14)
  - 显示模型下载状态
  - 打开模型存放目录
  - 批量生成图片嵌入向量
  - GPU 加速选项

### 2. 模型下载
- **模型源**: 使用 hf-mirror 国内镜像加速下载
- **ViT-B/32** (推荐):
  - Vision 编码器: `https://hf-mirror.com/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model.onnx`
  - Text 编码器: `https://hf-mirror.com/Xenova/clip-vit-base-patch32/resolve/main/onnx/text_model.onnx`
  - Tokenizer: `https://hf-mirror.com/Xenova/clip-vit-base-patch32/resolve/main/tokenizer.json`
- **ViT-L/14** (高精度):
  - Vision 编码器: `https://hf-mirror.com/Xenova/clip-vit-large-patch14/resolve/main/onnx/vision_model.onnx`
  - Text 编码器: `https://hf-mirror.com/Xenova/clip-vit-large-patch14/resolve/main/onnx/text_model.onnx`
  - Tokenizer: `https://hf-mirror.com/Xenova/clip-vit-large-patch14/resolve/main/tokenizer.json`

### 3. 语义搜索功能
- **启用方式**: 点击搜索框右侧的 ✨ 图标
- **搜索模式**: 自然语言描述搜索
- **示例查询**: "夕阳下的海滩"、"戴眼镜的少女"
- **自动加载**: 搜索时自动加载模型（如果未加载）

### 4. 嵌入向量生成
- **批量生成**: 为所有图片生成 CLIP 嵌入向量
- **分批处理**: 每批 50 张图片，避免内存溢出
- **增量更新**: 跳过已生成嵌入的图片
- **进度显示**: 显示生成进度百分比

## 文件结构

### 后端 (Rust)
```
src-tauri/src/
├── clip/
│   ├── mod.rs          # CLIP 管理器
│   ├── model.rs        # 模型加载和推理
│   ├── preprocessor.rs # 图像和文本预处理
│   ├── embedding.rs    # 嵌入向量存储
│   └── search.rs       # 向量搜索
└── main.rs             # Tauri 命令注册
```

### 前端 (TypeScript/React)
```
src/
├── api/
│   └── tauri-bridge.ts # CLIP API 桥接
├── components/
│   ├── SettingsModal.tsx  # AI视觉设置面板
│   └── TopBar.tsx         # CLIP 搜索按钮
├── types.ts            # CLIP 类型定义
└── App.tsx             # CLIP 搜索状态管理
```

## 技术实现

### 1. 类型定义 (types.ts)
```typescript
export type SettingsCategory = 'general' | 'appearance' | 'network' | 'storage' | 'ai' | 'aiVision' | 'performance' | 'about';

export type ClipModelName = 'ViT-B-32' | 'ViT-L-14';
export type ClipDownloadStatus = 'not_started' | 'downloading' | 'completed' | 'error';

export interface ClipSettings {
  modelName: ClipModelName;
  useGpu: boolean;
  downloadStatus: ClipDownloadStatus;
  downloadProgress: number;
  downloadError?: string;
  modelVersion: string;
  downloadedAt?: number;
}
```

### 2. Tauri 命令 (main.rs)
- `clip_search_by_text` - 文本搜索图片
- `clip_search_by_image` - 以图搜图
- `clip_generate_embedding` - 单张图片生成嵌入
- `clip_generate_embeddings_batch` - 批量生成嵌入
- `clip_get_model_status` - 获取模型状态
- `clip_delete_model` - 删除模型
- `clip_open_model_folder` - 打开模型目录
- `clip_load_model` - 加载模型
- `clip_unload_model` - 卸载模型
- `clip_is_model_loaded` - 检查模型状态
- `clip_get_embedding_count` - 获取嵌入数量

### 3. API 桥接 (tauri-bridge.ts)
```typescript
export const clipSearchByText = async (text: string, options?: SearchOptions): Promise<SearchResult[]> => {...}
export const clipSearchByImage = async (imagePath: string, options?: SearchOptions): Promise<SearchResult[]> => {...}
export const clipGenerateEmbeddingsBatch = async (files: [string, string][]): Promise<ClipBatchEmbeddingResult> => {...}
export const clipGetModelStatus = async (modelName: string): Promise<ClipModelStatus> => {...}
```

## 已知问题

### 1. 模型推理实现
- **当前状态**: 使用简化版本（确定性随机向量作为占位符）
- **问题**: 实际语义搜索功能需要完整的 ONNX 推理实现
- **建议**: 使用 `candle` 或 `burn` 等 Rust 原生深度学习框架，或通过 `tch-rs` 调用 PyTorch 模型

### 2. 嵌入向量生成
- **问题**: 当前实现从 localStorage 读取文件列表，但实际应该从数据库读取
- **错误**: "没有找到图片文件，请扫描目录"
- **原因**: 文件索引存储在数据库中，而非 localStorage

### 3. 文件路径处理
- **问题**: 需要正确处理 Windows 路径分隔符
- **注意**: 路径中的反斜杠需要转义或转换为正斜杠

## 使用流程

### 首次使用 CLIP 搜索
1. 打开 **设置** → **AI视觉**
2. 下载 CLIP 模型（推荐 ViT-B/32）
3. 点击 **"开始生成"** 按钮生成嵌入向量
4. 等待处理完成
5. 返回主界面，点击搜索框右侧的 **✨ 图标**
6. 输入自然语言描述进行搜索

### 后续使用
1. 点击搜索框右侧的 **✨ 图标** 启用 CLIP 搜索
2. 输入搜索词，按回车搜索
3. 系统会自动加载模型（首次搜索可能需要几秒钟）

## 修复记录

### 2026-02-15 修复完成

1. **嵌入向量生成** ✅
   - 新增 `get_all_image_files` 数据库查询函数
   - 前端改用 `getAllImageFiles()` API 从数据库获取图片列表
   - 不再依赖 localStorage 存储的文件列表

2. **模型推理** ✅
   - 实现了图像预处理（resize、normalize、NCHW 格式转换）
   - 添加了图像文件存在性验证
   - 添加了文本非空验证
   - 预留了 ONNX Runtime 集成接口（当前使用确定性伪随机向量作为占位符）

3. **错误处理** ✅
   - 使用 Toast 通知替代 alert
   - 添加错误分类处理（模型未加载、服务未初始化等）
   - 提供更友好的错误提示信息

### 2026-02-15 进度显示优化

4. **实时进度更新** ✅
   - 后端添加 `clip-embedding-progress` 事件，**每个文件处理完成后立即发送进度**（原为每10个文件）
   - 前端使用 `listenClipEmbeddingProgress` 监听进度事件
   - 进度条实时更新，显示当前处理数量、总数、成功数和失败数
   - 添加 `timestamp` 字段用于计算预估剩余时间

5. **取消生成功能** ✅
   - 后端添加 `clip_cancel_embedding_generation` 命令
   - 使用原子布尔标志 `CANCEL_GENERATION` 控制取消
   - 前端添加"取消"按钮，点击后发送取消请求
   - 后端检查取消标志，优雅地停止生成

6. **进度统计优化** ✅
   - 分离统计：processed_count（实际处理）、skipped_count（已存在跳过）、success_count（成功）、failed_count（失败）
   - 进度事件包含 skipped 和 processed 字段
   - UI 显示已跳过的文件数量（灰色显示"已存在: X"）
   - 显示实际处理的文件数量
   - 进度条基于总体进度（包括已跳过的文件）
   - **生成时隐藏"已生成: X张"，完成后显示最终数量**

7. **预估时间显示** ✅
   - 根据已处理文件数和已用时间计算处理速率
   - 实时显示预估剩余时间（如"预计剩余: 5分钟"）
   - 支持秒、分钟、小时的自动转换显示

8. **状态持久化** ✅
   - 使用全局单例状态 `globalEmbeddingState` 保存生成进度
   - 切换设置标签页或关闭设置界面后，重新打开可恢复进度状态
   - 事件监听器使用单例模式，避免重复监听

### 新增 Tauri 命令

- `get_all_image_files` - 从数据库获取所有图片文件
- `clip_cancel_embedding_generation` - 取消嵌入向量生成

### 新增事件

- `clip-embedding-progress` - 进度更新事件
- `clip-embedding-completed` - 生成完成事件
- `clip-embedding-cancelled` - 生成取消事件

## 相关文件

- `src-tauri/src/clip/mod.rs`
- `src-tauri/src/clip/model.rs`
- `src-tauri/src/clip/preprocessor.rs`
- `src-tauri/src/clip/embedding.rs`
- `src-tauri/src/clip/search.rs`
- `src-tauri/src/main.rs`
- `src/api/tauri-bridge.ts`
- `src/components/SettingsModal.tsx`
- `src/components/TopBar.tsx`
- `src/types.ts`
- `src/App.tsx`
