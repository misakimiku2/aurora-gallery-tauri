# M4a 数据与整理任务清单

> 版本： v1（2026-09-21 起草，M3 封版同日）
> 状态： **待开工**。开工前先拍板 §6 的 D10 / D11 / D13（D11 决定这一段的体量）。
> 配套： [规划](./安卓Kotlin版并行开发规划.md)（§6 M4a 行、§3.1「逻辑写一次」、§4 逻辑下沉清单）｜[矩阵](./三端功能矩阵.md)（表 2 侧栏 / 表 4 数据与智能 / 表 1 三个总览）｜[M1 清单](./M1任务清单.md)（§7 行 364 = 改 Rust FFI 的完整链条）｜[M3 清单](./M3查看器并入任务清单.md)（查看器与 `Listener` 的现状）
> 用途： M4a 的小步执行清单。每完成一个小任务更新对应行的状态。
> 结论速览： **Rust 侧几乎不用重写**——人物/专题/文件元数据的 db 原语在 `core/src/db/` 里全都现成，`db_commands.rs` 里对应那 20 个 command 清一色只依赖 `State<AppDbPool>`，导出成 UniFFI 是机械活；表也已经被 `init_db()` 在安卓上建好了。**真正的缺口只有标签**：没有表（是 `file_metadata.tags` 的 JSON 列）、词表存在依赖 Tauri 路径 API 的 user_data blob 里、增删改与侧栏计数目前写在 TS。所以本里程碑的大头是「把标签逻辑从 TS 搬到 Rust」，不是画 UI。

## 0. M4a 目标与验收（来自规划 §6）

- **范围**：UniFFI 扩面（人物/专题/文件元数据读写）；标签从 TS 下沉 Rust（含词表落库方式）；查看器内编辑标签/描述/来源网址接库；侧栏标签/人物/专题三个 Section 接真数据 + 对应总览视图；标签过滤接真数据；元数据面板。
- **验收标准（硬指标）**：能给一张图打上标签 → 侧栏标签 Section 看得到并带计数 → 点它能筛出该标签下的全部图；退出重进、重启进程后数据还在。
- **一致性口径**：标签分组与计数的算法只有一份（Rust）。React 与 Kotlin 在同一份 SQLite 上跑同一函数必须得到同一结果，对照方式见 D12。
- **明确不做**：AI 打标 / 人物识别 / 主色调与 CLIP（`clip_generate_tags_from_embeddings`、`clip_get_character_tags`、WD14 都不在安卓的 `generate_handler!` 里，属 M6）；LAN；设置面板与任务通知（属 M4b）。M4a 只保证这些入口不崩、有可见占位（沿用 M3 3.3 的 Toast 口径）。

## 1. 拆分原则

- **延续 M0/M1/M3 纪律**：`src-tauri/`、`src/`、React 版一律不动，React 安卓版照常出货。
- **一次任务一次提交**，提交信息带任务号（`M4a-1.2: ...`）。中断后从最后一个验收通过的任务恢复。
- **每步都在真机或模拟器上跑一遍再提交**，不留「编译通过即完成」。**并且要确认跑的是新路径**——M3 4.1 就是被「兜底把老路径救活」骗过一次（见 M3 清单 §7 4.1 的更正），凡是「A 不通退回 B」的降级，退回那一支必须打一条带原因的日志。
- **标签逻辑不许在 Kotlin 里重写第二遍**。UI 只消费 Rust 返回的结构；一旦发现有 Kotlin 侧手写的分组/计数/重命名级联，就是走偏了。
- 颜色一律从 `ui/theme/AuroraPalette.kt` 那张唯一的表取，不要再起第二份色值表（M3 1.2 刚收拢过）。

## 2. 依赖关系图

```
D10 词表落库方式 ─┬─ 0.1 FFI 扩面（人物/专题/元数据）── 0.2 绑定与 so 重编 ── 0.3 Kotlin 读写冒烟
                  │
                  └─ 1.1 标签 CRUD 下沉 Rust ── 1.2 词表与分组计数下沉 ── 1.3 React/Kotlin 一致性对照（D12）
                                            │
                  2.1 查看器编辑接库 ── 2.2 抽屉显示真数据 ── 3.1 侧栏三 Section 出行 ── 3.2 总览视图（范围见 D11）
                                                              │
                                    4.1 标签过滤接真数据 ── 4.2 元数据面板 ── 4.3 M1 三占位收口 ── 5 验收
```

## 阶段 0：FFI 扩面（Rust，纯机械，先打通管道再谈 UI）

### 0.1 导出人物 / 专题 / 文件元数据的读写
- **目标**：在 `core/src/ffi.rs`（现有导出只有 `init_db:85` / `upsert_media_images:97` / `list_folders:156` / `list_images:190` / `generate_thumbnail:229`）之外，补上 `src-tauri/src/db_commands.rs` 里那些**只依赖 `State<AppDbPool>`** 的 command 对应函数：人物 `db_get_all_people:64` / `db_upsert_person:73` / `db_delete_person:79` / `db_update_person_avatar:85`；专题 `db_get_all_topics:96` 起共 13 个（`:105/111/119/125/136/146/152/158/164/170/176/182/188`）；元数据 `db_upsert_file_metadata:194` / `db_get_all_file_metadata:205`。
- **底层不用动**：`core/src/db/persons.rs:27-125`、`db/topics.rs:143-387`、`db/file_metadata.rs:18-145` 已是纯函数；表由 `init_db()` 建（`db/mod.rs:100-190`），安卓库里已经存在。
- **要处理的类型**：给 `Person` / `FaceBox` / `Topic` / `TopicSummary` / `PaginatedFiles` / `FileMetadata` 加 `#[derive(uniffi::Record)]`。三个坑：`Topic` 里嵌了 `CoverCropData` 且有 `#[serde(rename = "type")]`；`HashMap<String, Vec<String>>` 这类返回要配 Map record；`db_get_all_file_metadata:205` 是 async 且带 `normalize_path`，安卓路径语义要单独确认。
- **不做**：`save_user_data:32` / `load_user_data:46`（依赖 Tauri 路径 API，见 D10）、`switch_root_database:213`（会 emit 事件）、颜色统计 `:270-378`。
- **验收**：`cargo build` 通过；Kotlin 侧能写进一条 person/topic/metadata 并读回来（临时按钮或日志即可，不算 UI）。

### 0.2 重编绑定与双 ABI so
- **照 M1 §7 行 364 那条链走**：`cargo build`（host dll）→ `cargo run --bin uniffi-bindgen -- generate --library target/debug/aurora_core.dll --language kotlin --out-dir ../kotlin-app/app/src/main/java` → `cargo ndk -t arm64-v8a` **和** `-t x86_64` 双 ABI release 重编并 `-o jniLibs` → `installDebug`。
- **x86_64 不重编，模拟器包缺符号必崩**（M1 踩过）。`ANDROID_NDK_HOME` 要指到 `AppData/Local/Android/Sdk/ndk/<ver>`。
- 日常用 `npm run kotlin:dev`（检测设备安装+起日志）/ `npm run kotlin:dev:so`（先重编 so）。
- **验收**：模拟器与平板都能装能起，`uniffi/aurora_core/aurora_core.kt` 里能看到新函数。

## 阶段 1：标签下沉（本里程碑唯一有设计含量的部分）

### 1.1 标签的读写原语进 Rust
- **现状**：标签**没有表**，是 `core/src/db/file_metadata.rs:7-16` 里 `file_metadata.tags` 这个 JSON 列；单文件读 `get_metadata_by_id`（`file_metadata.rs:44`）已存在但**没有对应 command**，React 是一次性拉全表（`db_get_all_file_metadata`）。
- **目标**：导出/新增「给某文件设置标签集合」「按标签取文件 id」「全量文件-标签映射」三件事。Kotlin 侧只调这三个，不自己解析 JSON。
- **验收**：脚本化冒烟——给两张图打同一标签，能从「按标签取文件」里拿到这两张。

### 1.2 词表与分组计数进 Rust
- **现状**：词表 `customTags` 存在 user_data JSON blob 里（`src/hooks/usePersistence.ts:35-44`、`src/hooks/useAppInit.ts:200`），写它走 `save_user_data`（依赖 AppHandle 路径 API）；重命名、跨文件级联删除、侧栏分组与计数全在 TS（`src/hooks/useTags.ts:35-70`，`groupedTags` 派生在 `src/hooks/useFileSearch.ts` 与 App）。
- **目标**：按 **D10** 选定的方式把词表落到能被 Rust 查询的位置；把 `useTags.ts` 的四个动作（新增、重命名并级联、删除并级联、分组+计数）实现为 Rust 函数，返回 Kotlin/React 可直接渲染的结构。
- **要求**：React 侧这轮**不改**（只新增 Rust 能力），避免动到正在出货的版本；级联语义以 `useTags.ts` 现行为准，逐条对照实现。
- **验收**：见 1.3。

### 1.3 一致性对照
- **目标**：按 **D12** 的口径，证明「同输入 → 同输出」。
- **验收**：同一份 SQLite 下，Rust 的分组/计数结果与 `useTags.ts` 现有实现的输出逐字段一致（含空标签、重名、只删词表不删文件标签等边界）。

## 阶段 2：查看器内的编辑接库

### 2.1 三个编辑弹窗接上真写入
- **现状**：`TagEditDialog` / `DescriptionEditDialog` / `SourceUrlEditDialog` 已随 M3 D9 全量搬入 `kotlin-app/.../viewer/dialogs/`，能输入、能确认，但保存只落到 `Listener.onUpdateFile`，而它现在是 Toast 占位（`MainActivity.kt` 的 `viewerListener`：「元数据保存 将随 M4 提供」）。
- **目标**：`onUpdateFile(fileId, updatesJson)` 解析后写 `db_upsert_file_metadata`；`onExtractPalette` / `onColorSearch` 仍属 M6，保持可见占位。
- **验收**：查看器里给当前图加两个标签、写一句描述 → 关闭重开还在 → 网格侧栏同步反映。

### 2.2 抽屉显示真数据
- **目标**：M3 2.1 里留空的 `tags/description/sourceUrl/palette/ai*` 中，本轮把前三个填上（palette/ai 仍空态）。
- **验收**：抽屉标签胶囊、描述、来源网址三区显示真实内容；胶囊上的删除叉能级联生效。

## 阶段 3：侧栏与总览

### 3.1 三个 Section 接真数据
- **现状**：`ui/components/TreeSidebar.kt` 六 Section 骨架已在 M1 交付，标签/人物显示 `(0)`；矩阵表 2 记着 M1 已留 `groupedTags` 参数位。
- **目标**：标签 Section 出行 + 计数 + 展开/选中；人物、专题按 **D11** 定的范围决定是否本轮做。
- **验收**：打过标签后侧栏出现该标签且计数正确；点它切到筛选态。

### 3.2 总览视图
- **现状**：`state/AppState.kt:21` 的 `ViewMode` 只有 `FOLDERS_OVERVIEW` / `BROWSER`；React 版另有 tags/people/topics 三个 overview。
- **目标**：按 **D11** 补枚举与视图。**注意历史栈**：`HistoryItem` 与 `HistoryStack` 要能容纳新视图，否则 4.3 返回链会漏级。
- **验收**：从侧栏进总览、返回、再进，位置与选中态不丢。

## 阶段 4：过滤、面板与收口

### 4.1 标签过滤接真数据
- **现状**：`ui/components/TopBar.kt:964` 的 `TagsFilterSheet` UI 已在 M1 交付，传空数据即空态；`GridModels.kt:57` 的 `filterImages` 目前**只按文件名 contains**，`SearchScope.TAG` 是摆设。
- **目标**：标签筛选真正参与展示序列。**注意 M3 的连带约束**：查看器的进入序列就是这条 `rememberDisplayImages`（`ui/components/DisplayPipeline.kt`），筛选一改，查看器翻页序列跟着变，需一起验。
- **验收**：按标签筛完点图进查看器，左右翻只在这批图里。

### 4.2 元数据面板
- **目标**：主界面右侧元数据面板（矩阵表 4）。**先解 D13**：它与 M3 查看器里那套抽屉是合并成一份组件，还是两处各自实现。
- **验收**：选中一张图能看到并编辑其标签/描述；配色取自 `AuroraPalette`。

### 4.3 M1 遗留占位收口
- 长按已选中项的上下文菜单、选择栏「更多」的 Toast、搜索 scope 的标签按钮（M1 §7 记的三个）转成真实行为或明确改期到 M4b/M6 并写进矩阵。

## 阶段 5：验收

- 对照矩阵表 2 / 表 4 中标注本轮的条目逐项核对，回填「Kotlin 目标」列；规划 §6 的 M4a 行打 ✅。
- 真机（SM-X808U）走一遍主链路：打标签 → 侧栏看到 → 点开筛选 → 进查看器翻页 → 编辑 → 退出还在。

## 6. 关键决策点（需验收人拍板）

| # | 决策 | 结论 | 说明 |
|---|---|---|---|
| D10 | 标签词表落在哪 | **待定**（起草人倾向 ②） | ① 继续用 user_data JSON blob，但把 `save_user_data` 的路径依赖改成显式传路径参数——改动小，可词表永远是个 blob，Rust 侧没法按标签查询/计数，1.2 的分组只能整块读改写；② 新建 `tags(tag, sort_key, color?)` 表 + `file_tags` 关联表——多半天工作量，换来「词表可查、计数可 SQL、跨端可同步」，且 M6 的内容指纹互联直接受益。**这是产品问题不是纯技术问题**：选 ② 意味着标签从此是结构化数据，桌面 React 版要不要跟着迁（迁则两端一致，不迁则两端各存一份词表、迟早对不上） |
| D11 | 阶段 3 做几个总览 | **待定** | 平板上**人物和专题没有产生数据的入口**（人脸与 AI 打标在桌面链路，属 M6），所以这一轮做完，人物 Section 大概率仍是空的，专题要能用得先能手动建。三选一：① 只做标签这条线（平板上唯一现在就能自己用出数据的），人物/专题等 M6；② 标签 + 专题（含「手动建专题 + 把图归入专题」的入口，这是真实可用的整理功能，多 2~3 天）；③ 三个都做（UI 齐全但两块是空壳）。**这直接决定 M4a 的体量** |
| D12 | React/Kotlin 一致性怎么验 | **待定**（起草人给一条） | 规划 §4-1 的原话是「同输入下渲染结果一致（快照对照）」，但两端库本来就不同（桌面扫磁盘、安卓扫 MediaStore），不能直接比。可行口径：**取桌面那份 .db 复制一份**，React 与 Kotlin 都指向它跑同一批标签操作，比对 Rust 返回的分组 JSON 与 `useTags.ts` 的输出。要验收人确认这个口径算不算数，否则 1.3 没有判据 |
| D13 | 元数据面板与查看器抽屉的关系 | **待定** | 现在有两处元数据展示：主界面右侧面板（表 4，M4a 要做）与查看器内的抽屉（M3 已并入，纯 View 体系手搓、`DialogTheme` 供色）。是抽一份共用组件（Compose 面板 + View 抽屉两套体系其实合不干净），还是各自实现只保证字段与文案一致。影响 4.2 的做法，动手前定 |

## 7. 任务状态记录

| 任务 | 状态 | 结果与备注 |
|---|---|---|
| 0.1 FFI 扩面 | 未开始 | |
| 0.2 绑定与双 ABI so | 未开始 | |
| 1.1 标签读写原语下沉 | 未开始 | |
| 1.2 词表与分组计数下沉 | 未开始 | |
| 1.3 一致性对照 | 未开始 | |
| 2.1 编辑弹窗接库 | 未开始 | |
| 2.2 抽屉显示真数据 | 未开始 | |
| 3.1 侧栏三 Section | 未开始 | |
| 3.2 总览视图 | 未开始 | |
| 4.1 标签过滤接真数据 | 未开始 | |
| 4.2 元数据面板 | 未开始 | |
| 4.3 M1 占位收口 | 未开始 | |
| 5 验收与回填 | 未开始 | |

## 8. 交接要点（供下会话快速接续）

- **M3 的落点直接可用**：`viewer/`（查看器 + `dialogs/` 全套，`Listener` 15 个回调已在 `MainActivity.kt` 的 `viewerListener` 里各就各位，本轮要动的就是 `onUpdateFile` 那一支）；`ui/components/DisplayPipeline.kt` 的 `rememberDisplayImages` 是网格与查看器**共用**的展示序列，改筛选必须从它改；`ui/theme/AuroraPalette.kt` 是唯一色表；`state/AppState.kt` 的 `ViewMode` / `HistoryItem` 是加新视图的挂载点。
- **FFI 改动的完整链条在 [M1 清单 §7 行 364](./M1任务清单.md)**，含「x86_64 不重编模拟器必崩」这个坑；绑定文件在 `kotlin-app/app/src/main/java/uniffi/aurora_core/aurora_core.kt`（由 `core/kotlin-bindings/` 生成后复制），so 在 `kotlin-app/app/src/main/jniLibs/{arm64-v8a,x86_64}/`。
- **真机测试环境**：Tab S8+ 无线 adb，序列号取 `adb devices -l` 里完整的 `adb-R52T701VA1J-…._adb-tls-connect._tcp`（会掉线，掉了要重连）；每条 adb 走 TLS 有 5~16s 建连延迟，时序敏感的操作必须在**设备端一条 shell** 里排好。
- **测试图**：`/sdcard/Pictures/m3test/`（GIF 640×360、`huge_8k.jpg` 7680×4320、`tall.jpg` 3000×12000、`shot_a.jpg` 1600×1200）平板与模拟器上都有一份；模拟器另有 `/sdcard/Pictures/bulk/` 60 张。用完再清，别在验收前删。
- **adb 驱动不了的手势**：真双指注不进去（`input motionevent` 只有单指），两次 `input tap` 也过不了 300ms 双击窗口——这类只能上手。另外进沉浸时系统弹的「Viewing full screen」确认窗会抢走 BACK 键，别当成 App 的 bug。
- **uiautomator 坐标**：`android_screenshot` 返回的图是缩放过的，**不要从截图读坐标**；一律 `uiautomator dump` 取 bounds（设备像素）再 `input tap`。
- **两处已知偏差，本轮顺手确认**：① 查看器顶栏图标是 88px，在平板 density 340 下约 41dp，低于移动端适配规范的 48dp（React 壳就是这样，M3 未改）；② 抽屉展开状态下转屏没测到（M3 5.1 遗留）。
- **`android_*_task_notification`（`lib.rs:739-765`）是 JNI→Tauri MainActivity 的桥，独立应用拿不到**——M4b 做任务通知时要在 Kotlin 侧自建，不要试图复用。
