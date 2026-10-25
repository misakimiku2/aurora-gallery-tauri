/**
 * 导航器/信息 组合面板。
 * 导航器:降采样缩略图(revision 变化时重拉)+ 视口红框 + 缩放行;
 * 信息:指针文档坐标/取样颜色(rAF 轮询 runtime,离屏位图本地取色,不走 IPC)。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Minus, Plus, Maximize, Frame } from 'lucide-react';
import { editorRender } from '../editorBridge';
import { getSession, subscribeSession } from '../editorStore';
import { actualPixelsSession, fitSession, zoomSession } from '../editorViewActions';
import { ZOOM_STEP } from '../viewMath';

const NavigatorTab: React.FC<{ tabId: string }> = ({ tabId }) => {
  const thumbRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const zoomTextRef = useRef<HTMLSpanElement>(null);

  // 缩略图:docId/revision 变化时重拉(降采样)
  useEffect(() => {
    let cancelled = false;
    let lastKey = '';
    const tick = () => {
      const s = getSession(tabId);
      if (cancelled || !s || s.docId == null) return;
      const key = `${s.docId}:${s.revision}`;
      if (key !== lastKey) {
        lastKey = key;
        void editorRender(s.docId, 232, 150)
          .then((bmp) => {
            if (cancelled) return;
            const cv = thumbRef.current;
            if (!cv) return;
            cv.width = bmp.width;
            cv.height = bmp.height;
            const ctx = cv.getContext('2d');
            if (ctx) ctx.putImageData(new ImageData(bmp.rgba, bmp.width, bmp.height), 0, 0);
          })
          .catch(() => undefined);
      }
    };
    tick();
    const un = subscribeSession(tabId, tick);
    return () => {
      cancelled = true;
      un();
    };
  }, [tabId]);

  // 视口红框 + 缩放百分比:rAF 轮询(视图变换不触发 React 更新)
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const s = getSession(tabId);
      const cv = thumbRef.current;
      const box = boxRef.current;
      const zoomText = zoomTextRef.current;
      if (s && s.state && cv && box && cv.clientWidth > 0) {
        const { view } = s.runtime;
        // 缩略图布局像素 ↔ 文档像素
        const k = cv.clientWidth / s.state.width;
        const w = Math.min(cv.clientWidth, (s.runtime.viewW / view.scale) * k);
        const h = Math.min(cv.clientHeight, (s.runtime.viewH / view.scale) * k);
        box.style.width = `${Math.max(4, w)}px`;
        box.style.height = `${Math.max(4, h)}px`;
        box.style.left = `${Math.max(0, Math.min(cv.clientWidth - w, (-view.ox / view.scale) * k))}px`;
        box.style.top = `${Math.max(0, Math.min(cv.clientHeight - h, (-view.oy / view.scale) * k))}px`;
        if (zoomText) zoomText.textContent = `${Math.round(view.scale * 100)}%`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [tabId]);

  return (
    <div className="flex flex-col gap-1.5 p-2">
      <div className="bg-[#1b1b1b] rounded border border-neutral-800 h-[150px] flex items-center justify-center overflow-hidden">
        <div className="relative inline-block leading-none">
          <canvas ref={thumbRef} className="max-w-[220px] max-h-[142px]" />
          <div ref={boxRef} className="absolute border border-red-500/90 pointer-events-none" style={{ left: 0, top: 0 }} />
        </div>
      </div>
      <div className="flex items-center gap-1">
        <button onClick={() => zoomSession(tabId, 1 / ZOOM_STEP)} className="p-1 text-neutral-400 hover:text-neutral-100" title="缩小">
          <Minus size={13} />
        </button>
        <span ref={zoomTextRef} className="text-[11px] text-neutral-300 w-12 text-center">100%</span>
        <button onClick={() => zoomSession(tabId, ZOOM_STEP)} className="p-1 text-neutral-400 hover:text-neutral-100" title="放大">
          <Plus size={13} />
        </button>
        <div className="flex-1" />
        <button onClick={() => fitSession(tabId)} className="p-1 text-neutral-400 hover:text-neutral-100" title="适合屏幕">
          <Maximize size={13} />
        </button>
        <button onClick={() => actualPixelsSession(tabId)} className="p-1 text-neutral-400 hover:text-neutral-100" title="实际像素 (100%)">
          <Frame size={13} />
        </button>
      </div>
    </div>
  );
};

const InfoTab: React.FC<{ tabId: string }> = ({ tabId }) => {
  const [info, setInfo] = useState<{ x: number; y: number; rgb: [number, number, number] | null } | null>(null);
  const infoRef = useRef(info);
  infoRef.current = info;

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      if (t - last > 66) {
        last = t;
        const s = getSession(tabId);
        const p = s?.runtime.pointerDoc;
        if (s && s.state && p) {
          const rs = s.runtime.rasterScale;
          const cv = s.runtime.offscreen;
          const px = Math.floor(p.x * rs);
          const py = Math.floor(p.y * rs);
          let rgb: [number, number, number] | null = null;
          if (cv && px >= 0 && py >= 0 && px < cv.width && py < cv.height) {
            const ctx = cv.getContext('2d');
            const d = ctx?.getImageData(px, py, 1, 1).data;
            if (d) rgb = [d[0], d[1], d[2]];
          }
          const next = { x: Math.floor(p.x), y: Math.floor(p.y), rgb };
          const prev = infoRef.current;
          if (!prev || prev.x !== next.x || prev.y !== next.y || prev.rgb?.join() !== next.rgb?.join()) {
            infoRef.current = next;
            setInfo(next);
          }
        } else if (infoRef.current) {
          infoRef.current = null;
          setInfo(null);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [tabId]);

  const s = getSession(tabId);
  const sel = s?.state?.selectionBounds;

  return (
    <div className="p-2 space-y-1 text-[11px] text-neutral-300 font-mono">
      <div className="flex justify-between">
        <span className="text-neutral-500">X / Y</span>
        <span>{info ? `${info.x}, ${info.y}` : '—'}</span>
      </div>
      <div className="flex justify-between items-center">
        <span className="text-neutral-500">R / G / B</span>
        <span className="flex items-center gap-1.5">
          {info?.rgb && <span className="w-3 h-3 rounded-sm border border-neutral-600 inline-block" style={{ background: `rgb(${info.rgb.join(',')})` }} />}
          <span>{info?.rgb ? info.rgb.join(', ') : '—'}</span>
        </span>
      </div>
      <div className="flex justify-between">
        <span className="text-neutral-500">文档</span>
        <span>{s?.state ? `${s.state.width} × ${s.state.height}` : '—'}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-neutral-500">选区</span>
        <span>{sel ? `${sel[2]} × ${sel[3]}` : '—'}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-neutral-500">文档名</span>
        <span className="truncate max-w-[140px]" title={s?.state?.name ?? ''}>{s?.state?.name ?? '—'}</span>
      </div>
    </div>
  );
};

export const NavigatorInfoPanel: React.FC<{ tabId: string }> = ({ tabId }) => {
  const [tab, setTab] = useState<'nav' | 'info'>('nav');
  return (
    <div className="border-b border-neutral-800 shrink-0">
      <div className="flex border-b border-neutral-800">
        {([['nav', '导航器'], ['info', '信息']] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-3 py-1 text-[11px] ${tab === k ? 'text-neutral-100 border-b-2 border-sky-500' : 'text-neutral-500 hover:text-neutral-300'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'nav' ? <NavigatorTab tabId={tabId} /> : <InfoTab tabId={tabId} />}
    </div>
  );
};
