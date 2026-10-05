# Eagle 数据迁移 · 方案讨论稿（交接用）

> **版本 v1.1（2026-10-06）**：新增 §0.5 产品定位拍板（P7）与 §5.0 C 档定稿答案；§3 补 C 档实现；**撤销 v2.2 的「切根接管」**（那不是 A 档，是被否决的 B 档）。详见文末更正记录。
> **用途**：给另一个 AI（或人）讨论 Eagle 导入方案的**自包含**简报——现在做到哪、哪些已拍板、哪些没定。事实均来自本机实测（Eagle 4.0.0 build20260401 + 真实库 49 条目），标注体系与完整证据链在规格书里。
> **深读（规格书）**：`docs/Eagle数据迁移-格式调研.md`（v2.2）——§2 库结构、§5 路线对比、§7 字段映射、§8 社区做法调研、§12 可行性复核（H1-H3）、§13 实测记录与拍板记录。本文与其冲突时以规格书 §13 为准。
> **上游**：`docs/PixCall数据迁移-设计方案.md`（PixCall 期定下的共享层契约与合并策略，Eagle 期直接复用）。

---

## 0. 一句话现状

**C 档（连文件接管）已升为主航道并实现（2026-10-06）；A 档退化为 C 流程内部的一步；B 档（把 `.library` 当资源根）出局并已从代码里撤掉。**

背景：Eagle 导入分两档（验收人 2026-10-05 拍板「A+C 两档」）——
- **A 档「只挂标注」**：不碰任何文件，把 Eagle 里整理的 tags/备注/来源网址/夹→专题 挂到**已经在我们图库里的同一批图**上（按 `name+ext` 认亲）。已实现，且现在是 C 流程里的「认亲命中就不搬」这一支。
- **C 档「连文件接管」**：把实体文件从 `.library` 里搬出来落进用户的资源根，同时挂标注。**已实现**（见 §3），是默认路径。
- **B 档「把 `.library` 当资源根」**：§5 早已写明代价，2026-10-06 实测后**彻底否决**——详见 §0.5。

### 0.5 产品定位（2026-10-06 验收人拍板，本次讨论的地基）

> **我们与 Eagle、PixCall 是同赛道的竞品，不是它们的附属插件。迁移功能的本质 = 让 Eagle/PixCall 的用户改用我们软件的成本降到最低。**（验收人自己并不使用 Eagle。）

这条一落地，§5 那四条路线的排序就变了，判断标准只有一句：**搬完之后用户的图库能不能独立存在**。

| 路线 | 用户能不能离开 Eagle | 判定 |
|---|---|---|
| B（把库当资源根） | 不能——文件还在 Eagle 库里，删掉 Eagle 就没了 | **出局** |
| A（只挂标注） | 前提是用户自己已经有同一批副本（等于要求他先导出过） | 退化为 C 的一步 |
| C（连文件接管） | 能 | **主航道** |

**B 档在 2026-10-06 之前被误实现过一次**：v2.2 的 `WelcomeEagleCard` 照搬 PixCall 那条「切根→扫描→probe→import」接管链，把 `*.library` 目录本身当成了资源根。实测后果（验收人原话「完全没办法看」）：

- 49 条目 → 网格里 49 个 `<ITEM_ID>.info` 文件夹，每个文件夹塞着 2 张图；
- 一张原图出现 3 张缩略图：Eagle 自存的 `_thumbnail.png` 一张 + 我们为实体生成一张 + 我们为那张缩略图又生成一张；
- 标注挂在了库内文件上，用户切回自己的目录后这些标注全是孤儿；Eagle 侧增删后索引变僵尸行。

PixCall 那条链在 Eagle 上不成立的原因是结构性的：PixCall 的 `.pixcall` 所在目录里就是图，而 Eagle 的图埋在 `images/<ID>.info/` 里、库目录本身是个数据库。**任何形式的「把 Eagle 库当资源根」都不许再回来。**

---

## 1. Eagle 库格式：实测事实清单（可直接当地基，全部验证过）

| # | 事实 | 证据 |
|---|---|---|
| F1 | 库 = `.library/` 目录：根 `metadata.json`（夹树/智能夹/标签组）+ 根 `mtime.json`（增量日志，`"all"` 是计数键）+ `images/<ITEM_ID>.info/{metadata.json, <name>.<ext>, <name>_thumbnail.*}`。**不是 SQLite，无锁文件** | 49 条目实测；与官方样本、社区解析器一致 |
| F2 | 条目 `metadata.json` 键集高度稳定（实测 49/49 同一 17 键）：`id/name/size/btime/mtime/ext/tags/folders/isDeleted/url/annotation/modificationTime/height/width/lastModified/palettes`(+`noThumbnail`)；**除 id 外全 Optional** | 全量聚合 |
| F3 | `id` = 13 位 `[A-Z0-9]`；**目录名是权威**（与 JSON `id` 不一致时以目录名为准，实测 49/49 一致） | 实测 + eagle-cli 判据 |
| F4 | **条目只记夹 id（`folders[]`），不记任何原始路径**——Eagle 导入即把文件复制进库（官方原话），用户原路径无处可寻。这否决了 PixCall 期的「路径 join」匹配链 | D1，官方帮助中心原文 |
| F5 | **普通夹是纯逻辑关系**：磁盘上 `images/` 下一层就是 `.info`，没有目录层级。**拖拽导入不建夹**——实测库 `folders` 树为空、49/49 条目 `folders:[]`，「未分类」是 Eagle 主流形态 | 实测 + 验收人口述 |
| F6 | `tags` 是字符串数组（无 tag id、无词表 join）；`annotation`=备注；`url`=来源网址；`star` 0-5 评分；`comments[]`=图上矩形标注（4.0 build22+）；`palettes[]`=主色板（带 Angular 残留 `$$hashKey`，且**可选**） | 实测（star/comments 本库无样本，官方文档佐证） |
| F7 | **`btime` = 源文件的文件系统创建时间（birth time），`mtime` = 源文件修改时间**——都是导入时从文件带过来的；**`modificationTime` 才是入库时刻**（49 条同批导入、modificationTime 全等、与 btime 重合 0 条）。⚠️ 网上和早期调研把 btime 当「加入库的时间」是错的 | 实测 |
| F8 | 实体文件定位：`<name>.<ext>` 精确命中 49/49；回退链 `精确 → <name>.* → 目录内最大文件`；`*_thumbnail.*` 一律排除（还有 `Desktop.ini` 之类杂物要排） | 实测 |
| F9 | 智能夹：`conditions: [{match: "AND"\|"OR", boolean?: "TRUE"\|"FALSE", rules: [{property, method, value}]}]`，组间 AND；子夹**磁盘 JSON 上带 `parent` 回指**和一批 UI 状态键（`depth/size/vstype/styles/isExpand…`，解析全忽略）；**`imageCount` 直接落在（子）智能夹节点上**（父节点没有）→ 计数断言可离线做 | 实测 |
| F10 | 智能夹条件标定（实测到的全部）：`type=equal`（value=扩展名串，大小写不敏感）、`name=contain`（**大小写不敏感**；**value 空串 = 什么都不命中**——实测 OCR 夹 value:"" 且 imageCount:0）。其余 property/method（tags/folders/rating/color/createTime…）未标定 | 实测（HEA 夹值 "HEAD" 命中小写 `head1(1)` 等 4 条） |
| F11 | 软删 = 原地 `isDeleted:true`（文件不动，无 recyclebin 目录）；`deletedTime` 存在与否本库无样本未验证 | 实测+待补 |
| F12 | Eagle 官方本地 API `http://localhost:41595`：**无鉴权、无 token**（Settings 里的 `developer.apiToken` 实测非必需），Eagle 开着时可裸调；`/api/library/info` 直接返回 `library.path`+`name`；`/api/library/history`、`/api/application/info` 配套 | curl 实测 |
| F13 | 库发现：`%APPDATA%\Eagle\Settings`（无扩展名 JSON）的 `libraryHistory[]` + `rootDir`（当前库）；Eagle 开着时运行直读 `.library` 无锁无碍（并发验证过） | 实测 |
| F14 | 官方口径：Eagle 自己能「一键导出全部内容并保留夹结构」；eaglepack 导出保留标签/注释/链接（不含标签组） | 官方帮助 |

---

## 2. 已拍板（验收人，2026-10-05；调研 §13.7）

| # | 决定 |
|---|---|
| P1 | **A+C 两档**：A 为本期主切片（已实现）；C 为显式 opt-in 第二档，单独切片——**C 的设计就是本次讨论对象** |
| P2 | 智能夹**断言通过才固化**：只实现已标定条件对（F10），自算成员数与磁盘 `imageCount` 精确一致才固化成快照专题；不过/含未标定键/无 imageCount → 跳过+上报；断言过但 0 成员 → 不落空专题；子夹按独立条件求值（不实现父条件继承——样本不可分辨，按严的来） |
| P3 | 标签组 `tagsGroups`：丢弃 + 上报（PixCall 先例） |
| P4 | 图上矩形标注 `comments[]`：丢弃 + 上报（PixCall 官方插件同样丢） |
| P5 | 评分 `star`：不迁（我们无评分功能） |
| P6 | 读取路径：直读磁盘为主；Eagle 开着时可选 API 交叉校验（F12，成本为零） |
| H2 | 报告加新栏 `unmatched_items`（Eagle 填「显示名.ext」），`unmatched_paths` 保留给 PixCall；serde default 兼容旧记录 |
| **P7（2026-10-06）** | **产品定位：我们与 Eagle / PixCall 是竞品不是附属；迁移 = 让用户搬过来的成本最低。** 路线重排为 **C 主航道 / A 退化为 C 的一步 / B 出局**（§0.5） |
| 范围 | **桌面单端**，不做移动端；三端功能矩阵不登记 |

**合并策略三条（PixCall 期既定，两档通用）**：标签并集（只写 `file_metadata.tags` 一处）/ 描述与来源网址「仅为空时填」/ 夹→专题同名不新建、成员并入、position 续排。

---

## 3. 已实现（A 档 2026-10-05 + C 档 2026-10-06，均未 commit）

| 层 | 内容 |
|---|---|
| Rust 核心（A 档） | `core/src/import/eagle.rs`（发现→解码→分类→匹配→计划）；匹配层 `OurIndex` 加 `by_name_ext`（键=`name.ext` 小写，命中后复核 size+宽高；H1 的「匹配层重写」落地）；报告 `MigrationReport` 加 `unmatched_items`（H2）；`core/src/file_types.rs` 补 `mime_for_extension()`（ext→mime，None=不支持，仍走 `is_indexable` 单点门禁） |
| Rust 核心（**C 档**） | 同文件新增「连文件接管」一段：`plan_takeover`（Q2/Q3/Q4/Q5：夹镜像目录、多归属只落主夹一份、未分类平铺进 `<库名>/`、撞名加 `_<短ID>`）+ `takeover_preview`（动手前的账）+ `execute_takeover`（**硬链接优先、失败按条降级复制**，绝不 move）+ `index_takeover`（搬完直接写 `file_index`，与 scanner 同一张表同一个 `generate_id`，不用等重扫）+ `Item.entity_path`（实体定位三级回退改为**返回文件本身**）；`MigrationReport` 加搬运栏 `files_linked/copied/already_here/skipped_existing/failed/bytes_imported/takeover_root`（全部 serde default，旧 `report_json` 不受影响），`has_anything_to_migrate` 认「搬了文件但没标注」也算动了库 |
| 命令 | `src-tauri/src/import_commands.rs`：`eagle_probe(sourceRoot, targetRoot?, preferLink?)` 返回 `{ report, takeover }`（A+C 两份预览一次给）；`eagle_import(sourceRoot, targetRoot?, preferLink?)` 按 **①读索引 → ②搬运（不占连接池）→ ③入库 → ④认亲+合并 → ⑤搬运栏并入报告** 五步走；搬运完成额外发 `lan-share-data-changed {kind:"files"}` 让前台重扫当前目录 |
| UI | 设置→存储：Eagle 卡（整宽同构，发现不到整块不渲染）→ **probe 出「迁入位置 + 条数 + 占不占空间」→ 用户点确认才动手**，另给「改为复制导入」开关；Welcome：来源按钮按发现结果渲染，`WelcomeEagleCard` **不再切根**——没选资源目录时先给「选择资源目录」，选好才出预览；报告视图复用 `PixcallReportView` 薄包装 |
| i18n | zh/en 各 42+ 键（`eagle.*` 镜像 `import.*`）+ 本次新增 `takeover*` / `statLinked` / `statCopied` / `statBytes` / `noteFailed` 等；`settings.importFromEagle` 与 `welcome.useEagleLibrary` 文案改为「迁移」 |
| 门禁 | cargo test **183** 通过（含新增 5 条 C 档用例：只搬实体不搬缩略图、认亲命中不搬、夹树镜像+撞名消歧、拒绝往库里写、重跑幂等）；`cargo check`（src-tauri）、`tsc --noEmit`、`npm run build`、相关 vitest（Eagle/Welcome/Pixcall/translations 共 63 例）全绿 |

**我方系统相关事实（C 档设计要用）**：`file_index` 列 `file_id/parent_id/path/name/file_type/size/created_at/modified_at/width/height/format`，**`name` 含扩展名**、`path` 正斜杠唯一；**文件挪位后不自动重扫**（陈旧索引会吃掉匹配率）；`topics`/`topic_files` 支持一文件多专题；图库根可切换（切根有确认弹窗）；主色调 `colors.db` 自算（Eagle `palettes` 不迁，两边数量不同构是正常的）。

---

## 4. 样本缺口（A/C 两档共同的未验证分支，验收人可在 Eagle 里补）

嵌套两层普通夹+夹描述；`tags`/`color` 两种智能夹 property；标签组；评分；一条同时属两夹；密码夹；图上矩形标注（comments）；回收站条目（deletedTime）；视频/字体；网页书签（无实体文件条目）；改一次显示名（验证实体文件名是否跟随）。补齐后可复跑聚合脚本与 smoke。

---

## 5. C 档问题清单（2026-10-06 已定稿，见 §5.0）

> **本节在 2026-10-06 由「待决」转为「已定稿」**：产品定位落地后（§0.5）C 档是唯一主航道，Q1–Q10 按下面的默认实现了一次。留着原题与代价是为了让后人看得懂「为什么是这个默认值」，不是还要再拍一次。

### 5.0 定稿答案（一句话版）

| # | 定稿 |
|---|---|
| Q1 | **硬链接优先**（同盘符零额外空间），不支持/跨盘符按条降级为复制；**绝不 move**（库只读）。UI 给「改为复制导入」开关给想要独立副本的人 |
| Q2 | **有夹则镜像物理目录 + 夹关系照样落专题（双轨）**；无夹则平铺 |
| Q3 | **物理只放一份**（主夹 = `folders[]` 第一个），其余夹关系全落专题 |
| Q4 | 未分类平铺进 **`<用户的资源根>/<库名>/`**（不污染根，也不要求用户已有这批图） |
| Q5 | 默认原名，**撞名（我们索引里已有同名 / 计划内已占位 / 目标盘上已有）才加 `_<短ID>`**——这一条同时保证认亲键 `name+ext` 唯一，避免「同名多义」把搬运进来的图又打回 unmatched |
| Q6 | `_thumbnail.png` **一律不搬、不进索引**（用户那「一张图三张缩略图」的正解）；是否灌进我们缓存留作后续优化 |
| Q7 | **幂等**：目标路径已有同尺寸文件就跳过；失败只进 warnings 不中断，重跑可补齐；不做事务回滚 |
| Q8 | **单流程**：每条先认亲（`name+ext` + size/宽高复核），命中就只挂标注不搬，没命中才搬；搬完**重新读一次索引**再走 A 档同一条合并链（不另写一套） |
| Q9 | 软删不搬只列名；Bookmark（无实体）跳过并上报；视频/字体走 `is_indexable` 拦下；密码夹整树跳过 |
| Q10 | 搬运栏并入 `MigrationReport`（带 serde default），不另起结构体；报告新增 `takeover_root` 让人能复核落到哪 |

### 5.1 原始问题与代价（保留）

**Q1 搬运语义：文件怎么从 `.library` 进图库根？**
| 选项 | 前提 | 代价 |
|---|---|---|
| a 复制 | 无 | 空间 ×1（库内副本仍在）；大库耗时 |
| b 同盘符硬链接 | 源与目标同盘 | 零额外空间；但 Eagle 侧删条目可能动到同一 inode 的链接计数，两边共用 inode 有长期风险 |
| c move | —— | **基本排除**：`.library` 被官方明令「勿改库内任何文件」，move 等于破坏 Eagle 库；除非用户明确「搬完即弃库」 |
| d 符号链接 | Windows 需开发者模式 | 用户环境门槛 |
倾向：**a 复制为默认 + b 硬链接为同盘符 opt-in**（§8.2 Q2 的结论：翻倍不是必然，但复制语义最干净、与「只读源侧」约束零冲突）。

**Q2 夹层级：落物理目录，还是落专题，还是双轨？**
C 档的存在意义是「接管文件」，夹层级落物理目录是默认预期；但 F5 说明**未分类是主流**（拖拽用法根本没夹），届时「物理目录」退化成全平铺。我们另有 `topic_files` 多对多——目录树给文件管理器用户，专题给应用内检索，两者不互斥。
倾向：**夹→物理目录（有夹时）＋夹→专题双轨**；无夹时只平铺＋标注，不造空洞的目录层。

**Q3 多归属：一条目属 N 个夹，物理上放几份？**（§8.2 Q1：社区三解都不好——复制 N 份/只放第一处/不落树）
倾向：若 Q2 双轨成立，此题缓解为「**物理放一份（主夹=第一个夹），全部归属落专题**」——空间与完整性的平衡，且报告如实计数。

**Q4 未分类条目落哪？** 图库根平铺 vs `<库名>/` 子目录。倾向：**子目录**（不污染根；A 档 smoke 已证明同根平铺的可匹配性，子目录不影响匹配——匹配走 name 不走路径）。

**Q5 命名与撞名**：`<name>.<ext>` 直接落盘会与图库根现有文件同名（同名不同图=歧义）。社区做法：`<name>_<ITEM_ID>.<ext>`（eaglecool-fuse 的消歧命名）。倾向：**默认原名、撞名才加 `_<ID>` 后缀**（保持优雅，歧义显式化），报告列撞名清单。

**Q6 缩略图**：`.info` 里 Eagle 已算好的 `_thumbnail.png` 要不要复用进我们的缓存？倾向：v1 不复用（我们缓存体系自有尺寸/格式约定），标记为后续优化。

**Q7 幂等/中断/回滚**：复制到一半挂了怎么办。倾向：按目标路径存在即跳过的幂等设计 + `import_records` 记录（`source='eagle'`），失败重跑安全；不做事务级回滚（复制语义下残留文件无害）。

**Q8 与 A 档的编排**：C 桬搬完文件后必须**复用 A 档的匹配+挂标注链**（搬→扫描→匹配→落标注），不能另写一套合并逻辑。先 A 后 C 或先 C 后 A 的重复导入要靠「并集/仅为空时填」天然幂等消化。

**Q9 特殊条目在 C 档**：Bookmark（无实体，F8 回退全空）→ 不搬、进报告栏；密码夹 → 整树跳过+上报（不解密不列内容，D7）；软删 → 不搬只列名（v4.5 拍板 A 先例）；视频/字体 → `is_indexable` 单点拦下（搬运都拦，标注更拦）。

**Q10 报告**：C 档报告 = A 档 MigrationReport + 搬运栏（复制数/硬链接数/跳过数/撞名改名数/字节数）。新增栏要不要进 `MigrationReport` 结构体还是 C 档独立结构，实现时定。

---

## 6. 硬约束（不许违反）

1. **只读 `.library`**：官方明令勿改库内文件；C 档只允许读，任何 move/写回都在禁令内（除非未来单独立项「弃库搬运」）。
2. **合并三策略与报告分栏契约**照 PixCall 期不变；「缺一栏=看起来像丢数据」。
3. **`is_indexable` 全仓单点**：不许在 Eagle 适配器散落扩展名黑名单。
4. **64 位 id 不进报告**的 PixCall 约束对 Eagle 天然不适用（id 是字符串），但 `order` 的字符串浮点同类坑仍在。
5. **桌面单端**。
6. 复测诚实原则：每条结论带证据等级；未实测的（样本缺口）不臆造。

---

## 7. 讨论时建议优先回答的三个问题（2026-10-06 已答，留档）

1. **C 档服务的用户到底是谁** → **已答（§0.5）**：面向所有 Eagle/PixCall 用户，目标是「搬过来的成本最低」。用户不用 Eagle 官方一键导出的理由：那是先导出一堆文件再自己想办法，而我们是「导出 + 标注 + 专题 + 检索」一次到位。
2. **Q2/Q3 连答** → **已定（§5.0）**：双轨 + 主夹物理一份，其余夹关系落专题。
3. **Q1 搬运语义** → **已定（§5.0）**：硬链接优先、失败降级复制，不做 move；接受「不想与 Eagle 共用数据」的人改用复制开关。

---

## 更正记录

| 版本 | 内容 |
|---|---|
| v1（2026-10-06） | 首版。A 档已实现、C 档待讨论；§5 是 Q1–Q10 的待决清单 |
| v1.1（2026-10-06） | **产品定位拍板（P7）**：我们是 Eagle/PixCall 的竞品，迁移 = 让用户搬过来的成本最低 → **C 档升主航道并实现、A 档退化为 C 的一步、B 档出局**。撤销 v2.2 那套「切根→扫描→probe→import」接管链（它把 `*.library` 当资源根 = 被否决的路线 B，实测网格退化成 49 个 `.info` 文件夹 / 每图 3 张缩略图）。§5 的 Q1–Q10 全部定稿（§5.0） |
