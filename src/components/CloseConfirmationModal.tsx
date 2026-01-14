import React, { useState } from 'react';
import { X } from 'lucide-react';

interface CloseConfirmationModalProps {
  onClose: () => void;
  onAction: (action: 'minimize' | 'exit', alwaysAsk: boolean) => void;
  t: (key: string) => string;
}

export const CloseConfirmationModal: React.FC<CloseConfirmationModalProps> = ({ onClose, onAction, t }) => {
  const [alwaysAsk, setAlwaysAsk] = useState(false);

  const handleAction = (action: 'minimize' | 'exit') => {
    onAction(action, alwaysAsk);
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-8 backdrop-blur-sm">
      <div 
        className="bg-white dark:bg-gray-800 rounded-xl w-[400px] shadow-2xl border border-gray-200 dark:border-gray-700 animate-zoom-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-6">
          <h2 className="text-xl font-bold text-gray-800 dark:text-white mb-4">{t('window.closeConfirmation.title')}</h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">{t('window.closeConfirmation.message')}</p>
          
          <div className="space-y-3">
            <button
              onClick={() => handleAction('minimize')}
              className="w-full flex items-center justify-center px-4 py-3 rounded-lg text-sm font-medium transition-colors bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 hover:bg-blue-200 dark:hover:bg-blue-900/50"
            >
              {t('window.closeConfirmation.minimizeToTray')}
            </button>
            
            <button
              onClick={() => handleAction('exit')}
              className="w-full flex items-center justify-center px-4 py-3 rounded-lg text-sm font-medium transition-colors bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/50"
            >
              {t('window.closeConfirmation.exit')}
            </button>
            
            <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-200 dark:border-gray-800">
              <label className="flex items-center text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={alwaysAsk}
                  onChange={(e) => {
                    e.stopPropagation();
                    setAlwaysAsk(e.target.checked);
                  }}
                  className="mr-2 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded cursor-pointer"
                />
                {t('window.closeConfirmation.alwaysAsk')}
              </label>
              
              <button
                onClick={onClose}
                className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
              >
                <X size={16} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
