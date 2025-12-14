import React from 'react';
import { AuroraLogo } from './Logo';

interface SplashScreenProps {
  isVisible: boolean;
  loadingInfo?: string[];
}

const SplashScreen: React.FC<SplashScreenProps> = ({ isVisible, loadingInfo = [] }) => {
  if (!isVisible) return null;

  return (
    <div className="fixed inset-0 z-[1000] bg-gradient-to-br from-blue-50 to-purple-50 dark:from-gray-950 dark:to-gray-900 flex flex-col items-center justify-center pointer-events-auto">
      {/* 背景装饰 */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -left-40 w-80 h-80 bg-blue-500/10 dark:bg-blue-500/20 rounded-full blur-3xl"></div>
        <div className="absolute -bottom-40 -right-40 w-80 h-80 bg-purple-500/10 dark:bg-purple-500/20 rounded-full blur-3xl"></div>
      </div>
      {/* 顶部覆盖条，遮挡标题栏区域和窗口按钮 */}
      <div className="absolute top-0 left-0 right-0 h-40 bg-gradient-to-b from-blue-50 to-transparent dark:from-gray-950 to-transparent pointer-events-auto z-[1001]"></div>

      {/* 主内容 */}
      <div className="relative z-10 flex flex-col items-center justify-center h-full">
        {/* Logo 和名称 */}
        <div className="flex flex-col items-center space-y-4 mb-8">
          {/* 去掉外框，放大图标，添加更明显的投影 */}
          <div className="flex items-center justify-center">
            {/* 使用drop-shadow滤镜，确保阴影只应用到图标实际形状 */}
            <div className="dark:hidden">
              {/* 浅色模式投影 - 增强强度，向下偏移10像素 */}
              <AuroraLogo size={140} style={{ filter: 'drop-shadow(0 18px 16px rgba(59, 130, 246, 0.5)) drop-shadow(0 14px 8px rgba(59, 130, 246, 0.4))' }} />
            </div>
            <div className="hidden dark:block">
              {/* 深色模式投影 - 增强强度，向下偏移10像素 */}
              <AuroraLogo size={140} style={{ filter: 'drop-shadow(0 18px 16px rgba(96, 165, 250, 0.6)) drop-shadow(0 14px 8px rgba(96, 165, 250, 0.5))' }} />
            </div>
          </div>
          <h1 className="text-4xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 dark:from-blue-400 dark:to-purple-400 bg-clip-text text-transparent">
            AURORA
          </h1>
        </div>

        {/* 加载指示器 */}
        <div className="flex flex-col items-center space-y-3 mb-8">
          <div className="w-16 h-16 relative">
            {/* 旋转动画 */}
            <div className="absolute inset-0 border-4 border-blue-200 dark:border-blue-800 border-t-blue-600 dark:border-t-blue-400 rounded-full animate-spin"></div>
            <div className="absolute inset-2 border-4 border-purple-200 dark:border-purple-800 border-b-purple-600 dark:border-b-purple-400 rounded-full animate-spin-slow"></div>
          </div>
          <p className="text-gray-600 dark:text-gray-300 text-lg">
            加载中...
          </p>
        </div>

        {/* 调试信息区域 */}
        {loadingInfo.length > 0 && (
          <div className="absolute bottom-[10px] mx-auto w-[270px] overflow-hidden text-left">
            <pre className="text-xs text-gray-500 dark:text-gray-400 font-mono whitespace-nowrap overflow-hidden text-ellipsis">
              {loadingInfo[loadingInfo.length - 1]}
            </pre>
          </div>
        )}

        {/* 版本信息 - 放在最下方 */}
        <div className="absolute bottom-8 text-center">
          <p className="text-gray-500 dark:text-gray-400 text-sm">
            Version 1.1.0
          </p>
        </div>
      </div>
    </div>
  );
};

export default SplashScreen;
