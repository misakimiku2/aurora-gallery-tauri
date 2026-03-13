import React from 'react';

interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeMap = {
  sm: 'w-4 h-4 border-2',
  md: 'w-8 h-8 border-2',
  lg: 'w-12 h-12 border-3',
};

export const LoadingSpinner: React.FC<LoadingSpinnerProps> = ({ 
  size = 'md', 
  className = '' 
}) => {
  return (
    <div
      className={`
        ${sizeMap[size]}
        border-gray-300 dark:border-gray-600
        border-t-blue-500
        rounded-full
        animate-spin
        ${className}
      `}
    />
  );
};

export default LoadingSpinner;
