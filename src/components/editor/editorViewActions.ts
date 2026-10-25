/** 视图动作:导航器/缩放控件调用,改 runtime.view 后请求画布重绘。 */
import { getSession } from './editorStore';
import { actualPixels, clampScale, fitToView, zoomAbout } from './viewMath';

export function zoomSession(tabId: string, factor: number, anchor?: { x: number; y: number }): void {
  const s = getSession(tabId);
  if (!s) return;
  const { viewW, viewH } = s.runtime;
  const a = anchor ?? { x: viewW / 2, y: viewH / 2 };
  s.runtime.view = zoomAbout(s.runtime.view, factor, a.x, a.y);
  s.runtime.requestDraw?.();
}

export function fitSession(tabId: string): void {
  const s = getSession(tabId);
  if (!s || !s.state) return;
  const { viewW, viewH } = s.runtime;
  s.runtime.view = fitToView(s.state.width, s.state.height, viewW, viewH);
  s.runtime.requestDraw?.();
}

export function actualPixelsSession(tabId: string): void {
  const s = getSession(tabId);
  if (!s || !s.state) return;
  const { viewW, viewH } = s.runtime;
  s.runtime.view = actualPixels(s.state.width, s.state.height, viewW, viewH);
  s.runtime.requestDraw?.();
}

export function setZoomSession(tabId: string, scale: number): void {
  const s = getSession(tabId);
  if (!s) return;
  const target = clampScale(scale);
  zoomSession(tabId, target / s.runtime.view.scale);
}
