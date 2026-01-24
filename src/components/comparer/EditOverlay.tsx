import React, { useState, useEffect, useRef } from 'react';
import { ComparisonItem } from './types';

// Photoshop 风格的旋转光标
const rotateCursor = `url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Cpath d='M16 4v4l-4-4 4-4v4c4.42 0 8 3.58 8 8 0 1.57-.46 3.03-1.24 4.26L21.31 15a5.95 5.95 0 0 0 .69-2.74c0-3.31-2.69-6-6-6z' fill='%23000'/%3E%3Cpath d='M16 28v-4l4 4-4 4v-4c-4.42 0-8-3.58-8-8 0-1.57.46-3.03 1.24-4.26L10.69 17a5.95 5.95 0 0 0-.69 2.74c0 3.31 2.69 6 6 6z' fill='%23000'/%3E%3C/svg%3E") 16 16, alias`;

interface EditOverlayProps {
    activeItem: ComparisonItem | null;
    selectedItems?: ComparisonItem[];
    allItems: ComparisonItem[];
    transform: { x: number; y: number; scale: number };
    onUpdateItem: (id: string, updates: Partial<ComparisonItem>) => void;
    onRemoveItem: (id: string) => void;
    // Notifies the parent that a drag interaction started/ended (for groups we need to update transient state)
    onInteractionStart?: () => void;
    onInteractionEnd?: () => void;
    containerRef?: React.RefObject<HTMLDivElement>;
    isSnappingEnabled?: boolean;
}

type HandleType = 'tl' | 'tc' | 'tr' | 'ml' | 'mr' | 'bl' | 'bc' | 'br';

interface SnapGuide {
    type: 'x' | 'y';
    pos: number;
    start: number;
    end: number;
    targetId: string;
}

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
    isSnappingEnabled = true
}) => {
    const [dragType, setDragType] = useState<string | null>(null);
    const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
    const startState = useRef({
        pivotWorld: { x: 0, y: 0 },
        itemR: 0,
        aspectRatio: 1,
        // For rotation
        centerX: 0, centerY: 0, startMouseAngle: 0,
        // For move
        itemX: 0, itemY: 0, startMouseWorld: { x: 0, y: 0 },
        // For scale offset correction
        clickOffset: { x: 0, y: 0 }
    });

    useEffect(() => {
        if (!activeItem || !dragType) return;

        const handleMouseMove = (e: MouseEvent) => {
            const rect = containerRef?.current?.getBoundingClientRect();
            const mouseX = rect ? e.clientX - rect.left : e.clientX;
            const mouseY = rect ? e.clientY - rect.top : e.clientY;

            // 当前鼠标的世界坐标
            const mx = (mouseX - transform.x) / transform.scale;
            const my = (mouseY - transform.y) / transform.scale;

            if (dragType === 'move') {
                const dx = mx - startState.current.startMouseWorld.x;
                const dy = my - startState.current.startMouseWorld.y;

                let newX = startState.current.itemX + dx;
                let newY = startState.current.itemY + dy;

                // 吸附逻辑 (感官对齐：15 屏幕像素)
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
                        // 1. 排除自身及所有选中项（防止多选移动时自吸附导致抽搐）
                        if (item.id === activeItem.id || selectedIds.includes(item.id)) return;

                        // 计算吸附目标 item 的旋转后 AABB
                        const o = getRotatedAABB(item);

                        // 计算移动项 activeItem 在当前假设位置 (newX, newY) 下的临时 AABB
                        // 注意：activeItem.rotation 是固定的，只有位置在变
                        const m = getRotatedAABB({ ...activeItem, x: newX, y: newY });

                        // 2. 邻近判定 (Proximity Check): 只有在另一个轴向上相对接近时才触发吸附
                        // 改用基于屏幕像素的固定阈值（如 200px），确保在任何缩放级别下，
                        // 只有“视觉上看起来靠近”的图才会吸附。
                        const proximityThreshold = 200 / transform.scale;

                        const isNearHorizontally = (m.l < o.r + proximityThreshold) && (m.r > o.l - proximityThreshold);
                        const isNearVertically = (m.t < o.b + proximityThreshold) && (m.b > o.t - proximityThreshold);

                        // 水平吸附 (对齐 X 坐标) - 仅在垂直方向靠近时
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
                                    // 计算为了让 m 的相应边缘达到 s.val 所需的 newX 偏移
                                    const offset = s.val - (s.type === 'l' ? m.l : (s.type === 'r' ? m.r : m.cx));
                                    bestSnapX = newX + offset;

                                    // 记录辅助线范围
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

                        // 垂直吸附 (对齐 Y 坐标) - 仅在水平方向靠近时
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
                                    // 对于 Y 轴吸附，逻辑相同
                                    const offset = s.val - (s.type === 't' ? m.t : (s.type === 'b' ? m.b : m.cy));
                                    bestSnapY = newY + offset;

                                    // 记录辅助线范围
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

                if (e.shiftKey) deg = Math.round(deg / 15) * 15;
                onUpdateItem(activeItem.id, { rotation: deg });
            }
            else {
                // =============== 核心缩放算法: Un-rotate Mouse Position with Offset ===============
                const { pivotWorld, itemR, aspectRatio, clickOffset } = startState.current;
                const rad = (itemR * Math.PI) / 180;
                const cos = Math.cos(-rad); // 反向旋转
                const sin = Math.sin(-rad);

                // 1. 计算鼠标相对于 Pivot 的向量
                const vx = mx - pivotWorld.x;
                const vy = my - pivotWorld.y;

                // 2. 将向量反向旋转至轴对齐局部空间
                // localMouseX/Y 指鼠标在局部空间相对于 Pivot 的位置
                const localMouseX = vx * cos - vy * sin;
                const localMouseY = vx * sin + vy * cos;

                // 3. 应用点击时的偏移量，恢复到实际 Corner 的位置
                // 这样即使鼠标点击偏移了几个像素，计算出的 dimensions 也是图片实际尺寸 + Delta
                const perfectCornerX = localMouseX + clickOffset.x;
                const perfectCornerY = localMouseY + clickOffset.y;

                // 4. 计算原始宽度高度 (取绝对值)
                let w = Math.abs(perfectCornerX);
                let h = Math.abs(perfectCornerY);

                // 5. 等比约束
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

                // 6. 计算新中心点
                // Pivot 在局部空间相对于新中心的坐标是固定的结构位置
                // 例如 Pivot 是 BR，则它在局部系的坐标是 (+w/2, +h/2) 相对于中心
                // 所以 CenterLocal = PivotLocal - Offset

                // 我们需要知道 Pivot 是哪个角 (TL/TR/BL/BR/TC/BC/ML/MR)
                // 在 mouseDown 时我们选择了“对角”作为 Pivot。
                // 设 X方向因子 kx, Y方向因子 ky。
                // 如果 Pivot 是 BR (Dragging TL), Pivot相对于Center是 (+w/2, +h/2).

                let kx = 0; // 1 = Right, -1 = Left, 0 = Center
                let ky = 0; // 1 = Bottom, -1 = Top, 0 = Center

                // 根据 DragType 反推 Pivot 的位置因子
                // Drag TL -> Pivot BR -> kx=1, ky=1
                if (dragType.includes('l')) kx = 1; // Drag Left -> Pivot Right
                else if (dragType.includes('r')) kx = -1; // Drag Right -> Pivot Left
                else kx = 0;

                // 修正：对于 Center Points，Pivot 是对边中点
                if (dragType.includes('t')) ky = 1;
                else if (dragType.includes('b')) ky = -1;
                else ky = 0;

                // 新的 Center 在局部空间相对于 Pivot 的偏移向量
                // Unrotated Offset from Pivot to Center = (-kx * w/2, -ky * h/2)
                const offX = -kx * w / 2;
                const offY = -ky * h / 2;

                // 7. 将偏移向量正向旋转回世界坐标
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

        const handleMouseUp = () => {
            setDragType(null);
            setSnapGuides([]);
            onInteractionEnd?.();
        };
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [dragType, activeItem, transform, onUpdateItem, allItems]);

    if (!activeItem) return null;

    const handleMouseDown = (e: React.MouseEvent, type: string) => {
        if (e.button !== 0) return; // Only allow left mouse button

        const rect = containerRef?.current?.getBoundingClientRect();
        const mouseViewportX = rect ? e.clientX - rect.left : e.clientX;
        const mouseViewportY = rect ? e.clientY - rect.top : e.clientY;

        const mx = (mouseViewportX - transform.x) / transform.scale;
        const my = (mouseViewportY - transform.y) / transform.scale;

        // Helper: test point inside rotated item with optional world-space tolerance
        const pointInRotated = (wx: number, wy: number, it: ComparisonItem, tolWorld = 0) => {
            const cx = it.x + it.width / 2;
            const cy = it.y + it.height / 2;
            const rad = -it.rotation * Math.PI / 180; // rotate point back by -rotation
            const dx = wx - cx;
            const dy = wy - cy;
            const lx = dx * Math.cos(rad) - dy * Math.sin(rad) + cx;
            const ly = dx * Math.sin(rad) + dy * Math.cos(rad) + cy;
            return lx >= it.x - tolWorld && lx <= it.x + it.width + tolWorld && ly >= it.y - tolWorld && ly <= it.y + it.height + tolWorld;
        };

        // Decide whether to capture this mousedown. For handle/rotate always capture.
        let shouldCapture = true;
        if (type === 'move') {
            const tolPx = 6; // screen-space tolerance in pixels
            const tolWorld = Math.max(0, tolPx / Math.max(1e-6, transform.scale));

            // Helper to get axis-aligned screen-space AABB for a rotated item
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

            // If this is group-mode (activeItem is a bounding box for many items), only capture if the click lands on any selected item's visible screen AABB (with tolerance)
            // AND also pass the precise rotated hit-test (world-space) so corners/rotated areas work.
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
                // single item: do fast rotated-screen-AABB test first (with tol), then precise rotated test in world space
                const r = itemScreenAABB(activeItem);
                if (ptX >= r.minX - tolPx && ptX <= r.maxX + tolPx && ptY >= r.minY - tolPx && ptY <= r.maxY + tolPx) {
                    shouldCapture = pointInRotated(mx, my, activeItem, tolWorld);
                } else {
                    shouldCapture = false;
                }
            }
        }

        if (!shouldCapture) {
            // Let the event bubble to parent so underlying items can be selected
            return;
        }

        // Otherwise capture and proceed
        e.stopPropagation();

        const cx = activeItem.x + activeItem.width / 2;
        const cy = activeItem.y + activeItem.height / 2;
        const rad = (activeItem.rotation * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        // 计算 Pivot (固定点) 的世界坐标
        // Pivot 是 Drag Handle 的中心对称点 (或者对边中点)
        let px = 0; // -1 Left, 0 Center, 1 Right (Local Factor)
        let py = 0; // -1 Top, 0 Center, 1 Bottom (Local Factor)

        if (type.includes('l')) px = 1; // Drag Left -> Pivot is Right (+0.5w)
        else if (type.includes('r')) px = -1; // Drag Right -> Pivot is Left (-0.5w)
        else px = 0;

        if (type.includes('t')) py = 1; // Drag Top -> Pivot is Bottom (+0.5h)
        else if (type.includes('b')) py = -1; // Drag Bottom -> Pivot is Top (-0.5h)
        else py = 0;

        // Local Offset of Pivot from Center
        const lpx = px * activeItem.width / 2;
        const lpy = py * activeItem.height / 2;

        // World Pivot
        const pivotWorld = {
            x: cx + (lpx * cos - lpy * sin),
            y: cy + (lpx * sin + lpy * cos)
        };

        // 计算 clickOffset
        // 1. Un-rotate Mouse to Local relative to Pivot
        const rCos = Math.cos(-rad);
        const rSin = Math.sin(-rad);
        const vx = mx - pivotWorld.x;
        const vy = my - pivotWorld.y;
        const localMouseX = vx * rCos - vy * rSin;
        const localMouseY = vx * rSin + vy * rCos;

        // 2. Calculate Actual Local Corner Position
        // Handle (Corner) Local Coords relative to Center:
        let hx = 0; if (type.includes('l')) hx = -activeItem.width / 2; else if (type.includes('r')) hx = activeItem.width / 2;
        let hy = 0; if (type.includes('t')) hy = -activeItem.height / 2; else if (type.includes('b')) hy = activeItem.height / 2;

        // Pivot Local Coords relative to Center was already calculated as lpx, lpy.
        // Vector Pivot -> Corner (Local Axis Aligned)
        const targetLocalX = hx - (px * activeItem.width / 2);
        const targetLocalY = hy - (py * activeItem.height / 2);

        // Offset = Target - Mouse
        // Adding this offset to subsequent mouse positions effectively "snaps" the mouse to the corner logically
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
        // Notify parent that interaction started
        onInteractionStart?.();
    };

    // 屏幕空间显示
    const screenX = activeItem.x * transform.scale + transform.x;
    const screenY = activeItem.y * transform.scale + transform.y;
    const screenW = activeItem.width * transform.scale;
    const screenH = activeItem.height * transform.scale;

    const snapTargetIds = isSnappingEnabled ? snapGuides.map(g => g.targetId) : [];

    return (
        <>
            {/* 渲染吸附辅助线 */}
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

            {/* 渲染其他选中项的辅助边框 */}
            {allItems.map(item => {
                const isSelected = selectedItems.some(si => si.id === item.id);
                const isSnapTarget = snapTargetIds.includes(item.id);

                // 只有当是选中项且不是活跃项，或者是吸附目标时才渲染
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

            <div className="absolute pointer-events-none"
                style={{ left: screenX, top: screenY, width: screenW, height: screenH, transform: `rotate(${activeItem.rotation}deg)`, transformOrigin: 'center', border: '1px solid #3b82f6', zIndex: 100 }}>
                {/* 移动区域 (Internal) */}
                <div onMouseDown={(e) => handleMouseDown(e, 'move')} className="absolute inset-0 cursor-move pointer-events-auto" />

                {/* 8 个控制点 */}
                {(['tl', 'tc', 'tr', 'ml', 'mr', 'bl', 'bc', 'br'] as HandleType[]).map(pos => {
                    const s = 10;
                    const style: React.CSSProperties = { position: 'absolute', width: s, height: s, backgroundColor: 'white', border: '1.5px solid #3b82f6', zIndex: 120, pointerEvents: 'auto', transition: 'transform 0.1s' };
                    if (pos.includes('t')) style.top = -s / 2; else if (pos.includes('b')) style.bottom = -s / 2;
                    if (pos.includes('l')) style.left = -s / 2; else if (pos.includes('r')) style.right = -s / 2;
                    if (pos === 'tc' || pos === 'bc') { style.left = '50%'; style.transform = 'translateX(-50%)'; }
                    if (pos === 'ml' || pos === 'mr') { style.top = '50%'; style.transform = 'translateY(-50%)'; }

                    const cursors: Record<string, string> = { tl: 'nwse-resize', tr: 'nesw-resize', bl: 'nesw-resize', br: 'nwse-resize', tc: 'ns-resize', bc: 'ns-resize', ml: 'ew-resize', mr: 'ew-resize' };
                    return <div key={pos} style={style} className={`${cursors[pos]} hover:scale-125 shadow-sm`} onMouseDown={(e) => handleMouseDown(e, pos)} />;
                })}

                {/* 旋转感应区 (Outward) */}
                {['tl', 'tr', 'bl', 'br'].map(c => (
                    <div key={`r-${c}`} className="absolute pointer-events-auto" style={{
                        width: 30, height: 30, cursor: rotateCursor, zIndex: 110,
                        top: c.includes('t') ? -35 : 'auto', bottom: c.includes('b') ? -35 : 'auto',
                        left: c.includes('l') ? -35 : 'auto', right: c.includes('r') ? -35 : 'auto'
                    }} onMouseDown={(e) => handleMouseDown(e, 'rotate')} />
                ))}
            </div>
        </>
    );
};
