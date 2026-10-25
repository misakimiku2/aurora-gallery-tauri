# 编辑器 v3:PhotoCraft 引擎整体移植方案

已拍板:①引擎整体移植(纯 Rust crate 原样抄入) ②Ctrl+S 覆盖原图+同名 .psd 分层伴生 ③两期走(位图线→矢量线) ④Tab 内嵌(像比较画布)。旧 v2 计划文件已删除作废,本方案全新起盘,不复用 archive/editor-v2 代码(仅必要时参考个别纯函数)。

## 一、总体架构

```
┌─ 前端 React/TS ────────────────────────────────────────────┐
│ 编辑器 Tab: 左工具栏 │ 中央画布(3层canvas) │ 顶部选项条 │ 右侧4面板组 │
│ 工具交互状态机(TS,照抄 ui-egui 逻辑) + 视图变换 + overlay 绘制 │
└──────────────┬─────────────────────────────────────────────┘
        JSON 命令桥(Tauri invoke,批量化) / RGBA 字节回流(损伤矩形)
┌──────────────┴─────────────────────────────────────────────┐
│ editor/(aurora-editor 新crate):Session管理·渲染桥·状态自省·LiveStroke桥 │
│ src-tauri/src/editor_cmds.rs:薄 Tauri 命令包装               │
├─────────────────────────────────────────────────────────────┤
│ photocraft-vendor/(原样抄入的 ~17 个引擎crate,零 egui 依赖):  │
│ geom color cms raster doc ops compose paint algo text vector │
│ io psd format codecs plugins craft-print                     │
└──────────────────────────────────────────────────────────────┘
```

关键事实(已核验):引擎全部行为经 `CommandSpec` 注册表以 JSON 进出(`crates/engine/src/commands.rs:132-201`),CLI/WASM 走同一入口;`DocState` 自带 `revision`/`last_damage` 增量协议(`crates/engine/src/lib.rs:217-227`);合成器有 `render_reduced_damage` 只重合成损伤矩形;许可证 MIT/Apache-2.0,抄代码合法。

## 二、后端工作项

1. **Vendor**:把 photocraft-main 的 crates/{上述17个} 抄到 `photocraft-vendor/crates/`,新建 `photocraft-vendor/Cargo.toml` 作为其 workspace 根(承接 `workspace = true` 继承:版本/edition 2024/依赖表,照抄其根 Cargo.toml 对应段落)。保留 LICENSE-MIT/LICENSE-APACHE/NOTICE 于 vendor 根,README 注明来源 commit。**先跑 `rustc --version` 确认 ≥1.95**(edition 2024),不足先 rustup 升级。`image 0.25` 与我方 0.24 共存,cargo 允许,后续再统一。
2. **`editor/` 新 crate(aurora-editor)**,不含 tauri 依赖,职责:
   - Session 生命周期(引擎 Session 本身多文档,每编辑 Tab 一个 docId);
   - 通用命令桥 `run(docId, cmd, params) -> {revision, damage, result}`;
   - 渲染桥:`render_full(docId, maxW/H)`(compose::render_reduced 供首屏/大图)与 `render_damage(docId)`(损伤矩形 RGBA,走 `tauri::ipc::Response` 原始字节返回,避免 JSON 数组开销);
   - 状态自省 `state_snapshot(docId)`:图层树/前后景色/历史列表/选区信息/文档信息(JSON,面板与信息栏数据源);
   - LiveStroke 桥 `live_begin/live_feed(批量点)/live_commit/live_cancel`(对应 engine `brush_cmds::LiveStroke`,画笔实时预览);
   - `selection_outline(docId)`:选区 Surface→蚂蚁线折线段(参考 `ui-egui/src/outline.rs:42`);
   - `layer_thumb(docId, layerId)`:图层面板缩略图;
   - 打开/保存:打开时若同目录存在 `<stem>.psd` 则开 PSD(恢复图层),否则开原图;`save(docId)`:引擎导出平面图覆盖原图(按扩展名定格式)+ 写 `<stem>.psd`;`export_as(docId, path, format, quality)` 另存为。
3. **`src-tauri/src/editor_cmds.rs`** 薄包装 + generate_handler 注册(约 12 条 editor_* 命令),保存成功后触发库重扫复用现有扫描链路。

## 三、前端工作项(src/components/editor/)

1. **入口**:useTabHandlers 新增 editor Tab 类型;图片右键菜单(库网格+查看器)加"编辑";Tab 名用图片名。
2. **EditorShell**:左工具栏(PS 分组+长按弹出子工具+前/背景色芯片,X 换 D 默认)/顶部选项条(随工具切换:笔刷大小·硬度·不透明度·流量,选区羽化,容差,渐变样式,裁剪比例…)/中央画布/右侧面板。深色主题同 photocraft 截图风格。
3. **画布(三层)**:CSS 棋盘格底层 + 全分辨率离屏 canvas(损伤矩形 putImageData 增量更新) + overlay canvas(蚂蚁线动画、笔刷圆环光标、框选/套索/裁剪框/形状/钢笔路径预览、移动虚线框)。Pointer 事件含 pressure;滚轮缩放(绕指针×1.1)、空格/中键平移、抓手/缩放工具。笔径 [ / ] 快捷键(照用户习惯)。
4. **工具交互层(tools/,TS)**:每工具一个模块,逻辑照 photocraft ui-egui 对应文件移植:
   - 一期:移动(move_ui.rs→layer.translate+选区浮动)、框选矩形/椭圆(select.rect)、套索(select.lasso)、裁剪(遮罩叠层+image.crop)、吸管(sampleColor+tools.setColors+取样环)、画笔/橡皮/模糊/锐化/涂抹(LiveStroke 桥+圆环光标)、渐变(paint.gradient 五样式)、油漆桶(paint.bucket)、抓手/缩放;
   - 二期:钢笔族5子工具(path.addAnchor/deleteAnchor/convertPoint…)、路径选择/直接选择、形状族5种(shape.create)、文字族(type.create 横/直排+蒙版;画布内嵌编辑,隐藏 textarea 承接中文 IME)、自由变换 Ctrl+T。
5. **右侧面板(panels/,自上而下)**:颜色(HSV 域+色带+RGB/Hex,前/背景色);属性/调整/历史(调整=16 种调整层一键创建,属性随目标显示参数控件,历史=列表点击回跳 history.selectState);导航器/信息(缩略图+视口红框+缩放滑杆;指针坐标/颜色读数/选区 W/H/文档尺寸);图层/路径(混合模式27种+不透明度+可见性+锁+蒙版+缩略图+拖拽排序;路径面板二期)。
6. **editorStore**:模块级 subscribe 单例(项目既有模式),持当前工具/选项/视图变换/revision;命令桥客户端封装自动批处理(每 rAF 合并 pointer moves,对齐 photocraft pointer_moves 合帧策略)。
7. **快捷键**:PS 键位(V M L C I B E G R P T A U H Z、X/D、Ctrl+Z/Y/D、[ ])。

## 四、里程碑(每步独立可验证,feature/editor-v3 分支)

- **M0 引擎落地**:vendor 抄入+workspace 接好+`cargo check` 通过;editor crate 打开图→run 一条命令→渲染出位图(先写个最小桥集成测试:fixture PNG→select.rect→paint.stroke→render 断言像素变化)。同时写设计方案文档 `docs/编辑器v3-photocraft引擎移植-设计方案.md` 并提交。
- **M1 壳与显示**:编辑 Tab 入口、三层画布+视图变换+棋盘格、图层面板(基础)/颜色/历史/导航器/信息可显示;打开相册图能流畅缩放平移(大图走 render_reduced)。
- **M2 位图工具**:移动/框选/套索/裁剪/吸管/抓手/缩放 + 蚂蚁线;画笔/橡皮 LiveStroke 实时笔迹+圆环光标;渐变/油漆桶/模糊/锐化/涂抹;顶部选项条随动。
- **M3 收口**:调整层+属性面板+图层蒙版基础+快捷键体系+保存链路(覆盖原图+PSD 伴生+重开恢复)+保存后库刷新;vitest 覆盖(视图变换/工具状态机/命令桥批处理,均 mock 桥);手测清单跑一轮(照 PS 验收口径)。**一期验收:对一张相册图完成修图→Ctrl+S→缩略图刷新→重开恢复图层。**
- **二期(另行计划细化)**:钢笔族、形状族、路径选择/直接选择、路径面板、文字族(IME)、自由变换、属性面板完整化。

## 五、风险与对策

- rustc <1.95:先 rustup 升级(引擎 edition 2024)。
- LiveStroke IPC 延迟:rAF 批量喂点;不行则降级为"抬笔才见笔迹"(photocraft 预览像素可直接复用,提交无二遍渲染)。
- 超大图(>4096)内存:首屏用 render_reduced,M3 后视实测决定是否上视口分块细节层(photocraft detail_plan 同思路)。
- vendor 体积/编译时间:引擎 ~17 crate 一次性抄入(~几万行),编译时间增加属可接受;不动其内部代码,升级靠重新对 diff 抄。
- 许可证:vendor 根保留 MIT/Apache 双许可文本+NOTICE, NOTICE 标注修改即可,合规。

## 六、实现期需要的授权

cargo 构建/检查/测试、rustup 升级工具链、从 photocraft-main 目录拷贝文件进仓库、npm install/构建/vitest、git 在 feature/editor-v3 分支上按里程碑提交(不 push,push 时按你的代理配置来)。