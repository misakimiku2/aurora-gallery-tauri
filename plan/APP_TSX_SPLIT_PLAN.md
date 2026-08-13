# App.tsx 拆分设计方案（供下一会话直接执行）

> 本文档是**自包含**的：下一个会话的 AI 只需阅读本文件即可了解项目现状与本任务的全部要求。
> 生成时间：2026-08-13。提交本方案前的 HEAD：`c3359f3`。

---

## 一、项目现状快照（执行前必读）

### 基本信息
- 项目路径：`C:\Users\Misaki\Desktop\git\aurora-gallery-tauri`
- 技术栈：Tauri 2 + React 18 + TypeScript 5（strict）+ Vite 5 + Tailwind 3
- 用户**不懂技术**：任何改动完成后，需要给用户一份简单的冒烟测试清单（见 `docs/TESTING_GUIDE.md`，已存在）

### 关键命令（工作目录 = 项目根目录）
| 命令 | 作用 |
|---|---|
| `npx tsc --noEmit` | 类型检查（必须 0 错误） |
| `npm run build` | tsc + vite 构建（必须成功） |
| `npx vitest run` | 单元测试（当前基线 **39 passed / 7 files**） |
| `npm run build:lan-share` | 局域网 Web 客户端构建（输出到 src-tauri/static/lan-share/） |
| `npm run tauri:dev` | 启动桌面应用（开发模式，Rust 增量编译） |

### 最近的架构变化（重要，避免重复劳动）
1. **`src/api/tauri-bridge.ts`（3175 行）已拆分为目录** `src/api/tauri-bridge/`：14 个领域模块（files/thumbnail/color/db/clip/lan/updater/window/platform/search/drag/color_db/state/index），`index.ts` 用 `export *` 聚合。**所有 `import ... from '../api/tauri-bridge'` 路径不变**，新增 API 时按领域放进对应模块（如系统命令放 `platform.ts`）。
2. 日志体系已完善：Rust + 前端日志都写入 `%LOCALAPPDATA%\com.aurora.gallery\logs\Aurora Gallery.log`（5MB 自动轮转）；设置 → 关于 → "打开日志文件夹"按钮可用；前端 `utils/logger.ts` 生产环境只转发 warn/error。
3. `scripts/clean.ps1` 已脚本化（`npm run clean` 不删 Rust 编译缓存；`npm run clean:full` 才删）。
4. CI 已配置：`.github/workflows/ci.yml`（push/PR 时自动跑 tsc + build + build:lan-share + vitest）。
5. 测试基线：`src/utils/__tests__/` 下有 6 个测试文件（pathUtils/debounce/colorUtils/textUtils/thumbnailCache/translations）+ 1 个组件测试（`src/components/__tests__/EmptyFolderPlaceholder.spec.tsx`）。

### 代码风格约定
- import 以**相对路径**为主（如 `'./api/tauri-bridge'`、`'../types'`）；`@/` 别名可用但项目内少用，跟随现有风格
- 注释为中文，保留原注释
- 提交信息格式：`refactor(app): ...`（中文描述，参考 git log 历史风格）

---

## 二、App.tsx 现状分析（实测数据）

### 规模
- **3433 行**（`src/App.tsx`），其中 `App` 组件从 97 行开始，`return (` 在 2967 行，JSX 区约 890 行

### 组件内部组成统计
- `useState` × 21（state 主体在 101 行 + 21 个零散 state：hoverPlayingId、tagSearchQuery、personSortBy、toolbarQuery、groupBy、topicLayoutMode、folderLayoutMode、lanRoots、lanLoading、lanConnected、isUploading 等）
- `useRef` × 17、`useEffect` × 34、`useCallback` × 48、`useMemo` × 6
- 已抽取的自定义 hooks（**不要再重复抽**）：useToasts、useWindowLifecycle、useTasks、useFileSelection、useDirectoryScan、useAIAnalysis、useFolderSettings、useNavigation、useKeyboardShortcuts、useMarqueeSelection、useAppInit、useSearch、usePeople、useTopics、useTags、useUpdateCheck、useFileSearch、useContextMenu、useFileOperations、usePersistence、useTasks（均在 `src/hooks/`）

### 结构分区
```
1-95     imports（注意：43-50 行之间还混着一组 import —— 历史拼贴痕迹，需上移到顶部）
97-320   App 组件开始：state 主体（101 行 useState<AppState>）+ 21 个 useState + refs
320-2700 handler 编排区：48 个 useCallback + 34 个 useEffect + 大量普通 const 函数
         （handle* 系列：文件、视图、导航、标签页、人物、专题、LAN、更新、拖拽等）
2700-2960 剩余 handler + 全局事件监听 effect（window.addEventListener 等）
2967-3857 JSX 渲染区（约 890 行）
```

### JSX 区组成（2967-3857，全部渲染**已存在的组件**，不是内联 UI）
| 块 | 行号 | 说明 |
|---|---|---|
| SplashScreen | 2977 | 现成组件 |
| LAN 下载进度遮罩 | 2980-2998 | **内联 JSX**（可提取） |
| DragDropOverlay | 3001-3008 | 现成组件 |
| SVG filters | 3011 | **内联 JSX**（纯静态，可提取） |
| TabBar | 3013-3028 | 现成组件，但 `onCloseWindow` 是**内联回调**（可提取） |
| 主内容区 | 3029-3850 | Sidebar（3040，**单行超长 props**）+ 中央区（ImageViewer/FileGrid/FoldersOverview/TopicModule）+ 右侧（MetadataPanel/MobileColorPickerSheet）+ ImageComparer + AndroidSelectionBar + ContextMenu + AppModals + GlobalToasts + TaskProgressModal |

### 核心结论
App.tsx **已经**是"状态 + handler 编排 + 组件组装"三层结构，大组件都已在 `src/components/` 存在。剩余工作本质是：
1. 把 JSX 组装层拆成子组件（大幅减行）
2. 把 handler 编排层按领域提取为自定义 hooks（可选、高风险）

---

## 三、拆分目标与铁律

### 目标
App.tsx 从 3433 行降到 **~1500 行以内**（阶段 2 完成即可达 ~2000 行，阶段 3 完成可达目标）。

### 铁律（违反即失败）
1. **零行为变化**：只移动代码，不改变任何逻辑、UI 结构、样式类名、事件顺序
2. **逐步提交**：每完成一个阶段，跑验证并提交一个 commit；不跨阶段混提交
3. **每阶段三验证**：`npx tsc --noEmit`（0 错误）→ `npm run build` → `npx vitest run`（39 passed）
4. **不做顺手重构**：不重命名变量、不调整样式、不引入新依赖（zustand/redux 等禁止）、不改变状态管理方式
5. **不碰其他模块**：只改 `src/App.tsx` 和新建文件；如需改 `src/components/` 下的现成组件，必须先说明理由

---

## 四、分阶段方案

### 阶段 1：文件内整理（低风险，预计 -200 行）
**目标**：消除拼贴痕迹，提取纯函数/常量。
1. 把 43-50 行之间混入的 import 上移到文件顶部 import 区
2. 提取剩余模块级纯函数/常量（如 `LAN_ROOT_IMAGES_ID`）到 `src/constants.ts`（已有此文件）或就近
3. 检查 `getInitialLayout`（98 行附近）等函数：若是纯函数（只读 localStorage、无组件依赖），提取到 `src/utils/`（如 `src/utils/layoutSettings.ts`）
4. 提取 JSX 区中**纯静态内联块**：
   - SVG filters（3011 行，一行大字符串）→ `src/components/SvgColorFilters.tsx`（无 props）
   - LAN 下载进度遮罩（2980-2998）→ `src/components/LanDownloadOverlay.tsx`（props：`{ progress: { active, completed, total }, t }`）
5. 验证 + 提交

### 阶段 2：JSX 组装层子组件化（中风险，预计 -600~-800 行）
**目标**：把 return 里的大块 JSX 抽成子组件，props 精确类型化。
推荐新建 `src/components/app/` 目录，按块拆分：

| 新组件 | 来源 | props 来源 |
|---|---|---|
| `AppShell.tsx`（可选，如 JSX 顶层结构简单可跳过） | 2968-2975 外层 div + 事件 | 现有 on* 事件 |
| `TabBarWrapper.tsx` | 3013-3028 | tabs/activeTabId/files/topics/people/onSwitchTab/onCloseTab/onNewTab/onContextMenu/t/showWindowControls/isReferenceMode/onHoverChange/onCloseWindow |
| `MainWorkspace.tsx` | 3029-3850（主内容区） | 见下 |
| `SidebarPane.tsx` | 3032-3042（Sidebar 外层布局） | roots/files/people/customTags/.../t（**注意：3040 行 Sidebar 的 props 有约 40 个**，可先原样搬移到一个 props 接口） |
| `CentralView.tsx` | 中央区（ImageViewer/FileGrid/FoldersOverview/TopicModule 切换） | 视分析结果 |
| `RightPanel.tsx` | MetadataPanel/MobileColorPickerSheet 区域 | 视分析结果 |

**方法（重要）**：
1. 先在 App.tsx 中把目标 JSX 块**原样复制**到新组件文件
2. 新组件 props 接口 = 该 JSX 块中引用的所有外部标识符（state 字段、handler、refs 的回调、t 函数）
3. 用 `src/types.ts` 的现有类型（AppState/FileNode/Topic/Person/AppSettings 等），**不要新造重复类型**
4. App.tsx 中该块替换为 `<新组件 {...props} />`，行数立即大减
5. 每拆一个块就运行 `npx tsc --noEmit` 检查，全部拆完再跑完整验证
6. **巨型 props 行（如 3040 行 Sidebar）允许先搬移成多行，但不要改 props 名称和含义**

**注意**：若某个块内部引用了 10+ 个 handler 且难以类型化，可跳过该块，优先拆 props 少的块（SVG filters、LAN 遮罩、SplashScreen 包装、TabBar 包装）。

### 阶段 3：handler 编排层提取 hooks（高风险，可选，建议单独一轮做）
**目标**：按领域把 handler 分组提取为自定义 hooks，App.tsx 降到 1500 行以内。
候选分组（按行号区域，执行时以实际为准）：
- `useLanClientSync`：LAN 相关（lanRoots/lanLoading/lanConnected/lanDownloadProgress + 对应 effect/retry/heartbeat，约 800-1200 行区域）
- `useViewerHandlers`：查看器相关（handleViewerNavigate/handleViewerJump/closeViewer 等）
- `useTabHandlers`：标签页（handleSwitchTab/handleCloseTab/handleNewTab/closeAllTabs 等）
- `usePersonTopicHandlers`：人物/专题筛选与导航
- `useExternalDragDrop`：拖拽（若现有 `src/hooks/useExternalDragDrop.ts` 不够用则扩展现有，不新建）

**方法**：
1. 每个 hook 接收 `(state, setState, refs, t, ...依赖回调)` 或更细粒度的参数
2. **useCallback 的依赖数组必须原样保留**（闭包陷阱：漏依赖 = 行为变化）
3. effect 的清理函数（return () => ...）必须一并搬移
4. 若两个 handler 互相调用，放在同一个 hook 或通过参数传入

### 阶段 4（远期，不建议本轮做）
- 状态管理重构（useReducer/外部 store）：**禁止**，理由：收益不确定、风险高、用户无法自行验证

---

## 五、每阶段验收清单（自动化）

```bash
npx tsc --noEmit        # 必须 0 错误
npm run build           # 必须成功
npx vitest run          # 必须 39 passed (7 files)
npm run build:lan-share # 必须成功（阶段 2/3 涉及共享代码时跑）
```
完成后向用户报告：App.tsx 行数变化（用 `(Get-Content src/App.tsx | Measure-Object -Line).Lines` 统计）、每个 commit、以及请用户做冒烟测试（让用户跑 `npm run tauri:dev`，然后按 `docs/TESTING_GUIDE.md` 第 3 节清单点一遍）。

---

## 六、风险与注意事项（踩坑预警）

1. **React StrictMode**（`src/main.tsx` 中启用）：dev 模式下 useEffect 会双调用，拆分时**不要**因"看起来重复"而删 effect
2. **闭包陷阱**：所有 handler/effect 的依赖数组（useCallback/useEffect 第二参数）**逐字照抄**，这是行为不变的关键
3. **React.memo**：被 memo 的子组件，其 props 中函数必须保持稳定引用（原 useCallback 不要改成普通函数）
4. **循环依赖**：新文件只依赖 `src/types.ts`、`src/api/tauri-bridge/`、`src/hooks/`、`src/components/` 中已有的低层模块，**绝不允许 import App.tsx**
5. **中间 import**（43-50 行）：阶段 1 必须处理，否则后续拆分容易混淆
6. **类型安全**：tsconfig 是 `strict: true`，新组件 props 必须精确类型；允许先用 `Partial<...>`/`Pick<...>` 缩小现有类型，禁止 `any` 泛滥
7. **样式**：className 原样搬移，任何"看起来可以简化"的类名都不许动
8. **提交粒度**：每阶段一个 commit，message 示例：`refactor(app): 拆分 JSX 组装层为子组件（阶段 2）`；若中途发现必须回退，用 `git checkout -- src/App.tsx` 恢复后重做（App.tsx 大，建议每拆一块手动 `git add` 一次？不——按阶段提交即可，但每拆一块跑一次 tsc）
9. **时间预期**：阶段 1 约 30 分钟，阶段 2 约 1-2 小时（类型化 props 是主要耗时），阶段 3 约 2-4 小时。若会话时间有限，完成阶段 1+2 即可交付（App.tsx ≈ 2000 行），阶段 3 可明确告知用户留待后续
10. **如果卡住**：优先跳过该块（阶段 2 的跳过策略），先交付已完成部分；不要为了拆一块而修改现成组件的接口

---

## 七、给执行 AI 的起始步骤（照做）

1. 阅读本文件 + `src/App.tsx` + `src/types.ts` + `src/hooks/` 目录清单 + `docs/TESTING_GUIDE.md`
2. `git status` 确认工作区干净；`git log --oneline -3` 确认 HEAD
3. 跑基线：`npx vitest run` 和 `npx tsc --noEmit`（必须全绿，确认基线正常再动手）
4. 记录 App.tsx 当前行数（3433）
5. 按第四节阶段 1 → 2 → 3 顺序执行；每阶段完成后跑第五节验收命令并提交
6. 全部完成后向用户报告（用通俗语言）：
   - 行数变化：3433 → XXX
   - 拆出了哪些文件
   - 请用户做的测试（`npm run tauri:dev` + 冒烟清单）
   - 未完成的部分（如有）与原因
