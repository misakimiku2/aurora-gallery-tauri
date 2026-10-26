# 图片编辑器 v3:PhotoCraft 引擎整体移植 — 设计方案

- 版本:v1.0(2026-10-25,分支 `feature/editor-v3`)
- 取代:已删除的《图片编辑UI设计.md》《图片编辑与封面合成-设计方案.md》(v2 世界,代码封存于 `archive/editor-v2`,不再参考)
- 状态:M0(引擎落地)实施中

## 0. 拍板记录(2026-10-25,用户确认)

| 决策项 | 结论 |
|---|---|
| 架构路线 | **引擎整体移植**:photocraft 的纯 Rust 引擎 crate 原样抄入,前端 React 重写 PS 风格 UI |
| 保存语义 | **Ctrl+S 覆盖原图(导出平面)+ 同目录 `<stem>.psd` 分层伴生;重开时优先恢复伴生** |
| 节奏 | **两期**:一期位图线(选区/画笔/渐变/模糊/裁剪/移动/吸管/抓手缩放+面板+保存),二期矢量线(钢笔/文字/形状/路径/自由变换) |
| 入口 | **Tab 内嵌**(像比较画布,右键图片→编辑) |
| 工具清单 | 用户指定 17 组 PS 工具(见 §4),超出部分引擎支持但 UI 不暴露 |

## 1. 来源与许可

- 来源:`C:\Users\misakimiku\Documents\photocraft-main`(workspace 0.15.1,2026-10 快照,非 git 仓库)
- 许可:MIT OR Apache-2.0(photocraft-vendor/ 下保留 LICENSE-MIT、LICENSE-APACHE、NOTICE、ATTRIBUTION.md)
- 禁忌:`docs/brand/` 的 ArtCraft 名称/logo 是商标,不引入
- 本地改动:仅 4 处(见 photocraft-vendor/README.md「本地改动」),引擎源码零改动

## 2. 架构

```
前端 React/TS(src/components/editor/)
  左工具栏 │ 三层画布(棋盘格/位图/overlay) │ 顶部选项条 │ 右侧四面板组
  工具交互状态机(TS,照 ui-egui 逻辑移植) + 视图变换 + overlay 绘制
        │ invoke: JSON 命令(批量化) / 回流: RGBA 字节(损伤矩形)
src-tauri/src/editor_cmds.rs(薄 Tauri 包装,~12 条 editor_* 命令)
editor/(aurora-editor 桥 crate,无 tauri 依赖)
  EditorManager:文档生命周期 · run 命令桥 · render_full/render_reduced · state
photocraft-vendor/(21 个引擎 crate,零 egui)
  engine(命令注册表) compose(CPU 合成) paint(笔刷) algo(选区/滤镜)
  doc(图层模型) ops(历史) vector text io psd format codecs …
```

### 2.1 引擎关键事实(已核验)

- 一切行为经 `Session::execute(&mut, id, params) -> Result<Value>`(`engine/src/lib.rs:692`),命令 schema 可自省(`commands::command_specs()`);
- 增量协议:`DocState.revision / view_revision / last_damage`(`engine/src/lib.rs:217-227`);
- 状态自省命令 `document.inspect`(`engine/src/inspect.rs`)一步给出图层树/历史/选区/通道/前后景色;
- 合成:`compose::render / render_reduced / render_reduced_damage / render_layer_in / thumbnail`;
- 实时笔迹:`brush_cmds::LiveStroke`(全公开;`doc` 字段即预览文档,`seed` 保证提交像素复用);
- 历史引擎侧已齐(整文档快照 + 瓦片 COW,默认 50 步);
- 选区=灰度 Surface;命令 `select.rect/lasso/magicWand…`,模式 replace/add/subtract/intersect。

## 3. 后端

### 3.1 photocraft-vendor(workspace 根 photocraft-vendor/Cargo.toml)

- 21 crate:geom color cms raster doc ops psd codecs raw affinity compose paint algo io text vector format plugins engine ipp;
- 未抄:ui-egui/gpu/apps/xtask/automation/testkit/tablet/heif;
- git 依赖钉版:craft-print、craft-docpath(storytold/craft-libs;拉取需本机代理 7897);
- dev 依赖开 opt-level=2(像素代码 debug 不可用,沿上游做法)。

### 3.2 editor/(aurora-editor)

`EditorManager{session: Session}` 单会话多文档;`open_bytes/open_path/new_document/close/run/render_full/render_reduced/state/documents`。
M0 集成测试 `editor/tests/bridge.rs`:new → setColors → select.rect → paint.stroke → 合成断言红笔/白底 → undo/redo → reduced → document.inspect → close。

### 3.3 src-tauri 挂接(M1)

`editor_cmds.rs` 薄包装注册进 `generate_handler!`:
`editor_open(path) / editor_run(docId, cmd, params) / editor_render(docId, {reduced?})`(原始字节 Response)/ `editor_state(docId) / editor_close` + 保存三兄弟(M3:`editor_save` 覆盖原图+PSD 伴生、`editor_export_as`、打开时伴生探测)。保存成功触发库重扫。

## 4. 前端(src/components/editor/)

- **工具栏**(PS 分组,长按弹子工具):移动/框选(椭圆)/套索/裁剪/吸管/画笔/橡皮/渐变(油漆桶)/模糊(锐化、涂抹)/钢笔族(二期)/文字族(二期)/路径选择(二期)/形状族(二期)/抓手/缩放 + 前/背景色芯片(X 换、D 复位)。
- **画布三层**:CSS 棋盘格;全分辨率离屏 canvas(损伤矩形 putImageData);overlay(蚂蚁线动画、笔刷圆环、框选/套索/裁剪预览)。Pointer pressure;滚轮绕指针 ×1.1 缩放;空格/中键平移;`[`/`]` 调笔径。
- **工具交互层**:每工具一个 TS 模块,命令映射(一期):move→layer.translate、marquee→select.rect、lasso→select.lasso、crop→image.crop、eyedropper→document.sampleColor+tools.setColors、brush/eraser/blur/sharpen/smudge→LiveStroke 桥、gradient→paint.gradient、bucket→paint.bucket。
- **右侧面板**:颜色;属性/调整/历史(16 调整层一键+history.selectState 回跳);导航器/信息;图层/路径(二期路径页)。
- **editorStore**:模块级 subscribe 单例(项目惯例);命令桥客户端 rAF 批量喂点。
- **快捷键**:V M L C I B E G R H Z + X/D + Ctrl+Z/Y/D + [ ]。

## 5. 里程碑与验收

- **M0**:vendor+editor crate+集成测试绿;本文档入库。✅ 标准:cargo test -p aurora-editor 通过。
- **M1**:编辑 Tab 入口+三层画布+缩放平移+图层面板(基础)/颜色/历史/导航器/信息;大图 render_reduced 首屏。验收:相册图打开、100%/缩放流畅、面板数据实时。
- **M2**:一期全部位图工具+蚂蚁线+选项条。验收:按 PS 口径手测每工具。
- **M3**:调整层+蒙版基础+快捷键+保存链路+vitest(视图变换/工具状态机/桥批处理)。**一期终验:修图→Ctrl+S→缩略图刷新→重开恢复图层。**
- **二期**(另立计划):钢笔族/文字族(IME)/形状族/路径面板/路径选择/自由变换/属性面板完整化。

### 5.1 M2 落地进度(2026-10-26,按切片提交)

| 切片 | 提交 | 内容 |
|---|---|---|
| 第一切片 | ebdd2f5→e815ade | 选框(矩形/椭圆)+真实轮廓蚂蚁线(移植上游 outline.rs)+吸管+工具单键 |
| 画笔族 | 6e7cc7f | brush/eraser/blur/sharpen/smudge 五工具端到端:LiveStroke/LiveDab 桥(stroke_begin/push/commit)+ damage 增量帧 + fromLive 零重渲染提交 + 补差帧;DabEffect+Send vendor 补丁 |
| 修缺陷 | 74a6742 / d0bb768 | 撤销画布不刷新(位图 effect 取消竞态)+ Ctrl+Z/Y 接线;live 描边悬空自愈(十余笔后永久失灵根因)+ 前端日志落盘修复(`__TAURI__` 开关+capabilities log:default) |
| 移动工具 | 858ca8c | 选区像素浮动移动(select.float 按下即切割/displayed 纯函数预览/Enter 落定一步 Move)+ 整层平移(layer.translate)+ 方向键微移(1px/Shift 10px) |
| 套索 | af72b75 | select.lasso 自由圈选(每事件采点/实线预览/<3 点=取消/Esc 取消/Enter 提交) |
| 单行列+四态 | 46f4f44 | select.rect line:row\|column(单行/单列选框,M 键四形态循环)+ 选项条选区四态(新选区/添加/减去/相交,修饰键优先且空选区降级) |
| 裁剪 | 180bdf5 | 拖框裁剪(image.crop,历史 Crop):框外遮罩+三分线+Enter/双击/✓ 提交+Esc 取消 |
| 渐变+油漆桶 | 52f3e07 | paint.gradient 拖线(Shift 45° 吸附/<2px 无操作/五样式选项条)+ paint.bucket 点击填充(容差滑杆/Alt 取色) |
| 长按弹层 | a7c261f | 选框工具长按 0.35s 弹出子形态(与右键等效) |

**架构要点(实现层沉淀)**:
- live 描边三段式协议:桥层 `stroke_begin/push/commit/cancel`;push 同帧返回 damage 矩形合成字节(16B 头);commit 回放 begin 原参数,引擎 `LiveCommit::matches` 命中(fromLive)零重渲染;补差帧兜 dab 收尾/点画。
- 移动/裁剪共用"纯函数预览+一条命令提交"模式:拖动中不入历史(桥 `move_frame`:float=`float_cmds::displayed`、layer=`layer_multi_cmds::moved`),抬起才提交。
- 前端 rAF 单飞泵:指针事件只积累,循环批量投递(描边 coalesced 全采样/移动取最新)。
- 引擎命令映射(一期已接):`paint.stroke`(brush/eraser,erase 参数)、`paint.blur/sharpen/smudge`(LiveDab,参数百分数)、`select.rect`(ellipse/line:row|column)、`select.lasso`、`select.float/drop`、`layer.translate`、`image.crop`、`paint.gradient`、`paint.bucket`。

**M2 验收(2026-10-26 实测)**:画笔/橡皮/模糊/撤销重做/快捷键/移动(选区像素+整层+方向键)/套索/裁剪/渐变/油漆桶/单行选框全部真机过;cargo 8 测试绿、vitest 231 绿、tsc 0。

**M2 已知裁剪(后续补)**:移动工具 Auto-Select/链接层扩散/Alt 复制移动;裁剪旋转/拉直/比例预设/画布外扩展;多边形/磁性套索;渐变 Live 图层模式;上游 G 键渐变/油漆桶同组循环(本版按 PS 惯例 K=油漆桶)。

### 5.2 M3 进度

- **保存链路(1676b63,2026-10-26)**:✅ 一期终验链路全通。`editor_save` = 平面导出覆盖原图(引擎 `apply_file_encoding` 按原编码质量回写 + `atomic_write` 原子写)+ 同目录 `<stem>.psd` 分层伴生;`open_path` 伴生探测优先(重开恢复图层,标题保持原图名);前端 Ctrl+S/保存按钮 → `aurora-editor-saved` 窗口事件 → App 清缩略图内存缓存(invalidateThumbnailCaches)+ 重扫当前视图。Rust 单测 + 一次性副本真机实测(原图覆盖/.psd 8.5MB/同秒重扫)。
- 待做:调整层/蒙版基础/快捷键补全;`editor_export_as` 已入库(前端 UI 后接)。
- **另存为 + 状态点(ff4ce61,2026-10-27)**:✅ `editor_save_as` 按新扩展名**真重编码**(jpg→png 产物是真 PNG,魔数测试钉死);PS 口径文档改绑新路径(此后 Ctrl+S 写新文件),平面格式自动带 .psd 伴生,psd 目标不重复写伴生;文件信息栏三段布局(文件名居中 + 状态圆点 橙=未保存/绿=已保存,引擎 dirty=revision>saved_revision);格式过滤器 PNG/JPEG/WebP/TIFF/PSD。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| LiveStroke IPC 延迟 | rAF 批量喂点;不行降级"抬笔见笔迹"(seed 复用保证无二遍渲染) |
| >4096 大图内存 | 首屏/导航器 render_reduced;100% 视口分块细节层(photocraft detail_plan 同思路)后置 |
| image 0.24/0.25 共存 | cargo 允许;后续统一 |
| craft-libs git 依赖拉取 | 本机代理 7897 + CARGO_NET_GIT_FETCH_WITH_CLI |
| vendor 升级 | 按清单重拷+重打 4 处补丁(README 有 procedure) |
