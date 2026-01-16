export async function asyncPool<T>(limit: number, items: T[], fn: (item: T, index: number) => Promise<any>) {
  const promises: Promise<any>[] = [];
  const pool = new Set();
  const results: any[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const p = Promise.resolve().then(() => fn(item, i));
    promises.push(p);
    results.push(p);
    if (limit <= items.length) {
      const e: any = p.then(() => pool.delete(e));
      pool.add(e);
      if (pool.size >= limit) {
        await Promise.race(pool);
      }
    }
  }
  return Promise.all(results);
}
