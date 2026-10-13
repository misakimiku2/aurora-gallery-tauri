import { convertFileSrc } from '@tauri-apps/api/core';
import { FileNode } from '../../types';
import { useVideoCover } from '../../hooks/useVideoCover';

/**
 * 文件封面 <img>（P1.5-A 消费方共用：人物 hero 背景 / 多选专题卡片封面等）。
 *
 * - 图片 → 原文件 convertFileSrc（与既有行为一致）；
 * - 视频 → 抽帧封面 URL（useVideoCover 解析），未就绪 / 抽帧失败 → 返回 null，
 *   由调用方的条件分支给占位；
 * - ⚠️ 绝不把视频路径喂给 <img>（记忆 §2.1：mp4 进 <img> = 破图 + 缓存污染 + 大文件海量读取）。
 *
 * 注意：本组件内部用 hook，只能作为组件使用，不能在普通函数/条件分支里调用。
 */
const FileCoverImg = ({
    file,
    resourceRoot,
    className,
    alt,
    style,
}: {
    file?: FileNode;
    resourceRoot?: string;
    className?: string;
    alt?: string;
    style?: React.CSSProperties;
}) => {
    const { isVideo, coverUrl } = useVideoCover(
        file?.path,
        resourceRoot,
        file?.meta?.format,
        file?.size
    );
    if (!file?.path) return null;
    const src = isVideo ? coverUrl : convertFileSrc(file.path);
    if (!src) return null;
    return (
        <img
            src={src}
            className={className}
            alt={alt}
            style={style}
            decoding="async"
            draggable={false}
        />
    );
};

export default FileCoverImg;
