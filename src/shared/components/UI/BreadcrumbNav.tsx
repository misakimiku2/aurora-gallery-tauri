import React, { useMemo } from 'react';

interface BreadcrumbItem {
  name: string;
  path: string;
}

interface BreadcrumbNavProps {
  currentPath: string;
  onNavigate: (path: string) => void;
  rootLabel?: string;
  className?: string;
}

export const BreadcrumbNav: React.FC<BreadcrumbNavProps> = ({
  currentPath,
  onNavigate,
  rootLabel = '根目录',
  className = '',
}) => {
  const pathParts = useMemo(() => {
    const parts = currentPath.split('/').filter(p => p);
    let accPath = '';
    return parts.map(part => {
      accPath += '/' + part;
      return { name: part, path: accPath };
    });
  }, [currentPath]);

  return (
    <nav className={`flex items-center gap-1 px-4 py-2 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 overflow-x-auto shrink-0 ${className}`}>
      <button
        onClick={() => onNavigate('/')}
        className={`px-2 py-1 text-sm rounded hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors shrink-0 ${
          pathParts.length === 0 ? 'text-blue-500 font-medium' : 'text-gray-600 dark:text-gray-400'
        }`}
      >
        {rootLabel}
      </button>
      {pathParts.map((part, index) => (
        <React.Fragment key={part.path}>
          <span className="text-gray-400 dark:text-gray-600">/</span>
          <button
            onClick={() => onNavigate(part.path)}
            className={`px-2 py-1 text-sm rounded hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors shrink-0 ${
              index === pathParts.length - 1 ? 'text-blue-500 font-medium' : 'text-gray-600 dark:text-gray-400'
            }`}
          >
            {part.name}
          </button>
        </React.Fragment>
      ))}
    </nav>
  );
};

export default BreadcrumbNav;
