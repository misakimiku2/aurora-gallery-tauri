# WD14 Tagger (EVA02-Large) 模型集成与优化记录

## 1. 背景与目标
在 Aurora Gallery 中集成 `WD-EVA02-Large-Tagger-V3` 模型，旨在为动漫/二次元图像提供更精准的标签识别（Auto-tagging）及 10861 维的特征向量（Embedding）搜索。

## 2. 核心修复点回顾

### 2.1 基础设施兼容性
- **无 Tokenizer 支持**: 修正了 `ClipModel` 强制加载 `tokenizer.json` 的逻辑。对于 WD14 这类纯视觉标注模型，系统现已支持跳过 Tokenizer 加载。
- **UI 动态反馈**: 修正了前端 `SettingsModal.tsx` 中硬编码的下载文件数量，自动适配 WD14 的 2 文件结构（Model + CSV）。

### 2.2 张量布局 (Critical)
- **NHWC 格式支持**: 
  - 标准 CLIP 模型使用 NCHW（Channels First）。
  - WD14 (TensorFlow 系) 要求 **NHWC**（Channels Last）。
  - **实现**: 在 `ImagePreprocessor` 中增加了物理数据序的重排，并将发送给 ONNX Runtime 的形状（Shape）从 `[B, 3, H, W]` 动态切换为 `[B, H, W, 3]`。

### 2.3 节点映射与安全性
- **物理节点对齐**: 识别并校准了 WD14 的 Embedding 输出节点名称为 `/core_model/fc_norm/LayerNormalization_output_0`。
- **防御性提取**: 重写了 `model.rs` 中的输出提取逻辑。使用 `.get()` 代替 `[]` 索引，并增加了完整性校验，彻底解决了因节点不匹配引发 Panic 导致的 **Mutex Poisoning (锁毒化)** 问题。

## 3. 批量推理与性能表现

### 3.1 调度配置
- **批次大小**: GPU 环境下默认开启 batch=32 推理压力。
- **高分辨率开销**: 模型输入尺寸为 448x448，相比标准 CLIP (224/336px) 显存占用翻倍。

### 3.2 稳健回退机制
- 针对 DirectML 在高批次下可能触发的 `LayerNormalization` 算子错误或显存溢出，系统实现了**自动隔离与串行回退**。
- 若批量推理失败，系统会逐一尝试处理该批次图像，确保任务不会中断，并维持约 4-6 files/sec 的处理速度。

## 4. UI 限制处理
由于 WD14 Tagger 是纯视觉模型，不支持文本编码，因此在前端 UI 中做了以下限制：

### 功能限制
- **不支持文本搜索**: WD14 模型无法将文本转换为嵌入向量，因此不支持"语义搜索"功能
- **仅支持以图搜图**: 用户可以通过图片的视觉特征进行相似图片搜索

### UI 行为
- **语义搜索按钮禁用**: 当选择 WD14 模型时，搜索框右侧的 ✨ 按钮显示为灰色禁用状态
- **提示消息**: 点击禁用的按钮会显示 "WD-EVA02-Large-Tagger-V3模型不支持语义搜索" 的提示，并自动跳转到 AI 视觉设置面板
- **自动关闭语义搜索**: 如果用户在开启语义搜索的状态下切换到 WD14 模型，语义搜索会自动关闭

### 相关文件
- `src/components/TopBar.tsx` - 语义搜索按钮的样式和点击逻辑
- `src/components/SettingsModal.tsx` - 模型切换时的回调处理
- `src/components/AppModals.tsx` - 回调函数传递
- `src/App.tsx` - 语义搜索状态管理

## 5. DirectML LayerNormalization 错误修复

### 5.1 问题现象
- GPU 使用率波动 (100% ↔ 40%)，低利用率时间占比高
- 批量推理时出现 `LayerNormalization` 节点错误

### 5.2 根因分析
1. **DirectML 限制**: DirectML 执行提供程序对 WD14 模型的 LayerNormalization 节点支持极差，即使 batch=4 也会失败
2. **WD14 模型特殊性**: 448×448 大尺寸输入，模型结构复杂
3. **CPU-GPU 流水线断裂**: 预处理和推理串行执行，GPU 空闲等待
4. **多次失败开销**: 自动降级机制 (16→8→4→串行) 每次尝试都有预处理开销

### 5.3 修复措施
1. **WD14 直接使用串行处理**: 检测到 Tagger 模型时，跳过批量推理尝试，直接使用串行处理 (`model.rs`)
2. **避免无效预处理开销**: 不再尝试 16→8→4 的降级，直接进入串行模式

### 5.4 修改文件
- `src-tauri/src/clip_commands.rs` - 批次大小配置
- `src-tauri/src/clip/model.rs` - Tagger 模型直接串行处理逻辑

### 5.5 性能影响
- **消除错误日志**: 不再出现 LayerNormalization 错误
- **GPU 利用率**: 串行处理时 GPU 持续工作，利用率更稳定
- **处理速度**: 约 4-6 files/sec，与之前串行回退后相同

## 6. 流水线预处理优化

### 6.1 问题分析
串行处理时，GPU 在等待 CPU 预处理时是空闲的：
```
原流程: [CPU预处理] → [GPU推理] → [CPU预处理] → [GPU推理] → ...
GPU状态:   空闲        工作        空闲        工作
```

### 6.2 优化方案
实现流水线预处理：在 GPU 推理当前图像时，CPU 同时预处理下一张图像：
```
优化后: [CPU预处理1] → [CPU预处理2] → [CPU预处理3] → ...
                      [GPU推理1]   → [GPU推理2]   → ...
GPU状态:                工作          工作          工作
```

### 6.3 实现细节
- 使用 `std::sync::mpsc` 通道连接预处理线程和主推理线程
- 预处理线程独立运行，不受 GPU 推理阻塞
- 主线程只负责 GPU 推理，最大化 GPU 利用率

### 6.4 预期效果
| 指标 | 优化前 | 优化后 |
|------|--------|--------|
| GPU 利用率 | 5-60% 波动 | 70-90% 稳定 |
| 处理速度 | 12 files/sec | 18-25 files/sec |
| CPU-GPU 重叠 | 无 | 完全重叠 |

### 6.5 Mutex Poisoning 修复
流水线处理函数存在 panic 风险，导致 Mutex 被毒化：

**问题原因**：
1. 预处理失败时只是 `break`，没有通知主线程
2. 推理失败时使用 `?` 会 panic
3. 最后 `results.into_iter().map(|r| r.unwrap())` 如果有 `None` 会 panic

**修复措施**：
1. 使用 `Result` 类型作为通道消息，区分正常数据和错误信号
2. 预处理失败时发送错误消息，而不是静默 break
3. 推理失败时使用 `continue`，而不是 `?` 导致 panic
4. 使用 `filter_map` 收集结果，避免 `unwrap()` panic
5. 检查结果数量，确保所有图像都被处理

## 7. CPU 模式性能优化

### 7.1 问题现象
- CPU 利用率仅 37% (Ryzen 9800X3D 8核16线程)
- 处理速度非常慢，每张图片约 850ms

### 7.2 根因分析
1. **批次大小过小**: CPU 模式下批次大小仅为 4，未充分利用多核能力
2. **ONNX Runtime 未配置线程数**: 可能只使用单线程推理
3. **Tagger 模型强制串行处理**: CPU 模式也走流水线路径，效率低
4. **预处理线程数不足**: 只使用一半 CPU 核心

### 7.3 优化措施

#### 7.3.1 提高批次大小
| 模型 | 优化前 | 优化后 |
|------|--------|--------|
| ViT-L-14 | 4 | 16 |
| ViT-B-32 | 8 | 32 |
| WD-EVA02-Large-Tagger-V3 | 4 | 16 |

#### 7.3.2 配置 ONNX Runtime CPU 线程数
```rust
let cpu_threads = num_cpus::get();
Session::builder()?
    .with_intra_threads(cpu_threads)?
```

#### 7.3.3 CPU 模式启用批量推理
修改条件判断，只有 GPU 模式 + Tagger 模型才使用流水线串行处理：
```rust
if self.model_spec.is_tagger() && self.is_gpu_active {
    return self.encode_images_pipelined(image_paths);
}
```

#### 7.3.4 优化预处理线程数
- CPU 模式：使用全部逻辑核心 (`num_cpus::get()`)
- GPU 模式：使用一半核心避免抢占资源

### 7.4 修改文件
- `src-tauri/src/clip_commands.rs` - 批次大小配置
- `src-tauri/src/clip/model.rs` - Session 线程配置、批量推理逻辑、预处理线程数

### 7.5 性能影响
| 指标 | 优化前 | 优化后 |
|------|--------|--------|
| CPU 利用率 | 37% | 70-90% |
| 批次大小 | 4-8 | 16-32 |
| 预处理线程 | 8 | 16 |

### 7.6 性能瓶颈说明
WD14 Tagger 在 CPU 上推理慢是模型特性决定的：
- 输入尺寸 448×448，像素量是标准 CLIP 的 4 倍
- 模型类型为 EVA02-Large，参数量大
- CPU 推理约 850ms/张属于正常水平

**建议**: 如需更快速度，建议开启 GPU 加速或使用更小的模型 (ViT-B-32 / SigLIP 2 So400M)

## 8. 以图搜图功能实现

### 8.1 功能入口
- **位置**: 图片右键菜单 → 「搜索相似图片」
- **支持模型**: 所有 CLIP 系列模型（包括 WD14 Tagger）

### 8.2 核心实现
- 新增 `handleSearchSimilarImages` 函数
- 调用 `clipSearchByImage` API 进行搜索
- 搜索结果通过 `aiFilter` 机制展示

### 8.3 排除自身
- 使用 `search_similar_exclude_self` 方法
- 如果查询图片在嵌入存储中，排除自身
- 如果查询图片不在存储中，使用普通搜索

### 8.4 相关文件
- `src/App.tsx` - 搜索逻辑实现
- `src/components/ContextMenu.tsx` - 右键菜单项
- `src-tauri/src/clip_commands.rs` - 后端搜索命令

## 9. WD14 预处理修复

### 9.1 问题现象
- 所有图片的嵌入向量几乎相同
- 余弦相似度接近 1.0，无法区分不同图片

### 9.2 根因分析
1. **颜色通道顺序错误**: WD14 需要 BGR 格式，代码使用 RGB
2. **归一化错误**: WD14 不需要归一化，直接使用 0-255 像素值
3. **输出节点选择**: `fc_norm` 输出区分度低，改用标签概率向量

### 9.3 修复措施

#### 9.3.1 预处理修复
```rust
// WD14 模式: BGR 格式，不归一化
if self.mean == [0.0, 0.0, 0.0] && self.std == [1.0, 1.0, 1.0] {
    for i in 0..pixel_count {
        let base_idx = i * 3;
        tensor[i * 3 + 0] = raw_pixels[base_idx + 2] as f32; // B
        tensor[i * 3 + 1] = raw_pixels[base_idx + 1] as f32; // G
        tensor[i * 3 + 2] = raw_pixels[base_idx] as f32;     // R
    }
}
```

#### 9.3.2 输出节点更改
- **原节点**: `/core_model/fc_norm/LayerNormalization_output_0` (1024维)
- **新节点**: `output` (10861维标签概率向量)
- **优势**: 标签概率向量有更好的区分度

### 9.4 修复效果
| 指标 | 修复前 | 修复后 |
|------|--------|--------|
| 最高分 | 0.9999 | 0.87 |
| 最低分 | 0.9999 | 0.36 |
| 分数差距 | 0.0000 | 0.51 |

### 9.5 修改文件
- `src-tauri/src/clip/preprocessor.rs` - BGR 转换和归一化修复
- `src-tauri/src/clip/models/wd14.rs` - 输出节点和嵌入维度更改

### 9.6 注意事项
- 嵌入维度从 1024 改为 10861
- **需要重新生成嵌入向量**

## 10. 搜索参数可配置化

### 10.1 新增配置项
| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `minScore` | number | 0.4 | 相似度阈值 (0.0 - 1.0) |
| `maxResults` | number | 200 | 最大返回结果数 |
| `unlimitedResults` | boolean | true | 是否无限制结果数 |

### 10.2 UI 实现
- **位置**: 设置 → AI视觉 → 高级选项
- **相似度阈值**: 滑块 (0.00 - 1.00)
- **最大结果数**: 滑块 (50 - 1000) + 无限制开关
- **无限制开关**: 开启时隐藏滑块，返回所有符合阈值的结果

### 10.3 适用范围
- **以图搜图**: 使用用户配置的参数
- **文本语义搜索**: 同样使用用户配置的参数
- **所有 CLIP 模型**: ViT-B/32、ViT-L/14、SigLIP 2、WD14 均生效

### 10.4 修改文件
- `src/types.ts` - ClipSettings 类型定义
- `src/App.tsx` - 默认值和搜索逻辑
- `src/components/SettingsModal.tsx` - 设置 UI
- `src/utils/translations.ts` - 翻译文本

## 11. 从嵌入向量生成标签功能

### 11.1 功能说明
当使用 WD14 模型生成嵌入向量时，如果当时没有开启"自动添加标签"选项，后续可以通过这个新功能快速生成标签，**无需重新推理**。

### 11.2 技术实现
- **后端命令**: `clip_generate_tags_from_embeddings`
- **原理**: WD14 的嵌入向量本身就是 10861 维的标签概率向量，直接从中提取标签即可
- **优势**: 
  - 快速：无需重新推理，直接从已有数据提取
  - 灵活：可以随时调整阈值重新生成
  - 独立：与嵌入向量生成解耦

### 11.3 相关文件
- `src-tauri/src/clip_commands.rs` - 后端命令实现
- `src/api/tauri-bridge.ts` - 前端 API
- `src/components/SettingsModal.tsx` - UI 按钮

## 12. 中文标签翻译功能

### 12.1 功能说明
当软件语言设置为中文时，自动将 WD14 生成的英文标签翻译成中文。

### 12.2 技术实现
- **翻译文件**: `Tags-cn_2024_ver-1.0.csv`（10861 条翻译）
- **嵌入方式**: 使用 `include_str!` 宏嵌入到二进制文件中
- **翻译器**: `TagTranslator` 结构体，启动时加载映射表

### 12.3 关键代码
```rust
// 嵌入翻译文件
const TAGS_CN_CSV: &str = include_str!("models/Tags-cn_2024_ver-1.0.csv");

// 翻译时将下划线替换为空格（与 LabelMapper 保持一致）
let en_tag = record[1].replace('_', " ").trim().to_string();
```

### 12.4 相关文件
- `src-tauri/src/clip/model.rs` - TagTranslator 实现
- `src-tauri/src/clip_commands.rs` - 翻译调用
- `src/components/SettingsModal.tsx` - 传递语言参数

## 13. 标签持久化与刷新修复

### 13.1 问题现象
1. 标签生成后前端界面不显示，重启后才出现
2. 标签删除后重启恢复

### 13.2 根因分析
1. **前端刷新问题**: `save_tags_to_metadata` 使用异步数据库操作，刷新时数据还没写入
2. **字段名不匹配**: 后端使用 camelCase (`fileId`)，前端期望 snake_case (`file_id`)
3. **删除未持久化**: `handleConfirmDeleteTags` 没有保存到数据库

### 13.3 修复措施
1. **同步数据库操作**: `save_tags_to_metadata` 改为同步执行
2. **修复字段映射**: 前端 API 使用 camelCase 匹配后端返回
3. **删除持久化**: `handleConfirmDeleteTags` 调用 `dbUpsertFileMetadata`
4. **新增刷新命令**: `db_get_all_file_metadata` 获取所有元数据

### 13.4 修改文件
- `src-tauri/src/clip_commands.rs` - 同步数据库操作
- `src-tauri/src/db_commands.rs` - 新增获取所有元数据命令
- `src/api/tauri-bridge.ts` - 修复字段映射
- `src/App.tsx` - 删除持久化、新增刷新函数

## 14. 智能创建人物功能

### 14.1 功能说明
利用 WD14 Tagger 模型的角色标签（category: 4）自动识别和创建人物，支持：
- 基于嵌入向量中的角色标签概率识别人物
- 角色名称自动补全和搜索
- 相似度阈值可调节
- 虚拟滚动展示匹配图片
- 头像裁剪功能
- 排除已创建角色

### 14.2 数据源
- **标签文件**: `tags_info.csv`（模型下载目录中）
- **角色标签**: category = 4 的标签（如 `hatsune miku`、`hakurei reimu`）
- **嵌入向量**: WD14 输出 10861 维标签概率向量

### 14.3 后端实现

#### 14.3.1 新增命令
| 命令 | 说明 |
|------|------|
| `clip_get_character_tags` | 获取所有角色标签（category=4） |
| `clip_search_by_character_tag` | 按角色标签搜索图片 |
| `clip_get_detected_characters` | 获取已识别的角色列表 |

#### 14.3.2 数据结构
```rust
pub struct CharacterTag {
    pub tag_id: String,
    pub name: String,
    pub name_cn: String,
    pub index: usize,
}

pub struct DetectedCharacter {
    pub tag_name: String,
    pub tag_name_cn: String,
    pub tag_index: usize,
    pub file_count: usize,
    pub max_score: f32,
    pub sample_file_id: String,
}
```

### 14.4 前端实现

#### 14.4.1 新增组件
- `SmartCreatePersonModal.tsx` - 智能创建人物模态框

#### 14.4.2 功能入口
- 人物概览界面右键菜单 → 「智能创建人物」

#### 14.4.3 UI 特性
- 圆形头像预览（可点击裁剪，支持缩放和拖拽）
- 角色名称输入（支持自动补全）
- 已识别角色列表（虚拟滚动，使用缩略图）
- 角色检测阈值滑块（0.01 - 0.5）
- 相似度阈值滑块（0.01 - 0.5）
- 匹配图片网格（虚拟滚动）
- 自动排除已创建的角色

### 14.5 阈值优化
角色标签的嵌入向量值通常很小（如 0.000007），远低于默认阈值 0.4。
- 默认阈值从 0.4 降低到 0.1
- 滑块范围调整为 0.01 - 0.5
- 两个独立滑块：角色检测阈值和相似度阈值

### 14.6 数据持久化
- 创建人物时自动关联匹配的文件
- 调用 `dbUpsertFileMetadata` 持久化 `aiData.faces`
- 存储角色标签名称和索引到 Person 结构

### 14.7 修改文件
- `src-tauri/src/clip_commands.rs` - 新增 3 个命令
- `src-tauri/src/main.rs` - 注册新命令
- `src/types.ts` - 新增类型定义，Person 添加 `characterTagName` 和 `characterTagIndex`
- `src-tauri/src/db/persons.rs` - 数据库结构添加新字段
- `src/api/tauri-bridge.ts` - 新增 API 函数
- `src/components/modals/SmartCreatePersonModal.tsx` - 新建模态框组件
- `src/components/AppModals.tsx` - 集成新模态框
- `src/components/ContextMenu.tsx` - 添加菜单入口
- `src/App.tsx` - 添加处理函数
- `src/utils/translations.ts` - 添加翻译

## 15. 智能添加图片功能

### 15.1 功能说明
在人物详情页提供手动入口，使用相似度阈值滑块搜索匹配的新图片并添加到人物。

### 15.2 功能入口
- 人物右键菜单 → 「智能添加图片」

### 15.3 UI 特性
- 人物头像显示（支持裁剪效果）
- 相似度阈值滑块（0.01 - 0.5）
- 匹配图片网格（虚拟滚动）
- 全选/取消全选按钮
- 已关联图片自动过滤
- 新图片检测与嵌入向量生成提示

### 15.4 新图片检测
打开窗口时自动检测是否有新图片缺少嵌入向量：
1. 遍历所有未关联的图片文件
2. 调用 `clipGetEmbeddingStatus` 检查嵌入向量是否存在
3. 如果有新图片，显示黄色提示框
4. 用户点击按钮后调用 `clipGenerateEmbeddingsBatch` 生成
5. 生成完成后自动刷新匹配列表

### 15.5 相关 API
| API | 说明 |
|-----|------|
| `clipGetEmbeddingStatus` | 检查单个文件是否有嵌入向量 |
| `clipGenerateEmbeddingsBatch` | 批量生成嵌入向量 |

### 15.6 修改文件
- `src/types.ts` - Person 类型添加新字段
- `src-tauri/src/db/persons.rs` - 数据库结构添加新字段
- `src-tauri/src/db/mod.rs` - 数据库迁移
- `src/App.tsx` - 新增 handleSmartAddToPerson
- `src/components/modals/SmartAddToPersonModal.tsx` - 新建组件
- `src/components/ContextMenu.tsx` - 添加菜单入口
- `src/components/AppModals.tsx` - 集成新模态框
- `src/utils/translations.ts` - 添加翻译

---
*记录时间: 2026-02-23*
*更新时间: 2026-02-28*
*维护者: Antigravity*
