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

export async function editorClose(doc: number): Promise<void> {
  return invoke<void>('editor_close', { doc });
}
