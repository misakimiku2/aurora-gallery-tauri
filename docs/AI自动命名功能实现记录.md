# AI自动命名功能实现记录

**日期**: 2026-02-10  
**功能**: AI批量重命名（Auto Rename）

---

## 功能概述

在批量重命名弹窗中新增"自动命名"按钮，点击后打开AI批量重命名窗口。窗口左侧显示选中的文件列表（缩略图+原文件名），右侧显示AI生成的新文件名。点击下方"开始生成"后，会将图片发送给AI模型，让AI根据图片内容智能生成新的文件名。

---

## 修改文件清单

### 1. 类型定义 ([src/types.ts](../src/types.ts))

**修改内容**: 在 `activeModal.type` 中添加 `'ai-batch-rename'` 类型

```typescript
activeModal: {
  type: 'copy-to-folder' | 'move-to-folder' | ... | 'batch-rename' | 'ai-batch-rename' | ... | null;
  data?: any;
};
```

---

### 2. 翻译文本 ([src/utils/translations.ts](../src/utils/translations.ts))

**添加的中文翻译键**:
- `autoRename`: "自动命名"
- `aiBatchRename`: "AI批量重命名"
- `aiRenameDesc`: "AI将根据图片内容智能生成文件名"
- `startGenerating`: "开始生成"
- `regenerate`: "重新生成"
- `applyRename`: "应用重命名"
- `aiGenerating`: "AI生成中..."
- `originalName`: "原文件名"
- `newName`: "新文件名"
- `aiRenameHint`: "点击下方'开始生成'按钮..."
- `failed`: "失败"
- `pending`: "等待中"
- `renamed`: "已重命名"
- `backToManualRename`: "返回手动重命名"

**添加的英文翻译键**: 同上（英文版本）

---

### 3. AI批量重命名弹窗 ([src/components/modals/AIBatchRenameModal.tsx](../src/components/modals/AIBatchRenameModal.tsx))

**新建文件**，包含以下功能：

#### 界面结构
- **左侧**: 原文件列表（缩略图 + 文件名）
- **右侧**: AI生成的新文件名列表（同样显示缩略图，保持行高一致）
- **底部**: 返回按钮（左）+ 操作按钮（右）
- **进度条**: 显示AI生成进度

#### 主要特性
1. **缩略图优化**:
   - 使用 `getThumbnail()` API 获取生成的缩略图
   - 添加 CSS 优化减少锯齿:
     ```css
     imageRendering: '-webkit-optimize-contrast'
     transform: 'translateZ(0)'  /* 硬件加速 */
     ```

2. **统一的行高**: 两侧都使用 `min-h-[64px]` 确保行高一致

3. **返回功能**: 点击"返回手动重命名"按钮可回到批量重命名弹窗

#### Props 接口
```typescript
interface AIBatchRenameModalProps {
  files: FileNode[];
  settings: AppSettings;
  onConfirm: (newNames: Record<string, string>) => void;
  onClose: () => void;
  onBack?: () => void;  // 返回手动重命名
  t: (key: string) => string;
}
```

---

### 4. 批量重命名弹窗 ([src/components/modals/BatchRenameModal.tsx](../src/components/modals/BatchRenameModal.tsx))

**修改内容**:
- 导入 `Sparkles` 图标
- 添加 `onAutoRename` 可选属性
- 在标题栏右侧添加"自动命名"按钮

```typescript
interface BatchRenameModalProps {
    count: number;
    onConfirm: (pattern: string, startNum: number) => void;
    onClose: () => void;
    onAutoRename?: () => void;  // 新增
    t: (key: string) => string;
}
```

---

### 5. 模态框管理 ([src/components/AppModals.tsx](../src/components/AppModals.tsx))

**修改内容**:
- 导入 `AIBatchRenameModal` 组件
- 添加 `handleAIBatchRename` 属性到 `AppModalsProps`
- 在 `batch-rename` 模态框中添加 `onAutoRename` 回调
- 添加 `ai-batch-rename` 模态框的渲染逻辑

```typescript
// batch-rename 模态框
<BatchRenameModalComp 
  ...
  onAutoRename={() => setState(s => ({ ...s, activeModal: { type: 'ai-batch-rename' } }))}
/>

// ai-batch-rename 模态框
<AIBatchRenameModalComp 
  files={activeTab.selectedFileIds.map(id => state.files[id]).filter(Boolean)}
  settings={state.settings}
  onConfirm={(newNames) => { handleAIBatchRename(newNames); closeModals(); }}
  onClose={closeModals}
  onBack={() => setState(s => ({ ...s, activeModal: { type: 'batch-rename' } }))}
  t={t}
/>
```

---

### 6. AI服务 ([src/services/aiService.ts](../src/services/aiService.ts))

**新增方法**:

#### `generateFileNames()`
批量生成文件名，支持进度回调

#### `generateSingleFileName()`
为单个文件生成文件名

**特性**:
1. **系统提示词支持**: 如果设置了 `settings.ai.systemPrompt`，会先发送系统提示词
2. **多AI提供商支持**: OpenAI、Ollama、LM Studio
3. **多模态图片分析**: 支持 GPT-4V、LLaVA 等视觉模型
4. **思考内容过滤**: 自动清理 `<think>` 标签和GLM模型的思考内容

**提示词设计**:
```
请根据这张图片的内容，直接输出一个简洁、描述性的中文文件名。不要思考，不要解释，直接输出文件名。

要求：
1. 文件名应该准确描述图片的主要内容
2. 使用中文，简洁明了（10-20字）
3. 不要包含特殊字符，只使用中文、英文、数字、空格和下划线
4. 直接输出文件名，不要有任何解释、思考过程或额外文字
5. 原文件名是："xxx"

请只返回新的文件名（不包含扩展名）：
```

**思考内容清理逻辑**:
```typescript
// 移除 think 标签及其内容
newName = newName.replace(/<think[\s\S]*?<\/think>/gi, '');

// 处理 GLM 模型的思考格式
if (newName.toLowerCase().startsWith('<think>')) {
  const thinkEndIndex = newName.indexOf('\n');
  if (thinkEndIndex !== -1) {
    newName = newName.substring(thinkEndIndex + 1);
  }
}

// 过滤思考关键词
newName = newName.split('\n').filter(line => {
  const lowerLine = line.trim().toLowerCase();
  return !lowerLine.startsWith('think') && 
         !lowerLine.includes('用户现在') &&
         !lowerLine.includes('首先看') &&
         !lowerLine.includes('分析');
}).join('\n');
```

---

### 7. 文件操作 Hook ([src/hooks/useFileOperations.ts](../src/hooks/useFileOperations.ts))

**新增函数**: `handleAIBatchRename()`

```typescript
const handleAIBatchRename = async (newNames: Record<string, string>) => {
  // 遍历AI生成的新文件名并执行实际的重命名操作
  // 显示任务进度
  // 完成后显示提示
};
```

**导出**: 在 `return` 语句中添加 `handleAIBatchRename`

---

### 8. 主应用 ([src/App.tsx](../src/App.tsx))

**修改内容**:
- 从 `useFileOperations` 解构 `handleAIBatchRename`
- 传递给 `AppModals` 组件

---

## 界面预览

### 批量重命名弹窗
```
┌─────────────────────────────────┐
│ 批量重命名              [✨自动命名]│
├─────────────────────────────────┤
│ 已选择 5 个文件                  │
├─────────────────────────────────┤
│ 命名模式: [Image_###      ]     │
│ 起始编号: [1              ]     │
├─────────────────────────────────┤
│ [取消]              [确认]      │
└─────────────────────────────────┘
```

### AI批量重命名弹窗
```
┌─────────────────────────────────────────────────────────────┐
│ ✨ AI批量重命名                                  [×]         │
├─────────────────────────────────────────────────────────────┤
│ AI将根据图片内容智能生成文件名                               │
├──────────────────────────┬──────────────────────────────────┤
│ 原文件名 (4)              │ 新文件名                          │
├──────────────────────────┼──────────────────────────────────┤
│ [缩略图] 多萝西_004.jpg   │ [缩略图] 白发红瞳少女比耶自拍.jpg   │ ✓
│ [缩略图] 多萝西_005.jpg   │ [缩略图] 蓝发少女侧身像.jpg         │ ✓
│ [缩略图] 多萝西_010.jpg   │ [缩略图] 双马尾少女坐姿.jpg         │ ✓
│ [缩略图] 多萝西_002.png   │ [缩略图] 绿发少女立绘.png           │ ✓
├──────────────────────────┴──────────────────────────────────┤
│ [← 返回手动重命名]        [重新生成] [应用重命名]             │
└─────────────────────────────────────────────────────────────┘
```

---

## 技术要点

1. **系统提示词**: 支持用户在设置中配置的系统提示词，会先于任务提示词发送
2. **并发控制**: 逐个处理文件，避免API过载，每个文件间隔100ms
3. **错误处理**: 单个文件失败不影响其他文件，保留原文件名
4. **进度反馈**: 实时显示生成进度（百分比）和每个文件的状态
5. **扩展名保留**: 自动保留原始文件的扩展名

---

## 支持的AI模型

- **OpenAI**: GPT-4o, GPT-4V 等支持视觉的模型
- **Ollama**: LLaVA 等多模态模型
- **LM Studio**: 本地部署的视觉模型

---

## 2026-02-10 更新记录

### 样式修复

#### 1. 缩略图锯齿优化 ([src/components/modals/AIBatchRenameModal.tsx](../src/components/modals/AIBatchRenameModal.tsx))

**优化内容**:
```typescript
<img
  src={item.thumbnailUrl}
  alt={item.file.name}
  className="w-full h-full object-cover"
  style={{
    imageRendering: '-webkit-optimize-contrast',
    transform: 'translateZ(0) scale(1.01)',
    backfaceVisibility: 'hidden',
    willChange: 'transform',
    WebkitFontSmoothing: 'antialiased',
    perspective: '1000px',
  }}
  loading="lazy"
  decoding="async"
/>
```

**新增属性说明**:
- `transform: 'translateZ(0) scale(1.01)'` - 硬件加速 + 轻微放大避免边缘锯齿
- `backfaceVisibility: 'hidden'` - 防止渲染时的闪烁问题
- `willChange: 'transform'` - 提示浏览器优化transform属性
- `WebkitFontSmoothing: 'antialiased'` - 字体平滑
- `perspective: '1000px'` - 3D透视优化
- `loading="lazy"` 和 `decoding="async"` - 异步加载优化

#### 2. 新文件名实时显示修复 ([src/services/aiService.ts](../src/services/aiService.ts) & [src/components/modals/AIBatchRenameModal.tsx](../src/components/modals/AIBatchRenameModal.tsx))

**问题**: 文件名生成后没有实时显示，需要等全部完成后才显示

**修复方案**:
- 修改 `generateFileNames` 方法的 `onProgress` 回调签名，新增 `result?: string` 参数
- 在每个文件处理完成后立即调用回调，传递生成的文件名
- AIBatchRenameModal 中实时更新对应文件项的 `newName`

```typescript
// aiService.ts
async generateFileNames(
  filePaths: string[],
  settings: AppSettings,
  onProgress?: (current: number, total: number, result?: string) => void
): Promise<string[]>

// AIBatchRenameModal.tsx
(current, total, result) => {
  setItems((prev) =>
    prev.map((item, index) => {
      if (index === current - 1 && result) {
        return {
          ...item,
          newName: result,
          status: 'completed'
        };
      }
      // ...
    })
  );
}
```

#### 3. 过渡动画修复 ([src/components/AppModals.tsx](../src/components/AppModals.tsx))

**问题**: 从批量重命名切换到AI批量重命名时，模态框没有过渡动画

**修复方案**: 为模态框组件添加 `key` 属性，强制重新渲染以触发动画

```typescript
{state.activeModal.type === 'batch-rename' && (
  <BatchRenameModalComp
    key="batch-rename"
    // ...
  />
)}

{state.activeModal.type === 'ai-batch-rename' && (
  <AIBatchRenameModalComp
    key="ai-batch-rename"
    // ...
  />
)}
```

---

### 人物信息智能命名功能

#### 功能描述

当使用AI批量重命名时，如果图片包含人物信息（人脸识别数据），AI会在生成的文件名中优先使用人物名称。

**示例**:
- 图片人物信息：`林奈`
- AI原本生成：`少女化妆步骤图.jpg`
- 优化后生成：`林奈化妆步骤图.jpg`

#### 修改文件清单

##### 1. AIBatchRenameModal.tsx

**Props 接口更新**:
```typescript
interface AIBatchRenameModalProps {
  files: FileNode[];
  settings: AppSettings;
  people: Record<string, Person>;  // 新增
  onConfirm: (newNames: Record<string, string>) => void;
  onClose: () => void;
  onBack?: () => void;
  t: (key: string) => string;
}
```

**构建人物信息映射**:
```typescript
// 构建文件路径到人物名称列表的映射
const filePersonMap = new Map<string, string[]>();
items.forEach((item) => {
  const personNames: string[] = [];
  if (item.file.aiData?.faces && item.file.aiData.faces.length > 0) {
    item.file.aiData.faces.forEach((face) => {
      const personName = face.name || people[face.personId]?.name;
      if (personName && personName !== '未知人物' && !personNames.includes(personName)) {
        personNames.push(personName);
      }
    });
  }
  if (personNames.length > 0) {
    filePersonMap.set(item.file.path, personNames);
  }
});
```

##### 2. AppModals.tsx

**传递 people 数据**:
```typescript
<AIBatchRenameModalComp
  key="ai-batch-rename"
  files={activeTab.selectedFileIds.map(id => state.files[id]).filter(Boolean)}
  settings={state.settings}
  people={state.people}  // 新增
  // ...
/>
```

##### 3. aiService.ts

**generateFileNames 方法更新**:
```typescript
async generateFileNames(
  filePaths: string[],
  settings: AppSettings,
  people: Record<string, Person>,           // 新增
  filePersonMap: Map<string, string[]>,     // 新增
  onProgress?: (current: number, total: number, result?: string) => void
): Promise<string[]>
```

**generateSingleFileName 方法更新**:
```typescript
private async generateSingleFileName(
  filePath: string,
  originalName: string,
  settings: AppSettings,
  personNames: string[] = []   // 新增
): Promise<string | null>
```

**提示词更新**:
```typescript
// 构建人物信息提示
const personInfoPrompt = personNames.length > 0
  ? `\n6. 图片中包含以下人物：${personNames.join('、')}，请在文件名中优先使用人物名称（如"${personNames[0]}的..."）`
  : '';

const userPrompt = `请根据这张图片的内容，直接输出一个简洁、描述性的中文文件名。不要思考，不要解释，直接输出文件名。

要求：
1. 文件名应该准确描述图片的主要内容
2. 使用中文，简洁明了（10-20字）
3. 不要包含特殊字符，只使用中文、英文、数字、空格和下划线
4. 直接输出文件名，不要有任何解释、思考过程或额外文字
5. 原文件名是："${nameWithoutExt}"${personInfoPrompt}

请只返回新的文件名（不包含扩展名）：`;
```

---

## 2026-02-10 更新记录 - 单文件 AI 重命名功能

### 功能描述

在右侧详情面板 MetadataPanel 中，为单个图片文件添加 AI 自动命名功能。点击文件名右侧的 Sparkles 图标按钮，AI 会分析图片内容生成新文件名，并显示预览供用户确认。

### 界面预览

#### 单文件 AI 重命名（按钮状态）
```
┌─────────────────────────────────────────┐
│ 文件名文                                │
│ 件名文件名.jpg                    [✨]   │  ← 按钮在最后一行右边
│ 父文件夹名称                             │
└─────────────────────────────────────────┘
```

#### 单文件 AI 重命名（预览状态）
```
┌─────────────────────────────────────────┐
│ 文件名文                                │
│ 件名文件名.jpg                          │
│ 父文件夹名称                             │
│ [绿色圆角矩形: 新文件名.jpg]    [✔] [✕] │  ← 预览在文件名下方
└─────────────────────────────────────────┘
```

### 修改文件清单

#### 1. AI 服务 ([src/services/aiService.ts](../src/services/aiService.ts))

**修改内容**: 将 `generateSingleFileName` 方法从 private 改为 public

```typescript
// 生成文件名 - 单个文件
async generateSingleFileName(
  filePath: string,
  originalName: string,
  settings: AppSettings,
  personNames: string[] = []
): Promise<string | null>
```

#### 2. AI 重命名 Hook ([src/hooks/useAIRename.ts](../src/hooks/useAIRename.ts))

**新建文件**，封装单文件 AI 重命名逻辑：

```typescript
interface UseAIRenameReturn {
  isGenerating: boolean;
  previewName: string | null;
  generateName: (file: FileNode) => Promise<void>;
  applyRename: (file: FileNode) => Promise<void>;
  cancelRename: () => void;
}
```

**特性**:
- 支持生成文件名预览
- 用户确认后才执行实际重命名
- 自动获取人物信息并传递给 AI
- 显示加载状态

#### 3. AI 重命名按钮组件 ([src/components/AIRenameButton.tsx](../src/components/AIRenameButton.tsx))

**新建文件**，仅包含 Sparkles 图标按钮：

```typescript
interface AIRenameButtonProps {
  onClick: () => void;
  isGenerating: boolean;
  t: (key: string) => string;
}
```

**样式**:
- 仅显示 Sparkles 图标（无文字）
- 加载时显示旋转动画
- hover 时变为紫色
- Tooltip 显示 "AI 自动命名"

#### 4. AI 重命名预览组件 ([src/components/AIRenamePreview.tsx](../src/components/AIRenamePreview.tsx))

**新建文件**，显示生成的文件名预览：

```typescript
interface AIRenamePreviewProps {
  previewName: string;
  onApply: () => void;
  onCancel: () => void;
  t: (key: string) => string;
}
```

**特性**:
- 绿色圆角矩形背景
- 长文件名自动换行显示（`break-all`）
- ✔ 按钮（绿色）：确认应用
- ✕ 按钮（灰色）：取消

#### 5. 详情面板 ([src/components/MetadataPanel.tsx](../src/components/MetadataPanel.tsx))

**修改内容**:
1. 添加 `settings` 到 props 接口
2. 导入 `useAIRename` hook 和 AI 重命名组件
3. 在文件名区域使用绝对定位放置按钮（最后一行右边）
4. 在文件名下方显示预览区域

**布局实现**:
```typescript
<div className="relative">
  {/* 文件名，添加 pr-7 避免与按钮重叠 */}
  <div className="font-bold ... break-all pr-7">
    {file?.name}
  </div>
  
  {/* 按钮绝对定位在右下角 */}
  <div className="absolute bottom-0 right-0">
    <AIRenameButton ... />
  </div>
</div>

{/* 预览区域显示在文件名下方 */}
{previewName && (
  <AIRenamePreview ... />
)}
```

#### 6. 主应用 ([src/App.tsx](../src/App.tsx))

**修改内容**: 传递 `settings` 给 MetadataPanel 组件

```typescript
<MetadataPanel
  ...
  settings={state.settings}
/>
```

### 与批量重命名的区别

| 特性 | 单文件重命名 | 批量重命名 |
|------|-------------|-----------|
| 入口位置 | MetadataPanel 文件名右侧 | 批量重命名弹窗中的按钮 |
| 预览方式 | 直接在面板中显示预览 | 在弹窗右侧列表显示 |
| 确认方式 | 单个文件单独确认 | 批量确认 |
| 弹窗 | 无需弹窗 | 需要打开 AI 批量重命名弹窗 |

### 技术要点

1. **组件拆分**: 将功能拆分为独立的 Hook 和组件，避免 MetadataPanel 文件过大
2. **绝对定位**: 使用 `absolute bottom-0 right-0` 将按钮定位在文件名最后一行右边
3. **预览模式**: 先生成文件名预览，用户确认后才执行实际重命名
4. **自动换行**: 使用 `break-all` 确保长文件名可以正确换行显示
5. **人物信息**: 同样支持人物信息优先，如果图片包含人脸识别数据

---

## 后续优化建议

1. 支持批量选择并手动编辑生成的文件名
2. 添加文件名预览功能（显示完整路径）
3. 支持保存常用的AI命名提示词模板
4. 添加命名历史记录功能
5. 支持多人物图片的文件名生成策略（如"林奈和朋友的聚会.jpg"）
