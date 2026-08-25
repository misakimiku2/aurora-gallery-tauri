import { FileNode, FileType } from '../types';

// 辅助函数：深度查找文件夹内的图片
export const findImagesDeeply = (
    rootFolder: FileNode,
    allFiles: Record<string, FileNode>,
    limit: number = 3
): FileNode[] => {
    const images: FileNode[] = [];
    // 使用栈进行 DFS
    const stack: string[] = [...(rootFolder.children || [])];
    const visited = new Set<string>(); // 防止循环引用

    // 设置一个遍历上限，防止超大文件夹卡住 UI
    let traversalCount = 0;
    const MAX_TRAVERSAL = 200;

    while (stack.length > 0 && images.length < limit && traversalCount < MAX_TRAVERSAL) {
        const id = stack.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);
        traversalCount++;

        const node = allFiles[id];
        if (!node) continue;

        if (node.type === FileType.IMAGE) {
            images.push(node);
        } else if (node.type === FileType.FOLDER && node.children) {
            stack.push(...node.children);
        }
    }

    // 排序并截取
    return images
        .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''))
        .slice(0, limit);
};
