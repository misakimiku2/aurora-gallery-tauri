# CLIP 模型切换问题修复计划

## 问题描述

用户在设置界面选择了 ViT-L/14 并点击"使用"按钮后，搜索时终端显示加载的是 ViT-B/32，导致：
- 模型与嵌入向量维度不匹配（512维 vs 768维）
- 搜索结果与预期完全不符

## 问题根源分析

**核心问题**：前后端模型名称状态不同步

### 问题流程

1. 用户在设置界面选择 `ViT-L-14` 并点击"使用"
2. `handleSelectModel` 被调用：
   - 前端 `settings.clip.modelName` 更新为 `ViT-L-14` ✅
   - 后端 `ClipConfig.model_name` 临时更新为 `ViT-L-14` ✅
   - 模型加载成功 ✅
3. **场景A**：模型被卸载（如切换GPU设置、内存不足等）
4. **场景B**：应用重启后进行 CLIP 搜索
5. `clip_search_by_text` 检测到模型未加载，自动调用 `load_model`
6. **问题**：此时 `ClipConfig.model_name` 可能是默认值 `ViT-B-32`
7. 终端显示加载的是 `ViT-B-32` ❌

### 关键代码位置

**搜索时自动加载模型** - [main.rs:2663-2708](file:///c:\Users\Misaki\Desktop\git\aurora-gallery-tauri\src-tauri\src\main.rs#L2663-L2708)：
```rust
// 问题所在：这里没有设置模型名称！
guard.load_model(&app).await.map_err(|e| format!("Failed to load model: {}", e))?;
```

**后端默认配置** - [clip/mod.rs:33-41](file:///c:\Users\Misaki\Desktop\git\aurora-gallery-tauri\src-tauri\src\clip\mod.rs#L33-L41)：
```rust
impl Default for ClipConfig {
    fn default() -> Self {
        Self {
            model_name: "ViT-B-32".to_string(),  // 默认模型
            // ...
        }
    }
}
```

## 解决方案

### 方案：前端传递模型名称到搜索接口

修改搜索相关的 Tauri 命令，让前端在调用时传递当前设置的模型名称。如果模型未加载或加载的模型与请求的不一致，则加载正确的模型。

### 修改内容

#### 1. 修改后端 `clip_search_by_text` 命令

**文件**：`src-tauri/src/main.rs`

**修改**：添加 `model_name` 参数，并在加载模型前检查是否需要切换模型

```rust
async fn clip_search_by_text(
    text: String,
    top_k: Option<usize>,
    min_score: Option<f32>,
    model_name: Option<String>,  // 新增参数
    app: tauri::AppHandle,
) -> Result<Vec<SearchResult>, String> {
    let manager = clip::get_clip_manager().await
        .ok_or("CLIP manager not initialized")?;
    
    // 获取请求的模型名称，如果没有提供则使用默认值
    let requested_model = model_name.unwrap_or_else(|| "ViT-B-32".to_string());
    
    // 检查并加载模型
    {
        let guard = manager.read().await;
        let current_model = guard.get_model_name();
        let is_loaded = guard.is_model_loaded();
        
        // 如果模型未加载，或加载的模型与请求的不一致
        if !is_loaded || current_model != requested_model {
            drop(guard);
            
            let mut guard = manager.write().await;
            // 双重检查
            let current_model = guard.get_model_name();
            let is_loaded = guard.is_model_loaded();
            
            if !is_loaded || current_model != requested_model {
                log::info!("Loading model: {} (current: {}, loaded: {})", 
                    requested_model, current_model, is_loaded);
                
                // 如果有其他模型已加载，先卸载
                if is_loaded {
                    guard.unload_model();
                }
                
                // 设置并加载正确的模型
                guard.set_model_name(requested_model);
                guard.load_model(&app).await.map_err(|e| format!("Failed to load model: {}", e))?;
            }
        }
    }
    // ... 后续搜索逻辑
}
```

#### 2. 修改后端 `clip_search_by_image` 命令

**文件**：`src-tauri/src/main.rs`

**修改**：同样添加 `model_name` 参数，逻辑与 `clip_search_by_text` 相同

#### 3. 修改前端 API 调用

**文件**：`src/api/tauri-bridge.ts`

**修改**：`clipSearchByText` 和 `clipSearchByImage` 函数添加 `modelName` 参数

```typescript
export const clipSearchByText = async (
  text: string, 
  topK: number = 20, 
  minScore: number = 0.2,
  modelName?: string  // 新增参数
): Promise<SearchResult[]> => {
  // ...
  const results = await invoke<SearchResult[]>('clip_search_by_text', { 
    text, 
    topK, 
    minScore,
    modelName  // 传递模型名称
  });
  // ...
};
```

#### 4. 修改前端搜索调用

**文件**：`src/App.tsx`

**修改**：在调用搜索时传递当前设置的模型名称

```typescript
const results = await clipSearchByText(
  searchText,
  20,
  0.2,
  settings.clip.modelName  // 传递当前设置的模型名称
);
```

#### 5. 添加 `get_model_name` 方法到 ClipManager

**文件**：`src-tauri/src/clip/mod.rs`

**修改**：添加获取当前模型名称的方法

```rust
impl ClipManager {
    pub fn get_model_name(&self) -> String {
        self.config.model_name.clone()
    }
}
```

## 验证步骤

1. 启动应用，打开设置 → AI视觉
2. 选择 ViT-L-14 模型并点击"使用"
3. 确认终端显示加载的是 ViT-L-14
4. 进行 CLIP 搜索，确认使用的是正确的模型
5. 切换 GPU 设置（触发模型卸载重载）
6. 再次进行 CLIP 搜索，确认仍然使用 ViT-L-14
7. 重启应用，进行 CLIP 搜索，确认使用的是设置中保存的模型

## 文件修改清单

| 文件 | 修改内容 |
|------|----------|
| `src-tauri/src/main.rs` | 修改 `clip_search_by_text` 和 `clip_search_by_image` 命令，添加 `model_name` 参数 |
| `src-tauri/src/clip/mod.rs` | 添加 `get_model_name` 方法 |
| `src/api/tauri-bridge.ts` | 修改 `clipSearchByText` 和 `clipSearchByImage` 函数签名 |
| `src/App.tsx` | 修改搜索调用，传递模型名称 |
