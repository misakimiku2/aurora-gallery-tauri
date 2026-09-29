# React/Tauri 安卓版退役残留清单

> 版本 v1.1（2026-09-29 盘点，**同日复核修订**）｜**只盘点、不改代码**
> 盘点基线：`git rev-parse --short HEAD` = `c2a258212`（工作区另有未提交改动，见 §2 注 ②）
> 口径：安卓唯一出货线是 `kotlin-app/`（v2.0 / versionCode 2 / 2026-09-29 发布，包名 `com.aurora.gallery.kotlin`）；
> 桌面端 `src/` + `src-tauri/`（2.0.0）仍在正常出货，**不是**残留。
>
> v1.1 相对 v1 的修订：更正 `isAndroid*` 与 `android_media_store` 的计数（v1 低估约 30%）、
> `bundle.android.versionCode` 现值、`useLongPress` 的归类依据（`零引用 ≠ 属于安卓`），
> 补 Kotlin 源码内陈旧指向与 §5 验收门的前置条件。所有改动均经行号级复核。

## 0. 先摆前提：这件事 D42=a 已经拍过板

M7 验收清单里明确登记（`docs/Android/Kotlin版/M7对齐验收任务清单.md:17`、`:51`、`:61`）：
桌面 React 版的 `isAndroid` 运行时分支**不做代码级清理**，理由是"桌面构建里它们是死代码，删除要动 30+
共享文件、回归风险与收益不成比"；退役提交 `975e0dda1`（2026-09-26）执行的就是这一案。

所以本清单**不推翻该决定**，只把"还剩什么、每块动它的代价与牵连"登记清楚，将来真要清时不必重新摸底。

## 1. 已随 D42 删除的（勿重复盘点）

`scripts/android-dev.mjs` / `android-dev-reuse.mjs` / `android-deploy-extra.mjs` / `android-scroll-probe.sh`、
`package.json` 里对应三条 script、`src-tauri/gen/android/`（77 个跟踪文件）、`src-tauri/.cargo/config.toml`
的安卓 linker 段。`com.aurora.gallery` 停止发版。

## 2. ① 零风险可删：桌面不可达 + 全仓零引用

| 条目 | 删除证据 | 归属证据（凭什么算安卓残留） |
| --- | --- | --- |
| `src/components/android-server/AndroidLanServerPanel.tsx` 全文 | grep 除自身外零引用 | 目录与文件名含 `android`；面板监听 `lan-share-android-status-changed`，服务已停发的安卓壳 |
| `src/components/android-client/AndroidClientPanel.tsx` 全文 | 零引用。**同目录 `androidClientApi.ts` 是活的，别一起删**（见 §3） | 文件名含 `android`，同为安卓壳面板 |
| `src/hooks/useLongPress.ts` | 零引用 | **存疑**：全文无安卓字样，是通用 `TouchEvent` 长按 hook（桌面触屏亦可复用）。零引用只证明"可删"，不证明"归属安卓"，见注 ① |
| `src-tauri/Cargo.toml:111-121` 四条 `[target.*-linux-android] linker` | Tauri 安卓构建链已删；Kotlin 的 `.so` 走 `core/` + cargo-ndk，`core/Cargo.toml` 无此段照样构建成功 | 目标三元组 `*-linux-android` 即安卓专属 |
| `tauri.conf.json` 的 `plugins.android`、`bundle.android{minSdkVersion,versionCode}` | `plugins.android` 不是 Tauri 2 合法插件键（Tauri 2 无此插件标识符），已 inert；`bundle.android` 只服务已停发的安卓壳（versionCode 2 是发布时"纯对齐"改的，见提交 `6f3ec29f2` ①） | 键名即安卓；`bundle.android` 对应已停发的 `com.aurora.gallery` 壳 |

注 ①：`useLongPress.ts` 删掉本身零风险，但若将来做 Windows 触屏手势支持，它是现成实现。把它归进"安卓残留"仅凭"当时同批引入"的判断，**无代码级证据**——本表其余四条的归属均有命名/目标三元组可证，唯此条没有。
注 ②：`bundle.android.versionCode` 在 HEAD（`c2a258212`）是 **2**；当前工作区未提交改动已随 `version` 2.0.0→**2.1.0** 一并改为 **3**（下一次发布同样的"纯对齐"）。**清单数字一律以 HEAD 为准**，复核时先 `git status` 看有没有在途 bump。

## 3. ② 看着像残留、其实是活的 —— **勿删**

这一节是最容易误伤的地方，八处：

1. **`src/lan-share/` 整目录**：手机浏览器打开桌面 LAN 地址时加载的就是它。桌面 Rust 用
   `include_str!` 把 `static/lan-share/{index.html,style.css,app.js}` 内嵌进二进制
   （`src-tauri/src/lan_share/server.rs:24-26`，路由 `:126-128`），构建入口 `vite.config.lan-share.ts`。
   Kotlin 侧**没有 WebView**（全原生 Compose），所以它不依赖安卓壳。附带纠正：我原先担心"手机浏览器里
   `isAndroid*` UA 嗅探会误翻成安卓分支"——不成立，`src/lan-share/` 完全不 import `androidPlatform`，
   只有 `api.ts:174-245 getDeviceName()` 自己读 UA 给设备命名，那也是活逻辑。
2. **`src/components/android-client/androidClientApi.ts`、`src/hooks/useAndroidClient.ts`**：桌面 → 手机的
   反向控制客户端（对端是 Kotlin 的 `LanServerHttp.kt`），设置面板「已连接设备」列表在用
   （`LanSharePanel.tsx:324-328`、`App.tsx:853,908`、`useAndroidClient.ts` 在 `App.tsx:788` 无条件挂载）。
3. **`src/components/lan-client/NetworkSection.tsx`**：桌面侧栏渲染手机文件夹树时用到（`TreeSidebar.tsx:1732`）。
4. **`=== 'android_media_store'` 判定群**（`App.tsx:722`、`FileGrid.tsx:132/168/1112`、`OverviewBar.tsx:25`、
   `thumbnail.ts:291` 等**实测 22 处**，v1 记"约 15 处"偏低）：**不是平台判定**，
   是"桌面正在浏览手机图库"的资源根标记，桌面完全可达。其余落在 `FileListItem.tsx:41`、
   `FoldersOverview.tsx:110/483`、`FolderThumbnail.tsx:61`、`ImageThumbnail.tsx:53`、`TopicModule.tsx:216/1958`、
   `useAppInit.ts:108/164/165/532/536`、`useNavigation.ts:174`、`usePersonTopicHandlers.ts:138/165`、
   `folderThumbnailPrefetch.ts:71`。
5. **`android_apk_download_url`**（`update_commands.rs:70` + `updater.rs:473,601,620`）：注册在**桌面** handler
   （`lib.rs:2048`），服务桌面欢迎页与设置面板的扫码下载；`update/android.json` 同时是 Kotlin
   `UpdateClient.kt:34` 的清单源。今天新加的 `AndroidDownloadCard` 走的就是它。
6. **`src/api/tauri-bridge/window.ts:61 captureWindowSnapshot`**：名字在安卓语境里，实为 `#[cfg(windows)]`
   桌面命令（`window_commands.rs:137`，非 Windows 返回 Err），桌面在 `App.tsx:1783` 调用（经 `App.tsx:11` 导入）。
7. **`core/` 整 crate、`kotlin-app/`、`scripts/kotlin-dev.ps1`、`adb-connect.ps1`、`gen_android_icons.py`**：
   Kotlin 线的构建与调试链路，正常在跑。
8. **`src-tauri/src/lan_share/{types,session,device_manager}.rs`**：平台无关，桌面 handler 直接依赖
   （只有 `handlers/server` 是 `#[cfg(not(android))]` 桌面专属）。

## 4. ③ 要动就得重新拍板：体量大 / 有牵连

- **`src-tauri/src/android/` 全目录 3,466 行**（`media_store.rs` 833、`server/handlers.rs` 609、
  `server/media_store.rs` 581、`thumbnail.rs` 376、`image_preview.rs` 328、`lan_server_commands.rs` 233、
  `server/server.rs` 286 等）+ `lib.rs` 内 **77 处** `#[cfg(target_os = "android")]` 块
  （含 `:2095-2201` 那份 104 行的安卓 `invoke_handler`）+ 两个 JNI 导出
  （`lib.rs:601/624/647` 的 `Java_com_aurora_gallery_ColorExtractionService_native*`、
  `android/lan_server_commands.rs:226` 的 `..._nativeStopLanShare`）。
  删除后桌面构建不再产安卓壳，风险可控但要过一遍 `cargo check` + 桌面冒烟。
- **`Cargo.toml:91-97`** 的 `[target.'cfg(target_os = "android")'.dependencies]`（jni / ndk / ndk-sys /
  ndk-context / flate2）。
- **`src-tauri/capabilities/default-android.json`** 整份（`platforms: ["android"]`，对应已停发的 `com.aurora.gallery`）。
- **`scripts/adb-logcat.ps1` / `-backend.ps1` / `-frontend.ps1`**：三处 `pidof com.aurora.gallery`（各 `:59`）
  加 `aurora_gallery_lib` / `Tauri/Console` tag —— 现役 Kotlin 包名是 `com.aurora.gallery.kotlin`，
  这三个脚本**现在就已经抓不到东西**了，属于"要么改指向 Kotlin 线、要么删"。
- **`src/` 里 `isAndroid*` 出现处实测 101**（`isAndroidPlatformCached` 63 / `isAndroidSync` 38 /
  异步 `isAndroidPlatform` 11；已去重——排除 `isAndroidPlatform` 对 `isAndroidPlatformCached` 的子串重叠，
  并剔除定义文件 `src/utils/androidPlatform.ts` 自身与两处 `__tests__` 的 `vi.mock`）。
  ⚠️ **v1 记为"约 70 处（48/20/5）"，低估约 30%，v1.1 已更正。** 复核口径见 §6。
  按性质分：v1 的"约 45 处删掉即等价 `false`、约 25 处需逐条确认"**未按 101 的新口径重新逐条复核**，
  按同比例外推约为 **65 / 36——这是估算，不是实测**。真要动手必须先实测分类，别拿外推数排期。
  需逐条确认的那类含桌面可见的尺寸/样式差异（`TreeSidebar` 行高、`SettingsModal` 按钮高度、
  `TabBar`、`AnnotationLayer`…）或是 `!isAndroid` 反向守卫（`ViewerPane.tsx:69`、`ContextMenu.tsx:244/581`）。
  **这一整块就是 D42=a 明确不做的那块**，重开需要新理由。
  触发条件（v1.1 补记，供将来重开时对照）：目前尚无任一条件成立——① 桌面包体需要显著瘦身；
  ② 要接入第三个平台导致平台判定模型重写；③ `isAndroid*` 分支本身引发过线上缺陷。
  三者皆无，则维持 D42=a 不动。
- **`android/server/handlers.rs`、`android/server/media_store.rs`**：Kotlin 侧 `LanServerHttp.kt:17`、
  `LanMediaSource.kt:17` 注释自称与之"逐字对齐"，删掉就失去参照实现。建议留到最后，或先把基准说明
  迁进文档再删。
- **文档/CI 里的陈旧指向**：`docs/Android/Android版本开发记录.md:265-271,522,717-720,1525`、
  `docs/Android/android-native-viewer.md:238,257`、`plan/PHASE1_DETAILED_PLAN.md:237-240`、
  `.github/workflows/ci.yml:34`（注释仍称 `.cargo/config.toml` 含 NDK 绝对路径，该文件已删；
  该 `rust` job 本身已整段注释、当前 CI 不执行，风险低于另外几条）。
- **Kotlin 源码里的陈旧指向**（v1 漏登记，v1.1 补）：`kotlin-app/` 内 **7 处** "WebView" 历史对照注释
  ——`viewer/NativeGalleryView.kt:57,60,2253,2316`、`ui/components/TreeSidebar.kt:117`、
  `viewer/dialogs/DeleteConfirmDialog.kt:13`、`viewer/dialogs/FolderPickerDialog.kt:36`、
  `viewer/ViewerLayer.kt:20`。均为"UI 与 WebView 版一致""覆盖在 WebView 之上"一类对齐说明。
  已核实**不含** `android.webkit` import——Kotlin 侧确无 WebView，§3.1 结论成立；
  另 4 处 `androidx.compose.ui.viewinterop.AndroidView`（`CanvasHost.kt:9`、`FileGrid.kt:31`、
  `FoldersOverview.kt:46`、`ViewerLayer.kt:11`）是 Compose 包装原生 View，与 WebView 无关，**勿误删**。
  要清"陈旧指向"应与文档类一并登记。

## 5. 真要动手时的批次与验收门

**前置条件（两批都要，v1 漏记）**：`src-tauri/static/lan-share/` 被 `.gitignore:46` 排除、**不入库**，
而 `src-tauri/src/lan_share/server.rs:24-26` 用 `include_str!` 内嵌其中的 `{index.html,style.css,app.js}`。
所以**裸 `cargo check` 在干净克隆上必然失败**——先跑 `npm run build:lan-share`
（或走 `npm run tauri:build`，其 `beforeBuildCommand`/`beforeDevCommand` 已含该步），再执行下面的门。
本机当前产物存在（app.js 215KB / index.html 435B / style.css 149KB，2026-09-29 04:02），故不影响本机验证。

1. 先 §2 零风险项（3 个文件 + Cargo linker 段 + 两个 conf 字段）。门：`npx tsc --noEmit` +
   `npx vitest run`（当前 81 用例，v1.1 实测复核一致）+ `cargo check` + `npm run build` + 桌面冒烟三处
   （设置-局域网共享、欢迎向导第 4 步、手机浏览器打开 LAN 地址）。
2. §4 的 Rust 大块单独一批，门同上再加桌面全功能冒烟。
3. 脚本与文档修订可并入任一批。
4. `useLongPress.ts`（§2 注 ①）建议单拎出来最后删：它是本表唯一归属存疑项，且是唯一有"将来可能复用"价值的。

纪律沿用 M7 清单 `:61`：每一笔删除都要能回答「桌面构建/运行是否受影响」。

## 6. 盘点方法（便于复核）

`grep -rn "isAndroidPlatformCached\|isAndroidSync\|isAndroidPlatform" src`、
`grep -rn 'cfg(target_os = "android")' src-tauri/src`（**全仓 84 处，其中 `lib.rs` 独占 77 处**，另 7 处散在其他文件）、
`wc -l src-tauri/src/android/**/*.rs`（3,466 行 / 11 个文件）、`git show --name-status 975e0dda1`（退役实体盘点）、
`node -e` 读 `update/android.json` 与 `src-tauri/tauri.conf.json` 的安卓字段。
零引用类条目均按"除自身文件外 grep 零命中"判定。

**计数口径（v1 就是栽在这里，v1.1 补）**：

1. `grep -o isAndroidPlatform` 会**子串命中** `isAndroidPlatformCached`，三者直接相加必然重复计数。
2. 需剔除定义文件 `src/utils/androidPlatform.ts` 自身（含 `_isAndroidCached` / `_isAndroidSyncCached` 等
   同样会被子串命中的内部变量）与 `__tests__` 内的 `vi.mock('../../utils/androidPlatform', ...)`。
3. 本次实测去重后：`isAndroidPlatformCached` 63 / `isAndroidSync` 38 / `isAndroidPlatform` 11。
4. 判定归属时另记住：**零引用 ≠ 属于安卓**（见 §2 注 ①）——前者是"可删性"，后者是"归属性"，两回事。
5. 复核前先 `git status`：本仓库常有在途的版本 bump（v1.1 复核时就撞上 2.1.0），会让 conf 字段类条目数字失真。
