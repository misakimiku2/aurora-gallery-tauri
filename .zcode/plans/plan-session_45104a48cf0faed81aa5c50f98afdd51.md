# 画笔工具 v1：笔刷 + 橡皮 + 空白图层 + 真实前景/背景色 + 锁透明像素

## 核心架构拍板：bake-on-stroke-end（图层保持文件驱动）

现状：`EditorLayer.source` 是文件路径，预览（convertFileSrc）、导出/全览（Rust 读路径）、工程保存（md5 内嵌读路径）、撤销（文档快照存 layers 引用）、剪贴壳 mask-image 全部吃这个路径。

方案：**画笔不改这条链**。落笔时在内存 canvas（图层自然尺寸的像素缓冲）上画，**抬笔时** canvas → PNG（`canvas.toBlob`）→ `plugin-fs writeFile` 写进缓存目录 → `layer.source` 换成新文件路径 → `onDocumentChange`。每笔一个新文件名，旧文件保留 → **撤销/重做天然正确**（快照引用旧路径，文件还在）；原图永不覆盖。

字节通道走已验证的先例（ImageComparer 写 Blob）：**不需要为像素传输新加任何大字节 IPC**。

## A. Rust（最小改动，2 处）

1. `editor_commands.rs`：新命令 `editor_paint_cache_dir() -> String` —— 返回并创建 `%TEMP%/aurora-editor-paint/`（画笔烘焙文件的家）。
2. `editor_open_project` 里现有 `prune_project_cache` 顺带清这个目录（同一 30 天 TTL；正在被 WebView 持有的文件删除失败会被吞掉，现函数已处理）。删除按 mtime，不按打开状态——与工程缓存同一口径。
3. `lib.rs` 桌面端 `generate_handler!` 列表注册新命令（编辑器命令都在桌面表，android 表不动）。

## B. 前端基础设施（3 个新文件，按 §7 防膨胀规则）

1. **`editorColorStore.ts`**：前景/背景色 module store（照 `editorViewStore` 的 subscribe 模式，ImageEditor 与面板两棵子树共用；颜色是会话态**不进文档/撤销**）。初始 黑/白（PS 同款）。快捷键：`D` 复位黑白、`X` 交换（进 useEditorKeyboard）。
2. **`brushPaint.ts`（纯函数，单测）**：
   - `strokeStamps(points, size)`：按 25% 笔径间距在折线上插值出图章点列；
   - `colorLuminance(hex) -> 0..255`：蒙版作画时前景色折灰度（与 Rust mask 的 sRGB 系数同款）；
   - `targetPaintTransform(layer) -> [6]`：目标坐标系换算——画图层 = `inv(M_layer)`；画**链接**蒙版 = `scale(蒙版自然/图层自然) ∘ inv(M_layer)`（蒙版拉伸语义）；画**解链**蒙版 = `inv(M_mask)`。全部复用 `layerTransform` 现有矩阵函数。
3. **`useEditorBrush.ts`（hook）**：笔划的命令式流程——
   - 像素缓冲管理：`Map<sourcePath, HTMLCanvasElement>` + 小 LRU；建缓冲用 `plugin-fs readFile` + `createImageBitmap`（不碰 asset 协议 img，**永不污染 canvas**，toBlob 不炸）；
   - 落笔：`ctx.setTransform(targetPaintTransform(...))` 后以**文档坐标**画圆形图章（径向渐变实现硬度），笔画期间图章先画进**笔划缓冲**（独立 canvas，保证笔画内不叠深），预览层实时镜像；
   - 抬笔：笔划缓冲以笔画不透明度合成进像素缓冲（橡皮 = `destination-out`；锁透明像素 = `source-atop`）→ toBlob(PNG) → 写 `paint-dir/<时间戳-序号>.png` → 换 source → emit；
   - 守卫：组行/无活动层/锁像素层 → flashNotice 提示，不落笔。

## C. 画布与光标（ImageEditor + EditorCanvasLayers）

- **笔划预览 canvas**：挂在 transform 容器内、`isolation` 混合组**外**的兄弟位（absolute、文档尺寸），只负责"正在画"的即时反馈（近似：不参与混合/蒙版，抬笔烘焙后即为精确合成）——已知取舍，记录文档。
- **圆形光标**：brush/eraser 工具下，容器内一个 `pointer-events-none` 的圆环 div 跟随鼠标，直径 = 笔径 × transform.scale（缩放跟随）。
- 指针入口：`onMouseDown` 里在 `effectiveTool !== 'move'` 早退**之前**加 brush/eraser 分支（stopPropagation，Pointer Capture，与移动/裁剪同款模式）。

## D. 选项条 / 面板

- `EditorOptionsBar`：brush/eraser 分支——**大小**（1–300 滑杆+数值）、**硬度**（0–100）、**不透明度**（1–100）、颜色 chip（点开原生 `<input type=color>`）；target=蒙版时颜色 chip 旁显示灰度值与「白=显示 / 黑=隐藏」提示（实际画的是前景色亮度）。橡皮在蒙版上 = 画背景色亮度（PS 口径）。
- `EditorPanel` 颜色区从写死展示变**真控件**：两色块可点开取色器 + 交换按钮 + 提示 D/X；文字更新。
- `EditorPanel` 底栏加**新建空白图层**按钮（PS 位置，加蒙版按钮旁）：先烘焙一张画布尺寸的全透明 PNG 落缓存目录，再插层（source 有路径、box=画布满幅恒等、名字「图层 N」）——空白层从此就是普通像素图层，后续每笔照常烘焙。

## E. 目标路由与锁定语义

- `activeTarget='mask'` 且有蒙版 → 画蒙版（灰度）；否则画图层本体。选中蒙版缩略图后 B 键直接开画蒙版（上一轮做的 target 机制正好用上）。
- **锁透明像素**（面板四格第一格）从灰显变可用：仅对图层本体生效（`source-atop`），橡皮在锁透明像素层上无效（PS：锁透明 = 不能改 alpha）。
- 锁像素 = 禁画（与禁变换同格）；锁位置不影响画笔。

## F. 测试与文档

- vitest：`brushPaint.spec.ts`（图章点列间距/端点、亮度换算与黄金值、三种 target 变换的角点重合——复用 layerTransform 断言风格）；`editorColorStore` 不测（纯状态）；面板/选项条不测（UI）。笔刷引擎本体（canvas 绘制/烘焙）无 jsdom 可测性，走手测清单。
- Rust：`editor_paint_cache_dir` 一条 smoke test（目录创建）；契约无新载荷键，contract 测试不动。
- 全量：前端逐文件 + 全量、core、src-tauri、tsc；进度文档更新（§3.3 画笔行、§4 计数与手测清单、§5 待办勾销、§6 如有新坑）。

## 边界（本轮不做，记录文档）

- 笔刷形状（只有圆形）、流量/喷枪、Shift 拉直线、对称绘画；
- 吸管工具（I）——下一轮接（会把取色写进前景色 store，本轮先给 store）；
- 大画布性能：每笔整层 PNG 烘焙（4000×3000 约 100–300ms/笔）是已知取舍，PS 级增量合成留待性能轮；
- 蒙版作画的撤销粒度 = 一笔一步（与现签名机制天然一致）。

## 改动面清单

新文件 3：`editorColorStore.ts` / `brushPaint.ts` / `useEditorBrush.ts`（+1 spec）。
改动 8：`ImageEditor.tsx`（指针分支+光标+预览层挂载）、`EditorCanvasLayers.tsx`（预览 canvas 槽位）、`EditorOptionsBar.tsx`（brush/eraser 分支）、`EditorPanel.tsx`（颜色区+新建图层按钮）、`useEditorKeyboard.ts`（D/X）、`editorTools.ts`（brush/eraser `available: true`）、`src-tauri/editor_commands.rs`（paint dir 命令+prune）、`lib.rs`（注册）。

做完不提交，等你实测（画图层、画蒙版、橡皮、撤销重做、锁透明像素、空白图层、保存重开再画、导出一致）。