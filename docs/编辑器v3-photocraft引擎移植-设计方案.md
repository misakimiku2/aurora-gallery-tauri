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
- 待做:levels/curves/gradientMap 编辑器/快捷键补全;`editor_export_as` 已入库(前端 UI 后接)。
- **另存为 + 状态点(ff4ce61,2026-10-27)**:✅ `editor_save_as` 按新扩展名**真重编码**(jpg→png 产物是真 PNG,魔数测试钉死);PS 口径文档改绑新路径(此后 Ctrl+S 写新文件),平面格式自动带 .psd 伴生,psd 目标不重复写伴生;文件信息栏三段布局(文件名居中 + 状态圆点 橙=未保存/绿=已保存,引擎 dirty=revision>saved_revision);格式过滤器 PNG/JPEG/WebP/TIFF/PSD。
- **保存体验补全(db93bc0,2026-10-27)**:✅ 另存为快捷键 Ctrl+Shift+S;tooltip 精简;**未保存警告弹窗**(应用自有样式,保存/不保存/取消 右下角横排)——关 dirty 编辑器标签(guardedCloseTab)与退出应用(X 关窗/关闭确认"退出程序"/托盘 quit 改发事件由前端拦截)三链路生效;编辑器标签页内屏蔽 Ctrl+W/Ctrl+T(防误触),Ctrl+Tab 保留。
- **图层蒙版基础(2026-10-27)**:✅ 引擎命令全现成,前端接线为主。桥层 `state()` 补 `maskInfo`(每带蒙版图层的 enabled/linked,inspect 只有 hasMask 布尔)+ 新增 `mask_snapshot`(蒙版灰度 RGBA,k 步长采样降采样,`Surface::sample_row_strided` 按行跨步只触落点 tile);蒙版缩略图(行内,64px 快照缓存按 docId:layerId:revision 过期,禁用红叉/未链接角标/目标高亮)+ 交互照上游蒙版缩略图口径:点=编辑目标(`channel.target {channel:"mask"}`)、Shift+点=启停、Alt+点=灰度查看(`view.layerMask toggleGray`,位图管线切蒙版快照)、Ctrl+点=载入选区(`select.loadSelection channel:"mask"`);添加蒙版按钮(有选区→revealSelection,Alt→hide 系,永不替换已有);**画笔/橡皮/修描/油漆桶/渐变落蒙版**——live 描边走桥层直通不经引擎 routed 注入,**必须前端显式带 `target:"mask"`**(strokeParams/bucketParams/gradientParams 带目标位);选项条无蒙版徽章(编辑目标切换只在图层/蒙版缩略图点击与 Ctrl+\、Ctrl+2,徽章经用户拍板移除);蒙版灰度查看的逐笔预览见下方灰度条目;快捷键 Ctrl+\=蒙版目标、Ctrl+2=合成;**删除单入口蒙版优先**(用户拍板:带蒙版先删蒙版,再按删图层)。蒙版目标下引擎自动换黑白前/背景对(tools.target_mask 成对记忆),D 键=恢复白/黑。
- **调整面板(2026-10-27)**:✅ 调整页 16 种调整层一键网格(上游 adjustments_grid 顺序+图标映射 lucide,`layer.newAdjustmentLayer.<kind>` 添加后自动切属性页);属性页按 kind 参数编辑器,**本切片 13 种标量类**:亮度/对比度(含 legacy)、曝光度、自然饱和度、色相/饱和度(全图+6 色范围+着色)、色彩平衡(三调+保持明度)、黑白(6 权重+着色)、照片滤镜(20 预设回显按颜色匹配+自定义色+浓度)、通道混合器(输出通道+单色)、可选颜色(9 范围 CMYK+相对/绝对)、色调分离、阈值、反相(无参数)、颜色查找(8 内置 LUT+插值+抖动;LUT 回显本地记忆,引擎 to_params 不回显);色阶/曲线/渐变映射的直方图/曲线点/渐变停靠点编辑器下一切片。编辑走 `layer.setAdjustment`(引擎给出键合并+钳制),100ms 节流补丁累积 + `coalesce:"properties-adjustment:<id>"` 把拖动合成一步历史(上游 Properties 同口径);控件本地态跟手(引擎回包滞后不顶滑杆);剪贴到下方图层(`layer.setProps clipped`)+ 重置默认(空参数=重置)。
- **另存为标签名跟随(2026-10-27)**:✅ save_as 改绑后广播 `aurora-editor-renamed {tabId,name}`,App 监听更新 tab.sessionName(小瑕疵清零)。
- **图层缩略图 + PS 行布局(2026-10-27)**:✅ 桥层 `layer_thumbnail`(图层自身像素,内容边界∩画布裁帧,最长边 ≤64 采样,透明 straight alpha,**不含蒙版**——蒙版有自己的缩略图,上游 layer_thumb 同口径;非像素层报错→前端出类型图标 调整=反差/编组=文件夹/填充/文字/形状/智能对象);行布局照 PS:**[眼睛][图层内容缩略图][链条][蒙版缩略图][名称]**,点图层缩略图=选中+编辑目标回合成(灰度查看中顺带 view off)、点蒙版缩略图=编辑蒙版,链条=linked 切换(解链变琥珀断链);缩略图缓存共用一表(L/M 前缀,revision 过期);Background 加蒙版自动变普通层改名(引擎 PS 口径)。集成测试 `layer_thumbnail_own_pixels_content_bounds`(笔画处红/帧角透明=不含蒙版/调整层报错)。
- **灰度查看中画蒙版的逐笔预览(2026-10-27,用户报障"画完一笔才显示蒙版内容")**:✅ 根因是灰度查看期间前端跳过全部增量帧(合成帧贴进灰度位图会花屏),提交后靠 revision 重拉快照。修复:**帧模式下沉到引擎桥**——`stroke_begin` 新增 `mask_frames` 参数,为真时 begin/push/commit 补差帧都从(克隆/正式)文档直接采样**活动图层蒙版表面灰度**(`live_mask_frame`,`sample_row_strided` 1 步),同一 16B 帧协议、同一贴图管线,内容换成蒙版本身;帧模式记录在 live 状态里 push/commit 沿用。前端灰度查看+蒙版目标落笔时传 `maskFrames`,`applyStrokeFrame` 的灰度跳过改为 force 放行(移动预览等合成帧照旧跳过)。合成视图(非灰度)画蒙版本就实时(合成增量帧),不受影响。集成测试 `mask_gray_stroke_frames_live_preview` 钉住 begin 帧即灰度蒙版内容;真机:灰度查看中拖一笔,拖拽返回即见笔画、无花屏、历史 Brush Tool。
- **画透明实时(47e6ef7,2026-10-27,用户二次报障"单层画蒙版出透明要画完才显示/下层有透明洞时画上层蒙版期间透明消失")**:✅ 根因=applyStrokeFrame 的 drawImage(**source-over**)擦不掉已有像素——帧里 alpha 变小的区域是 no-op,旧不透明像素留在离屏位图,提交整幅重渲才对。多图层露出不透明下层时帧内容不透明→覆盖成功→"看起来实时";单层画透明/下层透明洞→alpha 0→保持旧像素→"画完才显示/画期间透明消失"。修复=**clearRect 帧矩形再 drawImage(先清后贴)**,移动预览同路径一并修;判定性测试 `composite_frames_keep_lower_layer_mask_holes` 证明帧内容本身正确(洞区 alpha=0),缺陷纯在前端贴帧合成。教训:**增量帧贴进持久位图必须整矩形替换,source-over 只适用于纯增量不透明内容**。
- **色阶/曲线/渐变映射完整编辑器(dd1e5fc,2026-10-27)**:✅ 桥层 `editor_histogram`(editor/src/histogram.rs 移植上游 tone.rs:RGB 空间 4 组 256-bin,BelowLayer=调整层收到的输入,大图最近邻代理,rayon);前端纯函数三件套(curvePoints 交互+自然三次样条 LUT 引擎 curve_lut 逐行移植 / levelsMath 0.1% Auto+gamma 手柄几何 / gradientStops)+ ToneEditors.tsx 三编辑器(色阶三手柄+自动+通道、曲线点交互全套+复合通道叠加、渐变映射停靠点+反相抖动);直方图 keep-after-commit(本层提交不重拉);StrictMode 挂载双跑 inflight 防占位早退;setPointerCapture 合成事件防御。单测 13+桥集成 1。
- **手柄快速连拖回跳根修(ae9d19e,2026-10-27,用户报障)**:✅ 根因=快速连发时 state 拉取 IPC 响应乱序,旧快照把 revision/params 一起回退。store 按 revision 丢弃旧 state 快照+RunOutcome.revision 只进不退;三编辑器"自己提交的 300ms 内回包不回吸"+抬手 flushNow。浅色主题白手柄不可见:手柄改 SVG+1px 描边(上游本有)+投影。
- **蒙版右键菜单+属性面板蒙版区段(708c5ef,2026-10-27)**:✅ 蒙版缩略图右键 6 项(禁启/删除/应用|蒙版载入选区三种运算,删除不确认);双击蒙版缩略图=切蒙版目标+属性页(aurora-editor-panel 窗口事件);属性页蒙版区段:浓度 0..100%、羽化 0..1000px(x³ 轨道)、反相;`layer.layerMask.edit` 节流+coalesce;桥 maskInfo 补 density/feather。fixed 弹层必须 portal 到 body(面板祖先变换劫持 fixed)。
- **蒙版菜单样式统一(90a6633,2026-10-27,用户拍板)**:✅ 照图库 ContextMenu 设计语言(毛玻璃+圆角+软阴影+蓝 hover);宽度 w-max 自适应不留白。
- **导出为 → 快速导出图层 PNG(49ac09f+e8eebf0,2026-10-27,用户拍板:整图导出与另存为无差别,改图层级)**:✅ 信息栏按钮(FileOutput 图标,用户拍板导出不用下载图标;调整层禁用)+ Ctrl+Shift+E;桥 `export_layer_png`=引擎 layer_document 单层抽取(内容边界裁剪+蒙版应用+编组整组合成)→ PNG,**不推 revision/不入历史**(vendor 命令 journal:true 会入历史,故不走命令桥);对话框默认名=图层名(sanitize 照上游);不动会话路径/dirty。整图导出桥 editor_export_as 保留无 UI。
- **图层行右键菜单+图层颜色(8cd91a8,2026-10-27)**:✅ LayerContextMenu(复制/删除/从图层创建组|快速导出为 PNG|蒙版区|剪贴蒙版|链接|合并族|重命名|颜色);砍智能对象/图层样式/画板/帧/栅格化(依赖未实现功能);口径=非选区右键每项先 layer.select 再发命令、删除不确认;蒙版缩略图右键与图层行菜单同基座。图层颜色 12 色(上游 theme.rs 色值)+ setColorLabel。**样式经用户三轮拍板**:菜单底部裁剪→useLayoutEffect 实测钳位(14dd549);"颜色没作用"→右侧二级弹层(8ae78bb);**颜色标记定稿=行内"像素"标签左侧 8px 圆点(42d3204,竖色条挡眼睛按钮废弃)**。
- **移动工具补裁剪:Auto-Select/Alt 复制/链接层扩散(2026-10-28)**:✅ 照上游 move_ui/move_box/move_mods/pick_cmds 移植。①**Auto-Select**(选项条 开关+图层/组 下拉,默认开,Ctrl 临时反转):按下 `layer.pickAt` 探测——命中即选中(已选中的多选保持,引擎口径)、锁定层/背景命中=点击选中+拖出**层选框**(上游 #4058)、完全空白=层选框,松手 `layer.selectInRect`(⇧ 添加,负宽高引擎归一,画板外点击=取消图层选择 #4923);探测是异步 IPC,按下代次(seq)防「探测回来前已抬起」。②**Alt 复制**:整层路径=桥层 `editor_duplicate_move` 原子三步(in place 复制→平移→`History::purge_last`+`set_current_label` 折叠一步 "Duplicate + Move",上游 fold_history 同款);浮动像素路径=按下 `select.float {copy:true}`(引擎留原件浮副本);Alt+方向键=复制微移(浮动先 drop 再浮副本,整层走桥)。③**链接层扩散**:桥层 move_targets 换引擎 `layer_multi_cmds::move_targets`(with_links),前端 `moveBounds` 并入同 linkGroup 层的 bounds(linkGroup 经 inspect 已有,EditorLayer 透传);⇧ 轴约束升级为上游 `constrain` 原样移植(整层 4 方向/浮动 8 方向,**8° 迟滞**防对角抖动)。④桥 `state()` 补 `lockInfo`(position/all/background,探测判定用)与 `floating`。
- **浮动选区被状态拉取掉落的隐性根修(2026-10-28)**:✅ 引擎 `before_command` 在任何非豁免命令(含 `document.inspect`)前把浮动选区落地——上游 UI 直读 DocState 不走命令没这个问题;我们的 `state()` 经命令跑 inspect,**自 M2 起每次状态拉取都在掉浮动件**(零位移零历史,终态碰巧正确),浮动拖拽的实时预览帧其实一直被静默跳过。修复=**state() 直调 `inspect::document`(pub)绕过 dispatch**。释放语义随之显式化:抬笔 `select.float{dx,dy}` 后**显式 `select.drop` 立即落定**(PS Move 工具口径=用户已验收的历史"Move"一步;上游保持浮动到 Enter,方向键微移仍按上游保持浮动)。
- **PS 快捷键补全(2026-10-28)**:✅ Ctrl+J=通过拷贝的图层(带选区仅拷选中像素)/Ctrl+Shift+J=通过剪切(`layer.new.layerViaCopy/Cut`);Ctrl+G=编组/Ctrl+Shift+G=解组(`layer.groupLayers`/`layer.ungroupLayers`);Ctrl+E=合并图层(单选=向下合并,`layer.mergeLayers`;Ctrl+Shift+E 已被快速导出占用,合并可见走右键菜单);Ctrl+[ / ]=下移/上移一层,Ctrl+Shift+[ / ]=移到最后/最前(`layer.arrange.*`,方括号 e.code 兜底 IME);Ctrl+Shift+N=新建图层;Delete/Backspace=清除(选区内容,无选区=整层,上游 edit.clear 键位)/Alt+=填充前景色/Ctrl+=填充背景色(`edit.fill`);App 级 useKeyboardShortcuts 的 Delete(删文件)在编辑器标签内屏蔽。全部字母键走 e.code 兜底。
- **图层行链接标识(abb019f,2026-10-29,用户反馈"链接后看不出谁和谁链接")**:照上游 layer_row_ui 的 `Indicator::Link` 移植——`linkGroup != null` 即在行名称后渲染 link-2 淡色小图标,悬停显示同组成员名。
- **画笔族 Shift 直线(87a8f98,2026-10-29,用户要求)**:Shift+拖动=0°/45°/90° 直线(3 屏幕像素锁距+方向记忆);Shift+点击=连接上一笔终点(同一笔一步历史);橡皮筋预览;5 个画笔族工具通用(上游 stroke_constraint.rs 移植)。
- **裁剪工具完整版(2026-10-29,用户选定,真机验证过)**:✅ 照上游 crop_ui/crop_straighten 移植。①**框交互**:进入工具即有默认框(选区∩画布否则整幅,未动=提交无操作/离开丢弃)、拖画新框(内部点未编辑框也重画 #4461)、移动整框、8 把手(命中容差 8 屏幕 px,小框内侧收缩 1/4)、框外拖=绕中心旋转(⇧15° 步进、角度 readout 在指针旁)、方向键微移、双击框内提交。②**比例预设**(上游 CROP_RATIOS):自由/原始/1:1/4:5/5:7/2:3/16:9——选定后当前框**保中心只减不增**内缩适配(fitted_ratio;默认框适配不算编辑 #6750);调把手时预设始终生效、无预设 ⇧=保持按下时比例、⌥=绕中心;角把手 ratio 取"相对伸缩更大者"为主轴。③**拉直**:选项条标尺按钮(armed 一次性)→ 画线 ≥3 屏幕像素 → 角度=标尺线转到最近水平/垂直轴(引擎 straighten_angle 语义)→ 框保持自身比例取**旋转后仍完全内含于画布的最大居中框**(fitted 公式)。④**提交**:`image.crop {x,y,width,height,angle?}` 一条命令——引擎原生支持带角度旋转裁剪(一步历史)与**超出画布的显式矩形**(扩展区按背景色填充,Background 补实);x/y round、w/h ≥1;提交后视图自动适配;被拒恢复框。⑤**斜置框呈现**:遮罩用 even-odd 挖洞(正置/斜置同一实现)、三分线沿框边线性插值、把手小方块;把手悬停光标(缩放箭头/移动)。**顺带修**:裁剪钩子(cropCommit/cropCancel/cropFitRatio)在画布挂载早于会话创建时永不注册(✓按钮此前靠 Enter 掩盖)——改为订阅回调每次通知补注册(requestDraw 同款)。**砍**(记录):WHR 尺寸预设/用户裁剪预设/透视裁剪/内容识别填充/默认模式(视图旋转)/框专属 undo 步进/自绘旋转光标/O 构图线循环/吸附。**冒烟**:1:1 适配、拉直→旋转框→提交 1860x887→720x720(一步 Crop)、视图适配、扩展路径(引擎收画布外矩形+白底填充)全过;把手超画布扩展的端到端被冒烟环境干扰(验证期间 HMR 重挂载重置 view+1:1 比例残留约束),几何已被单测覆盖、引擎路径已证,待日常使用复验。
- 待做:曲线铅笔模式+Smooth;渐变映射预设下拉(依赖渐变预设库,渐变工具同样没有);Select and Mask;快捷键继续补全(Ctrl+C/V 剪贴板图像);多边形/磁性套索;渐变 Live 图层;完整"导出为"对话框(缩放/重采样,引擎 layer.exportAs 已就绪);移动工具 Auto-Select 的悬停轮廓高亮;裁剪的 WHR 尺寸预设/框专属 undo 步进/自绘旋转光标。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| LiveStroke IPC 延迟 | rAF 批量喂点;不行降级"抬笔见笔迹"(seed 复用保证无二遍渲染) |
| >4096 大图内存 | 首屏/导航器 render_reduced;100% 视口分块细节层(photocraft detail_plan 同思路)后置 |
| image 0.24/0.25 共存 | cargo 允许;后续统一 |
| craft-libs git 依赖拉取 | 本机代理 7897 + CARGO_NET_GIT_FETCH_WITH_CLI |
| vendor 升级 | 按清单重拷+重打 4 处补丁(README 有 procedure) |
