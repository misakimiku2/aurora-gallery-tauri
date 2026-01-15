import React, { useState } from 'react';
import { Minus, Pause, Loader2 } from 'lucide-react';
import { TaskProgress } from '../types';

interface TaskProgressModalProps {
    tasks: TaskProgress[];
    onMinimize: (taskId: string) => void;
    onClose: (id?: string) => void;
    t: (key: string) => string;
    onPauseResume: (taskId: string, type: 'color') => void;
}

export const TaskProgressModal: React.FC<TaskProgressModalProps> = ({ tasks, onMinimize, onClose, t, onPauseResume }) => {
    const [isMinimizing, setIsMinimizing] = useState(false);
    const activeTasks = tasks.filter((task) => !task.minimized && task.status !== 'completed');

    if (activeTasks.length === 0) return null;

    const handleMinimize = () => {
        setIsMinimizing(true);
        setTimeout(() => {
            activeTasks.forEach((task) => onMinimize(task.id));
            setIsMinimizing(false);
        }, 300);
    };

    const handlePauseResumeClick = (taskId: string, taskType: any) => {
        if (taskType !== 'color') return;
        onPauseResume(taskId, taskType);
    };

    // 格式化预估时间（毫秒）为 HH:MM:SS
    const formatEstimatedTime = (ms: number | undefined): string => {
        if (!ms || ms < 0) return '';

        const totalSeconds = Math.floor(ms / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        if (hours > 0) {
            return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        } else {
            return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
    };

    return (
        <div className={`fixed bottom-6 left-1/2 transform -translate-x-1/2 z-[100] transition-all duration-300 ease-in-out origin-bottom ${isMinimizing ? 'scale-75 opacity-0 translate-y-full' : 'scale-100 opacity-100'}`}>
            <div className="w-96 bg-white dark:bg-gray-800 rounded-lg shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden animate-slide-up">
                <div className="bg-gray-100 dark:bg-gray-900 px-4 py-2 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center"><span className="font-bold text-sm text-gray-700 dark:text-gray-200">{t('sidebar.tasks')} ({activeTasks.length})</span><div className="flex space-x-1"><button onClick={handleMinimize} className="p-1 hover:bg-gray-200 dark:hover:bg-gray-800 rounded text-gray-500"><Minus size={14} /></button></div></div>
                <div className="max-h-64 overflow-y-auto p-4 space-y-4">{activeTasks.map((task) => (
                    <div key={task.id} className="space-y-1">
                        <div className="flex justify-between items-center">
                            <span className="truncate pr-2 text-xs text-gray-600 dark:text-gray-400 flex-1">{task.title}</span>
                            <div className="flex items-center space-x-2">
                                <span className="text-xs text-gray-600 dark:text-gray-400">{Math.round((task.current / Math.max(task.total, 1)) * 100)}%</span>
                                {task.type === 'color' && (
                                    <button
                                        onClick={() => handlePauseResumeClick(task.id, task.type)}
                                        className="p-1 hover:bg-gray-200 dark:hover:bg-gray-800 rounded text-gray-500"
                                        title={task.status === 'paused' ? t('tasks.resume') : t('tasks.pause')}
                                    >
                                        {task.status === 'paused' ? <Loader2 size={12} className="animate-spin" /> : <Pause size={12} />}
                                    </button>
                                )}
                            </div>
                        </div>
                        {task.currentStep && <div className="text-xs text-gray-500 dark:text-gray-500 truncate">{task.currentStep}</div>}
                        {task.currentFile && <div className="text-xs text-gray-500 dark:text-gray-500 truncate">{task.currentFile}</div>}
                        {task.estimatedTime && task.estimatedTime > 0 && (
                            <div className="text-xs text-gray-500 dark:text-gray-500 truncate">
                                剩余时间: {formatEstimatedTime(task.estimatedTime)}
                            </div>
                        )}
                        <div className="w-full bg-gray-200 dark:bg-gray-700 h-1.5 rounded-full overflow-hidden">
                            <div
                                className={`h-full transition-all duration-300 ${task.status === 'paused' ? 'bg-yellow-500' : 'bg-blue-500'}`}
                                style={{ width: `${(task.current / Math.max(task.total, 1)) * 100}%` }}
                            ></div>
                        </div>
                    </div>
                ))}</div>
            </div>
        </div>
    );
};
