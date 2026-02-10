## 问题分析与修复计划

### 问题1: 缩略图锯齿问题
当前代码使用了 `imageRendering: '-webkit-optimize-contrast'` 和 `transform: 'translateZ(0)'`，但锯齿问题仍然存在。

**修复方案**:
- 添加更多CSS优化属性：`imageRendering: 'crisp-edges'` 作为备选
- 添加 `backfaceVisibility: 'hidden'` 防止渲染问题
- 确保图片容器有明确的尺寸和 `overflow: hidden`
- 考虑添加 `will-change: transform` 优化渲染

### 问题2: 新文件名实时显示问题
查看 `aiService.ts` 的 `generateFileNames` 方法，发现 `onProgress` 回调只传递进度信息，但生成的文件名是在所有文件处理完成后才一次性更新到状态。

**修复方案**:
- 修改 `generateFileNames` 方法，在 `onProgress` 回调中同时返回当前生成的文件名
- 修改回调函数签名：`onProgress?: (current: number, total: number, result?: string) => void`
- 在 AIBatchRenameModal.tsx 中实时更新每个文件的新文件名

### 问题3: 过渡效果问题
从批量重命名切换到AI批量重命名时，两个模态框都在同一个 overlay 容器中，React 只是简单地切换组件，没有重新创建 overlay，导致没有过渡动画。

**修复方案**:
- 在 AppModals.tsx 中为 AI 批量重命名模态框添加 `key` 属性，强制重新渲染
- 或者添加一个短暂的延迟/状态切换来触发过渡动画
- 更好的方案：给模态框容器添加 `key={state.activeModal.type}` 确保类型变化时重新渲染

### 修改文件清单

1. **src/services/aiService.ts** - 修改 `generateFileNames` 方法支持实时返回结果
2. **src/components/modals/AIBatchRenameModal.tsx** - 
   - 修复缩略图锯齿问题
   - 修复实时显示新文件名问题
3. **src/components/AppModals.tsx** - 修复过渡动画问题

请确认这个计划后，我将开始实施具体的修改。