// 直调后端 scan_directory:把 C:\Photos 强扫入库(反斜杠路径与 UI 查询口径一致)
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(p => p.type === 'page' && p.title === 'Aurora Gallery');
if (!page) throw new Error('page not found');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let seq = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval err');
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const winPath = 'C:' + String.fromCharCode(92) + 'Photos';
console.log('scan:', await ev(`import('/@id/@tauri-apps/api/core').then(function(m){ return m.invoke('scan_directory', { path: ${JSON.stringify(winPath)}, force: true }).then(function(r){ return 'OK ' + JSON.stringify(r).slice(0,150); }).catch(function(e){ return 'ERR ' + e; }); })`));
await sleep(1500);
console.log('refresh:', await ev(`(function(){ var b = document.querySelector('[title*="刷新"]'); if(b) { b.click(); return 'ok'; } return 'MISSING'; })()`));
for (let i = 0; i < 6; i++) {
  await sleep(2000);
  const found = await ev(`!!document.querySelector('[title="crop-ui-test.jpg"]')`);
  if (found) { console.log('card found after', (i + 1) * 2, 's'); break; }
  if (i === 5) console.log('not found');
}
process.exit(0);
