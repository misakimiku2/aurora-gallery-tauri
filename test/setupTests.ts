import '@testing-library/jest-dom';

// Node 24+ 抢先定义了一个没有任何方法的 globalThis.localStorage / sessionStorage 桩，
// vitest 装 jsdom 环境时不会覆盖已存在的全局，于是 jsdom 真正的 Storage 被盖掉，
// 测试里 localStorage.clear() / getItem() 全报「is not a function」。补一份内存实现。
class MemoryStorage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  key(index: number) { return [...this.map.keys()][index] ?? null; }
  getItem(key: string) { return this.map.has(String(key)) ? this.map.get(String(key))! : null; }
  setItem(key: string, value: string) { this.map.set(String(key), String(value)); }
  removeItem(key: string) { this.map.delete(String(key)); }
  clear() { this.map.clear(); }
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  const target = globalThis as Record<string, any>;
  if (typeof target[name]?.clear !== 'function') {
    Object.defineProperty(target, name, { value: new MemoryStorage(), configurable: true, writable: true });
  }
}
