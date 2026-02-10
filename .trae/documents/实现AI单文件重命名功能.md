## 实现计划：在 MetadataPanel 中添加 AI 单文件重命名功能

### 目标
在 MetadataPanel 顶部文件名区域添加一个 AI 自动命名按钮（仅显示 Sparkles 图标），点击后根据图片内容智能生成新文件名。

### 文件结构

由于 MetadataPanel.tsx 已有 2607 行代码，将功能拆分为独立模块：

#### 1. 新建 Hook: `src/hooks/useAIRename.ts`
封装 AI 单文件重命名逻辑：
- `generateSingleFileName()` - 调用 aiService 生成文件名
- `isGenerating` - 加载状态
- 生成后自动执行重命名

#### 2. 新建组件: `src/components/AIRenameButton.tsx`
AI 重命名按钮组件（仅图标）：
- 显示 Sparkles 图标按钮（无文字）
- 点击后调用 AI 生成文件名
- 加载时显示旋转动画
- 生成后自动应用重命名

#### 3. 修改 `src/components/MetadataPanel.tsx`
- 在顶部文件名区域（第1780行附近）添加 AI 重命名图标按钮
- 导入并使用 `useAIRename` hook
- 传递必要的 props（file, settings, people, onUpdate）

### 实现细节

#### AI 重命名流程
1. 用户点击 Sparkles 图标按钮
2. 按钮显示加载状态（旋转动画）
3. 调用 `aiService.generateSingleFileName()`
4. 获取人物信息（如果图片包含人脸识别数据）
5. 生成新文件名后自动应用重命名
6. 调用 `onUpdate` 更新文件状态
7. 显示成功提示

#### UI 位置
在 MetadataPanel 顶部文件名右侧添加图标按钮：
```
┌─────────────────────────────────────┐
│ 文件名.jpg                    [✨]   │
│ 父文件夹名称                         │
└─────────────────────────────────────┘
```

按钮样式：
- 使用 `Sparkles` 图标（lucide-react）
- 尺寸：16px
- 颜色：默认灰色，hover 时变为紫色/主题色
- 无文字标签
- Tooltip 显示 "AI 自动命名"（可选）

### 修改文件清单
1. **新建**: `src/hooks/useAIRename.ts`
2. **新建**: `src/components/AIRenameButton.tsx`
3. **修改**: `src/components/MetadataPanel.tsx`（约 15-20 行）

请确认此计划后，我将开始实施具体的代码修改。