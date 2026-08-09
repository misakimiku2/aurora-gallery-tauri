/**
 * Aurora Gallery - 匀速滚动测试脚本 (Uniform Scroll Test)
 *
 * 用途：在 Tauri WebView 的 DevTools 控制台中匀速滚动文件网格，
 *       为 scrollProfiler 提供可复现、可对比的滚动样本（替代手动滚动的不可控）。
 *
 * 用法：
 *   1. 打开应用，停留在「文件网格」页面（文件夹列表/图片网格视图）
 *   2. 按 F12 打开 DevTools，把本文件全部内容粘贴到 Console 执行
 *      → 3 秒后自动开始一次匀速向下滚动（默认 1400px/s，向下滚 7000px）
 *   3. 开启滚动性能记录（在自动滚动前执行）：
 *        window.__AURORA_SCROLL_PERF__ = true;
 *   4. 脚本滚动结束后约 1.6s，scrollProfiler 自动落盘日志到
 *      %LOCALAPPDATA%\Aurora\scroll-perf\scroll-perf-<时间戳>.txt
 *
 * 停止条件（满足任一即停，保证不会无限滚动）：
 *   - 到达目标位置：startTop + distance（向下）/ startTop - distance（向上）
 *   - 滚动位置连续多帧无变化（已滚到内容底部/顶部）
 *   - 超过超时上限（distance/speed + 3s，兜底）
 *
 * 重复/自定义滚动（无需重新粘贴，直接调用）：
 *   await __AuroraTest.scroll();                        // 默认 1400px/s 向下滚 7000px
 *   await __AuroraTest.scroll({ speed: 2000 });         // 更快
 *   await __AuroraTest.scroll({ distance: 10000 });     // 更远
 *   await __AuroraTest.scroll({ direction: 'up' });     // 向上滚回
 *
 * 参数说明：
 *   speed     像素/秒。手动滚动实测约 1400~1700px/s，默认 1400 模拟中速滚动。
 *   distance  单次滚动距离（px），默认 7000，与早期手动日志(6999~7299px)相近。
 *             注意：是「相对当前位置滚多少」，不是滚到绝对坐标。
 *   direction 'down'（向内容下方）或 'up'（向上滚回）。
 *   settle    滚动结束后等待 ms，确保 scrollProfiler 空闲判定(IDLE_MS=800)落盘。
 *   autoDelay 自动滚动前的等待 ms（仅脚本初始化时生效），默认 3000。
 *
 * 实现说明：
 *   用 requestAnimationFrame + 时间差驱动，每帧按 (speed * dt) 推进 scrollTop，
 *   从意图上是严格匀速的；主线程越忙 rAF 间隔越大，帧耗时差异会如实反映在
 *   scrollProfiler 的帧统计里，这正是我们希望测量的负载。
 */
(() => {
  'use strict';

  // 防止多个副本/重复调用叠加滚动
  if (window.__AuroraTest && window.__AuroraTest._scrolling) {
    console.warn('[AuroraTest] 上一次滚动仍在进行中，忽略本次调用');
    return true;
  }

  const scroll = async ({
    speed = 1400,        // 像素/秒
    distance = 7000,     // 滚动距离 (px)
    direction = 'down',  // 'down' | 'up'
    settle = 1600,       // 结束后等待 ms，确保会话落盘
  } = {}) => {
    if (window.__AuroraTest._scrolling) {
      console.warn('[AuroraTest] 上一次滚动仍在进行中，忽略本次调用');
      return null;
    }

    const container =
      document.getElementById('file-grid-container') ||
      document.getElementById('file-grid-scroll');
    if (!container) {
      throw new Error('[AuroraTest] 找不到滚动容器 (file-grid-container)');
    }

    window.__AuroraTest._scrolling = true;

    const sign = direction === 'up' ? -1 : 1;
    const startTop = container.scrollTop;
    const dist = sign > 0 ? distance : Math.min(distance, startTop);
    // 绝对目标位置
    const targetTop = sign > 0
      ? startTop + dist
      : Math.max(0, startTop - dist);
    // 超时兜底：按匀速时间 + 3s 余量
    const timeoutMs = (dist / speed) * 1000 + 3000;

    const startedAt = performance.now();
    let last = startedAt;
    let scrolled = 0;
    let stuckFrames = 0;
    let lastScrollTop = container.scrollTop;

    const stopped = await new Promise((resolve) => {
      const tick = (now) => {
        const dt = now - last;
        last = now;
        scrolled += (speed * dt) / 1000;

        // 推进到目标位置（不越界）
        let next = startTop + sign * Math.min(scrolled, dist);
        next = Math.max(0, Math.min(next, container.scrollHeight - container.clientHeight));
        container.scrollTop = next;

        // —— 停止条件 ——
        // 1. 到达目标位置
        const reachedTarget = sign > 0
          ? container.scrollTop >= targetTop - 0.5
          : container.scrollTop <= targetTop + 0.5;
        if (reachedTarget || scrolled >= dist) {
          resolve('target');
          return;
        }
        // 2. 位置连续 ~20 帧无变化（已滚到底/顶，内容不够距离）
        if (container.scrollTop === lastScrollTop) {
          stuckFrames++;
        } else {
          stuckFrames = 0;
          lastScrollTop = container.scrollTop;
        }
        if (stuckFrames >= 20) {
          resolve('stuck');
          return;
        }
        // 3. 超时兜底
        if (now - startedAt > timeoutMs) {
          resolve('timeout');
          return;
        }

        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const durationSec = (performance.now() - startedAt) / 1000;
    const report = {
      stoppedBy: stopped,          // 'target' | 'stuck'(到底/顶) | 'timeout'
      direction,
      speedPxPerSec: speed,
      distancePx: dist,
      startTop,
      targetTop: +targetTop.toFixed(1),
      endTop: Math.round(container.scrollTop),
      actualDeltaPx: Math.round(container.scrollTop - startTop),
      durationSec: +durationSec.toFixed(2),
      avgSpeedPxPerSec: Math.round(dist / durationSec),
    };
    console.table(report);
    if (stopped === 'stuck') {
      console.warn('[AuroraTest] 内容高度不足，已滚动到底部(或顶部)提前停止');
    } else if (stopped === 'timeout') {
      console.warn('[AuroraTest] 触发超时保护停止，请检查滚动容器选择是否正确');
    }

    // 等 scrollProfiler 空闲判定 (IDLE_MS=800) 结束会话并写盘
    await new Promise((r) => setTimeout(r, settle));
    window.__AuroraTest._scrolling = false;
    console.log('[AuroraTest] 完成。请查看 %LOCALAPPDATA%\\Aurora\\scroll-perf\\ 下的新日志');
    return report;
  };

  window.__AuroraTest = {
    _scrolling: false,
    scroll,
  };

  console.log('[AuroraTest] 已就绪。将在 3 秒后自动开始滚动(向下 1400px/s，7000px)。');
  console.log('[AuroraTest] 自定义滚动: await __AuroraTest.scroll({speed:1400,distance:7000})');

  // 粘贴即测：延迟几秒自动滚动，给用户切回应用/开启性能记录的时间
  const AUTO_DELAY = 3000;
  setTimeout(() => {
    scroll()
      .then((report) => {
        if (report) console.log('[AuroraTest] 自动滚动完成');
      })
      .catch((err) => {
        console.error('[AuroraTest] 自动滚动失败:', err);
        console.error('[AuroraTest] 请确认已停留在文件网格页面后手动运行: await __AuroraTest.scroll()');
      });
  }, AUTO_DELAY);

  return true;
})();
