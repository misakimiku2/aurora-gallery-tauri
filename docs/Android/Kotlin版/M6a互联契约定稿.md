# M6a 互联契约定稿（阶段 1 服务端扩展）

> 版本： v1（2026-09-24，阶段 1.0 定稿）
> 地位： 本文是 M6a 阶段 2（桌面失效消费）与阶段 3+（Kotlin 客户端）的**并行实现依据**。字段名/路由/方法自本文定稿起冻结，后续端点实现不得偏离契约改字段名（M6a 清单 §1 纪律）。
> 风格基准： 逐字对齐桌面服务端现状（`src-tauri/src/lan_share/`）——token 走 `Authorization: Bearer <token>` header（缩略图/大图例外，额外支持 `?token=` query）；错误统一 `{"error": "<message>"}` + HTTP 状态码；文件类写操作的**文件系统级失败**沿用现状返回 200 + `success:false`（不映射 5xx）。

## 0. 通用约定

- **鉴权**： 除 `/api/auth/*` 外全部要求 Bearer token，缺失/过期/无效 → `401 {"error": ...}`。
- **门禁**（M6a 清单 D32：默认全权，Rust `LanShareConfig::default()` 的 `allow_edit`/`allow_upload` 已改 `true`）：
  - 只读端点（browse/palette/all_image_folders/search/thumbnail/image/devices/heartbeat/**metadata/batch/people/topics**）：仅 token。
  - 编辑端点（rename/delete/move/copy/**PUT metadata/PUT person/topic 建删与成员调整**）：token + `allow_edit`，门禁关闭 → `403 {"error": "Edit not allowed"}`。
  - 上传（upload）：token + `allow_upload`，关闭 → `403`。
- **path 身份铁律**： 所有端点的 `path` 参数/回传值都是**不透明字符串**（共享根相对路径，`/` 分隔；历史上旧版本服务端可能回传过带盘符的绝对路径）。客户端**不得解析、规范化或拼接**，原样回传。服务端以 `file_id = md5(绝对路径) 前 9 位十六进制`（`core/src/db/mod.rs generate_id`）为库内身份，**rename/move 后 file_id 必变**——客户端一切以 path 为身份，写操作后以响应中的新 path 刷新。
- **事件**（照抄 `lan-share-devices-changed` 范式，无大数据负载，前端收到后回拉）：
  - Tauri 事件名： `lan-share-data-changed`
  - payload： `{"kind": "metadata" | "files" | "people" | "topics"}`
  - 触发： 元数据写（kind=metadata）、文件写（rename/delete/move/copy/upload，kind=files）、人物写（kind=people）、专题写（kind=topics）。读端点不触发。

## 1. 既有端点（形状不变，仅内部实现/事件增强）

| 端点 | 方法 | 门禁 | 变更说明 |
|---|---|---|---|
| `/api/auth/verify` | POST | - | 不变（`{code, device_name?, device_id?, peer_server?}` → `{success, token?, expires_in?, server_name?}`） |
| `/api/auth/logout` | POST | token | 不变 |
| `/api/browse?path=` | GET | token | **修复**：DB 查询以当前共享根为界——返回条目的绝对路径不落在当前共享根下（索引属旧根）时弃用 DB 结果、走 FS 回退（与 all_image_folders 回退行为对齐）。响应形状不变（`{current_path, folders[], images[], allow_edit, allow_upload}`） |
| `/api/palette?path=` | GET | token | 不变 |
| `/api/all_image_folders` | GET | token | 不变 |
| `/api/search?q=&scope=` | GET | token | 不变 |
| `/api/thumbnail?path=&size=&token=` | GET | token(query 可) | 不变 |
| `/api/image?path=&token=` | GET | token(query 可) | 不变 |
| `/api/devices` | GET | token | 不变 |
| `/api/heartbeat` | GET | token | 不变 |
| `/api/rename` | POST | allow_edit | 请求/响应形状**不变**；内部从裸 `fs::rename` 改道 `file_operations`（带 file_id 迁移与库联动）。成功后发 `data-changed{kind:"files"}` |
| `/api/file` | DELETE | allow_edit | `?path=` 不变；内部改道 `file_operations::delete_file`（同步删 file_index/file_metadata/colors）。成功后发 `data-changed{kind:"files"}` |
| `/api/upload` | POST | allow_upload | multipart（`file` + `target_dir`）形状**不变**；写文件后补入 file_index 索引（复用 `write_file_from_bytes` 的单文件增量路径），桌面 browse 立即可见。成功后发 `data-changed{kind:"files"}` |

`/api/rename` 请求/响应（现状照录）：

```jsonc
// 请求
{ "old_path": "dir/name.jpg", "new_name": "renamed.jpg" }   // 同目录内改名
// 200 响应（文件系统失败也是 200，success=false）
{ "success": true, "path": "dir/renamed.jpg" }              // path = 新的共享根相对路径
```

## 2. 新端点：元数据（tags / description / source_url）

### 2.1 `POST /api/metadata/batch` — 批量读

- 门禁： token（与 browse 同级，**不受 allow_edit 门禁**）。
- 请求：

```json
{ "paths": ["Apex/shot1.png", "鸣潮/a.jpg"] }
```

- 响应 `200`： `items` 与入参 `paths` **一一对应（同序、同数量）**；查不到元数据的 path 给空默认（`tags:[]`、`description:""`、`source_url:""`）；**绝不因个别 path 失败（不存在/越界）而整批报错**。

```json
{
  "items": [
    { "path": "Apex/shot1.png", "tags": ["fps", "四人"], "description": "...", "source_url": "https://..." },
    { "path": "鸣潮/a.jpg", "tags": [], "description": "", "source_url": "" }
  ]
}
```

- 服务端实现口径： path → `root_path.join(path)` 绝对化 → `generate_id` 得 file_id → core `get_metadata_by_ids`（单条 SQL `IN` 批查，无 N+1）→ 按入参序组装。越出共享根的 path 一律按空默认处理（不泄漏共享根外元数据）。

### 2.2 `PUT /api/metadata` — 单文件整行读改写

- 门禁： token + allow_edit（否则 403）。
- 请求： `patch` 三字段全可选，**缺省 = 不改**（`tags: null` 与字段缺省同义；`tags: []` 是显式清空）：

```json
{ "path": "Apex/shot1.png", "patch": { "tags": ["fps"], "description": "新描述", "source_url": "https://..." } }
```

- 响应 `200`： 更新后的完整条目（字段同 2.1 的 item）：

```json
{ "path": "Apex/shot1.png", "tags": ["fps"], "description": "新描述", "source_url": "https://..." }
```

- 服务端语义（**「不互吞」的服务端半边**）： 读旧行 → 只覆盖 patch 中出现的字段 → **整行写回**（`file_metadata` upsert 是覆盖语义，必须先合并再写；`ai_data`/`category` 等未入参字段原样保留）。行不存在时以空默认为底新建。
- 词表： patch.tags 中出现的新词并入**桌面**词表（`user_data.json` 的 `customTags` 并集后写回；桌面词表与安卓本地词表两套不混，D31 数据层铁律）。
- 事件： `data-changed{kind:"metadata"}`。
- 错误： 400（JSON 非法 / path 越出共享根）、401、403。对不存在于索引的 path 仍可写元数据（行以 path 哈希为 id 新建），与桌面 `db_upsert_file_metadata` 行为一致。

## 3. 新端点：people（人物）

### 3.1 `GET /api/people` — 读全部

- 门禁： token。
- 响应： core `persons.rs` 的 `Person` 模型 **camelCase 原样序列化**：

```json
{
  "people": [
    {
      "id": "person_某角色",
      "name": "某角色",
      "coverFileId": "a1b2c3d4e",
      "count": 42,
      "description": null,
      "faceBox": { "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.3 },
      "updatedAt": 1727000000000,
      "characterTagName": null,
      "characterTagIndex": null
    }
  ]
}
```

（`faceBox`/`description`/`updatedAt`/`characterTagName`/`characterTagIndex` 可为 `null`。`coverFileId` 是桌面 file_id，客户端如需显示头像应改用 `/api/thumbnail?path=` + 已知 path；`coverFileId` 仅作身份用。）

### 3.2 `PUT /api/person` — 重命名 / 换头像 / 改描述

- 门禁： token + allow_edit（否则 403）。
- 请求（除 `id` 外全可选，缺省 = 不改；整行读改写）：

```json
{ "id": "person_某角色", "name": "新名", "avatar_path": "Apex/shot1.png", "description": "新描述" }
```

- `avatar_path`： 共享根相对 path（**不是** file_id）——服务端内部换算成 `cover_file_id`（path 哈希），客户端永远只碰 path。换头像时旧 `faceBox` 一并清空（box 坐标属于旧头像）。
- 响应 `200`： 更新后的完整 Person（同 3.1 的 item 形状，不带外层包装）。
- 事件： `data-changed{kind:"people"}`。
- 错误： 404（人物 id 不存在）、400、401、403。

## 4. 新端点：topics（专题）

### 4.1 `GET /api/topics` — 读全部

- 门禁： token。
- 响应： core `topics.rs` 的 `Topic` 模型 **camelCase 原样序列化**（列表查询 `fileIds` 恒为 `[]`——成员走关联表懒加载，数量看 `fileCount`）：

```json
{
  "topics": [
    {
      "id": "k3j2h1g0f",
      "parentId": null,
      "name": "某专题",
      "description": null,
      "type": "TOPIC",
      "coverFileId": null,
      "backgroundFileId": null,
      "coverCrop": null,
      "peopleIds": ["person_某角色"],
      "fileIds": [],
      "sourceUrl": null,
      "createdAt": 1727000000000,
      "updatedAt": 1727000000000,
      "sourceType": null,
      "workName": null,
      "workNameCn": null,
      "fileCount": 12
    }
  ]
}
```

### 4.2 `POST /api/topic` — 建专题

- 门禁： token + allow_edit。
- 请求：

```json
{ "name": "新专题", "description": "可选", "parent_id": null }
```

- 响应 `200`： 新建后的完整 Topic（同 4.1 的 item 形状，不带外层包装；`id` 由服务端生成，形制对齐桌面端 9 位随机串）。
- 事件： `data-changed{kind:"topics"}`。

### 4.3 `DELETE /api/topic?id=<topic_id>` — 删专题

- 门禁： token + allow_edit。query 传 id（与 `DELETE /api/file?path=` 的 query 风格一致）。
- 响应 `200`： `{ "success": true }`（级联删 topic_files / topic_people，core `delete_topic`）。
- 事件： `data-changed{kind:"topics"}`。404（专题不存在）、401、403。

### 4.4 `POST /api/topic/members` — 归属调整（增）

- 门禁： token + allow_edit。
- 请求： `paths`（共享根相对 path 列表，服务端换算 file_id）与 `people_ids` 至少给一个，可同时给：

```json
{ "topic_id": "k3j2h1g0f", "paths": ["Apex/shot1.png"], "people_ids": ["person_某角色"] }
```

- 响应 `200`： `{ "success": true, "file_count": 13 }`（`file_count` = 调整后该专题的缓存成员数；纯加人物时也是调整后的 file_count）。
- 事件： `data-changed{kind:"topics"}`。404（专题不存在）、400（两个数组都缺省）、401、403。

### 4.5 `DELETE /api/topic/members?topic_id=&path=` / `?topic_id=&people_id=` — 归属调整（删单成员）

- 门禁： token + allow_edit。query 传 `topic_id` + 二选一（`path` 删文件成员 / `people_id` 删人物成员），对齐 core `remove_file_from_topic` / `remove_person_from_topic` 的单成员原语。
- 响应 `200`： `{ "success": true, "file_count": 12 }`。
- 事件： `data-changed{kind:"topics"}`。400（没给 path/people_id）、401、403。

## 5. 新端点：文件 move / copy

### 5.1 `POST /api/file/move`

- 门禁： token + allow_edit。
- 请求： `paths` 为待移动文件（共享根相对 path，可多个）；`target_dir` 为目标目录（共享根相对，与 upload 的 `target_dir` 同义同风格）：

```json
{ "paths": ["Apex/shot1.png", "鸣潮/a.jpg"], "target_dir": "收藏夹" }
```

- 响应 `200`： `items` 与入参同序一一对应；移动后新 path = `target_dir/<原文件名>`；目标已存在时该项失败（**不自动重命名、不覆盖**）：

```json
{
  "items": [
    { "path": "Apex/shot1.png", "success": true, "new_path": "收藏夹/shot1.png" },
    { "path": "鸣潮/a.jpg", "success": false, "error": "target already exists" }
  ]
}
```

- 服务端走 core `move_file` 原语（file_id 迁移 + file_metadata 迁移 + colors 迁移联动）。
- 事件： 整批处理完且**至少一项成功**时发一次 `data-changed{kind:"files"}`。

### 5.2 `POST /api/file/copy`

- 门禁： token + allow_edit。
- 请求： 同 5.1。
- 响应： 同 5.1 的 `items` 形状；**冲突时自动改名**（`name_copy.ext`、`name_copy2.ext`，对齐桌面 copy 行为），`new_path` 回传实际落盘路径。服务端走 core `copy_file` + 元数据/索引/colors 复制（`db_copy_file_metadata` 语义），副本在桌面库中立即可见且带原元数据。
- 事件： 同 5.1。

## 6. 事件汇总

| 事件 | payload | 触发端点 |
|---|---|---|
| `lan-share-devices-changed` | 无 | 既有设备上下线（不变） |
| `lan-share-peer-pairing` | `{host,port,accessCode,deviceName}` | 既有（不变） |
| `lan-share-data-changed` | `{"kind":"metadata"}` | PUT /api/metadata |
| `lan-share-data-changed` | `{"kind":"files"}` | /api/rename、DELETE /api/file、/api/file/move、/api/file/copy、/api/upload（成功时） |
| `lan-share-data-changed` | `{"kind":"people"}` | PUT /api/person |
| `lan-share-data-changed` | `{"kind":"topics"}` | POST /api/topic、DELETE /api/topic、POST /api/topic/members、DELETE /api/topic/members |

桌面 React 侧（阶段 2）监听 `lan-share-data-changed` 按 kind 分派回拉；Kotlin 侧（阶段 3+）作为客户端不监听桌面事件，写操作成功后以响应内的新 path/条目做本地乐观更新 + 重拉。

## 7. 错误码总表

| 状态码 | 场景 |
|---|---|
| 400 | JSON 非法、缺必填字段、path/target_dir 含 `..` 越权、两个成员数组都缺省等请求形状错误 |
| 401 | token 缺失/非法/过期 |
| 403 | allow_edit / allow_upload 门禁关闭（D32 默认全开，仅手动收紧时出现） |
| 404 | path / 人物 id / 专题 id 不存在 |
| 200 + `success:false` / item 级 `error` | 文件系统级失败（占用、权限、目标已存在等），沿用服务端现状不映射 5xx；批量端点逐项给结果不整批失败 |

## 8. M6b 契约补丁：AI 视觉计算端点（D36/D37）+ D40 读端点

> 版本： v1（2026-09-25，M6b 阶段 4/5 定稿）。新增端点**全部为纯计算/纯查询**——手机图字节过桌面内存可以，**落桌面索引/桌面库不行**（不复用 upload 的落盘路径）；不触发 `lan-share-data-changed` 事件。
> 临时文件例外： multipart 收到的图片字节为喂模型（`encode_image` 收路径）可写**系统临时目录**用后即删，不算落库。

### 8.0 通用约定

- 鉴权： Bearer token（同 §0）。
- 门禁： 本节端点**不受 allow_edit / allow_upload 门禁**（不写桌面库；D32 门禁语义只管桌面数据面）。
- 模型未就绪（未下载/加载失败/嵌入索引不存在）→ `503 {"error": "<中文原因>"}`——客户端据此置灰入口并提示。
- 图片字节输入统一 multipart 单文件字段 `file`（对齐 `/api/upload` 先例；`DefaultBodyLimit` 200MB 内）。

### 8.1 `POST /api/ai/wd14/classify` — WD14 标签推理（D37，纯计算）

- 请求： multipart `file`（图片字节）。
- 处理： 字节 → 临时文件 → `ClipModel::encode_image`（WD-EVA02-Large-Tagger-V3）→ probs 经 `TagMapper` 分流 → 删临时文件。general = category==0、character = category==4，按概率降序；character 附 `extract_work_name` 归组的作品名（无归组为 null）。阈值服务端固定 0.1（对齐桌面 `clip_get_detected_characters` 口径）。
- 响应 `200`：

```json
{
  "general_tags": ["1girl", "solo"],
  "character_tags": [
    { "tag": "角色名（作品名）", "score": 0.87, "work": "作品名" }
  ]
}
```

- 错误： 401、503（WD14 模型未就绪——需在桌面 AI 视觉面板下载并生成过模型文件）。

### 8.2 `POST /api/ai/clip/search_text` — 文本语义搜索（D36，纯查询）

- 请求：

```json
{ "query": "海边日落", "min_score": 0.2, "max_results": 100 }
```

- 响应 `200`： `hits` 按 score 降序，截断至 `max_results`（缺省 100，上限 500）；`path` 为共享根相对路径（§0 身份铁律同款不透明串）。

```json
{ "hits": [ { "path": "dir/a.jpg", "score": 0.83 } ] }
```

- 错误： 400（JSON 非法/query 空）、401、503（**该模型无嵌入索引**——需先在桌面 AI 视觉面板对当前库生成过嵌入；模型加载失败同 503）。

### 8.3 `POST /api/ai/clip/search_image` — 以图搜图（D36，纯计算）

- 请求： multipart `file`（查询图字节；查询向量**不入**嵌入索引）。
- 响应： 同 8.2 `hits`。
- 错误： 401、503（同 8.2）。

### 8.4 `GET /api/topic/members?topic_id=` — 专题成员枚举（D40）

- 门禁： token。
- 响应 `200`： `files` 为成员文件 path 列表（共享根相对）、`people` 为成员人物 id 列表——读 `topic_files` / `topic_people` 关联表（对齐 `set_topic_files` / `set_topic_people` 的写半边）。

```json
{ "files": ["dir/a.jpg"], "people": ["person_xxx"] }
```

- 错误： 401、404（专题不存在）。

### 8.5 `GET /api/people/members?person_id=` — 人物图片列表（D40）

- 门禁： token。
- 响应 `200`： `paths` 为关联该人物的文件 path 列表。桌面口径：遍历 `file_metadata.ai_data.faces[].personId == person_id` 的 file_id → `file_index` 反查 path（查不到索引的 file_id 跳过）。

```json
{ "paths": ["dir/a.jpg"] }
```

- 错误： 401、404（人物不存在）。空关联 → 200 空数组。

### 8.6 `GET /api/vocab` — 桌面词表读（D40）

- 门禁： token。
- 响应 `200`： `tags` 为桌面 `user_data.json` 的 `customTags`（与安卓本地词表两套不混，客户端只读作建议）。

```json
{ "tags": ["fps", "四人"] }
```

- 错误： 401。

### 8.7 错误码补录（叠加 §7 总表）

| 状态码 | 场景 |
|---|---|
| 503 | §8.1–8.3 的模型未下载/加载失败、嵌入索引不存在 |
