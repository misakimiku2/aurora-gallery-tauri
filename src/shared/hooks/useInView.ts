
import { useState, useRef, useEffect } from 'react';

type InViewCallback = (isIntersecting: boolean) => void;

interface SharedObserver {
    observer: IntersectionObserver;
    callbacks: Map<Element, InViewCallback>;
}

// 共享 IntersectionObserver：按 (root, rootMargin, threshold) 复用同一个实例
// （与 src/hooks/useInView.ts 同源）。原实现每张卡片各自 new 一个 IO，而卡片是
// 窗口化渲染的——每次布局变化都要整体换一批卡片，等于一次性创建+销毁几十个 IO，
// 安卓 WebView 上这是窗口切换卡顿的主要来源之一。
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

    const shared = getSharedObserver(
        root,
        rootMargin === undefined ? '0px' : String(rootMargin),
        threshold === undefined ? '0' : String(threshold),
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
