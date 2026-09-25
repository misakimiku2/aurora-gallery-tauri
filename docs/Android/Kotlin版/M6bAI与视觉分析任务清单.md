# M6b AI 与视觉分析任务清单

> 版本： v1（2026-09-25 起草：五路并行摸底结论回填 §0.1–0.5——AI 编排 TS 三处逐行／core 零 HTTP 设施／主色调 core 全齐但 ffi 零导出／CLIP gate·模型·EP·索引实测与 WD14 管线逐函数／Kotlin 挂载点清点；**D35–D41 待拍板**）
> 状态： **D35–D41 已拍板（2026-09-25 验收人），可开工；0.6 spike ①② 已完成**（结论 §0.6——回调通道定型并实测过；reqwest 体积 +4.3MB 超预估、ureq 对照 +2.7MB，**体积取舍待验收人过目，不阻塞阶段 1**）。七项拍板全按起草人建议（a 案）：D35=core 加 reqwest+UniFFI 回调、**D36/D37=互联态远程路线**（端上推理后置独立立项、spike ③ 取消——真机暂不可用亦不阻塞）、D38 子集、D39 双入口、D40 随 M6b 补、D41 文件夹摘要缩掉。结论详记 §7 行 0。（M6a 已于 2026-09-25 收口，提交 2249d32fa；本文档延续 M4a/M4b/M5/M6a 四份清单 §8 的全部交接要点——FFI 链条／平板冻结坑／联调同步纪律／词表两套别混，不重复抄录。）
> 配套： [规划](./安卓Kotlin版并行开发规划.md)（**§4-2 AI 编排下沉=本清单的需求原文**、§6 M6b 行）｜[矩阵](./三端功能矩阵.md)（表 4 四行、表 2 人物行、表 6 三行）｜[M6a 清单](./M6a互联与在线读写任务清单.md)（§0.6 摸底备忘=本清单前身；§7 行 5 登记①④=契约补端点输入；§7 行 8=验收人联调清单）｜[M4b 清单](./M4b系统集成任务清单.md)（D16 AI 面板改期、D17 通知基础版+按钮尾款）｜[AI服务商集成与优化-实现记录](../../AI服务商集成与优化-实现记录.md)｜[WD14-Tagger集成与优化记录](../../WD14-Tagger集成与优化记录.md)｜[主色调提取流程优化-实现记录](../../主色调提取流程优化-实现记录.md)｜[安卓端主色调提取功能实现记录](../安卓端主色调提取功能实现记录.md)
> 用途： M6b 的小步执行清单。每完成一个小任务更新对应行的状态。

## 0. M6b 目标与验收

- **M6b 范围（矩阵标注，八处）**：表 2 人物 PeopleSection（数据源）；表 4 四行（AI 打标/描述/重命名、CLIP 语义搜索/以图搜图、主色调提取/颜色搜索、人物管理的数据源半边——UI 半边 M4a 已达成）；表 6 三行（设置 AI 面板=D16 尾款、任务进度通知按钮=D17 尾款、存储/扫描面板的主色调与错误文件两节）。对应规划 §6 M6b 行六块：AI 编排下沉、主色调+颜色搜索下沉、人物数据源、CLIP 路线 spike 后拍、AI 面板、任务通知按钮。
- **验收标准（硬指标）**：矩阵标注 M6b 的条目全部达成（CLIP/人物两行按 D36/D37 拍板口径执行，降级须验收人明示）；**AI 全流程无 WebView 跑通**（规划 §6 原文）——AI 编排、进度、取消、写库全链在 core+Kotlin 完成，不经 Tauri 壳、不经 JNI 通知桥。
- **主链路判据（展开）**：设置 AI 面板配置 provider（连接测试过）→ 网格多选/查看器入口发起 AI 分析 → 后台逐张跑（进度可见）→ 通知按钮取消即时生效 → 结果写本地库（tags 进词表、description/aiData 整行读改写）→ 侧栏标签计数变化 + 查看器抽屉显示 AI 字段 → AI 重命名（AI 只产名字，改名走 M4b 重命名管线与系统授权）→ AI 搜索改写+过滤命中 → 主色调：查看器自动/手动提取 + StoragePanel 批量（暂停/恢复/取消三态）+ 错误文件管理 → 颜色搜索取色命中 → 人物：按 D37 路线产出真实 Person → PeopleOverview/侧栏出现本地人物（M4a 空态转真数据）→ CLIP：按 D36 路线（若=互联态远程，LAN 视图可语义搜索桌面库）。
- **明确不做 / 登记（起草人预案，随 D35–D41 拍板定稿）**：桌面 React 版 TS 编排**不动**（core 版为 Kotlin 用，桌面迁移不在本里程碑）；AI 文件夹摘要分支（useAIAnalysis.ts:44-297 的 5 步摘要任务）建议缩掉（D41）；端上 CLIP/WD14 本地推理若 D36/D37 拍互联态路线则登记不做（后置独立立项）；aiData.faces 恒空语义维持（无真人脸检测，矩阵 v8 更正——faces 是 WD14 标签匹配产物、box 恒 0）；LAN 态颜色搜索不做（远端无端点，本地库 only）；AI 整图 base64 不缩放=对齐桌面现状（手机大图体积/超时风险登记）；悬空设置 targetLanguage/confidenceThreshold 不复制进 Kotlin（D38）。
- **测试环境**：客户端 = avd_ai1 + avd_tab35 双 API 35 模拟器（真机复核随 Tab S8）；**AI provider 以确定性 mock 为主**（本机 node 起 OpenAI 兼容 `/chat/completions` 返回固定 JSON——M6a mock 桌面脚本同款手法，mock 返回内容不得含真实人名/敏感词）+ 真实 provider（Ollama/LMStudio，位置随验收人环境）冒烟一例；互联态远程路线（D36/D37 若走）联调沿用 M6a §8 纪律——主电脑（192.168.31.87）桌面端重建重启、SMB 句柄先释放。

## 0.1–0.5 摸底结论（2026-09-25 五路并行摸底，实现依据与验收对照）

### 0.1 AI 编排现状（TS 三处 + Rust 缺口）

- **useAIAnalysis.ts（579 行）**：严格逐张串行、无取消（:334）；三分支——openai `{endpoint}/chat/completions`（image_url data URL、max_tokens 1000，走 proxyHttpRequest，:386-414）、ollama `/api/generate`（images 数组裸 base64 + format:json，直接 fetch，:415-434）、lmstudio 补 `/v1` 且**自动改写 settings 里的 model**（:435-493，quirk 不复制）；prompt 按开关逐项拼行（:304-323，sceneCategory/objects **无条件加入**）；整图 base64 无缩放（:345-347，读取失败跳过该图）；parseJSON 容错=剥 \`\`\`json + 花括号段**从最后一个往前试 parse**（:358-384，为跳过思考前缀）；写库 dbUpsertFileMetadata **整行覆盖**（:526-534，不传 sourceUrl/updatedAt 也被覆盖——core 版必须整行读改写，M6a 1.2 同铁律）；tags 在内存合并旧集去重后随整行走。进度纯前端 useTasks（:327-328），无 Tauri 事件。
- **aiService.ts（620 行）**：checkConnection 按 provider 探测 `/models`、`/api/tags`、`/v1/models`（:17-44）；AI 重命名 generateSingleFileName（中文文件名 prompt+响应清理：剥 `<think>`、滤「分析/根据要求」行、去非法字符，:47-175）/generateFileNames（串行+每张 100ms，:178-220）；三对 call*（openai max_tokens 100 :223-249／ollama 手工转 messages :252-303／lmstudio :306-338）；fetchModels+7 天 localStorage 缓存（:349-406）。
- **useSearch.ts AI 搜索（:87-219）**：performAiSearch 输出**不是查询串而是 AiSearchFilter**（keywords/colors/people/description/originalQuery，:196-202）存入 tab 历史，失败回退普通搜索（:206-209）。**AiSearchFilter→结果集的过滤器应用逻辑是第四块要移植的 TS**（keywords/colors/people/description 各自匹配）。
- **设置**：user_data.json（db_commands.rs:32-43 写 app_data_dir，usePersistence 防抖 1s）；AIConfig 字段全表 types.ts:245-272（provider／openai{apiKey,endpoint,model}／ollama{endpoint,model}／lmstudio{endpoint,model}／autoTag/autoDescription/enhancePersonDescription/enableOCR/enableTranslation／targetLanguage/confidenceThreshold／systemPrompt/promptPresets/currentPresetId/onlineServicePreset）。**悬空确认**：targetLanguage 仅面板读写、运行时实际用 settings.language（useAIAnalysis.ts:39）；confidenceThreshold 全仓零消费（aiData.confidence 硬编码 0.95，:509）。Kotlin 版翻译目标语言直接用全局 language 设置（对齐实际行为）。
- **Rust 缺口**：core/Cargo.toml:17-29 **无 reqwest/tokio/任何 HTTP 与异步运行时**（下沉最大前置改动=D35）；src-tauri 有 proxy_http_request（system_commands.rs:274-309）与 read_file_as_base64（:214-241，无缩放）；**FfiFileMetadata 无 tags 字段**（ffi.rs:258-266）——tags 必须走 set_file_tags/add_tags_to_files（:718-745，M4a 词表管线），这恰好是 Kotlin 本地库的正确语义（AI 新词进词表），**别为 AI 给 FfiFileMetadata 加 tags 走整行 upsert**。
- **进度/取消模板（主色调通知桥，lib.rs）**：Rust 原子标志（CANCELLED/PAUSED）+ 独立 reporter 线程 1s 轮询 emit（:1035-1141）+ JNI 通知按钮→extern C 置标志（:600-666）。**Kotlin 独立版没有 Tauri event 也没有 JNI 桥**——等价物=UniFFI 回调接口（core 后台线程调 Kotlin 实现）或 Kotlin 轮询任务句柄，D35-② 一并拍。
- **桌面 UI 入口（对齐基准）**：批量/单张 AI 分析=右键菜单（ContextMenu.tsx:321 文件夹/:329 单张/:455 多选）+查看器菜单（ImageViewer.tsx:1875）；AI 重命名=MetadataPanel 按钮（:65）+批量 BatchRenameModal（AppModals.tsx:249-261）；AI 搜索=TopBar 紫色图标开关（TopBar.tsx:1023）开启后回车触发。

### 0.2 主色调与颜色搜索现状

- **core 侧算法与库全齐**：color_extractor.rs 的 get_dominant_colors(img,count)（color-thief 量化+频率 0.7/饱和度 0.3 加权+Lab 距离去重，:19）；color_db.rs 两表（dominant_colors 带 pending/processing/extracted/error 状态机 :918-928；image_color_indices :952-961）+ 全套 API（add_pending_files/get_pending_files/batch_save_colors/update_status/get_error_files/reset_error_files_to_pending/delete_error_files/cleanup_*/各计数，:978-1340）。**ffi.rs 零 color 导出**——提取、批读、搜索、统计、错误管理全部缺 UniFFI 面。
- **颜色搜索在 src-tauri 且桌面 only**：color_search.rs 的 search_by_palette（CIEDE2000，三模式：单色阈值 75／氛围≥5 色阈值 85／2-4 色阈值 88，截断 50000，:23-429）；注册在 `#[cfg(not(android))]` 块（lib.rs:1968-1973），安卓 handler 列表（:2094 起）不含。
- **lib.rs 安卓批量链路（React 壳专用，Kotlin 拿不到）**：android_batch_extract_colors（:977-1234）=pending 入队→rayon 6 worker→**Kotlin JNI 生成缩略图**（:918-952）→提取 8 色→reporter 1s→JNI 通知三态。Kotlin 独立版等价=core 批量循环+Kotlin 供像素（见下）。
- **桌面 UI 基准**：autoExtractPalette=查看器打开+开关开+当前图无 palette 时自动提取（App.tsx:2366-2417，写 color DB）；批量只有 StoragePanel 手动按钮（:193-233）+错误文件管理节（:915-1100）；颜色搜索=TopBar 调色板图标→ColorPickerPopover→`color:<hex>`（TopBar.tsx:786-801/:1007-1027），MetadataPanel 色块右键「搜索相似颜色」（:1718-1725）；前缀消费 useSearch.ts `color:`（:303-396，先查 colorDbStats 判数据量再搜）/`palette:`（:398-470）。
- **Kotlin 挂载点（M3 预留，全就位）**：Listener.onColorSearch（NativeGalleryView.kt:107-108）/onExtractPalette（:109-110）；ImageItem.palette/aiTags/aiDescription/aiSceneCategory/aiObjects（:144-148）；抽屉 Section 4 主色调（:424-431）带 loading/autoExtract/failed 状态机（:245-249、updateDrawer :806-930，含「提取主色调」48dp 按钮与色块点击→onColorSearch）；**MainActivity.kt:712-714 两回调均 toastSoon 占位**；aiTags/aiDescription 抽屉**无显示位**（ViewerItems.kt:19 登记）。
- **颜色键语义要拍（实现细节，非决策）**：dominant_colors.file_path 是桌面的绝对路径键；Kotlin 本地库稳定身份=file_id（content URI 哈希）——列不动、键传 file_id（MediaStore 改名 _id 不变→颜色行无需迁移联动，M4b ② 先例）。**输入形状**：AI=原文件字节（base64 格式透传，与桌面同限）；主色调=Kotlin 侧解码下采样位图→像素 buffer 传 core（对齐 React 安卓版「JNI 缩略图提取」现状，且兼容 HEIC——core 的 image crate 解不了 HEIF）。
- 无颜色名字典（全仓核实）；colors.db 落 Kotlin 自己的 app 数据目录（color_db::init_db(path) 现成）。

### 0.3 CLIP 与 WD14 现状

- **gate 实测**：lib.rs:13-20 `#[cfg(not(android))]` 包住 clip/clip_commands/work_extractor 三模块；ort(directml)/ndarray/tokenizers(onig)/csv 是 Cargo.toml:77-86 的 target-specific 依赖。**这些全在 src-tauri——Kotlin 版只链 core，架构上就够不着**（要给 Kotlin 用=搬 core，非「解开 gate」即可）。
- **模型与推理**：So400M≈4.23GiB（dim 1152）／Base≈1.40GiB（dim 768）／WD14≈1.17GiB（dim 10861=标签概率向量作特征）；下载 hf-mirror URL 硬编码（无 HF_ENDPOINT 环境变量）、断点续传+进度事件、存 `~/.aurora_cache/clip/{模型}/`；EP=Windows DirectML 失败回退 CPU、非 Windows 恒 CPU（**无 NNAPI/XNNPACK 集成**，端上要另加）；索引 `{库根}/.aurora/embeddings/{模型}/embeddings.db`；搜索=全量载入内存暴力余弦（So400M 每张 4.6KB、WD14 每张 43KB——9.8 万张 So400M≈450MB 内存）。
- **WD14 人物管线（逐函数）**：嵌入批量生成（AIVisionPanel.tsx:776 手动触发，clip_generate_embeddings_batch clip_commands.rs:267，IS_GENERATING 互斥）→ clip_generate_tags_from_embeddings（:1195-1330，probs→通用/角色标签→写 file_metadata.tags，不写 ai_data）→ clip_create_work_topics（:1899-2275，SmartCreateTopicModal.tsx:376 入口）：category==4 角色标签、**阈值 min_score=0.1**（嵌入第 tag_index 维≥0.1 即命中）→extract_work_name 映射作品→`person_{tag}` upsert_person（face_box=None）→`work_topic_{work}` 建 Topic→link_files_to_persons（:1009-1120）写 aiData.faces（box 恒 0、confidence 1.0）。**前提=先用 WD14 对全库生成过嵌入**。
- **Kotlin people 现状**：FFI 导出全就位（get_all_people/upsert_person/delete_person/update_person_avatar+topic-people 四个，ffi.rs:542-682）；PeopleOverview **只渲染 lanPeople（远端）**（TagsOverview.kt:251-321），本地 getAllPeople 仅备份导入/导出用（MainActivity.kt:363/:435）——安卓本地库零人物产生管线。
- **LAN 服务端搜索=纯文件名**：/api/search 走 search_by_name LIKE+FS 回退（handlers.rs:1778；core file_index.rs:755），无向量能力、服务端无模型加载路径——「互联态远程搜索」端点完全空白（D36 若走则新增契约端点，照 M6a 契约定稿格式：0 通用约定→既有端点表→新端点小节→事件汇总→错误码总表）。
- kotlin-app 无 clip/ort 残留（grep 仅命中 Compose `Modifier.clip` 与 FfiSmoke 测试字符串）。

### 0.4 Kotlin 侧挂载点（现成的与缺的）

- **现成**：后台任务组合拳先例（lanFetchJob :204／initialScanJob :218／mediaChangeJob :224 的 Job 句柄+cancel+relaunch、scanMutex.withLock :825、Dispatchers.IO 惯例、失败保留旧数据 :1276-1281）——AI 批量任务整套照搬；ScanNotifier.kt（aurora_scan Channel，:12-15 注释明示「按钮回传+主色调/AI 任务的完整版随 M6b（M6b 只需在同一个 Channel 上加 action）」）；设置双形态**共用 CategoryContent**（SettingsDialog.kt:191-262，新 AI 面板只改 SettingsCategory :174-186+CategoryContent 一处，平板/手机自动双形）；查看器 AI 字段与回调（0.2）；FfiSmoke 调试广播先例（aurora.debug.* :1321-1340；M6a 的 LanSmoke 已删、FfiSmoke 保留）；okhttp 4.12 已是依赖（D35 若选 HTTP 留 Kotlin 可直接用）。
- **缺（硬项）**：AppSettings 无任何 AI 键（AppSettings.kt:18-28、键表 :214-233）——provider/endpoint/apiKey/model/五开关全要新增；AI 编排 core 模块（0.1）；主色调 ffi 导出面（0.2）；人物产生管线（0.3）；抽屉 AI 字段显示节；TopBar 搜索的 AI 开关与颜色搜索入口。

### 0.5 core 与构建链现状

- core 39 个导出（DB 基础／人物 4／专题 11／元数据 3／标签 9／缩略图/ID），40 个单测（collate 9+ffi 4+tags 21+file_index 5+file_metadata 1）；无 android 专属 feature/gate，crate-type cdylib+rlib；color_db 有 std::thread::spawn 后台预热先例（:295-315）——core 起后台线程合法，但**无通用进度/取消设施**（要新建，D35-② 形状）。
- so 构建链（M1 清单 :364 完整链条）：cargo build→uniffi-bindgen generate→cargo ndk -t arm64-v8a 与 -t x86_64（x86_64 不编则模拟器缺符号必崩）→installDebug；scripts/kotlin-dev.ps1 -So 只编 arm64（日常快链）。**core 加 reqwest 后 spike 必须双 ABI 全过+体积记录**（M6a 收口基线：arm64 8,541,904B／x86_64 8,284,888B）。

### 0.6 spike（**已完成 2026-09-25**，①② 全过、③ 取消——结论即阶段 1 的实施依据）

- **① core+reqwest 编译与体积：编译面 PASS、体积超预估如实记**。reqwest 0.12.28（`blocking`+`rustls-tls`、default-features off；blocking 客户端自带 tokio 运行时线程，core 不直接依赖 tokio）双 ABI cargo ndk 编译过、core 40 测全绿；**体积 arm64 8,541,904→12,871,624B（+4.33MB，+50.7%）、x86_64 8,284,888→12,569,056B（+4.28MB，+51.7%）**——远超「1–2MB 级」预估（reqwest+hyper1+rustls+ring+tokio 实价；h2/http2 已被 default-features off 排除，无 feature 可再裁）。**ureq 3.2 对照**（本地副本 `C:\rust-target-m6b\core-ureq`，rustls+webpki-roots、未上机）：arm64 11,225,816B（**+2.68MB，+31.4%**），省 1.65MB。**体积取舍待验收人过目后定死（reqwest=设备实测过的默认 / ureq=更轻但只有编译证据）；不阻塞阶段 1 开工**——HTTP 层在 core 里是隔离的一薄层，随时可换。
- **② 回调通道：定型并实测通过**。`spike_ai_channel` 临时导出 + `SpikeCallback` 回调接口（on_progress/on_finished）：**uniffi 0.32 回调代理非 Send，不能 move 进 worker 线程**——通道形状定型为「worker 线程 → mpsc 事件 → 调用线程泵循环驱动回调」（Kotlin 从 IO 线程调导出函数即可；阶段 1 的取消走全局 AtomicBool 注册表，同样不需要回调跨线程）。emulator-5554 实测（host node mock @10.0.2.2:18081）：正路径 65ms 回流 mock 响应体（含首次 Client 构造）；死地址恰 15.0s 超时、`send_err` 原样上浮。证据 `log/m6b-spike/s1-aispike-logcat.log`；调试钩子=MainActivity 的 `aurora.debug.AI_SPIKE` 广播（收口时与 spike 导出一并删）。
- **③ 取消**（D36/D37 拍互联态，端上推理后置独立立项）。
- **spike 期间新增环境坑三条（后续会话直接用）**：① SMB 网络盘上 debug 链接报 link.exe 1450（reqwest 引入后对象数暴涨+网络盘）——`CARGO_TARGET_DIR=C:\rust-target-m6b` 本地盘全会话沿用即愈；② gradle 增量缓存损坏复发且 `--stop`+删 app/build 不再够——`-Pkotlin.incremental=false` 过（5 分钟清洁构建）；③ 本机 crates.io index 不通，新增依赖的解析须 `--offline` 走本地缓存（reqwest/ureq 全套已缓存）。

## 1. 拆分原则（延续 M4b/M5/M6a §1，M6b 特有五条）

- 延续项全部有效：一次任务一次提交带任务号（`M6b-1.1: ...`）；每步双模拟器跑通且确认跑的是新路径再提交；颜色只取 AuroraPalette.kt；弹层复用 Aurora 系菜单组件；UI 只消费数据层算好的结构。
- **「写一次」落地口径（规划 §4-2）**：prompt 组装／解析容错／provider 请求形状／写库语义全部进 core；Kotlin 只剩「选图→发任务→显示进度」。桌面 TS 编排不动、不迁移（登记），core 实现以 TS 行为为对齐基准（单测快照对拍，含 parseJSON「从最后一个花括号往前试」这类怪癖）。
- **写库铁律两条**：① AI 结果写 metadata 走**整行读改写**（core 读旧行→只改 AI 字段→整行写回；TS 版「不传 sourceUrl 也被覆盖」的缺陷不复制，M6a 1.2 同款教训）；② tags 走 add_tags_to_files 进词表（M4a 语义），不走 FfiFileMetadata。
- **通知与任务**：任务通知按钮在同一 aurora_scan Channel 加 action（ScanNotifier.kt:15 原文）；AI 任务=cancel 单态（对齐 TS 无暂停）、主色调批量=暂停/恢复/取消三态（对齐 React StoragePanel）；后台任务一律 GalleryViewModel 的 Job 句柄+IO+mutex 组合拳（0.4 先例）；force-stop 重启不留僵尸 pending（processing→pending 恢复用 color_db 现成函数）。
- **入口对齐桌面、形态复用 M4a–M6a 既有组件**：AI 分析入口=网格多选菜单+文件夹长按+查看器菜单（桌面 ContextMenu 三处对位）；AI 重命名走 M4b 重命名管线（系统授权弹窗复用）；取色 UI 形制照 ColorPickerPopover/MobileColorPickerSheet 的取色交互收敛为触屏版。

## 2. 依赖关系图

```
0.6 spike（①core+reqwest 编译体积 ②回调通道 ③端上推理[按需]）

1 AI 编排下沉 core（provider 客户端/prompt 组装/parseJSON 容错/
   整行读改写+tags 词库/任务句柄+进度取消/单测对拍 TS 行为）
   └── 2 Kotlin AI 任务 UI＋AI 面板＋通知按钮（入口/AI 重命名/搜索改写过滤/
             抽屉 AI 字段显示/设置面板/AppSettings 新键）

3 主色调与颜色搜索（ffi 导出面：单张/批量/统计/错误管理/批读/搜索下沉；
          Kotlin：查看器接线+StoragePanel 两节+取色搜索入口）——与 1/2 并行

4 人物数据源（D37 路线：互联态 compute 卸载端点 or 端上 WD14）
5 CLIP 路线（D36 路线：互联态远程搜索端点 or 端上）＋契约附录（含 D40 若拍）
   （4/5 都动 LAN 契约，与桌面端共用一次主电脑重建联调）

6 收口核对与验收（矩阵八处回填/销账/体积对比/黑盒用例/真机复核）
```

- 阶段 3 与 1/2 完全并行（颜色导出与 AI 模块在 core 内互不相交）；4/5 被 D36/D37 gate，若都走互联态则共享一次契约定稿与桌面联调。

## 阶段 1：AI 编排下沉 core（Rust）

### 1.1 基础设施
- core 加 HTTP 依赖（D35）；任务句柄设施（D35-②形状）：AiTaskHandle{cancel/快照(current,total,state)}+回调接口（进度/字节供给）；后台线程逐张循环（每张迭代首查 cancel）。
- **验收**：spike ①②结论回填本清单；cargo check 过；demo 双 ABI 编译+模拟器运行过。

### 1.2 provider 客户端与纯函数层
- AiProviderConfig（uniffi Record，AIConfig 子集）；三 provider 请求构造（openai image_url data URL／ollama 裸 base64+format:json／lmstudio 补 `/v1`）；check_connection/fetch_models；prompt 组装（开关→行、sceneCategory/objects 无条件）；parse_json 容错（对齐 TS 算法）；响应→FfiAiResult{description,extractedText,translatedText,tags[],category}。
- **验收**：单测对拍 TS 行为——prompt 快照（开关组合矩阵≥4 例）、parseJSON 用例集（markdown 包裹/思考前缀/多花括号/非法 JSON）、三 provider 请求体形状（本地 TcpListener mini mock server）。

### 1.3 编排循环与写库
- `ai_analyze_files(config, file_ids)`：逐张=回调取字节→base64→HTTP→解析→**整行读改写**（读旧 metadata→改 description/category/ai_data→写回）+tags 合并旧集去重走 add_tags_to_files；`ai_rename_files`（中文文件名 prompt+响应清理）；`ai_rewrite_search_query`→FfiAiSearchFilter+`ai_apply_search_filter` 纯函数（keywords/description 即期，colors/people 挂钩阶段 3/4 数据源）。
- **验收**：AI_SMOKE 调试钩子（aurora.debug.AI_SMOKE，FfiSmoke 风格）对 mock provider 跑 3 张假图全链——库行变化+词表新词+进度回调+取消生效；40 既有测试不破。

## 阶段 2：Kotlin AI 任务 UI＋AI 面板＋通知按钮

- **数据层**：GalleryViewModel 挂 aiJob/aiTaskState（idle/running(current,total)/done/error）；analyzeSelection/analyzeFolder/analyzeSingle/renameSelectionWithAi/performAiSearch；完成后刷新对应缓存（M4a 管线）；AI 分析为本地库功能、无 allow 门禁。
- **入口**：网格多选菜单「AI 分析…」「AI 重命名…」；文件夹卡片长按「AI 分析文件夹」（递归收集未分析图，对齐桌面 handleFolderAIAnalysis）；查看器菜单单张「AI 分析」；AI 搜索=TopBar 搜索旁 AI 图标开关（桌面紫色图标对位）→改写→AiSearchFilter 过滤。
- **AI 面板（D38 范围）**：SettingsCategory.AI 占位→真面板——provider 三选、endpoint/apiKey/model、连接测试、模型列表刷新、五开关（autoTag/autoDescription/enhancePersonDescription/enableOCR/enableTranslation）、systemPrompt 单框；翻译目标语言用全局 language 设置；AppSettings 新键（apiKey 明文存 prefs——桌面同为明文 user_data.json，登记）。
- **通知按钮（D17 尾款）**：AI 任务通知（进度 current/total+取消 action），ScanNotifier 同 Channel 扩展、不动既有扫描通知形态。
- **抽屉 AI 字段显示**：aiTags（复用标签节视觉）/aiDescription 接 ImageItem 既有字段（现在无显示位）。
- **验收**：mock provider 全链（多选 3 图→进度→完成→侧栏计数变+抽屉显示+force-stop 重启数据在）；通知取消 1 张内停；AI 重命名经系统授权弹窗后名字生效且元数据挂住（M4b 语义）；AI 搜索改写+keywords 过滤命中；真实 provider 冒烟一例。

## 阶段 3：主色调与颜色搜索（与 1/2 并行）

- **ffi 导出面**：init_color_db(path)／get_colors_by_file_paths（批读，网格/查看器缓存用）／extract_and_save_colors(file_id, pixels,w,h)（单张，Kotlin 供像素）／batch_extract_colors（后台批量+暂停/恢复/取消）／统计+错误文件五件套（get/retry/delete/cleanup_nonexistent/cleanup_stale）／**search_by_color+search_by_palette 从 src-tauri 下沉 core**（CIEDE2000 三模式原样）。键=file_id（0.2 语义）。
- **Kotlin 接线**：查看器 onExtractPalette→单张提取→抽屉色块显示（autoExtract 语义对齐 App.tsx:2366-2417：打开+开关开+无 palette 自动提取；loading/failed 状态机已就位）；色块点击→onColorSearch→颜色搜索；StoragePanel 主色调节（批量按钮+统计分布+错误文件管理，React StoragePanel :915-1100 形制）；取色入口（D39）→search_by_color→结果集视图（色库无数据时提示先批量提取，对齐 useSearch :310-324）。
- **批量循环**：core 后台线程（pending 队列+状态机），Kotlin 回调供缩略图像素；三态通知按钮；processing→pending 恢复（force-stop 中断自愈）。
- **验收**：单张/批量/暂停恢复取消/错误重试删全链；HEIC 图提取成功（像素路径）；颜色搜索与桌面同库同查询排序一致（对照一例）；批量 500 张模拟器进度与内存稳定。

## 阶段 4：人物数据源（D37 拍板路线落地）

- **a) 互联态 compute 卸载（起草人建议）**：LAN 契约新增 `POST /api/wd14/classify`（multipart 图片字节→{general_tags, character_tags[score]}，**纯计算端点：不入桌面索引、不落桌面库**，D32 互联即授权门禁）；Kotlin 批量选图→逐张上传→general_tags 走本地词表管线、character_tags 经作品归组（extract_work_name 等纯函数下沉 core 共享）→`person_{tag}`+`work_topic_{work}` 写本地库→PeopleOverview/侧栏出现本地人物（M4a 空态转真数据）。离线时入口置灰（登记：人物数据源依赖互联；端上路线后置）。
- **b) 端上 WD14**：ort+android EP+模型下载进手机（spike ③ 数据 gate）；clip 最小面（wd14 模型+probs→tags+嵌入索引）搬 core。体量≈独立里程碑，除非验收人明示否则不建议本期做。
- **验收（a 路线）**：选 5 图→classify→本地库出现人物+专题+tags（curl 半链+app 全链双证）；桌面库与索引零残留；断线中途入口置灰、已写部分保留。

## 阶段 5：CLIP 路线（D36 拍板路线落地）＋契约附录

- **a) 互联态远程搜索（起草人建议）**：LAN 契约新增 `POST /api/clip/search_text`（{query,min_score,max_results}→LAN paths+scores；桌面无嵌入索引时显式错误码）与 `POST /api/clip/search_image`（本地图字节→桌面 embed→搜桌面库）；**手机本地库的语义搜索/以图搜图在此路线不做**（本地图无嵌入索引——登记差异，端上后置）；顺带补上 M6a 登记的「LAN 视图无搜索入口」（文件名 /api/search 先接，语义模式叠加）。契约附录照 M6a 契约定稿格式。
- **D40 若拍补**：成员枚举端点（GET /api/topic/members?topic_id= + people 图片列表）+桌面词表读端点（LAN 标签编辑词表建议）同批进契约——M6a 行 5 登记①④销账，远端人物/专题点击从 Toast 占位转真筛选。
- **验收**：LAN 视图文本语义搜命中且分数合理（桌面已建索引前提）；以图搜图（本地图→桌面相似图）；无索引时明确报错；D40 端点若做：点远端人物/专题出筛选视图。

## 阶段 6：收口核对与验收

- **矩阵回填（八处）**：表 2 人物行、表 4 四行、表 6 三行——达成/差异（AI 搜索范围、文件夹摘要缩掉、CLIP/人物路线、悬空设置不复制等）一并备注。
- **销账**：全仓「随 M6b/M6 占位」清零（SettingsDialog.kt:95/:241/:762、ScanNotifier.kt:15 注释更新、ViewerItems.kt:19、MainActivity.kt:712-714 两处 toastSoon、TreeSidebar PeopleSection 注释 :414、AppState TabState 注释 :153-156）；AI_SMOKE 类调试钩子按 M6a 先例收口时删。
- **体积对比**：core 加 reqwest（若 D35a）后 so 双 ABI 增量如实记录（基线=M6a 收口值）；APK 清洁构建对照 M4b/M6a 口径。
- **黑盒用例（mobile-ui-tester，双模拟器）草案 11 条**：① AI 面板配置+连接测试（mock）；② 批量 AI 分析 3 图进度+完成+库验证；③ 通知取消；④ 查看器单张+抽屉 AI 字段；⑤ AI 重命名；⑥ AI 搜索改写过滤；⑦ 主色调单张+抽屉；⑧ 批量主色调三态+错误重试；⑨ 颜色搜索取色命中；⑩ 人物管线（D37 路线）；⑪ CLIP 远程搜索（D36 路线）。环境准备（mock provider 起法）写进用例本体；真机复核（Tab S8+真实 provider+弱网）随验收人。
- **回归**：本地库主链路（M4a 打标→筛选→查看器→编辑）+M6a LAN 抽三例（连接/抽屉回写/断线清理）+M5 画布进出——确认 AI/颜色任务没砸既有管线。

## 6. 关键决策点（编号接 M6a 的 D34；**2026-09-25 已全部拍板**，结论记 §7 行 0——全部按起草人建议（a 案），下表建议列保留作历史）

| # | 决策 | 起草人建议 | 说明 |
|---|---|---|---|
| D35 | core HTTP 依赖与任务通道 | **a：core 加 reqwest（rustls、default-features off）+ UniFFI 回调（进度/取消/字节供给）** | 「写一次」原则的正解（桌面未来可迁）；spike ①② gate——编译/体积不可接受落 b：HTTP 留 Kotlin okhttp、core 只做 prompt/parse/写库纯函数（编排拆两半，登记为妥协）。rustls 根证书 webpki-roots；局域网 http 明文 M6a 已放行。 |
| D36 | CLIP 端上路线 | **a：互联态远程搜索端点（LAN 视图搜桌面库）** | 体量小（契约+两端接线）+桌面 GPU/索引现成；**手机本地库语义搜索/以图搜图在此路线不做**（本地图无嵌入索引），登记差异。b=端上推理：ort android EP（现无 NNAPI/XNNPACK 集成）+模型 1.2–4.2GiB 下手机+暴力余弦内存（So400M 9.8 万张≈450MB）——spike ③ 数据 gate，建议后置独立立项而非本里程碑。 |
| D37 | 人物数据源（WD14） | **a：互联态 compute 卸载端点**（手机字节→桌面 WD14→tags 回手机本地库） | 桌面算力现成、手机零模型负担；端点设计为纯计算（不入桌面索引）不违反「桌面库唯一权威源」（§5.3 口径管的是数据归属，计算服务不落库）。b=端上 WD14（1.17GiB 模型+CPU 推理，spike ③ gate）。c=缓做（people 维持仅 LAN 远端）=矩阵人物行降级，须验收人明示。 |
| D38 | AI 面板范围 | **a：子集**——provider/连接测试/模型刷新/五开关/systemPrompt 单框；**prompt 预设管理与在线预设不带**（登记差异） | 预设管理是桌面锦上添花；悬空设置 targetLanguage/confidenceThreshold 不复制进 Kotlin（targetLanguage 用全局 language、confidenceThreshold 零消费——桌面债登记不修）。 |
| D39 | 颜色搜索入口 | **a：双入口**——查看器抽屉色块点击（回调现成）+TopBar 全局取色器 | v15 备忘「查看器抽屉扩展或恢复面板二选一」的落地建议：抽屉入口零成本先接（对齐桌面 MetadataPanel 色块右键「搜索相似颜色」语义），全局取色器对齐桌面 TopBar 调色板图标；「恢复右侧面板」形态最重不取。 |
| D40 | M6a 遗留契约补端点（成员枚举+词表读） | **a：随 M6b 补**（与阶段 5 同批动契约，桌面一次重建联调） | M6a 行 5 登记①④：GET /api/topic/members、people 图片列表、词表读——补齐后远端人物/专题点击从 Toast 占位转真筛选、LAN 标签编辑有词表建议。b=拆独立补丁先做（若嫌与 M6b 合并体量大）；c=维持占位（不建议，M7 前总要清）。 |
| D41 | AI 功能范围（文件夹摘要） | **a：缩掉文件夹摘要分支，登记差异** | useAIAnalysis.ts:44-297 的 5 步摘要任务依赖全库已分析的 description 汇总，独立于逐张主链；桌面保留、Kotlin 后置（真实需求出现再补）。 |

## 7. 任务状态记录

| 任务 | 状态 | 结果与备注 |
|---|---|---|
| 0 摸底与拍板 | 完成 | 摸底=五路并行（2026-09-25，结论 §0.1–0.5）。**D35–D41 已拍板（2026-09-25 验收人，全部按起草人建议 a 案）**：D35=core 加 reqwest（rustls、default-features off）+UniFFI 回调，spike ①② 实证门保留（FAIL 自动落 b=HTTP 留 Kotlin）；D36=CLIP 互联态远程搜索端点（手机本地库语义搜索/以图搜图登记不做，端上后置独立立项，spike ③ 取消）；D37=WD14 互联态 compute 卸载端点（纯计算不入桌面索引，离线入口置灰）；D38=AI 面板子集（预设管理不带、targetLanguage/confidenceThreshold 不复制）；D39=颜色搜索双入口（抽屉色块+TopBar 取色器）；D40=成员枚举+词表读端点随 M6b 同批补；D41=文件夹摘要分支缩掉登记差异。真机 Tab S8 暂不可用不阻塞（自验=双模拟器+mock provider+主电脑桌面端；真机项全在阶段 6 复核位）。 |
| 0.6 spike | 完成（2026-09-25） | ①编译 PASS+体积超预估（arm64 +4.33MB/+50.7%、x86_64 +4.28MB；ureq 对照 +2.68MB 未上机）——**体积取舍待验收人过目，不阻塞开工**；②回调通道定型（mpsc 泵形状，uniffi 回调代理非 Send 的规避）+ emulator-5554 实测正/负路径全过（65ms 回流/恰 15s 超时上浮），证据 log/m6b-spike/；③取消。环境坑三条记 §0.6 末。 |
| 1 AI 编排下沉 core | 完成（2026-09-25，emulator-5554 对宿主 mock provider 全链实测过） | 分工=纯函数层/provider 客户端（`core/src/ai.rs`，子智能体逐行对齐 TS）+任务设施（`core/src/ai_task.rs`，主线程）。**1.1 基础设施**：reqwest blocking（spike ①② 结论沿用）+base64 0.22；取消注册表（task_id→AtomicBool，`ai_cancel_task` 返回在册与否）；**锁步双通道泵**（worker↔mpsc 事件含 NeedBytes 请求、字节经第二通道回执——uniffi 回调代理非 Send 的完整形态，读字节/进度/完成回调全在调用线程）。**1.2 纯函数层（80 测全绿=40 旧+40 新）**：prompt 组装逐字对齐（框架句断言）、parse_ai_json（手写花括号扫描等价 TS 正则+从最后往前试）、三 provider 请求形状经 TcpListener 迷你服务验证（路径/Bearer 头/ollama images+format:json/lmstudio /v1/温度/模型兜底）；**TS 源码事实五条入档**：aiData 形状{analyzed,analyzedAt,description,tags,sceneCategory,confidence:0.95,dominantColors:[],objects,extractedText?,translatedText?,faces:[]}（关的开关字段空值/缺键）、**category=旧值透传（AI 不产出，sceneCategory 只进 aiData）**、systemPrompt=system role/ollama body.system、**ollama 重命名走 /api/chat 而非 generate（AiChatKind 三分）**、搜索 keywords 匹配 tags/description/objects **不匹配文件名**且 filter.description 是 AND 条件（useFileSearch.ts:64-100 为真实逻辑）。**1.3 编排+写库**：ai_analyze_files（逐张=回调取字节→base64→chat→parse→**整行读改写**[source_url 恒保留、description 关→保留旧值=TS null 覆盖的稳化偏差、category 透传]+tags 合并去重走 add_tags_to_files）/ai_generate_file_names（AI 只产名字+100ms 礼貌间隔）/ai_rewrite_search_query（originalQuery 由导出层回填）/ai_apply_search_filter/ai_check_connection/ai_fetch_models。**E2E（六模式全 PASS，证据 log/m6b-spike/s1-ai-stage1-e2e.log）**：分析×3 provider（3 图写库+词表+进度+断言 description/category=null/sceneCategory/ confidence/tags 全对）、改名（3 名产出）、搜索（改写回流+AND 语义命中）、取消（慢端点 8s/张，取消后 2 张完成即停=「迭代首查、在途不打断」文档化语义）、restore 全绿（元数据还原+mock 词清理）。**实机修 3 测试预期**（管线零缺陷）：category 断言按 TS 透传事实改、取消语义断言按文档化行为放宽、apply 数据按 AND 语义重构。登记：fetch_models 失败回退预设表不带（core 无预设表，交 UI 层）；endpoint 尾斜杠统一 trim（TS 三处不一致的稳化）；超时 chat 300s/探测 15s（桌面无超时）；体积 arm64 13,123,808B（spike 后再 +252KB=AI 模块）。 |
| 2 Kotlin AI UI＋面板＋通知按钮 | 未开始 | |
| 3 主色调与颜色搜索 | 未开始 | |
| 4 人物数据源 | 未开始（D37 待拍） | |
| 5 CLIP 路线＋契约附录 | 未开始（D36/D40 待拍） | |
| 6 收口与验收 | 未开始 | |

## 8. 交接要点（开工前读；M4a/M4b/M5/M6a §8 的通用坑不重复抄）

- **对齐基准是 TS 行为，包括怪癖**：parseJSON「从最后一个花括号往前试」（跳思考前缀）、ollama/lmstudio 直接请求而 openai 走代理、lmstudio 自动补 `/v1`——这些是互操作性现实不是「不规范」，core 版逐条对齐，别「顺手标准化」（M6a 协议对齐纪律同款）。唯一明示不复制的 quirk：lmstudio 自动改写用户 model 设置。
- **写库双铁律**（§1）：metadata 整行读改写（不复制 TS「不传也覆盖」缺陷）；tags 只走词表管线（FfiFileMetadata 无 tags 字段是架构事实不是缺陷）。
- **两套库别混的新形态**：阶段 4/5 的远程端点全部「纯计算/纯查询」——手机图字节过桌面内存可以，**落桌面索引/桌面库不行**（upload 端点会入索引，compute 端点别复用 upload 的落盘路径）；回写只进手机本地库。
- **so 构建链**：core 动 Cargo.toml（D35a）后必须双 ABI 全编（x86_64 不编则模拟器必崩，M1 教训）；uniffi-bindgen 重新生成别忘（M1 清单 :364 完整链条）。
- **mock 纪律**：AI/WD14 mock 返回的 JSON 不用真实人名/敏感词（M6a 共享根切根同因）；主电脑联调重建纪律沿用 M6a §8（服务端版本与代码同步、SMB 句柄先释放）。
- **三个验收人最可能追问的数字，如实记**：reqwest 进 core 的 so 双 ABI 增量（spike 已测：+4.33MB/+4.28MB，ureq 对照 +2.68MB）；批量主色调 500 张的耗时/内存；AI 整图 base64 的大图体积（手机相机 50MP 一张 base64 上行数十 MB——对齐桌面现状但要在验收时说清）。
- **本机（.174）构建环境 2026-09-25 起的三个既成口径**：core 一切 cargo 命令带 `CARGO_TARGET_DIR=C:\rust-target-m6b`（SMB 盘链接 1450 的规避）；gradle 装 APK 带 `-Pkotlin.incremental=false`（增量缓存损坏复发）；cargo 加新依赖后解析带 `--offline`（crates.io index 不通、本地缓存已备齐）。
