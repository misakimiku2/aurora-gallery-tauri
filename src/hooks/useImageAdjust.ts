// 调整参数状态 hook(轻量快调 §7):加载/编辑/撤销/防抖持久化。
//
// - 撤销 = 参数对象快照栈(上限 50 步,纯对象切换,零像素缓冲——验收口径 1);
// - 持久化防抖 500ms:全默认 → editClearParams(不落行),否则 editSetParams;
// - 每次保存同步 adjustStore(网格角标 + AVIF 兜底缩略图联动)并失效该路径
//   缩略图内存缓存(下次请求按新 adjust_tag 键重生成)。

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AdjustCropNorm,
  AdjustParams,
  ADJUST_DEFAULT,
  autoEnhanceFromStats,
  cloneDefault,
  isDefaultAdjustParams,
  sanitizeAdjustParams,
} from '../utils/adjust';
import { setAdjustParams } from '../utils/adjustStore';
import { invalidateAdjustedThumbnail } from '../api/tauri-bridge/thumbnail';
import { editClearParams, editGetParams, editSetParams } from '../api/tauri-bridge/edits';
import { AutoEnhanceStats } from '../utils/adjustCanvasDraw';

const HISTORY_LIMIT = 50;
const PERSIST_DEBOUNCE_MS = 500;
const HISTORY_MERGE_MS = 400;

export interface ImageAdjustApi {
  params: AdjustParams;
  loaded: boolean;
  isDirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  setToneParam: (key: keyof AdjustParams['tone'], value: number) => void;
  setStraighten: (deg: number) => void;
  rotateBy: (steps: number) => void;
  toggleFlip: (axis: 'h' | 'v') => void;
  setCropNorm: (crop: AdjustCropNorm | null) => void;
  applyAutoEnhance: (stats: AutoEnhanceStats) => void;
  resetAll: () => void;
  undo: () => void;
  redo: () => void;
}

export function useImageAdjust(fileId: string | undefined, filePath: string | undefined, enabled: boolean): ImageAdjustApi {
  const [params, setParams] = useState<AdjustParams>(ADJUST_DEFAULT);
  const [loaded, setLoaded] = useState(false);
  const [historyTick, setHistoryTick] = useState(0);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  // 撤销/重做栈(ref 存,避免每步渲染整栈)
  const pastRef = useRef<AdjustParams[]>([]);
  const futureRef = useRef<AdjustParams[]>([]);
  const lastHistoryAtRef = useRef(0);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyRef = useRef(false);

  const pushHistory = useCallback(() => {
    const now = Date.now();
    // 滑杆连续拖动合并为一步(400ms 内的快照不重复压栈)
    if (now - lastHistoryAtRef.current > HISTORY_MERGE_MS) {
      pastRef.current.push(paramsRef.current);
      if (pastRef.current.length > HISTORY_LIMIT) pastRef.current.shift();
      futureRef.current = [];
      lastHistoryAtRef.current = now;
      setHistoryTick((t) => t + 1);
    }
  }, []);

  const schedulePersist = useCallback(
    (fileIdVal: string, path: string | undefined, next: AdjustParams) => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      persistTimerRef.current = setTimeout(() => {
        if (isDefaultAdjustParams(next)) {
          editClearParams(fileIdVal)
            .then(() => {
              setAdjustParams(path, null);
              if (path) invalidateAdjustedThumbnail(path);
            })
            .catch((e) => console.warn('[adjust] clear failed:', e));
        } else {
          editSetParams(fileIdVal, next)
            .then(() => {
              setAdjustParams(path, next);
              if (path) invalidateAdjustedThumbnail(path);
            })
            .catch((e) => console.warn('[adjust] save failed:', e));
        }
      }, PERSIST_DEBOUNCE_MS);
    },
    []
  );

  // 加载:fileId 变化 → 拉取参数,重置栈与脏标记;卸载/换图时冲销未落盘的持久化
  useEffect(() => {
    if (!enabled || !fileId) {
      setLoaded(false);
      return;
    }
    let cancelled = false;
    setLoaded(false);
    pastRef.current = [];
    futureRef.current = [];
    lastHistoryAtRef.current = 0;
    dirtyRef.current = false;
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    editGetParams(fileId)
      .then((json) => {
        if (cancelled) return;
        const next = json ? sanitizeAdjustParams(JSON.parse(json)) : cloneDefault();
        setParams(next);
        dirtyRef.current = !isDefaultAdjustParams(next);
        setAdjustParams(filePath, isDefaultAdjustParams(next) ? null : next);
        setLoaded(true);
      })
      .catch((e) => {
        console.warn('[adjust] load failed:', e);
        if (!cancelled) {
          setParams(cloneDefault());
          dirtyRef.current = false;
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, fileId]);

  // 组件卸载兜底:冲销未落盘的防抖持久化
  useEffect(() => {
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, []);

  const applyEdit = useCallback(
    (mutate: (p: AdjustParams) => AdjustParams) => {
      const fileIdVal = fileId;
      if (!enabled || !fileIdVal) return;
      pushHistory();
      const next = sanitizeAdjustParams(mutate(paramsRef.current));
      setParams(next);
      dirtyRef.current = true;
      schedulePersist(fileIdVal, filePath, next);
    },
    [enabled, fileId, filePath, pushHistory, schedulePersist]
  );

  const setToneParam = useCallback(
    (key: keyof AdjustParams['tone'], value: number) => {
      applyEdit((p) => ({ ...p, tone: { ...p.tone, [key]: value } }));
    },
    [applyEdit]
  );

  const setStraighten = useCallback(
    (deg: number) => {
      applyEdit((p) => ({ ...p, geo: { ...p.geo, straightenDeg: deg } }));
    },
    [applyEdit]
  );

  const rotateBy = useCallback(
    (steps: number) => {
      applyEdit((p) => ({
        ...p,
        geo: { ...p.geo, rotate90: (((p.geo.rotate90 + steps) % 4) + 4) % 4 },
      }));
    },
    [applyEdit]
  );

  const toggleFlip = useCallback(
    (axis: 'h' | 'v') => {
      applyEdit((p) =>
        axis === 'h'
          ? { ...p, geo: { ...p.geo, flipH: !p.geo.flipH } }
          : { ...p, geo: { ...p.geo, flipV: !p.geo.flipV } }
      );
    },
    [applyEdit]
  );

  const setCropNorm = useCallback(
    (crop: AdjustCropNorm | null) => {
      applyEdit((p) => ({ ...p, geo: { ...p.geo, cropNorm: crop } }));
    },
    [applyEdit]
  );

  const applyAutoEnhance = useCallback(
    (stats: AutoEnhanceStats) => {
      const tone = autoEnhanceFromStats(stats.p2, stats.p98, stats.meanR, stats.meanG, stats.meanB);
      applyEdit((p) => ({ ...p, tone }));
    },
    [applyEdit]
  );

  const resetAll = useCallback(() => {
    applyEdit(() => cloneDefault());
  }, [applyEdit]);

  const undo = useCallback(() => {
    const prev = pastRef.current.pop();
    if (!prev || !fileId) return;
    futureRef.current.push(paramsRef.current);
    lastHistoryAtRef.current = 0;
    setHistoryTick((t) => t + 1);
    setParams(prev);
    schedulePersist(fileId, filePath, prev);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, filePath, schedulePersist]);

  const redo = useCallback(() => {
    const next = futureRef.current.pop();
    if (!next || !fileId) return;
    pastRef.current.push(paramsRef.current);
    lastHistoryAtRef.current = 0;
    setHistoryTick((t) => t + 1);
    setParams(next);
    schedulePersist(fileId, filePath, next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, filePath, schedulePersist]);

  return {
    params,
    loaded,
    isDirty: dirtyRef.current,
    canUndo: pastRef.current.length > 0 || historyTick < 0, // historyTick 仅触发重渲染
    canRedo: futureRef.current.length > 0,
    setToneParam,
    setStraighten,
    rotateBy,
    toggleFlip,
    setCropNorm,
    applyAutoEnhance,
    resetAll,
    undo,
    redo,
  };
}
