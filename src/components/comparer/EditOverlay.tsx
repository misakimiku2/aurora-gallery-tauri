import React, { useState, useEffect, useRef } from 'react';
import { ComparisonItem } from './types';

/**
 * 旋转手柄的光标。
 *
 * **双色描边**（白色外晕 + 黑色本体）：单一颜色必然有一半场景看不见——深色主题下
 * 黑图标糊在背景里、浅色主题下白图标糊在白底上（用户实测反馈「描边太浅，完全看不清」）。
 * 白晕负责在深底上分离轮廓，黑本体负责在浅底上可读，两个主题都成立。
 *
 * 图形沿用工具栏那个 `RotateCw`（lucide）的路径，只是把 viewBox 24 放大到 32 显示。
 */
const makeRotateCursor = () => {
    const p = `%3Cpath d='M21.5 2v6h-6'/%3E%3Cpath d='M21.34 15.57a10 10 0 1 1-.57-8.38'/%3E`;
    /**
     * 与系统光标**同族**的三个要点（用户实测反馈"旋转的是黑的、其他是白的、还更大"）：
     *
     * 1. **白色本体 + 黑色描边**——Windows 的缩放箭头就是这个配色；反过来（黑本体）
     *    一眼就不是同一套。
     * 2. **图形缩到 16px 居中**：画布取 32×32（与 Windows 标准光标同尺寸），
     *    再用 `translate(8 8) scale(0.6667)` 把 24 单位的图形压到 16 单位。
     *    直接画满 24/32 会比系统的箭头大一圈。
     * 3. 热点取画布中心 `16 16`。
     *
     * 先画粗黑再画细白 → 得到"白心黑边"的描边效果。
     */
    const svg =
        `%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'%3E` +
        `%3Cg transform='translate(8 8) scale(0.6667)' fill='none' stroke-linecap='round' stroke-linejoin='round'%3E` +
        `%3Cg stroke='%23000000' stroke-width='4.6'%3E${p}%3C/g%3E` +
        `%3Cg stroke='%23ffffff' stroke-width='2.4'%3E${p}%3C/g%3E` +
        `%3C/g%3E%3C/svg%3E`;
    return `url("data:image/svg+xml;charset=utf-8,${svg}") 16 16, alias`;
};

interface EditOverlayProps {
    activeItem: ComparisonItem | null;
    selectedItems?: ComparisonItem[];
    allItems: ComparisonItem[];
    transform: { x: number; y: number; scale: number };
    onUpdateItem: (id: string, updates: Partial<ComparisonItem>) => void;
    onRemoveItem: (id: string) => void;
    onInteractionStart?: () => void;
    onInteractionEnd?: () => void;
    containerRef?: React.RefObject<HTMLDivElement>;
    isSnappingEnabled?: boolean;
    /**
     * 画布尺寸——提供后，吸附目标额外包含**画布四边与画布中心**。
     *
     * 为什么需要：参考模式里吸附的是"其他项"，而编辑器单图层时没有第二项可对齐，
     * 唯一有意义的参照就是画布本身。不传 = 保持参考模式原有行为（纯增量改动）。
     */
    snapBounds?: { width: number; height: number };
    /**
     * @deprecated 自 2026-10-23 起不再影响旋转光标——光标改成"白晕 + 黑本体"的双色图标，
     * 深浅主题下都能看清，不需要按主题切换。保留参数只是为了不动调用方。
     */
    isDarkMode?: boolean;
    isEditMode?: boolean;
    /**
     * 是否显示**八个变换手柄 + 四角旋转区**。缺省等于 `isEditMode`。
     *
     * 单独拆出来是因为"能拖"和"能缩放手柄"是两件事：编辑器的移动工具要能拖动图层，
     * 但不该摆出一圈手柄（PS 里移动工具只显示边界、不显示控制点）。
     * 之前两者共用一个开关，结果移动工具连拖都拖不动（用户实测）。
     */
    showTransformHandles?: boolean;
    /**
     * 是否画那圈蓝色选中边框。缺省 `true`。
     *
     * 编辑器的移动工具要"点一下才选中"，未选中时不该顶着边框——否则看起来像
     * 已经选中了图层（用户实测反馈）。手柄由 `showTransformHandles` 单独管。
     */
    showChrome?: boolean;
    isAndroid?: boolean;
    onLongPress?: (worldX: number, worldY: number) => void;
}

type HandleType = 'tl' | 'tc' | 'tr' | 'ml' | 'mr' | 'bl' | 'bc' | 'br';

interface SnapGuide {
    type: 'x' | 'y';
    pos: number;
    start: number;
    end: number;
    targetId: string;
}

const ScaleIcon: React.FC<{ size?: number; color?: string }> = ({ size = 16, color = 'currentColor' }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="15 3 21 3 21 9" />
        <polyline points="9 21 3 21 3 15" />
        <line x1="21" y1="3" x2="14" y2="10" />
        <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
);

const RotateIcon: React.FC<{ size?: number; color?: string }> = ({ size = 16, color = 'currentColor' }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21.5 2v6h-6" />
        <path d="M21.34 15.57a10 10 0 1 1-.57-8.38" />
    </svg>
);

const getRotatedAABB = (item: ComparisonItem) => {
    const cx = item.x + item.width / 2;
    const cy = item.y + item.height / 2;
    const rad = (item.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    const corners = [
        { x: -item.width / 2, y: -item.height / 2 },
        { x: item.width / 2, y: -item.height / 2 },
        { x: item.width / 2, y: item.height / 2 },
        { x: -item.width / 2, y: item.height / 2 }
    ].map(p => ({
        x: cx + (p.x * cos - p.y * sin),
        y: cy + (p.x * sin + p.y * cos)
    }));

    const xs = corners.map(c => c.x);
    const ys = corners.map(c => c.y);

    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    return {
        l: minX, r: maxX, cx,
        t: minY, b: maxY, cy,
        width: maxX - minX,
        height: maxY - minY
    };
};

export const EditOverlay: React.FC<EditOverlayProps> = ({
    activeItem,
    selectedItems = [],
    allItems,
    transform,
    onUpdateItem,
    onInteractionStart,
    onInteractionEnd,
    containerRef,
    isSnappingEnabled = true,
    snapBounds,
    isDarkMode: _isDarkMode = false,
    isEditMode = true,
    showTransformHandles,
    showChrome = true,
    isAndroid = false,
    onLongPress
}) => {
    const [dragType, setDragType] = useState<string | null>(null);
    const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
    const overlayRef = useRef<HTMLDivElement>(null);
    const startState = useRef({
        pivotWorld: { x: 0, y: 0 },
        itemR: 0,
        aspectRatio: 1,
        centerX: 0, centerY: 0, startMouseAngle: 0,
        itemX: 0, itemY: 0, startMouseWorld: { x: 0, y: 0 },
        clickOffset: { x: 0, y: 0 }
    });

    // 手柄只影响"缩放/旋转"，拖动层始终跟着编辑态走——两件事不该共用一个开关
    const showHandles = showTransformHandles ?? isEditMode;
    const canDragLayer = isEditMode;

    const getWorldCoords = (clientX: number, clientY: number) => {
        const rect = containerRef?.current?.getBoundingClientRect();
        const mouseX = rect ? clientX - rect.left : clientX;
        const mouseY = rect ? clientY - rect.top : clientY;
        return {
            screenX: mouseX,
            screenY: mouseY,
            worldX: (mouseX - transform.x) / transform.scale,
            worldY: (mouseY - transform.y) / transform.scale
        };
    };

    const processDrag = (mx: number, my: number, shiftKey: boolean) => {
        if (!activeItem || !dragType) return;

        if (dragType === 'move') {
            const dx = mx - startState.current.startMouseWorld.x;
            const dy = my - startState.current.startMouseWorld.y;

            let newX = startState.current.itemX + dx;
            let newY = startState.current.itemY + dy;

            const screenThreshold = 15;
            const threshold = screenThreshold / transform.scale;

            let bestSnapX = newX;
            let bestSnapY = newY;
            let minDx = threshold;
            let minDy = threshold;
            let currentSnaps: SnapGuide[] = [];

            if (isSnappingEnabled) {
                const selectedIds = selectedItems.map(si => si.id);

                // 吸附目标 = 其他项 + （编辑器传入的）画布边/中心。
                // 两类目标统一成同一结构，匹配逻辑只写一遍——单图层编辑器没有
                // "其他项"可对齐，画布才是唯一有意义的参照。
                const targets: Array<{ id: string; box: ReturnType<typeof getRotatedAABB> }> = allItems
                    .filter(item => item.id !== activeItem.id && !selectedIds.includes(item.id))
                    .map(item => ({ id: item.id, box: getRotatedAABB(item) }));

                if (snapBounds) {
                    targets.push({
                        id: 'canvas',
                        box: {
                            l: 0,
                            t: 0,
                            r: snapBounds.width,
                            b: snapBounds.height,
                            cx: snapBounds.width / 2,
                            cy: snapBounds.height / 2,
                            width: snapBounds.width,
                            height: snapBounds.height
                        }
                    });
                }

                targets.forEach(({ id: targetId, box: o }) => {
                    const m = getRotatedAABB({ ...activeItem, x: newX, y: newY });

                    const proximityThreshold = 200 / transform.scale;

                    const isNearHorizontally = (m.l < o.r + proximityThreshold) && (m.r > o.l - proximityThreshold);
                    const isNearVertically = (m.t < o.b + proximityThreshold) && (m.b > o.t - proximityThreshold);

                    if (isNearVertically) {
                        const snapsX = [
                            { val: o.l, dist: Math.abs(m.l - o.l), type: 'l' },
                            { val: o.r, dist: Math.abs(m.l - o.r), type: 'l' },
                            { val: o.l, dist: Math.abs(m.r - o.l), type: 'r' },
                            { val: o.r, dist: Math.abs(m.r - o.r), type: 'r' },
                            { val: o.cx, dist: Math.abs(m.cx - o.cx), type: 'cx' }
                        ];
                        snapsX.forEach(s => {
                            if (s.dist < minDx) {
                                minDx = s.dist;
                                const offset = s.val - (s.type === 'l' ? m.l : (s.type === 'r' ? m.r : m.cx));
                                bestSnapX = newX + offset;

                                const yMin = Math.min(m.t, o.t);
                                const yMax = Math.max(m.b, o.b);
                                currentSnaps = currentSnaps.filter(g => g.type !== 'x');
                                currentSnaps.push({
                                    type: 'x',
                                    pos: s.val,
                                    start: yMin,
                                    end: yMax,
                                    targetId
                                });
                            }
                        });
                    }

                    if (isNearHorizontally) {
                        const snapsY = [
                            { val: o.t, dist: Math.abs(m.t - o.t), type: 't' },
                            { val: o.b, dist: Math.abs(m.t - o.b), type: 't' },
                            { val: o.t, dist: Math.abs(m.b - o.t), type: 'b' },
                            { val: o.b, dist: Math.abs(m.b - o.b), type: 'b' },
                            { val: o.cy, dist: Math.abs(m.cy - o.cy), type: 'cy' }
                        ];
                        snapsY.forEach(s => {
                            if (s.dist < minDy) {
                                minDy = s.dist;
                                const offset = s.val - (s.type === 't' ? m.t : (s.type === 'b' ? m.b : m.cy));
                                bestSnapY = newY + offset;

                                const xMin = Math.min(m.l, o.l);
                                const xMax = Math.max(m.r, o.r);
                                currentSnaps = currentSnaps.filter(g => g.type !== 'y');
                                currentSnaps.push({
                                    type: 'y',
                                    pos: s.val,
                                    start: xMin,
                                    end: xMax,
                                    targetId
                                });
                            }
                        });
                    }
                });
            }

            newX = bestSnapX;
            newY = bestSnapY;
            setSnapGuides(currentSnaps);

            onUpdateItem(activeItem.id, { x: newX, y: newY });
        }
        else if (dragType === 'rotate') {
            const { centerX, centerY, startMouseAngle, itemR } = startState.current;
            const currentAngle = Math.atan2(my - centerY, mx - centerX);
            let deg = (currentAngle - startMouseAngle) * (180 / Math.PI) + itemR;

            if (shiftKey) deg = Math.round(deg / 15) * 15;
            onUpdateItem(activeItem.id, { rotation: deg });
        }
        else {
            const { pivotWorld, itemR, aspectRatio, clickOffset } = startState.current;
            const rad = (itemR * Math.PI) / 180;
            const cos = Math.cos(-rad);
            const sin = Math.sin(-rad);

            const vx = mx - pivotWorld.x;
            const vy = my - pivotWorld.y;

            const localMouseX = vx * cos - vy * sin;
            const localMouseY = vx * sin + vy * cos;

            const perfectCornerX = localMouseX + clickOffset.x;
            const perfectCornerY = localMouseY + clickOffset.y;

            let w = Math.abs(perfectCornerX);
            let h = Math.abs(perfectCornerY);

            if (dragType === 'ml' || dragType === 'mr') {
                h = w / aspectRatio;
            } else if (dragType === 'tc' || dragType === 'bc') {
                w = h * aspectRatio;
            } else {
                if (w / aspectRatio > h) h = w / aspectRatio;
                else w = h * aspectRatio;
            }

            w = Math.max(50, w);
            h = Math.max(50, h);

            let kx = 0;
            let ky = 0;

            if (dragType.includes('l')) kx = 1;
            else if (dragType.includes('r')) kx = -1;
            else kx = 0;

            if (dragType.includes('t')) ky = 1;
            else if (dragType.includes('b')) ky = -1;
            else ky = 0;

            const offX = -kx * w / 2;
            const offY = -ky * h / 2;

            const cosR = Math.cos(rad);
            const sinR = Math.sin(rad);
            const worldOffX = offX * cosR - offY * sinR;
            const worldOffY = offX * sinR + offY * cosR;

            const newCenterX = pivotWorld.x + worldOffX;
            const newCenterY = pivotWorld.y + worldOffY;

            onUpdateItem(activeItem.id, {
                x: newCenterX - w / 2,
                y: newCenterY - h / 2,
                width: w,
                height: h
            });
        }
    };

    const startInteraction = (type: string, clientX: number, clientY: number) => {
        if (!activeItem) return;
        const { worldX: mx, worldY: my } = getWorldCoords(clientX, clientY);

        const cx = activeItem.x + activeItem.width / 2;
        const cy = activeItem.y + activeItem.height / 2;
        const rad = (activeItem.rotation * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        let px = 0;
        let py = 0;

        if (type.includes('l')) px = 1;
        else if (type.includes('r')) px = -1;
        else px = 0;

        if (type.includes('t')) py = 1;
        else if (type.includes('b')) py = -1;
        else py = 0;

        const lpx = px * activeItem.width / 2;
        const lpy = py * activeItem.height / 2;

        const pivotWorld = {
            x: cx + (lpx * cos - lpy * sin),
            y: cy + (lpx * sin + lpy * cos)
        };

        const rCos = Math.cos(-rad);
        const rSin = Math.sin(-rad);
        const vx = mx - pivotWorld.x;
        const vy = my - pivotWorld.y;
        const localMouseX = vx * rCos - vy * rSin;
        const localMouseY = vx * rSin + vy * rCos;

        let hx = 0; if (type.includes('l')) hx = -activeItem.width / 2; else if (type.includes('r')) hx = activeItem.width / 2;
        let hy = 0; if (type.includes('t')) hy = -activeItem.height / 2; else if (type.includes('b')) hy = activeItem.height / 2;

        const targetLocalX = hx - (px * activeItem.width / 2);
        const targetLocalY = hy - (py * activeItem.height / 2);

        const clickOffset = {
            x: targetLocalX - localMouseX,
            y: targetLocalY - localMouseY
        };

        startState.current = {
            pivotWorld,
            itemR: activeItem.rotation,
            aspectRatio: activeItem.width / activeItem.height,
            centerX: cx, centerY: cy, startMouseAngle: Math.atan2(my - cy, mx - cx),
            itemX: activeItem.x, itemY: activeItem.y,
            startMouseWorld: { x: mx, y: my },
            clickOffset
        };
        setDragType(type);
        onInteractionStart?.();
    };

    useEffect(() => {
        if (!activeItem || !dragType) return;

        const handleMouseMove = (e: MouseEvent) => {
            const { worldX: mx, worldY: my } = getWorldCoords(e.clientX, e.clientY);
            processDrag(mx, my, e.shiftKey);
        };

        const handleTouchMove = (e: TouchEvent) => {
            if (e.touches.length !== 1) return;
            if (e.cancelable) e.preventDefault();
            const touch = e.touches[0];
            const { worldX: mx, worldY: my } = getWorldCoords(touch.clientX, touch.clientY);
            processDrag(mx, my, false);
        };

        const handleEnd = () => {
            setDragType(null);
            setSnapGuides([]);
            onInteractionEnd?.();
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleEnd);
        if (isAndroid) {
            window.addEventListener('touchmove', handleTouchMove, { passive: false });
            window.addEventListener('touchend', handleEnd);
            window.addEventListener('touchcancel', handleEnd);
        }

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleEnd);
            if (isAndroid) {
                window.removeEventListener('touchmove', handleTouchMove);
                window.removeEventListener('touchend', handleEnd);
                window.removeEventListener('touchcancel', handleEnd);
            }
        };
    }, [dragType, activeItem, transform, onUpdateItem, allItems, isAndroid, snapBounds, isSnappingEnabled]);

    useEffect(() => {
        if (!isAndroid || !overlayRef.current) return;

        const el = overlayRef.current;
        const opts: AddEventListenerOptions = { passive: false };
        let longPressTimer: ReturnType<typeof setTimeout> | null = null;
        let longPressStartClientX = 0;
        let longPressStartClientY = 0;
        let longPressFired = false;

        const clearLongPress = () => {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        };

        const onTouchStart = (e: TouchEvent) => {
            const target = e.target as HTMLElement;
            const handleType = target.getAttribute('data-handle-type');
            if (!handleType) return;
            if (e.cancelable) e.preventDefault();
            e.stopPropagation();

            clearLongPress();
            longPressFired = false;

            if (handleType === 'move' && onLongPress) {
                const touch = e.touches[0];
                longPressStartClientX = touch.clientX;
                longPressStartClientY = touch.clientY;
                const worldCoords = getWorldCoords(touch.clientX, touch.clientY);
                longPressTimer = setTimeout(() => {
                    longPressFired = true;
                    onLongPress(worldCoords.worldX, worldCoords.worldY);
                    longPressTimer = null;
                }, 500);
            } else {
                const touch = e.touches[0];
                startInteraction(handleType, touch.clientX, touch.clientY);
            }
        };

        const onTouchMoveForLongPress = (e: TouchEvent) => {
            if (!longPressTimer) return;
            if (e.touches.length !== 1) {
                clearLongPress();
                return;
            }
            const touch = e.touches[0];
            const dx = touch.clientX - longPressStartClientX;
            const dy = touch.clientY - longPressStartClientY;
            if (Math.sqrt(dx * dx + dy * dy) > 8) {
                clearLongPress();
                startInteraction('move', longPressStartClientX, longPressStartClientY);
                processDrag(getWorldCoords(touch.clientX, touch.clientY).worldX, getWorldCoords(touch.clientX, touch.clientY).worldY, false);
            }
        };

        const onTouchEndForLongPress = () => {
            clearLongPress();
            longPressFired = false;
        };

        el.addEventListener('touchstart', onTouchStart, opts);
        el.addEventListener('touchmove', onTouchMoveForLongPress, opts);
        el.addEventListener('touchend', onTouchEndForLongPress);
        el.addEventListener('touchcancel', onTouchEndForLongPress);
        return () => {
            el.removeEventListener('touchstart', onTouchStart);
            el.removeEventListener('touchmove', onTouchMoveForLongPress);
            el.removeEventListener('touchend', onTouchEndForLongPress);
            el.removeEventListener('touchcancel', onTouchEndForLongPress);
            clearLongPress();
        };
    }, [isAndroid, activeItem, transform, onLongPress]);

    if (!activeItem) return null;

    const handleMouseDown = (e: React.MouseEvent, type: string) => {
        if (e.button !== 0) return;

        const { screenX: mouseViewportX, screenY: mouseViewportY, worldX: mx, worldY: my } = getWorldCoords(e.clientX, e.clientY);

        const pointInRotated = (wx: number, wy: number, it: ComparisonItem, tolWorld = 0) => {
            const cx = it.x + it.width / 2;
            const cy = it.y + it.height / 2;
            const rad = -it.rotation * Math.PI / 180;
            const dx = wx - cx;
            const dy = wy - cy;
            const lx = dx * Math.cos(rad) - dy * Math.sin(rad) + cx;
            const ly = dx * Math.sin(rad) + dy * Math.cos(rad) + cy;
            return lx >= it.x - tolWorld && lx <= it.x + it.width + tolWorld && ly >= it.y - tolWorld && ly <= it.y + it.height + tolWorld;
        };

        let shouldCapture = true;
        if (type === 'move') {
            const tolPx = 6;
            const tolWorld = Math.max(0, tolPx / Math.max(1e-6, transform.scale));

            const itemScreenAABB = (it: ComparisonItem) => {
                const cx = (it.x + it.width / 2) * transform.scale + transform.x;
                const cy = (it.y + it.height / 2) * transform.scale + transform.y;
                const rad = it.rotation * Math.PI / 180;
                const corners = [
                    { x: it.x, y: it.y },
                    { x: it.x + it.width, y: it.y },
                    { x: it.x + it.width, y: it.y + it.height },
                    { x: it.x, y: it.y + it.height }
                ].map(p => {
                    const dx = (p.x - (it.x + it.width / 2));
                    const dy = (p.y - (it.y + it.height / 2));
                    const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
                    const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
                    return {
                        x: (cx + rx * transform.scale),
                        y: (cy + ry * transform.scale)
                    };
                });
                const xs = corners.map(c => c.x);
                const ys = corners.map(c => c.y);
                return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
            };

            const ptX = mouseViewportX;
            const ptY = mouseViewportY;

            if (selectedItems.length > 1) {
                let hit = false;
                for (const it of selectedItems) {
                    const r = itemScreenAABB(it);
                    if (ptX >= r.minX - tolPx && ptX <= r.maxX + tolPx && ptY >= r.minY - tolPx && ptY <= r.maxY + tolPx) {
                        if (pointInRotated(mx, my, it, tolWorld)) { hit = true; break; }
                    }
                }
                shouldCapture = hit;
            } else {
                const r = itemScreenAABB(activeItem);
                if (ptX >= r.minX - tolPx && ptX <= r.maxX + tolPx && ptY >= r.minY - tolPx && ptY <= r.maxY + tolPx) {
                    shouldCapture = pointInRotated(mx, my, activeItem, tolWorld);
                } else {
                    shouldCapture = false;
                }
            }
        }

        if (!shouldCapture) {
            return;
        }

        e.stopPropagation();
        startInteraction(type, e.clientX, e.clientY);
    };

    const screenX = activeItem.x * transform.scale + transform.x;
    const screenY = activeItem.y * transform.scale + transform.y;
    const screenW = activeItem.width * transform.scale;
    const screenH = activeItem.height * transform.scale;

    const snapTargetIds = isSnappingEnabled ? snapGuides.map(g => g.targetId) : [];

    const handleSize = isAndroid ? 30 : 10;

    return (
        <>
            {isSnappingEnabled && snapGuides.map((guide, i) => {
                const isX = guide.type === 'x';
                const sPos = guide.pos * transform.scale + (isX ? transform.x : transform.y);
                const sStart = guide.start * transform.scale + (isX ? transform.y : transform.x);
                const sEnd = guide.end * transform.scale + (isX ? transform.y : transform.x);

                return (
                    <div
                        key={`snap-${i}`}
                        className="absolute pointer-events-none"
                        style={{
                            left: isX ? sPos : sStart,
                            top: isX ? sStart : sPos,
                            width: isX ? 1 : sEnd - sStart,
                            height: isX ? sEnd - sStart : 1,
                            borderLeft: isX ? '1px dashed #34d399' : 'none',
                            borderTop: isX ? 'none' : '1px dashed #34d399',
                            zIndex: 150,
                            boxShadow: '0 0 4px rgba(52, 211, 153, 0.5)'
                        }}
                    />
                );
            })}

            {allItems.map(item => {
                const isSelected = selectedItems.some(si => si.id === item.id);
                const isSnapTarget = snapTargetIds.includes(item.id);

                if (!isSelected && !isSnapTarget) return null;
                if (item.id === activeItem.id && !isSnapTarget) return null;

                const sx = item.x * transform.scale + transform.x;
                const sy = item.y * transform.scale + transform.y;
                const sw = item.width * transform.scale;
                const sh = item.height * transform.scale;

                return (
                    <div
                        key={item.id}
                        className="absolute pointer-events-none"
                        style={{
                            left: sx, top: sy, width: sw, height: sh,
                            transform: `rotate(${item.rotation}deg)`,
                            transformOrigin: 'center',
                            border: isSnapTarget ? '2px solid #34d399' : '1px solid #3b82f6',
                            opacity: isSnapTarget ? 1 : 0.6,
                            zIndex: isSnapTarget ? 140 : 99,
                            boxShadow: isSnapTarget ? '0 0 10px rgba(52, 211, 153, 0.3)' : 'none'
                        }}
                    />
                );
            })}

            <div ref={overlayRef} className="absolute pointer-events-none"
                style={{ left: screenX, top: screenY, width: screenW, height: screenH, transform: `rotate(${activeItem.rotation}deg)`, transformOrigin: 'center', border: showChrome ? '1px solid #3b82f6' : 'none', zIndex: 100 }}>
                {canDragLayer && (
                    <div
                        onMouseDown={(e) => handleMouseDown(e, 'move')}
                        data-handle-type="move"
                        className="absolute inset-0 cursor-move pointer-events-auto"
                    />
                )}

                {showHandles && (['tl', 'tc', 'tr', 'ml', 'mr', 'bl', 'bc', 'br'] as HandleType[]).map(pos => {
                    const s = handleSize;
                    const style: React.CSSProperties = {
                        position: 'absolute',
                        width: s, height: s,
                        borderRadius: '50%',
                        backgroundColor: 'white',
                        border: '1.5px solid #3b82f6',
                        zIndex: 120,
                        pointerEvents: 'auto',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        boxShadow: '0 1px 4px rgba(0,0,0,0.15)',
                        transition: 'transform 0.1s'
                    };

                    if (pos.includes('t')) style.top = -s / 2;
                    else if (pos.includes('b')) style.bottom = -s / 2;
                    if (pos.includes('l')) style.left = -s / 2;
                    else if (pos.includes('r')) style.right = -s / 2;
                    if (pos === 'tc' || pos === 'bc') { style.left = '50%'; style.transform = 'translateX(-50%)'; }
                    if (pos === 'ml' || pos === 'mr') { style.top = '50%'; style.transform = 'translateY(-50%)'; }

                    // ⚠️ 必须带 `cursor-` 前缀。原先写成 `nwse-resize` 这种裸名字，
                    // Tailwind 里根本没有这个类 → 八个手柄全都没有方向光标，
                    // 用户看到的就是画布那个统一的十字/移动光标（实测反馈）。
                    const cursors: Record<string, string> = { tl: 'cursor-nwse-resize', tr: 'cursor-nesw-resize', bl: 'cursor-nesw-resize', br: 'cursor-nwse-resize', tc: 'cursor-ns-resize', bc: 'cursor-ns-resize', ml: 'cursor-ew-resize', mr: 'cursor-ew-resize' };

                    return (
                        <div
                            key={pos}
                            style={style}
                            className={`${cursors[pos]} hover:scale-110`}
                            data-handle-type={pos}
                            onMouseDown={(e) => handleMouseDown(e, pos)}
                        >
                            {isAndroid && <ScaleIcon size={s * 0.5} color="#3b82f6" />}
                        </div>
                    );
                })}

                {showHandles && ['tl', 'tr', 'bl', 'br'].map(c => {
                    const s = isAndroid ? 30 : 30;
                    const offset = isAndroid ? -40 : -35;
                    return (
                        <div
                            key={`r-${c}`}
                            className="absolute pointer-events-auto"
                            style={{
                                width: s, height: s,
                                borderRadius: isAndroid ? '50%' : '0',
                                backgroundColor: isAndroid ? 'white' : 'transparent',
                                border: isAndroid ? '1.5px solid #3b82f6' : 'none',
                                cursor: makeRotateCursor(),
                                zIndex: 110,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                boxShadow: isAndroid ? '0 1px 4px rgba(0,0,0,0.15)' : 'none',
                                top: c.includes('t') ? offset : 'auto',
                                bottom: c.includes('b') ? offset : 'auto',
                                left: c.includes('l') ? offset : 'auto',
                                right: c.includes('r') ? offset : 'auto'
                            }}
                            data-handle-type="rotate"
                            onMouseDown={(e) => handleMouseDown(e, 'rotate')}
                        >
                            {isAndroid && <RotateIcon size={s * 0.5} color="#3b82f6" />}
                        </div>
                    );
                })}
            </div>
        </>
    );
};
