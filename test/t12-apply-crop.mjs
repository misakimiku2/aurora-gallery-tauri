// 裁剪「应用/取消」+ 面板无滚动条 冒烟(2026-11-14 用户口径):
//   ① 调整面板不显示滚动条(滚轮仍可滚)
//   ② 画框 → 点「应用裁剪」→ 退出裁剪态、保留裁剪,继续调影调(图像显示矩形=裁剪子矩形)
//   ③ 再进裁剪拖一下 → 点「取消裁剪」→ 回退到应用时的裁剪
// 通路沿用 cdp-smoke-webview2-pitfalls 记忆;eval 一律单行。
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(p => p.type === 'page' && /tauri\.localhost|localhost:14422/.test(p.url));
if (!page) throw new Error('CDP page 未找到');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let seq = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval err');
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mouse = async (type, x, y, extra = {}) => { await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseMoved' ? 1 : (type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0), clickCount: extra.clickCount ?? 1, ...extra }); };
const drag = async (x1, y1, x2, y2, steps = 8) => { await mouse('mousePressed', x1, y1); for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps); await sleep(16); } await mouse('mouseReleased', x2, y2); };
let fail = 0;
const check = (name, ok, detail) => { console.log(`[${name}]`, detail, ok ? '✓' : '✗ FAIL'); if (!ok) fail++; };
const cropBtn = () => evaluate(`(function(){ var b = Array.from(document.querySelectorAll('#aurora-adjust-slot button')).find(function(x){ return x.getAttribute('title') === '裁剪'; }); return b ? b.className.includes('bg-blue-500') : 'MISSING'; })()`);
const clickPanelBtn = async (text) => {
  const r = await evaluate(`(function(){ var b = Array.from(document.querySelectorAll('#aurora-adjust-slot button, [data-crop-toolbar] button')).find(function(x){ return x.textContent.trim() === '${text}'; }); if(!b) return 'MISSING'; b.click(); return 'ok'; })()`);
  if (r === 'MISSING') {
    const texts = await evaluate(`JSON.stringify(Array.from(document.querySelectorAll('#aurora-adjust-slot button, [data-crop-toolbar] button')).map(function(x){ return x.textContent.trim(); }).slice(0, 30))`);
    console.log(`[diag] '${text}' MISSING, 面板+裁剪栏按钮:`, texts);
  }
  return r;
};
// 进/出裁剪态带验证重试:点击可能落在 React 重渲染替换掉的旧节点上(静默 no-op)
const ensureCropMode = async (on) => {
  for (let i = 0; i < 4; i++) {
    const active = await evaluate(`!!document.querySelector('[data-crop-toolbar]')`);
    if (active === on) return true;
    await evaluate(`(function(){ var b = Array.from(document.querySelectorAll('#aurora-adjust-slot button')).find(function(x){ return x.getAttribute('title') === '裁剪'; }); if(b) b.click(); return 1; })()`);
    await sleep(600);
  }
  return (await evaluate(`!!document.querySelector('[data-crop-toolbar]')`)) === on;
};
const imgRect = async () => JSON.parse(await evaluate(`(function(){ var cv = document.querySelector('canvas[data-adjust-canvas]'); var r = cv.getBoundingClientRect(); var v = window.__adjustView; return JSON.stringify({ iw: Math.round((v.iw/v.bw)*r.width), ih: Math.round((v.ih/v.bh)*r.height), left: Math.round(r.left + (v.ix/v.bw)*r.width), top: Math.round(r.top + (v.iy/v.bh)*r.height) }); })()`));

// 0) 整页刷新(干净状态)
await send('Page.reload', { ignoreCache: true });
await sleep(5000);

// 1) 开查看器 + 调整态(裁剪按钮会自动建 80% 框并持久化,先重置掉)
let card = null;
for (let i = 0; i < 15 && !card; i++) {
  const ok = await evaluate(`(function(){ var el = document.querySelector('[title="crop-ui-test.jpg"]'); if(!el) return false; var r = el.getBoundingClientRect(); window.__card = {x: r.x + r.width/2, top: r.top}; return true; })()`);
  if (ok) card = JSON.parse(await evaluate('JSON.stringify(window.__card)'));
}
if (!card) throw new Error('网格里没找到 crop-ui-test.jpg');
await mouse('mousePressed', card.x, card.top - 60); await mouse('mouseReleased', card.x, card.top - 60);
await sleep(120);
await mouse('mousePressed', card.x, card.top - 60, { clickCount: 2 }); await mouse('mouseReleased', card.x, card.top - 60, { clickCount: 2 });
await sleep(1500);
// 查看器没开就重试一轮双击(网格刷新/焦点竞态兜底)
for (let i = 0; i < 5 && !(await evaluate(`!!document.querySelector('[title="调整"]')`)); i++) {
  await mouse('mousePressed', card.x, card.top - 60, { clickCount: 2 }); await mouse('mouseReleased', card.x, card.top - 60, { clickCount: 2 });
  await sleep(1500);
}
await evaluate(`document.querySelector('[title="调整"]').click()`);
await sleep(600);
await evaluate(`(function(){ var b = Array.from(document.querySelectorAll('#aurora-adjust-slot button')).find(function(x){ return x.textContent.trim() === '重置'; }); if(b) b.click(); return 1; })()`);
await sleep(600);
const preCrop = await imgRect();

// 2) 滚动条隐藏(内容不溢出时本就无条,隐藏口径看 ::-webkit-scrollbar display)
const sb = JSON.parse(await evaluate(`(function(){ var el = document.querySelector('.adjust-inner-scroll'); if(!el) return JSON.stringify({missing:1}); return JSON.stringify({ hidden: getComputedStyle(el, '::-webkit-scrollbar').display === 'none', sWidth: getComputedStyle(el).scrollbarWidth }); })()`));
check('T12-1', !sb.missing && sb.hidden && sb.sWidth === 'none', `滚动条隐藏(display=none, scrollbar-width=${sb.sWidth})`);

// 3) 进裁剪 → 清掉自动框 → 画宽扁框 → 应用裁剪
check('T12-2a', await ensureCropMode(true), '进入裁剪态(按钮组在场)');
const inCrop = await imgRect();
check('T12-1b', Math.abs(inCrop.iw - preCrop.iw) <= 2 && Math.abs(inCrop.ih - preCrop.ih) <= 2 && Math.abs(inCrop.left - preCrop.left) <= 2 && Math.abs(inCrop.top - preCrop.top) <= 2, `进裁剪态图片无大小变化: ${preCrop.iw}×${preCrop.ih}@(±${Math.max(Math.abs(inCrop.left - preCrop.left), Math.abs(inCrop.top - preCrop.top))}) → ${inCrop.iw}×${inCrop.ih}(悬浮裁剪栏不挤压舞台)`);
await clickPanelBtn('清除裁剪');
await sleep(300);
const img = JSON.parse(await evaluate(`(function(){ var cv = document.querySelector('canvas[data-adjust-canvas]'); var r = cv.getBoundingClientRect(); var v = window.__adjustView; return JSON.stringify({ x: r.left + (v.ix/v.bw)*r.width, y: r.top + (v.iy/v.bh)*r.height, w: (v.iw/v.bw)*r.width, h: (v.ih/v.bh)*r.height }); })()`));
// 宽扁框(norm 0.5×0.2):应用后 contain-fit 的高度远小于全帧,断言才可区分
const p1 = { x: img.x + img.w * 0.25, y: img.y + img.h * 0.35 };
const p2 = { x: img.x + img.w * 0.75, y: img.y + img.h * 0.55 };
await drag(p1.x, p1.y, p2.x, p2.y);
await sleep(300);
console.log('[raw] 拖后 rect:', await evaluate(`JSON.stringify(window.__adjustCropRect || null)`));
const before = await imgRect();
const applied = await clickPanelBtn('应用裁剪');
await sleep(500);
const afterApply = await imgRect();
const actionsGone = await evaluate(`!document.querySelector('[data-crop-toolbar]')`);
const cropActiveAfter = await cropBtn();
check('T12-2', applied === 'ok' && actionsGone && cropActiveAfter === false, `应用裁剪: 退出裁剪态(按钮组消失=${actionsGone}, 裁剪钮激活=${cropActiveAfter})`);
check('T12-3', afterApply.ih < before.ih * 0.6 && Math.abs(afterApply.iw - before.iw) < 30, `裁剪已生效继续调(所见即导出): 图像显示矩形 ${before.iw}×${before.ih} → ${afterApply.iw}×${afterApply.ih}(宽扁裁剪 contain-fit 高度收窄)`);
// 4) 再进裁剪 → 拖一下 → 取消裁剪 → 回退到应用时的裁剪
check('T12-4a', await ensureCropMode(true), '重新进入裁剪态');
const img2 = JSON.parse(await evaluate(`(function(){ var cv = document.querySelector('canvas[data-adjust-canvas]'); var r = cv.getBoundingClientRect(); var v = window.__adjustView; return JSON.stringify({ x: r.left + (v.ix/v.bw)*r.width, y: r.top + (v.iy/v.bh)*r.height, w: (v.iw/v.bw)*r.width, h: (v.ih/v.bh)*r.height }); })()`));
await drag(img2.x + img2.w * 0.2, img2.y + img2.h * 0.2, img2.x + img2.w * 0.7, img2.y + img2.h * 0.7);
await sleep(300);
const afterDrag = await imgRect();
const cancelled = await clickPanelBtn('取消裁剪');
await sleep(500);
const afterCancel = await imgRect();
check('T12-4', cancelled === 'ok' && !(await evaluate(`!!document.querySelector('[data-crop-toolbar]')`)), `取消裁剪: 退出裁剪态(点击返回=${cancelled})`);
const KEYS = ['left', 'top', 'iw', 'ih'];
const moved = KEYS.some(k => Math.abs(afterDrag[k] - afterApply[k]) > 2);
const restored = KEYS.every(k => Math.abs(afterCancel[k] - afterApply[k]) <= 2);
check('T12-5', moved && restored, `回退到应用时的裁剪: 拖后 ${JSON.stringify(afterDrag)} ≠ 应用时, 取消后 ${JSON.stringify(afterCancel)} = 应用时 ${JSON.stringify(afterApply)}`);

const { writeFileSync } = await import('node:fs');
const sr = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('test/t12-apply-crop.png', Buffer.from(sr.data, 'base64'));

// 清理:关调整=取消(清参数行,文件不动)
await evaluate(`document.querySelector('[title="调整"]').click()`);
console.log(fail === 0 ? '[T12] 全部通过' : `[T12] ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
