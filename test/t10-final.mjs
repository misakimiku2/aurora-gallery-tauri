const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(p => p.type === 'page' && /localhost:14422/.test(p.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let seq = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (p) => { const r = await send('Page.captureScreenshot', { format: 'png' }); const { writeFileSync } = await import('node:fs'); writeFileSync(p, Buffer.from(r.data, 'base64')); };
const mouse = async (type, x, y, extra = {}) => { await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' || type === 'mousePressed' ? 1 : 0, clickCount: extra.clickCount ?? 1, ...extra }); };
const drag = async (x1, y1, x2, y2, steps = 10) => { await mouse('mousePressed', x1, y1); for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps); await sleep(16); } await mouse('mouseReleased', x2, y2); };

// 1) 开查看器
let opened = false;
for (let i = 0; i < 15 && !opened; i++) {
  opened = await evaluate(`(function(){ var el = document.querySelector('[title="adjust-smoke.jpg"]'); if(!el) return false; var r = el.getBoundingClientRect(); window.__card = {x: r.x + r.width/2, top: r.top}; return true; })()`);
  if (!opened) { await evaluate(`(function(){ var b = document.querySelector('[title*="刷新"], [title*="Refresh"]'); if(b) b.click(); return 1; })()`); await sleep(2000); }
}
const card = JSON.parse(await evaluate('JSON.stringify(window.__card)'));
await mouse('mousePressed', card.x, card.top - 60); await mouse('mouseReleased', card.x, card.top - 60);
await sleep(120);
await mouse('mousePressed', card.x, card.top - 60, { clickCount: 2 }); await mouse('mouseReleased', card.x, card.top - 60, { clickCount: 2 });
await sleep(1500);
console.log('[T10-0] 查看器:', await evaluate(`!!document.querySelector('[title="调整"]')`));

// 2) 编辑 + 裁剪态 + 清除默认框
await evaluate(`document.querySelector('[title="调整"]').click()`);
await sleep(500);
await evaluate(`(function(){ var b = Array.from(document.querySelectorAll('#aurora-adjust-slot button')).find(function(x){ return x.getAttribute('title') === '裁剪'; }); b.click(); return 1; })()`);
await sleep(400);
await evaluate(`(function(){ var b = Array.from(document.querySelectorAll('#aurora-adjust-slot button')).find(function(x){ return x.textContent.trim() === '清除裁剪'; }); if (b) b.click(); return 1; })()`);
await sleep(300);

// 3) 框随指针
await drag(560, 420, 1000, 680);
await sleep(300);
const rect = JSON.parse(await evaluate(`JSON.stringify(window.__adjustCropRect)`));
const dpr = await evaluate(`(function(){ var cv = document.querySelector('canvas[data-adjust-canvas]'); return cv.width / cv.getBoundingClientRect().width; })()`);
const cr = await evaluate(`(function(){ var cv = document.querySelector('canvas[data-adjust-canvas]'); var r = cv.getBoundingClientRect(); return JSON.stringify({left: r.left, top: r.top}); })()`);
const off = JSON.parse(cr);
const css = { x: Math.round(rect.x / dpr + off.left), y: Math.round(rect.y / dpr + off.top), r: Math.round((rect.x + rect.w) / dpr + off.left), b: Math.round((rect.y + rect.h) / dpr + off.top) };
const ok = Math.abs(css.x - 560) < 70 && Math.abs(css.y - 420) < 70 && Math.abs(css.r - 1000) < 70 && Math.abs(css.b - 680) < 70;
console.log('[T10-1] 拉框(视口 px):', JSON.stringify(css), ok ? '✓ 框随指针(560,420→1000,680)' : '✗ FAIL');

// 4) 1:1 → 像素比
await evaluate(`(function(){ var b = Array.from(document.querySelectorAll('#aurora-adjust-slot button')).find(function(x){ return x.textContent.trim() === '1:1'; }); b.click(); return 1; })()`);
await sleep(400);
const rect2 = JSON.parse(await evaluate(`JSON.stringify(window.__adjustCropRect)`));
const norm = rect2.w / rect2.h / 1.5;
const pxRatio = norm * 1.5;
console.log('[T10-2] 1:1 像素比:', Math.round(pxRatio * 100) / 100, Math.abs(pxRatio - 1) < 0.05 ? '✓' : '✗ FAIL');
await shot('test/t10-crop-1to1.png');

// 5) 菜单单份/图标/动画/同宽
await evaluate(`(function(){ var chev = Array.from(document.querySelectorAll('#aurora-adjust-slot button')).find(function(b){ return b.querySelector('.lucide-chevron-down'); }); chev.click(); return 1; })()`);
await sleep(300);
const menu = await evaluate(`(function(){
  var slot = document.getElementById('aurora-adjust-slot');
  var saves = Array.from(slot.querySelectorAll('button')).filter(function(x){ return x.textContent.trim() === '保存'; });
  if (saves.length !== 1) return JSON.stringify({ FAIL: '保存按钮 x' + saves.length });
  var b = saves[0];
  var sp = b.parentElement.getBoundingClientRect();
  return JSON.stringify({ count: 1, hasIcon: !!b.querySelector('.lucide-save'), anim: getComputedStyle(b.parentElement).animationName, sameWidth: Math.abs(b.getBoundingClientRect().width - sp.width) < 3, bg: getComputedStyle(b).backgroundColor });
})()`);
console.log('[T10-3] 保存菜单:', menu);
await shot('test/t10-menu.png');

// 6) 清理:关编辑=取消
await evaluate(`document.querySelector('[title="调整"]').click()`);
console.log('[T10] 完成');
process.exit(0);
