
import React, { useEffect, useRef } from 'react';

export const InlineRenameInput = ({ defaultValue, onCommit, onCancel }: { defaultValue: string, onCommit: (val: string) => void, onCancel: () => void }) => {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      const lastDot = defaultValue.lastIndexOf('.');
      if (lastDot > 0) {
        inputRef.current.setSelectionRange(0, lastDot);
      } else {
        inputRef.current.select();
      }
    }
  }, [defaultValue]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.stopPropagation();
      onCommit(inputRef.current?.value || defaultValue);
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCancel();
    }
  };

  return (
    <input
      ref={inputRef}
      type="text"
      defaultValue={defaultValue}
      onBlur={(e) => onCommit(e.target.value)}
      onKeyDown={handleKeyDown}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDragStart={(e) => e.stopPropagation()}
      className="w-full text-center text-xs font-bold bg-white dark:bg-gray-700 border border-blue-500 rounded px-1 py-0.5 focus:outline-none shadow-sm cursor-text"
    />
  );
};
