# WD14 Tagger (EVA02-Large) 模型集成与优化记录

## 1. 背景与目标
在 Aurora Gallery 中集成 `WD-EVA02-Large-Tagger-V3` 模型，旨在为动漫/二次元图像提供更精准的标签识别（Auto-tagging）及 1024 维的特征向量（Embedding）搜索。

## 2. 核心修复点回顾

### 2.1 基础设施兼容性
- **无 Tokenizer 支持**: 修正了 `ClipModel` 强制加载 `tokenizer.json` 的逻辑。对于 WD14 这类纯视觉标注模型，系统现已支持跳过 Tokenizer 加载。
- **UI 动态反馈**: 修正了前端 `SettingsModal.tsx` 中硬编码的下载文件数量，自动适配 WD14 的 2 文件结构（Model + CSV）。

### 2.2 张量布局布局 (Critical)
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

## 4. 后续建议
- **多卡/并行流支持**: 若需进一步榨干 30 系/40 系显卡性能，可考虑移除推理引擎的独占锁，改为通过并发 `Session` 同时处理多路串行流。
- **标签过滤优化**: 目前默认阈值为 0.35，用户可根据收藏偏好在后续版本中调整该灵敏度。

## 4.1 UI 限制处理 (2026-02-25)
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

## 5. DirectML LayerNormalization 错误修复 (2026-02-24)

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

## 6. 流水线预处理优化 (2026-02-24)

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

## 7. CPU 模式性能优化 (2026-02-24)

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

## 8. 以图搜图功能实现 (2026-02-25)

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

## 9. WD14 预处理修复 (2026-02-25)

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

## 10. 搜索参数可配置化 (2026-02-25)

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

---

## 11. 从嵌入向量生成标签功能 (2026-02-26)

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

---

## 12. 中文标签翻译功能 (2026-02-26)

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

---

## 13. 标签持久化与刷新修复 (2026-02-26)

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

---

## 14. 智能创建人物功能 (2026-02-28)

### 14.1 功能说明
利用 WD14 Tagger 模型的角色标签（category: 4）自动识别和创建人物，支持：
- 基于嵌入向量中的角色标签概率识别人物
- 角色名称自动补全和搜索
- 相似度阈值可调节
- 虚拟滚动展示匹配图片

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
- 圆形头像预览（可点击裁剪）
- 角色名称输入（支持自动补全）
- 已识别角色列表（虚拟滚动）
- 相似度阈值滑块（0.01 - 0.5）
- 匹配图片网格（虚拟滚动）

### 14.5 阈值优化

#### 14.5.1 问题发现
角色标签的嵌入向量值通常很小（如 0.000007），远低于默认阈值 0.4。

#### 14.5.2 解决方案
- 默认阈值从 0.4 降低到 0.1
- 滑块范围调整为 0.01 - 0.5
- 后端自动检测过高阈值并降级

### 14.6 修改文件
- `src-tauri/src/clip_commands.rs` - 新增 3 个命令
- `src-tauri/src/main.rs` - 注册新命令
- `src/types.ts` - 新增类型定义
- `src/api/tauri-bridge.ts` - 新增 API 函数
- `src/components/modals/SmartCreatePersonModal.tsx` - 新建模态框组件
- `src/components/AppModals.tsx` - 集成新模态框
- `src/components/ContextMenu.tsx` - 添加菜单入口
- `src/App.tsx` - 添加处理函数
- `src/utils/translations.ts` - 添加翻译

---

## 15. 智能创建人物功能优化 (2026-02-28)

### 15.1 翻译问题修复

#### 15.1.1 问题现象
智能创建人物窗口中，UI 文本显示为翻译键而非翻译后的文本。

#### 15.1.2 解决方案
在 `translations.ts` 中添加 `smartCreate` 命名空间：
```typescript
smartCreate: {
  title: '智能创建人物',
  preview: '预览匹配图片',
  characterName: '角色名称',
  // ... 其他翻译
}
```

### 15.2 创建人物时自动关联文件

#### 15.2.1 问题现象
创建人物后，匹配的图片没有自动关联到该人物的人脸数据中。

#### 15.2.2 解决方案
修改 `handleSmartCreatePerson` 函数，在创建人物后自动为每个匹配的文件添加人脸关联记录：
```typescript
matchedFileIds.forEach(fid => {
  const file = newFiles[fid];
  if (file && file.type === FileType.IMAGE) {
    const newFace: AiFace = {
      id: Math.random().toString(36).substr(2, 9),
      personId: newId,
      name: name,
      confidence: 1.0,
      box: { x: 0, y: 0, w: 0, h: 0 }
    };
    // 更新文件的 aiData.faces
  }
});
```

### 15.3 头像裁剪功能重构

#### 15.3.1 问题现象
1. 点击头像进入裁剪窗口后，右侧文件栏为空
2. 确认裁剪后创建了无名人物，没有正确返回智能创建窗口

#### 15.3.2 解决方案
将裁剪功能完全集成到 `SmartCreatePersonModal` 组件内部：
- 移除对外部 `CropAvatarModal` 的依赖
- 在组件内部实现 `isCropping` 状态切换
- 裁剪界面使用原图（`convertFileSrc`）而非缩略图
- 裁剪完成后更新 `coverFaceBox` 状态

#### 15.3.3 裁剪预览实现
使用 `img` 元素配合 `left/top` 定位显示裁剪区域：
```tsx
<img
  src={coverSrc}
  style={coverFaceBox ? {
    width: `${10000 / coverFaceBox.w}%`,
    height: `${10000 / coverFaceBox.h}%`,
    left: `${-coverFaceBox.x / coverFaceBox.w * 100}%`,
    top: `${-coverFaceBox.y / coverFaceBox.h * 100}%`
  } : undefined}
/>
```

### 15.4 角色列表中文翻译

#### 15.4.1 问题现象
软件语言为中文时，角色列表显示英文名称。

#### 15.4.2 解决方案
修改后端 `clip_get_detected_characters` 函数：
1. 新增 `language` 参数
2. 当语言为 "zh" 时，加载 `Tags-cn_2024_ver-1.0.csv` 文件
3. 使用中文翻译填充 `tag_name_cn` 字段

```rust
let cn_tags_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .join("src")
    .join("clip")
    .join("models")
    .join("Tags-cn_2024_ver-1.0.csv");

// 加载中文翻译映射
let mut cn_translations: HashMap<String, String> = HashMap::new();
if lang == "zh" && cn_tags_path.exists() {
    // 读取 CSV 并填充映射
}

// 返回结果时使用翻译
let cn_name = cn_translations.get(&name).cloned().unwrap_or_else(|| name.clone());
```

### 15.5 修改文件
- `src/utils/translations.ts` - 添加 smartCreate 翻译命名空间
- `src/App.tsx` - 修改 handleSmartCreatePerson 函数
- `src/components/modals/SmartCreatePersonModal.tsx` - 内部实现裁剪功能
- `src/components/AppModals.tsx` - 移除不需要的 props
- `src/api/tauri-bridge.ts` - clipGetDetectedCharacters 添加 language 参数
- `src-tauri/src/clip_commands.rs` - clip_get_detected_characters 添加中文翻译支持

---

## 16. 智能创建人物功能深度优化 (2026-02-28)

### 16.1 角色列表使用缩略图

#### 16.1.1 问题现象
角色列表头像使用原图加载，导致加载缓慢，且 GIF 图片会播放动画。

#### 16.1.2 解决方案
1. 新增 `characterThumbnailUrls` 状态存储角色缩略图
2. 添加 `useEffect` 在加载角色后预加载缩略图
3. 修改 `CharacterRow` 组件只使用缩略图，不回退到原图

```tsx
// 只使用缩略图，缩略图加载前显示占位图标
{sampleFile && thumbnailUrl ? (
  <img src={thumbnailUrl} ... />
) : (
  <User size={16} />  // 占位图标
)}
```

#### 16.1.3 缩略图并行加载优化
将串行加载改为并行批量加载，每批 10 个：

```tsx
const batchSize = 10;
for (let i = 0; i < chars.length; i += batchSize) {
  const batch = chars.slice(i, i + batchSize);
  const results = await Promise.all(
    batch.map(async char => ...)
  );
  setCharacterThumbnailUrls(prev => ({ ...prev, ...newUrls }));  // 渐进式更新
}
```

### 16.2 窗口布局响应式优化

#### 16.2.1 问题现象
窗口固定大小 `w-[800px] max-h-[90vh]`，角色列表高度固定 `h-48`。

#### 16.2.2 解决方案
1. 窗口改为响应式：`w-full max-w-4xl h-[85vh]`
2. 角色列表使用 `flex-1 min-h-0` 自适应高度
3. 添加 `ResizeObserver` 动态检测列表高度
4. `react-window` 使用动态 `characterListHeight`

### 16.3 阈值滑块分离

#### 16.3.1 问题现象
只有一个相似度阈值滑块，同时影响角色列表检测和图片搜索。

#### 16.3.2 解决方案
分离为两个独立滑块：

| 滑块 | 位置 | 功能 |
|------|------|------|
| 角色检测阈值 | 左侧面板 | 控制角色列表检测 |
| 相似度阈值 | 右侧预览区 | 控制匹配图片搜索 |

#### 16.3.3 防抖机制
两个滑块都添加 200ms 防抖，避免频繁请求：

```tsx
const handleThresholdChange = useCallback((newThreshold: number) => {
  setThreshold(newThreshold);
  if (debounceTimerRef.current) {
    clearTimeout(debounceTimerRef.current);
  }
  debounceTimerRef.current = setTimeout(async () => {
    // 执行搜索
  }, 200);
}, [selectedCharacter]);
```

### 16.4 后端阈值降级逻辑移除

#### 16.4.1 问题现象
后端有降级逻辑：当 `min_score > 0.3` 时强制使用 `0.1`，导致阈值调高后反而检测到更多角色。

#### 16.4.2 解决方案
移除降级逻辑，让用户完全控制阈值：

```rust
// 之前
let effective_min_score = if min_score > 0.3 { 0.1 } else { min_score };

// 之后
let effective_min_score = min_score;
```

### 16.5 头像裁剪优化

#### 16.5.1 问题现象
裁剪后头像显示缩略图而非原图效果。

#### 16.5.2 解决方案
裁剪后使用原图，未裁剪时使用缩略图：

```tsx
const coverSrc = coverFile && coverFileId 
  ? (coverFaceBox 
      ? coverOriginalSrc           // 裁剪后用原图
      : thumbnailUrls[coverFileId] || coverOriginalSrc)
  : null;
```

#### 16.5.3 选择新角色时重置裁剪框
```tsx
const handleSelectCharacter = useCallback(async (char: DetectedCharacter) => {
  setCoverFileId(char.sample_file_id);
  setCoverFaceBox(undefined);  // 重置裁剪框
  // ...
}, [...]);
```

### 16.6 头像大小调整

| 位置 | 之前 | 之后 |
|------|------|------|
| 主头像 | `w-24 h-24` (96px) | `w-32 h-32` (128px) |
| 角色列表头像 | `w-7 h-7` (28px) | `w-9 h-9` (36px) |
| 行高 | `ITEM_HEIGHT = 40` | `ITEM_HEIGHT = 48` |

### 16.7 加载状态优化

#### 16.7.1 问题现象
加载状态显示文字"加载中..."、"搜索中..."。

#### 16.7.2 解决方案
使用 CSS 旋转动画替代文字：

```tsx
<div className="w-6 h-6 border-2 border-gray-300 dark:border-gray-500 
                border-t-blue-500 dark:border-t-blue-400 
                rounded-full animate-spin" />
```

### 16.8 修改文件
- `src/components/modals/SmartCreatePersonModal.tsx` - 主要优化
- `src/utils/translations.ts` - 添加 characterThreshold 翻译
- `src-tauri/src/clip_commands.rs` - 移除阈值降级逻辑

---
*记录时间: 2026-02-23*
*更新时间: 2026-02-28*
*维护者: Antigravity*
