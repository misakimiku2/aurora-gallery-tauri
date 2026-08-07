import { useEffect, type RefObject } from 'react';

/**
 * 自动隐藏滚动条行为（样式见 index.css 中 `#file-grid-container, .custom-scrollbar` 规则）：
 * - 滚动中给容器添加 `scrolling` class，滚动条淡入显示；
 * - 停止滚动 800ms 后移除，滚动条淡出隐藏；
 * - 鼠标悬停在滚动条区域（容器右缘）时添加 `scrollbar-hover` class，滚动条显示并放大；
 * - 鼠标移开滚动条区域后移除。
 */
export function useAutoScrollbar(containerRef: RefObject<HTMLDivElement | null>) {
    // 将 containerRef.current 加入依赖：当 ref 指向的容器切换（如详情面板不同分支）
    // 时自动解绑旧容器并绑定新容器。
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        let hideTimer: ReturnType<typeof setTimeout> | null = null;

        const handleScroll = () => {
            container.classList.add('scrolling');
            if (hideTimer) clearTimeout(hideTimer);
            hideTimer = setTimeout(() => {
                container.classList.remove('scrolling');
            }, 800);
        };

        const handlePointerMove = (e: MouseEvent) => {
            const rect = container.getBoundingClientRect();
            const nearScrollbar = e.clientX >= rect.right - 20 && e.clientX <= rect.right;
            container.classList.toggle('scrollbar-hover', nearScrollbar);
        };

        const handlePointerLeave = () => {
            container.classList.remove('scrollbar-hover');
        };

        container.addEventListener('scroll', handleScroll, { passive: true });
        container.addEventListener('mousemove', handlePointerMove);
        container.addEventListener('mouseleave', handlePointerLeave);

        return () => {
            container.removeEventListener('scroll', handleScroll);
            container.removeEventListener('mousemove', handlePointerMove);
            container.removeEventListener('mouseleave', handlePointerLeave);
            if (hideTimer) clearTimeout(hideTimer);
            container.classList.remove('scrolling');
            container.classList.remove('scrollbar-hover');
        };
    }, [containerRef, containerRef.current]);
}
