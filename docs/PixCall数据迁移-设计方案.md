# PixCall 库数据迁移 — 设计方案

> 版本： v4.10（2026-09-29 收尾：**首跑环境实测命中**，§9 的两套预期（并用机器 / 空库首跑）至此全部验完，welcome 那条接管链也在真应用里跑通了；§9 末段一处 v4.9 改名漏网的 `topics_skipped_name` 已跟着改成 `topics_merged_name`。验收人清场重验的做法与「哪几处数据必须一起清」记进 §10 待办段）
>
> v4.9（2026-09-29 验收人两条拍板落地：**① 删父专题级联删子专题**（收到 `core/src/db/topics.rs::delete_topic`，安卓在 ViewModel 里手工补的那层现在成兜底）；**② 同名看板从「不新建也不合并成员」改为「不新建、成员并进去」**（§4 表与 §4.6 规则 4 改写，报告栏 `topics_skipped_name` → `topics_merged_name`，新增 `topics_covered`）。提交 `9ff57428c`）
>
> v4.8（2026-09-29 实库首跑后补两处：§10 偏差 9——**导入出来的专题要自己补封面**（桌面那条「归入成员时取首图当封面」的规则在前端 `useTopics.ts:89-98`，导入器直接落库会绕过它，提交 `00c1cc2bb`）；偏差 10——上报文案是纯文本渲染，不许带 markdown 星号（提交 `63cd70566`））
> 状态： **v1 迁移已实现并两条路径全部实测通过**（双软并用 21:07 / 空库首跑 22:10，§9 两套预期逐栏命中）。解码/断言/层级/并集/级联/合并全部有单测覆盖（core 136 条 Rust + 前端 85 条，含 welcome 4 条）。唯一没验的是 §4.6 规则 10 那条 1457 成员专题的网格滚动性能——需要人眼在真库里点进去看
> 范围拍板（2026-09-29 与验收人对齐，v4 扩充）：v1 只迁 **标签 + 描述 + 来源链接 + 手动合集**；评分、文件夹固定封面、近重复检测三项不进本期（§5）
> §8 的 scanner 豁免移除已落地，`cargo check` 与运行时验证均通过
> v4 的全部实测数字复核于 2026-09-29 18:00 前后（PixCall 未运行、Aurora 在运行），复核脚本与中间结果在会话临时目录，未入库
> v4.7 的复测于 2026-09-29 20:20 前后（同一台机器、同一份源库快照），实现落账见 §10

## 1. Pixcall 把数据放在哪

三层落点，全部实测确认：

| 位置 | 内容 |
|---|---|
| `%APPDATA%\Pixcall\config.json` | **库注册表**：`libraries: string[]`（各库绝对路径）、`library_path`（当前库）、`preferences`（含 `ignore_rules`、`max` AI 配置、`cell_info`） |
| `<root>\.pixcall\` | 每库一份：`database\*.db`（**7 个** SQLite，WAL 模式）、`config.json`、`keystore` + `keystore.backup`（云同步密钥，二进制非明文）、`<uuid>.id`（库 UUID，空文件）、`trash\`（回收站实文件） |
| `%LOCALAPPDATA%\Pixcall\db_data\<uuid>\{backup,index}`、`db_cache\<uuid>\live_view.redb` | 按库 UUID 分开的派生索引缓存 |

本机现状：`libraries` 有两条（`D:\资源`、`C:\Users\Misaki\Videos\NVIDIA`），但 `D:\资源` 下**没有** `.pixcall`（注册了没建库），所以机器上只有一个 Pixcall 库可参照。**发现逻辑必须过滤掉没有 `.pixcall` 的注册项**（§6.4）。

`database\` 七个库的分工（v3 写「8 个」是数错了，实际 7 个）：

| 文件 | 主要表 | 对本次迁移 |
|---|---|---|
| `main.db` | `entries`（虚拟文件树）、`folders`、`tags`、`tag_groups`、`boards`、`board_entries`、`recent_entries`、`exif`、`media`、`captions`、`kvs`、**`remote_events`**（v3 漏列，0 行，云同步事件） | **标注层主体，唯一必读** |
| `thumbs.db` | `thumbnails`（webp blob） | 跳过（§5） |
| `sim_hash.db` | `image_hashes`（phash + 8 向投影）、`file_hashes`、`duplicates`、`non_duplicates`、`kvs` | 跳过（§5） |
| `max.db` | `text_embeddings`、`completions`、`settings` | 跳过（§5） |
| `tasks.db` / `blocks.db` / `hashtree.db` | 后台任务队列 / 云同步分块与 Merkle 树 | 无用户数据，不读 |

`main.db` 里两张 v3 没解释的表，v4 补上：`media`（53 行）是 ffprobe 级**视频**元数据（`duration` / `bit_rate` / `streams` / `creation_time` / 宽高），53 正好等于本机 mp4 数，我们不索引视频故不读（§5）；`remote_events`（0 行）是云同步事件，不读（§5）。

## 2. 实测结论（每条都可复核）

### 结构与标识

**① 库里不存绝对路径。** 文件位置靠 `parent_id` 链从虚拟根（`id=1, name='Pixcall'`；另有 `id=2, name='Trash'`，均 `parent_id=-1`）逐级拼 `name` 得到相对路径，再拼上「`.pixcall` 所在目录」。`%APPDATA%\Pixcall\config.json` 的 `libraries[]` 是根路径的权威来源，作交叉校验。
（v3 在此写过「`entries.source_path` 与 `link` 在 5403 条文件记录里全为 NULL」，**两半都不成立**，v4 更正：`source_path` 有 1 条非空、`link` 有 5 条非空且全是文件。结论「不存绝对路径」仍对——那条 `source_path` 的值是文件夹名 `Zenless Zone Zero` 而非路径，它是回收站项的「原所在夹」记录，见⑫；`link` 是来源链接，是**要迁的用户数据**，见 §4。）

**② 路径重建已验证。** 递归 CTE 重算 5429 条非根条目（5403 文件 + 26 夹），磁盘存在性检查 **5428/5429，缺 1**。（v3 写「5403/5403，0 缺失」已过期。）缺的那条是回收站项（⑫），**排除 Trash 子树后为 0 缺失**。

**③ `content_hash` 不是文件的 SHA-256。** 5403 条中 5401 个唯一值；v4 抽 3 个文件复算，`sha256` 与 `md5` **均不匹配**，`size` 与磁盘一致。它是 Pixcall 自己那套（疑似归一化后）的内容指纹，**我们无法复算**，只能当库内部不透明键——例如 `thumbnails.key` 的 `thumb/` 命名空间等于 `'thumb/' || entries.content_hash`（5402 行里 5400 行命中；另 2 行是 `icon/<content_type>` 命名空间，v3 漏提，反正不迁）。

**④ 它是云同步相册。** `keystore` + `blocks.db` + `hashtree.db` + `kvs['config.hosts']`（指向 `api.pixcall.com`）+ `entries.status` 同步态位，意味着 `entries` 里可能存在「只在云上、本地无文件」的项。我们自建 `file_index` 走扫盘，天然只含本地真实文件，此项免疫。

**⑤ 源库是活的，会在我们读的时候被写。** 第一轮调研的十几分钟内 `thumbnails` 从 1171 涨到 5402（Pixcall 刚扫完库）。**读侧必须按「对方在线」设计（§6.2），且 probe 与 import 必须共用同一份快照（§6.2 末）**。

**⑥ 所有 id 是 64 位，超出 JS 安全整数范围。** `entries.id` / `tags.id` / `boards.id` 形如 `646087413270029312`，经 `JSON.parse` 会变成 `646087413270029300`。**解码必须在 Rust 侧完成，任何环节都不许把这些 id 过一遍 JSON**（Tauri 命令返回值走 serde→JSON→webview 的 `JSON.parse`，同样会丢精度）。检查/预览命令返回给前端时要么用 `cast(... as text)`，要么干脆只返回计数与路径。

### 标注层编码（第二轮实测，验收人在 Pixcall 里造标注后回填）

第二轮快照：`entries` 5431（28 夹 + 5403 文件）、`tags` **10**、`board_entries` **4**、`boards` **2**、`entries.tags` 非空 **8** 行、`entries.description` 非空 **10** 行；`tag_groups` / `captions` / `exif` / `recent_entries` 仍为 0，`rating` / `is_private` / `is_deleted` / `is_hidden` 仍全 0。`kvs['schema_version'] = 22`。

**⑦ `entries.tags` 存的是竖线分隔的 tag id，不是标签名。** 实测原值形如 `'646086142005847040|646086152915231744'`。**不是 JSON 数组、也不是逗号串**。解码链路：`split('|')` → 逐个查 `tags.id` → 取 `tags.name`。实测 8 行全部解码成功、10 个词表标签全部被命中。标签名里出现过 `·`（间隔号）、`：`（全角冒号）、纯 ASCII（`CEP` / `TP9`）三类，我们 `core/src/db/tags.rs:39` 的 `normalize()` 只做 trim + 去重，这些字符原样保留，不需要额外清洗。

**⑧ `tags.category` 就是拼音首字母，`tags.pinyin` 是音节驼峰拼接——两者我们都自己算，可无损丢弃。** 实测 `舒恩→S / 米希丽丝→M / CEP→C（pinyin 为空）/ 里昂·S·肯尼迪→LiAng-S-KenNiDi (category=L)`；`pinyin` 仅 8/10 非空，两个 ASCII 词的 `pinyin` 是空串而 `category` 仍为首字母。我们的侧栏分组走 `src/utils/textUtils.ts:1-42` 的 `getPinyinGroup`（23 条拼音首字边界 + `Intl.Collator('zh-Hans-CN', {sensitivity:'accent'})`），算的是同一件事，实测 10/10 一致。→ **`category` / `pinyin` 一律不迁。** `tag_groups`（用户自定义分组，`tags.group_id` 亦全空）本机仍 0 行，遇到时按「丢弃 + 上报」处理。

**⑨ `description` 尾部带换行，导入必须 trim。** 10 条实测：5 条文件夹备注**全部**以 `\n` 结尾，图片备注 5 条里 2 条带（`TP9带后托\n`、`里昂与艾什莉\n`），3 条不带（`卡缪` ×3）。不 trim 会把空行带进我们的描述框。

**⑩ `entries.description` 也挂在文件夹上（13 条标注里 5 条是文件夹）。** 具体是 `Wuthering Waves`、`Arknights  Endfield`、`Browndust2`、`HTGame`、`NTE (Neverness To Everness)` 五个文件夹。展示位本来就有：`src/components/metadata/EditSection.tsx:41` 的 `!== FileType.FOLDER` 只挡 Tags Section，Description Section 在 `:96` 只有 `{!isMulti && (`，无类型门禁；验收人已在我们应用里给 4 个文件夹写了备注并成功落 `file_metadata`（v4 复核：库里确有 4 个 Folder 行带 description，正是 `Games` / `Resident Evil 4   Biohazard 4` / `Apex Legends` / `NTE (Neverness To Everness)`）。→ 零 UI 成本直接迁（§4.4）。

**⑪ 手动合集与智能合集的判据干净且有两个信号。** 实测：「阿松大」`filters='{}'` + `board_entries` 4 条 + `file_count=4`（手动）；「test」`filters='{"size":[{"should":"extra_small"}]}'` + `board_entries` 0 条 + `file_count=1457`（智能）。即 **手动 = `filters` 为 `'{}'` 且 `board_entries` 有行**；智能 = `filters` 非空、成员不落表、`file_count` 是查询算出来的缓存。两个信号一致，实现时同时校验，任一不符就按智能处理并上报。

**⑫ 回收站判据是 `parent_id = 2`，不是 `is_deleted`（v4 新定，关闭 v3 §7 的样本缺口）。** 实测唯一缺盘条目 `Zenless Zone Zero 2026.07.13 - 23.38.12.01.mp4`：`parent_id=2`（Trash 根）、文件实文件躺在 `.pixcall\trash\` 里、`source_path='Zenless Zone Zero'`（删前所在夹）、而 **`is_deleted` 仍为 0**。三个推论：
1. 「不迁已删项」的规则写成 **排除 `parent_id=2` 子树**，不要看 `is_deleted`。
2. **路径重建必须显式排除 Trash 子树**（或给它加不可能冲突的前缀）。否则 Trash 条目会拼出一个**根级相对路径**（实测该 mp4 重建出来就是光秃秃的文件名，无 `Trash/` 前缀），与真实根目录下的同名文件共用命名空间，可能假命中。
3. `source_path` 的唯一非空值由此得到解释，①的更正成立。

**⑬ `entries.metadata` 里没有藏着要迁的用户数据（v4 逐行解 JSON 确认）。** 5403 行全非空，键集为 `color_palette / creation / modification / orientation / image_width / image_height / thumb_hash / has_thumb / custom_thumb`（视频多一个 `duration`）。其中 `custom_thumb` **5402 条全为 false**（1 条无此键）——「文件级自定义缩略图」这个机制本机零使用，无数据损失；`color_palette` 是逗号分隔的打包整数，**不用迁**，因为我们的 `colors.db` 已为 5348 个文件算好主色（`dominant_colors` 5348 行 + `image_color_indices` 42784 行 Lab），格式也不同构；`creation` / `modification` 是 EXIF 级时间，我们 `file_index` 用文件系统时间，本期不迁。

**⑭ 智能合集的 `size` 筛选语义已复算验证，可以用计数断言固化成员（v4.2 新增）。** `'test'` 的 `filters='{"size":[{"should":"extra_small"}]}'`、`file_count=1457`。对 5402 条非回收站文件按字节大小复算：`count(size < 1048576) = 1457`，**与 `file_count` 精确相等**；能产出 1457 的阈值窗口是 (1048441, 1049387] 字节，**1 MiB 是窗口内唯一的整数边界** → `extra_small` = 文件 < 1 MiB。像素维度完全对不上（min 边 <1600 会给 5396），排除。这 1457 条**全是图片、0 条视频**，且 **1457/1457 都在我们 `file_index` 里** → 可完整固化为专题成员。其余桶（small/medium/large/extra_large）本机无样本、未标定，靠 §4.6 规则 7 的计数断言与规则 8 的「只实现标定键」兜底。

## 3. 可行性关键测量：路径映射命中率

**库级（第一轮）**：拿 Pixcall 重建的 5403 条路径与我们 `.aurora/metadata.db` 的 `file_index` 做集合比对：精确命中 5347/5347（100%）、仅大小写差异 0、未命中 56（pixcall 有我们没有）、反向缺失 0。56 条未命中已全部归因，**不是映射缺陷**：53 条 `.mp4`（我们 `is_supported_image` 不收视频），3 条 mtime 晚于我们上次扫描的新图（重扫即收录）。

**标注级（第二轮，v4 复算仍 13/13）**：13 条带标注的条目（8 图 + 5 夹，部分重叠），重建路径后查 `file_index`：**命中 13/13，未命中 0**。

**合集成员级（v4 新测）**：「阿松大」的 4 个 `board_entries` 成员重建路径后查 `file_index`：**4/4 全中**（含 `Arknights Endfield/...2026.09.09...` 与根级三张图）。v3 只测了标注没测合集成员。

**现成的合并用例**：`72C24C5F65D85C96C03CD08BA24D4A30.png` 与 `4A0DBAD8EEE396B3B3E5BB040DD49B46.png` 两张图，**我们侧已有标签**（`["test2","王权"]` / `["test2","DND","胜利女神"]`），Pixcall 侧分别是 `极乐净土 / CEP` 与 `舒恩 / 米希丽丝`；更强的第三张 `HSGb-FbbUAM6OSM.jpg` 我们侧 `["test2","枪","武器","gun"]`、Pixcall 侧 `科幻枪械 / 设计稿`。`明日方舟：终末地` 这个词**两边都有**（我们挂在 `Endfield/Endfield Screenshot 2026.02.10 - 04.29.35.87.png`，Pixcall 挂在 3 张 `Arknights  Endfield Screenshot 2026.02.15*`），正好验词表并集不产生重复词。

**现成的「不覆盖已有内容」用例（v4 新列）**：`NTE (Neverness To Everness)` 这个夹子，Pixcall 侧备注 `异环游戏内的截图\n`，我们侧已有一段非空备注 → 按「仅为空时填」规则**必被跳过**。验收时「Pixcall 有 5 条夹子备注、实际写进 4 条」是**正确行为**，报告里必须有「跳过 N 条（目标已有内容）」这一栏才不会看起来像丢数据（§4.7）。

**现成的「来源链接」用例（v4 新列）**：Pixcall 侧 5 条 `entries.link`（3 条 `x.com/SenseiRover`、1 条 `x.com/CyberKanjousen`、1 条误存的 `x.com/home`），5/5 精确命中我们 `file_index`，且我们这 5 行的 `source_url` **全为空** → 5 条全部可写入，无需让位。

**第三轮复测**：我们 `file_index` 从 5347 图 + 25 夹涨到 **5350 图 + 26 夹**，消失路径 0、孤儿 `file_metadata` 0、失效 file_id 0。v4 复测：5376 行 = 5350 图 + 26 夹，`path like '%/.pixcall%'` 行数 0、`Unknown` 行数 0（§8 销账）。

结论：join 键定「重建路径（**排除 Trash 子树**）→ `normalize_path`（`core/src/db/mod.rs:65`）→ 精确匹配 `file_index.path`」，不碰 `content_hash`。

## 4. 字段映射表（v1 范围，编码已实测）

| Pixcall 来源 | 我们落点 | 策略 | 状态 |
|---|---|---|---|
| `entries.tags`（`\|` 分隔 id）→ `tags.name` | **`file_metadata.tags`（JSON 列）** | 解码后过 `normalize()`，与我们已有标签取**并集**，保留我们已有顺序 | **已定**（⑦，落点见 §4.5） |
| `entries.link` | **`file_metadata.source_url`** | **v4 新增行（v3 整张表漏了它）**：仅当我们该行为空时填，不覆盖；**不做 URL 合法性校验**（本机有一条误存的 `x.com/home`，原样搬）。列与 UI 均现成（`EditSection.tsx:136` 起的「来源链接」段，不受 FOLDER 门禁限制） | **已定**（①，5/5 命中、我们侧全空） |
| `tags.category` / `tags.pinyin` / `tag_groups` / `tags.group_id` | — | **丢弃**：`category` 与我们 `getPinyinGroup`（`textUtils.ts:1-42`）归组等价，实测 10/10（⑧）；`tag_groups` 本机无样本，遇到则上报条数 | **已定**（⑧） |
| `entries.description`（文件） | `file_metadata.description` | **trim 后**仅当我们该行为空时填，不覆盖用户已写内容 | **已定**（⑨） |
| `entries.description`（文件夹） | `file_metadata.description`（folder 节点的行） | 同上一条。**展示位本来就有**，见 §4.4 | **已定**（⑩） |
| `boards` + `board_entries`（**含层级；智能节点可验证时固化**） | `topics` + `topic_files`（`position` 从现有 `COUNT(*)` 起排，同 `core/src/db/topics.rs:405` 语义） | 判据按 ⑪；**层级照搬**（§4.6，v4.1）：`parent_id=1`→我们 topics 根，其余挂到父节点映射出的 topic；**智能节点按 ⑭ 复算筛选、计数断言通过后固化为快照专题**（v4.2），断言不过或筛选含未标定键则跳过并上报，其手动子节点降级挂最近的已迁祖先；查重键 `(映射后父级, name)`，**同名已有专题时不新建、成员并进去**（v4.9 改，原为「不新建也不合并成员」）；`boards.description` 非空时写入 `topics.description`（并入已有专题时「空着才补」） | **已定**（⑪ + ⑭ + §4.6，v4.9 拍板合并） |
| `board_entries.entry_kind` | — | 校验：本机 4 条全为 1（文件）。若出现 0（文件夹），我们 `topic_files` 语义未定义 → **跳过该成员并上报** | **已定**（v4 新增，§4.8） |
| `entries.rating` | — | **不迁**（§5） | 决定：本期不做 |
| `folders.fixed_cover_id` / `folders.cover_id` / `icon` / `icon_color` | — | **不迁**（§5）。v4 补：`cover_id` 16/28 非空（它自算的夹子封面），`fixed_cover_id` / `icon` / `icon_color` 本机 0 非空 | 决定：本期不做 |
| `entries.name_pinyin` | — | 不迁；「拼音检索」对我们是真实缺口，另案评估 | 不在本期 |
| `captions` / `max.db` / `media` / `remote_events` | — | 不迁（§5） | 不在本期 |

### 4.4 文件夹描述有展示位，直接迁（v2 的「待拍板」作废，v3 已翻案，v4 复核成立）

`src/components/metadata/EditSection.tsx:41`（v3 误写为 `src/components/EditSection.tsx`，少一层 `metadata/`）的 FOLDER 门禁只挡 **Tags Section**；Description Section 在 `:96`，条件是 `{!isMulti && (`，不带任何类型判断。决定性证据是验收人的操作本身：他直接在我们应用里给 4 个文件夹写了长备注，全部落成 `file_metadata` 的 folder 行（v4 在库里逐行对上）。**文件夹备注零 UI 成本，直接按 §4 的表格迁。**（文件夹**标签**才是真被 `:41` 挡着的那个，但 Pixcall 侧的标签 8 条全挂在文件上，无影响；v4 复核我们库 folder 行带标签数 = 0。）

### 4.5 桌面标签真源不是 `tags`/`file_tags` 两张表（v3 已翻案，v4 复核成立）

| 存储 | 谁写 | 谁读 | 桌面库现状（v4 复核） |
|---|---|---|---|
| `file_metadata.tags`（JSON 列） | 桌面 `dbUpsertFileMetadata`；**LAN 也走它**（`src-tauri/src/lan_share/handlers.rs:166` 批量读、`:202-207` 读-合并-写整行） | 桌面加载 `dbGetAllFileMetadata` | 13 行中 5 行有标签，10 个唯一词 |
| `user_data.json` 的 `customTags` | `usePersistence`；LAN 的新词也并进这里（`handlers.rs:104-126`，不写库） | 侧栏 `App.tsx:1266-1281`（并集在 **1267-1268**；v3 写的 1264-1265 是空行） | 词表 |
| `tags` / `file_tags` 两张表 | 只由 `set_file_tags`（`core/src/db/tags.rs:76`）/ `add_tags_to_files`（`:89`）写 | **只有 Kotlin**：`core/src/ffi.rs:717+`（另 `:472-477` 的 `filter_images_by_tags` 也是读者，v3 漏列）与 `core/src/ai_task.rs:362` | **0 行 / 0 行** |

关键点：**侧栏 `groupedTags` = `customTags` ∪ 每个 FileNode 的 tags**，所以导入器只要写 `file_metadata.tags`，标签就会自动出现在侧栏，连 `customTags` 都不必动。→ **v1 只写 `file_metadata.tags` 一处。**

**两条仍然成立的硬约束：**

1. **`upsert_file_metadata` 是全行覆盖**（`core/src/db/file_metadata.rs:18-29`，`ON CONFLICT DO UPDATE SET tags=excluded.tags, description=excluded.description, ...`），漏传字段就是把已有数据清空。导入器**必须先读整行、改需要的列、再写回整行**。（背景更正：`docs/桌面版标签写入不落库问题-待修.md` 记的 bug 根因是改名/粘贴只改了 React state 没调 upsert，全行覆盖只是修复时要遵守的约束；该 bug 已修 2026-09-28。）
2. **folder 节点也要走同一条写入路径**：`scanner.rs:485` 的元数据合并不区分 Image/Folder，`FileNode.description` 已存在（`core/src/file_types.rs:54`），所以文件夹行按 file_id 正常 upsert 即可。

### 4.6 boards 的层级与查重（v4 新定，v4.1 按验收人拍板推翻「嵌套跳过」）

Pixcall 的 boards 是**树**：本机 `'test'.parent_id = '阿松大'.id`。我们的 `topics` 也是树（活数据：`Koc.parent_id = OPK.id`，即验收人自己的「OPK\Koc」主+子专题）。**验收人拍板：层级照搬**——他的看板结构就是按我们专题的心智建的，跳过嵌套等于把他真正想要的东西丢掉。规则：

1. **按树迁移手动节点**：`parent_id = 1` 的 board 挂到我们 topics 的根（我们侧根专题 `parent_id` 为 NULL）；其余 board 挂到「其父 board 映射出的 topic」下。先序遍历 boards 树，父节点先落库拿到我们的 topic id，子节点再用它做 parent。
2. **智能节点不是一律跳过：能验证就固化，不能验证才跳过（v4.2，规则 7/8）**。被跳过的智能节点，它的手动子节点不陪葬：降级挂到**最近的已迁祖先**（即跳过链上第一个成功映射的 topic）；若一个都没有，挂到 topics 根。两种降级都上报条数（`topics_reparented`）。理由：子看板是用户手工维护的成员集合，父级只是个查询条件，不该连坐。
3. 查重键是 **`(映射后的我们父级, name)`**，不是裸名字——名字在树里不唯一，裸名字查重会把不同父下的同名合集合并掉。
4. 命中同名已有专题时：**不新建，但把成员并进它**（v4.9 拍板，推翻原案「不新建也不合并成员」）。并的时候三件事守住：名字与父级不改（那是用户给专题起的、放的位置是他排的）；封面与描述**空着才补**——用户钉过的封面、写过的简介一律不动；`position` 从现有 `COUNT(*)` 续排，已在里的成员由 `INSERT OR IGNORE` 自然跳过，所以重跑是空操作。该节点仍写进映射表，它的子看板继续挂在同一个专题下。计数走 `topics_merged_name`，补了封面的另计 `topics_covered`。
   原案担心的「往别人已有的专题里塞成员是不可逆且出乎意料的」在同名同父这个前提下不成立：那个专题就是他在同一个位置用同一个名字要的东西。真出问题时靠的是 §6.5 的记录 + 重跑只做增量这一条。
5. `boards.description` 非空时写入 `topics.description`（两边列都在；本机 0 非空，空值安全）。
6. **智能合集固化为快照专题（v4.2，验收人拍板「只要文件过去就行」）**：用标定的筛选语义（⑭）在 PixCall 的 `entries` 上复算成员集合，再走标准 join 链落到我们的 `topic_files`。**语义上是快照**：导入后该专题是静态成员表，新产生的符合条件文件不会自动加入——我们侧没有智能专题机制，这是数据模型决定的，验收时要知晓。
7. **计数断言是硬门禁**：复算出的成员数必须**精确等于** `boards.file_count`，才允许落表；不相等就跳过并上报 `topics_skipped_unverifiable`。这条断言把「猜筛选语义」变成「可验证复算或放弃」：猜错桶边界（如把 small 猜成 <2 MiB 会得 2220）必然过不了断言。注意 `file_count` 是缓存值，源库在断言之后又增长时断言会保守失败——跳过比导入错名单安全。
8. **只实现标定过的筛选键**。当前标定表只有 `size.extra_small = 文件字节 < 1 MiB`（⑭，计数精确命中）。`filters` 里出现任何未标定的键或桶（small/medium/large/extra_large、tags、rating、日期、`must`/`must_not` 组合等）→ 不复算、直接跳过并上报。**不为迁移实现通用筛选器 DSL**——那是产品功能，另立项。
9. **固化的成员以 join 结果为准**：复算集合里若有我们 `file_index` 没有的条目（视频、未扫到的新文件），计入 `unmatched` 而不进 `topic_files`；因此 `topic_files_added` 可以小于 `file_count`，报告两栏都要给。本机 `test` 为 1457/1457 全中、0 视频（⑭）。
10. **本机数据的后果（v4.2 更新）**：`'阿松大'`（顶层手动）照迁 4 成员；`'test'`（智能、嵌套）**现在会作为 `阿松大` 的子专题固化进来，1457 成员**——层级路径与智能固化路径在今天的数据里**都能验到**。仍跑不到的是「智能父 + 手动子」的降级路径（§7 样本缺口 #3）。

### 4.7 MigrationReport 的计数栏（v4 新定）

报告必须分栏，缺一栏就会在验收时看起来像丢数据：

| 栏 | 含义 | 本机预期值 |
|---|---|---|
| `tags_unioned` / `tags_words_added` | 并集的行数 / 词表净增词数 | 8 行 / 9 词（`明日方舟：终末地` 已存在） |
| `descriptions_written` / `descriptions_skipped_existing` | 写入 / 因我们侧非空而让位 | 9 / **1**（NTE 夹） |
| `source_urls_written` / `source_urls_skipped_existing` | 同上 | 5 / 0 |
| `topics_created` / `topic_files_added` / `topics_merged_name` / `topics_covered` / `topics_materialized` / `topics_skipped_unverifiable` / `topics_reparented` | 合集各态：新建（含智能固化）/ 成员落表（并入时只算这次真新增的）/ 同名命中已有专题并并入成员 / 其中原本没封面、这次补了首张 / 智能节点固化成功 / 断言不过或含未标定键而跳过 / 手动子节点降级挂祖先 | 2 / 1461 / 0 / 0 / 1 / 0 / 0 |
| `skipped_unsupported_type` / 其中带标注者 / `topic_members_skipped_type` | `is_indexable` 为 false 的条目（今天即视频）/ 其中挂着标签、描述或来源链接的 / 合集成员里因类型被搁置的（§4.9） | **52**（v4.7 更正，原记 53：本机 `video/mp4` 共 53 条，其中 1 条在 Trash 子树、已计入 `excluded_trash`） / **1** / 0 |
| `excluded_trash` / `excluded_trash_names` | Trash 子树条目数 / 其名清单（v4.5 拍板 A：不复制、只列名；名字附原夹，取自 `source_path`） | 1 / 1（`Zenless Zone Zero 2026.07.13 - 23.38.12.01.mp4`，原夹 `Zenless Zone Zero`） |
| `unmatched` | 路径不命中清单（如实上报，不模糊猜） | 0 |

### 4.8 分类顺序（v4 新定）

① 排除 `parent_id=2` 子树（`excluded_trash`）→ ② `is_indexable(content_type)` 为 false 者计入 `skipped_unsupported_type`（§4.9，今天即 video/*）→ ③ 合集按 ⑪/§4.6 分态 → ④ 剩余做路径匹配，不中者入 `unmatched` → ⑤ 命中的按「并集 / 仅为空时填 / 同名跳过」合并并计数。**顺序错了会把同一条目重复计入两栏**（例如回收站里的 mp4 既算视频又算未命中）。注意 ② 与 ④ 的区分靠 `content_type` 而非「在不在 file_index 里」：视频今天不在索引里是**支持性问题**，删除图不在索引里是**缺失问题**，两者不能混在一栏。

### 4.9 视频支持的埋点（v4.3 新定：未来会支持视频，现在把接缝留对）

验收人拍板：视频未来会支持，本期不迁但**不许把路堵死**。埋点四条：

1. **支持性判定收敛为单一函数** `is_indexable(content_type: &str) -> bool`，放在导入模块里，全仓只此一处问「我们支不支持这类文件」。今天它对 `video/*` 返回 false、对 `image/*` 返回 true。**视频支持立项 = 改这一个函数 + scanner 收视频 + file_index 加 Video 类型**，导入器一行不改：原本被 ② 拦下的视频标注会自动走到 ④⑤ 正常落库。禁止在导入器其它地方散落 `== "image"` 或扩展名黑名单。
2. **解码不分类型，过滤只发生在落库阶段。** probe 对全部非 Trash 条目（含视频）解码标签/描述/来源链接/合集成员进中间计划；`is_indexable` 只在 apply 时过滤。因此视频上的标注今天是「**已解码、暂不落地**」，不是「丢弃」——计数进 `skipped_unsupported_type`，并在报告与 UI 文案里明说「N 条视频标注将在视频支持后随重新导入自动生效」。本机该栏为 **52**（v4.7 更正，原记 53；53 条 `video/mp4` 里有一条躺在 Trash 子树，按 §4.8 的顺序它先被 `excluded_trash` 吃掉），其中**带标注的 1 条**（v4.4：验收人给 `Arknights Endfield 2026.09.17 - 04.30.04.01.mp4` 补了标签「启动界面」、描述 `终末地登录界面\n`、B 站来源链接——**编码与图片完全一致**：竖线分隔 tag id、描述带尾换行、link 原样，`metadata` 键集仅少 `orientation` 多 `duration`，解码路径零特殊化，反向验证了本条设计）。搁置的代价就是这 1 条，视频支持落地后重导入自动补齐。
3. **join 永远只按 path，不许加 file_type 条件。** 视频支持落地后同一路径的 `file_type` 会从「不存在」变成 `Video`，任何带类型条件的 join 都会在那天静默失效。合集成员同理：成员 apply 用同一个 `is_indexable`，视频成员计 `topic_members_skipped_type`；视频支持后重导入会追加成员（`position` 续排，**顺序可能与 PixCall 原序不同**，接受并记录在案）。
4. **`media.metadata` 的字段映射先记档、不启用**：`image_width/image_height`→`file_index.width/height`、`duration`→（视频立项时的新列）、`extra.creation_time`→`created_at` 候选。视频元数据的写入是 **scanner 的职责**（重扫时自算），迁移不负责补写——埋点只保证立项时知道 PixCall 侧曾经算过哪些字段、格式是什么（ffprobe 级 JSON，见 §1）。
5. **视频取帧教训（v4.4 实测，视频立项时直接复用）**：该 mp4 的**首帧是纯黑**（fade-in，t=0 平均 RGB = 0,0,0），而 PixCall 的缩略图与 `color_palette` 都来自**早期一个非黑帧**——缩略图与 t=2~4s 帧的像素平均差仅 4.3/255，与 t=0 差 188.7/255；调色板（按 0xRRGGBBAA 解包，该解释下与缩略图颜色的最近邻距离 37.5，比 ARGB 解释的 81.8 低一倍）与 t=2~6s 帧的距离 35.1，为全场最低。**结论：我们视频支持立项时，自算缩略图/主色不得取 t=0**，需要「跳过近黑帧」或固定比例 seek 一类启发式；PixCall 的具体 seek 规则单样本定不了，也不必定——我们不迁它的主色（§5），只需避免自己踩同一个坑。顺带记档：`color_palette` 打包格式 = `R<<24 | G<<16 | B<<8 | A`。

`import_records` 存 `skipped_unsupported_type` 计数即可，不需要存视频路径清单：重导入是纯增量且会重新 probe，视频支持落地后用户再点一次导入（或设置面板那颗按钮）就补齐，无需额外存储。

## 5. 明确不迁的部分（及理由）

| 项 | 理由 |
|---|---|
| 扫描结果 / `entries` 整体当 `file_index` 用 | 我们的扫盘本来就便宜，导入它的树等于引入第二套扫描语义，还会把它的云占位项与 `ignore_rules` 差异变成我们的幽灵行。**本期先扫盘、后叠加标注** |
| 评分 `rating` | 我们全仓零实现（无列、无字段、无 UI、无 i18n key；`三端功能矩阵.md` 亦无此行）。迁评分＝先做评分功能 |
| 文件夹封面 `folders.fixed_cover_id` / `folders.cover_id` / `icon` / `icon_color` | 我们本地夹只有运行时 Canvas 合成，唯一的固定封面机制是专题级 `topics.cover_file_id`。`cover_id` 16/28 非空但那是它自算的，不是用户选择。要做是独立功能 |
| 文件级自定义缩略图 `entries.metadata.custom_thumb` | 5402 条**全 false**，零使用；机制本身我们也没有 |
| 主色 `entries.metadata.color_palette` | 我们 `colors.db` 已为 5348 个文件算好（`dominant_colors` + `image_color_indices` Lab），格式不同构，重算已自动化 |
| EXIF 级时间 `entries.metadata.creation/modification`、`media.metadata` | 我们 `file_index` 用文件系统时间；`media` 是视频元数据，我们不索引视频 |
| 近重复检测 `sim_hash.db` | 我们无对应表。它的 pHash + 8 向投影 + `phash_threshold=1` 是完整一套算法，且我们无法复算它的 `exact_hash`。应作为独立「重复文件」功能立项 |
| 通用筛选器 DSL（未标定的筛选键/桶） | 嵌套已照搬（v4.1）；智能合集 v4.2 起**可固化为快照专题**，但仅限标定过的筛选键（当前只有 `size.extra_small = <1 MiB`，⑭）且计数断言精确通过（§4.6 规则 7/8）。**未标定的筛选语义不迁**——为迁移实现通用 DSL 等于偷做产品功能，另立项 |
| 缩略图 `thumbs.db` | 我们的缓存键是 `md5(size ‖ mtime ‖ 前 4096 字节)`（`src-tauri/src/thumbnail.rs:45-60`，短边 256 在 `:152`），与它的 content-based 键不同构（且它有 `thumb/` 与 `icon/` 两个命名空间）。重生成很便宜 |
| 排序 `entries.ranking` / `folders.ranking` / `boards.ranking` | 用户手动排序/置顶，我们无对应概念 |
| 视频（本机 53 条 mp4） | 我们暂不索引视频。**已埋点（§4.9）**：标注照解码、落库阶段按 `is_indexable` 搁置并计数，视频支持立项后重导入自动补齐，导入器零改动 |
| 回收站内容（`parent_id=2` 子树 + `.pixcall\trash\` 实文件） | **不迁、不复制**（v4.5 拍板 A：只在报告列名字，§4.7 `excluded_trash_names`）。曾提案「opt-in：新建【废纸篓】文件夹 + 复制实文件 + 文件夹描述」，**否决理由四条**：① 我们无隐藏文件夹机制（`FolderSettings` 仅 layout/sort/group，scanner 无隐藏概念），复制进来的图片会全数复活进网格/搜索/主色/CLIP/局域网共享，与删除意图相反；② 在 PixCall 里还原后同图双路径、我们无内容级去重 → 网格双胞胎，且由他在另一个软件里的操作触发；③ 副本漂移（PixCall 清空后变僵尸）且空间翻倍，与安卓侧「不留副本换空间」的既有拍板相反；④ 破坏迁移「纯叠加标注、对文件系统零写、重跑安全」的契约与幂等。它想解决的三个问题都不存在（文件没丢、标注还原后自动迁、想知道跳过了什么靠报告列名）。**长期归宿：Aurora 自建废纸篓功能时，把 PixCall trash 映射到我们 trash** |
| 云同步相关（`keystore`、`blocks.db`、`hashtree.db`、`remote_events`、`kvs`）、`tasks.db`、`recent_entries`、`is_private`、`is_hidden`、`exif`、`captions` | 非用户创作内容 / 我们无对应概念 / 本机 0 行 |

## 6. 实现方案

### 6.1 分期与 UI（v4 按验收人拍板重写）

1. **只读探测 + 预览**（`probe`）：找到 `.pixcall`、以安全方式打开快照（§6.2）、按 §4 解码算出 §4.7 的各栏与未命中清单。纯读，零写入。
2. **执行导入**（`import`）：按 §4 落库，返回 §4.7 的完整报告。**与 probe 共用同一份快照**（§6.2 末）。id 一律在 Rust 里解（⑥）。
3. **UI —— welcome 第 1 步（验收人拍板的形态）**：
   - 在「选择文件夹」按钮**下方**加第二颗按钮「使用 PixCall 库」（次级样式，导入类图标）。两颗按钮互斥：点哪颗，下面的卡片就切到哪个模式。
   - **卡片是模式驱动的**，不再是「选了目录才出现」：`sourceMode = null | 'folder' | 'pixcall'`。`null` 不显示卡片（现状）；`'folder'` 显示现有卡片（当前选择 + 路径 + 扫描进度 + 扫描完成）；`'pixcall'` 显示新卡片（PixCall 库根路径 + 阶段标签 + 进度条 + 结果行）。
   - **进度条语义随阶段切换**：`switch`（设根目录、切库，瞬时）→ `scan`（复用现有 `scanProgress`，进度条=扫描进度）→ `probe`（读快照解码，进度条按 `entries` 行数或不确定态）→ `import`（**进度条=迁移进度**，按标注条目数）→ `done`（结果行：§4.7 各栏的一句话摘要，含「跳过 N 条回收站项，仍在 PixCall 废纸篓中」；N>0 时名字明细在设置面板的导入详情里，见第 4 条）。
   - **不设独立的预览确认弹窗**：整个合并是纯增量的（并集 / 仅为空时填 / 同名不新建 / 位置从 `COUNT(*)` 续排），重跑安全，所以报告作为**结果**展示而非事前确认。probe 发现 0 条可迁标注时显示「未发现可迁移的标注」且**不写迁移记录**。
   - 「下一步」门禁：folder 模式沿用现状（`currentPath && !isScanning`）；pixcall 模式为 `import 完成`。扫描期间（`isScanning`）导入按钮禁用，**复用现有进度 UI，不另做一套**。
   - 这颗按钮的语义是**「接管 PixCall 库」**：读 `%APPDATA%\Pixcall\config.json` → `library_path`（多库时给选择列表，过滤无 `.pixcall` 者）→ 复用现成的 `handleOpenFolder` 链（`switchRootDatabase` + `scanAndMerge`，`src/hooks/useDirectoryScan.ts:122/197`）→ 扫完自动 probe。这正好绕开「第 1 步还没选目录、`file_index` 为空、没东西可匹配」的死结（§6.3 的前置条件）。
4. **UI —— 设置 → 存储面板（存量/换库用户的入口）**：在现有「导出/导入元数据（标签/人物/专题）」按钮对（`StoragePanel.tsx:486/544`）旁边加一颗「使用 PixCall 库」。语义与 welcome 那颗**不同**：根目录已定，只往**当前打开的库**导标注，不重设根目录。**文案不能与 welcome 那颗相同。** 同面板加一块「上次导入报告」可展开区（读 `import_records.report_json`，§6.5）：列 §4.7 全栏计数，并把 `excluded_trash_names` 逐条列成「跳过 1 条回收站项：xxx.mp4（原 Zenless Zone Zero），仍在 PixCall 废纸篓中」——v4.5 拍板 A 的名字明细就落在这里，welcome 卡片只给计数。
5. **迁移记录**（§6.5）落 `.aurora/metadata.db` 新表，用来判定「已迁移过」，不能每次启动都问。
6. **i18n**：所有新字符串进 `translations.ts` 的 **zh（2-1039）与 en（1040-2077）两块**，命名空间 `import.*` + `welcome.usePixcallLibrary` / `settings.usePixcallLibrary`。v3 全文没提 i18n。

### 6.2 读取安全（源库在线，这条不能省）

- 把 `main.db` + `main.db-wal` 复制到临时目录再打开。**不能带 `-shm`**：Pixcall 运行时该文件被独占，实测 `cp` 直接报 `Device or resource busy`；只复制 db + wal 时 SQLite 能自行恢复 WAL，本方案各轮都用这套读法验证通过（`pragma integrity_check` = ok）。**wal 可能不存在**（本机 `thumbs.db` / `tasks.db` / `hashtree.db` 当下就无 `-wal`），复制逻辑要容忍缺文件。
- 失效模式要说准：不带 `-shm` 复制一个正在被写的 WAL 库，SQLite 靠 WAL 帧校验和忽略撕裂的尾帧，所以风险是**读到略旧的快照，不是读到坏数据**——`integrity_check` 通过也保证不了「最新」。
- **因此 probe 与 import 必须复用同一份快照**：probe 时把快照留在临时目录并返回句柄，import 用同一句柄；否则源库在两次读取之间被写（⑤ 记过十几分钟内 thumbnails 1171→5402），**预览条数会和实际导入条数对不上**，用户会以为导入出错。
- `SQLITE_OPEN_READ_ONLY` + `PRAGMA query_only`，先跑 `integrity_check` 再取数。
- 对 `.pixcall` **零写入、零删除、零改名**。Pixcall 之后完全照常可用——过渡期用户大概率两边都开着。
- 记录并核对 `kvs['schema_version']`（本机 22）。不认识的版本只做能安全做的那部分，并在报告里说明。

### 6.3 匹配与回退

主键：重建路径（**排除 Trash 子树**，⑫）→ `normalize_path`（`core/src/db/mod.rs:65`，`\`→`/`、去 Windows 盘符前导斜杠、去尾斜杠）→ 精确匹配 `file_index.path`。
回退一次：大小写不敏感匹配（各轮实测 0 条需要，但用户后改过名时会出现）。
仍不命中：**归入「未命中清单」如实上报**，不按名字/尺寸/mtime 模糊猜测——猜错会把标签贴到别人的图上。
前置：导入前我们这边必须已经扫过一次（`file_index` 非空）；未命中率高时提示「先重新扫描再导入」，而不是默默跳过。
**两个路径必须分开建模**：`pixcall_root`（`.pixcall` 所在目录）与我们当前打开的库根。本机二者重合（`C:\Users\Misaki\Videos\NVIDIA` 下并排 `.aurora` 与 `.pixcall`），但必须支持「我们根 = `Videos`、PixCall 根 = `Videos\NVIDIA`」这种子目录情形——路径精确匹配照样能中。v3 的 `probe_pixcall_library(root)` 把两者混成一个参数，v4 拆开。
发现顺序：① `<我们当前根>\.pixcall`；② `%APPDATA%\Pixcall\config.json` 的 `libraries[]`，**过滤掉没有 `.pixcall` 的**（本机 `D:\资源` 就是注册了没建库）；多于一个给选择列表。

### 6.4 多来源导入抽象（PixCall 是第一站，Eagle 下一期）

验收人拍板：PixCall 是实验的第一步，**后面还要支持 Eagle 导入**。所以本期就把共享部分抽出来，避免第二期重写：

- **共享（与来源无关）**：快照/只读访问管理、join 链（重建路径 → `normalize_path` → `file_index`）、合并策略（并集 / 仅为空时填 / 同名不新建 / `position` 续排）、§4.7 报告结构、§6.5 迁移记录表、welcome 卡片与设置按钮的 UI 组件、i18n 命名空间。
- **来源特定（每个来源一个适配器）**：库发现、格式解码、手动/智能等判据、§5 的跳过清单。
- Rust 侧落 `core/src/import/`：`mod.rs`（trait + 注册表）+ `pixcall.rs`；第二期加 `eagle.rs`。trait 契约只含 `discover() / probe() / import()` 与报告类型，**不许把「复制 db+wal」写进契约**——Eagle 的库是 `.library/` 目录 + 每图 JSON sidecar，**不是 SQLite**，快照策略必须 per-source。
- **Eagle 现状（v4 已查）**：本机未安装 Eagle、`%APPDATA%` 与常见盘符下均无 `*.library`，**没有真实库样本**。Eagle 适配器的格式调研等验收人给一个真实库后再做，本期只留接口与目录结构，不猜它的 schema。

### 6.5 迁移记录表

`.aurora/metadata.db` 新增 `import_records`：`id, source('pixcall'), source_root, source_schema_version, imported_at, report_json, matched, unmatched, skipped_existing, skipped_unsupported_type, topic_members_skipped_type`。
放 metadata.db 而非 `user_data.json`：**记录跟着库走**，换根目录不会误判「已迁过」，也不会把 A 库的迁移记到 B 库头上。现有 8 张表（file_index / file_metadata / file_tags / persons / tags / topic_files / topic_people / topics）中无任何 migration 类表，此表从零加。
同 `source + source_root` 已有记录时，按钮文案变为「已导入过，可重新导入（增量）」；因为合并纯增量，重跑安全，记录的作用是**信息展示 + 阻止自动弹提示**，不是硬阻断。

### 6.6 开工前提与实施顺序（v4.6 拍板）

**顺序拍板：迁移先做，Android 残留清理挂账。** 理由：§9 的验收预期对着源库**此刻**的状态（5350 图 / 13 标注 / 1457 成员 / 1 回收站 / 1 让位），源库每天都在被使用、会漂移，拖得越久验收越变成「重推预期」；清理是纯卫生、价值不衰减，且其中大块（101 处 `isAndroid*`）被 D42=a 明确不做、三个触发条件（包体瘦身 / 第三平台 / 分支引发线上缺陷）皆不成立（见 `docs/Android/React安卓版退役残留清单.md` §4，v1.1）。

**开工前两步（独立于迁移、先做、单独 commit）**：

1. **基线门跑绿**：`npx tsc --noEmit` + `npx vitest run`（当前 81 用例）+ `cargo check` + `npm run build`。注意清单 §5 记的坑：`src-tauri/static/lan-share/` 被 `.gitignore` 排除而 `lan_share/server.rs:24-26` 用 `include_str!` 内嵌它，**干净克隆上裸 `cargo check` 必失败**——换机器先 `npm run build:lan-share`；本机产物在，可直接跑。
2. **零风险批 + 工具修复**：清单 §2 的 3 个文件 + `src-tauri/Cargo.toml` 四条 android linker + `tauri.conf.json` 两个 `bundle.android` 字段，外加 3 个 adb 脚本的 `pidof com.aurora.gallery` → `com.aurora.gallery.kotlin`（它们今天就已经抓不到日志）。做完再跑一次门。**目的：让迁移期间任何红都只能归因于迁移**，而不是历史欠账。

**迁移内部切片（先核心后像素）**：

1. Rust 侧 `core/src/import/`（`mod.rs` trait + `pixcall.rs`）：快照（§6.2）、解码（⑦⑨⑭）、§4.8 分类、计数断言（§4.6 规则 7）、层级与降级（§4.6）、让位与并集（§4.5）、`is_indexable`（§4.9）。**用开发期入口（example 或 dev-only 命令）把 §4.7 报告打出来，逐栏对 §9 的表**——解码与断言的全部风险在这一层，先证明它再碰 UI。
2. `import_records` 表（§6.5）与报告落库。
3. Tauri 命令 + UI：welcome 第 1 步第二颗按钮与模式驱动卡片（§6.1 第 3 条）、设置-存储面板按钮与「上次导入报告」展开区（§6.1 第 4 条）。**此阶段验 1457 成员专题的网格滚动性能**（§4.6 规则 10 的后果，全文唯一标过的实现期留意点）。
4. i18n：`translations.ts` zh（2-1039）/ en（1040-2077）两块全量补 `import.*` 与两颗按钮的键（§6.1 第 6 条）。
5. 本机端到端验收：跑一遍对 §9；首跑环境另对 §9 末段的首跑预期。

**源库漂移提示**：§9 的数字是 2026-09-29 18:00–19:00 的快照（含验收人当晚补的视频标注）。若开工距复核已久，先按 §6.2 快照法重跑测量（排除 Trash、`count(size<1048576)` 断言、13/13 与 4/4 命中）再对表，别拿旧数字判新实现的生死。

## 7. 标注复核进度

已造并已解码验证（§2 ⑦–⑬）：标签（含中文标签、间隔号、全角冒号、ASCII）、手动合集、智能合集、描述、来源链接、回收站项（⑫，v4 用真实数据关闭）。

**仍缺的样本**——都不阻塞 v1 实现，但补上能少一次返工：

1. **标签分组**（`tag_groups` 仍 0 行）——本期按「丢弃 + 上报」写，若真实用户常用则改判。
2. ~~回收站项~~ **已关闭（⑫）**：判据 `parent_id=2`，非 `is_deleted`。
3. **降级路径与未标定筛选**（§4.6 规则 2/8）——v4.2 后「父手动 + 子智能（固化）」今天就能验（`阿松大`→`test`）；仍跑不到的是「智能父 + 手动子」的降级挂祖先，以及含未标定筛选键的跳过路径。补样本：在 `test` 下建一个手动子看板（验降级）；再造一个带 tags 或 rating 筛选的看板（验 `topics_skipped_unverifiable`）。
4. **AI 描述**（`captions` 仍 0 行，需它的 `max` 本地 LMStudio 跑通）——本期不迁，仅备。
5. 评分、文件夹钉封面、换图标——本期不迁，等他哪天顺手再采。

## 8. 已落地：scanner 的 `.pixcall` 豁免移除

`src-tauri/src/scanner.rs` 原本三处点目录过滤带着一条无来由的放行：

```rust
name != ".Aurora_Cache" && !(name.starts_with('.') && name != ".pixcall")
```

即其它点目录一律跳过，唯独 `.pixcall` 被走进索引。它里面只有 SQLite 与一个 `trash`，索引到的全是 `Unknown` 节点。全仓再无第二处引用 `.pixcall`，`git log -S` 只追到 `de368ce8f`「拆分Main.rs」这次文件搬迁，没有任何说明（2026-09-29 拍板：去掉）。

改动：三处判定（现 `scanner.rs:169`、`:345`、`:386`；v3 写的 160/336/377 偏了约 9 行）收敛到新增的 `is_ignored_entry_name(name)`（现 `scanner.rs:16-23`），规则就是「以 `.` 开头一律跳过」，并补注释记录该豁免已移除。语义差异只有一条：`.pixcall` 从「被索引」变「被跳过」，其余名字行为不变。

验证：`cargo check` 通过（40.4s，仅既有 warning）。

**运行时验证已通过（第三轮实测销账，v4 独立复核）**：重扫用的构建（17:40:16）晚于改动落盘（15:44:15）；重扫后 `file_index` 里 `path like '%/.pixcall%'` 行数 **0**、`file_type='Unknown'` 行数 **0**（v4 复测：5376 行 = 5350 图 + 26 夹，两栏皆 0），且这次扫描确实发生（补进了 3 张图和 `test` 文件夹，见 §3）。

## 9. 验收预期（v4 新增：今天这份数据应产出的报告）

按 §4.8 的分类顺序跑当前快照，报告应为：

```
excluded_trash            1     （Zenless Zone Zero 2026.07.13 - 23.38.12.01.mp4）
skipped_unsupported_type 52     （mp4；其中带标注 1、合集成员 0——视频支持落地后重导入自动补齐，§4.9。v4.7 更正：原记 53 把回收站那条重复计了一遍，本机 `video/mp4` 共 53 条、Trash 子树占 1 条）
topics_materialized       1     （test：断言 1457 == file_count 通过，固化为阿松大的子专题）
topics_skipped_unverifiable 0
topics_reparented         0     （test 固化成功，无降级）
tags_unioned              8     tags_words_added 9（明日方舟：终末地 已存在）
descriptions_written      9     descriptions_skipped_existing 1（NTE 夹）
source_urls_written       5     source_urls_skipped_existing 0
topics_created            2     （阿松大 + test）  topic_files_added 1461（4 + 1457）
unmatched                 0
```

任何一栏与上表不符，先怀疑分类顺序（§4.8）或 Trash 排除（⑫），再怀疑解码。

**首跑用户（我们侧库为空）的预期与上表不同**：没有让位与同名冲突，故 `descriptions_written 10 / descriptions_skipped_existing 0`、`tags_words_added 10`、`topics_merged_name 0`（v4.9 起这一栏改的名；原写 `topics_skipped_name`），其余栏相同。上表的 9/1 与 9 词是**双软并用机器**（验收人本机，Aurora 侧已有标注）的数字，不要拿它去对首跑环境。**两套预期现已都实测命中**（并用机器 21:07、首跑 22:10，见 §10）。

---

## 10. 实现落账与偏差登记（v4.7 新增，2026-09-29 首轮）

**提交**：`724d224` 零风险批 → `e53bfed` 迁移核心 → `839fd31` 命令层 + 设置入口 → `addd8ee1c` welcome 流程。§6.6 的开工前两步与迁移切片 1–4 全部落地，切片 5（本机端到端实库验收）留给验收人。

**落点**：

| 层 | 文件 | 对应设计 |
|---|---|---|
| 来源无关 | `core/src/import/mod.rs`（`OurIndex` join 链、合并策略、§4.7 报告、`apply_plan`、`is_indexable`、`record_import`） | §6.4 / §4.5 / §4.8 / §4.9 |
| PixCall 适配 | `core/src/import/pixcall.rs`（发现、快照、⑦⑨⑫⑭ 解码、§4.6 层级与固化） | §6.2 / §6.3 / §4.6 |
| 迁移记录 | `core/src/db/import_records.rs` + `init_db` 注册 | §6.5 |
| 命令层 | `src-tauri/src/import_commands.rs`（5 条命令 + `PixcallSnapshots` managed state + `pixcall-progress` 事件） | §6.1 第 1/2 条 |
| UI | `WelcomeModal` + `WelcomePixcallCard`（模式驱动卡片）、`settings/PixcallImportSection`（设置-存储入口 + 上次导入报告）、`utils/pixcallReport.ts`（摘要口径共用）、`api/tauri-bridge/import.ts` | §6.1 第 3/4 条 |
| 开发期入口 | `core/examples/pixcall_report.rs`：`probe` / `apply` / `discover` 三模式，按 §9 版式打印 | §6.6 切片 1 |

**本机实测（§9 逐栏，源库为 2026-09-29 20:20 的快照）**：`excluded_trash 1`（含原夹名 Zenless Zone Zero）、`skipped_unsupported_type 52`、`annotated_unsupported 1`、`topics_materialized 1`、`topics_created 2`、`topic_files_added 1461`、`matched 13`、`tags_unioned 8` / `tags_words_added 9`、`descriptions_written 9` / `skipped_existing 1`（NTE 夹）、`source_urls_written 5` / `0`、`unmatched 0`。**与 §9 唯一的差别就是上面更正的 52/53。**
落库验证全部在 `metadata.db` 的临时克隆上进行（实库一行未动）；克隆上第二次探测写入项全为 0，重跑安全成立。

**实现偏差与补充（都记在这里，不是静默改）**：

1. **报告多两栏**：`matched`（带标注且命中的条数，对 §3 的标注级口径）与 `warnings: string[]`。§4.7 的计数栏装不下「规则外状态」——`tag_groups` 真有行、标签挂在文件夹上、`entry_kind=0` 的成员、两信号不符、计数断言不过、快照专题语义——这些都曾有被静默吞掉的风险，现在全部进 `warnings` 并在设置面板的展开区逐条列出。
2. **文件夹上的标签跳过并上报**（§4.4 只说了「本机 0 条、无影响」）：我们的 `EditSection.tsx:41` 把文件夹的 Tags Section 挡掉了，写进去就是 UI 上看不见的隐形数据。今天这条路 0 条。
3. **`import_records.skipped_existing` = 描述让位 + 链接让位之和**（§6.5 只给了一个 `skipped_existing` 列，而 §4.7 是分两栏报的）。明细仍在 `report_json` 里。
4. **合集成员顺序按重建路径排序**，不保留 PixCall 的 `board_entries` 原序，也不按 64 位 id 排（那样等于依赖源库的内部生成序）。§4.9 第 3 条已接受「顺序可能与 PixCall 原序不同」。
5. **导入后的前端刷新复用 LAN 那条现成通道**：`apply` 成功后 emit `lan-share-data-changed`（`kind=metadata` 重建词表、`kind=topics` 重挂专题），没有另写一套刷新逻辑。
6. **`apply_plan` 不开外层事务**：`topics::insert_topic_files` 内部自带 `unchecked_transaction`，外面再包就是「在事务里开事务」。中途失败留下的是半份纯增量结果，修好重跑即补齐——这与 §6.1「重跑安全」的契约一致，但要知晓失败不是一键回滚。
7. **`useLongPress.ts` 未随零风险批删除**：残留清单 §5.4 明确建议把它单拎最后删（本表唯一归属存疑项，全文无安卓字样、桌面触屏可复用）；§6.6 第 2 步写的「§2 的 3 个文件」与此冲突，按更具体的 §5.4 执行。其余 §2 条目全部删净。
8. **adb 三脚本除 `pidof` 外还换了 logcat 过滤标签**：原 `aurora_gallery_lib` / `Tauri/Console` 随安卓壳一起失效，只改包名仍抓不到东西。现指向现役 Kotlin 标签（`AuroraKotlin` / `AuroraLan*` / `AuroraCanvas` 等，对齐 `scripts/kotlin-dev.ps1:84`）。
9. **导入出来的专题必须自己补封面**（验收人实库首跑指出）：桌面把「专题还没有封面且本次归入了新成员 → 取第一个 Image 成员当封面」这条规则写在前端（`useTopics.ts:89-98`），而导入器是直接写 `topics` + `topic_files`，绕过了它，结果 `阿松大`/`test` 的 `cover_file_id` 全是 NULL、卡片空封面。现在 `apply_plan` 落库时补同一条规则：成员按 §4.9 的 `is_indexable` 过滤后全是 `image/*`，所以「首个成员」就是「首张图」。**只在新建时给**——同名让位的已有专题一行都不碰（§4.6 规则 4），用户自己钉过的封面不会被重跑打回。彩排时这一条被意外验到：只删 `test`、留着 `阿松大` 时，重跑只给 `test` 补封面。
10. **上报文案是纯文本渲染**：设置面板展开区与 welcome 结果行都不是 markdown，所以警告文案里不许出现 `**快照**` 这类强调符号（第一版写了，验收人截图里就是两个杂散星号）。文案也照验收人的偏好砍短，语义留在句子里。
11. **删父专题级联子专题（v4.9 拍板，收进 core）**：`topics::delete_topic` 原先只删自己那行 + 两张关联表。安卓早就按「删父连带子」的心智在用，但那层是补在 `GalleryViewModel.deleteTopic` 里手工递归的；桌面 React 的 `useTopics.handleDeleteTopic` 没有这一步——于是删父之后子专题变成孤儿行（`parent_id` 指向已不存在的专题，看不见也删不掉）。现在 BFS 过 `parent_id` 一次性删整棵子树（`visited` 拦环，只删专题与关联、不动图片文件），两条线共用，安卓那段预删降为兜底（重复删已不存在的 id 是 no-op，注释已改）。桌面内存态同步摘子树。
    这条和偏差 9 是连着的：**导入出来的专题 id 是从源看板 id 确定性派生的**（`md5("pixcall-board|{board_id}|0")` 前 9 位），所以删掉父专题再重导会拿回同一个 id，幸存的子专题的 `parent_id` 又正好重新指向它——查重键 `(父级, name)` 于是命中，子专题被当成「已有的同名专题」。旧规则 4「一行都不碰」在这种情况下就把空封面永久锁死了（`阿松大`/`test` 那次）。
12. **同名看板改为并入成员（v4.9 拍板，推翻 §4.6 规则 4 原案）**：见改写后的规则 4。报告栏 `topics_skipped_name` 换名 `topics_merged_name`，新增 `topics_covered`；`has_anything_to_migrate` 现在也把「并入成员」和「补封面」算作动过库（只补一张封面也要留下迁移记录）。UI 摘要多一句「并入已有专题 N 个」，免得 `专题 0 个` 被读成没动静。
    **历史 `import_records` 里的行仍带着 `topicsSkippedName` 键**（改名前落的），摘要不读这一栏所以照旧可渲染，不必迁移旧数据。

**首跑环境实测（2026-09-29 22:10，验收人清空全部应用数据后走 welcome 那颗）**：`import_records` 全新库只落 1 行，报告**逐栏命中 §9 末段的首跑预期**——`excluded_trash 1`、`skipped_unsupported_type 52`（其中带标注 1）、`matched 13`、`tags_unioned 8`、**`tags_words_added 10`**、**`descriptions_written 10` / `skipped_existing 0`**、`source_urls_written 5` / `0`、`topics_created 2`、`topic_files_added 1461`、`topics_materialized 1`、`topics_merged_name 0`、`topics_covered 0`、`unmatched 0`；库侧 `file_index` 5350 图 + 26 夹，`file_metadata` 8 行带标签 / 10 行带描述 / 5 行带链接。与并用机器的差值正好是那三处（词 +1、描述全写不让位、没有同名冲突），§9 的两套预期至此都验完。welcome 那条接管链（设根 → 扫盘 → probe → import）也在真应用里跑通了——此前它只有 jsdom 用例。

**双软并用机器的首跑结果（2026-09-29 21:07）**：`import_records` 落 1 行（schema 22、matched 13、unmatched 0、让位 1、52），报告全栏与更正后的 §9 **逐栏一致**；`file_metadata` 13→22 行（带标签 5→10、带描述 6→15、带链接 3→8），NTE 夹保留他自己写的长备注，`72C2…png` 为 `["test2","王权","极乐净土","CEP"]`（原序保留 + 新词追加）。偏差 9 的封面修复在克隆库上彩排过（删两专题 → 重导 → `topics_created 2`、两个封面都等于各自 position 最小的成员，且他自己的 OPK/Koc 同样符合这条规则），**实库那两行的封面仍待他用带修复的构建重导或手工补**。

**尚未做 / 待验收**：

- ~~**实库首跑**~~ **已完成（2026-09-29 21:07，见上方首跑结果段）**；剩下的是偏差 9 的封面：`阿松大`/`test` 这两行是在修复之前落库的，`cover_file_id` 仍为 NULL，需要用带修复的构建重导（在应用里删掉这两个专题再点一次导入即可），或直接给这两行写 `cover_file_id = position 最小的成员`。
- ~~**首跑环境（我们侧库为空）那一组数字仍未验**~~ **已验（2026-09-29 22:10，逐栏命中，见 §10 末段）**。清场做法留档，下次要重验照着来：完全退出应用 → 清 `%APPDATA%\com.aurora.gallery\`（`user_data.json` 里藏着 19 个 customTags 与 2 个专题的副本，不清就凭空多出空标签和旧专题；而且没设资源根时 `get_initial_db_paths` 会**退回用同目录那份 8 月的旧 `metadata.db`**，首跑就不干净）→ 清 `%LOCALAPPDATA%\com.aurora.gallery\EBWebView\`（前端 localStorage/IndexedDB 在这儿）→ 库侧 `.aurora\` 与 `.Aurora_Cache\`。**`.pixcall`、`.pixcall.cache`、`%APPDATA%\Pixcall`、`%LOCALAPPDATA%\Pixcall` 一个都别动**，那是源库。
- **1457 成员专题的网格滚动性能**（§4.6 规则 10 的后果，全文唯一标过的实现期留意点）：需要在真库里点进去看。
- **§7 的样本缺口 #1/#3/#4**（标签分组、智能父+手动子降级、AI 描述）：实现与单测已按规则覆盖（降级路径、未标定筛选、`tag_groups` 丢弃都有对应测试用例，用内存夹具造的），但**本机真实数据跑不到这几条路**。补样本时在 PixCall 里建对应看板，再点一次导入即可验。
- **Eagle 适配器**：`core/src/import/` 的目录结构与 trait 侧共性已就位，`eagle.rs` 待真实库样本（§6.4）。

---

## 更正记录

| 项 | v1 说法 | v2 实测结论 |
|---|---|---|
| TBD-1 `entries.tags` 编码 | 猜「JSON 数组或逗号串」 | **两者皆错**：竖线分隔的 **tag id**，需 join `tags.name` 解码（⑦） |
| TBD-2 `tags.category` 语义 | 未知，倾向丢弃 | 就是拼音首字母；与我们 `getPinyinGroup`（`textUtils.ts:1-42`）归组等价，实测 10/10，**确认丢弃无损**（⑧） |
| TBD-3 手动/智能合集判据 | 未知 | `filters='{}'` 且 `board_entries` 有行 = 手动；两信号一致（⑪） |
| TBD-4（新增） | — | 所有 id 是 64 位、**过一遍 JSON 就精度丢失**（⑥），解码必须在 Rust |
| 描述字段 | 未察觉尾部换行 | 5/5 文件夹备注、2/5 图片备注带 `\n`，导入须 trim（⑨） |
| 命中率 §3 | 只测了库级 5347/5347 | 补测标注级 13/13，并找到现成合并用例（`test2` 与 Pixcall 标签共存） |

| 项 | v2 说法 | v3 实测结论 |
|---|---|---|
| §4.4 文件夹备注展示位 | 「桌面 `EditSection.tsx:41` 排除 Folder，**没有展示位**」→ 列成 A/B/C 待拍板 | **错**：`:41` 只挡 Tags Section，Description Section 在 `:95-96` 无类型门禁；验收人已在我们应用里给 4 个文件夹写了备注并成功落库。→ **零 UI 成本，直接迁**，A/B/C 撤销 |
| 硬约束 1「标签两边都要写」 | 「只写 `file_tags` 桌面看不见，只写 JSON 列安卓/LAN 看不见」 | **错**：`tags`/`file_tags` 在本机桌面库实测 **0 行**且**无任何桌面读者**——Kotlin 开自己的 `filesDir/aurora.db`，LAN 读写都走 `file_metadata`（`handlers.rs:166`/`:202-207`），新词并入的是 `user_data.json`（`:104-126`）。侧栏 `groupedTags` = `customTags` ∪ FileNode.tags → **只写 `file_metadata.tags` 一处即可** |
| §8 运行时验证 | 「未做，需下次重扫确认」 | **已通过**：17:40:16 的构建（含 15:44 改动）重扫后 `.pixcall` 行数 0、Unknown 行数 0，且这次扫描确实发生（补进 3 图 + `test` 夹） |
| boards 导入的查重 | 未考虑 | 我们库**已有 2 个专题**（`OPK` 嵌套 `Koc`，成员 3+8），导入必须按名字查重而非新增同名 |
| 「本机无可迁数据」 | v1 §2⑥ 的整段担忧 | 已由验收人补标注解决；同时发现我们侧写入路径的三处存储真相，比原判断更简单 |

| 项 | v3 说法 | v4 复核结论（2026-09-29，逐条重算） |
|---|---|---|
| §2① 「`source_path` 与 `link` 全为 NULL」 | 作为「库里不存绝对路径」的论据 | **两半都错**：`source_path` 1 条非空（回收站项的原所在夹，值非路径）、`link` **5 条非空且全是文件**。结论仍对，论据换掉；`link` 升格为要迁的字段 |
| §4 映射表 | 无 `entries.link` 行，§5 也未列 | **整张表漏了一个零成本字段**：`entries.link` → `file_metadata.source_url`。列与 UI 均现成（`EditSection.tsx:136` 起，无 FOLDER 门禁），5/5 命中、我们侧全空 → v4 加入 §4 |
| §2② 「5403/5403，0 缺失」 | 路径重建零缺失 | **已过期**：缺 1 条（回收站 mp4，文件在 `.pixcall\trash\`）。排除 Trash 子树后 0 缺失；并由此定出回收站判据 = `parent_id=2`（**非 `is_deleted`**，该项仍为 0）与「重建必须排除 Trash 子树」的正确性要求（否则根级命名空间假命中） |
| §1 「8 个 SQLite」/「八个库的分工」 | 8 | **实为 7 个**（blocks/hashtree/main/max/sim_hash/tasks/thumbs）；main.db 实为 **12 张表**，v3 列 11 张、漏 `remote_events` |
| §5 不迁清单 | 未列 `folders.cover_id`、三处 `ranking`、`entries.metadata.*`、`media`、`remote_events` | 补全：`cover_id` 16/28 非空（它自算）、`custom_thumb` 5402 全 false（无损失）、`color_palette` 不用迁（我们 `colors.db` 已算 5348 个文件）、`media` 是视频元数据、`ranking` 是手动排序 |
| §4 boards 映射 | 只写名字查重，未提 `parent_id` / `description` | 补 §4.6：boards 是树（本机 `'test'` 嵌在 `'阿松大'` 下），我们 topics 也是树；v1 只导顶层手动，嵌套跳过并上报；查重键含父级；同名已有专题**不合并成员** |
| §6.1 报告 | 只有「逐类计数与未命中明细」 | 补 §4.7：必须有 `skipped_existing` 栏——本机 NTE 夹的描述**必被让位**，没有这栏「5 条备注只进 4 条」看起来像丢数据 |
| §6.1/6.2 probe 与 import | 两个独立命令、各自复制快照 | 补 §6.2 末：**必须共用同一份快照**；并说准失效模式是「读到略旧快照」而非坏数据（WAL 帧校验和忽略撕裂尾帧） |
| §6.1.3 UI | 「第 1 步扫完之后**插一步**」+ 设置面板「另留一个手动入口」 | 按验收人拍板重写（§6.1）：welcome 第 1 步「选择文件夹」**下方**加第二颗按钮，卡片改模式驱动（folder / pixcall），进度条随阶段切换、迁移阶段显示迁移进度；**不设独立预览确认**（合并纯增量、重跑安全，报告作结果展示）；设置-存储面板的按钮是**存量用户主入口**且语义不同（不重设根目录）；并补 i18n 双份要求 |
| 引用路径/行号 | `src/components/EditSection.tsx`；`App.tsx:1264-1265`；`scanner.rs` 160/336/377 | 实为 `src/components/metadata/EditSection.tsx`；并集在 `App.tsx:1267-1268`；调用点在 `scanner.rs:169/345/386`。另补 `ffi.rs:472-477` 也是 `file_tags` 读者、`thumbnails` 有 `icon/` 第二命名空间 |
| §4.5 引证 | 「`docs/桌面版标签写入不落库问题-待修.md` 就是踩这个坑」 | 该文档根因是**漏写**（改名/粘贴只改 React state），全行覆盖只是修复约束；且已标**已修（2026-09-28）** |
| §7 样本缺口 #2 回收站 | 「仍缺样本，规则未定稿」 | **关闭**：真实数据已给出（⑫） |
| §3 命中率 | 只测标注级 | 补合集成员级 **4/4**；补「来源链接 5/5 且我们侧全空」「NTE 夹必让位」两个现成验收用例；新增 §9 验收预期表 |

| 项 | v4 说法 | v4.1 拍板结论 |
|---|---|---|
| §4.6 嵌套合集 | 「v1 只导顶层手动，`parent_id≠1` 跳过并上报」 | **推翻**：验收人拍板层级照搬——他的看板（`阿松大`→`test`）就是按我们专题（`OPK`→`Koc`）的心智建的，跳过嵌套等于丢掉他真正要的东西。改为按树迁移手动节点，`parent_id=1`→topics 根 |
| 智能节点的子节点 | （v4 未定义，整棵子树随嵌套规则一起跳过） | **新定**：智能节点跳过但手动子节点不陪葬，降级挂最近的已迁祖先，无祖先则挂 topics 根，计 `topics_reparented` |
| `test` 进不来的原因 | 「嵌套」 | 改为「**智能**」：1457 个成员是查询结果不落表，迁过来要么固化查询要么建空壳，都不对。层级代码路径因此今天仍跑不到，样本缺口转记 §7 #3 |
| 报告栏 | `topics_skipped_nested` | 换为 `topics_reparented`；§9 预期值同步（1 / 4 / 0 / 1 / 0） |

| 项 | v4.1 说法 | v4.2 拍板结论 |
|---|---|---|
| 智能合集 | 「跳过；1457 个成员是查询结果，迁过来要么固化查询要么建空壳，都不对」 | **推翻（验收人：「只要文件过去就行了」）**：固化为快照专题是可行的，前提是能证明复算名单与 PixCall 自己的计数一致。实测 `extra_small` = 文件 < 1 MiB（⑭：`count(size<1048576)=1457` 精确等于 `file_count`，阈值窗口内唯一整数边界），1457 条全图片、1457/1457 可落表 |
| 固化的语义 | — | **新定**：快照。导入后专题是静态成员表，新符合条件的文件不会自动加入（我们侧无智能专题机制）；验收时需知晓 |
| 安全门禁 | — | **新定**：计数断言（复算数 == `boards.file_count`）不过就跳过并上报 `topics_skipped_unverifiable`；只实现标定过的筛选键（当前仅 `size.extra_small`），**不为迁移实现通用筛选器 DSL** |
| §5 不迁清单 | 「智能合集、嵌套合集」整行不迁 | 拆细：嵌套已照搬（v4.1）；智能可固化（v4.2）；**只有未标定的筛选语义仍不迁** |
| §9 预期报告 | `topics_created 1 / topic_files_added 4 / topics_skipped_smart 1` | `topics_created 2 / topic_files_added 1461 / topics_materialized 1 / topics_skipped_unverifiable 0`；层级与智能固化两条路径今天都能验，§7 #3 收窄为降级路径与未标定筛选 |

| 项 | v4.2 说法 | v4.3 埋点结论 |
|---|---|---|
| 视频 | §5 整行「不迁，我们不支持索引视频」，§4.8 ② 按「非图片」硬分类 | **埋点**（验收人：未来会支持视频）：支持性判定收敛为单一 `is_indexable(content_type)`；解码不分类型、只在落库阶段过滤；视频标注是「已解码暂不落地」而非丢弃，视频立项后改一个函数 + scanner，导入器零改动自动生效（§4.9） |
| 报告栏 | `skipped_unsupported` 一栏 | 拆为 `skipped_unsupported_type` + 「其中带标注者」+ `topic_members_skipped_type`；与真·未命中 `unmatched` 严格分开（支持性问题 vs 缺失问题，靠 `content_type` 区分而非「在不在 file_index」） |
| join 条件 | 未约束 | **明令只按 path**，禁止加 file_type 条件——视频落地当天任何类型条件 join 都会静默失效（§4.9 第 3 条） |
| `media.metadata` | §5 一句「视频元数据，不读」 | 字段映射记档待启用（width/height/duration/creation_time），写入职责归 scanner 而非迁移（§4.9 第 4 条） |
| 本机影响 | — | 无：53 个视频 0 挂标注、0 合集成员、0 在 `extra_small` 集合，搁置零损失；§9 数字仅改栏名 |

| 项 | v4.3 说法 | v4.4 实测结论 |
|---|---|---|
| 「其中带标注者」 | 0（搁置零损失） | **1**：验收人给 `Arknights Endfield 2026.09.17 - 04.30.04.01.mp4` 补了标签「启动界面」、描述、B 站链接。编码与图片**完全一致**（竖线 tag id / 描述带尾换行 / link 原样；`metadata` 键集仅少 `orientation` 多 `duration`）→ 解码零特殊化被反向验证，§4.7/§9 同步改 1 |
| 视频主色/缩略图取帧 | 未涉及 | **不是首帧**：首帧纯黑（t=0 平均 0,0,0）；PixCall 的缩略图与调色板都来自早期非黑帧（缩略图 vs t=2~4s 像素差 4.3/255，vs t=0 差 188.7/255）。我们视频立项时自算缩略图/主色**不得取 t=0**（§4.9 第 5 条） |
| `color_palette` 打包格式 | 只说「逗号分隔的打包整数」 | 定为 `R<<24 \| G<<16 \| B<<8 \| A`（RGBA 解释与缩略图颜色最近邻距离 37.5，ARGB 解释 81.8） |

| 项 | v4.4 状态 | v4.5 拍板结论 |
|---|---|---|
| 回收站内容的呈现 | 只有计数 `excluded_trash`；验收人曾提案「opt-in 复制成【废纸篓】文件夹 + 描述」 | **拍板 A：不复制、不建文件夹**。报告增 `excluded_trash_names`（名字 + 原夹 `source_path`）；welcome 卡片结果行只给计数，名字明细落在设置-存储面板新增的「上次导入报告」展开区（读 `import_records.report_json`）。否决复制提案的四条理由与长期归宿（Aurora 自建废纸篓时再映射）记入 §5 |

| 项 | v4.5 状态 | v4.6 拍板结论 |
|---|---|---|
| 实施顺序 | 未涉及（文档只写「可进入实现」） | **新增 §6.6**：迁移优先于 Android 残留清理（§9 预期会随源库漂移、清理价值不衰减、D42=a 大块三触发条件皆不成立）；开工前先跑绿基线门 + 零风险批与 adb 脚本修复（单独 commit，保证迁移期的红可归因）；迁移内部「先核心后像素」——Rust 导入器先对 §9 的表，再接 UI/i18n；1457 成员专题的网格性能放在 UI 阶段验；源库漂移时先重测再对表 |

| 项 | v4.6 说法 | v4.7 实测结论（2026-09-29 实现首轮，本机真实库 + 克隆库） |
|---|---|---|
| §4.7 / §9 的 `skipped_unsupported_type` | 本机预期 **53** | **52**。本机 `video/mp4` 共 53 条，其中 1 条（`Zenless Zone Zero 2026.07.13 - 23.38.12.01.mp4`）的 `parent_id=2` 在 Trash 子树里，按 §4.8 自己的分类顺序它先被 ① `excluded_trash` 吃掉，不该再进 ②——v4.6 的预测表正是犯了 §4.8 警告的「同一条目重复计入两栏」。§4.9 第 2 条的「本机该栏为 53」同步更正 |
| §4.7 报告结构 | 14 个计数栏 + `excluded_trash_names` + `unmatched` | 实现补 `matched` 与 `warnings[]`：`tag_groups` 有行、文件夹上挂标签、`entry_kind=0` 成员、⑪ 两信号不符、§4.6 规则 7/8 的跳过理由都需要出口，计数栏装不下（§10 偏差 1） |
| §4.4 文件夹标签 | 「Pixcall 侧的标签 8 条全挂在文件上，无影响」 | 补实现口径：真有文件夹标签时**跳过并上报**，因为 `EditSection.tsx:41` 的 FOLDER 门禁让它们在我们 UI 里不可见（§10 偏差 2） |
| §6.5 `skipped_existing` | 单列 | 实现为「描述让位 + 链接让位」之和（§10 偏差 3），明细仍在 `report_json` |
| §6.6 第 2 步「§2 的 3 个文件」 | 含 `useLongPress.ts` | 按残留清单 §5.4 的建议**未删** `useLongPress.ts`（唯一归属存疑项，留给最后一批）；其余 §2 条目删净（§10 偏差 7） |
| §6.1 第 3 条 UI | 设计描述 | 已实现：welcome 两颗互斥按钮 + 模式驱动卡片 + 阶段进度（scan 复用现有 `scanProgress`），门禁 pixcall 模式看 import 完成；「接管」所需的 `openKnownPath` 从 `handleOpenFolder` 抽出并 await 扫描结束（提交 `addd8ee1c`） |
| 状态 | 「可进入实现」 | 「核心与两个入口已实现」：§9 逐栏在本机跑通、克隆库上重跑写入为 0；实库首跑与 1457 成员网格性能待验收人点（§10） |

| 项 | v4.7 说法 | v4.8 实测结论（验收人实库首跑后） |
|---|---|---|
| 导入专题的封面 | 未涉及（§4 的 topics 行只写了 `position` 续排） | **补规则**：桌面把「无封面且归入新成员 → 取第一个 Image 成员当封面」写在前端 `useTopics.ts:89-98`，导入器直接落库绕过了它，`阿松大`/`test` 落库后 `cover_file_id` 全 NULL、卡片空封面。现由 `apply_plan` 在新建时补同名规则；同名让位的已有专题不碰（§10 偏差 9，提交 `00c1cc2bb`） |
| §4.6 规则 4 的「不碰已有专题」 | 只写了「不新建也不合并成员」 | 实库彩排把它延伸验到封面：只删 `test`、留着 `阿松大` 时重跑只给 `test` 补封面，`阿松大` 一行未动——「一行都不碰」原来还含封面这一项 |
| §4.7 上报文案 | 未规定渲染形态 | 设置面板展开区与 welcome 结果行都是纯文本，第一版带了 markdown 的 `**快照**` 被读成杂散星号 → 文案不许出现强调符号（§10 偏差 10，提交 `63cd70566`） |
| §9 实库首跑 | 预期表 | **逐栏命中**（含更正后的 52）；`import_records` 落 1 行，`file_metadata` 13→22 行、NTE 让位、`72C2…png` 并集保留原序。命令层 + UI 这条路径由验收人跑通（此前只有 `core/examples` 与单测验过） |

| 项 | v4.8 说法 | v4.9 拍板结论 |
|---|---|---|
| §4.6 规则 4「同名已有专题不新建也不合并成员」 | 已定（理由：往别人已有的专题里塞成员不可逆且出乎意料） | **推翻（验收人：「如果专题同名时则合并就好了」）**：不新建、成员并进去；名字与父级不改，封面与描述「空着才补」。§4 表与规则 4 同步改写，报告栏 `topics_skipped_name` → `topics_merged_name`，新增 `topics_covered`（提交 `9ff57428c`） |
| 删除父专题的行为 | 文档未涉及（只写了 topics 的写入侧） | **拍板「删除父专题自然要关联到子专题」**：级联收进 `core/src/db/topics.rs::delete_topic`。安卓此前在 `GalleryViewModel.deleteTopic` 手工递归补了一层，桌面漏了——删父后子专题变成看不见也删不掉的孤儿行。这是公共层行为变更，Kotlin 线一并生效，那段预删降为兜底 |
| 导入专题的 id 形态 | 未规定 | 实现是确定性的（`md5("pixcall-board\|{board_id}\|0")` 前 9 位）。副作用记 §10 偏差 11：重导会拿回同一个 id，幸存的子专题因此重新认父并被查重命中——旧规则 4 正是这样把空封面永久锁死的（`阿松大`/`test` 那次的真因） |
| §10 待办「实库两行封面仍为 NULL」 | 待重导或手工补 | 验收人 21:34 把两个专题都删掉重导（报告 `topicsCreated 2`/`topicFilesAdded 1461`），实库两行封面已补齐。合并路径另在克隆上彩排：清空 `test` 封面 + 删 3 个成员 → 一次导入 `merged 2 / created 0 / files_added 3 / covered 1`，再跑一次全 0 且不写新记录 |

| 项 | v4.9 说法 | v4.10 结论 |
|---|---|---|
| §9 首跑那一组预期 | 「待验收人清库再对」，且沿用了改名前的栏名 `topics_skipped_name` | 栏名更正为 `topics_merged_name`；**22:10 实测逐栏命中**（`tags_words_added 10`、`descriptions_written 10`/让位 0、`topics_created 2`、`topic_files_added 1461`、`unmatched 0`，库侧 5350 图 + 26 夹）。至此 §9 的两套预期全部验完 |
| welcome 那条接管链 | 只有 jsdom 用例，真应用未跑 | 验收人清空全部应用数据后走 welcome，实跑通（设根 → 扫盘 → probe → import → 结果行） |
| 「怎么清成一个干净的首跑环境」 | 文档只说要移开 `metadata.db` + `user_data.json` | 补全清单与两个坑：`user_data.json` 里另藏着 customTags 词表与 2 个专题副本；没设资源根时 `get_initial_db_paths` 会退回用 `%APPDATA%\com.aurora.gallery\` 里那份 8 月的旧 `metadata.db`。前端 localStorage/IndexedDB 在 `%LOCALAPPDATA%\…\EBWebView\`。源库那四处（`.pixcall`/`.pixcall.cache`/`Roaming\Pixcall`/`Local\Pixcall`）一律不许动 |
