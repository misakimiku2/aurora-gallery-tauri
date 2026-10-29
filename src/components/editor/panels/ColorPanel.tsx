/** 颜色面板:前/背景色芯片 + 取色器(ColorPicker 共用组件)。提交走 tools.setColors。 */
import React, { useEffect, useState } from 'react';
import { runCommand, getSession, subscribeSession } from '../editorStore';
import { ColorPicker, toHex, type RGB } from './ColorPicker';

export const ColorPanel: React.FC<{ tabId: string }> = ({ tabId }) => {
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeSession(tabId, () => forceUpdate((n) => n + 1)), [tabId]);
  const s = getSession(tabId);
  const [target, setTarget] = useState<'foreground' | 'background'>('foreground');

  if (!s || !s.state) return <div className="px-2 py-1.5 text-[11px] text-gray-500 dark:text-neutral-400">颜色</div>;
  const color = s.state[target].slice(0, 3) as RGB;

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-2 py-1 text-[11px] text-gray-500 dark:text-neutral-400">颜色</div>
      <div className="flex gap-2 px-2 pb-1">
        <div className="relative w-11 h-11 shrink-0">
          <button
            title="背景色"
            onClick={() => setTarget('background')}
            className={`absolute right-0 bottom-0 w-7 h-7 rounded-sm border ${target === 'background' ? 'border-sky-400 ring-1 ring-sky-400' : 'border-black/30 dark:border-neutral-500'}`}
            style={{ background: toHex(...(s.state.background.slice(0, 3) as RGB)) }}
          />
          <button
            title="前景色"
            onClick={() => setTarget('foreground')}
            className={`absolute left-0 top-0 w-7 h-7 rounded-sm border z-10 ${target === 'foreground' ? 'border-sky-400 ring-1 ring-sky-400' : 'border-black/40 dark:border-neutral-300'}`}
            style={{ background: toHex(...(s.state.foreground.slice(0, 3) as RGB)) }}
          />
        </div>
        <div className="flex-1 min-w-0">
          <ColorPicker
            value={color}
            onCommit={(rgb) => {
              void runCommand(tabId, 'tools.setColors', { [target]: toHex(...rgb) }).catch(console.error);
            }}
            label={target === 'foreground' ? '前景色' : '背景色'}
          />
        </div>
      </div>
    </div>
  );
};
