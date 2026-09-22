# M4b 系统集成任务清单

> 版本： v1（2026-09-22 起草；同日经代码核对——Kotlin 侧占位与挂载点、React/Rust 侧同位功能均逐条核过，引用见各任务行）
> 状态： **待开工**。§6 的 D15–D20 六个决策点未拍板，其中 D16/D17 有像 M4a 4.2 那样拍成「改期/缩水」的可能，**开工前先拍板**；阶段 1（文件操作）不受 D16/D17 影响，拍完 D15/D18/D20 即可动工。
> 前置： [M4a 数据与整理任务清单](./M4a数据与整理任务清单.md) 已封版（2026-09-22，v15）；本文档延续其 §8 的全部交接要点（测试环境 aurora35、FFI 链条、平板冻结坑等，不重复抄录）。
> 配套： [规划](./安卓Kotlin版并行开发规划.md)（§6 M4b 行与「安卓本地库的完整文件操作」决策记录五要点、§5.3）｜[矩阵](./三端功能矩阵.md)（表 6 全表、表 3 删除/移动/复制行、表 1 搜索行、表 2 FolderSection/CanvasSection 行）｜[M1 清单](./M1任务清单.md)（§7 行 364 = 改 FFI 的完整链条；4.2 删除的 `createDeleteRequest` 先例）
> 用途： M4b 的小步执行清单。每完成一个小任务更新对应行的状态。

## 0. M4b 目标与验收（来自规划 §6）

- **范围（规划 §6 M4b 行原文五块）**：设置三个面板（通用/存储扫描/LAN+AI）；任务进度通知；状态栏与全局沉浸补全；画布入口；**安卓本地库的完整文件操作（重命名/移动/复制/新建相册，删除 M1 已达成）**。
- **M4a 顺延下来的散项（散落在 M4a 清单 §7/§8，本轮统一收口）**：
  1. **语言开关**：`GalleryViewModel.kt:803` 的 `TAG_LOCALE` 恒 `"zh"`（注释明说「语言开关随 M4b 的设置面板才存在」）；落语言开关时按 M4a 1.3 的三档判据把 `en` 档实测差异（真实标签库 5/665 位置、全部 Z 组）记进矩阵；
  2. **查看器重命名**：`updatesJson` 的第四个键 `name` 在 `MainActivity.kt:210-214` 走「重命名 M4b」Toast——它改的是 MediaStore `DISPLAY_NAME`、不是元数据行（M4a 2.1 拍板的归属）；
  3. **查看器复制/移动**：`MainActivity.kt:223-226` 的 `onCopyToFolder` / `onMoveToFolder` / `onFolderPickerConfirm` 三条 Toast；查看器「更多」菜单的两个菜单项**已存在**（`NativeGalleryView.kt:1826-1827`），`FolderPickerDialog` 也已随 M3 搬入（`NativeGalleryView.kt:1800`，收 `folderTreeJson`）——**UI 半成品已就位，缺的只是数据源与 confirm 落地**；
  4. **网格选中集菜单补 M4b 项**：`MainActivity.kt:685-688` 注释写明「复制/移动/重命名归 M4b，M4b 时出现」（M4a 4.3 按「不适用的项直接不出现」先例隐藏）；
  5. **文件夹卡片长按菜单**：M4a §7 4.3 行明确改期 M4b（桌面同位项复制/移动/重命名/缩略图全在 M4b 线）；现状 `onFolderCardLongPress`（`MainActivity.kt:753-758`）只有进选择/范围选择两个分支；总览选择栏「更多」还停在 Toast（`MainActivity.kt:833`）；
  6. **三条死接口占位的去留**：`NativeGalleryView.Listener` 的 `onMore`（`:79`）/ `onEditTags`（`:87`）/ `onLongPress`（`:89`）三个回调（宿主 Toast `MainActivity.kt:184-186`）**无任何调用方**（M4a 5 验收确认），M4b 决定删或接；
  7. **专题 fileCount 与 getTopicFiles 不同步**：M4a 5 验收的遗留观察（aurora35 上 0 vs 5 偏小、平板上 2 vs 1 偏大，两方向都出现过），本轮 1.2 碰数据层时顺手核对。
- **验收标准（硬指标，照规划 §6 M4b 行原文）**：矩阵表 6 标注 M4 的条目全部达成；**画布入口可点进（视图本体仍属 M5）**；**矩阵表 3「删除/移动/复制」行的 Kotlin 列全部达成**。
- **文件操作主链路的具体判据（把上面第二条展开）**：选中若干图 → 复制到已有相册/新相册 → 目标相册出现副本且**副本带着原标签**（规划五要点④）→ 重命名其中一张 → 元数据仍挂在改名后的那张上（五要点②）→ 移动到另一相册 → 两侧相册计数与归属都变（五要点③）→ **force-stop 重启全部还在**；移动过系统授权弹窗、复制不过（五要点①②的不对称要在 UI 上可感知）。
- **明确不做**：回收站（2026-09-21 拍板，两端一致）；LAN 客户端/AI 任务的功能本体（M6，面板归属见 D16）；画布视图本体（M5）；颜色搜索与主色调提取（M6，v15 备忘）；回收站式 trash API（`createTrashRequest` 不用）；空目录的 SAF / `MANAGE_EXTERNAL_STORAGE` 路线（规划 §6 决策记录⑤已否决）。
- **测试环境**：延续 M4a v15 的拍板——统一 **aurora35 模拟器**（`heid-tab35` 照旧别碰），平板真机复核随验收人安排。文件操作的系统授权弹窗在模拟器上可完整走通；多文件夹/多图测试数据用 `/sdcard/Pictures/bulk/`（60 张）+ `m3test/`，不够再 `adb push`。

## 1. 拆分原则（延续 M4a §1，另加文件操作特有两条）

- 延续项全部有效：一次任务一次提交带任务号（`M4b-1.1: ...`）；每步模拟器跑通且**确认跑的是新路径**再提交；颜色只取 `AuroraPalette.kt`；弹层一律复用 TopBar 的 Aurora 系菜单组件（M4a 3.3 教训：别起 material3 DropdownMenu 第二套）；UI 只消费数据层算好的结构。
- **桌面 `file_operations.rs` 的实现一行都不抄**：`rename_file:314` / `copy_file:540` / `move_file:674` 全是文件系统语义 + 路径哈希 `file_id` 的元数据迁移；安卓是 MediaStore + `generate_id(content_uri)`，**规划 §6 决策记录明说「不同源不可复用」**。能搬的只有**操作后的 db 联动语义**（哪些表哪些列要跟上），且五要点②已裁定安卓侧重命名/移动**不需要**桌面那套 `migrate_metadata`。
- **授权不对称要进 UI 而不只是代码**：复制静默完成（insert 新行、App 拥有新行，只要读权限）；移动/重命名必须过 `createWriteRequest` 系统弹窗（改已有行）——多选操作攒成**一次**请求，别一个文件弹一次（规划五要点①）。UI 上复制不必预警、移动要可预期（弹窗来自系统，App 侧文案别替系统说话）。

## 2. 依赖关系图

```
阶段 0 决策拍板（D15–D20）＋矩阵表 6 行标注（随本清单起草已拆，见矩阵 v5）

1.1 MediaStore 写原语＋批量授权 ── 1.2 索引联动（含 generate_id 导出＋FFI 重编）── 1.3 新建相册
        │                                        │
        └──────── 1.4 网格入口 ──────────────────┴──────── 1.5 查看器入口（含重命名 name 键）

2.1 设置持久化＋入口 ── 2.2 通用面板（语言开关接 collation）── 2.3 存储面板

3 搜索 scope（独立）    4 画布入口（独立）    5 任务通知（独立，按 D17 可能缩水/改期）

6 收口核对（死接口去留/系统分享/状态栏登记/fileCount 核对；1.5 之后做）── 7 验收
```

- 阶段 1/2/3/4/5 相互独立，可穿插推进；1.2 是阶段 1 的枢纽（所有 UI 入口都依赖它提供的索引一致性）。
- 1.2 若要动 FFI（导出 `generate_id`），**照 M1 §7 行 364 的完整链条**跑绑定与双 ABI so 重编（`scripts/kotlin-dev.ps1 -So` 只编 arm64 且多设备时取第一台，别用它冒充全链）。

## 阶段 1：本地库文件操作（本里程碑最大块）

### 1.1 MediaStore 写原语与批量授权
- **现状**：Kotlin 侧**零写操作**。删除是唯一先例：`MainActivity.requestDelete`（`:467-480`）走 `MediaStore.createDeleteRequest`（API≥30）+ `GalleryViewModel.deleteDirect`（`:265-281`，API<30 逐条 `contentResolver.delete` 兜底）；manifest 只有读权限（`READ_MEDIA_IMAGES` / `READ_EXTERNAL_STORAGE maxSdk=32`）。React 安卓版同样只做过删除（`android_delete_files`，`lib.rs:1881`），**没有可抄的 JNI 桥**——Kotlin 独立应用直接调 MediaStore API，反而不过 JNI。
- **目标**：`GalleryViewModel` 新增三个写原语（或一个 `FileOperations` 门面）：
  - **重命名**：`contentResolver.update` 改 `DISPLAY_NAME`。`_id`/`content_uri` 不变 → `file_id` 不变 → 元数据自然还挂着（规划五要点②），**不写任何迁移代码**。API≥30 先 `createWriteRequest(uris)` 拿授权再改；API<30 走 `WRITE_EXTERNAL_STORAGE`（manifest 加一条 `maxSdkVersion="29"`，同 M1 删除兜底先例）。
  - **移动**：`contentResolver.update` 改 `RELATIVE_PATH`（跨 bucket）。授权同上，**批量一次请求**。
  - **复制**：`MediaStore.Images` insert 新行（带上源的尺寸/日期等列），**不需要写授权**（规划五要点②）。注意 insert 后从返回的 uri 取新 `_id`。
- **细节**：写操作统一在 `Dispatchers.IO`；失败逐条 try/catch 记日志（`deleteDirect` 同款，成功多少算多少）；操作完成后**主动触发一次 `scanAndReconcile` + `reloadImages`**——MediaStore observer 的防抖（1s）虽会兜底，但主动触发让 UI 即时反映，不赌时序（规划五要点③「UI 不能等下次扫描才变」）。
- **验收**：模拟器上重命名/移动/复制各一例：重命名后查看器抽屉的标签/描述还在；移动后源/目标相册计数即变；复制出的副本在目标相册可见；三例都 `force-stop` 重启后不回退。

### 1.2 索引联动与元数据搬运（含 FFI 扩面）
- **复制场景的元数据问题**：insert 生成新 `_id` → 新 `content_uri` → 新 `file_id = generate_id(content_uri)`（Rust 内部函数，`ffi.rs:137`，**未导出**）。副本要带标签（规划五要点④），元数据搬运有两个方案：
  - **方案 A（推荐）**：导出 `generate_id(content_uri: String) -> String`，Kotlin 复制后立刻算出新 `file_id`，读旧行（`getFileMetadata`）→ copy → `upsertFileMetadata` 新行——`saveFileUpdates`（`GalleryViewModel.kt:323`）已示范读改写，这套不用新原语，**只导出一个纯函数**。Rust 侧现成参考 `file_metadata.rs:228` 的 `copy_metadata`（注意核对它的签名与默认值语义，别想当然）。绑定 + 双 ABI so 照 M1 §7 行 364。
  - **方案 B**：不动 FFI——复制后主动跑 `scanAndReconcile`（对账会按新 uri 生成 `file_index` 行），之后再按「目标相册 + 同名 + 新 uri」反查新 `file_id` 搬元数据。缺点：多一次全量管道、反查靠约定（重名文件在环），不如 A 确定性高。
- **移动场景的索引**：跨 bucket 后 `file_index.parent_id` 与文件夹计数变旧。M4a 4.1 起取数已收拢在 `reloadImages` 一个口，主动触发 `scanAndReconcile`（reconcile 本来就会纠正归属）即可，无需就地 UPDATE 的第二条路径——**别做两套索引维护**，那正是 M4a 2.0 教训反对的「多份缓存配多套失效时机」。
- **顺手核对（M4a 顺延项 7）**：专题卡片 `fileCount` 与详情 `getTopicFiles` 数不同步（`topics.rs` 缓存计数 vs 实时查询）。本轮动数据层，把两处口径核对一遍并记录结论；若能一行修掉就修，修不动写清原因留 M6。
- **验收**：方案 A 则 `aurora_core.kt` 出现 `generateId`、双 ABI so mtime 同批；副本落库后 `file_metadata` 有新行且 `file_tags` 跟着有（侧栏计数会+1）；移动后 `list_folders` 的计数与 MediaStore 实际一致；fileCount 核对有结论记录（无论修没修）。

### 1.3 新建相册（懒创建，并入目标选择器）
- **按规划 §6 决策记录⑤全文执行**，要点不再抄，只列本轮落点：
  - **不提供独立「新建空文件夹」入口**；「+ 新建相册」做在 1.4/1.5 的**移动/复制目标选择器底部**；
  - 建在 `Pictures/<名字>`，第一版不做父目录选择；
  - 顺序铁律（细则 i）：MediaStore 落地文件（`RELATIVE_PATH` 指向新目录即建）→ 重查 `BUCKET_ID`/`BUCKET_DISPLAY_NAME` → 对账插入 Folder 行。**不能先建 Folder 行**（bucket 身份来自 MediaStore，反过来会得到永远为空的假相册）；
  - 重名拦截（细则 iii）：与已有相册 `RELATIVE_PATH` 相同即提示「将合并到已有相册 X」并要求确认；
  - API<30 兜底同 1.1（细则 iv）。
- **验收**：新建相册 → 移动一张图进去 → 侧栏「本地相册」立刻出现该相册且计数 1；输入已存在的相册名 → 出合并确认不静默合并；不移动任何文件时不产生空相册（重启后侧栏无残留）。

### 1.4 网格入口：选中集菜单补项 + 文件夹长按菜单
- **选中集「更多」菜单**（`MainActivity.kt:691-716` 的 `moreActions`，M4a 4.3 的承载物直接扩）：`inBrowser` 分支补 **复制到…** / **移动到…**（多选）；**重命名…**（单选时）。目标选择器 = 新 Compose 弹窗（数据源 `viewModel.folders`，Aurora 系形制），底部「+ 新建相册」（1.3）。
- **文件夹卡片长按菜单**（M4a 改期项）：`onFolderCardLongPress` 已选中时长按弹菜单（同图片的 `moreExpanded` 机制），项为 **复制到…** / **移动到…** / **删除**（删除已有链路：`resolveSelectionUris` 会把文件夹展开成成员图，`GalleryViewModel.kt:241-257`）；总览选择栏「更多」的 Toast（`MainActivity.kt:833`）随之换成真菜单。
- **桌面同位项的取舍（登记，不悄悄砍）**：
  - **文件夹重命名**：MediaStore **没有 bucket 改名原语**（bucket 名跟目录走，改名 = 全员搬家式移动，大相册极重且有中途失败态）——按 D20 拍板做/不做；
  - **生成缩略图**：桌面是手动补缩略图的兜底入口（`ContextMenu.tsx:512-520`）；安卓缩略图管线全自动（`ThumbnailLoader`），无手动场景，**不做**，矩阵该行备注登记；
  - 复制文件夹路径 / 在资源管理器打开 / AI 分析：桌面专属或 M6，不做。
- **验收**：多选 3 张复制到新相册一次成功（系统弹窗只在移动时出现且只有一次）；文件夹长按菜单各项可用；选择栏「更多」在总览不再 Toast。

### 1.5 查看器入口：复制/移动落地 + 重命名接通
- **复制/移动**：菜单项与 `FolderPickerDialog` 都在（顺延项 3），本轮做三件事——① `MainActivity` 把 `viewModel.folders` 构造进 `showFolderPickerDialog` 的 `folderTreeJson`（核对 M3 时代的 JSON 形状约定，别另起）；② `onFolderPickerConfirm(fileId, targetFolderId, type)` 从 Toast 改为调 1.1 原语（`type` 分复制/移动）；③ 目标选择器底部「+ 新建相册」与网格侧同一语义（查看器是 View 体系弹窗，与网格 Compose 弹窗不强合——D13 先例：两处实现、写入路径只有一条）。
- **重命名（`name` 键）**：`MainActivity.kt:210-214` 的 Toast 分支改为调 1.1 重命名原语（改 `DISPLAY_NAME`）；`RenameDialog`（`viewer/dialogs/`，M3 搬入）不用动。网格侧重命名弹窗复用 `RenameDialog` 形制（必要时挪出 viewer 包）。
- **验收**：查看器内复制当前图到另一相册 → 退出查看器目标相册有副本且带标签；重命名当前图 → 抽屉信息区名字更新、网格同步；**只重命名不碰标签描述**（打整行覆盖回归，同 M4a 2.1 的验收口径）。

## 阶段 2：设置

### 2.1 持久化与设置入口
- **现状**：Kotlin 侧唯一的持久化是专题排序的 SharedPreferences（`aurora_topics`，`MainActivity.kt:664`）；React 的设置整体走 `save_user_data` blob（`usePersistence.ts:35-42`），而 `save_user_data`/`load_user_data` **没有 FFI 导出**（依赖 Tauri 路径 API，M4a D10 已查清）。设置项是「低频写、启动读」，**按 D15 拍板落 SharedPreferences 还是导出 blob 存取**。
- **目标**：设置入口挂侧栏或 TopBar（对齐 React SettingsModal 的形制，视觉照 `设计约定.md`），一个 `AppSettings` 数据类 + 唯一读写口；已有的散装偏好（专题排序的 `aurora_topics`）**顺手并入**同一入口，别留两套。
- **验收**：改一项设置 → force-stop 重启还在；专题排序迁移后行为不变。

### 2.2 通用面板（含语言开关）
- **React 同位对照**（`GeneralPanel.tsx`）：语言（`:42-56`）、animateOnHover（安卓文案 animateOnSelect，`:77-91`）、autoExtractPalette（`:93-107`）、调试日志（`:111-139`，注释明说安卓把这项放通用页因为性能面板隐藏）、主题（`:164-188`）、folderIconStyle（`:192-231`）、默认布局（`:287-430`）；自启动/退出行为桌面专属（`!isAndroid` 隐藏）。**做哪些按 D19 圈定**。
- **语言开关的连带（M4a 顺延项 1）**：切语言 → `TAG_LOCALE` 换源 → `reloadTagState()` 重算 → 侧栏分组顺序变；`en` 档的组内次序偏差（真实标签库 5/665、全在 Z 组，ICU 数据版本差）按 M4a 1.3 判据**记进矩阵表 4 标签行备注**，不算 bug。界面文案 本轮仍只有中文（React 的 i18n 范围本轮不对齐，登记即可——若验收人要求连界面文案一起双语，工作量另估）。
- **验收**：语言切 `en` → 侧栏含汉字标签的分组与 React 同数据对照一致（按 1.3 判据的三档口径）；各项设置重启不丢。

### 2.3 存储面板
- **React 同位对照**（`StoragePanel.tsx`）：安卓可见的实块是「缓存目录 + 删除缓存」（`:617-644`，调 `androidClearThumbnailCache`/`androidGetCacheSize`）与「数据备份：导出/导入标签 JSON」（`:672-698`，安卓导出走 `writeFileFromBytes` 到 Download）；主色调数据库管理与错误文件管理两节依赖 M6 能力（`androidBatchExtractColors` 等），**随 M6**。
- **Kotlin 落点**：缓存清理 = Coil 磁盘缓存（`NativeGalleryView` 的 ImageLoader 200MB 磁盘缓存）+ 应用 cacheDir，清完 Toast 大小变化；备份导出/导入的内容与 React 对齐（核对 `:672-698` 的确切字段——词表 + 文件标签，Kotlin 侧即 `tags`/`file_tags` 两表；描述/来源是否在备份范围以 React 实际为准，别自己扩）。
- **验收**：删缓存后缓存大小归零、缩略图自动重建；导出 JSON → 清库 → 导入 → 标签全回来；导出文件能被 React 版备份格式互相读通（若格式同源）或明确登记差异。

## 阶段 3：搜索 scope 下拉
- **现状**：`SearchScope` 枚举、`TabState.searchScope`、`HistoryItem.searchScope` 都在（`AppState.kt:31/:66/:118`），`toggleTagFilter` 已在用 `TAG`（`:507`）；但 **TopBar 没有 scope UI，`filterImages` 没有 scope 参数**（`GridModels.kt:62`，只按文件名 contains；`:56-60` 注释还专门警告「标签筛选别补在这里」——那是序列源的 4.1 决定，别混为一谈）。
- **React 同位**：`SearchScope = 'all' | 'file' | 'tag' | 'folder'`（`types.ts:452`），分支在 `useFileSearch.ts:128-148`：all=文件名+标签+**描述**、file=文件名、tag=标签、folder=所属文件夹名；TopBar 下拉 `:968-999`，安卓不隐藏。
- **Kotlin 的语义差异要自己想清楚（与 React 不是一一映射）**：React 在全库 `allFiles` 上过滤，Kotlin 在**当前序列源**上过滤——① `TAG` 文本搜与 4.1 的标签序列源（`activeTags`）是两回事，文本搜=当前序列里「标签名含 query」的图，要把 `tagsByFile` 喂进管道；② `FOLDER`（按所属文件夹名筛）在单文件夹视图里退化，只在标签筛选的全库视图里有意义；③ `all` 搜描述要把 `metadataById` 喂进管道。管道改动点：`filterImages` 加参 + `rememberDisplayImages`（`DisplayPipeline.kt:18`）透传 + 组合根喂快照。
- **验收**：四种 scope 各验一例（含「描述里含词、文件名不含」的 all 用例）；scope 切换后进查看器，翻页序列跟筛选一致（M4a 4.1 的连带约束）；系统返回退掉搜索词不退视图。

## 阶段 4：画布入口
- **现状**：侧栏画布行已渲染但不可点（`TreeSidebar.kt:393` 注释原文「M4b 前仅入口占位，视图归 M5」）。React 的「画布」= 新建 `isCompareMode: true` 的标签页进 ImageComparer 全屏画布（`useTabHandlers.ts:103-143`），无独立 ViewMode。
- **目标**：验收标准只要求「**画布入口可点进（视图本体仍属 M5）**」。落法：`ViewMode` 加 `CANVAS` + 空态占位页（文案明示「画布视图将随 M5 提供」，沿用 M3 3.3 的可见占位口径）；`HistoryItem` 复用 `viewMode` 字段自动兼容返回链；侧栏画布行接 `onCanvasClick`（高亮对齐其他 Section 的彩——画布绿）。D5 单标签下 React 的「单画布限制」不适用，登记即可。
- **验收**：点画布行 → 进占位页；系统返回/TopBar 返回都退得回来；重启后不停在画布占位（ViewMode 不持久化，天然满足——确认即可）。

## 阶段 5：任务进度通知（按 D17 结论执行或改期）
- **现状**：Kotlin 零通知基础设施（无 `POST_NOTIFICATIONS`、无 NotificationChannel）。React 侧的通知**只服务主色调提取任务**（`App.tsx:1869/2849`、`StoragePanel.tsx:252-270`；通知的「显示/更新/隐藏」实际是 Rust 侧批量提取时直接调 Kotlin 桥，`lib.rs:1154/1089/1060`；暂停/恢复按钮经 `color-extraction-notification-action` 事件回传）。主色调提取在安卓属 M6——**React 通知的唯一消费者不在 M4b 范围内**。
- **M4b 现成的长任务只有 MediaStore 扫描+对账**（前台有「扫描中…」全屏 + 下拉刷新指示器；退后台扫描继续跑但用户看不见）。D17 两个方向：
  - **做扫描通知**：自建 Channel + 进度/完成通知（M4a §8 已预警：`android_*_task_notification` 是 JNI→Tauri 桥，独立应用拿不到，**必须 Kotlin 侧自建，别试图复用**）；Android 13+ 要 `POST_NOTIFICATIONS` 运行时权限（manifest + 请求时机）。无按钮回传（扫描没有暂停语义），按钮回传留给 M6。
  - **改期 M6**：与首个真任务（主色调/AI）同期做完整版（进度+按钮+事件回传），M4b 在矩阵表 6 该行登记改期——M4a 4.2 的先例。
- **验收（若做）**：大库（`bulk/` 60 张不够就 push 更多）扫描期间退到桌面 → 通知栏有进度、完成有终态通知；点通知回应用；`force-stop` 后无残留通知。

## 阶段 6：收口核对
- **6.1 死接口去留（顺延项 6）**：`onMore` / `onEditTags` / `onLongPress` 无调用方。1.5 落完查看器菜单后核对是否仍无调用方：是则从 `NativeGalleryView.Listener` 删掉（15 回调减到 12），宿主 Toast 一并删；别留「永不触发的占位」给下个里程碑。
- **6.2 系统分享「其余随 M4」核对**（矩阵表 6）：Kotlin 已有网格选中集分享（`SelectionBar.onShare` → `onShareSelection`）+ 查看器单图分享（`:168-175`）；核对 React `androidShareImage(s)` 还有没有别的调用点没覆盖，预期零代码、矩阵行登记达成。
- **6.3 状态栏/全局沉浸核对（规划范围第四块的结论）**：React 的状态栏调用全部服务于「跟随主题深浅」（`App.tsx:499/653`、`AppModals.tsx:185/192`）与「画布沉浸」（`ImageComparer.tsx:1972-1987`）两个场景；Kotlin **恒浅色主题**（`MainActivity.kt:290` 注释钉死）、查看器沉浸 M3 已交付（`setImmersiveMode:241`）、画布沉浸随 M5。**起草人核对结论：这一块在 M4b 大概率是零代码登记**（React 平板也没有「主界面全局沉浸」），矩阵表 3「全局随 M4b」按此改注；验收人若另有要求（如主界面沉浸开关），届时单独立项。
- **6.4 Toast/注释里程碑号清理**：M4a 4.3 清过一轮，本轮把「将随 M4b 提供」的存量逐条销账（改成真实现或删掉），别让 M4b 过去后还留着 M4b 字样的 Toast。

## 阶段 7：验收
- **矩阵回填**：表 6 各行按实际达成/改期回填；表 3「删除/移动/复制」行 Kotlin 列补齐「重命名/移动/复制/新建相册 M4b 已达成」；表 1 搜索行补 scope 下拉；表 2 FolderSection 行按 D18 结论回填、CanvasSection 行标「入口已达成/视图 M5」；表 4 标签行补 `en` 档 collation 备注。规划 §6 的 M4b 行打 ✅。
- **主链路（§0 展开判据）**在 aurora35 全走一遍，最后 **force-stop 重启**验持久；文件操作后再跑一遍 M4a 的主链路（打标签→筛选→查看器→编辑），确认写操作没把元数据链路砸了。
- **顺手**：`npm run kotlin:dev` 起日志确认各操作走的是新路径（§1 第 2 条纪律）；体积对比一轮（本里程碑无新 ICU 类大依赖，so 体积应基本持平，异常膨胀要查）。

## 6. 关键决策点（需验收人拍板；编号接 M4a 的 D14）

| # | 决策 | 起草人建议 | 说明 |
|---|---|---|---|
| D15 | 设置持久化落哪 | **SharedPreferences**（起草人可定） | ① SharedPreferences（`aurora_topics` 先例）：零 FFI 改动，设置项低频写、启动读，量级 KB——够用；② 导出 `save/load_user_data` 等价物（blob 存 db）：与 React 形状同构、将来三端设置可互认，但要动 FFI + 定 blob 归属（`user_data` 在桌面是文件、安卓没有对应路径概念）。M4a D10 的教训反过来用：**别为「将来可能的三端一致」提前建抽象**，等 M6 互联真要同步设置时再迁。 |
| D16 | LAN/AI 设置面板归 M4b 还是 M6 | **随 M6**（面板与功能同期） | 矩阵表 6 两行原文「完整（M4）」。React 的 LAN 面板在安卓本就替换成 LanClientPanel（客户端 UI = M6 功能本体）；AI 面板的开关项（autoTag/autoDescription/OCR/翻译目标语言）全部驱动 M6 的任务。M4b 做出来是纯空壳（M4a 4.2 的同款问题：空壳会被当 bug 报回来）。拍成随 M6 的话，规划 §6 M4b 范围句「设置三个面板」要同步改成「设置通用/存储两面板」，矩阵行登记改期。 |
| D17 | 任务进度通知做不做、做什么 | **做扫描通知（基础版）** | 理由：M6 的通知链路（进度+按钮回传+事件）反正要自建，M4b 先把 Channel + 进度/终态的基础版立起来，M6 只加按钮；大库扫描/热刷新退后台后完成通知是真实价值。反方案：改期 M6 与首个真任务同期做完整版（省掉 POST_NOTIFICATIONS 权限流程在本轮的引入）。两案都写进了阶段 5，拍哪个走哪个。 |
| D18 | 侧栏文件夹树形做不做 | **维持扁平，登记矩阵** | 矩阵表 2 FolderSection 行「多级树形随 M4b」是 M1 时代写的目标，但**对齐基准的 React 平板现状就是扁平 bucket 列表**（`androidPlatform.ts:279-308` `buildFolderNodes` 所有 bucket `parentId: null`，无层级）。做树形要按 `RELATIVE_PATH` 前缀造「Pictures/」虚拟中间层，引入 React 版都没有的导航概念；bucket 之间本无父子关系，树形是造出来的层级。建议目标格改为「完整（扁平，对齐 React 平板）」，真机用户若报「想按目录层级看」再立项。 |
| D19 | 通用/存储面板的项目范围 | **做：语言/调试日志/默认布局与排序持久化/缓存清理/备份；不做并登记：主题暗色（Kotlin 恒浅色，M1 定）/自启动/退出行为/folderIconStyle；随 M6：autoExtractPalette/AI 开关** | React 通用面板 8 项里 3 项桌面专属本就隐藏；暗色主题做不做是产品问题（要整套暗色调色板，M1 拍过恒浅色），单独说一声即可推翻。animateOnHover（安卓文案 animateOnSelect）控制的是卡片动画，Kotlin 无对应效果，随实现核对：有则接、无则不做并登记。 |
| D20 | 文件夹「重命名」的安卓语义 | **不做，登记矩阵**（复制/移动照做） | MediaStore 没有 bucket 改名原语：目录名跟文件走，改相册名 = 全体成员搬家式移动（批量 `RELATIVE_PATH` update），大相册极重、中途失败态难看、还可能触发整库重扫。桌面语义在触屏没有廉价对应物。若验收人坚持要，按「批量移动」实现并接受其代价（进度提示 + 失败回滚不做、成功多少算多少）。 |

## 7. 任务状态记录

| 任务 | 状态 | 结果与备注 |
|---|---|---|
| 0 决策拍板 | 完成（2026-09-23，全部按 §6 起草人建议采纳，验收人可随时推翻单项） | **D15**＝SharedPreferences（清单起草人可定项；不导出 blob，不为「将来三端一致」提前建抽象）。**D16**＝LAN/AI 面板随 M6（空壳会被当 bug 报回来，4.2 同款问题；规划 §6 范围句与矩阵表 6 行已同步改「设置通用/存储两面板」）。**D17**＝做扫描通知基础版（自建 Channel + 进度/终态，无按钮回传；M6 只加按钮）。**D18**＝维持扁平、矩阵表 2 行改「完整（扁平，对齐 React 平板）」（树形是造出来的层级）。**D19**＝做：语言/调试日志/默认布局与排序持久化/缓存清理/备份导出导入；不做并登记：主题暗色/自启动/退出行为/folderIconStyle；随 M6：autoExtractPalette/AI 开关；animateOnSelect 随实现核对。**D20**＝不做文件夹重命名（MediaStore 无 bucket 改名原语），矩阵表 3 行备注登记；复制/移动照做。 |
| 1.1 MediaStore 写原语 | 完成（2026-09-23） | `GalleryViewModel` 三个原语收 **content uri**（UI 边界 id→uri 只解析一次，授权同用一批）：`renameFiles` 改 DISPLAY_NAME / `moveFiles` 改 RELATIVE_PATH（API<29 改 DATA 兜底）/ `copyFiles` insert+字节流拷贝（免写授权）。授权在宿主 `requestWriteAccess`：API≥30 `createWriteRequest` 攒一批一次弹（实测 2 张一张弹窗「modify 2 photos」），<30 走 WRITE_EXTERNAL_STORAGE 运行时权限（manifest maxSdk=29 已补）。写后主动 `scanAndReconcile`+`reloadImages`。模拟器实测：重命名/移动 **_id 不变**（元数据自然挂住，五要点②）、复制成功、move 2/2。调试钩子 `aurora.debug.FILEOP`（op= rename/move/copy + uris/target/name）供 UI 入口落地前 adb 驱动。**环境坑**：新 AVD 上 `adb push` 后 `cmd media_scanner scan` 会把行挂成 `is_pending=1`（应用查不到、shell 能查到），须逐行 `content update --bind is_pending:i:0` 清掉。 |
| 1.2 索引联动与元数据搬运 | 完成（2026-09-23） | **方案 A 落地**：FFI 导出 `generate_id`（`ffi.rs`，纯函数不碰库），绑定重生成 + 双 ABI so 同批重编（体积 x86_64 +0.2%/arm64 +0.8%，持平）；`copyFiles` 复制后读源行 `getFileMetadata`→copy 写新行、源标签 `setFileTags` 搬到新 id。**踩坑（已修）**：insert 返回 `content://media/external_primary/...` 形式，扫描管道拼的是 `content://media/external/...`——同一行两种字符串 → generateId 哈希不同 → 元数据写到索引永远对不上的孤儿 id；修法 = insert 后用 `ContentUris.withAppendedId(EXTERNAL_CONTENT_URI, parseId(uri))` 重导规范形式再哈希/写 path。模拟器实测：副本落库后 file_index 同 id、file_tags/file_metadata 跟着有（侧栏计数+1 无鬼影）。**fileCount 核对（顺延项 7，已修）**：两方向根因都找到——①「0 vs 5」偏小 = `addFilesToTopic` 自动封面分支拿过期快照 `topic.copy()` 走 `upsert_topic`，SQL `file_count = excluded.file_count` 把刚刷新的计数打回旧值；②「2 vs 1」偏大 = 图片被删后 topic_files 孤儿成员没人清（卡片=缓存列=原始行数，详情=list_images_by_ids 静默跳缺行）。修法 = upsert_topic 的 ON CONFLICT 分支改 `file_count = topics.file_count`（缓存列只由 update_file_count 维护）+ `reconcile_mediastore_snapshot` 事务内清 topic_files 孤儿并全量对齐缓存（该函数仅安卓调用，桌面不受影响）；新增回归单测 `reconcile_prunes_orphan_topic_members_and_refreshes_count`，db 模块 26 测试全过。**环境坑**：本机无 NDK/cargo-ndk，已装 NDK r29 + cargo-ndk v4.1.2；`kotlin-app/local.properties` 的 sdk.dir 指向另一台机器的路径，本机改为正确值（该文件本在 .gitignore，未入版本库）。 |
| 1.3 新建相册 | 待办 | |
| 1.4 网格入口 | 待办 | |
| 1.5 查看器入口 | 待办 | |
| 2.1 设置持久化与入口 | 待办 | |
| 2.2 通用面板（语言开关） | 待办 | |
| 2.3 存储面板 | 待办 | |
| 3 搜索 scope | 待办 | |
| 4 画布入口 | 待办 | |
| 5 任务通知（按 D17） | 待办 | |
| 6 收口核对 | 待办 | |
| 7 验收与回填 | 待办 | |

## 8. 交接要点（开工前读；M4a §8 的通用坑不重复抄）

- **文件操作的测试要多备一个「脏」环境**：`bulk/` 60 张在一个相册里，先 `adb push` 分散成 2~3 个目录（模拟多相册移动/复制）；系统授权弹窗（`createWriteRequest`）是真实弹窗，uiautomator 能看到但按钮坐标每次可能漂移，逐次 dump。
- **`adb` 注不进非 ASCII 文件名**（M4a §8 同款坑）：重命名测试用 ASCII 名（`renamed_01.jpg`）；中文相册名的「新建相册」要上手敲或先验 ASCII。
- **删除的确认弹窗文案别抄错**：现有删除确认（`MainActivity.kt:1215`）写着「可尝试在系统相册的回收站中找回」——两端均无回收站（拍板），这文案指的是**系统相册的**回收站（厂商层），不是本应用的；移动/复制的确认弹窗文案写的时候别把这个语义搅混。
- **阶段 1 全程盯着元数据不丢**：文件操作最容易砸的就是 M4a 刚建立的标签/描述链路——每个任务的验收都带一条「操作后元数据还在」（1.1/1.5 已写入判据），验收时别省。
- **复制的 `RELATIVE_PATH` 来源**：insert 时要自己算目标目录（源文件的 `DATA` 路径的父目录结构 + 目标 bucket 名），MediaStore 不会替你拼；跨存储桶名带空格/中文的路径拼接用 `Uri`/`File` API，别手拼字符串。
