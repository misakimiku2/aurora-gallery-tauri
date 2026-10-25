# Vendored: PhotoCraft crates (geom / cms / color / raster)

来源：[storytold/photocraft](https://github.com/storytold/photocraft) **v0.15.1**（本地评估副本
`photocraft-main`），双许可 **MIT OR Apache-2.0**（LICENSE-MIT / LICENSE-APACHE 随附）。

## 为什么 vendor 而不是 git 依赖

1. 构建环境对 github.com 的可达性不稳定——vendor 后离线可构建、版本钉死；
2. 只需要这 4 个 crate（合成核心的地基），vendor 集合最小；
3. 上游仍在快速演进（early alpha），pin 到我们逐行评估过的版本最稳。

## 相对上游的改动

- **只改了各 crate 的 `Cargo.toml`**：去掉 `*.workspace = true` 继承（脱离上游 workspace 需要），
  依赖改成具体版本/path；`cms`/`color` 裁掉了 dev-dependencies（`moxcms`，仅上游对比测试用）。
- **`src/` 全部原样未动**。上游源文件没有逐文件许可头，合规依据 = 本目录的 LICENSE-MIT /
  LICENSE-APACHE 全文 + 本 README（MIT 要求保留版权与许可声明，随附即满足）。

## 与本项目的关系

- `editor-engine`（仓库根，path 依赖）在 Photocraft 的 `Surface`（RGBA8 瓦片 COW）与
  `photocraft_color::blend`（33 档混合）之上构建编辑器的 Rust 合成核心；
- 缓冲口径：**RGBA8 非预乘 sRGB 存储 + 合成期 f32 算术**，与我们现有 u8 管线逐位兼容；
- 后续若需要 `paint`（笔刷引擎）或 `psd`（互操作），按同样方式 vendor。
