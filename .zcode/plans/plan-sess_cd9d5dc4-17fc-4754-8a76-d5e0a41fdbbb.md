# M4c：Kotlin 设置界面对齐桌面端（平板双栏 / 手机独立页）

## 背景

当前 `SettingsDialog.kt` 是 Material3 默认样式的居中小对话框（单列滚动、5 个设置项），与桌面端 900px 左分类导航 + 右内容面板的 `SettingsModal` 差距大。目标：**平板（≥600dp）复刻桌面端双栏形制，手机用独立全屏设置页**；同时对桌面设置项做一次正式筛选（React 安卓版当年没筛干净，Kotlin 版这次筛清楚并登记）。

## 一、桌面设置项筛选结论（本次范围）

**搬入（通用类）**：语言、默认布局（网格/自适应/瀑布流——list 按既有决定不做）、默认排序、排序方向，+ **新增「默认分组方式」（无/类型/日期）**：`GroupBy` 枚举与分组标题渲染在 M1 已存在（`GridModels.kt` buildGridItems），`state.groupBy` 现由 TopBar 菜单运行时控制但不持久化——补 `defaultGroupBy` 持久化字段即可端到端。

**搬入（存储类）**：清理缓存（含大小显示）、备份导出/导入（维持 M4b 字段对齐 React 的实现，只换形制）。

**搬入（关于类，新增）**：应用版本（PackageManager 取 versionName）、GitHub 仓库/Issues 链接（Intent 打开，URL 对齐桌面 `AboutPanel.tsx`）、致谢文案。检查更新不做（APK 侧载无更新渠道，登记）。

**不搬（沿用 D19 登记）**：主题暗色（Kotlin 恒浅色，M1 决定）、开机自启/关闭行为（桌面专属）、folderIconStyle、动画开关、调试日志。

**延后**：主色调提取与数据库管理（颜色链路归 M6，ScanNotifier.kt:15 已登记）、AI / 局域网共享面板（D16 归 M6，届时分类导航直接加项）。

## 二、双形态设计

- **断点**：沿用仓库既有 `screenWidthDp >= 600` 惯例（FileGrid/FoldersOverview 同款）。
- **平板（≥600dp）**：`Dialog(usePlatformDefaultWidth=false)` + 自绘 Surface 复刻桌面 SettingsModal——整体 `rounded 16dp`，左侧分类导航（panel 底色，宽约 200dp：「设置」标题行 + 分类行，选中态 primary 15% 底 + primary 字，底部「完成」按钮）+ 右侧内容区（content 底色、verticalScroll、24dp 内边距）。高宽对齐桌面比例：宽 min(屏宽−64dp, 720dp)、高 屏高−120dp 且 ≥400dp。
- **手机（<600dp）**：独立全屏页——content 底色 + 顶栏（返回箭头 + 「设置」标题）+ 单列滚动（同套分区卡片内容，行高 ≥48dp 触屏目标）；`BackHandler(enabled = showSettings)` 关闭页面（组合顺序放在既有返回链之后，仅 showSettings 时启用）。
- 分类导航只渲染已实现的类：通用 / 存储 / 关于（AI、局域网共享 M6 加）。分类内容区结构对齐桌面：通用类内分「通用」「默认布局」两节，节标题样式对齐桌面（粗体 + 底部分隔线感）、设置行包 `surface 底 + border + rounded 12dp` 卡片。
- 侧栏「设置」入口不动（TreeSidebar 底部，M4b 已定）。

## 三、实现步骤

1. **数据层**：`state/AppSettings.kt` 加 `defaultGroupBy: GroupBy = NONE` + SettingsStore key（枚举名存取）；`GalleryViewModel` 启动时把 `settings.defaultGroupBy` 压进 `state.groupBy`（对齐 161-163 行现有 defaultLayout/sort 做法），新增 `applyDefaultGroupBy` 写入口。
2. **UI 层**：重写 `ui/components/SettingsDialog.kt` → 保留文件名，内容改为：共享构建块（Section/Row/Choice/Action，样式对齐桌面 token：panel/content/surface/subtle/primary 全部取自 AuroraTheme.colors）+ 三个内容组件（GeneralContent / StorageContent / AboutContent）+ `SettingsHost`（内部按断点切平板双栏 Dialog / 手机全屏页）。
3. **宿主**：`MainActivity.kt` 894-907 的 `if (showSettings)` 块替换为 `SettingsHost(...)`；传 versionName、链接常量；手机页 BackHandler 就位。回调签名基本不变（新增 onDefaultGroupByChange）。
4. **文档**（按 §8.2 惯例）：新建 `docs/Android/Kotlin版/M4c设置界面对齐任务清单.md`（含新决策 D21 双形态断点、D22 项目筛选终版登记）；矩阵表 6 更新 Kotlin 列（通用/存储行 + 关于行）；规划 §6 加 M4c 行；README 里程碑状态表加 M4c。
5. **提交**：沿用 `M4c-<阶段>: <说明>` 格式分阶段提交。

## 四、验证（按用户测试偏好：手机+平板模拟器同开）

- avd_ai1（手机）+ avd_tab35（平板）分别构建安装（heid-tab35 真机不碰）。
- 平板：设置对话框双栏截图与桌面端逐区对比（导航选中态/卡片/间距）。
- 手机：全屏页开合、系统返回键关闭、各项可点、触控目标 ≥48dp。
- 功能：默认分组设为「类型」→ 杀进程重启 → 网格带分组标题；语言切换、缓存清理、备份导出导入回归；旋转后形态正确切换。

## 不改的东西

- 暗色主题、桌面专属项维持 D19 不做；AI/LAN 面板留 M6（D16）；SettingsStore 备份 JSON 字段不动（D15）。
- 界面文案维持 Kotlin 端现状（硬编码中文，与 TopBar/侧栏一致，不引入 i18n 层）。