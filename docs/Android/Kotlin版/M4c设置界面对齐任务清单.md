# M4c 设置界面对齐任务清单

> 版本： v1（2026-09-23 执行完成并自验回填）
> 状态： **已达成（2026-09-23 自验 + mobile-ui-tester 黑盒 14 用例）**。D26/D27 已拍板（结论记 §7 行 0）；手机/平板双模拟器实测通过，tester 报告的 5 个问题中 4 个当场修复回验、1 个判定误报（§7 行 4）。
> 前置： [M4b系统集成任务清单](./M4b系统集成任务清单.md) 已达成（2026-09-23）——本里程碑是其设置面板（2.1/2.2/2.3）的形制重构与项目范围终版筛选，能力面（缓存清理/备份导出导入/语言开关）不重做。
> 配套： [规划](./安卓Kotlin版并行开发规划.md)（§6 M4c 行）｜[矩阵](./三端功能矩阵.md)（表 6 三行）｜[M4b 清单](./M4b系统集成任务清单.md)（D15/D19 被本里程碑 D27 部分修订）
> 用途： M4c 的执行记录与决策依据。决策编号接续 **D26/D27**（D21–D25 已被 [M5 画布与比较器任务清单](./M5画布与比较器任务清单.md) 起草占用）。

## 0. 目标与验收（用户需求转译）

- **需求原文**：Kotlin 版设置样式尽可能对齐桌面端（平板）；手机用单独的设置界面；对桌面端设置做一次正式筛选（React 安卓版当年只是 `isAndroid` 简单提炼、未彻底筛干净——主题/folderIconStyle/调试日志等在无对应能力的端上仍残留）。
- **验收标准**：
  1. 平板上设置界面复刻桌面 `SettingsModal` 形制（左分类导航 + 右内容滚动 + 完成按钮，token 取 `AuroraTheme.colors`）；
  2. 手机上是独立的全屏设置页（顶栏返回 + 单列分区，非对话框）；
  3. 桌面设置项逐项给出「搬入/不做/延后」结论并登记（§1 筛选表）；
  4. 主题三档（浅色/深色/跟随系统）真实点亮——`AuroraPalette.dark` 自 M1 起建好但恒未渲染（`MainActivity` 固定 `darkTheme = false`），本次接通全链；
  5. 全部设置变更即时生效 + force-stop 重启不回退；
  6. 手机/平板双模拟器黑盒测试无崩溃（环境同 M4b：avd_ai1 + avd_tab35，heid-tab35 真机未触碰）。

## 1. 桌面设置项筛选结论（D27，终端版）

桌面 `SettingsModal` 七类逐项结论（React 安卓版视角的对照见矩阵表 6 备注）：

| 桌面项 | M4c 结论 | 依据 |
|---|---|---|
| 通用：语言（zh/en） | **已有**（M4b） | collation 联动 M4a 顺延项 |
| 通用：主题 light/dark/system | **搬入（本次点亮暗色档）** | `AuroraPalette.dark` + `AuroraPalettes.of(dark)` 分支 M1 已建；见 §2.2 生效链 |
| 通用：开机自启 / 关闭行为 | 不做 | 桌面专属（D19 原判，维持） |
| 通用：悬停/选中动画开关 | 不做 | Kotlin 无对应卡片动画（D19） |
| 通用：调试日志 | 不做 | Kotlin 无对应开关面（D19） |
| 外观：folderIconStyle | 不做 | Kotlin 无 Folder3DIcon 三形态（D19） |
| 默认布局：视图模式 | **已有**（网格/自适应/瀑布流三档；list 按 React 安卓端先例不做） | `LayoutMode` KDoc |
| 默认布局：排序方式/方向 | **已有**（M4b） | — |
| 默认布局：**默认分组方式** | **搬入（新增字段）** | `GroupBy` 枚举与分组标题渲染 M1 已有、`state.groupBy` 仅运行时——本次补 `defaultGroupBy` 持久化，对齐桌面 `defaultLayoutSettings.groupBy` |
| 存储：图库根目录 | 不做 | 安卓 MediaStore 无此概念 |
| 存储：缓存清理 | **已有**（M4b），形制换卡片 | — |
| 存储：数据备份导出/导入 | **已有**（M4b 字段对齐 React），形制换卡片 | D15 不导出设置本体，维持 |
| 存储：主色调数据库管理 | 延后 M6 | 颜色链路（提取/库/错误文件）归 M6 |
| AI 面板 / 局域网共享面板 | 延后 M6 | D16（M4b）：面板与功能同期 |
| AI 视觉 / 性能两面板 | 不做 | 桌面专属（React 安卓版已隐藏，正式登记） |
| 关于：应用版本 | **搬入（新增「关于」类）** | PackageManager `versionName` |
| 关于：GitHub / Issues 链接 | **搬入** | URL 对齐桌面 `AboutPanel.tsx:224/234` |
| 关于：检查更新 | 不做 | APK 侧载无更新渠道，登记 |
| 关于：致谢 | **搬入** | 一行文案 |

## 2. 执行阶段与结果

### 2.1 数据层（AppSettings/SettingsStore/ViewModel）
- `AppSettings` 加 `theme: String = THEME_SYSTEM`（值对齐桌面 `"light"|"dark"|"system"`）与 `defaultGroupBy: GroupBy = NONE`；`SettingsStore` 加 `theme`/`defaultGroupBy` 两 key（枚举名/字面量存取 + 非法值兜底）。
- `GalleryViewModel`：init 把 `defaultGroupBy` 压进 `state.groupBy`（对齐 defaultLayout/sort 既有做法）；新增 `applyDefaultGroupBy`（落设置 + 即时应用）与 `setTheme`（只落设置，生效链在 MainActivity）。

### 2.2 主题管线（M1「恒浅色」约束的解除）
- **单一推导点**：`MainActivity.isDarkTheme()` 按 `settings.theme` 选档，`"system"` 跟随 `systemDark`（`onConfigurationChanged` 接住——manifest 声明 uiMode configChange 不重建 Activity）。
- **四条同步分支**：① Compose `AuroraTheme(darkTheme = dark)`；② 窗口层 `applyWindowTheme`（窗口底色 = `palette.content`，冷启动首帧前先上好防深色闪白；状态栏图标深浅随档——XML 主题 Material.Light 仅作进程兜底，M1 的「必须与 XML 一致」约束由窗口底色同步根除）；③ 网格 `FileGridAdapter.applyThemeColors`（构造色 var 化 + 无变化 no-op + `notifyDataSetChanged`，attach 视图的重刷落点：文件名=applySelectedName、封面占位底=bindPhoto、分组标题=bindHeader，sticky 条由 `restyleStickyHeader` 重刷含 content 底色）；`FoldersOverview.FolderAdapter` 同款三色路径；④ 查看器 `applyViewerTheme` 写 `ViewerLayer` 的 options（每次 open 生效；**开着不重开**为已知边界，收掉再开即换色）。
- 深色档在总览/文件夹网格/设置页/侧栏/弹层全链实测换装正确；浅色状态栏底深图标（手机截图核对无误）。

### 2.3 设置 UI（`SettingsDialog.kt` 整体重写，入口 `SettingsHost`）
- 双形态断点：`screenWidthDp >= 600 && screenHeightDp >= 480` → 平板桌面式双栏对话框（宽 ≤720dp、高 屏高−120dp 上限扣系统栏、左导航 200dp panel 底 + 完成 按钮）；否则手机全屏页（顶栏返回 + 单列滚动 + `BackHandler` 关闭）。**断点必须带高度**：横屏手机（宽 923dp×高 411dp）实测放不下对话框（底部溢出），归全屏页形态。
- 分类只渲染已实现三类（通用/存储/关于，枚举 `SettingsCategory`），平板右栏与手机单列共用同一 `CategoryContent`；选项芯片样式对齐桌面 `bg-blue-500/15 text-blue-600`；节标题对齐 `text-lg font-bold border-subtle pb-2`。
- 关于类（新增）：版本徽标（PackageManager）、GitHub/Issues 行（`openExternalUrl` + 失败 Toast）、致谢。

### 2.4 宿主
- `MainActivity` 设置块换 `SettingsHost`；`appVersion`（lazy）与 `openExternalUrl` 落宿主；手机页返回链组合序在主返回链之后（BACK 先关设置页，实测未穿透退出应用）。
- **横屏手机第三形态兜底**（tester 发现的死角）：横屏手机侧栏固定 Section 总高超屏、底部「设置」行被裁切不可达（M2 侧栏结构封版不动刀）——`TopBar` 加可选 `onOpenSettings`（lucide settings-2 图标），仅 `isLandscapePhone`（宽 ≥600 且高 <480）传入渲染。

### 2.5 测试与修复回填
- 自测（双模拟器）：主题三档即时切换、双端重启持久化、默认分组→类型重启后进 bulk 直接带分组、手机 BACK 关设置页、平板双栏对话框分类切换/完成/遮罩关闭。
- mobile-ui-tester 黑盒 14 用例（手机 8 + 平板 6）：0 崩溃 0 ANR；5 个问题见 §7 行 4 处置。
- 顺手修复的 M1 遗留：`StickyHeaderDecoration` 在列表顶端与行内标题叠加出双标题——锚定组行内标题完整露在吸顶线以下时不再绘制 sticky（滚动后照常接管，实测回验）。

## 6. 决策表

| 编号 | 决策 | 结论 |
|---|---|---|
| **D26** | 设置界面双形态与断点 | 平板（宽 ≥600dp 且高 ≥480dp）= 桌面式双栏对话框；手机 = 全屏设置页；**横屏手机走手机形态**，设置入口挂顶栏兜底（侧栏 M2 结构不动）。断点沿用仓库 `screenWidthDp >= 600` 惯例并补高度条件 |
| **D27** | 设置项目范围终版（修订 D19） | **搬入**：主题三档（点亮 `AuroraPalette.dark`，M1 恒浅色约束解除）+ 默认分组持久化 + 关于类（版本/链接/致谢）；**维持不做**（D19 原判）：自启动/退出行为/folderIconStyle/动画开关/调试日志；**新增不做**：检查更新（无渠道）；**延后**：主色调管理（M6 颜色链路）、AI/LAN 面板（D16 不变） |

## 7. 验收记录

- **行 0（决策结论）**：D26/D27 按 §6 拍板（2026-09-23，验收人口头需求「平板对齐桌面、手机单独、颜色主题也要弄」转译）。
- **行 1（主题三档）**：PASS——深/浅/跟随系统三档即时生效（页面+窗口底色+状态栏图标），force-stop 重启保持；`跟随系统` 在系统浅色下显示浅色（`cmd uimode night` = no）。
- **行 2（双形态）**：PASS——平板双栏对话框（分类切换/完成/遮罩关闭/独立滚动）；手机全屏页（分区卡片/BACK 关闭/返回后滚动位置保留）；横屏手机 = 全屏页 + 顶栏齿轮入口。
- **行 3（功能回归）**：PASS——语言/默认视图/排序/方向/分组芯片即时应用；清理缓存 Toast + 数值刷新；导出落 Download；GitHub 行拉起浏览器返回不丢状态；默认分组持久化（重启进 bulk 直带分组标题）。
- **行 4（tester 报告处置）**：5 问题——①横屏手机侧栏设置入口裁切（高）：TopBar 兜底入口，修；②横屏对话框底部溢出（高）：断点补高度条件 + 对话框高度上限扣系统栏，修；③分组表头顶部重复（中）：StickyHeaderDecoration 顶端不画，修；④手机浅色状态栏不变色（中）：**误报**（截图核对为浅底深字，正确）；⑤缓存值「=」前缀（低）：改「约」，修。
- **行 5（遗留）**：①查看器开着时切主题不即时换色（收掉再开生效，D26 边界登记）；②M5 占用 D21–D25 起草编号、未拍板——后续里程碑起草先查本清单尾号。
