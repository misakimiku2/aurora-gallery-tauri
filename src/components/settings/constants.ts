import React from 'react';
import { Search, Image, Tag, Globe, Sparkles, Palette } from 'lucide-react';
import { ModelSeriesInfo, ClipModelInfo } from '../../types';

// 模型系列定义
export const MODEL_SERIES: ModelSeriesInfo[] = [
  {
    id: 'siglip',
    name: 'SigLIP 系列',
    description: 'Google 开发的多语言视觉模型',
    color: '#F97316',
  },
  {
    id: 'wd-tagger',
    name: 'WD Tagger 系列',
    description: '专为动漫和插画优化的标签识别模型',
    color: '#8B5CF6',
  },
];

// 功能特性标签配置
export const FEATURE_LABELS: Record<string, { icon: React.ElementType; label: string; color: string }> = {
  textSearch: { icon: Search, label: '文本搜索', color: 'blue' },
  imageSearch: { icon: Image, label: '以图搜图', color: 'green' },
  autoTagging: { icon: Tag, label: '自动标签', color: 'purple' },
  multilingual: { icon: Globe, label: '多语言', color: 'orange' },
  highPrecision: { icon: Sparkles, label: '高精度', color: 'yellow' },
  animeOptimized: { icon: Palette, label: '二次元', color: 'pink' },
};

export const CLIP_MODELS: ClipModelInfo[] = [
  {
    name: 'SigLIP2-Base',
    displayName: 'SigLIP 2 Base',
    description: '轻量级 - 多语言支持，适合低配置设备',
    size: 1600 * 1024 * 1024,
    sizeDisplay: '1.5 GB',
    embeddingDim: 768,
    isRecommended: true,
    series: 'siglip',
    features: {
      textSearch: true,
      imageSearch: true,
      autoTagging: false,
      multilingual: true,
    },
  },
  {
    name: 'SigLIP2-So400M',
    displayName: 'SigLIP 2 So400M',
    description: '高精度多语言支持 - 支持中文搜索',
    size: 4400 * 1024 * 1024,
    sizeDisplay: '4.3 GB',
    embeddingDim: 1152,
    isRecommended: false,
    series: 'siglip',
    isHighPrecision: true,
    features: {
      textSearch: true,
      imageSearch: true,
      autoTagging: false,
      multilingual: true,
    },
  },
  {
    name: 'WD-EVA02-Large-Tagger-V3',
    displayName: 'WD-EVA02-Large-Tagger-V3',
    description: '动漫/插画增强 - 自动标记标签 & 高质量二次元 Embedding',
    size: 1400 * 1024 * 1024,
    sizeDisplay: '1.4 GB',
    embeddingDim: 10861,
    isRecommended: true,
    series: 'wd-tagger',
    features: {
      textSearch: false,
      imageSearch: true,
      autoTagging: true,
      multilingual: false,
      animeOptimized: true,
    },
  },
];

// 全局状态，用于在组件卸载后保持生成状态
export const globalEmbeddingState = {
  isGenerating: false,
  progress: 0,
  stats: { current: 0, total: 0, success: 0, failed: 0, skipped: 0, processed: 0 },
  listeners: [] as ((() => void) | null)[],
  isInitialized: false,
  startTime: 0, // 开始时间戳
  estimatedTimeRemaining: 0, // 预估剩余时间（秒）
  isPaused: false, // 是否暂停
  isCancelling: false, // 是否正在取消
};
