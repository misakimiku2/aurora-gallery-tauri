# React/Tauri 安卓版退役残留清单

> 版本 v1（2026-09-29 盘点）｜**只盘点、不改代码**
> 口径：安卓唯一出货线是 `kotlin-app/`（v2.0 / versionCode 2 / 2026-09-29 发布，包名 `com.aurora.gallery.kotlin`）；
> 桌面端 `src/` + `src-tauri/`（2.0.0）仍在正常出货，**不是**残留。

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

| 条目 | 证据 |
| --- | --- |
| `src/components/android-server/AndroidLanServerPanel.tsx` 全文 | grep 除自身外零引用 |
| `src/components/android-client/AndroidClientPanel.tsx` 全文 | 零引用。**同目录 `androidClientApi.ts` 是活的，别一起删**（见 §3） |
| `src/hooks/useLongPress.ts` | 零引用 |
| `src-tauri/Cargo.toml:111-121` 四条 `[target.*-linux-android] linker` | Tauri 安卓构建链已删；Kotlin 的 `.so` 走 `core/` + cargo-ndk，`core/Cargo.toml` 无此段照样构建成功 |
| `tauri.conf.json` 的 `plugins.android`、`bundle.android{minSdkVersion,versionCode}` | `plugins.android` 不是 Tauri 2 合法插件键，已 inert；`bundle.android` 只服务已停发的安卓壳（versionCode 2 是发布时"纯对齐"改的，见提交 `6f3ec29f2` ①） |

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
   `thumbnail.ts:291` 等约 15 处）：**不是平台判定**，是"桌面正在浏览手机图库"的资源根标记，桌面完全可达。
5. **`android_apk_download_url`**（`update_commands.rs:70` + `updater.rs:473,601,620`）：注册在**桌面** handler
   （`lib.rs:2048`），服务桌面欢迎页与设置面板的扫码下载；`update/android.json` 同时是 Kotlin
   `UpdateClient.kt:34` 的清单源。今天新加的 `AndroidDownloadCard` 走的就是它。
6. **`src/api/tauri-bridge/window.ts:61 captureWindowSnapshot`**：名字在安卓语境里，实为 `#[cfg(windows)]`
   桌面命令（`window_commands.rs:137`，非 Windows 返回 Err），设置弹窗截屏在用。
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
- **`src/` 里约 70 处 `isAndroid*` 分支**（`isAndroidPlatformCached()` 48 / `isAndroidSync()` 20 /
  异步 `isAndroidPlatform()` 5，统计口径与 grep 计数有 ±2 差）。按性质分：约 45 处删掉即等价 `false`、
  桌面零影响；约 25 处含桌面可见的尺寸/样式差异（`TreeSidebar` 行高、`SettingsModal` 按钮高度、
  `TabBar`、`AnnotationLayer`…）或是 `!isAndroid` 反向守卫（`ViewerPane.tsx:69`、`ContextMenu.tsx:244/581`），
  需逐条确认。**这一整块就是 D42=a 明确不做的那块**，重开需要新理由。
- **`android/server/handlers.rs`、`android/server/media_store.rs`**：Kotlin 侧 `LanServerHttp.kt:17`、
  `LanMediaSource.kt:17` 注释自称与之"逐字对齐"，删掉就失去参照实现。建议留到最后，或先把基准说明
  迁进文档再删。
- **文档/CI 里的陈旧指向**：`docs/Android/Android版本开发记录.md:265-271,522,717-720,1525`、
  `docs/Android/android-native-viewer.md:238,257`、`plan/PHASE1_DETAILED_PLAN.md:237-240`、
  `.github/workflows/ci.yml:34`（注释仍称 `.cargo/config.toml` 含 NDK 绝对路径，该文件已删）。

## 5. 真要动手时的批次与验收门

1. 先 §2 零风险项（3 个文件 + Cargo linker 段 + 两个 conf 字段）。门：`npx tsc --noEmit` +
   `npx vitest run`（当前 81 用例）+ `cargo check` + `npm run build` + 桌面冒烟三处
   （设置-局域网共享、欢迎向导第 4 步、手机浏览器打开 LAN 地址）。
2. §4 的 Rust 大块单独一批，门同上再加桌面全功能冒烟。
3. 脚本与文档修订可并入任一批。

纪律沿用 M7 清单 `:61`：每一笔删除都要能回答「桌面构建/运行是否受影响」。

## 6. 盘点方法（便于复核）

`grep -rn "isAndroidPlatformCached\|isAndroidSync\|isAndroidPlatform" src`、
`grep -rn 'cfg(target_os = "android")' src-tauri/src`、`wc -l src-tauri/src/android/**/*.rs`、
`git show --name-status 975e0dda1`（退役实体盘点）、`node -e` 读 `update/android.json` 与
`src-tauri/tauri.conf.json` 的安卓字段。零引用类条目均按"除自身文件外 grep 零命中"判定。
