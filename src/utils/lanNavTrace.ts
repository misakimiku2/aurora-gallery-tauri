// LAN 文件夹导航管道追踪器。
// 记录从「点击文件夹」到「第一张缩略图加载完成」的完整管道时间线：
//   CLICK → FETCH START → FETCH END → setFiles() →
//   FIRST ITEM RENDER → FIRST THUMB REQUEST → FIRST THUMB LOADED → Loading hidden
//
// 每个步骤只记录一次（同一 nav session 内），跨组件通过模块级单例共享状态。

interface LanNavState {
  id: number;
  clickTs: number;
  folderName: string;
  steps: Record<string, number>;
}

let state: LanNavState | null = null;
let counter = 0;

export function lanNavStart(folderName: string): void {
  counter++;
  state = { id: counter, clickTs: performance.now(), folderName, steps: {} };
  console.log(`[LAN NAV #${counter}] ===== CLICK folder="${folderName}" =====`);
}

export function lanNavStep(step: string, extra?: string): void {
  if (!state) return;
  if (state.steps[step]) return;
  const now = performance.now();
  state.steps[step] = now;
  const elapsed = (now - state.clickTs).toFixed(0);
  const extraStr = extra ? ` ${extra}` : '';
  console.log(`[LAN NAV #${state.id}] ${step}${extraStr} +${elapsed}ms`);
}

export function lanNavId(): number {
  return state?.id || 0;
}

export function lanNavActive(): boolean {
  return state !== null;
}
