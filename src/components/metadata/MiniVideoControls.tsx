import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, RefObject } from 'react';
import { Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { isTextEditingTarget } from '../../utils/keyboardTarget';

/**
 * 右侧面板「就地播放」小窗的迷你控制条（2026-10-16，指挥官实机反馈后重设计）。
 *
 * 设计约束（指挥官指定）：小窗只保留 **播放/暂停 · 进度条 · 静音** ——
 * 不要查看器 VideoControls 的全套（逐帧 / ±5s / 倍速 / 循环 / 全屏 / 音量条），
 * 原生 `<video controls>` 的浏览器控件对这个小窗来说太繁杂。
 *
 * 沿用 viewer/VideoControls 的两个既有范式（避免重复踩坑）：
 *  - 进度条 = 视觉层（轨道 / 已播放 / 圆点）+ 透明 native range 交互层（键盘/拖动免费获得）；
 *  - **拖拽中只更新时间文字，松手（pointerup）才真正 seek**（UI 设计 §3：asset protocol
 *    单次 Range ≤1MiB，连续 seek 会把请求打爆）；松手可能落在控件外 → window 级兜底。
 *
 * `<video>` 由父组件（ImagePreview）渲染并经 videoRef 注入（与查看器同一模式）。
 * 视觉面向黑底视频：白色系小控件 + 底部渐变压暗。
 */
interface MiniVideoControlsProps {
    videoRef: RefObject<HTMLVideoElement>;
    t?: (key: string) => string;
    /** 查看器正开着视频：空格键归查看器（其 isVideo 分支会 preventDefault），小窗不抢（防双触发） */
    viewerVideoOpen?: boolean;
}

/** 与 viewer/VideoControls 的 formatTime 同规则（mm:ss / h:mm:ss），保证全站时间显示一致 */
const formatClock = (sec: number): string => {
    if (!isFinite(sec) || sec < 0) return '00:00';
    const total = Math.floor(sec);
    const s = total % 60;
    const m = Math.floor((total / 60) % 60);
    const h = Math.floor(total / 3600);
    const pad = (n: number) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
};

export const MiniVideoControls = ({ videoRef, t, viewerVideoOpen }: MiniVideoControlsProps) => {
    const tr = (key: string, fallback: string) => (t ? t(key) : fallback);

    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [muted, setMuted] = useState(false);
    // 拖拽中只更新时间文字，松手才 seek（与查看器同策略）
    const [isScrubbing, setIsScrubbing] = useState(false);
    const [scrubValue, setScrubValue] = useState(0);
    const scrubbingRef = useRef(false);
    const scrubValueRef = useRef(0);

    // 绑定视频事件 + 同步初始瞬时状态（autoPlay 的 play 事件异步到达，这里先读当前真值）
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;

        setIsPlaying(!v.paused && !v.ended);
        setCurrentTime(v.currentTime);
        setDuration(isFinite(v.duration) ? v.duration : 0);
        setMuted(v.muted);

        const onPlay = () => setIsPlaying(true);
        const onPause = () => setIsPlaying(false);
        const onEnded = () => setIsPlaying(false);
        const onTimeUpdate = () => { if (!scrubbingRef.current) setCurrentTime(v.currentTime); };
        const onDuration = () => setDuration(isFinite(v.duration) ? v.duration : 0);
        const onVolume = () => setMuted(v.muted);

        v.addEventListener('play', onPlay);
        v.addEventListener('pause', onPause);
        v.addEventListener('ended', onEnded);
        v.addEventListener('timeupdate', onTimeUpdate);
        v.addEventListener('durationchange', onDuration);
        v.addEventListener('loadedmetadata', onDuration);
        v.addEventListener('volumechange', onVolume);

        return () => {
            v.removeEventListener('play', onPlay);
            v.removeEventListener('pause', onPause);
            v.removeEventListener('ended', onEnded);
            v.removeEventListener('timeupdate', onTimeUpdate);
            v.removeEventListener('durationchange', onDuration);
            v.removeEventListener('loadedmetadata', onDuration);
            v.removeEventListener('volumechange', onVolume);
        };
    }, [videoRef]);

    const togglePlay = useCallback(() => {
        const v = videoRef.current;
        if (!v) return;
        if (v.paused) void v.play().catch(() => { /* 自动播放策略 / 解码失败：忽略 */ });
        else v.pause();
    }, [videoRef]);

    // 空格键：控制小窗播放/暂停（2026-10-16 指挥官指定「小窗在播放时用空格控制」）。
    // 让路规则（都不 preventDefault，原样放行）：
    //   ① 编辑目标（输入框 / 文本域 / 下拉 / contenteditable）内的空格；
    //   ② 查看器正开着视频（空格已归属查看器，防双触发）。
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== ' ' && e.key !== 'Spacebar') return;
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            if (e.isComposing) return; // 输入法组合中的空格（选字），放行
            if (viewerVideoOpen) return;
            const target = e.target as HTMLElement | null;
            // 只让路给文本编辑目标：小窗自己的 range 滑条持有焦点时，空格仍该是播放/暂停
            if (isTextEditingTarget(target)) return;
            e.preventDefault(); // 拦下页面滚动：空格已被小窗消费
            togglePlay();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [togglePlay, viewerVideoOpen]);

    const toggleMute = () => {
        const v = videoRef.current;
        if (!v) return;
        v.muted = !v.muted;
        setMuted(v.muted);
    };

    // 进度条拖拽：按下进入暂存态，拖动只更新文字，松手才 seek（§3）
    const beginScrub = () => {
        const v = videoRef.current;
        const tv = v ? v.currentTime : 0;
        scrubbingRef.current = true;
        scrubValueRef.current = tv;
        setScrubValue(tv);
        setIsScrubbing(true);
    };
    const onScrubChange = (e: ChangeEvent<HTMLInputElement>) => {
        const raw = Number(e.target.value);
        if (!isFinite(raw)) return;
        const max = duration > 0 ? duration : raw;
        const val = Math.max(0, Math.min(raw, max));
        scrubValueRef.current = val;
        setScrubValue(val);
    };
    const endScrub = useCallback(() => {
        if (!scrubbingRef.current) return;
        // 先解除 scrubbing 标记再 seek（与查看器一致：事件派发时序上更安全）
        scrubbingRef.current = false;
        const v = videoRef.current;
        const val = scrubValueRef.current;
        if (v) {
            v.currentTime = val;
            setCurrentTime(val);
        }
        setIsScrubbing(false);
    }, [videoRef]);

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

    // 黑底上的白色系小按钮（24px 热区 + 14px 图标）
    const iconBtn = 'shrink-0 w-6 h-6 rounded flex items-center justify-center text-white/90 hover:text-white hover:bg-white/15 transition-colors cursor-pointer';

    return (
        // 底部渐变压暗：控件可读 + 不硬切画面；rounded-b 贴合 <video> 的 rounded
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 px-2 pb-1.5 pt-6 rounded-b bg-gradient-to-t from-black/75 via-black/35 to-transparent">
            <button onClick={togglePlay} className={iconBtn} title={isPlaying ? tr('video.pause', '暂停') : tr('video.play', '播放')}>
                {isPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" className="ml-px" />}
            </button>

            <span className={`text-[10px] leading-none tabular-nums select-none shrink-0 ${isScrubbing ? 'text-white' : 'text-white/85'}`}>
                {formatClock(displayTime)}
            </span>

            {/* 进度条：视觉层 + 透明 range 交互层（同 viewer/VideoControls） */}
            <div className="relative flex-1 min-w-0 h-4 flex items-center">
                <div className="absolute inset-x-0 h-[3px] rounded-full bg-white/25" />
                <div className="absolute left-0 h-[3px] rounded-full bg-white" style={{ width: `${playedPct}%` }} />
                <div className="absolute w-2 h-2 rounded-full bg-white shadow pointer-events-none" style={{ left: `calc(${playedPct}% - 4px)` }} />
                <input
                    type="range"
                    min={0}
                    max={dur || 0}
                    step={0.01}
                    value={dur > 0 ? displayTime : 0}
                    tabIndex={-1}
                    // 焦点在进度条上时方向键就地调本窗进度，不冒泡给查看器的「← → 快退/快进」，
                    // 免得小窗与查看器同时 seek（与 viewer/VideoControls 的音量条同一口径）
                    onKeyDown={(e) => { if (e.key.startsWith('Arrow')) e.stopPropagation(); }}
                    onPointerDown={beginScrub}
                    onChange={onScrubChange}
                    onPointerUp={endScrub}
                    onPointerCancel={endScrub}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    aria-label={tr('video.progress', '进度')}
                />
            </div>

            <span className="text-[10px] leading-none tabular-nums text-white/60 select-none shrink-0">
                {formatClock(dur)}
            </span>

            <button onClick={toggleMute} className={iconBtn} title={muted ? tr('video.unmute', '取消静音') : tr('video.mute', '静音')}>
                {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </button>
        </div>
    );
};
