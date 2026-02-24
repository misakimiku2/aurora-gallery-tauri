# CLIP 模型集成实现记录

## 概述
本文档记录了 Aurora Gallery 中视觉模型集成的实现过程，包括：
- **CLIP** (Contrastive Language-Image Pre-training) - 支持文本搜索图片
- **WD14 Tagger** (EVA02-Large) - 支持自动标签识别和以图搜图

## 实现时间
2026-02-15 ~ 2026-02-24

## 更新记录
- **2026-02-25**: 重构AI视觉设置面板的模型展示样式
  - 新增模型系列分类标签页（CLIP系列、SigLIP系列、WD Tagger系列）
  - 新增模型功能特性标签（文本搜索、以图搜图、自动标签、多语言等）
  - 新增高精度模型标识（右下角黄色标签）
  - 当前使用模型所在系列标签页显示指示点
  - WD14 模型不支持文本搜索的 UI 限制处理

## 功能特性

### 1. AI视觉设置面板
- **位置**: 设置 → AI视觉
- **功能**:
  - CLIP 功能总开关（可卸载模型释放内存）
  - 下载和管理视觉语言模型 (ViT-B/32、ViT-L/14、SigLIP 2 So400M、WD14 Tagger)
  - **模型系列分类**: 按系列标签页展示（CLIP系列、SigLIP系列、WD Tagger系列）
  - **模型功能特性**: 显示每个模型支持的功能（文本搜索、以图搜图、自动标签、多语言等）
  - **高精度标识**: ViT-L/14 模型右下角显示高精度标签
  - **当前模型指示**: 标签页显示彩色圆点指示当前使用的模型所在系列
  - 显示模型下载状态、速度、进度
  - 打开模型存放目录
  - 批量生成图片嵌入向量
  - GPU 加速选项（DirectML）

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
- **SigLIP 2 So400M** (多语言支持):
  - 模型文件: `https://hf-mirror.com/onnx-community/siglip2-so400m-patch14-384-ONNX/resolve/main/onnx/model.onnx`
  - 模型权重: `https://hf-mirror.com/onnx-community/siglip2-so400m-patch14-384-ONNX/resolve/main/onnx/model.onnx_data`
  - Tokenizer: `https://hf-mirror.com/google/siglip2-so400m-patch14-384/resolve/main/tokenizer.json`
  - Tokenizer 配置: `https://hf-mirror.com/google/siglip2-so400m-patch14-384/resolve/main/tokenizer_config.json`
  - 特殊 Token: `https://hf-mirror.com/google/siglip2-so400m-patch14-384/resolve/main/special_tokens_map.json`
- **WD14 Tagger V3** (二次元标签识别):
  - 模型文件: `https://hf-mirror.com/deepghs/wd14_tagger_with_embeddings/resolve/main/SmilingWolf/wd-eva02-large-tagger-v3/model.onnx`
  - 标签文件: `https://hf-mirror.com/deepghs/wd14_tagger_with_embeddings/resolve/main/SmilingWolf/wd-eva02-large-tagger-v3/tags_info.csv`

### 3. 语义搜索功能
- **启用方式**: 点击搜索框右侧的 ✨ 图标
- **搜索模式**: 
  - CLIP/SigLIP: 自然语言描述搜索
  - WD14: 以图搜图（基于视觉相似度）
- **示例查询**: "夕阳下的海滩"、"戴眼镜的少女"
- **自动加载**: 搜索时自动加载模型（如果未加载）
- **多语言支持**: SigLIP 2 模型支持中文等非英语语言搜索
- **WD14 限制**: WD14 Tagger 模型不支持文本搜索，选择该模型时：
  - 语义搜索按钮显示为灰色禁用状态
  - 点击按钮会显示提示消息并跳转到设置面板
  - 若在开启语义搜索时切换到 WD14，语义搜索会自动关闭

### 4. 嵌入向量生成
- **批量生成**: 为所有图片生成嵌入向量
- **分批处理**: 
  - GPU 模式: batch_size=16-64（根据模型调整）
  - CPU 模式: batch_size=16-32（已优化）
- **增量更新**: 跳过已生成嵌入的图片
- **进度显示**: 显示生成进度百分比、预估剩余时间
- **暂停/继续/取消**: 支持任务控制

### 5. WD14 标签识别
- **自动标签**: 为动漫/二次元图像自动生成标签
- **标签数量**: 支持超过 1 万个标签
- **阈值过滤**: 默认置信度阈值 0.35
- **标签存储**: 自动保存到图片元数据

## 文件结构

### 后端 (Rust)
```
src-tauri/src/
├── clip/
│   ├── mod.rs              # CLIP 管理器
│   ├── model.rs            # 模型加载和推理
│   ├── preprocessor.rs     # 图像和文本预处理
│   ├── embedding.rs        # 嵌入向量存储
│   ├── search.rs           # 向量搜索
│   └── models/             # 模型定义目录
│       ├── mod.rs          # ModelSpec trait 和模型注册表
│       ├── clip_vit.rs     # CLIP ViT 系列模型
│       ├── siglip2.rs      # SigLIP 2 系列模型
│       └── wd14.rs         # WD14 Tagger 模型
└── main.rs                 # Tauri 命令注册
```

### 前端 (TypeScript/React)
```
src/
├── api/
│   └── tauri-bridge.ts     # CLIP API 桥接
├── components/
│   ├── SettingsModal.tsx   # AI视觉设置面板（含模型系列标签页、功能特性标签）
│   └── TopBar.tsx          # CLIP 搜索按钮
├── types.ts                # CLIP 类型定义（含 ModelSeries、ModelFeatures）
├── App.tsx                 # CLIP 搜索状态管理
└── utils/modelDownloadState.ts  # 全局模型下载状态管理
```

## 技术实现

### 1. 类型定义 (types.ts)
```typescript
export type ClipModelName = 'ViT-B-32' | 'ViT-L-14' | 'SigLIP2-So400M' | 'WD-EVA02-Large-Tagger-V3';
export type ClipDownloadStatus = 'not_started' | 'downloading' | 'completed' | 'error';

// 模型系列类型
export type ModelSeries = 'clip' | 'siglip' | 'wd-tagger';

// 模型功能特性
export interface ModelFeatures {
  textSearch: boolean;      // 文本搜索
  imageSearch: boolean;     // 以图搜图
  autoTagging: boolean;     // 自动标签
  multilingual: boolean;    // 多语言支持
  animeOptimized?: boolean; // 二次元优化（可选）
}

// 系列信息
export interface ModelSeriesInfo {
  id: ModelSeries;
  name: string;
  description: string;
  color: string; // 主题色
}

export interface ClipModelInfo {
  name: ClipModelName;
  displayName: string;
  description: string;
  size: number;
  sizeDisplay: string;
  embeddingDim: number;
  isRecommended: boolean;
  series: ModelSeries;       // 所属系列
  isHighPrecision?: boolean; // 是否为高精度模型
  features: ModelFeatures;   // 功能特性
}

export interface ClipSettings {
  enabled: boolean;           // CLIP 功能总开关
  modelName: ClipModelName;
  useGpu: boolean;
  downloadStatus: ClipDownloadStatus;
  downloadProgress: number;
  downloadError?: string;
  modelVersion: string;
  downloadedAt?: number;
}
```

### 2. Tauri 命令
- `clip_search_by_text` - 文本搜索图片
- `clip_search_by_image` - 以图搜图
- `clip_generate_embedding` - 单张图片生成嵌入
- `clip_generate_embeddings_batch` - 批量生成嵌入
- `clip_get_model_status` - 获取模型状态
- `clip_update_config` - 动态更新 GPU 配置
- `clip_cancel_embedding_generation` - 取消生成任务
- `clip_pause_embedding_generation` - 暂停生成任务
- `clip_resume_embedding_generation` - 继续生成任务
- `clip_get_embedding_count` - 获取嵌入总量
- `clip_load_model` / `clip_unload_model` - 手动模型管理

### 3. 事件
- `clip-embedding-progress` - 进度更新事件
- `clip-embedding-completed` - 生成完成事件
- `clip-embedding-cancelled` - 生成取消事件
- `clip-model-download-progress` - 模型下载进度事件

## 模型系列分类

### 系列定义

| 系列 | ID | 主题色 | 说明 | 包含模型 |
|------|-----|--------|------|---------|
| **CLIP 系列** | `clip` | 蓝色 #3B82F6 | OpenAI 开发的经典视觉-语言模型 | ViT-B/32, ViT-L/14 |
| **SigLIP 系列** | `siglip` | 橙色 #F97316 | Google 开发的多语言视觉模型 | SigLIP 2 So400M |
| **WD Tagger 系列** | `wd-tagger` | 紫色 #8B5CF6 | 专为动漫和插画优化的标签识别模型 | WD-EVA02-Large-Tagger-V3 |

### 模型功能特性

| 模型 | 文本搜索 | 以图搜图 | 自动标签 | 多语言 | 二次元优化 | 高精度 |
|------|---------|---------|---------|--------|-----------|--------|
| **ViT-B/32** | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| **ViT-L/14** | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ |
| **SigLIP 2 So400M** | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |
| **WD-EVA02-Large-Tagger-V3** | ❌ | ✅ | ✅ | ❌ | ✅ | ❌ |

### 高精度模型定义

**ViT-L/14** 被标记为高精度模型，原因：
- **更高的嵌入维度**：768维（vs ViT-B/32 的 512维）
- **更小的 Patch Size**：14（vs ViT-B/32 的 32），能捕捉更细粒度的特征
- **更大的模型容量**：1.6GB（vs ViT-B/32 的 580MB）

## 模型参数对比

| 特性 | CLIP ViT-B/32 | CLIP ViT-L/14 | SigLIP 2 So400M | WD14 Tagger V3 |
|------|---------------|---------------|-----------------|----------------|
| 图像尺寸 | 224x224 | 224x224 | 384x384 | 448x448 |
| Patch Size | 32 | 14 | 14 | 14 |
| 嵌入维度 | 512 | 768 | 1152 | 1024 |
| 多语言 | ❌ 仅英文 | ❌ 仅英文 | ✅ 多语言 | ❌ 仅视觉 |
| 模型大小 | ~580 MB | ~1.6 GB | ~1.2 GB | ~1.2 GB |
| 归一化均值 | [0.481, 0.458, 0.408] | [0.481, 0.458, 0.408] | [0.5, 0.5, 0.5] | [0, 0, 0] |
| 归一化标准差 | [0.269, 0.261, 0.276] | [0.269, 0.261, 0.276] | [0.5, 0.5, 0.5] | [1, 1, 1] |
| 最大文本长度 | 77 | 77 | 64 | 0 (不支持) |
| 张量格式 | NCHW | NCHW | NCHW | NHWC |
| 文本搜索 | ✅ | ✅ | ✅ | ❌ |
| 以图搜图 | ✅ | ✅ | ✅ | ✅ |
| 自动标签 | ❌ | ❌ | ❌ | ✅ |
| 适用场景 | 通用 | 高精度 | 多语言 | 二次元 |

### 模型选择建议

| 需求 | 推荐模型 | 原因 |
|------|----------|------|
| 通用文本搜索 | ViT-B/32 | 速度快、体积小 |
| 高精度搜索 | ViT-L/14 | 嵌入维度更高 |
| 中文搜索 | SigLIP 2 So400M | 原生多语言支持 |
| 动漫/二次元 | WD14 Tagger V3 | 专为二次元优化，支持标签识别 |

## 数据存储架构

### 嵌入向量数据隔离
```
{root_path}/
└── .aurora/
    ├── metadata.db          # 文件元数据
    ├── colors.db            # 颜色数据
    └── embeddings/          # 嵌入向量目录
        ├── ViT-B-32/        # ViT-B/32 模型
        │   └── embeddings.db
        ├── ViT-L-14/        # ViT-L/14 模型
        │   └── embeddings.db
        ├── SigLIP2-So400M/  # SigLIP 2 模型
        │   └── embeddings.db
        └── WD-EVA02-Large-Tagger-V3/  # WD14 Tagger 模型
            └── embeddings.db
```

| 维度 | 隔离方式 | 优势 |
|------|----------|------|
| **根目录** | 每个根目录有独立的 `.aurora` 文件夹 | 不同图片库完全隔离 |
| **模型** | 每个模型有独立的 `embeddings.db` 文件 | 容错性强，可单独备份/删除 |

## 系统要求

### GPU 加速要求

#### Windows（DirectML）
- **DirectML**: Windows 10 1903+ 或 Windows 11（默认启用）
- **GPU**: 支持 DirectX 12 的 GPU（NVIDIA、AMD、Intel 均可）
- **驱动**: 最新显卡驱动
- **优势**: 不依赖 CUDA 版本，兼容性最佳

#### 非 Windows 平台
- 仅支持 CPU 推理

## 使用流程

### 首次使用 CLIP 搜索
1. 打开 **设置** → **AI视觉**
2. 开启"启用 AI 视觉功能"开关
3. 下载模型（推荐 ViT-B/32 或 SigLIP 2 So400M）
4. 点击 **"开始生成"** 按钮生成嵌入向量
5. 等待处理完成
6. 返回主界面，点击搜索框右侧的 **✨ 图标**
7. 输入自然语言描述进行搜索

### 使用中文搜索
1. 在设置中选择 **SigLIP 2 So400M** 模型
2. 下载模型并生成嵌入向量
3. 使用中文描述进行搜索（如"夕阳下的海滩"）

## 关键技术实现

### 1. 模块化模型架构
- 定义 `ModelSpec` trait，所有模型实现此 trait
- 添加新模型只需创建新模块并实现 trait
- 模型参数集中管理，便于维护

### 2. GPU 加速（DirectML）
- 使用 ONNX Runtime 的 DirectML Execution Provider
- 批量推理：GPU 模式 32 张/批，CPU 模式 8 张/批
- 自动回退：DirectML 不可用时自动降级到 CPU

### 3. 图像预处理优化
- 使用 `fast_image_resize` 库实现高速图像缩放
- 使用 `rayon` 多线程并行预处理
- 预处理速度：5-33ms/张

### 4. 并发稳定性
- 使用 `IS_GENERATING` 原子锁防止任务冲突
- RAII 资源管理确保状态正确重置
- 支持暂停/继续/取消操作

### 5. 模型文件完整性校验
- 支持文件大小和 SHA256 哈希值校验
- 检测到损坏文件时自动提示修复
- 修复按钮一键重新下载

## 关键经验总结

1. **模型版本一致性**：生成嵌入和搜索必须使用相同的模型，否则维度不匹配会导致搜索失败
2. **前后端状态同步**：前端持久化的设置需要传递给后端，不能依赖后端的默认值
3. **Debug vs Release 性能**：Rust debug 模式性能极差，性能测试必须使用 release 模式
4. **DirectML 优势**：Windows 上 DirectML 兼容所有支持 DirectX 12 的 GPU，不依赖特定 CUDA 版本
5. **分离模型优先**：在 Windows 上应优先使用分离的 ONNX 模型，避开控制流节点，确保 100% GPU 推理
6. **数据隔离重要性**：不同模型、不同根目录的数据必须隔离，避免相互干扰
7. **内存管理**：提供用户可控的内存释放机制（CLIP 功能总开关），提升用户体验
8. **tokenizer 版本兼容性**：新模型可能需要更新的 tokenizers 版本（当前使用 0.21）
