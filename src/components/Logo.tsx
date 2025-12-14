
import React from 'react';

export const AuroraLogo = ({ size = 32, className = "", style = {} }: { size?: number, className?: string, style?: React.CSSProperties }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 256 256"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    style={style}
  >
    <defs>
      <linearGradient id="aurora-gradient" x1="0%" y1="100%" x2="100%" y2="0%">
        <stop offset="0%" stopColor="#4F46E5" /> {/* Indigo */}
        <stop offset="50%" stopColor="#8B5CF6" /> {/* Violet */}
        <stop offset="100%" stopColor="#EC4899" /> {/* Pink */}
      </linearGradient>
      <linearGradient id="aurora-gradient-dark" x1="0%" y1="100%" x2="100%" y2="0%">
        <stop offset="0%" stopColor="#60A5FA" /> {/* Light Blue */}
        <stop offset="50%" stopColor="#A78BFA" /> {/* Light Purple */}
        <stop offset="100%" stopColor="#F472B6" /> {/* Light Pink */}
      </linearGradient>
    </defs>
    
    {/* Background Container */}
    <rect 
      x="32" 
      y="32" 
      width="192" 
      height="192" 
      rx="48" 
      fill="url(#aurora-gradient)" 
      className="dark:fill-[url(#aurora-gradient-dark)]"
    />
    
    {/* Abstract Aurora Waves */}
    <path 
      d="M32 138 C 70 100, 186 196, 224 158" 
      stroke="white" 
      strokeWidth="20" 
      strokeLinecap="round" 
      fill="none" 
      opacity="0.4"
    />
    
    <path 
      d="M32 110 C 80 70, 176 166, 224 126" 
      stroke="white" 
      strokeWidth="12" 
      strokeLinecap="round" 
      fill="none" 
      opacity="0.6"
    />

    {/* Focal Point / Aperture Dot */}
    <circle cx="176" cy="80" r="14" fill="white" fillOpacity="0.95" />
  </svg>
);
