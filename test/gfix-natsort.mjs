// 名字自然序冒烟（虚拟化感知版）：
// 关分组 → 滚顶 → 文件夹块前缀必须按自然序、其后可见图片必须单调（asc/desc 各断一轮）。
// TopBar 排序菜单：点选项后不自动关（点 fixed 遮罩收起）；方向按钮显示"当前"方向。
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(p => p.type === 'page' && /localhost:14422/.test(p.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let seq = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r.result.value;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const READ_GRID = "(() => { const items=[...document.querySelectorAll('.file-item')].map(el=>{const spans=[...el.querySelectorAll('div')].map(d=>(d.textContent||'').trim()).filter(s=>s.length>1); const raw=spans[spans.length-2]||spans[spans.length-1]||''; return raw.replace(/\\d+x\\d+$/,'');}); return JSON.stringify(items); })()";
const SCROLL_TOP = "(() => { const b=document.querySelector('button[title=\"排序方式\"]'); let p=b&&b.parentElement; while(p){const s=getComputedStyle(p); if(/(auto|scroll)/.test(s.overflowY)){p.scrollTop=0; return p.scrollTop;} p=p.parentElement;} return -1; })()";

const closeMenu = async () => {
  const was = await evaluate(`(() => { const ov=document.querySelector('div.fixed.inset-0.z-40'); if(!ov) return false; ov.click(); return true; })()`);
  await sleep(250);
  return was;
};
const openMenu = async () => {
  await closeMenu();
  const r = await evaluate(`(() => { const b=document.querySelector('button[title="排序方式"]'); if(!b) return 'no-btn'; b.click(); return 'ok'; })()`);
  await sleep(350);
  return r;
};
const clickMenuButton = async (exact) => {
  const r = await evaluate(`(() => { const btns=[...document.querySelectorAll('button')].filter(b=>(b.textContent||'').trim()===${JSON.stringify(exact)}); if(!btns.length) return 'no-match'; btns[btns.length-1].click(); return 'clicked'; })()`);
  await sleep(700);
  await closeMenu();
  return r;
};
const pick = async (label) => { await openMenu(); return clickMenuButton(label); };

console.log('--- 关闭分组（选"无"）+ 切按名称 + 滚顶:');
console.log('group-none:', await pick('无'));
console.log('sort-name:', await pick('按名称'));
console.log('scrollTop:', await evaluate(SCROLL_TOP));
await sleep(700);
const asc = JSON.parse(await evaluate(READ_GRID));
console.log('flat asc:', asc);

// 文件夹块 = 已知 4 个文件夹；asc 期望
const FOLDERS = ['Desktop', 'Game.exe', 'Weixin', 'Wuthering Waves'];
const folderPrefixOk = (items, dir) => {
  const expect = [...FOLDERS].sort((a, b) => dir === 'asc' ? collator.compare(a, b) : collator.compare(b, a));
  return JSON.stringify(items.slice(0, 4)) === JSON.stringify(expect);
};
const imagesMonotonic = (items, dir) => {
  const imgs = items.slice(4);
  if (imgs.length < 2) return 'too-few-visible';
  for (let i = 1; i < imgs.length; i++) {
    const c = collator.compare(imgs[i - 1], imgs[i]);
    if (dir === 'asc' ? c > 0 : c < 0) return `violated at [${i - 1}]="${imgs[i - 1]}" vs [${i}]="${imgs[i]}"`;
  }
  return true;
};
const ascOk = asc.length >= 6 && folderPrefixOk(asc, 'asc') && imagesMonotonic(asc, 'asc') === true;
console.log('asc: folderPrefixOk =', folderPrefixOk(asc, 'asc'), ', images monotonic =', imagesMonotonic(asc, 'asc'));

console.log('--- 切到降序（点"升序"）+ 滚顶:');
console.log(await pick('升序'));
console.log('scrollTop:', await evaluate(SCROLL_TOP));
await sleep(700);
const desc = JSON.parse(await evaluate(READ_GRID));
console.log('flat desc:', desc);
const descOk = desc.length >= 6 && folderPrefixOk(desc, 'desc') && imagesMonotonic(desc, 'desc') === true;
console.log('desc: folderPrefixOk =', folderPrefixOk(desc, 'desc'), ', images monotonic =', imagesMonotonic(desc, 'desc'));

console.log('--- 恢复:升序 + 分组按类型 + 收起文件夹组 + 滚顶:');
console.log(await pick('降序'));
console.log('group-type:', await pick('类型'));
await sleep(400);
// 若"文件夹"组当前展开则收起
console.log('collapse-folder:', await evaluate(`(() => { const hs=[...document.querySelectorAll('div')].filter(d=>d.className&&String(d.className).includes('sticky top-0')); const f=hs.find(d=>(d.textContent||'').trim().startsWith('文件夹')); if(!f) return 'no-header'; const grp=f.parentElement; if(grp.children.length>1) { f.click(); return 'collapsed'; } return 'already-collapsed'; })()`));
await evaluate(SCROLL_TOP);
await sleep(500);

const flipped = JSON.stringify(asc) !== JSON.stringify(desc);
let ok = ascOk && descOk && flipped;
console.log(`flipped: ${flipped}`);
console.log(ok ? 'PASS ✅ 平铺网格按名字自然序排列、方向真实生效、界面状态已复原' : 'FAIL ❌');
process.exit(ok ? 0 : 1);
