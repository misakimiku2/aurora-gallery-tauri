import { useState, useEffect, useRef, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { debounce } from '../utils/debounce';
import { TaskProgress, FileNode } from '../types';

export const useTasks = (t: (key: string) => string) => {
    const [tasks, setTasks] = useState<TaskProgress[]>([]);

    // 存储所有定时器引用，用于组件卸载时清理
    const timerRefs = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

    // 使用 ref 暂存任务更新，确保防抖时的最终一致性
    const taskUpdatesRef = useRef<Map<string, Partial<TaskProgress>>>(new Map());

    // 创建防抖的状态更新函数
    const debouncedTaskUpdate = useRef(
        debounce(() => {
            setTasks(prev => {
                // 如果没有更新，直接返回
                if (taskUpdatesRef.current.size === 0) {
                    return prev;
                }

                // 应用所有暂存的任务更新
                const updatedTasks = prev.map(task => {
                    const updates = taskUpdatesRef.current.get(task.id);
                    if (updates) {
                        return { ...task, ...updates };
                    }
                    return task;
                });

                // 清空暂存的更新
                taskUpdatesRef.current.clear();

                return updatedTasks;
            });
        }, 100) // 100ms 防抖延迟
    ).current;

    // 优化的 updateTask 函数，使用防抖处理
    const updateTask = useCallback((id: string, updates: Partial<TaskProgress>) => {
        // 将更新暂存到 ref 中
        const existingUpdates = taskUpdatesRef.current.get(id) || {};
        taskUpdatesRef.current.set(id, { ...existingUpdates, ...updates });

        // 调用防抖函数
        debouncedTaskUpdate();
    }, [debouncedTaskUpdate]);

    const startTask = useCallback((type: 'copy' | 'move' | 'ai' | 'thumbnail' | 'color', fileIds: string[] | FileNode[], title: string, autoProgress: boolean = true) => {
        const id = Math.random().toString(36).substr(2, 9);
        const now = Date.now();
        const newTask: TaskProgress = {
            id,
            type: type as any,
            title,
            total: fileIds.length,
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
        setTasks(prev => [...prev, newTask]);

        if (autoProgress) {
            let current = 0;
            // 降低定时器频率，从 500ms 改为 1000ms
            const interval = setInterval(() => {
                current += 1;
                // 使用优化后的 updateTask 函数，利用防抖机制
                updateTask(id, { current });
                if (current >= newTask.total) {
                    clearInterval(interval);
                    // 移除定时器引用
                    timerRefs.current.delete(id);
                    // 使用 setTimeout 延迟移除任务，让用户看到完成状态
                    setTimeout(() => {
                        setTasks(prev => prev.filter(t => t.id !== id));
                    }, 1000);
                }
            }, 1000);

            // 存储定时器引用，便于后续清理
            timerRefs.current.set(id, interval);
        }
        return id;
    }, [updateTask]);

    // 组件卸载时清理逻辑
    useEffect(() => {
        return () => {
            // 清理所有定时器
            timerRefs.current.forEach((timer) => {
                clearInterval(timer);
            });
            timerRefs.current.clear();

            // 取消防抖任务更新
            debouncedTaskUpdate.cancel();

            // 应用所有暂存的任务更新，确保最终一致性
            if (taskUpdatesRef.current.size > 0) {
                setTasks(prev => {
                    const updatedTasks = prev.map(t => {
                        const updates = taskUpdatesRef.current.get(t.id);
                        if (updates) {
                            return { ...t, ...updates };
                        }
                        return t;
                    });
                    taskUpdatesRef.current.clear();
                    return updatedTasks;
                });
            }
        };
    }, [debouncedTaskUpdate]);

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
                            setTasks(prev => prev.filter(t => t.id !== oldTaskId));
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

                        // 获取当前任务状态
                        let lastProgress = 0;
                        let lastProgressUpdate = now;
                        let taskStatus = 'running';
                        let totalProcessedTime = 0;
                        let existingEstimatedTime: number | undefined = undefined;
                        let lastEstimatedTimeUpdate = now;

                        setTasks(prev => {
                            const task = prev.find(t => t.id === colorTaskIdRef.current);
                            if (task) {
                                lastProgress = task.lastProgress || 0;
                                lastProgressUpdate = task.lastProgressUpdate || now;
                                existingEstimatedTime = task.estimatedTime;
                                lastEstimatedTimeUpdate = task.lastEstimatedTimeUpdate || now;
                                taskStatus = task.status;
                                totalProcessedTime = task.totalProcessedTime || 0;
                            }
                            return prev;
                        });

                        // 计算预估时间
                        let calculatedEstimatedTime: number | undefined = existingEstimatedTime;
                        let shouldUpdateEstimatedTime = false;

                        if (taskStatus === 'running' && progress.current > lastProgress && now > lastProgressUpdate) {
                            const elapsedTime = now - lastProgressUpdate;
                            const currentSpeed = (totalProcessedTime + elapsedTime) > 0
                                ? progress.current / (totalProcessedTime + elapsedTime)
                                : 0;

                            const remainingTasks = Math.max(0, progress.total - progress.current);

                            if (currentSpeed > 0 && remainingTasks > 0) {
                                const newEstimatedTime = remainingTasks / currentSpeed;
                                const timeSinceLastEstimatedUpdate = now - lastEstimatedTimeUpdate;

                                if (timeSinceLastEstimatedUpdate >= 3000 || !existingEstimatedTime) {
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
                        if (taskStatus === 'running' && progress.current > lastProgress && now > lastProgressUpdate) {
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

                        updateTask(colorTaskIdRef.current, taskUpdates);

                        // 检测批次完成
                        if (progress.batchCompleted) {
                            updateTask(colorTaskIdRef.current, { status: 'completed' });

                            // 延迟1秒后关闭任务窗口
                            const currentTaskId = colorTaskIdRef.current;
                            setTimeout(() => {
                                if (isMounted && currentTaskId) {
                                    setTasks(prev => prev.filter(t => t.id !== currentTaskId));
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

    return { tasks, setTasks, startTask, updateTask };
};
