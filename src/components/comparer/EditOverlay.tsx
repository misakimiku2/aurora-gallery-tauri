import React, { useState, useEffect, useRef } from 'react';
import { ComparisonItem } from './types';

// Photoshop 风格的旋转光标
const rotateCursor = `url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Cpath d='M16 4v4l-4-4 4-4v4c4.42 0 8 3.58 8 8 0 1.57-.46 3.03-1.24 4.26L21.31 15a5.95 5.95 0 0 0 .69-2.74c0-3.31-2.69-6-6-6z' fill='%23000'/%3E%3Cpath d='M16 28v-4l4 4-4 4v-4c-4.42 0-8-3.58-8-8 0-1.57.46-3.03 1.24-4.26L10.69 17a5.95 5.95 0 0 0-.69 2.74c0 3.31 2.69 6 6 6z' fill='%23000'/%3E%3C/svg%3E") 16 16, alias`;

interface EditOverlayProps {
    activeItem: ComparisonItem | null;
    allItems: ComparisonItem[];
    transform: { x: number; y: number; scale: number };
    onUpdateItem: (id: string, updates: Partial<ComparisonItem>) => void;
    onRemoveItem: (id: string) => void;
}

type HandleType = 'tl' | 'tc' | 'tr' | 'ml' | 'mr' | 'bl' | 'bc' | 'br';

export const EditOverlay: React.FC<EditOverlayProps> = ({
    activeItem,
    allItems,
    transform,
    onUpdateItem
}) => {
    const [dragType, setDragType] = useState<string | null>(null);
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
            // 当前鼠标的世界坐标
            const mx = (e.clientX - transform.x) / transform.scale;
            const my = (e.clientY - transform.y) / transform.scale;

            if (dragType === 'move') {
                const dx = mx - startState.current.startMouseWorld.x;
                const dy = my - startState.current.startMouseWorld.y;

                let newX = startState.current.itemX + dx;
                let newY = startState.current.itemY + dy;

                // 吸附逻辑 (感官对齐：15 屏幕像素)
                const screenThreshold = 15;
                const threshold = screenThreshold / transform.scale;

                allItems.forEach(item => {
                    if (item.id === activeItem.id) return;
                    const o = { l: item.x, r: item.x + item.width, cx: item.x + item.width / 2, t: item.y, b: item.y + item.height, cy: item.y + item.height / 2 };
                    const m = { l: newX, r: newX + activeItem.width, cx: newX + activeItem.width / 2, t: newY, b: newY + activeItem.height, cy: newY + activeItem.height / 2 };

                    if (Math.abs(m.l - o.l) < threshold) newX = o.l;
                    else if (Math.abs(m.l - o.r) < threshold) newX = o.r;
                    else if (Math.abs(m.r - o.l) < threshold) newX = o.l - activeItem.width;
                    else if (Math.abs(m.r - o.r) < threshold) newX = o.r - activeItem.width;
                    if (Math.abs(m.cx - o.cx) < threshold) newX = o.cx - activeItem.width / 2;

                    if (Math.abs(m.t - o.t) < threshold) newY = o.t;
                    else if (Math.abs(m.t - o.b) < threshold) newY = o.b;
                    else if (Math.abs(m.b - o.t) < threshold) newY = o.t - activeItem.height;
                    else if (Math.abs(m.b - o.b) < threshold) newY = o.b - activeItem.height;
                    if (Math.abs(m.cy - o.cy) < threshold) newY = o.cy - activeItem.height / 2;
                });

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

        const handleMouseUp = () => setDragType(null);
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
        e.stopPropagation();
        const mx = (e.clientX - transform.x) / transform.scale;
        const my = (e.clientY - transform.y) / transform.scale;

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
    };

    // 屏幕空间显示
    const screenX = activeItem.x * transform.scale + transform.x;
    const screenY = activeItem.y * transform.scale + transform.y;
    const screenW = activeItem.width * transform.scale;
    const screenH = activeItem.height * transform.scale;

    return (
        <div className="absolute pointer-events-none"
            style={{ left: screenX, top: screenY, width: screenW, height: screenH, transform: `rotate(${activeItem.rotation}deg)`, border: '1px solid #3b82f6', zIndex: 100 }}>
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
    );
};
