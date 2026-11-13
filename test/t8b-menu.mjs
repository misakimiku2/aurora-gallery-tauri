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
// 开查看器(卡片还在网格?HMR 后回网格,重开)
let opened = false;
for (let i = 0; i < 10 && !opened; i++) {
  opened = await evaluate(`(function(){ var b = document.querySelector('[title="调整"]'); if (b && b.getBoundingClientRect().width) return true; return false; })()`);
  if (!opened) {
    const card = await evaluate(`(function(){ var el = document.querySelector('[title="adjust-smoke.jpg"]'); if(!el) return null; var r = el.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, top: r.top}); })()`);
    if (card) {
      const c = JSON.parse(card);
      for (const t of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type: t, x: c.x, y: c.top - 60, button: 'left', clickCount: 1 });
      for (const t of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type: t, x: c.x, y: c.top - 60, button: 'left', clickCount: 2 });
      await sleep(1200);
    } else {
      await evaluate(`(function(){ var b = document.querySelector('[title*="刷新"], [title*="Refresh"]'); if(b) b.click(); return 1; })()`);
      await sleep(2000);
    }
  }
}
console.log('[t8b] viewer open:', opened);
await evaluate(`document.querySelector('[title="调整"]').click()`);
await sleep(500);
// 拖亮度制造 hasChanges
const s = JSON.parse(await evaluate(`(function(){ var i = document.querySelectorAll('#aurora-adjust-slot input[type="range"]'); var inp = i[i.length-5]; var r = inp.getBoundingClientRect(); return JSON.stringify({left: r.x, right: r.x+r.width, y: r.y+r.height/2}); })()`));
for (const [t, x] of [['mousePressed', s.left + 10], ['mouseMoved', s.right - 60], ['mouseReleased', s.right - 60]]) {
  await send('Input.dispatchMouseEvent', { type: t, x, y: s.y, button: 'left', buttons: t === 'mouseReleased' || t === 'mousePressed' ? 1 : 0, clickCount: 1 });
  await sleep(30);
}
await sleep(200);
// 开菜单
await evaluate(`(function(){ var btns = Array.from(document.querySelectorAll('#aurora-adjust-slot button')); var chev = btns.find(function(b){ return b.querySelector('.lucide-chevron-down'); }); chev.click(); return 1; })()`);
await sleep(300);
const diag = await evaluate(`(function(){
  var slot = document.getElementById('aurora-adjust-slot');
  var b = Array.from(slot.querySelectorAll('button')).find(function(x){ return x.textContent.trim() === '保存'; });
  if (!b) return 'no save btn';
  var svg = b.querySelector('svg');
  return JSON.stringify({
    svgClass: svg ? svg.getAttribute('class') : null,
    svgChildren: svg ? svg.innerHTML.length : -1,
    parentClass: b.parentElement.className,
    anim: getComputedStyle(b.parentElement).animationName,
    rect: (function(){ var r = b.getBoundingClientRect(); var sp = b.parentElement.getBoundingClientRect(); return { w: Math.round(r.width), splitW: Math.round(sp.width) }; })()
  });
})()`);
console.log('[t8b] menu diag:', diag);
const crop = await evaluate(`JSON.stringify(window.__adjustCropRect || null)`);
console.log('[t8b] crop hook:', crop);
process.exit(0);
