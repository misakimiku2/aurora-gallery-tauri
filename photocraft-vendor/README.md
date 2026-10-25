# photocraft-vendor

[PhotoCraft](https://getartcraft.com)(Rust 复刻的开源 Photoshop)引擎层的 vendored 副本,
是 aurora-gallery-tauri 图片编辑器(v3)的核心。**引擎 crate 原则上不改内部代码**;
所有本地改动记录在下面「本地改动」一节。

- 来源快照:`C:\Users\misakimiku\Documents\photocraft-main`(workspace version **0.15.1**,抄入日期 2026-10;上游目录非 git 仓库,无 commit 哈希可引用)
- 许可证:**MIT OR Apache-2.0**(见 `LICENSE-MIT`、`LICENSE-APACHE`、`NOTICE`、`ATTRIBUTION.md`)。在本仓库的派生使用需保留这些声明;`docs/brand/` 的 ArtCraft 名称/logo 商标不随代码授权,不要引入。
- 工具链:edition 2024 / rust-version 1.95(本机 rustc 1.98.1 可用)。

## 抄入了什么(22 个 crate,引擎闭包全集)

`geom color cms raster doc ops psd codecs heif raw affinity compose paint algo io text vector format plugins engine ipp` + 本 workspace 根。

`io` 是文件格式聚合层(拖 raw/affinity/heif 进闭包);`engine` 是命令注册表(100+ JSON 命令);
`compose` 是 CPU 合成器;其余见各自 crate 头注释。

**未抄入**:`ui-egui`(egui 界面层——由前端 React 重写)、`gpu`(wgpu 合成器)、
`apps/*`、`xtask`、`automation`、`testkit`、`tablet`。

两个外部 git 依赖保持上游钉版:`craft-print`、`craft-docpath`(storytold/craft-libs)。

`assets/` 只保留 `fonts`(text build.rs 与 io 的编译期嵌入,必需)、`dict`(spell.rs 静态词典,必需)
与 `icons`(Lucide,ISC);上游的 `app-icon` 是 ArtCraft 商标物,已剔除不引入。

## 本地改动(相对上游快照)

1. **workspace 根**:新建本 `Cargo.toml`(上游根的裁剪版:`[workspace.package]` 四个继承键、
   `[workspace.dependencies]` 只保留闭包用到的条目、`[workspace.lints]`、dev 依赖优化 profile)。
2. **engine/algo/io**:删除 dev-dependencies 里的 `photocraft-testkit`(未抄入)。
3. 除此之外 crate 源码与各自 Cargo.toml 零改动。

## 升级 procedure

上游出新版时:按同清单重拷 `crates/`,重新应用上述 4 处改动,`cargo check` 过即可。
若上游 crate 的 `[dependencies]` 引用了新 crate,同步更新 workspace 根依赖表。

## 引擎桥接注意

- 命令执行入口:`photocraft_engine::Session::execute(&mut self, id, params) -> Result<Value>`。
- 增量协议:`Session::active() -> &DocState` 的 `revision` / `last_damage` / `view_revision`。
- 实时笔迹:`photocraft_engine::brush_cmds::LiveStroke`(全公开,`doc` 字段即预览文档)。
- 合成:`photocraft_compose::{render, render_reduced, render_reduced_damage, render_layer_in, thumbnail}`。
