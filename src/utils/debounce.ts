/**
 * 防抖函数：在一定时间内，多次调用同一个函数时，只执行最后一次调用
 * @param func 要执行的函数
 * @param wait 等待时间（毫秒）
 * @param immediate 是否立即执行
 * @returns 防抖处理后的函数
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number,
  immediate: boolean = false
): ((...args: Parameters<T>) => void) & { cancel: () => void } {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  // 创建防抖函数
  const debounced = (...args: Parameters<T>) => {
    // 如果已经有定时器，清除它
    if (timeout) {
      clearTimeout(timeout);
    }

    // 如果是立即执行模式，且没有正在等待执行的函数
    if (immediate && !timeout) {
      func(...args);
    }

    // 创建新的定时器
    timeout = setTimeout(() => {
      // 如果不是立即执行模式，或者立即执行模式下已经执行过了
      if (!immediate) {
        func(...args);
      }
      // 清除定时器
      timeout = null;
    }, wait);
  };

  // 添加取消方法
  debounced.cancel = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
  };

  return debounced;
}

/**
 * 节流函数：在一定时间内，多次调用同一个函数时，只执行一次
 * @param func 要执行的函数
 * @param limit 时间限制（毫秒）
 * @returns 节流处理后的函数
 */
export function throttle<T extends (...args: any[]) => any>(
  func: T,
  limit: number
): ((...args: Parameters<T>) => void) & { cancel: () => void } {
  let inThrottle: boolean = false;

  const throttled = (...args: Parameters<T>) => {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => {
        inThrottle = false;
      }, limit);
    }
  };

  throttled.cancel = () => {
    inThrottle = false;
  };

  return throttled;
}
