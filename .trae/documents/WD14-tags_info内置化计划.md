# WD14 模型 tags_info.csv 内置化计划

## 背景
用户已将 WD-EVA02-Large-Tagger-V3 模型所需的英文原版 CSV 文件复制到了 `src-tauri/src/clip/tags_info.csv` 目录中。目标是让模型使用这个内置文件，而不是从模型下载目录加载，并移除模型下载时的 tags_info.csv 文件。

## 当前状态
- 内置文件已存在: `src-tauri/src/clip/tags_info.csv`
- 模型下载目录: `{model_cache_dir}/WD-EVA02-Large-Tagger-V3/tags_info.csv`

## 需要修改的文件

### 1. `src-tauri/src/clip/models/wd14.rs`
**修改内容**: 移除 `model_files()` 中的 `tags_info.csv` 下载配置

**当前代码** (第 44-57 行):
```rust
fn model_files(&self) -> Vec<ModelFile> {
    vec![
        ModelFile::new("model.onnx", "..."),
        ModelFile::new("tags_info.csv", "..."),  // 需要移除
    ]
}
```

**修改后**:
```rust
fn model_files(&self) -> Vec<ModelFile> {
    vec![
        ModelFile::new("model.onnx", "..."),
    ]
}
```

**同时修改** `tags_file()` 方法 (第 83-85 行):
```rust
fn tags_file(&self) -> Option<&str> {
    None  // 使用内置文件，不从模型目录加载
}
```

### 2. `src-tauri/src/clip/model.rs`
**修改内容**: 添加嵌入的英文标签文件，并修改 `LabelMapper` 支持从嵌入数据加载

**新增常量** (在第 20 行附近):
```rust
/// 嵌入英文标签文件
const TAGS_EN_CSV: &str = include_str!("tags_info.csv");
```

**修改 `LabelMapper`** (第 110-151 行):
添加一个新方法 `load_embedded()` 从嵌入的 CSV 数据加载:
```rust
impl LabelMapper {
    pub fn load_embedded() -> Result<Self, String> {
        let mut rdr = csv::Reader::from_reader(TAGS_EN_CSV.as_bytes());
        
        let mut tags = Vec::new();
        for result in rdr.records() {
            let record = result.map_err(|e| format!("Failed to read tag record: {}", e))?;
            if record.len() >= 2 {
                let tag_name = record[1].replace('_', " ").trim().to_string();
                tags.push(tag_name);
            }
        }
        
        log::info!("Loaded {} tags from embedded file", tags.len());
        Ok(Self { tags })
    }
    
    // 保留原有的 load() 方法用于其他模型（如果需要）
    pub fn load(path: &std::path::Path) -> Result<Self, String> { ... }
}
```

**修改模型加载逻辑** (第 243-251 行):
```rust
// 加载标签映射器（如果是 Tagger）
let mut label_mapper = None;
if model_spec.is_tagger() {
    // 使用嵌入的标签文件
    label_mapper = Some(LabelMapper::load_embedded()?);
}
```

### 3. `src-tauri/src/clip_commands.rs`
**修改内容**: 
1. 添加嵌入的英文标签文件常量
2. 修改 `TagMapper` 支持从嵌入数据加载
3. 更新所有 6 处标签文件加载代码

**新增常量** (在文件开头):
```rust
/// 嵌入英文标签文件
const TAGS_EN_CSV: &str = include_str!("clip/tags_info.csv");
```

**修改 `TagMapper`** (第 1083-1134 行):
添加 `load_embedded()` 方法:
```rust
impl TagMapper {
    fn load_embedded() -> Result<Self, String> {
        let mut rdr = csv::Reader::from_reader(TAGS_EN_CSV.as_bytes());
        
        let mut tags = Vec::new();
        for result in rdr.records() {
            let record = result.map_err(|e| format!("Failed to read tag record: {}", e))?;
            if record.len() >= 3 {
                let tag_name = record[1].replace('_', " ").trim().to_string();
                let category: i32 = record[2].parse().unwrap_or(-1);
                tags.push(TagEntry { name: tag_name, category });
            }
        }
        
        log::info!("Loaded {} tags from embedded file", tags.len());
        Ok(Self { tags })
    }
    
    // 保留原有的 load() 方法
    fn load(tags_path: &std::path::Path) -> Result<Self, String> { ... }
}
```

**更新 6 处标签文件加载代码**:
将:
```rust
let tags_path = model_cache_dir
    .join(&requested_model)
    .join("tags_info.csv");

if !tags_path.exists() {
    return Err(format!("标签文件不存在: {:?}，请确保模型已下载", tags_path));
}

let mapper = TagMapper::load(&tags_path)?;
```

改为:
```rust
let mapper = TagMapper::load_embedded()?;
```

**涉及位置**:
1. 第 1181-1189 行 - `clip_generate_tags_from_embeddings` 函数
2. 第 1311-1317 行 - `clip_preview_tags_from_embeddings` 函数
3. 第 1414-1420 行 - `clip_get_character_tags` 函数
4. 第 1540-1546 行 - `clip_search_by_character_tag` 函数
5. 第 1709-1715 行 - `clip_get_detected_characters` 函数
6. 第 1927-1933 行 - `clip_get_work_topics` 函数

## 实现步骤

1. **修改 `src-tauri/src/clip/models/wd14.rs`**
   - 从 `model_files()` 移除 `tags_info.csv` 条目
   - 修改 `tags_file()` 返回 `None`

2. **修改 `src-tauri/src/clip/model.rs`**
   - 添加 `const TAGS_EN_CSV: &str = include_str!("tags_info.csv");`
   - 为 `LabelMapper` 添加 `load_embedded()` 方法
   - 修改模型加载时使用 `load_embedded()`

3. **修改 `src-tauri/src/clip_commands.rs`**
   - 添加 `const TAGS_EN_CSV: &str = include_str!("clip/tags_info.csv");`
   - 为 `TagMapper` 添加 `load_embedded()` 方法
   - 更新所有 6 处标签文件加载代码

4. **验证**
   - 确保编译通过
   - 确保标签功能正常工作

## 注意事项
- 内置文件会增加二进制文件大小 (tags_info.csv 约 300KB)
- 用户已下载的模型目录中的 tags_info.csv 可以手动删除，或保留不影响功能
- 前端 UI 的下载文件数量显示会自动适配（之前已修复为动态计算）
