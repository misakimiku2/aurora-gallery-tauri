/** 历史记录面板:引擎 history.entries(旧→新),当前态高亮,点击 history.selectState 回跳。 */
import React, { useEffect, useState } from 'react';
import { runCommand, getSession, subscribeSession } from '../editorStore';

export const HistoryPanel: React.FC<{ tabId: string }> = ({ tabId }) => {
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeSession(tabId, () => forceUpdate((n) => n + 1)), [tabId]);
  const s = getSession(tabId);
  if (!s || !s.state) return <div className="px-2 py-1.5 text-[11px] text-gray-500 dark:text-neutral-400">历史记录</div>;

  const st = s.state;
  const rows = st.history.map((label, i) => ({ label, i }));

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="px-2 py-1 text-[11px] text-gray-500 dark:text-neutral-400 shrink-0">历史记录</div>
      <div className="flex-1 min-h-0 overflow-y-auto px-1 pb-1">
        {rows.map(({ label, i }) => (
          <button
            key={i}
            onClick={() => void runCommand(tabId, 'history.selectState', { state: i }).catch(console.error)}
            className={`w-full text-left px-2 py-1 rounded text-xs truncate ${
              i === st.historyCurrent
                ? 'bg-sky-600/25 text-neutral-900 dark:text-neutral-100'
                : i > st.historyCurrent
                  ? 'text-gray-500 dark:text-gray-500 dark:text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10'
                  : 'text-gray-700 dark:text-gray-700 dark:text-neutral-300 hover:bg-black/5 dark:hover:bg-white/10'
            }`}
            title={label}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
};
