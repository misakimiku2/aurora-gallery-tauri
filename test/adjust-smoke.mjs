// 轻量快调 GUI 冒烟驱动(通路沿用 cdp-smoke-webview2-pitfalls 记忆):
// node≥22 全局 WebSocket 直连 ws://127.0.0.1:9222/devtools/page/<id>。
// ⚠️ eval 一律单行(分号连接)——多行会被截断只跑第一行且无报错。
const CDP_HTTP = 'http://127.0.0.1:9222';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`${CDP_HTTP}/json/list`)).json();
      const page = list.find((p) => p.type === 'page' && /tauri\.localhost|localhost:14422/.test(p.url));
      if (page) return page;
    } catch { /* 应用还没起 */ }
    await sleep(1000);
  }
  throw new Error('CDP page 未找到(应用未启动?)');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const id = ++seq;
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      close: () => ws.close(),
    });
    ws.onerror = reject;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    };
  });
}

const main = async () => {
  const page = await findPage();
  console.log('[smoke] page:', page.title, page.url);
  const cdp = await connect(page.webSocketDebuggerUrl);

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
    return r.result.value;
  };
  const screenshot = async (path) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, Buffer.from(r.data, 'base64'));
  };
  const mouse = async (type, x, y, extra = {}) => {
    await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' || type === 'mousePressed' ? 1 : 0, clickCount: 1, ...extra });
  };
  const drag = async (x1, y1, x2, y2, steps = 8) => {
    await mouse('mousePressed', x1, y1);
    for (let i = 1; i <= steps; i++) {
      await mouse('mouseMoved', x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps);
      await sleep(16);
    }
    await mouse('mouseReleased', x2, y2);
  };
  const key = async (key, code, keyCode) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  };

  // ── T0:页面就绪 ──
  await evaluate('document.readyState === "complete" || document.readyState === "interactive"');
  console.log('[T0] 页面就绪');

  // ── T1:打开测试图的查看器(网格卡片 title 双击;dev 库扫描可能要等) ──
  let opened = false;
  for (let i = 0; i < 20 && !opened; i++) {
    opened = await evaluate(`(function(){ var el = document.querySelector('[title="adjust-smoke.jpg"]'); if(!el) return false; var r = el.getBoundingClientRect(); window.__smokeCard = {x: r.x + r.width/2, y: r.y + r.height/2, top: r.top, left: r.x}; return true; })()`);
    if (!opened) {
      // 刷新按钮重扫(记忆:dev 库陈旧,点刷新是最快通路)
      await evaluate(`(function(){ var b = document.querySelector('[title*="刷新"], [title*="Refresh"], [title*="rescan"], [title*="Rescan"]'); if(b){ b.click(); } return !!b; })()`);
      await sleep(2000);
    }
  }
  if (!opened) { console.log('[T1] FAIL: 网格里没找到 adjust-smoke.jpg 卡片'); await screenshot('test/adjust-smoke-fail-t1.png'); process.exit(1); }
  console.log('[T1] 卡片坐标', await evaluate('JSON.stringify(window.__smokeCard)'));
  const card = await evaluate('JSON.stringify(window.__smokeCard)').then(JSON.parse);
  // 双击卡片**图片区**(title 元素是标签,双击标签=进重命名);图片区 = 标签上方 60px
  const imgX = card.x;
  const imgY = card.top - 60;
  await mouse('mousePressed', imgX, imgY);
  await mouse('mouseReleased', imgX, imgY);
  await sleep(120);
  await mouse('mousePressed', imgX, imgY, { clickCount: 2 });
  await mouse('mouseReleased', imgX, imgY, { clickCount: 2 });
  await sleep(1500);
  const inViewer = await evaluate(`(function(){ var b = document.querySelector('[title="调整"]'); return !!b && b.getBoundingClientRect().width > 0; })()`);
  console.log('[T1] 查看器已开(调整按钮存在):', inViewer);
  if (!inViewer) { await screenshot('test/adjust-smoke-fail-t1b.png'); process.exit(1); }

  // ── T2:点编辑 → 画布立即可见,不留白(修复 #1 时序) ──
  await evaluate(`document.querySelector('[title="调整"]').click()`);
  await sleep(600);
  const t2 = await evaluate(`(function(){
    var cv = Array.from(document.querySelectorAll('canvas')).find(function(c){ return c.closest('[class*="max-w-none"]') || (c.width>100 && c.height>100 && c.style.position==='absolute'); });
    if (!cv) return { canvas: false };
    // 读画布中心像素,非全透明 = 有内容(图片没有消失)
    var g = cv.getContext('2d');
    var d = g.getImageData(Math.floor(cv.width/2), Math.floor(cv.height/2), 1, 1).data;
    return { canvas: true, w: cv.width, h: cv.height, centerAlpha: d[3], centerRGB: [d[0], d[1], d[2]] };
  })()`);
  console.log('[T2] 编辑态画布:', JSON.stringify(t2));
  await screenshot('test/adjust-smoke-t2-edit-open.png');

  // ── T3:拖亮度滑杆 → 拖动不被图片拖拽抢占(修复 #2),参数生效 ──
  const slider = await evaluate(`(function(){
    var inputs = Array.from(document.querySelectorAll('#aurora-adjust-slot input[type="range"]'));
    var inp = inputs[inputs.length - 5] || inputs[0]; // 影调组第一根(亮度)
    var r = inp.getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, left: r.x, right: r.x + r.width });
  })()`).then(JSON.parse);
  console.log('[T3] 亮度滑杆', JSON.stringify(slider));
  const before = await evaluate(`(function(){ var i = Array.from(document.querySelectorAll('#aurora-adjust-slot input[type="range"]')); var inp = i[i.length-5]||i[0]; return inp.value; })()`);
  await drag(slider.left + 10, slider.y, slider.right - 10, slider.y);
  await sleep(300);
  const after = await evaluate(`(function(){ var i = Array.from(document.querySelectorAll('#aurora-adjust-slot input[type="range"]')); var inp = i[i.length-5]||i[0]; return inp.value; })()`);
  console.log('[T3] 亮度滑杆值', before, '→', after, after !== before ? '✓ 拖动生效(未被拖图抢占)' : '✗ FAIL');

  // ── T3b:右栏裁边检查(修复 #3):面板内所有元素 right 不超面板右缘 ──
  const clip = await evaluate(`(function(){
    var slot = document.getElementById('aurora-adjust-slot');
    var panel = slot.closest('.metadata-panel-container');
    var pr = panel.getBoundingClientRect();
    var worst = 0; var worstEl = '';
    slot.querySelectorAll('*').forEach(function(el){
      var r = el.getBoundingClientRect();
      if (r.width === 0) return;
      var over = r.right - (pr.right - 2);
      if (over > worst) { worst = over; worstEl = el.tagName + '.' + String(el.className).slice(0, 40); }
    });
    return JSON.stringify({ panelRight: pr.right, worstOverflowPx: Math.round(worst*10)/10, worstEl: worstEl });
  })()`);
  console.log('[T3b] 右缘溢出检查:', clip);

  // ── T4:箭头键不切图(修复 #4 屏蔽导航) ──
  const nameBefore = await evaluate(`(function(){ var h = document.querySelector('.metadata-panel-container'); return h ? h.textContent.slice(0, 40) : ''; })()`);
  await key('ArrowRight', 'ArrowRight', 39);
  await sleep(600);
  const nameAfter = await evaluate(`(function(){ var h = document.querySelector('.metadata-panel-container'); return h ? h.textContent.slice(0, 40) : ''; })()`);
  console.log('[T4] 调整态按 → 切图屏蔽:', nameBefore === nameAfter ? '✓ 未切图' : '✗ FAIL 切图了', JSON.stringify({ nameBefore, nameAfter }));

  // ── T5:另存为分体按钮:未保存前有调整→可用;箭头展开蓝色'保存'(修复 #4 样式) ──
  const t5 = await evaluate(`(function(){
    var slot = document.getElementById('aurora-adjust-slot');
    var btns = Array.from(slot.querySelectorAll('button'));
    var chev = btns.find(function(b){ return b.querySelector('.lucide-chevron-down'); });
    if (!chev) return { chev: false };
    chev.click();
    return { chev: true };
  })()`);
  await sleep(200);
  const t5b = await evaluate(`(function(){
    var slot = document.getElementById('aurora-adjust-slot');
    var save = Array.from(slot.querySelectorAll('button')).find(function(b){ return b.textContent.trim() === '保存'; });
    if (!save) return { found: false };
    var cs = getComputedStyle(save);
    return { found: true, text: save.textContent.trim(), disabled: save.disabled, bg: cs.backgroundColor };
  })()`);
  console.log('[T5] 覆盖菜单:', JSON.stringify(t5), JSON.stringify(t5b));
  await screenshot('test/adjust-smoke-t5-menu.png');
  await evaluate(`(function(){ var bd = document.querySelector('.fixed.inset-0.z-20'); if (bd) bd.click(); return 1; })()`);

  // ── T6:关闭 = 取消(修复 #1):点顶栏编辑钮关 → 重开后滑杆回 0 ──
  await evaluate(`document.querySelector('[title="调整"]').click()`);
  await sleep(500);
  await evaluate(`document.querySelector('[title="调整"]').click()`);
  await sleep(800);
  const t6 = await evaluate(`(function(){
    var b = document.querySelector('[title="调整"]');
    var active = b.className.includes('text-blue-500');
    return { editBtnActiveAfterClose: active };
  })()`);
  await evaluate(`document.querySelector('[title="调整"]').click()`);
  await sleep(600);
  const brightnessAfterReopen = await evaluate(`(function(){ var i = Array.from(document.querySelectorAll('#aurora-adjust-slot input[type="range"]')); var inp = i[i.length-5]||i[0]; return inp.value; })()`);
  console.log('[T6] 关闭后编辑钮失活:', JSON.stringify(t6), '| 重开亮度值:', brightnessAfterReopen, brightnessAfterReopen === '0' ? '✓ 已取消恢复原状' : '✗ FAIL 未取消');
  await screenshot('test/adjust-smoke-t6-reopen.png');

  console.log('[smoke] 完成');
  cdp.close();
  process.exit(0);
};

main().catch((e) => { console.error('[smoke] FAIL:', e); process.exit(1); });
