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
  return { x, y, width, height, rgba: new Uint8ClampedArray(u8.buffer as ArrayBuffer, u8.byteOffset + offset + 16, width * height * 4) };
}

/** 落笔:创建 live 描边并渲染首点(paint.stroke / paint.pencil / paint.blur|sharpen|smudge)。 */
export async function editorStrokeBegin(doc: number, cmd: string, params: Record<string, unknown>): Promise<StrokeFrame> {
  const buf = await invoke<ArrayBuffer>('editor_stroke_begin', { doc, cmd, params });
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

/** 选区真实轮廓(边界线段 [x0,y0,x1,y1],文档像素坐标;蚂蚁线数据源)。无选区为 null。 */
export async function editorSelectionOutline(doc: number, step: number): Promise<{ step: number; segments: number[][] } | null> {
  return invoke<{ step: number; segments: number[][] } | null>('editor_selection_outline', { doc, step });
}

export async function editorClose(doc: number): Promise<void> {
  return invoke<void>('editor_close', { doc });
}
