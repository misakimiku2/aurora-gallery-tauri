import React from 'react';

interface EmptyPlaceholderProps {
  icon?: React.ReactNode;
  title?: string;
  description?: string;
  className?: string;
}

export const EmptyPlaceholder: React.FC<EmptyPlaceholderProps> = ({
  icon,
  title = '暂无内容',
  description,
  className = '',
}) => {
  return (
    <div className={`flex flex-col items-center justify-center py-20 text-gray-400 dark:text-gray-500 ${className}`}>
      {icon || (
        <svg className="w-16 h-16 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
      )}
      <p className="text-lg">{title}</p>
      {description && (
        <p className="text-sm mt-2 text-gray-500 dark:text-gray-600">{description}</p>
      )}
    </div>
  );
};

export default EmptyPlaceholder;
