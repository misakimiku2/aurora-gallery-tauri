
import { LayoutMode, FileNode, FileType, Person } from '../types';

export interface LayoutItem {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface LayoutWorkerInput {
    items: string[];
    // We pass aspect ratios directly instead of full file objects to save transfer time
    aspectRatios: Record<string, number>; 
    layoutMode: LayoutMode;
    containerWidth: number;
    thumbnailSize: number;
    viewMode: 'browser' | 'tags-overview' | 'people-overview';
    // groupedTags: Record<string, string[]>; // Not used in layout calculation logic shown in snippet
    // searchQuery: string; // Not used in snippet logic
}

export interface LayoutWorkerOutput {
    layout: LayoutItem[];
    totalHeight: number;
}

self.onmessage = (e: MessageEvent<LayoutWorkerInput>) => {
    // console.time('Worker Calculation'); // Optional: Measure time
    const { 
        items, 
        aspectRatios, 
        layoutMode, 
        containerWidth, 
        thumbnailSize,
        viewMode 
    } = e.data;

    console.log(`[LayoutWorker] Received task: ${items.length} items, width=${containerWidth}, mode=${layoutMode}`);

    const layout: LayoutItem[] = [];
    let totalHeight = 0;
    const GAP = 16;
    const PADDING = 24;
    
    // Ensure we have a reasonable width
    const safeContainerWidth = containerWidth > 0 ? containerWidth : 1280; 
    const availableWidth = Math.max(100, safeContainerWidth - (PADDING * 2));
    const finalAvailableWidth = availableWidth;

    if (viewMode === 'browser') {
        if (layoutMode === 'list') {
            const itemHeight = 44;
            items.forEach((id, index) => {
                layout.push({ id, x: PADDING, y: PADDING + index * itemHeight, width: finalAvailableWidth, height: itemHeight });
            });
            totalHeight = PADDING + items.length * itemHeight;
        } else if (layoutMode === 'grid') {
            const minColWidth = thumbnailSize;
            const cols = Math.max(1, Math.floor((finalAvailableWidth + GAP) / (minColWidth + GAP)));
            const itemWidth = (finalAvailableWidth - (cols - 1) * GAP) / cols;
            const itemHeight = itemWidth + 40;

            items.forEach((id, index) => {
                const row = Math.floor(index / cols);
                const col = index % cols;
                layout.push({
                    id,
                    x: PADDING + col * (itemWidth + GAP),
                    y: PADDING + row * (itemHeight + GAP),
                    width: itemWidth,
                    height: itemHeight
                });
            });
            const rows = Math.ceil(items.length / cols);
            totalHeight = PADDING + rows * (itemHeight + GAP);
        } else if (layoutMode === 'adaptive') {
            let currentRow: { id: string, w: number }[] = [];
            let currentWidth = 0;
            const targetHeight = thumbnailSize; // Base height for rows
            let y = PADDING;

            items.forEach((id, index) => {
                // Adaptive layout logic
                const ratio = aspectRatios[id] || 1;
                // Calculate width if height was targetHeight
                const w = targetHeight * ratio;
                
                // If adding this item exceeds row width (with some tolerance or simple threshold)
                // Note: The original logic in FileGrid used a more complex accumulated width check.
                // We'll reimplement a standard adaptive row algorithm here.
                
                // Check if current row + new item fits? 
                // Actually, adaptive layout usually accumulates until > width, then compresses.
                
                currentRow.push({ id, w });
                currentWidth += w;

                // Estimate gap usage
                const gaps = Math.max(0, currentRow.length - 1) * GAP;
                
                // If row is full enough
                if (currentWidth + gaps >= finalAvailableWidth || index === items.length - 1) {
                    // Normalize row to fit exactly finalAvailableWidth
                    // total_w * scale + gaps = availableWidth
                    // scale = (availableWidth - gaps) / total_w
                    
                    // Don't stretch the last row if it's too short
                    let scale = (finalAvailableWidth - gaps) / currentWidth;
                    
                    if (index === items.length - 1 && currentWidth + gaps < finalAvailableWidth / 2) {
                        scale = 1; // Don't stretch last partial row
                    }

                    const rowHeight = targetHeight * scale;
                    let x = PADDING;
                    
                    currentRow.forEach(item => {
                        const finalW = item.w * scale;
                        layout.push({ 
                            id: item.id, 
                            x, 
                            y, 
                            width: finalW, 
                            height: rowHeight + 40 // +40 for metadata/padding
                        });
                        x += finalW + GAP;
                    });

                    y += rowHeight + 40 + GAP;
                    currentRow = [];
                    currentWidth = 0;
                }
            });
            totalHeight = y;
        }
    } else {
        // Fallback for other modes (people/tags) - simplified grid
        const minColWidth = thumbnailSize;
        const cols = Math.max(1, Math.floor((finalAvailableWidth + GAP) / (minColWidth + GAP)));
        const itemWidth = (finalAvailableWidth - (cols - 1) * GAP) / cols;
        const itemHeight = itemWidth + 60; // Extra space for text

        items.forEach((id, index) => {
            const row = Math.floor(index / cols);
            const col = index % cols;
            layout.push({
                id,
                x: PADDING + col * (itemWidth + GAP),
                y: PADDING + row * (itemHeight + GAP),
                width: itemWidth,
                height: itemHeight
            });
        });
        const rows = Math.ceil(items.length / cols);
        totalHeight = PADDING + rows * (itemHeight + GAP);
    }
    
    // Send back results
    console.log(`[LayoutWorker] Finished calculation. Total height: ${totalHeight}`);
    // console.timeEnd('Worker Calculation');
    self.postMessage({ layout, totalHeight } as LayoutWorkerOutput);
};
