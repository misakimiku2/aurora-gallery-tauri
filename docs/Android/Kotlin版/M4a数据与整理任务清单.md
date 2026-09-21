# M4a 数据与整理任务清单

> 版本： v7（2026-09-21 起草；同日经代码核对（v2）、跨端口径拍板（v3）、四个决策点全部拍板（v4）、collation 实现路径实测定价（v5）、阶段 0 与阶段 1 落地并回改三处估计（v6）、**阶段 2 + 3.1 + 4.1 落地，4.1 做法改道、新增 2.0 数据层（v7）** 修订）
> 状态： **阶段 0 / 1 / 2 与 3.1、4.1 已完成（2026-09-21，见 §7），下一轮从 3.2 接着做**（剩 3.2 总览、4.2 元数据面板、4.3 占位收口、5 验收）。D10=②（建 `tags`/`file_tags` 表）、D11=③（标签/人物/专题三个 Section 与总览都做，**v7 已确认含「手动建专题 + 把图归入」入口**）、D12=纯函数级对照、D13=各自实现、D14=修正不照搬——决策已全部落地，其中 **D10/D12/D13/D14 属实现细节、由起草人按分工定**（详见 §6 各条的拍板理由）。
> **v7 修订说明**：三处与清单原设计不同，都是有意的，理由写在 §7 对应行里——① 新增 **2.0 标签数据层**（清单没有这条，但 2.2/3.1/4.1/4.2 四处共用同一份数据且都要求在写入后立刻变）；② **4.1 不做成 `filterImages` 的谓词，做成序列源**，配套新增 Rust 导出 `list_images_by_tags`，因为侧栏徽标是全库计数、只筛当前文件夹会在同一屏自相矛盾；③ 2.1 的 `updatesJson` 其实有**第四个键 `name`**（查看器重命名弹窗也走这条通道），它不属元数据、归 M4b，本轮立可见占位。另在 §8 记下三条新的交接要点：同进程第二次打开查看器时抽屉动态内容不渲染（**未修，建议阶段 5 前修掉**）、adb 注不进非 ASCII 文本、第二台模拟器 `aurora35` 的 gpu 配置与「别碰 heid-tab35」。
> 配套： [规划](./安卓Kotlin版并行开发规划.md)（§6 M4a 行、§3.1「逻辑写一次」、§4 逻辑下沉清单）｜[矩阵](./三端功能矩阵.md)（表 2 侧栏 / 表 4 数据与智能 / 表 1 三个总览）｜[M1 清单](./M1任务清单.md)（§7 行 364 = 改 Rust FFI 的完整链条）｜[M3 清单](./M3查看器并入任务清单.md)（查看器与 `Listener` 的现状）
> 用途： M4a 的小步执行清单。每完成一个小任务更新对应行的状态。
> **v6 修订说明**：阶段 0 与阶段 1 落地后回改三处 v5 的说法——① ICU 的 so 体积从预估的 +1.35 MB 改为 **1.2 真接上分组路径后的实测 +2.30 MB**；② `en` 档的偏差从合成随机汉字语料的 2,211/2,900 改为**真实标签库上的 5/665（全在 Z 组）**，1.3 判据换成分层实测数字；③ `usize` 的 FFI 映射由 `u64` 改记为 `i64`。另在 §8 记下两条本轮踩到的坑：三星会把后台 App 整个冻结（进程显示 `D`，不是卡死），以及对照工具输出成 JSON 对象会被 `Object.keys()` 重排整数样键、导致组顺序那一维静默测不到。
> **v5 修订说明**：v4 留到最后没定价的唯一风险——1.2 的分组排序要不要上 ICU——已经用真数据实测完毕，结论写进 1.2 与 1.3：**ICU 路线成立**，`icu_collator` 能过 cargo-ndk 双 ABI 交叉编译、arm64 so 只涨 1.35 MB（+22%），组键在 30,463 个输入上与 `getPinyinGroup` **零差异**；剩下唯一偏差是 `language='en'` 时含汉字标签的组内次序（ICU 数据版本差异，且 M4a 的 Kotlin 侧没有语言设置、默认恒为 `zh`，本轮不可达）。1.3 的判据据此写实。新增 `core/src/collate.rs`（已带单测）作为 1.2 的落点。
> **v4 修订说明**：四个决策点全部拍板（见 §6）。连带四处结构改动：① **1.4「词表迁移与双写」整条删除**——查清 Kotlin 版（`com.aurora.gallery.kotlin`）与 React 安卓版（`com.aurora.gallery`）是**两个不同的包、各有各的数据库**，D10 选 ② 不影响任何已出货版本；而 Kotlin 版从没存过标签、库里没有旧数据，所以无迁移可做；② 依赖图与 §7 任务表随之调整；③ D14 选「修正」，桌面版那三个缺陷单独记录在 [桌面版标签写入不落库问题-待修](../../桌面版标签写入不落库问题-待修.md)，1.3 的对照基准改为「TS 现行为 + 该文件列出的已知偏差」；④ 1.1 的「批量粘贴是否在本轮」定为**在**（含单事务批量原语），因为 4.3 的上下文菜单需要它。
> **v3 修订说明**：跨端数据共享口径已拍板——互联态可查看并修改桌面标签、改动写回桌面库，**未连接时不显示任何桌面来源的内容**（不缓存、不合并）；同日补充拍板：人物与专题同样可在线编辑，文件的重命名/删除/移动/复制也可（须桌面开读写授权），归 M6。据此改了四处：① §0 新增「命名空间边界」约束，3.1 侧栏与 4.1 过滤只接本地库，**不留「将来混入桌面数据」的口子**；② D10 的「跨端可同步」「M6 内容指纹受益」两条论据作废，② 的收益缩水为纯本地理由，需重新判断；③ 内容指纹取消（规划 §4-3），v2 讨论里提过的「建表时预留 `content_hash` 列」**不再需要，别加**；④ 4.3 增补：查看器里 `onCopyToFolder`/`onMoveToFolder`/`onFolderPickerConfirm` 三个 Toast 标的「M4」已失效——**本地库**的移动/复制归 M4b（同日拍板：安卓本地库要支持与桌面同等的完整文件操作，删除已在 M1 达成），**互联态**对桌面文件的同类操作归 M6。完整口径见规划 [§5.3](./安卓Kotlin版并行开发规划.md#53-在线读写唯一实施方案)。
> **v2 修订说明**：v1 的代码引用逐条核对后改了 6 处错误（见 §9），并补上 v1 漏掉的两个会让 0.1 编译失败的类型约束、一个被完全低估的技术风险（分组算法依赖 ICU collation）、一个桌面版现存的数据一致性缺陷（重命名不落库，见 D14）。阶段 0 已从 D10 的依赖分支上摘下来，可以先跑。
> 结论速览： **Rust 侧几乎不用重写**——人物/专题/文件元数据的 db 原语在 `core/src/db/` 里全都现成，`db_commands.rs` 里对应那 20 个 command（4 人物 + 14 专题 + 2 元数据）清一色只依赖 `State<AppDbPool>`；表也已经被 `init_db()` 在安卓上建好了（`db/mod.rs:154/157` 连 `topics` 与关联表回填都在内）。但**「导出成 UniFFI 是机械活」这句要打折**：`db::` 结构体不能直接加 `#[derive(uniffi::Record)]`（`serde_json::Value` 与 `usize` 两处撞墙，见 0.1），得照 `ffi.rs` 现有约定另写 DTO。**真正的缺口只有标签**：没有表（是 `file_metadata.tags` 的 JSON 列）、词表存在依赖 Tauri 路径 API 的 user_data blob 里、增删改与侧栏计数目前写在 TS。所以本里程碑的大头是「把标签逻辑从 TS 搬到 Rust」，不是画 UI——**而这件事里最硬的不是搬，是搬过去之后分组排序要和 `Intl.Collator` 一致（见 1.2 的风险条）**。

## 0. M4a 目标与验收（来自规划 §6）

- **范围**：UniFFI 扩面（人物/专题/文件元数据读写）；标签从 TS 下沉 Rust（含词表落库方式）；查看器内编辑标签/描述/来源网址接库；侧栏标签/人物/专题三个 Section 接真数据 + 对应总览视图；标签过滤接真数据；元数据面板。
- **验收标准（硬指标，照规划 §6 M4a 行原文）**：能给一张图打上标签 → 侧栏标签 Section 看得到并带计数 → 点它能筛出该标签下的全部图；**人物/专题同链路可读**；M1 留下的三个占位（长按已选中项的上下文菜单、选择栏「更多」、搜索 scope 的标签按钮）转为真实行为；退出重进、重启进程后数据还在。
- **与 D11 的关系（已解）**：上面这条含「人物/专题同链路可读」。**D11 已拍板选 ③（三个都做）**，规划 §6 的 M4a 验收标准无需修改。但要说清本轮交付的是什么：三个 Section 与三个总览的 UI + **只有标签这条线有真数据**，人物与专题在平板上仍是空的（数据源在 M6：人脸识别 / AI 打标 / 互联态读桌面库，见 §6 D11）。4.3 若最终选「明确改期」，仍要同步改规划与矩阵。
- **一致性口径**：标签分组与计数的算法只有一份（Rust）。React 与 Kotlin 在同一份输入上跑同一函数必须得到同一结果，对照方式见 D12。
- **明确不做**：AI 打标 / 人物识别 / 主色调与 CLIP（`clip_generate_tags_from_embeddings`、`clip_get_character_tags`、WD14 都只在桌面那份 `generate_handler!`（`lib.rs:1969` 起）里，安卓那份从 `lib.rs:2095` 起，不含它们，属 M6）；LAN；设置面板与任务通知（属 M4b）。M4a 只保证这些入口不崩、有可见占位（沿用 M3 3.3 的 Toast 口径）。
- **命名空间边界（2026-09-21 拍板，是 3.1 / 4.1 的实现约束）**：跨端口径已定为「互联态在线读写桌面库，断线不显示桌面来源的内容」（规划 §5.3）。所以 M4a 做的侧栏标签 Section、标签过滤、元数据面板、词表**只针对安卓本地库**，一律只接本地 db。**不要为「将来混入桌面数据」预留任何口子**（不要设计成「数据源可插拔」、不要在侧栏留来源标记位）——桌面来源的标签是另一套命名空间，断线即消失，M6 要合流时由 M6 自己决定是分区展示还是给 LAN 浏览态独立侧栏。提前抽象只会让 3.1/4.1 变复杂且猜错形状。
- **已知边界（不是 bug，别在验收后当 bug 报回来）**：安卓侧 `file_id = generate_id(content_uri)`（`core/src/ffi.rs:137`），桌面侧是文件系统路径的哈希。MediaStore ID 平时稳定，但**清应用数据、文件删除后重扫、换设备**都会让它变，届时 `file_metadata` 变孤儿行、标签看起来「丢了」。M4a 的「重启进程后数据还在」不受影响；跨扫描周期的稳定性要靠 `migrate_metadata`（`file_metadata.rs:214`）一类的补偿，属 M4b 之后。

## 1. 拆分原则

- **延续 M0/M1/M3 纪律**：`src-tauri/`、`src/`、React 版一律不动，React 安卓版照常出货。**唯一例外见 D10**：若词表落新表，React 侧要么双写要么跟着迁，「完全不动」与「选 ②」不能同时成立。
- **一次任务一次提交**，提交信息带任务号（`M4a-1.2: ...`）。中断后从最后一个验收通过的任务恢复。
- **每步都在真机或模拟器上跑一遍再提交**，不留「编译通过即完成」。**并且要确认跑的是新路径**——M3 4.1 就是被「兜底把老路径救活」骗过一次（见 M3 清单 §7 4.1 的更正），凡是「A 不通退回 B」的降级，退回那一支必须打一条带原因的日志。
- **标签逻辑不许在 Kotlin 里重写第二遍**，但要开一个明确的口子：**落库级联归 Rust，会话态级联归 Kotlin**。`handleRenameTag`（`src/hooks/useTags.ts:163`）除了改文件标签，还改 `tab.searchQuery` / `tab.activeTags` / `tab.selectedTagIds`——这些是会话态，Rust 拿不到也不该拿。Kotlin 侧要做的是「调 Rust 的重命名 → 拿返回值 → 更新自己的 tab 状态」，不是自己再算一遍哪些文件要改。一旦发现有 Kotlin 侧手写的分组/计数/重命名级联**落库**，就是走偏了。
- 颜色一律从 `ui/theme/AuroraPalette.kt` 那张唯一的表取，不要再起第二份色值表（M3 1.2 刚收拢过）。
- **排序规则只许有一套**：React 用 `localeCompare(语言设置)`，Rust 侧走 ICU collator + 照抄 `textUtils.ts` 边界字表（路径已于 v5 实测确认，见 1.2）——本轮收拢成「Rust 返回什么顺序，UI 就按什么顺序渲染」，UI 不再自己排（3.1 已做：`TreeSidebar` 的 `flatten()` + `CASE_INSENSITIVE_ORDER` 已删，弹层的 `keys.sorted()` 也已删）。

## 2. 依赖关系图

```
A ✅ collation 实测（已完成，落点 core/src/collate.rs）──┐（1.2 的前置，v5）
                                                          ↓
0.1 FFI 扩面（人物/专题/元数据）── 0.2 绑定与双 ABI so 重编 ── 0.3 Kotlin 读写冒烟

1.1 标签 CRUD 下沉 Rust（含批量粘贴）── 1.2 建 tags/file_tags 表 + 词表与分组计数下沉 ── 1.3 一致性对照
                                                    │
2.1 查看器编辑接库（依赖 1.1 的读+写原语）── 2.2 抽屉显示真数据 ── 3.1 侧栏三 Section 出行 ── 3.2 三个总览视图
                                                              │
                                    4.1 标签过滤接真数据 ── 4.2 元数据面板 ── 4.3 M1 三占位收口 ── 5 验收
```

- 决策已全部拍板，图里不再标 D#（结论见 §6）。
- **阶段 0 与阶段 1 的 Rust 部分可以并行**，但 1.1/1.2 新增的导出同样要过一遍 0.2 的绑定与双 ABI 重编，Kotlin 侧才调得到——实操上建议阶段 0 先整条跑通（把链条踩熟），再动阶段 1。
- v3 图里的「1.4 词表迁移与双写」已删除：Kotlin 版与 React 安卓版是两个不同的包、各有各的库，且 Kotlin 版从没存过标签，**无迁移可做**（见 §6 D10）。

## 阶段 0：FFI 扩面（Rust，先打通管道再谈 UI）

### 0.1 导出人物 / 专题 / 文件元数据的读写
- **目标**：在 `core/src/ffi.rs`（现有导出只有 `init_db:85` / `upsert_media_images:97` / `list_folders:156` / `list_images:190` / `generate_thumbnail:229`）之外，补上 `src-tauri/src/db_commands.rs` 里那些**只依赖 `State<AppDbPool>`** 的 command 对应函数：
  - 人物 4 个：`db_get_all_people:64` / `db_upsert_person:73` / `db_delete_person:79` / `db_update_person_avatar:85`；
  - 专题 **14 个**：`db_get_all_topics:96` 起（`:105/111/119/125/136/146/152/158/164/170/176/182/188`）；
  - 元数据 2 个：`db_upsert_file_metadata:194` / `db_get_all_file_metadata:205`；
  - **再加 1 个 v1 漏掉的**：`get_metadata_by_id`（`file_metadata.rs:44`）——db 里有、**既无 command 也无 FFI 导出**，但 2.1 的先读后写必须要它（见 2.1）。
- **底层不用动**：`core/src/db/persons.rs:27-125`、`db/topics.rs:143-387`、`db/file_metadata.rs:18-145` 已是纯函数；表由 `init_db()` 建（`db/mod.rs:100-190`，含 `topics::create_table` 与 `backfill_association_tables`），安卓库里已经存在。
- **做法：另写 FFI DTO，不要给 `db::` 结构体加派生。** 这是 `ffi.rs` 现有的约定（`MediaImage` / `Folder` / `Image` 都是手写镜像 Record，从没给 `db::` 结构体加过派生），而且不这么做会撞两堵墙：
  1. **`serde_json::Value` 不是 UniFFI 类型**。`FileMetadata` 有 `tags: Option<serde_json::Value>`（`file_metadata.rs:10`）与 `ai_data`（`:13`），直接 `#[derive(uniffi::Record)]` 编译不过——而 `tags` 正是本里程碑的核心。DTO 里 `tags` 用 `Vec<String>`、`ai_data` 用 `Option<String>`（原始 JSON 文本，M4a 不解析）。
  2. **UniFFI 0.32 不支持 `usize`**（`uniffi_core-0.32.0/src/ffi_converter_impls.rs:70-79` 只有 u8/i8/u16/i16/u32/i32/u64/i64/f32/f64）。撞三处：`PaginatedFiles.total: usize`、`db_get_topic_files_paginated(offset, limit: usize)`、`db_get_topic_cover_previews(preview_count: usize)`。DTO 与新导出函数一律用 `i64`（v5 落地时改的选择：`u64` 生成到 Kotlin 侧是 `ULong`，与既有 DTO 全用 `i64`（`size` / `image_count` / `createdAt`）打架且混用得手动转换），在 FFI 层 `.max(0) as usize` 转回去。
  - 改 `db::` 结构体的字段类型来迁就 UniFFI 是**禁止**的：那会改到 `#[serde(rename_all = "camelCase")]` 的输出，动到 React 侧的序列化契约，违反 §1。
- **类型上另外三个坑**（v1 提的，仍然成立）：`Topic` 里嵌了 `CoverCropData` 且有 `#[serde(rename = "type")]`（`topics.rs:21-22`）——UniFFI 不看 serde 属性，Kotlin 侧字段名会是 `topicType`，与 React 拿到的 `type` 不同名，别照 React 的字段名写 Kotlin；`HashMap<String, Vec<String>>`（`db_get_topic_cover_previews:136` 的返回）**UniFFI 原生支持，不需要额外配 record**；`db_upsert_file_metadata:194` 写入时会 `normalize_path(&metadata.path)`（v1 把这条挂到了 `db_get_all_file_metadata:205` 上，那条只是转发 `get_all_metadata`）——安卓侧 `path` 存的是 `content://` URI，`normalize_path` 对它是空操作（无反斜杠、非 Windows 前导斜杠），所以**真正要确认的是 `file_id` 语义而不是 path**（见 §0 已知边界）。
- **`Topic.file_ids` 是懒加载的**（`topics.rs:34-37` 的注释）：列表查询时 `file_ids` 为空、`file_count` 才是列表用的计数。Kotlin 侧若按 `topic.fileIds.size` 显示计数会恒为 0，D11 选 ②/③ 时这是第一个会踩的坑。
- **不做**：`save_user_data:32` / `load_user_data:46`（依赖 Tauri 路径 API，见 D10）、`switch_root_database:213`（不止会 emit 事件，还依赖 `ColorDbPool` state 与 `color_worker`）、颜色统计 `:270-378`。
- **验收**：`cargo build` 通过（host dll），新导出函数在 `ffi.rs` 里齐；DTO 转换有单元测试覆盖 `tags` 的 `Vec<String>` ↔ JSON 往返（空数组、null、含引号/中文的标签名）。

### 0.2 重编绑定与双 ABI so
- **照 M1 §7 行 364 那条链走**：`cargo build`（host dll）→ `cargo run --bin uniffi-bindgen -- generate --library target/debug/aurora_core.dll --language kotlin --out-dir ../kotlin-app/app/src/main/java` → `cargo ndk -t arm64-v8a` **和** `-t x86_64` 双 ABI release 重编并 `-o jniLibs` → `installDebug`。
- **x86_64 不重编，模拟器包缺符号必崩**（M1 踩过）。`ANDROID_NDK_HOME` 要指到 `AppData/Local/Android/Sdk/ndk/<ver>`。
- 日常用 `npm run kotlin:dev`（检测设备安装+起日志）/ `npm run kotlin:dev:so`（先重编 so）。
- **验收**：`uniffi/aurora_core/aurora_core.kt` 里能看到新函数与新 Record；两个 ABI 的 `.so` 时间戳都是本轮的（别看文件名，看 mtime，M1 那次就是漏了一个）。

### 0.3 Kotlin 读写冒烟（v1 画在依赖图里但没有正文，补上）
- **目标**：模拟器与平板各装一次，用临时入口（调试按钮或启动日志）验证「写一条 person / topic / file_metadata → 读回来字段一致」。不算 UI，验完可留可删（留的话挂在调试入口下，别进主链路）。
- **必须验到失败路径**：故意传一个不存在的 `file_id` 读元数据，确认返回 `null` 而不是崩；这一步顺带确认 0.1 的错误映射（`AuroraError::Database`）在 Kotlin 侧是可捕获的异常而非进程退出。
- **验收**：两端各一条日志证明读回了写入的值（**日志内容要只有新路径能产出**，见 §1 第 3 条）；随后 2.1 才有地基。

## 阶段 1：标签下沉（本里程碑唯一有设计含量的部分）

### 1.1 标签的读写原语进 Rust
- **现状**：标签**没有表**，是 `core/src/db/file_metadata.rs:10` 里 `file_metadata.tags` 这个 JSON 列（全库 `CREATE TABLE` 只有 file_index / persons / file_metadata / topics / topic_files / topic_people + colors.db 的两张，确认无 tags 表）；单文件读 `get_metadata_by_id`（`file_metadata.rs:44`）已存在但没有对应 command，React 是一次性拉全表（`db_get_all_file_metadata`）。
- **目标**：导出/新增**四**件事，Kotlin 侧只调这四个，不自己解析 JSON：
  1. 按 `file_id` 读单条元数据（0.1 已导出，这里复用）；
  2. 给某文件设置标签集合（`Vec<String>` → JSON 列）；
  3. 按标签取文件 id 列表；
  4. 全量「文件 → 标签」映射（分组计数的输入）。
- **⚠ 写入是整行覆盖**：`upsert_file_metadata` 的 `ON CONFLICT DO UPDATE` 覆盖全部 8 个字段（`file_metadata.rs:22-29`）。所以「设置标签集合」在 Rust 内部必须**先读后写**（读旧行 → 只换 tags → 整行写回），否则会把 description/source_url/category/ai_data 清空。这条要在 Rust 里做掉，不能让 Kotlin 侧自己拼整行。
- **批量粘贴标签在本轮做（已定）**：`handlePasteTags`（`useTags.ts:83-98`）是「把标签批量贴到 N 个文件」，入口正是 4.3 要收口的长按上下文菜单与选择栏「更多」，所以本轮必须有。原语 2 是单文件的，**另加一个「多文件加标签」原语、单事务内完成**（别 N 次 upsert，也别在 Kotlin 侧循环调单文件原语）。⚠ 桌面对应实现**根本没落库**（[桌面版标签写入不落库问题-待修](../../桌面版标签写入不落库问题-待修.md) 缺陷 2），Rust 侧要写对，这条属 D14 的预期偏差。
- **验收**：脚本化冒烟——给两张图打同一标签，能从原语 3 拿到这两张；给其中一张再写一句描述，确认标签没被冲掉（这条专门验整行覆盖）。

### 1.2 词表与分组计数进 Rust
- **现状（v1 的位置引用有错，已更正）**：
  - 词表 `customTags` 存在 user_data JSON blob 里（写：`src/hooks/usePersistence.ts:35-44` 的 `dataToSave`；读：`src/hooks/useAppInit.ts:199`），写它走 `save_user_data`（依赖 AppHandle 路径 API）；
  - 新增 `useTags.ts:108`（`handleSaveNewTag`）、删除并级联 `useTags.ts:39`（`handleConfirmDeleteTags`，**这个是逐文件落库的**）、重命名并级联 `useTags.ts:163`（`handleRenameTag`，**这个不落库**，见 D14）；文件共 228 行，v1 引的 `:35-70` 只覆盖到删除那一支；
  - **分组与计数不在 `useTags.ts`，也不在 `useFileSearch.ts`（v1 说错了），在 `src/App.tsx:1263` 的 `groupedTags` useMemo**——这是 1.3 要对照的唯一基准，别找错文件。
- **目标**：**按 D10=② 新建 `tags` 与 `file_tags` 两张表**（`tags(tag, sort_key, color?)` + `file_tags(file_id, tag)`，由 `init_db()` 建，与 `topics`/`topic_files` 同处），词表从此可 SQL 查询；**无迁移工作**——Kotlin 版的库里从没存过标签（原 1.4 已删）。把四个动作（新增、重命名并级联、删除并级联、分组+计数）实现为 Rust 函数，返回 Kotlin/React 可直接渲染的结构。**返回结构要与 `TreeSidebar` 已有的参数位对齐**：`TreeSidebar.kt:191` 收的是 `Map<String, List<String>>`（组名 → 标签名），React 的 `groupedTags` 是 `Record<string, string[]>`，同构——但注意 Map 在 Kotlin 侧不保序，若要保住 Rust 排好的组顺序，得返回 `List<Pair<String, List<String>>>` 或自定义 Record，不能直接用 `Map`。
- **✅ collation 路径已实测确定（v5，2026-09-21）**：落点是 `core/src/collate.rs`（已提交，带单测），1.2 直接在其上加 `grouped_tags`。**做法就是清单原本倾向的那条**：边界字表照抄 `textUtils.ts` 那张（不引拼音 crate），collation 用 `icu_collator` + `icu_locale_core`（注意 `icu_locid` 2.0 起是废弃壳，`Locale` 要从 `icu_locale_core` 取）。实测数据：
  - **能过交叉编译**：`cargo ndk -t arm64-v8a -t x86_64 build --release` 一次通过，增量构建约 15s。
  - **体积**：arm64 release so 基线 6,157,144 字节；keepalive 最小引用时 **+1.35 MB**，1.2 真接上「分组 + 排序」两条路径后实测 **8,454,064 字节 = +2.30 MB / +37%**（x86_64 同步 +2.16 MB）。⚠ 中途只涨 37 KB / 310 KB 的那两次都是假数据——collate 没有被任何 UniFFI 导出引用时，release 构建把 ICU 数据当死代码剥了。**量体积必须等真导出之后**。
  - **组键零差异**：拿 `\u4e00-\u9fa5` 全 20,902 字 + Ext-A 6,592 字 + 2,900 条随机 2~4 字中文词 + 69 条边界用例，逐一对拍 Node 侧真实的 `getPinyinGroup`（直接 import `src/utils/textUtils.ts`，不是抄一份），**30,463 个输入全部一致**。多音字的取舍两端同源于 ICU zh 韵母表，因此自动对齐（实测：重庆→Z、长沙→Z、朝→C、单→D、行→X、乐→L）。
  - **组内次序**：`zh` 在合成真实词集（2,900 条）上零差异；全字表 20,902 字里只有 **4 处相邻互换**（劳/労、囍/鱚）。`en` 在**随机汉字语料**上差异很大（2,211/2,900 位不同），原因是 icu4x 2.3 带 CLDR 48.2.1 / ICU 78.1 导出，而对照侧 Node 24 是 ICU 77.1——**数据版本差，不是算法差，追平没有意义**：桌面跑 Tauri WebView 的 ICU、React 安卓跑系统 WebView 的 ICU，三个壳各一版。（1.3 拿真实标签库重测后，`en` 的偏差其实只有 5/665 且集中在一组，见 §7 的 1.3 行。）
  - **本轮因此不受影响**：`settings.language` 只有 `'zh' | 'en'`（`src/types.ts:407`），默认 `'zh'`（`src/App.tsx:78`），而 Kotlin 侧设置面板归 M4b——**M4a 的 Kotlin 端没有语言开关，locale 恒传 `zh`**，`en` 那条差异本轮不可达。签名仍按 1.2 的要求接受 locale 参数，把差异留给 M4b 落地语言开关时按 1.3 的判据记进矩阵。
- **`tagSearchQuery` 也在 `groupedTags` 里面**（`App.tsx:1266` 的 filter）：分组结果是被标签搜索框过滤过的。决定这个过滤是留在 UI（推荐，输入即时响应、不必过 FFI）还是进 Rust 参数，别默认照搬。
- **要求**：React 侧这轮**不改**（只新增 Rust 能力），避免动到正在出货的版本——**D10=② 与此不冲突**：Kotlin 版（`com.aurora.gallery.kotlin`）与 React 安卓版（`com.aurora.gallery`）是两个不同的包、各有各的数据库，新表只存在于 Kotlin 版自己的库里，两个 App 互不相干（v2 的顾虑已作废）。级联语义以 `useTags.ts` 现行为准，**除了 D14 要修的三处**（重命名落库、粘贴落库、不原地改 state，见 [桌面版标签写入不落库问题-待修](../../桌面版标签写入不落库问题-待修.md)）。
- **验收**：见 1.3。

### 1.3 一致性对照
- **目标**：按 **D12** 的口径（纯函数级对照，不共用 .db），证明「同输入 → 同输出」。**基准 = 桌面 TS 现行为 + 已知偏差清单**（D14 已定「修正」）：偏差就是重命名与粘贴在 Rust 侧会落库、TS 侧不会（[桌面版标签写入不落库问题-待修](../../桌面版标签写入不落库问题-待修.md)）。这两处在测试里要**显式标注为预期差异**，不是失败。
- **验收**：Rust 的分组/计数结果与 `App.tsx:1263` 的 `groupedTags` 输出在**同一份 `(file_id, tags)` 输入 + 同一份词表**下一致，覆盖边界：空标签、词表里有但没文件用的标签（计数 0，仍要出现在分组里）、重名、只删词表不删文件标签、纯 ASCII / 纯数字 / 中英混排 / 多音字。
- **判据（v5 定，1.3 落地后改成实测数字，不留「大概一致」）**：分三档，逐档给结论不给区间——
  1. **组键与分组结构：逐字节一致。** Part A 在 30,463 个输入（含 CJK 基本区与 Ext-A 全字表）上验证过；1.3 用真实标签库再验一次，同样 0 差异（组名序列与每组成员集合都相等）。
  2. **组内次序（`locale='zh'`）：一致。** 实测 `~/Pictures/.aurora/metadata.db` 导出的 661 词 / 542 文件，**逐位置 0 / 665 差异**（`groupedTags.spec.ts`）。全 CJK 字表的单字场景仍有 4 处相邻互换（劳/労、囍/鱚），属 ICU 数据版本差；对照语料里**不要**放整个基本区的单字表，放真实标签形状（2~4 字词、中英混排、带前缀符号）。
  3. **组内次序（`locale='en'` 且标签含汉字）：判为已知偏差，不算失败。** 真实标签库上实测 **5 / 665 个位置不同、全部落在 Z 组**，组名序列与成员集合仍完全一致；合成随机汉字语料上会放大到 2,211/2,900，那种输入实际不会出现。原因是 icu4x 带 CLDR 48.2.1/ICU 78.1、对照侧 Node 是 ICU 77.1，而三端壳（Tauri WebView / Android System WebView / Node）本来就各用一个 ICU 版本。**M4a 的 Kotlin 端无语言开关、恒传 `zh`，本轮不可达**；M4b 落语言开关时再按本条记进 [三端功能矩阵](./三端功能矩阵.md)。
  - 纯 ASCII、纯数字、大小写混排、带音调拉丁字母（café/Éclair）、谚文、假名这些类目两端已验证一致，测试里应当断言为**严格一致**，不要划进容差范围。

## 阶段 2：查看器内的编辑接库

### 2.1 三个编辑弹窗接上真写入
- **现状**：`TagEditDialog` / `DescriptionEditDialog` / `SourceUrlEditDialog` 已随 M3 D9 全量搬入 `kotlin-app/.../viewer/dialogs/`，能输入、能确认，但保存只落到 `Listener.onUpdateFile`，而它现在是 Toast 占位（`MainActivity.kt:164`：`onUpdateFile(...) = toastSoon("元数据保存", "M4")`）。
- **目标**：`onUpdateFile(fileId, updatesJson)` 解析后写库；`onExtractPalette` / `onColorSearch` 仍属 M6，保持可见占位。
- **⚠ 必须先读后写**：`updatesJson` 只带用户刚编辑的那几个字段，而 `upsert_file_metadata` 是整行覆盖（见 1.1）。所以流程是「调 0.1 的按 id 读 → 合并 `updatesJson` → 整行写回」。**如果 1.1 的「设置标签集合」原语已经在 Rust 内部做了读改写，这里就直接调原语、不要在 Kotlin 里再拼一遍整行**——两处各做一次合并就是第二份业务逻辑。
- **`updatesJson` 的字段契约要写下来**：它是 M3 留下的 String 通道，键名是 camelCase 还是 snake_case、缺字段表示「不改」还是「清空」，都得定死并记在 `NativeGalleryView.kt` 的 `Listener` 注释里（`onUpdateFile` 在 `NativeGalleryView.Listener` 里，该接口共 15 个回调；`MainActivity` 里 20 个 `override fun on` 含 `SlideshowView.Listener` 等别的接口，别按 20 找）。
- **验收**：查看器里给当前图加两个标签、写一句描述 → 关闭重开还在 → 网格侧栏同步反映 → **再单独验一次「只改描述、标签不动」和「只改标签、描述不动」**（专打整行覆盖）。

### 2.2 抽屉显示真数据
- **目标**：M3 2.1 里留空的 `tags/description/sourceUrl/palette/ai*` 中，本轮把前三个填上（palette/ai 仍空态）。
- **验收**：抽屉标签胶囊、描述、来源网址三区显示真实内容；胶囊上的删除叉能级联生效（走 1.1 的原语，不是本地删一个 UI 项）。

## 阶段 3：侧栏与总览

### 3.1 三个 Section 接真数据
- **现状**：`ui/components/TreeSidebar.kt` 六 Section 骨架已在 M1 交付（可展开的只有 `SidebarSection { FOLDERS, PEOPLE, TAGS }`，`:178`），标签/人物显示 `(0)`；矩阵表 2 记着 M1 已留 `groupedTags` 参数位（`:191`）。
- **⚠ 先拆掉 UI 侧的第二套排序**：`TreeSidebar.kt:205-206` 现在把 `groupedTags.values.flatten()` 拍平、再用 `compareBy(String.CASE_INSENSITIVE_ORDER)` 重排——**既丢了分组结构，又换了一套排序规则**。3.1 要把它改成直接渲染 Rust 返回的顺序与分组，否则 §1「UI 只消费 Rust 返回的结构」当场破功，而且这是全项目第三套标签排序规则。
- **目标**：标签 Section 出行 + 计数 + 展开/选中；**人物与专题本轮也做（D11=③）**，但平板上暂无数据源，只做到「有 UI、能展开、空态文案正确」，**不造假数据**。
- **验收**：打过标签后侧栏出现该标签且计数正确；点它切到筛选态；**标签顺序与 React 版在同一份数据下一致**（这条依赖 1.2 的 collation 结论）。

### 3.2 总览视图
- **现状**：`state/AppState.kt:21` 的 `ViewMode` 只有 `FOLDERS_OVERVIEW` / `BROWSER`；React 版另有 tags/people/topics 三个 overview。
- **目标**：D11=③，补 tags / people / topics 三个枚举与三个总览视图。**注意历史栈**：`HistoryItem`（`AppState.kt:54`）与 `HistoryStack`（`:69`）要能容纳新视图，否则 4.3 返回链会漏级；`AppState.kt:113` 的初始条目与 `:220-225` 的 push 点也要一并看。
- **验收**：从侧栏进总览、返回、再进，位置与选中态不丢。

## 阶段 4：过滤、面板与收口

### 4.1 标签过滤接真数据
- **现状**：`ui/components/TopBar.kt:964` 的 `TagsFilterSheet` UI 已在 M1 交付（调用点 `:389`），传空数据即空态。**`GridModels.kt:57` 的 `filterImages(images, query, dateFilter)` 签名里根本没有 scope 参数**——`SearchScope`（`AppState.kt:24`，含 `TAG`）压根没传进过滤函数，所以「`SearchScope.TAG` 是摆设」结论对，但要做的不是「填一个分支」，而是：改 `filterImages` 签名 → 改调用点（`DisplayPipeline.kt:18` 的 `rememberDisplayImages`）→ 把「文件 → 标签」映射喂进管道。`GridModels.kt:53` 的注释已经预告了这件事（只是把里程碑写成了 M2）。
- **目标**：标签筛选真正参与展示序列。**注意 M3 的连带约束**：查看器的进入序列就是这条 `rememberDisplayImages`（`ui/components/DisplayPipeline.kt`），筛选一改，查看器翻页序列跟着变，需一起验。
- **验收**：按标签筛完点图进查看器，左右翻只在这批图里。

### 4.2 元数据面板
- **目标**：主界面右侧元数据面板（矩阵表 4）。**先解 D13**：它与 M3 查看器里那套抽屉是合并成一份组件，还是两处各自实现。
- **验收**：选中一张图能看到并编辑其标签/描述；配色取自 `AuroraPalette`；编辑走的写入路径与 2.1 是同一条（不许出现第二套合并逻辑）。

### 4.3 M1 遗留占位收口
- 长按已选中项的上下文菜单、选择栏「更多」的 Toast、搜索 scope 的标签按钮（M1 §7 记的三个）转成真实行为或明确改期到 M4b/M6 并写进矩阵。**若「批量粘贴标签」在 1.1 被判定改期，上下文菜单里的粘贴项要跟着改期并写明。**
- **顺手清掉代码注释里过期的里程碑号**：M2 已并入 M4（规划 §6，2026-09-21 拍板），但 `GridModels.kt:53`「M2 侧栏落地后再补」、`TreeSidebar.kt:102-103`「人物/标签 M2、专题/画布 M2」还写着 M2。本轮碰到这些文件时一并改成 M4a/M4b/M6 的实际归属。
- **查看器里另外三个占位的归属要重标（2026-09-21 两次拍板的连带）**：`MainActivity.kt:167-170` 的 `onCopyToFolder` / `onMoveToFolder` / `onFolderPickerConfirm` 现在都 Toast「将随 M4 提供」。M4 拆分后它们的真实归属是两条不同的线：**本地库的移动/复制 → M4b**（2026-09-21 拍板「安卓本地库要支持与桌面同等的完整文件操作」；删除已在 M1 达成，走 `MediaStore.createDeleteRequest`，其余归 M4b——见规划 §6 决策记录与矩阵表 3）；**互联态对桌面文件的同类操作 → M6**（走 LAN API，规划 §5.3）。两者不同源不可复用：前者 MediaStore，后者 HTTP。本轮把这三条 Toast 文案里的「M4」改成 M4b，别让用户以为下个版本就有。

## 阶段 5：验收

- **矩阵行标注要先拆**：矩阵 v3 的表头记了「M4 拆成 M4a/M4b」，但**行内标注仍写 M4**（表 2 的专题/人物/标签/画布四行、表 4 的面板开合行等）。逐项核对前先把本轮的行改成 M4a、其余改成 M4b/M6，否则「标注本轮的条目」无从筛起；改完回填「Kotlin 目标」列，规划 §6 的 M4a 行打 ✅。
- 真机（SM-X808U）走一遍主链路：打标签 → 侧栏看到 → 点开筛选 → 进查看器翻页 → 编辑 → 退出还在。
- **补一条 v1 没有的验收**：重启进程后重进，标签与计数仍在（这条是 §0 硬指标的后半句，v1 的任务表里没有任何一行专门验它）。

## 6. 关键决策点（需验收人拍板）

| # | 决策 | 结论 | 说明 |
|---|---|---|---|
| D10 | 标签词表落在哪 | **②：建 `tags` / `file_tags` 表**（起草人定，2026-09-21） | ① 继续用 user_data JSON blob，但把 `save_user_data` 的路径依赖改成显式传路径参数——改动小，可词表永远是个 blob，Rust 侧没法按标签查询/计数，1.2 的分组只能整块读改写；② 新建 `tags(tag, sort_key, color?)` 表 + `file_tags` 关联表——多半天工作量，换来「词表可查、计数可 SQL」。<br>**v3 更正（2026-09-21）：② 原有的两条跨端论据已失效。** v1/v2 写的「跨端可同步」与「M6 的内容指纹互联直接受益」都不成立了——跨端口径已拍板为**互联态在线读写、断线不显示、不缓存不合并**（规划 §5.3/§5.4），内容指纹已取消（规划 §4-3）。也就是说：**没有任何跨端需求要求本轮把词表结构化**。② 现在只剩「本地库的标签计数可以用 SQL 而不是把整张表拉进内存算」这一条本地理由，值不值半天工作量 + 一条迁移任务（1.4）请照这个缩水后的收益重新判断。<br>**但 ② 仍有一条 M6 的连带收益**：在安卓上给桌面图新建标签时，新词要进**桌面的词表**（规划 §5.3 写路径），LAN 那条「读词表 / 加词」端点的形状取决于桌面词表是 blob 还是表——blob 的话服务端要整块读改写、并发加词会互相覆盖，表的话是一条 INSERT。这不构成现在就选 ② 的理由（M6 还远），但选 ① 要接受那个端点将来更麻烦。<br>**v2 补充：① 与 ② 不是全部选项。** 选 ② 就等于承认「React 侧这轮不改」（1.2）不成立——Kotlin 写新表、React 仍读 blob，桌面版立刻看不到新词表项。所以真实选项是三个：**①**、**②+双写**（Rust 同时写新表与 blob，权威源要定死）、**②+改 React**（两端一次迁干净，但违反 §1「React 版一律不动」，要验收人明确豁免）。选 ② 的任一分支都要加做 1.4 迁移。<br>**这是产品问题不是纯技术问题**：选 ② 意味着标签从此是结构化数据，桌面 React 版要不要跟着迁（迁则两端一致，不迁则两端各存一份词表、迟早对不上） <br>**拍板理由（2026-09-21）**：② 的成本已被查清并大幅缩水——Kotlin 版（`com.aurora.gallery.kotlin`）与 React 安卓版（`com.aurora.gallery`）是**两个不同的包、各有各的数据库**，所以 ② 不影响任何已出货版本，v2 里担心的「双写 / 改 React」两条连带**都不存在**；且 Kotlin 版从没存过标签、库里没有旧数据，**原 1.4 迁移任务整条取消**。剩下的只是纯本地取舍：1.2 的分组计数走 SQL 还是把整表拉进内存算——建表明显更值。下面 v2 那段关于三个选项的推演保留作过程记录，但其中「②+双写」「②+改 React」两个分支已作废。 |
| D11 | 阶段 3 做几个总览 | **③：标签/人物/专题三个都做**（验收人拍板，2026-09-21） | 平板上**人物和专题没有产生数据的入口**（人脸与 AI 打标在桌面链路，属 M6），所以这一轮做完，人物 Section 大概率仍是空的，专题要能用得先能手动建。三选一：① 只做标签这条线（平板上唯一现在就能自己用出数据的），人物/专题等 M6；② 标签 + 专题（含「手动建专题 + 把图归入专题」的入口，这是真实可用的整理功能，多 2~3 天）；③ 三个都做（UI 齐全但两块是空壳）。**这直接决定 M4a 的体量**。<br>**v2 补充**：选 ① 与规划 §6 的 M4a 验收标准（含「人物/专题同链路可读」）冲突，要同步改规划；选 ②/③ 会立刻撞上 `Topic.file_ids` 懒加载（0.1 已记）。 <br>**拍板（2026-09-21）：验收人要求三个都做。** 两点必须写清楚：① 本轮做完时**人物与专题在平板上仍是空的**——数据源在 M6（人脸识别 / AI 打标，或互联态读桌面库，见规划 §5.3），所以 ③ 的收益是「UI 齐全、M6 一到即有数据」，不是本轮就能用出数据；② **起草人把「全部都做」理解为「三个 Section 与三个总览的 UI 全做，且专题含『手动建专题 + 把图归入』入口」**（即原 ② 的内容，+2~3 天），因为不带入口的专题就是一个点不动的空壳、算不上"做"。若验收人只要空壳 UI，开工前说一声，可省这 2~3 天。人物 Section 本轮只做到「有 UI、能显示、空态正确」，不造假数据。<br>**v7 确认（2026-09-21，验收人口头拍板）：按起草人的理解做，专题含「手动建专题 + 把图归入专题」的入口**（原 ② 的内容，+2~3 天）。3.2 因此的体量是「三个 Section + 三个总览 + 建专题与归入的入口」，不是空壳；那条「可省 2~3 天」的疑问作废。 |
| D12 | React/Kotlin 一致性怎么验 | **纯函数级对照**（起草人定，2026-09-21） | v1 的口径是「取桌面那份 .db 复制一份，React 与 Kotlin 都指向它」——**做不到**：安卓 `file_id = generate_id(content_uri)`（`ffi.rs:137`），桌面 `file_id = generate_id(文件系统路径)`，桌面 .db 里的 file_index 行对 Kotlin 无意义；而 Kotlin 一跑 `upsert_media_images`，`reconcile_mediastore_snapshot`（`file_index.rs:409`）会把非快照行清掉，那份 .db 当场被改写。<br>**v2 建议口径：纯函数级对照，不共用 .db。** 从桌面 .db 里**只导出**一份 `(file_id, tags)` 列表 + 词表（一次性脚本，dump 成 JSON），把它同时喂给 Rust 的分组函数与 `App.tsx:1263` 的 `groupedTags` 逻辑（后者可在 vitest 里跑，`package.json:30` 的 `test` 就是 vitest，`src/utils/__tests__/textUtils.spec.ts` **已经在测 `getPinyinGroup`**，组键的金标准现成，扩成一个 `groupedTags.spec.ts` 即可），比对输出的组键、组内顺序、计数。这样比的是算法而不是库，绕开了两端 file_id 语义不同的问题，也能进 CI。要验收人确认这个口径算不算数，否则 1.3 没有判据 <br>**拍板理由（2026-09-21）**：采用下面 v2 提的口径（纯函数级对照、不共用 .db），因为它绕开了两端 `file_id` 语义不同的死结，且能挂在 vitest 上进 CI（`textUtils.spec.ts` 已在测 `getPinyinGroup`，组键的金标准现成）。**基准要带 D14 的已知偏差清单**：桌面 TS 的重命名与粘贴都不落库（见 [桌面版标签写入不落库问题-待修](../../桌面版标签写入不落库问题-待修.md)），Rust 侧落库，这两处必然不一致，属预期偏差、要在测试里显式标注而不是当失败。 |
| D13 | 元数据面板与查看器抽屉的关系 | **两处各自实现**，只保证字段与文案一致（起草人定，2026-09-21） | 现在有两处元数据展示：主界面右侧面板（表 4，M4a 要做）与查看器内的抽屉（M3 已并入，纯 View 体系手搓、`DialogTheme` 供色）。是抽一份共用组件（Compose 面板 + View 抽屉两套体系其实合不干净），还是各自实现只保证字段与文案一致。影响 4.2 的做法，动手前定。**不论选哪个，写入路径必须只有一条**（见 4.2 验收）。 <br>**拍板理由（2026-09-21）**：Compose 面板与查看器那套纯 View 抽屉（`DialogTheme` 供色）合不干净，硬抽共用组件的成本高于收益。**但底线是写入路径只有一条**——两处都调 1.1 的原语，谁都不许自己拼整行；字段顺序、空态文案、编辑弹窗行为对齐即可。 |
| D14 | 重命名不落库：照搬还是修正 | **修正**，不照搬桌面现行为（起草人定，2026-09-21） | **桌面版现存缺陷**：`handleRenameTag`（`useTags.ts:163-208`）只改内存 state（`state.files` / `customTags` / `tabs`），**没有任何 `dbUpsertFileMetadata` 调用**；而删除那一支（`handleConfirmDeleteTags:39-72`）是逐文件落库的。所以桌面当前行为是：重命名一个标签 → 词表 blob 里存了新名字（`usePersistence` 自动存），但 `file_metadata.tags` 里还是旧名字 → **重启后旧标签回来，词表里却多了个新名字，两边分叉**。<br>三选一：① **照搬**（Rust 也只改词表不动文件标签）——保住 1.3 的「逐字段一致」，但把数据缺陷固化进三端；② **修正**（Rust 的重命名在单事务里同时改词表与所有文件的 tags 列）——正确，但 1.3 的基准要改成「TS 现行为 + 已知偏差清单」，且**桌面 React 版仍带着这个缺陷出货**，两端行为从此不同，要不要回头修 React 得单独拍板；③ 修正 + 同时修 React（违反 §1，需豁免）。<br>**选 ② / ③ 都要注意**：重命名还要级联到 `tab.searchQuery` / `activeTags` / `selectedTagIds`，这部分是会话态、只能在 UI 侧做（见 §1 第 4 条的口子）。 <br>**拍板理由（2026-09-21）**：核对 `useTags.ts` 时发现的不止重命名一处——**粘贴标签同样完全不落库**（`:83-98`），另外重命名里还在原地改 state 对象（`:174`）。三个缺陷连同复现步骤与修复方向已单独记录在 [桌面版标签写入不落库问题-待修](../../桌面版标签写入不落库问题-待修.md)。**本轮不动 `src/`**，桌面版修不修、什么时候修由验收人单独排期（不阻塞 M4a）。Rust 侧按正确语义实现，1.3 的对照基准为「TS 现行为 + 该文件的偏差清单」。 |

## 7. 任务状态记录

| 任务 | 状态 | 结果与备注 |
|---|---|---|
| A 前置：ICU collation 可行性实测 | **完成**（v5，2026-09-21） | 落点 `core/src/collate.rs`（`group_collator` / `order_collator(locale)` / `group_key` / `sort_tags`，带 5 个单测）。cargo-ndk 双 ABI 通过；arm64 so +1.35 MB(+22%)；组键对 30,463 输入零差异；`zh` 组内次序在真实词集上零差异。唯一偏差 = `en` + 含汉字标签的组内次序（ICU 数据版本差），M4a 恒传 `zh` 不可达。详见 1.2 的 ✅ 条与 1.3 的三档判据。 |
| 0.1 FFI 扩面（含 DTO 与按 id 读元数据） | **完成**（2026-09-21） | 26 个导出（原 5 + 新 21：人物 4 / 专题 14 / 元数据 3）。手写镜像 Record `FfiPerson`/`FfiTopic`/`FfiCoverCrop`/`FfiFaceBox`/`FfiFileMetadata`/`FfiPaginatedFiles`；`tags` 收成 `Vec<String>`、`ai_data` 透传 JSON 文本、`usize` 走 `i64`（不是原定的 `u64`，理由见 0.1 第 2 条）。6 个 DTO 往返单测过（空数组/null/引号/反斜杠/中文/emoji/非字符串元素）。**注意**：空标签写 `NULL` 而非 `"[]"`，因为 `get_all_tags_for_classification`（`file_metadata.rs:149`）按 `tags IS NOT NULL` 判有无标签。 |
| 0.2 绑定与双 ABI so | **完成**（2026-09-21） | `aurora_core.kt` 的 `fun` 齐、`FfiPaginatedFiles.total` 生成的是 `kotlin.Long`；arm64-v8a 与 x86_64 两份 so 每轮同批重编（时间戳一致，M1 那次就是漏了一个）。⚠ **本行 0.2 当时量到的 6,466,848 字节不含 ICU**：那轮 `collate` 还没有任何导出符号引用它，release 构建把 ICU 数据当死代码剥了。1.2 接上 `get_grouped_tags` 之后是 **8,454,064 字节（+2.30 MB）**，体积以 §7 的 1.2 行为准。 |
| 0.3 Kotlin 读写冒烟 | **完成**（2026-09-21） | 挂在调试广播 `am broadcast -a aurora.debug.FFI_SMOKE`（`FfiSmoke.kt`，沿用 M3 的 `aurora.debug.PINCH` 那条路；Release 不注册，不进主链路）。**平板 SM-X808U（arm64）`nonce=M4a03t1` 与模拟器（x86_64）`nonce=M4a03e1` 各一次，四项全 PASS**：person 8 字段、topic 13 字段 + 懒加载契约（列表 `fileIds` 恒空、`getTopicFiles` 拿得到成员、分页 `total=3`）、metadata 8 字段（tags 含引号/反斜杠/中文/emoji/空串），以及失败路径「不存在的 file_id 返回 null 不抛异常」。日志每行都带本轮 nonce。 |
| 1.1 标签读写原语下沉（四原语 + 批量粘贴判定） | **完成**（2026-09-21） | 表按 D10=② 建在 `db/tags.rs::create_table`（由 `init_db` 调，与 `topics` 同处）：`tags(tag)` + `file_tags(file_id, tag, position)`。**没照 D10 草表加 `sort_key` / `color` 两列**——组键是运行时按 ICU 算的（存 `sort_key` 只会过期），React 也没有逐标签颜色，两列都没有读方，按 §0「不留口子」删掉。批量粘贴**在轮内**：`add_tags_to_files` 单事务、已有成员不重复、新标签追加在尾部。<br>**落地时对清单改了三处，都是有意的**：① 原语 2 写成 `Vec<String> → JSON 列`会让 `file_metadata.tags` 与 `file_tags` 同时存在、迟早对不上，所以 **`file_tags` 是唯一真源**，安卓侧既不读也不写那一列（有单测钉住）；② 连带 **`FfiFileMetadata` 去掉 `tags` 字段**，桌面那条 JSON 路不受影响；③ 于是「整行覆盖会冲掉标签」这个 1.1 的 ⚠ **对标签不成立了**（两者不同表），先读后写只在 2.1 改元数据时还需要。导出 5 个：`set_file_tags` / `add_tags_to_files` / `get_file_tags` / `get_files_by_tag` / `get_all_file_tags`（原语 1 复用 0.1 的 `get_file_metadata`）。<br>**验收**：`db/tags.rs` 10 个单测过（保序、整体替换、去重去空、词表留住 0 计数的词、批量粘贴不重复不越界、空输入 no-op、全量映射按文件分组保序、建表幂等）；设备冒烟 `[FfiSmoke] PASS tags` 在**平板（`T11a`/`T11b`）与模拟器（`E11b`）各过一遍**，用的是库里真实的 `file_id`（不是合成 id），逐项含「两张图共用标签 → `getFilesByTag` 拿到这两张」与「给其中一张写描述 → 标签没被冲掉」。 |
| 1.2 词表与分组计数下沉（含 collation 路径） | **完成**（2026-09-21） | 四个动作全在 Rust：`add_tag_to_vocabulary`（trim 后非空才收、重复静默忽略，同 `useTags.ts:108-116`）、`rename_tag`（词表 + 所有文件同事务级联，D14 的「修正」）、`delete_tags`（一批标签一个事务，同 `:39-72` 的级联语义）、`get_grouped_tags(locale)`（返回 **`Vec<TagGroup>`**，不用 `Map`）。分组算法是 `collate::group_tags`（纯函数，不碰 DB，1.3 直接比它）；计数走 SQL（`tags ∪ file_tags` LEFT JOIN `file_tags`，所以「只在词表里」与「只在文件上」两种状态都不丢）。`tagSearchQuery` 按清单推荐**留在 UI 侧**，不过 FFI。**所有入口统一 trim + 去重 + 去空**（React 的 `customTags` 不过 trim，这一条比它严；否则一个词会存成两个形态）。<br>⚠ **ICU 体积本轮真正落进 so 了：arm64 6,157,144 → 8,454,064 字节，+2.30 MB / +37%**（v5 那条 +1.35 MB 是 keepalive 只引用了排序一条路径时的低估，分组路径接上后又涨了约 1 MB）。<br>**验收**：`db/tags.rs` + `collate.rs` 共 21 个单测；设备冒烟 `[FfiSmoke] PASS vocab` 在平板（`T12a`）与模拟器（`E12a`）各过一遍，覆盖「trim 只留一个形态 / 0 计数的词仍出行 / 前缀同形词落同一组 / 组名升序 / 重命名级联到文件且旧名从文件与词表都消失 / 删除级联」。冒烟顺带清掉了历轮遗留的冒烟词（平板 9 个、模拟器 6 个）。 |
| 1.3 一致性对照 | **完成**（2026-09-21） | `src/utils/__tests__/groupedTags.spec.ts` 9 项，`npm test` 全绿。**输入是真数据**：`test/fixtures/tag-input.json` 从桌面库 `~/Pictures/.aurora/metadata.db`（644 行元数据、530 行带标签）导出 661 个词 / 542 个文件，再补清单点名的边界（空标签、重名、只贴在文件上、只在词表里、纯 ASCII、纯数字、中英混排、多音字）。Rust 侧现编现跑（`core/examples/grouped_tags_dump.rs` 建内存库 → `tag_counts` → `group_tags`），不落会过期的 golden 文件，编译不过就是失败。<br>**实测三档结论**：① 组键与分组结构 **0 差异**；② `locale=zh` 组内次序 **0 / 665 差异**（逐位置全等）；③ `locale=en` 只有 **5 / 665 个位置不同、全部集中在 Z 组**，组名序列与每组成员集合仍完全一致——比 Part A 合成语料上「2211/2900」的悲观估计小两个数量级，因为真实标签都是 2~4 字词、共用前缀的少。<br>**踩到并修掉的假通过**：dump 最初输出成 JSON 对象，JS `Object.keys()` 会把 `"0".."9"` 这类整数样键提到最前，导致「组的先后」这一维根本没比到（Rust 明明把 `#` 排在数字前，解析那一刻就丢了）。改成一 `{key, tags}` 数组输出，顺序才真的进了断言；另加一条反向验证：Rust 的 zh 与 en 两次输出确实不同，证明 `locale` 参数不是摆设。 |
| 2.0 标签数据层（**清单外新增**，2026-09-21 起草人加） | **完成**（2026-09-21） | `GalleryViewModel` 持有 `tagsByFile` / `metadataById` / `tagGroups` 三份快照，唯一写者 `reloadTagState()`（全量重算，不做增量）。加这条的理由：2.2 抽屉、3.1 侧栏、4.1 过滤、4.2 面板四处都要这两份数据且都要求在写入后立刻变，分头查库=四份缓存配四套失效时机。发布点两处：`startScanIfNeeded` 里**先于**全量扫描（标签只读本地库，不该等 MediaStore），以及 `scanAndReconcile` 尾部（对账会清孤儿行）。<br>**验收**：`[Tags] reload groups=… taggedFiles=… meta=…` 在模拟器上确认了「扫描前一次 + 对账后一次」，并在 2.1 的真实写入后从 `0/0/0` 变到 `2/1/0`——非零才算验过。 |
| 2.1 编辑弹窗接库（先读后写） | **完成**（2026-09-21） | `onUpdateFile` 从 Toast 占位改成落库分支，**契约定死并写进 `NativeGalleryView.Listener` 注释**：camelCase、只带本次编辑的键、**缺键=不改不是清空**（清空描述是 `""`）。`tags`→`setFileTags` 整体替换；`description`/`sourceUrl`→`getFileMetadata` 读-改-写后 `upsertFileMetadata`。合并只做一次、收在 `GalleryViewModel.saveFileUpdates`，4.2 复用同一条。<br>**清单没提的第四个键**：`name`（查看器重命名弹窗也在走 `onUpdateFile`）。它改的是 MediaStore 的 `DISPLAY_NAME`、不是元数据行，**不写库**、单独立「将随 M4b 提供」占位——按清单原样接会把重命名静默吞掉。<br>**验收**：anim.gif 加 sunset/beach → 只改描述 → 读库确认两个标签仍在、`file_metadata.tags` 那列仍是 NULL（安卓不碰 JSON 列）→ `force-stop` 重启后 reload 计数不变。 |
| 2.2 抽屉显示真数据 | **完成**（2026-09-21） | `toViewerItem` 的 tags/description/sourceUrl 从 2.0 的三份快照取（`ViewerLayerHost` 多收两个参数），本文件不查库；palette / ai* 仍空态。胶囊删除叉在 `TagEditDialog` 里，走的就是 `setFileTags`（抽屉本体的胶囊是纯展示，与桌面同）。<br>**顺手补命中区**（移动端规范下限 48dp，实测原值）：标签弹窗的 ✕ 32dp、`+` 44dp、抽屉「+ 编辑标签」与「提取主色调」约 33dp、弹窗取消/保存 45dp（改在 `DialogUtils.createDialogButton` 一处，查看器八个弹窗同时到位）。<br>**验收**：`force-stop` 重进后抽屉显示库里的 sunset + 描述 + 来源网址；弹窗删掉 beach 保存后读库只剩 sunset；只改来源网址时描述没被冲掉。<br>⚠ **本轮末发现一个不属于 2.2 改动面的缺陷，见 §8「同一进程内第二次打开查看器，抽屉的动态内容整块不渲染」一条**（不影响 2.2 的验收结论：`force-stop` 后首次打开是完整的）。 |
| 3.1 侧栏三 Section（含拆掉 UI 侧重排） | **完成**（标签；人物仍空态）（2026-09-21） | 参数从 `groupedTags: Map<String, List<String>>` 换成 `tagGroups: List<TagGroup>`，**M1 那套 `values.flatten()` + `CASE_INSENSITIVE_ORDER` 已删**（它是全项目第三套标签排序规则），组名一行不可点的分隔标题、组内是带计数徽标的标签行，整行 48dp。Section 头部计数=词表条数。<br>**与桌面的一处形态差**：桌面侧栏 `TagSection` 其实是 `customTags ∪ 文件标签` 的**扁平** `localeCompare('zh-CN')` 列表（`TreeSidebar.tsx:576-603`），分组只出现在顶栏弹层与标签总览。Kotlin 侧栏按 §1「UI 只消费 Rust 返回的结构」渲染分组，所以 1.3 的「顺序一致」判据**对的是 `App.tsx:1263` 的 `groupedTags`，不是桌面的侧栏**——回填矩阵时别拿桌面侧栏当基准。<br>筛选态落 `TabState.activeTags` + `HistoryItem.activeTags`（不存历史的话「点标签→返回」退不掉），`openFolder` 与 `stepHistory` 同步维护。<br>**验收**：跨两个文件夹给两张图打同一个 sea → 侧栏出「标签 (1) / S / sea 2」，`beach` 这类 0 计数的词也照常出行（1.2 的词表语义）。 |
| 3.2 总览视图 | 未开始 | |
| 4.1 标签过滤接真数据（改签名 + 管道） | **完成，做法与清单不同**（2026-09-21） | 清单写的是「改 `filterImages` 签名 + 把标签映射喂进管道」，实际**没走这条路**：标签不当谓词、当**序列源**。`activeTags` 非空时 `GalleryViewModel.reloadImages` 直接调新增的 Rust 导出 `list_images_by_tags` 取**全库**命中的图。<br>**为什么改**：侧栏徽标是全库计数，只筛当前文件夹会在同一屏出现「徽标 5、点开 2 张」；且 React 的 `useFileSearch.ts:110-113` 本来就是 `allFiles` 全集过滤（`state.files` 全量），文件夹内筛选才是偏离。<br>新增：`db/tags.rs::images_with_any_tag`（并集 / 只认 `file_type='Image'` / `modified_at DESC` 三条语义，4 个单测钉住，含「一张图带两个命中标签只出一行」的 EXISTS 用例）→ `ffi.rs` 导出 → 双 ABI so 重编（arm64 8,447,696 字节）。`GridModels.kt` 那条「M2 再补 tag scope」注释改写成「别补在这里」并写明理由。<br>连带：取数收拢成 `reloadImages` 一个口 + 组合根 `LaunchedEffect(viewMode, folderId, activeTags)` 单触发点（旧 `openFolder` 的手写竞态守卫由结构化并发替代）；清空只在序列源真换时做，热刷新不闪白（这条是自查时抓出来的回归，已修并验）。<br>顶栏标签弹层（M1 三占位之一）同时接上：chips 可点带选中态、组序不再 `keys.sorted()`、关闭按钮 36→48dp。<br>**验收**：在 SmokeTest 里点 sea → 标题「标签 · sea」、网格出 SmokeTest 与 Pictures 各一张；进查看器左右翻只在这两张里且两头停住；弹层点 chip 取消筛选；系统返回退掉筛选并留在原文件夹。 |
| 4.2 元数据面板 | 未开始 | |
| 4.3 M1 占位收口 + 过期里程碑号清理 | 未开始 | |
| 5 验收与回填（含矩阵行标注 M4→M4a/M4b） | 未开始 | |

## 8. 交接要点（供下会话快速接续）

- **M3 的落点直接可用**：`viewer/`（查看器 + `dialogs/` 全套，`NativeGalleryView.Listener` 15 个回调已在 `MainActivity.kt` 的 `viewerListener` 里各就各位，本轮要动的就是 `onUpdateFile:164` 那一支）；`ui/components/DisplayPipeline.kt:18` 的 `rememberDisplayImages` 是网格与查看器**共用**的展示序列，改筛选必须从它改；`ui/theme/AuroraPalette.kt` 是唯一色表；`state/AppState.kt` 的 `ViewMode:21` / `HistoryItem:54` / `HistoryStack:69` 是加新视图的挂载点。
- **标签逻辑的四个真位置**（v1 引错两处，这里是核对过的）：分组与计数 `src/App.tsx:1263`；组键算法 `src/utils/textUtils.ts:1`（`Intl.Collator('zh-Hans-CN')` + 边界字表）；增删改 `src/hooks/useTags.ts`（新增 `:108`、批量粘贴 `:83`、删除级联 `:39`、重命名级联 `:163`，共 228 行）；词表持久化 `src/hooks/usePersistence.ts:35-44` 写、`src/hooks/useAppInit.ts:199` 读。
- **⚠ 桌面版有三处已知标签缺陷，本轮不修但必须知道**：重命名不落库（`useTags.ts:163`）、粘贴标签不落库（`:83-98`）、重命名原地改 state 对象（`:174`）。完整复现与修复方向见 [桌面版标签写入不落库问题-待修](../../桌面版标签写入不落库问题-待修.md)。**Rust 侧一律按正确语义写**（D14），1.3 的对照基准要带这份偏差清单，测试里把这两处标成预期差异而不是失败。
- **两个安卓 App 互不相干**：Kotlin 版是 `com.aurora.gallery.kotlin`，React 安卓版（Tauri）是 `com.aurora.gallery`——不同包、不同沙箱、**不同数据库**。所以 D10 新建的 `tags`/`file_tags` 表只存在于 Kotlin 版自己的库里，不影响正在出货的 React 安卓版，**不需要双写、也没有迁移可做**（v2 曾把这误判成冲突，别再绕回去）。
- **FFI 改动的完整链条在 [M1 清单 §7 行 364](./M1任务清单.md)**，含「x86_64 不重编模拟器必崩」这个坑；绑定文件在 `kotlin-app/app/src/main/java/uniffi/aurora_core/aurora_core.kt`（由 `core/kotlin-bindings/` 生成后复制），so 在 `kotlin-app/app/src/main/jniLibs/{arm64-v8a,x86_64}/`。**改 FFI 结构体时记得 `ffi.rs` 的约定是手写镜像 Record，不是给 `db::` 结构体加派生**（0.1 记了两条硬约束）。
- **真机测试环境**：Tab S8+ 无线 adb，序列号取 `adb devices -l` 里完整的 `adb-R52T701VA1J-…._adb-tls-connect._tcp`（会掉线，掉了要重连）；每条 adb 走 TLS 有 5~16s 建连延迟，时序敏感的操作必须在**设备端一条 shell** 里排好。
- **⚠ 平板会把退到后台的 App 整个冻结**（Samsung `FreecessController ... Frozen, Reason: Bg`）：冻结期间进程 `ps` 显示 `D`、所有线程停摆，唤回前台才继续——**不是卡死，也不是性能回归**。跑冒烟或量任何耗时前先把 App 拉起并保持前台；本轮就因此量到一个假的 `[Scan] cost=422775ms`。
- **⚠ 冒烟会写进真库**：`FfiSmoke.kt` 写的就是 App 正在用的那个 `aurora.db`。person / topic / 标签成员行用完都自删，但 `file_metadata` 没有「按 id 删」的导出（`delete_metadata_by_path` 没进 FFI），词表在 1.2 的 `remove_tag` 落地前也删不掉——**每跑一次留一行 `smoke-<nonce>-meta` 和 3 个 `冒烟<nonce>-*` 词**。整体验收前清一次：`adb -s <serial> shell "run-as com.aurora.gallery.kotlin rm /data/data/com.aurora.gallery.kotlin/files/aurora.db*"` 后重开 App（索引会重扫 MediaStore 重建）。
- **测试图**：`/sdcard/Pictures/m3test/`（GIF 640×360、`huge_8k.jpg` 7680×4320、`tall.jpg` 3000×12000、`shot_a.jpg` 1600×1200）平板与模拟器上都有一份；模拟器另有 `/sdcard/Pictures/bulk/` 60 张。用完再清，别在验收前删。**本轮还需要一份「有真实标签数据的桌面 .db」给 1.3/1.4 用**，D12 定了口径再 dump。
- **adb 驱动不了的手势**：真双指注不进去（`input motionevent` 只有单指），两次 `input tap` 也过不了 300ms 双击窗口——这类只能上手。另外进沉浸时系统弹的「Viewing full screen」确认窗会抢走 BACK 键，别当成 App 的 bug。
- **uiautomator 坐标**：`android_screenshot` 返回的图是缩放过的，**不要从截图读坐标**；一律 `uiautomator dump` 取 bounds（设备像素）再 `input tap`。
- **两处已知偏差，本轮顺手确认**：① 查看器顶栏图标是 88px，在平板 density 340 下约 41dp，低于移动端适配规范的 48dp（React 壳就是这样，M3 未改）；② 抽屉展开状态下转屏没测到（M3 5.1 遗留）。
- **`android_*_task_notification`（`lib.rs:739-765`）是 JNI→Tauri MainActivity 的桥，独立应用拿不到**——M4b 做任务通知时要在 Kotlin 侧自建，不要试图复用。
- **⚠ 未修的缺陷（2026-09-21 本轮末发现）：同一进程内第二次打开查看器，抽屉的动态内容整块不渲染**。复现：进文件夹 → 点开一张 → 开抽屉（文件名/文件夹/描述都在，主色调按钮、文件信息 5 格、标签胶囊 + 编辑按钮全空，**截图确认不是无障碍树的假象**）→ BACK 关抽屉 → BACK 关查看器 → 再点同一张 → 开抽屉即复现。`updateDrawer` 每次都进了日志（`paletteSize=0, loadingPaletteFileId=null`）、描述也赋上了，说明函数跑到底而 `removeAllViews()` + `addView()` 的三块没留下可见子 view。**`force-stop` 后第一次打开是完整的**，所以是复用 `NativeGalleryView` 实例（`MainActivity.ensureViewer()`）那条路径上的状态残留，不是 2.2 的数据接线问题。归属建议：M4a 阶段 5 验收前修掉——「查看器里编辑标签」是硬指标，第二次打开看不见就没法验。
- **⚠ adb 注不进非 ASCII 文本**：`input text "海边"` 抛 `NullPointerException … get length of null array`，模拟器也没有 `cmd clipboard`。所以中文标签要么**上手敲**（一次敲几个就够），要么本轮先用 ASCII 验链路、中文分组交给 1.3 的 Rust↔TS 对照。**别为了「能自动化」去加一个写标签的调试广播入口**——那是给主链路开后门。
- **第二台模拟器**：`aurora35` AVD 已把 `hw.gpu.enabled` 从 `no` 改成 `yes`、`hw.gpu.mode` 改成 `host`（这台机器上 `no` 会开机挂死），可与 `heid-tab35` 并存，序列号按端口分配（本次是 `emulator-5554`=heid-tab35、`emulator-5556`=aurora35，**别按端口猜设备**，用 `adb -s <serial> emu avd name` 确认）。`heid-tab35` 是验收人跑 H.I.D.E 的，不要往它上面装东西或点它。
- **aurora35 的库里 `meta=4`**：历轮冒烟留下的 `smoke-<nonce>-meta` 行（本清单 §8「冒烟会写进真库」那条预警兑现了）。整体验收前按同一条 `run-as … rm aurora.db*` 清一次。

## 9. v1 → v2 更正记录

代码引用逐条核对后改掉的错误，留档免得下次再踩：

| # | v1 的说法 | 实际 |
|---|---|---|
| 1 | `db_get_all_file_metadata:205` 是 async 且带 `normalize_path` | `normalize_path` 在 `db_upsert_file_metadata:194`；`:205` 只转发 `get_all_metadata`。担忧对象也跟着改：安卓侧要确认的是 `file_id`（content_uri 哈希）而非 path |
| 2 | 专题「`db_get_all_topics:96` 起共 13 个」 | 14 个（96 + 括号里列的 13 个）；人物 4 + 专题 14 + 元数据 2 = 20，与「20 个 command」相符 |
| 3 | `groupedTags` 派生在 `src/hooks/useFileSearch.ts` 与 App | 只在 `src/App.tsx:1263`（useMemo）。`useFileSearch.ts` 里没有这个符号 |
| 4 | 重命名/级联删除/分组计数「全在 `useTags.ts:35-70`」 | `:35-70` 只有 `requestDeleteTags` + `handleConfirmDeleteTags`；重命名在 `:163`；分组计数不在 `useTags.ts`（见第 3 条）。文件共 228 行 |
| 5 | `HashMap<String, Vec<String>>` 这类返回要配 Map record | UniFFI 0.32 原生支持 map 返回类型，不需要额外 record。真正撞墙的是 `serde_json::Value`（`file_metadata.rs:10/13`）与 `usize`（`PaginatedFiles.total`、`offset/limit`、`preview_count`），v1 两条都没提 |
| 6 | §0 验收标准只含标签链路 | 规划 §6 M4a 行还含「人物/专题同链路可读」与「三个占位转为真实行为」，v1 漏抄；已在 §0 补回并标出与 D11 的耦合 |
| 7 | 依赖图里 0.1 挂在 D10 下面 | 人物/专题/元数据与 D10 无关，D10 只影响 1.2 的词表落库。已摘出来，拍板前阶段 0 就能跑 |
| 8 | 依赖图有 0.3，正文与 §7 都没有 | 已补 §0.3 正文与任务表行 |
| 9 | 4.1「`GridModels.kt:57` 的 `filterImages` 只按文件名 contains，`SearchScope.TAG` 是摆设」 | 结论对，但 `filterImages` 签名里**没有 scope 参数**（`SearchScope` 在 `AppState.kt:24`），所以工作量是改签名 + 改管道 + 喂标签映射，不是填一个分支 |
| 10 | §5「对照矩阵中标注本轮的条目」 | 矩阵行内标注仍写 **M4**（只有表头 v3 记了 M4a/M4b 拆分），本轮条目无从筛起；已把「先拆行标注」写进 §5 |
