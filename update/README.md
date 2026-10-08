# 更新清单与发布流程（D50）

本目录的两个 JSON 是**桌面端与安卓端共用的更新清单**，同一个 schema、两条托管渠道：

| 渠道 | 清单 URL（免鉴权 raw 直链） |
|---|---|
| GitHub（第一路线） | `https://raw.githubusercontent.com/misakimiku2/aurora-gallery-tauri/main/update/android.json` |
| Gitee（GitHub 连不上时的降级路线） | `https://gitee.com/misakimiku2/aurora_gallery/raw/master/update/android.json` |

- 安卓：`update/android.json`（常量在 `kotlin-app/.../update/UpdateClient.kt`）
- 桌面：`update/desktop.json`（常量在 `src-tauri/src/updater.rs` 的 `GITEE_MANIFEST_URL`）

客户端行为：**先取 GitHub，3 秒内没成功就降级到 Gitee**（桌面端是 GitHub releases API 三条路全失败后才走 Gitee 清单）。
两份清单内容保持一致即可；APK/安装包本体各自放在对应平台的 Release 附件里。

## 一、字段说明

```jsonc
{
  "schema": 1,                  // 固定 1
  "platform": "android",        // android | desktop，仅作标注
  "version": "0.2.0",           // 必填。桌面与 CARGO_PKG_VERSION 比；安卓优先比 version_code
  "version_code": 2,            // 安卓必填（Integer 版本号，必须与 APK 的 versionCode 一致）
  "release_name": "v0.2.0",     // 弹窗标题右侧徽标，缺省补 "v" + version
  "release_notes": "",          // 更新内容，纯文本，\n 换行
  "published_at": "2026-09-28", // 展示用日期字符串，不参与比较
  "min_version_code": 1,        // 预留，当前客户端未使用
  "homepage": "",               // 「下载页」按钮的目标（建议填 Gitee releases 页）
  "assets": [{
    "kind": "apk",              // apk（安卓）/ installer（桌面）；客户端优先挑这两个 kind
    "name": "AuroraGallery-v0.2.0.apk",
    "url": "https://gitee.com/.../download/v0.2.0/AuroraGallery-v0.2.0.apk",      // 主下载地址
    "fallback_url": "https://github.com/.../download/v0.2.0/AuroraGallery-v0.2.0.apk", // 主地址失败时重试
    "size": 0,                  // 字节数，进度条分母；0 也能跑（只显示已下载量）
    "size_text": "",            // 可选，覆盖 size 的展示（如 "22.7 MB"）
    "sha256": ""                // 预留，当前未校验
  }]
}
```

## 二、发一次版本要做的六步

1. 改版本号：`kotlin-app/app/build.gradle.kts` 的 `versionName` + `versionCode`（两者都要改，
   安卓判定优先用 `versionCode`）；桌面是 `src-tauri/Cargo.toml` 的 `version`。
2. 出包：安卓 `assembleRelease` 得到 APK；桌面 `tauri build` 得到安装包。
3. **两个仓库各建一个同名 Release**（tag 建议 `v0.2.0`），把安装包作为附件上传：
   - Gitee：`https://gitee.com/misakimiku2/aurora_gallery/releases`
   - GitHub：`https://github.com/misakimiku2/aurora-gallery-tauri/releases`
   附件 URL 形如 `.../releases/download/v0.2.0/<文件名>`（Gitee 与 GitHub 同形）。
4. 按上表改本目录的清单：`version`/`version_code` 填新值、`assets[].url` 填 Gitee 附件地址、
   `assets[].fallback_url` 填 GitHub 附件地址、`release_notes` 写更新内容。
5. **提交到两个仓库**，并且推到清单 URL 指向的分支（GitHub `main`、Gitee `master`）。
   只在一条渠道更新是不够的——另一台网络的机器会从另一条渠道取。
6. 自验（PowerShell 里用 `curl.exe`，别用别名 `curl`）：

```powershell
curl.exe -s "https://gitee.com/misakimiku2/aurora_gallery/raw/master/update/android.json"
curl.exe -s "https://raw.githubusercontent.com/misakimiku2/aurora-gallery-tauri/main/update/android.json"
```

   Gitee 会 302 到真实文件、GitHub 直接返回内容，两者都应输出上面那份 JSON。
   若 Gitee 返回 HTML 登录页，说明仓库变成了私有——公开 raw 才免鉴权。

   **Release 正文也要回读**（写进去 ≠ 写得对）：`scripts/publish-gitee.mjs` 跑完会自己比对
   正文首行，不符就中止报错。手工核对时注意——PowerShell 的 `Invoke-RestMethod` 按单字节
   解码 Gitee 的响应，中文一律显示成乱码（`发布于` → `åå¸äº`），**这是假警报**；
   用脚本或 Node 的 `fetch` 读 `repos/{repo}/releases/tags/<tag>` 的 `body` 才作准。

## 三、已知坑

- **分支名**：两个清单 URL 里写死了分支。换默认分支只改代码常量即可，别忘同步这个文档。
- **缓存**：客户端请求带了时间戳参数 + `Cache-Control: no-cache`，但公司代理仍可能缓存；
  实测清单不生效时用带 `?t=<毫秒>` 的 URL 在浏览器里先验证。
- **GitHub raw 在国内常不通**：这正是降级策略存在的原因，表现为「检查更新」多等约 3 秒后
  走 Gitee，属预期行为。
- Gitee 的 releases **OpenAPI**（`/api/v5/repos/.../releases/latest`）需要 access_token，所以
  代码刻意不用它——清单只走 raw；别把它「优化」回 API。
