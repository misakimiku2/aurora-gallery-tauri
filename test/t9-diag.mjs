const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(p => p.type === 'page' && /localhost:14422/.test(p.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let seq = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 进编辑
await evaluate(`document.querySelector('[title="调整"]').click()`);
await sleep(500);
// 拖亮度
const s = JSON.parse(await evaluate(`(function(){ var i = document.querySelectorAll('#aurora-adjust-slot input[type="range"]'); var inp = i[i.length-5]; var r = inp.getBoundingClientRect(); return JSON.stringify({left: r.x, right: r.x+r.width, y: r.y+r.height/2}); })()`));
for (const [t, x] of [['mousePressed', s.left + 10], ['mouseMoved', s.right - 60], ['mouseReleased', s.right - 60]]) {
  await send('Input.dispatchMouseEvent', { type: t, x, y: s.y, button: 'left', buttons: t === 'mouseReleased' || t === 'mousePressed' ? 1 : 0, clickCount: 1 });
  await sleep(30);
}
await sleep(200);
// 开菜单
await evaluate(`(function(){ var chev = Array.from(document.querySelectorAll('#aurora-adjust-slot button')).find(function(b){ return b.querySelector('.lucide-chevron-down'); }); chev.click(); return 1; })()`);
await sleep(300);
const tree = await evaluate(`(function(){
  var slot = document.getElementById('aurora-adjust-slot');
  function walk(el, depth) {
    var out = [];
    Array.from(el.children).forEach(function(c) {
      var fiberKeys = Object.keys(c).filter(function(k){ return k.startsWith('__reactFiber'); }).length;
      out.push({ d: depth, tag: c.tagName, cls: (c.className||'').toString().slice(0,45), fiber: fiberKeys, text: (c.textContent||'').slice(0,12), kids: walk(c, depth+1) });
    });
    return out;
  }
  return JSON.stringify(walk(slot, 0));
})()`);
console.log('[t9] slot 树:', tree.slice(0, 1400));
process.exit(0);
