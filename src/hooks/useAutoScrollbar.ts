import { useEffect, type RefObject } from 'react';

/**
 * 自动隐藏滚动条行为（样式见 index.css 中 `#file-grid-container, .custom-scrollbar` 规则）：
 * - 滚动中给容器添加 `scrolling` class，滚动条淡入显示；
 * - 停止滚动 800ms 后移除，滚动条淡出隐藏；
 * - 鼠标悬停在滚动条区域（容器右缘）时添加 `scrollbar-hover` class，滚动条显示并放大；
 * - 鼠标移开滚动条区域后移除。
 *
 * 性能注意：
 * - `getBoundingClientRect()` 会强制同步布局，若在每个 mousemove 事件里直接调用，
 *   滚动时（鼠标通常位于容器内）会破坏渲染流水线、加剧掉帧。
 *   因此此处用 rAF 节流 + 缓存 rect 的方式，把强制布局频率降到每帧最多一次。
 */
export function useAutoScrollbar(containerRef: RefObject<HTMLDivElement | null>) {
    // 将 containerRef.current 加入依赖：当 ref 指向的容器切换（如详情面板不同分支）
    // 时自动解绑旧容器并绑定新容器。
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        let hideTimer: ReturnType<typeof setTimeout> | null = null;
        let rectRaf: number | null = null;
        // 缓存容器布局信息：容器位置不会因滚动而变，只有 scroll/resize 才需刷新
        let cachedRight = 0;

        const refreshRect = () => {
            const rect = container.getBoundingClientRect();
            cachedRight = rect.right;
        };
        refreshRect();

        const handleScroll = () => {
            container.classList.add('scrolling');
            if (hideTimer) clearTimeout(hideTimer);
            hideTimer = setTimeout(() => {
                container.classList.remove('scrolling');
            }, 800);
        };

        const handlePointerMove = (e: MouseEvent) => {
            // rAF 节流：滚动中 mousemove 高频触发，但强制布局每帧最多一次
            if (rectRaf !== null) return;
            rectRaf = requestAnimationFrame(() => {
                rectRaf = null;
                const nearScrollbar = e.clientX >= cachedRight - 20 && e.clientX <= cachedRight;
                container.classList.toggle('scrollbar-hover', nearScrollbar);
            });
        };

        const handlePointerLeave = () => {
            container.classList.remove('scrollbar-hover');
        };

        // 窗口尺寸/滚动条出现等导致容器位置变化时刷新缓存 rect
        const handleResize = () => {
            refreshRect();
        };

        container.addEventListener('scroll', handleScroll, { passive: true });
        container.addEventListener('mousemove', handlePointerMove);
        container.addEventListener('mouseleave', handlePointerLeave);
        window.addEventListener('resize', handleResize);

        return () => {
            container.removeEventListener('scroll', handleScroll);
            container.removeEventListener('mousemove', handlePointerMove);
            container.removeEventListener('mouseleave', handlePointerLeave);
            window.removeEventListener('resize', handleResize);
            if (rectRaf !== null) cancelAnimationFrame(rectRaf);
            if (hideTimer) clearTimeout(hideTimer);
            container.classList.remove('scrolling');
            container.classList.remove('scrollbar-hover');
        };
    }, [containerRef, containerRef.current]);
}
