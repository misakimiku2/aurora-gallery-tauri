# Changelog: Updates from Code (generated from current code)

**生成时间**: 2026-01-11

## 概要
对 `memory/` 中文档做了一次代码驱动的同步更新，以保证文档以当前代码为准。

**修改文件**:
- `API_REFERENCE.md` ✅
- `MODULE_DISTRIBUTION.md` ✅
- `PROJECT_STRUCTURE.md` ✅
- `QUICK_REFERENCE.md` ✅
- `TECHNICAL_ARCHITECTURE.md` ✅

## 主要变更点（按代码引用）

1. tauri 桥接层（`src/api/tauri-bridge.ts`）
   - 修正 `scanDirectory` 签名为 `scanDirectory(path: string, forceRefresh?: boolean)`，并说明 `forceRefresh` 当前未转发给后端（保留以便未来扩展）。
   - 更新并记录 `getThumbnail` 的真实签名：
     `getThumbnail(filePath, modified?, rootPath?, signal?, onColors?) : Promise<string | null>`，说明：需要 `rootPath` 用于缓存路径计算（`${rootPath}/.Aurora_Cache`），返回值是经 `convertFileSrc` 的 URL 或 `null`；支持 `onColors` 回调与批量请求聚合（约 50ms）。
   - 新增并记录的函数：`getAssetUrl`, `readFileAsBase64 (-> Promise<string | null>)`, `getDominantColors`, `searchByColor`, `generateDragPreview`, `startDragToExternal`, `writeFileFromBytes`。
   - 标注 `ensureCacheDirectory` 为兼容适配器并已弃用（保留用于向后兼容）。
   - 人物数据库 API 的前端函数：`dbGetAllPeople`, `dbUpsertPerson`, `dbDeletePerson`, `dbUpdatePersonAvatar` 均存在并与代码一致。

2. Color extraction / Control APIs
   - `pauseColorExtraction` / `resumeColorExtraction` 返回类型修正为 `Promise<boolean>`（文档已同步）。

3. 文档结构
   - `PROJECT_STRUCTURE.md` 中 `memory/` 的文件列表已更新为当前存在的五个文档（`API_REFERENCE.md`、`MODULE_DISTRIBUTION.md`、`PROJECT_STRUCTURE.md`、`QUICK_REFERENCE.md`、`TECHNICAL_ARCHITECTURE.md`）。

4. 技术架构
   - 在 `TECHNICAL_ARCHITECTURE.md` 中补充了缩略图批量获取与缓存路径计算的说明（短时聚合窗口 ~50ms，缓存目录约为 `${rootPath}/.Aurora_Cache`，并说明 onColors 回调）。

## 下一步建议
- 请 review 我所做的改动（特别是 API 的返回类型和签名）并确认是否需要更详细的示例或参数说明。
- 如果希望我继续，我可以：
  - 将这些改动转换为一个 commit（包含改动说明）并准备 PR 文案；
  - 对文档进行拼写/格式化检查并统一样式（例如代码块风格、返回类型标注一致性）；
  - 扩展文档中缺少的示例（例如 `startDragToExternal` 的使用示例）。

---

如果你希望我把这些更改直接提交到分支，请告诉我目标分支名（或我可以创建一个新的 doc-sync 分支）。