# JPEG XL 和 AVIF 格式支持实现方案 (修订版 - 2026.02)

本方案记录了在 Aurora Gallery 中新增对现代图像格式 **AVIF** 和 **JPEG XL (JXL)** 支持的实现细节。针对 Windows 环境下的兼容性与性能需求，我们采用了 **“渐进式混合解码”** 架构。

## 1. 目标与挑战

- **AVIF**: 现代 Web 格式，压缩率高。Chromium (WebView2) 已原生完美支持，但 Rust 后端解码器高度依赖 C 语言环境 (dav1d)，在 Windows 分发时极易出现链接库错误。
- **JPEG XL (JXL)**: 下一代图像格式，性能优越。目前 WebView2 尚未原生支持，需要在后端进行并行转码方案。

## 2. 混合架构方案

### 2.1 依赖与特性配置 (`Cargo.toml`)
- **image**: 锁定在 `0.24` 系列。**故意禁用了后端 AVIF 特性**，以彻底解决 Windows 环境下的 C 库依赖风险。
- **jxl-oxide**: 引入纯 Rust 解码库，开启 `rayon` 特性实现自动并行化。

### 2.2 AVIF：前端辅助生成 (Frontend-Assisted Generation) 🌟
为了解决后端无法生成 AVIF 缩略图和主色调的问题，我们实现了“降级路径”：
1. **指令透传**: 后端 `get_avif_preview` 直接将文件流以 Base64 发送到前端。
2. **前端解码**: 利用 WebView2 的原生硬解能力，使用 `HTML5 Canvas` 进行二次处理。
3. **尺寸一致性**: 缩放逻辑严格遵循后端标准 —— **短边对齐 256px**，长边等比缩放。
4. **高质量渲染**: 启用 `imageSmoothingQuality = 'high'`，并以 `0.9` 的 JPG 质量编码。
5. **双向同步**: 
   - 前端提取感知颜色 (感知亮度加权的 RGB -> LAB)。
   - 调用后端 `save_remote_thumbnail` 命令，将生成的 JPG 缩略图和主色调数据同步回后端持久化。
6. **优势**: 彻底绕过 Rust C 库链接难题，同时由于 WebView2 的高性能，体验接近原生生成。

### 2.3 JXL：后端并行加速
针对 JXL 的复杂性，我们在后端实现了极致重负载优化：
- **并行解码**: 利用 `jxl-oxide` 的自动 Rayon 并行化。
- **并行转换**: 在像素缓冲区转换（`f32` -> `u8`）过程中使用 `rayon` 的 `par_iter`。

## 3. 性能与通信优化

- **字段映射统一**: 后端 `ColorResult` 使用 `#[serde(rename_all = "camelCase")]`，确保前端 `isDark`、`labL`、`labA`、`labB` 等驼峰命名数据能被正确解析。
- **缓存命中增强**: 前端生成的缩略图会保存路径至 `__AURORA_THUMBNAIL_PATH_CACHE__`，确保护理面板再次访问时无需重复生成。
- **并发限流**: 
    - **JXL**: 计入 `ACTIVE_HEAVY_DECODES` 并发统计，防止内存溢出。
    - **AVIF**: 属于“轻量透传”，不计入并发限额。

## 4. 关键文件变更记录

- **[main.rs](file:///src-tauri/src/main.rs)**: 整合 `save_remote_thumbnail` 接口。
- **[thumbnail.rs](file:///src-tauri/src/thumbnail.rs)**: 实现后端缩略图持久化与色彩扫描状态更新逻辑；修复了 `mut format` 警告。
- **[tauri-bridge.ts](file:///src/api/tauri-bridge.ts)**: 实现基于 Canvas 的 AVIF 生成器，整合短边 256px 缩放算法。
- **[color_db.rs](file:///src-tauri/src/color_db.rs)**: 清理大量 unused dead code，优化编译体积。

## 5. 预期效果

- **AVIF**: 解决 "Format not supported" 与缩略图缺失问题，显示质量清晰且比例正确。
- **JXL**: 满血并发支持，主色调提取速度极快。
- **维护性**: 消除所有编译告警，代码整洁符合 Rust 最佳实践。
