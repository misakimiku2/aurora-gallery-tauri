## 功能概述
在批量重命名弹窗中新增"自动命名"按钮，点击后打开AI批量重命名窗口，将选中的图片发送给AI模型，根据图片内容生成新文件名。支持使用设置中配置的系统提示词。

## 实现步骤

### 1. 新增类型定义 (src/types.ts)
- 在 `activeModal.type` 中添加 `'ai-batch-rename'` 类型
- 新增 `AIBatchRenameResult` 接口，存储AI生成的文件名结果

### 2. 新增翻译文本 (src/utils/translations.ts)
添加以下中文/英文翻译键：
- `context.autoRename` - "自动命名"
- `context.aiBatchRename` - "AI批量重命名"
- `context.aiRenameDesc` - "AI将根据图片内容智能生成文件名"
- `context.startGenerating` - "开始生成"
- `context.regenerate` - "重新生成"
- `context.applyRename` - "应用重命名"
- `context.aiGenerating` - "AI生成中..."
- `context.originalName` - "原文件名"
- `context.newName` - "新文件名"

### 3. 新增AI批量重命名弹窗组件 (src/components/modals/AIBatchRenameModal.tsx)
创建新组件，包含：
- 左侧：显示选中的文件列表（缩略图+原文件名）
- 右侧：显示AI生成的新文件名列表
- 底部按钮："开始生成"/"重新生成"、"应用重命名"、"取消"
- 生成状态显示（加载动画、进度提示）

### 4. 修改批量重命名弹窗 (src/components/modals/BatchRenameModal.tsx)
- 在现有表单右侧添加"自动命名"图标按钮（使用 Sparkles 或 Wand2 图标）
- 点击按钮关闭当前弹窗，打开AI批量重命名弹窗

### 5. 修改AppModals.tsx
- 导入新的 `AIBatchRenameModal` 组件
- 在模态框渲染逻辑中添加 `ai-batch-rename` 类型的处理
- 传递必要的props：选中文件、文件数据、AI配置、翻译函数等

### 6. 新增AI命名服务函数 (src/services/aiService.ts)
新增方法 `generateFileNames(filePaths: string[], settings: AppSettings): Promise<string[]>`：
- 将图片转换为base64格式
- **构建消息数组**：
  1. 如果 `settings.ai.systemPrompt` 存在，先添加 system 角色消息
  2. 添加 user 角色消息，包含重命名任务提示词和图片
- 调用AI API（支持OpenAI/Ollama/LM Studio）
- 解析返回结果，返回文件名数组

**提示词结构示例**：
```json
{
  "messages": [
    {
      "role": "system",
      "content": "用户设置的系统提示词内容..."
    },
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "请根据图片内容生成简洁的文件名，要求：1.使用中文 2.不超过20字 3.保留扩展名..."
        },
        {
          "type": "image_url",
          "image_url": { "url": "data:image/jpeg;base64,..." }
        }
      ]
    }
  ]
}
```

### 7. 新增Tauri桥接函数 (src/api/tauri-bridge.ts)
新增 `readFilesAsBase64(filePaths: string[]): Promise<string[]>` 用于批量读取图片

### 8. 修改App.tsx
- 新增 `handleAIBatchRename` 处理函数
- 处理AI生成文件名的逻辑
- 应用重命名结果到文件

## UI设计

### BatchRenameModal 修改
```
┌─────────────────────────────────┐
│ 批量重命名                    [✨]│  <- 新增自动命名按钮
├─────────────────────────────────┤
│ 已选择 5 个文件                  │
├─────────────────────────────────┤
│ 命名模式                        │
│ [Image_###              ]       │
│ 使用 ### 作为数字占位符          │
├─────────────────────────────────┤
│ 起始编号                        │
│ [1                      ]       │
├─────────────────────────────────┤
│ [取消]              [确认]      │
└─────────────────────────────────┘
```

### AIBatchRenameModal 新组件
```
┌─────────────────────────────────────────────────────────────┐
│ AI批量重命名                                    [×]         │
├──────────────────────────┬──────────────────────────────────┤
│ 原文件                    │ AI生成的新文件名                  │
├──────────────────────────┼──────────────────────────────────┤
│ [缩略图] IMG_001.jpg      │ 夕阳下的海滩.jpg                   │
│ [缩略图] IMG_002.jpg      │ 山间晨雾风景.jpg                   │
│ [缩略图] IMG_003.jpg      │ 城市夜景灯光.jpg                   │
│ [缩略图] IMG_004.jpg      │ 猫咪在沙发上.jpg                   │
│ [缩略图] IMG_005.jpg      │ 美食摄影-寿司.jpg                  │
├──────────────────────────┴──────────────────────────────────┤
│ [开始生成]  [应用重命名]  [取消]                              │
└─────────────────────────────────────────────────────────────┘
```

## 技术要点

1. **系统提示词处理**：
   - 检查 `settings.ai.systemPrompt` 是否存在
   - 如果存在，在API请求中先添加 system 角色消息
   - 然后添加包含重命名任务的 user 角色消息

2. **图片处理**：使用现有的 `readFileAsBase64` 读取图片，压缩后发送给AI

3. **AI提示词设计（User消息）**：
   - 要求生成简洁、描述性的中文文件名
   - 限制文件名长度（建议20字以内）
   - 保留原始文件扩展名

4. **并发控制**：批量处理时限制并发数，避免AI API过载

5. **错误处理**：单个文件生成失败时保留原文件名，不影响其他文件

6. **进度反馈**：显示生成进度（如 "正在分析第3/5张图片..."）