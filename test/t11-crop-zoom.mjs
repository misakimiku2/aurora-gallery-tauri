// 裁剪缩放态冒烟(2026-11-14 用户实测四坑回归):缩小图后——
//   ① 遮罩盖满整个查看器背景(非变换暗化层,尺寸=画布可视矩形)
//   ② 拉框从指针起(宿主 scale 变换下的坐标逆变换)
//   ③ 角手柄可拖(命中半径视觉恒定)
//   ④ 三分线可拖边(九宫格调形)
// 目标点全部按 __adjustView 图像显示矩形相对推算,不依赖窗口尺寸;
// 全程不保存、收尾取消,不动磁盘。通路沿用 cdp-smoke-webview2-pitfalls 记忆。
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
const shot = async (path) => { const r = await send('Page.captureScreenshot', { format: 'png' }); const { writeFileSync } = await import('node:fs'); writeFileSync(path, Buffer.from(r.data, 'base64')); };
const mouse = async (type, x, y, extra = {}) => { await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseMoved' ? 1 : (type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0), clickCount: extra.clickCount ?? 1, ...extra }); };
const drag = async (x1, y1, x2, y2, steps = 10) => { await mouse('mousePressed', x1, y1); for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps); await sleep(16); } await mouse('mouseReleased', x2, y2); };
const wheel = async (x, y, dy) => { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy }); };
let fail = 0;
const check = (name, ok, detail) => { console.log(`[${name}]`, detail, ok ? '✓' : '✗ FAIL'); if (!ok) fail++; };

// 0) 整页刷新(清掉上轮残留的缩放/裁剪态,HMR 幽灵一并清掉)
await send('Page.reload', { ignoreCache: true });
await sleep(5000);

// 1) 开查看器(双击图片区,标签不碰——双击标签=重命名)
// 注:用户拍板换图测(adjust-smoke.jpg naturalWidth=0 有问题)→ 用网格里的真实图
// crop-ui-test.jpg;全程不保存、收尾取消,不动磁盘。
const CARD_TITLE = 'crop-ui-test.jpg';
let card = null;
for (let i = 0; i < 15 && !card; i++) {
  const ok = await evaluate(`(function(){ var el = document.querySelector('[title="${CARD_TITLE}"]'); if(!el) return false; var r = el.getBoundingClientRect(); window.__card = {x: r.x + r.width/2, top: r.top}; return true; })()`);
  if (ok) card = JSON.parse(await evaluate('JSON.stringify(window.__card)'));
  else { await evaluate(`(function(){ var b = document.querySelector('[title*="刷新"], [title*="Refresh"]'); if(b) b.click(); return 1; })()`); await sleep(2000); }
}
if (!card) throw new Error('网格里没找到 ' + CARD_TITLE);
await mouse('mousePressed', card.x, card.top - 60); await mouse('mouseReleased', card.x, card.top - 60);
await sleep(120);
await mouse('mousePressed', card.x, card.top - 60, { clickCount: 2 }); await mouse('mouseReleased', card.x, card.top - 60, { clickCount: 2 });
await sleep(1500);
check('T11-1', await evaluate(`!!document.querySelector('[title="调整"]')`), '查看器已开');

// 2) 编辑态 + 裁剪态(若该文件有持久化残留参数——前轮探针写入了文件元数据,
//    重载后会被加载回来——先重置,保证从无裁剪的干净态开测)
const hasAdjust = await evaluate(`document.querySelector('[title="调整"]').className.includes('text-blue-500')`);
if (hasAdjust) {
  await evaluate(`document.querySelector('[title="调整"]').click()`);
  await sleep(500);
  await evaluate(`(function(){ var b = Array.from(document.querySelectorAll('#aurora-adjust-slot button')).find(function(x){ return x.textContent.trim() === '重置'; }); if(b) b.click(); return 1; })()`);
  await sleep(600);
  await evaluate(`document.querySelector('[title="调整"]').click()`);
  await sleep(600);
  console.log('[pre-clean] 已重置持久化残留参数');
  await evaluate(`document.querySelector('[title="调整"]').click()`);
  await sleep(500);
} else {
  await evaluate(`document.querySelector('[title="调整"]').click()`);
  await sleep(500);
}
await evaluate(`(function(){ var b = Array.from(document.querySelectorAll('#aurora-adjust-slot button')).find(function(x){ return x.getAttribute('title') === '裁剪'; }); b.click(); return 1; })()`);
await sleep(500);
// 既有裁剪残留(本次会话内)也清掉
const preRect = await evaluate(`JSON.stringify(window.__adjustCropRect || null)`);
if (preRect !== 'null') {
  await evaluate(`(function(){ var b = Array.from(document.querySelectorAll('[data-crop-toolbar] button')).find(function(x){ return x.textContent.trim() === '清除裁剪'; }); if(b) b.click(); return 1; })()`);
  await sleep(400);
  console.log('[pre-clean] 已清除会话内既有裁剪矩形');
}

// 3) 缩小图:先把 scale 归到 ≈1(带外则向 1 收敛),再向下滚 2 步(≈0.59)——用户截图场景
// scale 读法:画布可视宽/布局宽(变换在包裹 div 上,canvas 自身 computed 恒 none)
const readScale = async () => JSON.parse(await evaluate(`(function(){ var cv = document.querySelector('canvas[data-adjust-canvas]'); return cv.getBoundingClientRect().width / cv.clientWidth; })()`));
for (let i = 0; i < 15; i++) {
  const s = await readScale();
  if (s > 0.9 && s < 1.1) break;
  await wheel(500, 450, s > 1.1 ? 360 : -360); // 滚轮向下=缩小,向上=放大
  await sleep(380);
}
for (let i = 0; i < 2; i++) { await wheel(500, 450, 360); await sleep(380); }
const geom = JSON.parse(await evaluate(`(function(){ var cv = document.querySelector('canvas[data-adjust-canvas]'); var r = cv.getBoundingClientRect(); var v = JSON.parse(JSON.stringify(window.__adjustView)); return JSON.stringify({ scale: r.width / cv.clientWidth, left: r.left, top: r.top, width: r.width, height: r.height, bw: v.bw, bh: v.bh, ix: v.ix, iy: v.iy, iw: v.iw, ih: v.ih }); })()`));
console.log('[T11-3] 宿主 scale =', geom.scale.toFixed(3));
check('T11-3', geom.scale < 0.95 && geom.scale > 0.3, '缩小态 scale=' + geom.scale.toFixed(3));
// 链式合成对账:toCanvasPx 同款算法,打印实际合成的线性部分
console.log('[chain]', await evaluate(`(function(){ var cv = document.querySelector('canvas[data-adjust-canvas]'); var ma=1,mb=0,mc=0,md=1; var log=[]; for (var el = cv; el && el !== document.body; el = el.parentElement) { var t = getComputedStyle(el).transform; if (!t || t === 'none') continue; var m = new DOMMatrix(t); if (m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1) continue; log.push(el.tagName + ':' + t.slice(0, 48)); var na = m.a*ma + m.c*mb, nb = m.b*ma + m.d*mb, nc = m.a*mc + m.c*md, nd = m.b*mc + m.d*md; ma=na; mb=nb; mc=nc; md=nd; } var det = ma*md - mb*mc; return JSON.stringify({ chain: log, cssScale: Math.sqrt(Math.abs(det)).toFixed(4) }); })()`));

// 视口 CSS 里的图像显示矩形(画布设备px 线性映回)
const img = {
  x: geom.left + (geom.ix / geom.bw) * geom.width,
  y: geom.top + (geom.iy / geom.bh) * geom.height,
  w: (geom.iw / geom.bw) * geom.width,
  h: (geom.ih / geom.bh) * geom.height,
};
console.log('[T11-3] 图像显示矩形:', JSON.stringify(Object.fromEntries(Object.entries(img).map(([k, v]) => [k, Math.round(v)]))));

// 4) 拉框随指针:P1/P2 取图像中部 25%..75% 区域(必在图内,无边界钳制干扰)
const p1 = { x: img.x + img.w * 0.25, y: img.y + img.h * 0.25 };
const p2 = { x: img.x + img.w * 0.75, y: img.y + img.h * 0.75 };
const rawAt = async (tag) => {
  const r = JSON.parse(await evaluate(`JSON.stringify(window.__adjustCropRect)`));
  const v = JSON.parse(await evaluate(`JSON.stringify(window.__adjustView)`));
  const cv = JSON.parse(await evaluate(`(function(){ var b = document.querySelector('canvas[data-adjust-canvas]').getBoundingClientRect(); return JSON.stringify({ left: b.left, top: b.top, width: b.width, height: b.height }); })()`));
  console.log(`[raw ${tag}]`, 'rect:', JSON.stringify(r), 'view.vx/vy:', Math.round(v.vx), Math.round(v.vy), 'cvRect:', JSON.stringify(Object.fromEntries(Object.entries(cv).map(([k, x]) => [k, Math.round(x)]))));
  return r;
};
await drag(p1.x, p1.y, p2.x, p2.y);
await sleep(300);
const rect1 = await rawAt('T11-4');
const toCss = (rect) => ({
  x: geom.left + (rect.x / geom.bw) * geom.width,
  y: geom.top + (rect.y / geom.bh) * geom.height,
  r: geom.left + ((rect.x + rect.w) / geom.bw) * geom.width,
  b: geom.top + ((rect.y + rect.h) / geom.bh) * geom.height,
});
const css1 = toCss(rect1);
const okFollow = Math.abs(css1.x - p1.x) < 40 && Math.abs(css1.y - p1.y) < 40 && Math.abs(css1.r - p2.x) < 40 && Math.abs(css1.b - p2.y) < 40;
check('T11-4', okFollow, `框随指针: 左上(${css1.x.toFixed(0)},${css1.y.toFixed(0)})≈(${p1.x.toFixed(0)},${p1.y.toFixed(0)}) 右下(${css1.r.toFixed(0)},${css1.b.toFixed(0)})≈(${p2.x.toFixed(0)},${p2.y.toFixed(0)})`);

// 5) 角手柄:SE 手柄(视觉坐标)拖 +Δ → 矩形右/下跟着走
const ddx = Math.min(60, img.w * 0.18), ddy = Math.min(45, img.h * 0.18);
await drag(css1.r, css1.b, css1.r + ddx, css1.b + ddy);
await sleep(300);
const rect2 = JSON.parse(await evaluate(`JSON.stringify(window.__adjustCropRect)`));
const css2 = toCss(rect2);
check('T11-5', Math.abs(css2.r - (css1.r + ddx)) < 40 && Math.abs(css2.b - (css1.b + ddy)) < 40, `SE 手柄可拖: 右下(${css2.r.toFixed(0)},${css2.b.toFixed(0)})≈(${(css1.r + ddx).toFixed(0)},${(css1.b + ddy).toFixed(0)})`);

// 6) 三分线拖边:左 1/3 线中点向右拖 → 左缘右移、宽变窄
const lineX = geom.left + ((rect2.x + rect2.w / 3) / geom.bw) * geom.width;
const lineY = geom.top + ((rect2.y + rect2.h / 2) / geom.bh) * geom.height;
await drag(lineX, lineY, lineX + Math.min(60, img.w * 0.15), lineY, 8);
await sleep(300);
const rect3 = JSON.parse(await evaluate(`JSON.stringify(window.__adjustCropRect)`));
const css3 = toCss(rect3);
const grewLeft = css3.x - css2.x;
const w2 = css2.r - css2.x, w3 = css3.r - css3.x;
check('T11-6', grewLeft > 15 && w3 < w2 - 15, `三分线拖边: 左缘右移 ${grewLeft.toFixed(0)}px, 宽 ${w2.toFixed(0)}→${w3.toFixed(0)}`);

// 7) 1:1 → 像素正方形:画布设备 w/h 应 ≈ 1(设备空间=帧空间均匀缩放;
//    设备比已含帧比,再除 frameAspect 是 t8 时代把"归一化方形"当正确的旧口径)
await evaluate(`(function(){ var b = Array.from(document.querySelectorAll('[data-crop-toolbar] button')).find(function(x){ return x.textContent.trim() === '1:1'; }); b.click(); return 1; })()`);
await sleep(500);
const rect4 = JSON.parse(await evaluate(`JSON.stringify(window.__adjustCropRect)`));
const devRatio = rect4.w / rect4.h;
check('T11-7', Math.abs(devRatio - 1) < 0.05, `1:1 像素锁定: 设备 w/h = ${devRatio.toFixed(3)} (帧内正方形)`);
console.log('[T11-7] rect:', JSON.stringify(rect4));

// 8) 遮罩盖满背景:非变换暗化层(=查看器 stage 尺寸,不随图缩放)必须盖住图像显示矩形
const dim = JSON.parse(await evaluate(`(function(){ var d = document.querySelector('[data-crop-dim="1"]'); if(!d) return JSON.stringify({missing:1}); var r = d.getBoundingClientRect(); return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height, bg: getComputedStyle(d).backgroundColor, pe: getComputedStyle(d).pointerEvents }); })()`));
if (dim.missing) { check('T11-8', false, '暗化层不在场'); }
else {
  const covers = dim.x <= img.x + 2 && dim.y <= img.y + 2 && dim.x + dim.w >= img.x + img.w - 2 && dim.y + dim.h >= img.y + img.h - 2;
  check('T11-8', covers && dim.bg === 'rgba(0, 0, 0, 0.55)' && dim.pe === 'none', `暗化层 ${dim.w.toFixed(0)}×${dim.h.toFixed(0)} @(${dim.x.toFixed(0)},${dim.y.toFixed(0)}) ⊇ 图像显示矩形 ${img.w.toFixed(0)}×${img.h.toFixed(0)} @(${img.x.toFixed(0)},${img.y.toFixed(0)}), ${dim.bg}, pe=${dim.pe}`);
}
await shot('test/t11-crop-zoom.png');

// 清理:关编辑=取消 → 文件不动
await evaluate(`document.querySelector('[title="调整"]').click()`);
console.log(fail === 0 ? '[T11] 全部通过' : `[T11] ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
