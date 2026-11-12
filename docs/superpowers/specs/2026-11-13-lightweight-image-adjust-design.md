# 轻量非破坏图片调整(图库内置快调)设计文档

- 日期:2026-11-13
- 状态:方向已定,待用户审阅
- 基线:main @ e884582(v2.4.0)
- 背景:2026-11-13 两段式定调——专业编辑(图层/画笔/矢量/选区)不在图库做,外包独立 Photocraft;`feature/editor-v3`(ca8b038)冻结不合 main。本文档只覆盖图库内置的**轻量非破坏参数调整**。

## 0. 验收口径(用户视角,最高优先)

1. **内存占用小**:调整 36MP 级大图时前端不持有全尺寸像素缓冲,预览走 GPU。
2. **编辑流畅**:滑杆拖动实时跟手,无卡顿。
3. **实时所见即所得**:调整效果即时呈现,无"应用"步骤。
4. **大图无损**:原图文件字节永不修改;调整全部是参数;只有导出/另存产新文件。预览为按视口下采样的缩小版(视觉无损),烘焙按原始全分辨率执行。
5. **范围外(明确不做)**:图层、混合模式、画笔、矢量工具、选区/蒙版、文字排版、变形/Warp、内容识别、智能对象;打码/标注暂缓(用户拍板"遇到再说")。专业需求外包 Photocraft。

## 1. 功能范围与分期

**一期**
- 几何:旋转 90°/180°/270°、水平/垂直翻转(EXIF 方向感知)、裁剪(自由 + 1:1/4:3/3:2/16:9/原比例预设 + 九宫格参考线)、拉直(±15°,自动最大内接矩形裁边)
- 影调:亮度、对比度、饱和度、色温/色调(白平衡)
- 一键自动增强(**算法钉死**:亮度通道 2%/98% 分位裁剪直方图拉伸 + 灰世界白平衡假设,**展开为具体参数值**,可继续微调)、一键重置
- 参数持久化;缩略图反映调整(§5)
- 导出:`bake_edits` 产 PNG/JPEG 新文件,同目录 `<原名>-edited` 命名(§9)
- EXIF 方向基建(§6)

**二期**
- 高光/阴影、清晰度、锐化、自然饱和度(vibrance)、暗角、直方图面板
- 预设(参数组保存/套用/管理,与标签体系并列入口)
- 导出对话框:格式(PNG/JPEG)、质量、按最大宽度缩放、可选目标目录(复用 FolderPickerModal)

**三期**
- 批量:多选套预设、批量旋转/翻转、批量导出(转换/压缩/缩尺寸);复用现有批量基建(useFileSelection 多选、批量模态、AndroidSelectionBar 地基)

## 2. 架构总览

- 模型:**参数非像素**(Lightroom/Apple Photos/Eagle 模型)。原图永不写回,DB 是调整的唯一事实源。
- 双端分工:
  - **前端(交互/预览)**:视口尺寸 Canvas2D 预览(实施修订:原定 WebGL 纹理,改 Canvas2D——36MP 全尺寸纹理会占 144MB GPU/进程内存,与验收口径 1 冲突;Canvas2D 走 `ctx.filter` = CSS 内建(brightness/contrast/saturate,GPU 合成)+ SVG `#aurora-adjust-tt` 对角矩阵,与 Rust 公式逐项一致,且天然零全尺寸缓冲);无参数时走原 `<img>` 直通管线,零开销。
  - **Rust(权威像素)**:`bake_edits` 一次性烘焙,双用途——①导出产文件;②缩略图管线在有参数时套用(§5)。
- 契约:`AdjustParams` JSON 是两端唯一契约;数值语义以 Rust 参考实现为准,前端 `src/utils/adjust.ts` 逐项对齐,一致性由两端单测钉住(§8)。
- 方案取舍记录:A(WebGL 预览+Rust 烘焙,选定)/B(全 Rust 预览:交互延迟不可接受)/C(纯前端:36MP 前端编码吃 WebView 内存,与内存治理教训相抵)。

## 3. AdjustParams 契约(v1)

serde struct 与 TS type 手工同源;带 `v` 版本字段,迁移函数放 core。

```json
{
  "v": 1,
  "geo": {
    "rotate90": 0,            // 顺时针 90° 步数,0..3
    "flipH": false,
    "flipV": false,
    "straightenDeg": 0.0,     // -15..15,0=关
    "cropNorm": null          // {x,y,w,h} 归一化坐标,语义见 §4;null=未裁
  },
  "tone": {
    "brightness": 0.0,        // -1..1,0=不调
    "contrast": 0.0,
    "saturation": 0.0,
    "temperature": 0.0,       // -1(冷)..1(暖)
    "tint": 0.0               // -1(绿)..1(品红)
  }
}
```

**影调数学(钉死,sRGB 空间直接运算,不做线性化)**,通道值 v ∈ [0,1],**每步后 clamp 到 [0,1]**(与 SVG 滤镜逐原语 clamp 语义一致):
- 亮度(p):`v' = clamp(v * (1 + p))`
- 对比度(p):`v' = clamp((v - 0.5) * (1 + p) + 0.5)`
- 饱和度(p):`gray = dot(v, (0.213, 0.715, 0.072))`(Rec709,与 SVG `feColorMatrix saturate` 一致);`v' = clamp(lerp(gray, v, 1 + p))`
- 色温(p):`R' = clamp(R * (1 + p*0.25))`;`B' = clamp(B * (1 - p*0.25))`
- 色调(t):`G' = clamp(G * (1 - t*0.25))`
- 叠加顺序:亮度 → 对比度 → 饱和度 → 色温 → 色调。
- 全默认值视为"无调整":DB 不写行;UI 保存时若全默认则 clear。

## 4. 操作顺序与几何语义(钉死)

应用顺序:**EXIF 方向矫正 → flipH/flipV → rotate90×n(顺时针)→ 拉直 → 裁剪 → 影调 → 编码**。

- `cropNorm` 定义:基于"拉直+旋转+翻转完成后的正向图"的归一化坐标(x,y,w,h ∈ [0,1])。UI 只在此坐标系取值,规避坐标随几何变换映射的经典坑。
- 拉直:绕中心旋转,随即取最大内接轴对齐矩形裁边(**精确解**:中心对称多边形最大内接同比例矩形必居中,半高受四条约束取最小——近似公式在非方图会算大露角),结果宽高取整到偶数。
- EXIF 方向值 1..8 在几何链最前展开为对应的翻转+旋转组合(标准映射表,§8 单测覆盖 1/3/6/8)。

## 5. 存储与缩略图联动

- core 新表:`file_edits(file_id PK(与 file_index.file_id 同型且外键级联), params TEXT NOT NULL, updated_at)`,幂等建表照 `file_metadata` 模式(core/src/db/mod.rs)。
- Tauri 命令(src-tauri/src/db_commands.rs):`edit_get_params`、`edit_set_params`、`edit_clear_params`、`edit_get_params_batch`(三期用)。前端封装加进 src/api/tauri-bridge/。
- 缩略图联动(src-tauri/src/thumbnail.rs):
  - 缓存键升级为 v2:`v2 + size + mtime + 首4096字节哈希 + params 内容哈希`(无参数时 params 哈希为空串,与旧内容等价;键格式变化一次性使旧缓存自然失效重建,顺带解决 §6 的方向矫正)。
  - 有参数时:解码(含 EXIF 矫正)→ 套用与 bake_edits 相同的几何+影调管线 → 缩放到目标尺寸。
  - 网格 UI:已调整图片角标(lucide `SlidersHorizontal` 小图标)。

## 6. EXIF 方向基建(顺一期,修现有全局不一致)

**现状(2026-11-13 侦查证实)**:Rust 解码不套方向(thumbnail/AVIF/JXL 预览),DB 宽高为编码尺寸(scanner.rs:560 注释),前端无 EXIF 解析;查看器 `<img>` 靠 WebView2 自动转正——与缩略图横倒不一致。

方案:
- src-tauri 引入 `kamadak-exif`(仅读 orientation 标签,轻量)。
- `thumbnail.rs` 解码后统一按 orientation 像素重排(经 §5 缓存键 v2 一次性重建生效)。
- `scanner.rs` 读 orientation 写入 `file_index` 新列 `orientation INTEGER DEFAULT 1`(幂等 ALTER);存量行靠 `SCANNER_CAPABILITY` 5→6 触发的全扫回填;`width/height` 改存**显示尺寸**(方向 5..8 竖横互换)。
- ~~新 Tauri 命令 `get_image_orientation(path)`~~ **实施修订:不做**——前端 `<img>` 由 WebView2 按 EXIF 自动转正(Chromium ≥81 默认行为),Canvas 预览画 `img` 即正立;bake/thumbnail 在 Rust 侧现场读文件 EXIF,不依赖 DB 回填。

## 7. 前端 UI 与组件

- 挂点:ImageViewer(经 ViewerPane)新增"调整"模式,与现有缩放/幻灯片模式并列;**不往 ImageViewer.tsx(2660 行)里塞逻辑**,只加模式分支与挂载点。
- 新文件(全部独立、可单测):
  - `src/components/viewer/adjust/AdjustDrawer.tsx` — 抽屉壳、滑杆组、比例预设条、九宫格开关、导出/重置按钮;文案入 src/utils/translations.ts
  - `src/components/viewer/adjust/AdjustCanvas.tsx` — 视口尺寸 Canvas2D 预览(几何帧经 `buildAdjustedFrame`:flip/rotate90/拉直内接矩形,影调经 `ctx.filter`,裁剪覆盖层含手柄/九宫格/锁比例)
  - `src/utils/adjustCanvasDraw.ts` — 几何帧构建与自动增强取样(AdjustCanvas 与 AVIF 兜底缩略图共用,保证三方一致)
  - `src/hooks/useImageAdjust.ts` — 参数状态、防抖持久化(edit_set_params)、撤销栈(参数对象快照,上限 50 步,纯对象切换,零内存压力)
- 状态管理照现有模式:自定义 hook + props,不引状态库。
- 裁剪交互:拖角柄 + 比例锁定;拉直:滑杆 + 自动裁边虚线框预览。
- 前端不持有全尺寸像素缓冲:预览画布按视口尺寸绘制(源图下采样上限 2048 长边),自动增强取样下采样 ≤256(验收口径 1)。
- 状态管理照现有模式:自定义 hook + props,不引状态库;`adjustStore` 为路径键模块级注册表(网格角标 + AVIF 兜底共用)。
- Android 原生查看器本期不覆盖,后续单列。

## 8. 测试

- 几何单测:cropNorm 在 rotate90/flip 全组合下的像素坐标映射;拉直内接矩形公式(精确解);EXIF 1/3/6/8 展开。
- **两端一致性**:公式同源(Rust `apply_tone_rgb`/`straighten_image` 为权威,TS `adjust.ts` 逐项对齐)+ Rust 单测(image_adjust.rs 11 项)与 TS 单测(adjust.spec.ts 20 项)双面钉住;像素级快照对比(WebGL/Canvas 读回 vs Rust 烘焙)列为后续冒烟项,当前以「缩略图(Rust 烘焙)与预览(前端滤镜)肉眼一致」为口径。
- DB:幂等建表/重复迁移;params 版本迁移。
- 烘焙:格式循环转换、质量参数、max_width 缩放不产生坏图。
- 手动冒烟:36MP 图滑杆实时性与内存(对照验收口径 1–3)。

## 9. 导出

- Rust 命令 `bake_edits(src_path, params_json, out_path, format: "png"|"jpeg", quality: 0-100(默认 90), max_width: Option<u32>)`:解码(含 EXIF 矫正)→ 几何 → 影调 → 编码 → 走 `write_file_bytes_indexed`(file_operations.rs:852)落盘 → `scan_file` 入库。
- **一期导出格式钉死 PNG/JPEG**(image 0.24 WebP 编码能力受限,WebP 列二期,升 image 或引有损 webp 编码时一并做);AVIF 导出不做(canvas.toBlob 无 AVIF)。
- 输出命名:同目录 `<原名>-edited.<ext>`,重名追加序号;原图与参数不动。
- 入口:调整抽屉"导出"按钮;二期扩展格式/质量/尺寸对话框。

## 10. 错误处理

- 文件被外部移动/删除:参数按 file_id 保留;bake 失败给明确 toast。
- params JSON 解析失败:视为损坏,clear 该行,不阻塞查看。
- 超大图(>100MP)烘焙:36MP 级同步命令可接受(<2s);>100MP 给 loading 提示,不做分块。

## 11. 明确非目标

§0 范围外清单;Android 端调整;LAN-share 独立入口(src/shared,主应用不使用该目录的 ImageViewer)。

## 12. 一期实施切分(供后续实施计划用)

①EXIF 基建(§6)→ ②契约+DB(§3/§5)→ ③Rust 烘焙管线+测试(§4/§8)→ ④缩略图联动(§5)→ ⑤前端预览+抽屉 UI(§7)→ ⑥自动增强+导出(§9)。

## 13. 一期实施记录(2026-11-13)

分支 `feature/quick-adjust`(自 main@dfa2d45 起),未推送:
- `3f54a22` Rust 侧全量:EXIF 基建(kamadak-exif;orientation 列全链 12 处补齐+护栏测试扩展;SCANNER_CAPABILITY 5→6;缩略图解码统一矫正)、`file_edits` 表+`edit_*` 四命令、`image_adjust.rs`(契约/几何/影调/烘焙,742 行含 11 项单测)、缩略图联动(缓存键 `-tv2`+adjust 内容哈希;get_thumbnail/batch/save_remote 三读路径;LAN 走无参口径)
- `7849df6` 前端全量:`adjust.ts` 契约/`adjustStore`/`edits.ts` 桥/`AdjustFilterDefs`/`useImageAdjust`/`AdjustCanvas`/`AdjustDrawer`/ImageViewer 集成/网格角标+缓存失效联动/AVIF 兜底套参/translations/spec 20 项
- `5f62e59` 收尾修正:内接矩形精确解(两端同步)+`file_edits::get_all` 带路径

验证状态:cargo core 231 + src-tauri 88(全绿)、vitest 22 文件 210(全绿)、tsc 0 错、vite build 成功。**未做:真机 GUI 冒烟**(滑杆实时性/两端肉眼一致/EXIF 全扫回填,留待用户实跑验收口径 1–4)。

实施偏差(相对 §2/§6/§7 原文):预览 WebGL→Canvas2D(内存);`get_image_orientation` 命令取消(WebView 自动转正覆盖);饱和度 luma Rec601→Rec709(对齐 SVG saturate);影调改**每步 clamp**(对齐 SVG/CSS 滤镜语义);内接矩形近似公式→精确解(非方图露角)。

已知边界:AVIF/JXL 源不支持导出(解码 crate 缺位,Rust 给明确报错);幻灯片态不套参数;LAN 端缩略图为原图口径;Android 原生查看器不在本期;`webp` 导出列二期。
