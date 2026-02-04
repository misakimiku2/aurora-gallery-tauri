import React from 'react';
import { AuroraLogo } from './Logo';

interface SplashScreenProps {
  isVisible: boolean;
  loadingInfo?: string[];
}

const SplashScreen: React.FC<SplashScreenProps> = ({ isVisible, loadingInfo = [] }) => {
  if (!isVisible) return null;

  return (
    <div className="fixed inset-0 z-[1000] bg-[#fafafa] dark:bg-[#0a0a0a] flex flex-col items-center justify-center pointer-events-auto overflow-hidden font-sans">
      <style>{`
        @keyframes float {
          0% { transform: translateY(0px) rotate(0deg); }
          50% { transform: translateY(-15px) rotate(1deg); }
          100% { transform: translateY(0px) rotate(0deg); }
        }
        @keyframes pulse-glow {
          0%, 100% { opacity: 0.3; transform: scale(1); filter: blur(120px); }
          50% { opacity: 0.5; transform: scale(1.2); filter: blur(160px); }
        }
        @keyframes mesh-move {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        @keyframes progress-shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        @keyframes text-shine {
          0% { background-position: 0% 50%; }
          100% { background-position: 100% 50%; }
        }
        .animate-float {
          animation: float 6s ease-in-out infinite;
        }
        .animate-pulse-glow {
          animation: pulse-glow 7s ease-in-out infinite;
        }
        .mesh-gradient {
          background: radial-gradient(circle at 20% 30%, rgba(59, 130, 246, 0.1) 0%, rgba(59, 130, 246, 0.04) 30%, transparent 70%),
                      radial-gradient(circle at 80% 70%, rgba(139, 92, 246, 0.1) 0%, rgba(139, 92, 246, 0.04) 30%, transparent 70%),
                      radial-gradient(circle at 50% 50%, rgba(236, 72, 153, 0.06) 0%, rgba(236, 72, 153, 0.02) 40%, transparent 80%);
          background-size: 200% 200%;
          animation: mesh-move 20s ease-in-out infinite;
        }
        .text-shimmer {
          background: linear-gradient(
            to right,
            #3b82f6 0%,
            #8b5cf6 25%,
            #ec4899 50%,
            #8b5cf6 75%,
            #3b82f6 100%
          );
          background-size: 200% auto;
          color: transparent;
          -webkit-background-clip: text;
          background-clip: text;
          animation: text-shine 4s linear infinite;
        }
        .dark .text-shimmer {
          background: linear-gradient(
            to right,
            #60a5fa 0%,
            #a78bfa 25%,
            #f472b6 50%,
            #a78bfa 75%,
            #60a5fa 100%
          );
          background-size: 200% auto;
          -webkit-background-clip: text;
          background-clip: text;
        }
        .noise-overlay {
          background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E");
        }
        .delay-0 { animation-delay: 0s; }
        .delay-15 { animation-delay: 0.15s; }
        .delay-30 { animation-delay: 0.3s; }
        .delay-neg-25 { animation-delay: -2.5s; }
      `}</style>

      {/* 动态背景 */}
      <div className="absolute inset-0 mesh-gradient pointer-events-none" />
      
      {/* 背景装饰光晕 */}
      <div className="absolute top-[10%] -left-20 w-[400px] h-[400px] bg-blue-400/10 dark:bg-blue-600/5 rounded-full animate-pulse-glow delay-0" />
      <div className="absolute bottom-[10%] -right-20 w-[400px] h-[400px] bg-purple-400/10 dark:bg-purple-600/5 rounded-full animate-pulse-glow delay-neg-25" />

      {/* 顶部覆盖条（针对Tauri自定义标题栏） */}
      <div className="absolute top-0 left-0 right-0 h-10 bg-white/5 dark:bg-black/5 backdrop-blur-sm z-[1001]" />

      {/* 主内容容器 */}
      <div className="relative z-10 flex flex-col items-center max-w-md w-full px-12">
        {/* Logo 区域 */}
        <div className="relative mb-14 animate-float">
          {/* Logo 底部的发光效果 */}
          <div className="absolute inset-0 bg-blue-500/15 dark:bg-blue-400/15 blur-3xl rounded-full scale-[2.5]" />
          
          <div className="relative flex flex-col items-center">
            <div className="drop-shadow-[0_10px_40px_rgba(59,130,246,0.4)] dark:drop-shadow-[0_10px_40px_rgba(59,130,246,0.3)]">
              <AuroraLogo size={160} />
            </div>
          </div>
        </div>

        {/* 标题 */}
        <div className="text-center space-y-3 mb-16">
          <h1 className="text-6xl font-black tracking-tighter text-shimmer">
            AURORA
          </h1>
          <div className="flex items-center justify-center space-x-3">
            <div className="h-[1px] w-8 bg-gradient-to-r from-transparent to-gray-300 dark:to-gray-700" />
            <p className="text-gray-400 dark:text-gray-500 font-bold tracking-[0.4em] text-[10px] uppercase">
              Beyond the Vision
            </p>
            <div className="h-[1px] w-8 bg-gradient-to-l from-transparent to-gray-300 dark:to-gray-700" />
          </div>
        </div>

        {/* 加载状态 */}
        <div className="w-full space-y-8">
          <div className="relative h-[2px] w-full bg-gray-200 dark:bg-gray-800/50 rounded-full overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-r from-blue-500 via-purple-500 to-blue-500 rounded-full w-full opacity-40 animate-pulse" />
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/40 to-transparent w-full animate-[progress-shimmer_1.5s_infinite]" />
          </div>

          <div className="flex flex-col items-center justify-center space-y-6">
            <div className="flex items-center space-x-1.5">
              <div className="w-1 h-1 bg-blue-500 dark:bg-blue-400 rounded-full animate-bounce delay-0" />
              <div className="w-1 h-1 bg-blue-500 dark:bg-blue-400 rounded-full animate-bounce delay-15" />
              <div className="w-1 h-1 bg-blue-500 dark:bg-blue-400 rounded-full animate-bounce delay-30" />
            </div>
            
            <div className="h-6 flex flex-col items-center justify-center overflow-hidden">
              <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 tracking-wide transition-all duration-500">
                {loadingInfo.length > 0 ? (
                  <span className="inline-block">
                    {loadingInfo[loadingInfo.length - 1]}
                  </span>
                ) : (
                  "INITIALIZING SYSTEM"
                )}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* 底部信息 */}
      <div className="absolute bottom-12 flex flex-col items-center space-y-4">
        <div className="flex items-center space-x-4 opacity-40 grayscale hover:grayscale-0 transition-all duration-500 cursor-default">
            <div className="text-[10px] font-bold text-gray-400 dark:text-gray-500 tracking-[0.3em] uppercase">
              Next-Gen Gallery
            </div>
        </div>
        <div className="flex flex-col items-center space-y-1">
          <span className="text-[9px] font-black text-blue-500/50 dark:text-blue-400/40 tracking-widest uppercase">
            Product of Misakimiku
          </span>
          <span className="text-[10px] font-medium text-gray-400/60 dark:text-gray-500/60">
            v1.1.0-stable
          </span>
        </div>
      </div>

      {/* 噪点纹理叠加 */}
      <div className="absolute inset-0 pointer-events-none opacity-[0.03] dark:opacity-[0.05] mix-blend-overlay noise-overlay" />
    </div>
  );
};

export default SplashScreen;
