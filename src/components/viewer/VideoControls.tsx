import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FileNode } from '../../types';
import { useScrubSeek } from '../../hooks/useScrubSeek';
import { runAssetProbe } from '../../utils/scrubProbe';
import {
  mpvPollState, mpvTogglePlay, mpvSeekAbsolute, mpvSeekRelative, mpvFrameStep,
  mpvSetVolume, mpvSetMuted, mpvSetLoop, mpvSetSpeed, mpvShowVolumePopup,
} from '../../utils/mpvPlayer';
import {
  Play, Pause, StepBack, StepForward, Rewind, FastForward,
  Volume2, Volume1, VolumeX, Repeat, Maximize, Minimize,
} from 'lucide-react';

/**
 * 视频控制条（单行）。
 *
 * 设计依据：docs/视频播放UI设计.md
 *  - §2 控制条分组：传输（播放/暂停 · 上一帧 · 下一帧）· 跳转（±5s）·
 *       进度（当前时间 · 进度条 · 总时长）· 进度条右侧（倍速 · 静音 · 循环 · 全屏）。
 *       音量是**悬停静音按钮才出现的竖排弹窗**，不常驻控制条 —— 常驻横条会把宽度
 *       从进度条上抢走（指挥官 2026-10-16）
 *  - §3 实现要点：拖拽中**画面跟着进度走**（节流 seek，见 hooks/useScrubSeek）；
 *       无 fps 时逐帧按钮置灰（不按 1/30 猜，§1.3）
 *  - 进度条必须显示缓冲进度：总文档 §3.2 的 1MB 分片上限会让大文件 seek 有等待，
 *       没有缓冲反馈会被当成卡死
 *
 * 说明：本组件只负责「控制条」本身；`<video>` 元素由统一容器 ImageViewer 渲染，
 * 通过 videoRef 共享。逐帧等键位由 ImageViewer 的全局键盘处理统一驱动（§4）。
 */

const RATES = [0.5, 1, 1.25, 1.5, 2];

const formatTime = (sec: number): string => {
  if (!isFinite(sec) || sec < 0) return '00:00';
  const total = Math.floor(sec);
  const s = total % 60;
  const m = Math.floor((total / 60) % 60);
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

interface VideoControlsProps {
  videoRef: React.RefObject<HTMLVideoElement>;
  file: FileNode;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  /** 翻译函数（与 ImageViewer 同一套；App 层定义后经 props 透传） */
  t: (key: string) => string;
  /** 拖拽进度条状态回传：拖拽中尚未 seek（§3），容器据此隐藏中央缓冲遮罩 */
  onScrubbingChange?: (scrubbing: boolean) => void;
  /** P4/S1：mpv 模式（本地 + WebView2 解不动的编码/容器）。
   *  true 时状态来自 mpv 轮询、操作直接下 mpv 命令；<video> 元素是空壳不读。 */
  mpvMode?: boolean;
}

export const VideoControls: React.FC<VideoControlsProps> = ({
  videoRef,
  file,
  isFullscreen,
  onToggleFullscreen,
  t,
  onScrubbingChange,
  mpvMode = false,
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState(false);
  // 拖拽中画面跟着走（节流 seek），松手把最终位置落地
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubValue, setScrubValue] = useState(0);
  const scrubbingRef = useRef(false);
  const scrubValueRef = useRef(0);
  /** mpv 拖拽节流 seek 的上次触发时刻（<video> 路径走 useScrubSeek，不共用） */
  const mpvScrubLastRef = useRef(0);
  const { scheduleScrub, flushScrub } = useScrubSeek(videoRef);

  const frameRate = file.meta?.frameRate;
  // mpv 有原生 frame-step，不依赖 fps 元数据
  const canStepFrame = mpvMode || (typeof frameRate === 'number' && frameRate > 0);

  // ── P4/S1：mpv 轮询（250ms）驱动全部状态显示 ──
  // S2 会换成 mpv observe 事件推送；S1 轮询足够（本地进程内调用，开销可忽略）。
  useEffect(() => {
    if (!mpvMode) return;
    let alive = true;
    const tick = async () => {
      const st = await mpvPollState();
      if (!alive || !st) return;
      setIsPlaying(!st.paused && !st.idle);
      setCurrentTime(st.timePos ?? 0);
      setDuration(st.duration ?? 0);
      setVolume(Math.max(0, Math.min(1, st.volume / 100)));
      setMuted(st.muted);
      setRate(st.speed > 0 ? st.speed : 1);
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, 250);
    return () => { alive = false; clearInterval(timer); };
  }, [mpvMode]);

  // dev 诊断：打开视频时跑一次 asset 协议探针（一次会话只跑一次，产物见应用日志目录）
  // mpv 模式不读 asset 协议，无需探测
  useEffect(() => {
    if (mpvMode) return;
    if (import.meta.env.DEV && file.path) void runAssetProbe(file.path, file.size ?? 0);
  }, [file.path, file.size, mpvMode]);

  // 读取当前播放位置所在缓冲区间末尾（total buffered 到哪），用于进度条的缓冲底条
  const readBufferedEnd = useCallback((): number => {
    const v = videoRef.current;
    if (!v || v.buffered.length === 0) return 0;
    const t = v.currentTime;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= t && t <= v.buffered.end(i)) return v.buffered.end(i);
    }
    return v.buffered.end(v.buffered.length - 1);
  }, [videoRef]);

  // 绑定视频元素事件，并同步初始瞬时状态
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    setIsPlaying(!v.paused && !v.ended);
    setCurrentTime(v.currentTime);
    setDuration(isFinite(v.duration) ? v.duration : 0);
    setVolume(v.volume);
    setMuted(v.muted);
    setRate(v.playbackRate);
    setLoop(v.loop);
    setBufferedEnd(readBufferedEnd());

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => setIsPlaying(false);
    const onTimeUpdate = () => {
      if (!scrubbingRef.current) setCurrentTime(v.currentTime);
      setBufferedEnd(readBufferedEnd());
    };
    const onDuration = () => {
      setDuration(isFinite(v.duration) ? v.duration : 0);
      setBufferedEnd(readBufferedEnd());
    };
    const onProgress = () => setBufferedEnd(readBufferedEnd());
    const onVolume = () => { setVolume(v.volume); setMuted(v.muted); };
    const onRate = () => setRate(v.playbackRate);

    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onEnded);
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('durationchange', onDuration);
    v.addEventListener('loadedmetadata', onDuration);
    v.addEventListener('progress', onProgress);
    v.addEventListener('volumechange', onVolume);
    v.addEventListener('ratechange', onRate);

    return () => {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onEnded);
      v.removeEventListener('timeupdate', onTimeUpdate);
      v.removeEventListener('durationchange', onDuration);
      v.removeEventListener('loadedmetadata', onDuration);
      v.removeEventListener('progress', onProgress);
      v.removeEventListener('volumechange', onVolume);
      v.removeEventListener('ratechange', onRate);
    };
  }, [videoRef, readBufferedEnd, file.id]);

  const togglePlay = async () => {
    if (mpvMode) { await mpvTogglePlay(); return; }
    const v = videoRef.current;
    if (!v) return;
    try {
      if (v.paused) await v.play();
      else v.pause();
    } catch {
      // ignore（自动播放策略 / 解码失败）
    }
  };

  // 逐帧：pause 后 currentTime ± 1/fps；无 fps 时调用方已置灰（§1.3）
  // mpv：原生 frame-step / frame-back-step（暂停态下逐帧，不依赖 fps 元数据）
  const stepFrame = (dir: 1 | -1) => {
    if (mpvMode) { void mpvFrameStep(dir); return; }
    const v = videoRef.current;
    if (!v || !canStepFrame) return;
    v.pause();
    const next = v.currentTime + dir / (frameRate as number);
    const max = isFinite(v.duration) ? v.duration : next;
    v.currentTime = Math.max(0, Math.min(next, max));
    setCurrentTime(v.currentTime);
  };

  const nudge = (delta: number) => {
    if (mpvMode) { void mpvSeekRelative(delta); return; }
    const v = videoRef.current;
    if (!v) return;
    const max = isFinite(v.duration) ? v.duration : v.currentTime + Math.abs(delta);
    const next = Math.max(0, Math.min(v.currentTime + delta, max));
    v.currentTime = next;
    setCurrentTime(next);
  };

  const changeVolume = (val: number) => {
    if (mpvMode) { void mpvSetVolume(val); return; }
    const v = videoRef.current;
    if (!v) return;
    const clamped = Math.max(0, Math.min(1, val));
    v.volume = clamped;
    v.muted = clamped === 0;
  };

  // ── 悬停弹窗的竖排音量 ──
  // 上 = 1.0、下 = 0；按下即拖，pointer capture 保证指针滑出滑条也继续跟随。
  // 不占控制条宽度，也不参与全局键位（↑ ↓ 仍由 ImageViewer 调音量）。
  const volumeTrackRef = useRef<HTMLDivElement>(null);
  const volumeDraggingRef = useRef(false);
  const applyVolumeAt = (clientY: number) => {
    const el = volumeTrackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0) return;
    const ratio = 1 - (clientY - rect.top) / rect.height;
    changeVolume(Math.round(ratio * 100) / 100);
  };
  const beginVolumeDrag = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    volumeDraggingRef.current = true;
    applyVolumeAt(e.clientY);
  };
  const moveVolumeDrag = (e: React.PointerEvent) => {
    if (volumeDraggingRef.current) applyVolumeAt(e.clientY);
  };
  const endVolumeDrag = () => { volumeDraggingRef.current = false; };

  const toggleMute = () => {
    if (mpvMode) { void mpvSetMuted(!muted); return; }
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
  };

  // mpv 模式：点击静音按钮 = 弹/关自绘竖排音量弹窗（按钮上方，原生窗 z-order 在
  // mpv 画面 popup 之上，完全可见可拖；拖动由 Rust 直接下发 mpv volume，UI 轮询回读）。
  // ⚠️ anchor 必须是**客户区**物理像素 —— Rust 侧做 ClientToScreen（早期版本把它
  // 当屏幕坐标用，弹窗会飘到别的窗口/别的屏幕上，2026-10-21 修）。
  const muteBtnRef = useRef<HTMLButtonElement>(null);
  const handleShowVolumePopup = () => {
    const btn = muteBtnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const dark = document.documentElement.classList.contains('dark');
    void mpvShowVolumePopup(
      Math.round((r.left + r.width / 2) * dpr),
      Math.round(r.top * dpr),
      muted ? 0 : Math.round(volume * 100),
      dark,
      dpr,
    );
  };

  const cycleRate = () => {
    const idx = RATES.indexOf(rate);
    const next = RATES[(idx + 1) % RATES.length];
    if (mpvMode) {
      // mpv speed 属性（轮询会回读确认）；立即 setRate 给按钮即时反馈
      void mpvSetSpeed(next);
      setRate(next);
      return;
    }
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = next;
  };

  const toggleLoop = () => {
    if (mpvMode) {
      const next = !loop;
      setLoop(next);
      void mpvSetLoop(next);
      return;
    }
    const v = videoRef.current;
    if (!v) return;
    v.loop = !v.loop;
    setLoop(v.loop);
  };

  // 进度条拖拽：按下进入拖拽态，拖动期间节流 seek（画面跟着进度走），松手把最终位置落地
  const beginScrub = () => {
    const v = videoRef.current;
    const t = v ? v.currentTime : 0;
    scrubbingRef.current = true;
    scrubValueRef.current = t;
    setScrubValue(t);
    setIsScrubbing(true);
    // 拖拽期间压掉中央缓冲遮罩：拖出缓冲会反复进 waiting，遮罩跟着闪（§14.7 ③ 那个老问题）
    onScrubbingChange?.(true);
  };
  // 非有限值必须挡住，否则 NaN 会把时间文字与进度条一起抖坏
  const onScrubChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = Number(e.target.value);
    if (!isFinite(raw)) return;
    const max = duration > 0 ? duration : raw;
    const val = Math.max(0, Math.min(raw, max));
    scrubValueRef.current = val;
    setScrubValue(val);
    if (mpvMode) {
      // mpv：拖拽中节流 seek（画面跟着走，§3）；mpv seek 足够快，200ms 间隔不闪跳
      const now = performance.now();
      if (now - mpvScrubLastRef.current >= 200) {
        mpvScrubLastRef.current = now;
        void mpvSeekAbsolute(val);
      }
      return;
    }
    scheduleScrub(val);
  };
  const endScrub = useCallback(() => {
    if (!scrubbingRef.current) return;
    // 先解除 scrubbing 标记再 seek：seeking 事件（异步派发）到达时不应被拖拽态吞掉，
    // 从而让松手后的真实 seek 等待照常显示
    scrubbingRef.current = false;
    const val = scrubValueRef.current;
    if (mpvMode) void mpvSeekAbsolute(val);
    else flushScrub(val);
    setCurrentTime(val);
    setIsScrubbing(false);
    onScrubbingChange?.(false);
  }, [flushScrub, onScrubbingChange, mpvMode]);

  // 松手事件可能落在控件外，兜住指针释放
  useEffect(() => {
    if (!isScrubbing) return;
    const up = () => endScrub();
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [isScrubbing, endScrub]);

  const displayTime = isScrubbing ? scrubValue : currentTime;
  const dur = duration > 0 ? duration : 0;
  const playedPct = dur > 0 ? Math.min(100, (displayTime / dur) * 100) : 0;
  const bufferedPct = dur > 0 ? Math.min(100, (bufferedEnd / dur) * 100) : 0;

  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const volumePct = Math.round((muted ? 0 : volume) * 100);

  const iconBtn = 'p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed';

  return (
    <div className={`h-12 shrink-0 flex items-center gap-1.5 px-4 border-t text-gray-700 dark:text-gray-200 z-30 ${
      isFullscreen ? 'bg-black border-white/10' : 'bg-white dark:bg-[#262626] border-gray-200 dark:border-gray-800'
    }`}>
      {/* 传输：播放/暂停（主按钮）· 上一帧 · 下一帧 */}
      <button onClick={togglePlay} className={iconBtn} title={isPlaying ? t('video.pause') : t('video.play')}>
        {isPlaying ? <Pause size={18} /> : <Play size={18} />}
      </button>
      <button
        onClick={() => stepFrame(-1)}
        disabled={!canStepFrame}
        className={iconBtn}
        title={canStepFrame ? t('video.prevFrame') : t('video.frameUnavailable')}
      >
        <StepBack size={16} />
      </button>
      <button
        onClick={() => stepFrame(1)}
        disabled={!canStepFrame}
        className={iconBtn}
        title={canStepFrame ? t('video.nextFrame') : t('video.frameUnavailable')}
      >
        <StepForward size={16} />
      </button>

      {/* 跳转：后退 5s · 前进 5s */}
      <button onClick={() => nudge(-5)} className={iconBtn} title={t('video.back5s')}>
        <Rewind size={16} />
      </button>
      <button onClick={() => nudge(5)} className={iconBtn} title={t('video.forward5s')}>
        <FastForward size={16} />
      </button>

      {/* 进度：当前时间 · 进度条 · 总时长 */}
      {/* 拖拽中的反馈用静态样式（高亮时间文字），不用转圈动画（§3） */}
      <span className={`text-xs tabular-nums w-14 text-right select-none ${isScrubbing ? 'text-blue-500 font-medium' : ''}`}>{formatTime(displayTime)}</span>
      <div className="relative flex-1 h-5 flex items-center">
        <div className="absolute inset-x-0 h-1 rounded-full bg-gray-300 dark:bg-gray-700" />
        {/* 缓冲进度（浅色底条）：大文件 seek 等待的反馈 */}
        <div className="absolute left-0 h-1 rounded-full bg-gray-400 dark:bg-gray-500" style={{ width: `${bufferedPct}%` }} />
        <div className="absolute left-0 h-1 rounded-full bg-blue-500" style={{ width: `${playedPct}%` }} />
        <div
          className="absolute w-3 h-3 rounded-full bg-blue-500 border border-white dark:border-[#262626] shadow pointer-events-none"
          style={{ left: `calc(${playedPct}% - 6px)` }}
        />
        <input
          type="range"
          min={0}
          max={dur || 0}
          step={0.01}
          value={dur > 0 ? displayTime : 0}
          tabIndex={-1}
          // 点过进度条后它会持有焦点：原生 range 会用 ← →/Home/End 挪自己的值，
          // 与全局键位（← → = 快退/快进 5s）打架。只挡默认行为、不阻止冒泡，
          // 让键位继续交给 ImageViewer 的全局处理（§4）。
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
              e.preventDefault();
            }
          }}
          // 拖拽中只更新时间文字，松手（pointerup）才 seek（§3）
          onPointerDown={beginScrub}
          onChange={onScrubChange}
          onPointerUp={endScrub}
          onPointerCancel={endScrub}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          aria-label={t('video.progress')}
        />
      </div>
      <span className="text-xs tabular-nums w-14 select-none">{formatTime(dur)}</span>

      {/* 倍速：紧跟进度条右侧。定宽 w-12 是按最宽的「1.25x」算的（换档时不推挤后面的按钮），
          文字左对齐 —— 否则居中会让它的字形比左侧图标按钮多内缩约 9px，进度条两侧间距就不等了。
          mpv 模式走 speed 属性（S2 起）。 */}
      <button onClick={cycleRate} className="px-2 py-1 text-xs text-left rounded hover:bg-gray-100 dark:hover:bg-gray-800 tabular-nums w-12 shrink-0" title={t('video.rate')}>
        {rate}x
      </button>

      {/* 静音按钮 + 悬停音量条。横向音量条不再常驻控制条 —— 它从进度条上抢宽度 */}
      <div className="relative group shrink-0">
        <button
          ref={muteBtnRef}
          onClick={mpvMode ? handleShowVolumePopup : toggleMute}
          className={iconBtn}
          title={mpvMode ? t('video.volume') : (muted ? t('video.unmute') : t('video.mute'))}
        >
          <VolumeIcon size={16} />
        </button>
        {/* mpv 模式：竖排弹窗必然伸进媒体区，被 popup 盖住（airspace 反转）。
            改为**原生竖排音量弹窗**（Win32 trackbar，z-order 在 popup 之上，
            完全可见可拖；点击按钮弹出/关闭，拖动由 Rust 直接下发 mpv volume）。
            <video> 模式保持竖排弹窗不变（2026-10-16 指挥官定的样式）。 */}
        {mpvMode ? (
          <div className="pointer-events-none" />
        ) : (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 hidden group-hover:flex flex-col items-center pb-1">
          <div className="px-2 py-2 rounded-lg bg-white dark:bg-[#3a3a3a] border border-gray-200 dark:border-gray-700 shadow-lg">
            {/* 竖排音量自绘，不用原生 range：index.css 的全局 range 样式是按横排写的
                （track 高 4px、thumb 靠负 margin 居中），竖排得整套改写，不值当 */}
            <div
              ref={volumeTrackRef}
              role="slider"
              aria-orientation="vertical"
              aria-label={t('video.volume')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={volumePct}
              className="relative w-5 h-24 cursor-pointer select-none touch-none"
              onPointerDown={beginVolumeDrag}
              onPointerMove={moveVolumeDrag}
              onPointerUp={endVolumeDrag}
              onPointerCancel={endVolumeDrag}
            >
              <div className="absolute left-1/2 -translate-x-1/2 inset-y-0 w-1 rounded-full bg-gray-300 dark:bg-gray-600" />
              <div className="absolute left-1/2 -translate-x-1/2 bottom-0 w-1 rounded-full bg-blue-500" style={{ height: `${volumePct}%` }} />
              <div
                className="absolute left-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-blue-500 border border-white dark:border-[#262626] shadow pointer-events-none"
                style={{ bottom: `calc(${volumePct}% - 6px)` }}
              />
            </div>
          </div>
        </div>
        )}
      </div>
      <button
        onClick={toggleLoop}
        className={`p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 ${loop ? 'text-blue-500' : 'text-gray-600 dark:text-gray-300'}`}
        title={t('video.loop')}
      >
        <Repeat size={16} />
      </button>
      <button onClick={onToggleFullscreen} className={iconBtn} title={isFullscreen ? t('video.exitFullscreen') : t('video.fullscreen')}>
        {isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
      </button>
    </div>
  );
};
