import React, { useMemo } from 'react';

interface PullToRefreshIndicatorProps {
  pullDistance: number;
  isRefreshing: boolean;
  canRefresh: boolean;
  isComplete?: boolean;
  threshold?: number;
}

const DOT_COUNT = 12;

export const PullToRefreshIndicator: React.FC<PullToRefreshIndicatorProps> = ({
  pullDistance,
  isRefreshing,
  isComplete,
  threshold = 80,
}) => {
  const size = 40;
  const dotRadius = 2.2;
  const trackRadius = 13;
  const cx = size / 2;
  const cy = size / 2;

  const progress = isRefreshing || isComplete ? 1 : Math.min(pullDistance / threshold, 1);
  const activeDots = Math.ceil(progress * DOT_COUNT);

  const dots = useMemo(() => {
    return Array.from({ length: DOT_COUNT }, (_, i) => {
      const angle = (i * 360) / DOT_COUNT - 90;
      const rad = (angle * Math.PI) / 180;
      return {
        x: cx + trackRadius * Math.cos(rad),
        y: cy + trackRadius * Math.sin(rad),
        index: i,
        angle,
      };
    });
  }, [cx, cy, trackRadius]);

  const translateY = isRefreshing || isComplete
    ? threshold / 2
    : pullDistance > 0
      ? pullDistance / 2
      : -size;

  const opacity = pullDistance > 0 || isRefreshing || isComplete ? 1 : 0;

  const getDotOpacity = (index: number) => {
    if (isComplete) return 0;
    if (isRefreshing) {
      const stagger = index / DOT_COUNT;
      return 0.25 + 0.75 * stagger;
    }
    if (index < activeDots) {
      return 1;
    }
    if (index === activeDots && progress > 0) {
      return progress * DOT_COUNT - Math.floor(progress * DOT_COUNT);
    }
    return 0.15;
  };

  const getDotScale = (index: number) => {
    if (isComplete) return 0;
    if (isRefreshing) return 1;
    if (index < activeDots) return 1.15;
    if (index === activeDots) return 0.9 + 0.25 * (progress * DOT_COUNT - Math.floor(progress * DOT_COUNT));
    return 0.7;
  };

  return (
    <div
      className="absolute left-1/2 pointer-events-none z-50 flex items-center justify-center"
      style={{
        width: size,
        height: size,
        transform: `translate(-50%, ${translateY - size / 2}px)`,
        opacity,
        transition: (!isRefreshing && !isComplete)
          ? 'transform 300ms cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 200ms ease-out'
          : isComplete
            ? 'transform 400ms cubic-bezier(0.34, 1.56, 0.64, 1)'
            : 'none',
      }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {dots.map((dot) => (
          <circle
            key={dot.index}
            cx={dot.x}
            cy={dot.y}
            r={dotRadius}
            fill="rgba(59, 130, 246, 0.85)"
            opacity={getDotOpacity(dot.index)}
            style={{
              transformOrigin: `${dot.x}px ${dot.y}px`,
              transform: `scale(${getDotScale(dot.index)})`,
              transition: isComplete
                ? 'opacity 200ms ease-out, transform 250ms ease-out'
                : isRefreshing
                  ? 'opacity 200ms ease-out'
                  : 'opacity 80ms ease-out, transform 100ms ease-out',
              ...(isRefreshing && !isComplete && {
                animation: `pull-dot-fade ${1200 + dot.index * 40}ms ease-in-out infinite alternate`,
                animationDelay: `${dot.index * 70}ms`,
              }),
            }}
          />
        ))}

        {isComplete && (
          <g style={{
            transformOrigin: `${cx}px ${cy}px`,
            animation: 'pull-check-pop 350ms cubic-bezier(0.34, 1.56, 0.64, 1) forwards',
          }}>
            <circle cx={cx} cy={cy} r={12} fill="rgba(59, 130, 246, 0.12)" />
            <path
              d={`M${cx - 6} ${cy + 0.5} L${cx - 1.5} ${cy + 5} L${cx + 7} ${cy - 4}`}
              fill="none"
              stroke="rgba(59, 130, 246, 0.9)"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                strokeDasharray: 26,
                strokeDashoffset: 26,
                animation: 'pull-check-draw 280ms ease-out 80ms forwards',
              }}
            />
          </g>
        )}
      </svg>

      <style>{`
        @keyframes pull-dot-fade {
          0% { opacity: 0.25; transform: scale(0.8); }
          100% { opacity: 1; transform: scale(1.15); }
        }
        @keyframes pull-check-pop {
          0% { transform: scale(0.3); opacity: 0; }
          60% { transform: scale(1.08); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
        @keyframes pull-check-draw {
          to { stroke-dashoffset: 0; }
        }
      `}</style>
    </div>
  );
};
