/**
 * photocraft 引擎桥客户端:src-tauri editor_* 命令的 invoke 封装。
 * 渲染结果为原始字节([w:u32 LE][h:u32 LE][RGBA8…]),不走 JSON 数组。
 */
import { invoke } from '@tauri-apps/api/core';
import type { EditorDocState, EditorOpenInfo, RunOutcome } from './editorTypes';

export async function editorOpen(path: string): Promise<EditorOpenInfo> {
  return invoke<EditorOpenInfo>('editor_open', { path });
}

export async function editorRun(doc: number, cmd: string, params: Record<string, unknown> = {}): Promise<RunOutcome> {
  return invoke<RunOutcome>('editor_run', { doc, cmd, params });
}

export interface MagneticTraceResult {
  points: number[][];
}

/** 磁性套索:沿指针路径把 from→to 描在边上(桥层 EdgeSource 快照)。 */
export async function editorMagneticTrace(
  doc: number, from: [number, number], to: [number, number], guide: number[][], width: number, contrast: number,
): Promise<MagneticTraceResult> {
  return invoke<MagneticTraceResult>('editor_magnetic_trace', { doc, from, to, guide, width, contrast });
}

/** 磁性套索:落点吸附到检测宽度内的显著边(无显著边=原点)。 */
export async function editorMagneticSnap(
  doc: number, p: [number, number], width: number, contrast: number,
): Promise<{ point: number[] | null }> {
  return invoke<{ point: number[] | null }>('editor_magnetic_snap', { doc, p, width, contrast });
}

export interface RenderedBitmap {
  width: number;
  height: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

/** 合成画布位图;给 max 时降采样(导航器/大图),否则全分辨率。 */
export async function editorRender(doc: number, maxW?: number, maxH?: number): Promise<RenderedBitmap> {
  const buf = await invoke<ArrayBuffer>('editor_render', { doc, maxW: maxW ?? null, maxH: maxH ?? null });
  const u8 = new Uint8Array(buf);
  const w = (u8[0] | (u8[1] << 8) | (u8[2] << 16) | (u8[3] << 24)) >>> 0;
  const h = (u8[4] | (u8[5] << 8) | (u8[6] << 16) | (u8[7] << 24)) >>> 0;
  return { width: w, height: h, rgba: new Uint8ClampedArray(u8.buffer as ArrayBuffer, u8.byteOffset + 8) };
}

export async function editorState(doc: number): Promise<EditorDocState> {
  return invoke<EditorDocState>('editor_state', { doc });
}

/** live 描边增量帧:文档坐标矩形 + 合成像素(空帧 width=0 表示无变化)。 */
export interface StrokeFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

function parseStrokeFrame(buf: ArrayBuffer, offset = 0): StrokeFrame {
  const u8 = new Uint8Array(buf);
  const i32 = (o: number) => (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) | 0;
  const u32 = (o: number) => (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0;
  const x = i32(offset);
  const y = i32(offset + 4);
  const width = u32(offset + 8);
  const height = u32(offset + 12);
  // 载荷与头不符时给空帧而非抛错:帧解析抛错会把"引擎已成功的 begin"留在 Rust 侧
  // 成悬空 live(此后每次落笔都被拒),宁可丢这一帧。
  if (width === 0 || height === 0 || offset + 16 + width * height * 4 > u8.length) {
    return { x: 0, y: 0, width: 0, height: 0, rgba: new Uint8ClampedArray(0) };
  }
  return { x, y, width, height, rgba: new Uint8ClampedArray(u8.buffer as ArrayBuffer, u8.byteOffset + offset + 16, width * height * 4) };
}

/** 落笔:创建 live 描边并渲染首点(paint.stroke / paint.pencil / paint.blur|sharpen|smudge)。
 * maskFrames=灰度查看中画蒙版:帧取活动图层蒙版表面灰度(而非合成像素)。 */
export async function editorStrokeBegin(doc: number, cmd: string, params: Record<string, unknown>, maskFrames = false): Promise<StrokeFrame> {
  const buf = await invoke<ArrayBuffer>('editor_stroke_begin', { doc, cmd, params, maskFrames });
  return parseStrokeFrame(buf);
}

/** 拖动中投一批点([x,y,pressure,…] 平铺),返回本批改变区域的增量帧。 */
export async function editorStrokePush(doc: number, points: number[]): Promise<StrokeFrame> {
  const buf = await invoke<ArrayBuffer>('editor_stroke_push', { doc, points });
  return parseStrokeFrame(buf);
}

/** 抬笔提交的结果:RunOutcome + 补差帧(收尾 dab/点画等未送达像素)。 */
export interface StrokeCommitResult {
  outcome: RunOutcome;
  frame: StrokeFrame;
}

/** 抬笔:递交 live 像素并回放命令(fromLive 命中零重渲染),入一步历史。
 * 响应 = [jsonLen:u32][RunOutcome JSON][帧头 16B][RGBA]。 */
export async function editorStrokeCommit(doc: number): Promise<StrokeCommitResult> {
  const buf = await invoke<ArrayBuffer>('editor_stroke_commit', { doc });
  const u8 = new Uint8Array(buf);
  const jsonLen = ((u8[0] | (u8[1] << 8) | (u8[2] << 16) | (u8[3] << 24)) >>> 0);
  const text = new TextDecoder().decode(u8.subarray(4, 4 + jsonLen));
  return {
    outcome: JSON.parse(text) as RunOutcome,
    frame: parseStrokeFrame(buf, 4 + jsonLen),
  };
}

/** 放弃进行中的描边(无历史)。 */
export async function editorStrokeCancel(doc: number): Promise<void> {
  return invoke<void>('editor_stroke_cancel', { doc });
}

/** 保存结果:原图路径 + .psd 伴生路径(拍板:Ctrl+S 覆盖原图 + 分层伴生)。 */
export interface EditorSaveResult {
  imagePath: string;
  psdPath: string;
  psdExisted: boolean;
}

/** 保存:覆盖原图(按原编码质量)+ 同名 .psd 分层伴生(引擎原子写)。 */
export async function editorSave(doc: number): Promise<EditorSaveResult> {
  return invoke<EditorSaveResult>('editor_save', { doc });
}

/** 另存为结果:新路径 + 平面格式时的 .psd 伴生(选 psd 目标则无伴生)。 */
export interface EditorSaveAsResult {
  imagePath: string;
  psdPath: string | null;
}

/** 另存为:按新扩展名真重编码(photocraft_io 依扩展名走对应编码器),文档改绑新路径。 */
export async function editorSaveAs(doc: number, path: string): Promise<EditorSaveAsResult> {
  return invoke<EditorSaveAsResult>('editor_save_as', { doc, path });
}

/** 导出为指定路径的平面文件(不动会话路径、不写伴生)。 */
export async function editorExportAs(doc: number, path: string): Promise<{ bytes: number }> {
  return invoke<{ bytes: number }>('editor_export_as', { doc, path });
}

/** 快速导出当前图层为 PNG(单层文档:内容边界裁剪+蒙版应用;不入历史)。 */
export async function editorExportLayerPng(doc: number, layer: number, path: string): Promise<{ path: string; bytes: number; width: number; height: number }> {
  return invoke<{ path: string; bytes: number; width: number; height: number }>('editor_export_layer_png', { doc, layer, path });
}

/**
 * 移动工具拖拽预览帧(photocraft move_ui 口径:拖动中纯函数合成,提交才一条命令)。
 * target="float":选区像素浮动,dx/dy 为自最近一次已提交偏移以来的增量;
 * target="layer":整层平移,dx/dy 为总位移。x/y/w/h 为脏矩形(文档坐标)。
 */
export async function editorMoveFrame(
  doc: number, target: 'float' | 'layer', dx: number, dy: number, x: number, y: number, w: number, h: number,
): Promise<StrokeFrame> {
  const buf = await invoke<ArrayBuffer>('editor_move_frame', { doc, target, dx, dy, x, y, w, h });
  return parseStrokeFrame(buf);
}

/** Alt 复制移动(上游 move_mods 口径):in place 复制选中层并平移,历史折叠一步 "Duplicate + Move"。 */
export async function editorDuplicateMove(doc: number, dx: number, dy: number): Promise<{ revision: number; layers: number[] }> {
  return invoke<{ revision: number; layers: number[] }>('editor_duplicate_move', { doc, dx, dy });
}

/** Alt 拖动的历史折叠:把 before(拖拽开始前 past_len)之后的复制+平移合并成一步 "Duplicate + Move"。 */
export async function editorFoldDuplicateMove(doc: number, before: number): Promise<{ revision: number; historyCurrent: number }> {
  return invoke<{ revision: number; historyCurrent: number }>('editor_fold_duplicate_move', { doc, before });
}

/** 选区真实轮廓(边界线段 [x0,y0,x1,y1],文档像素坐标;蚂蚁线数据源)。无选区为 null。 */
export async function editorSelectionOutline(doc: number, step: number): Promise<{ step: number; segments: number[][] } | null> {
  return invoke<{ step: number; segments: number[][] } | null>('editor_selection_outline', { doc, step });
}

/** 蒙版快照(灰度 RGBA,文档坐标范围,降采样到 maxW×maxH 内):蒙版缩略图/灰度查看共用。 */
export async function editorMaskSnapshot(doc: number, layer: number, maxW: number, maxH: number): Promise<RenderedBitmap> {
  const buf = await invoke<ArrayBuffer>('editor_mask_snapshot', { doc, layer, maxW, maxH });
  const u8 = new Uint8Array(buf);
  const w = (u8[0] | (u8[1] << 8) | (u8[2] << 16) | (u8[3] << 24)) >>> 0;
  const h = (u8[4] | (u8[5] << 8) | (u8[6] << 16) | (u8[7] << 24)) >>> 0;
  return { width: w, height: h, rgba: new Uint8ClampedArray(u8.buffer as ArrayBuffer, u8.byteOffset + 8) };
}

/** 图层内容缩略图(图层自身像素,内容边界裁剪,最长边 ≤maxSide,透明 straight alpha)。 */
export async function editorLayerThumbnail(doc: number, layer: number, maxSide: number): Promise<RenderedBitmap> {
  const buf = await invoke<ArrayBuffer>('editor_layer_thumbnail', { doc, layer, maxSide });
  const u8 = new Uint8Array(buf);
  const w = (u8[0] | (u8[1] << 8) | (u8[2] << 16) | (u8[3] << 24)) >>> 0;
  const h = (u8[4] | (u8[5] << 8) | (u8[6] << 16) | (u8[7] << 24)) >>> 0;
  return { width: w, height: h, rgba: new Uint8ClampedArray(u8.buffer as ArrayBuffer, u8.byteOffset + 8) };
}

/** 直方图(levels/curves 编辑器背景):below=true 看调整层下方合成,否则单层自身;
 * channels[0]=复合 (R+G+B)/3,1..3=R/G/B,各 256-bin。 */
export async function editorHistogram(doc: number, layer: number, below: boolean): Promise<{ channels: number[][] }> {
  return invoke<{ channels: number[][] }>('editor_histogram', { doc, layer, below });
}

export async function editorClose(doc: number): Promise<void> {
  return invoke<void>('editor_close', { doc });
}
