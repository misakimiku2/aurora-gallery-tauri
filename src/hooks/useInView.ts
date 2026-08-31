
import { useState, useRef, useEffect } from 'react';

type InViewCallback = (isIntersecting: boolean) => void;

interface SharedObserver {
    observer: IntersectionObserver;
    callbacks: Map<Element, InViewCallback>;
}

// 共享 IntersectionObserver：按 (root, rootMargin, threshold) 复用同一个实例。
// 原实现每张卡片各自 new IntersectionObserver —— 卡片是绝对定位 + 窗口化渲染，
// 每次布局变化（捏合改档 / 面板开合）都要卸载并重挂一整个窗口的卡片，等于一次
// 性创建+销毁几十个 IO。安卓 WebView 上 IO 的构造与 observe 登记并不便宜，
// 实测 1751 项文件夹里 PHASE 0→PHASE 1（即窗口切换的那次 React 提交）要
// 59~118ms，卡片动画因此被推迟到面板动画尾段（WAAPI 只剩 120ms）。
const sharedObservers = new Map<string, SharedObserver>();
let rootUid = 0;
const rootKeys = new WeakMap<object, string>();

const getObserverKey = (root: unknown, rootMargin: string, threshold: string) => {
    if (!root || typeof root !== 'object') return `null|${rootMargin}|${threshold}`;
    let key = rootKeys.get(root as object);
    if (!key) {
        key = `r${++rootUid}`;
        rootKeys.set(root as object, key);
    }
    return `${key}|${rootMargin}|${threshold}`;
};

const getSharedObserver = (
    root: Element | Document | null | undefined,
    rootMargin: string,
    threshold: string,
    options: IntersectionObserverInit
): SharedObserver => {
    const key = getObserverKey(root, rootMargin, threshold);
    let shared = sharedObservers.get(key);
    if (!shared) {
        const callbacks = new Map<Element, InViewCallback>();
        const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                const cb = callbacks.get(entry.target);
                if (cb) cb(entry.isIntersecting);
            }
        }, options);
        shared = { observer, callbacks };
        sharedObservers.set(key, shared);
    }
    return shared;
};

export const useInView = (options: IntersectionObserverInit = {}): [React.RefObject<HTMLDivElement>, boolean, boolean] => {
  const [isInView, setIsInView] = useState(false);
  const [wasInView, setWasInView] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 依赖取原始值而非 options 对象本身：options 每次渲染都是新对象，
  // 用它做依赖会导致 observer 反复解绑/重绑。
  const root = options.root;
  const rootMargin = options.rootMargin;
  const threshold = options.threshold;

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      setIsInView(true);
      setWasInView(true);
      return;
    }

    const currentRef = ref.current;
    if (!currentRef) return;

    const marginKey = rootMargin === undefined ? '0px' : String(rootMargin);
    const thresholdKey = threshold === undefined ? '0' : String(threshold);
    const shared = getSharedObserver(
        root,
        marginKey,
        thresholdKey,
        { root, rootMargin, threshold }
    );

    shared.callbacks.set(currentRef, (intersecting) => {
      setIsInView(intersecting);
      if (intersecting) {
        setWasInView(true);
      }
    });
    shared.observer.observe(currentRef);

    return () => {
      shared.callbacks.delete(currentRef);
      shared.observer.unobserve(currentRef);
    };
  }, [root, rootMargin, threshold]);

  return [ref, isInView, wasInView];
};
