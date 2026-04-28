import React, { useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';

interface CircularProgressOverlayProps {
  x: number;
  y: number;
  duration?: number;
  size?: number;
}

export const CircularProgressOverlay: React.FC<CircularProgressOverlayProps> = ({
  x,
  y,
  duration = 350,
  size = 80,
}) => {
  const circleRef = useRef<SVGCircleElement>(null);
  const radius = (size - 8) / 2;
  const circumference = 2 * Math.PI * radius;

  useEffect(() => {
    const circle = circleRef.current;
    if (!circle) return;

    const startTime = performance.now();
    let rafId: number;

    const animate = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      circle.style.strokeDashoffset = String(circumference * (1 - progress));

      if (progress < 1) {
        rafId = requestAnimationFrame(animate);
      }
    };

    rafId = requestAnimationFrame(animate);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [duration, circumference]);

  return createPortal(
    <div
      style={{
        position: 'fixed',
        left: x - size / 2,
        top: y - size / 2,
        width: size,
        height: size,
        pointerEvents: 'none',
        zIndex: 99999,
      }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          ref={circleRef}
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="rgba(59, 130, 246, 0.15)"
          stroke="rgba(59, 130, 246, 0.8)"
          strokeWidth={4}
          strokeLinecap="round"
          style={{
            transform: 'rotate(-90deg)',
            transformOrigin: '50% 50%',
            strokeDasharray: `${circumference}`,
            strokeDashoffset: circumference,
          }}
        />
      </svg>
    </div>,
    document.body
  );
};
