# Eagle 数据迁移 · 格式调研

> **版本 v1（2026-09-30）**
> 目的：为 `core/src/import/eagle.rs`（设计方案 §6.4 预留的第二期来源）把 Eagle 的数据落在哪、长什么样、有几种读法查清楚，并给出字段映射草案与待拍板清单。
> **方法诚实声明**：本机**没有 Eagle**（`%APPDATA%`、`%LOCALAPPDATA%` 无 Eagle 目录；C/D/E 盘 depth≤4 内无任何 `*.library`），所以本文没有一条是**本机实测**。每条结论带来源与置信度，标注体系见 §0 末。**下一步是拿真实库复测，不是照本文开工。**
> 上游文档：`docs/PixCall数据迁移-设计方案.md`（下称「设计方案」，本文的 §N 引用除非注明皆指该文）。
> **v2（2026-10-05）**：本机实测已完成（Eagle 4.0.0 build20260401 + `Test.library` 49 条目，全程开着 Eagle），新增 §13。上文的「方法诚实声明」（无本机实测）**仅对 v1 有效**；§13 全部为【实测】，与 v1 结论冲突处**以 §13 为准**。
> **交接入口**：与外部讨论 Eagle 导入方案用 `docs/Eagle数据迁移-方案讨论稿.md`（自包含简报：现状/已拍板/C 档待决问题清单），本文是其背后的规格书。

---

## 0. 结论摘要

1. **Eagle 的库不是数据库，是一堆 JSON + 实体文件。** 没有 SQLite、没有 `.db`、没有 WAL。设计方案 §6.4 那句「`.library/` 目录 + 每图 JSON sidecar，**不是 SQLite**」**方向正确**，本文把它的准确名字补齐：sidecar 叫 `metadata.json`（不是 `metainfo.json`，后者查无实据），路径是 `images/<ITEM_ID>.info/metadata.json`。顺带排雷：`eagle_library.db` 这个名字在 GitHub 代码搜索里 **0 命中**，网上流传的说法是假线索。
2. **★ Eagle 把文件复制进库，而且不记原路径。** 官方原话：「Eagle 在导入文件时会将文件复制一份到资源库中，而不是仅创建索引链接到原始文件。」这意味着设计方案的命根子——§6.3 的「重建路径 → `normalize_path` → 精确匹配 `file_index.path`」——**对 Eagle 不成立**：库里的文件躺在 `.library` 包内，用户原本散落各处的目录里根本没有它。**这是 Eagle 期与 PixCall 期最大的不同，也是本期第一个要拍板的产品问题（§5、§9）。**
3. **好消息：字段比 PixCall 干净。** 标签直接是**字符串数组挂在条目上**（没有 tag id、没有词表 join）；id 是 **13 位 `[A-Z0-9]` 字符串**（⑥ 那条「64 位整数过 JSON 丢精度」的坑天然不存在）；手动夹与智能夹**分家**在两个数组里（不需要 PixCall 那种「`filters='{}'` + 成员表有没有行」的双信号判据）。
4. **现成的东西很多**：一份公开的真实 Eagle 4.0.0 库样本（含 JSON 原文）、一套 Rust 只读解析器（`ghostzero/eagle-cli`）、一份**官方机器可读的 API 文档**、以及**PixCall 自己就有官方「Eagle 导入插件」**——后者直接告诉我们同类产品在迁移时保留什么、丢什么。清单见 §8。
5. **两条读取路线，推荐 A 为主、B 为补**：A = 离线直读 `.library`（字段最全、不需要 Eagle 开着）；B = 走 Eagle 官方本地 HTTP API `http://localhost:41595`（官方契约、但文档 2022-11 停更，字段是磁盘 JSON 的子集）。详见 §6 的对比表。

**置信度标注体系**（本文每张表都用它）：

| 标记 | 含义 |
|---|---|
| 【一手】 | 本次会话中**我本人**拉取并读过原文（源文件 / 官方页面），关键值逐字核对 |
| 【代理】 | 子代理查得并给出出处，我**未**逐字复核——落码前需二次确认 |
| 【推断】 | 从样本或代码行为推出来的，没有权威陈述 |

---

## 1. 库发现（`discover()` 的输入）

| 途径 | 内容 | 置信度 |
|---|---|---|
| **Eagle 的注册文件** | `<appData>/Eagle/Settings` —— 一个**无扩展名**的 JSON 文件，键 `libraryHistory: string[]` = 各 `.library` 的绝对路径。Windows：`%APPDATA%\Eagle\Settings`；macOS：`~/Library/Application Support/Eagle/Settings` | 【一手】文件与键名在 `onmokoworks/Eagle-viewer/server/platform.ts:35,46-52` 里读得到（`settings.libraryHistory \|\| []`），:73 还有「扫父目录取 `*.library` 子目录」的兜底 |
| **官方 HTTP API** | `GET http://localhost:41595/api/library/history` → `{"status":"success","data":["/Users/augus/Google Drive/Design fields.library", …]}`；`GET /api/library/switch`、`/api/library/info`、`/api/application/info` 配套 | 【一手】官方文档 `api.eagle.cool/library/history.md` 原文 |
| **UI 里看** | 点左上方资源库名称 → 「历史载入资源库记录」窗口给出完整路径 | 【一手】官方帮助文章 |
| **环境变量** | `EAGLE_LIBRARY` / `EAGLE_LIBRARY_PATH`（生态惯例，非官方） | 【代理】 |
| **注册表** | 未发现任何 Windows 注册表参与 | 【代理】缺席即结论，别当已证 |

要点：**默认库路径不存在**——Eagle 首次启动引导用户自己选位置，所以发现逻辑必须以「注册文件 + 扫盘兜底」为准，不能猜路径。【代理】

**建议的 discover 顺序**（对齐设计方案 §6.3 的写法）：① `<我们当前根>` 下（含一级子目录）找 `*.library` 且满足有效性判据的目录；② `%APPDATA%\Eagle\Settings` 的 `libraryHistory`，**过滤掉已不存在的项**（对应 PixCall 那条「注册了没建库」的教训）；③ 多于一个给选择列表。**有效性判据**（两个独立实现一致）：`metadata.json` 是文件 **且** `images/` 是目录。【一手：`ghostzero/eagle-cli/src/library.rs:27-30`】

---

## 2. 库的内部结构

```
<Name>.library/
├── metadata.json            # 库头：folders 树 / smartFolders 树 / quickAccess / tagsGroups / applicationVersion
├── mtime.json               # { "<ITEM_ID>": <epochMs>, … , "all": <条目数> }   ← 增量变更日志
├── tags.json                # { historyTags: string[], starredTags: string[] }   可选【代理】
├── actions.json             # 批量/"快速操作"                                   可选【代理】
├── saved-filters.json       # 用户保存的筛选条件                                【代理，未确证普遍存在】
├── backup/                  # Eagle 自己的元数据备份                            【代理，未确证普遍存在】
└── images/
    └── <ITEM_ID>.info/               # 例：MGMYDH18YSIS1.info
        ├── metadata.json             # 条目元数据（本文 §3.1）
        ├── <name>.<ext>              # 实体文件，文件名 = 显示名 + 扩展名
        └── <name>_thumbnail.png      # 除 noThumbnail 外；也见 .jpg/.webp
```

- 结构图与三个根文件的角色【一手】：我逐字读过公开的真实样本 `naamiru/eagle-webui/docs/sample-library/`（`applicationVersion: "4.0.0"`，23 个条目 id + `"all": 23`）。
- `images/<ITEM_ID>.info/` 的拼法与「`readdir(images/)` 才是条目 id 的权威来源」【一手】：`eagle-cli/src/library.rs:54-62,114-121`。
- **`<ITEM_ID>` 目录名要优先于 JSON 里的 `id` 字段**（不一致时以目录名为准）【一手：`eagle-cli` 的 `read_item`】。
- **`mtime.json` 的 `"all"` 是计数，不是某个条目的 id**，解析时要显式排除这个键【一手：样本里 `"all": 23` 与 23 个 id 并列】。
- 它「可能落后于真实状态」→ 条目集合以 `readdir` 为准，`mtime.json` 只当增量提示【一手：`eagle-cli` 注释与实现】。
- **没有 `recyclebin/` 目录**：Eagle 的软删除是原地的 `isDeleted` + `deletedTime`，文件不动【代理，需在样本里复验】。
- 根目录是**扁平**的：`images/` 下面一层就是 `<id>.info/`，**库内不存在“文件夹”这一层目录**，Eagle 的夹纯粹是逻辑关系（这也是为什么在资源管理器里看不到分类树，用户被反复告知「千万不要随意调整资源库路径下的任何文件」——官方原话【一手】）。

---

## 3. 字段清单

### 3.1 条目级 `images/<id>.info/metadata.json`

**只有 `id` 是必需**，其余键可能整体缺失，也可能单条目缺失——解析侧要全部按 Optional 处理。【一手：社区解析器与官方样本一致】

| 键 | 类型 | 语义 | 依据 |
|---|---|---|---|
| `id` | string | 13 位 `[A-Z0-9]`，如 `MGMYDH18YSIS1`。跨库合并时的全局去重键 | 【一手】样本；【一手】官方 `folder/list` 样例 `JMHB2Y3Y3AA75` |
| `name` | string | 显示名（不含扩展名），与实体文件名同源 | 【一手】样本 |
| `ext` | string | 扩展名，无点 | 【一手】 |
| `size` | int | 字节 | 【一手】 |
| `width` / `height` | int | 像素 | 【一手】 |
| `tags` | string[] | **标签名本身**，不是 id。全局命名空间 | 【一手】样本 `["Animal","Bird"]` |
| `folders` | string[] | **夹 id** 数组，顺序即成员顺序 | 【一手】样本 `["MGH4XZ1OQCGZD"]` |
| `order` | `{ "<folderId>": "1759876940271.5" }` | 该条目在指定夹内的手动位置（值是**字符串**形式的浮点时间戳） | 【一手】样本 |
| `annotation` | string | 「备注」正文 | 【一手】样本（本条为空串） |
| `url` | string | 来源网址 | 【一手】 |
| `isDeleted` | bool | 软删除（回收站） | 【一手】 |
| `deletedTime` | int? | 删除时间 | 【代理】 |
| `star` | int 0–5 | 评分/收藏 | 【一手】官方文档 `/api/item/update` 的 `star` 与样例 `"star": 4`；【代理】称「非整数即字符串」，需在样本复验 |
| `btime` | int ms | 加入库的时间 | 【一手】样本 |
| `mtime` | int ms | 源文件的创建时间 | 【一手】样本 |
| `modificationTime` | int ms | Eagle 内部排序用 | 【一手】样本 |
| `lastModified` | int ms | 与根 `mtime.json` 联动 | 【一手】样本 |
| `palettes` | `{color:[r,g,b], ratio, $$hashKey}[]` | 主色板。**`$$hashKey` 是 Angular 残留，忽略**（官方文档样例里也带着它，别当脏数据 bug） | 【一手】样本 + 官方 `llms-full.txt` |
| `noThumbnail` / `noPreview` | bool? | 无缩略图 / 无预览 | 【一手】`noThumbnail` 样本里为 `true` |
| `duration` / `medium` / `bpm` / `fontMetas{numGlyphs}` | 杂 | 视频时长 / 媒体类型 / 音频节拍 / 字体度量 | 【代理】 |
| `comments` | `{id,x,y,width,height,annotation,duration,lastModified}[]` | **图片上的矩形区域标注**（Eagle 4.0 build22+ 才有） | 【一手】官方插件文档 `developer.eagle.cool/plugin-api/api/item.md` 里 `comments` 确实存在；字段明细【代理】 |

**我们这边没有的天然对应物**：`textContent`/OCR、条目级 description（只有 `annotation` 一个）、颜色标签（智能夹规则里的 `color` 走的是 `palettes`）、除 `btime` 外的第二个「加入时间」。这几项查无实据，不要臆造。

### 3.2 库级 `metadata.json`

顶层键（【一手】样本逐字核对）：`folders[]`、`smartFolders[]`、`quickAccess[]`、`tagsGroups[]`、`modificationTime`、`applicationVersion`。

| 对象 | 键 | 备注 |
|---|---|---|
| **文件夹节点** | `id` `name` `description` `children[]` `modificationTime` `tags[]` `password` `passwordTips` `coverId` `orderBy` `sortIncrease` `icon` `iconColor` | 【一手】样本含前 12 个中的 10 个。**子夹是完整对象嵌在 `children` 里，没有 `parent` 字段**，所以层级用递归解；`tags[]` 是「夹的自动打标规则」，不是夹自身的标签；`iconColor` 取值 `red/orange/yellow/green/aqua/blue/purple/pink`【代理】 |
| **智能夹节点** | `id` `name` `description?` `icon` `iconColor` `modificationTime` `conditions[]` `children[]` `orderBy` `sortOrder?` | 【一手】官方 `/api/library/info` 样例可对上。**子智能夹继承父条件、彼此 AND**【代理】 |
| **规则形状** | `conditions: [{ match: "AND"\|"OR", boolean?: "TRUE"\|"FALSE", rules: [{ property, method, value }] }]`，组间 AND | 【一手】官方样例：`{match:"OR", rules:[{method:"within", property:"createTime", value:[7]}]}` |
| `property` 取值 | `tags` `folders` `type` `name` `rating` `color` `createTime` `btime`（另有 `mtime`/`importTime` 别名） | 【代理】枚举表，官方样例只出现过 `createTime` 与 `color` → **枚举未全量核实** |
| `method` 取值 | `intersection` `union` `subset` `all` `contain` `uncontain` `identity` `equal` `unequal` `gt` `gte` `lt` `lte` `within` `similar` | 【代理】同上；`rating` 实际比对条目 `star`；`color` 的值是 hex 且配 `method:"similar"`；`within` 的值是 `[N]` 天；`identity` = 排除 |
| `quickAccess` | `[{ type: "folder"\|"smartFolder"\|…, id }]` | 【一手】官方样例 |
| `tagsGroups` | `[{ id, name, tags: string[], color? }]`，**`id` 是 UUID**（与条目/夹的 13 位串不同源） | 【一手】官方样例 `{id:"c549d2a8-…", name:"Location", tags:["Kitchen"], color:"yellow"}` |

**手动 vs 智能的判据比 PixCall 干净**：手动夹在 `folders` 树里，智能夹在**另一棵** `smartFolders` 树里，**没有 `type` 判别字段，也不需要**。设计方案 ⑪ 那套双信号校验在这里退化成「你在哪个数组里」。

### 3.3 `.eaglepack`（素材包，另一条输入）

ZIP：`pack.json` = `{"images":[ …条目… ]}`，外加 `<ID>.info/` 目录装实体文件。条目键集与 §3.1 同构，多 `resolutionWidth`/`resolutionHeight`/`duration`。【代理，但被两个独立来源指向同一结论】

官方口径：eaglepack「可以保留标签（**不包含标签群组**）」；导出 eaglepack「保留文件的标签、注释、链接等信息」。【一手】

---

## 4. 与 PixCall 的结构性差异（决定方案的地方）

| # | 差异 | 对设计方案的影响 |
|---|---|---|
| **D1** ★ | **Eagle 复制文件进库、且不记原始路径**（条目 JSON 里没有 `path`/`originalPath` 这类键；实体文件在 `images/<id>.info/` 下）。官方明确：「不是仅创建索引链接到原始文件」 | **§6.3 的 join 链失效**。不能靠「重建路径 → `normalize_path` → `file_index.path`」，因为那些路径在我们库里根本不存在。必须换成 §9 的四条路线之一 |
| D2 | 我们 `file_index` **没有内容指纹列**（列为 `file_id/parent_id/path/name/file_type/size/created_at/modified_at/width/height/format`），而「内容指纹」在 2026-09-21 已被明确取消（三端功能矩阵 v4 头部） | 连「算个哈希认亲」这条退路都要先立个项目才能走。别指望它 |
| D3 | id 是 13 位字符串 | ⑥ 那条「不许把 64 位 id 过 JSON」的硬约束**不适用**，Eagle 的 id 可以随便进报告、进前端。但**别把它当数字**（`1759876940271.5` 那种 order 值是字符串，也是这个坑的变体） |
| D4 | 标签是**名字字符串数组**，没有 tag id、没有词表 | 少了 PixCall 那跳 `split('\|') → tags.id → tags.name` 解码。词表并集逻辑（§4.5 的「只写 `file_metadata.tags` 一处」）可直接复用 |
| D5 | 手动/智能**分家两棵树** | §6.4 的「手动/智能等判据」per-source 那一半，Eagle 侧比 PixCall 简单。但智能规则的**计数断言**要换对象：Eagle 的 `folder/list` 直接给 `imageCount` / `descendantImageCount`，可当 PixCall `file_count` 的等价断言源 |
| D6 | 一个条目可属**多个夹**（`folders[]` 数组），而磁盘上只有一份文件 | PixCall 也有多对多，但 Eagle 更直白。我们的 `topic_files` 支持一文件多专题，无影响；**报告里要避免按“文件数”重复计数** |
| D7 | 存在**密码夹**（`password` 字段，社区观察到值是 base64 明文） | 加密夹的成员一律跳过并上报条数，**不尝试解密、不列出其中内容** |
| D8 | 图上矩形标注 `comments[]`（4.0 build22+）**我们完全没有对应机制** | PixCall 官方插件同样明说「暂未支持的文件导入信息包括：文件标注」——全行业都丢。我们要不要丢，见 §10 待拍板 P4 |

---

## 5. 迁移的路线选择（★ 本期第一个产品决定）

D1 摆平之后才谈得上解码。四条路线，代价各不相同：

| 路线 | 做法 | 能拿到 | 代价 / 风险 | 适合谁 |
|---|---|---|---|---|
| **A. 只挂标注** | 用户**已经**把这些图纳入我们的库（自己从 Eagle 导出过、或另有副本）。我们按 `name`+`ext`+`size`(+宽高) 认亲，把 tags/annotation/url/夹结构挂上去 | 标注、夹→专题、来源链接 | **零复制、零文件系统写**，与 PixCall 期契约完全一致、重跑安全。但**重名/同名不同图有歧义**（`name` 会被用户在 Eagle 里改显示名，一改就断），命中率取决于用户是否两边都有 | 一直在两边混用、或已手动导出过的用户 |
| **B. 直接把 `.library` 当资源根** | 我们扫盘扫 `<lib>/images/*.info/*.<ext>`，路径 join 天然成立 | 全量，且路径唯一 | 网格里会混进 `_thumbnail.png` 与 `.info` 这层目录；库继续被 Eagle 拥有，**Eagle 里新增/删除后我们这边变僵尸行**（要重扫）；夹结构靠 metadata 而非路径 | 想快速验证、不在乎库被两个软件共用的用户 |
| **C. 我们负责把文件搬出库** | 导入时把 `images/<id>.info/<name>.<ext>` 复制进我们的根，按 Eagle 的夹层级落目录，同时挂标注 | 全量、结构最正 | **破坏「对文件系统零写」契约**：占空间翻倍（**v1.2 修正：不是必然——同盘符硬链接或 move 可做到零额外空间，见 §8.2 Q2**）、与安卓侧「不留副本换空间」的拍板相反（见 memory，**v1.2：该拍板在 memory 中查无实据**）、要处理重名与幂等、失败要能回滚。等于新做一个「导入器 + 文件整理器」+ **还要回答「一个条目属多个夹时复制几份」（§8.2 Q1：社区三种解都不好）** | 真正想告别 Eagle 的用户 |
| **D. 走 eaglepack** | 用户在 Eagle 里导出 `.eaglepack`，我们解 ZIP（`pack.json` + `<id>.info/`） | 与 A 同构的字段 + 实体文件 | 需要用户动手导出；大包解压耗时；格式无官方 schema | 想把某几个夹搬走、不要全量的用户 |

**推荐**：**A 为主功能，C 作为显式 opt-in 的第二档，B/D 都不做独立入口。** 理由：A 复用 PixCall 期已经建好、已经实测跑通的全部共享半（快照管理、合并策略、§4.7 报告、`import_records`、UI 组件、i18n 命名空间），且与「零文件系统写、纯增量、重跑安全」的既有契约同构；C 明显是另一个功能（要动用户的盘），单独拍板、单独切片，别混进第一期。**注意 A 的前提在 §10 P1 里——必须先确认验收人要的是哪种用户场景。**

---

## 6. 读取方式对比（技术层面，与 §5 正交）

| 方式 | 契约稳定性 | 字段覆盖 | 前提 | 备注 |
|---|---|---|---|---|
| **直读 `.library`（推荐主路）** | 无官方契约（官方只说别改） | **全**：`star`/`btime`/`mtime`/`order`/`comments`/`palettes` 都在 | Eagle **不必**开着；能读离线盘/外置盘 | 纯 JSON，无库文件锁；社区多个只读工具与 Eagle 同时开库并发读，未见问题【一手：代码 + README 声明「read-only」】 |
| **官方本地 HTTP API `:41595`** | 官方文档 | **子集**：文档里的 `item/list`、`item/info` 结果**没有** `star`、`btime`、`mtime`、`order` | **Eagle 必须开着**；1.11 Build21(2020-06-17)+ | 官方口径是 `http://localhost:41595/`，「服务端随 Eagle 启动而启动」。文档 Changelog 最后一条是 2022-11-01（客户端 3.0 Build23）→ **文档可能落后于实现**，字段以实测为准。官方文档未提任何鉴权（样例就是裸 `fetch`），并明说「不限调用次数，因为连接都在本地」；CORS 那段只约束浏览器扩展脚本，**我们 Rust 侧直接发 HTTP 不受影响** |
| **官方插件 API（Node，`developer.eagle.cool/plugin-api`）** | 官方文档 | 最全，含 `item.filePath` / `fileURL` / `thumbnailPath` / `metadataFilePath` / `importedAt` / `modifiedAt` / `star` / `comments`、`smartFolder.getRules()`、`tagGroup.get()`、`library.path` | 要发布/安装一个 Eagle 插件，且 Eagle 开着 | 【一手】`item.md` 里这些属性名确实存在。注意坑：**`findAll()` 不存在，用 `getAll()`**。插件是无沙箱 Node，能 `fs`。可作为「解析不够时」的补路，第一期不引入 |
| **eaglepack 解包** | 半官方（导出功能本身官方） | `pack.json` 里的键同条目级 | 用户手动导出 | 与直读共用同一套解码器即可 |

**API 交叉校验的妙用**：若 Eagle 正开着，可以用 `/api/library/history` 校 `Settings` 文件的库列表、用 `/api/item/thumbnail?id=` 返回的绝对路径反推库根（它形如 `/Users/augus/Pictures/test.library/images/KBKE04XSTXR7I.info/Rosto.jpg`，截到 `.library` 即库根）——两个独立来源对不上时报错而不是猜。

---

## 7. 字段映射草案（对着设计方案 §4 的表形）

策略列沿用已拍板的三条：**并集 / 仅为空时填 / 同名不新建 + `position` 续排**。

| Eagle 来源 | 我们落点 | 策略 | 状态 |
|---|---|---|---|
| `item.tags[]`（名字串） | `file_metadata.tags`（JSON 列） | 逐个过 `normalize()`，与我们已有标签取并集、保留我们已有顺序；只写这一处（§4.5 的结论复用） | 可定 |
| `item.annotation` | `file_metadata.description` | **trim** 后仅为空时填 | 可定 |
| `item.url` | `file_metadata.source_url` | 仅为空时填；**不做 URL 合法性校验**（PixCall 期就有一条误存的 `x.com/home`） | 可定 |
| `folders` 树（含 `children` 嵌套、`description`） | `topics` + `topic_files` + `topics.description` | 先序遍历，父节点先落库；查重键 `(映射后父级, name)`；同名不新建、成员并入、封面与描述空着才补（§4.6 全套规则照搬，v4.9 口径） | 可定 |
| `item.folders[]` 多值 | 一个条目挂进多个专题 | 全部落 `topic_files`；`position` 从 `COUNT(*)` 续排 | 可定 |
| `smartFolders` 节点 | **快照专题**（我们无智能专题机制） | 沿用 §4.6 规则 6-8：**只实现标定过的 `property`+`method`**，且成员数必须精确等于 Eagle 侧计数（`folder/list` 的 `imageCount`，或解析 `getItems`）才落表；断言不过或含未标定键 → 跳过并上报。子智能夹继承父条件的语义**先标定再实现**，未标定即跳过 | 待定：标定表从零开始 |
| `tagsGroups[]` | — | **丢弃 + 上报条数**（PixCall 的 `tag_groups` 就是这个先例；我们侧栏的拼音归组不等价于标签组，别混） | 可定（建议按先例拍板） |
| `item.star`（0–5） | — | **不迁**：我们全仓无评分（列/字段/UI/i18n 皆无，§5 原文） | 决定：不做 |
| `palettes[]` | — | 不迁：`colors.db` 已自算主色，格式不同构（§5 先例） | 决定 |
| `btime`/`mtime`/`modificationTime`/`lastModified` | — | 不迁：我们 `file_index` 用文件系统时间 | 决定 |
| `size`/`width`/`height` | — | 不迁（scanner 自算），但**用作 §5-A 的 join 键** | 复用 |
| `folders[].icon`/`iconColor`/`coverId`/`orderBy`/`sortIncrease`/`tags[]`（夹自动打标规则） | — | 不迁：固定封面是独立功能（§5 先例）；夹的自动打标规则是查询条件不是数据 | 决定 |
| `folders[].password`/`passwordTips` | — | **加密夹整体跳过并上报**，不解密、不列内容（D7） | 可定 |
| `isDeleted`(+`deletedTime`) | — | 不迁、不复制，报告里**只列名字**（沿用 v4.5 拍板 A 与 `excluded_trash_names`） | 可定 |
| `order` / `quickAccess` / `mtime.json` / `tags.json` / `actions.json` / `saved-filters.json` / `backup/` | — | 不迁：排序偏好、书签位、增量日志、历史标签词、批处理动作、保存的筛选、它自己的备份 | 决定 |
| `noThumbnail`/`noPreview`/`duration`/`medium`/`bpm`/`fontMetas` | — | 不迁；视频/音频/字体按 §4.9 的 `is_indexable` 单点拦下并计 `skipped_unsupported_type`（**不许在 Eagle 适配器里散落扩展名黑名单**） | 可定 |
| `comments[]`（图上矩形标注） | — | 我们无对应机制。三选一：① 丢弃 + 上报条数；② 把矩形文字拼进 `description`（会污染正文、丢位置）；③ 做「区域标注」功能（独立立项） | **待拍板 P4**（建议 ①） |
| 报告结构 | §4.7 的 `MigrationReport` | **直接复用**。`excluded_trash` 语义换成 `isDeleted`；`topics_materialized` 继续给智能固化 | 可定 |
| 迁移记录 | `import_records.source = 'eagle'` | 该表 `source` 已是自由 TEXT、无需改 schema（已核对：现有列为 `source/source_root/source_schema_version/imported_at/report_json/…`）。`source_schema_version` 填 Eagle 的 `applicationVersion`（如 `"4.0.0"`） | 可定 |

---

## 8. 现成参照实现清单（可直接抄判据/结构）

| 来源 | 语言 | 它读了什么 | 值不值得信 |
|---|---|---|---|
| [naamiru/eagle-webui](https://github.com/naamiru/eagle-webui) | TS | **仓库里带一份真实 Eagle 4.0.0 样本库**；解析 `metadata.json`/`mtime.json`/`images/<id>.info/`，含 `comments[].annotation`；用 ajv 校验，硬拒非 `4.` 前缀版本 | ★ 最高：真实数据 + 校验器 |
| [ghostzero/eagle-cli](https://github.com/ghostzero/eagle-cli) | **Rust** | 只读解析 + 自建 SQLite 索引、夹/标签/智能筛选、`doctor` 健康检查、导出、TUI、FUSE 挂载。README 明令**不许写回 `.library`** | ★ 最高：与我们同栈，判据可直译 |
| [onmokoworks/Eagle-viewer](https://github.com/onmokoworks/Eagle-viewer) / [power-eagle](https://github.com/power-eagle/power-eagle) | TS | `Settings` → `libraryHistory` 的库发现；密码夹检测 | 高（我逐行读过 `platform.ts`） |
| [pampas9000/debris](https://github.com/pampas9000/debris) | Go | **Billfish / Pixcall / Eagle 三格式互转**，Eagle 当中间层。`model/eagle/*.go` 列全了条目级/库级键名，`model/pixcall/*` 与我们的 PixCall 实测对得上 | 中高：字段名可信；它**写**出来的 `images/<id>.info/` + 根 `metadata.json` 布局是照 Eagle 猜的，作者自称「未准备好用于生产」 |
| [sena-nana/MomoBako](https://github.com/sena-nana/MomoBako) | Rust | Tauri 里的 Eagle→文件夹树导入器；把 `tags.json`/`actions.json`/`saved-filters.json`/`mtime.json` 全当可选 | 中：它的 fixture 是合成的（其 `rating`、`smartFolders.filter.formats` **不是真 Eagle 键**，别抄） |
| [progressions/eagle-browse](https://github.com/progressions/eagle-browse) | Py | 智能夹规则求值器 + 原子写（temp+`os.replace`+锁+备份），`SMART_FOLDERS.md` 有枚举表 | 中（求值器可参考，写侧我们不需要） |
| [lawvs/eagle-plugin-mini-map](https://github.com/lawvs/eagle-plugin-mini-map) 等插件 dts | TS | 插件 API 的 `Item`/`Folder`/`SmartFolder` 类型（`filePath`、`thumbnailPath`、`metadataFilePath`、`importedAt`、`getRules()`） | 中高：贴着官方形状 |
| [corkborg/eaglecool-fuse-filesystem](https://github.com/corkborg/eaglecool-fuse-filesystem) | C | **另一个真实 `test.library` fixture**（`applicationVersion: "4.0.0"`），根目录还有 `actions.json`、`Icon` | 中（【代理】我未开包核对） |
| [fanyang89/eaglexport](https://github.com/fanyang89/eaglexport) / [kznrluk/sdweb-eaglepack](https://github.com/kznrluk/sdweb-eaglepack) / [trojblue/eagle-exporter](https://github.com/trojblue/eagle-exporter) / [Stef4678/eaglepack-importer](https://github.com/Stef4678/eaglepack-importer) | Go/TS | 各种导出/eaglepack 方向 | 中：查判据时交叉印证用 |
| **官方**：[api.eagle.cool](https://api.eagle.cool/sitemap.md)（旧版 HTTP API，全文 `llms-full.txt`）+ [developer.eagle.cool/plugin-api](https://developer.eagle.cool/plugin-api/llms.txt)（新插件 API） | — | 端点、字段、智能夹规则样例、Changelog | ★ 官方，但旧 API 文档停在 2022-11 |
| **同类产品的答案**：[PixCall 官方「Eagle 导入」插件](https://docs.pixcall.com/docs/plugin/plugin-eagle-importer/) | — | 支持 `.library` 与 `.eaglepack` 两种输入；保留「文件本身、所在文件夹、文件名、标签组」+「标签、描述、来源网址、评分、创建时间」；**明说「暂未支持的文件导入信息包括：文件标注」** | ★ 最对口：同赛道、同数据模型诉求。注意它**迁走了评分**，而我们现在没有评分功能 |
| **同类产品**：[飞牛 Seek 的 Eagle 导入](https://help.fnnas.com/zh-CN/articles/v1/seek/seek-import-eaglepack) | — | **只吃 `.eaglepack`**；夹关系映射、同名标签复用、评论转素材描述、**来源链接「当前暂不导入」**、缩略图重新生成、回收站项忽略 | 高：另一个真实实现取的子集 |

### 8.1 按「它解决什么问题」重新分类（v1.2 增补，2026-10-01 实测拉取）

§8 上表按可信度列，这里按**做法**列——因为它们的选择直接回答 §5 的两条路线。

| 类别 | 项目 | 它怎么做的 | 对我们的价值 |
|---|---|---|---|
| **① 只读索引 / 挂载（不搬文件）** | [corkborg/eaglecool-fuse-filesystem](https://github.com/corkborg/eaglecool-fuse-filesystem)（Py+FUSE） | 把库挂载成目录树。**命名用 `<显示名>_<ITEM_ID>.<ext>`**（`blue_MF7XBDKD71MCF.png`），挂载出来的树里**没有 `.info` 层、没有 `_thumbnail.png`**。同名夹也靠加 ID 消歧（输出里 `samefolder_MF7X5W2L2ZJ34` 与 `samefolder_MF7X6HU53Z5W2` 并列） | ★ **直接解决 §5-B「网格混进缩略图与 `.info` 层」**：命名带 ID + 只暴露资产即可。代价：Windows 需 WinFsp，Tauri 桌面别想 |
| ① | [ghostzero/eagle-cli](https://github.com/ghostzero/eagle-cli)（Rust） | 只读 + 自建 SQLite 索引 + FUSE + `doctor` | ★ 同栈，判据可直译 |
| ① | [naamiru/eagle-webui](https://github.com/naamiru/eagle-webui)（TS） | 带真实 4.0 样本库 + ajv 校验，**硬拒非 `4.` 前缀** | ★ 样本与校验器 |
| **② 导出成真实目录树**（= §5-C） | [tdccj/eagle_export](https://github.com/tdccj/eagle_export)（Py，中文） | **多归属 = `shutil.copy` 复制多份**（对 `folders[]` 每个 id 各拷一份 → 空间 ×N）；**sidecar 方案**：把 metadata 重写成 `<文件名>.json`（`#name:`/`#tag:`/`#url:`/`#annotation:` 文本头 + 原始 JSON 尾巴）；文件名加序号前缀消歧；**不排除缩略图**；**`folders:[]` 条目被静默丢弃**。已知 bug：夹有简介会崩 | ★ 唯一把「多归属怎么落物理树」写死的实现，**答案是复制多份**。旁证 M5 |
| ② | [ivomynttinen/eagle-library-transformer](https://github.com/ivomynttinen/eagle-library-transformer)（Py, 2025） | 复制（不移动）到 `dist/`，**规范化文件名**（去空格与特殊字符），排除缩略图，可选只处理图片，全部 metadata 合并成一个 JSON | 中：文件规整化的做法可参考 |
| ② | [fanyang89/eaglexport](https://github.com/fanyang89/eaglexport)（Go） | 导出到本地 fs 或 **SMB**，**带智能夹过滤** | 中：智能夹求值 + 远端落地 |
| ② | [NaughtDZ/fkoff_eagle](https://github.com/NaughtDZ/fkoff_eagle)（Py, 2026-02） | **反面教材即需求证据**：用户吐槽「Eagle 全复制，300G 库根本导不出来」。做法 = 在线用 API 抓目录树 → **提示用户关掉 Eagle** → `shutil.move` **移动**（非复制），**必须同盘符**（指针修改，0.01 秒/文件，不占空间） | ★ **证明「想告别 Eagle」是真实需求，且痛点正是空间**。§5-C 那条「占空间翻倍」在这里被反驳了一半 |
| ② | [diak345/eagle_export_link](https://github.com/diak345/eagle_export_link)（Eagle 插件, 2026-03） | 导出选中项为**符号链接或硬链接**，保留夹结构。**硬链接同盘符才行；符号链接在 Windows 要开发者模式** | ★ **唯一真正解决「空间翻倍」的现成方案**（同盘符硬链接 = 零额外空间） |
| ② | **Eagle 官方自己**：批量导出所有文件夹及其内容 | 官方帮助明写「导出的文件会保留原来的文件夹结构」 | ★★ **最重要**：路线 C 的搬运活 Eagle 官方已经能做，**我们不必重复造**。C 若要立项，先问「用户为什么不用官方导出」 |
| **③ 只导出元数据**（= §5-A） | [trojblue/eagle-exporter](https://github.com/trojblue/eagle-exporter)（Py） | 递归扫 `images/` 的 JSON，抽 tags / star / palette，**`--include-images` 可选**，导出到 **Parquet 或 HuggingFace Dataset** | 中：路线 A 的最纯粹形态（只抽标注，不碰目录） |
| ③ | [Stef4678/eaglepack-importer](https://github.com/Stef4678/eaglepack-importer)（Obsidian 插件） | 每条 → 一个 Markdown + YAML frontmatter（id/name/ext/size/星级/url/btime/annotation/夹路径/原始标签）；**folder mirroring 是可开关项**（默认镜像成 vault 文件夹，关掉则**扁平导入**）；标签转 Obsidian 标签；安全重导入（已存在默认跳过） | ★ **与我们最同构的同类**：目标系统另有组织方式 → 它把「夹→物理目录」做成**开关**，并把多归属化解为「不落物理树、只落 frontmatter」。这正好是 §5 的 P2 该抄的形态 |
| **④ 格式互转（写 Eagle 库）** | [pampas9000/debris](https://github.com/pampas9000/debris)（Go） | Billfish ↔ Pixcall，**用 Eagle 当中间层**；是**写**侧，作者自称 not production-ready | 中：字段名可信，写出的布局是猜的 |
| ④ | [kznrluk/sdweb-eaglepack](https://github.com/kznrluk/sdweb-eaglepack)（Go） | 生成可导回 Eagle 的 `.eaglepack` | 低：我们不做写侧 |

### 8.2 两个硬问题，社区的答案（v1.2 新增，直接喂给 §10 P1）

**Q1：一个条目属多个夹，落物理目录树时怎么放？——没有优雅解，只有三种粗糙解。**

| 解 | 谁在用 | 代价 |
|---|---|---|
| ① **复制多份** | tdccj/eagle_export | 空间 × 归属次数；同一张图在 N 个目录里是 N 个互不相干的副本，改一处不同步 |
| ② **只放第一处** | 多数导出器 | 静默丢失其余归属 |
| ③ **不落物理树，只落元数据** | Obsidian 插件的扁平模式、eagle-exporter | 放弃目录结构，改用标签/frontmatter 检索 |

→ **这反过来证明 `topic_files` 的多对多模型是对的，而 §5-C 才是那个要向「物理树」妥协的坏选择。** 走 C 就必须先回答「复制几份」，三个答案都不好；走 A/B 则根本不存在这个问题。**这是推荐 A 的一个比「零文件系统写」更硬的理由，§5 漏了。**

**Q2：「占空间翻倍」是必然吗？——不是。** §5-C 把「占空间翻倍」写成 C 的固有代价，**这条要修正**：

| 手段 | 前提 | 来源 |
|---|---|---|
| **硬链接** | 同盘符 | eagle_export_link 明确支持 |
| **`move` 不 `copy`** | 同盘符（OS 只改指针，0.01 秒/文件） | fkoff_eagle |
| **符号链接** | Windows 需开发者模式 | eagle_export_link |
| **官方导出** | 无（Eagle 自己做，且保留夹结构） | 官方帮助 |

→ 也就是说 C 的代价是**「要处理同盘符约束 + 链接/移动语义」**，不是必然翻倍。同时 fkoff_eagle 证明：真实用户卡住的正是这件事，需求是真的。

### 8.3 社区确认存在、本文漏掉的条目类型（v1.2 新增）

| 类型 | 证据 | 对我们的影响 |
|---|---|---|
| **Bookmark / 网页条目**：有 `url`、**没有实体文件**（`.info` 里只有 metadata.json + 预览图，有时还带 Windows `.url` 快捷方式） | 【一手】`Stef4678/eaglepack-importer/docs/FORMAT.md` 明文；插件专门把它渲染成「标题 → 可点链接 → 预览图」 | **§5-A 的 `name`+`ext`+`size` 键对它完全无效**（无 `ext`、无 `size`）。必须先判「有没有实体文件」再决定走哪条路。**本文 §3.1 与 §7 都没定义它** |
| **未分类条目（`folders: []`）** | 【一手】tdccj/eagle_export 对空 `folder_id` 直接 `continue` → **静默丢弃**，任何目录都不进 | 印证 §12 的 M5：社区也没处理好。我们必须显式定义（跳过 / 挂根 / 单列报告栏） |

### 8.4 可抄的解析策略（v1.2 新增）

`Stef4678/eaglepack-importer` 的 parser 有三条设计决策**比我们 §2 的「按路径猜」更稳，建议直接抄进 `eagle.rs`**：

1. **按内容分类 JSON，不按文件名**：有 `images` 数组 → `pack.json`；有字符串 `id` → 条目级；有 `folders`/`smartFolders`/`orderedList` 且无 `id` → 库头。（库头与条目 JSON **同名**，只能靠内容分）——顺带记一个新键：**库头还可能有 `orderedList`**，本文 §3.2 未列。
2. **资产定位三级回退**：精确 `<name>.<ext>` → `name.*` → 取最大的那个文件；`*_thumbnail.png` 单独识别为预览并**排除**。→ 这就是 §5-B/C 需要的「别把缩略图当条目」的解法。
3. **ZIP 不整体解压**，先读 central directory。

### 8.5 新增假线索（v1.2 新增）

- **「Eagle 用自定义 SQLite 数据库 + JSON 描述文件」**——一篇 2026 年的 Eagle/Hydrus/Bridge 横评（numonic.ai）仍这么写。**已证伪**（真实样本 + 官方 API + 多个解析器全程无 `.db`）。说明这类二手错误仍在流传，别被它带偏。

---

## 9. 还没查清（开工前必须补）

1. **没有任何一条本机实测。** 本文全部来自公开来源。设计方案的 §2 那种「每条都可复核」的编号结论（①-⑭），Eagle 这边**一条都还没有**。
2. **Eagle 2.x / 3.x 与 4.x 的 JSON 差异完全未知。** 所有证据都是 `applicationVersion: "4.0.0"`；`eagle-webui` 甚至硬拒非 `4.` 前缀。老库升级过后的样子、字段缺失分布，只能等样本。
3. `actions.json` / `saved-filters.json` / `backup/` / `tags.json` 是否每个 4.x 库都有（只有单个 2024 工具与一份合成 fixture 列过它们）。
4. **智能夹规则的全量 `property`/`method` 枚举**（§3.2 那张表【代理】）——它直接决定 D5 的标定表能写多满，而 §4.6 规则 7/8 的「只实现标定键 + 计数断言」全靠这个。
5. **条目实体文件名在用户改显示名后会不会跟着改** —— 决定 §5-A 路线的命中率。`<name>.<ext>` 与 `metadata.name` 在样本里同源，但没验过重命名。
6. 官方「导出到计算机 / 导出为 CSV」的产物到底带不带标注、带哪些列（CSV 文档说含 names/tags/source URLs，**`annotation` 是不是列：未确认**）。这决定 §5-D/备选路。
7. `deletedTime` 是否普遍存在（软删判据到底看 `isDeleted` 还是别的，PixCall 期在这上面翻过车——⑫ 的教训）。
8. 官方是否支持「Eagle 运行时读库」——**没有任何官方陈述**，只有第三方工具的行为证据。
9. 并发读是否需要 `NSFileCoordinator` 一类处理（iCloud Drive/Dropbox 上的库；直读侧要防「未下载的占位文件」）。

**需要验收人提供的真实样本清单**（照着在 Eagle 里造一遍即可，与设计方案 §7 的样本缺口同形）：
一个 `.library`，里面至少包含：① 嵌套两层的普通夹；② 至少一个智能夹（含 `tags` 与 `color` 两种 `property`）；③ 至少一个标签组（`tagsGroups`）；④ 一张带标签 + 备注 + 来源链接 + 评分的图；⑤ 一个**同时属于两个夹**的条目；⑥ 一个密码夹；⑦ 一张做了图上矩形标注（`comments`）的图；⑧ 一个回收站里的条目；⑨ 一个视频或字体（验证 `is_indexable` 那条路）；⑩ 夹的描述文字。
外加：样本的 `applicationVersion`，以及**同一台机器上 Eagle 是否开着**（我们要顺手验 §9-8）。

---

## 10. 开工前提与待拍板

**先测量，后设计**（PixCall 期 §3 那一轮「命中率关键测量」在 Eagle 这边是**缺失的**，且因为 D1，它测的东西不一样）：

拿到样本后第一步不是写 `eagle.rs`，而是回答**「Eagle 条目 → 我们 `file_index` 行的可匹配率到底有多少」**：
1. 取样本全部非软删条目，按 §5-A 的键（`name`+`ext`，再叠 `size`、`width`/`height`）去我们的库里匹配；
2. 统计：唯一命中 / 多义（同名不同图）/ 不命中，三档各多少；
3. 顺带验 §9-5（改显示名是否改文件名）与 §9-7（软删判据）。
**这个数字直接决定 §5 走 A 还是必须走 C**——如果真实用户的匹配率低于某个水平（建议线：80%），「只挂标注」这条最干净的路就根本走不通，得回头拍 C。

**待拍板（产品层，他定）**：

| # | 问题 | 选项 |
|---|---|---|
| **P1** | Eagle 那期到底面向哪种用户？（= §5 的路线选择） | A 只挂标注（零文件系统写，复用现有全部共享层）/ C 连文件一起接管（要新做文件搬运 + 回滚）/ A+C 两档 |
| P2 | 智能夹 | a 一律固化为快照专题（含未标定条件→跳过并上报）/ b 只处理能计数断言通过的 |
| P3 | 标签组 `tagsGroups` | a 丢弃 + 上报（PixCall 先例）/ b 迁成专题 / c 侧栏加标签组 |
| P4 | 图上矩形标注 `comments[]` | a 丢弃 + 上报（PixCall 插件同样丢）/ b 文字拼进备注 / c 立项做区域标注 |
| P5 | 评分 `star` | 我们无评分功能 → 需要「先做评分功能」还是「不迁」（PixCall 期不迁，但 PixCall 自己的 Eagle 插件是**迁了**评分的） |
| P6 | 读取路径 | 主 A：直读磁盘（推荐）/ 加一条 API 交叉校验 / 做 Eagle 插件 |

**实现顺序**（拍板后）：与设计方案 §6.6 同构——① 先跑 §3 基线门（`tsc` + `vitest` + `cargo check` + `npm run build`）；② Rust 侧 `core/src/import/eagle.rs`：发现（§1）、解码（§3）、分类顺序（§4.8 的变体：先排软删→再排 `is_indexable`→再匹配→再合并）、用 dev-only 命令把报告逐栏打出来；③ 复用 `import_records`（`source='eagle'`）；④ UI 侧在设置-存储那张折叠卡**同一条列表**里并一张 Eagle 的卡（v4.13 已定口径：整宽、同构、不要再各自定宽），welcome 那颗要不要加第二来源另议；⑤ i18n 进 `translations.ts` 的 zh/en 两块。

---

## 11. 对现有两份文档的影响

1. **设计方案 §6.4 需要两处更正**（按惯例升版本号 + 记「更正记录」）：
   - 「`.library/` 目录 + 每图 JSON sidecar」→ 补准确形态：根 `metadata.json` + 根 `mtime.json` + `images/<ITEM_ID>.info/{metadata.json, <name>.<ext>, <name>_thumbnail.png}`。**不是 SQLite 这一点确认无误。**
   - 「Eagle 适配器的格式调研等验收人给一个真实库后再做，本期只留接口与目录结构，不猜它的 schema」→ 调研已按公开来源完成（本文），但**「留接口」这件事本身要改**：§6.4 的 trait 契约默认了「源侧路径能 join 到我们 `file_index`」，而 D1 证明这个默认对 Eagle 不成立。契约要么把 join 策略也 per-source 化，要么等 P1 拍板后再定。
2. **`core/src/import/mod.rs:7-8` 的模块注释**同样只写了「`.library/` 目录 + 每图 JSON sidecar」，可与上面一起补齐，并在「不许把复制 db+wal 写进契约」那句后面加一条：**也不许把「路径 join」写进契约**。
3. **`import_records` 不用改**（`source` 是自由 TEXT，已核对现有列集）。
4. **三端功能矩阵里没有 Eagle 导入这一行**（已查，全仓 `eagle` 命中只在设计方案与 `core/src/import/` 的注释里）——它是桌面单端功能，矩阵是跨端口径，不登记；若要登记进里程碑，得在设计方案或独立规划文档里挂账。

---

## 12. 可行性审查（v1.1，2026-10-01 复核）

复核方式：**外部来源重拉原文 + 本地代码/schema 逐条对**。结论分四档，H = 影响可行性、必须改；M = 会踩但能救；L = 措辞/台账。

### 12.1 复核通过（可放心当地基用）

| 项 | 复核方式与结果 |
|---|---|
| **D1 官方原话** | 重拉官方帮助中心原文，逐字一致：「Eagle 在导入文件时会将文件复制一份到资源库中，而不是仅创建索引链接到原始文件。」**全文最硬的一条，站得住。** 文章未提任何原始路径字段 |
| **§3.1 条目字段表** | 重拉样本 `MGMYDH18YSIS1.info/metadata.json` 原文，键名与表格**逐一吻合**：`id`(13 位) `name` `size` `btime` `mtime` `ext` `tags` `folders` `isDeleted` `url` `annotation` `modificationTime` `height` `width` `noThumbnail` `lastModified` `palettes`(含 `$$hashKey`) `order`(字符串浮点)。**样本中没有 `star`、`comments`、`deletedTime`** → 这三项标【代理】是对的 |
| **§6 API 对比** | 重拉 `api.eagle.cool/llms-full.txt`：端口 `41595` ✅；`/api/library/history` 返回示例与本文逐字一致 ✅；`item/list`、`item/info` 的返回字段确为 `id/name/size/ext/tags/folders/isDeleted/url/annotation/modificationTime/width/height/lastModified/palettes`，**确无 `star`/`btime`/`mtime`/`order`** ✅；`/api/folder/list` 确返回 `imageCount`/`descendantImageCount` ✅（D5 的计数断言源可用） |
| **§8 PixCall 官方插件** | 重拉原文：支持 `.library` 与 `.eaglepack`；保留「文件本身、所在文件夹、文件名、标签、描述、来源网址、评分、创建时间、标签组」；「暂未支持：文件标注」。**复述准确**，且它确实迁了评分 |
| **D2 `file_index` 列集** | 对 `core/src/db/file_index.rs:23-35`：列确为 `file_id/parent_id/path/name/file_type/size/created_at/modified_at/width/height/format`，**确无内容指纹列** ✅ |
| **§7 `import_records` 不改 schema** | 对 `core/src/db/import_records.rs:36-48`：`source` 是自由 TEXT ✅，本文所列列集一字不差 ✅ |
| **§7「star 不迁」** | 全仓核过：`core/` 无 rating/star 字段；`src/` 的命中全是 `startsWith`/`start` 误匹配。**「我们无评分功能」成立** |
| **有效性判据 / 目录名优先 / `"all"` 是计数** | 与样本和解析器行为一致，合理 |

### 12.2 H — 影响可行性，必须先改

**H1. 「A 复用 PixCall 期已建好的全部共享半」不成立——匹配层必须重写。**
`core/src/import/mod.rs:137-190` 的 `OurIndex` 只有两张表（`exact`/`by_lower`），**键都是 path**；`IndexedRow` 只带 `file_id/path/file_type`；`load()` 的 SQL 是 `SELECT file_id, path, file_type FROM file_index`。而 §5-A 的 join 键是 `name`+`ext`+`size`(+宽高)——**一个字段都不在里面**。
真正能复用的是：`merge_tag_lists` / `fill_if_empty` / `is_indexable` / `apply_plan` / `find_topic_by_name` / `new_topic_id` / `record_import` / `MigrationReport` 结构体。**最核心的「怎么认亲」这一层要新造**（`OurIndex` 加 `by_name_size` 索引或整体 per-source 化，load 的 SQL 要带 name/size/width/height）。
→ §5 的推荐理由把成本说低了：这不是「复用」，是**改已经被 81 个用例护着、已跑通生产的共享层**，风险等级要上调。

**H2. 报告结构「直接复用」有个没解决的洞：`unmatched_paths`。**
`MigrationReport`（mod.rs:79-81）的 `matched` / `unmatched` / `unmatched_paths: Vec<String>` 语义是**路径**，Eagle 侧没有路径。§7 只写了「`excluded_trash` 语义换成 `isDeleted`」，没说这两栏装什么。三条路各有代价：塞 `name` → 字段名说谎；改名 → 影响前端 **且** 已有 PixCall `import_records.report_json` 的反序列化（旧记录的明细会静默变空）；加新栏 → §4.7「缺一栏就像丢数据」要重过一遍。
→ 这是**排在写码之前的第二个技术拍板**，本文漏了。

**H3. §10 的测量证明不了 §5-A 在真实场景成立——闭环上有个缺口。**
§10 说「拿到样本测可匹配率，低于 80% 就回头拍 C」。但 A 的前提是「用户**已经**把同一批图纳入我们的库」。验收人造样本时必然是「从 Eagle 导出一份再放进我们库」，测出来的是**人造环境的数字**——它只证明「键构造对了」，证明不了「真实 Eagle 用户两边有同一批图」。真实用户若压根没往我们库放过这批图，`file_index` 里就没有左值、命中率恒为 0，而**这份测量测不出这件事**。
→ P1 要拆成两问：① 你想服务哪种用户；② 这类用户「两边有同一批图」的比例是多少、**你怎么知道的**。若答不出 ②，A 只服务一个窄人群，C 才是主流。**这板要排在测量之前拍，否则测了也白测。**

### 12.3 M — 会踩但能救

| # | 问题 |
|---|---|
| **M1** | **字母撞车**：§0.5 的「读取路线 A/B」与 §5 的「迁移路线 A/B/C/D」是两套东西共用一组字母，且 §5-A 与 §6-A 都叫 A。后续 §7/§10 反复出现「A」，必读错。建议迁移路线改叫 R1–R4 或汉字（标注/接管/搬运/素材包） |
| **M2** | **§11 已过时**：它写的两件待办（设计方案 §6.4 两处更正、`mod.rs` 注释补齐）**都已落地**——设计方案已升 v4.16（§6.4 写全了四条冲突事实 + 更正记录有 v4.15→v4.16 表），`mod.rs:8-15` 已把两条 per-source 禁令写全并**明写出处是本文**。§11 应从「待办」改成「已落地台账」，并加一句：改动本文结论时要回头同步 `mod.rs` |
| **M3** | **§3.1 `star` 那行措辞是坏的**：「【代理】称『非整数即字符串』」读不通，且样本里**没有 star**（已重拉原文确认）→ 至今零证据。建议改成「样本未见该键；官方 `/api/item/update` 样例为 `"star": 4`；真实类型待样本确认」 |
| **M4** | **两条孤证**：① §5-C 的「与安卓侧『不留副本换空间』的拍板相反（见 memory）」——在 `memory/` 与 `.workbuddy/memory/` 里**均未检索到该拍板原文**，而它是 C 的否决理由之一 → 补出处或降级；② §6「Changelog 最后一条 2022-11-01」——我拉的 `llms-full.txt` 全文**未见 Changelog 章节**（内容在 Tampermonkey 示例处截断），无法证实亦无法证伪 → 标【一手】过誉 |
| **M5** | **漏了一类条目**：Eagle 条目可 `folders: []`（未分类）。本文通篇按 `folders[]` 挂专题，**没说空数组怎么办**（跳过 / 挂根 / 单列一栏）。会直接影响 `topics_created` 与「未挂靠条目」的报告栏 |
| **M6** | **`file_index.name` 是否含扩展名未确认**。§5-A 的键是 `name`+`ext`，若 scanner 存的 `name` 已带扩展名，拼出来就是 `foo.jpg.jpg`，匹配率直接归零且症状看似「Eagle 格式不对」。建议进 §9 待补清单 |

### 12.4 复核未能覆盖

- 从未取得 **2.x / 3.x 老库**样本（§9-2 仍是空白）。
- §9-5（改显示名是否改实体文件名）无法离线验证——**它决定 A 的命中率，只能等样本**。
- §6 的 Changelog 停更日期（见 M4②）。
- §8 清单中除 `naamiru/eagle-webui` 与 PixCall 插件外，其余参照实现未逐条重拉，按本文置信度标注采信即可。

## 13. 实测记录（v2，2026-10-05，Test.library）

**样本**：`C:\Users\misakimiku\Pictures\AuroraGallery\Test.library`，Eagle 4.0.0（`/api/application/info` 的 `buildVersion = 20260401`，win32），49 个条目（jpg 12 / png 36 / gif 1），`folders` 树为空（未建手动夹）、2 棵智能夹树、`tagsGroups`/`quickAccess` 空。**Eagle 全程开着**。
**方法**：Node 脚本全量聚合 49 个条目 JSON（`%TEMP%\eagle-audit.mjs`）；我们侧 `metadata.db` 以 `mode=ro` 只读查 `file_index`；`curl` 裸调官方 API。本节全部结论 **【实测】**，与 v1 冲突处**以本节为准**；样本补齐后脚本可复跑。

**目录来历（验收人口述，防误读）**：`Pictures\AuroraGallery\test` 是验收人**一开始为建 Eagle 库准备的普通文件夹**（当时以为选定文件夹就能建库，后来才知道要把文件拖进 Eagle 才触发建库）——它**不是 Eagle 库资源**，也尚未被我们应用重扫。应用的 `file_index` 停留在「这些图还在 `AuroraGallery\` 根」的时期（36 行全部指向根，0 行在 `test/` 下）。

### 13.1 §9 待补清单清账

| §9 | 结果 |
|---|---|
| 1 本机实测 | ✅ 本节 |
| 2 2.x/3.x 差异 | ⏳ 仍未知（样本 4.0.0） |
| 3 可选根文件 | `tags.json` ✓ 在（`historyTags` 6 词含中文 + `starredTags`）；`saved-filters.json` ✓ 在（`[]`）；`backup/` ✓ 在（`backup-*.json`）；`actions.json` 本库无（未用过批处理，仍属可选） |
| 4 智能夹枚举 | ◐ 新增两个实测对：`(type, equal, value=扩展名串"jpg")`、`(name, contain, value=子串)`；全量枚举仍待补 |
| 5 改名是否改文件名 | ◐ 49/49 精确 `<name>.<ext>`，库内无改名样本 → 仍无结论（在 Eagle 里改一次名即可复跑验证） |
| 6 CSV 导出 | 未测（需手动操作） |
| 7 deletedTime | ⏳ 0 个软删条目（`isDeleted` 全 false），仍未验证 |
| 8 Eagle 运行时直读 | ✅ **Eagle 开着时**：直读全部 JSON 成功（无锁；根 `metadata.json` 在会话期间被 Eagle 写过，并发读无碍）、同时 curl 三个 API 端点成功、**全部无鉴权** |
| 9 云占位文件 | 本地盘 N/A |

### 13.2 结构与字段（§2/§3 的实测与更正）

- 根文件清点与 §2 结构图一致：`metadata.json / mtime.json / tags.json / saved-filters.json / backup/`；无 `actions.json`、无 `recyclebin/`。
- `mtime.json`：`"all":49` 与 49 个 `.info` 目录完全对齐（本次未观察到落后；「条目集合以 readdir 为准」守则保留）。
- 条目级：**49/49 键集逐条目完全一致**（17 键：`id/name/size/btime/mtime/ext/tags/folders/isDeleted/url/annotation/modificationTime/height/width/lastModified/palettes` + 2 条有 `noThumbnail`），类型全部与 §3.1 吻合；`tags` 全字符串；`palettes` 49/49 存在但**仅 4 条带 `$$hashKey`**（Angular 残留是可选的，别假设必有）；id 全部 13 位 `[A-Z0-9]` 且**目录名 == `id`（49/49）**。
- 智能夹节点实测补充（§3.2 没记的）：子节点带 `parent` 回指；带 `depth/size/vstype/guidelines/styles/isVisible/index/isExpand` 等 UI 状态键（解析一律忽略）；`$$hashKey` 在 `conditions.rules` 里也出现；父夹 `conditions` 可为 `[]`；**`imageCount` 直接落在子智能夹节点上**（`HEA: 4` 与按条件实算一致）→ 计数断言可离线做，但**父节点没有 `imageCount`**，断言以自算成员为准、`imageCount` 只当旁证。
- ★ **更正 §3.1：`btime` 不是「加入库的时间」**。49 条全部同批导入（`modificationTime` 全等于导入时刻 2026-10-05 18:30），而 `btime` 分布 2022-05-25 ~ 2026-09-27、与 `modificationTime` 重合 0 条 → **`btime` = 源文件的文件系统创建时间（birth time）、`mtime` = 源文件修改时间，都是导入时从文件带过来的；`modificationTime` 才是入库时刻**。对迁移无影响（本就不迁这两列），但别再拿 `btime` 当「加入时间」用。
- 验收人观察：直接拖文件/文件夹进 Eagle **不会创建普通夹**（本库 `folders` 树为空、49/49 条目 `folders:[]`）→ 「未分类」是 Eagle 的**主流真实形态**，M5 的「空 `folders[]` 怎么办」要按主流 case 设计，不是边缘 case。

### 13.3 ★ 匹配率测量（§10 首轮数字）

| 项 | 数 |
|---|---|
| Eagle 条目 | 49（全非软删） |
| 我们 `file_index` | 36 行（35 Image + 1 Folder），全部指向 `AuroraGallery\` 根；实体文件现已在 `test/`、`test/CDPR/`、`test/wuwa/`（见本节开头「目录来历」）→ **索引整体陈旧** |
| 按**现状索引** | 唯一命中 34 / 多义 0 / 不命中 15（69.4%） |
| 15 个不命中的归因 | **全部**是索引陈旧：6 个在 `test/` 根、9 个在 `test/wuwa/`；49/49 在盘上找到实体，且 **size 与 Eagle `size` 49/49 一致** |
| 按**现势磁盘**重算 | **49/49 唯一命中（100%），0 多义** |
| 34 个命中的复核 | size 与宽高 **0 矛盾** → `name+ext` 主键 + size/宽高复核的键构造**零误报** |
| 反向覆盖 | 索引 35 张图里 34 张被 Eagle 引用；唯一没被引用的 `desktop_test_1.jpg` 是「我们有、Eagle 没导入」 |

- **M6 落定**：`file_index.name` **含扩展名**（`name` == 文件名；`path` 正斜杠）→ Eagle 侧 join 键 = `${name}.${ext}`（建议小写化），`foo.jpg.jpg` 风险不存在。
- 结论：键构造成立且在本样本零误报——只要「同一批图两边都有」（无论目录形态怎么变），`name+ext` + size/宽高 就能认亲。真实瓶颈回到 H3 第二问：**用户的这批图在不在我们库里**，不是键。
- ⚠️ 顺带发现：文件挪位后我们侧不自动重扫，陈旧索引会直接吃掉命中率 → Eagle 导入流程要在入口提示「先重扫 / 确认索引新鲜」。

### 13.4 官方 API 实测（§1/§6 更新）

- `library/info`、`library/history`、`application/info` 三个端点**裸 curl 成功，无鉴权、无 token**（Settings 里的 `developer.apiToken` 实测**非必需**）。
- `/api/library/info` 的 `data` 里带 **`library.path` + `library.name`**（§1/§6 未记）→ 库根交叉校验直接用它，比从 thumbnail 路径反推干净。
- `Settings` 实测：`libraryHistory` ✓；另有 **`rootDir`** 键（当前库路径）→ §1 的发现顺序可把它加进去。
- `application/info`：`version 4.0.0`、`buildVersion 20260401`、`platform win32`。

### 13.5 代码侧核对（H1/M2 复核 + import_records）

- **H1 属实**：`OurIndex`（`core/src/import/mod.rs:141-193`）只有 path 双索引，`load()` 只 `SELECT file_id, path, file_type`，`find()` 只按 path → Eagle 期匹配层要新造（`name+ext` 索引；load 带 name/size/width/height）。
- **M2 属实**：`mod.rs:8-15` 两条 per-source 禁令已落地且引用本文。
- 本机**已安装版**的 `metadata.db` 里**还没有 `import_records` 表**（旧构建）；建表在 `core/src/db/mod.rs:168`、随应用启动迁移执行，当前代码会补上 → §7「无需改 schema」仍成立（指代码侧）。

### 13.6 样本缺口（请验收人在 Eagle 里补，完成后复跑脚本）

本库还盖不住 §9 样本清单的：① 嵌套两层普通夹 + 夹描述（⑩）；② 的 `tags`/`color` 两种 property；③ 一个标签组（`tagsGroups`）；④ 的**评分**（star；标签/备注/链接已覆盖）；⑤ 一条同时属两夹；⑥ 密码夹；⑦ 图上矩形标注（`comments`）；⑧ 回收站条目（`deletedTime`/`isDeleted`）；⑨ 视频/字体。另：一个**网页书签**（无实体文件条目，§8.3）、在 Eagle 里**改一次显示名**（验 13.1-5）。

### 13.7 拍板记录（2026-10-05，验收人拍板）

| # | 决定 |
|---|---|
| **P1** | **A+C 两档**：A（只挂标注）为本期主切片；C（连文件接管，同盘符硬链接/move 优先、免空间翻倍）作为显式 opt-in 第二档，单独切片后续做 |
| **P2** | **b：断言通过才固化**。只实现已标定的 `property`+`method`（今天实测：`type=equal`、`name=contain`），自算成员数与 Eagle 侧 `imageCount` 精确一致才固化成快照专题；断言不过或含未标定键 → 跳过+上报。实测补充三条标定事实：`contain` 是**大小写不敏感**（条件值 "HEAD" 命中 `head1(1)` 等小写名、`imageCount=4`）；条件值为**空串按「不命中 any」处理**（OCR 夹 `value:""` 且 `imageCount:0`）；子智能夹**按独立条件求值**、断言不过即跳过（本样本父子条件不可分辨——两解都=4，按严的来） |
| **P3** | 标签组 `tagsGroups`：**丢弃+上报**（PixCall 先例） |
| **P4** | 图上矩形标注 `comments[]`：**丢弃+上报**（PixCall 官方插件同样丢） |
| **P5** | 评分 `star`：**不迁**（我们无评分功能，同 PixCall 期） |
| **P6** | 读取路径：**直读磁盘为主**；Eagle 开着时可选做 API 交叉校验（实测无鉴权、成本为零） |
| **H2** | 报告**加新栏** `unmatched_items`（Eagle 填条目名），`unmatched_paths` 保留给 PixCall；新增字段带 serde default，旧 `report_json` 反序列化不受影响 |
| 范围 | **桌面单端**：不做移动端（与 §11.4 口径一致，三端功能矩阵不登记） |

## 更正记录

| 版本 | 内容 |
|---|---|
| v1（2026-09-30） | 首版。无本机实测，全部结论带来源与置信度，见页首「方法诚实声明」 |
| v1.1（2026-10-01） | 可行性复核：新增 §12。重拉外部原文 + 核对本地 schema，确认 D1/§3.1/§6/§8/D2 站得住；**新增三条硬伤 H1–H3（匹配层须重写、`unmatched_paths` 语义空缺、§10 测量证明不了 A）**；六条中等风险 M1–M6（含 A/B 字母撞车、§11 已过时、`star` 措辞、两条孤证、空 `folders[]` 未定义、`name` 是否含扩展名） |
| v1.2（2026-10-01） | 社区做法调研：新增 §8.1–8.5。按「解决什么问题」重分四类，补 6 个本文漏掉的项目；**§8.2 回答两个硬问题**：多归属落物理树只有三种粗糙解（复制多份/只放一处/不落树）→ 反倒证明 A/B 更对；「空间翻倍」非必然（同盘符硬链接、move、符号链接、官方导出）→ **修正 §5-C 的代价描述**；§8.3 补两类漏掉的条目（Bookmark 无实体文件、未分类条目）；§8.4 三条可直抄的解析策略（按内容分类 JSON、资产三级回退、ZIP 不整体解压）；§8.5 新增假线索（SQLite 说法） |
| v2（2026-10-05） | **本机实测**（Eagle 4.0.0 build20260401 + `Test.library` 49 条目，全程开着 Eagle）：新增 §13。§9 清单落定 5 项；**更正 §3.1 `btime` 语义**（是文件系统创建时间，非「加入库的时间」）；**M6 落定**（`file_index.name` 含扩展名 → join 键 `${name}.${ext}`）；H1/M2 复核属实；API 无鉴权实测 + 新发现 `/api/library/info` 带 `library.path`、Settings 带 `rootDir`；智能夹 `imageCount` 落磁盘子节点 + 条件枚举新增 2 个实测对；**匹配率首轮：键构造零误报，按现势磁盘 49/49 唯一命中**（按陈旧索引 69.4%，15 个不命中全部归因索引陈旧）；样本缺口清单见 §13.6 |
| v2.1（2026-10-05） | **A 档实现落地**（桌面单端，按 §13.7 拍板）：`core/src/import/eagle.rs`（发现→解码→分类→匹配→计划）+ 匹配层 `by_name_ext`（H1）+ 报告新栏 `unmatched_items`（H2，serde default 兼容旧记录）+ `eagle_*` 五命令 + 设置-存储 Eagle 卡（v4.13 整宽同构，报告视图复用 PixcallReportView 薄包装）+ i18n zh/en；`file_types.rs` 补 `mime_for_extension`（仓内本无现成 ext→mime 映射）。**真实库 smoke：matched 49 / unmatched 0；HEA 断言过固化 4 成员、TESTV2/「阿萨的」无 imageCount 跳过、OCR 空串过断言不落空专题**。门禁：cargo test 178✓（pixcall 81 例未破）、`npm run build` ✓、vitest 本次改动相关全绿；vitest 仅有的两个失败文件均为既有环境问题（colorUtils 的 `localStorage.clear` 缺陷、groupedTags 触发 cargo 链接撞 Y 盘 LNK1104 文件锁——本地 `CARGO_TARGET_DIR` 重跑 9/9 过，均与本工作无关）。**C 档（连文件接管）未实现，留作独立切片** |
| v2.2（2026-10-06） | **Welcome 接入 Eagle 来源**（§10 ④ 的「welcome 那颗另议」落定）：WelcomeModal 第 1 步按发现结果显示来源按钮——step 1 挂载时并发 `pixcallDiscover(null)`+`eagleDiscover(null)`，各有库才渲染各自按钮、发现中都不渲染、都空则只剩「选择文件夹」（与设置页「发现不到整块不渲染」同口径，修掉「无条件渲染、点了才报错」的反模式）；新增 `WelcomeEagleCard`（镜像 PixcallCard 的接管链：切根→扫描→probe→import，复用来源无关的 `openKnownPath`）；i18n 仅新增 `welcome.useEagleLibrary`（其余全走既有 `eagle.*` 镜像键）；welcome 测试 20→25 例全绿、`npm run build` ✓。**⚠️ 这条里的「切根接管」在 v2.4 被撤销——它实现的是 §5 明确否决的路线 B** |
| v2.3（2026-10-06） | **产品定位拍板（P7）**：我们与 Eagle / PixCall 是同赛道的竞品，不是附属；迁移功能 = 让用户搬过来的成本最低。由此 **路线重排：C（连文件接管）升主航道、A 退化为 C 流程内的一步、B 出局**——判断标准是「搬完之后用户的图库能不能独立存在」。详见方案讨论稿 §0.5 |
| v2.7（2026-10-06，本文最新） | **重跑不再造重复专题**：专题查重键是 `(父级, name)`，父级一变就查不到，`new_topic_id` 又会铸一个新 id —— 于是「改版后重跑」会把同一枚源节点变成两枚专题（实测场景：早先的映射把 `HEA` 建在根上，修好层级后重跑，`HEA` 本该被挪到 `TESTV2` 下面）。新增 `find_topic_by_import_seed`（把 `new_topic_id` 的 `md5(seed\|salt)` 候选 id 0..64 全算一遍去查表，认出同一枚专题）+ `TopicCreate.reparent_existing`：**只认领「当前挂在根上、这次有父级」的那些**（有父级的一律不动，可能是用户自己整理的），落库时把父级改过去；报告计入 `topics_reparented` 并出提示。新增单测复刻「上次导入的残留 → 重跑认领」，cargo test 187→188 |
| v2.6（2026-10-06） | **智能夹成员与描述修正**（验收人重录库：`TESTV2` 有 12 个成员 + 描述、`HEA` 4 个成员 + 描述；副本在 `Z:\AuroraGallery\Test.library`）：**更正 §13.2「父节点没有 imageCount → 只能跳过」**——断言做不了 ≠ 数据不可信。① **无 `imageCount` 但条件全部标定** → 按条件自算成员照常落库（`TESTV2` = `type equal jpg` → 12 条），只是**不计入 `topics_materialized`**（那条计数与「新落入条件的文件不会自动加入」的说明只给断言过的夹），报告里明确写「未断言」；② **`conditions: []` 一律跳过**——我们求值器里「没有组」等于命中一切，而 Eagle 侧空条件语义不明（实测库「阿萨的」就是这个形态），按命中一切落库会造出一枚含全部 49 条的专题；③ **描述链路复核为通**：智能夹 `description` → `topics.description`（新建时写入、同名合并时空着才补；`HEA` 的 `"测试用的子专题\n"` 会 trim）。真实库 smoke 输出见本节末 | 
| v2.5（2026-10-06） | **智能夹层级两处修正**（.174 实机验收反馈）：① **被跳过的祖先要保留成层级容器**——实测库 `TESTV2` 无 `imageCount`（断言做不了 → 跳过），它的子智能夹 `HEA` 断言过；老逻辑沿链找「最近的已迁祖先」找不到就挂根，HEA 变成顶层专题。现在改成两趟：先给每个节点求值，再看哪些被跳过的节点**有后代要挂**，给它们建一枚**只承载层级、不带成员的容器专题**（成员不猜——父夹条件本来就断言不了，抄子夹成员等于报一组没验过的数），且容器**不计入 `topics_materialized`**；② **专题深度压到两级**——我们侧专题只有主/子两级，源树三级及更深一律挂到那一支的一级祖先下面（`clamped_parent`），手动夹与智能夹同一条规则。新增/改写 3 条单测（容器承载、TESTV2/HEA 实测形态、三层压平），cargo test 184→186 |
| v2.4（2026-10-06） | **C 档实现 + B 档误实现的撤销**：① 撤销 v2.2 的「切根→扫描」——`WelcomeEagleCard` 与 `EagleImportSection` 都不再收 `onSwitchRoot`，资源根永远由用户自己选，Eagle 只往 `<资源根>/<库名>/` 里添文件；② `core/src/import/eagle.rs` 新增 `plan_takeover` / `takeover_preview` / `execute_takeover` / `index_takeover`，`Item` 加 `entity_path`（三级回退改为**定位文件本身**）；③ 搬运语义 = **硬链接优先、失败按条降级复制、绝不 move**（库只读）；④ `MigrationReport` 加搬运栏（serde default），`has_anththing_to_migrate` 认「搬了文件但没标注」；⑤ 命令签名扩为 `eagle_probe/import(sourceRoot, targetRoot?, preferLink?)`，probe 返回 `{report, takeover}`；⑥ 新增 5 条 C 档单测（只搬实体不搬缩略图 / 认亲命中不搬 / 夹树镜像+撞名消歧 / 拒绝往库里写 / 重跑幂等），cargo test 178→183。**实测过的事实（B 档的代价，供后人别再走回去）**：49 条目 → 网格 49 个 `<ID>.info` 文件夹、每格两张图，一张原图 3 张缩略图（Eagle 自存的 `_thumbnail.png` + 我们为实体生成的 + 我们为那张缩略图又生成的） |

## 来源清单

- 真实库样本（逐字读过）：[naamiru/eagle-webui/docs/sample-library](https://github.com/naamiru/eagle-webui/tree/main/docs/sample-library) 的 `metadata.json` / `mtime.json` / `images/MGMYDH18YSIS1.info/metadata.json`
- 代码判据（逐行读过）：[ghostzero/eagle-cli/src/library.rs](https://github.com/ghostzero/eagle-cli/blob/main/src/library.rs)、[onmokoworks/Eagle-viewer/server/platform.ts](https://github.com/onmokoworks/Eagle-viewer/blob/main/server/platform.ts)、[pampas9000/debris](https://github.com/pampas9000/debris) 的 `model/eagle/*.go` 与 `pkg/eagle_id_generator.go`
- 官方 API 文档：[Overview（端口 41595 / 版本要求）](https://api.eagle.cool/master.md)、[/api/library/history](https://api.eagle.cool/library/history.md)、[/api/item/list](https://api.eagle.cool/item/list.md)、[/api/item/info](https://api.eagle.cool/item/info.md)、[/api/item/thumbnail](https://api.eagle.cool/item/thumbnail.md)、[/api/folder/list](https://api.eagle.cool/folder/list.md)、[/api/library/info（智能夹规则样例）](https://api.eagle.cool/library/info.md)、[/api/item/update](https://api.eagle.cool/item/update.md)、[Changelog](https://api.eagle.cool/changelog.md)、[全文 llms-full.txt](https://api.eagle.cool/llms-full.txt)
- 官方插件 API：[item](https://developer.eagle.cool/plugin-api/api/item.md)、[library](https://developer.eagle.cool/plugin-api/api/library.md)、[folder](https://developer.eagle.cool/plugin-api/api/folder.md)、[smartFolder](https://developer.eagle.cool/plugin-api/api/smart-folder.md)、[tagGroup](https://developer.eagle.cool/plugin-api/api/tag-group.md)
- Eagle 帮助中心：[导入是复制而非索引](https://cn.eagle.cool/support/article/does-eagle-import-files-by-copying-or-indexing)、[资源库 7 个必用技巧（备份/勿改库内文件）](https://cn.eagle.cool/blog/post/best-practice-for-eagle-library)、[导入／导出素材包 eaglepack](https://cn.eagle.cool/support/article/import-exporting-eaglepacks)、[一键导出全部内容](https://cn.eagle.cool/support/article/how-to-export-all-content-from-eagle-library-with-one-click)、[查看资源库存储位置](https://cn.eagle.cool/support/article/how-to-check-the-file-path-of-your-library-or-images)、[迁移到新设备](https://cn.eagle.cool/support/article/how-to-migrate-your-library-to-a-new-computer)、[导入既有资源库](https://cn.eagle.cool/support/article/import-existing-library)、[合并资源库](https://cn.eagle.cool/support/article/merge-libraries)
- 同类实现：[PixCall 官方 Eagle 导入插件](https://docs.pixcall.com/docs/plugin/plugin-eagle-importer/)、[PixCall 桌面端导入 Eagle/Pixcall 资源库](https://docs.pixcall.com/docs/desktop-client/import/)、[飞牛 Seek 导入 Eagle](https://help.fnnas.com/zh-CN/articles/v1/seek/seek-import-eaglepack)
- 其他社区：[Stef4678/eaglepack-importer/docs/FORMAT.md](https://github.com/Stef4678/eaglepack-importer/blob/main/docs/FORMAT.md)、[progressions/eagle-browse/docs/SMART_FOLDERS.md](https://github.com/progressions/eagle-browse/blob/main/docs/SMART_FOLDERS.md)、[V2EX 换电脑丢库](https://www.v2ex.com/t/546553)、[r/EagleCool：Eagle 复制每个导入的文件](https://www.reddit.com/r/EagleCool/comments/1fvvy0u/)
