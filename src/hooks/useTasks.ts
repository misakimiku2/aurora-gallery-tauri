import { useState, useEffect, useRef, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { TaskProgress, FileNode, AppState } from '../types';

export const useTasks = (state: AppState, setState: React.Dispatch<React.SetStateAction<AppState>>, t: (key: string) => string) => {
    const tasksRef = useRef(state.tasks);
    useEffect(() => { tasksRef.current = state.tasks; }, [state.tasks]);

    // 存储所有定时器引用，用于组件卸载时清理
    const timerRefs = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

    // 使用 ref 暂存任务更新，确保在定时刷新时的最终一致性
    const taskUpdatesRef = useRef<Map<string, Partial<TaskProgress>>>(new Map());
    
    // 使用定时器替代防抖，解决高频更新导致的“无限延迟”问题
    useEffect(() => {
        const flushUpdates = () => {
            if (taskUpdatesRef.current.size === 0) return;

            // 1. 识别哪些更新可以被应用（任务存在于当前状态引用中）
            // 我们必须在 setState 之外处理 Ref 清理，因为 setState 更新函数必须是纯函数（不能有副作用）
            // 否则在 React Strict Mode 下会导致 Ref 被错误清空，导致 UI 状态更新丢失（如暂停按钮需要点击两次的问题）
            const currentTaskIds = new Set(tasksRef.current.map(t => t.id));
            const updatesToApply = new Map<string, Partial<TaskProgress>>();
            const remainingUpdates = new Map<string, Partial<TaskProgress>>();

            for (const [id, update] of taskUpdatesRef.current.entries()) {
                if (currentTaskIds.has(id)) {
                    updatesToApply.set(id, update);
                } else {
                    remainingUpdates.set(id, update);
                }
            }

            if (updatesToApply.size === 0) return;

            // 2. 更新 ref 只保留未处理的更新
            taskUpdatesRef.current = remainingUpdates;

            setState(prev => {
                const updatedTasks = prev.tasks.map(t => {
                    const updates = updatesToApply.get(t.id);
                    if (updates) {
                        return { ...t, ...updates };
                    }
                    return t;
                });

                return { ...prev, tasks: updatedTasks };
            });
        };

        const intervalId = setInterval(flushUpdates, 100); // 每 100ms 刷新一次 UI
        
        return () => clearInterval(intervalId);
    }, [setState]);

    /**
     * 更新任务状态（写入缓冲）
     */
    const updateTask = useCallback((id: string, updates: Partial<TaskProgress>) => {
        // 将更新暂存到 ref 中
        const currentUpdates = taskUpdatesRef.current.get(id) || {};
        taskUpdatesRef.current.set(id, { ...currentUpdates, ...updates, lastProgressUpdate: Date.now() });
    }, []);

    const startTask = useCallback((type: string, fileIds: string[] | FileNode[], title: string, autoProgress: boolean = true) => {
        const id = Math.random().toString(36).substr(2, 9);
        const now = Date.now();
        const newTask: TaskProgress = {
            id,
            type: type as any,
            title,
            total: Array.isArray(fileIds) ? fileIds.length : (fileIds ? 1 : 0),
            current: 0,
            startTime: now,
            status: 'running',
            minimized: false,
            lastProgressUpdate: now,
            lastProgress: 0,
            estimatedTime: undefined,
            lastEstimatedTimeUpdate: now
        };

        // 立即添加任务，不使用防抖，确保用户立即看到任务开始
        setState(prev => ({ ...prev, tasks: [...prev.tasks, newTask] }));

        if (autoProgress && newTask.total > 0) {
            let current = 0;
            const total = newTask.total;
            // 降低定时器频率，从 500ms 改为 1000ms
            const interval = setInterval(() => {
                current += 1;
                // 使用优化后的 updateTask 函数，利用防抖机制
                updateTask(id, { current });
                if (current >= total) {
                    clearInterval(interval);
                    // 移除定时器引用
                    timerRefs.current.delete(id);
                    // 使用 setTimeout 延迟移除任务，让用户看到完成状态
                    setTimeout(() => {
                        setState(prev => ({ ...prev, tasks: prev.tasks.filter(task => task.id !== id) }));
                    }, 1000);
                }
            }, 1000);

            // 存储定时器引用，便于后续清理
            timerRefs.current.set(id, interval);
        }
        return id;
    }, [updateTask, setState]);

    // 组件卸载时清理逻辑
    useEffect(() => {
        return () => {
            // 清理所有定时器
            timerRefs.current.forEach((timer) => {
                clearInterval(timer);
            });
            timerRefs.current.clear();

            // 应用所有暂存的任务更新，确保最终一致性
            if (taskUpdatesRef.current.size > 0) {
                setState(prev => {
                    const updatedTasks = prev.tasks.map(t => {
                        const updates = taskUpdatesRef.current.get(t.id);
                        if (updates) {
                            return { ...t, ...updates };
                        }
                        return t;
                    });
                    taskUpdatesRef.current.clear();
                    return { ...prev, tasks: updatedTasks };
                });
            }
        };
    }, [setState]);

    // 监听主色调提取进度事件
    const colorTaskIdRef = useRef<string | null>(null);
    const colorBatchIdRef = useRef<number>(-1); // 初始化为 -1，以免与批次ID 0 冲突

    useEffect(() => {
        let isMounted = true;

        // Helper function for logging
        const eprintln = (msg: string) => {
            console.log(`[ColorExtraction] ${msg}`);
        };

        const listenProgress = async () => {
            try {
                const unlisten = await listen('color-extraction-progress', (event: any) => {
                    if (!isMounted) return;

                    const progress = event.payload as {
                        batchId: number;
                        current: number;
                        total: number;
                        pending: number;
                        currentFile: string;
                        batchCompleted: boolean;
                    };

                    // 忽略 total 为 0 的无效进度
                    if (progress.total === 0) {
                        return;
                    }

                    // 检查是否是新批次
                    const isNewBatch = progress.batchId !== colorBatchIdRef.current;

                    if (isNewBatch) {
                        // 防止旧批次干扰：如果收到的批次ID比当前的小且不为-1，忽略
                        if (colorBatchIdRef.current !== -1 && progress.batchId < colorBatchIdRef.current) {
                            return;
                        }

                        // 新批次：关闭旧任务，创建新任务
                        const oldTaskId = colorTaskIdRef.current;
                        if (oldTaskId) {
                            setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== oldTaskId) }));
                        }

                        // 创建新任务
                        const taskId = startTask('color', [], t('tasks.processingColors'), false);
                        colorTaskIdRef.current = taskId;
                        colorBatchIdRef.current = progress.batchId;

                        eprintln(`=== New color extraction batch ${progress.batchId} started, total: ${progress.total} ===`);
                    }

                    // 更新任务进度
                    if (colorTaskIdRef.current) {
                        const now = Date.now();
                        const taskId = colorTaskIdRef.current;

                        // 获取当前任务状态
                        let lastProgress = 0;
                        let lastProgressUpdate = now;
                        let taskStatus = 'running';
                        let totalProcessedTime = 0;
                        let existingEstimatedTime: number | undefined = undefined;
                        let lastEstimatedTimeUpdate = now;

                        const currentTasks = tasksRef.current;
                        const task = currentTasks.find(t => t.id === taskId);
                        
                        if (task) {
                            lastProgress = task.lastProgress || 0;
                            lastProgressUpdate = task.lastProgressUpdate || now;
                            existingEstimatedTime = task.estimatedTime;
                            lastEstimatedTimeUpdate = task.lastEstimatedTimeUpdate || now;
                            taskStatus = task.status;
                            totalProcessedTime = task.totalProcessedTime || 0;
                        }

                        // 如果任务处于暂停状态，不更新进度（或者只更新UI不更新内部计数器），防止UI跳变
                        // 但如果是 paused 状态，通常后端也应该暂停。如果后端还在发消息，说明还在跑
                        // 此时我们应该信任后端的消息更新 current，但不累计时间

                        // 计算预估时间
                        let calculatedEstimatedTime: number | undefined = existingEstimatedTime;
                        let shouldUpdateEstimatedTime = false;

                        // 只有找到任务且正在运行才计算时间
                        if (task && taskStatus === 'running' && progress.current > lastProgress && now > lastProgressUpdate) {
                            const elapsedTime = now - lastProgressUpdate;
                            // 简单的滑动窗口或累积平均速度
                            const currentSpeed = (totalProcessedTime + elapsedTime) > 0
                                ? progress.current / (totalProcessedTime + elapsedTime)
                                : 0;

                            const remainingTasks = Math.max(0, progress.total - progress.current);

                            if (currentSpeed > 0 && remainingTasks > 0) {
                                const newEstimatedTime = remainingTasks / currentSpeed;
                                const timeSinceLastEstimatedUpdate = now - lastEstimatedTimeUpdate;

                                if (timeSinceLastEstimatedUpdate >= 1000 || !existingEstimatedTime) { // 提高刷新频率到 1秒
                                    calculatedEstimatedTime = newEstimatedTime;
                                    lastEstimatedTimeUpdate = now;
                                    shouldUpdateEstimatedTime = true;
                                }
                            } else if (remainingTasks <= 0) {
                                calculatedEstimatedTime = 0;
                                shouldUpdateEstimatedTime = true;
                            }
                        }

                        // 只有处理了至少10个文件后才显示预估时间
                        let estimatedTime = progress.current >= 10 ? calculatedEstimatedTime : undefined;
                        if (taskStatus === 'paused') {
                            estimatedTime = undefined;
                        }

                        // 计算新的处理时间
                        let newTotalProcessedTime = totalProcessedTime;
                        if (task && taskStatus === 'running' && progress.current > lastProgress && now > lastProgressUpdate) {
                            newTotalProcessedTime += now - lastProgressUpdate;
                        }

                        const taskUpdates: any = {
                            current: progress.current,
                            total: progress.total,
                            currentFile: progress.currentFile,
                            currentStep: `${progress.current} / ${progress.total}`,
                            estimatedTime,
                            lastProgressUpdate: now,
                            lastProgress: progress.current,
                            totalProcessedTime: newTotalProcessedTime
                        };

                        if (shouldUpdateEstimatedTime) {
                            taskUpdates.lastEstimatedTimeUpdate = lastEstimatedTimeUpdate;
                        }

                        // 无条件触发更新，即使 tasksRef 中没找到任务（可能React状态还没同步）
                        // 这将确保任务至少能显示进度
                        updateTask(taskId, taskUpdates);

                        // 检测批次完成
                        if (progress.batchCompleted) {
                            updateTask(taskId, { status: 'completed' });

                            // 延迟1秒后关闭任务窗口
                            const currentTaskId = colorTaskIdRef.current;
                            setTimeout(() => {
                                if (isMounted && currentTaskId) {
                                    setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== currentTaskId) }));
                                    // 只有当当前任务ID未变化时才清除引用
                                    if (colorTaskIdRef.current === currentTaskId) {
                                        colorTaskIdRef.current = null;
                                    }
                                }
                            }, 1000);
                        }
                    }
                });

                return unlisten;
            } catch (error) {
                console.error('Failed to listen for color extraction progress:', error);
                return () => { };
            }
        };

        const unlistenPromise = listenProgress();

        return () => {
            isMounted = false;
            unlistenPromise.then(unlistenFn => unlistenFn()).catch(console.error);
        };
    }, [startTask, updateTask, t]); // Add startTask, updateTask, and t to dependencies

    return { startTask, updateTask };
};
