# FFmpeg（运行时下载副本）· 来源与许可登记

> 登记时间：2026-10-15 · 相关代码：`src-tauri/src/ffmpeg_download.rs`、`src-tauri/src/ffmpeg_cover.rs`
> （目录名用 `licenses/`：Windows 文件系统大小写不敏感，根目录 `LICENSE` 文件会与 `license/` 冲突）

## 组件

| 项 | 值 |
|---|---|
| 组件 | FFmpeg / FFprobe（`ffmpeg.exe` / `ffprobe.exe`） |
| 许可 | **LGPL v3**（GNU Lesser General Public License v3） |
| 构建来源 | BtbN/FFmpeg-Builds，`win64-lgpl` 变体（**无 GPL-only 组件**） |
| 版本 | n9.0.2-17-g2a571b6068（2026-09-30 月末构建，保留期 2 年） |
| 获取方式 | **运行时按需下载**（用户点击「下载 ffmpeg」），**不随本应用安装包分发** |
| pin 常量 | `ffmpeg_download.rs`：`PIN_URL` + `PIN_SHA256`（171,535,354 字节） |

## 为什么是 LGPL

本应用为 MIT 许可。ffmpeg 的常见分发渠道（gyan.dev 等）多含 libx264/libx265 等 GPL 组件，
一旦捆绑分发将触发 GPL 传染。BtbN 的 `lgpl` 变体只含 LGPL 兼容依赖，且本应用仅用其
**解码 + 抽帧 + `-c copy` remux**（不调用任何 GPL 编码器）→ 无传染路径。

**严禁**：`ffmpeg-sidecar::auto_download()` 的默认源（gyan.dev = GPLv3）。

## 义务与履行方式

| LGPL 义务 | 履行 |
|---|---|
| 告知用户组件与许可 | 设置面板展示组件状态；安装目录生成 `SOURCE.txt`（来源 / 版本 / 校验状态 / 许可链接） |
| 保留版权与许可文本 | `SOURCE.txt` 含许可声明与 https://www.gnu.org/licenses/lgpl-3.0.txt 链接；本文件登记 |
| 允许替换库 | 运行时独立下载、不静态链接进应用、未修改二进制 → 用户可自由替换目录内 exe |
| 源码提供（仅当分发二进制） | **本应用不分发 ffmpeg 二进制**（仅指引下载）→ 不适用；若未来改为捆绑分发，必须随附完整 LGPLv3 文本并提供对应源码获取方式（BtbN 仓库 / ffmpeg.org） |

## 机器可读状态

- `install-info.json`（与 exe 同目录）：`source`（pinned/latest）、`url`、`verified`、`installedAt`、`version`
- `ffmpeg_status` 命令返回 `installSource` → 前端对「latest 回退（未校验）」显示警示

## 检查表（P1.5-B 实施计划 §8）

- [x] 只取 LGPL 变体（BtbN `win64-lgpl`），绝不混 gyan/GPL
- [x] 落盘保留来源 / 版本说明（`SOURCE.txt` + `install-info.json`），`licenses/` 登记（本文件）
- [x] 仅解码 + 抽帧（+ 可选 remux `-c copy`）→ 不依赖 GPL 编码器 → 无传染
- [x] URL 与 SHA256 pin 为代码常量（pin 需定期检查有效性——BtbN 月末构建保留 2 年）
