# M6a 互联与在线读写任务清单

> 版本： v1（2026-09-24 起草：四路并行摸底结论回填 §0（服务端/React 客户端基准/对等服务端/Kotlin 挂载点+桌面失效钩子）；D29–D34 待拍板，**D29=M6 拆分本身**，通过后本清单生效）
> 状态： **D29–D34 已拍板（2026-09-24 验收人），可开工**——D29=拆分（M6a 先行）、D30=a（Kotlin 原生对等服务端）、**D31=推翻起草人建议：桌面来源的标签/人物/专题并入现有侧栏对应 Section＋网络来源标识**（「网络」栏仅区分本地/网络文件夹）、**D32=推翻起草人建议：不新增开关、互联即授权**（allow_edit/allow_upload 默认改 true，403 仅手动收紧时出现）、D33/D34 按起草人默认（zxing-android-embedded＋okhttp；保存到系统 Downloads）。结论详记 §7 行 0。M5 已执行完成（2026-09-23 + 2026-09-24 用户反馈修正三笔 1974609d/9199e4a1a，Tab S8 真机复核随验收人安排）；本文档延续 M4a/M4b/M5 三份清单 §8 的全部交接要点（FFI 链条、平板冻结坑、手势自动化坑、测试数据坑，不重复抄录）。
> 配套： [规划](./安卓Kotlin版并行开发规划.md)（**§5.3 在线读写唯一实施方案**=本清单的需求原文、§6 M6 行）｜[矩阵](./三端功能矩阵.md)（表 5 全表七行、表 1 LAN 文件夹总览、表 2 NetworkSection、表 6 LAN/AI 面板行）｜[M4b 清单](./M4b系统集成任务清单.md)（D16 LAN/AI 面板改期 M6、D17 通知基础版）｜[M4c 清单](./M4c设置界面对齐任务清单.md)（设置双形态 D26；AI/LAN 两个 placeholder 分类现成）｜[M5 清单](./M5画布与比较器任务清单.md)（查看器 isLan 门控先例）
> 用途： M6a 的小步执行清单。每完成一个小任务更新对应行的状态。

## 0. M6a 目标与验收

- **M6 拆分提案（D29，先拍这个）**：规划 §6 的 M6 原文四块（LAN 客户端/上传；AI 任务；桌面互联；§5.3 在线读写）拆成 **M6a 互联与在线读写**（本清单）+ **M6b AI 与视觉分析**（AI 编排下沉 Rust、AI 面板、主色调批量+颜色搜索、人物数据源、CLIP 路线、任务通知按钮——另立清单，M6a 收口后起草）。理由三条：① 矩阵标 M6 的 17 处条目分属**纯网络**与**模型推理**两条技术线，体量超 M4 拆分前（M4 当年因「一次性做完体量过大且无中间态」拆成 M4a/b/c）；② 风险隔离——CLIP/WD14 端上推理是大坑（0.6 备忘：clip 被 cfg 排除在安卓构建外、模型 1.2–4.2GiB），不应阻塞互联交付；③ 依赖单向——M6b 不依赖 M6a，M6a 先行可尽早兑现验收人 2026-09-21 的在线读写拍板（§5.3）。
- **M6a 范围（矩阵标注，九处）**：表 1 LAN 文件夹总览；表 2 NetworkSection；表 5 的 LAN 客户端浏览 / LAN 上传 / 桌面浏览安卓设备（互联对等）/ 扫码连接 / 标签人物专题跨端可见 / 元数据跨端在线编辑 / 文件跨端在线操作（七行）；表 6 设置 LAN 面板（AI 面板随 M6b）。
- **验收标准（硬指标；2026-09-24 D32 拍板后修订）**：矩阵标注 M6a 的条目全部达成；**互联态改标签 → 桌面端可见且不被桌面后续操作覆盖**（§5.3 已知风险的闭环验证）；403/菜单不可用场景仅在用户**手动关闭**既有 allowEdit 开关时验证（互联默认全权，见 D32）。
- **主链路判据（展开）**：扫码（或手输）连接桌面 → LAN 文件夹总览（`__lan_root_images__` 置顶）→ 网格 HTTP 缩略图浏览 → 查看器看 LAN 大图 → 查看器内改标签/描述回写桌面 → 桌面端不手动刷新即可见（失效事件）→ 桌面对同图再改 → **两边改动共存不互吞** → 互联态重命名后桌面库与文件一致且元数据挂住（默认全权直通；另验一例手动关 allowEdit 后菜单不出现+403）→ 上传一张桌面浏览出现新图 → 断线 → 侧栏带标识的远端条目消失、LAN 视图退出无残留、本地条目与本地库不受影响 → force-stop 重启后连接恢复（token 未过期场景）→ 本地库主链路（打标签→筛选→查看器→编辑）与 M5 画布未被砸。对等服务端：桌面 NetworkSection 发现本机设备并浏览缩略图。
- **明确不做 / 登记（M6a 内）**：离线同步（已否决，矩阵表 5）；LAN 内容缓存进本地库（不缓存不合并，§5.3/§5.4——注意 D31 改的是**显示层**合并，数据层不缓存不合并维持）；**视频项**——React 的 LAN 浏览含视频项（矩阵表 1 备注），但 Kotlin 全 App 的视频支持待定 M8+，第一版 LAN 网格过滤 `type=video`，差异登记矩阵；**桌面→手机方向的写操作**——D32 口径下默认放权，但对等服务端协议本无写端点且手机侧写要走系统授权弹窗，本期只交付桌面浏览手机（阶段 7 登记）；CLIP 语义搜索 / AI 任务 / AI 面板 / 任务通知按钮 / 主色调与颜色搜索（全归 M6b，见 0.6 备忘）；画布不收 LAN 图（M5 既有 `!isLan` 门控维持）。
- **测试环境（2026-09-24 已落实并冒烟验证；同日共享根由 `E:/图包` 切换为 NVIDIA 游戏截图目录——验收人要求测试截图不得带敏感内容）**：**服务端 = 主电脑桌面端**（`192.168.31.87:8080`，访问码 9928）；新共享根含 9 个游戏截图子目录（Apex Legends、鸣潮、绝区零、少女前线2 等，`/api/all_image_folders` 实测）；本机（模拟器宿主）= `192.168.31.174`，与主电脑同 /24 网段——模拟器出站经宿主网络栈直达 LAN，不涉及 10.0.2.2 回环问题（模拟器实际连通性随 0.7 spike 实测）。客户端 = avd_ai1 + avd_tab35 双 API 35 模拟器；最终验收口径 = Tab S8 真机与主电脑同网段联调（真机无线 adb 的时序坑沿用 M5 §8）。**注意两条**：① 切根后 `/api/browse` 吐旧索引的问题**复验已消除**——完全重启桌面端后 browse 返回新根 21 个游戏目录（应用内刷新无效，见 0.1 实测）；② 新根**根级散图为空**（图都在游戏子目录）——阶段 4 的 `__lan_root_images__` 置顶用例需临时往根目录放一两张散图才有数据。

## 0.1–0.6 摸底结论（2026-09-24 四路并行摸底，实现依据与验收对照）

### 0.1 桌面服务端现状（src-tauri/src/lan_share/）

- **17 条路由**（server.rs:125-144 注册，handlers.rs 实现）：静态页 3（`/`、`/style.css`、`/app.js`）＋ auth 2（`/api/auth/verify` 4 位 access_code 换 Bearer token、`/api/auth/logout`）＋ `/api/browse?path=`、`/api/palette?path=`、`/api/all_image_folders`、`/api/search?q=&scope=`、`/api/thumbnail?path=&size=&token=`、`/api/image?path=&token=` ＋ `/api/file` DELETE（allow_edit）＋ `/api/rename` POST（allow_edit）＋ `/api/upload` POST multipart（**allow_upload**）＋ `/api/devices`、`/api/heartbeat`。鉴权统一 Bearer token（`extract_token` handlers.rs:1635；缩略图/大图额外支持 `?token=` query）；SESSION 3600s / 心跳 5s / 在线判定 15s（types.rs:191-196）。
- **零元数据端点（M6a 服务端最大缺口）**：tags / description / sourceUrl / people / topics 无任何读写端点；`BrowseItem`（types.rs:128-148）也没有这些字段（name/path/type/size/thumbnail/preview_images/width/height/modified_at/palette）。桌面库的 tags 在 `file_metadata.tags` JSON 列、词表在 user_data blob（`load/save_user_data` db_commands.rs:32/46）——**服务端按桌面语义实现，不引入安卓侧 file_tags 表的双轨**（M4a D10 的表是 Kotlin 本地库的）。
- **现有三个写端点全是裸文件操作、不动桌面索引**：delete 只 `fs::remove_file`（handlers.rs:852）、rename 只改名（:909）、upload 只写文件（:1028）。而桌面 `file_id` = 路径哈希，**rename/move 必须走 `file_operations.rs` 的实现**（`rename_file:314`/`delete_file:473`/`copy_file:540`/`move_file:674`，自带 db 元数据迁移）——M6a 服务端改造的核心就是让 LAN 写端点全部改道 file_operations，并把上传的新文件入索引（否则桌面 browse 走 DB 路径看不到新文件）。
- **allow_upload 疑云已核实（2026-09-24）**：桌面**没有任何 UI 开关**——App.tsx:120 默认 false、LanSharePanel 只有 allowEdit toggle、Rust 默认 false（types.rs:22）。即 LAN 上传当前实际不可达（除非手改持久化 JSON）。处置 = D32。
- **事件先例**：`emit_devices_changed`（handlers.rs:35-39）→ Tauri 事件 `lan-share-devices-changed`，无负载、前端收后主动回拉——`lan-share-data-changed` 照抄这个范式。
- **已知死代码＋协议 bug（登记，阶段 2 顺手删）**：`HttpAdapter.deleteFile`（发 JSON body，服务端读 query）与 `renameFile`（字段名 `oldPath/newPath`，服务端要 `old_path/new_name`）与服务端不符（HttpAdapter.ts:56-74）；Web 页实际走 `src/lan-share/api.ts`（query 风格，正确），不受影响。
- **切根后 browse 吐旧索引（2026-09-24 实测，阶段 1 的直接输入）**：共享根从 `E:/图包` 切到 NVIDIA 截图目录后，`/api/browse` 仍返回旧库的 343 个文件夹（DB 优先、索引未随根变更失效），而 `/api/all_image_folders` 因 DB 查不到回退扫盘、返回新根的真实文件夹——同一服务端两路由各说各话；**点应用内刷新无效，完全重启桌面端后 browse 才按新根返回（21 个游戏目录、旧列表消失）**。失配问题本身仍归阶段 1 修（不能要求用户靠重启兜底）：browse 的 DB 查询要以当前共享根为界，根对不上就走 FS 回退（与 upload 入索引同类）。
- **安全边界（登记风险，不主动加固）**：4 位明文访问码 + CORS Any（handlers.rs:1770-1775）+ 无 TLS + token 进 URL query（缩略图/大图 URL 需要）。信任内网的现状设计；写能力上线后维持桌面默认 allow_edit=false，验收人若要求加固另立任务。

### 0.2 React 客户端行为基准（lanClientApi.ts / useLanClientSync.ts——Kotlin 逐条对齐的对照表）

- 连接生命周期：请求 15s 超时（lanClientApi.ts:52-73）；心跳 5s，连续 3 次失败或 401 → 清连接（logout + 停本机服务端 + 清 token + toast，useLanClientSync.ts:209-256）；未连接每 15s 周期重试（:124-176）；25s 加载卡死保护（:56-64）；token 过期立即清（:89-99）。
- 扫码：QR 内容 = JSON `{"type":"aurora-lan","url":"http://ip:port","code":"4位"}`（qrParseUtils.ts:24-48，兼容旧版纯 URL、默认端口 8080）；连接信息持久化 settings.lanShare（serverHost/Port/AccessToken/clientMode），「最近服务器」savedServers 含 accessCode 上限 10 条一键重连；设备名/设备 ID 各自 localStorage。**桌面二维码生成为外网服务 api.qrserver.com**（LanSharePanel.tsx:31-33）——离线环境显示不出，Kotlin 侧如需展示二维码应内置本地生成。
- 图片加载：HTTP 直连 URL（`getThumbnailUrl/getImageUrl`，token 进 query），无客户端磁盘缓存，靠 HTTP cache（服务端 max-age 600/300）。
- 上传：multipart FormData（字段 `file` + `target_dir`，lanClientApi.ts:317-343），逐个上传后 reload。
- React 端现状的缺口（= Kotlin 直接做全量的依据）：`allow_edit` 随 browse 下发但**无人消费**（无编辑 UI）；rename/delete 客户端函数已就绪但 useFileOperations 无远程分支（实际不可用）；move/copy 两端都没有。**对齐基准取「协议与服务端行为」，UI 形态以 §5.3 拍板为准做全量**。
- 断线行为：清连接链路里还会停掉本机对等服务端（`lanShareAndroidStop`）——Kotlin 的对等服务端（阶段 7）同款联动。

### 0.3 对等服务端（桌面浏览安卓设备的机制）

- React 安卓版**自己跑一个 axum 服务端**（`src-tauri/src/android/server/`，10 端点：auth 2 + browse/palette/all_image_folders/search/thumbnail/image/devices/heartbeat；**无 rename/delete/upload**；browse 的 `path` 参数 = bucketId 语义；`allow_edit` 恒 false；复用桌面 lan_share 的 types/session/device_manager）。
- 双向配对：手机认证桌面时携带 `peer_server{port,access_code}`（lanClientApi.authenticate）→ 桌面 emit `lan-share-peer-pairing`（handlers.rs:45-65）→ 桌面 App 注册 androidClientRegistry + 反向认证 + 写 settings.lanShare.androidClients（App.tsx:958-970 一带）。之后桌面可浏览手机，心跳 5s×3 失败移除、15s 自动重连（useAndroidClient.ts）。
- Kotlin 两条路（D30）：**a) Kotlin 原生实现 10 端点协议**（协议面窄；数据面 = Kotlin 侧现成的 MediaStore 查询做服务化；起草人建议）；b) UniFFI 托管 Rust `android/server`——但其数据面是 Rust 经 JNI 回调 Kotlin 的 MediaStore 扫描（`call_kotlin_*` 桥），与本项目「MediaStore 在 Kotlin 侧、FFI 只碰 db」的架构正相反，要拖整套 JNI 桥进 core。

### 0.4 Kotlin 侧挂载点（现成的与缺的）

- **现成**：侧栏「网络」骨架行（TreeSidebar.kt:334-342，WifiOff 占位、注释「M6 接入后按 connected 恢复」）；设置 AI/LAN 两个 placeholder 分类（SettingsDialog.kt:186-205，LAN 占位文案就是「桌面互联：局域网共享 / 扫码连接 / 文件互传」）；查看器 `ImageItem.isLan/thumbnailUrl/palette/aiTags/aiDescription…` 字段（NativeGalleryView.kt:111-134，M3 预留）与 `onExtractPalette/onColorSearch` 回调（:97-100，M6b 用）；「加入画布」与分享的 `!isLan` 拦截分支已写好（:1798-1807/:1837-1839，接真数据自动生效）；Coil 2.7.0 自带 http fetcher（okhttp 4.12 传递依赖，`ImageSource.kt:54` 的 isLan 分支已把 path 直交 Coil——缺缓存键）；`openCanvas/openTopic` 的 ViewMode+历史栈导航样板可复制。
- **缺（硬项）**：`INTERNET` 权限（manifest 没有，硬阻塞）；明文 HTTP 策略（API 28+ 默认禁 http，需 networkSecurityConfig 或 usesCleartextTraffic）；显式 HTTP 客户端依赖（okhttp 未声明）；扫码库（无 CameraX/zxing/ML Kit）；`ViewMode` 无 LAN 枚举（AppState.kt:30-32）、`reloadImages` 不认 LAN 序列源（GalleryViewModel.kt:1050-1052）；网格缩略图 `ThumbnailLoader` 绑死 MediaStore Long id（要加 URL 分支）。

### 0.5 桌面内存态失效钩子（§5.3 已知风险的落点）

- **现成可复用**：`handleRefreshTags`（useDirectoryScan.ts:309-334，全表读 file_metadata 把 tags 回写 `state.files` 并重建词表）——metadata 类失效直接调它；`filesVersion` 随 `state.files` 引用变化自动 bump（App.tsx:143-146），下游 memo 全部自动失效，无需新机制；`notifyRemoteChange()`（remoteSource.ts:97-122）清 `lan://` 前缀缩略图缓存并广播重解析。
- **要新建**：people/topics 没有独立重载函数（逻辑内联在 useAppInit.ts:158-197、useDirectoryScan.ts:186-222/:406-441 三处）——抽 `reloadPeople()/reloadTopics()` 公共函数；`lan-share-devices-changed` 现唯一消费点是 LanSharePanel 的设备列表，**数据失效零消费**——新增 `lan-share-data-changed` 事件 + 桌面分派消费。
- **验收判据的落点**：「不被桌面后续操作覆盖」= 桌面的整行 upsert（useTags 删除级联/AI 打标）都基于**内存里的旧行**——事件到达后重读受影响行，旧内存行被替换，后续整行 upsert 才带着安卓的改动走。这是 M6a 必须闭环的链路（写进阶段 2 验收）。

### 0.6 M6b 相关摸底备忘（本轮一并摸底，M6b 清单起草时引用，不在 M6a 执行）

- **AI 编排全在 TS 三处**：useAIAnalysis.ts（579 行主流程：Ollama/OpenAI/LMStudio 三分支、prompt 按开关拼字段、整图 base64、严格顺序无取消、parseJSON 容错、dbUpsertFileMetadata 整行写）＋ aiService.ts（AI 重命名 generateSingleFileName/generateFileNames、三对 call* 函数、checkConnection/fetchModels）＋ useSearch.ts:87-193（AI 搜索的 query 改写，同构三服务商分支）。Rust 侧只有 `proxy_http_request` CORS 代理（system_commands.rs:274-309）与 base64 读取（:215-241）；**core crate 无 reqwest**（下沉的最大前置改动）；写库 upsert 已在 core/ffi（ffi.rs:690）。任务通知桥「Rust 线程→JNI 通知→按钮事件回传」闭环（lib.rs:1050-1154/600-666）是 AI 任务进度/取消的现成模板。悬空设置：`targetLanguage`（被 settings.language 顶替）与 `confidenceThreshold`（无引用）。
- **主色调**：提取算法与颜色库全在 core（color_extractor.rs + color_db.rs），安卓批量提取/通知/错误文件管理的 Tauri 命令在 lib.rs（JNI 桥，Kotlin 拿不到——要 core 化导出）；**颜色搜索 `search_by_palette` 在 src-tauri（color_search.rs）且只注册桌面 handler**——要下沉 core + UniFFI 导出。autoExtractPalette 语义=查看器单张自动提取（App.tsx:2311-2356），批量只有 StoragePanel 手动按钮。
- **CLIP「零成本继承」判断有误（矩阵已更正）**：clip 三模块被 `#[cfg(not(target_os="android")]` 整体排除（lib.rs:13-20，ort/tokenizers 等依赖同为桌面 gate）；模型 So400M≈4.23GiB / Base≈1.40GiB / WD14≈1.17GiB 运行时下载（hf-mirror）；推理 GPU 仅 Windows DirectML，安卓要换 execution provider（NNAPI/CPU）；搜索是全量载入内存的暴力余弦。端上落地路线（本地推理 vs 互联态远程搜索端点 vs 只上 WD14）是 M6b 的核心决策，先 spike 后拍。
- **人物数据源**：无真实人脸检测（useAIAnalysis 的 faces 恒空数组，useAIAnalysis.ts:516）。真正产生 Person 的是 **WD14 角色标签管线**：`clip_create_work_topics`（clip_commands.rs:1899）→ `upsert_person`（id=person_{tag}）→ `link_files_to_persons` 写 `aiData.faces`（box 恒 0，是标签匹配不是视觉人脸框）。Kotlin 侧 people 的 ViewMode/侧栏/空态/FFI 五函数全就位（FfiSmoke 已验证），只差数据源。
- **任务通知按钮**：Kotlin ScanNotifier（M4b）已预留「同一 Channel 加 action」的扩展位（ScanNotifier.kt:14-15）；React 侧按钮回传事件范式 = `color-extraction-notification-action`。

### 0.7 spike（已完成，2026-09-24——阶段 1/3 开工的前置结论全落本节）

**进度（2026-09-24 全部完成）**：本机（192.168.31.174）curl 预验（auth 换 token `expires_in:3600`；browse/all_image_folders 真实数据＋尾部 `allow_edit:true, allow_upload:false` 实证；path 形态随共享根而变按**不透明字符串**回传）之后，剩余三项在 **emulator-5554（API 35）app 内全部实证 PASS**——okhttp auth → all_image_folders/browse → Coil 缩略图 → QR 编码解码一条龙（logcat `[LanSmoke m0]` 逐条 PASS 佐证；取证文件在 `C:\Users\misakimiku\AppData\Local\Temp\aurora-m6a-spike\`）。结论分条：

- **① 连通口径**：模拟器 → `http://192.168.31.87:8080` **直达可用**（AVD 出站经宿主网络栈 NAT 到宿主 LAN，10.0.2.2 回环不需要，备选路径未触发）；服务端 8080 对 192.168.31.0/24 现状放行，无需额外开洞。真机口径 = 同网段 Wi-Fi 直达（本 spike 未复验，Tab S8 阶段随验收安排）。
- **② 依赖引入清单（已落 app/build.gradle.kts，保留）**：`com.squareup.okhttp3:okhttp:4.12.0`（对齐 Coil 2.7 传递版本）、`com.journeyapps:zxing-android-embedded:4.3.0`（自带 zxing core 编解码；CaptureActivity 需 appcompat 主题，app 已有 1.6.1；minSdk 24 对齐）。manifest 新增 `INTERNET`＋`ACCESS_NETWORK_STATE`。
- **③ 明文 HTTP 配置形状**：networkSecurityConfig 的 `<domain>` 不支持裸 IP 段/CIDR，LAN IP 直连场景收敛不了到网段——实际可用且已实测生效的形状 = `res/xml/network_security_config.xml` 的 `<base-config cleartextTrafficPermitted="true" />`（manifest 引 `android:networkSecurityConfig`，不另用 usesCleartextTraffic 属性），API 35 上明文 http 全通。阶段 3 照此落地；后续要收紧只改这一个文件。
- **④ Coil 结论**：「Coil 2.7.0 自带 http fetcher」成立——`ImageRequest.data(httpUrl)` 直接出图（`/api/thumbnail?path=&size=256&token=` 实测出图 256x107），**无需额外 fetcher 依赖或 ImageLoader 配置**。两个实现注意：`imageLoader.execute` 是 suspend（非协程上下文要 runBlocking 包一层）；token 进 query 的 URL 要用 %20 形态编码（URLEncoder 的空格 `+` 得 replace 掉，对齐 React 的 encodeURIComponent）。
- **⑤ 扫码结论（D33 落地确认）**：zxing-android-embedded 集成通，**相机实扫未验**——Tab S8 息屏且无线 adb 唤不醒（物理对准本就无法自动化），已实证两条：ⓐ ScanContract 起 CaptureActivity＋运行时 CAMERA 权限请求＋取景预览＋取消回调全链（模拟器截图佐证）；ⓑ zxing 编码→解码 roundtrip＋桌面契约 JSON（`{"type":"aurora-lan","url":…,"code":…}`）解析取 url/code PASS。**阶段 3 注意**：从广播接收器起 CaptureActivity 被三星 BAL（后台起 Activity 限制）拦截——真实入口（设置 LAN 面板点击）是前台路径不受影响，调试广播钩子只在 app 前台时可用。
- **⑥ spike 代码处置**：验证代码**保留**（`LanSmoke.kt`＋MainActivity 的 `aurora.debug.LAN_SMOKE` / `aurora.debug.QR_SCAN` 调试广播，FfiSmoke 同款风格、零主链路侵入）——阶段 3 联调要复用，LAN 面板落地后删；配置（manifest / networkSecurityConfig / gradle 依赖）按 ②③ 保留为阶段 3 地基。
- **⑦ 遗留项**：① Tab S8 相机实扫（真机已装好 app 并预授权 CAMERA；二维码 PNG 已备 `aurora-lan-qr.png`，全屏显示后 `adb shell am broadcast -a aurora.debug.QR_SCAN` 即可扫，注意先亮屏且 app 在前台）；② 真机同网段连通复验（预期直达）；③ allow_upload 位在 D32/1.5 改默认值后复测直通/403 路径。

## 1. 拆分原则（延续 M4b/M5 §1，M6a 特有四条）

- 延续项全部有效：一次任务一次提交带任务号（`M6a-1.1: ...`）；每步双模拟器跑通且**确认跑的是新路径**再提交；颜色只取 `AuroraPalette.kt`；弹层一律复用 Aurora 系菜单组件；UI 只消费数据层算好的结构。
- **服务端新端点一律复用 core db 原语与 file_operations**（带 db 迁移的四个原语），不在 lan_share handler 里写第二套「动文件+迁库」逻辑（规划 §3.1 逻辑写一次）；元数据写端点在**服务端**整行读改写（§5.3 拍板原文），不让客户端拼整行传上来。
- **Kotlin 客户端行为逐条对齐 0.2 基准**（超时/心跳/清理时序表即验收对照表），别自创时序；协议层（路由形状、query/body 风格、token 位置）逐字对齐服务端，别「顺手规范化」。
- **命名空间口径（§5.3，2026-09-24 D31 修订）**：**数据层两套、显示层合并**——桌面来源的标签/人物/专题并入现有侧栏对应 Section，条目带网络来源标识（头像旁/行前小图标）；点远端条目=进 LAN 视图筛远端图；断线后带标识条目随连接消失。数据层铁律不变：桌面词表不进本地词表、桌面数据不落本地库、本地过滤不扫桌面数据。
- token 进 URL query 是协议现状（Coil 的 URL 模型需要），维持；写端点全部走 header token（服务端现状如此）。

## 2. 依赖关系图

```
0.7 spike（HTTP/cleartext/Coil http/模拟器↔宿主连通/扫码冒烟）＋服务端契约定稿

1 服务端扩展（Rust lan_share：元数据批量读＋写、词表、people/topics、
  move/copy 新端点、rename/delete/upload 改道 file_operations＋索引一致性、
  data-changed 事件、allow_upload 开关）
   ├── 2 桌面端失效消费（React：事件分派＋reloadPeople/reloadTopics 抽取＋顺手删 HttpAdapter 死代码）
   └── 3 Kotlin 客户端基础栈（权限/明文配置/okhttp/LanClient 状态机/扫码/
              设置 LAN 鞭板/网络 Section 接通）
            └── 4 LAN 浏览视图（ViewMode＋FoldersOverview LAN roots＋网格 URL 缩略图＋
                      查看器 LAN 缓存键＋上传＋保存到设备）
                      ├── 5 在线元数据读写（D31：远端条目并入现有侧栏＋网络标识＋查看器回写＋词表）
                      └── 6 互联态文件操作（rename/delete/move/copy＋桌面目录树选择器＋403 与菜单态）

7 对等服务端（D30 路线；依赖 3 的连接栈，与 4–6 可并行推进）
8 收口核对与验收（矩阵九处回填/真机联调/体积对比/黑盒用例）
```

- 阶段 1 是枢纽（2 与 3 的客户端/桌面端都消费它的契约）；契约定稿（字段名、错误码、事件 payload）在 1.0 一并落文档，2/3 按契约并行。
- 本里程碑**预期零 FFI 改动**（Kotlin 侧不碰 uniffi.aurora_core——LAN 会话是纯 HTTP；若 7 选 D30b 则除外，见决策表）。

## 阶段 1：服务端扩展（Rust，桌面 lan_share）

### 1.0 契约定稿
- 新端点形状表（路径/方法/请求/响应/错误码/门禁）+ `lan-share-data-changed` 事件 payload（`{kind: "metadata"|"files"|"people"|"topics"}`，不带大数据、前端回拉——emit_devices_changed 范式 handlers.rs:35-39）。落本清单附录或独立 md，2/3 按此并行。
- **验收**：契约评审过（起草人+验收人各看一眼），后续端点实现不得偏离契约改字段名。

### 1.1 元数据读端点（批量）
- `POST /api/metadata/batch`（或 GET+paths，定稿时拍）：入参 path 列表，出参每项 `{path, tags[], description, source_url}`；服务端 path→file_id→file_metadata 批量读（core 侧缺「按列表批量取」就照规划 §5.3 的说法补一个批量原语，别逐条查）。
- **验收**：curl 批量取 20 项一次返回；不存在的 path 显式缺省不报错整批。

### 1.2 元数据写端点（整行读改写）
- `PUT /api/metadata`：`{path, patch:{tags?, description?, source_url?}}`；服务端读旧行→只改传入字段→整行写回（file_metadata.rs:22-29 的覆盖语义，§5.3 铁律）；**新词进桌面词表**（load_user_data→customTags 并集→save_user_data）；allow_edit 门禁 403；发 `data-changed{kind:metadata}`。
- **验收**：改 tags→桌面 db 与词表都变；只传 description 时 tags 原样（不互吞的服务端半边）；allow_edit=false 时 403。

### 1.3 people / topics 读＋写端点
- 读：`GET /api/people`、`GET /api/topics`（LAN 态入口与总览用；复用 core persons.rs/topics.rs 原语）。写：人物重命名/换头像/改描述（`PUT /api/person`）；专题建删与归属调整（按 §5.3 拍板范围：人物与专题「一样能够编辑」）；同样 allow_edit + 整行读改写 + 事件（kind=people/topics）。
- **验收**：改名人物→桌面库变+事件触发；越权 403。

### 1.4 文件操作端点改造与新增
- **rename/delete 改道**：`/api/rename`、DELETE `/api/file` 从裸 fs 操作改调 `file_operations.rs`（rename_file:314 / delete_file:473——自带 file_id 迁移与 db 联动）；**新增** `POST /api/file/move`、`POST /api/file/copy`（move_file:674 / copy_file:540，返回新 path）；**upload 入索引**：`/api/upload` 写文件后把新文件补进 file_index（file_operations 或扫描管道的单文件增量路径），否则桌面 browse（DB 路径优先）看不到；全部发 `data-changed{kind:files}`。
- **验收**：LAN rename 后桌面 `file_id` 迁移正确、file_metadata/tags 挂在新 id 上（对照桌面本地同操作的库状态）；upload 后桌面 browse 立即可见新图；move/copy 全链；三个写端点 allow_edit 403。

### 1.5 事件与默认权限（D32 拍板口径）
- `emit_data_changed(kind)` 实装（照 emit_devices_changed）；**不新增任何开关**——`allow_edit`/`allow_upload` 默认值改 **true**（Rust LanShareConfig 默认 + 桌面 App.tsx:120 初始值），互联即授权；既有 allowEdit toggle 保留为默认开的收紧项（0.1 摸底的「上传不可达」由此消解）。
- **验收**：任一写端点触发后桌面收到事件（Tauri log 佐证）；全新配置的桌面端开共享后，不做任何设置手机即可编辑+上传；手动关 allowEdit 后 403 恢复。

## 阶段 2：桌面端失效消费（React）

- 监听 `lan-share-data-changed` → 按 kind 分派：**metadata** → `handleRefreshTags()`（useDirectoryScan.ts:309 现成）+ `notifyRemoteChange()`；**people/topics** → 抽取的 `reloadPeople()/reloadTopics()`（把 useAppInit.ts:158-197 等三处内联逻辑抽成公共函数并换用，别复制第四份）；**files** → 失效 folders/计数（filesVersion 自动 bump 依赖 state.files 写入，files 类最小做 folders 刷新）。
- 顺手：删 HttpAdapter 的 deleteFile/renameFile 死代码（0.1 协议 bug，Web 页走 lan-share/api.ts 不受影响，删前 grep 调用方确认）。
- **验收（§5.3 风险闭环）**：安卓改标签→桌面侧栏计数/TagsModal **不手动刷新**即新；安卓改人物名→桌面 PeopleSection 即时变；**不互吞**判据——安卓改完标签 A，桌面随后对同图加标签 B，库中 A、B 共存（事件重读后桌面整行 upsert 带着安卓改动走）。

## 阶段 3：Kotlin 客户端基础栈

- **manifest/配置**：`INTERNET` + `ACCESS_NETWORK_STATE` + 明文策略（起草建议 networkSecurityConfig 收敛到 LAN 网段 cleartext，比全局 usesCleartextTraffic 稳）；依赖：okhttp 4.12 显式声明（对齐 Coil 传递版本）、zxing-android-embedded（D33）。
- **LanClient 模块**（数据层，风格对齐 GalleryViewModel 的「属性+suspend+IO」惯例）：auth（device_id 生成/持久化）、browse、allImageFolders、search、thumbnail/image URL 拼（token 进 query）、upload（multipart）、heartbeat、fetch 15s 超时；**连接状态机**（disconnected/connecting/connected/reconnecting）+ 心跳 5s×3 失败清理 + 未连接 15s 周期重试 + 401 清 token——时序逐条对齐 0.2。
- **扫码**：QrScanner（embedded）+ QR 解析（JSON/旧版 URL 兼容）+ 手输 host:port+访问码 fallback；`ensureCameraPermission` 运行时权限。
- **持久化**：SettingsStore 新键（lanHost/lanPort/lanToken/savedServers 上限 10 含 code/lanServerEnabled——7 用）；设备名设置。
- **设置 LAN 面板**（替换 SettingsDialog 的 LAN placeholder，形制对齐 M4c）：连接状态行、服务器地址/访问码输入、最近服务器一键连、断开按钮；（7 落地后追加「允许桌面浏览本机」开关）。
- **网络 Section 接通**：connected → Wifi 图标 + 可展开（**承载远端文件夹树入口**，D31：网络栏只管本地/网络文件夹区分；标签/人物/专题的远端条目在各自 Section）；未连接维持骨架现状。
- **验收**：模拟器扫码连上宿主桌面端（0.7 连通口径）；杀进程重启自动恢复（token 未过期）；拔网（关桌面服务端）→ 自动清理 + toast + 周期重试；心跳断链 15s 内清态。

## 阶段 4：LAN 浏览视图

- **导航**：`ViewMode.LAN_FOLDERS_OVERVIEW` + `openLanOverview()`（openCanvas 样板）；返回链复用 HistoryItem.viewMode；TopBar 标题/搜索按视图切换。
- **数据**：GalleryViewModel 挂 LAN 会话态（lanFolders/lanRootImages/lanAllowEdit/lanAllowUpload/lanConnected）；`__lan_root_images__` 虚拟根置顶（对齐 React FoldersOverview.tsx:649-650）；序列源分流：BROWSER 的 folderId 带 lan 前缀时走 LanClient.browse（reloadImages 分流或并列入口，实现时按 M4a 序列源先例）。
- **网格**：`ThumbnailLoader` 加 URL 分支（okhttp 拉取→内存 LruCache 同池→磁盘 `cacheDir/lan_thumbs/<urlHash>`）——**保 FileGrid 全部既有能力**（三档捏合/分组/多选/选择栏/下拉刷新），别起第二套网格；视频项过滤（type=video 不进列表，登记差异）。
- **查看器**：isLan=true 走 Coil（ImageSource.kt:54 分支已预留）——补缓存键（disk=`aurora-lan:<remotePath>`、memory 带 variant，对齐 aurora-viewer 键风格）；分享/加入画布的既有 isLan 拦截自动生效。
- **上传**：LAN 视图内上传入口（本地多选弹窗→multipart 逐个→进度与完成 Toast）；allow_upload=false 时入口置灰并提示需桌面开启。
- **保存到设备**（D34）：查看器菜单「保存到设备」——下载原文件→MediaStore Downloads insert；与 React 的 app 内临时下载（lan-cache）登记差异。
- **验收**：总览置顶根散图；HTTP 缩略图滚动流畅（冷/热各记一轮数据，量法照 M1 gfxinfo 口径）；查看器大图加载与翻页；上传走通（allow_upload=on，桌面端出现新图）；保存落系统下载可见；断线后 LAN 视图退出且无残留。

## 阶段 5：在线元数据读写（§5.3 的核心交付；D31 口径=并入现有侧栏＋网络标识）

- **侧栏合并（D31）**：远端 tags/人物/专题**并入现有三 Section**（不是独立栏）：标签行前/人物头像旁/专题行加网络来源小图标；点远端条目 → 进 LAN 视图按该条目筛**远端**图（本地条目行为不变）；「网络」Section 只承载本地/网络文件夹区分。远端条目按各自 Section 现有分组规则插入，靠标识区分来源。
- **查看器抽屉 LAN 态**：显示远端 tags/description/sourceUrl（1.1 批量端点）＋编辑回写（1.2 端点；TagEditDialog 形制复用、写入走 LAN）；新标签走词表端点进**桌面**词表。
- **远端人物/专题编辑**：人物重命名/换头像、专题建删与归属调整（1.3 端点）——入口在对应总览/详情页与本地同位（带网络标识）。
- **数据层断言（验收硬项，D31 修订后仍有效）**：整个 LAN 会话期间**本地词表、本地库、本地过滤数据**零变化（显示层合并≠数据合并）；断线后侧栏带标识条目消失、本地条目与连接前逐项一致（截图对照）。
- **验收**：§0 主链路元数据段全过（改→桌面立即可见→不互吞→断线消失）；词表新词出现在桌面端而非本地；断线前后本地条目零变化。

## 阶段 6：互联态文件操作

- 选中集菜单 LAN 分支：**重命名**（单选，RenameDialog 形制）、**删除**（确认弹窗＋DELETE）、**移动到…/复制到…**（新端点）；目标选择器数据源 = LAN `/api/browse` 目录树（新建 LanFolderPicker，**数据源不复用本地 TargetPicker**——规划 §5.3 明示互联态目标树是桌面目录；形制复用）。
- **门禁（D32：默认全权）**：菜单按服务端下发的 allow_edit/allow_upload 位渲染（协议位保留）；默认 true 直通，手动关 allowEdit 后四项不出现（M4a「不适用的项不出现」先例）+ 强调用时 403 Toast；操作成功后以**返回的新 path** 刷新（桌面 file_id=路径哈希，rename/move 后 id 变——客户端不假设 id 稳定，0.1 铁律）。
- **验收**：互联态重命名→桌面库与文件一致且元数据挂住（1.4 服务端验收的端到端）；move/copy 到桌面子目录全链；403 与菜单态（默认直通一例 + 手动关 allowEdit 后一例）。

## 阶段 7：对等服务端（桌面浏览本机，D30 路线落地）

- 按 D30a（建议）：Kotlin 实现 10 端点协议（auth/logout/browse（path=bucketId 语义）/palette/all_image_folders/search/thumbnail/image/devices/heartbeat）——数据面 = Kotlin 侧 MediaStore 查询（listFolders/listImages 的既有数据做服务化，FFI 不动）；**语义对齐三件**：device_id 会话覆盖、认证带 `peer_server{port,access_code}` 反向配对（连桌面时上报本机服务端）、心跳 401/超时清理；**前台服务**（连接期间保活通知，新建 lan Channel——通知基建复用 M4b ScanNotifier 的先例，别复用其 Channel）。
- 断开联动：主动断开桌面连接时停本机服务端（0.2 末条同款）。
- **桌面→手机方向的写操作（登记，本期不做）**：D32 口径「桌面端也是同理默认放权」，但对等服务端协议（React 版）本无 rename/delete/upload 端点，且手机侧写操作要走 MediaStore 系统授权弹窗（桌面发指令→手机弹窗的交互链路未设计）——第一版只交付桌面浏览手机；桌面改手机文件若成为真实需求，随 M6b/后续立项（矩阵登记差异）。
- **验收**：桌面 NetworkSection 出现本机（型号名）、点入浏览缩略图/大图；本机断开后桌面 15s 内移除设备；服务端开关（设置 LAN 面板）记忆重启。

## 阶段 8：收口核对与验收

- **矩阵回填（九处）**：表 1 LAN 文件夹总览、表 2 NetworkSection、表 5 七行、表 6 LAN 面板行——达成/差异（视频项过滤、保存语义 D34）一并备注；**D29 通过后规划 §6 的 M6 行拆 M6a/M6b 两行**（M6a 打 ✅、M6b 指向另立清单）。CLIP/人物两行的摸底更正已在 v8 落，M6b 起草时复核。
- **销账**：全仓「随 M6」字样清零（SettingsDialog LAN placeholder 文案、TreeSidebar 网络行注释等）；体积对比——本里程碑新增 okhttp/zxing 依赖，so 应持平、APK 增量如实记录（对照 M4b 口径）。
- **黑盒用例（mobile-ui-tester，双模拟器）**：先决条件=宿主桌面端 lan_share 跑着＋连通口径（0.7 结论）——用例的环境准备写进用例本体。草案 10 条：① 扫码/手输连接；② LAN 总览置顶根散图；③ 网格浏览+查看器大图；④ 查看器改标签回写→桌面库验证（桌面侧 db/界面佐证）；⑤ 不互吞（桌面再改→共存）；⑥ allow_edit=off 菜单不可用+403；⑦ allow_edit=on 重命名/删除；⑧ 上传（allow_upload=on）；⑨ 断线清理+本地库零污染（截图对照）；⑩ 对等服务端被桌面浏览。adb 注不进的手势类不涉及；桌面端的验证步骤列**联调清单**由验收人执行。
- **真机复核**：Tab S8 + 桌面同网段全链路一遍（扫码相机、心跳稳定性、弱网清理时序——模拟器测不了的场景）；随验收人安排。
- **回归**：本地库主链路（M4a 打标签→筛选→查看器→编辑）＋ M4b 文件操作抽一例 + M5 画布进出——确认 LAN 会话态没砸本地管线。

## 6. 关键决策点（编号接 M5 的 D28；**2026-09-24 已全部拍板**，结论记 §7 行 0——D31/D32 推翻起草人建议按验收人口径执行，下表建议列保留作历史）

| # | 决策 | 起草人建议 | 说明 |
|---|---|---|---|
| D29 | M6 拆分为 M6a（互联与在线读写）＋M6b（AI 与视觉分析） | **拆，M6a 先行** | §0 开头三条理由。M6b 范围=AI 编排下沉 core（含 core 加 reqwest 的取舍）/AI 面板/主色调批量+颜色搜索下沉/人物数据源（WD14 管线）/CLIP 端上 vs 互联态远程的路线 spike/任务通知按钮/悬空设置清理。M6a 收口后起草 M6b 清单。不拆的代价：互联交付被模型推理风险阻塞，且无中间验收态。 |
| D30 | 对等服务端（桌面浏览本机）实现路线 | **a：Kotlin 原生实现 10 端点协议** | b=UniFFI 托管 Rust `android/server`：其数据面是 Rust 经 JNI 回调 Kotlin MediaStore（call_kotlin_* 桥），与本项目「MediaStore 在 Kotlin、FFI 只碰 db」架构相反，要拖 JNI 桥进 core 且违背 M4a 以来的分层。a 的成本=重写 10 个窄端点 + 对齐 device_id/peer_server/心跳语义（0.3 清单），协议面窄可控。 |
| D31 | LAN 内容的命名空间 UI 形态 | **网络 Section 承载**：connected 后展开=远端文件夹树＋人物/专题/标签入口（D31 建议的最小完整版）；元数据编辑在查看器抽屉；不动本地三 Section | 规划 §5.3 给了两形态（独立侧栏分区 vs 同侧栏明确分区）。React 现状无 LAN 元数据 UI（服务端没端点），无对齐基准、属新设计。若嫌重可缩为「仅文件夹树+查看器内元数据」，people/topics 入口后置 M6b/后续——验收人定深度。 |
| D32 | allow_upload 桌面 UI 开关 | **补**（LanSharePanel 加 toggle，随阶段 1.5） | 摸底核实：桌面无任何开关、恒 false（App.tsx:120）→ 矩阵「LAN 上传 React 现状=完整」实际不可达。allow_edit/allow_upload 语义不同（动库 vs 只写文件入索引），保留两位不合并；默认值维持 false。 |
| D33 | 扫码与 HTTP 客户端选型 | 起草人可定：**zxing-android-embedded（Apache-2.0，无 GMS 依赖）＋ okhttp 4.12 显式声明** | 备选 ML Kit（带 GMS 依赖，设备面窄否决）、CameraX+zxing core 手搓（embedded 已封装足够）。0.7 spike 冒烟后定案。 |
| D34 | 「保存到设备」语义 | 起草人可定：**MediaStore Downloads insert 存原文件**；React 的 app 内 lan-cache 临时下载不做 | 移动端「保存」的自然语义=落系统下载/相册；登记与 React 差异。若验收人要「保存到相册 Pictures」改 insert 目标即可。 |

## 7. 任务状态记录

| 任务 | 状态 | 结果与备注 |
|---|---|---|
| 0 摸底与拍板 | 完成 | 摸底=四路并行（2026-09-24，结论 §0.1–0.6）。**D29–D34 已拍板（2026-09-24 验收人）**：D29=拆分（M6a 先行，M6b 另立清单）；D30=a（Kotlin 原生 10 端点对等服务端）；**D31=推翻建议：远端标签/人物/专题并入现有侧栏对应 Section＋网络来源标识（头像旁/行前小图标），点远端条目=LAN 视图筛远端图，「网络」栏仅区分本地/网络文件夹——数据层仍两套（词表/库/过滤不混），断线带标识条目随连接消失**（推翻 09-21 规划 §5.3「不得并入本地侧栏」口径，规划已同步修订）；**D32=推翻建议：不新增开关、互联即授权——桌面端 allow_edit/allow_upload 默认值改 true（既有 allowEdit toggle 保留为默认开的收紧项），403 仅手动关闭时出现；桌面→手机方向同权但写端点本期不做（协议本无+MediaStore 授权链路未设计，登记）**；D33=zxing-android-embedded＋okhttp 4.12；D34=保存到系统 Downloads（MediaStore insert）。**0.7 spike 完成（2026-09-24，结论 §0.7：模拟器直达宿主 LAN IP、cleartext=base-config 全局放行、okhttp/zxing 依赖已入、Coil http fetcher 出图实测、扫码集成+解析链通）**；相机实扫待 Tab S8 真机。 |
| 1 服务端扩展 | 完成（2026-09-24，本机验证过；**主电脑重建重启桌面端后联调待做**） | 1.0 契约定稿=`M6a互联契约定稿.md`（形状/门禁/事件/错误码冻结，2/3 并行依据）。1.1 `POST /api/metadata/batch`（core 新增 `get_metadata_by_ids` 单 SQL IN 批量原语；越出共享根的 path 按空默认不泄漏）。1.2 `PUT /api/metadata` 整行读改写+新词并桌面词表（`lan_share/metadata.rs` 纯函数+7 单测锁定「patch 缺省=不改、`tags:[]`=显式清空」）。1.3 `GET /api/people|/api/topics`（core 模型 camelCase 原样序列化）+`PUT /api/person`（avatar_path 传 path 不传 file_id，换头像清 faceBox）+topic 建删/成员增删。1.4 rename/delete/upload 改道 file_operations（新增池化变体 `_with_pools` 系），upload 走 `write_file_bytes_indexed` 单文件增量入索引；新增 `POST /api/file/move|/api/file/copy`（move 冲突失败不覆盖、copy 冲突自动改名，逐项结果不整批失败）；**browse 旧根失配修复**（DB 结果绝对路径不落当前共享根即弃用走 FS 回退，切根须重启的坑消除）。1.5 `emit_data_changed(kind)` 覆盖全部写端点+D32 默认全权（Rust `LanShareConfig` allow_edit/allow_upload=true）。验证：cargo check 过、core 39 测全绿（含新批量读测试）；**src-tauri lib 测试二进制在本机初始化崩溃（0xc0000715，先于任何测试执行，deps 无历史测试 exe=本机从未跑过，疑 DirectML/ort 桌面依赖初始化，与本次改动无关）——7 个单测待主电脑跑**。**联调（同日主电脑重建后，curl 冒烟 28/29 过，1 FAIL=脚本清理断言把 404「本就该无残留」误报）**：批量读 20 项一次返回/同序/缺失空默认、PUT 整行读改写不互吞（只传 description 时 tags 原样、反向同、`tags:[]`=清空、还原逐字段一致）、topic 建删无残留、copy（冲突自动改名+副本继承元数据）→move（跨目录、tag 挂新 path、旧 path 清空）→rename→delete 全链、move 冲突逐项失败不整批炸，全实证。**抓到并修复文件 rename 元数据+index 行双丢 bug（`d5f1f8a2b`）**：`rename_file_with_pools` 同步事务迁完 id 后无条件 spawn 目录迁移尾巴，`migrate_*_dir` 第 0 步按「目标路径=残留」DELETE，文件 rename 恰把刚迁好的 index+metadata 行异步删掉（实测新/旧 path 均空、条目从 browse 整个消失；**桌面 `rename_file` 命令同函数同病，属预存潜伏 bug**）；修复=尾巴收进 `is_dir` 分支、文件分支 colors 同步迁（move_colors 无清残留步骤），主电脑二次重建后复验全绿（元数据挂住+browse 可见）。**联调遗留**：① allow_upload 存量配置仍 false（D32 只改默认值，上传 E2E/黑盒⑧前须放开主电脑存量配置）；② `lan-share-data-changed` 桌面 UI 即时可见性 curl 验不了，待桌面侧人工看或阶段 3 接通后验；③ 主电脑共享根有「Arknights  Endfield」（双空格）与「Arknights Endfield」两个真实目录，path 含多空格不透明回传实测无碍。 |
| 2 桌面端失效消费 | 完成（2026-09-24，本机 tsc 验证过；不互吞端到端闭环随主电脑联调=阶段 8 黑盒④⑤） | App.tsx 监听 `lan-share-data-changed` 按 kind 分派（metadata→`handleRefreshTags()`+`notifyRemoteChange()`；people/topics→新抽 `utils/peopleTopics.ts` 的 `reloadPeople/reloadTopics`，useAppInit 启动+useDirectoryScan 两处内联共三处全部换用，读失败保留内存行防瞬时 DB 故障清表被持久化；files→`handleRefreshAnySource` 并补 lan 文件夹分支），ref 持最新分发、监听只注册一次。顺手：HttpAdapter `deleteFile/renameFile` 死代码删除（全 src 零调用方实证，`FileApi` 接口改可选+注释登记协议细节）。D32：App.tsx 初始默认+SettingsModal 缺省 lanShare 对象 allowEdit/allowUpload=true（allowEdit toggle 保留为默认开的收紧项）。tsc --noEmit 过（仅 2 个预存 TS2688；vitest 环境的 pnpm symlink 损坏为预存与本笔无关，受影响测试集为空）。已知边界：`handleRefreshTags` 只回写非空 tags 行（远端「清空标签」不反向取消本地，登记）。 |
| 3 Kotlin 客户端基础栈 | 未开始 | |
| 4 LAN 浏览视图 | 未开始 | |
| 5 在线元数据读写 | 未开始 | |
| 6 互联态文件操作 | 未开始 | |
| 7 对等服务端 | 未开始 | |
| 8 收口与验收 | 未开始 | |

## 8. 交接要点（开工前读；M4a/M4b/M5 §8 的通用坑不重复抄）

- **联调环境（2026-09-24 已就绪并复验通过；共享根=NVIDIA 游戏截图目录 21 个子目录）**：服务端 = 主电脑（`192.168.31.87:8080`，访问码 9928——由敏感的 `E:/图包` 切换而来，测试截图不得带敏感内容；**切根后须完全重启桌面端才重建索引**，应用内刷新无效，0.1 实测）；本机 = `192.168.31.174` 同网段，curl 冒烟全通（结论在 0.7 进度行）。**改服务端代码后的同步纪律**：桌面端跑在主电脑，阶段 1 改 lan_share 后必须在主电脑重建并重启桌面端——被测服务端版本要与代码同步，别拿旧实例测新端点；桌面端运行时经 SMB 持有仓库文件句柄（历史教训：删/覆盖 target 等目录前先关它，别冤枉 SMB 权限）。模拟器→主电脑连通性随 0.7 实测（AVD 出站经宿主网络栈，预期能通）；最终口径 = Tab S8 真机同网段。双模拟器并发用例时注意 device_id 会话互踢（0.3）。
- **协议对齐纪律**：路由/字段名/token 位置逐字对齐服务端与 lanClientApi（query vs body 的教训见 HttpAdapter 死代码）；Kotlin 别引入「更 RESTful」的自创风格。契约定稿（1.0）后改字段名=返工。browse 的 `path` 是绝对路径形态（0.7 实测），客户端一律原样回传。
- **桌面 file_id=路径哈希**：互联态 rename/move 后 id 必变——客户端一切以 path 为身份、操作后以返回的新 path 刷新；服务端必须走 file_operations（带 migrate），别在 handler 里 fs::rename 完事（现状 bug，1.4 修）。
- **词表两套别混（D31 后仅指数据层）**：桌面词表=user_data blob（经 load/save_user_data）；安卓本地词表=tags 表（M4a D10）。LAN 新词只进桌面那套——侧栏显示层已合并（D31），但写库路径与词表归属绝不能跟着合并；阶段 5 的数据层断言就是防这个。
- **上传的桌面侧索引**：upload 端点现状只写文件；不入索引桌面 browse 看不到（1.4 要补）。顺手核对 addPendingFilesToDb 一类现成路径，别写第三套扫描。
- **心跳/token 时序表（0.2）就是 Kotlin 状态机的验收对照**：写代码前把 15s 超时/5s 心跳×3/15s 重试/401 即清/SESSION 3600s 做成常量表，别散落魔法数。
- **桌面二维码依赖外网 api.qrserver.com**：验收环境若离线，桌面端二维码显示不出≠本 App 的 bug——手输地址/访问码永远可用（fallback 是交付物的一部分）。
- **黑盒先决条件**：mobile-ui-tester 用例跑之前宿主桌面端必须起着 lan_share 且连通口径已知——把「启动桌面端→开共享→拿地址码」写进用例环境步骤，否则用例集体假失败。
