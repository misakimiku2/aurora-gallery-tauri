import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FileNode } from '../../types';
import {
  Play, Pause, StepBack, StepForward, Rewind, FastForward,
  Volume2, Volume1, VolumeX, Repeat, Maximize, Minimize, Loader2,
} from 'lucide-react';

/**
 * 视频控制条（单行）。
 *
 * 设计依据：docs/视频播放UI设计.md
 *  - §2 控制条分组：传输（播放/暂停 · 上一帧 · 下一帧）· 跳转（±5s）·
 *       进度（当前时间 · 进度条 · 总时长）· 辅助（静音/音量 · 倍速 · 循环 · 全屏）
 *  - §3 实现要点：拖拽中只更新时间文字，松手才真正 seek（避免连续请求打爆 asset protocol）；
 *       无 fps 时逐帧按钮置灰（不按 1/30 猜，§1.3）
 *  - 进度条必须显示缓冲进度：总文档 §3.2 的 1MB 分片上限会让大文件 seek 有等待，
 *       没有缓冲反馈会被当成卡死
 *
 * 说明：本组件只负责「控制条」本身；`<video>` 元素由统一容器 ImageViewer 渲染，
 * 通过 videoRef 共享。逐帧等键位由 ImageViewer 的全局键盘处理统一驱动（§4）。
 */

const RATES = [0.5, 1, 1.25, 1.5, 2];

// ── 等待状态稳定化参数（详见组件内 applyWaiting 注释）──
// 总文档 §3.2：asset protocol 单次 Range ≤1,024,000 字节，一次 seek/播放会被拆成
// 多次 waiting↔canplay，若把媒体事件直连 boolean，会反复卸载/重挂载 <Loader2>，
// CSS animate-spin 每次从 0° 重播 → 肉眼即「转圈反复跳动」的闪烁。
const WAIT_SHOW_DELAY_MS = 120; // 短于此时长的等待不显示：瞬时 seek 不再闪一下
const WAIT_MIN_SHOW_MS = 320;   // spinner 一旦显示，至少保持此时长：吸收高频抖动

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
}

export const VideoControls: React.FC<VideoControlsProps> = ({
  videoRef,
  file,
  isFullscreen,
  onToggleFullscreen,
  t,
  onScrubbingChange,
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState(false);
  const [isWaiting, setIsWaiting] = useState(false);
  // 拖拽中只更新时间文字，松手才真正 seek（§3）
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubValue, setScrubValue] = useState(0);
  const scrubbingRef = useRef(false);
  const scrubValueRef = useRef(0);

  // 稳定化等待状态的内部记账（配合下方 applyWaiting）
  const waitingRef = useRef(false);          // 当前是否已「显示」等待
  const waitingShownAtRef = useRef(0);       // 显示时刻，用于最短展示时长
  const waitShowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // 延迟显示
  const waitHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // 延迟隐藏

  const frameRate = file.meta?.frameRate;
  const canStepFrame = typeof frameRate === 'number' && frameRate > 0;

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

  // 稳定化的等待状态机（对应 WAIT_SHOW_DELAY_MS / WAIT_MIN_SHOW_MS）：
  //  next=true（waiting/stalled/seeking）→ 延迟 120ms 后显示，期间若 ready 则取消；
  //  next=false（seeked/canplay/playing）→ 已显示的需满足最短展示时长 320ms 才隐藏；
  // 这样既保留真实长等待（大文件 seek）的反馈，又消除高频 true/false 抖动造成的重挂载闪烁。
  const applyWaiting = useCallback((next: boolean) => {
    if (next) {
      // 保持显示：取消待隐藏；已在延迟窗口内则忽略重复事件（避免定时器抖动）
      if (waitHideTimerRef.current) {
        clearTimeout(waitHideTimerRef.current);
        waitHideTimerRef.current = null;
      }
      if (waitingRef.current || waitShowTimerRef.current) return;
      waitShowTimerRef.current = setTimeout(() => {
        waitShowTimerRef.current = null;
        waitingRef.current = true;
        waitingShownAtRef.current = performance.now();
        setIsWaiting(true);
      }, WAIT_SHOW_DELAY_MS);
      return;
    }
    // 等待结束：先取消尚未到点的延迟显示（瞬时 seek 不闪）
    if (waitShowTimerRef.current) {
      clearTimeout(waitShowTimerRef.current);
      waitShowTimerRef.current = null;
    }
    if (!waitingRef.current) return;
    const remain = WAIT_MIN_SHOW_MS - (performance.now() - waitingShownAtRef.current);
    if (remain <= 0) {
      waitingRef.current = false;
      setIsWaiting(false);
    } else if (!waitHideTimerRef.current) {
      waitHideTimerRef.current = setTimeout(() => {
        waitHideTimerRef.current = null;
        waitingRef.current = false;
        setIsWaiting(false);
      }, remain);
    }
  }, []);

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
    // 切换文件时重置稳定化等待状态（清掉上一支视频残留的等待/定时器）
    if (waitShowTimerRef.current) { clearTimeout(waitShowTimerRef.current); waitShowTimerRef.current = null; }
    if (waitHideTimerRef.current) { clearTimeout(waitHideTimerRef.current); waitHideTimerRef.current = null; }
    waitingRef.current = false;
    setIsWaiting(false);

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
    // waiting / stalled / seeking：seek 或网络等待时给反馈（§3「seek 中/缓冲中显示 waiting 状态」）
    // 拖拽中尚未 seek（§3），此刻的 waiting 属播放流下的背景缓冲噪声，不显示 → 消除拖拽期闪烁
    const onWaiting = () => { if (!scrubbingRef.current) applyWaiting(true); };
    const onSeeked = () => applyWaiting(false);
    const onCanPlay = () => applyWaiting(false);
    const onPlaying = () => applyWaiting(false);

    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onEnded);
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('durationchange', onDuration);
    v.addEventListener('loadedmetadata', onDuration);
    v.addEventListener('progress', onProgress);
    v.addEventListener('volumechange', onVolume);
    v.addEventListener('ratechange', onRate);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('stalled', onWaiting);
    v.addEventListener('seeking', onWaiting);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('canplay', onCanPlay);
    v.addEventListener('playing', onPlaying);

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
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('stalled', onWaiting);
      v.removeEventListener('seeking', onWaiting);
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('canplay', onCanPlay);
      v.removeEventListener('playing', onPlaying);
    };
  }, [videoRef, readBufferedEnd, applyWaiting, file.id]);

  // 卸载时清理等待状态定时器，避免在已卸载组件上 setState
  useEffect(() => () => {
    if (waitShowTimerRef.current) clearTimeout(waitShowTimerRef.current);
    if (waitHideTimerRef.current) clearTimeout(waitHideTimerRef.current);
  }, []);

  const togglePlay = async () => {
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
  const stepFrame = (dir: 1 | -1) => {
    const v = videoRef.current;
    if (!v || !canStepFrame) return;
    v.pause();
    const next = v.currentTime + dir / (frameRate as number);
    const max = isFinite(v.duration) ? v.duration : next;
    v.currentTime = Math.max(0, Math.min(next, max));
    setCurrentTime(v.currentTime);
  };

  const nudge = (delta: number) => {
    const v = videoRef.current;
    if (!v) return;
    const max = isFinite(v.duration) ? v.duration : v.currentTime + Math.abs(delta);
    const next = Math.max(0, Math.min(v.currentTime + delta, max));
    v.currentTime = next;
    setCurrentTime(next);
  };

  const changeVolume = (val: number) => {
    const v = videoRef.current;
    if (!v) return;
    const clamped = Math.max(0, Math.min(1, val));
    v.volume = clamped;
    v.muted = clamped === 0;
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
  };

  const cycleRate = () => {
    const v = videoRef.current;
    if (!v) return;
    const idx = RATES.indexOf(v.playbackRate);
    v.playbackRate = RATES[(idx + 1) % RATES.length];
  };

  const toggleLoop = () => {
    const v = videoRef.current;
    if (!v) return;
    v.loop = !v.loop;
    setLoop(v.loop);
  };

  // 进度条拖拽：按下进入暂存态，拖动只更新文字，松手（pointerup）才 seek（§3）
  const beginScrub = () => {
    const v = videoRef.current;
    const t = v ? v.currentTime : 0;
    scrubbingRef.current = true;
    scrubValueRef.current = t;
    setScrubValue(t);
    setIsScrubbing(true);
    // 拖拽尚未 seek（§3），清除任何残留等待态/定时器，并通知容器隐藏中央遮罩
    if (waitShowTimerRef.current) { clearTimeout(waitShowTimerRef.current); waitShowTimerRef.current = null; }
    if (waitHideTimerRef.current) { clearTimeout(waitHideTimerRef.current); waitHideTimerRef.current = null; }
    waitingRef.current = false;
    setIsWaiting(false);
    onScrubbingChange?.(true);
  };
  // 拖拽中只更新时间文字；对非有限值做防护，避免出现 NaN 导致文字/进度条抖动
  const onScrubChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = Number(e.target.value);
    if (!isFinite(raw)) return;
    const max = duration > 0 ? duration : raw;
    const val = Math.max(0, Math.min(raw, max));
    scrubValueRef.current = val;
    setScrubValue(val);
  };
  const endScrub = useCallback(() => {
    if (!scrubbingRef.current) return;
    // 先解除 scrubbing 标记再 seek：seeking 事件（异步派发）到达时不应被拖拽态吞掉，
    // 从而让松手后的真实 seek 等待照常显示
    scrubbingRef.current = false;
    const v = videoRef.current;
    const val = scrubValueRef.current;
    if (v) {
      v.currentTime = val;
      setCurrentTime(val);
    }
    setIsScrubbing(false);
    onScrubbingChange?.(false);
  }, [videoRef, onScrubbingChange]);

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

  const iconBtn = 'p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed';

  return (
    <div className="h-12 shrink-0 flex items-center gap-1.5 px-4 bg-white dark:bg-[#262626] border-t border-gray-200 dark:border-gray-800 text-gray-700 dark:text-gray-200 z-30">
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
          // 不拦截键盘：← → 仍由全局键位接管为「上一个/下一个文件」（U1）；
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

      {/* 缓冲/等待反馈：固定占位宽度，避免出现/消失时控制条整体位移（抖动）；
          拖拽中（未 seek，§3）一律不显示，消除拖拽期闪烁 */}
      <span className="w-[18px] h-[18px] shrink-0 flex items-center justify-center">
        {!isScrubbing && isWaiting && <Loader2 size={14} className="animate-spin text-blue-500" />}
      </span>

      {/* 辅助：静音/音量 · 倍速 · 循环 · 全屏 */}
      <button onClick={toggleMute} className={iconBtn} title={muted ? t('video.unmute') : t('video.mute')}>
        <VolumeIcon size={16} />
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={muted ? 0 : volume}
        tabIndex={-1}
        // 音量条允许方向键原生调节；仅阻止冒泡以免触发全局视频键位
        onKeyDown={(e) => { if (e.key === 'Escape') return; e.stopPropagation(); }}
        onChange={(e) => changeVolume(Number(e.target.value))}
        className="w-16 h-1 accent-blue-500 cursor-pointer shrink-0"
        aria-label={t('video.volume')}
      />
      <button onClick={cycleRate} className="px-2 py-1 text-xs rounded hover:bg-gray-100 dark:hover:bg-gray-800 tabular-nums w-12" title={t('video.rate')}>
        {rate}x
      </button>
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
