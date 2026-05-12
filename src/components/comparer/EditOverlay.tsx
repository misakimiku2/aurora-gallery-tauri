import React, { useState, useEffect, useRef } from 'react';
import { ComparisonItem } from './types';

const makeRotateCursor = (isDark: boolean) => {
    const fill = isDark ? '%23ffffff' : '%23000000';
    return `url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Cpath d='M16 4v4l-4-4 4-4v4c4.42 0 8 3.58 8 8 0 1.57-.46 3.03-1.24 4.26L21.31 15a5.95 5.95 0 0 0 .69-2.74c0-3.31-2.69-6-6-6z' fill='${fill}'/%3E%3Cpath d='M16 28v-4l4 4-4 4v-4c-4.42 0-8-3.58-8-8 0-1.57.46-3.03 1.24-4.26L10.69 17a5.95 5.95 0 0 0-.69 2.74c0 3.31 2.69 6 6 6z' fill='${fill}'/%3E%3C/svg%3E") 16 16, alias`;
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
    isDarkMode?: boolean;
    isEditMode?: boolean;
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
    isDarkMode = false,
    isEditMode = true,
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

    const showHandles = isEditMode;

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

                allItems.forEach(item => {
                    if (item.id === activeItem.id || selectedIds.includes(item.id)) return;

                    const o = getRotatedAABB(item);
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
                                    targetId: item.id
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
                                    targetId: item.id
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
    }, [dragType, activeItem, transform, onUpdateItem, allItems, isAndroid]);

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
                style={{ left: screenX, top: screenY, width: screenW, height: screenH, transform: `rotate(${activeItem.rotation}deg)`, transformOrigin: 'center', border: '1px solid #3b82f6', zIndex: 100 }}>
                {showHandles && (
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

                    const cursors: Record<string, string> = { tl: 'nwse-resize', tr: 'nesw-resize', bl: 'nesw-resize', br: 'nwse-resize', tc: 'ns-resize', bc: 'ns-resize', ml: 'ew-resize', mr: 'ew-resize' };

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
                                cursor: makeRotateCursor(!!isDarkMode),
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
