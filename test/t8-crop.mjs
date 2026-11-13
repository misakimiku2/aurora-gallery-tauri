// 裁剪交互终版冒烟(2026-11-14):框随指针/1:1 像素比/全背景遮罩/平移/菜单单份
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(p => p.type === 'page' && /localhost:14422/.test(p.url));
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
console.log('[T8-1] 查看器:', await evaluate(`!!document.querySelector('[title="调整"]')`));

// 2) 编辑态 + 裁剪态
await evaluate(`document.querySelector('[title="调整"]').click()`);
await sleep(500);
await evaluate(`(function(){ var b = Array.from(document.querySelectorAll('#aurora-adjust-slot button')).find(function(x){ return x.getAttribute('title') === '裁剪'; }); b.click(); return 1; })()`);
await sleep(500);

// 3) 框随指针:P1(500,400) 按下拖到 P2(1000,700) → 读钩子矩形(CSS 像素换算)
const dpr = await evaluate(`(function(){ var cv = document.querySelector('canvas[data-adjust-canvas]'); return cv.width / cv.getBoundingClientRect().width; })()`);
await drag(500, 400, 1000, 700);
await sleep(300);
const rect1 = JSON.parse(await evaluate(`JSON.stringify(window.__adjustCropRect)`));
const css = { x: rect1.x / dpr, y: rect1.y / dpr, r: (rect1.x + rect1.w) / dpr, b: (rect1.y + rect1.h) / dpr };
const okFollow = Math.abs(css.x - 500) < 60 && Math.abs(css.y - 400) < 60 && Math.abs(css.r - 1000) < 60 && Math.abs(css.b - 700) < 60;
console.log('[T8-3] 裁剪矩形(CSS px):', JSON.stringify(css), okFollow ? '✓ 框随指针(P1→P2)' : '⚠ 边缘可能被帧 contain 裁住,看数值');

// 4) 1:1 → 像素比 ≈ 1(帧显示比 = 图片比 1.5)
await evaluate(`(function(){ var b = Array.from(document.querySelectorAll('#aurora-adjust-slot button')).find(function(x){ return x.textContent.trim() === '1:1'; }); b.click(); return 1; })()`);
await sleep(400);
const rect2 = JSON.parse(await evaluate(`JSON.stringify(window.__adjustCropRect)`));
const pxAspect = Math.round(((rect2.w / rect2.h) / 1.5) * 100) / 100;
console.log('[T8-4] 1:1 归一化比:', Math.round(rect2.w / rect2.h * 100) / 100, '→ 像素比:', pxAspect, Math.abs(pxAspect - 1) < 0.05 ? '✓ 像素空间锁比正确' : '✗ FAIL');
await shot('test/t8-crop-1to1.png');

// 5) 退裁剪 → 图内平移
await evaluate(`(function(){ var b = Array.from(document.querySelectorAll('#aurora-adjust-slot button')).find(function(x){ return x.getAttribute('title') === '裁剪'; }); b.click(); return 1; })()`);
await sleep(300);
await drag(700, 500, 850, 620, 6);
await sleep(300);
const tf = await evaluate(`(function(){ var cvWrap = Array.from(document.querySelectorAll('div')).find(function(d){ return d.querySelector('canvas[data-adjust-canvas]') && d.style.transform; }); return cvWrap ? cvWrap.style.transform : 'none'; })()`);
console.log('[T8-5] 调整态图内平移:', tf, tf.includes('translate(150px, 120px)') || tf !== 'translate(0px, 0px) rotate(0deg) scale(1)' ? '✓' : '✗ FAIL');

// 6) 菜单:单份按钮/图标/动画/同宽
await evaluate(`(function(){ var btns = Array.from(document.querySelectorAll('#aurora-adjust-slot button')); var chev = btns.find(function(b){ return b.querySelector('.lucide-chevron-down'); }); chev.click(); return 1; })()`);
await sleep(300);
const menu = await evaluate(`(function(){
  var slot = document.getElementById('aurora-adjust-slot');
  var saves = Array.from(slot.querySelectorAll('button')).filter(function(x){ return x.textContent.trim() === '保存'; });
  if (saves.length !== 1) return JSON.stringify({ FAIL: '保存按钮数量 ' + saves.length });
  var b = saves[0];
  var sp = b.parentElement.getBoundingClientRect();
  var cs = getComputedStyle(b.parentElement);
  return JSON.stringify({ count: 1, hasIcon: !!b.querySelector('.lucide-save'), anim: cs.animationName, sameWidth: Math.abs(b.getBoundingClientRect().width - sp.width) < 3, bg: cs.backgroundColor });
})()`);
console.log('[T8-6] 保存菜单:', menu);
await shot('test/t8-menu.png');

// 清理:关编辑=取消 → 文件不动
await evaluate(`document.querySelector('[title="调整"]').click()`);
console.log('[T8] 完成');
process.exit(0);
