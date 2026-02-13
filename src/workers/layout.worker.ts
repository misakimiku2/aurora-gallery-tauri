
import { LayoutMode, FileNode, FileType, Person } from '../types';

export interface LayoutItem {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface PersonGroup {
    id: string;
    title: string;
    personIds: string[];
}

export interface LayoutWorkerInput {
    items: string[];
    // We pass aspect ratios directly instead of full file objects to save transfer time
    aspectRatios: Record<string, number>; 
    layoutMode: LayoutMode;
    containerWidth: number;
    thumbnailSize: number;
    viewMode: 'browser' | 'tags-overview' | 'people-overview';
    groupedTags?: Record<string, string[]>;
    searchQuery?: string;
    // People view grouping
    groupedPeople?: PersonGroup[];
    collapsedGroups?: Record<string, boolean>;
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
        viewMode,
        groupedTags,
        searchQuery,
        groupedPeople,
        collapsedGroups
    } = e.data;

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
        } else if (layoutMode === 'masonry') {
            // Masonry layout: place items into the shortest column
            const minColWidth = thumbnailSize;
            const cols = Math.max(1, Math.floor((finalAvailableWidth + GAP) / (minColWidth + GAP)));
            const colWidth = (finalAvailableWidth - (cols - 1) * GAP) / cols;
            const colHeights = new Array(cols).fill(PADDING);

            items.forEach((id) => {
                const ratio = aspectRatios[id] || 1; // width/height
                const imgHeight = ratio > 0 ? colWidth / ratio : colWidth; // height = width / (w/h) = h
                const itemHeight = imgHeight + 40; // add space for metadata/padding

                // find shortest column
                let minCol = 0;
                for (let i = 1; i < cols; i++) {
                    if (colHeights[i] < colHeights[minCol]) minCol = i;
                }

                const x = PADDING + minCol * (colWidth + GAP);
                const y = colHeights[minCol];

                layout.push({ id, x, y, width: colWidth, height: itemHeight });

                colHeights[minCol] += itemHeight + GAP;
            });

            totalHeight = Math.max(...colHeights);

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
    } else if (viewMode === 'tags-overview') {
        const query = searchQuery?.toLowerCase().trim();
        const filteredGroupedTags: Record<string, string[]> = {};
        if (groupedTags) {
            Object.entries(groupedTags).forEach(([key, tags]) => {
                const matchingTags = query 
                    ? tags.filter(tag => tag.toLowerCase().includes(query))
                    : tags;
                if (matchingTags.length > 0) {
                    filteredGroupedTags[key] = matchingTags;
                }
            });
        }

        const sortedKeys = Object.keys(filteredGroupedTags).sort();
        let y = PADDING;
        const HEADER_HEIGHT = 64;
        const TAG_GAP = 12;
        
        // Use a grid for tags within each group
        // In TagsList: grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6
        let cols = 2;
        if (safeContainerWidth >= 1536) cols = 6;
        else if (safeContainerWidth >= 1280) cols = 5;
        else if (safeContainerWidth >= 1024) cols = 4;
        else if (safeContainerWidth >= 768) cols = 3;
        
        const itemWidth = (finalAvailableWidth - (cols - 1) * TAG_GAP) / cols;
        const itemHeight = 100; // Estimated height for TagItem

        sortedKeys.forEach(key => {
            const tagsInGroup = filteredGroupedTags[key];
            
            // Add header layout item
            layout.push({
                id: `header:${key}`,
                x: PADDING,
                y,
                width: finalAvailableWidth,
                height: HEADER_HEIGHT
            });
            y += HEADER_HEIGHT;

            // Add tags in this group
            tagsInGroup.forEach((tag, index) => {
                const row = Math.floor(index / cols);
                const col = index % cols;
                layout.push({
                    id: `tag:${tag}`,
                    x: PADDING + col * (itemWidth + TAG_GAP),
                    y: y + row * (itemHeight + TAG_GAP),
                    width: itemWidth,
                    height: itemHeight
                });
            });

            const groupRowCount = Math.ceil(tagsInGroup.length / cols);
            y += groupRowCount * (itemHeight + TAG_GAP) + 32; // 32 is mb-8 spacing
        });
        
        totalHeight = y;
    } else if (viewMode === 'people-overview') {
        // People overview layout with grouping support
        const minColWidth = thumbnailSize;
        const cols = Math.max(1, Math.floor((finalAvailableWidth + GAP) / (minColWidth + GAP)));
        const itemWidth = (finalAvailableWidth - (cols - 1) * GAP) / cols;
        const itemHeight = itemWidth + 60; // Extra space for text
        const HEADER_HEIGHT = 48; // Group header height
        const GROUP_PADDING = 16;

        if (groupedPeople && groupedPeople.length > 0 && groupedPeople[0].id !== 'all') {
            // Grouped layout
            let currentY = PADDING;

            groupedPeople.forEach(group => {
                const isCollapsed = collapsedGroups?.[group.id];

                // Add group header
                layout.push({
                    id: `header:${group.id}`,
                    x: PADDING,
                    y: currentY,
                    width: finalAvailableWidth,
                    height: HEADER_HEIGHT
                });
                currentY += HEADER_HEIGHT;

                if (!isCollapsed) {
                    // Add items in this group
                    let colIndex = 0;
                    let rowIndex = 0;

                    group.personIds.forEach((personId, index) => {
                        // Only layout visible items (skip if not in items list)
                        if (!items.includes(personId)) return;

                        const x = PADDING + colIndex * (itemWidth + GAP);
                        const y = currentY + rowIndex * (itemHeight + GAP);

                        layout.push({
                            id: personId,
                            x,
                            y,
                            width: itemWidth,
                            height: itemHeight
                        });

                        colIndex++;
                        if (colIndex >= cols) {
                            colIndex = 0;
                            rowIndex++;
                        }
                    });

                    const rowsInGroup = Math.ceil(group.personIds.filter(id => items.includes(id)).length / cols);
                    currentY += rowsInGroup * (itemHeight + GAP) + GROUP_PADDING;
                } else {
                    currentY += GROUP_PADDING;
                }
            });

            totalHeight = currentY;
        } else {
            // Simple grid layout (no grouping)
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
    }
    
    // Send back results
    // console.timeEnd('Worker Calculation');
    self.postMessage({ layout, totalHeight } as LayoutWorkerOutput);
};
